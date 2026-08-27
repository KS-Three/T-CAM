/**
 * terrain-features.mjs — the landforms that concentrate deer movement.
 *
 * A contour map shows you the ground. This picks out the parts of it that
 * matter: where water runs, where the high ground runs, where a ridge dips low
 * enough to cross, and where a hillside flattens into a shelf.
 *
 * A deliberate choice runs through the whole file: thresholds are absolute and
 * tied to what is actually significant on the ground, NOT relative to whatever
 * terrain happens to be in the current grid. Relative thresholds always find
 * something — point them at a car park and they will confidently report a
 * saddle and two benches. On ground as gentle as Kent's (median slope near half
 * a degree) the honest answer for benches and saddles is usually "none here",
 * and this returns that rather than manufacturing features to look useful.
 *
 * Drainages and ridges are the exception, and they are the reason this module
 * earns its keep on flat ground: they come from flow accumulation, which is
 * scale-free. A draw with two feet of relief is still a draw, still holds
 * water, still carries a trail — and it is invisible on satellite imagery.
 */

import { elevationAtIndex, slopeAspect, cellLatLng, gridStats, metresToFeet } from './terrain.mjs';

// The eight neighbours, and the distance to each in cell widths. Diagonals are
// sqrt(2) away, which matters: treating them as equal biases every flow path
// diagonally, and the drainage lines come out as staircases.
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * D8 flow: each cell drains to its steepest downhill neighbour.
 *
 * Returns the index each cell flows into (-1 for a cell with nowhere lower —
 * a pit or the edge of data) and how many cells drain through each one.
 *
 * Accumulation is computed by walking cells from high to low, so every cell's
 * upstream total is complete before it passes anything on. That ordering is the
 * whole algorithm; without it a single pass gives each cell only its immediate
 * neighbours and the drainage lines never form.
 */
export function flowAccumulation(grid, { invert = false } = {}) {
  const { cols, rows } = grid;
  const n = cols * rows;
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = grid.z[i];
    z[i] = Number.isFinite(v) ? (invert ? -v : v) : NaN;
  }

  const flowTo = new Int32Array(n).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!Number.isFinite(z[i])) continue;
      let best = -1, bestDrop = 0;
      for (const [dc, dr, dist] of NEIGHBOURS) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const j = nr * cols + nc;
        if (!Number.isFinite(z[j])) continue;
        const drop = (z[i] - z[j]) / dist;
        if (drop > bestDrop) { bestDrop = drop; best = j; }
      }
      flowTo[i] = best;
    }
  }

  // High to low, so upstream is always settled first.
  const order = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(z[i])) order.push(i);
  order.sort((a, b) => z[b] - z[a]);

  const acc = new Float64Array(n).fill(1);
  for (const i of order) {
    const j = flowTo[i];
    if (j >= 0) acc[j] += acc[i];
  }
  return { flowTo, acc };
}

/**
 * Trace flow paths into polylines.
 *
 * A cell counts as channel if enough ground drains through it. Each path starts
 * at a HEAD — a channel cell with no channel cell flowing into it — and follows
 * the flow downstream until the channel ends. Starting anywhere else would
 * emit the same channel once per cell along it.
 */
function tracePaths(grid, { flowTo, acc }, threshold, minCells, minDropM = 0) {
  const { cols, rows } = grid;
  const n = cols * rows;
  const isChannel = i => acc[i] >= threshold;
  const surface = grid.z;

  const hasChannelInflow = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!isChannel(i)) continue;
    const j = flowTo[i];
    if (j >= 0 && isChannel(j)) hasChannelInflow[j] = 1;
  }

  const paths = [];
  const visited = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!isChannel(i) || hasChannelInflow[i] || visited[i]) continue;
    const cells = [];
    let cur = i;
    while (cur >= 0 && isChannel(cur) && !visited[cur]) {
      visited[cur] = 1;
      cells.push(cur);
      cur = flowTo[cur];
    }
    // Where one channel joins another, carry the line one cell into the
    // receiving channel so the two meet on the map instead of stopping short.
    if (cur >= 0 && isChannel(cur)) cells.push(cur);
    if (cells.length < minCells) continue;

    // A real channel descends. This is the filter that keeps sensor noise from
    // becoming terrain: bare-earth LiDAR is accurate to a few centimetres, and
    // on genuinely flat ground flow accumulation will happily trace dozens of
    // confident-looking drainages through that noise. Requiring a real drop
    // from head to mouth removes them while keeping the shallow draws that
    // matter on gentle ground.
    const drop = Math.abs(surface[cells[0]] - surface[cells.at(-1)]);
    if (!(drop >= minDropM)) continue;

    paths.push({
      cells,
      dropFt: Math.round(metresToFeet(drop) * 10) / 10,
      drains: Math.round(acc[cells.at(-1)]),
      path: cells.map(k => {
        const { lat, lng } = cellLatLng(grid, k % cols, Math.floor(k / cols));
        return [lng, lat];
      }),
    });
  }
  return paths;
}

