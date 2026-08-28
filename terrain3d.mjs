/**
 * terrain3d.mjs — the arithmetic behind the 3D view of the ground.
 *
 * The map can already draw the ground from above: hillshade, contours, draws
 * and ridges, all computed from the USGS 3DEP elevation grid the server
 * fetches and caches. What a flat rendering cannot do is answer the question
 * you actually stand in the woods with — what can I see FROM there — and that
 * is a question about relief. So the same grid is built into a mesh, the
 * satellite imagery is draped over it, and the camera is put where your eyes
 * would be.
 *
 * WHY THIS IS HAND-ROLLED. The obvious move is a library, and it would be
 * wrong here twice over: the dashboard's own rule is that the page has no
 * dependency to break (the offline test literally asserts the page contacts no
 * external host), and a mapping library's 3D mode wants its own tile pipeline
 * when this program already has one, proxied and cached. A terrain mesh, four
 * matrix functions and one shader pair is a few hundred lines — less code
 * than configuring the library would be, and every line of it testable here.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This module is the maths: quantized
 * elevations back into metres, grid into triangles, orbit angles into
 * matrices, world points into screen points. It runs in Node, where the tests
 * are, and is emitted into the page with the same browserSource() pattern
 * measure.mjs and coverage.mjs use — one definition, compiled and compared by
 * the tests, so the mesh the browser drapes and the mesh the tests measure
 * cannot drift. The WebGL calls themselves — contexts, buffers, the render
 * loop — live in map-view.mjs, because a GL context is a browser thing and
 * mocking one here would test the mock.
 *
 * AXES, ONCE. x is metres east, y is metres up, z is metres SOUTH — a
 * right-handed frame where "camera south of the target looking north" is the
 * resting view, matching how you read a paper map. The elevation grid arrives
 * row-major with row 0 at the SOUTH edge (the way terrain.mjs plans it), so
 * row r sits at z = ((rows-1)/2 - r) * dyM: row 0 positive-z (south), last
 * row negative (north). Getting either sign wrong mirrors the property, and
 * a mirrored property still looks like ground — which is why the tests pin
 * both signs to named corners.
 */

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Elevations travel as base64 Uint16, little-endian, because Float64 would be
 * four times the bytes for precision the source data does not have (3DEP is
 * good to about a tenth of a metre; 65534 steps across Wisconsin's relief is
 * millimetres). 0xFFFF is the hole marker: water, or ground 3DEP has not
 * flown. Reassembled by hand rather than with a DataView so the same code
 * runs on the raw bytes atob() gives a browser.
 */
export function bytesToU16(bytes) {
  const out = new Uint16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  return out;
}

export const ELEV_HOLE = 65535;

/** Quantized steps back into metres; holes come back as NaN, not as zero. */
export function dequantizeElev(u16, min, scale) {
  const out = new Float64Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    out[i] = u16[i] === ELEV_HOLE ? NaN : min + u16[i] * scale;
  }
  return out;
}

/**
 * Holes filled with the mean of the ground that IS there.
 *
 * A mesh cannot have NaN vertices — one poisons every triangle that touches
 * it and WebGL draws nothing, silently. The mean is the least-opinionated
 * patch: a pond sits at about the height of its banks, and the alternative
 * (zero) would dig a 300-metre shaft to sea level in the middle of the
 * property. Returns how many were filled, so a caller can say so.
 */
export function fillElevHoles(elev) {
  let sum = 0, n = 0;
  for (let i = 0; i < elev.length; i++) {
    if (Number.isFinite(elev[i])) { sum += elev[i]; n += 1; }
  }
  const mean = n ? sum / n : 0;
  let filled = 0;
  for (let i = 0; i < elev.length; i++) {
    if (!Number.isFinite(elev[i])) { elev[i] = mean; filled += 1; }
  }
  return { filled, mean };
}

/**
 * The lattice indices a decimated mesh keeps: every `stride`-th, plus the far
 * edge whatever the stride, because dropping the last row of samples would
 * shave metres off one side of the property and only that side.
 */
export function sampledIndices(count, stride) {
  const out = [];
  for (let i = 0; i < count; i += stride) out.push(i);
  if (out[out.length - 1] !== count - 1) out.push(count - 1);
  return out;
}

