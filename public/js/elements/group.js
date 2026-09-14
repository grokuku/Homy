import { el, uuid } from '../util.js';
import { catalog } from './catalog.js';
import { normalizeButton, renderButtonTile, applyTileMetrics, minSizeForVariant } from './button.js';
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
};

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

    let step = DEFAULT_STEP;
    let raf = 0;
    let dragCleanup = null; // active tile move/resize teardown (destroyed mid-drag)
    const deleteTimers = new Set(); // armed ✕ confirm timers (cleared on re-render/destroy)
    const tileDisposers = new Set(); // report-tile refresh cleanups (no timer leaks)

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
      for (const button of buttons) {
        const element = catalog.get(button.elementId);
        const { el: tile, dispose } = renderButtonTile({ button, element, step });
        tileDisposers.add(dispose);
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
        startResize(e, tile, button, allTiles(), applyTileMetrics, {
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

      tile.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('button, input, select, textarea, .tile-resize, .tile-edit-controls')) return;
        startMove(e, tile, button, allTiles(), applyTileMetrics);
      });
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

    function startMove(e, tile, obj, list, apply) {
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
        }
      };
      dragCleanup = () => endDrag(onMove, onUp);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.classList.add('tile-dragging');
    }

    function startResize(e, tile, obj, list, apply, { minW, minH, maxW, maxH, snap }) {
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

    // ---- initial paint + live step -------------------------------------------

    const applyStep = () => {
      // The single square unit (half a global COLUMN, width-derived) — see
      // measureStep. Tiles span integer multiples of it in BOTH axes.
      const next = measureStep(container, item);
      step = next;
      canvas.style.setProperty('--group-step', `${next}px`);
    };

    applyStep();
    renderTiles();

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
          if (Math.abs(next - step) > 0.25) {
            step = next;
            canvas.style.setProperty('--group-step', `${next}px`);
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
