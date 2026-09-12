import { el, debounce } from '../util.js';
import { api } from '../api.js';
import { toast } from '../ui/toast.js';

/**
 * Notes widget: a free-form editable text block persisted in the widget config.
 * config: { title, text }
 */
export const notes = {
  name: 'Notes',
  icon: '📝',
  category: 'tools',
  defaultSize: { w: 8, h: 3 }, // 3×3 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change)
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
      // Inline persistence (view mode has no ⚙ modal): debounced PATCH + a
      // 'homy:widget-config' broadcast. The event (contract documented in
      // main.js) updates state.layout and the editor's meta cache (review C4):
      // without it a later full-layout PUT rewrote the stale text and silently
      // lost everything the user typed. Failures surface as toasts (review
      // C3) — a silent .catch(() => {}) here meant data loss without a trace.
      const save = debounce((value) => {
        api.patch(`/api/layout/items/${itemId}/config`, { config: { text: value } }).catch(
          (err) => toast(err.message || 'Failed to save notes', 'error')
        );
      }, 600);
      ta.addEventListener('input', () => {
        // Broadcast IMMEDIATELY (not debounced): the local caches must be
        // fresher than any full PUT that could fire between keystrokes.
        window.dispatchEvent(new CustomEvent('homy:widget-config', { detail: { id: itemId, config: { text: ta.value } } }));
        save(ta.value);
      });
    }
  },
};
