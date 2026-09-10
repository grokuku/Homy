import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverConfig } from './config.js';
import { authGuard } from './middleware/auth.middleware.js';
import { authRoutes } from './routes/auth.routes.js';
import { layoutRoutes } from './routes/layout.routes.js';
import { widgetRoutes } from './routes/widgets.routes.js';
import { weatherRoutes } from './routes/weather.routes.js';
import { Store } from './services/store.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = new Hono();

// ---- Public routes ---------------------------------------------------------

app.get('/api/health', (c) => c.json({ ok: true, uptime: process.uptime() }));

// ---- JWT guard for /api/* (public paths exempted) --------------------------

const PUBLIC_PATHS = [
  '/api/health',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
];
app.use('/api/*', authGuard(PUBLIC_PATHS));

// ---- Origin check on mutations ---------------------------------------------

// Reject cross-origin state-changing requests (CSRF hardening).
app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const origin = c.req.header('origin');
  if (origin) {
    const host = c.req.header('host');
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      return c.json({ error: 'Invalid origin' }, 403);
    }
    if (!originHost) {
      // scheme-less origin (e.g. "localhost:3100") — normalize
      try {
        originHost = new URL(`http://${origin}`).host;
      } catch {
        return c.json({ error: 'Invalid origin' }, 403);
      }
    }
    if (originHost !== host) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }
  }
  return next();
});

// ---- API routes ------------------------------------------------------------

const store = new Store(serverConfig.dataDir);

app.route('/api/auth', authRoutes);
app.route('/api/layout', layoutRoutes(store));
app.route('/api/widgets', widgetRoutes);
app.route('/api/weather', weatherRoutes);

// ---- Static frontend -------------------------------------------------------

app.use('*', serveStatic({ root: PUBLIC_DIR }));
app.use('*', serveStatic({ root: PUBLIC_DIR, path: 'index.html' }));

// ---- Error handler ---------------------------------------------------------

app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ error: err.message || 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ---- Bootstrap -------------------------------------------------------------

const server = serve(
  {
    fetch: app.fetch,
    port: serverConfig.port,
  },
  (info) => {
    console.log(`Homy listening on http://localhost:${info.port}`);
    console.log(`Data dir: ${serverConfig.dataDir}`);
  }
);

function shutdown() {
  console.log('\nShutting down...');
  store.flushAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
