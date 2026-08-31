#!/usr/bin/env node
/**
 * gps-doctor.mjs — why is a camera's pin in the wrong place?
 *
 * Read-only. Compares three things for one camera:
 *   1. every GPS fix SpyPoint sent, from cameras.raw.json (last sync)
 *   2. which one our normalizer picks
 *   3. what is actually stored in the database, and drawn on the map
 *
 * Whichever pair disagrees names the culprit: a stale sync, a stale row, or
 * a picking bug. Needs no credentials — it reads the file the last sync left.
 *
 *   node gps-doctor.mjs --out spypoint-data --camera "Fremont North"
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, distanceM } from './db.mjs';
import { PROVIDERS } from './providers/index.mjs';


/**
 * Each fix carries its position THREE ways: a GeoJSON `position`, a pair of
 * DMS strings, and a geohash. We read `position`. If SpyPoint's own app reads
 * one of the others and they disagree, that is the whole bug — so decode all
 * three and compare rather than trusting the one we happen to use.
 */
export const dms = str => {
  // "N44 7.407360" — hemisphere, whole degrees, decimal minutes.
  const m = /^([NSEW])\s*(\d+)\s+([\d.]+)$/.exec(String(str ?? '').trim());
  if (!m) return null;
  const deg = Number(m[2]) + Number(m[3]) / 60;
  return (m[1] === 'S' || m[1] === 'W') ? -deg : deg;
};

const GEO32 = '0123456789bcdefghjkmnpqrstuvwxyz';
export const geohash = hash => {
  if (!hash || !/^[0-9bcdefghjkmnpqrstuvwxyz]+$/i.test(hash)) return null;
  let evenBit = true, latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  for (const ch of String(hash).toLowerCase()) {
    const idx = GEO32.indexOf(ch);
    if (idx === -1) return null;
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        bit ? (lngMin = mid) : (lngMax = mid);
      } else {
        const mid = (latMin + latMax) / 2;
        bit ? (latMin = mid) : (latMax = mid);
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lng: (lngMin + lngMax) / 2 };
};

import { fileURLToPath } from 'node:url';

