import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, createStand, updateStand, deleteStand, allStands, normalizeWinds,
  standHuntableOn, upsertCamera, upsertProperty, STAND_TYPES,
} from '../db.mjs';
import { createServer } from '../serve.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const fresh = () => openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-stands-')));
const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

// The fixture camera's position, so stands can be placed a known distance away.
const CAM_LAT = 44.123456;
const CAM_LNG = -90.654321;

test('a stand is created with a name, type and position', () => {
  const db = fresh();
  const s = createStand(db, {
    name: 'East Ridge Ladder', type: 'stand', lat: CAM_LAT, lng: CAM_LNG,
    goodWinds: ['NW', 'W'], notes: 'watch the funnel',
  });
  assert.equal(s.name, 'East Ridge Ladder');
  assert.equal(s.type, 'stand');
  assert.equal(s.lat, CAM_LAT);
  assert.equal(s.lng, CAM_LNG);
  assert.equal(s.good_winds, 'NW,W');
  assert.equal(s.notes, 'watch the funnel');
});

test('every stand type in the list is accepted, and nothing else is', () => {
  const db = fresh();
  for (const type of STAND_TYPES) {
    const s = createStand(db, { name: `a ${type}`, type, lat: 44, lng: -90 });
    assert.equal(s.type, type);
  }
  assert.throws(() => createStand(db, { name: 'x', type: 'treehouse', lat: 44, lng: -90 }),
    /unknown stand type/);
});

test('a stand without a name or a real position is refused', () => {
  const db = fresh();
  assert.throws(() => createStand(db, { name: '  ', lat: 44, lng: -90 }), /needs a name/);
  assert.throws(() => createStand(db, { name: 'x', lat: null, lng: -90 }), /needs coordinates/);
  assert.throws(() => createStand(db, { name: 'x', lat: 44, lng: NaN }), /needs coordinates/);
  // Out-of-range coordinates are a transposed lat/lng in disguise: a longitude
  // of -90 in the latitude slot is legal, but 120 is not, and catching it here
  // is cheaper than wondering why a pin is in the sea.
  assert.throws(() => createStand(db, { name: 'x', lat: 120, lng: -90 }), /out of range/);
  assert.throws(() => createStand(db, { name: 'x', lat: 44, lng: 200 }), /out of range/);
});

test('wind lists are normalized, and rubbish is dropped rather than stored', () => {
  assert.equal(normalizeWinds(['nw', ' w ', 'NW']), 'NW,W', 'upper-cased and de-duplicated');
  assert.equal(normalizeWinds('N, NNE, banana'), 'N,NNE', 'unknown points are discarded');
  assert.equal(normalizeWinds([]), null);
  assert.equal(normalizeWinds(null), null);
  assert.equal(normalizeWinds('banana'), null, 'nothing valid means nothing stored');
});

test('a stand with no recorded winds answers "unknown", never "yes"', () => {
  // The dangerous failure: treating "I have not told it yet" as "huntable"
  // would send you to sit somewhere the deer will smell you.
  const unset = { good_winds: null };
  assert.equal(standHuntableOn(unset, 315), null);

  const nw = { good_winds: 'NW,W' };
  assert.equal(standHuntableOn(nw, 315), true, '315° is NW');
  assert.equal(standHuntableOn(nw, 270), true, '270° is W');
  assert.equal(standHuntableOn(nw, 180), false, 'a south wind is not on the list');
  assert.equal(standHuntableOn(nw, null), null, 'no wind reading, no answer');
  assert.equal(standHuntableOn(nw, 0), false);
  assert.equal(standHuntableOn(nw, 360), false, 'wraps without becoming NW');
});

test('a partial update leaves untouched fields alone', () => {
  // A rename must not silently clear the winds — that would quietly turn a
  // known-good stand into one the tool refuses to recommend.
  const db = fresh();
  const s = createStand(db, {
    name: 'Old Name', lat: 44, lng: -90, goodWinds: ['NW'], notes: 'keep me', type: 'tripod',
  });
  const renamed = updateStand(db, s.id, { name: 'New Name' });
  assert.equal(renamed.name, 'New Name');
  assert.equal(renamed.good_winds, 'NW', 'winds survive a rename');
  assert.equal(renamed.notes, 'keep me');
  assert.equal(renamed.type, 'tripod');
  assert.notEqual(renamed.updated_at, null);

  // But an explicit null DOES clear them.
  assert.equal(updateStand(db, s.id, { goodWinds: null }).good_winds, null);
});

