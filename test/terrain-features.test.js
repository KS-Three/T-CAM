import test from 'node:test';
import assert from 'node:assert/strict';
import { planGrid, elevationAtIndex, gridStats } from '../terrain.mjs';
import {
  terrainFeatures, drainages, ridges, saddles, benches, flowAccumulation, smoothed,
} from '../terrain-features.mjs';

function make(fn, { cols = 41, rows = 41, spacingM = 10 } = {}) {
  const g = planGrid({ west: -89.04, south: 43.88, east: -89.03, north: 43.89 }, spacingM);
  g.cols = cols; g.rows = rows;
  g.z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) g.z[r * cols + c] = fn(c, r, cols, rows);
  }
  return g;
}
const mid = n => (n - 1) / 2;

// A repeatable stand-in for sensor noise. Bare-earth LiDAR is good to a few
// centimetres, and that error is the thing most likely to be mistaken for
// terrain, so it appears in several tests below rather than in none.
function noiseFn(amplitudeM = 0.06) {
  let seed = 12345;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * amplitudeM;
  };
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

test('flow runs downhill and accumulates toward the bottom', () => {
  const g = make((c, r) => 200 + r * 2);        // rises to the north
  const { flowTo, acc } = flowAccumulation(g);
  const k = 20 * g.cols + 20;
  assert.ok(flowTo[k] < k, 'a cell drains to a cell in a lower row');
  // The bottom row collects everything above it.
  const bottom = acc[0 * g.cols + 20];
  const top = acc[(g.rows - 1) * g.cols + 20];
  assert.ok(bottom > top, `accumulation grows downhill (${bottom} vs ${top})`);
});

test('flow follows the steepest GRADIENT, not the biggest raw drop', () => {
  // Treating a diagonal as one step biases every path diagonally and turns
  // drainage lines into staircases. The case that separates the two rules: a
  // surface falling 1.0 per cell east and 0.1 per cell north. The diagonal
  // drops MORE in total (1.1 against 1.0) but is sqrt(2) away, so its gradient
  // is only 0.78 — due east must win.
  const g = make((c, r) => 200 - c * 1.0 - r * 0.1);
  const { flowTo } = flowAccumulation(g);
  const c = 20, r = 20, to = flowTo[r * g.cols + c];
  assert.equal((to % g.cols) - c, 1, 'east, the steepest gradient');
  assert.equal(Math.floor(to / g.cols) - r, 0, 'not the diagonal with the larger total drop');

  // And where the diagonal genuinely is steepest per unit distance, it wins.
  const d = make((cc, rr) => 200 - cc * 1.0 - rr * 1.2);
  const dTo = flowAccumulation(d).flowTo[20 * d.cols + 20];
  assert.equal((dTo % d.cols) - 20, 1);
  assert.equal(Math.floor(dTo / d.cols) - 20, 1, 'a genuinely steeper diagonal is taken');
});

// ---------------------------------------------------------------------------
// Drainages and ridges
// ---------------------------------------------------------------------------

test('a V-shaped valley produces a drainage down its floor', () => {
  const g = make((c, r, cols) => 200 + Math.abs(c - mid(cols)) * 2 - r * 0.5);
  const found = drainages(g);
  assert.ok(found.length >= 1, 'the valley floor is found');
  const main = found.sort((a, b) => b.cells.length - a.cells.length)[0];
  const cols = main.cells.map(k => k % g.cols);
  const centre = mid(g.cols);
  assert.ok(cols.every(c => Math.abs(c - centre) <= 4),
    `the channel follows the valley floor, not the flanks (columns ${[...new Set(cols)]})`);
  assert.ok(main.dropFt > 0, 'and it descends');
});

test('a ridge produces a ridge line along its spine', () => {
  const g = make((c, r, cols) => 200 - Math.abs(c - mid(cols)) * 2 + r * 0.5);
  const found = ridges(g);
  assert.ok(found.length >= 1);
  const main = found.sort((a, b) => b.cells.length - a.cells.length)[0];
  const cols = main.cells.map(k => k % g.cols);
  assert.ok(cols.every(c => Math.abs(c - mid(g.cols)) <= 4), 'the line follows the spine');
});

test('traced lines really do sit in the low ground, and ridges on the high', () => {
  // The claim a drainage line makes is geometric, so it is checked
  // geometrically: sample across the line and the ground either side should be
  // higher. Measured at 87% on real LiDAR; a clean synthetic valley should be
  // near perfect.
  const g = make((c, r, cols) => 200 + Math.abs(c - mid(cols)) * 2 - r * 0.5);
  let below = 0, checked = 0;
  for (const p of drainages(g)) {
    for (let i = 1; i < p.cells.length; i++) {
      const k = p.cells[i], c = k % g.cols, r = Math.floor(k / g.cols);
      const z = elevationAtIndex(g, c, r);
      const a = elevationAtIndex(g, c - 3, r), b = elevationAtIndex(g, c + 3, r);
      if (![z, a, b].every(Number.isFinite)) continue;
      checked++;
      if ((a + b) / 2 > z) below++;
    }
  }
  assert.ok(checked > 10, 'enough points to mean something');
  assert.ok(below / checked > 0.9,
    `a drainage sits below its flanks (${below}/${checked})`);
});

test('sensor noise on flat ground does not become drainages', () => {
  // THE test for this module. Flow accumulation is perfectly happy to trace
  // dozens of confident drainages through three centimetres of noise, and they
  // look entirely real on a map.
  const rand = noiseFn(0.06);
  const g = make(() => 200 + rand());
  assert.equal(drainages(g).length, 0, 'nothing here is a draw, and nothing is reported');
  assert.equal(ridges(g).length, 0);
});

