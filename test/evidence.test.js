import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sunTimes, lightBand, isDaylight, bandForWindow, compassOf, pointsApart,
  conditionLadder, tagHours, cameraEvidence, evidenceConfidence, MIN_HOURS,
} from '../evidence.mjs';

// The invented cluster this repo uses everywhere. Points at nothing.
const LAT = 44.12, LNG = -90.65;

// ---------------------------------------------------------------------------
// The solar calculation, which everything downstream trusts
// ---------------------------------------------------------------------------

test('sunrise and sunset match published times to within a few minutes', () => {
  // Madison, Wisconsin. Checked against published tables: 7 Nov 2026 sunrise
  // about 6:41 CST (12:41Z) and sunset about 4:38 CST (22:38Z); the solstice
  // 5:18 CDT (10:18Z) and 8:40 CDT (01:40Z the next day).
  const near = (a, b, minutes, what) =>
    assert.ok(Math.abs(a - b) <= minutes * 60000,
      `${what}: ${new Date(a).toISOString()} vs ${new Date(b).toISOString()}`);

  const nov = sunTimes(Date.parse('2026-11-07T12:00:00Z'), 43.07, -89.40);
  near(nov.sunrise, Date.parse('2026-11-07T12:41:00Z'), 5, 'November sunrise');
  near(nov.sunset, Date.parse('2026-11-07T22:38:00Z'), 5, 'November sunset');

  const jun = sunTimes(Date.parse('2026-06-21T12:00:00Z'), 43.07, -89.40);
  near(jun.sunrise, Date.parse('2026-06-21T10:18:00Z'), 5, 'solstice sunrise');
  near(jun.sunset, Date.parse('2026-06-22T01:40:00Z'), 5, 'solstice sunset');
});

test('the sun setting before it rises is reported, not returned as NaN', () => {
  // Above the arctic circle in December there is no sunrise at all. A NaN here
  // would be compared against silently and every hour would classify as
  // 'night' for a plausible-looking reason.
  const polar = sunTimes(Date.parse('2026-12-21T12:00:00Z'), 78.2, 15.6);
  assert.equal(polar.polar, true);
  assert.equal(polar.sunrise, null);
  assert.equal(polar.sunset, null);
  assert.equal(lightBand(Date.parse('2026-12-21T12:00:00Z'), 78.2, 15.6), 'unknown');
});

test('the day divides into the bands a hunter actually sits', () => {
  const { sunrise, sunset } = sunTimes(Date.parse('2026-11-07T12:00:00Z'), LAT, LNG);
  const at = ms => lightBand(ms, LAT, LNG);
  assert.equal(at(sunrise), 'dawn');
  assert.equal(at(sunrise + 30 * 60000), 'dawn', 'half an hour after first light is still dawn');
  assert.equal(at(sunrise + 4 * 3600000), 'day');
  assert.equal(at(sunset - 30 * 60000), 'dusk');
  assert.equal(at(sunset + 3 * 3600000), 'night');
  assert.equal(isDaylight(sunrise + 4 * 3600000, LAT, LNG), true);
  assert.equal(isDaylight(sunset + 3 * 3600000, LAT, LNG), false);
});

test('a morning sit asks about dawn and an evening sit about dusk', () => {
  assert.equal(bandForWindow('AM'), 'dawn');
  assert.equal(bandForWindow('PM'), 'dusk');
});

// ---------------------------------------------------------------------------
// Compass helpers
// ---------------------------------------------------------------------------

test('compass points and the distance between them', () => {
  assert.equal(compassOf(0), 'N');
  assert.equal(compassOf(315), 'NW');
  assert.equal(compassOf(-45), 'NW', 'negative bearings wrap');
  assert.equal(compassOf(null), null, 'a missing bearing is not north');
  assert.equal(pointsApart('N', 'N'), 0);
  assert.equal(pointsApart('N', 'NNE'), 1);
  assert.equal(pointsApart('N', 'NNW'), 1, 'the short way round the circle');
  assert.equal(pointsApart('N', 'S'), 8);
});

// ---------------------------------------------------------------------------
// The condition ladder
// ---------------------------------------------------------------------------

test('conditions run from most specific to least, and say which they are', () => {
  const ladder = conditionLadder({ window: 'PM', windFrom: 'NW' });
  assert.equal(ladder[0].specificity, 3);
  assert.match(ladder[0].name, /dusk on a NW wind/);
  assert.equal(ladder.at(-1).specificity, 0);
  assert.match(ladder.at(-1).name, /any daylight hour/);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i].specificity < ladder[i - 1].specificity, 'strictly loosening');
  }
});

