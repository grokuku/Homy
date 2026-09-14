import { api } from '../api.js';

/**
 * Custom health-check front-end client (element.healthUrl).
 *
 * Mirror of `docky.js` for the « custom URL » health source:
 *
 *  1. `healthApi` — thin wrapper around the JWT-protected Homy proxy
 *     (`POST /api/health/check`). The browser NEVER fetches the user URL
 *     itself (CORS, credentials, mixed content…): the server does the probe.
 *
 *  2. `healthUrlPoller` — a page-level BATCH refresh loop. Tiles register the
 *     URL they need; the poller collects the UNIQUE URLs of the page and issues
 *     ONE `POST /api/health/check` per cycle (~30 s), then fans the results
 *     back out. The server keeps a per-URL TTL cache, so a repeated cycle is
 *     cheap.
 *
 * LIFECYCLE / NO LEAK (same contract as `dockyPoller`):
 *   - `registerUrl()` returns an idempotent unregister fn, wired into each
 *     tile's `dispose`;
 *   - the loop is PAUSED while the tab is hidden (`visibilitychange`) and
 *     resumes with an immediate refresh when it becomes visible again;
 *   - when the last URL unregisters the interval is cleared;
 *   - `clear()` drops everything (logout / instance switch).
 */

// ---- Proxy API -------------------------------------------------------------

export const healthApi = {
  /** POST the URL list; resolves to `{ checkedAt, results: [{url, ok, …}] }`. */
  check(urls) {
    return api.post('/api/health/check', { urls });
  },
};

// ---- Batch poller ----------------------------------------------------------

export const HEALTH_REFRESH_MS = 30_000;

/**
 * Derive the normalized pill state from a server result:
 *   - 2xx/3xx                → `healthy` (green);
 *   - the host answered error → `unhealthy` (red);
 *   - transport/timeout/offline → `degraded` (amber);
 *   - no data yet            → `unknown` (grey).
 */
export function healthStateOf(result) {
  if (!result) return 'unknown';
  if (result.ok) return 'healthy';
  if (result.status !== null && result.status !== undefined) return 'unhealthy';
  return 'degraded';
}

function normalizeResult(url, result, transportFailed = false) {
  if (!result) {
    return {
      url,
      state: transportFailed ? 'degraded' : 'unknown',
      ok: false,
      status: null,
      error: transportFailed ? 'unreachable' : null,
      checkedAt: null,
    };
  }
  return {
    url,
    state: healthStateOf(result),
    ok: !!result.ok,
    status: result.status ?? null,
    error: result.error || null,
    checkedAt: result.checkedAt || null,
  };
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const listeners = new Map(); // url -> Set<fn>
const urls = new Set(); // registered urls
const lastByUrl = new Map(); // url -> normalized result (immediate replay)

let timer = 0;
let soonTimer = 0;
let refreshing = false;
let visibilityBound = false;

function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else {
      start();
      refresh();
    }
  });
}

function deliver(url, data) {
  lastByUrl.set(url, data);
  const set = listeners.get(url);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (err) {
      console.warn('[health] listener failed:', err);
    }
  }
}

async function refresh() {
  if (refreshing) return;
  const list = [...urls];
  if (list.length === 0) return;
  refreshing = true;
  try {
    const res = await healthApi.check(list);
    const arr = Array.isArray(res?.results) ? res.results : [];
    const byUrl = new Map();
    for (const r of arr) {
      if (r && typeof r.url === 'string') byUrl.set(r.url, r);
    }
    for (const url of list) deliver(url, normalizeResult(url, byUrl.get(url) || null));
  } catch (err) {
    // The Homy route itself failed (network, 5xx…): degrade every registered
    // URL without throwing into the widget layer.
    for (const url of list) deliver(url, normalizeResult(url, null, true));
    console.warn('[health] batch refresh failed:', err?.message || err);
  } finally {
    refreshing = false;
  }
}

function scheduleSoon() {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = 0;
    refresh();
  }, 60);
}

function start() {
  bindVisibility();
  if (timer || typeof document === 'undefined' || document.hidden) return;
  timer = setInterval(refresh, HEALTH_REFRESH_MS);
}

function pause() {
  if (timer) clearInterval(timer);
  timer = 0;
}

export const healthUrlPoller = {
  /**
   * Subscribe to a health URL's live `{ state, ok, status, error, checkedAt }`.
   * Returns an idempotent unregister fn. An invalid / empty URL is a no-op and
   * issues NO request.
   */
  registerUrl(url, listener) {
    const key = typeof url === 'string' ? url.trim() : '';
    if (!isValidHttpUrl(key) || typeof listener !== 'function') return () => {};
    urls.add(key);
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);
    const cached = lastByUrl.get(key);
    if (cached) {
      try {
        listener(cached);
      } catch {
        /* ignore */
      }
    }
    start();
    scheduleSoon();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const s = listeners.get(key);
      if (s) {
        s.delete(listener);
        if (s.size === 0) {
          listeners.delete(key);
          urls.delete(key);
          lastByUrl.delete(key);
        }
      }
      if (urls.size === 0) pause();
    };
  },

  /** Force an immediate cycle (e.g. right after the user edits a health URL). */
  refreshNow() {
    scheduleSoon();
  },

  /** Drop every registration + cache (logout / instance switch). */
  clear() {
    listeners.clear();
    urls.clear();
    lastByUrl.clear();
    pause();
    if (soonTimer) {
      clearTimeout(soonTimer);
      soonTimer = 0;
    }
  },
};
