import { api } from './api.js';
import { state } from './state.js';
import { renderViewer } from './grid/viewer.js';
import { initEditor, renderPalette } from './grid/editor.js';
import { GRID_COLUMNS, GRID_ROWS, MAX_ITEMS, CANVAS_ASPECT, CELL_ASPECT_TOLERANCE, computeCanvasFit } from './grid/config.js';
import { getTheme, otherTheme, switchTheme, syncFromServer } from './ui/theme.js';
import { applyBackground, setBackgroundHost } from './backgrounds/manager.js';
import { openBackgroundModal } from './ui/backgroundModal.js';
import { openElementsModal } from './ui/elementsModal.js';
import { openDockyConfigModal } from './ui/dockyModal.js';
import { dockyPoller } from './docky/docky.js';
import { healthUrlPoller } from './health/health.js';
import { initTabs, renderTabs } from './ui/tabs.js';
import { toast } from './ui/toast.js';
import { catalog } from './elements/catalog.js';
import { clearLocalIconCache } from './elements/button.js';

const $ = (id) => document.getElementById(id);

let grid = null; // current grid instance (viewer gridstack or editor handle)
let viewTopbarVisible = false; // VIEW-mode topbar state (right-click toggles; default hidden)
let lastViewTopbarH = 0; // VIEW-mode topbar natural height (for the animated swap)
let switchingPage = false; // page switch in flight (double-click guard on the tabs)

// ---- VIEW ↔ EDIT transition (lot 4) ----------------------------------------
// Visual-only animation between the two modes (see style.css « VIEW ↔ EDIT »):
// the final geometry is always in place on the first frame (gridstack has
// already measured it); only transform/opacity/--guide-op are animated. A
// generation counter invalidates any in-flight rAF/timer so a fast re-toggle
// can never leave a stale callback mutating the classes.
let modeAnimTimer = 0;
let modeAnimRaf = 0;
let modeAnimId = 0;

/**
 * Transition duration, read LIVE from the CSS token --mode-dur. Keeps the
 * JS cleanup timer and the CSS transition in lockstep: they can never drift
 * (the old hardcoded 240ms was a latent bug — slowing --mode-dur left the
 * timer rebuilding the DOM mid-animation), and prefers-reduced-motion's
 * `--mode-dur: 0ms` is honored for free.
 */
function modeDurMs() {
  const raw = getComputedStyle($('dashboard-view')).getPropertyValue('--mode-dur').trim();
  const m = /^([\d.]+)ms$/.exec(raw);
  return m ? parseFloat(m[1]) : 480; // keep the fallback in sync with style.css
}

// ---- Topbar choreography measurement ----------------------------------------
// The right cluster (user/Edit/Logout) slides RIGHT by the width of the
// edit-only admin group (Background/Theme) so the admin can descend into the
// vacated slot. Both groups are laid out in EVERY mode (the admin is
// absolutely positioned and only faded/moved in VIEW), so offsetWidth is valid
// whatever the current mode. Kept in sync with the CSS contract: the admin's
// `right` is `--cluster-w + 10px` (see .editor-actions in style.css).
const TOPBAR_GROUP_GAP = 10;
function measureTopbarGroups() {
  const view = $('dashboard-view');
  const admin = $('editor-actions');
  const cluster = view.querySelector('.topbar-actions');
  if (!admin || !cluster) return;
  view.style.setProperty('--shift', `${admin.offsetWidth + TOPBAR_GROUP_GAP}px`);
  view.style.setProperty('--cluster-w', `${cluster.offsetWidth}px`);
}

/**
 * Publish `--bar-grow`: how much taller the bar is in EDIT than in VIEW (the
 * pages row appears in edit mode). It is the bottom inset of the topbar's
 * clip-path, so the bar GROWS IN PLACE (visual only) instead of animating its
 * layout — gridstack must keep reading the final EDIT geometry from frame 1.
 * 0 whenever the VIEW bar already includes the tabs row (>= 2 pages), and 0 in
 * view mode (there is nothing to grow back to).
 */
function updateBarGrow() {
  const view = $('dashboard-view');
  const topbar = view.querySelector('.topbar');
  if (!topbar) return;
  const grow =
    state.mode === 'edit' ? Math.max(0, topbar.offsetHeight - lastViewTopbarH) : 0;
  view.style.setProperty('--bar-grow', `${grow}px`);
}

/**
 * Tabs are visible in VIEW mode iff there are >= 2 pages (tabs.js contract).
 * When that is the case the row must NOT slide on a mode change (it is already
 * there — sliding it would snap backwards on the first frame): `.tabs-static`
 * pins it to its resting look. With a single page the row is edit-only, so it
 * animates in/out like the mockup.
 */
function syncTabsStatic() {
  $('dashboard-view').classList.toggle('tabs-static', (state.pages?.length || 0) >= 2);
}

// Must match MAX_BODY_BYTES in server/routes/layout.routes.js (review C3):
// the client refuses to send a body the server would 413, so the failure is
// explained instead of silently dropped.
const MAX_BODY_BYTES = 256 * 1024;

// ---- View switching --------------------------------------------------------

