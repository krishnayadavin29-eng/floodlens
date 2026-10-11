/**
 * routing.js - everything about ROUTES (not about waterlogging prediction).
 *
 * Part 1: get alternative routes from a routing provider (OSRM or openrouteservice).
 * Part 2: merge the backend's risk results into each route.
 * Part 3: rank routes with simple, explicit rules and explain the trade-off.
 *
 * Routing and risk prediction are kept apart on purpose: the routing engine does
 * NOT avoid waterlogged roads. It only returns candidate routes; the risk model
 * scores them afterwards, and the ranking here just sorts the scored routes.
 */
import { CONFIG } from './config.js';
import { getRoadRoute } from './api.js';
import { formatDistance, formatPercent, isNum, isValidLatLng, lngLatToLatLng, pathLength, haversine } from './utils.js';

/** Is this travel mode really supported by the configured provider? */
export function modeSupport(mode) {
  const m = CONFIG.ROUTING.modes[mode];
  if (!m) return { supported: false, note: 'Unknown travel mode.' };
  if (m.supported === false) return { supported: false, note: m.unavailableNote || 'This travel mode is not available.' };
  if (CONFIG.ROUTING.provider === 'ors') {
    const ok = Boolean(CONFIG.ROUTING.ors.baseUrl && m.orsProfile);
    return { supported: ok, note: ok ? '' : 'openrouteservice proxy is not configured (ROUTING.ors.baseUrl).' };
  }
  const ok = Boolean(m.endpoint && CONFIG.ROUTING.osrm.endpoints[m.endpoint]);
  return { supported: ok, note: ok ? '' : `No routing server is configured for ${m.label.toLowerCase()}.` };
}

export class RoutingError extends Error {
  constructor(message, { kind = 'service', canUseSample = false } = {}) {
    super(message);
    this.name = 'RoutingError';
    this.kind = kind; // 'validation' | 'no-route' | 'network' | 'timeout' | 'service'
    this.canUseSample = canUseSample;
  }
}

// ================================================================ Part 1 =====

export function validateEndpoints(origin, destination) {
  if (!origin) throw new RoutingError('Choose a starting location first.', { kind: 'validation' });
  if (!destination) throw new RoutingError('Choose a destination first.', { kind: 'validation' });
  if (!isValidLatLng(origin.lat, origin.lng) || !isValidLatLng(destination.lat, destination.lng)) {
    throw new RoutingError('One of the selected locations has invalid coordinates.', { kind: 'validation' });
  }
  if (haversine([origin.lat, origin.lng], [destination.lat, destination.lng]) < 100) {
    throw new RoutingError('The start and destination are almost the same place. Pick two different points.', { kind: 'validation' });
  }
}

async function fetchRoutingJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.ROUTING.timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new RoutingError('The routing service took too long to respond.', { kind: 'timeout', canUseSample: CONFIG.DEMO_MODE });
    throw new RoutingError('The routing service could not be reached. Check your internet connection.', { kind: 'network', canUseSample: CONFIG.DEMO_MODE });
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* body may be empty on errors */
  }
  return { res, body };
}

function isLineString(g) {
  return g && g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2
    && g.coordinates.every((p) => Array.isArray(p) && isValidLatLng(p[1], p[0]));
}

function makeRoute(index, geometry, distance_m, duration_s, provider, steps = null) {
  const letter = String.fromCharCode(65 + index);
  return {
    id: `route_${index + 1}`,
    letter,
    name: `Route ${letter}`,
    geometry,
    latlngs: lngLatToLatLng(geometry.coordinates),
    distance_m,
    duration_s,
    provider,
    isSample: false,
    steps, // turn-by-turn steps from the routing service, or null when it supplied none
    risk: null,
  };
}

/** Convert OSRM legs/steps into our step objects. Returns null if the service sent no steps. */
function parseOsrmSteps(route) {
  const out = [];
  for (const leg of route.legs || []) {
    for (const s of leg.steps || []) {
      const m = s.maneuver;
      if (!m || !Array.isArray(m.location) || !isValidLatLng(m.location[1], m.location[0])) continue;
      const step = { type: m.type, modifier: m.modifier || null, exit: isNum(m.exit) ? m.exit : null, name: s.name || '', distance: s.distance, duration: s.duration, location: [m.location[1], m.location[0]] };
      step.text = instructionText(step);
      out.push(step);
    }
  }
  return out.length ? out : null;
}

