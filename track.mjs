/**
 * track.mjs — where you actually walked, as opposed to where you meant to.
 *
 * The routes module holds the walk you DREW: a line on a map, judged against
 * the wind. This holds the walk you TOOK, recorded off the phone's GPS. The
 * two are different objects on purpose, and the gap between them is the whole
 * point — a route that is clean on paper tells you nothing if you actually cut
 * the corner in the dark and crossed the ground you were about to hunt.
 *
 * THE HARD PART IS NOT RECORDING IT, IT IS BELIEVING IT.
 *
 * A phone under a closed canopy in November is a bad GPS. Ten to thirty metres
 * of scatter is normal, and every so often it produces a fix a couple of
 * hundred metres away for one sample before recovering. Stored raw, that gives
 * a track whose length is wrong by a factor, a "walk" that teleports across
 * the property, and a scent analysis that confidently reports you contaminated
 * ground you never went near. Worse, it looks plausible on a map.
 *
 * So nothing is stored raw. Three filters, in order, each doing one job:
 *
 *   1. ACCURACY. The browser reports its own error estimate per fix. A fix
 *      that admits to being 80 m out is not evidence of anything at this
 *      scale, and is dropped rather than averaged in.
 *   2. SPEED. A person in the woods walks around 1 m/s and cannot exceed
 *      about 3. A fix implying more than that, against the last one KEPT, is
 *      the outlier — not a new position.
 *   3. RESOLUTION. A move smaller than your error is not a move. Standing on
 *      stand for ten minutes gives several hundred fixes scattered across the
 *      error radius, and summing them walks half a kilometre without going
 *      anywhere. A fix closer to the last kept one than its own stated
 *      accuracy is discarded as indistinguishable from standing still.
 *   4. SIMPLIFICATION. Douglas–Peucker at an epsilon tied to the observed
 *      accuracy, which straightens what is left without inventing corners.
 *
 * Filter 3 is the one that is easy to leave out and expensive to miss:
 * simplification alone does not fix a stationary cloud, because Douglas–Peucker
 * preserves SHAPE and a cloud of noise has plenty of shape. It keeps the
 * outermost fixes of the scatter and the distance survives.
 *
 * Everything the filters throw away is COUNTED and reported. A track built
 * from forty of two hundred fixes is a track you should not draw conclusions
 * from, and the only way to know that is to be told.
 */

import { distanceM } from './db.mjs';

/** Fixes worse than this are not evidence at the scale of a stand approach. */
export const MAX_ACCURACY_M = 50;

/** Nobody walks this fast in the woods; a fix implying it is an outlier. */
export const MAX_SPEED_MPS = 3;

/** Simplification floor, so a good GPS still gets a smooth line. */
export const MIN_EPSILON_M = 4;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * A fix as the browser hands it over, normalised.
 *
 * Time is kept per point rather than only start and end: pace is what tells
 * you whether you strolled in or arrived sweating, and where you stopped.
 */
