import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.service.js';
import { WIDGET_MANIFEST_FINAL } from '../routes/widgets.routes.js';

/**
 * Layout service: CRUD over the grid layout persisted in `layout.json`.
 *
 * Schema version 5 — "ComfyUI-style" model:
 *   {
 *     version: 5, columns: 64, rows: 36,
 *     activePageId: <uuid>,
 *     pages: [{ id, name, objects: [...], groups: [...] }]
 *   }
 *
 * `columns`/`rows` are FIXED (64×36 fine units, 1 unit = ½ global cell, so the
 * 16:9 aspect is unchanged). They are persisted for forward-compatibility but
 * never vary.
 *
 * An OBJECT is one of (kind = the single discriminant; `type` is reserved to
 * widgets):
 *   - widget : { id, kind:'widget', type, x, y, w, h, config }
 *   - element: { id, kind:'element', elementId, x, y, w, h, options }
 *   - report : { id, kind:'report', elementId, x, y, w, h }
 *
 * A GROUP is a titled BOX with NO content and NO membership data stored:
 *   - group  : { id, x, y, w, h, config }   (config = title/titleVisibility + appearance)
 *
 * Group membership will become a pure `contains(group, object)` function in a
 * later lot — NOTHING here stores `groupId` on an object nor `members` on a
 * group.
 *
 * LAZY, NON-DESTRUCTIVE migration (in memory only):
 *   - file missing / corrupt JSON → one empty "Home" page (a corrupt file logs
 *     an error; NOTHING is written automatically);
 *   - version < 5 → `migrateLayoutV5()` (pure, idempotent) is applied IN MEMORY:
 *     v4 widgets/groups ×2, a group's buttons/reports become absolute-positioned
 *     element/report objects, `zoom`/`tileInset`/legacy keys are STRIPPED, and
 *     legacy (v1/v2) 12-column coordinates are rescaled to the 64-column trame.
 *   - version >= 5 → read directly (tolerant coercion).
 * The original file is only rewritten by the first voluntary mutation; the
 * atomic Store copies the previous file to `<file>.bak` before that write.
 *
 * `MAX_OBJECTS_PER_PAGE`/`MAX_GROUPS_PER_PAGE` bound a page on WRITE; load-time
 * tolerance never drops user data (it only clamps geometry).
 */

export const LAYOUT_VERSION = 5;
export const GRID_COLUMNS = 64;
export const GRID_ROWS = 36;
export const LEGACY_COLUMNS = 12;
export const MAX_PAGES = 12;
export const PAGE_NAME_MAX = 40; // 1..40 chars after trim
export const MAX_OBJECTS_PER_PAGE = 200;
export const MAX_GROUPS_PER_PAGE = 32;
export const MIN_OBJECT = 2; // every object is at least 2×2 fine units
export const MIN_GROUP = 4; // a group box is at least 4×4 fine units
export const MAX_ELEMENT_SIZE = 4; // an element (button) is at most 4×4 fine units
export const MAX_REPORT_SIZE = 64; // reports keep a free size up to the canvas width
const DEFAULT_PAGE_NAME = 'Home'; // page 1 is always called "Home"

/** Object kinds — the SINGLE discriminant of a layout object. */
export const OBJECT_KINDS = new Set(['widget', 'element', 'report']);

/** Widget types the layout accepts (the manifest, minus the removed `group`). */
export const KNOWN_WIDGET_TYPES = new Set(WIDGET_MANIFEST_FINAL.map((w) => w.type));

/**
 * Group-config keys DROPPED on load/migration (group `zoom` and per-group
 * `tileInset` were removed in v5). MUST stay in sync with V4_STRIP in
 * public/js/grid/migrate.js.
 */
export const STRIP_KEYS = ['zoom', 'tileInset'];

/** Group title-chip visibility values (mirrors the front group schema). */
const TITLE_VISIBILITIES = new Set(['always', 'hover', 'never']);