function showLogin() {
  $('dashboard-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('setup-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
  $('login-error').textContent = '';
}

function showSetup() {
  $('dashboard-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('login-form').classList.add('hidden');
  $('setup-form').classList.remove('hidden');
  $('setup-error').textContent = '';
}

async function showDashboard() {
  $('login-view').classList.add('hidden');
  $('dashboard-view').classList.remove('hidden');
  $('user-label').textContent = state.user || '';
  // VIEW-mode topbar starts HIDDEN on every (re)entry (right-click reveals it).
  // Apply the collapsed state SYNCHRONOUSLY, before the first await: the
  // dashboard was just revealed, so the bar is laid out and its height can be
  // measured right now — a slow layout/settings fetch can therefore never
  // flash the bar before setMode('view') below re-affirms the same state.
  viewTopbarVisible = false;
  state.mode = 'view';
  applyTopbarState({ animate: false });

  try {
    // Fetch the element catalogue alongside the layout so a `group` renders
    // its tiles with the real names/icons on the FIRST paint (catalog.load is
    // tolerant — never rejects — so it can never break the dashboard boot).
    const [layoutRes, widgetsRes, settingsRes] = await Promise.all([
      api.get('/api/layout'),
      api.get('/api/widgets'),
      api.get('/api/settings'),
      catalog.load(),
    ]);
    state.layout = layoutRes.items || [];
    // Column count the layout was last saved with. Legacy layouts (no
    // `columns` field in layout.json) report 12 and are migrated client-side
    // by the editor/viewer via gridstack's column(32, 'moveScale') reflow.
    state.layoutColumns = Number(layoutRes.columns) || 12;
    // Multiple pages (schema v3): tab summary + memorized active page.
    state.pages = Array.isArray(layoutRes.pages) ? layoutRes.pages : [];
    state.activePageId = layoutRes.activePageId || state.pages[0]?.id || null;
    state.widgets = widgetsRes.widgets || [];
    state.settings = settingsRes || state.settings;
  } catch {
    state.layout = [];
    state.widgets = [];
  }

  // Server settings are the source of truth once authenticated: refresh the
  // anti-flash localStorage mirror and the live background.
  syncFromServer(state.settings.theme);
  applyBackground(state.settings.background);
  updateThemeButton();

  setMode('view');
}

// ---- Grid mode -------------------------------------------------------------

function destroyGrid() {
  if (grid) {
    try {
      grid.destroy?.();
    } catch {
      /* ignore */
    }
    grid = null;
  }
  // gridstack.destroy() removes its container element from the DOM, so the
  // original #grid-container is gone once a grid has been destroyed (this
  // happens on every view/edit switch). Re-create a fresh container if needed
  // and attach it INSIDE the preview frame (lot 1 structure).
  let container = $('grid-container');
  if (container) {
    container.replaceChildren();
  } else {
    container = document.createElement('div');
    container.id = 'grid-container';
    container.className = 'grid-stack';
    $('grid-preview').appendChild(container);
  }
  // Review C12: scrub whatever gridstack/editor left on the container. The
  // fresh re-creation above is normally clean, but if destroy() threw (e.g.
  // double-destroy) the SAME element is reused: it would keep the editor's
  // .editing-grid class (grid lines visible in view mode) and gridstack's
  // inline style (CSS vars + fixed height) — both must go before the next init.
  container.classList.remove('editing-grid');
  container.removeAttribute('style');
}

// ---- Adaptive edit-preview dezoom (lot 1) ----------------------------------
// The framed preview shows the WHOLE 32×18 canvas scaled down so the 16:9
// frame still fits beside the docked palette. The logical canvas keeps the
// exact size it has in view mode (so widget layout is WYSIWYG); only the
// rendered scale changes.
//
// Bounds / fallback (documented thresholds):
//  - PREVIEW_CELL_MIN: the rendered cell must stay >= 20px. This mirrors the
//    640px cell floor already enforced in CSS (640 = 32 × 20).
//  - PREVIEW_MIN_SCALE: hard lower bound on f, belt-and-braces.
//  - PREVIEW_BORDER: must match #grid-preview's border width in style.css.
// Below the floors edit mode drops the frame entirely and falls back to the
// legacy behavior (floating palette, min-width:640px + horizontal pan).
const PREVIEW_CELL_MIN = 20; // px — rendered cell-width floor
const PREVIEW_MIN_SCALE = 0.3; // hard floor on the adaptive scale f
const PREVIEW_BORDER = 2; // px — #grid-preview border width (style.css)

// ---- Canvas geometry pinning (lot E + fill-with-tolerance) -----------------
/**
 * Pin the canvas box to a FRESH JavaScript measurement (CSS vars --canvas-w /
 * --canvas-h on #grid-wrap, consumed by #grid-container's width/height in CSS).
 *
 * WHY (lot E, empty-page scrollbar in view mode): the CSS width used pure
 * container-query units (min(100cqw, 100cqh·16/9)). Those units resolve
 * against the query container's CURRENT box — which is mid-flight whenever a
 * grid rebuild races the 200ms topbar reveal animation (right-click toggle
 * followed immediately by a tab switch): gridstack then reads a stale
 * clientWidth, freezes cellHeight from it (its ResizeObserver is throttled
 * and short-circuits on prevWidth === clientWidth, so it may never converge
 * in frame-starved environments) and the canvas ends up TALLER than the real
 * area — a phantom vertical scrollbar on .grid-wrap (most visible on an
 * empty page). A JS measurement here is never stale: getBoundingClientRect /
 * clientWidth force a synchronous layout with the transition already snapped
 * to its final value by applyTopbarState({animate:false}) in setMode().
 *
 * FILL (user decision): instead of a strict 16:9 fit, the 32×18 canvas now
 * STRETCHES to fill the available box (the 18 rows take the full height, the
 * 32 columns the full width), cells being deformed by at most
 * --cell-aspect-tolerance (±20 % by default). When the required deformation
 * would exceed that bound the fit reverts to the centered 16:9 letterbox (see
 * computeCanvasFit in grid/config.js). The fit is purely a function of the
 * measured box → identical at every call site (view, resize, animation).
 *
 * The measured width/height are floored to INTEGER pixels: gridstack derives
 * item widths from the container's clientWidth (percentage column units) and
 * the row pitch from the cellHeight passed alongside (h/18), so integer pins
 * make gridstack's inline height agree EXACTLY with the pinned CSS box — no
 * sub-pixel overflow, no scrollbar, by construction (≤1px narrower than the
 * theoretical fit: imperceptible).
 */

// Row pitch (px) of the pinned VIEW canvas. 0 → gridstack keeps its 'auto'
// square-cell behavior (before the first JS measurement).
let viewCellHeight = 0;
// Row pitch (px) of the EDIT logical canvas (the view-sized canvas behind the
// dezoom). Always >= viewCellHeight once updatePreviewScale ran.
let editCellHeight = 0;

/**
 * Live cell-aspect tolerance: the CSS variable --cell-aspect-tolerance on
 * #dashboard-view is the single tunable knob; the JS constant
 * CELL_ASPECT_TOLERANCE (grid/config.js) is the documented fallback. Reading
 * the CSS value lets a theme/design tweak the bound without touching JS.
 */
function cellAspectTolerance() {
  const raw = getComputedStyle($('dashboard-view'))
    .getPropertyValue('--cell-aspect-tolerance')
    .trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : CELL_ASPECT_TOLERANCE;
}

/** Measured content box of #grid-wrap (padding removed), in CSS px. */
function wrapContentBox() {
  const wrap = $('grid-wrap');
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  // clientWidth: integer, EXCLUDES a classic scrollbar (pan case stays sane);
  // rect.height: fractional, exact — no rounding slack on the vertical fit.
  return {
    width: wrap.clientWidth - padX,
    height: wrap.getBoundingClientRect().height - padY,
  };
}

/**
 * Turn a computeCanvasFit() result into pinned INTEGER pixels. A « fill » fit
 * floors both axes; a « letterbox » fit floors the width and derives the
 * height from the design aspect so its cells stay exactly square. Returns
 * `{ w, h, mode }` or null when the fit is not measurable.
 */
function fitToPixels(fit) {
  if (!fit) return null;
  const w = Math.max(1, Math.floor(fit.width - 0.5));
  if (fit.mode === 'fill') {
    return { w, h: Math.max(1, Math.floor(fit.height - 0.5)), mode: fit.mode };
  }
  return { w, h: w / CANVAS_ASPECT, mode: fit.mode };
}

/**
 * Compute + pin the canvas box for the current wrap measurement. Also caches
 * the VIEW row pitch (h/18) used both by the viewer gridstack and as the
 * logical geometry of the edit preview. Idempotent: safe on every resize.
 */
function updateCanvasGeometry() {
  const box = wrapContentBox();
  const fit = fitToPixels(computeCanvasFit(box.width, box.height, cellAspectTolerance()));
  if (!fit) return null;
  const wrap = $('grid-wrap');
  wrap.style.setProperty('--canvas-w', `${fit.w}px`);
  wrap.style.setProperty('--canvas-h', `${fit.h}px`);
  viewCellHeight = fit.h / GRID_ROWS;
  return fit;
}

// Push the pinned row pitch into gridstack. The viewer exposes the real
// instance (cellHeight method); the editor handle exposes setCellHeight,
// because main.js never sees the raw editor gridstack instance.
function applyGridCellHeight(h) {
  if (!grid || !(h > 0)) return;
  if (typeof grid.setCellHeight === 'function') grid.setCellHeight(h);
  else if (typeof grid.cellHeight === 'function') grid.cellHeight(h);
}

/**
 * Compute (and apply) `--preview-scale` so the whole 16:9 EDIT frame fits the
 * area left of the docked palette, and pin the LOGICAL (16:9) canvas box for
 * the dezoom. All in CSS px:
 *   target  = 16:9 edit canvas for the current viewport (computeEditTarget)
 *   frameW  = min(bodyW − padX − dockW, availH·16/9) → framed content width
 *   f       = (frameW − 2·border) / target.w, then apply the floors above.
 * The frame is FIXED 16:9 (user decision) and `target` is 16:9 too, so the
 * dezoom `scale(f)` is always UNIFORM → the editor's cells stay square and no
 * element is ever distorted. Idempotent: safe on every resize. On the
 * small-screen fallback the frame is dropped entirely (floating palette + pan),
 * the legacy behavior.
 */
function updatePreviewScale() {
  const view = $('dashboard-view');
  const preview = $('grid-preview');
  const clear = () => {
    view.classList.remove('preview-active');
    for (const p of ['--preview-scale', '--view-canvas-w', '--view-canvas-h']) {
      preview.style.removeProperty(p);
    }
  };
  if (state.mode !== 'edit') {
    clear();
    return;
  }
  const wrap = $('grid-wrap');
  const body = $('dashboard-body');
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const availH = wrap.clientHeight - padY;
  const dockW = parseFloat(getComputedStyle(view).getPropertyValue('--palette-dock-w')) || 0;
  // The logical canvas is a 16:9 box (design aspect): the editor always lays
  // out square cells irrespective of the (possibly stretched) VIEW canvas. The
  // scale is the ratio between the framed content and that logical box — NOT
  // the framed area and its own natural fit (those are ~equal, which made f ≈ 1
  // and turned the « dezoom » into a plain size pop).
  const target = computeEditTarget();
  const aspect = CANVAS_ASPECT; // EDIT frame is fixed 16:9
  const frameW = Math.min(body.clientWidth - padX - dockW, availH * aspect);
  const frameContentW = frameW - 2 * PREVIEW_BORDER;
  const frameContentH = frameContentW / aspect;
  const scale = target.w > 0 && frameContentW > 0 ? frameContentW / target.w : 0;
  const ok =
    target.w > 0 &&
    frameContentW / GRID_COLUMNS >= PREVIEW_CELL_MIN &&
    frameContentH / GRID_ROWS >= PREVIEW_CELL_MIN &&
    scale >= PREVIEW_MIN_SCALE;
  if (!ok) {
    // Fallback: no frame, no scale — the legacy behavior (pan inside .grid-wrap).
    // The edit grid then uses the plain VIEW-cell-height pinned above.
    clear();
    editCellHeight = viewCellHeight;
    return;
  }
  view.classList.add('preview-active');
  preview.style.setProperty('--preview-scale', String(scale));
  // Pin the LOGICAL 16:9 canvas box (constant px, read by CSS as
  // #grid-container's width/height). gridstack derives item widths from
  // clientWidth and rows from the cellHeight we set, so this keeps every
  // cell/item stable while the frame box animates — the container never sees a
  // mid-transition size.
  preview.style.setProperty('--view-canvas-w', `${target.w}px`);
  preview.style.setProperty('--view-canvas-h', `${target.h}px`);
  editCellHeight = target.h / GRID_ROWS;
}

/**
 * Measured fit box of the dashboard view for the current viewport + topbar
 * state. Shared by computeViewTarget (VIEW geometry, fill aware) and
 * computeEditTarget (EDIT geometry, forced 16:9).
 */
function viewFitBox() {
  const view = $('dashboard-view');
  const wrap = $('grid-wrap');
  const cs = getComputedStyle(wrap);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const viewportW = view.clientWidth;
  const viewportH = view.clientHeight;
  const barH = viewTopbarVisible ? lastViewTopbarH : 0;
  return {
    viewportW,
    viewportH,
    barH,
    availW: viewportW - padX,
    availH: Math.max(0, viewportH - barH - padY),
    cx: viewportW / 2,
    cy: barH + (viewportH - barH) / 2,
  };
}

/**
 * The geometry the canvas has in VIEW mode for the CURRENT viewport and
 * topbar visibility ({ w, h, cx, cy } = width/height + center). Mirrors the
 * view-mode fit of updateCanvasGeometry() (collapsed bar: full height;
 * right-click-visible bar: minus its measured height), and is used as the
 * target rect of the animated dezoom when the VIEW/EDIT aspects match.
 */
function computeViewTarget() {
  const b = viewFitBox();
  const fit = fitToPixels(computeCanvasFit(b.availW, b.availH, cellAspectTolerance()));
  const geo = fit || { w: Math.max(1, Math.floor(b.availW - 0.5)), h: 0 };
  const h = geo.h > 0 ? geo.h : geo.w / CANVAS_ASPECT;
  return { w: geo.w, h, cx: b.cx, cy: b.cy };
}

/**
 * The geometry the EDIT canvas has for the current viewport: the centered 16:9
 * letterbox of the dashboard area ({ w, h, cx, cy }). Forcing the tolerance to
 * 0 makes computeCanvasFit return the 16:9 letterbox everywhere except a box
 * that is already exactly 16:9 (then the fill and the letterbox coincide). This
 * is the EDIT frame's fixed aspect by user decision.
 */
function computeEditTarget() {
  const b = viewFitBox();
  const fit = fitToPixels(computeCanvasFit(b.availW, b.availH, 0));
  const geo = fit || { w: Math.max(1, Math.floor(b.availW - 0.5)), h: 0 };
  const h = geo.h > 0 ? geo.h : geo.w / CANVAS_ASPECT;
  return { w: geo.w, h, cx: b.cx, cy: b.cy };
}

/**
 * Aspect gap beyond which the VIEW canvas and the fixed 16:9 EDIT frame can no
 * longer be overlaid EXACTLY without a non-uniform (distorting) scale. Within
 * ±ε we keep the seam-free glide onto the view rect; beyond it we switch to the
 * self-dezoom + cross-fade (see setViewOriginTransform). 2 % ≈ 2.6 px of cell
 * anisotropy on a 960-px-tall canvas — below the visible threshold, so the
 * glide stays un-distorted there too.
 */
const TRANSITION_ASPECT_EPSILON = 0.02;
/** Small UNIFORM overshoot of the self-dezoom start/end (aspect-mismatch case). */
const TRANSITION_SELF_DEZOOM = 1.06;

/**
 * Measure the transform that maps the framed preview (identity, final layout)
 * onto the view canvas rect, and publish it as --from-* custom props consumed
 * by the .anim-from-view/.anim-to-view styles.
 *
 * TWO cases, chosen from the VIEW/EDIT aspect gap:
 *  • aspects match (±TRANSITION_ASPECT_EPSILON) — the common 16:9 monitor case:
 *    the first edit frame renders EXACTLY where the view canvas was (same size
 *    + centre) and dezooms into the frame → a single seam-free glide, no fade.
 *  • aspects differ (VIEW stretched by the bounded fill fit, EDIT fixed 16:9):
 *    an exact overlay would require a NON-uniform scale, which would visibly
 *    deform cells/guides during the anim — refused. Instead the frame does a
 *    small UNIFORM dezoom about its OWN centre (tx/ty = 0) and cross-fades
 *    (--from-opacity: 0 → 1), so the geometry change is masked. No distortion,
 *    no abrupt geometry jump, no scrollbar (the dashboard stays overflow:clip
 *    while .mode-anim is on).
 */
function setViewOriginTransform() {
  const preview = $('grid-preview');
  const target = computeViewTarget();
  const r = preview.getBoundingClientRect(); // identity (no anim class yet)
  const frameContentW = r.width - 2 * PREVIEW_BORDER;
  if (!(r.width > 0 && frameContentW > 0 && target.w > 0)) return;
  const viewAspect = target.h > 0 ? target.w / target.h : CANVAS_ASPECT;
  const aspectDelta = Math.abs(viewAspect - CANVAS_ASPECT) / CANVAS_ASPECT;
  if (aspectDelta <= TRANSITION_ASPECT_EPSILON) {
    // Exact glide: the uniform scale target.w/frameContentW maps the frame onto
    // the view canvas width AND height (aspects match) → no fade needed.
    preview.style.setProperty('--from-scale', String(target.w / frameContentW));
    preview.style.setProperty('--from-tx', `${target.cx - (r.left + r.width / 2)}px`);
    preview.style.setProperty('--from-ty', `${target.cy - (r.top + r.height / 2)}px`);
    preview.style.removeProperty('--from-opacity');
    return;
  }
  // Aspects differ: uniform self-dezoom about the frame's own centre + fade.
  preview.style.setProperty('--from-scale', String(TRANSITION_SELF_DEZOOM));
  preview.style.setProperty('--from-tx', '0px');
  preview.style.setProperty('--from-ty', '0px');
  preview.style.setProperty('--from-opacity', '0');
}

/**
 * Clip (or un-clip) the live background to the framed edit preview (lot 2).
 * The layers stay on <body> at full-viewport geometry; manager.setBackgroundHost
 * only re-measures the frame's inner rect and toggles the body.bg-frame clip.
 * Always called right after updatePreviewScale() so a resize crossing the
 * fallback threshold keeps the background clip in sync with the frame.
 */
function syncBackgroundScope() {
  const view = $('dashboard-view');
  // Never re-measure while a mode swap is running: the frame is TRANSFORMED,
  // so getBoundingClientRect() on it would return the mid-flight (view-canvas)
  // rect instead of the resting edit rect. The target published by setMode()
  // is already final, and the swap animates the clip (not the geometry), so
  // the ResizeObserver firing on the entering layout must not clobber it.
  if (
    view.classList.contains('mode-anim') ||
    view.classList.contains('anim-from-view') ||
    view.classList.contains('anim-to-view')
  ) {
    return;
  }
  const scoped =
    state.mode === 'edit' && view.classList.contains('preview-active');
  setBackgroundHost(scoped ? $('grid-preview-bg') : null);
}

// ---- Topbar visibility (VIEW mode) -----------------------------------------
// The topbar is HIDDEN by default in view mode so the display area gets the
// full height; a right-click toggles it. Edit mode keeps it permanently (but
// compact). Collapsing pulls the bar above the viewport by its MEASURED height
// (--topbar-h): #dashboard-body (flex:1) then reclaims exactly that space, so
// the frame is never masked by the bar. The measure is refreshed on every
// layout change (ResizeObserver below) — no hardcoded height anywhere.
function updateTopbarHeight() {
  const view = $('dashboard-view');
  const topbar = view.querySelector('.topbar');
  if (!topbar) return;
  const h = topbar.offsetHeight; // margin independent → valid even when collapsed
  // The VIEW-mode height is remembered while we ARE in view: the animated
  // VIEW↔EDIT swap needs it as the target geometry (the bar is 40px with one
  // row, 78px with the pages row — never assume a constant).
  if (state.mode === 'view' && h > 0) lastViewTopbarH = h;
  if (h > 0 && view.style.getPropertyValue('--topbar-h') !== `${h}px`) {
    view.style.setProperty('--topbar-h', `${h}px`);
  }
}

function applyTopbarState({ animate = true } = {}) {
  // Edit: always shown. View: only after a right-click toggle.
  const collapsed = state.mode === 'view' && !viewTopbarVisible;
  const topbar = $('dashboard-view').querySelector('.topbar');
  // Measure BEFORE collapsing so the negative margin uses the real height.
  updateTopbarHeight();
  // Keep the topbar-choreography measurements in lockstep with the layout:
  // the cluster/admin widths feed --shift/--cluster-w, the height difference
  // feeds --bar-grow (both must be final before any swap reads them).
  measureTopbarGroups();
  updateBarGrow();
  // Mode switches must be INSTANT: gridstack reads the container size right
  // after setMode() (square cell height from clientWidth) and an animating
  // margin would feed it a stale intermediate size — the same trap the old
  // animated with-palette margin fell into. The right-click toggle keeps the
  // 200ms transition (pure view mode: no grid rebuild follows).
  if (!animate && topbar) topbar.classList.add('topbar-instant');
  $('dashboard-view').classList.toggle('topbar-collapsed', collapsed);
  if (!animate && topbar) {
    void topbar.offsetHeight; // flush layout while the transition is disabled
    requestAnimationFrame(() => topbar.classList.remove('topbar-instant'));
  }
}

function toggleViewTopbar() {
  if (state.mode !== 'view') return;
  viewTopbarVisible = !viewTopbarVisible;
  applyTopbarState(); // animated
}

// ---- VIEW ↔ EDIT transition orchestration (lot 4) --------------------------

/** prefers-reduced-motion is honored: no animation at all in that case. */
function prefersReducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Cancel any running/pending mode transition and remove every transition
 * class. Idempotent and safe to call from setMode() on any rebuild: it leaves
 * the dashboard with no residual transform/opacity and no guide fade pending.
 */
function stopModeAnim() {
  modeAnimId += 1; // invalidate in-flight rAF/timer callbacks
  if (modeAnimTimer) {
    clearTimeout(modeAnimTimer);
    modeAnimTimer = 0;
  }
  if (modeAnimRaf) {
    cancelAnimationFrame(modeAnimRaf);
    modeAnimRaf = 0;
  }
  $('dashboard-view').classList.remove('mode-anim', 'anim-from-view', 'anim-to-view');
  // Mirror the transition classes on <body> for the background frame clip:
  // the background layers live OUTSIDE #dashboard-view, but their clip must
  // share the exact same choreography (and the same fast-toggle invalidation).
  document.body.classList.remove('bg-anim', 'bg-from-view', 'bg-to-view');
}

/**
 * VIEW → EDIT: the edit grid has just been BUILT at its final geometry; we
 * paint the « from view » state (frame mapped onto the exact view canvas rect,
 * palette off to the left, controls hidden, guides transparent, topbar visually
 * collapsed) WITHOUT transitions so it snaps, then enable transitions and drop
 * the state class so everything glides to the final EDIT look. Two rAFs are
 * required (see the comments inside).
 */
function playEnterEdit() {
  const view = $('dashboard-view');
  stopModeAnim();
  const id = modeAnimId;
  // Publish the measured view→frame transform BEFORE the from-state class is
  // applied, so getBoundingClientRect() still reads the identity frame box.
  setViewOriginTransform();
  // Phase 1 — apply the from-state WITHOUT .mode-anim so it SNAPS (no
  // transition): otherwise adding the class while transitions are on would
  // make the from-state itself the transition TARGET and the frame would only
  // wiggle around its final value. The from-state also reveals the palette
  // (display:none→flex), which must be painted once before a transition can
  // start from it.
  view.classList.add('anim-from-view');
  // Background: snap its clip to the VIEW look (full viewport) WITHOUT a
  // transition — body.bg-anim is only added in phase 2.
  document.body.classList.add('bg-from-view');
  modeAnimRaf = requestAnimationFrame(() => {
    modeAnimRaf = requestAnimationFrame(() => {
      modeAnimRaf = 0;
      if (id !== modeAnimId) return;
      // Phase 2 — enable transitions and drop the from-state in the SAME
      // frame: the painted from-state is the start value, the final EDIT look
      // is the target.
      view.classList.add('mode-anim');
      view.classList.remove('anim-from-view');
      document.body.classList.add('bg-anim');
      document.body.classList.remove('bg-from-view');
      modeAnimTimer = setTimeout(() => {
        modeAnimTimer = 0;
        if (id !== modeAnimId) return;
        view.classList.remove('mode-anim'); // done: no residual transition class
        document.body.classList.remove('bg-anim');
      }, modeDurMs() + 60);
    });
  });
}

/**
 * EDIT → VIEW: we animate the CURRENT edit DOM toward the view look (frame
 * grows back onto the view canvas rect, palette slides out, guides fade out,
 * topbar slides away) and only rebuild the viewer grid at the end. That keeps
 * the reverse animation truly symmetric (guides/controls/palette all present
 * to animate), and the viewer gridstack still initializes on final geometry
 * after the swap. The target rect is computed analytically from the current
 * viewport + topbar visibility, so it matches the rebuilt viewer exactly.
 */
function playExitEdit() {
  const view = $('dashboard-view');
  stopModeAnim();
  const id = modeAnimId;
  setViewOriginTransform();
  view.classList.add('mode-anim');
  // Background: enable the clip transition now (the resting edit clip is the
  // start value; body.bg-to-view is added after the double rAF as the target).
  document.body.classList.add('bg-anim');
  // Double rAF for the same reason as playEnterEdit: the « to view » state must
  // be painted once before it becomes the transition target (the edit DOM here
  // is already rendered, but this keeps both directions on the same footing).
  modeAnimRaf = requestAnimationFrame(() => {
    modeAnimRaf = requestAnimationFrame(() => {
      modeAnimRaf = 0;
      if (id !== modeAnimId) return;
      view.classList.add('anim-to-view'); // → animate toward VIEW
      document.body.classList.add('bg-to-view'); // → clip toward full viewport
      modeAnimTimer = setTimeout(() => {
        modeAnimTimer = 0;
        if (id !== modeAnimId) return;
        view.classList.remove('mode-anim', 'anim-to-view');
        document.body.classList.remove('bg-anim', 'bg-to-view');
        setMode('view'); // instant, clean rebuild → final VIEW geometry
      }, modeDurMs() + 60);
    });
  });
}

// Right-click: toggle the bar in view mode, and suppress the browser context
// menu everywhere on the dashboard EXCEPT on genuine native targets (text
// fields, links) where the user legitimately wants copy/inspect. Events fired
// inside an <iframe> widget do not bubble to this document at all, so a
// cross-origin iframe keeps its own browser menu (and cannot toggle the bar) —
// documented limitation, not a regression.
function isNativeContextTarget(target) {
  return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable], a[href]'));
}

$('dashboard-view').addEventListener('contextmenu', (e) => {
  if (isNativeContextTarget(e.target)) return;
  e.preventDefault();
  if (state.mode === 'view') toggleViewTopbar();
});

function setMode(mode, { animate = false } = {}) {
  const from = state.mode;
  // Any rebuild cancels a pending/running transition and scrubs its classes:
  // the new grid must never inherit a stale transform/fade (fast re-toggle).
  stopModeAnim();
  state.mode = mode;
  const view = $('dashboard-view');
  // Mode state drives the topbar choreography (resting geometry + per-state
  // beat delays, see style.css « Topbar motion »). mode-* / anim-* names avoid
  // the generic `.view` class (login/dashboard sections).
  view.classList.toggle('mode-edit', mode === 'edit');
  view.classList.toggle('mode-view', mode === 'view');
  syncTabsStatic();
  const btn = $('toggle-mode');
  btn.textContent = mode === 'edit' ? 'Done' : 'Edit';
  btn.classList.toggle('active', mode === 'edit');
  $('editor-palette').classList.toggle('hidden', mode !== 'edit');
  // The Background / Theme buttons are edit-only, exactly like the palette was
  // (they live in the topbar since lot 2). Their visibility is now a CSS state
  // (mode-view parks + fades the group) so it can ANIMATE — the old `.hidden`
  // (display:none) made that impossible. `inert` keeps them unfocusable and
  // unclickable outside edit mode without touching the animation.
  $('editor-actions').toggleAttribute('inert', mode !== 'edit');
  $('grid-wrap').classList.toggle('with-palette', mode === 'edit');
  // Tab strip (multiple pages): rendered BEFORE the topbar is measured so
  // --topbar-h includes the row whenever it must be visible (edit: always;
  // view: only when ≥ 2 pages — see ui/tabs.js renderTabs).
  renderTabs();
  // View mode starts collapsed; edit mode forces the bar visible (compact).
  // Instant (no slide) so the geometry read below is final from the first
  // frame: the snap (topbar-instant) makes the used margin-top the target
  // value NOW, so the canvas width pinned next is measured at final geometry
  // and gridstack can never initialize from a mid-animation size.
  applyTopbarState({ animate: false });

  // Pin the canvas box from a FRESH measurement (see updateCanvasGeometry):
  // must run BEFORE initEditor/renderViewer, whose gridstack derives item
  // widths from the container clientWidth and rows from the cellHeight we pass.
  updateCanvasGeometry();
  destroyGrid();
  // Frame + scale must be applied BEFORE initEditor: it pins the LOGICAL
  // (view-sized) canvas box and the frame aspect, and its cellHeight is what
  // makes the zoomed-in editor compute view-mode-sized cells.
  updatePreviewScale();
  // The frame may have been switched on/off by updatePreviewScale: host the
  // background inside it (clipped) or back on <body>.
  syncBackgroundScope();
  // Both grids initialize at the SAVED column count and migrate to 32
  // themselves when needed. The viewer never persists: state.layout keeps its
  // original coordinates until the editor actually saves.
  const columns = state.layoutColumns || GRID_COLUMNS;
  // Row pitch of the pinned canvas (edit → logical view-sized box). Passed so
  // gridstack deforms the cells exactly like the pinned CSS box instead of
  // deriving a square cell height from clientWidth.
  const cellHeight = mode === 'edit' ? editCellHeight : viewCellHeight;
  if (mode === 'edit') {
    grid = initEditor($('grid-container'), state.layout, { onSave: saveLayout, columns, cellHeight });
    renderPalette($('palette-list'), state.widgets, (type) => {
      // Client-side cap (review C3): mirrors server MAX_ITEMS — adding to a
      // full layout must fail with a visible message HERE, not silently at
      // PUT time (editor.addWidget re-checks, this keeps state.layout honest).
      if (state.layout.length >= MAX_ITEMS) {
        toast(`Cannot add widget: layout is full (max ${MAX_ITEMS} items)`, 'error');
        return;
      }
      grid.addWidget(type);
    });
  } else {
    grid = renderViewer($('grid-container'), state.layout, { columns, cellHeight });
  }
  // gridstack v13 wrote the initial cell height from the option above; re-apply
  // the exact pinned pitch once (idempotent, keeps inline height == --canvas-h).
  applyGridCellHeight(cellHeight);

  // Lot 4 — user-driven VIEW → EDIT swap plays the enter animation now that
  // the edit grid exists at its final geometry. Reduced-motion and every
  // non-interactive rebuild (initial load, page switch) stay instant.
  if (animate && !prefersReducedMotion() && from === 'view' && mode === 'edit') {
    playEnterEdit();
  }
}

function saveLayout(items) {
  state.layout = items;
  // The editor grid always runs at 32 columns (legacy layouts are migrated at
  // init, before any save can happen) → persist the migrated coordinates with
  // the columns field so the next load skips the migration.
  state.layoutColumns = GRID_COLUMNS;
  // Multiple pages: the save MUST target the page the grid currently edits
  // (explicit pageId — the server replaces THAT page's items without ever
  // switching the active one). Read at call time so a page switch that
  // happened between the edit and the debounced save can never misroute it.
  const pageId = state.activePageId || undefined;
  // Review C3: persistence failures are NEVER swallowed. Two pre-checks plus
  // a toasting catch keep the UI and the server from diverging silently:
  //  - body > 256 KB would 413 server-side (limit duplicated above);
  //  - > MAX_ITEMS would 400 server-side (the palette already blocks adding,
  //    this covers layouts that were already over the cap at load).
  const body = JSON.stringify({ items, columns: GRID_COLUMNS, pageId });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    toast('Save failed: layout is too large (server limit 256 KB). Remove widgets or shorten notes.', 'error');
    return Promise.resolve();
  }
  // The returned promise lets the page-switch flush await the actual PUT
  // (ordering: the flushed save must land BEFORE PUT /api/layout/active).
  return api.put('/api/layout', { items, columns: GRID_COLUMNS, pageId })
    .then((res) => {
      // Converge on the server's sanitized items (e.g. h clamped to 18 rows)
      // so the client can never drift from what is actually on disk.
      if (Array.isArray(res?.items)) state.layout = res.items;
      // Item counts (and a possibly server-clamped columns/active id) follow.
      // NOTE: no renderTabs() here — the tab row displays only names + the
      // active state (itemCount lives in the title tooltip only), and a
      // silent row rebuild mid-interaction would cancel an armed delete
      // confirmation or an open rename input for nothing. The row refreshes
      // on its own triggers (setMode / switchPage / page mutations).
      if (Array.isArray(res?.pages)) state.pages = res.pages;
      if (Number(res?.columns) > 0) state.layoutColumns = Number(res.columns);
      if (res?.activePageId) state.activePageId = res.activePageId;
    })
    .catch((err) => toast(err.message || 'Failed to save layout', 'error'));
}

