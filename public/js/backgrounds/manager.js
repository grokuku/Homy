import { HolafAmbient } from '../../vendor/holaf/holaf-ambient.js';

/**
 * Background manager (lot 3).
 *
 * Three exclusive modes driven by settings.background:
 *   - 'none'       → no layer at all (plain theme background),
 *   - 'image'      → one <div> with the image (z-index -3) + one dim overlay
 *                    (z-index -2), optional blur/dim/scroll behavior,
 *   - 'procedural' → one fullscreen <canvas> (z-index -2) animated by the
 *                    vendored holaf-ambient brick (waves / particles / aurora).
 *
 * Whenever a background is active, <body data-bg-active> is set: style.css
 * keys on it to (a) relax the widget surface opacity to var(--surface-alpha)
 * and (b) enable backdrop-filter on widgets.
 *
 * PERFORMANCE CONTRACT (holaf-ambient provides the lifecycle):
 *   - devicePixelRatio-aware sizing via its internal ResizeObserver (no
 *     debounced window listener needed — the observer fires after resize
 *     settles and re-backs the canvas),
 *   - visibilitychange: the brick pauses its rAF loop when the tab is hidden,
 *   - prefers-reduced-motion: the brick renders ONE static frame, no loop,
 *   - dispose: destroy() cancels the rAF, disconnects the observer and
 *     removes its listeners; layers are removed from the DOM.
 */

let ambient = null; // HolafAmbient instance
let imageEl = null;
let dimEl = null;
let canvasEl = null;
let imgResizeSync = null; // window resize listener for scroll-mode image height

/** Apply a (server-validated) background descriptor. */
export function applyBackground(bg) {
  disposeBackground();
  const type = bg?.type || 'none';
  if (type === 'none') {
    document.body.removeAttribute('data-bg-active');
    return;
  }
  document.body.setAttribute('data-bg-active', '');

  if (type === 'image') {
    renderImage(bg.image || {});
  } else if (type === 'procedural') {
    renderProcedural(bg.procedural || {});
  }
}

/** Remove every layer + stop the animation loop. Safe to call repeatedly. */
export function disposeBackground() {
  if (ambient) {
    ambient.destroy();
    ambient = null;
  }
  if (imageEl) {
    imageEl.remove();
    imageEl = null;
  }
  if (dimEl) {
    dimEl.remove();
    dimEl = null;
  }
  if (canvasEl) {
    canvasEl.remove();
    canvasEl = null;
  }
  if (imgResizeSync) {
    window.removeEventListener('resize', imgResizeSync);
    imgResizeSync = null;
  }
}

// ---- image layer ------------------------------------------------------------

function renderImage(img) {
  // img.name is a server-validated UUID filename.
  imageEl = document.createElement('div');
  imageEl.id = 'homy-bg-image';
  imageEl.style.backgroundImage = `url("/backgrounds/${encodeURIComponent(img.name || '')}")`;
  const blur = Number(img.blur) || 0;
  if (blur > 0) {
    imageEl.style.filter = `blur(${blur}px)`;
    // Slight overscale hides the translucent blur fringe at the edges.
    imageEl.style.transform = 'scale(1.08)';
  }
  if (!img.fixed) {
    // Scroll with the page content instead of staying viewport-fixed.
    imageEl.classList.add('homy-bg-scroll');
    const syncHeight = () => {
      if (!imageEl) return;
      imageEl.style.height = `${document.documentElement.scrollHeight}px`;
    };
    syncHeight();
    imgResizeSync = syncHeight;
    window.addEventListener('resize', imgResizeSync);
  }
  document.body.appendChild(imageEl);

  const dim = Math.min(80, Math.max(0, Number(img.dim) || 0));
  if (dim > 0) {
    dimEl = document.createElement('div');
    dimEl.id = 'homy-bg-dim';
    dimEl.style.background = `rgba(0, 0, 0, ${dim / 100})`;
    document.body.appendChild(dimEl);
  }
}

// ---- procedural layer -------------------------------------------------------

function renderProcedural(proc) {
  canvasEl = document.createElement('canvas');
  canvasEl.id = 'homy-bg-canvas';
  document.body.appendChild(canvasEl);

  const opts = {
    target: canvasEl,
    mode: ['waves', 'particles', 'aurora'].includes(proc.generator) ? proc.generator : 'waves',
    speed: Number.isFinite(Number(proc.speed)) ? Number(proc.speed) : 1,
    density: Number.isFinite(Number(proc.density)) ? Number(proc.density) : 10,
    opacity: Number.isFinite(Number(proc.opacity)) ? Number(proc.opacity) : 1,
    // Flou gaussien global du fond (0 = net). La brique l'ignore proprement
    // là où ctx.filter n'existe pas (Safari < 18).
    blur: Number.isFinite(Number(proc.blur)) ? Number(proc.blur) : 0,
    links: proc.links !== false,
  };
  if (Array.isArray(proc.colors) && proc.colors.length > 0) {
    opts.colors = proc.colors.filter((c) => typeof c === 'string');
  }
  try {
    ambient = HolafAmbient.create(opts);
  } catch (err) {
    console.error('[backgrounds] ambient creation failed:', err);
    canvasEl.remove();
    canvasEl = null;
    document.body.removeAttribute('data-bg-active');
  }
}