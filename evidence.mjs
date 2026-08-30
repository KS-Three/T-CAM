/**
 * evidence.mjs — the WHERE half: what YOUR cameras have actually seen.
 *
 * design.md section 9 settled this shape and then nobody built it. The
 * reasoning there is worth restating because it is the thing that makes this
 * sound at all:
 *
 *   Fitting the PLANNER to observed sightings is hopeless. There is one rut a
 *   year, so rut phase, calendar date and "that Tuesday" are perfectly
 *   confounded — if a front lands on 8 November and produces forty pictures,
 *   nothing can separate the front from the rut from the date. Several factors
 *   are unidentifiable in principle until several seasons pull them apart.
 *
 *   But that objection only touches TIME. The question actually worth asking is
 *   "it is blowing north-west this afternoon, which stand?" — and that is a
 *   comparison BETWEEN CAMERAS DURING THE SAME WEATHER. Every camera on the
 *   property experiences the same north-west wind in the same hour of the same
 *   rut phase. Date, rut, moon and pressure are therefore held constant across
 *   the comparison for free, and the comparison is sound in the first season.
 *
 * So: this file never scores WHEN. It only ever compares cameras to each other
 * under matched conditions, and it refuses to compare them when there is not
 * enough matched data to be worth reading.
 *
 * THE DENOMINATOR IS THE WHOLE GAME. "Camera A has 30 deer pictures" is not a
 * fact about camera A until you know how long it was watching. Every rate here
 * is per hundred camera-hours, and the hours come from the weather table —
 * which design.md section 7 deliberately fills for EVERY hour whether or not a
 * photo exists, precisely so this file could exist one day. The quiet hours are
 * the control group.
 */

/**
 * Below this many matched camera-hours a camera is not ranked on that
 * condition. Settled in design.md section 9 ("start at 10"), kept.
 *
 * The reasoning for showing counts rather than running a significance test is
 * also settled there: in year one almost nothing clears a formal bar, so a
 * strict test answers "no significant difference" every time — correct and
 * useless. A person reading 7-versus-1 in front of him judges it correctly.
 */
export const MIN_HOURS = 10;

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const compassOf = deg =>
  (typeof deg === 'number' && Number.isFinite(deg))
    ? COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]
    : null;

/** Compass points apart, the short way round. */
export function pointsApart(a, b) {
  const i = COMPASS.indexOf(a), j = COMPASS.indexOf(b);
  if (i === -1 || j === -1) return null;
  return Math.min((i - j + 16) % 16, (j - i + 16) % 16);
}

// ---------------------------------------------------------------------------
// Sunrise and sunset from first principles.
//
// legal-light.mjs takes sunrise and sunset as strings BECAUSE the forecast API
// hands them over for the days it covers. That is the right call there and no
// use at all here: this file reasons about photos taken last November, and no
// forecast reaches backwards. So the standard sunrise equation, which is short,
// exact enough (well under a minute at this latitude) and has no dependencies.
//
// Everything is in UTC milliseconds. The photo timestamps are, the weather
// hours are, and converting to a local clock in between is how you get an
// off-by-an-hour that nothing catches because it looks plausible.
// ---------------------------------------------------------------------------
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const J1970 = 2440588, J2000 = 2451545;
const toJulian = ms => ms / 86400000 - 0.5 + J1970;
const fromJulian = j => (j + 0.5 - J1970) * 86400000;

/**
 * Sunrise and sunset in UTC ms for a date and place, plus solar noon.
 *
 * Returns nulls above the arctic circle in the seasons where the sun does not
 * cross the horizon — a real case that must not come back as NaN and be
 * compared against silently.
 */
