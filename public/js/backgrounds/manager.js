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
 * HOSTING (lot 2, reworked for the pop-free transition):
 * The three layers live on <body>, inside ONE fixed full-viewport wrapper
 * (#homy-bg-layer), in EVERY mode — the wrapper keeps the viewport geometry.
 * In the framed edit preview setBackgroundHost(#grid-preview-bg) merely CLIPS
 * that wrapper to the frame (clip-path, measured from the frame's inner rect)
 * and tags <body> with `.bg-frame`; outside (view mode, logout, small-screen
 * fallback) setBackgroundHost(null) drops the class → full-bleed again. The
 * layers are NEVER re-parented, so background-size:cover is resolved ONCE for
 * the viewport and the brick's ResizeObserver never re-backs the canvas on a
 * mode change: the image crop/canvas backing store are stable throughout the
 * 480 ms swap and only the clip animates (`.bg-anim`, driven by main.js with
 * the same --mode-dur/--mode-ease as the frame dezoom). The SINGLE
 * HolafAmbient instance is reused for the whole session — no second rAF loop
 * is ever created.
 *
 * PERFORMANCE CONTRACT (holaf-ambient provides the lifecycle):
 *   - devicePixelRatio-aware sizing via its internal ResizeObserver (no
 *     debounced window listener needed — the observer fires after resize
 *     settles and re-backs the canvas),
 *   - visibilitychange: the brick pauses its rAF loop when the tab is hidden,
 *   - prefers-reduced-motion: the brick renders ONE static frame, no loop,
 *   - scale/fps (perf options, settings.background.procedural): the buffer is
 *     rendered at scale × css × dpr and upscaled by the compositor, the rAF
 *     loop only paints at the configured fps ceiling (animation speed kept),
 *   - dispose: destroy() cancels the rAF, disconnects the observer and
 *     removes its listeners; layers are removed from the DOM.
 */

let ambient = null; // HolafAmbient instance
let imageEl = null;
let dimEl = null;
let canvasEl = null;
let layerEl = null; // fixed full-viewport wrapper hosting the three layers
let imgResizeSync = null; // window resize listener for scroll-mode image height
let lastImage = null; // last applied image descriptor (scroll re-apply per host)
let host = null; // framed preview host (#grid-preview-bg), or null → full viewport
let currentType = 'none'; // type currently rendered (fast-path in-place updates)

/**
 * Apply a (server-validated) background descriptor.
 *
 * FAST PATH: when the incoming descriptor has the SAME type as the one already
 * rendered, the live layer is updated IN PLACE instead of being torn down:
 *   - procedural → `HolafAmbient.setConfig` — the single instance and its rAF
 *     loop survive, so a live draft (the Background modal previews on the real
 *     full-screen background) never restarts the animation while dragging
 *     sliders, and a `scale` change resizes the backing store + repaints
 *     immediately;
 *   - anything else → full re-render (image layers are cheap; the browser
 *     caches the URL).
 * Any type change still goes through dispose + render, so switching
 * none↔image↔procedural tears the old layer down exactly as before.
 */
export function applyBackground(bg) {
  const type = bg?.type || 'none';

  if (type === 'procedural' && currentType === 'procedural' && ambient) {
    try {
      ambient.setConfig(proceduralOpts(bg.procedural || {}));
      return;
    } catch (err) {
      console.error('[backgrounds] ambient update failed:', err);
      // fall through to a clean re-render below
    }
  }

  disposeBackground();
  currentType = type;
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
  if (layerEl) {
    layerEl.remove();
    layerEl = null;
  }
  if (imgResizeSync) {
    window.removeEventListener('resize', imgResizeSync);
    imgResizeSync = null;
  }
  lastImage = null;
  currentType = 'none';
}

// ---- host / frame clipping (lot 2) -----------------------------------------

/** The fixed wrapper the layers are parented to (created on demand). */
function ensureLayer() {
  if (!layerEl) {
    layerEl = document.createElement('div');
    layerEl.id = 'homy-bg-layer';
    document.body.appendChild(layerEl);
  }
  return layerEl;
}

/** Target the live layers must be parented to (always the wrapper). */
function currentHost() {
  return ensureLayer();
}

/**
 * Place a layer in the fixed wrapper. Kept idempotent (a node already in the
 * wrapper is left untouched) so a repeated call never re-inserts the canvas —
 * a pointless DOM move that would re-trigger the brick's ResizeObserver.
 */
function adopt(el) {
  if (!el) return;
  const target = currentHost();
  if (el.parentNode !== target) target.appendChild(el);
}

/**
 * Point the background at `container` (the framed preview host) or back at the
 * full viewport when null. The layers stay on <body>; only the wrapper's
 * clip-path geometry changes:
 *   - framed  → measure the frame's inner rect (container = #grid-preview-bg,
 *               position:absolute inset:0 inside the bordered frame) and publish
 *               it as --bg-clip-* (viewport px insets + inner corner radius),
 *               then tag <body> with `.bg-frame`;
 *   - null    → drop `.bg-frame` (+ the stale vars) → full-bleed viewport.
 * The measurement runs on the frame at its FINAL identity layout (main.js
 * calls this before the mode animation starts / at its very end), so the
 * stored target is the resting edit rect, not a transformed one.
 */
export function setBackgroundHost(container) {
  const framed = container && container.nodeType === 1 ? container : null;
  host = framed;
  if (!framed) {
    document.body.classList.remove('bg-frame');
    for (const k of ['--bg-clip-t', '--bg-clip-r', '--bg-clip-b', '--bg-clip-l', '--bg-clip-radius']) {
      document.body.style.removeProperty(k);
    }
    applyScrollMode();
    return;
  }
  applyFrameClip(framed);
  document.body.classList.add('bg-frame');
  // The 'scroll with the page' option is meaningless inside a fixed-size
  // frame: re-evaluate it (removes the class + inline height while framed,
  // restores them on the way back to the full viewport).
  applyScrollMode();
}

/**
 * Publish the frame's inner rect as clip insets (viewport px) + corner radius.
 * Uses the live <body>-relative rects so it also works if the frame is not
 * flush with the viewport. `container` is #grid-preview-bg (the frame's inner
 * padding box); its parent is the bordered #grid-preview the radius comes from.
 */
function applyFrameClip(container) {
  const base = (layerEl || imageEl || dimEl || canvasEl)?.getBoundingClientRect();
  const r = container.getBoundingClientRect();
  if (!base || !(r.width > 0) || !(r.height > 0)) return;
  const frame = container.parentElement;
  const fcs = frame ? getComputedStyle(frame) : null;
  const outer = fcs ? parseFloat(fcs.borderTopLeftRadius) || 0 : 0;
  const border = fcs ? parseFloat(fcs.borderTopWidth) || 0 : 0;
  const radius = Math.max(0, Math.round(outer - border));
  const s = document.body.style;
  s.setProperty('--bg-clip-t', `${Math.max(0, Math.round(r.top - base.top))}px`);
  s.setProperty('--bg-clip-r', `${Math.max(0, Math.round(base.right - r.right))}px`);
  s.setProperty('--bg-clip-b', `${Math.max(0, Math.round(base.bottom - r.bottom))}px`);
  s.setProperty('--bg-clip-l', `${Math.max(0, Math.round(r.left - base.left))}px`);
  s.setProperty('--bg-clip-radius', `${radius}px`);
}

/**
 * (Re)apply the image 'scroll' (not fixed) behavior for the CURRENT host.
 * Framed mode always forces cover + no scroll, so the option is neutralized.
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
    // Drop the stale scroll height so the layer fills the viewport again.
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

/**
 * Map a server-validated procedural descriptor to HolafAmbient options.
 * `scale` is stored as a percentage (25..100) in settings and converted to the
 * brick's fraction (0.25..1); `fps` is an integer ceiling (15..60). Shared by
 * the initial render (create) and the in-place setConfig fast path, so both
 * paths always agree.
 */
function proceduralOpts(proc) {
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
    // Performance (holaf-ambient ≥ 0.3.0) : scale = facteur de résolution du
    // buffer interne (settings en %, la brique veut une fraction 0.25..1) et
    // fps = plafond de framerate. Le serveur injecte déjà les défauts 100/60
    // (settings.json anciens compris) ; les replis ci-dessous ne servent que
    // si un jour ce fichier est appelé avec un descriptor brut.
    scale: (Number.isFinite(Number(proc.scale)) ? Number(proc.scale) : 100) / 100,
    fps: Number.isInteger(Number(proc.fps)) && Number(proc.fps) >= 10 ? Number(proc.fps) : 60,
  };
  if (Array.isArray(proc.colors) && proc.colors.length > 0) {
    opts.colors = proc.colors.filter((c) => typeof c === 'string');
  }
  return opts;
}

function renderProcedural(proc) {
  canvasEl = document.createElement('canvas');
  canvasEl.id = 'homy-bg-canvas';
  adopt(canvasEl);
  try {
    ambient = HolafAmbient.create(proceduralOpts(proc));
  } catch (err) {
    console.error('[backgrounds] ambient creation failed:', err);
    canvasEl.remove();
    canvasEl = null;
    document.body.removeAttribute('data-bg-active');
  }
}