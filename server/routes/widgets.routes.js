import { Hono } from 'hono';

/**
 * Widget type manifest. This is the extensibility point for future widget
 * types (e.g. server stats in phase 2). Each entry describes a widget the
 * frontend can render, add to the grid, and configure via its declarative
 * `settingsSchema`.
 *
 * settingsSchema field types: text | number | range | select | url | icon | color |
 * toggle | textarea | list. Each field: { key, label, type, default, options?,
 * placeholder?, required?, min?, max?, step?, unit?, help? }. A `list` field
 * carries a nested `fields` array describing each row. `range` = numeric field
 * rendered as a slider (live value + unit) by the generic config modal; the
 * stored config value stays a number, exactly like `number`.
 */

/**
 * ⚠️ APPEARANCE_FIELDS — shared per-widget appearance section, merged into
 * EVERY widget's settingsSchema below. MUST stay in sync with the identical
 * constant in public/js/widgets/registry.js (getSettingsSchema). Any change
 * here must be mirrored there, and vice-versa.
 */
const APPEARANCE_FIELDS = [
  { key: 'bgColor', label: 'Background color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
  { key: 'bgOpacity', label: 'Background opacity', type: 'range', default: 100, min: 0, max: 100, step: 1, unit: '%', help: 'Requires a background color' },
  { key: 'borderColor', label: 'Border color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
  { key: 'showBorder', label: 'Show border', type: 'toggle', default: true, help: 'Hide to remove this widget\u2019s frame border' },
  { key: 'textColor', label: 'Text color', type: 'color', default: '', help: 'Leave empty to use the theme default' },
];

const WIDGET_MANIFEST = [
  {
    id: 'group',
    type: 'group',
    name: 'Group',
    icon: '▦',
    category: 'generic',
    description: 'Titled container whose buttons reference the global element catalogue (layout v4).',
    defaultSize: { w: 8, h: 6 } /* 8×6 global cells — comfortably above the 2×2 minimum; a group resizes in global cells */,
    settingsSchema: {
      fields: [
        { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Group title' },
        {
          key: 'titleVisibility',
          label: 'Title visibility',
          type: 'select',
          default: 'always',
          options: [
            { value: 'always', label: 'Always' },
            { value: 'hover', label: 'On hover' },
            { value: 'never', label: 'Never' },
          ],
          help: 'Always shows the title chip, reveals it on hover, or hides it entirely.',
        },
        {
          key: 'zoom',
          label: 'Zoom',
          type: 'range',
          default: 1,
          min: 0.5,
          max: 3,
          step: 0.05,
          unit: '\u00d7',
          help: 'Uniform scale of the group content (tiles + grid), keeping tiles square. Also adjustable with Ctrl+drag on the group in edit mode; Ctrl+double-click resets to 1.',
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
    defaultSize: { w: 5, h: 2 } /* 2×2 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change) */,
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
        { key: 'fitToFrame', label: 'Fit to frame', type: 'toggle', default: false, help: 'Scale time and date to the widget size' },
        {
          key: 'autoSizeMax',
          label: 'Maximum size',
          type: 'range',
          default: 120,
          min: 16,
          max: 400,
          step: 4,
          unit: 'px',
          help: 'Upper bound for the auto-fitted clock (Fit to frame only)',
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
    defaultSize: { w: 16, h: 4 } /* 6×4 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change) */,
    settingsSchema: {
      fields: [
        { key: 'title', label: 'Title', type: 'text', default: '', placeholder: 'Widget title' },
        { key: 'url', label: 'URL', type: 'url', default: '', required: true, placeholder: 'https://…' },
        { key: 'sandbox', label: 'Sandbox (restrict content)', type: 'toggle', default: true },
        { key: 'height', label: 'Height', type: 'range', default: 400, min: 100, max: 2000, step: 10, unit: 'px' },
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
    defaultSize: { w: 11, h: 2 } /* grown from the legacy 4×1 rescale (11×1): a 1-row cell cannot fit the search bar (review C1). Existing h=1 items are upgraded at load — see public/js/grid/config.js normalizeItems. */,
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
  },
  {
    id: 'notes',
    type: 'notes',
    name: 'Notes',
    icon: '📝',
    category: 'tools',
    description: 'Free-form editable text block (persisted in config).',
    defaultSize: { w: 8, h: 3 } /* 3×3 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change) */,
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
    defaultSize: { w: 5, h: 2 } /* 2×2 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change) */,
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

// Merge the shared appearance section into every widget's settingsSchema.
export const WIDGET_MANIFEST_FINAL = WIDGET_MANIFEST.map((w) => ({
  ...w,
  settingsSchema: {
    ...w.settingsSchema,
    fields: [...w.settingsSchema.fields, ...APPEARANCE_FIELDS],
  },
}));

export const widgetRoutes = new Hono();

widgetRoutes.get('/', (c) => c.json({ widgets: WIDGET_MANIFEST_FINAL }));
