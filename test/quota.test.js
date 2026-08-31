import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaOf, quotaLine, WARN_AT, PROJECTION_FLOOR_DAYS } from '../quota.mjs';
import { cameraSummary, healthOf } from '../spypoint-sync.mjs';
import { FLEX_M, LEGACY_SHAPE } from '../fixtures/cameras.js';

// A 30-day cycle, so "day N" arithmetic in the tests below is readable.
const CYCLE_START = '2026-06-01T00:00:00.000Z';
const CYCLE_END = '2026-06-30T23:59:59.999Z';
const day = n => Date.parse(CYCLE_START) + n * 86400000;

const cam = over => ({
  plan: 'Free',
  photoCount: 0,
  photoLimit: 100,
  cycleStart: CYCLE_START,
  cycleEnd: CYCLE_END,
  ...over,
});

// ---------------------------------------------------------------------------
// The counts themselves
// ---------------------------------------------------------------------------

test('a camera inside its allowance, spending it slowly, is ok', () => {
  // 28 photos over 20 days is 1.4/day; the remaining 72 would take another 51
  // days and the cycle has 9 whole ones left. Nothing to say beyond the rate.
  //
  // daysLeft counts WHOLE days and floors: on the last day of a cycle it reads
  // 0, which is how a countdown is read. It never rounds up, so it cannot
  // promise time the cycle does not have.
  const q = quotaOf(cam({ photoCount: 28 }), day(20));
  assert.equal(q.level, 'ok');
  assert.equal(q.remaining, 72);
  assert.equal(q.daysLeft, 9);
  assert.ok(Math.abs(q.perDay - 1.4) < 1e-9);
  assert.match(q.note, /lasts the cycle/);
});

test('a spent allowance is bad, and says how long until it resets', () => {
  const q = quotaOf(cam({ photoCount: 100 }), day(8));
  assert.equal(q.level, 'bad');
  assert.equal(q.remaining, 0);
  assert.equal(q.pct, 1);
  assert.match(q.note, /quota spent, 21 days left in cycle/);
});

test('a camera reported over its own limit does not go negative', () => {
  // Seen on a real account after a plan change mid-cycle. The bar must not
  // draw past full and the allowance must not read as -37 photos left.
  const q = quotaOf(cam({ photoCount: 137 }), day(8));
  assert.equal(q.remaining, 0);
  assert.equal(q.pct, 1);
  assert.equal(q.level, 'bad');
});

test('crossing the percentage threshold warns, and names what is left', () => {
  const q = quotaOf(cam({ photoCount: Math.ceil(WARN_AT * 100) }), day(24));
  assert.equal(q.level, 'warn');
  assert.match(q.note, /only 20 photos left, 5 days of cycle to go/);
});

test('one photo below the threshold is still ok', () => {
  const q = quotaOf(cam({ photoCount: WARN_AT * 100 - 1 }), day(24));
  assert.equal(q.level, 'ok');
});

// ---------------------------------------------------------------------------
// The burn rate — the half that sees it coming
// ---------------------------------------------------------------------------

test('a fast burner warns well before the percentage would', () => {
  // 51/100 spent in 8 days: only halfway through the allowance, so the
  // percentage rule says nothing. At 6.4/day the other 49 last 7.7 more days
  // and the cycle has 21 to run. This is the case the alarm exists for.
  const q = quotaOf(cam({ photoCount: 51 }), day(8));
  assert.ok(q.pct < WARN_AT, 'below the percentage threshold');
  assert.equal(q.level, 'warn');
  assert.ok(Math.abs(q.perDay - 6.375) < 1e-9);
  assert.equal(q.dryOn, '2026-06-16');
  assert.equal(q.daysEarly, 13);
  assert.match(q.note, /6.4\/day/);
});

test('the projection is suppressed in the last days of a cycle', () => {
  // Two days from the reset, "dry in one day" and "the cycle ends tomorrow"
  // are the same sentence, and only one of them is worth printing.
  const q = quotaOf(cam({ photoCount: 60 }), day(29));
  assert.ok(q.daysLeft <= PROJECTION_FLOOR_DAYS);
  assert.equal(q.level, 'ok');
  assert.match(q.note, /lasts the cycle/);
});

test('one busy morning on day zero does not predict catastrophe', () => {
  // Six hours in, four photos. Dividing by a quarter of a day gives 16/day and
  // a confident prediction of running dry on the 7th. There is not enough
  // history to divide by yet, so no rate is offered at all.
  const q = quotaOf(cam({ photoCount: 4 }), day(0.25));
  assert.equal(q.level, 'ok');
  assert.equal(q.perDay, null);
  assert.equal(q.dryOn, null);
  assert.equal(q.note, null);
});

