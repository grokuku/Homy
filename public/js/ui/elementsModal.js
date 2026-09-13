import { el } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { catalog } from '../elements/catalog.js';
import { buildIconNode } from '../elements/button.js';
import { buildField, collect } from './settingsModal.js';

/**
 * Elements catalogue screen (LOT 3) — CRUD UI for the GLOBAL element catalogue
 * (`elements.json` / `/api/elements`). Opened from the edit-mode topbar
 * (« Elements ») via main.js.
 *
 * LAYOUT
 *   - HolafModal shell (size "xl"), title "Elements" + a live « n / 200 »
 *     counter in the header.
 *   - A list of rows: icon preview (the EXACT tile icon — buildIconNode from
 *     elements/button.js), name, url, and the Docky / Health badges when set.
 *   - Footer action "New"; each row has "Edit" and a 2-step "Delete" (same
 *     armed-confirmation pattern as the tabs, no blocking modal).
 *
 * FORM (second, stacked HolafModal)
 *   The element form reuses the project's field builder (buildField/collect from
 *   ui/settingsModal.js): Name (required, 1..60 server-side), Icon (emoji /
 *   holaf:<name> / http(s) URL + a LIVE preview), URL, Description, Health check
 *   (toggle), and the raw Docky agent/container targets (the Docky-fed picker
 *   lands in lot 5). The footer Save is bound to the form through the HTML
 *   `form=` attribute — a real native submit (lot-2 lesson).
 *
 * DELETE
 *   `DELETE /api/elements/:id` returns 409 with the `pages` usage list when the
 *   element is referenced by a group button. Instead of a dry failure the modal
 *   shows a conflict panel listing those usages and offers « Force delete »
 *   (`?force=1`).
 *
 * MUTATIONS always `catalog.refresh()` so every rendered group re-draws with the
 * fresh catalogue, and re-fetch the list so the screen is never stale.
 *
 * ERRORS are never silent: {@link api} failures surface as toasts built from the
 * server's `{ error }` message (validation, 404, 413, 409…).
 */

const MAX_ELEMENTS = 200; // MUST mirror MAX_ELEMENTS in server/services/elements.service.js
const CONFIRM_MS = 3000; // 2-step delete: window before the arm reverts

// Field schema consumed by the shared builder. Keys are flat (the builder's
// contract); the two Docky parts are folded into `{ agent, container }` on save.
const FORM_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Jellyfin' },
  { key: 'icon', label: 'Icon', type: 'text', placeholder: 'Emoji, holaf:<name> or https://…' },
  { key: 'url', label: 'URL', type: 'url', placeholder: 'https://…' },
  { key: 'description', label: 'Description', type: 'textarea', rows: 2, placeholder: 'Optional' },
  { key: 'healthCheck', label: 'Health check', type: 'toggle', help: 'Delegate a health probe to Docky (wired in lot 5).' },
  { key: 'dockyAgent', label: 'Docky agent', type: 'text', placeholder: 'agent name', help: 'Target server — free text until the Docky picker lands (lot 5).' },
  { key: 'dockyContainer', label: 'Docky container', type: 'text', placeholder: 'container name', help: 'Target container — free text until the Docky picker lands (lot 5).' },
];

let formSeq = 0; // unique <form> ids when several forms are alive

