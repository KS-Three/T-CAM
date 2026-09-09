/**
 * patterns.mjs — the statistics side: what your own cameras have measured.
 *
 * Kent's ask, 2026-09-09: less prose, more numbers, "the way AWS does it for
 * NFL games". The camp report told him what to think; this tells him what was
 * counted, with the sample size attached to every figure so he can see when a
 * number is worth acting on and when it is one photograph pretending to be a
 * pattern.
 *
 * ## Everything here is a RATE, never a count
 *
 * Raw counts are the trap this whole file exists to avoid. A camera that was
 * dark for three weeks and a camera watching empty ground both report nothing,
 * and a bare tally cannot tell them apart. `camera-days.mjs` already fixed that
 * for the sit planner, and its argument is the one used here: the denominator
 * is the hours the camera was ACTUALLY WATCHING — `camera_days` rows whose
 * state is 'live', 24 hours each. A quota-dark day contributes neither a
 * sighting nor an hour, and so moves no number in either direction.
 *
 * Rates are per 100 camera-hours throughout. That unit is what lets a camera
 * hung in July and one hung last week sit in the same column.
 *
 * ## The clock is SOLAR, not UTC and not the laptop's
 *
 * Deer keep the sun's hours. Bucketing photographs by UTC would put the dawn
 * peak at eleven in the morning on this longitude, and bucketing by the
 * machine's local timezone would move every chart an hour on the first Sunday
 * in November, mid-season. So hour-of-day here means camera-local solar time,
 * via the same `solarOffsetMs(lng)` that decides which day a photograph belongs
 * to in `camera_days`. The two agree by construction.
 *
 * ## Two sources, side by side, NEVER summed
 *
 * `detections.source` separates the vendor's guess from a human's tag, and
 * db.mjs's own note on `detectionsWithWeather` is blunt about it: an unreviewed
 * machine guess is not evidence. It is, however, DATA — there are thousands of
 * the camera's tags and comparatively few of Kent's, and refusing to look at
 * them means most panels sit empty for a season.
 *
 * The resolution is the one the review screen already uses: show both, keep
 * them apart, and never let one masquerade as the other. Every figure in this
 * file is computed twice and returned in a labelled pair:
 *
 *   yours  — d.confirmed = 1. A person looked at the photograph and said so.
 *            A camera-ai row that Kent later confirmed counts HERE, because
 *            what makes it evidence is the looking, not who guessed first.
 *   camera — d.source = 'camera-ai' AND d.confirmed = 0. The vendor's
 *            unreviewed claim, and labelled as a claim wherever it is drawn.
 *
 * The two sets are disjoint by construction, so nothing is double-counted, and
 * nothing in this file ever adds them together.
 *
 * ## Too little data produces NULL, never zero
 *
 * A cell matched by four hours has no rate — not a rate of zero. Zero is a
 * claim ("deer do not use this camera on an east wind") and four hours cannot
 * support it. Every cell carries `hours`, and `rate` is null below
 * `MIN_HOURS`. Drawing code must render that as a refusal, not as a cold spot,
 * which is why `rate: null` and `rate: 0` are kept distinguishable all the way
 * out to the page.
 */
import { solarOffsetMs } from './camera-days.mjs';
import { MIN_HOURS, sunTimes } from './evidence.mjs';
import { cameraPoint } from './db.mjs';

/**
 * The two provenances, in the order they are drawn. `where` is spliced into the
 * detections query; both halves are literal, neither takes user input.
 */
export const SOURCES = [
  { key: 'yours', label: 'Your tags', short: 'yours', where: 'd.confirmed = 1' },
  {
    key: 'camera', label: "The camera's guesses", short: 'camera',
    where: "d.source = 'camera-ai' AND d.confirmed = 0",
  },
];

/** Eight octants, not the compass's sixteen: sixteen splits a season too thin. */
export const OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Which octant a bearing falls in.
 *
 * Straight from degrees rather than by folding compassOf's sixteen points in
 * half: folding centres the N octant on NNW-and-N instead of on N, which is a
 * 22.5-degree lie in every wind chart built on it.
 */
export const octantOf = deg => {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return null;
  return OCTANTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
};

