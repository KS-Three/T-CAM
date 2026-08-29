import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createServer, cameraFromRow, recentPhotos } from '../serve.mjs';
import { openDb, upsertCamera, upsertPhoto, addDetection, upsertProperty } from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

/** A populated output directory: a database, a property, a camera, two photos. */
function seeded() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-serve-'));
  const db = openDb(out);
  const prop = upsertProperty(db, 'Home 40');
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint', accountLabel: 'kent' });
  db.prepare('UPDATE cameras SET property_id = ? WHERE id = ?').run(prop.id, cam.id);

  const rel = path.join('North_Ridge', '2026-08', 'p1.jpg');
  fs.mkdirSync(path.join(out, 'photos', 'North_Ridge', '2026-08'), { recursive: true });
  fs.writeFileSync(path.join(out, 'photos', rel), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const p1 = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa', nativeId: 'p1',
    takenAt: '2026-08-21T07:15:00.000Z', filePath: rel,
  });
  upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa', nativeId: 'p2',
    takenAt: '2026-08-21T07:15:04.000Z',
  });
  addDetection(db, { photoId: p1.id, species: 'deer', source: 'camera-ai' });
  addDetection(db, { photoId: p1.id, species: 'buck', source: 'manual', confirmed: true });
  db.close();

  // A file OUTSIDE the photo directory, to prove traversal cannot reach it.
  fs.writeFileSync(path.join(out, 'secret.txt'), 'coordinates of every stand');
  return out;
}

/** Start the server on an ephemeral port and give the test a fetch helper. */
async function serving(t) {
  const out = seeded();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { base, out, get: (p, o) => fetch(base + p, o) };
}

test('the dashboard is served as HTML built from the database', async t => {
  const { get } = await serving(t);
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /North Ridge/, 'the camera from the database is rendered');
});

test('the JSON API returns cameras with lat and lng the right way round', async t => {
  const { get } = await serving(t);
  const cams = await (await get('/api/cameras')).json();
  assert.equal(cams.length, 1);
  assert.equal(cams[0].name, 'North Ridge');
  assert.equal(cams[0].lat, 44.123456);
  assert.equal(cams[0].lng, -90.654321);
  assert.equal(cams[0].property, 'Home 40', 'the property name is joined in');
  assert.equal(cams[0].battery, 20);
  assert.equal(cams[0].provider, 'spypoint');
});

test('photos come back newest first, with their species tags', async t => {
  const { get } = await serving(t);
  const photos = await (await get('/api/photos')).json();
  assert.equal(photos.length, 2);
  assert.equal(photos[0].id, 'spypoint:p2', 'newest first');
  assert.equal(photos[1].id, 'spypoint:p1');
  // A person's tag and the camera's claim arrive apart, never as one list.
  assert.equal(photos[1].confirmed, 'buck', "a person's tag is fact");
  assert.equal(photos[1].claims, 'deer', "the camera's word is a claim");
  assert.equal(photos[1].wind, null, 'no reviewed-empty baseline, no wind talk');
  assert.equal(photos[1].cameraName, 'North Ridge');
  assert.match(photos[1].file, /^\/photos\/North_Ridge\/2026-08\/p1\.jpg$/,
    'addressed by URL, with separators normalized for the web');
  assert.equal(photos[0].file, null, 'a photo with no downloaded file says so');
});