test('moving a stand updates its position', () => {
  const db = fresh();
  const s = createStand(db, { name: 'Moved', lat: 44, lng: -90 });
  const moved = updateStand(db, s.id, { lat: 44.5, lng: -90.5 });
  assert.equal(moved.lat, 44.5);
  assert.equal(moved.lng, -90.5);
});

test('updating or deleting a stand that is not there says so', () => {
  const db = fresh();
  assert.throws(() => updateStand(db, 999, { name: 'x' }), /no stand with id 999/);
  assert.equal(deleteStand(db, 999), false);
});

test('stands list the cameras near them, nearest first', () => {
  // This is the link that turns "camera A has been busy" into "sit the stand
  // that covers camera A".
  const db = fresh();
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });

  const close = createStand(db, { name: 'Over the camera', lat: CAM_LAT, lng: CAM_LNG });
  // ~1.1 km north — well outside the default 400 m reach.
  const far = createStand(db, { name: 'Far Ridge', lat: CAM_LAT + 0.01, lng: CAM_LNG });

  const stands = allStands(db);
  const byName = Object.fromEntries(stands.map(s => [s.name, s]));

  assert.equal(byName['Over the camera'].nearbyCameras.length, 1);
  assert.equal(byName['Over the camera'].nearbyCameras[0].name, 'North Ridge');
  assert.ok(byName['Over the camera'].nearbyCameras[0].metres < 5);
  assert.equal(byName['Far Ridge'].nearbyCameras.length, 0,
    'a camera a kilometre away is not "near" the stand');
  assert.ok(close.id !== far.id);
});

test('stands carry their property name and parsed winds', () => {
  const db = fresh();
  const prop = upsertProperty(db, 'Home 40');
  createStand(db, { name: 'North Box', type: 'box-blind', lat: 44, lng: -90,
    propertyId: prop.id, goodWinds: ['S', 'SW'] });
  const [s] = allStands(db);
  assert.equal(s.property_name, 'Home 40');
  assert.deepEqual(s.winds, ['S', 'SW'], 'parsed for the client, not left as a string');
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-standsrv-'));
  const db = openDb(out);
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  db.close();

  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  const call = (method, p, body) => fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { call };
}

test('a pin dropped through the API round-trips', async t => {
  const { call } = await serving(t);

  const created = await call('POST', '/api/stands', {
    name: 'Creek Tripod', type: 'tripod', lat: CAM_LAT, lng: CAM_LNG,
    goodWinds: ['NW', 'N'],
  });
  assert.equal(created.status, 201);
  const stand = await created.json();
  assert.equal(stand.name, 'Creek Tripod');
  assert.equal(stand.good_winds, 'NW,N');

  const list = await (await call('GET', '/api/stands')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].nearbyCameras[0].name, 'North Ridge',
    'the new pin already knows which camera it covers');

  const patched = await (await call('PATCH', `/api/stands/${stand.id}`,
    { name: 'Creek Tripod (moved)', lat: CAM_LAT + 0.0005 })).json();
  assert.equal(patched.name, 'Creek Tripod (moved)');
  assert.equal(patched.good_winds, 'NW,N', 'a move does not clear the winds');

  assert.equal((await call('DELETE', `/api/stands/${stand.id}`)).status, 200);
  assert.equal((await (await call('GET', '/api/stands')).json()).length, 0);
});

test('the API rejects a bad stand with a message naming the problem', async t => {
  const { call } = await serving(t);
  for (const [body, expected] of [
    [{ lat: 44, lng: -90 }, /needs a name/],
    [{ name: 'x', lat: 'nowhere', lng: -90 }, /needs coordinates/],
    [{ name: 'x', type: 'treehouse', lat: 44, lng: -90 }, /unknown stand type/],
    [{ name: 'x', lat: 999, lng: -90 }, /out of range/],
  ]) {
    const res = await call('POST', '/api/stands', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, expected);
  }
  assert.equal((await call('PATCH', '/api/stands/999', { name: 'x' })).status, 404);
  assert.equal((await call('DELETE', '/api/stands/999')).status, 404);
});

