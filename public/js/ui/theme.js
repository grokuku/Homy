import { api } from '../api.js';
import { HolafTokens } from '../../vendor/holaf/holaf-tokens.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { HolafToast } from '../../vendor/holaf/holaf-toast.js';
import { HolafColor } from '../../vendor/holaf/holaf-color.js';

/**
 * Theme management (lot 3).
 *
 * INTEGRATION CHOICE — holaf-tokens (vendored 0.1.0): ALIASING.
 * The brick is the only Holaf brick allowed to write CSS variables on :root,
 * under its reserved `--holaf-*` prefix. Homy's style.css therefore ALIASES its
 * own tokens to the brick's vars with Homy fallbacks:
 *     --bg: var(--holaf-surface, #0f1115); …
 * The palette itself is applied at runtime through the brick's registry API
 * (`HolafTokens.setTokens({ name, values })`) with two named palettes,
 * 'homy' (dark — the historical Homy palette) and 'homy-light' (derived, hover
 * variants computed with HolafColor.mix). This avoids the identified conflict:
 * the brick auto-applies its own dark/light preset on load (prefers-color-scheme)
 * — but because this module is imported in the same ES-module evaluation job
 * right after the brick, we synchronously override with the Homy palette before
 * any paint can happen. Before JS runs (login view, first paint), the mirrored
 * `data-theme` attribute + the CSS fallbacks in style.css ([data-theme="light"])
 * already give the correct palette — no flash, no JS dependency.
 *
 * The HolafModal / HolafToast registries get matching 'homy' / 'homy-light'
 * themes and `setTheme` is replayed on every switch so open modals and toasts
 * follow the page palette.
 *
 * `data-theme` on <html> is the user-facing state: set pre-CSS by the inline
 * script in index.html (localStorage mirror 'homy-theme'), then refreshed from
 * the server settings (source of truth) once authenticated.
 */

export const THEMES = ['dark', 'light'];
export const STORAGE_KEY = 'homy-theme';

const HOLAF_THEME = { dark: 'homy', light: 'homy-light' };

// ── Base palettes ─────────────────────────────────────────────────────────────
// Values MUST mirror the CSS fallbacks in public/css/style.css (:root and
// [data-theme="light"]) — keep both in sync (no build step to enforce it).
// accent-hover / danger-hover are derived with HolafColor (mix with surface).
const BASE_PALETTES = {
  dark: {
    surface: '#0f1115',
    'surface-elev': '#171a21',
    'surface-raised': '#1f232c',
    border: '#2a2f3a',
    text: '#e6e8ee',
    'text-muted': '#9aa1ad',
    accent: '#4f8cff',
    'accent-hover': '#3b78e8',
    'accent-text': '#ffffff',
    danger: '#e5484d',
    'danger-text': '#ffffff',
    radius: '10px',
    shadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
    overlay: 'rgba(0, 0, 0, 0.55)',
    'btn-hover': '#262b36',
  },
  light: {
    surface: '#eef1f6',
    'surface-elev': '#f7f9fc',
    'surface-raised': '#ffffff',
    border: '#d7dce5',
    text: '#1a2233',
    'text-muted': '#5b6472',
    accent: '#2f6fe4',
    'accent-text': '#ffffff',
    danger: '#d33b40',
    'danger-text': '#ffffff',
    radius: '10px',
    shadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
    overlay: 'rgba(15, 23, 42, 0.35)',
    'btn-hover': '#e3e8f2',
  },
};

// Surface translucency for widgets when a background is active is NOT part of
// the palette: it is structural (body[data-bg-active] { --surface-alpha: 80% })
// and lives in style.css only.

/** Full Holaf palette for a theme, with derived hover variants (HolafColor). */
function buildPalette(theme) {
  const base = BASE_PALETTES[theme];
  return {
    ...base,
    'accent-hover': base['accent-hover'] || HolafColor.mix(base.accent, base.surface, 0.15),
    'danger-hover': HolafColor.mix(base.danger, base.surface, 0.2),
  };
}

// ── HolafModal / HolafToast themes derived from the same palettes ────────────
function modalVars(p, theme) {
  return {
    '--hm-bg': p['surface-elev'],
    '--hm-bg-secondary': p['surface-raised'],
    '--hm-bg-input': p['surface-raised'],
    '--hm-text': p.text,
    '--hm-text-secondary': p['text-muted'],
    '--hm-border': p.border,
    '--hm-accent': p.accent,
    '--hm-accent-hover': p['accent-hover'],
    '--hm-accent-text': p['accent-text'],
    '--hm-danger': p.danger,
    '--hm-danger-hover': p['danger-hover'],
    '--hm-danger-text': p['danger-text'],
    '--hm-radius': p.radius,
    '--hm-overlay-bg': p.overlay,
    '--hm-font-size': '14px',
    '--hm-shadow': p.shadow,
    '--hm-busy-bg': theme === 'dark' ? 'rgba(23, 26, 33, 0.85)' : 'rgba(247, 249, 252, 0.85)',
  };
}

function toastVars(p, theme) {
  const isDark = theme === 'dark';
  return {
    '--ht-bg': p['surface-elev'],
    '--ht-bg-success': isDark ? '#1c2a22' : '#dcebe1',
    '--ht-bg-warning': isDark ? '#2b2416' : '#f6ecd9',
    '--ht-bg-error': isDark ? '#2b1c1d' : '#fbe3e4',
    '--ht-fg': p.text,
    '--ht-border': p.border,
    '--ht-accent-info': p.accent,
    '--ht-accent-success': isDark ? '#2e9e5b' : '#1f7a44',
    '--ht-accent-warning': isDark ? '#e0a030' : '#b45309',
    '--ht-accent-error': p.danger,
    '--ht-shadow': p.shadow,
    '--ht-radius': p.radius,
  };
}

// ── State ────────────────────────────────────────────────────────────────────
let current = 'dark';

function registerBrickThemes() {
  for (const t of THEMES) {
    const p = buildPalette(t);
    HolafModal.themes.register(HOLAF_THEME[t], modalVars(p, t));
    HolafToast.themes.register(HOLAF_THEME[t], toastVars(p, t));
  }
}

/**
 * Apply a theme everywhere: <html data-theme>, HolafTokens palette (--holaf-*),
 * HolafModal + HolafToast global themes, localStorage mirror.
 */
function apply(theme) {
  const t = THEMES.includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = t;
  HolafTokens.setTokens({ name: HOLAF_THEME[t], values: buildPalette(t) });
  HolafModal.setTheme(HOLAF_THEME[t]);
  HolafToast.setTheme(HOLAF_THEME[t]);
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* private mode etc. */
  }
  current = t;
}

// Register once, then apply the theme chosen by the inline <head> script
// (localStorage mirror). Runs synchronously in the same ES-module evaluation
// job as the holaf-tokens brick — no intermediate paint, no auto-preset flash.
registerBrickThemes();
apply(document.documentElement.dataset.theme || 'dark');

export function getTheme() {
  return current;
}

export function otherTheme() {
  return current === 'dark' ? 'light' : 'dark';
}

/**
 * Server is the source of truth once authenticated: refresh the local mirror
 * with the persisted theme (no server call here — caller fetched settings).
 */
export function syncFromServer(theme) {
  apply(theme);
}

/**
 * User-initiated switch: apply immediately, then persist via PUT /api/settings.
 * Returns true on success; on failure reverts to `previous` and returns false.
 */
export async function switchTheme(theme, background, previous) {
  apply(theme);
  try {
    await api.put('/api/settings', { theme, background });
    return true;
  } catch (err) {
    apply(previous);
    throw err;
  }
}