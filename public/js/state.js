/**
 * Global app state.
 */
export const state = {
  user: null,
  mode: 'view', // 'view' | 'edit'
  layout: [], // grid items
  layoutColumns: 32, // column count the layout was saved with (12 = legacy, migrated client-side)
  widgets: [], // widget type manifest
  settings: { theme: 'dark', background: { type: 'none' } }, // dashboard settings (server = source of truth)
};
