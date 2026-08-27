/**
 * db.mjs — the SQLite store, and the only file that knows SQL.
 *
 * Uses node:sqlite, built into Node 22+, so the project stays dependency-free.
 * It prints an ExperimentalWarning on import; run with
 * `--disable-warning=ExperimentalWarning` (the launcher does) so a working tool
 * doesn't look broken.
 *
 * Design decisions this schema encodes are argued in docs/design.md. The three
 * that matter most when reading it:
 *
 *   1. NULL means "not known", never zero. A camera reporting 0% battery is
 *      urgent; a camera that reports no battery figure at all is a different
 *      thing, and the health rules have to be able to tell them apart. Nothing
 *      in here invents a value to fill a gap.
 *
 *   2. Latitude and longitude are separate named columns and never a positional
 *      pair, because the ordering is the classic way to get this wrong.
 *
 *   3. Detections are per ANIMAL, not per photo, so one frame can hold two
 *      different bucks.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export const DB_FILE = 'trailcam.db';

// ---------------------------------------------------------------------------
// Migrations
//
// Applied in order, each exactly once, tracked in schema_version. Never edit a
// migration that has shipped — add another. The tool writes to a file the user
// cares about, and rewriting history in place is how that file gets corrupted.
// ---------------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up: db => {
      // A property groups cameras that sit on the same ground — "Home 40",
      // a friend's place. Bucks are deliberately NOT scoped to one: deer cross
      // property lines, and seeing that happen is the point.
      db.exec(`
        CREATE TABLE properties (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          notes       TEXT,
          created_at  TEXT NOT NULL
        );
      `);

      // Weather is stored per LOCATION, not per camera: cameras a few hundred
      // metres apart experience the same weather, so keying by camera would
      // multiply both the API calls and the rows for identical data. Coordinates
      // are rounded (see locationKey) so nearby cameras collapse onto one row.
      db.exec(`
        CREATE TABLE weather_locations (
          id      INTEGER PRIMARY KEY,
          lat     REAL NOT NULL,
          lng     REAL NOT NULL,
          UNIQUE (lat, lng)
        );
      `);

      // id is "<provider>:<native id>" so two accounts, or two brands, can never
      // collide. provider and account_label are kept separate: one person may
      // have several accounts with the same brand.
      db.exec(`
        CREATE TABLE cameras (
          id                   TEXT PRIMARY KEY,
          provider             TEXT NOT NULL,
          account_label        TEXT,
          native_id            TEXT NOT NULL,
          property_id          INTEGER REFERENCES properties(id) ON DELETE SET NULL,
          weather_location_id  INTEGER REFERENCES weather_locations(id),
          name                 TEXT NOT NULL,
          model                TEXT,
          lat                  REAL,
          lng                  REAL,
          gps_fix              TEXT,
          battery              INTEGER,
          battery_level        TEXT,
          battery_source       TEXT,
          signal               INTEGER,
          signal_bars          INTEGER,
          signal_level         TEXT,
          signal_type          TEXT,
          temp_value           REAL,
          temp_unit            TEXT,
          mem_used             INTEGER,
          mem_size             INTEGER,
          plan                 TEXT,
          photo_count          INTEGER,
          photo_limit          INTEGER,
          last_seen            TEXT,
          raw                  TEXT,
          first_seen_at        TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX cameras_property ON cameras(property_id);');
      db.exec('CREATE INDEX cameras_provider ON cameras(provider);');

      // A visit is one animal's appearance: photos from a camera clustered in
      // time. Cameras set to multiShot fire several frames per trigger, so a
      // visit is the natural unit to label once instead of per frame.
      db.exec(`
        CREATE TABLE visits (
          id          INTEGER PRIMARY KEY,
          camera_id   TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
          started_at  TEXT NOT NULL,
          ended_at    TEXT NOT NULL,
          photo_count INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.exec('CREATE INDEX visits_camera_time ON visits(camera_id, started_at);');

      // hour_utc is the join key to weather: a truncated ISO hour, denormalized
      // at insert so every "what were conditions when this was taken" query is
      // an index lookup rather than date arithmetic in SQL.
      //
      // phash is a perceptual hash used to spot near-identical frames within a
      // visit. It identifies duplicate IMAGES, never an animal.
      db.exec(`
        CREATE TABLE photos (
          id            TEXT PRIMARY KEY,
          camera_id     TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
          visit_id      INTEGER REFERENCES visits(id) ON DELETE SET NULL,
          native_id     TEXT NOT NULL,
          taken_at      TEXT,
          hour_utc      TEXT,
          file_path     TEXT,
          url           TEXT,
          phash         TEXT,
          raw           TEXT,
          downloaded_at TEXT,
          created_at    TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX photos_camera_time ON photos(camera_id, taken_at);');
      db.exec('CREATE INDEX photos_hour ON photos(hour_utc);');
      db.exec('CREATE INDEX photos_visit ON photos(visit_id);');

      // Bucks are global on purpose — a buck seen on two properties is ONE buck.
      db.exec(`
        CREATE TABLE bucks (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          notes       TEXT,
          first_seen  TEXT,
          last_seen   TEXT,
          created_at  TEXT NOT NULL
        );
      `);

      // One row per animal, so "2 does and a spike" is three rows, and two
      // different bucks in one frame are individually identifiable.
      //
      // source records where the claim came from: 'camera-ai' for the vendor's
      // own species tag, 'manual' for a human. confirmed marks that a person has
      // looked. Keeping these apart means an unreviewed machine guess is never
      // mistaken for evidence in the analysis.
      db.exec(`
        CREATE TABLE detections (
          id            INTEGER PRIMARY KEY,
          photo_id      TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
          species       TEXT,
          count         INTEGER NOT NULL DEFAULT 1,
          buck_id       INTEGER REFERENCES bucks(id) ON DELETE SET NULL,
          source        TEXT NOT NULL CHECK (source IN ('camera-ai', 'manual')),
          confirmed     INTEGER NOT NULL DEFAULT 0,
          notes         TEXT,
          created_at    TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX detections_photo ON detections(photo_id);');
      db.exec('CREATE INDEX detections_buck ON detections(buck_id);');
      db.exec('CREATE INDEX detections_species ON detections(species);');

      // Every hour for every location, whether or not anything was photographed.
      // The hours with NO detections are the control group: without them there
      // is nothing to compare active hours against, and any apparent pattern is
      // an artefact. This is why the table is filled from the weather archive
      // rather than from photo timestamps.
      db.exec(`
        CREATE TABLE weather_hours (
          location_id   INTEGER NOT NULL REFERENCES weather_locations(id) ON DELETE CASCADE,
          hour_utc      TEXT NOT NULL,
          temp_f        REAL,
          pressure_inhg REAL,
          wind_mph      REAL,
          wind_dir      REAL,
          precip_in     REAL,
          cloud_pct     REAL,
          moon_illum    REAL,
          PRIMARY KEY (location_id, hour_utc)
        );
      `);
      db.exec('CREATE INDEX weather_hour ON weather_hours(hour_utc);');
    },
  },
  {
    version: 2,
    name: 'stands',
    up: db => {
      // Where you actually sit. Cameras tell you where deer are; a stand is
      // where you can be, which is not the same place and is the thing a
      // recommendation ultimately has to name.
      //
      // good_winds is a comma-separated list of compass points on which the
      // stand is huntable — the wind carrying your scent AWAY from where deer
      // come from. It is the single most important property of a stand and
      // cannot be derived from anything the cameras report, so it is recorded
      // by hand or left null.
      db.exec(`
        CREATE TABLE stands (
          id          INTEGER PRIMARY KEY,
          property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL DEFAULT 'stand'
                        CHECK (type IN ('stand', 'tripod', 'ground-blind',
                                        'box-blind', 'saddle', 'other')),
          lat         REAL NOT NULL,
          lng         REAL NOT NULL,
          good_winds  TEXT,
          notes       TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX stands_property ON stands(property_id);');
    },
  },
  {
    version: 3,
    name: 'terrain grids',
    up: db => {
      // Cached LiDAR elevation. Fetching a 600 m square at 10 m spacing takes
      // about 25 seconds across five requests to the USGS service — far too
      // slow to repeat on every page load, and the ground does not move, so it
      // never needs fetching twice.
      //
      // Samples are stored as a raw little-endian Float32 BLOB rather than
      // JSON: a 61x61 grid is 3721 numbers, and JSON would roughly quadruple
      // the file for no gain. cols/rows/spacing are what make the blob
      // interpretable, so they live beside it rather than in a header.
      //
      // NaN in the blob means no data at that cell. That is a real state — the
      // edge of LiDAR coverage, or open water — and it must survive the round
      // trip rather than being written as 0, which is a sea-level elevation.
      db.exec(`
        CREATE TABLE terrain_grids (
          id         INTEGER PRIMARY KEY,
          west       REAL NOT NULL,
          south      REAL NOT NULL,
          d_lng      REAL NOT NULL,
          d_lat      REAL NOT NULL,
          cols       INTEGER NOT NULL,
          rows       INTEGER NOT NULL,
          spacing_m  REAL NOT NULL,
          source     TEXT NOT NULL DEFAULT 'usgs-3dep',
          fetched_at TEXT NOT NULL,
          samples    BLOB NOT NULL
        );
      `);
      db.exec('CREATE INDEX terrain_grids_at ON terrain_grids(west, south, spacing_m);');
    },
  },
  {
    version: 4,
    name: 'scouting markers',
    up: db => {
      // Sign you found on the ground: rubs, scrapes, beds, trails, food plots.
      // This is what both onX and Spartan Forge are really built around, and it
      // is the layer that turns a map into YOUR map.
      //
      // Kept separate from stands rather than folded in as another stand type.
      // A stand is somewhere you can BE, and carries winds and a structure; a
      // rub is something you SAW. Merging them would put a good_winds column on
      // a scrape and make every query about either one ambiguous.
      //
      // found_at is the important column and is why this is not just a pin
      // list. Sign is seasonal: a rub line found last November means something
      // quite different in October, and without a date the map slowly fills
      // with old news that looks current.
      db.exec(`
        CREATE TABLE markers (
          id          INTEGER PRIMARY KEY,
          property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
          kind        TEXT NOT NULL
                        CHECK (kind IN ('rub', 'scrape', 'bed', 'trail', 'food-plot',
                                        'water', 'access', 'other')),
          name        TEXT,
          lat         REAL NOT NULL,
          lng         REAL NOT NULL,
          found_at    TEXT,
          notes       TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX markers_kind ON markers(kind);');
      db.exec('CREATE INDEX markers_property ON markers(property_id);');
    },
  },
];

export const STAND_TYPES = ['stand', 'tripod', 'ground-blind', 'box-blind', 'saddle', 'other'];

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/** Truncate an ISO timestamp to its hour, the join key between photos and weather. */
export function hourKey(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 13) + ':00:00Z';
}

