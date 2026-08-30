import test from 'node:test';
import assert from 'node:assert/strict';
import { rutPhase, moonPhase, scoreSit, compass, inHg, rate, RUT_CALENDAR }
  from '../hunt-planner.mjs';

const on = (m, d) => new Date(2026, m - 1, d, 12, 0, 0);

test('rut calendar covers every day of the year exactly once', () => {
  // A gap would throw; an overlap would silently make the earlier entry win and
  // hide the later one, so check the whole year resolves and hits every phase.
  const seen = new Set();
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const date = new Date(2026, m - 1, d, 12);
      if (date.getMonth() !== m - 1) continue; // skip Feb 30 and friends
      const r = rutPhase(date);
      assert.ok(r, `${m}-${d} resolved to nothing`);
      seen.add(r.phase);
    }
  }
  assert.equal(seen.size, new Set(RUT_CALENDAR.map(r => r.phase)).size,
    'every calendar phase is reachable');
});

test('rut phases land on the right dates for this latitude', () => {
  assert.match(rutPhase(on(10, 10)).phase, /October transition/);
  assert.match(rutPhase(on(10, 20)).phase, /Pre-rut/);
  // Moved 2026-08-30. Hunsaker et al. 2025 collared 188 males in southwest
  // Wisconsin and ran changepoint analysis three ways — movement rate, range
  // size, conception date — and all three put the peak rut starting 23-27
  // October. The old calendar called this "pre-rut" and scored it a full tier
  // below the first week of November. See docs/deer-evidence.md section 1.
  assert.match(rutPhase(on(10, 25)).phase, /Peak rut/);
  assert.match(rutPhase(on(11, 5)).phase, /best week/);
  assert.match(rutPhase(on(11, 12)).phase, /Peak rut/i);
  assert.match(rutPhase(on(11, 20)).phase, /Post-peak/);
  assert.match(rutPhase(on(12, 15)).phase, /Second rut/);
  assert.match(rutPhase(on(7, 4)).phase, /Off season/);
});

test('the rut peaks in the measured week, above every other date', () => {
  const nov = rutPhase(on(11, 5)).score;
  for (const [m, d] of [[9, 15], [10, 10], [10, 20], [12, 1], [12, 15], [1, 20], [7, 4]]) {
    assert.ok(nov > rutPhase(on(m, d)).score,
      `Nov 5 (${nov}) should outrank ${m}/${d} (${rutPhase(on(m, d)).score})`);
  }
  // The October transition still scores below the season either side of it —
  // but for a stated reason that changed. It is a VISIBILITY dip, not a
  // movement one: collar data has movement rising steadily through October.
  assert.ok(rutPhase(on(10, 10)).score < rutPhase(on(9, 15)).score);
  assert.ok(rutPhase(on(10, 10)).score < rutPhase(on(10, 25)).score);
  assert.match(rutPhase(on(10, 10)).note, /VISIBILITY effect, not a movement one/);
});

test('the last week of October now scores inside the peak', () => {
  // The single biggest calendar change, and the one most worth pinning: it is
  // the difference between saving your best stand for November and being told
  // to hunt it on the 25th of October, which is what the Wisconsin data says.
  assert.ok(rutPhase(on(10, 25)).score >= 26,
    'inside the measured peak rut (23 Oct - 12 Nov)');
  assert.ok(rutPhase(on(10, 25)).score > rutPhase(on(11, 20)).score,
    'and above the post-peak week that used to outrank it');
  assert.equal(rutPhase(on(10, 25)).tier, 'A', 'on collar data from this latitude');
});

test('moon phase tracks the synodic cycle', () => {
  // Referenced to the new moon of 2000-01-06 18:14 UTC; one synodic month later
  // must be new again, and half a month later full.
  const SYNODIC = 29.530588853;
  const ref = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const plus = d => new Date(ref.getTime() + d * 86400000);

  assert.ok(moonPhase(ref).illum < 0.01, 'reference epoch is a new moon');
  assert.ok(moonPhase(plus(SYNODIC)).illum < 0.01, 'one cycle later is new again');
  assert.ok(moonPhase(plus(SYNODIC * 12)).illum < 0.02, 'twelve cycles later still new');
  assert.ok(moonPhase(plus(SYNODIC / 2)).illum > 0.99, 'half a cycle later is full');
  assert.match(moonPhase(plus(SYNODIC / 2)).name, /full/);
  assert.match(moonPhase(ref).name, /new/);

  // Illumination must stay within bounds across a whole cycle.
  for (let d = 0; d < 30; d += 0.5) {
    const { illum, frac } = moonPhase(plus(d));
    assert.ok(illum >= 0 && illum <= 1, `illum in range at day ${d}`);
    assert.ok(frac >= 0 && frac < 1, `frac in range at day ${d}`);
  }
});

