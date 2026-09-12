import { api } from './api.js';
import { state } from './state.js';
import { renderViewer } from './grid/viewer.js';
import { initEditor, renderPalette } from './grid/editor.js';
import { GRID_COLUMNS, MAX_ITEMS } from './grid/config.js';
import { getTheme, otherTheme, switchTheme, syncFromServer } from './ui/theme.js';
import { applyBackground, setBackgroundHost } from './backgrounds/manager.js';
import { openBackgroundModal } from './ui/backgroundModal.js';
import { initTabs, renderTabs } from './ui/tabs.js';
import { toast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);

let grid = null; // current grid instance (viewer gridstack or editor handle)
let viewTopbarVisible = false; // VIEW-mode topbar state (right-click toggles; default hidden)
let switchingPage = false; // page switch in flight (double-click guard on the tabs)

// Must match MAX_BODY_BYTES in server/routes/layout.routes.js (review C3):
// the client refuses to send a body the server would 413, so the failure is
// explained instead of silently dropped.
const MAX_BODY_BYTES = 256 * 1024;

// ---- View switching --------------------------------------------------------

function showLogin() {
  $('dashboard-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('setup-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
  $('login-error').textContent = '';
}

function showSetup() {
  $('dashboard-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('login-form').classList.add('hidden');
  $('setup-form').classList.remove('hidden');
  $('setup-error').textContent = '';
}

async function showDashboard() {
  $('login-view').classList.add('hidden');
  $('dashboard-view').classList.remove('hidden');
  $('user-label').textContent = state.user || '';
  // VIEW-mode topbar starts HIDDEN on every (re)entry (right-click reveals it).
  // Apply the collapsed state SYNCHRONOUSLY, before the first await: the
  // dashboard was just revealed, so the bar is laid out and its height can be
  // measured right now — a slow layout/settings fetch can therefore never
  // flash the bar before setMode('view') below re-affirms the same state.
  viewTopbarVisible = false;
  state.mode = 'view';
  applyTopbarState({ animate: false });

  try {
    const [layoutRes, widgetsRes, settingsRes] = await Promise.all([
      api.get('/api/layout'),
      api.get('/api/widgets'),
      api.get('/api/settings'),
    ]);
    state.layout = layoutRes.items || [];
    // Column count the layout was last saved with. Legacy layouts (no
    // `columns` field in layout.json) report 12 and are migrated client-side
    // by the editor/viewer via gridstack's column(32, 'moveScale') reflow.
    state.layoutColumns = Number(layoutRes.columns) || 12;
    // Multiple pages (schema v3): tab summary + memorized active page.
    state.pages = Array.isArray(layoutRes.pages) ? layoutRes.pages : [];
    state.activePageId = layoutRes.activePageId || state.pages[0]?.id || null;
    state.widgets = widgetsRes.widgets || [];
    state.settings = settingsRes || state.settings;
  } catch {
    state.layout = [];
    state.widgets = [];
  }

  // Server settings are the source of truth once authenticated: refresh the
  // anti-flash localStorage mirror and the live background.
  syncFromServer(state.settings.theme);
  applyBackground(state.settings.background);
  updateThemeButton();

  setMode('view');
}

// ---- Grid mode -------------------------------------------------------------

function destroyGrid() {
  if (grid) {
    try {
      grid.destroy?.();
    } catch {
      /* ignore */
    }
    grid = null;
  }
  // gridstack.destroy() removes its container element from the DOM, so the
  // original #grid-container is gone once a grid has been destroyed (this
  // happens on every view/edit switch). Re-create a fresh container if needed
  // and attach it INSIDE the preview frame (lot 1 structure).
  let container = $('grid-container');
  if (container) {
    container.replaceChildren();
  } else {
    container = document.createElement('div');
    container.id = 'grid-container';
    container.className = 'grid-stack';
    $('grid-preview').appendChild(container);
  }
  // Review C12: scrub whatever gridstack/editor left on the container. The
  // fresh re-creation above is normally clean, but if destroy() threw (e.g.
  // double-destroy) the SAME element is reused: it would keep the editor's
  // .editing-grid class (grid lines visible in view mode) and gridstack's
  // inline style (CSS vars + fixed height) — both must go before the next init.
  container.classList.remove('editing-grid');
  container.removeAttribute('style');
}

// ---- Adaptive edit-preview dezoom (lot 1) ----------------------------------
// The framed preview shows the WHOLE 32×18 canvas scaled down so the 16:9
// frame still fits beside the docked palette. The logical canvas keeps the
// exact size it has in view mode (so widget layout is WYSIWYG); only the
// rendered scale changes.
//
// Bounds / fallback (documented thresholds):
//  - PREVIEW_CELL_MIN: the rendered cell must stay >= 20px. This mirrors the
//    640px cell floor already enforced in CSS (640 = 32 × 20).
//  - PREVIEW_MIN_SCALE: hard lower bound on f, belt-and-braces.
//  - PREVIEW_BORDER: must match #grid-preview's border width in style.css.
// Below the floors edit mode drops the frame entirely and falls back to the
// legacy behavior (floating palette, min-width:640px + horizontal pan).
const PREVIEW_CELL_MIN = 20; // px — rendered cell-width floor
const PREVIEW_MIN_SCALE = 0.3; // hard floor on the adaptive scale f
const PREVIEW_BORDER = 2; // px — #grid-preview border width (style.css)

// ---- Canvas width pinning (lot E) ------------------------------------------
/**
 * Pin the 16:9 canvas width to a FRESH JavaScript measurement (CSS var
 * --canvas-w on #grid-wrap, consumed by #grid-container's width in CSS).
 *
 * WHY (lot E, empty-page scrollbar in view mode): the CSS width used pure
 * container-query units (min(100cqw, 100cqh·16/9)). Those units resolve
 * against the query container's CURRENT box — which is mid-flight whenever a
 * grid rebuild races the 200ms topbar reveal animation (right-click toggle
 * followed immediately by a tab switch): gridstack then reads a stale
 * clientWidth, freezes cellHeight from it (its ResizeObserver is throttled
 * and short-circuits on prevWidth === clientWidth, so it may never converge
 * in frame-starved environments) and the canvas ends up TALLER than the real
 * area — a phantom vertical scrollbar on .grid-wrap (most visible on an
 * empty page). A JS measurement here is never stale: getBoundingClientRect /
 * clientWidth force a synchronous layout with the transition already snapped
 * to its final value by applyTopbarState({animate:false}) in setMode().
 *
 * The measured width is floored to an INTEGER pixel: gridstack derives the
 * square cell height from the container's clientWidth (integer), so an
 * integer width makes the gridstack inline height (18 × clientWidth/32)
 * agree EXACTLY with the CSS aspect-ratio box — no sub-pixel overflow, no
 * scrollbar, by construction, at every instant (≤1px narrower than the
 * theoretical cq value: imperceptible).
 */
function updateCanvasWidth() {
  const wrap = $('grid-wrap');
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  // clientWidth: integer, EXCLUDES a classic scrollbar (pan case stays sane);
  // rect.height: fractional, exact — no rounding slack on the vertical fit.
  const contentW = wrap.clientWidth - padX;
  const contentH = wrap.getBoundingClientRect().height - padY;
  // −0.5 shave: clientWidth rounds to integer, the shave absorbs a round-up
  // so the width can never exceed the true visible content either.
  const w = Math.floor(Math.min(contentW, (contentH * 16) / 9) - 0.5);
  if (w > 0) wrap.style.setProperty('--canvas-w', `${w}px`);
}

/**
 * Compute (and apply) `--preview-scale` so the whole 16:9 frame fits the area
 * left of the docked palette. Formula (all in CSS px):
 *   availH  = grid-wrap content height
 *   fullW   = body width − wrap padding  → view-mode canvas width
 *   natural = min(fullW, availH·16/9)    → WYSIWYG logical width (view size)
 *   frame   = min(bodyW − padX − dockW, availH·16/9) → framed content width
 *   f       = (frame − 2·border) / natural, then apply the floors above.
 * `natural` already fits the height, so f is essentially the width ratio
 * between the framed area and the full view area (f = 1 when nothing is
 * docked and the window is wide enough). Idempotent: safe on every resize.
 */
function updatePreviewScale() {
  const view = $('dashboard-view');
  const preview = $('grid-preview');
  if (state.mode !== 'edit') {
    view.classList.remove('preview-active');
    preview.style.removeProperty('--preview-scale');
    return;
  }
  const wrap = $('grid-wrap');
  const body = $('dashboard-body');
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const availH = wrap.clientHeight - padY;
  const fullW = body.clientWidth - padX;
  const naturalW = Math.min(fullW, (availH * 16) / 9);
  const dockW = parseFloat(getComputedStyle(view).getPropertyValue('--palette-dock-w')) || 0;
  const frameW = Math.min(body.clientWidth - padX - dockW, (availH * 16) / 9);
  const frameContentW = frameW - 2 * PREVIEW_BORDER;
  const scale = naturalW > 0 ? frameContentW / naturalW : 0;
  const ok =
    naturalW > 0 &&
    frameContentW / GRID_COLUMNS >= PREVIEW_CELL_MIN &&
    scale >= PREVIEW_MIN_SCALE;
  if (!ok) {
    // Fallback: no frame, no scale — today's behavior (pan inside .grid-wrap).
    view.classList.remove('preview-active');
    preview.style.removeProperty('--preview-scale');
    return;
  }
  view.classList.add('preview-active');
  preview.style.setProperty('--preview-scale', String(scale));
}

/**
 * Clip (or un-clip) the live background to the framed edit preview (lot 2).
 * The layers follow #grid-preview-bg while the frame is active and <body>
 * otherwise (view mode, logout, small-screen fallback). Always called right
 * after updatePreviewScale() so a resize crossing the fallback threshold keeps
 * the background host in sync with the frame.
 */
function syncBackgroundScope() {
  const scoped =
    state.mode === 'edit' && $('dashboard-view').classList.contains('preview-active');
  setBackgroundHost(scoped ? $('grid-preview-bg') : null);
}

// ---- Topbar visibility (VIEW mode) -----------------------------------------
// The topbar is HIDDEN by default in view mode so the display area gets the
// full height; a right-click toggles it. Edit mode keeps it permanently (but
// compact). Collapsing pulls the bar above the viewport by its MEASURED height
// (--topbar-h): #dashboard-body (flex:1) then reclaims exactly that space, so
// the frame is never masked by the bar. The measure is refreshed on every
// layout change (ResizeObserver below) — no hardcoded height anywhere.
function updateTopbarHeight() {
  const view = $('dashboard-view');
  const topbar = view.querySelector('.topbar');
  if (!topbar) return;
  const h = topbar.offsetHeight; // margin independent → valid even when collapsed
  if (h > 0 && view.style.getPropertyValue('--topbar-h') !== `${h}px`) {
    view.style.setProperty('--topbar-h', `${h}px`);
  }
}

function applyTopbarState({ animate = true } = {}) {
  // Edit: always shown. View: only after a right-click toggle.
  const collapsed = state.mode === 'view' && !viewTopbarVisible;
  const topbar = $('dashboard-view').querySelector('.topbar');
  // Measure BEFORE collapsing so the negative margin uses the real height.
  updateTopbarHeight();
  // Mode switches must be INSTANT: gridstack reads the container size right
  // after setMode() (square cell height from clientWidth) and an animating
  // margin would feed it a stale intermediate size — the same trap the old
  // animated with-palette margin fell into. The right-click toggle keeps the
  // 200ms transition (pure view mode: no grid rebuild follows).
  if (!animate && topbar) topbar.classList.add('topbar-instant');
  $('dashboard-view').classList.toggle('topbar-collapsed', collapsed);
  if (!animate && topbar) {
    void topbar.offsetHeight; // flush layout while the transition is disabled
    requestAnimationFrame(() => topbar.classList.remove('topbar-instant'));
  }
}

function toggleViewTopbar() {
  if (state.mode !== 'view') return;
  viewTopbarVisible = !viewTopbarVisible;
  applyTopbarState(); // animated
}

// Right-click: toggle the bar in view mode, and suppress the browser context
// menu everywhere on the dashboard EXCEPT on genuine native targets (text
// fields, links) where the user legitimately wants copy/inspect. Events fired
// inside an <iframe> widget do not bubble to this document at all, so a
// cross-origin iframe keeps its own browser menu (and cannot toggle the bar) —
// documented limitation, not a regression.
function isNativeContextTarget(target) {
  return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable], a[href]'));
}

$('dashboard-view').addEventListener('contextmenu', (e) => {
  if (isNativeContextTarget(e.target)) return;
  e.preventDefault();
  if (state.mode === 'view') toggleViewTopbar();
});

function setMode(mode) {
  state.mode = mode;
  const btn = $('toggle-mode');
  btn.textContent = mode === 'edit' ? 'Done' : 'Edit';
  btn.classList.toggle('active', mode === 'edit');
  $('editor-palette').classList.toggle('hidden', mode !== 'edit');
  // The Background / Theme toolbar buttons are edit-only, exactly like the
  // palette was (they live in the topbar since lot 2).
  $('editor-actions').classList.toggle('hidden', mode !== 'edit');
  $('grid-wrap').classList.toggle('with-palette', mode === 'edit');
  // Tab strip (multiple pages): rendered BEFORE the topbar is measured so
  // --topbar-h includes the row whenever it must be visible (edit: always;
  // view: only when ≥ 2 pages — see ui/tabs.js renderTabs).
  renderTabs();
  // View mode starts collapsed; edit mode forces the bar visible (compact).
  // Instant (no slide) so the geometry read below is final from the first
  // frame: the snap (topbar-instant) makes the used margin-top the target
  // value NOW, so the canvas width pinned next is measured at final geometry
  // and gridstack can never initialize from a mid-animation size.
  applyTopbarState({ animate: false });

  // Pin the canvas width from a FRESH measurement (see updateCanvasWidth):
  // must run BEFORE initEditor/renderViewer, whose gridstack reads the
  // container's clientWidth to derive the square cell height.
  updateCanvasWidth();
  destroyGrid();
  // Frame + scale must be applied BEFORE initEditor: gridstack reads the
  // container's clientWidth at init to derive the square cell height, and the
  // logical width (`100% / --preview-scale`) is what makes the zoomed-in
  // canvas still compute view-mode-sized cells.
  updatePreviewScale();
  // The frame may have been switched on/off by updatePreviewScale: host the
  // background inside it (clipped) or back on <body>.
  syncBackgroundScope();
  // Both grids initialize at the SAVED column count and migrate to 32
  // themselves when needed. The viewer never persists: state.layout keeps its
  // original coordinates until the editor actually saves.
  const columns = state.layoutColumns || GRID_COLUMNS;
  if (mode === 'edit') {
    grid = initEditor($('grid-container'), state.layout, { onSave: saveLayout, columns });
    renderPalette($('palette-list'), state.widgets, (type) => {
      // Client-side cap (review C3): mirrors server MAX_ITEMS — adding to a
      // full layout must fail with a visible message HERE, not silently at
      // PUT time (editor.addWidget re-checks, this keeps state.layout honest).
      if (state.layout.length >= MAX_ITEMS) {
        toast(`Cannot add widget: layout is full (max ${MAX_ITEMS} items)`, 'error');
        return;
      }
      grid.addWidget(type);
    });
  } else {
    grid = renderViewer($('grid-container'), state.layout, { columns });
  }
}

function saveLayout(items) {
  state.layout = items;
  // The editor grid always runs at 32 columns (legacy layouts are migrated at
  // init, before any save can happen) → persist the migrated coordinates with
  // the columns field so the next load skips the migration.
  state.layoutColumns = GRID_COLUMNS;
  // Multiple pages: the save MUST target the page the grid currently edits
  // (explicit pageId — the server replaces THAT page's items without ever
  // switching the active one). Read at call time so a page switch that
  // happened between the edit and the debounced save can never misroute it.
  const pageId = state.activePageId || undefined;
  // Review C3: persistence failures are NEVER swallowed. Two pre-checks plus
  // a toasting catch keep the UI and the server from diverging silently:
  //  - body > 256 KB would 413 server-side (limit duplicated above);
  //  - > MAX_ITEMS would 400 server-side (the palette already blocks adding,
  //    this covers layouts that were already over the cap at load).
  const body = JSON.stringify({ items, columns: GRID_COLUMNS, pageId });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    toast('Save failed: layout is too large (server limit 256 KB). Remove widgets or shorten notes.', 'error');
    return Promise.resolve();
  }
  // The returned promise lets the page-switch flush await the actual PUT
  // (ordering: the flushed save must land BEFORE PUT /api/layout/active).
  return api.put('/api/layout', { items, columns: GRID_COLUMNS, pageId })
    .then((res) => {
      // Converge on the server's sanitized items (e.g. h clamped to 18 rows)
      // so the client can never drift from what is actually on disk.
      if (Array.isArray(res?.items)) state.layout = res.items;
      // Item counts (and a possibly server-clamped columns/active id) follow.
      // NOTE: no renderTabs() here — the tab row displays only names + the
      // active state (itemCount lives in the title tooltip only), and a
      // silent row rebuild mid-interaction would cancel an armed delete
      // confirmation or an open rename input for nothing. The row refreshes
      // on its own triggers (setMode / switchPage / page mutations).
      if (Array.isArray(res?.pages)) state.pages = res.pages;
      if (Number(res?.columns) > 0) state.layoutColumns = Number(res.columns);
      if (res?.activePageId) state.activePageId = res.activePageId;
    })
    .catch((err) => toast(err.message || 'Failed to save layout', 'error'));
}

