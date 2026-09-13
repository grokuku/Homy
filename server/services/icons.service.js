import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Icon library service (LOT 7): online SEARCH + LOCAL INSTALL of SVG icons.
 *
 * SOURCE (decision documented in roadmap §E and README):
 *   The canonical data service behind icons0.dev (and the vast majority of
 *   open-source icon collections) is the public **Iconify API**
 *   (`https://api.iconify.design`): free, no key, documented. icons0.dev itself
 *   exposes no documented HTTP API (only a web UI + an MCP server for AI
 *   agents), so we use Iconify directly by default. The base URL is
 *   CONFIGURABLE (`ICONS_API_BASE`) so a self-hosted mirror / a test stub can
 *   be swapped in — and it is the ONLY host this service will ever call
 *   (allowlist; no client-supplied URL is ever fetched).
 *
 * FLOW
 *   - search(q):     GET  <base>/search?query=…&limit=…  → normalized list
 *                    `{ id, prefix, name, collection, license, author }`,
 *                    PERMISSIVE-ONLY by default (see PERMISSIVE_LICENSES).
 *   - install(id):   verify the collection's license is permissive, download
 *                    `<base>/<prefix>/<name>.svg`, validate it strictly, store
 *                    it as DATA_DIR/icons/<slug>.svg and index it in
 *                    `icons.json` (atomic store, see store.service.js).
 *   - list/read/remove over the LOCAL store (traceability preserved).
 *
 * SECURITY
 *   - Every outbound fetch goes through `_url()` which builds the URL from the
 *     configured base and an id matching `^[a-z0-9-]+:[a-z0-9-]+$`, then
 *     asserts the resulting ORIGIN equals the base origin. Nothing else.
 *   - A response SVG is rejected when it is not well-formed, larger than
 *     64 KiB, or contains `<script>`, a `on*=` handler, `<foreignObject>`,
 *     `<iframe>/<object>/<embed>`, a `javascript:` scheme, a `<!ENTITY>`, or an
 *     EXTERNAL href/xlink:href. The stored SVG is served with a strict
 *     `image/svg+xml` Content-Type (JWT-protected, no public URL).
 *   - `currentColor` is preserved (Iconify emits `fill="currentColor"`), so the
 *     inlined icon follows the dashboard theme.
 *
 * NON-PERMISSIVE LICENSES ARE NEVER INSTALLED. The whitelist is enforced at
 * BOTH search (masked by default) and install (hard 400).
 */

export const ICONS_VERSION = 1;
export const MAX_ICONS = 500;
export const MAX_SVG_BYTES = 64 * 1024; // 64 KiB
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_API_BASE = 'https://api.iconify.design';

/** License SPDX ids that may be installed (permissive only — kind to users). */
export const PERMISSIVE_LICENSES = Object.freeze([
  'MIT',
  'Apache-2.0',
  'ISC',
  'CC0-1.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Unlicense',
]);

const PERMISSIVE_SET = new Set(PERMISSIVE_LICENSES);

// id == "prefix:name" — Iconify prefixes/names only use [a-z0-9-].
const ID_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

// Hardened SVG rejection patterns (see SECURITY above).
const FORBIDDEN_TAGS = /<\s*(script|foreignObject|iframe|object|embed|audio|video|animate|set)\b/i;
const EVENT_HANDLER = /\son[a-z]+\s*=/i;
const JS_SCHEME = /(?:href|src)\s*=\s*["']?\s*javascript:/i;
const DOCTYPE_ENTITY = /<!\s*(DOCTYPE|ENTITY)/i;
const EXTERNAL_REF = /\s(?:xlink:href|href)\s*=\s*["']\s*(?:https?:|\/\/)/i;

/** Thrown on invalid input / disallowed license; routes map it to HTTP 400. */
export class IconsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IconsValidationError';
    this.status = 400;
  }
}

/**
 * Thrown when the upstream icon service fails. `status` is a ready-to-use HTTP
 * code (504 timeout, 502 unreachable/upstream error, 404 unknown icon).
 */
export class IconsUpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'IconsUpstreamError';
    this.status = status;
  }
}

