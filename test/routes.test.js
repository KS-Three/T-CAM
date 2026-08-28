import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bearing, angleBetween, routeLength, scentReaches, routeWinds, assessRoute,
  CONE_REACH_M, CONE_HALF_ANGLE_DEG,
} from '../routes.mjs';
import {
  openDb, createStand, createRoute, updateRoute, deleteRoute, allRoutes, routeById,
  routesForStand,
} from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-routes-'));

const STAND = { name: 'Oak Ridge', lat: 44.1260, lng: -90.6510 };
// A walk-in due WEST of the stand.
const FROM_WEST = [[-90.6525, 44.1260], [-90.6520, 44.1260], [-90.6515, 44.1260]];

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test('bearings point where they should', () => {
  assert.ok(Math.abs(bearing(44.12, -90.65, 44.13, -90.65) - 0) < 1, 'north');
  assert.ok(Math.abs(bearing(44.12, -90.65, 44.12, -90.64) - 90) < 1, 'east');
  assert.ok(Math.abs(bearing(44.12, -90.65, 44.11, -90.65) - 180) < 1, 'south');
  assert.ok(Math.abs(bearing(44.12, -90.65, 44.12, -90.66) - 270) < 1, 'west');
});

test('the angle between two bearings is the SMALL one, and is not inverted', () => {
  // The bug this pins was the worst possible one for this file. An earlier
  // version subtracted the wrap expression from 180 as well, inverting every
  // result: a route due west of a stand then read clean on a west wind and
  // dirty on an east one — exactly backwards. It would have sent you up a
  // stand you had just walked your scent across while reporting it fine.
  assert.equal(angleBetween(90, 90), 0, 'the same bearing is zero degrees apart');
  assert.equal(angleBetween(0, 180), 180);
  assert.equal(angleBetween(350, 10), 20, 'and it wraps the short way round');
  assert.equal(angleBetween(10, 350), 20, 'in both directions');
  assert.equal(angleBetween(0, 90), 90);
});

test('route length is measured on the ground', () => {
  assert.equal(routeLength([[-90.65, 44.12]]), 0, 'one point is no distance');
  const m = routeLength([[-90.65, 44.12], [-90.65, 44.13]]);
  assert.ok(Math.abs(m - 1112) < 30, `about 1.1 km for a hundredth of a degree of latitude (${m})`);
});

// ---------------------------------------------------------------------------
// Scent
// ---------------------------------------------------------------------------

test('a walk upwind of the stand is clean; downwind of it is not', () => {
  // Wind FROM the west blows east, and the route is west of the stand, so the
  // stand is downwind of the walk. That is the dirty case.
  const dirty = scentReaches(FROM_WEST, STAND, 270);
  assert.ok(dirty, 'a west wind carries the walk onto the stand');
  assert.equal(dirty.offAxisDeg, 0, 'and dead on the axis');
  assert.ok(dirty.metres > 0 && dirty.metres < CONE_REACH_M);

  assert.equal(scentReaches(FROM_WEST, STAND, 90), null,
    'an east wind carries it away');
  assert.equal(scentReaches(FROM_WEST, STAND, 0), null,
    'and a north wind carries it across, not onto');
});

test('the dirty winds are the ones that blow from the walk toward the stand', () => {
  const { clean, dirty } = routeWinds(FROM_WEST, STAND);
  assert.deepEqual(dirty.sort(), ['W', 'WNW', 'WSW'].sort(),
    'a route to the west is dirty on the westerlies, and only those');
  assert.ok(clean.includes('E') && clean.includes('N') && clean.includes('S'));
  assert.equal(clean.length + dirty.length, 16, 'every compass point is judged');
});

test('scent does not reach past the modelled distance', () => {
  const far = [[-90.6900, 44.1260], [-90.6890, 44.1260]];   // ~3 km west
  assert.equal(scentReaches(far, STAND, 270), null, 'too far to count');
  assert.ok(scentReaches(far, STAND, 270, { reachM: 5000 }),
    'and the reach is a parameter, not a hidden constant');
});

