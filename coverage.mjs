/**
 * coverage.mjs — what a stand can actually shoot, and what that implies about
 * the wind.
 *
 * Until now a stand's good winds were sixteen tick-boxes, filled in from
 * memory. That asks the wrong question. You do not know a stand's winds
 * directly; you know where you can SEE and SHOOT from it — the lane cut
 * through the popple, the field edge, the opening over the crossing — and the
 * winds follow from that. Ticking boxes is doing that derivation in your head,
 * every time, and getting it slightly wrong.
 *
 * So the input becomes what you actually know. Mark the lanes: from the stand,
 * a point at the far end of each shooting opportunity. The winds are computed.
 *
 * THE GEOMETRY, AND WHY IT IS EXACT RATHER THAN SAMPLED.
 *
 * A lane radiates FROM the stand, so every point along it lies on one bearing
 * from the stand — the far end and the near end and everything between. That
 * collapses "does my scent reach any part of this lane" into a single angular
 * test against one bearing, with no sampling and no approximation. It is the
 * one place in this program where the honest answer is also the cheap one.
 *
 * Scent travels downwind. A wind FROM `w` pushes it toward `w + 180`. The
 * stand is unhuntable on that wind if the downwind direction falls within the
 * plume's half-angle of ANY lane's bearing, because then your scent is going
 * straight down the ground you are watching.
 *
 * WHAT THIS IS NOT. It is where your scent goes, not where a deer's nose
 * reaches — the same honest limit the route checker carries, and the same
 * half-angle, deliberately shared so the two cannot quietly disagree.
 *
 * The derived answer never silently replaces a judgement. A stand can still
 * carry hand-picked winds, and where it does, this reports both and says they
 * differ. You have stood in the tree; the arithmetic has not.
 */

import { bearing, angleBetween, COMPASS, CONE_HALF_ANGLE_DEG } from './routes.mjs';
import { distanceM } from './db.mjs';

/**
 * Half the angular width of a lane — the arc you can actually shoot through,
 * not the width of the cut itself.
 *
 * Ten degrees is a twenty-degree cone, which is about what an opening gives
 * you once you can swing: roughly nineteen metres of frontage at fifty. It is
 * a defensible middle rather than a measurement, and it is deliberately the
 * SAME number the map draws. Drawing a wide cone while computing winds from a
 * narrow one would make the picture disagree with the model, and the picture
 * is what you would believe.
 *
 * The scent plume still dominates: thirty degrees either side against this
 * ten, so a lane's own width moves the wind answer only at the margins.
 */
export const LANE_SPREAD_DEG = 10;

/**
 * How far a lane's own width may be dragged.
 *
 * Ten degrees is only ever a starting guess — a cut through popple and a
 * quarter-section of standing beans are not the same opening, and the whole
 * reason for a handle is that you know which one you are sitting over. So a
 * lane carries its own half-angle when you have set one, and falls back to the
 * number above when you have not.
 *
 * The bounds are what stops the handle producing something that is no longer a
 * lane. Below three degrees the cone is a line and the wind answer stops
 * depending on the width at all; above eighty it is a 160-degree fan, which is
 * a field you can see across rather than a shooting opportunity, and treating
 * it as one lane would rule out nearly every wind for the wrong reason.
 *
 * These are the bounds the map clamps a drag to. The database's own check is
 * deliberately looser (anything above 0 and below 90) — it is guarding against
 * nonsense, not enforcing a judgement, and the two should not be confused.
 */
export const MIN_LANE_SPREAD_DEG = 3;
export const MAX_LANE_SPREAD_DEG = 80;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * A lane's half-angle: its own, clamped, or the default.
 *
 * One function rather than a `?? LANE_SPREAD_DEG` at each site, because the
 * map draws the cone and this module derives the winds from it, and those two
 * reading the width differently is exactly the disagreement the constant above
 * exists to prevent.
 */
export function laneSpread(lane, fallback = LANE_SPREAD_DEG) {
  const s = lane?.spread;
  if (!isNum(s)) return fallback;
  return Math.min(MAX_LANE_SPREAD_DEG, Math.max(MIN_LANE_SPREAD_DEG, s));
}

/** Where a lane points, how far it reaches, and how wide it opens. */
export function laneGeometry(stand, lane, { spreadDeg = LANE_SPREAD_DEG } = {}) {
  const to = lane?.to;
  if (!Array.isArray(to) || !isNum(to[0]) || !isNum(to[1])) return null;
  if (!isNum(stand?.lat) || !isNum(stand?.lng)) return null;
  const deg = bearing(stand.lat, stand.lng, to[1], to[0]);
  return {
    to,
    label: lane.label ?? null,
    bearingDeg: Math.round(deg * 10) / 10,
    point: COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16],
    metres: Math.round(distanceM(stand.lat, stand.lng, to[1], to[0])),
    spreadDeg: laneSpread(lane, spreadDeg),
  };
}

export const laneGeometries = (stand, lanes = [], opts = {}) =>
  lanes.map(l => laneGeometry(stand, l, opts)).filter(Boolean);

/**
 * Which winds this stand can be hunted on, given its lanes.
 *
 * Returns null when there are no lanes. "I have not marked the lanes" and
 * "this stand works on no winds" are different facts, and every other module
 * here already refuses to conflate them.
 */
