import { el, isValidHttpUrl } from '../util.js';
import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { dockyApi, dockyPoller } from '../docky/docky.js';
import { HolafIcons } from '../../vendor/holaf/holaf-icons.js';

/**
 * Button tile renderer (LOT 2 — READ ONLY).
 *
 * A `button` is an INSTANCE of a catalogue `element`, placed inside a `group`.
 * It carries the display switches (`options`) and the grid geometry (col/row/w/h
 * in INTERNAL cells — the group's trame is 2× finer than the global grid, see
 * group.js). This module turns `{ button, element }` into a `<div class="group-tile">`
 * and applies the WHOLE variant matrix (§A.5 of the roadmap):
 *
 *   icon alone · icon+label · icon+health · icon+monitoring · icon+controls ·
 *   monitoring info alone · status (health) alone · controls alone ·
 *   explicit fallback when NOTHING is enabled.
 *
 * DISPLAY OPTIONS (all tolerant / defaulted):
 *   - icon              → the element icon (emoji / holaf:<name> / http(s) URL);
 *   - label             → the element name;
 *   - shortcut          → the tile's MAIN zone opens the element url (a real
 *                         <a href> when a valid http(s) url exists, inert otherwise);
 *   - health            → a live status dot (Docky: healthy/unhealthy/starting/none);
 *   - monitoring        → live CPU / RAM rows (Docky health+stats batch);
 *   - controls          → a live start/stop/restart zone with a 2-step
 *                         confirmation (Docky actions; a 409 is an idempotent
 *                         success);
 *   - iconSize          → S | M | L | XL | Fill = 40/55/70/85/100 % of the tile's
 *                         useful internal dimension (min side), see ICON_FRACTION;
 *   - allowIconOverflow → advanced, default OFF: lets the icon spill outside the
 *                         tile box instead of being clipped.
 *
 * LIVE DATA: when the element carries a Docky target, the tile subscribes to
 * `dockyPoller` (page-level health+stats batch, ~30 s) and unsubscribes in its
 * `dispose`. Without a target — or while Docky is offline — the tile degrades
 * to a grey dot / « — » / disabled controls, never a crash.
 *
 * TILE SIZES: the tile footprint is `w × step` by `h × step` internal px, where
 * `step` is the group's internal cell size (half a global cell). The matrix's
 * canonical sizes are 2×2, 4×2, 2×4 and 4×4 INTERNAL cells (i.e. 1×1 … 2×2 in
 * units of 2 internal cells). A stored value below the 2-cell minimum is
 * CLAMPED UP to 2 so no tile ever renders under the 45 px floor.
 */

export const ICON_SIZES = ['S', 'M', 'L', 'XL', 'Fill'];
export const ICON_SIZE_DEFAULT = 'M';

// Fraction of the tile's useful internal dimension (= its smaller side).
export const ICON_FRACTION = { S: 0.4, M: 0.55, L: 0.7, XL: 0.85, Fill: 1 };

// Smallest legal tile edge, in INTERNAL cells (2×2 internal = 1×1 global = 45 px
// on a 1440 px canvas). Sub-minimum stored values are clamped up to this.
const MIN_TILE_CELLS = 2;
const MAX_TILE_CELLS = 4;

const CONTROL_ACTIONS = [
  { action: 'start', glyph: '▶' },
  { action: 'stop', glyph: '■' },
  { action: 'restart', glyph: '↻' },
];

/** One display option set, completed with its documented defaults. */
export function normalizeOptions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  return {
    icon: bool(o.icon, true),
    label: bool(o.label, true),
    shortcut: bool(o.shortcut, true),
    health: bool(o.health, false),
    monitoring: bool(o.monitoring, false),
    controls: bool(o.controls, false),
    iconSize: ICON_SIZES.includes(o.iconSize) ? o.iconSize : ICON_SIZE_DEFAULT,
    allowIconOverflow: bool(o.allowIconOverflow, false),
  };
}

