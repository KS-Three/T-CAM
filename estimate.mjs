/**
 * estimate.mjs — how often a deer passes a camera, with the interval attached.
 *
 * The number Kent asked for, built under the five constraints he settled after
 * being argued with. Each of them exists to stop a specific lie, and each is
 * enforced here rather than left to whoever renders the result.
 *
 *   1. The interval is never optional. `point` alone is not a public field of
 *      this module's output — it comes with `lo` and `hi` or not at all.
 *   2. It claims CAMERA REPEAT and nothing else. P(this camera photographs a
 *      deer again in that light band). It is never multiplied by a guess about
 *      whether the animal then walks past a stand, so the metres between the
 *      two are named by the caller and priced by nobody.
 *   3. The subject is the SITE by default. "A deer passes here" needs no
 *      identity and is the fact the data supports; an individual's own rate
 *      appears only when that individual is actually identified, and the two
 *      are reported separately rather than blended.
 *   4. Time bins come from the sun: dawn, day, dusk, night, each 1.5 h either
 *      side of the crossing — evidence.mjs's own definition, re-anchored to the
 *      solar day by bandFor() below. There is no window parameter,
 *      deliberately: a width you can set is a width you widen until the answer
 *      flatters you.
 *   5. The denominator is CAMERA-LIVE days, from camera-days.mjs. A day the
 *      camera was out of quota, silent, or never recorded is not a day the deer
 *      did not come, and is excluded and counted separately.
 *
 * ## What it still cannot fix
 *
 * The interval is a Wilson binomial interval, which assumes independent trials.
 * Ten days of one deer are not ten coin flips: they are one food source, one
 * pressure level, one moon, mildly perturbed. So the true uncertainty is WIDER
 * than the interval printed here, never narrower. That is stated in the output
 * rather than buried, because a number that looks more precise than it is will
 * be believed exactly that much.
 */

import { sunTimes, TWILIGHT_HOURS, MIN_HOURS } from './evidence.mjs';
import { summarise, dayOf } from './camera-days.mjs';

/** The light bands a person can actually hunt, and the one they cannot. */
export const BANDS = ['dawn', 'day', 'dusk', 'night'];

/**
 * Which band an instant falls in, against ITS OWN solar day's sun.
 *
 * evidence.mjs lightBand() takes the sun times for the UTC day of the instant,
 * which is right everywhere the two agree and wrong west of Greenwich near
 * midnight UTC. At this longitude a 19:30 dusk visit is 01:30 UTC the next day,
 * so lightBand looks up the FOLLOWING evening's sunset — twenty-three hours
 * away — and calls a deer at last light "night". Every dusk sighting in a
 * Wisconsin account, silently dropped from the one band a person most wants.
 *
 * So the sun is looked up at midday of the instant's own solar day. Same
 * sunTimes, same TWILIGHT_HOURS either side, same definition of a band — only
 * the day it is anchored to differs, and that is the thing that was wrong.
 */
export function bandFor(whenMs, lat, lng) {
  if (!Number.isFinite(whenMs)) return 'unknown';
  const offset = (typeof lng === 'number' && Number.isFinite(lng) ? (lng / 15) * 3600000 : 0);
  // Midday of the solar day this instant belongs to, expressed back in UTC.
  const solarNoon = Date.parse(
    new Date(whenMs + offset).toISOString().slice(0, 10) + 'T12:00:00Z') - offset;
  const { sunrise, sunset, polar } = sunTimes(solarNoon, lat, lng);
  if (polar || sunrise === null || sunset === null) return 'unknown';
  const w = TWILIGHT_HOURS * 3600000;
  if (whenMs >= sunrise - w && whenMs <= sunrise + w) return 'dawn';
  if (whenMs >= sunset - w && whenMs <= sunset + w) return 'dusk';
  if (whenMs > sunrise + w && whenMs < sunset - w) return 'day';
  return 'night';
}

/**
 * Fewest camera-live days before any figure is quoted.
 *
 * The same bar the stand report already refuses below — evidence.mjs MIN_HOURS,
 * reused rather than re-chosen, so one standard governs what this program is
 * willing to claim. Below it the counts are still shown; only the estimate is
 * withheld, because 3 of 3 days reads as 100% to the eye however wide the
 * interval beside it.
 */
