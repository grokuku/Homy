import { el, isValidHttpUrl } from '../util.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import {
  normalizeButton,
  minSizeForVariant,
  normalizeIconSize,
  normalizeSurfaceColor,
  ICON_SIZE_MIN,
  ICON_SIZE_MAX,
  ICON_SIZE_STEP,
  ICON_SIZE_PRESETS,
  LABEL_POSITIONS,
  SURFACE_OPACITY_MIN,
  SURFACE_OPACITY_MAX,
  SURFACE_SHAPES,
  buildIconNode,
} from './button.js';
import { toast } from '../ui/toast.js';
import { openElementPicker } from './elementPicker.js';

/**
 * Button options panel (LOT 4, priority 2) — a compact HolafModal to edit ONE
 * tile's display switches, tile size, icon size and overflow option, change
 * its referenced element, or delete it.
 *
 * SIZE MINIMUM RULE (roadmap §A.7, validated): `minSizeForVariant(options)`
 * (already exported by elements/button.js) is CONSUMED here so the UI can
 * never produce a combination smaller than its minimum:
 *   - enabling an option that needs a bigger footprint GROWS the tile to its
 *     minimum automatically (with an explanatory toast);
 *   - size buttons below the current minimum are DISABLED with a tooltip.
 *
 * OPTION AVAILABILITY (degraded tolerance):
 *   - `shortcut` needs the element to have an `url` (otherwise it is disabled);
 *   - `health` needs a HEALTH SOURCE on the element — a custom `healthUrl` (with
 *     `healthCheck:true`) OR a Docky target (with `healthCheck:true`); without a
 *     source it is disabled with an explanation;
 *   - `monitoring` / `controls` need a Docky target on the element
 *     (`element.docky.{agent,container}`); without one they are disabled with
 *     an explanation (a custom health URL does NOT enable them).
 *
 * Every change is applied LIVE through `onUpdate(button)` (the group re-renders
 * the tile immediately and debounces the persistence); the panel stays open so
 * the user can toggle several switches in a row. `onDelete()` removes the tile.
 *
 * Sizes are expressed in GLOBAL units (1×1 / 2×1 / 1×2 / 2×2) but persisted in
 * INTERNAL cells (2×2 / 4×2 / 2×4 / 4×4) — a "1×1" button unit = 2×2 internal
 * cells (§B).
 */

const SIZE_STEPS = [
  { key: '1x1', label: '1×1', w: 2, h: 2 },
  { key: '2x1', label: '2×1', w: 4, h: 2 },
  { key: '1x2', label: '1×2', w: 2, h: 4 },
  { key: '2x2', label: '2×2', w: 4, h: 4 },
];

const SWITCHES = [
  { key: 'icon', label: 'Icon', help: 'Show the element icon.' },
  { key: 'label', label: 'Label', help: 'Show the element name.' },
  {
    key: 'shortcut',
    label: 'Shortcut',
    needs: 'url',
    help: 'Main clickable zone — opens the element URL.',
    disabledHelp: 'This element has no URL.',
  },
  {
    key: 'health',
    label: 'Health',
    needs: 'health',
    help: 'Status dot (custom URL probe or Docky).',
    disabledHelp: 'No health source on this element.',
  },
  {
    key: 'monitoring',
    label: 'Monitoring',
    needs: 'docky',
    help: 'CPU / RAM rows (delegated to Docky).',
    disabledHelp: 'No Docky target on this element.',
  },
  {
    key: 'controls',
    label: 'Controls',
    needs: 'docky',
    help: 'Start / stop / restart zone (Docky).',
    disabledHelp: 'No Docky target on this element.',
  },
];

const CONFIRM_MS = 3000; // 2-step delete: window before the arm reverts

// Human labels for the 4 label-position crans.
const LABEL_POS_LABEL = { bottom: 'Bottom', top: 'Top', left: 'Left', right: 'Right' };

// Human labels for the 2 surface shapes.
const SURFACE_SHAPE_LABEL = { rounded: 'Rounded', square: 'Square' };

