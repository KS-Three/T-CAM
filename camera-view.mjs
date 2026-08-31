/**
 * camera-view.mjs — which way a camera is pointed, and how far it sees.
 *
 * A camera's view is stored and drawn as ONE SHOOTING LANE. That is not a
 * shortcut: a lane already is "a cone from a point, out to a distance, this
 * wide", which is exactly what a trail camera's detection zone is. Reusing
 * `laneGeometry()` means the bearing maths, the width maths, the drag handles
 * and the cone drawing all stay single copies. A second implementation of a
 * cone is how the picture and the model start disagreeing.
 *
 * ## What this is FOR, and what it cannot do on its own
 *
 * Knowing a camera faces north tells you which ground it photographs. It does
 * NOT tell you which way a deer in that photograph was walking — a deer in a
 * north-facing frame may be heading east, west, toward the camera or away from
 * it, and the bearing alone cannot separate those four. What separates them is
 * where the animal sits from FRAME TO FRAME across a burst: left-to-right
 * across a north-facing frame is eastward, right-to-left is westward, growing
 * larger is toward the camera.
 *
 * So this module is half of a direction, deliberately. It carries the facing
 * and refuses to imply travel. The other half reads the frames.
 */

import { bearing, offsetPoint, COMPASS } from './routes.mjs';
import { laneGeometry, laneSpread, MIN_LANE_SPREAD_DEG, MAX_LANE_SPREAD_DEG } from './coverage.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Half-angle of a trail camera's cone when nobody has said otherwise.
 *
 * The FLEX-M's detection zone is quoted at about 42 degrees across, so half of
 * that. It is a default and not a fact about your camera: every model differs,
 * mounting height and undergrowth change what it really sees, and the handles
 * on the cone are there precisely so the drawn shape can be made to match what
 * the photos actually show rather than what a spec sheet claims.
 */
export const CAMERA_SPREAD_DEG = 21;

/**
 * How far out the cone is drawn when a camera is first given a facing.
 *
 * Detection range is a marketing number measured on a warm animal crossing an
 * open lane at night. Twenty-five metres is roughly where a deer stops being
 * reliably triggered in cover, and it is a starting point to drag, not a claim.
 */
export const CAMERA_REACH_M = 25;

/**
 * Read a stored view, refusing anything that is not one.
 *
 * Returns null rather than a default cone for unset or malformed input: a
 * camera with no facing recorded must read as "nobody has said", never as
 * "pointed north". A guessed bearing drawn in the same ink as a measured one
 * is worse than no bearing at all, because the map stops distinguishing them.
 */
export function parseView(raw) {
  let v = raw;
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const to = v.to;
  if (!Array.isArray(to) || !isNum(to[0]) || !isNum(to[1])) return null;
  if (Math.abs(to[0]) > 180 || Math.abs(to[1]) > 90) return null;
  const out = { to: [to[0], to[1]] };
  if (isNum(v.spread)) {
    out.spread = Math.min(MAX_LANE_SPREAD_DEG, Math.max(MIN_LANE_SPREAD_DEG, v.spread));
  }
  return out;
}

/**
 * Where a camera looks: bearing, compass point, reach and spread.
 *
 * Same shape a shooting lane reports, from the same function, so anything that
 * can draw a lane can draw this.
 */
export function cameraView(cam) {
  const view = parseView(cam?.view);
  if (!view) return null;
  if (!isNum(cam?.lat) || !isNum(cam?.lng)) return null;
  return laneGeometry({ lat: cam.lat, lng: cam.lng }, view, { spreadDeg: CAMERA_SPREAD_DEG });
}

/**
 * The view a camera would get if it were pointed at a bearing, at a distance.
 *
 * The inverse of the above, for setting a facing by typing rather than by
 * dragging — "it looks down the trail, roughly northeast".
 */
export function viewFromBearing(cam, bearingDeg, metres = CAMERA_REACH_M,
  spread = CAMERA_SPREAD_DEG) {
  if (!isNum(cam?.lat) || !isNum(cam?.lng) || !isNum(bearingDeg)) return null;
  const p = offsetPoint(cam.lat, cam.lng, ((bearingDeg % 360) + 360) % 360,
    Math.max(1, isNum(metres) ? metres : CAMERA_REACH_M));
  return { to: [p.lng, p.lat], spread: laneSpread({ spread }, CAMERA_SPREAD_DEG) };
}

/**
 * Whether a point falls inside what the camera sees.
 *
 * Used to say which stands sit in a camera's view — the thing that makes a
 * photograph mean something for a particular sit rather than for the property
 * in general.
 */
export function seesPoint(cam, lat, lng) {
  const v = cameraView(cam);
  if (!v || !isNum(lat) || !isNum(lng)) return false;
  const deg = bearing(cam.lat, cam.lng, lat, lng);
  const off = Math.abs(((deg - v.bearingDeg + 540) % 360) - 180);
  if (off > v.spreadDeg) return false;
  const d = distanceBetween(cam.lat, cam.lng, lat, lng);
  return d <= v.metres;
}

/** Metres between two points. Spherical earth is ample at camera distances. */
function distanceBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "NNE 23° · 27 m" — one phrasing, so the card and the API agree. */
export function facingLine(cam) {
  const v = cameraView(cam);
  if (!v) return null;
  return `${v.point} ${Math.round(v.bearingDeg)}° · ${v.metres} m`;
}

export { COMPASS };
