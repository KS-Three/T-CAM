/**
 * The 3D view in the woods: the ground keeps answering when the network stops.
 *
 * Three layers can be missing a connection, and each has its own fallback:
 *
 *  - The SERVER's internet (a cabin): terrainFor answers from the grids
 *    already saved in the database instead of surfacing USGS's failure.
 *  - The server itself (a phone with no bars): the service worker replays the
 *    newest cached terrain answer whose bounds contain the requested point —
 *    exact-URL matching would never hit, because the URL carries the map
 *    centre at full float precision and no two pans are identical.
 *  - Nothing saved at all: the failure surfaces honestly, because a 3D view
 *    invented from nothing would be worse than none.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { terrainFor } from '../serve.mjs';
import { openDb, saveTerrainGrid } from '../db.mjs';
import { planGrid } from '../terrain.mjs';
import { swSource } from '../offline.mjs';
import { mapScript } from '../map-view.mjs';

// Invented ground (the 44.12 / -90.65 cluster), like every fixture here.
const STORED = { west: -90.66, south: 44.11, east: -90.64, north: 44.13 };

function seededDb() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-off3d-'));
  const db = openDb(out);
  const grid = planGrid(STORED, 10);
  grid.z = new Float32Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) grid.z[r * grid.cols + c] = 250 + c * 0.1 + r * 0.05;
  }
  saveTerrainGrid(db, grid);
  return db;
}

const noInternet = () => { throw new Error('no internet'); };

// ---------------------------------------------------------------------------
// The server: saved ground beats a 502
// ---------------------------------------------------------------------------

test('with USGS unreachable, the saved ground that covers the spot answers', async () => {
  const db = seededDb();
  // Centred inside the stored grid but asking past its east edge, so the
  // stored grid does NOT cover the request and a fetch is attempted.
  const t = await terrainFor(db, {
    lat: 44.12, lng: -90.645, radiusM: 800, spacingM: 10, fetchImpl: noInternet,
  });
  assert.equal(t.covered, true);
  assert.equal(t.cached, true);
  assert.match(t.note, /USGS is unreachable/, 'and it says so rather than passing as live');
  // The bounds are the SAVED ground's, not the requested view's — the page
  // draws what it is given, and claiming the requested bounds would stretch
  // the stored grid over ground it never measured.
  assert.ok(Math.abs(t.bounds.west - STORED.west) < 1e-6);
  // The stored grid's east edge overshoots the asked-for bounds by up to half
  // a cell, because planGrid rounds to whole cells; the tolerance is one cell.
  assert.ok(t.bounds.east <= STORED.east + 2e-4,
    `east ${t.bounds.east} is the stored grid's edge, not the 800 m view's`);
});

test('with USGS unreachable and nothing saved under the spot, the failure surfaces', async () => {
  const db = seededDb();
  await assert.rejects(
    () => terrainFor(db, { lat: 44.5, lng: -90.9, radiusM: 300, spacingM: 10, fetchImpl: noInternet }),
    /no internet/,
    'ground invented from nothing would be worse than an honest error');
});

test('a request the saved ground fully covers never fetches at all', async () => {
  const db = seededDb();
  const t = await terrainFor(db, {
    lat: 44.12, lng: -90.65, radiusM: 300, spacingM: 10, fetchImpl: noInternet,
  });
  assert.equal(t.covered, true);
  assert.equal(t.cached, true);
  assert.equal(t.note, null, 'a cache hit is not a fallback, and gets no warning');
});

// ---------------------------------------------------------------------------
// The service worker: terrain replayed for any view it covers
// ---------------------------------------------------------------------------

function swHarness(fetchImpl) {
  const store = new Map();          // url -> Response
  const cache = {
    match: async req => store.get(typeof req === 'string' ? req : req.url),
    keys: async () => [...store.keys()].map(u => ({ url: u })),
    put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
    add: async () => {},
  };
  const handlers = {};
  const ctx = {
    self: {
      addEventListener: (k, fn) => { handlers[k] = fn; },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
      location: { origin: 'http://cam.test' },
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: fetchImpl,
    URL, Response, Headers, Promise, Date, Number, JSON,
  };
  vm.createContext(ctx);
  new vm.Script(swSource()).runInContext(ctx);
  const ask = url => new Promise((resolve, reject) => {
    handlers.fetch({
      request: { url, method: 'GET', mode: 'cors' },
      respondWith: p => Promise.resolve(p).then(resolve, reject),
    });
  });
  return { ask, store };
}

/** A cached /api/terrain answer: its bounds, when it was stamped, a marker. */
const terrainAnswer = (bounds, at, mark) => new Response(
  JSON.stringify({ covered: true, bounds, mark }),
  { status: 200, headers: { 'content-type': 'application/json', 'x-sw-cached-at': at } });

const T = 'http://cam.test/api/terrain';

test('offline, a cached answer covering the point replays for a different URL', async () => {
  const { ask, store } = swHarness(() => { throw new TypeError('failed to fetch'); });
  store.set(T + '?lat=44.121&lng=-90.649&radius=500&spacing=10',
    terrainAnswer(STORED, '2026-08-20T10:00:00Z', 'covering'));
  store.set(T + '?lat=44.9&lng=-89.1&radius=500&spacing=10',
    terrainAnswer({ west: -89.2, south: 44.8, east: -89.0, north: 45.0 },
      '2026-08-27T10:00:00Z', 'elsewhere'));
  // A pan later: same ground, different centre, a URL never seen before.
  const res = await ask(T + '?lat=44.1187&lng=-90.6521&radius=480&spacing=11');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mark, 'covering', 'the answer whose bounds contain the point, not the newest overall');
  assert.ok(res.headers.get('x-sw-cached-at'), 'still stamped, so the page can say how old');
});

