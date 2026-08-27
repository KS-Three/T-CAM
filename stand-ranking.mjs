/**
 * stand-ranking.mjs — which stand, for a given sit.
 *
 * The planner answers WHEN: it ranks the next fortnight of morning and evening
 * windows by rut, fronts, pressure, wind, rain and moon. This answers WHERE
 * within one of those windows, which is the question you actually act on while
 * putting your boots by the door.
 *
 * The ordering of what matters here is not a guess. Wind is first and by a
 * distance: a stand a deer can smell you from is not a stand, however good the
 * conditions or however many pictures the camera nearby has taken. Everything
 * else adjusts around that.
 *
 * On thermals, and why they are treated so carefully:
 *
 * Spartan Forge sells thermal modelling, and in hill country it is worth
 * having — cooling air drains downhill in the evening and morning sun pushes it
 * back up, and that local flow can completely override a light forecast wind.
 * But it is driven by SLOPE, and Kent's ground has a median slope of half a
 * degree. On that, thermals are not weak; they are absent. So this computes
 * them properly for ground that has relief, and says plainly that they do not
 * apply to ground that does not, rather than emitting a confident arrow that
 * means nothing. A tool that invents a thermal on a flat field is worse than
 * one that stays quiet, because you might believe it.
 */

import { COMPASS, standHuntableOn, distanceM } from './db.mjs';

/**
 * Thermal strength by slope. The bands are coarse deliberately — the honest
 * resolution of "how strong is the thermal here" from a DEM alone is about
 * this, and finer numbers would imply a precision that is not there.
 */
export const THERMAL_BANDS = [
  { minSlopeDeg: 12, strength: 'strong', weight: 1 },
  { minSlopeDeg: 5, strength: 'moderate', weight: 0.6 },
  { minSlopeDeg: 2, strength: 'weak', weight: 0.25 },
  { minSlopeDeg: 0, strength: 'none', weight: 0 },
];

export const thermalStrength = slopeDeg =>
  THERMAL_BANDS.find(b => slopeDeg >= b.minSlopeDeg) ?? THERMAL_BANDS.at(-1);

/**
 * Which way a thermal blows, expressed the way wind always is here: the
 * direction it comes FROM.
 *
 * Morning air is cold and sinks, so it drains downhill — and therefore arrives
 * from the high ground, which is the direction opposite the way the slope
 * faces. Evening sun warms the ground and the air climbs, arriving from below.
 * Getting this backwards would put you downwind of everything you are hunting,
 * which is why the aspect convention is stated so loudly in terrain.mjs.
 */
export function thermalAt({ slopeDeg, aspectDeg }, window) {
  if (!Number.isFinite(slopeDeg) || aspectDeg === null || !Number.isFinite(aspectDeg)) {
    return { strength: 'none', weight: 0, fromDeg: null, note: 'flat ground — no thermal' };
  }
  const band = thermalStrength(slopeDeg);
  if (band.strength === 'none') {
    return {
      strength: 'none', weight: 0, fromDeg: null,
      note: `${slopeDeg.toFixed(1)}° slope — too flat for a thermal`,
    };
  }
  // aspectDeg is the way the ground FACES, i.e. downhill.
  const fromDeg = window === 'AM' ? (aspectDeg + 180) % 360 : aspectDeg;
  return {
    strength: band.strength,
    weight: band.weight,
    fromDeg,
    note: window === 'AM'
      ? `morning air sinks downhill — a ${band.strength} thermal from ${COMPASS[Math.round(fromDeg / 22.5) % 16]}`
      : `evening air rises uphill — a ${band.strength} thermal from ${COMPASS[Math.round(fromDeg / 22.5) % 16]}`,
  };
}

const compassOf = deg =>
  Number.isFinite(deg) ? COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : null;

/**
 * Rank stands for one sit.
 *
 * Every contribution carries its reason, the same way the planner's scoring
 * does, so a ranking can be argued with instead of taken on faith. And an
 * unknown is never scored as a positive: a stand with no recorded winds gets
 * zero and a note asking for them, never the benefit of the doubt.
 */
