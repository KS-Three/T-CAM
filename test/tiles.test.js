import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  expandTile, tileBounds3857, sourceDescriptors, sourceByKey, BASE_SOURCES, MERC,
} from '../tile-sources.mjs';
import {
  getTile, prefetch, cacheStats, clearCache, tilesForBounds, tileDir, PREFETCH_MAX_TILES,
  MAX_AGE_MS,
} from '../tile-cache.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-tiles-'));

// A stand-in tile server: one pixel of PNG, and a record of what was asked for.
function fakeTiles({ fail = false, throws = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (throws) throw new Error('network is down');
    if (fail) return { ok: false, status: 500 };
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
    };
  };
  return { impl, calls };
}

/** A stand-in that answers only when the test says so, and says what it sent. */
function gatedTiles(bytes = [1, 2, 3, 4]) {
  const calls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const impl = async (url) => {
    calls.push(url);
    await gate;
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array(bytes).buffer,
    };
  };
  return { impl, calls, release: () => release() };
}

/**
 * Wait until `fn()` is true. The concurrency tests need the FIRST request to be
 * genuinely in flight before the second is issued: start both at once and, on a
 * loaded machine, the first can finish and write the tile before the second
 * even looks in the cache - at which point the second is an ordinary cache hit
 * and the test is measuring nothing. The gate stays shut throughout, so the
 * first cannot complete until the test says so.
 */
