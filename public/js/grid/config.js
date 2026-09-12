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
export const GRID_COLUMNS = 32;
export const GRID_ROWS = 18;
export const LEGACY_COLUMNS = 12;

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
 * Two adjustments (review C1):
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
  return (Array.isArray(items) ? items : []).map((item) => {
    const w = Math.floor(Number(item.w));
    const h = Math.floor(Number(item.h));
    const out = {
      ...item,
      w: Number.isFinite(w) && w >= 1 ? w : 1,
      h: Number.isFinite(h) && h >= 1 ? h : 1,
    };
    if (out.type === 'search' && out.h === 1) out.h = 2;
    return out;
  });
}