const isCoord = v => typeof v === 'number' && Number.isFinite(v);

/** Metres between two points. Spherical earth is ample at these distances. */
export function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Cameras closer together than this share one weather record. Beyond a couple of
// kilometres the forecast can genuinely differ (a front's edge, a lake effect);
// within it, fetching twice would be two API calls for identical numbers.
export const WEATHER_RADIUS_M = 2000;

/**
 * Coordinates rounded for storage. Rounding ALONE is not enough to group nearby
 * cameras — two points 200 m apart can fall either side of a grid boundary
 * (44.1234 rounds down, 44.1250 rounds up) and end up in different cells despite
 * being adjacent. weatherLocationFor therefore matches on real distance and uses
 * this only to keep stored values tidy.
 */
export function locationKey(lat, lng) {
  if (!isCoord(lat) || !isCoord(lng)) return null;
  return { lat: Math.round(lat * 10000) / 10000, lng: Math.round(lng * 10000) / 10000 };
}

export function openDb(dir = '.', file = DB_FILE) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, file));
  // Write-ahead logging so a reader (the dashboard) is never blocked by the
  // writer (a sync in progress); foreign keys are off by default in SQLite and
  // have to be asked for explicitly or the REFERENCES above are decorative.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT);');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Each migration is one transaction: a half-applied schema is worse than
    // none, and leaves the version counter lying about the file's shape.
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)')
        .run(m.version, nowIso(), m.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }
  return schemaVersion(db);
}

