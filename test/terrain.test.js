import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planGrid, cellLatLng, gridBounds, elevationAt, elevationAtIndex, parseElevation,
  fetchElevationGrid, slopeAspect, gridStats, contourLines, chooseIntervalFt,
  hillshade, autoZFactor, metresToFeet, BATCH,
} from '../terrain.mjs';
import { openDb, saveTerrainGrid, terrainGridAt, terrainGridCovering, allTerrainGrids } from '../db.mjs';
import { createServer } from '../serve.mjs';

// A synthetic hillside with an exactly known answer, so the maths below is
// checked against arithmetic rather than against itself.
function slopingGrid(gradEast, gradNorth, { spacingM = 20, cols = 21, rows = 21 } = {}) {
  const g = planGrid({ west: -89.04, south: 43.88, east: -89.03, north: 43.89 }, spacingM);
  g.cols = cols; g.rows = rows;
  g.z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      g.z[r * cols + c] = 200 + c * spacingM * gradEast + r * spacingM * gradNorth;
    }
  }
  return g;
}

// A symmetric ridge, for anything that has to tell one flank from the other.
function ridgeGrid(axis = 'ns', { spacingM = 20, cols = 21, rows = 21 } = {}) {
  const g = slopingGrid(0, 0, { spacingM, cols, rows });
  const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rise = axis === 'ns' ? midC - Math.abs(c - midC) : midR - Math.abs(r - midR);
      g.z[r * cols + c] = 200 + rise * spacingM * 0.1;
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// The grid itself
// ---------------------------------------------------------------------------

test('a grid is planned at the spacing asked for', () => {
  const g = planGrid({ west: -89.04, south: 43.88, east: -89.03, north: 43.89 }, 10);
  const b = gridBounds(g);
  assert.ok(g.cols > 50 && g.rows > 100, `got ${g.cols}x${g.rows}`);
  assert.ok(Math.abs(b.east - -89.03) < g.dLng, 'the east edge lands within a cell of the ask');
  // A degree of longitude is shorter than a degree of latitude at 44 N, so the
  // cell must be WIDER in degrees to be square in metres. Getting this backwards
  // stretches every distance on the map.
  assert.ok(g.dLng > g.dLat, 'cells are square in metres, not in degrees');
});

test('inside-out or missing bounds are refused, not quietly fixed', () => {
  assert.throws(() => planGrid({ west: -89, south: 43, east: -90, north: 44 }), /inside out/);
  assert.throws(() => planGrid({ west: -89, south: 44, east: -88, north: 43 }), /inside out/);
  assert.throws(() => planGrid({ west: NaN, south: 43, east: -88, north: 44 }), /finite bounds/);
  assert.throws(() => planGrid({ west: -89, south: 43, east: -88, north: 44 }, 0), /positive spacing/);
});

test('no-data never becomes a real elevation', () => {
  // The trap: the service's no-data sentinel is a huge negative float, and 0 is
  // a real elevation. Either one silently accepted would put a sea-level pit in
  // the middle of Wisconsin.
  assert.ok(Number.isNaN(parseElevation(-3.4e38)));
  assert.ok(Number.isNaN(parseElevation(null)));
  assert.ok(Number.isNaN(parseElevation('')));
  assert.ok(Number.isNaN(parseElevation('not a number')));
  assert.equal(parseElevation('231.695693970'), 231.69569397, 'values arrive as strings');
  assert.equal(parseElevation(0), 0, 'sea level is a real elevation and survives');
});

test('elevation between lattice points is interpolated, and refuses to guess', () => {
  const g = slopingGrid(0.1, 0);
  const at = cellLatLng(g, 5, 5);
  assert.ok(Math.abs(elevationAt(g, at.lat, at.lng) - g.z[5 * g.cols + 5]) < 1e-6);

  // Halfway between two columns is halfway up the slope.
  const half = cellLatLng(g, 5.5, 5);
  const want = (g.z[5 * g.cols + 5] + g.z[5 * g.cols + 6]) / 2;
  assert.ok(Math.abs(elevationAt(g, half.lat, half.lng) - want) < 1e-4);

  assert.ok(Number.isNaN(elevationAt(g, 44.5, -89.035)), 'outside the grid is NaN, not an edge value');

  g.z[5 * g.cols + 6] = NaN;
  assert.ok(Number.isNaN(elevationAt(g, half.lat, half.lng)),
    'a missing corner makes the answer unknown rather than plausible');
});

// ---------------------------------------------------------------------------
// Slope and aspect
// ---------------------------------------------------------------------------

test('slope and aspect are right on ground with a known answer', () => {
  // Aspect is the direction the ground FACES, i.e. downhill. Ground that rises
  // to the east faces west, which is 270. Getting this inverted would point
  // every thermal and every wind call exactly backwards, so all four compass
  // directions are checked rather than one.
  for (const [gradE, gradN, wantAspect] of [
    [0.1, 0, 270], [0, 0.1, 180], [-0.1, 0, 90], [0, -0.1, 0],
  ]) {
    const g = slopingGrid(gradE, gradN);
    const { slope, aspect } = slopeAspect(g);
    const k = Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2);
    assert.ok(Math.abs(slope[k] - 5.71) < 0.01, `slope ${slope[k]} for grad ${gradE},${gradN}`);
    assert.ok(Math.abs(aspect[k] - wantAspect) < 0.01,
      `aspect ${aspect[k]} should be ${wantAspect} for grad ${gradE},${gradN}`);
  }
});

