/**
 * The number, and everything it refuses to say.
 *
 * Each test below pins one of the five constraints settled in the 2026-08-31
 * interview. They are not implementation details — they are the difference
 * between a figure worth planning a morning around and one that flatters
 * whatever you already believed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimate, estimateLine, wilson, MIN_LIVE_DAYS, Z95,
} from '../estimate.mjs';
import { MIN_HOURS } from '../evidence.mjs';

// The invented cluster. Wisconsin-ish longitude, so solar day and UTC day
// differ by about six hours — which is the whole point of several of these.
const LAT = 44.12, LNG = -90.65;

const day = n => '2026-09-' + String(n).padStart(2, '0');
const liveRun = n => Array.from({ length: n }, (_, i) => ({ day: day(i + 1), state: 'live' }));
/** A dawn visit on day n. 11:30 UTC is about 05:30 solar at this longitude. */
const dawnVisit = n => ({ startedAt: day(n) + 'T11:30:00Z' });

// ---------------------------------------------------------------------------
// The interval
// ---------------------------------------------------------------------------

test('Wilson keeps its bounds inside 0 and 1 where the textbook one does not', () => {
  // 3 of 3 is where the normal approximation returns [1, 1] and tells you a
  // three-day streak is a certainty.
  const all = wilson(3, 3);
  assert.equal(all.point, 1);
  assert.ok(all.lo > 0.4 && all.lo < 0.5, `lower bound ${all.lo} is honest about n=3`);
  assert.equal(all.hi, 1);

  const none = wilson(0, 10);
  assert.equal(none.point, 0);
  assert.equal(none.lo, 0);
  assert.ok(none.hi > 0.2, 'never seeing it in ten days does not prove it never happens');
});

test('nine of ten is 90 per cent and an interval two-fifths of the scale wide', () => {
  const w = wilson(9, 10);
  assert.equal(Math.round(w.point * 100), 90);
  assert.equal(Math.round(w.lo * 100), 60);
  assert.equal(Math.round(w.hi * 100), 98);
});

test('the interval narrows as the sample grows, on the same proportion', () => {
  const small = wilson(9, 10), big = wilson(90, 100);
  assert.equal(Math.round(small.point * 100), Math.round(big.point * 100));
  assert.ok((big.hi - big.lo) < (small.hi - small.lo) / 2, 'ten times the days, far tighter');
});

test('nonsense counts get no interval rather than a NaN', () => {
  for (const [k, n] of [[1, 0], [-1, 5], [6, 5], [NaN, 5], [1, NaN]]) {
    assert.equal(wilson(k, n), null, `${k}/${n}`);
  }
});

// ---------------------------------------------------------------------------
// Constraint 5: the denominator is camera-live days
// ---------------------------------------------------------------------------

test('quota-dark and silent days are excluded, not counted as deer-free', () => {
  // The inflation this whole feature was built to avoid. Twelve calendar days,
  // ten of them usable; a deer on nine. Counting the dark days would make it
  // 9 of 12 = 75% and would be wrong in the direction that reads as caution.
  const days = [...liveRun(10),
    { day: day(11), state: 'quota-dark' },
    { day: day(12), state: 'silent' }];
  const visits = Array.from({ length: 9 }, (_, i) => dawnVisit(i + 1));

  const e = estimate({ days, visits, band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(12) });
  assert.equal(e.live, 10, 'ten usable days, not twelve');
  assert.equal(e.seen, 9);
  assert.equal(Math.round(e.point * 100), 90);
  assert.equal(e.excluded.quotaDark, 1);
  assert.equal(e.excluded.silent, 1);
});

test('a day never recorded is unknown and also excluded', () => {
  // The sync did not run. That is not evidence of an empty trail.
  const days = liveRun(10);           // days 1..10 recorded
  const visits = Array.from({ length: 9 }, (_, i) => dawnVisit(i + 1));
  const e = estimate({ days, visits, band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(14) });     // asked about 14
  assert.equal(e.span, 14);
  assert.equal(e.live, 10);
  assert.equal(e.excluded.unknown, 4);
});

test('a sighting on an unusable day is counted apart, never in the numerator', () => {
  // It really happened, and there is no denominator it belongs to.
  const days = [...liveRun(10), { day: day(11), state: 'quota-dark' }];
  const visits = [...Array.from({ length: 9 }, (_, i) => dawnVisit(i + 1)), dawnVisit(11)];
  const e = estimate({ days, visits, band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(11) });
  assert.equal(e.seen, 9, 'the quota-dark sighting does not inflate the numerator');
  assert.equal(e.excluded.sightingsOnUnusableDays, 1, 'but it is not silently dropped');
});

test('two visits on one day are one day seen, not two', () => {
  const days = liveRun(10);
  const visits = [dawnVisit(1), { startedAt: day(1) + 'T11:45:00Z' }, dawnVisit(2)];
  const e = estimate({ days, visits, band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(10) });
  assert.equal(e.seen, 2);
});

