import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GROUPS, groupBy, MIN_HOURS, OCTANTS, octantOf, withTrends, coverageDays,
  compare, whereTable, bucketsForConditions, standsForBucket,
} from '../analysis.mjs';
import {
  openDb, upsertCamera, upsertPhoto, addDetection, upsertWeatherHour,
  weatherLocationFor, createStand, allStands, groupVisits,
} from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-test-'));
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

/** N consecutive dates from a start, as YYYY-MM-DD. */
const dates = (start, n) => Array.from({ length: n }, (_, i) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

/** Every hour of every given date, with per-hour readings from `fields`. */
function hoursOn(days, fields = () => ({})) {
  const out = [];
  for (const d of days) {
    for (let h = 0; h < 24; h++) {
      out.push({ hour_utc: `${d}T${String(h).padStart(2, '0')}:00:00Z`, ...fields(h, d) });
    }
  }
  return out;
}

/** Afternoons wet, mornings dry — so the expected counts are arithmetic. */
const wetAfternoons = h => ({
  precip_in: h >= 12 ? 0.05 : 0, temp_f: 40, wind_mph: 8, wind_dir: 270, cloud_pct: 50,
});

const sighting = (cameraId, day, hour, visit) => ({
  camera_id: cameraId, hour_utc: `${day}T${String(hour).padStart(2, '0')}:00:00Z`,
  visit_id: visit ?? null, photo_id: `${cameraId}-${day}-${hour}-${visit ?? 'x'}`,
});

// ---------------------------------------------------------------------------
// The buckets themselves
// ---------------------------------------------------------------------------

test('a bucket places an hour, and a missing reading is unknown rather than "no"', () => {
  // Number(null) is 0 and 0 inches is "dry" — the trap that has bitten this
  // repo three times. Every bucketOf must reject the missing value BEFORE any
  // comparison, and be tested for it, or the analysis quietly counts a broken
  // backfill as a run of dry weather.
  const rain = groupBy('rain');
  assert.equal(rain.bucketOf({ precip_in: 0.05 }), 'wet');
  assert.equal(rain.bucketOf({ precip_in: 0 }), 'dry');
  assert.equal(rain.bucketOf({ precip_in: null }), null, 'no reading is not "dry"');
  assert.equal(rain.bucketOf({}), null, 'an absent column is not "dry" either');

  for (const g of GROUPS) {
    assert.equal(g.bucketOf({}), null, `${g.key} places an empty hour nowhere`);
    for (const b of g.buckets) assert.ok(b.key && b.label, `${g.key}.${b.key} is labelled`);
  }
});

test('the bucket boundaries are the ones the planner already uses', () => {
  // Two definitions of "a front is clearing" would drift apart, and the WHEN
  // and WHERE halves would then describe the same evening differently.
  const p = groupBy('pressure');
  assert.equal(p.bucketOf({ trend_inhg: 0.12 }), 'rising');
  assert.equal(p.bucketOf({ trend_inhg: 0.11 }), 'steady');
  assert.equal(p.bucketOf({ trend_inhg: -0.12 }), 'falling');
  assert.equal(p.bucketOf({ trend_inhg: null }), null);

  const t = groupBy('temp');
  assert.equal(t.bucketOf({ temp_f: 31.9 }), 'freezing');
  assert.equal(t.bucketOf({ temp_f: 32 }), 'cold');
  assert.equal(t.bucketOf({ temp_f: 60 }), 'warm');
});

test('wind is cut into eight sectors, not sixteen, and wraps at north', () => {
  // Sixteen bins over one season leaves a handful of hours in each and every
  // rate becomes noise. Eight is the compromise, and it has to wrap.
  assert.equal(OCTANTS.length, 8);
  assert.equal(octantOf(0), 'N');
  assert.equal(octantOf(359), 'N', 'just short of north is still north');
  assert.equal(octantOf(360), 'N');
  assert.equal(octantOf(315), 'NW');
  assert.equal(octantOf(180), 'S');
});

test('the pressure trend is a three-hour span, taken from the hour three back', () => {
  const rows = [
    { hour_utc: '2025-11-05T00:00:00Z', pressure_inhg: 29.8 },
    { hour_utc: '2025-11-05T01:00:00Z', pressure_inhg: 29.85 },
    { hour_utc: '2025-11-05T02:00:00Z', pressure_inhg: 29.9 },
    { hour_utc: '2025-11-05T03:00:00Z', pressure_inhg: 30.0 },
    { hour_utc: '2025-11-05T04:00:00Z', pressure_inhg: 30.4 },
  ];
  const out = withTrends(rows);
  assert.equal(out[0].trend_inhg, null, 'nothing three hours before the first row');
  assert.ok(Math.abs(out[3].trend_inhg - 0.2) < 1e-9, '03:00 measured against 00:00');
  assert.ok(Math.abs(out[4].trend_inhg - 0.55) < 1e-9, '04:00 against 01:00');
});

test('a gap in the archive gives no trend, rather than a six-hour one called three', () => {
  // Walking back three ROWS instead of three hours is the easy version, and on
  // a gapped archive it reports the pressure change over six hours as though it
  // happened in three — which is exactly what "a front is clearing" means here.
  const rows = [
    { hour_utc: '2025-11-05T00:00:00Z', pressure_inhg: 29.8 },
    { hour_utc: '2025-11-05T01:00:00Z', pressure_inhg: 29.8 },
    { hour_utc: '2025-11-05T02:00:00Z', pressure_inhg: 29.8 },
    // 03:00, 04:00, 05:00 missing from the archive.
    { hour_utc: '2025-11-05T06:00:00Z', pressure_inhg: 30.4 },
  ];
  const out = withTrends(rows);
  assert.equal(out[3].trend_inhg, null,
    'three rows back is 00:00, six hours away — that is not a three-hour trend');
  assert.equal(groupBy('pressure').bucketOf(out[3]), null,
    'and it falls out of the barometer cut rather than being called steady');
});

test('a pressure reading of null is unknown, never a steady barometer', () => {
  const out = withTrends([
    { hour_utc: '2025-11-05T00:00:00Z', pressure_inhg: null },
    { hour_utc: '2025-11-05T03:00:00Z', pressure_inhg: 30.0 },
  ]);
  assert.equal(out[1].trend_inhg, null);
});

// ---------------------------------------------------------------------------
// Coverage — the honesty of the denominator
// ---------------------------------------------------------------------------

test('a camera is credited only with the days it actually produced a photo', () => {
  // Counting every archived hour instead would charge a camera hung last week
  // with a whole autumn of "saw nothing", and it would read as dead ground.
  const cov = coverageDays([
    { camera_id: 'A', hour_utc: '2025-11-01T06:00:00Z' },
    { camera_id: 'A', hour_utc: '2025-11-01T18:00:00Z' },
    { camera_id: 'A', hour_utc: '2025-11-03T06:00:00Z' },
    { camera_id: 'B', hour_utc: '2025-11-03T06:00:00Z' },
  ]);
  assert.deepEqual([...cov.get('A')].sort(), ['2025-11-01', '2025-11-03'],
    'two days, not three — 2 Nov produced nothing and is not evidence either way');
  assert.equal(cov.get('B').size, 1);
});

test('a photo with no hour still dates itself from taken_at', () => {
  const cov = coverageDays([{ camera_id: 'A', hour_utc: null, taken_at: '2025-11-04T06:12:00Z' }]);
  assert.deepEqual([...cov.get('A')], ['2025-11-04']);
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const NOV = dates('2025-11-01', 10);

function twoCameras({ extraDaysForB = [], detections = [] } = {}) {
  const bDays = [...extraDaysForB, ...NOV];
  return {
    cameras: [{ id: 'A', name: 'North Ridge', locationId: 1 },
      { id: 'B', name: 'Creek Bottom', locationId: 1 }],
    hoursByLocation: new Map([[1, hoursOn([...extraDaysForB, ...NOV], wetAfternoons)]]),
    detections,
    coverage: new Map([['A', new Set(NOV)], ['B', new Set(bDays)]]),
  };
}

test('two cameras in the same rain rank by rate, with the raw counts beside it', () => {
  const det = [
    ...[12, 13, 14, 15, 16, 17].map((h, i) => sighting('A', NOV[i], h, 100 + i)),
    sighting('A', NOV[0], 6, 200),
    sighting('B', NOV[0], 12, 300),
    ...[6, 7, 8, 9, 10, 11].map((h, i) => sighting('B', NOV[i], h, 400 + i)),
  ];
  const out = compare(twoCameras({ detections: det }), { group: 'rain' });

  assert.equal(out.refusal, null);
  assert.equal(out.common.days, 10);
  const wet = out.buckets.find(b => b.key === 'wet');
  // 12 wet hours a day across 10 shared days.
  assert.equal(wet.hours, 120);
  assert.equal(wet.ranked[0].name, 'North Ridge');
  assert.equal(wet.ranked[0].sightings, 6);
  assert.equal(wet.ranked[0].per100, 5);
  assert.equal(wet.ranked[1].name, 'Creek Bottom');
  assert.equal(wet.ranked[1].sightings, 1);

  const dry = out.buckets.find(b => b.key === 'dry');
  assert.equal(dry.ranked[0].name, 'Creek Bottom', 'the order flips when it is dry');
  assert.equal(dry.ranked[0].sightings, 6);
  assert.equal(dry.ranked[1].sightings, 1);
});

test('the comparison runs over the days both cameras were watching, and no others', () => {
  // This is the load-bearing one. A camera that also ran through October has
  // seen October deer in October weather; counting them against November's
  // shared window compares different weeks, not different ground.
  const oct = dates('2025-10-12', 20);
  const det = [
    ...oct.map((d, i) => sighting('B', d, 14, 900 + i)), // 20 wet-hour sightings, all October
    sighting('B', NOV[0], 12, 300),
    ...[12, 13, 14, 15, 16, 17].map((h, i) => sighting('A', NOV[i], h, 100 + i)),
  ];
  const out = compare(twoCameras({ extraDaysForB: oct, detections: det }), { group: 'rain' });

  assert.equal(out.common.days, 10, 'the overlap is November only');
  assert.equal(out.common.from, NOV[0]);
  const wet = out.buckets.find(b => b.key === 'wet');
  const b = wet.ranked.find(r => r.id === 'B');
  assert.equal(b.sightings, 1, "October's twenty sightings do not travel into November");
  assert.equal(b.hours, 120, 'nor do its October hours');
  assert.equal(wet.ranked[0].id, 'A');

  // The extra coverage is still REPORTED — it explains the shape of the answer.
  const row = out.cameras.find(c => c.id === 'B');
  assert.equal(row.days, 30);
  assert.equal(row.inCommon, 10);
});

test('days one camera lost to a flat battery leave the window for everyone', () => {
  // The overlap shrinks to what they truly share, and both cameras are then
  // judged over exactly the same hours — identical denominators are the
  // invariant that makes the ranking a comparison rather than two separate
  // measurements laid side by side.
  const inputs = twoCameras({ detections: [sighting('A', NOV[0], 12, 1)] });
  inputs.coverage.set('B', new Set(NOV.slice(0, 5)));
  const out = compare(inputs, { group: 'rain' });
  assert.equal(out.common.days, 5);
  const wet = out.buckets.find(b => b.key === 'wet');
  assert.equal(wet.ranked.find(r => r.id === 'A').hours, 60,
    'A watched all ten days, but is judged on the five they share');
  assert.equal(wet.ranked.find(r => r.id === 'B').hours, 60);
  assert.equal(out.cameras.find(c => c.id === 'A').days, 10, 'its own span is still reported');
});

test('cameras on one ground always share a denominator, whatever the cut', () => {
  const det = [sighting('A', NOV[0], 12, 1), sighting('B', NOV[1], 6, 2)];
  for (const group of ['rain', 'temp', 'winddir', 'windspeed', 'sky']) {
    const out = compare(twoCameras({ detections: det }), { group });
    for (const b of out.buckets) {
      const all = [...b.ranked, ...b.thin, ...b.absent].map(c => c.hours);
      assert.equal(new Set(all).size <= 1, true,
        `${group}/${b.key}: one weather location, one set of hours for every camera`);
    }
  }
});

test('a burst of frames at one deer is one sighting, not twelve', () => {
  // Cameras set to multiShot fire several frames per trigger. Counting frames
  // would make burst length look like deer activity.
  const burst = Array.from({ length: 12 }, (_, i) => ({
    camera_id: 'A', hour_utc: `${NOV[0]}T14:00:00Z`, visit_id: 77, photo_id: `f${i}`,
  }));
  const out = compare(twoCameras({ detections: burst }), { group: 'rain' });
  assert.equal(out.buckets.find(b => b.key === 'wet').ranked.find(r => r.id === 'A').sightings, 1);
});

test('a detection with no visit still counts once, on its own', () => {
  const out = compare(twoCameras({
    detections: [
      { camera_id: 'A', hour_utc: `${NOV[0]}T14:00:00Z`, visit_id: null, photo_id: 'p1' },
      { camera_id: 'A', hour_utc: `${NOV[0]}T15:00:00Z`, visit_id: null, photo_id: 'p2' },
    ],
  }), { group: 'rain' });
  assert.equal(out.buckets.find(b => b.key === 'wet').ranked.find(r => r.id === 'A').sightings, 2);
});

test('under the hours floor a camera is not ranked, and the sentence says why', () => {
  // Ten hours is a floor against dividing by three, not a significance test —
  // but a rate off three hours is worse than no rate, because it looks like one.
  const short = dates('2025-11-01', 1);
  const inputs = {
    cameras: [{ id: 'A', name: 'North Ridge', locationId: 1 }],
    // One day, and only 8 of its hours are wet.
    hoursByLocation: new Map([[1, hoursOn(short, h => ({ precip_in: h >= 16 ? 0.05 : 0, temp_f: 40 }))]]),
    detections: [sighting('A', short[0], 18, 5)],
    coverage: new Map([['A', new Set(short)]]),
  };
  const out = compare(inputs, { group: 'rain' });
  const wet = out.buckets.find(b => b.key === 'wet');
  assert.equal(wet.ranked.length, 0, 'eight hours does not earn a rate');
  assert.equal(wet.thin.length, 1);
  assert.equal(wet.thin[0].hours, 8);
  assert.equal(wet.thin[0].sightings, 1, 'the raw count is still shown');
  assert.match(wet.says, /Not enough rain yet/);
  assert.match(wet.says, /North Ridge 8 h/);
  assert.match(wet.says, new RegExp(String(MIN_HOURS) + ' hours is the floor'));

  const dry = out.buckets.find(b => b.key === 'dry');
  assert.equal(dry.ranked.length, 1, '16 dry hours clears the floor');
  assert.equal(dry.ranked[0].sightings, 0, 'and honestly reports nothing seen');
  assert.equal(dry.ranked[0].per100, 0);
});

test('a bucket the shared window never contained says so, rather than showing zeroes', () => {
  const out = compare(twoCameras({ detections: [sighting('A', NOV[0], 12, 1)] }), { group: 'temp' });
  const freezing = out.buckets.find(b => b.key === 'freezing');
  assert.equal(freezing.ranked.length, 0);
  assert.equal(freezing.thin.length, 0);
  assert.match(freezing.says, /No sub-freezing weather in the 10-day window/);
});

test('a sentence about a compass point keeps the compass point', () => {
  // Lowercasing the label to build the sentence is the obvious shortcut, and
  // the first browser drive of this section showed what it produces: "No ne
  // wind in the 21-day window". Every bucket carries a phrase written for a
  // sentence instead, and every group needs one.
  for (const g of GROUPS) {
    for (const b of g.buckets) {
      assert.ok(b.phrase, `${g.key}.${b.key} has a sentence phrase`);
      assert.equal(b.phrase, b.phrase.trimEnd(), 'no trailing space');
    }
  }
  const out = compare(twoCameras({ detections: [sighting('A', NOV[0], 12, 1)] }), { group: 'winddir' });
  const ne = out.buckets.find(b => b.key === 'NE');
  assert.match(ne.says, /No NE wind in the 10-day window/);
  assert.ok(!/\bne wind\b/.test(ne.says), 'and never comes out lowercased');
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

test('untagged photos are not evidence — the table refuses rather than reporting zeroes', () => {
  const out = compare(twoCameras({ detections: [] }), { group: 'rain' });
  assert.equal(out.refusal.code, 'nothing-tagged');
  assert.match(out.refusal.says, /Review/);
  assert.equal(out.buckets.length, 0, 'no table at all, not a table of zeroes');
  assert.equal(out.cameras.length, 2, 'but the coverage is still reported');
});

test('with no weather stored, no condition can be told from another', () => {
  const out = compare({
    cameras: [{ id: 'A', name: 'North Ridge', locationId: 1 }],
    hoursByLocation: new Map(),
    detections: [sighting('A', NOV[0], 12, 1)],
    coverage: new Map([['A', new Set(NOV)]]),
  }, { group: 'rain' });
  assert.equal(out.refusal.code, 'no-weather');
});

test('with no photos anywhere it says so instead of dividing by nothing', () => {
  const out = compare({
    cameras: [{ id: 'A', name: 'North Ridge', locationId: 1 }],
    hoursByLocation: new Map([[1, hoursOn(NOV, wetAfternoons)]]),
    detections: [],
    coverage: new Map(),
  }, { group: 'rain' });
  assert.equal(out.refusal.code, 'no-photos');
});

test('cameras with no day in common are refused, and the short one is named', () => {
  // "No common window" is not actionable; "Creek Bottom covers 3 days" is.
  const inputs = twoCameras({ detections: [sighting('A', NOV[0], 12, 1)] });
  inputs.coverage.set('B', new Set(dates('2025-12-01', 3)));
  inputs.hoursByLocation.set(1, hoursOn([...NOV, ...dates('2025-12-01', 3)], wetAfternoons));
  const out = compare(inputs, { group: 'rain' });
  assert.equal(out.refusal.code, 'no-common-window');
  assert.match(out.refusal.says, /Creek Bottom covers 3 days/);
  assert.match(out.refusal.says, /different weeks, not different ground/);
});

test('an unknown condition group is refused by name', () => {
  assert.throws(() => compare(twoCameras(), { group: 'moon' }), /unknown condition group "moon"/);
});

// ---------------------------------------------------------------------------
// Tonight's conditions, and the stand they point at
// ---------------------------------------------------------------------------

test("tonight's conditions select a bucket in each group they can be placed in", () => {
  const b = bucketsForConditions({
    precip_in: 0.1, temp_f: 28, wind_dir: 315, wind_mph: 14, cloud_pct: 90, trend_inhg: 0.3,
  });
  assert.deepEqual(b, {
    rain: 'wet', temp: 'freezing', winddir: 'NW', windspeed: 'strong',
    sky: 'overcast', pressure: 'rising',
  });
});

test('a forecast that cannot be placed selects nothing, rather than defaulting', () => {
  assert.deepEqual(bucketsForConditions({}), {});
  assert.deepEqual(bucketsForConditions(null), {});
  assert.deepEqual(bucketsForConditions({ temp_f: 50 }), { temp: 'mild' },
    'the fields it does have still place, the ones it lacks stay out');
});

test('a producing camera becomes a stand to sit, or nothing if no stand covers it', () => {
  const bucket = {
    ranked: [
      { id: 'A', name: 'North Ridge', per100: 5, sightings: 6, hours: 120 },
      { id: 'B', name: 'Creek Bottom', per100: 1, sightings: 1, hours: 120 },
    ],
  };
  const stands = [
    { id: 1, name: 'Ladder', nearbyCameras: [{ id: 'B', metres: 40 }, { id: 'A', metres: 120 }] },
    { id: 2, name: 'Box blind', nearbyCameras: [{ id: 'B', metres: 60 }] },
    { id: 3, name: 'Far corner', nearbyCameras: [] },
  ];
  const out = standsForBucket(bucket, stands);
  assert.equal(out.length, 2, 'the stand no camera covers is not invented a number');
  assert.equal(out[0].stand, 'Ladder');
  assert.equal(out[0].camera, 'North Ridge', 'a stand takes its best covering camera');
  assert.equal(out[1].stand, 'Box blind');
  assert.deepEqual(standsForBucket({ ranked: [] }, stands), []);
  assert.deepEqual(standsForBucket(null, stands), []);
});

test('on equal rates the nearer stand wins, not whichever the database sorted first', () => {
  // The first browser drive of this section put a box blind 222 m from the
  // producing camera ahead of a ladder 40 m from it, both quoting the same
  // rate — same number, wrong tree. `allStands` counts anything within 400 m
  // as covering, so ties like this are ordinary rather than rare.
  const bucket = { ranked: [{ id: 'A', name: 'North Ridge', per100: 25, sightings: 21, hours: 84 }] };
  const stands = [
    { id: 1, name: 'Box blind', nearbyCameras: [{ id: 'A', metres: 222 }] },
    { id: 2, name: 'Ladder', nearbyCameras: [{ id: 'A', metres: 40 }] },
  ];
  const out = standsForBucket(bucket, stands);
  assert.equal(out[0].stand, 'Ladder');
  assert.equal(out[0].metres, 40);
  assert.equal(out[1].stand, 'Box blind');
});

test('a stand covering two equally productive cameras quotes the nearer one', () => {
  const bucket = {
    ranked: [
      { id: 'A', name: 'North Ridge', per100: 5, sightings: 6, hours: 120 },
      { id: 'B', name: 'Creek Bottom', per100: 5, sightings: 6, hours: 120 },
    ],
  };
  const stands = [{ id: 1, name: 'Ladder', nearbyCameras: [{ id: 'A', metres: 300 }, { id: 'B', metres: 30 }] }];
  assert.equal(standsForBucket(bucket, stands)[0].camera, 'Creek Bottom');
});

// ---------------------------------------------------------------------------
// End to end, through a real database
// ---------------------------------------------------------------------------

test('the same answer comes out of a real database', () => {
  const db = openDb(tmp());
  const camA = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const second = {
    ...FLEX_M,
    id: 'eeeeeeeeeeeeeeeeeeeeeeee',
    config: { ...FLEX_M.config, name: 'Creek Bottom' },
  };
  const camB = upsertCamera(db, norm(second), { provider: 'spypoint' });
  assert.equal(camA.weather_location_id, camB.weather_location_id,
    'one property, one weather location');
  const loc = weatherLocationFor(db, 44.123456, -90.654321);

  // Ten days of weather, afternoons wet.
  for (const h of hoursOn(NOV, wetAfternoons)) {
    upsertWeatherHour(db, loc.id, h.hour_utc, {
      tempF: h.temp_f, pressureInHg: 30.0, windMph: h.wind_mph,
      windDir: h.wind_dir, precipIn: h.precip_in, cloudPct: h.cloud_pct,
    });
  }

  // Both cameras produce a photo every day, so both cover the whole window.
  const photo = (camId, day, hour, n = 0) => upsertPhoto(db, {
    provider: 'spypoint', cameraId: camId, nativeId: `${camId}-${day}-${hour}-${n}`,
    takenAt: `${day}T${String(hour).padStart(2, '0')}:30:00.000Z`,
  });
  for (const d of NOV) {
    photo('aaaaaaaaaaaaaaaaaaaaaaaa', d, 3);
    photo('eeeeeeeeeeeeeeeeeeeeeeee', d, 3);
  }

  // Six wet-afternoon deer on North Ridge; one on Creek Bottom.
  for (let i = 0; i < 6; i++) {
    const p = photo('aaaaaaaaaaaaaaaaaaaaaaaa', NOV[i], 14, 1);
    addDetection(db, { photoId: p.id, species: 'deer', source: 'manual', confirmed: true });
  }
  const one = photo('eeeeeeeeeeeeeeeeeeeeeeee', NOV[0], 14, 1);
  addDetection(db, { photoId: one.id, species: 'deer', source: 'manual', confirmed: true });

  // And a machine claim nobody has confirmed, which must not count.
  const guess = photo('eeeeeeeeeeeeeeeeeeeeeeee', NOV[1], 15, 2);
  addDetection(db, { photoId: guess.id, species: 'deer', source: 'camera-ai' });

  const out = whereTable(db, { group: 'rain', species: 'deer' });
  assert.equal(out.refusal, null);
  assert.equal(out.common.days, 10);
  const wet = out.buckets.find(b => b.key === 'wet');
  assert.equal(wet.ranked[0].name, 'North Ridge');
  assert.equal(wet.ranked[0].sightings, 6);
  assert.equal(wet.ranked[1].name, 'Creek Bottom');
  assert.equal(wet.ranked[1].sightings, 1,
    "the camera's own unconfirmed guess is not a sighting");
});

test('a database with photos and no tags refuses, and says how to fix it', () => {
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const loc = weatherLocationFor(db, 44.123456, -90.654321);
  for (const h of hoursOn(NOV.slice(0, 2), wetAfternoons)) {
    upsertWeatherHour(db, loc.id, h.hour_utc, { tempF: 40, precipIn: h.precip_in });
  }
  upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa', nativeId: 'p1',
    takenAt: `${NOV[0]}T14:00:00.000Z`,
  });
  const out = whereTable(db);
  assert.equal(out.refusal.code, 'nothing-tagged');
  assert.match(out.refusal.says, /Review/);
});

test('visits are the unit end to end, once the sync has grouped them', () => {
  // groupVisits is what the sync runs; a burst tagged once must not read as
  // a burst-sized pile of sightings.
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const loc = weatherLocationFor(db, 44.123456, -90.654321);
  for (const h of hoursOn(NOV, wetAfternoons)) {
    upsertWeatherHour(db, loc.id, h.hour_utc, {
      tempF: 40, precipIn: h.precip_in, windMph: 8, windDir: 270, cloudPct: 50,
    });
  }
  for (const d of NOV) {
    upsertPhoto(db, {
      provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      nativeId: `keep-${d}`, takenAt: `${d}T03:00:00.000Z`,
    });
  }
  const frames = [];
  for (let i = 0; i < 8; i++) {
    frames.push(upsertPhoto(db, {
      provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      nativeId: `burst-${i}`, takenAt: `${NOV[0]}T14:00:0${i}.000Z`,
    }));
  }
  groupVisits(db);
  for (const f of frames) {
    addDetection(db, { photoId: f.id, species: 'deer', source: 'manual', confirmed: true });
  }
  const out = whereTable(db, { group: 'rain' });
  const wet = out.buckets.find(b => b.key === 'wet');
  assert.equal(wet.ranked[0].sightings, 1, 'eight frames of one deer is one sighting');
});

test('the stands a producing camera points at come back from a real database', () => {
  const db = openDb(tmp());
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  createStand(db, { name: 'Ladder', lat: 44.1236, lng: -90.6544, type: 'stand' });
  const stands = allStands(db);
  const bucket = { ranked: [{ id: cam.id, name: 'North Ridge', per100: 5, sightings: 6, hours: 120 }] };
  const out = standsForBucket(bucket, stands);
  assert.equal(out.length, 1);
  assert.equal(out[0].stand, 'Ladder');
  assert.ok(out[0].metres > 0 && out[0].metres < 400);
});
