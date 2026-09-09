/**
 * The buck matcher, driven end to end against a stand-in for the API.
 *
 * Every test here is really one assertion in different clothes: a proposal is
 * never a fact. The module returns; it does not write. Anything it cannot read
 * becomes "no suggestion" rather than a guess, because the caller's response to
 * every failure is the same and boring — tag it by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, upsertCamera, upsertPhoto, upsertBuck, addDetection } from '../db.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'test-key-not-a-real-one';
// A 1x1 JPEG. The bytes never matter to these tests — the stand-in answers
// from a script — but they have to be real base64 for the shape to be honest.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof'
  + 'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAA'
  + 'AAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const img = () => ({ mediaType: 'image/jpeg', base64: JPEG_B64 });
const REFS = [
  { buckId: 1, name: 'Split G2', images: [img()] },
  { buckId: 2, name: 'Kicker', images: [img(), img()] },
];

/** A stand-in API that replies with whatever the test scripts. */
async function standIn(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      const out = reply(seen.length);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, seen, base };
}

/** The documented success shape: a tool_use block carrying the answer. */
const answered = input => ({
  status: 200,
  json: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_match', input }],
    usage: { input_tokens: 4200, output_tokens: 90 },
  },
});

async function ask(base, over = {}) {
  const { matchBuck } = await import('../buck-match.mjs');
  // Passed explicitly rather than through the environment: the module reads
  // the env var per call, but an argument is what the test is actually about.
  return matchBuck({ candidate: img(), references: REFS, apiKey: KEY, baseUrl: base, ...over });
}

// --- the request that goes out ---------------------------------------------

test('the request carries labelled images, the tool, and the documented headers', async t => {
  const { buildRequest, MATCH_TOOL } = await import('../buck-match.mjs');
  const body = buildRequest({ candidate: img(), references: REFS });

  assert.equal(body.model, 'claude-opus-5');
  assert.deepEqual(body.tools, [MATCH_TOOL]);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'report_match' });

  const blocks = body.messages[0].content;
  const images = blocks.filter(b => b.type === 'image');
  assert.equal(images.length, 4, 'one reference, two references, and the candidate');
  for (const i of images) {
    assert.equal(i.source.type, 'base64');
    assert.equal(i.source.media_type, 'image/jpeg');
    assert.ok(i.source.data.length > 0);
  }
  // Every image is introduced by its own label, and the question comes last.
  const texts = blocks.filter(b => b.type === 'text').map(b => b.text);
  assert.ok(texts.some(t => t.includes('"Split G2"')));
  assert.ok(texts.some(t => t.includes('(1 of 2)')), 'multiple references are numbered');
  assert.ok(texts.at(-1).includes('report_match'));
  assert.equal(blocks.at(-1).type, 'text', 'the question is last, images before it');
});

test('the documented headers are sent', async t => {
  const { server, seen, base } = await standIn(() => answered(
    { buck: 'none', confidence: 10, why: 'too dark' }));
  t.after(() => server.close());
  await ask(base);
  const h = seen[0].headers;
  assert.equal(h['x-api-key'], KEY);
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.match(h['content-type'], /application\/json/);
  assert.equal(seen[0].url, '/v1/messages');
});

// --- reading the answer -----------------------------------------------------

test('a named match becomes a proposal with the buck id resolved', async t => {
  const { server, base } = await standIn(() => answered(
    { buck: 'Split G2', confidence: 78, why: 'split brow tine on the right beam' }));
  t.after(() => server.close());
  const p = await ask(base);
  assert.equal(p.answered, true);
  assert.equal(p.buckId, 1);
  assert.equal(p.name, 'Split G2');
  assert.equal(p.confidence, 78);
  assert.match(p.why, /brow tine/);
  assert.equal(p.usage.input_tokens, 4200);
});

test('"none" is an answer, not a failure', async t => {
  const { server, base } = await standIn(() => answered(
    { buck: 'none', confidence: 84, why: 'a doe' }));
  t.after(() => server.close());
  const p = await ask(base);
  assert.equal(p.answered, true, 'it answered');
  assert.equal(p.buckId, null, 'and the answer was none of them');
  assert.equal(p.confidence, 84);
});

test('a name that matches no buck is DROPPED, never fuzzy-matched', async t => {
  // A near-miss on a name is exactly how one buck's sightings end up filed
  // under another.
  const { server, base } = await standIn(() => answered(
    { buck: 'Split G3', confidence: 91, why: 'confident and wrong' }));
  t.after(() => server.close());
  const p = await ask(base);
  assert.equal(p.answered, false);
  assert.equal(p.buckId, null);
  assert.match(p.why, /not one of the bucks offered/);
});

test('a missing or unreadable confidence refuses the whole proposal', async t => {
  const { readProposal } = await import('../buck-match.mjs');
  for (const bad of [{ buck: 'Split G2', why: 'x' },
    { buck: 'Split G2', confidence: null, why: 'x' },
    { buck: 'Split G2', confidence: 'very', why: 'x' }]) {
    const p = readProposal(bad, REFS);
    assert.equal(p.answered, false, JSON.stringify(bad));
    assert.equal(p.buckId, null);
  }
  // Number('') and Number(null) are both 0, and a 0 meaning "it said nothing"
  // must not read as "certainly not".
  assert.equal(readProposal({ buck: 'none', confidence: '', why: 'x' }, REFS).answered, false);
  // A real zero, however, is a real answer.
  assert.equal(readProposal({ buck: 'none', confidence: 0, why: 'x' }, REFS).answered, true);
});

