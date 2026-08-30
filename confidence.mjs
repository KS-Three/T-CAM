/**
 * confidence.mjs — the score as a percentage that means something.
 *
 * Asked for on 2026-08-30: replace the planner's additive score with a
 * confidence level, "100% guaranteed to see a deer".
 *
 * The honest version of that, and the reason it is built the way it is below.
 * A percentage is only worth printing if it answers a question that has a real
 * answer, and there are two different questions hiding in the ask:
 *
 * 1. **"How good is tonight?"** — a real question with a real answer, because
 *    the planner already scores it. That answer is a RANKING, not a chance of
 *    anything, so it is reported as `conditions` and labelled as conditions.
 *    It is just the published PRIME/strong/good/fair/poor scale remapped onto
 *    0–100, which is what a percentage of a score can honestly mean.
 *
 * 2. **"Will I see a deer?"** — also a real question, and answerable, but only
 *    where there is evidence: your own cameras, in these conditions, at this
 *    stand. That is what `analysis.mjs` measures. Given a rate of sightings per
 *    hour, the chance of at least one in a sit of `t` hours is the standard
 *    arrival model, `1 - exp(-rate * t)`. It is reported as `deerChance` and
 *    it is ABSENT where no tagged sighting supports it — not defaulted, not
 *    guessed from the weather.
 *
 * Which is why there is no single number here. Merging the two would produce
 * exactly the kind of figure this program exists not to print: a confident
 * percentage that looks measured and is not. A hunter reading "78%" deserves to
 * know whether that is "these are good conditions" or "four out of five sits
 * like this one produced a deer", because those justify very different drives.
 *
 * **100% is deliberately unreachable.** The arrival model approaches it and
 * never arrives, and that is correct: a deer walking past is not something any
 * weather guarantees. The cap is stated rather than hidden.
 *
 * **What is measured and what is judged**, so the two are never confused:
 *
 * - MEASURED: the sighting rate per hour, from your confirmed tags, in matching
 *   conditions, over the days the compared cameras were all watching.
 * - JUDGED: how much a good night multiplies that rate (`activityFactor`), and
 *   what a standing or freshly cut crop is worth. Both are named in the output
 *   with their reasoning, the same way every planner factor already is.
 * - NOT USED: published GPS-collar movement rates. Nine open datasets exist and
 *   `calibrate-planner.mjs` can read them, but none has been run against this
 *   ground yet, so nothing here is grounded in collar research and this file
 *   does not pretend otherwise. When it is run, `activityFactor` is the one
 *   function it should replace.
 */

import { RATINGS } from './hunt-planner.mjs';

/**
 * The percentage bands the published words map onto, worst first.
 *
 * Read off `RATINGS` rather than restated, so the word and the number cannot
 * disagree. Within a band the score is interpolated, which keeps the ordering
 * of two "strong" evenings intact instead of flattening them to one figure.
 */
export const BANDS = [
  { word: 'poor', from: 0, to: 25 },
  { word: 'fair', from: 25, to: 45 },
  { word: 'good', from: 45, to: 65 },
  { word: 'strong', from: 65, to: 85 },
  { word: 'PRIME', from: 85, to: 100 },
];

/** The score thresholds, lowest first, paired with their band. */
const SCALE = (() => {
  const asc = [...RATINGS].sort((a, b) => a[0] - b[0]);
  return BANDS.map(b => {
    const found = asc.find(([, w]) => w === b.word);
    return { ...b, score: found ? found[0] : 0 };
  });
})();

// A score this far above PRIME reads as 100. Chosen from the planner's own
// weights: PRIME starts at 46 and the factors can stack to the mid-60s, so the
// top band has room to be a range rather than a single pinned value.
export const CEILING = 64;

/**
 * How far below the "fair" threshold the bottom band is spread.
 *
 * The planner's lowest threshold is the sentinel -999, which means "everything
 * else" and is not a score anybody sees. Interpolating across it would squeeze
 * every poor evening into the top hair of the poor band — a score of 0 and a
 * score of -20 would both read 24.9%. Twenty points is roughly the width of the
 * bands above, so the bottom of the scale behaves like the rest of it.
 */
export const POOR_SPAN = 20;

