/**
 * Shared app state and a very small event bus.
 * Modules talk to each other with emit()/on() instead of importing each other,
 * which avoids circular imports and keeps each file easy to read.
 */

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}

export function emit(event, data) {
  (listeners.get(event) || []).forEach((fn) => {
    try {
      fn(data);
    } catch (err) {
      console.error(`Error in "${event}" listener`, err);
    }
  });
}

export const state = {
  view: 'dashboard',
  pick: null, // null | 'origin' | 'destination' | 'report'  (waiting for a map click)
  userLocation: null, // kept in memory only, never saved
  selectedPoint: null,
  hotspots: [],
  hotspotsStatus: 'idle', // idle | loading | ready | unavailable
  reports: [],
  lastRefresh: null,
  backend: 'unknown', // unknown | demo | online | offline
};

// ---------------------------------------------------------- map picking -----
export function startPick(target, message) {
  state.pick = target;
  document.body.classList.add('picking');
  const banner = document.getElementById('pickBanner');
  document.getElementById('pickBannerText').textContent = message;
  banner.hidden = false;
  emit('pick-start', { target });
}

export function cancelPick() {
  if (!state.pick) return;
  state.pick = null;
  document.body.classList.remove('picking');
  document.getElementById('pickBanner').hidden = true;
  emit('pick-end');
}

// ---------------------------------------------------- harmless UI prefs -----
// Only UI preferences are stored (layer toggles, route preference, travel mode).
// Locations, routes and citizen reports are never written to localStorage.
const PREFS_KEY = 'jalalert.prefs.v2';

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

export function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    /* storage may be blocked; preferences are optional */
  }
}
