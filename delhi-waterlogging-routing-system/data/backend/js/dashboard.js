/**
 * dashboard.js - summary cards, weather panel, system status, charts,
 * and the hotspot list used by the "Risk Map" view.
 *
 * Numbers shown here come from api.js (backend or clearly-labelled demo data).
 * "Locations assessed" is NOT "locations flooded" and the UI says so.
 */
import { CONFIG } from './config.js';
import { state, on, emit } from './state.js';
import { $, h, icon, refreshIcons, clearNode, skeleton, errorState, riskBadge, chip } from './ui.js';
import { getHotspots, getRecentReports, getWeather, ApiError } from './api.js';
import { renderHotspots, markHotspotLayersUnavailable, setLayerStatus, openHotspot } from './map.js';
import { RISK_META, formatDateTime, formatPercent, timeAgo, dataStatusLabel } from './utils.js';

const DELHI = { latitude: 28.6139, longitude: 77.209 };
let weather = { status: 'idle', data: null, error: null };
let charts = {};
let allReports = [];
let reportsStatus = 'idle';

// ================================================================ load =====
export async function refreshDashboard() {
  const btn = $('#dashRefresh');
  btn?.setAttribute('aria-busy', 'true');
  btn && (btn.disabled = true);
  await Promise.allSettled([loadHotspots(), loadReports(), loadWeather()]);
  state.lastRefresh = new Date();
  renderAll();
  btn?.removeAttribute('aria-busy');
  btn && (btn.disabled = false);
}

async function loadHotspots() {
  state.hotspotsStatus = 'loading';
  setLayerStatus('risk', 'loading');
  setLayerStatus('hotspots', 'loading');
  renderCards();
  try {
    const [[south, west], [north, east]] = CONFIG.MAP.ncrBounds;
    state.hotspots = await getHotspots({ min_lat: south, min_lng: west, max_lat: north, max_lng: east });
    state.hotspotsStatus = 'ready';
    renderHotspots(state.hotspots);
  } catch (err) {
    state.hotspots = [];
    state.hotspotsStatus = 'unavailable';
    state.hotspotsError = err instanceof ApiError && err.kind === 'unavailable' ? 'The backend does not provide hotspot data yet (GET /hotspots was not found).' : err.message;
    markHotspotLayersUnavailable('Data unavailable');
  }
}

async function loadReports() {
  reportsStatus = 'loading';
  try {
    allReports = await getRecentReports({});
    reportsStatus = 'ready';
  } catch {
    allReports = [];
    reportsStatus = 'unavailable';
  }
}

async function loadWeather() {
  weather = { status: 'loading', data: null, error: null };
  renderWeather();
  try {
    weather = { status: 'ready', data: await getWeather(DELHI), error: null };
  } catch (err) {
    weather = { status: err.kind === 'unconfigured' ? 'unconfigured' : 'error', data: null, error: err.message };
  }
}

// ============================================================== render =====
export function initDashboard() {
  $('#dashRefresh').addEventListener('click', refreshDashboard);
  on('backend-status', renderStatus);
  renderAll();
}

function renderAll() {
  renderCards();
  renderWeather();
  renderStatus();
  renderCharts();
  renderHotspotList();
  refreshIcons();
}

function statCard({ label, value, note, tone = '' }) {
  return h('div', { class: `stat-card ${tone}` },
    h('span', { class: 'stat-label', text: label }),
    h('span', { class: 'stat-value', text: value }),
    h('span', { class: 'stat-note', text: note })
  );
}

function renderCards() {
  const wrap = $('#dashCards');
  clearNode(wrap);
  const ready = state.hotspotsStatus === 'ready';
  const loading = state.hotspotsStatus === 'loading' || state.hotspotsStatus === 'idle';
  const count = (lv) => state.hotspots.filter((x) => x.level === lv).length;
  const val = (n) => (ready ? String(n) : loading ? '…' : '—');
  const unavailableNote = loading ? 'Loading…' : 'Unavailable';

  const recent = allReports.filter((r) => r.status !== 'historical');
  const w = weather.data;
  const rain = w?.forecast?.totalMm;

  wrap.append(
    statCard({ label: 'Locations assessed', value: val(state.hotspots.length), note: ready ? 'Assessed ≠ flooded' : unavailableNote }),
    statCard({ label: 'High-risk locations', value: val(count('high')), note: ready ? 'Model-estimated' : unavailableNote, tone: 'tone-high' }),
    statCard({ label: 'Moderate-risk locations', value: val(count('moderate')), note: ready ? 'Model-estimated' : unavailableNote, tone: 'tone-moderate' }),
    statCard({
      label: 'Recent reported incidents',
      value: reportsStatus === 'ready' ? String(recent.length) : reportsStatus === 'loading' ? '…' : '—',
      note: reportsStatus === 'ready' ? 'Not all verified; excludes historical' : 'Unavailable',
    }),
    statCard({
      label: `Rainfall, next ${CONFIG.WEATHER.forecastHours} h`,
      value: typeof rain === 'number' ? `${rain.toFixed(1)} mm` : weather.status === 'loading' ? '…' : '—',
      note: typeof rain === 'number' ? 'Forecast, not observed' : weather.status === 'unconfigured' ? 'Weather not connected' : 'Unavailable',
    })
  );

  $('#dashDemoBadge').hidden = !CONFIG.DEMO_MODE;
}

