// The GPS doctor decodes the two encodings we do NOT normally read — the DMS
// strings and the geohash — so it can tell us when SpyPoint's own document
// disagrees with itself. That arithmetic is the whole value of the tool: if it
// is wrong it invents a disagreement and sends the next session chasing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dms, geohash } from '../gps-doctor.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

test('DMS decodes to the same point the GeoJSON array carries', () => {
  // The fixture is built so these two agree exactly — that relationship is
  // what pins the [longitude, latitude] ordering in extract.test.js.
  const fix = FLEX_M.status.coordinates[0];
  const [lng, lat] = fix.position.coordinates;
  assert.ok(Math.abs(dms(fix.latitude) - lat) < 1e-9, 'latitude');
  assert.ok(Math.abs(dms(fix.longitude) - lng) < 1e-9, 'longitude');
});

test('south and west come back negative', () => {
  assert.equal(dms('S44 7.407360'), -44.123456);
  assert.equal(dms('E90 39.259260'), 90.654321);
});

test('junk decodes to null rather than a plausible-looking number', () => {
  for (const bad of ['', null, undefined, 'not a fix', '44.123456', 'Q44 7.4']) {
    assert.equal(dms(bad), null, JSON.stringify(bad));
  }
});

test('geohash decodes to the cell it names', () => {
  // "ezs42" is the canonical worked example from the geohash spec.
  const p = geohash('ezs42');
  assert.ok(Math.abs(p.lat - 42.6) < 0.05, 'lat ' + p.lat);
  assert.ok(Math.abs(p.lng - -5.6) < 0.05, 'lng ' + p.lng);
});

test('geohash rejects letters its alphabet does not contain', () => {
  // a, i, l and o are excluded — the fixture's placeholder hash has them.
  assert.equal(geohash(FLEX_M.status.coordinates[0].geohash), null);
  assert.equal(geohash('has-a-dash'), null);
  assert.equal(geohash(''), null);
});
