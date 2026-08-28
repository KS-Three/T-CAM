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

import { bearing, angleBetween, COMPASS, CONE_HALF_ANGLE_DEG, offsetPoint } from './routes.mjs';
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

/**
 * The shortest a lane may be.
 *
 * Not a judgement about shots — a five-metre lane is a real thing under a
 * tree — but about not storing a lane that has collapsed to a point. Below
 * this there is no bearing to speak of, the cone has no area, and the lane
 * silently stops counting toward the winds while still sitting in the list.
 *
 * There is deliberately no maximum. A four-hundred-metre lane is usually a
 * misplaced click, and the form says so, but it might genuinely be the far
 * edge of a field you watch — and refusing to store what somebody means is a
 * worse failure than showing them a number they will recognise as wrong.
 */
export const MIN_LANE_REACH_M = 5;

/**
 * How wide a lane is on the ground where the shot ends, in metres.
 *
 * The stored width is a half-angle, and that is the right thing to STORE: it
 * is what the wind test needs, and it does not change when the lane gets
 * longer. It is the wrong thing to ASK FOR. Nobody standing under a tree knows
 * an opening in degrees. They know it is about twenty yards across where it
 * meets the field, because they have walked it — so that is the number the
 * form takes, and this is the conversion between the two.
 *
 * One definition, used by the box you type in, the readout on the cone and the
 * geometry the winds come out of, because three copies of a tangent is exactly
 * how the width you set stops being the width you are judged on.
 */
export const laneWidthM = (metres, spreadDeg) =>
  2 * metres * Math.tan(spreadDeg * Math.PI / 180);

/**
 * The inverse: the half-angle that makes a lane `widthM` across at `metres`.
 *
 * Clamped to the same bounds a drag is. Typing two hundred yards across a
 * forty-yard lane lands on the widest a lane may be rather than on a fan that
 * is not a lane at all — and because it clamps rather than refuses, the number
 * that comes back is the one that gets stored and shown, so the box always
 * ends up agreeing with the cone.
 */
export function spreadForWidthM(metres, widthM) {
  if (!isNum(metres) || !isNum(widthM) || metres <= 0 || widthM <= 0) return null;
  const deg = Math.atan(widthM / (2 * metres)) * 180 / Math.PI;
  const clamped = Math.min(MAX_LANE_SPREAD_DEG, Math.max(MIN_LANE_SPREAD_DEG, deg));
  return Math.round(clamped * 10) / 10;
}

/**
 * The far end of a lane moved to a given reach, keeping the bearing it has.
 *
 * What the reach box does, and the reason it is a separate operation from the
 * tip handle rather than the same one: typing a distance must not swing the
 * lane onto different ground. That is the same separation the two kinds of
 * handle exist for — length and direction on the tip, width on the rim — one
 * step further, because a number you type is the one input that can be exact.
 */
export function laneAtReach(stand, lane, metres) {
  const to = lane?.to;
  if (!Array.isArray(to) || !isNum(to[0]) || !isNum(to[1])) return null;
  if (!isNum(stand?.lat) || !isNum(stand?.lng) || !isNum(metres)) return null;
  const deg = bearing(stand.lat, stand.lng, to[1], to[0]);
  const p = offsetPoint(stand.lat, stand.lng, deg, Math.max(MIN_LANE_REACH_M, metres));
  return [p.lng, p.lat];
}

/** Where a lane points, how far it reaches, and how wide it opens. */
export function laneGeometry(stand, lane, { spreadDeg = LANE_SPREAD_DEG } = {}) {
  const to = lane?.to;
  if (!Array.isArray(to) || !isNum(to[0]) || !isNum(to[1])) return null;
  if (!isNum(stand?.lat) || !isNum(stand?.lng)) return null;
  const deg = bearing(stand.lat, stand.lng, to[1], to[0]);
  const metres = Math.round(distanceM(stand.lat, stand.lng, to[1], to[0]));
  const spread = laneSpread(lane, spreadDeg);
  return {
    to,
    label: lane.label ?? null,
    bearingDeg: Math.round(deg * 10) / 10,
    point: COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16],
    metres,
    spreadDeg: spread,
    // The same width said the way it would be said out loud. Carried on the
    // geometry rather than worked out again by whoever is displaying it, so
    // the form, the cone's own readout and the API all quote one number.
    //
    // To a tenth of a metre, not a whole one, because it is shown in yards: a
    // whole metre is more than a yard, so rounding here first would cost the
    // last digit of what is displayed. Typing "40 yd wide" and watching it
    // settle back to 39 is exactly the kind of small betrayal that stops
    // somebody trusting a box.
    widthM: Math.round(laneWidthM(metres, spread) * 10) / 10,
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
    MIN_LANE_REACH_M,
  };
  const body = [
    `const COMPASS = ${JSON.stringify(COMPASS)};`,
    ...Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`),
    `const isNum = ${isNum.toString()};`,
    `const distanceM = ${distanceM.toString()};`,
    `const bearing = ${bearing.toString()};`,
    `const offsetPoint = ${offsetPoint.toString()};`,
    `const angleBetween = ${angleBetween.toString()};`,
    `const laneSpread = ${laneSpread.toString()};`,
    `const laneWidthM = ${laneWidthM.toString()};`,
    `const spreadForWidthM = ${spreadForWidthM.toString()};`,
    `const laneAtReach = ${laneAtReach.toString()};`,
    `const laneGeometry = ${laneGeometry.toString()};`,
    `const laneGeometries = ${laneGeometries.toString()};`,
    `const huntableFromLanes = ${huntableFromLanes.toString()};`,
    `const compareToManual = ${compareToManual.toString()};`,
    // bearing, angleBetween and the spread bounds go across too: the map has to
    // turn a dragged handle into a half-angle, and doing that with its own copy
    // of the trigonometry is how the cone you drag and the cone that decides
    // the winds start to differ.
    //
    // The width and reach conversions cross for the same reason one step on.
    // The form takes a lane's size as yards out and yards across, which are not
    // what is stored — a half-angle is — so something has to convert, and if
    // that something is a tangent typed into the page then the width you set
    // and the width you are judged on are two numbers that merely started
    // equal.
    'return { laneGeometry, laneGeometries, huntableFromLanes, compareToManual,'
    + ' laneSpread, laneWidthM, spreadForWidthM, laneAtReach, bearing, offsetPoint,'
    + ' angleBetween, LANE_SPREAD_DEG, MIN_LANE_SPREAD_DEG, MAX_LANE_SPREAD_DEG,'
    + ' MIN_LANE_REACH_M };',
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
