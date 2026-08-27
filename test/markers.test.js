import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, createMarker, updateMarker, deleteMarker, allMarkers, markerById, MARKER_KINDS,
} from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-markers-'));

test('a marker records what it is, where, and WHEN you found it', () => {
  const db = openDb(tmp());
  const m = createMarker(db, {
    kind: 'rub', name: 'Fence-line rub', lat: 44.12, lng: -90.65,
    foundAt: '2026-08-01', notes: 'runs north',
  });
  assert.equal(m.kind, 'rub');
  assert.equal(m.found_at, '2026-08-01');
  const [listed] = allMarkers(db, { now: new Date('2026-08-27T12:00:00Z') });
  assert.equal(listed.label, 'Rub', 'the label travels with the row');
  assert.equal(listed.daysOld, 26, 'and the age is computed, not left to the reader');
  db.close();
});

test('sign with no date is of UNKNOWN age, not zero days old', () => {
  // These are different claims. "Found today" and "I never wrote it down" must
  // not look the same on a map, or old sign reads as fresh.
  const db = openDb(tmp());
  createMarker(db, { kind: 'scrape', lat: 44.12, lng: -90.65 });
  assert.equal(allMarkers(db)[0].daysOld, null);
  db.close();
});

test('an unknown kind is refused rather than stored', () => {
  const db = openDb(tmp());
  assert.throws(() => createMarker(db, { kind: 'unicorn', lat: 44, lng: -90 }),
    /unknown marker kind/);
  assert.equal(allMarkers(db).length, 0);
  db.close();
});

test('a marker without real coordinates is refused before it is stored', () => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic, so a missing
  // coordinate must be caught as missing rather than converted.
  const db = openDb(tmp());
  assert.throws(() => createMarker(db, { kind: 'rub', lat: null, lng: -90 }),
    /needs a latitude and longitude/);
  assert.throws(() => createMarker(db, { kind: 'rub', lat: undefined, lng: -90 }),
    /needs a latitude and longitude/);
  assert.throws(() => createMarker(db, { kind: 'rub', lat: 999, lng: -90 }),
    /real coordinates/);
  assert.throws(() => createMarker(db, { kind: 'rub', lat: NaN, lng: -90 }),
    /real coordinates/);
  assert.equal(allMarkers(db).length, 0);
  db.close();
});

test('every declared kind is actually storable', () => {
  // The CHECK constraint and the exported list have to agree; if they drift,
  // the UI offers a kind the database rejects.
  const db = openDb(tmp());
  for (const kind of MARKER_KINDS) {
    assert.doesNotThrow(() => createMarker(db, { kind, lat: 44.1, lng: -90.6 }), kind);
  }
  assert.equal(allMarkers(db).length, MARKER_KINDS.length);
  db.close();
});

test('a marker can be edited and deleted', () => {
  const db = openDb(tmp());
  const m = createMarker(db, { kind: 'rub', lat: 44.12, lng: -90.65 });
  const moved = updateMarker(db, m.id, { kind: 'scrape', name: 'Oak scrape', lat: 44.13 });
  assert.equal(moved.kind, 'scrape');
  assert.equal(moved.name, 'Oak scrape');
  assert.equal(moved.lat, 44.13);
  assert.equal(moved.lng, -90.65, 'an unmentioned field is left alone');
  assert.ok(deleteMarker(db, m.id));
  assert.equal(markerById(db, m.id), null);
  assert.equal(deleteMarker(db, m.id), false, 'deleting twice is not an error');
  db.close();
});

test('editing to an invalid state leaves the stored marker untouched', () => {
  const db = openDb(tmp());
  const m = createMarker(db, { kind: 'rub', name: 'Good', lat: 44.12, lng: -90.65 });
  assert.throws(() => updateMarker(db, m.id, { kind: 'nonsense' }));
  assert.throws(() => updateMarker(db, m.id, { lat: 999 }));
  const still = markerById(db, m.id);
  assert.equal(still.kind, 'rub');
  assert.equal(still.name, 'Good');
  assert.equal(still.lat, 44.12);
  db.close();
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t) {
  const out = tmp();
  openDb(out).close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  const json = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { json };
}

test('markers round-trip through the API', async t => {
  const { json } = await serving(t);
  const made = await json('POST', '/api/markers',
    { kind: 'bed', name: 'Doe bedding', lat: 44.12, lng: -90.65, foundAt: '2026-08-20' });
  assert.equal(made.status, 201);
  const m = await made.json();
  assert.equal(m.kind, 'bed');

  const listed = await (await json('GET', '/api/markers')).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'Bed');

  const patched = await json('PATCH', `/api/markers/${m.id}`, { notes: 'three beds on the bench' });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).notes, 'three beds on the bench');

  assert.equal((await json('DELETE', `/api/markers/${m.id}`)).status, 200);
  assert.equal((await (await json('GET', '/api/markers')).json()).length, 0);
});

test('a bad marker is the caller\'s mistake, not a server fault', async t => {
  const { json } = await serving(t);
  assert.equal((await json('POST', '/api/markers', { kind: 'unicorn', lat: 44, lng: -90 })).status, 400);
  assert.equal((await json('POST', '/api/markers', { kind: 'rub' })).status, 400);
  assert.equal((await json('POST', '/api/markers', { kind: 'rub', lat: '', lng: '' })).status, 400,
    'empty strings are missing coordinates, not 0,0 in the Atlantic');
  assert.equal((await json('PATCH', '/api/markers/999', { name: 'x' })).status, 404);
  assert.equal((await json('DELETE', '/api/markers/999')).status, 404);
});

test('the kinds the API offers are the kinds it accepts', async t => {
  const { json } = await serving(t);
  const { kinds, labels } = await (await json('GET', '/api/marker-kinds')).json();
  assert.deepEqual(kinds, MARKER_KINDS);
  for (const k of kinds) {
    assert.ok(labels[k], `${k} has a label`);
    assert.equal((await json('POST', '/api/markers', { kind: k, lat: 44.1, lng: -90.6 })).status, 201);
  }
});

test('markers reach the page state alongside stands', async t => {
  const { json } = await serving(t);
  await json('POST', '/api/markers', { kind: 'trail', name: 'Creek crossing', lat: 44.1, lng: -90.6 });
  const state = await (await json('GET', '/api/state')).json();
  assert.equal(state.markers.length, 1);
  assert.equal(state.markers[0].name, 'Creek crossing');
});
