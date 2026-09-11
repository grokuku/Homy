import { renderWidget, disposeWidget } from '../widgets/registry.js';

/**
 * Render a locked (non-interactive) grid in view mode.
 * Returns a wrapper around the gridstack instance with a `destroy()` that also
 * disposes every widget's cleanup (timers) before teardown.
 */
export function renderViewer(container, items) {
  const grid = window.GridStack.init(
    {
      staticGrid: true,
      cellHeight: 80,
      margin: 8,
      column: 12,
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
      content: '<div></div>',
    }))
  );

  const contentEls = [];
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