async function until(fn, what = 'condition', ms = 2000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Backdate a cached tile so it counts as past MAX_AGE_MS. */
async function age(out, key, z, x, y, ms = MAX_AGE_MS + 60_000) {
  const dir = path.join(tileDir(out), key, String(z), String(x));
  const [file] = await fsp.readdir(dir);
  const when = new Date(Date.now() - ms);
  await fsp.utimes(path.join(dir, file), when, when);
  return path.join(dir, file);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test('each source kind expands to the URL that service actually wants', () => {
  // Esri and USGS put ROW before column. Swapping them yields a valid-looking
  // URL for the wrong piece of ground, which is the kind of bug you only catch
  // by looking at the map and knowing the area.
  assert.equal(
    expandTile(BASE_SOURCES.map, 14, 4066, 5949),
    'https://tile.openstreetmap.org/14/4066/5949.png');
  assert.equal(
    expandTile(BASE_SOURCES.satellite, 14, 4066, 5949),
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5949/4066');
});

test('an export source gets a Web Mercator box, not degrees', () => {
  const url = expandTile(sourceByKey('vpa'), 14, 4066, 5949);
  assert.match(url, /bbox=-?\d+\.?\d*,/);
  assert.match(url, /bboxSR=3857/, 'the box is in metres to match the base tiles');
  assert.ok(!url.includes('{bbox3857}'), 'the placeholder is actually replaced');
});

test('tile bounds cover the whole world at zoom 0 and quarter it at zoom 1', () => {
  const whole = tileBounds3857(0, 0, 0).split(',').map(Number);
  assert.ok(Math.abs(whole[0] + MERC) < 1e-6);
  assert.ok(Math.abs(whole[1] + MERC) < 1e-6);
  assert.ok(Math.abs(whole[2] - MERC) < 1e-6);
  assert.ok(Math.abs(whole[3] - MERC) < 1e-6);

  // Zoom 1 tile (0,0) is the north-west quarter: west half, north half.
  const nw = tileBounds3857(1, 0, 0).split(',').map(Number);
  assert.ok(Math.abs(nw[0] + MERC) < 1e-6, 'west edge');
  assert.ok(Math.abs(nw[1] - 0) < 1e-6, 'south edge is the equator');
  assert.ok(Math.abs(nw[2] - 0) < 1e-6, 'east edge is the prime meridian');
  assert.ok(Math.abs(nw[3] - MERC) < 1e-6, 'north edge');
});

test('the served page is given proxy templates and never an upstream URL', () => {
  // This is what makes offline work: if the page talked to tile services
  // directly, nothing would pass through the cache.
  const proxied = sourceDescriptors({ proxied: true });
  for (const src of [...Object.values(proxied.base), ...Object.values(proxied.overlays)]) {
    assert.match(src.template, /^\/tiles\//, `${src.key} points at this server`);
    assert.equal(src.kind, 'xyz', 'and is addressed as an ordinary slippy tile');
  }
  assert.match(proxied.base.hybrid.reference, /^\/tiles\/hybrid-ref\//,
    'including the hybrid place-name layer');

  // The static file has no server to ask, so it gets the real thing.
  const direct = sourceDescriptors({ proxied: false });
  assert.match(direct.base.map.template, /^https:\/\/tile\.openstreetmap\.org/);
  assert.equal(direct.base.satellite.kind, 'zyx', 'keeping its real coordinate order');
});

test('the LiDAR layer asks USGS for the stretch rendering, defined once', () => {
  // Gray-Stretch is the load-bearing choice: the service's fixed hillshades
  // are scaled for real hills and draw the flat home ground near-solid white
  // (measured — see tile-sources.mjs). The stretch normalises each window to
  // its own relief, so a two-foot draw reads. Losing the rule, or the two
  // copies of it drifting apart, would be invisible in any structural sense
  // except this one.
  const url = expandTile(sourceByKey('lidar'), 15, 8132, 11764);
  assert.match(url, /^https:\/\/elevation\.nationalmap\.gov/);
  assert.match(url, /bboxSR=3857/, 'metres, to line up with the slippy tiles');
  assert.ok(url.includes('Hillshade%20Gray-Stretch'), 'the adaptive rendering');
  assert.ok(!url.includes('{bbox3857}'), 'the placeholder is replaced');
  assert.equal(BASE_SOURCES.lidar.maxZoom, 17, '1 m data has nothing new past z17');
  assert.ok(BASE_SOURCES.lidar.bulkAllowed, 'a federal service; Save offline may prefetch');
  assert.equal(sourceByKey('lidarshade').template, BASE_SOURCES.lidar.template,
    'the overlay is the SAME rendering, referenced not repeated');
});

test('an overlay says how it sits on the imagery, and the page obeys', async () => {
  const d = sourceDescriptors({ proxied: true });
  assert.equal(d.overlays.lidarshade.blend, 'overlay',
    'overlay, not multiply — multiply dimmed dark canopy into mud (measured in screenshots)');
  assert.equal(d.overlays.lidarshade.opacity, 0.8);
  assert.equal(d.overlays.vpa.blend, null, 'the DNR washes keep their flat look');
  const { mapScript } = await import('../map-view.mjs');
  assert.match(mapScript, /ov\.style\.opacity = String\(def\.opacity \?\? 0\.55\)/,
    'per-overlay opacity, defaulting to the old wash');
  assert.match(mapScript, /if \(def\.blend\) ov\.style\.mixBlendMode = def\.blend/,
    'and the blend is applied when a source declares one');
});

test('every proxy template names a source the server can resolve', () => {
  // Drift guard: a template pointing at a key sourceByKey does not know would
  // 400 on every tile, and the map would simply be blank.
  const proxied = sourceDescriptors({ proxied: true });
  const keys = [...Object.values(proxied.base), ...Object.values(proxied.overlays)]
    .map(s => s.template.split('/')[2]);
  keys.push(proxied.base.hybrid.reference.split('/')[2]);
  for (const key of keys) {
    assert.ok(sourceByKey(key), `the server can resolve "${key}"`);
  }
});

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

test('a tile is fetched once and served from disk after that', async () => {
  const out = tmp();
  const { impl, calls } = fakeTiles();
  const first = await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: impl });
  assert.equal(first.cached, false);
  assert.equal(calls.length, 1);

  const second = await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: impl });
  assert.equal(second.cached, true, 'served from disk');
  assert.equal(calls.length, 1, 'and the tile service is not asked twice');
  assert.deepEqual(second.body, first.body);
});

test('with no network, a cached tile still draws', async () => {
  // The entire point. A stale map beats no map when you are out of signal.
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  const offline = fakeTiles({ throws: true });
  const tile = await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: offline.impl });
  assert.equal(tile.cached, true);
  assert.ok(tile.body.length > 0);
});

test('with no network and no cached copy, the failure is reported', async () => {
  // Not a blank tile pretending to be ground.
  const out = tmp();
  await assert.rejects(
    () => getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles({ throws: true }).impl }),
    /network is down/);
});

test('an upstream error falls back to a cached copy rather than breaking the map', async () => {
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  const tile = await getTile(out, 'satellite', 14, 4066, 5949,
    { fetchImpl: fakeTiles({ fail: true }).impl });
  assert.equal(tile.cached, true);
});

test('nonsense coordinates and unknown sources are refused', async () => {
  const out = tmp();
  const { impl, calls } = fakeTiles();
  await assert.rejects(() => getTile(out, 'nope', 14, 1, 1, { fetchImpl: impl }), /unknown tile source/);
  await assert.rejects(() => getTile(out, 'satellite', 2, 99999, 1, { fetchImpl: impl }), /out of range/);
  await assert.rejects(() => getTile(out, 'satellite', -1, 0, 0, { fetchImpl: impl }), /out of range/);
  await assert.rejects(() => getTile(out, 'satellite', 14, 1.5, 1, { fetchImpl: impl }), /out of range/);
  assert.equal(calls.length, 0, 'nothing was fetched');
});

