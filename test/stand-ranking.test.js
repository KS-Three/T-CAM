import test from 'node:test';
import assert from 'node:assert/strict';
import { thermalAt, thermalStrength, rankStands, summarise, verdict } from '../stand-ranking.mjs';

// A shooting lane is measured geometry, not a ticked compass point: it is a
// place on the ground you can shoot to, and the winds fall out of the shape.
const M_LAT = 1 / 111320, M_LNG = 1 / (111320 * Math.cos(44.1 * Math.PI / 180));
const laneTo = (deg, m = 60, label = null) => {
  const r = deg * Math.PI / 180;
  return { to: [-90.6 + Math.sin(r) * m * M_LNG, 44.1 + Math.cos(r) * m * M_LAT], label };
};

const stand = (name, winds, extra = {}) => ({
  id: extra.id ?? 1, name, type: 'stand', lat: 44.1, lng: -90.6,
  winds, nearbyCameras: [], ...extra,
});

// ---------------------------------------------------------------------------
// Thermals
// ---------------------------------------------------------------------------

test('a thermal blows the way physics says, in both windows', () => {
  // Ground FACING south descends southward. Morning air cools and sinks, so it
  // runs downhill to the south and therefore arrives FROM the north. Evening
  // air warms and climbs north, arriving from the south. Inverting this would
  // sit you downwind of everything you are hunting, and nothing else in the
  // tool would look wrong.
  const facingSouth = { slopeDeg: 10, aspectDeg: 180 };
  assert.equal(thermalAt(facingSouth, 'AM').fromDeg, 0, 'morning thermal comes from uphill');
  assert.equal(thermalAt(facingSouth, 'PM').fromDeg, 180, 'evening thermal comes from downhill');

  const facingEast = { slopeDeg: 10, aspectDeg: 90 };
  assert.equal(thermalAt(facingEast, 'AM').fromDeg, 270);
  assert.equal(thermalAt(facingEast, 'PM').fromDeg, 90);
});

test('flat ground gets no thermal and no direction', () => {
  // Kent's ground is half a degree. A confident arrow there would be a lie, and
  // a believable one.
  const flat = thermalAt({ slopeDeg: 0.5, aspectDeg: 180 }, 'AM');
  assert.equal(flat.strength, 'none');
  assert.equal(flat.fromDeg, null, 'no direction at all, not north');
  assert.equal(flat.weight, 0);
  assert.match(flat.note, /too flat/);

  // Aspect is null on genuinely flat cells, which must not become a direction.
  const noAspect = thermalAt({ slopeDeg: 9, aspectDeg: null }, 'AM');
  assert.equal(noAspect.fromDeg, null);
});

