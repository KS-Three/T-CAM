// The doctor's value is that its verdict can be trusted, so the tests that
// matter are the ones about what it REFUSES to conclude. An earlier version
// passed a decoder suite while telling the truth about none of the cases
// below: it called NaN "(agrees)", read a missing coordinate as Null Island
// and advised a sync that would have erased the last good fix, blamed the
// picked fix for an older one's bad encoding, and called a correct geohash a
// contradiction six times in ten.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dms, geohashCell, cellContains } from '../gps-doctor.mjs';
import { openDb, upsertCamera, distanceM } from '../db.mjs';
import { cameraSummary } from '../providers/spypoint.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCTOR = path.join(HERE, '..', 'gps-doctor.mjs');

// ---- the decoders -------------------------------------------------------

test('DMS decodes to the same point the GeoJSON array carries', () => {
  const fix = FLEX_M.status.coordinates[0];
  const [lng, lat] = fix.position.coordinates;
  assert.equal(dms(fix.latitude), lat);
  assert.equal(dms(fix.longitude), lng);
});

test('south and west come back negative', () => {
  assert.equal(dms('S44 7.407360'), -44.123456);
  assert.equal(dms('E90 39.259260'), 90.654321);
});

test('a malformed minutes field is null, never NaN', () => {
  // NaN is the dangerous answer: it survives a `!== null` guard and then loses
  // every comparison, so the tool prints "(agrees)" about a broken field.
  for (const bad of ['N44 7.40.7360', 'N44 .', 'N44 7..4', 'N44 ', '', null,
    undefined, 'not a fix', '44.123456', 'Q44 7.4']) {
    const got = dms(bad);
    assert.equal(got, null, `${JSON.stringify(bad)} -> ${got}`);
    assert.ok(!Number.isNaN(got), 'must not be NaN');
  }
});

test('out-of-range degrees and minutes are refused, not rolled over', () => {
  assert.equal(dms('N44 90.0'), null, '90 minutes must not become 1.5 degrees');
  assert.equal(dms('N44 60.0'), null);
  assert.equal(dms('N999 0'), null);
  assert.equal(dms('N91 0'), null, 'latitude past the pole');
  assert.equal(dms('W181 0'), null);
  assert.equal(dms('W180 0'), -180, 'the limit itself is legal');
});

test('a geohash decodes to the cell it names, and knows what it contains', () => {
  const cell = geohashCell('ezs42');            // the spec's worked example
  assert.ok(Math.abs(cell.lat - 42.6) < 0.05, 'lat ' + cell.lat);
  assert.ok(Math.abs(cell.lng - -5.6) < 0.05, 'lng ' + cell.lng);
  assert.ok(cellContains(cell, { lat: cell.lat, lng: cell.lng }));
  assert.ok(!cellContains(cell, { lat: 44.12, lng: -90.65 }));
});

test('a correct short geohash CONTAINS its point, however far the centre is', () => {
  // The bug this replaced: a fixed 250 m threshold against the cell CENTRE
  // called a correct 5- or 6-character hash a contradiction, and the verdict
  // then advised switching the normalizer to the coarser encoding.
  const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  const encode = (lat, lng, len) => {
    let idx = 0, bit = 0, even = true, hash = '';
    let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
    while (hash.length < len) {
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (lng >= mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx *= 2; lngMax = mid; }
      } else {
        const mid = (latMin + latMax) / 2;
        if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx *= 2; latMax = mid; }
      }
      even = !even;
      if (++bit === 5) { hash += B32[idx]; bit = 0; idx = 0; }
    }
    return hash;
  };
  let farFromCentre = 0;
  for (let i = 0; i < 500; i++) {
    const p = { lat: 44.12 + (Math.random() - 0.5) * 0.02,
      lng: -90.65 + (Math.random() - 0.5) * 0.02 };
    for (const len of [5, 6, 7]) {
      const cell = geohashCell(encode(p.lat, p.lng, len));
      assert.ok(cellContains(cell, p), `len ${len} must contain its own point`);
      if (distanceM(cell.lat, cell.lng, p.lat, p.lng) > 250) farFromCentre++;
    }
  }
  assert.ok(farFromCentre > 0,
    'the centre really is often >250 m away — which is why containment is the test');
});

test('a non-string geohash is refused rather than coerced', () => {
  // /re/.test(true) coerces to "true", whose letters are all in the alphabet,
  // so an unguarded decoder answered with a cell in Kazakhstan.
  for (const bad of [true, 123, ['ezs42'], {}, '', null, undefined, 'has-a-dash']) {
    assert.equal(geohashCell(bad), null, JSON.stringify(bad));
  }
});

// ---- the verdict --------------------------------------------------------

