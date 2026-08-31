/**
 * Structural pins for the 2026-08-29 map UI work: zoom that cannot fly away,
 * the weather strip, crop fields, editable routes and the suggested walk in.
 *
 * These are the repo's usual after-the-fact pins — the behaviour itself was
 * driven in a real browser (see the PR) — asserting the DECISIONS in the
 * emitted script, so a convenient edit cannot quietly undo one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mapScript, mapMarkup, mapStyles } from '../map-view.mjs';
import { dashboardHtml } from '../dashboard-page.mjs';
import { CROP_KINDS } from '../db.mjs';

test('the wheel bank forgets between gestures, and the old handler is gone', () => {
  // Two sessions fixed the same "suddenly zoomed all the way out" bug and the
  // merge briefly kept BOTH handler sets — two `const setZoom`s, a page that
  // did not parse. main's own test (map-framing) pins the bank, the 100-px
  // step and the cursor anchor; what THIS branch adds on top is pinned here:
  // the bank's residue dies on a pause or a direction change, so a slow
  // clicky notch after a flick is exactly one step, never two.
  assert.match(mapScript,
    /if \(now - wheelAt > 250 \|\| Math\.sign\(e\.deltaY\) !== Math\.sign\(wheelBank\)\) wheelBank = 0;/,
    'the bank starts empty after a pause or a direction change');
  assert.doesNotMatch(mapScript, /setZoom\(zoom \+ \(e\.deltaY < 0 \? 1 : -1\)\)/,
    'the old level-per-event handler is gone');
  assert.equal((mapScript.match(/const setZoom = /g) || []).length, 1,
    'exactly one setZoom — the duplicated pair was a SyntaxError only compiling caught');
  assert.equal((mapScript.match(/addEventListener\('wheel'/g) || []).length, 2,
    'one wheel handler on the map, one in the 3D view — never two on the map');
});

test('zoom anchors on the pointer, and the buttons on the centre', () => {
  assert.match(mapScript, /function zoomAt\(z, atX, atY\)/,
    'one function knows how to zoom about a screen point');
  assert.match(mapScript, /const px = atX === undefined \? W \/ 2 : atX - rect\.left;/,
    'no point given means the centre — which is what the +/− buttons pass');
  assert.match(mapScript, /const setZoom = z => zoomAt\(z\);/,
    'the buttons stay centre-anchored');
});

test('a pinch hands the pan back to the finger that stays', () => {
  // main's test pins that the second finger ends the pan; this branch adds
  // the other half of that gesture: when the pinch ends with one finger
  // still down, that finger pans again from where it is NOW — without the
  // hand-off the map went dead under it until it was lifted too.
  assert.match(mapScript, /if \(touches\.size === 1 && !drag\) \{/,
    'the remaining finger is noticed');
  assert.match(mapScript, /drag = \{ x: p\.x, y: p\.y, x0: p\.x, y0: p\.y \};/,
    'and the pan restarts from its current position');
});

test('double-click zooms in, except while a placing mode is armed', () => {
  const dbl = mapScript.slice(mapScript.indexOf("addEventListener('dblclick'"));
  assert.ok(dbl.length > 100, 'the handler exists');
  assert.match(dbl.slice(0, 500), /zoomAt\(zoom \+ 1, e\.clientX, e\.clientY\)/,
    'one level in, anchored on the spot clicked');
  for (const mode of ['placing', 'marking', 'drawing', 'measuring', 'fielding', 'entryPick']) {
    assert.ok(dbl.slice(0, 400).includes(mode),
      `${mode} suppresses the double-click zoom — those clicks were placements`);
  }
});

test('the home button reframes on the ground, and exists in the markup', () => {
  assert.ok(mapMarkup.includes('id="zhome"'), 'the button is in the zoom stack');
  const home = mapScript.slice(mapScript.indexOf("getElementById('zhome')"));
  assert.match(home.slice(0, 400), /frameGround\(g\)/, 'a chosen ground frames itself');
  assert.match(home.slice(0, 400), /frameFor\(pts\)/, 'everything placed otherwise');
});

test('the weather strip reads its own server and scrubs the hours', () => {
  assert.ok(mapMarkup.includes('id="wxchip"') && mapMarkup.includes('id="wxbar"'));
  assert.match(mapScript, /fetch\('\/api\/forecast\?lat='/,
    'the forecast comes through the server — pages contact no external host');
  assert.match(mapScript, /Math\.round\(centre\.lat \* 100\) \/ 100/,
    'the URL is rounded so the offline cache can hit it');
  assert.match(mapScript, /slider\.oninput = \(\) => \{ wxIdx = Number\(slider\.value\); wxPaintBar\(\); \}/,
    'dragging the slider repaints the hour under it');
  assert.match(mapScript, /WX\.utcOffsetSeconds/,
    '"now" is found on the property\'s clock, not the phone\'s');
  assert.match(mapScript, /if \(WX\.note\) wxBar\.appendChild\(el\('div', 'stale', WX\.note\)\)/,
    'a stale forecast says so on the bar');
  assert.match(mapScript, /rotate\(' \+ Math\.round\(\(\(dirDeg \|\| 0\) \+ 180\) % 360\)/,
    'the arrow points where the air GOES while the words name where it is from');
});

test('crop fields: one vocabulary, faint paint, a chip for a click target', () => {
  // The dropdown's crops are db.mjs's own, interpolated as a value — the same
  // one-definition rule the measure geometry follows.
  assert.ok(mapScript.includes(JSON.stringify(CROP_KINDS)),
    'the page carries the database\'s crop list verbatim');
  assert.match(mapScript, /path class="field/, 'fields are drawn in the overlay SVG');
  assert.match(mapScript, /fieldPaths\(left, top\)\s*\n?\s*\.concat/,
    'and under everything else — they are ground, not a sticker');
  assert.match(mapStyles, /#map\.placing \.fieldlabel, #map\.placing \.routelabel \{ pointer-events: none; \}/,
    'chips stand down while a placing mode is armed');
  assert.match(mapScript, /'\/api\/cropscan\?lat='/, 'a new outline asks USDA for the crop');
  assert.match(mapScript, /cropTouched/,
    'and the answer never overwrites a crop the person already picked');
  assert.match(mapScript, /cutAt: cut\.value \|\| null/,
    'an empty date reads as standing, not as a date');
});

test('routes finally have a way back in: a chip, an edit form, redraw and delete', () => {
  assert.match(mapScript, /className = 'routelabel'/, 'every route wears a chip');
  assert.match(mapScript, /openRouteForm\(r\.points, r\)/, 'the chip opens the form in edit mode');
  assert.match(mapScript, /apiWrite\('PATCH', '\/api\/routes\/' \+ existing\.id/,
    'saving an edit PATCHes the same route');
  assert.match(mapScript, /apiWrite\('DELETE', '\/api\/routes\/' \+ existing\.id\)/,
    'and delete exists at last');
  assert.match(mapScript, /drawing = \{ standId: existing\.stand_id, points: \[\], editingId: existing\.id \}/,
    'redraw arms the same drawing mode, carrying the route\'s identity');
  assert.match(mapScript, /if \(drawing && drawing\.editingId === r\.id\) continue;/,
    'the old line hides while its replacement is drawn');
});

test('the suggested walk in is fetched, drawn dashed, and saved only on request', () => {
  assert.match(mapScript, /'\/api\/suggest-route\?standId='/, 'the server plans the line');
  assert.match(mapScript, /path class="sugwalk"/, 'drawn in its own colour and dash');
  assert.match(mapScript, /'Plan the walk in'/, 'offered from the stand report');
  assert.match(mapScript, /name: 'Walk in from ' \+ fromLabel/,
    'saving turns the proposal into an ordinary route');
  assert.match(mapScript, /kind === 'access'/,
    'an Access marker is the default entry point');
  assert.match(mapScript, /A model, not a promise/,
    'the caveat ships with the card, not just the PR description');
});

test('shooting lanes are drawn for the selected stand and no other', () => {
  // Every stand's cones at once was a wash of overlapping wedges over the
  // ground they describe. Driven in a browser on both grounds: nothing selected
  // 0 cones, North East Point 1 (its one lane), West Ladder 3 (its three),
  // closed again 0.
  const fn = mapScript.slice(mapScript.indexOf('function lanePaths'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  assert.match(body, /selected && selected\.kind === 'stand' && selected\.id === st\.id/,
    'a saved stand contributes its lanes only while it is the selected one');

  // The open form is exempt, and must stay exempt: you cannot edit a lane you
  // cannot see, and the form's copy is the array the handles mutate.
  const editLine = body.slice(0, body.indexOf('for (const st of STANDS)'));
  assert.match(editLine, /if \(laneForm\) sets\.push\(/,
    'the lanes being edited are drawn whether or not anything is selected');

  // Selection changes what is on the map, so both panels must repaint. Without
  // this the cones appear only on the NEXT redraw - a pan, a zoom, anything.
  for (const opener of ['function showStandReport', 'function showCameraPanel']) {
    const f = mapScript.slice(mapScript.indexOf(opener));
    const end = f.indexOf('\n}');
    assert.match(f.slice(0, end).slice(-120), /draw\(\);/,
      opener + ' repaints, so the lanes follow the selection immediately');
  }
});

test('all of it still compiles as one page script', () => {
  const html = dashboardHtml([], [], '2026-08-29T12:00:00.000Z', null, [], true, []);
  const blocks = [...html.matchAll(
    /<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(blocks.length, 1);
  assert.doesNotThrow(() => new vm.Script(blocks[0]));
  // The three new interactive surfaces survived composition.
  for (const id of ['zhome', 'fieldBtn', 'wxchip', 'wxbar']) {
    assert.ok(html.includes('id="' + id + '"'), `#${id} is on the page`);
  }
});

// ---------------------------------------------------------------------------
// Find an owner — the name search on the map
// ---------------------------------------------------------------------------

test('the owner search is a toolbar control that needs the server', () => {
  assert.match(mapMarkup, /<button id="findOwner" type="button">Find an owner<\/button>/,
    'it sits beside "Who owns this?" in the Ground group — same question, other end');
  const guard = mapScript.slice(mapScript.indexOf('findBtn.disabled'));
  assert.match(guard.slice(0, 200), /Owner search needs the server/,
    'opened as a saved file there is nothing to query, and a dead button must say why');
});

test('the search panel and the parcel card never share the corner', () => {
  // They sit in the same place and drive the same PARCEL_RINGS. Both open at
  // once is two answers to one question, with one boundary between them.
  const panel = mapScript.slice(mapScript.indexOf('function ownerPanel()'));
  assert.match(panel.slice(0, 400), /removeParcelCard\(\);/,
    'opening the search puts the card away');
  const look = mapScript.slice(mapScript.indexOf('async function lookupParcel'));
  assert.match(look.slice(0, 300), /removeOwnerSearch\(\);/,
    'and a click on the map puts the search away');
});

test('closing the search takes its boundary with it', () => {
  // The same split the parcel card needed: replacing the list must leave the
  // outline alone, dismissing it must not leave a red line on the map with
  // nothing on screen explaining what it is.
  const close = mapScript.slice(mapScript.indexOf('function closeOwnerSearch()'));
  assert.match(close.slice(0, 200),
    /removeOwnerSearch\(\);\s*\n\s*if \(PARCEL_RINGS\) \{ PARCEL_RINGS = null; draw\(\); \}/);
});

test('a truncated list says so before the rows', () => {
  const draw = mapScript.slice(mapScript.indexOf('function drawOwnerHits()'));
  assert.match(draw.slice(0, 1200), /if \(ownerHits\.truncated\)/,
    'fifty rows with no note reads as "these are all of them"');
  assert.match(draw.slice(0, 1200), /narrow the name/,
    'and it says what to do about it');
});

test('picking a result frames the parcel itself', () => {
  const pick = mapScript.slice(mapScript.indexOf('function pickOwnerHit('));
  assert.match(pick.slice(0, 600), /PARCEL_RINGS = p\.rings \|\| null;/);
  assert.match(pick.slice(0, 600), /\(\{ centre, zoom \} = frameFor\(pts\)\)/,
    'a 300-acre block and a town lot each fill the map');
  assert.match(pick.slice(0, 600), /else if \(p\.centre\)/,
    'the rare record with attributes but no geometry still goes somewhere');
});

test('the search asks the server, which asks the parcel service', () => {
  assert.match(mapScript, /fetch\('\/api\/parcels\/search\?name=' \+ encodeURIComponent\(term\)\)/,
    'one client on the public service, as with the point lookup');
  assert.match(mapScript, /Type at least three letters of a name\./,
    'the short-name rule is answered locally rather than by a round trip and a 400');
});
