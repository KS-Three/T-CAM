import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parcelAt, parcelFromFeature, describeClass, clearParcelCache,
  parcelsByOwner, ownerTerm, ownerWhere, ringsCentre,
} from '../parcels.mjs';
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

  const p = await parcelAt(44.125683, -90.651735);
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
  await assert.rejects(() => parcelAt(44.12, -90.65), /parcel service error: Invalid URL/);
});

test('bad coordinates are refused before any request is made', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await assert.rejects(() => parcelAt(NaN, -89), /needs a latitude and longitude/);
  await assert.rejects(() => parcelAt(44.12, null), /needs a latitude and longitude/);
  assert.equal(calls.length, 0, 'no pointless call to a public service');
});

test('repeat lookups of the same spot are served from memory', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [FEATURE] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });

  // Chosen to sit mid-cell: the key rounds to five decimals, so a coordinate
  // ending in a zero there is comfortably inside its bucket and a perturbation
  // in the seventh decimal cannot cross the edge. The previous fixture only
  // stayed in one cell by a floating-point accident.
  await parcelAt(44.125680, -90.651730);
  await parcelAt(44.125680, -90.651730);
  assert.equal(calls.length, 1, 'the same point twice is one request');

  // The key is a ~1 m grid, so two points CAN round into neighbouring cells
  // even when they are centimetres apart. That is fine for a cache — the cost
  // of a boundary miss is one extra request — but it is a grid, not a radius,
  // and this test says so rather than claiming a guarantee it does not give.
  await parcelAt(44.1256801, -90.6517301);
  assert.equal(calls.length, 1, 'a point inside the same cell is still cached');

  await parcelAt(44.1, -90.7);
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
  const res = await get('/api/parcel?lat=44.125683&lng=-90.651735');
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
  const res = await get('/api/parcel?lat=44.12&lng=-90.65');
  assert.equal(res.status, 502, 'an upstream failure is not the client\'s fault');
  assert.match((await res.json()).error, /service unavailable/);
});

test('missing coordinates are a 400', async t => {
  const { get } = await serving(t, () => ({ features: [] }));
  assert.equal((await get('/api/parcel')).status, 400);
  assert.equal((await get('/api/parcel?lat=44.12')).status, 400);
  assert.equal((await get('/api/parcel?lat=abc&lng=-89')).status, 400);
  // 0,0 is a real place in the Atlantic, so a missing parameter must not
  // quietly become a query about it.
  assert.equal((await get('/api/parcel?lat=&lng=')).status, 400);
  assert.equal((await get('/api/parcel?lat=999&lng=-89')).status, 400, 'out of range');
});

// ---------------------------------------------------------------------------
// Search by owner name
// ---------------------------------------------------------------------------

const RINGS = [[[-90.652, 44.125], [-90.650, 44.125], [-90.650, 44.127],
  [-90.652, 44.127], [-90.652, 44.125]]];

const named = (owner, acres, rings = RINGS) => ({
  attributes: { ...FEATURE.attributes, OWNERNME1: owner, GISACRES: acres },
  geometry: { rings },
});

test('a name is cleaned before it ever reaches a WHERE clause', () => {
  assert.equal(ownerTerm('  smith  '), 'SMITH', 'upper-cased and trimmed');
  assert.equal(ownerTerm("o'brien"), "O'BRIEN", 'apostrophes are part of names');
  assert.equal(ownerTerm('Smith & Sons, Inc.'), 'SMITH & SONS, INC.');
  // Injection dies twice over, and only the second half is this function's
  // job: everything outside a name's alphabet is dropped (the = here), and the
  // apostrophe that would end the string literal is doubled by ownerWhere.
  // Hyphens are kept either way, because Smith-Jones is a name.
  assert.equal(ownerTerm("x' OR 1=1 --"), "X' OR 1 1 --");
  assert.match(ownerWhere(ownerTerm("x' OR 1=1 --")), /LIKE '%X'' OR 1 1 --%'/,
    'the quote is doubled, so the payload stays inside the literal and is inert');
  // The LIKE wildcards go too — typed by accident they turn a search for a
  // person into a scan of the whole state.
  assert.equal(ownerTerm('%'), '', 'a bare wildcard is not a search');
  assert.equal(ownerTerm('sm_th'), 'SM TH', 'the single-character wildcard goes too');
});

test('the WHERE clause looks at both owner columns, with quotes doubled', () => {
  const w = ownerWhere(ownerTerm("o'brien"));
  assert.match(w, /UPPER\(OWNERNME1\) LIKE '%O''BRIEN%'/,
    'the apostrophe is escaped rather than left to end the string');
  assert.match(w, /UPPER\(OWNERNME2\) LIKE '%O''BRIEN%'/,
    'a name is as often the second owner as the first');
});

