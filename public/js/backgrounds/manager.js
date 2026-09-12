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
 * HOSTING (lot 2) — setBackgroundHost(container | null):
 * The three layers normally live on <body> (position:fixed, full viewport).
 * In the framed edit preview they are re-parented into `#grid-preview-bg` and
 * tagged `.bg-scoped`, which switches them to position:absolute; inset:0 so
 * they are CLIPPED by the frame (the 16:9 box has overflow:hidden). Outside
 * the frame (view mode, logout, small-screen fallback) the host is null and
 * the layers go back to <body> as full-viewport fixed layers. The SINGLE
 * HolafAmbient instance is reused throughout: moving its <canvas> makes its
 * internal ResizeObserver fire and re-back the drawing at the new (smaller)
 * size — no second rAF loop is ever created.
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
let lastImage = null; // last applied image descriptor (scroll re-apply on un-scope)
let host = null; // scoped host element, or null → document.body

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
  lastImage = null;
}

// ---- host / scoping (lot 2) -------------------------------------------------

/** Target the live layers must be parented to (frame host or <body>). */
function currentHost() {
  return host || document.body;
}

/**
 * Place a layer in the current host and tag it `.bg-scoped` when hosted by the
 * frame (absolute + clipped) instead of <body> (fixed full-viewport). Moving a
 * node already in the right place is skipped so a repeated call never re-inserts
 * the canvas (which would be a pointless DOM move on every resize).
 */
function adopt(el) {
  if (!el) return;
  el.classList.toggle('bg-scoped', !!host);
  const target = currentHost();
  if (el.parentNode !== target) target.appendChild(el);
}

/**
 * Point the background at `container` (the framed preview host) or back at
 * <body> when null. Re-homes any live layers immediately; layers created later
 * (applyBackground after this call) adopt the current host in render*().
 */
export function setBackgroundHost(container) {
  host = container && container.nodeType === 1 ? container : null;
  adopt(imageEl);
  adopt(dimEl);
  adopt(canvasEl);
  // The 'scroll with the page' option is meaningless inside a fixed-size
  // frame: re-evaluate it (removes the class + inline height while scoped,
  // restores them on the way back to <body>).
  applyScrollMode();
}

/**
 * (Re)apply the image 'scroll' (not fixed) behavior for the CURRENT host.
 * Scoped mode always forces cover + no scroll, so the option is neutralized.
 */
function applyScrollMode() {
  if (!imageEl) return;
  const scrolling = !!lastImage && !lastImage.fixed && !host;
  imageEl.classList.toggle('homy-bg-scroll', scrolling);
  if (imgResizeSync) {
    window.removeEventListener('resize', imgResizeSync);
    imgResizeSync = null;
  }
  if (scrolling) {
    // Scroll with the page content instead of staying viewport-fixed.
    const syncHeight = () => {
      if (!imageEl) return;
      imageEl.style.height = `${document.documentElement.scrollHeight}px`;
    };
    syncHeight();
    imgResizeSync = syncHeight;
    window.addEventListener('resize', imgResizeSync);
  } else {
    // Drop the stale scroll height so the scoped layer fills its host.
    imageEl.style.removeProperty('height');
  }
}

// ---- image layer ------------------------------------------------------------

function renderImage(img) {
  lastImage = img || {};
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
  adopt(imageEl);
  applyScrollMode(); // scroll class + inline height depend on the CURRENT host

  const dim = Math.min(80, Math.max(0, Number(img.dim) || 0));
  if (dim > 0) {
    dimEl = document.createElement('div');
    dimEl.id = 'homy-bg-dim';
    dimEl.style.background = `rgba(0, 0, 0, ${dim / 100})`;
    adopt(dimEl);
  }
}

// ---- procedural layer -------------------------------------------------------

function renderProcedural(proc) {
  canvasEl = document.createElement('canvas');
  canvasEl.id = 'homy-bg-canvas';
  adopt(canvasEl);

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