/**
 * map.js - everything that touches Leaflet.
 * The map is created ONCE (initMap) and layers are cleared/redrawn as data changes.
 * Other modules never call Leaflet directly; they use the functions exported here.
 */
import { CONFIG } from './config.js';
import {
  riskColor, RISK_META, formatDistance, formatDuration, formatPercent, formatDateTime, dataStatusLabel, scoreLabel,
  isCalibrated, formatCoords,
} from './utils.js';
import { h, icon, refreshIcons, riskBadge } from './ui.js';

let map;
const layers = {}; // name -> L.LayerGroup
let baseLayers = []; // tile layers of the active base-map style
let baseStyleId = null;
let inspectMarker = null;
let userMarker = null;
let userAccuracy = null;
let originMarker = null;
let destMarker = null;
let clickHandler = null;
let userPanHandler = null;
let tileErrors = 0;
let tileLoaded = false;
let lastRoutes = null; // remembered so routes can be redrawn when the risk-colour toggle changes

export const LAYER_NAMES = ['base', 'route', 'riskColors', 'risk', 'hotspots'];
const layerStatus = { base: 'ready', risk: 'idle', hotspots: 'idle', route: 'ready', riskColors: 'ready' };
// Defaults: clean navigation map. The analytical overlays (risk zones, hotspots) are OFF.
const layerVisible = { base: true, route: true, riskColors: true, risk: false, hotspots: false };

const ROUTE_BLUE = '#1a6fe0';
const ALT_GREY = '#8696ab';

// ------------------------------------------------------------------ init -----
/** Base-map styles available to the layer menu (MapTiler only if a key is configured). */
export function getBaseStyles() {
  const styles = { ...CONFIG.MAP.styles };
  const key = CONFIG.MAP.maptilerKey;
  if (key) {
    styles.maptiler = {
      label: 'MapTiler Streets',
      base: { url: `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}` },
      labels: null,
      subdomains: 'abc',
      attribution:
        '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    };
  }
  return Object.entries(styles).map(([id, st]) => ({ id, label: st.label }));
}

export function getBaseStyle() {
  return baseStyleId;
}

export function initMap(containerId, initialVisibility = {}, initialStyle = CONFIG.MAP.defaultStyle) {
  map = L.map(containerId, {
    center: CONFIG.MAP.center,
    zoom: CONFIG.MAP.zoom,
    minZoom: CONFIG.MAP.minZoom,
    maxZoom: CONFIG.MAP.maxZoom,
    zoomControl: false, // we draw our own zoom buttons in the toolbar
    maxBounds: L.latLngBounds([[CONFIG.MAP.ncrBounds[0][0] - 2, CONFIG.MAP.ncrBounds[0][1] - 2], [CONFIG.MAP.ncrBounds[1][0] + 2, CONFIG.MAP.ncrBounds[1][1] + 2]]),
  });
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  // Panes control drawing order: risk zones < routes < street-name labels < markers
  map.createPane('riskPane').style.zIndex = 380;
  map.createPane('routePane').style.zIndex = 420;
  const labelsPane = map.createPane('labelsPane');
  labelsPane.style.zIndex = 450; // above routes, so road names stay readable
  labelsPane.style.pointerEvents = 'none';

  for (const name of ['risk', 'hotspots', 'route', 'reports']) layers[name] = L.layerGroup().addTo(map);
  Object.assign(layerVisible, initialVisibility);
  setBaseStyle(initialStyle);
  ['risk', 'hotspots', 'route'].forEach((n) => applyVisibility(n));

  map.on('click', (e) => clickHandler?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
  map.on('dragstart', () => userPanHandler?.());
  map.on('popupopen', refreshIcons);
  // Leaflet only measures its container once. Re-measure whenever the container's size changes
  // (window resize, panel collapse, mobile sheet moving, fullscreen) so the map never ends up cropped.
  window.addEventListener('resize', () => map.invalidateSize());
  if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.getElementById(containerId));
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}

export function onMapClick(fn) {
  clickHandler = fn;
}

/** Called when the user drags the map (used to stop auto-following during a journey). */
export function onUserPan(fn) {
  userPanHandler = fn;
}

export function invalidateSize() {
  map?.invalidateSize();
}

export function zoomIn() {
  map.zoomIn();
}

export function zoomOut() {
  map.zoomOut();
}

// ------------------------------------------------------------ base styles -----
export function setBaseStyle(id) {
  const all = Object.fromEntries(getBaseStyles().map((s) => [s.id, true]));
  const styleId = all[id] ? id : CONFIG.MAP.defaultStyle;
  const style = { ...CONFIG.MAP.styles, ...(CONFIG.MAP.maptilerKey ? { maptiler: undefined } : {}) }[styleId] || getMapTilerStyle();
  baseLayers.forEach((l) => map.removeLayer(l));
  baseLayers = [];
  baseStyleId = styleId;
  tileErrors = 0;
  tileLoaded = false;

  const common = { maxZoom: CONFIG.MAP.maxZoom, subdomains: style.subdomains, detectRetina: true };
  const base = L.tileLayer(style.base.url, { ...common, attribution: style.attribution });
  baseLayers.push(base);
  if (style.labels) baseLayers.push(L.tileLayer(style.labels.url, { ...common, pane: 'labelsPane', attribution: '' }));
  watchTiles(base);
  if (layerVisible.base) baseLayers.forEach((l) => l.addTo(map));
}

function getMapTilerStyle() {
  const key = CONFIG.MAP.maptilerKey;
  return {
    label: 'MapTiler Streets',
    base: { url: `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}` },
    labels: null,
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  };
}

function watchTiles(tileLayer) {
  const loading = document.getElementById('mapLoading');
  const message = document.getElementById('mapMessage');
  const hideLoading = () => loading && (loading.hidden = true);

  tileLayer.on('tileload', () => {
    tileLoaded = true;
    tileErrors = 0;
    hideLoading();
    if (message) message.hidden = true;
  });
  tileLayer.on('load', hideLoading);
  tileLayer.on('tileerror', () => {
    tileErrors += 1;
    if (tileErrors >= 4 && !tileLoaded) showTileMessage();
  });
  // If nothing has loaded after a while, say so instead of spinning forever.
  setTimeout(() => {
    if (!tileLoaded && baseLayers[0] === tileLayer) showTileMessage();
  }, 9000);

  function showTileMessage() {
    hideLoading();
    if (!message) return;
    message.hidden = false;
    message.replaceChildren(
      icon('wifi-off'),
      h('div', {}, h('strong', { text: 'Map tiles could not be loaded.' }), h('p', { text: 'Check your internet connection or try another map style. Routes and overlays still draw, but without a base map.' })),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => { tileErrors = 0; message.hidden = true; tileLayer.redraw(); } }, icon('refresh-cw'), 'Retry')
    );
    refreshIcons();
  }
}