/**
 * Temperature bands, in Fahrenheit, cut where a Wisconsin season actually
 * varies rather than at round numbers. The top band is open because a 70-degree
 * November day is one thing whether it is 70 or 78.
 */
export const TEMP_BANDS = [
  { key: 'lt20', label: 'under 20°F', test: t => t < 20 },
  { key: '20s', label: '20–34°F', test: t => t >= 20 && t < 35 },
  { key: '30s', label: '35–49°F', test: t => t >= 35 && t < 50 },
  { key: '50s', label: '50–64°F', test: t => t >= 50 && t < 65 },
  { key: 'gte65', label: '65°F and up', test: t => t >= 65 },
];

/**
 * Pressure bands. Carried at tier D on purpose.
 *
 * docs/deer-evidence.md found the "active band" traces to hunting-magazine
 * logbooks rather than a study, and the one collar test of it found nothing —
 * which is why `movement-model.mjs` scores it zero. It is still worth PLOTTING:
 * a pattern on Kent's own ground would be evidence about Kent's ground, and
 * individuals.mjs already takes that position for a named buck. The tier
 * travels with the axis so the chart can say so rather than implying a factor
 * the literature does not support.
 */
export const PRESSURE_BANDS = [
  { key: 'low', label: 'under 29.80"', test: p => p < 29.8 },
  { key: 'mid', label: '29.80–30.10"', test: p => p >= 29.8 && p <= 30.1 },
  { key: 'high', label: 'over 30.10"', test: p => p > 30.1 },
];

/** Light bands, in the order a day runs. lightBand() produces exactly these. */
export const LIGHT_BANDS = [
  { key: 'dawn', label: 'Dawn' }, { key: 'day', label: 'Day' },
  { key: 'dusk', label: 'Dusk' }, { key: 'night', label: 'Night' },
];

/**
 * The axes a cell can be cut by, and what each is worth as evidence.
 *
 * tier travels with the axis because the page draws it. 'A' here means the
 * axis is a measurement of the animal's own clock (light), 'B' a measured
 * environmental factor with collar-study support (wind, temperature), 'D'
 * received wisdom with no traceable study (pressure). The tiers are
 * deer-evidence.md's, not new ones.
 */
export const AXES = [
  {
    key: 'light', label: 'Time of day', tier: 'A',
    note: 'Dawn and dusk overlap daylight on purpose — they are the hours you are in a tree.',
    buckets: LIGHT_BANDS,
    of: h => h.band,
  },
  {
    key: 'wind', label: 'Wind direction', tier: 'B',
    note: 'The direction the wind is coming FROM, in eight octants.',
    buckets: OCTANTS.map(k => ({ key: k, label: k })),
    of: h => h.windFrom,
  },
  {
    key: 'temp', label: 'Temperature', tier: 'B',
    note: 'Collar work finds temperature moves deer; a cold FRONT, separately, does not.',
    buckets: TEMP_BANDS,
    of: h => bandKey(TEMP_BANDS, h.tempF),
  },
  {
    key: 'pressure', label: 'Barometer', tier: 'D',
    note: 'Tier D: no collar study supports this. Plotted so your own ground can answer it.',
    buckets: PRESSURE_BANDS,
    of: h => bandKey(PRESSURE_BANDS, h.pressure),
  },
];

/** Which band a value falls in, or null when the value is unknown. */
export function bandKey(bands, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const hit = bands.find(b => b.test(v));
  return hit ? hit.key : null;
}

// ---------------------------------------------------------------------------
// The denominator
// ---------------------------------------------------------------------------

/**
 * Every hour a camera was actually watching, tagged with what was going on.
 *
 * One row per hour of every 'live' day. Weather is attached where the backfill
 * reached and left null where it did not, so a gap in the weather shows up as
 * cells that refuse rather than as hours quietly missing from the denominator
 * of a light-band chart that never needed weather in the first place.
 *
 * sunTimes is the expensive call, so it is made once per day and shared by that
 * day's 24 hours — the same economy tagHours() makes in evidence.mjs.
 */
