/**
 * Grid canvas constants — shared by editor.js, viewer.js and main.js.
 *
 * The dashboard grid is a fixed 64×36 canvas (64 columns × 36 rows — the v5
 * fine trame, 1 unit = ½ global cell). 64/36 = 16/9, so with square cells the
 * 36-row grid fills exactly the height of a 16:9 screen, which enables precise
 * placement and true screen-centering of widgets. The canvas is ALWAYS fitted
 * with a single uniform scale (see computeCanvasFit below): the trame is NEVER
 * anisotropic, at any window size.
 *
 * Legacy layouts (before the columns field existed in layout.json) were
 * built on a 12-column grid with a fixed 80px cell height; their x/w
 * coordinates are migrated client-side via gridstack's native
 * `column(GRID_COLUMNS, 'moveScale')` reflow (see editor.js / viewer.js).
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
 * would skew every cell and desync the 36-row fit from the 16:9 aspect box.
 */
import { getWidget } from '../widgets/registry.js';

export const GRID_COLUMNS = 64;
export const GRID_ROWS = 36;
export const LEGACY_COLUMNS = 12;

/** Design aspect of the canvas (64 columns / 36 rows = 16/9). */
export const CANVAS_ASPECT = GRID_COLUMNS / GRID_ROWS;

/**
 * Fit the 64×36 canvas into an available content box (CSS px).
 *
 * UNIFORM, ADAPTIVE FIT (user decision): ONE scale factor for both axes,
 *
 *   scale = min(availW / 64, availH / 36)   // px per fine cell, both axes
 *
 * so the canvas always takes the LARGEST 16:9 box that fits the available
 * area (≈100 % of the area on the constraining axis, margins only on the
 * other one) and its cells are EXACTLY square (cellAspect === 1, ratio 1.000)
 * at every window size. The canvas therefore still ADAPTS to the screen (its
 * size is a pure function of the measured area, never a fixed size) — it is
 * simply never stretched: a 16/9 window fills completely, a 4/3 window gets
 * pillarbox margins (left/right) and an ultra-wide one letterbox margins
 * (top/bottom), both CENTERED by the layout (see style.css: `.grid-wrap` is a
 * flex box and `#grid-container` uses `margin: auto`, which is the overflow-…
 * safe form of centering).
 *
 * The previous « fill with bounded tolerance » regime (a ±20 % cell stretch
 * with a ±2 % snap dead band) is GONE: it deformed the trame on purpose and
 * is what the user asked to remove. Nothing else changed — 64×36, the saved
 * coordinates and the layout data are untouched; only the DISPLAYED scale
 * changes.
 *
 * Returns `{ mode, width, height, scale, cellAspect }` or null for a
 * non-measurable box. Pure: callers decide how (and whether) to pin the
 * result.
 */
export function computeCanvasFit(availW, availH) {
  const w = Number(availW);
  const h = Number(availH);
  if (!(w > 0) || !(h > 0)) return null;
  const scale = Math.min(w / GRID_COLUMNS, h / GRID_ROWS);
  return {
    mode: 'uniform',
    width: scale * GRID_COLUMNS,
    height: scale * GRID_ROWS,
    scale,
    cellAspect: 1,
  };
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
 *    philosophy as the legacy 12→64 column reflow: the editor persists the
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
