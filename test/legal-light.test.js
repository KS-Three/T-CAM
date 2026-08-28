/**
 * The one file here whose output could cost a citation rather than a sit, so
 * the tests are about the two ways it could lie: the wrong offset either side
 * of sunrise, and the timezone of the machine leaking into a time that is
 * supposed to describe a place.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WISCONSIN_DEER, localInstant, shootingHours, clockFace, shiftClock,
  lightNow, beInTreeBy, walkMinutes, SETTLE_MIN,
} from '../legal-light.mjs';

const RISE = '2026-11-07T06:35';
const SET = '2026-11-07T16:32';
const CST = -6 * 3600;   // what Open-Meteo reports for Wisconsin in November

test('a naive local time is resolved against the PROPERTY offset, not the machine', () => {
  const { ms, exact } = localInstant(RISE, CST);
  assert.equal(exact, true);
  // 06:35 central is 12:35 UTC. This must hold whatever TZ the test runs in.
  assert.equal(new Date(ms).toISOString(), '2026-11-07T12:35:00.000Z');
});

test('the same string in a different zone resolves to a different instant', () => {
  const central = localInstant(RISE, CST).ms;
  const eastern = localInstant(RISE, -5 * 3600).ms;
  assert.equal(central - eastern, 3600000);
});

test('a time that already carries an offset is left alone', () => {
  assert.equal(localInstant('2026-11-07T06:35:00Z', CST).ms, Date.parse('2026-11-07T06:35:00Z'));
  assert.equal(localInstant('2026-11-07T06:35:00-06:00', null).exact, true);
});

test('with no offset recorded it still answers, but says it is not exact', () => {
  const r = localInstant(RISE, null);
  assert.equal(r.exact, false);
  assert.ok(Number.isFinite(r.ms));
});

test('Wisconsin is 30 minutes before sunrise to 20 minutes after sunset', () => {
  const h = shootingHours(RISE, SET, { utcOffsetSeconds: CST });
  assert.equal((h.sunrise - h.open) / 60000, 30);
  assert.equal((h.close - h.sunset) / 60000, 20);
  assert.equal(h.openLocal, '6:05 am');
  assert.equal(h.closeLocal, '4:52 pm');
  assert.equal(h.exact, true);
  assert.equal(h.rules.authority, 'Wisconsin DNR');
});

test('the offsets are parameters, because other states differ', () => {
  const h = shootingHours(RISE, SET, {
    utcOffsetSeconds: CST,
    rules: { ...WISCONSIN_DEER, beforeSunriseMin: 30, afterSunsetMin: 30 },
  });
  assert.equal(h.closeLocal, '5:02 pm');
});

test('the DNR caveat travels with the numbers', () => {
  const h = shootingHours(RISE, SET, { utcOffsetSeconds: CST });
  assert.match(h.rules.caveat, /legal authority/);
});

test('clock arithmetic crosses midnight without changing the hour twice', () => {
  assert.equal(clockFace('2026-11-07T00:04'), '12:04 am');
  assert.equal(clockFace('2026-11-07T12:00'), '12:00 pm');
  assert.equal(shiftClock('2026-11-07T00:10', -30), '11:40 pm');
  assert.equal(shiftClock('2026-11-07T23:50', 20), '12:10 am');
});

test('bad input gives null rather than a plausible wrong time', () => {
  assert.equal(shootingHours(null, SET, { utcOffsetSeconds: CST }), null);
  assert.equal(shootingHours('not a time', SET, { utcOffsetSeconds: CST }), null);
  assert.equal(clockFace(undefined), null);
});

test('the clock is placed against the hours', () => {
  const h = shootingHours(RISE, SET, { utcOffsetSeconds: CST });
  assert.equal(lightNow(h, h.open - 45 * 60000).phase, 'before');
  assert.equal(lightNow(h, h.open - 45 * 60000).minutesToOpen, 45);
  assert.equal(lightNow(h, h.open + 60 * 60000).phase, 'open');
  assert.equal(lightNow(h, h.close - 10 * 60000).phase, 'last-light');
  assert.equal(lightNow(h, h.close - 10 * 60000).legal, true);
  assert.equal(lightNow(h, h.close + 60000).phase, 'after');
  assert.equal(lightNow(h, h.close + 60000).legal, false);
});

test('an evening sit is planned around deer moving, not around last light', () => {
  const h = shootingHours(RISE, SET, { utcOffsetSeconds: CST });
  const pm = beInTreeBy(h, 'PM', { walkMinutes: 12 });
  assert.equal((h.close - pm.sitBy) / 3600000, 2.5);
  assert.equal((pm.sitBy - pm.leaveBy) / 60000, SETTLE_MIN + 12);

  const am = beInTreeBy(h, 'AM', { walkMinutes: 12 });
  assert.equal(am.sitBy, h.open);
});

test('the walk is planned at a slow, quiet pace', () => {
  // 800 m at 0.9 m/s is a shade under 15 minutes, and rounds up.
  assert.equal(walkMinutes(800), 15);
  assert.equal(walkMinutes(0), 0);
  assert.equal(walkMinutes(null), null);
});