// ---- Minimum tile size per variant (roadmap §A.7) --------------------------
// Sizes are returned in INTERNAL cells — the unit of button.w/h, where a
// button's « 1×1 » unit = 2×2 internal cells = 1 global cell (§B). This is the
// single source of truth lot 4 will use to constrain tile resizing; lot 3 only
// exposes it (there is still NO tile editing).
const SIZE_SQUARE = { w: 2, h: 2 }; // 1×1 global
const SIZE_WIDE = { w: 4, h: 2 }; // 2×1 global
const SIZE_BIG = { w: 4, h: 4 }; // 2×2 global

/**
 * Minimum / ideal tile size for a display-option combination, in INTERNAL
 * cells (1 global cell = 2 internal cells). User-validated rule (§A.7):
 *
 *   icon alone ............ 1×1 global — smallest legal square
 *   icon + label .......... 2×1 global (icon + label on one row)
 *   icon + health ......... 1×1 min (dot in a corner) · 2×1 ideal
 *   icon + monitoring ..... 2×2 global (CPU/RAM rows beside the icon)
 *   icon + controls ....... 2×1 min · 2×2 ideal
 *   monitoring alone ...... 2×1 global
 *   status (health) alone . 2×1 global
 *   controls alone ........ 2×1 global
 *   nothing enabled ....... 1×1 global (explicit fallback tile)
 *
 * Returns `{ min, ideal }` (fresh objects — safe to mutate).
 */
export function minSizeForVariant(raw) {
  const o = normalizeOptions(raw);
  if (o.controls) return { min: { ...SIZE_WIDE }, ideal: { ...SIZE_BIG } };
  if (o.monitoring) {
    return o.icon
      ? { min: { ...SIZE_BIG }, ideal: { ...SIZE_BIG } }
      : { min: { ...SIZE_WIDE }, ideal: { ...SIZE_BIG } };
  }
  if (o.icon && o.label) return { min: { ...SIZE_WIDE }, ideal: { ...SIZE_WIDE } };
  if (o.icon && o.health) return { min: { ...SIZE_SQUARE }, ideal: { ...SIZE_WIDE } };
  if (o.label || o.health) return { min: { ...SIZE_WIDE }, ideal: { ...SIZE_WIDE } };
  return { min: { ...SIZE_SQUARE }, ideal: { ...SIZE_SQUARE } };
}

/** True when (w, h) — in internal cells — satisfy the variant's minimum size. */
export function sizeMeetsMin(raw, w, h) {
  const { min } = minSizeForVariant(raw);
  return Number(w) >= min.w && Number(h) >= min.h;
}

/** A button with completed geometry/options (never throws). */
export function normalizeButton(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof b.id === 'string' ? b.id : '',
    elementId: typeof b.elementId === 'string' ? b.elementId : '',
    col: clampInt(b.col, 0, 0, 100000),
    row: clampInt(b.row, 0, 0, 100000),
    w: clampInt(b.w, MIN_TILE_CELLS, MIN_TILE_CELLS, MAX_TILE_CELLS),
    h: clampInt(b.h, MIN_TILE_CELLS, MIN_TILE_CELLS, MAX_TILE_CELLS),
    options: normalizeOptions(b.options),
  };
}

/**
 * Build a button tile. `step` is the group's internal cell size in px (half a
 * global cell). Returns the tile element (grid placement is set inline so the
 * group's CSS grid slots it at its col/row/w/h).
 */
