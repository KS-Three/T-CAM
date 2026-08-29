import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, migrate, schemaVersion, hourKey, locationKey, upsertProperty,
  upsertCamera, upsertPhoto, addDetection, upsertBuck, upsertWeatherHour,
  weatherLocationFor, allCameras, detectionsWithWeather, counts, distanceM,
} from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M, LEGACY_SHAPE } from '../fixtures/cameras.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-test-'));
const fresh = () => openDb(tmp());
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

test('a new database migrates to the current version', () => {
  const db = fresh();
  assert.ok(schemaVersion(db) >= 1);
  assert.deepEqual(counts(db),
    { properties: 0, cameras: 0, photos: 0, detections: 0, bucks: 0, weatherHours: 0 });
});

test('migrations are idempotent — reopening does not re-apply them', () => {
  const dir = tmp();
  const a = openDb(dir);
  upsertProperty(a, 'Home 40');
  const v = schemaVersion(a);
  a.close();

  const b = openDb(dir);
  assert.equal(schemaVersion(b), v, 'version unchanged on reopen');
  assert.equal(counts(b).properties, 1, 'existing data survives');
  assert.equal(migrate(b), v, 'running migrate again is a no-op');
});

test('migration 11 heals photo paths written with the on-disk prefix', () => {
  // The first real photos ever synced landed in the database as
  // photos/Camera/2026-08/id.jpg — the on-disk shape — while every reader
  // resolves file_path against out/photos already, so each image URL doubled
  // to /photos/photos/... and 404d. The migration strips the prefix from rows
  // written before the sync was fixed; this replays that exact state.
  const dir = tmp();
  const a = openDb(dir);
  upsertCamera(a, norm(FLEX_M), { provider: 'spypoint', accountLabel: 'kent' });
  upsertPhoto(a, { provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'pfx1', takenAt: '2026-08-29T10:14:53.000Z',
    filePath: 'North_Ridge/2026-08/pfx1.jpg' });
  // Recreate the broken shape and un-record the migration, as if this database
  // had been written by the old sync and never opened since.
  a.prepare("UPDATE photos SET file_path = 'photos/' || file_path").run();
  a.prepare('DELETE FROM schema_version WHERE version = 11').run();
  a.close();

  const b = openDb(dir);
  const row = b.prepare('SELECT file_path FROM photos').get();
  assert.equal(row.file_path, 'North_Ridge/2026-08/pfx1.jpg',
    'the prefix is gone and nothing else moved');
  // And a path that never had the prefix is left alone on yet another reopen —
  // the WHERE guards it even if the migration record were lost again.
  b.prepare('DELETE FROM schema_version WHERE version = 11').run();
  b.close();
  const c = openDb(dir);
  assert.equal(c.prepare('SELECT file_path FROM photos').get().file_path,
    'North_Ridge/2026-08/pfx1.jpg');
});

test('foreign keys are enforced, not decorative', () => {
  // SQLite disables them by default; if the PRAGMA is ever dropped, orphan rows
  // would be accepted silently and the joins would quietly lose data.
  const db = fresh();
  assert.throws(
    () => addDetection(db, { photoId: 'nope:1', source: 'manual' }),
    /FOREIGN KEY/i);
});

test('hourKey truncates to the hour and rejects rubbish', () => {
  assert.equal(hourKey('2025-11-05T07:42:19.000Z'), '2025-11-05T07:00:00Z');
  assert.equal(hourKey('2025-11-05T07:00:00.000Z'), '2025-11-05T07:00:00Z');
  assert.equal(hourKey(null), null);
  assert.equal(hourKey('not a date'), null);
});

