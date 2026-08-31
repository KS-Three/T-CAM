/**
 * travel.mjs — which way the animal was walking, from frames you already have.
 *
 * A camera's bearing says which ground it photographs. It does NOT say which
 * way a deer in that photograph was going: east, west, toward and away are all
 * consistent with one bearing. What separates them is where the animal sits
 * from FRAME TO FRAME across a burst.
 *
 * ## It reads the stored hashes, not the pictures
 *
 * Every photo already carries a dHash: 17x16 grayscale, one bit per horizontal
 * neighbour pair, 256 bits (see phash.mjs). Bit k compares column k%16 against
 * its right-hand neighbour in row floor(k/16) — so the bits are LAID OUT IN
 * SPACE, and XORing two hashes says not merely how much changed but *where
 * across the frame* it changed.
 *
 * That means direction can be read from what is in the database today, with no
 * new image decoding, nothing extra posted from the browser, and no second
 * downsample to drift out of step with the first.
 *
 * ## What it can and cannot see
 *
 * Sixteen columns is coarse. It is ample for the SIGN of a movement — a deer
 * crossing a frame moves through several columns — and useless for speed or
 * for small shifts, so nothing here reports either.
 *
 * It reads the CROSSING component only: movement perpendicular to where the
 * camera looks. A deer walking straight at the camera grows without crossing,
 * and is correctly reported as no crossing rather than guessed at. The heading
 * this produces is therefore "it crossed left-to-right", turned into a compass
 * bearing — not a full travel vector, and it says so.
 *
 * ## Why three frames
 *
 * Finding the animal needs a background to subtract. With three or more frames
 * the background is the bitwise MAJORITY of the burst: whatever most frames
 * agree on is the scene, and what a frame disagrees with is what moved through
 * it. With two frames there is no majority — XOR gives one blob where the
 * animal was and another where it went, with nothing to say which is which —
 * so two frames yield a direction only when the camera has a reviewed-empty
 * baseline to use instead. Otherwise: unknown, stated plainly.
 */

import { HASH_H, isHash } from './phash.mjs';
import { cameraView } from './camera-view.mjs';

/** Comparisons per row — the column count the bits are laid out in. */
export const COLS = 16;

/**
 * How many bits a frame must differ from its background by before it is
 * treated as containing anything. Below this the "subject" is exposure drift
 * and a centroid computed from it is a number about noise.
 */
export const MIN_SUBJECT_BITS = 12;

/**
 * How far the subject must travel across the frame, in columns, before a
 * crossing is called. One column is inside the jitter of a coarse grid; this
 * is deliberately more than a deer standing still and swinging its head.
 */
export const MIN_DRIFT_COLS = 1.5;

/** Fewest frames that can carry their own background. */
export const MIN_FRAMES_SELF = 3;

/** The 256 bits of a hash, most significant first — the order dhashHex wrote. */
export function bitsOf(hash) {
  if (!isHash(hash)) return null;
  const bits = new Uint8Array(COLS * HASH_H);
  for (let k = 0; k < bits.length; k++) {
    const nib = parseInt(hash[3 + (k >> 2)], 16);
    bits[k] = (nib >> (3 - (k & 3))) & 1;
  }
  return bits;
}

/**
 * The background of a burst: whatever most of its frames agree on.
 *
 * Majority vote per bit. An animal occupies a different part of the frame in
 * each shot, so it loses every vote it is in a minority for, and what survives
 * is the scene. Needs an odd-ish crowd to mean much, hence MIN_FRAMES_SELF.
 */
export function backgroundBits(hashes) {
  const all = (hashes ?? []).map(bitsOf).filter(Boolean);
  if (all.length < MIN_FRAMES_SELF) return null;
  const out = new Uint8Array(COLS * HASH_H);
  for (let k = 0; k < out.length; k++) {
    let ones = 0;
    for (const b of all) ones += b[k];
    out[k] = ones * 2 > all.length ? 1 : 0;
  }
  return out;
}

/**
 * Where in the frame this shot differs from its background, per column.
 *
 * Returns 16 counts — how many of the sixteen rows changed in that column.
 */
export function columnChange(bits, background) {
  if (!bits || !background) return null;
  const cols = new Array(COLS).fill(0);
  for (let k = 0; k < bits.length; k++) {
    if (bits[k] !== background[k]) cols[k % COLS]++;
  }
  return cols;
}

/**
 * The horizontal centre of whatever moved, 0 (frame left) to 15 (frame right).
 *
 * Null when too little changed to be talking about an animal at all — which is
 * the honest answer for an empty frame, and stops a centroid of pure noise
 * entering the average as though it were a sighting.
 */
export function subjectColumn(bits, background) {
  const cols = columnChange(bits, background);
  if (!cols) return null;
  const total = cols.reduce((a, b) => a + b, 0);
  if (total < MIN_SUBJECT_BITS) return null;
  let sum = 0;
  for (let c = 0; c < COLS; c++) sum += c * cols[c];
  return { col: sum / total, bits: total };
}

