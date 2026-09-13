import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import {
  KNOWN_ITEM_TYPES,
  LayoutService,
  MAX_COLUMNS,
  MAX_PAGES,
  PAGE_NAME_MAX,
} from '../services/layout.service.js';
import { WIDGET_MANIFEST_FINAL } from './widgets.routes.js';

const MAX_ITEMS = 100; // per PAGE (widgets are confined to their page)
const MAX_BODY_BYTES = 256 * 1024; // 256 KB

// v4 group/button bounds. `group` is a KNOWN item type (the new container);
// `frame`/`shortcut`/`links` and every widget stay valid types for now.
const MIN_GROUP = 2; // a group occupies at least 2×2 GLOBAL cells
const MAX_BUTTONS_PER_GROUP = 50;
const MAX_BUTTONS_PER_PAGE = 200; // buttons of ALL groups on a single page
const BUTTON_CELLS_MAX = 4; // button w/h in INTERNAL cells (1..4)
const ELEMENT_ID_MAX = 128;
// Button icon size steps (per-button display option): fraction of the tile's
// useful internal dimension. "Fill" = 100 %. MUST stay in sync with
// ICON_SIZES in public/js/elements/button.js.
const BUTTON_ICON_SIZES = new Set(['S', 'M', 'L', 'XL', 'Fill']);
const BUTTON_ICON_SIZE_DEFAULT = 'M';

// The grid canvas (must stay in sync with public/js/grid/config.js and with
// MAX_COLUMNS in layout.service.js): 32 columns × 18 rows.
const GRID_COLUMNS = MAX_COLUMNS;
const GRID_ROWS = 18;

