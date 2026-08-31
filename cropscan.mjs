/**
 * cropscan.mjs — what USDA's satellite crop map says grows at a point.
 *
 * The USDA NASS Cropland Data Layer classifies every 30 m of the country each
 * season from satellite imagery, and CropScape exposes it as a free point
 * lookup — no key, no account, same terms as the parcel and elevation
 * services already used here. That is what "automatically recognise the
 * crop" honestly amounts to at zero dependencies: when you outline a field,
 * the form asks this and pre-selects the crop it names, and you correct it
 * if the satellite is wrong.
 *
 * What this deliberately does NOT do is trace field boundaries for you.
 * Extracting an outline from the CDL raster means fetching and decoding a
 * GeoTIFF and vectorising pixel blobs — hundreds of lines to save the eight
 * clicks an outline takes, against a public service that is not always up.
 * The map's outline tool plus this lookup is the same answer with less to go
 * wrong.
 *
 * The service speaks EPSG:5070 (CONUS Albers equal-area on GRS80), so the
 * projection lives here too, straight from Snyder's Map Projections — A
 * Working Manual. The tests pin it at the projection origin and against
 * ground distance, because a transposed constant would land the lookup in a
 * different county and every answer would be confidently wrong.
 */

const CDL = 'https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLValue';
export const ENDPOINT = () => process.env.TRAILCAM_CDL_URL || CDL;

// GRS80 ellipsoid and the EPSG:5070 parameters.
const A = 6378137.0;
const E2 = 0.00669438002290;
const E = Math.sqrt(E2);
const RAD = Math.PI / 180;
const LAT0 = 23 * RAD, LNG0 = -96 * RAD;   // origin
const SP1 = 29.5 * RAD, SP2 = 45.5 * RAD;  // standard parallels

const qOf = phi => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s)
    - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const mOf = phi => Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);

const m1 = mOf(SP1), m2 = mOf(SP2);
const q1 = qOf(SP1), q2 = qOf(SP2);
const N = (m1 * m1 - m2 * m2) / (q2 - q1);
const C = m1 * m1 + N * q1;
const rho = phi => A * Math.sqrt(C - N * qOf(phi)) / N;
const RHO0 = rho(LAT0);

/** WGS84 degrees -> EPSG:5070 metres. (WGS84 and NAD83 differ by about a
 *  metre here, a thirtieth of a CDL pixel — ignored, and said so.) */
export function toAlbers(lat, lng) {
  const phi = lat * RAD;
  const theta = N * (lng * RAD - LNG0);
  const r = rho(phi);
  return { x: r * Math.sin(theta), y: RHO0 - r * Math.cos(theta) };
}

/**
 * The service answers SOAP-shaped XML whose Result element carries a JS-ish
 * object literal. Regex rather than a parser, because the two fields needed
 * are quoted strings and the envelope varies with the error path.
 */
export function parseCdlResponse(text) {
  const fault = text.match(/<faultstring[^>]*>([^<]*)</i);
  if (fault) throw new Error(fault[1].trim() || 'CropScape refused the request');
  const category = text.match(/category:\s*"([^"]*)"/i)?.[1] ?? null;
  const code = text.match(/value:\s*"?(\d+)"?/i)?.[1] ?? null;
  if (!category) throw new Error('CropScape answered without a category');
  return { category, code: code === null ? null : Number(code) };
}

/**
 * CDL vocabulary -> this program's crop kinds. Only where it cannot be wrong,
 * the same rule VENDOR_SPECIES follows for the camera's AI words: an
 * unrecognised category is shown verbatim with no pre-selection, never
 * guessed into a crop.
 */
export function cropGuess(category) {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes('corn')) return 'corn';
  if (c.includes('soybean')) return 'soybeans';
  if (c.includes('alfalfa')) return 'alfalfa';
  if (c.includes('winter wheat')) return 'winter-wheat';
  if (c.includes('oats')) return 'oats';
  if (c.includes('clover')) return 'clover';
  if (/turnip|radish|canola|rape seed|mustard/.test(c)) return 'brassicas';
  if (/grass|pasture|hay|fallow|sod/.test(c)) return 'pasture';
  return null;
}

