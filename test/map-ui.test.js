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
  assert.match(mapScript, /if \(WX\.note\) body\.appendChild\(el\('div', 'stale', WX\.note\)\)/,
    'a stale forecast says so on the bar (its body, since radar joined the bar)');
  assert.match(mapScript, /rotate\(' \+ Math\.round\(\(\(dirDeg \|\| 0\) \+ 180\) % 360\)/,
    'the arrow points where the air GOES while the words name where it is from');
});

test('the timeline is drawn, not borrowed from the browser', () => {
  // The native range input is deliberately KEPT — it already knows how to be
  // dragged, arrowed and announced — and then stripped of its chrome. Losing
  // the input in favour of a div is the regression this pins: the look would
  // survive and the keyboard would not.
  assert.match(mapScript, /slider\.type = 'range'/,
    'the control is still a real range input, for keyboard and screen readers');
  assert.match(mapScript, /slider\.setAttribute\('aria-label', 'Forecast hour'\)/,
    'a slider stripped of its chrome has to say what it is');
  assert.match(mapStyles, /\.wxbar input\[type=range\] \{ -webkit-appearance: none; appearance: none;/,
    'the browser thumb and groove are removed, not merely recoloured');
  assert.match(mapStyles, /::-webkit-slider-thumb[\s\S]*?background: var\(--accent\)/,
    'the thumb is drawn in the app palette');
  assert.match(mapStyles, /:focus-visible::-webkit-slider-thumb/,
    'keyboard focus is visible — appearance:none removes the default ring too');

  // The rain profile sits behind the track. Heights are probability; the
  // darker bars are the hours with precipitation actually falling, which is
  // the distinction height alone cannot carry.
  assert.match(mapScript, /const spark = el\('div', 'wxspark'\)/,
    'the bar draws a rain profile behind the timeline');
  assert.match(mapScript, /const wet = Number\.isFinite\(WX\.precip\[i\]\) && WX\.precip\[i\] > 0/,
    'an hour with rain falling is marked apart from one that merely might');
  assert.match(mapScript, /Math\.max\(10, \.\.\.probs\.filter\(p => Number\.isFinite\(p\)\)\)/,
    'a dry week does not scale a 4% chance up into a wall of rain');

  // "Now" is inside the track, not at its left edge: the forecast starts at
  // midnight this morning.
  assert.match(mapScript, /tick\.style\.left = \(wxNowIdx \/ \(WX\.time\.length - 1\) \* 100\) \+ '%'/,
    'the now tick is placed by index, so it stays true as the forecast rolls');

  assert.doesNotMatch(mapStyles, /\.wxbar \.scale span \{[^}]*border-left/,
    'the day cells lost their dividers — they drew a grid the data does not have');
});

test('the floating controls fall back to something solid', () => {
  // color-mix is the whole glass effect. Where it does not land the control
  // must still be readable, so every translucent fill is preceded by the
  // opaque one — a plain chip is fine, an unreadable one is not.
  for (const sel of ['.wxchip', '.wxbar']) {
    const block = mapStyles.slice(mapStyles.indexOf('  ' + sel + ' {'));
    const decl = block.slice(0, block.indexOf('}'));
    assert.ok(/background: var\(--panel\);[\s\S]*background: color-mix/.test(decl),
      sel + ' declares the opaque background before the translucent one');
    assert.ok(/border: 1px solid var\(--line\);[\s\S]*border-color: color-mix/.test(decl),
      sel + ' does the same for its edge');
  }
  assert.match(mapStyles, /-webkit-backdrop-filter: blur/,
    'Safari still needs the prefixed backdrop-filter');
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

test('radar rides its own axis, and never joins the tile machinery', () => {
  // Radar deliberately does NOT become an OVERLAY_SOURCES entry. That set is
  // written to localStorage, offered to the bounded offline pre-fetch, and
  // addressed by a URL with no time in it — three things that are all wrong
  // for an image which expires in minutes.
  assert.match(mapScript, /if \(radarOn && radarFrame\(\)\) paintRadar\(left, top, W, H\);/,
    'radar paints in its own pass, after every overlay and outside the tile loop');
  assert.match(mapScript, /img\.src = '\/radar\/' \+ f\.id \+ '\/' \+ rz/,
    'the URL carries a frame AND its own zoom, which is why it cannot be an overlay template');

  // The service has radar only to z7; above it every request answers HTTP 200
  // with an identical "Zoom Level Not Supported" placard (measured at z8-z12,
  // 1370 bytes each). Drawn straight that is a grey wall of lettering across
  // the property, and nothing in the response says so.
  assert.match(mapScript, /const rz = Math\.min\(zoom, RADAR_MAX_ZOOM\)/,
    'the deepest zoom that exists is asked for, never deeper');
  assert.match(mapScript, /const RADAR_MAX_ZOOM = 7;/,
    'and the ceiling is emitted from the module that measured it, not retyped');
  assert.match(mapScript, /const size = TS \* 2 \*\* \(zoom - rz\)/,
    'that tile is then stretched — radar is a kilometre across, so nothing is lost');
  assert.doesNotMatch(mapScript, /overlayOn\.add\('radar'\)|OVERLAYS\.radar/,
    'radar is not an overlay, so it cannot be persisted or pre-fetched as one');
  const save = mapScript.slice(mapScript.indexOf("'/api/tiles/save'"));
  assert.doesNotMatch(save.slice(0, 600), /radar/,
    'and "save this view" never pre-fetches a frame that dies in ten minutes');

  // The cutoff is the server's judgement, honoured by the paint loop rather
  // than only by a label — a note saying "too old" over a drawn storm would
  // be the worst of both.
  assert.match(mapScript, /const radarFrame = \(\) =>\s*\n?\s*\(RADAR && !RADAR\.tooOld/,
    'too old means nothing is drawn, not merely something is written');

  assert.match(mapScript, /const wasNewest = !RADAR \|\| radarIdx >= \(RADAR\.frames\.length - 1\)/,
    'the live tail is decided before the new reel replaces the old one');
  assert.match(mapScript, /radarNewer = RADAR\.frames\.length - 1 - radarIdx/,
    'and a scrubbed-back viewer is told how many arrived behind them');
  assert.match(mapScript, /radarStop\(\);[^\n]*\n\s*radarIdx = Number\(slider\.value\)/,
    'a hand on the slider ends the autoplay rather than fighting it');
  assert.match(mapScript, /img\.onerror = \(\) => \{ img\.style\.display = 'none'; radarExpired\(\); \}/,
    'a 410 refreshes the reel instead of dripping dead requests every pan');
});

test('the loop only runs while somebody is looking at it', () => {
  assert.match(mapScript, /radarPoll = setInterval\(/, 'new frames are polled for');
  assert.match(mapScript, /5 \* 60000\)/, 'about as often as the vendor publishes');
  const setMode = mapScript.slice(mapScript.indexOf('async function wxSetMode'));
  assert.match(setMode.slice(0, 900), /radarOn = false;[\s\S]*?radarStop\(\);[\s\S]*?radarPollStop\(\)/,
    'leaving radar mode stops BOTH timers — polling a reel nobody is watching '
    + 'spends the truck\'s data on nothing');
});

test('the radar clock is the property\'s, like everything else on the bar', () => {
  assert.match(mapScript, /function radarClock\(unixSeconds\)/);
  assert.match(mapScript, /Number\.isFinite\(WX\?\.utcOffsetSeconds\) \? WX\.utcOffsetSeconds : null/,
    'frames are stamped on the ground\'s clock, not the phone\'s');
  assert.match(mapScript, /d\.getUTCHours\(\)/,
    'and the offset is applied by reading UTC parts, not by re-parsing a local string');
});

test('one track, two modes — not two sliders stacked', () => {
  assert.match(mapScript, /function wxSegment\(\)/);
  assert.match(mapScript, /\['forecast', 'Forecast'\], \['radar', 'Radar'\]/,
    'the two modes are the segmented control');
  assert.match(mapScript, /b\.setAttribute\('aria-pressed'/,
    'a segmented control has to announce which half is chosen');
  assert.match(mapScript, /slider\.setAttribute\('aria-label', 'Radar frame'\)/,
    'the radar track names itself too');
  assert.match(mapStyles, /\.wxseg button\.on \{/, 'and the chosen half is drawn as chosen');
});

test('the chip admits when radar is painting behind a closed bar', () => {
  const chip = mapScript.slice(mapScript.indexOf('function wxPaintChip'));
  assert.match(chip.slice(0, 1400), /if \(radarOn && rf\)/,
    'a live layer with every control hidden is the state this prevents');
  assert.match(chip.slice(0, 1400), /radarClock\(rf\.time\)/, 'the chip carries the frame time');
  assert.match(chip.slice(0, 1400), /wxdot stale/,
    'radar on with nothing drawable says so rather than looking off');
  assert.match(mapStyles, /\.wxdot\.live \{[^}]*animation: wxpulse/);
  assert.match(mapStyles, /prefers-reduced-motion[\s\S]*?\.wxdot\.live \{ animation: none; \}/,
    'the pulse respects a reduced-motion preference');
});

test('the age beside a frame is that frame\'s, not the reel\'s', () => {
  // Caught by the browser drive: the head read "9 min old" next to a frame
  // from ninety minutes earlier, because it was reporting the reel's age.
  // They differ by the whole loop the moment you scrub back.
  const head = mapScript.slice(mapScript.indexOf('function wxPaintRadarHead'));
  assert.match(head.slice(0, 1600), /const mins = Math\.round\(\(Date\.now\(\) - f\.time \* 1000\) \/ 60000\)/,
    'the age is measured off the displayed frame');
  assert.doesNotMatch(head.slice(0, 1600), /RADAR\.ageMinutes \+ ' min/,
    'the reel age governs whether radar draws at all, and describes no single frame');
  assert.match(head.slice(0, 1600), /in ' \+ Math\.abs\(mins\)/,
    'a nowcast frame is in the future, and says so rather than reporting negative age');
});
