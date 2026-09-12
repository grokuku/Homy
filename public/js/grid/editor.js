import { renderWidget, disposeWidget, getWidget, getDefaultSize, getSettingsSchema } from '../widgets/registry.js';
import { openSettingsModal } from '../ui/settingsModal.js';
import { toast } from '../ui/toast.js';
import { api } from '../api.js';
import { uuid, el } from '../util.js';
import { GRID_COLUMNS, GRID_ROWS, MAX_ITEMS, normalizeItems } from './config.js';

/**
 * Editable grid (edit mode): interactive gridstack + per-widget controls +
 * generic config modal. Persists changes via the `onSave` callback (debounced).
 *
 * Grid canvas: 32×18, square cells (cellHeight 'auto' → cell height = cell
 * width, and 32/18 = 16/9 so 18 rows fill a 16:9 viewport). `columns` is the
 * column count the incoming items were saved with (12 for legacy layouts):
 * the grid is initialized at that count, items are loaded, then — when it
 * differs from 32 — gridstack's native `column(32, 'moveScale')` reflow
 * rescales every x/w client-side. The caller must persist the result (the
 * 'change' event fired by column() plus the explicit save below).
 *
 * float: true = FREE VERTICAL PLACEMENT (review C7 fix): an item dropped in
 * the lower rows STAYS there, voluntary vertical holes are preserved (no
 * compaction toward the top) and the drag placeholder follows the real mouse
 * position (with float:false it stayed pinned to the compacted top row, which
 * read as a dark « shadow zone » glued to the top of the edit area). View mode
 * uses the same flag (viewer.js) so the rendered layout is IDENTICAL to the
 * saved positions. gridstack still forbids overlaps in both modes (collision
 * push). margin must stay a single symmetric value (square-cell contract),
 * see config.js (review C8).
 */
