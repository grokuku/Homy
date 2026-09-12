import { Hono } from 'hono';
import { LayoutService, MAX_COLUMNS } from '../services/layout.service.js';
import { WIDGET_MANIFEST_FINAL } from './widgets.routes.js';

const MAX_ITEMS = 100;
const MAX_BODY_BYTES = 256 * 1024; // 256 KB
const VALID_TYPES = new Set(WIDGET_MANIFEST_FINAL.map((w) => w.type));

// The grid canvas (must stay in sync with public/js/grid/config.js and with
// MAX_COLUMNS in layout.service.js): 32 columns × 18 rows.
const GRID_COLUMNS = MAX_COLUMNS;
const GRID_ROWS = 18;

export function layoutRoutes(store) {
  const layout = new LayoutService(store);
  const routes = new Hono();

  // Get full layout — items + the column count they are expressed in
  // (12 for legacy layouts, converted client-side by gridstack) + schema version.
  routes.get('/', (c) => c.json({ items: layout.list(), ...layout.meta() }));

  // Replace full layout (from gridstack serialization). `columns` (optional)
  // records the grid the coordinates are expressed in; legacy 12-column
  // coordinates are migrated client-side BEFORE this call (editor.js), so a
  // PUT with columns: 32 stores already-rescaled items.
  routes.put('/', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const rawItems = Array.isArray(parsed.body.items) ? parsed.body.items : [];
    if (rawItems.length > MAX_ITEMS) {
      return c.json({ error: `Too many items (max ${MAX_ITEMS})` }, 400);
    }
    let columns;
    if (parsed.body.columns !== undefined) {
      columns = Math.round(Number(parsed.body.columns));
      if (!Number.isFinite(columns) || columns < 1 || columns > MAX_COLUMNS) {
        return c.json({ error: `columns must be an integer between 1 and ${MAX_COLUMNS}` }, 400);
      }
    }
    const clean = [];
    for (const item of rawItems) {
      const typeError = validateType(item);
      if (typeError) return c.json({ error: typeError }, 400);
      const { error, item: cleanItem } = sanitizeItem(item);
      if (error) return c.json({ error }, 400);
      clean.push(cleanItem);
    }
    layout.replace(clean, columns);
    return c.json({ items: clean, ...layout.meta() });
  });

  // Add a single item — missing w/h default to the widget's manifest
  // defaultSize (32-col values, e.g. search = 11×1).
  routes.post('/items', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (layout.list().length >= MAX_ITEMS) {
      return c.json({ error: `Too many items (max ${MAX_ITEMS})` }, 400);
    }
    const error = validateType(parsed.body);
    if (error) return c.json({ error }, 400);
    const defaults = defaultSizeFor(parsed.body);
    const { error: sanitizeError, item } = sanitizeItem({ ...parsed.body, ...defaults });
    if (sanitizeError) return c.json({ error: sanitizeError }, 400);
    const entry = layout.add(item);
    return c.json(entry, 201);
  });

  // Update an item's config
  routes.patch('/items/:id/config', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (!parsed.body.config || typeof parsed.body.config !== 'object') {
      return c.json({ error: 'config object required' }, 400);
    }
    const entry = layout.updateConfig(c.req.param('id'), parsed.body.config);
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.json(entry);
  });

  // Delete an item
  routes.delete('/items/:id', (c) => {
    const ok = layout.remove(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  return routes;
}

/**
 * Read + size-limit + JSON-parse a request body.
 * Returns `{ ok: true, body }` on success, or `{ ok: false, status, error }`.
 */
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

function validateType(item) {
  if (!item || typeof item !== 'object') return 'Invalid layout item';
  const type = String(item.type || 'frame');
  if (!VALID_TYPES.has(type)) return `Unknown widget type: ${type}`;
  return null;
}

/** Manifest defaultSize for a type (only fills fields the caller omitted). */
function defaultSizeFor(item) {
  const def = WIDGET_MANIFEST_FINAL.find((w) => w.type === String(item?.type || 'frame'))?.defaultSize;
  const out = {};
  if (def && item?.w === undefined) out.w = def.w;
  if (def && item?.h === undefined) out.h = def.h;
  return out;
}

/**
 * Validate/normalize a grid item for the 32×18 canvas.
 * Returns `{ item }` on success or `{ error }` (HTTP 400) on rejection.
 *
 * Rejected: non-integer or negative x/y, w outside 1..32, h < 1, non-numeric
 * coordinates. Tolerated (documented leniency): missing w/h/x/y fall back to
 * the historical defaults (11×3 — the old 12-col default 4×3, rescaled —
 * at 0,0), and h is CLAMPED to 18 instead of rejected so a hand-edited legacy
 * item taller than the canvas can still be saved (a rejection here would
 * strand the whole layout: the client could never persist its edits again).
 */
function sanitizeItem(item) {
  if (!item || typeof item !== 'object') return { error: 'Invalid layout item' };
  const type = String(item.type || 'frame');
  const id = String(item.id || '');

  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  let x = int(item.x);
  if (x === null) x = 0;
  if (x < 0) return { error: 'x must be an integer >= 0' };

  let y = int(item.y);
  if (y === null) y = 0;
  if (y < 0) return { error: 'y must be an integer >= 0' };

  let w = int(item.w);
  if (w === null) w = 11;
  if (w < 1 || w > GRID_COLUMNS) {
    return { error: `w must be an integer between 1 and ${GRID_COLUMNS}` };
  }

  let h = int(item.h);
  if (h === null) h = 3;
  if (h < 1) return { error: 'h must be an integer >= 1' };

  return {
    item: {
      id: id || undefined,
      x,
      y,
      w,
      h: Math.min(h, GRID_ROWS),
      type,
      config: item.config && typeof item.config === 'object' ? item.config : {},
    },
  };
}