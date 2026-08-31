#!/usr/bin/env node
/**
 * gps-doctor.mjs - why is a camera's pin in the wrong place?
 *
 * Compares three things for one camera and names which pair disagrees:
 *   1. every GPS fix SpyPoint sent, from cameras.raw.json (last sync)
 *   2. which one the normalizer picks
 *   3. what the database holds, which is what the map draws
 *
 * It also decodes the two encodings we never normally read. Each fix carries
 * its position three ways - the GeoJSON array we use, a pair of DMS strings,
 * and a geohash - and nothing else checks that they agree.
 *
 * Opened read-only, and it reads the file the last sync left, so it needs no
 * credentials, never migrates the schema, and cannot alter a byte of your data.
 * (SQLite still lays down its usual -wal/-shm sidecars beside a WAL database
 * while reading it; that is the price of an open that stays correct when the
 * server or a sync holds the file at the same time - see the note above the
 * open below.)
 *
 *   node gps-doctor.mjs --out spypoint-data --camera "Fremont North"
 *
 * THE RULE THIS TOOL LIVES BY: never compare two numbers without first
 * establishing that both are real. A missing coordinate is unknown, not zero -
 * db.mjs's distanceM coerces null to 0, so an unguarded comparison against a
 * missing fix reports a confident 11,000,000 yd drift from Null Island and
 * advises a re-sync that would overwrite the last good position with NULL.
 * Every comparison below is guarded, and refuses out loud rather than
 * inventing a disagreement for the next session to chase.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, distanceM } from './db.mjs';
import { M_PER_YARD } from './measure.mjs';
import { cameraSummary, newestBy } from './providers/spypoint.mjs';

/** A point, or null if either half is not a real number. Never a half-point. */
const pt = (lat, lng) =>
  (Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);

/** Metres apart, or null if either point is unknown. */
const apart = (a, b) => (a && b ? distanceM(a.lat, a.lng, b.lat, b.lng) : null);

const yd = m => Math.round(m / M_PER_YARD).toLocaleString('en-US');

/**
 * "N44 7.407360" - hemisphere, whole degrees, decimal minutes.
 *
 * Returns null for anything it cannot read as a real position. The earlier
 * version accepted [\d.]+ for the minutes, so "N44 7.40.7360" parsed to NaN,
 * passed a `!== null` guard, and then printed "(agrees)" because NaN > 25 is
 * false - exonerating the one field that was broken. Minutes must be < 60 and
 * the degrees in range, or a truncated string silently rolls into a
 * plausible-looking number.
 */
export const dms = str => {
  const m = /^([NSEW])\s*(\d{1,3})\s+(\d{1,3}(?:\.\d+)?)$/.exec(String(str ?? '').trim());
  if (!m) return null;
  const [, hemi, degStr, minStr] = m;
  const minutes = Number(minStr);
  if (!(minutes < 60)) return null;
  const deg = Number(degStr) + minutes / 60;
  const limit = (hemi === 'N' || hemi === 'S') ? 90 : 180;
  if (!Number.isFinite(deg) || deg > limit) return null;
  return (hemi === 'S' || hemi === 'W') ? -deg : deg;
};

const GEO32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Decode a geohash to the CELL it names, bounds and all.
 *
 * A geohash is a rectangle, not a point, and its size depends on its length:
 * at latitude 44 a 6-character cell is about 610 x 880 m and a 5-character one
 * about 4.9 x 3.5 km. Comparing a point to the cell's CENTRE against a fixed
 * 250 m threshold therefore called a perfectly consistent document a
 * contradiction 59% of the time at six characters, and effectively always at
 * five. Return the bounds so the caller can ask the only question that means
 * anything: does the point fall inside the cell?
 */