export function initEditor(container, items, { onSave, columns = GRID_COLUMNS }) {
  const meta = new Map(); // id -> { type, config }
  items.forEach((i) => meta.set(i.id, { type: i.type, config: i.config || {} }));

  // Class hook for the edit-mode-only grid lines (see style.css): the visual
  // grid must never appear in view mode nor on the login view.
  container.classList.add('editing-grid');

  const grid = window.GridStack.init(
    {
      staticGrid: false,
      cellHeight: 'auto', // square cells: height tracks cellWidth (= containerWidth/32)
      margin: 8, // INSIDE the cell: items snap to multiples of the cell width,
      // so the CSS grid lines (also at multiples) align with item edges.
      column: columns, // saved column count (12 for legacy) — migrated below if ≠ 32
      minRow: GRID_ROWS, // fixed 18-row canvas: gridstack's inline height stays 18*cellH
      maxRow: GRID_ROWS, // …and content can never exceed it → exact 16:9 fill
      float: true, // free vertical placement (review C7) — holes are preserved
      resizable: { handles: 'all' },
      draggable: { handle: '.grid-stack-item-content' },
    },
    container
  );

  grid.removeAll(false);
  // normalizeItems: geometry hardening + the deliberate search h:1→h:2 upgrade
  // (see config.js) — applied BEFORE the load so the 12→32 column reflow only
  // ever sees corrected geometry. The native reflow scales x/w by 32/columns
  // (±1 rounding); y only moves when an overlap must be resolved (h is
  // untouched) — with float:true saved rows are NEVER compacted upward
  // (measured on gridstack v13, see the migration comment above grid.column()).
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

  // ---- legacy column migration (12 → 32), BEFORE widgets are rendered so the
  // DOM node list is already final (columnChanged re-adds the same elements).
  const migrated = columns !== GRID_COLUMNS;
  if (migrated) {
    // Native reflow: scales x/w by 32/columns with rounding (±1 cell possible).
    // Row heights are unchanged by the migration (h is untouched); y only
    // moves when the rescaled footprint collides with a neighbour (engine
    // collision resolution) — no upward compaction with float:true (measured
    // on gridstack v13), matching the free-placement rule (review C7 fix).
    grid.column(GRID_COLUMNS, 'moveScale');
  }

  for (const node of grid.engine.nodes) {
    const item = loaded.find((i) => i.id === node.id);
    const contentEl = node.el.querySelector('.grid-stack-item-content');
    if (item && contentEl) {
      renderWidget(contentEl, item);
      attachControls(node.el, item.id);
    }
  }

  // ---- persistence (debounced, CANCELLABLE) ----
  // Unlike the shared debounce() helper, the timer is kept in a handle so a
  // page switch can FLUSH synchronously and CANCEL the pending tick: a stale
  // tick firing after the switch would re-send the old page's items (the
  // gridstack race guard would usually catch it, but cancellation removes the
  // race window entirely).
  let ready = false;
  let pendingSave = false; // a debounced save is scheduled but not yet run
  let saveTimer = 0;
  // Serialize from the LIVE engine nodes — NOT from grid.save(). gridstack's
  // removeInternalForSave() strips `w`/`h` whenever they equal 1, so a
  // grid.save()-based body silently dropped the geometry of every 1-cell item
  // and the server re-inflated it (review A1). node.w/node.h are always
  // defined here (gridstack defaults missing values at load/add time); the
  // `|| 1` guards are belt-and-braces for hand-crafted nodes.
  const serialize = () =>
    grid.engine.nodes.map((n) => {
      const m = meta.get(n.id) || { type: 'frame', config: {} };
      return { id: n.id, x: n.x, y: n.y, w: n.w || 1, h: n.h || 1, type: m.type, config: m.config };
    });
  const runSave = () => {
    saveTimer = 0;
    pendingSave = false;
    // Known race: a debounced save can fire after destroy() (fast edit→view
    // toggle). gridstack's destroy() deletes .engine/.opts — bail out quietly
    // instead of throwing inside the timer.
    if (!ready || !grid.engine) return;
    return onSave(serialize());
  };
  const scheduleSave = () => {
    pendingSave = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(runSave, 500);
  };
  /**
   * Flush a pending debounced save NOW and cancel its timer. Returns the
   * result of onSave() when a save actually ran (a promise when onSave is
   * async — main.js's switchPage awaits it), undefined when nothing was
   * pending. Used BEFORE page switches / grid teardown so a drag-edit made
   * in the 500 ms debounce window is never lost.
   */
  const flushSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (!pendingSave) return;
    pendingSave = false;
    if (ready && grid.engine) return onSave(serialize());
  };

  grid.on('change', scheduleSave);
  grid.on('added', scheduleSave);
  grid.on('removed', scheduleSave);
  ready = true;

  // After a legacy migration the rescaled coordinates must be persisted:
  // the 'change' event fired by grid.column() above happened before these
  // listeners were attached, so save explicitly (the debounce coalesces).
  if (migrated) scheduleSave();

  // ---- add widget ----
  function addWidget(type) {
    // Client-side cap (review C3): mirrors the server's MAX_ITEMS so a full
    // layout fails LOUDLY here instead of at PUT time (silent divergence).
    if (grid.engine.nodes.length >= MAX_ITEMS) {
      toast(`Cannot add widget: layout is full (max ${MAX_ITEMS} items)`, 'error');
      return null;
    }
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
    scheduleSave();
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
        scheduleSave();
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
    // The deletion is also carried by the debounced full PUT below (the server
    // replace() drops it) — this endpoint just reconciles faster. A failure is
    // surfaced, never swallowed (review C3): the PUT remains the source of truth.
    api.del(`/api/layout/items/${id}`).catch((err) => toast(err.message || 'Failed to delete item', 'error'));
    scheduleSave();
  }

  /**
   * Merge a config patch into the meta Map without touching geometry. Fed by
   * main.js's 'homy:widget-config' listener (review C4): widgets that persist
   * config changes outside the ⚙ modal (notes inline textarea) must keep this
   * cache fresh, or the next full-layout PUT would rewrite the stale config
   * and silently lose the user's text. Does NOT schedule a save: the widget's
   * own PATCH persists the change; this only keeps the next full PUT correct.
   */
  function applyConfig(id, config) {
    const m = meta.get(id);
    if (m && config && typeof config === 'object') {
      m.config = { ...(m.config || {}), ...config };
    }
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
    // Review C14: the vendored gridstack v13 drag engine has no
    // draggable.cancel — a mousedown on an interactive child (<a>, inputs,
    // buttons…) bubbles to the drag handle (.grid-stack-item-content), starts
    // an item drag on move, and its preventDefault() kills text selection in
    // e.g. the notes textarea. Block the bubbling AT the child, before the
    // handle sees it (children fire before their ancestors while bubbling).
    // stopPropagation() only — the native behavior (links, focus, typing,
    // clicks) is untouched.
    for (const interactive of contentEl.querySelectorAll('a, textarea, input, select, button')) {
      if (interactive.dataset.dragGuard) continue;
      interactive.dataset.dragGuard = '1';
      const stop = (e) => e.stopPropagation();
      interactive.addEventListener('mousedown', stop);
      interactive.addEventListener('touchstart', stop, { passive: true });
    }
  }

  return {
    addWidget,
    applyConfig,
    /** Flush a pending debounced save NOW (awaitable — see flushSave). */
    flush: flushSave,
    destroy() {
      // Flush a pending debounced save BEFORE gridstack tears the DOM down:
      // without this, a change (e.g. a drag) followed by an immediate
      // edit→view toggle inside the 500ms window would be silently lost.
      try {
        flushSave();
      } catch {
        /* ignore — the debounced path already guards */
      }
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
