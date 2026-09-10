import { el, isValidHttpUrl } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';

/**
 * Generic settings modal. Builds a form automatically from a widget's
 * declarative `settingsSchema` — no per-widget UI code.
 *
 * Supported field types: text | number | select | url | icon | color | toggle |
 * textarea | list. A `list` field carries a nested `fields` array describing
 * each row (used e.g. by shortcut/links).
 *
 * On save it PATCHes `/api/layout/items/:id/config`, then calls `onSaved` with
 * the new config so the caller can re-render the widget.
 */
export function openSettingsModal({ itemId, title, schema, config, onSaved }) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];

  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');
  const heading = el('h3', null, title || 'Edit widget');
  const form = el('form', 'config-form');
  const errorEl = el('p', 'form-error', '', { role: 'alert' });
  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn btn-ghost', 'Cancel', { type: 'button' });
  const saveBtn = el('button', 'btn btn-primary', 'Save', { type: 'submit' });

  const controls = {};
  for (const f of fields) {
    form.appendChild(buildField(f, config?.[f.key], controls));
  }

  actions.append(cancelBtn, saveBtn);
  modal.append(heading, form, errorEl, actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const result = collect(fields, controls);
    if (!result.ok) {
      errorEl.textContent = result.error;
      return;
    }
    saveBtn.disabled = true;
    try {
      await api.patch(`/api/layout/items/${itemId}/config`, { config: result.value });
      onSaved?.(result.value);
      toast('Settings saved', 'success');
      close();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to save settings';
      saveBtn.disabled = false;
    }
  });
}

// ---- Field builders --------------------------------------------------------

function buildField(f, value, controls) {
  const wrap = el('div', 'field');
  const label = el('label');
  label.appendChild(el('span', null, f.label));
  if (f.help) label.appendChild(el('small', 'field-help', f.help));

  let input;
  switch (f.type) {
    case 'number': {
      input = el('input', null, null, { type: 'number' });
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step !== undefined) input.step = f.step;
      input.value = value ?? f.default ?? '';
      break;
    }
    case 'select': {
      input = el('select', null, null);
      for (const opt of f.options || []) {
        const o = el('option', null, opt.label);
        o.value = opt.value;
        input.appendChild(o);
      }
      input.value = value ?? f.default ?? '';
      break;
    }
    case 'toggle': {
      input = el('input', null, null, { type: 'checkbox' });
      input.checked = value !== undefined ? !!value : !!f.default;
      break;
    }
    case 'textarea': {
      input = el('textarea', null, null, { rows: f.rows || 5 });
      input.value = value ?? f.default ?? '';
      break;
    }
    case 'url': {
      input = el('input', null, null, { type: 'text', placeholder: f.placeholder || 'https://…' });
      input.value = value ?? f.default ?? '';
      break;
    }
    case 'color': {
      const row = el('div', 'color-field');
      input = el('input', null, null, { type: 'color' });
      input.value = value || f.default || '#4f8cff';
      const clearBtn = el('button', 'btn', '✕', { type: 'button', title: 'Clear color' });
      clearBtn.addEventListener('click', () => {
        input.value = '#4f8cff';
        input.dataset.cleared = '1';
      });
      input.addEventListener('input', () => {
        delete input.dataset.cleared;
      });
      row.append(input, clearBtn);
      label.appendChild(row);
      wrap.appendChild(label);
      controls[f.key] = { field: f, input };
      return wrap;
    }
    case 'list': {
      return buildListField(f, value, controls);
    }
    case 'icon':
    case 'text':
    default: {
      input = el('input', null, null, { type: 'text', placeholder: f.placeholder || '' });
      input.value = value ?? f.default ?? '';
      break;
    }
  }

  if (f.required) input.setAttribute('required', '');
  label.appendChild(input);
  wrap.appendChild(label);
  controls[f.key] = { field: f, input };
  return wrap;
}

