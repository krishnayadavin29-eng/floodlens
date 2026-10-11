/**
 * api.js - ALL calls to the backend (and weather) live here.
 *
 * Every function either:
 *   - returns normalised, validated data, or
 *   - throws an ApiError with a message that is safe to show the user.
 *
 * Demo mode (CONFIG.DEMO_MODE = true) answers from js/mock.js after a short delay.
 * Real mode never silently falls back to fake data: if a request fails, the caller
 * gets an error and the UI says so.
 */
import { CONFIG } from './config.js';
import { isNum, isValidLatLng, normalizeRisk, pathLength, sleep, lngLatToLatLng } from './utils.js';
import { SAMPLE_REPORTS, mockPredict, mockRouteRisk, sampleHotspotsResponse } from './mock.js';

export class ApiError extends Error {
  /** kind: 'network' | 'timeout' | 'http' | 'unavailable' | 'invalid' | 'unconfigured' */
  constructor(message, { kind = 'http', status = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (isNum(v) ? v : null);

// ----------------------------------------------------------- low level -----
async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = CONFIG.API_TIMEOUT_MS, label = 'the server' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { method, body, headers, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(`${label} took too long to respond.`, { kind: 'timeout' });
    throw new ApiError(`Could not reach ${label}. Check your internet connection or that the server is running.`, { kind: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 501) {
      throw new ApiError('This feature is not available on the backend yet.', { kind: 'unavailable', status: response.status });
    }
    let detail = '';
    try {
      const err = await response.json();
      if (typeof err?.detail === 'string') detail = ` (${err.detail})`;
    } catch {
      /* ignore body parse errors */
    }
    throw new ApiError(`${label} returned an error (HTTP ${response.status})${detail}.`, { kind: 'http', status: response.status });
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError(`${label} sent a response that could not be read.`, { kind: 'invalid' });
  }
}

/** Request to our own backend. `path` starts with "/". */
function backend(path, { query, ...options } = {}) {
  const url = new URL(CONFIG.API_BASE_URL + path);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  return fetchJson(url.toString(), { label: 'the JalAlert backend', ...options });
}

const jsonPost = (path, data) =>
  backend(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// -------------------------------------------------------------- health -----
/** Check the real backend even when the UI is using demo/sample risk data. */
export async function getHealthStatus() {
  const data = await backend('/health', { timeoutMs: 6000 });
  if (data?.status !== 'ok') throw new ApiError('Backend health check did not report "ok".', { kind: 'invalid' });
  return {
    status: 'ok',
    modelReady: data.model_ready === true,
    liveCoordinatePredictionReady: data.live_coordinate_prediction_ready === true,
    routeRiskReady: data.route_risk_ready === true,
    hotspotsReady: data.hotspots_ready === true,
    reportsReady: data.reports_ready === true,
    limitations: Array.isArray(data.limitations) ? data.limitations : [],
  };
}

// ------------------------------------------------------------- predict -----
/** POST /predict  -> normalised location prediction. */
export async function predictLocationRisk({ latitude, longitude }) {
  if (!isValidLatLng(latitude, longitude)) throw new ApiError('Those coordinates are not valid.', { kind: 'invalid' });
  let raw;
  if (CONFIG.DEMO_MODE) {
    await sleep(700);
    raw = mockPredict(latitude, longitude);
  } else {
    // The test-only backend endpoint requires all 18 verified features. Do not
    // send a coordinate-only request or substitute invented feature values.
    throw new ApiError(
      'Live location prediction is unavailable until verified model features can be generated for this point.',
      { kind: 'unavailable' },
    );
  }
  return normalizePrediction(raw, latitude, longitude);
}

function normalizePrediction(raw, latitude, longitude) {
  if (!raw || typeof raw !== 'object') throw new ApiError('The backend sent an unexpected prediction response.', { kind: 'invalid' });
  const probability = num(raw.risk_probability);
  return {
    latitude,
    longitude,
    level: normalizeRisk(raw.risk_level, probability), // missing -> 'unknown', never 'low'
    probability,
    calibrated: raw.risk_probability_calibrated === true,
    timestamp: str(raw.prediction_timestamp),
    dataStatus: str(raw.data_status) || 'unknown',
    rainfall: {
      recentMm: num(raw.recent_rainfall_mm),
      h1: num(raw.rainfall_1h_mm),
      h3: num(raw.rainfall_3h_mm),
      h24: num(raw.rainfall_24h_mm),
    },
    terrain:
      raw.terrain && typeof raw.terrain === 'object'
        ? { elevationM: num(raw.terrain.elevation_m), slopeDeg: num(raw.terrain.slope_deg), description: str(raw.terrain.description) }
        : null,
    drainDistanceM: num(raw.distance_to_drain_m),
    hotspot:
      raw.historical_hotspot && typeof raw.historical_hotspot === 'object'
        ? { name: str(raw.historical_hotspot.name), incidentCount: num(raw.historical_hotspot.incident_count) }
        : null,
    confirmedCurrentReports: num(raw.confirmed_current_reports),
  };
}

/** POST /route -> calculate a road route between two coordinates. */
export async function getRoadRoute({
  startLat,
  startLon,
  endLat,
  endLon,
}) {
  const raw = await jsonPost('/route', {
    start_lat: startLat,
    start_lon: startLon,
    end_lat: endLat,
    end_lon: endLon,
  });

  if (
    !raw ||
    !Array.isArray(raw.coordinates) ||
    raw.coordinates.length < 2
  ) {
    throw new ApiError(
      'The backend returned an invalid road route.',
      { kind: 'invalid' },
    );
  }

  return {
    coordinates: lngLatToLatLng(raw.coordinates),
    distanceM: num(raw.distance_m),
    distanceKm: num(raw.distance_km),
    nodesInRoute: num(raw.nodes_in_route),
  };
}


// ---------------------------------------------------------- route risk -----
/**
 * POST /route-risk
 * payload: { origin, destination, routes:[{route_id, geometry, distance_m, duration_s}], preference }
 * @returns {Promise<Array>} normalised per-route risk records
 */
export async function calculateRouteRisk(payload) {
  let raw;
  if (CONFIG.DEMO_MODE) {
    await sleep(900);
    raw = mockRouteRisk(payload);
  } else {
    raw = await jsonPost('/route-risk', payload);
  }
  return normalizeRouteRisk(raw);
}

function normalizeSegment(seg) {
  if (!seg || !Array.isArray(seg.coordinates)) return null;
  const valid = seg.coordinates.filter((p) => Array.isArray(p) && p.length >= 2 && isValidLatLng(p[1], p[0]));
  if (valid.length < 2) return null;
  const latlngs = lngLatToLatLng(valid);
  const prob = num(seg.risk_probability);
  const hs = seg.historical_hotspot && typeof seg.historical_hotspot === 'object' ? seg.historical_hotspot : null;
  return {
    latlngs,
    level: normalizeRisk(seg.risk_level, prob),
    prob,
    lengthM: pathLength(latlngs),
    rainfallMm: num(seg.rainfall_mm), // optional, shown in the segment popup when supplied
    hotspot: hs ? { name: str(hs.name), incidentCount: num(hs.incident_count) } : null,
  };
}

function normalizeRouteRisk(raw) {
  if (!raw || !Array.isArray(raw.routes)) throw new ApiError('The backend sent an unexpected route-risk response.', { kind: 'invalid' });
  return raw.routes
    .filter((r) => r && typeof r.route_id === 'string')
    .map((r) => {
      const avgProb = num(r.average_risk_probability);
      return {
        routeId: r.route_id,
        overall: normalizeRisk(r.overall_risk, avgProb),
        avgProb,
        highCount: num(r.high_risk_segment_count),
        highDistanceM: num(r.high_risk_distance_m),
        segments: (Array.isArray(r.risk_segments) ? r.risk_segments : []).map(normalizeSegment).filter(Boolean),
        calibrated: r.risk_probability_calibrated === true,
        timestamp: str(r.prediction_timestamp),
        dataStatus: str(r.data_status) || 'unknown',
      };
    });
}

// ------------------------------------------------------------- weather -----
const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

/**
 * Weather for a location. Source depends on CONFIG.WEATHER.provider.
 * "current" values from Open-Meteo are model-based analysis values, not rain-gauge readings,
 * and the "forecast" block is clearly a forecast - the UI keeps them separate.
 */
export async function getWeather({ latitude, longitude }) {
  const w = CONFIG.WEATHER;
  if (w.provider === 'none') {
    throw new ApiError('Weather data is not connected. Set WEATHER.provider in js/config.js.', { kind: 'unconfigured' });
  }

  if (w.provider === 'backend') {
    const raw = await backend('/weather', { query: { lat: latitude, lon: longitude } });
    if (!raw || typeof raw !== 'object') throw new ApiError('The backend sent an unexpected weather response.', { kind: 'invalid' });
    return {
      temperatureC: num(raw.temperature_c),
      precipitationMm: num(raw.precipitation_mm),
      description: str(raw.description),
      observedAt: str(raw.timestamp),
      source: str(raw.source) || 'JalAlert backend',
      basis: str(raw.basis) || 'unspecified',
      forecast: raw.forecast
        ? { hours: Array.isArray(raw.forecast.hours) ? raw.forecast.hours.length : null, totalMm: num(raw.forecast.total_mm), maxProbability: num(raw.forecast.max_probability) }
        : null,
    };
  }

  // Open-Meteo (no API key)
  const url = new URL(w.baseUrl);
  url.searchParams.set('latitude', latitude);
  url.searchParams.set('longitude', longitude);
  url.searchParams.set('current', 'temperature_2m,precipitation,weather_code');
  url.searchParams.set('hourly', 'precipitation,precipitation_probability');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('timezone', 'Asia/Kolkata');
  const raw = await fetchJson(url.toString(), { label: 'the weather service', timeoutMs: 10000 });

  const cur = raw?.current;
  if (!cur || typeof cur !== 'object') throw new ApiError('The weather service sent an unexpected response.', { kind: 'invalid' });

  let forecast = null;
  const times = raw?.hourly?.time;
  if (Array.isArray(times)) {
    const idx = [];
    for (let i = 0; i < times.length && idx.length < w.forecastHours; i++) if (times[i] > cur.time) idx.push(i);
    const mm = idx.map((i) => num(raw.hourly.precipitation?.[i])).filter((v) => v !== null);
    const pr = idx.map((i) => num(raw.hourly.precipitation_probability?.[i])).filter((v) => v !== null);
    forecast = {
      hours: idx.length,
      totalMm: mm.length ? mm.reduce((a, b) => a + b, 0) : null,
      maxProbability: pr.length ? Math.max(...pr) / 100 : null,
    };
  }

  return {
    temperatureC: num(cur.temperature_2m),
    precipitationMm: num(cur.precipitation),
    description: WMO[cur.weather_code] || null,
    observedAt: cur.time ? new Date(`${cur.time}:00+05:30`).toISOString() : null,
    source: 'Open-Meteo',
    basis: 'model-based current conditions (not a rain-gauge reading)',
    forecast,
  };
}

// ------------------------------------------------------------- hotspots -----
/** GET /hotspots?min_lat&min_lng&max_lat&max_lng */
export async function getHotspots(bounds) {
  let raw;
  if (CONFIG.DEMO_MODE) {
    await sleep(350);
    raw = sampleHotspotsResponse();
  } else {
    raw = await backend('/hotspots', { query: bounds });
    if (raw && Array.isArray(raw.hotspots)) raw = raw.hotspots;
  }
  if (!Array.isArray(raw)) throw new ApiError('The backend sent an unexpected hotspot response.', { kind: 'invalid' });

  return raw
    .filter((h) => h && isValidLatLng(h.latitude, h.longitude))
    .map((h, i) => {
      const prob = num(h.risk_probability);
      return {
        id: str(h.id) || `hotspot_${i}`,
        name: str(h.name) || 'Unnamed location',
        latitude: h.latitude,
        longitude: h.longitude,
        level: normalizeRisk(h.risk_level, prob),
        probability: prob,
        calibrated: h.risk_probability_calibrated === true,
        incidentCount: num(h.historical_incident_count),
        rainfallContext: str(h.rainfall_context),
        dataStatus: str(h.data_status) || 'unknown',
        timestamp: str(h.data_timestamp),
        radiusM: num(h.radius_m) || 600,
      };
    });
}

// -------------------------------------------------------------- reports -----
/** GET /reports?q&severity&status&from&to */
export async function getRecentReports(filters = {}) {
  let raw;
  if (CONFIG.DEMO_MODE) {
    await sleep(250);
    raw = SAMPLE_REPORTS;
  } else {
    raw = await backend('/reports', { query: filters });
    if (raw && Array.isArray(raw.reports)) raw = raw.reports;
  }
  if (!Array.isArray(raw)) throw new ApiError('The backend sent an unexpected reports response.', { kind: 'invalid' });

  const all = raw
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({
      id: str(r.id) || `report_${i}`,
      location: str(r.location) || 'Unnamed location',
      latitude: isNum(r.latitude) ? r.latitude : null,
      longitude: isNum(r.longitude) ? r.longitude : null,
      observedAt: str(r.observed_at),
      severity: ['low', 'moderate', 'high'].includes(r.severity) ? r.severity : 'unknown',
      status: ['verified', 'unverified', 'historical'].includes(r.status) ? r.status : 'unverified',
      source: str(r.source) || 'Unknown source',
      description: str(r.description),
    }));

  // Demo mode filters locally. In API mode the backend gets the filters as query
  // parameters, and we apply them again here so a simple backend still works.
  return applyReportFilters(all, filters);
}

export function applyReportFilters(list, f = {}) {
  const q = (f.q || '').trim().toLowerCase();
  const from = f.from ? new Date(`${f.from}T00:00:00+05:30`).getTime() : null;
  const to = f.to ? new Date(`${f.to}T23:59:59+05:30`).getTime() : null;
  return list
    .filter((r) => !q || r.location.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
    .filter((r) => !f.severity || r.severity === f.severity)
    .filter((r) => !f.status || r.status === f.status)
    .filter((r) => {
      const t = r.observedAt ? new Date(r.observedAt).getTime() : null;
      if ((from || to) && t === null) return false;
      return (!from || t >= from) && (!to || t <= to);
    })
    .sort((a, b) => new Date(b.observedAt || 0) - new Date(a.observedAt || 0));
}

/**
 * POST /reports (multipart/form-data so a photo can be attached).
 * Resolves with { submitted: true, reportId } ONLY if the backend confirms.
 * In demo mode nothing is sent and { submitted: false, demo: true } is returned,
 * so the UI can never show a fake "saved" message.
 */
export async function submitWaterloggingReport(payload) {
  if (CONFIG.DEMO_MODE) {
    await sleep(500);
    return { submitted: false, demo: true };
  }
  const form = new FormData();
  form.append('latitude', String(payload.latitude));
  form.append('longitude', String(payload.longitude));
  form.append('description', payload.description);
  form.append('severity', payload.severity);
  form.append('observed_at', payload.observedAt);
  if (payload.photo) form.append('photo', payload.photo);

  // No Content-Type header: the browser sets the multipart boundary itself.
  const data = await backend('/reports', { method: 'POST', body: form, timeoutMs: 30000 });
  const confirmed = data && (data.status === 'received' || data.status === 'ok' || data.report_id !== undefined);
  if (!confirmed) throw new ApiError('The backend did not confirm that the report was saved.', { kind: 'invalid' });
  return { submitted: true, reportId: data.report_id ?? null };
}