test('thermal strength follows slope, in bands rather than false precision', () => {
  assert.equal(thermalStrength(0.5).strength, 'none');
  assert.equal(thermalStrength(3).strength, 'weak');
  assert.equal(thermalStrength(8).strength, 'moderate');
  assert.equal(thermalStrength(20).strength, 'strong');
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const sitNW = { window: 'AM', windDir: 315 };

test('the stand that suits the wind wins', () => {
  const ranked = rankStands({
    sit: sitNW,
    stands: [stand('Wrong', ['S', 'SSW'], { id: 2 }), stand('Right', ['NW', 'N'], { id: 1 })],
  });
  assert.equal(ranked[0].name, 'Right');
  assert.equal(ranked[0].huntable, true);
  assert.equal(ranked[1].huntable, false);
  assert.ok(ranked[0].total > ranked[1].total);
  // The reason names the wind and says what allows it — lanes where they are
  // marked, the ticked winds otherwise.
  assert.ok(ranked[0].reasons.some(r => /wind is NW, which .* allow/.test(r.why)));
});

test('a stand with no recorded winds is unknown, never a quiet yes', () => {
  // The rule that matters most here: "I have not been told" and "yes" must not
  // score the same, or the tool will send you somewhere the deer will smell you.
  const ranked = rankStands({ sit: sitNW, stands: [stand('Untold', [])] });
  assert.equal(ranked[0].huntable, null);
  assert.equal(ranked[0].total, 0, 'unknown scores zero, not a bonus');
  assert.ok(ranked[0].reasons.some(r => /no shooting lanes or good winds recorded/.test(r.why)),
    'it says what is missing');
  assert.ok(ranked[0].reasons.some(r => /mark the lanes on the map/.test(r.why)),
    'and what to do about it');
});

test('a known-good stand outranks an unknown one', () => {
  const ranked = rankStands({
    sit: sitNW,
    stands: [stand('Untold', [], { id: 2 }), stand('Known', ['NW'], { id: 1 })],
  });
  assert.equal(ranked[0].name, 'Known');
});

test('a thermal that fights the stand is a penalty, and says so', () => {
  // The interaction worth catching: the forecast wind is fine and the thermal
  // quietly undoes it near dawn and dusk.
  const terrainAt = () => ({ slopeDeg: 15, aspectDeg: 90 });   // faces east, steep
  const ranked = rankStands({
    sit: { window: 'PM', windDir: 315 },
    stands: [stand('Ridge', ['NW'])],
    terrainAt,
  });
  const s = ranked[0];
  assert.equal(s.huntable, true, 'the forecast wind suits it');
  assert.equal(s.thermal.strength, 'strong');
  const penalty = s.reasons.find(r => r.points < 0);
  assert.ok(penalty, 'but the thermal costs it points');
  assert.match(penalty.why, /thermal usually wins/);
  assert.ok(s.total < 30, 'so it no longer scores as a clean pick');
});

test('a thermal that agrees with the stand is a small bonus', () => {
  const terrainAt = () => ({ slopeDeg: 15, aspectDeg: 90 });
  const ranked = rankStands({
    sit: { window: 'PM', windDir: 315 },
    stands: [stand('Ridge', ['NW', 'E'])],   // E is the evening thermal here
    terrainAt,
  });
  assert.ok(ranked[0].reasons.some(r => r.points > 0 && /also suits/.test(r.why)));
});

test('flat ground contributes nothing either way', () => {
  const terrainAt = () => ({ slopeDeg: 0.5, aspectDeg: 180 });
  const ranked = rankStands({ sit: sitNW, stands: [stand('Flat', ['NW'])], terrainAt });
  assert.equal(ranked[0].total, 30, 'wind only — the thermal neither helps nor hurts');
  assert.ok(ranked[0].reasons.some(r => /too flat/.test(r.why)), 'and it says why');
});

test('camera coverage is reported honestly while no photos exist', () => {
  const ranked = rankStands({
    sit: sitNW,
    stands: [stand('Covered', ['NW'], { nearbyCameras: [{ name: 'Creek Bottom', metres: 80 }] })],
  });
  const r = ranked[0].reasons.find(x => /Creek Bottom/.test(x.why));
  assert.ok(r, 'the covering camera is named');
  assert.equal(r.points, 0, 'but contributes nothing until there are photos');
  assert.match(r.why, /no photos have been synced/);
});

test('your own photographs count once there are enough matched hours', () => {
  // Replaced 2026-08-30. This used to be a raw 30-day detection count, which is
  // a fact about how long a camera was out rather than about the ground. It is
  // now a RATE per hundred matched camera-hours, produced by evidence.mjs, and
  // the stand is credited in proportion to the best camera on the property.
  const evidence = {
    condition: 'dusk on a NW wind',
    minHours: 10,
    rows: [
      { cameraId: 'c1', name: 'Creek Bottom', hours: 120, detections: 9, per100: 7.5, enough: true, nocturnalShare: 40 },
      { cameraId: 'c2', name: 'Far Corner', hours: 130, detections: 1, per100: 0.8, enough: true, nocturnalShare: 50 },
    ],
  };
  const ranked = rankStands({
    sit: sitNW, evidence,
    stands: [
      stand('Hot', ['NW'], { id: 1, nearbyCameras: [{ id: 'c1', name: 'Creek Bottom', metres: 80 }] }),
      stand('Cold', ['NW'], { id: 2, nearbyCameras: [{ id: 'c2', name: 'Far Corner', metres: 90 }] }),
    ],
  });
  assert.equal(ranked[0].name, 'Hot', 'the productive camera wins on an equal wind');
  assert.ok(ranked[0].reasons.some(r => r.points > 0 && /7\.5 per 100/.test(r.why)),
    'and the rate is shown, with its denominator');
  assert.ok(ranked[0].reasons.some(r => /120 camera-hours/.test(r.why)));
  assert.ok(ranked[1].total < ranked[0].total);
});

test('a camera with too few matched hours is refused, not guessed at', () => {
  const evidence = {
    condition: 'dusk on a NW wind',
    minHours: 10,
    rows: [{ cameraId: 'c1', name: 'Creek Bottom', hours: 4, detections: 3, per100: null, enough: false, nocturnalShare: 33 }],
  };
  const ranked = rankStands({
    sit: sitNW, evidence,
    stands: [stand('Thin', ['NW'], { id: 1, nearbyCameras: [{ id: 'c1', name: 'Creek Bottom', metres: 80 }] })],
  });
  const r = ranked[0].reasons.find(x => /matched camera-hours/.test(x.why));
  assert.ok(r, 'it says the data is too thin');
  assert.equal(r.points, 0, 'and three deer in four hours buys nothing');
  assert.equal(ranked[0].total, 30, 'the stand is still ranked on wind alone');
});

test('a mostly-nocturnal camera says so on the stand it recommends', () => {
  const evidence = {
    condition: 'dusk on a NW wind',
    minHours: 10,
    rows: [{ cameraId: 'c1', name: 'Night Owl', hours: 200, detections: 20, per100: 10, enough: true, nocturnalShare: 91 }],
  };
  const ranked = rankStands({
    sit: sitNW, evidence,
    stands: [stand('Busy', ['NW'], { id: 1, nearbyCameras: [{ id: 'c1', name: 'Night Owl', metres: 80 }] })],
  });
  assert.ok(ranked[0].reasons.some(r => /91% of everything it sees is after dark/.test(r.why)),
    'the rate alone would recommend a stand you will never see a deer from');
});

test('no wind forecast is not treated as a passing wind', () => {
  const ranked = rankStands({ sit: { window: 'AM', windDir: null }, stands: [stand('A', ['NW'])] });
  assert.equal(ranked[0].total, 0);
  assert.ok(ranked[0].reasons.some(r => /no wind forecast/.test(r.why)));
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('the summary says something true when there is nothing to recommend', () => {
  assert.match(summarise([]), /No stands yet/);

  const noWinds = rankStands({ sit: sitNW, stands: [stand('A', []), stand('B', [], { id: 2 })] });
  assert.match(summarise(noWinds), /none can be ranked on wind/,
    'it asks for the missing information rather than guessing');

  const allWrong = rankStands({ sit: sitNW, stands: [stand('A', ['S'])] });
  assert.match(summarise(allWrong), /No stand is set up for a NW wind/);
  assert.match(summarise(allWrong), /puts your scent where the deer are/,
    'and does not offer a least-bad option as if it were a good one');
});

test('the summary names the pick, and flags a fighting thermal', () => {
  const terrainAt = () => ({ slopeDeg: 15, aspectDeg: 90 });
  const ranked = rankStands({
    sit: { window: 'PM', windDir: 315 }, stands: [stand('Ridge', ['NW'])], terrainAt,
  });
  const text = summarise(ranked, { hasTerrain: true });
  assert.match(text, /Ridge suits a NW wind/);
  assert.match(text, /thermal there works against you/);
});

test('the summary admits when thermals were not considered at all', () => {
  const ranked = rankStands({ sit: sitNW, stands: [stand('A', ['NW'])] });
  assert.match(summarise(ranked, { hasTerrain: false }), /Load Terrain/);
});

// ---------------------------------------------------------------------------
// Confidence — how much to believe the order, which is NOT how high it scored
// ---------------------------------------------------------------------------

test('a stand with no recorded winds has no confidence at all', () => {
  const ranked = rankStands({ sit: sitNW, stands: [stand('Untold', [])] });
  assert.equal(ranked[0].confidence.tier, 'none');
  assert.match(ranked[0].confidence.why, /neither shooting lanes nor recorded winds/);
});

test('a high score on no evidence is low confidence, and says so', () => {
  // The failure this exists to prevent: a stand tops the list on a perfect wind
  // and nothing else, and the number looks like the output of a model.
  const ranked = rankStands({ sit: sitNW, stands: [stand('Lucky', ['NW'])] });
  assert.equal(ranked[0].total, 30, 'it scores well');
  assert.ok(['low', 'moderate'].includes(ranked[0].confidence.tier),
    'but a good wind alone is not a confident recommendation');
  assert.ok(ranked[0].confidence.factors.some(f => /none of your own photographs/.test(f)));
  assert.ok(ranked[0].confidence.factors.some(f => /no sits logged/.test(f)));
});

test('confidence rises as the things it is made of arrive', () => {
  const evidence = {
    condition: 'dusk on a NW wind', minHours: 10,
    rows: [{ cameraId: 'c1', name: 'Creek', hours: 300, detections: 20, per100: 6.7, enough: true, nocturnalShare: 30 }],
  };
  const bare = rankStands({ sit: sitNW, stands: [stand('S', ['NW'], { id: 1 })] })[0];
  const full = rankStands({
    sit: sitNW, evidence,
    stands: [stand('S', ['NW'], { id: 1, lanes: [laneTo(135, 60, 'the crossing')],
      nearbyCameras: [{ id: 'c1', name: 'Creek', metres: 60 }] })],
    sits: [{ stand_id: 1, ended_at: '2026-10-01T18:00:00Z' }],
    now: Date.parse('2026-11-07T12:00:00Z'),
  })[0];
  assert.ok(full.confidence.score > bare.confidence.score,
    `lanes + photos + logged sits should beat nothing (${full.confidence.score} vs ${bare.confidence.score})`);
  assert.ok(full.confidence.factors.some(f => /lanes you traced/.test(f)));
  assert.ok(full.confidence.factors.some(f => /camera-hours of your own/.test(f)));
});

test('two stands a point apart are called level rather than ranked', () => {
  const ranked = rankStands({
    sit: sitNW,
    stands: [stand('A', ['NW'], { id: 1 }), stand('B', ['NW'], { id: 2 })],
  });
  assert.equal(ranked[0].total, ranked[1].total, 'a genuine tie');
  assert.ok(ranked[0].confidence.factors.some(f => /treat these two as level/.test(f)));
});

test('the verdict answers where, why and how much to believe it, in one place', () => {
  const ranked = rankStands({
    sit: { ...sitNW, date: '2026-11-07' },
    stands: [stand('Creek', ['NW'], { id: 1 }), stand('Wrong', ['S'], { id: 2 })],
  });
  const v = verdict(ranked, { sit: { ...sitNW, date: '2026-11-07' } });
  assert.equal(v.stand, 'Creek');
  assert.ok(v.why.length, 'the reasons that moved the number');
  assert.ok(v.why.every(r => r.points !== 0), 'and only those');
  assert.ok(v.confidence, 'with a confidence beside it');
  assert.ok(v.todo.some(t => /trace|log|draw|mark/i.test(t.why)),
    'and what to do to make the answer better');
});
