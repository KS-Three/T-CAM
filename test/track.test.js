/**
 * Recording a walk is easy; believing it is not. These tests are almost
 * entirely about the filters, because a phone under November canopy produces
 * scatter and the occasional fix a couple of hundred metres away — and stored
 * raw, that gives a plausible-looking line whose length is wrong by a factor
 * and whose scent analysis names ground you never went near.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrack, simplify, pointToSegmentM, normalisePoint, compareToRoute,
  trackQuality, MAX_ACCURACY_M, MAX_SPEED_MPS,
} from '../track.mjs';
import { distanceM } from '../db.mjs';

const LAT = 44.12, LNG = -90.65;
// A metre north and a metre east, near enough at this latitude.
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));

/** A straight walk north: one fix a second at 1 m/s, good accuracy. */
const walkNorth = (n, { acc = 8, start = 1762000000000, stepM = 1 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    lat: LAT + i * stepM * M_LAT, lng: LNG, acc, t: start + i * 1000,
  }));

test('a fix without real coordinates is discarded, not coerced', () => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic.
  assert.equal(normalisePoint({ lat: null, lng: -90.65 }), null);
  assert.equal(normalisePoint({ lat: 44.12 }), null);
  assert.equal(normalisePoint({ lat: 'x', lng: 'y' }), null);
  assert.equal(normalisePoint({ lat: 91, lng: 0 }), null, 'out of range is not a place');
  assert.equal(normalisePoint({}), null);
  // The browser's own shape works untouched.
  const p = normalisePoint({ coords: { latitude: 44.12, longitude: -90.65, accuracy: 6 }, timestamp: 1 });
  assert.deepEqual(p, { lat: 44.12, lng: -90.65, acc: 6, t: 1 });
});

test('an unknown accuracy is treated as untrustworthy, not as perfect', () => {
  // The tempting default is to let a fix through when the phone did not say
  // how good it was. That is exactly backwards.
  const t = buildTrack(walkNorth(20).map(p => ({ ...p, acc: undefined })));
  assert.equal(t.dropped.accuracy, 20);
  assert.equal(t.quality.level, 'unusable');
});

test('fixes the phone admits are bad are dropped rather than averaged in', () => {
  const raw = walkNorth(20);
  raw[5].acc = 90; raw[11].acc = 120;
  const t = buildTrack(raw);
  assert.equal(t.dropped.accuracy, 2);
  assert.ok(t.medianAccuracyM <= 10);
});

test('a single wild fix does not become a 200 m detour', () => {
  // The failure this whole module exists for. One bad sample mid-walk, and a
  // raw track reports a journey twice as long as the one you took.
  const raw = walkNorth(30);
  raw[15] = { ...raw[15], lat: LAT + 200 * M_LAT, lng: LNG + 200 * M_LNG };
  const t = buildTrack(raw);
  assert.equal(t.dropped.speed, 1, 'the jump was rejected on speed');
  // 30 fixes a metre apart is a 29 m walk. Raw, the outlier would add ~560 m.
  assert.ok(Math.abs(t.lengthM - 29) <= 3, `expected about 29 m, got ${t.lengthM}`);
});

test('an outlier is measured against the last fix KEPT, not the last one seen', () => {
  // Otherwise one bad fix drags the gate out to meet it and the fix AFTER it —
  // a real one — gets rejected instead, leaving the track stuck at the outlier.
  const raw = walkNorth(10);
  raw[4] = { ...raw[4], lat: LAT + 500 * M_LAT };
  const t = buildTrack(raw);
  assert.equal(t.dropped.speed, 1, 'exactly one rejection, not a cascade');
  assert.ok(Math.abs(t.lengthM - 9) <= 2, `the walk survives: ${t.lengthM} m`);
});

test('standing still does not accumulate distance', () => {
  // Ten minutes on stand produces hundreds of fixes scattered by the error
  // radius. Summed raw, that is a kilometre of "walking" without moving.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const raw = Array.from({ length: 300 }, (_, i) => ({
    lat: LAT + rnd() * 12 * M_LAT, lng: LNG + rnd() * 12 * M_LNG,
    acc: 10, t: 1762000000000 + i * 2000,
  }));
  const t = buildTrack(raw);
  assert.ok(t.lengthM < 40, `a stationary hour should not walk far, got ${t.lengthM} m`);
  assert.ok(t.used < 20, `and should collapse to a few points, got ${t.used}`);
});

