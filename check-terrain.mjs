#!/usr/bin/env node
/**
 * check-terrain.mjs — why is terrain not loading?
 *
 *   node --disable-warning=ExperimentalWarning check-terrain.mjs
 *   node --disable-warning=ExperimentalWarning check-terrain.mjs --lat 44.125 --lng -90.651
 *
 * "Terrain fetch failed" in the browser is one line with no diagnosis behind
 * it. This walks the same path the server takes, one step at a time, and says
 * which step broke — so the answer is "your network blocks the USGS service"
 * or "this ground has no LiDAR coverage" rather than a shrug.
 */

import process from 'node:process';
import path from 'node:path';
import {
  ENDPOINT, fetchElevationGrid, gridStats, metresToFeet, contourLines, planGrid,
} from './terrain.mjs';

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

// Somewhere with known-good coverage, so a failure here is about YOUR network
// rather than about your ground.
const lat = Number(val('--lat', '44.125683'));
const lng = Number(val('--lng', '-90.651735'));
const out = path.resolve(val('--out', process.env.SPYPOINT_OUT || './spypoint-data'));

const ok = m => console.log(`  ✓ ${m}`);
const bad = m => console.log(`  ✗ ${m}`);

console.log(`\nChecking terrain at ${lat}, ${lng}`);
console.log(`Elevation service: ${ENDPOINT()}\n`);

let failed = false;

// 1. Can we reach the service at all?
console.log('1. Reaching the elevation service');
try {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT().replace(/\/getSamples$/, '') + '?f=json', {
    headers: { 'user-agent': 'TrailCam/1.0 (personal trail-camera tool)' },
  });
  if (!res.ok) {
    bad(`the service answered HTTP ${res.status}`);
    failed = true;
  } else {
    await res.json();
    ok(`reachable, ${Date.now() - t0} ms`);
  }
} catch (err) {
  bad(`could not reach it: ${err.message}`);
  console.log('    This is a network problem, not a TrailCam one. A firewall, a');
  console.log('    VPN, or a proxy between you and elevation.nationalmap.gov.');
  failed = true;
}

// 2. Does one small grid actually come back?
if (!failed) {
  console.log('\n2. Fetching a small grid (about 200 m across)');
  const dLat = 100 / 110540, dLng = 100 / (111320 * Math.cos(lat * Math.PI / 180));
  try {
    const t0 = Date.now();
    const grid = await fetchElevationGrid(
      { west: lng - dLng, south: lat - dLat, east: lng + dLng, north: lat + dLat },
      { spacingM: 10, onProgress: p => process.stdout.write(`\r    batch ${p.done}/${p.of}`) });
    const st = gridStats(grid);
    process.stdout.write('\r');
    ok(`${grid.cols}x${grid.rows} grid in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!st.count) {
      bad('every cell came back empty — no LiDAR coverage at this spot');
      console.log('    That is a real answer, not a fault. Try --lat/--lng somewhere else.');
      failed = true;
    } else {
      ok(`${st.count}/${grid.cols * grid.rows} cells have data`);
      ok(`elevation ${metresToFeet(st.min).toFixed(1)}–${metresToFeet(st.max).toFixed(1)} ft`
         + ` (${metresToFeet(st.relief).toFixed(1)} ft of relief)`);
      const c = contourLines(grid);
      ok(`contours: ${c.lines.length} paths at a ${c.intervalFt} ft interval`);
    }
  } catch (err) {
    process.stdout.write('\r');
    bad(err.message);
    failed = true;
  }
}

// 3. Can the database hold the result?
console.log('\n3. Checking the database can cache terrain');
try {
  const { openDb, saveTerrainGrid, allTerrainGrids, schemaVersion } = await import('./db.mjs');
  const db = openDb(out);
  const v = schemaVersion(db);
  if (v < 3) {
    bad(`schema is at version ${v}; terrain needs 3 or later`);
    failed = true;
  } else {
    ok(`schema version ${v}`);
    const g = planGrid({ west: lng, south: lat, east: lng + 0.001, north: lat + 0.001 }, 50);
    g.z = new Float32Array(g.cols * g.rows).fill(200);
    const id = saveTerrainGrid(db, g);
    ok(`wrote and read back a test grid (id ${id})`);
    db.prepare('DELETE FROM terrain_grids WHERE id = ?').run(id);
    ok(`${allTerrainGrids(db).length} terrain grids cached in ${out}`);
  }
  db.close();
} catch (err) {
  bad(`database problem: ${err.message}`);
  failed = true;
}

console.log(failed
  ? '\nSomething above is broken — the first ✗ is the one that matters.\n'
  : '\nAll good. Terrain should load in the browser; if it does not, the problem\n'
    + 'is in the page rather than the data — check the window running the server\n'
    + 'for a "Terrain failed" line.\n');
process.exitCode = failed ? 1 : 0;
