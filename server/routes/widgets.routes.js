import { Hono } from 'hono';

/**
 * Widget type manifest. This is the extensibility point for future widget
 * types (e.g. server stats in phase 2). Each entry describes a widget the
 * frontend can render, add to the grid, and configure via its declarative
 * `settingsSchema`.
 *
 * settingsSchema field types: text | number | select | url | icon | color |
 * toggle | textarea | list. Each field: { key, label, type, default, options?,
 * placeholder?, required?, min?, max?, step?, help? }. A `list` field carries
 * a nested `fields` array describing each row.
 */
const WIDGET_MANIFEST = [
  {
    id: 'frame',
    type: 'frame',
    name: 'Frame',
    icon: '▭',
    category: 'generic',
    description: 'Empty titled container to group widgets.',
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
  },
  {
    id: 'shortcut',
    type: 'shortcut',
    name: 'Shortcut',
    icon: '🔗',
    category: 'generic',
    description: 'Block of icon shortcuts (label, URL, icon = emoji | URL | initials).',
    defaultSize: { w: 2, h: 2 },
    settingsSchema: {
      fields: [
        { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Shortcuts' },
        { key: 'accent', label: 'Accent color', type: 'color', default: '' },
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
  },
  {
    id: 'clock',
    type: 'clock',
    name: 'Clock',
    icon: '🕐',
    category: 'data',
    description: 'Live clock widget.',
    defaultSize: { w: 2, h: 2 },
    settingsSchema: {
      fields: [
        {
          key: 'format',
          label: 'Format',
          type: 'select',
          default: '24h',
          options: [
            { value: '24h', label: '24-hour' },
            { value: '12h', label: '12-hour' },
          ],
        },
        {
          key: 'timezone',
          label: 'Timezone (IANA, optional)',
          type: 'text',
          default: '',
          placeholder: 'e.g. Europe/Paris',
        },
        { key: 'showDate', label: 'Show date', type: 'toggle', default: true },
        {
          key: 'style',
          label: 'Style',
          type: 'select',
          default: 'digital',
          options: [
            { value: 'digital', label: 'Digital' },
            { value: 'minimal', label: 'Minimal' },
          ],
        },
      ],
    },
  },
  {
    id: 'iframe',
    type: 'iframe',
    name: 'Iframe',
    icon: '🖼',
    category: 'tools',
    description: 'Embed an external page in an iframe.',
    defaultSize: { w: 6, h: 4 },
    settingsSchema: {
      fields: [
        { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Widget title' },
        { key: 'url', label: 'URL', type: 'url', default: '', required: true, placeholder: 'https://…' },
        { key: 'sandbox', label: 'Sandbox (restrict content)', type: 'toggle', default: true },
        { key: 'height', label: 'Height (px)', type: 'number', default: 400, min: 100, max: 2000, step: 10 },
      ],
    },
  },
  {
    id: 'links',
    type: 'links',
    name: 'Links',
    icon: '🔖',
    category: 'generic',
    description: 'Simple column of text links (bookmarks).',
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
  },
  {
    id: 'search',
    type: 'search',
    name: 'Search',
    icon: '🔍',
    category: 'tools',
    description: 'Search bar (Google, DuckDuckGo, Bing or custom URL).',
    defaultSize: { w: 4, h: 1 },
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
          type: 'text',
          default: '',
          placeholder: 'https://example.com/search?q={q}',
        },
        { key: 'placeholder', label: 'Placeholder', type: 'text', default: 'Search…' },
        { key: 'newTab', label: 'Open in new tab', type: 'toggle', default: true },
      ],
    },
  },
  {
    id: 'notes',
    type: 'notes',
    name: 'Notes',
    icon: '📝',
    category: 'tools',
    description: 'Free-form editable text block (persisted in config).',
    defaultSize: { w: 3, h: 3 },
    settingsSchema: {
      fields: [
        { key: 'title', label: 'Title', type: 'text', default: 'Notes', placeholder: 'Notes' },
        { key: 'text', label: 'Notes', type: 'textarea', default: '', rows: 8 },
      ],
    },
  },
  {
    id: 'weather',
    type: 'weather',
    name: 'Weather',
    icon: '🌤',
    category: 'data',
    description: 'Current weather via open-meteo (no API key).',
    defaultSize: { w: 2, h: 2 },
    settingsSchema: {
      fields: [
        { key: 'city', label: 'City', type: 'text', default: '', required: true, placeholder: 'e.g. Paris' },
        {
          key: 'units',
          label: 'Units',
          type: 'select',
          default: 'metric',
          options: [
            { value: 'metric', label: 'Celsius (°C)' },
            { value: 'imperial', label: 'Fahrenheit (°F)' },
          ],
        },
      ],
    },
  },
];

export const widgetRoutes = new Hono();

widgetRoutes.get('/', (c) => c.json({ widgets: WIDGET_MANIFEST }));
