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
  groupVisits, allVisits, visitById, photosForVisit, reviewVisit,
  detectionsForVisit, addDetection, updateDetection, deleteDetection,
  allBucks, upsertBuck, recentDetectionCounts, SPECIES, DEER_CLASS,
  saveWindClimatology, windClimatology,
  allRoutes, routesForStand, createRoute, updateRoute, deleteRoute, routeById,
  logSit, updateSit, deleteSit, allSits, sitById, SIT_WINDOWS,
} from './db.mjs';
import { dashboardHtml } from './dashboard-page.mjs';
import { readPlan } from './spypoint-sync.mjs';
import { parcelAt } from './parcels.mjs';
import { terrainFeatures } from './terrain-features.mjs';
import { rankStands, summarise } from './stand-ranking.mjs';
import { suggestStands, onYourGround } from './stand-suggester.mjs';
import { calibration, windAccuracy, standPerformance, summary as sitSummary } from './sit-journal.mjs';
import { nextSits, resolveSit, whenLabel, departure } from './tonight.mjs';
import { WISCONSIN_DEER } from './legal-light.mjs';
import { sourceDescriptors } from './tile-sources.mjs';
import { reviewHtml } from './review-page.mjs';
import { tonightHtml } from './tonight-page.mjs';
import { journalHtml } from './journal-page.mjs';
import { swSource, manifest, iconSvg } from './offline.mjs';
import {
  fetchArchive, climatology, standCoverage, SEASON_MONTHS,
} from './wind-history.mjs';
import { assessRoute, routeWinds, routeLength } from './routes.mjs';
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
/**
 * A photo row as the browser needs it: addressed by URL rather than by a
 * filesystem path it could not read, and falling back to the camera's own URL
 * when the file has not been downloaded yet — which is the normal state for a
 * photo the sync has listed but not yet fetched.
 */