export function layoutRoutes(storeOrService, options = {}) {
  const layout =
    storeOrService instanceof LayoutService ? storeOrService : new LayoutService(storeOrService);
  // Optional catalogue predicate — used ONLY to warn about buttons pointing at
  // an unknown element id (best-effort signal, never a hard failure).
  const elementExists = typeof options.elementExists === 'function' ? options.elementExists : null;
  const routes = new Hono();

  // Get full layout — items of the ACTIVE page + the column count they are
  // expressed in (12 for legacy layouts, converted client-side by gridstack)
  // + schema version + the page list (tabs). RETRO-COMPATIBLE: the legacy
  // front only reads `items`/`columns`, which keep their meaning.
  routes.get('/', (c) =>
    c.json({
      ...layout.meta(),
      activePageId: layout.activePageId,
      pages: layout.pagesSummary(),
      items: layout.list(),
    })
  );

  // Replace the items of the ACTIVE page (from gridstack serialization).
  // `pageId` (optional) targets another page WITHOUT switching the active one.
  // `columns` (optional) records the grid the coordinates are expressed in;
  // legacy 12-column coordinates are migrated client-side BEFORE this call
  // (editor.js), so a PUT with columns: 32 stores already-rescaled items.
  routes.put('/', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    let targetId;
    if (parsed.body.pageId !== undefined) {
      targetId = layout.page(String(parsed.body.pageId))?.id;
      if (!targetId) return c.json({ error: 'Not found' }, 404);
    }
    const rawItems = Array.isArray(parsed.body.items) ? parsed.body.items : [];
    if (rawItems.length > MAX_ITEMS) {
      return c.json({ error: `Too many items (max ${MAX_ITEMS} per page)` }, 400);
    }
    let columns;
    if (parsed.body.columns !== undefined) {
      columns = Math.round(Number(parsed.body.columns));
      if (!Number.isFinite(columns) || columns < 1 || columns > MAX_COLUMNS) {
        return c.json({ error: `columns must be an integer between 1 and ${MAX_COLUMNS}` }, 400);
      }
    }
    const clean = [];
    const ignored = new Set();
    for (const item of rawItems) {
      if (!isKnownType(item)) {
        ignored.add(String(item?.type ?? 'undefined'));
        continue; // unknown item types are IGNORED on PUT (never a hard failure)
      }
      const { error, item: cleanItem } = sanitizeItem(item);
      if (error) return c.json({ error }, 400);
      clean.push(cleanItem);
    }
    if (ignored.size) {
      console.warn(`[layout] ignoring unknown item type(s) on PUT: ${[...ignored].join(', ')}`);
    }
    if (countButtons(clean) > MAX_BUTTONS_PER_PAGE) {
      return c.json({ error: `Too many buttons on this page (max ${MAX_BUTTONS_PER_PAGE})` }, 400);
    }
    warnUnknownElements(clean, elementExists);
    const items = layout.replace(clean, columns, targetId);
    return c.json({ items, ...layout.meta(), activePageId: layout.activePageId, pages: layout.pagesSummary() });
  });

  // Add a single item to the ACTIVE page — missing w/h default to the widget's
  // manifest defaultSize (32-col values, e.g. search = 11×2).
  routes.post('/items', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (layout.list().length >= MAX_ITEMS) {
      return c.json({ error: `Too many items (max ${MAX_ITEMS} per page)` }, 400);
    }
    const error = validateType(parsed.body);
    if (error) return c.json({ error }, 400);
    const defaults = defaultSizeFor(parsed.body);
    const { error: sanitizeError, item } = sanitizeItem({ ...parsed.body, ...defaults });
    if (sanitizeError) return c.json({ error: sanitizeError }, 400);
    if (countButtons(layout.list()) + countButtons([item]) > MAX_BUTTONS_PER_PAGE) {
      return c.json({ error: `Too many buttons on this page (max ${MAX_BUTTONS_PER_PAGE})` }, 400);
    }
    warnUnknownElements([item], elementExists);
    const entry = layout.add(item);
    return c.json(entry, 201);
  });

  // Update an item's config (id looked up across all pages — ids are unique)
  routes.patch('/items/:id/config', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (!parsed.body.config || typeof parsed.body.config !== 'object') {
      return c.json({ error: 'config object required' }, 400);
    }
    const entry = layout.updateConfig(c.req.param('id'), parsed.body.config);
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.json(entry);
  });

  // Delete an item
  routes.delete('/items/:id', (c) => {
    const ok = layout.remove(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  // ---- Pages (tabs) ---------------------------------------------------------

  // Items of a specific page (the active one is NOT switched).
  routes.get('/pages/:id', (c) => {
    const page = layout.page(c.req.param('id'));
    if (!page) return c.json({ error: 'Not found' }, 404);
    return c.json({
      id: page.id,
      name: page.name,
      itemCount: page.items.length,
      items: page.items,
      ...layout.meta(),
    });
  });

  // Create a page — optional {name} (1..40 chars after trim), defaults to
  // "Page N" (first free index). Page ids are server-generated UUIDs.
  routes.post('/pages', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (layout.pages.length >= MAX_PAGES) {
      return c.json({ error: `Too many pages (max ${MAX_PAGES})` }, 400);
    }
    let name;
    if (parsed.body.name !== undefined) {
      name = normalizePageName(parsed.body.name);
      if (!name) return c.json({ error: `name must be 1 to ${PAGE_NAME_MAX} characters after trim` }, 400);
    }
    return c.json(layout.createPage(name), 201);
  });

  // Rename a page — {name} required, 1..40 chars after trim.
  routes.patch('/pages/:id', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const name = normalizePageName(parsed.body.name);
    if (!name) return c.json({ error: `name must be 1 to ${PAGE_NAME_MAX} characters after trim` }, 400);
    const page = layout.renamePage(c.req.param('id'), name);
    if (!page) return c.json({ error: 'Not found' }, 404);
    return c.json(page);
  });

  // Delete a page. The last page cannot be deleted (400). Deleting the ACTIVE
  // page falls back to the FIRST remaining page: the response carries the new
  // activePageId AND its items + the fresh page list (single round-trip).
  routes.delete('/pages/:id', (c) => {
    const result = layout.deletePage(c.req.param('id'));
    if (!result.ok) {
      if (result.reason === 'not-found') return c.json({ error: 'Not found' }, 404);
      return c.json({ error: 'Cannot delete the last page' }, 400);
    }
    return c.json({
      ok: true,
      activePageId: result.activePageId,
      items: layout.list(),
      ...layout.meta(),
      pages: layout.pagesSummary(),
    });
  });

  // Switch the active page — {pageId}. One round-trip: returns the new active
  // page's items + the page list, so the front can swap tabs instantly.
  routes.put('/active', async (c) => {
    const parsed = await parseBody(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (parsed.body.pageId === undefined) return c.json({ error: 'pageId required' }, 400);
    const page = layout.setActive(String(parsed.body.pageId));
    if (!page) return c.json({ error: 'Not found' }, 404);
    return c.json({
      activePageId: page.id,
      items: page.items,
      ...layout.meta(),
      pages: layout.pagesSummary(),
    });
  });

  return routes;
}

/**
 * Read + size-limit + JSON-parse a request body.
 * Returns `{ ok: true, body }` on success, or `{ ok: false, status, error }`.
 */
async function parseBody(c) {
  const text = await c.req.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'Request body too large (max 256 KB)' };
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }
}

