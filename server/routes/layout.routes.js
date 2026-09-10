import { Hono } from 'hono';
import { LayoutService } from '../services/layout.service.js';

export function layoutRoutes(store) {
  const layout = new LayoutService(store);
  const routes = new Hono();

  // Get full layout
  routes.get('/', (c) => c.json({ items: layout.list() }));

  // Replace full layout (from gridstack serialization)
  routes.put('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : [];
    const clean = items.map(sanitizeItem).filter(Boolean);
    layout.replace(clean);
    return c.json({ items: clean });
  });

  // Add a single item
  routes.post('/items', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const entry = layout.add(sanitizeItem(body) || {});
    return c.json(entry, 201);
  });

  // Update an item's config
  routes.patch('/items/:id/config', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const entry = layout.updateConfig(c.req.param('id'), body?.config || {});
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
