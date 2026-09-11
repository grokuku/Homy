import { el } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
import { applyBackground } from '../backgrounds/manager.js';

/**
 * "Background" modal (edit-mode toolbar). Custom content inside the HolafModal
 * shell (the brick's free-content use case). Lets the user pick:
 *   - type: none | image | procedural
 *   - image: pick an uploaded background (thumbnails), upload new ones,
 *     blur (0-20px), dim (0-80%), fixed (viewport) vs scrolling
 *   - procedural: generator (waves / particles / aurora) + speed, density,
 *     opacity, links, optional comma-separated colors
 *
 * Saving = PUT /api/settings (full background object, server-validated),
 * then the onSaved callback applies it live via the background manager.
 * The footer Save button is provided by the HolafModal shell (a REAL button
 * we attach an onClick handler to — per the lot-2 lesson we never replace
 * native interactions with synthetic events).
 */
export function openBackgroundModal({ settings, onSaved }) {
  const current = settings?.background || { type: 'none' };

  // ---- type -----------------------------------------------------------------
  const typeSel = el('select', null, null, { id: 'bg-type-select' });
  for (const [value, label] of [
    ['none', 'None (theme color)'],
    ['image', 'Image'],
    ['procedural', 'Procedural (animated)'],
  ]) {
    const o = el('option', null, label);
    o.value = value;
    typeSel.appendChild(o);
  }
  typeSel.value = current.type || 'none';

  // ---- image section ----------------------------------------------------------
  const img = current.type === 'image' ? current.image || {} : {};
  let selectedName = img.name || null;

  const thumbs = el('div', 'bg-thumbs');
  const fileInput = el('input', null, null, { type: 'file', accept: '.png,.jpg,.jpeg,.webp,.avif,image/png,image/jpeg,image/webp,image/avif' });
  fileInput.id = 'bg-file-input';
  fileInput.className = 'bg-file-input';
  const uploadBtn = el('button', 'btn', 'Upload', { type: 'button' });
  const blurInput = numberField('Blur (px)', 0, 20, 1, img.blur ?? 0);
  const dimInput = numberField('Dim overlay (%)', 0, 80, 5, img.dim ?? 0);
  const fixedInput = el('input', null, null, { type: 'checkbox' });
  fixedInput.checked = !!img.fixed;

  async function refreshThumbs() {
    thumbs.replaceChildren();
    let files = [];
    try {
      const res = await api.get('/api/backgrounds');
      files = res?.files || [];
    } catch (err) {
      toast(err.message || 'Failed to load backgrounds', 'error');
      return;
    }
    if (files.length === 0) {
      thumbs.appendChild(el('p', 'muted bg-empty', 'No background uploaded yet — pick an image file and click Upload.'));
    }
    for (const f of files) {
      const item = el('div', 'bg-thumb' + (f.name === selectedName ? ' selected' : ''));
      item.dataset.name = f.name;
      const imgEl = el('img', null, null, { src: f.url, alt: f.name, loading: 'lazy' });
      const del = el('button', 'bg-thumb-del', '✕', { type: 'button', title: 'Delete background' });
      item.append(imgEl, del);
      item.addEventListener('click', (e) => {
        if (e.target === del) return;
        selectedName = f.name;
        thumbs.querySelectorAll('.bg-thumb').forEach((t) => t.classList.toggle('selected', t.dataset.name === selectedName));
      });
      del.addEventListener('click', async () => {
        try {
          await api.del(`/api/backgrounds/${f.name}`);
          if (selectedName === f.name) selectedName = null;
          await refreshThumbs();
        } catch (err) {
          toast(err.message || 'Delete failed', 'error');
        }
      });
      thumbs.appendChild(item);
    }
  }

  uploadBtn.addEventListener('click', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      toast('Choose an image file first', 'warning');
      return;
    }
    uploadBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload('/api/backgrounds', fd);
      fileInput.value = '';
      selectedName = res.name;
      await refreshThumbs();
      toast('Background uploaded', 'success');
    } catch (err) {
      toast(err.message || 'Upload failed', 'error');
    } finally {
      uploadBtn.disabled = false;
    }
  });

  // ---- procedural section -----------------------------------------------------
  const proc = current.type === 'procedural' ? current.procedural || {} : {};
  const genSel = el('select');
  for (const [value, label] of [
    ['waves', 'Waves'],
    ['particles', 'Particles'],
    ['aurora', 'Aurora'],
  ]) {
    const o = el('option', null, label);
    o.value = value;
    genSel.appendChild(o);
  }
  genSel.value = ['waves', 'particles', 'aurora'].includes(proc.generator) ? proc.generator : 'waves';
  const speedInput = numberField('Speed', 0, 3, 0.1, proc.speed ?? 1);
  const densityInput = numberField('Density', 1, 100, 1, proc.density ?? 10);
  const opacityInput = numberField('Opacity', 0, 1, 0.05, proc.opacity ?? 1);
  const linksInput = el('input', null, null, { type: 'checkbox' });
  linksInput.checked = proc.links !== false;
  const colorsInput = el('input', null, null, { type: 'text', placeholder: '#4f8cff, #22d3ee, #a78bfa (optional)' });
  colorsInput.value = Array.isArray(proc.colors) ? proc.colors.join(', ') : '';

  // ---- layout -----------------------------------------------------------------
  const typeField = el('div', 'field');
  const typeLabel = el('label');
  typeLabel.appendChild(el('span', null, 'Background type'));
  typeLabel.appendChild(typeSel);
  typeField.appendChild(typeLabel);

  const imageSection = el('div', 'bg-section');
  imageSection.append(
    sectionTitle('Uploaded backgrounds'),
    thumbs,
    fieldWrap('New image (png, jpg, webp, avif — max 10 MB)', fileInput),
    uploadBtn,
    blurInput.wrap,
    dimInput.wrap,
    toggleWrap('Fixed to viewport (no scroll)', fixedInput)
  );

  const procSection = el('div', 'bg-section');
  procSection.append(
    sectionTitle('Generator'),
    fieldWrap('Generator', genSel),
    speedInput.wrap,
    densityInput.wrap,
    opacityInput.wrap,
    toggleWrap('Particle links', linksInput),
    fieldWrap('Colors (comma-separated hex, empty = default)', colorsInput)
  );

  function syncSections() {
    const t = typeSel.value;
    imageSection.classList.toggle('hidden', t !== 'image');
    procSection.classList.toggle('hidden', t !== 'procedural');
  }
  typeSel.addEventListener('change', syncSections);
  syncSections();

  const content = el('div', 'config-form');
  content.append(typeField, imageSection, procSection);

  // ---- save -------------------------------------------------------------------
  const ctrl = HolafModal.open({
    title: 'Background',
    size: 'md',
    content,
    actions: [
      { label: 'Cancel', type: 'cancel' },
      {
        label: 'Save',
        type: 'primary',
        // We keep the modal open on failure (return false) and close it
        // ourselves on success — deterministic with async saves.
        onClick: (c2) => {
          save(c2).catch(() => {});
          return false;
        },
      },
    ],
  });

  async function save(ctrlRef) {
    const errorEl = ctrlRef.el.querySelector('.bg-error');
    if (errorEl) errorEl.textContent = '';
    const type = typeSel.value;
    let background = { type: 'none' };
    try {
      if (type === 'image') {
        if (!selectedName) throw new Error('Select a background image first (or upload one)');
        background = {
          type: 'image',
          image: {
            name: selectedName,
            blur: Number(blurInput.input.value) || 0,
            dim: Number(dimInput.input.value) || 0,
            fixed: fixedInput.checked,
          },
        };
      } else if (type === 'procedural') {
        const colors = colorsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        background = {
          type: 'procedural',
          procedural: {
            generator: genSel.value,
            speed: Number(speedInput.input.value) || 0,
            density: Number(densityInput.input.value) || 0,
            opacity: Number(opacityInput.input.value) || 0,
            links: linksInput.checked,
            colors,
          },
        };
      }
      // Server-side strict validation is the gate; reflect failures inline.
      const next = await api.put('/api/settings', { theme: settings?.theme || 'dark', background });
      onSaved?.(next);
      toast('Background saved', 'success');
      ctrlRef.close();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message || 'Failed to save background';
      else toast(err.message || 'Failed to save background', 'error');
    }
  }

  return ctrl;
}

// ---- small builders -----------------------------------------------------------

function sectionTitle(text) {
  return el('h4', 'bg-section-title', text);
}

function fieldWrap(label, input) {
  const labelEl = el('label');
  labelEl.appendChild(el('span', null, label));
  labelEl.appendChild(input);
  return labelEl;
}

function toggleWrap(label, input) {
  const labelEl = el('label', 'bg-toggle');
  labelEl.appendChild(input);
  labelEl.appendChild(el('span', null, label));
  return labelEl;
}

function numberField(label, min, max, step, value) {
  const input = el('input', null, null, { type: 'number', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  return { input, wrap: fieldWrap(label, input) };
}