function isKnownType(item) {
  if (!item || typeof item !== 'object') return false;
  return KNOWN_ITEM_TYPES.has(String(item.type || 'frame'));
}

function validateType(item) {
  if (!item || typeof item !== 'object') return 'Invalid layout item';
  const type = String(item.type || 'frame');
  if (!KNOWN_ITEM_TYPES.has(type)) return `Unknown widget type: ${type}`;
  return null;
}

/** Manifest defaultSize for a type (only fills fields the caller omitted). */
function defaultSizeFor(item) {
  const def = WIDGET_MANIFEST_FINAL.find((w) => w.type === String(item?.type || 'frame'))?.defaultSize;
  const out = {};
  if (def && item?.w === undefined) out.w = def.w;
  if (def && item?.h === undefined) out.h = def.h;
  return out;
}

/** Page name: trim + length check (1..40). Returns the trimmed name or null. */
function normalizePageName(raw) {
  const name = String(raw ?? '').trim();
  return name && name.length <= PAGE_NAME_MAX ? name : null;
}

/**
 * Validate/normalize a grid item for the 32×18 canvas.
 * Returns `{ item }` on success or `{ error }` (HTTP 400) on rejection.
 *
 * Rejected: non-integer or negative x/y, w outside 1..32, h < 1, non-numeric
 * coordinates. Tolerated (documented leniency): missing w/h/x/y and h taller
 * than the canvas. Review A1 restored a NON-destructive fallback:
 *   - w/h missing → 1 (NOT the old 11×3, which silently inflated every item
 *     whose w or h was omitted). Why 1 and not the widget's defaultSize: the
 *     only legitimate producer of a PUT body missing w/h is gridstack's own
 *     save() (old cached frontends included), and its removeInternalForSave()
 *     strips these fields ONLY when the value IS exactly 1 — so a missing
 *     field semantically means "1". Deriving from defaultSize would inflate
 *     widgets the user deliberately resized to a single cell (e.g. a clock at
 *     h=1). The fixed client always sends explicit w/h (it serializes from
 *     the live engine nodes, not grid.save()); POST /items keeps its
 *     defaultSize fallback because there the caller means "create a widget
 *     without geometry" and the manifest default IS the intent.
 *   - x/y missing → 0 (unchanged).
 *   - h is CLAMPED to 18 instead of rejected so a hand-edited legacy item
 *     taller than the canvas can still be saved (a rejection here would
 *     strand the whole layout: the client could never persist its edits again).
 *
 * v4 additions: a `group` is validated with a 2×2 GLOBAL minimum (a 1×1 group
 * is rejected) and carries a sanitized `buttons[]`. Non-group items keep the
 * exact previous behavior — no `buttons` field is ever attached to them.
 */
function sanitizeItem(item) {
  if (!item || typeof item !== 'object') return { error: 'Invalid layout item' };
  const type = String(item.type || 'frame');
  const id = String(item.id || '');
  const isGroup = type === 'group';
  const minW = isGroup ? MIN_GROUP : 1;
  const minH = isGroup ? MIN_GROUP : 1;

  const int = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  let x = int(item.x);
  if (x === null) x = 0;
  if (x < 0) return { error: 'x must be an integer >= 0' };

  let y = int(item.y);
  if (y === null) y = 0;
  if (y < 0) return { error: 'y must be an integer >= 0' };

  let w = int(item.w);
  if (w === null) w = minW;
  if (w < minW || w > GRID_COLUMNS) {
    return {
      error: isGroup
        ? `w must be an integer between ${minW} and ${GRID_COLUMNS} for a group`
        : `w must be an integer between 1 and ${GRID_COLUMNS}`,
    };
  }

  let h = int(item.h);
  if (h === null) h = minH;
  if (h < minH) {
    return { error: isGroup ? 'h must be an integer >= 2 for a group (min 2×2)' : 'h must be an integer >= 1' };
  }

  const clean = {
    id: id || (isGroup ? randomUUID() : undefined),
    x,
    y,
    w,
    h: Math.min(h, GRID_ROWS),
    type,
    config: item.config && typeof item.config === 'object' ? item.config : {},
  };

  if (isGroup) {
    const { error, buttons } = sanitizeButtons(item.buttons);
    if (error) return { error };
    clean.buttons = buttons;
  }

  return { item: clean };
}

