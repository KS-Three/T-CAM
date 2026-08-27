/**
 * tile-cache.mjs — map tiles kept on disk, so the map works with no signal.
 *
 * onX charges for offline maps. The mechanism is not complicated: every tile
 * the page asks for comes through this server anyway, so keeping a copy on the
 * way past means the same ground draws again later without a network.
 *
 * On not abusing free tile services, which is the part that actually needs
 * thinking about:
 *
 * OpenStreetMap's tile usage policy explicitly forbids bulk downloading. Their
 * tiles are donated. Caching what a person has genuinely looked at is ordinary
 * client behaviour — every map app does it — but walking a bounding box to
 * hoover up an area is not, and "it's for offline use" does not change that.
 *
 * So two things are true here at once, deliberately:
 *
 *   - Every tile viewed is cached, for every source. This is free, invisible,
 *     and exactly what a browser would do anyway.
 *   - Deliberate pre-fetching is bounded (one view, a couple of zoom levels,
 *     a hard tile ceiling) and REFUSED outright for sources whose terms do not
 *     allow it. OpenStreetMap is marked bulkAllowed: false and the satellite
 *     layer is offered instead, rather than quietly doing it anyway.
 *
 * Tiles are stored as plain files under <out>/tiles/<source>/<z>/<x>/<y>.<ext>
 * rather than in SQLite. They are opaque blobs the server only ever streams
 * back, the filesystem already indexes them by path, and a directory of files
 * can be inspected, backed up, or deleted with ordinary tools.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sourceByKey, expandTile } from './tile-sources.mjs';

// A tile is immutable in practice — imagery is re-flown in years, not days —
// but not forever, so a cached tile is refreshed after this long.
export const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// A ceiling on one "save this view" request. Four zoom levels of a screenful is
// a few hundred tiles; anything far past that is someone trying to download a
// county, which is the thing the tile policies forbid.
export const PREFETCH_MAX_TILES = 400;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export const tileDir = out => path.join(out, 'tiles');

function tilePath(out, key, z, x, y, ext) {
  return path.join(tileDir(out), key, String(z), String(x), `${y}.${ext}`);
}

/** The cached file for a tile, whatever image type it was stored as. */
async function findCached(out, key, z, x, y) {
  for (const ext of ['png', 'jpg', 'webp']) {
    const p = tilePath(out, key, z, x, y, ext);
    try {
      const stat = await fsp.stat(p);
      return { path: p, ext, stat };
    } catch { /* not this one */ }
  }
  return null;
}

const contentTypeFor = ext =>
  ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';

/**
 * A tile, from disk if we have a fresh copy and from upstream otherwise.
 *
 * Returns the bytes plus where they came from, because "was this cached" is the
 * whole question when someone asks whether the map will work in the woods.
 */
export async function getTile(out, key, z, x, y, { fetchImpl = globalThis.fetch, signal } = {}) {
  const source = sourceByKey(key);
  if (!source) throw new Error(`unknown tile source "${key}"`);
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)
    || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    throw new Error('tile coordinates are out of range');
  }

  const hit = await findCached(out, key, z, x, y);
  if (hit && Date.now() - hit.stat.mtimeMs < MAX_AGE_MS) {
    return {
      body: await fsp.readFile(hit.path),
      contentType: contentTypeFor(hit.ext),
      cached: true,
    };
  }

  let res;
  try {
    res = await fetchImpl(expandTile(source, z, x, y), {
      signal,
      // Tile services ask for a real identifying agent, and OSM's policy
      // requires one. Saying what this is, honestly, is the price of using
      // somebody's donated bandwidth.
      headers: { 'user-agent': 'TrailCam/1.0 (personal trail-camera tool)' },
    });
  } catch (err) {
    // No network. If there is a stale copy, a stale map beats no map — this is
    // precisely the situation the cache exists for.
    if (hit) {
      return { body: await fsp.readFile(hit.path), contentType: contentTypeFor(hit.ext), cached: true, stale: true };
    }
    throw err;
  }
  if (!res.ok) {
    if (hit) {
      return { body: await fsp.readFile(hit.path), contentType: contentTypeFor(hit.ext), cached: true, stale: true };
    }
    throw new Error(`tile server returned HTTP ${res.status}`);
  }

  const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const body = Buffer.from(await res.arrayBuffer());
  const ext = EXT[contentType] ?? 'png';
  const dest = tilePath(out, key, z, x, y, ext);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // Written via a temporary file and renamed, so a tile interrupted halfway
  // never becomes a truncated image that the cache then serves forever.
  const tmp = `${dest}.${process.pid}.part`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, dest);
  return { body, contentType, cached: false };
}

