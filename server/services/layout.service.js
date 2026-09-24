import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.service.js';
import { WIDGET_MANIFEST_FINAL } from '../routes/widgets.routes.js';

/**
 * Layout service: CRUD over the grid layout persisted in `layout.json`.
 *
 * Schema version 4 — MULTIPLE PAGES (tabs) + GROUPS:
 *   { version: 4, columns: <int 1..32>, activePageId: <uuid>, pages: [{ id, name, items: [...] }] }
 *
 * v4 is an ADDITIVE change over v3: an item may now be
 *   { id, x, y, w, h, type: 'group', config, buttons: [...] }
 * The surviving widgets (clock/iframe/search/notes/weather) and `group` are the
 * valid item types; the legacy `frame`/`shortcut`/`links` types were REMOVED in
 * lot 6 and are now treated like any unknown type (skipped at load, one log).
 * v3 (and v1/v2) files remain readable and are normalized to v4 IN MEMORY ONLY: unknown item types
 * are skipped (tolerance, one log) and a `group` whose `buttons` is not an
 * array is coerced to []. The file is only rewritten on the first voluntary
 * mutation; `meta()` keeps reporting the on-disk version until then.
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
 *   - v3/v4 → read directly (with tolerant coercion: missing page ids are
 *     regenerated, non-array items become [], unknown activePageId falls back
 *     to the first page, unknown item types are skipped, malformed group
 *     `buttons` become []).
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
const LAYOUT_VERSION = 4;
export const MIN_COLUMNS = 1;
export const MAX_COLUMNS = 32;
export const LEGACY_COLUMNS = 12;
export const MAX_PAGES = 12;
export const PAGE_NAME_MAX = 40; // 1..40 chars after trim
const DEFAULT_PAGE_NAME = 'Home'; // page 1 is always called "Home"

/**
 * Item types the layout accepts: every widget in the manifest PLUS the new
 * `group` container. Kept in ONE place so load-time tolerance (this service)
 * and the PUT/POST validation (layout.routes.js) cannot drift apart.
 */
export const KNOWN_ITEM_TYPES = new Set([...WIDGET_MANIFEST_FINAL.map((w) => w.type), 'group']);

/** Group title-chip visibility values (mirrors the settingsSchema + the front). */
const TITLE_VISIBILITIES = new Set(['always', 'hover', 'never']);

/**
 * Tolerant `titleVisibility` coercion for a group config: any unknown/missing
 * value (or a hand-edited config) falls back to 'always', the documented
 * default. Mirrors normalizeTitleVisibility() in public/js/elements/group.js.
 */
export function normalizeTitleVisibility(raw) {
  return TITLE_VISIBILITIES.has(raw) ? raw : 'always';
}

// Per-group ZOOM (uniform scale of the group CONTENT: tiles + trame). The step
// is 0.05 so the slider and Ctrl+drag agree; the range is bounded so the trame
// stays usable. MUST stay in sync with GROUP_ZOOM_* in
// public/js/elements/group.js and with the `zoom` field of the group
// settingsSchema (defined in public/js/elements/group.js, mirrored in
// server/routes/widgets.routes.js — enforced by scripts/check-schema-sync.mjs).
const GROUP_ZOOM_MIN = 0.5;
const GROUP_ZOOM_MAX = 3;
const GROUP_ZOOM_DEFAULT = 1;
const GROUP_ZOOM_STEP = 0.05;

// Per-group TILE INSET (px): the ONE regular gap kept around every tile inside
// the group frame. Promoted from the former per-tile `surfaceInset` option so
// the whole trame spacing is homogeneous. MUST stay in sync with TILE_INSET_*
// in public/js/elements/group.js and the `tileInset` field of the group
// settingsSchema (mirrored in server/routes/widgets.routes.js — enforced by
// scripts/check-schema-sync.mjs).
const TILE_INSET_MIN = 0;
const TILE_INSET_MAX = 8;
const TILE_INSET_DEFAULT = 4;

/**
 * Tolerant group `zoom` coercion: a finite number inside [0.5, 3] (snapped to
 * the 0.05 step) is kept; anything missing, non-numeric or out of range (e.g.
 * 99 or "abc") falls back to 1 so a hand-edited / stale config can never
 * distort the group. Mirrors normalizeGroupZoom() in elements/group.js.
 */
