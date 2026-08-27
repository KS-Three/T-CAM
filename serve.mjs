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
  STAND_TYPES, COMPASS,
} from './db.mjs';
import { dashboardHtml, readPlan } from './spypoint-sync.mjs';

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
  return { generatedAt: new Date().toISOString(), cameras, photos, stands, plan, counts: counts(db) };
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
          dashboardHtml(s.cameras, s.photos, s.generatedAt, s.plan, s.stands, true));
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
      if (req.method === 'GET' && url.pathname === '/api/stand-types') {
        return sendJson(res, 200, { types: STAND_TYPES, winds: COMPASS });
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