/**
 * Tolerant `titleVisibility` coercion for a group config: any unknown/missing
 * value (or a hand-edited config) falls back to 'always', the documented
 * default. Mirrors normalizeTitleVisibility() in public/js/grid/groups.js.
 */
export function normalizeTitleVisibility(raw) {
  return TITLE_VISIBILITIES.has(raw) ? raw : 'always';
}

// ---------------------------------------------------------------------------
// Pure migration v4 (and legacy v1/v2/v3) → v5.
// ---------------------------------------------------------------------------

/**
 * Pure, IDEMPOTENT v4→v5 migration. `version >= 5` returns the input unchanged,
 * so applying it twice is a no-op. Ids are preserved. Nothing is logged here
 * (purity); the caller reports the strip/zoom warnings.
 *
 *   - widget : x,y,w,h ×2 (already 32-col global cells)
 *   - group  : x,y,w,h ×2 ; its `buttons`/`reports` become element/report
 *              objects at ABSOLUTE fine coordinates (x' = gx*2 + col,
 *              y' = gy*2 + row, w/h verbatim);
 *   - element/report : rendered at the same pixel as a non-zoomed v4 group;
 *   - group config   : `zoom`/`tileInset` stripped;
 *   - legacy 12-col files (columns === 12) are rescaled to the 64-col trame
 *     (round(x*64/12), ×2 on rows) with even parity on widgets.
 */
export function migrateLayoutV5(raw) {
  if (!raw || typeof raw !== 'object') {
    return { version: LAYOUT_VERSION, columns: GRID_COLUMNS, rows: GRID_ROWS, activePageId: null, pages: [] };
  }
  const version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1;
  if (version >= LAYOUT_VERSION) return raw; // idempotent

  const cols = Number.isFinite(Number(raw.columns)) ? Number(raw.columns) : LEGACY_COLUMNS;
  const legacy12 = cols === LEGACY_COLUMNS;

  let pages;
  if (Array.isArray(raw.pages) && raw.pages.length) {
    pages = raw.pages
      .filter((p) => p && typeof p === 'object')
      .map((p, i) => migratePage(p, i, legacy12));
  } else {
    const items = Array.isArray(raw.items) ? raw.items : [];
    pages = [migratePage({ name: DEFAULT_PAGE_NAME, items }, 0, legacy12)];
  }
  if (!pages.length) pages = [migratePage({ name: DEFAULT_PAGE_NAME, items: [] }, 0, legacy12)];

  const activePageId =
    typeof raw.activePageId === 'string' && pages.some((p) => p.id === raw.activePageId)
      ? raw.activePageId
      : pages[0].id;

  return { version: LAYOUT_VERSION, columns: GRID_COLUMNS, rows: GRID_ROWS, activePageId, pages };
}

function migratePage(page, index, legacy12) {
  const { objects, groups } = migrateItems(Array.isArray(page.items) ? page.items : [], legacy12);
  const name =
    typeof page.name === 'string' && page.name.trim()
      ? page.name
      : index === 0
        ? DEFAULT_PAGE_NAME
        : `Page ${index + 1}`;
  return {
    id: typeof page.id === 'string' && page.id ? page.id : randomUUID(),
    name,
    objects,
    groups,
  };
}

function migrateItems(items, legacy12) {
  const objects = [];
  const groups = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (type === 'group') {
      const migrated = migrateGroup(item, legacy12);
      groups.push(migrated.box);
      objects.push(...migrated.objects);
    } else if (KNOWN_WIDGET_TYPES.has(type)) {
      objects.push(migrateWidget(item, legacy12));
    }
    // `frame`/`shortcut`/`links`/unknown types are skipped (tolerance).
  }
  return { objects, groups };
}

function migrateWidget(item, legacy12) {
  const r = scaleV4Rect(item, legacy12);
  const rect = legacy12 ? toEvenRect(r) : r;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
    kind: 'widget',
    type: String(item.type || ''),
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    config: plainObject(item.config),
  };
}

