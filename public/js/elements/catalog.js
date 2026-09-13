import { api } from '../api.js';

/**
 * Lightweight client for the GLOBAL element catalogue (`GET /api/elements`).
 *
 * The catalogue (`elements.json` server-side) is a STABLE referential that a
 * `group`'s buttons reference by `id`. It is fetched once per session, kept in
 * a memory cache (id → element) and re-fetched on demand (`refresh()`).
 *
 * TOLERANCE CONTRACT (this module NEVER throws):
 *  - a failed / rejected request keeps whatever was already cached and only
 *    logs a muted warning — a group must still render (with placeholders) when
 *    the catalogue is momentarily unreachable;
 *  - a malformed payload degrades to an empty list rather than throwing;
 *  - concurrent `load()` calls are de-duplicated through a single in-flight
 *    promise so a page with many groups issues exactly ONE request.
 *
 * `subscribe(cb)` notifies listeners (groups) after every successful load so a
 * group rendered BEFORE the catalogue resolved can redraw itself with the real
 * element names/icons. Every subscriber must unsubscribe from its widget
 * cleanup (see disposeWidget) to avoid leaks.
 */

let elements = [];
let byId = new Map();
let loaded = false;
let inflight = null;
const listeners = new Set();

function index(list) {
  elements = Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
  byId = new Map();
  for (const entry of elements) {
    if (typeof entry.id === 'string' && entry.id) byId.set(entry.id, entry);
  }
}

function notify() {
  for (const cb of [...listeners]) {
    try {
      cb(elements);
    } catch (err) {
      // A broken listener must never take the catalogue (or the other
      // listeners) down with it.
      console.warn('[catalog] listener failed:', err);
    }
  }
}

export const catalog = {
  /** Cached element for an id, or null (unknown / not loaded yet). */
  get(id) {
    if (!id) return null;
    return byId.get(String(id)) || null;
  },

  has(id) {
    return id != null && byId.has(String(id));
  },

  /** Cached list (may be empty before the first successful load). */
  list() {
    return elements;
  },

  isLoaded() {
    return loaded;
  },

  /**
   * Register a listener called after every successful load. Returns an
   * unsubscribe function (safe to call multiple times).
   */
  subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /**
   * Load the catalogue. Returns the cached list immediately when already
   * loaded (unless `force`). Never rejects.
   */
  load({ force = false } = {}) {
    if (!force && loaded) return Promise.resolve(elements);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await api.get('/api/elements');
        index(res?.elements);
        loaded = true;
        notify();
      } catch (err) {
        // Degrade silently (muted): keep the previous cache, never throw.
        console.warn('[catalog] failed to load elements:', err?.message || err);
      } finally {
        inflight = null;
      }
      return elements;
    })();
    return inflight;
  },

  /** Force a re-fetch (e.g. after the catalogue screen mutates an element). */
  refresh() {
    return this.load({ force: true });
  },

  /** Drop the cache (logout / instance switch). */
  clear() {
    elements = [];
    byId = new Map();
    loaded = false;
    inflight = null;
  },
};
