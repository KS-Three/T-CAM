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
