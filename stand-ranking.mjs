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

import { COMPASS, distanceM } from './db.mjs';
import { windsForStand } from './coverage.mjs';
import { pressureAt, foodAt } from './stand-context.mjs';

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
export function rankStands({ stands = [], sit, terrainAt = () => null,
  evidence = null, sits = [], fields = [], now = Date.now() } = {}) {
  const windDir = Number.isFinite(sit?.windDir) ? sit.windDir : null;
  const windFrom = compassOf(windDir);

  const ranked = stands.map(stand => {
    const parts = [];
    let total = 0;
    // Every reason carries what it rests on, the same way the sit scoring does.
    // 'Y' is your own ground — traced lanes, your photographs, your logged
    // sits — which for a WHERE question is better evidence than any study.
    const add = (n, why, tier = 'B') => { total += n; parts.push({ points: n, why, tier }); };

    // 1. Wind. The one that decides it.
    //
    // Lanes first where they are marked, because they are derived from
    // geometry you measured rather than boxes you ticked from memory — and
    // the reason says which, so a ranking can be argued with.
    const cover = windsForStand(stand);
    const huntable = cover.source === 'none' || windFrom === null
      ? null : cover.winds.includes(windFrom);
    const by = cover.source === 'lanes' ? 'its shooting lanes' : 'the winds you recorded';
    if (windDir === null) {
      parts.push({ points: 0, why: 'no wind forecast for this window' });
    } else if (huntable === null) {
      parts.push({
        points: 0,
        why: 'no shooting lanes or good winds recorded for this stand — mark the '
          + 'lanes on the map and it can be ranked',
      });
    } else if (huntable) {
      add(30, `wind is ${windFrom}, which ${by} allow`, cover.source === 'lanes' ? 'Y' : 'C');
    } else {
      const blocked = cover.derived?.blocked?.find(b => b.point === windFrom);
      add(-40, blocked
        ? `wind is ${windFrom} — that blows your scent down the `
          + (blocked.lane.label ? blocked.lane.label + ' lane' : `${blocked.lane.point} lane`)
        : `wind is ${windFrom} — this stand is not huntable on it`,
        cover.source === 'lanes' ? 'Y' : 'C');
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
          add(Math.round(10 * thermal.weight), `${thermal.note}, which this stand also suits`, 'B');
        } else {
          // The case worth catching: the forecast wind is fine and the thermal
          // quietly undoes it. This is exactly what the paid apps model, and on
          // real slope it is the difference between seeing deer and not.
          add(Math.round(-18 * thermal.weight),
            `${thermal.note} — that is NOT a wind this stand is set up for, and near dawn or dusk the thermal usually wins`, 'B');
        }
      } else {
        parts.push({ points: 0, why: thermal.note });
      }
    }

    // 3. What the cameras covering this stand have actually seen, under
    //    conditions like tonight's.
    //
    // This is the WHERE half of design.md section 9, and the reason it is sound
    // in the first season is that it compares CAMERAS TO EACH OTHER during the
    // same weather. Every camera on the property gets the same north-west wind
    // in the same hour of the same rut phase, so date, rut and moon are held
    // constant for free — the confounding that makes fitting the PLANNER to one
    // season hopeless does not touch a camera-versus-camera comparison.
    //
    // The rate is per hundred camera-hours, never a raw count, because a raw
    // count is a fact about how long a camera was out.
    const cams = stand.nearbyCameras ?? [];
    const rows = evidence?.rows ?? [];
    const mine = rows.filter(r => cams.some(c => c.id === r.cameraId));
    // The NEAREST camera with enough data, not the best of them. Two cameras
    // 300 m apart are both "covering" both stands, and taking the best would
    // credit a stand with the productivity of a camera on the far side of the
    // property — which is how a mediocre stand inherits a good one's numbers.
    const distanceOf = id => {
      const c = cams.find(x => x.id === id);
      return Number.isFinite(c?.metres) ? c.metres : Infinity;
    };
    const ranked3 = mine.filter(r => r.enough && r.per100 !== null)
      .sort((a, b) => distanceOf(a.cameraId) - distanceOf(b.cameraId));
    if (ranked3.length) {
      const best = ranked3[0];
      // Scaled against the best camera on the property rather than against an
      // absolute rate, because "3.1 deer per 100 hours" means nothing without
      // knowing what this ground produces. Capped at 18 so a productive camera
      // can outweigh a thermal but never a wrong wind.
      const top = rows.filter(r => r.enough && r.per100 !== null)
        .reduce((a, b) => (b.per100 > a.per100 ? b : a), { per100: 0 });
      const share = top.per100 > 0 ? best.per100 / top.per100 : 0;
      const pts = Math.round(18 * (share - 0.5) * 2) / 1;
      add(Math.max(-8, Math.min(18, pts)),
        `${best.name}: ${best.detections} deer in ${best.hours} camera-hours `
        + `(${best.per100.toFixed(1)} per 100) on "${evidence.condition}"`
        + (best.nocturnalShare !== null && best.nocturnalShare >= 80
          ? ` — but ${best.nocturnalShare}% of everything it sees is after dark`
          : ''), 'Y');
    } else if (mine.length) {
      parts.push({
        points: 0,
        why: `${mine.map(r => r.name).join(', ')} cover this stand, but no condition has `
          + `${evidence?.minHours ?? 10} matched camera-hours yet — not ranked on your own photos`,
      });
    } else if (cams.length) {
      parts.push({
        points: 0,
        why: `covered by ${cams.map(c => c.name).join(', ')}, but no photos have been synced yet`,
      });
    } else {
      parts.push({ points: 0, why: 'no camera covers this stand' });
    }

    // 4. How hard you have hunted it lately. The largest human effect measured
    //    in docs/deer-evidence.md, and it was not modelled at all.
    const press = pressureAt(stand, sits, { now });
    if (press.points) add(press.points, press.why, press.known ? 'B' : 'C');
    else parts.push({ points: 0, why: press.why });

    // 5. What the food within reach is doing today.
    const food = foodAt(stand, fields, { date: sitDate(sit, now) });
    if (food.points) add(food.points, food.why, 'C');
    else parts.push({ points: 0, why: food.why });

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
      pressure: press,
      food,
      cameras: mine,
      windSource: cover.source,
      slopeDeg: ground ? Math.round(ground.slopeDeg * 10) / 10 : null,
      reasons: parts,
    };
  });

  ranked.sort((a, b) => b.total - a.total);
  for (const r of ranked) r.confidence = standConfidence(r, ranked, evidence);
  return ranked;
}