// Swatch shown by the colour input while the surface uses the theme default
// (an <input type=color> cannot display "empty").
const SURFACE_SWATCH_FALLBACK = '#3a4150';

/** Pretty icon-size percentage (drops a trailing « .0 »). */
const fmtIconSize = (n) => String(Math.round(Number(n) * 10) / 10);

const hasDockyTarget = (element) => !!(element?.docky && (element.docky.agent || element.docky.container));

/**
 * True when the element has a usable health-pill source: `healthCheck` on AND
 * (a valid custom `healthUrl` OR a Docky target). Mirrors the server-side
 * `resolveHealthSource` contract — a Docky target alone (healthCheck off) or an
 * URL alone (healthCheck off) is NOT a source.
 */
const hasHealthSource = (element) => {
  if (element?.healthCheck !== true) return false;
  if (isValidHttpUrl(String(element?.healthUrl || '').trim())) return true;
  return hasDockyTarget(element);
};

/**
 * Open the options panel for one tile. Returns the HolafModal controller.
 *
 * @param {object}   opts
 * @param {object}   opts.button      current button (col/row/w/h/options)
 * @param {object}   opts.element     referenced catalogue element (or null)
 * @param {number}   opts.maxW        max tile width in INTERNAL cells (group)
 * @param {number}   opts.maxH        max tile height in INTERNAL cells (group)
 * @param {Function} opts.onUpdate    applied live with a fresh normalized button
 * @param {Function} opts.onDelete    removes the tile
 */
