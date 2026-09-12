import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.service.js';

/**
 * Layout service: CRUD over the grid layout persisted in `layout.json`.
 *
 * Schema version 3 — MULTIPLE PAGES (tabs):
 *   { version: 3, columns: <int 1..32>, activePageId: <uuid>, pages: [{ id, name, items: [...] }] }
 *
 * The whole layout (all pages + which page is active) lives in ONE file so the
 * "activePageId always points to an existing page" invariant is kept in a
 * single atomic write. Widgets are confined to their page (`items` per page);
 * `columns` stays global to the file.
 *
 * LAZY, NON-DESTRUCTIVE migration (in memory only):
 *   - file missing (or corrupt JSON → Store.read() returns null) → one empty
 *     "Home" page. A corrupt file additionally logs an error; NOTHING is ever
 *     written automatically — the original file is only rewritten by the first
 *   - legacy v1 (no `version`/`columns` fields, 12-column items) → items are
 *     wrapped into a "Home" page, `columns: 12` is KEPT so the frontend still
 *     applies its 12 → 32 migration exactly as before;
 *   - v2 ({ version: 2, columns, items }) → same wrap;
 *   - v3 → read directly (with tolerant coercion: missing page ids are
 *     regenerated, non-array items become [], unknown activePageId falls back
 *     to the first page).
 * `meta()` keeps reporting the ORIGINAL version/columns until the first
 * `_persist()` (the schema on disk is only migrated by a voluntary mutation),
 * so an old cached frontend keeps interpreting the coordinates as before.
 *
 * The 12 → 32 column conversion itself happens CLIENT-side (gridstack
 * `column(32, 'moveScale')` reflow) — the server only stores and reports the
 * column count; GET /api/layout returns it so the frontend knows how to
 * interpret the coordinates, and PUT /api/layout accepts it so the migrated
 * coordinates are persisted with columns: 32.
 */
const LAYOUT_VERSION = 3;
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 32;
export const LEGACY_COLUMNS = 12;
export const MAX_PAGES = 12;
export const PAGE_NAME_MAX = 40; // 1..40 chars after trim
const DEFAULT_PAGE_NAME = 'Home'; // page 1 is always called "Home"

export class LayoutService {
  constructor(store) {
    this.store = store;
    const loaded = this._load(); // never throws: every failure mode degrades to one empty page
    this.pages = loaded.pages; // [{ id, name, items }]
    this.activePageId = loaded.activePageId; // invariant: always an existing page's id
    this.columns = loaded.columns;
    // meta(): version/columns AS ON DISK — original values until the first
    // persisted mutation, then LAYOUT_VERSION/current columns.
    this.origVersion = loaded.version;
    this.origColumns = loaded.columns;
  }