function migrateGroup(item, legacy12) {
  // Groups only ever existed in v4 (32-col); the legacy-12 branch is defensive.
  const r = scaleV4Rect(item, legacy12);
  const box = {
    id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
    x: r.x,
    y: r.y,
    w: Math.max(MIN_GROUP, r.w),
    h: Math.max(MIN_GROUP, r.h),
    config: stripGroupConfig(item.config),
  };
  const gx = box.x;
  const gy = box.y;
  const objects = [];
  for (const b of Array.isArray(item.buttons) ? item.buttons : []) {
    if (!b || typeof b !== 'object' || !b.elementId) continue;
    objects.push({
      id: typeof b.id === 'string' && b.id ? b.id : randomUUID(),
      kind: 'element',
      elementId: String(b.elementId),
      x: gx + intOr(b.col, 0),
      y: gy + intOr(b.row, 0),
      w: clamp(intOr(b.w, 1), 1, MAX_ELEMENT_SIZE),
      h: clamp(intOr(b.h, 1), 1, MAX_ELEMENT_SIZE),
      options: normOptions(stripOptions(b.options)),
    });
  }
  for (const rep of Array.isArray(item.reports) ? item.reports : []) {
    if (!rep || typeof rep !== 'object' || !rep.elementId) continue;
    objects.push({
      id: typeof rep.id === 'string' && rep.id ? rep.id : randomUUID(),
      kind: 'report',
      elementId: String(rep.elementId),
      x: gx + intOr(rep.col, 0),
      y: gy + intOr(rep.row, 0),
      w: clamp(intOr(rep.w, MIN_OBJECT), MIN_OBJECT, MAX_REPORT_SIZE),
      h: clamp(intOr(rep.h, MIN_OBJECT), MIN_OBJECT, GRID_ROWS),
    });
  }
  return { box, objects };
}

/** v4 rect → fine rect. Legacy 12-col files are rescaled; others are doubled. */
function scaleV4Rect(item, legacy12) {
  const x = intOr(item.x, 0);
  const y = intOr(item.y, 0);
  const w = Math.max(1, intOr(item.w, 1));
  const h = Math.max(1, intOr(item.h, 1));
  if (legacy12) {
    const w64 = clamp(Math.round((w * GRID_COLUMNS) / LEGACY_COLUMNS), MIN_OBJECT, GRID_COLUMNS);
    const x64 = clamp(Math.round((x * GRID_COLUMNS) / LEGACY_COLUMNS), 0, GRID_COLUMNS - w64);
    const h64 = clamp(Math.round(h * 2), MIN_OBJECT, GRID_ROWS);
    const y64 = clamp(Math.round(y * 2), 0, GRID_ROWS - h64);
    return { x: x64, y: y64, w: w64, h: h64 };
  }
  return { x: x * 2, y: y * 2, w: w * 2, h: h * 2 };
}

/** Force even parity (widgets live on the 2-fine-unit grid) with a 2 min. */
function toEvenRect(r) {
  const w = Math.max(MIN_OBJECT, r.w - (r.w % 2));
  const h = Math.max(MIN_OBJECT, r.h - (r.h % 2));
  const x = r.x - (r.x % 2);
  const y = r.y - (r.y % 2);
  return {
    x: clamp(x, 0, GRID_COLUMNS - w),
    y: clamp(y, 0, GRID_ROWS - h),
    w,
    h,
  };
}

/**
 * Warnings produced while migrating `raw` (pure helper so the migration itself
 * stays side-effect free). Returns an array of human-readable strings.
 */
