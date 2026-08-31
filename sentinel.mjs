/**
 * sentinel.mjs — how green a field is, this week, from Sentinel-2.
 *
 * The CDL (cropscan.mjs) is a year behind: the 2025 layer was published in
 * February 2026. That is fine for "what usually grows here" and useless for
 * "is the corn still standing". This module answers the second question from
 * imagery that is at most a few days old.
 *
 * The data is free and needs no account. Element 84's Earth Search catalogues
 * Sentinel-2 L2A, and the pixels themselves are public COGs on AWS Open Data,
 * read through cog.mjs a tile at a time. Revisit is about five days, so a
 * season yields thirty-odd looks at a field, of which the cloud-free ones make
 * a curve.
 *
 * WHAT IS MEASURED. NDVI, (nir - red) / (nir + red), from bands 8 and 4. It
 * saturates on a closed canopy and cannot tell a good corn crop from a great
 * one, but it falls off a cliff when a field is cut, which is the event worth
 * knowing about. Cloud, shadow and snow are removed using the scene's own
 * classification band rather than a whole-scene cloud percentage, because a
 * scene that is 40% cloudy may be perfectly clear over one small field.
 *
 * PROJECTION. Sentinel-2 is published in UTM, so lat/lng has to be projected
 * before a pixel can be found. The transverse Mercator series below is from
 * Snyder, the same source as the Albers in cropscan.mjs, and lives next to its
 * consumer for the same reason. The zone is taken from the scene's own MGRS
 * code rather than computed from the field's longitude: near a zone boundary a
 * tile legitimately covers ground that a longitude test would put in the next
 * zone over, and using the wrong zone silently lands the sample hundreds of
 * kilometres away.
 */

import { readHeader, valueAtPixel, pixelFor, centreOf } from './cog.mjs';

const CATALOGUE = 'https://earth-search.aws.element84.com/v1/search';
export const ENDPOINT = () => process.env.TRAILCAM_STAC_URL || CATALOGUE;

/**
 * Scene Classification values that are not usable ground:
 * 0 no data, 1 saturated, 3 cloud shadow, 8 cloud medium, 9 cloud high,
 * 10 thin cirrus, 11 snow. Vegetation (4), bare soil (5) and water (6) are
 * kept — a cut field reads as bare soil, which is the whole point.
 */
export const SCL_UNUSABLE = new Set([0, 1, 3, 8, 9, 10, 11]);

/** Beyond this many well-spread looks the curve stops changing shape. */
export const MAX_SCENES = 14;

/** A field needs this many clear pixels before its NDVI means anything. */
export const MIN_PIXELS = 8;

// --- projection ------------------------------------------------------------

const A = 6378137.0;                       // WGS84 semi-major axis
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const RAD = Math.PI / 180;

/** The UTM zone a longitude falls in, when no scene says otherwise. */
export const utmZone = lng => Math.floor((((lng + 180) % 360) + 360) % 360 / 6) + 1;

/**
 * WGS84 degrees -> UTM metres in a given zone. Snyder's series, good to
 * millimetres well beyond the 3 degrees either side of a meridian that a zone
 * actually spans.
 */
