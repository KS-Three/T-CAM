/**
 * The radar routes: the frame list, the tile proxy, and the two refusals.
 *
 * The refusals are the point. Radar is a photograph, not a prediction, so
 * this server has to be willing to say "not drawing that" — for a frame that
 * has rolled off the reel (410, so the page refreshes instead of retrying)
 * and for a reel that has gone too old to mean anything.
 *
 * A stub upstream stands in for the vendor: the same process serves the index
 * AND the tiles, with the index pointing its `host` at the stub, which is how
 * a tile request can be followed all the way through without touching the
 * real service.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../db.mjs';
import { createServer } from '../serve.mjs';
import { STALE_CUTOFF_MINUTES, PALETTE, TILE_OPTIONS, MAX_ZOOM } from '../radar.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-radar-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A stand-in vendor. `state` is mutable so a test can age the reel, empty it,
 * or start failing, without restarting anything.
 */
async function stubVendor(t, state) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/index.json')) {
      if (state.down) { res.writeHead(503); return res.end('nope'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        version: '2.0', generated: state.newest, host: state.host,
        radar: {
          past: state.frames.map((f, i) => ({
            time: state.newest - (state.frames.length - 1 - i) * 600,
            path: '/v2/radar/' + f,
          })),
          nowcast: [],
        },
      }));
    }
    if (req.url.startsWith('/v2/radar/')) {
      if (state.tileStatus && state.tileStatus !== 200) {
        res.writeHead(state.tileStatus); return res.end('no');
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  state.host = `http://127.0.0.1:${port}`;
  process.env.TRAILCAM_RADAR_URL = `${state.host}/index.json`;
  t.after(() => {
    delete process.env.TRAILCAM_RADAR_URL;
    return new Promise(r => server.close(r));
  });
  return hits;
}

async function serving(t) {
  const out = tmp();
  openDb(out).close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { get: p => fetch(base + p) };
}

const freshState = () => ({
  newest: Math.floor(Date.now() / 1000) - 120,
  frames: ['aaa111', 'bbb222', 'ccc333'],
});

test('the frame list comes back with no vendor URL anywhere in it', async t => {
  const state = freshState();
  await stubVendor(t, state);
  const { get } = await serving(t);

  const res = await get('/api/radar');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.frames.length, 3);
  assert.deepEqual(body.frames.map(f => f.id), ['aaa111', 'bbb222', 'ccc333']);
  assert.ok(body.frames.every(f => f.kind === 'past'));
  assert.equal(body.tooOld, false);
  assert.equal(body.cutoffMinutes, STALE_CUTOFF_MINUTES);

  // The page must not be able to reach the vendor directly — the same rule
  // the offline test pins for every other layer.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('127.0.0.1:' + new URL(state.host).port),
    'the upstream host does not ride along');
  assert.ok(!raw.includes('/v2/radar/'), 'nor the upstream path');
});

test('a tile is proxied, cached, and asked for with the no-green palette', async t => {
  const state = freshState();
  const hits = await stubVendor(t, state);
  const { get } = await serving(t);
  await get('/api/radar');

  const first = await get('/radar/bbb222/7/31/46');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(first.headers.get('x-radar-cache'), 'miss');
  assert.equal(Buffer.from(await first.arrayBuffer()).length, PNG.length);

  const tileHit = hits.find(h => h.startsWith('/v2/radar/'));
  assert.equal(tileHit, `/v2/radar/bbb222/256/7/31/46/${PALETTE}/${TILE_OPTIONS}.png`);

  // Cached: scrubbing back and forth over a dozen frames must not refetch
  // every tile.
  const second = await get('/radar/bbb222/7/31/46');
  assert.equal(second.headers.get('x-radar-cache'), 'hit');
  assert.equal(hits.filter(h => h.startsWith('/v2/radar/')).length, 1);

  // Short cache-control: this is the one image on the map that must not be
  // held the way ground is.
  assert.match(second.headers.get('cache-control'), /max-age=300/);
});