export function photoForClient(p) {
  return {
    id: p.id,
    takenAt: p.taken_at,
    file: p.file_path
      ? `/photos/${encodeURI(p.file_path.split(path.sep).join('/'))}` : null,
    url: p.url ?? null,
    downloaded: !!p.downloaded_at,
  };
}

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

  // 3DEP is a United States programme. Asked about anywhere else the service
  // answers "Invalid or missing input parameters", which surfaces to a person
  // as an inexplicable failure rather than as "there is no data there". Worth
  // catching before the request: the map centres on 0,0 when no camera has a
  // GPS fix, which lands in the Gulf of Guinea.
  const IN_COVERAGE = (la, ln) =>
    (la >= 24 && la <= 50 && ln >= -125 && ln <= -66)      // lower 48
    || (la >= 51 && la <= 72 && ln >= -170 && ln <= -129)  // Alaska
    || (la >= 18 && la <= 23 && ln >= -161 && ln <= -154); // Hawaii
  if (!IN_COVERAGE(lat, lng)) {
    return {
      covered: false, cached: false, bounds, stats: null,
      why: lat === 0 && lng === 0
        ? 'The map has no location yet — none of your cameras reported GPS '
          + 'coordinates, so there is nowhere to read the ground.'
        : 'USGS 3DEP covers the United States. There is no elevation data at '
          + `${lat.toFixed(4)}, ${lng.toFixed(4)}.`,
    };
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
    return {
      covered: false, cached, bounds: gridBounds(grid), stats: null,
      why: 'No LiDAR coverage on this ground. That is a real answer rather than '
        + 'a fault — 3DEP does not cover every square metre.',
    };
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


/**
 * Rank every stand for a list of sits, with the best walk in to each.
 *
 * Shared by /api/stand-plan (the next several sits, on the dashboard) and
 * /api/tonight (the one sit you are about to hunt). Two copies of this would
 * drift, and the two screens disagreeing about which stand to sit is exactly
 * the failure that would destroy trust in both of them.
 */
function rankSits(db, sits) {
  // Confirmed detections per camera, attached to the stands each camera
  // covers. This is the number the ranking has been scoring as zero because no
  // photos existed; it starts counting the moment they do.
  const recent = recentDetectionCounts(db);
  const stands = allStands(db).map(st => ({
    ...st,
    nearbyCameras: (st.nearbyCameras ?? []).map(c => ({
      ...c, recentDetections: recent[c.id] ?? 0,
    })),
  }));
  const terrainAt = standTerrainLookup(db);
  const hasTerrain = stands.some(st => terrainAt(st) !== null);

  const ranked = sits.map(sit => {
    const withWalk = rankStands({ stands, sit, terrainAt }).map(r => {
      const routes = routesForStand(db, r.id);
      if (!routes.length) return r;
      const stand = stands.find(s => s.id === r.id);
      // The best of the available walks: having one clean route is what
      // matters, not whether every route is clean.
      const verdicts = routes.map(rt => ({
        id: rt.id, name: rt.name,
        ...assessRoute(rt, {
          stand,
          others: stands.filter(s => s.id !== r.id),
          windFromDeg: sit.windDir,
        }),
      }));
      const best = verdicts.find(v => v.ok === true) ?? verdicts[0];
      return { ...r, routes: verdicts, walk: best };
    });
    return {
      sit,
      stands: withWalk,
      summary: summarise(withWalk, { hasTerrain }),
    };
  });

  return { ranked, stands, hasTerrain };
}


// In-flight climatology fetches, shared the same way terrain's are: seven years
// of hourly archive is a slow pull and two tabs must not both make it.
const windInFlight = new Map();

/**
 * How often each wind blows here during season, and what that is worth to each
 * stand.
 *
 * Cached permanently once fetched, because history does not change.
 */
export async function windHistoryFor(db, { lat, lng, years = 7, months = SEASON_MONTHS }) {
  let clim = windClimatology(db, lat, lng, months, years);
  if (!clim) {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${months.join('')},${years}`;
    if (!windInFlight.has(key)) {
      windInFlight.set(key, (async () => {
        const archives = await fetchArchive(lat, lng, { years, months });
        const computed = climatology(archives, { months });
        if (!computed.hours) {
          throw new Error('the weather archive returned no usable hours for this place');
        }
        saveWindClimatology(db, lat, lng, months, years, computed);
        return { ...computed, cached: false };
      })().finally(() => windInFlight.delete(key)));
    }
    clim = await windInFlight.get(key);
  }
  return { ...clim, coverage: standCoverage(allStands(db), clim) };
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
      // The review screen. A separate page from the dashboard on purpose: this
      // is a task you sit down to do, not something to glance at beside a map.
      if (req.method === 'GET' && (url.pathname === '/review' || url.pathname === '/review/')) {
        return send(res, 200, 'text/html; charset=utf-8', reviewHtml({
          species: SPECIES, deerClasses: DEER_CLASS,
          bucks: allBucks(db),
          remaining: allVisits(db, { unreviewed: true, limit: 100000 }).length,
        }));
      }

      // Offline plumbing: the worker, the manifest and the icon. Tiny, static,
      // and cache-forever would be wrong for the worker — the browser decides
      // when to re-check it, and telling it never to would strand old code on
      // the phone.
      if (req.method === 'GET' && url.pathname === '/sw.js') {
        return send(res, 200, 'application/javascript; charset=utf-8', swSource());
      }
      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        return send(res, 200, 'application/manifest+json', manifest());
      }
      if (req.method === 'GET' && url.pathname === '/icon.svg') {
        return send(res, 200, 'image/svg+xml', iconSvg());
      }

      // The season, and what it is entitled to claim from it.
      if (req.method === 'GET' && (url.pathname === '/journal' || url.pathname === '/journal/')) {
        return send(res, 200, 'text/html; charset=utf-8', journalHtml());
      }

      // Tonight. One screen, one question, read on a phone in the kitchen.
      if (req.method === 'GET' && (url.pathname === '/tonight' || url.pathname === '/tonight/')) {
        return send(res, 200, 'text/html; charset=utf-8', tonightHtml());
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



      // Which winds actually blow here during season, and what that is worth to
      // each stand. Answers "which stands earn their keep", which is a
      // different question from "can I sit there this evening".
      if (req.method === 'GET' && url.pathname === '/api/wind-history') {
        const cams = allCameras(db).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
        const stands = allStands(db);
        // Defaults to the middle of your own ground rather than making the page
        // supply coordinates it would have to invent.
        const spots = [...cams, ...stands];
        const lat = Number(url.searchParams.get('lat'))
          || (spots.length ? spots.reduce((a, c) => a + c.lat, 0) / spots.length : NaN);
        const lng = Number(url.searchParams.get('lng'))
          || (spots.length ? spots.reduce((a, c) => a + c.lng, 0) / spots.length : NaN);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return sendJson(res, 400, {
            error: 'no location yet — none of your cameras or stands has coordinates',
          });
        }
        const years = Math.min(15, Math.max(1, Number(url.searchParams.get('years')) || 7));
        try {
          return sendJson(res, 200, await windHistoryFor(db, { lat, lng, years }));
        } catch (err) {
          console.error(`\n  Wind history failed at ${lat},${lng}: ${err.message}\n`);
          return sendJson(res, 502, { error: err.message });
        }
      }
      // --- review: visits, detections, bucks ------------------------------
      //
      // A VISIT is the unit you tag, not a photo. These cameras fire two frames
      // per trigger and a deer working through sets off several triggers, so
      // tagging per photo would mean labelling the same animal six times.
      if (req.method === 'GET' && url.pathname === '/api/visits') {
        const unreviewed = url.searchParams.get('unreviewed') === '1';
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const cameraId = url.searchParams.get('camera') || null;
        const visits = allVisits(db, { unreviewed, limit, cameraId }).map(v => ({
          ...v,
          photos: photosForVisit(db, v.id).map(photoForClient),
          detections: detectionsForVisit(db, v.id),
        }));
        return sendJson(res, 200, {
          visits,
          // Counted separately from the page, so the queue can say how much is
          // left rather than how much it happened to fetch.
          remaining: allVisits(db, { unreviewed: true, limit: 100000 }).length,
          species: SPECIES, deerClasses: DEER_CLASS,
        });
      }

      const visitMatch = url.pathname.match(/^\/api\/visits\/(\d+)$/);
      if (visitMatch && req.method === 'GET') {
        const v = visitById(db, Number(visitMatch[1]));
        if (!v) return sendJson(res, 404, { error: `no visit with id ${visitMatch[1]}` });
        return sendJson(res, 200, {
          ...v,
          photos: photosForVisit(db, v.id).map(photoForClient),
          detections: detectionsForVisit(db, v.id),
        });
      }

      const reviewMatch = url.pathname.match(/^\/api\/visits\/(\d+)\/review$/);
      if (reviewMatch && req.method === 'POST') {
        const b = await readJson(req);
        try {
          return sendJson(res, 200, reviewVisit(db, Number(reviewMatch[1]), {
            reviewed: b.reviewed !== false, notes: b.notes,
          }));
        } catch (err) {
          return sendJson(res, /no visit/.test(err.message) ? 404 : 400, { error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/regroup') {
        const b = await readJson(req);
        const gap = Number(b.gapSeconds);
        return sendJson(res, 200, groupVisits(db,
          Number.isFinite(gap) && gap > 0 ? { gapSeconds: gap } : {}));
      }

      if (url.pathname === '/api/detections') {
        if (req.method === 'POST') {
          const b = await readJson(req);
          try {
            if (!b.photoId) throw new Error('a detection needs a photo');
            const made = addDetection(db, {
              photoId: b.photoId, species: b.species ?? null,
              count: Number(b.count) || 1, buckId: b.buckId ?? null,
              // Anything created here came from a person looking at the frame.
              source: 'manual', confirmed: b.confirmed !== false, notes: b.notes ?? null,
            });
            // Validated through the same path an edit takes, so the rules
            // cannot differ between creating and changing a detection.
            return sendJson(res, 201, updateDetection(db, made.id, {}));
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }
      }
      const detMatch = url.pathname.match(/^\/api\/detections\/(\d+)$/);
      if (detMatch) {
        const id = Number(detMatch[1]);
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const b = await readJson(req);
          try {
            const patch = {};
            for (const k of ['species', 'count', 'buckId', 'confirmed', 'notes']) {
              if (b[k] !== undefined) patch[k] = b[k];
            }
            return sendJson(res, 200, updateDetection(db, id, patch));
          } catch (err) {
            return sendJson(res, /no detection/.test(err.message) ? 404 : 400, { error: err.message });
          }
        }
        if (req.method === 'DELETE') {
          return deleteDetection(db, id)
            ? sendJson(res, 200, { deleted: id })
            : sendJson(res, 404, { error: `no detection with id ${id}` });
        }
      }

      if (url.pathname === '/api/bucks') {
        if (req.method === 'GET') return sendJson(res, 200, allBucks(db));
        if (req.method === 'POST') {
          const b = await readJson(req);
          const name = (b.name ?? '').trim();
          if (!name) return sendJson(res, 400, { error: 'a buck needs a name' });
          try {
            return sendJson(res, 201, upsertBuck(db, name, b.notes ?? null));
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }
      }

      // --- entry and exit routes ------------------------------------------
      // How you get to a stand. Judged the same way the stand is: against the
      // wind, because walking to a good stand across the ground you are about
      // to hunt is how a good stand gets wasted.
      if (url.pathname === '/api/routes') {
        if (req.method === 'GET') {
          const stands = allStands(db);
          return sendJson(res, 200, allRoutes(db).map(r => {
            const stand = stands.find(x => x.id === r.stand_id) ?? null;
            return {
              ...r,
              lengthM: routeLength(r.points),
              // Which winds this walk is clean on, worked out when the route is
              // CUT rather than only on the morning you use it — which is when
              // you can still move it.
              winds: stand ? routeWinds(r.points, stand) : null,
            };
          }));
        }
        if (req.method === 'POST') {
          const b = await readJson(req);
          try {
            return sendJson(res, 201, createRoute(db, {
              standId: b.standId ?? null, name: b.name ?? null,
              points: b.points, notes: b.notes ?? null,
            }));
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }
      }
      const routeMatch = url.pathname.match(/^\/api\/routes\/(\d+)$/);
      if (routeMatch) {
        const id = Number(routeMatch[1]);
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const b = await readJson(req);
          try {
            const patch = {};
            for (const k of ['standId', 'name', 'points', 'notes']) {
              if (b[k] !== undefined) patch[k] = b[k];
            }
            return sendJson(res, 200, updateRoute(db, id, patch));
          } catch (err) {
            return sendJson(res, /no route with id/.test(err.message) ? 404 : 400,
              { error: err.message });
          }
        }
        if (req.method === 'DELETE') {
          return deleteRoute(db, id)
            ? sendJson(res, 200, { deleted: id })
            : sendJson(res, 404, { error: `no route with id ${id}` });
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
        const howMany = Math.min(10, Math.max(1, Number(url.searchParams.get('sits')) || 3));
        const { ranked, stands, hasTerrain } = rankSits(db, (plan?.sits ?? []).slice(0, howMany));
        return sendJson(res, 200, {
          sits: ranked.map(({ sit, stands: rows, summary }) => ({
            date: sit.date, window: sit.window, rating: sit.rating,
            score: sit.total, windFrom: sit.windFrom, rut: sit.rut,
            stands: rows, summary,
          })),
          hasTerrain,
          // Said out loud so an empty or flat ranking is explicable rather than
          // just disappointing.
          note: !stands.length ? 'No stands yet — drop a pin on the map.'
            : !plan ? 'No plan yet — run the sync to fetch a forecast.'
            : hasTerrain ? null
            : 'Thermals are not included: press Terrain on the map to load elevation first.',
        });
      }

      // Tonight. The one screen you read with your boots in your hand.
      //
      // Everything here already existed and was spread across three places:
      // the planner knew when, the stand ranking knew where, the routes knew
      // which way in. What was missing was the assembly, and the clock — the
      // dashboard shows the BEST sits, and the best sit is regularly not the
      // next one.
      if (req.method === 'GET' && url.pathname === '/api/tonight') {
        const plan = await readPlan(out);
        const now = Number(url.searchParams.get('now')) || Date.now();
        const { sits: upcoming, stale, lastEnded } = nextSits(plan?.sits ?? [], { now, count: 2 });
        const { ranked, stands, hasTerrain } = rankSits(db, upcoming);

        const sits = ranked.map(({ sit, stands: rows, summary }) => {
          const pick = rows.find(r => r.huntable === true) ?? rows[0] ?? null;
          const walk = pick?.walk ?? null;
          return {
            date: sit.date, window: sit.window, rating: sit.rating, score: sit.total,
            windFrom: sit.windFrom, windDir: sit.windDir, windSpeed: sit.wind,
            temp: sit.temp, rain: sit.rain, rut: sit.rut, moon: sit.moon,
            when: whenLabel(sit, now),
            hours: sit.hours, light: sit.light,
            timezone: sit.timezone ?? null,
            depart: departure(sit, walk),
            pick, walk, stands: rows, summary,
          };
        });

        // The best sit still ahead, which is regularly not the next one. Kent
        // deciding to skip a fair evening and save the stand for Saturday is a
        // better outcome than being sent out on it, so the comparison is on
        // the page rather than left to him to go and look up.
        const ahead = (plan?.sits ?? [])
          .map(s => resolveSit(s, { now }))
          .filter(s => s && s.endsAt > now);
        const best = ahead.length
          ? ahead.reduce((a, b) => (b.total > a.total ? b : a))
          : null;

        return sendJson(res, 200, {
          now, sits, hasTerrain,
          best: best && sits[0] && best.date + best.window !== sits[0].date + sits[0].window
            ? {
                date: best.date, window: best.window, rating: best.rating,
                score: best.total, windFrom: best.windFrom,
                when: whenLabel(best, now),
                // The margin, so the page can stay quiet about a point or two.
                betterBy: Math.round(best.total - (sits[0].score ?? 0)),
              }
            : null,
          shootingHours: WISCONSIN_DEER,
          // Every reason there might be nothing to show, told apart. "No plan"
          // and "a plan from last week" need different actions from Kent.
          note: !plan ? 'No forecast yet — run the planner to fetch one.'
            : stale ? `Every sit in the plan has already passed${
                lastEnded ? ` (the last ended ${new Date(lastEnded).toISOString().slice(0, 10)})` : ''
              } — run the planner again.`
            : !stands.length ? 'No stands yet — drop a pin on the map to add one.'
            : null,
        });
      }

      // The sit journal: what actually happened when you sat there.
      //
      // The table that makes every other prediction in this program
      // falsifiable. Reads are cheap and the analysis is pure, so it is all
      // computed per request rather than cached.
      if (url.pathname === '/api/sits') {
        if (req.method === 'GET') {
          const standId = url.searchParams.get('stand');
          const sits = allSits(db, {
            limit: Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 500)),
            standId: standId === null || standId === '' ? null : Number(standId),
          });
          return sendJson(res, 200, {
            sits,
            summary: sitSummary(sits),
            calibration: calibration(sits),
            wind: windAccuracy(sits),
            stands: standPerformance(sits),
            windows: SIT_WINDOWS,
          });
        }
        if (req.method === 'POST') {
          let body;
          try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }
          try {
            return sendJson(res, 201, logSit(db, body));
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }
        return sendJson(res, 405, { error: 'GET or POST' });
      }
      const sitMatch = url.pathname.match(/^\/api\/sits\/(\d+)$/);
      if (sitMatch) {
        const id = Number(sitMatch[1]);
        if (req.method === 'GET') {
          const row = sitById(db, id);
          return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: 'no such sit' });
        }
        if (req.method === 'PATCH') {
          let body;
          try { body = await readJson(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }
          try {
            return sendJson(res, 200, updateSit(db, id, body));
          } catch (err) {
            return sendJson(res, /no sit with id/.test(err.message) ? 404 : 400, { error: err.message });
          }
        }
        if (req.method === 'DELETE') {
          return deleteSit(db, id)
            ? sendJson(res, 200, { deleted: id })
            : sendJson(res, 404, { error: 'no such sit' });
        }
        return sendJson(res, 405, { error: 'GET, PATCH or DELETE' });
      }

      // Where to hang the next stand.
      //
      // Everything this needs was already being computed separately: the
      // landforms from the terrain module, the winds no stand covers from the
      // wind history, and the sign from the markers. The work is putting them
      // together, and the answer is a shortlist to go and walk rather than a
      // decision — which every response says out loud.
      if (req.method === 'GET' && url.pathname === '/api/suggest-stands') {
        const stands = allStands(db);
        const cams = allCameras(db).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
        const spots = [...cams, ...stands];
        const lat = Number(url.searchParams.get('lat'))
          || (spots.length ? spots.reduce((a, c) => a + c.lat, 0) / spots.length : NaN);
        const lng = Number(url.searchParams.get('lng'))
          || (spots.length ? spots.reduce((a, c) => a + c.lng, 0) / spots.length : NaN);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return sendJson(res, 400, {
            error: 'no location yet — drop a stand on the map first',
          });
        }
        const radiusM = Math.min(1200, Math.max(150, Number(url.searchParams.get('radius')) || 500));

        // Terrain is the one slow input, and it is cached forever once fetched
        // because the ground does not move. Everything else is local.
        let terrain = null;
        try {
          terrain = await terrainFor(db, { lat, lng, radiusM });
        } catch (err) {
          return sendJson(res, 502, { error: `terrain could not be read: ${err.message}` });
        }
        if (!terrain?.covered) {
          return sendJson(res, 200, {
            candidates: [],
            note: terrain?.why ?? 'No LiDAR coverage on this ground, so there are no '
              + 'landforms to work from.',
          });
        }

        // Wind coverage only if it is already cached — this endpoint must not
        // block on a seven-year archive pull. Without it the suggester ranks on
        // ground and sign alone, and says so rather than quietly changing what
        // its numbers mean.
        let clim = null;
        try {
          clim = windClimatology(db, lat, lng, SEASON_MONTHS, 7);
        } catch { clim = null; }
        const coverage = clim ? standCoverage(stands, clim) : null;

        const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 5));
        // Over-generate, because the ownership filter below may drop spots that
        // landed over the line, and a shortlist that starts at five and loses
        // three is a shortlist of two for no reason.
        let result = suggestStands({
          features: terrain.features,
          stands,
          markers: allMarkers(db),
          gaps: coverage?.gaps ?? [],
          climatology: clim,
          limit: limit * 3,
        });
        // Keep suggestions on ground you can actually hunt. On-demand lookups
        // through the same in-memory parcel cache the map's card uses — nothing
        // is written anywhere. ?parcels=off skips it (outside Wisconsin, or the
        // service is down and you just want the terrain answer).
        if (url.searchParams.get('parcels') !== 'off') {
          result = await onYourGround(result, {
            lookup: (a, b) => parcelAt(a, b),
            stands, at: { lat, lng }, limit,
          });
        } else {
          result.candidates = result.candidates.slice(0, limit);
        }
        return sendJson(res, 200, {
          ...result,
          at: { lat, lng, radiusM },
          windHistoryLoaded: !!clim,
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
          // Printed as well as returned. The browser shows one line; the
          // window the launcher leaves open is where you can actually see what
          // went wrong, and "terrain fetch failed" on its own is not a
          // diagnosis.
          console.error(`\n  Terrain failed at ${lat.toFixed(5)},${lng.toFixed(5)} `
            + `(radius ${radiusM} m, spacing ${spacingM} m):\n  ${err.message}\n`
            + '  Run  node check-terrain.mjs  to test the elevation service on its own.\n');
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