export function migrationWarnings(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1;
  if (version >= LAYOUT_VERSION) return [];
  const warnings = [];
  let stripped = false;
  const pages = Array.isArray(raw.pages) && raw.pages.length ? raw.pages : [{ items: raw.items }];
  for (const page of pages) {
    for (const item of Array.isArray(page?.items) ? page.items : []) {
      if (!item || String(item.type || '') !== 'group') continue;
      const cfg = item.config && typeof item.config === 'object' ? item.config : {};
      if ('zoom' in cfg || 'tileInset' in cfg) stripped = true;
      const z = Number(cfg.zoom);
      if (Number.isFinite(z) && z !== 1) {
        const title = typeof cfg.title === 'string' && cfg.title.trim() ? cfg.title : item.id || 'group';
        warnings.push(`[layout] v5 migration: zoom dropped on group "${title}" (was ${z})`);
      }
    }
  }
  if (stripped) warnings.push('[layout] v5 migration: stripped residual zoom/tileInset key(s)');
  return warnings;
}

// ---------------------------------------------------------------------------
// LayoutService
// ---------------------------------------------------------------------------

export class LayoutService {
  constructor(store) {
    this.store = store;
    const loaded = this._load(); // never throws: every failure mode degrades to one empty page
    this.pages = loaded.pages; // [{ id, name, objects, groups }]
    this.activePageId = loaded.activePageId; // invariant: always an existing page's id
  }

  _load() {
    const data = this.store.read('layout', null);
    if (data === null) {
      // Missing file OR corrupt JSON (Store.read() cannot tell them apart).
      if (existsSync(this._file())) {
        console.error(
          '[layout] layout.json is corrupt — starting from a single empty "Home" page. ' +
            'The file is NOT rewritten automatically; it will be migrated (v5) on your first layout change.'
        );
      }
      return { pages: [this._emptyPage(DEFAULT_PAGE_NAME)], activePageId: null };
    }
    // Migration (pure, idempotent) is applied IN MEMORY; warnings are logged
    // here (migrationWarnings mirrors what migrateLayoutV5 strips).
    for (const line of migrationWarnings(data)) console.warn(line);
    const migrated = migrateLayoutV5(data);
    const pages = coercePages(migrated.pages, this);
    const activePageId =
      typeof migrated.activePageId === 'string' && pages.some((p) => p.id === migrated.activePageId)
        ? migrated.activePageId
        : pages[0].id;
    return { pages, activePageId };
  }

  _emptyPage(name) {
    return { id: randomUUID(), name, objects: [], groups: [] };
  }

  _file() {
    return path.join(this.store.dataDir, 'layout.json');
  }

  /**
   * Canonical layout header — every layout response carries it. There is no
   * retro-compatible `meta()` any more: the whole app speaks v5.
   */
  canonical() {
    return { version: LAYOUT_VERSION, columns: GRID_COLUMNS, rows: GRID_ROWS };
  }

