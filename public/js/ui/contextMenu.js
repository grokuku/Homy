/**
 * Generic context menu (layout v5, lot L9) — a self-contained, dependency-free
 * popup menu appended to <body> and positioned at the pointer.
 *
 * WHY IT EXISTS: the EDIT canvas used to carry a ✕ (delete) and a ⚙ (options)
 * button on every tile. Those per-tile controls are gone: EVERY object setting
 * is now reachable from a RIGHT CLICK on the object (see grid/contextMenuItems.js
 * for the per-kind content). This module is deliberately generic — it knows
 * nothing about Homy objects — so it can serve any future menu (palette, tabs…).
 *
 * ── API ────────────────────────────────────────────────────────────────────
 *   openContextMenu({ x, y, items, label, onClose }) → controller | null
 *   closeContextMenu()   — close the open menu (no-op when none)
 *   isContextMenuOpen()  — true while a menu (or one of its submenus) is open
 *
 * An ITEM is a plain object (`type` decides the rendering):
 *   header    { label }                                     non-interactive title
 *   separator {}                                            hairline
 *   action    { label, danger?, disabled?, checked?, keepOpen?,
 *               onSelect(ctx) }                             ctx = { close, setLabel, setDisabled }
 *   submenu   { label, items[], disabled? }                 nested panel
 *   checkbox  { label, checked, disabled?, hint?, onChange(next) }
 *   range     { label, min, max, step, value, unit?, disabled?, onChange(n) }
 *   select    { label, value, options:[{value,label}], disabled?, onChange(v) }
 *   color     { label, value, fallback?, onReset?, onChange(v) }
 *   text      { label, value, placeholder?, onChange(v) }
 *
 * Behaviour contract:
 *   - ONE menu at a time: opening a second one closes the first;
 *   - FLIP + CLAMP: a panel that would overflow the viewport opens to the
 *     LEFT / ABOVE the cursor (submenus flip to the left of their parent row)
 *     and is finally clamped inside the viewport;
 *   - CLOSES on: click outside, Escape, scroll, resize, window blur, a mode
 *     change / grid rebuild (the caller calls closeContextMenu()), or any action
 *     item (unless `keepOpen`, used by 2-step confirmations and by the
 *     check/range/select/color/text rows which stay open to chain changes);
 *   - KEYBOARD: ↑/↓ move (skipping separators + disabled rows), Home/End,
 *     →/← open/close a submenu, Enter/Space activate, Escape closes the deepest
 *     panel first. Key events are handled in the CAPTURE phase and stopped
 *     there, so the canvas keyboard brain (Delete/Backspace/Escape/Ctrl+A in
 *     grid/groupEditor.js) and the page arrows in main.js never fire while a
 *     menu is open;
 *   - NO residual node / timer / listener after close.
 *
 * Accessibility: `role="menu"` on every panel, `menuitem` / `menuitemcheckbox`
 * / `menuitemradio` on the rows, `aria-checked` / `aria-disabled`, focus moves
 * to the first actionable row on open, and focus is restored to the previously
 * focused element when the close was not caused by a focus grab elsewhere.
 */

import { el } from '../util.js';

const EDGE = 6; // min distance (px) kept from every viewport edge
const GAP = 2; // gap (px) between the cursor / parent row and a panel

/** The single open menu controller (never more than one). */
let active = null;

/** True while a menu (root panel or any submenu) is open. */
export function isContextMenuOpen() {
  return !!active;
}

/** Close the open menu, if any. Safe to call from any lifecycle hook. */
export function closeContextMenu() {
  if (active) active.close();
}

/** Pretty value for a range (`55.0` → `55`, `55.5` → `55.5`). */
function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return String(Math.round(n * 10) / 10);
}

/** Drop empty/invalid entries so a builder can return a sparse list. */
function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item === 'object' && typeof item.type === 'string');
}

function hasSubmenu(item) {
  return item.type === 'submenu' && sanitizeItems(item.items).length > 0;
}

/** Rows that can receive focus with ↑/↓. */
function isFocusableRow(row) {
  return row && row.dataset.focusable === '1' && row.getAttribute('aria-disabled') !== 'true';
}

