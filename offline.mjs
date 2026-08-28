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

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/tiles/') || url.pathname.startsWith('/photos/')) {
    e.respondWith(cacheFirst(e.request));
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
