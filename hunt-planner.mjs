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
 * The scoring lives in movement-model.mjs, and every factor there carries the
 * tier of evidence behind it — see docs/deer-evidence.md. That split matters:
 * this file fetches a forecast and walks a calendar, and the question of what a
 * cold front is worth is settled somewhere a citation can sit next to it.
 *
 * It is NOT learned from your cameras. It does not know which bucks use which
 * trail, when they moved last November, or where they bed. That is what
 * evidence.mjs does with the photos you have actually collected, and the two
 * answer deliberately different questions: this one says WHEN, that one says
 * WHERE. Keeping them apart is what stops one season of sightings being fitted
 * to a rut that only happens once a year.
 *
 * Zero dependencies. Node 20+. Weather from open-meteo.com (free, no API key).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
// Safe to import: spypoint-sync only runs a sync when invoked as a program, so
// pulling in its helpers here never touches the network or asks for credentials.
import { cameraSummary, PLAN_FILE } from './spypoint-sync.mjs';
import { dashboardHtml } from './dashboard-page.mjs';
import {
  rutPhase, moonPhase, scoreSit, seasonalNormalF, inHg, rate,
  RUT_CALENDAR, RATINGS, OFF_SEASON_CAP, TIERS, evidenceOf, sitAdvice,
  weatherFactors, moonFactor, MONTHLY_NORMAL_F,
} from './movement-model.mjs';

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

// ---------------------------------------------------------------------------
// Sit windows
//
// Morning: on stand well before first light, through mid-morning — the rut
// cruising window runs later than most people sit. Evening: mid-afternoon to
// last light.
// ---------------------------------------------------------------------------
const WINDOWS = [
  { name: 'AM', fromSunrise: -1.5, toSunrise: 3.5 },
  { name: 'PM', fromSunset: -3.5, toSunset: 0.5 },
];

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
      const normalF = seasonalNormalF(date);
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

        const s = scoreSit({ hours, rut, moon, tempDropF, pressureTrend,
          window: w.name, normalF });
        sits.push({
          camera: cam.name, lat: cam.lat, lng: cam.lng,
          date: daily.time[d], window: w.name,
          start: new Date(start).toISOString(), end: new Date(end).toISOString(),
          // Sunrise and sunset verbatim, as the naive local strings the API
          // returned, plus the property's own UTC offset. Everything above
          // parses those strings with new Date(), which silently uses the
          // MACHINE's timezone — fine on a laptop in Wisconsin, six hours out
          // in a cloud container. Scoring never noticed because it compares
          // two times parsed the same wrong way. Shooting light does notice,
          // so it gets the offset and does the conversion properly.
          sunrise: daily.sunrise[d], sunset: daily.sunset[d],
          utcOffsetSeconds: wx.utc_offset_seconds ?? null,
          timezone: wx.timezone ?? null,
          rut: rut.phase, moon: moon.name,
          normalF: Math.round(normalF),
          ...s,
          // Resolve the bearing here: the dashboard shows this verbatim and
          // should not have to know the compass conversion.
          windFrom: s.windDir === null ? '?' : compass(s.windDir),
          rating: rate(s.total),
        });
      }
    }
  }

  sits.sort((a, b) => b.total - a.total);

  // Cameras on one property share a forecast, so ranking every camera
  // separately fills the list with the same morning repeated once per camera
  // and pushes out genuinely different dates. Collapse to one row per sit
  // window, keeping the best-scoring camera, and record the others so nothing
  // is silently dropped.
  const byWindow = new Map();
  for (const s of sits) {
    const key = `${s.date}|${s.window}`;
    const kept = byWindow.get(key);
    if (!kept) byWindow.set(key, { ...s, alsoAt: [] });
    else if (!kept.alsoAt.includes(s.camera)) kept.alsoAt.push(s.camera);
  }
  const ranked = [...byWindow.values()].sort((a, b) => b.total - a.total);

  const top = ranked.slice(0, 12);
  log('BEST SITS, RANKED\n');
  for (const s of top) {
    const when = new Date(s.start);
    const day = when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const t = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    log(`  ${s.rating.padEnd(6)} ${String(Math.round(s.total)).padStart(3)}  ${day} ${s.window} (from ${t})  ${s.camera}`);
    log(`         ${Math.round(s.temp)}°F, wind ${compass(s.windDir)} ${Math.round(s.wind)} mph, ${s.rut}`);
    // Evidence tier alongside the score, because "why is this a 44" and "how
    // much should I believe the 44" are different questions and the second one
    // used to have no answer at all.
    if (s.evidence?.tier) log(`         evidence ${s.evidence.tier} — ${s.evidence.note}`);
    for (const p of s.parts.filter(x => Math.abs(x.points) >= 3).slice(0, 3)) {
      log(`         ${p.points > 0 ? '+' : ''}${p.points}  [${p.tier}] ${p.reason}`);
    }
    if (s.advice) log(`         ${s.advice}`);
    log('');
  }

  if (OPT.json) {
    await fs.writeFile(OPT.json, JSON.stringify(sits, null, 2));
    log(`Full plan written to ${OPT.json}`);
  }

  // Write the plan where the dashboard looks for it, then rebuild the page so
  // there is one thing to open rather than a console to read.
  const plan = { generatedAt: new Date().toISOString(), sits: ranked };
  try {
    await fs.mkdir(OPT.out, { recursive: true });
    await fs.writeFile(path.join(OPT.out, PLAN_FILE), JSON.stringify(plan, null, 2));

    // Rebuilding needs the synced cameras and photos. Without them the plan is
    // still saved and will appear on the next sync — no reason to fail here.
    const raw = JSON.parse(await fs.readFile(path.join(OPT.out, 'cameras.raw.json'), 'utf8'));
    let photos = [];
    try {
      photos = (await fs.readFile(path.join(OPT.out, 'photos.jsonl'), 'utf8'))
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { /* no photos synced yet */ }
    photos.sort((a, b) => Date.parse(b.date ?? 0) - Date.parse(a.date ?? 0));

    const dash = path.join(OPT.out, 'dashboard.html');
    await fs.writeFile(dash, dashboardHtml(
      raw.map(cameraSummary), photos, new Date().toISOString(), plan));
    log(`\nDashboard updated: ${dash}`);
    log('Open it to see this plan alongside your camera map.');
  } catch {
    log(`\nPlan saved to ${path.join(OPT.out, PLAN_FILE)}.`);
    log('Run "node spypoint-sync.mjs" to build the dashboard around it.');
  }

  log('\nWind direction is where the wind comes FROM. Pick the stand it does not');
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

export {
  rutPhase, moonPhase, scoreSit, compass, inHg, rate, RUT_CALENDAR,
  RATINGS, OFF_SEASON_CAP, TIERS, evidenceOf, sitAdvice, weatherFactors,
  moonFactor, seasonalNormalF, MONTHLY_NORMAL_F, WINDOWS, windowHours,
};