/**
 * Open a context menu at viewport coordinates `{ x, y }`.
 *
 * @param {object}   opts
 * @param {number}   opts.x        client X of the pointer
 * @param {number}   opts.y        client Y of the pointer
 * @param {object[]} opts.items    item descriptors (see the module doc)
 * @param {string}   [opts.label]  accessible name of the root panel
 * @param {Function} [opts.onClose] called ONCE after the menu is torn down
 * @returns {{ close: Function, el: HTMLElement }|null} null when `items` is empty
 */
export function openContextMenu({ x = 0, y = 0, items = [], label = 'Options', onClose = null } = {}) {
  // One menu at a time — the previous one is torn down (listeners included).
  if (active) active.close();

  const rootItems = sanitizeItems(items);
  if (!rootItems.length) return null;

  const states = []; // open panels, index 0 = root, last = deepest submenu
  let closed = false;
  let previousFocus = document.activeElement;

  // ---- positioning ---------------------------------------------------------
  /** Place `panel` so it stays ENTIRELY visible, preferring the given anchor. */
  function placePanel(panel, anchorX, anchorY) {
    panel.style.left = '0px';
    panel.style.top = '0px';
    const rect = panel.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    let left = anchorX + GAP;
    let top = anchorY + GAP;
    // Horizontal: flip to the left of the anchor when the right side overflows,
    // then clamp (a panel wider than the viewport is pinned to the left edge).
    if (left + rect.width > vw - EDGE) left = anchorX - rect.width - GAP;
    if (left < EDGE) left = Math.min(Math.max(EDGE, vw - rect.width - EDGE), EDGE);
    // Vertical: flip above, then clamp the same way.
    if (top + rect.height > vh - EDGE) top = anchorY - rect.height - GAP;
    if (top < EDGE) top = Math.min(Math.max(EDGE, vh - rect.height - EDGE), EDGE);
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    return panel.getBoundingClientRect();
  }

  // ---- panel lifecycle -----------------------------------------------------
  /** Close `state` and every deeper panel; the root panel closes everything. */
  function closeFrom(state) {
    const idx = states.indexOf(state);
    if (idx < 0) return;
    for (const deeper of states.splice(idx)) {
      if (deeper.parentRow) {
        deeper.parentRow.classList.remove('open');
        deeper.parentRow.setAttribute('aria-expanded', 'false');
      }
      deeper.panel.remove();
    }
    if (!states.length) closeAll();
  }

  /** Close the open submenu of `state` (and anything deeper), keeping `state`. */
  function closeChild(state) {
    if (!state || !state.child) return;
    const child = state.child;
    state.child = null;
    closeFrom(child);
  }

  function closeAll() {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onOutsideMouseDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onWindowBlur);
    for (const s of states.splice(0)) s.panel.remove();
    if (active === controller) active = null;
    // Restore focus when the menu swallowed it and nothing else claimed it (a
    // menu action opening a modal keeps the modal's own focus).
    const focusNow = document.activeElement;
    if (
      previousFocus &&
      previousFocus !== document.body &&
      previousFocus.isConnected &&
      typeof previousFocus.focus === 'function' &&
      (!focusNow || focusNow === document.body || focusNow === previousFocus)
    ) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        /* focus is best-effort */
      }
    }
    previousFocus = null;
    if (typeof onClose === 'function') {
      try {
        onClose();
      } catch (err) {
        console.error('[contextMenu] onClose failed', err);
      }
    }
  }

  // ---- rows ----------------------------------------------------------------
  /** Focusable row shell (`action` / `checkbox` / `submenu`). */
  function buildRow(item) {
    const isCheckbox = item.type === 'checkbox';
    const isRadio = !isCheckbox && item.checked !== undefined;
    const row = el('div', 'context-item', null, {
      role: isCheckbox ? 'menuitemcheckbox' : isRadio ? 'menuitemradio' : 'menuitem',
      tabindex: '-1',
    });
    row.dataset.focusable = '1';
    if (isCheckbox || isRadio) row.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    if (hasSubmenu(item)) {
      row.classList.add('has-submenu');
      row.setAttribute('aria-haspopup', 'menu');
      row.setAttribute('aria-expanded', 'false');
    }
    if (item.danger) row.classList.add('danger');
    if (item.disabled) {
      row.classList.add('disabled');
      row.setAttribute('aria-disabled', 'true');
    }
    const mark = el('span', 'context-mark', isCheckbox || isRadio ? '✓' : '');
    mark.setAttribute('aria-hidden', 'true');
    row.appendChild(mark);
    const main = el('div', 'context-main');
    main.appendChild(el('span', 'context-label', String(item.label ?? '')));
    if (item.hint) main.appendChild(el('small', 'context-hint', String(item.hint)));
    row.appendChild(main);
    if (hasSubmenu(item)) {
      const arrow = el('span', 'context-arrow', '›');
      arrow.setAttribute('aria-hidden', 'true');
      row.appendChild(arrow);
    }
    return row;
  }

  function buildRangeRow(item) {
    const wrap = el('div', 'context-field');
    const head = el('div', 'context-field-head');
    head.appendChild(el('span', 'context-label', String(item.label ?? '')));
    const valueEl = el('span', 'context-field-value', `${fmtNumber(item.value)}${item.unit || ''}`);
    head.appendChild(valueEl);
    const input = el('input', 'context-range', null, {
      type: 'range',
      min: String(item.min ?? 0),
      max: String(item.max ?? 100),
      step: String(item.step ?? 1),
      'aria-label': String(item.label ?? ''),
    });
    input.value = String(item.value ?? item.min ?? 0);
    if (item.disabled) {
      input.disabled = true;
      wrap.classList.add('disabled');
    }
    input.addEventListener('input', () => {
      const next = Number(input.value);
      valueEl.textContent = `${fmtNumber(next)}${item.unit || ''}`;
      item.onChange?.(next);
    });
    // The slider lives INSIDE the menu: its key/mouse events must never reach
    // the panel navigation (arrows would move the focus away mid-drag).
    input.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.append(head, input);
    return wrap;
  }

  function buildSelectRow(item) {
    const wrap = el('div', 'context-field');
    const head = el('div', 'context-field-head');
    head.appendChild(el('span', 'context-label', String(item.label ?? '')));
    wrap.appendChild(head);
    const row = el('div', 'segmented');
    for (const opt of item.options || []) {
      const active = String(opt.value) === String(item.value);
      const b = el('button', 'segmented-item' + (active ? ' active' : ''), opt.label, { type: 'button' });
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.disabled = !!item.disabled;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (item.disabled) return;
        for (const other of row.children) {
          other.classList.remove('active');
          other.setAttribute('aria-pressed', 'false');
        }
        b.classList.add('active');
        b.setAttribute('aria-pressed', 'true');
        item.onChange?.(opt.value);
      });
      row.appendChild(b);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function buildColorRow(item) {
    const wrap = el('div', 'context-field');
    const head = el('div', 'context-field-head');
    head.appendChild(el('span', 'context-label', String(item.label ?? '')));
    const row = el('div', 'context-color-row');
    const input = el('input', 'context-color', null, {
      type: 'color',
      'aria-label': String(item.label ?? 'Color'),
    });
    input.value = item.value || item.fallback || '#3a4150';
    input.addEventListener('input', () => item.onChange?.(input.value));
    input.addEventListener('keydown', (e) => e.stopPropagation());
    row.appendChild(input);
    if (typeof item.onReset === 'function') {
      const theme = el('button', 'btn context-theme', 'Theme', {
        type: 'button',
        title: 'Use the theme default color',
      });
      theme.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.onReset();
      });
      row.appendChild(theme);
    }
    wrap.append(head, row);
    return wrap;
  }

  function buildTextRow(item) {
    const wrap = el('div', 'context-field');
    const head = el('div', 'context-field-head');
    head.appendChild(el('span', 'context-label', String(item.label ?? '')));
    const input = el('input', 'context-text', null, {
      type: 'text',
      placeholder: String(item.placeholder || ''),
      'aria-label': String(item.label ?? ''),
    });
    input.value = String(item.value ?? '');
    input.addEventListener('input', () => item.onChange?.(input.value));
    input.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.append(head, input);
    return wrap;
  }

  // ---- panels --------------------------------------------------------------
  function openPanel(list, { level, anchor, parentRow = null }) {
    const panel = el('div', 'context-menu', null, {
      role: 'menu',
      tabindex: '-1',
    });
    if (level === 0) {
      panel.id = 'homy-context-menu';
      panel.setAttribute('aria-label', label);
    }
    const state = { panel, level, parentRow, rows: [], child: null };
    for (const item of list) {
      if (item.type === 'separator') {
        panel.appendChild(el('div', 'context-sep', null, { role: 'separator' }));
        continue;
      }
      if (item.type === 'header') {
        const header = el('div', 'context-header', String(item.label ?? ''), { role: 'presentation' });
        if (item.hint) header.title = String(item.hint);
        panel.appendChild(header);
        continue;
      }
      if (item.type === 'range') {
        panel.appendChild(buildRangeRow(item));
        continue;
      }
      if (item.type === 'select') {
        panel.appendChild(buildSelectRow(item));
        continue;
      }
      if (item.type === 'color') {
        panel.appendChild(buildColorRow(item));
        continue;
      }
      if (item.type === 'text') {
        panel.appendChild(buildTextRow(item));
        continue;
      }
      const row = buildRow(item);
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        activate(state, row, item);
      });
      row.addEventListener('mouseenter', () => {
        // Hovering a row closes the sibling submenu and opens its own (classic
        // menu behaviour); hovering a plain row closes the open submenu.
        closeChild(state);
        if (hasSubmenu(item) && !item.disabled) openSubmenu(state, row, item);
      });
      state.rows.push({ row, item });
      panel.appendChild(row);
    }
    document.body.appendChild(panel);
    const rect = level === 0 ? placePanel(panel, anchor.x, anchor.y) : positionSubmenu(panel, parentRow);
    states.push(state);
    if (parentRow) {
      parentRow.classList.add('open');
      parentRow.setAttribute('aria-expanded', 'true');
    }
    return { state, rect };
  }

  function positionSubmenu(panel, parentRow) {
    const r = parentRow.getBoundingClientRect();
    const parentPanel = parentRow.closest('.context-menu');
    const pr = parentPanel ? parentPanel.getBoundingClientRect() : r;
    panel.style.left = '0px';
    panel.style.top = '0px';
    const size = panel.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    let left = pr.right + GAP;
    if (left + size.width > vw - EDGE) left = pr.left - size.width - GAP; // flip left
    if (left < EDGE) left = EDGE;
    let top = r.top - 6;
    if (top + size.height > vh - EDGE) top = vh - size.height - EDGE; // clamp bottom
    if (top < EDGE) top = EDGE;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    return panel.getBoundingClientRect();
  }

  function openSubmenu(state, row, item) {
    closeChild(state);
    const { state: child } = openPanel(sanitizeItems(item.items), {
      level: state.level + 1,
      parentRow: row,
    });
    state.child = child;
    const first = child.rows.find((r) => isFocusableRow(r.row));
    if (first) first.row.focus({ preventScroll: true });
  }

  function toggleSubmenu(state, row, item) {
    if (state.child) {
      closeChild(state);
      return;
    }
    openSubmenu(state, row, item);
  }

  // ---- activation ----------------------------------------------------------
  function setRowLabel(row, text) {
    const labelEl = row.querySelector('.context-label');
    if (labelEl) labelEl.textContent = text;
  }

  function activate(state, row, item) {
    if (item.disabled) return;
    if (hasSubmenu(item)) {
      toggleSubmenu(state, row, item);
      return;
    }
    if (item.type === 'checkbox') {
      item.checked = !item.checked;
      row.setAttribute('aria-checked', item.checked ? 'true' : 'false');
      try {
        item.onChange?.(item.checked);
      } catch (err) {
        console.error('[contextMenu] onChange failed', err);
      }
      return; // chained toggles: the menu stays open
    }
    // action (or a `menuitemradio` action carrying `checked`)
    let keepOpen = !!item.keepOpen;
    try {
      const res = item.onSelect?.({
        close: closeAll,
        setLabel: (text) => setRowLabel(row, text),
        setDisabled: (disabled) => {
          row.setAttribute('aria-disabled', disabled ? 'true' : 'false');
          row.classList.toggle('disabled', !!disabled);
        },
      });
      if (res === false) keepOpen = true;
    } catch (err) {
      console.error('[contextMenu] onSelect failed', err);
    }
    if (!keepOpen) closeAll();
  }

  // ---- keyboard ------------------------------------------------------------
  function focusableRows(state) {
    return state.rows.filter((r) => isFocusableRow(r.row));
  }

  function focusStep(state, dir) {
    const list = focusableRows(state);
    if (!list.length) return;
    const idx = list.findIndex((r) => r.row === document.activeElement);
    const next = idx < 0 ? (dir > 0 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    list[next].row.focus({ preventScroll: true });
  }

  function onKeyDown(e) {
    if (closed) return;
    const state = states[states.length - 1];
    if (!state) return;
    // A focused control inside the menu keeps its own key semantics (arrow
    // keys on a range slider, typing in the title field); only Escape escapes.
    const t = e.target;
    const inField = !!(t && t.closest && t.closest('input, textarea, select, [contenteditable]'));
    const key = e.key;
    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (state.level > 0) {
        const parentRow = state.parentRow;
        closeFrom(state);
        const parent = states[states.length - 1];
        if (parent) {
          if (parent.child === state) parent.child = null;
          parentRow?.focus?.({ preventScroll: true });
        }
      } else {
        closeAll();
      }
      return;
    }
    if (inField) return;
    if (key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      focusStep(state, 1);
      return;
    }
    if (key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      focusStep(state, -1);
      return;
    }
    if (key === 'Home' || key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      const list = focusableRows(state);
      if (list.length) list[key === 'Home' ? 0 : list.length - 1].row.focus({ preventScroll: true });
      return;
    }
    if (key === 'ArrowRight') {
      const entry = state.rows.find((r) => r.row === document.activeElement);
      if (entry && hasSubmenu(entry.item) && !entry.item.disabled) {
        e.preventDefault();
        e.stopPropagation();
        if (!state.child) openSubmenu(state, entry.row, entry.item);
        return;
      }
      return;
    }
    if (key === 'ArrowLeft') {
      if (state.level > 0) {
        e.preventDefault();
        e.stopPropagation();
        const parentRow = state.parentRow;
        closeFrom(state);
        const parent = states[states.length - 1];
        if (parent) {
          if (parent.child === state) parent.child = null;
          parentRow?.focus?.({ preventScroll: true });
        }
      }
      return;
    }
    if (key === 'Tab') {
      // Never trap Tab inside a transient menu: close it and let focus move on.
      closeAll();
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      const entry = state.rows.find((r) => r.row === document.activeElement);
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      activate(state, entry.row, entry.item);
    }
  }

  // ---- outside interactions ------------------------------------------------
  function onOutsideMouseDown(e) {
    if (closed) return;
    const t = e.target;
    if (t && t.closest && t.closest('.context-menu')) return; // inside a panel
    closeAll();
  }

  function onScroll(e) {
    if (closed) return;
    const t = e.target;
    // Scrolling INSIDE a panel (long menu on a small screen) must not close it.
    if (t && t.nodeType === 1 && t.closest && t.closest('.context-menu')) return;
    closeAll();
  }

  function onResize() {
    closeAll();
  }

  function onWindowBlur() {
    closeAll();
  }

  // ---- open ----------------------------------------------------------------
  const controller = {
    close: closeAll,
    get el() {
      return states[0]?.panel || null;
    },
  };
  active = controller;

  const { state: rootState } = openPanel(rootItems, { level: 0, anchor: { x, y } });

  document.addEventListener('mousedown', onOutsideMouseDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onWindowBlur);

  rootState.panel.focus({ preventScroll: true });
  const first = rootState.rows.find((r) => isFocusableRow(r.row));
  if (first) first.row.focus({ preventScroll: true });

  return controller;
}