export function toUtm(lat, lng, zone = utmZone(lng)) {
  const phi = lat * RAD;
  const lam = lng * RAD;
  const lam0 = ((zone - 1) * 6 - 180 + 3) * RAD;

  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  // Normalised so a point just across the antimeridian doesn't blow up.
  let dl = lam - lam0;
  while (dl > Math.PI) dl -= 2 * Math.PI;
  while (dl < -Math.PI) dl += 2 * Math.PI;
  const Aa = dl * cos;

  const M = A * (
    (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));

  const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;

  let y = K0 * (M + N * tan * (Aa * Aa / 2
    + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  if (lat < 0) y += 10000000;

  return { x, y, zone };
}

// --- catalogue -------------------------------------------------------------

/** Bounding box of a [lng, lat] ring. */
export function ringBounds(ring) {
  const lngs = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  return {
    west: Math.min(...lngs), east: Math.max(...lngs),
    south: Math.min(...lats), north: Math.max(...lats),
  };
}

/** Centre of a ring's bounding box, as [lng, lat]. */
export const ringCentre = (ring) => {
  const b = ringBounds(ring);
  return [(b.west + b.east) / 2, (b.south + b.north) / 2];
};

/**
 * Even-odd point-in-polygon on the ring's own coordinates. Fields are small
 * enough that treating lat/lng as planar for the inside test is exact enough;
 * the pixel grid it is applied to is metres, and the ring is converted first.
 */
export function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y)
      && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Scenes covering a ring, newest last, thinned to a manageable spread.
 *
 * Only one MGRS tile is kept — whichever covers the field most often — so
 * every scene shares a grid and a zone. A few-acre field is never split
 * across tiles, and mixing them would mean reprojecting per scene.
 */
export async function searchScenes(ring, {
  start, end, maxCloud = 70, limit = 200, maxScenes = MAX_SCENES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const [lng, lat] = ringCentre(ring);
  const res = await fetchImpl(ENDPOINT(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      intersects: { type: 'Point', coordinates: [lng, lat] },
      datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: maxCloud } },
      limit,
    }),
  });
  if (!res.ok) throw new Error(`the imagery catalogue answered HTTP ${res.status}`);
  const body = await res.json();
  const features = body.features ?? [];
  if (!features.length) return [];

  const byTile = new Map();
  for (const f of features) {
    const code = f.properties?.['grid:code'] ?? f.id?.split('_')[1] ?? '?';
    if (!byTile.has(code)) byTile.set(code, []);
    byTile.get(code).push(f);
  }
  let best = [];
  for (const list of byTile.values()) if (list.length > best.length) best = list;

  best.sort((a, b) => a.properties.datetime.localeCompare(b.properties.datetime));
  return thin(best, maxScenes).map(shapeScene);
}

/** The fields of a STAC item this module actually uses. */
export function shapeScene(f) {
  const code = f.properties?.['grid:code'] ?? f.id?.split('_')[1] ?? '';
  const digits = /(\d{1,2})[A-Z]{3}$/.exec(code.replace(/^MGRS-/, ''));
  return {
    id: f.id,
    date: f.properties.datetime.slice(0, 10),
    cloud: f.properties['eo:cloud_cover'] ?? null,
    zone: digits ? Number(digits[1]) : null,
    red: f.assets?.red?.href ?? null,
    nir: f.assets?.nir?.href ?? null,
    scl: f.assets?.scl?.href ?? null,
  };
}

/**
 * Subsample scenes evenly across time, preferring the clearest in each
 * neighbourhood. Taking the first N would bunch every look into spring and
 * miss the senescence the curve exists to show.
 */
export function thin(scenes, keep) {
  if (!keep || scenes.length <= keep) return scenes;
  const picked = [], taken = new Set();
  for (let i = 0; i < keep; i++) {
    const target = (scenes.length - 1) * (i / (keep - 1));
    const lo = Math.max(0, Math.floor(target) - 1);
    const hi = Math.min(scenes.length, Math.ceil(target) + 2);
    let bestAt = -1, bestCloud = Infinity, bestGap = Infinity;
    for (let j = lo; j < hi; j++) {
      if (taken.has(j)) continue;
      const c = scenes[j].properties?.['eo:cloud_cover'] ?? scenes[j].cloud ?? 100;
      const gap = Math.abs(j - target);
      // Clearest wins; on a tie take the one nearest the slot being filled, or
      // the first and last scenes lose to their neighbours and the curve
      // quietly loses its green-up and senescence ends.
      if (c < bestCloud || (c === bestCloud && gap < bestGap)) {
        bestCloud = c; bestGap = gap; bestAt = j;
      }
    }
    if (bestAt >= 0) { taken.add(bestAt); picked.push(scenes[bestAt]); }
  }
  return picked.sort((a, b) => {
    const da = a.properties?.datetime ?? a.date;
    const db = b.properties?.datetime ?? b.date;
    return da.localeCompare(db);
  });
}

