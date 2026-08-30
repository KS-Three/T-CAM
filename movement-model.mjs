/**
 * movement-model.mjs — the WHEN half, with every number traced to a source.
 *
 * This file exists because the planner's weather weights were folk wisdom. They
 * were reasonable-sounding folk wisdom, chosen by judgement and labelled as
 * such, but a literature pass (docs/deer-evidence.md) found that GPS-collar
 * studies contradict four of them outright:
 *
 *   - A cold front scored +14, on a par with a whole rut phase. The Penn State
 *     Deer-Forest Study found no difference in movement before, during or after
 *     a front. Oklahoma collar work found the same for temperature drops.
 *   - Wind above 18 mph scored -9. Deer-Forest measured the LEAST movement in
 *     dead calm and steadily more as wind rose. The sign was backwards.
 *   - A barometer in "the active band" scored +5. That band traces to hunting
 *     magazine logbook compilations, not a study, and the one collar test of it
 *     found nothing.
 *   - Moon scored +/-2. Two separate collar datasets report no lunar pattern
 *     at all.
 *
 * So the shape of this file is deliberate: every factor carries the TIER of
 * evidence behind it, and a tier-D factor — received wisdom with no traceable
 * study — is allowed to be REPORTED but scores zero. That way the number Kent
 * used to see is still on the screen, visibly contributing nothing, rather than
 * vanishing with no explanation and being proposed again next season.
 *
 * The second deliberate shape: factors are split into what they are ABOUT.
 * A 'deer' factor is a claim about deer behaviour and needs a citation. A
 * 'hunter' factor is craft — where your scent goes, whether you can see — and
 * needs no deer study, because it is not making a claim about deer. Wind ends
 * up mostly in the second category, which is the honest place for it: a steady
 * breeze is good for you, not bad for them.
 */

/**
 * Evidence tiers. The whole point of the exercise is that these are visible in
 * the output, so a reason can be weighed rather than believed.
 */
export const TIERS = {
  // Your own ground outranks the literature, and it should: a season of your
  // own photographs at the stand you are asking about is better evidence about
  // THAT stand than any collar study of other deer in another state. It only
  // ever applies to WHERE questions — nothing about your cameras can tell you
  // when the rut peaks.
  Y: { rank: 5, label: 'measured on your own ground' },
  A: { rank: 4, label: 'collar/fetal data at this latitude' },
  B: { rank: 3, label: 'peer-reviewed, but southern or direction-only' },
  C: { rank: 2, label: 'extension summary of collar work' },
  D: { rank: 1, label: 'received wisdom, no traceable study' },
};

/** A tier-D claim never moves the score. It is shown so it can be dismissed. */
export const scoresNothing = tier => tier === 'D';

