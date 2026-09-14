import { randomUUID } from 'node:crypto';

/**
 * Report providers registry (LOT 8 — "Special reporting").
 *
 * An `element` of the global catalogue may carry an OPTIONAL report config
 *   report: { type: 'jellyfin', baseUrl, apiKey }
 * and a `group` may contain dedicated REPORT TILES referencing such an element.
 * This module is the PLUGGABLE registry of report TYPES: each type declares
 *   - its configuration FIELDS (rendered by the element form),
 *   - a `fetch(credentials, opts)` function returning a NORMALIZED payload
 *     (stable shape for the front) — or a DEGRADED state.
 *
 * Only Jellyfin is IMPLEMENTED; radarr / sonarr / qbittorrent are DECLARED but
 * not implemented (`implemented: false`), so the front can list them as
 * "soon" without a schema change when they land.
 *
 * SECURITY (§G):
 *   - API keys NEVER leave the server: routes return the normalized report
 *     data only, never the credentials; the catalogue masks `apiKey` behind
 *     `hasApiKey` (see elements.service.js).
 *   - Outbound calls are made BY THE SERVER to the URL configured by the user
 *     (self-hosted instance, single-user). Only http(s) is accepted.
 *   - Every outbound call has a TIMEOUT; failures degrade to a readable state
 *     (`unreachable` / `timeout` / `unauthorized` / `error`) — never a throw
 *     to the route layer, never an infinite retry loop.
 */
export const DEFAULT_TIMEOUT_MS = 8000;
export const MAX_SESSIONS = 50;
export const REPORT_FIELD_MAX = 2048;
export const REPORT_TYPE_MAX = 32;
export const MAX_BASE_URL = 2048;

/**
 * Sentinel a client sends in place of `apiKey` when it does NOT want to change
 * the stored key (the form shows a « •••• » placeholder). The server keeps the
 * existing key; the actual secret is never round-tripped to the browser.
 * MUST stay in sync with API_KEY_SENTINEL in public/js/ui/elementsModal.js.
 */
export const API_KEY_SENTINEL = '__KEEP__';

/** Thrown on invalid report configuration; routes map it to HTTP 400. */
export class ReportsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReportsValidationError';
    this.status = 400;
  }
}

// ---- Registry ---------------------------------------------------------------

/** The two standard fields every (implemented) provider exposes. */
const CREDENTIAL_FIELDS = [
  {
    key: 'baseUrl',
    label: 'Server URL',
    type: 'url',
    required: true,
    placeholder: 'http://jellyfin:8096',
    help: 'Base URL of your self-hosted instance (http/https). Stored server-side only.',
  },
  {
    key: 'apiKey',
    label: 'API key',
    type: 'password',
    required: true,
    help: 'The key is stored server-side and never sent back to the browser.',
  },
];

const jellyfin = {
  id: 'jellyfin',
  label: 'Jellyfin',
  declared: true,
  implemented: true,
  fields: CREDENTIAL_FIELDS,
  /**
   * Fetch + normalize Jellyfin activity. `credentials` = { baseUrl, apiKey }.
   * NEVER throws: every failure mode returns a degraded payload.
   */
  async fetch(credentials, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return fetchJellyfin(credentials, timeoutMs);
  },
};

/** A declared-but-not-implemented provider (listed by GET /api/reports/types). */
function declaredOnly(id, label) {
  return {
    id,
    label,
    declared: true,
    implemented: false,
    fields: CREDENTIAL_FIELDS,
    async fetch() {
      return {
        status: 'not_implemented',
        server: null,
        sessions: [],
        error: `${label} reporting is not implemented yet`,
      };
    },
  };
}

export const reportTypes = {
  jellyfin,
  radarr: declaredOnly('radarr', 'Radarr'),
  sonarr: declaredOnly('sonarr', 'Sonarr'),
  qbittorrent: declaredOnly('qbittorrent', 'qBittorrent'),
};

export function getReportType(id) {
  return reportTypes[id] ?? null;
}

export function isKnownReportType(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(reportTypes, id);
}

export function isImplementedReportType(id) {
  return getReportType(id)?.implemented === true;
}

/** Client-safe type list (no `fetch`): implemented + declared providers. */
export function publicReportTypes() {
  return Object.values(reportTypes).map((t) => ({
    id: t.id,
    label: t.label,
    declared: t.declared === true,
    implemented: t.implemented === true,
    fields: (t.fields || []).map((f) => ({ ...f })),
  }));
}

