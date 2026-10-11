/**
 * Delhi JalAlert - central configuration
 * ------------------------------------------------------------
 * Change values here to switch between demo mode and a real backend,
 * or to swap the routing / geocoding / weather providers.
 *
 * NEVER put private API keys in this file. Everything in js/ is public.
 * If a provider needs a secret key (e.g. openrouteservice), call it through
 * your FastAPI backend and point the base URL below at that proxy.
 */

// Quick override for demos: open index.html?demo=0 to force API mode,
// or ?demo=1 to force demo mode. (Only demo mode can be overridden via URL
// on purpose, so a shared link can never redirect the app to another backend.)
const params = new URLSearchParams(window.location.search);
const demoParam = params.get('demo');

export const CONFIG = {
  // ---- Mode -------------------------------------------------------------
  // true  -> risk predictions, hotspots and reports come from built-in SAMPLE data (js/mock.js)
  // false -> the app talks to the FastAPI backend at API_BASE_URL
  DEMO_MODE: demoParam === null ? true : !(demoParam === '0' || demoParam === 'false'),

  // ---- Backend (FastAPI) ---------------------------------------------------
  API_BASE_URL: 'http://127.0.0.1:8001',
  API_TIMEOUT_MS: 15000,

  // ---- Map ---------------------------------------------------------------
  MAP: {
    center: [28.6139, 77.2090], // Delhi
    zoom: 11,
    minZoom: 8,
    maxZoom: 19,
    // Rough Delhi-NCR box: [[south, west], [north, east]]
    ncrBounds: [[28.20, 76.70], [29.10, 77.70]],

    // Which base map to show first. Users can switch in the layer menu.
    defaultStyle: 'osm',

    // Optional: a MapTiler key unlocks the extra "MapTiler Streets" style.
    // Get a free key at https://cloud.maptiler.com/ and RESTRICT it to your site's domain
    // in the MapTiler dashboard (browser map keys are visible to users by design).
    // Leave '' to disable. Never use a private/server key here.
    maptilerKey: '',

    // Base-map styles. Each style is one or more raster tile layers.
    // A "labels" layer is drawn ABOVE the route lines so street names stay readable.
    styles: {
      voyager: {
        label: 'Map',
        base: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png' },
        labels: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png' },
        subdomains: 'abcd',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
      },
      light: {
        label: 'Light',
        base: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_nolabels/{z}/{x}/{y}{r}.png' },
        labels: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_only_labels/{z}/{x}/{y}{r}.png' },
        subdomains: 'abcd',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
      },
      osm: {
        label: 'Standard (OSM)',
        base: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
        labels: null,
        subdomains: 'abc',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      },
      satellite: {
        label: 'Satellite',
        base: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' },
        labels: { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}{r}.png' },
        subdomains: 'abcd',
        attribution:
          'Imagery &copy; Esri, Maxar, Earthstar Geographics &middot; Labels &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
      },
    },
  },

  // ---- Risk classification -------------------------------------------------
  // These thresholds are only used when the backend sends a probability but no
  // risk_level, and by the demo-mode mock model. They MUST match the backend.
  RISK: {
    thresholds: { moderate: 0.35, high: 0.6 },
    // Set to true only if your model's scores are calibrated probabilities.
    // The backend can also say so per response with "risk_probability_calibrated": true.
    probabilityIsCalibrated: false,
    // Single source of truth for risk colours (also pushed into CSS variables).
    colors: {
      low: '#16a34a',
      moderate: '#f59e0b',
      high: '#dc2626',
      unknown: '#6b7280',
    },
  },

  // ---- Route ranking -------------------------------------------------------
  RANKING: {
    // "Balanced" preference = weight * normalised time + (1 - weight) * normalised risk
    balancedTimeWeight: 0.5,
    // Differences smaller than this (in 0-1 score units) are described as "similar".
    similarRiskDelta: 0.03,
  },

  // ---- Routing provider ----------------------------------------------------
  ROUTING: {
    provider: 'osrm', // 'osrm' | 'ors'
    timeoutMs: 15000,
    maxAlternatives: 3,
    // OSRM-compatible servers. The FOSSGIS servers run SEPARATE car, bike and foot
    // profiles, so each travel mode gets a genuinely different route.
    // Fair-use public servers, no uptime guarantee. Self-host OSRM for production.
    // A mode whose endpoint is missing is shown as unavailable (never faked).
    osrm: {
      endpoints: {
        driving: 'https://routing.openstreetmap.de/routed-car',
        cycling: 'https://routing.openstreetmap.de/routed-bike',
        walking: 'https://routing.openstreetmap.de/routed-foot',
      },
    },
    ors: {
      // openrouteservice needs an API key. Do NOT put the key here.
      // Create a small proxy route in FastAPI (e.g. /proxy/ors) that adds the key,
      // then set baseUrl to `${API_BASE_URL}/proxy/ors`.
      baseUrl: '',
    },
    // Travel modes. `endpoint` picks the OSRM server above, `orsProfile` the ORS profile.
    // No free routing provider offers a motorcycle/scooter profile, so two-wheeler is
    // disabled instead of silently returning a car route.
    modes: {
      driving: { label: 'Driving', icon: 'car', endpoint: 'driving', orsProfile: 'driving-car', speedMps: 12 },
      two_wheeler: {
        label: 'Two-wheeler', icon: 'two-wheeler', supported: false,
        unavailableNote: 'Two-wheeler routing is not available with the current routing provider. Driving, walking and cycling are supported.',
      },
      walking: { label: 'Walking', icon: 'footprints', endpoint: 'walking', orsProfile: 'foot-walking', speedMps: 1.4 },
      cycling: { label: 'Cycling', icon: 'bike', endpoint: 'cycling', orsProfile: 'cycling-regular', speedMps: 4.5 },
    },
    defaultMode: 'driving',
  },

  // ---- Journey (route-following) mode ---------------------------------------
  JOURNEY: {
    warnDistanceM: 600, // show a warning when a risky section is this close ahead
    warnLevels: ['high'], // which risk levels trigger warnings
    offRouteM: 60, // metres from the route before "off route" is considered
    offRouteConfirmations: 2, // consecutive position updates needed
    staleRiskMinutes: 60, // risk data older than this is flagged as possibly outdated
    followZoom: 16,
    // Lets you demo the journey without moving: a clearly-labelled simulated position
    // that travels along the route. Set false to remove the button.
    allowSimulation: true,
    simulationSpeedFactor: 12, // multiples of the route's average speed
  },

  // ---- Geocoding (place search) ------------------------------------------------
  GEOCODING: {
    provider: 'nominatim',
    // Nominatim usage policy: max 1 request/second, no autocomplete-on-every-keystroke,
    // identify your app. See https://operations.osmfoundation.org/policies/nominatim/
    baseUrl: 'https://nominatim.openstreetmap.org',
    debounceMs: 700,
    minChars: 3,
    minIntervalMs: 1100,
    countryCodes: 'in',
    viewbox: '76.70,29.05,77.60,28.20', // left,top,right,bottom
    bounded: true, // only return results inside the viewbox
    limit: 5,
    language: 'en',
    contactEmail: '', // optional: your email, sent as `email=` as Nominatim asks
  },

  // ---- Weather -----------------------------------------------------------------
  WEATHER: {
    // 'open-meteo' -> free, no API key, called directly from the browser
    // 'backend'    -> GET {API_BASE_URL}/weather?lat=..&lon=..
    // 'none'       -> weather panel shows a "not connected" message
    provider: 'open-meteo',
    baseUrl: 'https://api.open-meteo.com/v1/forecast',
    forecastHours: 6,
  },

  // ---- Citizen reports -----------------------------------------------------------
  REPORTS: {
    maxPhotoBytes: 5 * 1024 * 1024,
    allowedPhotoTypes: ['image/jpeg', 'image/png', 'image/webp'],
    minDescriptionLength: 10,
    maxDescriptionLength: 500,
  },
};