test('a malformed body is a 400, not a 500 and not a crashed server', async t => {
  const { call } = await serving(t);
  const base = new URL((await call('GET', '/api/stands')).url).origin;

  const bad = await fetch(`${base}/api/stands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json',
  });
  assert.equal(bad.status, 400, 'invalid JSON is the caller\'s mistake, not a server fault');
  assert.match((await bad.json()).error, /valid JSON/);

  // An oversized body is refused rather than read into memory unbounded.
  const huge = await fetch(`${base}/api/stands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(200000), lat: 44, lng: -90 }),
  }).catch(() => ({ status: 400 }));
  assert.ok([400, 500].includes(huge.status), 'a huge body does not succeed');

  // The server is still answering afterwards, which is the real assertion.
  assert.equal((await call('GET', '/api/stands')).status, 200);
});

test('stands appear in the one-call state alongside cameras', async t => {
  const { call } = await serving(t);
  await call('POST', '/api/stands', { name: 'Box', type: 'box-blind', lat: 44, lng: -90 });
  const s = await (await call('GET', '/api/state')).json();
  assert.equal(s.stands.length, 1);
  assert.equal(s.stands[0].name, 'Box');
  assert.equal(s.cameras.length, 1);
});

test('the client can ask what types and winds are allowed', async t => {
  // So the drop-a-pin form is built from the server's list rather than a copy
  // that drifts out of step with the CHECK constraint.
  const { call } = await serving(t);
  const meta = await (await call('GET', '/api/stand-types')).json();
  assert.deepEqual(meta.types, STAND_TYPES);
  assert.equal(meta.winds.length, 16);
  assert.ok(meta.winds.includes('NW'));
});

test('the Add stand button is only offered on a page that can actually save', async () => {
  // The bug this pins: `live` was hardcoded true, so the STATIC dashboard the
  // sync writes also showed the button. A file:// page has no server to POST
  // to, so pressing it did nothing at all — the worst kind of broken, because
  // it looks like a working control.
  const { dashboardHtml } = await import('../dashboard-page.mjs');
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];

  const staticPage = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z', null, []);
  assert.match(staticPage, /"live":false/,
    'the file written by the sync declares itself not live');
  assert.match(staticPage, /Stands need the server/,
    'and the page explains why the control is unavailable');

  const servedPage = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z', null, [], true);
  assert.match(servedPage, /"live":true/, 'the served page can save');
});

test('a served page carries its stands into the rendered payload', async () => {
  const { dashboardHtml } = await import('../dashboard-page.mjs');
  const stands = [{ id: 1, name: 'East Ridge Ladder', type: 'tripod',
    lat: 44.1, lng: -90.6, winds: ['NW'], nearbyCameras: [] }];
  const html = dashboardHtml([], [], '2026-08-27T12:00:00.000Z', null, stands, true);
  assert.match(html, /East Ridge Ladder/);
});

