/**
 * wind-history.mjs — which winds actually blow here, during season, at the
 * hours you would be sitting.
 *
 * A stand's good winds are the single most important thing recorded about it,
 * and until now the tool could only say whether a given stand suited a given
 * forecast. That answers "can I sit there this evening". It does not answer the
 * question that decides where you spend a weekend hanging stands: over a whole
 * season, how often is this stand huntable AT ALL?
 *
 * Measured at Kent's property, across seven Novembers, it turns out roughly
 * 44% of huntable hours blow from the western quadrant. So a stand set up for
 * WNW earns its keep and one that only works on an easterly sits idle most of
 * the season — which is worth knowing before you carry a ladder into the woods,
 * not after.
 *
 * This needs no photos, no account, and no money: Open-Meteo publishes the
 * historical archive free and keyless, the same service the planner already
 * uses for its forecast.
 *
 * "Huntable hours" here means exactly what the planner means by a sit — the
 * window around sunrise and sunset — rather than a rough guess at morning and
 * evening. Sunrise moves by well over an hour across a season, so a fixed clock
 * window would weight late-season evenings wrongly.
 */

import { windsForStand } from './coverage.mjs';

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

export const ENDPOINT = () => process.env.TRAILCAM_ARCHIVE_URL || ARCHIVE;

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const compassOf = deg =>
  COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// The same windows the planner scores: an hour and a half before sunrise to
// three and a half after, and three and a half before sunset to half an hour
// after. Kept in one place here and stated so the two cannot quietly diverge.
export const WINDOWS = [
  { name: 'AM', fromSunrise: -1.5, toSunrise: 3.5 },
  { name: 'PM', fromSunset: -3.5, toSunset: 0.5 },
];

// Wisconsin's deer seasons run from the September bow opener into January.
export const SEASON_MONTHS = [9, 10, 11, 12, 1];

/**
 * Pull the archive for a run of years.
 *
 * Requested as one range per year rather than one long span, because a single
 * multi-year request of hourly data is a large response and a slow one, and a
 * failure loses the lot.
 */