export function normalizeGroupZoom(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < GROUP_ZOOM_MIN || n > GROUP_ZOOM_MAX) return GROUP_ZOOM_DEFAULT;
  const stepped = Math.round(n / GROUP_ZOOM_STEP) * GROUP_ZOOM_STEP;
  return Number(Math.min(GROUP_ZOOM_MAX, Math.max(GROUP_ZOOM_MIN, stepped)).toFixed(2));
}

/**
 * Tolerant group `tileInset` coercion: an integer px value inside [0, 8] is
 * kept; anything missing, non-numeric or out of range (e.g. 99, -1 or "abc")
 * falls back to the 4 px default — a stale / hand-edited config can never
 * collapse or distort the trame. Mirrors normalizeTileInset() in
 * public/js/elements/group.js.
 */
export function normalizeTileInset(raw) {
  if (raw === null || raw === undefined) return TILE_INSET_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < TILE_INSET_MIN || n > TILE_INSET_MAX) return TILE_INSET_DEFAULT;
  return Math.round(n);
}

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
            'The file is NOT rewritten automatically; it will be migrated (v4) on your first layout change.'
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

  /** One "Home" page wrapping a flat items array (v1/v2 → v4, in memory only). */
  _wrap(items, columns, version) {
    const page = { id: randomUUID(), name: DEFAULT_PAGE_NAME, items: this._coerceItems(items) };
    return { pages: [page], activePageId: page.id, columns, version };
  }

  /**
   * Tolerant coercion of a v3/v4 `pages` array: missing page ids are
   * regenerated, duplicate ids deduped, missing/blank names defaulted,
   * non-array items → []. Returns null when `rawPages` holds no usable page
   * (caller falls back).
   */
  _coercePages(rawPages, fallbackItems) {
    if (!Array.isArray(rawPages)) return null;
    const pages = rawPages
      .filter((p) => p && typeof p === 'object')
      .map((p, i) => ({
        id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
        name: typeof p.name === 'string' && p.name.trim() ? p.name : i === 0 ? DEFAULT_PAGE_NAME : `Page ${i + 1}`,
        items: this._coerceItems(
          Array.isArray(p.items) ? p.items : Array.isArray(fallbackItems) && i === 0 ? fallbackItems : []
        ),
      }));
    if (!pages.length) return null;
    const seen = new Set();
    for (const p of pages) {
      if (seen.has(p.id)) p.id = randomUUID();
      seen.add(p.id);
    }
    return pages;
  }

  /**
   * Tolerant per-item normalization on LOAD (never throws):
   *   - non-object items are dropped;
   *   - an item whose type is not known is dropped (one log per load);
   *   - a `group` gets a `buttons` array (non-array → []) with each button
   *     coerced to the valid shape (ids regenerated, options completed).
   * Non-group items are returned UNCHANGED (identity) so a v3 file with a
   * surviving widget is loaded without any loss.
   */
  _coerceItems(rawItems) {
    if (!Array.isArray(rawItems)) return [];
    const ignored = new Set();
    const out = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const type = String(item.type || '');
      if (!KNOWN_ITEM_TYPES.has(type)) {
        ignored.add(type);
        continue;
      }
      out.push(
        type === 'group'
          ? {
              ...item,
              config: normalizeGroupConfig(item.config),
              buttons: coerceButtons(item.buttons),
              reports: coerceReports(item.reports),
            }
          : item
      );
    }
    if (ignored.size) {
      console.warn(`[layout] ignoring unknown item type(s) on load: ${[...ignored].join(', ')}`);
    }
    return out;
  }

  _file() {
    return path.join(this.store.dataDir, 'layout.json');
  }

  /** Column count + schema version alongside the items (read path). */
  meta() {
    return { columns: this.origColumns, version: this.origVersion };
  }

  /**
   * Every `group` button referencing `elementId`, with its page + group.
   * Used by the catalogue routes (usage endpoint + guarded delete). The id is
   * matched exactly; an unknown id simply yields [].
   */
  findElementUsages(elementId) {
    const usages = [];
    for (const page of this.pages) {
      for (const item of page.items) {
        if (!item || item.type !== 'group' || !Array.isArray(item.buttons)) continue;
        for (const button of item.buttons) {
          if (button && button.elementId === elementId) {
            usages.push({ pageId: page.id, name: page.name, groupId: item.id });
          }
        }
      }
    }
    return usages;
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
    const type = item.type || '';
    const entry = {
      id: item.id || randomUUID(),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      w: Number(item.w) || 11,
      h: Number(item.h) || 3,
      type,
      config: item.config || {},
    };
    if (type === 'group') {
      entry.buttons = Array.isArray(item.buttons) ? item.buttons : [];
      entry.reports = Array.isArray(item.reports) ? item.reports : [];
    }
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
        // Tolerant normalization on write: a group's titleVisibility can only
        // ever be stored as one of always|hover|never (unknown → always) and
        // its zoom as a finite number in [0.5, 3] (unknown/out-of-range → 1).
        if (entry.type === 'group') {
          entry.config.titleVisibility = normalizeTitleVisibility(entry.config.titleVisibility);
          entry.config.zoom = normalizeGroupZoom(entry.config.zoom);
          entry.config.tileInset = normalizeTileInset(entry.config.tileInset);
        }
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
    // Single atomic write keeps the v4 invariant (activePageId ↔ pages).
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

/**
 * Group config normalization on load/write: the `titleVisibility` key is
 * coerced to one of always|hover|never (unknown/missing → always), `zoom`
 * to a finite number in [0.5, 3] (unknown/out-of-range → 1) and `tileInset`
 * to an integer px value in [0, 8] (unknown/out-of-range → 4). Every other
 * config key passes through untouched (tolerance: never drops user data).
 */
export function normalizeGroupConfig(config) {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    ...c,
    titleVisibility: normalizeTitleVisibility(c.titleVisibility),
    zoom: normalizeGroupZoom(c.zoom),
    tileInset: normalizeTileInset(c.tileInset),
  };
}

