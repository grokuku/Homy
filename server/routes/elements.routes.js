import { Hono } from 'hono';
import {
  ElementsService,
  ElementsValidationError,
  MAX_ELEMENTS,
} from '../services/elements.service.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB

/**
 * Global element catalogue routes (JWT-protected via the global /api/* guard).
 *
 *   GET    /api/elements            → { elements: [...], count, max }
 *   GET    /api/elements/:id        → element (404 unknown)
 *   GET    /api/elements/:id/usage  → { pages: [{ pageId, name, groupId }], count }
 *   POST   /api/elements            → 201 element (400 invalid/limit, 413 body)
 *   PATCH  /api/elements/:id        → 200 element (400 invalid, 404 unknown)
 *   DELETE /api/elements/:id        → 200 { ok, id } ; 409 { error, pages, count }
 *                                     when referenced by ≥1 group button
 *                                     (bypass with `?force=1`) ; 404 unknown
 *
 * `layout` (optional) is the SAME LayoutService instance the layout routes use,
 * so the usage scan sees the live in-memory pages without a second copy.
 */
export function elementsRoutes(storeOrService, layout = null) {
  const elements =
    storeOrService instanceof ElementsService ? storeOrService : new ElementsService(storeOrService);
  const routes = new Hono();

  routes.get('/', (c) =>
    c.json({ elements: elements.list(), count: elements.count(), max: MAX_ELEMENTS })
  );

  routes.get('/:id/usage', (c) => {
    const id = c.req.param('id');
    if (!elements.get(id)) return c.json({ error: 'Not found' }, 404);
    const pages = layout ? layout.findElementUsages(id) : [];
    return c.json({ pages, count: pages.length });
  });

  routes.get('/:id', (c) => {
    const element = elements.get(c.req.param('id'));
    if (!element) return c.json({ error: 'Not found' }, 404);
    return c.json(element);
  });

  routes.post('/', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try {
      return c.json(elements.create(parsed.body), 201);
    } catch (err) {
      if (err instanceof ElementsValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  routes.patch('/:id', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try {
      const element = elements.update(c.req.param('id'), parsed.body);
      if (!element) return c.json({ error: 'Not found' }, 404);
      return c.json(element);
    } catch (err) {
      if (err instanceof ElementsValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  routes.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!elements.get(id)) return c.json({ error: 'Not found' }, 404);
    const pages = layout ? layout.findElementUsages(id) : [];
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
    if (pages.length && !force) {
      return c.json(
        {
          error: `Element is used by ${pages.length} button(s) — pass ?force=1 to delete anyway`,
          pages,
          count: pages.length,
        },
        409
      );
    }
    elements.remove(id);
    return c.json({ ok: true, id });
  });

  return routes;
}

/**
 * Read + size-limit + JSON-parse a request body.
 * Returns `{ ok: true, body }` on success, or `{ ok: false, status, error }`.
 * (Same contract as layout.routes.js — 413 beyond 256 KB.)
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
