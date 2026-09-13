import { Hono } from 'hono';
import { ElementsService } from '../services/elements.service.js';
import {
  API_KEY_SENTINEL,
  fetchReport,
  publicReportTypes,
} from '../services/reports.service.js';

const MAX_BODY_BYTES = 256 * 1024; // 256 KB (same contract as the other routes)

/**
 * Report routes (LOT 8) — JWT-protected via the global /api/* guard.
 *
 *   GET  /api/reports/types           → { types: [{ id, label, declared, implemented, fields }] }
 *   GET  /api/reports/:elementId      → normalized report data for the element
 *                                       (404 unknown element / element without a report;
 *                                        200 + degraded `status` when the service is down)
 *   POST /api/reports/:elementId/test → connection test on the STORED config
 *   POST /api/reports/test            → connection test on credentials from the form
 *                                       ({ type, baseUrl, apiKey, elementId? })
 *
 * SECRETS: the element's `apiKey` is read here (server-side) but never echoed —
 * the response carries only the normalized report payload. A form testing an
 * EXISTING element sends the {@link API_KEY_SENTINEL} placeholder and the stored
 * key is resolved here.
 */
export function reportsRoutes(storeOrService, options = {}) {
  const elements =
    storeOrService instanceof ElementsService ? storeOrService : new ElementsService(storeOrService);
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : undefined;
  const routes = new Hono();

  routes.get('/types', (c) => c.json({ types: publicReportTypes() }));

  // Form-driven connection test (no element yet, or testing unsaved values).
  routes.post('/test', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    return testConnection(c, elements, parsed.body, timeoutMs);
  });

  routes.get('/:elementId', async (c) => {
    const element = elements.get(c.req.param('elementId'));
    if (!element) return c.json({ error: 'Not found' }, 404);
    if (!element.report) return c.json({ error: 'This element has no report configured' }, 404);
    const data = await fetchReport(element.report.type, element.report, { timeoutMs });
    return c.json({
      elementId: element.id,
      type: element.report.type,
      fetchedAt: new Date().toISOString(),
      ...data,
    });
  });

  routes.post('/:elementId/test', async (c) => {
    const element = elements.get(c.req.param('elementId'));
    if (!element) return c.json({ error: 'Not found' }, 404);
    if (!element.report) return c.json({ error: 'This element has no report configured' }, 404);
    const data = await fetchReport(element.report.type, element.report, { timeoutMs });
    return c.json({ elementId: element.id, type: element.report.type, ...data });
  });

  return routes;
}

/** Run a provider against either the form credentials or the stored config. */
async function testConnection(c, elements, body, timeoutMs) {
  const type = typeof body?.type === 'string' ? body.type.trim() : '';
  if (!type) return c.json({ error: 'type is required' }, 400);

  let baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
  let apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';

  // The form never receives the stored key: a « keep » sentinel resolves the
  // key of the element being edited, server-side.
  if (apiKey === API_KEY_SENTINEL) {
    const element = body?.elementId ? elements.get(String(body.elementId)) : null;
    if (!element?.report || typeof element.report.apiKey !== 'string') {
      return c.json({ error: 'Stored API key not found' }, 400);
    }
    baseUrl = baseUrl || element.report.baseUrl;
    apiKey = element.report.apiKey;
  }

  const data = await fetchReport(type, { baseUrl, apiKey }, { timeoutMs });
  return c.json({
    type,
    ok: data.status === 'ok',
    status: data.status,
    error: data.error,
    server: data.server,
    sessionCount: Array.isArray(data.sessions) ? data.sessions.length : 0,
  });
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