test('nearby cameras share one weather location, distant ones do not', () => {
  // Matching must be on real distance, not a rounding grid: 44.1234 and 44.1250
  // are 170 m apart but round to different cells, so a grid would split them.
  const db = fresh();
  const a = weatherLocationFor(db, 44.123456, -90.654321);
  const b = weatherLocationFor(db, 44.125000, -90.656000);
  assert.equal(b.id, a.id, 'cameras a few hundred metres apart share a location');
  assert.ok(distanceM(44.123456, -90.654321, 44.125, -90.656) < 250,
    'the two test points really are close together');

  const far = weatherLocationFor(db, 44.30, -90.65);
  assert.notEqual(far.id, a.id, 'cameras kilometres apart get their own');
  assert.equal(counts(db).weatherHours, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM weather_locations').get().n, 2);

  assert.equal(weatherLocationFor(db, null, -90.6), null, 'no coordinates, no location');
  assert.equal(weatherLocationFor(db, 44.1, undefined), null);
});

test('locationKey rejects non-coordinates and keeps stored values tidy', () => {
  assert.deepEqual(locationKey(44.1234567, -90.6543219), { lat: 44.1235, lng: -90.6543 });
  assert.equal(locationKey(null, -90.6), null);
  assert.equal(locationKey(44.1, undefined), null);
  assert.equal(locationKey(NaN, 1), null);
});

test('distanceM measures roughly correctly', () => {
  // One degree of latitude is ~111 km anywhere on earth; a good sanity check
  // that the formula is not silently returning radians or kilometres.
  assert.ok(Math.abs(distanceM(44, -90, 45, -90) - 111195) < 500);
  assert.equal(Math.round(distanceM(44, -90, 44, -90)), 0);
});

test('a camera round-trips from the provider shape with lat and lng intact', () => {
  const db = fresh();
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint', accountLabel: 'kent', raw: FLEX_M });

  assert.equal(cam.id, 'spypoint:aaaaaaaaaaaaaaaaaaaaaaaa', 'id namespaced by provider');
  assert.equal(cam.provider, 'spypoint');
  assert.equal(cam.account_label, 'kent');
  assert.equal(cam.name, 'North Ridge');
  // The ordering invariant, asserted at the storage layer too — a transposition
  // introduced anywhere between provider and disk would be caught here.
  assert.equal(cam.lat, 44.123456);
  assert.equal(cam.lng, -90.654321);
  assert.equal(cam.battery, 20);
  assert.equal(cam.signal, 100);
  assert.ok(cam.weather_location_id, 'linked to a weather location');
  assert.equal(JSON.parse(cam.raw).status.model, 'FLEX-M', 'raw document preserved');
});

test('two providers with the same native id do not collide', () => {
  const db = fresh();
  const shared = { ...norm(FLEX_M), id: 'same-id' };
  upsertCamera(db, shared, { provider: 'spypoint' });
  upsertCamera(db, { ...shared, name: 'Other Brand' }, { provider: 'moultrie' });
  assert.equal(counts(db).cameras, 2, 'namespacing keeps them separate');
});

test('re-syncing updates provider fields but keeps what a person set', () => {
  const db = fresh();
  const prop = upsertProperty(db, 'Home 40');
  const first = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });

  // A person assigns the camera to a property; the provider knows nothing of it.
  db.prepare('UPDATE cameras SET property_id = ? WHERE id = ?').run(prop.id, first.id);

  const changed = { ...norm(FLEX_M), battery: 4, name: 'North Ridge (moved)' };
  const second = upsertCamera(db, changed, { provider: 'spypoint' });

  assert.equal(second.battery, 4, 'provider data is refreshed');
  assert.equal(second.name, 'North Ridge (moved)');
  assert.equal(second.property_id, prop.id, 'the human assignment survives a re-sync');
  assert.equal(second.first_seen_at, first.first_seen_at, 'first seen is not reset');
  assert.equal(counts(db).cameras, 1, 'still one camera, not a duplicate');
});

test('a camera with no coordinates stores NULL, not zero', () => {
  // Zero is a real place in the Atlantic. Confusing "unknown" with 0,0 would put
  // a pin off the coast of Africa and quietly corrupt any distance maths.
  const db = fresh();
  const cam = upsertCamera(db, norm({ config: { name: 'No GPS' } }), { provider: 'spypoint' });
  assert.equal(cam.lat, null);
  assert.equal(cam.lng, null);
  assert.equal(cam.battery, null);
  assert.equal(cam.weather_location_id, null);
});

test('photos link to their camera and carry an hour key for the weather join', () => {
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const p = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'photo1', takenAt: '2025-11-05T07:42:19.000Z',
    url: 'https://example.invalid/a.jpg',
  });
  assert.equal(p.camera_id, 'spypoint:aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(p.hour_utc, '2025-11-05T07:00:00Z');
});

test('re-syncing a photo does not forget it was already downloaded', () => {
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const args = {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'photo1', takenAt: '2025-11-05T07:42:19.000Z',
  };
  upsertPhoto(db, { ...args, filePath: 'photos/north/a.jpg' });
  // The photo list carries no file path — that is local knowledge.
  const again = upsertPhoto(db, { ...args, url: 'https://example.invalid/new.jpg' });
  assert.equal(again.file_path, 'photos/north/a.jpg', 'the download is remembered');
  assert.equal(again.url, 'https://example.invalid/new.jpg', 'the URL still refreshes');
  assert.equal(counts(db).photos, 1);
});

test('one photo holds several animals, including two different bucks', () => {
  // The reason detections are per-animal rather than per-photo.
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const photo = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'p1', takenAt: '2025-11-05T07:42:19.000Z',
  });
  const split = upsertBuck(db, 'Split G2');
  const stickers = upsertBuck(db, 'Stickers');

  addDetection(db, { photoId: photo.id, species: 'deer', count: 2, source: 'camera-ai' });
  addDetection(db, { photoId: photo.id, species: 'buck', buckId: split.id, source: 'manual', confirmed: true });
  addDetection(db, { photoId: photo.id, species: 'buck', buckId: stickers.id, source: 'manual', confirmed: true });

  const rows = db.prepare('SELECT * FROM detections WHERE photo_id = ?').all(photo.id);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(r => r.buck_id).filter(Boolean)).size, 2,
    'two distinct bucks in one frame');
});

test('detections must declare where the claim came from', () => {
  // An unreviewed machine guess must never be indistinguishable from a human's
  // identification in the analysis.
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const photo = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'p1', takenAt: '2025-11-05T07:00:00.000Z',
  });
  assert.throws(
    () => addDetection(db, { photoId: photo.id, source: 'guessed' }),
    /CHECK/i, 'an unknown source is rejected by the schema');

  const ai = addDetection(db, { photoId: photo.id, species: 'deer', source: 'camera-ai' });
  assert.equal(ai.confirmed, 0, 'machine tags start unconfirmed');
});

