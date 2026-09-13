import { el, isValidHttpUrl } from '../util.js';
import { api } from '../api.js';
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
 *   - health            → a status dot (DEGRADED: grey — Docky is not wired yet);
 *   - monitoring        → CPU / RAM rows (DEGRADED: « — » — Docky not wired yet);
 *   - controls          → a SECOND clickable zone (start/stop/restart) — DEGRADED:
 *                         every control is DISABLED/inert (no action, no request);
 *   - iconSize          → S | M | L | XL | Fill = 40/55/70/85/100 % of the tile's
 *                         useful internal dimension (min side), see ICON_FRACTION;
 *   - allowIconOverflow → advanced, default OFF: lets the icon spill outside the
 *                         tile box instead of being clipped.
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
    if (hasMonitoring) main.appendChild(buildMonitoring());
    if (hasHealth) main.appendChild(buildHealth());

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

  // ---- controls zone (second clickable area — DEGRADED: inert buttons) ------
  if (hasControls) root.appendChild(buildControls());

  // ---- explicit "nothing enabled" fallback ---------------------------------
  if (!hasContent && !hasControls) root.appendChild(el('div', 'tile-empty', '—'));

  return root;
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

/**
 * Health dot. DEGRADED state: Docky is not connected yet, so the state is
 * UNKNOWN — rendered as a grey, non-animated dot (never green/red).
 */
function buildHealth() {
  const dot = el('span', 'tile-health', null, {
    title: 'Health unavailable (Docky not connected)',
    'aria-label': 'Health unknown',
  });
  dot.dataset.state = 'unknown';
  return dot;
}

/** CPU / RAM rows. DEGRADED state: values are « — » until Docky is wired. */
function buildMonitoring() {
  const wrap = el('div', 'tile-monitoring', null, {
    title: 'Monitoring unavailable (Docky not connected)',
  });
  wrap.dataset.state = 'unknown';
  wrap.appendChild(metricRow('CPU'));
  wrap.appendChild(metricRow('RAM'));
  return wrap;
}

function metricRow(label) {
  const row = el('div', 'tile-metric');
  row.appendChild(el('span', 'tile-metric-label', label));
  row.appendChild(el('span', 'tile-metric-value', '—'));
  return row;
}

/**
 * start / stop / restart. DEGRADED: every control is DISABLED — no listener is
 * attached, so no action can ever fire (the real 2-time confirmation lands in
 * lot 5 with the Docky proxy).
 */
function buildControls() {
  const wrap = el('div', 'tile-controls', null, {
    role: 'group',
    'aria-label': 'Container controls (unavailable)',
  });
  for (const { action, glyph } of CONTROL_ACTIONS) {
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    const btn = el('button', `tile-control tile-control-${action}`, glyph, {
      type: 'button',
      title: `${label} (unavailable)`,
      'aria-label': label,
      disabled: '',
    });
    btn.disabled = true;
    wrap.appendChild(btn);
  }
  return wrap;
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

/** Parse SVG text into an importable <svg> node, or null when unusable. */
function svgElementFrom(svgText) {
  if (typeof svgText !== 'string' || !svgText.trim()) return null;
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (svgEl?.nodeName === 'svg' && !doc.querySelector('parsererror')) {
      return document.importNode(svgEl, true);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Tolerant wrapper around the vendored HolafIcons.get (throws on unknown). */
function safeHolafGet(name) {
  try {
    return HolafIcons.get(name);
  } catch {
    return null;
  }
}

// Tile chrome consumed by the box model (border 1px + padding 3px, per side =
// 8px total — MUST mirror .group-tile in style.css).
const TILE_CHROME = 8;
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