test('with no forecast wind the wind rungs are not offered at all', () => {
  const ladder = conditionLadder({ window: 'AM', windFrom: null, windDir: null });
  assert.ok(!ladder.some(c => /wind/.test(c.name) && c.specificity >= 2),
    'an unknown wind must not silently become "any wind"');
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** A season of hours at one place, every hour on the hour, with a fixed wind. */
function season(days, windDeg, { from = '2026-10-15T00:00:00Z' } = {}) {
  const start = Date.parse(from);
  const rows = [];
  for (let h = 0; h < days * 24; h++) {
    rows.push({
      hour_utc: new Date(start + h * 3600000).toISOString().slice(0, 13) + ':00:00Z',
      wind_dir: windDeg, temp_f: 40,
    });
  }
  return tagHours(rows, { lat: LAT, lng: LNG });
}

/** Sightings placed at a chosen band on the first N days. */
function sightingsAt(cameraId, hours, band, n) {
  return hours.filter(h => h.band === band).slice(0, n)
    .map(h => ({ cameraId, ms: h.ms + 60000 }));
}

test('a rate is per hundred camera-hours, and the denominator is real', () => {
  const hours = season(30, 315);           // NW all month
  const cameras = [
    { id: 'a', name: 'A', lat: LAT, lng: LNG, hours },
    { id: 'b', name: 'B', lat: LAT, lng: LNG, hours },
  ];
  const sightings = [
    ...sightingsAt('a', hours, 'dusk', 12),
    ...sightingsAt('b', hours, 'dusk', 2),
  ];
  const r = cameraEvidence({ cameras, sightings, sit: { window: 'PM', windFrom: 'NW' } });

  assert.match(r.condition, /dusk on a NW wind/, 'the most specific rung cleared the bar');
  const a = r.rows.find(x => x.cameraId === 'a');
  const b = r.rows.find(x => x.cameraId === 'b');
  assert.equal(a.detections, 12);
  assert.ok(a.hours > 0);
  assert.equal(a.per100, Math.round(1000 * 12 / a.hours) / 10);
  assert.ok(a.per100 > b.per100);
  assert.equal(r.rows[0].cameraId, 'a', 'sorted by rate, not by count');
});

test('the whole comparison uses ONE condition, not one per camera', () => {
  // Ranking camera A on its best-supported condition against camera B on a
  // different one compares two different questions and calls it a ranking.
  const nw = season(30, 315);
  const se = season(30, 135);
  const cameras = [
    { id: 'a', name: 'A', lat: LAT, lng: LNG, hours: nw },
    { id: 'b', name: 'B', lat: LAT, lng: LNG, hours: se },
  ];
  const r = cameraEvidence({
    cameras, sightings: [], sit: { window: 'PM', windFrom: 'NW' },
  });
  const conditions = new Set(r.rows.map(x => x.condition));
  assert.equal(conditions.size, 1, 'every camera judged on the same question');
});

test('it drops down the ladder rather than answering from nothing', () => {
  // Hours exist, but never on a north-west wind. The specific rung is empty, so
  // the answer must loosen and SAY it loosened.
  const hours = season(30, 135);           // SE all month
  const cameras = [
    { id: 'a', name: 'A', lat: LAT, lng: LNG, hours },
    { id: 'b', name: 'B', lat: LAT, lng: LNG, hours },
  ];
  const r = cameraEvidence({ cameras, sightings: [], sit: { window: 'PM', windFrom: 'NW' } });
  assert.ok(r.specificity < 2, 'the wind rungs could not be met');
  assert.match(r.condition, /dusk, any wind|any daylight hour/);
});

test('too little matched data is refused outright, and named as refused', () => {
  const hours = season(1, 315);            // a single day
  const cameras = [{ id: 'a', name: 'A', lat: LAT, lng: LNG, hours }];
  const r = cameraEvidence({
    cameras, sightings: sightingsAt('a', hours, 'dusk', 3),
    sit: { window: 'PM', windFrom: 'NW' }, minHours: 40,
  });
  assert.equal(r.condition, null);
  assert.equal(r.rows[0].per100, null, 'three deer in one evening is not a rate');
  assert.equal(r.rows[0].enough, false);
  assert.match(r.note, /Nothing here is ranked on your own photographs/);
  assert.equal(evidenceConfidence(r).tier, 'none');
});

test('nocturnal share is measured over every picture, not the matched ones', () => {
  // It is a property of the place, and it is the number that stops a busy
  // camera recommending a stand you will never see a deer from.
  const hours = season(30, 315);
  const cameras = [
    { id: 'a', name: 'A', lat: LAT, lng: LNG, hours },
    { id: 'b', name: 'B', lat: LAT, lng: LNG, hours },
  ];
  const sightings = [
    ...sightingsAt('a', hours, 'night', 18),
    ...sightingsAt('a', hours, 'dusk', 2),
    ...sightingsAt('b', hours, 'dusk', 6),
  ];
  const r = cameraEvidence({ cameras, sightings, sit: { window: 'PM', windFrom: 'NW' } });
  const a = r.rows.find(x => x.cameraId === 'a');
  assert.equal(a.totalSightings, 20);
  assert.equal(a.nocturnalShare, 90);
  assert.equal(r.rows.find(x => x.cameraId === 'b').nocturnalShare, 0);
});

test('confidence rises with hours and with separation, not with the rate', () => {
  const hours = season(60, 315);
  const cameras = [
    { id: 'a', name: 'A', lat: LAT, lng: LNG, hours },
    { id: 'b', name: 'B', lat: LAT, lng: LNG, hours },
  ];
  const clear = cameraEvidence({
    cameras,
    sightings: [...sightingsAt('a', hours, 'dusk', 40), ...sightingsAt('b', hours, 'dusk', 2)],
    sit: { window: 'PM', windFrom: 'NW' },
  });
  const level = cameraEvidence({
    cameras,
    sightings: [...sightingsAt('a', hours, 'dusk', 20), ...sightingsAt('b', hours, 'dusk', 20)],
    sit: { window: 'PM', windFrom: 'NW' },
  });
  const cc = evidenceConfidence(clear), cl = evidenceConfidence(level);
  assert.ok(['strong', 'moderate'].includes(cc.tier));
  assert.ok(cl.gap <= 0 || cl.tier !== 'strong', 'a tie is not a strong finding');
  assert.match(cl.why, /level|leads/);
});

test('the evidence bar has the value design.md settled on', () => {
  assert.equal(MIN_HOURS, 10);
});
