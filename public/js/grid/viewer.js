import { renderWidget, disposeWidget } from '../widgets/registry.js';
import { GRID_COLUMNS, GRID_ROWS } from './config.js';

/**
 * Render a locked (non-interactive) grid in view mode.
 * Returns a wrapper around the gridstack instance with a `destroy()` that also
 * disposes every widget's cleanup (timers) before teardown.
 *
 * Same 32×18 square-cell canvas as the editor, and the same client-side legacy
 * column migration — but NO persistence: the viewer is static, it only applies
 * `column(32, 'moveScale')` at display time so a legacy 12-column layout shows
 * exactly like it will once the editor saves it. Note: unlike the editor, no
 * `editing-grid` class is added → the visual grid lines stay edit-mode-only.
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
  grid.load(
    items.map((item) => ({
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
    const item = items.find((i) => i.id === node.id);
    const contentEl = node.el.querySelector('.grid-stack-item-content');
    if (item && contentEl) {
      renderWidget(contentEl, item);
      contentEls.push(contentEl);
    }
  }

  const originalDestroy = grid.destroy.bind(grid);
  return {
    ...grid,
    destroy() {
      for (const contentEl of contentEls) disposeWidget(contentEl);
      contentEls.length = 0;
      originalDestroy();
    },
  };
}
