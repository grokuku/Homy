import { frame } from './frame.js';
import { shortcut } from './shortcut.js';
import { clock } from './clock.js';
import { iframe } from './iframe.js';
import { links } from './links.js';
import { search } from './search.js';
import { notes } from './notes.js';
import { weather } from './weather.js';
import { el } from '../util.js';

/**
 * Widget type registry. Each entry: { name, icon, category, defaultSize,
 * settingsSchema, render }. `render(container, config, item)` renders content
 * and may return a cleanup fn. `settingsSchema` drives the generic config modal.
 */
export const registry = {
  frame,
  shortcut,
  clock,
  iframe,
  links,
  search,
  notes,
  weather,
};

/**
 * ⚠️ APPEARANCE_FIELDS — shared per-widget appearance section, merged into
 * EVERY widget's settingsSchema via getSettingsSchema() below. MUST stay in
 * sync with the identical constant in server/routes/widgets.routes.js. Any
 * change here must be mirrored there, and vice-versa.
 */
export const APPEARANCE_FIELDS = [
  { key: 'bgColor', label: 'Background color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
  { key: 'bgOpacity', label: 'Background opacity', type: 'range', default: 100, min: 0, max: 100, step: 1, unit: '%', help: 'Requires a background color' },
  { key: 'borderColor', label: 'Border color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
  { key: 'showBorder', label: 'Show border', type: 'toggle', default: true, help: 'Hide to remove this widget\u2019s frame border' },
  { key: 'textColor', label: 'Text color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
];

export function getWidget(type) {
  return registry[type] || null;
}

export function getDefaultSize(type) {
  return getWidget(type)?.defaultSize || { w: 11, h: 3 }; // 11×3 = legacy 4×3 fallback, rescaled ×32/12
}

export function getSettingsSchema(type) {
  const base = getWidget(type)?.settingsSchema || { fields: [] };
  return {
    ...base,
    fields: [...(base.fields || []), ...APPEARANCE_FIELDS],
  };
}

/**
 * Apply per-widget appearance (bgColor/bgOpacity/borderColor/showBorder/
 * textColor) via inline CSS custom properties on the widget container. Called
 * from renderWidget() so it runs on every render (initial, config save,
 * view/edit switch, page reload). Always resets the 5 vars first because the
 * container element persists between re-renders — without a reset a previously
 * applied custom style would linger after the config is cleared.
 *
 * Lot 3: when the user set a bgColor, the per-widget appearance is ALWAYS
 * authoritative — --widget-bg-op is set for any finite bgOpacity (including
 * 100%) so a translucent global surface (--surface-alpha, active when a
 * dashboard background is set) never overrides an explicit widget opacity.
 */
export function applyAppearance(container, config) {
  const c = config || {};
  const bgColor = (c.bgColor || '').trim();
  const bgOpacity = Number(c.bgOpacity);
  const borderColor = (c.borderColor || '').trim();
  const textColor = (c.textColor || '').trim();
  // Border visibility is opt-OUT: legacy configs have no key at all and must
  // keep the current theme border. Only an explicit false (or the string
  // "false" from a hand-edited config) zeroes the width.
  const borderHidden = c.showBorder === false || c.showBorder === 'false';

  // Reset all 5 vars first (container persists between re-renders).
  container.style.removeProperty('--widget-bg-color');
  container.style.removeProperty('--widget-bg-op');
  container.style.removeProperty('--widget-border-color');
  container.style.removeProperty('--widget-border-width');
  container.style.removeProperty('--widget-text-color');

  if (bgColor) {
    container.style.setProperty('--widget-bg-color', bgColor);
    // Opacity only applies when a background color is set. Any finite value
    // (100 included) is applied explicitly so it keeps priority over the
    // global --surface-alpha token.
    if (Number.isFinite(bgOpacity)) {
      container.style.setProperty('--widget-bg-op', `${Math.max(0, Math.min(100, bgOpacity))}%`);
    }
  }
  if (borderColor) container.style.setProperty('--widget-border-color', borderColor);
  // When hidden, force the border width to 0. The CSS keeps
  // var(--widget-border-width, 1px) as the fallback so a widget without the
  // setting (or with it on) is unchanged.
  if (borderHidden) container.style.setProperty('--widget-border-width', '0');
  if (textColor) container.style.setProperty('--widget-text-color', textColor);
}

/**
 * Render a widget into a container. Clears the container first (safe: we
 * control the container, no user data is cleared via innerHTML). Runs the
 * previous cleanup (if any) before re-rendering so timers/RAF loops from an
 * earlier render never leak. Returns an optional cleanup function.
 */
const cleanups = new WeakMap(); // container -> cleanup fn returned by a widget render

export function renderWidget(container, item) {
  disposeWidget(container);
  // Clear the container before re-rendering: gridstack seeds
  // .grid-stack-item-content via its default renderCB (textContent = content),
  // and re-renders (config save, view/edit switch) must not stack stale DOM on
  // top of the previous render. We own this container, so nothing user-owned is
  // lost by clearing it.
  container.replaceChildren();
  applyAppearance(container, item?.config || {});
  const w = getWidget(item?.type);
  if (!w) {
    container.appendChild(el('p', 'muted', `Unknown widget: ${item?.type || '?'}`));
    return null;
  }
  const cleanup = w.render(container, item?.config || {}, item);
  if (typeof cleanup === 'function') cleanups.set(container, cleanup);
  else cleanups.delete(container);
  return cleanup;
}

/**
 * Run (and drop) the cleanup fn associated with a container, if any. Call this
 * on every destroy path (grid destroy, widget removal, container teardown) so
 * widget timers (clock/weather interval, preview RAF loops, …) never leak.
 */
export function disposeWidget(container) {
  if (!container) return;
  const cleanup = cleanups.get(container);
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (err) {
      console.error('[widget] cleanup failed:', err);
    }
  }
  cleanups.delete(container);
}
