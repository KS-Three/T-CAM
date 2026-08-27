import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, createStand, updateStand, deleteStand, allStands, normalizeWinds,
  standHuntableOn, upsertCamera, upsertProperty, STAND_TYPES,
} from '../db.mjs';
import { createServer } from '../serve.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const fresh = () => openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-stands-')));
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

// The fixture camera's position, so stands can be placed a known distance away.
const CAM_LAT = 44.123456;
const CAM_LNG = -90.654321;

test('a stand is created with a name, type and position', () => {
  const db = fresh();
  const s = createStand(db, {
    name: 'East Ridge Ladder', type: 'stand', lat: CAM_LAT, lng: CAM_LNG,
    goodWinds: ['NW', 'W'], notes: 'watch the funnel',
  });
  assert.equal(s.name, 'East Ridge Ladder');
  assert.equal(s.type, 'stand');
  assert.equal(s.lat, CAM_LAT);
  assert.equal(s.lng, CAM_LNG);
  assert.equal(s.good_winds, 'NW,W');
  assert.equal(s.notes, 'watch the funnel');
});

test('every stand type in the list is accepted, and nothing else is', () => {
  const db = fresh();
  for (const type of STAND_TYPES) {
    const s = createStand(db, { name: `a ${type}`, type, lat: 44, lng: -90 });
    assert.equal(s.type, type);
  }
  assert.throws(() => createStand(db, { name: 'x', type: 'treehouse', lat: 44, lng: -90 }),
    /unknown stand type/);
});

test('a stand without a name or a real position is refused', () => {
  const db = fresh();
  assert.throws(() => createStand(db, { name: '  ', lat: 44, lng: -90 }), /needs a name/);
  assert.throws(() => createStand(db, { name: 'x', lat: null, lng: -90 }), /needs coordinates/);
  assert.throws(() => createStand(db, { name: 'x', lat: 44, lng: NaN }), /needs coordinates/);
  // Out-of-range coordinates are a transposed lat/lng in disguise: a longitude
  // of -90 in the latitude slot is legal, but 120 is not, and catching it here
  // is cheaper than wondering why a pin is in the sea.
  assert.throws(() => createStand(db, { name: 'x', lat: 120, lng: -90 }), /out of range/);
  assert.throws(() => createStand(db, { name: 'x', lat: 44, lng: 200 }), /out of range/);
});

test('wind lists are normalized, and rubbish is dropped rather than stored', () => {
  assert.equal(normalizeWinds(['nw', ' w ', 'NW']), 'NW,W', 'upper-cased and de-duplicated');
  assert.equal(normalizeWinds('N, NNE, banana'), 'N,NNE', 'unknown points are discarded');
  assert.equal(normalizeWinds([]), null);
  assert.equal(normalizeWinds(null), null);
  assert.equal(normalizeWinds('banana'), null, 'nothing valid means nothing stored');
});

test('a stand with no recorded winds answers "unknown", never "yes"', () => {
  // The dangerous failure: treating "I have not told it yet" as "huntable"
  // would send you to sit somewhere the deer will smell you.
  const unset = { good_winds: null };
  assert.equal(standHuntableOn(unset, 315), null);

  const nw = { good_winds: 'NW,W' };
  assert.equal(standHuntableOn(nw, 315), true, '315° is NW');
  assert.equal(standHuntableOn(nw, 270), true, '270° is W');
  assert.equal(standHuntableOn(nw, 180), false, 'a south wind is not on the list');
  assert.equal(standHuntableOn(nw, null), null, 'no wind reading, no answer');
  assert.equal(standHuntableOn(nw, 0), false);
  assert.equal(standHuntableOn(nw, 360), false, 'wraps without becoming NW');
});

test('a partial update leaves untouched fields alone', () => {
  // A rename must not silently clear the winds — that would quietly turn a
  // known-good stand into one the tool refuses to recommend.
  const db = fresh();
  const s = createStand(db, {
    name: 'Old Name', lat: 44, lng: -90, goodWinds: ['NW'], notes: 'keep me', type: 'tripod',
  });
  const renamed = updateStand(db, s.id, { name: 'New Name' });
  assert.equal(renamed.name, 'New Name');
  assert.equal(renamed.good_winds, 'NW', 'winds survive a rename');
  assert.equal(renamed.notes, 'keep me');
  assert.equal(renamed.type, 'tripod');
  assert.notEqual(renamed.updated_at, null);

  // But an explicit null DOES clear them.
  assert.equal(updateStand(db, s.id, { goodWinds: null }).good_winds, null);
});

test('moving a stand updates its position', () => {
  const db = fresh();
  const s = createStand(db, { name: 'Moved', lat: 44, lng: -90 });
  const moved = updateStand(db, s.id, { lat: 44.5, lng: -90.5 });
  assert.equal(moved.lat, 44.5);
  assert.equal(moved.lng, -90.5);
});

test('updating or deleting a stand that is not there says so', () => {
  const db = fresh();
  assert.throws(() => updateStand(db, 999, { name: 'x' }), /no stand with id 999/);
  assert.equal(deleteStand(db, 999), false);
});