// --- measurement -----------------------------------------------------------

/**
 * Mean NDVI inside a ring for one scene.
 *
 * Returns nulls rather than numbers when the field is too clouded to judge —
 * a wrong NDVI here becomes a wrong harvest date later, so an absent reading
 * is much cheaper than a confident bad one.
 */
export async function ndviForScene(scene, ring, { fetchImpl = globalThis.fetch } = {}) {
  if (!scene.red || !scene.nir) throw new Error(`scene ${scene.id} has no red/nir asset`);

  const red = await readHeader(scene.red, { fetchImpl });
  const nir = await readHeader(scene.nir, { fetchImpl });
  const scl = scene.scl ? await readHeader(scene.scl, { fetchImpl }) : null;

  const zone = scene.zone ?? utmZone(ringCentre(ring)[0]);
  const ringM = ring.map(([lng, lat]) => {
    const { x, y } = toUtm(lat, lng, zone);
    return [x, y];
  });
  const xs = ringM.map(p => p[0]), ys = ringM.map(p => p[1]);
  const box = {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };

  const topLeft = pixelFor(red, box.minX, box.maxY);
  const botRight = pixelFor(red, box.maxX, box.minY);
  const col0 = Math.min(topLeft.col, botRight.col);
  const col1 = Math.max(topLeft.col, botRight.col);
  const row0 = Math.min(topLeft.row, botRight.row);
  const row1 = Math.max(topLeft.row, botRight.row);

  let clear = 0, clouded = 0, missing = 0, outside = 0;
  const values = [];
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const c = centreOf(red, col, row);
      if (!inRing(ringM, c.x, c.y)) { outside++; continue; }

      const r = await valueAtPixel(red, col, row);
      const n = await valueAtPixel(nir, col, row);
      // Off the edge of the image is a different failure from cloud, and
      // conflating them hides a field that is in the wrong place entirely.
      if (r === null || n === null) { missing++; continue; }

      if (scl) {
        const px = pixelFor(scl, c.x, c.y);
        const klass = await valueAtPixel(scl, px.col, px.row);
        if (klass === null) { missing++; continue; }
        if (SCL_UNUSABLE.has(klass)) { clouded++; continue; }
      }
      if (r + n === 0) { clouded++; continue; }
      values.push((n - r) / (n + r));
      clear++;
    }
  }

  const covered = clear + clouded;          // pixels the scene actually holds
  return {
    date: scene.date,
    id: scene.id,
    pixels: covered,
    clear,
    clouded,
    missing,
    clearFraction: covered ? clear / covered : 0,
    ndvi: clear >= MIN_PIXELS ? median(values) : null,
    why: clear >= MIN_PIXELS ? null
      : (covered === 0
        ? 'the field does not fall inside this scene'
        : `only ${clear} of ${covered} pixels were cloud-free`),
    outside,
  };
}

/** Median, which shrugs off the odd bright pixel a mean would follow. */
export function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The NDVI curve for a field across a season: one reading per usable scene,
 * oldest first. Scenes that fail are recorded with their reason rather than
 * dropped, so a caller can tell "nothing grew" from "we never got a look".
 */
export async function ndviSeries(ring, scenes, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    try {
      out.push(await ndviForScene(scenes[i], ring, { fetchImpl }));
    } catch (err) {
      out.push({
        date: scenes[i].date, id: scenes[i].id, pixels: 0, clear: 0,
        clouded: 0, missing: 0, clearFraction: 0, ndvi: null,
        why: err.message, outside: 0,
      });
    }
    onProgress?.(i + 1, scenes.length);
  }
  return out;
}