  /**
   * Every element/report object referencing `elementId`, with its page. Used by
   * the catalogue routes (usage endpoint + guarded delete).
   */
  findElementUsages(elementId) {
    const usages = [];
    for (const page of this.pages) {
      for (const object of page.objects) {
        if (!object || (object.kind !== 'element' && object.kind !== 'report')) continue;
        if (object.elementId === elementId) {
          usages.push({ pageId: page.id, name: page.name, objectId: object.id });
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

  /** Tab-strip payload: pages without their objects (counts only). */
  pagesSummary() {
    return this.pages.map(({ id, name, objects, groups }) => ({
      id,
      name,
      objectCount: objects.length,
      groupCount: groups.length,
    }));
  }

  /** Objects of a page — defaults to the ACTIVE page. */
  listObjects(pageId) {
    const page = this.page(pageId === undefined ? this.activePageId : pageId);
    return page ? page.objects : [];
  }

  /** Groups (boxes) of a page — defaults to the ACTIVE page. */
  listGroups(pageId) {
    const page = this.page(pageId === undefined ? this.activePageId : pageId);
    return page ? page.groups : [];
  }

  // ---- Object mutations (target the ACTIVE page, except id-based lookups) ----

  /** Replace the objects of the active page (or `pageId`'s page). */
  replaceObjects(objects, pageId) {
    const page = this.page(pageId) ?? this.activePage();
    page.objects = Array.isArray(objects) ? objects : [];
    this._persist();
    return page.objects;
  }

  addObject(object) {
    this.activePage().objects.push(object);
    this._persist();
    return object;
  }

  addGroup(group) {
    this.activePage().groups.push(group);
    this._persist();
    return group;
  }

  /** Config/geometry updates look the id up across ALL pages (ids are global). */
  updateObject(id, patch) {
    for (const page of this.pages) {
      const entry = page.objects.find((o) => o.id === id);
      if (!entry) continue;
      if (patch && typeof patch === 'object') {
        if (patch.config && typeof patch.config === 'object') {
          entry.config = { ...(entry.config || {}), ...patch.config };
        }
        for (const k of ['x', 'y', 'w', 'h']) {
          if (patch[k] !== undefined) entry[k] = patch[k];
        }
      }
      this._persist();
      return entry;
    }
    return null;
  }

  /** Update a group's config and/or rect (id looked up across all pages). */
  updateGroup(id, patch) {
    for (const page of this.pages) {
      const entry = page.groups.find((g) => g.id === id);
      if (!entry) continue;
      if (patch && typeof patch === 'object') {
        if (patch.config && typeof patch.config === 'object') {
          entry.config = normalizeGroupConfig({ ...(entry.config || {}), ...patch.config });
        }
        for (const k of ['x', 'y', 'w', 'h']) {
          if (patch[k] !== undefined) entry[k] = patch[k];
        }
      }
      this._persist();
      return entry;
    }
    return null;
  }

  removeObject(id) {
    for (const page of this.pages) {
      const before = page.objects.length;
      page.objects = page.objects.filter((o) => o.id !== id);
      if (page.objects.length !== before) {
        this._persist();
        return true;
      }
    }
    return false;
  }

  /**
   * Remove a group. `withObjects` also deletes every object ENTIRELY contained
   * in the group (strict containment); false/default just dissolves the box.
   */
  removeGroup(id, withObjects = false) {
    for (const page of this.pages) {
      const index = page.groups.findIndex((g) => g.id === id);
      if (index === -1) continue;
      const [group] = page.groups.splice(index, 1);
      let removedObjects = 0;
      if (withObjects) {
        const before = page.objects.length;
        page.objects = page.objects.filter((o) => !contains(group, o));
        removedObjects = before - page.objects.length;
      }
      this._persist();
      return { ok: true, removedObjects };
    }
    return { ok: false };
  }

  // ---- Page CRUD ------------------------------------------------------------

  createPage(rawName) {
    const name = rawName === undefined || rawName === null ? this._defaultPageName() : rawName;
    const page = this._emptyPage(name);
    this.pages.push(page);
    this._persist();
    return { id: page.id, name: page.name };
  }

  renamePage(id, name) {
    const page = this.page(id);
    if (!page) return null;
    page.name = name;
    this._persist();
    return { id: page.id, name: page.name, objectCount: page.objects.length, groupCount: page.groups.length };
  }

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
    // Single atomic write keeps the invariant (activePageId ↔ pages). The Store
    // copies the previous file to `<file>.bak` before overwriting (v4 backup).
    this.store.write(
      'layout',
      {
        version: LAYOUT_VERSION,
        columns: GRID_COLUMNS,
        rows: GRID_ROWS,
        activePageId: this.activePageId,
        pages: this.pages.map((p) => ({ id: p.id, name: p.name, objects: p.objects, groups: p.groups })),
      },
      500
    );
  }
}

// ---------------------------------------------------------------------------
// Tolerant load coercion (never throws, never drops user data except element/
// report objects with no elementId).
// ---------------------------------------------------------------------------

function coercePages(rawPages, service) {
  if (!Array.isArray(rawPages)) return [service._emptyPage(DEFAULT_PAGE_NAME)];
  const pages = rawPages
    .filter((p) => p && typeof p === 'object')
    .map((p, i) => ({
      id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
      name:
        typeof p.name === 'string' && p.name.trim()
          ? p.name
          : i === 0
            ? DEFAULT_PAGE_NAME
            : `Page ${i + 1}`,
      objects: coerceObjects(p.objects),
      groups: coerceGroups(p.groups),
    }));
  if (!pages.length) return [service._emptyPage(DEFAULT_PAGE_NAME)];
  const seen = new Set();
  for (const p of pages) {
    if (seen.has(p.id)) p.id = randomUUID();
    seen.add(p.id);
  }
  return pages;
}

/** Tolerant object coercion on LOAD: unknown kind/type skipped, bad geometry clamped. */
export function coerceObjects(raw) {
  if (!Array.isArray(raw)) return [];
  const unknown = new Set();
  let missingId = 0;
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const kind = String(o.kind || '');
    if (!OBJECT_KINDS.has(kind)) {
      unknown.add(kind || 'undefined');
      continue;
    }
    if (kind === 'widget') {
      const type = String(o.type || '');
      if (!KNOWN_WIDGET_TYPES.has(type)) {
        unknown.add(type);
        continue;
      }
    } else {
      const elementId = typeof o.elementId === 'string' ? o.elementId : '';
      if (!elementId) {
        missingId += 1;
        continue;
      }
    }
    let id = typeof o.id === 'string' && o.id ? o.id : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    out.push(coerceObject(o, id));
  }
  if (unknown.size) {
    console.warn(`[layout] ignoring unknown object kind/type on load: ${[...unknown].join(', ')}`);
  }
  if (missingId) {
    console.warn(`[layout] dropped ${missingId} element/report object(s) with no elementId on load`);
  }
  return out;
}

function coerceObject(o, id) {
  const kind = String(o.kind);
  const x = clamp(intOr(o.x, 0), 0, GRID_COLUMNS);
  const y = clamp(intOr(o.y, 0), 0, GRID_ROWS);
  const maxW = kind === 'element' ? MAX_ELEMENT_SIZE : GRID_COLUMNS;
  let w = clamp(intOr(o.w, MIN_OBJECT), MIN_OBJECT, maxW);
  let h = clamp(intOr(o.h, MIN_OBJECT), MIN_OBJECT, GRID_ROWS);
  w = Math.min(w, GRID_COLUMNS - Math.min(x, GRID_COLUMNS - MIN_OBJECT));
  h = Math.min(h, GRID_ROWS - Math.min(y, GRID_ROWS - MIN_OBJECT));
  w = Math.max(MIN_OBJECT, w);
  h = Math.max(MIN_OBJECT, h);
  if (kind === 'widget') {
    return { id, kind, type: String(o.type), x, y, w, h, config: plainObject(o.config) };
  }
  if (kind === 'element') {
    return { id, kind, elementId: String(o.elementId), x, y, w, h, options: normOptions(o.options) };
  }
  return { id, kind, elementId: String(o.elementId), x, y, w, h };
}

/** Tolerant group coercion on LOAD: ≥4×4 enforced, strip keys removed, overlap warned. */
export function coerceGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  let stripped = false;
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    if ('zoom' in (g.config || {}) || 'tileInset' in (g.config || {})) stripped = true;
    let id = typeof g.id === 'string' && g.id ? g.id : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    const x = clamp(intOr(g.x, 0), 0, GRID_COLUMNS - MIN_GROUP);
    const y = clamp(intOr(g.y, 0), 0, GRID_ROWS - MIN_GROUP);
    const w = clamp(intOr(g.w, MIN_GROUP), MIN_GROUP, GRID_COLUMNS - x);
    const h = clamp(intOr(g.h, MIN_GROUP), MIN_GROUP, GRID_ROWS - y);
    out.push({ id, x, y, w, h, config: normalizeGroupConfig(g.config) });
  }
  if (stripped) console.warn('[layout] stripped residual zoom/tileInset key(s) on load');
  warnOverlaps(out);
  return out;
}