test('flat ground has no aspect at all', () => {
  // Not north. A flat cell does not face anywhere, and calling it north would
  // invent a thermal on ground that has none.
  const { slope, aspect } = slopeAspect(slopingGrid(0, 0));
  const k = 10 * 21 + 10;
  assert.equal(slope[k], 0);
  assert.ok(Number.isNaN(aspect[k]), 'aspect on flat ground is unknown, not 0');
});

// ---------------------------------------------------------------------------
// Hillshade
// ---------------------------------------------------------------------------

test('hillshade lights the terrain from the direction it is told', () => {
  // The bug this pins: the textbook trigonometric form is easy to transcribe
  // with the aspect convention inverted, which lights from the south-east and
  // makes every ridge read as a valley. The first version did exactly that and
  // looked entirely plausible.
  const ns = ridgeGrid('ns');
  const nw = hillshade(ns, { zFactor: 1 });
  const mid = (ns.cols - 1) / 2, row = Math.floor(ns.rows / 2) * ns.cols;
  const west = nw.shade[row + Math.floor(mid / 2)];
  const east = nw.shade[row + Math.floor(mid * 1.5)];
  assert.ok(west > east, `north-west light must brighten the west flank (${west} vs ${east})`);

  const se = hillshade(ns, { zFactor: 1, azimuthDeg: 135 });
  assert.ok(se.shade[row + Math.floor(mid * 1.5)] > se.shade[row + Math.floor(mid / 2)],
    'moving the sun to the south-east flips which flank is lit');

  const ew = ridgeGrid('ew');
  const hs = hillshade(ew, { zFactor: 1 });
  const col = Math.floor(ew.cols / 2), midR = (ew.rows - 1) / 2;
  assert.ok(hs.shade[Math.floor(midR * 1.5) * ew.cols + col]
          > hs.shade[Math.floor(midR / 2) * ew.cols + col],
    'and the same holds for an east-west ridge');
});

test('vertical exaggeration scales to the relief actually present', () => {
  // A z-factor of 1 renders Kent's ground as an even grey. The exaggeration is
  // therefore chosen from the relief, and REPORTED, because an exaggerated
  // hillshade is a diagram and a reader who thinks otherwise misjudges the
  // ground badly.
  const gentle = slopingGrid(0.002, 0);
  const steep = slopingGrid(0.4, 0);
  assert.ok(autoZFactor(gentle) > autoZFactor(steep),
    'flatter ground gets more exaggeration, not less');
  assert.ok(autoZFactor(steep) >= 1, 'and it never inverts the terrain');
  assert.ok(autoZFactor(gentle) <= 60, 'nor runs away on near-flat ground');
  assert.equal(hillshade(gentle).zFactor, autoZFactor(gentle), 'the factor used is the factor reported');
});

