/**
 * /api/where — the WHERE half over HTTP.
 *
 * The module's own reasoning is pinned in analysis.test.js. What these check is
 * the boundary: that the endpoint refuses an unknown condition by name rather
 * than falling back to a default, that an unconfirmed machine claim does not
 * become a sighting on its way through the server, that the stands come back
 * attached to the cameras that produced, and that the plan's own next sit
 * selects the bucket it belongs in — or none, when the plan cannot place it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, upsertCamera, upsertPhoto, addDetection, upsertWeatherHour,
  weatherLocationFor, createStand,
} from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-where-'));
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

const DAYS = Array.from({ length: 10 }, (_, i) =>
  new Date(Date.parse('2025-11-01T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));

const CAM_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CAM_B = 'eeeeeeeeeeeeeeeeeeeeeeee';

/** Ten days of weather, afternoons wet; both cameras watching every day. */
function seedGround(db) {
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  upsertCamera(db, norm({
    ...FLEX_M, id: CAM_B, config: { ...FLEX_M.config, name: 'Creek Bottom' },
  }), { provider: 'spypoint' });
  const loc = weatherLocationFor(db, 44.123456, -90.654321);
  for (const d of DAYS) {
    for (let h = 0; h < 24; h++) {
      upsertWeatherHour(db, loc.id, `${d}T${String(h).padStart(2, '0')}:00:00Z`, {
        tempF: 40, pressureInHg: 30.0, windMph: 8, windDir: 270,
        precipIn: h >= 12 ? 0.05 : 0, cloudPct: 50,
      });
    }
    for (const cam of [CAM_A, CAM_B]) {
      upsertPhoto(db, {
        provider: 'spypoint', cameraId: cam, nativeId: `${cam}-${d}-idle`,
        takenAt: `${d}T03:00:00.000Z`,
      });
    }
  }
  return loc;
}

const tag = (db, cam, day, hour, { confirmed = true, species = 'deer' } = {}) => {
  const p = upsertPhoto(db, {
    provider: 'spypoint', cameraId: cam, nativeId: `${cam}-${day}-${hour}`,
    takenAt: `${day}T${String(hour).padStart(2, '0')}:20:00.000Z`,
  });
  addDetection(db, {
    photoId: p.id, species, source: confirmed ? 'manual' : 'camera-ai', confirmed,
  });
};

async function serving(t, seed, plan) {
  const out = tmp();
  const db = openDb(out);
  if (seed) seed(db);
  db.close();
  if (plan) fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan));
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { out, get: async p => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  } };
}

test('cameras in the same rain come back ranked, with their counts', async (t) => {
  const { get } = await serving(t, db => {
    seedGround(db);
    for (let i = 0; i < 6; i++) tag(db, CAM_A, DAYS[i], 14);
    tag(db, CAM_B, DAYS[0], 15);
  });
  const { status, body } = await get('/api/where?group=rain');
  assert.equal(status, 200);
  assert.equal(body.refusal, null);
  assert.equal(body.group.key, 'rain');
  assert.equal(body.common.days, 10);
  const wet = body.buckets.find(b => b.key === 'wet');
  assert.equal(wet.ranked[0].name, 'North Ridge');
  assert.equal(wet.ranked[0].sightings, 6);
  assert.equal(wet.ranked[0].hours, 120);
  assert.equal(wet.ranked[0].per100, 5);
  assert.equal(wet.ranked[1].sightings, 1);
  assert.ok(body.groups.some(g => g.key === 'winddir'), 'the other cuts are offered');
  assert.equal(body.minHours, 10);
});

test("the camera's own guess does not become a sighting on the way through", async (t) => {
  const { get } = await serving(t, db => {
    seedGround(db);
    for (let i = 0; i < 6; i++) tag(db, CAM_B, DAYS[i], 14, { confirmed: false });
    tag(db, CAM_A, DAYS[0], 14);
  });
  const { body } = await get('/api/where?group=rain');
  const wet = body.buckets.find(b => b.key === 'wet');
  assert.equal(wet.ranked.find(r => r.name === 'Creek Bottom').sightings, 0);
  assert.equal(wet.ranked[0].name, 'North Ridge');
});

test('an unknown condition group is refused by name, never defaulted', async (t) => {
  const { get } = await serving(t, seedGround);
  const { status, body } = await get('/api/where?group=solunar');
  assert.equal(status, 400);
  assert.match(body.error, /unknown condition group "solunar"/);
  assert.ok(body.groups.length, 'and the real ones are listed');
});

test('nothing tagged is a refusal that names the screen that fixes it', async (t) => {
  const { get } = await serving(t, seedGround);
  const { status, body } = await get('/api/where');
  assert.equal(status, 200, 'a refusal is an answer, not an error');
  assert.equal(body.refusal.code, 'nothing-tagged');
  assert.match(body.refusal.says, /Review/);
  assert.equal(body.buckets.length, 0);
  assert.equal(body.cameras.length, 2, 'the coverage still comes back');
});

test('a producing camera comes back with the stand that watches it', async (t) => {
  const { get } = await serving(t, db => {
    seedGround(db);
    createStand(db, { name: 'Ladder', lat: 44.1236, lng: -90.6544, type: 'stand' });
    for (let i = 0; i < 6; i++) tag(db, CAM_A, DAYS[i], 14);
  });
  const { body } = await get('/api/where?group=rain');
  const wet = body.buckets.find(b => b.key === 'wet');
  assert.equal(wet.stands[0].stand, 'Ladder');
  assert.equal(wet.stands[0].camera, 'North Ridge');
  assert.ok(wet.stands[0].metres > 0);
});

test("the plan's next sit selects the bucket it falls in", async (t) => {
  const plan = {
    sits: [{
      date: '2025-11-05', window: 'PM', rating: 'strong', total: 40,
      start: '2025-11-05T19:00:00.000Z', end: '2025-11-05T23:00:00.000Z',
      windFrom: 'W', windDir: 270, wind: 8, temp: 40, rain: 0.2,
    }],
  };
  const { get } = await serving(t, db => {
    seedGround(db);
    for (let i = 0; i < 6; i++) tag(db, CAM_A, DAYS[i], 14);
  }, plan);
  const { body } = await get('/api/where?group=rain&now=' + Date.parse('2025-11-05T18:00:00Z'));
  assert.equal(body.tonight.rain, 'wet');
  assert.equal(body.tonight.winddir, 'W');
  assert.equal(body.sit.date, '2025-11-05');
  // The plan carries no cloud cover and no barometer trend, so those cuts
  // select nothing rather than defaulting to a bucket nobody asked for.
  assert.equal(body.tonight.sky, undefined);
  assert.equal(body.tonight.pressure, undefined);
});

test('with no plan at all, nothing is selected and nothing is invented', async (t) => {
  const { get } = await serving(t, db => {
    seedGround(db);
    tag(db, CAM_A, DAYS[0], 14);
  });
  const { body } = await get('/api/where?group=rain');
  assert.deepEqual(body.tonight, {});
  assert.equal(body.sit, null);
});

test('species can be widened to anything tagged', async (t) => {
  const { get } = await serving(t, db => {
    seedGround(db);
    tag(db, CAM_A, DAYS[0], 14, { species: 'turkey' });
  });
  const deer = await get('/api/where?group=rain&species=deer');
  assert.equal(deer.body.refusal.code, 'nothing-tagged', 'no deer is no deer');
  const any = await get('/api/where?group=rain&species=any');
  assert.equal(any.body.refusal, null);
  assert.equal(any.body.buckets.find(b => b.key === 'wet').ranked[0].sightings, 1);
});
