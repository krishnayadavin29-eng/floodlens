/**
 * Small UI helpers: safe DOM building, toast notifications, confirm dialog, icons.
 * Everything user-provided is inserted with textContent (never innerHTML)
 * so text from geocoders, reports or APIs cannot inject HTML.
 */
import { RISK_META } from './utils.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * h('div', { class: 'card', onClick: fn }, 'text', childNode, ...)
 * Tiny hyperscript helper. Strings become text nodes, not HTML.
 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, extraClass = '') {
  return h('i', { 'data-lucide': name, class: `icon ${extraClass}`.trim(), 'aria-hidden': 'true' });
}

/** Turn <i data-lucide="..."> placeholders into SVG icons. Call after inserting new DOM. */
export function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setLoading(button, isLoading, loadingText) {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalHtml = button.dataset.originalHtml || button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    clearNode(button);
    button.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), loadingText || 'Loading…');
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml; // original markup written by us, not user data
      delete button.dataset.originalHtml;
      refreshIcons();
    }
  }
}

// ---------------------------------------------------------------- toasts -----
const TOAST_ICONS = { info: 'info', success: 'check-circle', warning: 'alert-triangle', error: 'x-circle' };

export function toast(message, type = 'info', timeout = 5000) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const node = h(
    'div',
    { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(TOAST_ICONS[type] || 'info'),
    h('span', { class: 'toast-text', text: message }),
    h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss notification', onClick: () => dismiss() }, icon('x'))
  );
  const dismiss = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  container.append(node);
  refreshIcons();
  if (timeout) setTimeout(dismiss, timeout);
  // Keep the stack short
  while (container.children.length > 4) container.firstChild.remove();
}

// ------------------------------------------------------------ confirm dialog --
export function confirmDialog({ title, message, confirmText = 'Continue', cancelText = 'Cancel' }) {
  const dialog = document.getElementById('confirmDialog');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const okBtn = document.getElementById('confirmOk');
  const cancelBtn = document.getElementById('confirmCancel');
  okBtn.textContent = confirmText;
  cancelBtn.textContent = cancelText;

  return new Promise((resolve) => {
    const finish = (result) => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = (e) => {
      if (e) e.preventDefault();
      finish(false);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    okBtn.focus();
  });
}

// ----------------------------------------------------------- shared widgets --
export function riskBadge(level, text) {
  const meta = RISK_META[level] || RISK_META.unknown;
  return h('span', { class: `badge risk-${level in RISK_META ? level : 'unknown'}` }, h('span', { class: 'badge-dot' }), text || meta.label);
}

export function chip(text, cls = '') {
  return h('span', { class: `chip ${cls}`.trim(), text });
}

export function emptyState(title, body, action) {
  return h('div', { class: 'empty-state' }, h('p', { class: 'empty-title', text: title }), body ? h('p', { class: 'empty-body', text: body }) : null, action || null);
}

export function errorState(message, onRetry, retryLabel = 'Try again') {
  return h(
    'div',
    { class: 'error-state', role: 'alert' },
    icon('alert-triangle'),
    h('div', { class: 'error-body' }, h('p', { text: message }), onRetry ? h('button', { class: 'btn btn-sm', type: 'button', onClick: onRetry }, icon('refresh-cw'), retryLabel) : null)
  );
}

export function skeleton(lines = 3) {
  return h('div', { class: 'skeleton-block', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('div', { class: 'skeleton-line', style: `width:${90 - i * 14}%` })));
}

/** key / value row for detail lists. `value` may be a string or a Node. */
export function detailRow(label, value, { muted = false } = {}) {
  const content = value === null || value === undefined || value === '' ? 'Not available' : value;
  const isMissing = content === 'Not available';
  return h('div', { class: 'detail-row' }, h('dt', { text: label }), h('dd', { class: isMissing || muted ? 'is-missing' : '' }, content));
}