test('of two answers covering the point, the newest wins', async () => {
  const { ask, store } = swHarness(() => { throw new TypeError('failed to fetch'); });
  store.set(T + '?lat=44.12&lng=-90.65&radius=300&spacing=10',
    terrainAnswer(STORED, '2026-08-01T10:00:00Z', 'stale'));
  store.set(T + '?lat=44.121&lng=-90.651&radius=600&spacing=10',
    terrainAnswer(STORED, '2026-08-27T10:00:00Z', 'fresh'));
  const body = await (await ask(T + '?lat=44.125&lng=-90.645&radius=200&spacing=10')).json();
  assert.equal(body.mark, 'fresh',
    'a later save of the same ground is a finer or larger fetch of it');
});

test('a 5xx from the server falls back to saved ground too', async () => {
  // The cabin, seen from the phone: the server is up but IT has no internet,
  // so it answers 502. For terrain that is "could not be read now", and the
  // ground saved last week beats the error.
  const { ask, store } = swHarness(async () =>
    new Response(JSON.stringify({ error: 'terrain could not be read' }), { status: 502 }));
  store.set(T + '?lat=44.12&lng=-90.65&radius=300&spacing=10',
    terrainAnswer(STORED, '2026-08-20T10:00:00Z', 'saved'));
  const res = await ask(T + '?lat=44.122&lng=-90.648&radius=350&spacing=10');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mark, 'saved');
});

test('a 4xx passes through untouched — the server judged the request, it did not fail', async () => {
  const { ask, store } = swHarness(async () =>
    new Response(JSON.stringify({ error: 'lat and lng are required' }), { status: 400 }));
  store.set(T + '?lat=44.12&lng=-90.65&radius=300&spacing=10',
    terrainAnswer(STORED, '2026-08-20T10:00:00Z', 'saved'));
  const res = await ask(T + '?lat=44.12&lng=-90.65&radius=300&spacing=10&broken=1');
  assert.equal(res.status, 400, 'a covering cache must not paper over a refused request');
});

test('offline with nothing covering the point, the failure is honest', async () => {
  const { ask, store } = swHarness(() => { throw new TypeError('failed to fetch'); });
  store.set(T + '?lat=44.9&lng=-89.1&radius=500&spacing=10',
    terrainAnswer({ west: -89.2, south: 44.8, east: -89.0, north: 45.0 },
      '2026-08-27T10:00:00Z', 'elsewhere'));
  const res = await ask(T + '?lat=44.12&lng=-90.65&radius=300&spacing=10');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /no ground saved for this spot/);
});

test('an answer that is not real ground never serves as a fallback', async () => {
  // covered:false answers ("no LiDAR here") and non-JSON junk both sit in the
  // cache legitimately; neither is a mesh.
  const { ask, store } = swHarness(() => { throw new TypeError('failed to fetch'); });
  store.set(T + '?lat=44.12&lng=-90.65&radius=300&spacing=10', new Response(
    JSON.stringify({ covered: false, bounds: STORED, why: 'no LiDAR' }), { status: 200 }));
  store.set(T + '?lat=44.121&lng=-90.651&radius=300&spacing=10',
    new Response('<html>not json</html>', { status: 200 }));
  const res = await ask(T + '?lat=44.12&lng=-90.65&radius=310&spacing=10');
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// The page: Save offline saves the ground, and stale ground says so
// ---------------------------------------------------------------------------

test('Save offline saves the ground and the drape, not only the map tiles', () => {
  const fn = mapScript.slice(mapScript.indexOf('async function saveGroundForView'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /\/api\/terrain\?lat=/, 'the elevation is fetched, storing it server-side');
  assert.match(body, /terrainRequestForView\(\)/,
    'with the same radius and spacing the Terrain button would use, so the grid is a cache hit later');
  assert.match(body, /textureFor3d\(body\.bounds\)/,
    'and the 3D drape tiles are pulled once through the page, landing in the worker cache');

  const click = mapScript.slice(mapScript.indexOf('offlineBtn.onclick'));
  const handler = click.slice(0, click.indexOf('\n};'));
  const tiles = handler.indexOf('/api/tiles/save');
  const ground = handler.indexOf('saveGroundForView()');
  assert.ok(tiles !== -1 && ground !== -1 && tiles < ground, 'tiles first, then the ground');
  assert.match(handler, /Tiles saved, but the ground could not be/,
    'a ground failure is reported without undoing the tile save that worked');
});

test('ground served from a fallback is dated, not passed off as live', () => {
  const fn = mapScript.slice(mapScript.indexOf('async function loadTerrain'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /x-sw-cached-at/, 'the worker’s stamp reaches the note');
  assert.match(body, /body\.note/, 'and so does the server’s own fallback note');
});

test('the worker routes terrain through its own covering fallback', () => {
  const src = swSource();
  const dispatch = src.slice(src.indexOf("addEventListener('fetch'"));
  assert.match(dispatch, /\/api\/terrain/, 'terrain has its own branch');
  assert.match(src, /function cachedTerrainCovering/, 'with the containment search behind it');
});