test('hillshade marks missing ground as transparent rather than black', () => {
  const g = slopingGrid(0.1, 0);
  for (let r = 0; r < g.rows; r++) g.z[r * g.cols + 0] = NaN;
  const hs = hillshade(g);
  assert.equal(hs.alpha[Math.floor(g.rows / 2) * g.cols + 0], 0, 'no data is see-through');
  assert.equal(hs.alpha[Math.floor(g.rows / 2) * g.cols + 10], 255);
});

// ---------------------------------------------------------------------------
// Contours
// ---------------------------------------------------------------------------

test('the contour interval adapts to the relief, or it draws nothing useful', () => {
  // Kent's ground has under 9 ft of relief in a 300 m box. A fixed 10 ft
  // interval draws ONE line there, which is why this is computed.
  assert.equal(chooseIntervalFt(2.7), 1, 'nine feet of relief gets a one-foot interval');
  assert.ok(chooseIntervalFt(300) >= 40, 'and real hills get a coarse one');
  assert.equal(chooseIntervalFt(0), 1, 'dead-flat ground still answers something drawable');
});

test('contours on a known slope are the lines you can work out by hand', () => {
  const g = slopingGrid(0.1, 0, { spacingM: 20, cols: 21, rows: 21 });
  const { intervalFt, lines } = contourLines(g);
  assert.ok(lines.length > 0);
  const levels = [...new Set(lines.map(l => l.levelFt))].sort((a, b) => a - b);
  for (let i = 1; i < levels.length; i++) {
    assert.equal(levels[i] - levels[i - 1], intervalFt, 'levels are evenly spaced');
  }
  // On a plane rising only to the east, every contour runs north-south: each
  // line spans the full height of the grid at a constant longitude.
  const line = lines[0];
  const lngs = line.path.map(p => p[0]);
  assert.ok(Math.max(...lngs) - Math.min(...lngs) < g.dLng,
    'a contour of an east-facing plane is a straight north-south line');
  assert.ok(line.path.length > 5, 'and it is stitched into one path, not left as loose segments');
});

test('contours do not bridge a hole in coverage', () => {
  // Interpolating across no-data would draw a ridge that is not there.
  const g = slopingGrid(0.1, 0);
  for (let r = 0; r < g.rows; r++) for (let c = 8; c <= 12; c++) g.z[r * g.cols + c] = NaN;
  const { lines } = contourLines(g);
  const westEdge = gridBounds(g).west + 8 * g.dLng;
  const eastEdge = gridBounds(g).west + 12 * g.dLng;
  for (const l of lines) {
    for (const [lng] of l.path) {
      assert.ok(lng <= westEdge + 1e-9 || lng >= eastEdge - 1e-9,
        'no contour point lands inside the hole');
    }
  }
});