// ---- Page switching (multiple pages, lot C+D) -------------------------------
/**
 * Switch the active dashboard page. Allowed in BOTH modes (view + edit);
 * creation/rename/delete stay edit-only (ui/tabs.js).
 *
 * ORDER IS CRITICAL (the 500 ms debounce window):
 *   1. FLUSH the editor's pending debounced save (and cancel its timer) —
 *      it PUTs the CURRENT page's items with an explicit pageId, so it must
 *      land while state.activePageId still points at the old page. A save
 *      firing AFTER the switch would carry the OLD items under the NEW
 *      active page and silently move them across pages.
 *   2. PUT /api/layout/active {pageId} — ONE round-trip: the server switches
 *      the active page and returns its items + the fresh page list.
 *   3. destroyGrid() — every widget's timers/observers go through the
 *      existing disposeWidget mechanism (editor/viewer destroy).
 *   4. setMode(current mode) — rebuilds the grid through the SAME path as
 *      the initial load: initEditor/renderViewer re-apply normalizeItems()
 *      (geometry hardening + search h:1→h:2) and the legacy 12→32 column
 *      migration client-side, because the server NEVER re-scales
 *      coordinates (columns is global to the file) and a joined page may
 *      still be stored in 12-column coordinates.
 *   updatePreviewScale() + syncBackgroundScope() run inside setMode, and
 *   renderTabs() refreshes the active-tab highlight. NO animation: the
 *   geometry must be final from the first frame (gridstack reads the
 *   container size right after init).
 */