/**
 * Track one burst: where the subject sat in each frame, and whether it crossed.
 *
 * `hashes` must be in time order. `baseline` is an optional camera background
 * (a reviewed-empty frame's bits), which is what lets a two-frame burst answer
 * at all.
 *
 * Never guesses. Every refusal comes back with `why`, because "no direction"
 * and "direction unknown for this reason" are different things to a reader.
 */
export function trackVisit(hashes, { baseline = null } = {}) {
  const list = (hashes ?? []).filter(isHash);
  const none = why => ({ crossing: null, drift: null, columns: [], frames: list.length, why });

  if (list.length < 2) return none('a single frame cannot show movement');

  const background = baseline ?? backgroundBits(list);
  if (!background) {
    return none(`${list.length} frames and no empty baseline for this camera `
      + `— ${MIN_FRAMES_SELF} frames are needed to supply their own background`);
  }

  const columns = [];
  for (const h of list) {
    const s = subjectColumn(bitsOf(h), background);
    if (s) columns.push(s.col);
  }
  if (columns.length < 2) {
    return { ...none('fewer than two frames contain a subject'), columns };
  }

  // First half against second half, rather than first frame against last: one
  // frame where the animal is half out of shot drags a two-point comparison
  // hard, and a burst is short enough that halves are still "before" and
  // "after".
  const mid = Math.floor(columns.length / 2);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const from = mean(columns.slice(0, mid || 1));
  const to = mean(columns.slice(mid));
  const drift = to - from;

  if (Math.abs(drift) < MIN_DRIFT_COLS) {
    return {
      crossing: null, drift, columns, frames: list.length,
      why: 'the subject did not cross the frame — it may have been walking '
        + 'toward or away from the camera, which this cannot see',
    };
  }
  return {
    crossing: drift > 0 ? 'right' : 'left',
    drift, columns, frames: list.length, why: null,
  };
}

/**
 * The compass bearing a crossing implies, given where the camera looks.
 *
 * A camera looking along bearing B photographs the ground in front of it; in
 * the resulting picture, rightward is B + 90 and leftward is B - 90. So a deer
 * crossing left-to-right in front of a north-facing camera is heading east.
 *
 * This is the CROSSING component and nothing more. The animal may also have
 * been closing or opening the range, which no arrangement of these bits can
 * show, so the result is a bearing across the camera's view rather than a
 * claim about where the deer was going in the end.
 */
export function headingFrom(facingDeg, crossing) {
  if (!Number.isFinite(facingDeg) || (crossing !== 'left' && crossing !== 'right')) {
    return null;
  }
  const deg = crossing === 'right' ? facingDeg + 90 : facingDeg - 90;
  return ((deg % 360) + 360) % 360;
}

/**
 * Read every visit's crossing out of the fingerprints already stored, and
 * record it.
 *
 * Takes the database handle rather than living in db.mjs, which cannot import
 * the geometry: routes.mjs already imports distanceM FROM db.mjs, so the
 * bearing maths and the store would form a cycle. This module is the one place
 * that can see both.
 *
 * Recomputes every visit by default. Pointing a camera changes the heading of
 * every visit it ever recorded, and the alternative is a compass bearing that
 * quietly still belongs to the old bearing.
 */
export function updateVisitHeadings(db, { only = null } = {}) {
  const visits = only
    ? db.prepare('SELECT id, camera_id FROM visits WHERE id = ?').all(only)
    : db.prepare('SELECT id, camera_id FROM visits').all();

  const frames = db.prepare(
    'SELECT phash FROM photos WHERE visit_id = ? AND phash IS NOT NULL ORDER BY taken_at, id');
  const getCam = db.prepare('SELECT lat, lng, view FROM cameras WHERE id = ?');
  const save = db.prepare('UPDATE visits SET crossing = ?, heading_deg = ?, '
    + 'heading_frames = ?, heading_note = ? WHERE id = ?');

  const cams = new Map();
  let read = 0, noBearing = 0;

  for (const v of visits) {
    const hashes = frames.all(v.id).map(r => r.phash);
    const t = trackVisit(hashes);

    let deg = null;
    if (t.crossing) {
      if (!cams.has(v.camera_id)) cams.set(v.camera_id, getCam.get(v.camera_id) ?? null);
      const c = cams.get(v.camera_id);
      const facing = c ? cameraView({ lat: c.lat, lng: c.lng, view: c.view }) : null;
      if (facing) deg = headingFrom(facing.bearingDeg, t.crossing);
      else noBearing++;
    }

    // A crossing with no camera bearing keeps its note: the reader is told the
    // animal crossed and that the camera has not been pointed, rather than
    // being handed a blank where a compass word should be.
    const note = t.why
      ?? (t.crossing && deg === null ? 'crossed the frame, but this camera has no facing set' : null);
    save.run(t.crossing, deg, hashes.length, note, v.id);
    if (t.crossing) read++;
  }
  return { of: visits.length, crossings: read, noBearing };
}
