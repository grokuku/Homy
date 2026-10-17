import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  GRID_COLUMNS,
  GRID_ROWS,
  KNOWN_WIDGET_TYPES,
  LayoutService,
  MAX_ELEMENT_SIZE,
  MAX_GROUPS_PER_PAGE,
  MAX_OBJECTS_PER_PAGE,
  MAX_PAGES,
  MIN_GROUP,
  MIN_OBJECT,
  OBJECT_KINDS,
  PAGE_NAME_MAX,
  contains,
  normalizeGroupConfig,
} from '../services/layout.service.js';
import { WIDGET_MANIFEST_FINAL } from './widgets.routes.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB
const ELEMENT_ID_MAX = 128;
const PAGE_NAME_MAX_LOCAL = PAGE_NAME_MAX;

// Button icon size (per-element display option) — mirror of the front
// (elements/button.js) and of layout.service.js.
const ICON_SIZE_MIN = 8;
const ICON_SIZE_MAX = 120;
const ICON_SIZE_DEFAULT = 55;
const ICON_SIZE_STEP = 0.5;
const ICON_SIZE_PRESETS = { S: 40, M: 55, L: 70, XL: 85, Fill: 100 };
const LABEL_POSITIONS = new Set(['bottom', 'top', 'left', 'right']);
const SURFACE_OPACITY_MIN = 0;
const SURFACE_OPACITY_MAX = 100;
const SURFACE_OPACITY_DEFAULT = 100;
const SURFACE_INSET_MIN = 0;
const SURFACE_INSET_MAX = 8;
const SURFACE_INSET_DEFAULT = 0;
const SURFACE_SHAPES = new Set(['rounded', 'square']);
const SURFACE_SHAPE_DEFAULT = 'rounded';
const SURFACE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([0-9a-zA-Z.,%\s/]+\)|[a-zA-Z]{3,20})$/;

