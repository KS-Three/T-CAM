/**
 * terrain.mjs — the shape of the ground.
 *
 * The paid hunting apps make a lot of noise about LiDAR terrain, and they are
 * right to: on ground like Kent's, deer movement is governed by structure you
 * cannot see on satellite imagery. A bench three feet high, a drainage barely
 * worth the name, the low point in a fence line — that is where the trail is.
 *
 * It turns out none of this needs paying for. The USGS 3D Elevation Program
 * publishes bare-earth LiDAR nationally, free and keyless, and at Kent's
 * property it answers at ONE METRE resolution. This module turns that into
 * something a hunter can look at: a contour map, slope and aspect, and (in
 * terrain-features.mjs) the landforms that concentrate movement.
 *
 * How the data is fetched, and why this way:
 *
 * The service samples points rather than shipping a raster, which is a gift —
 * decoding GeoTIFF or LERC would mean a dependency, and this project has none.
 * A multipoint query returns values in the order they were asked for, so we
 * define the lattice ourselves and never have to resample somebody else's.
 *
 * Two measured limits shape the code (both probed against the live service,
 * 2026-08-27): a request returns AT MOST 1000 samples however many are asked
 * for, and the geometry must be POSTed — a lattice of any size overflows a URL
 * and comes back 414. Hence batches of 900, posted.
 *
 * Elevations are metres, as the service returns them. Feet are a display
 * concern and are converted at the edge, not stored.
 */

const DEFAULT_ENDPOINT =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';

export const ENDPOINT = () => process.env.TRAILCAM_ELEVATION_URL || DEFAULT_ENDPOINT;

// Measured, not guessed: the service caps a response at 1000 samples whatever
// sampleCount asks for. 900 leaves headroom and keeps each POST comfortable.
export const BATCH = 900;

export const M_PER_DEG_LAT = 110540;
export const mPerDegLng = lat => 111320 * Math.cos(lat * Math.PI / 180);

export const metresToFeet = m => m * 3.280839895;

/**
 * A grid is a plain object so it can be cached, serialised and tested without
 * ceremony:
 *
 *   { west, south, cols, rows, dLat, dLng, spacingM, z }
 *
 * `z` is a Float32Array in row-major order and **row 0 is the SOUTH edge**,
 * with r increasing northward. That is the mathematical convention rather than
 * the image one, and it is chosen deliberately: every gradient, slope and
 * aspect calculation below reads naturally in it, and only rendering has to
 * flip, which it does once. Getting this backwards silently mirrors every
 * aspect by 180 degrees — which would point every thermal the wrong way — so
 * it is stated here rather than left to be inferred.
 *
 * A cell with no data (outside LiDAR coverage, or over water) is NaN, never 0.
 * Zero is a real elevation and would read as a sea-level pit in the middle of
 * Wisconsin.
 */
export function planGrid({ west, south, east, north }, spacingM = 10) {
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error('terrain grid needs finite bounds');
  }
  if (east <= west || north <= south) throw new Error('terrain bounds are inside out');
  if (!(spacingM > 0)) throw new Error('terrain grid needs a positive spacing');

  const midLat = (north + south) / 2;
  const dLat = spacingM / M_PER_DEG_LAT;
  const dLng = spacingM / mPerDegLng(midLat);
  const cols = Math.max(2, Math.round((east - west) / dLng) + 1);
  const rows = Math.max(2, Math.round((north - south) / dLat) + 1);
  return { west, south, cols, rows, dLat, dLng, spacingM, z: null };
}

/** Coordinates of one lattice point. */
export function cellLatLng(grid, c, r) {
  return { lng: grid.west + c * grid.dLng, lat: grid.south + r * grid.dLat };
}

export const gridBounds = g => ({
  west: g.west, south: g.south,
  east: g.west + (g.cols - 1) * g.dLng,
  north: g.south + (g.rows - 1) * g.dLat,
});

/** Elevation at a lattice index, or NaN outside the grid. */
export function elevationAtIndex(grid, c, r) {
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return NaN;
  return grid.z[r * grid.cols + c];
}

/**
 * Elevation at an arbitrary point, bilinearly interpolated. Returns NaN rather
 * than a plausible-looking number when any corner it would need is missing.
 */
