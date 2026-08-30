import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraSummary, fmtLoc, fmtPct, daysSince, photoDate, photoUrl, healthOf, dashboardHtml,
} from '../spypoint-sync.mjs';
import { FLEX_M, LEGACY_SHAPE, PHOTO } from '../fixtures/cameras.js';

test('location comes out as [longitude, latitude], not transposed', () => {
  const r = cameraSummary(FLEX_M);
  // SpyPoint sends a GeoJSON Point, whose array is [lng, lat]. Reading it the
  // other way round puts a Wisconsin camera in Asia — and a map renders that
  // without complaint, so only an assertion catches it.
  assert.equal(r.lat, 44.123456);
  assert.equal(r.lng, -90.654321);

  // The DMS strings on the same object are the independent check: converting
  // them must reproduce the numbers above, latitude to lat and longitude to lng.
  const dms = s => {
    const [, hemi, deg, min] = s.match(/^([NSEW])(\d+) ([\d.]+)$/);
    const v = Number(deg) + Number(min) / 60;
    return 'SW'.includes(hemi) ? -v : v;
  };
  const src = FLEX_M.status.coordinates[0];
  assert.ok(Math.abs(dms(src.latitude) - r.lat) < 1e-9, 'DMS latitude agrees');
  assert.ok(Math.abs(dms(src.longitude) - r.lng) < 1e-9, 'DMS longitude agrees');

  assert.equal(fmtLoc(r), '44.123456,-90.654321');
  assert.equal(r.gpsFix, '2025-11-28T15:00:42.000Z');
});

test('a moved camera reports its NEWEST fix, whatever order they arrive in', () => {
  // The bug this pins, reported from the field 2026-08-30: one camera's
  // position "did not update". status.coordinates is an ARRAY of fixes, and
  // the code took [0] — a guess about ordering that held only because every
  // fixture and every camera so far carried exactly one. Move a camera and it
  // carries several; with the old fix first, the pin stays on ground the
  // camera has left while its battery, signal and photos all update around
  // it. Nothing is malformed, so nothing complains.
  const moved = { ...FLEX_M, status: { ...FLEX_M.status, coordinates: [
    { dateTime: '2025-11-28T15:00:42.000Z',
      position: { type: 'Point', coordinates: [-90.654321, 44.123456] } },
    { dateTime: '2026-08-20T11:30:00.000Z',
      position: { type: 'Point', coordinates: [-90.640000, 44.130000] } },
  ] } };
  const r = cameraSummary(moved);
  assert.equal(r.lat, 44.130000, 'the newer fix wins even though it is last');
  assert.equal(r.lng, -90.640000);
  assert.equal(r.gpsFix, '2026-08-20T11:30:00.000Z', 'and the date matches it');

  // Order must not decide the answer: the same two fixes the other way round.
  const flipped = cameraSummary({ ...moved,
    status: { ...moved.status, coordinates: [...moved.status.coordinates].reverse() } });
  assert.deepEqual([flipped.lat, flipped.lng, flipped.gpsFix],
    [r.lat, r.lng, r.gpsFix], 'newest-wins, not first-wins or last-wins');

  // An undated fix loses to a dated one but is never dropped: one undated
  // entry is still the only answer there is.
  const undated = cameraSummary({ ...FLEX_M, status: { ...FLEX_M.status,
    coordinates: [{ position: { type: 'Point', coordinates: [-90.66, 44.11] } }] } });
  assert.equal(undated.lat, 44.11, 'a lone undated fix is still used');
  const mixed = cameraSummary({ ...FLEX_M, status: { ...FLEX_M.status, coordinates: [
    { position: { type: 'Point', coordinates: [-90.66, 44.11] } },
    { dateTime: '2026-08-20T11:30:00.000Z',
      position: { type: 'Point', coordinates: [-90.64, 44.13] } },
  ] } });
  assert.equal(mixed.lat, 44.13, 'but a dated fix beats an undated one');
});

test('signal is read from the nested object, not hunted for as a number', () => {
  // Regression: status.signal is an OBJECT, so a "first number named signal"
  // search matched nothing and every camera reported an unknown signal.
  const r = cameraSummary(FLEX_M);
  assert.equal(r.signal, 100);
  assert.equal(r.signalBars, 4);
  assert.equal(r.signalLevel, 'high');
  assert.equal(r.signalType, 'LTE');
});

test('battery prefers powerSources over the bare batteries array', () => {
  const r = cameraSummary(FLEX_M);
  assert.equal(r.battery, 20);
  assert.equal(r.batteryLevel, 'medium');
  assert.equal(r.batterySource, 'AA');
});

