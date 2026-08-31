/**
 * stand-suggester.mjs — where to hang the next one.
 *
 * Every input this needs was already being computed and none of it was ever
 * put together. The terrain module finds the saddles, benches, draws and
 * ridgelines that concentrate movement. The wind history knows which winds
 * actually blow here during season, and the coverage analysis knows which of
 * them NO stand can be hunted on — the gap that quietly costs you days. The
 * markers know where you have found rubs, scrapes and beds. This walks that
 * evidence and proposes places to put a stand, with the reasoning attached.
 *
 * The central idea, and the reason the suggestions are not just "here is a
 * saddle": a stand is a PAIR — a piece of ground deer use, and a position
 * relative to it that the wind allows you to sit. The same saddle gives a
 * completely different stand depending on which side of it you hang, and which
 * side you should hang on is decided by the winds you cannot currently hunt.
 *
 * So each candidate is a feature plus an offset, and the offset is chosen to
 * make one of your MISSING winds huntable. That is why this can propose
 * something useful on ground you already know well: it is not finding you a new
 * saddle, it is finding you the side of a known saddle that fills a hole in
 * your season.
 *
 * WHAT IT IS NOT. It is a shortlist to go and walk, not a decision. It knows
 * nothing about property lines, standing crops, whether there is a tree there,
 * whether you can get a ladder in, or who owns the ground forty yards away.
 * Every output says so. A tool that says "hang it here" about ground it has
 * never seen is worse than one that says "these four spots are worth walking".
 */

import { bearing, angleBetween, COMPASS, CONE_HALF_ANGLE_DEG, offsetPoint } from './routes.mjs';
import { distanceM } from './db.mjs';
import { pointInRings } from './parcels.mjs';

/**
 * How far downwind of the feature to sit.
 *
 * Sixty yards is a compromise and is stated as one: inside comfortable rifle
 * range, at the far edge of what most people shoot with a bow, and far enough
 * that your movement in the tree is not happening on top of the trail. Anyone
 * hunting a bow in thick cover wants this smaller; it is a parameter for that
 * reason rather than a constant buried in the arithmetic.
 */
export const SETBACK_M = 55;

/** Two stands closer than this are the same stand for planning purposes. */
export const MIN_FROM_STAND_M = 100;

/** Sign this far from a candidate is treated as being at it. */
export const SIGN_RADIUS_M = 120;

/**
 * What each landform is worth as a place deer move through.
 *
 * The order is the conventional one and is not measured here — it comes from
 * how reliably each concentrates movement, not from anything in this data set.
 * Saddles first because a ridge crossing funnels hard; benches next because
 * deer both bed and travel on them; then draws, which carry movement on ground
 * too gentle for anything else; ridgelines last, because deer walk them but
 * with far less concentration.
 */
export const FEATURE_WEIGHT = {
  saddle: 26,
  bench: 20,
  drainage: 15,
  ridge: 10,
};

const FEATURE_WHY = {
  saddle: 'a saddle — the cheap crossing on this ridge, and deer take it for the same reason people do',
  bench: 'a bench — a flat shelf on a slope, which deer both bed on and travel along',
  drainage: 'a draw — it carries water and a trail, and it is invisible on satellite imagery',
  ridge: 'a ridgeline — deer walk them, though less predictably than a draw or a saddle',
};

/**
 * Move a point `metres` along a bearing.
 *
 * Moved to routes.mjs, which owns the rest of this geometry, once the lane
 * form needed it too — a typed reach has to put the far end somewhere. Kept
 * exported from here because that is where callers and tests already look for
 * it, and re-exporting costs nothing next to two copies of the arithmetic.
 */
export { offsetPoint };

/**
 * Which winds a stand at `from` can be hunted on, given the deer are at `at`.
 *
 * The rule is the same one the route checker uses, and it is the only honest
 * definition available without a season of sitting there: you can hunt a wind
 * if it does not carry your scent into the ground you are watching. Wind comes
 * FROM `w`, so scent travels toward `w + 180`; the stand is unhuntable on that
 * wind when the feature falls inside that cone.
 */
export function huntableWinds(from, at, { halfAngleDeg = CONE_HALF_ANGLE_DEG } = {}) {
  const toFeature = bearing(from.lat, from.lng, at.lat, at.lng);
  const winds = [];
  for (let i = 0; i < 16; i++) {
    const w = i * 22.5;
    if (angleBetween((w + 180) % 360, toFeature) > halfAngleDeg) winds.push(COMPASS[i]);
  }
  return winds;
}

