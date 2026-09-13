import { Hono } from 'hono';
import { IconsService, IconsValidationError, ICONS_VERSION, MAX_ICONS } from '../services/icons.service.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB (same contract as elements/layout)
const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 24;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Icon library routes (LOT 7) — JWT-protected via the global /api/* guard.
 *
 *   GET    /api/icons/search?q=…[&limit=…][&all=1]  → { icons, count, permissiveOnly }
 *                                       (400 on empty/oversized q; permissive-only
 *                                        by default, `all=1` also returns the rest)
 *   GET    /api/icons                    → { icons, count, max, version }
 *   POST   /api/icons/install {id}       → 201 entry (200 + alreadyInstalled when
 *                                          already installed; 400 bad id / non-
 *                                          permissive license / invalid SVG;
 *                                          404 unknown icon; 502/504 upstream)
 *   DELETE /api/icons/:slug              → { ok, slug } (404 unknown)
 *   GET    /api/icons/:slug/svg          → image/svg+xml (JWT required — never a
 *                                          public URL)
 *
 * The service is the ONLY component that talks to the outside world; it enforces
 * an allowlisted base URL + timeout (see icons.service.js).
 */
export function iconsRoutes(storeOrService) {
  const icons =
    storeOrService instanceof IconsService ? storeOrService : new IconsService(storeOrService);
  const routes = new Hono();

  routes.get('/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const includeAll = c.req.query('all') === '1' || c.req.query('all') === 'true';
    const limit = parseLimit(c.req.query('limit'));
    try {
      const results = await icons.search(q, { limit, includeAll });
      return c.json({
        icons: results,
        count: results.length,
        permissiveOnly: !includeAll,
      });
    } catch (err) {
      return mapError(err, c);
    }
  });

  routes.get('/', (c) =>
    c.json({ icons: icons.list(), count: icons.count(), max: MAX_ICONS, version: ICONS_VERSION })
  );

  routes.post('/install', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const id = parsed.body?.id;
    try {
      const entry = await icons.install(id);
      return c.json(entry, entry.alreadyInstalled ? 200 : 201);
    } catch (err) {
      return mapError(err, c);
    }
  });

  routes.get('/:slug/svg', (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug)) return c.json({ error: 'Invalid slug' }, 400);
    const svg = icons.readSvg(slug);
    if (svg === null) return c.json({ error: 'Not found' }, 404);
    return c.body(svg, 200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // Private: the response is JWT-gated, so shared caches must not store it.
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  routes.delete('/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug)) return c.json({ error: 'Invalid slug' }, 400);
    const removed = icons.remove(slug);
    if (!removed) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true, slug });
  });

  return routes;
}

/**
 * Map a service error to an HTTP response. Validation → 400, upstream →
 * the service-provided status (404/502/504). Anything else is re-thrown to the
 * global handler (500) — never leaked.
 */
function mapError(err, c) {
  if (err instanceof IconsValidationError) return c.json({ error: err.message }, 400);
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return c.json({ error: err.message || 'Icon service error' }, status);
  }
  throw err;
}

function parseLimit(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

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