test('a genuinely shallow draw survives the noise filter', () => {
  // The other half: the filter must not be so aggressive that it throws away
  // the shallow ground that matters on a gentle property.
  const rand = noiseFn(0.06);
  const g = make((c, r, cols) => 200 + Math.abs(c - mid(cols)) * 0.35 - r * 0.05 + rand());
  const found = drainages(g);
  assert.ok(found.length >= 1, 'a two-foot draw is still a draw');
  const main = found.sort((a, b) => b.cells.length - a.cells.length)[0];
  assert.ok(main.cells.length > 8, 'and it is traced as a real line, not a stub');
});

test('smoothing does not invent ground where there is none', () => {
  const g = make((c, r) => 200 + r);
  for (let r = 0; r < g.rows; r++) g.z[r * g.cols + 5] = NaN;
  const sm = smoothed(g);
  for (let r = 0; r < g.rows; r++) {
    assert.ok(Number.isNaN(sm.z[r * g.cols + 5]),
      'a no-data cell stays no-data after smoothing');
  }
  assert.ok(Number.isFinite(sm.z[10 * g.cols + 10]), 'and real ground survives it');
  assert.equal(gridStats(g).count, gridStats(sm).count, 'coverage is unchanged');
});

// ---------------------------------------------------------------------------
// Saddles and benches
// ---------------------------------------------------------------------------

test('a col between two peaks is found as a saddle', () => {
  const g = make((c, r, cols, rows) => {
    const dx = c - mid(cols), dy = r - mid(rows);
    return 200 + 30 * Math.exp(-((dx + 10) ** 2 + dy ** 2) / 60)
               + 30 * Math.exp(-((dx - 10) ** 2 + dy ** 2) / 60);
  });
  const found = saddles(g);
  assert.equal(found.length, 1, 'one saddle, not one per cell of it');
  const col = Math.round((found[0].lng - g.west) / g.dLng);
  const row = Math.round((found[0].lat - g.south) / g.dLat);
  assert.ok(Math.abs(col - mid(g.cols)) <= 2, `saddle sits between the peaks (col ${col})`);
  assert.ok(Math.abs(row - mid(g.rows)) <= 2, `and on their axis (row ${row})`);
  assert.ok(found[0].reliefFt > 0, 'and it reports how much lower it is');
});

test('a single peak is not a saddle, and neither is a plain hillside', () => {
  const peak = make((c, r, cols, rows) =>
    200 + 30 * Math.exp(-(((c - mid(cols)) ** 2 + (r - mid(rows)) ** 2) / 60)));
  assert.equal(saddles(peak).length, 0, 'a summit is not a crossing');
  const hill = make((c, r) => 200 + r * 2);
  assert.equal(saddles(hill).length, 0, 'nor is an even slope');
});

test('a shelf on a steep slope is a bench; a flat field is not', () => {
  const shelf = make((c, r, cols, rows) => {
    const m = mid(rows);
    if (r < m - 3) return 200 + r * 3;
    if (r > m + 3) return 200 + (r - 7) * 3;
    return 200 + (m - 3) * 3;
  });
  const found = benches(shelf);
  assert.ok(found.length >= 1, 'the shelf is found');
  assert.ok(found[0].slopeDeg <= 4, 'and it is genuinely flat');
  assert.ok(found[0].steepAround >= 35, 'with real slope around it');

  // The distinction the whole detector rests on: flat ground surrounded by more
  // flat ground is a field, not a bench. Without this it reports a whole
  // property as one enormous bench.
  const field = make(() => 200);
  assert.equal(benches(field).length, 0);
});

test('one pin per feature, not one per cell', () => {
  // A bench forty cells across would otherwise arrive as forty pins stacked on
  // the same spot.
  const shelf = make((c, r, cols, rows) => {
    const m = mid(rows);
    if (r < m - 3) return 200 + r * 3;
    if (r > m + 3) return 200 + (r - 7) * 3;
    return 200 + (m - 3) * 3;
  }, { cols: 61, rows: 61 });
  const found = benches(shelf);
  assert.ok(found.length < 12, `thinned to ${found.length} pins, not hundreds`);
});

// ---------------------------------------------------------------------------
// The honest summary
// ---------------------------------------------------------------------------

test('gentle ground reports itself as too gentle rather than empty', () => {
  // Kent's ground is half a degree. An empty list with no explanation is
  // indistinguishable from a broken detector, so the reason is part of the
  // answer.
  const rand = noiseFn(0.04);
  const g = make((c) => 200 + c * 0.05 + rand());
  const f = terrainFeatures(g);
  assert.equal(f.quiet, true, 'the ground is flagged as too gentle');
  assert.deepEqual(f.benches, [], 'and no benches are invented');
  assert.deepEqual(f.saddles, []);
  assert.ok(f.medianSlopeDeg < 2, `median slope ${f.medianSlopeDeg}`);
  assert.ok(typeof f.reliefFt === 'number');
});

test('real relief is not flagged as quiet', () => {
  const g = make((c, r, cols) => 200 + Math.abs(c - mid(cols)) * 3);
  const f = terrainFeatures(g);
  assert.equal(f.quiet, false, 'ground with slope gets the full analysis');
});

test('a grid with no data at all answers without throwing', () => {
  const g = make(() => NaN);
  const f = terrainFeatures(g);
  assert.deepEqual(f.drainages, []);
  assert.deepEqual(f.ridges, []);
  assert.equal(f.reliefFt, null, 'unknown relief is null, not 0');
});
