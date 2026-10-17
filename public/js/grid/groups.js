/**
 * Group BOXES — render + hit-test layer (layout v5, lot L2).
 *
 * A v5 group is a CONTENT-LESS box `{ id, x, y, w, h, config }` (see
 * server/services/layout.service.js). It owns no membership: an object belongs
 * to a group purely by geometry (`rect.contains(point)`), computed here.
 *
 * DOM CONTRACT (see #grid-preview in index.html / style.css):
 *   #grid-preview
 *     .group-layer   ← FIRST child (this module) — the boxes, z under the grid
 *     #grid-preview-bg
 *     #grid-container.grid-stack
 *     .overlay-layer ← LAST child, EDIT only — lasso / selection / handles
 *
 * GEOMETRY — a SINGLE conversion unit: `u = canvasW/64`, `v = canvasH/36`,
 * published ONCE on #grid-preview as --unit-w / --unit-h (main.js
 * syncCanvas). Every .group-box positions itself with
 * `left: calc(x * var(--unit-w))` etc. — a box NEVER measures anything (no
 * getBoundingClientRect of positioning): the layer is the canvas box, the
 * boxes are pure multiples of the unit.
 *
 * The module is DOM-only and side-effect free at import time; create it once
 * with createGroupLayer(#grid-preview) and drive it from main.js's setMode().
 */

import { GRID_COLUMNS, GRID_ROWS } from './config.js';
import { applyAppearance } from '../widgets/registry.js';
import { el } from '../util.js';

/** Group title-chip visibility values. Mirrors the server set. */
const TITLE_VISIBILITIES = new Set(['always', 'hover', 'never']);

/**
 * Tolerant `titleVisibility` coercion: any unknown/missing value falls back to
 * 'always'. Mirrors normalizeTitleVisibility() in server/services/layout.service.js.
 */
export function normalizeTitleVisibility(raw) {
  return TITLE_VISIBILITIES.has(raw) ? raw : 'always';
}

/**
 * Pure geometry of a group box, in FINE units (integers). Tolerant: a
 * hand-edited group gets sane defaults instead of poisoning the layer.
 */
export function groupRect(group) {
  const g = group && typeof group === 'object' ? group : {};
  return {
    x: Math.max(0, Math.floor(Number(g.x)) || 0),
    y: Math.max(0, Math.floor(Number(g.y)) || 0),
    w: Math.max(1, Math.floor(Number(g.w)) || 1),
    h: Math.max(1, Math.floor(Number(g.h)) || 1),
  };
}

/** Half-open contains test on the fine trame: [x, x+w[ × [y, y+h[. */
export function rectContains(rect, point) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.w &&
    point.y >= rect.y &&
    point.y < rect.y + rect.h
  );
}

/**
 * PURE hit-test: `point` is in FINE units. Iterates the groups LAST → FIRST
 * (topmost first) and returns the first whose rect contains the point, or null.
 */
export function hitGroups(groups, point) {
  if (!Array.isArray(groups) || !point) return null;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g && rectContains(groupRect(g), point)) return g;
  }
  return null;
}

/**
 * Group layer controller. Owns the two overlay layers inside #grid-preview and
 * the group boxes of the active page.
 *
 * Returned API:
 *   setMode(mode)             — 'view' | 'edit': toggles the overlay layer.
 *   render(groups, mode)      — (re)build every .group-box of the page.
 *   syncCanvas(container)     — pin --unit-w/--unit-h + the layer box from the
 *                               LIVE canvas box (VIEW fit / EDIT logical box).
 *   pointerMove(clientX, clientY) — hover hit-test; returns the hit group|null.
 *   clearHover()              — drop any .group-hover (mouseleave).
 *   reorder()                 — re-assert the layer order after a grid rebuild.
 *   destroy()                 — detach both layers.
 */