export const schemaVersion = db =>
  db.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_version').get().v;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function upsertProperty(db, name, notes = null) {
  db.prepare('INSERT OR IGNORE INTO properties (name, notes, created_at) VALUES (?, ?, ?)')
    .run(name, notes, nowIso());
  return db.prepare('SELECT * FROM properties WHERE name = ?').get(name);
}

/**
 * Find or create the weather location covering a point, matching on actual
 * distance rather than a grid cell so adjacent cameras genuinely share a record.
 * A linear scan is right here: this table holds one row per patch of ground a
 * camera sits on, so it stays in the low tens for a lifetime.
 */
export function weatherLocationFor(db, lat, lng) {
  const k = locationKey(lat, lng);
  if (!k) return null;

  let best = null;
  let bestM = Infinity;
  for (const row of db.prepare('SELECT * FROM weather_locations').all()) {
    const m = distanceM(k.lat, k.lng, row.lat, row.lng);
    if (m < bestM) { bestM = m; best = row; }
  }
  if (best && bestM <= WEATHER_RADIUS_M) return best;

  db.prepare('INSERT OR IGNORE INTO weather_locations (lat, lng) VALUES (?, ?)')
    .run(k.lat, k.lng);
  return db.prepare('SELECT * FROM weather_locations WHERE lat = ? AND lng = ?')
    .get(k.lat, k.lng);
}

