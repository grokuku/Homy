import { el } from '../util.js';
import { api } from '../api.js';

const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
};

/**
 * Weather widget. Fetches current conditions through the backend proxy
 * (`/api/weather`) which talks to open-meteo (free, no API key).
 * config: { city, units: 'metric' | 'imperial' }
 */
export const weather = {
  name: 'Weather',
  icon: '🌤',
  category: 'data',
  defaultSize: { w: 2, h: 2 },
  settingsSchema: {
    fields: [
      { key: 'city', label: 'City', type: 'text', default: '', required: true, placeholder: 'e.g. Paris' },
      {
        key: 'units',
        label: 'Units',
        type: 'select',
        default: 'metric',
        options: [
          { value: 'metric', label: 'Celsius (°C)' },
          { value: 'imperial', label: 'Fahrenheit (°F)' },
        ],
      },
    ],
  },

  render(container, config) {
    const city = (config?.city || '').trim();
    const units = config?.units === 'imperial' ? 'imperial' : 'metric';

    container.classList.add('weather-widget');
    if (!city) {
      container.appendChild(el('p', 'muted', 'Configure a city to show weather.'));
      return;
    }

    const body = el('div', 'weather-body');
    body.appendChild(el('div', 'weather-loading', 'Loading…'));
    container.appendChild(body);

    let cancelled = false;
    async function load() {
      try {
        const data = await api.get(`/api/weather?city=${encodeURIComponent(city)}&units=${units}`);
        if (cancelled) return;
        renderWeather(body, data);
      } catch (err) {
        if (cancelled) return;
        body.replaceChildren(el('p', 'muted', err.message || 'Weather unavailable'));
      }
    }
    load();
    const timer = setInterval(load, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  },
};

function renderWeather(body, data) {
  body.replaceChildren();
  const temp = data.temperature != null ? `${Math.round(data.temperature)}°` : '—';
  const unit = data.units === 'imperial' ? 'F' : 'C';
  const cond = WEATHER_CODES[data.weatherCode] || '—';
  const wind = data.windSpeed != null ? `${Math.round(data.windSpeed)} ${data.units === 'imperial' ? 'mph' : 'km/h'}` : '';

  const top = el('div', 'weather-top');
  top.appendChild(el('div', 'weather-temp', `${temp}${unit}`));
  top.appendChild(el('div', 'weather-city', data.city || ''));
  body.appendChild(top);
  body.appendChild(el('div', 'weather-cond', cond));
  if (wind) body.appendChild(el('div', 'weather-wind', `Wind ${wind}`));
}