/** Open the catalogue screen (idempotent — a second call focuses the open one). */
export function openElementsModal() {
  if (document.getElementById('elements-modal')) return;

  let elements = [];
  let max = MAX_ELEMENTS;
  let confirm = null; // armed 2-step delete: { id, btn, timer }

  const countEl = el('span', 'elements-count muted', '');
  const noticeEl = el('div', 'elements-notice hidden', null, { role: 'alert' });
  const listEl = el('div', 'elements-list');
  const content = el('div', 'elements-body');
  content.append(noticeEl, listEl);

  HolafModal.open({
    id: 'elements-modal',
    title: 'Elements',
    size: 'xl',
    content,
    headerRight: countEl,
    onClose: () => disarmConfirm(),
    actions: [
      { label: 'Close', type: 'cancel' },
      // close:false — the shared HolafModal action handler would otherwise
      // close THIS modal when opening the (stacked) element form.
      { label: 'New', type: 'primary', close: false, onClick: () => openElementFormModal(null, refresh) },
    ],
  });

  // ---- 2-step delete arm/disarm ----------------------------------------------

  function disarmConfirm() {
    if (!confirm) return;
    clearTimeout(confirm.timer);
    confirm.btn.classList.remove('confirm');
    confirm.btn.textContent = 'Delete';
    confirm.btn.title = 'Delete element';
    confirm = null;
  }

  function armConfirm(item, btn) {
    disarmConfirm();
    btn.classList.add('confirm');
    btn.textContent = 'Confirm?';
    btn.title = 'Click again to confirm deletion';
    confirm = { id: item.id, btn, timer: setTimeout(disarmConfirm, CONFIRM_MS) };
  }

  // ---- data + rendering ------------------------------------------------------

  async function refresh({ notify = true } = {}) {
    disarmConfirm();
    clearNotice();
    try {
      const res = await api.get('/api/elements');
      elements = Array.isArray(res?.elements) ? res.elements : [];
      max = Number(res?.max) > 0 ? Number(res.max) : MAX_ELEMENTS;
      render();
      // Keep the client catalogue (groups render from it) in lockstep.
      catalog.refresh();
    } catch (err) {
      if (notify) toast(err.message || 'Failed to load elements', 'error');
    }
  }

  function render() {
    disarmConfirm();
    countEl.textContent = `${elements.length} / ${max}`;
    listEl.replaceChildren();
    if (elements.length === 0) {
      listEl.appendChild(el('p', 'elements-empty muted', 'No elements yet — click “New” to add one.'));
      return;
    }
    for (const item of elements) listEl.appendChild(buildRow(item));
  }

  function buildRow(item) {
    const row = el('div', 'elements-row');
    row.dataset.id = item.id;

    const iconBox = el('div', 'elements-icon-box elements-row-icon');
    iconBox.appendChild(buildIconNode(item.icon, item.name));

    const main = el('div', 'elements-row-main');
    main.appendChild(el('div', 'elements-row-name', item.name));
    if (item.url) {
      main.appendChild(
        el('a', 'elements-row-url', item.url, {
          href: item.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        })
      );
    }
    if (item.description) main.appendChild(el('div', 'elements-row-desc muted', item.description));

    const badges = el('div', 'elements-row-badges');
    if (item.docky && (item.docky.agent || item.docky.container)) {
      const target = [item.docky.agent, item.docky.container].filter(Boolean).join(' / ');
      badges.appendChild(el('span', 'badge badge-docky', `Docky: ${target}`));
    }
    if (item.healthCheck) badges.appendChild(el('span', 'badge badge-health', 'Health'));

    const actions = el('div', 'elements-row-actions');
    const editBtn = el('button', 'btn', 'Edit', { type: 'button', title: 'Edit element' });
    editBtn.addEventListener('click', () => openElementFormModal(item, refresh));
    const delBtn = el('button', 'btn btn-ghost', 'Delete', { type: 'button', title: 'Delete element' });
    delBtn.addEventListener('click', () => {
      if (confirm?.id === item.id) {
        disarmConfirm();
        removeElement(item, false);
        return;
      }
      armConfirm(item, delBtn);
    });
    actions.append(editBtn, delBtn);

    row.append(iconBox, main, badges, actions);
    return row;
  }

  // ---- delete + 409 conflict -------------------------------------------------

  async function removeElement(item, force) {
    try {
      await api.del(`/api/elements/${encodeURIComponent(item.id)}${force ? '?force=1' : ''}`);
      toast('Element deleted', 'success');
      clearNotice();
      await refresh();
    } catch (err) {
      if (err.status === 409) {
        showConflict(item, Array.isArray(err.body?.pages) ? err.body.pages : []);
      } else {
        toast(err.message || 'Failed to delete element', 'error');
      }
    }
  }

  function showConflict(item, pages) {
    noticeEl.replaceChildren();
    noticeEl.classList.remove('hidden');
    noticeEl.appendChild(el('p', 'elements-notice-title', `“${item.name}” is referenced by other widgets`));
    noticeEl.appendChild(
      el('p', null, `It is used by ${pages.length} button${pages.length === 1 ? '' : 's'}:`)
    );
    const ul = el('ul', 'elements-usages');
    if (pages.length === 0) {
      ul.appendChild(el('li', null, 'Unknown usage location.'));
    } else {
      for (const usage of pages) {
        const where = usage?.name || usage?.pageId || 'page';
        const group = usage?.groupId ? ` · group ${String(usage.groupId).slice(0, 8)}` : '';
        ul.appendChild(el('li', null, `${where}${group}`));
      }
    }
    noticeEl.appendChild(ul);

    const actions = el('div', 'elements-notice-actions');
    const cancel = el('button', 'btn btn-ghost', 'Cancel', { type: 'button' });
    cancel.addEventListener('click', clearNotice);
    const forceBtn = el('button', 'btn btn-danger', 'Force delete', { type: 'button' });
    forceBtn.addEventListener('click', async () => {
      forceBtn.disabled = true;
      await removeElement(item, true);
      forceBtn.disabled = false;
    });
    actions.append(cancel, forceBtn);
    noticeEl.appendChild(actions);
  }

  function clearNotice() {
    noticeEl.classList.add('hidden');
    noticeEl.replaceChildren();
  }

  refresh();
}