async function switchPage(pageId) {
  if (!pageId || switchingPage) return;
  if (pageId === state.activePageId) return; // re-click the active tab: no-op
  switchingPage = true;
  try {
    // 1) flush (awaitable — saveLayout resolves after the PUT settles; it
    //    toasts on failure itself, a failed save must not block navigation).
    try {
      await grid?.flush?.();
    } catch {
      /* already toasted */
    }
    // 2) single round-trip switch
    const res = await api.put('/api/layout/active', { pageId });
    state.activePageId = res.activePageId;
    if (Array.isArray(res.pages)) state.pages = res.pages;
    state.layout = Array.isArray(res.items) ? res.items : [];
    if (Number(res.columns) > 0) state.layoutColumns = Number(res.columns);
    // 3+4) teardown + rebuild (same normalization path as initial load).
    setMode(state.mode);
  } catch (err) {
    toast(err.message || 'Failed to switch page', 'error');
  } finally {
    switchingPage = false;
  }
}

// ---- Auth forms ------------------------------------------------------------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('login-error').textContent = '';
  try {
    const res = await api.post('/api/auth/login', {
      user: fd.get('user'),
      password: fd.get('password'),
    });
    api.setToken(res.token);
    state.user = res.user;
    showDashboard();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('setup-error').textContent = '';
  if (fd.get('password') !== fd.get('confirm')) {
    $('setup-error').textContent = 'Passwords do not match';
    return;
  }
  try {
    const res = await api.post('/api/auth/setup', {
      user: fd.get('user'),
      password: fd.get('password'),
    });
    api.setToken(res.token);
    state.user = res.user;
    showDashboard();
  } catch (err) {
    $('setup-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* ignore */
  }
  api.setToken(null);
  state.user = null;
  // Cancel any in-flight VIEW↔EDIT transition: its timer must never rebuild a
  // grid (or re-add classes) on the now-hidden dashboard after logout.
  stopModeAnim();
  destroyGrid();
  catalog.clear(); // drop the element cache (next session re-fetches)
  clearLocalIconCache(); // drop inlined local-icon SVGs
  dockyPoller.clear(); // drop Docky subscriptions + batch loop
  healthUrlPoller.clear(); // drop custom-URL health subscriptions + loop
  setBackgroundHost(null); // back to full-viewport background (frame is gone)
  showLogin();
});

