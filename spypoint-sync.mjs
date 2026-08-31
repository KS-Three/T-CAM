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
import { openDb, upsertCamera, upsertPhoto, addDetection, counts, groupVisits,
  recordCameraDay } from './db.mjs';
import { cameraDayRow } from './camera-days.mjs';
import { updateVisitHeadings } from './travel.mjs';
import { quotaOf, quotaLine } from './quota.mjs';
// The dashboard is its own module now: it is a page, not a sync concern.
import {
  dashboardHtml, healthOf, fmtLoc, fmtPct, daysSince, STALE_DAYS,
} from './dashboard-page.mjs';

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

// CSV quoting and filesystem-safe names. These stayed with the sync when the
// dashboard moved out: writing files is what this half of the program does.
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
// The plan file
//
// The page itself now lives in dashboard-page.mjs. This stays because both the
// sync and the planner read it, and it is about files on disk rather than
// about the page.
// ---------------------------------------------------------------------------

const PLAN_FILE = 'plan.json';

// Missing or malformed plan.json is normal, not an error: the planner may never
// have been run. The dashboard renders an explanatory panel in that case.
async function readPlan(dir) {
  try {
    const plan = JSON.parse(await fs.readFile(path.join(dir, PLAN_FILE), 'utf8'));
    return Array.isArray(plan?.sits) ? plan : null;
  } catch { return null; }
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
  // Quota is metered PER CAMERA. This was one line reporting whichever
  // camera happened to come back first, labelled as though it were the
  // account's - so a camera sitting at 100/100 and transmitting nothing was
  // invisible behind a neighbour's 10/100. Print them all, then say plainly
  // which ones are in trouble.
  const quotas = rows.map(r => ({ r, q: quotaOf(r) })).filter(x => x.q.limit !== null);
  if (quotas.length) {
    const w = Math.max(...quotas.map(x => x.r.name.length));
    log('Photo quota this billing cycle:');
    for (const { r, q } of quotas) log(`  ${r.name.padEnd(w)}  ${quotaLine(q)}`);
    const flagged = quotas.filter(x => x.q.level !== 'ok');
    if (flagged.length) {
      warn(`\nQUOTA: ${flagged.length} of ${quotas.length} camera(s) are at or near their limit:`);
      for (const { r, q } of flagged) warn(`  ${r.name}: ${q.note}`);
      warn('A camera that has spent its allowance keeps taking photos and stops');
      warn('sending them, without reporting anything wrong. The pictures are on');
      warn('its SD card; they will not reach the cloud until the cycle turns over.\n');
    }
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
        const stored = upsertCamera(db, rows[i], {
          provider: provider.id,
          accountLabel: OPT.account,
          raw: cameras[i],
        });
        // Today's liveness, written BEFORE any photo is fetched. If the photo
        // run then fails outright, the fact that this camera was watching is
        // already recorded — and that is the half that cannot be recovered
        // afterwards, because the next sync overwrites the state it was read
        // from. The photo count is filled in below and only ever increases.
        recordCameraDay(db, cameraDayRow({ ...rows[i], id: stored.id }));
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
      'plan', 'photos_used', 'photo_limit', 'cycle_start', 'cycle_end',
      'quota_level', 'photos_per_day', 'quota_dry_on',
      'last_seen', 'days_since_seen',
    ].join(',');
    const lines = rows.map(r => { const qt = quotaOf(r); return [
      r.id, q(r.name), q(r.model), r.lat ?? '', r.lng ?? '', q(r.gpsFix),
      r.battery ?? '', q(r.batteryLevel), q(r.batterySource),
      r.signal ?? '', r.signalBars ?? '', q(r.signalLevel), q(r.signalType),
      r.tempValue ?? '', q(r.tempUnit), r.memUsed ?? '', r.memSize ?? '',
      q(r.plan), r.photoCount ?? '', r.photoLimit ?? '',
      q(r.cycleStart), q(r.cycleEnd),
      q(qt.level), qt.perDay === null ? '' : qt.perDay.toFixed(2), q(qt.dryOn),
      q(r.lastSeen), daysSince(r.lastSeen) ?? '',
    ].join(','); });
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
        // One photo, two path shapes, and they are NOT the same string:
        //
        //   - `rel` is relative to the photos/ directory. It is what the
        //     DATABASE stores, because everything reading it back — the
        //     server's /photos/ route, photoForClient, recentPhotos — resolves
        //     it against out/photos and prepends /photos/ for the browser.
        //   - `'photos/' + rel` is where the file lands on DISK, and what the
        //     STATIC dashboard.html uses as a relative <img src>, since that
        //     file sits beside the photos/ directory rather than inside it.
        //
        // The first real photos this program ever met arrived with the disk
        // shape in the database, and every image URL came out as
        // /photos/photos/... and 404d — details rendered, pictures did not.
        // Migration 11 heals rows written that way.
        const rel = [safe(cam.name), d ? safe(d.slice(0, 7)) : 'unknown-date', `${id}.jpg`].join('/');
        if (OPT.dryRun) {
          log(`  [dry] ${cam.name}  ${id}  ${d ?? 'date?'}`);
        } else {
          try {
            await download(url, path.join(OPT.out, 'photos', ...rel.split('/')));
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
          provider: provider.id, file: 'photos/' + rel,
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
    // Same row again, now that the count is known. recordCameraDay takes the
    // HIGHER photo count, so a later run that fetches nothing cannot erase
    // what arrived this morning.
    if (db) {
      const row = rows.find(r => r.id === cam.id) ?? cam;
      recordCameraDay(db, cameraDayRow(
        { ...row, id: `${provider.id}:${row.id}` }, { photos: fetched }));
    }
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
    // Group photos into visits, so the review screen has a queue the moment the
    // sync finishes. Done here rather than on demand because it must happen
    // after EVERY sync: a download that failed and got retried lands a photo
    // between two already-grouped ones, and only a regroup notices.
    if (!OPT.dryRun) {
      const g = groupVisits(db);
      log(`Visits: ${g.visits} to review from ${g.grouped} photo(s)`
        + (g.ungrouped ? `, ${g.ungrouped} without a timestamp left ungrouped` : ''));

      // Which way each animal crossed the frame, read out of the fingerprints
      // already stored. After the regroup, because a visit that just gained a
      // late-arriving photo is a different burst and reads differently.
      const h = updateVisitHeadings(db);
      log(`Direction: ${h.crossings} of ${h.of} visit(s) crossed the frame`
        + (h.noBearing ? `, ${h.noBearing} at camera(s) with no facing set` : ''));
    }

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