/**
 * Drainages: where water goes, and with it a great many deer.
 *
 * The threshold is a fraction of the grid rather than a fixed count, so the
 * same call gives sensible detail whether it is looking at four hectares or
 * four hundred.
 */
export function drainages(grid, {
  minAreaFraction = 0.01, minCells = 6, minDropFt = 1, smooth = true,
} = {}) {
  const work = smooth ? smoothed(grid) : grid;
  const flow = flowAccumulation(work);
  const threshold = Math.max(8, grid.cols * grid.rows * minAreaFraction);
  return tracePaths(work, flow, threshold, minCells, minDropFt / 3.280839895)
    .map(p => ({ ...p, kind: 'drainage' }));
}

/**
 * A light 3x3 mean, run before flow accumulation only.
 *
 * Hydrology routinely smooths a DEM first, and for a reason that matters here:
 * flow direction is decided by which neighbour is lowest, so a centimetre of
 * noise can send a channel off in the wrong direction entirely. The smoothing
 * is NOT applied to the elevations shown to the user, or to contours — those
 * stay as measured.
 */
export function smoothed(grid) {
  const { cols, rows } = grid;
  const z = new Float32Array(cols * rows).fill(NaN);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = elevationAtIndex(grid, c + dc, r + dr);
          if (Number.isFinite(v)) { sum += v; n++; }
        }
      }
      // A cell with no data stays no data; smoothing must not invent ground at
      // the edge of coverage.
      if (n && Number.isFinite(elevationAtIndex(grid, c, r))) z[r * cols + c] = sum / n;
    }
  }
  return { ...grid, z };
}

/**
 * Ridges, by the same machinery upside down: run the flow on an inverted
 * surface and the lines that emerge are the ones water runs AWAY from.
 */
export function ridges(grid, {
  minAreaFraction = 0.01, minCells = 6, minDropFt = 1, smooth = true,
} = {}) {
  const work = smooth ? smoothed(grid) : grid;
  const flow = flowAccumulation(work, { invert: true });
  const threshold = Math.max(8, grid.cols * grid.rows * minAreaFraction);
  return tracePaths(work, flow, threshold, minCells, minDropFt / 3.280839895)
    .map(p => ({ ...p, kind: 'ridge' }));
}

/**
 * Saddles: the low crossing point on a ridge, and the classic funnel — deer
 * cross a ridge at its cheapest point just as people do.
 *
 * Detected by walking a ring of neighbours at a fixed radius and counting how
 * many times the ground changes between higher and lower. A saddle alternates
 * exactly twice: up on two opposite sides (the ridge continuing) and down on
 * the other two (the ground falling away). A peak is up nowhere, a pit is up
 * everywhere, and a plain hillside changes once.
 *
 * `minRelief` is why this stays quiet on flat ground: a dip of a few inches is
 * arithmetic, not a saddle, and calling it one would send someone to sit over
 * nothing.
 */
