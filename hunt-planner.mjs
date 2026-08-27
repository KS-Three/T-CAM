#!/usr/bin/env node
/**
 * hunt-planner.mjs — rank the next two weeks of sits at your camera locations
 * by how likely deer are to move in daylight.
 *
 *   node hunt-planner.mjs                 # uses ./spypoint-data/cameras.raw.json
 *   node hunt-planner.mjs --days 10
 *   node hunt-planner.mjs --lat 44.1 --lng -90.6      # no sync data needed
 *   node hunt-planner.mjs --json plan.json
 *
 * WHAT THIS IS, AND IS NOT
 *
 * Every factor here comes from published whitetail behaviour — rut timing for
 * this latitude, cold fronts, barometric swings, wind, precipitation — applied
 * to a real weather forecast for your actual camera coordinates. It is a
 * weather-and-calendar model.
 *
 * It is NOT learned from your cameras. It does not know which bucks use which
 * trail, when they moved last November, or where they bed. That needs sighting
 * data, and sighting data needs cameras that are transmitting. Once photos
 * exist, those observations can be scored against these same factors to find
 * out which ones actually predict movement ON YOUR GROUND — at which point
 * this model should be corrected by that evidence, not trusted over it.
 *
 * So: treat the ranking as "which sits the weather favours", not "where the
 * deer will be". The reasons are printed for every sit precisely so you can
 * disagree with them.
 *
 * Zero dependencies. Node 20+. Weather from open-meteo.com (free, no API key).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const OPT = {
  out: path.resolve(val('--out', process.env.SPYPOINT_OUT || './spypoint-data')),
  days: Math.min(16, Math.max(1, parseInt(val('--days', '10'), 10) || 10)),
  lat: val('--lat', null),
  lng: val('--lng', null),
  json: val('--json', null),
  quiet: has('--quiet'),
};

const log = (...a) => { if (!OPT.quiet) console.log(...a); };

// ---------------------------------------------------------------------------
// Rut calendar
//
// Photoperiod drives breeding, so the dates barely move year to year at a given
// latitude — these are for the upper Midwest (~43-45°N, i.e. Wisconsin). Peak
// breeding here is consistently the second week of November. Further south the
// whole calendar slides later; this table would need changing.
//
// Note the dip during peak breeding: bucks lock down with individual does and
// cover less ground in daylight, which is why the seeking and chasing phase
// just before it is the classic time to be in a stand all day.
// ---------------------------------------------------------------------------
const RUT_CALENDAR = [
  { from: '09-01', to: '09-30', score: 10, phase: 'Early season',
    note: 'bachelor groups still together, tight feeding patterns — hunt food' },
  { from: '10-01', to: '10-17', score: 4, phase: 'October lull',
    note: 'bachelor groups breaking up, daylight movement at its lowest' },
  { from: '10-18', to: '10-31', score: 16, phase: 'Pre-rut / scraping',
    note: 'scrape activity building, bucks expanding range — hunt scrape lines' },
  { from: '11-01', to: '11-07', score: 24, phase: 'Seeking',
    note: 'bucks cruising for the first does — best daylight movement of the year' },
  { from: '11-08', to: '11-15', score: 22, phase: 'Chasing / peak breeding',
    note: 'peak activity, but bucks may lock down with a doe — sit all day' },
  { from: '11-16', to: '11-25', score: 16, phase: 'Post-peak seeking',
    note: 'bucks back on their feet hunting the last receptive does' },
  { from: '11-26', to: '12-10', score: 8, phase: 'Post-rut recovery',
    note: 'worn-down bucks return to food — hunt the best feed you have' },
  { from: '12-11', to: '12-20', score: 12, phase: 'Second rut',
    note: 'doe fawns and missed does cycle — brief renewed movement' },
  { from: '12-21', to: '01-31', score: 10, phase: 'Late season',
    note: 'pure food-source hunting, cold drives afternoon feeding' },
  { from: '02-01', to: '08-31', score: 2, phase: 'Off season',
    note: 'outside the season for this model' },
];

function rutPhase(date) {
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  for (const r of RUT_CALENDAR) {
    // Ranges that wrap the new year (12-21 → 01-31) need the OR form.
    const wraps = r.from > r.to;
    if (wraps ? (md >= r.from || md <= r.to) : (md >= r.from && md <= r.to)) return r;
  }
  return RUT_CALENDAR.at(-1);
}

// ---------------------------------------------------------------------------
// Moon phase — pure arithmetic, no lookup needed.
//
// Deliberately weighted low. Solunar theory is popular and genuinely contested;
// the honest position is that moon effects are small and inconsistent next to a
// cold front or the rut. It is reported mainly so you can see it and judge.
// ---------------------------------------------------------------------------
const SYNODIC = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14);

function moonPhase(date) {
  const days = (date.getTime() - NEW_MOON_REF) / 86400000;
  const frac = ((days / SYNODIC) % 1 + 1) % 1;
  const illum = (1 - Math.cos(2 * Math.PI * frac)) / 2;
  const names = [
    [0.02, 'new'], [0.24, 'waxing crescent'], [0.27, 'first quarter'],
    [0.48, 'waxing gibbous'], [0.52, 'full'], [0.73, 'waning gibbous'],
    [0.77, 'last quarter'], [0.98, 'waning crescent'], [1.01, 'new'],
  ];
  return { frac, illum, name: names.find(([t]) => frac < t)[1] };
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------
async function forecast(lat, lng, days) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lng}`
    + '&hourly=temperature_2m,surface_pressure,wind_speed_10m,wind_direction_10m,'
    + 'precipitation,cloud_cover'
    + '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
    + `&timezone=auto&forecast_days=${days}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather request failed: HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.hourly?.time) throw new Error('weather response missing hourly data');
  return j;
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// hPa -> inches of mercury, the unit every deer-hunting article quotes.
const inHg = hpa => hpa * 0.02952998751;

// ---------------------------------------------------------------------------
// Sit windows and scoring
// ---------------------------------------------------------------------------

// Morning: on stand well before first light, through mid-morning — the rut
// cruising window runs later than most people sit. Evening: mid-afternoon to
// last light.
const WINDOWS = [
  { name: 'AM', fromSunrise: -1.5, toSunrise: 3.5 },
  { name: 'PM', fromSunset: -3.5, toSunset: 0.5 },
];

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function windowHours(hourly, start, end) {
  const out = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const t = new Date(hourly.time[i]).getTime();
    if (t >= start && t <= end) {
      out.push({
        time: hourly.time[i],
        temp: hourly.temperature_2m[i],
        pressure: hourly.surface_pressure[i],
        wind: hourly.wind_speed_10m[i],
        windDir: hourly.wind_direction_10m[i],
        precip: hourly.precipitation[i],
        cloud: hourly.cloud_cover[i],
      });
    }
  }
  return out;
}

/**
 * Additive, transparent scoring. Every contribution carries the reason it was
 * applied, so the output can be argued with rather than taken on faith. The
 * weights encode the usual ordering of effect sizes: rut first, then a real
 * cold front, then wind and rain, with moon last and deliberately small.
 */
