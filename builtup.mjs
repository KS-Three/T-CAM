/**
 * builtup.mjs — the house, the barn and the blacktop.
 *
 * The parcel filter answers "is this my ground". It does not answer "is this a
 * place a stand can go", and on a real property those are different questions:
 * one of the two real properties is classed residential AND agricultural,
 * because there is a house on it, and a suggester that only checks ownership
 * will cheerfully put a stand in the yard. It is your ground. It is not a
 * stand site.
 *
 * Roads are the same shape of mistake from the other side. A state highway
 * right-of-way is not a parcel at all, so ownership has nothing to say about
 * it — and the ground beside a highway is where the terrain module finds its
 * best draws, because a road cut IS a draw as far as a contour map is
 * concerned.
 *
 * So this asks OpenStreetMap what is built here. Overpass is free, needs no
 * key, and the two things wanted from it — building footprints and classified
 * roads — are the parts of OSM that rural Wisconsin actually has mapped well.
 *
 * WHAT IT IS NOT: a legal setback. Wisconsin's rules about hunting near a
 * building are their own subject with their own exceptions, and legal-light.mjs
 * is where regulation lives in this program. The distances below are hunting
 * sense — far enough that you are not in somebody's yard and not watching
 * traffic — and they are parameters because reasonable people set them
 * differently on a 40 than on a section.
 *
 * OSM is also incomplete. A building it does not know about will not be
 * avoided, which is why nothing here upgrades the suggester's caveat: these
 * are still places to go and WALK.
 */

import { pointToSegmentM } from './track.mjs';

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// Overridable so tests can point at a local stand-in rather than a public
// service, and so a slow public instance can be swapped for a mirror.
export const ENDPOINT = () => process.env.TRAILCAM_OVERPASS_URL || DEFAULT_ENDPOINT;

/** Who is asking. See the fetch below for why this is not optional. */
export const USER_AGENT = 'trailcam (personal hunting tool; github.com/KS-Three/TrailCam)';

/**
 * How close to a building is too close, in metres.
 *
 * A hundred and twenty is a compromise and is stated as one: beyond the far
 * side of most rural yards, beyond where a dog notices you, and short enough
 * that it does not sterilise a whole forty around a farmhouse. Anyone hunting
 * a small parcel with a house on it wants this smaller and should say so.
 */
export const BUILDING_STANDOFF_M = 120;

/**
 * How close to a classified road is too close, in metres.
 *
 * Sixty. Far enough that headlights are not in your face and that nobody
 * driving past is looking at your silhouette, and close enough that the
 * roadside cover deer genuinely use is not thrown away.
 */
export const ROAD_STANDOFF_M = 60;

/**
 * The road classes worth standing off from.
 *
 * Deliberately NOT `service`, `track`, `path` or `footway`: a field road or a
 * two-track through the woods is where you want to be, not something to avoid,
 * and treating farm lanes as roads is how this would refuse the best ground on
 * an agricultural property.
 */
export const AVOID_HIGHWAY =
  /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$/;

/** The Overpass query, as its own function so a test can read what was asked. */
export function overpassQuery(lat, lng, radiusM) {
  const r = Math.round(radiusM);
  const at = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  return '[out:json][timeout:30];('
    + `way["building"](around:${r},${at});`
    + `way["highway"](around:${r},${at});`
    + ');out geom;';
}

/**
 * Turn an Overpass answer into the two lists this needs.
 *
 * Buildings become their nodes rather than a centroid: a hundred-foot machine
 * shed measured from its middle is fifty feet closer than it looks, and the
 * cheap fix is to measure from the wall.
 */
export function parseBuiltUp(body) {
  const buildings = [];
  const roads = [];
  for (const el of body?.elements ?? []) {
    const geom = Array.isArray(el?.geometry) ? el.geometry : null;
    if (!geom || !geom.length) continue;
    const path = geom
      .filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
      .map(p => ({ lat: p.lat, lng: p.lon }));
    if (path.length < 1) continue;
    const tags = el.tags ?? {};
    if (tags.building) {
      buildings.push({ id: el.id ?? null, kind: tags.building, path });
    } else if (tags.highway && AVOID_HIGHWAY.test(tags.highway)) {
      roads.push({ id: el.id ?? null, kind: tags.highway, path });
    }
  }
  return { buildings, roads };
}

// Cached in memory only, like the parcel layer: this is a few hundred KB of
// public map data about ground you are already asking the tool about, and a
// second press of the button inside the hour should not go back out for it.
const cache = new Map();
const CACHE_MAX = 40;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function clearBuiltUpCache() { cache.clear(); }