/**
 * Run one provider against credentials and return the normalized payload with
 * the element/type metadata attached. Unknown / unimplemented types degrade.
 */
export async function fetchReport(typeId, credentials, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const provider = getReportType(typeId);
  if (!provider || provider.implemented !== true) {
    return {
      status: 'not_implemented',
      server: null,
      sessions: [],
      error: provider ? `${provider.label} reporting is not implemented yet` : 'Unknown report type',
    };
  }
  try {
    return await provider.fetch(credentials, { timeoutMs });
  } catch (err) {
    // Belt-and-braces: a provider must never leak an exception to the route.
    return {
      status: 'error',
      server: null,
      sessions: [],
      error: 'Report service failed',
    };
  }
}

// ---- Jellyfin provider ------------------------------------------------------

/**
 * Jellyfin authentication headers.
 *
 * HISTORY (LOT 8 fix): the original implementation authenticated with the
 * legacy `?api_key=<key>` QUERY parameter. Modern Jellyfin (10.9+/12.x)
 * REMOVED query-string key support and answers `HTTP 401` for it — verified
 * against a real Jellyfin 12.0.0 server where the SAME valid key returns 200
 * via the `MediaBrowser` Authorization scheme. `X-Emby-Token` is likewise
 * rejected by that build. The canonical, version-agnostic mechanism is:
 *
 *   Authorization: MediaBrowser Token="<apiKey>"
 *
 * Using a header also keeps the secret OUT of the URL, so it can never land in
 * reverse-proxy / access logs upstream.
 *
 * Returns `null` when the key is empty or contains characters that would break
 * (or inject into) the header value — never expected for a real key.
 */
