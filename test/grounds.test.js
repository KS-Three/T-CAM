/**
 * Grounds: which piece of land is which, discovered from what is placed on it.
 *
 * Two hunting properties on one map was the first real multi-property case.
 * The rules under test: things within walking distance are one ground, things
 * a drive apart are not; the label is the members' majority property name and
 * never a guess; naming a ground over HTTP creates the property row and
 * assigns exactly the members that were named, nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groundsFrom, groundAt, describeGround, browserSource, GROUND_GAP_M } from '../grounds.mjs';
import {
  openDb, upsertCamera, createStand, createMarker, allMarkers, allProperties,
} from '../db.mjs';
import { createServer } from '../serve.mjs';
import { mapScript } from '../map-view.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

// Two invented clusters in rural Jackson County, ~21 km apart — pointing at
// nothing, like every fixture here (this repo is public).
const HOME = [
  { id: 'c1', kind: 'camera', lat: 44.120, lng: -90.650, property: null },
  { id: 1, kind: 'stand', lat: 44.125, lng: -90.655, property: null },
  { id: 2, kind: 'stand', lat: 44.128, lng: -90.648, property: null },
];
const FAR = [
  { id: 'c2', kind: 'camera', lat: 44.250, lng: -90.450, property: null },
  { id: 3, kind: 'stand', lat: 44.253, lng: -90.447, property: null },
];

test('walking distance is one ground; a drive apart splits them', () => {
  const g = groundsFrom([...HOME, ...FAR]);
  assert.equal(g.length, 2);
  assert.equal(g[0].size, 3, 'biggest first, so the home ground stays on top');
  assert.equal(g[1].size, 2);
  assert.deepEqual(g[0].ids.stand, [1, 2]);
  assert.deepEqual(g[1].ids.camera, ['c2']);
  // The box is the members' box.
  assert.equal(g[0].bounds.south, 44.120);
  assert.equal(g[0].bounds.north, 44.128);
  assert.equal(g[0].bounds.west, -90.655);
  assert.equal(g[0].bounds.east, -90.648);
});

test('a chain of pins each within the gap stays one ground', () => {
  // Single-linkage on purpose: a long skinny property is one piece of land
  // even when its far ends are beyond the gap from each other.
  const chain = [
    { id: 1, kind: 'stand', lat: 44.120, lng: -90.650 },
    { id: 2, kind: 'stand', lat: 44.133, lng: -90.650 }, // ~1.4 km up
    { id: 3, kind: 'stand', lat: 44.146, lng: -90.650 }, // ~2.9 km from the first
  ];
  assert.equal(groundsFrom(chain).length, 1);
  // And the same three with the middle link removed split in two.
  assert.equal(groundsFrom([chain[0], chain[2]]).length, 2);
});

test('a single pin alone founds a ground', () => {
  // The moment the first stand lands on the far property, the switcher has
  // something to offer — nobody has to place two things before it exists.
  const g = groundsFrom([...HOME, { id: 9, kind: 'stand', lat: 44.250, lng: -90.450 }]);
  assert.equal(g.length, 2);
  assert.equal(g[1].size, 1);
  assert.ok(Number.isFinite(g[1].centre.lat));
});

test('the label is the majority property name, never a guess', () => {
  const named = groundsFrom([
    { ...HOME[0], property: 'Home 40' },
    { ...HOME[1], property: 'Home 40' },
    { ...HOME[2], property: 'Typo Farm' },
  ]);
  assert.equal(named[0].name, 'Home 40', 'one stray assignment does not relabel the ground');
  assert.equal(groundsFrom(HOME)[0].name, null, 'no names, no label — the counts speak instead');
});

test('a point with no coordinates is skipped, never guessed into a ground', () => {
  const g = groundsFrom([...HOME, { id: 'x', kind: 'camera', lat: null, lng: null }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].size, 3);
});

test('an unnamed ground is described by what is on it', () => {
  const [home] = groundsFrom(HOME);
  assert.equal(describeGround(home), '1 camera, 2 stands');
  assert.equal(describeGround({ counts: {} }), 'nothing placed');
});

test('the browser copy is the same arithmetic, not a retelling', () => {
  // The repo rule: formulas the map needs are emitted from the very functions
  // Node runs. Compile the emitted copy and compare it on the same input.
  const ctx = vm.createContext({});
  vm.runInContext(browserSource('GROUNDS') + '\nGROUNDS;', ctx);
  const emitted = vm.runInContext('GROUNDS', ctx);
  assert.equal(emitted.GROUND_GAP_M, GROUND_GAP_M);
  const input = [...HOME, ...FAR].map(p => ({ ...p }));
  // JSON round-trip: objects born in the vm have another realm's prototypes,
  // which strict deepEqual counts as a difference. The VALUES are the test.
  assert.deepEqual(JSON.parse(JSON.stringify(emitted.groundsFrom(input))),
    JSON.parse(JSON.stringify(groundsFrom(input))));
  assert.equal(emitted.describeGround(groundsFrom(input)[0]), '1 camera, 2 stands');
});

// ---------------------------------------------------------------------------
// Naming a ground over HTTP
// ---------------------------------------------------------------------------

const norm = c => PROVIDERS.spypoint.normalizeCamera(c);

async function serving(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-grounds-'));
  const db = openDb(out);
  upsertCamera(db, norm(FLEX_M), { provider: 'spypoint' });
  const s1 = createStand(db, { name: 'Oak', type: 'stand', lat: 44.125, lng: -90.655 });
  const s2 = createStand(db, { name: 'Creek', type: 'stand', lat: 44.128, lng: -90.648 });
  const far = createStand(db, { name: 'Far ridge', type: 'stand', lat: 44.250, lng: -90.450 });
  const m1 = createMarker(db, { kind: 'rub', lat: 44.126, lng: -90.652 });
  db.close();

  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return {
    out, s1, s2, far, m1,
    json: (method, p, body) => fetch(base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

test('naming a ground creates the property and assigns exactly what was named', async t => {
  const { out, s1, s2, far, m1, json } = await serving(t);
  // The stored camera id is provider-prefixed — the same id the page holds.
  const res = await json('POST', '/api/properties', {
    name: 'Home 40',
    cameraIds: ['spypoint:aaaaaaaaaaaaaaaaaaaaaaaa'],
    standIds: [s1.id, s2.id],
    markerIds: [m1.id],
  });
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.equal(made.name, 'Home 40');
  assert.equal(made.assigned, 4, 'camera, two stands, one marker');

  const db = openDb(out);
  const props = allProperties(db);
  assert.equal(props.length, 1);
  assert.equal(props[0].cameras, 1);
  assert.equal(props[0].stands, 2);
  assert.equal(props[0].markers, 1);
  const farRow = db.prepare('SELECT property_id FROM stands WHERE id = ?').get(far.id);
  assert.equal(farRow.property_id, null, 'the other ground is not swept in');
  assert.equal(allMarkers(db)[0].property_name, 'Home 40',
    'markers carry the name back to the page, like cameras and stands');
  db.close();
});

test('a property needs a name, and naming again is not a duplicate', async t => {
  const { s1, far, json } = await serving(t);
  assert.equal((await json('POST', '/api/properties', { name: '  ' })).status, 400);

  await json('POST', '/api/properties', { name: 'Home 40', standIds: [s1.id] });
  const again = await json('POST', '/api/properties', { name: 'Home 40', standIds: [far.id] });
  assert.equal(again.status, 201);
  const list = await (await json('GET', '/api/properties')).json();
  assert.equal(list.length, 1, 'same name, same property');
  assert.equal(list[0].stands, 2, 'the second naming added its members to it');
});

// ---------------------------------------------------------------------------
// The page carries the switcher
// ---------------------------------------------------------------------------

test('the served page carries the switcher, and the script drives it', async t => {
  const { json } = await serving(t);
  const html = await (await json('GET', '/')).text();
  assert.match(html, /id="groundSel"/, 'the dropdown sits in the top bar');

  assert.match(mapScript, /GROUNDS\.groundsFrom/, 'the map clusters with the shared arithmetic');
  assert.match(mapScript, /trailcam\.ground/, 'the chosen ground is remembered');
  assert.match(mapScript, /GROUND_LIST\.length < 2\) \{ groundSel\.hidden = true/,
    'one ground is not a choice — the control hides');
  assert.match(mapScript, /D\.live && current >= 0 && !GROUND_LIST\[current\]\.name/,
    'naming is offered only where saving is possible and only for unnamed ground');

  // The phone placement. position: fixed inside the top bar pins to the BAR,
  // not the screen — its backdrop-filter makes it the containing block — so
  // at phone width the script moves the select to body. Losing this line
  // makes the chip vanish off the bar's top edge, visibly nowhere, on phones
  // only.
  assert.match(mapScript, /phoneQ\.matches\) document\.body\.appendChild\(groundSel\)/,
    'the select leaves the filtered bar before fixed positioning applies');
  assert.match(html, /max-width: 560px[\s\S]{0,200}#groundSel/,
    'and the phone styling that needs it is present');
});

// ---- which ground a request is about --------------------------------------
// Anything that reasons about YOUR stands has to know which property is meant.
// Handed every pin from both places at once, the stand suggester decided whose
// ground one property was by majority vote across the other one's deeds.

test('a point over a property is on that property, not the biggest one', () => {
  const g = groundsFrom([...HOME, ...FAR]);
  assert.equal(groundAt(g, 44.251, -90.449).ids.stand[0], 3, 'the far cluster, though it is smaller');
  assert.ok(groundAt(g, 44.124, -90.652).ids.stand.includes(1), 'and the home cluster from over it');
});

test('open country between two properties belongs to neither', () => {
  // Halfway is a defensible "I do not know", and the caller falls back to
  // every stand rather than being told a wrong one confidently.
  const g = groundsFrom([...HOME, ...FAR]);
  assert.equal(groundAt(g, 44.19, -90.55), null);
});

test('a corner of a long property still counts as being on it', () => {
  // A skinny eighty's centre can be several hundred metres from the corner you
  // are standing in, so inside the bounds settles it before distance does.
  const strip = [
    { id: 1, kind: 'stand', lat: 44.120, lng: -90.660, property: null },
    { id: 2, kind: 'stand', lat: 44.120, lng: -90.640, property: null },
  ];
  const g = groundsFrom(strip);
  assert.ok(groundAt(g, 44.120, -90.6405), 'the far corner is still the same ground');
});

test('nothing placed anywhere is null, not a guess', () => {
  assert.equal(groundAt([], 44.12, -90.65), null);
  assert.equal(groundAt(groundsFrom(HOME), NaN, -90.65), null);
});
