#!/usr/bin/env node
/**
 * serve.mjs — the local web server.
 *
 *   node --disable-warning=ExperimentalWarning serve.mjs
 *   node serve.mjs --host 0.0.0.0        # reachable from a phone on your Wi-Fi
 *   node serve.mjs --port 8080 --open
 *
 * Why a server exists at all: a static HTML file cannot save anything. The
 * moment you want to click a photo and say "that is Split G2", the page needs
 * somewhere to write, and that is what this provides.
 *
 * Everything stays on this machine. Node's built-in http module, so still no
 * dependencies, and by default it binds to 127.0.0.1 — nothing outside this
 * computer can reach it until you explicitly ask for that with --host.
 *
 * The browser talks to a small JSON API rather than to a page with data baked
 * in. That boundary is deliberate: a phone app later can speak to exactly this
 * interface instead of forcing a rewrite.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  openDb, allCameras, counts, allStands, createStand, updateStand, deleteStand,
  STAND_TYPES, COMPASS, saveTerrainGrid, terrainGridCovering, terrainGridAt,
  allMarkers, createMarker, updateMarker, deleteMarker, MARKER_KINDS, MARKER_LABELS,
} from './db.mjs';
import { dashboardHtml, readPlan } from './spypoint-sync.mjs';
import { parcelAt } from './parcels.mjs';
import { terrainFeatures } from './terrain-features.mjs';
import { rankStands, summarise } from './stand-ranking.mjs';
import { sourceDescriptors } from './tile-sources.mjs';
import { getTile, prefetch, cacheStats, clearCache, PREFETCH_MAX_TILES } from './tile-cache.mjs';
import {
  fetchElevationGrid, contourLines, hillshade, gridStats, gridBounds,
  slopeAspect, metresToFeet, planGrid, slopeAspectAt,
} from './terrain.mjs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

export const OPT = {
  out: path.resolve(val('--out', process.env.SPYPOINT_OUT || './spypoint-data')),
  port: Number(val('--port', process.env.TRAILCAM_PORT || 8787)),
  // Loopback by default. --host 0.0.0.0 opens it to the local network so a
  // phone on the same Wi-Fi can reach it; that is a deliberate choice the user
  // makes, never the default, because it exposes camera locations to anything
  // else on that network.
  host: val('--host', '127.0.0.1'),
  open: has('--open'),
};

/**
 * SQLite gives snake_case columns; the dashboard renderer was written against
 * the provider's camelCase shape. Converting here keeps one renderer rather
 * than two, and keeps the SQL naming conventional.
 */
export function cameraFromRow(r) {
  return {
    id: r.id,
    provider: r.provider,
    accountLabel: r.account_label,
    property: r.property_name ?? null,
    name: r.name,
    model: r.model,
    lat: r.lat,
    lng: r.lng,
    gpsFix: r.gps_fix,
    battery: r.battery,
    batteryLevel: r.battery_level,
    batterySource: r.battery_source,
    signal: r.signal,
    signalBars: r.signal_bars,
    signalLevel: r.signal_level,
    signalType: r.signal_type,
    tempValue: r.temp_value,
    tempUnit: r.temp_unit,
    memUsed: r.mem_used,
    memSize: r.mem_size,
    plan: r.plan,
    photoCount: r.photo_count,
    photoLimit: r.photo_limit,
    lastSeen: r.last_seen,
  };
}

/**
 * Photos for the dashboard grid, newest first, with their confirmed and
 * unconfirmed species tags. group_concat is used rather than a second query
 * because the grid only needs a label, not the detection rows themselves.
 */
export function recentPhotos(db, limit = 200) {
  return db.prepare(`
    SELECT p.id, p.taken_at AS date, p.file_path AS file, p.url,
           c.name AS cameraName, c.id AS cameraId,
           (SELECT group_concat(DISTINCT d.species)
              FROM detections d WHERE d.photo_id = p.id) AS tagList
    FROM photos p
    JOIN cameras c ON c.id = p.camera_id
    WHERE p.taken_at IS NOT NULL
    ORDER BY p.taken_at DESC
    LIMIT ?
  `).all(limit).map(r => ({
    ...r,
    tags: r.tagList ? r.tagList.split(',').filter(Boolean) : [],
    // The page is served over http, so photos are addressed by URL rather than
    // by a filesystem path the browser could not read anyway.
    file: r.file ? `/photos/${encodeURI(r.file.split(path.sep).join('/'))}` : null,
  }));
}