test('a real walk keeps its shape and its length', () => {
  const t = buildTrack(walkNorth(200, { acc: 6 }));
  assert.ok(Math.abs(t.lengthM - 199) <= 4, `expected about 199 m, got ${t.lengthM}`);
  assert.ok(t.used >= 2 && t.used < 20, `a straight line needs few points, got ${t.used}`);
  assert.equal(t.seconds, 199);
  assert.equal(t.quality.level, 'good');
});

test('pace is reported for a walk long enough for it to mean anything', () => {
  const t = buildTrack(walkNorth(300, { acc: 6 }));
  // 1 m/s is 1000 s per km.
  assert.ok(Math.abs(t.pacePerKm - 1000) < 60, `got ${t.pacePerKm} s/km`);
  assert.equal(buildTrack(walkNorth(20)).pacePerKm, null, 'too short to claim a pace');
});

test('what was thrown away is counted, because it decides whether to believe it', () => {
  const raw = [...walkNorth(10), { lat: 'x', lng: 'y' }, { lat: null, lng: null }];
  raw[3].acc = 200;
  const t = buildTrack(raw);
  assert.equal(t.dropped.unusable, 2);
  assert.equal(t.dropped.accuracy, 1);
  assert.equal(t.fixes, 12);
});

test('a track built from a handful of fixes says it is not a track', () => {
  const raw = walkNorth(20).map((p, i) => (i < 17 ? { ...p, acc: 999 } : p));
  const t = buildTrack(raw);
  assert.equal(t.quality.level, 'unusable');
  assert.match(t.quality.why, /not a track/);
});

test('a mostly-discarded track is called poor, not measured to the metre', () => {
  const raw = walkNorth(60).map((p, i) => (i % 3 ? { ...p, acc: 999 } : p));
  const t = buildTrack(raw);
  assert.equal(t.quality.level, 'poor');
  assert.match(t.quality.why, /rough indication/);
});

