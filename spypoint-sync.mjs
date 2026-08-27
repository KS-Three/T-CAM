#!/usr/bin/env node
/**
 * spypoint-sync.mjs — pull your SpyPoint cameras (locations + status) and
 * photos to local disk, incrementally, via the same REST API the SpyPoint
 * app itself uses.
 *
 * UNOFFICIAL: endpoints mirrored from the community clients
 * hstern/pyspypoint and coloradude/spypoint-api-wrapper
 * (https://restapi.spypoint.com/api/v3). SpyPoint can change this API at any
 * time; when that happens this script fails loudly with a nonzero exit
 * instead of guessing.
 *
 * Zero dependencies. Node 20+.
 *
 *   SPYPOINT_EMAIL=you@example.com SPYPOINT_PASSWORD=... node spypoint-sync.mjs
 *
 * Options:
 *   --out DIR      output dir (default ./spypoint-data, or $SPYPOINT_OUT)
 *   --limit N      photos per API page (default 100)
 *   --max N        max new downloads per camera per run (default 500, 0 = all)
 *   --size S       large | medium | small (default large; falls back downward)
 *   --cameras A,B  only cameras whose name/id contains one of these
 *   --dry-run      show what would download; write nothing
 *   --inspect      dump raw field paths of one camera + one photo, then exit
 *   --quiet        errors and final summary only
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const API = 'https://restapi.spypoint.com/api/v3';
const FUTURE = '2100-01-01T00:00:00.000Z';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const maxRaw = parseInt(val('--max', '500'), 10);
const OPT = {
  out: path.resolve(val('--out', process.env.SPYPOINT_OUT || './spypoint-data')),
  limit: Math.max(1, parseInt(val('--limit', '100'), 10) || 100),
  max: Number.isNaN(maxRaw) ? 500 : Math.max(0, maxRaw),
  size: val('--size', 'large'),
  cameras: val('--cameras', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  dryRun: has('--dry-run'),
  inspect: has('--inspect'),
  quiet: has('--quiet'),
};

const log = (...a) => { if (!OPT.quiet) console.log(...a); };
const warn = (...a) => console.error(...a);
// Calling process.exit() while fetch still holds open sockets trips a libuv
// assertion on Windows — "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// file src\win\async.c" — which prints a crash dump right after the real error
// message and makes a clean failure look like a broken script. Unwind with a
// thrown error and set the exit code instead, so Node shuts down in its own
// time. (Seen on Node 24.18.0 / Windows, 2026-08-27.)
class Fatal extends Error {}
const die = msg => { throw new Fatal(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, route, { token, body } = {}) {
  await sleep(250); // no official rate limits exist, so stay deliberately slow
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(API + route, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < 3) { await sleep(1500 * attempt); continue; }
      throw new Error(`${method} ${route}: network failure after ${attempt} tries (${err.message})`);
    }
    if (res.status >= 500 && attempt < 3) { await sleep(1500 * attempt); continue; }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      const e = new Error(`${method} ${route} -> HTTP ${res.status}${text ? ` ${text}` : ''}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }
}

// The camera/photo schemas are undocumented (both community clients pass the
// JSON through untouched), so extraction hunts by key name instead of
// hardcoding paths. Run --inspect to see what your account actually returns.
function* walk(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') {
    if (prefix) yield [prefix, obj];
    return;
  }
  if (Array.isArray(obj)) {
    if (prefix && obj.length > 0 && obj.every(x => typeof x === 'number')) yield [prefix, obj];
    for (let i = 0; i < obj.length; i++) yield* walk(obj[i], `${prefix}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(obj)) yield* walk(v, prefix ? `${prefix}.${k}` : k);
}

const leafKey = p => p.replace(/\[\d+\]/g, '').split('.').pop();

function findFirst(obj, keyRe, pred = () => true) {
  for (const [p, v] of walk(obj)) {
    if (keyRe.test(leafKey(p)) && pred(v)) return { path: p, value: v };
  }
  return null;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const first = a => (Array.isArray(a) ? a[0] : undefined);

// Field paths below were confirmed against a real 4-camera FLEX-M account on
// 2026-08-27 via --inspect. The generic findFirst() hunts remain as fallbacks,
// since other SpyPoint models may lay their documents out differently.
//
// Location arrives as a GeoJSON Point (status.coordinates[0].position), so
// `coordinates` is [longitude, latitude] — NOT the other way round. This was
// verified, not assumed: the same object carries DMS strings, and converting
// them reproduces the numeric array with longitude in slot 0. Transposing it
// drops a Wisconsin camera into Asia, and a map renders that without
// complaining, so test/extract.test.js pins the ordering. Do not "fix" this.
function cameraSummary(cam) {
  const st = cam?.status ?? {};
  const gps = first(st.coordinates);
  const pos = gps?.position?.coordinates;
  const geo = Array.isArray(pos) && isNum(pos[0]) && isNum(pos[1]);
  const power = first(st.powerSources);
  // status.signal is an object, so an earlier "first number named signal" hunt
  // silently found nothing and every camera reported an unknown signal.
  const sig = st.signal ?? {};
  const sub = first(cam?.subscriptions);

  return {
    id: String(cam?.id ?? ''),
    name: cam?.config?.name
      ?? findFirst(cam, /^name$/i, v => typeof v === 'string' && v.length > 0)?.value
      ?? String(cam?.id ?? 'camera'),
    model: st.model ?? findFirst(cam, /^model$/i, v => typeof v === 'string')?.value ?? null,
    lat: geo ? pos[1] : findFirst(cam, /^lat(itude)?$/i, isNum)?.value ?? null,
    lng: geo ? pos[0] : findFirst(cam, /^(lng|lon|long|longitude)$/i, isNum)?.value ?? null,
    gpsFix: gps?.dateTime ?? null,
    battery: power?.percentage ?? first(st.batteries)
      ?? findFirst(cam, /batter/i, isNum)?.value ?? null,
    batteryLevel: power?.level ?? first(st.batteryLevels) ?? null,
    batterySource: power?.type ?? st.batteryType ?? null,
    signal: sig.processed?.percentage ?? null,
    signalBars: sig.processed?.bar ?? sig.bar ?? null,
    signalLevel: sig.processed?.level ?? null,
    signalType: sig.type ?? null,
    tempValue: st.temperature?.value ?? null,
    tempUnit: st.temperature?.unit ?? null,
    memUsed: st.memory?.used ?? null,
    memSize: st.memory?.size ?? null,
    plan: sub?.plan?.name ?? null,
    photoCount: sub?.photoCount ?? null,
    photoLimit: sub?.photoLimit ?? null,
    lastSeen: st.lastUpdate
      ?? findFirst(cam, /last.?(update|sync|comm|photo)/i, v => typeof v === 'string')?.value ?? null,
  };
}

const fmtLoc = r => (r.lat !== null && r.lng !== null ? `${r.lat},${r.lng}` : '?');

const fmtPct = (v, suffix = '%') => (isNum(v) ? `${v}${suffix}` : '?');

// A camera that has not phoned home in months has no new photos to fetch, and
// that is far and away the likeliest reason for an empty sync. Say so loudly
// rather than letting "0 new photos" read as a broken script.
function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

const STALE_DAYS = 30;

const DATE_KEYS = ['originDate', 'date', 'createDate', 'creationDate', 'dateTime'];
function photoDate(p) {
  for (const k of DATE_KEYS) {
    if (typeof p?.[k] === 'string' && !Number.isNaN(Date.parse(p[k]))) return p[k];
  }
  const hit = findFirst(p, /date|time/i, v => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
  return hit?.value ?? null;
}

function photoUrl(p, prefer) {
  for (const size of [prefer, 'large', 'medium', 'small']) {
    const s = p?.[size];
    if (s?.host && s?.path) return `https://${s.host}/${s.path}`;
  }
  return null;
}

const q = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const safe = s =>
  String(s).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'camera';

async function existingIds(root) {
  const ids = new Set();
  let names;
  try { names = await fs.readdir(root, { recursive: true }); } catch { return ids; }
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') ids.add(path.basename(n, path.extname(n)));
  }
  return ids;
}

async function download(url, dest) {
  await sleep(150);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

const fetchPage = (token, cameraId, dateEnd) =>
  api('POST', '/photo/all', {
    token,
    body: { camera: [cameraId], dateEnd, favorite: false, hd: false, limit: OPT.limit, tag: [] },
  });

function dumpPaths(label, obj) {
  console.log(`\n=== ${label} ===`);
  if (!obj) { console.log('  (nothing returned)'); return; }
  for (const [p, v] of walk(obj)) {
    let s = JSON.stringify(v);
    if (s && s.length > 80) s = s.slice(0, 77) + '...';
    console.log(`  ${p} = ${s}`);
  }
}

// ---------------------------------------------------------------------------
// Dashboard
//
// Written as a single self-contained HTML file next to the synced data, with
// the camera rows baked in as JSON. That keeps coordinates on this machine (no
// server, no upload) and makes the page work by double-clicking it — a page
// that fetched cameras.csv over file:// would be blocked by the browser.
//
// The slippy map is hand-rolled rather than pulled from a CDN so the page has
// no dependency to break. Only the OpenStreetMap raster tiles come from the
// network; with no connection the pins still lay out correctly over blank
// tiles, and the camera cards below are unaffected.
// ---------------------------------------------------------------------------

const RANK = { ok: 0, warn: 1, bad: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

function healthOf(r) {
  let level = 'ok';
  const notes = [];
  const age = daysSince(r.lastSeen);
  if (age === null) { level = worst(level, 'warn'); notes.push('never reported'); }
  else if (age >= STALE_DAYS) { level = worst(level, 'bad'); notes.push(`silent ${age} days`); }
  else if (age >= 7) { level = worst(level, 'warn'); notes.push(`quiet ${age} days`); }

  if (isNum(r.battery)) {
    if (r.battery <= 10) { level = worst(level, 'bad'); notes.push(`battery ${r.battery}%`); }
    else if (r.battery <= 30) { level = worst(level, 'warn'); notes.push(`battery ${r.battery}%`); }
  }
  return { level, notes, age };
}

// Embedding JSON in a <script> block: the only sequence that can break out is
// a literal "</script>", and & / < are escaped so nothing in a camera name can
// inject markup.
const embed = data => JSON.stringify(data)
  .replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

const PLAN_FILE = 'plan.json';

// Missing or malformed plan.json is normal, not an error: the planner may never
// have been run. The dashboard renders an explanatory panel in that case.
async function readPlan(dir) {
  try {
    const plan = JSON.parse(await fs.readFile(path.join(dir, PLAN_FILE), 'utf8'));
    return Array.isArray(plan?.sits) ? plan : null;
  } catch { return null; }
}

// `plan` is optional and comes from hunt-planner.mjs by way of plan.json, so a
// sync run picks up the last plan instead of wiping it off the page, and a
// planner run rebuilds this same page. Either tool can be run first.
function dashboardHtml(rows, photos, generatedAt, plan = null) {
  const payload = embed({
    generatedAt,
    staleDays: STALE_DAYS,
    cameras: rows.map(r => ({ ...r, health: healthOf(r) })),
    photos,
    plan,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail Cameras</title>
<style>
  :root {
    --bg: #f6f7f5; --panel: #fff; --ink: #1a1c19; --muted: #5d6159;
    --line: #dcdfd8; --ok: #2f7d4f; --warn: #b06d15; --bad: #b3352b;
    --accent: #375a3f;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14160f; --panel: #1d2018; --ink: #e8eae2; --muted: #9aa08f;
      --line: #2f3428; --ok: #6bbb85; --warn: #e0a850; --bad: #e8776b;
      --accent: #8fbf9c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
           justify-content: space-between; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .alert { border-left: 3px solid var(--bad); background: var(--panel);
           padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px; }
  .alert h2 { margin: 0 0 6px; font-size: 14px; }
  .alert ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; }
  #map { height: 420px; border: 1px solid var(--line); border-radius: 10px;
         position: relative; overflow: hidden; background: var(--panel);
         cursor: grab; touch-action: none; margin-bottom: 8px; }
  #map.drag { cursor: grabbing; }
  #tiles img { position: absolute; width: 256px; height: 256px; user-select: none;
               -webkit-user-drag: none; }
  .pin { position: absolute; width: 18px; height: 18px; border-radius: 50%;
         border: 2px solid #fff; transform: translate(-50%, -50%);
         box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer; }
  .pin.ok { background: var(--ok); } .pin.warn { background: var(--warn); }
  .pin.bad { background: var(--bad); }
  .plabel { position: absolute; transform: translate(-50%, -170%); font-size: 11px;
            font-weight: 600; white-space: nowrap; padding: 1px 5px; border-radius: 4px;
            background: rgba(0,0,0,.72); color: #fff; pointer-events: none; }
  .zoom { position: absolute; right: 10px; top: 10px; display: grid; gap: 4px; z-index: 5; }
  .zoom button { width: 30px; height: 30px; font-size: 17px; cursor: pointer;
                 border: 1px solid var(--line); background: var(--panel);
                 color: var(--ink); border-radius: 6px; }
  .attrib { font-size: 11px; color: var(--muted); margin-bottom: 24px; }
  .attrib a { color: inherit; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: 10px; padding: 14px 16px; }
  .card.bad { border-left: 3px solid var(--bad); }
  .card.warn { border-left: 3px solid var(--warn); }
  .card.ok { border-left: 3px solid var(--ok); }
  .card h3 { margin: 0 0 2px; font-size: 15px; }
  .model { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; gap: 10px;
         font-size: 13px; padding: 3px 0; }
  .row span:first-child { color: var(--muted); }
  .bar { height: 5px; border-radius: 3px; background: var(--line);
         overflow: hidden; margin-top: 3px; }
  .bar i { display: block; height: 100%; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 20px;
         border: 1px solid currentColor; margin-top: 9px; }
  .tag.ok { color: var(--ok); } .tag.warn { color: var(--warn); } .tag.bad { color: var(--bad); }
  a.coord { color: var(--accent); text-decoration: none; font-variant-numeric: tabular-nums; }
  a.coord:hover { text-decoration: underline; }
  h2.section { font-size: 15px; margin: 32px 0 12px; }
  .photos { display: grid; gap: 10px;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .photos figure { margin: 0; }
  .photos img { width: 100%; border-radius: 8px; display: block; border: 1px solid var(--line); }
  .photos figcaption { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 10px;
           padding: 20px; color: var(--muted); font-size: 14px; }
  .sit { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
         padding: 12px 14px; margin-bottom: 8px; display: grid;
         grid-template-columns: auto 1fr; gap: 4px 14px; align-items: start; }
  .sit .score { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums;
                text-align: center; min-width: 52px; }
  .sit .when { font-weight: 600; }
  .sit .cond { color: var(--muted); font-size: 13px; }
  .sit ul { margin: 6px 0 0; padding-left: 16px; font-size: 13px; color: var(--muted); }
  .sit li.neg { color: var(--bad); }
  .rating { display: block; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
  .r-prime .score, .r-prime .rating { color: var(--ok); }
  .r-strong .score, .r-strong .rating { color: var(--ok); }
  .r-good .score, .r-good .rating { color: var(--accent); }
  .r-fair .score, .r-fair .rating { color: var(--warn); }
  .r-poor .score, .r-poor .rating { color: var(--muted); }
  .stale-note { color: var(--warn); font-size: 12px; margin: -4px 0 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Trail Cameras</h1>
      <div class="sub" id="sub"></div>
    </div>
    <div class="sub" id="plan"></div>
  </header>
  <div id="alerts"></div>
  <h2 class="section" style="margin-top:0">Best sits ahead</h2>
  <div id="planArea"></div>
  <h2 class="section">Cameras</h2>
  <div id="map"><div id="tiles"></div><div id="pins"></div>
    <div class="zoom"><button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">\u2212</button></div>
  </div>
  <div class="attrib">Map data \u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors. Drag to pan.</div>
  <div class="grid" id="cards"></div>
  <h2 class="section">Recent photos</h2>
  <div id="photoArea"></div>
</div>
<script type="application/json" id="data">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c;
  if (x !== undefined) n.textContent = x; return n; };
const fmtDate = s => { if (!s) return 'never';
  const d = new Date(s); return isNaN(d) ? 'never' : d.toLocaleDateString(); };

document.getElementById('sub').textContent =
  D.cameras.length + ' camera' + (D.cameras.length === 1 ? '' : 's') +
  ' \u00b7 synced ' + new Date(D.generatedAt).toLocaleString();
const planned = D.cameras.find(c => c.plan);
if (planned) document.getElementById('plan').textContent =
  planned.plan + ' plan \u00b7 ' + planned.photoCount + '/' + planned.photoLimit + ' photos this cycle';

// ---- alerts -----------------------------------------------------------
const bad = D.cameras.filter(c => c.health.level !== 'ok');
if (bad.length) {
  const box = el('div', 'alert');
  box.appendChild(el('h2', null, 'Needs attention'));
  const ul = el('ul');
  for (const c of bad) ul.appendChild(el('li', null, c.name + ' \u2014 ' + c.health.notes.join(', ')));
  box.appendChild(ul);
  document.getElementById('alerts').appendChild(box);
}

// ---- map --------------------------------------------------------------
const TS = 256;
const located = D.cameras.filter(c => typeof c.lat === 'number' && typeof c.lng === 'number');
const mapEl = document.getElementById('map');
const tilesEl = document.getElementById('tiles');
const pinsEl = document.getElementById('pins');

// Web Mercator, in pixels at the current zoom.
const projX = (lng, z) => (lng + 180) / 360 * TS * 2 ** z;
const projY = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TS * 2 ** z;
};

let zoom = 16, centre = { lat: 0, lng: 0 };
if (located.length) {
  const lats = located.map(c => c.lat), lngs = located.map(c => c.lng);
  const [m1, m2] = [Math.min(...lats), Math.max(...lats)];
  const [n1, n2] = [Math.min(...lngs), Math.max(...lngs)];
  centre = { lat: (m1 + m2) / 2, lng: (n1 + n2) / 2 };
  // Widest zoom whose pixel span still fits, so every camera lands on screen.
  for (let z = 18; z >= 2; z--) {
    const w = Math.abs(projX(n2, z) - projX(n1, z)), h = Math.abs(projY(m1, z) - projY(m2, z));
    if (w < mapEl.clientWidth - 90 && h < mapEl.clientHeight - 90) { zoom = z; break; }
  }
}

function draw() {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const cx = projX(centre.lng, zoom), cy = projY(centre.lat, zoom);
  const left = cx - W / 2, top = cy - H / 2;
  const n = 2 ** zoom;
  tilesEl.textContent = ''; pinsEl.textContent = '';
  for (let tx = Math.floor(left / TS); tx <= Math.floor((left + W) / TS); tx++) {
    for (let ty = Math.floor(top / TS); ty <= Math.floor((top + H) / TS); ty++) {
      if (ty < 0 || ty >= n) continue;
      const img = new Image();
      img.src = 'https://tile.openstreetmap.org/' + zoom + '/' + ((tx % n) + n) % n + '/' + ty + '.png';
      img.alt = ''; img.loading = 'lazy';
      img.style.left = (tx * TS - left) + 'px';
      img.style.top = (ty * TS - top) + 'px';
      tilesEl.appendChild(img);
    }
  }
  for (const c of located) {
    const x = projX(c.lng, zoom) - left, y = projY(c.lat, zoom) - top;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const lab = el('div', 'plabel', c.name);
    lab.style.left = x + 'px'; lab.style.top = y + 'px';
    const p = el('div', 'pin ' + c.health.level);
    p.style.left = x + 'px'; p.style.top = y + 'px';
    p.title = c.name + ' \u2014 last contact ' + fmtDate(c.lastSeen);
    p.onclick = () => document.getElementById('cam-' + c.id)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pinsEl.append(lab, p);
  }
}

let drag = null;
mapEl.addEventListener('pointerdown', e => {
  if (e.target.closest('.zoom')) return;
  drag = { x: e.clientX, y: e.clientY }; mapEl.classList.add('drag');
  mapEl.setPointerCapture(e.pointerId);
});
mapEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  const cx = projX(centre.lng, zoom) - dx, cy = projY(centre.lat, zoom) - dy;
  const n = TS * 2 ** zoom;
  centre.lng = cx / n * 360 - 180;
  centre.lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / n))) * 180 / Math.PI;
  draw();
});
for (const ev of ['pointerup', 'pointercancel'])
  mapEl.addEventListener(ev, () => { drag = null; mapEl.classList.remove('drag'); });
document.getElementById('zin').onclick = () => { zoom = Math.min(19, zoom + 1); draw(); };
document.getElementById('zout').onclick = () => { zoom = Math.max(2, zoom - 1); draw(); };
addEventListener('resize', draw);
if (located.length) draw();
else mapEl.innerHTML = '<div style="padding:20px;color:#888">No camera reported GPS coordinates.</div>';

// ---- camera cards -----------------------------------------------------
const cards = document.getElementById('cards');
const meter = (pct, colour) => {
  const b = el('div', 'bar'), i = el('i');
  i.style.width = Math.max(0, Math.min(100, pct)) + '%';
  i.style.background = colour; b.appendChild(i); return b;
};
const line = (k, v) => { const r = el('div', 'row');
  r.append(el('span', null, k), typeof v === 'string' ? el('span', null, v) : v); return r; };

for (const c of D.cameras) {
  const card = el('div', 'card ' + c.health.level);
  card.id = 'cam-' + c.id;
  card.appendChild(el('h3', null, c.name));
  card.appendChild(el('div', 'model', [c.model, c.signalType].filter(Boolean).join(' \u00b7 ') || '\u2014'));

  if (typeof c.battery === 'number') {
    const v = el('span', null, c.battery + '%' + (c.batteryLevel ? ' (' + c.batteryLevel + ')' : ''));
    card.appendChild(line('Battery', v));
    card.appendChild(meter(c.battery,
      c.battery <= 10 ? 'var(--bad)' : c.battery <= 30 ? 'var(--warn)' : 'var(--ok)'));
  }
  if (typeof c.signal === 'number') {
    card.appendChild(line('Signal', c.signal + '%' +
      (c.signalBars !== null ? ' \u00b7 ' + c.signalBars + ' bars' : '')));
    card.appendChild(meter(c.signal, 'var(--accent)'));
  }
  if (typeof c.tempValue === 'number')
    card.appendChild(line('Temperature', c.tempValue + '\u00b0' + (c.tempUnit || '')));
  if (typeof c.memUsed === 'number' && typeof c.memSize === 'number')
    card.appendChild(line('SD card', c.memUsed + ' / ' + c.memSize + ' MB'));
  card.appendChild(line('Last contact', fmtDate(c.lastSeen) +
    (c.health.age !== null ? ' (' + c.health.age + 'd)' : '')));

  if (typeof c.lat === 'number') {
    const a = document.createElement('a');
    a.className = 'coord';
    a.href = 'https://www.openstreetmap.org/?mlat=' + c.lat + '&mlon=' + c.lng + '#map=17/' + c.lat + '/' + c.lng;
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = c.lat.toFixed(6) + ', ' + c.lng.toFixed(6);
    card.appendChild(line('Location', a));
  }
  const t = el('span', 'tag ' + c.health.level,
    c.health.level === 'ok' ? 'healthy' : c.health.notes.join(' \u00b7 '));
  card.appendChild(t);
  cards.appendChild(card);
}

// ---- hunt plan --------------------------------------------------------
const planArea = document.getElementById('planArea');
if (!D.plan || !D.plan.sits || !D.plan.sits.length) {
  planArea.appendChild(el('div', 'empty',
    'No hunt plan yet. Run "node hunt-planner.mjs" to rank the coming sits by weather, rut phase and moon — it needs no photos, only your camera locations.'));
} else {
  // A forecast goes off quickly, so say plainly when the plan was built rather
  // than presenting week-old weather as if it were current.
  const built = new Date(D.plan.generatedAt);
  const hrs = (Date.now() - built.getTime()) / 3600000;
  if (hrs > 12) {
    planArea.appendChild(el('div', 'stale-note',
      'This plan was built ' + (hrs < 48 ? Math.round(hrs) + ' hours' : Math.round(hrs / 24) + ' days')
      + ' ago. Re-run "node hunt-planner.mjs" for a current forecast.'));
  }
  for (const s of D.plan.sits.slice(0, 8)) {
    const row = el('div', 'sit r' + '-' + s.rating.toLowerCase());
    const sc = el('div');
    sc.appendChild(el('div', 'score', String(Math.round(s.total))));
    sc.appendChild(el('span', 'rating', s.rating));
    const body = el('div');
    const when = new Date(s.start);
    body.appendChild(el('div', 'when',
      when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
      + ' · ' + s.window + ' from '
      + when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      + ' · ' + s.camera));
    body.appendChild(el('div', 'cond',
      Math.round(s.temp) + '°F · wind ' + s.windFrom + ' ' + Math.round(s.wind)
      + ' mph · ' + s.rut + ' · ' + s.moon + ' moon'
      + (s.alsoAt && s.alsoAt.length
        ? ' · same window also scored at ' + s.alsoAt.join(', ') : '')));
    const ul = el('ul');
    for (const p of s.parts) {
      const li = el('li', p.points < 0 ? 'neg' : null,
        (p.points > 0 ? '+' : '') + p.points + '  ' + p.reason);
      ul.appendChild(li);
    }
    body.appendChild(ul);
    row.append(sc, body);
    planArea.appendChild(row);
  }
  planArea.appendChild(el('div', 'sub',
    'Wind direction is where the wind comes FROM. This ranks WHEN to sit; you still choose WHERE.'));
}

// ---- photos -----------------------------------------------------------
const area = document.getElementById('photoArea');
if (!D.photos.length) {
  const why = D.cameras.every(c => c.health.age !== null && c.health.age >= D.staleDays)
    ? 'Every camera has been silent for months, so there is nothing to download. Photos will appear here after the cameras start transmitting again and you re-run the sync.'
    : 'No photos have been synced yet. Run the script without --dry-run to download them.';
  area.appendChild(el('div', 'empty', why));
} else {
  const g = el('div', 'photos');
  for (const p of D.photos.slice(0, 60)) {
    const f = document.createElement('figure');
    const i = new Image(); i.src = p.file; i.alt = p.cameraName + ' ' + fmtDate(p.date);
    i.loading = 'lazy';
    const cap = el('figcaption', null,
      p.cameraName + ' \u00b7 ' + fmtDate(p.date) + (p.tags && p.tags.length ? ' \u00b7 ' + p.tags.join(', ') : ''));
    f.append(i, cap); g.appendChild(f);
  }
  area.appendChild(g);
}
</script>
</body>
</html>
`;
}

async function main() {
  const email = process.env.SPYPOINT_EMAIL;
  const password = process.env.SPYPOINT_PASSWORD;
  if (!email || !password) {
    die(`SPYPOINT_EMAIL and SPYPOINT_PASSWORD must be set (never hardcode them).
  PowerShell:  $env:SPYPOINT_EMAIL = "you@example.com"; $env:SPYPOINT_PASSWORD = "..."
  cmd:         set SPYPOINT_EMAIL=you@example.com
  bash:        export SPYPOINT_EMAIL=you@example.com`);
  }

  log(`Logging in as ${email} ...`);
  let auth;
  try {
    auth = await api('POST', '/user/login', { body: { username: email, password } });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      die('SpyPoint rejected the login — check SPYPOINT_EMAIL / SPYPOINT_PASSWORD.');
    }
    throw err;
  }
  const token = auth?.token;
  if (!token) {
    die(`login response carried no token — the API may have changed. Keys seen: ${Object.keys(auth ?? {}).join(', ')}`);
  }

  const cameras = await api('GET', '/camera/all', { token });
  if (!Array.isArray(cameras)) die('camera/all did not return an array — the API may have changed.');
  log(`${cameras.length} camera(s) on the account.`);

  if (OPT.inspect) {
    dumpPaths('camera[0] raw fields', cameras[0]);
    // An empty photo list is ambiguous on its own: it could mean the account
    // genuinely holds no photos, or that this query is shaped wrong. Dump the
    // response envelope for EVERY camera so the two can be told apart.
    for (const cam of cameras) {
      const label = cam?.config?.name ?? cam?.id ?? 'camera';
      if (!cam?.id) continue;
      const page = await fetchPage(token, cam.id, FUTURE);
      const photos = page?.photos ?? [];
      console.log(`\n=== photo/all envelope for ${label} ===`);
      console.log(`  response keys: ${Object.keys(page ?? {}).join(', ') || '(none)'}`);
      console.log(`  photos array present: ${Array.isArray(page?.photos)}`);
      console.log(`  photos returned: ${photos.length}`);
      for (const k of ['countPhotos', 'count', 'total', 'totalPhotos']) {
        if (page?.[k] !== undefined) console.log(`  ${k}: ${JSON.stringify(page[k])}`);
      }
      if (photos.length) { dumpPaths(`photo[0] raw fields (${label})`, photos[0]); break; }
    }
    console.log('\n(Trim anything you consider sensitive before sharing this output.)');
    return;
  }

  const rows = cameras.map(cameraSummary);
  const selected = OPT.cameras.length
    ? rows.filter(r => OPT.cameras.some(f =>
        r.name.toLowerCase().includes(f) || r.id.toLowerCase().includes(f)))
    : rows;
  const stale = [];
  for (const r of rows) {
    const mark = selected.includes(r) ? '' : '   (skipped by --cameras)';
    const age = daysSince(r.lastSeen);
    if (age !== null && age >= STALE_DAYS) stale.push({ name: r.name, age });
    const ageTxt = age === null ? '?' : `${r.lastSeen.slice(0, 10)} (${age}d ago)`;
    log(`  ${r.name}  model=${r.model ?? '?'}  loc=${fmtLoc(r)}`);
    log(`      battery=${fmtPct(r.battery)}${r.batteryLevel ? ` (${r.batteryLevel})` : ''}` +
        `  signal=${fmtPct(r.signal)}${r.signalBars !== null ? ` / ${r.signalBars} bars` : ''}` +
        `${r.signalType ? ` ${r.signalType}` : ''}` +
        `  temp=${r.tempValue !== null ? `${r.tempValue}°${r.tempUnit ?? ''}` : '?'}` +
        `  last=${ageTxt}${mark}`);
  }
  const plan = rows.find(r => r.plan);
  if (plan) {
    log(`Plan: ${plan.plan} — ${plan.photoCount ?? '?'}/${plan.photoLimit ?? '?'} photos used this billing cycle.`);
  }
  if (stale.length) {
    warn(`\nNOTE: ${stale.length} of ${rows.length} camera(s) have not reported in over ${STALE_DAYS} days:`);
    for (const s of stale) warn(`  ${s.name}: last contact ${s.age} days ago`);
    warn('A camera that is not transmitting has no new photos to fetch, so an empty');
    warn('sync below is expected rather than a failure.\n');
  }

  if (!OPT.dryRun) {
    await fs.mkdir(OPT.out, { recursive: true });
    await fs.writeFile(path.join(OPT.out, 'cameras.raw.json'), JSON.stringify(cameras, null, 2));
    const header = [
      'id', 'name', 'model', 'latitude', 'longitude', 'gps_fix',
      'battery_pct', 'battery_level', 'battery_source',
      'signal_pct', 'signal_bars', 'signal_level', 'signal_type',
      'temperature', 'temperature_unit', 'memory_used_mb', 'memory_size_mb',
      'plan', 'photos_used', 'photo_limit', 'last_seen', 'days_since_seen',
    ].join(',');
    const lines = rows.map(r => [
      r.id, q(r.name), q(r.model), r.lat ?? '', r.lng ?? '', q(r.gpsFix),
      r.battery ?? '', q(r.batteryLevel), q(r.batterySource),
      r.signal ?? '', r.signalBars ?? '', q(r.signalLevel), q(r.signalType),
      r.tempValue ?? '', q(r.tempUnit), r.memUsed ?? '', r.memSize ?? '',
      q(r.plan), r.photoCount ?? '', r.photoLimit ?? '',
      q(r.lastSeen), daysSince(r.lastSeen) ?? '',
    ].join(','));
    await fs.writeFile(path.join(OPT.out, 'cameras.csv'), [header, ...lines].join('\n') + '\n');
  }

  const photoRoot = path.join(OPT.out, 'photos');
  const seen = await existingIds(photoRoot); // the photos/ tree IS the sync state
  log(`${seen.size} photo(s) already on disk under ${photoRoot}`);

  let totalNew = 0;
  const meta = [];
  for (const cam of selected) {
    let dateEnd = FUTURE;
    let fetched = 0;
    let pages = 0;
    camloop: while (pages < 1000) {
      const page = await fetchPage(token, cam.id, dateEnd);
      const photos = page?.photos ?? [];
      pages++;
      if (photos.length === 0) break;
      let oldest = null;
      for (const p of photos) {
        const d = photoDate(p);
        if (d && (oldest === null || Date.parse(d) < Date.parse(oldest))) oldest = d;
        const id = String(p?.id ?? '');
        if (!id || seen.has(id)) continue;
        const url = photoUrl(p, OPT.size);
        if (!url) { warn(`  ${cam.name}: photo ${id} has no downloadable URL, skipped`); continue; }
        // Stored with forward slashes and relative to the output dir, because
        // the dashboard loads it as an <img src> from that same folder.
        const rel = ['photos', safe(cam.name), d ? safe(d.slice(0, 7)) : 'unknown-date', `${id}.jpg`].join('/');
        if (OPT.dryRun) {
          log(`  [dry] ${cam.name}  ${id}  ${d ?? 'date?'}`);
        } else {
          try {
            await download(url, path.join(OPT.out, ...rel.split('/')));
          } catch (err) {
            warn(`  ${cam.name}: download failed for ${id} (${err.message}) — will retry next run`);
            continue;
          }
        }
        seen.add(id);
        meta.push(JSON.stringify({
          id, camera: cam.id, cameraName: cam.name, date: d,
          tags: p.tag ?? p.tags ?? [], url, file: rel,
        }));
        fetched++; totalNew++;
        if (OPT.max && fetched >= OPT.max) {
          log(`  ${cam.name}: reached --max ${OPT.max}; older history remains (rerun, or --max 0 for full backfill)`);
          break camloop;
        }
      }
      if (photos.length < OPT.limit) break; // final page
      if (!oldest) break;                   // cannot page without dates
      const next = new Date(Date.parse(oldest) - 1).toISOString();
      if (Date.parse(next) >= Date.parse(dateEnd)) break; // cursor must move backward
      dateEnd = next;
    }
    log(`${cam.name}: ${fetched} new photo(s)`);
  }

  if (meta.length && !OPT.dryRun) {
    await fs.appendFile(path.join(OPT.out, 'photos.jsonl'), meta.join('\n') + '\n');
  }

  if (!OPT.dryRun) {
    // Read back the whole log, not just this run's additions, so the dashboard
    // shows every photo ever synced rather than only tonight's.
    let all = [];
    try {
      all = (await fs.readFile(path.join(OPT.out, 'photos.jsonl'), 'utf8'))
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(p => p && p.file);
    } catch { /* no photos synced yet — the dashboard says so itself */ }
    all.sort((a, b) => Date.parse(b.date ?? 0) - Date.parse(a.date ?? 0));

    const dash = path.join(OPT.out, 'dashboard.html');
    // Carry forward the last hunt plan if one exists, so syncing does not blank
    // the plan section. hunt-planner.mjs writes this file and rebuilds the same
    // page, so the two tools can be run in either order.
    const plan = await readPlan(OPT.out);
    await fs.writeFile(dash, dashboardHtml(rows, all, new Date().toISOString(), plan));
    log(`Dashboard: ${dash}`);
  }

  console.log(`Done: ${totalNew} new photo(s)${OPT.dryRun ? ' would be downloaded (dry run)' : ''}. Output: ${OPT.out}`);
}

// Run only when invoked as a program. Importing this file — which is how
// test/extract.test.js reaches the pure functions below — must not start a
// sync or demand credentials.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch(err => {
    // A Fatal is one of this script's own diagnosed failures, so its message is
    // the whole story; anything else is unexpected and earns a stack trace.
    console.error(`\nERROR: ${err instanceof Fatal ? err.message : err.stack ?? String(err)}`);
    process.exitCode = 1;
  });
}

export { cameraSummary, fmtLoc, fmtPct, daysSince, photoDate, photoUrl, healthOf, dashboardHtml, readPlan, PLAN_FILE, STALE_DAYS };