export function sunTimes(whenMs, lat, lng) {
  const n = Math.round(toJulian(whenMs) - J2000 + 0.0008);
  const Jstar = n - lng / 360;                                    // mean solar time
  const M = (357.5291 + 0.98560028 * Jstar) % 360;                // solar mean anomaly
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M))
    + 0.0003 * Math.sin(rad(3 * M));                              // equation of centre
  const lambda = (M + C + 180 + 102.9372) % 360;                  // ecliptic longitude
  const Jtransit = J2000 + Jstar + 0.0053 * Math.sin(rad(M))
    - 0.0069 * Math.sin(rad(2 * lambda));
  const decl = Math.asin(Math.sin(rad(lambda)) * Math.sin(rad(23.44)));
  // -0.833 degrees is the standard sunrise altitude: the sun's radius plus
  // atmospheric refraction at the horizon.
  const cosOmega = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(decl))
    / (Math.cos(rad(lat)) * Math.cos(decl));
  if (!Number.isFinite(cosOmega) || cosOmega > 1 || cosOmega < -1) {
    return { sunrise: null, sunset: null, noon: fromJulian(Jtransit), polar: true };
  }
  const omega = deg(Math.acos(cosOmega));
  return {
    sunrise: fromJulian(Jtransit - omega / 360),
    sunset: fromJulian(Jtransit + omega / 360),
    noon: fromJulian(Jtransit),
    polar: false,
  };
}

/** How wide dawn and dusk are, either side of the sun crossing the horizon. */
export const TWILIGHT_HOURS = 1.5;

/**
 * Which part of the day an instant falls in.
 *
 * 'dawn' and 'dusk' overlap daylight deliberately — they are the hours a person
 * is in a tree, and the Mississippi State time budget has bucks walking 19% of
 * dawn and 21% of dusk against 9% of the day. Splitting them out is the whole
 * reason a camera's timestamps are worth anything.
 */
export function lightBand(whenMs, lat, lng) {
  const { sunrise, sunset, polar } = sunTimes(whenMs, lat, lng);
  if (polar || sunrise === null || sunset === null) return 'unknown';
  const w = TWILIGHT_HOURS * 3600000;
  if (whenMs >= sunrise - w && whenMs <= sunrise + w) return 'dawn';
  if (whenMs >= sunset - w && whenMs <= sunset + w) return 'dusk';
  if (whenMs > sunrise + w && whenMs < sunset - w) return 'day';
  return 'night';
}

/** Is this instant in legal-ish shooting light at all? Used for the daylight rate. */
export const isDaylight = (whenMs, lat, lng) => {
  const b = lightBand(whenMs, lat, lng);
  return b === 'dawn' || b === 'day' || b === 'dusk';
};

/**
 * The band a sit window is really asking about. An AM sit is dawn; a PM sit is
 * dusk. Both of them care about the shoulder, not midday.
 */
export const bandForWindow = w => (w === 'AM' ? 'dawn' : 'dusk');

// ---------------------------------------------------------------------------
// The condition ladder
//
// One season of photographs cannot answer "north-west wind, dusk, peak rut, 28
// degrees" — that intersection is empty and any rate computed from it is one
// picture pretending to be a pattern. So conditions are tried from most
// specific to least, and the FIRST one that clears the evidence bar is the one
// reported, with its name, so it is obvious how narrow the claim is.
//
// This is the honest version of what a machine-learning model would do
// implicitly and invisibly.
// ---------------------------------------------------------------------------
export function conditionLadder(sit) {
  const windFrom = sit?.windFrom ?? compassOf(sit?.windDir);
  const band = bandForWindow(sit?.window);
  const out = [];

  if (windFrom) {
    out.push({
      name: `${band} on a ${windFrom} wind`,
      specificity: 3,
      match: h => h.band === band && h.wind !== null && pointsApart(h.wind, windFrom) <= 1,
    });
    out.push({
      name: `any daylight on a ${windFrom} wind`,
      specificity: 2,
      match: h => h.daylight && h.wind !== null && pointsApart(h.wind, windFrom) <= 1,
    });
  }
  out.push({
    name: `${band}, any wind`,
    specificity: 1,
    match: h => h.band === band,
  });
  out.push({
    name: 'any daylight hour, any wind',
    specificity: 0,
    match: h => h.daylight,
  });
  return out;
}

// ---------------------------------------------------------------------------
// The comparison itself
// ---------------------------------------------------------------------------

/**
 * Tag each weather hour with the things a condition can match on.
 *
 * Done once per camera location rather than inside the matcher, because the
 * solar calculation is the expensive part and a season is a few thousand hours
 * per location.
 */