/** The smallest stride that keeps the mesh under `maxVerts` vertices. */
export function meshStride(cols, rows, maxVerts) {
  let stride = 1;
  const vertsAt = st =>
    sampledIndices(cols, st).length * sampledIndices(rows, st).length;
  while (vertsAt(stride) > maxVerts) stride += 1;
  return stride;
}

/**
 * The elevation grid as a triangle mesh.
 *
 * Vertices carry position (x east, y metres above the grid's mean, z south),
 * texture coordinates, and the ground's SLOPE (de/dx, de/dz) instead of a
 * normal. That is not an optimisation but a correctness point: the view has a
 * vertical-exaggeration control, and a stored normal is only right for one
 * exaggeration — the shader rebuilds the true normal from the slope and the
 * current setting, so lighting stays honest while the slider moves. y keeps
 * REAL metres for the same reason; the shader multiplies.
 *
 * `maxVerts` caps the mesh by decimation, defaulting under 65536 so indices
 * fit Uint16 — the one index size WebGL 1 takes without an extension.
 *
 * `uv(c, r)` maps a full-resolution lattice cell to texture coordinates. The
 * default spreads the texture edge-to-edge, which is right only when the
 * texture was cut exactly to the grid; the map passes a mapping through its
 * tile projection instead, because tiles come in powers-of-two chunks that
 * never line up with the grid edge.
 */
export function buildTerrainMesh({ cols, rows, dxM, dyM, elev, maxVerts = 60000, uv = null }) {
  if (!isNum(cols) || !isNum(rows) || cols < 2 || rows < 2) return null;
  if (!isNum(dxM) || !isNum(dyM) || !(dxM > 0) || !(dyM > 0)) return null;
  if (!elev || elev.length !== cols * rows) return null;

  const { mean } = fillElevHoles(elev);
  const stride = meshStride(cols, rows, maxVerts);
  const cs = sampledIndices(cols, stride);
  const rs = sampledIndices(rows, stride);
  const gc = cs.length, gr = rs.length;

  const positions = new Float32Array(gc * gr * 3);
  const slopes = new Float32Array(gc * gr * 2);
  const uvs = new Float32Array(gc * gr * 2);
  const at = (c, r) => elev[r * cols + c];

  for (let j = 0; j < gr; j++) {
    const r = rs[j];
    for (let i = 0; i < gc; i++) {
      const c = cs[i];
      const k = j * gc + i;
      positions[k * 3] = (c - (cols - 1) / 2) * dxM;
      positions[k * 3 + 1] = at(c, r) - mean;
      positions[k * 3 + 2] = ((rows - 1) / 2 - r) * dyM;
      // Central differences on the SAMPLED lattice, because that is the
      // surface actually drawn; slopes of detail the decimation removed would
      // light bumps the mesh does not have.
      const cl = cs[Math.max(0, i - 1)], cr2 = cs[Math.min(gc - 1, i + 1)];
      const rd = rs[Math.max(0, j - 1)], ru = rs[Math.min(gr - 1, j + 1)];
      slopes[k * 2] = (at(cr2, r) - at(cl, r)) / ((cr2 - cl) * dxM || 1);
      // z runs SOUTH: a step up in r is a step in -z, so de/dz picks up a
      // minus sign relative to de/dr.
      slopes[k * 2 + 1] = (at(c, rd) - at(c, ru)) / ((ru - rd) * dyM || 1);
      const [u, v] = uv ? uv(c, r) : [c / (cols - 1), 1 - r / (rows - 1)];
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
    }
  }

  const quads = (gc - 1) * (gr - 1);
  const indices = new (gc * gr > 65535 ? Uint32Array : Uint16Array)(quads * 6);
  let n = 0;
  for (let j = 0; j < gr - 1; j++) {
    for (let i = 0; i < gc - 1; i++) {
      const a = j * gc + i, b = a + 1, c2 = a + gc, d = c2 + 1;
      indices[n++] = a; indices[n++] = c2; indices[n++] = b;
      indices[n++] = b; indices[n++] = c2; indices[n++] = d;
    }
  }

  return { positions, slopes, uvs, indices, gc, gr, stride, meanElev: mean };
}