export function renderButtonTile({ button, element, step = 22.5 } = {}) {
  const b = normalizeButton(button);
  const o = b.options;
  const stepPx = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 22.5;
  const def = element && typeof element === 'object' ? element : null;
  const name = def ? String(def.name || '') : b.elementId ? 'Unknown element' : '';
  const iconValue = def ? String(def.icon || '') : '';
  const url = def && isValidHttpUrl(def.url) ? def.url : null;

  const hasIcon = o.icon && !!iconValue;
  const hasLabel = o.label && !!name;
  const hasHealth = o.health;
  const hasMonitoring = o.monitoring;
  const hasControls = o.controls;
  const hasContent = hasIcon || hasLabel || hasHealth || hasMonitoring;

  const flags = [];
  if (hasIcon) flags.push('icon');
  if (hasLabel) flags.push('label');
  if (hasHealth) flags.push('health');
  if (hasMonitoring) flags.push('monitoring');
  if (hasControls) flags.push('controls');
  const variant = flags.length ? flags.join('+') : 'empty';

  const root = el('div', 'group-tile', null, {
    'data-variant': variant,
    'data-size': `${b.w}x${b.h}`,
    'data-icon-size': o.iconSize,
    'data-element-id': b.elementId,
  });
  applyTileMetrics(root, b, stepPx);
  if (o.allowIconOverflow) root.classList.add('allow-overflow');

  const target = dockyTargetOf(def);
  let healthEl = null;
  let monitoring = null;
  let controls = null;

  /** Apply a resolved action result to the tile (optimistic update). */
  const applyActionResult = (res) => {
    if (!res) return;
    if (healthEl) {
      healthEl.dataset.state = res.health || 'unknown';
      healthEl.title = healthTitle(res.health, res.state, null);
    }
    controls?.update(res.state, { disabled: !res.state || res.state === 'unknown' });
  };

  const runTileAction = async (action) => {
    if (!target) return;
    controls?.setBusy(true);
    try {
      const res = await dockyApi.action(target.agent, target.container, action);
      const label = action.charAt(0).toUpperCase() + action.slice(1);
      if (res?.already) toast(`${label}: container is already in this state`, 'info');
      else toast(`${label}: ok`, 'success');
      applyActionResult(res);
      dockyPoller.refreshNow();
    } catch (err) {
      toast(err?.message || `${action} failed`, 'error');
    } finally {
      controls?.setBusy(false);
    }
  };

  // ---- main zone (the `shortcut` clickable area wraps the visible content) ---
  if (hasContent) {
    const clickable = o.shortcut && url;
    const main = clickable
      ? el('a', 'tile-main', null, { href: url, target: '_blank', rel: 'noopener noreferrer' })
      : el('div', 'tile-main');
    if (!clickable) main.classList.add('tile-main-static');

    if (hasIcon) {
      const iconBox = el('div', 'tile-icon');
      iconBox.appendChild(buildIconNode(iconValue, name));
      main.appendChild(iconBox);
    }
    if (hasLabel) main.appendChild(el('span', 'tile-label', name));
    if (hasMonitoring) {
      monitoring = buildMonitoring();
      main.appendChild(monitoring.el);
    }
    if (hasHealth) {
      healthEl = buildHealth();
      main.appendChild(healthEl);
    }

    root.appendChild(main);
  } else if (o.shortcut && url) {
    // Nothing to display but shortcut is on: keep a clickable (empty) zone.
    root.appendChild(
      el('a', 'tile-main tile-main-empty', null, {
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': name || 'Open link',
      })
    );
  }

  // ---- controls zone (second clickable area — live start/stop/restart) ------
  if (hasControls) {
    controls = buildControls({ onAction: runTileAction });
    root.appendChild(controls.el);
  }

  // ---- explicit "nothing enabled" fallback ---------------------------------
  if (!hasContent && !hasControls) root.appendChild(el('div', 'tile-empty', '—'));

  // ---- live Docky data wiring ----------------------------------------------
  // A small note is shown over degraded tiles (« Docky offline »), so the
  // degraded state is explicit even on a health-only tile.
  const offlineNote = el('span', 'tile-docky-note hidden', 'Docky offline');
  if (target) root.appendChild(offlineNote);

  let dispose = () => {};
  if (target && (hasHealth || hasMonitoring || hasControls)) {
    root.dataset.docky = 'pending';
    const apply = (data) => {
      const degraded = data?.degraded === true;
      const hres = data?.health || null;
      const sres = data?.stats || null;
      const failed = degraded || !!(hres?.error) || !!(sres?.error);
      const state = failed ? 'unknown' : hres?.state || 'unknown';
      const health = failed ? 'unknown' : hres?.health || 'unknown';
      root.dataset.docky = degraded
        ? 'offline'
        : failed
          ? 'error'
          : 'ok';
      offlineNote.classList.toggle('hidden', !degraded);
      if (healthEl) {
        healthEl.dataset.state = health;
        healthEl.title = healthTitle(health, state, hres);
      }
      if (monitoring) monitoring.update(failed ? null : sres, { degraded, error: hres?.error || sres?.error });
      if (controls) controls.update(state, { disabled: failed });
    };
    dispose = dockyPoller.register(target, apply);
  } else {
    root.dataset.docky = 'none';
    if (monitoring) monitoring.update(null, {});
    if (healthEl) healthEl.dataset.state = 'unknown';
  }

  return { el: root, dispose };
}

