/**
 * routePlanner.js - the signature feature.
 *
 * Flow when the user presses "Find Routes":
 *   1. validate start + destination
 *   2. routing.js   -> ask the routing provider for alternative routes (geometry, distance, time)
 *   3. api.js       -> send those routes to the backend (/route-risk) for waterlogging scores
 *   4. routing.js   -> merge scores into routes, rank them with explicit rules
 *   5. map.js       -> draw each route as separate coloured risk segments
 *   6. this file    -> build the route cards and recommendation text
 */
import { CONFIG } from './config.js';
import { on, emit, startPick, loadPrefs, savePrefs } from './state.js';
import { $, $$, h, icon, refreshIcons, clearNode, toast, errorState, riskBadge, chip, setLoading } from './ui.js';
import { createAutocomplete } from './autocomplete.js';
import { reverseGeocode } from './geocoding.js';
import { requestUserLocation } from './geolocation.js';
import { calculateRouteRisk } from './api.js';
import {
  findRoutes, buildSampleRoutes, attachRisk, rankRoutes, routeTags, describeRecommendation, explainRisk, validateEndpoints, RoutingError, modeSupport, tradeoffLine,
} from './routing.js';
import { setOriginMarker, setDestinationMarker, renderRoutes, clearRoutes, fitToRoutes, fitToPoints } from './map.js';
import {
  RISK_META, formatDistance, formatDuration, formatPercent, formatDateTime, dataStatusLabel, isCalibrated, isInsideNcr, isNum, arrivalClock,
} from './utils.js';

const plan = {
  origin: null, // { lat, lng, label }
  destination: null,
  rawRoutes: [], // routes from the routing provider (before risk)
  routes: [], // routes with risk attached
  selectedId: null,
  token: 0, // incremented to ignore results from outdated requests
};

const PROVIDER_LABEL = {
  osrm: 'OSRM routing (public demo server)',
  ors: 'openrouteservice',
  sample: 'Sample geometry - not a routing service',
};

let originAc;
let destAc;

// ---------------------------------------------------------------- setup -----
export function initRoutePlanner() {
  const prefs = loadPrefs();

  // Preference + travel mode (restored from harmless UI preferences)
  const prefValue = ['lowest_risk', 'balanced', 'fastest'].includes(prefs.preference) ? prefs.preference : 'balanced';
  $$('input[name="preference"]').forEach((r) => {
    r.checked = r.value === prefValue;
    r.addEventListener('change', onPreferenceChange);
  });
  buildModeSelector(prefs.travelMode);

  // Place search boxes
  originAc = createAutocomplete({
    input: $('#originInput'), list: $('#originList'),
    onSelect: (p) => setPlace('origin', p, { updateInput: false }),
    onEdit: () => { if (plan.origin) { plan.origin = null; setOriginMarker(null); invalidateResults(); } },
  });
  destAc = createAutocomplete({
    input: $('#destInput'), list: $('#destList'),
    onSelect: (p) => setPlace('destination', p, { updateInput: false }),
    onEdit: () => { if (plan.destination) { plan.destination = null; setDestinationMarker(null); invalidateResults(); } },
  });

  $('#originMyLoc').addEventListener('click', useMyLocation);
  $('#originPick').addEventListener('click', () => startPick('origin', 'Click the map to set your starting point.'));
  $('#destPick').addEventListener('click', () => startPick('destination', 'Click the map to set your destination.'));
  $('#originClear').addEventListener('click', () => clearPlace('origin'));
  $('#destClear').addEventListener('click', () => clearPlace('destination'));
  $('#swapBtn').addEventListener('click', swapPlaces);
  $('#startJourneyBtn').addEventListener('click', () => {
    const route = getSelectedRoute();
    if (route) emit('start-journey', { route });
  });
  $('#routeForm').addEventListener('submit', (e) => { e.preventDefault(); findAndAssess(); });

  on('picked', ({ target, latlng }) => {
    if (target !== 'origin' && target !== 'destination') return;
    setPlace(target, { lat: latlng.lat, lng: latlng.lng, label: `Pinned point (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`, source: 'map' });
  });
  on('pick-start', ({ target }) => $(`#${target === 'origin' ? 'originPick' : 'destPick'}`)?.setAttribute('aria-pressed', 'true'));
  on('pick-end', () => $$('.pick-btn').forEach((b) => b.setAttribute('aria-pressed', 'false')));
}