export function layoutRoutes(storeOrService, options = {}) {
  const layout =
    storeOrService instanceof LayoutService ? storeOrService : new LayoutService(storeOrService);
  const elementExists = typeof options.elementExists === 'function' ? options.elementExists : null;
  const routes = new Hono();

  // ---- Full layout (canonical v5) ------------------------------------------
  // GET /api/layout → { version:5, columns:64, rows:36, activePageId, pages,
  //                     objects (active page), groups (active page) }
  routes.get('/', (c) => c.json(fullLayout(layout)));

  // Replace the objects of the ACTIVE page (or an explicit `pageId`). The body
  // may carry `objects` (v5) or a legacy `items` key — tolerated, never a 400.
  routes.put('/', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    let targetId;
    if (parsed.body.pageId !== undefined) {
      targetId = layout.page(String(parsed.body.pageId))?.id;
      if (!targetId) return c.json({ error: 'Not found' }, 404);
    }
    const raw = Array.isArray(parsed.body.objects)
      ? parsed.body.objects
      : Array.isArray(parsed.body.items)
        ? parsed.body.items
        : [];
    if (raw.length > MAX_OBJECTS_PER_PAGE) {
      return c.json({ error: `Too many objects (max ${MAX_OBJECTS_PER_PAGE} per page)` }, 400);
    }
    const clean = [];
    const unknown = new Set();
    const seen = new Set();
    for (const item of raw) {
      const { error, object } = sanitizeObject(item, { defaults: false });
      if (error) {
        if (error === 'unknown-kind') {
          unknown.add(String(item?.kind ?? item?.type ?? 'undefined'));
          continue;
        }
        return c.json({ error }, 400);
      }
      if (seen.has(object.id)) {
        object.id = randomUUID();
        console.warn('[layout] regenerated a duplicate object id on PUT');
      }
      seen.add(object.id);
      clean.push(object);
    }
    if (unknown.size) console.warn(`[layout] ignoring unknown object kind(s) on PUT: ${[...unknown].join(', ')}`);
    warnUnknownElements(clean, elementExists);
    const objects = layout.replaceObjects(clean, targetId);
    return c.json({ objects, ...layout.canonical(), activePageId: layout.activePageId, pages: layout.pagesSummary() });
  });

  // ---- Objects --------------------------------------------------------------

  // Add a single object to the ACTIVE page. Missing w/h default to the widget's
  // manifest defaultSize (64-col fine values) for widgets, or the 2×2 minimum.
  routes.post('/objects', (c) => addObject(c, layout, elementExists));

  // Update an object's config and/or rect (id looked up across all pages).
  routes.patch('/objects/:id', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const patch = {};
    if (parsed.body.config !== undefined || parsed.body.options !== undefined) {
      patch.config = parsed.body.config; // widget config
    }
    const entry = layout.updateObject(c.req.param('id'), patch);
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.json(entry);
  });

  // Config-only update (kept for the existing front call sites).
  routes.patch('/objects/:id/config', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (!parsed.body.config || typeof parsed.body.config !== 'object') {
      return c.json({ error: 'config object required' }, 400);
    }
    const entry = layout.updateObject(c.req.param('id'), { config: parsed.body.config });
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.json(entry);
  });

  routes.delete('/objects/:id', (c) => {
    const ok = layout.removeObject(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  // ---- Groups (boxes) -------------------------------------------------------

  routes.post('/groups', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (layout.listGroups().length >= MAX_GROUPS_PER_PAGE) {
      return c.json({ error: `Too many groups (max ${MAX_GROUPS_PER_PAGE} per page)` }, 400);
    }
    const { error, group } = sanitizeGroup(parsed.body);
    if (error) return c.json({ error }, 400);
    return c.json(layout.addGroup(group), 201);
  });

  routes.patch('/groups/:id', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const entry = layout.updateGroup(c.req.param('id'), parsed.body || {});
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.json(entry);
  });

  // DELETE = dissolve (objects kept); DELETE ?withObjects=1 = also delete every
  // object ENTIRELY contained in the group.
  routes.delete('/groups/:id', (c) => {
    const withObjects = c.req.query('withObjects') === '1' || c.req.query('withObjects') === 'true';
    const result = layout.removeGroup(c.req.param('id'), withObjects);
    if (!result.ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true, removedObjects: result.removedObjects });
  });

  // ---- Pages (tabs) ---------------------------------------------------------

  routes.get('/pages/:id', (c) => {
    const page = layout.page(c.req.param('id'));
    if (!page) return c.json({ error: 'Not found' }, 404);
    return c.json({
      id: page.id,
      name: page.name,
      objectCount: page.objects.length,
      groupCount: page.groups.length,
      objects: page.objects,
      groups: page.groups,
      ...layout.canonical(),
    });
  });

  routes.post('/pages', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (layout.pages.length >= MAX_PAGES) {
      return c.json({ error: `Too many pages (max ${MAX_PAGES})` }, 400);
    }
    let name;
    if (parsed.body.name !== undefined) {
      name = normalizePageName(parsed.body.name);
      if (!name) return c.json({ error: `name must be 1 to ${PAGE_NAME_MAX_LOCAL} characters after trim` }, 400);
    }
    return c.json(layout.createPage(name), 201);
  });

  routes.patch('/pages/:id', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const name = normalizePageName(parsed.body.name);
    if (!name) return c.json({ error: `name must be 1 to ${PAGE_NAME_MAX_LOCAL} characters after trim` }, 400);
    const page = layout.renamePage(c.req.param('id'), name);
    if (!page) return c.json({ error: 'Not found' }, 404);
    return c.json(page);
  });

  routes.delete('/pages/:id', (c) => {
    const result = layout.deletePage(c.req.param('id'));
    if (!result.ok) {
      if (result.reason === 'not-found') return c.json({ error: 'Not found' }, 404);
      return c.json({ error: 'Cannot delete the last page' }, 400);
    }
    return c.json({ ok: true, ...fullLayout(layout), activePageId: result.activePageId });
  });

  routes.put('/active', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (parsed.body.pageId === undefined) return c.json({ error: 'pageId required' }, 400);
    const page = layout.setActive(String(parsed.body.pageId));
    if (!page) return c.json({ error: 'Not found' }, 404);
    return c.json(fullLayout(layout));
  });

  return routes;
}

