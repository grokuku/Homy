/**
 * Group / selection editing engine (layout v5, lots L4 + L6).
 *
 * This module is the single pointer + keyboard brain of the EDIT canvas. It
 * drives the selection STORE (grid/selection.js), the group layer
 * (grid/groups.js), the object grid (grid/editor.js) and the floating bar
 * (grid/selectionBar.js). It owns NO persisted state of its own.
 *
 * ── L4 (delivered) ────────────────────────────────────────────────────────
 *   - GROUP selection on click (pure `hitGroups`) + object multi-selection.
 *   - GROUP drag (members frozen at mousedown, one shared delta, parity
 *     preserving, canvas clamp, no-overlap refusal with a ~120 ms alert ring)
 *     and SE resize (min 4×4, growth stopped at first contact).
 *   - « Group selection » (bbox±2, margin 0 fallback, refusal + toast, absorbs
 *     the selected groups), Ungroup, Delete group + contents (2-step).
 *
 * ── L6 (this lot) ──────────────────────────────────────────────────────────
 *   - SELECTION gestures: click replaces, Ctrl/Cmd-click toggles (XOR),
 *     Shift-click is UNION-ONLY (never removes), empty-canvas click clears,
 *     Escape cancels the lasso else clears, Ctrl+A selects every object + group
 *     of the active page (EDIT only, never inside a text field / modal).
 *   - LASSO: a left press on empty canvas (no Ctrl/Meta) arms a lasso; only past
 *     LASSO_THRESHOLD px does the marquee appear. Objects are caught by
 *     INTERSECTION (area > 0), groups by CONTAINMENT (fully inside). Shift =
 *     additive (XOR on what is met, never clearing the rest). Escape cancels an
 *     in-flight lasso (restores the previous selection). Marquee + halos live in
 *     the EDIT-only `.overlay-layer` (pointer-events:none). Live counter via the
 *     coalesced homy:selection event (rAF). NOTHING is persisted.
 *   - RIGID TRANSLATION: dragging an ALREADY-selected item while the selection
 *     size ≥ 2 translates the WHOLE selection by ONE delta (clamped by the
 *     tightest constraint: canvas for objects, no-overlap for groups). ONE
 *     mutation at mouseup.
 *   - KEYBOARD DELETE (Delete / Backspace): objects removed, groups DISSOLVED
 *     (contents kept), mixed = both. Never removes contents — that stays the
 *     2-step « Delete group + contents ». Guarded against text fields, modals,
 *     in-flight gestures and page transitions.
 *
 * Pointer routing priority at mousedown: (1) an EDIT-only overlay handle,
 * (2) an object inside `.grid-stack-item`, (3) a group box (`hitGroups`),
 * (4) empty canvas → lasso / clear.
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { el, uuid } from '../util.js';
import { toast } from '../ui/toast.js';
import { openSettingsModal } from '../ui/settingsModal.js';
import { APPEARANCE_FIELDS } from '../widgets/registry.js';
import { catalog } from '../elements/catalog.js';
import { openElementsModal } from '../ui/elementsModal.js';
import { closeContextMenu, isContextMenuOpen, openContextMenu } from '../ui/contextMenu.js';
import { contains, groupRect, hitGroups, rectsIntersect } from './groups.js';
import { GRID_COLUMNS, GRID_ROWS } from './config.js';
import { selection } from './selection.js';
import { emitSelection } from './selectionEvents.js';
import { createSelectionBar } from './selectionBar.js';
import {
  canvasMenuItems,
  elementMenuItems,
  groupMenuItems,
  reportMenuItems,
  widgetMenuItems,
} from './contextMenuItems.js';

/** Pixels of pointer travel before a press becomes a drag / a lasso. */
export const DRAG_THRESHOLD = 4;
/** Pixels before an empty-canvas press becomes a lasso (no flicker on a click). */
export const LASSO_THRESHOLD = 4;
/** A group box is at least 4×4 fine units (mirrors server MIN_GROUP). */
const GROUP_MIN = 4;
/** Units of margin added on each side when grouping a selection. */
const GROUP_MARGIN = 2;
/** Debounce before a group config write leaves the client (bar live edits). */
const GROUP_PATCH_MS = 400;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Group config schema (front-only — the group is NOT a widget, so it is not
 * part of the server widget manifest nor of scripts/check-schema-sync.mjs).
 * The write path is PATCH /api/layout/groups/:id via openSettingsModal's
 * `save` override; the server's normalizeGroupConfig tolerates every field.
 * The removed `zoom`/`tileInset` keys are gone for good.
 */
