/**
 * The suggested walk in: does the line it proposes actually stay clean?
 *
 * The check that matters is not "did it draw a path" but "does routes.mjs —
 * the independent scent model every hand-drawn route is judged by — call the
 * proposal clean on the wind it was planned for". A suggester graded by its
 * own arithmetic proves nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  suggestEntryPath, taints, APPROACH_SETBACK_M, compassOf,
} from '../entry-path.mjs';
import { scentReaches, bearing, offsetPoint } from '../routes.mjs';
import { openDb, createStand, createMarker, distanceM } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-entry-'));

// Invented ground, the 44.12 / -90.65 cluster.
const STAND = { name: 'Oak Ridge', lat: 44.1260, lng: -90.6510 };

const last = pts => pts[pts.length - 1];

// ---------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------

test('the walk approaches from downwind and the model calls it clean', () => {
  // Wind from the north; the truck parked 600 m NORTH of the stand. Straight
  // in is the worst possible line — the whole final stretch walks the
  // downwind axis with scent blowing ahead onto the stand.
  const from = offsetPoint(STAND.lat, STAND.lng, 0, 600);
  const s = suggestEntryPath({ from, stand: STAND, windFromDeg: 0 });

  assert.equal(s.ok, true);
  assert.equal(s.verdict.ok, true, 'judged clean by assessRoute, the standard model');
  assert.equal(scentReaches(s.points, STAND, 0), null,
    'no point of the walk puts scent on the stand');

  // The points ARE the line. scentReaches judges points, so a sparse
  // corner path could sweep through a wedge while every corner sat outside
  // it — caught in the first browser screenshot of this feature, where a
  // "clean" proposal drew straight through the beds.
  for (let i = 1; i < s.points.length; i++) {
    const [a, b] = [s.points[i - 1], s.points[i]];
    assert.ok(distanceM(a[1], a[0], b[1], b[0]) <= 30,
      'no gap wide enough for a wedge to hide between judged points');
  }

  // It ends just short of the stand, on its downwind side.
  const [endLng, endLat] = last(s.points);
  const d = distanceM(endLat, endLng, STAND.lat, STAND.lng);
  assert.ok(Math.abs(d - APPROACH_SETBACK_M) < 3, `ends ${APPROACH_SETBACK_M} m out (${d.toFixed(1)})`);
  const side = bearing(STAND.lat, STAND.lng, endLat, endLng);
  assert.ok(Math.abs(side - 180) < 10, `on the downwind side (${side.toFixed(0)}°)`);

  assert.ok(s.lengthM > s.straightM, 'the swing costs distance, and says so');
  assert.ok(s.why.some(w => /downwind side/.test(w)), 'and the reasoning names the approach');
  assert.ok(s.why.some(w => /stops 20 m short/.test(w)), 'and owns the last steps');
});

test('a marked bed on the straight line is routed around, not walked past', () => {
  // Same north wind, and a bed 300 m north of the stand — dead on the
  // straight line in. The walk must swing wide enough that neither the bed
  // nor the stand ever sits downwind of a step.
  const from = offsetPoint(STAND.lat, STAND.lng, 0, 600);
  const bed = { ...offsetPoint(STAND.lat, STAND.lng, 0, 300), name: 'Cedar beds' };
  const s = suggestEntryPath({ from, stand: STAND, windFromDeg: 0, avoid: [bed] });

  assert.equal(scentReaches(s.points, STAND, 0), null, 'clean on the stand');
  assert.equal(scentReaches(s.points, bed, 0), null, 'and clean on the beds');
  assert.equal(s.verdict.ok, true);
  assert.equal(s.verdict.crossed.length, 0, 'assessRoute agrees nothing was crossed');
  assert.ok(s.bentAround.length >= 1, 'the bends are named, not silent');
});

test('what the start already ruins is reported, never routed around in vain', () => {
  // Parked 50 m dead upwind of the beds: standing at the truck already blows
  // scent across them, and no path out of the parking spot un-rings that
  // bell. The suggester must say so rather than fail or pretend.
  const bed = { ...offsetPoint(STAND.lat, STAND.lng, 0, 400), name: 'Cedar beds' };
  const from = offsetPoint(bed.lat, bed.lng, 0, 50);
  const s = suggestEntryPath({ from, stand: STAND, windFromDeg: 0, avoid: [bed] });
  assert.ok(s.excused.includes('Cedar beds'));
  assert.ok(s.why.some(w => /no path helps Cedar beds/.test(w)));
  assert.equal(scentReaches(s.points, STAND, 0), null, 'the stand is still kept clean');
});

test('sixteen winds are reported, and the planning wind is among the clean ones', () => {
  const from = offsetPoint(STAND.lat, STAND.lng, 45, 500);
  const s = suggestEntryPath({ from, stand: STAND, windFromDeg: 270 });
  assert.equal(s.winds.clean.length + s.winds.dirty.length, 16);
  assert.ok(s.winds.clean.includes('W'), 'clean on the wind it was planned for');
  assert.equal(s.windFrom, 'W');
});

test('missing inputs are refused in words that say what is missing', () => {
  assert.throws(() => suggestEntryPath({ stand: STAND, windFromDeg: 0 }), /starting point/);
  assert.throws(() => suggestEntryPath({ from: { lat: 44.13, lng: -90.65 }, windFromDeg: 0 }),
    /needs a stand/);
  assert.throws(() => suggestEntryPath({
    from: { lat: 44.13, lng: -90.65 }, stand: STAND, windFromDeg: null,
  }), /needs one/);
});

test('parking at the foot of the tree suggests the trivial walk, not a tour', () => {
  const from = offsetPoint(STAND.lat, STAND.lng, 180, 15);
  const s = suggestEntryPath({ from, stand: STAND, windFromDeg: 0 });
  assert.ok(s.points.length >= 2);
  assert.ok(s.lengthM < 80, `no invented detour from the doorstep (${s.lengthM} m)`);
});

test('taints mirrors the scent model point for point', () => {
  // Standing 100 m upwind of a target on a north wind taints it; standing
  // 100 m downwind, or 300 m upwind, does not. The same three answers
  // scentReaches gives for a one-point route.
  const target = { lat: 44.1260, lng: -90.6510 };
  const up = offsetPoint(target.lat, target.lng, 0, 100);
  const down = offsetPoint(target.lat, target.lng, 180, 100);
  const far = offsetPoint(target.lat, target.lng, 0, 300);
  for (const [p, want] of [[up, true], [down, false], [far, false]]) {
    const pt = [p.lng, p.lat];
    assert.equal(taints(pt, target, 0), want);
    assert.equal(!!scentReaches([pt], target, 0), want, 'agrees with scentReaches');
  }
  assert.equal(compassOf(0), 'N');
  assert.equal(compassOf(292.5), 'WNW');
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t, { plan } = {}) {
  const out = tmp();
  const db = openDb(out);
  const stand = createStand(db, { name: 'Oak Ridge', lat: STAND.lat, lng: STAND.lng });
  createMarker(db, { kind: 'bed', name: 'Cedar beds', lat: 44.1287, lng: -90.6510 });
  db.close();
  if (plan) fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan));
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { standId: stand.id, get: p => fetch(base + p) };
}

// A plan whose one sit is far in the future, so "the coming sit" stays ahead
// of the clock however long this test suite lives.
const PLAN = {
  generatedAt: '2026-08-29T12:00:00.000Z',
  sits: [{
    date: '2099-11-09', window: 'PM', rating: 'PRIME', total: 40,
    windDir: 0, windFrom: 'N', start: '2099-11-09T14:30', end: '2099-11-09T18:30',
  }],
};

test('the API plans against the coming sit\'s wind and says so', async t => {
  const { standId, get } = await serving(t, { plan: PLAN });
  const from = offsetPoint(STAND.lat, STAND.lng, 0, 600);
  const res = await get('/api/suggest-route?standId=' + standId
    + '&fromLat=' + from.lat + '&fromLng=' + from.lng);
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.windFrom, 'N');
  assert.match(s.windSource, /coming sit \(2099-11-09 PM\)/);
  assert.equal(scentReaches(s.points, STAND, 0), null, 'clean on the plan\'s wind');
  // The bed marker seeded above rides along as ground not to blow out.
  assert.equal(scentReaches(s.points, { lat: 44.1287, lng: -90.6510 }, 0), null);
});

test('?wind= overrides the plan, for what-if the wind swings', async t => {
  const { standId, get } = await serving(t, { plan: PLAN });
  const from = offsetPoint(STAND.lat, STAND.lng, 90, 500);
  const s = await (await get('/api/suggest-route?standId=' + standId
    + '&fromLat=' + from.lat + '&fromLng=' + from.lng + '&wind=270')).json();
  assert.equal(s.windFrom, 'W');
  assert.equal(s.windSource, 'as asked');
});

test('no plan and no wind is a 400 that says what to do, never a guessed wind', async t => {
  const { standId, get } = await serving(t);
  const res = await get('/api/suggest-route?standId=' + standId
    + '&fromLat=44.13&fromLng=-90.65');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /run the planner|no wind/i);
});

test('a missing start or stand is the caller\'s mistake, named', async t => {
  const { standId, get } = await serving(t, { plan: PLAN });
  assert.equal((await get('/api/suggest-route?standId=999&fromLat=44.13&fromLng=-90.65')).status, 404);
  const res = await get('/api/suggest-route?standId=' + standId);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /starting point/);
});
