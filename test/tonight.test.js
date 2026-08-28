/**
 * The distinction this file exists to protect: the NEXT sit is not the BEST
 * sit. The planner sorts by score, and if "tonight" ever starts reading that
 * order it will confidently send Kent to a stand nine days from now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSit, nextSits, whenLabel, departure } from '../tonight.mjs';

const CST = -6 * 3600;
const sit = (date, window, extra = {}) => ({
  date, window,
  sunrise: `${date}T06:35`, sunset: `${date}T16:32`,
  utcOffsetSeconds: CST, timezone: 'America/Chicago',
  windDir: 290, windFrom: 'WNW', temp: 34, wind: 8, rain: 0,
  rut: 'pre-rut', moon: 'waxing gibbous', total: 50, rating: 'good',
  ...extra,
});

// 3:00 pm central on the 7th, expressed as a real instant.
const AT = iso => Date.parse(iso);
const NOV7_3PM = AT('2026-11-07T21:00:00Z');

test('a sit resolves to real instants and its shooting hours', () => {
  const r = resolveSit(sit('2026-11-07', 'PM'), { now: NOV7_3PM });
  assert.equal(r.hours.openLocal, '6:05 am');
  assert.equal(r.hours.closeLocal, '4:52 pm');
  assert.equal(r.hours.exact, true);
  assert.equal(r.light.legal, true);          // 3pm is inside the day's light
  assert.equal(r.light.minutesToClose, 112);  // to 4:52 pm
});

test('the next sit is chosen by the clock, never by the score', () => {
  const sits = [
    // The planner's order: the best day first, which is a week away.
    sit('2026-11-14', 'AM', { total: 95, rating: 'prime' }),
    sit('2026-11-07', 'PM', { total: 30, rating: 'fair' }),
    sit('2026-11-08', 'AM', { total: 60, rating: 'good' }),
  ];
  const { sits: next } = nextSits(sits, { now: NOV7_3PM });
  assert.equal(next[0].date, '2026-11-07');
  assert.equal(next[0].window, 'PM');
  assert.equal(next[0].rating, 'fair');       // reported, not used to choose
  assert.equal(next[1].date, '2026-11-08');
  assert.equal(next[1].window, 'AM');
});

test('an evening already under way is still tonight, not tomorrow', () => {
  const sits = [sit('2026-11-07', 'PM'), sit('2026-11-08', 'AM')];
  // 4:30 pm central: the window opened at 1 pm and the light closes at 4:52.
  const { sits: next } = nextSits(sits, { now: AT('2026-11-07T22:30:00Z') });
  assert.equal(next[0].date, '2026-11-07');
  assert.equal(next[0].light.phase, 'last-light');
});

test('once the light is legally over, tonight becomes tomorrow morning', () => {
  const sits = [sit('2026-11-07', 'PM'), sit('2026-11-08', 'AM')];
  const { sits: next } = nextSits(sits, { now: AT('2026-11-07T22:53:00Z') });
  assert.equal(next[0].date, '2026-11-08');
  assert.equal(next[0].window, 'AM');
});

test('a plan entirely in the past is stale, which is not the same as absent', () => {
  const { sits: next, stale } = nextSits([sit('2026-11-01', 'PM')], { now: NOV7_3PM });
  assert.equal(next.length, 0);
  assert.equal(stale, true);
  assert.equal(nextSits([], { now: NOV7_3PM }).stale, false);
});

test('an older plan with no sunrise recorded still works, and admits it', () => {
  const legacy = {
    date: '2026-11-07', window: 'PM',
    start: '2026-11-07T19:00:00Z', end: '2026-11-07T22:42:00Z',
    windDir: 290, total: 40, rating: 'fair',
  };
  const r = resolveSit(legacy, { now: NOV7_3PM });
  assert.ok(r, 'a legacy sit must still resolve');
  assert.equal(r.hours.exact, false, 'and must not claim the minute is exact');
});

test('the label is relative, because you are holding your boots', () => {
  const pm = resolveSit(sit('2026-11-07', 'PM'), { now: NOV7_3PM });
  assert.equal(whenLabel(pm, NOV7_3PM), 'this evening — on now');

  const am = resolveSit(sit('2026-11-08', 'AM'), { now: NOV7_3PM });
  assert.equal(whenLabel(am, NOV7_3PM), 'tomorrow morning');

  const far = resolveSit(sit('2026-11-14', 'AM'), { now: NOV7_3PM });
  assert.match(whenLabel(far, NOV7_3PM), /^7 days out/);
});

test('a dark evening does not get called tomorrow morning', () => {
  // 5:30 pm central on the 7th. Sunrise on the 8th is 12h35 away, so any
  // "under fourteen hours means today" rule reads it as this morning.
  const halfFive = AT('2026-11-07T23:30:00Z');
  const am = resolveSit(sit('2026-11-08', 'AM'), { now: halfFive });
  assert.equal(whenLabel(am, halfFive), 'tomorrow morning');
});

test('the day is the property\'s day, not the reader\'s', () => {
  // 11pm central on the 7th is already the 8th in UTC. A reader in London
  // must still be told "tomorrow morning" about the 8th at the property.
  const late = AT('2026-11-08T05:00:00Z');
  const am = resolveSit(sit('2026-11-08', 'AM'), { now: late });
  assert.equal(whenLabel(am, late), 'tomorrow morning');
});

test('the departure time is the walk plus the settle, backed off the sit time', () => {
  const pm = resolveSit(sit('2026-11-07', 'PM'), { now: NOV7_3PM });
  const d = departure(pm, { lengthM: 800 });
  assert.equal(d.walkKnown, true);
  assert.equal(d.walkMinutes, 15);
  assert.equal((d.sitBy - d.leaveBy) / 60000, 45);   // 30 settle + 15 walk
  assert.equal((pm.hours.close - d.sitBy) / 3600000, 2.5);
});

test('with no route recorded the walk is zero and it says so', () => {
  const pm = resolveSit(sit('2026-11-07', 'PM'), { now: NOV7_3PM });
  const d = departure(pm, null);
  assert.equal(d.walkKnown, false);
  assert.equal(d.walkMinutes, 0);
});

// ---------------------------------------------------------------------------
// Half-known days — plans written before sunrise and sunset were recorded
// ---------------------------------------------------------------------------

const legacy = (window, extra = {}) => ({
  date: '2026-11-07', window,
  // The planner's scoring window: AM is sunrise-1.5h to sunrise+3.5h,
  // PM is sunset-3.5h to sunset+0.5h.
  start: window === 'AM' ? '2026-11-07T11:05:00Z' : '2026-11-07T19:02:00Z',
  end: window === 'AM' ? '2026-11-07T16:05:00Z' : '2026-11-07T23:02:00Z',
  windDir: 290, total: 40, rating: 'fair', ...extra,
});

test('a morning-only plan gives the morning bound and NOTHING for the evening', () => {
  // The first version completed the day by arithmetic: it took the far edge of
  // the morning scoring window as "sunset", so close came out around sunrise
  // plus four hours — and the page printed that as the legal window. Of
  // everything this program says, that is the one number that can cost a
  // citation.
  const r = resolveSit(legacy('AM'), { now: AT('2026-11-07T10:00:00Z') });
  assert.equal(r.hours.partial, 'AM');
  assert.ok(Number.isFinite(r.hours.open), 'the opening of light is known');
  assert.equal(r.hours.close, null, 'the close is NOT invented');
  assert.equal(r.hours.closeLocal, null);
  assert.equal(r.hours.exact, false);
  // Sunrise is start + 1h30; light opens 30 minutes before that.
  assert.equal(new Date(r.hours.sunrise).toISOString(), '2026-11-07T12:35:00.000Z');
  assert.equal((r.hours.sunrise - r.hours.open) / 60000, 30);
});

test('an evening-only plan gives the closing bound and nothing for the morning', () => {
  const r = resolveSit(legacy('PM'), { now: AT('2026-11-07T20:00:00Z') });
  assert.equal(r.hours.partial, 'PM');
  assert.equal(r.hours.open, null);
  assert.equal(r.hours.openLocal, null);
  assert.ok(Number.isFinite(r.hours.close));
  // Sunset is end - 30 min; light closes 20 minutes after it.
  assert.equal(new Date(r.hours.sunset).toISOString(), '2026-11-07T22:32:00.000Z');
  assert.equal((r.hours.close - r.hours.sunset) / 60000, 20);
});

test('a half-known day says the phase is unknown rather than guessing legality', () => {
  const r = resolveSit(legacy('AM'), { now: AT('2026-11-07T14:00:00Z') });
  assert.equal(r.light.partial, true);
  assert.equal(r.light.legal, null, 'not true, and not false — unknown');
  assert.equal(r.light.phase, 'unknown');
});

test('a half-known day still orders correctly against complete ones', () => {
  // Sequencing is a different question from legality: getting it slightly
  // wrong picks a neighbouring sit, it does not misstate shooting hours.
  const { sits: next } = nextSits(
    [legacy('PM'), sit('2026-11-08', 'AM')],
    { now: AT('2026-11-07T20:00:00Z') },
  );
  assert.equal(next[0].date, '2026-11-07');
  assert.equal(next[0].window, 'PM');
  assert.equal(next[1].window, 'AM');
});

test('with no usable bound there is no departure time, rather than a made-up one', () => {
  const am = resolveSit(legacy('AM'), { now: AT('2026-11-07T10:00:00Z') });
  assert.ok(departure(am, { lengthM: 400 }), 'a morning sit has its own bound');
  // A morning sit whose start is unparseable has neither.
  const broken = resolveSit({ ...legacy('AM'), start: 'x', end: 'y' },
    { now: AT('2026-11-07T10:00:00Z') });
  assert.equal(broken, null, 'and an unreadable one resolves to nothing at all');
});
