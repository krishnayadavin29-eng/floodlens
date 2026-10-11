/**
 * geolocation.js - "use my current location".
 * We show our own explanation dialog BEFORE the browser's permission prompt,
 * and keep the result in memory only (never saved to localStorage).
 */
import { state } from './state.js';
import { confirmDialog, toast } from './ui.js';
import { setUserLocation, flyTo } from './map.js';
import { isInsideNcr } from './utils.js';

export class GeoError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'GeoError';
    this.kind = kind; // 'unsupported' | 'declined' | 'denied' | 'unavailable' | 'timeout'
  }
}

let consentGiven = false;

/**
 * @returns {Promise<{lat:number,lng:number,accuracy:number}>}
 * @throws {GeoError} with a message that can be shown directly to the user
 */
export async function requestUserLocation() {
  if (!('geolocation' in navigator)) {
    throw new GeoError('Your browser does not support location access. Search for a place or click the map instead.', 'unsupported');
  }

  if (!consentGiven) {
    const ok = await confirmDialog({
      title: 'Use your current location?',
      message:
        'Delhi JalAlert will ask your browser for your location to set your starting point and show it on the map. It stays in this browser tab and is not saved or uploaded.',
      confirmText: 'Continue',
      cancelText: 'Not now',
    });
    if (!ok) throw new GeoError('Location access was cancelled. You can search for a starting place or click the map instead.', 'declined');
    consentGiven = true;
  }

  const position = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }).catch((err) => {
    consentGiven = err.code === 1 ? false : consentGiven;
    if (err.code === 1) {
      throw new GeoError('Location permission was denied. Type a starting place or click the map instead. You can re-enable location in your browser’s site settings.', 'denied');
    }
    if (err.code === 3) throw new GeoError('Finding your location took too long. Try again, or choose a start point manually.', 'timeout');
    throw new GeoError('Your location is not available right now. Choose a start point manually.', 'unavailable');
  });

  const loc = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
  state.userLocation = loc;
  setUserLocation(loc);
  if (!isInsideNcr(loc.lat, loc.lng)) {
    toast('You appear to be outside Delhi-NCR. Risk data only covers the Delhi area.', 'warning', 7000);
  }
  return loc;
}

/** Button handler: get location and move the map there. */
export async function locateAndShow() {
  try {
    const loc = await requestUserLocation();
    if (isInsideNcr(loc.lat, loc.lng)) flyTo(loc.lat, loc.lng, 14);
    toast('Showing your current location on the map.', 'success', 3000);
    return loc;
  } catch (err) {
    toast(err.message, err.kind === 'declined' ? 'info' : 'warning', 7000);
    return null;
  }
}
