/**
 * Selection state (layout v5, lot L4 — extensible for L6).
 *
 * A DEDICATED store for what is currently selected on the canvas. L4 only
 * needs single-group selection + a minimal multi-selection of OBJECTS (click /
 * Ctrl-Cmd-click / Shift-click) to power « Group selection ». L6 (lasso,
 * floating multi-selection bar, heterogeneous rigid translation, Ctrl+A,
 * keyboard delete) will reuse the SAME store, so nothing is hard-coded to
 * « one group » here: both collections are Sets.
 *
 * Contract:
 *   - `objects` : Set<objectId>  — v5 objects (widgets / elements / reports)
 *   - `groups`  : Set<groupId>   — group boxes
 *   - `onChange(cb)` returns an unsubscribe fn; subscribers re-apply the visual
 *     state (group ring, object ring, handles, context bar).
 *   - Mutators only emit when something actually changed (idempotent).
 *
 * The store is DOM-free and side-effect free: it never touches the DOM. The
 * visual layer (grid/groupEditor.js) subscribes.
 */

class Selection {
  constructor() {
    this.objects = new Set();
    this.groups = new Set();
    this._listeners = new Set();
  }

  /** Subscribe to any change. Returns an unsubscribe function. */
  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit() {
    for (const cb of [...this._listeners]) {
      try {
        cb(this);
      } catch (err) {
        // A broken subscriber must never break the others.
        console.error('[selection] listener failed', err);
      }
    }
  }

  isEmpty() {
    return this.objects.size === 0 && this.groups.size === 0;
  }

  isObjectSelected(id) {
    return this.objects.has(id);
  }

  isGroupSelected(id) {
    return this.groups.has(id);
  }

  /** The single selected group id (L4), or null. */
  singleGroup() {
    if (this.groups.size !== 1) return null;
    return this.groups.values().next().value;
  }

  clear() {
    if (this.isEmpty()) return;
    this.objects.clear();
    this.groups.clear();
    this._emit();
  }

  /**
   * Select an object. `additive` (Ctrl/Cmd/Shift) toggles it; a plain click
   * replaces the whole selection. Selecting an object always DROPS the group
   * selection unless additive.
   */
  selectObject(id, { additive = false } = {}) {
    if (id == null) return;
    if (!additive) {
      const same = this.objects.size === 1 && this.objects.has(id) && this.groups.size === 0;
      if (same) return;
      this.objects.clear();
      this.groups.clear();
      this.objects.add(id);
    } else if (this.objects.has(id)) {
      this.objects.delete(id);
    } else {
      this.objects.add(id);
    }
    this._emit();
  }

  /**
   * Select a group box. `additive` toggles it; a plain click replaces the
   * whole selection (dropping any object selection).
   */
  selectGroup(id, { additive = false } = {}) {
    if (id == null) return;
    if (!additive) {
      const same = this.groups.size === 1 && this.groups.has(id) && this.objects.size === 0;
      if (same) return;
      this.objects.clear();
      this.groups.clear();
      this.groups.add(id);
    } else if (this.groups.has(id)) {
      this.groups.delete(id);
    } else {
      this.groups.add(id);
    }
    this._emit();
  }

  /** Drop ids that no longer exist (page switch / deletion). */
  prune({ objectIds, groupIds } = {}) {
    let changed = false;
    if (objectIds) {
      for (const id of [...this.objects]) {
        if (!objectIds.has(id)) {
          this.objects.delete(id);
          changed = true;
        }
      }
    }
    if (groupIds) {
      for (const id of [...this.groups]) {
        if (!groupIds.has(id)) {
          this.groups.delete(id);
          changed = true;
        }
      }
    }
    if (changed) this._emit();
  }
}

/** Module singleton — one dashboard, one selection. */
export const selection = new Selection();
