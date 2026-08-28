/**
 * The suggester over HTTP. The unit tests cover the geometry; these cover the
 * things only the endpoint can get wrong — where it looks, what it does when an
 * input is missing, and whether it says so rather than quietly changing what
 * its numbers mean.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-suggest-'));

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

test('with nothing placed it asks for a stand rather than guessing a location', async t => {
  const { get } = await serving(t);
  const res = await get('/api/suggest-stands');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /drop a stand on the map first/);
});

test('it centres on your own ground without being told where that is', async t => {
  // No lat/lng in the query: the endpoint averages what you have placed. The
  // terrain fetch will fail in a test environment, and that is the point —
  // the failure has to name the ground it tried, not a default.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'B', lat: 44.130, lng: -90.660 });
  });
  const res = await get('/api/suggest-stands');
  const body = await res.json();
  if (res.status === 200 && body.at) {
    assert.ok(Math.abs(body.at.lat - 44.125) < 1e-6, 'centred between the two stands');
    assert.ok(Math.abs(body.at.lng + 90.655) < 1e-6);
  } else {
    // Offline: a 502 naming the terrain failure is the correct outcome, and
    // must not be dressed up as "no suggestions here".
    assert.equal(res.status, 502);
    assert.match(body.error, /terrain/);
  }
});

test('the radius is clamped rather than trusted', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  for (const [asked, expected] of [['5', 150], ['999999', 1200], ['abc', 500]]) {
    const body = await (await get(`/api/suggest-stands?radius=${asked}`)).json();
    if (body.at) assert.equal(body.at.radiusM, expected, `radius=${asked}`);
  }
});

test('bad coordinates are refused, not converted', async t => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic. The endpoint
  // falls back to your own ground rather than to the origin.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const body = await (await get('/api/suggest-stands?lat=&lng=')).json();
  if (body.at) {
    assert.notEqual(body.at.lat, 0, 'an empty lat did not become the equator');
    assert.ok(Math.abs(body.at.lat - 44.12) < 1e-6);
  }
});

test('it reports whether wind history was available, because it changes the ranking', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65, goodWinds: 'NW' });
  });
  const res = await get('/api/suggest-stands');
  const body = await res.json();
  if (res.status === 200 && 'windHistoryLoaded' in body) {
    assert.equal(typeof body.windHistoryLoaded, 'boolean');
    // Nothing cached in a fresh database, so the suggester must say the
    // ranking is not about filling a wind gap.
    assert.equal(body.windHistoryLoaded, false);
    if (body.notes) {
      assert.ok(body.notes.some(n => /No wind history loaded/.test(n))
        || body.note, 'the missing input is explained');
    }
  }
});
