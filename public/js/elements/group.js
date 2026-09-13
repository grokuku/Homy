import { el, uuid } from '../util.js';
import { catalog } from './catalog.js';
import { normalizeButton, renderButtonTile, applyTileMetrics, minSizeForVariant } from './button.js';
import { openElementPicker } from './elementPicker.js';
import { openButtonOptions } from './buttonOptions.js';
import { toast } from '../ui/toast.js';

/**
 * Group widget (LOT 2 container + LOT 4 in-trame tile editing).
 *
 * A `group` (layout v4) is a titled container whose `buttons[]` are button
 * tiles referencing catalogue elements. It renders:
 *   - an optional header (config.title) +, in EDIT mode, a « + Add element »
 *     action that opens the catalogue picker;
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
const TILE_DELETE_CONFIRM_MS = 3000;
const ADD_DEFAULT_OPTIONS = {
  icon: true,
  label: true,
  shortcut: true,
  health: false,
  monitoring: false,
  controls: false,
  iconSize: 'M',
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
    ],
  },

  render(container, config, item, context = {}) {
    container.classList.add('group-widget');
    const editable = !!context?.editable;

    const title = (config?.title || '').trim();
    if (title || editable) {
      const header = el('div', 'widget-header');
      if (title) header.appendChild(el('span', 'widget-title', title));
      if (editable) {
        const addBtn = el('button', 'group-add', '+ Add element', {
          type: 'button',
          title: 'Add an element to this group',
        });
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          addElement();
        });
        header.appendChild(addBtn);
      }
      container.appendChild(header);
    }

    const board = el('div', 'group-board');
    const canvas = el('div', 'group-grid');
    board.appendChild(canvas);
    container.appendChild(board);

    const buttons = (Array.isArray(item?.buttons) ? item.buttons : [])
      .map(normalizeButton)
      .filter((b) => b.elementId);

    // Group dimensions in INTERNAL cells (a global cell = 2 internal cells).
    const groupCols = Math.max(2, (Number(item?.w) || 1) * 2);
    const groupRows = Math.max(2, (Number(item?.h) || 1) * 2);

    let step = DEFAULT_STEP;
    let raf = 0;
    let dragCleanup = null; // active tile move/resize teardown (destroyed mid-drag)
    const deleteTimers = new Set(); // armed ✕ confirm timers (cleared on re-render/destroy)

    const clearDeleteTimers = () => {
      for (const t of deleteTimers) clearTimeout(t);
      deleteTimers.clear();
    };

    // ---- tile rendering -------------------------------------------------------

    const renderTiles = () => {
      clearDeleteTimers();
      canvas.replaceChildren();
      for (const button of buttons) {
        const element = catalog.get(button.elementId);
        const tile = renderButtonTile({ button, element, step });
        if (editable) decorateTile(tile, button);
        canvas.appendChild(tile);
      }
    };

    // ---- persistence ----------------------------------------------------------

    // The group does not own the save path: it publishes its fresh buttons and
    // the editor (which holds the item meta) debounces the PUT /api/layout.
    function persist() {
      window.dispatchEvent(
        new CustomEvent('homy:group-buttons', { detail: { id: item.id, buttons } })
      );
    }

    // ---- add / remove ---------------------------------------------------------

    function nextSlot(w, h, exclude = null) {
      const maxCol = Math.max(0, groupCols - w);
      for (let row = 0; row < 500; row += 2) {
        for (let col = 0; col <= maxCol; col += 2) {
          if (!overlaps(buttons, exclude, col, row, w, h)) return { col, row };
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
          const slot = nextSlot(min.w, min.h);
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

    function removeButton(button) {
      const index = buttons.indexOf(button);
      if (index >= 0) buttons.splice(index, 1);
      renderTiles();
      persist();
      toast('Tile removed', 'success');
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
          if (overlaps(buttons, button, updated.col, updated.row, button.w, button.h)) {
            const slot = nextSlot(button.w, button.h, button);
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
      resize.addEventListener('mousedown', (e) => startResize(e, tile, button));

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
        startMove(e, tile, button);
      });
    }

    function startMove(e, tile, button) {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startCol = button.col;
      const startRow = button.row;
      let moved = false;

      const onMove = (ev) => {
        const dCol = Math.round((ev.clientX - startX) / step);
        const dRow = Math.round((ev.clientY - startY) / step);
        const col = clampInt(startCol + dCol, 0, Math.max(0, groupCols - button.w));
        const row = Math.max(0, startRow + dRow);
        if (col === button.col && row === button.row) return;
        if (overlaps(buttons, button, col, row, button.w, button.h)) return;
        button.col = col;
        button.row = row;
        applyTileMetrics(tile, button, step);
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

    function startResize(e, tile, button) {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = button.w;
      const startH = button.h;
      const { min } = minSizeForVariant(button.options);
      const minW = Math.max(2, min.w);
      const minH = Math.max(2, min.h);
      let resized = false;

      const onMove = (ev) => {
        const maxW = Math.max(minW, Math.min(MAX_TILE_CELLS, groupCols - button.col));
        const maxH = Math.max(minH, Math.min(MAX_TILE_CELLS, groupRows - button.row));
        const w = clampInt(snap2(startW + Math.round((ev.clientX - startX) / step)), minW, maxW);
        const h = clampInt(snap2(startH + Math.round((ev.clientY - startY) / step)), minH, maxH);
        if (w === button.w && h === button.h) return;
        if (overlaps(buttons, button, button.col, button.row, w, h)) return;
        button.w = w;
        button.h = h;
        applyTileMetrics(tile, button, step);
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
      dragCleanup?.();
    };
  },
};

/**
 * Internal cell size in px = half of the GLOBAL grid cell. Read from the live
 * grid container (gridstack publishes --gs-columns), with a geometry fallback
 * when the grid is not measurable yet (the ResizeObserver re-runs this later).
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

/** Round to the nearest even internal-cell value (tile sizes are {2,4}). */
function snap2(value) {
  return Math.round(value / 2) * 2;
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