/** Which tiles cover a bounding box at one zoom level. */
export function tilesForBounds({ west, south, east, north }, z) {
  const n = 2 ** z;
  const lngToX = lng => Math.floor((lng + 180) / 360 * n);
  const latToY = lat => {
    const s = Math.sin(lat * Math.PI / 180);
    return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  };
  const x0 = Math.max(0, lngToX(west)), x1 = Math.min(n - 1, lngToX(east));
  const y0 = Math.max(0, latToY(north)), y1 = Math.min(n - 1, latToY(south));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  return out;
}

/**
 * Pull down one view for offline use.
 *
 * Bounded on purpose, in three ways: the sources whose terms forbid bulk
 * fetching are refused rather than quietly fetched, the tile count is capped,
 * and only a few zoom levels are taken. What comes back says exactly what was
 * saved and what was skipped, because a silent cap would leave someone
 * believing they have a map they do not have.
 */
export async function prefetch(out, { bounds, zooms, sources, fetchImpl = globalThis.fetch,
  max = PREFETCH_MAX_TILES, concurrency = 4, onProgress = null } = {}) {
  const refused = [];
  const wanted = [];
  for (const key of sources) {
    const source = sourceByKey(key);
    if (!source) { refused.push({ key, why: 'unknown source' }); continue; }
    if (source.bulkAllowed === false) {
      refused.push({
        key,
        why: `${source.label} does not permit bulk downloading — its tiles are donated. `
          + 'Tiles you actually view are still cached; switch to Satellite to save an area.',
      });
      continue;
    }
    for (const z of zooms) {
      if (z > source.maxZoom) continue;
      for (const t of tilesForBounds(bounds, z)) wanted.push({ key, ...t });
    }
  }

  const capped = wanted.length > max;
  const todo = wanted.slice(0, max);
  let saved = 0, alreadyHad = 0, failed = 0, done = 0;

  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const t = todo[i];
      try {
        const r = await getTile(out, t.key, t.z, t.x, t.y, { fetchImpl });
        if (r.cached) alreadyHad++; else saved++;
      } catch {
        failed++;
      }
      onProgress?.({ done: ++done, of: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()));

  return {
    saved, alreadyHad, failed,
    requested: todo.length,
    // Said out loud. A truncated download that reports success is how someone
    // ends up in the woods with half a map.
    skipped: capped ? wanted.length - todo.length : 0,
    capped,
    refused,
  };
}

/** How much ground is actually saved, for a page that wants to say so. */
export async function cacheStats(out) {
  const root = tileDir(out);
  let tiles = 0, bytes = 0;
  const bySource = {};
  const walk = async (dir, key) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, key ?? e.name);
      else if (!e.name.endsWith('.part')) {
        const st = await fsp.stat(full);
        tiles++; bytes += st.size;
        if (key) {
          bySource[key] ??= { tiles: 0, bytes: 0 };
          bySource[key].tiles++; bySource[key].bytes += st.size;
        }
      }
    }
  };
  await walk(root, null);
  return { tiles, bytes, bySource };
}

/** Forget cached tiles — all of them, or one source's. */
export async function clearCache(out, key = null) {
  const target = key ? path.join(tileDir(out), key) : tileDir(out);
  if (key && !sourceByKey(key)) throw new Error(`unknown tile source "${key}"`);
  const before = await cacheStats(out);
  await fsp.rm(target, { recursive: true, force: true });
  const after = await cacheStats(out);
  return { removedTiles: before.tiles - after.tiles, removedBytes: before.bytes - after.bytes };
}

export const cacheExists = out => fs.existsSync(tileDir(out));