/** The CDL for a season is published early the following year. */
export const latestCdlYear = (now = new Date()) => now.getFullYear() - 1;

/**
 * What the CDL says is at a point. Tries the newest season first and falls
 * back one year, because "published early the following year" is a habit,
 * not a promise.
 */
export async function cropAt(lat, lng, { year, fetchImpl = globalThis.fetch, now } = {}) {
  const { x, y } = toAlbers(lat, lng);
  const years = year ? [year] : [latestCdlYear(now), latestCdlYear(now) - 1];
  let lastErr = null;
  for (const y2 of years) {
    const url = `${ENDPOINT()}?year=${y2}&x=${x.toFixed(1)}&y=${y.toFixed(1)}`;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`CropScape answered HTTP ${res.status}`);
      const parsed = parseCdlResponse(await res.text());
      return { found: true, year: y2, ...parsed, crop: cropGuess(parsed.category) };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('CropScape lookup failed');
}

/**
 * Six years of CDL at one point, oldest first. Years the service cannot answer
 * are omitted rather than guessed, so a short history is visibly short.
 *
 * Requests are sequential on purpose. CropScape is a free public service and
 * was observed struggling on 2026-08-31 (its raster endpoint returning 502
 * while the point endpoint stayed healthy); six polite requests is a fair
 * price for a field, and hammering it in parallel is how the point endpoint
 * joins the raster one.
 */
export async function cropHistory(lat, lng, { years = 6, now, fetchImpl = globalThis.fetch } = {}) {
  const newest = latestCdlYear(now);
  const out = [];
  for (let y = newest - years + 1; y <= newest; y++) {
    try {
      const r = await cropAt(lat, lng, { year: y, fetchImpl });
      out.push({ year: y, category: r.category, code: r.code, crop: r.crop });
    } catch {
      // A single missing year is normal at the edges of coverage.
    }
  }
  return out;
}

/** Crops that hold the ground rather than rotating out of it. */
const PERSISTENT = new Set(['alfalfa', 'clover', 'pasture']);

/**
 * What the rotation suggests for a season the CDL has not published yet.
 *
 * Deliberately legible rather than learned, because a hunter can check this
 * reasoning against what they saw and a fitted model cannot be argued with:
 * a strict corn/soybean alternation is the strongest signal in the midwest,
 * perennial cover mostly persists, and otherwise recent years vote with the
 * most recent weighted highest — except for itself, since a rotation is
 * precisely the habit of not repeating.
 *
 * Returns [{ crop, p }] best first, normalised, or [] with no history.
 */
export function rotationPrior(history, targetYear) {
  const known = history.filter(h => h.crop);
  if (!known.length) return [];

  const scores = new Map();
  const add = (crop, w) => scores.set(crop, (scores.get(crop) ?? 0) + w);
  const last = known[known.length - 1];

  if (PERSISTENT.has(last.crop)) add(last.crop, 6);

  const cs = known.filter(h => h.crop === 'corn' || h.crop === 'soybeans').slice(-4);
  const alternating = cs.length >= 3
    && cs.every((h, i) => i === 0 || h.crop !== cs[i - 1].crop);
  if (alternating && (last.crop === 'corn' || last.crop === 'soybeans')) {
    add(last.crop === 'corn' ? 'soybeans' : 'corn', 8);
    add(last.crop, 1.5);
  }

  known.forEach((h, i) => {
    let w = 1.5 ** i;
    if (i === known.length - 1) w *= 0.4;
    add(h.crop, w);
  });

  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return [...scores.entries()]
    .map(([crop, v]) => ({ crop, p: v / total }))
    .sort((a, b) => b.p - a.p);
}
