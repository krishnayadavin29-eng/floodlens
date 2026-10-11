/**
 * geocoding.js - place search (address -> coordinates) and reverse lookup.
 *
 * OpenStreetMap *tiles* cannot search places, so we use a separate geocoder.
 * Default: Nominatim (free, but with a strict usage policy):
 *   - max 1 request per second  -> we enforce a minimum interval below
 *   - no search-as-you-type on every key -> the autocomplete debounces (see autocomplete.js)
 *   - results should be cached  -> small in-memory cache below
 * Policy: https://operations.osmfoundation.org/policies/nominatim/
 *
 * To swap providers (Photon, Mapbox, Google...), keep these two function
 * signatures and change the internals - nothing else in the app needs to change.
 */
import { CONFIG } from './config.js';
import { isInsideNcr, isNum, isValidLatLng, sleep } from './utils.js';

export class GeocodingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeocodingError';
  }
}

const searchCache = new Map();
const reverseCache = new Map();
let lastRequestAt = 0;
let queue = Promise.resolve();

/** Run requests one at a time, at least minIntervalMs apart. */
function throttled(task) {
  const run = async () => {
    const wait = lastRequestAt + CONFIG.GEOCODING.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

async function getJson(url, signal) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new GeocodingError('Place search is unavailable right now. You can still click the map to choose a point.');
  }
  if (res.status === 429) throw new GeocodingError('Place search is rate-limited. Wait a few seconds and try again.');
  if (!res.ok) throw new GeocodingError(`Place search failed (HTTP ${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new GeocodingError('Place search returned an unreadable response.');
  }
}

function shortLabel(displayName) {
  return String(displayName).split(',').slice(0, 3).join(',').trim();
}

/**
 * Search for places in Delhi-NCR.
 * @returns {Promise<Array<{id, name, label, lat, lng, source}>>}
 */
export async function searchPlaces(query, { signal } = {}) {
  const g = CONFIG.GEOCODING;
  const q = query.trim();
  if (q.length < g.minChars) return [];
  const key = q.toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key);

  const url = new URL('/search', g.baseUrl);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q.toLowerCase().includes('delhi') ? q : `${q}, Delhi`);
  url.searchParams.set('limit', String(g.limit));
  url.searchParams.set('countrycodes', g.countryCodes);
  url.searchParams.set('viewbox', g.viewbox);
  url.searchParams.set('bounded', g.bounded ? '1' : '0');
  url.searchParams.set('accept-language', g.language);
  url.searchParams.set('addressdetails', '0');
  if (g.contactEmail) url.searchParams.set('email', g.contactEmail);

  const raw = await throttled(() => getJson(url.toString(), signal));
  if (!Array.isArray(raw)) throw new GeocodingError('Place search returned an unexpected response.');

  const results = raw
    .map((r) => ({ lat: parseFloat(r.lat), lng: parseFloat(r.lon), r }))
    .filter((x) => isValidLatLng(x.lat, x.lng) && isInsideNcr(x.lat, x.lng))
    .map(({ lat, lng, r }) => ({
      id: `nominatim_${r.place_id}`,
      name: shortLabel(r.display_name).split(',')[0],
      label: shortLabel(r.display_name),
      lat,
      lng,
      source: 'nominatim',
    }));

  searchCache.set(key, results);
  return results;
}

/** Reverse geocode a point to a readable place name, or null if none. Never throws. */
export async function reverseGeocode(lat, lng) {
  if (!isNum(lat) || !isNum(lng)) return null;
  const g = CONFIG.GEOCODING;
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseCache.has(key)) return reverseCache.get(key);

  const url = new URL('/reverse', g.baseUrl);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', '16');
  url.searchParams.set('accept-language', g.language);
  if (g.contactEmail) url.searchParams.set('email', g.contactEmail);

  try {
    const raw = await throttled(() => getJson(url.toString()));
    const name = raw && typeof raw.display_name === 'string' ? shortLabel(raw.display_name) : null;
    reverseCache.set(key, name);
    return name;
  } catch {
    return null; // a missing place name is not an error worth interrupting the user for
  }
}
