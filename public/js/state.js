/**
 * Global app state.
 */
export const state = {
  user: null,
  mode: 'view', // 'view' | 'edit'
  layout: [], // grid items
  widgets: [], // widget type manifest
  settings: { theme: 'dark', background: { type: 'none' } }, // dashboard settings (server = source of truth)
};
