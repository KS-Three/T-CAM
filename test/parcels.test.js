import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parcelAt, parcelFromFeature, describeClass, clearParcelCache } from '../parcels.mjs';
import { createServer } from '../serve.mjs';
import { openDb } from '../db.mjs';

/**
 * A stand-in for the ArcGIS parcel service, so these tests never depend on a
 * public service being up — and so the failure shapes below (a service error
 * inside a 200, an empty result) can actually be produced on demand.
 */
async function fakeArcgis(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(handler(req, calls.length)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_PARCEL_URL = `http://127.0.0.1:${server.address().port}/query`;
  clearParcelCache();
  return { server, calls };
}

const FEATURE = {
  attributes: {
    OWNERNME1: 'SOME FAMILY TRUST', OWNERNME2: null,
    PSTLADRESS: '1 EXAMPLE RD, ANYTOWN, WI  50000',
    SITEADRESS: null, CONAME: 'MARQUETTE', PLACENAME: 'TOWN OF EXAMPLE', GISACRES: 20.3216,
    PARCELID: '000000000000', PROPCLASS: '5,6', SCHOOLDIST: 'EXAMPLE SCHOOL DISTRICT',
  },
};

test('a feature becomes a clean parcel record', () => {
  const p = parcelFromFeature(FEATURE);
  assert.equal(p.owner, 'SOME FAMILY TRUST');
  assert.equal(p.county, 'MARQUETTE');
  assert.equal(p.acres, 20.32, 'acreage is rounded to something readable');
  assert.equal(p.propClass, '5,6');
  assert.equal(p.propClassName, 'undeveloped, productive forest',
    'codes are translated — "5" on a map means nothing to a hunter');
  assert.equal(p.siteAddress, null, 'absent fields are null, not empty strings');
});

test('two owners on one parcel are both kept', () => {
  const p = parcelFromFeature({ attributes: {
    ...FEATURE.attributes, OWNERNME1: 'A PERSON', OWNERNME2: 'ANOTHER PERSON' } });
  assert.equal(p.owner, 'A PERSON & ANOTHER PERSON');
  assert.deepEqual(p.owners, ['A PERSON', 'ANOTHER PERSON']);
});

test('the service\'s own null-ish values do not become fake data', () => {
  // The service returns the string "None" in places, which would otherwise be
  // displayed as if it were an owner called None.
  const p = parcelFromFeature({ attributes: {
    OWNERNME1: 'None', OWNERNME2: '   ', PSTLADRESS: '', GISACRES: null } });
  assert.equal(p.owner, null);
  assert.deepEqual(p.owners, []);
  assert.equal(p.mailingAddress, null);
  assert.equal(p.acres, null);
});

test('property class codes translate, and unknown ones do not invent a name', () => {
  assert.equal(describeClass('1'), 'residential');
  assert.equal(describeClass('4'), 'agricultural');
  assert.equal(describeClass('5,6'), 'undeveloped, productive forest');
  assert.equal(describeClass('6,6'), 'productive forest', 'de-duplicated');
  assert.equal(describeClass('99'), null, 'an unknown code is not guessed at');
  assert.equal(describeClass(null), null);
});

test('a point with a parcel returns the owner', async t => {
  const { server } = await fakeArcgis(() => ({ features: [FEATURE] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });

  const p = await parcelAt(43.885683, -89.031735);
  assert.equal(p.owner, 'SOME FAMILY TRUST');
  assert.equal(p.acres, 20.32);
});

test('a point with no parcel returns null, which is an answer not a failure', async t => {
  // Outside Wisconsin, or on water. This must be distinguishable from a lookup
  // that broke, or the map would claim nobody owns ground that plainly is owned.
  const { server } = await fakeArcgis(() => ({ features: [] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  assert.equal(await parcelAt(40.0, -80.0), null);
});

test('an ArcGIS error inside a 200 response throws rather than reading as empty', async t => {
  // The trap: ArcGIS reports its own errors with HTTP 200. Checking only the
  // status code would turn a broken service into "no parcel here".
  const { server } = await fakeArcgis(() => ({ error: { code: 400, message: 'Invalid URL' } }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await assert.rejects(() => parcelAt(43.88, -89.03), /parcel service error: Invalid URL/);
});

test('bad coordinates are refused before any request is made', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await assert.rejects(() => parcelAt(NaN, -89), /needs a latitude and longitude/);
  await assert.rejects(() => parcelAt(43.88, null), /needs a latitude and longitude/);
  assert.equal(calls.length, 0, 'no pointless call to a public service');
});

test('repeat lookups of the same spot are served from memory', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [FEATURE] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });

  await parcelAt(43.885683, -89.031735);
  await parcelAt(43.885683, -89.031735);
  assert.equal(calls.length, 1, 'the same point twice is one request');

  // The key is a ~1 m grid, so two points can round into neighbouring cells
  // even when they are centimetres apart. That is fine for a cache — the cost
  // of a boundary miss is one extra request — but it is a grid, not a radius,
  // and this test says so rather than claiming a guarantee it does not give.
  await parcelAt(43.8856831, -89.0317349);
  assert.equal(calls.length, 1, 'a point inside the same cell is still cached');

  await parcelAt(43.9, -89.1);
  assert.equal(calls.length, 2, 'a genuinely different point does fetch');
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t, handler) {
  const { server: arc } = await fakeArcgis(handler);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-parcel-'));
  openDb(out).close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    arc.close();
    delete process.env.TRAILCAM_PARCEL_URL;
    return new Promise(r => server.close(r));
  });
  return { get: p => fetch(base + p) };
}

test('the API answers who owns a point', async t => {
  const { get } = await serving(t, () => ({ features: [FEATURE] }));
  const res = await get('/api/parcel?lat=43.885683&lng=-89.031735');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, true);
  assert.equal(body.parcel.owner, 'SOME FAMILY TRUST');
  assert.equal(body.parcel.propClassName, 'undeveloped, productive forest');
});

test('no parcel is a 200 with found:false, not an error', async t => {
  const { get } = await serving(t, () => ({ features: [] }));
  const res = await get('/api/parcel?lat=40&lng=-80');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.found, false);
  assert.equal(body.parcel, null);
});

test('a broken parcel service is a 502, distinguishable from empty ground', async t => {
  const { get } = await serving(t, () => ({ error: { message: 'service unavailable' } }));
  const res = await get('/api/parcel?lat=43.88&lng=-89.03');
  assert.equal(res.status, 502, 'an upstream failure is not the client\'s fault');
  assert.match((await res.json()).error, /service unavailable/);
});

test('missing coordinates are a 400', async t => {
  const { get } = await serving(t, () => ({ features: [] }));
  assert.equal((await get('/api/parcel')).status, 400);
  assert.equal((await get('/api/parcel?lat=43.88')).status, 400);
  assert.equal((await get('/api/parcel?lat=abc&lng=-89')).status, 400);
  // 0,0 is a real place in the Atlantic, so a missing parameter must not
  // quietly become a query about it.
  assert.equal((await get('/api/parcel?lat=&lng=')).status, 400);
  assert.equal((await get('/api/parcel?lat=999&lng=-89')).status, 400, 'out of range');
});
