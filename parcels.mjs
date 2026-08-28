/**
 * parcels.mjs — who owns this ground.
 *
 * Wisconsin publishes a statewide parcel layer, aggregated from every county,
 * carrying owner names, mailing addresses, acreage and property class. It is
 * public record, free, and queryable by point — which makes the headline
 * feature of the paid hunting apps available here at no cost.
 *
 * Scope, honestly: this is a WISCONSIN service. Other states publish parcel
 * data in wildly varying shapes, and several do not publish owner names at all.
 * A point outside Wisconsin simply returns nothing rather than pretending.
 *
 * On privacy: owner names and mailing addresses are public record, and the
 * mailing address is the practical point — it is how you write to ask
 * permission. But it is still someone's home address, so this fetches on
 * demand and holds results only in memory for the life of the process. Nothing
 * is written to the database or to disk, and there is no bulk download.
 */

const DEFAULT_ENDPOINT =
  'https://services3.arcgis.com/n6uYoouQZW75n5WI/ArcGIS/rest/services/'
  + 'Wisconsin_Statewide_Parcels_DB/FeatureServer/0/query';

// Overridable so tests can point at a local stand-in rather than a public
// service, and so a future version can be pointed at another state.
export const ENDPOINT = () => process.env.TRAILCAM_PARCEL_URL || DEFAULT_ENDPOINT;

// Only the fields that answer "who owns this and how big is it". Asking for
// everything would pull 41 columns of tax detail nobody here needs.
// Field names verified against the layer's own schema. A single name that the
// layer does not have rejects the WHOLE query with "Invalid query parameters",
// so this list is checked rather than assumed — the county field is CONAME
// here, not the CNTYNAME the schema documentation uses.
const FIELDS = [
  'OWNERNME1', 'OWNERNME2', 'PSTLADRESS', 'SITEADRESS', 'PLACENAME',
  'CONAME', 'GISACRES', 'DEEDACRES', 'PARCELID', 'PROPCLASS', 'SCHOOLDIST',
].join(',');

// Property class codes as used by Wisconsin assessors. Worth translating: "5"
// on a map means nothing, "undeveloped" tells a hunter something real.
const PROP_CLASS = {
  1: 'residential', 2: 'commercial', 3: 'manufacturing', 4: 'agricultural',
  5: 'undeveloped', '5M': 'agricultural forest', 6: 'productive forest',
  7: 'other', 8: 'tax-exempt',
};

export function describeClass(code) {
  if (!code) return null;
  const parts = String(code).split(/[,\s]+/).filter(Boolean);
  const named = parts.map(p => PROP_CLASS[p] ?? PROP_CLASS[Number(p)] ?? null).filter(Boolean);
  return named.length ? [...new Set(named)].join(', ') : null;
}

/**
 * Normalize one ArcGIS feature. Absent values come back as null rather than
 * the empty strings and "None" the service sometimes returns, so a caller can
 * tell "no owner recorded" from "owner is blank".
 */
export function parcelFromFeature(f) {
  const a = f?.attributes ?? {};
  // Rings come back as [[[lng, lat], ...]] because outSR is pinned to 4326 in
  // the query. Without that the service answers in the layer's own projection
  // (Web Mercator), whose numbers are metres — drawing those as degrees puts
  // the boundary somewhere off the coast of Africa, silently and confidently.
  const rings = Array.isArray(f?.geometry?.rings) ? f.geometry.rings : null;
  const clean = v => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s && s.toLowerCase() !== 'none' ? s : null;
  };
  const owners = [clean(a.OWNERNME1), clean(a.OWNERNME2)].filter(Boolean);
  return {
    owner: owners.length ? owners.join(' & ') : null,
    owners,
    mailingAddress: clean(a.PSTLADRESS),
    siteAddress: clean(a.SITEADRESS),
    county: clean(a.CONAME),
    town: clean(a.PLACENAME),
    acres: Number.isFinite(a.GISACRES) ? Math.round(a.GISACRES * 100) / 100 : null,
    deedAcres: Number.isFinite(a.DEEDACRES) ? Math.round(a.DEEDACRES * 100) / 100 : null,
    parcelId: clean(a.PARCELID),
    propClass: clean(a.PROPCLASS),
    propClassName: describeClass(a.PROPCLASS),
    schoolDistrict: clean(a.SCHOOLDIST),
    rings,
  };
}

// Coordinates are rounded to about a metre for the cache key: two clicks on the
// same tree should not be two requests, and a metre is far finer than a parcel.
const key = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

const cache = new Map();
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function clearParcelCache() { cache.clear(); }

/**
 * Look up the parcel containing a point. Returns null when there is no parcel
 * there — outside Wisconsin, or on water — which is a real answer, not a fault.
 * Network and service failures throw, so the caller can say "lookup failed"
 * rather than "nobody owns this".
 */
export async function parcelAt(lat, lng, { signal } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('parcel lookup needs a latitude and longitude');
  }
  const k = key(lat, lng);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const geometry = JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } });
  const url = `${ENDPOINT()}?${new URLSearchParams({
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: FIELDS,
    // The boundary itself, not just the answer to "who owns this". Drawing the
    // line is what makes ownership readable at a glance rather than one click
    // at a time — it is the thing onX is recognised for.
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1',
    f: 'json',
  })}`;

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`parcel service returned HTTP ${res.status}`);
  const body = await res.json();
  // ArcGIS reports its own errors inside a 200 response, so checking the status
  // code alone would treat a service error as "no parcel here".
  if (body?.error) {
    throw new Error(`parcel service error: ${body.error.message ?? 'unknown'}`);
  }

  const feature = (body.features ?? [])[0];
  const value = feature ? parcelFromFeature(feature) : null;

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { at: Date.now(), value });
  return value;
}

/**
 * Is a point inside a parcel's rings?
 *
 * Even-odd rule over every ring, which handles holes for free: a point inside
 * the outer boundary and inside a hole crosses an odd number of edges twice,
 * and comes out even — outside. ArcGIS delivers rings closed (first point
 * repeated last), but the loop does not rely on it.
 */
export function pointInRings(rings, lng, lat) {
  if (!Array.isArray(rings)) return false;
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat)
          && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}
