import { el, isValidHttpUrl } from '../util.js';
import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { dockyApi, dockyPoller } from '../docky/docky.js';
import { healthUrlPoller } from '../health/health.js';
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
 *   - iconSize          → a PERCENTAGE (8..120, step 0.5, default 55) of the
 *                         tile's useful internal dimension (min side). The legacy
 *                         S | M | L | XL | Fill crans are still accepted and
 *                         coerced to 40/55/70/85/100 (see ICON_SIZE_PRESETS);
 *   - labelPosition     → bottom | top | left | right (default bottom): where the
 *                         label sits relative to the icon;
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

// Icon size is a PERCENTAGE of the tile's useful internal dimension (its
// smaller usable side), adjustable by a 0.5 step. The historical S/M/L/XL/Fill
// crans are kept as accepted aliases (coerced to their percentage) so buttons
// stored before this option became a percentage keep working.
export const ICON_SIZE_MIN = 8;
export const ICON_SIZE_MAX = 120;
export const ICON_SIZE_DEFAULT = 55;
export const ICON_SIZE_STEP = 0.5;
export const ICON_SIZE_PRESETS = { S: 40, M: 55, L: 70, XL: 85, Fill: 100 };
// Legacy letter list — still exported for back-compat with older callers.
export const ICON_SIZES = ['S', 'M', 'L', 'XL', 'Fill'];

// Label placement crans (relative to the icon).
export const LABEL_POSITIONS = ['bottom', 'top', 'left', 'right'];
export const LABEL_POSITION_DEFAULT = 'bottom';

/**
 * Coerce an icon size to a percentage in [8,120], rounded to the 0.5 step.
 * Accepts a finite number, a numeric string, or a legacy letter
 * (S/M/L/XL/Fill → 40/55/70/85/100). Anything else falls back to 55 (never
 * throws), so a hand-edited / legacy value can never break a render.
 */
export function normalizeIconSize(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return clampIconSize(raw);
  if (typeof raw === 'string') {
    const key = raw.trim();
    if (Object.prototype.hasOwnProperty.call(ICON_SIZE_PRESETS, key)) return ICON_SIZE_PRESETS[key];
    if (key) {
      const n = Number(key);
      if (Number.isFinite(n)) return clampIconSize(n);
    }
  }
  return ICON_SIZE_DEFAULT;
}

