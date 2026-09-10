import { Hono } from 'hono';
import { isFirstRun, setup, verifyCredentials, signToken, changeCredentials } from '../services/auth.service.js';
import { rateLimit } from '../middleware/rateLimit.middleware.js';

export const authRoutes = new Hono();

// First-run status
authRoutes.get('/status', (c) => c.json({ firstRun: isFirstRun() }));

// First-run setup (only when not configured)
authRoutes.post('/setup', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  if (!user || !password) {
    return c.json({ error: 'user and password are required' }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  }
  try {
    const result = await setup(user, password);
    return c.json({ ...result, token: signToken() }, 201);
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});

// Login (rate-limited)
authRoutes.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = String(body.user || '');
  const password = String(body.password || '');
  const ok = await verifyCredentials(user, password);
  if (!ok) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  return c.json({ token: signToken(), user });
});

// Logout (stateless JWT — client discards the token)
authRoutes.post('/logout', (c) => c.json({ ok: true }));

// Current user
authRoutes.get('/me', (c) => c.json({ user: c.get('user') }));

// Change credentials (current password required)
authRoutes.put('/credentials', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const currentPassword = String(body.currentPassword || '');
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  if (!user || !password) {
    return c.json({ error: 'user and password are required' }, 400);
  }
  if (password.length < 6) {
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  }
  try {
    const result = await changeCredentials(currentPassword, user, password);
    return c.json({ ...result, token: signToken() });
  } catch (err) {
    return c.json({ error: err.message }, err.status || 500);
  }
});
