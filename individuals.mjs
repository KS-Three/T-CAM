/**
 * individuals.mjs — "some individuals follow the moon" made falsifiable.
 *
 * Kent's call, 2026-08-30, and it is a better objection than it first looks:
 * there is no population-level evidence for moon or barometer, but a
 * population average is exactly the thing that hides an individual. The
 * literature agrees with him on the mechanism, if not the factor — Mississippi
 * State found a third of their bucks lived on ranges fifteen times the size of
 * the other two thirds', which means "the deer here do X" is routinely an
 * average over two different animals.
 *
 * So the resolution is NOT to put moon and pressure back into the score. The
 * population weight stays zero, because that is what the collar data says and
 * Kent agrees. Instead the claim gets tested where it can actually be settled:
 * against ONE named buck, on Kent's own ground, in Kent's own photographs.
 * If Split G2's pictures really do pile up on bright nights, that is a fact
 * about Split G2 measurable from data already in the database, and it earns
 * tier Y — better evidence about that animal than any study of other deer.
 *
 * Two traps govern the whole file:
 *
 * 1. THE NULL MUST BE MATCHED ON TIME OF DAY. Barometric pressure has a
 *    diurnal cycle and deer are crepuscular, so drawing the comparison sample
 *    from all available hours would compare "this buck moves at dusk" against
 *    "pressure is different at dusk" and report a confident, entirely spurious
 *    barometer effect. This is the same trap collar.mjs documents for
 *    temperature, and it runs in the dangerous direction: it invents a
 *    relationship rather than hiding one. The draw is therefore stratified by
 *    light band.
 *
 * 2. TESTING SEVERAL BUCKS AGAINST SEVERAL FACTORS WILL FIND SOMETHING.
 *    Five bucks against two factors is ten tests, and at p = 0.05 you expect
 *    one of them to look real when nothing is. The threshold is divided by the
 *    number of tests actually run, and the count is reported, so a "finding"
 *    cannot be read without seeing how many chances it had.
 */

import { mulberry32 } from './sit-journal.mjs';
import { moonPhase } from './movement-model.mjs';
import { tagHours } from './evidence.mjs';

/**
 * Below this many confirmed sightings of one individual, nothing is reported.
 *
 * Higher than the camera evidence bar (10 hours) because this is a harder
 * question: a rate needs a denominator, but a distribution needs a shape, and
 * twelve points is the floor at which the shuffle test can say anything at all.
 * It is the same number sit-journal.mjs refuses below, for the same reason.
 */
export const MIN_SIGHTINGS = 12;

export const ITERATIONS = 5000;

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * The factors worth testing per individual.
 *
 * Deliberately only the two Kent named. This is not a fishing expedition — the
 * multiple-comparison penalty below is real, and every factor added makes every
 * other factor's finding weaker.
 */
export const FACTORS = {
  moon: {
    label: 'moon',
    // Computed from the timestamp rather than read from weather_hours, so it
    // works on any photo whether or not the weather backfill reached that hour.
    valueOf: (ms) => moonPhase(new Date(ms)).illum,
    high: 'bright moons', low: 'dark moons',
    say: v => `${Math.round(v * 100)}% illuminated`,
  },
  pressure: {
    label: 'barometer',
    valueOf: (ms, hour) => (hour && Number.isFinite(hour.pressure) ? hour.pressure : null),
    high: 'high pressure', low: 'low pressure',
    say: v => `${v.toFixed(2)} inHg`,
  },
};

/**
 * A randomization test, stratified by a label.
 *
 * `observed` and `pool` are [{ stratum, value }]. For each shuffle the pool is
 * sampled to match the observed count WITHIN each stratum, so whatever the
 * strata correlate with is held constant rather than measured by accident.
 *
 * Returns null rather than a number when a stratum in the observed set has no
 * pool to draw from — that is not a p-value of 1, it is an unanswerable
 * question, and the two must not look the same.
 */