export async function buildState(db, out) {
  const cameras = allCameras(db).map(cameraFromRow);
  const photos = recentPhotos(db);
  const plan = await readPlan(out);
  const stands = allStands(db);
  const markers = allMarkers(db);
  return { generatedAt: new Date().toISOString(), cameras, photos, stands, markers,
           plan, counts: counts(db) };
}

const send = (res, code, type, body) => {
  res.writeHead(code, {
    'content-type': type,
    // Nothing here should be cached: the whole point is that a tag saved a
    // second ago is visible on the next load.
    'cache-control': 'no-store',
  });
  res.end(body);
};

const sendJson = (res, code, obj) =>
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
};

/**
 * Serve a synced photo. The path comes from the URL, so it is untrusted: it is
 * resolved and then checked to be inside the photos directory. Without that,
 * a request for ../../../../etc/passwd would be honoured.
 */
async function servePhoto(res, out, rel) {
  const root = path.resolve(out, 'photos');
  const full = path.resolve(root, decodeURIComponent(rel));
  if (full !== root && !full.startsWith(root + path.sep)) {
    return send(res, 403, 'text/plain', 'outside the photo directory');
  }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    });
    res.end(data);
  } catch {
    send(res, 404, 'text/plain', 'no such photo');
  }
}



// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

// Fetches already running, keyed by the ground they cover. Two tabs opening the
// same map must not both spend 25 seconds asking a public service for identical
// data; the second waits on the first instead.
const terrainInFlight = new Map();

/**
 * Everything the map needs to draw the ground: a hillshade image, contour
 * lines, and the numbers behind them.
 *
 * The hillshade is computed here rather than in the browser so there is one
 * implementation of the terrain maths, and it ships as base64 grey bytes —
 * about 5 KB for a 61x61 grid, against 40 KB for the same thing as JSON
 * numbers.
 */
