/**
 * stand-context.mjs — the two things about a stand that the program already
 * knew and had never once used.
 *
 * Both of these were sitting in the database. Every sit Kent logs goes into the
 * `sits` table; every crop field he draws carries a crop type and a CUT DATE.
 * Neither has ever moved a ranking by a single point, while the planner was
 * scoring a barometric band that traces to a magazine.
 *
 * 1. HUNTING PRESSURE. This is the largest actionable effect in
 *    docs/deer-evidence.md and it is not close. Mississippi State watched
 *    hunter observations of collared bucks KNOWN TO STILL BE THERE fall 62% by
 *    the second weekend. Collar work reported by Deer & Deer Hunting measured
 *    daytime movement down 22% by Saturday and 34% by Sunday, recovering by
 *    Thursday or Friday. Little et al. (2016, 37 collared males, southern
 *    Oklahoma) found prolonged exposure drove deer into security cover and
 *    dropped observation rates.
 *
 *    Note what all three measure: OBSERVATIONS and daytime movement, not total
 *    movement. Wisconsin collar data (Hunsaker 2025) found opening firearm
 *    weekend had no significant effect on movement RATE. The deer do not leave
 *    and they do not stop walking. You stop seeing them. That is exactly the
 *    thing a stand ranking is trying to predict, which is why this belongs here
 *    and not in the weather model.
 *
 * 2. FOOD. What is standing and what has been cut moves the whole herd, and it
 *    is the one input on this property that changes on a known date rather than
 *    being inferred. A cut date is a fact; everything else here is a forecast.
 *
 * Both are capped well below the wind term. A stand you have burned is a worse
 * stand; a stand the wind is wrong for is not a stand at all, and no amount of
 * fresh corn changes that.
 */

import { distanceM } from './db.mjs';

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

/**
 * How fast a sat stand recovers, in days.
 *
 * The collar work has daytime movement back toward normal by the Thursday or
 * Friday after a hunted weekend — four to five days. So sits decay with a
 * five-day time constant, which puts yesterday's sit at nearly full weight and
 * one from a fortnight ago at almost none.
 */
export const RECOVERY_DAYS = 5;

/** Sits older than this are not counted at all, however the maths decays. */
export const PRESSURE_WINDOW_DAYS = 21;

/** The most a burned stand can lose. Deliberately far below the wind term. */
export const MAX_PRESSURE_PENALTY = 12;

/**
 * Recency-weighted count of how hard a stand has been hunted lately.
 *
 * Weighted rather than a plain count because four sits in four days and four
 * sits across a month are completely different situations and a count cannot
 * tell them apart.
 */
export function pressureAt(stand, sits = [], { now = Date.now() } = {}) {
  const mine = sits.filter(s => s.stand_id === stand.id || s.standId === stand.id);
  const scored = [];
  for (const s of mine) {
    const when = Date.parse(s.ended_at ?? s.started_at ?? `${s.date}T12:00:00Z`);
    if (!Number.isFinite(when) || when > now) continue;
    const daysAgo = (now - when) / 86400000;
    if (daysAgo > PRESSURE_WINDOW_DAYS) continue;
    scored.push({ daysAgo, weight: Math.exp(-daysAgo / RECOVERY_DAYS) });
  }
  const burn = scored.reduce((s, x) => s + x.weight, 0);
  const lastSit = scored.length ? Math.min(...scored.map(s => s.daysAgo)) : null;

  // Bands rather than a curve, for the same reason the thermal bands are
  // bands: the honest resolution of "how burned is this stand" from a handful
  // of logged sits is about this, and a decimal would imply precision that is
  // not there.
  let points = 0, why;
  if (!mine.length) {
    why = 'no sits logged here — pressure is unknown, not zero. Log your sits and this starts working';
  } else if (burn >= 2.0) {
    points = -MAX_PRESSURE_PENALTY;
    why = `hunted hard lately (${scored.length} sits in ${PRESSURE_WINDOW_DAYS} days, last ${fmtDays(lastSit)}) — `
      + 'observations of bucks known to still be present fell 62% by the second weekend in the Mississippi State collar data';
  } else if (burn >= 1.2) {
    points = -7;
    why = `sat ${scored.length} time${scored.length === 1 ? '' : 's'} recently, last ${fmtDays(lastSit)} — `
      + 'daytime movement measured down 22-34% across consecutive hunted days';
  } else if (burn >= 0.4) {
    points = -3;
    why = `sat ${fmtDays(lastSit)}, and a stand takes about ${RECOVERY_DAYS} days to come back`;
  } else if (lastSit !== null && lastSit >= 10) {
    points = 3;
    why = `rested — nothing logged here for ${Math.round(lastSit)} days`;
  } else {
    points = 0;
    why = `last sat ${fmtDays(lastSit)}, far enough back to have recovered`;
  }

  return {
    points, why, burn: Math.round(burn * 100) / 100,
    sits: scored.length, lastSitDaysAgo: lastSit === null ? null : Math.round(lastSit * 10) / 10,
    known: mine.length > 0,
  };
}

