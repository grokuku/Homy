import { api } from '../api.js';
import { toast } from '../ui/toast.js';

/**
 * Docky front-end client (LOT 5).
 *
 * TWO responsibilities, kept together so the tile layer has a single import:
 *
 *  1. `dockyApi` — thin wrappers around the JWT-protected Homy proxy
 *     (`/api/docky/*`). The browser NEVER talks to Docky directly and never
 *     sees the integration key.
 *
 *  2. `dockyPoller` — a page-level BATCH refresh loop shared by every live
 *     tile. Tiles register the `{ agent, container }` they need; the poller
 *     collects the UNIQUE targets of the page and issues ONE health batch +
 *     ONE stats batch per cycle (~30 s), then fans the results back out. This
 *     is what keeps N monitoring tiles from firing N requests at Docky.
 *
 * LIFECYCLE / NO LEAK:
 *   - `registerTarget()` returns an unregister fn; every tile wires it into its
 *     `dispose` (see elements/button.js → group.js → disposeWidget).
 *   - the loop is PAUSED while the tab is hidden (`visibilitychange`) and
 *     resumes with an immediate refresh when it becomes visible again;
 *   - when the last target unregisters, the interval is cleared.
 */

// ---- Proxy API -------------------------------------------------------------

export const dockyApi = {
  status(force = false) {
    return api.get(`/api/docky/status${force ? '?force=1' : ''}`);
  },
  config() {
    return api.get('/api/docky/config');
  },
  saveConfig(body) {
    return api.put('/api/docky/config', body);
  },
  agents() {
    return api.get('/api/docky/agents');
  },
  containers(agent) {
    return api.get(`/api/docky/containers?agent=${encodeURIComponent(agent)}`);
  },
  action(agent, container, action) {
    return api.post('/api/docky/actions', { agent, container, action });
  },
};

// ---- Batch poller ----------------------------------------------------------

export const REFRESH_MS = 30_000;

/** Global failure codes that mean « Docky (or its config) is not usable ». */
const GLOBAL_DEGRADED = new Set([
  'unreachable',
  'timeout',
  'not_configured',
  'no_agents',
  'agent_offline',
  'unauthorized',
  'forbidden',
  'error',
]);

function keyOf(target) {
  if (!target || !target.agent || !target.container) return '';
  return `${target.agent}\u0000${target.container}`;
}

const listeners = new Map(); // key -> Set<fn>
const targets = new Map(); // key -> { agent, container }
const lastByKey = new Map(); // key -> merged data (immediate replay to new listeners)

let timer = 0;
let soonTimer = 0;
let refreshing = false;
let dockyOffline = false; // last known global state (toast edge detection)
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

function deliver(key, data) {
  lastByKey.set(key, data);
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (err) {
      console.warn('[docky] listener failed:', err);
    }
  }
}

/** Merge the health + stats ordered results back onto the registered targets. */
function fanOut(health, stats) {
  const keys = [...targets.keys()];
  const hmap = new Map();
  const smap = new Map();
  if (Array.isArray(health?.results)) {
    health.results.forEach((r, i) => {
      const t = targets.get(keys[i]);
      if (t) hmap.set(keys[i], r);
    });
  }
  if (Array.isArray(stats?.results)) {
    stats.results.forEach((r, i) => {
      const t = targets.get(keys[i]);
      if (t) smap.set(keys[i], r);
    });
  }
  const offline =
    GLOBAL_DEGRADED.has(health?.error) ||
    GLOBAL_DEGRADED.has(stats?.error) ||
    (Array.isArray(health?.results) &&
      health.results.length > 0 &&
      health.results.every((r) => r?.error && GLOBAL_DEGRADED.has(r.error.code)));
  for (const key of keys) {
    deliver(key, {
      health: hmap.get(key) || null,
      stats: smap.get(key) || null,
      degraded: offline,
    });
  }
  setOffline(offline);
}

function setOffline(offline) {
  if (offline === dockyOffline) return;
  dockyOffline = offline;
  if (offline) toast('Docky offline — tiles are degraded', 'warning');
  else toast('Docky back online', 'success');
}

async function refresh() {
  if (refreshing) return;
  const list = [...targets.values()];
  if (list.length === 0) return;
  refreshing = true;
  try {
    const [health, stats] = await Promise.all([
      api.post('/api/docky/health', { targets: list }),
      api.post('/api/docky/stats', { targets: list }),
    ]);
    fanOut(health, stats);
  } catch (err) {
    // The Homy route itself failed (network, 5xx…): degrade every registered
    // tile without throwing into the widget layer.
    for (const key of targets.keys()) {
      deliver(key, { health: null, stats: null, degraded: true });
    }
    setOffline(true);
    console.warn('[docky] batch refresh failed:', err?.message || err);
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
  timer = setInterval(refresh, REFRESH_MS);
}

function pause() {
  if (timer) clearInterval(timer);
  timer = 0;
}

export const dockyPoller = {
  /**
   * Subscribe to a target's live `{ health, stats, degraded }`. Returns an
   * unregister fn (idempotent). Safe with an incomplete/empty target: it then
   * returns a no-op unsubscribe and issues NO request.
   */
  register(target, listener) {
    const key = keyOf(target);
    if (!key || typeof listener !== 'function') return () => {};
    targets.set(key, { agent: String(target.agent), container: String(target.container) });
    let set = listeners.get(key);
    if (!set) {
      set = new Set();
      listeners.set(key, set);
    }
    set.add(listener);
    const cached = lastByKey.get(key);
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
          targets.delete(key);
          lastByKey.delete(key);
        }
      }
      if (targets.size === 0) pause();
    };
  },

  /** Force an immediate cycle (e.g. right after a container action). */
  refreshNow() {
    scheduleSoon();
  },

  /** Drop every registration + cache (logout / instance switch). */
  clear() {
    listeners.clear();
    targets.clear();
    lastByKey.clear();
    pause();
    if (soonTimer) {
      clearTimeout(soonTimer);
      soonTimer = 0;
    }
    dockyOffline = false;
  },
};