/** Warn (never reject) about overlapping group boxes — resolved client-side later. */
function warnOverlaps(groups) {
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i];
      const b = groups[j];
      if (!(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)) {
        console.warn(`[layout] groups ${a.id} and ${b.id} overlap (tolerated)`);
      }
    }
  }
}

/**
 * Pure containment test (strict): an object is "entirely contained" in a group
 * box when its whole rectangle fits inside. Used by `DELETE /groups/:id?withObjects=1`.
 */
export function contains(group, object) {
  if (!group || !object) return false;
  return (
    object.x >= group.x &&
    object.y >= group.y &&
    object.x + object.w <= group.x + group.w &&
    object.y + object.h <= group.y + group.h
  );
}

// ---------------------------------------------------------------------------
// Config/option normalization
// ---------------------------------------------------------------------------

/**
 * Group config normalization on load/write: `titleVisibility` is coerced to
 * always|hover|never (unknown → always) and the obsolete `zoom`/`tileInset`
 * keys are STRIPPED. Every other key (title + the appearance family
 * bgColor/bgOpacity/borderColor/borderOpacity/showBorder/textColor) passes
 * through untouched (tolerance: never drops user data).
 */
export function normalizeGroupConfig(config) {
  const c = plainObject(config);
  const out = { ...c };
  for (const key of STRIP_KEYS) delete out[key];
  out.titleVisibility = normalizeTitleVisibility(c.titleVisibility);
  return out;
}