function scoreSit({ hours, rut, moon, tempDropF, pressureTrend }) {
  const parts = [];
  const add = (points, reason) => { if (points) parts.push({ points, reason }); };

  add(rut.score, `${rut.phase} — ${rut.note}`);

  // A sharp temperature drop is the single most reliable non-rut trigger:
  // deer feed hard ahead of and just behind a front.
  if (tempDropF >= 20) add(14, `temperature ${Math.round(tempDropF)}°F below yesterday — strong cold front`);
  else if (tempDropF >= 10) add(9, `temperature ${Math.round(tempDropF)}°F below yesterday — cold front`);
  else if (tempDropF >= 5) add(4, `temperature ${Math.round(tempDropF)}°F below yesterday`);
  else if (tempDropF <= -12) add(-6, `${Math.round(-tempDropF)}°F warmer than yesterday — warm-up suppresses daylight movement`);

  // Rising pressure behind a departing front is the classic "go now" signal;
  // a steep fall usually means weather arriving and deer sitting it out.
  const p = mean(hours.map(h => h.pressure));
  if (pressureTrend >= 0.12) add(8, `pressure rising ${pressureTrend.toFixed(2)} inHg — front clearing`);
  else if (pressureTrend <= -0.12) add(-5, `pressure falling ${Math.abs(pressureTrend).toFixed(2)} inHg — weather moving in`);
  if (p !== null && inHg(p) >= 30.0 && inHg(p) <= 30.4) add(5, `barometer ${inHg(p).toFixed(2)} inHg — in the active band`);

  // Wind: a little is helpful cover, a lot shuts movement down and wrecks a
  // deer's own ability to detect danger, which makes them reluctant.
  const w = mean(hours.map(h => h.wind));
  if (w !== null) {
    if (w <= 3) add(-2, `wind ${w.toFixed(0)} mph — dead calm, your scent pools and sound carries`);
    else if (w <= 12) add(6, `wind ${w.toFixed(0)} mph — steady enough to cover you`);
    else if (w <= 18) add(-2, `wind ${w.toFixed(0)} mph — getting gusty`);
    else add(-9, `wind ${w.toFixed(0)} mph — too much, deer hold in cover`);
  }

  // Rain: a drizzle is fine and quiets the woods; a downpour ends the sit.
  const rain = hours.reduce((s, h) => s + (h.precip ?? 0), 0);
  if (rain >= 0.4) add(-10, `${rain.toFixed(2)} in of rain — deer bed down, and blood trails wash out`);
  else if (rain >= 0.05) add(2, `${rain.toFixed(2)} in light rain — quiet woods, movement often continues`);

  // Overcast keeps light levels low and stretches the morning window.
  const cloud = mean(hours.map(h => h.cloud));
  if (cloud !== null && cloud >= 70) add(3, `${cloud.toFixed(0)}% cloud — low light extends movement`);

  // Small and clearly labelled: see the note on the moon block above.
  if (moon.illum <= 0.1) add(2, `${moon.name} moon — dark nights push feeding into daylight`);
  else if (moon.illum >= 0.9) add(-2, `${moon.name} moon — bright nights let deer feed after dark`);

  let total = parts.reduce((s, x) => s + x.points, 0);

  // Weather factors are additive, which alone would let a flawless August
  // morning outrank a windy day in the rut — nonsense, since there is no
  // season then. Out of season the weather cannot rescue the date, so cap it.
  if (rut.phase === 'Off season' && total > OFF_SEASON_CAP) {
    parts.push({ points: OFF_SEASON_CAP - total, reason: 'outside the hunting season — weather cannot make up for it' });
    total = OFF_SEASON_CAP;
  }

  return { total, parts, wind: w, windDir: hours.length ? hours[Math.floor(hours.length / 2)].windDir : null, rain, temp: mean(hours.map(h => h.temp)) };
}

