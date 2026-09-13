import { Hono } from 'hono';
import { DockyConfigError, DockyError, MAX_TARGETS } from '../services/docky.service.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB (same contract as the other routes)

/**
 * Docky integration proxy (LOT 5) — JWT-protected via the global /api/* guard.
 *
 *   GET  /api/docky/status            → { configured, reachable, baseUrl }
 *   GET  /api/docky/config            → { configured, baseUrl, hasKey, fromEnv }
 *   PUT  /api/docky/config            → same shape (URL + key write-only)
 *   GET  /api/docky/agents            → { agents: [...] }
 *   GET  /api/docky/containers?agent= → { agent, containers: [...] }
 *   POST /api/docky/health            → { checkedAt, ok, error, results: [...] }
 *   POST /api/docky/stats             → same batch shape
 *   POST /api/docky/actions           → { success, already, state, health, … }
 *
 * SECURITY: the Docky API key is read SERVER-SIDE only. `GET /status`, `GET
 * /config` and every proxy response are built from normalized payloads that
 * never carry it. The base URL is a single allow-listed value — the client can
 * never make Homy call an arbitrary host. A Docky `401` is mapped to a Homy
 * `502` (see docky.service.js) so it can never trigger the front's auth-expiry.
 */
export function dockyRoutes(docky) {
  const routes = new Hono();

  routes.get('/status', async (c) => {
    const force = c.req.query('force') === '1' || c.req.query('force') === 'true';
    const status = await docky.getStatus({ force });
    return c.json(status);
  });

  routes.get('/config', (c) => c.json(docky.publicConfig()));

  routes.put('/config', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try {
      const cfg = docky.setConfig({
        baseUrl: parsed.body.baseUrl,
        apiKey: parsed.body.apiKey,
      });
      return c.json(cfg);
    } catch (err) {
      if (err instanceof DockyConfigError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  routes.get('/agents', async (c) => {
    return run(c, () => docky.listAgents());
  });

  routes.get('/containers', async (c) => {
    const agent = c.req.query('agent') || '';
    return run(c, () => docky.listContainers(agent));
  });

  routes.post('/health', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const targets = parsed.body.targets;
    if (!Array.isArray(targets)) return c.json({ error: 'targets must be an array' }, 400);
    if (targets.length > MAX_TARGETS) {
      return c.json({ error: `Too many targets (max ${MAX_TARGETS})` }, 400);
    }
    return run(c, () => docky.healthBatch(targets));
  });

  routes.post('/stats', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const targets = parsed.body.targets;
    if (!Array.isArray(targets)) return c.json({ error: 'targets must be an array' }, 400);
    if (targets.length > MAX_TARGETS) {
      return c.json({ error: `Too many targets (max ${MAX_TARGETS})` }, 400);
    }
    return run(c, () => docky.statsBatch(targets));
  });

  routes.post('/actions', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const { agent, container, action } = parsed.body || {};
    return run(c, () => docky.action(agent, container, action));
  });

  return routes;
}

/** Run a service call and map a normalized DockyError to its HTTP status. */
async function run(c, fn) {
  try {
    const data = await fn();
    return c.json(data);
  } catch (err) {
    if (err instanceof DockyConfigError) return c.json({ error: err.message }, err.status);
    if (err instanceof DockyError) {
      const body = { error: err.message, code: err.code };
      if (err.retryAfter) {
        return c.json(body, err.status, { 'Retry-After': String(err.retryAfter) });
      }
      return c.json(body, err.status);
    }
    throw err;
  }
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
