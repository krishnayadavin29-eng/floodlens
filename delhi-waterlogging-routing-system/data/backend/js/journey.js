/**
 * journey.js - "Start Journey" route-following mode.
 *
 * What this IS: a browser-based route follower. It shows your position on the chosen route,
 * progress, remaining distance/time, the next instruction WHEN the routing service supplied
 * steps, an off-route notice, and waterlogging warnings for risky sections ahead.
 *
 * What this is NOT: full GPS navigation. There is no voice guidance, no live traffic, and no
 * automatic re-routing (you press Recalculate). If the routing service sent no steps, no
 * turn instructions are shown - they are never invented from the route line.
 *
 * Warnings use only real data: your position, the route geometry and the risk-segment
 * coordinates returned by the backend. A high-risk warning is a PREDICTION, not a confirmed flood.
 */
import { CONFIG } from './config.js';
import { on, emit, state } from './state.js';
import { $, h, icon, refreshIcons, clearNode, toast } from './ui.js';
import { requestUserLocation } from './geolocation.js';
import { setUserLocation, removeUserLocation, centerOn, fitToRoutes, onUserPan } from './map.js';
import { replanFromHere } from './routePlanner.js';
import {
  buildPathIndex, projectOnPath, pointAtDistance, formatDistance, formatDuration, arrivalClock, formatPercent, formatDateTime, dataStatusLabel, isNum, RISK_META,
} from './utils.js';

const J = {
  active: false, route: null, idx: null, steps: [], riskSecs: [], unmappedRisk: 0,
  epoch: 0, watchId: null, simTimer: null, simAlong: 0, simulated: false, tracking: false,
  follow: true, lastFix: null, firstFix: true, offCount: 0, offRoute: false, arrived: false,
  alongM: 0, warned: new Set(), dismissed: new Set(), busy: false,
};

export const isJourneyActive = () => J.active;

export function initJourney() {
  on('start-journey', ({ route }) => startJourney(route));
  onUserPan(() => {
    if (J.active && J.tracking && J.follow) {
      J.follow = false;
      renderHud();
    }
  });
  $('#navEnd').addEventListener('click', endJourney);
  $('#navRecenter').addEventListener('click', recenter);
  $('#navStepsBtn').addEventListener('click', () => {
    const open = $('#navSteps').hidden;
    $('#navSteps').hidden = !open;
    $('#navStepsBtn').setAttribute('aria-expanded', String(open));
  });
  $('#navTrackBtn').addEventListener('click', () => enableTracking(true));
  $('#navSimBtn').addEventListener('click', toggleSimulation);
  $('#navRecalcOff').addEventListener('click', recalculate);
  $('#navAlertRecalc').addEventListener('click', recalculate);
  $('#navAlertDismiss').addEventListener('click', () => {
    if (J.currentAlert) J.dismissed.add(J.currentAlert);
    J.currentAlert = null;
    $('#navAlert').hidden = true;
  });
  $('#navSimBtn').hidden = !CONFIG.JOURNEY.allowSimulation;
}

// ------------------------------------------------------------- preparing -----
/** Pre-compute where each step and each risk section lies along the route (metres from the start). */
function prepare(route) {
  J.epoch += 1;
  J.route = route;
  J.idx = buildPathIndex(route.latlngs);
  J.alongM = 0;
  J.simAlong = 0;
  J.offCount = 0;
  J.offRoute = false;
  J.arrived = false;
  J.currentAlert = null;
  J.warned = new Set();
  J.dismissed = new Set();

  J.steps = (route.steps || [])
    .map((s) => ({ ...s, along: projectOnPath(J.idx, s.location).along }))
    .sort((a, b) => a.along - b.along);

  J.riskSecs = [];
  J.unmappedRisk = 0;
  if (route.risk?.available) {
    route.risk.segments.forEach((seg, i) => {
      if (seg.level !== 'high' && seg.level !== 'moderate') return;
      const a = projectOnPath(J.idx, seg.latlngs[0]);
      const b = projectOnPath(J.idx, seg.latlngs[seg.latlngs.length - 1]);
      // Only use a section if its ends really lie on this route's geometry.
      if (a.distance > 60 || b.distance > 60) {
        J.unmappedRisk += 1;
        return;
      }
      const start = Math.min(a.along, b.along);
      const end = Math.max(a.along, b.along, start + Math.min(seg.lengthM, 50));
      J.riskSecs.push({ id: `${J.epoch}:${i}`, level: seg.level, prob: seg.prob, start, end, lengthM: seg.lengthM, hotspot: seg.hotspot });
    });
    J.riskSecs.sort((x, y) => x.start - y.start);
  }
}