export class IconsService {
  constructor(store, { apiBase = DEFAULT_API_BASE, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.store = store;
    this.apiBase = normalizeBase(apiBase);
    this.baseOrigin = new URL(this.apiBase).origin;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.icons = this._load(); // never throws: degrades to an empty library
    this._svgCache = new Map(); // id -> { svg, expires } (search preview speedup)
  }

  _dir() {
    return path.join(this.store.dataDir, 'icons');
  }

  _file(slug) {
    return path.join(this._dir(), `${slug}.svg`);
  }

  _load() {
    const data = this.store.read('icons', null);
    if (data === null) {
      if (existsSync(path.join(this.store.dataDir, 'icons.json'))) {
        console.error('[icons] icons.json is corrupt — starting from an empty library.');
      }
      return [];
    }
    const raw = Array.isArray(data?.icons) ? data.icons : [];
    const out = [];
    for (const entry of raw) {
      const clean = coerceStored(entry);
      if (clean) out.push(clean);
      if (out.length >= MAX_ICONS) break;
    }
    return out;
  }

  // ---- local reads ----------------------------------------------------------

  list() {
    // Newest first — the Installed tab shows the most recent installs on top.
    return [...this.icons].sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
  }

  count() {
    return this.icons.length;
  }

  get(slug) {
    return this.icons.find((i) => i.slug === slug) ?? null;
  }

  getById(id) {
    return this.icons.find((i) => i.id === id) ?? null;
  }

  /** Raw stored SVG text for a slug, or null when unknown/missing. */
  readSvg(slug) {
    const entry = this.get(slug);
    if (!entry) return null;
    const file = this._file(slug);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  // ---- remote: search -------------------------------------------------------

  /**
   * Search the upstream service. Returns normalized, PERMISSIVE-ONLY results by
   * default (`includeAll: true` opts into showing non-permissive ones too — the
   * UI's « Permissive only » switch — but install still refuses them).
   * `withSvg` inlines each result's SVG (validated) for direct thumbnails.
   */
  async search(query, { limit = 24, includeAll = false, withSvg = true } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new IconsValidationError('q is required');
    if (q.length > 100) throw new IconsValidationError('q must be at most 100 characters');
    const cap = clampInt(limit, 1, 60, 24);

    // Over-fetch a little so the permissive filter cannot starve the page.
    const fetchLimit = Math.min(200, includeAll ? cap : cap * 3);
    const data = await this._fetchJson(this._url('/search', { query: q, limit: String(fetchLimit) }));
    const ids = Array.isArray(data?.icons) ? data.icons : [];
    const collections = data?.collections && typeof data.collections === 'object' ? data.collections : {};

    const results = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const normalized = normalizeResult(id, collections);
      if (!normalized) continue; // missing metadata → cannot trace → skip
      if (!includeAll && !normalized.permissive) continue;
      results.push(normalized);
      if (results.length >= cap) break;
    }

    if (withSvg) {
      await mapLimit(results, 6, async (r) => {
        try {
          r.svg = await this._fetchSvg(r.id);
        } catch {
          r.svg = ''; // thumbnail simply stays empty; install will retry/report
        }
      });
    }
    return results;
  }

  // ---- remote: install ------------------------------------------------------

  /**
   * Install one icon by id (`prefix:name`). Idempotent: installing an already
   * installed id returns the existing entry with `alreadyInstalled: true`.
   * Throws IconsValidationError (400) on bad id / non-permissive license,
   * IconsUpstreamError on upstream failure, and a 404-ish upstream error for an
   * unknown collection/icon.
   */
  async install(id) {
    const cleanId = typeof id === 'string' ? id.trim().toLowerCase() : '';
    if (!ID_RE.test(cleanId)) {
      throw new IconsValidationError('id must be a valid "prefix:name" icon id');
    }

    const existing = this.getById(cleanId);
    if (existing) return { ...existing, alreadyInstalled: true };

    if (this.icons.length >= MAX_ICONS) {
      throw new IconsValidationError(`Too many installed icons (max ${MAX_ICONS})`);
    }

    const [prefix, name] = cleanId.split(':');
    const collection = await this._fetchCollection(prefix);
    if (!collection) throw new IconsUpstreamError('Unknown icon collection', 404);

    const license = normalizeLicense(collection.license);
    if (!PERMISSIVE_SET.has(license)) {
      throw new IconsValidationError(
        `Icon collection "${prefix}" is not permissively licensed${license ? ` (${license})` : ''} — installation refused`
      );
    }

    // Download + validate BEFORE touching the disk.
    const svg = await this._fetchSvg(cleanId);

    const slug = this._slugFor(cleanId);
    mkdirSync(this._dir(), { recursive: true });
    const target = this._file(slug);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, svg, 'utf8');
    renameSync(tmp, target);

    const entry = {
      slug,
      id: cleanId,
      name: name,
      collection: String(collection.name || prefix),
      collectionPrefix: prefix,
      license,
      author: authorName(collection.author),
      source: `https://icon-sets.iconify.design/${prefix}/`,
      installedAt: new Date().toISOString(),
    };
    this.icons.push(entry);
    this._persist();
    return entry;
  }

