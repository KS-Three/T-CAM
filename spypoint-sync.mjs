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
import { getProvider, credentialsFor } from './providers/index.mjs';
import spypoint from './providers/spypoint.mjs';
import { openDb, upsertCamera, upsertPhoto, addDetection, counts } from './db.mjs';

// Re-exported from the provider rather than defined twice: two copies of the
// same extraction logic is exactly how they drift apart.
const cameraSummary = spypoint.normalizeCamera;
const photoDate = p => spypoint.photoDate(p);
const photoUrl = (p, prefer) => spypoint.photoUrl(p, prefer);

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
  provider: val('--provider', 'spypoint'),
  account: val('--account', null),
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

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const first = a => (Array.isArray(a) ? a[0] : undefined);

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
function dashboardHtml(rows, photos, generatedAt, plan = null, stands = [], live = false, markers = []) {
  const payload = embed({
    generatedAt,
    staleDays: STALE_DAYS,
    cameras: rows.map(r => ({ ...r, health: healthOf(r) })),
    photos,
    plan,
    stands,
    // Only a SERVED page can save a pin: a file:// page has no server to POST
    // to, so the button would do nothing. This must be passed in rather than
    // hardcoded — it was hardcoded true at first, which put a dead button on
    // the static dashboard the sync writes.
    live,
    markers,
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
  /* Stand pins are a different SHAPE as well as colour: a teardrop against the
     cameras' circles, so the two are told apart without relying on colour. */
  .stand { position: absolute; width: 16px; height: 16px; cursor: pointer;
           transform: translate(-50%, -100%) rotate(-45deg);
           border: 2px solid #fff; border-radius: 50% 50% 50% 0;
           background: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,.5); }
  .stand.sel { outline: 3px solid var(--warn); outline-offset: 2px; }
  .slabel { position: absolute; transform: translate(-50%, -230%); font-size: 11px;
            font-weight: 600; white-space: nowrap; padding: 1px 5px; border-radius: 4px;
            background: rgba(0,0,0,.65); color: #fff; pointer-events: none; }
  /* Top-LEFT: the zoom buttons own the top-right and the layer switcher the
     bottom-left, so this is the only free corner. */
  .maptools { position: absolute; left: 10px; top: 10px; z-index: 3; display: flex;
              flex-direction: column; gap: 6px; }
  .maptools button { padding: 7px 11px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
                     border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
                     background: var(--panel); color: var(--ink);
                     box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .maptools button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  #map.placing { cursor: crosshair; }
  /* The terrain layers cover the whole map, so they MUST not take clicks —
     without pointer-events:none they would swallow every press meant for the
     ground and break stand placement and ownership lookup alike. */
  #terrain, #contours { position: absolute; left: 0; top: 0; width: 100%; height: 100%;
                        pointer-events: none; display: none; }
  #map.terrain-on #terrain, #map.terrain-on #contours { display: block; }
  #terrain { opacity: .72; mix-blend-mode: multiply; }
  #contours path { fill: none; stroke: rgba(255,238,170,.55); stroke-width: 1; }
  #contours path.index { stroke: rgba(255,225,120,.95); stroke-width: 1.8; }
  /* Drainages and ridges are drawn in different colours AND different dash
     patterns, so they stay distinguishable printed, in bright sun, or by
     someone who does not separate blue from tan easily. */
  #contours path.drain { stroke: rgba(120,190,255,.95); stroke-width: 2.4; stroke-linecap: round; }
  #contours path.ridgeline { stroke: rgba(255,170,105,.9); stroke-width: 2.2;
                             stroke-dasharray: 7 5; stroke-linecap: round; }
  .tfeat { position: absolute; z-index: 2; pointer-events: auto; cursor: help; }
  .tfeat.saddle { width: 13px; height: 13px; transform: translate(-50%,-50%) rotate(45deg);
                  background: rgba(255,215,0,.92); border: 2px solid #3a2c00; }
  .tfeat.bench { width: 13px; height: 9px; transform: translate(-50%,-50%);
                 background: rgba(160,235,160,.92); border: 2px solid #123a12; border-radius: 2px; }
  .tlegend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .tlegend span { display: inline-flex; align-items: center; gap: 4px; }
  .tlegend i { width: 14px; height: 0; border-top-width: 3px; border-top-style: solid; }
  /* Sign markers carry a LETTER as well as a colour, so a rub and a scrape are
     told apart on a sunlit phone screen and in greyscale. */
  .mark { position: absolute; width: 18px; height: 18px; cursor: pointer;
          transform: translate(-50%, -50%); border-radius: 4px; border: 2px solid #fff;
          font: 700 10px/14px ui-sans-serif, system-ui, sans-serif; text-align: center;
          color: #10240f; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
  .mark.old { opacity: .45; }
  .ovsep { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
           color: var(--muted); padding: 6px 4px 2px; border-top: 1px solid var(--line);
           margin-top: 4px; }
  .layermenu button.ovbtn { background: none; height: auto; width: auto; padding: 4px 6px;
    font: 600 11px/1.3 ui-sans-serif, system-ui, sans-serif; color: var(--ink);
    text-align: left; border: 0; cursor: pointer; }
  .layermenu button.ovbtn.on { color: var(--accent); }
  .mklabel { position: absolute; transform: translate(-50%, -190%); font-size: 10px;
             white-space: nowrap; padding: 1px 4px; border-radius: 4px;
             background: rgba(0,0,0,.6); color: #fff; pointer-events: none; }
  #contours path.parcel { stroke: rgba(255,90,90,.95); stroke-width: 2.6; fill: rgba(255,90,90,.10);
                          stroke-dasharray: none; }
  .terrainnote { position: absolute; left: 10px; bottom: 46px; z-index: 4; max-width: 260px;
                 background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
                 padding: 8px 10px; font-size: 11px; color: var(--muted);
                 box-shadow: 0 2px 10px rgba(0,0,0,.35); }
  .terrainnote b { color: var(--ink); }
  .sitplan { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
             margin-bottom: 10px; background: var(--panel); }
  .sitplan h3 { margin: 0 0 2px; font-size: 14px; }
  .sitplan .verdict { font-size: 13px; color: var(--ink); margin: 6px 0 10px; }
  .srow { display: flex; align-items: baseline; gap: 10px; padding: 5px 0;
          border-top: 1px solid var(--line); font-size: 13px; }
  .srow .nm { font-weight: 600; min-width: 150px; }
  .srow .verdict-tag { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
                       margin-left: 8px; }
  .srow.yes .verdict-tag { color: var(--ok); }
  .srow.no .verdict-tag { color: var(--bad); }
  .srow.unknown .verdict-tag { color: var(--muted); }
  .srow ul { margin: 2px 0 0; padding-left: 15px; color: var(--muted); font-size: 12px; }
  .srow li.minus { color: var(--warn); }
  .terrainnote .warn { color: var(--warn); }
  .standform { position: absolute; left: 50%; top: 50%; z-index: 5;
               transform: translate(-50%, -50%); width: min(340px, 90%);
               background: var(--panel); border: 1px solid var(--line);
               border-radius: 10px; padding: 16px; box-shadow: 0 6px 28px rgba(0,0,0,.4); }
  .standform h3 { margin: 0 0 10px; font-size: 15px; }
  .standform label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; }
  .standform input, .standform select, .standform textarea {
    width: 100%; padding: 7px 9px; font: inherit; font-size: 13px; color: var(--ink);
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
  .winds { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; margin-top: 4px; }
  .winds button { padding: 5px 0; font: 600 10px/1 ui-sans-serif, system-ui, sans-serif;
                  border: 1px solid var(--line); border-radius: 4px; cursor: pointer;
                  background: var(--bg); color: var(--muted); }
  .winds button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .formrow { display: flex; gap: 8px; margin-top: 14px; }
  .formrow button { flex: 1; padding: 8px; font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
                    border-radius: 6px; cursor: pointer; border: 1px solid var(--line);
                    background: var(--bg); color: var(--ink); }
  .formrow button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .formrow button.danger { color: var(--bad); }
  /* The marker form's Delete sits outside .formrow, so it needs its own rule
     rather than inheriting one scoped to that row. */
  .standform > button.danger { color: var(--bad); background: var(--bg); cursor: pointer;
    border: 1px solid var(--line); border-radius: 6px; padding: 7px 11px; font: inherit;
    font-size: 13px; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  /* Bottom-right: the toolbar owns the top-left, zoom the top-right and the
     layer switcher the bottom-left, so this is the last free corner. */
  .parcelcard { position: absolute; right: 10px; bottom: 10px; z-index: 5;
                width: min(300px, calc(100% - 20px)); background: var(--panel);
                border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px;
                box-shadow: 0 4px 20px rgba(0,0,0,.35); font-size: 13px; }
  .parcelcard h4 { margin: 0 0 8px; font-size: 14px; }
  .parcelcard .row { display: flex; justify-content: space-between; gap: 12px;
                     padding: 3px 0; color: var(--muted); }
  .parcelcard .row b { color: var(--ink); font-weight: 600; text-align: right; }
  .parcelcard .close { position: absolute; right: 8px; top: 6px; cursor: pointer;
                       border: 0; background: none; color: var(--muted); font-size: 18px;
                       line-height: 1; padding: 2px 6px; }
  /* Map-type control, positioned like Google's: a thumbnail in the lower-left
     showing what you would switch TO, with the full list on hover or tap. */
  .layers { position: absolute; left: 10px; bottom: 10px; z-index: 3; }
  .swatch { width: 74px; height: 58px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 2px solid #fff; box-shadow: 0 1px 5px rgba(0,0,0,.45);
            background-size: cover; background-position: center; position: relative;
            display: block; overflow: hidden; }
  .swatch span { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 0 4px;
                 font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; color: #fff;
                 text-shadow: 0 1px 3px rgba(0,0,0,.9); background: rgba(0,0,0,.35); }
  .layermenu { position: absolute; left: 0; bottom: 0; display: none; gap: 8px;
               background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
               padding: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
  .layers.open .layermenu { display: flex; }
  .layers.open .swatch { visibility: hidden; }
  .layermenu button { width: 74px; height: 58px; padding: 0; border-radius: 6px;
                      cursor: pointer; border: 2px solid transparent; overflow: hidden;
                      background-size: cover; background-position: center; position: relative; }
  .layermenu button.on { border-color: var(--accent); }
  .layermenu button span { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 0 4px;
                           font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; color: #fff;
                           text-shadow: 0 1px 3px rgba(0,0,0,.9); background: rgba(0,0,0,.35); }
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
  <h2 class="section">Where to sit</h2>
  <div id="standPlan"></div>
  <h2 class="section">Cameras</h2>
  <div id="map"><div id="tiles"></div><canvas id="terrain"></canvas><svg id="contours"></svg><div id="pins"></div>
    <div class="zoom"><button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">\u2212</button></div>
    <div class="maptools">
      <button id="addStand" type="button">+ Add stand</button>
      <button id="whoOwns" type="button">Who owns this?</button>
      <button id="terrainBtn" type="button">Terrain</button>
      <button id="markBtn" type="button">+ Mark sign</button>
    </div>
    <div class="layers">
      <button id="layerToggle" class="swatch" type="button" title="Change map type">
        <span id="layerLabel"></span>
      </button>
      <div class="layermenu" id="layerMenu"></div>
    </div>
  </div>
  <div class="attrib"><span id="credit"></span>. Drag to pan, scroll to zoom.</div>
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

// Base layers, laid out like Google Maps: a Map/Satellite thumbnail toggle in
// the bottom-left corner, with Hybrid offered once satellite is showing.
//
// Google's own tiles are deliberately NOT used — serving them outside their
// Maps API breaches their terms. Esri's World Imagery is free for this kind of
// use with attribution and reaches z19 over rural Wisconsin, which is close
// enough to pick out field edges, funnels and standing crops. USGS imagery was
// measured too: sharper where it exists, but it 404s above z16 here, so it is
// offered as an option rather than the default.
const LAYERS = {
  map: {
    label: 'Map', alt: 'Satellite', maxZoom: 19,
    url: (z, x, y) => 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png',
    credit: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  satellite: {
    label: 'Satellite', alt: 'Map', maxZoom: 19,
    url: (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x,
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
  hybrid: {
    label: 'Hybrid', alt: 'Map', maxZoom: 19,
    url: (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x,
    overlay: (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/' + z + '/' + y + '/' + x,
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
  topo: {
    label: 'Terrain', alt: 'Map', maxZoom: 17,
    url: (z, x, y) => 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/' + z + '/' + y + '/' + x,
    credit: 'Topo © <a href="https://www.usgs.gov/">USGS</a> The National Map',
  },
};

/**
 * Wisconsin DNR overlays — the regulatory layers, free from the state.
 *
 * These are MapServers rather than tile caches, so there is no /tile/z/y/x to
 * ask for; each tile is an "export" of a bounding box. The box has to be given
 * in Web Mercator metres (bboxSR 3857) to line up with the base map, which is
 * why tileBounds3857 exists rather than passing degrees.
 *
 * Labels are deliberately narrow. "Public land" would be wrong and dangerously
 * so: VPA is the Voluntary Public Access programme — private land enrolled for
 * public hunting — not state land, and not every place you may legally hunt.
 * Nothing here replaces reading the regulations.
 */
const OVERLAYS = {
  vpa: {
    label: 'VPA public access',
    note: 'Private land enrolled in the DNR Voluntary Public Access programme. '
      + 'Not all public land, and not a substitute for the regulations.',
    service: 'WM_VPA/WM_VPA_HUNT_LEASE_LAND_WTM',
    credit: 'Public access © <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a>',
  },
  cwd: {
    label: 'CWD areas',
    note: 'Chronic wasting disease management areas. Baiting and carcass '
      + 'transport rules differ inside these.',
    service: 'WM_CWD/WM_CWD_WTM_Ext',
    credit: 'CWD areas © <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a>',
  },
  units: {
    label: 'Deer zones',
    note: 'DNR deer management zones — which unit your tag is valid in.',
    service: 'WM_CWD/WM_DEER_MANAGEMENT_ZONES_WTM_Ext',
    credit: 'Deer zones © <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a>',
  },
};

// Web Mercator metres for one slippy tile. The projection constant is the
// half-circumference of the earth in the same metres the base tiles use.
const MERC = 20037508.342789244;
function tileBounds3857(z, x, y) {
  const size = 2 * MERC / 2 ** z;
  return [
    -MERC + x * size,
    MERC - (y + 1) * size,
    -MERC + (x + 1) * size,
    MERC - y * size,
  ].join(',');
}

const overlayUrl = (key, z, x, y) =>
  'https://dnrmaps.wi.gov/arcgis/rest/services/' + OVERLAYS[key].service
  + '/MapServer/export?bbox=' + tileBounds3857(z, x, y)
  + '&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image';

// Remembered per browser, like the base layer.
let overlayOn = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('trailcam.overlays') || '[]');
  overlayOn = new Set(saved.filter(k => OVERLAYS[k]));
} catch { /* private window, or blocked site data */ }
const saveOverlays = () => {
  try { localStorage.setItem('trailcam.overlays', JSON.stringify([...overlayOn])); }
  catch { /* ignore */ }
};

// Remembered per browser. Wrapped because a private window or blocked site
// data makes storage throw rather than return null.
let layerKey = 'satellite';
try { layerKey = localStorage.getItem('trailcam.layer') || 'satellite'; } catch { /* ignore */ }
if (!LAYERS[layerKey]) layerKey = 'satellite';
const saveLayer = k => { try { localStorage.setItem('trailcam.layer', k); } catch { /* ignore */ } };
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
  drawTerrain(left, top, W, H);
  for (let tx = Math.floor(left / TS); tx <= Math.floor((left + W) / TS); tx++) {
    for (let ty = Math.floor(top / TS); ty <= Math.floor((top + H) / TS); ty++) {
      if (ty < 0 || ty >= n) continue;
      const L = LAYERS[layerKey];
      const wx = ((tx % n) + n) % n;
      const place = img => {
        img.alt = ''; img.loading = 'lazy';
        img.style.left = (tx * TS - left) + 'px';
        img.style.top = (ty * TS - top) + 'px';
        // Offline — in a cabin, or a tile server having a bad day — a failed
        // tile otherwise leaves a broken-image icon in every cell. Hide it and
        // let the blank panel show through; the pins are what matter and they
        // stay correctly positioned regardless.
        img.onerror = () => { img.style.display = 'none'; };
        tilesEl.appendChild(img);
      };
      const base = new Image();
      base.src = L.url(zoom, wx, ty);
      place(base);
      // Hybrid draws place names and boundaries as a transparent PNG over the
      // imagery, in a second pass so it always lands on top.
      if (L.overlay) {
        const ov = new Image();
        ov.src = L.overlay(zoom, wx, ty);
        ov.style.pointerEvents = 'none';
        place(ov);
      }
      // DNR regulatory overlays, each a transparent PNG in its own pass.
      for (const key of overlayOn) {
        const dnr = new Image();
        dnr.src = overlayUrl(key, zoom, wx, ty);
        dnr.style.pointerEvents = 'none';
        dnr.style.opacity = '0.55';
        place(dnr);
      }
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

  // Stands: teardrops rather than circles, so they read as a different KIND of
  // thing than a camera even at a glance or in greyscale.
  for (const s of STANDS) {
    const x = projX(s.lng, zoom) - left, y = projY(s.lat, zoom) - top;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const lab = el('div', 'slabel', s.name);
    lab.style.left = x + 'px'; lab.style.top = y + 'px';
    const pin = el('div', 'stand' + (editing && editing.id === s.id ? ' sel' : ''));
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    pin.title = s.name + ' \u2014 ' + s.type.replace('-', ' ')
      + (s.winds && s.winds.length ? ' \u00b7 good on ' + s.winds.join(', ') : '')
      + (s.nearbyCameras && s.nearbyCameras.length
        ? ' \u00b7 covers ' + s.nearbyCameras.map(c => c.name + ' (' + c.metres + 'm)').join(', ')
        : '');
    pin.onclick = ev => { ev.stopPropagation(); openStandForm(s); };
    pinsEl.append(lab, pin);
  }

  drawMarkers(left, top, W, H);
}




// ---- scouting markers -------------------------------------------------
// Sign you found on the ground. Both paid apps are built around this layer,
// and it is the one that turns a generic map into YOUR map.
let MARKERS = D.markers || [];
let marking = false;
const markBtn = document.getElementById('markBtn');

// Colour AND letter for each kind. Colour alone fails on a sunlit phone.
const MARK_STYLE = {
  rub: ['#d8b25a', 'R'], scrape: ['#c98a4b', 'S'], bed: ['#9fd3a0', 'B'],
  trail: ['#a8c8e8', 'T'], 'food-plot': ['#b8e07a', 'F'], water: ['#7fc4e8', 'W'],
  access: ['#e0a8d8', 'A'], other: ['#cccccc', '?'],
};

// Sign goes stale. A rub found last November is history in October, so an old
// marker is drawn faded rather than as if you saw it this morning.
const STALE_SIGN_DAYS = 45;

async function refreshMarkers() {
  MARKERS = await (await fetch('/api/markers')).json();
  draw();
}

function drawMarkers(left, top, W, H) {
  for (const m of MARKERS) {
    const x = projX(m.lng, zoom) - left, y = projY(m.lat, zoom) - top;
    if (x < -30 || y < -30 || x > W + 30 || y > H + 30) continue;
    const [colour, letter] = MARK_STYLE[m.kind] || MARK_STYLE.other;
    const stale = m.daysOld !== null && m.daysOld > STALE_SIGN_DAYS;
    const pin = el('div', 'mark' + (stale ? ' old' : ''), letter);
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    pin.style.background = colour;
    pin.title = m.label + (m.name ? ' \u2014 ' + m.name : '')
      + (m.daysOld === null ? ' \u2014 no date recorded'
         : m.daysOld === 0 ? ' \u2014 found today'
         : ' \u2014 found ' + m.daysOld + ' days ago')
      // The newline below is escaped TWICE on purpose. This whole script is
      // emitted from a template literal, so a single-escaped newline is turned
      // into a REAL line break when the page is built — which lands a raw
      // newline inside a quoted string and makes the entire dashboard script a
      // syntax error. (Writing that warning out in full here broke it a second
      // time, because the comment is inside the same template literal.)
      // Unicode escapes such as the em-dash are safe: they produce an ordinary
      // character rather than a control one.
      + (m.notes ? '\\n' + m.notes : '');
    pin.onclick = ev => { ev.stopPropagation(); openMarkerForm(m); };
    pinsEl.appendChild(pin);
    if (m.name) {
      const lab = el('div', 'mklabel', m.name);
      lab.style.left = x + 'px'; lab.style.top = y + 'px';
      pinsEl.appendChild(lab);
    }
  }
}

markBtn.onclick = ev => {
  ev.stopPropagation();
  if (!D.live) return;
  marking = !marking;
  if (marking && placing) addBtn.onclick(new Event('click'));
  if (marking && identifying) ownBtn.onclick(new Event('click'));
  markBtn.classList.toggle('on', marking);
  markBtn.textContent = marking ? 'Click the map\u2026' : '+ Mark sign';
  mapEl.classList.toggle('placing', marking);
};
if (!D.live) {
  markBtn.disabled = true;
  markBtn.title = 'Markers need the server';
  markBtn.style.opacity = '0.6';
  markBtn.style.cursor = 'not-allowed';
}

function openMarkerForm(marker) {
  document.querySelector('.standform')?.remove();
  const isNew = !marker.id;
  const form = el('div', 'standform');
  form.appendChild(el('h3', null, isNew ? 'Mark sign' : 'Edit sign'));

  const kind = document.createElement('select');
  for (const [value, label] of Object.entries(
    { rub: 'Rub', scrape: 'Scrape', bed: 'Bed', trail: 'Trail',
      'food-plot': 'Food plot', water: 'Water', access: 'Access route', other: 'Other' })) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    if ((marker.kind || 'rub') === value) o.selected = true;
    kind.appendChild(o);
  }
  form.append(el('label', null, 'What is it'), kind);

  const name = document.createElement('input');
  name.value = marker.name || '';
  name.placeholder = 'Fence-line rub';
  form.append(el('label', null, 'Name (optional)'), name);

  // Defaulted to today because that is nearly always right, and because sign
  // with no date cannot be aged later.
  const found = document.createElement('input');
  found.type = 'date';
  found.value = (marker.found_at || new Date().toISOString()).slice(0, 10);
  form.append(el('label', null, 'When you found it'), found);

  const notes = document.createElement('textarea');
  notes.rows = 2;
  notes.value = marker.notes || '';
  form.append(el('label', null, 'Notes'), notes);

  const row = el('div', 'formrow');
  const save = el('button', 'primary', isNew ? 'Drop pin' : 'Save');
  const cancel = el('button', null, 'Cancel');
  row.append(save, cancel);
  form.appendChild(row);

  if (!isNew) {
    const del = el('button', 'danger', 'Delete');
    del.style.marginTop = '8px';
    del.onclick = async () => {
      await apiWrite('DELETE', '/api/markers/' + marker.id);
      form.remove();
      refreshMarkers();
    };
    form.appendChild(del);
  }

  cancel.onclick = () => form.remove();
  save.onclick = async () => {
    const body = {
      kind: kind.value, name: name.value.trim() || null,
      lat: marker.lat, lng: marker.lng,
      foundAt: found.value || null, notes: notes.value.trim() || null,
    };
    try {
      if (isNew) await apiWrite('POST', '/api/markers', body);
      else await apiWrite('PATCH', '/api/markers/' + marker.id, body);
      form.remove();
      refreshMarkers();
    } catch (err) {
      form.appendChild(el('div', 'hint', 'Could not save: ' + err.message));
    }
  };
  mapEl.appendChild(form);
  name.focus();
}

// ---- where to sit -----------------------------------------------------
// The planner ranks WHEN. This ranks WHERE within one of those windows, which
// is the question you act on while putting your boots by the door.
const standPlanEl = document.getElementById('standPlan');

async function loadStandPlan() {
  if (!D.live) {
    standPlanEl.appendChild(el('div', 'empty',
      'Stand ranking needs the server \u2014 open http://127.0.0.1:8787'));
    return;
  }
  let data;
  try {
    data = await (await fetch('/api/stand-plan?sits=3')).json();
  } catch {
    standPlanEl.appendChild(el('div', 'empty', 'Could not load the stand ranking.'));
    return;
  }
  standPlanEl.textContent = '';
  if (data.note) standPlanEl.appendChild(el('div', 'stale-note', data.note));
  if (!data.sits.length) return;

  for (const sit of data.sits) {
    const box = el('div', 'sitplan');
    const d = new Date(sit.date + 'T12:00:00');
    box.appendChild(el('h3', null,
      d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' ' + sit.window + ' \u2014 ' + sit.rating + ', wind ' + sit.windFrom));
    box.appendChild(el('div', 'verdict', sit.summary));

    for (const st of sit.stands) {
      const cls = st.huntable === true ? 'yes' : st.huntable === false ? 'no' : 'unknown';
      const row = el('div', 'srow ' + cls);
      const left = el('div');
      left.appendChild(el('span', 'nm', st.name));
      // "Unknown" is shown as unknown, never as a quiet yes: a stand whose
      // winds have not been recorded must not look like one that works.
      left.appendChild(el('span', 'verdict-tag',
        st.huntable === true ? 'huntable' : st.huntable === false ? 'wrong wind' : 'winds not set'));
      const ul = document.createElement('ul');
      for (const r of st.reasons) {
        const li = el('li', r.points < 0 ? 'minus' : null,
          r.why + (r.points ? ' (' + (r.points > 0 ? '+' : '') + r.points + ')' : ''));
        ul.appendChild(li);
      }
      left.appendChild(ul);
      row.appendChild(left);
      box.appendChild(row);
    }
    standPlanEl.appendChild(box);
  }
}
loadStandPlan();

// ---- terrain ----------------------------------------------------------
// The ground itself, from free USGS LiDAR. This is the layer the paid apps
// charge for, and on subtle ground it is the one that actually tells you where
// to sit: a two-foot bench does not show up on satellite imagery at all.
const terrainCanvas = document.getElementById('terrain');
const contoursEl = document.getElementById('contours');
let PARCEL_RINGS = null;     // boundary of the parcel last looked up
let TERRAIN = null;          // the loaded payload
let terrainImage = null;     // an offscreen canvas holding the hillshade
let terrainOn = false;
let terrainLoading = false;
const terrainBtn = document.getElementById('terrainBtn');

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

function terrainNote(html) {
  document.querySelector('.terrainnote')?.remove();
  if (!html) return;
  const n = el('div', 'terrainnote');
  n.innerHTML = html;
  mapEl.appendChild(n);
}

/** base64 -> bytes, without pulling in anything. */
function unb64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildTerrainImage(t) {
  const { cols, rows } = t.hillshade;
  const shade = unb64(t.hillshade.shade), alpha = unb64(t.hillshade.alpha);
  const off = document.createElement('canvas');
  off.width = cols; off.height = rows;
  const ctx = off.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    const v = shade[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(img, 0, 0);
  return off;
}

/**
 * How much ground to ask for, and how finely.
 *
 * A fixed patch is wrong in both directions: zoomed out it covers a third of
 * the screen, zoomed in it fetches far more than you can see. So the radius
 * follows the visible map, and the spacing is then chosen to keep the sample
 * count — and therefore the wait, and the load on a public service — roughly
 * constant however much ground was asked for.
 */
function terrainRequestForView() {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  // Metres per pixel at this zoom and latitude, from the Web Mercator scale.
  const mpp = 156543.03392 * Math.cos(centre.lat * Math.PI / 180) / 2 ** zoom;
  const halfSpan = Math.max(W, H) / 2 * mpp;
  const radius = Math.min(1500, Math.max(150, Math.round(halfSpan)));
  // Aim for about 120 cells across, so a patch is ~14k samples whatever its
  // size. The server clamps spacing to 5 m at the finest regardless.
  const spacing = Math.min(50, Math.max(5, Math.round(2 * radius / 120)));
  return { radius, spacing };
}

/** Is the map still looking at the ground we loaded? */
function terrainCoversView() {
  if (!TERRAIN) return false;
  const b = TERRAIN.bounds;
  return centre.lat >= b.south && centre.lat <= b.north
      && centre.lng >= b.west && centre.lng <= b.east;
}

async function loadTerrain() {
  if (terrainLoading) return;
  terrainLoading = true;
  const { radius, spacing } = terrainRequestForView();
  terrainBtn.textContent = 'Reading ground\u2026';
  terrainNote('Fetching LiDAR elevation from USGS for about '
    + (radius >= 1000 ? (radius * 2 / 1000).toFixed(1) + ' km' : radius * 2 + ' m')
    + ' of ground. A few seconds the first time, then it is cached and instant.');
  try {
    const res = await fetch('/api/terrain?lat=' + centre.lat + '&lng=' + centre.lng
      + '&radius=' + radius + '&spacing=' + spacing);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'terrain lookup failed');
    if (!body.covered) {
      terrainNote('No LiDAR coverage here. Outside the mapped area there is '
        + 'nothing to draw, which is different from flat ground.');
      terrainOn = false;
      return;
    }
    TERRAIN = body;
    terrainImage = buildTerrainImage(body);
    terrainOn = true;
    mapEl.classList.add('terrain-on');
    const st = body.stats, c = body.contours;
    // The exaggeration is stated, deliberately. A hillshade stretched 23x is a
    // diagram, and a reader who thinks it is a photograph will read these as
    // real hills. On ground this flat, saying so is the honest part.
    const F = body.features;
    const flat = st.medianSlopeDeg < 2;
    terrainNote(
      '<b>' + st.reliefFt + ' ft</b> of relief here (' + st.minFt + '\u2013' + st.maxFt + ' ft). '
      + 'Contours every <b>' + c.intervalFt + ' ft</b>. '
      + 'Median slope <b>' + st.medianSlopeDeg + '\u00b0</b>.<br>'
      + 'Hillshade exaggerated <b>' + body.hillshade.zFactor + '\u00d7</b> vertically \u2014 '
      + 'at true scale this ground would look flat.'
      + '<div class="tlegend">'
      + '<span><i style="border-color:rgba(120,190,255,.95)"></i>'
      + plural(F.drainages.length, 'draw') + '</span>'
      + '<span><i style="border-color:rgba(255,170,105,.9);border-top-style:dashed"></i>'
      + plural(F.ridges.length, 'ridge') + '</span>'
      + (F.saddles.length ? '<span>\u25c6 ' + plural(F.saddles.length, 'saddle') + '</span>' : '')
      + (F.benches.length ? '<span>\u25ac ' + plural(F.benches.length, 'bench', 'benches') + '</span>' : '')
      + '</div>'
      // Why the list is empty, rather than an empty list. A detector that finds
      // nothing and says nothing is indistinguishable from a broken one.
      + (F.quiet
        ? '<span class="warn">No saddles or benches: this ground is too gentle '
          + '(median ' + F.medianSlopeDeg + '\u00b0) for either to mean anything. '
          + 'Draws and ridges still hold \u2014 a two-foot draw still carries a trail.</span>'
        : '')
      + (flat ? '<br><span class="warn">Thermals need real slope; this ground has none.</span>' : '')
      + '<br>Loaded for this view \u2014 pan, then press Terrain again for new ground.');
  } catch (err) {
    terrainNote('Terrain unavailable: ' + err.message);
    terrainOn = false;
  } finally {
    terrainLoading = false;
    terrainBtn.textContent = 'Terrain';
    terrainBtn.classList.toggle('on', terrainOn);
    mapEl.classList.toggle('terrain-on', terrainOn);
    draw();
  }
}

terrainBtn.onclick = ev => {
  ev.stopPropagation();
  if (!D.live) return;
  // Pressing Terrain while looking at ground we have not loaded fetches it,
  // rather than switching on a hillshade of somewhere else entirely.
  if (!TERRAIN || (!terrainOn && !terrainCoversView())) return loadTerrain();
  terrainOn = !terrainOn;
  terrainBtn.classList.toggle('on', terrainOn);
  mapEl.classList.toggle('terrain-on', terrainOn);
  if (!terrainOn) terrainNote(null);
  draw();
};
if (!D.live) {
  terrainBtn.disabled = true;
  terrainBtn.title = 'Terrain needs the server';
  terrainBtn.style.opacity = '0.6';
  terrainBtn.style.cursor = 'not-allowed';
}

/** Project one ring or path into an SVG path string. */
function svgPath(points, left, top, close) {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const px = projX(points[i][0], zoom) - left;
    const py = projY(points[i][1], zoom) - top;
    d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
  }
  return d + (close ? 'Z' : '');
}

function parcelPaths(left, top) {
  if (!PARCEL_RINGS) return [];
  return PARCEL_RINGS.map(ring =>
    '<path class="parcel" d="' + svgPath(ring, left, top, true) + '"></path>');
}

/** The parcel boundary alone, when the terrain layer is off. */
function drawOverlayOnly(left, top, W, H) {
  const paths = parcelPaths(left, top);
  if (!paths.length) { contoursEl.innerHTML = ''; contoursEl.style.display = 'none'; return; }
  contoursEl.style.display = 'block';
  contoursEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  contoursEl.setAttribute('width', W);
  contoursEl.setAttribute('height', H);
  contoursEl.innerHTML = paths.join('');
}

/** Paint the hillshade and contours for the current pan and zoom. */
function drawTerrain(left, top, W, H) {
  // The parcel outline is not terrain, but it lives in the same SVG so it pans
  // and zooms with everything else. It must draw whether or not the terrain
  // layer is switched on, so it comes before that check.
  if (!terrainOn || !TERRAIN) return drawOverlayOnly(left, top, W, H);
  const b = TERRAIN.bounds;
  // Project the terrain patch's own corners, so it stays pinned to the ground
  // through every pan and zoom rather than to the screen.
  const x0 = projX(b.west, zoom) - left, x1 = projX(b.east, zoom) - left;
  const y0 = projY(b.north, zoom) - top, y1 = projY(b.south, zoom) - top;

  terrainCanvas.width = W; terrainCanvas.height = H;
  const ctx = terrainCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (terrainImage) ctx.drawImage(terrainImage, x0, y0, x1 - x0, y1 - y0);

  // Contours as one path per line. Every fifth line is drawn heavier, the way a
  // paper topo does it, so you can count elevation without reading labels.
  const step = TERRAIN.contours.intervalFt || 1;
  const parts = [];
  for (const line of TERRAIN.contours.lines) {
    let d = '';
    for (let i = 0; i < line.path.length; i++) {
      const px = projX(line.path[i][0], zoom) - left;
      const py = projY(line.path[i][1], zoom) - top;
      d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    const index = Math.round(line.levelFt / step) % 5 === 0;
    parts.push('<path class="' + (index ? 'index' : '') + '" d="' + d + '"></path>');
  }

  // Drainages and ridges on top of the contours, because they are the reading
  // of the ground rather than the ground itself.
  const F = TERRAIN.features;
  if (F) {
    const trace = (line, cls) => {
      let d = '';
      for (let i = 0; i < line.path.length; i++) {
        const px = projX(line.path[i][0], zoom) - left;
        const py = projY(line.path[i][1], zoom) - top;
        d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
      }
      parts.push('<path class="' + cls + '" d="' + d + '"></path>');
    };
    for (const r of F.ridges) trace(r, 'ridgeline');
    for (const dr of F.drainages) trace(dr, 'drain');
  }
  parts.push(...parcelPaths(left, top));
  contoursEl.style.display = 'block';
  contoursEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  contoursEl.setAttribute('width', W);
  contoursEl.setAttribute('height', H);
  contoursEl.innerHTML = parts.join('');

  // Saddles and benches are places, not lines, so they get pins.
  if (!F) return;
  for (const sd of F.saddles) {
    const m = el('div', 'tfeat saddle');
    m.style.left = (projX(sd.lng, zoom) - left) + 'px';
    m.style.top = (projY(sd.lat, zoom) - top) + 'px';
    m.title = 'Saddle \u2014 the low crossing on this ridge, about '
      + sd.reliefFt + ' ft below the high ground either side. Deer cross where it is cheapest.';
    pinsEl.appendChild(m);
  }
  for (const bn of F.benches) {
    const m = el('div', 'tfeat bench');
    m.style.left = (projX(bn.lng, zoom) - left) + 'px';
    m.style.top = (projY(bn.lat, zoom) - top) + 'px';
    m.title = 'Bench \u2014 a flat shelf (' + bn.slopeDeg + '\u00b0) with '
      + bn.steepAround + '% steeper ground around it. Deer bed on these and travel along them.';
    pinsEl.appendChild(m);
  }
}

// ---- stands -----------------------------------------------------------
let STANDS = D.stands || [];
let placing = false;
let editing = null;

const WINDS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const TYPES = [['stand','Ladder / hang-on'],['tripod','Tripod'],['ground-blind','Ground blind'],
               ['box-blind','Box blind'],['saddle','Saddle'],['other','Other']];

/** Screen pixel -> coordinates. The inverse of projX/projY, used when a click
 *  on the map has to become a real position for a new pin. */
function pixelToLatLng(px, py) {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const n = TS * 2 ** zoom;
  const cx = projX(centre.lng, zoom) - W / 2 + px;
  const cy = projY(centre.lat, zoom) - H / 2 + py;
  return {
    lng: cx / n * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / n))) * 180 / Math.PI,
  };
}

// ---- who owns this ----------------------------------------------------
let identifying = false;
const ownBtn = document.getElementById('whoOwns');

// Two different things, and conflating them cost an afternoon: REPLACING the
// card (which showParcelCard does on every lookup) must leave the boundary
// alone, while DISMISSING it should take the boundary with it. When close did
// both, every lookup drew the outline and then immediately wiped it, because
// showParcelCard opens by clearing whatever card is already there.
function removeParcelCard() { document.querySelector('.parcelcard')?.remove(); }

function closeParcelCard() {
  removeParcelCard();
  // A red outline left on the map with nothing explaining it reads as a
  // permanent property line, so the two go together.
  if (PARCEL_RINGS) { PARCEL_RINGS = null; draw(); }
}

function showParcelCard(title, rows, note) {
  removeParcelCard();
  const card = el('div', 'parcelcard');
  const x = document.createElement('button');
  x.className = 'close'; x.textContent = '\u00d7'; x.title = 'Close';
  x.onclick = closeParcelCard;
  card.appendChild(x);
  card.appendChild(el('h4', null, title));
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '') continue;
    const r = el('div', 'row');
    r.append(el('span', null, k), el('b', null, String(v)));
    card.appendChild(r);
  }
  if (note) card.appendChild(el('div', 'hint', note));
  mapEl.appendChild(card);
}

async function lookupParcel(lat, lng) {
  showParcelCard('Looking up\u2026', [], null);
  try {
    const res = await fetch('/api/parcel?lat=' + lat + '&lng=' + lng);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'lookup failed');
    if (!body.found) {
      PARCEL_RINGS = null;
      draw();
      return showParcelCard('No parcel here', [],
        'Wisconsin parcels only. Outside the state, or on water, there is nothing to look up.');
    }
    const p = body.parcel;
    PARCEL_RINGS = p.rings || null;
    draw();
    showParcelCard(p.owner || 'Owner not recorded', [
      ['Acres', p.acres],
      ['Class', p.propClassName || p.propClass],
      ['County', p.county],
      ['Parcel ID', p.parcelId],
      ['Mailing address', p.mailingAddress],
      ['School district', p.schoolDistrict],
    ], 'Public record from the Wisconsin statewide parcel map.');
  } catch (err) {
    showParcelCard('Lookup failed', [['Reason', err.message]],
      'The parcel service may be down; the rest of the map is unaffected.');
  }
}

if (!D.live) {
  ownBtn.disabled = true;
  ownBtn.title = 'Ownership lookup needs the server';
  ownBtn.style.opacity = '0.6';
  ownBtn.style.cursor = 'not-allowed';
} else {
  ownBtn.onclick = ev => {
    ev.stopPropagation();
    identifying = !identifying;
    if (identifying && placing) addBtn.onclick(new Event('click'));
    ownBtn.classList.toggle('on', identifying);
    ownBtn.textContent = identifying ? 'Click the map\u2026' : 'Who owns this?';
    mapEl.classList.toggle('placing', identifying);
  };
}

const addBtn = document.getElementById('addStand');
if (!D.live) {
  // Opened as a file rather than served. Say why the control is unavailable —
  // a button that silently does nothing is worse than one that is absent, and
  // an absent one with no explanation is a close second.
  addBtn.textContent = 'Stands need the server';
  addBtn.title = 'Run start-trailcam.cmd and open http://127.0.0.1:8787 to add stands';
  addBtn.disabled = true;
  addBtn.style.opacity = '0.6';
  addBtn.style.cursor = 'not-allowed';
} else {
  addBtn.onclick = ev => {
    ev.stopPropagation();
    placing = !placing;
    addBtn.classList.toggle('on', placing);
    addBtn.textContent = placing ? 'Click the map\u2026' : '+ Add stand';
    mapEl.classList.toggle('placing', placing);
  };
}

// Used by stands and markers alike, so it is named for what it does.
async function apiWrite(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || ('request failed: ' + res.status));
  }
  return res.status === 200 || res.status === 201 ? res.json() : null;
}

async function refreshStands() {
  STANDS = await (await fetch('/api/stands')).json();
  draw();
}

// The drop/edit form. A row with an id is an edit; {lat,lng} alone is new.
function openStandForm(stand) {
  document.querySelector('.standform')?.remove();
  editing = stand.id ? stand : null;
  const isNew = !stand.id;
  const chosen = new Set(stand.winds || []);

  const form = el('div', 'standform');
  form.appendChild(el('h3', null, isNew ? 'New stand' : 'Edit stand'));

  const name = document.createElement('input');
  name.value = stand.name || '';
  name.placeholder = 'East Ridge ladder';
  form.append(el('label', null, 'Name'), name);

  const type = document.createElement('select');
  for (const [v, labelText] of TYPES) {
    const o = document.createElement('option');
    o.value = v; o.textContent = labelText;
    if ((stand.type || 'stand') === v) o.selected = true;
    type.appendChild(o);
  }
  form.append(el('label', null, 'Type'), type);

  form.appendChild(el('label', null, 'Huntable on these winds (the wind comes FROM)'));
  const windBox = el('div', 'winds');
  for (const w of WINDS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = w;
    b.className = chosen.has(w) ? 'on' : '';
    b.onclick = () => {
      if (chosen.has(w)) chosen.delete(w); else chosen.add(w);
      b.classList.toggle('on');
    };
    windBox.appendChild(b);
  }
  form.appendChild(windBox);
  form.appendChild(el('div', 'hint',
    'Leave blank if unsure \u2014 the tool then says "unknown" rather than recommending it.'));

  const notes = document.createElement('textarea');
  notes.rows = 2; notes.value = stand.notes || '';
  form.append(el('label', null, 'Notes'), notes);

  const row = el('div', 'formrow');
  const save = document.createElement('button');
  save.className = 'primary'; save.textContent = isNew ? 'Drop pin' : 'Save';
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body = {
        name: name.value, type: type.value,
        lat: stand.lat, lng: stand.lng,
        goodWinds: [...chosen],
        notes: notes.value || null,
      };
      if (isNew) await apiWrite('POST', '/api/stands', body);
      else await apiWrite('PATCH', '/api/stands/' + stand.id, body);
      form.remove(); editing = null;
      await refreshStands();
    } catch (err) {
      save.disabled = false;
      let e = form.querySelector('.stale-note');
      if (!e) { e = el('div', 'stale-note'); form.appendChild(e); }
      e.textContent = err.message;
    }
  };
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { form.remove(); editing = null; draw(); };
  row.append(save, cancel);

  if (!isNew) {
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete ' + stand.name + '?')) return;
      await apiWrite('DELETE', '/api/stands/' + stand.id);
      form.remove(); editing = null;
      await refreshStands();
    };
    row.appendChild(del);
  }
  form.appendChild(row);
  mapEl.appendChild(form);
  name.focus();
  draw();
}

