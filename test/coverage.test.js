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
  windsForStand, laneSpread, LANE_SPREAD_DEG,
  MIN_LANE_SPREAD_DEG, MAX_LANE_SPREAD_DEG,
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
    // Widths, including ones outside the bounds: the clamp has to happen the
    // same way on both sides, or a lane dragged to its limit would be drawn at
    // one angle and judged at another.
    [{ ...lane(0), spread: 45 }],
    [{ ...lane(0), spread: 3 }, { ...lane(140, 90), spread: 70 }, lane(250)],
    [{ ...lane(0), spread: 500 }, { ...lane(90), spread: 0.5 }],
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

  // The width handles need these three in the browser to turn a drag into an
  // angle. They are exported rather than reimplemented, so check they crossed.
  assert.equal(typeof browser.bearing, 'function');
  assert.equal(typeof browser.angleBetween, 'function');
  assert.equal(typeof browser.laneSpread, 'function');
  assert.equal(browser.MIN_LANE_SPREAD_DEG, MIN_LANE_SPREAD_DEG);
  assert.equal(browser.MAX_LANE_SPREAD_DEG, MAX_LANE_SPREAD_DEG);
  assert.equal(browser.LANE_SPREAD_DEG, LANE_SPREAD_DEG);

  // A handle held due east of a stand whose lane runs due north is a
  // 90-degree drag, which the bounds pull back to the widest a lane may be.
  const east = { lat: LAT, lng: LNG + 60 * M_LNG };
  const off = browser.angleBetween(
    browser.bearing(stand.lat, stand.lng, east.lat, east.lng),
    browser.bearing(stand.lat, stand.lng, lane(0).to[1], lane(0).to[0]));
  assert.ok(Math.abs(off - 90) < 0.5, `expected about 90, got ${off}`);
  assert.equal(browser.laneSpread({ spread: off }), MAX_LANE_SPREAD_DEG);
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
  //
  // This used to carry its own copy of the recentring arithmetic, offsetting
  // by half the form's height on the assumption the form was always a strip
  // along the bottom. It is now one of two shapes, so it asks the function
  // that measures — and has to repaint first, because the class that turns the
  // panel into the strip lands in that repaint.
  const trace = mapScript.slice(mapScript.indexOf('traceBtn.onclick'));
  const body = trace.slice(0, trace.indexOf('\n  };'));
  const paint = body.indexOf('paintLanes()');
  const recentre = body.indexOf('centreClearOfForm(form, stand)');
  assert.ok(paint !== -1 && recentre !== -1, 'it repaints and recentres');
  assert.ok(paint < recentre, 'and measures the strip it has become, not the panel it was');
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

