/**
 * offline.mjs — the phone in the truck, with no bars.
 *
 * The server runs on the home network. The phone talks to it over Wi-Fi from
 * the kitchen, and then gets carried to a place with no Wi-Fi and frequently
 * no signal at all — which is precisely where "where do I sit" and "log what I
 * saw" are wanted. So the pages have to work from what the phone already has.
 *
 * Two pieces, both exported as source text the way measure.mjs is, so the
 * versions the browser runs are the versions the tests compile:
 *
 * 1. A service worker. Tiles and photos are cache-first — they are immutable
 *    by URL, and a map that re-downloads satellite imagery it drew yesterday
 *    is wasting the signal it does have. Pages and API answers are
 *    network-first: fresh wins whenever the server is reachable, and the cache
 *    only answers when it is not. A cached answer is stamped with when it was
 *    stored, so a page can say "this is the plan as of Tuesday evening"
 *    instead of passing old data off as live.
 *
 * 2. A queue for sits. Logging a sit in the woods cannot POST anywhere, so it
 *    lands in localStorage and is pushed when the server is next reachable.
 *    The rule that decides retries: a NETWORK failure keeps the sit queued,
 *    but a 400 from the server drops it and says so — the server has seen it
 *    and called it invalid, and retrying an invalid sit forever would wedge
 *    the queue on one bad row.
 *
 * Terrain gets one rule of its own. A terrain answer covers an AREA, but its
 * URL carries the map centre at full float precision — so exact-URL matching
 * would replay it only for the identical pan, which never happens twice. The
 * worker instead falls back to the newest cached answer whose bounds contain
 * the requested point, the same containment rule the server's own grid store
 * uses. That is what lets the 3D view build its mesh in the woods.
 *
 * What this deliberately does not do: background sync (needs permissions and
 * buys little — the queue flushes on the next open), and precaching every
 * tile on the property (the map's own "Save offline" button already does that
 * on demand, and every tile it fetches passes through the worker and is
 * cached as a side effect).
 */

/** Bump to invalidate everything a previous version cached. */
export const CACHE_VERSION = 'trailcam-v1';

export function swSource() {
  return String.raw`
const VERSION = '${CACHE_VERSION}';
const SHELL = ['/', '/tonight', '/journal', '/review'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      // Shell pages are fetched one by one and failures tolerated: install
      // must not fail outright because one page 500d at the wrong moment.
      .then(c => Promise.allSettled(SHELL.map(p => c.add(p))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// A response is stamped when stored, so a page answering from cache can say
// how old its data is rather than passing it off as live.
async function stamp(res) {
  const headers = new Headers(res.headers);
  headers.set('x-sw-cached-at', new Date().toISOString());
  const body = await res.arrayBuffer();
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, await stamp(res.clone()));
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, await stamp(res.clone()));
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) return hit;
    // A navigation with nothing cached still deserves a page, not a browser
    // error screen that looks like the app is broken.
    if (req.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    return new Response('Offline, and nothing cached for this yet.', {
      status: 503, headers: { 'content-type': 'text/plain' },
    });
  }
}

// Terrain cached for ANY view it covers, not only for its exact URL.
//
// A terrain request carries the map centre at full float precision, so the
// URL is different after every pan — exact matching would replay a saved
// answer only if the phone happened to be aimed at the identical spot, which
// it never is. But the ANSWER covers an area: the same rule the server's own
// grid store uses (any stored grid containing the point serves it) applies
// here, one cache further out. The newest covering answer wins, because a
// later save of the same ground is a finer or larger fetch of it.
async function cachedTerrainCovering(url) {
  const cache = await caches.open(VERSION);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null, bestAt = '';
  for (const req of await cache.keys()) {
    if (new URL(req.url).pathname !== '/api/terrain') continue;
    const hit = await cache.match(req);
    if (!hit) continue;
    let body;
    try { body = await hit.clone().json(); } catch (err) { continue; }
    const b = body && body.covered && body.bounds;
    if (!b) continue;
    if (lat < b.south || lat > b.north || lng < b.west || lng > b.east) continue;
    const at = hit.headers.get('x-sw-cached-at') || '';
    if (!best || at > bestAt) { best = hit; bestAt = at; }
  }
  return best;
}

// Network first like everything else, but two failures fall back to covering
// ground rather than surfacing: no network at all, and a server that answers
// 5xx — which for terrain means the SERVER's internet is down (it could not
// reach USGS), and ground saved last week still beats an error screen. A 4xx
// passes through untouched: that is the server judging the request, not
// failing to answer it.
async function terrainFirst(req, url) {
  const cache = await caches.open(VERSION);
  let res = null;
  try {
    res = await fetch(req);
    if (res.ok) { cache.put(req, await stamp(res.clone())); return res; }
    if (res.status < 500) return res;
  } catch (err) { /* no network: fall through to the cache */ }
  const exact = await cache.match(req);
  if (exact) return exact;
  const covering = await cachedTerrainCovering(url);
  if (covering) return covering;
  return res || new Response('Offline, and no ground saved for this spot yet.', {
    status: 503, headers: { 'content-type': 'text/plain' },
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/tiles/') || url.pathname.startsWith('/photos/')) {
    e.respondWith(cacheFirst(e.request));
  } else if (url.pathname === '/api/terrain') {
    e.respondWith(terrainFirst(e.request, url));
  } else {
    e.respondWith(networkFirst(e.request));
  }
});
`;
}