export function jellyfinAuthHeaders(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return null;
  // Reject CR/LF/control chars and quotes: guarantees a well-formed header.
  if (/[\u0000-\u001f\u007f"]/.test(key)) return null;
  return { authorization: `MediaBrowser Token="${key}"` };
}

async function fetchJellyfin(credentials, timeoutMs) {
  const baseUrl = normalizeBaseUrl(credentials?.baseUrl);
  const apiKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey : '';
  if (!baseUrl) return degraded('error', 'Invalid server URL');
  if (!apiKey) return degraded('unauthorized', 'Missing API key');

  const authHeaders = jellyfinAuthHeaders(apiKey);
  if (!authHeaders) return degraded('unauthorized', 'Invalid API key format');

  const sessionsUrl = buildUrl(baseUrl, '/Sessions');
  if (!sessionsUrl) return degraded('error', 'Invalid server URL');
  const headers = { accept: 'application/json', ...authHeaders };

  // Best-effort server info: launched CONCURRENTLY and fully isolated so a slow
  // / absent / 401 /System/Info can neither delay nor degrade the sessions
  // report. Its rejection is swallowed immediately (never an unhandled
  // rejection) and it never carries the key into the URL.
  const infoPromise = fetchJellyfinServerInfo(baseUrl, headers, timeoutMs);

  let res;
  try {
    res = await fetch(sessionsUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
  } catch (err) {
    return degraded(...mapFetchError(err));
  }
  if (res.status === 401 || res.status === 403) {
    return degraded('unauthorized', `Invalid API key or access denied (HTTP ${res.status})`);
  }
  if (!res.ok) {
    return degraded('error', `Jellyfin responded with HTTP ${res.status}`);
  }
  let raw;
  try {
    raw = await res.json();
  } catch {
    return degraded('error', 'Jellyfin returned invalid JSON');
  }
  const sessions = normalizeSessions(raw).slice(0, MAX_SESSIONS);

  const info = (await infoPromise) || { name: '', version: '' };
  const server = { name: info.name, version: info.version, sessionCount: sessions.length };

  return { status: 'ok', server, sessions, error: null };
}

/**
 * OPTIONAL `/System/Info` lookup (server name/version). NEVER throws and NEVER
 * blocks the report: any failure resolves to `null`.
 */
async function fetchJellyfinServerInfo(baseUrl, headers, timeoutMs) {
  try {
    const infoUrl = buildUrl(baseUrl, '/System/Info');
    if (!infoUrl) return null;
    const res = await fetch(infoUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (!res.ok) return null;
    const info = await res.json();
    return normalizeServerInfo(info);
  } catch {
    return null;
  }
}

function degraded(status, error) {
  return { status, server: null, sessions: [], error };
}

/**
 * Map a thrown fetch error to a DIAGNOSABLE degraded state. The status stays
 * within the known set (`timeout` / `unreachable` / `error`); the message names
 * the underlying network cause (DNS, refused connection, TLS…) WITHOUT ever
 * echoing the API key or the full request URL.
 */
function mapFetchError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return ['timeout', 'Jellyfin did not respond in time'];
  }
  const code = deepestErrorCode(err);
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return ['unreachable', 'Jellyfin host not found — check the server URL / DNS'];
    case 'ECONNREFUSED':
      return ['unreachable', 'Jellyfin refused the connection — check the server URL / port'];
    case 'ECONNRESET':
      return ['unreachable', 'Jellyfin closed the connection unexpectedly'];
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return ['timeout', 'Jellyfin did not respond in time'];
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return ['error', `TLS certificate error (${code})`];
    case 'ERR_INVALID_URL':
      return ['error', 'Invalid server URL'];
    default:
      return ['unreachable', 'Jellyfin is unreachable'];
  }
}

/** Walk the `cause` chain (undici wraps Node errors) for the deepest `code`. */
function deepestErrorCode(err) {
  let current = err;
  let code = '';
  let depth = 0;
  while (current && depth < 6) {
    if (typeof current.code === 'string' && current.code) code = current.code;
    current = current.cause;
    depth++;
  }
  return code;
}

/**
 * Tolerant `user.name.mediaLabel` normalization of /Sessions.
 *
 * ONE SESSION = ONE ROW. Sessions are NEVER de-duplicated by user (or by
 * anything else): when the SAME user plays several videos in parallel, Jellyfin
 * reports one session per playback and EVERY one of them must reach the tile.
 * The only defensive treatment is the id: Jellyfin ids are unique, but if a
 * build ever repeats one for two distinct playbacks we suffix the second so a
 * downstream keyed render can never collapse them into a single row.
 */
function normalizeSessions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seenIds = new Set();
  for (const session of list) {
    if (!session || typeof session !== 'object') continue;
    const item = session.NowPlayingItem;
    if (!item || typeof item !== 'object') continue; // idle session: no stream
    const play = session.PlayState && typeof session.PlayState === 'object' ? session.PlayState : {};
    const durationTicks = toNumber(item.RunTimeTicks);
    const positionTicks = toNumber(play.PositionTicks);
    const progress =
      durationTicks > 0
        ? Math.max(0, Math.min(100, Math.round((positionTicks / durationTicks) * 100)))
        : null;
    const playMethod = str(play.PlayMethod);
    let id = str(session.Id) || randomUUID();
    if (seenIds.has(id)) id = `${id}#${out.length}`;
    seenIds.add(id);
    out.push({
      id,
      user: str(session.UserName) || 'Unknown user',
      media: mediaLabel(item),
      type: str(item.Type),
      series: str(item.SeriesName) || null,
      year: toNumber(item.ProductionYear) || null,
      device: str(session.DeviceName),
      client: str(session.Client),
      progress,
      positionTicks,
      durationTicks,
      paused: play.IsPaused === true,
      transcoding: playMethod === 'Transcode' || !!session.TranscodingInfo,
      playMethod: playMethod || null,
    });
  }
  return out;
}

function mediaLabel(item) {
  const name = str(item.Name) || 'Unknown media';
  const series = str(item.SeriesName);
  if (!series) return name;
  const season = toNumber(item.ParentIndexNumber);
  const episode = toNumber(item.IndexNumber);
  const code =
    season !== null || episode !== null
      ? ` S${pad2(season)}E${pad2(episode)}`
      : '';
  return `${series} ·${code} ${name}`.replace(/\s+/g, ' ').trim();
}

function normalizeServerInfo(info) {
  const obj = info && typeof info === 'object' ? info : {};
  return {
    name: str(obj.ServerName),
    version: str(obj.Version),
  };
}

// ---- helpers ----------------------------------------------------------------

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pad2(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '?';
  return String(Math.floor(n)).padStart(2, '0');
}

/** Trim + validate an http(s) base URL. Returns '' when unusable. */
export function normalizeBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > MAX_BASE_URL) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** Append a path to the (already normalized) base URL. Never throws. */
function buildUrl(base, pathname) {
  try {
    return new URL(`${base}${pathname}`);
  } catch {
    return null;
  }
}
