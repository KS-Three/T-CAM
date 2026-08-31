/**
 * End-to-end test of the sync: a stand-in SpyPoint API on localhost, the real
 * spypoint-sync.mjs run as a subprocess against it, then assertions on what
 * actually landed on disk and in the database.
 *
 * This is the test that would have caught the wiring being wrong. The unit
 * tests prove each piece works; only this proves they are connected — that a
 * photo returned by the API becomes a downloaded file, a database row and a
 * detection, with the right camera attached.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
// fileURLToPath, NOT new URL(...).pathname: on Windows the pathname is
// "/C:/Users/..." with a leading slash, which path.join turns into
// "\C:\Users\..." and node then resolves against the cwd as
// "C:\C:\Users\...". Every test in this file spawned a subprocess that
// died with MODULE_NOT_FOUND, so the one test proving the sync is wired
// together has never actually run on Windows.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HERE, '..', 'spypoint-sync.mjs');

// A 1x1 JPEG, so the download path writes a real image rather than a stub.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const CAMERA = (id, name, lng, lat) => ({
  id,
  config: { name, gps: true },
  status: {
    model: 'FLEX-M',
    lastUpdate: '2026-08-20T12:00:00.000Z',
    powerSources: [{ type: 'AA', percentage: 64, level: 'medium' }],
    signal: { type: 'LTE', bar: 3, processed: { percentage: 72, bar: 3, level: 'high' } },
    temperature: { unit: 'F', value: 55 },
    memory: { size: 1871, used: 12 },
    coordinates: [{
      dateTime: '2026-08-20T12:00:00.000Z',
      position: { type: 'Point', coordinates: [lng, lat] },
    }],
  },
  subscriptions: [{
    plan: { name: 'Free' }, photoCount: 2, photoLimit: 100,
    startDateBillingCycle: '2025-11-01T00:00:00.000Z',
    endDateBillingCycle: '2025-11-30T23:59:59.999Z',
  }],
});

/** A stand-in for the SpyPoint API, serving two cameras and three photos. */
async function fakeSpypoint() {
  const photos = {
    cam1: [
      { id: 'p1', originDate: '2026-08-21T07:15:00.000Z', tag: ['deer'] },
      { id: 'p2', originDate: '2026-08-21T07:15:04.000Z', tag: ['deer', 'buck'] },
    ],
    cam2: [
      { id: 'p3', originDate: '2026-08-22T18:40:00.000Z', tag: [] },
    ],
  };
  const calls = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push(req.url);
      const json = o => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url.endsWith('/user/login')) {
        const { username, password } = JSON.parse(body || '{}');
        if (password !== 'correct-horse') {
          res.writeHead(401, { 'content-type': 'application/json' });
          return res.end('{"error":"bad credentials"}');
        }
        return json({ token: 'test-token', uuid: 'u1', username });
      }
      if (req.url.endsWith('/camera/all')) {
        return json([
          CAMERA('cam1', 'North Ridge', -90.654321, 44.123456),
          // Deliberately close to cam1 — under 2 km, so both must end up sharing
          // one weather location rather than creating two.
          CAMERA('cam2', 'Creek Bottom', -90.656000, 44.125000),
        ]);
      }
      if (req.url.endsWith('/photo/all')) {
        const { camera } = JSON.parse(body || '{}');
        const host = `http://127.0.0.1:${server.address().port}`;
        const list = (photos[camera?.[0]] ?? []).map(p => ({
          ...p,
          large: { host, path: `img/${p.id}.jpg` },
        }));
        return json({ photos: list });
      }
      if (req.url.startsWith('/img/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(JPEG);
      }
      res.writeHead(404); res.end();
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, calls };
}

