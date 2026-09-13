import { el } from '../util.js';
import { api } from '../api.js';
import { toast } from '../ui/toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { catalog } from './catalog.js';
import { buildIconNode } from './button.js';
import { openElementFormModal } from '../ui/elementsModal.js';

/**
 * Element picker (LOT 4, priority 1) — a compact HolafModal that lists the
 * GLOBAL catalogue (`catalog`) with a live text filter and lets the caller
 * pick one element to pose as a `button` inside a `group`.
 *
 *   - The list comes from the shared `catalog` cache (`catalog.load()`), so a
 *     group that opens the picker never issues a second catalogue request.
 *   - « + Create new… » opens the REUSED element form (openElementFormModal,
 *     lot 3) stacked on top; on success the freshly created element is picked
 *     immediately, so the user gets a tile without a second round-trip.
 *   - Each row carries a 2-step Delete (same armed-confirmation pattern as the
 *     catalogue screen / tabs). A 409 means the element is still referenced by
 *     a group button; the toast explains and points to the Elements screen.
 *
 * `onPick(element)` is called once with the chosen catalogue entry; the picker
 * then closes itself.
 */

const CONFIRM_MS = 3000; // 2-step delete: window before the arm reverts

export function openElementPicker({ title = 'Choose element', onPick } = {}) {
  if (typeof onPick !== 'function') return;
  if (document.getElementById('element-picker-modal')) return; // already open

  let elements = [];

  const countEl = el('span', 'picker-count muted', '');
  const search = el('input', 'picker-search', null, {
    type: 'search',
    placeholder: 'Search elements…',
    'data-holaf-autofocus': '1',
  });
  const list = el('div', 'picker-list');
  const content = el('div', 'picker-body');
  content.append(search, list);

  let ctrl = null;
  let confirm = null; // armed delete: { id, btn, timer }

  const pick = (element) => {
    if (!element) return;
    ctrl?.close();
    onPick(element);
  };

  // ---- 2-step delete (reuses the catalogue's contract) -----------------------

  function disarm() {
    if (!confirm) return;
    clearTimeout(confirm.timer);
    confirm.btn.classList.remove('confirm');
    confirm.btn.textContent = '✕';
    confirm.btn.title = 'Delete element';
    confirm = null;
  }

  function arm(item, btn) {
    disarm();
    btn.classList.add('confirm');
    btn.textContent = 'Confirm?';
    btn.title = 'Click again to confirm deletion';
    confirm = { id: item.id, btn, timer: setTimeout(disarm, CONFIRM_MS) };
  }

  async function remove(item) {
    try {
      await api.del(`/api/elements/${encodeURIComponent(item.id)}`);
      toast('Element deleted', 'success');
      await catalog.refresh();
      elements = catalog.list();
      render();
    } catch (err) {
      if (err.status === 409) {
        toast('Element is used by a group button — remove that button first', 'error');
      } else {
        toast(err.message || 'Failed to delete element', 'error');
      }
    }
  }

  // ---- rendering -------------------------------------------------------------

  function render() {
    disarm();
    const q = search.value.trim().toLowerCase();
    const rows = elements.filter((e) =>
      !q ? true : [e.name, e.url, e.description].some((v) => String(v || '').toLowerCase().includes(q))
    );
    countEl.textContent = q ? `${rows.length} / ${elements.length}` : `${elements.length}`;
    list.replaceChildren();
    if (rows.length === 0) {
      list.appendChild(
        el('p', 'picker-empty muted', q ? 'No element matches your search.' : 'No elements yet — click “+ Create new…”.')
      );
      return;
    }
    for (const item of rows) list.appendChild(buildRow(item));
  }

  function buildRow(item) {
    const row = el('div', 'picker-row');
    row.dataset.id = item.id;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.title = item.url || item.description || item.name;

    const iconBox = el('div', 'picker-row-icon');
    iconBox.appendChild(buildIconNode(item.icon, item.name));

    const main = el('div', 'picker-row-main');
    main.appendChild(el('div', 'picker-row-name', item.name));
    if (item.url) main.appendChild(el('div', 'picker-row-url muted', item.url));
    else if (item.description) main.appendChild(el('div', 'picker-row-url muted', item.description));

    const badges = el('div', 'picker-row-badges');
    if (item.docky && (item.docky.agent || item.docky.container)) {
      badges.appendChild(el('span', 'badge badge-docky', 'Docky'));
    }
    if (item.healthCheck) badges.appendChild(el('span', 'badge badge-health', 'Health'));

    const del = el('button', 'picker-row-del', '✕', { type: 'button', title: 'Delete element' });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm?.id === item.id) {
        disarm();
        remove(item);
        return;
      }
      arm(item, del);
    });

    const choose = () => pick(item);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.picker-row-del')) return;
      choose();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose();
      }
    });

    row.append(iconBox, main, badges, del);
    return row;
  }

  search.addEventListener('input', render);

  ctrl = HolafModal.open({
    id: 'element-picker-modal',
    title,
    size: 'md',
    content,
    headerRight: countEl,
    onClose: () => disarm(),
    actions: [
      { label: 'Cancel', type: 'cancel' },
      {
        label: '+ Create new…',
        type: 'primary',
        // Do NOT close the picker: the element form opens stacked on top and
        // the picker must still be there if the user cancels the form.
        close: false,
        onClick: () => {
          disarm();
          openElementFormModal(null, (created) => {
            if (created?.id) pick(created);
            else {
              elements = catalog.list();
              render();
            }
          });
        },
      },
    ],
  });

  // Catalogue is cached after the first session load; `load()` resolves from
  // cache immediately when already loaded, otherwise fetches once (tolerant:
  // never rejects) before painting the rows.
  catalog.load().then(() => {
    elements = catalog.list();
    render();
  });
  render();
}
