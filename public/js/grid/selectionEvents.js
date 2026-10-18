/**
 * Coalesced `homy:selection` broadcast (layout v5, lot L6).
 *
 * The selection STATE lives in grid/selection.js (a DOM-free store). L6's
 * floating bar and the canvas renders need a single, low-cost notification per
 * FRAME — not one per mutation — so this module funnels every change into one
 * `window` CustomEvent, coalesced with `requestAnimationFrame`.
 *
 * Detail contract (stable — the bar and any future renderer subscribe to it):
 *   { objects: string[], groups: string[], count: number, source: string }
 * where `source` is one of 'click' | 'lasso' | 'keyboard' (the gesture that
 * produced the change; the LAST source wins when several mutations share a
 * frame). `count` is objects.length + groups.length (a convenience).
 *
 * Kept OUT of the store on purpose: the store stays DOM-free and side-effect
 * free, and the caller is the only one who knows the gesture `source`.
 */

import { selection } from './selection.js';

let scheduled = false;
let pendingSource = 'click';

/**
 * Schedule ONE `homy:selection` for the current frame. Safe to call from any
 * mutator (idempotent within a frame).
 */
export function emitSelection(source = 'click') {
  pendingSource = source || 'click';
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    const objects = [...selection.objects];
    const groups = [...selection.groups];
    const detail = { objects, groups, count: objects.length + groups.length, source: pendingSource };
    try {
      window.dispatchEvent(new CustomEvent('homy:selection', { detail }));
    } catch {
      /* a hostile environment (no CustomEvent) must never break a gesture */
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}