test('a frame that has rolled off the reel answers 410, not 404', async t => {
  // The page uses the distinction: 410 means refresh the reel, where a 404
  // would just look like a broken tile and get retried on every pan.
  const state = freshState();
  await stubVendor(t, state);
  const { get } = await serving(t);
  await get('/api/radar');

  const gone = await get('/radar/zzz999/7/31/46');
  assert.equal(gone.status, 410);
  assert.match((await gone.json()).error, /expired/);
});

test('a malformed frame id never becomes part of an outbound request', async t => {
  const state = freshState();
  const hits = await stubVendor(t, state);
  const { get } = await serving(t);
  await get('/api/radar');
  const before = hits.length;

  // Path traversal and shouting both fail the route pattern itself, so they
  // fall through to the 404 handler rather than reaching the radar branch.
  for (const bad of ['/radar/..%2f..%2fetc/7/1/1', '/radar/AAA111/7/1/1']) {
    const res = await get(bad);
    assert.ok(res.status === 400 || res.status === 404, bad + ' is refused');
  }
  // Out-of-range coordinates are caught before any fetch.
  const oor = await get('/radar/aaa111/7/999999/1');
  assert.equal(oor.status, 400);
  assert.match((await oor.json()).error, /out of range/);
  assert.equal(hits.length, before, 'none of that reached the vendor');
});

test('a reel past the cutoff comes back refusing to be drawn, and saying why', async t => {
  const state = freshState();
  state.newest = Math.floor(Date.now() / 1000) - (STALE_CUTOFF_MINUTES + 5) * 60;
  await stubVendor(t, state);
  const { get } = await serving(t);

  const body = await (await get('/api/radar')).json();
  assert.equal(body.tooOld, true);
  assert.ok(body.ageMinutes > STALE_CUTOFF_MINUTES);
  assert.match(body.note, /needs a signal/);
  assert.match(body.note, /does not look old/,
    'the reason is given, not just the refusal');
});

test('losing the vendor keeps the last reel, flagged, so age can still be judged', async t => {
  const state = freshState();
  await stubVendor(t, state);
  const { get } = await serving(t);
  await get('/api/radar');

  state.down = true;
  // Inside the index TTL nothing is refetched, so this still reads clean —
  // which is correct: the reel genuinely has not aged out yet.
  const body = await (await get('/api/radar')).json();
  assert.equal(body.cached, true);
  assert.equal(body.frames.length, 3);
});

test('with no reel and no vendor, the answer is a refusal rather than an empty loop', async t => {
  const state = { ...freshState(), down: true };
  await stubVendor(t, state);
  const { get } = await serving(t);

  const res = await get('/api/radar');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no radar/);
});

test('an upstream tile failure is reported, not served as a blank image', async t => {
  const state = freshState();
  await stubVendor(t, state);
  const { get } = await serving(t);
  await get('/api/radar');

  state.tileStatus = 500;
  const res = await get('/radar/aaa111/7/31/46');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /HTTP 500/);
});

test('two servers keep two loops', async t => {
  // The caches hang off createServer, not off the module, so one test's reel
  // cannot answer for another's.
  const state = freshState();
  const hits = await stubVendor(t, state);
  const a = await serving(t);
  const b = await serving(t);
  await a.get('/api/radar');
  await b.get('/api/radar');
  assert.equal(hits.filter(h => h.startsWith('/index.json')).length, 2);
});

test('above the measured ceiling the server refuses instead of fetching a placard', async t => {
  // The service answers z8 and deeper with an HTTP 200 carrying a "Zoom Level
  // Not Supported" image — identical 1370 bytes at z8 and at z12 — so a
  // request that got through would put grey lettering on the map with nothing
  // in the response to catch it. The page stretches the deepest real zoom
  // instead; this refuses on behalf of a page that has not been reloaded.
  const state = freshState();
  const hits = await stubVendor(t, state);
  const { get } = await serving(t);
  await get('/api/radar');
  const before = hits.filter(h => h.startsWith('/v2/radar/')).length;

  const res = await get('/radar/aaa111/' + (MAX_ZOOM + 1) + '/100/100');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /only served to zoom/);
  assert.equal(hits.filter(h => h.startsWith('/v2/radar/')).length, before,
    'and nothing was asked of the vendor');

  const ok = await get('/radar/aaa111/' + MAX_ZOOM + '/31/46');
  assert.equal(ok.status, 200, 'the ceiling itself is still served');
});