/**
 * The planner's additive score as 0–100.
 *
 * Monotonic, so it can never reorder two evenings the planner ranked — a
 * percentage disagreeing with the list it sits in would be worse than no
 * percentage at all. It is a remapping of the published PRIME/strong/good/fair
 * scale and nothing more: 78% here means "a strong evening", not "78% of
 * anything happening".
 */
export function conditionsPct(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= CEILING) return 100;

  // Every band except the sentinel at the bottom, lowest first.
  const real = SCALE.filter(b => b.score > -900);
  const top = real[real.length - 1];
  if (score >= top.score) {
    return round1(top.from + (top.to - top.from) * (score - top.score) / (CEILING - top.score));
  }
  for (let i = real.length - 2; i >= 0; i--) {
    const b = real[i], next = real[i + 1];
    if (score >= b.score) {
      return round1(b.from + (b.to - b.from) * (score - b.score) / (next.score - b.score));
    }
  }
  const lowest = real[0];               // "fair" — the bottom real threshold
  const poor = SCALE[0];                // the 0–25 band under it
  return round1(Math.max(0,
    poor.to * (score - (lowest.score - POOR_SPAN)) / POOR_SPAN));
}

const round1 = n => Math.round(n * 10) / 10;

/**
 * How much a night's conditions multiply the ordinary rate of deer movement.
 *
 * A JUDGEMENT, and the one number here most worth replacing with a measured
 * one. The shape is a doubling curve anchored at the planner's own "good"
 * threshold: a good evening is the baseline (1x), and every `SPAN` points
 * either side doubles or halves it. That puts a PRIME night at roughly 2x an
 * ordinary one and a poor night at about half — which is the right order of
 * magnitude for daylight movement in the published literature, and is not a
 * measurement of anything on this property.
 *
 * Bounded at both ends on purpose. An unbounded multiplier would let a freak
 * score claim deer are moving eight times as much, which no weather does.
 */
export const NEUTRAL_SCORE = 24;   // the planner's "good"
export const SPAN = 22;            // points per doubling
export const MIN_FACTOR = 0.35;
export const MAX_FACTOR = 2.5;

export function activityFactor(score) {
  if (!Number.isFinite(score)) return 1;
  const raw = 2 ** ((score - NEUTRAL_SCORE) / SPAN);
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, round2(raw)));
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * The chance of at least one deer during a sit, from a measured rate.
 *
 * The arrival model: sightings land independently at some average rate, so the
 * chance of none in `hours` is exp(-rate * hours) and the chance of at least
 * one is its complement. It is the right model for "will something walk past",
 * it needs only the one number the cameras actually measure, and it approaches
 * 100% without reaching it — which is the honest shape for this question.
 *
 * `null` in, `null` out. No rate means no answer, not a low one.
 */
export const MAX_PCT = 97;

export function deerChance({ ratePerHour, hours, factor = 1 } = {}) {
  if (!Number.isFinite(ratePerHour) || ratePerHour < 0) return null;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const lambda = ratePerHour * (Number.isFinite(factor) ? factor : 1);
  const pct = 100 * (1 - Math.exp(-lambda * hours));
  // Capped, and the cap is a statement rather than a rounding artefact: no
  // arrangement of weather guarantees a deer.
  return round1(Math.min(MAX_PCT, pct));
}

