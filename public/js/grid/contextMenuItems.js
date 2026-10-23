/**
 * EDIT-mode context-menu CONTENT (layout v5, lot L9) — the per-kind item lists
 * fed to ui/contextMenu.js by the EDIT canvas (grid/groupEditor.js).
 *
 * WHY: the per-tile ✕ (delete) and ⚙ (options) buttons were removed from the
 * canvas. Every setting of every object is now reachable from a RIGHT CLICK on
 * it — no control overlay, no lost canvas space, and one uniform gesture for
 * objects, widgets and group boxes.
 *
 * This module is PURE: it builds item descriptors and calls the callbacks it is
 * given. It never touches persistence directly — `actions` is wired by
 * gridEditor (setOptions → editor.setObjectOptions → debounced PUT, …), so a
 * menu write is exactly ONE mutation, like every other canvas write.
 *
 * Per-kind content:
 *   element : display switches (Icon / Label / Shortcut / Health / Monitoring /
 *             Controls), Icon size (8–120 %, step 0.5), Label position (submenu),
 *             Allow icon overflow, Surface (shape / opacity / color + Theme),
 *             Settings… (full tile panel), Edit element… (catalogue modal),
 *             Delete
 *   widget  : Settings… (schema-driven modal), Delete
 *   report  : Delete (a report has no per-tile options — its element does)
 *   group   : Title (live text), Title visibility (submenu), Appearance…,
 *             Ungroup, Delete group + contents (2-step)
 *   canvas  : Add element… / Add report… (same entry points as the topbar)
 */

import {
  ICON_SIZE_MAX,
  ICON_SIZE_MIN,
  ICON_SIZE_STEP,
  LABEL_POSITIONS,
  SURFACE_OPACITY_MAX,
  SURFACE_OPACITY_MIN,
  SURFACE_SHAPES,
  normalizeIconSize,
  elementHasDockyTarget,
  elementHasHealthSource,
  elementHasUrl,
} from '../elements/button.js';

const LABEL_POS_LABEL = { bottom: 'Bottom', top: 'Top', left: 'Left', right: 'Right', overlay: 'Overlay' };
const SURFACE_SHAPE_LABEL = { rounded: 'Rounded', square: 'Square' };
const TITLE_VISIBILITIES = [
  { value: 'always', label: 'Always' },
  { value: 'hover', label: 'On hover' },
  { value: 'never', label: 'Never' },
];
const COLOR_FALLBACK = '#3a4150'; // same swatch fallback as the tile panels

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Human label of an object, used as the menu header. */
function objectLabel(info, element) {
  if (info.kind === 'element') return element?.name || 'Element';
  if (info.kind === 'report') return `${element?.name || 'Element'} · report`;
  return info.type ? info.type.charAt(0).toUpperCase() + info.type.slice(1) : 'Widget';
}

/**
 * ELEMENT menu. `info.options` is the object's persisted `options` bag (already
 * normalized by the server); every write goes through `actions.setOptions`,
 * which merges the patch, re-renders the tile and schedules ONE save.
 */
export function elementMenuItems({ info, element, deleteLabel = 'Delete', actions } = {}) {
  const o = info?.options && typeof info.options === 'object' ? info.options : {};
  const set = (patch) => actions?.setOptions?.(patch);
  const hasIcon = !!o.icon;
  const hasLabel = !!o.label;
  const hasUrl = elementHasUrl(element);
  const hasHealth = elementHasHealthSource(element);
  const hasDocky = elementHasDockyTarget(element);

  return [
    { type: 'header', label: objectLabel(info || {}, element), hint: element?.url || '' },
    // ---- icon -------------------------------------------------------------
    { type: 'checkbox', label: 'Icon', checked: hasIcon, onChange: (v) => set({ icon: v }) },
    {
      type: 'range',
      label: 'Icon size',
      min: ICON_SIZE_MIN,
      max: ICON_SIZE_MAX,
      step: ICON_SIZE_STEP,
      value: clamp(normalizeIconSize(o.iconSize), ICON_SIZE_MIN, ICON_SIZE_MAX),
      unit: '%',
      disabled: !hasIcon,
      onChange: (v) => set({ iconSize: normalizeIconSize(v) }),
    },
    {
      type: 'checkbox',
      label: 'Allow icon overflow',
      checked: !!o.allowIconOverflow,
      disabled: !hasIcon,
      hint: hasIcon ? 'Let the icon spill outside the tile' : 'Enable “Icon” first',
      onChange: (v) => set({ allowIconOverflow: v }),
    },
    { type: 'separator' },
    // ---- label ------------------------------------------------------------
    { type: 'checkbox', label: 'Label', checked: hasLabel, onChange: (v) => set({ label: v }) },
    {
      type: 'submenu',
      label: 'Label position',
      disabled: !hasLabel,
      items: LABEL_POSITIONS.map((pos) => ({
        type: 'action',
        label: LABEL_POS_LABEL[pos] || pos,
        hint: pos === 'overlay' ? 'On top of the icon' : '',
        checked: (o.labelPosition || 'bottom') === pos,
        onSelect: () => set({ labelPosition: pos }),
      })),
    },
    { type: 'separator' },
    // ---- behaviour switches (same availability rules as the tile panel) ----
    {
      type: 'checkbox',
      label: 'Shortcut',
      checked: !!o.shortcut,
      disabled: !hasUrl,
      hint: hasUrl ? 'Main clickable zone opens the URL' : 'This element has no URL',
      onChange: (v) => set({ shortcut: v }),
    },
    {
      type: 'checkbox',
      label: 'Health',
      checked: !!o.health,
      disabled: !hasHealth,
      hint: hasHealth ? 'Status dot (URL probe or Docky)' : 'No health source on this element',
      onChange: (v) => set({ health: v }),
    },
    {
      type: 'checkbox',
      label: 'Monitoring',
      checked: !!o.monitoring,
      disabled: !hasDocky,
      hint: hasDocky ? 'CPU / RAM rows (Docky)' : 'No Docky target on this element',
      onChange: (v) => set({ monitoring: v }),
    },
    {
      type: 'checkbox',
      label: 'Controls',
      checked: !!o.controls,
      disabled: !hasDocky,
      hint: hasDocky ? 'Start / stop / restart (Docky)' : 'No Docky target on this element',
      onChange: (v) => set({ controls: v }),
    },
    { type: 'separator' },
    // ---- surface ----------------------------------------------------------
    {
      type: 'submenu',
      label: 'Surface',
      items: [
        {
          type: 'select',
          label: 'Shape',
          value: o.surfaceShape === 'square' ? 'square' : 'rounded',
          options: SURFACE_SHAPES.map((shape) => ({ value: shape, label: SURFACE_SHAPE_LABEL[shape] || shape })),
          onChange: (v) => set({ surfaceShape: v }),
        },
        {
          type: 'range',
          label: 'Opacity',
          min: SURFACE_OPACITY_MIN,
          max: SURFACE_OPACITY_MAX,
          step: 1,
          value: clamp(Number(o.surfaceOpacity ?? SURFACE_OPACITY_MAX) || 0, SURFACE_OPACITY_MIN, SURFACE_OPACITY_MAX),
          unit: '%',
          onChange: (v) => set({ surfaceOpacity: v }),
        },
        {
          type: 'color',
          label: 'Color',
          value: String(o.surfaceColor || ''),
          fallback: COLOR_FALLBACK,
          onChange: (v) => set({ surfaceColor: v }),
          onReset: () => set({ surfaceColor: '' }),
        },
      ],
    },
    { type: 'separator' },
    // ---- panels -----------------------------------------------------------
    { type: 'action', label: 'Settings…', hint: 'All tile options', onSelect: () => actions?.openOptions?.() },
    {
      type: 'action',
      label: 'Edit element…',
      hint: 'Catalogue',
      onSelect: () => {
        if (actions?.openElement) actions.openElement();
        else actions?.openOptions?.();
      },
    },
    { type: 'separator' },
    { type: 'action', label: deleteLabel, danger: true, onSelect: () => actions?.remove?.() },
  ];
}