$('toggle-mode').addEventListener('click', () => {
  if (state.mode === 'edit' && !prefersReducedMotion()) {
    // Animate the current edit DOM toward view, THEN rebuild (see playExitEdit).
    playExitEdit();
    return;
  }
  setMode(state.mode === 'edit' ? 'view' : 'edit', { animate: true });
});

// ---- Widget config changes outside the ⚙ modal (review C4) -----------------
// Widgets may persist config changes themselves (notes: inline textarea →
// PATCH /api/layout/items/:id/config). Broadcast via 'homy:widget-config'
// (see widgets/notes.js), this keeps BOTH sources of truth in sync so a later
// full-layout PUT can never overwrite the fresh config with a stale copy:
//  - state.layout: the next initEditor/renderViewer must show the new text;
//  - the editor's meta Map (via applyConfig): the next serialize() must
//    include it. In view mode there is no editor — state.layout is enough.
window.addEventListener('homy:widget-config', (e) => {
  const { id, config } = e.detail || {};
  if (!id || !config || typeof config !== 'object') return;
  const item = state.layout.find((i) => i.id === id);
  if (item) item.config = { ...(item.config || {}), ...config };
  grid?.applyConfig?.(id, config);
});

// ---- Group tile edits outside the ⚙ modal (lot 4) --------------------------
// The group widget owns no save path: after any tile mutation (add / options /
// move / resize / delete) it broadcasts the fresh `buttons` here. We keep
// state.layout in sync AND hand the batch to the editor, which debounces the
// PUT /api/layout exactly like a widget drag (its destroy/switch flush covers
// tile edits for free).
window.addEventListener('homy:group-buttons', (e) => {
  const { id, buttons } = e.detail || {};
  if (!id || !Array.isArray(buttons)) return;
  const item = state.layout.find((i) => i.id === id);
  if (item) item.buttons = buttons;
  grid?.applyButtons?.(id, buttons);
});