/** Canonical full layout payload for the ACTIVE page. */
function fullLayout(layout) {
  return {
    ...layout.canonical(),
    activePageId: layout.activePageId,
    pages: layout.pagesSummary(),
    objects: layout.listObjects(),
    groups: layout.listGroups(),
  };
}

async function addObject(c, layout, elementExists) {
  const parsed = await parseBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  if (layout.listObjects().length >= MAX_OBJECTS_PER_PAGE) {
    return c.json({ error: `Too many objects (max ${MAX_OBJECTS_PER_PAGE} per page)` }, 400);
  }
  const { error, object } = sanitizeObject(parsed.body, { defaults: true });
  if (error) return c.json({ error: error === 'unknown-kind' ? `Unknown object type: ${parsed.body?.type ?? parsed.body?.kind}` : error }, 400);
  warnUnknownElements([object], elementExists);
  return c.json(layout.addObject(object), 201);
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

async function parseBody(c) {
  const text = await c.req.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Request body too large (max 256 KB)' };
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }
}

function normalizePageName(raw) {
  const name = String(raw ?? '').trim();
  return name && name.length <= PAGE_NAME_MAX_LOCAL ? name : null;
}

// ---------------------------------------------------------------------------
// Object/group sanitization (WRITE path)
// ---------------------------------------------------------------------------

/**
 * Validate/normalize a layout object. `defaults` (POST) fills missing w/h from
 * the widget manifest; on PUT the caller always sends explicit geometry.
 * Returns `{ object }` or `{ error }` (or `{ error:'unknown-kind' }` so PUT can
 * SKIP unknown kinds while POST rejects them).
 *
 * Documented leniency: `h` is clamped to 36 (never rejected), x/y default to 0,
 * missing w/h fall back to the 2×2 minimum, `zoom`/`tileInset` keys are STRIPPED
 * (never a 400). Rejections: negative/non-integer x/y, w outside 1..64, missing
 * `type` for a widget, missing `elementId` for element/report.
 */
export function sanitizeObject(raw, { defaults = false } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid layout object' };
  const kind = String(raw.kind || '');
  if (!OBJECT_KINDS.has(kind)) return { error: 'unknown-kind' };

  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  let x = int(raw.x);
  if (x === null) x = 0;
  if (x < 0) return { error: 'x must be an integer >= 0' };
  let y = int(raw.y);
  if (y === null) y = 0;
  if (y < 0) return { error: 'y must be an integer >= 0' };

  const id = typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();

  if (kind === 'widget') {
    const type = String(raw.type || '');
    if (!KNOWN_WIDGET_TYPES.has(type)) return { error: 'unknown-kind' };
    let w = int(raw.w);
    if (w === null) w = defaults ? defaultWidgetSize(type).w : MIN_OBJECT;
    if (w < 1 || w > GRID_COLUMNS) return { error: `w must be an integer between 1 and ${GRID_COLUMNS}` };
    w = Math.max(MIN_OBJECT, w);
    let h = int(raw.h);
    if (h === null && defaults) h = defaultWidgetSize(type).h;
    h = clampInt(h, MIN_OBJECT, GRID_ROWS);
    return { object: { id, kind, type, x, y, w: Math.min(w, GRID_COLUMNS - x), h: Math.min(h, GRID_ROWS - y), config: plainObject(raw.config) } };
  }

  // element / report — elementId required.
  const elementId = typeof raw.elementId === 'string' ? raw.elementId.trim() : '';
  if (!elementId || elementId.length > ELEMENT_ID_MAX) return { error: `${kind}.elementId is required` };

  const maxW = kind === 'element' ? MAX_ELEMENT_SIZE : GRID_COLUMNS;
  let w = int(raw.w);
  if (w === null) w = MIN_OBJECT;
  w = clampInt(w, MIN_OBJECT, maxW);
  let h = int(raw.h);
  if (h === null) h = MIN_OBJECT;
  h = clampInt(h, MIN_OBJECT, kind === 'element' ? MAX_ELEMENT_SIZE : GRID_ROWS);
  const rect = { x, y, w: Math.min(w, GRID_COLUMNS - x), h: Math.min(h, GRID_ROWS - y) };

  if (kind === 'report') {
    return { object: { id, kind, elementId, ...rect } };
  }
  return { object: { id, kind, elementId, ...rect, options: normalizeButtonOptions(raw.options) } };
}

function sanitizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid group' };
  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  let x = int(raw.x);
  if (x === null) x = 0;
  if (x < 0) return { error: 'x must be an integer >= 0' };
  let y = int(raw.y);
  if (y === null) y = 0;
  if (y < 0) return { error: 'y must be an integer >= 0' };
  const w = clampInt(int(raw.w) ?? MIN_GROUP, MIN_GROUP, GRID_COLUMNS);
  const h = clampInt(int(raw.h) ?? MIN_GROUP, MIN_GROUP, GRID_ROWS);
  const id = typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return {
    group: {
      id,
      x,
      y,
      w: Math.min(w, GRID_COLUMNS - x),
      h: Math.min(h, GRID_ROWS - y),
      config: normalizeGroupConfig(raw.config),
    },
  };
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** Manifest defaultSize for a widget type (64-col fine values). */
function defaultWidgetSize(type) {
  return WIDGET_MANIFEST_FINAL.find((w) => w.type === type)?.defaultSize ?? { w: MIN_OBJECT, h: MIN_OBJECT };
}

/**
 * TOLERANT option coercion on WRITE: unknown/missing keys fall back to defaults.
 * A residual per-tile `iconColor` is dropped (the icon colour is now an
 * element-level setting).
 */
function normalizeButtonOptions(raw) {
  const o = plainObject(raw);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  return {
    icon: bool(o.icon, true),
    label: bool(o.label, true),
    shortcut: bool(o.shortcut, true),
    health: bool(o.health, false),
    monitoring: bool(o.monitoring, false),
    controls: bool(o.controls, false),
    iconSize: normalizeButtonIconSize(o.iconSize),
    labelPosition: LABEL_POSITIONS.has(o.labelPosition) ? o.labelPosition : 'bottom',
    allowIconOverflow: bool(o.allowIconOverflow, false),
    surfaceOpacity: normalizeSurfaceOpacity(o.surfaceOpacity),
    surfaceInset: normalizeSurfaceInset(o.surfaceInset),
    surfaceShape: SURFACE_SHAPES.has(o.surfaceShape) ? o.surfaceShape : SURFACE_SHAPE_DEFAULT,
    surfaceColor: normalizeSurfaceColor(o.surfaceColor),
  };
}

function normalizeSurfaceOpacity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SURFACE_OPACITY_DEFAULT;
  return Math.min(SURFACE_OPACITY_MAX, Math.max(SURFACE_OPACITY_MIN, Math.round(n)));
}

function normalizeSurfaceInset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SURFACE_INSET_DEFAULT;
  return Math.min(SURFACE_INSET_MAX, Math.max(SURFACE_INSET_MIN, Math.round(n)));
}

function normalizeSurfaceColor(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 64) return '';
  return SURFACE_COLOR_RE.test(s) ? s : '';
}

function normalizeButtonIconSize(raw) {
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
 * Best-effort signal: log the catalog element ids referenced by element/report
 * objects but absent from the catalogue. Never blocks the write.
 */
function warnUnknownElements(objects, elementExists) {
  if (!elementExists) return;
  const unknown = new Set();
  for (const object of objects) {
    if (!object || (object.kind !== 'element' && object.kind !== 'report')) continue;
    if (object.elementId && !elementExists(object.elementId)) unknown.add(object.elementId);
  }
  if (unknown.size) {
    console.warn(`[layout] placement(s) reference unknown element id(s): ${[...unknown].join(', ')}`);
  }
}

// `contains` is imported for documentation parity (used by the service); keep a
// reference so the bundler/linter does not flag the import as dead when the
// route-level containment test lives in the service.
void contains;