test('a downloaded photo is served with the right content type', async t => {
  const { get } = await serving(t);
  const res = await get('/photos/North_Ridge/2026-08/p1.jpg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await res.arrayBuffer()).byteLength, 4);
});

test('path traversal cannot escape the photo directory', async t => {
  // The path comes straight from a URL, so it is untrusted. Without the check
  // in servePhoto, any of these would hand out a file from elsewhere on disk.
  const { base, out } = await serving(t);
  const attempts = [
    '/photos/../secret.txt',
    '/photos/..%2Fsecret.txt',
    '/photos/%2e%2e%2fsecret.txt',
    '/photos/North_Ridge/../../secret.txt',
    '/photos/....//secret.txt',
    '/photos/..%252Fsecret.txt',
  ];
  for (const p of attempts) {
    // fetch normalizes some of these, so request the raw path over a socket to
    // be sure the server itself refuses rather than the client rewriting it.
    const res = await fetch(base + p, { redirect: 'manual' });
    const body = await res.text();
    assert.ok(res.status === 403 || res.status === 404,
      `${p} was refused (got ${res.status})`);
    assert.ok(!body.includes('coordinates of every stand'),
      `${p} did not leak the file outside the photo directory`);
  }
  // Sanity: the file really is there and really is readable by the process, so
  // the refusals above are the check working rather than a missing file.
  assert.equal(fs.readFileSync(path.join(out, 'secret.txt'), 'utf8'),
    'coordinates of every stand');
});

test('the state endpoint carries everything the page needs in one call', async t => {
  const { get } = await serving(t);
  const s = await (await get('/api/state')).json();
  assert.ok(Array.isArray(s.cameras) && s.cameras.length === 1);
  assert.ok(Array.isArray(s.photos) && s.photos.length === 2);
  assert.equal(s.plan, null, 'no hunt plan has been generated yet');
  assert.equal(s.counts.cameras, 1);
  assert.equal(s.counts.detections, 2);
  assert.ok(Date.parse(s.generatedAt), 'stamped with when it was built');
});

test('health reports the store contents', async t => {
  const { get } = await serving(t);
  const h = await (await get('/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.cameras, 1);
  assert.equal(h.photos, 2);
});

test('health says which code the process is running, and whether it is stale', async t => {
  // The pages are built at import time, so a server left running from before a
  // pull serves the old HTML with nothing to show for it. This is the one
  // place that can be asked without guessing.
  const { get } = await serving(t);
  const h = await (await get('/api/health')).json();
  assert.match(h.build.commit, /^[0-9a-f]{7}$/);
  assert.ok(Date.parse(h.build.startedAt), 'stamped with when the process booted');
  assert.equal(h.build.stale, false, 'a server started from the current tree is not stale');
  assert.equal(h.build.staleSince, null);
});

test('unknown paths 404 rather than erroring', async t => {
  const { get } = await serving(t);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/api/nope')).status, 404);
});

test('responses are not cached, so a saved tag shows up immediately', async t => {
  // A cached /api/state would make tagging feel broken: you save, reload, and
  // see the old answer.
  const { get } = await serving(t);
  for (const p of ['/', '/api/state', '/api/cameras']) {
    assert.match((await get(p)).headers.get('cache-control'), /no-store/, p);
  }
});

test('cameraFromRow never turns a missing value into a real one', () => {
  // The invariant carried all the way to the API: unknown must not arrive at a
  // client as 0, because 0% battery is an alarm and 0,0 is a spot in the ocean.
  const r = cameraFromRow({ id: 'x', name: 'Bare', provider: 'spypoint' });
  assert.equal(r.name, 'Bare');
  for (const f of ['lat', 'lng', 'battery', 'signal', 'lastSeen', 'model']) {
    assert.notEqual(r[f], 0, `${f} is not zero`);
    assert.ok(r[f] === undefined || r[f] === null, `${f} reads as unknown, not a value`);
  }
  // And a real zero survives as a zero — a flat battery must still alarm.
  const flat = cameraFromRow({ id: 'x', name: 'Flat', battery: 0, lat: 0, lng: 0 });
  assert.equal(flat.battery, 0, 'a genuine 0% is preserved');
  assert.equal(flat.lat, 0);
});

test('the server itself rejects traversal, not just the fetch client', async t => {
  // fetch() normalizes "..", so the test above partly proves the CLIENT is
  // careful. This writes the raw request bytes down a socket so the path
  // reaches the server exactly as an attacker would send it.
  const { base, out } = await serving(t);
  const { port } = new URL(base);
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write('GET /photos/../secret.txt HTTP/1.1\r\nHost: localhost\r\n'
        + 'Connection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', c => { data += c; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });

  assert.match(raw, /^HTTP\/1\.1 (403|404)/, 'the un-normalized path is refused');
  assert.ok(!raw.includes('coordinates of every stand'), 'the outside file did not leak');
  assert.equal(fs.readFileSync(path.join(out, 'secret.txt'), 'utf8'),
    'coordinates of every stand', 'and the file really was there to leak');
});
