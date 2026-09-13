/**
 * Docky integration client (LOT 5).
 *
 * A THIN, server-only client for the Docky integration API v1
 * (`<base>/api/integration/v1`). Modeled after `reports.service.js`:
 *   - credentials live SERVER-SIDE only (`docky.json` via the atomic Store,
 *     overridable with the `DOCKY_URL` / `DOCKY_KEY` env vars); the API key is
 *     NEVER returned by a route nor written to a log;
 *   - every outbound call is bounded by an AbortSignal timeout (≤ 15 s stats,
 *     ≤ 20 s actions) and NEVER throws to the route layer for batch reads: a
 *     per-target error is returned instead (contract §4.4);
 *   - the base URL is a SINGLE allow-listed value — there is no way to make
 *     Homy fetch an arbitrary host (contract §3.2 / §6.4);
 *   - Docky error codes are mapped to normalized Homy codes/states (contract
 *     §5.1), and a `409 conflict` on an action is reported as an idempotent
 *     SUCCESS (the container is already in the target state);
 *   - a small in-memory TTL cache (~30 s) collapses the repeated health/stats
 *     reads of a ~30 s dashboard cycle into (at most) one upstream call.
 */

// ---- Constants -------------------------------------------------------------

export const DOCKY_VERSION_PATH = '/api/integration/v1';
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_STATS_TIMEOUT_MS = 15000;
export const DEFAULT_ACTION_TIMEOUT_MS = 20000;
export const DEFAULT_CACHE_TTL_MS = 30000;
export const NEGATIVE_CACHE_TTL_MS = 5000;

export const MAX_TARGETS = 200; // hard route cap (chunked ≤100 upstream)
export const DOCKY_BATCH_LIMIT = 100; // per-request upstream limit (contract §4.4)
export const DOCKY_AGENT_MAX = 64;
export const DOCKY_CONTAINER_MAX = 128;
export const MAX_BASE_URL = 2048;
export const MAX_API_KEY = 4096;

export const ACTIONS = ['start', 'stop', 'restart'];
export const STATES = ['running', 'exited', 'paused', 'restarting', 'created', 'dead', 'unknown'];
export const HEALTHS = ['healthy', 'unhealthy', 'starting', 'none'];

/**
 * Sentinel a client sends in place of `apiKey` to KEEP the stored key. MUST
 * stay in sync with the front-end forms (elementsModal.js pattern).
 */
export const API_KEY_SENTINEL = '__KEEP__';

/** Config/validation failure — routes map `.status` to the HTTP response. */
export class DockyConfigError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DockyConfigError';
    this.status = status;
  }
}

/** Normalized Docky failure (`.status` = the Homy HTTP status to return). */
export class DockyError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = 'DockyError';
    this.code = code;
    this.status = status;
    this.retryAfter = extra.retryAfter ?? null;
  }
}