async function sync(port, out, extra = [], password = 'correct-horse') {
  return run(process.execPath,
    ['--disable-warning=ExperimentalWarning', SYNC, '--out', out, ...extra], {
      env: {
        ...process.env,
        SPYPOINT_API_BASE: `http://127.0.0.1:${port}`,
        SPYPOINT_EMAIL: 'test@example.invalid',
        SPYPOINT_PASSWORD: password,
      },
    });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-sync-'));
const openRead = out => new DatabaseSync(path.join(out, 'trailcam.db'));

test('a full sync lands cameras, photos and detections in the database', async t => {
  const { server, port } = await fakeSpypoint();
  t.after(() => server.close());
  const out = tmp();

  const { stdout } = await sync(port, out);
  assert.match(stdout, /2 SpyPoint camera\(s\)/);
  assert.match(stdout, /Done: 3 new photo\(s\)/);

  const db = openRead(out);

  const cams = db.prepare('SELECT * FROM cameras ORDER BY name').all();
  assert.equal(cams.length, 2);
  assert.equal(cams[0].name, 'Creek Bottom');
  assert.equal(cams[1].name, 'North Ridge');
  assert.equal(cams[1].id, 'spypoint:cam1', 'ids namespaced by provider');
  // The ordering invariant, now checked through the whole pipeline rather than
  // in isolation: API JSON -> provider -> sync -> SQLite.
  assert.equal(cams[1].lat, 44.123456);
  assert.equal(cams[1].lng, -90.654321);
  assert.equal(cams[1].battery, 64);
  assert.equal(cams[1].signal, 72);

  // Both cameras are under 2 km apart, so they must share one weather location.
  assert.equal(cams[0].weather_location_id, cams[1].weather_location_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM weather_locations').get().n, 1);

  const photos = db.prepare('SELECT * FROM photos ORDER BY taken_at').all();
  assert.equal(photos.length, 3);
  assert.equal(photos[0].id, 'spypoint:p1');
  assert.equal(photos[0].camera_id, 'spypoint:cam1', 'photo attached to its camera');
  assert.equal(photos[0].hour_utc, '2026-08-21T07:00:00Z', 'hour key set for the weather join');
  assert.ok(photos[0].file_path, 'a downloaded file is recorded');
  // The SHAPE of that path is the contract, not just its presence — the first
  // real photos arrived with a photos/ prefix here, every consumer prepended
  // photos/ again, and each image URL 404d as /photos/photos/... while this
  // assertion stayed green. The column is relative to the photos directory.
  for (const ph of photos) {
    assert.ok(!ph.file_path.startsWith('photos/'),
      `file_path "${ph.file_path}" carries the on-disk prefix — the serving route will double it`);
    assert.ok(fs.existsSync(path.join(out, 'photos', ...ph.file_path.split('/'))),
      `resolving "${ph.file_path}" against out/photos must land on the downloaded file`);
  }
  assert.equal(photos[2].camera_id, 'spypoint:cam2');

  // The camera's own AI tags become unconfirmed machine claims, one row per tag.
  const dets = db.prepare(`
    SELECT d.species, d.source, d.confirmed, d.photo_id FROM detections d
    ORDER BY d.photo_id, d.species`).all();
  assert.deepEqual(dets.map(d => [d.photo_id, d.species]), [
    ['spypoint:p1', 'deer'],
    ['spypoint:p2', 'buck'],
    ['spypoint:p2', 'deer'],
  ], 'p2 carried two tags and became two detections; p3 had none');
  assert.ok(dets.every(d => d.source === 'camera-ai'), 'attributed to the camera, not a person');
  assert.ok(dets.every(d => d.confirmed === 0), 'and left unconfirmed');

  const jpgs = fs.readdirSync(path.join(out, 'photos'), { recursive: true })
    .filter(f => String(f).endsWith('.jpg'));
  assert.equal(jpgs.length, 3, 'the images really were written to disk');
  db.close();
});

test('re-running is incremental and does not duplicate anything', async t => {
  const { server, port, calls } = await fakeSpypoint();
  t.after(() => server.close());
  const out = tmp();

  await sync(port, out);
  const firstImageFetches = calls.filter(u => u.startsWith('/img/')).length;
  assert.equal(firstImageFetches, 3);

  const { stdout } = await sync(port, out);
  assert.match(stdout, /Done: 0 new photo\(s\)/, 'nothing new the second time');
  assert.equal(calls.filter(u => u.startsWith('/img/')).length, firstImageFetches,
    'no image is downloaded twice');

  const db = openRead(out);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cameras').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM photos').get().n, 3);
  // The important one: a second run must not re-seed the AI tags, or every sync
  // would silently multiply the detection count and inflate any analysis.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM detections').get().n, 3,
    'detections are not duplicated by a re-sync');
  db.close();
});