test('the cone is drawn at the arc the wind derivation uses, by asking it', () => {
  // This used to compare two numbers and assert they matched. Now that a lane
  // carries its own width there is no single number to compare, and copying
  // the "spread or the default, clamped" rule into the drawing code is exactly
  // how a picture starts disagreeing with the model behind it. So the map does
  // not have that rule: it calls the one the derivation uses.
  assert.match(mapScript, /const laneHalfDeg = l => COVER\.laneSpread\(l\)/,
    'the map asks the model for the width');
  assert.doesNotMatch(mapScript, /LANE_HALF_DEG/,
    'and keeps no constant of its own that could drift');
  // The handles turn a drag into an angle. Doing that with a second copy of
  // the trigonometry is the same failure one step along.
  assert.match(mapScript, /COVER\.bearing\(/, 'bearings come from the model too');
  assert.match(mapScript, /COVER\.angleBetween\(/);
});

test('a lane keeps its own width, and falls back rather than storing one', () => {
  assert.equal(laneSpread({ to: [0, 0] }), LANE_SPREAD_DEG, 'no width set means the default');
  assert.equal(laneSpread({ to: [0, 0], spread: 25 }), 25);
  // A width outside what a lane can sensibly be is pulled back to the bound,
  // not honoured and not discarded: the drag that produced it still meant
  // "wider" or "narrower".
  assert.equal(laneSpread({ to: [0, 0], spread: 200 }), MAX_LANE_SPREAD_DEG);
  assert.equal(laneSpread({ to: [0, 0], spread: 0.1 }), MIN_LANE_SPREAD_DEG);
  // Not a number at all is not a width. Storing NaN as one would make every
  // angular test false and quietly free up all sixteen winds.
  assert.equal(laneSpread({ to: [0, 0], spread: 'wide' }), LANE_SPREAD_DEG);
  assert.equal(laneSpread({ to: [0, 0], spread: null }), LANE_SPREAD_DEG);
});

test('the geometry reports the width actually used for that lane', () => {
  const g = laneGeometry(stand, { ...lane(90), spread: 30 });
  assert.equal(g.spreadDeg, 30);
  assert.equal(laneGeometry(stand, lane(90)).spreadDeg, LANE_SPREAD_DEG);
  // The fallback is overridable per call, which is what lets the derivation
  // test a hypothetical width without rewriting the lanes.
  assert.equal(laneGeometry(stand, lane(90), { spreadDeg: 4 }).spreadDeg, 4);
});

test('widening a lane rules out more winds, and only that lane widens', () => {
  // The point of the handles: the shape you drew is the shape you are judged
  // on. A lane you opened up to cover a whole field really does cost you the
  // winds that blow across it.
  const narrow = huntableFromLanes(stand, [{ ...lane(0), spread: 5 }]);
  const wide = huntableFromLanes(stand, [{ ...lane(0), spread: 45 }]);
  assert.ok(wide.winds.length < narrow.winds.length,
    `wide ${wide.winds.length} should be fewer than narrow ${narrow.winds.length}`);
  // Every wind the wide lane still allows was allowed when it was narrow —
  // widening can only ever take winds away.
  for (const w of wide.winds) assert.ok(narrow.winds.includes(w), w);

  // Two lanes, one widened: the other keeps its own answer.
  const mixed = huntableFromLanes(stand, [{ ...lane(0), spread: 45 }, lane(180)]);
  assert.equal(mixed.lanes[0].spreadDeg, 45);
  assert.equal(mixed.lanes[1].spreadDeg, LANE_SPREAD_DEG);
});

test('a widened lane blocks exactly the winds the geometry says it should', () => {
  // Worked by hand rather than by re-running the implementation. A lane due
  // north with a 40-degree half-angle is blocked by any wind whose downwind
  // direction falls within 30 + 40 = 70 degrees of north — that is, a wind
  // FROM within 70 degrees of SOUTH. S is 180; 110 through 250 inclusive.
  const d = huntableFromLanes(stand, [{ ...lane(0), spread: 40 }]);
  const blocked = new Set(d.blocked.map(b => b.point));
  for (let i = 0; i < 16; i++) {
    const from = i * 22.5;
    const off = Math.abs(180 - from);
    assert.equal(blocked.has(COMPASS[i]), off <= 70,
      `${COMPASS[i]} (from ${from} degrees)`);
  }
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

// ---------------------------------------------------------------------------
// The handles
//
// Three per lane on the stand whose form is open: a tip that moves the far end
// and a pair on the rim that open and close the cone. These are checked as
// source text rather than driven in a browser, which is a real limit — but the
// specific ways this breaks are structural, and each of them shipped once in
// some form already: geometry that goes stale, a target too small for a
// finger, and a listener destroyed by the redraw it triggers.

test('the handles are drawn from the open form, not the saved stand', () => {
  // The map used to draw the SAVED lanes whenever a form was open but not
  // armed for tracing. Widening a lane would then have shown nothing at all
  // until after a save, which is the one moment the picture has to be live.
  const fn = mapScript.slice(mapScript.indexOf('function lanePaths'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(laneForm\) sets\.push/, 'the open form is a source of lanes');
  assert.match(body, /laneForm\.standId && st\.id === laneForm\.standId/,
    'and the saved copy of that same stand is skipped');
  assert.doesNotMatch(body, /laneEdit/,
    'drawing must not depend on the trace mode being armed');
});

test('each lane of the open form gets a tip and two width handles', () => {
  const fn = mapScript.slice(mapScript.indexOf('function laneGrips'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const kind of ["'left'", "'right'", "'tip'"]) {
    assert.ok(body.includes('grip(') && body.includes(kind), `a ${kind} handle`);
  }
  // Which lane and which handle travel on the element, because the SVG is
  // rebuilt on every draw and a closure over the index would not survive it.
  assert.match(body, /data-lane="/);
  assert.match(body, /data-grip="/);
});

test('the grab target is a finger wide even though the dot is not', () => {
  // Used on a phone, in the cold, over the ground you are trying to point at.
  // A five-pixel target cannot be hit; a sixteen-pixel dot covers the thing
  // you are aiming for. So they are different circles.
  const fn = mapScript.slice(mapScript.indexOf('function laneGrips'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const grab = body.match(/const grab = Math\.max\((\d+), Math\.min\((\d+), r \* ([\d.]+)\)\)/);
  assert.ok(grab, 'the grab radius is computed from the lane, not fixed');
  assert.ok(Number(grab[2]) >= 14, `cap ${grab[2]} is too small for a fingertip`);
  assert.match(body, /const dot = Math\.max/, 'and the visible dot is smaller');
  assert.match(mapStyles, /circle\.lanegrip \{ fill: transparent/, 'the target is invisible');
  assert.match(mapStyles, /circle\.lanegrip[^}]*pointer-events: all/,
    'the overlay turns pointer-events off; the handles turn it back on');
  assert.match(mapStyles, /circle\.lanegrip[^}]*touch-action: none/,
    'or a drag on a phone scrolls the page instead');
});

test('the width handles stay clear of the tip at every width a lane can be', () => {
  // Measured before this existed: on a default 20-degree cone the rim corners
  // are a tenth of the lane's length from the tip — 10 pixels on a 60-pixel
  // lane — so the tip's grab circle covered both, and a drag meant to widen
  // the lane moved its far end instead. Verified by driving it in a browser.
  //
  // Pulling the width handles back along the edge fixes it, and this is the
  // arithmetic that says by how much. The tip-to-handle distance scales with
  // the lane; so does the grab radius; the first has to stay bigger.
  const fn = mapScript.slice(mapScript.indexOf('const WIDTH_GRIP_AT'));
  const k = Number(fn.match(/const WIDTH_GRIP_AT = ([\d.]+)/)[1]);
  const g = fn.match(/const grab = Math\.max\(\d+, Math\.min\(\d+, r \* ([\d.]+)\)\)/);
  const grabPerR = Number(g[1]);
  for (const halfDeg of [MIN_LANE_SPREAD_DEG, LANE_SPREAD_DEG, 25, 45, MAX_LANE_SPREAD_DEG]) {
    const h = halfDeg * Math.PI / 180;
    // Distance from the tip (at radius 1, on the centre line) to a width
    // handle (at radius k, h off it), in units of the lane's length.
    const d = Math.hypot(k * Math.sin(h), 1 - k * Math.cos(h));
    assert.ok(d > 2 * grabPerR,
      `at ${halfDeg} degrees the handles are ${d.toFixed(3)}r apart `
      + `but the grab circles span ${(2 * grabPerR).toFixed(3)}r`);
  }
});

test('the stand form moves off the stand it is editing', () => {
  // A panel in the middle of the map covers the stand you just clicked, so its
  // handles are underneath it. Driven in a browser before this: the press
  // landed on the tick grid and the cone never moved.
  assert.match(mapStyles, /\.standform\.aside \{ left: 10px; top: 10px; transform: none/);
  assert.match(mapStyles, /@media \(max-width: 700px\)[^]*?\.standform\.aside \{[^}]*bottom: 10px/,
    'and becomes a bottom sheet where there is no room beside it');
  assert.match(mapScript, /form\.classList\.add\('aside'\)/);
  assert.match(mapScript, /centreClearOfForm\(form, stand\)/,
    'and the map puts the stand in what is left');
  // Measured from the form's real box: it grows with the number of lanes and
  // changes shape on a phone, so a guess at its size would be wrong on both.
  const fn = mapScript.slice(mapScript.indexOf('function centreClearOfForm'));
  assert.match(fn.slice(0, 900), /form\.getBoundingClientRect\(\)/);
});

test('the drag is captured to the SVG, which survives its own redraw', () => {
  // The handles are destroyed and recreated on every draw, including the draw
  // the drag itself causes. A listener on the circle would be gone after the
  // first move; on touch, where the pointer is implicitly captured to the
  // original target, the rest of the gesture would go to a detached node.
  assert.match(mapScript, /contoursEl\.addEventListener\('pointerdown'/);
  assert.match(mapScript, /contoursEl\.addEventListener\('pointermove'/);
  assert.match(mapScript, /contoursEl\.setPointerCapture/);
  assert.match(mapScript, /contoursEl\.releasePointerCapture/);
});

test('a width drag reads an angle; only the tip moves the lane', () => {
  const i = mapScript.indexOf("contoursEl.addEventListener('pointermove'");
  const body = mapScript.slice(i, mapScript.indexOf('\n});', i));
  assert.match(body, /gripDrag\.kind === 'tip'/);
  assert.match(body, /lane\.to = \[at\.lng, at\.lat\]/, 'the tip moves the far end');
  assert.match(body, /lane\.spread = /, 'a rim handle sets the width');
  // The tip dragged onto the stand leaves no length and no bearing, and a lane
  // with neither silently stops counting toward the winds.
  assert.match(body, /if \(Math\.hypot\(px - ax, py - ay\) < 8\) return;/,
    'a collapsed lane is refused, not stored');
  // The clamp is the model's, not a second opinion.
  assert.match(body, /COVER\.MAX_LANE_SPREAD_DEG/);
  assert.match(body, /COVER\.MIN_LANE_SPREAD_DEG/);
});

test('every way out of the stand form clears what hangs off it', () => {
  // Delete used to leave the map armed for tracing with no form to show for
  // it, and the marker and route forms share the stand form's class, so
  // opening one deleted the node and left the rest of the state behind.
  const closes = mapScript.match(/closeStandForm\(\)/g) || [];
  assert.ok(closes.length >= 6, `only ${closes.length} sites go through it`);
  const fn = mapScript.slice(mapScript.indexOf('function closeStandForm'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const cleared of ['editing', 'laneEdit', 'laneForm', 'gripDrag']) {
    assert.match(body, new RegExp(cleared + ' = null'), `${cleared} is cleared`);
  }
});
