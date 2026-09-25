import { el, uuid } from '../util.js';
import { catalog } from './catalog.js';
import {
  normalizeButton,
  renderButtonTile,
  applyTileMetrics,
  minSizeForVariant,
  normalizeSurfaceColor,
  SURFACE_OPACITY_MIN,
  SURFACE_OPACITY_MAX,
  SURFACE_SHAPES,
} from './button.js';
import {
  renderReportTile,
  applyReportMetrics,
  normalizeReport,
  REPORT_CELLS_MIN,
  REPORT_CELLS_MAX,
} from './reportTile.js';
import { openElementPicker } from './elementPicker.js';
import { openButtonOptions } from './buttonOptions.js';
import { toast } from '../ui/toast.js';
import { api } from '../api.js';

/**
 * Group widget (LOT 2 container + LOT 4 in-trame tile editing).
 *
 * A `group` (layout v4) is a titled container whose `buttons[]` are button
 * tiles referencing catalogue elements. It renders:
 *   - an optional floating TITLE chip (config.title), an absolute overlay that
 *     reserves ZERO space (row 0 of the trame is flush with the top edge); its
 *     visibility is governed by config.titleVisibility (always | hover | never);
 *   - in EDIT mode, a separate « + Add element » / « + Add report » action bar
 *     that stays available whatever the title visibility is;
 *   - the INTERNAL TRAME (a grid 2× finer than the global grid: one internal
 *     cell = half a global cell), drawn with repeating gradients at the exact
 *     step so the lines line up with the tiles;
 *   - its tiles, positioned at their stored col/row/w/h INTERNAL cells;
 *   - an internal SCROLL when the content is larger than the group.
 *
 * CONSTANT PHYSICAL SIZE: the internal step is derived from the GLOBAL grid
 * cell (gridContainer.clientWidth / 32 columns) divided by 2 — NOT from the
 * group's own size. Resizing the group (in global cells) therefore never
 * rescales or reflows its content; a group smaller than its content simply
 * scrolls. On a 1440 px canvas this gives a 45 px global cell and a 22.5 px
 * internal step (45 px minimum tile = 2×2 internal).
 *
 * LOT 4 EDITION (only when the widget is rendered with `context.editable`):
 *   - « + Add element » → element picker → poses a new button with default
 *     options and a variant-minimum size at the first free internal slot;
 *   - each tile exposes ⚙ (options panel), a 2-step ✕ (delete), an in-trame
 *     MOVE (snap to the internal cell, no overlap, col clamped to the group)
 *     and a RESIZE handle (steps of 2 internal cells, bounded by the variant
 *     minimum and the group size, no overlap);
 *   - every mutation is broadcast as `homy:group-buttons` so the editor keeps
 *     its meta cache fresh and debounces the PUT /api/layout persistence — the
 *     SAME save path as a widget drag, including the mode-change flush.
 *
 * The `group` type is a KNOWN layout item type server-side and is registered in
 * the widget registry on BOTH sides (see widgets/registry.js and
 * server/routes/widgets.routes.js) with the same defaultSize/settingsSchema.
 */

// MUST mirror GRID_COLUMNS in public/js/grid/config.js (kept as a local literal
// to avoid an import cycle registry → group → config → registry).
const GLOBAL_COLUMNS = 32;
const DEFAULT_STEP = 22.5; // px — 1440px canvas: 45px global cell / 2
const MAX_TILE_CELLS = 4; // server-side per-button cap (internal cells)
const DEFAULT_REPORT_SIZE = { w: 8, h: 6 }; // internal cells (free size)
const TILE_DELETE_CONFIRM_MS = 3000;
// Per-group ZOOM: a UNIFORM scale factor applied to the whole group content by
// multiplying the base `--group-step`. Because the SAME effective step drives
// both grid axes (grid-template-columns AND grid-auto-rows) and the tiles span
// integer multiples of it, scaling keeps every tile perfectly SQUARE. Range and
// step MUST stay in sync with normalizeGroupZoom() server-side
// (server/services/layout.service.js) and the `zoom` settingsSchema field.
const GROUP_ZOOM_MIN = 0.5;
const GROUP_ZOOM_MAX = 3;
const GROUP_ZOOM_DEFAULT = 1;
const GROUP_ZOOM_STEP = 0.05;
// Ctrl+drag sensitivity: how many px of (horizontal) travel change the zoom by
// 1.0. 200px ≈ the full 0.5→3 sweep, fine enough for a live, precise feel.
const GROUP_ZOOM_PX_PER_UNIT = 200;
// Per-group TILE INSET (px): the ONE regular gap kept around EVERY tile of the
// group, promoted from the former per-tile `surfaceInset` option so the whole
// trame spacing is homogeneous. The frame↔tile gap equals this value; two
// ADJACENT tiles (each carrying the margin) therefore get 2× it. Computed ONCE
// per group and published through the inherited CSS var `--group-tile-inset`
// (see style.css); a tile's residual `surfaceInset` option is ignored. Range /
// default MUST stay in sync with TILE_INSET_* in server/services/layout.service.js
// and the `tileInset` settingsSchema field (server/routes/widgets.routes.js —
// enforced by scripts/check-schema-sync.mjs).
const TILE_INSET_MIN = 0;
const TILE_INSET_MAX = 8;
const TILE_INSET_DEFAULT = 4;
const ADD_DEFAULT_OPTIONS = {
  icon: true,
  label: true,
  shortcut: true,
  health: false,
  monitoring: false,
  controls: false,
  iconSize: 55,
  labelPosition: 'bottom',
  allowIconOverflow: false,
  surfaceOpacity: 100,
  surfaceShape: 'rounded',
  surfaceColor: '',
  // '' = inherited / theme default icon colour.
  iconColor: '',
};