test('a grid with no data at all yields no contours instead of throwing', () => {
  const g = slopingGrid(0.1, 0);
  g.z.fill(NaN);
  const out = contourLines(g);
  assert.deepEqual(out.lines, []);
  assert.equal(gridStats(g).count, 0);
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * A stand-in for the USGS service. Returns a plane so results are predictable,
 * and records every request so the batching can be inspected.
 */
async function fakeElevation(handler = null) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const geom = JSON.parse(params.get('geometry') ?? '{}');
      calls.push({ method: req.method, points: geom.points?.length ?? 0 });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (handler) return res.end(JSON.stringify(handler(geom, calls.length)));
      res.end(JSON.stringify({
        samples: (geom.points ?? []).map((p, i) => ({
          locationId: i, value: String(200 + (p[0] + 89.04) * 100000), resolution: 1,
        })),
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_ELEVATION_URL = `http://127.0.0.1:${server.address().port}/getSamples`;
  return { server, calls };
}

const bounds = { west: -89.04, south: 43.88, east: -89.0385, north: 43.8815 };

test('a grid is fetched in batches and every cell is filled', async t => {
  const { server, calls } = await fakeElevation();
  t.after(() => { server.close(); delete process.env.TRAILCAM_ELEVATION_URL; });

  const g = await fetchElevationGrid(bounds, { spacingM: 10 });
  assert.equal(gridStats(g).count, g.cols * g.rows, 'no cell left unfilled');
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(c => c.method === 'POST'),
    'the lattice is POSTed — a GET overflows the URL and returns 414');
  assert.ok(calls.every(c => c.points <= BATCH),
    'no batch exceeds the size the service will answer');
});

test('batches map their samples back to the right cells', async t => {
  // The trap: locationId is an index within ONE batch, not into the whole grid.
  // Forgetting the offset scrambles every cell after the first batch, and the
  // result still looks like plausible terrain.
  const { server } = await fakeElevation();
  t.after(() => { server.close(); delete process.env.TRAILCAM_ELEVATION_URL; });

  // Deliberately more than one batch.
  const wide = { west: -89.04, south: 43.88, east: -89.0345, north: 43.8845 };
  const g = await fetchElevationGrid(wide, { spacingM: 10 });
  assert.ok(g.cols * g.rows > BATCH, 'this really is a multi-batch fetch');
  // The fake returns elevation as a function of longitude alone, so every row
  // must be identical and every column must increase left to right.
  for (let r = 1; r < g.rows; r++) {
    assert.ok(Math.abs(elevationAtIndex(g, 5, r) - elevationAtIndex(g, 5, 0)) < 1e-3,
      `row ${r} does not match row 0 — samples landed in the wrong cells`);
  }
  assert.ok(elevationAtIndex(g, g.cols - 1, 0) > elevationAtIndex(g, 0, 0));
});

test('parallel batches drop nothing', async t => {
  const { server, calls } = await fakeElevation();
  t.after(() => { server.close(); delete process.env.TRAILCAM_ELEVATION_URL; });
  const wide = { west: -89.04, south: 43.88, east: -89.0345, north: 43.8845 };
  const g = await fetchElevationGrid(wide, { spacingM: 10, concurrency: 4 });
  assert.equal(gridStats(g).count, g.cols * g.rows, 'every sample survived the concurrency');
  assert.equal(calls.length, Math.ceil(g.cols * g.rows / BATCH), 'each batch asked exactly once');
});

test('a service error inside a 200 throws rather than yielding a grid of holes', async t => {
  // ArcGIS reports failures with HTTP 200. Trusting the status code would turn
  // a broken service into terrain that is quietly all no-data.
  const { server } = await fakeElevation(() => ({ error: { code: 400, message: 'Invalid geometry' } }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_ELEVATION_URL; });
  await assert.rejects(() => fetchElevationGrid(bounds, { spacingM: 10 }),
    /elevation service error: Invalid geometry/);
});

test('an absurd area is refused before a public service is hammered', async () => {
  await assert.rejects(
    () => fetchElevationGrid({ west: -90, south: 43, east: -89, north: 44 }, { spacingM: 5 }),
    /ask for a smaller area or a coarser spacing/);
});

test('missing samples come back as no-data, not as zero', async t => {
  const { server } = await fakeElevation(geom => ({
    samples: (geom.points ?? []).map((p, i) => ({ locationId: i, value: i % 2 ? null : '250' })),
  }));
  t.after(() => { server.close(); delete process.env.TRAILCAM_ELEVATION_URL; });
  const g = await fetchElevationGrid(bounds, { spacingM: 10 });
  const st = gridStats(g);
  assert.ok(st.count > 0 && st.count < g.cols * g.rows, 'some cells known, some not');
  assert.ok(st.min >= 250, 'and the unknown ones did not drag the minimum to zero');
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

test('a grid survives the round trip through the database, no-data included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-terrain-'));
  const db = openDb(dir);
  const g = slopingGrid(0.1, 0, { cols: 6, rows: 6 });
  g.z[7] = NaN;
  saveTerrainGrid(db, g);

  const back = terrainGridAt(db, g.south + 2 * g.dLat, g.west + 2 * g.dLng);
  assert.ok(back, 'the grid covering a point is found');
  assert.equal(back.cols, g.cols);
  assert.ok(Number.isNaN(back.z[7]), 'no-data is still no-data and not 0');
  assert.equal(back.z[8], g.z[8]);
  assert.equal(terrainGridAt(db, 10, 10), null, 'ground we have not fetched answers null');
  db.close();
});

test('a cached grid is reused only when it actually covers the ask', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-terrain-'));
  const db = openDb(dir);
  const g = slopingGrid(0.1, 0, { cols: 11, rows: 11, spacingM: 10 });
  saveTerrainGrid(db, g);
  const b = gridBounds(g);

  assert.ok(terrainGridCovering(db, b, 10), 'the exact area is a hit');
  assert.ok(terrainGridCovering(db, {
    west: b.west + g.dLng, south: b.south + g.dLat,
    east: b.east - g.dLng, north: b.north - g.dLat,
  }, 10), 'ground inside it is a hit too');
  assert.equal(terrainGridCovering(db, {
    west: b.west - 1, south: b.south, east: b.east, north: b.north,
  }, 10), null, 'ground reaching outside it is a miss, not a partial answer');
  assert.equal(terrainGridCovering(db, b, 2), null,
    'and a request for finer detail than we cached is a miss');
  assert.equal(allTerrainGrids(db).length, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t) {
  const { server: elev, calls } = await fakeElevation();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-terrain-http-'));
  openDb(out).close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    elev.close();
    delete process.env.TRAILCAM_ELEVATION_URL;
    return new Promise(r => server.close(r));
  });
  return { get: p => fetch(base + p), calls };
}

test('the API returns terrain, and caches it', async t => {
  const { get, calls } = await serving(t);
  const res = await get('/api/terrain?lat=43.881&lng=-89.039&radius=150&spacing=20');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.covered, true);
  assert.equal(body.cached, false, 'the first ask is a real fetch');
  assert.ok(body.stats.reliefFt > 0);
  assert.ok(body.hillshade.zFactor >= 1, 'the exaggeration is disclosed, not hidden');
  assert.ok(body.hillshade.shade.length > 0);
  assert.ok(body.contours.intervalFt > 0);

  const before = calls.length;
  const again = await (await get('/api/terrain?lat=43.881&lng=-89.039&radius=150&spacing=20')).json();
  assert.equal(again.cached, true, 'the second ask is served from the database');
  assert.equal(calls.length, before, 'and does not touch the elevation service again');
});