// -------------------------------------------------------------- view ctl -----
export function resetView() {
  map.flyTo(CONFIG.MAP.center, CONFIG.MAP.zoom, { duration: 0.8 });
}

/** Extra padding so content is not hidden under the mobile bottom sheet. */
function fitPadding() {
  const panel = document.getElementById('panel');
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const navigating = document.body.classList.contains('navigating');
  // During a journey the instruction card (top) and stats bar (bottom) sit over the map.
  const top = navigating ? 150 : 32;
  const bottom = navigating ? 170 : mobile && panel ? panel.offsetHeight + 24 : 32;
  return { paddingTopLeft: [32, top], paddingBottomRight: [32, bottom] };
}

/** Move the map to a point without the long fly animation (used while following a journey). */
export function centerOn(lat, lng, zoom) {
  if (zoom) map.setView([lat, lng], zoom, { animate: true });
  else map.panTo([lat, lng], { animate: true });
}

export function flyTo(lat, lng, zoom = 15) {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  map.flyTo([lat, lng], zoom, { duration: 0.8 });
  if (mobile) setTimeout(() => map.panBy([0, document.getElementById('panel').offsetHeight / 3]), 900);
}

// --------------------------------------------------------- layer control -----
function applyVisibility(name) {
  const visible = layerVisible[name];
  if (name === 'base') {
    baseLayers.forEach((l) => (visible ? l.addTo(map) : map.removeLayer(l)));
    return;
  }
  if (name === 'riskColors') {
    drawRoutes(); // same lines, different colouring
    return;
  }
  const group = layers[name];
  if (!group) return;
  if (visible) group.addTo(map);
  else map.removeLayer(group);
}

export function setLayerVisible(name, visible) {
  layerVisible[name] = visible;
  applyVisibility(name);
}

export const isLayerVisible = (name) => layerVisible[name];
export const getLayerStatus = (name) => layerStatus[name];

