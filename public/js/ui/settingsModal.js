import { el, isValidHttpUrl } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';

/**
 * Generic settings modal. Builds a form automatically from a widget's
 * declarative `settingsSchema` — no per-widget UI code.
 *
 * Supported field types: text | number | select | url | icon | color | toggle |
 * textarea | list. A `list` field carries a nested `fields` array describing
 * each row (e.g. used by shortcut/links).
 *
 * On save it PATCHes `/api/layout/items/:id/config`, then calls `onSaved` with
 * the new config so the caller can re-render the widget.
 *
 * Shell : HolafModal (brique holaf-lib) sert de coque (pile, focus trap,
 * scroll-lock, ARIA, Échap, clic overlay). Homy garde le settingsSchema, la
 * logique fields/collect()/errorEl, et le PATCH. Le bouton Save reste HORS du
 * <form> (dans le footer de la coque) et est associé au formulaire via
 * l'attribut HTML `form=` — un vrai clic soumet nativement le formulaire (la
 * leçon apprise : ne jamais remplacer par un dispatch('submit')).
 *
 * Theme: the 'homy' / 'homy-light' modal themes are registered and applied
 * globally (HolafModal.setTheme) by ui/theme.js — this modal deliberately does
 * NOT pass a `theme` option to open() so the global theme (which follows the
 * dashboard dark/light switch) always governs.
 */
let modalSeq = 0; // unique <form> ids when several modals are alive

export function openSettingsModal({ itemId, title, schema, config, onSaved }) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];

  const form = el('form', 'config-form');
  // The Save button lives OUTSIDE the <form> (in the modal footer) but is
  // associated via the HTML `form` attribute → a type="submit" button only
  // submits its *form owner*, so it needs form="settings-form-N". novalidate
  // keeps all validation in collect() (errorEl messages).
  const formId = `settings-form-${++modalSeq}`;
  form.id = formId;
  form.setAttribute('novalidate', '');
  const errorEl = el('p', 'form-error', '', { role: 'alert' });

  const controls = {};
  for (const f of fields) {
    form.appendChild(buildField(f, config?.[f.key], controls));
  }

  // Focus initial raisonnable : le 1er champ réel du formulaire (la coque
  // HolafModal honore [data-holaf-autofocus] à l'ouverture).
  const firstField = form.querySelector('input, select, textarea');
  if (firstField) firstField.setAttribute('data-holaf-autofocus', '1');

  const content = el('div');
  content.appendChild(form);
  content.appendChild(errorEl);

  // Actions du footer (coque) : Annuler (ferme), Enregistrer (submit natif du
  // formulaire, géré par le listener submit ci-dessous). Pas d'option `theme`
  // : le thème global HolafModal (posé par ui/theme.js, suit le switch
  // sombre/clair du dashboard) s'applique.
  const ctrl = HolafModal.open({
    title: title || 'Edit widget',
    size: 'md',
    content,
    actions: [
      { label: 'Cancel', type: 'cancel' },
      { label: 'Save', type: 'primary', form: formId },
    ],
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const result = collect(fields, controls);
    if (!result.ok) {
      errorEl.textContent = result.error;
      return;
    }
    // Bouton Save rendu par la coque (type=submit dans le footer).
    const saveBtn = ctrl.el.querySelector('.holaf-modal-footer button[type="submit"]');
    if (saveBtn) saveBtn.disabled = true;
    try {
      await api.patch(`/api/layout/items/${itemId}/config`, { config: result.value });
      onSaved?.(result.value);
      toast('Settings saved', 'success');
      ctrl.close();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to save settings';
      if (saveBtn) saveBtn.disabled = false;
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