export function watchedHours(db, cam) {
  const days = db.prepare(
    "SELECT day FROM camera_days WHERE camera_id = ? AND state = 'live' ORDER BY day"
  ).all(cam.id).map(r => r.day);
  if (!days.length) return [];

  const wx = new Map();
  if (cam.weatherLocationId !== null && cam.weatherLocationId !== undefined) {
    for (const r of db.prepare(
      `SELECT hour_utc, temp_f, pressure_inhg, wind_mph, wind_dir, precip_in, cloud_pct
       FROM weather_hours WHERE location_id = ?`
    ).all(cam.weatherLocationId)) {
      wx.set(String(r.hour_utc ?? '').slice(0, 13), r);
    }
  }

  const off = solarOffsetMs(cam.lng);
  const out = [];
  for (const day of days) {
    const localMidnight = Date.parse(day + 'T00:00:00.000Z');
    if (!Number.isFinite(localMidnight)) continue;
    // One solar reading for the day, reused by its 24 hours. Taken at local
    // NOON: local midnight can land in the previous UTC day at an eastern
    // longitude and carry that day's sunrise with it.
    const sun = sunTimes(localMidnight + 43200000 - off, cam.lat, cam.lng);
    for (let h = 0; h < 24; h++) {
      const ms = localMidnight + h * 3600000 - off;
      const w = wx.get(new Date(ms).toISOString().slice(0, 13)) ?? null;
      out.push({
        ms, day, localHour: h,
        band: bandFromSun(ms, sun),
        windFrom: w ? octantOf(w.wind_dir) : null,
        windMph: w ? w.wind_mph : null,
        tempF: w ? w.temp_f : null,
        pressure: w ? w.pressure_inhg : null,
        hasWeather: w !== null,
      });
    }
  }
  return out;
}

/**
 * lightBand's decision, against a sun already computed for the day.
 *
 * Kept in step with lightBand() by construction rather than by comment: the
 * thresholds below are the same ones, and `test/patterns.test.js` compares this
 * against lightBand() across a year so the two cannot drift.
 */
export function bandFromSun(ms, sun) {
  if (!sun || sun.polar || sun.sunrise === null || sun.sunset === null) return 'unknown';
  const w = 1.5 * 3600000;                     // TWILIGHT_HOURS, in ms
  if (ms >= sun.sunrise - w && ms <= sun.sunrise + w) return 'dawn';
  if (ms >= sun.sunset - w && ms <= sun.sunset + w) return 'dusk';
  if (ms > sun.sunrise + w && ms < sun.sunset - w) return 'day';
  return 'night';
}

// ---------------------------------------------------------------------------
// The numerator
// ---------------------------------------------------------------------------

/**
 * Sightings for one provenance.
 *
 * A "sighting" is a DETECTION ROW, not a photograph and not an animal: a burst
 * of nine frames of the same doe is nine rows, and this file makes no attempt
 * to collapse them. That is a real limitation and it is stated on the page —
 * `visits` already groups a burst, and moving the numerator onto visits is the
 * obvious next step once there are enough of Kent's own tags to check it
 * against.
 */
export function sightings(db, { source, species = 'deer', buckId = null } = {}) {
  const src = SOURCES.find(s => s.key === source);
  if (!src) throw new Error('unknown source: ' + source);
  return db.prepare(`
    SELECT ph.camera_id AS cameraId, ph.taken_at AS takenAt, d.buck_id AS buckId
    FROM detections d
    JOIN photos ph ON ph.id = d.photo_id
    WHERE ${src.where}
      AND (? IS NULL OR d.species = ?)
      AND (? IS NULL OR d.buck_id = ?)
      AND ph.taken_at IS NOT NULL
  `).all(species, species, buckId, buckId)
    .map(r => ({ cameraId: r.cameraId, buckId: r.buckId, ms: Date.parse(r.takenAt) }))
    .filter(r => Number.isFinite(r.ms));
}

// ---------------------------------------------------------------------------
// Putting hours and sightings together
// ---------------------------------------------------------------------------

/** A rate per 100 camera-hours, or null when the hours cannot support one. */
export function rateOf(hits, hours, minHours = MIN_HOURS) {
  if (hours < minHours) return null;
  return (hits / hours) * 100;
}