export function openButtonOptions({ button, element, maxW = 4, maxH = 4, onUpdate, onDelete } = {}) {
  if (document.getElementById('button-options-modal')) return;

  const work = normalizeButton(button);
  let currentElement = element || null;

  const body = el('div', 'opt-panel');
  const content = el('div', 'opt-panel-body');
  content.appendChild(body);

  let ctrl = null;
  let confirmTimer = 0;
  let armed = false;

  // ---- commit helpers --------------------------------------------------------

  const hasUrl = () => !!String(currentElement?.url || '').trim();

  /** Apply the working copy live, enforcing the variant minimum footprint. */
  function commit() {
    const { min } = minSizeForVariant(work.options);
    if (work.w < min.w || work.h < min.h) {
      work.w = Math.max(work.w, min.w);
      work.h = Math.max(work.h, min.h);
      toast(`Tile resized to ${work.w / 2}×${work.h / 2} to fit these options`, 'info');
    }
    // Never exceed the group (or the server's 4-cell cap).
    work.w = Math.min(work.w, Math.max(2, Math.min(4, maxW)));
    work.h = Math.min(work.h, Math.max(2, Math.min(4, maxH)));
    onUpdate?.(normalizeButton(work));
  }

  // ---- painting --------------------------------------------------------------

  function paint() {
    body.replaceChildren();

    // The referenced element (identity), with a change shortcut.
    body.appendChild(buildElementHeader());

    // 6 display switches.
    const switches = el('div', 'opt-group');
    switches.appendChild(el('div', 'opt-group-title', 'Display'));
    for (const sw of SWITCHES) switches.appendChild(buildSwitch(sw));
    body.appendChild(switches);

    // Tile size (minimum-aware).
    body.appendChild(buildSizeGroup());

    // Label placement (only meaningful when the label is shown).
    body.appendChild(buildLabelPositionGroup());

    // Icon appearance.
    body.appendChild(buildIconGroup());

    // Surface (background box) — opacity / inset / shape / colour.
    body.appendChild(buildSurfaceGroup());

    // Danger zone.
    body.appendChild(buildDanger());
  }

  function buildElementHeader() {
    const wrap = el('div', 'opt-element');
    const iconBox = el('div', 'opt-element-icon');
    iconBox.appendChild(buildIconNode(currentElement?.icon || '', currentElement?.name || ''));
    const main = el('div', 'opt-element-main');
    main.appendChild(
      el('div', 'opt-element-name', currentElement?.name || (work.elementId ? 'Unknown element' : 'No element'))
    );
    if (currentElement?.url) main.appendChild(el('div', 'opt-element-url muted', currentElement.url));
    const choose = el('button', 'btn', 'Choose element', { type: 'button', title: 'Change the referenced element' });
    choose.addEventListener('click', () => {
      openElementPicker({
        title: 'Choose element',
        onPick: (picked) => {
          currentElement = picked;
          work.elementId = picked.id;
          commit();
          paint();
        },
      });
    });
    wrap.append(iconBox, main, choose);
    return wrap;
  }

  function buildSwitch(sw) {
    const disabled =
      sw.needs === 'url'
        ? !hasUrl()
        : sw.needs === 'docky'
          ? !hasDockyTarget(currentElement)
          : sw.needs === 'health'
            ? !hasHealthSource(currentElement)
            : false;
    const row = el('label', 'opt-switch' + (disabled ? ' disabled' : ''));

    const cb = el('input', null, null, { type: 'checkbox' });
    cb.checked = disabled ? false : !!work.options[sw.key];
    cb.disabled = disabled;
    if (disabled && work.options[sw.key]) work.options[sw.key] = false;
    cb.addEventListener('change', () => {
      work.options[sw.key] = cb.checked;
      commit();
      paint();
    });

    const text = el('span', 'opt-switch-main');
    text.appendChild(el('span', 'opt-switch-label', sw.label));
    const help = disabled ? sw.disabledHelp : sw.help;
    if (help) text.appendChild(el('small', 'opt-switch-help', help));
    if (disabled) {
      row.title = sw.disabledHelp || 'Unavailable';
      text.title = sw.disabledHelp || 'Unavailable';
    }

    row.append(cb, text);
    return row;
  }

  function buildSizeGroup() {
    const { min } = minSizeForVariant(work.options);
    const group = el('div', 'opt-group');
    const head = el('div', 'opt-group-title');
    head.appendChild(el('span', null, 'Tile size'));
    head.appendChild(el('span', 'opt-min-hint muted', `min ${min.w / 2}×${min.h / 2}`));
    group.appendChild(head);

    const row = el('div', 'segmented');
    for (const s of SIZE_STEPS) {
      const tooSmall = s.w < min.w || s.h < min.h;
      const tooBig = s.w > Math.min(4, maxW) || s.h > Math.min(4, maxH);
      const active = work.w === s.w && work.h === s.h;
      const b = el('button', 'segmented-item' + (active ? ' active' : ''), s.label, { type: 'button' });
      b.disabled = tooSmall || tooBig;
      b.title = tooSmall
        ? `Below the minimum for these options (min ${min.w / 2}×${min.h / 2})`
        : tooBig
          ? 'Larger than the group'
          : `Resize to ${s.label}`;
      b.addEventListener('click', () => {
        work.w = s.w;
        work.h = s.h;
        onUpdate?.(normalizeButton(work));
        paint();
      });
      row.appendChild(b);
    }
    group.appendChild(row);
    return group;
  }

  function buildLabelPositionGroup() {
    const labelOn = !!work.options.label;
    const group = el('div', 'opt-group');
    group.appendChild(el('div', 'opt-group-title', 'Label position'));

    const row = el('div', 'segmented');
    for (const pos of LABEL_POSITIONS) {
      const active = work.options.labelPosition === pos;
      const b = el('button', 'segmented-item' + (active ? ' active' : ''), LABEL_POS_LABEL[pos], {
        type: 'button',
      });
      b.disabled = !labelOn;
      b.title = labelOn ? `Place the label ${pos} of the icon` : 'Enable “Label” to change its position';
      b.addEventListener('click', () => {
        work.options.labelPosition = pos;
        onUpdate?.(normalizeButton(work));
        paint();
      });
      row.appendChild(b);
    }
    group.appendChild(row);
    return group;
  }

  function buildIconGroup() {
    const iconOn = !!work.options.icon;
    const group = el('div', 'opt-group');
    group.appendChild(el('div', 'opt-group-title', 'Icon size'));

    // Fine control: a 0.5-step slider over a PERCENTAGE (8..120) of the tile's
    // useful internal dimension. The panel working copy uses the normalized
    // value so a legacy letter (M) shows as 55.
    const row = el('div', 'icon-size-row');
    const slider = el('input', 'icon-size-slider', null, {
      type: 'range',
      min: String(ICON_SIZE_MIN),
      max: String(ICON_SIZE_MAX),
      step: String(ICON_SIZE_STEP),
      'aria-label': 'Icon size (percent of the tile)',
    });
    slider.value = String(normalizeIconSize(work.options.iconSize));
    const valueEl = el('span', 'icon-size-value', `${fmtIconSize(slider.value)}%`);
    slider.disabled = !iconOn;
    slider.addEventListener('input', () => {
      work.options.iconSize = normalizeIconSize(slider.value);
      valueEl.textContent = `${fmtIconSize(work.options.iconSize)}%`;
      onUpdate?.(normalizeButton(work));
    });
    row.append(slider, valueEl);
    group.appendChild(row);

    // Quick presets — the legacy S/M/L/XL/Fill crans, which pose the value.
    const row2 = el('div', 'segmented');
    for (const [key, value] of Object.entries(ICON_SIZE_PRESETS)) {
      const active = normalizeIconSize(work.options.iconSize) === value;
      const b = el('button', 'segmented-item' + (active ? ' active' : ''), key, { type: 'button' });
      b.disabled = !iconOn;
      b.title = iconOn ? `${key} — ${value}%` : 'Enable “Icon” to change its size';
      b.addEventListener('click', () => {
        work.options.iconSize = value;
        onUpdate?.(normalizeButton(work));
        paint();
      });
      row2.appendChild(b);
    }
    group.appendChild(row2);

    // Icon colour + a « Theme » reset (clears the explicit colour). Applies
    // LIVE and only affects monochrome / currentColor glyphs (multicolour or
    // raster icons keep their own colours).
    const colorRow = el('div', 'icon-size-row');
    colorRow.appendChild(el('span', 'opt-switch-label', 'Icon color'));
    const color = el('input', 'opt-surface-color', null, {
      type: 'color',
      'aria-label': 'Icon color',
      title: 'Icon color (monochrome icons only)',
    });
    color.value = work.options.iconColor || SURFACE_SWATCH_FALLBACK;
    color.disabled = !iconOn;
    color.addEventListener('input', () => {
      work.options.iconColor = normalizeSurfaceColor(color.value);
      onUpdate?.(normalizeButton(work));
    });
    const theme = el('button', 'btn', 'Theme', {
      type: 'button',
      title: 'Use the theme default icon color',
    });
    theme.disabled = !iconOn;
    theme.addEventListener('click', () => {
      work.options.iconColor = '';
      onUpdate?.(normalizeButton(work));
      paint();
    });
    colorRow.append(color, theme);
    group.appendChild(colorRow);

    // Advanced: allow the icon to overflow its tile (default OFF).
    const overflow = el('label', 'opt-switch' + (iconOn ? '' : ' disabled'));
    const cb = el('input', null, null, { type: 'checkbox' });
    cb.checked = iconOn ? !!work.options.allowIconOverflow : false;
    cb.disabled = !iconOn;
    cb.addEventListener('change', () => {
      work.options.allowIconOverflow = cb.checked;
      onUpdate?.(normalizeButton(work));
    });
    const text = el('span', 'opt-switch-main');
    text.appendChild(el('span', 'opt-switch-label', 'Allow icon overflow'));
    text.appendChild(el('small', 'opt-switch-help', 'Let the icon spill outside the tile instead of clipping.'));
    if (!iconOn) overflow.title = 'Enable “Icon” first';
    overflow.append(cb, text);
    group.appendChild(overflow);
    return group;
  }

  /**
   * A labelled range row for one surface option, applied LIVE. Reads/writes
   * the panel's working copy so the tile re-renders immediately; the value
   * badge always shows the current cran.
   */
  function buildRangeRow({ label, key, min, max, step, unit }) {
    const row = el('div', 'icon-size-row');
    row.appendChild(el('span', 'opt-switch-label', label));
    const slider = el('input', 'icon-size-slider', null, {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      'aria-label': label,
    });
    slider.value = String(work.options[key]);
    const valueEl = el('span', 'icon-size-value', `${work.options[key]}${unit}`);
    slider.addEventListener('input', () => {
      work.options[key] = Number(slider.value);
      valueEl.textContent = `${work.options[key]}${unit}`;
      onUpdate?.(normalizeButton(work));
    });
    row.append(slider, valueEl);
    return row;
  }

  /**
   * PER-TILE SURFACE group: background colour (+ « Theme » reset), opacity and
   * shape (rounded | square). Every control applies LIVE through onUpdate,
   * exactly like the other option controls. The tile INSET is no longer a
   * per-tile option — it is a GROUP-level setting (config.tileInset) rendered
   * by the group's own config modal.
   */
  function buildSurfaceGroup() {
    const o = work.options;
    const group = el('div', 'opt-group');
    group.appendChild(el('div', 'opt-group-title', 'Surface'));

    // Background colour + a « Theme » reset (clears the explicit colour).
    const colorRow = el('div', 'icon-size-row');
    colorRow.appendChild(el('span', 'opt-switch-label', 'Color'));
    const color = el('input', 'opt-surface-color', null, {
      type: 'color',
      'aria-label': 'Surface color',
      title: 'Tile background color',
    });
    color.value = o.surfaceColor || SURFACE_SWATCH_FALLBACK;
    color.addEventListener('input', () => {
      o.surfaceColor = normalizeSurfaceColor(color.value);
      onUpdate?.(normalizeButton(work));
    });
    const theme = el('button', 'btn', 'Theme', {
      type: 'button',
      title: 'Use the theme default background color',
    });
    theme.addEventListener('click', () => {
      o.surfaceColor = '';
      onUpdate?.(normalizeButton(work));
      paint();
    });
    colorRow.append(color, theme);
    group.appendChild(colorRow);

    group.appendChild(
      buildRangeRow({
        label: 'Opacity',
        key: 'surfaceOpacity',
        min: SURFACE_OPACITY_MIN,
        max: SURFACE_OPACITY_MAX,
        step: 1,
        unit: '%',
      })
    );

    const shapeRow = el('div', 'segmented');
    for (const shape of SURFACE_SHAPES) {
      const active = o.surfaceShape === shape;
      const b = el('button', 'segmented-item' + (active ? ' active' : ''), SURFACE_SHAPE_LABEL[shape] || shape, {
        type: 'button',
        title: shape === 'square' ? 'Square corners (no rounding)' : 'Rounded corners',
      });
      b.addEventListener('click', () => {
        o.surfaceShape = shape;
        onUpdate?.(normalizeButton(work));
        paint();
      });
      shapeRow.appendChild(b);
    }
    group.appendChild(shapeRow);
    return group;
  }

  function buildDanger() {
    const wrap = el('div', 'opt-danger');
    const del = el('button', 'btn btn-danger', 'Delete tile', { type: 'button', title: 'Remove this tile' });
    del.addEventListener('click', () => {
      if (armed) {
        clearTimeout(confirmTimer);
        armed = false;
        ctrl?.close();
        onDelete?.();
        return;
      }
      armed = true;
      del.textContent = 'Confirm delete?';
      del.classList.add('confirm');
      confirmTimer = setTimeout(() => {
        armed = false;
        del.textContent = 'Delete tile';
        del.classList.remove('confirm');
      }, CONFIRM_MS);
    });
    wrap.appendChild(del);
    return wrap;
  }

  paint();

  ctrl = HolafModal.open({
    id: 'button-options-modal',
    title: currentElement?.name ? `Tile: ${currentElement.name}` : 'Tile options',
    size: 'md',
    content,
    onClose: () => {
      if (confirmTimer) clearTimeout(confirmTimer);
    },
    actions: [{ label: 'Done', type: 'primary' }],
  });
  return ctrl;
}
