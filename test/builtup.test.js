/**
 * The built-up filter: the house, the barn and the blacktop.
 *
 * These are the tests for the failure that prompted the module — five
 * suggestions, three of them standing on a state highway and two in somebody's
 * yard. The parcel filter could not have caught the highway ones (right-of-way
 * is not a parcel) and would not have caught the yard ones (it was the owner's
 * own ground). So this asks a different question, and the tests are mostly
 * about it dropping rather than marking down, and about saying when it had
 * nothing to check against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBuiltUp, distanceToPath, clearOfBuiltUp, overpassQuery, builtUpNear,
  clearBuiltUpCache, AVOID_HIGHWAY, BUILDING_STANDOFF_M, ROAD_STANDOFF_M,
} from '../builtup.mjs';
import { offsetPoint } from '../routes.mjs';

// The invented cluster this repo uses everywhere. Points at nothing.
const AT = { lat: 44.12, lng: -90.65 };

const way = (id, tags, points) => ({
  type: 'way', id, tags,
  geometry: points.map(p => ({ lat: p.lat, lon: p.lng })),
});

const candidate = (lat, lng, extra = {}) => ({ lat, lng, score: 30, reasons: [], ...extra });
const resultOf = (...candidates) => ({ candidates, notes: [], caveat: 'walk it' });

test('a building becomes its wall, not its middle', () => {
  // A shed measured from its centroid is half its width closer than it looks.
  // Every node of the way is kept so the distance is to the nearest wall.
  const corner = offsetPoint(AT.lat, AT.lng, 90, 40);
  const built = parseBuiltUp({
    elements: [way(1, { building: 'shed' }, [AT, corner, { lat: corner.lat + 0.0003, lng: corner.lng }])],
  });
  assert.equal(built.buildings.length, 1);
  assert.equal(built.buildings[0].path.length, 3, 'every node survived');
  const d = distanceToPath({ lat: AT.lat, lng: AT.lng }, built.buildings[0].path);
  assert.ok(d < 1, `stood on a corner, so the distance is ~0, got ${d}`);
});

test('farm lanes are not roads — a two-track is where you want to be', () => {
  const line = [AT, offsetPoint(AT.lat, AT.lng, 0, 200)];
  const built = parseBuiltUp({
    elements: [
      way(1, { highway: 'track' }, line),
      way(2, { highway: 'service' }, line),
      way(3, { highway: 'path' }, line),
      way(4, { highway: 'residential' }, line),
      way(5, { highway: 'primary' }, line),
    ],
  });
  assert.deepEqual(built.roads.map(r => r.kind).sort(), ['primary', 'residential']);
  assert.ok(AVOID_HIGHWAY.test('trunk_link'), 'the ramps count too');
  assert.ok(!AVOID_HIGHWAY.test('track'));
});

test('a spot in the yard is dropped, and the drop is counted out loud', () => {
  const house = offsetPoint(AT.lat, AT.lng, 0, 10);
  const built = { buildings: [{ path: [house] }], roads: [] };
  const close = candidate(AT.lat, AT.lng);
  const far = offsetPoint(AT.lat, AT.lng, 180, BUILDING_STANDOFF_M + 60);
  const r = clearOfBuiltUp(resultOf(close, candidate(far.lat, far.lng)), { built });
  assert.equal(r.candidates.length, 1, 'the one in the yard went');
  assert.ok(Math.abs(r.candidates[0].lat - far.lat) < 1e-9);
  assert.ok(r.notes.some(n => /within 120 m of a building/.test(n)), 'and the drop is named');
  assert.equal(r.builtUpChecked, true);
});

test('a spot on the blacktop is dropped, not merely marked down', () => {
  // The whole point. A stand eighty metres off the highway is not a worse
  // stand, it is not a stand, so it must not survive with a penalty.
  const a = offsetPoint(AT.lat, AT.lng, 270, 300);
  const b = offsetPoint(AT.lat, AT.lng, 90, 300);
  const built = { buildings: [], roads: [{ kind: 'primary', path: [a, b] }] };
  const onIt = candidate(AT.lat, AT.lng);
  const off = offsetPoint(AT.lat, AT.lng, 0, ROAD_STANDOFF_M + 40);
  const r = clearOfBuiltUp(resultOf(onIt, candidate(off.lat, off.lng)), { built });
  assert.equal(r.candidates.length, 1);
  assert.ok(r.candidates.every(c => c.score === 30), 'the survivor was not penalised either');
  assert.ok(r.notes.some(n => /within 60 m of a road/.test(n)));
});

test('the standoffs are parameters, because a forty is not a section', () => {
  const house = offsetPoint(AT.lat, AT.lng, 0, 80);
  const built = { buildings: [{ path: [house] }], roads: [] };
  const base = resultOf(candidate(AT.lat, AT.lng));
  assert.equal(clearOfBuiltUp(base, { built }).candidates.length, 0, 'dropped at the default 120 m');
  assert.equal(
    clearOfBuiltUp(base, { built, buildingStandoffM: 50 }).candidates.length, 1,
    'kept when the hunter says fifty');
});

test('an empty map says so rather than passing everything silently', () => {
  // Nought buildings on a rural section is usually "unmapped", and unmapped
  // looks exactly like all-clear unless the answer says which it was.
  const r = clearOfBuiltUp(resultOf(candidate(AT.lat, AT.lng)), {
    built: { buildings: [], roads: [] },
  });
  assert.equal(r.candidates.length, 1, 'nothing to drop against');
  assert.ok(r.notes.some(n => /no buildings mapped/.test(n)));
  assert.ok(r.notes.some(n => /satellite/.test(n)), 'and it says what to do instead');
});

test('when the service is down the answer says it was not checked', () => {
  const r = clearOfBuiltUp(resultOf(candidate(AT.lat, AT.lng)), {
    unavailable: 'the map service returned HTTP 504',
  });
  assert.equal(r.candidates.length, 1, 'nothing is dropped blind');
  assert.equal(r.builtUpChecked, false);
  assert.ok(r.notes.some(n => /not checked/.test(n) && /504/.test(n)));
});

test('the query asks for the ground around the point, in JSON, with a timeout', () => {
  const q = overpassQuery(44.12, -90.65, 620);
  assert.match(q, /\[out:json\]/);
  assert.match(q, /timeout:30/);
  assert.match(q, /around:620,44\.120000,-90\.650000/);
  assert.match(q, /out geom;$/, 'geometry inline, or there is nothing to measure to');
});

test('a request with no User-Agent is refused by Overpass, so one is always sent', async () => {
  // Verified against the live service: no User-Agent comes back 406 with an
  // HTML body, which arrives looking like a parse bug rather than a policy.
  clearBuiltUpCache();
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = opts;
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  await builtUpNear(44.12, -90.65, 500, { fetchImpl });
  assert.ok(seen.headers['user-agent'], 'a User-Agent was sent');
  assert.match(seen.headers['user-agent'], /trailcam/);
  assert.equal(seen.method, 'POST');
});

test('a service that answers 200 with a remark is a failure, not an empty map', async () => {
  // Overpass reports load shedding in a remark on a 200. Reading that as "no
  // buildings here" is the quiet version of the bug this module exists to fix.
  clearBuiltUpCache();
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ remark: 'runtime error: Query timed out' }),
  });
  await assert.rejects(
    () => builtUpNear(44.12, -90.65, 500, { fetchImpl }),
    /refused|timed out/);
});

test('the same ground twice is one request', async () => {
  clearBuiltUpCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  await builtUpNear(44.12, -90.65, 500, { fetchImpl });
  await builtUpNear(44.12, -90.65, 500, { fetchImpl });
  assert.equal(calls, 1, 'the second press came out of the cache');
});
