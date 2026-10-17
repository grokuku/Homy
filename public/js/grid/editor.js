import { renderWidget, disposeWidget, getWidget, getDefaultSize, getSettingsSchema } from '../widgets/registry.js';
import { openSettingsModal } from '../ui/settingsModal.js';
import { toast } from '../ui/toast.js';
import { uuid, el } from '../util.js';
import { GRID_COLUMNS, GRID_ROWS, MAX_ITEMS, normalizeItems } from './config.js';

// Per-kind geometry minimums (layout v5). MUST mirror the server bounds in
// server/services/layout.service.js: every object is at least 2×2 fine units,
// an element (button) is capped at 4×4, a report may grow to the full canvas.
const MIN_OBJECT_SIZE = 2;
const MAX_ELEMENT_SIZE = 4;

/**
 * Editable grid (edit mode): interactive gridstack + per-object controls +
 * generic config modal. Persists changes via the `onSave` callback (debounced).
 *
 * Canvas (layout v5): 64×36 FINE units (1 unit = ½ global cell, 64/36 = 16/9),
 * so cells stay square with `cellHeight: 'auto'`. The grid is a single
 * gridstack hosting EVERY object (widgets, element placements, reports);
 * group boxes are NOT grid items — they live in the decorative background
 * layer owned by grid/groups.js. The persisted model is a flat v5 list:
 *
 *   widget : { id, kind:'widget', type, x, y, w, h, config }
 *   element: { id, kind:'element', elementId, x, y, w, h, options }
 *   report : { id, kind:'report', elementId, x, y, w, h }
 *
 * `serialize()` reproduces EXACTLY that shape from the live engine nodes,
 * preserving kind/elementId/options/config — a full PUT can never drop an
 * element/report's identity. It must never emit the legacy v4 keys
 * (type/config for an element, `buttons`/`reports`, …).
 *
 * float: true = FREE VERTICAL PLACEMENT: an item dropped in the lower rows
 * STAYS there, voluntary vertical holes are preserved (no compaction toward
 * the top) and the drag placeholder follows the real mouse position. gridstack
 * still forbids overlaps (collision push): a drop on an occupied cell PUSHES
 * the occupant. View mode uses the same flag (viewer.js) so the rendered
 * layout is IDENTICAL to the saved positions. margin must stay a single
 * symmetric value (square-cell contract), see config.js.
 */