export function elevationAt(grid, lat, lng) {
  const fc = (lng - grid.west) / grid.dLng;
  const fr = (lat - grid.south) / grid.dLat;
  const c = Math.floor(fc), r = Math.floor(fr);
  if (c < 0 || r < 0 || c >= grid.cols - 1 || r >= grid.rows - 1) return NaN;
  const tx = fc - c, ty = fr - r;
  const z00 = elevationAtIndex(grid, c, r), z10 = elevationAtIndex(grid, c + 1, r);
  const z01 = elevationAtIndex(grid, c, r + 1), z11 = elevationAtIndex(grid, c + 1, r + 1);
  if (![z00, z10, z01, z11].every(Number.isFinite)) return NaN;
  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty)
       + z01 * (1 - tx) * ty + z11 * tx * ty;
}

/**
 * The service returns values as strings, and marks no-data in more than one
 * way depending on the raster. Anything not a sane terrestrial elevation
 * becomes NaN — Mount Everest is 8849 m and the Dead Sea shore is -430 m, so
 * this window is generous while still rejecting the -3.4e38 no-data sentinel.
 */
export function parseElevation(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -500 || n > 9000) return NaN;
  return n;
}

/**
 * Fill the grid from the elevation service.
 *
 * `onProgress` reports batches done and total so a caller can say something
 * while a large area is fetched; a 1 km square at 10 m is a dozen requests and
 * roughly twenty seconds, which is long enough to need saying.
 */
export async function fetchElevationGrid(bounds, {
  spacingM = 10, signal, onProgress = null, fetchImpl = globalThis.fetch,
  concurrency = 4,
} = {}) {
  const grid = planGrid(bounds, spacingM);
  const total = grid.cols * grid.rows;
  if (total > 250_000) {
    // A guard rather than a preference: at ~1.4 s per 900 points this would be
    // a six-minute fetch, and the caller has almost certainly asked for a whole
    // county by accident.
    throw new Error(
      `that area needs ${total.toLocaleString()} samples at ${spacingM} m spacing; `
      + 'ask for a smaller area or a coarser spacing');
  }
  grid.z = new Float32Array(total).fill(NaN);

  const batches = Math.ceil(total / BATCH);

  // Batches run several at a time, because the round trips ARE the wait:
  // measured at 95% of it, against 146 ms for every piece of terrain maths
  // combined. Sequentially a typical patch was about a minute of staring at a
  // button — long enough that the first version felt broken.
  //
  // Four at a time. It was briefly three, out of caution about rate limiting a
  // free service; the retry-with-backoff below now handles a 429 properly, so
  // the caution is spent in the right place and the ceiling can go back up.
  // It is still a deliberate ceiling and not a value to raise casually.
  let done = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const b = next++;
      if (b >= batches) return;
      await fetchBatch(grid, b, { signal, fetchImpl });
      onProgress?.({ done: ++done, of: batches });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches) }, () => worker()));
  return grid;
}

/**
 * A public service under load answers 429 or 503 rather than failing outright,
 * and a single one of those used to abort the whole grid — turning a momentary
 * hiccup into "terrain fetch failed" with sixteen batches thrown away. Retried
 * with backoff, honouring Retry-After when the service sends one.
 */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const RETRIES = 3;