/** WIDGET menu: the schema-driven settings modal + delete. */
export function widgetMenuItems({ info, element, deleteLabel = 'Delete', actions } = {}) {
  return [
    { type: 'header', label: objectLabel({ ...(info || {}), kind: 'widget' }, element) },
    { type: 'action', label: 'Settings…', hint: 'Widget options', onSelect: () => actions?.openSettings?.() },
    { type: 'separator' },
    { type: 'action', label: deleteLabel, danger: true, onSelect: () => actions?.remove?.() },
  ];
}

/** REPORT menu: a report carries no per-tile options — only its element does. */
export function reportMenuItems({ info, element, deleteLabel = 'Delete', actions } = {}) {
  return [
    { type: 'header', label: objectLabel({ ...(info || {}), kind: 'report' }, element) },
    { type: 'action', label: 'Edit element…', hint: 'Catalogue', onSelect: () => actions?.openElement?.() },
    { type: 'separator' },
    { type: 'action', label: deleteLabel, danger: true, onSelect: () => actions?.remove?.() },
  ];
}

/**
 * GROUP menu. `Title` writes live through `actions.setGroupConfig` (the same
 * debounced PATCH the floating bar uses); `Delete group + contents` is 2-STEP:
 * the first activation only arms it (label change + `actions` timer), exactly
 * like the bar's button.
 */
export function groupMenuItems({ group, actions } = {}) {
  const config = group?.config && typeof group.config === 'object' ? group.config : {};
  const title = String(config.title || '');
  return [
    { type: 'header', label: title || 'Group' },
    {
      type: 'text',
      label: 'Title',
      value: title,
      placeholder: 'Group name',
      onChange: (v) => actions?.setGroupConfig?.({ title: v }),
    },
    {
      type: 'submenu',
      label: 'Title visibility',
      items: TITLE_VISIBILITIES.map((vis) => ({
        type: 'action',
        label: vis.label,
        checked: (config.titleVisibility || 'always') === vis.value,
        onSelect: () => actions?.setGroupConfig?.({ titleVisibility: vis.value }),
      })),
    },
    { type: 'action', label: 'Appearance…', hint: 'Title + colors', onSelect: () => actions?.editGroup?.() },
    { type: 'separator' },
    { type: 'action', label: 'Ungroup', hint: 'Objects stay', onSelect: () => actions?.ungroup?.() },
    {
      type: 'action',
      label: 'Delete group + contents',
      danger: true,
      keepOpen: true, // the 2-step arm keeps the menu open for the confirmation
      onSelect: (ctx) => actions?.deleteGroupWithContents?.(ctx),
    },
  ];
}

/** EMPTY-CANVAS menu: the two creation entry points (same as the topbar). */
export function canvasMenuItems({ actions } = {}) {
  const items = [{ type: 'header', label: 'Canvas' }];
  if (typeof actions?.addElement === 'function') {
    items.push({ type: 'action', label: 'Add element…', onSelect: () => actions.addElement() });
  }
  if (typeof actions?.addReport === 'function') {
    items.push({ type: 'action', label: 'Add report…', onSelect: () => actions.addReport() });
  }
  return items;
}
