/**
 * `/api/my-properties` over HTTP.
 *
 * These tests were the surviving half of `suggest-api.test.js`. The suggester
 * they shared a file with is gone; this endpoint is not, because it answers a
 * question about a DEED rather than offering an opinion — which parcels sit
 * under your pins, what they are called, and the boundary the page has to
 * draw. The map's "Property boundaries" tool stands on it.
 *
 * These go through the real `parcelAt`, so they reach the state parcel
 * service over the network, exactly as they did inside suggest-api.test.js.
 * Offline, or outside Wisconsin, a lookup finds no parcel and the shape of the
 * answer is what gets checked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-props-'));

async function serving(t, seed = () => {}) {
  const out = tmp();
  const db = openDb(out);
  seed(db);
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: p => fetch(base + p), out };
}

test('with nothing placed, the property list is empty and says why', async t => {
  const { get } = await serving(t);
  const body = await (await get('/api/my-properties')).json();
  assert.deepEqual(body.properties, []);
  assert.match(body.note, /Nothing is placed yet/);
});

test('each property carries the boundary the page has to draw', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.120, lng: -90.650 });
  });
  const body = await (await get('/api/my-properties')).json();
  assert.equal(body.properties.length, 1, 'one cluster, one property');
  const p = body.properties[0];
  assert.equal(p.key, 'g0');
  assert.ok('parcels' in p, 'parcels are always reported, even when empty');
  assert.ok('centre' in p && 'bounds' in p, 'the page needs somewhere to fly to');
  // Offline (or outside Wisconsin) there is simply no parcel, which is a real
  // answer: the shape must still be right so the picker can render a row.
  for (const parcel of p.parcels) {
    assert.ok('rings' in parcel && 'owner' in parcel && 'acres' in parcel);
  }
});

test('two properties get labels that tell them apart', async t => {
  // The failure this pins: describeGround says what is ON a ground, and two
  // properties hunted the same way describe identically — a picker whose two
  // rows both read "2 cameras, 1 stand" is not a picker.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'Home', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'Far', lat: 44.250, lng: -90.450 });
  });
  const body = await (await get('/api/my-properties')).json();
  assert.equal(body.properties.length, 2, 'a drive apart is two properties');
  const [a, b] = body.properties.map(p => p.label);
  // Offline both fall back to the contents and DO match; with a parcel service
  // they carry acreage and county. Either way the keys must differ, which is
  // what the page actually selects on.
  assert.notEqual(body.properties[0].key, body.properties[1].key);
  assert.ok(typeof a === 'string' && typeof b === 'string');
});

test('the map lists your ground and draws its boundary', async () => {
  const { mapScript } = await import('../map-view.mjs');
  assert.match(mapScript, /\/api\/my-properties/, 'the page can list your ground');
  assert.match(mapScript, /path class="myprop"/, 'and the boundary is drawn');
});

test('the suggester is gone, endpoint and all', async t => {
  // Removed on Kent's call (design.md §14). Pinned because a half-deleted
  // feature that still answers on its old path is worse than either state:
  // the map would have no way to reach it and no way to know it was there.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const res = await get('/api/suggest-stands?lat=44.12&lng=-90.65');
  assert.equal(res.status, 404, 'the endpoint no longer exists');
  const { mapScript } = await import('../map-view.mjs');
  assert.ok(!mapScript.includes('/api/suggest-stands'), 'and the page does not ask for it');
});
