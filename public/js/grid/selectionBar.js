/**
 * Floating multi-selection bar (layout v5, lot L6) — REPLACES the minimal L4
 * context bar. A single `position:fixed` toolbar centred at the bottom of the
 * viewport, appended to <body> (so it can never be clipped by the canvas and
 * never scrolls with the grid), `role="toolbar"`.
 *
 * It is PURELY a view + write surface: it never owns selection STATE (the store
 * grid/selection.js does) and never reads the DOM to guess the selection — it
 * subscribes to the coalesced `homy:selection` event (grid/selectionEvents.js)
 * and rebuilds from the payload.
 *
 * SECTIONS (in order):
 *   1. counter      — « N selected » (+ « x objects · y groups » when mixed)
 *   2. Objects      — only when >= 1 object is selected. A control appears ONLY
 *                     when at least one selected object CARRIES its key, and it
 *                     is applied ONLY to those objects:
 *                       - Shape (rounded|square)   → element `options.surfaceShape`
 *                       - Opacity                  → widget `config.bgOpacity`
 *                                                    element `options.surfaceOpacity`
 *                       - Color (+ Theme reset)    → widget `config.bgColor`
 *                                                    element `options.surfaceColor`
 *                       - Icon size                → element `options.iconSize`
 *                     A report carries none of these → no surface field.
 *   3. Groups       — only when >= 1 group is selected: Title, Title visibility
 *                     and the group appearance schema MINUS the removed
 *                     `zoom`/`tileInset` keys (= APPEARANCE_FIELDS).
 *   4. actions      — Group · Ungroup · Delete · Delete group + contents
 *                     (2-step). Actions are GLOBAL (bound to no family).
 *
 * SINGLE item → the same fields + an « Edit… » that opens the full panel of the
 * kind (widget → settings modal, element → tile options panel, group → group
 * modal). MIXED objects+groups → both sections COEXIST, each bounded to its
 * family; only the action row is global.
 *
 * « mixed » PER KEY: when the carriers disagree, the control shows a visible
 * `is-mixed` marker and a neutral value; moving it OVERWRITES the key on every
 * carrier of that key (the whole family that carries it).
 */

import { el } from '../util.js';
import { APPEARANCE_FIELDS } from '../widgets/registry.js';
import { selection } from './selection.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const GROUP_TITLE_FALLBACK = 'always';
const GROUP_VISIBILITIES = [
  { value: 'always', label: 'Always' },
  { value: 'hover', label: 'Hover' },
  { value: 'never', label: 'Never' },
];
const SURFACE_SHAPES = [
  { value: 'rounded', label: 'Rounded' },
  { value: 'square', label: 'Square' },
];
const COLOR_FALLBACK = '#4f8cff';

/**
 * Object surface slots. `get(info)` reads the CURRENT value (tolerant defaults),
 * `set(info, value)` returns the patch to merge into the object's persisted
 * bag. `kinds` = which object kinds CARRY the key (that is the whole
 * « appears only if a selected object carries the key » rule).
 */
const OBJECT_SLOTS = [
  {
    key: 'shape',
    label: 'Shape',
    kinds: ['element'],
    type: 'segmented',
    options: SURFACE_SHAPES,
    get: (info) => (info.options?.surfaceShape === 'square' ? 'square' : 'rounded'),
    set: (_info, value) => ({ surfaceShape: value }),
  },
  {
    key: 'opacity',
    label: 'Opacity',
    kinds: ['widget', 'element'],
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    get: (info) => {
      const raw = info.kind === 'widget' ? info.config?.bgOpacity : info.options?.surfaceOpacity;
      const n = Number(raw);
      return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : 100;
    },
    set: (info, value) => (info.kind === 'widget' ? { bgOpacity: value } : { surfaceOpacity: value }),
  },
  {
    key: 'color',
    label: 'Color',
    kinds: ['widget', 'element'],
    type: 'color',
    get: (info) => String((info.kind === 'widget' ? info.config?.bgColor : info.options?.surfaceColor) || ''),
    set: (info, value) => (info.kind === 'widget' ? { bgColor: value } : { surfaceColor: value }),
  },
  {
    key: 'iconSize',
    label: 'Icon size',
    kinds: ['element'],
    type: 'range',
    min: 8,
    max: 120,
    step: 0.5,
    unit: '%',
    get: (info) => {
      const n = Number(info.options?.iconSize);
      return Number.isFinite(n) ? clamp(n, 8, 120) : 55;
    },
    set: (_info, value) => ({ iconSize: value }),
  },
];

