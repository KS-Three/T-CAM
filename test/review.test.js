import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDb, upsertCamera, upsertPhoto, upsertBuck, addDetection, groupVisits, allVisits,
  visitById, photosForVisit, reviewVisit, detectionsForVisit, updateDetection,
  deleteDetection, allBucks, recentDetectionCounts, VISIT_GAP_SECONDS,
  SPECIES, VENDOR_SPECIES, speciesFromVendorWord,
} from '../db.mjs';
import { reviewHtml } from '../review-page.mjs';
import { createServer } from '../serve.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-review-'));

function seeded({ pattern = null } = {}) {
  const db = openDb(tmp());
  upsertCamera(db, { ...PROVIDERS.spypoint.normalizeCamera(FLEX_M), id: 'cam1', name: 'Oak Ridge' },
    { provider: 'spypoint' });
  const base = new Date('2026-11-09T06:30:00Z').getTime();
  // Two frames per trigger, three triggers as one deer works through, then a
  // separate appearance hours later — the real firing pattern.
  const offsets = pattern ?? [0, 3, 45, 48, 120, 123, 4 * 3600, 4 * 3600 + 3];
  offsets.forEach((off, i) => upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'cam1', nativeId: 'p' + i,
    takenAt: new Date(base + off * 1000).toISOString(), url: 'http://x/' + i,
  }));
  return db;
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

test('a burst of frames becomes ONE visit to tag, not six', () => {
  // The whole reason visits exist. These cameras fire two frames per trigger
  // and a deer sets off several triggers; tagging per photo would mean
  // labelling the same animal six times, which is how someone stops using it.
  const db = seeded();
  const result = groupVisits(db);
  assert.equal(result.visits, 2, 'one working-through, plus a separate appearance');
  const visits = allVisits(db);
  const big = visits.find(v => v.photo_count === 6);
  assert.ok(big, 'the six frames of one deer are a single visit');
  assert.equal(big.spanSeconds, 123);
  db.close();
});

test('a gap longer than the visit window starts a new visit', () => {
  const db = seeded({ pattern: [0, 3, VISIT_GAP_SECONDS + 60] });
  assert.equal(groupVisits(db).visits, 2);
  db.close();
});

test('a photo with no timestamp is left ungrouped rather than guessed', () => {
  // It cannot be known to belong with its neighbours, and quietly attaching it
  // would put an animal at a time it may not have been there.
  const db = seeded();
  upsertPhoto(db, { provider: 'spypoint', cameraId: 'cam1', nativeId: 'undated',
    takenAt: null, url: 'http://x/u' });
  const r = groupVisits(db);
  assert.equal(r.ungrouped, 1);
  const stray = db.prepare("SELECT visit_id FROM photos WHERE native_id = 'undated'").get();
  assert.equal(stray.visit_id, null);
  db.close();
});

test('regrouping is idempotent, because a sync fills gaps later', () => {
  // Downloads fail and get retried on the next run, so photos routinely arrive
  // BETWEEN ones already grouped. Grouping has to be recomputable.
  const db = seeded();
  const first = groupVisits(db);
  const again = groupVisits(db);
  assert.deepEqual(again, first);
  assert.equal(allVisits(db).length, first.visits);
  db.close();
});

test('reviewed and empty is a different fact from never looked at', () => {
  // The distinction the analysis depends on. Without it, every unreviewed frame
  // reads as evidence of no deer.
  const db = seeded();
  groupVisits(db);
  const [v] = allVisits(db);
  assert.equal(v.reviewed, false);
  assert.equal(allVisits(db, { unreviewed: true }).length, 2);

  reviewVisit(db, v.id);
  assert.equal(visitById(db, v.id).reviewed, true);
  assert.equal(allVisits(db, { unreviewed: true }).length, 1,
    'a reviewed visit leaves the queue even with nothing tagged on it');
  assert.equal(detectionsForVisit(db, v.id).length, 0, 'and it genuinely holds nothing');

  reviewVisit(db, v.id, { reviewed: false });
  assert.equal(allVisits(db, { unreviewed: true }).length, 2, 'and it can be put back');
  db.close();
});

