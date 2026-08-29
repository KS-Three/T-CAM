import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
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

test('the photo grid never draws a broken icon for an undownloaded photo', () => {
  // An <img> whose src is null renders as a broken icon wearing a real
  // caption — which is indistinguishable from a lost photo. Listed-but-not-
  // downloaded rows are counted in a line instead, the same rule the camera
  // cards use.
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];
  const html = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z');
  const script = inlineScript(html);
  const grid = script.slice(script.indexOf("document.getElementById('photoArea')"));
  const body = grid.slice(0, grid.indexOf('listedOnly)') + 400);
  assert.match(body, /const onDisk = D\.photos\.filter\(p => p\.file\)/,
    'only photos on disk get a picture');
  assert.match(body, /for \(const p of onDisk\.slice/,
    'and the grid iterates that filtered list, not D.photos');
  assert.match(body, /listed at SpyPoint but not downloaded yet/,
    'the rest are counted and explained, not drawn broken');
});

test('a camera card carries its own latest photos, from what the page already holds', () => {
  // Clicking a camera pin should answer "any deer here?" without a trip to
  // the drawer. The strip is filtered from D.photos — the page carries the
  // newest 200 already — rather than fetched, so the same card works on the
  // live page, the baked file, and offline.
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];
  const photo = { id: 1, date: '2026-08-21T07:15:00.000Z',
    file: '/photos/North_Ridge/2026-08/p1.jpg', url: 'https://vendor.example/p1',
    cameraName: 'North Ridge', cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa', tags: ['buck'] };
  const html = dashboardHtml(rows, [photo], '2026-08-27T12:00:00.000Z');
  const script = inlineScript(html);
  assert.doesNotThrow(() => new vm.Script(script), 'the strip branch still compiles');

  const fn = script.slice(script.indexOf('function cameraCard'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /D\.photos\.filter\(p => p\.cameraId === c\.id\)/,
    'each card shows its own camera\u2019s photos, nobody else\u2019s');
  assert.match(body, /listed\.filter\(p => p\.file\)/, 'downloaded photos only');
  // The strip must never draw from the vendor\u2019s own URL. The page contacts
  // no external host directly — the offline test pins that — and an <img>
  // pointing at one would break the strip exactly where it is wanted: in the
  // woods, where the vendor is unreachable and the file on disk is not.
  const strip = body.slice(body.indexOf("el('div', 'campics')"), body.indexOf('campics-note'));
  assert.ok(strip.length > 0, 'the strip is built');
  assert.doesNotMatch(strip, /p\.url/);
  // Listed and downloaded are different facts with different fixes, and the
  // empty states keep them apart rather than folding both into "no photos".
  assert.match(body, /listed but not downloaded/);
  assert.match(body, /No photos from this camera yet/);
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

test('the map is its own module, and the dashboard only composes it', async () => {
  // Split out 2026-08-28. The check is structural, like the whitelist and
  // mode-disarm tests: it asserts the map's code is not back in the dashboard,
  // which is the drift that would undo the split one convenient edit at a time.
  const { mapStyles, mapMarkup, mapScript } = await import('../map-view.mjs');
  const dash = await fs.readFile(new URL('../dashboard-page.mjs', import.meta.url), 'utf8');

  for (const marker of ['tileBounds3857', 'refreshMarkers', 'clearMapModes',
    'drawMarkers', 'lookupParcel', 'measurePaths', 'openStandForm']) {
    assert.ok(mapScript.includes(marker), `${marker} lives in the map module`);
    assert.ok(!dash.includes(marker), `${marker} is NOT still in the dashboard`);
  }

  // The dashboard composes the three pieces rather than owning them.
  for (const piece of ['${mapStyles}', '${mapMarkup}', '${mapScript}']) {
    assert.ok(dash.includes(piece), `the dashboard interpolates ${piece}`);
  }

  // String.raw keeps escapes literal, which is the point of moving it — but a
  // backtick still closes the literal, so there must be none in what is
  // WRITTEN. The evaluated string does contain backticks, arriving through the
  // measure geometry that is interpolated in, and those are harmless: an
  // interpolated value is inserted after the literal has been parsed.
  const source = await fs.readFile(new URL('../map-view.mjs', import.meta.url), 'utf8');
  const written = source.slice(source.indexOf('export const mapMarkup'));
  const literals = written.split('String.raw`').slice(1).map(part => part.split('\n`;')[0]);
  assert.equal(literals.length, 2, 'the markup and the script are both raw literals');
  for (const lit of literals) {
    assert.ok(!lit.includes('`'), 'no backtick written inside a raw literal');
  }

  // The zoom-out label is markup, not a JS string, so there is no parser to
  // resolve a \u escape for it. It must be an HTML entity or the character.
  assert.doesNotMatch(mapMarkup, /\\u[0-9a-fA-F]{4}/,
    'markup carries no unresolved escape');
  assert.match(mapStyles, /#map \{/, 'the map owns its own styles');
});

test('the split did not drop anything from the page', async () => {
  // Composed page vs. a snapshot taken before the split: identical line for
  // line once \uXXXX escapes are resolved, which is the only spelling that
  // changed when the map script moved into a String.raw literal.
  const rows = [PROVIDERS.spypoint.normalizeCamera(FLEX_M)];
  const html = dashboardHtml(rows, [], '2026-08-27T12:00:00.000Z', null, [], true, []);
  for (const id of ['tiles', 'terrain', 'contours', 'pins', 'zin', 'zout',
    'addStand', 'whoOwns', 'terrainBtn', 'markBtn', 'offlineBtn', 'routeBtn',
    'measureBtn', 'layerToggle', 'layerMenu', 'credit']) {
    assert.ok(html.includes('id="' + id + '"'), `#${id} survived the split`);
  }
  assert.ok(html.includes('&minus;'), 'the zoom-out label is an entity now');
  // Markup and styles only — stopping short of the JSON payload, whose < and &
  // are escaped as \\u003c and \\u0026 on purpose so no name can close the block.
  const markup = html.slice(0, html.indexOf('<script type="application/json"'));
  assert.doesNotMatch(markup, /\\u[0-9a-fA-F]{4}/,
    'no unresolved escape reached the markup, where nothing would resolve it');
});

test('the journal page script parses', async () => {
  const { journalHtml } = await import('../journal-page.mjs');
  assert.doesNotThrow(() => new vm.Script(inlineScript(journalHtml())));
});
