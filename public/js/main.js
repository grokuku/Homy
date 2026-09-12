import { api } from './api.js';
import { state } from './state.js';
import { renderViewer } from './grid/viewer.js';
import { initEditor, renderPalette } from './grid/editor.js';
import { GRID_COLUMNS } from './grid/config.js';
import { getTheme, otherTheme, switchTheme, syncFromServer } from './ui/theme.js';
import { applyBackground } from './backgrounds/manager.js';
import { openBackgroundModal } from './ui/backgroundModal.js';
import { toast } from './ui/toast.js';

const $ = (id) => document.getElementById(id);

let grid = null; // current grid instance (viewer gridstack or editor handle)

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
  // happens on every view/edit switch). Re-create a fresh container if needed.
  let container = $('grid-container');
  if (container) {
    container.replaceChildren();
  } else {
    container = document.createElement('div');
    container.id = 'grid-container';
    container.className = 'grid-stack';
    $('grid-wrap').appendChild(container);
  }
}

function setMode(mode) {
  state.mode = mode;
  const btn = $('toggle-mode');
  btn.textContent = mode === 'edit' ? 'Done' : 'Edit';
  btn.classList.toggle('active', mode === 'edit');
  $('editor-palette').classList.toggle('hidden', mode !== 'edit');
  $('grid-wrap').classList.toggle('with-palette', mode === 'edit');

  destroyGrid();
  // Both grids initialize at the SAVED column count and migrate to 32
  // themselves when needed. The viewer never persists: state.layout keeps its
  // original coordinates until the editor actually saves.
  const columns = state.layoutColumns || GRID_COLUMNS;
  if (mode === 'edit') {
    grid = initEditor($('grid-container'), state.layout, { onSave: saveLayout, columns });
    renderPalette($('palette-list'), state.widgets, (type) => grid.addWidget(type));
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
  api.put('/api/layout', { items, columns: GRID_COLUMNS }).catch(() => {});
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
  showLogin();
});

$('toggle-mode').addEventListener('click', () => {
  setMode(state.mode === 'edit' ? 'view' : 'edit');
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
  showLogin();
});

// ---- Bootstrap -------------------------------------------------------------

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
