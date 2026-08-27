import test from 'node:test';
import assert from 'node:assert/strict';
import { rutPhase, moonPhase, scoreSit, compass, inHg, rate, RUT_CALENDAR }
  from '../hunt-planner.mjs';

const on = (m, d) => new Date(2026, m - 1, d, 12, 0, 0);

test('rut calendar covers every day of the year exactly once', () => {
  // A gap would throw; an overlap would silently make the earlier entry win and
  // hide the later one, so check the whole year resolves and hits every phase.
  const seen = new Set();
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const date = new Date(2026, m - 1, d, 12);
      if (date.getMonth() !== m - 1) continue; // skip Feb 30 and friends
      const r = rutPhase(date);
      assert.ok(r, `${m}-${d} resolved to nothing`);
      seen.add(r.phase);
    }
  }
  assert.equal(seen.size, new Set(RUT_CALENDAR.map(r => r.phase)).size,
    'every calendar phase is reachable');
});

test('rut phases land on the right dates for this latitude', () => {
  assert.match(rutPhase(on(10, 10)).phase, /October lull/);
  assert.match(rutPhase(on(10, 25)).phase, /Pre-rut/);
  assert.match(rutPhase(on(11, 5)).phase, /Seeking/);
  assert.match(rutPhase(on(11, 12)).phase, /Chasing|peak/i);
  assert.match(rutPhase(on(11, 20)).phase, /Post-peak/);
  assert.match(rutPhase(on(12, 15)).phase, /Second rut/);
  assert.match(rutPhase(on(7, 4)).phase, /Off season/);
});

test('the rut peaks in early-to-mid November, above every other date', () => {
  const nov = rutPhase(on(11, 5)).score;
  for (const [m, d] of [[9, 15], [10, 10], [10, 25], [12, 1], [12, 15], [1, 20], [7, 4]]) {
    assert.ok(nov > rutPhase(on(m, d)).score,
      `Nov 5 (${nov}) should outrank ${m}/${d} (${rutPhase(on(m, d)).score})`);
  }
  // The October lull must score below both the season either side of it.
  assert.ok(rutPhase(on(10, 10)).score < rutPhase(on(9, 15)).score);
  assert.ok(rutPhase(on(10, 10)).score < rutPhase(on(10, 25)).score);
});

test('moon phase tracks the synodic cycle', () => {
  // Referenced to the new moon of 2000-01-06 18:14 UTC; one synodic month later
  // must be new again, and half a month later full.
  const SYNODIC = 29.530588853;
  const ref = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const plus = d => new Date(ref.getTime() + d * 86400000);

  assert.ok(moonPhase(ref).illum < 0.01, 'reference epoch is a new moon');
  assert.ok(moonPhase(plus(SYNODIC)).illum < 0.01, 'one cycle later is new again');
  assert.ok(moonPhase(plus(SYNODIC * 12)).illum < 0.02, 'twelve cycles later still new');
  assert.ok(moonPhase(plus(SYNODIC / 2)).illum > 0.99, 'half a cycle later is full');
  assert.match(moonPhase(plus(SYNODIC / 2)).name, /full/);
  assert.match(moonPhase(ref).name, /new/);

  // Illumination must stay within bounds across a whole cycle.
  for (let d = 0; d < 30; d += 0.5) {
    const { illum, frac } = moonPhase(plus(d));
    assert.ok(illum >= 0 && illum <= 1, `illum in range at day ${d}`);
    assert.ok(frac >= 0 && frac < 1, `frac in range at day ${d}`);
  }
});

// A plain hour, so each test can vary one factor at a time.
const hour = (o = {}) => ({
  time: '2026-11-05T07:00', temp: 35, pressure: 1016, wind: 8, windDir: 315,
  precip: 0, cloud: 50, ...o,
});
const hours = (n, o) => Array.from({ length: n }, () => hour(o));
const RUT = { score: 24, phase: 'Seeking', note: 'test' };
const MOON = { illum: 0.5, name: 'first quarter', frac: 0.25 };
const base = extra => scoreSit({
  hours: hours(4), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0, ...extra,
});

test('a cold front scores above a warm-up, and bigger drops score higher', () => {
  const flat = base({}).total;
  const mild = base({ tempDropF: 6 }).total;
  const front = base({ tempDropF: 12 }).total;
  const hard = base({ tempDropF: 22 }).total;
  const warmUp = base({ tempDropF: -15 }).total;

  assert.ok(mild > flat, 'any drop beats no change');
  assert.ok(front > mild, 'a real front beats a mild drop');
  assert.ok(hard > front, 'a hard front scores highest');
  assert.ok(warmUp < flat, 'a warm-up is a penalty');
});

