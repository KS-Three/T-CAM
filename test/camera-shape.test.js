import test from 'node:test';
import assert from 'node:assert/strict';
import {
  walk, leafKey, skeleton, displayValue, shapeLines, blanksFor, blankLines, PROBES,
} from '../camera-shape.mjs';
import { FLEX_M, ODD_SHAPE } from '../fixtures/cameras.js';
import { PROVIDERS } from '../providers/index.mjs';

const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

// --- walking a document ----------------------------------------------------

test('a coordinate pair is walked as the pair AND as its numbers', () => {
  // Both forms are yielded, and anything redacting this output has to cover
  // both: a rule written for the pair alone prints the two halves separately,
  // which is the same fix in two lines instead of one.
  const leaves = [...walk({ position: { coordinates: [-90.65, 44.12] } })];
  assert.deepEqual(leaves, [
    ['position.coordinates', [-90.65, 44.12]],
    ['position.coordinates[0]', -90.65],
    ['position.coordinates[1]', 44.12],
  ]);
});

test('every form of a coordinate is redacted, the pair and its halves alike', () => {
  const lines = shapeLines({ position: { coordinates: [-90.654321, 44.123456] } });
  assert.deepEqual(lines, [
    'position.coordinates = [<number 6dp>, <number 6dp>]',
    'position.coordinates[0] = <number 6dp>',
    'position.coordinates[1] = <number 6dp>',
  ]);
});

test('leafKey drops array indices', () => {
  assert.equal(leafKey('status.powerSources[0].percentage'), 'percentage');
  assert.equal(leafKey('id'), 'id');
});

// --- redaction -------------------------------------------------------------

test('a DMS string keeps its FORMAT and loses its value', () => {
  // The format is the diagnostic half: "is this model sending degrees-minutes
  // or a decimal?" is the question a normalizer has to answer. The digits are
  // the half that is somebody's hunting property.
  const shown = displayValue('status.coordinates[0].latitude', 'N44 7.407360');
  assert.equal(shown, '"A## #.######"');
  assert.doesNotMatch(shown, /44|7|40/, 'no digit of the real fix survives');
});

test('a coordinate number is reported as a type and a precision, never a value', () => {
  const shown = displayValue('status.coordinates[0].position.coordinates', [-90.654321, 44.123456]);
  assert.equal(shown, '[<number 6dp>, <number 6dp>]');
  assert.doesNotMatch(shown, /90|44/);
});

test('the redaction reaches every path that mentions a position', () => {
  // Matched on the whole path, not the leaf: `dateTime` and `geohash` sit
  // beside the fix under a parent that names it, and a leaf-only rule would
  // print the geohash — which IS the position, in another alphabet.
  const geo = displayValue('status.coordinates[0].geohash', 'ExAmPlEgEoHaSh');
  assert.equal(geo, '"AaAaAaAaAaAaAa"');
  const bare = displayValue('latitude', 45.5);
  assert.equal(bare, '<number 1dp>');
});

test('identifiers are redacted; the values a diagnosis needs are not', () => {
  assert.equal(displayValue('ucid', '000000000000000'), '"###############"');
  assert.equal(displayValue('status.sim', '00000000000000000000'), '"####################"');
  assert.equal(displayValue('id', 'abc123'), '"aaa###"');
  // Everything that is not a place or an identity survives intact — a battery
  // percentage redacted would make the dump useless for its own purpose.
  assert.equal(displayValue('status.powerSources[0].percentage', 20), '20');
  assert.equal(displayValue('status.model', 'FLEX-M'), '"FLEX-M"');
  assert.equal(displayValue('config.name', 'North Ridge'), '"North Ridge"');
  assert.equal(displayValue('status.lastUpdate', '2025-11-28T15:00:42.000Z'),
    '"2025-11-28T15:00:42.000Z"', 'a timestamp is not a location');
});

test('a timestamp under a position survives; a coordinate that reads as a date does not', () => {
  // The fix DATE is what says which of several fixes is newest — the subject of
  // a field bug this repo has already had — so it is kept.
  assert.equal(displayValue('status.coordinates[0].dateTime', '2025-11-28T15:00:42.000Z'),
    '"2025-11-28T15:00:42.000Z"');
  assert.equal(displayValue('status.coordinates[0].installDate', '2025-11-28'), '"2025-11-28"');

  // And the trap it must not fall into: Date.parse reads "90.6" as June 1990
  // and "-90" as 1990, so a date-ish test would hand back a coordinate.
  assert.equal(displayValue('status.gps.lon', '90.6'), '"##.#"');
  assert.equal(displayValue('status.gps.lat', '-90'), '"-##"');
  assert.equal(displayValue('coordinates.latitude', '44.123456'), '"##.######"');
});

test('--raw prints the true values, and is the only way to get them', () => {
  const raw = displayValue('status.coordinates[0].position.coordinates',
    [-90.654321, 44.123456], { raw: true });
  assert.equal(raw, '[-90.654321,44.123456]');
});

