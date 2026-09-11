import { el, isValidHttpUrl } from '../util.js';

/**
 * Shortcut widget: a block of icon shortcuts in an internal grid.
 * config: { title, iconSize, shortcuts: [{ label, url, icon }] }
 * icon is one of: emoji text, an image URL, or empty (→ initials).
 */
export const shortcut = {
  name: 'Shortcut',
  icon: '🔗',
  category: 'generic',
  defaultSize: { w: 2, h: 2 },
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Shortcuts' },
      {
        key: 'iconSize',
        label: 'Icon size',
        type: 'select',
        default: 'md',
        options: [
          { value: 'sm', label: 'Small' },
          { value: 'md', label: 'Medium' },
          { value: 'lg', label: 'Large' },
        ],
      },
      {
        key: 'shortcuts',
        label: 'Shortcuts',
        type: 'list',
        itemLabel: 'shortcut',
        fields: [
          { key: 'label', label: 'Label', type: 'text', default: '' },
          { key: 'url', label: 'URL', type: 'url', default: '' },
          { key: 'icon', label: 'Icon (emoji / image URL)', type: 'icon', default: '' },
        ],
      },
    ],
  },

  render(container, config) {
    const title = (config?.title || '').trim();
    const iconSize = config?.iconSize || 'md';
    const shortcuts = Array.isArray(config?.shortcuts) ? config.shortcuts : [];

    container.classList.add('shortcut-widget');
    if (title) {
      const header = el('div', 'widget-header');
      header.appendChild(el('span', 'widget-title', title));
      container.appendChild(header);
    }
    const grid = el('div', `shortcut-grid size-${iconSize}`);
    container.appendChild(grid);

    for (const s of shortcuts) {
      const url = isValidHttpUrl(s?.url) ? s.url : null;
      const tile = el('a', 'shortcut-tile', null, url ? { href: url, target: '_blank', rel: 'noopener noreferrer' } : {});
      tile.appendChild(buildIcon(s));
      tile.appendChild(el('span', 'shortcut-label', s?.label || url || ''));
      grid.appendChild(tile);
    }
  },
};

function buildIcon(s) {
  const box = el('div', 'shortcut-icon');
  const icon = (s?.icon || '').trim();
  if (isValidHttpUrl(icon)) {
    const img = el('img', null, null, { src: icon, alt: '', loading: 'lazy' });
    box.appendChild(img);
  } else if (icon) {
    // emoji (or any short text)
    box.textContent = icon;
  } else {
    // initials from label
    const label = (s?.label || '').trim();
    const initials = label
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    box.textContent = initials || '?';
  }
  return box;
}
