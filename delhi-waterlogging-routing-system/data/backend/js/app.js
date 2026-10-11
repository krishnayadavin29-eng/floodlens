/**
 * app.js - starts the app and wires the shared UI together:
 * navigation, mobile sheet/drawer, header buttons, layer toggles, map clicks, API status.
 * Feature logic lives in the other modules (routePlanner.js, location.js, ...).
 */
import { CONFIG } from './config.js';
import { state, on, emit, cancelPick, loadPrefs, savePrefs } from './state.js';
import { $, $$, h, refreshIcons, toast } from './ui.js';
import { applyRiskColorsToCss } from './utils.js';
import { getHealthStatus } from './api.js';
import {
  initMap, onMapClick, resetView, setLayerVisible, isLayerVisible, invalidateSize, flyTo, LAYER_NAMES,
  getBaseStyles, setBaseStyle, getBaseStyle, zoomIn, zoomOut, fitToRoutes,
} from './map.js';
import { locateAndShow } from './geolocation.js';
import { createAutocomplete } from './autocomplete.js';
import { initRoutePlanner, getSelectedRoute, currentRoutes } from './routePlanner.js';
import { initJourney, isJourneyActive } from './journey.js';
import { initLocationPanel, inspectFromMap, inspectPlace } from './location.js';
import { initReports, setIncidentsViewOpen } from './reports.js';
import { initDashboard, refreshDashboard } from './dashboard.js';

const VIEWS = ['dashboard', 'route', 'map', 'location', 'report', 'incidents', 'about'];
const mobileQuery = window.matchMedia('(max-width: 900px)');

// ============================================================ navigation =====
function navigate(view, { updateHash = true } = {}) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  if (isJourneyActive() && view !== 'route') {
    toast('End the journey first to leave navigation.', 'info', 3000);
    if (location.hash !== '#route') history.replaceState(null, '', '#route');
    return;
  }
  cancelPick();
  state.view = view;

  $$('.view').forEach((section) => (section.hidden = section.dataset.view !== view));
  $$('#mainNav a').forEach((a) => {
    const active = a.dataset.view === view;
    a.classList.toggle('is-active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  setIncidentsViewOpen(view === 'incidents');
  document.body.classList.remove('nav-open');
  $('#navToggle').setAttribute('aria-expanded', 'false');
  setSheet(false);
  requestAnimationFrame(invalidateSize); // map may have been resized by the view change

  $('#panelScroll').scrollTop = 0;
  const heading = $(`.view[data-view="${view}"] .view-title`);
  heading?.focus({ preventScroll: true });
  document.title = `${heading?.textContent || 'Delhi JalAlert'} · Delhi JalAlert`;
}

function initNavigation() {
  $$('#mainNav a').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(a.dataset.view);
    })
  );
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1), { updateHash: false }));
  on('navigate', ({ view }) => navigate(view));

  $$('[data-goto]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.goto)));

  $('#navToggle').addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    $('#navToggle').setAttribute('aria-expanded', String(open));
  });
  $('#navBackdrop').addEventListener('click', () => {
    document.body.classList.remove('nav-open');
    $('#navToggle').setAttribute('aria-expanded', 'false');
  });
}

// ========================================================= mobile sheet =====
function setSheet(collapsed) {
  const panel = $('#panel');
  if (!mobileQuery.matches) {
    panel.classList.remove('is-collapsed');
    return;
  }
  panel.classList.toggle('is-collapsed', collapsed);
  $('#sheetHandle').setAttribute('aria-expanded', String(!collapsed));
  setTimeout(invalidateSize, 320);
}

function initSheet() {
  $('#sheetHandle').addEventListener('click', () => setSheet(!$('#panel').classList.contains('is-collapsed')));
  on('sheet-collapse', () => setSheet(true));
  on('pick-start', () => setSheet(true));
  on('picked', () => setSheet(false));
  mobileQuery.addEventListener('change', () => { setSheet(false); invalidateSize(); });
}

// ============================================================ map & layers =====
function syncLayerToggles() {
  $$('input[data-layer]').forEach((input) => (input.checked = isLayerVisible(input.dataset.layer)));
}

