/**
 * Crop fields: outlined on the map, coloured by crop, and dated when cut.
 *
 * The cut date is the fact worth testing hardest: "cut" without a date cannot
 * age, and a field that quietly reads as standing all season would mislead
 * every evening-pattern judgement built on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, createField, updateField, deleteField, allFields, fieldById,
  CROP_KINDS, CROP_LABELS,
} from '../db.mjs';
import { toAlbers, parseCdlResponse, cropGuess, cropAt } from '../cropscan.mjs';
import { offsetPoint } from '../routes.mjs';
import { createServer } from '../serve.mjs';
import http from 'node:http';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-fields-'));

// A field on the invented 44.12 / -90.65 cluster, like every fixture here.
const RING = [[-90.6520, 44.1250], [-90.6500, 44.1250], [-90.6500, 44.1265], [-90.6520, 44.1265]];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('a field stores its crop, boundary and cut date, and reads back whole', () => {
  const db = openDb(tmp());
  const f = createField(db, { name: 'North forty', crop: 'corn', points: RING });
  assert.equal(f.crop, 'corn');
  assert.equal(f.cut_at, null, 'standing until told otherwise');
  assert.deepEqual(f.points, RING, 'points come back as coordinates, not a string');

  const cut = updateField(db, f.id, { cutAt: '2026-10-12' });
  assert.equal(cut.cut_at, '2026-10-12');
  assert.equal(cut.crop, 'corn', 'an unmentioned field is left alone');

  const standing = updateField(db, f.id, { cutAt: null });
  assert.equal(standing.cut_at, null, 'and a cut can be undone — wrong clicks happen');

  assert.ok(deleteField(db, f.id));
  assert.equal(fieldById(db, f.id), null);
  db.close();
});

test('every crop the label table knows is storable, and nothing else is', () => {
  const db = openDb(tmp());
  for (const crop of CROP_KINDS) {
    assert.ok(CROP_LABELS[crop], `${crop} has a label`);
    createField(db, { crop, points: RING });
  }
  assert.equal(allFields(db).length, CROP_KINDS.length);
  assert.throws(() => createField(db, { crop: 'bananas', points: RING }),
    /crop must be one of/);
  db.close();
});

test('a boundary needs three real corners, refused before conversion', () => {
  const db = openDb(tmp());
  assert.throws(() => createField(db, { crop: 'corn', points: RING.slice(0, 2) }),
    /three points/);
  // Number(null) is 0, and 0,0 is a real place in the Atlantic — the same trap
  // routes and the collar loader have both been bitten by.
  assert.throws(() => createField(db, {
    crop: 'corn', points: [[null, 44.12], [-90.65, 44.12], [-90.65, 44.13]],
  }), /missing a coordinate/);
  assert.throws(() => createField(db, { crop: 'corn', points: RING, cutAt: 'last week' }),
    /YYYY-MM-DD/);
  assert.equal(allFields(db).length, 0, 'and none of them were stored');
  db.close();
});

test('a bad edit changes nothing', () => {
  const db = openDb(tmp());
  const f = createField(db, { name: 'Beans', crop: 'soybeans', points: RING });
  assert.throws(() => updateField(db, f.id, { points: [[1, 2]] }), /three points/);
  assert.throws(() => updateField(db, f.id, { cutAt: '10/12/2026' }), /YYYY-MM-DD/);
  const back = fieldById(db, f.id);
  assert.equal(back.name, 'Beans');
  assert.deepEqual(back.points, RING);
  assert.throws(() => updateField(db, 999, { name: 'x' }), /no field with id/);
  db.close();
});

// ---------------------------------------------------------------------------
// Over HTTP, and baked into the page
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
    base,
    json: (method, p, body) => fetch(base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

test('fields round-trip through the API, cut date included', async t => {
  const { json } = await serving(t);
  const made = await json('POST', '/api/fields',
    { name: 'North forty', crop: 'corn', points: RING });
  assert.equal(made.status, 201);

  const listed = await (await json('GET', '/api/fields')).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].crop, 'corn');

  const id = listed[0].id;
  assert.equal((await json('PATCH', `/api/fields/${id}`, { cutAt: '2026-10-12' })).status, 200);
  const after = await (await json('GET', '/api/fields')).json();
  assert.equal(after[0].cut_at, '2026-10-12');

  assert.equal((await json('POST', '/api/fields', { crop: 'corn', points: [[1, 2]] })).status, 400);
  assert.equal((await json('PATCH', '/api/fields/999', { name: 'x' })).status, 404);
  assert.equal((await json('DELETE', `/api/fields/${id}`)).status, 200);
  assert.equal((await json('DELETE', '/api/fields/999')).status, 404);
  assert.equal((await (await json('GET', '/api/fields')).json()).length, 0);
});

test('the crop vocabulary is served, and matches the database\'s own', async t => {
  const { json } = await serving(t);
  const kinds = await (await json('GET', '/api/crop-kinds')).json();
  assert.deepEqual(kinds.kinds, CROP_KINDS);
  assert.deepEqual(kinds.labels, CROP_LABELS);
});

test('the dashboard bakes the fields in, so the map draws them on load', async t => {
  const { base } = await serving(t, db => {
    createField(db, { name: 'North forty', crop: 'corn', points: RING, cutAt: '2026-10-12' });
  });
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('"fields":'), 'the payload carries a fields key');
  assert.ok(html.includes('North forty'), 'with the field in it');
  assert.ok(html.includes('2026-10-12'), 'cut date included');
});

// ---------------------------------------------------------------------------
// The USDA crop lookup
// ---------------------------------------------------------------------------

test('the Albers projection is pinned at its origin and against the ground', () => {
  // EPSG:5070's origin is 23N 96W by definition; a transposed constant moves it.
  const o = toAlbers(23, -96);
  assert.ok(Math.abs(o.x) < 1e-6 && Math.abs(o.y) < 1e-6, `origin projects to 0,0 (${o.x}, ${o.y})`);

  // Equal-area conic: distances inside CONUS survive within a fraction of a
  // percent. A kilometre on the ground must be a kilometre on the grid, or
  // every lookup lands in a neighbouring pixel at best.
  const a = { lat: 44.1260, lng: -90.6510 };
  const b = offsetPoint(a.lat, a.lng, 90, 1000);
  const pa = toAlbers(a.lat, a.lng), pb = toAlbers(b.lat, b.lng);
  const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  assert.ok(Math.abs(d - 1000) < 10, `1 km stays 1 km on the grid (${d.toFixed(1)})`);

  assert.ok(toAlbers(44, -90).x > 0, 'east of the central meridian is positive x');
  assert.ok(toAlbers(44, -100).x < 0, 'west of it negative');
});

test('the service\'s answer is parsed, and its vocabulary mapped only where certain', () => {
  const xml = '<?xml version="1.0"?><ns1:GetCDLValueResponse>'
    + '<Result>{x: -10061273.7, y: 5433859.2, value: "1", category: "Corn", color: "#FFD300"}</Result>'
    + '</ns1:GetCDLValueResponse>';
  const r = parseCdlResponse(xml);
  assert.equal(r.category, 'Corn');
  assert.equal(r.code, 1);

  assert.throws(() => parseCdlResponse('<faultstring>year 2026 not available</faultstring>'),
    /year 2026 not available/);
  assert.throws(() => parseCdlResponse('<html>gateway error</html>'), /without a category/);

  assert.equal(cropGuess('Corn'), 'corn');
  assert.equal(cropGuess('Sweet Corn'), 'corn');
  assert.equal(cropGuess('Soybeans'), 'soybeans');
  assert.equal(cropGuess('Winter Wheat'), 'winter-wheat');
  assert.equal(cropGuess('Grassland/Pasture'), 'pasture');
  assert.equal(cropGuess('Deciduous Forest'), null,
    'a wood is not a crop, and must not be guessed into one');
});

test('the lookup falls back one season, then fails honestly', async () => {
  const calls = [];
  const ok = body => ({ ok: true, text: async () => body });
  const answer = '<Result>{value: "5", category: "Soybeans"}</Result>';
  const fetchImpl = async url => {
    calls.push(url);
    // The newest season is "not yet available", the one before answers — the
    // real shape of CropScape early in a year.
    if (calls.length === 1) return ok('<faultstring>not available</faultstring>');
    return ok(answer);
  };
  const r = await cropAt(44.126, -90.651, { fetchImpl, now: new Date('2026-08-29') });
  assert.equal(r.found, true);
  assert.equal(r.year, 2024, 'fell back from 2025 to 2024');
  assert.equal(r.crop, 'soybeans');
  assert.ok(calls[0].includes('year=2025') && calls[1].includes('year=2024'));

  await assert.rejects(
    cropAt(44.126, -90.651, { fetchImpl: async () => ok('<faultstring>down</faultstring>') }),
    /down/);
});

test('the cropscan API answers found:false rather than erroring, and rejects no coordinates', async t => {
  // Point the proxy at a stub that plays USDA.
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('<Result>{value: "1", category: "Corn", color: "#FFD300"}</Result>');
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => stub.close(r)));
  process.env.TRAILCAM_CDL_URL = `http://127.0.0.1:${stub.address().port}/cdl`;
  t.after(() => { delete process.env.TRAILCAM_CDL_URL; });

  const { json } = await serving(t);
  const hit = await (await json('GET', '/api/cropscan?lat=44.126&lng=-90.651')).json();
  assert.equal(hit.found, true);
  assert.equal(hit.crop, 'corn');

  assert.equal((await json('GET', '/api/cropscan?lat=44.126')).status, 400,
    'missing lng is the caller\'s mistake');

  // Service down: the answer is found:false with the reason, because the
  // field form works identically without the assist and must not error out.
  process.env.TRAILCAM_CDL_URL = 'http://127.0.0.1:9/cdl';
  const down = await (await json('GET', '/api/cropscan?lat=44.126&lng=-90.651')).json();
  assert.equal(down.found, false);
  assert.match(down.why, /CropScape/);
});
