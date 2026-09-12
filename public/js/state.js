/**
 * Global app state.
 */
export const state = {
  user: null,
  mode: 'view', // 'view' | 'edit'
  layout: [], // grid items OF THE ACTIVE PAGE (pages are cloisonnées: one item set per page)
  layoutColumns: 32, // column count the layout was saved with (12 = legacy, migrated client-side)
  // Multiple pages (schema v3): `pages` is the tab-strip summary the server
  // returns ({ id, name, itemCount }, NO items), `activePageId` is the
  // memorized active page (id of an existing page, server invariant).
  pages: [],
  activePageId: null,
  widgets: [], // widget type manifest
  settings: { theme: 'dark', background: { type: 'none' } }, // dashboard settings (server = source of truth)
};
