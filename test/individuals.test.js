import test from 'node:test';
import assert from 'node:assert/strict';
import {
  individualFactor, stratifiedTest, judge, FACTORS, MIN_SIGHTINGS,
} from '../individuals.mjs';
import { moonPhase } from '../movement-model.mjs';
import { lightBand } from '../evidence.mjs';

const LAT = 44.12, LNG = -90.65;
const START = Date.parse('2026-08-01T00:00:00Z');

/**
 * Every hour of a long season, tagged the way individualsFor tags them.
 *
 * Pressure is given a deliberate DIURNAL CYCLE — high in the afternoon, low
 * overnight — because that is the confound the stratification exists to kill.
 */
const pool = Array.from({ length: 150 * 24 }, (_, h) => {
  const ms = START + h * 3600000;
  const hourOfDay = new Date(ms).getUTCHours();
  return {
    ms,
    band: lightBand(ms, LAT, LNG),
    hour: { pressure: 30.0 + 0.25 * Math.cos((hourOfDay - 19) / 24 * 2 * Math.PI) },
  };
});

const inBand = b => pool.filter(h => h.band === b);

// ---------------------------------------------------------------------------
// Refusals, which are most of the answers this will ever give
// ---------------------------------------------------------------------------

test('a buck with a handful of pictures gets a refusal, not a verdict', () => {
  const r = individualFactor({
    name: 'Split G2', sightings: inBand('dusk').slice(0, 5), pool, factor: 'moon',
  });
  assert.equal(r.p, null);
  assert.equal(r.verdict, 'not enough sightings');
  assert.match(r.why, /noise with a decimal point/);
  assert.ok(MIN_SIGHTINGS >= 12, 'the bar matches the sit journal, for the same reason');
});

test('an unanswerable question is not a p-value of 1', () => {
  // Every sighting in a band the record barely covers: there is nothing to
  // compare against, and "no relationship" would be a claim rather than a shrug.
  const odd = Array.from({ length: 14 }, (_, i) => ({
    ms: START + i * 3600000, band: 'nowhere', hour: { pressure: 30 },
  }));
  const r = individualFactor({ name: 'Ghost', sightings: odd, pool, factor: 'moon' });
  assert.equal(r.p, null);
  assert.equal(r.verdict, 'cannot be answered');
});

// ---------------------------------------------------------------------------
// It finds a real effect, and does not find an absent one
// ---------------------------------------------------------------------------

test('a buck that really does follow the moon is found', () => {
  // Planted: every picture on a bright night, all at dusk so the light band is
  // held constant and the moon is the only thing left varying.
  const bright = inBand('dusk')
    .filter(h => moonPhase(new Date(h.ms)).illum > 0.9).slice(0, 20);
  assert.ok(bright.length >= MIN_SIGHTINGS, 'the fixture has enough bright-moon dusks');

  const r = individualFactor({ name: 'Moonlight', sightings: bright, pool, factor: 'moon' });
  assert.ok(r.p !== null);
  assert.ok(r.p < 0.01, `a planted effect should be obvious, got p ${r.p}`);
  assert.equal(r.direction, 'bright moons');
  assert.ok(r.observed > r.expected + 0.3, 'and the size of it is reported');
  assert.match(r.why, /against .* for the hours he could have been/);
});

test('a buck that follows nothing is reported as following nothing', () => {
  const spread = inBand('dusk').filter((_, i) => i % 7 === 0).slice(0, 30);
  const r = individualFactor({ name: 'Ordinary', sightings: spread, pool, factor: 'moon' });
  assert.ok(r.p !== null);
  assert.ok(r.p > 0.05, `no planted effect should not produce one, got p ${r.p}`);
});

// ---------------------------------------------------------------------------
// The trap this file exists to avoid
// ---------------------------------------------------------------------------

test('a nocturnal buck is NOT reported as a barometer buck', () => {
  // THE test. Pressure cycles through the day and deer are crepuscular, so
  // comparing a night-time buck against all available hours would report a
  // confident barometric effect that is really just "he moves at night".
  // The draw is stratified by light band, so the comparison is night-against-
  // night and the confound has nowhere to go.
  const nightly = inBand('night').filter((_, i) => i % 11 === 0).slice(0, 25);
  const r = individualFactor({ name: 'Nightowl', sightings: nightly, pool, factor: 'pressure' });

  assert.ok(r.p !== null);
  assert.ok(r.p > 0.05,
    `stratified, a nocturnal buck has no barometer effect — got p ${r.p}`);

  // And prove the confound was really there to be fallen into: against the
  // whole pool rather than against night hours, his pressure is visibly low.
  const allMean = pool.reduce((s, h) => s + h.hour.pressure, 0) / pool.length;
  const hisMean = nightly.reduce((s, h) => s + h.hour.pressure, 0) / nightly.length;
  assert.ok(allMean - hisMean > 0.1,
    'the naive comparison would have shown a large, entirely spurious difference');
  assert.ok(Math.abs(r.observed - r.expected) < 0.05,
    'matched on time of day, the difference is gone');
});

// ---------------------------------------------------------------------------
// Multiple comparisons
// ---------------------------------------------------------------------------

test('testing more bucks makes every finding harder to claim', () => {
  const marginal = { individual: 'A', factor: 'moon', p: 0.03, direction: 'bright moons', why: 'x' };
  const alone = judge([{ ...marginal }]);
  assert.equal(alone.tests, 1);
  assert.equal(alone.results[0].verdict, 'follows bright moons', 'one test, 5% bar, called');

  const crowd = judge([{ ...marginal }, { ...marginal, individual: 'B' },
    { ...marginal, individual: 'C' }, { ...marginal, individual: 'D' }]);
  assert.equal(crowd.tests, 4);
  assert.ok(crowd.threshold < 0.03);
  assert.equal(crowd.results[0].verdict, 'no relationship',
    'the same p-value is not a finding when four tests had a go at it');
  assert.match(crowd.results[0].why, /one of them looking real is what chance does/);
});

test('refusals do not count toward the test budget', () => {
  const { tests } = judge([
    { individual: 'A', factor: 'moon', p: 0.01, direction: 'bright moons', why: 'x' },
    { individual: 'B', factor: 'moon', p: null, verdict: 'not enough sightings', why: 'y' },
  ]);
  assert.equal(tests, 1, 'a buck with four pictures did not have a go at anything');
});

// ---------------------------------------------------------------------------
// Determinism, because a p-value that moves when you reload is not a p-value
// ---------------------------------------------------------------------------

test('the same data gives the same p-value every time', () => {
  const s = inBand('dusk').slice(0, 20);
  const a = individualFactor({ name: 'X', sightings: s, pool, factor: 'moon', seed: 7 });
  const b = individualFactor({ name: 'X', sightings: s, pool, factor: 'moon', seed: 7 });
  assert.equal(a.p, b.p);
});

test('a stratum with too little to draw from refuses rather than guessing', () => {
  const observed = Array.from({ length: 12 }, () => ({ stratum: 'thin', value: 1 }));
  const thin = [{ stratum: 'thin', value: 1 }, { stratum: 'thin', value: 2 }];
  assert.equal(stratifiedTest({ observed, pool: thin }), null);
});

test('both factors, and only the two that were asked for', () => {
  // Not a fishing expedition: every factor added makes every other factor's
  // finding weaker, and that trade is made deliberately or not at all.
  assert.deepEqual(Object.keys(FACTORS).sort(), ['moon', 'pressure']);
});