test('a visit carries its camera name however it was fetched', () => {
  // The review screen refetches a single visit after every tag. A bare visit
  // row has no camera name, so the heading silently emptied itself the moment
  // you tagged anything.
  const db = seeded();
  groupVisits(db);
  const [listed] = allVisits(db);
  const fetched = visitById(db, listed.id);
  assert.equal(fetched.camera_name, 'Oak Ridge');
  assert.equal(fetched.camera_name, listed.camera_name, 'one shape for a visit');
  db.close();
});

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

function tagged() {
  const db = seeded();
  groupVisits(db);
  const [v] = allVisits(db);
  const photo = photosForVisit(db, v.id)[0];
  return { db, visit: v, photo };
}

test('a detection can be edited and removed', () => {
  const { db, visit, photo } = tagged();
  const d = addDetection(db, { photoId: photo.id, species: 'deer', source: 'manual', confirmed: true });
  assert.equal(detectionsForVisit(db, visit.id).length, 1);
  const up = updateDetection(db, d.id, { count: 3 });
  assert.equal(up.count, 3);
  assert.ok(deleteDetection(db, d.id));
  assert.equal(detectionsForVisit(db, visit.id).length, 0);
  db.close();
});

test('a detection counts at least one animal, and species must be real', () => {
  const { db, photo } = tagged();
  const d = addDetection(db, { photoId: photo.id, species: 'deer', source: 'manual' });
  assert.throws(() => updateDetection(db, d.id, { count: 0 }), /at least one animal/);
  assert.throws(() => updateDetection(db, d.id, { species: 'dragon' }), /unknown species/);
  assert.equal(updateDetection(db, d.id, {}).count, 1, 'and the stored row is untouched');
  db.close();
});

test('a named buck must be a deer', () => {
  // Otherwise "how many deer" and "how many times I saw this buck" answer
  // differently, which makes both numbers useless.
  const { db, photo } = tagged();
  const buck = upsertBuck(db, 'Split G2');
  const d = addDetection(db, { photoId: photo.id, species: 'deer', source: 'manual' });
  assert.doesNotThrow(() => updateDetection(db, d.id, { buckId: buck.id }));
  assert.throws(() => updateDetection(db, d.id, { species: 'turkey' }),
    /assigned to a named buck must be a deer/);
  db.close();
});

test('bucks carry how often they have been seen', () => {
  const { db, photo } = tagged();
  const buck = upsertBuck(db, 'Split G2');
  const d = addDetection(db, { photoId: photo.id, species: 'deer', source: 'manual' });
  updateDetection(db, d.id, { buckId: buck.id });
  const [b] = allBucks(db);
  assert.equal(b.name, 'Split G2');
  assert.equal(b.sightings, 1);
  db.close();
});

test("the vendor's vocabulary maps only where it cannot be wrong", () => {
  assert.equal(speciesFromVendorWord('buck'), 'deer', 'a buck is a deer; antlered is a judgement');
  assert.equal(speciesFromVendorWord(' Doe '), 'deer', "case and whitespace are the vendor's business");
  assert.equal(speciesFromVendorWord('turkey'), 'turkey');
  assert.equal(speciesFromVendorWord('vehicle'), null, 'an undocumented word maps to nothing');
  assert.equal(speciesFromVendorWord(''), null);
  assert.equal(speciesFromVendorWord(null), null);
  for (const s of Object.values(VENDOR_SPECIES)) {
    assert.ok(SPECIES.includes(s), `every mapping lands on the species list: ${s}`);
  }
});

