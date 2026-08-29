/**
 * Where the map points when it opens, and — the actual bug — that it opens at
 * all.
 *
 * The map used to frame the cameras and nothing else, and if no camera reported
 * GPS it replaced itself with a one-line apology, taking every stand, marker,
 * route and the measure tool down with it. That is backwards: a camera is one
 * of the things ON the map, not the reason there is one. Somebody with four
 * stands and no cameras has more to look at, not less — and could not drop a
 * fifth, because the button went with the map.
 *
 * The framing arithmetic is lifted out of the generated page and run here
 * against a stub DOM, so this tests the code that actually ships rather than a
 * copy of it. The three states were also driven in a real browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mapScript } from '../map-view.mjs';

/**
 * Run the page's own framing block against a stubbed map element.
 * Everything it needs is either declared inside the block or stubbed here.
 */
function frame({ cameras = [], stands = [], markers = [], width = 1000, height = 420 }) {
  const start = mapScript.indexOf('// Where to point the map when it opens.');
  const end = mapScript.indexOf('function draw()');
  assert.ok(start > 0 && end > start, 'the framing block was found in the page');
  const block = mapScript.slice(start, end);

  const ctx = vm.createContext({
    D: { cameras, stands, markers },
    located: cameras.filter(c => typeof c.lat === 'number' && typeof c.lng === 'number'),
    mapEl: { clientWidth: width, clientHeight: height },
    projX: (lng, z) => (lng + 180) / 360 * 256 * 2 ** z,
    projY: (lat, z) => {
      const s = Math.sin(lat * Math.PI / 180);
      return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
    },
  });
  new vm.Script(block + '\n({ zoom, centre, framePoints });').runInContext(ctx);
  return vm.runInContext('({ zoom, centre, framePoints })', ctx);
}

const CAM = { name: 'Creek', lat: 44.120, lng: -90.650 };
const STAND_A = { name: 'A', lat: 44.130, lng: -90.660 };
const STAND_B = { name: 'B', lat: 44.110, lng: -90.640 };
const MARKER = { kind: 'rub', lat: 44.125, lng: -90.655 };

test('cameras frame the map, as they always did', () => {
  const f = frame({ cameras: [CAM] });
  assert.equal(f.framePoints.length, 1);
  assert.equal(f.centre.lat, 44.120);
  assert.ok(f.zoom >= 16, 'a single point opens in close');
});

test('stands and markers frame it too, not just cameras', () => {
  const f = frame({ stands: [STAND_A, STAND_B], markers: [MARKER] });
  assert.equal(f.framePoints.length, 3);
  assert.ok(Math.abs(f.centre.lat - 44.12) < 1e-9);
  assert.ok(Math.abs(f.centre.lng + 90.65) < 1e-9);
});

test('with no camera on GPS the map is still framed and still drawn', () => {
  // The regression. Before this, a stands-only property got no map at all.
  const f = frame({ cameras: [{ name: 'no fix', lat: null, lng: null }], stands: [STAND_A, STAND_B] });
  assert.equal(f.framePoints.length, 2, 'the camera without a fix is skipped, the stands are not');
  assert.ok(Number.isFinite(f.centre.lat) && Number.isFinite(f.centre.lng));
  assert.notEqual(f.centre.lat, 0, 'and it is not left sitting in the Atlantic');
});

test('everything together is framed to fit', () => {
  const f = frame({ cameras: [CAM], stands: [STAND_A, STAND_B], markers: [MARKER] });
  assert.equal(f.framePoints.length, 4);
  // Every point must land inside the viewport at the chosen zoom.
  const px = (lng, z) => (lng + 180) / 360 * 256 * 2 ** z;
  const py = (lat, z) => {
    const s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z;
  };
  const cx = px(f.centre.lng, f.zoom), cy = py(f.centre.lat, f.zoom);
  for (const [lng, lat] of f.framePoints) {
    assert.ok(Math.abs(px(lng, f.zoom) - cx) < 500, 'inside the width');
    assert.ok(Math.abs(py(lat, f.zoom) - cy) < 210, 'inside the height');
  }
});

test('with nothing placed at all it opens wide, over the country', () => {
  const f = frame({});
  assert.equal(f.framePoints.length, 0);
  assert.ok(f.zoom <= 5, 'wide enough to pan to your ground');
  assert.ok(f.centre.lat > 20 && f.centre.lat < 55, 'somewhere in the continental US');
  assert.ok(f.centre.lng < -60 && f.centre.lng > -130);
});

test('zoom banks trackpad deltas, aims at the cursor, and pinches', () => {
  // The complaint this pins: a trackpad flick fires dozens of small wheel
  // events, and stepping one zoom level per EVENT turned a two-finger nudge
  // into "suddenly zoomed all the way out over the whole country".
  assert.match(mapScript, /wheelBank \+= e\.deltaMode/, 'deltas accumulate; an event is not a step');
  assert.match(mapScript, /Math\.trunc\(wheelBank \/ 100\)/, 'a hundred pixels is one step');
  assert.match(mapScript, /zoomAt\(zoom - steps, e\.clientX, e\.clientY\)/,
    'wheel zoom keeps the ground under the cursor');
  assert.match(mapScript, /touches\.size === 2\) \{ drag = null; dragged = true/,
    'a second finger ends the pan, and the pinch can never end in a click');
});

test('the map is never replaced by a message', () => {
  // The specific line that used to do it. A note belongs beside the map, not
  // instead of it.
  assert.doesNotMatch(mapScript, /mapEl\.innerHTML\s*=/,
    'nothing overwrites the map wholesale');
  assert.match(mapScript, /^paintControl\(\);$/m, 'the map is always painted');
  assert.match(mapScript, /No camera has reported GPS/, 'and the situation is explained');
});