// ---- Helpers ---------------------------------------------------------------

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPct(value) {
  const n = toNum(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

export function normalizeState(value) {
  const v = str(value).toLowerCase();
  return STATES.includes(v) ? v : 'unknown';
}

export function normalizeHealth(value) {
  const v = str(value).toLowerCase();
  if (v === 'null' || v === '') return 'none';
  return HEALTHS.includes(v) ? v : 'none';
}

function normalizeErrorObj(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { code: 'error', message: raw };
  if (typeof raw !== 'object') return null;
  const code = str(raw.code) || 'error';
  return { code, message: str(raw.message) || str(raw.error) || code };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Validate + normalize an http(s) base URL. When the user provides only a host
 * (`https://docky.example.tld`), the versioned integration prefix is appended
 * so the DEFAULT base is `<host>/api/integration/v1` (contract: dedicated,
 * versioned prefix). An already-suffixed URL is left untouched.
 * Returns '' when unusable.
 */
export function normalizeDockyBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > MAX_BASE_URL) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    // Never carry a query/hash into the stored base URL.
    url.search = '';
    url.hash = '';
    let path = url.pathname.replace(/\/+$/, '');
    if (!path) {
      path = DOCKY_VERSION_PATH;
    } else if (!path.endsWith(DOCKY_VERSION_PATH)) {
      path = `${path}${DOCKY_VERSION_PATH}`;
    }
    url.pathname = path;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Normalize a target list into `[{ agent, container }]` (never throws). */
function normalizeTargets(rawTargets) {
  const list = Array.isArray(rawTargets) ? rawTargets : [];
  return list.map((t) => ({
    agent: str(t?.agent).slice(0, DOCKY_AGENT_MAX),
    container: str(t?.container).slice(0, DOCKY_CONTAINER_MAX),
  }));
}

function targetKey(t) {
  return `${t.agent}\u0000${t.container}`;
}

// ---- Service ---------------------------------------------------------------

export class DockyService {
  /**
   * @param {import('./store.service.js').Store} store
   * @param {object} [options]
   */
  constructor(store, options = {}) {
    this.store = store;
    this.timeoutMs = timeouts(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.statsTimeoutMs = timeouts(options.statsTimeoutMs, DEFAULT_STATS_TIMEOUT_MS);
    this.actionTimeoutMs = timeouts(options.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS);
    this.cacheTtlMs = timeouts(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    // Env overrides (read once at boot; documented in .env.example).
    this.envBaseUrl = normalizeDockyBaseUrl(options.envBaseUrl || '');
    this.envApiKey = typeof options.envApiKey === 'string' ? options.envApiKey.trim() : '';
    /** @type {Map<string, {expires:number, value:object}>} */
    this._cache = new Map();
    this._statusCache = null; // { expires, value }
  }

  // ---- configuration --------------------------------------------------------

  _stored() {
    const raw = this.store.read('docky', null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { baseUrl: '', apiKey: '' };
    return {
      baseUrl: normalizeDockyBaseUrl(raw.baseUrl || ''),
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    };
  }

  /** Effective credentials = env override merged over the stored config. */
  effective() {
    const stored = this._stored();
    const baseUrl = this.envBaseUrl || stored.baseUrl;
    const apiKey = this.envApiKey || stored.apiKey;
    return { baseUrl, apiKey, envBaseUrl: !!this.envBaseUrl, envApiKey: !!this.envApiKey };
  }

  configured() {
    const { baseUrl, apiKey } = this.effective();
    return !!(baseUrl && apiKey);
  }

  /** Client-safe config view — NEVER includes the key. */
  publicConfig() {
    const { baseUrl, apiKey, envBaseUrl, envApiKey } = this.effective();
    return {
      configured: !!(baseUrl && apiKey),
      baseUrl: baseUrl || null,
      hasKey: !!apiKey,
      // Which side provided the values (the UI disables what env controls).
      fromEnv: { baseUrl: envBaseUrl, apiKey: envApiKey },
    };
  }

  /**
   * Persist URL + key. `apiKey === API_KEY_SENTINEL` keeps the stored key.
   * Empty URL/key clears that field. Throws DockyConfigError(400) on invalid.
   */
  setConfig({ baseUrl, apiKey } = {}) {
    const stored = this._stored();
    let nextBase = stored.baseUrl;
    let nextKey = stored.apiKey;

    if (baseUrl !== undefined) {
      const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
      if (!raw) nextBase = '';
      else {
        if (raw.length > MAX_BASE_URL) throw new DockyConfigError('Docky URL is too long');
        const normalized = normalizeDockyBaseUrl(raw);
        if (!normalized) throw new DockyConfigError('Docky URL must be a valid http(s) URL');
        nextBase = normalized;
      }
    }

    if (apiKey !== undefined) {
      if (apiKey === API_KEY_SENTINEL) {
        // keep stored key
      } else if (typeof apiKey !== 'string') {
        throw new DockyConfigError('Docky API key must be a string');
      } else {
        const trimmed = apiKey.trim();
        if (trimmed.length > MAX_API_KEY) throw new DockyConfigError('Docky API key is too long');
        nextKey = trimmed;
      }
    }

    this.store.write('docky', { baseUrl: nextBase, apiKey: nextKey }, 300);
    // The credentials changed: whatever was cached is now meaningless.
    this._cache.clear();
    this._statusCache = null;
    return this.publicConfig();
  }

  // ---- status ---------------------------------------------------------------

  /**
   * `{ configured, reachable, baseUrl }`. `reachable` is probed with a cheap
   * `GET /agents` (unless `force`, a ~15 s cache avoids hammering when the UI
   * polls the status). NEVER includes the key.
   */
  async getStatus({ force = false } = {}) {
    const { baseUrl, apiKey } = this.effective();
    const configured = !!(baseUrl && apiKey);
    if (!configured) {
      return { configured: false, reachable: false, baseUrl: baseUrl || null };
    }
    const now = Date.now();
    if (!force && this._statusCache && this._statusCache.expires > now) {
      return this._statusCache.value;
    }
    let reachable = false;
    try {
      await this._requestJson('GET', '/agents', undefined, { timeoutMs: this.timeoutMs });
      reachable = true;
    } catch {
      reachable = false;
    }
    const value = { configured: true, reachable, baseUrl };
    this._statusCache = { expires: now + 15000, value };
    return value;
  }

  // ---- reads ----------------------------------------------------------------

  async listAgents({ force = false } = {}) {
    const cacheKey = 'agents';
    if (!force) {
      const cached = this._cacheGet(cacheKey);
      if (cached) return cached;
    }
    const res = await this._requestJson('GET', '/agents', undefined, { timeoutMs: this.timeoutMs });
    const agents = (Array.isArray(res?.agents) ? res.agents : [])
      .map(normalizeAgent)
      .filter((a) => a.name);
    const value = { agents };
    this._cacheSet(cacheKey, value);
    return value;
  }

  async listContainers(agent) {
    const name = str(agent).slice(0, DOCKY_AGENT_MAX);
    if (!name) throw new DockyConfigError('agent is required');
    const cacheKey = `containers:${name}`;
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;
    const res = await this._requestJson('GET', `/agents/${encodeURIComponent(name)}/containers`, undefined, {
      timeoutMs: this.timeoutMs,
    });
    const containers = (Array.isArray(res?.containers) ? res.containers : [])
      .map(normalizeContainer)
      .filter((c) => c.name);
    const value = { agent: str(res?.agent) || name, containers };
    this._cacheSet(cacheKey, value);
    return value;
  }

  // ---- health (batch) -------------------------------------------------------

  /**
   * Batch state + health. NEVER throws on per-target or transport failures:
   * every target gets a result (success or `{ state:'unknown', error:{…} }`)
   * in the SAME order as the input. `ok` is false when at least one target
   * failed; `error` carries a global code when Docky itself was unreachable.
   */
  async healthBatch(rawTargets) {
    const targets = normalizeTargets(rawTargets);
    const { results, globalError } = await this._batch('/containers/health', targets, 'health', (t, raw) =>
      normalizeHealthResult(t, raw)
    );
    return {
      checkedAt: new Date().toISOString(),
      ok: !globalError && results.every((r) => !r.error),
      error: globalError,
      results,
    };
  }

  // ---- stats (batch) --------------------------------------------------------

  /**
   * Batch stats. Same order/error contract as {@link healthBatch}. A stopped
   * container is a SUCCESS with zeroed counters (contract §4.5).
   */
  async statsBatch(rawTargets) {
    const targets = normalizeTargets(rawTargets);
    const { results, globalError } = await this._batch('/containers/stats', targets, 'stats', (t, raw) =>
      normalizeStatsResult(t, raw)
    );
    return {
      checkedAt: new Date().toISOString(),
      ok: !globalError && results.every((r) => !r.error),
      error: globalError,
      results,
    };
  }

  /**
   * Generic batch driver: cache hit → reuse; miss → chunk ≤100 and POST.
   * On a global transport/HTTP failure every target of the chunk receives the
   * SAME normalized error (a negative cache keeps retries cheap).
   */
  async _batch(pathname, targets, kind, normalizeOne) {
    const results = new Array(targets.length).fill(null);
    const jobs = [];
    targets.forEach((t, index) => {
      if (!t.agent || !t.container) {
        results[index] = invalidTargetResult(t, kind);
        return;
      }
      const cached = this._cacheGet(`${kind}:${targetKey(t)}`);
      if (cached) {
        results[index] = cached;
        return;
      }
      jobs.push({ t, index });
    });

    let globalError = null;
    if (jobs.length) {
      for (const part of chunk(jobs, DOCKY_BATCH_LIMIT)) {
        try {
          const res = await this._requestJson('POST', pathname, { targets: part.map((j) => j.t) }, {
            timeoutMs: kind === 'stats' ? this.statsTimeoutMs : this.timeoutMs,
          });
          const arr = Array.isArray(res?.results) ? res.results : [];
          part.forEach((job, i) => {
            const raw = arr[i];
            const result = raw && typeof raw === 'object'
              ? normalizeOne(job.t, raw)
              : invalidTargetResult(job.t, kind, 'error', 'Missing result from Docky');
            results[job.index] = result;
            if (!result.error) this._cacheSet(`${kind}:${targetKey(job.t)}`, result);
          });
        } catch (err) {
          const code = err instanceof DockyError ? err.code : 'unreachable';
          const message = err instanceof DockyError ? err.message : 'Docky is unreachable';
          globalError = code;
          for (const job of part) {
            const result = invalidTargetResult(job.t, kind, code, message);
            results[job.index] = result;
            // Short negative cache: avoids a request storm while Docky is down.
            this._cacheSet(`${kind}:${targetKey(job.t)}`, result, NEGATIVE_CACHE_TTL_MS);
          }
        }
      }
    }

    return {
      results: results.map((r, i) => r || invalidTargetResult(targets[i], kind, 'error', 'Unavailable')),
      globalError,
    };
  }

  // ---- actions --------------------------------------------------------------

  /**
   * Run start/stop/restart. A `409 conflict` is an IDEMPOTENT SUCCESS: the
   * returned `{ success:true, already:true, state }` tells the front « already
   * in this state ». Throws DockyError for real failures.
   */
  async action(agent, container, action) {
    const a = str(agent).slice(0, DOCKY_AGENT_MAX);
    const c = str(container).slice(0, DOCKY_CONTAINER_MAX);
    const act = str(action).toLowerCase();
    if (!a || !c) throw new DockyConfigError('agent and container are required');
    if (!ACTIONS.includes(act)) throw new DockyConfigError(`Unknown action "${act}"`);

    try {
      const res = await this._requestJson(
        'POST',
        `/agents/${encodeURIComponent(a)}/containers/${encodeURIComponent(c)}/${act}`,
        {},
        { timeoutMs: this.actionTimeoutMs }
      );
      // The container state changed: drop any cached health/stats for it so the
      // next refresh reads the fresh state instead of the pre-action snapshot.
      this._invalidateTarget(a, c);
      return {
        success: res?.success !== false,
        already: false,
        agent: a,
        container: c,
        action: act,
        state: normalizeState(res?.state),
        health: normalizeHealth(res?.health),
        message: null,
      };
    } catch (err) {
      if (err instanceof DockyError && err.code === 'conflict') {
        this._invalidateTarget(a, c);
        let state = normalizeState(err.body?.state);
        let health = normalizeHealth(err.body?.health);
        if (state === 'unknown') {
          // Contract's 409 body may omit the resulting state: re-read it once.
          try {
            const hb = await this.healthBatch([{ agent: a, container: c }]);
            const first = hb.results[0];
            if (first && !first.error) {
              state = first.state;
              health = first.health;
            }
          } catch {
            /* keep unknown */
          }
        }
        return {
          success: true,
          already: true,
          agent: a,
          container: c,
          action: act,
          state,
          health,
          message: err.message || 'Container is already in this state',
        };
      }
      throw err;
    }
  }

  // ---- HTTP -----------------------------------------------------------------

  async _requestJson(method, pathname, body, { timeoutMs = this.timeoutMs } = {}) {
    const { baseUrl, apiKey } = this.effective();
    if (!baseUrl || !apiKey) throw new DockyError('not_configured', 'Docky is not configured', 503);

    let url;
    try {
      url = new URL(`${baseUrl}${pathname}`);
    } catch {
      throw new DockyError('not_configured', 'Docky base URL is invalid', 503);
    }
    // Defense in depth: the computed URL must stay under the configured base.
    if (!url.toString().startsWith(baseUrl)) {
      throw new DockyError('invalid_request', 'Refusing to call a non-configured URL', 400);
    }

    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new DockyError('timeout', 'Docky did not respond in time', 504);
      }
      throw new DockyError('unreachable', 'Docky is unreachable', 502);
    }

    const text = await res.text().catch(() => '');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      throw mapHttpError(res, parsed);
    }
    if (parsed === null && text) {
      throw new DockyError('error', 'Docky returned invalid JSON', 502);
    }
    return parsed;
  }

  // ---- cache ----------------------------------------------------------------

  _cacheGet(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this._cache.delete(key);
      return null;
    }
    return entry.value;
  }

  _cacheSet(key, value, ttl = this.cacheTtlMs) {
    this._cache.set(key, { expires: Date.now() + ttl, value });
  }

  /** Drop the cached health/stats of one target (after an action mutates it). */
  _invalidateTarget(agent, container) {
    const key = `${agent}\u0000${container}`;
    this._cache.delete(`health:${key}`);
    this._cache.delete(`stats:${key}`);
  }
}

// ---- normalization ---------------------------------------------------------

function normalizeAgent(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const status = str(o.status).toLowerCase();
  return {
    name: str(o.name).slice(0, DOCKY_AGENT_MAX),
    url: str(o.url),
    status: ['online', 'offline', 'unknown'].includes(status) ? status : 'unknown',
    version: str(o.version) || null,
    lastCheck: str(o.lastCheck) || null,
  };
}

function normalizeContainer(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(o.id),
    name: str(o.name).slice(0, DOCKY_CONTAINER_MAX),
    image: str(o.image),
    state: normalizeState(o.state),
    health: normalizeHealth(o.health),
    stack: str(o.stack) || null,
    service: str(o.service),
  };
}