/**
 * The sit queue, emitted into the tonight page as `SITQ`.
 *
 * Everything is behind try/catch because localStorage itself can throw — a
 * private window, storage pressure — and losing the ability to log must never
 * take the page down with it.
 */
export function queueSource(globalName = 'SITQ') {
  return String.raw`
const ${globalName} = (function () {
  const KEY = 'trailcam.sitQueue';
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (err) { return []; }
  };
  const write = list => {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch (err) { return false; }
  };
  return {
    pending: () => read().length,
    enqueue(body) {
      const list = read();
      list.push({ body, queuedAt: new Date().toISOString() });
      return write(list) ? list.length : 0;
    },
    /**
     * Push everything queued. A network failure stops and keeps the rest — the
     * server is unreachable, so trying the next one is noise. A 400 drops the
     * sit as rejected: the server saw it and called it invalid, and retrying
     * an invalid sit forever would wedge the queue on one bad row.
     */
    async flush(fetchImpl) {
      const doFetch = fetchImpl || fetch;
      let list = read();
      let sent = 0, rejected = 0;
      while (list.length) {
        let res;
        try {
          res = await doFetch('/api/sits', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(list[0].body),
          });
        } catch (err) {
          break;                      // offline: keep the queue as it is
        }
        if (res.ok) sent++;
        else if (res.status >= 400 && res.status < 500) rejected++;
        else break;                   // a server error: worth retrying later
        list = list.slice(1);
        write(list);
      }
      return { sent, rejected, left: list.length };
    },
  };
})();
`;
}

/**
 * The registration snippet every served page carries. Registration is safe to
 * run repeatedly and silently does nothing over file:// or in browsers
 * without service workers.
 */
export function registerSnippet() {
  return String.raw`
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline still works without it next time */ });
}
`;
}

/** A minimal installable-app manifest, so the phone can pin it like an app. */
export function manifest() {
  return JSON.stringify({
    name: 'TrailCam',
    short_name: 'TrailCam',
    start_url: '/tonight',
    display: 'standalone',
    background_color: '#14160f',
    theme_color: '#375a3f',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }, null, 2);
}

/** The icon: a stand teardrop, same mark the map uses. */
export function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#375a3f"/>
  <path d="M32 10c9 0 16 7 16 16 0 12-16 28-16 28S16 38 16 26c0-9 7-16 16-16z" fill="#f6f7f5"/>
  <circle cx="32" cy="26" r="7" fill="#375a3f"/>