/** The sit's own day, so food ages against the right date rather than today. */
function sitDate(sit, now) {
  const d = sit?.date ? Date.parse(`${sit.date}T12:00:00Z`) : NaN;
  return new Date(Number.isFinite(d) ? d : now);
}

/**
 * How much to believe a stand's placing — which is NOT how high it scored.
 *
 * This is the distinction the program has been missing everywhere. A stand can
 * top the list on a perfect wind and nothing else, and the honest report of
 * that is "right wind, and I know nothing else about it", not a number that
 * looks like the output of a model.
 *
 * So confidence is assembled from what is KNOWN, never from what was scored:
 * whether the winds came from measured lane geometry or ticked boxes, whether
 * any of your own photographs fed into it, whether your sits are logged, and
 * whether the stand below it is close enough that the order is arbitrary.
 */
export function standConfidence(row, ranked = [], evidence = null) {
  const factors = [];
  let score = 0;

  if (row.huntable === null) {
    return {
      tier: 'none',
      score: 0,
      why: 'this stand has neither shooting lanes nor recorded winds, so it is not '
        + 'ranked on the thing that matters most',
      factors: [],
    };
  }
  if (row.windSource === 'lanes') {
    score += 2;
    factors.push('winds derived from the lanes you traced, not boxes ticked from memory');
  } else {
    score += 1;
    factors.push('winds from the boxes you ticked — trace the shooting lanes and this gets firmer');
  }

  const seen = (row.cameras ?? []).filter(c => c.enough);
  if (seen.length) {
    const hours = seen.reduce((s, c) => s + c.hours, 0);
    score += hours >= 200 ? 2 : 1;
    factors.push(`${hours} camera-hours of your own on "${evidence?.condition}"`);
  } else {
    factors.push('none of your own photographs have enough matched hours to count yet');
  }

  if (row.pressure?.known) {
    score += 1;
    factors.push('your sits at this stand are logged, so pressure is real rather than assumed');
  } else {
    factors.push('no sits logged here, so how burned it is is unknown — not zero');
  }

  // The margin. A one-point lead is not a recommendation, however well founded
  // each stand's own number is.
  const idx = ranked.indexOf(row);
  const next = ranked[idx + 1];
  if (next && Number.isFinite(next.total)) {
    const gap = row.total - next.total;
    if (idx === 0) {
      if (gap >= 15) { score += 1; factors.push(`clear of the next stand by ${Math.round(gap)} points`); }
      else if (gap <= 3) { score -= 1; factors.push(`only ${Math.round(gap)} points clear of ${next.name} — treat these two as level`); }
    }
  }

  const tier = score >= 5 ? 'high' : score >= 3 ? 'moderate' : score >= 1 ? 'low' : 'none';
  return {
    tier,
    score,
    why: factors[0],
    factors,
  };
}