const MODIFIER_TEXT = { left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right', 'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight', uturn: 'around (U-turn)' };

/** Plain-English instruction built from the service's structured maneuver. */
export function instructionText(step) {
  const mod = MODIFIER_TEXT[step.modifier] || '';
  const onto = step.name ? ` onto ${step.name}` : '';
  const on = step.name ? ` on ${step.name}` : '';
  switch (step.type) {
    case 'depart': return `Start${on || ' on the road'}`;
    case 'arrive': return step.modifier === 'left' ? 'Arrive at your destination, on the left' : step.modifier === 'right' ? 'Arrive at your destination, on the right' : 'Arrive at your destination';
    case 'turn': return step.modifier === 'uturn' ? `Make a U-turn${on}` : step.modifier === 'straight' ? `Continue straight${on}` : `Turn ${mod}${onto}`;
    case 'new name': return `Continue${onto}`;
    case 'continue': return !mod || mod === 'straight' ? `Continue straight${on}` : `Continue ${mod}${onto}`;
    case 'merge': return `Merge${mod ? ` ${mod}` : ''}${onto}`;
    case 'on ramp': return `Take the ramp${mod ? ` ${mod}` : ''}${onto}`;
    case 'off ramp': return `Take the exit${mod ? ` ${mod}` : ''}${onto}`;
    case 'fork': return `Keep ${mod || 'straight'} at the fork${onto}`;
    case 'end of road': return `At the end of the road, turn ${mod}${onto}`;
    case 'roundabout': case 'rotary': case 'roundabout turn': return step.exit ? `At the roundabout, take exit ${step.exit}${onto}` : `At the roundabout, continue${onto}`;
    case 'exit roundabout': case 'exit rotary': return `Exit the roundabout${onto}`;
    default: return `Continue${onto}`;
  }
}

async function osrmRoutes(origin, destination, mode) {
  const support = modeSupport(mode);
  if (!support.supported) throw new RoutingError(support.note, { kind: 'validation' });
  const base = CONFIG.ROUTING.osrm.endpoints[CONFIG.ROUTING.modes[mode].endpoint].replace(/\/+$/, '');
  const coords = `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`;
  // The profile name in the path is always "driving" on the FOSSGIS servers: the real
  // profile (car / bike / foot) is chosen by the server address, not by this word.
  const build = (alt) => `${base}/route/v1/driving/${coords}?alternatives=${alt}&overview=full&geometries=geojson&steps=true`;

  let { res, body } = await fetchRoutingJson(build(CONFIG.ROUTING.maxAlternatives));
  // Some OSRM builds only accept alternatives=true/false
  if (res.status === 400 && body?.code === 'InvalidValue') ({ res, body } = await fetchRoutingJson(build('true')));

  if (!res.ok && !body) throw new RoutingError(`The routing service returned an error (HTTP ${res.status}).`, { canUseSample: CONFIG.DEMO_MODE });
  if (body?.code === 'NoRoute') throw new RoutingError(`No ${CONFIG.ROUTING.modes[mode].label.toLowerCase()} route was found between these two points.`, { kind: 'no-route' });
  if (body?.code === 'InvalidValue' || body?.code === 'NoSegment') {
    throw new RoutingError('One of the points is not close enough to a road or path. Try a different location.', { kind: 'no-route' });
  }
  if (!res.ok || body?.code !== 'Ok' || !Array.isArray(body.routes)) {
    throw new RoutingError(`The routing service returned an error${body?.message ? `: ${body.message}` : ''}.`, { canUseSample: CONFIG.DEMO_MODE });
  }
  return body.routes
    .filter((r) => isLineString(r.geometry) && isNum(r.distance) && isNum(r.duration))
    .map((r, i) => makeRoute(i, r.geometry, r.distance, r.duration, 'osrm', parseOsrmSteps(r)));
}

async function orsRoutes(origin, destination, mode) {
  const base = CONFIG.ROUTING.ors.baseUrl.replace(/\/+$/, '');
  if (!base) {
    throw new RoutingError('openrouteservice is selected but no proxy URL is configured (ROUTING.ors.baseUrl).', { kind: 'service', canUseSample: CONFIG.DEMO_MODE });
  }
  const profile = CONFIG.ROUTING.modes[mode]?.orsProfile;
  if (!profile) throw new RoutingError('This travel mode is not available with openrouteservice.', { kind: 'validation' });
  const { res, body } = await fetchRoutingJson(`${base}/v2/directions/${profile}/geojson`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coordinates: [[origin.lng, origin.lat], [destination.lng, destination.lat]],
      alternative_routes: { target_count: CONFIG.ROUTING.maxAlternatives, share_factor: 0.6, weight_factor: 1.6 },
      instructions: false,
    }),
  });
  if (!res.ok || !body?.features) {
    throw new RoutingError(`The routing service returned an error (HTTP ${res.status}).`, { canUseSample: CONFIG.DEMO_MODE });
  }
  return body.features
    .filter((f) => isLineString(f.geometry) && isNum(f.properties?.summary?.distance) && isNum(f.properties?.summary?.duration))
    .map((f, i) => makeRoute(i, f.geometry, f.properties.summary.distance, f.properties.summary.duration, 'ors'));
}

