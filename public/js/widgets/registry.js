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

export function getWidget(type) {
  return registry[type] || null;
}

export function getDefaultSize(type) {
  return getWidget(type)?.defaultSize || { w: 4, h: 3 };
}

export function getSettingsSchema(type) {
  return getWidget(type)?.settingsSchema || { fields: [] };
}

/**
 * Render a widget into a container. Clears the container first (safe: we
 * control the container, no user data is cleared via innerHTML). Returns an
 * optional cleanup function.
 */
export function renderWidget(container, item) {
  container.replaceChildren();
  const w = getWidget(item?.type);
  if (!w) {
    container.appendChild(el('p', 'muted', `Unknown widget: ${item?.type || '?'}`));
    return null;
  }
  return w.render(container, item?.config || {}, item);
}