test('a dry run writes nothing at all', async t => {
  const { server, port, calls } = await fakeSpypoint();
  t.after(() => server.close());
  const out = tmp();

  const { stdout } = await sync(port, out, ['--dry-run']);
  assert.match(stdout, /would be downloaded \(dry run\)/);
  assert.ok(!fs.existsSync(path.join(out, 'trailcam.db')), 'no database');
  assert.ok(!fs.existsSync(path.join(out, 'photos')), 'no photos');
  assert.equal(calls.filter(u => u.startsWith('/img/')).length, 0, 'nothing downloaded');
});

test('a rejected login fails clearly and leaves no half-written store', async t => {
  const { server, port } = await fakeSpypoint();
  t.after(() => server.close());
  const out = tmp();

  await assert.rejects(
    () => sync(port, out, [], 'wrong-password'),
    err => {
      assert.equal(err.code, 1, 'exits nonzero');
      assert.match(err.stderr, /rejected the login/);
      return true;
    });
  assert.ok(!fs.existsSync(path.join(out, 'trailcam.db')),
    'no database is created when the sync never got started');
});

test('the flat files are still written alongside the database', async t => {
  // The migration is deliberately additive: anything still reading the CSV or
  // the dashboard keeps working while the store is bedded in.
  const { server, port } = await fakeSpypoint();
  t.after(() => server.close());
  const out = tmp();

  await sync(port, out);
  for (const f of ['cameras.raw.json', 'cameras.csv', 'photos.jsonl', 'dashboard.html']) {
    assert.ok(fs.existsSync(path.join(out, f)), `${f} still written`);
  }
  const csv = fs.readFileSync(path.join(out, 'cameras.csv'), 'utf8');
  assert.match(csv, /North Ridge/);
  assert.match(csv, /44\.123456,-90\.654321/, 'lat then lng in the CSV too');

  // The quota columns, end to end: the API's subscription block, through the
  // provider, into the flat file. Derived here rather than in the dashboard so
  // a spreadsheet can sort on it.
  const [header, row] = csv.trim().split('\n');
  const cols = header.split(',');
  const at = name => row.split(',')[cols.indexOf(name)];
  for (const c of ['cycle_start', 'cycle_end', 'quota_level', 'photos_per_day', 'quota_dry_on']) {
    assert.ok(cols.includes(c), `${c} column present`);
  }
  assert.equal(at('photos_used'), '2');
  assert.equal(at('photo_limit'), '100');
  assert.equal(at('cycle_start'), '2025-11-01T00:00:00.000Z');
  assert.equal(at('quota_level'), 'ok', '2 of 100 is not an alarm');
});

test('the sync reports the quota per camera, not one camera for the account', async t => {
  // The line this replaced printed whichever camera came back first. Every
  // camera has to appear, with its own numbers.
  const { server, port } = await fakeSpypoint();
  t.after(() => server.close());
  const { stdout } = await sync(port, tmp());
  assert.match(stdout, /Photo quota this billing cycle:/);
  assert.match(stdout, /North Ridge\s+\[.{10}\] 2\/100/,
    'the camera, its bar and its own counts');
});