// ---------------------------------------------------------------------------
// Absent or unmetered data must never alarm
// ---------------------------------------------------------------------------

test('an unlimited plan is ok, not zero of zero', () => {
  for (const limit of [0, null, undefined]) {
    const q = quotaOf(cam({ plan: 'Unlimited', photoCount: 4200, photoLimit: limit }), day(8));
    assert.equal(q.level, 'ok', `photoLimit ${limit}`);
    assert.equal(q.limit, null);
    assert.equal(q.note, null);
    assert.equal(quotaLine(q), null);
  }
});

test('a camera with no quota fields at all is ok and silent', () => {
  const q = quotaOf({ name: 'nothing known' }, day(8));
  assert.equal(q.level, 'ok');
  assert.equal(q.used, null);
  assert.equal(q.limit, null);
  assert.equal(q.note, null);
});

test('counts without cycle dates still measure, but never project', () => {
  const q = quotaOf({ plan: 'Free', photoCount: 90, photoLimit: 100 }, day(8));
  assert.equal(q.level, 'warn');       // the percentage rule still applies
  assert.equal(q.perDay, null);        // nothing to divide by
  assert.equal(q.dryOn, null);
  assert.equal(q.daysLeft, null);
  assert.match(q.note, /only 10 photos left$/); // no cycle clause invented
});

test('unparseable cycle dates are treated as absent, not as 1970', () => {
  const q = quotaOf(cam({ photoCount: 50, cycleStart: 'soon', cycleEnd: 'later' }), day(8));
  assert.equal(q.perDay, null);
  assert.equal(q.daysLeft, null);
  assert.equal(q.level, 'ok');
});

// ---------------------------------------------------------------------------
// The line, and the wiring into camera health
// ---------------------------------------------------------------------------

test('quotaLine draws a bar proportional to what is spent', () => {
  assert.match(quotaLine(quotaOf(cam({ photoCount: 0 }), day(8))), /^\[----------\] 0\/100/);
  assert.match(quotaLine(quotaOf(cam({ photoCount: 50 }), day(8))), /^\[#####-----\] 50\/100/);
  assert.match(quotaLine(quotaOf(cam({ photoCount: 100 }), day(8))), /^\[##########\] 100\/100/);
});

test('the provider carries the billing cycle through', () => {
  const r = cameraSummary(FLEX_M);
  assert.equal(r.cycleStart, '2025-11-01T00:00:00.000Z');
  assert.equal(r.cycleEnd, '2025-11-30T23:59:59.999Z');
  assert.equal(r.photoLimit, 100);
});

test('a camera model with no subscription block yields nulls, not a false limit', () => {
  const r = cameraSummary(LEGACY_SHAPE);
  assert.equal(r.cycleStart, null);
  assert.equal(r.cycleEnd, null);
  assert.equal(quotaOf(r).level, 'ok');
});

test('a spent quota shows up in camera health, beside the battery', () => {
  // The point of folding it in: the card, the map pin and the alert list all
  // read health.level, so a camera that has stopped transmitting turns red in
  // all three without any of them knowing what a quota is.
  // healthOf ages lastSeen against the real clock, so the camera has to have
  // reported just now for the staleness rule to stay out of the way.
  const justNow = new Date().toISOString();
  const healthy = healthOf({ lastSeen: justNow, battery: 90,
    ...cam({ photoCount: 10 }) }, day(8));
  assert.equal(healthy.level, 'ok');

  const dry = healthOf({ lastSeen: justNow, battery: 90,
    ...cam({ photoCount: 100 }) }, day(8));
  assert.equal(dry.level, 'bad');
  assert.ok(dry.notes.some(n => /quota spent/.test(n)), dry.notes.join(' | '));
  assert.equal(dry.quota.remaining, 0);
});

test('a quota warning does not overwrite a worse battery verdict', () => {
  const both = healthOf({ lastSeen: new Date().toISOString(), battery: 5,
    ...cam({ photoCount: 85 }) }, day(24));
  assert.equal(both.level, 'bad');            // the battery, not the quota
  assert.equal(both.quota.level, 'warn');
  assert.ok(both.notes.some(n => /battery 5%/.test(n)));
  assert.ok(both.notes.some(n => /only 15 photos left/.test(n)));
});