// ---------------------------------------------------------------------------
// Constraint 4: the sun sets the bins, and nobody sets the sun
// ---------------------------------------------------------------------------

test('a dawn visit does not count toward dusk', () => {
  const days = liveRun(10);
  const visits = Array.from({ length: 9 }, (_, i) => dawnVisit(i + 1));
  const dusk = estimate({ days, visits, band: 'dusk', lat: LAT, lng: LNG,
    from: day(1), to: day(10) });
  assert.equal(dusk.seen, 0, 'none of these were at dusk');
  assert.equal(dusk.live, 10, 'but the denominator is unchanged');
});

test('an evening visit belongs to the evening, not to the next morning', () => {
  // 01:30 UTC is about 19:30 the previous day at this longitude. Filed under
  // the UTC date it would land on tomorrow, and every dusk sighting in the
  // account would be counted against the wrong day.
  const days = liveRun(10);
  const evening = { startedAt: '2026-09-06T01:30:00Z' };  // solar 2026-09-05
  const e = estimate({ days, visits: [evening], band: 'dusk', lat: LAT, lng: LNG,
    from: day(1), to: day(10) });
  assert.equal(e.seen, 1, 'it landed on a live day');
});

test('there is no window parameter to widen', () => {
  // Constraint 4, made structural: the only knob estimate() takes about time is
  // WHICH band, never how wide one is.
  const args = estimate.toString().slice(0, estimate.toString().indexOf(')'));
  for (const f of ['window', 'tolerance', 'plusMinus', 'widthMin', 'binMinutes']) {
    assert.ok(!args.includes(f), `no ${f} parameter`);
  }
});

// ---------------------------------------------------------------------------
// Constraint 1 and the refusal
// ---------------------------------------------------------------------------

test('below the minimum it refuses, and still shows the counts', () => {
  // Kent's real sample on the day this was written: three days of photographs.
  const days = liveRun(3);
  const visits = [dawnVisit(1), dawnVisit(2), dawnVisit(3)];
  const e = estimate({ days, visits, band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(3) });

  assert.equal(e.point, null, 'no estimate');
  assert.equal(e.lo, null);
  assert.equal(e.hi, null);
  assert.match(e.refused, /3 camera-live days of 10 needed/);
  assert.equal(e.seen, 3, 'the counts are still reported');
  assert.equal(e.live, 3);
  assert.match(estimateLine(e), /NOT RANKED/);
  assert.ok(!/100%/.test(estimateLine(e)), 'and 3 of 3 never prints as 100%');
});

test('the refusal threshold is the one the rest of the program already uses', () => {
  assert.equal(MIN_LIVE_DAYS, MIN_HOURS,
    'one standard for what this program will claim, not two');
});

test('the point estimate is never rendered without its interval', () => {
  // Constraint 1, made structural. There is no formatter that prints one half.
  const days = liveRun(10);
  const visits = Array.from({ length: 9 }, (_, i) => dawnVisit(i + 1));
  const line = estimateLine(estimate({ days, visits, band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(10) }));
  assert.match(line, /90%/);
  assert.match(line, /60–98% at 95%/);
});

test('the output carries the caveat the interval cannot express', () => {
  // Wilson assumes independent trials. Ten days of one deer are one food
  // source mildly perturbed, so the true uncertainty is wider than printed.
  const e = estimate({ days: liveRun(10), visits: [], band: 'dawn', lat: LAT, lng: LNG,
    from: day(1), to: day(10) });
  assert.match(e.caveat, /not independent/);
  assert.match(e.caveat, /wider/);
});

// ---------------------------------------------------------------------------
// Constraints 2 and 3: what it claims to be about
// ---------------------------------------------------------------------------

test('the subject is the site, not an individual', () => {
  const e = estimate({ days: liveRun(10), visits: [dawnVisit(1)], band: 'dawn',
    lat: LAT, lng: LNG, from: day(1), to: day(10) });
  assert.equal(e.subject, 'any deer');
  assert.match(estimateLine(e), /^any deer/);
});

test('nothing in the output mentions a stand or a sighting', () => {
  // Constraint 2. The number is about this camera. The metres between it and
  // a seat are the caller's to name and nobody's to price.
  const e = estimate({ days: liveRun(10), visits: [dawnVisit(1)], band: 'dawn',
    lat: LAT, lng: LNG, from: day(1), to: day(10) });
  const text = JSON.stringify(e) + ' ' + estimateLine(e);
  // "seen on N of M camera-live days" is the claim; anything implying a stand,
  // a shot, or a sighting BY somebody is not.
  for (const phrase of [/\bstand\b/i, /\byou\b/i, /\bshot\b/i, /probability of seeing/i]) {
    assert.ok(!phrase.test(text), `the output does not say ${phrase}`);
  }
  assert.match(estimateLine(e), /camera-live days/, 'it says what it counted');
});

test('an empty account produces a refusal, not a zero', () => {
  const e = estimate({});
  assert.equal(e.live, 0);
  assert.equal(e.point, null);
  assert.match(e.refused, /0 camera-live days/);
});
