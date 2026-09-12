import { randomUUID } from 'node:crypto';
import { Store } from './store.service.js';

/**
 * Layout service: CRUD over the grid items persisted in `layout.json`.
 *
 * The current layout is kept in memory so reads reflect pending writes
 * immediately, while disk writes are debounced via the Store.
 *
 * File schema (version 2):
 *   { version: 2, columns: <int 1..32>, items: [...] }
 * Legacy files (pre-migration) have no `columns`/`version` fields: they were
 * built on a 12-column grid. The 12 → 32 column conversion itself happens
 * CLIENT-side (gridstack `column(32, 'moveScale')` reflow) — the server only
 * stores and reports the column count; GET /api/layout returns it so the
 * frontend knows how to interpret the coordinates, and PUT /api/layout
 * accepts it so the migrated coordinates are persisted with columns: 32.
 */
const LAYOUT_VERSION = 2;
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 32;
export const LEGACY_COLUMNS = 12;

export class LayoutService {
  constructor(store) {
    this.store = store;
    const data = this._load();
    this.items = data.items;
    this.columns = data.columns;
    this.version = data.version;
  }

  _load() {
    const data = this.store.read('layout', null);
    const items = Array.isArray(data?.items) ? data.items : [];
    // No `columns` field (or garbage) → legacy 12-column layout.
    const columns = clampColumns(data?.columns, LEGACY_COLUMNS);
    const version = Number.isFinite(Number(data?.version)) ? Number(data.version) : 1;
    return { items, columns, version };
  }

  /** Column count + schema version alongside the items (read path). */
  meta() {
    return { columns: this.columns, version: this.version };
  }

  list() {
    return this.items;
  }

  /**
   * Replace the whole layout. `columns` (optional) is the grid the coordinates
   * are expressed in; when absent the previously stored value is kept, so an
   * old cached frontend (PUT without columns) can never corrupt the field.
   */
  replace(items, columns) {
    this.items = Array.isArray(items) ? items : [];
    if (columns !== undefined) this.columns = clampColumns(columns, this.columns);
    this.version = LAYOUT_VERSION;
    this._persist();
    return this.items;
  }

  add(item) {
    const entry = {
      id: item.id || randomUUID(),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      w: Number(item.w) || 11,
      h: Number(item.h) || 3,
      type: item.type || 'frame',
      config: item.config || {},
    };
    this.items.push(entry);
    this._persist();
    return entry;
  }

  updateConfig(id, config) {
    const entry = this.items.find((i) => i.id === id);
    if (!entry) return null;
    entry.config = { ...(entry.config || {}), ...(config || {}) };
    this._persist();
    return entry;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    this._persist();
    return true;
  }

  _persist() {
    this.store.write('layout', { version: this.version, columns: this.columns, items: this.items }, 500);
  }
}

function clampColumns(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, n));
}