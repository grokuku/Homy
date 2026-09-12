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
 */
export const GRID_COLUMNS = 32;
export const GRID_ROWS = 18;
export const LEGACY_COLUMNS = 12;