function weatherRow(label, value, tag) {
  return h('div', { class: 'wx-row' }, h('span', { class: 'wx-label', text: label }), h('span', { class: 'wx-value' }, value, tag ? chip(tag, 'chip-type') : null));
}

function renderWeather() {
  const box = $('#weatherBody');
  clearNode(box);

  if (weather.status === 'idle' || weather.status === 'loading') {
    box.append(skeleton(3));
    return;
  }
  if (weather.status === 'unconfigured') {
    box.append(h('div', { class: 'banner banner-info' }, icon('info'), h('p', { text: 'Weather data is not connected. In js/config.js set WEATHER.provider to "open-meteo" (free, no key) or "backend".' })));
    refreshIcons();
    return;
  }
  if (weather.status === 'error') {
    box.append(errorState(`Weather unavailable. ${weather.error}`, async () => { await loadWeather(); renderAll(); }, 'Retry'));
    refreshIcons();
    return;
  }

  const w = weather.data;
  const f = w.forecast;
  box.append(
    h('div', { class: 'wx-main' },
      h('span', { class: 'wx-temp', text: w.temperatureC !== null ? `${Math.round(w.temperatureC)}°C` : '—' }),
      h('span', { class: 'wx-desc', text: w.description || 'Conditions not reported' })
    ),
    weatherRow('Current precipitation', w.precipitationMm !== null ? `${w.precipitationMm} mm` : 'Not available', 'Model-based now'),
    f
      ? weatherRow(`Next ${f.hours ?? CONFIG.WEATHER.forecastHours} hours`, `${f.totalMm !== null ? `${f.totalMm.toFixed(1)} mm` : '—'}${f.maxProbability !== null ? ` · up to ${formatPercent(f.maxProbability)} chance` : ''}`, 'Forecast')
      : weatherRow('Forecast', 'Not available'),
    h('p', { class: 'hint', text: `Source: ${w.source}${w.basis ? ` (${w.basis})` : ''} · ${w.observedAt ? `data time ${formatDateTime(w.observedAt)}` : 'data time not provided'}.` })
  );
}

function renderStatus() {
  const box = $('#statusBody');
  if (!box) return;
  clearNode(box);
  const backendText = CONFIG.DEMO_MODE
    ? 'Not used (demo mode)'
    : { online: 'Connected', offline: 'Not reachable', unknown: 'Checking…' }[state.backend] || 'Unknown';
  const tone = CONFIG.DEMO_MODE ? 'warn' : state.backend === 'online' ? 'ok' : state.backend === 'offline' ? 'bad' : 'warn';

  const row = (label, value, cls = '') => h('div', { class: 'detail-row' }, h('dt', { text: label }), h('dd', { class: cls, text: value }));
  box.append(
    h('dl', { class: 'detail-list compact' },
      row('Data mode', CONFIG.DEMO_MODE ? 'Demo (illustrative sample data)' : 'Live backend'),
      row('Backend', backendText, `tone-${tone}`),
      row('Hotspot data', { ready: `${state.hotspots.length} locations loaded`, loading: 'Loading…', unavailable: 'Unavailable', idle: 'Not loaded' }[state.hotspotsStatus]),
      row('Weather', { ready: `${weather.data?.source || 'Connected'}`, loading: 'Loading…', unconfigured: 'Not connected', error: 'Unavailable', idle: 'Not loaded' }[weather.status]),
      row('Last refresh', state.lastRefresh ? `${timeAgo(state.lastRefresh)} (${state.lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})` : 'Not yet')
    )
  );
}