function normalizeHealthResult(t, raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    agent: t.agent,
    container: t.container,
    found: o.found === true,
    id: str(o.id) || null,
    name: str(o.name) || null,
    state: normalizeState(o.state),
    health: normalizeHealth(o.health),
    checkedAt: str(o.checkedAt) || null,
    error: normalizeErrorObj(o.error),
  };
}

function normalizeStatsResult(t, raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    agent: t.agent,
    container: t.container,
    state: normalizeState(o.state),
    health: normalizeHealth(o.health),
    cpu_percent: clampPct(o.cpu_percent),
    cpu_percent_raw: toNum(o.cpu_percent_raw),
    cpu_count: toNum(o.cpu_count),
    mem_usage: toNum(o.mem_usage),
    mem_limit: toNum(o.mem_limit),
    mem_percent: clampPct(o.mem_percent),
    network_rx: toNum(o.network_rx),
    network_tx: toNum(o.network_tx),
    // Disks are NOT measured by Docky (contract): always null, never an error.
    disk_usage: null,
    disk_limit: null,
    disk_percent: null,
    checkedAt: str(o.checkedAt) || null,
    error: normalizeErrorObj(o.error),
  };
}

function invalidTargetResult(t, kind, code = 'invalid_request', message = 'Invalid target') {
  const base = {
    agent: t?.agent || '',
    container: t?.container || '',
    state: 'unknown',
    health: 'none',
    error: { code, message },
  };
  if (kind === 'stats') {
    return {
      ...base,
      cpu_percent: null,
      cpu_percent_raw: null,
      cpu_count: null,
      mem_usage: null,
      mem_limit: null,
      mem_percent: null,
      network_rx: null,
      network_tx: null,
      disk_usage: null,
      disk_limit: null,
      disk_percent: null,
      checkedAt: null,
    };
  }
  return { ...base, found: false, id: null, name: null, checkedAt: null };
}