export function tagHours(hours, { lat, lng }) {
  return hours.map(h => {
    const ms = Date.parse(h.hour_utc ?? h.hour ?? '');
    if (!Number.isFinite(ms)) return null;
    const band = lightBand(ms, lat, lng);
    return {
      ms,
      band,
      daylight: band === 'dawn' || band === 'day' || band === 'dusk',
      wind: compassOf(h.wind_dir ?? h.windDir ?? null),
      temp: h.temp_f ?? h.temp ?? null,
      key: (h.hour_utc ?? h.hour ?? '').slice(0, 13),
    };
  }).filter(Boolean);
}

/**
 * Detections per hundred camera-hours, per camera, under matched conditions.
 *
 * `cameras`   [{ id, name, lat, lng, hours: [tagged], firstMs, lastMs }]
 * `sightings` [{ cameraId, ms }]  — CONFIRMED detections only; the caller
 *             filters, because "is a machine guess evidence" is settled
 *             elsewhere (design.md section 3) and must not be re-decided here.
 */
export function cameraEvidence({ cameras = [], sightings = [], sit,
  minHours = MIN_HOURS } = {}) {
  const ladder = conditionLadder(sit);
  const byCamera = new Map();
  for (const s of sightings) {
    if (!byCamera.has(s.cameraId)) byCamera.set(s.cameraId, []);
    byCamera.get(s.cameraId).push(s.ms);
  }

  // One condition for the WHOLE comparison, not one per camera. Ranking camera
  // A on its best-supported condition against camera B on a different one
  // compares two different questions and calls the answer a ranking.
  let chosen = null;
  for (const cond of ladder) {
    const hoursPer = cameras.map(c => c.hours.filter(cond.match).length);
    // Every camera that has been out at all must clear the bar, or the
    // comparison silently becomes "the cameras with data beat the ones
    // without", which is a fact about deployment, not deer.
    const live = cameras.filter((c, i) => c.hours.length > 0 && hoursPer[i] >= minHours);
    if (live.length >= 2 || (cameras.length === 1 && live.length === 1)) {
      chosen = cond;
      break;
    }
  }

  const rows = cameras.map(c => {
    const cond = chosen;
    const matched = cond ? c.hours.filter(cond.match) : [];
    const keys = new Set(matched.map(h => h.key));
    const hits = (byCamera.get(c.id) ?? []).filter(ms => {
      const k = new Date(ms).toISOString().slice(0, 13);
      return keys.has(k);
    });
    // Nocturnal share is computed over ALL of a camera's sightings rather than
    // the matched ones, because it is a property of the place and needs every
    // picture it can get. It is the single most useful number a camera
    // produces: a stand covered by a camera whose deer are 90% nocturnal is
    // not a daylight stand, whatever its rate.
    const all = byCamera.get(c.id) ?? [];
    const night = all.filter(ms => !isDaylight(ms, c.lat, c.lng)).length;
    return {
      cameraId: c.id,
      name: c.name,
      condition: cond?.name ?? null,
      specificity: cond?.specificity ?? null,
      hours: matched.length,
      detections: hits.length,
      per100: matched.length >= minHours
        ? Math.round(1000 * hits.length / matched.length) / 10 : null,
      enough: matched.length >= minHours,
      totalSightings: all.length,
      nocturnalShare: all.length ? Math.round(100 * night / all.length) : null,
      deployedHours: c.hours.length,
    };
  });

  rows.sort((a, b) => (b.per100 ?? -1) - (a.per100 ?? -1));

  return {
    condition: chosen?.name ?? null,
    specificity: chosen?.specificity ?? null,
    minHours,
    rows,
    // Said plainly, because "no condition cleared the bar" and "they all tied"
    // need different things from Kent and both look like silence otherwise.
    note: !chosen
      ? `No condition has ${minHours} matched camera-hours yet at two or more cameras. `
        + 'Nothing here is ranked on your own photographs — the stand order is coming '
        + 'from wind and terrain alone.'
      : null,
  };
}

