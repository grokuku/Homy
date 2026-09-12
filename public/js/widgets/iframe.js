import { el, isValidHttpUrl } from '../util.js';

/**
 * Iframe widget: embed an external page.
 * config: { title, url, sandbox, height }
 */
export const iframe = {
  name: 'Iframe',
  icon: '🖼',
  category: 'tools',
  defaultSize: { w: 16, h: 4 }, // 6×4 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change)
  settingsSchema: {
    fields: [
      { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Widget title' },
      { key: 'url', label: 'URL', type: 'url', default: '', required: true, placeholder: 'https://…' },
      { key: 'sandbox', label: 'Sandbox (restrict content)', type: 'toggle', default: true },
      { key: 'height', label: 'Height', type: 'range', default: 400, min: 100, max: 2000, step: 10, unit: 'px' },
    ],
  },

  render(container, config) {
    const url = isValidHttpUrl(config?.url) ? config.url : null;
    const title = (config?.title || '').trim();
    const sandbox = config?.sandbox !== false;
    const height = Number(config?.height) || 400;

    container.classList.add('iframe-widget');
    if (title) {
      const header = el('div', 'widget-header');
      header.appendChild(el('span', 'widget-title', title));
      container.appendChild(header);
    }
    if (url) {
      const frame = el('iframe', null, null, {
        src: url,
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
        style: `height:${height}px`,
      });
      if (sandbox) frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      container.appendChild(frame);
    } else {
      const body = el('div', 'widget-body');
      body.appendChild(el('p', 'muted', 'No URL configured.'));
      container.appendChild(body);
    }
  },
};
