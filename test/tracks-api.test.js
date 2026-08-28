/**
 * Tracks over HTTP. The design decision under test is that the PHONE sends raw
 * fixes and the SERVER filters: the filtering is the part most likely to need
 * improving, and a track recorded today should get the benefit of that, which
 * is impossible if the phone already threw the evidence away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand, createRoute } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-tracks-'));
const LAT = 44.12, LNG = -90.65;
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos(LAT * Math.PI / 180));

const walkNorth = (n, opts = {}) => Array.from({ length: n }, (_, i) => ({
  lat: LAT + i * M_LAT, lng: LNG, acc: opts.acc ?? 6, t: 1762000000000 + i * 1000,
}));

async function serving(t, seed = () => ({})) {
  const out = tmp();
  const db = openDb(out);
  const made = seed(db);
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { json, made };
}

test('the phone sends raw fixes and the server does the filtering', async t => {
  const { json } = await serving(t);
  const fixes = walkNorth(150);
  fixes[70] = { ...fixes[70], lat: LAT + 400 * M_LAT, lng: LNG + 400 * M_LNG };
  fixes[100] = { ...fixes[100], acc: 300 };

  const res = await json('POST', '/api/tracks', { fixes, name: 'Walk in' });
  assert.equal(res.status, 201);
  const t1 = await res.json();
  assert.equal(t1.fixes, 150, 'every raw fix is recorded as having been seen');
  assert.equal(t1.dropped.speed, 1, 'the teleport was rejected');
  assert.equal(t1.dropped.accuracy, 1, 'and the bad fix too');
  assert.ok(Math.abs(t1.length_m - 149) <= 5, `about 149 m, got ${t1.length_m}`);
  assert.equal(t1.quality.level, 'good');
  assert.ok(t1.points.length >= 2 && t1.points.length < 40, 'simplified for storage');
});

test('what was filtered out is stored with the track, because it decides its worth', async t => {
  const { json } = await serving(t);
  const fixes = walkNorth(60).map((p, i) => (i % 3 ? { ...p, acc: 400 } : p));
  const saved = await (await json('POST', '/api/tracks', { fixes })).json();
  assert.equal(saved.quality.level, 'poor');
  assert.match(saved.quality.why, /rough indication/);
  // And it survives a re-read: a later reader must not have to re-derive it.
  const back = await (await json('GET', `/api/tracks/${saved.id}`)).json();
  assert.equal(back.quality.level, 'poor');
  assert.equal(back.dropped.accuracy, saved.dropped.accuracy);
});

test('a walk of nothing but noise is refused, with the reason', async t => {
  const { json } = await serving(t);
  const junk = Array.from({ length: 30 }, (_, i) => ({
    lat: LAT, lng: LNG, acc: 500, t: 1762000000000 + i * 1000,
  }));
  const res = await json('POST', '/api/tracks', { fixes: junk });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /nothing usable in 30 fixes/);
  assert.ok(body.track, 'and the filtering result comes back so the page can explain');
  assert.equal((await (await json('GET', '/api/tracks')).json()).tracks.length, 0);
});

test('fewer than two fixes is not a track', async t => {
  const { json } = await serving(t);
  for (const fixes of [[], [{ lat: LAT, lng: LNG, acc: 5, t: 1 }]]) {
    const res = await json('POST', '/api/tracks', { fixes });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at least two fixes/);
  }
});

test('a track walked against a route is compared to it on the spot', async t => {
  // Nobody comes back later to ask "did I follow the plan", so the answer
  // arrives with the save.
  const { json, made } = await serving(t, db => {
    const stand = createStand(db, { name: 'Creek ladder', lat: LAT + 200 * M_LAT, lng: LNG });
    const route = createRoute(db, {
      standId: stand.id, name: 'Straight in',
      points: [[LNG, LAT], [LNG, LAT + 200 * M_LAT]],
    });
    return { stand, route };
  });

  // Walked it faithfully.
  const clean = await (await json('POST', '/api/tracks', {
    fixes: walkNorth(200), standId: made.stand.id, routeId: made.route.id,
  })).json();
  assert.equal(clean.vsRoute.comparable, true);
  assert.equal(clean.vsRoute.followed, true);
  assert.equal(clean.stand_name, 'Creek ladder');
  assert.equal(clean.route_name, 'Straight in');

  // Cut the corner by 70 m in the dark.
  const strayed = walkNorth(200);
  for (let i = 80; i < 130; i++) strayed[i].lng = LNG + 70 * M_LNG;
  const off = await (await json('POST', '/api/tracks', {
    fixes: strayed, standId: made.stand.id, routeId: made.route.id,
  })).json();
  assert.equal(off.vsRoute.followed, false);
  assert.ok(Math.abs(off.vsRoute.worstM - 70) < 8, `got ${off.vsRoute.worstM} m`);
  assert.match(off.vsRoute.why, /never looked at/);
});

test('a recorded track cannot be edited, only deleted', async t => {
  // A route is a plan you can change; a track is a measurement. Letting it be
  // patched turns the record of a walk into a story about it.
  const { json } = await serving(t);
  const saved = await (await json('POST', '/api/tracks', { fixes: walkNorth(60) })).json();
  const patch = await json('PATCH', `/api/tracks/${saved.id}`, { length_m: 5 });
  assert.equal(patch.status, 405);
  assert.match((await patch.json()).error, /not editable/);
  assert.equal((await json('DELETE', `/api/tracks/${saved.id}`)).status, 200);
  assert.equal((await json('GET', `/api/tracks/${saved.id}`)).status, 404);
});

test('a track pointed at a stand or route that does not exist is refused', async t => {
  const { json } = await serving(t);
  for (const [body, pattern] of [
    [{ fixes: walkNorth(60), standId: 404 }, /no stand with id/],
    [{ fixes: walkNorth(60), routeId: 404 }, /no route with id/],
  ]) {
    const res = await json('POST', '/api/tracks', body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, pattern);
  }
});

test('tracks come back newest first', async t => {
  const { json } = await serving(t);
  await json('POST', '/api/tracks', { fixes: walkNorth(60), name: 'older' });
  await json('POST', '/api/tracks', {
    fixes: walkNorth(60).map(p => ({ ...p, t: p.t + 86400000 })), name: 'newer',
  });
  const { tracks } = await (await json('GET', '/api/tracks')).json();
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].name, 'newer');
});

test('a track the filters call unusable is refused, not saved and compared', async t => {
  // Two surviving points out of sixty still draw a confident line, and the
  // route comparison then reports a stray of a hundred metres measured from
  // nothing. Seen for real in a browser run where compressed timing tripped
  // the speed gate: the page announced having left the route by 140 m.
  const { json, made } = await serving(t, db => {
    const stand = createStand(db, { name: 'Creek', lat: LAT + 200 * M_LAT, lng: LNG });
    return { stand, route: createRoute(db, {
      standId: stand.id, name: 'In', points: [[LNG, LAT], [LNG, LAT + 200 * M_LAT]] }) };
  });
  // Sixty fixes, each implying 100 m/s — every one but the first is rejected.
  const tooFast = Array.from({ length: 60 }, (_, i) => ({
    lat: LAT + i * 3.6 * M_LAT, lng: LNG, acc: 6, t: 1762000000000 + i * 35,
  }));
  const res = await json('POST', '/api/tracks', {
    fixes: tooFast, standId: made.stand.id, routeId: made.route.id,
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /nothing usable in 60 fixes/);
  assert.equal(body.track.quality.level, 'unusable');
  assert.ok(!body.vsRoute, 'and no comparison is offered for a track that is not one');
  assert.equal((await (await json('GET', '/api/tracks')).json()).tracks.length, 0,
    'nothing was stored');
});
