/**
 * cog.mjs — reading pixels out of a Cloud-Optimized GeoTIFF, with no library.
 *
 * This module exists because a decision written elsewhere in this repo turned
 * out to rest on a false premise. `terrain.mjs` says "decoding GeoTIFF or LERC
 * would mean a dependency, and this project has none", and `cropscan.mjs` says
 * much the same. That was right about LERC — it is a bespoke codec — but wrong
 * about the GeoTIFFs that actually matter here. Sentinel-2's public COGs are
 * classic TIFF with **Deflate** compression (tag 259 = 8) and the horizontal
 * differencing predictor (tag 317 = 2), and Node ships zlib. Probed against
 * the live bucket, 2026-08-31:
 *
 *     10980x10980, uint16, 1 sample/pixel, tiled 1024x1024, 121 tiles
 *     compression 8 (Adobe Deflate), predictor 2
 *
 * So the cost is arithmetic, not a dependency, and zero-dependencies survives.
 * See docs/design.md for the entry that revisits this.
 *
 * What "cloud optimized" buys us is the only reason this is affordable: the
 * tile index sits in the header, so a field of a few acres costs one HTTP
 * range request for the header, one for the index, and one per tile actually
 * overlapped — not the 120 MB the full image would be.
 *
 * DELIBERATE LIMITS. This reads exactly the flavour of TIFF that Sentinel-2
 * publishes and refuses everything else loudly, because a reader that guesses
 * at a format it half-understands returns plausible wrong numbers rather than
 * an error:
 *
 *   - classic TIFF only (BigTIFF is detected and refused by name)
 *   - tiled only, not stripped
 *   - one sample per pixel, 8/16/32-bit unsigned integer
 *   - Deflate (8 or 32946) or uncompressed (1)
 *   - predictor 1 (none) or 2 (horizontal differencing)
 *
 * Every one of those is checked. An unsupported file throws saying which
 * feature it wanted, so the failure names itself instead of arriving later as
 * a strange NDVI.
 */

import { inflateSync } from 'node:zlib';

/** TIFF tags this reader understands. Anything else in the IFD is ignored. */
const TAG = {
  width: 256, height: 257, bitsPerSample: 258, compression: 259,
  stripOffsets: 273, samplesPerPixel: 277, predictor: 317,
  tileWidth: 322, tileHeight: 323, tileOffsets: 324, tileByteCounts: 325,
  sampleFormat: 339, pixelScale: 33550, tiePoint: 33922,
};

/** Bytes per TIFF field type, indexed by the type code. */
const TYPE_BYTES = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
  16: 8, 17: 8, 18: 8,
};

const DEFLATE = new Set([8, 32946]);   // Adobe Deflate and the older zlib code
const NO_COMPRESSION = 1;

/** How much of the front of the file to ask for when opening. The header and
 *  a classic IFD live well inside this, so opening costs one request. */
export const HEADER_BYTES = 16384;

/**
 * Fetch a byte range. Servers may legally answer a range request with the
 * whole file (200 instead of 206), so the caller must not assume the response
 * starts at `start` — `readRange` slices when that happens rather than
 * silently reading from the wrong offset, which is the kind of bug that shows
 * up as one wrong pixel in ten thousand.
 */
