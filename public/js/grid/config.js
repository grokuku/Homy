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

export const GRID_COLUMNS = 64;
export const GRID_ROWS = 36;
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
 * Hard cap on the number of layout objects. MUST stay equal to
 * MAX_OBJECTS_PER_PAGE in server/services/layout.service.js: the server rejects
 * PUT bodies with more objects (400), so the client blocks adding beyond this
 * count with a visible error instead of silently diverging from the server.
 */
export const MAX_ITEMS = 200;

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
 *
 * x/y, ids, types and configs pass through untouched. Returns NEW objects —
 * callers keep their original item list untouched (meta/state stay valid).
 */
export function normalizeItems(items) {
  const out = [];
  const ignored = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    // v5 OBJECTS: an element/report placement is not a widget — keep it (it is
    // rendered by its own tile renderer) with hardened geometry (2×2 minimum).
    if (item.kind === 'element' || item.kind === 'report') {
      const w = Math.floor(Number(item.w));
      const h = Math.floor(Number(item.h));
      const x = Math.floor(Number(item.x));
      const y = Math.floor(Number(item.y));
      out.push({
        ...item,
        x: Number.isFinite(x) && x >= 0 ? x : 0,
        y: Number.isFinite(y) && y >= 0 ? y : 0,
        w: Number.isFinite(w) && w >= 2 ? w : 2,
        h: Number.isFinite(h) && h >= 2 ? h : 2,
      });
      continue;
    }
    // Tolerance (v4/v5): an UNKNOWN widget type is skipped cleanly (one muted
    // log). The removed `group`/`frame`/`shortcut`/`links` types are covered.
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
    // A search bar needs 2 global rows (4 fine units) or it clips at every
    // common desktop size — same « correct on load, persist on next save » rule
    // as before, expressed in fine units (was h:1→2 on the 32-col grid).
    if (next.type === 'search' && next.h < 4) next.h = 4;
    out.push(next);
  }
  if (ignored.size) {
    console.warn(`[grid] ignoring unknown item type(s): ${[...ignored].join(', ')}`);
  }
  return out;
}