  _load() {
    const data = this.store.read('layout', null);
    if (data === null) {
      // Missing file OR corrupt JSON (Store.read() cannot tell them apart).
      if (existsSync(this._file())) {
        console.error(
          '[layout] layout.json is corrupt — starting from a single empty "Home" page. ' +
            'The file is NOT rewritten automatically; it will be migrated (v3) on your first layout change.'
        );
      }
      return this._wrap([], LEGACY_COLUMNS, 1);
    }
    const columns = clampColumns(data?.columns, LEGACY_COLUMNS);
    const version = Number.isFinite(Number(data?.version)) ? Number(data.version) : 1;

    if (version >= 3) {
      const pages = this._coercePages(data.pages, data.items);
      if (pages) {
        const activePageId =
          typeof data.activePageId === 'string' && pages.some((p) => p.id === data.activePageId)
            ? data.activePageId
            : pages[0].id;
        return { pages, activePageId, columns, version };
      }
      // Malformed v3 (pages missing/empty) → fall through to a tolerant wrap
      // of the top-level items if any, else an empty "Home" page.
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    return this._wrap(items, columns, version);
  }

  /** One "Home" page wrapping a flat items array (v1/v2 → v3, in memory only). */
  _wrap(items, columns, version) {
    const page = { id: randomUUID(), name: DEFAULT_PAGE_NAME, items };
    return { pages: [page], activePageId: page.id, columns, version };
  }

  /**
   * Tolerant coercion of a v3 `pages` array: missing page ids are regenerated,
   * duplicate ids deduped, missing/blank names defaulted, non-array items → [].
   * Returns null when `rawPages` holds no usable page (caller falls back).
   */
  _coercePages(rawPages, fallbackItems) {
    if (!Array.isArray(rawPages)) return null;
    const pages = rawPages
      .filter((p) => p && typeof p === 'object')
      .map((p, i) => ({
        id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
        name: typeof p.name === 'string' && p.name.trim() ? p.name : i === 0 ? DEFAULT_PAGE_NAME : `Page ${i + 1}`,
        items: Array.isArray(p.items) ? p.items : Array.isArray(fallbackItems) && i === 0 ? fallbackItems : [],
      }));
    if (!pages.length) return null;
    const seen = new Set();
    for (const p of pages) {
      if (seen.has(p.id)) p.id = randomUUID();
      seen.add(p.id);
    }
    return pages;
  }

  _file() {
    return path.join(this.store.dataDir, 'layout.json');
  }

  /** Column count + schema version alongside the items (read path). */
  meta() {
    return { columns: this.origColumns, version: this.origVersion };
  }

  // ---- Page accessors -------------------------------------------------------

  page(id) {
    return this.pages.find((p) => p.id === id) ?? null;
  }

  activePage() {
    return this.page(this.activePageId);
  }

  /** Tab-strip payload: pages without their items (item counts only). */
  pagesSummary() {
    return this.pages.map(({ id, name, items }) => ({ id, name, itemCount: items.length }));
  }

  /**
   * Items of a page — defaults to the ACTIVE page so the legacy routes
   * (POST/PATCH/DELETE /items, GET/PUT /) keep working unchanged.
   */
  list(pageId) {
    const page = this.page(pageId === undefined ? this.activePageId : pageId);
    return page ? page.items : [];
  }

  // ---- Item mutations (target the ACTIVE page, except id-based lookups) -----

  /**
   * Replace the items of the active page (or `pageId`'s page). `columns`
   * (optional) is the grid the coordinates are expressed in; when absent the
   * previously stored value is kept, so an old cached frontend (PUT without
   * columns) can never corrupt the field.
   */
  replace(items, columns, pageId) {
    const page = this.page(pageId) ?? this.activePage();
    page.items = Array.isArray(items) ? items : [];
    if (columns !== undefined) this.columns = clampColumns(columns, this.columns);
    this._persist();
    return page.items;
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
    this.activePage().items.push(entry);
    this._persist();
    return entry;
  }

  /** Config updates look the id up across ALL pages (ids are globally unique). */
  updateConfig(id, config) {
    for (const page of this.pages) {
      const entry = page.items.find((i) => i.id === id);
      if (entry) {
        entry.config = { ...(entry.config || {}), ...(config || {}) };
        this._persist();
        return entry;
      }
    }
    return null;
  }

  remove(id) {
    for (const page of this.pages) {
      const before = page.items.length;
      page.items = page.items.filter((i) => i.id !== id);
      if (page.items.length !== before) {
        this._persist();
        return true;
      }
    }
    return false;
  }

  // ---- Page CRUD ------------------------------------------------------------

  /**
   * Create a page. `rawName` already validated/trimmed by the route, or
   * undefined → "Page N" (first free index). Page ids are server-generated
   * UUIDs and immutable.
   */
  createPage(rawName) {
    const name = rawName === undefined || rawName === null ? this._defaultPageName() : rawName;
    const page = { id: randomUUID(), name, items: [] };
    this.pages.push(page);
    this._persist();
    return { id: page.id, name: page.name };
  }

  renamePage(id, name) {
    const page = this.page(id);
    if (!page) return null;
    page.name = name;
    this._persist();
    return { id: page.id, name: page.name, itemCount: page.items.length };
  }

  /**
   * Delete a page. Deleting the LAST page is refused (`last-page`); deleting
   * the ACTIVE page falls back deterministically to the FIRST remaining page.
   * Returns `{ ok: true, activePageId }` or `{ ok: false, reason }`.
   */
  deletePage(id) {
    const index = this.pages.findIndex((p) => p.id === id);
    if (index === -1) return { ok: false, reason: 'not-found' };
    if (this.pages.length <= 1) return { ok: false, reason: 'last-page' };
    const [removed] = this.pages.splice(index, 1);
    if (this.activePageId === removed.id) {
      this.activePageId = this.pages[0].id; // invariant kept in the SAME write
    }
    this._persist();
    return { ok: true, activePageId: this.activePageId };
  }

  /** Switch the active page (persisted immediately — debounced). */
  setActive(id) {
    const page = this.page(id);
    if (!page) return null;
    this.activePageId = page.id;
    this._persist();
    return page;
  }

  _defaultPageName() {
    const taken = new Set(this.pages.map((p) => p.name));
    let n = 1;
    while (taken.has(`Page ${n}`)) n += 1;
    return `Page ${n}`;
  }

  _persist() {
    // Single atomic write keeps the v3 invariant (activePageId ↔ pages).
    this.origVersion = LAYOUT_VERSION;
    this.origColumns = this.columns;
    this.store.write(
      'layout',
      {
        version: LAYOUT_VERSION,
        columns: this.columns,
        activePageId: this.activePageId,
        pages: this.pages.map((p) => ({ id: p.id, name: p.name, items: p.items })),
      },
      500
    );
  }
}

function clampColumns(value, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, n));
}