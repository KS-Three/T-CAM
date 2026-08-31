import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pressureAt, foodAt, ringCentre, RECOVERY_DAYS, MAX_PRESSURE_PENALTY,
  PRESSURE_WINDOW_DAYS, FIELD_REACH_M, FRESH_CUT_DAYS,
} from '../stand-context.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();
const STAND = { id: 1, name: 'Creek', lat: 44.12, lng: -90.65 };
const sit = (standId, d) => ({ stand_id: standId, ended_at: daysAgo(d), date: daysAgo(d).slice(0, 10) });

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

test('a stand with no logged sits is unknown, not unpressured', () => {
  // The distinction the whole program is built on. A blank must never read as
  // a zero, or every stand you forgot to log becomes evidence of a fresh one.
  const p = pressureAt(STAND, [], { now: NOW });
  assert.equal(p.points, 0);
  assert.equal(p.known, false);
  assert.match(p.why, /unknown, not zero/);
});

test('hunting a stand hard costs it, and cites what was measured', () => {
  const p = pressureAt(STAND, [sit(1, 0.5), sit(1, 1.5), sit(1, 3)], { now: NOW });
  assert.equal(p.points, -MAX_PRESSURE_PENALTY);
  assert.equal(p.known, true);
  assert.match(p.why, /62%/, 'the number it rests on is in the reason');
});

test('a walked-on stand says so in a sentence, not just in points', () => {
  // Kent's call, 2026-08-30: what he wants from this is to be TOLD the ground
  // has been walked recently and make the judgement himself, not to have a
  // stand quietly demoted out of the running. So the note is the real output
  // and the points are a nudge.
  const hard = pressureAt(STAND, [sit(1, 0.5), sit(1, 1.5), sit(1, 3)], { now: NOW });
  const light = pressureAt(STAND, [sit(1, 2)], { now: NOW });
  const fresh = pressureAt(STAND, [], { now: NOW });

  assert.equal(hard.note, 'This area has experienced recent pressure.');
  assert.equal(light.note, 'This area has experienced recent pressure.',
    'even one recent sit is worth mentioning');
  assert.equal(fresh.note, null, 'and an unhunted stand says nothing');
  assert.ok(Math.abs(hard.points) <= 6, 'the penalty is a nudge now, not a demotion');
});

test('a stand settles faster than the literature average', () => {
  // The collar figure is four or five days, from Mississippi and Oklahoma
  // hunting cultures with very different access patterns. Kent says shorter on
  // his ground, and he has better information about his ground than they do.
  assert.equal(RECOVERY_DAYS, 3);
  const weekAgo = pressureAt(STAND, [sit(1, 7)], { now: NOW });
  assert.equal(weekAgo.points, 0, 'last weekend no longer counts against you');
  assert.equal(weekAgo.note, null);
});

test('pressure decays, so an old sit is not held against a stand', () => {
  const fresh = pressureAt(STAND, [sit(1, 0)], { now: NOW });
  const stale = pressureAt(STAND, [sit(1, 12)], { now: NOW });
  assert.ok(fresh.points < 0, 'sat today is a penalty');
  assert.ok(stale.points >= fresh.points, 'a fortnight ago is not');
  assert.ok(stale.burn < fresh.burn / 4, `decay over ${RECOVERY_DAYS}-day constant`);
});

test('sits beyond the window are dropped entirely', () => {
  const p = pressureAt(STAND, [sit(1, PRESSURE_WINDOW_DAYS + 5)], { now: NOW });
  assert.equal(p.sits, 0, 'not counted');
  assert.equal(p.known, true, 'but the stand is still one you have hunted');
});

test('a rested stand is worth a little extra, and says how long', () => {
  const p = pressureAt(STAND, [sit(1, 16)], { now: NOW });
  assert.ok(p.points > 0);
  assert.match(p.why, /rested/);
});

test('another stand’s sits do not burn this one', () => {
  const p = pressureAt(STAND, [sit(2, 0), sit(2, 1), sit(2, 2)], { now: NOW });
  assert.equal(p.points, 0);
  assert.equal(p.known, false);
});

test('a sit logged in the future is ignored rather than counted backwards', () => {
  const p = pressureAt(STAND, [{ stand_id: 1, ended_at: daysAgo(-3) }], { now: NOW });
  assert.equal(p.sits, 0);
});