const TWO_WHEELER_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="17" r="3"/><circle cx="18.5" cy="17" r="3"/><path d="M8.5 17h4l2-6h-4M14.5 11l-1-4h-2M16 7h2"/></svg>';

/** Build the Driving / Two-wheeler / Walking / Cycling selector from CONFIG, honouring provider support. */
function buildModeSelector(saved) {
  const group = $('#modeGroup');
  clearNode(group);
  const wanted = CONFIG.ROUTING.modes[saved] && modeSupport(saved).supported ? saved : CONFIG.ROUTING.defaultMode;
  const unsupported = [];
  Object.entries(CONFIG.ROUTING.modes).forEach(([key, m]) => {
    const support = modeSupport(key);
    if (!support.supported) unsupported.push(support.note);
    const input = h('input', { type: 'radio', name: 'travelMode', value: key, disabled: !support.supported, checked: key === wanted, 'aria-label': m.label });
    input.addEventListener('change', () => {
      savePrefs({ travelMode: key });
      invalidateResults();
    });
    const iconNode = m.icon === 'two-wheeler' ? h('span', { class: 'mode-svg' }) : icon(m.icon);
    if (m.icon === 'two-wheeler') iconNode.innerHTML = TWO_WHEELER_SVG; // constant string written by us
    group.append(h('label', { class: `mode-opt ${support.supported ? '' : 'is-disabled'}`, title: support.supported ? m.label : support.note }, input, iconNode, h('span', { text: m.label })));
  });
  $('#modeNote').textContent = unsupported[0] || '';
  refreshIcons();
}

function currentMode() {
  return $('input[name="travelMode"]:checked')?.value || CONFIG.ROUTING.defaultMode;
}

function currentPreference() {
  return $('input[name="preference"]:checked')?.value || 'balanced';
}

// ------------------------------------------------------- place handling -----
function fieldMsg(kind, text, type = 'error') {
  const el = $(kind === 'origin' ? '#originMsg' : '#destMsg');
  el.textContent = text || '';
  el.className = `field-msg ${text ? `is-${type}` : ''}`;
}

/** Public: other modules (map popups) can set a route point. */
export function setPoint(kind, latlng, label) {
  setPlace(kind, { lat: latlng.lat, lng: latlng.lng, label: label || `Pinned point (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`, source: 'map' });
}

function setPlace(kind, place, { updateInput = true } = {}) {
  plan[kind] = { lat: place.lat, lng: place.lng, label: place.label };
  (kind === 'origin' ? setOriginMarker : setDestinationMarker)(plan[kind]);
  if (updateInput) (kind === 'origin' ? originAc : destAc).setValue(place.label);
  fieldMsg(kind, '');
  invalidateResults();

  if (!isInsideNcr(place.lat, place.lng)) fieldMsg(kind, 'This point looks outside Delhi-NCR. Risk data only covers the Delhi area.', 'warning');

  const points = [plan.origin, plan.destination].filter(Boolean);
  fitToPoints(points);

  // Replace a coordinate label with a readable place name when the geocoder can provide one.
  if (place.source === 'map') {
    reverseGeocode(place.lat, place.lng).then((name) => {
      const current = plan[kind];
      if (name && current && current.lat === place.lat && current.lng === place.lng) {
        current.label = name;
        (kind === 'origin' ? originAc : destAc).setValue(name);
        (kind === 'origin' ? setOriginMarker : setDestinationMarker)(current);
      }
    });
  }
}