/**
 * Apply a button's LIVE grid geometry + icon metrics to an already-built tile.
 * Shared by renderButtonTile (initial paint) and lot 4's in-trame move/resize,
 * so a tile dragged or resized by half a global cell keeps its icon correctly
 * re-fitted instead of keeping the icon size computed for its old footprint.
 * Never throws; `step` is the group's internal cell size in px.
 */
export function applyTileMetrics(tileEl, rawButton, step = 22.5) {
  if (!tileEl) return;
  const b = normalizeButton(rawButton);
  const o = b.options;
  const stepPx = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 22.5;
  const wPx = b.w * stepPx;
  const hPx = b.h * stepPx;
  const iconPx = computeIconPx({
    wPx,
    hPx,
    hasLabel: o.label,
    hasMonitoring: o.monitoring,
    hasControls: o.controls,
    w: b.w,
    h: b.h,
    iconSize: o.iconSize,
  });
  tileEl.style.gridColumn = `${b.col + 1} / span ${b.w}`;
  tileEl.style.gridRow = `${b.row + 1} / span ${b.h}`;
  tileEl.dataset.size = `${b.w}x${b.h}`;
  tileEl.style.setProperty('--tile-icon-px', `${iconPx}px`);
  tileEl.style.setProperty('--tile-w-px', `${wPx}px`);
  tileEl.style.setProperty('--tile-h-px', `${hPx}px`);
}

// ---- pieces -----------------------------------------------------------------

/** Read a usable `{ agent, container }` target off a catalogue element. */
function dockyTargetOf(element) {
  const agent = element?.docky?.agent ? String(element.docky.agent).trim() : '';
  const container = element?.docky?.container ? String(element.docky.container).trim() : '';
  return agent && container ? { agent, container } : null;
}

/**
 * Live health dot. `data-state` drives the colour (healthy/unhealthy/starting/
 * none/unknown); a title explains the current state and any per-target error.
 */
function buildHealth() {
  const dot = el('span', 'tile-health', null, {
    title: 'Health unknown',
    'aria-label': 'Health unknown',
  });
  dot.dataset.state = 'unknown';
  return dot;
}

function healthTitle(health, state, result) {
  const label =
    { healthy: 'Healthy', unhealthy: 'Unhealthy', starting: 'Starting', none: 'No healthcheck', unknown: 'Unknown' }[
      health
    ] || 'Unknown';
  const statePart = state && state !== 'unknown' ? ` · ${state}` : '';
  const err = result?.error?.message ? ` — ${result.error.message}` : '';
  return `${label}${statePart}${err}`;
}

/**
 * CPU / RAM rows fed by the batched Docky stats. Without data (offline / no
 * target) every value reads « — ». Returns `{ el, update(stats, meta) }`.
 */
