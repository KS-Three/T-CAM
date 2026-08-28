import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardHtml } from '../dashboard-page.mjs';
import { reviewHtml } from '../review-page.mjs';
import { tonightHtml } from '../tonight-page.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { FLEX_M } from '../fixtures/cameras.js';

/** The page's own script, as the browser would receive it. */
function inlineScript(html) {
  const blocks = [...html.matchAll(
    /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(blocks.length, 1, 'exactly one app script');
  return blocks[0];
}

test('the generated dashboard script actually parses', () => {
  // This is not a formality. The whole page script is emitted from a template
  // literal, so an escape written with one backslash is resolved WHEN THE PAGE
  // IS BUILT rather than when the browser reads it: a single-escaped newline
  // becomes a real line break, lands inside a quoted string, and turns the
  // entire dashboard into a syntax error. Nothing catches that upstream —
  // `node --check` on the module passes, because the module is fine. The page
  // it produces is not.
  //
  // It has to be compiled, not pattern-matched: the failure is a parse error,
  // so only a parser finds it.
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];
  const html = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z', null, [], true, []);
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)),
    'the page script must compile');
});

test('it parses with every kind of content filled in', () => {
  // Escapes hide in the branches that only run when there is data, so the
  // fixture carries a stand, a marker and a plan rather than empty arrays.
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];
  const stands = [{ id: 1, name: "O'Brien's ridge \"north\"", type: 'tripod',
    lat: 44.1, lng: -90.6, winds: ['NW'], nearbyCameras: [{ name: 'Creek', metres: 90 }] }];
  const markers = [{ id: 1, kind: 'rub', label: 'Rub', name: 'Fence-line \\ rub',
    lat: 44.1, lng: -90.6, found_at: '2026-08-01', notes: 'two trees, line runs north',
    daysOld: 26 }];
  const plan = { generatedAt: '2026-08-27T12:00:00.000Z', sits: [{
    date: '2026-11-09', window: 'AM', rating: 'PRIME', total: 52, windDir: 315,
    windFrom: 'NW', rut: 'Chasing', moon: 'waxing gibbous', parts: [{ points: 22, why: 'rut' }],
  }] };
  const html = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z', plan, stands, true, markers);
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
});

test('the static page parses too', () => {
  // The file written by the sync takes different branches from the served page.
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];
  const html = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z');
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
});

test('embedded data cannot break out of its JSON block', () => {
  // A camera or stand named with a closing script tag would otherwise end the
  // block early and inject markup.
  const nasty = { ...PROVIDERS.spypoint.normalizeCamera(FLEX_M),
    name: '</script><img src=x onerror=alert(1)>' };
  const html = dashboardHtml([nasty], [], '2026-08-27T12:00:00.000Z', null, [], true, []);
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
  assert.ok(!html.includes('<img src=x onerror'), 'the tag is escaped, not emitted');
});

// Every page this program serves goes through the same template-literal
// hazard, so every page is compiled here rather than only the one that has
// been bitten. A new page added without a line in this file is a page that can
// ship broken.
test('the review page script parses', () => {
  const html = reviewHtml({
    species: ['deer', 'turkey'],
    bucks: [{ id: 1, name: "Kicker \\ 'the' one" }],
    remaining: 12,
  });
  assert.doesNotThrow(() => new vm.Script(inlineScript(html)));
});

test('the tonight page script parses', () => {
  assert.doesNotThrow(() => new vm.Script(inlineScript(tonightHtml())));
});

test('the tonight page ships one script and no stray markup', () => {
  const html = tonightHtml();
  const script = inlineScript(html);
  assert.ok(script.includes('replaceChildren'), 'the browser half is actually emitted');
  // A backtick surviving into the emitted script would mean the String.raw
  // literal had closed early and the rest of the page followed it out.
  assert.ok(!script.includes('`'), 'no backtick escaped into the page');
  assert.doesNotThrow(() => new vm.Script(script));
});
