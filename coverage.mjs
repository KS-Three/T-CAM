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
 * A lane is not infinitely thin, but it is close enough that its own width
 * barely matters: a five-metre lane at forty metres subtends about seven
 * degrees, against a scent plume modelled at sixty. The plume dominates, so
 * lane width is folded in as a small constant rather than measured — measuring
 * it would imply a precision the plume model does not have.
 */
export const LANE_SPREAD_DEG = 5;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Where a lane points and how far it reaches. */
export function laneGeometry(stand, lane) {
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
  };
}

export const laneGeometries = (stand, lanes = []) =>
  lanes.map(l => laneGeometry(stand, l)).filter(Boolean);

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
  const geo = laneGeometries(stand, lanes);
  if (!geo.length) return null;
  const reach = halfAngleDeg + spreadDeg;

  const winds = [], blocked = [];
  for (let i = 0; i < 16; i++) {
    const from = i * 22.5;
    const downwind = (from + 180) % 360;
    // The lane whose ground your scent would cross most directly, which is the
    // one worth naming when explaining a refusal.
    let worst = null;
    for (const g of geo) {
      const off = angleBetween(downwind, g.bearingDeg);
      if (off <= reach && (!worst || off < worst.offDeg)) {
        worst = { offDeg: Math.round(off), lane: g };
      }
    }
    if (worst) blocked.push({ point: COMPASS[i], ...worst });
    else winds.push(COMPASS[i]);
  }

  return {
    winds, blocked,
    lanes: geo,
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
  const consts = { CONE_HALF_ANGLE_DEG, LANE_SPREAD_DEG };
  const body = [
    `const COMPASS = ${JSON.stringify(COMPASS)};`,
    ...Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`),
    `const isNum = ${isNum.toString()};`,
    `const distanceM = ${distanceM.toString()};`,
    `const bearing = ${bearing.toString()};`,
    `const angleBetween = ${angleBetween.toString()};`,
    `const laneGeometry = ${laneGeometry.toString()};`,
    `const laneGeometries = ${laneGeometries.toString()};`,
    `const huntableFromLanes = ${huntableFromLanes.toString()};`,
    `const compareToManual = ${compareToManual.toString()};`,
    'return { laneGeometry, laneGeometries, huntableFromLanes, compareToManual };',
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