// ----------------------------------------------------------------- start -----
async function startJourney(route) {
  if (J.active) return;
  J.active = true;
  J.follow = true;
  J.firstFix = true;
  J.tracking = false;
  J.simulated = false;
  J.lastFix = null;
  prepare(route);

  document.body.classList.add('navigating');
  $('#navHud').hidden = false;
  emit('journey', { active: true });
  renderHud();
  setTimeout(() => fitToRoutes([route]), 120); // after the HUD padding applies

  await enableTracking(false);
}

/** Ask for location (with our explanation dialog first) and start following updates. */
async function enableTracking(userInitiated) {
  if (!J.active) return;
  if (J.simulated) stopSimulation();
  try {
    const loc = await requestUserLocation();
    if (!J.active) return;
    J.tracking = true;
    J.simulated = false;
    startWatch();
    handleFix(loc);
  } catch (err) {
    if (!J.active) return;
    J.tracking = false;
    toast(`${err.message} Showing the route without live tracking.`, userInitiated ? 'warning' : 'info', 7000);
    renderHud();
  }
}

function startWatch() {
  if (J.watchId !== null) navigator.geolocation.clearWatch(J.watchId);
  J.watchId = navigator.geolocation.watchPosition(
    (pos) => !J.simulated && handleFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
    (err) => {
      if (err.code === 1) {
        stopWatch();
        J.tracking = false;
        toast('Location permission was turned off. Showing the route without live tracking.', 'warning', 7000);
        renderHud();
      } else {
        $('#navNote').textContent = 'Waiting for a GPS signal…';
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

function stopWatch() {
  if (J.watchId !== null) navigator.geolocation.clearWatch(J.watchId);
  J.watchId = null;
}

// -------------------------------------------------------------- simulation -----
function toggleSimulation() {
  if (J.simulated) {
    stopSimulation();
    enableTracking(true);
  } else {
    stopWatch();
    J.simulated = true;
    J.tracking = true;
    J.follow = true;
    J.firstFix = true;
    J.simAlong = Math.max(0, J.alongM);
    const speed = (J.route.distance_m / J.route.duration_s) * CONFIG.JOURNEY.simulationSpeedFactor;
    J.simTimer = setInterval(() => {
      J.simAlong = Math.min(J.idx.total, J.simAlong + speed);
      const [lat, lng] = pointAtDistance(J.idx, J.simAlong);
      handleFix({ lat, lng, accuracy: 5 });
      if (J.simAlong >= J.idx.total) stopSimulationTimer();
    }, 1000);
    renderHud();
  }
}

function stopSimulationTimer() {
  clearInterval(J.simTimer);
  J.simTimer = null;
}

function stopSimulation() {
  stopSimulationTimer();
  J.simulated = false;
  J.tracking = false;
  removeUserLocation();
}

// ---------------------------------------------------------- position update -----
function handleFix(fix) {
  if (!J.active) return;
  J.lastFix = fix;
  setUserLocation(fix);
  const p = projectOnPath(J.idx, [fix.lat, fix.lng]);
  const limit = Math.max(CONFIG.JOURNEY.offRouteM, (fix.accuracy || 0) * 1.5);

  if (p.distance > limit) {
    J.offCount += 1;
    if (J.offCount >= CONFIG.JOURNEY.offRouteConfirmations) J.offRoute = true;
  } else {
    J.offCount = 0;
    J.offRoute = false;
    J.alongM = p.along;
  }
  J.offDistance = p.distance;

  if (!J.arrived && J.idx.total - J.alongM < 30 && !J.offRoute) {
    J.arrived = true;
    toast('You have arrived at your destination.', 'success', 6000);
  }

  if (J.follow) {
    centerOn(fix.lat, fix.lng, J.firstFix ? CONFIG.JOURNEY.followZoom : undefined);
    J.firstFix = false;
  }
  renderHud();
}

// ------------------------------------------------------------------- HUD -----
const STEP_ICON = {
  left: 'corner-up-left', right: 'corner-up-right', 'slight left': 'arrow-up-left', 'slight right': 'arrow-up-right',
  'sharp left': 'corner-up-left', 'sharp right': 'corner-up-right', straight: 'arrow-up', uturn: 'undo-2',
};

function stepIcon(step) {
  if (step.type === 'arrive') return 'flag';
  if (step.type === 'depart') return 'navigation';
  if (/roundabout|rotary/.test(step.type)) return 'refresh-cw';
  return STEP_ICON[step.modifier] || 'arrow-up';
}

function roundAhead(m) {
  const v = Math.max(0, m);
  return v >= 1000 ? formatDistance(v) : `${Math.round(v / (v > 200 ? 50 : 10)) * (v > 200 ? 50 : 10)} m`;
}

function nextStep() {
  return J.steps.find((s) => s.type !== 'depart' && s.along > J.alongM + 8) || null;
}

function renderHud() {
  if (!J.active) return;
  const total = J.idx.total;
  const tracked = J.tracking && J.lastFix;
  const remainingM = tracked ? Math.max(0, total - J.alongM) : total;
  const remainingS = J.route.duration_s * (total > 0 ? remainingM / total : 1);

  // ---- instruction card
  const icoBox = $('#navIcon');
  clearNode(icoBox);
  if (J.arrived) {
    icoBox.append(icon('flag'));
    $('#navDist').textContent = 'Arrived';
    $('#navText').textContent = 'You have reached your destination.';
  } else if (J.steps.length) {
    const step = tracked ? nextStep() : J.steps.find((s) => s.type !== 'depart');
    if (step) {
      icoBox.append(icon(stepIcon(step)));
      $('#navDist').textContent = tracked ? `In ${roundAhead(step.along - J.alongM)}` : 'First instruction';
      $('#navText').textContent = step.text;
    }
  } else {
    icoBox.append(icon('route'));
    $('#navDist').textContent = 'Route-following mode';
    $('#navText').textContent = 'This route has no turn-by-turn instructions from the routing service. Follow the route line on the map.';
  }
  $('#navStepsBtn').hidden = J.steps.length === 0;
  renderStepList(tracked);

  // ---- off-route
  const off = tracked && J.offRoute;
  $('#navOffroute').hidden = !off;
  if (off) $('#navOffText').textContent = `You appear to be about ${formatDistance(J.offDistance)} off the planned route.`;

  // ---- bottom bar
  $('#navRemain').textContent = formatDistance(remainingM);
  $('#navTime').textContent = formatDuration(remainingS);
  $('#navEta').textContent = arrivalClock(remainingS) || '—';
  const pct = tracked && total > 0 ? Math.min(100, (J.alongM / total) * 100) : 0;
  $('#navProgress').style.width = `${pct}%`;
  $('#navProgressWrap').setAttribute('aria-valuenow', String(Math.round(pct)));

  $('#navNote').textContent = J.simulated
    ? 'SIMULATED position (demo). This is not your real location.'
    : tracked
      ? `Live location${J.lastFix.accuracy ? ` (±${Math.round(J.lastFix.accuracy)} m)` : ''}. Remaining time is an estimate without traffic.`
      : 'Live tracking is off. You are viewing the route only: progress and warnings need your location.';
  $('#navTrackBtn').hidden = tracked && !J.simulated ? true : J.simulated ? true : false;
  $('#navSimBtn').textContent = J.simulated ? 'Stop simulation' : 'Simulate (demo)';
  $('#navRecenter').classList.toggle('is-attention', tracked && !J.follow);
  $('#navRecenter').hidden = !tracked && !J.route;

  renderRiskInfo(tracked);
  renderAlert(tracked && !J.offRoute);
  refreshIcons();
}

function renderStepList(tracked) {
  const list = $('#navStepList');
  clearNode(list);
  const upcoming = J.steps.filter((s) => !tracked || s.along > J.alongM - 5).slice(0, 25);
  upcoming.forEach((s) => {
    list.append(h('li', {}, icon(stepIcon(s)), h('span', { class: 'ns-text', text: s.text }), h('span', { class: 'ns-dist', text: tracked ? roundAhead(s.along - J.alongM) : formatDistance(s.along) })));
  });
}

function renderRiskInfo(tracked) {
  const box = $('#navRisk');
  clearNode(box);
  const r = J.route.risk;
  if (CONFIG.DEMO_MODE) box.append(h('span', { class: 'chip chip-warn', text: 'Demo data' }));
  if (!r?.available) {
    box.append(h('span', { class: 'chip chip-type', text: 'Waterlogging risk unavailable for this route. No risk warnings will be shown.' }));
    return;
  }
  if (r.segmentsMissing) {
    box.append(h('span', { class: 'chip chip-type', text: 'No section-level risk data. No distance warnings.' }));
    return;
  }
  const stale = isStale(r.timestamp);
  if (stale) box.append(h('span', { class: 'chip chip-warn', text: `Risk data is ${stale} old and may be outdated` }));
  if (!r.timestamp) box.append(h('span', { class: 'chip chip-type', text: 'Risk data time unknown' }));
  if (J.unmappedRisk) box.append(h('span', { class: 'chip chip-type', text: `${J.unmappedRisk} risk section(s) could not be matched to the route` }));

  const ahead = J.riskSecs.filter((s) => !tracked || s.end > J.alongM).slice(0, 3);
  if (!ahead.length) {
    box.append(h('span', { class: 'chip chip-good', text: tracked ? 'No moderate/high-risk sections ahead (estimate)' : 'No moderate/high-risk sections on this route (estimate)' }));
    return;
  }
  ahead.forEach((s) => {
    const dist = tracked ? (s.start > J.alongM ? `in ${roundAhead(s.start - J.alongM)}` : 'now') : `at ${formatDistance(s.start)} from start`;
    box.append(h('span', { class: `badge risk-${s.level}` }, h('span', { class: 'badge-dot' }), `${RISK_META[s.level].label} risk ${dist} · ${formatDistance(s.lengthM)}`));
  });
}

function isStale(ts) {
  if (!ts) return null;
  const mins = (Date.now() - new Date(ts).getTime()) / 60000;
  if (!Number.isFinite(mins) || mins < CONFIG.JOURNEY.staleRiskMinutes) return null;
  return mins >= 120 ? `${Math.round(mins / 60)} h` : `${Math.round(mins)} min`;
}

// -------------------------------------------------------------- warnings -----
function renderAlert(canWarn) {
  const box = $('#navAlert');
  if (!canWarn || !J.route.risk?.available) {
    box.hidden = true;
    J.currentAlert = null;
    return;
  }
  const sec = J.riskSecs.find((s) =>
    CONFIG.JOURNEY.warnLevels.includes(s.level) && !J.dismissed.has(s.id) && J.alongM < s.end &&
    (J.alongM >= s.start || s.start - J.alongM <= CONFIG.JOURNEY.warnDistanceM));
  if (!sec) {
    box.hidden = true;
    J.currentAlert = null;
    return;
  }

  const inside = J.alongM >= sec.start;
  const ts = J.route.risk.timestamp;
  const stale = isStale(ts);
  const level = RISK_META[sec.level].label;
  $('#navAlertTitle').textContent = inside
    ? `You are in a ${level.toLowerCase()} estimated waterlogging risk section (about ${roundAhead(sec.end - J.alongM)} remaining)`
    : `${level} estimated waterlogging risk ahead, approximately ${roundAhead(sec.start - J.alongM)}`;
  $('#navAlertBody').textContent =
    `Section ${formatDistance(sec.lengthM)} long` +
    (isNum(sec.prob) ? ` · model score ${formatPercent(sec.prob)}` : '') +
    (sec.hotspot?.name ? ` · near historical hotspot: ${sec.hotspot.name}` : '') +
    ` · ${dataStatusLabel(J.route.risk.dataStatus)}` +
    (ts ? ` · predicted ${formatDateTime(ts)}` : ' · prediction time unknown') +
    (stale ? ` (${stale} old, may be outdated)` : '') +
    '. This is a model estimate, not a confirmed flood report.';
  box.hidden = false;
  J.currentAlert = sec.id;
  if (!J.warned.has(sec.id)) {
    J.warned.add(sec.id); // alert the user once per section
    navigator.vibrate?.(200);
  }
}

// ------------------------------------------------------------ other actions -----
function recenter() {
  J.follow = true;
  if (J.lastFix) centerOn(J.lastFix.lat, J.lastFix.lng, CONFIG.JOURNEY.followZoom);
  else fitToRoutes([J.route]);
  renderHud();
}

async function recalculate() {
  if (J.busy) return;
  if (!J.lastFix) {
    toast('Turn on location tracking first, so the route can be recalculated from where you are.', 'info');
    return;
  }
  J.busy = true;
  $('#navNote').textContent = 'Recalculating routes from your position…';
  try {
    const route = await replanFromHere(J.lastFix);
    if (!J.active) return;
    if (route) {
      prepare(route);
      J.follow = true;
      renderHud();
      toast(`Recalculated. Now following ${route.name} (${formatDuration(route.duration_s)}).`, 'success', 5000);
    } else {
      toast('Could not recalculate routes. Check the connection and try again.', 'error');
      renderHud();
    }
  } finally {
    J.busy = false;
  }
}

export function endJourney() {
  if (!J.active) return;
  stopWatch();
  stopSimulationTimer();
  if (J.simulated) removeUserLocation();
  J.active = false;
  J.simulated = false;
  J.tracking = false;
  document.body.classList.remove('navigating');
  $('#navHud').hidden = true;
  emit('journey', { active: false });
  emit('navigate', { view: 'route' });
  toast('Journey ended. You are back in route planning.', 'info', 3500);
}
