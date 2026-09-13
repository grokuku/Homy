import { el, isValidHttpUrl } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { catalog } from '../elements/catalog.js';
import { buildIconNode } from '../elements/button.js';
import { buildField, collect } from './settingsModal.js';
import { openIconsPicker } from './iconsPicker.js';
import { buildDockyTargetField } from './dockyTarget.js';

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
 *   (toggle), and a live Docky target picker (filterable agent/container
 *   dropdowns with state/health badges, free-text fallback when Docky is
 *   unavailable — lot 5). The footer Save is bound to the form through the HTML
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

// MUST mirror API_KEY_SENTINEL in server/services/reports.service.js. The form
// sends this in place of `apiKey` when the user edits an element whose key is
// already stored and does NOT want to change it (the secret is never sent back).
const API_KEY_SENTINEL = '__KEEP__';

let reportTypesPromise = null;

/** Fetch the report types once per session (tolerant: never rejects). */
function loadReportTypes() {
  if (!reportTypesPromise) {
    reportTypesPromise = api
      .get('/api/reports/types')
      .then((res) => (Array.isArray(res?.types) ? res.types : []))
      .catch((err) => {
        console.warn('[reports] failed to load report types:', err?.message || err);
        return [];
      });
  }
  return reportTypesPromise;
}

/**
 * Build the « Special reporting » section of the element form. Returns
 * `{ section, getValue, toggle }`:
 *   - `section` is appended to the form;
 *   - `getValue()` returns `{ ok, value: null | { type, baseUrl, apiKey } }`
 *     (an unchanged stored key is returned as the sentinel);
 *   - a « Test connection » button validates URL + key against the server proxy
 *     WITHOUT ever echoing the stored key (sentinel + elementId).
 */
function buildReportingSection(element) {
  const editing = !!element;
  const existing = element?.report || null;

  const section = el('div', 'report-section');
  section.appendChild(el('div', 'report-section-title', 'Special reporting'));

  const toggle = el('input', null, null, { type: 'checkbox' });
  toggle.checked = !!existing;
  const toggleLabel = el('label', 'report-toggle');
  toggleLabel.append(toggle, el('span', null, 'Special reporting'));
  section.appendChild(toggleLabel);
  section.appendChild(
    el(
      'small',
      'field-help',
      'Dedicated report tiles (active sessions, queues…) for a predefined service. The API key is stored server-side and never sent back to the browser.'
    )
  );

  const body = el('div', 'report-config');
  section.appendChild(body);

  const typeField = el('div', 'field');
  typeField.appendChild(el('span', 'field-label', 'Report type'));
  const typeSelect = el('select');
  typeField.appendChild(typeSelect);
  body.appendChild(typeField);

  const baseField = el('div', 'field');
  baseField.appendChild(el('span', 'field-label', 'Server URL'));
  const baseUrlInput = el('input', null, null, { type: 'text', placeholder: 'http://jellyfin:8096' });
  baseUrlInput.value = existing?.baseUrl || '';
  baseField.appendChild(baseUrlInput);
  body.appendChild(baseField);

  const keyField = el('div', 'field');
  keyField.appendChild(el('span', 'field-label', 'API key'));
  const apiKeyInput = el('input', null, null, { type: 'password', autocomplete: 'new-password' });
  if (existing?.hasApiKey) apiKeyInput.placeholder = '•••••••• (unchanged)';
  keyField.appendChild(apiKeyInput);
  body.appendChild(keyField);

  let keyTouched = false;
  apiKeyInput.addEventListener('input', () => {
    keyTouched = true;
  });

  const testRow = el('div', 'report-test-row');
  const testBtn = el('button', 'btn report-test-btn', 'Test connection', { type: 'button' });
  const testResult = el('div', 'report-test-result', '');
  testRow.append(testBtn, testResult);
  body.appendChild(testRow);

  const syncVisibility = () => body.classList.toggle('hidden', !toggle.checked);
  toggle.addEventListener('change', syncVisibility);
  syncVisibility();

  // The type list arrives asynchronously (cached per session). Keep the test
  // button disabled until it lands so a fast click can never hit the empty
  // select and surface a spurious « Choose a report type ».
  testBtn.disabled = true;
  const typesReady = loadReportTypes().then((types) => {
    for (const t of types) {
      const opt = el('option', null, t.implemented ? t.label : `${t.label} (soon)`);
      opt.value = t.id;
      opt.disabled = !t.implemented;
      typeSelect.appendChild(opt);
    }
    const wanted =
      existing?.type && types.some((t) => t.id === existing.type && t.implemented)
        ? existing.type
        : types.find((t) => t.implemented)?.id || '';
    if (wanted) typeSelect.value = wanted;
    testBtn.disabled = false;
    return types;
  });

  /** Validate the current report fields → `{ payload }` or `{ error }`. */
  function credentials() {
    const type = typeSelect.value;
    const baseUrl = baseUrlInput.value.trim();
    if (!type) return { error: 'Choose a report type' };
    if (!baseUrl) return { error: 'Server URL is required' };
    if (!isValidHttpUrl(baseUrl)) return { error: 'Server URL must be a valid http(s) URL' };
    let apiKey = apiKeyInput.value;
    if (editing && existing?.hasApiKey && !keyTouched) apiKey = API_KEY_SENTINEL;
    if (!apiKey) return { error: 'API key is required' };
    const payload = { type, baseUrl, apiKey };
    if (element?.id) payload.elementId = element.id;
    return { payload };
  }

  testBtn.addEventListener('click', async () => {
    testResult.className = 'report-test-result';
    testResult.textContent = 'Testing…';
    await typesReady; // ensure the type select is populated before validating
    const c = credentials();
    if (c.error) {
      testResult.textContent = c.error;
      testResult.classList.add('error');
      return;
    }
    testBtn.disabled = true;
    try {
      const res = await api.post('/api/reports/test', c.payload);
      if (res?.ok) {
        const s = res.server;
        const name = s?.name ? ` — ${s.name}${s.version ? ` ${s.version}` : ''}` : '';
        testResult.textContent = `Connected${name} (${res.sessionCount} active session${
          res.sessionCount === 1 ? '' : 's'
        })`;
        testResult.classList.add('success');
      } else {
        testResult.textContent = res?.error || `Failed (${res?.status || 'error'})`;
        testResult.classList.add('error');
      }
    } catch (err) {
      testResult.textContent = err.message || 'Connection test failed';
      testResult.classList.add('error');
    } finally {
      testBtn.disabled = false;
    }
  });

  function getValue() {
    if (!toggle.checked) return { ok: true, value: null };
    const c = credentials();
    if (c.error) return { ok: false, error: c.error };
    return { ok: true, value: c.payload };
  }

  return { section, getValue, toggle };
}

