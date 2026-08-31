import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  toUtm, utmZone, ringBounds, ringCentre, inRing, thin, median, shapeScene,
  searchScenes, ndviForScene, ndviSeries, SCL_UNUSABLE, MIN_PIXELS,
} from '../sentinel.mjs';

// The invented cluster this repo uses everywhere. Points at nothing.
const LAT = 44.12, LNG = -90.65;

/**
 * A minimal uncompressed, unpredicted, single-tile GeoTIFF. cog.mjs already
 * proves Deflate and the predictor against its own fixtures, so these can stay
 * plain — what is under test here is the sampling, not the decoding.
 */
function tinyTiff({ width, height, originX, originY, res, pixel }) {
  const tags = [
    [256, 3, 1, [width]], [257, 3, 1, [height]], [258, 3, 1, [16]],
    [259, 3, 1, [1]], [277, 3, 1, [1]], [317, 3, 1, [1]],
    [322, 3, 1, [width]], [323, 3, 1, [height]], [339, 3, 1, [1]],
    [324, 4, 1, null], [325, 4, 1, null],
    [33550, 12, 3, [res, res, 0]], [33922, 12, 6, [0, 0, 0, originX, originY, 0]],
  ].sort((a, b) => a[0] - b[0]);

  const TB = { 3: 2, 4: 4, 12: 8 };
  const ifd = 8, ifdBytes = 2 + tags.length * 12 + 4;
  let cursor = ifd + ifdBytes;
  const extern = new Map();
  for (const [tag, type, count] of tags) {
    const n = TB[type] * count;
    if (n > 4) { extern.set(tag, cursor); cursor += n; }
  }
  const dataAt = cursor;
  const dataBytes = width * height * 2;
  const out = Buffer.alloc(dataAt + dataBytes);

  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd, 4);
  out.writeUInt16LE(tags.length, ifd);

  const put = (type, vals, at) => vals.forEach((v, i) => {
    const o = at + i * TB[type];
    if (type === 12) out.writeDoubleLE(v, o);
    else if (type === 4) out.writeUInt32LE(v, o);
    else out.writeUInt16LE(v, o);
  });

  tags.forEach(([tag, type, count, vals], i) => {
    const o = ifd + 2 + i * 12;
    out.writeUInt16LE(tag, o);
    out.writeUInt16LE(type, o + 2);
    out.writeUInt32LE(count, o + 4);
    const data = vals ?? (tag === 324 ? [dataAt] : [dataBytes]);
    if (TB[type] * count > 4) {
      out.writeUInt32LE(extern.get(tag), o + 8);
      put(type, data, extern.get(tag));
    } else put(type, data, o + 8);
  });

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      out.writeUInt16LE(pixel(c, r) & 0xffff, dataAt + (r * width + c) * 2);
    }
  }
  return out;
}

