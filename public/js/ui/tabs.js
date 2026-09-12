import { api } from '../api.js';
import { state } from '../state.js';
import { el } from '../util.js';
import { toast } from './toast.js';

/**
 * Dashboard pages tab strip (multiple-pages chantier, lot C+D).
 *
 * Renders INTO the reserved #topbar-tabs slot inside the topbar (index.html).
 * The row is shown/hidden here; the topbar itself stays owned by main.js
 * (applyTopbarState) — the row lives inside it, so revealing the bar in VIEW
 * mode (right-click) reveals the tabs with it.
 *
 * VISIBILITY CONTRACT (user decisions):
 *   - EDIT mode: ALWAYS visible (otherwise there is no way to create the
 *     second page) — includes the trailing « + » button.
 *   - VIEW mode: visible ONLY when there are ≥ 2 pages (a single-page
 *     dashboard gains nothing from a one-tab strip).
 *
 * Interactions (all mutations are EDIT-only):
 *   - click a tab      → hooks.onSwitch(pageId) (main.js switchPage)
 *   - dblclick a tab   → inline rename input (Enter/blur commit, Esc cancel)
 *     Double-click detection uses the click event's `detail` counter, NOT a
 *     dblclick listener: on an INACTIVE tab the 1st click triggers the page
 *     switch, which re-renders the row — a dblclick listener bound on the tab
 *     element dies with it (the 2nd click lands on fresh DOM and the native
 *     dblclick is never dispatched there). `detail` is computed by the input
 *     pipeline from click time+position only, so the 2nd click of a real
 *     double-click carries detail=2 EVEN after the row was rebuilt → one
 *     double-click opens the rename on the (now re-rendered) tab, while the
 *     simple click stays instant (no delay, no timer).
 *   - « + »            → POST /api/layout/pages, then switch to the new page
 *   - hover ✕ (2-step) → first click arms a red ~3 s confirmation (no modal),
 *                        second click deletes; blur/Escape/new click elsewhere
 *                        cancels. Deleting the ACTIVE page relies on the
 *                        server's deterministic fallback (first remaining page)
 *                        carried by the DELETE response (activePageId + items).
 *
 * All DOM is built with textContent/attributes only (no innerHTML) — page
 * names are user data.
 */

const CONFIRM_MS = 3000; // 2-step delete: window before the ✕ reverts to armed-off

const hooks = { onSwitch: null, onRebuild: null, onFlush: null };
let container = null;
let confirm = null; // armed 2-step delete: { id, del, timer }
let creating = false; // « + » in flight (double-click guard)
let renaming = false; // inline rename input open

export function initTabs(next) {
  container = document.getElementById('topbar-tabs');
  if (!container) return;
  Object.assign(hooks, next);
  // Delegated cancellation for the armed delete: focus leaving the ✕ or
  // Escape anywhere in the row disarms it (blur/Escape cancellation).
  container.addEventListener('focusout', (e) => {
    if (confirm && e.target === confirm.del && e.relatedTarget !== confirm.del) disarmConfirm();
  });
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') disarmConfirm();
  });
}

/** Render the row from state (pages/activePageId/mode). Idempotent. */
export function renderTabs() {
  if (!container) return;
  if (renaming) {
    // An inline rename input is open: rebuilding the row would destroy the
    // user's typing mid-edit. The input path always closes itself through
    // finish() (Enter/blur/Escape) which re-renders; a rare external re-render
    // (background save…) must not eat the input — skip this pass, the next
    // one after the rename will pick the fresh state up.
    return;
  }
  disarmConfirm();
  const edit = state.mode === 'edit';
  const visible = edit || (state.pages?.length || 0) >= 2;
  container.classList.toggle('hidden', !visible);
  if (!visible) {
    container.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const page of state.pages) frag.appendChild(buildTab(page, edit));
  if (edit) frag.appendChild(buildAddButton());
  container.replaceChildren(frag);
}

// ---- Tab button -------------------------------------------------------------

function buildTab(page, edit) {
  const active = page.id === state.activePageId;
  const tab = el('button', active ? 'topbar-tab active' : 'topbar-tab', null, {
    type: 'button',
    title: page.name, // full name — the label itself is ellipsized
  });
  if (active) tab.setAttribute('aria-current', 'page');
  tab.appendChild(el('span', 'topbar-tab-label', page.name));
  if (edit) tab.appendChild(buildDeleteButton(page));
  tab.addEventListener('click', (e) => {
    // A click that is NOT on the ✕ disarms an armed confirmation.
    disarmConfirm();
    // 2nd click of a double-click (see the header note): open the inline
    // rename INSTEAD of switching. On an inactive tab the 1st click already
    // switched and re-rendered the row — this handler then runs on the fresh
    // tab element, so `tab` is alive and startRename() can replace its
    // content. On the active tab nothing was rebuilt; same rename behavior
    // as the former dblclick listener. Keyboard-activated clicks (Enter on
    // the focused button) have detail 0 → they always stay plain switches.
    if (edit && e.detail >= 2) {
      e.preventDefault();
      startRename(page, tab);
      return;
    }
    hooks.onSwitch?.(page.id);
  });
  return tab;
}