/**
 * A plain-language verdict for the whole set, so the page can say something
 * true when there is nothing to recommend. Silence here reads as a broken
 * feature; "you have not told me which winds these stands work on" reads as
 * an instruction, which is what it is.
 */
export function summarise(ranked, { hasTerrain = false, evidence = null } = {}) {
  if (!ranked.length) return 'No stands yet — drop a pin on the map to add one.';
  const unknown = ranked.filter(s => s.huntable === null);
  if (unknown.length === ranked.length) {
    return 'None of your stands have their good winds recorded, so none can be '
      + 'ranked on wind. Open a stand and trace its shooting lanes on the map.';
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
    + (hasTerrain ? '' : '. Load Terrain to include thermals')
    // Confidence belongs in the same breath as the recommendation. Given
    // separately it reads as a disclaimer nobody has to look at; given here it
    // is part of the answer.
    + (best.confidence ? `. Confidence ${best.confidence.tier} — ${best.confidence.why}` : '');
}

/**
 * The whole verdict for one sit, in the order a person asks the questions:
 * where, why, and how much to believe it.
 *
 * Assembled here rather than in the page so /tonight and the map panel cannot
 * drift into telling different stories, which is the failure that would destroy
 * trust in both of them.
 */
export function verdict(ranked, { sit, evidence = null, hasTerrain = false } = {}) {
  const good = ranked.filter(s => s.huntable === true);
  const pick = good[0] ?? ranked[0] ?? null;
  if (!pick) return null;
  // Reasons worth printing: the ones that moved the number, biggest first, plus
  // any zero-point reason that is an INSTRUCTION rather than an observation.
  const why = pick.reasons
    .filter(r => r.points !== 0)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
    .slice(0, 5);
  const todo = pick.reasons.filter(r => r.points === 0 && /trace|log|draw|mark/i.test(r.why));
  return {
    stand: pick.name,
    standId: pick.id,
    huntable: pick.huntable,
    score: pick.total,
    why,
    todo,
    confidence: pick.confidence ?? null,
    evidence: evidence
      ? { condition: evidence.condition, minHours: evidence.minHours,
          rows: evidence.rows, note: evidence.note, confidence: evidence.confidence ?? null }
      : null,
    summary: summarise(ranked, { hasTerrain, evidence }),
  };
}
