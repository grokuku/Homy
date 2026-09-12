import { el, isValidHttpUrl } from '../util.js';

const ENGINES = {
  google: 'https://www.google.com/search?q={q}',
  duckduckgo: 'https://duckduckgo.com/?q={q}',
  bing: 'https://www.bing.com/search?q={q}',
};

/**
 * Search widget: a search bar with a configurable engine.
 * config: { engine, customUrl, placeholder, newTab }
 */
export const search = {
  name: 'Search',
  icon: '🔍',
  category: 'tools',
  // h:2 since the 32×18 grid review (C1): a 1-row cell cannot fit the search
  // bar (at 1366×768 a 1-row cell offers ~21px of content for a ~46px bar).
  // Existing h=1 search items are grown to h=2 at load time — see the shared
  // normalizeItems() in grid/config.js (editor + viewer). Must stay in sync
  // with server/routes/widgets.routes.js (check-schema-sync enforces it).
  defaultSize: { w: 11, h: 2 }, // 4×2 after rescale: w = legacy 4×1 ×32/12 rounded, h grown for C1 (was 11×1)
  settingsSchema: {
    fields: [
      {
        key: 'engine',
        label: 'Search engine',
        type: 'select',
        default: 'google',
        options: [
          { value: 'google', label: 'Google' },
          { value: 'duckduckgo', label: 'DuckDuckGo' },
          { value: 'bing', label: 'Bing' },
          { value: 'custom', label: 'Custom URL' },
        ],
      },
      {
        key: 'customUrl',
        label: 'Custom search URL (with {q})',
        type: 'url',
        default: '',
        placeholder: 'https://example.com/search?q={q}',
      },
      { key: 'placeholder', label: 'Placeholder', type: 'text', default: 'Search…' },
      { key: 'newTab', label: 'Open in new tab', type: 'toggle', default: true },
    ],
  },

  render(container, config) {
    const engine = config?.engine || 'google';
    const customUrl = (config?.customUrl || '').trim();
    const placeholder = (config?.placeholder || 'Search…').trim();
    const newTab = config?.newTab !== false;

    container.classList.add('search-widget');
    const form = el('form', 'search-form');
    const input = el('input', 'search-input', null, { type: 'text', placeholder, autocomplete: 'off' });
    const btn = el('button', 'btn', 'Go', { type: 'submit' });
    form.append(input, btn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      let url;
      // Only honor the custom engine when customUrl is a valid http(s) URL
      // (blocks javascript: URIs — XSS). Otherwise fall back to the default.
      const useCustom = engine === 'custom' && isValidHttpUrl(customUrl);
      if (useCustom) {
        url = customUrl.replace('{q}', encodeURIComponent(q));
      } else {
        url = (ENGINES[engine] || ENGINES.google).replace('{q}', encodeURIComponent(q));
      }
      if (newTab) window.open(url, '_blank', 'noopener');
      else window.location.href = url;
    });

    container.appendChild(form);
  },
};
