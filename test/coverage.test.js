/**
 * Deriving a stand's winds from its shooting lanes.
 *
 * The failure to guard against is the same one the route checker guards
 * against, one step earlier: an inverted sign here would report a stand
 * huntable on exactly the winds that carry your scent down the lane you are
 * watching, and nothing on the map would look wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  laneGeometry, laneGeometries, huntableFromLanes, compareToManual,
  windsForStand, LANE_SPREAD_DEG,
} from '../coverage.mjs';
import { CONE_HALF_ANGLE_DEG, scentReaches, COMPASS } from '../routes.mjs';
import { mapStyles, mapScript } from '../map-view.mjs';

const LAT = 44.12, LNG = -90.65;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
const stand = { lat: LAT, lng: LNG, name: 'Creek ladder' };

/** A lane `m` metres out on `deg`. */
const lane = (deg, m = 60, label = null) => {
  const r = deg * Math.PI / 180;
  return { to: [LNG + Math.sin(r) * m * M_LNG, LAT + Math.cos(r) * m * M_LAT], label };
};

test('a lane knows where it points and how far it reaches', () => {
  const g = laneGeometry(stand, lane(90, 55));
  assert.ok(Math.abs(g.bearingDeg - 90) < 0.5);
  assert.equal(g.point, 'E');
  assert.ok(Math.abs(g.metres - 55) <= 1);
});

test('a lane without real coordinates is discarded, not coerced', () => {
  assert.equal(laneGeometry(stand, { to: [null, 44.12] }), null);
  assert.equal(laneGeometry(stand, {}), null);
  assert.equal(laneGeometry({ lat: null, lng: null }, lane(0)), null);
  assert.equal(laneGeometries(stand, [lane(0), { to: 'x' }]).length, 1);
});

test('a stand with no lanes marked returns null, not "no winds"', () => {
  // The distinction every other module here already refuses to blur.
  assert.equal(huntableFromLanes(stand, []), null);
  assert.equal(huntableFromLanes(stand), null);
});

test('a single lane rules out the winds that blow down it', () => {
  // One lane due north. Scent goes downwind, so a SOUTH wind pushes it north —
  // straight up the lane. A NORTH wind pushes it south, away.
  const d = huntableFromLanes(stand, [lane(0)]);
  assert.ok(d.winds.includes('N'), 'a north wind carries scent away from a north lane');
  assert.ok(!d.winds.includes('S'), 'a south wind carries it straight down the lane');
  assert.ok(!d.winds.includes('SSE') && !d.winds.includes('SSW'), 'and its neighbours');
  assert.ok(d.winds.includes('E') && d.winds.includes('W'), 'crosswinds are fine');
  // 30 degree plume plus 5 of lane spread: S, SSE, SSW blocked.
  assert.equal(d.blocked.length, 3);
  assert.equal(d.winds.length, 13);
});

test('the blocked wind names the lane it would blow down', () => {
  const d = huntableFromLanes(stand, [lane(0, 70, 'The opening'), lane(90, 40, 'Field edge')]);
  const south = d.blocked.find(b => b.point === 'S');
  assert.equal(south.lane.label, 'The opening', 'the north lane, which a south wind runs up');
  const west = d.blocked.find(b => b.point === 'W');
  assert.equal(west.lane.label, 'Field edge', 'and the east lane for a west wind');
});

test('four lanes on the cardinals still leave the four diagonals', () => {
  // Worth asserting because it is not the obvious answer. A NE wind pushes
  // scent SW, which is 45 degrees off both the south and west lanes — outside
  // the 35 degree reach, so the stand is still huntable on it.
  const d = huntableFromLanes(stand, [lane(0), lane(90), lane(180), lane(270)]);
  assert.deepEqual(d.winds.sort(), ['NE', 'NW', 'SE', 'SW']);
  assert.equal(d.blocked.length, 12);
});

test('lanes in every direction leave no huntable wind, and say why', () => {
  const every = [0, 45, 90, 135, 180, 225, 270, 315].map(deg => lane(deg));
  const d = huntableFromLanes(stand, every);
  assert.equal(d.winds.length, 0);
  assert.match(d.why, /too many directions to hunt as one stand/);
});

test('two lanes close together block little more than one', () => {
  const one = huntableFromLanes(stand, [lane(0)]);
  const two = huntableFromLanes(stand, [lane(0), lane(20)]);
  assert.ok(two.winds.length < one.winds.length, 'a little more is blocked');
  assert.ok(two.winds.length >= one.winds.length - 2, 'but not much');
});

