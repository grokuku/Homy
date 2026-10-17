/**
 * Global app state.
 */
export const state = {
  user: null,
  mode: 'view', // 'view' | 'edit'
  layout: [], // grid OBJECTS OF THE ACTIVE PAGE (v5: widgets + element/report placements)
  layoutGroups: [], // group BOXES of the active page (content-less; background layer in L2+)
  layoutColumns: 64, // fixed v5 trame (64 columns × 36 rows fine units)
  // Multiple pages (schema v5): `pages` is the tab-strip summary the server
  // returns ({ id, name, objectCount, groupCount }), `activePageId` is the
  // memorized active page (id of an existing page, server invariant).
  pages: [],
  activePageId: null,
  widgets: [], // widget type manifest
  settings: { theme: 'dark', background: { type: 'none' } }, // dashboard settings (server = source of truth)
};