export function initEditor(container, items, { onSave, columns = GRID_COLUMNS, cellHeight = 'auto' } = {}) {
  const meta = new Map(); // id -> normalized v5 object ({ kind, type|elementId, config|options })
  // normalizeItems MUST run before the meta cache is populated: it is the load
  // correction shared with the viewer (geometry hardening, search h→4 and the
  // element/report 2×2 minimum — see config.js). Feeding the CORRECTED items to
  // meta means the very next save persists exactly what is rendered.
  const loaded = normalizeItems(items);
  for (const i of loaded) meta.set(i.id, toMeta(i));

  // Class hook for the edit-mode-only grid lines (see style.css): the visual
  // grid must never appear in view mode nor on the login view.
  container.classList.add('editing-grid');

  const grid = window.GridStack.init(
    {
      staticGrid: false,
      // 'auto' = square cells; a positive NUMBER = the pinned row pitch (px)
      // computed by main.js so the editor's logical (view-sized) canvas keeps
      // the exact VIEW geometry even when the view canvas is stretched (see
      // grid/config.js computeCanvasFit).
      cellHeight: Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : 'auto',
      margin: 8, // INSIDE the cell: items snap to multiples of the cell width,
      // so the CSS grid lines (also at multiples) align with item edges.
      column: columns, // saved column count (12 for legacy) — migrated below if ≠ 64
      minRow: GRID_ROWS, // fixed 36-row canvas: gridstack's inline height stays 36*cellH
      maxRow: GRID_ROWS, // …and content can never exceed it → exact 16:9 fill
      float: true, // free vertical placement — holes are preserved
      resizable: { handles: 'all' },
      draggable: { handle: '.grid-stack-item-content' },
    },
    container
  );

  grid.removeAll(false);
  // `loaded` (normalized above) is used here so the 12→64 column reflow only
  // ever sees corrected geometry. Per-kind min/max geometry is enforced on the
  // gridstack nodes themselves, so the UI can never produce a layout the server
  // would refuse to save (element > 4×4, object < 2×2).
  grid.load(
    loaded.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      ...gridLimits(objectKind(item)),
      // Gridstack's default renderCB assigns `content` via textContent, so any
      // markup here would surface as literal text. Widgets render themselves
      // into .grid-stack-item-content, so keep this empty.
      content: '',
    }))
  );

  // ---- legacy column migration (12 → 64), BEFORE objects are rendered so the
  // DOM node list is already final (columnChanged re-adds the same elements).
  const migrated = columns !== GRID_COLUMNS;
  if (migrated) {
    // Native reflow: scales x/w by 64/columns with rounding (±1 cell possible).
    // Row heights are unchanged by the migration (h is untouched); y only
    // moves when the rescaled footprint collides with a neighbour (engine
    // collision resolution) — no upward compaction with float:true.
    grid.column(GRID_COLUMNS, 'moveScale');
  }

  for (const node of grid.engine.nodes) {
    const item = loaded.find((i) => i.id === node.id);
    const contentEl = node.el.querySelector('.grid-stack-item-content');
    if (item && contentEl) {
      renderWidget(contentEl, item, { editable: true });
      attachControls(node.el, item.id, { config: objectKind(item) === 'widget' });
    }
  }

  // ---- snapping: widgets live on the 2-fine-unit parity grid ----
  // Applied AFTER gridstack resolved the drop (the `change` event fires at
  // dragstop/resizestop), never during the gesture. `applyingSnap` guards the
  // re-entrancy triggered by our own grid.update() calls so x ↔ x±1 can never
  // oscillate; update() is only issued for values that actually change.
  let applyingSnap = false;
  function snapWidgets() {
    if (applyingSnap || !grid.engine) return;
    const updates = [];
    for (const n of grid.engine.nodes) {
      const m = meta.get(n.id);
      if (!m || m.kind !== 'widget') continue;
      const x = n.x || 0;
      const y = n.y || 0;
      const w = n.w || 1;
      const h = n.h || 1;
      const sx = x - (x % 2);
      const sy = y - (y % 2);
      const sw = Math.max(MIN_OBJECT_SIZE, w - (w % 2));
      const sh = Math.max(MIN_OBJECT_SIZE, h - (h % 2));
      if (sx !== x || sy !== y || sw !== w || sh !== h) {
        updates.push({ el: n.el, x: sx, y: sy, w: sw, h: sh });
      }
    }
    if (!updates.length) return;
    applyingSnap = true;
    try {
      for (const u of updates) grid.update(u.el, { x: u.x, y: u.y, w: u.w, h: u.h });
    } finally {
      applyingSnap = false;
    }
  }

  // ---- persistence (debounced, CANCELLABLE) ----
  // Unlike the shared debounce() helper, the timer is kept in a handle so a
  // page switch can FLUSH synchronously and CANCEL the pending tick: a stale
  // tick firing after the switch would re-send the old page's objects (the
  // gridstack race guard would usually catch it, but cancellation removes the
  // race window entirely).
  let ready = false;
  let pendingSave = false; // a debounced save is scheduled but not yet run
  let saveTimer = 0;
  // Serialize from the LIVE engine nodes — NOT from grid.save(). gridstack's
  // removeInternalForSave() strips `w`/`h` whenever they equal 1, so a
  // grid.save()-based body silently dropped the geometry of every 1-cell item.
  // node.w/node.h are always defined here; the `|| 1` guards are belt-and-braces.
  const serialize = () =>
    grid.engine.nodes
      .map((n) => {
        const m = meta.get(n.id);
        if (!m) return null;
        const x = n.x || 0;
        const y = n.y || 0;
        const w = n.w || 1;
        const h = n.h || 1;
        if (m.kind === 'element') {
          return { id: n.id, kind: 'element', elementId: m.elementId, x, y, w, h, options: m.options || {} };
        }
        if (m.kind === 'report') {
          return { id: n.id, kind: 'report', elementId: m.elementId, x, y, w, h };
        }
        return { id: n.id, kind: 'widget', type: m.type, x, y, w, h, config: m.config || {} };
      })
      .filter(Boolean);
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

  // ONE mutation per gesture: gridstack fires `change` once the drag/resize
  // settles (dragstop/resizestop), `added`/`removed` once per add/delete.
  // Snap first (widget parity), then arm the debounce so the persisted body
  // carries the SNAPPED geometry.
  grid.on('change', () => {
    snapWidgets();
    scheduleSave();
  });
  grid.on('added', () => {
    snapWidgets();
    scheduleSave();
  });
  grid.on('removed', scheduleSave);
  ready = true;

  // After a legacy migration the rescaled coordinates must be persisted:
  // the 'change' event fired by grid.column() above happened before these
  // listeners were attached, so save explicitly (the debounce coalesces).
  if (migrated) scheduleSave();

  // ---- add object ----
  /**
   * Add an object to the grid. `draft` is a v5 object (kind + geometry +
   * type/config for widgets, elementId/options for elements, elementId for
   * reports). Per-kind min/max geometry is applied to the gridstack node so
   * resize can never leave the bounds. Returns the created object, or null
   * when the layout is full.
   */
  function addObject(draft) {
    // Client-side cap: mirrors the server's MAX_OBJECTS_PER_PAGE so a full
    // layout fails LOUDLY here instead of at PUT time (silent divergence).
    if (grid.engine.nodes.length >= MAX_ITEMS) {
      toast(`Cannot add object: layout is full (max ${MAX_ITEMS} objects)`, 'error');
      return null;
    }
    const kind = objectKind(draft);
    const limits = gridLimits(kind);
    const id = typeof draft.id === 'string' && draft.id ? draft.id : uuid();
    const w = clampSize(draft.w, limits.minW, limits.maxW);
    const h = clampSize(draft.h, limits.minH, limits.maxH);
    const x = Math.max(0, Math.floor(Number(draft.x)) || 0);
    const y = Math.max(0, Math.floor(Number(draft.y)) || 0);
    const item = { id, kind, x, y, w, h };
    if (kind === 'widget') {
      item.type = String(draft.type || '');
      item.config = draft.config && typeof draft.config === 'object' ? draft.config : {};
    } else {
      item.elementId = String(draft.elementId || '');
      if (kind === 'element') item.options = draft.options && typeof draft.options === 'object' ? draft.options : {};
    }
    // gridstack v13 types addWidget() as `GridItemHTMLElement | undefined`:
    // it returns the item element, not a GridStackNode with `.id`/`.el`.
    // Resolve the item element from the engine via the id we control.
    grid.addWidget({ id, x, y, w, h, ...limits, content: '' });
    meta.set(id, toMeta(item));
    const itemEl = grid.engine.nodes.find((n) => n.id === id)?.el;
    const contentEl = itemEl?.querySelector('.grid-stack-item-content');
    if (itemEl && contentEl) {
      renderWidget(contentEl, item, { editable: true });
      attachControls(itemEl, id, { config: kind === 'widget' });
    }
    scheduleSave();
    return item;
  }

  /** Palette entry point: add a WIDGET by type at its manifest default size. */
  function addWidget(type) {
    const size = getDefaultSize(type);
    const res = addObject({ kind: 'widget', type, x: 0, y: 0, w: size.w, h: size.h, config: {} });
    return res ? res.id : null;
  }

  // ---- config modal (generic, schema-driven) ----
  function openConfig(id) {
    const m = meta.get(id);
    if (!m || m.kind !== 'widget') return;
    const w = getWidget(m.type);
    if (!w) return;
    openSettingsModal({
      itemId: id,
      title: `Edit ${w.name}`,
      schema: getSettingsSchema(m.type),
      config: m.config || {},
      onSaved: (newConfig) => {
        m.config = newConfig;
        const node = grid.engine.nodes.find((n) => n.id === id);
        const contentEl = node?.el?.querySelector('.grid-stack-item-content');
        if (contentEl) {
          renderWidget(
            contentEl,
            { id, kind: 'widget', type: m.type, x: node?.x || 0, y: node?.y || 0, w: node?.w || 1, h: node?.h || 1, config: newConfig },
            { editable: true }
          );
          attachControls(node.el, id, { config: true });
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
      // gridstack fires `removed` → ONE debounced PUT carries the deletion.
      // No dedicated DELETE call: a gesture must produce a SINGLE mutation, and
      // the full PUT is the source of truth (it also keeps group boxes intact —
      // a group is never an object and is never touched here).
      grid.removeWidget(node.el, true);
    }
    meta.delete(id);
  }

  /**
   * Merge a config patch into the meta cache without touching geometry. Fed by
   * main.js's 'homy:widget-config' listener: widgets that persist config
   * changes outside the ⚙ modal (notes inline textarea) must keep this cache
   * fresh, or the next full-layout PUT would rewrite the stale config and
   * silently lose the user's text. Does NOT schedule a save: the widget's own
   * PATCH persists the change; this only keeps the next full PUT correct.
   */
  function applyConfig(id, config) {
    const m = meta.get(id);
    if (m && m.kind === 'widget' && config && typeof config === 'object') {
      m.config = { ...(m.config || {}), ...config };
    }
  }

  function attachControls(itemEl, id, { config = true } = {}) {
    const contentEl = itemEl.querySelector('.grid-stack-item-content');
    if (!contentEl) return;
    const controls = el('div', 'widget-controls');
    const delBtn = el('button', 'del', '✕', { type: 'button', title: 'Delete', 'aria-label': 'Delete' });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWidget(id);
    });
    if (config) {
      const editBtn = el('button', null, '⚙', { type: 'button', title: 'Edit', 'aria-label': 'Edit' });
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openConfig(id);
      });
      controls.appendChild(editBtn);
    }
    controls.appendChild(delBtn);
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
    addObject,
    applyConfig,
    /**
     * Live geometry of every object, straight from the engine nodes (the source
     * of truth for the next PUT). Used by the L4 group engine to FREEZE the
     * member list at drag start — `contains()` runs on these exact rects.
     */
    getObjectRects() {
      return grid.engine.nodes.map((n) => {
        const m = meta.get(n.id);
        return {
          id: n.id,
          kind: m?.kind || 'widget',
          x: n.x || 0,
          y: n.y || 0,
          w: n.w || 1,
          h: n.h || 1,
        };
      });
    },
    /** Gridstack item element for an object id (L4 live member transform). */
    getObjectElement(id) {
      return grid.engine.nodes.find((n) => n.id === id)?.el || null;
    },
    /**
     * Move objects to EXACT positions WITHOUT gridstack collision resolution.
     *
     * The L4 group drag translates every frozen member by the SAME delta, so the
     * final arrangement has no member/member overlap — but a naive `grid.update()`
     * per member would still push a not-yet-moved member whose ORIGINAL cell the
     * moved one transiently crosses (gridstack resolves collisions on each call
     * and `collideAll`'s skip is a single node, not a list). We therefore write
     * the target geometry straight onto the engine nodes and re-render with
     * gridstack's own `_writeAttr()` (the exact path a real drag uses). One
     * debounced save is scheduled for the whole batch.
     */
    commitObjectRects(list) {
      if (!Array.isArray(list) || !list.length) return;
      let changed = false;
      for (const entry of list) {
        if (!entry || entry.id == null) continue;
        const node = grid.engine.nodes.find((n) => n.id === entry.id);
        if (!node) continue;
        const x = Math.max(0, Math.floor(Number(entry.x)) || 0);
        const y = Math.max(0, Math.floor(Number(entry.y)) || 0);
        if (x === node.x && y === node.y) continue;
        node.x = x;
        node.y = y;
        node._dirty = true;
        if (typeof grid._writeAttr === 'function') grid._writeAttr(node.el, node);
        else grid.update(node.el, { x, y });
        changed = true;
      }
      if (changed) scheduleSave();
    },
    /**
     * Remove objects from the live grid. Each gridstack `removeWidget` fires
     * `removed`, which the debounce coalesces into ONE PUT carrying the
     * remaining objects (used by L4 « Delete group + contents »).
     */
    removeObjects(ids) {
      const set = new Set(Array.isArray(ids) ? ids : []);
      if (!set.size) return;
      for (const node of [...grid.engine.nodes]) {
        if (!set.has(node.id)) continue;
        const contentEl = node.el?.querySelector('.grid-stack-item-content');
        if (contentEl) disposeWidget(contentEl);
        grid.removeWidget(node.el, true);
        meta.delete(node.id);
      }
    },
    /**
     * Update the pinned row pitch (px) from main.js after a resize / geometry
     * change. With an explicit cellHeight gridstack no longer tracks
     * clientWidth (its auto ResizeObserver path is off), so the owner must
     * push the fresh value — keeps the inline container height == --canvas-h.
     */
    setCellHeight(h) {
      if (Number.isFinite(h) && h > 0) grid.cellHeight(h);
    },
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