test('map controls are not stolen by the drag handler', async () => {
  // The bug this pins, and it killed every control on the map at once.
  //
  // The click handler and the pointerdown handler each carried their OWN list
  // of "things on the map that are not the ground". When the toolbar was added,
  // only the click handler's list was updated. So pressing "+ Add stand" ran
  // the drag handler, which calls setPointerCapture on #map — and pointer
  // capture retargets the following click to the capturing element. The button
  // never received its own click. Same for "Who owns this?", the stand form's
  // inputs, and reopening an existing pin.
  //
  // This is a STRUCTURAL check: it asserts the two handlers share one predicate
  // rather than proving browser behaviour, which needs a real browser (verified
  // by hand). Sharing the predicate is what makes the drift impossible.
  const { dashboardHtml } = await import('../dashboard-page.mjs');
  const html = dashboardHtml([], [], '2026-08-27T12:00:00.000Z', null, [], true);

  assert.equal((html.match(/const onMapGround =/g) || []).length, 1,
    'exactly one definition of "is this the map ground"');

  const click = html.match(/mapEl\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  const down = html.match(/mapEl\.addEventListener\('pointerdown',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert.ok(click && down, 'both handlers were found');
  assert.match(click, /onMapGround\(e\.target\)/, 'the click handler uses the shared test');
  assert.match(down, /onMapGround\(e\.target\)/,
    'and so does the drag handler — a control must not start a drag or capture the pointer');

  // The specific shape of the old bug: a hand-rolled subset in the drag path.
  assert.doesNotMatch(down, /closest\(/,
    'the drag handler must not grow its own exclusion list again');
});

test('arming one map mode disarms every other one', async () => {
  // The successor to the bug above, and the same shape. Each button used to
  // carry its own list of modes to turn off, and the lists had already rotted:
  // "+ Add stand" turned nothing off at all, "Who owns this?" turned off only
  // stand placing. Adding a measure mode broke Add stand outright — measuring
  // claimed the map click first, so the button armed and then silently did
  // nothing, which is precisely the failure the whitelist above was written to
  // end.
  //
  // Structural, for the same reason: it asserts that ONE function knows every
  // mode, which is what makes the drift impossible. The behaviour itself was
  // driven in a real browser across all twenty ordered pairs of the five
  // buttons — each left exactly one mode armed and no stale crosshair.
  const { dashboardHtml } = await import('../dashboard-page.mjs');
  const html = dashboardHtml([], [], '2026-08-27T12:00:00.000Z', null, [], true);

  assert.equal((html.match(/function clearMapModes\(/g) || []).length, 1,
    'exactly one place that knows the map modes');

  // Every mode is disarmed there, so a new one is added here or nowhere.
  const body = html.match(/function clearMapModes\([\s\S]*?\n\}/)?.[0] ?? '';
  for (const mode of ['placing', 'marking', 'identifying', 'drawing', 'measuring',
    'fielding', 'entryPick']) {
    assert.match(body, new RegExp('\\b' + mode + '\\b'), `${mode} is disarmed there`);
  }

  // And every button that arms a mode goes through it.
  assert.ok((html.match(/clearMapModes\('(stand|mark|parcel|route|measure|field|entry)'\)/g) || []).length >= 7,
    'each mode arms itself through the shared disarm');

  // The old shape: one button reaching in to click another.
  assert.doesNotMatch(html, /onclick\(new Event\('click'\)\)/,
    'no button drives another button to turn it off');
});

test('the measure tool ships the same arithmetic the tests check', async () => {
  // measure.mjs is emitted into the page rather than rewritten for it, so the
  // acreage the map shows and the acreage test/measure.test.js verifies come
  // from one definition. Interpolating it as a value also keeps its backticks
  // and escapes out of the surrounding template literal.
  const { dashboardHtml } = await import('../dashboard-page.mjs');
  const html = dashboardHtml([], [], '2026-08-27T12:00:00.000Z', null, [], true);
  assert.match(html, /const MEASURE = \(function \(\)/, 'the geometry is in the page');
  assert.match(html, /ringArea/, 'including the spherical area');
  assert.match(html, /MEASURE\.measure\(/, 'and the map calls it');
});

test('a plan with no start time loses the time, not the headline', async () => {
  // It printed "Invalid Date · AM from Invalid Date" — twice per row, in the
  // largest text on the page. The date and window are always present, so a
  // missing or unparseable start instant costs only the start time. Same
  // reasoning as the `parts` fallback directly below it in the source.
  const { dashboardHtml } = await import('../dashboard-page.mjs');
  const sit = extra => ({
    date: '2026-11-09', window: 'AM', rating: 'PRIME', total: 52, camera: 'Creek',
    windDir: 315, windFrom: 'NW', wind: 9, temp: 33, rut: 'Chasing', moon: 'full',
    parts: [], ...extra,
  });
  const html = dashboardHtml([], [], '2026-08-27T12:00:00.000Z', {
    generatedAt: '2026-08-27T12:00:00.000Z',
    sits: [sit(), sit({ start: 'not a time' }), sit({ start: '2026-11-09T11:30:00Z' })],
  }, [], true);

  // The guard is in the emitted script, so check the branch is actually there.
  assert.match(html, /Invalid Date/, 'the comment naming the bug survives');
  assert.match(html, /const timed = when && !isNaN\(when\)/,
    'the row asks whether the instant parsed before formatting it');
  assert.match(html, /s\.date \|\| 'date not recorded'/,
    'and falls back to the date the plan always carries');
});

// ---------------------------------------------------------------------------
// Shooting lanes, and the width each one carries
//
// Lanes went in without a persistence test of their own, which was already a
// gap; adding a per-lane width to the stored shape made it one worth closing.
// The failure to guard against is silent: a width that does not round-trip
// leaves a cone drawn at one angle and judged at another, and nothing looks
// wrong on the map.

test('a lane round-trips through the database with its width', () => {
  const db = fresh();
  const s = createStand(db, {
    name: 'Creek ladder', lat: 44.12, lng: -90.65,
    lanes: [
      { to: [-90.649, 44.121], label: 'The opening', spread: 22.5 },
      { to: [-90.651, 44.119], label: null },
    ],
  });
  const [back] = allStands(db);
  assert.equal(back.lanes.length, 2);
  assert.equal(back.lanes[0].spread, 22.5);
  assert.equal(back.lanes[0].label, 'The opening');
  // The second lane was never widened, so it must come back with no width at
  // all rather than a stored copy of today's default — which would outlive any
  // change to that default and quietly disagree with every lane traced after.
  assert.equal('spread' in back.lanes[1], false);
  assert.equal(s.id, back.id);
});

test('a width is rounded to a tenth, the way a dragged handle produces one', () => {
  const db = fresh();
  createStand(db, {
    name: 'Oak point', lat: 44.12, lng: -90.65,
    lanes: [{ to: [-90.649, 44.121], spread: 17.348219 }],
  });
  assert.equal(allStands(db)[0].lanes[0].spread, 17.3);
});

test('a width that is not an angle is refused rather than stored', () => {
  const db = fresh();
  for (const spread of [0, -5, 90, 180, 'wide', NaN, Infinity]) {
    assert.throws(
      () => createStand(db, {
        name: 'Bad', lat: 44.12, lng: -90.65,
        lanes: [{ to: [-90.649, 44.121], spread }],
      }),
      /half-angle in degrees/,
      `spread ${String(spread)} should be refused`,
    );
  }
});

test('patching the lanes replaces them, and leaves the ticked winds alone', () => {
  const db = fresh();
  const s = createStand(db, {
    name: 'East field box', lat: 44.12, lng: -90.65, goodWinds: ['NW', 'W'],
    lanes: [{ to: [-90.649, 44.121], spread: 12 }],
  });
  updateStand(db, s.id, { lanes: [{ to: [-90.648, 44.122], spread: 40 }] });
  const [back] = allStands(db);
  assert.equal(back.lanes.length, 1);
  assert.equal(back.lanes[0].spread, 40);
  assert.equal(back.good_winds, 'NW,W', 'a lane edit must not clear the ticks');
});

test('the API carries a lane width in and back out, and derives from it', async t => {
  const { call } = await serving(t);
  // Due north, wide enough that the derived winds cannot match the default.
  const created = await (await call('POST', '/api/stands', {
    name: 'Saddle', type: 'stand', lat: 44.12, lng: -90.65,
    lanes: [{ to: [-90.65, 44.1245], spread: 45 }],
  })).json();
  assert.equal(created.lanes[0].spread, 45);

  const [listed] = await (await call('GET', '/api/stands')).json();
  assert.equal(listed.lanes[0].spread, 45);
  assert.equal(listed.windSource, 'lanes');
  // A 45-degree half-angle plus the 30-degree plume blocks any wind from
  // within 75 degrees of south, which is everything from SSE round to SSW.
  for (const w of ['S', 'SSE', 'SE', 'SSW', 'SW']) {
    assert.ok(!listed.effectiveWinds.includes(w), `${w} should be blocked`);
  }
  assert.ok(listed.effectiveWinds.includes('N'), 'N blows down the back of you');

  const patched = await (await call('PATCH', `/api/stands/${created.id}`, {
    lanes: [{ to: [-90.65, 44.1245], spread: 5 }],
  })).json();
  assert.equal(patched.lanes[0].spread, 5);
  // Narrowed, the same lane gives those winds back.
  const [again] = await (await call('GET', '/api/stands')).json();
  assert.ok(again.effectiveWinds.includes('SE'), 'a narrow lane frees SE again');
});

test('a bad lane width is a 400 from the API, not a 500', async t => {
  const { call } = await serving(t);
  const res = await call('POST', '/api/stands', {
    name: 'Bad', type: 'stand', lat: 44.12, lng: -90.65,
    lanes: [{ to: [-90.65, 44.1245], spread: 400 }],
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /half-angle in degrees/);
});