/** Bilinear elevation lookup on the raw grid, for putting pins on the skin. */
export function elevAtCell(elev, cols, rows, fc, fr) {
  const c = Math.max(0, Math.min(cols - 2, Math.floor(fc)));
  const r = Math.max(0, Math.min(rows - 2, Math.floor(fr)));
  const tx = Math.max(0, Math.min(1, fc - c)), ty = Math.max(0, Math.min(1, fr - r));
  const z00 = elev[r * cols + c], z10 = elev[r * cols + c + 1];
  const z01 = elev[(r + 1) * cols + c], z11 = elev[(r + 1) * cols + c + 1];
  return z00 * (1 - tx) * (1 - ty) + z10 * tx * (1 - ty)
       + z01 * (1 - tx) * ty + z11 * tx * ty;
}

// ---- camera ---------------------------------------------------------------
// Column-major 4x4, the order WebGL reads. Only what the view needs: a
// perspective, a lookAt, a multiply, and the orbit that turns "facing
// north-east, tipped 55 degrees down, 400 metres out" into an eye.

export function mat4Perspective(fovYDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovYDeg * Math.PI / 360);
  const nf = 1 / (near - far);
  return new Float64Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

const norm3 = v => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function mat4LookAt(eye, target, up = [0, 1, 0]) {
  const f = norm3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const s = norm3(cross3(f, up));
  const u = cross3(s, f);
  return new Float64Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2],
    1,
  ]);
}

export function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Where the eye sits for an orbit: `yawDeg` is the compass bearing YOU FACE
 * (0 looks north, so the camera is south of the target), `pitchDeg` is how
 * far the view tips below level, `dist` the metres to the target.
 */
export function orbitEye(target, yawDeg, pitchDeg, dist) {
  const b = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
  const dh = dist * Math.cos(p);
  return [
    target[0] - Math.sin(b) * dh,
    target[1] + dist * Math.sin(p),
    target[2] + Math.cos(b) * dh,
  ];
}

/** The ground-plane basis for panning: which way is "right" and "ahead". */
export function orbitBasis(yawDeg) {
  const b = yawDeg * Math.PI / 180;
  return {
    rightX: Math.cos(b), rightZ: Math.sin(b),
    fwdX: Math.sin(b), fwdZ: -Math.cos(b),
  };
}

/**
 * A world point through the camera onto the screen, for the DOM pins that
 * ride the terrain. `visible` is false behind the eye or outside the frustum
 * with a margin, so a label does not pop off the instant its anchor grazes
 * the edge.
 */
export function projectPoint(mvp, x, y, z, W, H) {
  const w = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  if (!(w > 0)) return { x: 0, y: 0, depth: 1, visible: false };
  const nx = (mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12]) / w;
  const ny = (mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13]) / w;
  const nz = (mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14]) / w;
  return {
    x: (nx * 0.5 + 0.5) * W,
    y: (0.5 - ny * 0.5) * H,
    depth: nz,
    visible: nx > -1.15 && nx < 1.15 && ny > -1.15 && ny < 1.15 && nz < 1,
  };
}

/**
 * The same functions, as source, for the page — the pattern measure.mjs and
 * coverage.mjs set: one definition, emitted, and the tests compile this and
 * compare against the exports on the same inputs, so the mesh the browser
 * renders and the mesh the tests measured are the same object.
 */
export function browserSource(globalName = 'T3D') {
  const fns = {
    bytesToU16, dequantizeElev, fillElevHoles, sampledIndices, meshStride,
    buildTerrainMesh, elevAtCell, mat4Perspective, mat4LookAt, mat4Multiply,
    orbitEye, orbitBasis, projectPoint,
  };
  const body = [
    `const isNum = ${isNum.toString()};`,
    `const ELEV_HOLE = ${ELEV_HOLE};`,
    `const norm3 = ${norm3.toString()};`,
    `const cross3 = ${cross3.toString()};`,
    ...Object.entries(fns).map(([k, f]) => `const ${k} = ${f.toString()};`),
    `return { ${Object.keys(fns).join(', ')}, ELEV_HOLE };`,
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
