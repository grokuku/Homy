/**
 * Grid canvas constants — shared by editor.js, viewer.js and main.js.
 *
 * The dashboard grid is a fixed 32×18 canvas (32 columns × 18 rows).
 * 32/18 = 16/9, so with square cells (cellHeight: 'auto' → cell height =
 * cell width) the 18-row grid fills exactly the height of a 16:9 screen,
 * which enables precise placement and true screen-centering of widgets.
 *
 * Legacy layouts (before the columns field existed in layout.json) were
 * built on a 12-column grid with a fixed 80px cell height; their x/w
 * coordinates are migrated client-side via gridstack's native
 * `column(32, 'moveScale')` reflow (see editor.js / viewer.js).
 *
 * float: true (set by editor.js and viewer.js) = FREE VERTICAL PLACEMENT
 * (review C7 fix): an item dropped in the lower rows keeps its y, voluntary
 * vertical holes are preserved (no compaction toward the top) and the drag
 * placeholder follows the real mouse position. gridstack still forbids
 * overlaps: a drop on an occupied cell pushes the occupant (collision
 * resolution), it never stacks. Deleting an item leaves its rows empty (no
 * auto re-flow) — deliberate. Editor and viewer use the SAME flag so the
 * rendered layout is always identical to the persisted coordinates.
 *
 * margin (editor/viewer) must stay a single SYMMETRIC value (review C8):
 * gridstack insets each item's content box with the four --gs-item-margin-*
 * vars (vendored CSS positions .grid-stack-item-content absolutely with those
 * insets), and cellHeight:'auto' computes the square cell height as
 * cellWidth − marginRight − marginLeft + marginTop + marginBottom. Symmetric
 * margins ⇒ cell height = cell width (true square); any asymmetric margin
 * would skew every cell and desync the 18-row fill from the 16:9 aspect box.
 */
import { getWidget } from '../widgets/registry.js';
import { normalizeButton, minSizeForVariant } from '../elements/button.js';

export const GRID_COLUMNS = 32;
export const GRID_ROWS = 18;
export const LEGACY_COLUMNS = 12;

/** Design aspect of the canvas (32 columns / 18 rows = 16/9). */
export const CANVAS_ASPECT = GRID_COLUMNS / GRID_ROWS;

/**
 * Maximum allowed cell ANISOTROPY when the canvas stretches to fill the
 * viewport (lot « fill »). 0.2 = ±20 %: a cell may never be more than 1.2×
 * wider than tall (nor 1.2× taller than wide). Beyond this bound the fit falls
 * back to a CENTERED 16:9 letterboxed canvas instead of distorting further.
 *
 * MUST mirror the `--cell-aspect-tolerance` CSS variable declared on
 * `#dashboard-view` in style.css: main.js reads THAT value when present (so a
 * single CSS knob tunes the behavior live) and falls back to this constant
 * when the variable is missing/invalid.
 */
export const CELL_ASPECT_TOLERANCE = 0.2;

/**
 * Fit the 32×18 canvas into an available content box (CSS px).
 *
 *   cellAspect = (availW / 32) / (availH / 18)   // 1 = square cell
 *
 * When `cellAspect` is inside [1/(1+tol), 1+tol] the canvas FILLS the box
 * (mode « fill »): the 32 columns span the available width and the 18 rows the
 * available height, so cells are deformed by at most the tolerance. Otherwise
 * the fit falls back to a centered 16:9 canvas (mode « letterbox ») whose cells
 * stay square — the pre-fill behavior.
 *
 * Returns `{ mode, width, height, cellAspect }` or null for a non-measurable
 * box. Pure: callers decide how (and whether) to pin the result.
 */