function stripGroupConfig(config) {
  return normalizeGroupConfig(config);
}

/** Drop residual per-tile option keys that the catalogue now owns. */
function stripOptions(options) {
  const o = plainObject(options);
  const out = { ...o };
  // `iconColor` moved to the ELEMENT catalogue in v4; `surfaceInset` is a
  // group-level setting superseded by the group trame. Both are dropped.
  delete out.iconColor;
  delete out.surfaceInset;
  return out;
}

// Button icon size — mirror of layout.routes.js / elements/button.js.
const ICON_SIZE_MIN = 8;
const ICON_SIZE_MAX = 120;
const ICON_SIZE_DEFAULT = 55;
const ICON_SIZE_STEP = 0.5;
const ICON_SIZE_PRESETS = { S: 40, M: 55, L: 70, XL: 85, Fill: 100 };
// `overlay` = the label is centred ON TOP of the icon (translucent pill) instead
// of taking its own slot beside it. Mirrors layout.routes.js / elements/button.js.
const LABEL_POSITIONS = new Set(['bottom', 'top', 'left', 'right', 'overlay']);
const SURFACE_OPACITY_MIN = 0;
const SURFACE_OPACITY_MAX = 100;
const SURFACE_OPACITY_DEFAULT = 100;
const SURFACE_INSET_MIN = 0;
const SURFACE_INSET_MAX = 8;
const SURFACE_INSET_DEFAULT = 0;
const SURFACE_SHAPES = new Set(['rounded', 'square']);
const SURFACE_SHAPE_DEFAULT = 'rounded';
const SURFACE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([0-9a-zA-Z.,%\s/]+\)|[a-zA-Z]{3,20})$/;

/** Tolerant option coercion on LOAD: unknown/missing keys are defaulted. */
function normOptions(raw) {
  const o = plainObject(raw);
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

function normSurfaceOpacity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SURFACE_OPACITY_DEFAULT;
  return Math.min(SURFACE_OPACITY_MAX, Math.max(SURFACE_OPACITY_MIN, Math.round(n)));
}

function normSurfaceInset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SURFACE_INSET_DEFAULT;
  return Math.min(SURFACE_INSET_MAX, Math.max(SURFACE_INSET_MIN, Math.round(n)));
}

function normSurfaceColor(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 64) return '';
  return SURFACE_COLOR_RE.test(s) ? s : '';
}

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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function intOr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
