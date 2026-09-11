import { Hono } from 'hono';

/**
 * Weather proxy. The frontend calls this endpoint instead of open-meteo
 * directly, which avoids CORS and lets us cache responses server-side.
 *
 * open-meteo is free and requires no API key. We geocode the city name first,
 * then fetch current conditions. Results are cached in memory for 10 minutes.
 */
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { data, expires }

export const weatherRoutes = new Hono();

weatherRoutes.get('/', async (c) => {
  const city = String(c.req.query('city') || '').trim();
  const units = c.req.query('units') === 'imperial' ? 'imperial' : 'metric';

  if (!city) return c.json({ error: 'city is required' }, 400);
  if (city.length > 200) return c.json({ error: 'city is too long' }, 400);

  const cacheKey = `${city.toLowerCase()}|${units}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return c.json(hit.data);

  try {
    const geo = await fetchJson(
      `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
    );
    const place = geo?.results?.[0];
    if (!place) return c.json({ error: `City not found: ${city}` }, 404);

    const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
    const windUnit = units === 'imperial' ? 'mph' : 'kmh';
    const forecast = await fetchJson(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
        `&timezone=auto&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}`
    );

    const data = {
      city: place.name,
      country: place.country || '',
      units,
      temperature: forecast?.current?.temperature_2m ?? null,
      weatherCode: forecast?.current?.weather_code ?? null,
      windSpeed: forecast?.current?.wind_speed_10m ?? null,
      humidity: forecast?.current?.relative_humidity_2m ?? null,
      updatedAt: Date.now(),
    };

    cache.set(cacheKey, { data, expires: Date.now() + CACHE_TTL_MS });
    purgeCache();
    return c.json(data);
  } catch (err) {
    console.error('[weather]', err?.message || err);
    return c.json({ error: 'Weather service unavailable' }, 502);
  }
});

/** Drop expired entries so the Map cannot grow unbounded once it grows past 50. */
function purgeCache() {
  if (cache.size <= 50) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('open-meteo request timed out');
    }
    throw new Error('open-meteo unreachable');
  }
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}
