import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateSync } from 'node:zlib';
import {
  readHeader, readTile, readRange, valueAt, valueAtPixel, pixelFor, readBox,
  centreOf, undoPredictor,
} from '../cog.mjs';

/**
 * A TIFF writer, so the reader is checked against pixel values chosen here
 * rather than against itself. It writes the same flavour Sentinel-2 does —
 * classic, little-endian, tiled, single-band, Deflate with predictor 2 — and
 * can be told to write the variants the reader must refuse.
 *
 * The layout is: header, IFD, then the tag values that don't fit inline, then
 * the tile data. Offsets are computed rather than patched, which keeps the
 * writer short enough to trust.
 */
function writeTiff(opts = {}) {
  const {
    width = 8, height = 8, tileWidth = 4, tileHeight = 4,
    bits = 16, compression = 8, predictor = 2, samplesPerPixel = 1,
    sampleFormat = 1, magic = 42, byteOrder = 'II',
    originX = 400000, originY = 4700000, res = 10,
    pixel = (col, row) => col + row * 100,
    sparseTiles = [], shortTiles = [], geo = true, tiled = true,
  } = opts;

  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileHeight);
  const bytesPer = bits / 8;

  // --- tile payloads -------------------------------------------------------
  const tiles = [];
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      const idx = ty * across + tx;
      if (sparseTiles.includes(idx)) { tiles.push(Buffer.alloc(0)); continue; }
      const flat = Buffer.alloc(tileWidth * tileHeight * bytesPer);
      const put = (o, v) => bits === 8 ? flat.writeUInt8(v & 0xff, o)
        : bits === 16 ? flat.writeUInt16LE(v & 0xffff, o)
          : flat.writeUInt32LE(v >>> 0, o);
      for (let r = 0; r < tileHeight; r++) {
        for (let c = 0; c < tileWidth; c++) {
          const col = tx * tileWidth + c, row = ty * tileHeight + r;
          // Pixels outside the image still occupy the tile; any value will do.
          const v = (col < width && row < height) ? pixel(col, row) : 0;
          put((r * tileWidth + c) * bytesPer, v);
        }
      }
      if (predictor === 2) {
        // Encode as differences from the left neighbour, the inverse of the
        // running sum the reader applies.
        const get = o => bits === 8 ? flat.readUInt8(o)
          : bits === 16 ? flat.readUInt16LE(o) : flat.readUInt32LE(o);
        for (let r = 0; r < tileHeight; r++) {
          for (let c = tileWidth - 1; c > 0; c--) {
            const o = (r * tileWidth + c) * bytesPer;
            put(o, get(o) - get(o - bytesPer));
          }
        }
      }
      // A tile that decompresses to less than a full tile: valid Deflate,
      // wrong length, which is what a corrupt or misdeclared tile looks like.
      const body = shortTiles.includes(idx) ? flat.subarray(0, flat.length >> 1) : flat;
      tiles.push(compression === 1 ? body : deflateSync(body));
    }
  }

  // --- tag table -----------------------------------------------------------
  const tags = [
    [256, 3, 1, [width]], [257, 3, 1, [height]], [258, 3, 1, [bits]],
    [259, 3, 1, [compression]], [277, 3, 1, [samplesPerPixel]],
    [317, 3, 1, [predictor]],
  ];
  if (tiled) {
    tags.push([322, 3, 1, [tileWidth]], [323, 3, 1, [tileHeight]]);
  }
  tags.push([339, 3, 1, [sampleFormat]]);
  const tileOffsetsTag = tiled ? [324, 4, tiles.length, null] : [273, 4, tiles.length, null];
  tags.push(tileOffsetsTag, [325, 4, tiles.length, null]);
  if (geo) {
    tags.push([33550, 12, 3, [res, res, 0]],
      [33922, 12, 6, [0, 0, 0, originX, originY, 0]]);
  }
  tags.sort((a, b) => a[0] - b[0]);

  const TYPE_BYTES = { 1: 1, 3: 2, 4: 4, 12: 8 };
  const ifdStart = 8;
  const ifdBytes = 2 + tags.length * 12 + 4;
  let cursor = ifdStart + ifdBytes;

  // Reserve space for out-of-line tag values, then for the tiles themselves.
  const extern = new Map();
  for (const [tag, type, count] of tags) {
    const size = TYPE_BYTES[type] * count;
    if (size > 4) { extern.set(tag, cursor); cursor += size; }
  }
  const tileOffsets = [];
  for (const t of tiles) { tileOffsets.push(t.length ? cursor : 0); cursor += t.length; }

  const out = Buffer.alloc(cursor);
  out.write(byteOrder, 0, 'ascii');
  out.writeUInt16LE(magic, 2);
  out.writeUInt32LE(ifdStart, 4);
  out.writeUInt16LE(tags.length, ifdStart);

  const writeVals = (type, vals, at) => {
    vals.forEach((v, i) => {
      const o = at + i * TYPE_BYTES[type];
      if (type === 12) out.writeDoubleLE(v, o);
      else if (type === 4) out.writeUInt32LE(v, o);
      else if (type === 3) out.writeUInt16LE(v, o);
      else out.writeUInt8(v, o);
    });
  };

  tags.forEach(([tag, type, count, vals], i) => {
    const o = ifdStart + 2 + i * 12;
    out.writeUInt16LE(tag, o);
    out.writeUInt16LE(type, o + 2);
    out.writeUInt32LE(count, o + 4);
    const data = vals ?? (tag === 325 ? tiles.map(t => t.length) : tileOffsets);
    const size = TYPE_BYTES[type] * count;
    if (size > 4) {
      const at = extern.get(tag);
      out.writeUInt32LE(at, o + 8);
      writeVals(type, data, at);
    } else {
      writeVals(type, data, o + 8);
    }
  });

  tiles.forEach((t, i) => { if (t.length) t.copy(out, tileOffsets[i]); });
  return out;
}