const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchBatch(grid, b, { signal, fetchImpl, attempt = 0 }) {
  const total = grid.cols * grid.rows;
  const start = b * BATCH;
  const end = Math.min(total, start + BATCH);
  const points = [];
  for (let i = start; i < end; i++) {
    const { lat, lng } = cellLatLng(grid, i % grid.cols, Math.floor(i / grid.cols));
    points.push([lng, lat]);
  }

  const body = new URLSearchParams({
    geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryMultipoint',
    returnFirstValueOnly: 'true',
    f: 'json',
  });
  // POSTed because the lattice does not fit in a URL — a GET returns 414.
  let res;
  try {
    res = await fetchImpl(ENDPOINT(), {
      method: 'POST', body, signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Public services are entitled to know who is calling them.
        'user-agent': 'TrailCam/1.0 (personal trail-camera tool)',
      },
    });
  } catch (err) {
    // A dropped connection is exactly the kind of thing worth one more try.
    if (attempt < RETRIES && !signal?.aborted) {
      await wait(500 * 2 ** attempt);
      return fetchBatch(grid, b, { signal, fetchImpl, attempt: attempt + 1 });
    }
    throw new Error(`could not reach the elevation service: ${err.message}`);
  }

  if (!res.ok) {
    if (RETRY_STATUS.has(res.status) && attempt < RETRIES) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(10_000, retryAfter * 1000)
        : 500 * 2 ** attempt;
      await wait(delay);
      return fetchBatch(grid, b, { signal, fetchImpl, attempt: attempt + 1 });
    }
    throw new Error(
      `elevation service returned HTTP ${res.status}`
      + (res.status === 429 ? ' (rate limited — try a smaller area)' : ''));
  }
  const json = await res.json();
  // ArcGIS reports its own failures inside a 200, so the status code alone
  // would turn a broken service into a grid of quiet NaNs.
  if (json?.error) {
    throw new Error(`elevation service error: ${json.error.message ?? 'unknown'}`);
  }

  for (const s of json.samples ?? []) {
    // locationId is the index within THIS batch's point list, which is why the
    // batch is built in grid order and offset back here.
    const idx = start + Number(s.locationId);
    if (idx >= start && idx < end) grid.z[idx] = parseElevation(s.value);
  }
}

/**
 * Slope in degrees and aspect in compass degrees (the direction the ground
 * FACES, i.e. downhill), by the Horn method — the same third-order finite
 * difference ArcGIS and GDAL use, so numbers here are comparable to any other
 * tool rather than being our own invention.
 *
 * Aspect is NaN on genuinely flat ground, because a flat cell does not face
 * anywhere and pretending it faces north would put a thermal on it.
 */
export function slopeAspect(grid) {
  const { cols, rows, spacingM } = grid;
  const slope = new Float32Array(cols * rows).fill(NaN);
  const aspect = new Float32Array(cols * rows).fill(NaN);
  const at = (c, r) => elevationAtIndex(grid, c, r);

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const a = at(c - 1, r + 1), b = at(c, r + 1), d = at(c + 1, r + 1);
      const e = at(c - 1, r), g = at(c + 1, r);
      const h = at(c - 1, r - 1), i = at(c, r - 1), j = at(c + 1, r - 1);
      if (![a, b, d, e, g, h, i, j].every(Number.isFinite)) continue;

      // dzdx east-positive, dzdy north-positive (row 0 is south — see planGrid).
      const dzdx = ((d + 2 * g + j) - (a + 2 * e + h)) / (8 * spacingM);
      const dzdy = ((a + 2 * b + d) - (h + 2 * i + j)) / (8 * spacingM);
      const k = r * cols + c;
      const rise = Math.hypot(dzdx, dzdy);
      slope[k] = Math.atan(rise) * 180 / Math.PI;
      if (rise < 1e-9) continue;               // flat: no aspect, deliberately
      // Downslope direction as a compass bearing: the ground faces the way the
      // surface descends, which is the negative gradient.
      let deg = Math.atan2(-dzdx, -dzdy) * 180 / Math.PI;
      aspect[k] = (deg + 360) % 360;
    }
  }
  return { slope, aspect };
}

/** Mean and range of a grid, ignoring no-data. Used to choose contour levels. */
export function gridStats(grid) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  const vals = [];
  for (const v of grid.z) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
    vals.push(v);
  }
  if (!n) {
    return { min: null, max: null, mean: null, relief: null, typicalRelief: null, count: 0 };
  }
  vals.sort((a, b) => a - b);
  const at = p => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return {
    min, max, mean: sum / n, relief: max - min, count: n,
    p5: at(0.05), p95: at(0.95),
    /**
     * The relief of the ground you are mostly looking at, ignoring the extremes.
     *
     * This exists because max-minus-min is the wrong number to choose a contour
     * interval from. Pan far enough to catch the bluff running down to Green
     * Lake and the total relief jumps to 184 ft, which picks a 20 ft interval —
     * and the flat ground you actually hunt, all 12 ft of it, gets NO contour
     * lines at all. The bluff is 5% of the view and was deciding what the other
     * 95% could show.
     */
    typicalRelief: at(0.95) - at(0.05),
  };
}