export async function terrainFor(db, { lat, lng, radiusM = 300, spacingM = 10 }) {
  // spacingM is reassigned below when the area is too large to sample finely.
  const dLat = radiusM / 110540;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const bounds = { west: lng - dLng, south: lat - dLat, east: lng + dLng, north: lat + dLat };

  // Coarsen rather than refuse.
  //
  // The route clamps radius and spacing separately, and the two clamps used to
  // combine into a request that could never succeed: the largest allowed area
  // at the finest allowed spacing is 361,201 samples, over the fetcher's own
  // 250,000 guard, so asking for the maximum always failed. Area is what the
  // caller actually cares about, so the area is honoured and the detail gives
  // way — which is also the right trade when someone zooms out: they want to
  // see the shape of a whole property, not every square metre of it.
  const MAX_SAMPLES = 200_000;
  let planned = planGrid(bounds, spacingM);
  if (planned.cols * planned.rows > MAX_SAMPLES) {
    const factor = Math.sqrt(planned.cols * planned.rows / MAX_SAMPLES);
    spacingM = Math.ceil(spacingM * factor);
    planned = planGrid(bounds, spacingM);
  }

  let grid = terrainGridCovering(db, bounds, spacingM);
  let cached = !!grid;
  if (!grid) {
    const key = [bounds.west, bounds.south, bounds.east, bounds.north, spacingM]
      .map(n => n.toFixed(6)).join(',');
    if (!terrainInFlight.has(key)) {
      terrainInFlight.set(key, (async () => {
        const fetched = await fetchElevationGrid(bounds, { spacingM });
        saveTerrainGrid(db, fetched);
        return fetched;
      })().finally(() => terrainInFlight.delete(key)));
    }
    grid = await terrainInFlight.get(key);
  }

  const stats = gridStats(grid);
  if (!stats.count) {
    // Real answer, not a failure: outside LiDAR coverage there is no terrain to
    // draw, and saying so beats drawing an empty grey square.
    return { covered: false, cached, bounds: gridBounds(grid), stats: null };
  }

  const hs = hillshade(grid);
  const features = terrainFeatures(grid);
  const { slope } = slopeAspect(grid);
  const slopes = [...slope].filter(Number.isFinite).sort((a, b) => a - b);
  const contours = contourLines(grid);

  return {
    covered: true,
    cached,
    bounds: gridBounds(grid),
    grid: { cols: grid.cols, rows: grid.rows, spacingM: grid.spacingM },
    stats: {
      minFt: Math.round(metresToFeet(stats.min) * 10) / 10,
      maxFt: Math.round(metresToFeet(stats.max) * 10) / 10,
      reliefFt: Math.round(metresToFeet(stats.relief) * 10) / 10,
      medianSlopeDeg: slopes.length ? Math.round(slopes[Math.floor(slopes.length / 2)] * 10) / 10 : null,
      maxSlopeDeg: slopes.length ? Math.round(slopes.at(-1) * 10) / 10 : null,
    },
    hillshade: {
      // Row 0 of the grid is the SOUTH edge, but an image's first row is its
      // TOP. The flip happens here, once, so the browser can blit the bytes
      // straight into an ImageData without knowing about the convention.
      shade: Buffer.from(flipRows(hs.shade, hs.cols, hs.rows)).toString('base64'),
      alpha: Buffer.from(flipRows(hs.alpha, hs.cols, hs.rows)).toString('base64'),
      cols: hs.cols, rows: hs.rows,
      // Reported, not hidden: this hillshade is vertically exaggerated, and a
      // reader who does not know by how much will misjudge the ground badly.
      zFactor: Math.round(hs.zFactor * 10) / 10,
    },
    contours,
    features: {
      // Lines carry only their geometry to the browser; the cell indices they
      // were traced through are an implementation detail of the detector.
      drainages: features.drainages.map(d => ({ path: d.path, dropFt: d.dropFt, drains: d.drains })),
      ridges: features.ridges.map(d => ({ path: d.path, dropFt: d.dropFt })),
      saddles: features.saddles,
      benches: features.benches,
      // Passed through so the page can say WHY it found no benches or saddles.
      // An empty list with no explanation reads as a broken detector.
      quiet: features.quiet,
      medianSlopeDeg: features.medianSlopeDeg,
    },
  };
}

function flipRows(arr, cols, rows) {
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    out.set(arr.subarray(r * cols, (r + 1) * cols), (rows - 1 - r) * cols);
  }
  return out;
}


/**
 * Look up the ground under a stand, using whatever terrain has already been
 * cached. Deliberately does NOT fetch: ranking stands must stay instant, and a
 * ranking that silently spends 25 seconds on a network call the first time it
 * is asked would be worse than one that says thermals are unavailable until
 * you press Terrain.
 *
 * slopeAspect over a whole grid is the expensive part, so it is computed once
 * per grid rather than once per stand.
 */
function standTerrainLookup(db) {
  const cache = new Map();
  return stand => {
    const grid = terrainGridAt(db, stand.lat, stand.lng);
    if (!grid) return null;
    if (!cache.has(grid.id)) cache.set(grid.id, slopeAspect(grid));
    return slopeAspectAt(grid, stand.lat, stand.lng, cache.get(grid.id));
  };
}

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('body was not valid JSON')); }
    });
    req.on('error', reject);
  });
}