// ---- Group report tile edits (lot 8) ---------------------------------------
// Same contract as `homy:group-buttons`: the group broadcasts its fresh report
// tiles; we keep state.layout in sync and let the editor debounce the PUT.
window.addEventListener('homy:group-reports', (e) => {
  const { id, reports } = e.detail || {};
  if (!id || !Array.isArray(reports)) return;
  const item = state.layout.find((i) => i.id === id);
  if (item) item.reports = reports;
  grid?.applyReports?.(id, reports);
});

// ---- Dashboard pages tab strip (multiple pages, lot C+D) --------------------
// The row itself is rendered by ui/tabs.js into the reserved #topbar-tabs
// slot; main.js owns the navigation/flush/rebuild pieces it needs:
//  - onSwitch: page switch (the ordered flush→PUT /active→rebuild flow above);
//  - onFlush: the editor's awaitable pending-save flush (before delete/switch);
//  - onRebuild: full grid rebuild after a state change that swapped the active
//    page's items (deletion of the active page → server fallback). setMode
//    already runs destroyGrid + updatePreviewScale + syncBackgroundScope +
//    renderTabs in the right order.
initTabs({
  onSwitch: (pageId) => switchPage(pageId),
  onFlush: () => grid?.flush?.(),
  onRebuild: () => setMode(state.mode),
});