// ---- Page switching (multiple pages, lot C+D) -------------------------------
/**
 * Switch the active dashboard page. Allowed in BOTH modes (view + edit);
 * creation/rename/delete stay edit-only (ui/tabs.js).
 *
 * ORDER IS CRITICAL (the 500 ms debounce window):
 *   1. FLUSH the editor's pending debounced save (and cancel its timer) —
 *      it PUTs the CURRENT page's items with an explicit pageId, so it must
 *      land while state.activePageId still points at the old page. A save
 *      firing AFTER the switch would carry the OLD items under the NEW
 *      active page and silently move them across pages.
 *   2. PUT /api/layout/active {pageId} — ONE round-trip: the server switches
 *      the active page and returns its items + the fresh page list.
 *   3. destroyGrid() — every widget's timers/observers go through the
 *      existing disposeWidget mechanism (editor/viewer destroy).
 *   4. setMode(current mode) — rebuilds the grid through the SAME path as
 *      the initial load: initEditor/renderViewer re-apply normalizeItems()
 *      (geometry hardening + search h:1→h:2) and the legacy 12→32 column
 *      migration client-side, because the server NEVER re-scales
 *      coordinates (columns is global to the file) and a joined page may
 *      still be stored in 12-column coordinates.
 *   updatePreviewScale() + syncBackgroundScope() run inside setMode, and
 *   renderTabs() refreshes the active-tab highlight. NO animation: the
 *   geometry must be final from the first frame (gridstack reads the
 *   container size right after init).
 */