/**
 * Pick a contour interval that actually shows something.
 *
 * A fixed 10 ft interval is useless on Kent's ground — a 300 m box there has
 * under 9 ft of relief, so it would draw one line, or none. The interval is
 * therefore chosen from the relief actually present, aiming for roughly a
 * dozen lines, and snapped to a value a person can read off a legend.
 */
export const CONTOUR_STEPS_FT = [1, 2, 5, 10, 20, 40, 100];

export function chooseIntervalFt(reliefM, target = 12) {
  const reliefFt = metresToFeet(reliefM ?? 0);
  if (!(reliefFt > 0)) return CONTOUR_STEPS_FT[0];
  const ideal = reliefFt / target;
  return CONTOUR_STEPS_FT.find(s => s >= ideal) ?? CONTOUR_STEPS_FT.at(-1);
}

/**
 * Contours by marching squares.
 *
 * Each cell contributes zero, one or two segments per level; segments are then
 * stitched end-to-end into polylines so the map draws a few long paths instead
 * of thousands of disconnected hairs. Cells touching no-data are skipped
 * entirely rather than interpolated across, so a contour never bridges a hole
 * in coverage and invents a ridge that is not there.
 *
 * Levels are computed in FEET because that is what the legend shows and what a
 * hunter thinks in, then converted for comparison against the metric grid.
 */
export function contourLines(grid, { intervalFt = null, maxLevels = 60 } = {}) {
  const stats = gridStats(grid);
  if (!stats.count || !(stats.relief > 0)) return { intervalFt: null, lines: [] };

  // Chosen from the ground you are mostly looking at, not from its extremes —
  // see typicalRelief in gridStats for why.
  let step = intervalFt ?? chooseIntervalFt(stats.typicalRelief || stats.relief);

  // Then widened until the FULL range fits. The loop below used to stop at
  // maxLevels and say nothing, which silently dropped every contour above the
  // cut — the top of a map quietly losing its lines is worse than a coarser
  // interval, because nothing about it looks wrong.
  const levelsNeeded = st => Math.ceil(metresToFeet(stats.relief) / st);
  if (!intervalFt) {
    for (const candidate of CONTOUR_STEPS_FT) {
      if (candidate < step) continue;
      step = candidate;
      if (levelsNeeded(step) <= maxLevels) break;
    }
  }
  const stepM = step / 3.280839895;

  const first = Math.ceil(stats.min / stepM) * stepM;
  const levels = [];
  for (let v = first; v <= stats.max && levels.length < maxLevels; v += stepM) levels.push(v);

  const lines = [];
  for (const level of levels) {
    const segments = [];
    for (let r = 0; r < grid.rows - 1; r++) {
      for (let c = 0; c < grid.cols - 1; c++) {
        const z00 = elevationAtIndex(grid, c, r);
        const z10 = elevationAtIndex(grid, c + 1, r);
        const z11 = elevationAtIndex(grid, c + 1, r + 1);
        const z01 = elevationAtIndex(grid, c, r + 1);
        if (![z00, z10, z11, z01].every(Number.isFinite)) continue;
        marchCell(grid, c, r, [z00, z10, z11, z01], level, segments);
      }
    }
    for (const path of stitch(segments)) {
      lines.push({ levelM: level, levelFt: Math.round(metresToFeet(level)), path });
    }
  }
  return { intervalFt: step, lines };
}