test('a centre is derived from the boundary, for framing', () => {
  const c = ringsCentre(RINGS);
  assert.equal(Math.round(c.lat * 1000) / 1000, 44.126);
  assert.equal(Math.round(c.lng * 1000) / 1000, -90.651);
  assert.equal(ringsCentre(null), null, 'a record with no geometry has no centre');
  assert.equal(ringsCentre([]), null);
});

test('a search finds parcels by owner, largest first', async t => {
  const { server, calls } = await fakeArcgis(() => ({
    features: [named('SMITH FARMS LLC', 640), named('SMITH, JOHN A', 40.2)],
  }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });

  const found = await parcelsByOwner('smith');
  assert.equal(found.term, 'SMITH');
  assert.equal(found.parcels.length, 2);
  assert.equal(found.parcels[0].owner, 'SMITH FARMS LLC');
  assert.equal(found.parcels[0].acres, 640);
  assert.ok(found.parcels[0].rings, 'the boundary rides with the row, so a click draws it');
  assert.equal(Math.round(found.parcels[0].centre.lat * 1000) / 1000, 44.126);
  assert.equal(found.truncated, false);

  const asked = decodeURIComponent(calls[0]);
  assert.match(asked, /orderByFields=GISACRES\+DESC/,
    'acreage is what makes a row worth reading');
  assert.match(asked, /resultRecordCount=51/,
    'one more than the cap is asked for, so truncation is known rather than guessed');
});

test('more matches than the cap are reported as truncated, not silently cut', async t => {
  // The failure this guards: a list that stops at the cap with no note reads
  // as "these are all of them", which for a common surname is a lie.
  const { server } = await fakeArcgis(() => ({
    features: Array.from({ length: 4 }, (_, i) => named('SMITH ' + i, 100 - i)),
  }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });

  const found = await parcelsByOwner('smith', { limit: 3 });
  assert.equal(found.parcels.length, 3, 'the cap is honoured');
  assert.equal(found.truncated, true, 'and the extra row is counted, not shown');
});

test('a limit above the maximum cannot be talked upwards', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await parcelsByOwner('smith', { limit: 5000 });
  assert.match(decodeURIComponent(calls[0]), /resultRecordCount=51/,
    'the cap is part of the feature — no bulk download through a query string');
});

test('too short a name is refused before any request', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await assert.rejects(() => parcelsByOwner('sm'), /at least 3 characters/);
  await assert.rejects(() => parcelsByOwner('%%'), /at least 3 characters/);
  assert.equal(calls.length, 0, 'two letters of a surname is not a query worth making');
});

test('a repeated search is served from memory', async t => {
  const { server, calls } = await fakeArcgis(() => ({ features: [named('SMITH', 10)] }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await parcelsByOwner('smith');
  await parcelsByOwner('  Smith ');
  assert.equal(calls.length, 1, 'the same name twice, however typed, is one request');
  await parcelsByOwner('jones');
  assert.equal(calls.length, 2);
});

test('an ArcGIS error inside a 200 throws for a search too', async t => {
  const { server } = await fakeArcgis(() => ({ error: { message: 'Invalid query parameters' } }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_PARCEL_URL; });
  await assert.rejects(() => parcelsByOwner('smith'),
    /parcel service error: Invalid query parameters/);
});

test('the API searches by owner name', async t => {
  const { get } = await serving(t, () => ({
    features: [named('SMITH FARMS LLC', 640), named('SMITH, JOHN A', 40.2)],
  }));
  const res = await get('/api/parcels/search?name=smith');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.term, 'SMITH');
  assert.equal(body.count, 2);
  assert.equal(body.truncated, false);
  assert.equal(body.max, 50);
  assert.equal(body.parcels[0].owner, 'SMITH FARMS LLC');
  assert.equal(body.parcels[0].propClassName, 'undeveloped, productive forest');
});

test('a name nobody owns is an empty list, not an error', async t => {
  const { get } = await serving(t, () => ({ features: [] }));
  const res = await get('/api/parcels/search?name=nobodyhere');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.parcels, []);
  assert.equal(body.count, 0);
});

test('a too-short or missing name is a 400 that says what is needed', async t => {
  const { get } = await serving(t, () => ({ features: [] }));
  assert.equal((await get('/api/parcels/search')).status, 400);
  assert.equal((await get('/api/parcels/search?name=')).status, 400);
  assert.equal((await get('/api/parcels/search?name=sm')).status, 400);
  const body = await (await get('/api/parcels/search?name=%25')).json();
  assert.match(body.error, /at least 3 letters/,
    'the message asks for more of the name rather than reporting a fault');
  assert.equal((await get('/api/parcels/search?name=smith&limit=0')).status, 400);
  assert.equal((await get('/api/parcels/search?name=smith&limit=abc')).status, 400);
});

test('a broken service during a search is a 502', async t => {
  const { get } = await serving(t, () => ({ error: { message: 'service unavailable' } }));
  const res = await get('/api/parcels/search?name=smith');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /service unavailable/);
});