export async function readRange(url, start, end, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) {
    throw new Error(`range request answered HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status === 200 && buf.length > end - start + 1) {
    return buf.subarray(start, end + 1);
  }
  return buf;
}

/** Little/big-endian readers chosen once, at open, from the byte-order mark. */
function readers(littleEndian) {
  return littleEndian
    ? {
      u16: (b, o) => b.readUInt16LE(o), u32: (b, o) => b.readUInt32LE(o),
      f64: (b, o) => b.readDoubleLE(o),
    }
    : {
      u16: (b, o) => b.readUInt16BE(o), u32: (b, o) => b.readUInt32BE(o),
      f64: (b, o) => b.readDoubleBE(o),
    };
}

/**
 * Parse the header and first IFD. Returns everything needed to locate a pixel,
 * plus `entries` for anything a caller wants to inspect.
 *
 * `head` must contain the start of the file; if the IFD falls outside it a
 * second range request is made, which is why this takes the url and fetch.
 */
export async function readHeader(url, { fetchImpl = globalThis.fetch } = {}) {
  const head = await readRange(url, 0, HEADER_BYTES - 1, fetchImpl);
  if (head.length < 8) throw new Error('file is too short to be a TIFF');

  const mark = head.toString('ascii', 0, 2);
  if (mark !== 'II' && mark !== 'MM') {
    throw new Error(`not a TIFF: byte order mark is ${JSON.stringify(mark)}`);
  }
  const { u16, u32, f64 } = readers(mark === 'II');

  const magic = u16(head, 2);
  if (magic === 43) throw new Error('BigTIFF is not supported by this reader');
  if (magic !== 42) throw new Error(`not a TIFF: magic number ${magic}`);

  const ifdOffset = u32(head, 4);
  // Usually inside the block already fetched; only pay for a second request
  // when the writer put the IFD at the end of the file.
  let blk = head, base = ifdOffset;
  if (ifdOffset + 2 > head.length) {
    blk = await readRange(url, ifdOffset, ifdOffset + HEADER_BYTES - 1, fetchImpl);
    base = 0;
  }
  const count = u16(blk, base);
  const need = base + 2 + count * 12 + 4;
  if (need > blk.length) {
    blk = await readRange(url, ifdOffset, ifdOffset + need + 1024, fetchImpl);
    base = 0;
  }

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const o = base + 2 + i * 12;
    entries.set(u16(blk, o), {
      type: u16(blk, o + 2), count: u32(blk, o + 4), offset: o + 8,
      value: u32(blk, o + 8),
    });
  }

  /** Read a tag's values, following the offset when they don't fit inline. */
  const values = async (tag) => {
    const e = entries.get(tag);
    if (!e) return null;
    const size = TYPE_BYTES[e.type];
    if (!size) throw new Error(`tag ${tag} has unsupported field type ${e.type}`);
    const total = size * e.count;
    let buf, at;
    if (total <= 4) { buf = blk; at = e.offset; } else {
      buf = await readRange(url, e.value, e.value + total - 1, fetchImpl);
      at = 0;
    }
    const out = [];
    for (let i = 0; i < e.count; i++) {
      const o = at + i * size;
      if (e.type === 12) out.push(f64(buf, o));
      else if (e.type === 4) out.push(u32(buf, o));
      else if (e.type === 3) out.push(u16(buf, o));
      else if (e.type === 1) out.push(buf.readUInt8(o));
      else throw new Error(`tag ${tag} has unsupported field type ${e.type}`);
    }
    return out;
  };

  const one = async (tag, fallback = null) => {
    const v = await values(tag);
    return v === null ? fallback : v[0];
  };

  const width = await one(TAG.width);
  const height = await one(TAG.height);
  if (!width || !height) throw new Error('TIFF has no image dimensions');

  const tileWidth = await one(TAG.tileWidth);
  const tileHeight = await one(TAG.tileHeight);
  if (!tileWidth || !tileHeight) {
    throw new Error('only tiled TIFFs are supported; this one is stripped');
  }

  const samples = await one(TAG.samplesPerPixel, 1);
  if (samples !== 1) {
    throw new Error(`only single-band TIFFs are supported; this has ${samples}`);
  }

  const bits = await one(TAG.bitsPerSample, 8);
  if (![8, 16, 32].includes(bits)) {
    throw new Error(`unsupported bit depth ${bits}`);
  }
  const sampleFormat = await one(TAG.sampleFormat, 1);
  if (sampleFormat !== 1) {
    throw new Error(`only unsigned integer samples are supported (format ${sampleFormat})`);
  }

  const compression = await one(TAG.compression, NO_COMPRESSION);
  if (compression !== NO_COMPRESSION && !DEFLATE.has(compression)) {
    throw new Error(`unsupported compression ${compression}; only Deflate and none`);
  }

  const predictor = await one(TAG.predictor, 1);
  if (predictor !== 1 && predictor !== 2) {
    throw new Error(`unsupported predictor ${predictor}`);
  }

  const offsets = await values(TAG.tileOffsets);
  const byteCounts = await values(TAG.tileByteCounts);
  if (!offsets || !byteCounts) throw new Error('TIFF has no tile index');

  // GeoTIFF placement. PixelScale + TiePoint covers every north-up image,
  // which is all Sentinel-2 publishes; a rotated raster would need the
  // ModelTransformation tag and is refused above by having no origin.
  const scale = await values(TAG.pixelScale);
  const tie = await values(TAG.tiePoint);
  const geo = (scale && tie)
    ? { originX: tie[3], originY: tie[4], resX: scale[0], resY: scale[1] }
    : null;

  return {
    url, fetchImpl, width, height, tileWidth, tileHeight,
    bits, compression, predictor, offsets, byteCounts, geo, entries,
    tilesAcross: Math.ceil(width / tileWidth),
    tilesDown: Math.ceil(height / tileHeight),
  };
}

/**
 * Undo horizontal differencing, in place. Each sample was stored as the
 * difference from its left neighbour, so the row is a running sum. Wrapping
 * is deliberate: the encoder wrapped too, and masking to the sample width is
 * what makes the round trip exact.
 */
export function undoPredictor(samples, tileWidth, tileHeight, bits) {
  const mask = bits === 32 ? 0xffffffff : (bits === 16 ? 0xffff : 0xff);
  for (let r = 0; r < tileHeight; r++) {
    const row = r * tileWidth;
    for (let c = 1; c < tileWidth; c++) {
      samples[row + c] = (samples[row + c] + samples[row + c - 1]) & mask;
    }
  }
}

/** Wrap a decoded tile's bytes as the right typed array for its bit depth. */
function asSamples(buf, bits) {
  // The buffer from a pooled allocation may not start at zero, and typed
  // arrays need a correctly offset view rather than the whole pool.
  const { buffer, byteOffset, length } = buf;
  if (bits === 8) return new Uint8Array(buffer, byteOffset, length);
  if (bits === 16) return new Uint16Array(buffer, byteOffset, length / 2);
  return new Uint32Array(buffer, byteOffset, length / 4);
}

/**
 * Fetch and decode one tile by index. Tiles are cached on the header object
 * for the life of that object, because a field usually samples the same tile
 * many times and re-fetching a megabyte per pixel would be absurd.
 */
export async function readTile(header, index) {
  header._tiles ??= new Map();
  if (header._tiles.has(index)) return header._tiles.get(index);

  const start = header.offsets[index];
  const bytes = header.byteCounts[index];
  if (start === undefined || bytes === undefined) {
    throw new Error(`tile ${index} is outside the tile index`);
  }
  // A sparse COG marks an absent tile with zero length; that is empty ground,
  // not an error, and must read as zeroes rather than throw.
  let samples;
  if (bytes === 0) {
    samples = asSamples(Buffer.alloc(
      header.tileWidth * header.tileHeight * (header.bits / 8)), header.bits);
  } else {
    const raw = await readRange(header.url, start, start + bytes - 1, header.fetchImpl);
    const flat = DEFLATE.has(header.compression) ? inflateSync(raw) : raw;
    const expect = header.tileWidth * header.tileHeight * (header.bits / 8);
    if (flat.length < expect) {
      throw new Error(
        `tile ${index} decoded to ${flat.length} bytes, expected ${expect}`);
    }
    samples = asSamples(flat.subarray(0, expect), header.bits);
    if (header.predictor === 2) {
      undoPredictor(samples, header.tileWidth, header.tileHeight, header.bits);
    }
  }
  header._tiles.set(index, samples);
  return samples;
}

/** Image column/row for a projected coordinate, as integers. */
export function pixelFor(header, x, y) {
  if (!header.geo) throw new Error('TIFF carries no georeferencing');
  const { originX, originY, resX, resY } = header.geo;
  return {
    col: Math.floor((x - originX) / resX),
    row: Math.floor((originY - y) / resY),
  };
}

/** One sample at an image column/row, or null outside the image. */
export async function valueAtPixel(header, col, row) {
  if (col < 0 || row < 0 || col >= header.width || row >= header.height) return null;
  const tile = Math.floor(row / header.tileHeight) * header.tilesAcross
             + Math.floor(col / header.tileWidth);
  const samples = await readTile(header, tile);
  return samples[(row % header.tileHeight) * header.tileWidth + (col % header.tileWidth)];
}

/** One sample at a projected coordinate, or null outside the image. */
export async function valueAt(header, x, y) {
  const { col, row } = pixelFor(header, x, y);
  return valueAtPixel(header, col, row);
}

/**
 * Every sample inside a projected bounding box, plus the grid that describes
 * it. Reads whole tiles, so a box spanning a tile edge costs both — which is
 * the honest price of the format and why callers should keep boxes small.
 */
export async function readBox(header, { minX, minY, maxX, maxY }) {
  const a = pixelFor(header, minX, maxY);          // top-left
  const b = pixelFor(header, maxX, minY);          // bottom-right
  const col0 = Math.max(0, Math.min(a.col, b.col));
  const row0 = Math.max(0, Math.min(a.row, b.row));
  const col1 = Math.min(header.width - 1, Math.max(a.col, b.col));
  const row1 = Math.min(header.height - 1, Math.max(a.row, b.row));
  if (col1 < col0 || row1 < row0) {
    return { cols: 0, rows: 0, col0, row0, values: [] };
  }
  const cols = col1 - col0 + 1, rows = row1 - row0 + 1;
  const values = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      values[r * cols + c] = await valueAtPixel(header, col0 + c, row0 + r);
    }
  }
  return { cols, rows, col0, row0, values };
}

/** Projected coordinate at the centre of an image pixel. */
export function centreOf(header, col, row) {
  const { originX, originY, resX, resY } = header.geo;
  return { x: originX + (col + 0.5) * resX, y: originY - (row + 0.5) * resY };
}