export function createServer({ out = OPT.out } = {}) {
  let db;
  try {
    db = openDb(out);
  } catch (err) {
    throw new Error(`could not open the database at ${out}: ${err.message}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const s = await buildState(db, out);
        return send(res, 200, 'text/html; charset=utf-8',
          dashboardHtml(s.cameras, s.photos, s.generatedAt, s.plan, s.stands, true, s.markers,
                        sourceDescriptors({ proxied: true })));
      }
      // The API boundary a phone app would later speak to.
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, await buildState(db, out));
      }
      if (req.method === 'GET' && url.pathname === '/api/cameras') {
        return sendJson(res, 200, allCameras(db).map(cameraFromRow));
      }
      if (req.method === 'GET' && url.pathname === '/api/photos') {
        const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 200);
        return sendJson(res, 200, recentPhotos(db, limit));
      }
      // --- stands -------------------------------------------------------
      if (url.pathname === '/api/stands') {
        if (req.method === 'GET') return sendJson(res, 200, allStands(db));
        if (req.method === 'POST') {
          const b = await readJson(req);
          try {
            return sendJson(res, 201, createStand(db, {
              name: b.name, type: b.type, lat: Number(b.lat), lng: Number(b.lng),
              propertyId: b.propertyId ?? null, goodWinds: b.goodWinds ?? null,
              notes: b.notes ?? null,
            }));
          } catch (err) {
            // A bad stand is the caller's mistake, not a server fault, and the
            // message says which field to fix.
            return sendJson(res, 400, { error: err.message });
          }
        }
      }
      const standMatch = url.pathname.match(/^\/api\/stands\/(\d+)$/);
      if (standMatch) {
        const id = Number(standMatch[1]);
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const b = await readJson(req);
          try {
            const patch = {};
            for (const k of ['name', 'type', 'notes', 'goodWinds', 'propertyId']) {
              if (b[k] !== undefined) patch[k] = b[k];
            }
            if (b.lat !== undefined) patch.lat = Number(b.lat);
            if (b.lng !== undefined) patch.lng = Number(b.lng);
            return sendJson(res, 200, updateStand(db, id, patch));
          } catch (err) {
            const missing = /no stand with id/.test(err.message);
            return sendJson(res, missing ? 404 : 400, { error: err.message });
          }
        }
        if (req.method === 'DELETE') {
          return deleteStand(db, id)
            ? sendJson(res, 200, { deleted: id })
            : sendJson(res, 404, { error: `no stand with id ${id}` });
        }
      }

      // --- scouting markers ---------------------------------------------
      // Sign found on the ground. Same shape as stands deliberately: one CRUD
      // pattern for everything the map lets you place.
      if (url.pathname === '/api/markers') {
        if (req.method === 'GET') return sendJson(res, 200, allMarkers(db));
        if (req.method === 'POST') {
          const b = await readJson(req);
          try {
            return sendJson(res, 201, createMarker(db, {
              kind: b.kind, name: b.name ?? null,
              lat: b.lat === undefined || b.lat === null || b.lat === '' ? null : Number(b.lat),
              lng: b.lng === undefined || b.lng === null || b.lng === '' ? null : Number(b.lng),
              foundAt: b.foundAt ?? null, notes: b.notes ?? null,
              propertyId: b.propertyId ?? null,
            }));
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }
      }
      const markerMatch = url.pathname.match(/^\/api\/markers\/(\d+)$/);
      if (markerMatch) {
        const id = Number(markerMatch[1]);
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const b = await readJson(req);
          try {
            const patch = {};
            for (const k of ['kind', 'name', 'notes', 'foundAt', 'propertyId']) {
              if (b[k] !== undefined) patch[k] = b[k];
            }
            if (b.lat !== undefined) patch.lat = Number(b.lat);
            if (b.lng !== undefined) patch.lng = Number(b.lng);
            return sendJson(res, 200, updateMarker(db, id, patch));
          } catch (err) {
            const missing = /no marker with id/.test(err.message);
            return sendJson(res, missing ? 404 : 400, { error: err.message });
          }
        }
        if (req.method === 'DELETE') {
          return deleteMarker(db, id)
            ? sendJson(res, 200, { deleted: id })
            : sendJson(res, 404, { error: `no marker with id ${id}` });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/marker-kinds') {
        return sendJson(res, 200, { kinds: MARKER_KINDS, labels: MARKER_LABELS });
      }
      if (req.method === 'GET' && url.pathname === '/api/stand-types') {
        return sendJson(res, 200, { types: STAND_TYPES, winds: COMPASS });
      }




      // --- map tiles ----------------------------------------------------
      // Every tile the page draws comes through here, so a copy lands on disk
      // on the way past and the same ground works later with no signal.
      const tileMatch = url.pathname.match(/^\/tiles\/([a-z-]+)\/(\d+)\/(\d+)\/(\d+)$/);
      if (req.method === 'GET' && tileMatch) {
        const [, key, z, x, y] = tileMatch;
        try {
          const tile = await getTile(out, key, Number(z), Number(x), Number(y));
          res.writeHead(200, {
            'content-type': tile.contentType,
            // Tiles are the one thing here worth caching in the browser too:
            // they are immutable in practice and this is the offline path.
            'cache-control': 'public, max-age=604800',
            'x-tile-cache': tile.stale ? 'stale' : tile.cached ? 'hit' : 'miss',
          });
          return res.end(tile.body);
        } catch (err) {
          const bad = /unknown tile source|out of range/.test(err.message);
          return sendJson(res, bad ? 400 : 502, { error: err.message });
        }
      }

      // Save the current view for offline use. Bounded deliberately — see
      // tile-cache.mjs on why bulk downloading is not simply allowed.
      if (req.method === 'POST' && url.pathname === '/api/tiles/save') {
        const b = await readJson(req);
        const bounds = b.bounds ?? {};
        const ok = ['west', 'south', 'east', 'north'].every(k => Number.isFinite(Number(bounds[k])));
        if (!ok) return sendJson(res, 400, { error: 'bounds (west, south, east, north) are required' });
        const zooms = Array.isArray(b.zooms) && b.zooms.length
          ? b.zooms.map(Number).filter(z => Number.isInteger(z) && z >= 0 && z <= 22).slice(0, 6)
          : [];
        if (!zooms.length) return sendJson(res, 400, { error: 'at least one zoom level is required' });
        const sources = Array.isArray(b.sources) && b.sources.length ? b.sources : ['satellite'];
        try {
          const result = await prefetch(out, {
            bounds: {
              west: Number(bounds.west), south: Number(bounds.south),
              east: Number(bounds.east), north: Number(bounds.north),
            },
            zooms, sources,
          });
          return sendJson(res, 200, { ...result, max: PREFETCH_MAX_TILES });
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/tiles/stats') {
        return sendJson(res, 200, await cacheStats(out));
      }
      if (req.method === 'DELETE' && url.pathname === '/api/tiles') {
        try {
          return sendJson(res, 200, await clearCache(out, url.searchParams.get('source')));
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      // Which stand, for a given sit. The planner says WHEN; this says WHERE.
      if (req.method === 'GET' && url.pathname === '/api/stand-plan') {
        const plan = await readPlan(out);
        const stands = allStands(db);
        const terrainAt = standTerrainLookup(db);
        const hasTerrain = stands.some(st => terrainAt(st) !== null);
        const howMany = Math.min(10, Math.max(1, Number(url.searchParams.get('sits')) || 3));
        const sits = (plan?.sits ?? []).slice(0, howMany).map(sit => {
          const ranked = rankStands({ stands, sit, terrainAt });
          return {
            date: sit.date, window: sit.window, rating: sit.rating,
            score: sit.total, windFrom: sit.windFrom, rut: sit.rut,
            stands: ranked,
            summary: summarise(ranked, { hasTerrain }),
          };
        });
        return sendJson(res, 200, {
          sits,
          hasTerrain,
          // Said out loud so an empty or flat ranking is explicable rather than
          // just disappointing.
          note: !stands.length ? 'No stands yet — drop a pin on the map.'
            : !plan ? 'No plan yet — run the sync to fetch a forecast.'
            : hasTerrain ? null
            : 'Thermals are not included: press Terrain on the map to load elevation first.',
        });
      }
      // The shape of the ground, from free USGS LiDAR.
      //
      // Fetching is slow — about 25 seconds for a 600 m square, across five
      // requests — so it happens once and is cached in the database forever
      // after. The ground does not move. In-flight requests are also shared:
      // two browser tabs asking for the same ground must not start two fetches.
      if (req.method === 'GET' && url.pathname === '/api/terrain') {
        const raw = { lat: url.searchParams.get('lat'), lng: url.searchParams.get('lng') };
        if (!raw.lat || !raw.lng) {
          return sendJson(res, 400, { error: 'lat and lng are required' });
        }
        const lat = Number(raw.lat), lng = Number(raw.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)
          || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return sendJson(res, 400, { error: 'lat and lng must be real coordinates' });
        }
        // Bounded hard: the radius decides how many samples get requested from
        // a public service, so it is not left to whatever the caller types.
        const radiusM = Math.min(1500, Math.max(100, Number(url.searchParams.get('radius')) || 300));
        const spacingM = Math.min(50, Math.max(5, Number(url.searchParams.get('spacing')) || 10));
        try {
          const terrain = await terrainFor(db, { lat, lng, radiusM, spacingM });
          return sendJson(res, 200, terrain);
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }
      // Who owns this ground. Proxied through the server rather than called
      // from the browser so the public service sees one client, the result can
      // be cached in one place, and a future non-Wisconsin source is a change
      // here rather than in the page.
      if (req.method === 'GET' && url.pathname === '/api/parcel') {
        // Number(null) is 0, so a MISSING parameter would otherwise become a
        // valid-looking query against 0,0 in the Atlantic and answer "no parcel
        // here" instead of "you gave me no coordinates".
        const raw = { lat: url.searchParams.get('lat'), lng: url.searchParams.get('lng') };
        if (raw.lat === null || raw.lng === null || raw.lat === '' || raw.lng === '') {
          return sendJson(res, 400, { error: 'lat and lng are required' });
        }
        const lat = Number(raw.lat);
        const lng = Number(raw.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)
          || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return sendJson(res, 400, { error: 'lat and lng must be real coordinates' });
        }
        try {
          const parcel = await parcelAt(lat, lng);
          // No parcel is a real answer (outside Wisconsin, or on water), and
          // must not read as a failed lookup.
          return sendJson(res, 200, { parcel, found: parcel !== null });
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, out, ...counts(db) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
        return servePhoto(res, out, url.pathname.slice('/photos/'.length));
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      // A malformed or oversized body is the caller's mistake, not a server
      // fault, and deserves a 4xx that says which. Anything else is ours.
      const clientFault = /valid JSON|body too large/.test(err.message);
      if (clientFault) return sendJson(res, 400, { error: err.message });
      // A broken request must not take the server down mid-session.
      send(res, 500, 'text/plain', `error: ${err.message}`);
    }
  });

  server.on('close', () => { try { db.close(); } catch { /* already closed */ } });
  return server;
}

async function main() {
  if (!fs.existsSync(path.join(OPT.out, 'trailcam.db'))) {
    console.error(`\nNo database at ${path.join(OPT.out, 'trailcam.db')}.`);
    console.error('Run a sync first:  node spypoint-sync.mjs\n');
    process.exitCode = 1;
    return;
  }

  const server = createServer();
  await new Promise(r => server.listen(OPT.port, OPT.host, r));
  const shown = OPT.host === '0.0.0.0' ? localAddress() : OPT.host;

  console.log(`\n  TrailCam is running.\n`);
  console.log(`    On this computer:  http://127.0.0.1:${OPT.port}`);
  if (OPT.host === '0.0.0.0') {
    console.log(`    On your phone:     http://${shown}:${OPT.port}   (same Wi-Fi)`);
  } else {
    console.log(`    For your phone:    restart with  --host 0.0.0.0`);
  }
  console.log(`\n  Leave this window open. Ctrl+C to stop.\n`);

  if (OPT.open) {
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const { spawn } = await import('node:child_process');
    spawn(cmd, [`http://127.0.0.1:${OPT.port}`], { shell: true, stdio: 'ignore', detached: true }).unref();
  }
}

/** Best-effort LAN address, so the phone instruction shows something usable. */
function localAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'your-computer';
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch(err => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  });
}
