/**
 * The journal over HTTP — the round trip that matters most being that the
 * prediction goes in frozen and comes back unedited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-sitsapi-'));

async function serving(t, seed = () => {}) {
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
  return { json, made, base };
}

test('a sit round-trips, prediction and outcome kept apart', async t => {
  const { json, made } = await serving(t, db =>
    createStand(db, { name: 'Creek ladder', lat: 44.12, lng: -90.65 }));
  const res = await json('POST', '/api/sits', {
    standId: made.id, date: '2026-11-07', window: 'PM',
    predicted: { score: 52, rating: 'prime', windFrom: 'NW', temp: 33 },
    windFrom: 'NNW', deer: 4, bucks: 1, shot: true, notes: 'off the point',
  });
  assert.equal(res.status, 201);
  const sit = await res.json();
  assert.equal(sit.predicted.rating, 'prime');
  assert.equal(sit.predicted.windFrom, 'NW');
  assert.equal(sit.wind_from, 'NNW');
  assert.equal(sit.stand_name, 'Creek ladder');

  const listed = await (await json('GET', '/api/sits')).json();
  assert.equal(listed.sits.length, 1);
  assert.equal(listed.summary.deer, 4);
  assert.equal(listed.calibration.verdict, 'not enough sits');
});

test('the recorded prediction cannot be rewritten through the API', async t => {
  const { json } = await serving(t);
  const sit = await (await json('POST', '/api/sits', {
    date: '2026-11-07', window: 'PM', predicted: { rating: 'poor', score: 10 }, deer: 0,
  })).json();
  const patched = await (await json('PATCH', `/api/sits/${sit.id}`, {
    deer: 6, predicted: { rating: 'prime' }, predicted_rating: 'prime', predicted_score: 99,
  })).json();
  assert.equal(patched.deer, 6, 'the outcome is editable');
  assert.equal(patched.predicted.rating, 'poor', 'the prediction is not');
  assert.equal(patched.predicted.score, 10);
});

test('a blank count stays blank through the API, not zeroed', async t => {
  const { json } = await serving(t);
  const sit = await (await json('POST', '/api/sits', {
    date: '2026-11-07', window: 'PM', deer: null, bucks: '',
  })).json();
  assert.equal(sit.deer, null);
  assert.equal(sit.bucks, null);
  const body = await (await json('GET', '/api/sits')).json();
  assert.equal(body.summary.counted, 0);
  assert.equal(body.summary.uncounted, 1);
  assert.equal(body.summary.deerPerSit, null, 'no average is invented from nothing');
});

test('bad input is a 400 naming the problem, not a 500', async t => {
  const { json } = await serving(t);
  for (const [body, pattern] of [
    [{ date: 'nope', window: 'PM' }, /YYYY-MM-DD/],
    [{ date: '2026-11-07', window: 'dusk' }, /window must be/],
    [{ date: '2026-11-07', window: 'PM', standId: 404 }, /no stand with id/],
  ]) {
    const res = await json('POST', '/api/sits', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, pattern);
  }
  assert.equal((await (await json('GET', '/api/sits')).json()).sits.length, 0);
});

test('a missing sit is a 404 on every verb', async t => {
  const { json } = await serving(t);
  for (const method of ['GET', 'DELETE']) {
    assert.equal((await json(method, '/api/sits/999')).status, 404);
  }
  assert.equal((await json('PATCH', '/api/sits/999', { deer: 1 })).status, 404);
});

test('a sit can be deleted', async t => {
  const { json } = await serving(t);
  const sit = await (await json('POST', '/api/sits', { date: '2026-11-07', window: 'PM', deer: 1 })).json();
  assert.equal((await json('DELETE', `/api/sits/${sit.id}`)).status, 200);
  assert.equal((await (await json('GET', '/api/sits')).json()).sits.length, 0);
});

test('the whole season analysis comes back with the listing', async t => {
  const { json, made } = await serving(t, db =>
    createStand(db, { name: 'Creek', lat: 44.12, lng: -90.65 }));
  const plan = [['poor', 0], ['poor', 1], ['poor', 0], ['fair', 1], ['fair', 2], ['fair', 1],
    ['good', 2], ['good', 3], ['good', 2], ['prime', 4], ['prime', 5], ['prime', 3]];
  let d = 0;
  for (const [rating, deer] of plan) {
    await json('POST', '/api/sits', {
      standId: made.id, date: `2026-11-${String(++d).padStart(2, '0')}`, window: 'PM',
      predicted: { rating, score: 20 + d * 3, windFrom: 'NW' },
      windFrom: d % 3 ? 'NW' : 'NNW', deer,
    });
  }
  const body = await (await json('GET', '/api/sits')).json();
  assert.equal(body.summary.sits, 12);
  assert.ok(body.calibration.rho > 0.6, `expected a positive rho, got ${body.calibration.rho}`);
  assert.ok(body.calibration.p <= 0.05);
  assert.match(body.calibration.caveat, /You choose which days to hunt/);
  assert.equal(body.wind.sits, 12);
  assert.equal(body.stands.stands.length, 1);
  assert.equal(body.stands.stands[0].enough, true);
});

test('the journal page is served', async t => {
  const { json } = await serving(t);
  const res = await json('GET', '/journal');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sit journal/);
  assert.match(html, /api\/sits/);
});