async function switchPage(pageId) {
  if (!pageId || switchingPage) return;
  if (pageId === state.activePageId) return; // re-click the active tab: no-op
  switchingPage = true;
  try {
    // 1) flush (awaitable — saveLayout resolves after the PUT settles; it
    //    toasts on failure itself, a failed save must not block navigation).
    try {
      await grid?.flush?.();
    } catch {
      /* already toasted */
    }
    // 2) single round-trip switch
    const res = await api.put('/api/layout/active', { pageId });
    state.activePageId = res.activePageId;
    if (Array.isArray(res.pages)) state.pages = res.pages;
    state.layout = Array.isArray(res.items) ? res.items : [];
    if (Number(res.columns) > 0) state.layoutColumns = Number(res.columns);
    // 3+4) teardown + rebuild (same normalization path as initial load).
    setMode(state.mode);
  } catch (err) {
    toast(err.message || 'Failed to switch page', 'error');
  } finally {
    switchingPage = false;
  }
}

// ---- Auth forms ------------------------------------------------------------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('login-error').textContent = '';
  try {
    const res = await api.post('/api/auth/login', {
      user: fd.get('user'),
      password: fd.get('password'),
    });
    api.setToken(res.token);
    state.user = res.user;
    showDashboard();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('setup-error').textContent = '';
  if (fd.get('password') !== fd.get('confirm')) {
    $('setup-error').textContent = 'Passwords do not match';
    return;
  }
  try {
    const res = await api.post('/api/auth/setup', {
      user: fd.get('user'),
      password: fd.get('password'),
    });
    api.setToken(res.token);
    state.user = res.user;
    showDashboard();
  } catch (err) {
    $('setup-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* ignore */
  }
  api.setToken(null);
  state.user = null;
  destroyGrid();
  setBackgroundHost(null); // back to full-viewport background (frame is gone)
  showLogin();
});

