/**
 * The FLEX-M2, read from a real (redacted) --inspect dump of the camera that
 * joined the account on 2026-09-07.
 *
 * The suspicion that prompted this was that a new model would come through
 * blank. It does not — and that is the first thing pinned here, because a
 * fixture proving a model READS is what stops a later "simplification" of the
 * extraction from quietly breaking it.
 *
 * What the model did surface is one real defect and one cosmetic one, both
 * invisible until a second model existed to compare against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M, FLEX_M2 } from '../fixtures/cameras.js';
import { blanksFor } from '../camera-shape.mjs';
import { fmtLoc } from '../dashboard-page.mjs';

const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

test('every field of a FLEX-M2 is read', () => {
  // The headline. camera-shape.mjs is the thing that would have shouted if not,
  // so it is what asserts it: no field came through blank while the document
  // carried it.
  const row = norm(FLEX_M2);
  assert.deepEqual(blanksFor(FLEX_M2, row), [],
    'a FLEX-M2 normalizes with nothing missing');

  assert.equal(row.model, 'FLEX-M2');
  assert.equal(row.battery, 94);
  assert.equal(row.batteryLevel, 'high');
  assert.equal(row.signal, 100);
  assert.equal(row.signalBars, 5);
  assert.equal(row.signalType, 'LTE');
  assert.equal(row.tempValue, 63);
  assert.equal(row.memSize, 7893);
  assert.equal(row.photoCount, 18);
  assert.equal(row.photoLimit, 100);
  assert.equal(row.lastSeen, '2026-09-08T09:43:13.000Z');
  assert.equal(row.gpsFix, '2026-09-08T03:12:35.000Z');
});

test('coordinates land the right way round, at fourteen decimal places', () => {
  // The ordering test providers/README.md requires of every new shape. This
  // model sends far more precision than the FLEX-M, which is exactly the kind
  // of difference that makes a transposition easy to miss: both numbers look
  // unfamiliar.
  const row = norm(FLEX_M2);
  assert.equal(row.lat, 44.12345678901234, 'latitude, from slot 1 of the pair');
  assert.equal(row.lng, -90.65432109876543, 'longitude, from slot 0');
  assert.ok(row.lat > 0 && row.lng < 0, 'Wisconsin: north and west');
});

test('the fix is stored as sent, not rounded on the way in', () => {
  // Rounding at ingest would quietly alter what the vendor reported. The extra
  // digits are float noise, but they are the CAMERA'S noise, and the place to
  // deal with that is the display.
  const row = norm(FLEX_M2);
  assert.ok(String(row.lat).split('.')[1].length > 6,
    'full precision survives normalization');
});

test('"UNK" is the camera saying it does not know, and is stored as null', () => {
  // The real defect this model exposed. Its tray reports type "UNK" and it
  // carries no status.batteryType at all, so the chain lands on the vendor's
  // placeholder — which then reached the database, the CSV export and the API
  // as though the camera ran on a chemistry called UNK.
  //
  // providers/README.md: anything a provider cannot supply is null, never a
  // placeholder, because a fake value corrupts the zero-versus-unknown
  // distinction the health rules depend on.
  const row = norm(FLEX_M2);
  assert.equal(row.batterySource, null);

  // And the battery ITSELF still reads — nulling the placeholder must not take
  // the percentage with it.
  assert.equal(row.battery, 94);
  assert.equal(row.batteryLevel, 'high');
});

test('a real battery chemistry is untouched', () => {
  // The other half of the same rule: this must not null anything meaningful.
  assert.equal(norm(FLEX_M).batterySource, 'AA');
  assert.equal(norm(FLEX_M).model, 'FLEX-M');
  assert.equal(norm(FLEX_M).plan, 'Free');
});

test('the unknown-marker list is short on purpose', () => {
  const cam = extra => norm({
    id: 'x', config: { name: 'X' },
    status: { powerSources: [{ type: extra }] },
  });
  for (const marker of ['UNK', 'unk', 'Unknown', 'N/A', '   ', '']) {
    assert.equal(cam(marker).batterySource, null, `${JSON.stringify(marker)} is not a value`);
  }
  // "NA" is deliberately NOT in the list. A chemistry could be written that
  // way, and turning a real value into a null is the error nobody can spot
  // afterwards — the reverse at least shows up as an odd word on a card.
  assert.equal(cam('NA').batterySource, 'NA');
  assert.equal(cam('LITHIUM').batterySource, 'LITHIUM');
});

test('the sync prints a fix at six decimals, not fourteen', () => {
  // Cosmetic, and only in the sync's own console line, but this model made it
  // visible: loc=44.12345678901234,-90.65432109876544 reads as precision when
  // it is float noise. The camera card has always used six.
  assert.equal(fmtLoc(norm(FLEX_M2)), '44.123457,-90.654321');
  assert.equal(fmtLoc(norm(FLEX_M)), '44.123456,-90.654321');
});

test('fmtLoc refuses a missing coordinate rather than reading it as zero', () => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic. This has bitten
  // this repo three times, so the guard is isNum, not a null check.
  assert.equal(fmtLoc({ lat: null, lng: null }), '?');
  assert.equal(fmtLoc({ lat: 44.1, lng: undefined }), '?');
  assert.equal(fmtLoc({}), '?');
  assert.equal(fmtLoc({ lat: NaN, lng: -90.6 }), '?');
});

test('a FLEX-M and a FLEX-M2 are told apart by model, and both survive a sync', () => {
  // Two models on one account is the case that did not exist before, and the
  // thing --inspect now dumps one camera per.
  const models = [FLEX_M, FLEX_M2].map(c => norm(c).model);
  assert.deepEqual(models, ['FLEX-M', 'FLEX-M2']);
  assert.notEqual(norm(FLEX_M).id, norm(FLEX_M2).id, 'and by id');
});
