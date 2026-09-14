import { el } from '../util.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { HolafModal } from '../../vendor/holaf/holaf-modal.js';
// Imported ONLY for the static `elementCount` helper (density hint). No
// HolafAmbient instance is ever created here any more: the modal renders no
// canvas — the LIVE PREVIEW is the real, full-screen background behind the
// modal, driven by the background manager (single ambient instance reused).
import { HolafAmbient } from '../../vendor/holaf/holaf-ambient.js';
import { applyBackground } from '../backgrounds/manager.js';

/**
 * "Background" modal (edit-mode toolbar). Custom content inside the HolafModal
 * shell (the brick's free-content use case). Lets the user pick:
 *   - type: none | image | procedural
 *   - image: pick an uploaded background (thumbnails), upload new ones,
 *     blur (0-20px), dim (0-80%), fixed (viewport) vs scrolling
 *   - procedural: generator (waves / particles / aurora) + mood preset, speed,
 *     density (intensity 1..100), opacity, blur (0-40px), links (particles
 *     only), palette preset or custom comma-separated colors, PLUS the two
 *     performance sliders (holaf-ambient ≥ 0.3.0): scale — internal render
 *     resolution 25-100 % (buffer = css × dpr × scale, upscaled by the
 *     compositor) — and FPS max 15-60 (rAF loop paints at most N fps, the
 *     animation keeps its wall-clock speed).
 *
 * NO in-modal preview canvas. Instead the modal edits a DRAFT and applies it
 * LIVE to the REAL full-screen background behind itself:
 *   - at open we clone the SAVED settings (`saved`) for an exact revert;
 *   - every user edit rebuilds the draft descriptor and calls
 *     `applyBackground(draft)` — discrete controls (type, generator, palette,
 *     presets, checkboxes, thumbnail pick) apply immediately, sliders and the
 *     hex text field are DEBOUNCED (~300 ms) so dragging never re-creates the
 *     ambient instance (the manager updates it in place via setConfig);
 *   - the modal panel is opaque and anchored to the LEFT, and the overlay scrim
 *     is neutralised (--hm-overlay-bg: transparent) so the animated background
 *     stays visible — the background IS the preview;
 *   - Save = PUT /api/settings (persist) + close; Cancel / Escape / overlay
 *     click / ✕ = re-apply the SAVED snapshot (exact revert) + close.
 *
 * Saving = PUT /api/settings (full background object, server-validated), then
 * the onSaved callback applies it live via the background manager. The footer
 * Save button is provided by the HolafModal shell (a REAL button we attach an
 * onClick handler to — per the lot-2 lesson we never replace native
 * interactions with synthetic events).
 */

// Palette presets (same set as the holaf-lib test bench) and mood presets that
// set speed / density / opacity / blur in one click.
const PALETTES = {
  homy: ['#7dd3fc', '#38bdf8', '#818cf8', '#22d3ee'],
  aikore: ['#4f8cff', '#22d3ee', '#a78bfa', '#6366f1', '#38bdf8'],
  sunset: ['#ff7a59', '#ffb86b', '#ff5f9e', '#a855f7'],
  mono: ['#4f8cff', '#0ea5e9'],
};
const MOODS = {
  discret: { speed: 0.6, density: 6, opacity: 0.7, blur: 10 },
  equilibre: { speed: 1, density: 10, opacity: 1, blur: 0 },
  intense: { speed: 1.6, density: 22, opacity: 1, blur: 0 },
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Deep clone of a plain server descriptor (exact revert needs an isolated copy). */
function clone(v) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(v);
  } catch {
    /* fall through to JSON */
  }
  return JSON.parse(JSON.stringify(v));
}