const OFF_SEASON_CAP = 5;

const RATINGS = [[46, 'PRIME'], [34, 'strong'], [24, 'good'], [14, 'fair'], [-999, 'poor']];
const rate = n => RATINGS.find(([t]) => n >= t)[1];

async function loadCameras() {
  if (OPT.lat !== null && OPT.lng !== null) {
    return [{ name: 'given location', lat: Number(OPT.lat), lng: Number(OPT.lng) }];
  }
  const file = path.join(OPT.out, 'cameras.raw.json');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error(
      `no camera data at ${file}\n`
      + '  Run a sync first:  node spypoint-sync.mjs\n'
      + '  Or plan for one spot without it:  node hunt-planner.mjs --lat 44.1 --lng -90.6');
  }
  const { cameraSummary } = await import('./spypoint-sync.mjs');
  const rows = raw.map(cameraSummary).filter(r => r.lat !== null && r.lng !== null);
  if (!rows.length) throw new Error('camera data has no usable coordinates');
  return rows;
}

async function main() {
  const cams = await loadCameras();
  log(`Planning ${OPT.days} days for ${cams.length} location(s).\n`);

  const sits = [];
  for (const cam of cams) {
    const wx = await forecast(cam.lat, cam.lng, OPT.days);
    const daily = wx.daily;

    for (let d = 0; d < daily.time.length; d++) {
      const date = new Date(`${daily.time[d]}T12:00:00`);
      const rut = rutPhase(date);
      const moon = moonPhase(date);
      const sunrise = new Date(daily.sunrise[d]).getTime();
      const sunset = new Date(daily.sunset[d]).getTime();

      // Day-over-day change in the daily high, the practical definition of a
      // front for hunting purposes.
      const tempDropF = d > 0 ? daily.temperature_2m_max[d - 1] - daily.temperature_2m_max[d] : 0;

      for (const w of WINDOWS) {
        const start = w.name === 'AM' ? sunrise + w.fromSunrise * 3600000 : sunset + w.fromSunset * 3600000;
        const end = w.name === 'AM' ? sunrise + w.toSunrise * 3600000 : sunset + w.toSunset * 3600000;
        const hours = windowHours(wx.hourly, start, end);
        if (!hours.length) continue;

        const pressureTrend = hours.length > 1
          ? inHg(hours.at(-1).pressure) - inHg(hours[0].pressure) : 0;

        const s = scoreSit({ hours, rut, moon, tempDropF, pressureTrend });
        sits.push({
          camera: cam.name, lat: cam.lat, lng: cam.lng,
          date: daily.time[d], window: w.name,
          start: new Date(start).toISOString(), end: new Date(end).toISOString(),
          rut: rut.phase, moon: moon.name,
          ...s, rating: rate(s.total),
        });
      }
    }
  }

  sits.sort((a, b) => b.total - a.total);

  const top = sits.slice(0, 12);
  log('BEST SITS, RANKED\n');
  for (const s of top) {
    const when = new Date(s.start);
    const day = when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const t = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    log(`  ${s.rating.padEnd(6)} ${String(Math.round(s.total)).padStart(3)}  ${day} ${s.window} (from ${t})  ${s.camera}`);
    log(`         ${Math.round(s.temp)}°F, wind ${compass(s.windDir)} ${Math.round(s.wind)} mph, ${s.rut}`);
    for (const p of s.parts.filter(x => Math.abs(x.points) >= 4).slice(0, 3)) {
      log(`         ${p.points > 0 ? '+' : ''}${p.points}  ${p.reason}`);
    }
    log('');
  }

  if (OPT.json) {
    await fs.writeFile(OPT.json, JSON.stringify(sits, null, 2));
    log(`Full plan written to ${OPT.json}`);
  }

  log('Wind direction is where the wind comes FROM. Pick the stand it does not');
  log('carry your scent from — this model scores WHEN, you still choose WHERE.');
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch(err => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  });
}

export { rutPhase, moonPhase, scoreSit, compass, inHg, rate, RUT_CALENDAR };
