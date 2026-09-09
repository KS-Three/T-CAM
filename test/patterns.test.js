/**
 * The statistics board.
 *
 * Two things make a number here wrong in a way nobody notices: counting hours
 * the camera was not watching, and bucketing a photograph by the wrong clock.
 * Both produce a plausible chart. Most of this file is about those two.
 *
 * The last test is the one that would catch a rewrite going subtly wrong: a
 * signal is PLANTED in generated data and the module has to find it, at roughly
 * the strength it was planted at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertCamera, recordCameraDay, upsertPhoto, addDetection,
  upsertWeatherHour, weatherLocationFor, setCameraPlacement } from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';
import { lightBand, MIN_HOURS, sunTimes } from '../evidence.mjs';
import { solarOffsetMs } from '../camera-days.mjs';
import { patterns, watchedHours, sightings, curveFor, axisFor, rateOf, octantOf,
  bandFromSun, bandKey, AXES, SOURCES, TEMP_BANDS, camerasFor } from '../patterns.mjs';

const LAT = 44.12, LNG = -90.65;
const DAY0 = '2026-08-01';
const dayIso = i => new Date(Date.parse(DAY0 + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
const hourKeyOf = ms => new Date(ms).toISOString().slice(0, 13) + ':00:00Z';

/** The UTC instant of a given camera-local solar hour on a given local day. */
const localHourMs = (day, h, lng = LNG) =>
  Date.parse(day + 'T00:00:00.000Z') + h * 3600000 - solarOffsetMs(lng);

function store({ days = 3, weather = true, dark = [] } = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-patterns-'));
  const db = openDb(out);
  const doc = structuredClone(FLEX_M);
  doc.status.coordinates = [{ dateTime: '2026-08-01T00:00:00.000Z',
    position: { type: 'Point', coordinates: [LNG, LAT] } }];
  const cam = upsertCamera(db, PROVIDERS.spypoint.normalizeCamera(doc),
    { provider: 'spypoint', accountLabel: 'k' });
  const loc = weather ? weatherLocationFor(db, LAT, LNG) : null;
  if (loc) db.prepare('UPDATE cameras SET weather_location_id = ? WHERE id = ?').run(loc.id, cam.id);

  for (let d = 0; d < days; d++) {
    const day = dayIso(d);
    recordCameraDay(db, { cameraId: cam.id, day,
      state: dark.includes(d) ? 'quota-dark' : 'live',
      photos: 0, photoCount: 0, photoLimit: 100, lastSeen: day + 'T12:00:00Z',
      battery: 70, observedAt: day + 'T23:00:00Z' });
    if (!loc) continue;
    for (let h = 0; h < 24; h++) {
      upsertWeatherHour(db, loc.id, hourKeyOf(localHourMs(day, h)),
        { tempF: 40, pressureInHg: 30.0, windMph: 8, windDir: 315 });
    }
  }
  let n = 0;
  const shoot = (ms, { source = 'manual', confirmed = true, buckId = null, species = 'deer' } = {}) => {
    const p = upsertPhoto(db, { provider: 'spypoint', cameraId: doc.id,
      nativeId: 'shot-' + (n++), takenAt: new Date(ms).toISOString() });
    addDetection(db, { photoId: p.id, species, source, confirmed, buckId });
    return p;
  };
  return { out, db, id: cam.id, shoot, loc };
}

// ---------------------------------------------------------------------------
// The denominator
// ---------------------------------------------------------------------------

test('only live days are counted as hours watched', () => {
  // The whole file rests on this. A quota-dark camera and a camera watching an
  // empty trail report exactly the same nothing, and counting the dark day as
  // deer-absent inflates every rate built on top, always the same way.
  const { db, id } = store({ days: 5, dark: [1, 3] });
  const cam = camerasFor(db).find(c => c.id === id);
  const hours = watchedHours(db, cam);
  assert.equal(hours.length, 3 * 24, 'three live days, not five');
  assert.ok(!hours.some(h => h.day === dayIso(1) || h.day === dayIso(3)),
    'neither dark day contributed an hour');
  db.close();
});