$('toggle-mode').addEventListener('click', () => {
  setMode(state.mode === 'edit' ? 'view' : 'edit');
});

// ---- Widget config changes outside the ⚙ modal (review C4) -----------------
// Widgets may persist config changes themselves (notes: inline textarea →
// PATCH /api/layout/items/:id/config). Broadcast via 'homy:widget-config'
// (see widgets/notes.js), this keeps BOTH sources of truth in sync so a later
// full-layout PUT can never overwrite the fresh config with a stale copy:
//  - state.layout: the next initEditor/renderViewer must show the new text;
//  - the editor's meta Map (via applyConfig): the next serialize() must
//    include it. In view mode there is no editor — state.layout is enough.
window.addEventListener('homy:widget-config', (e) => {
  const { id, config } = e.detail || {};
  if (!id || !config || typeof config !== 'object') return;
  const item = state.layout.find((i) => i.id === id);
  if (item) item.config = { ...(item.config || {}), ...config };
  grid?.applyConfig?.(id, config);
});

// ---- Dashboard pages tab strip (multiple pages, lot C+D) --------------------
// The row itself is rendered by ui/tabs.js into the reserved #topbar-tabs
// slot; main.js owns the navigation/flush/rebuild pieces it needs:
//  - onSwitch: page switch (the ordered flush→PUT /active→rebuild flow above);
//  - onFlush: the editor's awaitable pending-save flush (before delete/switch);
//  - onRebuild: full grid rebuild after a state change that swapped the active
//    page's items (deletion of the active page → server fallback). setMode
//    already runs destroyGrid + updatePreviewScale + syncBackgroundScope +
//    renderTabs in the right order.
initTabs({
  onSwitch: (pageId) => switchPage(pageId),
  onFlush: () => grid?.flush?.(),
  onRebuild: () => setMode(state.mode),
});

