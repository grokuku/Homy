import { el } from '../util.js';

/**
 * Clock widget: live time + optional date.
 * config: { format: '24h' | '12h', timezone, showDate, style: 'digital' | 'minimal' }
 */
export const clock = {
  name: 'Clock',
  icon: '🕐',
  category: 'data',
  defaultSize: { w: 2, h: 2 },
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
    ],
  },

  render(container, config) {
    const format = config?.format === '12h' ? '12h' : '24h';
    const showDate = config?.showDate !== false;
    const style = config?.style === 'minimal' ? 'minimal' : 'digital';
    const tz = (config?.timezone || '').trim();

    container.classList.add('clock-widget', `style-${style}`);
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
    return () => clearInterval(timer);
  },
};

function formatTime(date, format, tz) {
  const opts =
    format === '12h'
      ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  if (tz) opts.timeZone = tz;
  return date.toLocaleTimeString(undefined, opts);
}

function formatDate(date, tz) {
  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  if (tz) opts.timeZone = tz;
  return date.toLocaleDateString(undefined, opts);
}
