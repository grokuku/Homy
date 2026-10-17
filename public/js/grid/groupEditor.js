/**
 * Group editing engine (layout v5, lot L4).
 *
 * Wires up everything the L2/L3 substrate deferred:
 *   - GROUP selection on click (via the pure `hitGroups`) + a minimal OBJECT
 *     multi-selection (click / Ctrl-Cmd-click / Shift-click) — the selection
 *     STATE itself lives in grid/selection.js, this module only drives it.
 *   - GROUP drag: the member list is FROZEN at mousedown (`contains`, widgets
 *     AND elements/reports) and every member is translated by the exact same
 *     delta. Snap is 1 fine unit, raised to 2 when the group contains at least
 *     one widget so no widget can ever land on an odd trame (relative parity is
 *     preserved by construction: all members share one even delta). Canvas
 *     clamp [0,64]×[0,36]; a candidate that INTERSECTS another group is refused
 *     (the group sticks at the last valid position + a ~120 ms alert ring).
 *     ONE mutation per gesture at mouseup: a single debounced full PUT for the
 *     members + one PATCH for the box geometry.
 *   - GROUP resize from a 12×12 SE handle: min 4×4, 1-unit snap, canvas clamp,
 *     growth STOPPED at the first contact with another group (no refusal, no
 *     push). ONE PATCH at mouseup (members do not move).
 *   - « Group selection »: bbox of the selected objects (+ selected groups)
 *     inflated by 2 units, floor/ceil, clamp, symmetric widening to 4×4;
 *     collision → retry with 0 margin → refuse + toast (nothing written).
 *     Selected groups are ABSORBED (dissolved, their objects untouched).
 *   - Ungroup (dissolve) / Delete group + contents (2-step, strict containment).
 *
 * DOM: the 4px border grab frame + the SE handle live in `groupLayer.overlay`
 * (EDIT only, pointer-events:none on the parent, `auto` on the handles). The
 * context bar is a small fixed bar appended to <body> and revealed only in EDIT
 * when a group is selected or ≥ 2 objects are selected.
 *
 * NOT L4 (see lot L6): lasso, full floating multi-selection bar, Ctrl+A,
 * keyboard Delete/Backspace, heterogeneous rigid translation, bulk appearance.
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { el, uuid } from '../util.js';
import { toast } from '../ui/toast.js';
import { openSettingsModal } from '../ui/settingsModal.js';
import { APPEARANCE_FIELDS } from '../widgets/registry.js';
import { contains, groupRect, hitGroups, rectsIntersect } from './groups.js';
import { GRID_COLUMNS, GRID_ROWS } from './config.js';
import { selection } from './selection.js';

/** Pixels of pointer travel before a press becomes a drag (below = a click). */
export const DRAG_THRESHOLD = 4;
/** A group box is at least 4×4 fine units (mirrors server MIN_GROUP). */
const GROUP_MIN = 4;
/** Units of margin added on each side when grouping a selection. */
const GROUP_MARGIN = 2;
/** 2-step « Delete group + contents » confirmation window (tabs.js pattern). */
const CONFIRM_MS = 3000;