export function computeCanvasFit(availW, availH, tolerance = CELL_ASPECT_TOLERANCE) {
  const w = Number(availW);
  const h = Number(availH);
  if (!(w > 0) || !(h > 0)) return null;
  const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : CELL_ASPECT_TOLERANCE;
  const cellAspect = w / GRID_COLUMNS / (h / GRID_ROWS);
  if (cellAspect >= 1 / (1 + tol) && cellAspect <= 1 + tol) {
    return { mode: 'fill', width: w, height: h, cellAspect };
  }
  const width = Math.min(w, h * CANVAS_ASPECT);
  return { mode: 'letterbox', width, height: width / CANVAS_ASPECT, cellAspect: 1 };
}

/**
 * Hard cap on the number of layout items. MUST stay equal to MAX_ITEMS in
 * server/routes/layout.routes.js: the server rejects PUT bodies with more
 * items (400), so the client blocks adding beyond this count with a visible
 * error instead of silently diverging from the server (review C3).
 */
export const MAX_ITEMS = 100;

/**
 * Canvas-level item normalization, applied at load time by BOTH the editor
 * and the viewer so the two always render the same geometry.
 *
 * Three adjustments:
 *  - search widgets saved at h=1 (the old defaultSize) clip their search bar
 *    at every common desktop size (a 1-row cell offers ~38px of content at
 *    1920×1080, less below, while the bar needs ~46px): the search defaultSize
 *    is now 11×2 and EXISTING h=1 searches are grown to h=2 on load. Same
 *    philosophy as the legacy 12→32 column reflow: the editor persists the
 *    corrected height on its next save, the viewer applies it at display time
 *    only (it never persists). Note this is the ONE deliberate deviation from
 *    the column migration's « h unchanged » contract — it is widget-scoped,
 *    not a coordinate rescale.
 *  - missing or non-numeric w/h (hand-edited layout.json) fall back to 1,
 *    matching the non-destructive server fallback in layout.routes.js
 *    (gridstack omits w/h on save only when the value IS 1).
 *  - LOT 6: every `group` button is RAISED to the minimum of its display
 *    variant (minSizeForVariant, roadmap §A.7) so tiles seeded before the rule
 *    existed no longer truncate their content. Same « correct on load, persist
 *    on next save » philosophy as search h:1→h:2. A tile that cannot keep its
 *    grown footprint (out of the group trame or overlapping a neighbour) is
 *    relocated to the first free internal slot; if no slot exists the grown
 *    size is kept anyway (best-effort — the group's own 2×2 global minimum
 *    makes such a case impossible for a well-formed layout).
 *
 * x/y, ids, types and configs pass through untouched. Returns NEW objects —
 * callers keep their original item list untouched (meta/state stay valid).
 */
export function normalizeItems(items) {
  const out = [];
  const ignored = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    // Tolerance (v4): an UNKNOWN item type is skipped cleanly (one muted log)
    // instead of reaching renderWidget and printing an "Unknown widget" label
    // — an old/future type must never break the layout. Server-side load/PUT
    // already drops unknown types; this is the matching client-side guard.
    // Since lot 6 this also covers the removed `frame`/`shortcut`/`links`.
    const type = String(item.type || '');
    if (!getWidget(type)) {
      ignored.add(type);
      continue;
    }
    const w = Math.floor(Number(item.w));
    const h = Math.floor(Number(item.h));
    const next = {
      ...item,
      type,
      w: Number.isFinite(w) && w >= 1 ? w : 1,
      h: Number.isFinite(h) && h >= 1 ? h : 1,
    };
    if (next.type === 'search' && next.h === 1) next.h = 2;
    if (next.type === 'group') {
      next.buttons = normalizeGroupButtons(item.buttons, next.w, next.h);
      next.reports = normalizeGroupReports(item.reports, next.w, next.h);
    }
    out.push(next);
  }
  if (ignored.size) {
    console.warn(`[grid] ignoring unknown item type(s): ${[...ignored].join(', ')}`);
  }
  return out;
}

// Server-side per-button cap (internal cells) — mirrors BUTTON_CELLS_MAX in
// layout.routes.js and MAX_TILE_CELLS in elements/group.js.
const BUTTON_CELLS_MAX = 4;

