import { api } from './api.js';
import { state } from './state.js';
import { renderViewer } from './grid/viewer.js';
import { initEditor, renderPalette } from './grid/editor.js';

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
    const [layoutRes, widgetsRes] = await Promise.all([
      api.get('/api/layout'),
      api.get('/api/widgets'),
    ]);
    state.layout = layoutRes.items || [];
    state.widgets = widgetsRes.widgets || [];
  } catch {
    state.layout = [];
    state.widgets = [];
  }

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
  if (mode === 'edit') {
    grid = initEditor($('grid-container'), state.layout, { onSave: saveLayout });
    renderPalette($('palette-list'), state.widgets, (type) => grid.addWidget(type));
  } else {
    grid = renderViewer($('grid-container'), state.layout);
  }
}

function saveLayout(items) {
  state.layout = items;
  api.put('/api/layout', { items }).catch(() => {});
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