/**
 * Open the element create/edit form as a STANDALONE stacked HolafModal. Used by
 * the catalogue screen (lot 3) AND by the group element picker (lot 4), so the
 * two entry points can never drift: same fields, same validation, same PATCH/
 * POST. `onSaved(element)` receives the created/updated element after a
 * successful save (the form then closes itself). `element` = null → create.
 *
 * Shares the exact field builder / icon preview / Docky free-text handling with
 * the catalogue screen; the only difference is where the result is consumed.
 */
export function openElementFormModal(element, onSaved) {
  const editing = !!element;
  const form = el('form', 'config-form');
  const formId = `element-form-${++formSeq}`;
  form.id = formId;
  form.setAttribute('novalidate', '');
  const errorEl = el('p', 'form-error', '', { role: 'alert' });

  const controls = {};
  for (const f of FORM_FIELDS) {
    form.appendChild(buildField(f, initialValue(f.key, element), controls));
  }
  controls.name.input.setAttribute('data-holaf-autofocus', '1');

  // Live icon preview, rendered with the SAME node a tile uses.
  const previewBox = el('div', 'elements-icon-box elements-icon-preview');
  const renderPreview = () =>
    previewBox.replaceChildren(
      buildIconNode(controls.icon.input.value.trim(), controls.name.input.value.trim())
    );
  renderPreview();
  const previewField = el('div', 'field');
  previewField.appendChild(el('span', 'field-label', 'Icon preview'));
  previewField.appendChild(previewBox);
  controls.icon.input.closest('.field').after(previewField);
  controls.icon.input.addEventListener('input', renderPreview);
  controls.name.input.addEventListener('input', renderPreview);

  const content = el('div', 'elements-form-body');
  content.append(form, errorEl);

  let formCtrl = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const result = collect(FORM_FIELDS, controls);
    if (!result.ok) {
      errorEl.textContent = result.error;
      toast(result.error, 'error');
      return;
    }
    const v = result.value;
    const docky =
      v.dockyAgent || v.dockyContainer
        ? { agent: v.dockyAgent || '', container: v.dockyContainer || '' }
        : null;
    const payload = {
      name: v.name,
      icon: v.icon || '',
      url: v.url || '',
      description: v.description || '',
      healthCheck: !!v.healthCheck,
      docky,
    };
    const saveBtn = formCtrl?.el.querySelector('.holaf-modal-footer button[type="submit"]');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const saved = editing
        ? await api.patch(`/api/elements/${encodeURIComponent(element.id)}`, payload)
        : await api.post('/api/elements', payload);
      toast(editing ? 'Element updated' : 'Element created', 'success');
      // Keep every rendered group in lockstep with the fresh catalogue.
      catalog.refresh();
      onSaved?.(saved || null);
      formCtrl.close();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to save element';
      toast(err.message || 'Failed to save element', 'error');
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  formCtrl = HolafModal.open({
    id: 'element-form-modal',
    title: editing ? 'Edit element' : 'New element',
    size: 'md',
    content,
    actions: [
      { label: 'Cancel', type: 'cancel' },
      { label: editing ? 'Save' : 'Create', type: 'primary', form: formId },
    ],
  });
  return formCtrl;
}

/** Initial field value from an existing element (create ⇒ schema defaults). */
function initialValue(key, element) {
  if (!element) return undefined;
  switch (key) {
    case 'name':
      return element.name || '';
    case 'icon':
      return element.icon || '';
    case 'url':
      return element.url || '';
    case 'description':
      return element.description || '';
    case 'healthCheck':
      return !!element.healthCheck;
    case 'dockyAgent':
      return element.docky?.agent || '';
    case 'dockyContainer':
      return element.docky?.container || '';
    default:
      return undefined;
  }
}