// ---------------------------------------------------------------------------
// Rut calendar — recalibrated to southwest Wisconsin
//
// The old calendar put the year's best week at 1-7 November and called
// 18-31 October merely "pre-rut". Hunsaker et al. 2025 (Ecology and Evolution)
// collared 188 males in Dane, Iowa and Grant counties -- the same latitude, the
// same crops, the same state -- and ran changepoint analysis three separate
// ways: on movement rates, on range sizes, and on conception dates. All three
// agreed the peak rut starts 23-27 October and ends 9-15 November.
//
// That is the single most relevant study that exists for this ground, and it
// says the last week of October was being scored a full tier too low. Peak
// movement across all ages landed in the week of 5-11 November.
//
// Photoperiod drives breeding, so these dates barely move year to year. They
// would move a long way south of here, and this table would need replacing.
// ---------------------------------------------------------------------------
export const RUT_CALENDAR = [
  { from: '09-01', to: '09-30', score: 10, phase: 'Early season',
    tier: 'C',
    note: 'bachelor groups still together on tight feeding patterns — hunt food, and hunt it before you have taught them you are there' },
  { from: '10-01', to: '10-17', score: 6, phase: 'October transition',
    tier: 'B',
    note: 'the "lull" is a VISIBILITY effect, not a movement one — collar data has movement rising steadily through October while daylight activity in the open falls' },
  { from: '10-18', to: '10-22', score: 18, phase: 'Pre-rut / scraping',
    tier: 'A',
    note: 'scrape activity building and ranges expanding, days from the measured changepoint' },
  { from: '10-23', to: '11-04', score: 26, phase: 'Peak rut — seeking',
    tier: 'A',
    note: 'inside the measured peak (Hunsaker 2025 changepoint: 23 Oct); bucks cruising, and this is the week the old calendar under-rated most' },
  { from: '11-05', to: '11-11', score: 30, phase: 'Peak rut — best week',
    tier: 'A',
    note: 'highest mean movement rate of the year across all ages; ~70% of rut excursions happen in DAYLIGHT against ~30% either side of it — sit all day' },
  { from: '11-12', to: '11-15', score: 24, phase: 'Peak rut — closing',
    tier: 'A',
    note: 'the measured peak ends 9-15 Nov; mature bucks are the most nocturnal they get all season, younger bucks still cruising' },
  { from: '11-16', to: '11-25', score: 16, phase: 'Post-peak seeking',
    tier: 'B',
    note: 'bucks back on their feet hunting the last receptive does' },
  { from: '11-26', to: '12-10', score: 8, phase: 'Post-rut recovery',
    tier: 'C',
    note: 'worn-down bucks return to food — hunt the best feed you have' },
  { from: '12-11', to: '12-20', score: 12, phase: 'Second rut',
    tier: 'B',
    note: 'doe fawns cycle — Midwest fetal aging puts fawn conception near 2 December, which is what "second rut" actually refers to' },
  { from: '12-21', to: '01-31', score: 10, phase: 'Late season',
    tier: 'C',
    note: 'pure food-source hunting; cold drives afternoon feeding' },
  { from: '02-01', to: '08-31', score: 2, phase: 'Off season',
    tier: 'A',
    note: 'outside the season for this model' },
];

export function rutPhase(date) {
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  for (const r of RUT_CALENDAR) {
    // Ranges that wrap the new year (12-21 -> 01-31) need the OR form.
    const wraps = r.from > r.to;
    if (wraps ? (md >= r.from || md <= r.to) : (md >= r.from && md <= r.to)) return r;
  }
  return RUT_CALENDAR.at(-1);
}

// ---------------------------------------------------------------------------
// Moon — kept, computed, displayed, and scoring exactly nothing.
// ---------------------------------------------------------------------------
const SYNODIC = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14);

export function moonPhase(date) {
  const days = (date.getTime() - NEW_MOON_REF) / 86400000;
  const frac = ((days / SYNODIC) % 1 + 1) % 1;
  const illum = (1 - Math.cos(2 * Math.PI * frac)) / 2;
  const names = [
    [0.02, 'new'], [0.24, 'waxing crescent'], [0.27, 'first quarter'],
    [0.48, 'waxing gibbous'], [0.52, 'full'], [0.73, 'waning gibbous'],
    [0.77, 'last quarter'], [0.98, 'waning crescent'], [1.01, 'new'],
  ];
  return { frac, illum, name: names.find(([t]) => frac < t)[1] };
}

// ---------------------------------------------------------------------------
// Seasonal normal temperature, so "cold" can mean "cold FOR THE DATE".
//
// A 40 degree afternoon is unremarkable in late October and a warm spell in
// January, and a model that scores absolute temperature cannot tell those
// apart. These are monthly mean temperatures for west-central Wisconsin,
// interpolated between month midpoints.
//
// Regional, and said to be regional: a property far from here gets an anomaly
// computed against the wrong normal, which is why the anomaly is reported in
// the reason text rather than silently folded into a number.
// ---------------------------------------------------------------------------
export const MONTHLY_NORMAL_F =
  [15, 20, 32, 45, 57, 66, 70, 68, 59, 47, 33, 20];