test('two simultaneous asks for the same ground fetch it once', async t => {
  // Two browser tabs must not each spend 25 seconds asking a public service for
  // identical data.
  const { get, calls } = await serving(t);
  const [a, b] = await Promise.all([
    get('/api/terrain?lat=43.881&lng=-89.039&radius=150&spacing=20').then(r => r.json()),
    get('/api/terrain?lat=43.881&lng=-89.039&radius=150&spacing=20').then(r => r.json()),
  ]);
  assert.equal(a.covered, true);
  assert.equal(b.covered, true);
  assert.equal(calls.length, Math.ceil((a.grid.cols * a.grid.rows) / BATCH),
    'exactly one fetch happened, not two');
});

test('bad coordinates are a 400 before anything is fetched', async t => {
  const { get, calls } = await serving(t);
  assert.equal((await get('/api/terrain')).status, 400);
  assert.equal((await get('/api/terrain?lat=43.88')).status, 400);
  assert.equal((await get('/api/terrain?lat=abc&lng=-89')).status, 400);
  assert.equal((await get('/api/terrain?lat=999&lng=-89')).status, 400);
  assert.equal(calls.length, 0, 'no pointless call to a public service');
});

test('the requested area is clamped, whatever the caller asks for', async t => {
  // radius and spacing decide how many samples get pulled from a free public
  // service, so they are bounded by the server rather than by the caller.
  const { get } = await serving(t);
  const body = await (await get('/api/terrain?lat=43.881&lng=-89.039&radius=99999&spacing=0.1')).json();
  assert.equal(body.covered, true,
    'the largest permitted request must SUCCEED. The radius and spacing clamps '
    + 'were once independent, and their extremes combined into 361,201 samples '
    + '— past the fetcher\'s own guard — so asking for the maximum always failed.');
  const widthM = (body.grid.cols - 1) * body.grid.spacingM;
  assert.ok(body.grid.spacingM >= 5, 'spacing is not allowed below 5 m');
  // One cell of slack: the grid rounds up to a whole number of cells.
  assert.ok(widthM <= 3000 + body.grid.spacingM,
    `radius is capped (got ${widthM} m across)`);
  assert.ok(body.grid.cols * body.grid.rows <= 200_000,
    'and the sample count stays inside the fetcher\'s guard by coarsening');
});