const fmtDays = d => d === null ? 'never'
  : d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.round(d)} days ago`;

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

/** A field further than this from a stand is not the reason deer are there. */
export const FIELD_REACH_M = 250;

/** Waste grain pulls hard, then gets eaten. Roughly three weeks of it. */
export const FRESH_CUT_DAYS = 21;

/**
 * Centroid of a polygon ring, which is all the precision this needs.
 *
 * A stored field point is [lng, lat] — longitude FIRST, the GeoJSON order that
 * db.mjs enforces on routes and fields alike. Reading it as [lat, lng] puts a
 * Wisconsin field in the Indian Ocean, every distance comes back as thousands
 * of kilometres, and the only symptom is that food silently never applies.
 * That is exactly the shape of the parcel bug in state-of-play, so it is
 * spelled out rather than left to the reader.
 */
export function ringCentre(points) {
  const pts = (typeof points === 'string' ? JSON.parse(points) : points) ?? [];
  if (!Array.isArray(pts) || !pts.length) return null;
  let lat = 0, lng = 0, n = 0;
  for (const p of pts) {
    const la = Array.isArray(p) ? p[1] : p?.lat;
    const ln = Array.isArray(p) ? p[0] : p?.lng;
    if (Number.isFinite(la) && Number.isFinite(ln)) { lat += la; lng += ln; n++; }
  }
  return n ? { lat: lat / n, lng: lng / n } : null;
}

/**
 * What the food near a stand is doing on the day of the sit.
 *
 * Only ever a nudge. Food explains where deer go, but a field is a big thing
 * and a stand is a point in it, and this program cannot tell which corner they
 * enter from — the cameras answer that, and they answer it with evidence.
 */
export function foodAt(stand, fields = [], { date = new Date() } = {}) {
  const near = [];
  for (const f of fields) {
    const c = ringCentre(f.points);
    if (!c) continue;
    const m = distanceM(stand.lat, stand.lng, c.lat, c.lng);
    if (m <= FIELD_REACH_M) near.push({ ...f, metres: Math.round(m), centre: c });
  }
  if (!near.length) {
    return { points: 0, why: 'no crop field mapped within '
      + `${FIELD_REACH_M} m — draw your fields and their cut dates to include food here`,
      fields: [] };
  }
  near.sort((a, b) => a.metres - b.metres);

  const day = date instanceof Date ? date : new Date(date);
  const parts = [];
  let points = 0;

  for (const f of near.slice(0, 3)) {
    const cut = f.cutAt ?? f.cut_at ?? null;
    const cutMs = cut ? Date.parse(`${cut}T12:00:00Z`) : null;
    const sinceCut = Number.isFinite(cutMs) ? (day.getTime() - cutMs) / 86400000 : null;
    const label = f.name || f.crop;

    const freshCut = sinceCut !== null && sinceCut >= 0 && sinceCut <= FRESH_CUT_DAYS;

    // Alfalfa first, and grain second, because a cut hay field and a cut corn
    // field are different events: one leaves waste grain on the ground, the
    // other leaves fresh regrowth. The generic branch used to describe a hay
    // cut as "waste grain", which is not a thing.
    if (f.crop === 'alfalfa' && sinceCut !== null && sinceCut >= 0 && sinceCut <= 30) {
      points += 3;
      parts.push({ points: 3, why: `${label} cut ${Math.round(sinceCut)} days ago — fresh regrowth is the best thing in the field` });
    } else if (freshCut && (f.crop === 'corn' || f.crop === 'soybeans')) {
      points += 5;
      parts.push({ points: 5, why: `${label} cut ${Math.round(sinceCut)} days ago — waste grain, and deer feed in the open once it is off` });
    } else if (freshCut) {
      points += 3;
      parts.push({ points: 3, why: `${label} cut ${Math.round(sinceCut)} days ago — deer feed in the open once it is off` });
    } else if (f.crop === 'corn' && sinceCut === null) {
      // Not a food penalty. Standing corn is food AND bedding AND cover, so it
      // holds deer rather than moving them, and a stand on the edge of it
      // competes with everything the deer needs already being inside.
      points -= 3;
      parts.push({ points: -3, why: `${label} is still standing — corn is food, bed and cover at once, so deer have little reason to step out of it` });
    } else if (f.crop === 'brassicas' && (day.getMonth() >= 10 || day.getMonth() === 0)) {
      points += 4;
      parts.push({ points: 4, why: `${label} — brassicas sweeten after hard frost and come into their own now` });
    } else {
      parts.push({ points: 0, why: `${label} ${f.metres} m away${cut ? `, cut ${cut}` : ''}` });
    }
  }

  // Capped for the same reason pressure is: food is a nudge, wind is a veto.
  points = Math.max(-6, Math.min(8, points));
  return { points, why: parts.map(p => p.why).join('; '), parts, fields: near };
}