test('a whole FLEX-M dump carries no coordinate', () => {
  // The fixture's coordinates are invented, but this is the assertion that
  // matters for a real account: no line of a redacted dump may contain the fix.
  const lines = shapeLines(FLEX_M).join('\n');
  assert.doesNotMatch(lines, /-90\.654321|44\.123456/, 'no decimal fix');
  assert.doesNotMatch(lines, /7\.407360|39\.259260/, 'no DMS minutes');
  assert.doesNotMatch(lines, /ExAmPlEgEoHaSh/, 'no geohash');
  assert.match(lines, /status\.coordinates\[0\]\.dateTime = "2025-11-28T15:00:42\.000Z"/,
    'but the fix DATE is kept — it is not a place, and it says which fix is newest');
  assert.match(lines, /status\.model = "FLEX-M"/, 'the shape itself is still readable');
  assert.match(lines, /status\.powerSources\[0\]\.percentage = 20/);
});

test('skeleton keeps case and digits apart', () => {
  assert.equal(skeleton('N44 7.4'), 'A## #.#');
  assert.equal(skeleton('abcXYZ09'), 'aaaAAA##');
});

// --- what did not come through ---------------------------------------------

test('a fully read camera reports no blanks', () => {
  assert.deepEqual(blanksFor(FLEX_M, norm(FLEX_M)), []);
});

test('a field the document mentions but the normalizer missed is named', () => {
  // ODD_SHAPE puts the battery somewhere the extraction does not look. The
  // report must not claim to know which key is right — only that the document
  // talks about power and the row came back empty.
  const row = norm(ODD_SHAPE);
  assert.equal(row.battery, null, 'the fixture really does defeat the extraction');

  const blanks = blanksFor(ODD_SHAPE, row);
  const battery = blanks.find(b => b.label === 'battery');
  assert.ok(battery, 'battery is reported blank');
  assert.ok(battery.candidates.length > 0, 'and the document is shown to mention it');
  assert.ok(battery.candidates.some(c => c.path === 'power.remainingPct'),
    'the unread key is named by its path');

  const lines = blankLines(blanks).join('\n');
  assert.match(lines, /battery \(battery\) — read nothing, but the document mentions:/);
  assert.match(lines, /power\.remainingPct = 64/);
});

test('a field nothing in the document mentions reads as unreported, not as a bug', () => {
  // The two need opposite responses — one is a normalizer to teach, the other
  // is a camera that did not say — so they must never collapse into one line.
  const bare = { id: 'x', config: { name: 'Bare' }, status: {} };
  const blanks = blanksFor(bare, norm(bare));
  const temp = blanks.find(b => b.label === 'temperature');
  assert.deepEqual(temp.candidates, []);
  const lines = blankLines([temp]).join('\n');
  assert.match(lines, /nothing in the document mentions it/);
  assert.match(lines, /the camera did not report this/);
  assert.doesNotMatch(lines, /read nothing, but/);
});

test('a half-read position fires the probe rather than waiting for both to go', () => {
  // A camera that gave a latitude and no longitude is MORE broken than one
  // that gave neither, and a rule requiring every field to be null would stay
  // silent through exactly that.
  const half = { id: 'x', config: { name: 'Half' }, latitude: 45.5, status: {} };
  const row = norm(half);
  assert.equal(row.lat, 45.5);
  assert.equal(row.lng, null);
  const pos = blanksFor(half, row).find(b => b.label === 'position');
  assert.ok(pos, 'the probe fired on one missing field');
  assert.deepEqual(pos.missing, ['lng'], 'and named only the field that is missing');
});

test('candidate values are redacted too', () => {
  // The candidates are raw document values, so the leak this closes in the
  // dump would reopen here if the report printed them straight.
  // latDeg/lonDeg, not lat/lon: the normalizer's generic hunt reads the plain
  // names perfectly well, so a fixture using them would prove nothing.
  const gpsOnly = { id: 'x', config: { name: 'GPS' }, status: {},
    gps: { fix: { latDeg: 44.123456, lonDeg: -90.654321 } } };
  const row = norm(gpsOnly);
  const pos = blanksFor(gpsOnly, row).find(b => b.label === 'position');
  const shown = pos.candidates.map(c => c.display).join(' ');
  assert.doesNotMatch(shown, /44\.123456|-90\.654321/);
  assert.match(shown, /<number 6dp>/);
});

test('the candidate list is capped, so one document cannot bury the report', () => {
  // Named for power rather than battery: /batter/i is what the normalizer
  // itself hunts on, so `battery0` would be READ and the probe never fire.
  const noisy = { id: 'x', config: { name: 'Noisy' }, status: {} };
  for (let i = 0; i < 20; i++) noisy['powerCell' + i] = i + 1;
  const b = blanksFor(noisy, norm(noisy)).find(x => x.label === 'battery');
  assert.ok(b.candidates.length <= 6, `capped, got ${b.candidates.length}`);
});

test('every probe names fields that exist on the normalized row', () => {
  // A probe pointing at a field name no provider produces would be permanently
  // silent, and silence is indistinguishable from "nothing wrong".
  const row = norm(FLEX_M);
  for (const p of PROBES) {
    for (const f of p.fields) {
      assert.ok(f in row, `${p.label} probes ${f}, which is not on a normalized camera`);
    }
  }
});

test('a missing raw document does not throw', () => {
  // gps-doctor's lesson: a comparison against nothing must refuse, not invent.
  const row = norm(FLEX_M);
  assert.doesNotThrow(() => blanksFor(null, row));
  assert.doesNotThrow(() => blanksFor(undefined, row));
  assert.deepEqual(blanksFor(FLEX_M, null), []);
});
