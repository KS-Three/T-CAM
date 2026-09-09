import test from 'node:test';
import assert from 'node:assert/strict';
import { counterOf } from '../card-gap.mjs';

// ---------------------------------------------------------------------------
// Reading the camera's own file number
// ---------------------------------------------------------------------------

test('a FLEX-M file name yields its counter', () => {
  assert.equal(counterOf('PICT0431.JPG'), 431);
});

test('a FLEX-M2 file name, which is bare digits, yields its counter', () => {
  assert.equal(counterOf('1392.jpg'), 1392);
});

test('a name with no digits is not a counter', () => {
  assert.equal(counterOf('photo.jpg'), null);
  assert.equal(counterOf(''), null);
  assert.equal(counterOf(null), null);
  assert.equal(counterOf(undefined), null);
});

test('digits in the extension or a directory do not leak into the counter', () => {
  assert.equal(counterOf('100SPYPT/PICT0007.JPG'), 7);
  assert.equal(counterOf('PICT0007.mp4'), 7);
});

// ---------------------------------------------------------------------------
// Counting what never arrived
// ---------------------------------------------------------------------------

import { cardGapOf, cardGapLine, RECENT_DAYS, RESET_JUMP } from '../card-gap.mjs';

// Mid-day UTC throughout, so the calendar day is the same in every timezone
// the tests might run in.
const at = (day, hour = 12) =>
  `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const pict = (n, takenAt) => ({ originName: `PICT${String(n).padStart(4, '0')}.JPG`, takenAt });
const NOW = Date.parse(at(10));

test('consecutive numbers mean nothing was held back', () => {
  const g = cardGapOf([pict(1, at(1)), pict(2, at(1, 13)), pict(3, at(2))], NOW);
  assert.equal(g.counted, 3);
  assert.equal(g.missing, 0);
  assert.deepEqual(g.gaps, []);
  assert.equal(g.resets, 0);
  assert.equal(g.level, 'ok');
  assert.equal(g.note, null);
});

test('one absent number is one photo on the card, between its neighbours', () => {
  const g = cardGapOf([pict(2, at(1)), pict(4, at(2))], NOW);
  assert.equal(g.missing, 1);
  assert.equal(g.gaps.length, 1);
  assert.deepEqual(g.gaps[0], {
    afterN: 2, afterAt: at(1), beforeN: 4, beforeAt: at(2), missing: 1,
  });
});

test('a contiguous block is one gap with the block\'s size and window', () => {
  // The Fremont North shape: PICT1303 arrived, then nothing until PICT1378.
  const g = cardGapOf([pict(1302, at(1)), pict(1303, at(1, 19)), pict(1378, at(2, 23)), pict(1379, at(3))], NOW);
  assert.equal(g.missing, 74);
  assert.equal(g.gaps.length, 1);
  assert.equal(g.gaps[0].afterAt, at(1, 19));
  assert.equal(g.gaps[0].beforeAt, at(2, 23));
});

test('a counter that restarts is a reset, not sixteen hundred missing photos', () => {
  // A formatted card, or the counter wrapping at 9999: the number falls off a
  // cliff. Nothing between the old high and the new low was ever taken.
  const g = cardGapOf([pict(1706, at(1)), pict(1707, at(2)), pict(1, at(6)), pict(2, at(6, 13))], NOW);
  assert.equal(g.missing, 0);
  assert.equal(g.resets, 1);
  assert.ok(RESET_JUMP < 1706);
});

test('a small step backwards in time is the same run out of order', () => {
  // A FLEX-M2 at activation: 1375..1377, 1379, then 1374 stamped hours later,
  // then 1380 onward. Only 1378 is actually missing.
  const g = cardGapOf([
    pict(1375, at(7, 16)), pict(1376, at(7, 16)), pict(1377, at(7, 16)),
    pict(1379, at(7, 17)), pict(1374, at(7, 21)), pict(1380, at(8, 6)),
  ], NOW);
  assert.equal(g.missing, 1);
  assert.equal(g.resets, 0);
  assert.equal(g.gaps[0].afterN, 1377);
  assert.equal(g.gaps[0].beforeN, 1379);
});

test('a photo with no counter or no time cannot be placed and is skipped', () => {
  const g = cardGapOf([
    { originName: null, takenAt: at(1) },
    { originName: 'PICT0001.JPG', takenAt: null },
    pict(2, at(2)), pict(3, at(3)),
  ], NOW);
  assert.equal(g.counted, 2);
  assert.equal(g.skipped, 2);
  assert.equal(g.missing, 0);
});

test('an old gap is still reported but no longer raises a flag', () => {
  const old = cardGapOf([pict(1, at(1)), pict(5, at(2))], NOW + 40 * 86400000);
  assert.equal(old.missing, 3);
  assert.equal(old.recent, 0);
  assert.equal(old.level, 'ok');
  assert.ok(old.note, 'the number is still on the card; the note still says so');

  const fresh = cardGapOf([pict(1, at(1)), pict(5, at(2))], NOW);
  assert.equal(fresh.recent, 3);
  assert.equal(fresh.level, 'warn');
  assert.ok(RECENT_DAYS >= 14);
});

test('the note says how many, and when', () => {
  const g = cardGapOf([pict(401, at(3)), pict(430, at(8))], NOW);
  assert.equal(g.note, '28 photos on the card never sent, 9/3 to 9/8');
  const one = cardGapOf([pict(1, at(7)), pict(3, at(7, 13))], NOW);
  assert.equal(one.note, '1 photo on the card never sent, 9/7');
});

test('gaps are newest first, and the note counts them', () => {
  const g = cardGapOf([pict(1, at(1)), pict(3, at(2)), pict(4, at(3)), pict(5, at(5)), pict(9, at(8))], NOW);
  assert.equal(g.gaps.length, 2);
  assert.equal(g.gaps[0].afterN, 5, 'the later gap leads');
  assert.equal(g.missing, 4);
  assert.match(g.note, /^4 photos on the card never sent, 9\/5 to 9\/8, in 2 gaps$/);
});

test('the terminal line carries the count and the window, and is silent when there is nothing', () => {
  assert.equal(cardGapLine(cardGapOf([pict(1, at(1)), pict(2, at(2))], NOW)), null);
  assert.equal(cardGapLine(cardGapOf([pict(401, at(3)), pict(430, at(8))], NOW)),
    '28 photos, 9/3 to 9/8');
  assert.equal(cardGapLine(cardGapOf([pict(1, at(1)), pict(3, at(2)), pict(4, at(3)), pict(5, at(5)), pict(9, at(8))], NOW)),
    '4 photos, 9/5 to 9/8, in 2 gaps');
});

// ---------------------------------------------------------------------------
// From the database, and onto the camera's health
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertCamera, upsertPhoto, originCounters } from '../db.mjs';
import { cardGapsByCamera } from '../card-gap.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';
import { cameraSummary, healthOf } from '../spypoint-sync.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-cardgap-'));
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);
const CAM = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // FLEX_M's native id
const photo = (db, nativeId, takenAt, originName) => upsertPhoto(db, {
  provider: 'spypoint', cameraId: CAM, nativeId, takenAt,
  raw: originName === undefined ? null : { originName },
});

test('originCounters reads each camera\'s file names out of the raw documents, in time order', () => {
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  photo(db, 'p3', at(3), 'PICT0003.JPG');
  photo(db, 'p1', at(1), 'PICT0001.JPG');
  photo(db, 'px', at(2));               // no raw document at all
  const byCam = originCounters(db);
  assert.deepEqual(Object.keys(byCam), [`spypoint:${CAM}`]);
  assert.deepEqual(byCam[`spypoint:${CAM}`], [
    { takenAt: at(1), originName: 'PICT0001.JPG' },
    { takenAt: at(2), originName: null },
    { takenAt: at(3), originName: 'PICT0003.JPG' },
  ]);
  db.close();
});

test('cardGapsByCamera keys one result per camera by its database id', () => {
  const db = openDb(tmp());
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  photo(db, 'p1', at(1), 'PICT0001.JPG');
  photo(db, 'p3', at(3), 'PICT0003.JPG');
  const gaps = cardGapsByCamera(db, NOW);
  const g = gaps[`spypoint:${CAM}`];
  assert.equal(g.missing, 1);
  assert.equal(g.skipped, 0);
  assert.equal(g.level, 'warn');
  db.close();
});

test('a recent hole on the card reaches the camera\'s health, an old one does not', () => {
  const row = cameraSummary(FLEX_M);
  const fresh = healthOf({ ...row, cardGap: cardGapOf([pict(401, at(3)), pict(430, at(8))], NOW) }, NOW);
  assert.notEqual(fresh.level, 'ok');
  assert.ok(fresh.notes.includes('28 photos on the card never sent, 9/3 to 9/8'),
    `notes were: ${fresh.notes.join(' | ')}`);

  const old = healthOf({ ...row, cardGap: cardGapOf([pict(401, at(3)), pict(430, at(8))], NOW + 60 * 86400000) }, NOW);
  assert.ok(!old.notes.some(n => /on the card/.test(n)), 'an old hole is history, not an alert');

  const none = healthOf(row, NOW);
  assert.ok(!none.notes.some(n => /on the card/.test(n)), 'no reading, no claim');
});

// ---------------------------------------------------------------------------
// Where it shows
// ---------------------------------------------------------------------------

import { dashboardHtml } from '../dashboard-page.mjs';
import { buildState } from '../serve.mjs';

test('the reading carries its window, so a card can show it without redoing the dates', () => {
  const g = cardGapOf([pict(1, at(1)), pict(3, at(2)), pict(4, at(3)), pict(5, at(5)), pict(9, at(8))], NOW);
  assert.equal(g.window, '9/5 to 9/8, in 2 gaps');
  assert.equal(cardGapOf([pict(1, at(1)), pict(2, at(2))], NOW).window, null);
});

test('the camera card has a Never sent line, and says what it means', () => {
  const html = dashboardHtml([cameraSummary(FLEX_M)], [], '2026-09-08T12:00:00.000Z');
  assert.match(html, /line\('Never sent'/, 'the card line is emitted');
  assert.match(html, /Only the card has them/, 'and it explains itself on hover');
});

test('the served page\'s cameras carry the reading, keyed like the database', async () => {
  const dir = tmp();
  const db = openDb(dir);
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  photo(db, 'p1', at(1), 'PICT0001.JPG');
  photo(db, 'p3', at(3), 'PICT0003.JPG');
  const state = await buildState(db, dir);
  assert.equal(state.cameras.length, 1);
  assert.equal(state.cameras[0].cardGap.missing, 1);
  db.close();
});
