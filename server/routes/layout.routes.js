import { Hono } from 'hono';
import { LayoutService } from '../services/layout.service.js';
import { WIDGET_MANIFEST_FINAL } from './widgets.routes.js';

const MAX_ITEMS = 100;
const MAX_BODY_BYTES = 256 * 1024; // 256 KB
const VALID_TYPES = new Set(WIDGET_MANIFEST_FINAL.map((w) => w.type));

export function layoutRoutes(store) {
  const layout = new LayoutService(store);
  const routes = new Hono();

  // Get full layout
  routes.get('/', (c) => c.json({ items: layout.list() }));

  // Replace full layout (from gridstack serialization)
  routes.put('/', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const rawItems = Array.isArray(parsed.body.items) ? parsed.body.items : [];
    if (rawItems.length > MAX_ITEMS) {
      return c.json({ error: `Too many items (max ${MAX_ITEMS})` }, 400);
    }
    const clean = [];
    for (const item of rawItems) {
      const error = validateType(item);
      if (error) return c.json({ error }, 400);
      clean.push(sanitizeItem(item));
    }
    layout.replace(clean);
    return c.json({ items: clean });
  });

  // Add a single item
  routes.post('/items', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (layout.list().length >= MAX_ITEMS) {
      return c.json({ error: `Too many items (max ${MAX_ITEMS})` }, 400);
    }
    const error = validateType(parsed.body);
    if (error) return c.json({ error }, 400);
    const entry = layout.add(sanitizeItem(parsed.body) || {});
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

/** Validate/normalize a grid item. Returns null if invalid. */
function sanitizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = String(item.type || 'frame');
  const id = String(item.id || '');
  return {
    id: id || undefined,
    x: clampInt(item.x, 0, 0),
    y: clampInt(item.y, 0, 0),
    w: clampInt(item.w, 1, 1),
    h: clampInt(item.h, 1, 1),
    type,
    config: item.config && typeof item.config === 'object' ? item.config : {},
  };
}

function clampInt(v, min, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}
