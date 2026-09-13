import { el } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';

/**
 * Icon library picker (LOT 7) — search the online icon service, INSTALL icons
 * locally, browse what is installed, and hand a `local:<slug>` reference back
 * to the caller (the element form's « Browse icons » button).
 *
 *   openIconsPicker({ onPick(entry) })   entry = installed icon index record
 *                                        `{ slug, id, name, collection,
 *                                           license, author, installedAt }`
 *
 * LAYOUT (as validated)
 *   - two tabs: « Search » and « Installed (n) »;
 *   - Search: query field + example chips, a « Permissive only » switch
 *     (checked by default — non-permissive results are masked), a result GRID
 *     (inline SVG thumbnail + name + license badge) and a PREVIEW panel (large
 *     icon, name, collection, license, author) with an « Install locally »
 *     button that flips to « Installed » / « Use this icon »;
 *   - Installed: the local library with its TRACEABILITY (collection, license,
 *     author) and a per-row delete.
 *
 * SVGs are INLINED (the server returns them in the search payload; installed
 * icons are fetched through the JWT-gated `GET /api/icons/:slug/svg`). No public
 * icon URL is ever exposed to the page.
 */

const MAX_RESULTS = 24;
const SEARCH_DEBOUNCE_MS = 320;
const SAMPLE_QUERIES = ['server', 'home', 'music', 'database', 'calendar', 'bookmark'];

