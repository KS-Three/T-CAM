/**
 * The denominator: whether a camera was actually watching on a given day.
 *
 * Everything here exists to stop one specific lie — counting a day when the
 * camera could not report as a day the deer did not come.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dayState, dayOf, cameraDayRow, summarise, summaryLine, SILENT_AFTER_H,
} from '../camera-days.mjs';
import { openDb, upsertCamera, recordCameraDay, cameraDays } from '../db.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-camdays-'));
const NOW = Date.parse('2026-08-31T12:00:00Z');

const cam = over => ({
  id: 'spypoint:abc', lastSeen: '2026-08-31T09:00:00Z',
  photoCount: 10, photoLimit: 100,
  cycleStart: '2026-08-01T00:00:00.000Z', cycleEnd: '2026-08-31T23:59:59.999Z',
  battery: 90, signal: 80, ...over,
});

// ---------------------------------------------------------------------------
// What state a camera is in
// ---------------------------------------------------------------------------

test('a camera in contact with allowance left is live', () => {
  assert.equal(dayState(cam(), NOW), 'live');
});

test('a camera that has spent its quota is dark, not live', () => {
  // It is still reporting battery and signal, still taking pictures, and can
  // no longer send one. An empty day from it says nothing about deer.
  assert.equal(dayState(cam({ photoCount: 100 }), NOW), 'quota-dark');
  assert.equal(dayState(cam({ photoCount: 137 }), NOW), 'quota-dark');
});

test('a camera out of contact is silent, whatever the reason', () => {
  const old = new Date(NOW - (SILENT_AFTER_H + 1) * 3600 * 1000).toISOString();
  assert.equal(dayState(cam({ lastSeen: old }), NOW), 'silent');
  // Just inside the window is still live: cameras check in on their own
  // schedule and a quiet night is not a fault.
  const recent = new Date(NOW - (SILENT_AFTER_H - 1) * 3600 * 1000).toISOString();
  assert.equal(dayState(cam({ lastSeen: recent }), NOW), 'live');
});

test('silence beats quota-dark when a camera is both', () => {
  // The stronger fact, and the one that would still be true if the allowance
  // reset tomorrow.
  const old = new Date(NOW - 96 * 3600 * 1000).toISOString();
  assert.equal(dayState(cam({ photoCount: 100, lastSeen: old }), NOW), 'silent');
});

test('a camera that has never reported is unknown, never live', () => {
  for (const lastSeen of [null, undefined, '', 'soon']) {
    assert.equal(dayState(cam({ lastSeen }), NOW), 'unknown', JSON.stringify(lastSeen));
  }
  assert.equal(dayState(null, NOW), 'unknown');
  assert.equal(dayState(undefined, NOW), 'unknown');
});

test('an unmetered plan is live, not permanently dark', () => {
  // photoLimit 0 or null means no limit known - it must not read as a spent
  // allowance, which would silently remove the camera from every denominator.
  for (const photoLimit of [0, null, undefined]) {
    assert.equal(dayState(cam({ photoLimit, photoCount: 9000 }), NOW), 'live',
      String(photoLimit));
  }
});

test('a row carries the evidence the state was read from', () => {
  const r = cameraDayRow(cam({ photoCount: 100 }), { now: NOW, photos: 3 });
  assert.equal(r.day, '2026-08-31');
  assert.equal(r.state, 'quota-dark');
  assert.equal(r.photos, 3);
  assert.equal(r.photoCount, 100);
  assert.equal(r.photoLimit, 100);
  assert.equal(r.battery, 90);
  assert.equal(r.observedAt, '2026-08-31T12:00:00.000Z');
});

test('dayOf refuses an unreadable timestamp rather than inventing a day', () => {
  assert.equal(dayOf('2026-08-31T12:00:00Z'), '2026-08-31');
  assert.equal(dayOf('whenever'), null);
  assert.equal(dayOf(null), null);
});

// ---------------------------------------------------------------------------
// A gap is not a live day
// ---------------------------------------------------------------------------

test('days with no row are counted as unknown, not quietly dropped', () => {
  // THE point of the module. The sync only writes on days it runs; if the
  // laptop was off for a week those days are not evidence of an empty trail.
  const rows = [
    { day: '2026-08-25', state: 'live' },
    { day: '2026-08-26', state: 'live' },
    { day: '2026-08-27', state: 'quota-dark' },
    { day: '2026-08-29', state: 'silent' },
    { day: '2026-08-31', state: 'live' },
  ];
  const s = summarise(rows, { from: '2026-08-25', to: '2026-08-31' });
  assert.equal(s.span, 7);
  assert.equal(s.live, 3);
  assert.equal(s.quotaDark, 1);
  assert.equal(s.silent, 1);
  assert.equal(s.unknown, 2, 'the 28th and the 30th were never recorded');
  assert.equal(s.live + s.quotaDark + s.silent + s.unknown, s.span,
    'every day in the span is accounted for exactly once');
  assert.equal(summaryLine(s),
    '3 of 7 days usable — 1 quota-dark, 1 silent, 2 never recorded');
});

test('an empty log over a real span is seven unknowns, not seven live days', () => {
  const s = summarise([], { from: '2026-08-25', to: '2026-08-31' });
  assert.equal(s.live, 0);
  assert.equal(s.unknown, 7);
  assert.equal(summaryLine(s), '0 of 7 days usable — 7 never recorded');
});

test('with no span asked for, only recorded days are reported', () => {
  const s = summarise([{ day: '2026-08-25', state: 'live' }]);
  assert.equal(s.span, 1);
  assert.equal(s.live, 1);
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const provided = over => ({
  id: 'abc', name: 'East Side', model: 'FLEX-M', lat: 44.12, lng: -90.65,
  gpsFix: null, battery: 90, batteryLevel: 'high', batterySource: 'AA',
  signal: 80, signalBars: 3, signalLevel: 'medium', signalType: 'LTE',
  tempValue: 60, tempUnit: 'F', memUsed: 100, memSize: 1000,
  plan: 'Free', photoCount: 10, photoLimit: 100,
  cycleStart: '2026-08-01T00:00:00.000Z', cycleEnd: '2026-08-31T23:59:59.999Z',
  lastSeen: '2026-08-31T09:00:00Z', ...over,
});

test('a day is written once and updated in place', () => {
  const out = tmp();
  const db = openDb(out);
  const stored = upsertCamera(db, provided(), { provider: 'spypoint' });

  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id },
    { now: NOW, photos: 0 }));
  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id },
    { now: NOW, photos: 12 }));

  const days = cameraDays(db, stored.id);
  assert.equal(days.length, 1, 'one row for one day, not two');
  assert.equal(days[0].photos, 12);
  db.close();
});

test('a later empty sync cannot erase photos that already arrived', () => {
  // The sync records the day twice - once before fetching, once after - and
  // runs many times a day. Whichever order they land in, the count only rises.
  const out = tmp();
  const db = openDb(out);
  const stored = upsertCamera(db, provided(), { provider: 'spypoint' });
  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id }, { now: NOW, photos: 12 }));
  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id }, { now: NOW, photos: 0 }));
  assert.equal(cameraDays(db, stored.id)[0].photos, 12);
  db.close();
});

test('a camera that goes dark during the day ends the day dark', () => {
  // State takes the LATEST reading, unlike the photo count: a camera live at
  // 08:00 and out of quota by 16:00 spent that day going dark.
  const out = tmp();
  const db = openDb(out);
  const stored = upsertCamera(db, provided(), { provider: 'spypoint' });
  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id }, { now: NOW }));
  assert.equal(cameraDays(db, stored.id)[0].state, 'live');
  recordCameraDay(db, cameraDayRow({ ...provided({ photoCount: 100 }), id: stored.id },
    { now: NOW + 8 * 3600 * 1000 }));
  assert.equal(cameraDays(db, stored.id)[0].state, 'quota-dark');
  db.close();
});

test('days come back in order, and can be asked for by span', () => {
  const out = tmp();
  const db = openDb(out);
  const stored = upsertCamera(db, provided(), { provider: 'spypoint' });
  for (const d of [2, 0, 1]) {
    recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id },
      { now: NOW - d * 86400000 }));
  }
  assert.deepEqual(cameraDays(db, stored.id).map(r => r.day),
    ['2026-08-29', '2026-08-30', '2026-08-31']);
  assert.deepEqual(
    cameraDays(db, stored.id, { from: '2026-08-30', to: '2026-08-30' }).map(r => r.day),
    ['2026-08-30']);
  db.close();
});

test('the log and the summary agree end to end', () => {
  const out = tmp();
  const db = openDb(out);
  const stored = upsertCamera(db, provided(), { provider: 'spypoint' });
  // Three days recorded out of a five-day span, one of them quota-dark.
  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id },
    { now: Date.parse('2026-08-27T12:00:00Z') }));
  recordCameraDay(db, cameraDayRow({ ...provided({ photoCount: 100 }), id: stored.id },
    { now: Date.parse('2026-08-28T12:00:00Z') }));
  recordCameraDay(db, cameraDayRow({ ...provided(), id: stored.id },
    { now: Date.parse('2026-08-31T12:00:00Z') }));

  const s = summarise(cameraDays(db, stored.id), { from: '2026-08-27', to: '2026-08-31' });
  assert.equal(s.live, 2);
  assert.equal(s.quotaDark, 1);
  assert.equal(s.unknown, 2, 'the 29th and 30th, when the sync did not run');
  assert.equal(summaryLine(s), '2 of 5 days usable — 1 quota-dark, 2 never recorded');
  db.close();
});
