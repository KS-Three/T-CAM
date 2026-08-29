/**
 * Photo fingerprints, and what "looks like wind" is allowed to mean.
 *
 * The rules under test: the hash is deterministic gradient arithmetic; a
 * distance only exists between hashes of the same algorithm; the wind verdict
 * exists only against a person's own reviewed-empty frames, at least three of
 * them, with every frame of the visit inside the gate — and a confirmed
 * detection anywhere in a visit removes it from the baseline, while the
 * camera's unconfirmed claims do not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HASH_W, HASH_H, WIND_BITS, WIND_MIN_BASELINE,
  lumaFromRGBA, dhashHex, isHash, hamming, windMatch, browserSource,
} from '../phash.mjs';
import {
  openDb, upsertCamera, upsertPhoto, addDetection, groupVisits, allVisits,
  setPhotoPhash, emptyBaseline,
} from '../db.mjs';
import { createServer } from '../serve.mjs';
import { reviewHtml } from '../review-page.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const flat = v => new Array(HASH_W * HASH_H).fill(v);
const ramp = () => {
  // Every pixel darker than its right-hand neighbour: all 64 bits set.
  const g = [];
  for (let r = 0; r < HASH_H; r++) for (let c = 0; c < HASH_W; c++) g.push(c);
  return g;
};

test('the hash is the gradients, nothing else', () => {
  assert.equal(dhashHex(flat(128)), 'd1:' + '0'.repeat(64), 'a flat frame has no gradients');
  assert.equal(dhashHex(ramp()), 'd1:' + 'f'.repeat(64), 'a left-to-right ramp is all of them');
  assert.throws(() => dhashHex(flat(1).slice(1)), /grayscale values/);
});

test('brightening a whole frame changes nothing; an edit changes bits', () => {
  // The property the wind match rests on: exposure drift between two empty
  // frames must not read as difference.
  const base = ramp();
  assert.equal(dhashHex(base.map(v => v + 40)), dhashHex(base));
  const edited = ramp();
  for (let c = 0; c < HASH_W; c++) edited[3 * HASH_W + c] = 200 - c; // one row reversed
  const d = hamming(dhashHex(base), dhashHex(edited));
  assert.ok(d >= 8, `a rewritten region moves real bits (got ${d})`);
});

test('distance exists only between hashes of the same algorithm', () => {
  const a = dhashHex(flat(9)), b = dhashHex(ramp());
  assert.equal(hamming(a, a), 0);
  assert.equal(hamming(a, b), 256);
  assert.equal(hamming(a, null), null);
  assert.equal(hamming(a, 'd2:' + '0'.repeat(64)), null, 'a future algorithm is not comparable');
  assert.ok(isHash(a));
  assert.ok(!isHash('0'.repeat(64)), 'unprefixed is not a fingerprint');
  assert.ok(!isHash('d1:0000000000000000'), 'the old 64-bit shape is not one either');
});

test('luma weighs the eye, not the channels equally', () => {
  const red = lumaFromRGBA([255, 0, 0, 255])[0];
  const green = lumaFromRGBA([0, 255, 0, 255])[0];
  assert.ok(Math.abs(red - 76.245) < 1e-9);
  assert.ok(green > red, 'green carries most of what we see');
});

test('wind needs a baseline worth the name, and closeness', () => {
  const empty = dhashHex(flat(50));
  const deer = dhashHex(ramp());
  const base3 = [empty, empty, empty];
  assert.deepEqual(windMatch(empty, base3), { bits: 0, of: 3 });
  assert.equal(windMatch(empty, base3.slice(0, WIND_MIN_BASELINE - 1)), null,
    'two frames of history is a coincidence, not a baseline');
  assert.equal(windMatch(deer, base3), null, 'a different frame is not wind');
  assert.ok(WIND_BITS > 0 && WIND_BITS < 32, 'the gate leans toward silence');
});

test('the browser copy is the same arithmetic, not a retelling', () => {
  const ctx = vm.createContext({});
  vm.runInContext(browserSource('PHASH') + '\nPHASH;', ctx);
  const emitted = vm.runInContext('PHASH', ctx);
  assert.equal(emitted.dhashHex(ramp()), dhashHex(ramp()));
  assert.equal(emitted.hamming(dhashHex(flat(3)), dhashHex(ramp())), 256);
  assert.equal(emitted.WIND_BITS, WIND_BITS);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted.windMatch(dhashHex(flat(5)),
    [dhashHex(flat(5)), dhashHex(flat(5)), dhashHex(flat(5))]))), { bits: 0, of: 3 });
});

// ---------------------------------------------------------------------------
// The loop over HTTP: hash, review empty, and the suggestion appears
// ---------------------------------------------------------------------------

const EMPTY_HASH = 'd1:' + '0f'.repeat(32);
const DEER_HASH = 'd1:' + 'f0'.repeat(32);   // 256 bits from EMPTY_HASH — not wind

async function serving(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-phash-'));
  const db = openDb(out);
  upsertCamera(db, { ...PROVIDERS.spypoint.normalizeCamera(FLEX_M), id: 'cam1', name: 'Oak Ridge' },
    { provider: 'spypoint' });
  const base = new Date('2026-11-09T06:30:00Z').getTime();
  // An empty three-frame burst (the future baseline), then two later visits:
  // one that will hash like the empties, one that will not.
  const at = [0, 4, 8, 3600, 7200];
  at.forEach((off, i) => upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'cam1', nativeId: 'p' + i,
    takenAt: new Date(base + off * 1000).toISOString(), url: 'http://x/' + i,
  }));
  groupVisits(db);
  db.close();

  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return {
    out,
    json: (method, p, body) => fetch(origin + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

test('a stored fingerprint must be one, and belong to a photo', async t => {
  const { json } = await serving(t);
  assert.equal((await json('POST', '/api/photos/spypoint:p0/phash',
    { phash: 'not-a-hash' })).status, 400);
  assert.equal((await json('POST', '/api/photos/nope/phash',
    { phash: EMPTY_HASH })).status, 404);
  const ok = await json('POST', '/api/photos/spypoint:p0/phash', { phash: EMPTY_HASH });
  assert.equal(ok.status, 200);
});

test('reviewed-empty frames become the baseline; the suggestion follows', async t => {
  const { out, json } = await serving(t);
  // The browser's part, played by hand: hash every frame.
  for (const [nid, h] of [['p0', EMPTY_HASH], ['p1', EMPTY_HASH], ['p2', EMPTY_HASH],
    ['p3', EMPTY_HASH], ['p4', DEER_HASH]]) {
    assert.equal((await json('POST', '/api/photos/spypoint:' + nid + '/phash',
      { phash: h })).status, 200);
  }

  // Nothing is suggested before anything has been reviewed.
  let data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  assert.ok(data.visits.every(v => v.wind === null), 'no baseline, no verdict');
  assert.ok(data.visits.every(v => v.photos.every(p => p.hashed)),
    'but the page is told the fingerprints exist');

  // Review the three-frame burst as empty — the camera's own unconfirmed
  // claim on one of its frames must NOT keep it out of the baseline.
  const db = openDb(out);
  addDetection(db, { photoId: 'spypoint:p1', species: 'deer', source: 'camera-ai' });
  const burst = allVisits(db).find(v => v.photo_count === 3);
  db.close();
  assert.equal((await json('POST', `/api/visits/${burst.id}/review`, {})).status, 200);

  data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  const like = data.visits.find(v => v.photos.some(p => p.id === 'spypoint:p3'));
  const deer = data.visits.find(v => v.photos.some(p => p.id === 'spypoint:p4'));
  assert.deepEqual(like.wind, { bits: 0, of: 3 },
    'the empty-looking visit is called: every frame matches the baseline');
  assert.equal(deer.wind, null, 'the different frame earns no wind talk');

  // A confirmed detection anywhere in a reviewed visit removes it from the
  // baseline — a person said something was there.
  const db2 = openDb(out);
  addDetection(db2, { photoId: 'spypoint:p0', species: 'deer', source: 'manual', confirmed: true });
  assert.equal(emptyBaseline(db2, 'spypoint:cam1').length, 0, 'the burst no longer counts as empty');
  db2.close();
  data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  assert.equal(data.visits.find(v => v.photos.some(p => p.id === 'spypoint:p3')).wind, null,
    'and with it goes the suggestion');
});

test('the baseline is per camera and per algorithm', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-phash-db-'));
  const db = openDb(dir);
  upsertCamera(db, { ...PROVIDERS.spypoint.normalizeCamera(FLEX_M), id: 'camA', name: 'A' },
    { provider: 'spypoint' });
  const p = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'camA', nativeId: 'x',
    takenAt: '2026-11-09T06:30:00.000Z',
  });
  groupVisits(db);
  const visit = allVisits(db)[0];
  db.prepare('UPDATE visits SET reviewed_at = ? WHERE id = ?')
    .run('2026-11-09T07:00:00.000Z', visit.id);
  setPhotoPhash(db, p.id, EMPTY_HASH);
  assert.deepEqual(emptyBaseline(db, 'spypoint:camA'), [EMPTY_HASH]);
  assert.deepEqual(emptyBaseline(db, 'spypoint:other'), [], 'another camera sees nothing');
  db.close();
});

// ---------------------------------------------------------------------------
// The pages carry it
// ---------------------------------------------------------------------------

test('the review page hashes frames and says when a visit looks like wind', () => {
  const html = reviewHtml({});
  const [script] = [...html.matchAll(
    /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.match(script, /PHASH\.dhashHex\(PHASH\.lumaFromRGBA/, 'the emitted copy does the hashing');
  assert.match(script, /Looks like wind/, 'the verdict speaks under its own heading');
  assert.match(script, /you reviewed as empty on this camera/,
    'and names whose judgement it is measured against');
  assert.match(script, /p\.file \|\| p\.hashed \|\| hashing\.has|!p\.file \|\| p\.hashed \|\| hashing\.has/,
    'frames are hashed once, and only downloaded ones');
});
