import { renderWidget } from '../widgets/registry.js';

/**
 * Render a locked (non-interactive) grid in view mode.
 * Returns the gridstack instance.
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

  for (const node of grid.engine.nodes) {
    const item = items.find((i) => i.id === node.id);
    const contentEl = node.el.querySelector('.grid-stack-item-content');
    if (item && contentEl) renderWidget(contentEl, item);
  }

  return grid;
}