/** Serves several named buffers with Range support. */
async function serveTiffs(map) {
  const server = http.createServer((req, res) => {
    const buf = map[req.url];
    if (!buf) { res.writeHead(404); return res.end(); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (!m) { res.writeHead(200, { 'content-length': buf.length }); return res.end(buf); }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), buf.length - 1);
    if (start > end) { res.writeHead(416); return res.end(); }
    res.writeHead(206, { 'content-length': end - start + 1 });
    res.end(buf.subarray(start, end + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// ---------------------------------------------------------------------------
// projection

test('UTM is pinned at the places its definition fixes', () => {
  // On a zone's central meridian the easting is exactly the false easting,
  // and at the equator the northing is exactly zero.
  const cm = toUtm(0, -93, 15);
  assert.ok(Math.abs(cm.x - 500000) < 1e-6, `x ${cm.x}`);
  assert.ok(Math.abs(cm.y) < 1e-6, `y ${cm.y}`);

  const cm16 = toUtm(44.12, -87, 16);
  assert.ok(Math.abs(cm16.x - 500000) < 1e-6, `x ${cm16.x}`);
});

test('UTM agrees with PROJ to the millimetre', () => {
  // Reference values from pyproj (EPSG:4326 -> EPSG:326NN), which is an
  // independent implementation of the same definition.
  const cases = [
    [42.18, -93.78, 15, 435584.426, 4670056.154],
    [LAT, LNG, 15, 688030.705, 4887886.335],
    [44.125, -90.651, 15, 687934.830, 4888439.416],
    [44.12, -87.0, 16, 500000.000, 4885201.117],
  ];
  for (const [lat, lng, zone, ex, ey] of cases) {
    const { x, y } = toUtm(lat, lng, zone);
    assert.ok(Math.abs(x - ex) < 0.001, `x for ${lat},${lng}: ${x} vs ${ex}`);
    assert.ok(Math.abs(y - ey) < 0.001, `y for ${lat},${lng}: ${y} vs ${ey}`);
  }
});

test('UTM holds ground distance', () => {
  // A tenth of a degree of latitude is about 11.1 km, and UTM's scale error
  // is under a part in a thousand, so the projected distance must match.
  const a = toUtm(LAT, LNG, 15);
  const b = toUtm(LAT + 0.1, LNG, 15);
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(Math.abs(d - 11119) < 30, `${d} m`);
});

test('the zone for a longitude is the one UTM defines', () => {
  assert.equal(utmZone(-90.65), 15);
  assert.equal(utmZone(-87.0), 16);
  assert.equal(utmZone(-93.78), 15);
  assert.equal(utmZone(-179.9), 1);
  assert.equal(utmZone(179.9), 60);
});

// ---------------------------------------------------------------------------
// geometry

const square = [[-90.66, 44.12], [-90.65, 44.12], [-90.65, 44.13], [-90.66, 44.13]];

test('a ring reports its own bounds and centre', () => {
  const b = ringBounds(square);
  assert.deepEqual(b, { west: -90.66, east: -90.65, south: 44.12, north: 44.13 });
  const [lng, lat] = ringCentre(square);
  assert.ok(Math.abs(lng + 90.655) < 1e-9);
  assert.ok(Math.abs(lat - 44.125) < 1e-9);
});

test('point-in-ring separates inside from outside', () => {
  assert.equal(inRing(square, -90.655, 44.125), true);
  assert.equal(inRing(square, -90.60, 44.125), false);
  assert.equal(inRing(square, -90.655, 44.20), false);
});

test('a concave ring is not treated as its bounding box', () => {
  // An L: the missing quadrant must read as outside.
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  assert.equal(inRing(L, 0.5, 0.5), true);
  assert.equal(inRing(L, 1.5, 0.5), true);
  assert.equal(inRing(L, 1.5, 1.5), false, 'the notch is outside');
});

// ---------------------------------------------------------------------------
// scene selection

const scene = (date, cloud) => ({ date, cloud, properties: { datetime: `${date}T00:00:00Z`, 'eo:cloud_cover': cloud } });

test('thinning keeps the ends and spreads the middle', () => {
  const list = Array.from({ length: 40 }, (_, i) =>
    scene(`2026-0${4 + Math.floor(i / 10)}-${String(1 + (i % 10) * 3).padStart(2, '0')}`, 10));
  const kept = thin(list, 8);
  assert.equal(kept.length, 8);
  assert.equal(kept[0].date, list[0].date, 'first is kept');
  assert.equal(kept[7].date, list[39].date, 'last is kept');
  const dates = kept.map(s => s.date);
  assert.deepEqual(dates, [...dates].sort(), 'still in time order');
  assert.equal(new Set(dates).size, 8, 'no scene picked twice');
});

test('thinning prefers the clearest scene nearby', () => {
  const list = [scene('2026-05-01', 5), scene('2026-05-04', 80), scene('2026-05-07', 2),
    scene('2026-05-10', 90), scene('2026-05-13', 1)];
  const kept = thin(list, 3).map(s => s.cloud);
  assert.ok(!kept.includes(90), `picked a 90% cloudy scene: ${kept}`);
});

test('a short list is returned untouched', () => {
  const list = [scene('2026-05-01', 5), scene('2026-05-04', 8)];
  assert.equal(thin(list, 10).length, 2);
});

test('a STAC item is reduced to the fields used, zone included', () => {
  const s = shapeScene({
    id: 'S2B_15TVG_20260826_0_L2A',
    properties: { datetime: '2026-08-26T17:00:00Z', 'eo:cloud_cover': 0.2, 'grid:code': 'MGRS-15TVG' },
    assets: { red: { href: 'r.tif' }, nir: { href: 'n.tif' }, scl: { href: 's.tif' } },
  });
  assert.equal(s.date, '2026-08-26');
  assert.equal(s.zone, 15);
  assert.equal(s.red, 'r.tif');
  assert.equal(s.cloud, 0.2);
});

test('the catalogue is queried and one tile is chosen', async t => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      const mk = (id, tile, date, cloud) => ({
        id, properties: { datetime: `${date}T00:00:00Z`, 'eo:cloud_cover': cloud, 'grid:code': tile },
        assets: { red: { href: 'r' }, nir: { href: 'n' }, scl: { href: 's' } },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        features: [
          mk('a', 'MGRS-15TVG', '2026-05-01', 5),
          mk('b', 'MGRS-15TVG', '2026-06-01', 5),
          mk('c', 'MGRS-15TVG', '2026-07-01', 5),
          mk('d', 'MGRS-16TAA', '2026-05-02', 5),   // a different tile, fewer scenes
        ],
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_STAC_URL = `http://127.0.0.1:${server.address().port}/search`;
  t.after(() => { server.close(); delete process.env.TRAILCAM_STAC_URL; });

  const scenes = await searchScenes(square, { start: '2026-04-01', end: '2026-09-01' });
  assert.equal(scenes.length, 3, 'only the majority tile survives');
  assert.ok(scenes.every(s => s.zone === 15));
  assert.deepEqual(scenes.map(s => s.id), ['a', 'b', 'c']);

  const sent = bodies[0];
  assert.deepEqual(sent.collections, ['sentinel-2-l2a']);
  assert.equal(sent.intersects.type, 'Point');
});

test('an empty catalogue answer is empty, not an error', async t => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ features: [] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_STAC_URL = `http://127.0.0.1:${server.address().port}/search`;
  t.after(() => { server.close(); delete process.env.TRAILCAM_STAC_URL; });
  assert.deepEqual(await searchScenes(square, { start: '2026-04-01', end: '2026-09-01' }), []);
});

// ---------------------------------------------------------------------------
// measurement

test('median ignores an outlier a mean would follow', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3, 1000]), 2.5);
  assert.equal(median([]), null);
});