// ---- Editor toolbar: Background + Theme (lot 3) -----------------------------

function updateThemeButton() {
  const btn = $('theme-btn');
  if (!btn) return;
  const t = getTheme();
  btn.textContent = `Theme: ${t === 'dark' ? 'Dark' : 'Light'}`;
  btn.classList.toggle('active', t === 'light');
}

$('theme-btn').addEventListener('click', async () => {
  const previous = getTheme();
  const next = otherTheme();
  try {
    await switchTheme(next, state.settings.background, previous);
    state.settings = { ...state.settings, theme: next };
    updateThemeButton();
  } catch (err) {
    toast(err.message || 'Failed to save theme', 'error');
  }
});

$('bg-btn').addEventListener('click', () => {
  openBackgroundModal({
    settings: state.settings,
    onSaved: (next) => {
      state.settings = next;
      applyBackground(next.background);
    },
  });
});

// Elements catalogue (lot 3): global CRUD screen. The modal refreshes the
// client catalogue itself after every mutation, so groups re-render live.
$('elements-btn').addEventListener('click', () => {
  openElementsModal();
});

// Docky integration config (lot 5): URL + write-only key, with a Test button.
$('docky-btn').addEventListener('click', () => {
  openDockyConfigModal();
});

// If the token expires mid-session, return to login.
window.addEventListener('auth:expired', () => {
  api.setToken(null);
  state.user = null;
  stopModeAnim(); // drop any pending mode-transition timer/rAF (see logout)
  destroyGrid();
  catalog.clear(); // drop the element cache (same as an explicit logout)
  clearLocalIconCache(); // drop inlined local-icon SVGs (same as logout)
  dockyPoller.clear(); // drop Docky subscriptions + batch loop (same as logout)
  healthUrlPoller.clear(); // drop custom-URL health loop (same as logout)
  setBackgroundHost(null);
  showLogin();
});

