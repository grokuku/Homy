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
  { key: 'bgOpacity', label: 'Background opacity (%)', type: 'number', default: 100, min: 0, max: 100, step: 1, help: 'Requires a background color' },
  { key: 'borderColor', label: 'Border color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
  { key: 'textColor', label: 'Text color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
];

export function getWidget(type) {
  return registry[type] || null;
}

export function getDefaultSize(type) {
  return getWidget(type)?.defaultSize || { w: 4, h: 3 };
}

export function getSettingsSchema(type) {
  const base = getWidget(type)?.settingsSchema || { fields: [] };
  return {
    ...base,
    fields: [...(base.fields || []), ...APPEARANCE_FIELDS],
  };
}

/**
 * Apply per-widget appearance (bgColor/bgOpacity/borderColor/textColor) via
 * inline CSS custom properties on the widget container. Called from
 * renderWidget() so it runs on every render (initial, config save, view/edit
 * switch, page reload). Always resets the 4 vars first because the container
 * element persists between re-renders — without a reset a previously applied
 * custom style would linger after the config is cleared.
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

  // Reset all 4 vars first (container persists between re-renders).
  container.style.removeProperty('--widget-bg-color');
  container.style.removeProperty('--widget-bg-op');
  container.style.removeProperty('--widget-border-color');
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
  if (textColor) container.style.setProperty('--widget-text-color', textColor);
}

/**
 * Render a widget into a container. Clears the container first (safe: we
 * control the container, no user data is cleared via innerHTML). Returns an
 * optional cleanup function.
 */
export function renderWidget(container, item) {
  container.replaceChildren();
  applyAppearance(container, item?.config || {});
  const w = getWidget(item?.type);
  if (!w) {
    container.appendChild(el('p', 'muted', `Unknown widget: ${item?.type || '?'}`));
    return null;
  }
  return w.render(container, item?.config || {}, item);
}
