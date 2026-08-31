/**
 * cropseason.mjs — reading a season out of a field's NDVI curve.
 *
 * sentinel.mjs produces the curve; this module says what it means. Two
 * questions, answered with very different confidence, and the difference is
 * the point of this file:
 *
 * IS IT STANDING OR CUT — reliable, and the one that matters for hunting.
 * A crop coming off is a step change in greenness, and needs no reference
 * data at all: the field is compared against its own peak. stand-context.mjs
 * already branches on a fresh cut, and this is where that fact can come from
 * without anyone typing it in.
 *
 * WHAT IS PLANTED — usually refused, honestly. Corn and soybeans do separate
 * in NDVI, and strongly. Measured near Ames, Iowa for 2025 from 27 corn and
 * 23 soybean CDL-labelled points:
 *
 *     Jun 19   corn 0.806   soy 0.406    corn canopied, soy barely emerged
 *     Jul 14   corn 0.906   soy 0.882    indistinguishable
 *     Aug 28   corn 0.648   soy 0.909    corn senescing, soy still green
 *
 * But that separation has to be calibrated against local fields of a KNOWN
 * crop, and Kent's ground is not the corn belt: a 2 km sample around the
 * property came back 40% woody wetland, 16% corn and 4% soybeans — one
 * soybean point in twenty-five. So the reference set usually cannot be built,
 * and this module says so rather than extrapolating from Iowa. A refusal you
 * can see beats a number you cannot check.
 *
 * WHY THE ALIGNMENT WINDOW IS NARROW. Reference curves come from last season,
 * and planting dates move between years, so curves are compared after a small
 * time shift. That window must stay well inside the corn/soybean phenology
 * gap. At +-24 days the corn curve slides onto soybeans and the RMSE between
 * them collapses from 0.238 to 0.035 — the alignment erases the very
 * difference being measured. Hence +-12 days, and a penalty on top so a large
 * shift has to earn itself. There is a test named for this.
 */

import { cropAt, latestCdlYear, rotationPrior } from './cropscan.mjs';
import { searchScenes, ndviSeries, ringCentre } from './sentinel.mjs';

// --- standing or cut -------------------------------------------------------

/** Below this a field is bare ground however green it once was. */
export const CUT_LEVEL = 0.35;

/** A fall of at least this much is a harvest rather than weather noise. */
export const CUT_DROP = 0.20;

/** A drop seen across more days than this could be a slow drydown instead. */
export const FAST_DAYS = 12;

/** Still within this fraction of the season's peak counts as standing. */
export const STANDING_FRACTION = 0.75;

/** Past this, an answer is old enough that it has to say so out loud. */
export const STALE_DAYS = 10;

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Standing, senescing or cut, from the field's own curve.
 *
 * The honest difficulty is that a combine and a hard drydown look the same in
 * a single number. They are told apart by HOW FAST the fall happened, which is
 * only knowable when two clear looks sit close together — so when cloud has
 * left a three-week hole, this reports that it cannot separate the two rather
 * than picking one.
 *
 * Every answer carries how old it is. Observed on Kent's own ground: the last
 * three passes were all clouded out, so "standing" was really "standing as of
 * sixteen days ago" — and a field can come off in a morning. A state without
 * its date is a claim about today that nobody checked.
 */