/**
 * Insert or update one camera from a provider's normalized shape.
 *
 * Re-syncing must not lose anything a person set, so property_id is preserved
 * on update and first_seen_at keeps its original value. Everything the provider
 * owns is overwritten, since the provider is authoritative for it.
 */
export function upsertCamera(db, row, { provider, accountLabel = null, raw = null } = {}) {
  const id = `${provider}:${row.id}`;
  const loc = weatherLocationFor(db, row.lat, row.lng);
  const now = nowIso();
  const existing = db.prepare('SELECT id, first_seen_at, property_id FROM cameras WHERE id = ?').get(id);

  db.prepare(`
    INSERT INTO cameras (
      id, provider, account_label, native_id, property_id, weather_location_id,
      name, model, lat, lng, gps_fix, battery, battery_level, battery_source,
      signal, signal_bars, signal_level, signal_type, temp_value, temp_unit,
      mem_used, mem_size, plan, photo_count, photo_limit, last_seen, raw,
      first_seen_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      account_label = excluded.account_label,
      weather_location_id = excluded.weather_location_id,
      name = excluded.name, model = excluded.model,
      lat = excluded.lat, lng = excluded.lng, gps_fix = excluded.gps_fix,
      battery = excluded.battery, battery_level = excluded.battery_level,
      battery_source = excluded.battery_source,
      signal = excluded.signal, signal_bars = excluded.signal_bars,
      signal_level = excluded.signal_level, signal_type = excluded.signal_type,
      temp_value = excluded.temp_value, temp_unit = excluded.temp_unit,
      mem_used = excluded.mem_used, mem_size = excluded.mem_size,
      plan = excluded.plan, photo_count = excluded.photo_count,
      photo_limit = excluded.photo_limit, last_seen = excluded.last_seen,
      raw = excluded.raw, updated_at = excluded.updated_at
  `).run(
    id, provider, accountLabel, String(row.id), existing?.property_id ?? null,
    loc?.id ?? null, row.name, row.model, row.lat, row.lng, row.gpsFix,
    row.battery, row.batteryLevel, row.batterySource,
    row.signal, row.signalBars, row.signalLevel, row.signalType,
    row.tempValue, row.tempUnit, row.memUsed, row.memSize,
    row.plan, row.photoCount, row.photoLimit, row.lastSeen,
    raw ? JSON.stringify(raw) : null,
    existing?.first_seen_at ?? now, now);

  return db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
}