export function seasonalNormalF(date) {
  // Month midpoints, interpolated by day. Day 15 of each month is that month's
  // normal exactly; days either side blend toward the neighbouring month.
  const m = date.getMonth();
  const d = date.getDate();
  const daysInMonth = new Date(date.getFullYear(), m + 1, 0).getDate();
  const t = (d - 15) / daysInMonth;
  const other = t >= 0 ? (m + 1) % 12 : (m + 11) % 12;
  const w = Math.min(1, Math.abs(t));
  return MONTHLY_NORMAL_F[m] * (1 - w) + MONTHLY_NORMAL_F[other] * w;
}

const mean = a => {
  const xs = a.filter(x => typeof x === 'number' && Number.isFinite(x));
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
};

// hPa -> inches of mercury, the unit every deer-hunting article quotes.
export const inHg = hpa => hpa * 0.02952998751;

/**
 * Every weather factor, as evidence-tagged parts.
 *
 * Returns parts even where they score zero, because a zero carrying a reason is
 * the whole mechanism by which this file argues with the last one.
 */
export function weatherFactors({ hours = [], window = 'PM', tempDropF = 0,
  pressureTrend = 0, normalF = null } = {}) {
  const parts = [];
  const add = (points, reason, { tier, about = 'deer' } = {}) =>
    parts.push({ points: scoresNothing(tier) ? 0 : points, reason, tier, about });

  const temp = mean(hours.map(h => h.temp));
  const wind = mean(hours.map(h => h.wind));
  const cloud = mean(hours.map(h => h.cloud));
  const press = mean(hours.map(h => h.pressure));
  const rain = hours.reduce((s, h) => s + (h.precip ?? 0), 0);

  // ---- Temperature, as an anomaly, and only to shift WHICH window ----
  //
  // Goethlich 2019 (Auburn, South Carolina) found activity probability is
  // BIMODAL in temperature — a cool peak and a warm peak with a trough between
  // — so "colder is better" is the wrong shape entirely. What did come out
  // cleanly is directional and useful: in the post-rut, high temperatures push
  // activity into the morning and night, low temperatures into the day and
  // evening. That moves which window is worth sitting, not whether to go.
  if (temp !== null && normalF !== null) {
    const anomaly = temp - normalF;
    if (window === 'PM' && anomaly <= -8) {
      add(4, `${Math.round(-anomaly)}°F below the seasonal normal — cold pushes activity into the day and evening block`, { tier: 'B' });
    } else if (window === 'AM' && anomaly >= 8) {
      add(3, `${Math.round(anomaly)}°F above the seasonal normal — warm shifts activity toward the morning and night block`, { tier: 'B' });
    } else if (window === 'PM' && anomaly >= 12) {
      add(-3, `${Math.round(anomaly)}°F above the seasonal normal — warm evenings are the weak half of the bimodal curve`, { tier: 'B' });
    } else {
      add(0, `${temp.toFixed(0)}°F, within ${Math.abs(Math.round(anomaly))}°F of normal for the date`, { tier: 'B' });
    }
  }

  // ---- The cold front. Contested, and scored like it. ----
  //
  // This used to be +14, the largest weather number in the program. Penn State
  // found no difference in movement speed or distance before, during or after
  // a front; Oklahoma collar work found temperature drops produced no big
  // movement either. Diefenbach, who ran the study, will not say fronts have no
  // effect and will not say they do.
  //
  // So it keeps a small positive — a front reliably brings the cold anomaly and
  // the falling light that DO have support — and the reason says out loud that
  // the classic claim is not backed.
  if (tempDropF >= 15) {
    add(3, `${Math.round(tempDropF)}°F colder than yesterday — collar studies find no movement change across a front, so this is scored small deliberately`, { tier: 'B' });
  } else if (tempDropF >= 8) {
    add(2, `${Math.round(tempDropF)}°F colder than yesterday — a front, scored small: the evidence for "fronts move deer" is not there`, { tier: 'B' });
  }

  // ---- Wind. The sign was backwards, and it is now a hunter factor. ----
  //
  // Deer-Forest measured the LEAST movement in dead calm and steadily more as
  // wind rose. Webb 2010 found no clear relationship either way. Nothing
  // supports "deer hold in cover above 18 mph", which this program used to
  // score at -9.
  //
  // What survives is entirely about the hunter: a steady breeze gives a
  // predictable scent cone, dead calm lets your scent pool and wander, and a
  // gale makes the cone wide and swirling. None of that is a claim about deer,
  // so it is labelled as craft rather than dressed up as behaviour.
  if (wind !== null) {
    if (wind <= 2) {
      add(-3, `wind ${wind.toFixed(0)} mph — dead calm, so your scent pools and drifts unpredictably. Note this is about YOUR scent: deer move LESS in calm, not more`, { tier: 'B', about: 'hunter' });
    } else if (wind <= 15) {
      add(3, `wind ${wind.toFixed(0)} mph — steady enough to give a predictable scent cone`, { tier: 'C', about: 'hunter' });
    } else if (wind <= 22) {
      add(0, `wind ${wind.toFixed(0)} mph — gusty for you, but deer activity rises with wind rather than falling`, { tier: 'B', about: 'hunter' });
    } else {
      add(-2, `wind ${wind.toFixed(0)} mph — the scent cone is wide and swirling and a treestand is unpleasant; the deer are not the problem`, { tier: 'C', about: 'hunter' });
    }
  }

  // ---- Rain. The two studies disagree about drizzle, so drizzle scores 0. ----
  //
  // Goethlich saw a slight INCREASE in buck movement in drizzle. Deer-Forest
  // saw bucks cut movement by as much as half on rainy days, does unaffected,
  // and — the detail worth keeping — no effect at all from light rain when the
  // wind was strong. Where two collar studies disagree, neutral is the honest
  // score.
  if (rain >= 0.4) {
    add(-8, `${rain.toFixed(2)} in of rain — Deer-Forest measured bucks cutting movement by up to half on rainy days, and blood trails wash out`, { tier: 'B' });
  } else if (rain >= 0.05) {
    add(0, `${rain.toFixed(2)} in light rain — the two collar studies disagree on drizzle, so it is scored neutral`, { tier: 'B' });
  }

  // ---- Cloud. Plausible, unsourced, scored as such. ----
  if (cloud !== null && cloud >= 70) {
    add(0, `${cloud.toFixed(0)}% cloud — low light plausibly extends the window, but no collar study measured it`, { tier: 'D' });
  }

  // ---- Barometer. The band came from logbooks. It scores nothing. ----
  if (press !== null) {
    const p = inHg(press);
    const band = p >= 30.0 && p <= 30.4;
    add(0, `barometer ${p.toFixed(2)} inHg${band ? ' — inside the "active band" hunting media quote' : ''}, `
      + 'which traces to logbook compilations rather than a study and is scored zero here', { tier: 'D' });
  }
  if (Math.abs(pressureTrend) >= 0.12) {
    add(0, `pressure ${pressureTrend > 0 ? 'rising' : 'falling'} ${Math.abs(pressureTrend).toFixed(2)} inHg — reported so you can judge it against your own sits; no collar study supports scoring it`, { tier: 'D' });
  }

  return { parts, temp, wind, cloud, rain, pressure: press };
}

