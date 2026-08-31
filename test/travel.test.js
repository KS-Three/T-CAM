/**
 * Which way the animal crossed the frame, read out of the fingerprints that
 * were already stored.
 *
 * The synthetic bursts below are built by moving a dark blob across a textured
 * background and hashing each frame with the REAL dhashHex — so these exercise
 * the actual bit layout rather than a convenient stand-in for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dhashHex, HASH_W, HASH_H } from '../phash.mjs';
import {
  bitsOf, backgroundBits, columnChange, subjectColumn, trackVisit, headingFrom,
  updateVisitHeadings, COLS, MIN_FRAMES_SELF, MIN_DRIFT_COLS,
} from '../travel.mjs';
import { openDb, upsertCamera, upsertPhoto, setCameraView } from '../db.mjs';
import { viewFromBearing } from '../camera-view.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-travel-'));

/**
 * A frame with a dark blob centred on column `cx`, over textured background.
 * `cx = null` gives the bare background — an empty frame.
 */
function frame(cx) {
  const g = new Array(HASH_W * HASH_H);
  for (let r = 0; r < HASH_H; r++) {
    for (let c = 0; c < HASH_W; c++) {
      const near = cx !== null && Math.hypot(c - cx, r - HASH_H / 2) < 3;
      g[r * HASH_W + c] = near ? 20 : 200 + ((r * 7 + c * 13) % 9);
    }
  }
  return g;
}
const burst = (...centres) => centres.map(cx => dhashHex(frame(cx)));

/** An empty-frame background, so a difference shows only where the animal IS. */
const emptyBackground = () => backgroundBits(burst(null, null, null));

// ---------------------------------------------------------------------------
// The bits are laid out in space
// ---------------------------------------------------------------------------

test('a hash unpacks to 256 bits in the order dhashHex wrote them', () => {
  const bits = bitsOf(dhashHex(frame(8)));
  assert.equal(bits.length, COLS * HASH_H);
  assert.equal(bitsOf('not a hash'), null);
  assert.equal(bitsOf(null), null);
});

test('the column a change lands in is the column it happened in', () => {
  // The whole basis of the module: bit k belongs to column k % 16.
  // Against an EMPTY background, so the only difference is where the animal is.
  // Against a background that itself contains a blob, the vacated spot differs
  // just as loudly as the occupied one, and the peak means nothing.
  const bg = emptyBackground();
  const left = columnChange(bitsOf(dhashHex(frame(2))), bg);
  const right = columnChange(bitsOf(dhashHex(frame(13))), bg);
  const peak = cols => cols.indexOf(Math.max(...cols));
  assert.ok(peak(left) < 6, `a blob at column 2 changes the left of the frame (peak ${peak(left)})`);
  assert.ok(peak(right) > 9, `a blob at column 13 changes the right (peak ${peak(right)})`);
});

test('a subject centroid tracks the blob across the frame', () => {
  const bg = emptyBackground();
  const at = cx => subjectColumn(bitsOf(dhashHex(frame(cx))), bg)?.col;
  const a = at(2), b = at(14);
  assert.ok(a !== undefined && b !== undefined, 'both frames have a subject');
  assert.ok(a < b, `left blob sits left of right blob (${a} vs ${b})`);
});

test('an unchanged frame has no subject, rather than a centroid of noise', () => {
  const bg = emptyBackground();
  assert.equal(subjectColumn(bitsOf(dhashHex(frame(null))), bg), null);
});

// ---------------------------------------------------------------------------
// Reading a crossing
// ---------------------------------------------------------------------------

test('a deer walking left to right reads as crossing right, and back again', () => {
  const right = trackVisit(burst(2, 5, 8, 11, 14));
  assert.equal(right.crossing, 'right');
  assert.ok(right.drift > MIN_DRIFT_COLS);
  assert.equal(right.why, null);

  const left = trackVisit(burst(14, 11, 8, 5, 2));
  assert.equal(left.crossing, 'left');
  assert.ok(left.drift < -MIN_DRIFT_COLS);
});

test('an animal that does not cross is not given a direction', () => {
  // It may have been walking straight at the camera, which no arrangement of
  // these bits can see. Refused, with the reason said out loud.
  const t = trackVisit(burst(8, 8, 8, 8));
  assert.equal(t.crossing, null);
  assert.match(t.why, /did not cross|fewer than two frames/);
});

test('a single frame cannot show movement and says so', () => {
  const t = trackVisit(burst(5));
  assert.equal(t.crossing, null);
  assert.match(t.why, /single frame/);
});

test('two frames refuse without a baseline, and answer with one', () => {
  // XOR of two frames gives one blob where the animal was and another where it
  // went, with nothing to say which is which. A camera baseline breaks the tie.
  const two = burst(3, 12);
  const bare = trackVisit(two);
  assert.equal(bare.crossing, null);
  assert.match(bare.why, new RegExp(`${MIN_FRAMES_SELF} frames are needed`));

  const baseline = emptyBackground();   // the camera's reviewed-empty reference
  const withBase = trackVisit(two, { baseline });
  assert.equal(withBase.crossing, 'right', 'now it can tell where the animal was');
});

test('every refusal carries a reason, never a bare null', () => {
  for (const t of [trackVisit([]), trackVisit(burst(5)), trackVisit(burst(3, 12)),
    trackVisit(burst(8, 8, 8))]) {
    assert.equal(t.crossing, null);
    assert.ok(typeof t.why === 'string' && t.why.length > 10, t.why);
  }
});