// ---- error mapping ---------------------------------------------------------

/**
 * Map a Docky HTTP failure to a normalized {@link DockyError}.
 * IMPORTANT: Docky `401`/`403` become a Homy `502` (NOT 401) so the front's
 * generic auth-expiry handler never logs the user out for a Docky misconfig.
 */
function mapHttpError(res, body) {
  const code = str(body?.code).toLowerCase();
  const message = str(body?.error) || str(body?.message) || `Docky responded with HTTP ${res.status}`;
  const byCode = {
    unauthorized: ['unauthorized', message, 502],
    forbidden: ['forbidden', message, 502],
    not_configured: ['not_configured', message, 503],
    no_agents: ['no_agents', message, 503],
    agent_offline: ['agent_offline', message, 503],
    agent_not_found: ['agent_not_found', message, 404],
    not_found: ['not_found', message, 404],
    conflict: ['conflict', message, 409],
    invalid_request: ['invalid_request', message, 400],
    agent_unreachable: ['agent_unreachable', message, 502],
    action_failed: ['action_failed', message, 502],
    timeout: ['timeout', message, 504],
    rate_limited: ['rate_limited', message, 429],
  };
  if (code && byCode[code]) {
    const [c, m, s] = byCode[code];
    return new DockyError(c, m, s, { retryAfter: res.headers.get('retry-after') });
  }
  // Fall back to the HTTP status when Docky sent no/unknown code.
  switch (res.status) {
    case 400:
      return new DockyError('invalid_request', message, 400);
    case 401:
      return new DockyError('unauthorized', message, 502);
    case 403:
      return new DockyError('forbidden', message, 502);
    case 404:
      return new DockyError('not_found', message, 404);
    case 409:
      return new DockyError('conflict', message, 409);
    case 429:
      return new DockyError('rate_limited', message, 429, { retryAfter: res.headers.get('retry-after') });
    case 503:
      return new DockyError('agent_offline', message, 503);
    case 504:
      return new DockyError('timeout', message, 504);
    default:
      return new DockyError('error', message, 502);
  }
}

function timeouts(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
