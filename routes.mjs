/**
 * routes.mjs — the walk in, and whether it ruins the sit.
 *
 * The classic way a good stand is wasted is not sitting it on the wrong wind.
 * It is walking to it across the ground you were about to hunt, an hour before
 * dark, leaving a scent line the deer cross on their way in. The stand was
 * fine. The approach was not.
 *
 * So a route is stored and scored the same way a stand is: against the wind.
 * A stand has good winds; this works out which winds a ROUTE is clean on, and
 * the two have to agree before a sit is actually a good idea.
 *
 * The model, stated plainly because it is a model and not a measurement:
 *
 *   Scent travels downwind. Every point of your walk sits at the apex of a cone
 *   opening downwind of it. Anything inside that cone has been told you are
 *   there. A route is dirty for a given wind if the stand — or the ground you
 *   expect deer to approach from — falls inside the cone of any point on it.
 *
 * The two numbers that define the cone are deliberately visible and adjustable
 * rather than buried. A half-angle of 30 degrees and a reach of 200 m are
 * defensible middles, not physics: real scent plumes wander with terrain,
 * thermals and humidity, and a deer's nose beats 200 m easily in the right
 * conditions. The honest claim is "this walk is upwind of your stand", not
 * "this walk cannot be smelled".
 */

import { distanceM } from './db.mjs';

export const CONE_HALF_ANGLE_DEG = 30;
export const CONE_REACH_M = 200;

export const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass bearing from one point to another, degrees clockwise from north. */
export function bearing(fromLat, fromLng, toLat, toLng) {
  const φ1 = fromLat * Math.PI / 180, φ2 = toLat * Math.PI / 180;
  const Δλ = (toLng - fromLng) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * The point `metres` along `bearingDeg` from somewhere — the inverse of the
 * bearing above, and the thing you need whenever a distance is TYPED rather
 * than clicked.
 *
 * Equirectangular rather than the full great-circle formula, which is exact
 * enough by a wide margin at the ranges anything here works over: at a
 * kilometre the error is under a centimetre, and this is used for shooting
 * lanes and stand setbacks measured in tens of metres.
 *
 * It lives here, beside bearing() and with the same radius, because the two
 * are used as a pair and a second copy of the arithmetic elsewhere is how a
 * distance typed in and a distance measured back start to disagree.
 */
export function offsetPoint(lat, lng, bearingDeg, metres) {
  const R = 6371008.8;
  const br = bearingDeg * Math.PI / 180;
  const dLat = (metres * Math.cos(br)) / R * 180 / Math.PI;
  const dLng = (metres * Math.sin(br)) / (R * Math.cos(lat * Math.PI / 180)) * 180 / Math.PI;
  return { lat: lat + dLat, lng: lng + dLng };
}

/**
 * Smallest angle between two bearings, 0..180.
 *
 * The wrap expression below IS the answer; an earlier version subtracted it
 * from 180 as well, which inverted every result — a route due west of a stand
 * then read clean on a west wind and dirty on an east one, exactly backwards.
 * That is the worst possible failure for this file, because it would send you
 * up a stand you had just walked your scent across while telling you it was
 * fine, and nothing on the map would look wrong.
 */
export const angleBetween = (a, b) =>
  Math.abs(((a - b) % 360 + 540) % 360 - 180);

/** Route length on the ground, in metres. */
export function routeLength(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    m += distanceM(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
  }
  return Math.round(m);
}

/**
 * Does walking this route put scent on a target, given a wind?
 *
 * `windFromDeg` is where the wind COMES FROM, the same convention as everywhere
 * else here. Scent therefore travels toward windFrom + 180.
 *
 * Returns the worst offending point rather than a bare yes/no, because "your
 * walk blows across the stand for the last 120 m" is something you can act on
 * and "dirty" is not.
 */
export function scentReaches(points, target, windFromDeg, {
  halfAngleDeg = CONE_HALF_ANGLE_DEG, reachM = CONE_REACH_M,
} = {}) {
  if (!Number.isFinite(windFromDeg)) return null;   // unknown wind, unknown answer
  const downwind = (windFromDeg + 180) % 360;
  let worst = null;
  for (const [lng, lat] of points) {
    const d = distanceM(lat, lng, target.lat, target.lng);
    if (d > reachM) continue;
    const toTarget = bearing(lat, lng, target.lat, target.lng);
    const off = angleBetween(downwind, toTarget);
    if (off > halfAngleDeg) continue;
    if (!worst || d < worst.metres) {
      worst = { metres: Math.round(d), offAxisDeg: Math.round(off), at: [lng, lat] };
    }
  }
  return worst;
}

/**
 * Which winds this route is clean on.
 *
 * Checked against all sixteen compass points rather than only the forecast, so
 * a route can be judged when it is CUT rather than only on the morning you use
 * it — which is when you can still move it.
 */
export function routeWinds(points, target, opts = {}) {
  const clean = [];
  const dirty = [];
  for (let i = 0; i < 16; i++) {
    const deg = i * 22.5;
    const hit = scentReaches(points, target, deg, opts);
    (hit ? dirty : clean).push(COMPASS[i]);
  }
  return { clean, dirty };
}

/**
 * The whole verdict for one route on one wind.
 *
 * `stand` is where you are going. `others` are the other stands and any bedding
 * markers you would rather not blow out on the way past — walking under a
 * second stand on the way to the first is the same mistake one step removed.
 */
export function assessRoute(route, { stand, others = [], windFromDeg, ...opts } = {}) {
  const points = route.points ?? [];
  const lengthM = routeLength(points);
  if (points.length < 2) {
    return { lengthM, ok: null, why: 'this route needs at least two points' };
  }
  if (!stand) {
    return { lengthM, ok: null, why: 'this route is not attached to a stand' };
  }

  const onStand = scentReaches(points, stand, windFromDeg, opts);
  const crossed = others
    .map(o => ({ target: o, hit: scentReaches(points, o, windFromDeg, opts) }))
    .filter(x => x.hit);

  // Unknown wind is unknown, never "fine". The same rule the stand ranking
  // follows: a missing input must not read as a passing grade.
  if (!Number.isFinite(windFromDeg)) {
    return { lengthM, ok: null, why: 'no wind for this sit, so the walk cannot be judged' };
  }

  const point = COMPASS[Math.round(((windFromDeg % 360) + 360) % 360 / 22.5) % 16];
  if (onStand) {
    return {
      lengthM, ok: false, onStand, crossed,
      why: `on a ${point} wind this walk carries your scent over ${stand.name ?? 'the stand'}`
        + ` — closest ${onStand.metres} m, and you get there before the deer do`,
    };
  }
  if (crossed.length) {
    return {
      lengthM, ok: true, onStand: null, crossed,
      why: `clear of ${stand.name ?? 'the stand'} on a ${point} wind, but it blows across `
        + crossed.map(c => c.target.name ?? 'another spot').join(', '),
    };
  }
  return {
    lengthM, ok: true, onStand: null, crossed: [],
    why: `upwind of ${stand.name ?? 'the stand'} on a ${point} wind`,
  };
}