const GROUP_SETTINGS_SCHEMA = {
  fields: [
    { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Group name' },
    {
      key: 'titleVisibility',
      label: 'Title visibility',
      type: 'select',
      default: 'always',
      options: [
        { value: 'always', label: 'Always' },
        { value: 'hover', label: 'On hover' },
        { value: 'never', label: 'Never' },
      ],
    },
    ...APPEARANCE_FIELDS,
  ],
};

const NO_GUARDS = {
  isTextEntryTarget: () => false,
  isOverlayOpen: () => false,
  isPaletteOverlayOpen: () => false,
  isInteractionActive: () => false,
  isTransitionActive: () => false,
};

export function createGroupEditor({ previewEl, groupLayer, getGrid, guards: guardsOpt, canvasActions }) {
  const guards = { ...NO_GUARDS, ...(guardsOpt || {}) };
  const canvasMenuActions = canvasActions && typeof canvasActions === 'object' ? canvasActions : {};
  let mode = 'view';
  let gesture = null; // active group drag/resize
  let rigid = null; // active rigid multi-selection translation
  let lasso = null; // active marquee
  let clickState = null; // a press that may resolve into a selection click / lasso
  let selectionSource = 'click';
  let marquee = null; // the .group-marquee node (overlay)
  const handleSets = new Map(); // groupId -> handle DOM
  const groupPatchTimers = new Map(); // groupId -> debounce timer
  let groupRenderScheduled = false;
  let menuConfirmTimer = 0; // armed « Delete group + contents » from the menu

  // ---- floating bar (L6 — replaces the L4 minimal bar) ----------------------
  const bar = createSelectionBar({
    getGrid,
    getGroups: () => state.layoutGroups,
    actions: {
      group: () => groupSelection(),
      dissolveGroups: () => dissolveSelectedGroups(),
      deleteSelection: (source) => deleteSelection(source || 'click'),
      deleteGroupsWithContents: () => deleteGroupsWithContents(),
      editGroup: (id) => editGroup(id),
      setGroupConfig: (id, patch) => setGroupConfig(id, patch),
    },
  });

  const totalSelection = () => selection.objects.size + selection.groups.size;

  /** Tag the selection source for the coalesced homy:selection event. */
  function withSource(source, fn) {
    selectionSource = source || 'click';
    try {
      return fn();
    } finally {
      selectionSource = 'click';
    }
  }

  // ---- selection visuals ----------------------------------------------------
  const unsubscribeSelection = selection.onChange(() => {
    applySelection();
    emitSelection(selectionSource);
  });

  function applySelection() {
    groupLayer.setSelectedGroups(selection.groups);
    const selected = selection.objects;
    for (const node of previewEl.querySelectorAll('.grid-stack-item')) {
      const id = node.gridstackNode?.id ?? node.getAttribute('gs-id');
      node.classList.toggle('grid-object-selected', id != null && selected.has(String(id)));
    }
    syncHandles();
  }

  // ---- handles (overlay) ----------------------------------------------------
  function createHandleSet(id) {
    const wrap = el('div', 'group-handle-set', null, { 'data-group-id': String(id) });
    for (const edge of ['n', 's', 'e', 'w']) {
      const e = el('div', 'group-edge', null, { 'data-edge': edge });
      e.dataset.handle = 'move';
      wrap.appendChild(e);
    }
    const se = el('div', 'group-handle', null, { 'data-handle': 'se' });
    wrap.appendChild(se);
    return wrap;
  }

  function positionHandleSet(wrap, group) {
    const r = groupRect(group);
    const uw = 'var(--unit-w, 1px)';
    const uh = 'var(--unit-h, 1px)';
    wrap.style.left = `calc(${r.x} * ${uw})`;
    wrap.style.top = `calc(${r.y} * ${uh})`;
    wrap.style.width = `calc(${r.w} * ${uw})`;
    wrap.style.height = `calc(${r.h} * ${uh})`;
  }

  function clearHandles() {
    for (const wrap of handleSets.values()) wrap.remove();
    handleSets.clear();
  }

  /**
   * Keep the overlay handles in sync with the visible ids: the SELECTED groups
   * (persistent rings, L6 multi-selection) plus the currently HOVERED one (set
   * by groups.js's mousemove hit-test). Idempotent — only the diff changes.
   */
  function syncHandles() {
    const overlay = groupLayer.overlay;
    if (mode !== 'edit' || !overlay.isConnected) {
      clearHandles();
      return;
    }
    const ids = new Set();
    const hovered = groupLayer.getHoveredId();
    if (hovered != null) ids.add(String(hovered));
    for (const id of selection.groups) ids.add(String(id));
    for (const [id, wrap] of handleSets) {
      if (!ids.has(id)) {
        wrap.remove();
        handleSets.delete(id);
      }
    }
    for (const id of ids) {
      const g = groupLayer.findGroup(id);
      if (!g) continue;
      let wrap = handleSets.get(id);
      if (!wrap) {
        wrap = createHandleSet(id);
        handleSets.set(id, wrap);
        overlay.appendChild(wrap);
      }
      positionHandleSet(wrap, g);
    }
  }

  // ---- pointer routing ------------------------------------------------------
  function onPreviewMouseDown(e) {
    if (mode !== 'edit' || e.button !== 0) return;
    const t = e.target;
    const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
    const ctrlMeta = e.ctrlKey || e.metaKey;
    const shiftOnly = e.shiftKey && !ctrlMeta;

    // (a) an overlay handle wins (it is above the grid by design).
    const handleEl = closest('.group-handle, .group-edge');
    if (handleEl) {
      const wrap = handleEl.closest('[data-group-id]');
      const g = wrap ? groupLayer.findGroup(wrap.dataset.groupId) : null;
      if (g) {
        withSource('click', () => selection.selectGroup(g.id));
        startGesture(handleEl.dataset.handle === 'se' ? 'resize' : 'move', g, e);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // (b) an object wins over the group it sits on.
    const itemEl = closest('.grid-stack-item');
    if (itemEl) {
      const id = itemEl.gridstackNode?.id ?? itemEl.getAttribute('gs-id');
      if (id != null) {
        const sid = String(id);
        // L6 rigid translation: press on an ALREADY-selected object while the
        // selection is multiple (no modifier) → move the whole selection. We
        // stopPropagation so gridstack's own single-item drag never starts.
        if (selection.objects.has(sid) && totalSelection() >= 2 && !ctrlMeta && !e.shiftKey) {
          startRigid(e, { id: sid, kind: 'object' });
          if (rigid) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        clickState = {
          type: 'object',
          objectId: sid,
          additive: ctrlMeta,
          unionOnly: shiftOnly,
          x: e.clientX,
          y: e.clientY,
          moved: false,
        };
      }
      // EDIT: neutralize a tile's real <a href> so a press starts a selection /
      // gridstack drag instead of a native link drag.
      if (closest('a[href]')) e.preventDefault();
      return;
    }

    // (c) empty canvas → the group under the pointer (pure hit-test) grabs it.
    const units = groupLayer.unitsFromClient(e.clientX, e.clientY);
    const hit = units ? hitGroups(groupLayer.getGroups(), units) : null;
    if (hit) {
      const gid = String(hit.id);
      // Rigid translation of a multi-selection containing this group.
      if (selection.groups.has(gid) && totalSelection() >= 2 && !ctrlMeta && !e.shiftKey) {
        startRigid(e, { id: gid, kind: 'group' });
        if (rigid) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      if (shiftOnly) {
        if (!selection.groups.has(gid)) withSource('click', () => selection.selectGroup(gid, { additive: true }));
      } else if (ctrlMeta) {
        withSource('click', () => selection.selectGroup(gid, { additive: true }));
      } else {
        withSource('click', () => selection.selectGroup(gid));
      }
      startGesture('move', hit, e);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // (d) truly empty canvas → arm a lasso (or clear the selection on click).
    clickState = {
      type: 'canvas',
      x: e.clientX,
      y: e.clientY,
      moved: false,
      additive: ctrlMeta || e.shiftKey,
      canLasso: !ctrlMeta,
      shift: e.shiftKey,
      baseObjects: new Set(selection.objects),
      baseGroups: new Set(selection.groups),
    };
  }

  function onWindowMouseMove(e) {
    if (lasso) {
      moveLasso(e);
      return;
    }
    if (gesture) {
      moveGesture(e);
      return;
    }
    if (rigid) {
      moveRigid(e);
      return;
    }
    if (clickState && !clickState.moved) {
      if (Math.hypot(e.clientX - clickState.x, e.clientY - clickState.y) > DRAG_THRESHOLD) {
        clickState.moved = true;
        if (clickState.type === 'canvas' && clickState.canLasso) startLasso(clickState, e);
      }
    }
  }

  function onWindowMouseUp(e) {
    if (lasso) {
      finishLasso();
      return;
    }
    if (gesture) {
      finishGesture();
      return;
    }
    if (rigid) {
      finishRigid();
      return;
    }
    if (clickState) finishClick(e);
  }

  /**
   * EDIT-only capture guard on tile anchors: a real <a href> inside a grid item
   * must NOT follow its URL while editing (it would navigate the dashboard away
   * mid-selection). Capture runs before the anchor's native activation; the
   * selection/drag behaviour is unaffected.
   */
  function onPreviewClick(e) {
    if (mode !== 'edit') return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a || !a.closest('.grid-stack-item')) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function applyObjectClick(id, { additive, unionOnly }) {
    const sid = String(id);
    if (unionOnly) {
      if (selection.objects.has(sid)) return; // union-only: never removes
      withSource('click', () => selection.selectObject(sid, { additive: true }));
      return;
    }
    withSource('click', () => selection.selectObject(sid, { additive: !!additive }));
  }

  function finishClick(e) {
    const cs = clickState;
    clickState = null;
    if (!cs || cs.moved || mode !== 'edit') return;
    if (cs.type === 'object') {
      applyObjectClick(cs.objectId, cs);
    } else if (cs.type === 'canvas' && !cs.additive) {
      withSource('click', () => selection.clear());
    }
  }

  // ---- lasso (L6) -----------------------------------------------------------
  function rectContainsRect(outer, inner) {
    return (
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.w <= outer.x + outer.w &&
      inner.y + inner.h <= outer.y + outer.h
    );
  }

  function startLasso(cs, e) {
    clickState = null;
    lasso = {
      startX: cs.x,
      startY: cs.y,
      baseObjects: cs.baseObjects,
      baseGroups: cs.baseGroups,
      shift: cs.shift,
      rect: null,
    };
    document.body.classList.add('lasso-active');
    marquee = el('div', 'group-marquee');
    groupLayer.overlay.appendChild(marquee);
    moveLasso(e);
  }

  function moveLasso(e) {
    if (!lasso) return;
    const cur = groupLayer.unitsFromClient(e.clientX, e.clientY);
    const start = groupLayer.unitsFromClient(lasso.startX, lasso.startY);
    if (!cur || !start) return;
    const x = clamp(Math.min(start.x, cur.x), 0, GRID_COLUMNS);
    const y = clamp(Math.min(start.y, cur.y), 0, GRID_ROWS);
    const w = clamp(Math.max(start.x, cur.x), 0, GRID_COLUMNS) - x;
    const h = clamp(Math.max(start.y, cur.y), 0, GRID_ROWS) - y;
    const rect = { x, y, w, h };
    lasso.rect = rect;
    if (marquee) {
      marquee.style.left = `calc(${x} * var(--unit-w, 1px))`;
      marquee.style.top = `calc(${y} * var(--unit-h, 1px))`;
      marquee.style.width = `calc(${w} * var(--unit-w, 1px))`;
      marquee.style.height = `calc(${h} * var(--unit-h, 1px))`;
    }

    const grid = getGrid();
    const objRects = grid ? grid.getObjectRects() : [];
    const hitObjects = objRects.filter((o) => rectsIntersect(rect, o)).map((o) => String(o.id));
    const hitGroups = groupLayer
      .getGroups()
      .filter((g) => rectContainsRect(rect, groupRect(g)))
      .map((g) => String(g.id));

    let objects;
    let groups;
    if (lasso.shift) {
      objects = new Set(lasso.baseObjects);
      groups = new Set(lasso.baseGroups);
      for (const id of hitObjects) objects.has(id) ? objects.delete(id) : objects.add(id);
      for (const id of hitGroups) groups.has(id) ? groups.delete(id) : groups.add(id);
    } else {
      objects = new Set(hitObjects);
      groups = new Set(hitGroups);
    }
    withSource('lasso', () => selection.set({ objects, groups }));
    if (e.cancelable) e.preventDefault();
  }

  function teardownLasso() {
    document.body.classList.remove('lasso-active');
    if (marquee) {
      marquee.remove();
      marquee = null;
    }
  }

  function finishLasso() {
    if (!lasso) return;
    lasso = null;
    teardownLasso();
  }

  /** Escape during an in-flight lasso → restore the pre-lasso selection. */
  function cancelLasso() {
    if (!lasso) return;
    const base = lasso;
    lasso = null;
    teardownLasso();
    withSource('lasso', () => selection.set({ objects: base.baseObjects, groups: base.baseGroups }));
  }

  // ---- group drag / resize --------------------------------------------------
  function startGesture(kind, group, e) {
    const grid = getGrid();
    const rects = grid ? grid.getObjectRects() : [];
    const members = rects.filter((o) => contains(group, o)).map((o) => ({ ...o }));
    gesture = {
      kind,
      groupId: String(group.id),
      group,
      startX: e.clientX,
      startY: e.clientY,
      startRect: groupRect(group),
      members,
      dragging: false,
    };
  }

  function moveGesture(e) {
    const g = gesture;
    const dxpx = e.clientX - g.startX;
    const dypx = e.clientY - g.startY;
    if (!g.dragging) {
      if (Math.hypot(dxpx, dypx) < DRAG_THRESHOLD) return;
      g.dragging = true;
      document.body.classList.add(g.kind === 'resize' ? 'group-resizing' : 'group-dragging');
    }
    const units = groupLayer.unitsFromClient(g.startX, g.startY);
    if (!units) return;
    if (g.kind === 'move') applyMove(dxpx / units.u, dypx / units.v, units.u, units.v);
    else applyResize(dxpx / units.u, dypx / units.v);
    if (e.cancelable) e.preventDefault();
  }

  function overlapsOther(rect, selfId) {
    for (const g of groupLayer.getGroups()) {
      if (String(g.id) === String(selfId)) continue;
      if (rectsIntersect(rect, groupRect(g))) return true;
    }
    return false;
  }

  function applyMove(rawDx, rawDy, uPx, vPx) {
    const g = gesture;
    const g0 = g.startRect;
    // Widgets live on the even trame; all members share ONE delta, so keeping
    // the delta even (when a widget is inside) is the only way to preserve the
    // parity of every member at once. Otherwise the group snaps to 1 unit.
    const step = g.members.some((m) => m.kind === 'widget') ? 2 : 1;
    let dx = Math.round(rawDx / step) * step;
    let dy = Math.round(rawDy / step) * step;
    dx = clamp(dx, -g0.x, GRID_COLUMNS - g0.w - g0.x);
    dy = clamp(dy, -g0.y, GRID_ROWS - g0.h - g0.y);
    const cand = { x: g0.x + dx, y: g0.y + dy, w: g0.w, h: g0.h };
    if (overlapsOther(cand, g.groupId)) {
      // Q2: refuse the position, stay at the last valid one + contact ring.
      groupLayer.flashAlert(g.groupId);
      return;
    }
    if (g.group.x === cand.x && g.group.y === cand.y) return;
    g.group.x = cand.x;
    g.group.y = cand.y;
    groupLayer.placeGroup(g.groupId);
    syncHandles();
    const mdx = cand.x - g0.x;
    const mdy = cand.y - g0.y;
    const grid = getGrid();
    for (const m of g.members) {
      const node = grid?.getObjectElement(m.id);
      if (node) node.style.transform = `translate(${mdx * uPx}px, ${mdy * vPx}px)`;
    }
  }

  /**
   * Clamp a candidate SE growth to the FIRST contact with another group (no
   * refusal, no push): a group whose vertical span overlaps caps the width at
   * its left edge, one whose horizontal span overlaps caps the height at its
   * top edge. The box can never overlap another group after this.
   */
  function clampResizeToGroups(rect, selfId) {
    const others = groupLayer
      .getGroups()
      .filter((g) => String(g.id) !== String(selfId))
      .map(groupRect);
    for (const g of others) {
      if (rect.y < g.y + g.h && g.y < rect.y + rect.h && g.x >= rect.x) {
        rect.w = Math.min(rect.w, Math.max(GROUP_MIN, g.x - rect.x));
      }
    }
    for (const g of others) {
      if (rect.x < g.x + g.w && g.x < rect.x + rect.w && g.y >= rect.y) {
        rect.h = Math.min(rect.h, Math.max(GROUP_MIN, g.y - rect.y));
      }
    }
    return rect;
  }

  function applyResize(rawDx, rawDy) {
    const g = gesture;
    const g0 = g.startRect;
    const reqW = clampResizeAxis(g0, rawDx, 'w');
    const reqH = clampResizeAxis(g0, rawDy, 'h');
    const cand = clampResizeToGroups({ x: g0.x, y: g0.y, w: reqW, h: reqH }, g.groupId);
    if (cand.w !== reqW || cand.h !== reqH) groupLayer.flashAlert(g.groupId);
    if (g.group.w === cand.w && g.group.h === cand.h) return;
    g.group.w = cand.w;
    g.group.h = cand.h;
    groupLayer.placeGroup(g.groupId);
    syncHandles();
  }

  /** Requested SE size on one axis: min 4×4, clamped to the canvas edge. */
  function clampResizeAxis(g0, raw, axis) {
    return axis === 'w'
      ? clamp(g0.w + Math.round(raw), GROUP_MIN, GRID_COLUMNS - g0.x)
      : clamp(g0.h + Math.round(raw), GROUP_MIN, GRID_ROWS - g0.y);
  }

  function clearMemberTransforms(g) {
    const grid = getGrid();
    for (const m of g.members) {
      const node = grid?.getObjectElement(m.id);
      if (node && node.style.transform) node.style.transform = '';
    }
  }

  function finishGesture() {
    const g = gesture;
    gesture = null;
    document.body.classList.remove('group-dragging');
    document.body.classList.remove('group-resizing');
    if (!g || !g.dragging) return;

    if (g.kind === 'move') {
      const dx = g.group.x - g.startRect.x;
      const dy = g.group.y - g.startRect.y;
      const grid = getGrid();
      if ((dx || dy) && grid) {
        grid.commitObjectRects(g.members.map((m) => ({ id: m.id, x: m.x + dx, y: m.y + dy })));
      }
      clearMemberTransforms(g);
      if (dx || dy) patchGroup({ id: g.groupId, x: g.group.x, y: g.group.y });
    } else {
      clearMemberTransforms(g);
      patchGroup({ id: g.groupId, x: g.group.x, y: g.group.y, w: g.group.w, h: g.group.h });
    }
    syncHandles();
  }

  function patchGroup(patch) {
    const { id, ...body } = patch;
    return api
      .patch(`/api/layout/groups/${id}`, body)
      .catch((err) => toast(err.message || 'Failed to save group', 'error'));
  }

  // ---- rigid multi-selection translation (L6) -------------------------------
  function startRigid(e, press) {
    const grid = getGrid();
    const rects = grid ? grid.getObjectRects() : [];
    const objects = rects.filter((o) => selection.objects.has(String(o.id))).map((o) => ({ ...o }));
    const groups = groupLayer
      .getGroups()
      .filter((g) => selection.groups.has(String(g.id)))
      .map((g) => ({ group: g, rect: groupRect(g) }));
    if (objects.length + groups.length < 2) {
      rigid = null;
      return;
    }
    const step = objects.some((o) => o.kind === 'widget') ? 2 : 1;
    rigid = { startX: e.clientX, startY: e.clientY, objects, groups, step, dragging: false, dx: 0, dy: 0, press: press || null };
  }

  function overlapsStaticGroups(dx, dy) {
    const statics = groupLayer
      .getGroups()
      .filter((g) => !selection.groups.has(String(g.id)))
      .map(groupRect);
    if (!statics.length) return false;
    for (const entry of rigid.groups) {
      const cand = { x: entry.rect.x + dx, y: entry.rect.y + dy, w: entry.rect.w, h: entry.rect.h };
      for (const s of statics) if (rectsIntersect(cand, s)) return true;
    }
    return false;
  }

  /**
   * Clamp a requested rigid delta by the TIGHTEST constraint: every translated
   * object AND group stays inside the canvas, and no translated group may
   * overlap a non-selected one (stepped back one unit at a time from the
   * requested delta — the largest valid one wins).
   */
  function clampRigid(dx, dy) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of rigid.objects) {
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.w);
      maxY = Math.max(maxY, o.y + o.h);
    }
    for (const g of rigid.groups) {
      minX = Math.min(minX, g.rect.x);
      minY = Math.min(minY, g.rect.y);
      maxX = Math.max(maxX, g.rect.x + g.rect.w);
      maxY = Math.max(maxY, g.rect.y + g.rect.h);
    }
    dx = clamp(dx, -minX, GRID_COLUMNS - maxX);
    dy = clamp(dy, -minY, GRID_ROWS - maxY);
    let guard = 0;
    while (guard++ < 200 && overlapsStaticGroups(dx, dy)) {
      if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) dx -= Math.sign(dx) * rigid.step;
      else if (dy !== 0) dy -= Math.sign(dy) * rigid.step;
      else break;
    }
    return { dx, dy };
  }

  function moveRigid(e) {
    const r = rigid;
    const dxpx = e.clientX - r.startX;
    const dypx = e.clientY - r.startY;
    if (!r.dragging) {
      if (Math.hypot(dxpx, dypx) < DRAG_THRESHOLD) return;
      r.dragging = true;
      document.body.classList.add('group-dragging');
    }
    const units = groupLayer.unitsFromClient(r.startX, r.startY);
    if (!units) return;
    let dx = Math.round(dxpx / units.u / r.step) * r.step;
    let dy = Math.round(dypx / units.v / r.step) * r.step;
    ({ dx, dy } = clampRigid(dx, dy));
    r.dx = dx;
    r.dy = dy;
    const grid = getGrid();
    for (const o of r.objects) {
      const node = grid?.getObjectElement(o.id);
      if (node) node.style.transform = dx || dy ? `translate(${dx * units.u}px, ${dy * units.v}px)` : '';
    }
    for (const entry of r.groups) {
      groupLayer.previewTransform(entry.group.id, dx * units.u, dy * units.v);
      const wrap = handleSets.get(String(entry.group.id));
      if (wrap) wrap.style.transform = dx || dy ? `translate(${dx * units.u}px, ${dy * units.v}px)` : '';
    }
    if (e.cancelable) e.preventDefault();
  }

  function clearRigidTransforms(r) {
    const grid = getGrid();
    for (const o of r.objects) {
      const node = grid?.getObjectElement(o.id);
      if (node && node.style.transform) node.style.transform = '';
    }
    for (const entry of r.groups) {
      groupLayer.previewTransform(entry.group.id, 0, 0);
      const wrap = handleSets.get(String(entry.group.id));
      if (wrap) wrap.style.transform = '';
    }
  }

  function finishRigid() {
    const r = rigid;
    rigid = null;
    if (!r) return;
    document.body.classList.remove('group-dragging');
    clearRigidTransforms(r);
    if (!r.dragging) {
      // A press WITHOUT movement is a plain CLICK: collapse the multi-selection
      // onto the pressed item (the « click replaces » rule of L6-B).
      if (r.press) {
        if (r.press.kind === 'group') withSource('click', () => selection.selectGroup(r.press.id));
        else withSource('click', () => selection.selectObject(r.press.id));
      }
      return;
    }
    const { dx, dy } = r;
    if (dx === 0 && dy === 0) return;
    const grid = getGrid();
    // ONE object mutation (debounced full PUT) carrying every selected object.
    if (r.objects.length && grid) {
      grid.commitObjectRects(r.objects.map((o) => ({ id: o.id, x: o.x + dx, y: o.y + dy })));
    }
    // Groups are not grid items: one PATCH each, committed together here.
    for (const entry of r.groups) {
      entry.group.x = entry.rect.x + dx;
      entry.group.y = entry.rect.y + dy;
      groupLayer.placeGroup(entry.group.id);
      patchGroup({ id: entry.group.id, x: entry.group.x, y: entry.group.y });
    }
    syncHandles();
  }

  // ---- create / dissolve / delete -------------------------------------------
  function nextGroupTitle() {
    const used = new Set(state.layoutGroups.map((g) => String(g?.config?.title || '')));
    let n = 1;
    while (used.has(`Group ${n}`)) n += 1;
    return `Group ${n}`;
  }

  async function groupSelection() {
    const grid = getGrid();
    if (!grid) return;
    const selIds = selection.objects;
    if (!selIds.size) {
      toast('Select at least one object to group', 'error');
      return;
    }
    const rects = grid.getObjectRects().filter((o) => selIds.has(o.id));
    const selGroups = groupLayer.getGroups().filter((g) => selection.groups.has(g.id));
    if (!rects.length && !selGroups.length) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const o of rects) {
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.w);
      maxY = Math.max(maxY, o.y + o.h);
    }
    for (const g of selGroups) {
      const r = groupRect(g);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }

    const build = (margin) => {
      const right = Math.ceil(maxX) + margin;
      const bottom = Math.ceil(maxY) + margin;
      let x = clamp(Math.floor(minX) - margin, 0, GRID_COLUMNS - GROUP_MIN);
      let y = clamp(Math.floor(minY) - margin, 0, GRID_ROWS - GROUP_MIN);
      let w = clamp(right - x, GROUP_MIN, GRID_COLUMNS - x);
      let h = clamp(bottom - y, GROUP_MIN, GRID_ROWS - y);
      if (w < GROUP_MIN) {
        const grow = GROUP_MIN - w;
        x = Math.max(0, x - Math.floor(grow / 2));
        w = Math.min(GRID_COLUMNS - x, GROUP_MIN);
      }
      if (h < GROUP_MIN) {
        const grow = GROUP_MIN - h;
        y = Math.max(0, y - Math.floor(grow / 2));
        h = Math.min(GRID_ROWS - y, GROUP_MIN);
      }
      return { x, y, w, h };
    };
    const collides = (r) =>
      groupLayer.getGroups().some((g) => !selection.groups.has(g.id) && rectsIntersect(r, groupRect(g)));
    let rect = build(GROUP_MARGIN);
    if (collides(rect)) rect = build(0);
    if (collides(rect)) {
      toast('Cannot create group: no free space around the selection', 'error');
      return;
    }

    const absorbedIds = selGroups.map((g) => String(g.id));
    const absorbedSet = new Set(absorbedIds);
    const draft = {
      id: uuid(),
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      config: { title: nextGroupTitle(), titleVisibility: 'always' },
    };
    try {
      const created = await api.post('/api/layout/groups', draft);
      for (const id of absorbedIds) {
        try {
          await api.del(`/api/layout/groups/${id}`);
        } catch {
          /* best effort — the local model still absorbs it */
        }
      }
      state.layoutGroups = state.layoutGroups.filter((g) => !absorbedSet.has(String(g.id)));
      state.layoutGroups.push(created && created.id ? created : draft);
      withSource('click', () => selection.clear());
      groupLayer.render(state.layoutGroups, mode);
      applySelection();
      toast(`Group created (${rect.w}×${rect.h})`, 'success');
    } catch (err) {
      toast(err.message || 'Failed to create group', 'error');
    }
  }

  function openGroupConfig(group) {
    openSettingsModal({
      title: 'Edit group',
      schema: GROUP_SETTINGS_SCHEMA,
      config: group.config || {},
      save: (value) => api.patch(`/api/layout/groups/${group.id}`, { config: value }),
      onSaved: (value) => {
        group.config = { ...(group.config || {}), ...value };
        groupLayer.render(state.layoutGroups, mode);
        applySelection();
        toast('Group saved', 'success');
      },
    });
  }

  function editGroup(id) {
    const g = groupLayer.findGroup(id);
    if (g) openGroupConfig(g);
  }

  /**
   * Live group config write from the floating bar: mutate the box locally + a
   * single rAF-coalesced re-render (so dragging a slider never rebuilds the
   * layer per pixel), and debounce the actual PATCH per group.
   */
  function setGroupConfig(id, patch) {
    const g = groupLayer.findGroup(id);
    if (!g || !patch) return;
    g.config = { ...(g.config || {}), ...patch };
    scheduleGroupRender();
    const key = String(id);
    const prev = groupPatchTimers.get(key);
    if (prev) clearTimeout(prev);
    groupPatchTimers.set(
      key,
      setTimeout(() => {
        groupPatchTimers.delete(key);
        api
          .patch(`/api/layout/groups/${id}`, { config: g.config })
          .catch((err) => toast(err.message || 'Failed to save group', 'error'));
      }, GROUP_PATCH_MS)
    );
  }

  function scheduleGroupRender() {
    if (groupRenderScheduled) return;
    groupRenderScheduled = true;
    requestAnimationFrame(() => {
      groupRenderScheduled = false;
      groupLayer.render(state.layoutGroups, mode);
      applySelection();
    });
  }

  /** Ungroup: dissolve every SELECTED group (objects always kept). */
  async function dissolveSelectedGroups() {
    const ids = [...selection.groups];
    if (!ids.length) return;
    for (const id of ids) {
      try {
        await api.del(`/api/layout/groups/${id}`);
      } catch {
        /* best effort */
      }
    }
    const set = new Set(ids);
    state.layoutGroups = state.layoutGroups.filter((g) => !set.has(String(g.id)));
    withSource('click', () => selection.clear());
    groupLayer.render(state.layoutGroups, mode);
    applySelection();
    toast(ids.length > 1 ? `Removed ${ids.length} groups — objects kept` : 'Group removed — objects kept', 'success');
  }

  /**
   * Delete (bar « Delete » AND keyboard Delete/Backspace): the selected OBJECTS
   * are removed and the selected GROUPS are only DISSOLVED — their contents are
   * NEVER removed implicitly (that is the 2-step « Delete group + contents »).
   */
  function deleteSelection(source = 'click') {
    const grid = getGrid();
    const objIds = [...selection.objects];
    const grpIds = [...selection.groups];
    if (!objIds.length && !grpIds.length) return;
    if (objIds.length && grid) grid.removeObjects(objIds);
    if (grpIds.length) {
      const set = new Set(grpIds);
      for (const id of grpIds) api.del(`/api/layout/groups/${id}`).catch(() => {});
      state.layoutGroups = state.layoutGroups.filter((g) => !set.has(String(g.id)));
    }
    withSource(source, () => selection.clear());
    if (grpIds.length) groupLayer.render(state.layoutGroups, mode);
    applySelection();
    const parts = [];
    if (objIds.length) parts.push(`${objIds.length} object${objIds.length > 1 ? 's' : ''} deleted`);
    if (grpIds.length) parts.push(`${grpIds.length} group${grpIds.length > 1 ? 's' : ''} dissolved (objects kept)`);
    if (parts.length) toast(parts.join(' · '), 'success');
  }

  /** 2-step: delete the selected groups AND every object entirely inside them. */
  async function deleteGroupsWithContents() {
    const grid = getGrid();
    const ids = [...selection.groups];
    if (!ids.length) return;
    const groups = groupLayer.getGroups().filter((g) => selection.groups.has(String(g.id)));
    const rects = grid ? grid.getObjectRects() : [];
    const contained = new Set();
    for (const g of groups) for (const o of rects) if (contains(g, o)) contained.add(String(o.id));
    for (const id of ids) {
      try {
        await api.del(`/api/layout/groups/${id}?withObjects=1`);
      } catch {
        /* best effort */
      }
    }
    if (contained.size && grid) grid.removeObjects([...contained]);
    const set = new Set(ids);
    state.layoutGroups = state.layoutGroups.filter((g) => !set.has(String(g.id)));
    withSource('click', () => selection.clear());
    groupLayer.render(state.layoutGroups, mode);
    applySelection();
    toast(
      contained.size
        ? `Group(s) deleted (${contained.size} object${contained.size > 1 ? 's' : ''} removed)`
        : 'Group(s) deleted',
      'success'
    );
  }

  // ---- EDIT context menu (L9) ----------------------------------------------
  // The per-tile ✕ (delete) / ⚙ (options) buttons are GONE: every setting of
  // every object is reachable from a RIGHT CLICK on it (see
  // grid/contextMenuItems.js for the per-kind content). The menu is opened from
  // the `contextmenu` event — NEVER from `mousedown` — so the gridstack drag
  // engine, the selection gestures and the lasso are completely untouched.
  const MENU_CONFIRM_MS = 3000; // mirrors the floating bar's 2-step window
  let menuConfirmArmed = false; // « Delete group + contents » armed from the menu

  function openGridMenu(e, items) {
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items,
      label: 'Object options',
      onClose: () => {
        // A half-armed 2-step must never survive the menu it belongs to.
        clearTimeout(menuConfirmTimer);
        menuConfirmTimer = 0;
        menuConfirmArmed = false;
      },
    });
  }

  /**
   * Delete label of the menu: when the right-clicked object belongs to a
   * MULTIPLE selection the whole selection goes (exactly like the floating
   * bar's « Delete »), otherwise only that object.
   */
  function menuDeleteLabel(id) {
    return selection.objects.has(id) && totalSelection() >= 2 ? `Delete selection (${totalSelection()})` : 'Delete';
  }

  /**
   * Menu « Delete »: routed through the SAME path as the bar / keyboard
   * (deleteSelection), so objects are removed and selected groups are only
   * dissolved — then ONE debounced PUT persists the result.
   */
  function menuDeleteObject(id) {
    if (selection.objects.has(id) || selection.groups.size) {
      deleteSelection('click');
      return;
    }
    getGrid()?.removeObjects?.([id]);
  }

  /** Wiring of the menu rows of an OBJECT (element / widget / report). */
  function objectMenuActions(id) {
    const grid = getGrid();
    return {
      setOptions: (patch) => grid?.setObjectOptions?.(id, patch),
      openOptions: () => grid?.openObjectOptions?.(id),
      openSettings: () => grid?.openObjectConfig?.(id),
      openElement: () => openElementsModal(),
      remove: () => menuDeleteObject(id),
    };
  }

  /** Wiring of the menu rows of a GROUP box. */
  function groupMenuActions(group) {
    const gid = String(group.id);
    return {
      setGroupConfig: (patch) => setGroupConfig(gid, patch),
      editGroup: () => editGroup(gid),
      ungroup: () => dissolveSelectedGroups(),
      deleteGroupWithContents: (ctx) => {
        // 2-step: the first activation only ARMS the destructive action (same
        // pattern as the bar's button), the second one executes it.
        if (!menuConfirmArmed) {
          menuConfirmArmed = true;
          ctx?.setLabel?.('Click again to confirm');
          clearTimeout(menuConfirmTimer);
          menuConfirmTimer = setTimeout(() => {
            menuConfirmTimer = 0;
            menuConfirmArmed = false;
            ctx?.setLabel?.('Delete group + contents');
          }, MENU_CONFIRM_MS);
          return;
        }
        clearTimeout(menuConfirmTimer);
        menuConfirmTimer = 0;
        menuConfirmArmed = false;
        ctx?.close?.();
        deleteGroupsWithContents();
      },
    };
  }

  /**
   * EDIT right click. Priority mirrors the pointer routing: an object wins over
   * the group box it sits on, then a group, then the empty canvas.
   * VIEW is untouched (the tile's native contract opens a NEW TAB).
   */
  function onPreviewContextMenu(e) {
    if (mode !== 'edit' || !previewEl.isConnected) return;
    const t = e.target;
    const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
    // Native fields keep the BROWSER menu (copy / paste / inspect) — the same
    // exemption main.js applies to genuine native targets in VIEW.
    if (
      closest(
        'input, textarea, select, [contenteditable], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )
    ) {
      return;
    }
    if (lasso || gesture || rigid) return; // never interrupt an in-flight gesture
    if (guards.isOverlayOpen() || guards.isPaletteOverlayOpen()) return; // a modal owns the screen
    if (guards.isTransitionActive()) return;

    const grid = getGrid();

    // (a) an object (widget / element / report).
    const itemEl = closest('.grid-stack-item');
    if (itemEl && grid) {
      const raw = itemEl.gridstackNode?.id ?? itemEl.getAttribute('gs-id');
      if (raw == null) return;
      const id = String(raw);
      const info = grid.getObjectMeta(id);
      if (!info) return;
      e.preventDefault();
      e.stopPropagation();
      // Selection sync: a right click on an object OUTSIDE the current selection
      // makes it THE selection (menu + bar agree); an object already part of a
      // multi-selection keeps the selection, so « Delete » applies to all of it.
      if (!selection.objects.has(id) || selection.groups.size) withSource('click', () => selection.selectObject(id));
      const element = info.kind === 'widget' ? null : catalog.get(info.elementId);
      const common = {
        info,
        element,
        deleteLabel: menuDeleteLabel(id),
        actions: objectMenuActions(id),
      };
      const items =
        info.kind === 'element'
          ? elementMenuItems(common)
          : info.kind === 'report'
            ? reportMenuItems(common)
            : widgetMenuItems(common);
      openGridMenu(e, items);
      return;
    }

    // (b) a group box under the pointer (pure hit test, LAST → FIRST).
    const units = groupLayer.unitsFromClient(e.clientX, e.clientY);
    const hit = units ? hitGroups(groupLayer.getGroups(), units) : null;
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      const gid = String(hit.id);
      if (!selection.groups.has(gid) || selection.objects.size) {
        withSource('click', () => selection.selectGroup(gid));
      }
      openGridMenu(e, groupMenuItems({ group: hit, actions: groupMenuActions(hit) }));
      return;
    }

    // (c) truly empty canvas → the two creation entry points (same as topbar).
    const canvasItems = canvasMenuItems({ actions: canvasMenuActions });
    if (canvasItems.length > 1) {
      e.preventDefault();
      e.stopPropagation();
      withSource('click', () => selection.clear());
      openGridMenu(e, canvasItems);
    }
  }

  // ---- keyboard (L6) --------------------------------------------------------
  /** Ctrl+A: every object + every group of the active page (EDIT only). */
  function selectAll() {
    const grid = getGrid();
    const objects = grid ? grid.getObjectRects().map((o) => String(o.id)) : [];
    const groups = groupLayer.getGroups().map((g) => String(g.id));
    withSource('keyboard', () => selection.set({ objects, groups }));
  }

  function onKeyDown(e) {
    if (mode !== 'edit' || !previewEl.isConnected) return;
    // An open context menu owns the keyboard (its capture handler stops the
    // keys it uses, but Delete / Backspace / Ctrl+A must never reach the canvas
    // while a menu or one of its fields has the focus).
    if (isContextMenuOpen()) return;
    if (e.defaultPrevented) return;
    if (guards.isOverlayOpen() || guards.isPaletteOverlayOpen()) return;
    // Never steal a key from a text field — INCLUDING the floating bar's own
    // inputs (Delete must not remove an object while typing its title).
    if (guards.isTextEntryTarget(e.target) || guards.isTextEntryTarget(document.activeElement)) return;

    const key = e.key;
    if (key === 'Escape') {
      if (lasso) {
        e.preventDefault();
        cancelLasso();
        return;
      }
      if (!selection.isEmpty()) {
        e.preventDefault();
        withSource('keyboard', () => selection.clear());
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'a' || key === 'A')) {
      e.preventDefault();
      selectAll();
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      // No-op total on an empty selection / during a gesture / transition /
      // lasso: never preventDefault without acting (it would break ←/→, the
      // native history and in-field editing).
      if (selection.isEmpty()) return;
      if (lasso || gesture || rigid) return;
      if (guards.isInteractionActive()) return;
      if (guards.isTransitionActive()) return;
      e.preventDefault();
      deleteSelection('keyboard');
    }
  }

  // ---- lifecycle ------------------------------------------------------------
  function setMode(next) {
    mode = next === 'edit' ? 'edit' : 'view';
    // A menu belongs to the EDIT canvas: leaving EDIT tears it down (no stale
    // panel above the VIEW dashboard, no half-armed 2-step).
    if (mode !== 'edit') closeContextMenu();
    if (mode !== 'edit') {
      clearHandles();
      document.body.classList.remove('group-dragging');
      document.body.classList.remove('group-resizing');
      if (lasso) cancelLasso();
      gesture = null;
      rigid = null;
      clickState = null;
    }
    bar.setMode(mode);
    syncHandles();
  }

  /** Drop selection + handles (called on every grid rebuild / page switch). */
  function reset() {
    if (lasso) cancelLasso();
    closeContextMenu(); // a grid rebuild invalidates every menu target
    gesture = null;
    rigid = null;
    clickState = null;
    withSource('click', () => selection.clear());
    clearHandles();
    bar.refresh();
  }

  // ---- listeners ------------------------------------------------------------
  // CAPTURE phase: gridstack's drag engine stops mousedown propagation on
  // `.grid-stack-item`, so a bubble listener would never see an OBJECT press
  // (only the canvas + overlay handles). Capture runs first; for an object we
  // deliberately do NOT stop propagation, so gridstack still starts its drag.
  previewEl.addEventListener('mousedown', onPreviewMouseDown, true);
  previewEl.addEventListener('click', onPreviewClick, true);
  // `contextmenu` (never `mousedown`): the menu can never interfere with the
  // gridstack drag engine nor with the selection gestures above.
  previewEl.addEventListener('contextmenu', onPreviewContextMenu, true);
  previewEl.addEventListener('mousemove', () => {
    if (mode === 'edit') syncHandles();
  });
  window.addEventListener('mousemove', onWindowMouseMove, true);
  window.addEventListener('mouseup', onWindowMouseUp, true);
  document.addEventListener('keydown', onKeyDown);

  function destroy() {
    unsubscribeSelection();
    previewEl.removeEventListener('mousedown', onPreviewMouseDown, true);
    previewEl.removeEventListener('click', onPreviewClick, true);
    previewEl.removeEventListener('contextmenu', onPreviewContextMenu, true);
    window.removeEventListener('mousemove', onWindowMouseMove, true);
    window.removeEventListener('mouseup', onWindowMouseUp, true);
    document.removeEventListener('keydown', onKeyDown);
    closeContextMenu();
    clearTimeout(menuConfirmTimer);
    menuConfirmTimer = 0;
    menuConfirmArmed = false;
    clearHandles();
    teardownLasso();
    for (const t of groupPatchTimers.values()) clearTimeout(t);
    groupPatchTimers.clear();
    bar.destroy();
  }

  return { setMode, reset, syncHandles, destroy };
}