test('wind is scored as a curve, not more-is-better', () => {
  const calm = scoreSit({ hours: hours(4, { wind: 1 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const ideal = scoreSit({ hours: hours(4, { wind: 8 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const gusty = scoreSit({ hours: hours(4, { wind: 16 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const gale = scoreSit({ hours: hours(4, { wind: 25 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;

  assert.ok(ideal > calm, 'a steady breeze beats dead calm');
  assert.ok(ideal > gusty, 'ideal beats gusty');
  assert.ok(gale < gusty, 'a gale is worst');
});

test('heavy rain is penalised but a drizzle is not', () => {
  const dry = base({}).total;
  const drizzle = scoreSit({ hours: hours(4, { precip: 0.03 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const downpour = scoreSit({ hours: hours(4, { precip: 0.2 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;

  assert.ok(drizzle >= dry, 'light rain is not a penalty');
  assert.ok(downpour < dry, 'heavy rain is a penalty');
});

test('rising pressure beats falling pressure', () => {
  assert.ok(base({ pressureTrend: 0.2 }).total > base({ pressureTrend: -0.2 }).total);
});

test('perfect weather out of season never outranks a poor day in the rut', () => {
  // Weather is additive, so without a cap a flawless August morning outscores a
  // windy November rut sit — which is nonsense, there being no season in
  // August. This is the assertion that caught it.
  const rutBadWeather = scoreSit({
    hours: hours(4, { wind: 20 }), rut: { score: 24, phase: 'Seeking', note: '' },
    moon: MOON, tempDropF: 0, pressureTrend: 0,
  }).total;
  const offSeasonPerfect = scoreSit({
    hours: hours(4, { wind: 8, cloud: 80 }), rut: { score: 2, phase: 'Off season', note: '' },
    moon: { illum: 0.02, name: 'new', frac: 0 }, tempDropF: 22, pressureTrend: 0.2,
  }).total;

  assert.ok(rutBadWeather > 0, 'a rut sit in bad weather is still worth something');
  assert.ok(offSeasonPerfect < rutBadWeather,
    `off season (${offSeasonPerfect}) must rank below a windy rut sit (${rutBadWeather})`);
  assert.equal(rate(offSeasonPerfect), 'poor');
});

test('the off-season cap is recorded as a visible reason, not applied silently', () => {
  const s = scoreSit({
    hours: hours(4, { wind: 8, cloud: 80 }), rut: { score: 2, phase: 'Off season', note: '' },
    moon: { illum: 0.02, name: 'new', frac: 0 }, tempDropF: 22, pressureTrend: 0.2,
  });
  assert.match(s.parts.at(-1).reason, /outside the hunting season/);
  // The printed reasons must still add up to the total, or the output lies.
  assert.equal(s.parts.reduce((t, p) => t + p.points, 0), s.total);
});

test('in-season scores are never touched by the cap', () => {
  const s = scoreSit({
    hours: hours(4, { wind: 8 }), rut: { score: 24, phase: 'Seeking', note: '' },
    moon: MOON, tempDropF: 12, pressureTrend: 0.2,
  });
  assert.equal(s.parts.reduce((t, p) => t + p.points, 0), s.total);
  assert.ok(!s.parts.some(p => /outside the hunting season/.test(p.reason)));
  assert.ok(s.total > 40, 'a rut sit on a front should rate highly');
});

test('every scored factor carries a human-readable reason', () => {
  const s = base({ tempDropF: 12, pressureTrend: 0.2 });
  assert.ok(s.parts.length >= 3);
  for (const p of s.parts) {
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 5, `reason too terse: ${p.reason}`);
    assert.notEqual(p.points, 0, 'zero-point factors are not recorded');
  }
});

test('compass converts bearings to the direction wind comes from', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(90), 'E');
  assert.equal(compass(180), 'S');
  assert.equal(compass(270), 'W');
  assert.equal(compass(315), 'NW');
  assert.equal(compass(360), 'N', 'wraps at 360');
  assert.equal(compass(-90), 'W', 'handles negative bearings');
});

test('pressure converts hPa to inHg', () => {
  assert.ok(Math.abs(inHg(1013.25) - 29.921) < 0.01, 'standard atmosphere');
});

test('ratings are ordered and every score gets one', () => {
  assert.equal(rate(60), 'PRIME');
  assert.equal(rate(36), 'strong');
  assert.equal(rate(26), 'good');
  assert.equal(rate(16), 'fair');
  assert.equal(rate(2), 'poor');
  assert.equal(rate(-50), 'poor', 'deeply negative still rates');
});