// ---------------------------------------------------------------------------
// Never waiting on ground already on disk
// ---------------------------------------------------------------------------

test('an expired tile is served from disk without waiting for the refresh', async () => {
  // The reason this exists: measured cold, a DNR CWD tile takes 2.5-3.7 s and a
  // LiDAR tile 1.5-2.7 s. Blocking a redraw of ground already on disk for that
  // long, to replace imagery re-flown in years, is not a trade worth making.
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  await age(out, 'satellite', 14, 4066, 5949);

  const slow = gatedTiles([9, 9, 9, 9]);   // upstream that never answers on its own
  const t0 = Date.now();
  const tile = await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  const waited = Date.now() - t0;

  assert.equal(tile.cached, true);
  assert.equal(tile.stale, true, 'and it says the bytes are old');
  assert.ok(tile.body.length > 0);
  assert.ok(waited < 500, `answered in ${waited} ms without waiting on upstream`);
  assert.equal(slow.calls.length, 1, 'the refresh did start');

  slow.release();
  assert.equal(await tile.revalidating, true);
});

test('the background refresh actually replaces the bytes', async () => {
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  const file = await age(out, 'satellite', 14, 4066, 5949);
  const before = await fsp.readFile(file);

  const fresh = gatedTiles([42, 42, 42, 42]);
  const stale = await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fresh.impl });
  assert.deepEqual(Buffer.from(stale.body), before, 'the caller got the OLD bytes');

  fresh.release();
  await stale.revalidating;

  const next = await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  assert.deepEqual([...next.body], [42, 42, 42, 42], 'the next caller gets the new ones');
  assert.equal(next.stale, undefined, 'and it is fresh again');
});

test('a refresh that fails leaves the old tile in place and reports it', async () => {
  // Offline, on ground last seen four months ago. The map must still draw.
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  await age(out, 'satellite', 14, 4066, 5949);

  const tile = await getTile(out, 'satellite', 14, 4066, 5949,
    { fetchImpl: fakeTiles({ throws: true }).impl });
  assert.equal(tile.cached, true);
  assert.equal(tile.stale, true);
  assert.equal(await tile.revalidating, false, 'the failure is caught, not thrown');

  const again = await getTile(out, 'satellite', 14, 4066, 5949,
    { fetchImpl: fakeTiles({ throws: true }).impl });
  assert.ok(again.body.length > 0, 'the old tile survived the failed refresh');
});

test('two requests for the same uncached tile make one upstream fetch', async () => {
  // A pan that crosses a tile boundary and comes back asks twice. On CWD that
  // was two three-second requests for one picture.
  const out = tmp();
  const slow = gatedTiles();
  const first = getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  await until(() => slow.calls.length === 1, 'the first request to reach upstream');
  const second = getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  slow.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(slow.calls.length, 1, 'asked upstream once');
  assert.deepEqual([...a.body], [...b.body], 'both callers got the tile');
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
});

test('different tiles are not folded into one another', async () => {
  const out = tmp();
  const slow = gatedTiles();
  const first = getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  await until(() => slow.calls.length === 1, 'the first request to reach upstream');
  const second = getTile(out, 'satellite', 14, 4067, 5949, { fetchImpl: slow.impl });
  slow.release();
  await Promise.all([first, second]);
  assert.equal(slow.calls.length, 2);
});

test('two stores are two caches and do not answer for each other', async () => {
  const a = tmp(), b = tmp();
  const slow = gatedTiles();
  const first = getTile(a, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  await until(() => slow.calls.length === 1, 'the first request to reach upstream');
  const second = getTile(b, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  slow.release();
  await Promise.all([first, second]);
  assert.equal(slow.calls.length, 2, 'each store fetched its own copy');
});

test('a caller that brought its own abort signal is not folded in', async () => {
  // Deduplicating it would hand it somebody else's request to cancel.
  const out = tmp();
  const slow = gatedTiles();
  const first = getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: slow.impl });
  await until(() => slow.calls.length === 1, 'the first request to reach upstream');
  const second = getTile(out, 'satellite', 14, 4066, 5949,
    { fetchImpl: slow.impl, signal: new AbortController().signal });
  slow.release();
  await Promise.all([first, second]);
  assert.equal(slow.calls.length, 2);
});