/** Every point that represents a feature, flattened and labelled. */
export function anchorPoints(features, { alongPathEvery = 6 } = {}) {
  const out = [];
  for (const s of features?.saddles ?? []) {
    out.push({ kind: 'saddle', lat: s.lat, lng: s.lng, detail: s });
  }
  for (const b of features?.benches ?? []) {
    out.push({ kind: 'bench', lat: b.lat, lng: b.lng, detail: b });
  }
  // A draw is a line, not a point, and any part of it can hold a stand. Sample
  // along it rather than proposing only its head — but sample coarsely, or one
  // long draw drowns out every other feature on the property.
  for (const key of ['drainages', 'ridges']) {
    const kind = key === 'drainages' ? 'drainage' : 'ridge';
    for (const line of features?.[key] ?? []) {
      const path = line.path ?? [];
      for (let i = 0; i < path.length; i += alongPathEvery) {
        out.push({ kind, lat: path[i][1], lng: path[i][0], detail: line });
      }
    }
  }
  return out;
}

const compassIndex = p => COMPASS.indexOf(p);

/**
 * Propose stands.
 *
 * `gaps` are the winds that blow here and that no existing stand covers, in
 * the shape standCoverage returns: `[{ point, pct }]`. They are what the
 * offsets are chosen to fill, and without them this falls back to ranking on
 * terrain and sign alone — and says so, rather than quietly changing what the
 * numbers mean.
 */