test('the longest lane is reported, because it is the shot you might take', () => {
  const d = huntableFromLanes(stand, [lane(0, 35), lane(90, 120), lane(200, 60)]);
  assert.equal(d.longestM, 120);
  assert.match(d.why, /3 lanes/);
  assert.match(d.why, /E 120 m/);
});

test('checked against the route module, which computes scent independently', () => {
  // huntableFromLanes and scentReaches were written for different jobs and
  // share only the angle helpers. Put a target far down the lane and the two
  // must agree about every wind, or one of them has a sign error.
  for (const deg of [0, 47, 135, 200, 310]) {
    const l = lane(deg, 90);
    const d = huntableFromLanes(stand, [l], { spreadDeg: 0 });
    const target = { lat: l.to[1], lng: l.to[0] };
    for (let i = 0; i < 16; i++) {
      const hit = scentReaches([[LNG, LAT]], target, i * 22.5,
        { reachM: 500, halfAngleDeg: CONE_HALF_ANGLE_DEG });
      assert.equal(d.winds.includes(COMPASS[i]), !hit,
        `lane ${deg}, wind ${COMPASS[i]}: coverage says `
        + `${d.winds.includes(COMPASS[i]) ? 'huntable' : 'blocked'}, routes says scent `
        + `${hit ? 'reaches' : 'misses'}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Against what was ticked by hand
// ---------------------------------------------------------------------------

test('agreement between the lanes and the ticked winds is reported as such', () => {
  const d = huntableFromLanes(stand, [lane(0)]);
  const c = compareToManual(d, d.winds);
  assert.equal(c.agree, true);
  assert.match(c.why, /agree/);
});

test('a wind ticked by hand that the lanes rule out is named', () => {
  const d = huntableFromLanes(stand, [lane(0)]);
  const c = compareToManual(d, ['N', 'S']);      // S blows up the lane
  assert.equal(c.agree, false);
  assert.deepEqual(c.onlyManual, ['S']);
  assert.match(c.why, /You ticked S/);
  assert.match(c.why, /runs down a lane/);
});

test('winds the lanes allow but nobody ticked are offered, not imposed', () => {
  const d = huntableFromLanes(stand, [lane(0)]);
  const c = compareToManual(d, ['N']);
  assert.ok(c.onlyDerived.length > 5);
  assert.match(c.why, /also allow/);
  assert.equal(c.agree, false);
});

test('with nothing ticked there is nothing to compare, which is not disagreement', () => {
  const d = huntableFromLanes(stand, [lane(0)]);
  assert.equal(compareToManual(d, []).agree, null);
  assert.equal(compareToManual(null, ['N']), null);
});

// ---------------------------------------------------------------------------
// Which source a stand is judged on
// ---------------------------------------------------------------------------

test('lanes are used where they exist, and the source is stated', () => {
  const s = { ...stand, lanes: [lane(0)], winds: ['S'] };
  const r = windsForStand(s);
  assert.equal(r.source, 'lanes');
  assert.ok(!r.winds.includes('S'), 'the geometry overrules the tick for the ranking');
  assert.equal(r.compared.agree, false, 'and the disagreement is surfaced, not hidden');
});

test('a stand with no lanes still works off its ticked winds', () => {
  // Nothing that already worked may stop working.
  const r = windsForStand({ ...stand, winds: ['NW', 'N'] });
  assert.equal(r.source, 'ticked');
  assert.deepEqual(r.winds, ['NW', 'N']);
  assert.equal(r.derived, null);
});

test('the database shape works too, not just the API shape', () => {
  const r = windsForStand({ ...stand, good_winds: 'NW,N' });
  assert.equal(r.source, 'ticked');
  assert.deepEqual(r.winds, ['NW', 'N']);
});

test('a stand with neither reports none, and is not given the benefit of the doubt', () => {
  const r = windsForStand({ ...stand });
  assert.equal(r.source, 'none');
  assert.deepEqual(r.winds, []);
});

test('the copy the map runs derives exactly what Node derives', async () => {
  // The winds have to appear as each lane is placed, so this arithmetic runs
  // in the browser too. One definition, emitted — and compared here on real
  // lanes, so the winds shown while tracing and the winds the ranking uses
  // cannot drift apart.
  const vm = await import('node:vm');
  const { browserSource } = await import('../coverage.mjs');
  const ctx = vm.createContext({});
  new vm.Script(browserSource('C') + '\nC;').runInContext(ctx);
  const browser = vm.runInContext('C', ctx);

  const sets = [
    [lane(0)],
    [lane(0, 70, 'The opening'), lane(90, 40, 'Field edge')],
    [lane(23, 15), lane(200, 300), lane(310, 65)],
    [lane(0), lane(45), lane(90), lane(135), lane(180), lane(225), lane(270), lane(315)],
    [],
  ];
  // Compared by value: the results carry nested objects from the vm's realm,
  // which a structural comparison rejects even when every field matches.
  const plain = v => JSON.parse(JSON.stringify(v ?? null));
  for (const set of sets) {
    assert.deepStrictEqual(plain(browser.huntableFromLanes(stand, set)),
      plain(huntableFromLanes(stand, set)), `${set.length} lanes`);
  }
  assert.deepStrictEqual(
    plain(browser.compareToManual(browser.huntableFromLanes(stand, [lane(0)]), ['N', 'S'])),
    plain(compareToManual(huntableFromLanes(stand, [lane(0)]), ['N', 'S'])));
});

test('the stand form can never grow past the map and lose its buttons', () => {
  // The map clips overflow at 420px. The form was already close with sixteen
  // wind buttons and a notes box; adding the lane section pushed it over and
  // Save became literally unclickable — Playwright reported the page wrapper
  // intercepting the click. Caught by driving it, not by a test.
  const rule = mapStyles.slice(mapStyles.indexOf('.standform {'));
  const block = rule.slice(0, rule.indexOf('}'));
  assert.match(block, /max-height:/, 'the form is bounded');
  assert.match(block, /overflow-y: auto/, 'and scrolls rather than overflowing');
});

test('the tracing strip clears the centring transform it inherits', () => {
  // .standform centres itself with translate(-50%, -50%). The tracing rule
  // changes left/right/bottom but the transform survives, so the strip sat
  // half its width off the left edge with its text clipped. Seen in a
  // screenshot, not in a test.
  const rule = mapStyles.slice(mapStyles.indexOf('.standform.tracing {'));
  const block = rule.slice(0, rule.indexOf('}'));
  assert.match(block, /transform: none/);
});

test('arming the trace moves the stand clear of the strip', () => {
  // Whichever edge the strip is pinned to it can land over the stand, and then
  // most of the ground you want to mark is behind it. Measured while driving
  // it: two clicks in three hit the panel instead of the map.
  const trace = mapScript.slice(mapScript.indexOf('traceBtn.onclick'));
  const body = trace.slice(0, trace.indexOf('\n  };'));
  assert.match(body, /form\.getBoundingClientRect\(\)\.height/, 'it measures the strip');
  assert.match(body, /projY\(stand\.lat, zoom\) \+ strip \/ 2/, 'and offsets by half of it');
  assert.match(body, /centre = \{/, 'then recentres');
});

test('the lane cone is filled by an inline style, not a fill attribute', () => {
  // #contours carries a blanket "path { fill: none }" for the contour lines,
  // and a CSS declaration beats a presentation attribute. With fill="url(...)"
  // the map drew four geometrically perfect cones filled with nothing at all —
  // invisible, no error, nothing in the DOM to suggest a problem. Only looking
  // at it found this.
  assert.match(mapScript, /style="fill:url\(#/, 'the fill is inline');
  assert.doesNotMatch(mapScript, /<path class="lane" fill="url/,
    'not a presentation attribute the stylesheet would override');
  assert.match(mapStyles, /#contours path \{ fill: none/, 'the rule that would win still exists');
});

test('the cone is drawn at the same arc the wind derivation uses', () => {
  // A wide cone over a narrow calculation would make the picture disagree with
  // the model, and the picture is what you would believe.
  const drawn = Number(mapScript.match(/const LANE_HALF_DEG = (\d+)/)[1]);
  assert.equal(drawn, LANE_SPREAD_DEG);
});

test('one fade per stand, scaled to its longest lane', () => {
  // Per-cone gradients would make a short lane fade as fast as a long one,
  // reading as "less certain" when it is the opposite.
  const fn = mapScript.slice(mapScript.indexOf('function lanePaths'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /gradientUnits="userSpaceOnUse"/, 'the fade is in map pixels');
  assert.match(body, /longest = Math\.max\(longest/, 'scaled to the longest lane');
  assert.match(body, /lanefade-' \+ key/, 'and keyed per stand');
});