function buildListField(f, value, controls) {
  const wrap = el('div', 'field');
  const label = el('span', 'field-label', f.label);
  const list = el('div', 'list-editor');
  const addBtn = el('button', 'btn', `+ Add ${f.itemLabel || 'item'}`, { type: 'button' });

  function addRow(data = {}) {
    const row = el('div', 'list-row');
    for (const sub of f.fields || []) {
      const cell = el('div', 'list-cell');
      cell.appendChild(el('span', 'list-cell-label', sub.label));
      let input;
      if (sub.type === 'select') {
        input = el('select', null, null);
        for (const opt of sub.options || []) {
          const o = el('option', null, opt.label);
          o.value = opt.value;
          input.appendChild(o);
        }
        input.value = data[sub.key] ?? sub.default ?? '';
      } else if (sub.type === 'toggle') {
        input = el('input', null, null, { type: 'checkbox' });
        input.checked = data[sub.key] !== undefined ? !!data[sub.key] : !!sub.default;
      } else {
        input = el('input', null, null, { type: 'text', placeholder: sub.placeholder || '' });
        input.value = data[sub.key] ?? sub.default ?? '';
      }
      cell.appendChild(input);
      row.appendChild(cell);
    }
    const remove = el('button', 'btn remove-shortcut', '✕', { type: 'button', title: 'Remove' });
    remove.addEventListener('click', () => row.remove());
    row.appendChild(remove);
    list.appendChild(row);
  }

  const items = Array.isArray(value) ? value : [];
  if (items.length === 0) addRow();
  else items.forEach(addRow);
  addBtn.addEventListener('click', () => addRow());

  wrap.append(label, list, addBtn);
  controls[f.key] = { field: f, list };
  return wrap;
}

// ---- Validation / collection ----------------------------------------------

function collect(fields, controls) {
  const out = {};
  for (const f of fields) {
    const c = controls[f.key];
    if (!c) continue;

    if (f.type === 'list') {
      const rows = [...c.list.querySelectorAll('.list-row')];
      const arr = rows
        .map((row) => {
          const inputs = row.querySelectorAll('input, select');
          const obj = {};
          f.fields.forEach((sub, i) => {
            const input = inputs[i];
            if (!input) return;
            if (sub.type === 'toggle') obj[sub.key] = input.checked;
            else if (sub.type === 'number') obj[sub.key] = input.value === '' ? undefined : Number(input.value);
            else obj[sub.key] = input.value.trim();
          });
          return obj;
        })
        .filter((o) => f.fields.some((sub) => (o[sub.key] ?? '') !== '' && o[sub.key] !== undefined));
      out[f.key] = arr;
      continue;
    }

    const input = c.input;
    let val;
    switch (f.type) {
      case 'number': {
        if (input.value === '') {
          if (f.required) return { ok: false, error: `${f.label} is required` };
          val = undefined;
        } else {
          val = Number(input.value);
          if (!Number.isFinite(val)) return { ok: false, error: `${f.label} must be a number` };
          if (f.min !== undefined && val < f.min) return { ok: false, error: `${f.label} must be ≥ ${f.min}` };
          if (f.max !== undefined && val > f.max) return { ok: false, error: `${f.label} must be ≤ ${f.max}` };
        }
        break;
      }
      case 'toggle':
        val = input.checked;
        break;
      case 'select':
        val = input.value;
        break;
      case 'url': {
        const v = input.value.trim();
        if (v && !isValidHttpUrl(v)) return { ok: false, error: `${f.label} must be a valid http(s) URL` };
        if (!v && f.required) return { ok: false, error: `${f.label} is required` };
        val = v;
        break;
      }
      case 'textarea':
        val = input.value;
        break;
      case 'color':
        val = input.dataset.cleared ? '' : input.value;
        break;
      default: {
        const v = input.value.trim();
        if (!v && f.required) return { ok: false, error: `${f.label} is required` };
        val = v;
      }
    }
    out[f.key] = val;
  }
  return { ok: true, value: out };
}
