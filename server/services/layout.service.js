import { randomUUID } from 'node:crypto';
import { Store } from './store.service.js';

/**
 * Layout service: CRUD over the grid items persisted in `layout.json`.
 *
 * The current layout is kept in memory so reads reflect pending writes
 * immediately, while disk writes are debounced via the Store.
 */
export class LayoutService {
  constructor(store) {
    this.store = store;
    this.items = this._load();
  }

  _load() {
    const data = this.store.read('layout', { items: [] });
    return Array.isArray(data?.items) ? data.items : [];
  }

  list() {
    return this.items;
  }

  replace(items) {
    this.items = Array.isArray(items) ? items : [];
    this.store.write('layout', { items: this.items }, 500);
    return this.items;
  }

  add(item) {
    const entry = {
      id: item.id || randomUUID(),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      w: Number(item.w) || 4,
      h: Number(item.h) || 3,
      type: item.type || 'frame',
      config: item.config || {},
    };
    this.items.push(entry);
    this.store.write('layout', { items: this.items }, 500);
    return entry;
  }

  updateConfig(id, config) {
    const entry = this.items.find((i) => i.id === id);
    if (!entry) return null;
    entry.config = { ...(entry.config || {}), ...(config || {}) };
    this.store.write('layout', { items: this.items }, 500);
    return entry;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    this.store.write('layout', { items: this.items }, 500);
    return true;
  }
}