test('saving a view for offline waits for real bytes, stale is not good enough', async () => {
  // Everywhere else an old tile is fine to draw with. Here it is not: the point
  // is to come back with bytes that will still be there in the woods.
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  const file = await age(out, 'satellite', 14, 4066, 5949);

  const { impl, calls } = fakeTiles();
  const r = await prefetch(out, {
    bounds, zooms: [14], sources: ['satellite'], fetchImpl: impl,
  });
  assert.ok(calls.length > 0, 'the expired tile was actually refetched');
  assert.ok(r.saved > 0);
  const stat = await fsp.stat(file);
  assert.ok(Date.now() - stat.mtimeMs < 60_000, 'and rewritten before it reported success');
});

test('a partly written tile never becomes a cached one', async () => {
  // Tiles are written to a temporary name and renamed, so an interrupted write
  // cannot leave a truncated image that the cache then serves forever.
  const out = tmp();
  await getTile(out, 'satellite', 14, 4066, 5949, { fetchImpl: fakeTiles().impl });
  const files = await fsp.readdir(path.join(tileDir(out), 'satellite', '14', '4066'));
  assert.deepEqual(files.filter(f => f.endsWith('.part')), [], 'no leftovers');
});

// ---------------------------------------------------------------------------
// Saving a view
// ---------------------------------------------------------------------------

const bounds = { west: -90.665, south: 44.120, east: -90.640, north: 44.132 };

test('saving a view fetches the tiles that cover it', async () => {
  const out = tmp();
  const { impl, calls } = fakeTiles();
  const r = await prefetch(out, { bounds, zooms: [14, 15], sources: ['satellite'], fetchImpl: impl });
  assert.ok(r.saved > 0);
  assert.equal(r.failed, 0);
  assert.equal(calls.length, r.saved);
  assert.equal((await cacheStats(out)).tiles, r.saved);
});

test('a source whose terms forbid bulk downloading is refused, not quietly fetched', async () => {
  // OpenStreetMap's tiles are donated and their policy says so plainly.
  // "It's for offline use" is not an exemption.
  const out = tmp();
  const { impl, calls } = fakeTiles();
  const r = await prefetch(out, { bounds, zooms: [14], sources: ['map'], fetchImpl: impl });
  assert.equal(r.saved, 0);
  assert.equal(calls.length, 0, 'not a single tile was pulled');
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].why, /does not permit bulk downloading/);
  assert.match(r.refused[0].why, /Satellite/, 'and it says what to do instead');
});

test('a mixed request saves what it may and refuses the rest', async () => {
  const out = tmp();
  const { impl } = fakeTiles();
  const r = await prefetch(out, { bounds, zooms: [14], sources: ['map', 'satellite'], fetchImpl: impl });
  assert.ok(r.saved > 0, 'satellite still saved');
  assert.equal(r.refused.length, 1, 'OpenStreetMap still refused');
});

test('an oversized request is capped, and SAYS it was capped', async () => {
  // A truncated download reporting success is how someone ends up in the woods
  // with half a map.
  const out = tmp();
  const { impl } = fakeTiles();
  const r = await prefetch(out, {
    bounds, zooms: [14, 15, 16, 17, 18], sources: ['satellite'], fetchImpl: impl, max: 10,
  });
  assert.equal(r.requested, 10);
  assert.equal(r.capped, true);
  assert.ok(r.skipped > 0, 'and reports how many it left');
});

test('tiles covering a box are counted correctly', () => {
  const one = tilesForBounds(bounds, 10);
  assert.ok(one.length >= 1);
  const deeper = tilesForBounds(bounds, 14);
  assert.ok(deeper.length > one.length, 'a closer zoom needs more tiles');
  for (const t of deeper) {
    assert.ok(t.x >= 0 && t.x < 2 ** 14 && t.y >= 0 && t.y < 2 ** 14, 'and all are in range');
  }
});

test('the cache can be measured and cleared', async () => {
  const out = tmp();
  const { impl } = fakeTiles();
  await prefetch(out, { bounds, zooms: [14], sources: ['satellite'], fetchImpl: impl });
  const before = await cacheStats(out);
  assert.ok(before.tiles > 0);
  assert.ok(before.bytes > 0);
  assert.ok(before.bySource.satellite.tiles > 0, 'and broken down by source');

  const cleared = await clearCache(out, 'satellite');
  assert.equal(cleared.removedTiles, before.tiles);
  assert.equal((await cacheStats(out)).tiles, 0);
  await assert.rejects(() => clearCache(out, 'nope'), /unknown tile source/);
});

test('the prefetch ceiling is a real number, not unlimited', () => {
  assert.ok(Number.isInteger(PREFETCH_MAX_TILES) && PREFETCH_MAX_TILES > 0);
  assert.ok(PREFETCH_MAX_TILES <= 2000, 'and modest enough not to abuse a free service');
});
