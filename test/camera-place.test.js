/**
 * Putting a camera where it actually is.
 *
 * Reported from the field 2026-08-30: pins still in the wrong place after the
 * sync was taught to read the camera's NEWEST fix. That fix was right and
 * insufficient — the newest wrong answer is still wrong, and a cellular
 * camera's GPS under canopy is routinely wrong by a few hundred metres.
 *
 * The load-bearing test in here is the last one: that a sync does not quietly
 * undo the correction. That is the failure this feature exists to prevent, and
 * it is invisible until the next morning's sync.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, upsertCamera, allCameras, placeCamera, distanceM, weatherLocationFor,
} from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-place-'));
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);
const ID = 'spypoint:aaaaaaaaaaaaaaaaaaaaaaaa';

// The fixture's own fix, and a spot a few hundred metres off it.
const GPS = { lat: 44.123456, lng: -90.654321 };
const REAL = { lat: 44.126100, lng: -90.651000 };

const one = db => allCameras(db)[0];

test('a camera with no override reads as the vendor left it', () => {
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const c = one(db);
  assert.equal(c.lat, GPS.lat);
  assert.equal(c.gps_lat, GPS.lat, 'the vendor fix rides along under its own name');
  assert.equal(c.placed_at, null);
});

test('placing a camera moves where it IS without touching what the vendor said', () => {
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  placeCamera(db, ID, REAL);
  const c = one(db);
  assert.equal(c.lat, REAL.lat);
  assert.equal(c.lng, REAL.lng);
  assert.equal(c.gps_lat, GPS.lat, "the camera's own claim is kept, not overwritten");
  assert.equal(c.gps_lng, GPS.lng);
  assert.ok(c.placed_at, 'and the correction is dated');
  // The distance between the two is the evidence the panel shows.
  assert.ok(distanceM(c.lat, c.lng, c.gps_lat, c.gps_lng) > 200);
});

test('clearing the override hands the camera back to its own GPS', () => {
  // An override you cannot undo is a worse trap than none: a camera really
  // moved next season would be pinned at last year's spot for ever.
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  placeCamera(db, ID, REAL);
  placeCamera(db, ID, { lat: null, lng: null });
  const c = one(db);
  assert.equal(c.lat, GPS.lat);
  assert.equal(c.placed_at, null);
});

test('nonsense coordinates are refused before conversion, not after', () => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic. This program has
  // been bitten by that three times; a camera silently teleported there would
  // take the weather join, the ground clustering and the map framing with it.
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  for (const bad of [{ lat: 'north', lng: -90.6 }, { lat: 200, lng: -90.6 },
    { lat: 44.1, lng: 999 }, { lat: NaN, lng: -90.6 }]) {
    assert.throws(() => placeCamera(db, ID, bad), /real coordinates|out of range/);
  }
  assert.equal(one(db).lat, GPS.lat, 'and nothing moved');
  assert.throws(() => placeCamera(db, 'spypoint:nope', REAL), /no camera/);
});

test('the weather location follows the camera to where it really is', () => {
  // Locations are keyed on rounded coordinates, so a fix a few hundred metres
  // out can land on the far side of the rounding — and the analysis would then
  // join this camera's sightings to another point's weather.
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const far = { lat: 44.98, lng: -90.02 };
  placeCamera(db, ID, far);
  const moved = one(db);
  const loc = weatherLocationFor(db, far.lat, far.lng);
  assert.equal(moved.weather_location_id, loc.id);
});

test('a later sync does not quietly undo the correction', () => {
  // The failure this feature exists to prevent, and the one nobody would see
  // until the next morning. The sync stays authoritative for what the camera
  // REPORTED — including a brand new fix — and authoritative for nothing else.
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  placeCamera(db, ID, REAL);

  const later = {
    ...FLEX_M,
    status: {
      ...FLEX_M.status,
      powerSources: [{ location: 'TRAY1', type: 'AA', percentage: 77, level: 'high' }],
      coordinates: [{
        dateTime: '2026-08-30T12:00:00.000Z',
        position: { type: 'Point', coordinates: [-90.66, 44.11] },
      }],
    },
  };
  upsertCamera(db, norm(later), { provider: 'spypoint' });

  const c = one(db);
  assert.equal(c.lat, REAL.lat, 'still where you put it');
  assert.equal(c.lng, REAL.lng);
  assert.equal(c.gps_lat, 44.11, "and the camera's new claim is recorded too");
  assert.equal(c.gps_lng, -90.66);
  assert.equal(c.battery, 77, 'everything else the sync owns still updates');

  const loc = weatherLocationFor(db, REAL.lat, REAL.lng);
  assert.equal(c.weather_location_id, loc.id,
    'and the weather location stays with the placed position, not the new fix');
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t, seed) {
  const out = tmp();
  const db = openDb(out);
  if (seed) seed(db);
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return {
    get: async p => ({ status: (await fetch(base + p)).status }),
    json: async p => (await fetch(base + p)).json(),
    patch: async (p, body) => {
      const res = await fetch(base + p, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

const seedCam = db => upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });

test('a camera is moved over the API, colon in its id and all', async (t) => {
  // The id carries a provider prefix and a colon, so the route cannot match
  // digits the way a stand's does.
  const api = await serving(t, seedCam);
  const { status, body } = await api.patch(
    '/api/cameras/' + encodeURIComponent(ID), REAL);
  assert.equal(status, 200);
  assert.equal(body.lat, REAL.lat);
  assert.equal(body.gpsLat, GPS.lat);
  assert.ok(body.placedAt);

  const list = await api.json('/api/cameras');
  assert.equal(list[0].lat, REAL.lat, 'and the list agrees with the answer');
});

test('the API hands a camera back to its own GPS on an explicit null', async (t) => {
  const api = await serving(t, seedCam);
  await api.patch('/api/cameras/' + encodeURIComponent(ID), REAL);
  const { status, body } = await api.patch(
    '/api/cameras/' + encodeURIComponent(ID), { lat: null, lng: null });
  assert.equal(status, 200);
  assert.equal(body.lat, GPS.lat);
  assert.equal(body.placedAt, null);
});

test('the API refuses a camera it does not have, and a method it does not take', async (t) => {
  const api = await serving(t, seedCam);
  const missing = await api.patch('/api/cameras/spypoint:nope', REAL);
  assert.equal(missing.status, 404);
  const bad = await api.patch('/api/cameras/' + encodeURIComponent(ID), { lat: 91, lng: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /out of range/);
  const wrong = await api.get('/api/cameras/' + encodeURIComponent(ID));
  assert.equal(wrong.status, 405);
});
