import { Hono } from 'hono';
import { THEMES, ValidationError } from '../services/settings.service.js';

/**
 * Dashboard settings (theme + background). Persisted via SettingsService
 * (atomic JSON store). Mutations are JWT-protected and pass through the
 * global Origin check (see index.js).
 */
export function settingsRoutes(settingsService) {
  const routes = new Hono();

  // Available themes (static list, consumed by the frontend toolbar).
  routes.get('/themes', (c) => c.json({ themes: THEMES }));

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