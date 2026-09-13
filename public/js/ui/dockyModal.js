import { el } from '../util.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { dockyApi } from '../docky/docky.js';

/**
 * Docky configuration modal (LOT 5) — edit-mode only.
 *
 * Writes the integration base URL + dedicated key to the SERVER
 * (`PUT /api/docky/config`). The key is write-only: the form shows a
 * « •••••• (unchanged) » placeholder when a key is already stored and sends the
 * sentinel {@link DOCKY_KEY_SENTINEL} to keep it — the secret is never sent
 * back to the browser. « Test connection » persists the form then probes
 * `GET /api/docky/status?force=1` + `GET /api/docky/agents`.
 */

// MUST stay in sync with API_KEY_SENTINEL in server/services/docky.service.js.
export const DOCKY_KEY_SENTINEL = '__KEEP__';

export function openDockyConfigModal() {
  if (document.getElementById('docky-config-modal')) return;

  let hasKey = false;
  let keyTouched = false;

  const form = el('form', 'config-form docky-config-form');
  form.id = 'docky-config-form';
  form.setAttribute('novalidate', '');

  const urlField = el('div', 'field');
  urlField.appendChild(el('span', 'field-label', 'Docky base URL'));
  const urlInput = el('input', null, null, {
    type: 'text',
    placeholder: 'https://docky.example.tld',
    'data-holaf-autofocus': '1',
  });
  urlField.appendChild(urlInput);
  urlField.appendChild(
    el('small', 'field-help', 'Host alone is enough — /api/integration/v1 is appended automatically.')
  );

  const keyField = el('div', 'field');
  keyField.appendChild(el('span', 'field-label', 'Integration key'));
  const keyInput = el('input', null, null, { type: 'password', autocomplete: 'new-password' });
  keyField.appendChild(keyInput);
  keyField.appendChild(
    el('small', 'field-help', 'Stored server-side only — never returned by an API response nor written to a log.')
  );

  form.append(urlField, keyField);

  const testRow = el('div', 'docky-test-row');
  const testBtn = el('button', 'btn', 'Test connection', { type: 'button' });
  const statusEl = el('div', 'docky-config-status', '');
  testRow.append(testBtn, statusEl);
  form.appendChild(testRow);

  const errorEl = el('p', 'form-error', '', { role: 'alert' });
  const content = el('div', 'docky-config-body');
  content.append(form, errorEl);

  let ctrl = null;

  const setStatus = (text, kind = '') => {
    statusEl.className = `docky-config-status ${kind}`.trim();
    statusEl.textContent = text;
  };

  /** Build the PUT payload from the form (validating the URL). */
  function payload() {
    const baseUrl = urlInput.value.trim();
    if (baseUrl && baseUrl.length > 2048) return { error: 'Docky URL is too long' };
    let apiKey;
    if (hasKey && !keyTouched) apiKey = DOCKY_KEY_SENTINEL;
    else apiKey = keyInput.value;
    return { value: { baseUrl, apiKey } };
  }

  async function persist() {
    const built = payload();
    if (built.error) {
      errorEl.textContent = built.error;
      return { ok: false };
    }
    errorEl.textContent = '';
    const saved = await dockyApi.saveConfig(built.value);
    hasKey = !!saved?.hasKey;
    keyTouched = false;
    keyInput.value = '';
    if (hasKey) keyInput.placeholder = '•••••••• (unchanged)';
    return { ok: true, saved };
  }

  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    setStatus('Testing…');
    try {
      const res = await persist();
      if (!res.ok) {
        setStatus('Fix the form first', 'error');
        return;
      }
      const status = await dockyApi.status(true);
      if (!status?.configured) {
        setStatus('Not configured', 'error');
        return;
      }
      if (!status.reachable) {
        setStatus('Configured but unreachable', 'error');
        return;
      }
      let count = 0;
      try {
        const agents = await dockyApi.agents();
        count = Array.isArray(agents?.agents) ? agents.agents.length : 0;
      } catch {
        count = 0;
      }
      setStatus(`Connected — ${count} agent${count === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      setStatus(err?.message || 'Connection failed', 'error');
    } finally {
      testBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = ctrl?.el.querySelector('.holaf-modal-footer button[type="submit"]');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const res = await persist();
      if (res.ok) {
        toast('Docky configuration saved', 'success');
        ctrl?.close();
      } else if (saveBtn) saveBtn.disabled = false;
    } catch (err) {
      errorEl.textContent = err?.message || 'Failed to save Docky configuration';
      if (saveBtn) saveBtn.disabled = false;
    }
  });

  keyInput.addEventListener('input', () => {
    keyTouched = true;
  });

  // Hydrate from the server (URL + hasKey only — never the key).
  dockyApi
    .config()
    .then((cfg) => {
      urlInput.value = cfg?.baseUrl || '';
      hasKey = !!cfg?.hasKey;
      if (hasKey) keyInput.placeholder = '•••••••• (unchanged)';
      if (cfg?.fromEnv?.baseUrl || cfg?.fromEnv?.apiKey) {
        setStatus('Some values are set by environment variables.', 'warn');
      }
    })
    .catch((err) => setStatus(err?.message || 'Failed to load configuration', 'error'));

  ctrl = HolafModal.open({
    id: 'docky-config-modal',
    title: 'Docky integration',
    size: 'md',
    content,
    actions: [
      { label: 'Cancel', type: 'cancel' },
      { label: 'Save', type: 'primary', form: form.id },
    ],
  });
  return ctrl;
}
