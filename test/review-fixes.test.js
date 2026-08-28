/**
 * Regressions for the findings a code review turned up on this session's work.
 *
 * Four of them live in generated browser scripts, where the failure needs a
 * real DOM and a real network to reproduce. Those are pinned structurally —
 * the same approach as the pointer-capture and mode-disarm tests: assert the
 * SHAPE that makes the bug impossible, and say in the comment what was
 * verified by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tonightHtml } from '../tonight-page.mjs';
import { mapScript } from '../map-view.mjs';

const tonight = tonightHtml();

test('the countdown cannot re-enter load() forever at close of light', () => {
  // startClock() calls tick() immediately, and load() calls startClock(). So
  // an unguarded load() from inside tick() re-enters itself. Online the server
  // returns the NEXT sit and it settles; offline the service worker keeps
  // answering with the same expired one, and the phone spins at exactly the
  // moment shooting light ends.
  assert.match(tonight, /let rolledOverFrom = null/, 'the roll-over is tracked');
  // Anchor on the guard, not on the message: there are two "light is over"
  // branches now, and the partial-day one comes first.
  const at = tonight.indexOf('rolledOverFrom !== id');
  assert.ok(at > 0, 'the reload is guarded');
  const guard = tonight.slice(at, at + 200);
  assert.match(guard, /clearInterval\(clockTimer\)/, 'and stops the timer first');
  assert.match(guard, /load\(\);/, 'before asking for the next sit');
  // The only load() inside the tick must be that guarded one.
  const tick = tonight.slice(tonight.indexOf('const tick = ()'), tonight.indexOf('clockTimer = setInterval'));
  assert.equal((tick.match(/load\(\)/g) || []).length, 1,
    'exactly one reload path inside the tick');
});

test('a server rejection is never reported as "no connection"', () => {
  // They shared a catch: a 400 threw, landed in the offline branch, told the
  // user the sit was saved on the phone, and the next flush dropped it as
  // rejected. Data loss behind two reassuring messages.
  const save = tonight.slice(tonight.indexOf('save.onclick'), tonight.indexOf('row.appendChild(save)'));
  const fetchTry = save.slice(save.indexOf('let res;'), save.indexOf('try {', save.indexOf('let res;') + 10));
  assert.match(save, /return queueOffline\(err\)/, 'a thrown fetch queues');
  // The !res.ok throw must sit in a DIFFERENT try from the fetch.
  const okThrow = save.indexOf('if (!res.ok) throw');
  const queueCall = save.indexOf('return queueOffline(err)');
  assert.ok(queueCall < okThrow,
    'the offline branch is closed before the response is inspected');
  assert.match(save, /The server would not accept this/, 'and a refusal says so');
});

test('a legal window is only printed when both ends are known', () => {
  assert.match(tonight, /if \(h\.openLocal && h\.closeLocal\)/,
    'both bounds required before the window is stated');
  assert.match(tonight, /the other end is not in this plan/,
    'and a half-known day says which half it has');
});

test('a failed suggestion request shows the reason, not "nothing to suggest"', () => {
  // The endpoint explains itself — no stands yet, no LiDAR coverage, terrain
  // service down — and all three came out as the blandest possible lie.
  // Bounded to the function: an unbounded slice runs to the end of the script
  // and matches an ok-check belonging to something else entirely.
  const from = mapScript.indexOf('async function loadSuggestions');
  const load = mapScript.slice(from, mapScript.indexOf('suggestBtn.onclick', from));
  assert.ok(load.length > 200 && load.length < 3000, 'the slice is the function');
  assert.match(load, /if \(!res\.ok\) throw/, 'the status is checked');
  assert.match(load, /body\.error/, 'and the server\'s reason is used');
});

test('typing in a notes box never edits the map', () => {
  // The guard exempted INPUT and SELECT but not TEXTAREA, so with measure
  // armed, Backspace in a stand or marker notes field deleted a map point
  // instead of a character. Clicking a pin does not disarm measure, so it is
  // one click away.
  assert.match(mapScript, /const isTyping = t =>/, 'one shared predicate');
  assert.match(mapScript, /t\.tagName === 'TEXTAREA'/, 'which knows about textareas');
  assert.match(mapScript, /t\.isContentEditable/);
  // And both keyboard handlers go through it rather than keeping their own list.
  const guards = [...mapScript.matchAll(/if \(isTyping\(e\.target\)\) return;/g)];
  assert.ok(guards.length >= 2, `both handlers use it, found ${guards.length}`);
  assert.doesNotMatch(mapScript, /e\.target\.tagName === 'INPUT'/,
    'no handler keeps its own copy of the list');
});

test('the click that ends a pan does not drop a point', () => {
  // Every map mode treats a click as "put something here", so dragging the map
  // to see the rest of a shape added a measure point where you let go — and
  // panning is unavoidable when measuring anything larger than the screen.
  assert.match(mapScript, /const DRAG_SLOP_PX = 5/);
  assert.match(mapScript, /dragged = true/, 'movement past the threshold is recorded');
  const click = mapScript.slice(mapScript.indexOf("mapEl.addEventListener('click'"));
  assert.match(click.slice(0, 300), /if \(dragged\) \{ dragged = false; return; \}/,
    'and the click that follows it is ignored');
});

test('the next sit and the better day are not announced twice', () => {
  // When the chronologically next sit is also the best one coming, both cards
  // named the same evening. Seen on the real page: "6 days out — morning of
  // 2026-09-03" printed in two panels, one under the other.
  const src = tonightHtml();
  assert.match(src, /b\.date === sits\[1\]\.date && b\.window === sits\[1\]\.window/,
    'the two cards are compared');
  assert.match(src, /!\(better && dupe\)/, 'and the duplicate is dropped');
});
