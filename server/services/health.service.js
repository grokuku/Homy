/**
 * Custom health-check service (element.healthUrl).
 *
 * A SMALL, server-only HTTP prober: given a list of user-configured health
 * URLs, it issues one bounded GET per URL and returns a normalized
 * `{ url, ok, status, checkedAt, error }` result per entry.
 *
 * SECURITY (project rule — the server must never fetch an arbitrary URL):
 *   - ONLY `http:` / `https:` are accepted. Every other scheme (`file:`,
 *     `ftp:`, `gopher:`, `data:`…) is rejected BEFORE any `fetch()` — the route
 *     maps an invalid input to HTTP 400;
 *   - URLs carrying embedded credentials (`https://user:pass@host`) are
 *     refused: a secret must never ride in a URL this server stores/logs;
 *   - every probe is bounded by a SHORT AbortSignal timeout (5 s default);
 *   - a request may carry at most {@link MAX_HEALTH_URLS} URLs (bound);
 *   - the URL is NEVER written to the console — failures are logged by code
 *     only, so a query token cannot leak into the logs.
 *
 * PERFORMANCE: a small in-memory TTL cache (~30 s) per URL collapses the
 * repeated reads of a ~30 s dashboard cycle into (at most) one upstream probe.
 * Concurrent probes of the SAME URL are de-duplicated through an in-flight
 * promise map, so a burst can never fan out to N requests.
 *
 * Result contract:
 *   ok      → the server answered 2xx or 3xx;
 *   status  → the HTTP status code (null when the transport failed);
 *   error   → a readable, stable code when ok is false:
 *             `timeout` | `unreachable` | `http_<status>`;
 *   checkedAt → ISO timestamp of the probe (cached value keeps its own time).
 */

export const MAX_HEALTH_URLS = 20; // hard route cap
export const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
export const DEFAULT_HEALTH_CACHE_TTL_MS = 30000;
export const HEALTH_URL_MAX = 2048;

/** Thrown by checkBatch when the raw list is unusable; the route maps to 400. */
export class HealthValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HealthValidationError';
    this.status = 400;
  }
}

/**
 * Validate + normalize one health URL. Returns the trimmed URL string when it
 * is a usable http(s) URL WITHOUT credentials; otherwise `null` (never throws).
 */
export function normalizeHealthUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > HEALTH_URL_MAX) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    // Credentials in a URL are a leak vector (and a secret we must not store).
    if (url.username || url.password) return null;
    // Keep the ORIGINAL trimmed string (not url.toString()): the front caches
    // and maps results by the exact element.healthUrl value, so normalizing
    // (e.g. adding a trailing slash) would break the client-side key match.
    return value;
  } catch {
    return null;
  }
}

export class HealthService {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs]     per-probe timeout (default 5000)
   * @param {number} [options.cacheTtlMs]    per-URL cache TTL (default 30000)
   */
  constructor(options = {}) {
    this.timeoutMs = positive(options.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
    this.cacheTtlMs = positive(options.cacheTtlMs, DEFAULT_HEALTH_CACHE_TTL_MS);
    /** @type {Map<string, {expires:number, value:object}>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<object>>} — de-dupes concurrent probes. */
    this._inflight = new Map();
  }

  /**
   * Probe a list of raw URLs. Invalid entries are SKIPPED defensively (the
   * route already rejects an invalid list with a 400); results preserve the
   * input order and never throw for a transport failure.
   */
  async checkBatch(rawUrls) {
    if (!Array.isArray(rawUrls)) throw new HealthValidationError('urls must be an array');
    if (rawUrls.length === 0) throw new HealthValidationError('urls must not be empty');
    if (rawUrls.length > MAX_HEALTH_URLS) {
      throw new HealthValidationError(`Too many urls (max ${MAX_HEALTH_URLS})`);
    }
    const urls = [];
    for (const raw of rawUrls) {
      const normalized = normalizeHealthUrl(raw);
      if (!normalized) throw new HealthValidationError('Each url must be a valid http(s) URL without credentials');
      urls.push(normalized);
    }
    return Promise.all(urls.map((url) => this.checkUrl(url)));
  }

  /** Probe ONE http(s) URL, cache-first (never throws). */
  async checkUrl(url) {
    const cached = this._cacheGet(url);
    if (cached) return cached;
    const inflight = this._inflight.get(url);
    if (inflight) return inflight;
    const promise = this._probe(url)
      .then((result) => {
        this._cacheSet(url, result);
        return result;
      })
      .finally(() => this._inflight.delete(url));
    this._inflight.set(url, promise);
    return promise;
  }

  async _probe(url) {
    const checkedAt = new Date().toISOString();
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { accept: '*/*' },
        // 3xx is a SUCCESS per contract; never follow a redirect to an
        // unconfigured host (bounded, credential-free probing).
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Never log the URL (it may carry a token query param): code only.
      const code = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'unreachable';
      return { url, ok: false, status: null, checkedAt, error: code };
    }
    const status = Number.isInteger(res.status) ? res.status : null;
    // Discard the body without buffering it: we only need the status line.
    try {
      await res.body?.cancel();
    } catch {
      /* body already consumed / not cancellable */
    }
    const ok = status !== null && status >= 200 && status < 400;
    return { url, ok, status, checkedAt, error: ok ? null : `http_${status ?? 'error'}` };
  }

  // ---- cache ----------------------------------------------------------------

  _cacheGet(url) {
    const entry = this._cache.get(url);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this._cache.delete(url);
      return null;
    }
    return entry.value;
  }

  _cacheSet(url, value) {
    this._cache.set(url, { expires: Date.now() + this.cacheTtlMs, value });
  }
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
