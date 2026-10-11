/**
 * reports.js - citizen report form + recent incidents list.
 *
 * Honesty rules:
 *  - A success message is shown ONLY when the backend confirms the report.
 *  - In demo mode nothing is sent, and the form says so.
 *  - Reports are user observations that may need verification, never "confirmed floods".
 */
import { CONFIG } from './config.js';
import { on, emit, startPick, cancelPick } from './state.js';
import { $, $$, h, icon, refreshIcons, clearNode, setLoading, toast, errorState, emptyState, skeleton, chip } from './ui.js';
import { requestUserLocation } from './geolocation.js';
import { submitWaterloggingReport, getRecentReports } from './api.js';
import { reverseGeocode } from './geocoding.js';
import { showInspectPoint, showReportMarkers, clearReportMarkers, openReportMarker, flyTo } from './map.js';
import { debounce, formatCoords, formatDate, formatDateTime, isInsideNcr } from './utils.js';

const form = { point: null, photo: null, previewUrl: null, submitting: false };
const SEVERITY_LABEL = { low: 'Low', moderate: 'Moderate', high: 'High', unknown: 'Unknown' };
const STATUS_LABEL = { verified: 'Verified', unverified: 'Unverified', historical: 'Historical record' };

// ================================================================ form =====
export function initReports() {
  initForm();
  initIncidents();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateTimeValue(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function initForm() {
  const when = $('#reportWhen');
  when.value = localDateTimeValue();
  when.max = localDateTimeValue();

  $('#reportPick').addEventListener('click', () => startPick('report', 'Click the map where you saw the waterlogging.'));
  $('#reportLocate').addEventListener('click', async () => {
    try {
      const loc = await requestUserLocation();
      setReportPoint({ lat: loc.lat, lng: loc.lng }, 'My current location');
    } catch (err) {
      fieldError('location', err.message);
    }
  });
  $('#reportClearLoc').addEventListener('click', () => setReportPoint(null));
  on('picked', ({ target, latlng }) => target === 'report' && setReportPoint(latlng));
  on('report-location', (latlng) => setReportPoint(latlng));

  const desc = $('#reportDesc');
  desc.maxLength = CONFIG.REPORTS.maxDescriptionLength;
  desc.addEventListener('input', () => {
    $('#descCount').textContent = `${desc.value.length} / ${CONFIG.REPORTS.maxDescriptionLength}`;
  });

  $('#reportPhoto').addEventListener('change', onPhotoChange);
  $('#photoRemove').addEventListener('click', removePhoto);
  $('#reportForm').addEventListener('submit', onSubmit);
  $('#reportForm').addEventListener('reset', () => setTimeout(resetForm, 0));
}

function fieldError(name, message) {
  const el = $(`#err-${name}`);
  if (el) el.textContent = message || '';
  const input = { location: $('#reportLocDisplay'), description: $('#reportDesc'), severity: $('#severityGroup'), when: $('#reportWhen'), photo: $('#reportPhoto') }[name];
  input?.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function setReportPoint(latlng, label) {
  form.point = latlng ? { lat: latlng.lat, lng: latlng.lng } : null;
  const display = $('#reportLocDisplay');
  display.value = latlng ? label || formatCoords(latlng.lat, latlng.lng) : '';
  fieldError('location', '');
  if (latlng) {
    showInspectPoint(latlng.lat, latlng.lng, null);
    if (!isInsideNcr(latlng.lat, latlng.lng)) fieldError('location', 'This point is outside Delhi-NCR. Reports are only useful for the Delhi area.');
    if (!label) {
      reverseGeocode(latlng.lat, latlng.lng).then((name) => {
        if (name && form.point && form.point.lat === latlng.lat && form.point.lng === latlng.lng) display.value = `${name} (${formatCoords(latlng.lat, latlng.lng)})`;
      });
    }
  }
}

function onPhotoChange(e) {
  const file = e.target.files[0];
  fieldError('photo', '');
  if (!file) return removePhoto();
  if (!CONFIG.REPORTS.allowedPhotoTypes.includes(file.type)) {
    e.target.value = '';
    fieldError('photo', 'Use a JPEG, PNG or WebP image.');
    return;
  }
  if (file.size > CONFIG.REPORTS.maxPhotoBytes) {
    e.target.value = '';
    fieldError('photo', `Photo is too large. Maximum size is ${Math.round(CONFIG.REPORTS.maxPhotoBytes / 1024 / 1024)} MB.`);
    return;
  }
  if (form.previewUrl) URL.revokeObjectURL(form.previewUrl);
  form.photo = file;
  form.previewUrl = URL.createObjectURL(file);
  $('#photoPreviewImg').src = form.previewUrl;
  $('#photoPreview').hidden = false;
}

function removePhoto() {
  if (form.previewUrl) URL.revokeObjectURL(form.previewUrl);
  form.photo = null;
  form.previewUrl = null;
  $('#reportPhoto').value = '';
  $('#photoPreviewImg').removeAttribute('src');
  $('#photoPreview').hidden = true;
  fieldError('photo', '');
}

function resetForm() {
  removePhoto();
  setReportPoint(null);
  ['location', 'description', 'severity', 'when', 'photo'].forEach((n) => fieldError(n, ''));
  $('#descCount').textContent = `0 / ${CONFIG.REPORTS.maxDescriptionLength}`;
  $('#reportWhen').value = localDateTimeValue();
  $('#reportWhen').max = localDateTimeValue();
  cancelPick();
}

function validate() {
  const errors = {};
  if (!form.point) errors.location = 'Choose a location on the map or use your current location.';
  const description = $('#reportDesc').value.trim();
  if (description.length < CONFIG.REPORTS.minDescriptionLength) errors.description = `Describe what you saw (at least ${CONFIG.REPORTS.minDescriptionLength} characters).`;
  if (!$('input[name="severity"]:checked')) errors.severity = 'Select how severe the waterlogging is.';
  const whenValue = $('#reportWhen').value;
  const when = whenValue ? new Date(whenValue) : null;
  if (!when || Number.isNaN(when.getTime())) errors.when = 'Enter when you saw it.';
  else if (when.getTime() > Date.now() + 60000) errors.when = 'The observation time cannot be in the future.';
  return { errors, description, when };
}

async function onSubmit(e) {
  e.preventDefault();
  if (form.submitting) return;
  ['location', 'description', 'severity', 'when'].forEach((n) => fieldError(n, ''));
  const { errors, description, when } = validate();
  const names = Object.keys(errors);
  names.forEach((n) => fieldError(n, errors[n]));
  const result = $('#reportResult');
  clearNode(result);

  if (names.length) {
    toast('Please fix the highlighted fields.', 'warning', 3500);
    const first = { location: '#reportPick', description: '#reportDesc', severity: 'input[name="severity"]', when: '#reportWhen' }[names[0]];
    $(first)?.focus();
    return;
  }

  form.submitting = true;
  const btn = $('#reportSubmit');
  setLoading(btn, true, 'Submitting…');
  try {
    const outcome = await submitWaterloggingReport({
      latitude: form.point.lat,
      longitude: form.point.lng,
      description,
      severity: $('input[name="severity"]:checked').value,
      observedAt: when.toISOString(),
      photo: form.photo,
    });
    if (outcome.submitted) {
      result.append(h('div', { class: 'banner banner-ok', role: 'status' }, icon('check-circle'), h('p', { text: `Report received${outcome.reportId ? ` (reference ${outcome.reportId})` : ''}. It is an unverified observation until it has been checked.` })));
      toast('Report received by the backend.', 'success');
      $('#reportForm').reset();
      refreshIncidents();
    } else if (outcome.demo) {
      result.append(h('div', { class: 'banner banner-info', role: 'status' }, icon('info'), h('p', { text: 'Demo mode: your report is valid, but it was NOT sent or saved anywhere. Connect the backend and set DEMO_MODE to false to submit real reports.' })));
    }
  } catch (err) {
    result.append(errorState(`The report was not submitted. ${err.message}`, () => $('#reportForm').requestSubmit(), 'Try again'));
    toast('Report not submitted.', 'error');
  } finally {
    form.submitting = false;
    setLoading(btn, false);
    refreshIcons();
  }
}

// ========================================================== incidents list =====
const filters = { q: '', severity: '', status: '', from: '', to: '' };
let incidentToken = 0;
let incidentsOpen = false;

function initIncidents() {
  const apply = () => {
    filters.q = $('#fSearch').value;
    filters.severity = $('#fSeverity').value;
    filters.status = $('#fStatus').value;
    filters.from = $('#fFrom').value;
    filters.to = $('#fTo').value;
    refreshIncidents();
  };
  const debounced = debounce(apply, 300);
  $('#fSearch').addEventListener('input', debounced);
  ['#fSeverity', '#fStatus', '#fFrom', '#fTo'].forEach((s) => $(s).addEventListener('change', apply));
  $('#fReset').addEventListener('click', () => {
    $('#incidentFilters').reset();
    apply();
  });
}

export function setIncidentsViewOpen(open) {
  incidentsOpen = open;
  if (open) refreshIncidents();
  else clearReportMarkers();
}

function reportPopup(r) {
  return h('div', { class: 'popup' },
    h('h3', { class: 'pop-title', text: r.location }),
    h('div', { class: 'pop-badges' }, chip(STATUS_LABEL[r.status], `status-${r.status}`), chip(`Severity: ${SEVERITY_LABEL[r.severity]}`, `sev-chip sev-${r.severity}`)),
    h('div', { class: 'pop-row' }, h('span', { class: 'pop-label', text: 'Observed' }), h('span', { class: 'pop-value', text: formatDateTime(r.observedAt) || 'Unknown' })),
    h('div', { class: 'pop-row' }, h('span', { class: 'pop-label', text: 'Source' }), h('span', { class: 'pop-value', text: r.source })),
    h('p', { class: 'pop-note', text: r.status === 'historical' ? 'Historical record, not a current condition.' : r.status === 'unverified' ? 'User observation. Not verified.' : 'Verified record.' })
  );
}

function reportCard(r) {
  const hasCoords = r.latitude !== null && r.longitude !== null;
  return h('article', { class: `incident-card status-${r.status}` },
    h('header', {},
      h('h3', { text: r.location }),
      h('div', { class: 'ic-badges' },
        chip(STATUS_LABEL[r.status], `status-${r.status}`),
        chip(`${SEVERITY_LABEL[r.severity]} severity`, `sev-chip sev-${r.severity}`)
      )
    ),
    r.description ? h('p', { class: 'ic-desc', text: r.description }) : null,
    h('p', { class: 'ic-meta' }, h('span', { text: formatDate(r.observedAt) }), ' · ', h('span', { text: r.source }), hasCoords ? [' · ', h('span', { text: formatCoords(r.latitude, r.longitude) })] : null),
    hasCoords
      ? h('button', { class: 'btn btn-sm', type: 'button', onClick: () => { openReportMarker(r); emit('sheet-collapse'); } }, icon('map-pin'), 'Show on map')
      : h('span', { class: 'hint', text: 'No coordinates available' })
  );
}

export async function refreshIncidents() {
  const list = $('#incidentList');
  const count = $('#incidentCount');
  const token = ++incidentToken;
  clearNode(list);
  list.append(skeleton(3), skeleton(3));
  count.textContent = 'Loading…';

  try {
    const reports = await getRecentReports({ ...filters });
    if (token !== incidentToken) return;
    clearNode(list);
    count.textContent = `${reports.length} record${reports.length === 1 ? '' : 's'}`;
    if (!reports.length) {
      list.append(emptyState('No reports match these filters', 'Try clearing the filters or widening the date range.', h('button', { class: 'btn btn-sm', type: 'button', onClick: () => $('#fReset').click() }, 'Clear filters')));
    } else {
      reports.forEach((r) => list.append(reportCard(r)));
    }
    if (incidentsOpen) showReportMarkers(reports, reportPopup);
    emit('reports-loaded', { filtered: filters.q || filters.severity || filters.status || filters.from || filters.to, reports });
  } catch (err) {
    if (token !== incidentToken) return;
    clearNode(list);
    count.textContent = 'Unavailable';
    list.append(errorState(err.kind === 'unavailable' ? 'The backend does not provide a reports list yet (GET /reports was not found).' : err.message, refreshIncidents, 'Retry'));
  }
  refreshIcons();
}

export { flyTo };
