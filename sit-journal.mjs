/**
 * sit-journal.mjs — what the record of your own sits is actually able to say.
 *
 * Every prediction this program makes has, until now, been unfalsifiable. The
 * planner rates an evening "prime", the stand ranking picks a stand, the route
 * checker calls a walk clean — and nothing anywhere records whether a deer ever
 * turned up. That is not a small gap. It means the tool has been reasoning from
 * general theory about deer, on ground it has never been checked against, and
 * could have been wrong all season without a single number moving.
 *
 * The journal closes that loop. This file is the half that draws conclusions
 * from it, and its most important job is REFUSING to.
 *
 * The three ways a season of sits will lie to you, all of them handled here:
 *
 * 1. THE SAMPLE IS TINY. Twenty sits is a good season and a terrible data set.
 *    A correlation on eight sits is noise with a decimal point, so nothing is
 *    reported until there is enough of it, and what "enough" means is stated
 *    rather than assumed.
 *
 * 2. YOU HUNT THE GOOD DAYS. This is the serious one, and no amount of
 *    arithmetic fixes it. If you only sit when the planner says prime, every
 *    row in the table is a prime evening and there is nothing to compare
 *    against — the tool would score itself 100% correct while having predicted
 *    nothing at all. So the spread of ratings you actually hunted is measured
 *    and reported, and a set with no variation gets a refusal, not a number.
 *
 * 3. "SAW NOTHING" AND "DID NOT COUNT" ARE DIFFERENT. A blank must never read
 *    as a zero, or every sit you forgot to fill in becomes evidence of no deer.
 *    Nulls are excluded from every average and counted separately.
 *
 * Where a claim survives all three, it is reported with a p-value from a
 * permutation test rather than a table lookup — the sample is far too small
 * and far too non-normal for anything that assumes a distribution.
 */

/** Below this many usable sits, no correlation is reported at all. */
export const MIN_SITS = 12;

/** And the ratings hunted must vary: at least two buckets with this many each. */
export const MIN_PER_BUCKET = 3;

export const RATING_ORDER = ['poor', 'fair', 'good', 'strong', 'prime'];

const ratingRank = r => {
  const i = RATING_ORDER.indexOf(String(r ?? '').toLowerCase());
  return i === -1 ? null : i;
};

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Deterministic PRNG, so a reported p-value is the same every time it is read. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ranks, averaging ties — which matters here, because ratings tie constantly. */
export function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

/**
 * Spearman's rank correlation.
 *
 * Rank rather than Pearson because a rating is ordinal — the distance from
 * "fair" to "good" is not a number — and because deer counts are a handful of
 * small integers with the occasional six in them, where one good evening would
 * dominate a Pearson coefficient completely.
 */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs), ry = ranks(ys);
  const n = xs.length;
  const mean = a => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;   // no variation: no correlation exists
  return num / Math.sqrt(dx * dy);
}

/**
 * How surprising that correlation is, by shuffling.
 *
 * A permutation test rather than a table: with a dozen points, ties everywhere
 * and no reason to believe any distribution, the assumptions behind a textbook
 * p-value do not hold. Shuffling one column and counting how often chance beats
 * the observed correlation makes no assumptions at all.
 */
export function permutationP(xs, ys, { iterations = 5000, seed = 1 } = {}) {
  const observed = spearman(xs, ys);
  if (observed === null) return null;
  const rnd = mulberry32(seed);
  const shuffled = ys.slice();
  let atLeastAsExtreme = 0;
  for (let it = 0; it < iterations; it++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const r = spearman(xs, shuffled);
    if (r !== null && Math.abs(r) >= Math.abs(observed)) atLeastAsExtreme++;
  }
  // +1 on both sides: the observed arrangement is itself one of the
  // possibilities, and leaving it out can report p = 0, which is never true.
  return (atLeastAsExtreme + 1) / (iterations + 1);
}

/** Sits that can be scored: a rating was recorded, and deer were counted. */
export const usableSits = sits => sits.filter(s =>
  ratingRank(s.predicted?.rating ?? s.predicted_rating) !== null && isNum(s.deer));