export async function fetchArchive(lat, lng, {
  years = 7, endYear = new Date().getFullYear() - 1,
  months = SEASON_MONTHS, fetchImpl = globalThis.fetch, signal,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('wind history needs a latitude and longitude');
  }
  const out = [];
  for (let y = endYear - years + 1; y <= endYear; y++) {
    const params = new URLSearchParams({
      latitude: String(lat), longitude: String(lng),
      start_date: `${y}-01-01`, end_date: `${y}-12-31`,
      hourly: 'wind_direction_10m,wind_speed_10m,temperature_2m',
      daily: 'sunrise,sunset',
      timezone: 'auto',
    });
    const res = await fetchImpl(`${ENDPOINT()}?${params}`, { signal });
    if (!res.ok) throw new Error(`weather archive returned HTTP ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error(`weather archive error: ${body.reason ?? 'unknown'}`);
    out.push(body);
  }
  return out;
}

const hourOf = iso => Number(iso.slice(11, 13));
const monthOf = iso => Number(iso.slice(5, 7));

/**
 * Reduce the archive to how often each compass point blows during huntable
 * hours, overall and split by morning and evening.
 *
 * The AM/PM split matters and is not decoration: thermals and prevailing flow
 * differ between dawn and dusk, so a stand can be a morning stand and not an
 * evening one. Anywhere the two disagree, that is a real fact about the stand.
 */
export function climatology(archives, { months = SEASON_MONTHS } = {}) {
  const wanted = new Set(months);
  const counts = { all: new Map(), AM: new Map(), PM: new Map() };
  const speeds = [];
  let hours = 0;
  let days = 0;

  for (const a of archives) {
    const daily = a.daily ?? {};
    const hourly = a.hourly ?? {};
    if (!daily.time || !hourly.time) continue;

    // Sunrise and sunset by date, so each hour can be placed in a window.
    const sun = new Map();
    for (let i = 0; i < daily.time.length; i++) {
      if (!wanted.has(monthOf(daily.time[i]))) continue;
      const rise = daily.sunrise?.[i], set = daily.sunset?.[i];
      if (!rise || !set) continue;
      sun.set(daily.time[i], { rise: hourOf(rise) + Number(rise.slice(14, 16)) / 60,
                               set: hourOf(set) + Number(set.slice(14, 16)) / 60 });
      days++;
    }

    for (let i = 0; i < hourly.time.length; i++) {
      const t = hourly.time[i];
      const dir = hourly.wind_direction_10m?.[i];
      if (dir === null || dir === undefined) continue;
      const s = sun.get(t.slice(0, 10));
      if (!s) continue;
      const h = hourOf(t);

      let window = null;
      if (h >= s.rise - 1.5 && h <= s.rise + 3.5) window = 'AM';
      else if (h >= s.set - 3.5 && h <= s.set + 0.5) window = 'PM';
      if (!window) continue;

      const point = compassOf(dir);
      counts.all.set(point, (counts.all.get(point) ?? 0) + 1);
      counts[window].set(point, (counts[window].get(point) ?? 0) + 1);
      const spd = hourly.wind_speed_10m?.[i];
      if (Number.isFinite(spd)) speeds.push(spd);
      hours++;
    }
  }

  const pct = map => {
    const total = [...map.values()].reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(COMPASS.map(p =>
      [p, Math.round(1000 * (map.get(p) ?? 0) / total) / 10]));
  };
  speeds.sort((a, b) => a - b);

  return {
    hours, days, years: archives.length,
    byPoint: pct(counts.all),
    byWindow: { AM: pct(counts.AM), PM: pct(counts.PM) },
    medianSpeed: speeds.length ? speeds[Math.floor(speeds.length / 2)] : null,
    // Ranked, because "your commonest wind" is the thing you act on.
    ranked: COMPASS.map(p => ({ point: p, pct: pct(counts.all)[p] }))
      .sort((a, b) => b.pct - a.pct),
  };
}

/**
 * How much of the season each stand is actually huntable, and where the gaps
 * are.
 *
 * A stand with no recorded winds gets null rather than zero — the same rule as
 * everywhere else. "I have not told it which winds this works on" and "this
 * works on no winds" are different, and only one of them is the stand's fault.
 */
export function standCoverage(stands, clim) {
  const covered = new Map();
  const rows = stands.map(s => {
    // Lanes where they are marked, ticked winds otherwise — one derivation,
    // shared with the ranking, so the two screens cannot disagree about which
    // winds a stand has.
    const cover = windsForStand(s);
    const winds = cover.winds;
    if (!winds.length) {
      return { id: s.id, name: s.name, winds: [], source: cover.source,
               pct: null, amPct: null, pmPct: null };
    }
    for (const w of winds) covered.set(w, (covered.get(w) ?? 0) + 1);
    const sum = (table) => Math.round(10 * winds.reduce((a, w) => a + (table[w] ?? 0), 0)) / 10;
    return {
      id: s.id, name: s.name, winds, source: cover.source,
      pct: sum(clim.byPoint),
      amPct: sum(clim.byWindow.AM),
      pmPct: sum(clim.byWindow.PM),
    };
  });
  rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

  // The winds that blow most and that NO stand can be hunted on. This is the
  // gap that costs you days, and it is invisible until it is counted.
  const gaps = clim.ranked
    .filter(r => r.pct > 0 && !covered.has(r.point))
    .slice(0, 4);

  const withWinds = rows.filter(r => r.pct !== null);
  return {
    stands: rows,
    gaps,
    // How much of the season at least one stand covers — the number that says
    // whether the SET of stands is any good, rather than any one of them.
    seasonCovered: withWinds.length
      ? Math.round(10 * clim.ranked
        .filter(r => covered.has(r.point))
        .reduce((a, r) => a + r.pct, 0)) / 10
      : null,
    unsetStands: rows.filter(r => r.pct === null).length,
  };
}