export function suggestStands({
  features = null,
  stands = [],
  markers = [],
  gaps = [],
  climatology = null,
  setbackM = SETBACK_M,
  minFromStandM = MIN_FROM_STAND_M,
  limit = 5,
  halfAngleDeg = CONE_HALF_ANGLE_DEG,
  keepAnchor = null,
} = {}) {
  const notes = [];
  if (!features) {
    return {
      candidates: [],
      note: 'Terrain has not been loaded for this ground yet — open the map and press Terrain.',
      notes,
    };
  }
  if (features.quiet) {
    notes.push('This ground is too gentle for saddles or benches to mean anything, '
      + `so the suggestions come from draws and ridgelines only (median slope ${features.medianSlopeDeg}°).`);
  }
  if (!gaps.length) {
    notes.push(climatology
      ? 'Your stands already cover every wind that blows here often, so these are '
        + 'ranked on the ground and the sign rather than on filling a gap.'
      : 'No wind history loaded, so nothing here is ranked on which winds you are '
        + 'missing — press "Which stands earn their keep" first for that.');
  }

  // Landforms worth pairing with a wind. `keepAnchor` narrows them to ground
  // the caller already knows is yours — and it is a real fix rather than a
  // tidy-up: a terrain radius is a circle, a property is not, and on a twenty
  // the circle is four-fifths somebody else's. Spending the shortlist's places
  // on ground that the ownership filter is certain to throw away is how a
  // request for five suggestions came back with one.
  let anchors = anchorPoints(features);
  const anchorsFound = anchors.length;
  if (typeof keepAnchor === 'function') {
    const near = anchors.filter(a => keepAnchor(a.lat, a.lng));
    // Only if it leaves something. An anchor filter that empties the list has
    // told you nothing except that the landforms are off the parcel, and the
    // unnarrowed answer with its exclusions counted is more use than silence.
    if (near.length) anchors = near;
  }
  if (!anchors.length) {
    return {
      candidates: [],
      note: anchorsFound
        ? 'No landforms were found on your own ground in the loaded terrain.'
        : 'No landforms were found in the loaded terrain. Pan to different ground and load it again.',
      notes,
    };
  }

  // The winds to aim at. Gaps first, and if there are none, the winds that
  // blow most — a stand is worth more on a common wind either way.
  const targets = gaps.length
    ? gaps.map(g => ({ point: g.point, pct: g.pct, isGap: true }))
    : (climatology?.ranked ?? []).slice(0, 4).map(r => ({ ...r, isGap: false }));
  const aims = targets.length ? targets : COMPASS.slice(0, 16).map(p => ({ point: p, pct: 0, isGap: false }));

  const out = [];
  for (const anchor of anchors) {
    for (const aim of aims) {
      const windDeg = compassIndex(aim.point) * 22.5;
      // Sit downwind of the deer: on a wind FROM `aim`, that is on the far side
      // of the feature, at bearing wind+180 from it.
      const at = offsetPoint(anchor.lat, anchor.lng, (windDeg + 180) % 360, setbackM);

      const nearest = stands.reduce((best, s) => {
        const d = distanceM(at.lat, at.lng, s.lat, s.lng);
        return (!best || d < best.metres) ? { stand: s, metres: Math.round(d) } : best;
      }, null);
      if (nearest && nearest.metres < minFromStandM) continue;   // you already hunt this

      const winds = huntableWinds(at, anchor, { halfAngleDeg });
      if (!winds.includes(aim.point)) continue;                  // the offset failed its own test

      // What this would actually add to the season, in the units the coverage
      // analysis already speaks: percent of huntable hours.
      const covered = gaps.filter(g => winds.includes(g.point));
      const gapPct = Math.round(10 * covered.reduce((a, g) => a + g.pct, 0)) / 10;

      const sign = markers.filter(m =>
        Number.isFinite(m.lat) && Number.isFinite(m.lng)
        && distanceM(at.lat, at.lng, m.lat, m.lng) <= SIGN_RADIUS_M);

      const reasons = [];
      let score = 0;
      const add = (n, why) => { score += n; reasons.push({ points: Math.round(n), why }); };

      add(FEATURE_WEIGHT[anchor.kind] ?? 8, FEATURE_WHY[anchor.kind] ?? 'a landform deer use');

      if (covered.length) {
        // The headline. A stand that opens up a wind you cannot currently hunt
        // is worth more than a marginally better tree on a wind you already own.
        add(Math.min(40, gapPct * 2.5),
          `covers ${covered.map(g => g.point).join(', ')} — ${gapPct}% of the season's `
          + `huntable hours that no stand of yours can be sat on`);
      } else if (aim.pct) {
        add(Math.min(12, aim.pct / 2),
          `huntable on ${aim.point}, which is ${aim.pct}% of the season's hours here`);
      }

      if (sign.length) {
        // Sign you found yourself outranks anything derived from a contour map.
        const fresh = sign.filter(m => m.daysOld !== null && m.daysOld <= 45);
        add(Math.min(20, 6 * sign.length + 4 * fresh.length),
          `${sign.length} piece${sign.length === 1 ? '' : 's'} of sign within `
          + `${SIGN_RADIUS_M} m (${sign.map(m => m.label ?? m.kind).join(', ')})`
          + (fresh.length ? `, ${fresh.length} of it fresh` : ''));
      }

      // A new stand that blows out an old one on its own good winds is a net
      // loss, however good the ground is.
      const spoils = stands.filter(s => {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return false;
        if (distanceM(at.lat, at.lng, s.lat, s.lng) > 250) return false;
        const toStand = bearing(at.lat, at.lng, s.lat, s.lng);
        return winds.some(w => {
          const deg = compassIndex(w) * 22.5;
          return angleBetween((deg + 180) % 360, toStand) <= halfAngleDeg;
        });
      });
      if (spoils.length) {
        add(-14, `on some of those winds your scent would drift over `
          + spoils.map(s => s.name).join(', '));
      }

      if (nearest) {
        reasons.push({ points: 0, why: `${nearest.metres} m from ${nearest.stand.name}` });
      }

      out.push({
        lat: Math.round(at.lat * 1e6) / 1e6,
        lng: Math.round(at.lng * 1e6) / 1e6,
        score: Math.round(score),
        feature: { kind: anchor.kind, lat: anchor.lat, lng: anchor.lng },
        setbackM,
        // The bearing you would be looking, which is the thing you check first
        // when you get there.
        facing: COMPASS[Math.round(bearing(at.lat, at.lng, anchor.lat, anchor.lng) / 22.5) % 16],
        aimedAt: aim.point,
        winds,
        coversGaps: covered.map(g => g.point),
        gapPct,
        signNearby: sign.length,
        reasons,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);

  // One suggestion per piece of ground. Without this the top ten are the same
  // saddle offset by fifteen degrees ten times.
  const kept = [];
  for (const c of out) {
    if (kept.some(k => distanceM(c.lat, c.lng, k.lat, k.lng) < minFromStandM)) continue;
    kept.push(c);
    if (kept.length >= limit) break;
  }

  return {
    candidates: kept,
    notes,
    // Said on every result, not just when it is convenient.
    caveat: 'These are places to go and WALK. This knows the shape of the ground and '
      + 'your wind history; it does not know property lines, standing crops, whether '
      + 'there is a tree there, or whether you can get a ladder to it.',
    note: kept.length ? null
      : 'Nothing worth suggesting — every good offset here is already within '
        + `${minFromStandM} m of a stand you have.`,
  };
}


/**
 * Filter and annotate suggestions against the ground you actually hunt.
 *
 * This is the difference between a shortlist of five and a shortlist you would
 * genuinely walk: a spot on the neighbour's side of the line is not a stand
 * site, however good the saddle, and a spot you cannot reach without crossing
 * their ground costs you a conversation before it costs you anything else.
 *
 * "Your ground" is a set of PARCELS, not a name. The first version took the
 * commonest owner name under your stands and kept anything whose owner string
 * matched — which broke the first time it met a real account: two properties
 * forty kilometres apart, one deeded to a person and the other to that same
 * person's revocable trust. Two owner strings, one vote each, and a tie-break
 * decided which property the tool believed in. Half the time it judged one
 * property against the other one's owner name.
 *
 * So the anchors' parcels are collected whole — id, owner AND boundary — and a
 * candidate is on your ground when it falls inside one of those boundaries.
 * That answer needs no lookup at all and no name comparison, which is the
 * point: a parcel is a shape on record, and a shape either contains a point or
 * does not. A candidate outside every known boundary is still looked up, in
 * case you own the parcel next door too, and matched by parcel id first and
 * owner name only as a fallback.
 *
 * The two ways of not being on your ground are now told apart, because they
 * are different facts and only one of them is a service problem:
 *
 *   - the lookup FAILED — kept, and flagged. Dropping on a hiccup would
 *     silently hide good ground every time the service coughs.
 *   - the lookup SUCCEEDED and there is no parcel — dropped. The parcel layer
 *     covers the whole state; the gaps in it are highway right-of-way, rail
 *     corridor and open water. "No parcel here" is a real answer and not a
 *     fault — parcels.mjs says exactly that about its own return value — and
 *     treating it as unknown is what put three suggestions on a state highway.
 *
 * `lookup` is parcelAt or a stand-in: on-demand, cached in memory by the
 * parcel module, never written anywhere. This adds a handful of lookups per
 * suggestion run, all on ground you are already asking the tool about.
 */

/**
 * Two parcels are the same parcel when the county's own id matches. Owner name
 * is the fallback for a layer, or a stub, that carries no ids — good enough to
 * group parcels, never good enough to decide ownership on its own.
 */
const parcelKey = p => (p?.parcelId ? `id:${p.parcelId}` : (p?.owner ? `owner:${p.owner}` : null));

/**
 * Which parcels are yours, worked out once.
 *
 * Separated from the filtering because the answer is needed BEFORE the
 * suggestions exist: knowing the boundary is what lets the generator spend its
 * shortlist on ground you can actually hunt instead of proposing twenty spots
 * for the ownership filter to throw nineteen of away. One pass of lookups,
 * used twice.
 */
export async function resolveHomeGround({ lookup, stands = [], at = null } = {}) {
  const empty = { home: [], homeKeys: new Set(), ownerVotes: new Map(), homeOwner: null, sawFailure: false, anchors: [] };
  if (typeof lookup !== 'function') return empty;

  const tryLookup = async (lat, lng) => {
    try { return { ok: true, parcel: await lookup(lat, lng) }; }
    catch { return { ok: false, parcel: null }; }
  };

  const home = [];
  const homeKeys = new Set();
  const ownerVotes = new Map();
  let sawFailure = false;
  const anchors = stands.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!anchors.length && at) anchors.push(at);
  for (const a of anchors.slice(0, 8)) {
    const r = await tryLookup(a.lat, a.lng);
    if (!r.ok) { sawFailure = true; continue; }
    if (!r.parcel) continue;
    if (r.parcel.owner) ownerVotes.set(r.parcel.owner, (ownerVotes.get(r.parcel.owner) ?? 0) + 1);
    const k = parcelKey(r.parcel);
    if (!k || homeKeys.has(k)) continue;
    homeKeys.add(k);
    home.push(r.parcel);
  }
  const homeOwner = [...ownerVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { home, homeKeys, ownerVotes, homeOwner, sawFailure, anchors };
}

/** A test for "inside a boundary you own" — the answer that costs no request. */
export function insideGround(ground, lat, lng) {
  return !!ground?.home?.some(p => pointInRings(p.rings, lng, lat));
}

export async function onYourGround(result, {
  lookup, stands = [], at = null, limit = 5, accessSamples = [0.25, 0.5, 0.75],
  ground = null,
} = {}) {
  if (!result?.candidates?.length || typeof lookup !== 'function') return result;

  const tryLookup = async (lat, lng) => {
    try { return { ok: true, parcel: await lookup(lat, lng) }; }
    catch { return { ok: false, parcel: null }; }
  };

  // Whose ground is "yours": every parcel under a pin of yours, kept whole.
  // Handed in when the caller already worked it out to narrow the generator.
  const resolved = ground ?? await resolveHomeGround({ lookup, stands, at });
  const { home, homeKeys, ownerVotes, homeOwner, sawFailure, anchors } = resolved;

  const notes = [...(result.notes ?? [])];
  if (!home.length) {
    notes.push(sawFailure
      ? 'The parcel service did not answer, so nothing here is confirmed to be on '
        + 'your ground — check the boundary before walking any of it.'
      : 'No parcel was found under your stands (outside Wisconsin, or no stands '
        + 'yet), so ownership was not checked.');
    return { ...result, notes, homeOwner: null, homeParcels: [] };
  }

  /** Inside a boundary you already own — the answer that costs nothing. */
  const insideHome = c => home.some(p => pointInRings(p.rings, c.lng, c.lat));

  /** Is this looked-up parcel one of yours? Id first, owner name as fallback. */
  const isHomeParcel = p => {
    const k = parcelKey(p);
    if (k && homeKeys.has(k)) return true;
    return !!(p?.owner && ownerVotes.has(p.owner));
  };

  const kept = [];
  let droppedOffGround = 0;
  let droppedNoParcel = 0;
  for (const c of result.candidates) {
    if (kept.length >= limit) break;

    let standing;                                     // true | false | null
    if (insideHome(c)) {
      standing = true;
    } else {
      const r = await tryLookup(c.lat, c.lng);
      if (!r.ok) {
        standing = null;
      } else if (!r.parcel) {
        // The layer answered and there is nothing here: right-of-way or water.
        droppedNoParcel++;
        continue;
      } else {
        standing = isHomeParcel(r.parcel);
      }
    }

    if (standing === false) { droppedOffGround++; continue; }

    if (standing === null) {
      kept.push({
        ...c, onYourGround: null,
        reasons: [...c.reasons, {
          points: 0,
          why: 'could not confirm whose ground this is — check the line before '
            + 'carrying a ladder in',
        }],
      });
      continue;
    }

    // The walk. A straight line from your nearest stand, sampled at a few
    // points: if any of them is somebody else's, getting there without a
    // detour means crossing the line. A penalty and a named reason rather than
    // an exclusion, because a longer legal walk usually exists. A sample that
    // lands on no parcel at all is a road, and crossing a road is not the
    // problem this is looking for.
    const near = anchors.reduce((best, s) => {
      const d = distanceM(c.lat, c.lng, s.lat, s.lng);
      return !best || d < best.d ? { s, d } : best;
    }, null);
    let crossing = null;
    if (near && near.d > 30) {
      for (const t of accessSamples) {
        const lat = near.s.lat + (c.lat - near.s.lat) * t;
        const lng = near.s.lng + (c.lng - near.s.lng) * t;
        if (insideHome({ lat, lng })) continue;
        const rr = await tryLookup(lat, lng);
        if (!rr.ok || !rr.parcel) continue;
        if (!isHomeParcel(rr.parcel)) {
          crossing = rr.parcel.owner ?? 'somebody else';
          break;
        }
      }
    }
    if (crossing) {
      kept.push({
        ...c, onYourGround: true, score: c.score - 12,
        reasons: [...c.reasons, {
          points: -12,
          why: `the straight walk in from ${near.s.name ?? 'your nearest stand'} crosses `
            + `ground owned by ${crossing} — plan the approach before counting on this one`,
        }],
      });
    } else {
      kept.push({ ...c, onYourGround: true });
    }
  }
  kept.sort((a, b) => b.score - a.score);

  if (droppedOffGround) {
    notes.push(`${droppedOffGround} spot${droppedOffGround === 1 ? '' : 's'} landed on `
      + 'a parcel with a different owner and ' + (droppedOffGround === 1 ? 'was' : 'were')
      + ' dropped.');
  }
  if (droppedNoParcel) {
    notes.push(`${droppedNoParcel} spot${droppedNoParcel === 1 ? '' : 's'} landed where the `
      + 'parcel layer has no parcel at all — a road right-of-way, a rail corridor or open '
      + `water — and ${droppedNoParcel === 1 ? 'was' : 'were'} dropped.`);
  }
  notes.push('Your ground was taken to be the parcels under your own pins'
    + (homeOwner ? ` (${homeOwner})` : '')
    + '. If some of those are permission ground, read these with that in mind.');

  return {
    ...result,
    candidates: kept,
    notes,
    homeOwner,
    homeParcels: home.map(p => ({ parcelId: p.parcelId ?? null, owner: p.owner ?? null })),
  };
}