function buildMonitoring() {
  const wrap = el('div', 'tile-monitoring', null, { title: 'Monitoring' });
  wrap.dataset.state = 'unknown';
  const cpuValue = el('span', 'tile-metric-value', '—');
  const ramValue = el('span', 'tile-metric-value', '—');
  wrap.appendChild(metricRow('CPU', cpuValue));
  wrap.appendChild(metricRow('RAM', ramValue));

  const update = (stats, meta = {}) => {
    if (!stats) {
      cpuValue.textContent = '—';
      ramValue.textContent = '—';
      cpuValue.title = '';
      ramValue.title = '';
      wrap.dataset.state = 'unknown';
      wrap.title = meta.degraded
        ? 'Monitoring unavailable — Docky offline'
        : meta.error?.message
          ? `Monitoring unavailable — ${meta.error.message}`
          : 'Monitoring unavailable';
      return;
    }
    wrap.dataset.state = stats.state || 'unknown';
    cpuValue.textContent = stats.cpu_percent === null ? '—' : `${stats.cpu_percent.toFixed(1)}%`;
    ramValue.textContent = stats.mem_percent === null ? '—' : `${Math.round(stats.mem_percent)}%`;
    cpuValue.title = stats.cpu_count ? `${stats.cpu_count} CPUs` : '';
    ramValue.title =
      stats.mem_usage !== null
        ? `${formatBytes(stats.mem_usage)}${stats.mem_limit !== null ? ` / ${formatBytes(stats.mem_limit)}` : ''}`
        : '';
    wrap.title = 'CPU / RAM (Docky)';
  };

  return { el: wrap, update };
}

function metricRow(label, valueEl) {
  const row = el('div', 'tile-metric');
  row.appendChild(el('span', 'tile-metric-label', label));
  row.appendChild(valueEl);
  return row;
}

/** Readable byte size (binary units, 1 decimal beyond KiB). */
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Which controls are legal for a container state (contract §2.5). */
function controlAvailable(state, action) {
  switch (state) {
    case 'running':
      return action === 'stop' || action === 'restart';
    case 'paused':
      return action === 'stop' || action === 'restart';
    case 'exited':
    case 'created':
    case 'dead':
      return action === 'start';
    default:
      return false; // restarting / unknown
  }
}

/**
 * start / stop / restart with a 2-step confirmation (same armed pattern as the
 * deletion flows). Returns `{ el, update(state, meta), setBusy(bool) }`.
 * Buttons are disabled unless `controlAvailable(state, action)`.
 */
function buildControls({ onAction } = {}) {
  const wrap = el('div', 'tile-controls', null, {
    role: 'group',
    'aria-label': 'Container controls',
  });
  let currentState = 'unknown';
  let globallyDisabled = true; // no data yet → everything inert
  let busy = false;
  const items = [];

  const refreshDisabled = () => {
    for (const item of items) {
      const allowed = !globallyDisabled && !busy && controlAvailable(currentState, item.action);
      item.btn.disabled = !allowed;
      if (!allowed) item.disarm();
    }
  };

  for (const { action, glyph } of CONTROL_ACTIONS) {
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    const btn = el('button', `tile-control tile-control-${action}`, glyph, {
      type: 'button',
      title: `${label}`,
      'aria-label': label,
    });
    btn.disabled = true;

    const item = { action, btn, disarm: null };
    let armed = false;
    let timer = 0;
    const disarm = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
      armed = false;
      btn.classList.remove('armed');
      btn.textContent = glyph;
      btn.title = label;
    };
    item.disarm = disarm;

    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      if (armed) {
        disarm();
        onAction?.(action);
        return;
      }
      armed = true;
      btn.classList.add('armed');
      btn.textContent = '?';
      btn.title = `Click again to ${action}`;
      timer = setTimeout(disarm, 3000);
    });
    items.push(item);
    wrap.appendChild(btn);
  }

  return {
    el: wrap,
    update(state, meta = {}) {
      currentState = state || 'unknown';
      if (meta.disabled !== undefined) globallyDisabled = !!meta.disabled;
      refreshDisabled();
    },
    setBusy(value) {
      busy = !!value;
      refreshDisabled();
    },
  };
}