  /** Delete an installed icon (file + index). Returns the removed entry or null. */
  remove(slug) {
    const index = this.icons.findIndex((i) => i.slug === slug);
    if (index === -1) return null;
    const [entry] = this.icons.splice(index, 1);
    const file = this._file(slug);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch (err) {
      console.error(`[icons] failed to delete ${file}:`, err?.message || err);
    }
    this._svgCache.delete(entry.id);
    this._persist();
    return entry;
  }

  _persist() {
    // Icons are installed infrequently and the index is tiny: flush immediately
    // so a fresh install/delete is observable on disk without waiting for the
    // store's debounce window.
    this.store.writeNow('icons', { version: ICONS_VERSION, icons: this.icons });
  }

  _slugFor(id) {
    const base = slugify(id);
    const clash = this.icons.find((i) => i.slug === base && i.id !== id);
    if (!clash) return base;
    return `${base}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}`;
  }

  // ---- outbound HTTP (allowlisted host only) --------------------------------

  /** Build a URL against the configured base and ENFORCE the host allowlist. */
  _url(pathname, params) {
    const url = new URL(pathname, this.apiBase);
    if (url.origin !== this.baseOrigin) {
      throw new IconsUpstreamError('Refused: URL outside the configured icon service', 502);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new IconsUpstreamError('Refused: unsupported protocol', 502);
    }
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  async _fetchCollection(prefix) {
    const url = this._url('/collections', { prefix });
    const data = await this._fetchJson(url);
    return data && typeof data === 'object' && data[prefix] ? data[prefix] : null;
  }

  async _fetchSvg(id) {
    const cached = this._svgCache.get(id);
    if (cached && cached.expires > Date.now()) return cached.svg;
    const [prefix, name] = String(id).split(':');
    if (!ID_RE.test(String(id))) throw new IconsValidationError('Invalid icon id');
    const url = this._url(`/${prefix}/${name}.svg`);
    const svg = await this._fetchText(url, { expectSvg: true });
    if (this._svgCache.size > 300) this._svgCache.clear();
    this._svgCache.set(id, { svg, expires: Date.now() + 10 * 60 * 1000 });
    return svg;
  }

  async _fetchJson(url) {
    const res = await this._request(url);
    try {
      return await res.json();
    } catch {
      throw new IconsUpstreamError('Icon service returned invalid JSON', 502);
    }
  }

  async _fetchText(url, { expectSvg = false } = {}) {
    const res = await this._request(url);
    const text = await res.text();
    if (expectSvg) {
      const check = validateSvg(text);
      // An invalid body is a CLIENT-facing validation failure (task contract:
      // install → 400 on invalid SVG), even though it came from upstream. The
      // search path catches it and simply omits the thumbnail.
      if (!check.ok) throw new IconsValidationError(`Rejected icon SVG: ${check.error}`);
    }
    return text;
  }

  async _request(url) {
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json, image/svg+xml, text/plain' },
        redirect: 'error', // never follow a redirect away from the allowlist
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new IconsUpstreamError('Icon service timed out', 504);
      }
      throw new IconsUpstreamError('Icon service unreachable', 502);
    }
    if (res.status === 404) throw new IconsUpstreamError('Unknown icon', 404);
    if (!res.ok) throw new IconsUpstreamError(`Icon service error (${res.status})`, 502);
    return res;
  }
}

// ---- license / metadata normalization --------------------------------------

