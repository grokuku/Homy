import { renderWidget, disposeWidget, getWidget, getDefaultSize, getSettingsSchema } from '../widgets/registry.js';
import { openSettingsModal } from '../ui/settingsModal.js';
import { api } from '../api.js';
import { uuid, debounce, el } from '../util.js';

/**
 * Editable grid (edit mode): interactive gridstack + per-widget controls +
 * generic config modal. Persists changes via the `onSave` callback (debounced).
 */
export function initEditor(container, items, { onSave }) {
  const meta = new Map(); // id -> { type, config }
  items.forEach((i) => meta.set(i.id, { type: i.type, config: i.config || {} }));

  const grid = window.GridStack.init(
    {
      staticGrid: false,
      cellHeight: 80,
      margin: 8,
      column: 12,
      float: false,
      resizable: { handles: 'all' },
      draggable: { handle: '.grid-stack-item-content' },
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

  for (const node of grid.engine.nodes) {
    const item = items.find((i) => i.id === node.id);
    const contentEl = node.el.querySelector('.grid-stack-item-content');
    if (item && contentEl) {
      renderWidget(contentEl, item);
      attachControls(node.el, item.id);
    }
  }

  // ---- persistence (debounced) ----
  let ready = false;
  const save = debounce(() => {
    if (!ready) return;
    const serialized = grid.save(false).map((n) => {
      const m = meta.get(n.id) || { type: 'frame', config: {} };
      return { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, type: m.type, config: m.config };
    });
    onSave(serialized);
  }, 500);

  grid.on('change', save);
  grid.on('added', save);
  grid.on('removed', save);
  ready = true;

  // ---- add widget ----
  function addWidget(type) {
    const size = getDefaultSize(type);
    const id = uuid();
    // gridstack v13 types addWidget() as `GridItemHTMLElement | undefined`:
    // it returns the item element, not a GridStackNode with `.id`/`.el`.
    // Don't depend on the return value — resolve the item element from the
    // engine via the id we control, and guard against a missing node.
    grid.addWidget({
      id,
      x: 0,
      y: 0,
      w: size.w,
      h: size.h,
      // See grid.load() above: content is assigned via textContent by gridstack.
      content: '',
    });
    meta.set(id, { type, config: {} });
    const itemEl = grid.engine.nodes.find((n) => n.id === id)?.el;
    const contentEl = itemEl?.querySelector('.grid-stack-item-content');
    if (itemEl && contentEl) {
      renderWidget(contentEl, { id, type, config: {} });
      attachControls(itemEl, id);
    }
    save();
    return id;
  }

  // ---- config modal (generic, schema-driven) ----
  function openConfig(id) {
    const m = meta.get(id);
    const w = getWidget(m?.type);
    if (!w) return;
    openSettingsModal({
      itemId: id,
      title: `Edit ${w.name}`,
      schema: getSettingsSchema(m?.type),
      config: m.config || {},
      onSaved: (newConfig) => {
        m.config = newConfig;
        const node = grid.engine.nodes.find((n) => n.id === id);
        const contentEl = node?.el?.querySelector('.grid-stack-item-content');
        if (contentEl) {
          renderWidget(contentEl, { id, type: m.type, config: newConfig });
          attachControls(node.el, id);
        }
        save();
      },
    });
  }

  // ---- delete ----
  function removeWidget(id) {
    const node = grid.engine.nodes.find((n) => n.id === id);
    if (node) {
      const contentEl = node.el?.querySelector('.grid-stack-item-content');
      if (contentEl) disposeWidget(contentEl);
      grid.removeWidget(node.el, true);
    }
    meta.delete(id);
    api.del(`/api/layout/items/${id}`).catch(() => {});
    save();
  }

  function attachControls(itemEl, id) {
    const contentEl = itemEl.querySelector('.grid-stack-item-content');
    if (!contentEl) return;
    const controls = el('div', 'widget-controls');
    const editBtn = el('button', null, '⚙', { type: 'button', title: 'Edit', 'aria-label': 'Edit' });
    const delBtn = el('button', 'del', '✕', { type: 'button', title: 'Delete', 'aria-label': 'Delete' });
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openConfig(id);
    });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWidget(id);
    });
    controls.append(editBtn, delBtn);
    contentEl.appendChild(controls);
    itemEl.classList.add('editing');
  }

  return {
    addWidget,
    destroy() {
      // Dispose every widget's cleanup (timers) before gridstack tears the DOM down.
      for (const node of grid.engine.nodes) {
        const contentEl = node.el?.querySelector('.grid-stack-item-content');
        if (contentEl) disposeWidget(contentEl);
      }
      grid.destroy();
    },
  };
}

/**
 * Render the widget palette (edit mode). `onAdd(type)` is called when a
 * palette item is clicked. Shows icon, name, description and default size.
 */
export function renderPalette(paletteEl, widgets, onAdd) {
  paletteEl.replaceChildren();
  for (const w of widgets) {
    const item = el('button', 'palette-item', null, { type: 'button' });
    const head = el('div', 'palette-head');
    head.appendChild(el('span', 'palette-icon', w.icon || ''));
    head.appendChild(el('span', null, w.name));
    item.appendChild(head);
    item.appendChild(el('small', null, w.description || ''));
    item.appendChild(el('small', 'palette-size', `${w.defaultSize?.w || 4}×${w.defaultSize?.h || 3}`));
    item.addEventListener('click', () => onAdd(w.type));
    paletteEl.appendChild(item);
  }
}
