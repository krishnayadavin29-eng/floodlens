/**
 * location.js - "Location Risk Details" panel and the popup shown when the user clicks the map.
 *
 * The panel keeps four kinds of information visibly separate:
 *   - Model-predicted risk
 *   - Historical incidents
 *   - Confirmed current reports
 *   - Unknown / not provided data
 * Missing values are displayed as "Not available" - they are never guessed.
 */
import { state, emit } from './state.js';
import { $, h, icon, refreshIcons, clearNode, skeleton, errorState, riskBadge, detailRow, chip, emptyState } from './ui.js';
import { predictLocationRisk, ApiError } from './api.js';
import { reverseGeocode } from './geocoding.js';
import { showInspectPoint, clearInspectPoint } from './map.js';
import { setPoint } from './routePlanner.js';
import {
  RISK_META, formatCoords, formatPercent, formatDateTime, formatDistance, dataStatusLabel, scoreLabel, isCalibrated, isInsideNcr,
} from './utils.js';

const loc = { point: null, name: null, status: 'empty', result: null, error: null, token: 0 };

export function initLocationPanel() {
  render();
}

// ------------------------------------------------------------ map popup -----
function popupActions(lat, lng) {
  const go = (fn) => () => { fn(); };
  return h('div', { class: 'popup' },
    h('h3', { class: 'pop-title', text: 'Selected point' }),
    h('p', { class: 'pop-coords', text: formatCoords(lat, lng) }),
    h('div', { class: 'pop-actions' },
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onClick: go(() => checkRiskHere(true)) }, icon('droplets'), 'Check risk here'),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: go(() => { setPoint('origin', { lat, lng }); emit('navigate', { view: 'route' }); }) }, icon('navigation'), 'Start here'),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: go(() => { setPoint('destination', { lat, lng }); emit('navigate', { view: 'route' }); }) }, icon('flag'), 'Go here'),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: go(() => { emit('report-location', { lat, lng }); emit('navigate', { view: 'report' }); }) }, icon('camera'), 'Report here')
    )
  );
}

/** Called when the user clicks the map (and no "pick" mode is active). */
export function inspectFromMap({ lat, lng }) {
  selectPoint(lat, lng);
  showInspectPoint(lat, lng, popupActions(lat, lng));
}

/** Called when a point is chosen from search, so the same panel/popup flow applies. */
export function inspectPlace({ lat, lng, label }) {
  selectPoint(lat, lng, label);
  showInspectPoint(lat, lng, popupActions(lat, lng));
}

function selectPoint(lat, lng, name = null) {
  loc.token += 1;
  loc.point = { lat, lng };
  loc.name = name;
  loc.status = 'idle';
  loc.result = null;
  loc.error = null;
  state.selectedPoint = loc.point;
  render();
  if (!name) {
    const token = loc.token;
    reverseGeocode(lat, lng).then((n) => {
      if (token === loc.token && n) {
        loc.name = n;
        render();
      }
    });
  }
}

// ---------------------------------------------------------------- check -----
export async function checkRiskHere(openPanel = false) {
  if (!loc.point) return;
  if (openPanel) emit('navigate', { view: 'location' });
  const token = ++loc.token;
  loc.status = 'loading';
  render();
  try {
    const result = await predictLocationRisk({ latitude: loc.point.lat, longitude: loc.point.lng });
    if (token !== loc.token) return;
    loc.result = result;
    loc.status = 'done';
  } catch (err) {
    if (token !== loc.token) return;
    loc.status = 'error';
    loc.error = err instanceof ApiError && err.kind === 'unavailable'
      ? 'The backend does not provide location predictions yet (POST /predict was not found).'
      : err.message || 'The prediction could not be completed.';
  }
  render();
}

// --------------------------------------------------------------- render -----
function section(title, tag, ...rows) {
  return h('section', { class: 'loc-section' },
    h('div', { class: 'loc-section-head' }, h('h3', { text: title }), tag ? chip(tag, 'chip-type') : null),
    h('dl', { class: 'detail-list' }, rows)
  );
}

const mm = (v) => (v === null || v === undefined ? null : `${v} mm`);

