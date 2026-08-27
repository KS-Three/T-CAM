import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, getProvider, providerIds, usableProviders, credentialsFor }
  from '../providers/index.mjs';
import { cameraSummary } from '../spypoint-sync.mjs';
import { FLEX_M, LEGACY_SHAPE, PHOTO } from '../fixtures/cameras.js';

test('every provider declares the interface', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(p.id, id, `${id}: id matches its registry key`);
    assert.ok(p.label, `${id}: has a label`);
    assert.match(p.envPrefix, /^[A-Z][A-Z0-9_]*$/, `${id}: env prefix is shouty`);
    for (const m of ['login', 'cameras', 'photos', 'normalizeCamera',
      'photoDate', 'photoUrl', 'photoId', 'photoTags']) {
      assert.equal(typeof p[m], 'function', `${id}: ${m} is a function`);
    }
  }
});

test('provider env prefixes are unique, so brands cannot collide', () => {
  const prefixes = Object.values(PROVIDERS).map(p => p.envPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test('getProvider resolves case-insensitively and rejects the unknown', () => {
  assert.equal(getProvider('spypoint').id, 'spypoint');
  assert.equal(getProvider('SpyPoint').id, 'spypoint');
  assert.throws(() => getProvider('nikon'), /unknown provider/);
  assert.throws(() => getProvider(undefined), /unknown provider/);
});

test('an unimplemented provider refuses with an explanation, not a crash', () => {
  // Moultrie is registered so it is discoverable and documented, but must never
  // pretend to work — a provider returning plausible wrong data would be drawn
  // on the map and fed to the hunt planner without complaint.
  assert.ok(providerIds().includes('moultrie'));
  assert.equal(PROVIDERS.moultrie.implemented, false);
  assert.throws(() => getProvider('moultrie'), /not implemented/i);
  assert.throws(() => getProvider('moultrie'), /moultrie-capture\.md/);
  for (const m of ['login', 'cameras', 'photos', 'normalizeCamera']) {
    assert.throws(() => PROVIDERS.moultrie[m](), /not implemented/i,
      `moultrie.${m} refuses rather than returning something`);
  }
  assert.ok(!usableProviders().some(p => p.id === 'moultrie'),
    'unimplemented providers are excluded from a sync-everything run');
});

test('credentials are read from the provider-specific prefix', () => {
  const env = {
    SPYPOINT_EMAIL: 'a@example.com', SPYPOINT_PASSWORD: 'sp',
    MOULTRIE_EMAIL: 'b@example.com', MOULTRIE_PASSWORD: 'mo',
  };
  assert.deepEqual(credentialsFor(PROVIDERS.spypoint, env),
    { email: 'a@example.com', password: 'sp' });
  assert.deepEqual(credentialsFor(PROVIDERS.moultrie, env),
    { email: 'b@example.com', password: 'mo' });
  assert.deepEqual(credentialsFor(PROVIDERS.spypoint, {}),
    { email: null, password: null });
});

test('the extracted SpyPoint provider still produces the pre-refactor output', () => {
  // Pinned to an explicit snapshot rather than to cameraSummary(): the sync now
  // re-exports the provider's function, so comparing the two would compare a
  // function with itself and pass no matter what broke.
  const sp = PROVIDERS.spypoint;
  assert.deepEqual(sp.normalizeCamera(FLEX_M), {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'North Ridge',
    model: 'FLEX-M',
    lat: 44.123456,
    lng: -90.654321,
    gpsFix: '2025-11-28T15:00:42.000Z',
    battery: 20,
    batteryLevel: 'medium',
    batterySource: 'AA',
    signal: 100,
    signalBars: 4,
    signalLevel: 'high',
    signalType: 'LTE',
    tempValue: 26,
    tempUnit: 'F',
    memUsed: 1758,
    memSize: 1871,
    plan: 'Free',
    photoCount: 0,
    photoLimit: 100,
    lastSeen: '2025-11-28T15:00:42.000Z',
  });

  // The sync's re-export must stay wired to the provider, not drift into a
  // second copy of the same logic.
  assert.equal(cameraSummary, sp.normalizeCamera,
    'spypoint-sync re-exports the provider function rather than duplicating it');

  assert.equal(sp.photoDate(PHOTO), '2025-11-27T22:14:03.000Z');
  assert.equal(sp.photoUrl(PHOTO, 'large'), 'https://example-cdn.invalid/lg/photo.jpg');
  assert.equal(sp.photoUrl(PHOTO, 'small'), 'https://example-cdn.invalid/sm/photo.jpg');
  assert.equal(sp.photoId(PHOTO), 'dddddddddddddddddddddddd');
  assert.deepEqual(sp.photoTags(PHOTO), ['deer']);
});

test('the normalized camera keeps latitude and longitude apart', () => {
  // The contract every future provider has to meet. Named fields, never a
  // positional pair, because the ordering is the classic way to get this wrong.
  const r = PROVIDERS.spypoint.normalizeCamera(FLEX_M);
  assert.equal(r.lat, 44.123456);
  assert.equal(r.lng, -90.654321);
  assert.ok(!('coordinates' in r), 'no positional array escapes the provider');
  for (const field of ['id', 'name', 'model', 'lat', 'lng', 'battery',
    'signal', 'lastSeen']) {
    assert.ok(field in r, `normalized camera exposes ${field}`);
  }
});

test('missing data normalizes to null rather than a stand-in value', () => {
  // Zero and unknown must stay distinguishable: the health rules treat a 0%
  // battery as urgent, and inventing a number would raise a false alarm or
  // hide a real one.
  const r = PROVIDERS.spypoint.normalizeCamera({ config: { name: 'Bare' } });
  for (const field of ['lat', 'lng', 'battery', 'signal', 'lastSeen', 'model']) {
    assert.equal(r[field], null, `${field} is null when absent`);
  }
  assert.equal(r.name, 'Bare');
});
