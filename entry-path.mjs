/**
 * entry-path.mjs — a suggested walk in: from where you park to the stand,
 * placed by the wind instead of by hope.
 *
 * The rule it encodes is the one every article states and every map makes
 * hard to actually apply: approach from downwind, and never let the ground
 * you are about to hunt sit downwind of any step of the walk. routes.mjs
 * already models a step's scent as a cone opening downwind (half-angle 30°,
 * reach 200 m); this module is that model run backwards. Every target you
 * must not alert — the stand you are walking to, the other stands, the beds
 * and food plots you have marked — projects a no-walk wedge opening UPWIND
 * of it: stand inside that wedge and your scent is on the target. A clean
 * entry path threads between the wedges and comes at the stand from its
 * downwind side.
 *
 * The construction is deliberately simple rather than a grid search: start
 * with the straight line from your entry point to a spot just downwind of
 * the stand, find the first place it stands inside somebody's wedge, bend
 * the path around that wedge's nearest shoulder, repeat, then straighten
 * what over-bent. On ground with a handful of targets this converges in two
 * or three bends, each of which can be pointed at and explained — which a
 * thousand-cell cost surface cannot.
 *
 * Planning uses the model's cone PLUS a margin (a suggested line that grazes
 * the cone's edge would flip verdicts with one step); the verdict reported
 * back uses the standard model, unpadded, through the same assessRoute every
 * hand-drawn route is judged by. The suggestion must never be graded by a
 * kinder rule than the thing it replaces.
 *
 * The path ends APPROACH_SETBACK_M short of the stand, dead downwind of it.
 * The last few steps to the tree are unavoidable on any wind — pretending a
 * clever line exists for them would be dishonest, so they are left to you
 * and said so.
 */

import {
  bearing, offsetPoint, angleBetween, routeLength, assessRoute, routeWinds,
  CONE_HALF_ANGLE_DEG, CONE_REACH_M, COMPASS,
} from './routes.mjs';
import { distanceM } from './db.mjs';

export const APPROACH_SETBACK_M = 20;

// The planning margin beyond the scent model. Wedge tests while ROUTING use
// cone + margin; the verdict uses the cone alone.
const MARGIN_M = 30;
const MARGIN_DEG = 10;
const SAMPLE_M = 12;
const MAX_BENDS = 12;

export const compassOf = deg =>
  COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/** Standing at [lng,lat], does this wind put scent on the target? The same
 *  per-point test scentReaches runs, exposed for a single point so the
 *  planner can ask it about candidate steps. */
export function taints(p, target, windFromDeg, {
  halfAngleDeg = CONE_HALF_ANGLE_DEG, reachM = CONE_REACH_M,
} = {}) {
  const d = distanceM(p[1], p[0], target.lat, target.lng);
  if (d > reachM) return false;
  if (d < 1e-6) return true;      // standing on it
  const downwind = (windFromDeg + 180) % 360;
  return angleBetween(downwind, bearing(p[1], p[0], target.lat, target.lng)) <= halfAngleDeg;
}

/** Walk a segment in SAMPLE_M steps; the first sample that taints any active
 *  target names the wedge to bend around. Linear interpolation in degrees is
 *  ample at walk lengths. */
function firstTaint(a, b, targets, windFromDeg, pad) {
  const m = distanceM(a[1], a[0], b[1], b[0]);
  const steps = Math.max(1, Math.ceil(m / SAMPLE_M));
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    for (const t of targets) {
      if (taints(p, t, windFromDeg, pad)) return { target: t, at: p };
    }
  }
  return null;
}

const segmentClean = (a, b, targets, windFromDeg, pad) =>
  !firstTaint(a, b, targets, windFromDeg, pad);

/**
 * Where to step to get around one target's wedge: just outside either
 * shoulder, or beyond the arc entirely. Which one wins is decided by added
 * distance, not by rule.
 */
function shoulders(target, windFromDeg, pad) {
  const out = [];
  const swing = pad.halfAngleDeg + 12;
  const r = pad.reachM + 25;
  for (const side of [-1, 1]) {
    const p = offsetPoint(target.lat, target.lng, (windFromDeg + side * swing + 360) % 360, r);
    out.push([p.lng, p.lat]);
  }
  const far = offsetPoint(target.lat, target.lng, windFromDeg, pad.reachM * 1.35);
  out.push([far.lng, far.lat]);
  return out;
}

/**
 * The corner path, re-sampled every DENSIFY_M along its own line.
 *
 * This is an honesty requirement, not smoothing. scentReaches — the model
 * every route is judged by, here and after this is saved as a route — tests
 * the POINTS of a path, and a three-corner path can sweep its line straight
 * through a wedge while every corner sits outside it. The first browser
 * screenshot of this feature showed exactly that: a "clean" proposal drawn
 * through the beds. Densified, the points ARE the line, and the verdict
 * cannot claim better than the walk.
 */
const DENSIFY_M = 25;
function densify(path) {
  const out = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const m = distanceM(a[1], a[0], b[1], b[0]);
    const steps = Math.max(1, Math.ceil(m / DENSIFY_M));
    for (let s = 1; s <= steps; s++) {
      out.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
    }
  }
  return out;
}

/**
 * Suggest the walk from `from` to `stand` on one wind.
 *
 * `avoid` is everything else you would rather not blow out on the way —
 * other stands, bed and food-plot markers — each {lat, lng, name}.
 * Returns the path, the verdict the standard model gives it, which of the
 * 16 winds it stays clean on, and the reasoning in sentences.
 */