// Corner order is counter-clockwise from the south-west: 0 = (c,r),
// 1 = (c+1,r), 2 = (c+1,r+1), 3 = (c,r+1).
function marchCell(grid, c, r, z, level, out) {
  const [z00, z10, z11, z01] = z;
  const code = (z00 > level ? 1 : 0) | (z10 > level ? 2 : 0)
             | (z11 > level ? 4 : 0) | (z01 > level ? 8 : 0);
  if (code === 0 || code === 15) return;

  const lng = i => grid.west + i * grid.dLng;
  const lat = j => grid.south + j * grid.dLat;
  const t = (a, b) => (level - a) / (b - a);
  // Edge midpoints, interpolated: S = south, E = east, N = north, W = west.
  const S = () => [lng(c + t(z00, z10)), lat(r)];
  const E = () => [lng(c + 1), lat(r + t(z10, z11))];
  const N = () => [lng(c + t(z01, z11)), lat(r + 1)];
  const W = () => [lng(c), lat(r + t(z00, z01))];

  switch (code) {
    case 1: case 14: out.push([W(), S()]); break;
    case 2: case 13: out.push([S(), E()]); break;
    case 3: case 12: out.push([W(), E()]); break;
    case 4: case 11: out.push([E(), N()]); break;
    case 6: case 9:  out.push([S(), N()]); break;
    case 7: case 8:  out.push([W(), N()]); break;
    // The two ambiguous saddle cases. Resolved by the cell's mean, which is the
    // usual convention; picking arbitrarily here is what produces the crossed
    // "bowtie" contours you see in careless implementations.
    case 5: {
      const mid = (z00 + z10 + z11 + z01) / 4;
      if (mid > level) { out.push([W(), N()]); out.push([S(), E()]); }
      else { out.push([W(), S()]); out.push([E(), N()]); }
      break;
    }
    case 10: {
      const mid = (z00 + z10 + z11 + z01) / 4;
      if (mid > level) { out.push([W(), S()]); out.push([E(), N()]); }
      else { out.push([W(), N()]); out.push([S(), E()]); }
      break;
    }
  }
}

// Join segments into polylines. Endpoints are matched on a rounded key: they
// come from identical arithmetic on shared cell edges, so they agree to well
// within this tolerance, and rounding avoids float equality entirely.
function stitch(segments) {
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const ends = new Map();
  const add = (k, seg) => {
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push(seg);
  };
  const segs = segments.map(s => ({ pts: s, used: false }));
  for (const s of segs) { add(key(s.pts[0]), s); add(key(s.pts.at(-1)), s); }

  const paths = [];
  for (const seed of segs) {
    if (seed.used) continue;
    seed.used = true;
    const path = [...seed.pts];
    // Grow from both ends until nothing else connects.
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? path.at(-1) : path[0];
        const next = (ends.get(key(tip)) ?? []).find(s => !s.used);
        if (!next) break;
        next.used = true;
        const a = next.pts[0], b = next.pts.at(-1);
        const grow = key(a) === key(tip) ? b : a;
        if (forward) path.push(grow); else path.unshift(grow);
      }
    }
    if (path.length > 1) paths.push(path);
  }
  return paths;
}

/**
 * Hillshade — the picture that makes subtle ground readable.
 *
 * The national shaded-relief basemaps are built for mountains. Pointed at
 * ground with twelve feet of relief across six hundred metres they render an
 * even grey, which is why this computes its own from the DEM instead of
 * borrowing a tile service.
 *
 * The whole trick is vertical exaggeration. Real hillshade of Kent's property
 * at a z-factor of 1 is blank; at 30 the drainages and benches stand out. So
 * the exaggeration is chosen from the relief actually present rather than
 * fixed, and it is REPORTED alongside the image — an exaggerated hillshade is
 * a diagram, not a photograph, and a reader who does not know the factor will
 * badly misjudge how steep the ground is.
 *
 * Standard illumination: from the north-west, 45 degrees up. It is the
 * cartographic convention, and it matters — lighting terrain from the
 * south-east makes ridges read as valleys to most eyes.
 */
export function autoZFactor(grid, stats = gridStats(grid)) {
  if (!stats.count || !(stats.relief > 0)) return 1;
  const widthM = (grid.cols - 1) * grid.spacingM;
  // Aim to present the whole grid as if it had a ~15% overall grade, which is
  // the range where hillshade has the most contrast without looking molten.
  const z = 0.15 * widthM / stats.relief;
  return Math.min(60, Math.max(1, z));
}

