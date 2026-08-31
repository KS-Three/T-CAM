import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer } from '../serve.mjs';
import {
  openDb, createField, fieldScan, saveFieldScan, allFieldScans,
  fieldsDueForScan, SCAN_TTL_DAYS,
} from '../db.mjs';
import { toUtm } from '../sentinel.mjs';
import { disagreement } from '../cropseason.mjs';

const LAT = 44.12, LNG = -90.65;
const d = 0.0009;
const RING = [[LNG - d, LAT - d], [LNG + d, LAT - d],
  [LNG + d, LAT + d], [LNG - d, LAT + d]];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-scan-'));
  return dir;
}

/** Minimal single-tile GeoTIFF, deflated, covering the ring. */
function tiff(value, { size = 60, res = 10 } = {}) {
  const { x, y } = toUtm(LAT, LNG, 15);
  const originX = x - (size / 2) * res, originY = y + (size / 2) * res;
  const tags = [
    [256, 3, 1, [size]], [257, 3, 1, [size]], [258, 3, 1, [16]],
    [259, 3, 1, [8]], [277, 3, 1, [1]], [317, 3, 1, [1]],
    [322, 3, 1, [size]], [323, 3, 1, [size]], [339, 3, 1, [1]],
    [324, 4, 1, null], [325, 4, 1, null],
    [33550, 12, 3, [res, res, 0]], [33922, 12, 6, [0, 0, 0, originX, originY, 0]],
  ].sort((a, b) => a[0] - b[0]);

  const flat = Buffer.alloc(size * size * 2);
  for (let i = 0; i < size * size; i++) flat.writeUInt16LE(value & 0xffff, i * 2);
  const body = deflateSync(flat);

  const TB = { 3: 2, 4: 4, 12: 8 };
  const ifd = 8;
  let cursor = ifd + 2 + tags.length * 12 + 4;
  const extern = new Map();
  for (const [tag, type, count] of tags) {
    const n = TB[type] * count;
    if (n > 4) { extern.set(tag, cursor); cursor += n; }
  }
  const dataAt = cursor;
  const out = Buffer.alloc(dataAt + body.length);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd, 4);
  out.writeUInt16LE(tags.length, ifd);
  const put = (type, vals, at) => vals.forEach((v, i) => {
    const o = at + i * TB[type];
    if (type === 12) out.writeDoubleLE(v, o);
    else if (type === 4) out.writeUInt32LE(v, o);
    else out.writeUInt16LE(v, o);
  });
  tags.forEach(([tag, type, count, vals], i) => {
    const o = ifd + 2 + i * 12;
    out.writeUInt16LE(tag, o);
    out.writeUInt16LE(type, o + 2);
    out.writeUInt32LE(count, o + 4);
    const data = vals ?? (tag === 324 ? [dataAt] : [body.length]);
    if (TB[type] * count > 4) {
      out.writeUInt32LE(extern.get(tag), o + 8);
      put(type, data, extern.get(tag));
    } else put(type, data, o + 8);
  });
  body.copy(out, dataAt);
  return out;
}

/**
 * A stand-in for Earth Search plus the COG bucket. `curve` maps a date to the
 * NDVI that date should read, so a whole season can be dictated by the test.
 */