/**
 * Group appearance schema — the SAME fields as the group settings modal minus
 * the removed `zoom`/`tileInset` keys (they no longer exist). Each entry maps a
 * group config key to a control.
 */
const GROUP_FIELDS = [
  { key: 'title', label: 'Title', type: 'text', fallback: '' },
  { key: 'titleVisibility', label: 'Title visibility', type: 'segmented', options: GROUP_VISIBILITIES, fallback: GROUP_TITLE_FALLBACK },
  ...APPEARANCE_FIELDS.map((f) => ({ ...f, fallback: f.default })),
];

export function createSelectionBar({ getGrid, getGroups, actions }) {
  const bar = el('div', 'selection-bar hidden', null, { id: 'group-context-bar', role: 'toolbar', 'aria-label': 'Selection' });
  document.body.appendChild(bar);

  let mode = 'view';
  let lastDetail = { objects: [], groups: [], count: 0, source: 'click' };
  let confirmTimer = 0;
  const CONFIRM_MS = 3000;

  // ---- object helpers -----------------------------------------------------
  function objectInfos() {
    const grid = getGrid();
    if (!grid) return [];
    const out = [];
    for (const id of selection.objects) {
      const info = grid.getObjectMeta(id);
      if (info) out.push(info);
    }
    return out;
  }

  function groupInfos() {
    const groups = getGroups() || [];
    const byId = new Map(groups.map((g) => [String(g.id), g]));
    const out = [];
    for (const id of selection.groups) {
      const g = byId.get(String(id));
      if (g) out.push(g);
    }
    return out;
  }

  /** Values of a slot across its carriers → { mixed, value, carriers }. */
  function slotState(slot, infos) {
    const carriers = infos.filter((info) => slot.kinds.includes(info.kind));
    if (!carriers.length) return null;
    const values = carriers.map((info) => slot.get(info));
    const first = values[0];
    const mixed = values.some((v) => String(v) !== String(first));
    return { carriers, value: first, mixed };
  }

  function applyObjectSlot(slot, value) {
    const grid = getGrid();
    if (!grid) return;
    for (const info of objectInfos()) {
      if (!slot.kinds.includes(info.kind)) continue;
      const patch = slot.set(info, value);
      if (info.kind === 'widget') grid.setWidgetConfig(info.id, patch);
      else grid.setObjectOptions(info.id, patch);
    }
  }

  // ---- generic controls ---------------------------------------------------
  function fmt(value, unit) {
    const n = Number(value);
    const txt = Number.isFinite(n) ? String(Math.round(n * 10) / 10) : String(value);
    return unit ? `${txt} ${unit}` : txt;
  }

  function fieldShell(label, mixed) {
    const wrap = el('div', 'sel-field' + (mixed ? ' is-mixed' : ''));
    wrap.appendChild(el('span', 'sel-field-label', label));
    return wrap;
  }

  function buildRange(slot, state, onInput) {
    const wrap = fieldShell(slot.label, state.mixed);
    const input = el('input', 'sel-range', null, { type: 'range', min: String(slot.min), max: String(slot.max), step: String(slot.step), 'aria-label': slot.label });
    input.value = String(state.value);
    const val = el('span', 'sel-field-val', fmt(state.value, slot.unit));
    input.addEventListener('input', () => {
      wrap.classList.remove('is-mixed');
      val.textContent = fmt(input.value, slot.unit);
      onInput(Number(input.value));
    });
    wrap.append(input, val);
    return wrap;
  }

  function buildSegmented(slot, state, onPick) {
    const wrap = fieldShell(slot.label, state.mixed);
    const row = el('div', 'segmented');
    for (const opt of slot.options || []) {
      const b = el('button', 'segmented-item' + (!state.mixed && state.value === opt.value ? ' active' : ''), opt.label, { type: 'button' });
      b.addEventListener('click', () => onPick(opt.value));
      row.appendChild(b);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function buildColor(slot, state, { onInput, onReset }) {
    const wrap = fieldShell(slot.label, state.mixed);
    const row = el('div', 'sel-color-row');
    const input = el('input', 'sel-color', null, { type: 'color', 'aria-label': `${slot.label} color` });
    input.value = state.value || COLOR_FALLBACK;
    input.addEventListener('input', () => {
      wrap.classList.remove('is-mixed');
      onInput(input.value);
    });
    const theme = el('button', 'btn sel-theme', 'Theme', { type: 'button', title: 'Use the theme default' });
    theme.addEventListener('click', () => {
      wrap.classList.remove('is-mixed');
      onReset();
    });
    row.append(input, theme);
    wrap.appendChild(row);
    return wrap;
  }

  function buildText(slot, state, onInput) {
    const wrap = fieldShell(slot.label, state.mixed);
    const input = el('input', 'sel-text', null, { type: 'text', placeholder: state.mixed ? 'Mixed' : '' });
    input.value = state.mixed ? '' : String(state.value ?? '');
    input.addEventListener('input', () => {
      wrap.classList.remove('is-mixed');
      onInput(input.value);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function buildToggle(slot, state, onChange) {
    const wrap = el('label', 'sel-field sel-field-toggle' + (state.mixed ? ' is-mixed' : ''));
    const input = el('input', null, null, { type: 'checkbox' });
    input.checked = !!state.value;
    input.addEventListener('change', () => {
      wrap.classList.remove('is-mixed');
      onChange(input.checked);
    });
    wrap.append(input, el('span', 'sel-field-label', slot.label));
    return wrap;
  }

  // ---- object section -----------------------------------------------------
  function buildObjectSection(infos) {
    const section = el('div', 'sel-section sel-objects');
    section.appendChild(el('span', 'sel-section-title', 'Objects'));
    for (const slot of OBJECT_SLOTS) {
      const state = slotState(slot, infos);
      if (!state) continue;
      if (slot.type === 'range') section.appendChild(buildRange(slot, state, (v) => applyObjectSlot(slot, v)));
      else if (slot.type === 'segmented') section.appendChild(buildSegmented(slot, state, (v) => applyObjectSlot(slot, v)));
      else if (slot.type === 'color') {
        section.appendChild(
          buildColor(slot, state, {
            onInput: (v) => applyObjectSlot(slot, v),
            onReset: () => applyObjectSlot(slot, ''),
          })
        );
      }
    }
    return section;
  }

  // ---- group section ------------------------------------------------------
  function groupState(def, groups) {
    const values = groups.map((g) => {
      const c = g.config || {};
      const v = c[def.key];
      return v === undefined || v === null ? def.fallback : v;
    });
    const first = values[0];
    const mixed = values.some((v) => String(v) !== String(first));
    return { value: first, mixed };
  }

  function applyGroupField(key, value) {
    const groups = groupInfos();
    for (const g of groups) actions.setGroupConfig(g.id, { [key]: value });
  }

  function buildGroupSection(groups) {
    const section = el('div', 'sel-section sel-groups');
    section.appendChild(el('span', 'sel-section-title', 'Groups'));
    for (const def of GROUP_FIELDS) {
      const state = groupState(def, groups);
      const slot = { ...def, options: def.options };
      if (def.type === 'range') section.appendChild(buildRange(slot, state, (v) => applyGroupField(def.key, v)));
      else if (def.type === 'segmented') section.appendChild(buildSegmented(slot, state, (v) => applyGroupField(def.key, v)));
      else if (def.type === 'color') {
        section.appendChild(
          buildColor(slot, state, {
            onInput: (v) => applyGroupField(def.key, v),
            onReset: () => applyGroupField(def.key, ''),
          })
        );
      } else if (def.type === 'toggle') {
        section.appendChild(buildToggle(slot, state, (v) => applyGroupField(def.key, v)));
      } else section.appendChild(buildText(slot, state, (v) => applyGroupField(def.key, v)));
    }
    return section;
  }

  // ---- actions ------------------------------------------------------------
  function buildActions(infos, groups) {
    const row = el('div', 'sel-actions');
    const btn = (label, cls, title, onClick) => {
      const b = el('button', `btn ${cls}`, label, { type: 'button', title });
      b.addEventListener('click', onClick);
      return b;
    };
    if (infos.length >= 1) row.appendChild(btn('Group', '', 'Group the selected objects', () => actions.group()));
    if (groups.length >= 1) row.appendChild(btn('Ungroup', '', 'Dissolve the selected group(s) — objects stay', () => actions.dissolveGroups()));
    row.appendChild(btn('Delete', 'btn-danger', 'Delete the selected objects (groups are only dissolved)', () => actions.deleteSelection('click')));
    if (groups.length >= 1) {
      // 2-step: the CONTENTS are NEVER removed implicitly, only on a second
      // click within CONFIRM_MS (same pattern as the L4 minimal bar).
      const del = el('button', 'btn btn-danger', 'Delete group + contents', {
        type: 'button',
        title: 'Delete these groups and every object entirely inside them',
      });
      let armed = false;
      const disarm = () => {
        armed = false;
        del.classList.remove('confirm');
        del.textContent = 'Delete group + contents';
      };
      del.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          del.classList.add('confirm');
          del.textContent = 'Click again to confirm';
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(disarm, CONFIRM_MS);
          return;
        }
        clearTimeout(confirmTimer);
        disarm();
        actions.deleteGroupsWithContents();
      });
      row.appendChild(del);
    }
    return row;
  }

  function buildEditButton() {
    if (selection.objects.size + selection.groups.size !== 1) return null;
    const b = el('button', 'btn sel-edit', 'Edit…', { type: 'button', title: 'Open the full settings panel' });
    b.addEventListener('click', () => {
      if (selection.groups.size === 1) {
        actions.editGroup([...selection.groups][0]);
        return;
      }
      const id = [...selection.objects][0];
      const grid = getGrid();
      const info = grid?.getObjectMeta(id);
      if (!info) return;
      if (info.kind === 'widget') grid.openObjectConfig(id);
      else if (info.kind === 'element') grid.openObjectOptions(id);
    });
    return b;
  }

  // ---- render -------------------------------------------------------------
  function render() {
    bar.replaceChildren();
    clearTimeout(confirmTimer);
    const infos = objectInfos();
    const groups = groupInfos();
    const total = selection.objects.size + selection.groups.size;
    if (mode !== 'edit' || total === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');

    const head = el('div', 'sel-count');
    head.appendChild(el('span', 'sel-count-n', `${total} selected`));
    if (selection.objects.size > 0 && selection.groups.size > 0) {
      const nObj = selection.objects.size;
      const nGrp = selection.groups.size;
      head.appendChild(el('span', 'sel-count-detail', `${nObj} object${nObj > 1 ? 's' : ''} · ${nGrp} group${nGrp > 1 ? 's' : ''}`));
    }
    const edit = buildEditButton();
    if (edit) head.appendChild(edit);
    bar.appendChild(head);

    if (infos.length >= 1) bar.appendChild(buildObjectSection(infos));
    if (groups.length >= 1) bar.appendChild(buildGroupSection(groups));
    bar.appendChild(buildActions(infos, groups));
  }

  const onSelectionEvent = (e) => {
    if (e.detail) lastDetail = e.detail;
    render();
  };
  window.addEventListener('homy:selection', onSelectionEvent);

  return {
    setMode(next) {
      mode = next === 'edit' ? 'edit' : 'view';
      render();
    },
    refresh: render,
    destroy() {
      clearTimeout(confirmTimer);
      window.removeEventListener('homy:selection', onSelectionEvent);
      bar.remove();
    },
    el: bar,
    /** Exposed for tests: the last selection payload the bar received. */
    lastDetail: () => lastDetail,
  };
}