/**
 * Serves a buffer with real Range handling, and records what was asked for so
 * the tests can prove the reader fetches tiles rather than whole images.
 */
async function serveBuffer(buf, { ignoreRange = false } = {}) {
  const ranges = [];
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (!m || ignoreRange) {
      ranges.push(null);
      res.writeHead(200, { 'content-length': buf.length });
      return res.end(buf);
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), buf.length - 1);
    if (start > end) {
      ranges.push([start, end]);
      res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
      return res.end();
    }
    ranges.push([start, end]);
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${buf.length}`,
      'content-length': end - start + 1,
    });
    res.end(buf.subarray(start, end + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, ranges, url: `http://127.0.0.1:${server.address().port}/x.tif` };
}

async function open(opts, serveOpts) {
  const { server, ranges, url } = await serveBuffer(writeTiff(opts), serveOpts);
  const header = await readHeader(url);
  return { server, ranges, url, header };
}

// ---------------------------------------------------------------------------

test('the header of a Sentinel-shaped COG is parsed', async t => {
  const { server, header } = await open({});
  t.after(() => server.close());

  assert.equal(header.width, 8);
  assert.equal(header.height, 8);
  assert.equal(header.tileWidth, 4);
  assert.equal(header.tileHeight, 4);
  assert.equal(header.compression, 8);
  assert.equal(header.predictor, 2);
  assert.equal(header.bits, 16);
  assert.equal(header.tilesAcross, 2);
  assert.equal(header.tilesDown, 2);
  assert.equal(header.offsets.length, 4);
});

test('every pixel round-trips through Deflate and the predictor', async t => {
  const { server, header } = await open({});
  t.after(() => server.close());

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      assert.equal(await valueAtPixel(header, col, row), col + row * 100,
        `pixel ${col},${row}`);
    }
  }
});

test('an uncompressed, unpredicted TIFF reads the same', async t => {
  const { server, header } = await open({ compression: 1, predictor: 1 });
  t.after(() => server.close());
  assert.equal(await valueAtPixel(header, 5, 6), 5 + 600);
});

test('8- and 32-bit samples are read at their own widths', async t => {
  const a = await open({ bits: 8, pixel: (c, r) => (c + r * 8) & 0xff });
  t.after(() => a.server.close());
  assert.equal(await valueAtPixel(a.header, 3, 2), 3 + 16);

  const b = await open({ bits: 32, pixel: (c, r) => 100000 + c + r * 1000 });
  t.after(() => b.server.close());
  assert.equal(await valueAtPixel(b.header, 3, 2), 100000 + 3 + 2000);
});

test('only the tiles a pixel touches are fetched', async t => {
  const { server, header, ranges } = await open({});
  t.after(() => server.close());

  const before = ranges.length;
  await valueAtPixel(header, 0, 0);            // top-left tile
  const afterFirst = ranges.length;
  assert.ok(afterFirst > before, 'reading a pixel fetched something');

  await valueAtPixel(header, 1, 1);            // same tile again
  assert.equal(ranges.length, afterFirst, 'the tile was cached, not refetched');

  await valueAtPixel(header, 7, 7);            // opposite tile
  assert.ok(ranges.length > afterFirst, 'a different tile was fetched');
});

test('a pixel outside the image is null, not a wrong number', async t => {
  const { server, header } = await open({});
  t.after(() => server.close());
  assert.equal(await valueAtPixel(header, -1, 0), null);
  assert.equal(await valueAtPixel(header, 0, -1), null);
  assert.equal(await valueAtPixel(header, 8, 0), null);
  assert.equal(await valueAtPixel(header, 0, 8), null);
});

