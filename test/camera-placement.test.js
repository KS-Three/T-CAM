/**
 * Correcting a camera's pin.
 *
 * A camera's lat/lng is the fix its own GPS reported, and a trail camera's GPS
 * is a small antenna under a canopy — ten or twenty metres out is ordinary.
 * Everything measured FROM a camera inherits that error, and until now nothing
 * could say so: stands could be dragged, cameras could not.
 *
 * The rule these tests exist to hold down is that the correction sits BESIDE
 * the fix and never on top of it. Both are true statements about different
 * things — what the device reported, and where the person who hung it says it
 * is — and collapsing them would destroy the only evidence that a correction
 * happened at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertCamera, setCameraPlacement, cameraPoint, distanceM } from '../db.mjs';
import { createServer, cameraFromRow } from '../serve.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const norm = c => PROVIDERS.spypoint.normalizeCamera(c);
const FIX = { lat: 44.123456, lng: -90.654321 };          // what the fixture reports
const TRUE_SPOT = { lat: 44.123600, lng: -90.654100 };    // ~26 m away

function store() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-place-'));
  const db = openDb(out);
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint', accountLabel: 'k' });
  return { out, db, id: cam.id };
}

test('a correction never touches the reported fix', () => {
  const { db, id } = store();
  const r = setCameraPlacement(db, id, TRUE_SPOT);
  assert.equal(r.lat, FIX.lat, 'the GPS latitude is untouched');
  assert.equal(r.lng, FIX.lng, 'the GPS longitude is untouched');
  assert.equal(r.placed_lat, TRUE_SPOT.lat);
  assert.equal(r.placed_lng, TRUE_SPOT.lng);
  assert.ok(r.placed_at, 'stamped with when it was said');
  db.close();
});

test('cameraPoint prefers the correction, and says which it gave', () => {
  const { db, id } = store();
  const before = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  assert.deepEqual(cameraPoint(before), { ...FIX, corrected: false });

  const after = setCameraPlacement(db, id, TRUE_SPOT);
  assert.deepEqual(cameraPoint(after), { ...TRUE_SPOT, corrected: true });
  db.close();
});

test('a correction SURVIVES A SYNC', () => {
  // The one that matters. `view` is absent from upsertCamera's column list for
  // exactly this reason; a sync that silently un-corrected every pin would
  // show up only as markers drifting back weeks later, with nothing to explain
  // it. Same failure, same guard.
  const { db, id } = store();
  setCameraPlacement(db, id, TRUE_SPOT);

  const moved = structuredClone(FLEX_M);
  moved.status.coordinates[0].position.coordinates = [-90.6500, 44.1200];
  moved.status.coordinates[0].dateTime = '2026-09-09T10:00:00.000Z';
  const after = upsertCamera(db, norm(moved), { provider: 'spypoint', accountLabel: 'k' });

  assert.equal(after.placed_lat, TRUE_SPOT.lat, 'the correction is still there');
  assert.equal(after.placed_lng, TRUE_SPOT.lng);
  assert.equal(after.lat, 44.1200, 'and the new fix landed, as it should');
  db.close();
});

test('the correction can be withdrawn, and the pin goes back to the fix', () => {
  // A camera that has since been moved makes yesterday's correction the wrong
  // answer. Removing it has to stay reachable.
  const { db, id } = store();
  setCameraPlacement(db, id, TRUE_SPOT);
  const cleared = setCameraPlacement(db, id, null);
  assert.equal(cleared.placed_lat, null);
  assert.equal(cleared.placed_lng, null);
  assert.equal(cleared.placed_at, null);
  assert.deepEqual(cameraPoint(cleared), { ...FIX, corrected: false });
  db.close();
});

test('a half-point is refused rather than stored', () => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic. This repo has
  // been bitten three times, so the check is for a finite number.
  const { db, id } = store();
  for (const bad of [{ lat: 44.1 }, { lng: -90.6 }, { lat: null, lng: -90.6 },
    { lat: NaN, lng: -90.6 }, { lat: '44.1', lng: 'x' }]) {
    assert.throws(() => setCameraPlacement(db, id, bad), /needs both/);
  }
  assert.throws(() => setCameraPlacement(db, id, { lat: 91, lng: 0 }), /out of range/);
  assert.throws(() => setCameraPlacement(db, id, { lat: 44, lng: 181 }), /out of range/);
  const row = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  assert.equal(row.placed_lat, null, 'nothing was written by any of those');
  db.close();
});

test('an unknown camera is a 404, not a silent no-op', () => {
  const { db } = store();
  assert.throws(() => setCameraPlacement(db, 'spypoint:nope', TRUE_SPOT), /no camera/);
  db.close();
});

// --- what the API and the card see -----------------------------------------

async function serving(t) {
  const { out, db, id } = store();
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  const patch = body => fetch(`${base}/api/cameras/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { base, id, patch, get: p => fetch(base + p) };
}

test('the API draws the correction and keeps the fix beside it', async t => {
  const { patch, get } = await serving(t);
  const res = await patch({ placed: TRUE_SPOT });
  assert.equal(res.status, 200);
  const cam = await res.json();

  assert.equal(cam.lat, TRUE_SPOT.lat, 'lat/lng are where the camera IS');
  assert.equal(cam.lng, TRUE_SPOT.lng);
  assert.equal(cam.gpsLat, FIX.lat, 'and the fix is still reported');
  assert.equal(cam.gpsLng, FIX.lng);
  assert.equal(cam.placed.lat, TRUE_SPOT.lat);
  assert.ok(cam.placed.fromFix >= 20 && cam.placed.fromFix <= 35,
    `about 26 m from the fix, got ${cam.placed.fromFix}`);

  // And the list endpoint agrees, so the map and the card cannot diverge.
  const [listed] = await (await get('/api/cameras')).json();
  assert.equal(listed.lat, TRUE_SPOT.lat);
  assert.equal(listed.placed.fromFix, cam.placed.fromFix);
});

test('the facing cone moves with the corrected pin', async t => {
  // A cone still growing out of the GPS position would be a camera looking out
  // of somewhere it is not.
  const { patch } = await serving(t);
  await patch({ view: { to: [FIX.lng + 0.0004, FIX.lat + 0.0004] } });
  const before = await (await patch({ placed: null })).json();
  const anchoredAtFix = before.facing;

  const after = await (await patch({ placed: TRUE_SPOT })).json();
  assert.ok(anchoredAtFix && after.facing, 'both have a cone');
  assert.notEqual(after.facing.bearingDeg, anchoredAtFix.bearingDeg,
    'the bearing to the same looked-at point changed, because the camera moved');
});

test('clearing over the API puts the pin back on the fix', async t => {
  const { patch } = await serving(t);
  await patch({ placed: TRUE_SPOT });
  const cam = await (await patch({ placed: null })).json();
  assert.equal(cam.lat, FIX.lat);
  assert.equal(cam.placed, null);
});

test('a malformed correction is refused with a message naming the field', async t => {
  const { patch } = await serving(t);
  for (const bad of [{ placed: { lat: 44.1 } }, { placed: { lat: 'x', lng: 'y' } },
    { placed: {} }]) {
    const res = await patch(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await res.json()).error, /placed must be/);
  }
});

test('a camera still refuses anything but view and placed', async t => {
  const { patch } = await serving(t);
  const res = await patch({ name: 'renamed', lat: 0 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /only "view" and "placed"/);
});

test('the distance is what makes a suspicious correction visible', async t => {
  // A three-metre nudge is a GPS fix under a canopy. A three-hundred-metre one
  // is somebody correcting the map to match a photograph rather than the
  // ground, and the number on the card is what shows the difference.
  const { patch } = await serving(t);
  const farAway = { lat: FIX.lat + 0.003, lng: FIX.lng };
  const cam = await (await patch({ placed: farAway })).json();
  assert.ok(cam.placed.fromFix > 300, `${cam.placed.fromFix} m is shown, not hidden`);
  assert.equal(Math.round(distanceM(FIX.lat, FIX.lng, farAway.lat, farAway.lng)),
    cam.placed.fromFix, 'and it is the real distance, not an estimate');
});
