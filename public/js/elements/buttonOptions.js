import { el } from '../util.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { normalizeButton, minSizeForVariant, ICON_SIZES, buildIconNode } from './button.js';
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
 *   - `health` / `monitoring` / `controls` need a Docky target on the element
 *     (`element.docky.{agent,container}`); without one they are disabled with
 *     an explanation (Docky itself is lot 5).
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
    needs: 'docky',
    help: 'Status dot (delegated to Docky).',
    disabledHelp: 'No Docky target on this element.',
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

const hasDockyTarget = (element) => !!(element?.docky && (element.docky.agent || element.docky.container));

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

    // Icon appearance.
    body.appendChild(buildIconGroup());

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
    const disabled = sw.needs === 'url' ? !hasUrl() : sw.needs === 'docky' ? !hasDockyTarget(currentElement) : false;
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

  function buildIconGroup() {
    const iconOn = !!work.options.icon;
    const group = el('div', 'opt-group');
    group.appendChild(el('div', 'opt-group-title', 'Icon size'));

    const row = el('div', 'segmented');
    for (const size of ICON_SIZES) {
      const active = work.options.iconSize === size;
      const b = el('button', 'segmented-item' + (active ? ' active' : ''), size, { type: 'button' });
      b.disabled = !iconOn;
      b.title = iconOn ? `${size} icon` : 'Enable “Icon” to change its size';
      b.addEventListener('click', () => {
        work.options.iconSize = size;
        onUpdate?.(normalizeButton(work));
        paint();
      });
      row.appendChild(b);
    }
    group.appendChild(row);

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