export const MIN_LIVE_DAYS = MIN_HOURS;

/** 95%. */
export const Z95 = 1.959963984540054;

/**
 * The Wilson score interval for k successes of n.
 *
 * Wilson rather than the textbook normal approximation because at the counts
 * this program will actually see — 9 of 10, 3 of 3 — the normal one produces
 * intervals that run past 1 or below 0, and an upper bound of 1.08 destroys a
 * reader's trust faster than a wide honest one.
 */
export function wilson(k, n, z = Z95) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return {
    point: p,
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
  };
}

const pct = v => Math.round(v * 100);

/**
 * How often a camera photographs a deer in one light band.
 *
 * `days`   camera_days rows for this camera (see db.cameraDays)
 * `visits` [{ startedAt }] for this camera — every visit, not pre-filtered
 * `band`   one of BANDS
 * `lat`, `lng` the camera's position: the sun decides the bands, and the
 *          longitude decides which solar day a dusk sighting belongs to
 * `from`, `to`  the span asked about, as YYYY-MM-DD
 *
 * Returns the counts always, and an estimate only when there is enough to
 * support one.
 */
export function estimate({ days = [], visits = [], band = 'dawn',
  lat, lng, from, to, minLiveDays = MIN_LIVE_DAYS } = {}) {
  const span = summarise(days, { from, to });
  const liveDays = new Set(span.days.filter(d => d.state === 'live').map(d => d.day));

  // A visit counts only if it happened on a day the camera was demonstrably
  // watching AND in the band being asked about. A sighting on a quota-dark day
  // is real, but it cannot be divided by anything: there is no denominator it
  // belongs to.
  const seenDays = new Set();
  let offLive = 0;
  for (const v of visits) {
    const t = Date.parse(v?.startedAt ?? v?.started_at ?? '');
    if (!Number.isFinite(t)) continue;
    if (bandFor(t, lat, lng) !== band) continue;
    const day = dayOf(new Date(t).toISOString(), lng);
    if (liveDays.has(day)) seenDays.add(day);
    else offLive++;
  }

  const live = liveDays.size;
  const seen = seenDays.size;
  const excluded = {
    quotaDark: span.quotaDark, silent: span.silent, unknown: span.unknown,
    sightingsOnUnusableDays: offLive,
  };

  const base = {
    band, live, seen, excluded, span: span.span,
    subject: 'any deer', minLiveDays,
    // Said in the output, not in a comment somewhere: the interval assumes
    // independent days and they are not independent.
    caveat: 'days are not independent trials — the real uncertainty is wider '
      + 'than this interval, never narrower',
  };

  if (live < minLiveDays) {
    return {
      ...base, point: null, lo: null, hi: null,
      refused: `${live} camera-live day${live === 1 ? '' : 's'} of ${minLiveDays} needed`,
    };
  }
  const w = wilson(seen, live);
  return { ...base, ...w, refused: null };
}

/**
 * One line a person can read, refusal included.
 *
 * There is no formatter here that prints the point estimate without its
 * interval. That is the constraint made structural: you cannot accidentally
 * render the confident half on its own.
 */
export function estimateLine(e) {
  if (!e) return null;
  const head = `${e.subject}, ${e.band}: seen on ${e.seen} of ${e.live} camera-live days`;
  const dropped = [];
  if (e.excluded.quotaDark) dropped.push(`${e.excluded.quotaDark} quota-dark`);
  if (e.excluded.silent) dropped.push(`${e.excluded.silent} silent`);
  if (e.excluded.unknown) dropped.push(`${e.excluded.unknown} never recorded`);
  const tail = dropped.length ? ` (${dropped.join(', ')} excluded)` : '';

  if (e.refused) return `${head}${tail} — NOT RANKED: ${e.refused}`;
  return `${head}${tail} — ${pct(e.point)}%, ${pct(e.lo)}–${pct(e.hi)}% at 95%`;
}
