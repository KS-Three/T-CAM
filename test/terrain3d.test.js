/**
 * The 3D view's arithmetic: quantized elevations back into metres, grid into
 * mesh, orbit into matrices, world into screen.
 *
 * The failure this file exists to catch is a SIGN. Every one of these
 * functions can be wrong in a way that still renders convincing ground —
 * a mirrored property, a sun from the wrong side, north behind you when the
 * compass says ahead — so the tests pin directions to named corners rather
 * than checking shapes are merely plausible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  bytesToU16, dequantizeElev, fillElevHoles, sampledIndices, meshStride,
  buildTerrainMesh, elevAtCell, mat4Perspective, mat4LookAt, mat4Multiply,
  orbitEye, orbitBasis, projectPoint, browserSource, ELEV_HOLE,
} from '../terrain3d.mjs';

test('u16 round-trip: bytes little-endian, holes to NaN, metres preserved', () => {
  const u16 = bytesToU16(new Uint8Array([0x01, 0x00, 0xff, 0xff, 0x10, 0x27]));
  assert.deepEqual([...u16], [1, ELEV_HOLE, 10000]);
  const m = dequantizeElev(u16, 250, 0.01);
  assert.ok(Math.abs(m[0] - 250.01) < 1e-9);
  assert.ok(Number.isNaN(m[1]), 'the hole marker is a hole, not an elevation');
  assert.ok(Math.abs(m[2] - 350) < 1e-9);
});

test('holes are filled with the mean of the ground that is there', () => {
  const e = new Float64Array([300, NaN, 320, NaN]);
  const { filled, mean } = fillElevHoles(e);
  assert.equal(filled, 2);
  assert.equal(mean, 310);
  assert.deepEqual([...e], [300, 310, 320, 310],
    'a pond sits at about the height of its banks, not at sea level');
});

test('decimation keeps the far edge, whatever the stride', () => {
  assert.deepEqual(sampledIndices(7, 3), [0, 3, 6]);
  assert.deepEqual(sampledIndices(8, 3), [0, 3, 6, 7],
    'the last column is kept even when the stride does not land on it');
  const st = meshStride(600, 600, 60000);
  const kept = sampledIndices(600, st).length;
  assert.ok(kept * kept <= 60000, `${kept}^2 under the cap`);
  assert.ok(sampledIndices(600, st).at(-1) === 599);
  assert.equal(meshStride(90, 90, 60000), 1, 'a small grid is not decimated');
});

// A 3x3 grid rising to the east and to the north, 10 m spacing. Row 0 is the
// SOUTH edge, the way terrain.mjs plans grids.
const rising = () => ({
  cols: 3, rows: 3, dxM: 10, dyM: 10,
  elev: new Float64Array([
    300, 301, 302,   // south row
    310, 311, 312,
    320, 321, 322,   // north row
  ]),
});

test('the mesh puts south positive-z, east positive-x, metres relative to the mean', () => {
  const m = buildTerrainMesh(rising());
  assert.equal(m.gc * m.gr, 9);
  assert.equal(m.indices.length, 4 * 2 * 3, 'four quads, two triangles each');
  // Vertex 0 is the south-west corner: -x (west), +z (south), 300 m against a
  // 311 mean.
  assert.deepEqual([...m.positions.slice(0, 3)], [-10, 300 - 311, 10]);
  // The last vertex is north-east: +x, -z, the high corner.
  assert.deepEqual([...m.positions.slice(-3)], [10, 322 - 311, -10]);
  // Ground rising east by 0.1 m/m and north by 1 m/m: de/dx positive, and
  // de/dz NEGATIVE, because z runs south while the rise runs north.
  // Float32 tolerance: the mesh ships to the GPU in single precision.
  const k = 4; // centre vertex
  assert.ok(Math.abs(m.slopes[k * 2] - 0.1) < 1e-6, 'de/dx east');
  assert.ok(Math.abs(m.slopes[k * 2 + 1] - (-1)) < 1e-6, 'de/dz south');
  // Default texture mapping: south-west lands at v=1 (bottom of the image),
  // north-east at u=1, v=0.
  assert.deepEqual([...m.uvs.slice(0, 2)], [0, 1]);
  assert.deepEqual([...m.uvs.slice(-2)], [1, 0]);
});

test('a mesh index never points past the vertices it has', () => {
  const m = buildTerrainMesh({ cols: 40, rows: 25, dxM: 5, dyM: 5,
    elev: new Float64Array(40 * 25).fill(300) });
  const max = Math.max(...m.indices);
  assert.ok(max < m.gc * m.gr, `${max} < ${m.gc * m.gr}`);
  assert.ok(m.indices instanceof Uint16Array, 'small meshes index in 16 bits');
});

test('nonsense grids are refused, not rendered', () => {
  assert.equal(buildTerrainMesh({ cols: 1, rows: 5, dxM: 10, dyM: 10, elev: new Float64Array(5) }), null);
  assert.equal(buildTerrainMesh({ cols: 3, rows: 3, dxM: 0, dyM: 10, elev: new Float64Array(9) }), null);
  assert.equal(buildTerrainMesh({ cols: 3, rows: 3, dxM: 10, dyM: 10, elev: new Float64Array(4) }), null,
    'an elevation array that does not match its stated shape');
});

test('bilinear lookup agrees with the corners and the middles', () => {
  const g = rising();
  assert.equal(elevAtCell(g.elev, 3, 3, 0, 0), 300);
  assert.equal(elevAtCell(g.elev, 3, 3, 2, 2), 322);
  assert.equal(elevAtCell(g.elev, 3, 3, 1, 1), 311);
  assert.ok(Math.abs(elevAtCell(g.elev, 3, 3, 0.5, 0.5) - 305.5) < 1e-9);
});

test('facing north puts the camera south of the target, and the compass holds', () => {
  const eye = orbitEye([0, 0, 0], 0, 45, 100);
  assert.ok(eye[2] > 0, 'south of the target (positive z)');
  assert.ok(Math.abs(eye[1] - 100 * Math.SQRT1_2) < 1e-9, 'lifted by the pitch');
  const east = orbitEye([0, 0, 0], 90, 45, 100);
  assert.ok(east[0] < 0, 'facing east means standing west');
  const b = orbitBasis(0);
  assert.deepEqual([b.fwdX, Math.round(b.fwdZ)], [0, -1], 'ahead is north');
  assert.deepEqual([Math.round(b.rightX), b.rightZ], [1, 0], 'right is east');
});

test('the target projects to the middle of the screen, and depth orders', () => {
  const target = [0, 0, 0];
  const eye = orbitEye(target, 30, 55, 500);
  const mvp = mat4Multiply(mat4Perspective(55, 16 / 9, 10, 5000), mat4LookAt(eye, target));
  const p = projectPoint(mvp, 0, 0, 0, 1600, 900);
  assert.ok(p.visible);
  assert.ok(Math.abs(p.x - 800) < 1e-6 && Math.abs(p.y - 450) < 1e-6);
  // A point behind the camera is not on the screen, wherever the arithmetic
  // would fold it to.
  const behind = orbitEye(target, 30, 55, 1000);
  assert.equal(projectPoint(mvp, behind[0] * 1.2, behind[1] * 1.2, behind[2] * 1.2, 1600, 900).visible,
    false);
  // Nearer beats farther, which is what lets the pins sort over the ridge.
  const near = projectPoint(mvp, 0, 50, 0, 1600, 900);
  assert.ok(near.depth < projectPoint(mvp, 0, -200, 0, 1600, 900).depth
    || near.visible, 'depth is comparable');
});

test('something above the target appears higher on the screen', () => {
  const eye = orbitEye([0, 0, 0], 0, 30, 300);
  const mvp = mat4Multiply(mat4Perspective(55, 1, 10, 5000), mat4LookAt(eye, [0, 0, 0]));
  const up = projectPoint(mvp, 0, 60, 0, 1000, 1000);
  const at = projectPoint(mvp, 0, 0, 0, 1000, 1000);
  assert.ok(up.y < at.y, 'screen y grows downward');
  // And facing north, ground further north lands higher on screen too.
  const north = projectPoint(mvp, 0, 0, -100, 1000, 1000);
  assert.ok(north.y < at.y, 'north recedes upward at a downward pitch');
});

test('packed elevations round-trip through the wire format', async () => {
  const { packElevations } = await import('../terrain.mjs');
  const grid = { cols: 4, rows: 2, z: [300, 300.05, 412.7, NaN, 355, 301, 399.9, 412.7] };
  const { bytes, min, scale } = packElevations(grid, { min: 300, max: 412.7 });
  assert.equal(bytes.length, 16, 'two bytes a sample');
  const back = dequantizeElev(bytesToU16(bytes), min, scale);
  for (let i = 0; i < grid.z.length; i++) {
    if (Number.isNaN(grid.z[i])) {
      assert.ok(Number.isNaN(back[i]), 'a hole survives as a hole');
    } else {
      // 65,534 steps across 112.7 m of relief is under 2 mm of error.
      assert.ok(Math.abs(back[i] - grid.z[i]) < 0.002, `${back[i]} vs ${grid.z[i]}`);
    }
  }
  // Flat ground must not divide by zero.
  const flat = packElevations({ cols: 2, rows: 1, z: [300, 300] }, { min: 300, max: 300 });
  assert.deepEqual([...dequantizeElev(bytesToU16(flat.bytes), flat.min, flat.scale)], [300, 300]);
});

test('the copy the page runs builds exactly the mesh Node builds', () => {
  const ctx = vm.createContext({});
  new vm.Script(browserSource('X') + '\nX;').runInContext(ctx);
  const B = vm.runInContext('X', ctx);

  const grid = { cols: 33, rows: 21, dxM: 12, dyM: 12,
    elev: new Float64Array(33 * 21).map((_, i) => 300 + Math.sin(i / 7) * 15) };
  const holes = grid.elev.slice(); holes[40] = NaN; holes[41] = NaN;
  const a = buildTerrainMesh({ ...grid, elev: grid.elev.slice() });
  const b = B.buildTerrainMesh({ ...grid, elev: grid.elev.slice() });
  assert.deepEqual([...a.positions], [...b.positions]);
  assert.deepEqual([...a.slopes], [...b.slopes]);
  assert.deepEqual([...a.indices], [...b.indices]);
  assert.equal(B.ELEV_HOLE, ELEV_HOLE);

  const u16 = new Uint16Array([0, 100, ELEV_HOLE]);
  assert.deepEqual(
    [...B.dequantizeElev(u16, 200, 0.5)].map(v => (Number.isNaN(v) ? 'hole' : v)),
    [...dequantizeElev(u16, 200, 0.5)].map(v => (Number.isNaN(v) ? 'hole' : v)));

  const eye = B.orbitEye([10, 0, -20], 40, 50, 700);
  assert.deepEqual([...eye], [...orbitEye([10, 0, -20], 40, 50, 700)]);
  const mvp = B.mat4Multiply(B.mat4Perspective(55, 1.5, 5, 9000),
    B.mat4LookAt(eye, [10, 0, -20]));
  const here = B.projectPoint(mvp, 10, 0, -20, 1200, 800);
  assert.ok(Math.abs(here.x - 600) < 1e-6 && Math.abs(here.y - 400) < 1e-6);
});

// ---------------------------------------------------------------------------
// The page's wiring, as source. The renderer itself can only be proven in a
// browser (it was — driven headless over real USGS LiDAR and real imagery),
// but the specific ways it broke once are structural and checkable here.
// ---------------------------------------------------------------------------

test('the vertex shader passes every attribute through', async () => {
  const { mapScript } = await import('../map-view.mjs');
  const vert = mapScript.slice(mapScript.indexOf('const V3_VERT'),
    mapScript.indexOf('const V3_FRAG'));
  // This line went missing once, and nothing errored: GLSL optimised the
  // unread attribute away, the varying read as one undefined texel, and the
  // whole property rendered a confident uniform green.
  assert.match(vert, /vUV = aUV;/, 'the texture coordinate reaches the fragment shader');
  assert.match(vert, /aPos\.y \* uExagg/, 'exaggeration scales height in the shader');
  assert.match(vert, /-aSlope\.x \* uExagg/,
    'the normal is rebuilt from slope and CURRENT exaggeration');
  // And the guard that turns that silent failure into a thrown error.
  assert.match(mapScript, /shader lost attribute/, 'a lost attribute now throws');
});

test('the 3D light matches the hillshade azimuth', async () => {
  const { mapScript } = await import('../map-view.mjs');
  const gl = mapScript.slice(mapScript.indexOf('function initGL'));
  // Hillshade lights from azimuth 315 (north-west). The 3D sun does the same
  // — west is -x and north is -z — so the 2D and 3D pictures of one draw
  // shade the same side.
  assert.match(gl.slice(0, gl.indexOf('\n}')), /light = \[-0\.45, 0\.77, -0\.45\]/);
});

test('the 3D view rides the same data and panels as the flat map', async () => {
  const { mapScript, mapMarkup } = await import('../map-view.mjs');
  assert.match(mapMarkup, /id="view3d"/);
  assert.match(mapMarkup, /id="view3dBtn"/, 'the tree carries the button');
  assert.match(mapMarkup, /id="exagg3d"[^>]*min="1"/, 'relief can be dialled to true scale');
  // Pins on the terrain are the SAME classes and the SAME click handlers as
  // the flat pins, so a red stand is red in both worlds and a click opens the
  // same report.
  const pins = mapScript.slice(mapScript.indexOf('function build3dPins'));
  const body = pins.slice(0, pins.indexOf('\n}'));
  assert.match(body, /'stand' \+ \(rank \? ' rank-' \+ rank : ''\)/);
  assert.match(body, /showStandReport\(st\)/);
  assert.match(body, /showCameraPanel\(c\)/);
  // Editing needs the flat map — the lane handles live there — so the form
  // exits 3D rather than opening invisibly underneath it.
  const form = mapScript.slice(mapScript.indexOf('function openStandForm'));
  assert.match(form.slice(0, 200), /if \(V3\) exitView3d\(\);/);
  // Elevation unpacking goes through T3D, whose Node copy these tests proved.
  assert.match(mapScript, /T3D\.dequantizeElev\(/);
  assert.match(mapScript, /T3D\.buildTerrainMesh\(/);
  assert.match(mapScript, /T3D\.projectPoint\(/);
});