/**
 * Build the icon node for one of the supported sources: an http(s) image URL,
 * a vendored `holaf:<name>` feather icon (stroke = currentColor), an emoji /
 * short text, or the label's initials as a last resort.
 *
 * Exported so the catalogue screen (ui/elementsModal.js) renders the EXACT same
 * icon a tile would — no second, drifting icon-rendering path.
 */
export function buildIconNode(icon, label) {
  const value = (icon || '').trim();
  if (isValidHttpUrl(value)) {
    return el('img', 'tile-icon-img', null, { src: value, alt: '', loading: 'lazy' });
  }
  if (value.startsWith('local:')) {
    return buildLocalIcon(value.slice(6).trim(), label);
  }
  if (value.startsWith('holaf:')) {
    const name = value.slice(6).trim();
    const svgEl = svgElementFrom(safeHolafGet(name));
    if (svgEl) return svgEl;
    // Unknown `holaf:<name>`: fall back to the label initials — NEVER render the
    // raw `holaf:…` reference (a long string that overflowed tiny tiles).
    return el('span', 'tile-icon-text', initialsOf(label) || '?');
  }
  if (value) return el('span', 'tile-icon-text', value);
  return el('span', 'tile-icon-text', initialsOf(label) || '?');
}

/**
 * `local:<slug>` — an icon installed in the server-side icon library (§E). The
 * SVG is fetched ONCE through the JWT-protected API and INLINED (no public URL,
 * `currentColor` preserved so it follows the theme). A short-lived cache avoids
 * repeated requests when many tiles share the same icon; while loading (or if
 * the fetch fails) the node shows the label initials, so a tile NEVER breaks.
 */
function buildLocalIcon(slug, label) {
  const holder = el('span', 'tile-icon-local');
  holder.appendChild(el('span', 'tile-icon-text', initialsOf(label) || '?'));
  if (!slug) return holder;
  loadLocalIcon(slug).then((svg) => {
    if (!svg) return;
    const node = svgElementFrom(svg);
    if (node) holder.replaceChildren(node);
  });
  return holder;
}

const LOCAL_ICON_TTL_MS = 10 * 60 * 1000;
const localIconCache = new Map(); // slug -> { svg, expires }
const localIconInflight = new Map(); // slug -> Promise

/** Fetch (and cache) an installed icon's SVG text. Never rejects. */
function loadLocalIcon(slug) {
  const cached = localIconCache.get(slug);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.svg);
  const inflight = localIconInflight.get(slug);
  if (inflight) return inflight;
  const p = api
    .getText(`/api/icons/${encodeURIComponent(slug)}/svg`)
    .then((svg) => {
      if (typeof svg === 'string' && svg.trim()) {
        localIconCache.set(slug, { svg, expires: Date.now() + LOCAL_ICON_TTL_MS });
        return svg;
      }
      return null;
    })
    .catch((err) => {
      console.warn('[icons] failed to load local icon:', slug, err?.message || err);
      return null;
    })
    .finally(() => localIconInflight.delete(slug));
  localIconInflight.set(slug, p);
  return p;
}

/** Drop the local-icon cache (logout / instance switch). */
export function clearLocalIconCache() {
  localIconCache.clear();
  localIconInflight.clear();
}

/** Parse SVG text into an importable, host-box-fit <svg> node, or null when
 * unusable. Exported so the icon-library previews (ui/iconsPicker.js) inline
 * the SAME normalized node a tile renders. */