/**
 * Tolerant coercion of a group's `buttons` on LOAD (never throws): non-array →
 * [], non-object rows dropped, ids regenerated when missing, coordinates
 * floored/clamped into the documented ranges, options completed with their
 * defaults. The per-group/per-page CAPS are NOT enforced here — load tolerance
 * never drops user data; caps are a write-time validation concern.
 */
function coerceButtons(raw) {
  if (!Array.isArray(raw)) return [];
  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  const out = [];
  for (const button of raw) {
    if (!button || typeof button !== 'object') continue;
    let col = int(button.col);
    if (col === null || col < 0) col = 0;
    let row = int(button.row);
    if (row === null || row < 0) row = 0;
    const w = Math.min(4, Math.max(1, int(button.w) ?? 1));
    const h = Math.min(4, Math.max(1, int(button.h) ?? 1));
    out.push({
      id: typeof button.id === 'string' && button.id ? button.id : randomUUID(),
      elementId: typeof button.elementId === 'string' ? button.elementId : '',
      col,
      row,
      w,
      h,
      options: normOptions(button.options),
    });
  }
  return out;
}

// Button icon size (per-button display option) — a PERCENTAGE of the tile's
// useful internal dimension, 0.5-step, range 8..120. Legacy letter crans
// (S/M/L/XL/Fill) are accepted and coerced to 40/55/70/85/100. MUST stay in
// sync with the ICON_* constants in server/routes/layout.routes.js and
// public/js/elements/button.js.
const ICON_SIZE_MIN = 8;
const ICON_SIZE_MAX = 120;
const ICON_SIZE_DEFAULT = 55;
const ICON_SIZE_STEP = 0.5;
const ICON_SIZE_PRESETS = { S: 40, M: 55, L: 70, XL: 85, Fill: 100 };
const LABEL_POSITIONS = new Set(['bottom', 'top', 'left', 'right']);
// Per-tile SURFACE options — mirror of layout.routes.js / elements/button.js.
const SURFACE_OPACITY_MIN = 0;
const SURFACE_OPACITY_MAX = 100;
const SURFACE_OPACITY_DEFAULT = 100;
const SURFACE_INSET_MIN = 0;
const SURFACE_INSET_MAX = 8;
const SURFACE_INSET_DEFAULT = 0;
const SURFACE_SHAPES = new Set(['rounded', 'square']);
const SURFACE_SHAPE_DEFAULT = 'rounded';
const SURFACE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([0-9a-zA-Z.,%\s/]+\)|[a-zA-Z]{3,20})$/;

