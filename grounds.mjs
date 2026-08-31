/**
 * grounds.mjs — which piece of land is which.
 *
 * Two hunting properties is the normal case this program had not met: one map
 * that frames EVERYTHING opens at a zoom where both parcels are specks, and
 * "go look at the other place" means a minute of panning. The fix is a
 * switcher, and the switcher needs to know what the pieces are.
 *
 * A ground is DISCOVERED, not configured. Everything with coordinates —
 * cameras, stands, markers — is clustered by proximity: two things within
 * walking distance of each other are on the same ground, things you drive
 * between are not. Nobody files their stands into folders, no form grows a
 * "property" field, and a stand dropped on the far parcel next week lands in
 * the right ground because geography says so, not because anyone remembered
 * to assign it.
 *
 * The gap is 2 km, single-linkage (a chain of things each within the gap is
 * one ground). A Wisconsin forty is 400 m on a side, so parcels you hunt as
 * one piece chain comfortably; separate lands are miles apart. Two properties
 * literally across the road from each other will merge — and framing both
 * together is the right answer for ground you can walk between anyway.
 *
 * Naming is the one deliberate act: an unnamed ground is described by what is
 * on it ("3 cameras, 5 stands"); giving it a name creates the property row
 * the schema has carried since day one and assigns the members. The label
 * then comes from the members' own property names — majority wins, so one
 * stray assignment does not relabel a whole ground.
 */

import { distanceM } from './db.mjs';

/** Walking distance vs. driving distance, in metres. See the header. */
export const GROUND_GAP_M = 2000;

/**
 * Cluster located things into grounds.
 *
 * Points are { id, kind, lat, lng, property } — kind one of camera | stand |
 * marker, property the name already assigned or null. Anything without finite
 * coordinates is skipped, never guessed at. Returns grounds biggest first
 * (the home ground stays on top of the list as both places grow), each with
 * bounds, centre, counts by kind, member ids by kind, and the majority
 * property name or null.
 */
export function groundsFrom(points, { gapM = GROUND_GAP_M } = {}) {
  const pts = (points || []).filter(p => Number.isFinite(p && p.lat) && Number.isFinite(p && p.lng));

  // Single-linkage via union-find. O(n²) distance checks: at a few hundred
  // pins that is thousands of haversines, not a performance question.
  const parent = pts.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (distanceM(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) <= gapM) {
        const ri = find(i), rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }

  const byRoot = new Map();
  pts.forEach((p, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(p);
  });

  const grounds = [...byRoot.values()].map(members => {
    const lats = members.map(p => p.lat), lngs = members.map(p => p.lng);
    const bounds = {
      south: Math.min(...lats), north: Math.max(...lats),
      west: Math.min(...lngs), east: Math.max(...lngs),
    };
    const counts = {};
    const ids = { camera: [], stand: [], marker: [] };
    const votes = new Map();
    for (const p of members) {
      counts[p.kind] = (counts[p.kind] || 0) + 1;
      if (ids[p.kind]) ids[p.kind].push(p.id);
      if (p.property) votes.set(p.property, (votes.get(p.property) || 0) + 1);
    }
    let name = null, best = 0;
    for (const [n, v] of votes) if (v > best) { best = v; name = n; }
    return {
      name,
      bounds,
      centre: { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 },
      counts,
      ids,
      size: members.length,
    };
  });

  // Biggest first, west as the tiebreak so the order is stable rather than an
  // accident of insertion.
  grounds.sort((a, b) => b.size - a.size || a.bounds.west - b.bounds.west);
  return grounds;
}

/**
 * Which ground a point is on, or null for open country between them.
 *
 * The switcher needed this the moment anything else did work "here": a request
 * that says only where the map is scrolled has no idea which property it is
 * about, and the parts of this program that reason about YOUR stands — what
 * winds you are short of, whose ground the neighbour is — get the wrong answer
 * when they are handed every pin from both places at once.
 *
 * Inside a ground's bounds settles it. Otherwise the nearest centre wins, but
 * only within the same walking-distance gap the clustering uses: pan out to
 * the county road halfway between two properties and the honest answer is
 * neither, not whichever happens to be nearer.
 */
export function groundAt(grounds, lat, lng, { gapM = GROUND_GAP_M } = {}) {
  if (!Array.isArray(grounds) || !grounds.length) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const inside = grounds.filter(g => g && g.bounds
    && lat >= g.bounds.south && lat <= g.bounds.north
    && lng >= g.bounds.west && lng <= g.bounds.east);
  const pool = inside.length ? inside : grounds;

  let best = null;
  for (const g of pool) {
    const d = distanceM(lat, lng, g.centre.lat, g.centre.lng);
    if (!best || d < best.d) best = { g, d };
  }
  if (!best) return null;
  // A point inside the bounds is on that ground however far the centre is —
  // a long skinny property's centre can be several hundred metres from a
  // corner you are standing in.
  return inside.length || best.d <= gapM ? best.g : null;
}

/** What an unnamed ground is called in a list: what is on it, plainly. */
export function describeGround(g) {
  const parts = [];
  for (const k of ['camera', 'stand', 'marker']) {
    const n = (g && g.counts && g.counts[k]) || 0;
    if (n) parts.push(n + ' ' + k + (n === 1 ? '' : 's'));
  }
  return parts.join(', ') || 'nothing placed';
}

/**
 * The same functions, as source, for the map to use in the browser — the
 * repo's one-definition rule (see measure.mjs, whose pattern this copies).
 * The switcher clusters the pins the page already holds, so this arithmetic
 * must exist client-side, and a second copy is how the dropdown and the tests
 * would come to disagree about where one ground ends.
 */
export function browserSource(globalName = 'GROUNDS') {
  const consts = { GROUND_GAP_M };
  const fns = { distanceM, groundsFrom, describeGround };
  const body = [
    ...Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`),
    ...Object.entries(fns).map(([k, f]) => `const ${k} = ${f.toString()};`),
    `return { ${Object.keys(fns).join(', ')}, GROUND_GAP_M };`,
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