// Human labels / swatch fallback for the multi-selection surface bar.
const SURFACE_SHAPE_LABEL = { rounded: 'Rounded', square: 'Square' };
const SURFACE_SWATCH_FALLBACK = '#3a4150';

export const group = {
  name: 'Group',
  icon: '▦',
  category: 'generic',
  defaultSize: { w: 8, h: 6 }, // 8×6 global cells (≥ the 2×2 minimum)
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Group title' },
      {
        key: 'titleVisibility',
        label: 'Title visibility',
        type: 'select',
        default: 'always',
        options: [
          { value: 'always', label: 'Always' },
          { value: 'hover', label: 'On hover' },
          { value: 'never', label: 'Never' },
        ],
        help: 'Always shows the title chip, reveals it on hover, or hides it entirely.',
      },
      {
        key: 'zoom',
        label: 'Zoom',
        type: 'range',
        default: 1,
        min: 0.5,
        max: 3,
        step: 0.05,
        unit: '\u00d7',
        help: 'Uniform scale of the group content (tiles + grid), keeping tiles square. Also adjustable with Ctrl+drag on the group in edit mode; Ctrl+double-click resets to 1.',
      },
      {
        key: 'tileInset',
        label: 'Tile inset',
        type: 'range',
        default: 4,
        min: 0,
        max: 8,
        step: 1,
        unit: 'px',
        help: 'Regular gap kept around every tile inside the frame (frame-to-tile spacing and between adjacent tiles). Applied to all tiles of the group.',
      },
    ],
  },

  render(container, config, item, context = {}) {
    container.classList.add('group-widget');
    const editable = !!context?.editable;
    // The internal trame (½-global-cell guides) is an EDIT-ONLY affordance: it
    // is drawn only while `editable`, so VIEW mode shows the tiles alone. The
    // class is the single hook (see .group-widget.group-editing in style.css).
    container.classList.toggle('group-editing', editable);

    const title = (config?.title || '').trim();
    // Title chip visibility: always | hover | never (unknown → always).
    // Published as a data attribute so style.css owns the show/hide rule
    // (including « hover reveals, EDIT always shows »). In `never` the chip is
    // NOT rendered at all, so no title can appear in VIEW as well as EDIT.
    const titleVisibility = normalizeTitleVisibility(config?.titleVisibility);
    container.dataset.titleVisibility = titleVisibility;

    // ---- per-group TILE INSET -----------------------------------------------
    // ONE value shared by every tile, published through the inherited CSS var
    // consumed by `.group-tile` (margin, see style.css). The former PER-TILE
    // `surfaceInset` option is no longer applied (a residual value on a stored
    // button is tolerated and ignored — the group value always wins).
    const tileInset = normalizeTileInset(config?.tileInset);
    container.style.setProperty('--group-tile-inset', `${tileInset}px`);
    const applyButtonMetrics = (tile, button, stepPx) => applyTileMetrics(tile, button, stepPx, tileInset);

    // ---- floating TITLE chip (overlay, pointer-events:none) ----------------
    // The chip reserves NO space: it is absolutely positioned and `.group-board`
    // fills the WHOLE interior (no padding), so row 0 of the internal trame
    // starts exactly at the top edge of the group (tile.top == board.top),
    // whether or not the title is shown. The chip is translucent + blurred so
    // whatever it overlaps remains perceptible; only its buttons (if any) are
    // interactive.
    if (title && titleVisibility !== 'never') {
      const header = el('div', 'widget-header');
      header.appendChild(el('span', 'widget-title', title));
      container.appendChild(header);
    }

    // ---- edit-only actions (NOT the title chip) ----------------------------
    // « + Add element » / « + Add report » stay reachable whatever
    // titleVisibility is (including `never`), so a group can always be filled
    // from the editor. They live in their own floating bar, clear of the chip.
    if (editable) {
      const actions = el('div', 'group-actions');
      const addBtn = el('button', 'group-add', '+ Add element', {
        type: 'button',
        title: 'Add an element to this group',
      });
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addElement();
      });
      const addReportBtn = el('button', 'group-add group-add-report', '+ Add report', {
        type: 'button',
        title: 'Add a report tile (element with Special reporting)',
      });
      addReportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        addReport();
      });
      actions.append(addBtn, addReportBtn);
      container.appendChild(actions);
    }

    const board = el('div', 'group-board');
    const canvas = el('div', 'group-grid');
    board.appendChild(canvas);
    container.appendChild(board);

    const buttons = (Array.isArray(item?.buttons) ? item.buttons : [])
      .map(normalizeButton)
      .filter((b) => b.elementId);
    const reports = (Array.isArray(item?.reports) ? item.reports : [])
      .map(normalizeReport)
      .filter((r) => r.elementId);
    const allTiles = () => [...buttons, ...reports];

    // Group dimensions in INTERNAL cells (a global cell = 2 internal cells).
    const groupCols = Math.max(2, (Number(item?.w) || 1) * 2);
    const groupRows = Math.max(2, (Number(item?.h) || 1) * 2);

    // ZOOM: uniform content scale, persisted in config.zoom (default 1).
    // `baseStep` is the raw half-global-cell unit; `step` is the EFFECTIVE
    // (baseStep × zoom) value that drives the trame AND the tiles — so a
    // single factor scales everything together, keeping tiles square.
    let zoom = normalizeGroupZoom(config?.zoom);
    let baseStep = DEFAULT_STEP;
    let step = DEFAULT_STEP;
    let raf = 0;
    let dragCleanup = null; // active tile move/resize teardown (destroyed mid-drag)
    let zoomCleanup = null; // active Ctrl+drag zoom teardown (destroyed mid-drag)
    let zoomBadge = null; // transient « 1.25× » readout shown while adjusting
    let resetHintTimer = 0; // brief « reset » flash after a reset gesture
    const deleteTimers = new Set(); // armed ✕ confirm timers (cleared on re-render/destroy)
    const tileDisposers = new Set(); // report-tile refresh cleanups (no timer leaks)

    // ---- multi-selection (edit mode) -----------------------------------------
    // `selected` holds button IDS; `tileEls` maps id → live tile element so a
    // surface change can be applied IN PLACE (no full re-render) while dragging
    // a slider. `selectionBar` is the floating group edit panel (body-appended
    // so a group's `overflow: hidden` never clips it).
    const selected = new Set();
    const tileEls = new Map();
    let selectionBar = null;
    let selectionKeyHandler = null;

    const clearDeleteTimers = () => {
      for (const t of deleteTimers) clearTimeout(t);
      deleteTimers.clear();
    };

    const disposeTiles = () => {
      for (const dispose of tileDisposers) {
        try {
          dispose();
        } catch (err) {
          console.error('[group] tile dispose failed:', err);
        }
      }
      tileDisposers.clear();
    };

    // ---- tile rendering -------------------------------------------------------

    const renderTiles = () => {
      clearDeleteTimers();
      disposeTiles();
      canvas.replaceChildren();
      tileEls.clear();
      for (const button of buttons) {
        const element = catalog.get(button.elementId);
        const { el: tile, dispose } = renderButtonTile({ button, element, step, inset: tileInset });
        tileDisposers.add(dispose);
        tileEls.set(button.id, tile);
        if (editable) decorateTile(tile, button);
        canvas.appendChild(tile);
      }
      for (const report of reports) {
        const element = catalog.get(report.elementId);
        const { el: tile, dispose } = renderReportTile({ report, element, step });
        tileDisposers.add(dispose);
        if (editable) decorateReportTile(tile, report);
        canvas.appendChild(tile);
      }
      syncSelection();
    };

    // ---- persistence ----------------------------------------------------------

    // The group does not own the save path: it publishes its fresh tiles and
    // the editor (which holds the item meta) debounces the PUT /api/layout.
    function persist() {
      window.dispatchEvent(
        new CustomEvent('homy:group-buttons', { detail: { id: item.id, buttons } })
      );
      window.dispatchEvent(
        new CustomEvent('homy:group-reports', { detail: { id: item.id, reports } })
      );
    }

    // ---- add / remove ---------------------------------------------------------

    function nextSlot(list, w, h, exclude = null) {
      const maxCol = Math.max(0, groupCols - w);
      for (let row = 0; row < 500; row += 2) {
        for (let col = 0; col <= maxCol; col += 2) {
          if (!overlaps(list, exclude, col, row, w, h)) return { col, row };
        }
      }
      return { col: 0, row: 0 };
    }

    function addElement() {
      openElementPicker({
        title: 'Add element',
        onPick: (element) => {
          if (!element?.id) return;
          const { min } = minSizeForVariant(ADD_DEFAULT_OPTIONS);
          const slot = nextSlot(allTiles(), min.w, min.h);
          buttons.push(
            normalizeButton({
              id: uuid(),
              elementId: element.id,
              col: slot.col,
              row: slot.row,
              w: min.w,
              h: min.h,
              options: { ...ADD_DEFAULT_OPTIONS },
            })
          );
          renderTiles();
          persist();
          toast(`“${element.name}” added`, 'success');
        },
      });
    }

    function addReport() {
      openElementPicker({
        title: 'Add report',
        emptyText: 'No element has a report configured yet — edit an element and enable “Special reporting”.',
        filter: (element) => !!(element?.report && element.report.type),
        onPick: (element) => {
          if (!element?.id) return;
          const w = Math.min(REPORT_CELLS_MAX, Math.min(DEFAULT_REPORT_SIZE.w, groupCols));
          const h = Math.min(REPORT_CELLS_MAX, Math.min(DEFAULT_REPORT_SIZE.h, groupRows));
          const slot = nextSlot(allTiles(), w, h);
          reports.push(
            normalizeReport({ id: uuid(), elementId: element.id, col: slot.col, row: slot.row, w, h })
          );
          renderTiles();
          persist();
          toast(`Report “${element.name}” added`, 'success');
        },
      });
    }

    function removeButton(button) {
      const index = buttons.indexOf(button);
      if (index >= 0) buttons.splice(index, 1);
      selected.delete(button.id);
      renderTiles();
      persist();
      toast('Tile removed', 'success');
    }

    function removeReport(report) {
      const index = reports.indexOf(report);
      if (index >= 0) reports.splice(index, 1);
      renderTiles();
      persist();
      toast('Report tile removed', 'success');
    }

    function openOptions(button) {
      openButtonOptions({
        button,
        element: catalog.get(button.elementId),
        maxW: Math.min(MAX_TILE_CELLS, groupCols),
        maxH: Math.min(MAX_TILE_CELLS, groupRows),
        onUpdate: (updated) => {
          // In-place mutation: the panel keeps its own working copy, the group
          // keeps the array identity (so open panels/closures stay valid).
          button.elementId = updated.elementId;
          button.w = updated.w;
          button.h = updated.h;
          button.options = updated.options;
          // The panel may have GROWN the tile to its variant minimum (e.g. a
          // 1×1 that just enabled `monitoring`): if the grown footprint would
          // collide with a neighbour, relocate to the nearest free slot so the
          // « no overlap » invariant always holds.
          if (overlaps(allTiles(), button, updated.col, updated.row, button.w, button.h)) {
            const slot = nextSlot(allTiles(), button.w, button.h, button);
            button.col = slot.col;
            button.row = slot.row;
          } else {
            button.col = updated.col;
            button.row = updated.row;
          }
          renderTiles();
          persist();
        },
        onDelete: () => removeButton(button),
      });
    }

    // ---- in-trame editing affordances ----------------------------------------

    function decorateTile(tile, button) {
      tile.classList.add('tile-editable');
      // Expose the button id so the Ctrl+click multi-selection path (which the
      // container capture handler must discriminate from Ctrl+drag zoom) can
      // resolve the tile's button.
      tile.dataset.buttonId = button.id;

      const controls = el('div', 'tile-edit-controls');
      const optBtn = el('button', 'tile-edit-opt', '⚙', {
        type: 'button',
        title: 'Tile options',
        'aria-label': 'Tile options',
      });
      const delBtn = el('button', 'tile-edit-del', '✕', {
        type: 'button',
        title: 'Delete tile',
        'aria-label': 'Delete tile',
      });
      optBtn.addEventListener('mousedown', stopEvent);
      delBtn.addEventListener('mousedown', stopEvent);
      optBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openOptions(button);
      });
      let armed = false;
      let timer = 0;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (armed) {
          clearTimeout(timer);
          removeButton(button);
          return;
        }
        armed = true;
        delBtn.textContent = '!';
        delBtn.classList.add('confirm');
        delBtn.title = 'Click again to delete';
        timer = setTimeout(() => {
          deleteTimers.delete(timer);
          armed = false;
          delBtn.textContent = '✕';
          delBtn.classList.remove('confirm');
          delBtn.title = 'Delete tile';
        }, TILE_DELETE_CONFIRM_MS);
        deleteTimers.add(timer);
      });
      controls.append(optBtn, delBtn);

      const resize = el('div', 'tile-resize', null, { title: 'Resize', 'aria-hidden': 'true' });
      resize.addEventListener('mousedown', (e) =>
        startResize(e, tile, button, allTiles(), applyButtonMetrics, {
          minW: Math.max(2, minSizeForVariant(button.options).min.w),
          minH: Math.max(2, minSizeForVariant(button.options).min.h),
          maxW: MAX_TILE_CELLS,
          maxH: MAX_TILE_CELLS,
          snap: snap2,
        })
      );

      tile.append(controls, resize);

      // In edit mode a shortcut tile's whole main zone is an <a href>: clicking
      // it must NOT navigate away mid-edit, and a drag must still be startable
      // from it. Neutralise the navigation but keep the zone draggable.
      tile.addEventListener(
        'click',
        (e) => {
          const link = e.target.closest ? e.target.closest('a[href]') : null;
          if (link) e.preventDefault();
        },
        true
      );

      // CAPTURE phase: the editor's dragGuard (grid/editor.js) attaches a
      // bubbling mousedown `stopPropagation` to every <a>/input/button inside
      // the content, INCLUDING a shortcut tile's <a href> — a bubbling listener
      // here would never run. Capturing on the tile makes the in-trame drag /
      // selection authoritative over that guard (the guard only exists to keep
      // gridstack's WIDGET drag out, which this stopPropagation also does).
      tile.addEventListener(
        'mousedown',
        (e) => {
          if (e.button !== 0) return;
          if (e.target.closest('button, input, select, textarea, .tile-resize, .tile-edit-controls')) return;
          startMove(e, tile, button, allTiles(), applyButtonMetrics, {
            // A mousedown that does NOT move is a SELECTION click; Ctrl/Cmd toggles
            // the tile in/out of the selection. A real move keeps the drag path.
            onClick: () => toggleSelect(button, e.ctrlKey || e.metaKey),
          });
        },
        true
      );
    }

    function decorateReportTile(tile, report) {
      tile.classList.add('tile-editable');

      const controls = el('div', 'tile-edit-controls');
      const delBtn = el('button', 'tile-edit-del', '✕', {
        type: 'button',
        title: 'Delete report tile',
        'aria-label': 'Delete report tile',
      });
      delBtn.addEventListener('mousedown', stopEvent);
      let armed = false;
      let timer = 0;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (armed) {
          clearTimeout(timer);
          removeReport(report);
          return;
        }
        armed = true;
        delBtn.textContent = '!';
        delBtn.classList.add('confirm');
        delBtn.title = 'Click again to delete';
        timer = setTimeout(() => {
          deleteTimers.delete(timer);
          armed = false;
          delBtn.textContent = '✕';
          delBtn.classList.remove('confirm');
          delBtn.title = 'Delete report tile';
        }, TILE_DELETE_CONFIRM_MS);
        deleteTimers.add(timer);
      });
      controls.appendChild(delBtn);

      const resize = el('div', 'tile-resize', null, { title: 'Resize', 'aria-hidden': 'true' });
      resize.addEventListener('mousedown', (e) =>
        startResize(e, tile, report, allTiles(), applyReportMetrics, {
          minW: REPORT_CELLS_MIN,
          minH: REPORT_CELLS_MIN,
          maxW: REPORT_CELLS_MAX,
          maxH: REPORT_CELLS_MAX,
          snap: snap1,
        })
      );

      tile.append(controls, resize);

      tile.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('button, input, select, textarea, .tile-resize, .tile-edit-controls')) return;
        startMove(e, tile, report, allTiles(), applyReportMetrics);
      });
    }

    function startMove(e, tile, obj, list, apply, { onClick } = {}) {
      // Ctrl/Cmd+drag is the ZOOM gesture (handled at the container in capture
      // phase); never start a tile move for it.
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startCol = obj.col;
      const startRow = obj.row;
      let moved = false;

      const onMove = (ev) => {
        const dCol = Math.round((ev.clientX - startX) / step);
        const dRow = Math.round((ev.clientY - startY) / step);
        const col = clampInt(startCol + dCol, 0, Math.max(0, groupCols - obj.w));
        const row = Math.max(0, startRow + dRow);
        if (col === obj.col && row === obj.row) return;
        if (overlaps(list, obj, col, row, obj.w, obj.h)) return;
        obj.col = col;
        obj.row = row;
        apply(tile, obj, step);
        moved = true;
      };
      const onUp = () => {
        endDrag(onMove, onUp);
        if (moved) {
          renderTiles();
          persist();
        } else {
          // No displacement → a click, not a drag.
          onClick?.();
        }
      };
      dragCleanup = () => endDrag(onMove, onUp);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.classList.add('tile-dragging');
    }

    function startResize(e, tile, obj, list, apply, { minW, minH, maxW, maxH, snap }) {
      // Ctrl/Cmd+drag is the ZOOM gesture; never start a tile resize for it.
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = obj.w;
      const startH = obj.h;
      let resized = false;

      const onMove = (ev) => {
        const capW = Math.max(minW, Math.min(maxW, groupCols - obj.col));
        const capH = Math.max(minH, Math.min(maxH, groupRows - obj.row));
        const w = clampInt(snap(startW + Math.round((ev.clientX - startX) / step)), minW, capW);
        const h = clampInt(snap(startH + Math.round((ev.clientY - startY) / step)), minH, capH);
        if (w === obj.w && h === obj.h) return;
        if (overlaps(list, obj, obj.col, obj.row, w, h)) return;
        obj.w = w;
        obj.h = h;
        apply(tile, obj, step);
        resized = true;
      };
      const onUp = () => {
        endDrag(onMove, onUp);
        if (resized) {
          renderTiles();
          persist();
        }
      };
      dragCleanup = () => endDrag(onMove, onUp);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.classList.add('tile-dragging');
    }

    function endDrag(onMove, onUp) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('tile-dragging');
      dragCleanup = null;
    }

    // ---- selection state + floating action bar ------------------------------

    /** Repaint the selection ring on every tile then refresh the action bar. */
    function syncSelection() {
      for (const [id, tile] of tileEls) tile.classList.toggle('tile-selected', selected.has(id));
      renderSelectionBar();
    }

    function clearSelection() {
      if (!selected.size) return;
      selected.clear();
      syncSelection();
    }

    /** Plain click selects ONLY this tile; Ctrl/Cmd+click toggles it. */
    function toggleSelect(button, additive) {
      if (!editable) return;
      if (additive) {
        if (selected.has(button.id)) selected.delete(button.id);
        else selected.add(button.id);
      } else {
        selected.clear();
        selected.add(button.id);
      }
      syncSelection();
    }

    /** The selected buttons, in document order. */
    const selectedButtons = () => buttons.filter((b) => selected.has(b.id));

    /** A surface option's value when ALL selected tiles agree, else undefined. */
    function commonValue(key) {
      const list = selectedButtons();
      if (!list.length) return undefined;
      const first = list[0].options[key];
      return list.every((b) => b.options[key] === first) ? first : undefined;
    }

    /** Apply one option to every selected tile, live + persisted. */
    function applyToSelection(key, value) {
      const list = selectedButtons();
      if (!list.length) return;
      for (const b of list) {
        b.options[key] = value;
        const tile = tileEls.get(b.id);
        if (tile) applyButtonMetrics(tile, b, step);
      }
      persist();
    }

    /** A labelled range for the selection bar; a mixed value shows « — ». */
    function buildBarRange({ label, key, min, max, step: stepSize, unit }) {
      const field = el('div', 'sel-field');
      field.appendChild(el('span', null, label));
      const value = commonValue(key);
      const slider = el('input', null, null, {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(stepSize),
        'aria-label': `Selected tiles ${label.toLowerCase()}`,
      });
      slider.value = String(value === undefined ? Math.round((Number(min) + Number(max)) / 2) : value);
      const valEl = el('span', 'sel-val', value === undefined ? '—' : `${value}${unit}`);
      slider.addEventListener('input', () => {
        applyToSelection(key, Number(slider.value));
        valEl.textContent = `${slider.value}${unit}`;
      });
      field.append(slider, valEl);
      if (value === undefined) field.appendChild(el('span', 'sel-mixed', 'mixed'));
      return field;
    }

    /**
     * Floating « N tiles selected » bar. Built with the COMMON value of each
     * surface option: a value shared by every selected tile pre-fills the
     * control, a divergent value shows a « mixed » marker and a neutral slider
     * position — moving a control OVERWRITES that option on ALL selected tiles
     * (the untouched options keep their per-tile values).
     */
    function renderSelectionBar() {
      if (!editable) return;
      if (!selected.size) {
        selectionBar?.remove();
        selectionBar = null;
        return;
      }
      if (!selectionBar) {
        selectionBar = el('div', 'group-selection-bar', null, { role: 'toolbar', 'aria-label': 'Selected tiles' });
        document.body.appendChild(selectionBar);
      }
      const bar = selectionBar;
      bar.replaceChildren();

      const count = selected.size;
      bar.appendChild(el('span', 'sel-count', `${count} tile${count > 1 ? 's' : ''} selected`));

      // Icon colour (+ theme reset). Same « common value / mixed » contract as
      // the surface colour below; only monochrome / currentColor glyphs follow.
      const iconColor = commonValue('iconColor');
      const iconColorField = el('div', 'sel-field');
      iconColorField.appendChild(el('span', null, 'Icon color'));
      const iconInput = el('input', null, null, {
        type: 'color',
        'aria-label': 'Selected tiles icon color',
      });
      iconInput.value = iconColor || SURFACE_SWATCH_FALLBACK;
      iconInput.addEventListener('input', () =>
        applyToSelection('iconColor', normalizeSurfaceColor(iconInput.value))
      );
      iconColorField.appendChild(iconInput);
      const iconThemeBtn = el('button', 'btn', 'Theme', {
        type: 'button',
        title: 'Use the theme default icon color on all selected tiles',
      });
      iconThemeBtn.addEventListener('click', () => {
        applyToSelection('iconColor', '');
        renderSelectionBar();
      });
      iconColorField.appendChild(iconThemeBtn);
      if (iconColor === undefined) iconColorField.appendChild(el('span', 'sel-mixed', 'mixed'));
      bar.appendChild(iconColorField);

      // Shape.
      const shape = commonValue('surfaceShape');
      const shapeField = el('div', 'sel-field');
      shapeField.appendChild(el('span', null, 'Shape'));
      const seg = el('div', 'segmented');
      for (const s of SURFACE_SHAPES) {
        const b = el('button', 'segmented-item' + (shape === s ? ' active' : ''), SURFACE_SHAPE_LABEL[s] || s, {
          type: 'button',
        });
        b.addEventListener('click', () => {
          applyToSelection('surfaceShape', s);
          renderSelectionBar();
        });
        seg.appendChild(b);
      }
      shapeField.appendChild(seg);
      if (shape === undefined) shapeField.appendChild(el('span', 'sel-mixed', 'mixed'));
      bar.appendChild(shapeField);

      // Opacity (Inset is now a GROUP-level setting — see config.tileInset).
      bar.appendChild(
        buildBarRange({
          label: 'Opacity',
          key: 'surfaceOpacity',
          min: SURFACE_OPACITY_MIN,
          max: SURFACE_OPACITY_MAX,
          step: 1,
          unit: '%',
        })
      );

      // Colour (+ theme reset).
      const color = commonValue('surfaceColor');
      const colorField = el('div', 'sel-field');
      colorField.appendChild(el('span', null, 'Color'));
      const input = el('input', null, null, { type: 'color', 'aria-label': 'Selected tiles surface color' });
      input.value = color || SURFACE_SWATCH_FALLBACK;
      input.addEventListener('input', () => applyToSelection('surfaceColor', normalizeSurfaceColor(input.value)));
      colorField.appendChild(input);
      const themeBtn = el('button', 'btn', 'Theme', {
        type: 'button',
        title: 'Use the theme default color on all selected tiles',
      });
      themeBtn.addEventListener('click', () => {
        applyToSelection('surfaceColor', '');
        renderSelectionBar();
      });
      colorField.appendChild(themeBtn);
      if (color === undefined) colorField.appendChild(el('span', 'sel-mixed', 'mixed'));
      bar.appendChild(colorField);

      const clear = el('button', 'btn sel-clear', 'Clear selection', { type: 'button' });
      clear.addEventListener('click', clearSelection);
      bar.appendChild(clear);
    }

    // ---- zoom (uniform content scale) ----------------------------------------
    //
    // Ctrl+drag (edit mode) adjusts `zoom` LIVE. The factor multiplies the base
    // internal step, so the trame AND the tiles scale together — the tiles stay
    // perfectly square (a single factor, same in both axes). It never touches
    // the tiles' col/row/w/h (internal cells) nor the group geometry on the
    // global grid. Content larger than the group simply scrolls, as before.

    /** Apply the effective step (baseStep × zoom) to the trame and the tiles. */
    const applyStep = () => {
      // The single square unit (half a global COLUMN, width-derived), scaled by
      // the group zoom. Tiles span integer multiples of it in BOTH axes.
      baseStep = measureStep(container, item);
      step = baseStep * zoom;
      canvas.style.setProperty('--group-step', `${step}px`);
    };

    /**
     * Re-fit every tile to the current effective step WITHOUT rebuilding the
     * DOM: the grid tracks (driven by --group-step) already resize the tile
     * boxes, this refreshes the icon px computed from each tile's footprint.
     */
    const applyZoomMetrics = () => {
      const list = allTiles();
      const children = canvas.children;
      for (let i = 0; i < list.length; i += 1) {
        const tile = children[i];
        const obj = list[i];
        if (!tile || !obj) continue;
        if ('options' in obj) applyButtonMetrics(tile, obj, step);
        else applyReportMetrics(tile, obj, step);
      }
    };

    /** Keep local caches (state.layout + editor meta) in sync with the zoom. */
    const broadcastZoom = (value) => {
      if (!item?.id) return;
      window.dispatchEvent(
        new CustomEvent('homy:widget-config', { detail: { id: item.id, config: { zoom: value } } })
      );
    };

    /** Persist the zoom through the SAME config PATCH as the ⚙ modal. */
    const persistZoom = (value) => {
      if (!item?.id) return;
      api
        .patch(`/api/layout/items/${item.id}/config`, { config: { zoom: value } })
        .catch((err) => toast(err.message || 'Failed to save zoom', 'error'));
    };

    /**
     * Set the zoom (clamped + snapped to the shared step). Live updates
     * (Ctrl+drag) refresh the layout + local caches; the final value is
     * persisted on drag end / reset / modal save.
     */
    const setZoom = (value, { persist: doPersist = false, broadcast = true } = {}) => {
      const next = clampZoom(value);
      const changed = next !== zoom;
      zoom = next;
      applyStep();
      applyZoomMetrics();
      if (broadcast) broadcastZoom(zoom);
      if (doPersist) persistZoom(zoom);
      return changed;
    };

    // ---- zoom readout (transient « 1.25× » badge) ----------------------------

    const ensureZoomBadge = () => {
      if (!zoomBadge) {
        zoomBadge = el('div', 'group-zoom-badge', null, { 'aria-hidden': 'true' });
        document.body.appendChild(zoomBadge);
      }
      return zoomBadge;
    };

    const placeZoomBadge = (x, y) => {
      if (!zoomBadge) return;
      zoomBadge.style.left = `${x}px`;
      zoomBadge.style.top = `${y}px`;
    };

    const showZoomBadge = (text, x, y, reset = false) => {
      const badge = ensureZoomBadge();
      badge.textContent = text;
      badge.classList.toggle('reset', reset);
      placeZoomBadge(x, y);
    };

    const hideZoomBadge = () => {
      if (resetHintTimer) {
        clearTimeout(resetHintTimer);
        resetHintTimer = 0;
      }
      zoomBadge?.remove();
      zoomBadge = null;
    };

    /**
     * Start a live Ctrl+drag zoom. `startX/startY` are the press point (the
     * baseline for the drag), `pointerX/pointerY` the current position (for the
     * badge placement).
     *
     * The gesture is armed lazily by the container mousedown handler (see
     * below) so a Ctrl+CLICK without movement stays a multi-SELECTION toggle
     * (toggleSelect) — only an actual drag switches to zoom.
     */
    function startZoom(startX, startY, pointerX, pointerY) {
      const startZoomValue = zoom;
      let changed = false;
      document.body.classList.add('group-zoom-dragging');
      showZoomBadge(zoomText(zoom), pointerX, pointerY);

      const update = (ev) => {
        // Horizontal travel drives the zoom (drag right = larger); vertical up
        // also counts so a diagonal gesture feels natural. The factor is a
        // SINGLE uniform scale → the ratio is always preserved.
        const delta = ev.clientX - startX - (ev.clientY - startY);
        if (setZoom(startZoomValue + delta / GROUP_ZOOM_PX_PER_UNIT)) changed = true;
        showZoomBadge(zoomText(zoom), ev.clientX, ev.clientY);
      };
      const cleanup = () => {
        document.removeEventListener('mousemove', update);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('keydown', onKey);
        document.body.classList.remove('group-zoom-dragging');
        hideZoomBadge();
        zoomCleanup = null;
      };
      const onUp = () => {
        cleanup();
        if (changed) persistZoom(zoom);
      };
      const onKey = (ev) => {
        if (ev.key !== 'Escape') return;
        cleanup();
        if (startZoomValue !== zoom) setZoom(startZoomValue, { persist: true });
      };
      zoomCleanup = cleanup;
      document.addEventListener('mousemove', update);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('keydown', onKey);
      return update;
    }

    /** Ctrl+double-click reset: back to 1 with a brief, explicit readout. */
    function resetZoom(e) {
      e.stopPropagation();
      e.preventDefault();
      if (zoom !== GROUP_ZOOM_DEFAULT) setZoom(GROUP_ZOOM_DEFAULT, { persist: true });
      clearTimeout(resetHintTimer);
      showZoomBadge(`Reset ${zoomText(GROUP_ZOOM_DEFAULT)}`, e.clientX, e.clientY, true);
      resetHintTimer = setTimeout(() => {
        resetHintTimer = 0;
        hideZoomBadge();
      }, 700);
    }

    // ---- initial paint + live step -------------------------------------------

    applyStep();
    renderTiles();

    // Edit-only: Escape clears the selection; a click on the trame background
    // (not on a tile / control) clears it too. Both are no-ops in VIEW mode.
    if (editable) {
      selectionKeyHandler = (e) => {
        if (e.key === 'Escape' && selected.size) clearSelection();
      };
      document.addEventListener('keydown', selectionKeyHandler);
      board.addEventListener('click', (e) => {
        if (e.target === board || e.target === canvas) clearSelection();
      });

      // CAPTURE phase so a Ctrl/Cmd gesture wins over the tile move/resize
      // handlers (deeper) AND gridstack's drag handle (bubble on this very
      // element). We ARM the gesture on mousedown but only promote it to a ZOOM
      // once the pointer has travelled past a small threshold: a Ctrl+CLICK
      // without movement therefore stays a multi-SELECTION toggle, while a
      // Ctrl+DRAG adjusts the zoom. A drag WITHOUT Ctrl falls through untouched
      // (tiles move, the group drags/resizes as before).
      const zoomExcluded = (target) =>
        !!(target?.closest && target.closest('button, input, select, textarea, .tile-edit-controls, .tile-resize'));
      const ZOOM_DRAG_THRESHOLD = 4; // px before a Ctrl press becomes a zoom drag
      container.addEventListener(
        'mousedown',
        (e) => {
          if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
          if (zoomExcluded(e.target)) return;
          // Block BOTH the tile move/resize (deeper capture) and gridstack's
          // drag handle (bubble). The click-vs-drag decision happens below.
          e.stopPropagation();
          e.preventDefault();
          const startX = e.clientX;
          const startY = e.clientY;
          const tile = e.target.closest?.('.group-tile') || null;
          let zooming = false;
          // Track the pending listeners so a widget destroy mid-gesture (mode
          // switch, page change) tears them down too — no leak, no stale
          // handler on document.
          const pendingCleanup = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (zoomCleanup === pendingCleanup) zoomCleanup = null;
          };
          const onMove = (ev) => {
            if (zooming) return;
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < ZOOM_DRAG_THRESHOLD) return;
            zooming = true;
            pendingCleanup();
            const update = startZoom(startX, startY, ev.clientX, ev.clientY);
            update(ev); // apply the threshold-crossing move immediately
          };
          const onUp = () => {
            pendingCleanup();
            if (zooming) return;
            // A Ctrl+CLICK (no movement): keep the multi-selection toggle that
            // the tile's own capture handler would otherwise have run.
            const id = tile?.dataset?.buttonId;
            const button = id ? buttons.find((b) => b.id === id) : null;
            if (button) toggleSelect(button, true);
          };
          zoomCleanup = pendingCleanup;
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        },
        true
      );
      container.addEventListener(
        'dblclick',
        (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          if (zoomExcluded(e.target)) return;
          resetZoom(e);
        },
        true
      );
    }

    // The catalogue may resolve AFTER the group was first rendered (tolerant
    // async load): redraw the tiles with the real element names/icons.
    const unsubscribe = catalog.subscribe(renderTiles);
    catalog.load();

    // Viewport resizes change the global cell width (hence the internal step).
    // The GROUP's own resize does NOT (step derives from the global grid), so
    // this only fires a redraw when the step actually moved.
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const next = measureStep(container, item);
          if (Math.abs(next - baseStep) > 0.25) {
            baseStep = next;
            step = baseStep * zoom;
            canvas.style.setProperty('--group-step', `${step}px`);
            renderTiles();
          }
        });
      });
      observer.observe(container);
    }

    return () => {
      unsubscribe();
      if (observer) observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearDeleteTimers();
      disposeTiles();
      dragCleanup?.();
      zoomCleanup?.();
      hideZoomBadge();
      container.style.removeProperty('--group-tile-inset');
      if (selectionKeyHandler) document.removeEventListener('keydown', selectionKeyHandler);
      selectionBar?.remove();
      selectionBar = null;
    };
  },
};

