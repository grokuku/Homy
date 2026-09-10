import { el, debounce } from '../util.js';
import { api } from '../api.js';

/**
 * Notes widget: a free-form editable text block persisted in the widget config.
 * config: { title, text }
 */
export const notes = {
  name: 'Notes',
  icon: '📝',
  category: 'tools',
  defaultSize: { w: 3, h: 3 },
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: 'Notes', placeholder: 'Notes' },
      { key: 'text', label: 'Notes', type: 'textarea', default: '', rows: 8 },
    ],
  },

  render(container, config, item) {
    const title = (config?.title || '').trim();
    const text = config?.text || '';
    const itemId = item?.id;

    container.classList.add('notes-widget');
    if (title) {
      const header = el('div', 'widget-header');
      header.appendChild(el('span', 'widget-title', title));
      container.appendChild(header);
    }
    const ta = el('textarea', 'notes-textarea', null, { placeholder: 'Write your notes…' });
    ta.value = text;
    container.appendChild(ta);

    if (itemId) {
      const save = debounce((value) => {
        api.patch(`/api/layout/items/${itemId}/config`, { config: { text: value } }).catch(() => {});
      }, 600);
      ta.addEventListener('input', () => save(ta.value));
    }
  },
};