export function openBackgroundModal({ settings, onSaved }) {
  const current = settings?.background || { type: 'none' };
  // SNAPSHOT of the saved settings — the reverve target. It is never mutated by
  // the draft; Cancel/Escape/overlay re-apply this exact object, whatever draft
  // detours the user took (image → procedural → image …).
  const saved = clone(current);

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
  const blurInput = rangeField('Blur', 0, 20, 1, img.blur ?? 0, { unit: 'px' });
  const dimInput = rangeField('Dim overlay', 0, 80, 5, img.dim ?? 0, { unit: '%' });
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
      const del = el('button', 'bg-thumb-del', '✕', { type: 'button', title: 'Delete background', 'aria-label': 'Delete background' });
      item.append(imgEl, del);
      item.addEventListener('click', (e) => {
        if (e.target === del) return;
        selectedName = f.name;
        thumbs.querySelectorAll('.bg-thumb').forEach((t) => t.classList.toggle('selected', t.dataset.name === selectedName));
        // Picking a thumbnail is a discrete choice → apply the draft at once so
        // the image shows up live on the real background.
        applyDraftNow();
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
      if (typeSel.value === 'image') applyDraftNow();
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

  // Preset d'ambiance (règle vitesse/densité/opacité/flou d'un coup).
  const presetSel = el('select');
  for (const [value, label] of [
    ['discret', 'Discret (calme, flouté)'],
    ['equilibre', 'Équilibré'],
    ['intense', 'Intense'],
  ]) {
    const o = el('option', null, label);
    o.value = value;
    presetSel.appendChild(o);
  }
  presetSel.value = 'equilibre';

  const speedInput = rangeField('Speed', 0, 3, 0.1, proc.speed ?? 1);
  const densityHelp = el('span', 'field-help');
  const densityInput = rangeField('Density', 1, 100, 1, proc.density ?? 10, { helpEl: densityHelp });
  const opacityInput = rangeField('Opacity', 0, 1, 0.05, proc.opacity ?? 1);
  const procBlurInput = rangeField('Blur', 0, 40, 1, proc.blur ?? 0, {
    unit: 'px',
    help: 'Softens the whole background (global gaussian blur) without touching the rest of the page.',
  });
  // Performance (holaf-ambient ≥ 0.3.0) : résolution du buffer interne et
  // plafond de framerate. Défauts = 100 % / 60 fps (settings sans ces clés,
  // y compris d'anciens settings.json : le serveur renvoie les défauts).
  const scaleInput = rangeField('Échelle de rendu', 25, 100, 5, proc.scale ?? 100, {
    unit: '%',
    help: 'Rendu interne réduit puis agrandi — quasi invisible sur des dégradés doux',
  });
  const fpsInput = rangeField('FPS max', 15, 60, 1, proc.fps ?? 60, {
    unit: 'fps',
    help: 'Limite la charge ; au-delà de 60 Hz le fond est plafonné (invisible sur un fond animé lent)',
  });
  const linksInput = el('input', null, null, { type: 'checkbox' });
  linksInput.checked = proc.links !== false;
  const linksWrap = toggleWrap('Particle links', linksInput);
  const colorsInput = el('input', null, null, { type: 'text', placeholder: '#4f8cff, #22d3ee, #a78bfa (optional)' });
  colorsInput.value = Array.isArray(proc.colors) ? proc.colors.join(', ') : '';

  // Palette : preset (remplit le champ hex) ou couleurs personnalisées.
  const paletteSel = el('select');
  for (const [value, label] of [
    ['homy', 'Homy (default)'],
    ['aikore', 'AiKore'],
    ['sunset', 'Sunset'],
    ['mono', 'Mono blue'],
    ['custom', 'Custom (hex field below)'],
  ]) {
    const o = el('option', null, label);
    o.value = value;
    paletteSel.appendChild(o);
  }
  {
    const currentColors = colorsInput.value.toLowerCase();
    const match = Object.entries(PALETTES).find(
      ([, hexes]) => hexes.join(', ').toLowerCase() === currentColors
    );
    paletteSel.value = match ? match[0] : 'custom';
  }
  const swatches = el('div', 'bg-swatches');

  /** Valeur numérique d'un champ (repli si vide / NaN). */
  function num(input, fallback) {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Couleurs valides saisies (#rrggbb), dans l'ordre. */
  function parsedColors() {
    return colorsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => HEX_RE.test(s))
      .map((s) => s.toLowerCase());
  }

  /**
   * Build the DRAFT background descriptor from the current form state. This is
   * exactly the server-shaped object we PUT on Save — the same one we apply live,
   * so what the user sees behind the modal is what gets persisted. `null` means
   * "nothing applicable yet" (image type with no file picked): the live
   * background is then left untouched rather than flashing a broken layer.
   */
  function buildDescriptor() {
    const type = typeSel.value;
    if (type === 'image') {
      if (!selectedName) return null;
      return {
        type: 'image',
        image: {
          name: selectedName,
          blur: num(blurInput.input, 0),
          dim: num(dimInput.input, 0),
          fixed: fixedInput.checked,
        },
      };
    }
    if (type === 'procedural') {
      return {
        type: 'procedural',
        procedural: {
          generator: genSel.value,
          speed: num(speedInput.input, 1),
          density: num(densityInput.input, 10),
          opacity: num(opacityInput.input, 1),
          blur: num(procBlurInput.input, 0),
          // Perf : le serveur attend des entiers (scale en %, fps entier).
          scale: Math.round(num(scaleInput.input, 100)),
          fps: Math.round(num(fpsInput.input, 60)),
          links: linksInput.checked,
          colors: parsedColors(),
        },
      };
    }
    return { type: 'none' };
  }

  // ---- live draft application (debounced) ------------------------------------
  let applyTimer = null;
  let committed = false; // Save succeeded → closing must NOT revert

  /** Apply the current draft to the REAL background immediately. */
  function applyDraftNow() {
    if (applyTimer) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    const draft = buildDescriptor();
    if (!draft) return; // image without a picked file → keep the current bg
    try {
      applyBackground(draft);
    } catch (err) {
      console.warn('[backgrounds] live draft apply failed:', err);
    }
  }

  /**
   * Debounced draft apply for CONTINUOUS inputs (sliders, hex typing): a drag
   * fires a burst of `input` events, and re-baying the canvas on every tick
   * would cost more than it saves. 300 ms after the last event we apply once —
   * the manager updates the single ambient instance in place (no restart).
   */
  function scheduleApply() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      applyDraftNow();
    }, 300);
  }

  /** Refresh helps / value badges / swatches (no preview instance any more). */
  function syncMeta() {
    const n = HolafAmbient.elementCount(genSel.value, num(densityInput.input, 10));
    const unit = genSel.value === 'particles' ? 'particles' : genSel.value === 'aurora' ? 'glows' : 'ribbons';
    densityHelp.textContent = `≈ ${n} ${unit}`;
    // Badges de valeur : un preset (ou le change de générateur) écrit les
    // valeurs directement dans les inputs sans événement input → re-sync.
    for (const f of [speedInput, densityInput, opacityInput, procBlurInput, scaleInput, fpsInput]) f.sync();
    linksWrap.classList.toggle('hidden', genSel.value !== 'particles');
    swatches.replaceChildren(
      ...parsedColors().map((hex) => {
        const i = el('i');
        i.style.background = hex;
        i.title = hex;
        return i;
      })
    );
  }

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
    fieldWrap('Mood preset', presetSel),
    speedInput.wrap,
    densityInput.wrap,
    opacityInput.wrap,
    procBlurInput.wrap,
    scaleInput.wrap,
    fpsInput.wrap,
    linksWrap,
    fieldWrap('Palette', paletteSel),
    fieldWrap('Colors (comma-separated hex, empty = default)', colorsInput),
    swatches
  );

  // Discrete controls apply the draft at once; continuous inputs are debounced.
  genSel.addEventListener('change', () => { syncMeta(); applyDraftNow(); });
  colorsInput.addEventListener('input', () => { syncMeta(); scheduleApply(); });
  linksInput.addEventListener('change', applyDraftNow);
  fixedInput.addEventListener('change', applyDraftNow);
  for (const f of [speedInput, densityInput, opacityInput, procBlurInput, scaleInput, fpsInput, blurInput, dimInput]) {
    f.input.addEventListener('input', scheduleApply);
  }
  presetSel.addEventListener('change', () => {
    const m = MOODS[presetSel.value];
    if (!m) return;
    speedInput.input.value = String(m.speed);
    densityInput.input.value = String(m.density);
    opacityInput.input.value = String(m.opacity);
    procBlurInput.input.value = String(m.blur);
    syncMeta();
    applyDraftNow();
  });
  paletteSel.addEventListener('change', () => {
    const hexes = PALETTES[paletteSel.value];
    if (!hexes) return; // « custom » : on laisse la saisie de l'utilisateur
    colorsInput.value = hexes.join(', ');
    syncMeta();
    applyDraftNow();
  });

  function syncSections() {
    const t = typeSel.value;
    imageSection.classList.toggle('hidden', t !== 'image');
    procSection.classList.toggle('hidden', t !== 'procedural');
  }
  // A type change swaps the live layer behind the modal immediately
  // (none ↔ image ↔ procedural), so the user sees the real result at once.
  typeSel.addEventListener('change', () => { syncSections(); applyDraftNow(); });
  syncSections();
  syncMeta();
  // Populate the uploaded-backgrounds grid on open (pre-existing gap): without
  // it the image section started empty and an existing background could not be
  // picked. Async — the grid fills in as soon as the list resolves.
  refreshThumbs();

  const content = el('div', 'config-form');
  content.append(
    el('p', 'bg-live-hint', 'Changes apply live to the background behind this window. Save keeps them; Cancel restores the previous background.'),
    typeField,
    imageSection,
    procSection
  );

  // ---- save / close -----------------------------------------------------------
  const ctrl = HolafModal.open({
    title: 'Background',
    size: 'md',
    content,
    // Any close that is NOT a successful Save means "revert the live draft":
    // Cancel, Escape, overlay click and the ✕ button all funnel through here.
    onClose: () => {
      if (applyTimer) {
        clearTimeout(applyTimer);
        applyTimer = null;
      }
      if (!committed) {
        try {
          applyBackground(clone(saved));
        } catch (err) {
          console.error('[backgrounds] revert failed:', err);
        }
      }
    },
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

  // The background behind the modal IS the preview: neutralise the overlay
  // scrim (fully transparent — no darkening over the animated background) and
  // anchor the opaque panel to the LEFT so the largest possible area stays
  // visible. The panel keeps its own opaque surface + shadow → still readable.
  // (HolafModal exposes --hm-overlay-bg per instance; setting it here, after
  // open(), wins over the global theme without touching the palette.)
  ctrl.overlay.style.setProperty('--hm-overlay-bg', 'transparent');
  ctrl.overlay.style.justifyContent = 'flex-start';

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
        background = {
          type: 'procedural',
          procedural: {
            generator: genSel.value,
            speed: num(speedInput.input, 1),
            density: num(densityInput.input, 10),
            opacity: num(opacityInput.input, 1),
            blur: num(procBlurInput.input, 0),
            scale: Math.round(num(scaleInput.input, 100)),
            fps: Math.round(num(fpsInput.input, 60)),
            links: linksInput.checked,
            colors: parsedColors(),
          },
        };
      }
      // Server-side strict validation is the gate; reflect failures inline.
      const next = await api.put('/api/settings', { theme: settings?.theme || 'dark', background });
      committed = true; // the draft is now the saved state → close must not revert
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

/**
 * Slider field (mock homy-bg-modal-mock.html): fine track + accent handle,
 * label on the left, LIVE value right-aligned inside the label row (e.g.
 * « 1.0 », « 0 px », « 40 % »), optional help / dynamic help below the track.
 * Value formatting derives the decimal count from `step` (0.1 → « 1.0 »,
 * 0.05 → « 1.00 », integers stay integers) — exactly the mock's formatting.
 */
function decimalsOf(step) {
  const s = String(step ?? 1);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

function formatRange(input, opts) {
  const n = Number(input.value);
  const txt = Number.isFinite(n) ? n.toFixed(decimalsOf(opts.step)) : String(input.value);
  return opts.unit ? `${txt} ${opts.unit}` : txt;
}

function rangeField(label, min, max, step, value, opts = {}) {
  // Merge step into the formatter options (decimals of the badge derive from it).
  const fmtOpts = { step, unit: opts.unit, help: opts.help, helpEl: opts.helpEl };
  const input = el('input', null, null, { type: 'range', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  const valEl = el('span', 'field-val', formatRange(input, fmtOpts));
  const labelEl = el('label');
  const labelSpan = el('span', null, label);
  labelSpan.appendChild(valEl);
  labelEl.append(labelSpan, input);
  let helpEl = null;
  if (typeof fmtOpts.help === 'string') {
    helpEl = el('span', 'field-help', fmtOpts.help);
    labelEl.appendChild(helpEl);
  } else if (fmtOpts.helpEl) {
    // Dynamic help (e.g. density's « ≈ N ribbons »): caller keeps the element
    // and refreshes its text; it lives INSIDE the label, under the track.
    helpEl = fmtOpts.helpEl;
    labelEl.appendChild(helpEl);
  }
  input.addEventListener('input', () => {
    valEl.textContent = formatRange(input, fmtOpts);
  });
  return {
    input,
    wrap: labelEl,
    /** Re-rend the value badge (used when a preset sets input.value directly). */
    sync() {
      valEl.textContent = formatRange(input, fmtOpts);
    },
  };
}