/** Hours between two instants, or null if either is unusable. */
export function sitHours(start, end) {
  const a = Date.parse(start ?? ''), b = Date.parse(end ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return (b - a) / 3600000;
}

// ---------------------------------------------------------------------------
// Crops
// ---------------------------------------------------------------------------

/** Metres within which a field is "at" a stand. */
export const FIELD_NEAR_M = 250;
/** A cut field pulls deer hardest while the grain is still on the ground. */
export const FRESH_CUT_DAYS = 14;

// Judgements, named and weighted small next to the rut and a front — the same
// discipline the planner's moon factor gets. A standing cornfield is bedding
// and food at once; the fortnight after it is cut is the single biggest
// reorganisation of evening traffic a property sees.
const CROP_PULL = {
  corn: 1.25, soybeans: 1.25, brassicas: 1.2, clover: 1.15,
  alfalfa: 1.15, 'winter-wheat': 1.1, oats: 1.1, pasture: 1, other: 1,
};

/**
 * What the crop next to a stand is worth tonight, as a multiplier and a
 * sentence. Null where there is no field near enough to say anything — silence
 * rather than 1.0 with an explanation nobody asked for.
 */
export function fieldModifier(stand, fields, { now = new Date(), distanceM } = {}) {
  if (!stand || !Array.isArray(fields) || !fields.length || !distanceM) return null;
  let best = null;
  for (const f of fields) {
    const pts = Array.isArray(f.points) ? f.points : [];
    if (!pts.length) continue;
    // Nearest outline point is ample: a field is judged by whether the stand is
    // on it, not by exactly which corner.
    let near = Infinity;
    for (const p of pts) {
      const lng = Number(p[0]), lat = Number(p[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      near = Math.min(near, distanceM(stand.lat, stand.lng, lat, lng));
    }
    if (near > FIELD_NEAR_M) continue;
    const cutMs = Date.parse(f.cut_at ?? f.cutAt ?? '');
    const cutDays = Number.isFinite(cutMs) ? (now.getTime() - cutMs) / 86400000 : null;
    const name = f.name || f.crop;

    let factor, why;
    if (cutDays !== null && cutDays >= 0 && cutDays <= FRESH_CUT_DAYS) {
      factor = 1.35;
      why = `${name} was cut ${Math.round(cutDays)} day${Math.round(cutDays) === 1 ? '' : 's'} ago — grain on the ground pulls hard for a fortnight`;
    } else if (cutDays !== null && cutDays > FRESH_CUT_DAYS) {
      factor = 0.85;
      why = `${name} was cut ${Math.round(cutDays)} days ago — picked over, and the cover is gone`;
    } else {
      factor = CROP_PULL[f.crop] ?? 1;
      why = factor > 1
        ? `standing ${f.crop} ${Math.round(near)} m off — food and cover in the same place`
        : `${f.crop} ${Math.round(near)} m off`;
    }
    if (!best || Math.abs(factor - 1) > Math.abs(best.factor - 1)) {
      best = { factor, why, metres: Math.round(near), crop: f.crop, name };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The assembled answer
// ---------------------------------------------------------------------------

/**
 * Everything the page needs to show one number honestly.
 *
 * Returns both figures and never merges them: `conditions` is always there
 * because the planner always has a score; `deerChance` appears only where the
 * cameras have earned it. `basis` says in one phrase which of the two the page
 * is entitled to lead with.
 */
export function confidence({
  score, start, end, hours: givenHours = null,
  ratePerHour = null, sightings = null, observedHours = null,
  stand = null, fields = null, distanceM = null, now = new Date(),
} = {}) {
  const hours = givenHours ?? sitHours(start, end);
  const factor = activityFactor(score);
  const field = fieldModifier(stand, fields, { now, distanceM });
  const parts = [];
  if (Number.isFinite(score)) {
    parts.push({ factor, why: `conditions score ${Math.round(score)} — ${describeFactor(factor)}` });
  }
  if (field) parts.push({ factor: field.factor, why: field.why });

  const combined = parts.reduce((a, p) => a * p.factor, 1);
  const chance = deerChance({ ratePerHour, hours, factor: combined });

  return {
    conditions: conditionsPct(score),
    deerChance: chance,
    // The evidence, carried with the number so the page never has to show one
    // without the other. This is the evidence bar from design.md, applied to a
    // percentage: a bare 58% hides that it rests on four sightings.
    evidence: chance === null ? null : {
      sightings, hours: observedHours, ratePerHour: round3(ratePerHour),
    },
    hours: hours === null ? null : round1(hours),
    factor: round2(combined),
    parts,
    basis: chance === null ? 'conditions' : 'sightings',
    // Said in words, because "58%" alone invites the reading this file exists
    // to prevent.
    says: chance === null
      ? 'No confirmed sighting supports a number here yet — this is how good the conditions are, not a chance of seeing a deer.'
      : `About ${chance}% chance a deer walks past in ${round1(hours)} hours, from ${plural(sightings, 'sighting')} in ${observedHours} hours of weather like this.`,
  };
}

const round3 = n => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);
const plural = (n, w) => `${n} ${n === 1 ? w : w + 's'}`;

function describeFactor(f) {
  if (f >= 1.6) return 'deer should move well above normal';
  if (f >= 1.15) return 'better than an ordinary evening';
  if (f > 0.85) return 'about an ordinary evening';
  if (f > 0.6) return 'below an ordinary evening';
  return 'deer should hold tight';
}