/**
 * What is built within `radiusM` of a point.
 *
 * Throws on a service or network failure, so the caller can say "this was not
 * checked" instead of "there is nothing here" — the same refusal the parcel
 * module makes, and for the same reason.
 */
export async function builtUpNear(lat, lng, radiusM, { signal, fetchImpl = fetch } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('built-up lookup needs a latitude and longitude');
  }
  // The key rounds to about a hundred metres and buckets the radius, so panning
  // a little does not miss the cache while a genuinely different area does.
  const k = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(radiusM / 250)}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const res = await fetchImpl(ENDPOINT(), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Overpass answers 406 Not Acceptable to a request with no User-Agent —
      // an HTML error page, not a JSON one, so the failure arrives looking like
      // a parse bug rather than a policy. Naming the tool is also simply the
      // courteous way to use a free public instance.
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ data: overpassQuery(lat, lng, radiusM) }).toString(),
    signal,
  });
  if (!res.ok) throw new Error(`the map service returned HTTP ${res.status}`);
  const body = await res.json();
  if (body?.remark && !body?.elements) {
    // Overpass reports load shedding and timeouts in a remark on a 200.
    throw new Error(`the map service refused: ${body.remark}`);
  }
  const value = parseBuiltUp(body);

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { at: Date.now(), value });
  return value;
}

/** Metres from a point to the nearest node of a way, or null for an empty way. */
export function distanceToPath(point, path) {
  if (!Array.isArray(path) || !path.length) return null;
  if (path.length === 1) return pointToSegmentM(point, path[0], path[0]);
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const d = pointToSegmentM(point, path[i - 1], path[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Drop the suggestions that are in somebody's yard or beside the blacktop.
 *
 * Returns the same shape it was given, with the survivors, the count of what
 * went and why, and — when the check could not run — a note saying so rather
 * than a silent pass. A dropped spot is dropped, not marked down: a stand
 * eighty metres off Highway 21 is not a worse stand, it is not a stand.
 */
export function clearOfBuiltUp(result, {
  built = null,
  buildingStandoffM = BUILDING_STANDOFF_M,
  roadStandoffM = ROAD_STANDOFF_M,
  unavailable = null,
} = {}) {
  const notes = [...(result?.notes ?? [])];
  if (unavailable) {
    notes.push(`Buildings and roads were not checked (${unavailable}), so look at `
      + 'the satellite layer before you walk any of these.');
    return { ...result, notes, builtUpChecked: false };
  }
  if (!result?.candidates?.length || !built) return result;

  const kept = [];
  let nearBuilding = 0;
  let nearRoad = 0;
  for (const c of result.candidates) {
    const p = { lat: c.lat, lng: c.lng };
    const b = built.buildings.reduce((best, w) => {
      const d = distanceToPath(p, w.path);
      return d !== null && d < best ? d : best;
    }, Infinity);
    if (b <= buildingStandoffM) { nearBuilding++; continue; }
    const r = built.roads.reduce((best, w) => {
      const d = distanceToPath(p, w.path);
      return d !== null && d < best ? d : best;
    }, Infinity);
    if (r <= roadStandoffM) { nearRoad++; continue; }
    kept.push(c);
  }

  if (nearBuilding) {
    notes.push(`${nearBuilding} spot${nearBuilding === 1 ? '' : 's'} came out within `
      + `${buildingStandoffM} m of a building and ${nearBuilding === 1 ? 'was' : 'were'} dropped.`);
  }
  if (nearRoad) {
    notes.push(`${nearRoad} spot${nearRoad === 1 ? '' : 's'} came out within `
      + `${roadStandoffM} m of a road and ${nearRoad === 1 ? 'was' : 'were'} dropped.`);
  }
  if (nearBuilding || nearRoad) {
    notes.push('Buildings and roads come from OpenStreetMap, which is good in rural '
      + 'Wisconsin and not complete — a shed nobody has mapped will not be avoided.');
  }
  // Zero buildings on a rural section is far more often "nobody has mapped
  // this" than "there is nothing here", and the difference matters: on ground
  // OSM has not touched, this filter did not fail — it had nothing to say, and
  // saying nothing looks exactly like saying all clear.
  if (!built.buildings.length) {
    notes.push('OpenStreetMap has no buildings mapped on this ground at all, which '
      + 'on a rural section usually means unmapped rather than empty — the house '
      + 'check found nothing to check against, so use the satellite layer.');
  }
  return {
    ...result,
    candidates: kept,
    notes,
    builtUpChecked: true,
    builtUpCounts: { buildings: built.buildings.length, roads: built.roads.length },
  };
}
