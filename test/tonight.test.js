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