// Report-tile geometry bounds (INTERNAL trame cells). Reports have a FREE size
// (no button-variant minima): 2 cells minimum, up to a generous cap. MUST stay
// in sync with REPORT_CELLS_MIN/MAX in server/routes/layout.routes.js and
// public/js/elements/reportTile.js.
const REPORT_CELLS_MIN = 2;
const REPORT_CELLS_MAX = 64;
/**
 * Tolerant option coercion on LOAD: unknown/missing keys are defaulted, so a
 * button stored before `iconSize`/`allowIconOverflow` existed still loads.
 */
function normOptions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  return {
    icon: bool(o.icon, true),
    label: bool(o.label, true),
    shortcut: bool(o.shortcut, true),
    health: bool(o.health, false),
    monitoring: bool(o.monitoring, false),
    controls: bool(o.controls, false),
    iconSize: normIconSize(o.iconSize),
    labelPosition: LABEL_POSITIONS.has(o.labelPosition) ? o.labelPosition : 'bottom',
    allowIconOverflow: bool(o.allowIconOverflow, false),
    surfaceOpacity: normSurfaceOpacity(o.surfaceOpacity),
    surfaceInset: normSurfaceInset(o.surfaceInset),
    surfaceShape: SURFACE_SHAPES.has(o.surfaceShape) ? o.surfaceShape : SURFACE_SHAPE_DEFAULT,
    surfaceColor: normSurfaceColor(o.surfaceColor),
  };
}

/** Clamp a surface opacity to an integer percentage in [0,100] (default 100). */
function normSurfaceOpacity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SURFACE_OPACITY_DEFAULT;
  return Math.min(SURFACE_OPACITY_MAX, Math.max(SURFACE_OPACITY_MIN, Math.round(n)));
}

/** Clamp a surface inset to an integer px value in [0,8] (default 0). */
function normSurfaceInset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SURFACE_INSET_DEFAULT;
  return Math.min(SURFACE_INSET_MAX, Math.max(SURFACE_INSET_MIN, Math.round(n)));
}

/** Tolerant surface colour coercion: a plausible CSS colour, else '' (theme). */
function normSurfaceColor(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 64) return '';
  return SURFACE_COLOR_RE.test(s) ? s : '';
}

/** Tolerant icon-size coercion on LOAD (see layout.routes.js for the contract). */
function normIconSize(raw) {
  let n = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) n = raw;
  else if (typeof raw === 'string') {
    const key = raw.trim();
    if (Object.prototype.hasOwnProperty.call(ICON_SIZE_PRESETS, key)) return ICON_SIZE_PRESETS[key];
    const parsed = Number(key);
    if (key && Number.isFinite(parsed)) n = parsed;
  }
  if (n === null) return ICON_SIZE_DEFAULT;
  const stepped = Math.round(n / ICON_SIZE_STEP) * ICON_SIZE_STEP;
  return Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, stepped));
}

/**
 * Tolerant coercion of a group's `reports[]` on LOAD (never throws): non-array
 * → [], non-object rows dropped, ids regenerated when missing, geometry
 * floored/clamped. Report tiles have a FREE size on the internal trame (no
 * button-variant minima) — only [REPORT_CELLS_MIN, REPORT_CELLS_MAX] is
 * enforced here; caps are a write-time concern.
 */
function coerceReports(raw) {
  if (!Array.isArray(raw)) return [];
  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  const out = [];
  for (const report of raw) {
    if (!report || typeof report !== 'object') continue;
    let col = int(report.col);
    if (col === null || col < 0) col = 0;
    let row = int(report.row);
    if (row === null || row < 0) row = 0;
    const w = Math.min(REPORT_CELLS_MAX, Math.max(REPORT_CELLS_MIN, int(report.w) ?? REPORT_CELLS_MIN));
    const h = Math.min(REPORT_CELLS_MAX, Math.max(REPORT_CELLS_MIN, int(report.h) ?? REPORT_CELLS_MIN));
    out.push({
      id: typeof report.id === 'string' && report.id ? report.id : randomUUID(),
      elementId: typeof report.elementId === 'string' ? report.elementId : '',
      col,
      row,
      w,
      h,
    });
  }
  return out;
}