/**
 * How much the camera evidence is worth, as a tier and a sentence.
 *
 * Deliberately separate from the rate itself. A camera can have a very high
 * rate on eleven hours, and the rate is not the problem — the eleven hours are.
 */
export function evidenceConfidence(result) {
  const ranked = result.rows.filter(r => r.enough);
  if (!ranked.length) {
    return { tier: 'none', why: result.note ?? 'no camera has enough matched hours' };
  }
  const hours = ranked.reduce((s, r) => s + r.hours, 0);
  const best = ranked[0], next = ranked[1] ?? null;
  const gap = next && next.per100 !== null && best.per100 !== null
    ? best.per100 - next.per100 : null;

  // Volume first: everything else is arithmetic on top of it.
  const volume = hours >= 400 ? 3 : hours >= 120 ? 2 : 1;
  // Then separation: two cameras a hair apart is a tie however many hours back it.
  const separation = gap === null ? 0
    : gap >= (best.per100 || 1) * 0.5 ? 2
    : gap > 0 ? 1 : 0;
  // And how narrow the claim is. The bottom rung of the ladder is "any daylight
  // hour", which is a fact about the camera, not about tonight.
  const narrow = (result.specificity ?? 0) >= 2 ? 1 : 0;

  const score = volume + separation + narrow;
  const tier = score >= 5 ? 'strong' : score >= 3 ? 'moderate' : 'weak';
  return {
    tier,
    hours,
    gap,
    why: `${ranked.length} camera${ranked.length === 1 ? '' : 's'} with `
      + `${hours} matched hours between them, compared on "${result.condition}"`
      + (gap === null ? '. Only one camera cleared the bar, so nothing is being compared'
        : gap <= 0 ? '. The top two are level, so this does not pick between them'
        : `; the top camera leads the next by ${gap.toFixed(1)} per 100 hours`),
  };
}

// ---------------------------------------------------------------------------
// Reading it out of the database
//
// Kept to the bottom, and kept thin, so everything above can be tested with
// plain arrays and no SQLite file.
// ---------------------------------------------------------------------------

/**
 * Assemble the camera evidence for one sit, straight from the store.
 *
 * `species` defaults to deer and `bucksOnly` narrows to detections carrying a
 * named buck, which is the question Kent will actually ask in November.
 */
export function evidenceFor(db, sit, { species = 'deer', bucksOnly = false,
  minHours = MIN_HOURS } = {}) {
  const cams = db.prepare(`
    SELECT c.id, c.name, c.lat, c.lng, c.weather_location_id AS loc
    FROM cameras c WHERE c.lat IS NOT NULL AND c.lng IS NOT NULL
  `).all();
  if (!cams.length) return { condition: null, rows: [], minHours, note: 'no cameras with coordinates' };

  const hoursByLoc = new Map();
  const readHours = loc => {
    if (!hoursByLoc.has(loc)) {
      hoursByLoc.set(loc, db.prepare(
        'SELECT hour_utc, wind_dir, temp_f FROM weather_hours WHERE location_id = ?'
      ).all(loc));
    }
    return hoursByLoc.get(loc);
  };

  const cameras = cams.map(c => ({
    id: c.id, name: c.name, lat: c.lat, lng: c.lng,
    hours: c.loc === null ? [] : tagHours(readHours(c.loc), { lat: c.lat, lng: c.lng }),
  }));

  const sightings = db.prepare(`
    SELECT ph.camera_id AS cameraId, ph.taken_at AS takenAt
    FROM detections d
    JOIN photos ph ON ph.id = d.photo_id
    WHERE d.confirmed = 1
      AND (? IS NULL OR d.species = ?)
      ${bucksOnly ? 'AND d.buck_id IS NOT NULL' : ''}
      AND ph.taken_at IS NOT NULL
  `).all(species, species)
    .map(r => ({ cameraId: r.cameraId, ms: Date.parse(r.takenAt) }))
    .filter(r => Number.isFinite(r.ms));

  const result = cameraEvidence({ cameras, sightings, sit, minHours });
  return { ...result, confidence: evidenceConfidence(result) };
}