/**
 * The 24-hour curve for one camera: how many deer per 100 camera-hours in each
 * hour of the solar day.
 *
 * Every live day contributes exactly one hour to each of the 24 buckets, so the
 * denominator is the same in every bucket for a camera with no gaps — and
 * visibly different in one that came online mid-season, which is the case this
 * shape exists to keep honest.
 */
export function curveFor(hours, sight, lng) {
  const hits = new Array(24).fill(0);
  const denom = new Array(24).fill(0);
  for (const h of hours) denom[h.localHour] += 1;
  const off = solarOffsetMs(lng);
  for (const s of sight) {
    const local = new Date(s.ms + off).getUTCHours();
    hits[local] += 1;
  }
  return hits.map((n, i) => ({
    hour: i, hits: n, hours: denom[i], rate: rateOf(n, denom[i]),
  }));
}

/**
 * The average sunrise and sunset across the hours actually watched, in solar
 * hours, so the curve can be drawn with the light marked on it.
 *
 * A range as well as a mean: sunset moves nearly two hours across a season and
 * a single line would be a fiction. Null when nothing was watched.
 */
export function lightWindow(hours, cam) {
  const rises = [], sets = [];
  const off = solarOffsetMs(cam.lng);
  const seen = new Set();
  for (const h of hours) {
    if (seen.has(h.day)) continue;
    seen.add(h.day);
    const sun = sunTimes(h.ms, cam.lat, cam.lng);
    if (sun.polar || sun.sunrise === null || sun.sunset === null) continue;
    rises.push(((sun.sunrise + off) % 86400000) / 3600000);
    sets.push(((sun.sunset + off) % 86400000) / 3600000);
  }
  if (!rises.length) return null;
  const span = a => ({
    min: Math.min(...a), max: Math.max(...a),
    mean: a.reduce((x, y) => x + y, 0) / a.length,
  });
  return { sunrise: span(rises), sunset: span(sets), days: rises.length };
}

/**
 * One axis, cut into its buckets, for one camera.
 *
 * Hours whose value on this axis is unknown — no weather backfilled for that
 * hour, a wind direction the service left null — are counted in `unknown` and
 * excluded from every bucket. They are not silently dropped, because "we have
 * 400 hours here but only 30 with weather" is exactly the thing a person needs
 * to know before believing a wind chart.
 */
export function axisFor(hours, sight, axis, minHours = MIN_HOURS) {
  const byKey = new Map(axis.buckets.map(b => [b.key, { hits: 0, hours: 0 }]));
  let unknown = 0;

  const at = new Map();                     // ms of hour start -> bucket key
  for (const h of hours) {
    const k = axis.of(h);
    at.set(Math.floor(h.ms / 3600000), k);
    if (k === null || !byKey.has(k)) { unknown += 1; continue; }
    byKey.get(k).hours += 1;
  }
  for (const s of sight) {
    const k = at.get(Math.floor(s.ms / 3600000));
    if (k === undefined) continue;          // a sighting outside every live day
    if (k === null || !byKey.has(k)) continue;
    byKey.get(k).hits += 1;
  }
  return {
    key: axis.key, label: axis.label, tier: axis.tier, note: axis.note, unknown,
    buckets: axis.buckets.map(b => {
      const c = byKey.get(b.key);
      return { key: b.key, label: b.label, hits: c.hits, hours: c.hours,
        rate: rateOf(c.hits, c.hours, minHours) };
    }),
  };
}

// ---------------------------------------------------------------------------
// The whole board
// ---------------------------------------------------------------------------

/** The cameras this analysis can speak about, with the effective pin. */
export function camerasFor(db) {
  return db.prepare('SELECT * FROM cameras').all()
    .map(r => {
      const p = cameraPoint(r);
      return { id: r.id, name: r.name, lat: p.lat, lng: p.lng, corrected: p.corrected,
        weatherLocationId: r.weather_location_id };
    })
    .filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lng));
}

/**
 * Everything the statistics board draws, in one pass over the database.
 *
 * The hours are read once per camera and reused by every metric and both
 * sources — a season is a few thousand rows per camera and the solar work is
 * the expensive part, so computing it four times would be four times the wait
 * for the same answer.
 */