// A plain hour, so each test can vary one factor at a time.
const hour = (o = {}) => ({
  time: '2026-11-05T07:00', temp: 35, pressure: 1016, wind: 8, windDir: 315,
  precip: 0, cloud: 50, ...o,
});
const hours = (n, o) => Array.from({ length: n }, () => hour(o));
const RUT = { score: 24, phase: 'Seeking', note: 'test', tier: 'A' };
const MOON = { illum: 0.5, name: 'first quarter', frac: 0.25 };
const base = extra => scoreSit({
  hours: hours(4), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0,
  window: 'PM', ...extra,
});

test('a cold front is scored small, and says why', () => {
  // Reversed 2026-08-30, and this is the most important test in the file.
  //
  // A 20-degree drop used to score +14 — on a par with an entire rut phase,
  // and the largest weather number in the program. The Penn State Deer-Forest
  // Study found no difference in movement speed or distance before, during or
  // after a front; Oklahoma collar work found temperature drops produced no
  // movement response either. It keeps a small positive because a front does
  // bring the cold anomaly that has support, and the reason string admits the
  // classic claim is not backed.
  const flat = base({}).total;
  const front = base({ tempDropF: 12 }).total;
  const hard = base({ tempDropF: 22 }).total;

  assert.ok(front > flat, 'a front is still worth something');
  assert.ok(hard - flat <= 4, `but small: a 22-degree drop moved the score ${hard - flat}`);
  const reason = base({ tempDropF: 22 }).parts.find(p => /colder than yesterday/.test(p.reason));
  assert.match(reason.reason, /no movement change|not there/,
    'and it tells you the evidence does not support the folklore');
});

test('the rut outweighs every weather factor put together', () => {
  // The ordering used to be a matter of taste. It is now a finding: the rut
  // calendar is tier A and measured at this latitude, and every weather term
  // is tier B or worse.
  const perfect = scoreSit({
    hours: hours(4, { wind: 8, cloud: 90 }), rut: { score: 6, phase: 'October transition', note: 'x', tier: 'B' },
    moon: { illum: 0.02, name: 'new', frac: 0 }, tempDropF: 25, pressureTrend: 0.3,
    window: 'PM', normalF: 60,
  }).total;
  const rutDay = scoreSit({
    hours: hours(4, { wind: 20 }), rut: { score: 30, phase: 'Peak rut - best week', note: 'x', tier: 'A' },
    moon: MOON, tempDropF: 0, pressureTrend: 0, window: 'PM',
  }).total;
  assert.ok(rutDay > perfect,
    `peak rut in bad weather (${rutDay}) must beat October in perfect weather (${perfect})`);
});