// ---- Editor toolbar: Background + Theme (lot 3) -----------------------------

function updateThemeButton() {
  const btn = $('theme-btn');
  if (!btn) return;
  const t = getTheme();
  btn.textContent = `Theme: ${t === 'dark' ? 'Dark' : 'Light'}`;
  btn.classList.toggle('active', t === 'light');
}

$('theme-btn').addEventListener('click', async () => {
  const previous = getTheme();
  const next = otherTheme();
  try {
    await switchTheme(next, state.settings.background, previous);
    state.settings = { ...state.settings, theme: next };
    updateThemeButton();
  } catch (err) {
    toast(err.message || 'Failed to save theme', 'error');
  }
});

$('bg-btn').addEventListener('click', () => {
  openBackgroundModal({
    settings: state.settings,
    onSaved: (next) => {
      state.settings = next;
      applyBackground(next.background);
    },
  });
});

// If the token expires mid-session, return to login.
window.addEventListener('auth:expired', () => {
  api.setToken(null);
  state.user = null;
  destroyGrid();
  setBackgroundHost(null);
  showLogin();
});

// ---- Bootstrap -------------------------------------------------------------

// Recompute the edit-preview dezoom whenever the available area changes
// (window resize, topbar reflow, palette docking). Observing #dashboard-body
// covers window resizes; the palette docking itself is handled explicitly in
// setMode(). updatePreviewScale() is idempotent, so double fires are harmless.
// syncBackgroundScope() runs after it because a resize can toggle the frame
// (fallback threshold) and the background must follow the new host.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    // Topbar height can wrap/change with the width: re-measure it FIRST so the
    // collapse margin and the edit-preview dezoom both use the fresh value.
    updateTopbarHeight();
    // Re-pin the canvas width (the wrap resizes with the body — topbar
    // animation, window resize, palette docking) BEFORE the dezoom math.
    updateCanvasWidth();
    updatePreviewScale();
    syncBackgroundScope();
  }).observe($('dashboard-body'));
}

async function boot() {
  try {
    const status = await api.get('/api/auth/status');
    if (status.firstRun) {
      showSetup();
      return;
    }
  } catch {
    showLogin();
    return;
  }

  if (api.token) {
    try {
      const me = await api.get('/api/auth/me');
      state.user = me.user;
      showDashboard();
      return;
    } catch {
      /* fall through to login */
    }
  }
  showLogin();
}

boot();