// ---- Bootstrap -------------------------------------------------------------

// Recompute the edit-preview dezoom whenever the available area changes
// (window resize, topbar reflow, palette docking). Observing #dashboard-body
// covers window resizes; the palette docking itself is handled explicitly in
// setMode(). updatePreviewScale() is idempotent, so double fires are harmless.
// syncBackgroundScope() runs after it because a resize can toggle the frame
// (fallback threshold) and the background must follow the new host.
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    // Topbar height can wrap/change with the width: re-measure it FIRST so the
    // collapse margin and the edit-preview dezoom both use the fresh value.
    updateTopbarHeight();
    // Re-measure the choreography inputs too (cluster/admin widths, bar grow).
    measureTopbarGroups();
    updateBarGrow();
    // Re-pin the canvas box (the wrap resizes with the body — topbar
    // animation, window resize, palette docking) BEFORE the dezoom math.
    updateCanvasGeometry();
    updatePreviewScale();
    // Push the freshly computed row pitch into gridstack: with an explicit
    // cellHeight it no longer derives it from clientWidth (its own
    // ResizeObserver only does that for the 'auto' mode), so a window resize
    // would otherwise keep the stale inline container height.
    applyGridCellHeight(state.mode === 'edit' ? editCellHeight : viewCellHeight);
    syncBackgroundScope();
  }).observe($('dashboard-body'));
}

async function boot() {
  try {
    const status = await api.get('/api/auth/status');
    if (status.firstRun) {
      showSetup();
      return;
    }
  } catch {
    showLogin();
    return;
  }

  if (api.token) {
    try {
      const me = await api.get('/api/auth/me');
      state.user = me.user;
      showDashboard();
      return;
    } catch {
      /* fall through to login */
    }
  }
  showLogin();
}

boot();