// ---------------------------------------------------------------------------
// Turning a crossing into a compass bearing
// ---------------------------------------------------------------------------

test('rightward across a north-facing camera is east', () => {
  assert.equal(headingFrom(0, 'right'), 90);
  assert.equal(headingFrom(0, 'left'), 270);
  assert.equal(headingFrom(90, 'right'), 180);
  assert.equal(headingFrom(315, 'right'), 45, 'wraps past north');
  assert.equal(headingFrom(45, 'left'), 315, 'and back the other way');
});

test('no bearing without a facing, and none without a crossing', () => {
  assert.equal(headingFrom(null, 'right'), null);
  assert.equal(headingFrom(0, null), null);
  assert.equal(headingFrom(0, 'sideways'), null);
});

// ---------------------------------------------------------------------------
// Over the store
// ---------------------------------------------------------------------------

const CAM = { lat: 44.12, lng: -90.65 };
const provided = over => ({
  id: 'abc', name: 'East Side', model: 'FLEX-M', lat: CAM.lat, lng: CAM.lng,
  gpsFix: null, battery: 90, batteryLevel: 'high', batterySource: 'AA',
  signal: 80, signalBars: 3, signalLevel: 'medium', signalType: 'LTE',
  tempValue: 60, tempUnit: 'F', memUsed: 100, memSize: 1000,
  plan: 'Free', photoCount: 10, photoLimit: 100,
  cycleStart: null, cycleEnd: null, lastSeen: '2026-08-31T09:00:00Z', ...over,
});

// upsertPhoto prefixes the camera id itself, so it wants the NATIVE id while
// the visits table wants the stored one. Passing the stored id to both is a
// foreign-key failure with `spypoint:spypoint:abc` in it.
function storeWithBurst(db, camId, nativeCamId, centres) {
  const visitId = db.prepare(
    'INSERT INTO visits (camera_id, started_at, ended_at, photo_count) '
    + 'VALUES (?,?,?,?) RETURNING id')
    .get(camId, '2026-08-31T06:00:00Z', '2026-08-31T06:00:30Z', centres.length).id;
  centres.forEach((cx, i) => {
    const p = upsertPhoto(db, {
      provider: 'spypoint', cameraId: nativeCamId, nativeId: 'p' + i,
      takenAt: `2026-08-31T06:00:0${i}Z`, phash: dhashHex(frame(cx)),
    });
    db.prepare('UPDATE photos SET visit_id = ? WHERE id = ?').run(visitId, p.id);
  });
  return visitId;
}

test('a crossing is stored even when the camera has no facing', () => {
  // Two different claims. That the animal crossed is observable from the frames
  // alone; the compass bearing needs a pointed camera and waits for one.
  const db = openDb(tmp());
  const cam = upsertCamera(db, provided(), { provider: 'spypoint' });
  storeWithBurst(db, cam.id, 'abc', [2, 5, 8, 11, 14]);

  const r = updateVisitHeadings(db);
  assert.equal(r.of, 1);
  assert.equal(r.crossings, 1);
  assert.equal(r.noBearing, 1);

  const v = db.prepare('SELECT * FROM visits').get();
  assert.equal(v.crossing, 'right');
  assert.equal(v.heading_deg, null);
  assert.equal(v.heading_frames, 5);
  assert.match(v.heading_note, /no facing set/);
  db.close();
});

test('pointing the camera afterwards gives every past visit its bearing', () => {
  // Which is why it recomputes everything rather than only new visits: a
  // heading left over from an old bearing is worse than none.
  const db = openDb(tmp());
  const cam = upsertCamera(db, provided(), { provider: 'spypoint' });
  storeWithBurst(db, cam.id, 'abc', [2, 5, 8, 11, 14]);
  updateVisitHeadings(db);

  setCameraView(db, cam.id, viewFromBearing(CAM, 0, 30));   // pointed north
  const r = updateVisitHeadings(db);
  assert.equal(r.noBearing, 0);

  const v = db.prepare('SELECT * FROM visits').get();
  assert.equal(v.crossing, 'right');
  assert.equal(Math.round(v.heading_deg), 90, 'rightward across a north camera is east');
  assert.equal(v.heading_note, null);
  db.close();
});

test('re-pointing a camera moves the headings with it', () => {
  const db = openDb(tmp());
  const cam = upsertCamera(db, provided(), { provider: 'spypoint' });
  storeWithBurst(db, cam.id, 'abc', [2, 5, 8, 11, 14]);
  setCameraView(db, cam.id, viewFromBearing(CAM, 0, 30));
  updateVisitHeadings(db);
  assert.equal(Math.round(db.prepare('SELECT heading_deg h FROM visits').get().h), 90);

  setCameraView(db, cam.id, viewFromBearing(CAM, 180, 30));  // turned around
  updateVisitHeadings(db);
  assert.equal(Math.round(db.prepare('SELECT heading_deg h FROM visits').get().h), 270,
    'the same crossing now points the other way');
  db.close();
});

test('a visit that cannot be read stores the reason, not a silent null', () => {
  const db = openDb(tmp());
  const cam = upsertCamera(db, provided(), { provider: 'spypoint' });
  storeWithBurst(db, cam.id, 'abc', [7, 7]);          // two frames, no baseline

  updateVisitHeadings(db);
  const v = db.prepare('SELECT * FROM visits').get();
  assert.equal(v.crossing, null);
  assert.equal(v.heading_deg, null);
  assert.ok(v.heading_note && v.heading_note.length > 10, v.heading_note);
  db.close();
});
