import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compassOf, climatology, standCoverage, fetchArchive, SEASON_MONTHS, COMPASS,
} from '../wind-history.mjs';
import { openDb, saveWindClimatology, windClimatology, createStand } from '../db.mjs';
import { createServer } from '../serve.mjs';

/**
 * A synthetic year: every day of the given months, hourly, with a wind
 * direction chosen per hour so the expected answer is arithmetic.
 */
function fakeYear({ year = 2024, months = [11], dirAt = () => 270 } = {}) {
  const hourly = { time: [], wind_direction_10m: [], wind_speed_10m: [], temperature_2m: [] };
  const daily = { time: [], sunrise: [], sunset: [] };
  for (const m of months) {
    for (let d = 1; d <= 28; d++) {
      const date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      daily.time.push(date);
      daily.sunrise.push(`${date}T07:00`);
      daily.sunset.push(`${date}T17:00`);
      for (let h = 0; h < 24; h++) {
        const t = `${date}T${String(h).padStart(2, '0')}:00`;
        hourly.time.push(t);
        hourly.wind_direction_10m.push(dirAt(h, m, d));
        hourly.wind_speed_10m.push(12);
        hourly.temperature_2m.push(5);
      }
    }
  }
  return { hourly, daily };
}

test('compass points map from degrees, and wrap correctly', () => {
  assert.equal(compassOf(0), 'N');
  assert.equal(compassOf(360), 'N');
  assert.equal(compassOf(359), 'N', 'just short of north is still north');
  assert.equal(compassOf(90), 'E');
  assert.equal(compassOf(180), 'S');
  assert.equal(compassOf(270), 'W');
  assert.equal(compassOf(315), 'NW');
  assert.equal(COMPASS.length, 16);
});

test('only the hours you would actually be sitting are counted', () => {
  // The window is anchored to sunrise and sunset, not a fixed clock: sunrise
  // moves by well over an hour across a season, so a fixed window would weight
  // late-season evenings wrongly.
  //
  // Sunrise 07:00, sunset 17:00 here, so AM is 05:30-10:30 and PM 13:30-17:30 —
  // 6 whole hours in AM (6,7,8,9,10 plus 6? ) and 4 in PM by hour granularity.
  const c = climatology([fakeYear({ dirAt: h => (h < 12 ? 0 : 180) })], { months: [11] });
  assert.ok(c.hours > 0);
  assert.equal(c.days, 28);
  // Midday and midnight winds must not appear at all: only N (morning) and
  // S (evening) were ever blown during the windows.
  assert.ok(c.byPoint.N > 0 && c.byPoint.S > 0);
  assert.equal(c.byPoint.E, 0);
  assert.equal(c.byWindow.AM.S, 0, 'no evening wind leaks into the morning');
  assert.equal(c.byWindow.PM.N, 0, 'and none the other way');
});

test('months outside the season are ignored', () => {
  const july = climatology([fakeYear({ months: [7] })], { months: SEASON_MONTHS });
  assert.equal(july.hours, 0, 'July is not deer season');
  const nov = climatology([fakeYear({ months: [11] })], { months: SEASON_MONTHS });
  assert.ok(nov.hours > 0);
});

test('frequencies are percentages that account for everything', () => {
  const c = climatology([fakeYear({ dirAt: h => (h < 12 ? 270 : 90) })], { months: [11] });
  const total = Object.values(c.byPoint).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `percentages sum to ${total}`);
  assert.ok(c.ranked[0].pct >= c.ranked[1].pct, 'ranked really is ranked');
});

test('several years are pooled', () => {
  const one = climatology([fakeYear({ year: 2023 })], { months: [11] });
  const two = climatology([fakeYear({ year: 2023 }), fakeYear({ year: 2024 })], { months: [11] });
  assert.equal(two.hours, one.hours * 2);
  assert.equal(two.years, 2);
  assert.equal(two.byPoint.W, one.byPoint.W, 'pooling does not change the shape');
});

// ---------------------------------------------------------------------------
// What it is worth to a stand
// ---------------------------------------------------------------------------

const clim = {
  byPoint: { N: 5, NNE: 0, NE: 0, ENE: 0, E: 0, ESE: 0, SE: 0, SSE: 0,
    S: 20, SSW: 10, SW: 15, WSW: 0, W: 30, WNW: 20, NW: 0, NNW: 0 },
  byWindow: {
    AM: { N: 10, S: 20, SSW: 10, SW: 15, W: 25, WNW: 20 },
    PM: { N: 0, S: 20, SSW: 10, SW: 15, W: 35, WNW: 20 },
  },
  ranked: [
    { point: 'W', pct: 30 }, { point: 'S', pct: 20 }, { point: 'WNW', pct: 20 },
    { point: 'SW', pct: 15 }, { point: 'SSW', pct: 10 }, { point: 'N', pct: 5 },
  ],
};

test('a stand is worth the sum of the winds it can be hunted on', () => {
  const cov = standCoverage([{ id: 1, name: 'West', winds: ['W', 'WNW'] }], clim);
  assert.equal(cov.stands[0].pct, 50, '30 + 20');
  assert.equal(cov.stands[0].amPct, 45);
  assert.equal(cov.stands[0].pmPct, 55, 'and morning and evening differ, which is a real fact');
});

test('a stand with no recorded winds is unknown, not zero percent', () => {
  // The same rule as everywhere: "I have not told it" and "it never works" are
  // different, and only one of them is the stand's fault.
  const cov = standCoverage([{ id: 1, name: 'Untold', winds: [] }], clim);
  assert.equal(cov.stands[0].pct, null);
  assert.equal(cov.unsetStands, 1);
  assert.equal(cov.seasonCovered, null, 'nothing can be claimed about coverage yet');
});