test('remaining camera fields are picked up', () => {
  const r = cameraSummary(FLEX_M);
  assert.equal(r.name, 'North Ridge');
  assert.equal(r.model, 'FLEX-M');
  assert.equal(r.tempValue, 26);
  assert.equal(r.tempUnit, 'F');
  assert.equal(r.memUsed, 1758);
  assert.equal(r.memSize, 1871);
  assert.equal(r.plan, 'Free');
  assert.equal(r.photoCount, 0);
  assert.equal(r.photoLimit, 100);
  assert.equal(r.lastSeen, '2025-11-28T15:00:42.000Z');
});

test('a differently shaped camera still resolves through the fallbacks', () => {
  const r = cameraSummary(LEGACY_SHAPE);
  assert.equal(r.lat, 45.5);
  assert.equal(r.lng, -91.25);
  assert.equal(r.battery, 55);
  assert.equal(r.model, 'FORCE-20');
  assert.equal(r.signal, null, 'absent data reports null rather than throwing');
});

test('malformed camera documents never throw', () => {
  for (const bad of [{}, { status: null }, { status: { coordinates: [] } },
    { status: { coordinates: [{ position: {} }] } }, { config: {} }]) {
    const r = cameraSummary(bad);
    assert.equal(r.lat, null);
    assert.equal(r.lng, null);
    assert.equal(r.signal, null);
    assert.equal(fmtLoc(r), '?');
  }
});

test('daysSince handles real, missing and unparseable dates', () => {
  assert.equal(daysSince(null), null);
  assert.equal(daysSince('not a date'), null);
  assert.equal(daysSince(new Date().toISOString()), 0);
  const tenDays = new Date(Date.now() - 10 * 86400000).toISOString();
  assert.equal(daysSince(tenDays), 10);
});

test('health escalates on staleness and low battery, keeping the worst', () => {
  const fresh = new Date().toISOString();
  assert.equal(healthOf({ lastSeen: fresh, battery: 90 }).level, 'ok');
  assert.equal(healthOf({ lastSeen: fresh, battery: 25 }).level, 'warn');
  assert.equal(healthOf({ lastSeen: fresh, battery: 5 }).level, 'bad');

  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const stale = healthOf({ lastSeen: old, battery: 100 });
  assert.equal(stale.level, 'bad', 'silent for 200 days is bad even on a full battery');
  assert.match(stale.notes.join(' '), /silent 200 days/);

  // A camera both stale AND flat must not be downgraded to merely "warn".
  assert.equal(healthOf({ lastSeen: old, battery: 5 }).level, 'bad');
  assert.equal(healthOf({ lastSeen: null, battery: null }).level, 'warn');
});

test('photo helpers read dates and build URLs, with size fallback', () => {
  assert.equal(photoDate(PHOTO), '2025-11-27T22:14:03.000Z');
  assert.equal(photoDate({}), null);
  assert.equal(photoUrl(PHOTO, 'large'), 'https://example-cdn.invalid/lg/photo.jpg');
  assert.equal(photoUrl(PHOTO, 'small'), 'https://example-cdn.invalid/sm/photo.jpg');
  assert.equal(photoUrl({ small: { host: 'h', path: 'p' } }, 'large'), 'https://h/p',
    'falls back down the size list');
  assert.equal(photoUrl({}, 'large'), null);
});

test('fmtPct only formats real numbers', () => {
  assert.equal(fmtPct(42), '42%');
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(null), '?');
  assert.equal(fmtPct(NaN), '?');
});

test('dashboard renders and cannot be broken out of by camera names', () => {
  const rows = [cameraSummary(FLEX_M), cameraSummary(LEGACY_SHAPE)];
  const html = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /North Ridge/);

  // Camera names are user-controlled, so a name containing markup must be
  // escaped in the embedded JSON rather than closing the script element.
  const nasty = cameraSummary({
    ...FLEX_M,
    config: { ...FLEX_M.config, name: '</script><script>alert(1)</script>' },
  });
  const out = dashboardHtml([nasty], [], '2026-08-27T12:00:00.000Z');
  const scripts = out.match(/<\/script>/gi) ?? [];
  assert.equal(scripts.length, out.match(/<script/gi).length,
    'every </script> pairs with a real <script>; none injected via a camera name');
  assert.ok(!out.includes('<script>alert(1)</script>'), 'injected markup did not survive raw');
});