export function saddles(grid, { radiusCells = 3, minReliefM = 1.5 } = {}) {
  const { cols, rows } = grid;
  const found = [];
  const ring = [];
  const steps = 16;
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * 2 * Math.PI;
    ring.push([Math.round(Math.cos(a) * radiusCells), Math.round(Math.sin(a) * radiusCells)]);
  }

  for (let r = radiusCells; r < rows - radiusCells; r++) {
    for (let c = radiusCells; c < cols - radiusCells; c++) {
      const z0 = elevationAtIndex(grid, c, r);
      if (!Number.isFinite(z0)) continue;

      const diffs = [];
      let ok = true;
      for (const [dc, dr] of ring) {
        const v = elevationAtIndex(grid, c + dc, r + dr);
        if (!Number.isFinite(v)) { ok = false; break; }
        diffs.push(v - z0);
      }
      if (!ok) continue;

      // How far up the ridge rises either side, and how far the ground falls.
      const up = Math.max(...diffs), down = Math.min(...diffs);
      if (up < minReliefM || -down < minReliefM) continue;

      let changes = 0;
      for (let s = 0; s < diffs.length; s++) {
        const a = diffs[s] > 0, b = diffs[(s + 1) % diffs.length] > 0;
        if (a !== b) changes++;
      }
      if (changes !== 4) continue;      // exactly two up sectors and two down

      const { lat, lng } = cellLatLng(grid, c, r);
      found.push({
        kind: 'saddle', lat, lng,
        // How much you save by crossing here rather than over the ridge.
        reliefFt: Math.round(metresToFeet(Math.min(up, -down)) * 10) / 10,
      });
    }
  }
  return thin(found, grid, radiusCells * 2);
}

/**
 * Benches: a flat shelf part-way up a slope. Deer bed on them, and travel
 * along them, because walking a level line costs less than climbing.
 *
 * A bench is flat ground that is NOT merely part of a flat landscape — the
 * definition requires real slope nearby. That distinction is the whole test,
 * and it is what keeps this silent on a uniformly gentle property instead of
 * reporting the entire field as one enormous bench.
 */
export function benches(grid, {
  maxSlopeDeg = 4, surroundMinSlopeDeg = 8, radiusCells = 4, minSurroundFraction = 0.35,
} = {}) {
  const { cols, rows } = grid;
  const { slope } = slopeAspect(grid);
  const found = [];

  for (let r = radiusCells; r < rows - radiusCells; r++) {
    for (let c = radiusCells; c < cols - radiusCells; c++) {
      const k = r * cols + c;
      if (!Number.isFinite(slope[k]) || slope[k] > maxSlopeDeg) continue;

      let steep = 0, seen = 0;
      for (let dr = -radiusCells; dr <= radiusCells; dr++) {
        for (let dc = -radiusCells; dc <= radiusCells; dc++) {
          const s = slope[(r + dr) * cols + (c + dc)];
          if (!Number.isFinite(s)) continue;
          seen++;
          if (s >= surroundMinSlopeDeg) steep++;
        }
      }
      if (!seen || steep / seen < minSurroundFraction) continue;

      const { lat, lng } = cellLatLng(grid, c, r);
      found.push({
        kind: 'bench', lat, lng,
        slopeDeg: Math.round(slope[k] * 10) / 10,
        steepAround: Math.round(100 * steep / seen),
      });
    }
  }
  return thin(found, grid, radiusCells * 2);
}

/**
 * Keep one point per cluster. Detectors fire on every cell of a feature, and a
 * bench forty cells across would otherwise arrive as forty pins on top of each
 * other.
 */
function thin(points, grid, minSeparationCells) {
  const kept = [];
  const dLat = grid.dLat * minSeparationCells, dLng = grid.dLng * minSeparationCells;
  for (const p of points) {
    const near = kept.some(q =>
      Math.abs(q.lat - p.lat) < dLat && Math.abs(q.lng - p.lng) < dLng);
    if (!near) kept.push(p);
  }
  return kept;
}

/**
 * Everything at once, with the honesty built in: `quiet` says outright that the
 * ground is too gentle for benches and saddles to mean anything, so the caller
 * can explain an empty result instead of leaving someone to wonder whether the
 * detector is broken.
 */
export function terrainFeatures(grid, opts = {}) {
  const stats = gridStats(grid);
  const { slope } = slopeAspect(grid);
  const slopes = [...slope].filter(Number.isFinite).sort((a, b) => a - b);
  const medianSlope = slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
  const steepEnough = slopes.length ? slopes.at(-1) >= 8 : false;

  return {
    drainages: drainages(grid, opts.drainage),
    ridges: ridges(grid, opts.ridge),
    // Skipped rather than run and returned empty: on ground with no slope
    // anywhere, these two detectors have nothing to say, and saying so is more
    // use than an empty list that looks like a failure.
    saddles: steepEnough ? saddles(grid, opts.saddle) : [],
    benches: steepEnough ? benches(grid, opts.bench) : [],
    quiet: !steepEnough,
    medianSlopeDeg: Math.round(medianSlope * 10) / 10,
    reliefFt: stats.relief === null ? null : Math.round(metresToFeet(stats.relief) * 10) / 10,
  };
}