test('the gaps are the commonest winds no stand covers', () => {
  const cov = standCoverage([{ id: 1, name: 'West', winds: ['W', 'WNW'] }], clim);
  assert.equal(cov.gaps[0].point, 'S', 'the biggest uncovered wind comes first');
  assert.equal(cov.gaps[0].pct, 20);
  assert.ok(!cov.gaps.some(g => g.point === 'W'), 'a covered wind is not a gap');
  assert.ok(!cov.gaps.some(g => g.pct === 0), 'a wind that never blows is not a gap either');
});

test('season coverage counts each wind once, not once per stand', () => {
  // Two stands on the same wind do not cover twice as much season.
  const cov = standCoverage([
    { id: 1, name: 'A', winds: ['W'] },
    { id: 2, name: 'B', winds: ['W'] },
  ], clim);
  assert.equal(cov.seasonCovered, 30, 'both cover W; the season is still 30% covered');
});

test('stands are ranked by how much of the season they cover', () => {
  const cov = standCoverage([
    { id: 1, name: 'Small', winds: ['N'] },
    { id: 2, name: 'Big', winds: ['W', 'S'] },
    { id: 3, name: 'Untold', winds: [] },
  ], clim);
  assert.deepEqual(cov.stands.map(s => s.name), ['Big', 'Small', 'Untold'],
    'and the unranked one sorts last rather than first');
});

test('good_winds as a stored string works as well as an array', () => {
  const cov = standCoverage([{ id: 1, name: 'From db', good_winds: 'W,WNW' }], clim);
  assert.equal(cov.stands[0].pct, 50);
});

// ---------------------------------------------------------------------------
// Fetching and caching
// ---------------------------------------------------------------------------

async function fakeArchiveServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(handler ? handler(calls.length) : fakeYear()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_ARCHIVE_URL = `http://127.0.0.1:${server.address().port}/archive`;
  return { server, calls };
}

test('the archive is fetched one year at a time', async t => {
  // One multi-year request of hourly data is a large, slow response, and a
  // failure loses the lot.
  const { server, calls } = await fakeArchiveServer();
  t.after(() => { server.close(); delete process.env.TRAILCAM_ARCHIVE_URL; });
  const years = await fetchArchive(44.12, -90.65, { years: 3, endYear: 2024 });
  assert.equal(years.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.some(u => u.includes('2022')) && calls.some(u => u.includes('2024')));
  assert.ok(calls.every(u => u.includes('sunrise')), 'sunrise is needed to place the windows');
});

test('bad coordinates are refused before any request', async t => {
  const { server, calls } = await fakeArchiveServer();
  t.after(() => { server.close(); delete process.env.TRAILCAM_ARCHIVE_URL; });
  await assert.rejects(() => fetchArchive(NaN, -90.65), /needs a latitude and longitude/);
  assert.equal(calls.length, 0);
});

test('a climatology survives the round trip through the database', () => {
  const db = openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-wind-')));
  const data = climatology([fakeYear()], { months: [11] });
  saveWindClimatology(db, 44.125683, -90.651735, [11], 7, data);

  const back = windClimatology(db, 44.125683, -90.651735, [11], 7);
  assert.equal(back.hours, data.hours);
  assert.equal(back.cached, true);
  // Rounded to about a kilometre: everything on one property shares a wind
  // climate, and keying finer would refetch history to answer the same question.
  assert.ok(windClimatology(db, 44.1258, -90.6517, [11], 7), 'a nearby point is the same cache entry');
  assert.equal(windClimatology(db, 44.5, -90.6, [11], 7), null, 'a different place is not');
  assert.equal(windClimatology(db, 44.125683, -90.651735, [11], 3), null, 'nor a different span');
  db.close();
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

test('the API answers with the rose and what it is worth to each stand', async t => {
  const { server: arch, calls } = await fakeArchiveServer();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-wind-http-'));
  const db = openDb(out);
  createStand(db, { name: 'West ridge', lat: 44.125, lng: -90.651, goodWinds: ['W', 'WNW'] });
  createStand(db, { name: 'Untold', lat: 44.126, lng: -90.652 });
  db.close();

  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    arch.close();
    delete process.env.TRAILCAM_ARCHIVE_URL;
    return new Promise(r => server.close(r));
  });

  const body = await (await fetch(`${base}/api/wind-history?years=2`)).json();
  assert.equal(body.cached, false, 'the first ask is a real fetch');
  assert.ok(body.hours > 0);
  assert.equal(body.ranked.length, 16);
  assert.equal(body.coverage.unsetStands, 1);
  assert.ok(body.coverage.stands.some(s => s.pct !== null));

  const before = calls.length;
  const again = await (await fetch(`${base}/api/wind-history?years=2`)).json();
  assert.equal(again.cached, true, 'the second is served from the database');
  assert.equal(calls.length, before, 'and does not touch the archive again');
});

test('with nowhere to ask about, it says so rather than guessing', async t => {
  const { server: arch, calls } = await fakeArchiveServer();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-wind-empty-'));
  openDb(out).close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    arch.close();
    delete process.env.TRAILCAM_ARCHIVE_URL;
    return new Promise(r => server.close(r));
  });
  const res = await fetch(`${base}/api/wind-history`);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no location yet/);
  assert.equal(calls.length, 0, 'and asks the archive nothing');
});