// ---- Create (« + », edit only) ----------------------------------------------

function buildAddButton() {
  const add = el('button', 'topbar-tab-add', '+', {
    type: 'button',
    title: 'New page',
    'aria-label': 'New page',
  });
  add.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (creating) return; // in-flight guard (double click)
    creating = true;
    try {
      // No flush needed: a pending save PUTs with an explicit pageId, so it
      // targets the CURRENT active page regardless of what happens next.
      const res = await api.post('/api/layout/pages');
      // The new page becomes active through the standard switch flow
      // (PUT /api/layout/active returns its (empty) items + fresh page list).
      hooks.onSwitch?.(res.id);
    } catch (err) {
      toast(err.message || 'Failed to create page', 'error');
    } finally {
      creating = false;
    }
  });
  return add;
}

// ---- Delete (edit only, 2-step confirmation) ---------------------------------

function buildDeleteButton(page) {
  const del = el('button', 'topbar-tab-del', '✕', {
    type: 'button',
    title: 'Delete page',
    'aria-label': `Delete page ${page.name}`,
  });
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (confirm?.id === page.id) {
      // Second click inside the window → confirmed, delete for real.
      disarmConfirm();
      await deletePage(page);
      return;
    }
    // First click → arm the red confirmation (~3 s). No modal by design.
    disarmConfirm();
    del.classList.add('confirm');
    del.title = 'Click again to confirm deletion';
    confirm = {
      id: page.id,
      del,
      timer: setTimeout(() => disarmConfirm(), CONFIRM_MS),
    };
  });
  return del;
}

function disarmConfirm() {
  if (!confirm) return;
  clearTimeout(confirm.timer);
  confirm.del.classList.remove('confirm');
  confirm.del.title = 'Delete page';
  confirm = null;
}

async function deletePage(page) {
  if ((state.pages?.length || 0) <= 1) {
    toast('Cannot delete the last page', 'error');
    return;
  }
  const wasActive = page.id === state.activePageId;
  try {
    // FLUSH a pending debounced save FIRST: it targets THIS page explicitly
    // (pageId), so its edits must land before the page disappears — a flush
    // arriving after the DELETE would hit a 404.
    try {
      await hooks.onFlush?.();
    } catch {
      /* saveLayout already toasted; continue — the user asked to delete */
    }
    const res = await api.del(`/api/layout/pages/${page.id}`);
    // Server response carries everything (single round-trip): fresh page
    // list, new activePageId (deterministic fallback if the active page was
    // deleted) and the items/columns of the now-active page.
    if (Array.isArray(res.pages)) state.pages = res.pages;
    if (res.activePageId) state.activePageId = res.activePageId;
    if (Number(res.columns) > 0) state.layoutColumns = Number(res.columns);
    if (wasActive) {
      state.layout = Array.isArray(res.items) ? res.items : [];
      // Full rebuild through the SAME path as a page switch (setMode re-runs
      // destroyGrid/updatePreviewScale/syncBackgroundScope/renderTabs).
      hooks.onRebuild?.();
    } else {
      renderTabs(); // active page untouched → tabs only
    }
  } catch (err) {
    toast(err.message || 'Failed to delete page', 'error');
  }
}

// ---- Rename (edit only, inline input) ----------------------------------------

function startRename(page, tab) {
  if (renaming) return;
  renaming = true;
  disarmConfirm();
  const input = el('input', 'topbar-tab-input', null, {
    type: 'text',
    value: page.name,
    maxlength: '40', // server PAGE_NAME_MAX
    'aria-label': 'Page name',
  });
  tab.replaceChildren(input); // the whole tab becomes the input (no nested form controls in <button>)
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; // Enter fires blur → the guard keeps a single path
    done = true;
    renaming = false; // close the input path BEFORE any re-render
    const name = input.value.trim();
    if (commit && name && name !== page.name) {
      rename(page, name); // optimistic; reverts + toasts on failure
    } else {
      renderTabs(); // cancel (Esc, empty, unchanged) or nothing to do
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep Escape from disarming anything else / page nav
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  // Clicks inside the input must not reach the tab's switch handler.
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
}

async function rename(page, name) {
  const local = state.pages.find((p) => p.id === page.id);
  const previous = page.name;
  if (local) local.name = name; // optimistic (input blur must feel instant)
  renderTabs();
  try {
    const res = await api.patch(`/api/layout/pages/${page.id}`, { name });
    if (local && res?.name) local.name = res.name; // server-authoritative (trim)
    renderTabs();
  } catch (err) {
    if (local) local.name = previous; // revert
    toast(err.message || 'Failed to rename page', 'error');
    renderTabs();
  }
}