export function harvestState(series, { now = new Date() } = {}) {
  const clear = series.filter(r => r.ndvi !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const age = last => Math.max(0,
    Math.round((now.getTime() - Date.parse(last)) / 86400000));

  if (clear.length < 3) {
    return {
      state: 'unknown', since: null, peak: null, latest: null,
      latestDate: clear.length ? clear[clear.length - 1].date : null,
      staleDays: clear.length ? age(clear[clear.length - 1].date) : null,
      why: `only ${clear.length} cloud-free looks at this field`,
    };
  }

  const peakAt = clear.reduce((best, r) => (r.ndvi > best.ndvi ? r : best), clear[0]);
  const peak = peakAt.ndvi;
  const latest = clear[clear.length - 1];
  const staleDays = age(latest.date);
  const asOf = staleDays > STALE_DAYS
    ? `, but the last clear look was ${staleDays} days ago (${latest.date}), `
      + 'so this describes then rather than now'
    : '';
  const base = { latestDate: latest.date, staleDays };

  // Never green enough to have been a standing crop at all.
  if (peak < CUT_LEVEL + CUT_DROP) {
    return {
      ...base, state: 'unknown', since: null, peak, latest: latest.ndvi,
      why: `this field never got green (peak ${peak.toFixed(2)}), so there is `
         + 'no standing crop to lose',
    };
  }

  // The first fall after the peak that lands on bare ground.
  for (let i = 1; i < clear.length; i++) {
    const a = clear[i - 1], b = clear[i];
    if (a.date < peakAt.date) continue;
    const drop = a.ndvi - b.ndvi;
    if (b.ndvi > CUT_LEVEL || drop < CUT_DROP) continue;

    const gap = days(a.date, b.date);
    if (gap <= FAST_DAYS) {
      return {
        ...base, state: 'cut', since: b.date, peak, latest: latest.ndvi,
        why: `greenness fell ${drop.toFixed(2)} to ${b.ndvi.toFixed(2)} in `
           + `${gap} days, which is a harvest rather than a drydown`,
      };
    }
    return {
      ...base, state: 'cut-or-senesced', since: b.date, peak, latest: latest.ndvi,
      why: `greenness fell ${drop.toFixed(2)} to ${b.ndvi.toFixed(2)}, but the `
         + `looks either side are ${gap} days apart, so a harvest and a slow `
         + 'drydown cannot be told apart',
    };
  }

  if (latest.ndvi >= peak * STANDING_FRACTION) {
    return {
      ...base, state: 'standing', since: null, peak, latest: latest.ndvi,
      why: `still at ${latest.ndvi.toFixed(2)} against a peak of `
         + `${peak.toFixed(2)}${asOf}`,
    };
  }
  return {
    ...base, state: 'senescing', since: peakAt.date, peak, latest: latest.ndvi,
    why: `down to ${latest.ndvi.toFixed(2)} from a peak of ${peak.toFixed(2)}, `
       + `but not yet bare${asOf}`,
  };
}

// --- what is planted -------------------------------------------------------

/** Reference points needed per crop before a comparison means anything. */
export const MIN_REFERENCE_FIELDS = 8;

/** Radii tried in turn, in metres, before giving up. */
export const SEARCH_RADII = [2000, 5000, 10000];

/**
 * Hard ceiling on CropScape requests, so a slow service cannot stall a sync.
 * Sized against measured behaviour rather than guessed: CropScape answers a
 * point in roughly two to five seconds, and a 9x9 grid per radius (243 points
 * over three radii) was observed taking over six minutes before timing out.
 * Twenty-five points per radius, four at a time, keeps the worst case — ground
 * that will never have enough references — under about a minute per field.
 */
export const QUERY_BUDGET = 75;

/** Sample points per side, per radius. */
export const GRID_SIDE = 5;

/**
 * How many lookups run at once. cropHistory stays strictly sequential because
 * it is six requests for one field; this is up to seventy-five, where being
 * polite one-at-a-time would cost minutes of a sync. Four is a compromise, not
 * a maximum to raise.
 */
export const REFERENCE_CONCURRENCY = 4;

export const MAX_SHIFT_DAYS = 12;
export const SHIFT_PENALTY = 0.35;
export const PRIOR_WEIGHT = 0.6;
const GRID_STEP = 4;

/**
 * Find nearby fields whose crop last season is known, widening the search
 * until both corn and soybeans are represented or the budget runs out.
 *
 * Returns { corn: [[lng,lat]...], soybeans: [...], radius, queries, enough }.
 */
export async function referenceFields(ring, {
  year, radii = SEARCH_RADII, budget = QUERY_BUDGET, side = GRID_SIDE,
  concurrency = REFERENCE_CONCURRENCY, fetchImpl = globalThis.fetch, now,
} = {}) {
  const [lng, lat] = ringCentre(ring);
  const cdlYear = year ?? latestCdlYear(now);
  const found = { corn: [], soybeans: [] };
  const seen = new Set();
  let queries = 0;
  let radius = 0;

  const enoughYet = () => found.corn.length >= MIN_REFERENCE_FIELDS
    && found.soybeans.length >= MIN_REFERENCE_FIELDS;

  for (const r of radii) {
    radius = r;

    // A grid over the neighbourhood, spaced so neighbouring samples land in
    // different fields rather than twice in the same one.
    const points = [];
    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) {
        const dLat = (2 * r * (i / (side - 1) - 0.5)) / 110540;
        const dLng = (2 * r * (j / (side - 1) - 0.5))
          / (111320 * Math.cos(lat * Math.PI / 180));
        const p = [lng + dLng, lat + dLat];
        const key = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        points.push(p);
      }
    }

    for (let at = 0; at < points.length && queries < budget; at += concurrency) {
      const room = Math.min(concurrency, budget - queries, points.length - at);
      const slice = points.slice(at, at + room);
      queries += slice.length;
      const hits = await Promise.all(slice.map(async p => {
        try {
          return { p, crop: (await cropAt(p[1], p[0], { year: cdlYear, fetchImpl })).crop };
        } catch {
          return null;     // a refused point is just a point
        }
      }));
      for (const h of hits) {
        if (h && (h.crop === 'corn' || h.crop === 'soybeans')) found[h.crop].push(h.p);
      }
    }

    if (enoughYet() || queries >= budget) break;
  }

  return {
    ...found, radius, queries,
    enough: enoughYet(),
  };
}

