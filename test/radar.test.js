/**
 * radar.mjs — the frame index, the staleness cutoff, and the two caches.
 *
 * The live probe these fixtures are shaped from (2026-08-31) returned 13 past
 * frames at ten-minute spacing and ZERO nowcast frames, which is why several
 * of these assert that past-only is an ordinary answer rather than a failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeIndex, framesForClient, tileUrl, frameById, frameAgeMinutes, validId,
  makeIndexCache, makeTileCache,
  PALETTE, TILE_OPTIONS, TILE_SIZE, STALE_CUTOFF_MINUTES, INDEX_TTL_SECONDS,
} from '../radar.mjs';

/** An index shaped exactly like the vendor's, at a fixed clock. */
const T0 = 1788201600;                       // the newest past frame
const rawIndex = ({ past = 3, nowcast = 0, host = 'https://tiles.example' } = {}) => ({
  version: '2.0', generated: T0 + 60, host,
  radar: {
    past: Array.from({ length: past }, (_, i) => ({
      time: T0 - (past - 1 - i) * 600,
      path: `/v2/radar/${'abc'}${String(i).padStart(3, '0')}`,
    })),
    nowcast: Array.from({ length: nowcast }, (_, i) => ({
      time: T0 + (i + 1) * 600,
      path: `/v2/radar/nc${String(i).padStart(4, '0')}`,
    })),
  },
});

const NOW = (T0 + 120) * 1000;               // two minutes after the newest frame

test('the index is shaped down to frames the tile route can address', () => {
  const s = shapeIndex(rawIndex({ past: 3 }));
  assert.equal(s.host, 'https://tiles.example');
  assert.equal(s.frames.length, 3);
  assert.deepEqual(s.frames.map(f => f.kind), ['past', 'past', 'past']);
  assert.deepEqual(s.frames.map(f => f.id), ['abc000', 'abc001', 'abc002']);
  assert.ok(s.frames.every(f => f.path.startsWith('/v2/radar/')),
    'the upstream path rides along for the tile route');
  for (let i = 1; i < s.frames.length; i++) {
    assert.ok(s.frames[i].time > s.frames[i - 1].time, 'frames come out in time order');
  }
});

test('no nowcast is an ordinary answer, not a failure', () => {
  // Measured live: the vendor returned zero forecast frames. A loop that
  // assumes they exist is a loop that is sometimes simply wrong.
  const s = shapeIndex(rawIndex({ past: 13, nowcast: 0 }));
  assert.equal(s.frames.length, 13);
  const c = framesForClient(s, { now: NOW });
  assert.equal(c.tooOld, false);
  assert.ok(c.frames.every(f => f.kind === 'past'));
});

test('nowcast frames are kept apart from past ones, and never date the reel', () => {
  const s = shapeIndex(rawIndex({ past: 3, nowcast: 2 }));
  assert.deepEqual(s.frames.map(f => f.kind), ['past', 'past', 'past', 'nowcast', 'nowcast']);

  // The age must come off the newest PAST frame. A nowcast frame is stamped
  // in the future, so measuring against it would report a two-hour-old reel
  // as brand new — the exact failure the cutoff exists to prevent.
  const old = shapeIndex({
    ...rawIndex({ past: 1, nowcast: 1 }),
    radar: {
      past: [{ time: T0 - 3600, path: '/v2/radar/oldone' }],
      nowcast: [{ time: T0 + 600, path: '/v2/radar/future' }],
    },
  });
  const c = framesForClient(old, { now: NOW });
  assert.equal(c.tooOld, true, 'an hour-old reel is too old however far its nowcast reaches');
  assert.ok(c.ageMinutes >= 60);
});

test('a frame that cannot be addressed is dropped, not repaired', () => {
  const raw = rawIndex({ past: 2 });
  raw.radar.past.push({ time: T0 + 600, path: '' });
  raw.radar.past.push({ time: NaN, path: '/v2/radar/badtime' });
  raw.radar.past.push({ time: T0 + 700, path: '/v2/radar/NOT-VALID!' });
  const s = shapeIndex(raw);
  assert.equal(s.frames.length, 2, 'only the two addressable frames survive');
  assert.ok(s.frames.every(f => validId(f.id)));
});

test('an index with nothing usable in it throws rather than returning an empty loop', () => {
  assert.throws(() => shapeIndex({ host: 'https://x', radar: { past: [] } }),
    /no usable frames/);
  assert.throws(() => shapeIndex({ radar: { past: [{ time: T0, path: '/v2/radar/abc123' }] } }),
    /no host/, 'a frame path is useless without the host to hang it on');
});

test('the page is handed frames with no vendor path on them', () => {
  const s = shapeIndex(rawIndex({ past: 3 }));
  const c = framesForClient(s, { now: NOW, fetchedAt: NOW });
  assert.ok(c.frames.every(f => !('path' in f)),
    'a page that learns the upstream URL is a page that can contact it directly');
  assert.ok(JSON.stringify(c).indexOf('tiles.example') === -1,
    'and the host does not leak through some other field');
  assert.deepEqual(Object.keys(c.frames[0]).sort(), ['id', 'kind', 'time']);
});