function initLayerControls() {
  document.addEventListener('change', (e) => {
    const input = e.target.closest?.('input[data-layer]');
    if (!input) return;
    setLayerVisible(input.dataset.layer, input.checked);
    syncLayerToggles();
    savePrefs({ layers: Object.fromEntries(LAYER_NAMES.map((n) => [n, isLayerVisible(n)])) });
  });

  const btn = $('#layersBtn');
  const menu = $('#layerMenu');
  const closeMenu = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { closeMenu(); btn.focus(); } });

  $('#resetViewBtn').addEventListener('click', resetView);
  $('#mapLocateBtn').addEventListener('click', locateAndShow);
  $('#headerLocateBtn').addEventListener('click', locateAndShow);
  $('#zoomInBtn').addEventListener('click', zoomIn);
  $('#zoomOutBtn').addEventListener('click', zoomOut);
  $('#recenterBtn').addEventListener('click', recenterMap);
  buildBasemapLists();
  initFullscreen();
  initPanelTab();
  syncLayerToggles();
}

/** Recenter: fit the selected route if there is one, otherwise go to the user's location, otherwise Delhi. */
function recenterMap() {
  const selected = getSelectedRoute();
  if (selected) fitToRoutes(currentRoutes(), selected.id);
  else if (state.userLocation) flyTo(state.userLocation.lat, state.userLocation.lng, 15);
  else resetView();
}

/** Radio lists for the base-map style (one in the map menu, one in the Risk Map view), kept in sync. */
function buildBasemapLists() {
  const lists = $$('[data-basemap-list]');
  const styles = getBaseStyles();
  lists.forEach((list, li) => {
    styles.forEach((st) => {
      const input = h('input', { type: 'radio', name: `basemap-${li}`, value: st.id, checked: st.id === getBaseStyle() });
      input.addEventListener('change', () => {
        setBaseStyle(st.id);
        savePrefs({ baseStyle: st.id });
        $$('[data-basemap-list] input').forEach((r) => (r.checked = r.value === st.id));
      });
      list.append(h('label', { class: 'check' }, input, h('span', { text: st.label })));
    });
  });
}

function initFullscreen() {
  const btn = $('#fullscreenBtn');
  const wrap = $('.map-wrap');
  if (!document.fullscreenEnabled) {
    btn.hidden = true; // not supported (e.g. some iOS browsers)
    return;
  }
  btn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen().catch(() => toast('Full screen is not available in this browser.', 'warning'));
  });
  document.addEventListener('fullscreenchange', () => {
    const on = Boolean(document.fullscreenElement);
    btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    btn.title = on ? 'Exit full screen' : 'Full screen';
    btn.replaceChildren(h('i', { 'data-lucide': on ? 'minimize' : 'maximize', class: 'icon', 'aria-hidden': 'true' }));
    refreshIcons();
    setTimeout(invalidateSize, 150);
  });
}

/** Desktop: collapse the side panel so the map uses the full width. */
function initPanelTab() {
  const tab = $('#panelTab');
  tab.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('panel-collapsed');
    tab.setAttribute('aria-expanded', String(!collapsed));
    tab.setAttribute('aria-label', collapsed ? 'Expand side panel' : 'Collapse side panel');
    tab.title = collapsed ? 'Expand side panel' : 'Collapse side panel';
    tab.replaceChildren(h('i', { 'data-lucide': collapsed ? 'chevron-right' : 'chevron-left', class: 'icon', 'aria-hidden': 'true' }));
    refreshIcons();
    setTimeout(invalidateSize, 260);
  });
  // Opening a view from the rail re-opens the panel
  $$('#mainNav a').forEach((a) => a.addEventListener('click', () => {
    if (document.body.classList.contains('panel-collapsed')) tab.click();
  }));
  on('journey', ({ active }) => {
    if (active) document.body.classList.add('panel-collapsed-nav');
    else document.body.classList.remove('panel-collapsed-nav');
    setTimeout(invalidateSize, 260);
  });
}

function initMapClicks() {
  onMapClick((latlng) => {
    if (state.pick) {
      const target = state.pick;
      cancelPick();
      emit('picked', { target, latlng });
      return;
    }
    inspectFromMap(latlng);
  });
  $('#pickCancel').addEventListener('click', cancelPick);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && cancelPick());
}