/**
 * Builds red/nir/scl rasters over a ring, with reflectances chosen so NDVI is
 * a known constant, and returns the scene to measure.
 */
async function fieldFixture({ ndvi = 0.8, sclValue = 4, size = 40 } = {}) {
  const zone = 15;
  const { x, y } = toUtm(LAT, LNG, zone);
  const res = 10;
  const originX = x - (size / 2) * res;
  const originY = y + (size / 2) * res;

  // NDVI = (n - r) / (n + r); fix r = 1000 and solve for n.
  const r = 1000;
  const n = Math.round(r * (1 + ndvi) / (1 - ndvi));

  const geo = { width: size, height: size, originX, originY, res };
  const map = {
    '/red.tif': tinyTiff({ ...geo, pixel: () => r }),
    '/nir.tif': tinyTiff({ ...geo, pixel: () => n }),
    '/scl.tif': tinyTiff({ ...geo, pixel: () => sclValue }),
  };
  const { server, base } = await serveTiffs(map);
  return {
    server,
    scene: {
      id: 'fixture', date: '2026-08-20', cloud: 0, zone,
      red: `${base}/red.tif`, nir: `${base}/nir.tif`, scl: `${base}/scl.tif`,
    },
    // A ring a little inside the raster, ~150 m across.
    ring: (() => {
      const d = 0.0009;   // roughly 100 m in latitude
      return [[LNG - d, LAT - d], [LNG + d, LAT - d], [LNG + d, LAT + d], [LNG - d, LAT + d]];
    })(),
  };
}

test('NDVI over a ring is measured from the pixels inside it', async t => {
  const { server, scene, ring } = await fieldFixture({ ndvi: 0.8 });
  t.after(() => server.close());

  const r = await ndviForScene(scene, ring);
  assert.ok(Math.abs(r.ndvi - 0.8) < 1e-6, `ndvi ${r.ndvi}`);
  assert.equal(r.date, '2026-08-20');
  assert.ok(r.clear >= MIN_PIXELS, `clear ${r.clear}`);
  assert.equal(r.clearFraction, 1);
  assert.equal(r.why, null);
  assert.ok(r.outside > 0, 'pixels outside the ring were skipped, not counted');
});

test('a cut field reads low, a standing one high', async t => {
  const hi = await fieldFixture({ ndvi: 0.85 });
  t.after(() => hi.server.close());
  const lo = await fieldFixture({ ndvi: 0.18 });
  t.after(() => lo.server.close());

  const a = await ndviForScene(hi.scene, hi.ring);
  const b = await ndviForScene(lo.scene, lo.ring);
  assert.ok(a.ndvi - b.ndvi > 0.6, `${a.ndvi} vs ${b.ndvi}`);
});

test('cloud is refused rather than measured', async t => {
  for (const bad of SCL_UNUSABLE) {
    const { server, scene, ring } = await fieldFixture({ sclValue: bad });
    const r = await ndviForScene(scene, ring);
    assert.equal(r.ndvi, null, `SCL ${bad} should be unusable`);
    assert.equal(r.clear, 0);
    assert.match(r.why, /cloud-free/);
    server.close();
  }
});

test('a field outside the scene says so', async t => {
  const { server, scene } = await fieldFixture({});
  t.after(() => server.close());
  const far = [[-80.0, 40.0], [-79.99, 40.0], [-79.99, 40.01], [-80.0, 40.01]];
  const r = await ndviForScene(scene, far);
  assert.equal(r.ndvi, null);
  assert.match(r.why, /does not fall inside/);
});

test('a series records failures instead of dropping them', async t => {
  const { server, scene, ring } = await fieldFixture({ ndvi: 0.7 });
  t.after(() => server.close());

  const broken = { ...scene, id: 'broken', date: '2026-08-25', red: null };
  const seen = [];
  const series = await ndviSeries(ring, [scene, broken], {
    onProgress: (i, n) => seen.push(`${i}/${n}`),
  });

  assert.equal(series.length, 2, 'both scenes appear');
  assert.ok(Math.abs(series[0].ndvi - 0.7) < 1e-3, `ndvi ${series[0].ndvi}`);
  assert.equal(series[1].ndvi, null);
  assert.match(series[1].why, /no red\/nir asset/);
  assert.deepEqual(seen, ['1/2', '2/2']);
});
