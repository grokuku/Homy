import { el } from '../util.js';
import { api } from '../api.js';

/**
 * Report tile (LOT 8) — a DEDICATED tile kind inside a `group` (alongside
 * `buttons[]`), referencing a catalogue element that carries a `report` config.
 *
 * Unlike a button, a report tile has a FREE size on the group's internal trame
 * (no button-variant minima): it renders the normalized payload returned by
 * `GET /api/reports/:elementId` — active sessions (user / media / progress /
 * device / transcoding) plus a readable DEGRADED state when the service is
 * unreachable (never a crash, never a request loop).
 *
 * LIFECYCLE: `renderReportTile()` returns `{ el, dispose }`. `dispose` clears
 * the refresh interval so NO timer survives a group re-render / destroy (the
 * group wires every dispose into its own cleanup returned to `disposeWidget`).
 * A periodic refresh (REFRESH_MS) keeps the data reasonably fresh; a disposed
 * tile can never schedule another request.
 */

// MUST stay in sync with REPORT_CELLS_MIN/MAX (server: layout.routes.js /
// layout.service.js) — free internal-trame size for a report tile.
export const REPORT_CELLS_MIN = 2;
export const REPORT_CELLS_MAX = 64;
export const REFRESH_MS = 30_000;

/** A report tile completed with its geometry (never throws). */
export function normalizeReport(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof r.id === 'string' ? r.id : '',
    elementId: typeof r.elementId === 'string' ? r.elementId : '',
    col: clampInt(r.col, 0, 0, 100000),
    row: clampInt(r.row, 0, 0, 100000),
    w: clampInt(r.w, REPORT_CELLS_MIN, REPORT_CELLS_MIN, REPORT_CELLS_MAX),
    h: clampInt(r.h, REPORT_CELLS_MIN, REPORT_CELLS_MIN, REPORT_CELLS_MAX),
  };
}

/** Apply a report tile's grid placement (same inline grid contract as buttons). */
export function applyReportMetrics(tileEl, rawReport, step = 22.5) {
  if (!tileEl) return;
  const r = normalizeReport(rawReport);
  tileEl.style.gridColumn = `${r.col + 1} / span ${r.w}`;
  tileEl.style.gridRow = `${r.row + 1} / span ${r.h}`;
  tileEl.dataset.size = `${r.w}x${r.h}`;
  tileEl.style.setProperty('--tile-w-px', `${r.w * step}px`);
  tileEl.style.setProperty('--tile-h-px', `${r.h * step}px`);
}

/**
 * Build a report tile and start its refresh loop.
 * Returns `{ el, dispose }` — `dispose()` MUST be called on teardown.
 */
export function renderReportTile({ report, element, step = 22.5 }) {
  const r = normalizeReport(report);
  const root = el('div', 'report-tile');
  applyReportMetrics(root, r, step);
  root.dataset.elementId = r.elementId;

  const title = element?.name || 'Report';
  const type = element?.report?.type || '';
  root.dataset.reportType = type;

  const head = el('div', 'report-head');
  head.appendChild(el('span', 'report-title', title));
  const countEl = el('span', 'report-count', '');
  head.appendChild(countEl);
  const body = el('div', 'report-body');
  body.appendChild(el('div', 'report-state muted', 'Loading…'));
  root.append(head, body);

  if (!element) {
    root.dataset.status = 'error';
    body.replaceChildren(el('div', 'report-state', 'Unknown element'));
    return { el: root, dispose: () => {} };
  }
  if (!type) {
    root.dataset.status = 'error';
    body.replaceChildren(el('div', 'report-state', 'No report configured on this element'));
    return { el: root, dispose: () => {} };
  }

  let disposed = false;
  let timer = 0;

  const render = (data) => {
    if (disposed) return;
    const status = data?.status || 'error';
    root.dataset.status = status;
    if (status !== 'ok') {
      countEl.textContent = '';
      body.replaceChildren(el('div', 'report-state', degradedMessage(status, data?.error)));
      return;
    }
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    countEl.textContent = sessions.length ? String(sessions.length) : '';
    if (sessions.length === 0) {
      body.replaceChildren(el('div', 'report-state muted', 'No active streams'));
      return;
    }
    const list = el('div', 'report-sessions');
    for (const s of sessions) list.appendChild(buildSession(s));
    body.replaceChildren(list);
  };

  const load = async () => {
    if (disposed) return;
    try {
      const data = await api.get(`/api/reports/${encodeURIComponent(r.elementId)}`);
      render(data);
    } catch (err) {
      // A 404 means the element has no report / is gone: readable state, no loop.
      render({ status: err?.status === 404 ? 'unauthorized' : 'error', error: err?.message });
    }
  };

  load();
  timer = setInterval(load, REFRESH_MS);

  return {
    el: root,
    dispose: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = 0;
    },
  };
}

function buildSession(s) {
  const row = el('div', 'report-session');
  const top = el('div', 'report-session-top');
  top.appendChild(el('span', 'report-media', s.media || 'Unknown media'));
  if (s.transcoding) top.appendChild(el('span', 'report-badge report-badge-tc', 'transcode'));
  if (s.paused) top.appendChild(el('span', 'report-badge report-badge-paused', 'paused'));
  row.appendChild(top);

  const meta = [s.user, s.device || s.client].filter(Boolean).join(' · ');
  if (meta) row.appendChild(el('div', 'report-sub muted', meta));

  if (typeof s.progress === 'number') {
    const bar = el('div', 'report-bar');
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, s.progress))}%`;
    bar.appendChild(fill);
    const line = el('div', 'report-meta');
    line.appendChild(el('span', null, `${s.progress}%`));
    if (s.durationTicks && s.positionTicks !== undefined) {
      line.appendChild(el('span', 'report-time', `${fmtTime(s.positionTicks)} / ${fmtTime(s.durationTicks)}`));
    }
    row.append(bar, line);
  }
  return row;
}

function degradedMessage(status, error) {
  if (error) return error;
  switch (status) {
    case 'unreachable':
      return 'Service unreachable';
    case 'timeout':
      return 'Service timed out';
    case 'unauthorized':
      return 'Invalid API key or access denied';
    case 'not_implemented':
      return 'Reporting not implemented yet';
    default:
      return 'Report unavailable';
  }
}

/** Jellyfin ticks (100 ns) → « h:mm:ss » / « m:ss ». */
function fmtTime(ticks) {
  const totalSeconds = Math.max(0, Math.round(Number(ticks) / 10_000_000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function clampInt(value, min, fallback, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