function render() {
  const root = $('#locationBody');
  clearNode(root);

  if (!loc.point) {
    root.append(
      emptyState('No point selected', 'Click anywhere on the map, or search for a place, then choose “Check risk here”.'),
      h('button', { class: 'btn', type: 'button', onClick: () => emit('navigate', { view: 'map' }) }, icon('map'), 'Open risk map')
    );
    refreshIcons();
    return;
  }

  const { lat, lng } = loc.point;
  root.append(
    h('div', { class: 'loc-head' },
      h('h2', { class: 'loc-name', text: loc.name || 'Selected point' }),
      h('p', { class: 'loc-coords', text: `${formatCoords(lat, lng)}${isInsideNcr(lat, lng) ? '' : ' · outside Delhi-NCR'}` })
    )
  );

  const check = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => checkRiskHere(false) },
    icon(loc.status === 'done' ? 'refresh-cw' : 'droplets'), loc.status === 'done' ? 'Check again' : 'Check risk here');

  if (loc.status === 'idle') {
    root.append(
      h('p', { class: 'hint', text: 'The risk for this point has not been requested yet.' }),
      check
    );
  }

  if (loc.status === 'loading') {
    root.append(h('div', { class: 'status-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking waterlogging risk…'), skeleton(4), skeleton(3));
  }

  if (loc.status === 'error') {
    root.append(errorState(loc.error, () => checkRiskHere(false), 'Retry'));
  }

  if (loc.status === 'done') {
    const r = loc.result;
    const calibrated = isCalibrated(r.calibrated);
    root.append(
      section('Model-predicted risk', 'Model prediction',
        detailRow('Risk level', riskBadge(r.level, RISK_META[r.level].phrase)),
        detailRow(scoreLabel(calibrated), r.probability !== null ? formatPercent(r.probability) : null),
        detailRow('Predicted at', formatDateTime(r.timestamp)),
        detailRow('Data source & status', dataStatusLabel(r.dataStatus))
      ),
      section('Rainfall', 'Not provided unless shown',
        detailRow('Recent rainfall', mm(r.rainfall.recentMm)),
        detailRow('Last 1 hour', mm(r.rainfall.h1)),
        detailRow('Last 3 hours', mm(r.rainfall.h3)),
        detailRow('Last 24 hours', mm(r.rainfall.h24))
      ),
      section('Terrain & drainage', 'Not provided unless shown',
        detailRow('Elevation', r.terrain?.elevationM != null ? `${r.terrain.elevationM} m` : null),
        detailRow('Slope', r.terrain?.slopeDeg != null ? `${r.terrain.slopeDeg}°` : null),
        detailRow('Terrain note', r.terrain?.description),
        detailRow('Distance to nearest drain', r.drainDistanceM !== null ? formatDistance(r.drainDistanceM) : null)
      ),
      section('Historical incidents', 'Historical - not current',
        detailRow('Associated hotspot', r.hotspot?.name ? `${r.hotspot.name}${r.hotspot.incidentCount !== null ? ` · ${r.hotspot.incidentCount} past incidents` : ''}` : 'None reported by the data source')
      ),
      section('Confirmed current reports', 'Verified reports only',
        detailRow('Verified reports nearby', r.confirmedCurrentReports !== null ? String(r.confirmedCurrentReports) : 'No verified-report feed connected')
      ),
      h('p', { class: 'disclaimer', text: 'Risk is an estimate. It does not confirm that this location is flooded or dry right now, and conditions can change rapidly.' }),
      check
    );
    if (r.level === 'unknown') {
      root.insertBefore(h('div', { class: 'banner banner-warn' }, icon('alert-triangle'), h('p', { text: 'No prediction was returned for this point, so its risk is unknown (not low).' })), root.children[1]);
    }
  }

  root.append(
    h('div', { class: 'loc-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => { setPoint('origin', loc.point, loc.name || undefined); emit('navigate', { view: 'route' }); } }, icon('navigation'), 'Route from here'),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => { setPoint('destination', loc.point, loc.name || undefined); emit('navigate', { view: 'route' }); } }, icon('flag'), 'Route to here'),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => { emit('report-location', loc.point); emit('navigate', { view: 'report' }); } }, icon('camera'), 'Report here'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onClick: () => { loc.point = null; loc.status = 'empty'; clearInspectPoint(); render(); } }, icon('x'), 'Clear')
    )
  );
  refreshIcons();
}
