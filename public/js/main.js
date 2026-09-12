import { api } from './api.js';
import { state } from './state.js';
import { renderViewer } from './grid/viewer.js';
import { initEditor, renderPalette } from './grid/editor.js';
import { GRID_COLUMNS, MAX_ITEMS } from './grid/config.js';
import { getTheme, otherTheme, switchTheme, syncFromServer } from './ui/theme.js';
import { applyBackground, setBackgroundHost } from './backgrounds/manager.js';
import { openBackgroundModal } from './ui/backgroundModal.js';
import { toast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);

let grid = null; // current grid instance (viewer gridstack or editor handle)

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
  // Review C3: persistence failures are NEVER swallowed. Two pre-checks plus
  // a toasting catch keep the UI and the server from diverging silently:
  //  - body > 256 KB would 413 server-side (limit duplicated above);
  //  - > MAX_ITEMS would 400 server-side (the palette already blocks adding,
  //    this covers layouts that were already over the cap at load).
  const body = JSON.stringify({ items, columns: GRID_COLUMNS });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    toast('Save failed: layout is too large (server limit 256 KB). Remove widgets or shorten notes.', 'error');
    return;
  }
  api.put('/api/layout', { items, columns: GRID_COLUMNS })
    .then((res) => {
      // Converge on the server's sanitized items (e.g. h clamped to 18 rows)
      // so the client can never drift from what is actually on disk.
      if (Array.isArray(res?.items)) state.layout = res.items;
    })
    .catch((err) => toast(err.message || 'Failed to save layout', 'error'));
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