export function suggestEntryPath({ from, stand, windFromDeg, avoid = [],
                                   halfAngleDeg = CONE_HALF_ANGLE_DEG,
                                   reachM = CONE_REACH_M } = {}) {
  if (!from || !Number.isFinite(from.lat) || !Number.isFinite(from.lng)) {
    throw new Error('an entry path needs a starting point — where you leave the truck or the road');
  }
  if (!stand || !Number.isFinite(stand.lat) || !Number.isFinite(stand.lng)) {
    throw new Error('an entry path needs a stand to walk to');
  }
  if (!Number.isFinite(windFromDeg)) {
    throw new Error('an entry path is shaped by the wind, so it needs one');
  }

  const pad = { halfAngleDeg: halfAngleDeg + MARGIN_DEG, reachM: reachM + MARGIN_M };
  const model = { halfAngleDeg, reachM };
  const wind = ((windFromDeg % 360) + 360) % 360;
  const downwind = (wind + 180) % 360;
  const S = [from.lng, from.lat];

  // The approach point: just downwind of the stand, so the last leg arrives
  // with the wind in your face and your scent trailing away from the ground
  // ahead. If you park closer than the setback the "path" is the walk you
  // already have.
  const straightM = Math.round(distanceM(from.lat, from.lng, stand.lat, stand.lng));
  const endPt = offsetPoint(stand.lat, stand.lng, downwind, APPROACH_SETBACK_M);
  const E = [endPt.lng, endPt.lat];

  const targets = [
    { lat: stand.lat, lng: stand.lng, name: stand.name ?? 'the stand' },
    ...avoid.filter(t => Number.isFinite(t?.lat) && Number.isFinite(t?.lng)),
  ];

  // A wedge the start or the end already stands in cannot be routed out of —
  // you park where you park, and the approach point is as kind as an
  // approach gets. Those targets are reported, not silently dropped, and the
  // final verdict still judges them.
  const excused = [];
  const active = [];
  for (const t of targets) {
    if (taints(S, t, wind, pad) || taints(E, t, wind, pad)) excused.push(t);
    else active.push(t);
  }

  // Bend the straight line around wedges until nothing on it taints.
  let path = [S, E];
  const bentAround = [];
  const bendCount = new Map();
  if (straightM > APPROACH_SETBACK_M + 5) {
    for (let round = 0; round < MAX_BENDS; round++) {
      let hit = null, seg = -1;
      for (let i = 0; i < path.length - 1 && !hit; i++) {
        hit = firstTaint(path[i], path[i + 1], active, wind, pad);
        seg = i;
      }
      if (!hit) break;
      const n = bendCount.get(hit.target) ?? 0;
      if (n >= 3) break;                    // this wedge will not thread; stop honestly
      bendCount.set(hit.target, n + 1);
      const options = shoulders(hit.target, wind, pad)
        .map(c => ({
          c,
          added: distanceM(path[seg][1], path[seg][0], c[1], c[0])
            + distanceM(c[1], c[0], path[seg + 1][1], path[seg + 1][0]),
        }))
        // The bend must clear the wedge it is bending around along BOTH new
        // legs, not merely stand outside it itself. The far-point candidate
        // sits dead on the downwind axis, so it passes any point test while
        // its onward leg dives straight back through the wedge — chosen, it
        // was re-chosen forever and the loop gave up with the line still
        // dirty. Wedges a leg newly grazes belong to a later round.
        .filter(o => !firstTaint(path[seg], o.c, [hit.target], wind, pad)
          && !firstTaint(o.c, path[seg + 1], [hit.target], wind, pad))
        .sort((a, b) => a.added - b.added);
      if (!options.length) break;
      path.splice(seg + 1, 0, options[0].c);
      if (!bentAround.includes(hit.target)) bentAround.push(hit.target);
    }

    // Straighten: a bend that a later bend made unnecessary is walked off.
    let pruned = true;
    while (pruned && path.length > 2) {
      pruned = false;
      for (let i = 1; i < path.length - 1; i++) {
        if (segmentClean(path[i - 1], path[i + 1], active, wind, pad)) {
          path.splice(i, 1);
          pruned = true;
          break;
        }
      }
    }
  }

  // The corners become the walked line before anything judges it — see
  // densify() for why sparse corners would let the verdict lie.
  path = densify(path);

  // Judged by the standard model, exactly as a hand-drawn route would be.
  const others = avoid.filter(t => Number.isFinite(t?.lat) && Number.isFinite(t?.lng));
  const verdict = assessRoute({ points: path }, { stand, others, windFromDeg: wind, ...model });
  const winds = routeWinds(path, stand, model);
  const lengthM = routeLength(path);

  const why = [];
  why.push(`comes at ${stand.name ?? 'the stand'} from the ${compassOf(downwind)} — its `
    + `downwind side on a ${compassOf(wind)} wind, so the walk's scent trails away from it`);
  if (bentAround.length) {
    why.push('bends to stay out of the scent cone over '
      + bentAround.map(t => t.name ?? 'a marked spot').join(', '));
  }
  const extra = lengthM - straightM;
  why.push(`${lengthM} m on the ground` + (extra > 25
    ? ` — ${extra} m further than straight in, which is what the wind costs`
    : ', barely longer than straight in'));
  for (const t of excused) {
    why.push(`no path helps ${t.name ?? 'one marked spot'}: where you start `
      + `(or the stand's own doorstep) already puts it downwind on this wind`);
  }
  why.push(`stops ${APPROACH_SETBACK_M} m short, dead downwind of the stand — `
    + 'the last steps are yours on any wind');

  return {
    ok: verdict.ok === true,
    points: path,
    windFromDeg: wind,
    windFrom: compassOf(wind),
    verdict,
    winds,
    lengthM,
    straightM,
    why,
    bentAround: bentAround.map(t => t.name ?? 'a marked spot'),
    excused: excused.map(t => t.name ?? 'a marked spot'),
  };
}
