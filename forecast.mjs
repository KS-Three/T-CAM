/**
 * forecast.mjs — the hourly forecast the map's weather strip scrubs through.
 *
 * The planner already fetches a forecast, but it keeps only the hours inside
 * its two sit windows and throws the rest away — right for ranking sits,
 * useless for "show me the wind swinging round tomorrow afternoon". This
 * fetches the same Open-Meteo endpoint and keeps every hour, shaped small
 * enough to bake into an API answer the phone can cache.
 *
 * The page never calls Open-Meteo itself: the offline test pins that pages
 * contact no external host, so this goes through the server's /api/forecast,
 * which caches the answer in SQLite (see db.mjs `forecasts`). In the truck
 * with no signal the strip shows the last fetched forecast and says how old
 * it is, which beats both a blank strip and a stale one passed off as live.
 *
 * Times stay in the PROPERTY's local clock, as naive strings, end to end.
 * Open-Meteo returns them that way with timezone=auto, and parsing them into
 * Date objects would re-interpret them in whatever timezone the browser
 * happens to be in — the same trap legal-light.mjs documents. The one
 * calculation that needs "now" uses the returned utcOffsetSeconds instead.
 */

import { COMPASS } from './routes.mjs';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
export const ENDPOINT = () => process.env.TRAILCAM_FORECAST_URL || FORECAST;

/** How long a cached forecast is served before refetching. Open-Meteo updates
 *  hourly; refetching much faster than that spends requests on identical
 *  numbers. */
export const FORECAST_TTL_MINUTES = 45;

export const compassOf = deg =>
  COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/**
 * WMO weather codes, as words a hunter would use. Grouped deliberately
 * coarsely — the strip has room for one word, and "light drizzle" versus
 * "dense drizzle" is not a decision anybody changes a sit over.
 */
export function wmoWord(code) {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code === 61 || code === 80) return 'light rain';
  if (code === 63 || code === 81) return 'rain';
  if (code === 65 || code === 82) return 'heavy rain';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code === 71 || code === 85) return 'light snow';
  if (code === 73) return 'snow';
  if (code === 75 || code === 77 || code === 86) return 'heavy snow';
  if (code >= 95) return 'thunderstorm';
  return null;
}

/** Fetch the raw hourly forecast. Same endpoint, units and fields the planner
 *  uses, plus gusts and the sky — the strip answers "what will it feel like",
 *  not just "what scores". */
export async function fetchForecast(lat, lng, { days = 7, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('a forecast needs a latitude and longitude');
  }
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lng),
    hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,'
      + 'precipitation,precipitation_probability,cloud_cover,weather_code',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
    timezone: 'auto', forecast_days: String(days),
  });
  const res = await fetchImpl(`${ENDPOINT()}?${params}`);
  if (!res.ok) throw new Error(`forecast request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`forecast error: ${body.reason ?? 'unknown'}`);
  if (!Array.isArray(body?.hourly?.time) || !body.hourly.time.length) {
    throw new Error('forecast response missing hourly data');
  }
  return body;
}

const round = (v, dp = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/**
 * The raw response, cut down to what the strip reads. Parallel arrays rather
 * than an object per hour: 168 hours ride along on every load of the page
 * that caches this, and the keys would outweigh the numbers.
 */
export function shapeForecast(raw) {
  const h = raw.hourly;
  const n = h.time.length;
  const grab = (name, dp) =>
    Array.from({ length: n }, (_, i) => round(h[name]?.[i], dp));
  const code = grab('weather_code');
  return {
    timezone: raw.timezone ?? null,
    utcOffsetSeconds: Number.isFinite(raw.utc_offset_seconds) ? raw.utc_offset_seconds : null,
    // Naive local strings, deliberately unparsed — see the module comment.
    time: h.time.slice(0, n),
    temp: grab('temperature_2m'),
    wind: grab('wind_speed_10m'),
    gust: grab('wind_gusts_10m'),
    dir: grab('wind_direction_10m'),
    precip: grab('precipitation', 2),
    prob: grab('precipitation_probability'),
    cloud: grab('cloud_cover'),
    code,
    // The words ride along rather than the page carrying the WMO table: one
    // definition, and the strip never shows a code the table has not met.
    sky: code.map(wmoWord),
  };
}
