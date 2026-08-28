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
import { swSource, queueSource, registerSnippet, manifest, iconSvg, CACHE_VERSION } from '../offline.mjs';

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
