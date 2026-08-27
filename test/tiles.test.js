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

const bounds = { west: -89.045, south: 43.880, east: -89.020, north: 43.892 };

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