export function normalisePoint(p) {
  const lat = p?.lat ?? p?.coords?.latitude;
  const lng = p?.lng ?? p?.coords?.longitude;
  if (!isNum(lat) || !isNum(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const acc = p?.acc ?? p?.accuracy ?? p?.coords?.accuracy;
  const t = p?.t ?? p?.timestamp;
  return {
    lat, lng,
    // Unknown accuracy is NOT good accuracy. It is carried as null and the
    // accuracy gate treats it as untrustworthy rather than perfect.
    acc: isNum(acc) ? acc : null,
    t: isNum(t) ? t : (typeof t === 'string' ? Date.parse(t) || null : null),
  };
}

/**
 * Perpendicular distance from a point to a segment, in metres.
 *
 * Projected flat locally. Over the few hundred metres a walk-in covers, the
 * error from ignoring curvature is millimetres — far below the GPS noise this
 * exists to measure — and the spherical version is a great deal easier to get
 * subtly wrong.
 */
export function pointToSegmentM(p, a, b) {
  const latRad = a.lat * Math.PI / 180;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad);
  const mPerDegLng = 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad);
  const x = (p.lng - a.lng) * mPerDegLng, y = (p.lat - a.lat) * mPerDegLat;
  const bx = (b.lng - a.lng) * mPerDegLng, by = (b.lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(x, y);          // a and b are the same point
  // Clamped, so the answer is to the SEGMENT and not to its infinite line.
  const t = Math.max(0, Math.min(1, (x * bx + y * by) / len2));
  return Math.hypot(x - t * bx, y - t * by);
}

/** Douglas–Peucker, iterative so a long track cannot blow the stack. */
export function simplify(points, epsilonM) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let worst = 0, at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointToSegmentM(points[i], points[lo], points[hi]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at !== -1 && worst > epsilonM) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Turn a pile of fixes into a track worth reading, and say what was discarded.
 *
 * The counts are not diagnostics for a developer — they belong on the screen.
 * A track assembled from a fifth of its fixes is one you should not measure
 * anything from, and nothing else on the page would reveal that.
 */
export function buildTrack(raw = [], {
  maxAccuracyM = MAX_ACCURACY_M,
  maxSpeedMps = MAX_SPEED_MPS,
  epsilonM = null,
} = {}) {
  const fixes = raw.map(normalisePoint).filter(Boolean);
  const dropped = { accuracy: 0, speed: 0, stationary: 0, unusable: raw.length - fixes.length };

  // 1. Accuracy. An unknown accuracy is treated as failing, not passing.
  const accurate = fixes.filter(p => {
    const ok = p.acc !== null && p.acc <= maxAccuracyM;
    if (!ok) dropped.accuracy++;
    return ok;
  });

  // 2. Speed, measured against the last fix KEPT — comparing against the last
  //    fix SEEN would let one outlier drag the whole gate along with it.
  const kept = [];
  for (const p of accurate) {
    const prev = kept[kept.length - 1];
    if (prev && isNum(p.t) && isNum(prev.t)) {
      const dt = (p.t - prev.t) / 1000;
      if (dt > 0) {
        const speed = distanceM(prev.lat, prev.lng, p.lat, p.lng) / dt;
        if (speed > maxSpeedMps) { dropped.speed++; continue; }
      }
    }
    kept.push(p);
  }

  // 3. Resolution: a step shorter than the error is not a step.
  //
  //    The threshold is TWICE the reported accuracy, and the factor matters.
  //    Browsers report accuracy as a 68% (one sigma) radius, so two fixes
  //    taken at the same true position routinely differ by about twice it.
  //    Gating at one sigma lets a stationary cloud oscillate across itself —
  //    each fix far enough from the last kept one to be accepted, the anchor
  //    walking back and forth — and a motionless hour still accumulates a
  //    hundred metres. Measured: with ten-metre fixes, one sigma left 148 m of
  //    phantom walking, two sigma leaves under twenty.
  //
  //    The cost is real and is the honest one: under heavy canopy you cannot
  //    resolve a bend tighter than your error, so those bends are not drawn.
  //    The last fix is always kept, or a walk that ends with a pause ends
  //    short of where you actually stopped.
  const moved = [];
  for (const p of kept) {
    const prev = moved[moved.length - 1];
    const floor = Math.max(MIN_EPSILON_M, 2 * (p.acc ?? maxAccuracyM));
    if (!prev || distanceM(prev.lat, prev.lng, p.lat, p.lng) >= floor) moved.push(p);
    else dropped.stationary++;
  }
  if (kept.length > 1 && moved[moved.length - 1] !== kept[kept.length - 1]) {
    moved.push(kept[kept.length - 1]);
    dropped.stationary--;
  }

  // 4. Simplify at an epsilon tied to what the GPS was actually managing, so a
  //    good fix keeps its detail and a poor one is not smoothed into fiction.
  const accs = kept.map(p => p.acc).filter(isNum).sort((a, b) => a - b);
  const medianAcc = accs.length ? accs[Math.floor(accs.length / 2)] : maxAccuracyM;
  const eps = epsilonM ?? Math.max(MIN_EPSILON_M, medianAcc / 2);
  const line = simplify(moved, eps);

  const lengthM = line.reduce((sum, p, i) =>
    i ? sum + distanceM(line[i - 1].lat, line[i - 1].lng, p.lat, p.lng) : 0, 0);
  const times = kept.map(p => p.t).filter(isNum);
  const startedAt = times.length ? Math.min(...times) : null;
  const endedAt = times.length ? Math.max(...times) : null;
  const seconds = startedAt !== null && endedAt !== null
    ? Math.round((endedAt - startedAt) / 1000) : null;

  return {
    points: line.map(p => [p.lng, p.lat]),
    // Kept alongside the geometry so a later reading knows how much to trust
    // it without re-deriving anything.
    fixes: raw.length,
    used: line.length,
    dropped,
    medianAccuracyM: accs.length ? Math.round(medianAcc * 10) / 10 : null,
    epsilonM: Math.round(eps * 10) / 10,
    lengthM: Math.round(lengthM),
    startedAt, endedAt, seconds,
    pacePerKm: lengthM > 100 && seconds ? Math.round(seconds / (lengthM / 1000)) : null,
    // The honest headline. Everything else on the page depends on it.
    quality: trackQuality({ fixes: raw.length, used: line.length, kept: kept.length, medianAcc: accs.length ? medianAcc : null }),
  };
}

/**
 * How much this track is worth, in words.
 *
 * Deliberately blunt. The failure this prevents is a 40-metre-scatter track
 * being measured to the metre and used to argue about scent.
 */
export function trackQuality({ fixes, used, kept, medianAcc }) {
  if (!used || used < 2) {
    return { level: 'unusable', why: 'Too few usable fixes to make a line at all.' };
  }
  if (kept < 5) {
    return { level: 'unusable',
      why: `Only ${kept} fix${kept === 1 ? '' : 'es'} survived filtering — this is not a track.` };
  }
  const survived = kept / Math.max(1, fixes);
  if (survived < 0.4) {
    return { level: 'poor',
      why: `Only ${Math.round(survived * 100)}% of fixes were usable. Treat the line as a `
        + 'rough indication of where you went, not a measurement.' };
  }
  if (medianAcc !== null && medianAcc > 20) {
    return { level: 'rough',
      why: `The phone's own error estimate averaged ${Math.round(medianAcc)} m — heavy `
        + 'canopy or a poor sky view. The shape is right; the distances are approximate.' };
  }
  return { level: 'good',
    why: medianAcc === null ? 'Fixes were accepted, but the phone reported no accuracy.'
      : `Median accuracy ${Math.round(medianAcc)} m across ${kept} fixes.` };
}

/**
 * How closely the walk followed the plan.
 *
 * Not "did you take this route" as a yes or no — the useful answer is WHERE
 * and BY HOW MUCH you left it, because that is the ground your scent was
 * actually on. A cut corner in the dark is the commonest way a good route
 * stops being one, and it never shows up in the route you drew.
 */
export function compareToRoute(track, route, { strayM = 40 } = {}) {
  const walked = (track?.points ?? []).map(([lng, lat]) => ({ lat, lng }));
  const planned = (route?.points ?? []).map(([lng, lat]) => ({ lat, lng }));
  if (walked.length < 2 || planned.length < 2) {
    return { comparable: false,
      why: 'Needs both a recorded track and a drawn route with at least two points each.' };
  }
  let worst = 0, worstAt = null;
  const deviations = [];
  for (const p of walked) {
    let best = Infinity;
    for (let i = 1; i < planned.length; i++) {
      const d = pointToSegmentM(p, planned[i - 1], planned[i]);
      if (d < best) best = d;
    }
    deviations.push(best);
    if (best > worst) { worst = best; worstAt = p; }
  }
  deviations.sort((a, b) => a - b);
  const median = deviations[Math.floor(deviations.length / 2)];
  const off = deviations.filter(d => d > strayM).length;
  return {
    comparable: true,
    medianM: Math.round(median),
    worstM: Math.round(worst),
    worstAt: worstAt ? [worstAt.lng, worstAt.lat] : null,
    offRouteFraction: Math.round(100 * off / deviations.length) / 100,
    followed: worst <= strayM,
    why: worst <= strayM
      // "within 0 m" is arithmetically true and reads as a bug. Below the
      // resolution the GPS was managing, say that instead of a number.
      ? (worst < 2
        ? 'You followed the route the whole way, within what the GPS can resolve.'
        : `You stayed within ${Math.round(worst)} m of the route the whole way.`)
      : `You left the route by up to ${Math.round(worst)} m, and were more than `
        + `${strayM} m off it for ${Math.round(100 * off / deviations.length)}% of the walk. `
        + 'That is ground the route check never looked at.',
  };
}
