import { renderWidget, disposeWidget } from '../widgets/registry.js';
import { GRID_COLUMNS, GRID_ROWS, normalizeItems } from './config.js';

/**
 * Render a locked (non-interactive) grid in view mode.
 * Returns the gridstack instance itself with an overridden `destroy()` that
 * also disposes every widget's cleanup (timers) before teardown (review C6:
 * the previous `{ ...grid }` spread returned a plain object that lost every
 * GridStack prototype method — the REAL instance keeps the full API).
 *
 * Same 32×18 square-cell canvas as the editor, the same item normalization
 * (search h:1→h:2, see grid/config.js) and the same client-side legacy column
 * migration — but NO persistence: the viewer is static, it only applies
 * `column(32, 'moveScale')` at display time so a legacy 12-column layout shows
 * exactly like it will once the editor saves it. The normalization MUST run
 * here too: with the old h=1 the float:false load compacts following items
 * one row up, which would make the viewer disagree with the editor on y.
 * Note: unlike the editor, no `editing-grid` class is added → the visual grid
 * lines stay edit-mode-only.
 */
export function renderViewer(container, items, { columns = GRID_COLUMNS } = {}) {
  const grid = window.GridStack.init(
    {
      staticGrid: true,
      cellHeight: 'auto', // square cells (same canvas as the editor)
      margin: 8,
      column: columns, // saved column count (12 for legacy) — migrated below if ≠ 32
      minRow: GRID_ROWS, // fixed 18-row canvas (same as the editor)
      maxRow: GRID_ROWS,
      float: false,
    },
    container
  );

  grid.removeAll(false);
  // Same normalization as the editor (config.js): geometry hardening + the
  // deliberate search h:1→h:2 upgrade. Applied BEFORE the load so the 12→32
  // column reflow only sees corrected geometry — and so the viewer's rendered
  // layout is IDENTICAL to what the editor will persist (viewer == editor).
  const loaded = normalizeItems(items);
  grid.load(
    loaded.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      // Gridstack's default renderCB assigns `content` via textContent, so any
      // markup here would surface as literal text. Widgets render themselves
      // into .grid-stack-item-content, so keep this empty.
      content: '',
    }))
  );

  const contentEls = [];
  // ---- legacy column migration (12 → 32) at display time (never persisted
  // here — the editor owns saving). Same reflow as initEditor → the viewer
  // and editor always agree on positions.
  if (columns !== GRID_COLUMNS) {
    grid.column(GRID_COLUMNS, 'moveScale');
  }

  for (const node of grid.engine.nodes) {
    const item = loaded.find((i) => i.id === node.id);
    const contentEl = node.el.querySelector('.grid-stack-item-content');
    if (item && contentEl) {
      renderWidget(contentEl, item);
      contentEls.push(contentEl);
    }
  }

  // Return the REAL instance (review C6): the previous `{ ...grid }` spread
  // produced a plain object that lost every GridStack prototype method.
  // An own-property destroy() shadows the prototype method for this instance
  // only — gridstack never calls this.destroy() internally, so it is safe.
  const originalDestroy = grid.destroy.bind(grid);
  grid.destroy = () => {
    for (const contentEl of contentEls) disposeWidget(contentEl);
    contentEls.length = 0;
    originalDestroy();
  };
  return grid;
}