/**
 * Internal cell size in px — the ONE square unit the whole group trame is
 * built on. It is ALWAYS half the GLOBAL grid COLUMN width:
 *
 *   step = gridEl.clientWidth / columns / 2
 *
 * and NEVER derived from the (possibly stretched) cell HEIGHT. The same value
 * feeds `.group-grid`'s `grid-template-columns` AND `grid-auto-rows` (see
 * style.css), and every tile is placed with integer col/row/w/h spans, so a
 * 2×2 tile is always a perfect square and no child (health circle, SVG icon,
 * gauge) can be ovalized — even when the PARENT canvas is stretched by the
 * fill fit (the parent cell may be up to ±20 % anisotropic, the group content
 * stays strictly 1:1).
 *
 * Read from the live grid container (gridstack publishes --gs-columns and the
 * container width is the pinned canvas width), with a geometry fallback when
 * the grid is not measurable yet (the ResizeObserver re-runs this later).
 */
function measureStep(container, item) {
  const gridEl = container?.closest ? container.closest('.grid-stack') : null;
  if (gridEl && gridEl.clientWidth > 0) {
    const cols = Number(getComputedStyle(gridEl).getPropertyValue('--gs-columns')) || GLOBAL_COLUMNS;
    if (cols > 0) return gridEl.clientWidth / cols / 2;
  }
  const groupCols = Math.max(1, Number(item?.w) || 1) * 2;
  const width = container?.clientWidth || 0;
  return width > 0 ? width / groupCols : DEFAULT_STEP;
}