/** Resample an irregular series onto a regular day grid, NaN outside it. */
export function toGrid(series, step = GRID_STEP) {
  const clear = series.filter(r => r.ndvi !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (clear.length < 3) return null;
  const t0 = Date.parse(clear[0].date);
  const span = Math.round((Date.parse(clear[clear.length - 1].date) - t0) / 86400000);
  const xs = clear.map(r => Math.round((Date.parse(r.date) - t0) / 86400000));
  const ys = clear.map(r => r.ndvi);

  const grid = [];
  for (let d = 0; d <= span; d += step) {
    let k = 0;
    while (k < xs.length - 1 && xs[k + 1] < d) k++;
    if (d < xs[0] || d > xs[xs.length - 1]) { grid.push(NaN); continue; }
    const x0 = xs[k], x1 = xs[k + 1] ?? x0;
    grid.push(x1 === x0 ? ys[k] : ys[k] + (ys[k + 1] - ys[k]) * (d - x0) / (x1 - x0));
  }
  return { t0: clear[0].date, step, values: grid };
}

/** Lowest penalised RMSE between two gridded curves over a bounded shift. */
export function bestShiftRmse(a, b, {
  step = GRID_STEP, maxShift = MAX_SHIFT_DAYS, penalty = SHIFT_PENALTY,
} = {}) {
  let best = Infinity, bestShift = 0;
  const span = Math.floor(maxShift / step);
  for (let s = -span; s <= span; s++) {
    let n = 0, sum = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i - s;
      if (j < 0 || j >= b.length) continue;
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[j])) continue;
      sum += (a[i] - b[j]) ** 2;
      n++;
    }
    if (n < 4) continue;
    let r = Math.sqrt(sum / n);
    if (maxShift) r *= 1 + penalty * Math.abs(s * step) / maxShift;
    if (r < best) { best = r; bestShift = s * step; }
  }
  return { rmse: best, shift: bestShift };
}

/**
 * Rank corn against soybeans for a field, given reference curves for each and
 * the rotation prior. Returns { verdict, ranked, why } — verdict is null when
 * the evidence does not support a call.
 */
export function classify(series, references, prior = [], { temperature = 0.06 } = {}) {
  const target = toGrid(series);
  if (!target) {
    return { verdict: null, ranked: [], why: 'not enough cloud-free looks to make a curve' };
  }
  const names = Object.keys(references).filter(k => references[k]?.length);
  if (names.length < 2) {
    return { verdict: null, ranked: [], why: 'no local reference curves to compare against' };
  }

  const rows = [];
  for (const name of names) {
    const { rmse, shift } = bestShiftRmse(target.values, references[name]);
    if (!Number.isFinite(rmse)) continue;
    rows.push({ crop: name, rmse, shift });
  }
  if (rows.length < 2) {
    return { verdict: null, ranked: [], why: 'reference curves did not overlap this season' };
  }

  const priorOf = crop => Math.max(prior.find(p => p.crop === crop)?.p ?? 0, 0.02);
  const like = rows.map(r => Math.exp(-r.rmse / temperature));
  const post = rows.map((r, i) => like[i] * priorOf(r.crop) ** PRIOR_WEIGHT);
  const sum = post.reduce((a, b) => a + b, 0);
  const likeSum = like.reduce((a, b) => a + b, 0);

  const ranked = rows.map((r, i) => ({
    ...r,
    confidence: sum ? post[i] / sum : 0,
    curveOnly: likeSum ? like[i] / likeSum : 0,
  })).sort((a, b) => b.confidence - a.confidence);

  const top = ranked[0], next = ranked[1];
  if (top.confidence - next.confidence < 0.15) {
    return {
      verdict: null, ranked,
      why: `${top.crop} and ${next.crop} are too close to call `
         + `(${Math.round(top.confidence * 100)}% against `
         + `${Math.round(next.confidence * 100)}%)`,
    };
  }
  if (top.rmse > 0.12) {
    return {
      verdict: null, ranked,
      why: `nothing nearby matches this curve well (best difference `
         + `${top.rmse.toFixed(3)})`,
    };
  }
  return { verdict: top.crop, ranked, why: null };
}

/**
 * Build a reference curve per crop by averaging the seasons of fields known to
 * carry it. Sampled from the SAME season the labels describe, which is why
 * this uses last year's imagery and last year's CDL together.
 */