export function stratifiedTest({ observed, pool, iterations = ITERATIONS, seed = 1 }) {
  const obs = observed.filter(o => Number.isFinite(o.value));
  if (obs.length < 2) return null;

  const byStratum = new Map();
  for (const p of pool) {
    if (!Number.isFinite(p.value)) continue;
    if (!byStratum.has(p.stratum)) byStratum.set(p.stratum, []);
    byStratum.get(p.stratum).push(p.value);
  }
  const need = new Map();
  for (const o of obs) need.set(o.stratum, (need.get(o.stratum) ?? 0) + 1);
  for (const [stratum, n] of need) {
    const have = byStratum.get(stratum);
    // Needs enough to draw from without the draw simply being the pool itself.
    if (!have || have.length < n * 2) return null;
  }

  const observedMean = mean(obs.map(o => o.value));
  const expectedMean = mean(
    [...need].flatMap(([stratum, n]) => {
      const have = byStratum.get(stratum);
      // The stratum's own mean, weighted by how many of the observed fell in it.
      return Array.from({ length: n }, () => mean(have));
    }));

  const rnd = mulberry32(seed);
  let atLeastAsExtreme = 0;
  for (let it = 0; it < iterations; it++) {
    const drawn = [];
    for (const [stratum, n] of need) {
      const have = byStratum.get(stratum);
      for (let k = 0; k < n; k++) drawn.push(have[Math.floor(rnd() * have.length)]);
    }
    const m = mean(drawn);
    if (Math.abs(m - expectedMean) >= Math.abs(observedMean - expectedMean)) atLeastAsExtreme++;
  }
  // +1 on both sides: the observed arrangement is itself one of the
  // possibilities, and leaving it out can report p = 0, which is never true.
  return {
    observed: observedMean,
    expected: expectedMean,
    n: obs.length,
    p: (atLeastAsExtreme + 1) / (iterations + 1),
    iterations,
  };
}

/**
 * One individual against one factor.
 *
 * `sightings` [{ ms, band, hour }] — the individual's own confirmed pictures.
 * `pool`      [{ ms, band, hour }] — every hour it could have been photographed
 *                                    in, at the cameras that have seen it.
 */
export function individualFactor({ name, sightings = [], pool = [], factor,
  minSightings = MIN_SIGHTINGS, seed = 1, iterations = ITERATIONS } = {}) {
  const f = typeof factor === 'string' ? FACTORS[factor] : factor;
  const base = { individual: name, factor: f.label, sightings: sightings.length };

  if (sightings.length < minSightings) {
    return {
      ...base, p: null, verdict: 'not enough sightings',
      why: `${sightings.length} confirmed picture${sightings.length === 1 ? '' : 's'} of `
        + `${name}. Nothing is reported below ${minSightings} — a pattern in a handful `
        + 'of photographs is noise with a decimal point.',
    };
  }

  const value = row => f.valueOf(row.ms, row.hour);
  const result = stratifiedTest({
    observed: sightings.map(s => ({ stratum: s.band, value: value(s) })),
    pool: pool.map(h => ({ stratum: h.band, value: value(h) })),
    iterations, seed,
  });

  if (!result) {
    return {
      ...base, p: null, verdict: 'cannot be answered',
      why: `There are not enough comparable hours to test ${name} against the `
        + `${f.label} — the pictures fall in parts of the day the record barely covers.`,
    };
  }

  const higher = result.observed > result.expected;
  return {
    ...base,
    p: result.p,
    observed: result.observed,
    expected: result.expected,
    verdict: null,           // filled in by the caller, which knows the test count
    direction: higher ? f.high : f.low,
    why: `${name} was photographed at ${f.say(result.observed)} on average, against `
      + `${f.say(result.expected)} for the hours he could have been. Matched on time `
      + `of day, because ${f.label === 'barometer'
        ? 'pressure varies through the day and so does he'
        : 'a nocturnal buck would otherwise look like a lunar one'}.`,
  };
}

/**
 * Every individual against every factor, with the multiple-comparison penalty
 * applied honestly.
 *
 * The threshold divides by the number of tests that actually ran, so adding a
 * buck makes every other buck's finding harder to claim — which is the correct
 * behaviour and the opposite of what a dashboard usually does.
 */
export function judge(results, { alpha = 0.05 } = {}) {
  const testable = results.filter(r => r.p !== null);
  const tests = testable.length;
  const threshold = tests ? alpha / tests : alpha;
  for (const r of results) {
    if (r.p === null) continue;
    r.tests = tests;
    r.threshold = threshold;
    r.verdict = r.p <= threshold ? `follows ${r.direction}` : 'no relationship';
    if (r.p > threshold && r.p <= alpha) {
      r.why += ` It would clear a bare 5% bar (p ${r.p.toFixed(3)}), but ${tests} `
        + 'tests were run and one of them looking real is what chance does. Not called.';
    } else if (r.p <= threshold) {
      r.why += ` p ${r.p.toFixed(4)}, against a ${threshold.toFixed(4)} bar that already `
        + `accounts for the ${tests} tests run. This is about ${r.individual} and nobody else.`;
    }
  }
  return { results, tests, threshold, alpha };
}