function clampIconSize(n) {
  const stepped = Math.round(n / ICON_SIZE_STEP) * ICON_SIZE_STEP;
  return Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, stepped));
}

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
    iconSize: normalizeIconSize(o.iconSize),
    labelPosition: LABEL_POSITIONS.includes(o.labelPosition) ? o.labelPosition : LABEL_POSITION_DEFAULT,
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
 *   icon + label .......... 1×1 min · 2×1 ideal (label may sit under/over/beside)
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
  if (o.icon && o.label) return { min: { ...SIZE_SQUARE }, ideal: { ...SIZE_WIDE } };
  if (o.icon && o.health) return { min: { ...SIZE_SQUARE }, ideal: { ...SIZE_WIDE } };
  // Label alone (or health alone) still fits a 1×1: the label truncates.
  if (o.label) return { min: { ...SIZE_SQUARE }, ideal: { ...SIZE_WIDE } };
  if (o.health) return { min: { ...SIZE_WIDE }, ideal: { ...SIZE_WIDE } };
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
    'data-icon-size': String(o.iconSize),
    'data-label-pos': o.labelPosition,
    'data-element-id': b.elementId,
  });
  applyTileMetrics(root, b, stepPx);
  if (o.allowIconOverflow) root.classList.add('allow-overflow');

  const target = dockyTargetOf(def);
  const healthUrl = healthUrlOf(def);
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

    // Icon + label are wrapped in a `.tile-core` box so the LABEL POSITION
    // (bottom/top/left/right) can flip their axis WITHOUT moving the sibling
    // monitoring / health blocks, which stay stacked under the core.
    if (hasIcon || hasLabel) {
      const core = el('div', 'tile-core');
      if (hasIcon) {
        const iconBox = el('div', 'tile-icon');
        iconBox.appendChild(buildIconNode(iconValue, name));
        core.appendChild(iconBox);
      }
      if (hasLabel) core.appendChild(el('span', 'tile-label', name));
      main.appendChild(core);
    }
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

  // ---- live health data wiring --------------------------------------------
  // Two independent sources, resolved from the element contract:
  //   healthUrl set  → the health pill comes from the custom HTTP probe;
  //   else docky set → the health pill comes from Docky (which also feeds
  //                    monitoring + controls);
  //   else           → grey/unknown.
  // A Docky target is still subscribed when monitoring/controls are shown even
  // if the pill is URL-sourced, so those keep working.
  const offlineNote = el('span', 'tile-docky-note hidden', 'Docky offline');
  if (target) root.appendChild(offlineNote);

  const disposers = [];
  const dockyFeedsHealth = !healthUrl;
  const useDocky = !!target && (hasMonitoring || hasControls || (hasHealth && dockyFeedsHealth));
  if (useDocky) {
    root.dataset.docky = 'pending';
    const apply = (data) => {
      const degraded = data?.degraded === true;
      const hres = data?.health || null;
      const sres = data?.stats || null;
      const failed = degraded || !!(hres?.error) || !!(sres?.error);
      const state = failed ? 'unknown' : hres?.state || 'unknown';
      const health = failed ? 'unknown' : hres?.health || 'unknown';
      root.dataset.docky = degraded ? 'offline' : failed ? 'error' : 'ok';
      offlineNote.classList.toggle('hidden', !degraded);
      if (healthEl && dockyFeedsHealth) {
        healthEl.dataset.state = health;
        healthEl.title = healthTitle(health, state, hres);
      }
      if (monitoring) monitoring.update(failed ? null : sres, { degraded, error: hres?.error || sres?.error });
      if (controls) controls.update(state, { disabled: failed });
    };
    disposers.push(dockyPoller.register(target, apply));
  } else {
    root.dataset.docky = 'none';
    if (monitoring) monitoring.update(null, {});
  }

  if (healthUrl && hasHealth) {
    root.dataset.healthUrl = 'pending';
    const applyUrl = (data) => {
      if (!healthEl) return;
      const state = data?.state || 'unknown';
      healthEl.dataset.state = state;
      healthEl.title = urlHealthTitle(state, data);
      root.dataset.healthUrl = state;
    };
    disposers.push(healthUrlPoller.registerUrl(healthUrl, applyUrl));
  } else if (healthEl && !useDocky) {
    // Health pill requested but NO usable source: stay grey.
    healthEl.dataset.state = 'unknown';
  }

  const dispose = () => {
    for (const fn of disposers) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };

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
    labelPosition: o.labelPosition,
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

/** Read a usable custom health URL off a catalogue element (valid http(s)). */
function healthUrlOf(element) {
  const value = element?.healthUrl ? String(element.healthUrl).trim() : '';
  return isValidHttpUrl(value) ? value : null;
}

/**
 * Live health dot. `data-state` drives the colour (healthy/unhealthy/degraded/
 * starting/none/unknown); a title explains the current state and any error.
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

/** Title for a custom-URL probe result (state + HTTP status / error code). */
function urlHealthTitle(state, data) {
  const label =
    { healthy: 'Healthy', unhealthy: 'Unhealthy', degraded: 'Unreachable', unknown: 'Unknown' }[state] ||
    'Unknown';
  const statusPart = data?.status ? ` · HTTP ${data.status}` : '';
  const err = data?.error && state !== 'healthy' ? ` — ${data.error}` : '';
  return `${label}${statusPart}${err}`;
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
    if (svgEl) {
      scheduleSvgInkFit(svgEl);
      return svgEl;
    }
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
    if (node) {
      holder.replaceChildren(node);
      scheduleSvgInkFit(node);
    }
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

/**
 * Schedule a post-insertion INK FIT of an inline SVG. `normalizeSvgNode`
 * guarantees a viewBox and `preserveAspectRatio="xMidYMid meet"`, but it does
 * NOT guarantee that the viewBox actually CONTAINS the drawing: many real
 * icons (and any custom one) draw right up to — or slightly past — the viewBox
 * boundary, and a stroke is always painted half OUTSIDE the path geometry. The
 * browser clips an inline SVG's paint to its viewport (the host box), so such a
 * glyph came out visibly truncated (typically the bottom/edges shaved) even
 * though the source drawing was complete.
 *
 * The fix must be measured AFTER the node is connected (getBBox needs layout),
 * so this defers to the next frame and never throws on a detached node.
 */
function scheduleSvgInkFit(svg) {
  if (!svg) return;
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    try {
      fitSvgInkToViewport(svg);
    } catch {
      /* purely cosmetic hardening — never break a tile over it */
    }
  });
}