export async function referenceCurves(refs, { start, end, fetchImpl = globalThis.fetch, onProgress } = {}) {
  const out = {};
  for (const crop of ['corn', 'soybeans']) {
    const pts = (refs[crop] ?? []).slice(0, MIN_REFERENCE_FIELDS * 2);
    if (!pts.length) continue;
    const curves = [];
    for (const [lng, lat] of pts) {
      const d = 0.00025;                     // a ~50 m box, well inside a field
      const ring = [[lng - d, lat - d], [lng + d, lat - d],
        [lng + d, lat + d], [lng - d, lat + d]];
      try {
        const scenes = await searchScenes(ring, { start, end, fetchImpl });
        const series = await ndviSeries(ring, scenes, { fetchImpl });
        const g = toGrid(series);
        if (g) curves.push(g.values);
      } catch {
        // One unreachable reference field must not sink the set.
      }
      onProgress?.(crop, curves.length, pts.length);
    }
    if (curves.length >= 3) out[crop] = averageCurves(curves);
  }
  return out;
}

/** Element-wise median across curves, ignoring gaps. */
export function averageCurves(curves) {
  const len = Math.max(...curves.map(c => c.length));
  const out = [];
  for (let i = 0; i < len; i++) {
    const vals = curves.map(c => c[i]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) { out.push(NaN); continue; }
    const m = vals.length >> 1;
    out.push(vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2);
  }
  return out;
}

// --- putting it together ---------------------------------------------------

/** Imagery is only worth fetching between these months. */
export const SEASON_START_MONTH = 4;
export const SEASON_END_MONTH = 11;

const iso = d => d.toISOString().slice(0, 10);

/**
 * Scan one field: the season's curve, whether the crop is still standing, and
 * — where the ground allows it — what the crop appears to be.
 *
 * `classifyToo` is off by default. Building reference curves means a second
 * season of imagery for a dozen neighbouring fields, which is minutes of
 * network for an answer that most ground cannot support. Harvest state needs
 * none of that and is the reason to run this at all.
 */
export async function scanField(ring, {
  season, now = new Date(), classifyToo = false, history = [],
  fetchImpl = globalThis.fetch, onProgress,
} = {}) {
  const year = season ?? now.getUTCFullYear();
  const start = `${year}-0${SEASON_START_MONTH}-01`;
  const seasonEnd = new Date(Date.UTC(year, SEASON_END_MONTH - 1, 15));
  const end = iso(now < seasonEnd ? now : seasonEnd);

  onProgress?.('scenes');
  const scenes = await searchScenes(ring, { start, end, fetchImpl });
  if (!scenes.length) {
    return {
      season: year, series: [], looks: 0,
      state: 'unknown', stateWhy: 'no usable imagery covers this field',
      verdict: null, verdictWhy: 'no imagery', scannedAt: now.toISOString(),
    };
  }

  onProgress?.('imagery', scenes.length);
  const series = await ndviSeries(ring, scenes, {
    fetchImpl,
    onProgress: (i, n) => onProgress?.('imagery', n, i),
  });
  const harvest = harvestState(series);
  const clear = series.filter(r => r.ndvi !== null);

  let verdict = null;
  let verdictWhy = 'crop identification was not attempted';
  if (classifyToo) {
    onProgress?.('references');
    const refs = await referenceFields(ring, { now, fetchImpl });
    if (!refs.enough) {
      verdictWhy = `only ${refs.corn.length} corn and ${refs.soybeans.length} `
        + `soybean fields within ${(refs.radius / 1000).toFixed(0)} km — not `
        + 'enough known ground nearby to calibrate against';
    } else {
      onProgress?.('reference curves');
      const refYear = year - 1;
      const curves = await referenceCurves(refs, {
        start: `${refYear}-0${SEASON_START_MONTH}-01`,
        end: `${refYear}-${SEASON_END_MONTH}-15`,
        fetchImpl,
      });
      const result = classify(series, curves, rotationPrior(history, year));
      verdict = result.verdict;
      verdictWhy = result.why;
    }
  }

  return {
    season: year,
    scannedAt: now.toISOString(),
    series: series.map(r => ({ date: r.date, ndvi: r.ndvi, clear: r.clear })),
    looks: clear.length,
    state: harvest.state,
    stateSince: harvest.since,
    stateWhy: harvest.why,
    peakNdvi: harvest.peak,
    latestNdvi: harvest.latest,
    latestDate: clear.length ? clear[clear.length - 1].date : null,
    verdict,
    verdictWhy,
  };
}

/** Does this field disagree with what is recorded for it? */
export function disagreement(field, scan) {
  if (!scan) return null;
  const notes = [];
  if (scan.verdict && scan.verdict !== field.crop) {
    notes.push(`recorded as ${field.crop}, but this season's greenness looks `
      + `like ${scan.verdict}`);
  }
  const cutRecorded = Boolean(field.cut_at ?? field.cutAt);
  if (scan.state === 'cut' && !cutRecorded) {
    notes.push(`looks cut since ${scan.state_since ?? scan.stateSince}, with no cut date recorded`);
  }
  if (cutRecorded && scan.state === 'standing') {
    notes.push('recorded as cut, but it still looks like a standing crop');
  }
  return notes.length ? notes : null;
}