/** status: 'idle' | 'loading' | 'ready' | 'unavailable' */
export function setLayerStatus(name, status, message = '') {
  layerStatus[name] = status;
  document.querySelectorAll(`[data-layer-status="${name}"]`).forEach((el) => {
    el.textContent = status === 'unavailable' ? message || 'Data unavailable' : status === 'loading' ? 'Loading…' : '';
    el.classList.toggle('is-unavailable', status === 'unavailable');
  });
}

// ------------------------------------------------------------- hotspots -----
function detailLine(label, value) {
  return h('div', { class: 'pop-row' }, h('span', { class: 'pop-label', text: label }), h('span', { class: 'pop-value', text: value }));
}

export function buildHotspotPopup(hs) {
  const timestamp = formatDateTime(hs.timestamp);
  return h(
    'div',
    { class: 'popup' },
    h('h3', { class: 'pop-title', text: hs.name }),
    h('div', { class: 'pop-badges' }, riskBadge(hs.level, RISK_META[hs.level].phrase)),
    detailLine(scoreLabel(isCalibrated(hs.calibrated)), hs.probability !== null ? formatPercent(hs.probability) : 'Not available'),
    detailLine('Historical incidents', hs.incidentCount !== null ? String(hs.incidentCount) : 'Not available'),
    detailLine('Rainfall context', hs.rainfallContext || 'Not available'),
    detailLine('Data type', `${dataStatusLabel(hs.dataStatus)} · model-predicted risk + historical count`),
    detailLine('Data timestamp', timestamp || 'Not available (static sample)'),
    h('p', { class: 'pop-note', text: 'Historical records are not current conditions. This does not mean the road is flooded now.' })
  );
}

/**
 * Draw risk zones (translucent circles) and historical hotspot markers.
 * Layers whose data is missing show an "unavailable" status instead of inventing anything.
 */
