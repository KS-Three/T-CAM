/**
 * The suggester's job is to pair a piece of ground with the SIDE of it you can
 * sit, and the tests are mostly about that pairing being right — because a
 * suggestion that puts you upwind of the deer is worse than no suggestion at
 * all, and would look perfectly reasonable on a map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestStands, huntableWinds, offsetPoint, anchorPoints,
  SETBACK_M, MIN_FROM_STAND_M, FEATURE_WEIGHT,
} from '../stand-suggester.mjs';
import { bearing } from '../routes.mjs';
import { distanceM } from '../db.mjs';

const AT = { lat: 44.12, lng: -90.65 };

const features = ({ saddles = [], benches = [], drainages = [], ridges = [], quiet = false } = {}) =>
  ({ saddles, benches, drainages, ridges, quiet, medianSlopeDeg: 0.5, reliefFt: 12 });

const saddle = (lat = AT.lat, lng = AT.lng) => ({ kind: 'saddle', lat, lng, reliefFt: 9 });

test('an offset lands the given distance away on the given bearing', () => {
  const p = offsetPoint(AT.lat, AT.lng, 90, 100);
  assert.ok(Math.abs(distanceM(AT.lat, AT.lng, p.lat, p.lng) - 100) < 0.5);
  assert.ok(Math.abs(bearing(AT.lat, AT.lng, p.lat, p.lng) - 90) < 0.5);
  const n = offsetPoint(AT.lat, AT.lng, 0, 250);
  assert.ok(n.lat > AT.lat && Math.abs(n.lng - AT.lng) < 1e-9, 'due north moves latitude only');
});

test('a stand is huntable on the winds that do not blow its scent at the deer', () => {
  // Deer due north of the stand. A north wind carries your scent south, away
  // from them: huntable. A south wind carries it straight at them: not.
  const deer = offsetPoint(AT.lat, AT.lng, 0, 60);
  const winds = huntableWinds(AT, deer);
  assert.ok(winds.includes('N'), 'a north wind blows your scent away from deer to the north');
  assert.ok(!winds.includes('S'), 'a south wind blows it straight at them');
  assert.ok(!winds.includes('SSW') && !winds.includes('SSE'), 'and so do its neighbours');
  assert.ok(winds.includes('E') && winds.includes('W'), 'crosswinds are fine');
  assert.equal(winds.length, 13, 'three of sixteen are ruled out at a 30 degree cone');
});

test('the offset is chosen so the wind you cannot hunt becomes huntable', () => {
  // The whole point of the module. The property has a saddle and one stand set
  // up for westerlies; the season's gap is an east wind.
  const { candidates } = suggestStands({
    features: features({ saddles: [saddle()] }),
    stands: [{ id: 1, name: 'West ladder', lat: 44.128, lng: -90.658, winds: ['W', 'WNW'] }],
    gaps: [{ point: 'E', pct: 9.4 }],
  });
  assert.ok(candidates.length, 'something was suggested');
  const top = candidates[0];
  assert.ok(top.winds.includes('E'), 'the suggestion is huntable on the missing wind');
  assert.deepEqual(top.coversGaps, ['E']);

  // On an east wind, scent goes west — so the stand must be WEST of the saddle.
  const toFeature = bearing(top.lat, top.lng, top.feature.lat, top.feature.lng);
  assert.ok(Math.abs(toFeature - 90) < 30, `should be looking east at the saddle, faces ${top.facing}`);
  assert.equal(top.facing, 'E');
  assert.ok(Math.abs(distanceM(top.lat, top.lng, top.feature.lat, top.feature.lng) - SETBACK_M) < 1);
});

test('it never proposes a stand upwind of the ground it is watching', () => {
  // The failure that would be invisible on a map and ruin every sit.
  const { candidates } = suggestStands({
    features: features({
      saddles: [saddle(), saddle(44.126, -90.643)],
      benches: [{ kind: 'bench', lat: 44.115, lng: -90.657, slopeDeg: 2, steepAround: 40 }],
    }),
    gaps: [{ point: 'NNE', pct: 7 }, { point: 'S', pct: 11 }],
    limit: 8,
  });
  assert.ok(candidates.length >= 2);
  for (const c of candidates) {
    assert.ok(c.winds.includes(c.aimedAt),
      `${c.aimedAt} must be huntable from a spot chosen for it`);
    assert.deepEqual(huntableWinds(c, c.feature), c.winds, 'the reported winds are the real ones');
  }
});

test('the gap it fills is the biggest single reason, and it is in season hours', () => {
  const { candidates } = suggestStands({
    features: features({ saddles: [saddle()] }),
    gaps: [{ point: 'ENE', pct: 12.5 }],
  });
  const top = candidates[0];
  const gapReason = top.reasons.find(r => /no stand of yours/.test(r.why));
  assert.ok(gapReason, 'the gap is named as a reason');
  assert.ok(gapReason.points >= FEATURE_WEIGHT.saddle,
    'and outweighs the landform, which is the ordering the module argues for');
  assert.match(gapReason.why, /% of the season/);
});

test('sign you found yourself counts, and fresh sign counts more', () => {
  const base = { features: features({ saddles: [saddle()] }), gaps: [{ point: 'E', pct: 8 }] };
  const bare = suggestStands(base).candidates[0];
  const near = offsetPoint(AT.lat, AT.lng, 270, SETBACK_M);
  const withSign = suggestStands({
    ...base,
    markers: [
      { kind: 'rub', label: 'Rub', lat: near.lat, lng: near.lng, daysOld: 5 },
      { kind: 'scrape', label: 'Scrape', lat: near.lat, lng: near.lng, daysOld: 400 },
    ],
  }).candidates[0];
  assert.ok(withSign.score > bare.score, 'sign raises the score');
  assert.equal(withSign.signNearby, 2);
  assert.match(withSign.reasons.find(r => /sign within/.test(r.why)).why, /1 of it fresh/);
});

test('it will not crowd a stand you already have', () => {
  // A stand right where the best offset would be: nothing is proposed there.
  const spot = offsetPoint(AT.lat, AT.lng, 270, SETBACK_M);
  const { candidates, note } = suggestStands({
    features: features({ saddles: [saddle()] }),
    stands: [{ id: 1, name: 'Already there', lat: spot.lat, lng: spot.lng, winds: ['E'] }],
    gaps: [{ point: 'E', pct: 8 }],
  });
  assert.equal(candidates.length, 0);
  assert.match(note, /already within/);
});

test('a suggestion that would blow out an existing stand is marked down', () => {
  // 150 m downwind of the candidate on its own good winds — close enough to
  // matter, far enough not to be filtered as crowding.
  const cand = offsetPoint(AT.lat, AT.lng, 270, SETBACK_M);
  const inTheWay = offsetPoint(cand.lat, cand.lng, 270, 150);
  const clean = suggestStands({
    features: features({ saddles: [saddle()] }), gaps: [{ point: 'E', pct: 8 }],
  }).candidates[0];
  const spoiled = suggestStands({
    features: features({ saddles: [saddle()] }), gaps: [{ point: 'E', pct: 8 }],
    stands: [{ id: 2, name: 'Old oak', lat: inTheWay.lat, lng: inTheWay.lng, winds: ['E'] }],
  }).candidates[0];
  assert.ok(spoiled.score < clean.score, 'the penalty applies');
  assert.match(spoiled.reasons.find(r => r.points < 0).why, /drift over Old oak/);
});

test('one suggestion per piece of ground, not the same saddle sixteen times', () => {
  const { candidates } = suggestStands({
    features: features({ saddles: [saddle()] }),
    gaps: 'N NNE NE ENE E ESE SE SSE'.split(' ').map(point => ({ point, pct: 6 })),
    limit: 6,
  });
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      assert.ok(distanceM(candidates[i].lat, candidates[i].lng,
        candidates[j].lat, candidates[j].lng) >= MIN_FROM_STAND_M,
      'suggestions are not stacked on top of each other');
    }
  }
});

test('a draw is sampled along its length, not treated as one point', () => {
  const path = [];
  for (let i = 0; i < 40; i++) path.push([-90.65 + i * 0.0002, 44.12 + i * 0.0001]);
  const anchors = anchorPoints(features({ drainages: [{ kind: 'drainage', path, dropFt: 3 }] }));
  assert.ok(anchors.length >= 6, `sampled along the draw, got ${anchors.length}`);
  assert.ok(anchors.every(a => a.kind === 'drainage'));
  // Coarsely, though: forty pins along one draw would drown out the property.
  assert.ok(anchors.length < path.length / 3);
});

test('with no terrain loaded it says so instead of guessing', () => {
  const r = suggestStands({ gaps: [{ point: 'E', pct: 8 }] });
  assert.equal(r.candidates.length, 0);
  assert.match(r.note, /Terrain has not been loaded/);
});

test('on flat ground it says which detectors were unavailable', () => {
  const r = suggestStands({
    features: features({ quiet: true, drainages: [{ path: [[-90.65, 44.12], [-90.649, 44.121]] }] }),
    gaps: [{ point: 'E', pct: 8 }],
  });
  assert.ok(r.notes.some(n => /too gentle for saddles or benches/.test(n)));
});

test('with no wind history it does not pretend to be filling a gap', () => {
  const r = suggestStands({ features: features({ saddles: [saddle()] }) });
  assert.ok(r.notes.some(n => /No wind history loaded/.test(n)));
  for (const c of r.candidates) assert.deepEqual(c.coversGaps, []);
});

test('every result carries the caveat about what it cannot know', () => {
  const r = suggestStands({
    features: features({ saddles: [saddle()] }), gaps: [{ point: 'E', pct: 8 }],
  });
  assert.match(r.caveat, /property lines/);
  assert.match(r.caveat, /WALK/);
});

test('checked against the route module, which computes scent independently', async () => {
  // huntableWinds and scentReaches were written for different jobs and do not
  // share code beyond the angle helpers. If a suggestion says a wind is
  // huntable, the route checker — asked whether standing there puts scent on
  // the feature — has to agree. This is the assertion that would catch a sign
  // error in either one.
  const { scentReaches } = await import('../routes.mjs');
  const { candidates } = suggestStands({
    features: features({
      saddles: [saddle(), saddle(44.1265, -90.6435)],
      benches: [{ kind: 'bench', lat: 44.1148, lng: -90.6572, slopeDeg: 3, steepAround: 45 }],
      ridges: [{ path: [[-90.652, 44.1185], [-90.6512, 44.1191], [-90.6503, 44.1198],
                        [-90.6494, 44.1204], [-90.6486, 44.1211], [-90.6477, 44.1218],
                        [-90.6469, 44.1224]], dropFt: 4 }],
    }),
    gaps: [{ point: 'NNE', pct: 7 }, { point: 'ESE', pct: 9 }, { point: 'S', pct: 11 }],
    limit: 10,
  });
  assert.ok(candidates.length >= 3, `expected several candidates, got ${candidates.length}`);

  let checked = 0;
  for (const c of candidates) {
    for (let i = 0; i < 16; i++) {
      const deg = i * 22.5;
      const point = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][i];
      // Standing at the candidate is a one-point route; does its scent reach
      // the feature on this wind?
      const hit = scentReaches([[c.lng, c.lat]], c.feature, deg, { reachM: 400 });
      assert.equal(c.winds.includes(point), !hit,
        `${point}: suggester says ${c.winds.includes(point) ? 'huntable' : 'not'}, `
        + `route module says scent ${hit ? 'reaches' : 'misses'} the feature`);
      checked++;
    }
  }
  assert.ok(checked >= 48, `checked ${checked} stand/wind pairs`);
});