// Field schema consumed by the shared builder. Keys are flat (the builder's
// contract); the Docky target is a dedicated picker section (buildDockyTargetField)
// appended below, folded into `{ agent, container }` on save.
const FORM_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Jellyfin' },
  { key: 'icon', label: 'Icon', type: 'text', placeholder: 'Emoji, holaf:<name>, local:<slug> or https://…', help: 'Pick a local icon from the library or type an emoji / holaf:<name> / https://… URL.' },
  { key: 'url', label: 'URL', type: 'url', placeholder: 'https://…' },
  { key: 'description', label: 'Description', type: 'textarea', rows: 2, placeholder: 'Optional' },
  { key: 'healthCheck', label: 'Health check', type: 'toggle', help: 'Delegate a health probe to Docky (via the Docky target below).' },
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
    if (item.report?.type) {
      badges.appendChild(el('span', 'badge badge-report', `Report: ${item.report.type}`));
    }

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

  // « Browse icons » opens the lot-7 icon library picker; picking OR installing
  // an icon fills this field with `local:<slug>` and refreshes the preview.
  const browseBtn = el('button', 'btn icon-browse-btn', 'Browse icons', {
    type: 'button',
    title: 'Search the online icon library and install locally',
  });
  browseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openIconsPicker({
      onPick: (entry) => {
        if (!entry?.slug) return;
        controls.icon.input.value = `local:${entry.slug}`;
        renderPreview();
      },
    });
  });
  controls.icon.input.closest('.field').appendChild(browseBtn);

  // « Special reporting » (lot 8): optional report provider config. Appended to
  // the form so it participates in the native submit and the same error line.
  const reporting = buildReportingSection(element);
  form.appendChild(reporting.section);

  // Docky target (lot 5): filterable agent/container picker with a free-text
  // fallback when Docky is unavailable. Persists agent + container NAME only.
  const dockyField = buildDockyTargetField({ element });
  form.appendChild(dockyField.section);

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
    const reportResult = reporting.getValue();
    if (!reportResult.ok) {
      errorEl.textContent = reportResult.error;
      toast(reportResult.error, 'error');
      return;
    }
    const docky = dockyField.getValue();
    const payload = {
      name: v.name,
      icon: v.icon || '',
      url: v.url || '',
      description: v.description || '',
      healthCheck: !!v.healthCheck,
      docky,
      report: reportResult.value,
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
    onClose: () => dockyField.dispose(),
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
    default:
      return undefined;
  }
}