// ============================================================== charts =====
function destroyChart(key) {
  charts[key]?.destroy();
  delete charts[key];
}

function chartBlock(canvasId, emptyId, hasData, emptyText) {
  $(`#${canvasId}`).parentElement.hidden = !hasData;
  const empty = $(`#${emptyId}`);
  empty.hidden = hasData;
  if (!hasData) empty.textContent = emptyText;
}

function renderCharts() {
  const demoLabel = CONFIG.DEMO_MODE ? ' (sample data)' : '';
  $('#chartRiskTitle').textContent = `Risk across assessed locations${demoLabel}`;
  $('#chartMonthTitle').textContent = `Reports by month${demoLabel}`;

  if (!window.Chart) {
    ['chartRiskEmpty', 'chartMonthEmpty'].forEach((id) => {
      $(`#${id}`).hidden = false;
      $(`#${id}`).textContent = 'The chart library could not be loaded. Check your internet connection.';
    });
    return;
  }

  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.color = '#475569';

  // ---- Risk distribution
  destroyChart('risk');
  const levels = ['low', 'moderate', 'high', 'unknown'];
  const counts = levels.map((lv) => state.hotspots.filter((x) => x.level === lv).length);
  const hasRisk = counts.some((c) => c > 0);
  chartBlock('chartRisk', 'chartRiskEmpty', hasRisk, state.hotspotsStatus === 'loading' ? 'Loading…' : 'No assessed locations to chart.');
  if (hasRisk) {
    charts.risk = new Chart($('#chartRisk'), {
      type: 'doughnut',
      data: {
        labels: levels.map((lv) => RISK_META[lv].label),
        datasets: [{ data: counts, backgroundColor: levels.map((lv) => RISK_META[lv].color), borderColor: '#fff', borderWidth: 2 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 12, usePointStyle: true } },
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.parsed} location${c.parsed === 1 ? '' : 's'}` } },
        },
      },
    });
  }

  // ---- Reports by month (stacked by status)
  destroyChart('month');
  const monthKey = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7) : null);
  const months = [...new Set(allReports.map((r) => monthKey(r.observedAt)).filter(Boolean))].sort();
  const hasMonths = months.length > 0;
  chartBlock('chartMonth', 'chartMonthEmpty', hasMonths, reportsStatus === 'loading' ? 'Loading…' : 'No report data available to chart.');
  if (hasMonths) {
    const label = (k) => new Date(`${k}-15`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
    const series = [
      { key: 'verified', name: 'Verified', color: '#0b2545' },
      { key: 'unverified', name: 'Unverified', color: '#60a5fa' },
      { key: 'historical', name: 'Historical record', color: '#9ca3af' },
    ];
    charts.month = new Chart($('#chartMonth'), {
      type: 'bar',
      data: {
        labels: months.map(label),
        datasets: series.map((s) => ({
          label: s.name,
          backgroundColor: s.color,
          data: months.map((m) => allReports.filter((r) => r.status === s.key && monthKey(r.observedAt) === m).length),
          borderRadius: 3,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Reports' } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } } },
      },
    });
  }
}

// ======================================================== hotspot list =====
function renderHotspotList() {
  const list = $('#hotspotList');
  if (!list) return;
  clearNode(list);
  $('#hotspotCount').textContent = state.hotspotsStatus === 'ready' ? `(${state.hotspots.length})` : '';

  if (state.hotspotsStatus === 'unavailable') {
    list.append(errorState(state.hotspotsError || 'Hotspot data is unavailable.', async () => { await loadHotspots(); renderAll(); }, 'Retry'));
    return;
  }
  if (state.hotspotsStatus !== 'ready') {
    list.append(skeleton(3));
    return;
  }
  const order = { high: 0, moderate: 1, low: 2, unknown: 3 };
  [...state.hotspots].sort((a, b) => order[a.level] - order[b.level] || (b.probability ?? -1) - (a.probability ?? -1)).forEach((hs) => {
    list.append(
      h('li', {},
        h('button', { class: 'hotspot-item', type: 'button', onClick: () => { openHotspot(hs); emit('sheet-collapse'); } },
          h('span', { class: 'hs-main' }, h('span', { class: 'hs-name', text: hs.name }), h('span', { class: 'hs-sub', text: `${dataStatusLabel(hs.dataStatus)}${hs.incidentCount !== null ? ` · ${hs.incidentCount} historical incidents` : ''}` })),
          riskBadge(hs.level)
        )
      )
    );
  });
}
