import test from 'node:test';
import assert from 'node:assert/strict';
import { thermalAt, thermalStrength, rankStands, summarise } from '../stand-ranking.mjs';

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
  assert.ok(ranked[0].reasons.some(r => /set up for/.test(r.why)));
});

test('a stand with no recorded winds is unknown, never a quiet yes', () => {
  // The rule that matters most here: "I have not been told" and "yes" must not
  // score the same, or the tool will send you somewhere the deer will smell you.
  const ranked = rankStands({ sit: sitNW, stands: [stand('Untold', [])] });
  assert.equal(ranked[0].huntable, null);
  assert.equal(ranked[0].total, 0, 'unknown scores zero, not a bonus');
  assert.ok(ranked[0].reasons.some(r => /not recorded/.test(r.why)),
    'and it says what to do about it');
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

test('detections count once they exist', () => {
  const ranked = rankStands({
    sit: sitNW,
    stands: [stand('Hot', ['NW'], {
      nearbyCameras: [{ name: 'Creek Bottom', metres: 80, recentDetections: 6 }],
    })],
  });
  assert.ok(ranked[0].reasons.some(r => r.points > 0 && /6 recent detections/.test(r.why)));
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