export function patterns(db, { species = 'deer', minHours = MIN_HOURS, bucks = true } = {}) {
  const cams = camerasFor(db);
  if (!cams.length) {
    return { cameras: [], sources: SOURCES.map(s => ({ ...s, total: 0 })), axes: AXES.map(axisMeta),
      byCamera: {}, board: {}, bucks: [], minHours, note: 'no cameras with coordinates' };
  }

  const hoursBy = new Map(cams.map(c => [c.id, watchedHours(db, c)]));
  const sightBy = new Map();
  for (const s of SOURCES) sightBy.set(s.key, sightings(db, { source: s.key, species }));

  const cameras = cams.map(c => {
    const hs = hoursBy.get(c.id);
    return { id: c.id, name: c.name, lat: c.lat, lng: c.lng, corrected: c.corrected,
      hours: hs.length, days: hs.length / 24,
      weatherHours: hs.filter(h => h.hasWeather).length,
      light: lightWindow(hs, c) };
  });

  const byCamera = {}, board = {};
  for (const s of SOURCES) {
    const all = sightBy.get(s.key);
    byCamera[s.key] = {};
    board[s.key] = [];
    for (const c of cams) {
      const hs = hoursBy.get(c.id);
      const mine = all.filter(x => x.cameraId === c.id);
      byCamera[s.key][c.id] = {
        curve: curveFor(hs, mine, c.lng),
        axes: AXES.map(a => axisFor(hs, mine, a, minHours)),
      };
      board[s.key].push({ id: c.id, name: c.name, hits: mine.length, hours: hs.length,
        rate: rateOf(mine.length, hs.length, minHours) });
    }
    // Ranked, but a camera with no rate never outranks one with a real number:
    // "unknown" sorting above "measured zero" is how a dark camera becomes a
    // recommendation.
    board[s.key].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  }

  return {
    cameras,
    sources: SOURCES.map(s => ({ key: s.key, label: s.label, short: s.short,
      total: sightBy.get(s.key).length })),
    axes: AXES.map(axisMeta),
    byCamera, board,
    bucks: bucks ? buckPatterns(db, { cams, hoursBy, minHours }) : [],
    minHours,
    note: null,
  };
}

const axisMeta = a => ({ key: a.key, label: a.label, tier: a.tier, note: a.note,
  buckets: a.buckets.map(b => ({ key: b.key, label: b.label })) });

/**
 * The same treatment per named buck.
 *
 * Only ever from `yours`: the vendor's AI says "deer", never "Split G2", so a
 * per-buck row can only come from a human tag and there is no second column to
 * draw. A buck with no confirmed detections is returned with his zero rather
 * than omitted, because "we have him in the book and have never caught him" is
 * a fact about the season worth seeing.
 */
export function buckPatterns(db, { cams, hoursBy, minHours = MIN_HOURS } = {}) {
  const rows = db.prepare('SELECT id, name FROM bucks ORDER BY name').all();
  if (!rows.length) return [];
  return rows.map(b => {
    const mine = sightings(db, { source: 'yours', species: null, buckId: b.id });
    const perCamera = cams.map(c => {
      const hs = hoursBy.get(c.id);
      const his = mine.filter(x => x.cameraId === c.id);
      return { id: c.id, name: c.name, hits: his.length, hours: hs.length,
        rate: rateOf(his.length, hs.length, minHours) };
    }).sort((a, b2) => (b2.rate ?? -1) - (a.rate ?? -1));

    // His hours pooled across cameras: one buck rarely gives one camera enough
    // to say anything, and the question "when does HE move" is not per-camera.
    const pooled = new Array(24).fill(0);
    const denom = new Array(24).fill(0);
    for (const c of cams) {
      const off = solarOffsetMs(c.lng);
      for (const h of hoursBy.get(c.id)) denom[h.localHour] += 1;
      for (const s of mine.filter(x => x.cameraId === c.id)) {
        pooled[new Date(s.ms + off).getUTCHours()] += 1;
      }
    }
    return {
      id: b.id, name: b.name, hits: mine.length,
      curve: pooled.map((n, i) => ({ hour: i, hits: n, hours: denom[i],
        rate: rateOf(n, denom[i], minHours) })),
      perCamera,
    };
  });
}