export function openIconsPicker({ onPick } = {}) {
  if (document.getElementById('icons-picker-modal')) return;

  let tab = 'search'; // 'search' | 'installed'
  let permissiveOnly = true;
  let results = [];
  let installed = [];
  let selected = null; // search result shown in the preview
  let seq = 0; // search generation (drops stale responses)
  let debounceTimer = 0;
  let loading = false;

  const countEl = el('span', 'icons-count muted', '');
  const content = el('div', 'icons-body');

  const tabsEl = el('div', 'segmented icons-tabs');
  const searchTab = el('button', 'segmented-item active', 'Search', { type: 'button' });
  const installedTab = el('button', 'segmented-item', 'Installed (0)', { type: 'button' });
  tabsEl.append(searchTab, installedTab);

  const searchPane = el('div', 'icons-pane icons-search-pane');
  const installedPane = el('div', 'icons-pane icons-installed-pane hidden');

  // ---- search pane ----------------------------------------------------------

  const queryInput = el('input', 'icons-query', null, {
    type: 'search',
    placeholder: 'Search icons…',
    'data-holaf-autofocus': '1',
  });
  const permissiveCb = el('input', null, null, { type: 'checkbox' });
  permissiveCb.checked = true;
  const permissiveLabel = el('label', 'icons-permissive');
  permissiveLabel.append(permissiveCb, el('span', null, 'Permissive only'));

  const searchRow = el('div', 'icons-search-row');
  searchRow.append(queryInput, permissiveLabel);

  const samplesRow = el('div', 'icons-samples');
  for (const sample of SAMPLE_QUERIES) {
    const chip = el('button', 'icons-chip', sample, { type: 'button' });
    chip.addEventListener('click', () => {
      queryInput.value = sample;
      runSearch();
    });
    samplesRow.appendChild(chip);
  }

  const statusEl = el('p', 'icons-status muted', 'Search an icon collection to get started.');
  const gridEl = el('div', 'icons-grid');

  const previewEl = el('aside', 'icons-preview');
  const splitEl = el('div', 'icons-split');
  splitEl.append(gridEl, previewEl);

  searchPane.append(searchRow, samplesRow, statusEl, splitEl);

  // ---- installed pane -------------------------------------------------------

  const installedList = el('div', 'icons-installed-list');
  installedPane.appendChild(installedList);

  content.append(tabsEl, searchPane, installedPane);

  // ---- svg helpers ----------------------------------------------------------

  function svgNode(svgText) {
    if (typeof svgText !== 'string' || !svgText.trim()) return null;
    try {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const svgEl = doc.documentElement;
      if (svgEl?.nodeName === 'svg' && !doc.querySelector('parsererror')) {
        return document.importNode(svgEl, true);
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  function iconBox(svgText, label, cls) {
    const box = el('div', cls);
    const node = svgNode(svgText);
    if (node) box.appendChild(node);
    else box.appendChild(el('span', 'icons-fallback', initials(label)));
    return box;
  }

  // ---- search flow ----------------------------------------------------------

  function scheduleSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  }

  async function runSearch() {
    const q = queryInput.value.trim();
    if (!q) {
      results = [];
      selected = null;
      statusEl.textContent = 'Search an icon collection to get started.';
      renderGrid();
      renderPreview();
      return;
    }
    const id = ++seq;
    loading = true;
    statusEl.hidden = false;
    statusEl.textContent = 'Searching…';
    renderGrid();
    try {
      const res = await api.get(
        `/api/icons/search?q=${encodeURIComponent(q)}&limit=${MAX_RESULTS}${permissiveOnly ? '' : '&all=1'}`
      );
      if (id !== seq) return; // a newer search superseded this one
      results = Array.isArray(res?.icons) ? res.icons : [];
      if (!selected || !results.some((r) => r.id === selected.id)) selected = results[0] || null;
      statusEl.textContent = results.length
        ? `${results.length} result${results.length === 1 ? '' : 's'}`
        : 'No matching permissive icon.';
    } catch (err) {
      if (id !== seq) return;
      results = [];
      selected = null;
      statusEl.textContent = err.message || 'Search failed';
      toast(err.message || 'Icon search failed', 'error');
    } finally {
      if (id === seq) {
        loading = false;
        renderGrid();
        renderPreview();
      }
    }
  }

  // ---- installed flow -------------------------------------------------------

  async function refreshInstalled({ notify = false } = {}) {
    try {
      const res = await api.get('/api/icons');
      installed = Array.isArray(res?.icons) ? res.icons : [];
      renderInstalled();
      renderCount();
      renderGrid();
      renderPreview();
    } catch (err) {
      if (notify) toast(err.message || 'Failed to load installed icons', 'error');
    }
  }

  async function install(entry) {
    if (!entry || entry.permissive === false) return;
    try {
      const saved = await api.post('/api/icons/install', { id: entry.id });
      if (!installed.some((i) => i.id === saved.id)) installed.unshift(saved);
      renderInstalled();
      renderCount();
      renderGrid();
      renderPreview();
      toast(`“${saved.name}” installed`, 'success');
      // Hand the reference back to the caller (fills the element form icon).
      onPick?.(saved);
    } catch (err) {
      toast(err.message || 'Failed to install icon', 'error');
    }
  }

  async function remove(entry) {
    try {
      await api.del(`/api/icons/${encodeURIComponent(entry.slug)}`);
      installed = installed.filter((i) => i.slug !== entry.slug);
      renderInstalled();
      renderCount();
      renderGrid();
      renderPreview();
      toast(`“${entry.name}” removed`, 'success');
    } catch (err) {
      toast(err.message || 'Failed to remove icon', 'error');
    }
  }

  // ---- rendering ------------------------------------------------------------

  function isInstalled(id) {
    return installed.find((i) => i.id === id) || null;
  }

  function renderCount() {
    countEl.textContent = `${installed.length} installed`;
    installedTab.textContent = `Installed (${installed.length})`;
  }

  function renderTabs() {
    searchTab.classList.toggle('active', tab === 'search');
    installedTab.classList.toggle('active', tab === 'installed');
    searchPane.classList.toggle('hidden', tab !== 'search');
    installedPane.classList.toggle('hidden', tab !== 'installed');
    if (tab === 'installed') refreshInstalled();
  }

  function renderGrid() {
    gridEl.replaceChildren();
    statusEl.hidden = results.length > 0;
    if (!results.length) return;
    for (const item of results) {
      gridEl.appendChild(buildResultCard(item));
    }
  }

  function buildResultCard(item) {
    const card = el('button', 'icons-card', null, { type: 'button' });
    card.dataset.id = item.id;
    card.classList.toggle('selected', selected?.id === item.id);
    card.classList.toggle('non-permissive', item.permissive === false);
    card.title = `${item.name} · ${item.collection}`;

    card.appendChild(iconBox(item.svg, item.name, 'icons-card-icon'));

    const meta = el('div', 'icons-card-meta');
    meta.appendChild(el('span', 'icons-card-name', item.name));
    const badges = el('span', 'icons-card-badges');
    badges.appendChild(el('span', 'badge', item.license || 'No license'));
    if (isInstalled(item.id)) badges.appendChild(el('span', 'badge badge-installed', 'Installed'));
    meta.appendChild(badges);
    card.appendChild(meta);

    card.addEventListener('click', () => {
      selected = item;
      renderGrid();
      renderPreview();
    });
    return card;
  }

  function renderPreview() {
    previewEl.replaceChildren();
    if (!selected) {
      previewEl.appendChild(el('p', 'icons-preview-empty muted', 'Select an icon to preview it.'));
      return;
    }
    const item = selected;
    previewEl.appendChild(iconBox(item.svg, item.name, 'icons-preview-icon'));

    const body = el('div', 'icons-preview-body');
    body.appendChild(el('div', 'icons-preview-name', item.name));
    body.appendChild(el('div', 'icons-preview-id muted', item.id));
    const dl = el('dl', 'icons-preview-meta');
    dl.appendChild(metaRow('Collection', item.collection || item.prefix));
    dl.appendChild(metaRow('License', item.license || 'Unknown'));
    dl.appendChild(metaRow('Author', item.author || '—'));
    body.appendChild(dl);
    previewEl.appendChild(body);

    const actions = el('div', 'icons-preview-actions');
    const installedEntry = isInstalled(item.id);
    if (item.permissive === false) {
      actions.appendChild(el('span', 'icons-note', 'Non-permissive license — not installable.'));
    } else if (installedEntry) {
      const useBtn = el('button', 'btn btn-primary', 'Use this icon', { type: 'button' });
      useBtn.addEventListener('click', () => onPick?.(installedEntry));
      const done = el('span', 'badge badge-installed', 'Installed');
      actions.append(done, useBtn);
    } else {
      const installBtn = el('button', 'btn btn-primary', 'Install locally', { type: 'button' });
      installBtn.addEventListener('click', () => {
        installBtn.disabled = true;
        install(item);
      });
      actions.appendChild(installBtn);
    }
    previewEl.appendChild(actions);
  }

  function metaRow(label, value) {
    const wrap = el('div', 'icons-meta-row');
    wrap.appendChild(el('dt', null, label));
    wrap.appendChild(el('dd', null, value));
    return wrap;
  }

  function renderInstalled() {
    installedList.replaceChildren();
    if (!installed.length) {
      installedList.appendChild(
        el('p', 'icons-empty muted', 'No icons installed yet — search and install one.')
      );
      return;
    }
    for (const entry of installed) {
      installedList.appendChild(buildInstalledRow(entry));
    }
  }

  function buildInstalledRow(entry) {
    const row = el('div', 'icons-installed-row');
    row.dataset.slug = entry.slug;

    const box = el('div', 'icons-installed-icon');
    // Installed icons are stored server-side: fetch the SVG via the API (cached
    // by the browser through the Cache-Control header), then inline it.
    api
      .getText(`/api/icons/${encodeURIComponent(entry.slug)}/svg`)
      .then((svg) => {
        const node = svgNode(svg);
        if (node) box.replaceChildren(node);
      })
      .catch(() => {
        box.replaceChildren(el('span', 'icons-fallback', initials(entry.name)));
      });

    const main = el('div', 'icons-installed-main');
    main.appendChild(el('div', 'icons-installed-name', entry.name));
    const badges = el('div', 'icons-installed-badges');
    badges.appendChild(el('span', 'badge', entry.collection));
    if (entry.license) badges.appendChild(el('span', 'badge', entry.license));
    if (entry.author) badges.appendChild(el('span', 'badge badge-author', entry.author));
    main.appendChild(badges);

    const actions = el('div', 'icons-installed-actions');
    const useBtn = el('button', 'btn', 'Use', { type: 'button', title: 'Use this icon' });
    useBtn.addEventListener('click', () => onPick?.(entry));
    const delBtn = el('button', 'btn btn-ghost', 'Delete', { type: 'button', title: 'Remove this icon' });
    delBtn.addEventListener('click', () => remove(entry));
    actions.append(useBtn, delBtn);

    row.append(box, main, actions);
    return row;
  }

  // ---- events ---------------------------------------------------------------

  queryInput.addEventListener('input', scheduleSearch);
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounceTimer);
      runSearch();
    }
  });
  permissiveCb.addEventListener('change', () => {
    permissiveOnly = permissiveCb.checked;
    if (queryInput.value.trim()) runSearch();
  });
  searchTab.addEventListener('click', () => {
    tab = 'search';
    renderTabs();
  });
  installedTab.addEventListener('click', () => {
    tab = 'installed';
    renderTabs();
  });

  HolafModal.open({
    id: 'icons-picker-modal',
    title: 'Icons',
    size: 'xl',
    content,
    headerRight: countEl,
    onClose: () => clearTimeout(debounceTimer),
    actions: [{ label: 'Close', type: 'cancel' }],
  });

  renderCount();
  renderTabs();
  renderGrid();
  renderPreview();
  refreshInstalled();
  queryInput.focus();
}

function initials(label) {
  return (label || '')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