test('a buck seen on two properties is still one buck', () => {
  const db = fresh();
  const home = upsertProperty(db, 'Home 40');
  const dans = upsertProperty(db, "Dan's place");

  const mine = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const his = upsertCamera(db, { ...norm(LEGACY_SHAPE), id: 'moul1' }, { provider: 'moultrie' });
  db.prepare('UPDATE cameras SET property_id = ? WHERE id = ?').run(home.id, mine.id);
  db.prepare('UPDATE cameras SET property_id = ? WHERE id = ?').run(dans.id, his.id);

  const buck = upsertBuck(db, 'Split G2');
  for (const [cam, prov, native, when] of [
    [mine, 'spypoint', 'aaaaaaaaaaaaaaaaaaaaaaaa', '2025-11-04T07:00:00.000Z'],
    [his, 'moultrie', 'moul1', '2025-11-06T17:00:00.000Z'],
  ]) {
    const p = upsertPhoto(db, { provider: prov, cameraId: native, nativeId: `${prov}-p`, takenAt: when });
    addDetection(db, { photoId: p.id, species: 'buck', buckId: buck.id, source: 'manual', confirmed: true });
  }

  const seen = db.prepare(`
    SELECT DISTINCT p.name FROM detections d
    JOIN photos ph ON ph.id = d.photo_id
    JOIN cameras c ON c.id = ph.camera_id
    JOIN properties p ON p.id = c.property_id
    WHERE d.buck_id = ?`).all(buck.id).map(r => r.name).sort();

  assert.deepEqual(seen, ["Dan's place", 'Home 40'],
    'one buck, two properties, across two camera brands');
  assert.equal(counts(db).bucks, 1);
});

test('weather is stored for quiet hours too, and joins to detections', () => {
  const db = fresh();
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const loc = weatherLocationFor(db, 44.123456, -90.654321);

  // Three consecutive hours of weather; only one of them has a photo. The other
  // two are the control group the analysis depends on.
  const hours = ['2025-11-05T06:00:00Z', '2025-11-05T07:00:00Z', '2025-11-05T08:00:00Z'];
  hours.forEach((h, i) => upsertWeatherHour(db, loc.id, h,
    { tempF: 28 + i, pressureInHg: 30.1, windMph: 9, windDir: 315, precipIn: 0, cloudPct: 40 }));

  const photo = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'p1', takenAt: '2025-11-05T07:42:19.000Z',
  });
  addDetection(db, { photoId: photo.id, species: 'buck', source: 'manual', confirmed: true });

  assert.equal(counts(db).weatherHours, 3, 'quiet hours are stored');

  const rows = detectionsWithWeather(db, { species: 'buck' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].temp_f, 29, 'joined to the 07:00 hour, not 06:00 or 08:00');
  assert.equal(rows[0].wind_dir, 315);
  assert.equal(rows[0].camera_name, 'North Ridge');

  // The comparison the WHERE analysis rests on: hours with a detection versus
  // hours without, at the same location.
  const quiet = db.prepare(`
    SELECT COUNT(*) n FROM weather_hours w
    WHERE w.location_id = ?
      AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.hour_utc = w.hour_utc)
  `).get(loc.id).n;
  assert.equal(quiet, 2, 'two hours with weather and no photos');
  assert.ok(cam.weather_location_id === loc.id, 'camera points at that location');
});

test('a detection with no weather row is kept, not silently dropped', () => {
  // A gap in the weather backfill must show as missing conditions, never as a
  // missing sighting — otherwise a backfill failure quietly deletes evidence.
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const photo = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'p1', takenAt: '2025-11-05T07:42:19.000Z',
  });
  addDetection(db, { photoId: photo.id, species: 'buck', source: 'manual' });

  const rows = detectionsWithWeather(db);
  assert.equal(rows.length, 1, 'the sighting survives');
  assert.equal(rows[0].temp_f, null, 'conditions read as unknown');
});

test('deleting a camera takes its photos and detections with it', () => {
  const db = fresh();
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const photo = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nativeId: 'p1', takenAt: '2025-11-05T07:00:00.000Z',
  });
  const buck = upsertBuck(db, 'Split G2');
  addDetection(db, { photoId: photo.id, buckId: buck.id, source: 'manual' });

  db.prepare('DELETE FROM cameras WHERE id = ?').run(cam.id);
  assert.equal(counts(db).photos, 0, 'photos cascade');
  assert.equal(counts(db).detections, 0, 'detections cascade');
  assert.equal(counts(db).bucks, 1, 'the buck itself is not deleted with a camera');
});

test('cameras list joins their property name', () => {
  const db = fresh();
  const prop = upsertProperty(db, 'Home 40');
  const cam = upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  db.prepare('UPDATE cameras SET property_id = ? WHERE id = ?').run(prop.id, cam.id);

  const rows = allCameras(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].property_name, 'Home 40');
});