/**
 * Validate/normalize a group's `buttons`. Returns `{ buttons }` or `{ error }`.
 * A missing batch defaults to []; `elementId` is REQUIRED but may point at an
 * unknown catalogue id (the catalogue can evolve) — that is only logged, never
 * fatal. Options are completed with their documented defaults.
 */
function sanitizeButtons(raw) {
  if (raw === undefined || raw === null) return { buttons: [] };
  if (!Array.isArray(raw)) return { error: 'buttons must be an array' };
  if (raw.length > MAX_BUTTONS_PER_GROUP) {
    return { error: `Too many buttons in group (max ${MAX_BUTTONS_PER_GROUP})` };
  }
  const buttons = [];
  for (const button of raw) {
    if (!button || typeof button !== 'object' || Array.isArray(button)) return { error: 'Invalid button' };
    const elementId = typeof button.elementId === 'string' ? button.elementId.trim() : '';
    if (!elementId || elementId.length > ELEMENT_ID_MAX) {
      return { error: 'button.elementId is required' };
    }
    const int = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.floor(n) : null;
    };
    let col = int(button.col);
    if (col === null) col = 0;
    if (col < 0) return { error: 'button.col must be an integer >= 0' };
    let row = int(button.row);
    if (row === null) row = 0;
    if (row < 0) return { error: 'button.row must be an integer >= 0' };
    let w = int(button.w);
    if (w === null) w = 1;
    if (w < 1 || w > BUTTON_CELLS_MAX) {
      return { error: `button.w must be an integer between 1 and ${BUTTON_CELLS_MAX}` };
    }
    let h = int(button.h);
    if (h === null) h = 1;
    if (h < 1 || h > BUTTON_CELLS_MAX) {
      return { error: `button.h must be an integer between 1 and ${BUTTON_CELLS_MAX}` };
    }
    buttons.push({
      id: typeof button.id === 'string' && button.id ? button.id : randomUUID(),
      elementId,
      col,
      row,
      w,
      h,
      options: normalizeButtonOptions(button.options),
    });
  }
  return { buttons };
}

/**
 * Button display options with their defaults (icon/label/shortcut ON).
 * TOLERANT: unknown/missing keys fall back to their default — a button saved
 * before `iconSize`/`allowIconOverflow` existed keeps working untouched.
 */
function normalizeButtonOptions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const iconSize = BUTTON_ICON_SIZES.has(o.iconSize) ? o.iconSize : BUTTON_ICON_SIZE_DEFAULT;
  return {
    icon: bool(o.icon, true),
    label: bool(o.label, true),
    shortcut: bool(o.shortcut, true),
    health: bool(o.health, false),
    monitoring: bool(o.monitoring, false),
    controls: bool(o.controls, false),
    iconSize,
    allowIconOverflow: bool(o.allowIconOverflow, false),
  };
}

/** Total buttons carried by a batch of (already sanitized or raw) items. */
function countButtons(items) {
  let total = 0;
  for (const item of items) {
    if (item && Array.isArray(item.buttons)) total += item.buttons.length;
  }
  return total;
}

/**
 * Best-effort signal: log (once per write) the element ids referenced by a
 * group but absent from the catalogue. Never blocks the write — references are
 * allowed to dangle while the catalogue evolves (the DELETE guard handles the
 * cleanup side).
 */
function warnUnknownElements(items, elementExists) {
  if (!elementExists) return;
  const unknown = new Set();
  for (const item of items) {
    if (!item || item.type !== 'group' || !Array.isArray(item.buttons)) continue;
    for (const button of item.buttons) {
      if (button && button.elementId && !elementExists(button.elementId)) unknown.add(button.elementId);
    }
  }
  if (unknown.size) {
    console.warn(`[layout] button(s) reference unknown element id(s): ${[...unknown].join(', ')}`);
  }
}