test('the cone has an angle, and it is adjustable', () => {
  // Something off to one side is inside a wide cone and outside a narrow one.
  const offset = { name: 'Off axis', lat: 44.1272, lng: -90.6510 };
  assert.equal(scentReaches(FROM_WEST, offset, 270, { halfAngleDeg: 5 }), null);
  assert.ok(scentReaches(FROM_WEST, offset, 270, { halfAngleDeg: 80 }));
  assert.ok(CONE_HALF_ANGLE_DEG > 0 && CONE_HALF_ANGLE_DEG < 90);
});

test('an unknown wind gives an unknown answer, never a passing one', () => {
  // The same rule the stand ranking follows: a missing input must not read as
  // a clean bill of health.
  assert.equal(scentReaches(FROM_WEST, STAND, null), null);
  const v = assessRoute({ points: FROM_WEST }, { stand: STAND, windFromDeg: null });
  assert.equal(v.ok, null, 'not true');
  assert.match(v.why, /cannot be judged/);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('the verdict names the stand and how close the walk comes', () => {
  const bad = assessRoute({ points: FROM_WEST }, { stand: STAND, windFromDeg: 270 });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /carries your scent over Oak Ridge/);
  assert.ok(bad.onStand.metres > 0);
  assert.ok(bad.lengthM > 0);

  const good = assessRoute({ points: FROM_WEST }, { stand: STAND, windFromDeg: 90 });
  assert.equal(good.ok, true);
  assert.match(good.why, /upwind of Oak Ridge/);
});

test('a walk that blows across ANOTHER stand is flagged without failing this one', () => {
  // Walking under a second stand on the way to the first is the same mistake
  // one step removed — worth saying, but it does not make this sit wrong.
  const other = { name: 'Creek tripod', lat: 44.1260, lng: -90.6518 };
  const v = assessRoute({ points: FROM_WEST },
    { stand: STAND, others: [other], windFromDeg: 270 });
  assert.equal(v.ok, false, 'this one is dirty on its own account');

  const east = assessRoute({ points: FROM_WEST },
    { stand: { name: 'Far east', lat: 44.1260, lng: -90.6400 }, others: [other], windFromDeg: 270 });
  assert.equal(east.ok, true, 'the stand itself is out of reach');
  assert.equal(east.crossed.length, 1);
  assert.match(east.why, /blows across Creek tripod/);
});

test('a route needs two points and a stand before it means anything', () => {
  assert.equal(assessRoute({ points: [[-90.65, 44.12]] }, { stand: STAND, windFromDeg: 0 }).ok, null);
  assert.match(assessRoute({ points: FROM_WEST }, { windFromDeg: 0 }).why, /not attached to a stand/);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function seeded() {
  const db = openDb(tmp());
  const stand = createStand(db, { name: 'Oak Ridge', lat: 44.126, lng: -90.651, goodWinds: ['NW'] });
  return { db, stand };
}

test('a route is stored against the stand it leads to', () => {
  const { db, stand } = seeded();
  const r = createRoute(db, { standId: stand.id, name: 'From the gate', points: FROM_WEST });
  assert.equal(r.stand_id, stand.id);
  assert.deepEqual(r.points, FROM_WEST, 'points come back as coordinates, not a string');
  assert.equal(routesForStand(db, stand.id).length, 1);
  assert.equal(allRoutes(db)[0].stand_name, 'Oak Ridge');
  db.close();
});

test('a route point missing a coordinate is refused before conversion', () => {
  // Number(null) is 0, and 0,0 is a real place in the Atlantic. An earlier
  // version converted first and cheerfully accepted [null, 43] as a point off
  // the coast of Africa — with a comment above it warning about exactly that.
  const { db, stand } = seeded();
  for (const bad of [
    [[null, 44.12], [-90.65, 44.13]],
    [[undefined, 44.12], [-90.65, 44.13]],
    [['', 44.12], [-90.65, 44.13]],
    [[true, 44.12], [-90.65, 44.13]],
  ]) {
    assert.throws(() => createRoute(db, { standId: stand.id, points: bad }),
      /missing a coordinate/, JSON.stringify(bad));
  }
  assert.throws(() => createRoute(db, { standId: stand.id, points: [[-89, 999], [-89, 44]] }),
    /real coordinates/);
  assert.throws(() => createRoute(db, { standId: stand.id, points: [[-90.65, 44.12]] }),
    /at least two points/);
  assert.equal(allRoutes(db).length, 0, 'and none of them were stored');
  db.close();
});

test('a route cannot point at a stand that does not exist', () => {
  const { db } = seeded();
  assert.throws(() => createRoute(db, { standId: 999, points: FROM_WEST }), /no stand with id/);
  db.close();
});

test('a route can be edited and deleted, and a bad edit changes nothing', () => {
  const { db, stand } = seeded();
  const r = createRoute(db, { standId: stand.id, name: 'A', points: FROM_WEST });
  assert.equal(updateRoute(db, r.id, { name: 'B' }).name, 'B');
  assert.deepEqual(routeById(db, r.id).points, FROM_WEST, 'an unmentioned field is left alone');
  assert.throws(() => updateRoute(db, r.id, { points: [[null, 1], [2, 3]] }), /missing a coordinate/);
  assert.equal(routeById(db, r.id).name, 'B', 'the stored route survived the bad edit');
  assert.ok(deleteRoute(db, r.id));
  assert.equal(routeById(db, r.id), null);
  db.close();
});

test('deleting a stand takes its routes with it', () => {
  // A route's whole meaning is "the way in to that stand". Orphaned, it cannot
  // be judged against anything.
  const { db, stand } = seeded();
  createRoute(db, { standId: stand.id, points: FROM_WEST });
  db.prepare('DELETE FROM stands WHERE id = ?').run(stand.id);
  assert.equal(allRoutes(db).length, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t) {
  const out = tmp();
  const db = openDb(out);
  createStand(db, { name: 'Oak Ridge', lat: 44.126, lng: -90.651, goodWinds: ['NW'] });
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return {
    json: (method, p, body) => fetch(base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

test('routes round-trip through the API and report their clean winds', async t => {
  const { json } = await serving(t);
  const stands = await (await json('GET', '/api/stands')).json();
  const made = await json('POST', '/api/routes',
    { standId: stands[0].id, name: 'From the gate', points: FROM_WEST });
  assert.equal(made.status, 201);

  const listed = await (await json('GET', '/api/routes')).json();
  assert.equal(listed.length, 1);
  assert.ok(listed[0].lengthM > 0);
  assert.deepEqual(listed[0].winds.dirty.sort(), ['W', 'WNW', 'WSW'].sort(),
    'the walk is judged when it is cut, not only on the morning you use it');

  const id = listed[0].id;
  assert.equal((await json('PATCH', `/api/routes/${id}`, { name: 'Renamed' })).status, 200);
  assert.equal((await json('DELETE', `/api/routes/${id}`)).status, 200);
  assert.equal((await (await json('GET', '/api/routes')).json()).length, 0);
});

test('a bad route is the caller\'s mistake, not a server fault', async t => {
  const { json } = await serving(t);
  assert.equal((await json('POST', '/api/routes', { points: [[-89, 43]] })).status, 400);
  assert.equal((await json('POST', '/api/routes', { points: [[null, 43], [-89, 44]] })).status, 400);
  assert.equal((await json('POST', '/api/routes', { standId: 999, points: FROM_WEST })).status, 400);
  assert.equal((await json('PATCH', '/api/routes/999', { name: 'x' })).status, 404);
  assert.equal((await json('DELETE', '/api/routes/999')).status, 404);
});