export function createGroupLayer(previewEl) {
  const layer = el('div', 'group-layer');
  const overlay = el('div', 'overlay-layer');
  layer.dataset.mode = 'view';
  previewEl.prepend(layer);

  let groups = [];
  let cache = []; // [{ group, rect }] — invalidated on every mutation
  let rectsDirty = true;
  let mode = 'view';
  let hoveredId = null;

  function invalidate() {
    rectsDirty = true;
  }

  /** Cached rects, recomputed lazily after the last mutation (rectsDirty). */
  function cachedRects() {
    if (rectsDirty) {
      cache = groups.map((g) => ({ group: g, rect: groupRect(g) }));
      rectsDirty = false;
    }
    return cache;
  }

  /** Cache-backed hit test (same last→first rule as hitGroups). */
  function hitCached(point) {
    const list = cachedRects();
    for (let i = list.length - 1; i >= 0; i--) {
      if (rectContains(list[i].rect, point)) return list[i].group;
    }
    return null;
  }

  function boxFor(id) {
    for (const node of layer.children) {
      if (node.dataset && node.dataset.groupId === id) return node;
    }
    return null;
  }

  function setHover(id) {
    if (hoveredId === id) return;
    if (hoveredId != null) boxFor(hoveredId)?.classList.remove('group-hover');
    hoveredId = id;
    if (id != null) boxFor(id)?.classList.add('group-hover');
    // Cursor feedback: only EDIT makes a group a grabbable target (L4 engine).
    previewEl.classList.toggle('group-hovering', mode === 'edit' && id != null);
  }

  /** Build one .group-box (+ its floating title chip unless `never`). */
  function buildBox(group) {
    const box = el('div', 'group-box', null, { 'data-group-id': String(group?.id || '') });
    const config = group && group.config && typeof group.config === 'object' ? group.config : {};
    // SAME appearance contract as .grid-stack-item-content: applyAppearance sets
    // --widget-* vars and `data-surface-off` when bgColor is set at bgOpacity:0
    // (background + backdrop-filter off, border kept — see style.css).
    applyAppearance(box, config);
    // backdrop-filter is conditionally paid for: only when a background color is
    // set AND the fill is not neutralized (bgOpacity > 0 && bgColor).
    const bgColor = String(config.bgColor || '').trim();
    if (bgColor && !('surfaceOff' in box.dataset)) box.setAttribute('data-group-blur', '');
    box.dataset.titleVisibility = normalizeTitleVisibility(config.titleVisibility);
    if (box.dataset.titleVisibility !== 'never') {
      const header = el('div', 'group-header');
      header.appendChild(el('span', 'group-title', String(config.title || '')));
      box.appendChild(header);
    }
    return box;
  }

  /** Position a box in FINE units — pure CSS multiplication, no measurement. */
  function place(box, group) {
    const r = groupRect(group);
    box.style.left = `calc(${r.x} * var(--unit-w, 1px))`;
    box.style.top = `calc(${r.y} * var(--unit-h, 1px))`;
    box.style.width = `calc(${r.w} * var(--unit-w, 1px))`;
    box.style.height = `calc(${r.h} * var(--unit-h, 1px))`;
  }

  function setMode(next) {
    mode = next === 'edit' ? 'edit' : 'view';
    layer.dataset.mode = mode;
    if (mode !== 'edit') previewEl.classList.remove('group-hovering');
    if (mode === 'edit') {
      // The overlay layer (lasso / selection / handles) exists ONLY in edit.
      if (previewEl.lastChild !== overlay) previewEl.append(overlay);
    } else if (overlay.isConnected) {
      overlay.remove();
    }
  }

  /** Re-assert the layer order after gridstack appended a fresh container. */
  function reorder() {
    if (previewEl.firstChild !== layer) previewEl.prepend(layer);
    if (mode === 'edit' && previewEl.lastChild !== overlay) previewEl.append(overlay);
  }

  /** (Re)build every group box for `nextGroups` and switch to `nextMode`. */
  function render(nextGroups, nextMode = mode) {
    setMode(nextMode);
    groups = Array.isArray(nextGroups) ? nextGroups : [];
    layer.replaceChildren();
    for (const g of groups) {
      const box = buildBox(g);
      place(box, g);
      layer.appendChild(box);
    }
    hoveredId = null;
    invalidate();
  }

  /**
   * Pin the conversion units + the layer box from the LIVE canvas container.
   * The layer becomes a byte-for-byte copy of #grid-container's layout box, so
   * a sibling transform (EDIT dezoom, mode animation on #grid-preview) applies
   * to both identically. No box is ever measured.
   */
  function syncCanvas(container) {
    if (!container) return;
    const w = container.offsetWidth;
    const h = container.offsetHeight;
    if (!(w > 0 && h > 0)) return;
    previewEl.style.setProperty('--unit-w', `${w / GRID_COLUMNS}px`);
    previewEl.style.setProperty('--unit-h', `${h / GRID_ROWS}px`);
    const left = `${container.offsetLeft}px`;
    const top = `${container.offsetTop}px`;
    const box = `${w}px`;
    const tall = `${h}px`;
    layer.style.left = left;
    layer.style.top = top;
    layer.style.width = box;
    layer.style.height = tall;
    if (overlay.isConnected) {
      overlay.style.left = left;
      overlay.style.top = top;
      overlay.style.width = box;
      overlay.style.height = tall;
    }
  }

  /**
   * Hover hit-test from a client point. Converts to FINE units through the LIVE
   * rendered layer rect (transform-aware: EDIT dezoom included), toggles
   * `.group-hover`, and returns the hit group (or null). Works in VIEW and EDIT
   * (hover `titleVisibility` is revealed in both modes).
   */
  function pointerMove(clientX, clientY) {
    if (!groups.length) return null;
    const rect = layer.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const u = rect.width / GRID_COLUMNS;
    const v = rect.height / GRID_ROWS;
    const point = { x: (clientX - rect.left) / u, y: (clientY - rect.top) / v };
    const hit = hitCached(point);
    setHover(hit ? hit.id : null);
    return hit;
  }

  function clearHover() {
    setHover(null);
  }

  const onMouseMove = (e) => pointerMove(e.clientX, e.clientY);
  previewEl.addEventListener('mousemove', onMouseMove);
  previewEl.addEventListener('mouseleave', clearHover);

  function destroy() {
    previewEl.removeEventListener('mousemove', onMouseMove);
    previewEl.removeEventListener('mouseleave', clearHover);
    layer.remove();
    overlay.remove();
    cache = [];
    groups = [];
  }

  return {
    setMode,
    render,
    reorder,
    syncCanvas,
    pointerMove,
    clearHover,
    destroy,
    layer,
    overlay,
  };
}
