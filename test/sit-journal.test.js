/**
 * The journal's statistics, and mostly its refusals.
 *
 * The failure this file exists to prevent is the tool marking its own homework:
 * a season of sits taken only on the days it called prime, scored as evidence
 * that it was right. Most of these tests check that it declines to answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand, logSit, updateSit, deleteSit, allSits, sitById } from '../db.mjs';
import {
  calibration, spearman, ranks, permutationP, windAccuracy, standPerformance,
  summary, usableSits, MIN_SITS, MIN_PER_BUCKET, mulberry32,
} from '../sit-journal.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-sits-'));

const sit = (rating, deer, extra = {}) => ({
  date: '2026-11-07', window: 'PM',
  predicted: { rating, score: 50, windFrom: 'NW' },
  deer, ...extra,
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('a sit records what happened and what was predicted beforehand', () => {
  const db = openDb(tmp());
  const stand = createStand(db, { name: 'Creek ladder', lat: 44.12, lng: -90.65 });
  const s = logSit(db, {
    standId: stand.id, date: '2026-11-07', window: 'PM',
    startedAt: '2026-11-07T19:00:00Z', endedAt: '2026-11-07T23:00:00Z',
    predicted: { score: 52, rating: 'prime', windFrom: 'NW', temp: 33 },
    windFrom: 'NNW', temp: 31, deer: 4, bucks: 1, does: 3, shot: true, notes: 'came off the point',
  });
  assert.equal(s.stand_name, 'Creek ladder');
  assert.equal(s.predicted.rating, 'prime');
  assert.equal(s.wind_from, 'NNW', 'what the wind actually did is its own field');
  assert.equal(s.deer, 4);
  assert.equal(s.shot, true);
  assert.equal(s.harvested, false);
  db.close();
});

test('"saw nothing" and "did not count" stay different', () => {
  // The distinction the whole analysis rests on. A blank must never become a
  // zero, or every sit you forgot to fill in is evidence of no deer.
  const db = openDb(tmp());
  logSit(db, { date: '2026-11-07', window: 'AM', deer: 0 });
  logSit(db, { date: '2026-11-08', window: 'AM' });
  const [later, earlier] = allSits(db);
  assert.equal(later.deer, null, 'not counted stays null');
  assert.equal(earlier.deer, 0, 'saw nothing is a zero');
  const sum = summary(allSits(db));
  assert.equal(sum.sits, 2);
  assert.equal(sum.counted, 1);
  assert.equal(sum.uncounted, 1);
  assert.equal(sum.deerPerSit, 0, 'the blank is not averaged in');
  db.close();
});

test('a bad date or window is refused rather than stored', () => {
  const db = openDb(tmp());
  assert.throws(() => logSit(db, { date: 'yesterday', window: 'PM' }), /YYYY-MM-DD/);
  assert.throws(() => logSit(db, { date: '2026-11-07', window: 'evening' }), /window must be/);
  assert.throws(() => logSit(db, { date: '2026-11-07', window: 'PM', standId: 99 }), /no stand with id/);
  assert.equal(allSits(db).length, 0);
  db.close();
});

test('the prediction cannot be edited after the fact', () => {
  // Otherwise the table stops being evidence and becomes a story.
  const db = openDb(tmp());
  const s = logSit(db, { date: '2026-11-07', window: 'PM', predicted: { rating: 'poor', score: 12 }, deer: 0 });
  const after = updateSit(db, s.id, {
    deer: 5, notes: 'actually good', predicted: { rating: 'prime' }, predicted_rating: 'prime',
  });
  assert.equal(after.deer, 5, 'what happened is editable');
  assert.equal(after.predicted.rating, 'poor', 'what was predicted is not');
  db.close();
});

test('a sit can be corrected and removed', () => {
  const db = openDb(tmp());
  const s = logSit(db, { date: '2026-11-07', window: 'PM', deer: 1 });
  assert.equal(updateSit(db, s.id, { deer: 3, notes: 'recount' }).deer, 3);
  assert.equal(updateSit(db, s.id, { deer: '' }).deer, null, 'blanking is allowed');
  assert.equal(deleteSit(db, s.id), true);
  assert.equal(sitById(db, s.id), null);
  assert.equal(deleteSit(db, s.id), false);
  db.close();
});

// ---------------------------------------------------------------------------
// The statistics
// ---------------------------------------------------------------------------

test('ranks average their ties, because ratings tie constantly', () => {
  assert.deepEqual(ranks([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(ranks([5, 5, 9]), [1.5, 1.5, 3]);
  assert.deepEqual(ranks([7, 7, 7]), [2, 2, 2]);
});

test('spearman finds a monotone relationship and ignores its shape', () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(spearman(xs, [1, 2, 3, 4, 5]), 1);
  assert.equal(spearman(xs, [2, 4, 8, 16, 32]), 1, 'rank-based, so a curve is still 1');
  assert.equal(spearman(xs, [5, 4, 3, 2, 1]), -1);
  assert.equal(spearman(xs, [3, 3, 3, 3, 3]), null, 'no variation is not a correlation of zero');
  assert.equal(spearman([1, 2], [1, 2]), null, 'too few points to say anything');
});

test('the shuffle test is deterministic and never reports p = 0', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const ys = xs.slice();
  const a = permutationP(xs, ys, { iterations: 2000, seed: 7 });
  const b = permutationP(xs, ys, { iterations: 2000, seed: 7 });
  assert.equal(a, b, 'the same seed gives the same answer every time');
  assert.ok(a > 0, 'a p-value of exactly zero is never true');
  assert.ok(a < 0.01, 'a perfect correlation on twelve points is still surprising');
  const rnd = mulberry32(3);
  assert.ok(rnd() >= 0 && rnd() < 1);
});

test('with a handful of sits it refuses to report a correlation', () => {
  const sits = [sit('prime', 4), sit('poor', 0), sit('good', 2)];
  const c = calibration(sits);
  assert.equal(c.rho, null);
  assert.equal(c.verdict, 'not enough sits');
  assert.match(c.why, new RegExp(String(MIN_SITS)));
  assert.match(c.why, /noise with a decimal point/);
});

test('hunting only the good days is reported as having no comparison group', () => {
  // The serious confound. Twenty prime evenings is plenty of data and answers
  // nothing, and the tool must not score itself right on it.
  const sits = Array.from({ length: 20 }, (_, i) => sit('prime', i % 4));
  const c = calibration(sits);
  assert.equal(c.usable, 20, 'the sits are usable');
  assert.equal(c.rho, null, 'and it still refuses');
  assert.equal(c.verdict, 'no comparison group');
  assert.match(c.why, /only really hunted one class of day/);
  assert.equal(c.spread, 1);
});

test('one mediocre sit among twenty prime ones is still not a comparison group', () => {
  const sits = [...Array.from({ length: 19 }, () => sit('prime', 3)), sit('poor', 0)];
  const c = calibration(sits);
  assert.equal(c.verdict, 'no comparison group', `needs ${MIN_PER_BUCKET} in each bucket`);
});

test('given a real spread and a real signal, it says so with a p-value', () => {
  const sits = [];
  for (const [rating, counts] of [['poor', [0, 0, 1, 0]], ['fair', [1, 0, 2, 1]],
                                  ['good', [2, 3, 2, 4]], ['prime', [5, 4, 6, 5]]]) {
    for (const d of counts) sits.push(sit(rating, d));
  }
  const c = calibration(sits, { iterations: 3000 });
  assert.equal(c.usable, 16);
  assert.ok(c.spread >= 2);
  assert.ok(c.rho > 0.6, `expected a strong positive rho, got ${c.rho}`);
  assert.ok(c.p <= 0.05, `expected a small p, got ${c.p}`);
  assert.match(c.verdict, /strong relationship/);
  assert.match(c.why, /shuffle test/);
});

test('a rating that runs BACKWARDS is called that, not smoothed over', () => {
  const sits = [];
  for (const [rating, counts] of [['poor', [5, 6, 4, 5]], ['fair', [3, 4, 3, 2]],
                                  ['good', [1, 2, 1, 1]], ['prime', [0, 0, 1, 0]]]) {
    for (const d of counts) sits.push(sit(rating, d));
  }
  const c = calibration(sits, { iterations: 3000 });
  assert.ok(c.rho < -0.6);
  assert.match(c.why, /BACKWARDS/);
});

test('noise is reported as not distinguishable from chance', () => {
  const sits = [];
  const rnd = mulberry32(42);
  for (const rating of ['poor', 'fair', 'good', 'prime']) {
    for (let i = 0; i < 4; i++) sits.push(sit(rating, Math.floor(rnd() * 5)));
  }
  const c = calibration(sits, { iterations: 3000 });
  assert.ok(c.p > 0.05, `random data should not be significant, p was ${c.p}`);
  assert.equal(c.verdict, 'not distinguishable from chance');
});

test('the selection caveat is attached to every answer it does give', () => {
  const sits = [];
  for (const [rating, counts] of [['poor', [0, 0, 1, 0]], ['fair', [1, 0, 2, 1]],
                                  ['good', [2, 3, 2, 4]], ['prime', [5, 4, 6, 5]]]) {
    for (const d of counts) sits.push(sit(rating, d));
  }
  const c = calibration(sits, { iterations: 1000 });
  assert.match(c.caveat, /You choose which days to hunt/);
  assert.match(c.caveat, /not an experiment/);
});

test('uncounted sits are excluded from the correlation and counted separately', () => {
  const sits = [sit('prime', 4), sit('poor', 0), { ...sit('good', null) }];
  assert.equal(usableSits(sits).length, 2);
  assert.equal(calibration(sits).uncounted, 1);
});

test('forecast wind accuracy needs no deer at all', () => {
  const s = (pred, actual) => ({
    date: '2026-11-07', window: 'PM',
    predicted: { windFrom: pred }, wind_from: actual,
  });
  const w = windAccuracy([s('NW', 'NW'), s('NW', 'NNW'), s('S', 'N'), s('W', 'W')]);
  assert.equal(w.sits, 4);
  assert.equal(w.exact, 50);
  assert.equal(w.close, 75, 'one point either side counts as close');
  assert.match(w.why, /exact compass point 50%/);
  assert.equal(windAccuracy([]).exact, null);
});

test('stand averages carry their sample size and say when it is too small', () => {
  const rows = [
    { stand_id: 1, stand_name: 'Creek', deer: 4, bucks: 1 },
    { stand_id: 1, stand_name: 'Creek', deer: 2, bucks: 0 },
    { stand_id: 2, stand_name: 'East', deer: 0, bucks: 0 },
  ];
  const p = standPerformance(rows);
  assert.equal(p.stands[0].name, 'Creek');
  assert.equal(p.stands[0].deerPerSit, 3);
  assert.equal(p.stands[0].enough, false, 'two sits is not enough to rank a stand');
  assert.match(p.note, /means much/);
});

test('the totals hold up with times, blanks and a harvest', () => {
  const rows = [
    { deer: 3, bucks: 1, shot: true, harvested: true,
      started_at: '2026-11-07T19:00:00Z', ended_at: '2026-11-07T23:00:00Z' },
    { deer: 0, bucks: 0, shot: false, harvested: false,
      started_at: '2026-11-08T11:00:00Z', ended_at: '2026-11-08T15:00:00Z' },
    { deer: null, bucks: null, shot: false, harvested: false },
  ];
  const s = summary(rows);
  assert.equal(s.sits, 3);
  assert.equal(s.counted, 2);
  assert.equal(s.uncounted, 1);
  assert.equal(s.hours, 8);
  assert.equal(s.deer, 3);
  assert.equal(s.deerPerSit, 1.5);
  assert.equal(s.deerPerHour, 0.38);
  assert.equal(s.blankSits, 1, 'one sit where nothing was seen');
  assert.equal(s.harvests, 1);
});

test('a p-value is never reported as exactly zero', () => {
  // The shuffle test can only bound p from below: with N shuffles the smallest
  // it can ever produce is 1/(N+1). Rounding that to "0.000" would claim a
  // precision the method does not have, and an impossibility besides.
  const sits = [];
  for (const [rating, counts] of [['poor', [0, 0, 0, 0, 0]], ['fair', [1, 1, 1, 1, 1]],
                                  ['good', [3, 3, 3, 3, 3]], ['prime', [9, 9, 9, 9, 9]]]) {
    for (const d of counts) sits.push(sit(rating, d));
  }
  const c = calibration(sits, { iterations: 2000 });
  assert.ok(c.rho > 0.9, 'a perfect ordering');
  assert.ok(c.p > 0, 'p is strictly positive');
  assert.match(c.pText, /^< 0\.0/, `expected a bound, got ${c.pText}`);
  assert.doesNotMatch(c.why, /p 0\.000/);
  assert.match(c.why, /p < 0\.0/);
});

test('sits with no forecast direction leave the denominator with them', () => {
  // The planner writes '?' for a forecast that carried no wind direction.
  // Dividing by every row scored those as misses and reported the forecast as
  // worse than it was: two right out of two became "50% exact".
  const s = (pred, actual) => ({
    date: '2026-11-07', window: 'PM',
    predicted: { windFrom: pred }, wind_from: actual,
  });
  const w = windAccuracy([s('NW', 'NW'), s('W', 'W'), s('?', 'NW'), s('?', 'S')]);
  assert.equal(w.sits, 4, 'all four rows had both fields present');
  assert.equal(w.scored, 2, 'only two could actually be compared');
  assert.equal(w.skipped, 2);
  assert.equal(w.exact, 100, 'and the forecast got both of those right');
  assert.match(w.why, /2 more had no forecast direction/);
});

test('when nothing can be compared it says so rather than reporting 0%', () => {
  const s = (pred, actual) => ({
    date: '2026-11-07', window: 'PM',
    predicted: { windFrom: pred }, wind_from: actual,
  });
  const w = windAccuracy([s('?', 'NW'), s('?', 'S')]);
  assert.equal(w.scored, 0);
  assert.equal(w.exact, null, '0% would read as "the forecast is always wrong"');
  assert.match(w.why, /recorded no direction/);
});