export function upsertPhoto(db, { provider, cameraId, nativeId, takenAt,
  filePath = null, url = null, phash = null, raw = null }) {
  const id = `${provider}:${nativeId}`;
  db.prepare(`
    INSERT INTO photos (id, camera_id, native_id, taken_at, hour_utc, file_path,
                        url, phash, raw, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      taken_at = excluded.taken_at, hour_utc = excluded.hour_utc,
      -- A downloaded file already on disk is not un-downloaded by a re-sync
      -- that happens to omit the path.
      file_path = COALESCE(excluded.file_path, photos.file_path),
      url = excluded.url,
      phash = COALESCE(excluded.phash, photos.phash),
      raw = excluded.raw
  `).run(id, `${provider}:${cameraId}`, String(nativeId), takenAt, hourKey(takenAt),
    filePath, url, phash, raw ? JSON.stringify(raw) : null, nowIso());
  return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
}

export function addDetection(db, { photoId, species = null, count = 1,
  buckId = null, source, confirmed = false, notes = null }) {
  const info = db.prepare(`
    INSERT INTO detections (photo_id, species, count, buck_id, source, confirmed, notes, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(photoId, species, count, buckId, source, confirmed ? 1 : 0, notes, nowIso());
  return db.prepare('SELECT * FROM detections WHERE id = ?').get(info.lastInsertRowid);
}

export function upsertBuck(db, name, notes = null) {
  db.prepare('INSERT OR IGNORE INTO bucks (name, notes, created_at) VALUES (?, ?, ?)')
    .run(name, notes, nowIso());
  return db.prepare('SELECT * FROM bucks WHERE name = ?').get(name);
}

export function upsertWeatherHour(db, locationId, hour, w) {
  db.prepare(`
    INSERT INTO weather_hours (location_id, hour_utc, temp_f, pressure_inhg,
                               wind_mph, wind_dir, precip_in, cloud_pct, moon_illum)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(location_id, hour_utc) DO UPDATE SET
      temp_f = excluded.temp_f, pressure_inhg = excluded.pressure_inhg,
      wind_mph = excluded.wind_mph, wind_dir = excluded.wind_dir,
      precip_in = excluded.precip_in, cloud_pct = excluded.cloud_pct,
      moon_illum = excluded.moon_illum
  `).run(locationId, hour, w.tempF ?? null, w.pressureInHg ?? null,
    w.windMph ?? null, w.windDir ?? null, w.precipIn ?? null,
    w.cloudPct ?? null, w.moonIllum ?? null);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const allCameras = db => db.prepare(`
  SELECT c.*, p.name AS property_name
  FROM cameras c LEFT JOIN properties p ON p.id = c.property_id
  ORDER BY p.name, c.name
`).all();

export const photosForCamera = (db, cameraId, limit = 500) =>
  db.prepare('SELECT * FROM photos WHERE camera_id = ? ORDER BY taken_at DESC LIMIT ?')
    .all(cameraId, limit);

/**
 * Detections joined to the weather of the hour they happened in — the shape the
 * WHERE half of the analysis is built on. Rows with no matching weather hour are
 * kept (LEFT JOIN) rather than silently dropped, so a gap in the weather backfill
 * shows up as missing conditions instead of missing sightings.
 */
export const detectionsWithWeather = (db, { species = null } = {}) => db.prepare(`
  SELECT d.*, ph.taken_at, ph.camera_id, c.name AS camera_name, c.property_id,
         w.temp_f, w.pressure_inhg, w.wind_mph, w.wind_dir, w.precip_in, w.cloud_pct
  FROM detections d
  JOIN photos ph ON ph.id = d.photo_id
  JOIN cameras c ON c.id = ph.camera_id
  LEFT JOIN weather_hours w
    ON w.location_id = c.weather_location_id AND w.hour_utc = ph.hour_utc
  WHERE (? IS NULL OR d.species = ?)
  ORDER BY ph.taken_at DESC
`).all(species, species);

export const counts = db => ({
  properties: db.prepare('SELECT COUNT(*) n FROM properties').get().n,
  cameras: db.prepare('SELECT COUNT(*) n FROM cameras').get().n,
  photos: db.prepare('SELECT COUNT(*) n FROM photos').get().n,
  detections: db.prepare('SELECT COUNT(*) n FROM detections').get().n,
  bucks: db.prepare('SELECT COUNT(*) n FROM bucks').get().n,
  weatherHours: db.prepare('SELECT COUNT(*) n FROM weather_hours').get().n,
});

// ---------------------------------------------------------------------------
// Stands
// ---------------------------------------------------------------------------

/** Normalize a wind list to canonical compass points, dropping anything unknown. */
export function normalizeWinds(winds) {
  if (!winds) return null;
  const list = Array.isArray(winds) ? winds : String(winds).split(',');
  const seen = [];
  for (const w of list) {
    const up = String(w).trim().toUpperCase();
    if (COMPASS.includes(up) && !seen.includes(up)) seen.push(up);
  }
  return seen.length ? seen.join(',') : null;
}

export function createStand(db, { name, type = 'stand', lat, lng,
  propertyId = null, goodWinds = null, notes = null }) {
  if (!name || !String(name).trim()) throw new Error('a stand needs a name');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('a stand needs coordinates');
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`coordinates out of range: ${lat}, ${lng}`);
  }
  if (!STAND_TYPES.includes(type)) {
    throw new Error(`unknown stand type "${type}" — one of ${STAND_TYPES.join(', ')}`);
  }
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO stands (property_id, name, type, lat, lng, good_winds, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(propertyId, String(name).trim(), type, lat, lng,
    normalizeWinds(goodWinds), notes, now, now);
  return db.prepare('SELECT * FROM stands WHERE id = ?').get(info.lastInsertRowid);
}

/** Patch only the fields supplied, so a rename cannot silently clear the winds. */
export function updateStand(db, id, patch = {}) {
  const existing = db.prepare('SELECT * FROM stands WHERE id = ?').get(id);
  if (!existing) throw new Error(`no stand with id ${id}`);

  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : existing.name,
    type: patch.type !== undefined ? patch.type : existing.type,
    lat: patch.lat !== undefined ? patch.lat : existing.lat,
    lng: patch.lng !== undefined ? patch.lng : existing.lng,
    property_id: patch.propertyId !== undefined ? patch.propertyId : existing.property_id,
    good_winds: patch.goodWinds !== undefined ? normalizeWinds(patch.goodWinds) : existing.good_winds,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
  };
  if (!next.name) throw new Error('a stand needs a name');
  if (!STAND_TYPES.includes(next.type)) {
    throw new Error(`unknown stand type "${next.type}" — one of ${STAND_TYPES.join(', ')}`);
  }
  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) {
    throw new Error('a stand needs coordinates');
  }

  db.prepare(`
    UPDATE stands SET name = ?, type = ?, lat = ?, lng = ?, property_id = ?,
                      good_winds = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.type, next.lat, next.lng, next.property_id,
    next.good_winds, next.notes, nowIso(), id);
  return db.prepare('SELECT * FROM stands WHERE id = ?').get(id);
}