/**
 * The moon, as a part that scores nothing.
 *
 * Split out rather than folded into weatherFactors because it is the clearest
 * single example of what this file is for, and a test points at it directly.
 */
export function moonFactor(moon) {
  return {
    points: 0,
    tier: 'D',
    about: 'deer',
    reason: `${moon.name} moon — Penn State and Mississippi State both report NO lunar `
      + 'pattern in movement; shown so you can see it counting for nothing',
  };
}

/**
 * The hours a sit is worth sitting, which the rut changes more than anything.
 *
 * During the best week, ~70% of rut excursions happen in daylight against ~30%
 * either side of it. That is the evidence behind "sit all day", and it belongs
 * in the output as advice rather than buried in a score.
 */
export function sitAdvice(rut) {
  if (/best week|seeking/.test(rut.phase)) {
    return 'Sit all day if you can. During the peak, about 70% of rut excursions '
      + 'happen in daylight — against about 30% in the weeks either side.';
  }
  if (/closing/.test(rut.phase)) {
    return 'Mature bucks are at their most nocturnal now; younger bucks are still '
      + 'cruising in daylight. Hunt the doe groups.';
  }
  if (/transition/.test(rut.phase)) {
    return 'Movement is NOT down this month — visibility is. Hunt tight to cover '
      + 'rather than the field edge, and save your best stands.';
  }
  if (/Late season|recovery/.test(rut.phase)) {
    return 'Food decides everything now. Hunt the best feed you have, in the afternoon.';
  }
  return null;
}