/**
 * Canonicalize an Iconify `license` object (`{ title, spdx, url }`) to a known
 * SPDX id, or '' when unknown / non-permissive. Both `spdx` and `title` are
 * accepted because a few collections only carry a human title.
 */
export function normalizeLicense(license) {
  if (!license) return '';
  const candidates = [license.spdx, license.title];
  for (const raw of candidates) {
    const key = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) continue;
    const mapped = LICENSE_ALIASES[key];
    if (mapped) return mapped;
  }
  return '';
}

const LICENSE_ALIASES = {
  mit: 'MIT',
  apache20: 'Apache-2.0',
  apache2: 'Apache-2.0',
  apachelicense20: 'Apache-2.0',
  isc: 'ISC',
  cc010: 'CC0-1.0',
  cc00: 'CC0-1.0',
  cc0: 'CC0-1.0',
  bsd2clause: 'BSD-2-Clause',
  bsd2: 'BSD-2-Clause',
  bsd3clause: 'BSD-3-Clause',
  bsd3: 'BSD-3-Clause',
  unlicense: 'Unlicense',
  theunlicense: 'Unlicense',
};

function authorName(author) {
  if (!author) return '';
  if (typeof author === 'string') return author.trim();
  if (typeof author.name === 'string') return author.name.trim();
  return '';
}

/** Normalize one `prefix:name` search hit against its collection metadata. */
function normalizeResult(id, collections) {
  if (typeof id !== 'string') return null;
  const sep = id.indexOf(':');
  if (sep <= 0) return null;
  const prefix = id.slice(0, sep).toLowerCase();
  const name = id.slice(sep + 1).toLowerCase();
  if (!prefix || !name) return null;
  const meta = collections[prefix];
  const license = normalizeLicense(meta?.license);
  return {
    id: `${prefix}:${name}`,
    prefix,
    name,
    collection: String(meta?.name || prefix),
    license,
    author: authorName(meta?.author),
    permissive: PERMISSIVE_SET.has(license),
  };
}

// ---- SVG validation --------------------------------------------------------

/**
 * Strict, dependency-free SVG sanity check for a downloaded body.
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export function validateSvg(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty body' };
  if (Buffer.byteLength(text, 'utf8') > MAX_SVG_BYTES) return { ok: false, error: 'too large (max 64 KB)' };
  if (/<\s*parsererror/i.test(text)) return { ok: false, error: 'malformed XML' };
  if (!/<\s*svg[\s>]/i.test(text)) return { ok: false, error: 'missing <svg> root' };
  if (!/<\/\s*svg\s*>/i.test(text)) return { ok: false, error: 'unclosed <svg>' };
  if (FORBIDDEN_TAGS.test(text)) return { ok: false, error: 'forbidden element' };
  if (EVENT_HANDLER.test(text)) return { ok: false, error: 'inline event handler' };
  if (JS_SCHEME.test(text)) return { ok: false, error: 'javascript: scheme' };
  if (DOCTYPE_ENTITY.test(text)) return { ok: false, error: 'DTD/entity declaration' };
  if (EXTERNAL_REF.test(text)) return { ok: false, error: 'external reference' };
  return { ok: true };
}

// ---- small helpers ---------------------------------------------------------

function normalizeBase(raw) {
  const value = String(raw || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_API_BASE;
  }
}

function slugify(id) {
  const s = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return s || 'icon';
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Bounded-concurrency `map` (preserves order; never rejects on item errors). */
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

// ---- tolerant load coercion ------------------------------------------------

function coerceStored(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!ID_RE.test(id)) return null;
  const slug = typeof raw.slug === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(raw.slug) ? raw.slug : slugify(id);
  const sep = id.indexOf(':');
  return {
    slug,
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id.slice(sep + 1),
    collection: typeof raw.collection === 'string' ? raw.collection : id.slice(0, sep),
    collectionPrefix: typeof raw.collectionPrefix === 'string' ? raw.collectionPrefix : id.slice(0, sep),
    license: normalizeLicense({ spdx: raw.license, title: raw.license }),
    author: typeof raw.author === 'string' ? raw.author : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    installedAt: isIso(raw.installedAt) ? raw.installedAt : new Date().toISOString(),
  };
}

function isIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