/**
 * Expand (NEVER shrink) an inline SVG's `viewBox` so the WHOLE painted artwork
 * sits inside the rendered viewport with a small safety margin. Only icons
 * whose ink (including stroke) spills outside their declared viewBox are
 * touched — a glyph that already has internal margins keeps its exact
 * viewBox/aspect, so shipped icons do not drift.
 *
 *  - geometry: `getBBox()` gives the fill/geometry box in viewBox user units;
 *  - stroke: unions a half-stroke-width margin for every stroked descendant
 *    (a centered stroke paints w/2 outside the path);
 *  - pad: a 2 % safety inset so a drawing that touches the boundary is never
 *    shaved by anti-aliasing / sub-pixel rounding.
 */
function fitSvgInkToViewport(svg) {
  if (!svg || !svg.isConnected) return;
  let bb = null;
  try {
    bb = svg.getBBox();
  } catch {
    return; // not rendered yet (display:none / detached subtree)
  }
  if (!bb || !(bb.width > 0) || !(bb.height > 0)) return;

  const stroke = maxStrokeWidth(svg) / 2;
  const pad = Math.max(bb.width, bb.height) * SVG_INK_PAD;
  const margin = stroke + pad;
  const ink = {
    x: bb.x - margin,
    y: bb.y - margin,
    w: bb.width + margin * 2,
    h: bb.height + margin * 2,
  };

  const cur = readViewBox(svg);
  if (!cur) {
    svg.setAttribute('viewBox', `${round3(ink.x)} ${round3(ink.y)} ${round3(ink.w)} ${round3(ink.h)}`);
    return;
  }
  // Union the declared viewBox with the ink box: the viewBox may only grow.
  const x0 = Math.min(cur.x, ink.x);
  const y0 = Math.min(cur.y, ink.y);
  const x1 = Math.max(cur.x + cur.w, ink.x + ink.w);
  const y1 = Math.max(cur.y + cur.h, ink.y + ink.h);
  const next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const moved =
    Math.abs(next.x - cur.x) > 1e-3 ||
    Math.abs(next.y - cur.y) > 1e-3 ||
    Math.abs(next.w - cur.w) > 1e-3 ||
    Math.abs(next.h - cur.h) > 1e-3;
  if (moved) {
    svg.setAttribute('viewBox', `${round3(next.x)} ${round3(next.y)} ${round3(next.w)} ${round3(next.h)}`);
  }
}

// Safety inset (fraction of the ink's larger side) added around the drawing.
const SVG_INK_PAD = 0.02;

/** Parse an SVG's `viewBox` into a positive-size box, or null when absent/bad. */
function readViewBox(svg) {
  const raw = svg.getAttribute('viewBox');
  if (!raw) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [x, y, w, h] = parts;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

/** Largest computed `stroke-width` among an SVG's stroked descendants (0 when
 * none). Strokes may be declared on the root and inherited, so descendants are
 * read through `getComputedStyle` (which resolves inheritance). */
function maxStrokeWidth(svg) {
  let max = 0;
  for (const node of svg.querySelectorAll('*')) {
    let cs;
    try {
      cs = getComputedStyle(node);
    } catch {
      continue;
    }
    if (!cs || !cs.stroke || cs.stroke === 'none') continue;
    const sw = parseFloat(cs.strokeWidth);
    if (Number.isFinite(sw) && sw > max) max = sw;
  }
  return max;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
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
 * controls) are subtracted. The icon is sized from the real leftover space so a
 * large emoji can never spill out of a small tile onto its neighbours.
 *
 * `labelPosition` decides which axis the label consumes: top/bottom subtract a
 * height reserve, left/right a width reserve. `iconSize` is a percentage of the
 * resulting base (0.5-step, 8..120) — kept to 2 decimals so two adjacent slider
 * crans (e.g. 40 and 40.5) genuinely differ.
 */
function computeIconPx({ wPx, hPx, hasLabel, hasMonitoring, hasControls, labelPosition, iconSize }) {
  let availW = Math.max(0, wPx - TILE_CHROME);
  let availH = Math.max(0, hPx - TILE_CHROME);
  if (hasLabel) {
    if (labelPosition === 'left' || labelPosition === 'right') availW -= LABEL_RESERVE;
    else availH -= LABEL_RESERVE;
  }
  if (hasMonitoring) availH -= MONITORING_RESERVE;
  if (hasControls) availH -= CONTROLS_RESERVE;
  const base = Math.max(1, Math.min(availW, availH));
  const pct = normalizeIconSize(iconSize);
  return Math.max(1, Math.round(base * pct) / 100);
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