test('a day with no camera_days row is not a day watched', () => {
  // The sync writes a row only on the days it runs. A week with the laptop off
  // is UNKNOWN, and camera-days.mjs is explicit that unknown must never read as
  // live — otherwise the denominator grows while the numerator cannot.
  const { db, id } = store({ days: 2 });
  const cam = camerasFor(db).find(c => c.id === id);
  assert.equal(watchedHours(db, cam).length, 48);
  db.close();
});

test('a camera with no weather still gets its hours, with weather null', () => {
  // The light chart needs no weather at all. Making the hours depend on the
  // weather backfill would silently empty a chart that never needed it.
  const { db, id } = store({ days: 2, weather: false });
  const cam = camerasFor(db).find(c => c.id === id);
  const hours = watchedHours(db, cam);
  assert.equal(hours.length, 48);
  assert.ok(hours.every(h => h.hasWeather === false));
  assert.ok(hours.every(h => h.windFrom === null && h.tempF === null));
  db.close();
});

test('rates are per 100 camera-hours, and refuse below the evidence bar', () => {
  assert.equal(rateOf(5, 100), 5);
  assert.equal(rateOf(1, 200), 0.5);
  assert.equal(rateOf(0, 100), 0, 'nothing seen in a hundred hours IS a zero');
  assert.equal(rateOf(3, MIN_HOURS - 1), null, 'too few hours has no rate at all');
  assert.equal(rateOf(0, 2), null, 'and especially not a zero — that is a claim');
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

test('a photograph is bucketed by the camera\'s solar hour, not UTC', () => {
  // At this longitude the two are six hours apart. Bucketing by UTC would put
  // the dawn peak at eleven in the morning and every chart would still look
  // perfectly reasonable.
  const { db, id, shoot } = store({ days: 2 });
  shoot(localHourMs(dayIso(0), 6) + 60000);        // 06:0x local
  const cam = camerasFor(db).find(c => c.id === id);
  const curve = curveFor(watchedHours(db, cam), sightings(db, { source: 'yours' }), LNG);
  assert.equal(curve[6].hits, 1, 'landed in the 6am bucket');
  assert.equal(curve.reduce((n, c) => n + c.hits, 0), 1, 'and in exactly one bucket');
  const utcHour = new Date(localHourMs(dayIso(0), 6)).getUTCHours();
  assert.notEqual(utcHour, 6, 'the test would be vacuous if they agreed');
  assert.equal(curve[utcHour].hits, 0, 'the UTC bucket is empty');
  db.close();
});

test('every live day contributes one hour to each of the 24 buckets', () => {
  const { db, id } = store({ days: 4, dark: [2] });
  const cam = camerasFor(db).find(c => c.id === id);
  const curve = curveFor(watchedHours(db, cam), [], LNG);
  assert.equal(curve.length, 24);
  assert.ok(curve.every(c => c.hours === 3), 'three live days, so three hours per bucket');
  db.close();
});

test('bandFromSun agrees with lightBand every hour of a year', () => {
  // bandFromSun exists only to reuse one solar calculation across a day's 24
  // hours. It re-states lightBand's thresholds, so it is exactly the kind of
  // second copy this repo keeps catching — pinned against the original rather
  // than trusted.
  let checked = 0;
  for (let d = 0; d < 365; d += 7) {
    const base = Date.UTC(2026, 0, 1) + d * 86400000;
    const sun = sunTimes(base + 43200000, LAT, LNG);
    for (let h = 0; h < 24; h++) {
      const ms = base + h * 3600000;
      assert.equal(bandFromSun(ms, sun), lightBand(ms, LAT, LNG),
        `disagreed on day ${d} hour ${h}`);
      checked++;
    }
  }
  assert.ok(checked > 1200, `checked ${checked} hours`);
});

test('an octant is centred on its cardinal, not offset by a half-point', () => {
  // Folding a 16-point compass in half puts the N octant on NNW-and-N. That is
  // a 22.5-degree lie in every wind chart, and it looks completely normal.
  assert.equal(octantOf(0), 'N');
  assert.equal(octantOf(22), 'N');
  assert.equal(octantOf(23), 'NE');
  assert.equal(octantOf(338), 'N', 'the wrap-around half of the N octant');
  assert.equal(octantOf(90), 'E');
  assert.equal(octantOf(315), 'NW');
  assert.equal(octantOf(-45), 'NW', 'a negative bearing is still a bearing');
  assert.equal(octantOf(null), null);
  assert.equal(octantOf(NaN), null, 'Number(null) is 0 and 0 is due north');
});

test('an unknown value goes in no bucket at all', () => {
  assert.equal(bandKey(TEMP_BANDS, null), null);
  assert.equal(bandKey(TEMP_BANDS, NaN), null);
  assert.equal(bandKey(TEMP_BANDS, '40'), null, 'a string temperature is not a temperature');
  assert.equal(bandKey(TEMP_BANDS, 40), '30s');
});

// ---------------------------------------------------------------------------
// The two sources
// ---------------------------------------------------------------------------

test('the two sources are disjoint, and a confirmed guess counts as yours', () => {
  // What makes a row evidence is that a person looked at it, not who guessed
  // first. If a confirmed camera-ai row appeared in both columns the totals
  // would double-count and the comparison would be meaningless.
  const { db, shoot } = store({ days: 2 });
  shoot(localHourMs(dayIso(0), 7), { source: 'camera-ai', confirmed: false });
  shoot(localHourMs(dayIso(0), 8), { source: 'camera-ai', confirmed: true });
  shoot(localHourMs(dayIso(0), 9), { source: 'manual', confirmed: true });

  const yours = sightings(db, { source: 'yours' });
  const theirs = sightings(db, { source: 'camera' });
  assert.equal(yours.length, 2, 'the confirmed camera-ai row and the manual one');
  assert.equal(theirs.length, 1, 'only the unreviewed guess');
  const overlap = yours.filter(y => theirs.some(t => t.ms === y.ms));
  assert.equal(overlap.length, 0, 'no row can be in both columns');
  db.close();
});

test('an unknown source is refused rather than quietly returning everything', () => {
  const { db } = store({ days: 1 });
  assert.throws(() => sightings(db, { source: 'assist' }), /unknown source/);
  db.close();
});

test('species filters, and null means every species', () => {
  const { db, shoot } = store({ days: 2 });
  shoot(localHourMs(dayIso(0), 7), { species: 'deer' });
  shoot(localHourMs(dayIso(0), 8), { species: 'turkey' });
  assert.equal(sightings(db, { source: 'yours' }).length, 1, 'deer by default');
  assert.equal(sightings(db, { source: 'yours', species: null }).length, 2);
  db.close();
});

// ---------------------------------------------------------------------------
// Cells that cannot support a number
// ---------------------------------------------------------------------------

test('hours whose value is unknown are counted, not dropped', () => {
  // "400 hours here, 30 of them with weather" is the thing a person needs to
  // know before believing a wind chart. Dropping them silently would leave the
  // chart looking as though it rested on all 400.
  const { db, id } = store({ days: 3, weather: false });
  const cam = camerasFor(db).find(c => c.id === id);
  const wind = axisFor(watchedHours(db, cam), [], AXES.find(a => a.key === 'wind'));
  assert.equal(wind.unknown, 72, 'every hour lacked a wind direction');
  assert.ok(wind.buckets.every(b => b.hours === 0 && b.rate === null));
  db.close();
});

test('a bucket with no hours has no rate, and is not a cold spot', () => {
  const { db, id } = store({ days: 3 });          // every hour is 40°F
  const cam = camerasFor(db).find(c => c.id === id);
  const temp = axisFor(watchedHours(db, cam), [], AXES.find(a => a.key === 'temp'));
  const cold = temp.buckets.find(b => b.key === 'lt20');
  assert.equal(cold.hours, 0);
  assert.equal(cold.rate, null, 'null, so the page can refuse rather than draw a zero');
  assert.notEqual(cold.rate, 0, 'these must stay distinguishable all the way out');
  db.close();
});

test('a sighting outside every live day moves no bucket', () => {
  // A photograph from a day the camera was quota-dark has no denominator to
  // belong to. Counting it against some other day\'s hours is how a rate goes
  // above what the hours can support.
  const { db, id, shoot } = store({ days: 3, dark: [1] });
  shoot(localHourMs(dayIso(1), 7));                // on the dark day
  const cam = camerasFor(db).find(c => c.id === id);
  const hours = watchedHours(db, cam);
  const wind = axisFor(hours, sightings(db, { source: 'yours' }), AXES.find(a => a.key === 'wind'));
  assert.equal(wind.buckets.reduce((n, b) => n + b.hits, 0), 0,
    'the sighting had no watched hour to land in');
  db.close();
});

// ---------------------------------------------------------------------------
// The whole board
// ---------------------------------------------------------------------------

test('the board ranks a measured zero above an unknown', () => {
  // "We have never seen a deer here in 400 hours" is information. "We have 3
  // hours" is not, and must never outrank it — that is how a dark camera
  // becomes a recommendation.
  const { db, id } = store({ days: 20 });
  const second = structuredClone(FLEX_M);
  second.id = 'ffffffffffffffffffffff02'; second.config.name = 'Thin';
  second.status.coordinates = [{ dateTime: '2026-08-01T00:00:00.000Z',
    position: { type: 'Point', coordinates: [LNG + 0.01, LAT] } }];
  const thin = upsertCamera(db, PROVIDERS.spypoint.normalizeCamera(second),
    { provider: 'spypoint', accountLabel: 'k' });
  recordCameraDay(db, { cameraId: thin.id, day: dayIso(0), state: 'live', photos: 0,
    photoCount: 0, photoLimit: 100, lastSeen: dayIso(0) + 'T12:00:00Z', battery: 70,
    observedAt: dayIso(0) + 'T23:00:00Z' });

  const P = patterns(db, { minHours: 48, bucks: false });
  const board = P.board.yours;
  assert.equal(board[0].id, id, 'the camera with 480 hours and no deer comes first');
  assert.equal(board[0].rate, 0);
  assert.equal(board[1].rate, null, 'the 24-hour camera has no rate');
  db.close();
});

test('a corrected pin is the pin the statistics use', () => {
  // Everything measured from a camera follows the effective point. A board that
  // read the raw GPS column would put the camera\'s solar clock and its hours
  // somewhere the owner has said it is not.
  const { db, id } = store({ days: 2 });
  setCameraPlacement(db, id, { lat: LAT + 0.002, lng: LNG + 0.002 });
  const cam = camerasFor(db).find(c => c.id === id);
  assert.equal(cam.lng, LNG + 0.002);
  assert.equal(cam.corrected, true);
  db.close();
});

test('every axis carries its evidence tier out to the page', () => {
  // The barometer is tier D — no collar study supports it, and movement-model
  // scores it zero. Plotting it without saying so would imply the tool believes
  // it, which is the exact thing deer-evidence.md was written to stop.
  const { db } = store({ days: 1 });
  const P = patterns(db, { bucks: false });
  const tiers = Object.fromEntries(P.axes.map(a => [a.key, a.tier]));
  assert.equal(tiers.pressure, 'D');
  assert.equal(tiers.light, 'A');
  assert.equal(tiers.wind, 'B');
  assert.ok(P.axes.every(a => a.note), 'and each says in words what it is');
  db.close();
});

test('bucks come only from confirmed tags, and a buck never seen still appears', () => {
  // The vendor\'s AI says "deer", never "Split G2", so there is no second
  // column to draw. And "he is in the book and has never walked past a camera"
  // is a fact about the season worth seeing rather than an empty row to hide.
  const { db, shoot } = store({ days: 5 });
  db.prepare('INSERT INTO bucks (name, created_at) VALUES (?, ?)').run('Split G2', '2026-08-01T00:00:00Z');
  db.prepare('INSERT INTO bucks (name, created_at) VALUES (?, ?)').run('Ghost', '2026-08-01T00:00:00Z');
  const g2 = db.prepare('SELECT id FROM bucks WHERE name = ?').get('Split G2').id;
  shoot(localHourMs(dayIso(0), 6), { buckId: g2 });
  shoot(localHourMs(dayIso(1), 6), { buckId: g2 });
  shoot(localHourMs(dayIso(2), 6), { source: 'camera-ai', confirmed: false });

  const P = patterns(db, { minHours: 24 });
  const by = Object.fromEntries(P.bucks.map(b => [b.name, b]));
  assert.equal(by['Split G2'].hits, 2);
  assert.equal(by.Ghost.hits, 0, 'named, never photographed, still listed');
  assert.equal(by['Split G2'].curve[6].hits, 2, 'in his own solar hour');
  db.close();
});

test('the board says so rather than throwing when there are no cameras', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-patterns-empty-'));
  const db = openDb(out);
  const P = patterns(db);
  assert.deepEqual(P.cameras, []);
  assert.match(P.note, /no cameras/);
  assert.ok(Array.isArray(P.axes) && P.axes.length, 'the axes are still described');
  db.close();
});

// ---------------------------------------------------------------------------
// The one that would catch a rewrite
// ---------------------------------------------------------------------------

test('a planted signal comes back out at the strength it went in', () => {
  // Everything above checks a rule. This checks the arithmetic end to end: a
  // camera three times as busy on a north-west wind has to read about three
  // times as busy on a north-west wind, through the hours, the join, the
  // bucketing and the rate.
  const { db, id, shoot, loc } = store({ days: 0 });
  const DAYS = 60;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let d = 0; d < DAYS; d++) {
    const day = dayIso(d);
    recordCameraDay(db, { cameraId: id, day, state: 'live', photos: 0, photoCount: 0,
      photoLimit: 100, lastSeen: day + 'T12:00:00Z', battery: 70,
      observedAt: day + 'T23:00:00Z' });
    for (let h = 0; h < 24; h++) {
      const ms = localHourMs(day, h);
      // Half the days blow north-west, half blow east. Nothing else varies.
      const windDir = d % 2 === 0 ? 315 : 90;
      upsertWeatherHour(db, loc.id, hourKeyOf(ms),
        { tempF: 45, pressureInHg: 30, windMph: 8, windDir });
      const mu = windDir === 315 ? 0.09 : 0.03;      // planted: three times
      if (rnd() < mu) shoot(ms + 60000);
    }
  }

  const P = patterns(db, { bucks: false });
  const wind = P.byCamera.yours[id].axes.find(a => a.key === 'wind');
  const nw = wind.buckets.find(b => b.key === 'NW');
  const e = wind.buckets.find(b => b.key === 'E');
  assert.ok(nw.hours > 600 && e.hours > 600, `${nw.hours} and ${e.hours} hours`);
  const ratio = nw.rate / e.rate;
  assert.ok(ratio > 2 && ratio < 4.5,
    `north-west should read about 3x east, read ${ratio.toFixed(2)}x ` +
    `(${nw.rate.toFixed(2)} vs ${e.rate.toFixed(2)})`);

  // And the untouched axes must NOT invent a pattern: temperature never varied.
  const temp = P.byCamera.yours[id].axes.find(a => a.key === 'temp');
  const withRate = temp.buckets.filter(b => b.rate !== null);
  assert.equal(withRate.length, 1, 'one temperature band was ever observed');
  assert.equal(withRate[0].key, '30s');
  db.close();
});