// ================================================================ search =====
function initSearch() {
  const dialog = $('#searchDialog');
  const input = $('#searchInput');
  const ac = createAutocomplete({
    input,
    list: $('#searchList'),
    onSelect: (place) => {
      dialog.close();
      flyTo(place.lat, place.lng, 15);
      inspectPlace(place);
      emit('sheet-collapse');
    },
  });
  $('#headerSearchBtn').addEventListener('click', () => {
    ac.clear();
    dialog.showModal();
    input.focus();
  });
  $('#searchClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
}

// ======================================================== data status pill =====

const PILL = {
  checking: {
    text: 'Checking API…',
    title: 'Checking the backend',
  },
  online: {
    text: 'API Online · Demo Risk',
    title: 'Backend is reachable and the model is loaded, but live-coordinate risk prediction and route-risk assessment are not ready.',
  },
  offline: {
    text: 'Backend Disconnected',
    title: 'Backend health check failed. Click to retry.',
  },
};


function setStatusPill(kind) {
  state.backend = kind === 'checking' ? 'unknown' : kind;
  const pill = $('#statusPill');
  pill.className = `status-pill status-${kind}`;
  $('#statusText').textContent = PILL[kind].text;
  pill.title = PILL[kind].title;
  emit('backend-status', kind);
}

async function checkBackend({ announce = false } = {}) {
  setStatusPill('checking');
  try {
    await getHealthStatus();
    setStatusPill('online');
    if (announce) toast('Backend is reachable. Demo data mode is unchanged.', 'success');
  } catch (err) {
    setStatusPill('offline');
    // In demo mode, a disconnected backend does not affect mock risk or route behavior.
    if (announce || !CONFIG.DEMO_MODE) {
      toast(`${err.message} ${CONFIG.DEMO_MODE ? 'Demo features remain available.' : 'Backend features will show an error until it is running.'}`, 'warning', 8000);
    }
  }
}

function initModeBanners() {
  const text = CONFIG.DEMO_MODE
    ? 'Demo mode: risk scores, hotspots and reports are illustrative sample data, not real predictions or real-time government data.'
    : `Backend mode: connected to ${CONFIG.API_BASE_URL}. The saved model can score supplied feature rows, but live coordinate predictions and route-risk assessment are not available until geographic feature generation is validated. Routes may be shown with unknown risk.`;
  $$('[data-mode-banner]').forEach((el) => {
    el.classList.add(CONFIG.DEMO_MODE ? 'banner-warn' : 'banner-info');
    el.replaceChildren(h('i', { 'data-lucide': CONFIG.DEMO_MODE ? 'flask-conical' : 'activity', class: 'icon', 'aria-hidden': 'true' }), h('p', { text }));
  });
  $('#aboutMode').textContent = CONFIG.DEMO_MODE ? 'Demo mode (sample data)' : `Live mode (${CONFIG.API_BASE_URL})`;
}

// Unexpected errors should be visible, not silent.
window.addEventListener('error', (e) => console.error(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast('Something went wrong. Check the browser console for details.', 'error');
});

// ================================================================ start =====
function start() {
  applyRiskColorsToCss();
  if (typeof window.L === 'undefined') {
    const msg = $('#mapMessage');
    $('#mapLoading').hidden = true;
    msg.hidden = false;
    msg.textContent = 'The map library (Leaflet) could not be loaded. Check your internet connection and reload.';
    return;
  }
  const prefs = loadPrefs();
  // Older versions defaulted to a CARTO composite style that may show API-key
  // placeholders in some environments. Prefer the key-free OSM base map unless
  // the user explicitly saved a known non-CARTO style.
  const savedBaseStyle = ['osm', 'satellite', 'maptiler'].includes(prefs.baseStyle)
    ? prefs.baseStyle
    : CONFIG.MAP.defaultStyle;
  initMap('map', prefs.layers || {}, savedBaseStyle);
  initModeBanners();
  initNavigation();
  initSheet();
  initLayerControls();
  initMapClicks();
  initSearch();

  initRoutePlanner();
  initJourney();
  initLocationPanel();
  initReports();
  initDashboard();

  $('#statusPill').addEventListener('click', () => checkBackend({ announce: true }));

  navigate(location.hash.slice(1) || 'dashboard', { updateHash: false });
  refreshIcons();
  checkBackend();
  refreshDashboard();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