export function deleteStand(db, id) {
  return db.prepare('DELETE FROM stands WHERE id = ?').run(id).changes > 0;
}

/**
 * Stands with their property name and, for each, the cameras within reach and
 * how far away they are. That link is what lets a recommendation move from
 * "camera A has been busy" to "sit the stand that covers camera A".
 */
export function allStands(db, { nearMetres = 400 } = {}) {
  const cams = db.prepare('SELECT id, name, lat, lng FROM cameras WHERE lat IS NOT NULL').all();
  return db.prepare(`
    SELECT s.*, p.name AS property_name
    FROM stands s LEFT JOIN properties p ON p.id = s.property_id
    ORDER BY p.name, s.name
  `).all().map(s => ({
    ...s,
    winds: s.good_winds ? s.good_winds.split(',') : [],
    nearbyCameras: cams
      .map(c => ({ id: c.id, name: c.name, metres: Math.round(distanceM(s.lat, s.lng, c.lat, c.lng)) }))
      .filter(c => c.metres <= nearMetres)
      .sort((a, b) => a.metres - b.metres),
  }));
}

/**
 * Is this stand huntable on this wind? Unknown winds answer null rather than
 * true: "I have not told it yet" and "yes" must not look the same, or the tool
 * would recommend sitting somewhere the deer will smell you.
 */