function clearPlace(kind) {
  plan[kind] = null;
  (kind === 'origin' ? originAc : destAc).clear();
  (kind === 'origin' ? setOriginMarker : setDestinationMarker)(null);
  fieldMsg(kind, '');
  invalidateResults();
  $(kind === 'origin' ? '#originInput' : '#destInput').focus();
}

function swapPlaces() {
  const { origin, destination } = plan;
  plan.origin = destination;
  plan.destination = origin;
  originAc.setValue(plan.origin?.label || '');
  destAc.setValue(plan.destination?.label || '');
  setOriginMarker(plan.origin);
  setDestinationMarker(plan.destination);
  fieldMsg('origin', '');
  fieldMsg('destination', '');
  invalidateResults();
}

async function useMyLocation() {
  const btn = $('#originMyLoc');
  btn.disabled = true;
  try {
    const loc = await requestUserLocation();
    setPlace('origin', { lat: loc.lat, lng: loc.lng, label: 'My current location' });
    toast('Start set to your current location.', 'success', 3000);
  } catch (err) {
    fieldMsg('origin', err.message, 'error');
    $('#originInput').focus();
  } finally {
    btn.disabled = false;
  }
}

/** Remove old results when start / destination / mode change, so stale routes are never shown. */
function invalidateResults() {
  plan.token += 1; // ignore any request still in flight
  setLoading($('#findRoutesBtn'), false);
  if (!plan.routes.length && !plan.rawRoutes.length && $('#routeResults').hidden) {
    clearNode($('#routeStatus'));
    return;
  }
  plan.routes = [];
  plan.rawRoutes = [];
  plan.selectedId = null;
  clearRoutes();
  $('#routeResults').hidden = true;
  const status = $('#routeStatus');
  clearNode(status);
  status.append(h('p', { class: 'status-note', text: 'Start, destination or travel mode changed. Press “Find Routes” to update.' }));
}