export function rankStands({ stands = [], sit, terrainAt = () => null }) {
  const windDir = Number.isFinite(sit?.windDir) ? sit.windDir : null;
  const windFrom = compassOf(windDir);

  const ranked = stands.map(stand => {
    const parts = [];
    let total = 0;
    const add = (n, why) => { total += n; parts.push({ points: n, why }); };

    // 1. Wind. The one that decides it.
    const huntable = standHuntableOn(
      { good_winds: (stand.winds ?? []).join(',') || stand.good_winds || null }, windDir);
    if (windDir === null) {
      parts.push({ points: 0, why: 'no wind forecast for this window' });
    } else if (huntable === null) {
      parts.push({
        points: 0,
        why: 'good winds not recorded for this stand — set them and it can be ranked',
      });
    } else if (huntable) {
      add(30, `wind is ${windFrom}, which this stand is set up for`);
    } else {
      add(-40, `wind is ${windFrom} — this stand is not huntable on it`);
    }

    // 2. Thermal, where the ground has enough slope to make one.
    const ground = terrainAt(stand);
    let thermal = null;
    if (ground) {
      thermal = thermalAt(ground, sit?.window);
      if (thermal.weight > 0) {
        const thermalPoint = compassOf(thermal.fromDeg);
        const winds = stand.winds ?? [];
        if (!winds.length) {
          parts.push({ points: 0, why: thermal.note });
        } else if (winds.includes(thermalPoint)) {
          add(Math.round(10 * thermal.weight), `${thermal.note}, which this stand also suits`);
        } else {
          // The case worth catching: the forecast wind is fine and the thermal
          // quietly undoes it. This is exactly what the paid apps model, and on
          // real slope it is the difference between seeing deer and not.
          add(Math.round(-18 * thermal.weight),
            `${thermal.note} — that is NOT a wind this stand is set up for, and near dawn or dusk the thermal usually wins`);
        }
      } else {
        parts.push({ points: 0, why: thermal.note });
      }
    }

    // 3. What the cameras nearby have actually seen.
    //
    // Deliberately small, and currently always zero: no photos have been
    // synced, so there are no detections to count. It stays wired up and
    // visible rather than hidden, so the day photos land this starts working
    // and it is obvious where the number comes from.
    const cams = stand.nearbyCameras ?? [];
    const detections = cams.reduce((n, c) => n + (c.recentDetections ?? 0), 0);
    if (detections > 0) {
      add(Math.min(15, detections), `${detections} recent detections on cameras covering this stand`);
    } else if (cams.length) {
      parts.push({
        points: 0,
        why: `covered by ${cams.map(c => c.name).join(', ')}, but no photos have been synced yet`,
      });
    } else {
      parts.push({ points: 0, why: 'no camera covers this stand' });
    }

    return {
      id: stand.id,
      name: stand.name,
      type: stand.type,
      lat: stand.lat,
      lng: stand.lng,
      total,
      huntable,
      windFrom,
      thermal,
      slopeDeg: ground ? Math.round(ground.slopeDeg * 10) / 10 : null,
      reasons: parts,
    };
  });

  ranked.sort((a, b) => b.total - a.total);
  return ranked;
}

/**
 * A plain-language verdict for the whole set, so the page can say something
 * true when there is nothing to recommend. Silence here reads as a broken
 * feature; "you have not told me which winds these stands work on" reads as
 * an instruction, which is what it is.
 */
export function summarise(ranked, { hasTerrain = false } = {}) {
  if (!ranked.length) return 'No stands yet — drop a pin on the map to add one.';
  const unknown = ranked.filter(s => s.huntable === null);
  if (unknown.length === ranked.length) {
    return 'None of your stands have their good winds recorded, so none can be '
      + 'ranked on wind. Open a stand and tick the winds it is huntable on.';
  }
  const good = ranked.filter(s => s.huntable === true);
  if (!good.length) {
    return `No stand is set up for a ${ranked[0].windFrom} wind. `
      + 'Sitting one anyway puts your scent where the deer are.';
  }
  const best = good[0];
  const thermalWarning = good.find(s => s.thermal?.weight > 0
    && s.reasons.some(r => r.points < 0 && /thermal/.test(r.why)));
  return `${best.name} suits a ${best.windFrom} wind`
    + (unknown.length ? `. ${unknown.length} stand${unknown.length > 1 ? 's have' : ' has'} no winds recorded` : '')
    + (thermalWarning ? `. Watch ${thermalWarning.name}: the thermal there works against you` : '')
    + (hasTerrain ? '' : '. Load Terrain to include thermals');
}