export function standHuntableOn(stand, windFromDeg) {
  const winds = stand.good_winds ? stand.good_winds.split(',') : [];
  if (!winds.length) return null;
  if (!Number.isFinite(windFromDeg)) return null;
  const point = COMPASS[Math.round(((windFromDeg % 360) + 360) % 360 / 22.5) % 16];
  return winds.includes(point);
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/**
 * Save a fetched elevation grid. Float32Array -> BLOB; the view is copied into
 * a Buffer over exactly its own bytes, because a Float32Array can be a window
 * onto a larger buffer and writing the whole underlying buffer would store
 * somebody else's data alongside ours.
 */
export function saveTerrainGrid(db, grid) {
  const bytes = Buffer.from(grid.z.buffer, grid.z.byteOffset, grid.z.byteLength);
  const info = db.prepare(`
    INSERT INTO terrain_grids
      (west, south, d_lng, d_lat, cols, rows, spacing_m, fetched_at, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(grid.west, grid.south, grid.dLng, grid.dLat,
         grid.cols, grid.rows, grid.spacingM, nowIso(), bytes);
  return Number(info.lastInsertRowid);
}

const gridFromRow = row => ({
  id: row.id,
  west: row.west, south: row.south,
  dLng: row.d_lng, dLat: row.d_lat,
  cols: row.cols, rows: row.rows, spacingM: row.spacing_m,
  fetchedAt: row.fetched_at,
  // A copy, not a view onto the row's buffer: node:sqlite may reuse that memory
  // for the next row read, which would quietly corrupt a grid held across
  // queries. The copy is a few kilobytes and removes the whole class of bug.
  z: new Float32Array(
    row.samples.buffer.slice(row.samples.byteOffset,
                             row.samples.byteOffset + row.samples.byteLength)),
});

export const allTerrainGrids = db =>
  db.prepare('SELECT * FROM terrain_grids ORDER BY id').all().map(gridFromRow);

/**
 * The cached grid covering a point, if there is one. Prefers the finest
 * spacing available, since a 5 m grid tells you more than a 30 m one about the
 * same ground.
 */
export function terrainGridAt(db, lat, lng) {
  const rows = db.prepare('SELECT * FROM terrain_grids ORDER BY spacing_m ASC').all();
  for (const row of rows) {
    const east = row.west + (row.cols - 1) * row.d_lng;
    const north = row.south + (row.rows - 1) * row.d_lat;
    if (lng >= row.west && lng <= east && lat >= row.south && lat <= north) {
      return gridFromRow(row);
    }
  }
  return null;
}

/** Does a cached grid already cover this whole box at this spacing or finer? */
export function terrainGridCovering(db, { west, south, east, north }, spacingM) {
  const rows = db.prepare(
    'SELECT * FROM terrain_grids WHERE spacing_m <= ? ORDER BY spacing_m ASC').all(spacingM);
  for (const row of rows) {
    const e = row.west + (row.cols - 1) * row.d_lng;
    const n = row.south + (row.rows - 1) * row.d_lat;
    if (row.west <= west && row.south <= south && e >= east && n >= north) {
      return gridFromRow(row);
    }
  }
  return null;
}

export const deleteTerrainGrid = (db, id) =>
  db.prepare('DELETE FROM terrain_grids WHERE id = ?').run(id).changes > 0;

// ---------------------------------------------------------------------------
// Scouting markers
// ---------------------------------------------------------------------------

export const MARKER_KINDS = ['rub', 'scrape', 'bed', 'trail', 'food-plot',
  'water', 'access', 'other'];

// Labels live here rather than in the page so the API and the UI cannot drift.
export const MARKER_LABELS = {
  rub: 'Rub', scrape: 'Scrape', bed: 'Bed', trail: 'Trail',
  'food-plot': 'Food plot', water: 'Water', access: 'Access route', other: 'Other',
};

function checkPoint(lat, lng) {
  // Number(null) is 0, and 0,0 is a real place in the Atlantic, so the check is
  // on the value BEFORE conversion as well as after.
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    throw new Error('a marker needs a latitude and longitude');
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('a marker needs real coordinates');
  }
}

export function createMarker(db, { kind, name = null, lat, lng,
  foundAt = null, notes = null, propertyId = null }) {
  if (!MARKER_KINDS.includes(kind)) {
    throw new Error(`unknown marker kind "${kind}" — one of ${MARKER_KINDS.join(', ')}`);
  }
  checkPoint(lat, lng);
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO markers (property_id, kind, name, lat, lng, found_at, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(propertyId, kind, name, lat, lng, foundAt, notes, now, now);
  return markerById(db, Number(info.lastInsertRowid));
}

export const markerById = (db, id) =>
  db.prepare('SELECT * FROM markers WHERE id = ?').get(id) ?? null;

export function updateMarker(db, id, patch = {}) {
  const row = markerById(db, id);
  if (!row) throw new Error(`no marker with id ${id}`);
  const next = {
    kind: patch.kind ?? row.kind,
    name: patch.name !== undefined ? patch.name : row.name,
    lat: patch.lat !== undefined ? patch.lat : row.lat,
    lng: patch.lng !== undefined ? patch.lng : row.lng,
    foundAt: patch.foundAt !== undefined ? patch.foundAt : row.found_at,
    notes: patch.notes !== undefined ? patch.notes : row.notes,
    propertyId: patch.propertyId !== undefined ? patch.propertyId : row.property_id,
  };
  if (!MARKER_KINDS.includes(next.kind)) {
    throw new Error(`unknown marker kind "${next.kind}"`);
  }
  checkPoint(next.lat, next.lng);
  db.prepare(`
    UPDATE markers SET property_id = ?, kind = ?, name = ?, lat = ?, lng = ?,
                       found_at = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(next.propertyId, next.kind, next.name, next.lat, next.lng,
         next.foundAt, next.notes, nowIso(), id);
  return markerById(db, id);
}

export const deleteMarker = (db, id) =>
  db.prepare('DELETE FROM markers WHERE id = ?').run(id).changes > 0;

/**
 * Every marker, with how old the sign is. Age is the point: a scrape found last
 * season is history, not intelligence, and the map should be able to show that
 * without the reader doing date arithmetic in their head.
 */
export function allMarkers(db, { now = new Date() } = {}) {
  return db.prepare('SELECT * FROM markers ORDER BY kind, id').all().map(m => ({
    ...m,
    label: MARKER_LABELS[m.kind] ?? m.kind,
    // null, not 0: sign with no date recorded is of UNKNOWN age, which is a
    // different thing from sign found today.
    daysOld: m.found_at ? Math.floor((now - new Date(m.found_at)) / 86400000) : null,
  }));
}
