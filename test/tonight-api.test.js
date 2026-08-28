/**
 * The tonight screen end to end: a plan on disk, stands and routes in the
 * database, and the one thing the whole screen exists to get right — that the
 * sit it shows is the next one, not the best one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand, createRoute } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-tonight-'));

const CST = -6 * 3600;
const sit = (date, window, extra = {}) => ({
  camera: 'Creek', lat: 44.12, lng: -90.65,
  date, window,
  sunrise: `${date}T06:35`, sunset: `${date}T16:32`,
  utcOffsetSeconds: CST, timezone: 'America/Chicago',
  windDir: 315, windFrom: 'NW', wind: 9, temp: 33, rain: 0,
  rut: 'chasing', moon: 'waxing gibbous',
  total: 50, rating: 'good', parts: [],
  ...extra,
});

// 3:00 pm central on 7 November 2026.
const NOW = Date.parse('2026-11-07T21:00:00Z');

function ground(t, { sits, stands = [], routes = [] }) {
  const out = tmp();
  const db = openDb(out);
  const made = stands.map(s => createStand(db, s));
  for (const r of routes) createRoute(db, { ...r, standId: made[r.standIndex ?? 0].id });
  db.close();
  fs.writeFileSync(path.join(out, 'plan.json'),
    JSON.stringify({ generatedAt: '2026-11-07T06:00:00Z', sits }));

  const server = createServer({ out });
  t.after(() => new Promise(r => server.close(r)));
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, get: p => fetch(base + p), stands: made });
    });
  });
}

test('the screen picks the sit that is next, not the one that scores best', async t => {
  const { get } = await ground(t, {
    // The planner writes them sorted by score. The best is a week out.
    sits: [
      sit('2026-11-14', 'AM', { total: 95, rating: 'prime' }),
      sit('2026-11-07', 'PM', { total: 28, rating: 'fair' }),
      sit('2026-11-08', 'AM', { total: 61 }),
    ],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW,NNW,N' }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  assert.equal(body.sits[0].date, '2026-11-07');
  assert.equal(body.sits[0].window, 'PM');
  assert.equal(body.sits[0].rating, 'fair', 'the mediocre rating is reported, not hidden');
  assert.equal(body.sits[0].when, 'this evening — on now');
  assert.equal(body.sits[1].date, '2026-11-08', 'and the one after it is offered');
});

test('it names the stand the wind suits, with the reason that decided it', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-07', 'PM')],
    stands: [
      { name: 'East field', lat: 44.121, lng: -90.651, goodWinds: 'S,SSE' },
      { name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW,NNW' },
    ],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  const pick = body.sits[0].pick;
  assert.equal(pick.name, 'Creek ladder');
  assert.equal(pick.huntable, true);
  assert.ok(pick.reasons.some(r => /wind is NW/.test(r.why)));
  // The stand that does not suit the wind is still listed, so it is visibly
  // rejected rather than silently absent.
  assert.ok(body.sits[0].stands.some(s => s.name === 'East field'));
});

test('shooting light comes back on the property clock, with the caveat attached', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-07', 'PM')],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  const s = body.sits[0];
  assert.equal(s.hours.openLocal, '6:05 am');
  assert.equal(s.hours.closeLocal, '4:52 pm');
  assert.equal(s.hours.exact, true, 'exact, because the plan carried the offset');
  assert.equal(s.light.legal, true);
  assert.match(body.shootingHours.caveat, /legal authority/);
});

test('the walk in is judged against the same wind as the stand', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-07', 'PM')],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
    routes: [
      // Approaching from the north-west on a NW wind pushes scent straight
      // down onto the stand.
      { name: 'Straight in', points: [[-90.6512, 44.1211], [-90.6505, 44.1205], [-90.65, 44.12]] },
      // From the south-east, upwind of it.
      { name: 'Round the back', points: [[-90.6488, 44.1189], [-90.6494, 44.1195], [-90.65, 44.12]] },
    ],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  const walk = body.sits[0].walk;
  assert.equal(walk.ok, true, 'the clean route is the one offered');
  assert.equal(walk.name, 'Round the back');
  assert.match(walk.why, /upwind of Creek ladder/);
  // And the dirty one is still on the record.
  assert.ok(body.sits[0].pick.routes.some(r => r.ok === false));
});

test('the departure time is the walk plus the settle, off the sit time', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-07', 'PM')],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
    routes: [{ name: 'Round the back',
      points: [[-90.6488, 44.1189], [-90.6494, 44.1195], [-90.65, 44.12]] }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  const d = body.sits[0].depart;
  assert.equal(d.walkKnown, true);
  assert.ok(d.walkMinutes > 0);
  assert.equal((d.sitBy - d.leaveBy) / 60000, d.settleMin + d.walkMinutes);
});

test('once the light is over, tonight has become tomorrow morning', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-07', 'PM'), sit('2026-11-08', 'AM')],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
  });
  const late = Date.parse('2026-11-07T23:30:00Z');   // 5:30 pm central
  const body = await (await get(`/api/tonight?now=${late}`)).json();
  assert.equal(body.sits[0].date, '2026-11-08');
  assert.equal(body.sits[0].window, 'AM');
  assert.equal(body.sits[0].when, 'tomorrow morning');
});

test('a plan whose sits have all passed says so, rather than showing nothing', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-01', 'PM')],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  assert.equal(body.sits.length, 0);
  assert.match(body.note, /already passed/);
});

test('a stand with no winds recorded is not given the benefit of the doubt', async t => {
  const { get } = await ground(t, {
    sits: [sit('2026-11-07', 'PM')],
    stands: [{ name: 'Unmeasured', lat: 44.12, lng: -90.65 }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  assert.equal(body.sits[0].pick.huntable, null);
  assert.match(body.sits[0].summary, /good winds recorded/);
});

test('the page itself is served', async t => {
  const { get } = await ground(t, { sits: [sit('2026-11-07', 'PM')] });
  const res = await get('/tonight');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Tonight/);
  assert.match(html, /api\/tonight/);
});

test('a much better day still ahead is named, with the margin', async t => {
  const { get } = await ground(t, {
    sits: [
      sit('2026-11-14', 'AM', { total: 95, rating: 'prime' }),
      sit('2026-11-07', 'PM', { total: 28, rating: 'fair' }),
    ],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  assert.equal(body.best.date, '2026-11-14');
  assert.equal(body.best.betterBy, 67);
  assert.match(body.best.when, /days out/);
});

test('when tonight IS the best sit, there is no better day to point at', async t => {
  const { get } = await ground(t, {
    sits: [
      sit('2026-11-07', 'PM', { total: 88, rating: 'prime' }),
      sit('2026-11-09', 'AM', { total: 40 }),
    ],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  assert.equal(body.best, null);
});

test('a better day that has already passed is not offered', async t => {
  const { get } = await ground(t, {
    sits: [
      sit('2026-11-02', 'PM', { total: 99, rating: 'prime' }),   // gone
      sit('2026-11-07', 'PM', { total: 28, rating: 'fair' }),
    ],
    stands: [{ name: 'Creek ladder', lat: 44.12, lng: -90.65, goodWinds: 'NW' }],
  });
  const body = await (await get(`/api/tonight?now=${NOW}`)).json();
  assert.equal(body.best, null);
});