// ---------------------------------------------------------------------------
// Reading it out of the database
// ---------------------------------------------------------------------------

/**
 * Test every named buck with enough pictures against the moon and the barometer.
 *
 * Returns the findings AND the refusals, because "Split G2 has 4 pictures" is
 * the answer to "does he follow the moon" far more often than any verdict is,
 * and hiding it would make the feature look broken rather than honest.
 */
export function individualsFor(db, { minSightings = MIN_SIGHTINGS,
  iterations = ITERATIONS, seed = 1 } = {}) {
  const bucks = db.prepare('SELECT id, name FROM bucks ORDER BY name').all();
  if (!bucks.length) {
    return { results: [], tests: 0, note: 'No bucks named yet. Name one in review and '
      + 'this can start asking whether he follows anything.' };
  }

  const cams = db.prepare(`
    SELECT id, name, lat, lng, weather_location_id AS loc FROM cameras
    WHERE lat IS NOT NULL AND lng IS NOT NULL
  `).all();
  const byCam = new Map(cams.map(c => [c.id, c]));

  // Hours per camera, tagged with their light band and carrying the pressure.
  const hoursCache = new Map();
  const indexCache = new Map();
  const hoursFor = cam => {
    if (!hoursCache.has(cam.id)) {
      const rows = cam.loc === null ? [] : db.prepare(
        'SELECT hour_utc, wind_dir, temp_f, pressure_inhg FROM weather_hours WHERE location_id = ?'
      ).all(cam.loc);
      const tagged = tagHours(rows, { lat: cam.lat, lng: cam.lng });
      // tagHours does not carry pressure, so pair them back up by hour key.
      const press = new Map(rows.map(r => [(r.hour_utc ?? '').slice(0, 13), r.pressure_inhg]));
      const built = tagged.map(h => ({
        ms: h.ms, band: h.band, key: h.key,
        hour: { pressure: press.get(h.key) ?? null },
      }));
      hoursCache.set(cam.id, built);
      // Indexed by hour, because looking a sighting's hour up with .find()
      // walks a season of weather per photograph — fine on a fixture, quadratic
      // on a real season.
      indexCache.set(cam.id, new Map(built.map(h => [h.key, h])));
    }
    return hoursCache.get(cam.id);
  };
  const hourAt = (cam, key) => {
    hoursFor(cam);
    return indexCache.get(cam.id).get(key) ?? null;
  };

  const results = [];
  for (const buck of bucks) {
    const rows = db.prepare(`
      SELECT ph.taken_at AS takenAt, ph.camera_id AS cameraId
      FROM detections d
      JOIN photos ph ON ph.id = d.photo_id
      WHERE d.confirmed = 1 AND d.buck_id = ? AND ph.taken_at IS NOT NULL
    `).all(buck.id);

    const seenAt = new Set();
    const sightings = [];
    for (const r of rows) {
      const cam = byCam.get(r.cameraId);
      const ms = Date.parse(r.takenAt);
      if (!cam || !Number.isFinite(ms)) continue;
      seenAt.add(cam.id);
      const hour = hourAt(cam, new Date(ms).toISOString().slice(0, 13));
      sightings.push({ ms, band: hour?.band ?? 'unknown', hour: hour?.hour ?? { pressure: null } });
    }
    // The pool is the hours at the cameras that have actually seen him. Using
    // every camera on the property would compare him against ground he has
    // never been photographed on.
    const pool = [...seenAt].flatMap(id => hoursFor(byCam.get(id)));

    for (const key of Object.keys(FACTORS)) {
      results.push(individualFactor({
        name: buck.name, sightings, pool, factor: key, minSightings, seed, iterations,
      }));
    }
  }

  return {
    ...judge(results),
    note: 'The population weight for both of these stays zero — no collar study '
      + 'supports it. This asks a different question: whether THIS animal, on THIS '
      + 'ground, in your own photographs, does something the population does not.',
  };
}