/** Build an output dir holding one camera document and one stored row. */
function plant({ fixes, rowLat, rowLng, rowFix, name = 'Fremont North', omitRow = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpsdoc-'));
  const doc = structuredClone(FLEX_M);
  doc.config.name = name;
  doc.status.coordinates = fixes;
  fs.writeFileSync(path.join(dir, 'cameras.raw.json'), JSON.stringify([doc]));
  const db = openDb(dir);
  if (!omitRow) {
    const summary = cameraSummary(doc);
    upsertCamera(db, { ...summary, lat: rowLat, lng: rowLng,
      gpsFix: rowFix === undefined ? summary.gpsFix : rowFix }, { provider: 'spypoint' });
  }
  db.close();
  return dir;
}
const run = dir => execFileSync(process.execPath, [DOCTOR, '--out', dir], { encoding: 'utf8' });

const FIX = (dateTime, lat, lng, extra = {}) => ({
  dateTime, position: { type: 'Point', coordinates: [lng, lat] }, ...extra });

test('a document with no position never advises a sync that would erase the row', () => {
  const dir = plant({ fixes: [], rowLat: 44.123456, rowLng: -90.654321 });
  const out = run(dir);
  assert.match(out, /current document carries NO position/);
  assert.match(out, /Do NOT re-sync/);
  assert.doesNotMatch(out, /DATABASE is the older/);
  // The old failure: null coerced to 0 and produced a Null Island drift.
  assert.doesNotMatch(out, /11,001,466|11001466/);
});

test('a camera with no position anywhere is said to have none, not to match', () => {
  const dir = plant({ fixes: [], rowLat: null, rowLng: null });
  const out = run(dir);
  assert.match(out, /no position anywhere/);
  assert.doesNotMatch(out, /stored it faithfully/);
});

test('same fix, different position: the row was written by an older rule', () => {
  // The likeliest real case, and the shape the coordinates[0] bug left behind:
  // both sides name one fix and disagree about where it is. Re-syncing heals it.
  const dir = plant({ fixes: [FIX('2026-08-30T12:00:00.000Z', 44.123456, -90.654321)],
    rowLat: 44.113, rowLng: -90.641 });
  const out = run(dir);
  assert.match(out, /SAME fix but disagree/);
  assert.match(out, /re-run the sync/);
  assert.match(out, new RegExp('--out ' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the remedy must target the directory we diagnosed');
});

test('a document carrying a newer fix means the database is behind', () => {
  const dir = plant({ fixes: [FIX('2026-08-30T12:00:00.000Z', 44.123456, -90.654321)],
    rowLat: 44.113, rowLng: -90.641, rowFix: '2026-06-01T12:00:00.000Z' });
  const out = run(dir);
  assert.match(out, /DATABASE is behind/);
  assert.doesNotMatch(out, /RAW FILE is behind/);
});

test('a row carrying a newer fix means the dump is behind, not the database', () => {
  // Decided on the fix dates, not file mtimes: sync writes the rows and the
  // dump milliseconds apart, so mtime ordering is noise, not evidence.
  const dir = plant({ fixes: [FIX('2026-06-01T12:00:00.000Z', 44.113, -90.641)],
    rowLat: 44.123456, rowLng: -90.654321, rowFix: '2026-08-30T12:00:00.000Z' });
  const out = run(dir);
  assert.match(out, /RAW FILE is behind/);
  assert.doesNotMatch(out, /DATABASE is behind/);
});

test('an older fix’s bad encoding is never charged to the picked fix', () => {
  const dir = plant({
    fixes: [
      // Not picked, and its DMS is far from its own point.
      FIX('2025-01-01T00:00:00.000Z', 44.12, -90.65,
        { latitude: 'N44 30.000000', longitude: 'W90 39.000000' }),
      // Picked, and entirely self-consistent.
      FIX('2026-08-30T12:00:00.000Z', 44.123456, -90.654321,
        { latitude: 'N44 7.407360', longitude: 'W90 39.259260' }),
    ],
    rowLat: 44.123456, rowLng: -90.654321,
  });
  const out = run(dir);
  assert.match(out, /DISAGREES/, 'the older fix is still reported in the listing');
  assert.doesNotMatch(out, /PICKED fix’s DMS copy/,
    'but the verdict must not blame the fix that agrees');
  assert.match(out, /geohash copies agree with it|Nothing here explains/);
});

test('all-undated fixes get a caution, not a clean bill', () => {
  const dir = plant({
    fixes: [{ position: { type: 'Point', coordinates: [-90.641, 44.113] } },
      { position: { type: 'Point', coordinates: [-90.6555, 44.1245] } }],
    rowLat: 44.113, rowLng: -90.641,
  });
  const out = run(dir);
  assert.match(out, /not one fix carries a dateTime/);
  assert.doesNotMatch(out, /We picked the newest fix, stored it faithfully/);
});

test('an unreadable DMS pair is said to be unreadable, never silently skipped', () => {
  const dir = plant({
    fixes: [FIX('2026-08-30T12:00:00.000Z', 44.123456, -90.654321,
      { latitude: 'N44 7.40.7360', longitude: 'W90 39.259260' })],
    rowLat: 44.123456, rowLng: -90.654321,
  });
  const out = run(dir);
  assert.match(out, /UNREADABLE/);
  assert.doesNotMatch(out, /\(agrees\)/);
});

test('it opens read-only, and refuses a directory with no database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpsdoc-'));
  fs.writeFileSync(path.join(dir, 'cameras.raw.json'), JSON.stringify([FLEX_M]));
  assert.throws(() => run(dir), /./);
  assert.equal(fs.existsSync(path.join(dir, 'trailcam.db')), false,
    'a diagnostic must not create the database it claims to inspect');
});

test('a trailing flag falls back to the default instead of throwing', () => {
  // `--out` with nothing after it used to reach path.resolve(undefined) and
  // die with a Node stack trace, from the one tool a person runs when they are
  // already confused about where their data is.
  let stderr = '';
  try {
    execFileSync(process.execPath, [DOCTOR, '--out'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    stderr = String(err.stderr ?? '');
  }
  assert.doesNotMatch(stderr, /ERR_INVALID_ARG_TYPE/);
  assert.match(stderr, /Run a sync first|could not read/,
    'it should explain itself, not throw');
});
