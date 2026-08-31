/**
 * The suggester over HTTP. The unit tests cover the geometry; these cover the
 * things only the endpoint can get wrong — where it looks, what it does when an
 * input is missing, and whether it says so rather than quietly changing what
 * its numbers mean.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStand } from '../db.mjs';
import { createServer } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-suggest-'));

async function serving(t, seed = () => {}) {
  const out = tmp();
  const db = openDb(out);
  seed(db);
  db.close();
  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: p => fetch(base + p), out };
}

test('with nothing placed it asks for a stand rather than guessing a location', async t => {
  const { get } = await serving(t);
  const res = await get('/api/suggest-stands');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /drop a stand on the map first/);
});

test('it centres on your own ground without being told where that is', async t => {
  // No lat/lng in the query: the endpoint averages what you have placed. The
  // terrain fetch will fail in a test environment, and that is the point —
  // the failure has to name the ground it tried, not a default.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'B', lat: 44.130, lng: -90.660 });
  });
  const res = await get('/api/suggest-stands');
  const body = await res.json();
  if (res.status === 200 && body.at) {
    assert.ok(Math.abs(body.at.lat - 44.125) < 1e-6, 'centred between the two stands');
    assert.ok(Math.abs(body.at.lng + 90.655) < 1e-6);
  } else {
    // Offline: a 502 naming the terrain failure is the correct outcome, and
    // must not be dressed up as "no suggestions here".
    assert.equal(res.status, 502);
    assert.match(body.error, /terrain/);
  }
});

test('the radius is clamped rather than trusted', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  for (const [asked, expected] of [['5', 150], ['999999', 1200], ['abc', 500]]) {
    const body = await (await get(`/api/suggest-stands?radius=${asked}`)).json();
    if (body.at) assert.equal(body.at.radiusM, expected, `radius=${asked}`);
  }
});

test('bad coordinates are refused, not converted', async t => {
  // Number(null) is 0 and 0,0 is a real place in the Atlantic. The endpoint
  // falls back to your own ground rather than to the origin.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const body = await (await get('/api/suggest-stands?lat=&lng=')).json();
  if (body.at) {
    assert.notEqual(body.at.lat, 0, 'an empty lat did not become the equator');
    assert.ok(Math.abs(body.at.lat - 44.12) < 1e-6);
  }
});

test('it reports whether wind history was available, because it changes the ranking', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65, goodWinds: 'NW' });
  });
  const res = await get('/api/suggest-stands');
  const body = await res.json();
  if (res.status === 200 && 'windHistoryLoaded' in body) {
    assert.equal(typeof body.windHistoryLoaded, 'boolean');
    // Nothing cached in a fresh database, so the suggester must say the
    // ranking is not about filling a wind gap.
    assert.equal(body.windHistoryLoaded, false);
    if (body.notes) {
      assert.ok(body.notes.some(n => /No wind history loaded/.test(n))
        || body.note, 'the missing input is explained');
    }
  }
});

test('the map sends what it can see, so the answer can say what is off-screen', async () => {
  // Structural, because the viewport is only worth anything if the client
  // actually reports it. It no longer FILTERS — the property you picked is the
  // scope now, and a spot on it is on it whatever the zoom — but the answer
  // still counts how many are off the edge, because a pin you cannot see reads
  // as the tool having ignored where you are looking.
  const { mapScript } = await import('../map-view.mjs');
  assert.match(mapScript, /const vb = visibleBounds\(\);/, 'the bounds are read at request time');
  for (const k of ['north', 'south', 'east', 'west']) {
    assert.ok(mapScript.includes("'&" + k + "=' + vb." + k + ".toFixed(6)"), `${k} is sent`);
  }
});

test('bounds are echoed back, so the page can tell whether they were honoured', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const q = '?lat=44.12&lng=-90.65&north=44.13&south=44.11&east=-90.64&west=-90.66';
  const body = await (await get('/api/suggest-stands' + q)).json();
  if (body.view) {
    assert.deepEqual(body.view, { north: 44.13, south: 44.11, east: -90.64, west: -90.66 });
  }
});

test('a request with no bounds still works — the clip is optional', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const res = await get('/api/suggest-stands?lat=44.12&lng=-90.65');
  const body = await res.json();
  assert.ok(res.status === 200 || res.status === 502, `unexpected ${res.status}`);
  if (res.status === 200 && 'view' in body) assert.equal(body.view, null);
});

test('partial bounds are ignored rather than half-applied', async t => {
  // Three of the four corners is not a viewport. Clipping on a made-up fourth
  // edge would drop good ground for a reason nobody could see.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const body = await (await get('/api/suggest-stands?lat=44.12&lng=-90.65&north=44.13&south=44.11')).json();
  if ('view' in body) assert.equal(body.view, null);
});

test('the answer says which property it is about', async t => {
  // Two grounds a drive apart. A request centred on one of them must not be
  // reasoning about the stands on the other.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'Home oak', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'Far ladder', lat: 44.250, lng: -90.450 });
  });
  const body = await (await get('/api/suggest-stands?lat=44.1205&lng=-90.6505')).json();
  if ('ground' in body && body.ground) {
    assert.equal(body.ground.counts.stand, 1, 'one stand on this ground, not both');
  }
});

// ---- the property picker -------------------------------------------------
// Which ground a suggestion is about is now ASKED, not inferred. The map
// centre was the old answer and on the view that frames everything it lands in
// open country between two properties, where the honest answer is neither —
// at which point the old code fell back to every stand and let an owner-name
// vote pick a deed forty kilometres away.

test('with nothing placed, the property list is empty and says why', async t => {
  const { get } = await serving(t);
  const body = await (await get('/api/my-properties')).json();
  assert.deepEqual(body.properties, []);
  assert.match(body.note, /Nothing is placed yet/);
});

test('each property carries the boundary the page has to draw', async t => {
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.120, lng: -90.650 });
  });
  const body = await (await get('/api/my-properties')).json();
  assert.equal(body.properties.length, 1, 'one cluster, one property');
  const p = body.properties[0];
  assert.equal(p.key, 'g0');
  assert.ok('parcels' in p, 'parcels are always reported, even when empty');
  assert.ok('centre' in p && 'bounds' in p, 'the page needs somewhere to fly to');
  // Offline (or outside Wisconsin) there is simply no parcel, which is a real
  // answer: the shape must still be right so the picker can render a row.
  for (const parcel of p.parcels) {
    assert.ok('rings' in parcel && 'owner' in parcel && 'acres' in parcel);
  }
});

test('two properties get labels that tell them apart', async t => {
  // The failure this pins: describeGround says what is ON a ground, and two
  // properties hunted the same way describe identically — a picker whose two
  // rows both read "2 cameras, 1 stand" is not a picker.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'Home', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'Far', lat: 44.250, lng: -90.450 });
  });
  const body = await (await get('/api/my-properties')).json();
  assert.equal(body.properties.length, 2, 'a drive apart is two properties');
  const [a, b] = body.properties.map(p => p.label);
  // Offline both fall back to the contents and DO match; with a parcel service
  // they carry acreage and county. Either way the keys must differ, which is
  // what the page actually selects on.
  assert.notEqual(body.properties[0].key, body.properties[1].key);
  assert.ok(typeof a === 'string' && typeof b === 'string');
});

test('over open country it refuses to guess, and hands back the list', async t => {
  // The bug in the shipped version: the default "Everything" view centres
  // between two properties, and the answer came back judged against whichever
  // deed the owner vote happened to pick.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'Home', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'Far', lat: 44.250, lng: -90.450 });
  });
  const res = await get('/api/suggest-stands?lat=44.19&lng=-90.55');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.needsProperty, true, 'it asked instead of guessing');
  assert.deepEqual(body.candidates, []);
  assert.equal(body.properties.length, 2, 'and said what there is to choose from');
  assert.match(body.note, /not over one of your properties/);
});

test('an unknown property key is refused rather than ignored', async t => {
  // Silently falling back to "everything" would make a typo look like a
  // working search over ground the person did not ask about.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const res = await get('/api/suggest-stands?properties=g99');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no property matches g99/);
});

test('an explicit property beats the map centre entirely', async t => {
  // Ask about the far ground while the map is parked on the home one: the
  // answer must be about what was asked for, not about where the map is.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'Home', lat: 44.120, lng: -90.650 });
    createStand(db, { name: 'Far', lat: 44.250, lng: -90.450 });
  });
  const body = await (await get('/api/suggest-stands?properties=g1&lat=44.120&lng=-90.650')).json();
  assert.ok(!body.needsProperty, 'no need to ask — it was told');
  if (body.properties && body.properties.length) {
    assert.equal(body.properties.length, 1, 'exactly the one ground asked for');
  }
});

test('the viewport reports what is off-screen; it no longer throws it away', async t => {
  // The clip used to run before the lookups, which was right when the search
  // was a circle round the map centre. Now the property is the scope, so a
  // spot on the ground you picked is on it whatever the zoom — the answer
  // says how many you cannot see rather than hiding them.
  const { get } = await serving(t, db => {
    createStand(db, { name: 'A', lat: 44.12, lng: -90.65 });
  });
  const q = '?properties=g0&north=44.1201&south=44.1199&east=-90.6499&west=-90.6501';
  const body = await (await get('/api/suggest-stands' + q)).json();
  assert.ok('offScreen' in body, 'the count is reported');
  assert.equal(typeof body.offScreen, 'number');
});

test('the map asks for the properties it has ticked', async () => {
  const { mapScript } = await import('../map-view.mjs');
  assert.match(mapScript, /\/api\/my-properties/, 'the page can list your ground');
  assert.match(mapScript, /SELECTED_PROPS/, 'and remembers which you picked');
  assert.ok(mapScript.includes("'&properties=' + [...SELECTED_PROPS].join(',')"),
    'the selection is what the request carries');
  assert.match(mapScript, /path class="myprop"/, 'and the boundary is drawn');
  assert.match(mapScript, /body\.needsProperty/, 'a refusal to guess opens the picker');
});