// ---------------------------------------------------------------------------
// v5 object helpers
// ---------------------------------------------------------------------------

/** The v5 discriminant of an object; anything that is not element/report is a widget. */
function objectKind(item) {
  return item && (item.kind === 'element' || item.kind === 'report') ? item.kind : 'widget';
}

/**
 * gridstack min/max geometry per kind. Mirrors the server bounds:
 * widget ≥ 2×2, element 2×2..4×4, report 2×2..64×36.
 */
function gridLimits(kind) {
  if (kind === 'element') {
    return { minW: MIN_OBJECT_SIZE, minH: MIN_OBJECT_SIZE, maxW: MAX_ELEMENT_SIZE, maxH: MAX_ELEMENT_SIZE };
  }
  if (kind === 'report') {
    return { minW: MIN_OBJECT_SIZE, minH: MIN_OBJECT_SIZE, maxW: GRID_COLUMNS, maxH: GRID_ROWS };
  }
  return { minW: MIN_OBJECT_SIZE, minH: MIN_OBJECT_SIZE }; // widget
}

/** Normalized meta entry: the persisted identity fields of an object. */
function toMeta(item) {
  const kind = objectKind(item);
  const base = { id: item.id, kind, x: item.x, y: item.y, w: item.w, h: item.h };
  if (kind === 'element') {
    return { ...base, elementId: String(item.elementId || ''), options: plainObject(item.options) };
  }
  if (kind === 'report') {
    return { ...base, elementId: String(item.elementId || '') };
  }
  return { ...base, type: String(item.type || ''), config: plainObject(item.config) };
}

function clampSize(value, min, max) {
  const n = Math.floor(Number(value));
  const v = Number.isFinite(n) && n > 0 ? n : min;
  return Math.min(max, Math.max(min, v));
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
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
