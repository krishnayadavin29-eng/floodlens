/**
 * Small, dependency-free helpers used across the app.
 * Coordinate conventions:
 *   - GeoJSON / API payloads use [longitude, latitude]
 *   - Leaflet and most of our own code use [latitude, longitude]
 * Helpers below say which one they expect.
 */
import { CONFIG } from './config.js';

// ---------------------------------------------------------------- risk -----
export const RISK_META = {
  low: { label: 'Low', phrase: 'Low estimated risk', color: CONFIG.RISK.colors.low },
  moderate: { label: 'Moderate', phrase: 'Moderate estimated risk', color: CONFIG.RISK.colors.moderate },
  high: { label: 'High', phrase: 'High estimated risk', color: CONFIG.RISK.colors.high },
  unknown: { label: 'Unknown', phrase: 'Risk assessment unavailable', color: CONFIG.RISK.colors.unknown },
};

/** Turn a probability (0-1) into a level using the configured thresholds. */
export function levelFromProbability(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'unknown';
  if (p >= CONFIG.RISK.thresholds.high) return 'high';
  if (p >= CONFIG.RISK.thresholds.moderate) return 'moderate';
  return 'low';
}

/**
 * Decide which risk level to show.
 * 1. Trust the backend's level when it is one we know.
 * 2. Otherwise derive it from the probability.
 * 3. Otherwise "unknown" - a missing prediction is NEVER shown as low risk.
 */
export function normalizeRisk(level, probability) {
  const lv = typeof level === 'string' ? level.trim().toLowerCase() : '';
  if (lv === 'low' || lv === 'moderate' || lv === 'high') return lv;
  if (lv === 'medium') return 'moderate';
  return levelFromProbability(probability);
}

export function riskColor(level) {
  return (RISK_META[level] || RISK_META.unknown).color;
}

/** Put the configured risk colours into CSS variables so JS and CSS never disagree. */
export function applyRiskColorsToCss() {
  const root = document.documentElement.style;
  Object.entries(CONFIG.RISK.colors).forEach(([k, v]) => root.setProperty(`--risk-${k}`, v));
}

/** Label for a numeric score. Uncalibrated model scores are not called "probability". */
export function scoreLabel(calibrated) {
  return calibrated || CONFIG.RISK.probabilityIsCalibrated ? 'Estimated probability' : 'Model risk score';
}

export function isCalibrated(flag) {
  return flag === true || CONFIG.RISK.probabilityIsCalibrated;
}

export const DATA_STATUS_LABELS = {
  example: 'Illustrative sample data',
  sample: 'Illustrative sample data',
  model: 'Model-predicted',
  forecast: 'Forecast-based',
  historical: 'Historical record',
  live: 'Live observation',
  unknown: 'Unknown data status',
};

export function dataStatusLabel(status) {
  return DATA_STATUS_LABELS[status] || DATA_STATUS_LABELS.unknown;
}

// ---------------------------------------------------------------- misc -----
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function isValidLatLng(lat, lng) {
  return isNum(lat) && isNum(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function isInsideNcr(lat, lng) {
  const [[s, w], [n, e]] = CONFIG.MAP.ncrBounds;
  return lat >= s && lat <= n && lng >= w && lng <= e;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ------------------------------------------------------------ geometry -----
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two [lat, lng] points. */
export function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Length in metres of a [[lat,lng], ...] path. */
export function pathLength(latlngs) {
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) total += haversine(latlngs[i - 1], latlngs[i]);
  return total;
}

/** [[lng,lat], ...] -> [[lat,lng], ...] */
export function lngLatToLatLng(coords) {
  return coords.map(([lng, lat]) => [lat, lng]);
}

/**
 * Split a [[lng,lat], ...] line into pieces of roughly `targetM` metres.
 * Used only by the demo-mode mock model (a real backend does its own splitting).
 */
export function splitIntoSegments(coords, targetM = 400) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const segments = [];
  let current = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    acc += haversine([a[1], a[0]], [b[1], b[0]]);
    current.push(b);
    if (acc >= targetM) {
      segments.push(current);
      current = [b];
      acc = 0;
    }
  }
  if (current.length > 1) {
    if (acc < targetM / 3 && segments.length) segments[segments.length - 1].push(...current.slice(1));
    else segments.push(current);
  }
  return segments;
}

// ---------------------------------------------------------- formatting -----
export function formatDistance(m) {
  if (!isNum(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function formatDuration(s) {
  if (!isNum(s)) return '—';
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatPercent(p, digits = 0) {
  return isNum(p) ? `${(p * 100).toFixed(digits)}%` : '—';
}

const dtFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const dFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });

export function formatDateTime(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${dtFormat.format(d)} IST` : null;
}

export function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? dFormat.format(d) : '—';
}

export function formatCoords(lat, lng) {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** "3 min ago" style text for a Date or ISO string. */
export function timeAgo(value) {
  const d = value instanceof Date ? value : new Date(value);
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (!Number.isFinite(sec)) return '—';
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return formatDate(d.toISOString());
}

/** Deterministic pseudo-random number in [0, 1) from two numbers (for mock data). */
export function hashNoise(a, b) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ------------------------------------------------- path projection (journey) --
/** Cumulative distances along a [[lat,lng], ...] path. cum[i] = metres from the start to point i. */
export function buildPathIndex(latlngs) {
  const cum = [0];
  for (let i = 1; i < latlngs.length; i++) cum.push(cum[i - 1] + haversine(latlngs[i - 1], latlngs[i]));
  return { latlngs, cum, total: cum[cum.length - 1] || 0 };
}

/**
 * Find the closest point on the path to `point` ([lat,lng]).
 * Returns { along, distance, index }: metres travelled along the path to that point,
 * metres between the point and the path, and the segment index.
 * Uses a local flat-earth approximation, accurate to centimetres at city scale.
 */
export function projectOnPath(index, point) {
  const { latlngs, cum } = index;
  const k = Math.cos(toRad(point[0]));
  const mx = 111320 * k;
  const my = 110540;
  let best = { distance: Infinity, along: 0, index: 0 };
  for (let i = 0; i < latlngs.length - 1; i++) {
    const ax = (latlngs[i][1] - point[1]) * mx;
    const ay = (latlngs[i][0] - point[0]) * my;
    const bx = (latlngs[i + 1][1] - point[1]) * mx;
    const by = (latlngs[i + 1][0] - point[0]) * my;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(px, py);
    if (d < best.distance) best = { distance: d, along: cum[i] + t * (cum[i + 1] - cum[i]), index: i };
  }
  return best;
}

/** Point at `along` metres from the start of the path (for the simulated journey). */
export function pointAtDistance(index, along) {
  const { latlngs, cum, total } = index;
  const d = Math.max(0, Math.min(total, along));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / span;
  return [latlngs[i - 1][0] + (latlngs[i][0] - latlngs[i - 1][0]) * t, latlngs[i - 1][1] + (latlngs[i][1] - latlngs[i - 1][1]) * t];
}

const clockFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

/** "6:20 pm" for now + `seconds`. */
export function arrivalClock(seconds, from = Date.now()) {
  if (!isNum(seconds)) return null;
  return clockFormat.format(new Date(from + seconds * 1000)).replace('AM', 'am').replace('PM', 'pm');
}
