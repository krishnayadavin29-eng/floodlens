/**
 * autocomplete.js - reusable place-search dropdown (combobox pattern).
 *
 *  - Popular Delhi places filter instantly (no network).
 *  - Remote geocoder results arrive after a debounce (see CONFIG.GEOCODING).
 *  - Keyboard: Arrow Up/Down, Enter, Escape.
 */
import { CONFIG } from './config.js';
import { POPULAR_PLACES } from './mock.js';
import { searchPlaces } from './geocoding.js';
import { debounce } from './utils.js';
import { h, clearNode } from './ui.js';

const normalize = (s) => s.toLowerCase().trim();

/**
 * @param {object} opts
 * @param {HTMLInputElement} opts.input
 * @param {HTMLUListElement} opts.list
 * @param {(place) => void} opts.onSelect     called with {name,label,lat,lng,source}
 * @param {() => void} [opts.onEdit]          called when the user types after selecting
 */
export function createAutocomplete({ input, list, onSelect, onEdit }) {
  let options = [];
  let active = -1;
  let controller = null;
  let remoteNote = '';
  let requestId = 0;

  const localMatches = (q) => {
    const n = normalize(q);
    const pool = POPULAR_PLACES.map((p) => ({ ...p, source: 'popular' }));
    return (n ? pool.filter((p) => normalize(`${p.name} ${p.label}`).includes(n)) : pool).slice(0, n ? 5 : 6);
  };

  function open() {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function setActive(i) {
    const items = [...list.querySelectorAll('[role="option"]')];
    items.forEach((el, idx) => el.setAttribute('aria-selected', idx === i ? 'true' : 'false'));
    active = i;
    if (items[i]) {
      input.setAttribute('aria-activedescendant', items[i].id);
      items[i].scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(place) {
    input.value = place.label;
    // Stop any pending/in-flight search so it cannot re-open the list after a choice was made.
    remoteSearch.cancel();
    controller?.abort();
    requestId += 1;
    close();
    onSelect(place);
  }

  function render(heading) {
    clearNode(list);
    if (heading) list.append(h('li', { class: 'ac-heading', role: 'presentation', text: heading }));
    options.forEach((p, i) => {
      list.append(
        h(
          'li',
          {
            class: 'ac-option',
            role: 'option',
            id: `${list.id}-opt-${i}`,
            'aria-selected': 'false',
            // mousedown (not click) so it fires before the input loses focus
            onMouseDown: (e) => {
              e.preventDefault();
              choose(p);
            },
          },
          h('span', { class: 'ac-name', text: p.name }),
          h('span', { class: 'ac-sub', text: p.source === 'popular' ? 'Popular place · approximate location' : p.label })
        )
      );
    });
    if (remoteNote) list.append(h('li', { class: 'ac-note', role: 'presentation', text: remoteNote }));
    if (!options.length && !remoteNote) list.append(h('li', { class: 'ac-note', role: 'presentation', text: 'No matches yet. Keep typing or click the map.' }));
    open();
    active = -1;
  }

  const remoteSearch = debounce(async (q) => {
    if (q.trim().length < CONFIG.GEOCODING.minChars || document.activeElement !== input) return;
    controller?.abort();
    controller = new AbortController();
    const myId = ++requestId;
    remoteNote = 'Searching places…';
    render('Suggestions');
    try {
      const found = await searchPlaces(q, { signal: controller.signal });
      if (myId !== requestId) return;
      const local = localMatches(q);
      const seen = new Set(local.map((p) => normalize(p.name)));
      options = [...local, ...found.filter((p) => !seen.has(normalize(p.name)))];
      remoteNote = found.length ? '' : 'No more results from place search.';
      render('Suggestions');
    } catch (err) {
      if (err.name === 'AbortError' || myId !== requestId) return;
      options = localMatches(q);
      remoteNote = `${err.message} Showing popular places only.`;
      render('Suggestions');
    }
  }, CONFIG.GEOCODING.debounceMs);

  input.addEventListener('input', () => {
    onEdit?.();
    options = localMatches(input.value);
    remoteNote = input.value.trim().length >= CONFIG.GEOCODING.minChars ? 'Searching places…' : '';
    render(input.value.trim() ? 'Suggestions' : 'Popular places');
    remoteSearch(input.value);
  });

  input.addEventListener('focus', () => {
    if (!input.value.trim()) {
      options = localMatches('');
      remoteNote = '';
      render('Popular places');
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      options = localMatches(input.value);
      render('Suggestions');
    }
    const count = options.length;
    if (e.key === 'ArrowDown' && count) {
      e.preventDefault();
      setActive((active + 1) % count);
    } else if (e.key === 'ArrowUp' && count) {
      e.preventDefault();
      setActive((active - 1 + count) % count);
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return {
    setValue(text) {
      input.value = text;
    },
    clear() {
      input.value = '';
      close();
    },
    close,
  };
}