</svg>`;
}

/**
 * The GPS recorder, emitted into the tonight page as `TRACKER`.
 *
 * Three things make this harder than calling watchPosition:
 *
 * 1. THE PHONE SLEEPS. Lock the screen on the walk in — which is exactly what
 *    you do — and the page is frozen or discarded. So every fix is written to
 *    localStorage as it arrives, not held in memory; reopening the page finds
 *    the recording still in progress and carries on.
 * 2. THERE IS NO SIGNAL. GPS works without one, but posting does not. A
 *    finished track goes into the same queue the sits use, with the same rule:
 *    a network failure keeps it, a rejection drops it.
 * 3. THE RAW FIXES ARE THE EVIDENCE. The phone posts everything it saw and the
 *    server filters. Filtering here would throw away the data that a better
 *    filter later would need.
 *
 * Battery: a continuous high-accuracy watch is expensive — reckon on a few
 * percent for a walk in, far more if left running through a sit. The page says
 * so and offers to stop.
 */
export function trackerSource(globalName = 'TRACKER') {
  return String.raw`
const ${globalName} = (function () {
  const KEY = 'trailcam.track';
  const QUEUE = 'trailcam.trackQueue';
  let watchId = null;

  const read = k => {
    try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v; }
    catch (err) { return null; }
  };
  const write = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (err) { return false; }
  };

  return {
    supported: () => typeof navigator !== 'undefined' && !!navigator.geolocation,
    current: () => read(KEY),
    recording: () => !!read(KEY),
    pending: () => (read(QUEUE) || []).length,

    /**
     * Start, or pick up a recording the phone was already making. Fixes are
     * appended to storage as they arrive so a locked screen loses nothing.
     */
    start(meta, onFix) {
      if (!this.supported()) return { ok: false, why: 'This browser has no GPS.' };
      if (!read(KEY)) write(KEY, { startedAt: Date.now(), meta: meta || {}, fixes: [] });
      if (watchId !== null) return { ok: true, resumed: true };
      watchId = navigator.geolocation.watchPosition(
        pos => {
          const rec = read(KEY);
          if (!rec) return;
          rec.fixes.push({
            lat: pos.coords.latitude, lng: pos.coords.longitude,
            acc: pos.coords.accuracy, t: pos.timestamp,
          });
          write(KEY, rec);
          if (onFix) onFix(rec);
        },
        err => { if (onFix) onFix(read(KEY), err); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
      );
      return { ok: true, resumed: false };
    },

    /** Stop watching but keep what was recorded, so a reload can resume. */
    pause() {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    },

    discard() {
      this.pause();
      try { localStorage.removeItem(KEY); } catch (err) { /* nothing to do */ }
    },

    /**
     * Finish: move the recording into the send queue and clear it. The raw
     * fixes go up untouched — the server does the filtering.
     */
    finish(extra) {
      const rec = read(KEY);
      this.pause();
      if (!rec || rec.fixes.length < 2) { this.discard(); return null; }
      const q = read(QUEUE) || [];
      q.push({ body: Object.assign({ fixes: rec.fixes }, rec.meta, extra || {}),
               queuedAt: new Date().toISOString() });
      write(QUEUE, q);
      try { localStorage.removeItem(KEY); } catch (err) { /* nothing to do */ }
      return { fixes: rec.fixes.length, queued: q.length };
    },

    /** Same rules as the sit queue: offline keeps, rejected drops. */
    async flush(fetchImpl) {
      const doFetch = fetchImpl || fetch;
      let q = read(QUEUE) || [];
      let sent = 0, rejected = 0;
      const saved = [];
      while (q.length) {
        let res;
        try {
          res = await doFetch('/api/tracks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(q[0].body),
          });
        } catch (err) { break; }
        if (res.ok) {
          sent++;
          try { saved.push(await res.json()); } catch (err) { /* the save counted */ }
        } else if (res.status >= 400 && res.status < 500) rejected++;
        else break;
        q = q.slice(1);
        write(QUEUE, q);
      }
      return { sent, rejected, left: q.length, saved };
    },
  };
})();
`;
}
