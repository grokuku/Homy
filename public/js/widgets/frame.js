import { el } from '../util.js';

/**
 * Frame widget: an empty titled container to group content.
 * config: { title, accent, background: 'solid' | 'translucent' | 'transparent' }
 */
export const frame = {
  name: 'Frame',
  icon: '▭',
  category: 'generic',
  defaultSize: { w: 4, h: 3 },
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Frame title' },
      { key: 'accent', label: 'Accent / border color', type: 'color', default: '' },
      {
        key: 'background',
        label: 'Background',
        type: 'select',
        default: 'solid',
        options: [
          { value: 'solid', label: 'Solid' },
          { value: 'translucent', label: 'Translucent' },
          { value: 'transparent', label: 'Transparent' },
        ],
      },
    ],
  },

  render(container, config) {
    const title = (config?.title || '').trim();
    const accent = (config?.accent || '').trim();
    const bg = config?.background || 'solid';

    container.classList.add('frame-widget', `bg-${bg}`);
    if (accent) container.style.setProperty('--accent', accent);
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