/**
 * Does the planner's rating track what you actually see?
 *
 * The answer is usually "not enough sits to say", and that is a real answer.
 */
export function calibration(sits = [], { seed = 1, iterations = 5000 } = {}) {
  const usable = usableSits(sits);
  const buckets = new Map();
  for (const s of usable) {
    const key = String(s.predicted?.rating ?? s.predicted_rating).toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s.deer);
  }
  const byRating = RATING_ORDER
    .filter(r => buckets.has(r))
    .map(r => {
      const d = buckets.get(r);
      return {
        rating: r, sits: d.length,
        deerPerSit: Math.round(100 * d.reduce((a, b) => a + b, 0) / d.length) / 100,
        blank: 0,
      };
    });

  const spread = byRating.filter(b => b.sits >= MIN_PER_BUCKET).length;
  const counted = sits.filter(s => isNum(s.deer)).length;
  const uncounted = sits.length - counted;

  const base = {
    sits: sits.length, usable: usable.length, uncounted,
    byRating,
    // Reported whether or not a verdict follows, because this IS the finding
    // when someone only hunts the good days.
    ratingsHunted: byRating.length,
    spread,
  };

  if (usable.length < MIN_SITS) {
    return {
      ...base, rho: null, p: null, verdict: 'not enough sits',
      why: `${usable.length} sit${usable.length === 1 ? '' : 's'} with both a rating and a `
        + `deer count. Nothing is reported below ${MIN_SITS} — a correlation on a `
        + 'handful of evenings is noise with a decimal point.',
    };
  }
  if (spread < 2) {
    return {
      ...base, rho: null, p: null, verdict: 'no comparison group',
      why: 'You have only really hunted one class of day, so there is nothing to '
        + 'compare against. The tool would score itself right about every sit while '
        + 'having predicted nothing at all. Sit a few mediocre evenings and this '
        + 'becomes answerable.',
    };
  }

  const xs = usable.map(s => ratingRank(s.predicted?.rating ?? s.predicted_rating));
  const ys = usable.map(s => s.deer);
  const rho = spearman(xs, ys);
  if (rho === null) {
    return { ...base, rho: null, p: null, verdict: 'no variation', why: 'Every sit scored the same.' };
  }
  const p = permutationP(xs, ys, { iterations, seed });
  // The shuffle test can only ever bound p from below — with 5,000 shuffles the
  // smallest it can report is 1/5001 — so a rounded "0.000" would be claiming a
  // precision the method does not have, and an impossibility besides.
  const pText = p < 1 / iterations ? `< ${(1 / iterations).toFixed(4)}` : p.toFixed(3);

  const strength = Math.abs(rho) < 0.2 ? 'no relationship worth acting on'
    : Math.abs(rho) < 0.4 ? 'a weak relationship'
    : Math.abs(rho) < 0.6 ? 'a moderate relationship'
    : 'a strong relationship';
  const direction = rho > 0 ? 'the way it should' : 'BACKWARDS';

  return {
    ...base,
    rho: Math.round(rho * 100) / 100,
    p: Math.round(p * 10000) / 10000,
    pText,
    iterations,
    verdict: p <= 0.05 ? strength : 'not distinguishable from chance',
    why: p <= 0.05
      ? `${strength}, running ${direction} (rho ${rho.toFixed(2)}, p ${pText} `
        + `from a shuffle test on ${usable.length} sits).`
      : `Rho is ${rho.toFixed(2)}, but shuffling the deer counts produces a correlation `
        + `that big ${Math.round(p * 100)}% of the time, so this is not yet `
        + 'distinguishable from chance.',
    caveat: 'You choose which days to hunt, and you choose them using this tool. '
      + 'That makes this a check on whether the ratings order YOUR sits correctly, '
      + 'not an experiment — nothing here can rule out the days you stayed home.',
  };
}

/**
 * How often the forecast wind was the wind you got.
 *
 * Useful long before there are enough sits to say anything about deer, and it
 * needs no deer at all: it says how much to trust a forecast on your ground,
 * which is the input every other judgement here rests on.
 */