// --------------------------------------------------------- finding routes -----
function showLoading(text) {
  const status = $('#routeStatus');
  clearNode(status);
  status.append(h('div', { class: 'status-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text));
}

function showRoutingError(err, token) {
  const status = $('#routeStatus');
  clearNode(status);
  const message = err instanceof RoutingError ? err.message : 'Something went wrong while finding routes.';
  const box = errorState(message, () => findAndAssess(), 'Retry');
  if (err instanceof RoutingError && err.canUseSample) {
    box.querySelector('.error-body').append(
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onClick: () => useSampleRoutes() }, 'Use sample routes (demo only)'),
      h('p', { class: 'hint', text: 'Sample routes are smooth curves, not real roads, and are labelled as such.' })
    );
  }
  status.append(box);
  refreshIcons();
}

function routePayload(routes) {
  return {
    origin: { latitude: plan.origin.lat, longitude: plan.origin.lng },
    destination: { latitude: plan.destination.lat, longitude: plan.destination.lng },
    routes: routes.map((r) => ({
      route_id: r.id,
      geometry: r.geometry,
      distance_m: Math.round(r.distance_m),
      duration_s: Math.round(r.duration_s),
    })),
    preference: currentPreference(),
  };
}

async function findAndAssess(opts = {}) {
  keepView = Boolean(opts.keepView);
  fieldMsg('origin', '');
  fieldMsg('destination', '');
  try {
    validateEndpoints(plan.origin, plan.destination);
  } catch (err) {
    const kind = !plan.origin ? 'origin' : 'destination';
    const typed = $(kind === 'origin' ? '#originInput' : '#destInput').value.trim();
    // Text that was never matched to a real place must not be treated as a resolved location.
    fieldMsg(kind, typed ? 'This place has not been found yet. Choose a suggestion from the list, or click the map.' : err.message);
    $(kind === 'origin' ? '#originInput' : '#destInput').focus();
    return;
  }

  const token = ++plan.token;
  const btn = $('#findRoutesBtn');
  setLoading(btn, true, 'Finding routes…');
  $('#routeResults').hidden = true;
  clearRoutes();
  showLoading('Requesting alternative routes…');

  let routes;
  try {
    routes = await findRoutes(plan.origin, plan.destination, currentMode());
  } catch (err) {
    if (token !== plan.token) return;
    setLoading(btn, false);
    showRoutingError(err, token);
    return;
  }
  if (token !== plan.token) return;
  await assessRoutes(routes, token);
}

function useSampleRoutes() {
  const token = ++plan.token;
  setLoading($('#findRoutesBtn'), true, 'Preparing sample…');
  assessRoutes(buildSampleRoutes(plan.origin, plan.destination), token);
}

let keepView = false;
async function assessRoutes(routes, token) {
  const btn = $('#findRoutesBtn');
  plan.rawRoutes = routes;

  // Show geometry straight away in grey (risk unknown) while the backend works.
  renderRoutes(routes, routes[0].id, {});
  if (!document.body.classList.contains('navigating')) fitToRoutes(routes);
  showLoading('Assessing waterlogging risk along each route…');

  let records = [];
  let failure = null;
  try {
    records = await calculateRouteRisk(routePayload(routes));
  } catch (err) {
    failure = err.message || 'The risk service did not respond.';
  }
  if (token !== plan.token) return;

  plan.routes = attachRisk(routes, records, failure);
  setLoading(btn, false);
  presentRoutes({ select: true, fit: false });
  if (!keepView) $('#routeReco').scrollIntoView({ block: 'start', behavior: 'smooth' });

  if (failure) {
    const status = $('#routeStatus');
    clearNode(status);
    status.append(errorState(`Waterlogging risk could not be assessed: ${failure} Routes are shown in grey and ordered by travel time.`, retryRisk, 'Retry risk assessment'));
    refreshIcons();
  } else {
    clearNode($('#routeStatus'));
  }
}

async function retryRisk() {
  const token = ++plan.token;
  showLoading('Assessing waterlogging risk along each route…');
  let records = [];
  let failure = null;
  try {
    records = await calculateRouteRisk(routePayload(plan.rawRoutes));
  } catch (err) {
    failure = err.message || 'The risk service did not respond.';
  }
  if (token !== plan.token) return;
  plan.routes = attachRisk(plan.rawRoutes, records, failure);
  presentRoutes({ select: true, fit: false });
  const status = $('#routeStatus');
  clearNode(status);
  if (failure) {
    status.append(errorState(`Waterlogging risk could not be assessed: ${failure}`, retryRisk, 'Retry risk assessment'));
    refreshIcons();
  }
}

// ----------------------------------------------------------- presenting -----
function onPreferenceChange() {
  savePrefs({ preference: currentPreference() });
  if (plan.routes.length) presentRoutes({ select: true, fit: false });
}

function presentRoutes({ select, fit }) {
  const ranked = rankRoutes(plan.routes, currentPreference());
  if (select || !plan.selectedId) plan.selectedId = ranked[0].id;

  renderRoutes(plan.routes, plan.selectedId, { onSelect: selectRoute });
  if (fit) fitToRoutes(plan.routes);

  renderRecommendation(ranked);
  renderCompare();
  renderCards(ranked);
  $('#routeResults').hidden = false;
  refreshIcons();
}

function selectRoute(id, { scroll = true } = {}) {
  if (plan.selectedId === id) return;
  plan.selectedId = id;
  renderRoutes(plan.routes, id, { onSelect: selectRoute });
  $$('.route-card').forEach((card) => {
    const isSel = card.dataset.routeId === id;
    card.classList.toggle('is-selected', isSel);
    const btn = card.querySelector('.rc-select');
    btn.setAttribute('aria-pressed', String(isSel));
    btn.lastChild.textContent = isSel ? 'Selected' : 'View route';
  });
  if (scroll) $(`.route-card[data-route-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  renderStartBar();
  fitToRoutes(plan.routes, id);
}

function renderRecommendation(ranked) {
  const box = $('#routeReco');
  clearNode(box);
  const info = describeRecommendation(ranked, currentPreference());
  if (!info) return;
  box.append(
    icon('route'),
    h('div', {},
      h('p', { class: 'reco-title', text: info.title }),
      h('p', { class: 'reco-detail', text: info.detail }),
      h('p', { class: 'reco-caveat', text: 'A lower estimated risk does not mean a route is safe or flood-free. Conditions can change quickly.' })
    )
  );
}

/** Side-by-side: fastest route vs the route with the lowest estimated exposure. Uses returned data only. */
function renderCompare() {
  const box = $('#routeCompare');
  clearNode(box);
  if (plan.routes.length < 2) return;

  const fastest = [...plan.routes].sort((a, b) => a.duration_s - b.duration_s)[0];
  const assessed = plan.routes.filter((r) => r.risk?.available && isNum(r.risk.avgProb));
  if (assessed.length < 2) {
    box.append(h('p', { class: 'hint', text: 'Fastest vs lower-risk comparison needs risk scores for at least two routes.' }));
    return;
  }
  const lower = [...assessed].sort((a, b) => a.risk.avgProb - b.risk.avgProb)[0];
  const gap = (isNum(fastest.risk?.avgProb) ? fastest.risk.avgProb : lower.risk.avgProb) - lower.risk.avgProb;

  if (lower.id === fastest.id || gap < CONFIG.RANKING.similarRiskDelta) {
    box.append(h('div', { class: 'compare compare-note' }, icon('scale'),
      h('p', { text: lower.id === fastest.id
        ? `${fastest.name} is both the fastest route and the one with the lowest estimated exposure, so there is no trade-off to weigh.`
        : `The fastest route (${fastest.name}) and the lowest-risk route (${lower.name}) have similar estimated exposure.` })));
    refreshIcons();
    return;
  }

  const score = (r) => (isNum(r.risk?.avgProb) ? formatPercent(r.risk.avgProb) : '—');
  const hi = (r) => (r.risk?.available ? `${r.risk.highCount ?? '—'} · ${formatDistance(r.risk.highDistanceM)}` : '—');
  const cols = [
    { label: 'Fastest', r: fastest },
    { label: 'Lower risk', r: lower },
  ];
  const rows = [
    ['Travel time', (r) => formatDuration(r.duration_s)],
    ['Distance', (r) => formatDistance(r.distance_m)],
    ['Avg. risk score', score],
    ['High-risk sections · distance', hi],
  ];
  const extra = Math.round((lower.duration_s - fastest.duration_s) / 60);

  box.append(
    h('section', { class: 'compare', 'aria-label': 'Fastest route compared with lower-risk route' },
      h('h3', { text: 'Fastest vs lower-risk' }),
      h('div', { class: 'compare-grid', role: 'table' },
        h('div', { class: 'cg-row cg-head', role: 'row' }, h('span', { role: 'columnheader', text: '' }),
          cols.map((c) => h('span', { role: 'columnheader' }, c.label, h('small', { text: c.r.name })))),
        rows.map(([label, fn]) => h('div', { class: 'cg-row', role: 'row' }, h('span', { class: 'cg-label', role: 'rowheader', text: label }), cols.map((c) => h('span', { role: 'cell', text: fn(c.r) }))))
      ),
      h('p', { class: 'compare-text', text: `${lower.name} takes about ${Math.max(extra, 0)} min ${extra < 0 ? 'less' : 'longer'} than ${fastest.name}, with a lower estimated exposure (${score(lower)} vs ${score(fastest)} average score). Lower estimated risk is not a safety guarantee.` }),
      h('div', { class: 'btn-row' }, cols.map((c) => h('button', { class: 'btn btn-sm', type: 'button', onClick: () => selectRoute(c.r.id) }, icon('eye'), `Show ${c.label.toLowerCase()} route`)))
    )
  );
  refreshIcons();
}

function riskBar(route) {
  const r = route.risk;
  if (!r?.available || r.segmentsMissing) {
    return h('div', { class: 'risk-bar is-unknown', role: 'img', 'aria-label': 'Segment-level risk unavailable' });
  }
  const total = Object.values(r.distances).reduce((a, b) => a + b, 0) || 1;
  const parts = ['low', 'moderate', 'high', 'unknown']
    .filter((lv) => r.distances[lv] > 0)
    .map((lv) => h('span', { class: `rb-${lv}`, style: `width:${(r.distances[lv] / total) * 100}%`, title: `${RISK_META[lv].label}: ${formatDistance(r.distances[lv])}` }));
  const label = ['low', 'moderate', 'high', 'unknown']
    .filter((lv) => r.distances[lv] > 0)
    .map((lv) => `${RISK_META[lv].label} ${Math.round((r.distances[lv] / total) * 100)}%`)
    .join(', ');
  return h('div', { class: 'risk-bar', role: 'img', 'aria-label': `Route risk breakdown: ${label}` }, parts);
}

function segmentDetails(route) {
  const r = route.risk;
  const body = h('div', { class: 'rc-details-body' });
  if (r?.available && r.segments.length) {
    const shown = r.segments.slice(0, 12);
    body.append(
      h('ol', { class: 'seg-list' },
        shown.map((s, i) =>
          h('li', {},
            riskBadge(s.level),
            h('span', { class: 'seg-len', text: formatDistance(s.lengthM) }),
            h('span', { class: 'seg-score', text: s.prob !== null ? formatPercent(s.prob) : 'no score' })
          )
        )
      )
    );
    if (r.segments.length > shown.length) body.append(h('p', { class: 'hint', text: `…and ${r.segments.length - shown.length} more sections.` }));
  } else {
    body.append(h('p', { class: 'hint', text: 'No section-level risk data for this route.' }));
  }
  body.append(
    h('dl', { class: 'detail-list compact' },
      h('div', { class: 'detail-row' }, h('dt', { text: 'Route source' }), h('dd', { text: PROVIDER_LABEL[route.provider] || route.provider })),
      r?.available ? h('div', { class: 'detail-row' }, h('dt', { text: 'Risk data' }), h('dd', { text: dataStatusLabel(r.dataStatus) })) : null,
      r?.available ? h('div', { class: 'detail-row' }, h('dt', { text: 'Prediction time' }), h('dd', { text: formatDateTime(r.timestamp) || 'Not available' })) : null
    )
  );
  return h('details', { class: 'rc-details' }, h('summary', { text: 'Section details' }), body);
}

function buildCard(route, tags, fastest) {
  const r = route.risk;
  const level = r?.available ? r.overall : 'unknown';
  const selected = route.id === plan.selectedId;
  const calibrated = r?.available && isCalibrated(r.calibrated);
  const highShare = r?.available && r.totalM > 0 && r.highDistanceM !== null ? r.highDistanceM / r.totalM : null;
  const arrive = arrivalClock(route.duration_s);
  const trade = tradeoffLine(route, fastest);

  const card = h(
    'article',
    { class: `route-card ${selected ? 'is-selected' : ''}`, dataset: { routeId: route.id }, 'aria-label': route.name },
    h('header', { class: 'rc-head' },
      h('span', { class: 'rc-letter', 'aria-hidden': 'true', text: route.letter }),
      h('div', { class: 'rc-title' },
        h('div', { class: 'rc-time' }, h('strong', { text: formatDuration(route.duration_s) }), h('span', { text: ` · ${formatDistance(route.distance_m)}` })),
        h('div', { class: 'rc-sub', text: `${route.name}${arrive ? ` · arrive about ${arrive}` : ''}` })
      ),
      riskBadge(level, level === 'unknown' ? 'Risk unavailable' : `${RISK_META[level].label} risk`)
    ),
    h('div', { class: 'rc-tags' }, (tags || []).map((t) => chip(t, t === 'Recommended' ? 'chip-primary' : t.includes('risk') ? 'chip-good' : '')), route.isSample ? chip('Sample geometry', 'chip-warn') : null, route.steps ? null : chip('No turn-by-turn', 'chip-type')),
    riskBar(route),
    h('p', { class: 'rc-explain', text: explainRisk(route) }),
    trade ? h('p', { class: 'rc-trade', text: trade }) : null,
    r?.available
      ? h('p', { class: 'rc-stats' },
          `${calibrated ? 'Avg. probability' : 'Avg. risk score'} ${r.avgProb !== null ? formatPercent(r.avgProb) : '—'}`,
          ' · ', `High-risk sections: ${r.highCount ?? '—'}`,
          ' · ', `${formatDistance(r.highDistanceM)}${highShare !== null ? ` (${Math.round(highShare * 100)}%)` : ''} high-risk`)
      : null,
    segmentDetails(route),
    h('button', { class: 'btn btn-sm rc-select', type: 'button', 'aria-pressed': String(selected), onClick: (e) => { e.stopPropagation(); selectRoute(route.id, { scroll: false }); } },
      icon('eye'), h('span', { text: selected ? 'Selected' : 'View route' }))
  );

  // Clicking anywhere on the card (except the expandable details) also selects it.
  card.addEventListener('click', (e) => {
    if (e.target.closest('details') || e.target.closest('button')) return;
    selectRoute(route.id, { scroll: false });
  });
  return card;
}

function renderCards(ranked) {
  const wrap = $('#routeCards');
  clearNode(wrap);
  const tags = routeTags(plan.routes);
  const fastest = [...plan.routes].sort((a, b) => a.duration_s - b.duration_s)[0];

  if (ranked.some((r) => r.isSample)) {
    wrap.append(h('div', { class: 'banner banner-warn' }, icon('alert-triangle'), h('p', { text: 'Sample routes: smooth curves between your two points. They are not from a routing service and do not follow roads, so distance and time are rough.' })));
  }
  if (ranked.length === 1) {
    wrap.append(h('p', { class: 'hint', text: 'Only one route was returned, so there are no alternatives to compare.' }));
  }
  ranked.forEach((route, i) => {
    wrap.append(buildCard(route, [...(i === 0 && ranked.length > 1 ? ['Recommended'] : []), ...(tags.get(route.id) || [])], fastest));
  });
  renderStartBar();
  refreshIcons();
}

/** Sticky bar with the Start journey button for the currently selected route. */
function renderStartBar() {
  const bar = $('#startBar');
  const route = getSelectedRoute();
  bar.hidden = !route;
  if (!route) return;
  const level = route.risk?.available ? route.risk.overall : 'unknown';
  $('#startBarText').textContent = `${route.name} · ${formatDuration(route.duration_s)} · ${formatDistance(route.distance_m)} · ${RISK_META[level].phrase.toLowerCase()}`;
}

export function getSelectedRoute() {
  return plan.routes.find((r) => r.id === plan.selectedId) || null;
}

export function getPlanEndpoints() {
  return { origin: plan.origin, destination: plan.destination, mode: currentMode() };
}

/**
 * Journey support: re-plan from the user's live position to the same destination and return the
 * route that is now selected (best by the current preference), or null if it failed.
 */
export async function replanFromHere(latlng) {
  if (!plan.destination) return null;
  setPlace('origin', { lat: latlng.lat, lng: latlng.lng, label: 'My current location' });
  await findAndAssess({ keepView: true });
  return getSelectedRoute();
}

/** Called by app.js when the route view opens: keep results consistent with map. */
export function currentRoutes() {
  return plan.routes;
}