test('confidence is clamped to 0-100 rather than trusted', async t => {
  const { readProposal } = await import('../buck-match.mjs');
  assert.equal(readProposal({ buck: 'Kicker', confidence: 140, why: 'x' }, REFS).confidence, 100);
  assert.equal(readProposal({ buck: 'Kicker', confidence: -5, why: 'x' }, REFS).confidence, 0);
});

// --- every failure looks the same, and is safe ------------------------------

test('a refusal, an error, a hiccup and a wrong shape all mean "no suggestion"', async t => {
  const cases = [
    ['refusal', { status: 200, json: { stop_reason: 'refusal', stop_details: { category: 'x' }, content: [] } }],
    ['a 500', { status: 500, json: { error: 'boom' } }],
    ['a 401', { status: 401, json: { error: 'bad key' } }],
    ['no tool block', { status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I think it is Split G2' }] } }],
  ];
  for (const [label, out] of cases) {
    const { server, base } = await standIn(() => out);
    const p = await ask(base);
    server.close();
    assert.equal(p.answered, false, label);
    assert.equal(p.buckId, null, label);
    assert.ok(p.why, `${label} keeps a reason`);
  }
});

test('an unreachable service does not throw', async t => {
  // The caller's response to a network failure is the same as to everything
  // else: tag it by hand. Throwing would make a sync fall over for it.
  const p = await ask('http://127.0.0.1:1');
  assert.equal(p.answered, false);
  assert.match(p.why, /could not reach/);
});

test('a missing key stops, because that is a mistake worth noticing', async t => {
  const { matchBuck } = await import('../buck-match.mjs');
  await assert.rejects(
    () => matchBuck({ candidate: img(), references: REFS, apiKey: '' }),
    /ANTHROPIC_API_KEY/);
  await assert.rejects(
    () => matchBuck({ candidate: img(), references: [], apiKey: KEY }),
    /name at least one buck/);
});

// --- the line a person reads ------------------------------------------------

test('the wording never states an identity as fact', async t => {
  const { proposalLine } = await import('../buck-match.mjs');
  const line = proposalLine({ answered: true, buckId: 1, name: 'Split G2', confidence: 78 });
  assert.match(line, /Thinks this is Split G2/);
  assert.match(line, /78%/);
  assert.match(line, /Your call/);
  // It must never read as a bare identification.
  assert.notEqual(line.trim(), 'Split G2');
  assert.match(proposalLine({ answered: false, why: 'declined' }), /No suggestion/);
});

// --- what may be stored -----------------------------------------------------

test('a proposal may only be stored as an UNCONFIRMED assist claim', async t => {
  // migration 19's whole purpose. An assist row is a third provenance, apart
  // from the vendor's guess and the person's tag, and it must not count as
  // evidence until somebody agrees with it.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-assist-'));
  const db = openDb(out);
  upsertCamera(db, PROVIDERS.spypoint.normalizeCamera(FLEX_M),
    { provider: 'spypoint', accountLabel: 'k' });
  const photo = upsertPhoto(db, {
    provider: 'spypoint', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa', nativeId: 'p1',
    takenAt: '2026-09-08T01:00:00.000Z',
  });
  const buck = upsertBuck(db, 'Split G2');

  const row = addDetection(db, {
    photoId: photo.id, species: 'deer', buckId: buck.id,
    source: 'assist', confirmed: false, notes: 'assistant: 78% — split brow tine',
  });
  assert.equal(row.source, 'assist');
  assert.equal(row.confirmed, 0, 'unconfirmed, so nothing downstream counts it');

  // The three sources coexist and stay distinguishable — the point of keeping
  // provenance rather than folding assist into camera-ai.
  addDetection(db, { photoId: photo.id, species: 'deer', source: 'camera-ai', confirmed: false });
  addDetection(db, { photoId: photo.id, species: 'deer', source: 'manual', confirmed: true });
  const sources = db.prepare('SELECT source, confirmed FROM detections ORDER BY source').all();
  assert.deepEqual(sources.map(s => s.source), ['assist', 'camera-ai', 'manual']);

  // And an invented provenance is still refused by the constraint.
  assert.throws(() => addDetection(db, {
    photoId: photo.id, species: 'deer', source: 'guess', confirmed: true,
  }), /CHECK|constraint/i);
  db.close();
});

test('nothing in this module writes to a database', async t => {
  // Enforced by construction: it never imports db.mjs. If that ever changes,
  // this is the test that should stop it.
  const src = fs.readFileSync(new URL('../buck-match.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/db\.mjs'/, 'the matcher must not reach the store');
  assert.doesNotMatch(src, /INSERT|UPDATE\s+cameras|addDetection/,
    'and must not carry SQL of its own');
});

// --- costing it before spending it ------------------------------------------

test('visual tokens follow the published 28-pixel patch rule', async t => {
  const { visualTokens } = await import('../buck-match.mjs');
  // The documented worked examples.
  assert.equal(visualTokens(200, 200), 64);
  assert.equal(visualTokens(1000, 1000), 1296);
  assert.equal(visualTokens(1092, 1092), 1521);
});