test('pressure can never outweigh the wind', () => {
  const p = pressureAt(STAND, Array.from({ length: 12 }, (_, i) => sit(1, i * 0.2)), { now: NOW });
  assert.ok(Math.abs(p.points) <= MAX_PRESSURE_PENALTY);
  assert.ok(MAX_PRESSURE_PENALTY < 40, 'a wrong wind is -40 and must stay the veto');
});

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

// [lng, lat], because that is what db.mjs stores and hands back — the order
// this got wrong the first time.
const ring = (lat, lng, d = 0.001) => [
  [lng - d, lat - d], [lng - d, lat + d], [lng + d, lat + d], [lng + d, lat - d],
];
const field = (crop, over = {}) => ({
  crop, name: over.name ?? crop, points: ring(44.12, -90.65), cutAt: null, ...over,
});
const DATE = new Date('2026-11-07T12:00:00Z');

test('a centroid reads [lng, lat], the order the database stores', () => {
  const c = ringCentre(ring(44.12, -90.65));
  assert.ok(Math.abs(c.lat - 44.12) < 1e-9);
  assert.ok(Math.abs(c.lng - -90.65) < 1e-9);
  assert.equal(ringCentre([]), null);
  assert.equal(ringCentre(null), null);
  // The object form is still accepted, because the map hands one shape and the
  // store another and both reach this function.
  const o = ringCentre([{ lat: 44.12, lng: -90.65 }, { lat: 44.12, lng: -90.65 }]);
  assert.ok(Math.abs(o.lat - 44.12) < 1e-9);
  // And getting the order wrong must not quietly produce a plausible point.
  const wrong = ringCentre([[44.12, -90.65], [44.12, -90.65]]);
  assert.ok(Math.abs(wrong.lat - 44.12) > 100, 'swapped input lands nowhere near');
});

test('no mapped field is an instruction, not a penalty', () => {
  const f = foodAt(STAND, [], { date: DATE });
  assert.equal(f.points, 0);
  assert.match(f.why, /draw your fields/);
});

test('a field out of reach is not the reason deer are here', () => {
  const far = field('corn', { points: ring(44.30, -90.65), cutAt: '2026-11-01' });
  assert.equal(foodAt(STAND, [far], { date: DATE }).fields.length, 0);
  assert.ok(FIELD_REACH_M <= 400);
});

test('corn cut inside the last three weeks pulls hard', () => {
  const f = foodAt(STAND, [field('corn', { cutAt: '2026-11-01' })], { date: DATE });
  assert.ok(f.points > 0);
  assert.match(f.why, /waste grain/);
});

test('corn cut long ago has been eaten', () => {
  const f = foodAt(STAND, [field('corn', { cutAt: '2026-08-01' })], { date: DATE });
  assert.equal(f.points, 0);
  assert.ok(FRESH_CUT_DAYS <= 30);
});

test('standing corn holds deer inside it rather than moving them past you', () => {
  const f = foodAt(STAND, [field('corn')], { date: DATE });
  assert.ok(f.points < 0);
  assert.match(f.why, /still standing/);
  assert.match(f.why, /food, bed and cover at once/);
});

test('brassicas come into their own after frost', () => {
  const nov = foodAt(STAND, [field('brassicas')], { date: DATE });
  const sep = foodAt(STAND, [field('brassicas')], { date: new Date('2026-09-07T12:00:00Z') });
  assert.ok(nov.points > sep.points, 'the same plot is worth more in November');
  assert.match(nov.why, /frost/);
});

test('freshly cut alfalfa is the best thing in the field', () => {
  const f = foodAt(STAND, [field('alfalfa', { cutAt: '2026-10-25' })], { date: DATE });
  assert.ok(f.points > 0);
  assert.match(f.why, /regrowth/);
});

test('food is a nudge, never a veto', () => {
  const many = Array.from({ length: 6 }, () => field('corn', { cutAt: '2026-11-05' }));
  const f = foodAt(STAND, many, { date: DATE });
  assert.ok(f.points <= 8, `capped, got ${f.points}`);
  assert.ok(f.points < 30, 'a wind the stand suits is +30 and must stay bigger');
});