/**
 * Raise every button of a group to its variant minimum and keep the tiles
 * inside the group trame without overlap (lot 6 normalization, see
 * normalizeItems above). Order is preserved (document order wins the slot);
 * returns fresh, normalized button objects (id/elementId/options kept).
 */
function normalizeGroupButtons(rawButtons, groupW, groupH) {
  const groupCols = Math.max(2, (Number(groupW) || 1) * 2);
  const groupRows = Math.max(2, (Number(groupH) || 1) * 2);
  const placed = [];
  const out = [];
  for (const raw of Array.isArray(rawButtons) ? rawButtons : []) {
    const b = normalizeButton(raw);
    if (!b.elementId) continue; // group.js filters these out too
    const { min } = minSizeForVariant(b.options);
    // Grow to the variant minimum, capped by the server's per-button cap.
    const w = Math.min(BUTTON_CELLS_MAX, Math.max(b.w, min.w));
    const h = Math.min(BUTTON_CELLS_MAX, Math.max(b.h, min.h));
    let { col, row } = b;
    if (col + w > groupCols || row + h > groupRows || buttonOverlaps(placed, col, row, w, h)) {
      const slot = firstFreeSlot(placed, groupCols, groupRows, w, h);
      if (slot) {
        col = slot.col;
        row = slot.row;
      }
    }
    const next = { ...b, col, row, w, h };
    placed.push(next);
    out.push(next);
  }
  return out;
}

/** AABB overlap test on the internal trame (mirrors elements/group.js). */
function buttonOverlaps(list, col, row, w, h) {
  return list.some(
    (b) => !(col + w <= b.col || b.col + b.w <= col || row + h <= b.row || b.row + b.h <= row)
  );
}

/** First free even-cell slot for a w×h tile, or null when the trame is full. */
function firstFreeSlot(list, groupCols, groupRows, w, h) {
  const maxCol = Math.max(0, groupCols - w);
  const maxRow = Math.max(0, groupRows - h);
  for (let row = 0; row <= maxRow; row += 2) {
    for (let col = 0; col <= maxCol; col += 2) {
      if (!buttonOverlaps(list, col, row, w, h)) return { col, row };
    }
  }
  return null;
}

// Report-tile geometry bounds (internal cells) — MUST stay in sync with
// reportTile.js / layout.routes.js. Reports have a FREE size (no button minima).
const REPORT_CELLS_MIN = 2;
const REPORT_CELLS_MAX = 64;

/**
 * Tolerant normalization of a group's report tiles (lot 8). Unlike buttons,
 * reports have NO variant minimum: only [REPORT_CELLS_MIN, REPORT_CELLS_MAX] is
 * enforced and the tile is kept inside the group trame (with overlap tolerance
 * — a report tile never blocks the layout from rendering).
 */
function normalizeGroupReports(rawReports, groupW, groupH) {
  const groupCols = Math.max(2, (Number(groupW) || 1) * 2);
  const groupRows = Math.max(2, (Number(groupH) || 1) * 2);
  const out = [];
  for (const raw of Array.isArray(rawReports) ? rawReports : []) {
    if (!raw || typeof raw !== 'object') continue;
    const elementId = typeof raw.elementId === 'string' ? raw.elementId : '';
    if (!elementId) continue;
    const w = Math.min(REPORT_CELLS_MAX, Math.max(REPORT_CELLS_MIN, Math.floor(Number(raw.w)) || REPORT_CELLS_MIN));
    const h = Math.min(REPORT_CELLS_MAX, Math.max(REPORT_CELLS_MIN, Math.floor(Number(raw.h)) || REPORT_CELLS_MIN));
    const col = Math.min(Math.max(0, Math.floor(Number(raw.col)) || 0), Math.max(0, groupCols - w));
    const row = Math.min(Math.max(0, Math.floor(Number(raw.row)) || 0), Math.max(0, groupRows - h));
    out.push({
      id: typeof raw.id === 'string' ? raw.id : '',
      elementId,
      col,
      row,
      w,
      h,
    });
  }
  return out;
}
