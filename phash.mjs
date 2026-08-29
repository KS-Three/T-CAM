/**
 * phash.mjs — a photo's fingerprint, and what "looks like wind" means.
 *
 * Most of what a trail camera sends is nothing: a branch moved, the sun came
 * out, grass leaned into the detector. SpyPoint's AI tags deer and people but
 * stays silent on empty frames, so "probably nothing here" is the one
 * recognition this program has to do itself — and it can, without a vision
 * model, because an empty frame looks like the OTHER empty frames from the
 * same camera. The person's own review supplies the ground truth: visits they
 * marked "nothing here" become that camera's empty baseline, and a new frame
 * within a few bits of it probably is too.
 *
 * The fingerprint is dHash: shrink to 17×16 grayscale, keep one bit per
 * horizontal neighbour pair — is the left pixel darker than the right — for a
 * 256-bit gradient signature. It survives exposure and small colour shifts
 * (brightening a whole frame flips no gradients) which is exactly the noise
 * between two empty daylight frames; an animal in frame rewrites a region's
 * gradients. Night IR frames simply match other night frames — the baseline
 * holds both, and the nearest neighbour is what counts.
 *
 * Why 17×16 and not the classic 9×8: measured, in the browser drive. At 9×8
 * an animal-sized blob covering 15% of the frame moved TWO bits of 64 — well
 * inside any usable noise gate, so a deer frame matched the empty baseline
 * and would have been suggested away. At 17×16 the same blob rewrites
 * dozens of bits of 256 while pure exposure drift still moves none.
 *
 * WHO COMPUTES IT: the browser. Hashing needs pixels, pixels need a JPEG
 * decoder, and a JPEG decoder in dependency-free Node is a project of its
 * own — while every browser ships one. The review screen already loads every
 * frame at full size, so it downsamples on a canvas, hashes with the copy of
 * these functions the page carries, and posts the hash back. The server
 * stores and compares; it never decodes an image.
 *
 * Hashes are prefixed 'd1:' so a future algorithm cannot be compared against
 * this one by accident — cross-algorithm distances are noise wearing numbers.
 */

/** 17×16 — sixteen comparisons per row, sixteen rows: 256 bits. */
export const HASH_W = 17;
export const HASH_H = 16;
export const HASH_BITS = (HASH_W - 1) * HASH_H;

/**
 * Within this many bits of a reviewed-empty frame, a frame "looks like wind".
 * Pure exposure drift moves zero bits; an animal in frame moves dozens (see
 * the header). Twelve of 256 is under five percent, deliberately tight: the
 * cost of a miss is one more frame reviewed by hand, the cost of a false
 * match is a deer suggested away — so the gate leans toward silence.
 */
export const WIND_BITS = 12;

/**
 * How many reviewed-empty frames a camera needs before "looks like your
 * empty frames" means anything. One match against one frame is a coincidence
 * with a percentage attached.
 */
export const WIND_MIN_BASELINE = 3;

/** Flat RGBA (canvas getImageData.data) to grayscale, ITU-R BT.601 luma. */
export function lumaFromRGBA(data) {
  const n = Math.floor(data.length / 4);
  const gray = new Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

/**
 * dHash of a 17×16 row-major grayscale array, as 'd1:' + 64 hex chars.
 * Bit set = this pixel is darker than its right-hand neighbour.
 */
export function dhashHex(gray) {
  if (!gray || gray.length !== HASH_W * HASH_H) {
    throw new Error(`dhash wants ${HASH_W}x${HASH_H} = ${HASH_W * HASH_H} grayscale values, got ${gray ? gray.length : 'nothing'}`);
  }
  let hex = '';
  let nibble = 0, bits = 0;
  for (let r = 0; r < HASH_H; r++) {
    for (let c = 0; c < HASH_W - 1; c++) {
      nibble = (nibble << 1) | (gray[r * HASH_W + c] < gray[r * HASH_W + c + 1] ? 1 : 0);
      if (++bits === 4) { hex += nibble.toString(16); nibble = 0; bits = 0; }
    }
  }
  return 'd1:' + hex;
}

/** Is this a hash the current algorithm produced? */
export const isHash = h => typeof h === 'string' && /^d1:[0-9a-f]{64}$/.test(h);

/**
 * Bits of difference between two hashes, 0..256 — or null when either is
 * missing or from another algorithm, because a distance between two different
 * kinds of fingerprint is not a distance.
 */
export function hamming(a, b) {
  if (!isHash(a) || !isHash(b)) return null;
  let d = 0;
  for (let i = 3; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * The nearest reviewed-empty frame: { bits, of } — the best match and how
 * many baseline frames were behind it — or null when the baseline is too
 * small to mean anything or nothing lands within WIND_BITS.
 */
export function windMatch(hash, baseline) {
  const usable = (baseline || []).filter(isHash);
  if (!isHash(hash) || usable.length < WIND_MIN_BASELINE) return null;
  let best = Infinity;
  for (const b of usable) {
    const d = hamming(hash, b);
    if (d !== null && d < best) best = d;
  }
  return best <= WIND_BITS ? { bits: best, of: usable.length } : null;
}

/**
 * The same functions, as source, for the review page — the one-definition
 * rule (see measure.mjs). The browser computes hashes; if its copy drifted
 * from the server's comparisons, every stored fingerprint would quietly stop
 * matching anything.
 */
export function browserSource(globalName = 'PHASH') {
  const consts = { HASH_W, HASH_H, HASH_BITS, WIND_BITS, WIND_MIN_BASELINE };
  const fns = { lumaFromRGBA, dhashHex, isHash, hamming, windMatch };
  const body = [
    ...Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`),
    ...Object.entries(fns).map(([k, f]) => `const ${k} = ${f.toString()};`),
    `return { ${Object.keys(fns).join(', ')}, HASH_W, HASH_H, HASH_BITS, WIND_BITS, WIND_MIN_BASELINE };`,
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
