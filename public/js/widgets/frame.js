import { el } from '../util.js';

/**
 * Frame widget: an empty titled container to group content.
 * config: { title }. Appearance (bgColor/bgOpacity/borderColor/textColor) is
 * handled generically by applyAppearance() in registry.js.
 */
export const frame = {
  name: 'Frame',
  icon: '▭',
  category: 'generic',
  defaultSize: { w: 4, h: 3 },
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Frame title' },
    ],
  },

  render(container, config) {
    const title = (config?.title || '').trim();

    container.classList.add('frame-widget');
    if (title) {
      const header = el('div', 'widget-header');
      header.appendChild(el('span', 'widget-title', title));
      container.appendChild(header);
    }
    const body = el('div', 'widget-body');
    body.appendChild(el('p', 'muted', 'Empty frame — add widgets around it.'));
    container.appendChild(body);
  },
};