export const geohashCell = hash => {
  if (typeof hash !== 'string' || !hash.length) return null;
  let evenBit = true, latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  for (const ch of hash.toLowerCase()) {
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
  return { latMin, latMax, lngMin, lngMax,
    lat: (latMin + latMax) / 2, lng: (lngMin + lngMax) / 2 };
};

/** Does the cell the hash names contain this point? */
export const cellContains = (cell, p) => !!cell && !!p
  && p.lat >= cell.latMin && p.lat <= cell.latMax
  && p.lng >= cell.lngMin && p.lng <= cell.lngMax;

/**
 * The position of one fix, by the SAME rule cameraSummary uses: a GeoJSON
 * [lng, lat] of two finite numbers, or nothing. Printing a fix the normalizer
 * refused (string coordinates, an empty array) as though it were usable is how
 * the tool ends up blaming the picker for a document the picker read correctly.
 */
const fixPoint = fix => {
  const c = fix?.position?.coordinates;
  return Array.isArray(c) ? pt(c[1], c[0]) : null;
};

function main() {
  const argv = process.argv.slice(2);
  const val = (f, d) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
  };
  const OUT = path.resolve(val('--out', process.env.SPYPOINT_OUT || './spypoint-data'));
  const WANT = val('--camera', null);
  const want = WANT?.toLowerCase() ?? null;

  const rawFile = path.join(OUT, 'cameras.raw.json');
  let raw, mtime;
  try {
    raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    mtime = fs.statSync(rawFile).mtime;
  } catch (err) {
    console.error(`could not read ${rawFile}\n  ${err.message}`);
    console.error('  Run a sync first:  node spypoint-sync.mjs'
      + (OUT === path.resolve('./spypoint-data') ? '' : ` --out ${OUT}`));
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error(`${rawFile} is not a list of cameras (found ${typeof raw}).`);
    console.error('  It should be the array the sync writes. Re-run the sync.');
    process.exit(1);
  }

  // Match on the resolved name the rest of the program uses, and on the id,
  // the way spypoint-sync.mjs's --cameras does. A document with no
  // config.name still has an id, and is exactly the malformed shape this tool
  // exists to look at, so it must stay reachable.
  const named = raw.map(cam => ({ cam, summary: cameraSummary(cam) }));
  const cams = want
    ? named.filter(({ summary }) => summary.name.toLowerCase().includes(want)
        || summary.id.toLowerCase().includes(want))
    : named;
  if (!cams.length) {
    console.error(`no camera matching "${WANT}". Present: `
      + named.map(({ summary }) => summary.name).join(', '));
    process.exit(1);
  }

  // Read-only, and refuse rather than create: openDb() would mkdir, set WAL and
  // run every pending migration, so a mistyped --out would leave a junk
  // database behind and report that every camera had never synced - a tool
  // reached for when something already looks wrong must not mutate the evidence.
  //
  // NOT `file:...?immutable=1`, which would avoid the -wal/-shm sidecars
  // entirely: immutable promises SQLite the file cannot change underneath it,
  // and serve.mjs may well be running and writing (a stand edit, a logged sit)
  // while someone runs this. A stale or torn read from a diagnostic is worse
  // than two sidecar files.
  const dbPath = path.join(OUT, DB_FILE);
  if (!fs.existsSync(dbPath)) {
    console.error(`no ${DB_FILE} in ${OUT} - nothing to compare against.`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const rowFor = db.prepare(
      'SELECT lat, lng, gps_fix, updated_at FROM cameras WHERE id = ?');
    const RULE = '='.repeat(64);
    console.log(`raw file written ${mtime.toISOString()} `
      + `(${Math.round((Date.now() - mtime) / 36e5)}h ago)\n`);

    for (const { cam, summary } of cams) {
      const out = [RULE, summary.name, RULE, ''];
      const say = line => out.push(line);

      // 1. Every fix, in the order sent, with the other two encodings of each.
      const fixes = Array.isArray(cam?.status?.coordinates) ? cam.status.coordinates : [];
      if (!Array.isArray(cam?.status?.coordinates) && cam?.status?.coordinates != null) {
        say('status.coordinates is not a list - SpyPoint changed the shape.');
      }
      say(`status.coordinates - ${fixes.length} fix(es), in the order sent:`);
      const picked = newestBy(fixes);           // the normalizer's own rule
      const notes = new Map();                  // fix -> what disagrees on it

      fixes.forEach((f, i) => {
        const p = fixPoint(f);
        const mark = f === picked ? ' <- picked' : '';
        say(`  [${i}] ${f?.dateTime ?? '(no dateTime)'}  `
          + (p ? `lat ${p.lat}, lng ${p.lng}` : '(no usable position)') + mark);
        if (!p) return;                         // nothing to cross-check against

        const d = pt(dms(f?.latitude), dms(f?.longitude));
        if (d) {
          const off = apart(d, p);
          const bad = off > 25;
          say(`        DMS  "${f.latitude}" / "${f.longitude}" -> `
            + `lat ${d.lat.toFixed(6)}, lng ${d.lng.toFixed(6)}`
            + (bad ? `   *** DISAGREES by ${yd(off)} yd ***` : '   (agrees)'));
          if (bad) notes.set(f, { kind: 'DMS', off });
        } else if (f?.latitude != null || f?.longitude != null) {
          // Silence would read as agreement, which is the one thing this tool
          // must never imply about a field it could not read.
          say(`        DMS  "${f?.latitude}" / "${f?.longitude}" -> UNREADABLE`);
        }

        const cell = geohashCell(f?.geohash);
        if (cell) {
          const inside = cellContains(cell, p);
          say(`        hash "${f.geohash}" -> cell ${cell.latMin.toFixed(4)}..`
            + `${cell.latMax.toFixed(4)}, ${cell.lngMin.toFixed(4)}..${cell.lngMax.toFixed(4)}`
            + (inside ? '   (contains the point)'
              : `   *** DOES NOT CONTAIN the point (${yd(apart(cell, p))} yd to its centre) ***`));
          if (!inside && !notes.has(f)) notes.set(f, { kind: 'geohash', off: apart(cell, p) });
        } else if (f?.geohash != null) {
          say(`        hash "${f.geohash}" -> UNREADABLE`);
        }
      });
      if (fixes.length > 1) say('  ^ more than one fix: which one we pick decides the pin.');

      // 2. What the normalizer picks.
      const mine = pt(summary.lat, summary.lng);
      say('');
      say(`our normalizer picks:  ${mine ? `lat ${mine.lat}, lng ${mine.lng}`
        : 'NO POSITION'}   (fix ${summary.gpsFix ?? 'none'})`);

      // 3. What the database holds - this is what the map draws.
      // The primary key is "<provider>:<native id>" - db.mjs keeps the brand in
      // the key so two accounts, or two brands, can never collide. Querying
      // native_id alone is a scan that returns whichever row it reaches first.
      const row = rowFor.get(`spypoint:${summary.id}`);
      if (!row) {
        say('');
        say('NOT IN THE DATABASE - this camera has never synced to it.');
        console.log(out.join('\n') + '\n');
        continue;
      }
      const stored = pt(row.lat, row.lng);
      say(`database row (drawn): ${stored ? `lat ${stored.lat}, lng ${stored.lng}`
        : 'NO POSITION'}   (fix ${row.gps_fix ?? 'none'}, written ${row.updated_at})`);

      // ---- Verdict -------------------------------------------------------
      say('');
      say('VERDICT');
      const resync = `      node spypoint-sync.mjs --out ${OUT} --cameras "${summary.name}"`;

      if (!mine && !stored) {
        say('  This camera has no position anywhere - not in the document, not in');
        say('  the database. It has never reported a GPS fix, so it has no pin.');
        say('  Nothing here is wrong with the code; the camera has not told us.');
      } else if (!mine && stored) {
        say('  The current document carries NO position, but the row still holds one.');
        say('  The row is the only place this pin exists.');
        say('  Do NOT re-sync to fix this: upsertCamera overwrites lat/lng');
        say('  unconditionally, so it would replace the stored fix with NULL and');
        say('  the camera would vanish from the map entirely.');
      } else if (mine && !stored) {
        say('  The row has no position but the document does. A sync will write it:');
        say(resync);
      } else {
        const drift = apart(mine, stored);
        if (drift > 25) {
          // Which side is behind? Decide on the FIX DATES the two sides carry,
          // not on file mtimes: sync writes the rows and the dump milliseconds
          // apart, so their ordering is noise, and an earlier version read that
          // noise as evidence and blamed whichever side it happened to favour.
          const docFix = Date.parse(summary.gpsFix ?? '');
          const rowFix = Date.parse(row.gps_fix ?? '');
          const bothDated = Number.isFinite(docFix) && Number.isFinite(rowFix);
          say(`  The stored row and the raw file are ${yd(drift)} yd apart.`);
          if (bothDated && rowFix > docFix) {
            say('  The RAW FILE is behind: the row carries a NEWER fix than this dump.');
            say('  You are diagnosing an old download. Sync, then re-run me:');
            say(resync);
          } else if (bothDated && docFix > rowFix) {
            say('  The DATABASE is behind: the document carries a newer fix than the');
            say('  row. Re-run the sync and the pin moves:');
            say(resync);
          } else {
            // Same fix, different position: the row was written FROM this very
            // fix by code that read it differently - which is precisely what
            // the coordinates[0] bug did before 6a96bd6.
            say('  Both sides name the SAME fix but disagree about where it is, so the');
            say('  row was written from this document by an older rule. That is the');
            say('  stale-row case: re-run the sync and the pin moves.');
            say(resync);
          }
        } else {
          say(`  Stored row matches what we picked (${yd(drift)} yd apart).`);
          const note = picked ? notes.get(picked) : null;
          if (!picked) {
            say('  But NO fix was picked - there is nothing in status.coordinates.');
            say('  The coordinates above came from the normalizer’s fallback hunt for');
            say('  any field named lat/lng in the document, not from a GPS fix.');
          } else if (summary.gpsFix && picked.dateTime && summary.gpsFix !== picked.dateTime) {
            say('  But the fix we stored is not the one the picking rule chose - that');
            say('  is a picking bug in providers/spypoint.mjs.');
          } else if (!fixes.some(f => f?.dateTime)) {
            say('  CAUTION: not one fix carries a dateTime, so nothing says which is');
            say('  newest. The rule falls back to the first in the list, which may well');
            say('  be the OLD spot - exactly the shape of the last field report.');
            if (fixes.length > 1) say('  Compare the fixes listed above against where the camera actually is.');
          } else if (note) {
            say(`  But the PICKED fix’s ${note.kind} copy puts the camera ${yd(note.off)} yd away.`);
            say('  SpyPoint sent two different answers for the same fix. If the app shows');
            say(`  the ${note.kind} spot, that is the field we should be reading.`);
            say('  Tell me and I will switch the normalizer to it, and pin it in a test.');
          } else {
            say('  We picked the newest fix, stored it faithfully, and its DMS and');
            say('  geohash copies agree with it. Nothing here explains a wrong pin.');
            say('  If the SpyPoint app disagrees, this dump predates the move: sync,');
            say('  then re-run me.');
          }
        }
      }
      console.log(out.join('\n') + '\n');
    }
  } finally {
    db.close();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
