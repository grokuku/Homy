import { el, isValidHttpUrl } from '../util.js';

/**
 * Links widget: a simple column of text links (bookmarks, no icons).
 * config: { title, links: [{ label, url }] }
 */
export const links = {
  name: 'Links',
  icon: '🔖',
  category: 'generic',
  defaultSize: { w: 2, h: 3 },
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: 'Links', placeholder: 'Links' },
      {
        key: 'links',
        label: 'Links',
        type: 'list',
        itemLabel: 'link',
        fields: [
          { key: 'label', label: 'Label', type: 'text', default: '' },
          { key: 'url', label: 'URL', type: 'url', default: '' },
        ],
      },
    ],
  },

  render(container, config) {
    const title = (config?.title || '').trim();
    const items = Array.isArray(config?.links) ? config.links : [];

    container.classList.add('links-widget');
    if (title) {
      const header = el('div', 'widget-header');
      header.appendChild(el('span', 'widget-title', title));
      container.appendChild(header);
    }
    const list = el('ul', 'links-list');
    for (const l of items) {
      const url = isValidHttpUrl(l?.url) ? l.url : null;
      const li = el('li');
      if (url) {
        const a = el('a', null, l?.label || url, { href: url, target: '_blank', rel: 'noopener noreferrer' });
        li.appendChild(a);
      } else {
        li.appendChild(el('span', 'muted', l?.label || ''));
      }
      list.appendChild(li);
    }
    container.appendChild(list);
  },
};
