import { Hono } from 'hono';
import { ValidationError } from '../services/settings.service.js';

/**
 * Dashboard settings (theme + background). Persisted via SettingsService
 * (atomic JSON store). Mutations are JWT-protected and pass through the
 * global Origin check (see index.js).
 *
 * NOTE: available themes are served by GET /api/themes (see index.js). This
 * router intentionally does NOT expose /themes (it was a duplicate).
 */
export function settingsRoutes(settingsService) {
  const routes = new Hono();

  routes.get('/', (c) => c.json(settingsService.get()));

  routes.put('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const clean = settingsService.update(body);
      return c.json(clean);
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  return routes;
}