/**
 * Group config schema (front-only — the group is NOT a widget, so it is not
 * part of the server widget manifest nor of scripts/check-schema-sync.mjs).
 * The write path is PATCH /api/layout/groups/:id via openSettingsModal's
 * `save` override; the server's normalizeGroupConfig tolerates every field.
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

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function createGroupEditor({ previewEl, groupLayer, getGrid }) {
  let mode = 'view';
  let gesture = null; // active group drag/resize
  let clickState = null; // a press that may resolve into a selection click
  const handleSets = new Map(); // groupId -> handle DOM
  let deleteTimer = 0;

  // ---- context bar ----------------------------------------------------------
  const bar = el('div', 'group-context-bar hidden', null, { id: 'group-context-bar' });
  const groupBtn = el('button', 'btn', 'Group', { type: 'button', title: 'Group the selected objects' });
  const ungroupBtn = el('button', 'btn', 'Ungroup', { type: 'button', title: 'Dissolve this group (objects stay)' });
  const editBtn = el('button', 'btn', 'Edit group…', { type: 'button', title: 'Edit title, visibility and appearance' });
  const deleteBtn = el('button', 'btn btn-danger', 'Delete group + contents', {
    type: 'button',
    title: 'Delete this group and every object entirely inside it',
  });
  bar.append(groupBtn, ungroupBtn, editBtn, deleteBtn);
  document.body.appendChild(bar);

  groupBtn.addEventListener('click', () => groupSelection());
  ungroupBtn.addEventListener('click', () => ungroupSelected());
  editBtn.addEventListener('click', () => {
    const g = groupLayer.findGroup(selection.singleGroup());
    if (g) openGroupConfig(g);
  });
  deleteBtn.addEventListener('click', () => {
    if (deleteBtn.classList.contains('confirm')) {
      disarmDelete();
      deleteSelectedGroup();
      return;
    }
    armDelete();
  });

  function armDelete() {
    disarmDelete();
    deleteBtn.classList.add('confirm');
    deleteBtn.textContent = 'Click again to confirm';
    deleteTimer = setTimeout(disarmDelete, CONFIRM_MS);
  }
  function disarmDelete() {
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = 0;
    deleteBtn.classList.remove('confirm');
    deleteBtn.textContent = 'Delete group + contents';
  }

  // ---- selection visuals ----------------------------------------------------
  const unsubscribeSelection = selection.onChange(() => applySelection());

  function applySelection() {
    groupLayer.setSelectedGroup(selection.singleGroup());
    const selected = selection.objects;
    for (const node of previewEl.querySelectorAll('.grid-stack-item')) {
      const id = node.gridstackNode?.id ?? node.getAttribute('gs-id');
      node.classList.toggle('grid-object-selected', id != null && selected.has(String(id)));
    }
    syncHandles();
    updateBar();
  }

  function updateBar() {
    const hasGroup = selection.groups.size > 0;
    const objectCount = selection.objects.size;
    const visible = mode === 'edit' && (hasGroup || objectCount >= 2);
    bar.classList.toggle('hidden', !visible);
    groupBtn.classList.toggle('hidden', objectCount < 1);
    ungroupBtn.classList.toggle('hidden', !hasGroup);
    editBtn.classList.toggle('hidden', !hasGroup);
    deleteBtn.classList.toggle('hidden', !hasGroup);
    if (!hasGroup) disarmDelete();
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
   * Keep the overlay handles in sync with the visible ids: the SELECTED group
   * (persistent ring) plus the currently HOVERED one (set by groups.js's
   * mousemove hit-test). Idempotent — only the diff is created/removed.
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

    // (a) an overlay handle wins (it is above the grid by design).
    const handleEl = closest('.group-handle, .group-edge');
    if (handleEl) {
      const wrap = handleEl.closest('[data-group-id]');
      const g = wrap ? groupLayer.findGroup(wrap.dataset.groupId) : null;
      if (g) {
        selection.selectGroup(g.id);
        startGesture(handleEl.dataset.handle === 'se' ? 'resize' : 'move', g, e);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // (b) an object wins over the group it sits on.
    const itemEl = closest('.grid-stack-item');
    if (itemEl) {
      // An object wins over the group it sits on; let gridstack handle the drag.
      const id = itemEl.gridstackNode?.id ?? itemEl.getAttribute('gs-id');
      if (id != null) {
        clickState = { type: 'object', objectId: String(id), x: e.clientX, y: e.clientY, moved: false };
      }
      // EDIT: neutralize a tile's real <a href> so a press starts a selection /
      // gridstack drag instead of a native link drag (the capture-phase guard
      // the L2 comments refer to — see elements/button.js wireViewNavigation).
      if (closest('a[href]')) e.preventDefault();
      return;
    }

    // (c) empty canvas → the group under the pointer (pure hit-test) grabs it.
    const units = groupLayer.unitsFromClient(e.clientX, e.clientY);
    const hit = units ? hitGroups(groupLayer.getGroups(), units) : null;
    if (hit) {
      selection.selectGroup(hit.id);
      startGesture('move', hit, e);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // (d) truly empty canvas → clear the selection on click.
    clickState = { type: 'canvas', x: e.clientX, y: e.clientY, moved: false };
  }

  function onWindowMouseMove(e) {
    if (gesture) {
      moveGesture(e);
      return;
    }
    if (clickState && !clickState.moved) {
      if (Math.hypot(e.clientX - clickState.x, e.clientY - clickState.y) > DRAG_THRESHOLD) {
        clickState.moved = true;
      }
    }
  }

  function onWindowMouseUp(e) {
    if (gesture) {
      finishGesture();
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

  function finishClick(e) {
    const cs = clickState;
    clickState = null;
    if (!cs || cs.moved || mode !== 'edit') return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (cs.type === 'object') {
      selection.selectObject(cs.objectId, { additive });
    } else if (cs.type === 'canvas' && !additive) {
      selection.clear();
    }
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
      document.body.classList.add('group-dragging');
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
    const reqW = clamp(g0.w + Math.round(rawDx), GROUP_MIN, GRID_COLUMNS - g0.x);
    const reqH = clamp(g0.h + Math.round(rawDy), GROUP_MIN, GRID_ROWS - g0.y);
    const cand = clampResizeToGroups({ x: g0.x, y: g0.y, w: reqW, h: reqH }, g.groupId);
    if (cand.w !== reqW || cand.h !== reqH) groupLayer.flashAlert(g.groupId);
    if (g.group.w === cand.w && g.group.h === cand.h) return;
    g.group.w = cand.w;
    g.group.h = cand.h;
    groupLayer.placeGroup(g.groupId);
    syncHandles();
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
    if (!g || !g.dragging) return;

    if (g.kind === 'move') {
      const dx = g.group.x - g.startRect.x;
      const dy = g.group.y - g.startRect.y;
      const grid = getGrid();
      if ((dx || dy) && grid) {
        // ONE debounced full PUT carries every member at its final position
        // (direct node writes — no collision resolution, see editor.js).
        grid.commitObjectRects(g.members.map((m) => ({ id: m.id, x: m.x + dx, y: m.y + dy })));
      }
      clearMemberTransforms(g);
      if (dx || dy) {
        patchGroup({ id: g.groupId, x: g.group.x, y: g.group.y });
      }
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

    // bbox + `margin` on each side (floor/ceil), clamped to the canvas. Below
    // the 4×4 minimum the box is widened symmetrically.
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
    // Collision against a group OUTSIDE the selection: fold back to margin 0,
    // then refuse + toast (nothing is written).
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
      // Absorb the selected groups: dissolve them server-side (objects stay).
      for (const id of absorbedIds) {
        try {
          await api.del(`/api/layout/groups/${id}`);
        } catch {
          /* best effort — the local model still absorbs it */
        }
      }
      state.layoutGroups = state.layoutGroups.filter((g) => !absorbedSet.has(String(g.id)));
      state.layoutGroups.push(created && created.id ? created : draft);
      selection.clear();
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

  async function ungroupSelected() {
    const id = selection.singleGroup();
    if (!id) return;
    try {
      await api.del(`/api/layout/groups/${id}`);
      state.layoutGroups = state.layoutGroups.filter((g) => String(g.id) !== String(id));
      selection.clear();
      groupLayer.render(state.layoutGroups, mode);
      applySelection();
      toast('Group removed — objects kept', 'success');
    } catch (err) {
      toast(err.message || 'Failed to remove group', 'error');
    }
  }

  async function deleteSelectedGroup() {
    const group = groupLayer.findGroup(selection.singleGroup());
    if (!group) return;
    const grid = getGrid();
    // Same STRICT containment as the server: only fully-inside objects go.
    const contained = grid
      ? grid.getObjectRects().filter((o) => contains(group, o)).map((o) => o.id)
      : [];
    try {
      await api.del(`/api/layout/groups/${group.id}?withObjects=1`);
      if (contained.length && grid) grid.removeObjects(contained);
      state.layoutGroups = state.layoutGroups.filter((g) => String(g.id) !== String(group.id));
      selection.clear();
      groupLayer.render(state.layoutGroups, mode);
      applySelection();
      toast(
        contained.length
          ? `Group deleted (${contained.length} object${contained.length > 1 ? 's' : ''} removed)`
          : 'Group deleted',
        'success'
      );
    } catch (err) {
      toast(err.message || 'Failed to delete group', 'error');
    }
  }

  // ---- lifecycle ------------------------------------------------------------
  function setMode(next) {
    mode = next === 'edit' ? 'edit' : 'view';
    if (mode !== 'edit') {
      clearHandles();
      document.body.classList.remove('group-dragging');
    }
    updateBar();
    syncHandles();
  }

  /** Drop selection + handles (called on every grid rebuild / page switch). */
  function reset() {
    selection.clear();
    clearHandles();
    disarmDelete();
    updateBar();
  }

  // ---- listeners ------------------------------------------------------------
  // CAPTURE phase: gridstack's drag engine stops mousedown propagation on
  // `.grid-stack-item`, so a bubble listener would never see an OBJECT press
  // (only the canvas + overlay handles). Capture runs first; for an object we
  // deliberately do NOT stop propagation, so gridstack still starts its drag.
  previewEl.addEventListener('mousedown', onPreviewMouseDown, true);
  previewEl.addEventListener('click', onPreviewClick, true);
  previewEl.addEventListener('mousemove', () => {
    if (mode === 'edit') syncHandles();
  });
  window.addEventListener('mousemove', onWindowMouseMove, true);
  window.addEventListener('mouseup', onWindowMouseUp, true);

  function destroy() {
    unsubscribeSelection();
    previewEl.removeEventListener('mousedown', onPreviewMouseDown, true);
    previewEl.removeEventListener('click', onPreviewClick, true);
    window.removeEventListener('mousemove', onWindowMouseMove, true);
    window.removeEventListener('mouseup', onWindowMouseUp, true);
    clearHandles();
    disarmDelete();
    bar.remove();
  }

  return { setMode, reset, syncHandles, destroy };
}