test('an absent tile in a sparse COG reads as zeroes', async t => {
  const { server, header } = await open({ sparseTiles: [3] });
  t.after(() => server.close());
  assert.equal(await valueAtPixel(header, 0, 0), 0 + 0);
  assert.equal(await valueAtPixel(header, 7, 7), 0, 'the sparse tile is empty');
});

test('georeferencing maps coordinates to pixels and back', async t => {
  const { server, header } = await open({ originX: 400000, originY: 4700000, res: 10 });
  t.after(() => server.close());

  assert.deepEqual(pixelFor(header, 400000, 4700000), { col: 0, row: 0 });
  assert.deepEqual(pixelFor(header, 400025, 4699975), { col: 2, row: 2 });

  // A pixel centre must land back inside the pixel it came from.
  const c = centreOf(header, 3, 4);
  assert.deepEqual(pixelFor(header, c.x, c.y), { col: 3, row: 4 });

  assert.equal(await valueAt(header, 400025, 4699975), 2 + 200);
});

test('a box spanning a tile boundary returns every value in order', async t => {
  const { server, header } = await open({});
  t.after(() => server.close());

  // Columns 2..5, rows 2..5 — straddles all four tiles.
  const box = await readBox(header, {
    minX: 400025, maxX: 400055, minY: 4699945, maxY: 4699975,
  });
  assert.equal(box.cols, 4);
  assert.equal(box.rows, 4);
  assert.equal(box.col0, 2);
  assert.equal(box.row0, 2);
  for (let r = 0; r < box.rows; r++) {
    for (let c = 0; c < box.cols; c++) {
      assert.equal(box.values[r * box.cols + c], (2 + c) + (2 + r) * 100);
    }
  }
});

test('a box entirely outside the image comes back empty', async t => {
  const { server, header } = await open({});
  t.after(() => server.close());
  const box = await readBox(header, {
    minX: 500000, maxX: 500100, minY: 4600000, maxY: 4600100,
  });
  assert.equal(box.values.length, 0);
});

test('a server that ignores Range still yields correct pixels', async t => {
  // Some CDNs answer 200 with the whole file. Reading from offset zero then
  // would silently return the wrong bytes, so the slice is pinned here.
  const { server, header } = await open({}, { ignoreRange: true });
  t.after(() => server.close());
  assert.equal(await valueAtPixel(header, 6, 3), 6 + 300);
});

test('readRange slices a whole-file 200 response', async t => {
  const buf = Buffer.from('0123456789');
  const { server, url } = await serveBuffer(buf, { ignoreRange: true });
  t.after(() => server.close());
  assert.equal((await readRange(url, 3, 5)).toString(), '345');
});

test('undoPredictor is the exact inverse of differencing', () => {
  const original = Uint16Array.from([10, 20, 35, 5, 7, 7, 9, 65535]);
  const diffed = Uint16Array.from(original);
  for (let c = 7; c > 0; c--) diffed[c] = (diffed[c] - diffed[c - 1]) & 0xffff;
  undoPredictor(diffed, 8, 1, 16);
  assert.deepEqual(Array.from(diffed), Array.from(original));
});

test('unsupported files are refused by name, not misread', async t => {
  const cases = [
    [{ magic: 43 }, /BigTIFF/],
    [{ magic: 7 }, /magic number/],
    [{ tiled: false }, /stripped/],
    [{ samplesPerPixel: 3 }, /single-band/],
    [{ compression: 5 }, /compression 5/],
    [{ predictor: 3 }, /predictor 3/],
    [{ sampleFormat: 3 }, /unsigned/],
    [{ bits: 64 }, /bit depth 64/],
  ];
  for (const [opts, re] of cases) {
    const { server, url } = await serveBuffer(writeTiff(opts));
    await assert.rejects(() => readHeader(url), re, JSON.stringify(opts));
    server.close();
  }

  const { server, url } = await serveBuffer(Buffer.from('not a tiff at all'));
  t.after(() => server.close());
  await assert.rejects(() => readHeader(url), /not a TIFF/);
});

test('a tile that decodes short is reported, not read as garbage', async t => {
  const { server, header } = await open({ shortTiles: [3] });
  t.after(() => server.close());
  assert.equal(await valueAtPixel(header, 0, 0), 0, 'good tiles still read');
  await assert.rejects(() => readTile(header, 3), /decoded to 16 bytes, expected 32/);
});

test('a tile index out of range is refused', async t => {
  const { server, header } = await open({});
  t.after(() => server.close());
  await assert.rejects(() => readTile(header, 99), /outside the tile index/);
});

test('a TIFF without georeferencing refuses coordinate lookups', async t => {
  const { server, header } = await open({ geo: false });
  t.after(() => server.close());
  assert.equal(header.geo, null);
  assert.throws(() => pixelFor(header, 1, 2), /no georeferencing/);
  assert.equal(await valueAtPixel(header, 1, 2), 1 + 200, 'pixels still read');
});