/**
 * Ask the configured provider for up to 3 alternative routes.
 * @param {{lat:number,lng:number}} origin
 * @param {{lat:number,lng:number}} destination
 * @param {string} mode  key of CONFIG.ROUTING.modes
 */

export async function findRoutes(
  origin,
  destination,
  mode = CONFIG.ROUTING.defaultMode
) {
  validateEndpoints(origin, destination);

  const raw = await getRoadRoute({
    startLat: origin.lat,
    startLon: origin.lng,
    endLat: destination.lat,
    endLon: destination.lng,
  });

  const geometry = {
    type: 'LineString',
    coordinates: raw.coordinates.map(([lat, lng]) => [lng, lat]),
  };

  const route = makeRoute(
    0,
    geometry,
    raw.distanceM,
    Math.round(raw.distanceM / (30 / 3.6)),
    'local-road-graph',
    null
  );

  return [route];
}


/**
 * DEMO ONLY. Used when the user explicitly chooses "Use sample routes" after the
 * routing service failed. These are smooth curves between the two points, NOT
 * road-snapped and NOT produced by a routing service. They are flagged isSample.
 */
export function buildSampleRoutes(origin, destination) {
  const a = [origin.lng, origin.lat];
  const b = [destination.lng, destination.lat];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1e-6;
  const perp = [-dy / len, dx / len];
  const offsets = [0.03, 0.38, -0.36];

  return offsets.map((off, i) => {
    const control = [(a[0] + b[0]) / 2 + perp[0] * off * len, (a[1] + b[1]) / 2 + perp[1] * off * len];
    const coordinates = [];
    for (let s = 0; s <= 80; s++) {
      const t = s / 80;
      coordinates.push([
        (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * control[0] + t ** 2 * b[0],
        (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * control[1] + t ** 2 * b[1],
      ]);
    }
    const geometry = { type: 'LineString', coordinates };
    const dist = Math.round(pathLength(lngLatToLatLng(coordinates)));
    const route = makeRoute(i, geometry, dist, Math.round(dist / (24 / 3.6)), 'sample', null);
    route.isSample = true;
    return route;
  });
}

// ================================================================ Part 2 =====

/**
 * Merge backend risk records into the route objects.
 * A route with no usable risk record gets risk.available = false (shown as
 * "Risk assessment unavailable") - never an automatic "low".
 */
export function attachRisk(routes, riskRecords, failureReason = null) {
  const byId = new Map((riskRecords || []).map((r) => [r.routeId, r]));
  return routes.map((route) => {
    const rec = byId.get(route.id);
    if (!rec) {
      return { ...route, risk: { available: false, reason: failureReason || 'The backend returned no risk data for this route.' } };
    }
    const segments = rec.segments;
    const sum = (level) => segments.filter((s) => s.level === level).reduce((t, s) => t + s.lengthM, 0);
    const segTotal = segments.reduce((t, s) => t + s.lengthM, 0);
    const totalM = segTotal > 0 ? segTotal : route.distance_m;

    const weighted = segments.filter((s) => isNum(s.prob));
    const weightedLen = weighted.reduce((t, s) => t + s.lengthM, 0);
    const avgFromSegments = weightedLen > 0 ? weighted.reduce((t, s) => t + s.prob * s.lengthM, 0) / weightedLen : null;

    const hasAnything = rec.overall !== 'unknown' || segments.length > 0 || isNum(rec.avgProb);
    if (!hasAnything) {
      return { ...route, risk: { available: false, reason: 'The backend could not assess this route.' } };
    }

    return {
      ...route,
      risk: {
        available: true,
        overall: rec.overall,
        avgProb: isNum(rec.avgProb) ? rec.avgProb : avgFromSegments,
        highCount: isNum(rec.highCount) ? rec.highCount : segments.filter((s) => s.level === 'high').length,
        highDistanceM: isNum(rec.highDistanceM) ? rec.highDistanceM : sum('high'),
        distances: { low: sum('low'), moderate: sum('moderate'), high: sum('high'), unknown: sum('unknown') },
        totalM,
        segments,
        segmentsMissing: segments.length === 0,
        calibrated: rec.calibrated,
        timestamp: rec.timestamp,
        dataStatus: rec.dataStatus,
      },
    };
  });
}

/** One-line trade-off against the fastest route. Uses only returned data; '' when not supported. */
export function tradeoffLine(route, fastest) {
  if (!fastest || route.id === fastest.id) return route.id === fastest?.id ? 'Quickest of the routes found.' : '';
  const diffMin = Math.round((route.duration_s - fastest.duration_s) / 60);
  const time = diffMin <= 0 ? 'About the same time as' : `${diffMin} min longer than`;
  const a = route.risk?.available && isNum(route.risk.avgProb) ? route.risk.avgProb : null;
  const b = fastest.risk?.available && isNum(fastest.risk.avgProb) ? fastest.risk.avgProb : null;
  if (a === null || b === null) return `${time} ${fastest.name}. Risk comparison unavailable.`;
  const d = b - a;
  const delta = CONFIG.RANKING.similarRiskDelta;
  const risk = d >= delta ? `lower estimated exposure (${formatPercent(a)} vs ${formatPercent(b)})` : d <= -delta ? `higher estimated exposure (${formatPercent(a)} vs ${formatPercent(b)})` : 'similar estimated exposure';
  return `${time} ${fastest.name}, with ${risk}.`;
}

/** Plain-language reason for a route's risk classification. Only uses returned data. */
export function explainRisk(route) {
  const r = route.risk;
  if (!r || !r.available) return `Risk assessment unavailable${r?.reason ? `: ${r.reason}` : '.'}`;
  const share = (m) => (r.totalM > 0 && isNum(m) ? Math.round((m / r.totalM) * 100) : null);
  const highShare = share(r.highDistanceM);
  const modShare = share(r.distances.moderate);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (r.overall === 'unknown') return 'The backend did not provide an overall risk level for this route.';
  if (r.segmentsMissing) return `Classified ${r.overall} by the backend. Segment-level detail was not provided, so the route is drawn in grey.`;

  if (r.overall === 'high') {
    return isNum(r.highCount) && r.highCount > 0
      ? `${plural(r.highCount, 'high-risk section')} covering ${formatDistance(r.highDistanceM)}${highShare !== null ? ` (${highShare}% of the route)` : ''}. Potentially vulnerable road sections.`
      : 'Classified high by the risk model.';
  }
  if (r.overall === 'moderate') {
    if (r.highCount > 0) return `${plural(r.highCount, 'high-risk section')} (${formatDistance(r.highDistanceM)}) and ${modShare ?? 0}% moderate-risk road.`;
    return `${modShare ?? 0}% of the route has moderate estimated risk; no high-risk sections were identified.`;
  }
  if (r.highCount > 0) return `Mostly low risk, with ${plural(r.highCount, 'short high-risk section')} (${formatDistance(r.highDistanceM)}). An estimate, not a guarantee.`;
  return `No high-risk sections identified${modShare ? `; ${modShare}% of the route has moderate risk` : ''}. An estimate, not a guarantee.`;
}

// ================================================================ Part 3 =====

/** Value used only for sorting by risk. Higher = more exposure. Unknown sorts last. */
function riskSortValue(route) {
  const r = route.risk;
  if (!r || !r.available) return Infinity;
  if (isNum(r.avgProb)) return r.avgProb;
  // No numeric score: fall back to the level, for ORDERING ONLY (never displayed as a number).
  return { low: 0.2, moderate: 0.5, high: 0.8 }[r.overall] ?? Infinity;
}

const compare = (x, y) => (x === y ? 0 : x < y ? -1 : 1);

/**
 * Explicit ranking rules (see README "How ranking works"):
 *  fastest       -> shortest travel time first
 *  lowest_risk   -> lowest average risk score first; ties broken by travel time
 *  balanced      -> w * normalised time + (1 - w) * normalised risk, lower is better
 * Routes without a risk assessment are placed after assessed routes for the
 * risk-based preferences. If NO route has risk data, everything is ordered by time.
 */
export function rankRoutes(routes, preference) {
  const byTime = [...routes].sort((a, b) => compare(a.duration_s, b.duration_s));
  if (preference === 'fastest') return byTime;
  if (!routes.some((r) => r.risk?.available)) return byTime;

  if (preference === 'lowest_risk') {
    return [...routes].sort((a, b) => compare(riskSortValue(a), riskSortValue(b)) || compare(a.duration_s, b.duration_s));
  }

  // balanced
  const assessed = routes.filter((r) => Number.isFinite(riskSortValue(r)));
  const times = assessed.map((r) => r.duration_s);
  const risks = assessed.map(riskSortValue);
  const norm = (v, arr) => {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    return max === min ? 0 : (v - min) / (max - min);
  };
  const w = CONFIG.RANKING.balancedTimeWeight;
  const score = (r) => (Number.isFinite(riskSortValue(r)) ? w * norm(r.duration_s, times) + (1 - w) * norm(riskSortValue(r), risks) : 10);
  return [...routes].sort((a, b) => compare(score(a), score(b)) || compare(a.duration_s, b.duration_s));
}

/** Short tags such as "Fastest" - only when the data actually supports them. */
export function routeTags(routes) {
  const tags = new Map(routes.map((r) => [r.id, []]));
  if (routes.length < 2) return tags;

  const fastest = [...routes].sort((a, b) => a.duration_s - b.duration_s)[0];
  const shortest = [...routes].sort((a, b) => a.distance_m - b.distance_m)[0];
  tags.get(fastest.id).push('Fastest');
  if (new Set(routes.map((r) => r.distance_m)).size > 1) tags.get(shortest.id).push('Shortest distance');

  const scored = routes.filter((r) => r.risk?.available && isNum(r.risk.avgProb));
  if (scored.length >= 2) {
    const sorted = [...scored].sort((a, b) => a.risk.avgProb - b.risk.avgProb);
    if (sorted[1].risk.avgProb - sorted[0].risk.avgProb >= CONFIG.RANKING.similarRiskDelta) {
      tags.get(sorted[0].id).push('Lower waterlogging risk');
    }
  }
  return tags;
}

/**
 * Sentence explaining the recommendation. Every number comes from route data;
 * if the data is missing the sentence is not produced.
 */
export function describeRecommendation(ranked, preference) {
  if (!ranked.length) return null;
  const rec = ranked[0];
  if (ranked.length === 1) {
    return { title: `${rec.name} is the only route returned`, detail: 'The routing service gave no alternatives, so there is nothing to compare.' };
  }

  const scored = ranked.filter((r) => r.risk?.available && isNum(r.risk.avgProb));
  if (!scored.length) {
    return { title: 'Risk assessment unavailable', detail: 'Routes are ordered by travel time only, because waterlogging risk could not be compared.' };
  }

  const fastest = [...ranked].sort((a, b) => a.duration_s - b.duration_s)[0];
  const lowest = [...scored].sort((a, b) => a.risk.avgProb - b.risk.avgProb)[0];
  const mins = (s) => Math.round(s / 60);
  const score = (r) => formatPercent(r.risk.avgProb);
  const delta = CONFIG.RANKING.similarRiskDelta;

  if (!(rec.risk?.available && isNum(rec.risk.avgProb))) {
    return { title: `${rec.name} is shown first`, detail: 'It has no risk assessment, so the comparison is based on travel time only.' };
  }

  if (rec.id === fastest.id && rec.id === lowest.id) {
    return { title: `${rec.name} is recommended`, detail: `It is the fastest option (${mins(rec.duration_s)} min) and has the lowest estimated waterlogging exposure of the routes returned (average score ${score(rec)}).` };
  }

  if (rec.id === fastest.id) {
    const longer = mins(lowest.duration_s) - mins(rec.duration_s);
    const better = rec.risk.avgProb - lowest.risk.avgProb >= delta;
    return {
      title: `${rec.name} is recommended`,
      detail: better
        ? `It is the fastest option, but ${lowest.name} has a lower estimated waterlogging exposure (${score(lowest)} vs ${score(rec)} average score) for about ${Math.max(longer, 0)} min more.`
        : 'It is the fastest option, and its estimated waterlogging exposure is similar to the alternatives.',
    };
  }

  const extra = mins(rec.duration_s) - mins(fastest.duration_s);
  const extraText = extra <= 0 ? 'about the same travel time as' : `about ${extra} min longer than`;
  if (isNum(fastest.risk?.avgProb) && fastest.risk.avgProb - rec.risk.avgProb >= delta) {
    return {
      title: `${rec.name} is recommended`,
      detail: `It takes ${extraText} the fastest option (${fastest.name}) but has a lower estimated waterlogging exposure (${score(rec)} vs ${score(fastest)} average score).`,
    };
  }
  return {
    title: `${rec.name} is shown first`,
    detail: `It takes ${extraText} the fastest option (${fastest.name}); the estimated waterlogging exposure is similar.`,
  };
}