export function svgElementFrom(svgText) {
  if (typeof svgText !== 'string' || !svgText.trim()) return null;
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (svgEl?.nodeName === 'svg' && !doc.querySelector('parsererror')) {
      return normalizeSvgNode(document.importNode(svgEl, true));
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Make an imported SVG render EXACTLY inside its host box, whatever the
 * source's intrinsic sizing:
 *   - drop the `width`/`height` presentation attributes. Iconify ships
 *     `width="1em" height="1em"`, which resolves against the HOST element's
 *     font-size — a fragile, font-dependent viewport we do not control. With
 *     the attributes gone the CSS (`width/height:100%` on `.tile-icon svg` /
 *     `.tile-icon-local svg`) is the single sizing authority.
 *   - guarantee a `viewBox` (derived from a numeric width/height when absent)
 *     so the drawing scales instead of being drawn 1:1 and cropped.
 *   - force an explicit `preserveAspectRatio="xMidYMid meet"` so a glyph whose
 *     design box differs from the host box is letterboxed, never stretched nor
 *     cropped.
 *   - mark it `aria-hidden`/`focusable="false"` (purely decorative icon).
 * Idempotent; never throws (a missing attribute is simply skipped).
 */
function normalizeSvgNode(svg) {
  const w = svg.getAttribute('width');
  const h = svg.getAttribute('height');
  if (!svg.getAttribute('viewBox') && w && h) {
    const nw = parseFloat(w);
    const nh = parseFloat(h);
    if (Number.isFinite(nw) && nw > 0 && Number.isFinite(nh) && nh > 0) {
      svg.setAttribute('viewBox', `0 0 ${nw} ${nh}`);
    }
  }
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  if (!svg.getAttribute('preserveAspectRatio')) {
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/** Tolerant wrapper around the vendored HolafIcons.get (throws on unknown). */
function safeHolafGet(name) {
  try {
    return HolafIcons.get(name);
  } catch {
    return null;
  }
}

// Tile chrome consumed by the box model. MUST mirror style.css (per side):
//   .group-tile  border 1px + padding 3px
//   .tile-main   padding 2px
// = 12px total. The icon is sized from the tile's TRUE content box, so the
// computed size always matches the box the glyph is painted into — without
// relying on `.tile-icon`'s max-width/height clamp (which used to hide the
// 4px of `.tile-main` padding and left the Fill crank 4px too big, clipped as
// soon as `allowIconOverflow` lifted that clamp).
const TILE_CHROME = 12;
// Space (px) reserved for a sibling block so the icon never crowds it out of
// the tile — the compact-typography guard of roadmap §A.7.
const LABEL_RESERVE = 15;
const MONITORING_RESERVE = 32;
const CONTROLS_RESERVE = 28;

/**
 * Icon edge (px) for the tile's AVAILABLE space: the smaller of the two usable
 * dimensions once the tile chrome and any sibling block (label / monitoring /
 * controls) are subtracted. Sizing the icon from the raw tile edge (the lot-2
 * behaviour) let a large emoji spill out of a small tile onto its neighbours;
 * sizing it from the real leftover space keeps every variant inside its box.
 */
function computeIconPx({ wPx, hPx, hasLabel, hasMonitoring, hasControls, w, h, iconSize }) {
  const rowLayout = w > h; // mirrors .group-tile[data-size='4x2'] .tile-main
  let availW = Math.max(0, wPx - TILE_CHROME);
  let availH = Math.max(0, hPx - TILE_CHROME);
  if (hasLabel) {
    if (rowLayout) availW -= LABEL_RESERVE;
    else availH -= LABEL_RESERVE;
  }
  if (hasMonitoring) availH -= MONITORING_RESERVE;
  if (hasControls) availH -= CONTROLS_RESERVE;
  const base = Math.max(1, Math.min(availW, availH));
  return Math.round(base * (ICON_FRACTION[iconSize] ?? ICON_FRACTION[ICON_SIZE_DEFAULT]));
}

function initialsOf(label) {
  return (label || '')
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function clampInt(value, min, fallback, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
