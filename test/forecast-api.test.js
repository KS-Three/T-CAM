/**
 * The forecast the weather strip scrubs: proxied, cached, honest about age.
 *
 * The three-way behaviour is what these pin — fresh from the service, served
 * from cache inside the TTL, and stale-but-said-so when the internet is gone.
 * A Tuesday forecast passed off as live is how you sit the wrong wind
 * believing the map, so the stale path carries a note and the tests read it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, createStand, saveForecast, cachedForecast } from '../db.mjs';
import { shapeForecast, wmoWord, fetchForecast } from '../forecast.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-fc-'));

/** A tiny Open-Meteo, five hours long. */
const RAW = {
  timezone: 'America/Chicago',
  utc_offset_seconds: -18000,
  hourly: {
    time: ['2026-08-29T15:00', '2026-08-29T16:00', '2026-08-29T17:00',
      '2026-08-29T18:00', '2026-08-29T19:00'],
    temperature_2m: [71.3, 69.8, 66.1, 62.4, 59.9],
    wind_speed_10m: [7.6, 8.4, 9.1, 11.8, 6.2],
    wind_direction_10m: [312, 318, 331, 344, 351],
    wind_gusts_10m: [14.1, 15.9, 18.2, 22.0, 12.1],
    precipitation: [0, 0, 0.02, 0.11, 0],
    precipitation_probability: [5, 10, 45, 70, 20],
    cloud_cover: [20, 45, 80, 100, 60],
    weather_code: [1, 2, 61, 63, 3],
  },
};

function stubMeteo(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    process.env.TRAILCAM_FORECAST_URL = `http://127.0.0.1:${server.address().port}/v1/forecast`;
    t.after(() => {
      delete process.env.TRAILCAM_FORECAST_URL;
      return new Promise(r => server.close(r));
    });
    resolve(hits);
  }));
}

const answer = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function serving(t, seed) {
  const out = tmp();
  const db = openDb(out);
  if (seed) seed(db);
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return { out, get: p => fetch(base + p) };
}

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

test('the shaped forecast keeps every hour, adds the sky words, drops nothing it needs', () => {
  const s = shapeForecast(RAW);
  assert.equal(s.time.length, 5);
  assert.equal(s.utcOffsetSeconds, -18000);
  assert.equal(s.time[0], '2026-08-29T15:00', 'local strings pass through unparsed');
  assert.equal(s.temp[2], 66, 'whole degrees — the strip has no room for decimals');
  assert.equal(s.dir[3], 344);
  assert.equal(s.precip[3], 0.11);
  assert.deepEqual(s.sky, ['mostly clear', 'partly cloudy', 'light rain', 'rain', 'overcast'],
    'the WMO table rides along as words — the page never sees a bare code');
});

test('the WMO words cover the codes that matter and refuse the rest', () => {
  assert.equal(wmoWord(0), 'clear');
  assert.equal(wmoWord(75), 'heavy snow');
  assert.equal(wmoWord(95), 'thunderstorm');
  assert.equal(wmoWord(42), null, 'an unknown code is no word, not a guess');
});

test('a forecast without hourly data is refused, not shaped', async () => {
  await assert.rejects(
    fetchForecast(44.12, -90.65, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ hourly: {} }) }),
    }), /missing hourly/);
  await assert.rejects(fetchForecast(NaN, -90.65), /latitude and longitude/);
});

// ---------------------------------------------------------------------------
// The API: fresh, cached, stale-but-said-so
// ---------------------------------------------------------------------------

test('the forecast is fetched once and served from cache inside the TTL', async t => {
  const hits = await stubMeteo(t, (req, res) => answer(res, RAW));
  const { get } = await serving(t);

  const first = await (await get('/api/forecast?lat=44.126&lng=-90.651')).json();
  assert.equal(first.time.length, 5);
  assert.equal(first.stale, false);
  assert.equal(first.cached, false);
  assert.equal(hits.length, 1);

  const second = await (await get('/api/forecast?lat=44.126&lng=-90.651')).json();
  assert.equal(second.cached, true, 'the second ask is the cache');
  assert.equal(hits.length, 1, 'and the service was not asked again');

  // A pan of a few hundred metres rounds to the same key — the forecast does
  // not know where the property line is.
  await (await get('/api/forecast?lat=44.128&lng=-90.653')).json();
  assert.equal(hits.length, 1);
});

test('with the service down, the cached forecast is served and SAYS it is old', async t => {
  await stubMeteo(t, (req, res) => { res.writeHead(502); res.end('bad gateway'); });
  const { out, get } = await serving(t);

  // A forecast fetched "yesterday", planted straight into the cache.
  const db = openDb(out);
  saveForecast(db, 44.126, -90.651, shapeForecast(RAW));
  db.prepare('UPDATE forecasts SET fetched_at = ?')
    .run(new Date(Date.now() - 20 * 3600000).toISOString());
  db.close();

  const res = await (await get('/api/forecast?lat=44.126&lng=-90.651')).json();
  assert.equal(res.stale, true);
  assert.match(res.note, /unreachable/, 'the age is said out loud');
  assert.equal(res.time.length, 5, 'and the old numbers still answer');
});

test('no cache and no service is an error, never an invented forecast', async t => {
  await stubMeteo(t, (req, res) => { res.writeHead(500); res.end('down'); });
  const { get } = await serving(t);
  const res = await get('/api/forecast?lat=44.126&lng=-90.651');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no forecast/);
});

test('the location defaults to your own ground, and no ground is a 400', async t => {
  const hits = await stubMeteo(t, (req, res) => answer(res, RAW));
  const { get } = await serving(t, db => {
    createStand(db, { name: 'Oak Ridge', lat: 44.126, lng: -90.651 });
  });
  const res = await (await get('/api/forecast')).json();
  assert.equal(res.time.length, 5);
  assert.ok(hits[0].includes('latitude=44.126'), 'asked at the stand, not at 0,0');

  const bare = await serving(t);
  assert.equal((await bare.get('/api/forecast')).status, 400,
    'nowhere to forecast for is the caller\'s problem to fix, not 0,0\'s');
});

test('the forecast cache rounds its key the way the climatology does', () => {
  const db = openDb(tmp());
  saveForecast(db, 44.1261, -90.6512, { time: ['x'] });
  assert.ok(cachedForecast(db, 44.1338, -90.6488), 'a nearby point shares the row');
  assert.equal(cachedForecast(db, 45.5, -92.1), null, 'a different ground does not');
  db.close();
});
