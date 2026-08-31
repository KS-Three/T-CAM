/**
 * radar.mjs — the live radar loop the map plays over the ground.
 *
 * The forecast already says whether it will rain on Saturday. What it cannot
 * say is where the rain is RIGHT NOW and which way it is moving, which is the
 * question you ask standing at the truck with a front on the horizon. That is
 * radar, and it is a different kind of data from everything else this app
 * draws: it is a photograph rather than a prediction, it is worthless in
 * twenty minutes, and it arrives as a short reel of frames rather than one
 * answer.
 *
 * Three consequences run through this file.
 *
 * **The page is never told a vendor URL.** Frames are handed out with opaque
 * ids and the tiles come back through this server, the same rule the forecast
 * and the map tiles follow — `test/offline.test.js` pins that a page contacts
 * no external host, and an `<img src>` pointed at a tile cache would break it
 * silently.
 *
 * **Radar is not a tile source.** It deliberately does not join
 * `tile-sources.mjs`: everything there is cached to disk for ninety days,
 * offered to the bounded "save this view" pre-fetch, and served back
 * cache-first by the service worker. All three are exactly wrong for an image
 * that expires in minutes. Radar gets its own route, its own short-lived
 * cache, and a network-first worker rule.
 *
 * **Stale radar is worse than no radar, past a point.** A forecast from
 * Tuesday shown with its age attached is still useful; an hour-old
 * photograph of a storm sitting over your property is not, because it does
 * not LOOK old. So this serves what it has up to STALE_CUTOFF_MINUTES with
 * the age said out loud, and past that refuses and says why. That is a
 * deliberate departure from the stale-but-said-so rule the forecast follows —
 * Kent's call, 2026-08-31.
 */

const INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
export const ENDPOINT = () => process.env.TRAILCAM_RADAR_URL || INDEX;

/** How long a fetched frame index is served before refetching. The vendor
 *  publishes a new frame about every ten minutes; asking much faster than
 *  that spends requests on an identical answer. */
export const INDEX_TTL_SECONDS = 300;

/**
 * Past this age the layer refuses rather than draws. Thirty minutes is three
 * frames: long enough to survive walking in under trees and losing signal,
 * short enough that the picture still describes the sky you are standing
 * under.
 */
export const STALE_CUTOFF_MINUTES = 30;

/**
 * Universal Blue, out of the vendor's fixed palette menu, chosen because it
 * contains no green. The classic green-yellow-red radar ramp is the one
 * everybody can read instantly, and it is the wrong one here: light rain is
 * the case that most changes whether you sit, and light rain painted green
 * over green canopy and green fields is invisible on the only base maps this
 * app uses. Blue-to-purple reads on imagery, on topo and on the LiDAR grey.
 * Kent's call, 2026-08-31, with screenshots in the PR.
 */
export const PALETTE = 2;

/** Smoothed, with snow shown apart from rain. */
export const TILE_OPTIONS = '1_1';

/** Tiles are square and this is their edge, in pixels — the map draws 256s. */
export const TILE_SIZE = 256;

/**
 * A frame id has to survive being put in a URL path and compared against a
 * cache key, so it is checked rather than trusted. The vendor's own frame
 * paths end in a short hex token; anything else is refused before it can
 * become part of an outbound request.
 */
const ID_OK = /^[a-z0-9]{4,32}$/;
export const validId = id => typeof id === 'string' && ID_OK.test(id);