// ---- geometry helpers --------------------------------------------------------

/** Title-chip visibility values (must mirror the server + settingsSchema). */
const TITLE_VISIBILITIES = new Set(['always', 'hover', 'never']);

/** Tolerant titleVisibility coercion: unknown/missing → 'always'. */
function normalizeTitleVisibility(raw) {
  return TITLE_VISIBILITIES.has(raw) ? raw : 'always';
}

/**
 * Tolerant group zoom coercion (mirror of the server): a finite number inside
 * [0.5, 3] is kept (snapped to the 0.05 step); anything missing, non-numeric
 * or out of range (e.g. 99 or "abc") falls back to 1. Applied to config.zoom
 * at render time so a stale/hand-edited config never distorts the group.
 */
function normalizeGroupZoom(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < GROUP_ZOOM_MIN || n > GROUP_ZOOM_MAX) return GROUP_ZOOM_DEFAULT;
  return snapZoom(n);
}

/** Clamp + snap a LIVE zoom value to the documented [0.5, 3] × 0.05 grid. */
function clampZoom(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return GROUP_ZOOM_DEFAULT;
  return snapZoom(Math.min(GROUP_ZOOM_MAX, Math.max(GROUP_ZOOM_MIN, n)));
}

/**
 * Tolerant group tile-inset coercion (mirror of the server): an integer px
 * value inside [0, 8] is kept; anything missing, non-numeric or out of range
 * (e.g. 99 or "abc") falls back to the 4 px default so a stale/hand-edited
 * config never collapses the trame or distorts it.
 */