export function windAccuracy(sits = [], { withinPoints = 1 } = {}) {
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const rows = sits.filter(s =>
    (s.predicted?.windFrom ?? s.predicted_wind) && s.wind_from);
  if (!rows.length) {
    return { sits: 0, exact: null, close: null,
      why: 'No sit has both a forecast wind and the wind you recorded.' };
  }
  let exact = 0, close = 0;
  for (const s of rows) {
    const a = COMPASS.indexOf(s.predicted?.windFrom ?? s.predicted_wind);
    const b = COMPASS.indexOf(s.wind_from);
    if (a === -1 || b === -1) continue;
    const gap = Math.min((a - b + 16) % 16, (b - a + 16) % 16);
    if (gap === 0) exact++;
    if (gap <= withinPoints) close++;
  }
  return {
    sits: rows.length,
    exact: Math.round(100 * exact / rows.length),
    close: Math.round(100 * close / rows.length),
    withinPoints,
    why: `Across ${rows.length} sit${rows.length === 1 ? '' : 's'}, the forecast named `
      + `the exact compass point ${Math.round(100 * exact / rows.length)}% of the time and `
      + `came within ${withinPoints} point${withinPoints === 1 ? '' : 's'} `
      + `${Math.round(100 * close / rows.length)}% of the time.`,
  };
}

/**
 * Which stands actually produce.
 *
 * Deliberately blunt about sample size per stand, because this is the number
 * people most want to believe and the one they have least data for. Three sits
 * in a stand tells you about those three evenings.
 */
export function standPerformance(sits = [], { minSits = 4 } = {}) {
  const by = new Map();
  for (const s of sits) {
    const key = s.stand_id ?? 'none';
    if (!by.has(key)) {
      by.set(key, { standId: s.stand_id ?? null, name: s.stand_name ?? 'no stand recorded', sits: [] });
    }
    by.get(key).sits.push(s);
  }
  const rows = [...by.values()].map(g => {
    const counted = g.sits.filter(s => isNum(s.deer));
    const deer = counted.reduce((a, s) => a + s.deer, 0);
    return {
      standId: g.standId, name: g.name,
      sits: g.sits.length,
      counted: counted.length,
      uncounted: g.sits.length - counted.length,
      deer: counted.length ? deer : null,
      deerPerSit: counted.length ? Math.round(100 * deer / counted.length) / 100 : null,
      bucks: g.sits.reduce((a, s) => a + (isNum(s.bucks) ? s.bucks : 0), 0),
      // The honesty flag the page has to show, not a footnote it can drop.
      enough: counted.length >= minSits,
    };
  });
  rows.sort((a, b) => (b.deerPerSit ?? -1) - (a.deerPerSit ?? -1));
  return {
    stands: rows,
    minSits,
    note: rows.every(r => !r.enough)
      ? `No stand has ${minSits} counted sits yet, so none of these averages means much.`
      : null,
  };
}

/** The plain totals, which are worth having on their own. */
export function summary(sits = []) {
  const counted = sits.filter(s => isNum(s.deer));
  const hours = sits.reduce((a, s) => {
    if (!s.started_at || !s.ended_at) return a;
    const h = (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 3600000;
    return Number.isFinite(h) && h > 0 && h < 24 ? a + h : a;
  }, 0);
  const deer = counted.reduce((a, s) => a + s.deer, 0);
  return {
    sits: sits.length,
    counted: counted.length,
    uncounted: sits.length - counted.length,
    hours: Math.round(hours * 10) / 10,
    deer: counted.length ? deer : null,
    deerPerSit: counted.length ? Math.round(100 * deer / counted.length) / 100 : null,
    // Per hour is the fairer comparison between a two-hour evening and an
    // all-day rut sit, where it is available.
    deerPerHour: hours > 0 && counted.length ? Math.round(100 * deer / hours) / 100 : null,
    bucks: sits.reduce((a, s) => a + (isNum(s.bucks) ? s.bucks : 0), 0),
    shots: sits.filter(s => s.shot).length,
    harvests: sits.filter(s => s.harvested).length,
    blankSits: counted.filter(s => s.deer === 0).length,
  };
}