export function renderHotspots(hotspots) {
  layers.risk.clearLayers();
  layers.hotspots.clearLayers();

  for (const hs of hotspots) {
    const color = riskColor(hs.level);
    L.circle([hs.latitude, hs.longitude], {
      radius: hs.radiusM,
      pane: 'riskPane',
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.12,
      dashArray: hs.level === 'unknown' ? '5 5' : null,
      interactive: false,
    }).addTo(layers.risk);
  }

  const historical = hotspots.filter((hs) => hs.incidentCount !== null && hs.incidentCount > 0);
  for (const hs of historical) {
    const marker = L.marker([hs.latitude, hs.longitude], {
      icon: L.divIcon({
        className: 'hotspot-icon',
        html: `<span class="hotspot-pin" aria-hidden="true"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      title: hs.name,
      keyboard: true,
      alt: `Historical hotspot: ${hs.name}`,
    });
    marker.bindPopup(() => buildHotspotPopup(hs), { maxWidth: 300 });
    marker.addTo(layers.hotspots);
  }

  setLayerStatus('risk', hotspots.length ? 'ready' : 'unavailable', 'No risk data supplied');
  setLayerStatus('hotspots', historical.length ? 'ready' : 'unavailable', 'No historical hotspot data supplied');
}

export function markHotspotLayersUnavailable(message) {
  layers.risk.clearLayers();
  layers.hotspots.clearLayers();
  setLayerStatus('risk', 'unavailable', message);
  setLayerStatus('hotspots', 'unavailable', message);
}

export function openHotspot(hs) {
  flyTo(hs.latitude, hs.longitude, 15);
  const marker = layers.hotspots.getLayers().find((m) => m.getLatLng().equals([hs.latitude, hs.longitude]));
  if (marker) setTimeout(() => marker.openPopup(), 900);
}

// --------------------------------------------------------------- markers -----
const pinIcon = (cls, html) =>
  L.divIcon({ className: 'pin-icon', html: `<span class="pin ${cls}" aria-hidden="true">${html}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

export function showInspectPoint(lat, lng, popupContent) {
  if (inspectMarker) inspectMarker.remove();
  inspectMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: 'pin-icon', html: '<span class="pin pin-inspect" aria-hidden="true"></span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    keyboard: false,
    zIndexOffset: 500,
  }).addTo(map);
  if (popupContent) {
    inspectMarker.bindPopup(popupContent, { maxWidth: 280, closeButton: true }).openPopup();
  }
}

export function clearInspectPoint() {
  inspectMarker?.remove();
  inspectMarker = null;
}

/** Create the "you are here" marker, or move it if it already exists (no flicker, no duplicates). */
export function setUserLocation({ lat, lng, accuracy }) {
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'pin-icon', html: '<span class="pin pin-user" aria-hidden="true"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 800,
      keyboard: false,
    }).addTo(map);
  }
  userMarker.bindPopup(h('div', { class: 'popup' }, h('h3', { class: 'pop-title', text: 'Your current location' }), detailLine('Coordinates', formatCoords(lat, lng)), detailLine('Accuracy', accuracy ? `±${Math.round(accuracy)} m` : 'Unknown')));
  if (accuracy && accuracy < 3000) {
    if (userAccuracy) {
      userAccuracy.setLatLng([lat, lng]);
      userAccuracy.setRadius(accuracy);
    } else {
      userAccuracy = L.circle([lat, lng], { radius: accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    }
  } else if (userAccuracy) {
    userAccuracy.remove();
    userAccuracy = null;
  }
}

export function removeUserLocation() {
  userMarker?.remove();
  userAccuracy?.remove();
  userMarker = null;
  userAccuracy = null;
}

function endpointMarker(existing, latlng, cls, label, title) {
  existing?.remove();
  if (!latlng) return null;
  return L.marker([latlng.lat, latlng.lng], {
    icon: pinIcon(cls, label),
    title,
    alt: title,
    zIndexOffset: 700,
  })
    .bindPopup(h('div', { class: 'popup' }, h('h3', { class: 'pop-title', text: title }), h('p', { class: 'pop-note', text: latlng.label || formatCoords(latlng.lat, latlng.lng) })))
    .addTo(map);
}

export function setOriginMarker(place) {
  originMarker = endpointMarker(originMarker, place, 'pin-start', 'A', 'Start');
}

export function setDestinationMarker(place) {
  destMarker = endpointMarker(destMarker, place, 'pin-end', 'B', 'Destination');
}

// ---------------------------------------------------------------- routes -----
function buildSegmentPopup(route, seg, index) {
  const r = route.risk;
  return h(
    'div',
    { class: 'popup' },
    h('h3', { class: 'pop-title', text: `${route.name} · section ${index + 1}` }),
    h('div', { class: 'pop-badges' }, riskBadge(seg.level, RISK_META[seg.level].phrase)),
    detailLine(scoreLabel(isCalibrated(r?.calibrated)), seg.prob !== null && seg.prob !== undefined ? formatPercent(seg.prob) : 'Not available'),
    detailLine('Section length', formatDistance(seg.lengthM)),
    detailLine('Rainfall', seg.rainfallMm !== null && seg.rainfallMm !== undefined ? `${seg.rainfallMm} mm` : 'Not available'),
    detailLine('Historical hotspot', seg.hotspot?.name ? `${seg.hotspot.name}${seg.hotspot.incidentCount !== null ? ` · ${seg.hotspot.incidentCount} past incidents` : ''}` : 'None reported'),
    detailLine('Data type', dataStatusLabel(r?.dataStatus)),
    detailLine('Prediction time', formatDateTime(r?.timestamp) || 'Not available'),
    h('p', { class: 'pop-note', text: 'A model estimate for this section, not a confirmed flood report. Conditions can change quickly.' })
  );
}

/**
 * Draw all routes. In risk-colour mode each route is a group of separate polylines - one per
 * risk segment - so one route can be green, amber and red along its length. With the toggle
 * off, routes are drawn the way a normal navigation app does: selected = blue, others = grey.
 * The selected route gets a white halo and is drawn last (on top).
 */
export function renderRoutes(routes, selectedId, handlers = {}) {
  lastRoutes = { routes, selectedId, handlers };
  drawRoutes();
}

function drawRoutes() {
  if (!layers.route) return;
  layers.route.clearLayers();
  if (!lastRoutes) return;
  const { routes, selectedId, handlers } = lastRoutes;
  const riskMode = layerVisible.riskColors;
  const ordered = [...routes].sort((a, b) => (a.id === selectedId) - (b.id === selectedId));

  ordered.forEach((route) => {
    const selected = route.id === selectedId;
    const group = L.featureGroup().addTo(layers.route);
    const common = { pane: 'routePane', lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false };

    // white halo: separates the selected route from the map without hiding roads
    if (selected) L.polyline(route.latlngs, { ...common, color: '#ffffff', weight: 11, opacity: 0.95, interactive: false }).addTo(group);

    const assessed = route.risk?.available && route.risk.segments.length > 0;
    let segments;
    if (riskMode) {
      segments = assessed ? route.risk.segments : [{ latlngs: route.latlngs, level: 'unknown', prob: null, lengthM: route.distance_m, placeholder: true }];
    } else {
      segments = [{ latlngs: route.latlngs, level: null, plain: true }];
    }

    segments.forEach((seg, i) => {
      const color = seg.plain ? (selected ? ROUTE_BLUE : ALT_GREY) : riskColor(seg.level);
      const line = L.polyline(seg.latlngs, {
        ...common,
        color,
        weight: selected ? 7 : seg.plain ? 5 : 4,
        opacity: selected || seg.plain ? 1 : 0.6,
        dashArray: !seg.plain && seg.level === 'unknown' ? '8 8' : null,
      }).addTo(group);

      const tip = seg.plain
        ? `${route.name}: ${formatDuration(route.duration_s)}, ${formatDistance(route.distance_m)}`
        : seg.placeholder
          ? `${route.name}: ${route.risk?.available ? 'segment-level risk not provided' : 'risk assessment unavailable'}`
          : `${route.name}: ${RISK_META[seg.level].label} risk${seg.prob !== null ? ` (${formatPercent(seg.prob)})` : ''}`;
      line.bindTooltip(tip, { sticky: true, direction: 'top' });
      line.on('mouseover', () => selected && line.setStyle({ weight: 9 }));
      line.on('mouseout', () => selected && line.setStyle({ weight: 7 }));

      if (selected && !seg.plain && !seg.placeholder) line.bindPopup(() => buildSegmentPopup(route, seg, i), { maxWidth: 290 });
      else line.on('click', () => !selected && handlers.onSelect?.(route.id));
    });

    // Duration bubble (like a navigation app), placed at a different spot on each route
    const pos = route.latlngs[Math.floor(route.latlngs.length * (0.4 + 0.1 * (route.letter.charCodeAt(0) - 65)))] || route.latlngs[0];
    L.marker(pos, {
      icon: L.divIcon({
        className: 'route-label-icon',
        html: `<span class="route-label ${selected ? 'is-selected' : ''}">${route.letter} · ${formatDuration(route.duration_s)}</span>`,
        iconSize: [86, 24],
        iconAnchor: [43, 12],
      }),
      keyboard: false,
      zIndexOffset: selected ? 600 : 300,
    })
      .on('click', () => handlers.onSelect?.(route.id))
      .addTo(group);
  });
}

export function clearRoutes() {
  lastRoutes = null;
  layers.route.clearLayers();
}

export function fitToRoutes(routes, selectedOnly = null) {
  const pts = (selectedOnly ? routes.filter((r) => r.id === selectedOnly) : routes).flatMap((r) => r.latlngs);
  if (!pts.length) return;
  map.fitBounds(L.latLngBounds(pts), { ...fitPadding(), maxZoom: 15 });
}

export function fitToPoints(points) {
  if (points.length === 1) return flyTo(points[0].lat, points[0].lng, 14);
  map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { ...fitPadding(), maxZoom: 15 });
}

// -------------------------------------------------------- report markers -----
export function showReportMarkers(reports, onShow) {
  layers.reports.clearLayers();
  reports
    .filter((r) => r.latitude !== null && r.longitude !== null)
    .forEach((r) => {
      const marker = L.marker([r.latitude, r.longitude], {
        icon: L.divIcon({ className: 'pin-icon', html: `<span class="report-pin sev-${r.severity}" aria-hidden="true"></span>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
        title: r.location,
        alt: `Report: ${r.location}`,
      });
      marker.bindPopup(() => onShow(r), { maxWidth: 280 });
      marker.addTo(layers.reports);
    });
}

export function clearReportMarkers() {
  layers.reports?.clearLayers();
}

export function openReportMarker(report) {
  flyTo(report.latitude, report.longitude, 15);
  const marker = layers.reports.getLayers().find((m) => m.getLatLng().equals([report.latitude, report.longitude]));
  if (marker) setTimeout(() => marker.openPopup(), 900);
}

export function getBounds() {
  const b = map.getBounds();
  return { min_lat: b.getSouth(), min_lng: b.getWest(), max_lat: b.getNorth(), max_lng: b.getEast() };
}