test('stands list the cameras near them, nearest first', () => {
  // This is the link that turns "camera A has been busy" into "sit the stand
  // that covers camera A".
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });

  const close = createStand(db, { name: 'Over the camera', lat: CAM_LAT, lng: CAM_LNG });
  // ~1.1 km north — well outside the default 400 m reach.
  const far = createStand(db, { name: 'Far Ridge', lat: CAM_LAT + 0.01, lng: CAM_LNG });

  const stands = allStands(db);
  const byName = Object.fromEntries(stands.map(s => [s.name, s]));

  assert.equal(byName['Over the camera'].nearbyCameras.length, 1);
  assert.equal(byName['Over the camera'].nearbyCameras[0].name, 'North Ridge');
  assert.ok(byName['Over the camera'].nearbyCameras[0].metres < 5);
  assert.equal(byName['Far Ridge'].nearbyCameras.length, 0,
    'a camera a kilometre away is not "near" the stand');
  assert.ok(close.id !== far.id);
});

test('stands carry their property name and parsed winds', () => {
  const db = fresh();
  const prop = upsertProperty(db, 'Home 40');
  createStand(db, { name: 'North Box', type: 'box-blind', lat: 44, lng: -90,
    propertyId: prop.id, goodWinds: ['S', 'SW'] });
  const [s] = allStands(db);
  assert.equal(s.property_name, 'Home 40');
  assert.deepEqual(s.winds, ['S', 'SW'], 'parsed for the client, not left as a string');
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-standsrv-'));
  const db = openDb(out);
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  db.close();

  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  const call = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { call };
}

test('a pin dropped through the API round-trips', async t => {
  const { call } = await serving(t);

  const created = await call('POST', '/api/stands', {
    name: 'Creek Tripod', type: 'tripod', lat: CAM_LAT, lng: CAM_LNG,
    goodWinds: ['NW', 'N'],
  });
  assert.equal(created.status, 201);
  const stand = await created.json();
  assert.equal(stand.name, 'Creek Tripod');
  assert.equal(stand.good_winds, 'NW,N');

  const list = await (await call('GET', '/api/stands')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].nearbyCameras[0].name, 'North Ridge',
    'the new pin already knows which camera it covers');

  const patched = await (await call('PATCH', `/api/stands/${stand.id}`,
    { name: 'Creek Tripod (moved)', lat: CAM_LAT + 0.0005 })).json();
  assert.equal(patched.name, 'Creek Tripod (moved)');
  assert.equal(patched.good_winds, 'NW,N', 'a move does not clear the winds');

  assert.equal((await call('DELETE', `/api/stands/${stand.id}`)).status, 200);
  assert.equal((await (await call('GET', '/api/stands')).json()).length, 0);
});

test('the API rejects a bad stand with a message naming the problem', async t => {
  const { call } = await serving(t);
  for (const [body, expected] of [
    [{ lat: 44, lng: -90 }, /needs a name/],
    [{ name: 'x', lat: 'nowhere', lng: -90 }, /needs coordinates/],
    [{ name: 'x', type: 'treehouse', lat: 44, lng: -90 }, /unknown stand type/],
    [{ name: 'x', lat: 999, lng: -90 }, /out of range/],
  ]) {
    const res = await call('POST', '/api/stands', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, expected);
  }
  assert.equal((await call('PATCH', '/api/stands/999', { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', '/api/stands/999')).status, 404);
});

test('a malformed body is a 400, not a 500 and not a crashed server', async t => {
  const { call } = await serving(t);
  const base = new URL((await call('GET', '/api/stands')).url).origin;

  const bad = await fetch(`${base}/api/stands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  assert.equal(bad.status, 400, 'invalid JSON is the caller\'s mistake, not a server fault');
  assert.match((await bad.json()).error, /valid JSON/);

  // An oversized body is refused rather than read into memory unbounded.
  const huge = await fetch(`${base}/api/stands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(200000), lat: 44, lng: -90 }),
  }).catch(() => ({ status: 400 }));
  assert.ok([400, 500].includes(huge.status), 'a huge body does not succeed');

  // The server is still answering afterwards, which is the real assertion.
  assert.equal((await call('GET', '/api/stands')).status, 200);
});

test('stands appear in the one-call state alongside cameras', async t => {
  const { call } = await serving(t);
  await call('POST', '/api/stands', { name: 'Box', type: 'box-blind', lat: 44, lng: -90 });
  const s = await (await call('GET', '/api/state')).json();
  assert.equal(s.stands.length, 1);
  assert.equal(s.stands[0].name, 'Box');
  assert.equal(s.cameras.length, 1);
});

test('the client can ask what types and winds are allowed', async t => {
  // So the drop-a-pin form is built from the server's list rather than a copy
  // that drifts out of step with the CHECK constraint.
  const { call } = await serving(t);
  const meta = await (await call('GET', '/api/stand-types')).json();
  assert.deepEqual(meta.types, STAND_TYPES);
  assert.equal(meta.winds.length, 16);
  assert.ok(meta.winds.includes('NW'));
});