function normalizeTileInset(raw) {
  if (raw === null || raw === undefined) return TILE_INSET_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < TILE_INSET_MIN || n > TILE_INSET_MAX) return TILE_INSET_DEFAULT;
  return Math.round(n);
}

/** Snap to the 0.05 zoom step, clamped to the range, rounded to 2 decimals. */
function snapZoom(n) {
  const stepped = Math.round(n / GROUP_ZOOM_STEP) * GROUP_ZOOM_STEP;
  return Number(Math.min(GROUP_ZOOM_MAX, Math.max(GROUP_ZOOM_MIN, stepped)).toFixed(2));
}

/** Human zoom readout, e.g. 1 → « 1.00× », 1.25 → « 1.25× ». */
function zoomText(z) {
  return `${Number(z).toFixed(2)}\u00d7`;
}

/** Round to the nearest even internal-cell value (tile sizes are {2,4}). */
function snap2(value) {
  return Math.round(value / 2) * 2;
}

/** Round to the nearest internal cell (free-size report tiles). */
function snap1(value) {
  return Math.round(value);
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** AABB overlap on the internal trame; `exclude` is skipped (the moving tile). */
function overlaps(list, exclude, col, row, w, h) {
  return list.some(
    (b) =>
      b !== exclude &&
      !(col + w <= b.col || b.col + b.w <= col || row + h <= b.row || b.row + b.h <= row)
  );
}

function stopEvent(e) {
  e.stopPropagation();
}