test('wind is scored as a curve, not more-is-better', () => {
  const calm = scoreSit({ hours: hours(4, { wind: 1 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const ideal = scoreSit({ hours: hours(4, { wind: 8 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const gusty = scoreSit({ hours: hours(4, { wind: 16 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const gale = scoreSit({ hours: hours(4, { wind: 25 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;

  assert.ok(ideal > calm, 'a steady breeze beats dead calm');
  assert.ok(ideal > gusty, 'ideal beats gusty');
  assert.ok(gale < gusty, 'a gale is worst');
});

test('heavy rain is penalised but a drizzle is not', () => {
  const dry = base({}).total;
  const drizzle = scoreSit({ hours: hours(4, { precip: 0.03 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;
  const downpour = scoreSit({ hours: hours(4, { precip: 0.2 }), rut: RUT, moon: MOON, tempDropF: 0, pressureTrend: 0 }).total;

  assert.ok(drizzle >= dry, 'light rain is not a penalty');
  assert.ok(downpour < dry, 'heavy rain is a penalty');
});

test('barometric pressure is reported and scores nothing', () => {
  // Reversed 2026-08-30. The "active band" of 30.00-30.40 inHg that this used
  // to score +5 for traces to hunting-magazine logbook compilations, not a
  // study, and the one collar test of it (Oklahoma, 32 deer) found nothing.
  // A rising or falling trend has no collar support either.
  //
  // It is still COMPUTED and still SHOWN, because a number Kent can see
  // contributing zero is better than one that vanished without explanation and
  // gets proposed again next season.
  assert.equal(base({ pressureTrend: 0.2 }).total, base({ pressureTrend: -0.2 }).total,
    'the trend moves nothing either way');
  const parts = base({ pressureTrend: 0.2 }).parts.filter(p => /pressure|barometer/i.test(p.reason));
  assert.ok(parts.length, 'but it is still reported');
  for (const p of parts) {
    assert.equal(p.points, 0);
    assert.equal(p.tier, 'D', 'flagged as received wisdom with no traceable study');
  }
});

test('the moon is reported and scores nothing', () => {
  // Penn State and Mississippi State both report NO lunar pattern in movement.
  // This used to be +/-2 and called "deliberately small"; the honest weight is
  // zero.
  const dark = scoreSit({ hours: hours(4), rut: RUT, moon: { illum: 0.01, name: 'new', frac: 0 }, window: 'PM' });
  const bright = scoreSit({ hours: hours(4), rut: RUT, moon: { illum: 0.99, name: 'full', frac: 0.5 }, window: 'PM' });
  assert.equal(dark.total, bright.total, 'a full moon and a new moon score identically');
  const moonPart = dark.parts.find(p => /moon/.test(p.reason));
  assert.equal(moonPart.points, 0);
  assert.match(moonPart.reason, /NO lunar pattern/);
});

test('wind no longer penalises the deer, only the hunter', () => {
  // Reversed 2026-08-30, sign and all. 18+ mph used to score -9 on the belief
  // that deer hold in cover. Deer-Forest measured the LEAST movement in dead
  // calm and steadily more as wind rose; Webb 2010 found no clear relationship
  // either way. What survives is entirely about scent management, and is
  // labelled as being about the hunter rather than dressed up as behaviour.
  const gale = scoreSit({ hours: hours(4, { wind: 25 }), rut: RUT, moon: MOON, window: 'PM' });
  const ideal = scoreSit({ hours: hours(4, { wind: 8 }), rut: RUT, moon: MOON, window: 'PM' });
  const calm = scoreSit({ hours: hours(4, { wind: 1 }), rut: RUT, moon: MOON, window: 'PM' });

  assert.ok(ideal.total - gale.total <= 6,
    'a gale is a mild inconvenience now, not a nine-point disaster');
  assert.ok(calm.total < ideal.total, 'dead calm is still the worst wind to hunt');
  for (const s of [gale, ideal, calm]) {
    const w = s.parts.find(p => /wind \d/.test(p.reason));
    assert.equal(w.about, 'hunter', 'wind is scored as craft, not as deer behaviour');
  }
  assert.match(calm.parts.find(p => /wind \d/.test(p.reason)).reason,
    /deer move LESS in calm/, 'and it corrects the folklore out loud');
});

test('perfect weather out of season never outranks a poor day in the rut', () => {
  // Weather is additive, so without a cap a flawless August morning outscores a
  // windy November rut sit — which is nonsense, there being no season in
  // August. This is the assertion that caught it.
  const rutBadWeather = scoreSit({
    hours: hours(4, { wind: 20 }), rut: { score: 24, phase: 'Seeking', note: '', tier: 'A' },
    moon: MOON, tempDropF: 0, pressureTrend: 0, window: 'PM',
  }).total;
  const offSeasonPerfect = scoreSit({
    hours: hours(4, { wind: 8, cloud: 80 }), rut: { score: 2, phase: 'Off season', note: '', tier: 'A' },
    moon: { illum: 0.02, name: 'new', frac: 0 }, tempDropF: 22, pressureTrend: 0.2,
  }).total;

  assert.ok(rutBadWeather > 0, 'a rut sit in bad weather is still worth something');
  assert.ok(offSeasonPerfect < rutBadWeather,
    `off season (${offSeasonPerfect}) must rank below a windy rut sit (${rutBadWeather})`);
  assert.equal(rate(offSeasonPerfect), 'poor');
});

test('the off-season cap is recorded as a visible reason, not applied silently', () => {
  const s = scoreSit({
    hours: hours(4, { wind: 8, cloud: 80 }), rut: { score: 2, phase: 'Off season', note: '', tier: 'A' },
    moon: { illum: 0.02, name: 'new', frac: 0 }, tempDropF: 22, pressureTrend: 0.2,
  });
  assert.match(s.parts.at(-1).reason, /outside the hunting season/);
  // The printed reasons must still add up to the total, or the output lies.
  assert.equal(s.parts.reduce((t, p) => t + p.points, 0), s.total);
});

test('in-season scores are never touched by the cap', () => {
  const s = scoreSit({
    hours: hours(4, { wind: 8 }), rut: { score: 24, phase: 'Seeking', note: '', tier: 'A' },
    moon: MOON, tempDropF: 12, pressureTrend: 0.2, window: 'PM',
  });
  assert.equal(s.parts.reduce((t, p) => t + p.points, 0), s.total);
  assert.ok(!s.parts.some(p => /outside the hunting season/.test(p.reason)));
  // Note what is NOT asserted any more: that weather pushes this over 40. It
  // cannot, and that is the finding. The rut carries the score now.
  assert.ok(s.total >= 24, 'the rut phase alone floors it');
  assert.ok(s.total - 24 <= 8, `weather moved it by only ${s.total - 24} points`);
});

test('every factor carries a reason and an evidence tier', () => {
  // The rule changed on 2026-08-30. Zero-point factors USED to be dropped;
  // they are now deliberately kept, because a factor visibly counting for
  // nothing is the whole mechanism by which this model argues with the folklore
  // it replaced. What must never be missing is the reason or the tier.
  const s = base({ tempDropF: 12, pressureTrend: 0.2 });
  assert.ok(s.parts.length >= 3);
  for (const p of s.parts) {
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 5, `reason too terse: ${p.reason}`);
    assert.ok(['A', 'B', 'C', 'D'].includes(p.tier), `part has no evidence tier: ${p.reason}`);
    assert.ok(['deer', 'hunter'].includes(p.about), `part does not say what it is about: ${p.reason}`);
  }
  // And a tier-D part can never move the number.
  for (const p of s.parts.filter(x => x.tier === 'D')) assert.equal(p.points, 0);
});

test('a score says what it rests on, not just how big it is', () => {
  const rutDriven = scoreSit({
    hours: hours(4), rut: { score: 30, phase: 'Peak rut - best week', note: 'x', tier: 'A' },
    moon: MOON, window: 'PM',
  });
  assert.equal(rutDriven.evidence.tier, 'A');
  assert.match(rutDriven.evidence.driver, /Peak rut/);

  // The same total assembled from weather is not the same claim.
  const weatherDriven = scoreSit({
    hours: hours(4, { wind: 8 }), rut: { score: 6, phase: 'October transition', note: 'x', tier: 'C' },
    moon: MOON, window: 'PM',
  });
  assert.ok(['B', 'C'].includes(weatherDriven.evidence.tier),
    'a weather-carried score is weaker evidence than a rut-carried one');
});

test('compass converts bearings to the direction wind comes from', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(90), 'E');
  assert.equal(compass(180), 'S');
  assert.equal(compass(270), 'W');
  assert.equal(compass(315), 'NW');
  assert.equal(compass(360), 'N', 'wraps at 360');
  assert.equal(compass(-90), 'W', 'handles negative bearings');
});

test('pressure converts hPa to inHg', () => {
  assert.ok(Math.abs(inHg(1013.25) - 29.921) < 0.01, 'standard atmosphere');
});

test('ratings are ordered and every score gets one', () => {
  assert.equal(rate(60), 'PRIME');
  assert.equal(rate(36), 'strong');
  assert.equal(rate(26), 'good');
  assert.equal(rate(16), 'fair');
  assert.equal(rate(2), 'poor');
  assert.equal(rate(-50), 'poor', 'deeply negative still rates');
});