export function huntableFromLanes(stand, lanes = [], {
  halfAngleDeg = CONE_HALF_ANGLE_DEG, spreadDeg = LANE_SPREAD_DEG,
} = {}) {
  const geo = laneGeometries(stand, lanes, { spreadDeg });
  if (!geo.length) return null;

  const winds = [], blocked = [];
  for (let i = 0; i < 16; i++) {
    const from = i * 22.5;
    const downwind = (from + 180) % 360;
    // The lane whose ground your scent would cross most directly, which is the
    // one worth naming when explaining a refusal.
    let worst = null;
    for (const g of geo) {
      // Each lane is tested against its OWN width. A wide lane rules out more
      // winds than a narrow one, which is the entire point of being able to
      // widen it: the shape you drew is the shape you are judged on.
      const off = angleBetween(downwind, g.bearingDeg);
      if (off <= halfAngleDeg + g.spreadDeg && (!worst || off < worst.offDeg)) {
        worst = { offDeg: Math.round(off), lane: g };
      }
    }
    if (worst) blocked.push({ point: COMPASS[i], ...worst });
    else winds.push(COMPASS[i]);
  }

  return {
    winds, blocked,
    lanes: geo,
    // spreadDeg is the FALLBACK, not a description of the lanes: each geometry
    // above carries the width actually used for it.
    halfAngleDeg, spreadDeg,
    longestM: Math.max(...geo.map(g => g.metres)),
    // Said in the terms you would use standing under the tree.
    why: `${geo.length} lane${geo.length === 1 ? '' : 's'} `
      + `(${geo.map(g => g.point + ' ' + g.metres + ' m').join(', ')}). `
      + (winds.length
        ? `Huntable on ${winds.length} of 16 winds — the rest blow your scent down a lane.`
        : 'No wind keeps your scent out of all of them, which usually means the '
          + 'lanes face too many directions to hunt as one stand.'),
  };
}

/**
 * Compare what the lanes say against what was ticked by hand.
 *
 * Neither wins automatically. A hand-picked set may encode something real that
 * geometry cannot see — a thermal that always drains one way, a road you will
 * not shoot toward — and it may equally be a guess made once and never
 * revisited. Reporting the disagreement is the useful thing; resolving it is
 * Kent's.
 */
export function compareToManual(derived, manualWinds = []) {
  if (!derived) return null;
  const manual = manualWinds.filter(w => COMPASS.includes(w));
  if (!manual.length) return { agree: null, why: 'No winds were ticked by hand to compare.' };
  const d = new Set(derived.winds);
  const m = new Set(manual);
  const onlyManual = manual.filter(w => !d.has(w));
  const onlyDerived = derived.winds.filter(w => !m.has(w));
  if (!onlyManual.length && !onlyDerived.length) {
    return { agree: true, onlyManual, onlyDerived, why: 'The lanes agree with what you ticked.' };
  }
  return {
    agree: false, onlyManual, onlyDerived,
    why: [
      onlyManual.length
        ? `You ticked ${onlyManual.join(', ')}, but on ${onlyManual.length === 1 ? 'that wind' : 'those'} `
          + 'your scent runs down a lane.'
        : null,
      onlyDerived.length
        ? `The lanes also allow ${onlyDerived.join(', ')}, which you did not tick.`
        : null,
    ].filter(Boolean).join(' '),
  };
}

/**
 * The winds a stand should be judged on.
 *
 * Lanes first where they exist, because they are derived from something you
 * measured rather than something you recalled — but a hand-picked set is
 * honoured when there are no lanes, so nothing that already works stops
 * working. Which source was used is returned, never inferred by the caller.
 */
export function windsForStand(stand, { halfAngleDeg = CONE_HALF_ANGLE_DEG } = {}) {
  const lanes = stand?.lanes ?? [];
  const manual = stand?.winds ?? (stand?.good_winds ? stand.good_winds.split(',') : []);
  const derived = huntableFromLanes(stand, lanes, { halfAngleDeg });
  if (derived) {
    return {
      winds: derived.winds, source: 'lanes', derived,
      compared: compareToManual(derived, manual),
    };
  }
  if (manual.length) return { winds: manual, source: 'ticked', derived: null, compared: null };
  return { winds: [], source: 'none', derived: null, compared: null };
}

/**
 * The same derivation, as source, for the map to run while you trace.
 *
 * The lanes have to turn into winds as each one is placed — a derivation you
 * only see after saving is one you cannot correct. Writing it twice is how the
 * winds shown while tracing and the winds the ranking uses drift apart, so
 * this is emitted from the functions above and test/coverage.test.js compiles
 * the result and checks it against them on the same lanes.
 */
export function browserSource(globalName = 'COVER') {
  const consts = {
    CONE_HALF_ANGLE_DEG, LANE_SPREAD_DEG, MIN_LANE_SPREAD_DEG, MAX_LANE_SPREAD_DEG,
  };
  const body = [
    `const COMPASS = ${JSON.stringify(COMPASS)};`,
    ...Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`),
    `const isNum = ${isNum.toString()};`,
    `const distanceM = ${distanceM.toString()};`,
    `const bearing = ${bearing.toString()};`,
    `const angleBetween = ${angleBetween.toString()};`,
    `const laneSpread = ${laneSpread.toString()};`,
    `const laneGeometry = ${laneGeometry.toString()};`,
    `const laneGeometries = ${laneGeometries.toString()};`,
    `const huntableFromLanes = ${huntableFromLanes.toString()};`,
    `const compareToManual = ${compareToManual.toString()};`,
    // bearing, angleBetween and the spread bounds go across too: the map has to
    // turn a dragged handle into a half-angle, and doing that with its own copy
    // of the trigonometry is how the cone you drag and the cone that decides
    // the winds start to differ.
    'return { laneGeometry, laneGeometries, huntableFromLanes, compareToManual,'
    + ' laneSpread, bearing, angleBetween,'
    + ' LANE_SPREAD_DEG, MIN_LANE_SPREAD_DEG, MAX_LANE_SPREAD_DEG };',
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