function main() {
  const argv = process.argv.slice(2);
  const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : d; };
  const OUT = path.resolve(val('--out', process.env.SPYPOINT_OUT || './spypoint-data'));
  const WANT = val('--camera', null);

  const rawFile = path.join(OUT, 'cameras.raw.json');
  if (!fs.existsSync(rawFile)) {
    console.error(`no ${rawFile} — run a sync first.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const mtime = fs.statSync(rawFile).mtime;

  const cams = raw.filter(c => !WANT
    || (c?.config?.name ?? '').toLowerCase().includes(WANT.toLowerCase()));
  if (!cams.length) {
    console.error(`no camera matching "${WANT}". Names present: `
      + raw.map(c => c?.config?.name).join(', '));
    process.exit(1);
  }

  const db = openDb(OUT);
  const yd = m => (m * 1.09361).toFixed(0);
  console.log(`raw file written ${mtime.toISOString()} `
    + `(${Math.round((Date.now() - mtime) / 36e5)}h ago)\n`);

  for (const cam of cams) {
    const name = cam?.config?.name ?? cam?.id;
    console.log('='.repeat(64));
    console.log(name);
    console.log('='.repeat(64));

    // 1. Every fix SpyPoint sent, in array order.
    const fixes = cam?.status?.coordinates ?? [];
    console.log(`\nstatus.coordinates — ${fixes.length} fix(es), in the order sent:`);
    let disagreement = null;
    fixes.forEach((f, i) => {
      const p = f?.position?.coordinates;
      console.log(`  [${i}] ${f?.dateTime ?? '(no dateTime)'}  `
        + (Array.isArray(p) ? `lat ${p[1]}, lng ${p[0]}` : '(no position)'));

      // Cross-check the other two encodings of the SAME fix.
      if (!Array.isArray(p)) return;
      const d = { lat: dms(f?.latitude), lng: dms(f?.longitude) };
      if (d.lat !== null && d.lng !== null) {
        const off = distanceM(d.lat, d.lng, p[1], p[0]);
        console.log(`        DMS  "${f.latitude}" / "${f.longitude}" -> `
          + `lat ${d.lat.toFixed(6)}, lng ${d.lng.toFixed(6)}`
          + (off > 25 ? `   *** DISAGREES by ${yd(off)} yd ***` : '   (agrees)'));
        if (off > 25) disagreement = { kind: 'DMS', off, lat: d.lat, lng: d.lng };
      }
      const g = geohash(f?.geohash);
      if (g) {
        const off = distanceM(g.lat, g.lng, p[1], p[0]);
        console.log(`        hash "${f.geohash}" -> `
          + `lat ${g.lat.toFixed(6)}, lng ${g.lng.toFixed(6)}`
          + (off > 250 ? `   *** DISAGREES by ${yd(off)} yd ***` : '   (agrees)'));
        if (off > 250 && !disagreement) disagreement = { kind: 'geohash', off, ...g };
      }
    });
    if (fixes.length > 1) {
      console.log('  ^ more than one fix: which one we pick decides the pin.');
    }

    // 2. What the normalizer picks.
    const picked = PROVIDERS.spypoint.normalizeCamera(cam);
    console.log(`\nour normalizer picks:  lat ${picked.lat}, lng ${picked.lng}`
      + `   (fix ${picked.gpsFix ?? 'none'})`);

    // 3. What the database holds — this is what the map draws.
    const row = db.prepare(
      'SELECT lat, lng, gps_fix, updated_at FROM cameras WHERE native_id = ?').get(String(cam.id));
    if (!row) { console.log('\nNOT IN THE DATABASE — this camera has never synced to it.'); continue; }
    console.log(`database row (drawn): lat ${row.lat}, lng ${row.lng}`
      + `   (fix ${row.gps_fix ?? 'none'}, written ${row.updated_at})`);

    // Verdict.
    const drift = distanceM(picked.lat, picked.lng, row.lat, row.lng);
    console.log('\nVERDICT');
    if (drift > 25) {
      console.log(`  The stored row disagrees with the raw file by ${yd(drift)} yd.`);
      console.log('  The database is STALE — re-run the sync and the pin will move:');
      console.log(`      node spypoint-sync.mjs --cameras ${JSON.stringify(name)}`);
    } else {
      console.log(`  Stored row matches what we picked (${yd(drift)} yd apart).`);
      const newest = fixes.filter(f => Date.parse(f?.dateTime ?? ''))
        .sort((a, b) => Date.parse(b.dateTime) - Date.parse(a.dateTime))[0];
      const np = newest?.position?.coordinates;
      if (np && distanceM(np[1], np[0], picked.lat, picked.lng) > 25) {
        console.log('  But we did NOT pick the newest fix — that is a picking bug.');
      } else if (disagreement) {
        console.log(`  We picked the newest fix and stored it faithfully — BUT that`);
        console.log(`  fix's ${disagreement.kind} encoding puts the camera ${yd(disagreement.off)} yd away.`);
        console.log('  SpyPoint sent us two different answers in one document. If the app');
        console.log(`  shows the ${disagreement.kind} spot, that is the field we should be reading.`);
        console.log('  Tell me and I will switch the normalizer to it (and pin it in a test).');
      } else {
        console.log('  We picked the newest fix SpyPoint sent, and stored it faithfully.');
        console.log('  So the wrong position came from the API itself in this file.');
        console.log('  If the SpyPoint app shows it correctly, the app is reading a');
        console.log('  field this file does not carry — re-sync, then re-run me. If it');
        console.log('  still says this, send me the fix list above (dates only, not');
        console.log('  coordinates) and I will find the field we are missing.');
      }
    }
    console.log();
  }
  db.close();

}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