/** Fetch the raw frame index. */
export async function fetchIndex({ fetchImpl = globalThis.fetch, signal } = {}) {
  const res = await fetchImpl(ENDPOINT(), { signal });
  if (!res.ok) throw new Error(`radar index request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body !== 'object') throw new Error('radar index was not an object');
  return body;
}

/**
 * The raw index cut down to what the page and the tile route need.
 *
 * `nowcast` is treated as optional on purpose rather than defensively: it was
 * measured EMPTY on a live probe (2026-08-31, 13 past frames and zero
 * forecast ones), so a loop that assumes future frames exist is a loop that
 * is sometimes wrong. Past-only is a normal answer, not a degraded one.
 *
 * Each frame carries the upstream path it came from. That never reaches the
 * browser — `framesForClient()` strips it — but the tile route needs it to
 * build the outbound request, and keeping the two together means a frame id
 * cannot be resolved against a path it did not come with.
 */
export function shapeIndex(raw) {
  const host = typeof raw.host === 'string' && raw.host ? raw.host : null;
  if (!host) throw new Error('radar index carried no host');
  const seen = new Set();
  const take = (list, kind) => (Array.isArray(list) ? list : []).flatMap(f => {
    const time = Number(f?.time);
    const path = typeof f?.path === 'string' ? f.path : '';
    const id = path.split('/').filter(Boolean).pop() ?? '';
    // A frame that cannot be addressed is dropped rather than repaired: an
    // id guessed from an unexpected shape would build a URL that 404s once a
    // minute forever.
    if (!Number.isFinite(time) || !validId(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, time, kind, path }];
  });
  const frames = [...take(raw.radar?.past, 'past'), ...take(raw.radar?.nowcast, 'nowcast')]
    .sort((a, b) => a.time - b.time);
  if (!frames.length) throw new Error('radar index carried no usable frames');
  return { host, generated: Number(raw.generated) || null, frames };
}

/** The upstream URL for one tile of one frame. */
export function tileUrl(shaped, frame, z, x, y) {
  return `${shaped.host}${frame.path}/${TILE_SIZE}/${z}/${x}/${y}/${PALETTE}/${TILE_OPTIONS}.png`;
}

export const frameById = (shaped, id) =>
  shaped?.frames?.find(f => f.id === id) ?? null;

/** Minutes between a frame's timestamp and now, or null if it cannot be told. */
export function frameAgeMinutes(frame, now = Date.now()) {
  if (!frame || !Number.isFinite(frame.time)) return null;
  return (now - frame.time * 1000) / 60000;
}

/**
 * What the page is handed: the frames without their upstream paths, plus the
 * one judgement it must not make for itself — whether this reel is too old to
 * draw. The page could compute the age, but then the cutoff would live in two
 * places and drift, and the half that drifts is the half that decides whether
 * a stale picture goes on the map.
 */
export function framesForClient(shaped, { now = Date.now(), fetchedAt = null } = {}) {
  const frames = shaped.frames.map(f => ({ id: f.id, time: f.time, kind: f.kind }));
  const newest = frames.length ? frames[frames.length - 1] : null;
  const past = frames.filter(f => f.kind === 'past');
  // Age is measured from the newest PAST frame, never from a nowcast one: a
  // nowcast frame is stamped in the future, and measuring against it would
  // report a two-hour-old reel as fresh.
  const newestPast = past.length ? past[past.length - 1] : null;
  const ageMinutes = frameAgeMinutes(newestPast ?? newest, now);
  const tooOld = ageMinutes !== null && ageMinutes > STALE_CUTOFF_MINUTES;
  return {
    frames, generated: shaped.generated, fetchedAt,
    ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes),
    cutoffMinutes: STALE_CUTOFF_MINUTES,
    tooOld,
    note: tooOld
      ? `Radar needs a signal. The newest frame is ${Math.round(ageMinutes)} minutes old, `
        + `past the ${STALE_CUTOFF_MINUTES}-minute limit, so it is not drawn — `
        + 'an old picture of a storm does not look old.'
      : null,
  };
}

/**
 * The index, cached in memory rather than in SQLite.
 *
 * Everything else this server caches is worth keeping across a restart. A
 * radar index is not: every frame in it has expired within the hour, so a
 * persisted copy would only ever be read to discover it is useless, and it
 * would need a migration to hold it. Losing it on restart costs one fetch.
 */
export function makeIndexCache({ ttlSeconds = INDEX_TTL_SECONDS } = {}) {
  let hit = null;                  // { shaped, fetchedAt }
  let inflight = null;
  return {
    /** The current index, refetched when stale. Falls back to the last good
     *  one when the fetch fails, so losing signal degrades to "old, and said
     *  so" rather than to nothing. */
    async get({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
      if (hit && now - hit.fetchedAt < ttlSeconds * 1000) {
        return { ...hit, cached: true, error: null };
      }
      // One refetch at a time. Without this a map with the loop playing sends
      // a burst of identical index requests the moment the TTL lapses.
      inflight = inflight ?? (async () => {
        try {
          const shaped = shapeIndex(await fetchIndex({ fetchImpl }));
          hit = { shaped, fetchedAt: Date.now() };
          return { ...hit, cached: false, error: null };
        } finally {
          inflight = null;
        }
      })();
      try {
        return await inflight;
      } catch (err) {
        if (hit) return { ...hit, cached: true, error: err.message };
        throw err;
      }
    },
    /** For tests, and for the tile route to resolve an id without refetching. */
    peek: () => hit,
    clear: () => { hit = null; inflight = null; },
  };
}

/**
 * Radar tiles held in memory, keyed by frame.
 *
 * Deliberately NOT the disk cache in `tile-cache.mjs`: that one exists so the
 * map works in the woods with no signal, holds tiles for ninety days, and is
 * fed by a pre-fetch. Radar wants the opposite of all three. What it does
 * want is that scrubbing back and forth across a dozen frames, or a second
 * phone looking at the same loop, does not refetch every tile — which a small
 * bounded map in memory covers.
 *
 * Whole frames are evicted at once, when the index stops listing them. That
 * is the natural lifetime: a frame nobody can select is a frame nobody will
 * ask for again.
 */
export function makeTileCache({ maxTiles = 600 } = {}) {
  const byFrame = new Map();       // id -> Map(z/x/y -> {body, contentType})
  let count = 0;
  const keyOf = (z, x, y) => `${z}/${x}/${y}`;
  return {
    get(id, z, x, y) { return byFrame.get(id)?.get(keyOf(z, x, y)) ?? null; },
    put(id, z, x, y, tile) {
      let frame = byFrame.get(id);
      if (!frame) { frame = new Map(); byFrame.set(id, frame); }
      if (!frame.has(keyOf(z, x, y))) count++;
      frame.set(keyOf(z, x, y), tile);
      // A ceiling as well as the eviction below: one person panning a long
      // way with the loop playing could otherwise outrun the index refresh
      // that would have cleaned up after them.
      while (count > maxTiles && byFrame.size) {
        const oldest = byFrame.keys().next().value;
        count -= byFrame.get(oldest).size;
        byFrame.delete(oldest);
      }
    },
    /** Drop every frame the index no longer lists. */
    keepOnly(ids) {
      const live = new Set(ids);
      for (const id of [...byFrame.keys()]) {
        if (live.has(id)) continue;
        count -= byFrame.get(id).size;
        byFrame.delete(id);
      }
    },
    get size() { return count; },
    get frames() { return byFrame.size; },
  };
}

/**
 * The deepest zoom the service actually has radar for.
 *
 * Measured, not assumed (2026-08-31, over a live cell in northern New
 * Mexico): z4 through z7 return real imagery of varying size, and z8, z9,
 * z10, z11 and z12 every one return an IDENTICAL 1370-byte PNG with an HTTP
 * **200** — a "Zoom Level Not Supported" placard rather than an error. Drawn
 * straight, that paints a grey wall of lettering over the ground at every
 * zoom this map is actually used at, and nothing about the response says it
 * is wrong.
 *
 * So the page asks for the deepest zoom that exists and stretches it. That is
 * honest rather than lossy: radar resolution is about a kilometre, so a
 * sharper tile would carry no more weather even if one were served.
 */
export const MAX_ZOOM = 7;