// ---- map type control -------------------------------------------------
const layersEl = document.querySelector('.layers');
const toggleEl = document.getElementById('layerToggle');
const menuEl = document.getElementById('layerMenu');
const creditEl = document.getElementById('credit');

// Each swatch previews a real tile from that layer over the cameras, so the
// buttons look like where you actually hunt rather than a generic icon.
const previewTile = key => {
  const L = LAYERS[key];
  const z = Math.min(14, L.maxZoom);
  const n = 2 ** z;
  const x = Math.floor((centre.lng + 180) / 360 * n);
  const s = Math.sin(centre.lat * Math.PI / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return L.url(z, ((x % n) + n) % n, Math.max(0, Math.min(n - 1, y)));
};

function paintControl() {
  const L = LAYERS[layerKey];
  // Google shows the layer you would switch TO, not the one you are on.
  const other = LAYERS[layerKey] === LAYERS.map ? 'satellite' : 'map';
  toggleEl.style.backgroundImage = 'url("' + previewTile(other) + '")';
  document.getElementById('layerLabel').textContent = LAYERS[other].label;
  creditEl.innerHTML = [L.credit, ...[...overlayOn].map(k => OVERLAYS[k].credit)].join('. ');

  menuEl.textContent = '';
  for (const [key, def] of Object.entries(LAYERS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = key === layerKey ? 'on' : '';
    b.style.backgroundImage = 'url("' + previewTile(key) + '")';
    b.title = def.label;
    b.appendChild(el('span', null, def.label));
    b.onclick = ev => {
      ev.stopPropagation();
      layerKey = key; saveLayer(key);
      if (zoom > LAYERS[key].maxZoom) zoom = LAYERS[key].maxZoom;
      layersEl.classList.remove('open');
      paintControl(); draw();
    };
    menuEl.appendChild(b);
  }

  // Overlays are checkboxes rather than a choice: they stack on any base map,
  // and several can be on at once.
  const sep = el('div', 'ovsep', 'Overlays \u2014 Wisconsin DNR');
  menuEl.appendChild(sep);
  for (const [key, def] of Object.entries(OVERLAYS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ovbtn' + (overlayOn.has(key) ? ' on' : '');
    b.title = def.note;
    b.textContent = (overlayOn.has(key) ? '\u2611 ' : '\u2610 ') + def.label;
    b.onclick = ev => {
      ev.stopPropagation();
      if (overlayOn.has(key)) overlayOn.delete(key); else overlayOn.add(key);
      saveOverlays();
      paintControl(); draw();
    };
    menuEl.appendChild(b);
  }
}

toggleEl.onclick = e => { e.stopPropagation(); layersEl.classList.add('open'); };
layersEl.onmouseenter = () => layersEl.classList.add('open');
layersEl.onmouseleave = () => layersEl.classList.remove('open');
document.addEventListener('click', () => layersEl.classList.remove('open'));

/**
 * Is this event on the map GROUND, rather than on something laid over it?
 *
 * Every control here — toolbar, zoom, layer switcher, stand form, parcel card,
 * pins — is a child of #map, so both the click handler and the drag handler
 * below have to tell "clicked the ground" from "pressed a button".
 *
 * This whitelists the background on purpose. It replaced two separate
 * blacklists that had drifted: the drag handler still excluded only .zoom and
 * .layers, so a pointerdown on any newer control started a map drag AND called
 * setPointerCapture — which retargets the following click to #map. The button
 * never received its own click, so "+ Add stand" and "Who owns this?" both did
 * nothing, the stand form could not be typed into, and a stand pin could not
 * be reopened. A whitelist cannot rot that way: a control added tomorrow is
 * excluded by default rather than by someone remembering to add it.
 */
const onMapGround = t =>
  t === mapEl || t === tilesEl || t === pinsEl || !!t.closest('#tiles');

mapEl.addEventListener('click', e => {
  if (!onMapGround(e.target)) return;
  if (identifying) {
    const r0 = mapEl.getBoundingClientRect();
    const ix = e.clientX - r0.left, iy = e.clientY - r0.top;
    if (ix < 0 || iy < 0 || ix > r0.width || iy > r0.height) return;
    const at0 = pixelToLatLng(ix, iy);
    identifying = false;
    ownBtn.classList.remove('on');
    ownBtn.textContent = 'Who owns this?';
    mapEl.classList.remove('placing');
    lookupParcel(at0.lat, at0.lng);
    return;
  }
  if (marking) {
    const rm = mapEl.getBoundingClientRect();
    const mx = e.clientX - rm.left, my = e.clientY - rm.top;
    if (mx < 0 || my < 0 || mx > rm.width || my > rm.height) return;
    const at = pixelToLatLng(mx, my);
    marking = false;
    markBtn.classList.remove('on');
    markBtn.textContent = '+ Mark sign';
    mapEl.classList.remove('placing');
    openMarkerForm({ lat: at.lat, lng: at.lng });
    return;
  }
  if (!placing) return;
  const r = mapEl.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (px < 0 || py < 0 || px > r.width || py > r.height) return;
  const at = pixelToLatLng(px, py);
  placing = false;
  addBtn.classList.remove('on');
  addBtn.textContent = '+ Add stand';
  mapEl.classList.remove('placing');
  openStandForm({ lat: at.lat, lng: at.lng });
});

let drag = null;
mapEl.addEventListener('pointerdown', e => {
  // Same test as the click handler, deliberately: pressing a control must not
  // start a drag, and must not capture the pointer away from that control.
  if (!onMapGround(e.target)) return;
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
// Each layer has its own deepest usable zoom — USGS topo stops well short of
// the imagery — so clamp against the active layer rather than a fixed 19,
// otherwise zooming in past coverage silently paints blank tiles.
const setZoom = z => {
  zoom = Math.max(2, Math.min(LAYERS[layerKey].maxZoom, z));
  draw();
};
document.getElementById('zin').onclick = () => setZoom(zoom + 1);
document.getElementById('zout').onclick = () => setZoom(zoom - 1);
mapEl.addEventListener('wheel', e => {
  e.preventDefault();
  setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });
addEventListener('resize', draw);
if (located.length) { paintControl(); draw(); }
else mapEl.innerHTML = '<div style="padding:20px;color:#888">No camera reported GPS coordinates.</div>';

// ---- camera cards -----------------------------------------------------
const MIXED_BRANDS = new Set(D.cameras.map(c => c.provider).filter(Boolean)).size > 1;
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
  // Name the brand only when more than one is present. On a single-brand
  // account it would be the same word on every card, which is just noise.
  const brand = MIXED_BRANDS && c.provider
    ? c.provider.charAt(0).toUpperCase() + c.provider.slice(1) : null;
  card.appendChild(el('div', 'model',
    [brand, c.model, c.signalType].filter(Boolean).join(' \u00b7 ') || '\u2014'));

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
    // A plan written by an older version of the planner, or edited by hand, may
    // not carry the reason breakdown. Missing reasons should cost you the
    // reasons, not the whole page — this threw and blanked everything below it.
    for (const p of s.parts ?? []) {
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
  // Everything brand-specific now lives behind a provider, so adding a camera
  // make means writing providers/<id>.mjs, not touching this file.
  let provider;
  try {
    provider = getProvider(OPT.provider);
  } catch (err) {
    die(err.message);
  }
  const { email, password } = credentialsFor(provider);
  const P = provider.envPrefix;
  if (!email || !password) {
    die(`${P}_EMAIL and ${P}_PASSWORD must be set (never hardcode them).
  PowerShell:  $env:${P}_EMAIL = "you@example.com"; $env:${P}_PASSWORD = "..."
  cmd:         set ${P}_EMAIL=you@example.com
  bash:        export ${P}_EMAIL=you@example.com

  Or just double-click start-trailcam.cmd, which asks for them.`);
  }

  log(`Logging in to ${provider.label} as ${email} ...`);
  let session;
  try {
    session = await provider.login(email, password);
  } catch (err) {
    // Providers flag a credential rejection so the message stays specific
    // without this file knowing any provider's status codes.
    if (err.credentials) die(err.message);
    throw err;
  }

  const cameras = await provider.cameras(session);
  log(`${cameras.length} ${provider.label} camera(s) on the account.`);

  if (OPT.inspect) {
    dumpPaths('camera[0] raw fields', cameras[0]);
    // An empty photo list is ambiguous on its own: it could mean the account
    // genuinely holds no photos, or that this query is shaped wrong. Dump the
    // response envelope for EVERY camera so the two can be told apart.
    for (const cam of cameras) {
      const label = provider.normalizeCamera(cam).name;
      if (!cam?.id) continue;
      const { photos, raw: page } = await provider.photos(session, cam.id, FUTURE, OPT.limit);
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

  const rows = cameras.map(c => ({ ...provider.normalizeCamera(c), provider: provider.id }));
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

  // The database is the system of record from here on; the flat files below are
  // still written so nothing that reads them breaks mid-migration. A dry run
  // touches neither.
  let db = null;
  if (!OPT.dryRun) {
    await fs.mkdir(OPT.out, { recursive: true });
    try {
      db = openDb(OPT.out);
      for (let i = 0; i < rows.length; i++) {
        upsertCamera(db, rows[i], {
          provider: provider.id,
          accountLabel: OPT.account,
          raw: cameras[i],
        });
      }
    } catch (err) {
      // A store failure must not cost the sync: the photos and the dashboard are
      // the point, and the database can be rebuilt from the next run.
      warn(`  could not open the database (${err.message}) — continuing without it`);
      db = null;
    }

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
      const { photos } = await provider.photos(session, cam.id, dateEnd, OPT.limit);
      pages++;
      if (photos.length === 0) break;
      let oldest = null;
      for (const p of photos) {
        const d = provider.photoDate(p);
        if (d && (oldest === null || Date.parse(d) < Date.parse(oldest))) oldest = d;
        const id = provider.photoId(p);
        if (!id || seen.has(id)) continue;
        const url = provider.photoUrl(p, OPT.size);
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
        const tags = provider.photoTags(p);
        if (db) {
          try {
            const stored = upsertPhoto(db, {
              provider: provider.id, cameraId: cam.id, nativeId: id,
              takenAt: d, filePath: OPT.dryRun ? null : rel, url, raw: p,
            });
            // The vendor's species tag is recorded as an UNCONFIRMED machine
            // claim, never as an observation. A person confirming it later is
            // what turns it into evidence.
            for (const tag of tags) {
              addDetection(db, {
                photoId: stored.id, species: String(tag).toLowerCase(),
                source: 'camera-ai', confirmed: false,
              });
            }
          } catch (err) {
            warn(`  ${cam.name}: could not record photo ${id} (${err.message})`);
          }
        }
        meta.push(JSON.stringify({
          id, camera: cam.id, cameraName: cam.name, date: d,
          tags, url,
          provider: provider.id, file: rel,
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

  if (db) {
    const c = counts(db);
    log(`Store: ${c.cameras} camera(s), ${c.photos} photo(s), ${c.detections} detection(s), `
      + `${c.bucks} buck(s), ${c.weatherHours} weather hour(s).`);
    db.close();
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
