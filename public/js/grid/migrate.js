/**
 * Layout migration v4 → v5 (client copy).
 *
 * ⚠️ MUST stay in sync with the server migration in
 * server/services/layout.service.js (STRIP_KEYS + migrateLayoutV5). The layout
 * is normally ALREADY migrated server-side, so this module is applied
 * DEFENSIVELY (and is a no-op on a v5 payload — idempotent).
 *
 * v5 model (see server/services/layout.service.js for the full contract):
 *   { version:5, columns:64, rows:36, activePageId,
 *     pages:[{ id, name, objects:[…], groups:[…] }] }
 * 1 fine unit = ½ global cell; the 16:9 aspect is unchanged.
 *
 * Objects: { id, kind:'widget'|'element'|'report', …geometry, config|options }
 * Groups : { id, x, y, w, h, config }  (content-less box, NO membership stored)
 */

/** Keys dropped on migration. MUST stay in sync with STRIP_KEYS (server). */
export const V4_STRIP = {
  groupConfig: ['zoom', 'tileInset'],
  objectOptions: ['surfaceInset', 'iconColor'],
};

export const LAYOUT_VERSION = 5;
export const GRID_COLUMNS = 64;
export const GRID_ROWS = 36;
export const MIN_OBJECT = 2;
export const MIN_GROUP = 4;
const LEGACY_COLUMNS = 12;

/** True when `raw` is a pre-v5 payload that needs migrating. */
export function needsMigration(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const version = Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1;
  return version < LAYOUT_VERSION;
}

/**
 * Pure, IDEMPOTENT v4→v5 migration. Returns `raw` unchanged when it is already
 * v5 (version >= 5). Ids are preserved.
 */
export function migrateLayout(raw) {
  if (!needsMigration(raw)) return raw;
  const cols = Number.isFinite(Number(raw.columns)) ? Number(raw.columns) : LEGACY_COLUMNS;
  const legacy12 = cols === LEGACY_COLUMNS;
  const rawPages = Array.isArray(raw.pages) && raw.pages.length ? raw.pages : [{ name: 'Home', items: raw.items }];
  const pages = rawPages.map((p, i) => {
    const { objects, groups } = migrateItems(Array.isArray(p?.items) ? p.items : [], legacy12);
    return {
      id: typeof p?.id === 'string' && p.id ? p.id : `page-${i}`,
      name: typeof p?.name === 'string' && p.name.trim() ? p.name : i === 0 ? 'Home' : `Page ${i + 1}`,
      objects,
      groups,
    };
  });
  const activePageId =
    typeof raw.activePageId === 'string' && pages.some((p) => p.id === raw.activePageId)
      ? raw.activePageId
      : pages[0].id;
  return { version: LAYOUT_VERSION, columns: GRID_COLUMNS, rows: GRID_ROWS, activePageId, pages };
}

function migrateItems(items, legacy12) {
  const objects = [];
  const groups = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    if (type === 'group') {
      const box = scaleV4Rect(item, legacy12);
      const gx = box.x;
      const gy = box.y;
      groups.push({
        id: typeof item.id === 'string' && item.id ? item.id : newId(),
        x: gx,
        y: gy,
        w: Math.max(MIN_GROUP, box.w),
        h: Math.max(MIN_GROUP, box.h),
        config: stripGroupConfig(item.config),
      });
      for (const b of Array.isArray(item.buttons) ? item.buttons : []) {
        if (!b || !b.elementId) continue;
        objects.push({
          id: typeof b.id === 'string' && b.id ? b.id : newId(),
          kind: 'element',
          elementId: String(b.elementId),
          x: gx + int(b.col, 0),
          y: gy + int(b.row, 0),
          w: clamp(int(b.w, 1), 1, 4),
          h: clamp(int(b.h, 1), 1, 4),
          options: stripObjectOptions(b.options),
        });
      }
      for (const rep of Array.isArray(item.reports) ? item.reports : []) {
        if (!rep || !rep.elementId) continue;
        objects.push({
          id: typeof rep.id === 'string' && rep.id ? rep.id : newId(),
          kind: 'report',
          elementId: String(rep.elementId),
          x: gx + int(rep.col, 0),
          y: gy + int(rep.row, 0),
          w: clamp(int(rep.w, MIN_OBJECT), MIN_OBJECT, GRID_COLUMNS),
          h: clamp(int(rep.h, MIN_OBJECT), MIN_OBJECT, GRID_ROWS),
        });
      }
    } else {
      const r = scaleV4Rect(item, legacy12);
      const rect = legacy12 ? toEvenRect(r) : r;
      objects.push({
        id: typeof item.id === 'string' && item.id ? item.id : newId(),
        kind: 'widget',
        type,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        config: stripObjectOptions(item.config),
      });
    }
  }
  return { objects, groups };
}

/** v4 rect → fine rect (×2, or 12→64 rescale for legacy files). */
export function scaleV4Rect(item, legacy12 = false) {
  const x = int(item.x, 0);
  const y = int(item.y, 0);
  const w = Math.max(1, int(item.w, 1));
  const h = Math.max(1, int(item.h, 1));
  if (legacy12) {
    const w64 = clamp(Math.round((w * GRID_COLUMNS) / LEGACY_COLUMNS), MIN_OBJECT, GRID_COLUMNS);
    const x64 = clamp(Math.round((x * GRID_COLUMNS) / LEGACY_COLUMNS), 0, GRID_COLUMNS - w64);
    const h64 = clamp(Math.round(h * 2), MIN_OBJECT, GRID_ROWS);
    const y64 = clamp(Math.round(y * 2), 0, GRID_ROWS - h64);
    return { x: x64, y: y64, w: w64, h: h64 };
  }
  return { x: x * 2, y: y * 2, w: w * 2, h: h * 2 };
}

/**
 * Legacy 12-column → 64-column migration (front-only convenience). Idempotent
 * via the caller's guard (`columns !== 64 && version < 5`).
 */
export function migrateLegacy12(rect) {
  return scaleV4Rect(rect, true);
}

function toEvenRect(r) {
  const w = Math.max(MIN_OBJECT, r.w - (r.w % 2));
  const h = Math.max(MIN_OBJECT, r.h - (r.h % 2));
  return {
    x: clamp(r.x - (r.x % 2), 0, GRID_COLUMNS - w),
    y: clamp(r.y - (r.y % 2), 0, GRID_ROWS - h),
    w,
    h,
  };
}

function stripGroupConfig(config) {
  const c = plain(config);
  const out = { ...c };
  for (const k of V4_STRIP.groupConfig) delete out[k];
  out.titleVisibility = ['always', 'hover', 'never'].includes(c.titleVisibility) ? c.titleVisibility : 'always';
  return out;
}

function stripObjectOptions(options) {
  const o = plain(options);
  const out = { ...o };
  for (const k of V4_STRIP.objectOptions) delete out[k];
  return out;
}

function int(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function plain(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Math.random().toString(36).slice(2)}`;
  }
}