export function hillshade(grid, {
  zFactor = null, azimuthDeg = 315, altitudeDeg = 45,
} = {}) {
  const stats = gridStats(grid);
  const z = zFactor ?? autoZFactor(grid, stats);
  const { cols, rows, spacingM } = grid;
  const shade = new Uint8ClampedArray(cols * rows);
  const alpha = new Uint8ClampedArray(cols * rows);

  // Illumination is a plain dot product between the surface normal and the
  // direction of the light, rather than the trigonometric identity the GIS
  // texts write it as. The identity is easy to transcribe with the aspect
  // convention inverted, which lights the terrain from the south-east and makes
  // every ridge read as a valley; the first version of this function did
  // exactly that. This form can be checked by hand against a ridge, and is.
  //
  // azimuthDeg is the compass direction the light COMES FROM, so the vector
  // pointing from the ground toward the sun is (east, north, up):
  const altRad = altitudeDeg * Math.PI / 180;
  const azRad = azimuthDeg * Math.PI / 180;
  const lx = Math.sin(azRad) * Math.cos(altRad);
  const ly = Math.cos(azRad) * Math.cos(altRad);
  const lz = Math.sin(altRad);
  const at = (c, r) => elevationAtIndex(grid, c, r);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Clamp at the edges rather than skipping, so the shaded image covers the
      // whole grid instead of leaving a transparent one-cell frame.
      const cc = Math.min(cols - 2, Math.max(1, c));
      const rr = Math.min(rows - 2, Math.max(1, r));
      const a = at(cc - 1, rr + 1), b = at(cc, rr + 1), d = at(cc + 1, rr + 1);
      const e = at(cc - 1, rr), g = at(cc + 1, rr);
      const h = at(cc - 1, rr - 1), i = at(cc, rr - 1), j = at(cc + 1, rr - 1);
      const k = r * cols + c;
      if (![a, b, d, e, g, h, i, j].every(Number.isFinite)) { alpha[k] = 0; continue; }

      const dzdx = z * ((d + 2 * g + j) - (a + 2 * e + h)) / (8 * spacingM);
      const dzdy = z * ((a + 2 * b + d) - (h + 2 * i + j)) / (8 * spacingM);
      // Surface normal of z(east, north) is (-dz/dx, -dz/dy, 1), normalised.
      const norm = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      const v = (-dzdx * lx - dzdy * ly + lz) / norm;
      shade[k] = Math.round(255 * Math.max(0, v));
      alpha[k] = 255;
    }
  }
  return { shade, alpha, cols, rows, zFactor: z, relief: stats.relief };
}

/**
 * The elevations themselves, packed for the wire.
 *
 * The 3D view needs the raw grid in the browser, and Float64 JSON would be
 * megabytes of digits the source data cannot back — 3DEP is good to about a
 * tenth of a metre. Quantized to 65,534 steps across the grid's own relief
 * the worst-case error on this ground is millimetres, and the payload is two
 * bytes a sample before base64.
 *
 * Bytes are written little-endian BY HAND rather than through the platform's
 * typed-array memory, so the format is the format wherever this runs. 0xFFFF
 * marks a hole — water, or ground 3DEP has not flown — because zero is a real
 * elevation and would read as a sea-level pit in the middle of Wisconsin.
 * terrain3d.mjs owns the matching unpack, and a test round-trips the pair.
 */
export function packElevations(grid, stats = gridStats(grid)) {
  const n = grid.cols * grid.rows;
  const min = Number.isFinite(stats.min) ? stats.min : 0;
  const relief = (Number.isFinite(stats.max) ? stats.max : min) - min;
  const scale = relief > 0 ? relief / 65534 : 1;
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const z = grid.z[i];
    const q = Number.isFinite(z)
      ? Math.max(0, Math.min(65534, Math.round((z - min) / scale)))
      : 65535;
    bytes[2 * i] = q & 255;
    bytes[2 * i + 1] = q >> 8;
  }
  return { bytes, min, scale };
}

/**
 * Slope and aspect at one point, from the nearest lattice cell.
 *
 * Nearest-cell rather than interpolated on purpose: aspect is an angle that
 * wraps at 360, and averaging 350 with 10 gives 180 — the exact opposite of the
 * right answer. Interpolating slope alone would be fine; doing one and not the
 * other invites someone to "fix" the inconsistency later.
 */
export function slopeAspectAt(grid, lat, lng, precomputed = null) {
  const { slope, aspect } = precomputed ?? slopeAspect(grid);
  const c = Math.round((lng - grid.west) / grid.dLng);
  const r = Math.round((lat - grid.south) / grid.dLat);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return null;
  const k = r * grid.cols + c;
  const s = slope[k];
  if (!Number.isFinite(s)) return null;
  return {
    slopeDeg: s,
    // NaN aspect is flat ground, which genuinely faces nowhere.
    aspectDeg: Number.isFinite(aspect[k]) ? aspect[k] : null,
  };
}