test('past the cutoff the answer says so, and says why', () => {
  const s = shapeIndex(rawIndex({ past: 3 }));
  const fresh = framesForClient(s, { now: NOW });
  assert.equal(fresh.tooOld, false);
  assert.equal(fresh.note, null);
  assert.equal(fresh.cutoffMinutes, STALE_CUTOFF_MINUTES);
  assert.equal(fresh.ageMinutes, 2);

  // One minute inside the limit still draws; one minute past it does not.
  const inside = framesForClient(s, { now: (T0 + (STALE_CUTOFF_MINUTES - 1) * 60) * 1000 });
  assert.equal(inside.tooOld, false, 'inside the cutoff radar still draws, with its age attached');
  const outside = framesForClient(s, { now: (T0 + (STALE_CUTOFF_MINUTES + 1) * 60) * 1000 });
  assert.equal(outside.tooOld, true);
  assert.match(outside.note, /needs a signal/);
  assert.match(outside.note, new RegExp(String(STALE_CUTOFF_MINUTES)));
});

test('the tile URL carries the no-green palette, and the size the map draws', () => {
  const s = shapeIndex(rawIndex({ past: 1 }));
  const url = tileUrl(s, s.frames[0], 14, 4066, 5949);
  assert.equal(url,
    `https://tiles.example/v2/radar/abc000/${TILE_SIZE}/14/4066/5949/${PALETTE}/${TILE_OPTIONS}.png`);
  assert.equal(PALETTE, 2, 'Universal Blue — the classic ramp hides light rain on green ground');
});

test('an id is checked before it can become part of an outbound request', () => {
  for (const bad of ['../../etc', 'AB123', 'a', 'x'.repeat(40), '', null, undefined, 'a/b']) {
    assert.equal(validId(bad), false, JSON.stringify(bad) + ' is refused');
  }
  assert.ok(validId('24ed973a7a8c'), 'the shape the vendor actually returns');
  const s = shapeIndex(rawIndex({ past: 2 }));
  assert.equal(frameById(s, 'nosuchframe'), null);
  assert.equal(frameById(s, 'abc001').time, T0);
});

test('frame age is measured, not guessed', () => {
  assert.equal(frameAgeMinutes({ time: T0 }, (T0 + 600) * 1000), 10);
  assert.equal(frameAgeMinutes(null), null);
  assert.equal(frameAgeMinutes({ time: 'soon' }), null);
});

test('the index cache refetches on its TTL and folds concurrent callers into one', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => rawIndex() }; };
  const cache = makeIndexCache();

  const first = await cache.get({ fetchImpl });
  assert.equal(calls, 1);
  assert.equal(first.cached, false);

  const again = await cache.get({ fetchImpl });
  assert.equal(calls, 1, 'inside the TTL nothing is refetched');
  assert.equal(again.cached, true);

  cache.clear();
  const [a, b, c] = await Promise.all([
    cache.get({ fetchImpl }), cache.get({ fetchImpl }), cache.get({ fetchImpl }),
  ]);
  assert.equal(calls, 2, 'three simultaneous callers cost one request, not three');
  assert.ok(a.shaped && b.shaped && c.shaped);
  assert.equal(INDEX_TTL_SECONDS, 300);
});

test('losing the network degrades to the last good index, flagged', async () => {
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('getaddrinfo ENOTFOUND');
    return { ok: true, json: async () => rawIndex() };
  };
  const cache = makeIndexCache({ ttlSeconds: 0 });
  const good = await cache.get({ fetchImpl });
  assert.equal(good.error, null);

  fail = true;
  const stale = await cache.get({ fetchImpl });
  assert.equal(stale.cached, true);
  assert.match(stale.error, /ENOTFOUND/, 'the failure rides along rather than being swallowed');
  assert.ok(stale.shaped.frames.length, 'and the frames are still there to be judged on age');
});

test('with nothing cached at all, a failed fetch throws rather than inventing a loop', async () => {
  const cache = makeIndexCache();
  await assert.rejects(
    cache.get({ fetchImpl: async () => { throw new Error('down'); } }), /down/);
});

test('a bad index response is refused', async () => {
  const cache = makeIndexCache();
  await assert.rejects(
    cache.get({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('the tile cache is bounded, and forgets whole frames when they age out', () => {
  const cache = makeTileCache({ maxTiles: 10 });
  const tile = { body: Buffer.from([1]), contentType: 'image/png' };
  for (const id of ['f1', 'f2']) {
    for (let x = 0; x < 3; x++) cache.put(id, 14, x, 0, tile);
  }
  assert.equal(cache.size, 6);
  assert.equal(cache.frames, 2);
  assert.ok(cache.get('f1', 14, 1, 0), 'a stored tile comes back');
  assert.equal(cache.get('f1', 14, 9, 0), null, 'and one never stored does not');
  assert.equal(cache.get('nosuch', 14, 1, 0), null);

  // Storing the same tile twice is not two tiles.
  cache.put('f1', 14, 1, 0, tile);
  assert.equal(cache.size, 6);

  // The index stops listing f1: every one of its tiles goes at once, because
  // a frame nobody can select is a frame nobody will ask for again.
  cache.keepOnly(['f2']);
  assert.equal(cache.frames, 1);
  assert.equal(cache.size, 3);
  assert.equal(cache.get('f1', 14, 1, 0), null);
  assert.ok(cache.get('f2', 14, 1, 0));
});

test('the tile cache has a ceiling of its own, for a pan that outruns the index', () => {
  const cache = makeTileCache({ maxTiles: 5 });
  const tile = { body: Buffer.from([1]), contentType: 'image/png' };
  for (let f = 0; f < 4; f++) {
    for (let x = 0; x < 3; x++) cache.put('frame' + f, 14, x, 0, tile);
  }
  assert.ok(cache.size <= 5 + 3, 'the ceiling holds within one frame of slack');
  assert.ok(cache.get('frame3', 14, 0, 0), 'the newest frame survives');
  assert.equal(cache.get('frame0', 14, 0, 0), null, 'the oldest was dropped whole');
});