async function fakeImagery(curve) {
  const dates = Object.keys(curve).sort();
  const rasters = new Map();
  for (const [date, ndvi] of Object.entries(curve)) {
    const red = 1000;
    const nir = Math.round(red * (1 + ndvi) / (1 - ndvi));
    rasters.set(`/red-${date}.tif`, tiff(red));
    rasters.set(`/nir-${date}.tif`, tiff(nir));
    rasters.set(`/scl-${date}.tif`, tiff(4));
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/search')) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const base = `http://127.0.0.1:${server.address().port}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          features: dates.map(date => ({
            id: `S2A_15TVG_${date.replace(/-/g, '')}_0_L2A`,
            properties: {
              datetime: `${date}T17:00:00Z`, 'eo:cloud_cover': 1,
              'grid:code': 'MGRS-15TVG',
            },
            assets: {
              red: { href: `${base}/red-${date}.tif` },
              nir: { href: `${base}/nir-${date}.tif` },
              scl: { href: `${base}/scl-${date}.tif` },
            },
          })),
        }));
      });
      return;
    }
    const buf = rasters.get(req.url);
    if (!buf) { res.writeHead(404); return res.end(); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (!m) { res.writeHead(200, { 'content-length': buf.length }); return res.end(buf); }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), buf.length - 1);
    if (start > end) { res.writeHead(416); return res.end(); }
    res.writeHead(206, { 'content-length': end - start + 1 });
    res.end(buf.subarray(start, end + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_STAC_URL = `http://127.0.0.1:${server.address().port}/search`;
  return server;
}

/**
 * A server over a throwaway database. openDb takes a DIRECTORY, and the server
 * opens its own handle to the same file, so the seeding handle is closed
 * before the server starts and `read` opens a short-lived one for assertions.
 */
async function appWith(t, fields = []) {
  const dir = tmpDir();
  const seed = openDb(dir);
  fields.forEach(f => createField(seed, f));
  seed.close();

  const app = createServer({ out: dir });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(() => new Promise(r => app.close(r)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const read = fn => {
    const db = openDb(dir);
    try { return fn(db); } finally { db.close(); }
  };
  return { dir, base, read };
}

const STANDING = {
  '2026-05-04': 0.20, '2026-05-20': 0.28, '2026-06-08': 0.55,
  '2026-06-24': 0.82, '2026-07-12': 0.90, '2026-08-02': 0.88,
  '2026-08-20': 0.86,
};
const HARVESTED = { ...STANDING, '2026-08-26': 0.24 };

// ---------------------------------------------------------------------------

test('an unscanned field says so rather than inventing a scan', async t => {
  const { base } = await appWith(t, [{ crop: 'corn', points: RING }]);

  const r = await fetch(`${base}/api/fields/1/scan`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.scanned, false);
  assert.match(body.why, /not been scanned/);
});

test('a scan of a standing crop is measured, stored and read back', async t => {
  const imagery = await fakeImagery(STANDING);
  const { base, read } = await appWith(t, [{ crop: 'corn', points: RING }]);
  t.after(() => new Promise(r => imagery.close(r)));
  t.after(() => { delete process.env.TRAILCAM_STAC_URL; });

  const post = await fetch(`${base}/api/fields/1/scan?season=2026`, { method: 'POST' });
  const scan = await post.json();
  assert.equal(scan.state, 'standing', scan.state_why ?? scan.why);
  assert.equal(scan.looks, 7);
  assert.ok(Math.abs(scan.peak_ndvi - 0.90) < 0.01, `peak ${scan.peak_ndvi}`);
  assert.equal(scan.verdict, null, 'crop ID is not attempted unless asked');

  // Stored, and readable without touching the network again.
  const stored = read(db => fieldScan(db, 1, 2026));
  assert.equal(stored.state, 'standing');
  assert.equal(stored.series.length, 7, 'the curve is kept for later questions');

  const got = await (await fetch(`${base}/api/fields/1/scan?season=2026`)).json();
  assert.equal(got.state, 'standing');
  assert.ok(Math.abs(got.latest_ndvi - 0.86) < 0.01);
});

test('a harvest is detected and reported against the recorded field', async t => {
  const imagery = await fakeImagery(HARVESTED);
  const { base } = await appWith(t, [{ crop: 'corn', points: RING }]);
  t.after(() => new Promise(r => imagery.close(r)));
  t.after(() => { delete process.env.TRAILCAM_STAC_URL; });

  const scan = await (await fetch(`${base}/api/fields/1/scan?season=2026`,
    { method: 'POST' })).json();
  assert.equal(scan.state, 'cut', scan.state_why);
  assert.equal(scan.state_since, '2026-08-26');
  assert.ok(Array.isArray(scan.disagreement), 'a cut with no cut date recorded is flagged');
  assert.match(scan.disagreement.join(' '), /no cut date recorded/);
});

test('a rescan replaces the season rather than piling up rows', async t => {
  const imagery = await fakeImagery(STANDING);
  const { base, read } = await appWith(t, [{ crop: 'corn', points: RING }]);
  t.after(() => new Promise(r => imagery.close(r)));
  t.after(() => { delete process.env.TRAILCAM_STAC_URL; });

  await fetch(`${base}/api/fields/1/scan?season=2026`, { method: 'POST' });
  await fetch(`${base}/api/fields/1/scan?season=2026`, { method: 'POST' });
  assert.equal(read(db => allFieldScans(db, 2026)).length, 1);
});

test('scanning a field that does not exist is a 404', async t => {
  const { base } = await appWith(t, []);
  assert.equal((await fetch(`${base}/api/fields/99/scan`)).status, 404);
  assert.equal((await fetch(`${base}/api/fields/99/scan`, { method: 'POST' })).status, 404);
});

test('a catalogue that is down answers with the reason, not a 500', async t => {
  const { base } = await appWith(t, [{ crop: 'corn', points: RING }]);
  process.env.TRAILCAM_STAC_URL = 'http://127.0.0.1:1/search';
  t.after(() => { delete process.env.TRAILCAM_STAC_URL; });

  const r = await fetch(`${base}/api/fields/1/scan?season=2026`, { method: 'POST' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.scanned, false);
  assert.ok(body.why, 'it says what went wrong');
});

// ---------------------------------------------------------------------------
// the scan never overwrites what the person entered

test('a scan writes only its own table, never the field', async t => {
  const imagery = await fakeImagery(HARVESTED);
  const { base, read } = await appWith(t, [{ crop: 'corn', points: RING }]);
  t.after(() => new Promise(r => imagery.close(r)));
  t.after(() => { delete process.env.TRAILCAM_STAC_URL; });

  const before = read(db => db.prepare('SELECT crop, cut_at FROM fields WHERE id = 1').get());
  await fetch(`${base}/api/fields/1/scan?season=2026`, { method: 'POST' });
  const after = read(db => db.prepare('SELECT crop, cut_at FROM fields WHERE id = 1').get());

  assert.deepEqual(after, before,
    'the satellite may disagree, but it does not get to rewrite the record');
  assert.equal(after.cut_at, null, 'a detected harvest did not set cut_at');
});

test('disagreement is reported for a crop that does not match', () => {
  const field = { crop: 'corn', cut_at: null };
  const notes = disagreement(field, { verdict: 'soybeans', state: 'standing' });
  assert.match(notes.join(' '), /recorded as corn/);
  assert.match(notes.join(' '), /looks like soybeans/);
});

test('agreement is silent', () => {
  const field = { crop: 'corn', cut_at: null };
  assert.equal(disagreement(field, { verdict: 'corn', state: 'standing' }), null);
});

test('a field recorded as cut but still green is flagged the other way', () => {
  const field = { crop: 'corn', cut_at: '2026-08-01' };
  const notes = disagreement(field, { verdict: null, state: 'standing' });
  assert.match(notes.join(' '), /still looks like a standing crop/);
});

// ---------------------------------------------------------------------------
// scheduling

test('fields are due when never scanned and fresh when just scanned', async t => {
  const dir = tmpDir();
  const db = openDb(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  createField(db, { crop: 'corn', points: RING });
  const now = new Date('2026-08-31T12:00:00Z');

  assert.equal(fieldsDueForScan(db, { season: 2026, now }).length, 1);

  saveFieldScan(db, 1, 2026, {
    scannedAt: now.toISOString(), state: 'standing', series: [], looks: 5,
  });
  assert.equal(fieldsDueForScan(db, { season: 2026, now }).length, 0);

  const later = new Date(now.getTime() + (SCAN_TTL_DAYS + 1) * 86400000);
  assert.equal(fieldsDueForScan(db, { season: 2026, now: later }).length, 1,
    'stale again once the satellite has been round');
});

test('nothing is due out of season', async t => {
  const dir = tmpDir();
  const db = openDb(dir);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  createField(db, { crop: 'corn', points: RING });
  assert.equal(fieldsDueForScan(db, { now: new Date('2026-01-15T12:00:00Z') }).length, 0);
  assert.equal(fieldsDueForScan(db, { now: new Date('2026-12-20T12:00:00Z') }).length, 0);
  assert.ok(fieldsDueForScan(db, { now: new Date('2026-06-01T12:00:00Z') }).length > 0);
});