test('only CONFIRMED detections count toward camera activity', () => {
  // An unreviewed machine guess is not evidence, and the stand ranking must not
  // treat it as such.
  const { db, photo } = tagged();
  addDetection(db, { photoId: photo.id, species: 'deer', source: 'camera-ai', confirmed: false });
  const now = new Date('2026-11-09T12:00:00Z');
  assert.deepEqual(recentDetectionCounts(db, { now }), {},
    'a machine guess nobody has checked counts for nothing');

  addDetection(db, { photoId: photo.id, species: 'deer', count: 2, source: 'manual', confirmed: true });
  const counts = recentDetectionCounts(db, { now });
  assert.equal(counts['spypoint:cam1'], 2, 'a confirmed sighting counts');
  db.close();
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

async function serving(t, { claims = [] } = {}) {
  const out = tmp();
  const db = openDb(out);
  upsertCamera(db, { ...PROVIDERS.spypoint.normalizeCamera(FLEX_M), id: 'cam1', name: 'Oak Ridge' },
    { provider: 'spypoint' });
  const base = new Date('2026-11-09T06:30:00Z').getTime();
  [0, 3, 45, 4 * 3600].forEach((off, i) => upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'cam1', nativeId: 'p' + i,
    takenAt: new Date(base + off * 1000).toISOString(), url: 'http://x/' + i,
  }));
  groupVisits(db);
  // The camera's own AI tags, the way the sync records them.
  for (const c of claims) {
    addDetection(db, { photoId: c.photo, species: c.word, source: 'camera-ai' });
  }
  db.close();

  const server = createServer({ out });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base_ = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => server.close(r)));
  return {
    json: (method, p, body) => fetch(base_ + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

test('the queue serves visits with their photos and remaining count', async t => {
  const { json } = await serving(t);
  const data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  assert.equal(data.remaining, 2);
  assert.ok(data.visits[0].photos.length > 0);
  assert.ok(data.species.includes('deer'));
  // Photos are addressed by URL, not by a filesystem path the browser cannot read.
  const p = data.visits.flatMap(v => v.photos)[0];
  assert.ok(p.file === null || p.file.startsWith('/photos/'));
});

test('tagging and reviewing a visit over HTTP', async t => {
  const { json } = await serving(t);
  const data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  const visit = data.visits.find(v => v.photos.length > 1) ?? data.visits[0];

  const made = await json('POST', '/api/detections',
    { photoId: visit.photos[0].id, species: 'deer', count: 2 });
  assert.equal(made.status, 201);
  const det = await made.json();
  assert.equal(det.confirmed, 1, 'a person tagged it, so it is confirmed');

  const one = await (await json('GET', `/api/visits/${visit.id}`)).json();
  assert.equal(one.detections.length, 1);
  assert.equal(one.camera_name, 'Oak Ridge');

  const done = await json('POST', `/api/visits/${visit.id}/review`, {});
  assert.equal(done.status, 200);
  const after = await (await json('GET', '/api/visits?unreviewed=1')).json();
  assert.equal(after.remaining, 1);
});

test("the camera's claim arrives as a suggestion, not a tag", async t => {
  const { json } = await serving(t, { claims: [
    { photo: 'spypoint:p0', word: 'buck' },
    { photo: 'spypoint:p1', word: 'deer' },
    { photo: 'spypoint:p0', word: 'lynx' },
  ] });
  const data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  const visit = data.visits.find(v => v.detections.length);
  const bySpecies = Object.fromEntries(visit.detections.map(d => [d.species, d]));
  assert.equal(bySpecies.buck.suggestion, 'deer', "the vendor's word maps onto the species list");
  assert.equal(bySpecies.deer.suggestion, 'deer');
  assert.equal(bySpecies.lynx.suggestion, null, 'an undocumented word is not guessed at');
  assert.ok(visit.detections.every(d => d.source === 'camera-ai' && d.confirmed === 0),
    'all of it still an unconfirmed machine claim');

  // Agreeing writes a person's tag; the tag carries no suggestion field,
  // because it is not one.
  await json('POST', '/api/detections', { photoId: 'spypoint:p0', species: 'deer' });
  const one = await (await json('GET', '/api/visits/' + visit.id)).json();
  assert.equal(one.detections.find(d => d.species === 'buck').suggestion, 'deer',
    'the single-visit fetch maps the same way as the list');
  const manual = one.detections.find(d => d.source === 'manual');
  assert.ok(manual && !('suggestion' in manual), "a person's tag is not a suggestion");
});

test('a rejected tag leaves nothing behind', async t => {
  const { json } = await serving(t);
  const res = await json('POST', '/api/detections',
    { photoId: 'spypoint:p0', species: 'dragon' });
  assert.equal(res.status, 400);
  const data = await (await json('GET', '/api/visits?unreviewed=1')).json();
  assert.ok(data.visits.every(v => v.detections.length === 0),
    'the 400 did not quietly insert the invalid row first — it used to');
});

test('a bad tag is the caller\'s mistake, not a server fault', async t => {
  const { json } = await serving(t);
  assert.equal((await json('POST', '/api/detections', { species: 'deer' })).status, 400);
  assert.equal((await json('POST', '/api/detections',
    { photoId: 'nope', species: 'deer' })).status, 400);
  assert.equal((await json('PATCH', '/api/detections/999', { count: 2 })).status, 404);
  assert.equal((await json('DELETE', '/api/detections/999')).status, 404);
  assert.equal((await json('POST', '/api/visits/999/review', {})).status, 404);
  assert.equal((await json('POST', '/api/bucks', { name: '  ' })).status, 400);
});

test('regrouping can be triggered over HTTP', async t => {
  const { json } = await serving(t);
  const r = await (await json('POST', '/api/regroup', { gapSeconds: 10 })).json();
  assert.ok(r.visits >= 3, 'a tighter gap splits the burst into more visits');
});

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

test('the review page script parses', () => {
  // Same rule as the dashboard: the page is built from a template literal, so
  // an escape resolved at BUILD time can make the whole script a syntax error
  // while the module itself still passes node --check.
  const html = reviewHtml({ species: ['deer'], bucks: [{ id: 1, name: 'Split G2', sightings: 3 }], remaining: 4 });
  const blocks = [...html.matchAll(
    /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(blocks.length, 1);
  assert.doesNotThrow(() => new vm.Script(blocks[0]));
});

test('a buck named with a script tag cannot break out of the page', () => {
  const html = reviewHtml({ bucks: [{ id: 1, name: '</script><img src=x onerror=alert(1)>' }] });
  assert.ok(!html.includes('<img src=x onerror'), 'the tag is escaped, not emitted');
  const blocks = [...html.matchAll(
    /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.doesNotThrow(() => new vm.Script(blocks[0]));
});

test('machine claims render apart from tags, with one key to agree', () => {
  // The decision this pins arrived with the first real photos: SpyPoint's own
  // AI tag rendered exactly like a human tag, so a visit looked already
  // tagged, Enter felt natural, and the guess stayed unconfirmed — invisible
  // to the ranking. The page must keep the two apart and offer agreement.
  const html = reviewHtml({});
  const [script] = [...html.matchAll(
    /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.match(script, /source !== 'camera-ai'/,
    "the person's tag list excludes the camera's claims");
  assert.match(script, /The camera thinks/, 'the claims speak under their own heading');
  assert.match(script, /'y'\)[\s\S]{0,60}agreeAll/, 'Y agrees');
  assert.match(script, /not a species this tool tracks/,
    'a word the table does not know is shown verbatim, never guessed at');
  assert.match(script, /d\.species === 'deer' && d\.source !== 'camera-ai'/,
    "a buck's name attaches to a person's tag, never to a machine claim");
});

test('the review page is served', async t => {
  const { json } = await serving(t);
  const res = await json('GET', '/review');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Review photos/);
  assert.match(html, /Nothing here/, 'the empty-answer control is on the page');
});
