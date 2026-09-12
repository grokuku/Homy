import { el } from '../util.js';

// Auto-fit bounds: the container's font-size is scaled (everything in the clock
// uses `em`, so time and date stay proportional). FIT_RATIO leaves a small
// margin so the text never touches the frame.
const MIN_FIT_PX = 10;
const FIT_RATIO = 0.94;

/**
 * Clock widget: live time + optional date.
 * config: { format: '24h' | '12h', timezone, showDate, style: 'digital' |
 *           'minimal', fitToFrame, autoSizeMax }
 */
export const clock = {
  name: 'Clock',
  icon: '🕐',
  category: 'data',
  defaultSize: { w: 5, h: 2 }, // 2×2 on the legacy 12-col grid, rescaled ×32/12 (h unchanged: row heights did not change)
  settingsSchema: {
    fields: [
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        default: '24h',
        options: [
          { value: '24h', label: '24-hour' },
          { value: '12h', label: '12-hour' },
        ],
      },
      {
        key: 'timezone',
        label: 'Timezone (IANA, optional)',
        type: 'text',
        default: '',
        placeholder: 'e.g. Europe/Paris',
      },
      { key: 'showDate', label: 'Show date', type: 'toggle', default: true },
      {
        key: 'style',
        label: 'Style',
        type: 'select',
        default: 'digital',
        options: [
          { value: 'digital', label: 'Digital' },
          { value: 'minimal', label: 'Minimal' },
        ],
      },
      { key: 'fitToFrame', label: 'Fit to frame', type: 'toggle', default: false, help: 'Scale time and date to the widget size' },
      {
        key: 'autoSizeMax',
        label: 'Maximum size',
        type: 'range',
        default: 120,
        min: 16,
        max: 400,
        step: 4,
        unit: 'px',
        help: 'Upper bound for the auto-fitted clock (Fit to frame only)',
      },
    ],
  },

  render(container, config) {
    const format = config?.format === '12h' ? '12h' : '24h';
    const showDate = config?.showDate !== false;
    const style = config?.style === 'minimal' ? 'minimal' : 'digital';
    const tz = (config?.timezone || '').trim();
    const fitToFrame = config?.fitToFrame === true;
    const autoSizeMax = clampNumber(config?.autoSizeMax, 16, 400, 120);

    // The container persists between re-renders: drop the style class and any
    // inline font-size left by a previous Fit-to-frame run so switching the
    // option off really restores the default look.
    container.classList.remove('style-digital', 'style-minimal');
    container.classList.add('clock-widget', `style-${style}`);
    container.style.removeProperty('font-size');

    const timeEl = el('div', 'clock-time');
    const dateEl = el('div', 'clock-date');
    container.append(timeEl, dateEl);

    function tick() {
      const now = new Date();
      timeEl.textContent = formatTime(now, format, tz);
      dateEl.textContent = showDate ? formatDate(now, tz) : '';
    }
    tick();
    const timer = setInterval(tick, 1000);

    // ResizeObserver (live) drives the auto-fit. Guarded for old environments;
    // in that case we still fit once synchronously.
    let observer = null;
    if (fitToFrame) {
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => fitClock());
        observer.observe(container);
      }
      fitClock();
    }

    /**
     * Pick the largest base font-size (px) that keeps the time and the date
     * within the frame (width and height). Measured on the live layout with a
     * short binary search so date wrapping is accounted for instead of relying
     * on a fragile hand-computed ratio.
     */
    function fitClock() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return; // not laid out yet — ResizeObserver will re-fire
      const maxW = w * FIT_RATIO;
      const maxH = h * FIT_RATIO;

      const hi0 = Math.max(MIN_FIT_PX, autoSizeMax);
      if (fitsAt(hi0, maxW, maxH)) {
        container.style.fontSize = `${hi0}px`;
        return;
      }
      let lo = MIN_FIT_PX;
      let hi = hi0;
      // ~12 iterations is far more than enough precision for pixel text.
      for (let i = 0; i < 12 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid, maxW, maxH)) lo = mid;
        else hi = mid;
      }
      container.style.fontSize = `${lo.toFixed(2)}px`;
    }

    function fitsAt(basePx, maxW, maxH) {
      container.style.fontSize = `${basePx}px`;
      const t = timeEl.getBoundingClientRect();
      const d = showDate ? dateEl.getBoundingClientRect() : null;
      // The date may wrap, so its widest line is usually what dominates on wide
      // frames. Constrain both elements against the same margin so neither
      // touches (nor overflows) the frame edge.
      const neededW = d ? Math.max(t.width, d.width) : t.width;
      const neededH = d ? d.bottom - t.top : t.height;
      return neededW <= maxW && neededH <= maxH;
    }

    // Cleanup: stop the tick AND the ResizeObserver, then drop the inline
    // font-size so a later non-fit render starts from the theme default.
    return () => {
      clearInterval(timer);
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      container.style.removeProperty('font-size');
    };
  },
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function formatTime(date, format, tz) {
  const opts =
    format === '12h'
      ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  return formatWithTimezone(date, opts, tz, (o) => date.toLocaleTimeString(undefined, o));
}

function formatDate(date, tz) {
  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  return formatWithTimezone(date, opts, tz, (o) => date.toLocaleDateString(undefined, o));
}

/**
 * Format with a timezone, falling back to the local timezone if the IANA name
 * is invalid (RangeError). Guards the per-second clock tick so a bad timezone
 * config can never crash the widget rendering every second.
 */
function formatWithTimezone(date, opts, tz, formatter) {
  if (!tz) return formatter(opts);
  try {
    return formatter({ ...opts, timeZone: tz });
  } catch {
    // Invalid IANA timezone — fall back to local-time formatting.
    return formatter(opts);
  }
}
