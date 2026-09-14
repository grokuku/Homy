import { Hono } from 'hono';
import {
  HealthService,
  HealthValidationError,
  MAX_HEALTH_URLS,
  normalizeHealthUrl,
} from '../services/health.service.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB (same contract as the other routes)

/**
 * Custom health-check routes — JWT-protected via the global /api/* guard.
 *
 *   POST /api/health/check  { urls: ["https://…/health", …] }
 *        → { checkedAt, results: [{ url, ok, status, checkedAt, error }] }
 *
 * The client sends the health URLs it is rendering; the server probes them
 * (http(s) only, short timeout, per-URL TTL cache, ≤ MAX_HEALTH_URLS per
 * request). NO unvalidated URL ever reaches `fetch()`: the whole list is
 * validated BEFORE any probe, and an invalid entry (non-http scheme,
 * credentials, missing url) fails the request with HTTP 400.
 *
 * Mounted at `/api/health` alongside the public Homy ping — the JWT guard
 * exempts only the EXACT `/api/health` path, so this POST stays protected.
 */
export function healthRoutes(health = new HealthService()) {
  const routes = new Hono();

  routes.post('/check', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);

    const urls = parsed.body.urls;
    if (!Array.isArray(urls)) return c.json({ error: 'urls must be an array' }, 400);
    if (urls.length === 0) return c.json({ error: 'urls must not be empty' }, 400);
    if (urls.length > MAX_HEALTH_URLS) {
      return c.json({ error: `Too many urls (max ${MAX_HEALTH_URLS})` }, 400);
    }
    for (const raw of urls) {
      if (!normalizeHealthUrl(raw)) {
        return c.json({ error: 'Each url must be a valid http(s) URL without credentials' }, 400);
      }
    }

    try {
      const results = await health.checkBatch(urls);
      return c.json({ checkedAt: new Date().toISOString(), results });
    } catch (err) {
      if (err instanceof HealthValidationError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return routes;
}

/**
 * Read + size-limit + JSON-parse a request body (same contract as the other
 * routes: 413 beyond 256 KB, 400 on invalid JSON).
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