export const OFF_SEASON_CAP = 5;

/**
 * Additive, transparent, and every part carrying the tier behind it.
 *
 * The ordering of effect sizes is no longer a matter of taste: the rut calendar
 * is tier A and measured on this latitude, and every weather term is tier B or
 * worse. So the rut dominates, by a distance, and that is the finding rather
 * than a preference.
 */
export function scoreSit({ hours = [], rut, moon, tempDropF = 0, pressureTrend = 0,
  window = 'PM', normalF = null } = {}) {
  const parts = [];

  parts.push({ points: rut.score, reason: `${rut.phase} — ${rut.note}`,
    tier: rut.tier ?? 'B', about: 'deer' });

  const wx = weatherFactors({ hours, window, tempDropF, pressureTrend, normalF });
  parts.push(...wx.parts);
  if (moon) parts.push(moonFactor(moon));

  let total = parts.reduce((s, x) => s + x.points, 0);

  // Weather is additive, which alone would let a flawless August morning outrank
  // a windy day in the rut — nonsense, since there is no season then.
  if (rut.phase === 'Off season' && total > OFF_SEASON_CAP) {
    parts.push({ points: OFF_SEASON_CAP - total, tier: 'A', about: 'deer',
      reason: 'outside the hunting season — weather cannot make up for it' });
    total = OFF_SEASON_CAP;
  }

  return {
    total,
    parts,
    advice: sitAdvice(rut),
    wind: wx.wind,
    windDir: hours.length ? hours[Math.floor(hours.length / 2)].windDir : null,
    rain: wx.rain,
    temp: wx.temp,
    pressure: wx.pressure === null ? null : Math.round(inHg(wx.pressure) * 100) / 100,
    moonIllum: moon ? Math.round(moon.illum * 100) / 100 : null,
    // What the score RESTS on, which is not the same as how big it is. A sit
    // carried by the rut calendar is standing on collar data from this state;
    // the same number assembled out of weather terms is standing on much less.
    evidence: evidenceOf(parts),
  };
}

/**
 * How well-founded a score is, as distinct from how high it is.
 *
 * Weighted by the absolute contribution of each part, because a tier-A factor
 * worth 30 points and a tier-A factor worth 1 do not deserve equal say in
 * whether the answer is well-founded.
 */
export function evidenceOf(parts) {
  const scoring = parts.filter(p => p.points !== 0);
  if (!scoring.length) return { tier: null, note: 'nothing scored either way' };
  let weight = 0, sum = 0;
  for (const p of scoring) {
    const w = Math.abs(p.points);
    weight += w;
    sum += w * (TIERS[p.tier]?.rank ?? 2);
  }
  const avg = sum / weight;
  const tier = avg >= 4.5 ? 'Y' : avg >= 3.5 ? 'A' : avg >= 2.5 ? 'B' : avg >= 1.5 ? 'C' : 'D';
  return {
    tier,
    note: TIERS[tier].label,
    // The single largest contributor, which is what a person actually wants to
    // know when they ask "why is this rated that".
    driver: scoring.reduce((a, b) => (Math.abs(b.points) > Math.abs(a.points) ? b : a)).reason,
  };
}

export const RATINGS = [[46, 'PRIME'], [34, 'strong'], [24, 'good'], [14, 'fair'], [-999, 'poor']];
export const rate = n => RATINGS.find(([t]) => n >= t)[1];
