/**
 * The offline layer: the worker compiles and routes correctly, and the sit
 * queue survives the three things that happen to it — no signal, a server
 * error, and a sit the server rejects outright.
 *
 * Both are tested by compiling the SOURCE the pages actually emit, the same
 * approach as measure.mjs: there is one definition, and it is the one under
 * test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { swSource, queueSource, trackerSource, registerSnippet, manifest, iconSvg, CACHE_VERSION } from '../offline.mjs';

// ---------------------------------------------------------------------------
// The service worker
// ---------------------------------------------------------------------------

function workerContext() {
  const handlers = {};
  const ctx = {
    self: {
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      location: { origin: 'http://192.168.1.20:8787' },
    },
    caches: {
      open: async () => ({ match: async () => undefined, put: () => {}, add: async () => {} }),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => new Response('x'),
    URL, Response, Headers,
  };
  ctx.self.addEventListener = ctx.self.addEventListener.bind(ctx.self);
  vm.createContext(ctx);
  new vm.Script(swSource()).runInContext(ctx);
  return { handlers, ctx };
}

test('the worker compiles and registers its three handlers', () => {
  const { handlers } = workerContext();
  assert.ok(handlers.install, 'install');
  assert.ok(handlers.activate, 'activate');
  assert.ok(handlers.fetch, 'fetch');
});

test('tiles and photos are cache-first; pages and API are network-first', () => {
  // Routing is the design decision here, so it is asserted structurally: the
  // dispatch has to read exactly this way round. Cache-first API answers would
  // freeze the plan; network-first tiles would redownload the county.
  const src = swSource();
  const dispatch = src.slice(src.indexOf("addEventListener('fetch'"));
  assert.match(dispatch, /\/tiles\/.*\|\|.*\/photos\/|\/tiles\/'\)[\s\S]*?\/photos\/'\)/,
    'tiles and photos share a branch');
  const tileBranch = dispatch.indexOf('cacheFirst');
  const restBranch = dispatch.indexOf('networkFirst');
  assert.ok(tileBranch > 0 && restBranch > tileBranch,
    'the immutable things take the cache branch and everything else the network one');
  assert.match(src, /e\.request\.method !== 'GET'/, 'POSTs are never intercepted');
  assert.match(src, /url\.origin !== self\.location\.origin/, 'nor other origins');
});

test('radar is never cached, and is checked before the tile rule', () => {
  // Ground does not move, so a month-old map tile is the same tile. A
  // month-old radar frame is a photograph of weather that is long gone, and
  // cache-first would serve it back looking exactly as current as the real
  // thing — the failure the whole staleness cutoff exists to prevent.
  const src = swSource();
  const dispatch = src.slice(src.indexOf("addEventListener('fetch'"));
  const radarAt = dispatch.indexOf("'/radar/'");
  const tilesAt = dispatch.indexOf("'/tiles/'");
  assert.ok(radarAt > 0, 'radar has its own branch');
  assert.ok(radarAt < tilesAt,
    'and it is tested BEFORE /tiles/, or a path could fall into the cache-first branch');
  const radarBranch = dispatch.slice(radarAt, tilesAt);
  assert.match(radarBranch, /respondWith\(fetch\(e\.request\)\)/,
    'radar goes straight to the network, with no cache read and no cache write');
  assert.doesNotMatch(radarBranch, /cacheFirst|cache\.put/,
    'nothing about radar touches the cache');
  assert.match(dispatch, /url\.pathname === '\/api\/radar'/,
    'the frame list is not cached either — a cached list dates the whole reel');
});

test('a cached answer is stamped with when it was stored', () => {
  assert.match(swSource(), /x-sw-cached-at/,
    'the page can say how old offline data is instead of passing it off as live');
});

test('the cache name carries the version, and old versions are deleted', () => {
  const src = swSource();
  assert.match(src, new RegExp(CACHE_VERSION));
  assert.match(src, /keys\.filter\(k => k !== VERSION\)/);
});

// ---------------------------------------------------------------------------
// The sit queue
// ---------------------------------------------------------------------------

function queueContext() {
  const store = new Map();
  const ctx = {
    localStorage: {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    },
    fetch: undefined,
    JSON, Array, Date, Response,
  };
  vm.createContext(ctx);
  new vm.Script(queueSource('SITQ') + '\nthis.SITQ = SITQ;').runInContext(ctx);
  return { q: ctx.SITQ, store };
}

const sit = n => ({ date: '2026-11-0' + n, window: 'PM', deer: n });

test('a sit queued offline is delivered on the next flush', async () => {
  const { q } = queueContext();
  assert.equal(q.pending(), 0);
  assert.equal(q.enqueue(sit(1)), 1);
  assert.equal(q.enqueue(sit(2)), 2);

  const posted = [];
  const r = await q.flush(async (url, opts) => {
    posted.push(JSON.parse(opts.body));
    return { ok: true, status: 201 };
  });
  assert.deepEqual({ ...r }, { sent: 2, rejected: 0, left: 0 });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].deer, 1, 'oldest first');
  assert.equal(q.pending(), 0);
});

test('no signal keeps the queue exactly as it was', async () => {
  const { q } = queueContext();
  q.enqueue(sit(1)); q.enqueue(sit(2));
  const r = await q.flush(async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual({ ...r }, { sent: 0, rejected: 0, left: 2 });
  assert.equal(q.pending(), 2, 'nothing is lost to a dead network');
});

test('a sit the server rejects is dropped, so one bad row cannot wedge the queue', async () => {
  const { q } = queueContext();
  q.enqueue({ date: 'garbage', window: 'PM' });
  q.enqueue(sit(2));
  let calls = 0;
  const r = await q.flush(async (url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    return body.date === 'garbage' ? { ok: false, status: 400 } : { ok: true, status: 201 };
  });
  assert.deepEqual({ ...r }, { sent: 1, rejected: 1, left: 0 });
  assert.equal(calls, 2, 'the queue moved past the bad row');
});

test('a server error is retried later, not dropped', async () => {
  // 500 is the server having a bad moment, not a verdict on the sit.
  const { q } = queueContext();
  q.enqueue(sit(1));
  const r = await q.flush(async () => ({ ok: false, status: 500 }));
  assert.deepEqual({ ...r }, { sent: 0, rejected: 0, left: 1 });
  assert.equal(q.pending(), 1);
});

test('a broken localStorage disables the queue without throwing', () => {
  const ctx = {
    localStorage: {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    },
    JSON, Array, Date,
  };
  vm.createContext(ctx);
  new vm.Script(queueSource('SITQ') + '\nthis.SITQ = SITQ;').runInContext(ctx);
  assert.equal(ctx.SITQ.pending(), 0);
  assert.equal(ctx.SITQ.enqueue(sit(1)), 0, 'enqueue reports failure rather than lying');
});

// ---------------------------------------------------------------------------
// The rest of the plumbing
// ---------------------------------------------------------------------------

test('the registration snippet compiles and stays off non-http pages', () => {
  assert.doesNotThrow(() => new vm.Script(registerSnippet()));
  assert.match(registerSnippet(), /location\.protocol\.startsWith\('http'\)/,
    'a file:// copy of the dashboard must not try to register a worker');
});

test('the manifest is valid JSON pointing at real routes', () => {
  const m = JSON.parse(manifest());
  assert.equal(m.start_url, '/tonight');
  assert.equal(m.display, 'standalone');
  assert.equal(m.icons[0].src, '/icon.svg');
  assert.match(iconSvg(), /^<svg /);
});

// ---------------------------------------------------------------------------
// The GPS recorder
// ---------------------------------------------------------------------------

function trackerContext({ supported = true } = {}) {
  const store = new Map();
  const watchers = [];
  const ctx = {
    localStorage: {
      getItem: k => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: k => store.delete(k),
    },
    navigator: supported ? {
      geolocation: {
        watchPosition: (ok, err) => { watchers.push({ ok, err }); return watchers.length; },
        clearWatch: id => { watchers[id - 1] = null; },
      },
    } : {},
    Date, JSON, Object, Array,
  };
  vm.createContext(ctx);
  new vm.Script(trackerSource('TRACKER') + '\nthis.TRACKER = TRACKER;').runInContext(ctx);
  return { T: ctx.TRACKER, watchers, store };
}

const fix = (i) => ({
  coords: { latitude: 44.12 + i * 0.00001, longitude: -90.65, accuracy: 6 },
  timestamp: 1762000000000 + i * 1000,
});

test('every fix is written to storage as it arrives, so a locked screen loses nothing', async () => {
  // The phone freezes or discards the page the moment you pocket it — which is
  // exactly when you are walking. Holding fixes in memory loses the walk.
  const { T, watchers, store } = trackerContext();
  T.start({ standId: 3 });
  for (let i = 0; i < 5; i++) watchers[0].ok(fix(i));
  const stored = JSON.parse(store.get('trailcam.track'));
  assert.equal(stored.fixes.length, 5, 'in storage, not in a variable');
  assert.equal(stored.meta.standId, 3);
  assert.equal(T.recording(), true);
});

test('reopening the page mid-walk resumes the same recording', async () => {
  const { T, watchers } = trackerContext();
  T.start({});
  watchers[0].ok(fix(0));
  // A second start() — the page was reloaded — must not begin a new track.
  const again = T.start({});
  assert.equal(again.resumed, true);
  watchers[0].ok(fix(1));
  assert.equal(T.current().fixes.length, 2, 'the earlier fix survived the reload');
});

test('finishing queues the RAW fixes, untouched, for the server to filter', async () => {
  const { T, watchers } = trackerContext();
  T.start({ standId: 7, routeId: 9 });
  for (let i = 0; i < 4; i++) watchers[0].ok(fix(i));
  const done = T.finish({ name: 'Walk' });
  assert.equal(done.fixes, 4);
  assert.equal(T.recording(), false, 'the live recording is cleared');
  assert.equal(T.pending(), 1);

  const posted = [];
  const r = await T.flush(async (url, opts) => {
    posted.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, json: async () => ({ id: 1, length_m: 40 }) };
  });
  assert.equal(r.sent, 1);
  assert.equal(posted[0].url, '/api/tracks');
  assert.equal(posted[0].body.fixes.length, 4, 'raw fixes, not a filtered line');
  assert.equal(posted[0].body.standId, 7);
  assert.equal(posted[0].body.routeId, 9);
  assert.equal(posted[0].body.name, 'Walk');
  assert.ok(posted[0].body.fixes[0].acc, 'accuracy travels with each fix');
});

test('a walk too short to be a walk is dropped rather than queued', () => {
  const { T, watchers } = trackerContext();
  T.start({});
  watchers[0].ok(fix(0));
  assert.equal(T.finish(), null);
  assert.equal(T.pending(), 0);
  assert.equal(T.recording(), false);
});

test('no signal keeps the track queued; a rejection drops it', async () => {
  const { T, watchers } = trackerContext();
  T.start({});
  for (let i = 0; i < 4; i++) watchers[0].ok(fix(i));
  T.finish();

  const offline = await T.flush(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(offline.sent, 0);
  assert.equal(offline.rejected, 0);
  assert.equal(offline.left, 1);
  assert.equal(offline.saved.length, 0);
  assert.equal(T.pending(), 1, 'a walk is not lost to a dead network');

  const refused = await T.flush(async () => ({ ok: false, status: 400 }));
  assert.equal(refused.rejected, 1);
  assert.equal(T.pending(), 0, 'but one bad track cannot wedge the queue');
});

test('discarding a recording leaves nothing behind', () => {
  const { T, watchers } = trackerContext();
  T.start({});
  watchers[0].ok(fix(0));
  T.discard();
  assert.equal(T.recording(), false);
  assert.equal(T.pending(), 0);
});

test('a browser with no GPS says so instead of failing at the first fix', () => {
  const { T } = trackerContext({ supported: false });
  assert.equal(T.supported(), false);
  const r = T.start({});
  assert.equal(r.ok, false);
  assert.match(r.why, /no GPS/);
});