test('heavy canopy is reported as rough, with the shape still usable', () => {
  const t = buildTrack(walkNorth(80, { acc: 35 }));
  assert.equal(t.quality.level, 'rough');
  assert.match(t.quality.why, /distances are approximate/);
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test('distance to a segment is to the SEGMENT, not its infinite line', () => {
  const a = { lat: LAT, lng: LNG };
  const b = { lat: LAT + 100 * M_LAT, lng: LNG };
  // Beside the middle: 10 m.
  assert.ok(Math.abs(pointToSegmentM({ lat: LAT + 50 * M_LAT, lng: LNG + 10 * M_LNG }, a, b) - 10) < 0.5);
  // Beyond the end: the answer is to the endpoint, not a perpendicular.
  const beyond = { lat: LAT + 150 * M_LAT, lng: LNG };
  assert.ok(Math.abs(pointToSegmentM(beyond, a, b) - 50) < 0.5,
    'clamped to the segment end');
  // A degenerate segment is a point.
  assert.ok(Math.abs(pointToSegmentM(beyond, a, a) - 150) < 1);
});

test('simplification keeps the ends and the corners', () => {
  const line = [
    { lat: LAT, lng: LNG },
    { lat: LAT + 50 * M_LAT, lng: LNG },
    { lat: LAT + 100 * M_LAT, lng: LNG },        // straight: droppable
    { lat: LAT + 100 * M_LAT, lng: LNG + 100 * M_LNG },   // a real corner
  ];
  const s = simplify(line, 5);
  assert.equal(s.length, 3, 'the collinear middle point goes, the corner stays');
  assert.deepEqual(s[0], line[0]);
  assert.deepEqual(s.at(-1), line.at(-1));
  assert.equal(simplify(line.slice(0, 2), 5).length, 2, 'two points are already simple');
});

test('simplification handles a long track without blowing the stack', () => {
  // Recursive Douglas-Peucker on a degenerate input recurses once per point.
  const many = Array.from({ length: 20000 }, (_, i) => ({ lat: LAT + i * M_LAT, lng: LNG }));
  assert.doesNotThrow(() => simplify(many, 0.001));
});

// ---------------------------------------------------------------------------
// Against the plan
// ---------------------------------------------------------------------------

const route = {
  points: [[LNG, LAT], [LNG, LAT + 200 * M_LAT]],   // straight north, 200 m
};

test('a walk that followed the route says so', () => {
  const track = buildTrack(walkNorth(200, { acc: 6 }));
  const c = compareToRoute(track, route);
  assert.equal(c.comparable, true);
  assert.equal(c.followed, true);
  assert.ok(c.worstM < 10, `worst deviation ${c.worstM} m`);
  assert.match(c.why, /followed the route the whole way/);
});

test('a cut corner is found, measured, and located', () => {
  // The commonest way a good route stops being one: in the dark you drift off
  // it, and the route check never looked at the ground you actually crossed.
  const raw = walkNorth(200, { acc: 6 });
  for (let i = 80; i < 130; i++) raw[i].lng = LNG + 70 * M_LNG;
  const c = compareToRoute(buildTrack(raw), route);
  assert.equal(c.followed, false);
  assert.ok(Math.abs(c.worstM - 70) < 6, `expected about 70 m, got ${c.worstM}`);
  assert.ok(c.worstAt, 'and says where');
  assert.ok(c.offRouteFraction > 0.1);
  assert.match(c.why, /never looked at/);
});

test('with nothing to compare it says so rather than reporting zero deviation', () => {
  assert.equal(compareToRoute(null, route).comparable, false);
  assert.equal(compareToRoute(buildTrack(walkNorth(50)), { points: [] }).comparable, false);
  assert.match(compareToRoute(null, null).why, /Needs both/);
});

test('the resolution gate is set at two sigma, and one sigma is not enough', () => {
  // Pinning the factor, because the difference between 1x and 2x accuracy is
  // the difference between "you stood still" and "you walked 150 m on stand",
  // and 1x is the reading that looks obviously right.
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const still = Array.from({ length: 400 }, (_, i) => ({
    lat: LAT + rnd() * 12 * M_LAT, lng: LNG + rnd() * 12 * M_LNG,
    acc: 10, t: 1762000000000 + i * 2000,
  }));
  assert.ok(buildTrack(still).lengthM < 40, 'two sigma holds it down');
  // Forcing the epsilon does not rescue it: simplification preserves shape,
  // and a cloud of noise has plenty of shape.
  assert.ok(buildTrack(still, { epsilonM: 5 }).lengthM < 40,
    'the resolution gate, not simplification, is what does this');
});

test('a walk that ends standing still still reaches where it ended', () => {
  // The last fix is kept unconditionally; without that, a pause at the stand
  // truncates the track short of the stand.
  const raw = [...walkNorth(120, { acc: 6 })];
  const last = raw[raw.length - 1];
  for (let i = 0; i < 60; i++) {
    raw.push({ lat: last.lat, lng: last.lng, acc: 6, t: last.t + (i + 1) * 2000 });
  }
  const t = buildTrack(raw);
  const end = t.points[t.points.length - 1];
  assert.ok(Math.abs(distanceM(end[1], end[0], last.lat, last.lng)) < 3,
    'the track ends where the walk did');
  assert.ok(Math.abs(t.lengthM - 119) <= 4, `and is not inflated by the wait: ${t.lengthM}`);
});

test('a walk right down the route does not report "within 0 m"', () => {
  // Arithmetically true and reads as a bug. Below what the GPS can resolve,
  // the honest wording is words, not a zero.
  const exact = buildTrack(walkNorth(200, { acc: 6 }));
  const c = compareToRoute(exact, route);
  assert.equal(c.followed, true);
  assert.doesNotMatch(c.why, /within 0 m/);
  assert.match(c.why, /within what the GPS can resolve/);
  // A real but small deviation still gets its number.
  const drift = walkNorth(200, { acc: 6 });
  for (let i = 90; i < 110; i++) drift[i].lng = LNG + 12 * M_LNG;
  assert.match(compareToRoute(buildTrack(drift), route).why, /stayed within \d+ m/);
});
