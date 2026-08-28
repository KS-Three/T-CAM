/**
 * The measure tool's arithmetic, checked against numbers that exist outside
 * this program: a survey section is a mile square and 640 acres by definition,
 * and a quarter-quarter is 40.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pathLength, ringArea, ringPerimeter, sayDistance, sayArea, measure,
  M2_PER_ACRE, M_PER_YARD,
} from '../measure.mjs';
import { distanceM } from '../db.mjs';

const R = 6371008.8;
const MILE_M = 1609.344;

/** A box whose sides are `metres` on the ground, centred on Kent's country. */
function box(metres, lat = 44.12, lng = -90.65) {
  const dLat = metres / (R * Math.PI / 180);
  const dLng = metres / (R * Math.cos(lat * Math.PI / 180) * Math.PI / 180);
  const s = lat - dLat / 2, n = lat + dLat / 2;
  const w = lng - dLng / 2, e = lng + dLng / 2;
  return [[w, s], [e, s], [e, n], [w, n]];
}

test('a section measures 640 acres', () => {
  const acres = ringArea(box(MILE_M)) / M2_PER_ACRE;
  assert.ok(Math.abs(acres - 640) < 1, `expected about 640 acres, got ${acres.toFixed(2)}`);
});

test('a quarter-quarter section measures 40 acres', () => {
  const acres = ringArea(box(MILE_M / 4)) / M2_PER_ACRE;
  assert.ok(Math.abs(acres - 40) < 0.1, `expected about 40 acres, got ${acres.toFixed(3)}`);
});

test('treating degrees as flat would err LARGE, by 1/cos(latitude)', () => {
  // The mistake this module exists to avoid, measured rather than asserted in
  // a comment. At 44 degrees north the naive figure is about 1.39x the truth,
  // so a ten-acre plot reads as fourteen.
  const ring = box(MILE_M / 4);
  const flat = (() => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      sum += x1 * y2 - x2 * y1;
    }
    // Degrees squared, scaled as though a degree were the same size both ways.
    return Math.abs(sum / 2) * (R * Math.PI / 180) ** 2;
  })();
  const ratio = flat / ringArea(ring);
  const expected = 1 / Math.cos(44.12 * Math.PI / 180);
  assert.ok(Math.abs(ratio - expected) < 0.01,
    `naive/true was ${ratio.toFixed(3)}, expected about ${expected.toFixed(3)}`);
  assert.ok(ratio > 1, 'and it errs large, not small');
});

test('which way round the ring was drawn does not change the acreage', () => {
  const ring = box(400);
  assert.equal(
    Math.round(ringArea(ring)),
    Math.round(ringArea([...ring].reverse())),
  );
});

test('repeating the first point to close the ring changes nothing', () => {
  const ring = box(400);
  assert.ok(Math.abs(ringArea(ring) - ringArea([...ring, ring[0]])) < 1);
});

test('a shape with fewer than three points has no area', () => {
  assert.equal(ringArea([]), 0);
  assert.equal(ringArea([[-90.65, 44.12]]), 0);
  assert.equal(ringArea([[-90.65, 44.12], [-90.64, 44.12]]), 0);
  assert.equal(measure([[-90.65, 44.12], [-90.64, 44.12]]).area, null);
});

test('path length agrees with the distance function it is built on', () => {
  const a = [-90.65, 44.12], b = [-90.64, 44.13], c = [-90.63, 44.12];
  const direct = distanceM(a[1], a[0], b[1], b[0]) + distanceM(b[1], b[0], c[1], c[0]);
  assert.ok(Math.abs(pathLength([a, b, c]) - direct) < 0.001);
  assert.equal(pathLength([a]), 0);
  assert.equal(pathLength([]), 0);
});

test('the perimeter includes the closing leg, the length does not', () => {
  const ring = box(400);
  const open = pathLength(ring);
  const closed = ringPerimeter(ring);
  assert.ok(closed > open, 'closing the shape adds a side');
  assert.ok(Math.abs(closed - 1600) < 2, `a 400 m box has a 1600 m perimeter, got ${closed}`);
});

test('distances are said the way they would be said out loud', () => {
  assert.equal(sayDistance(30 * M_PER_YARD), '90 ft (30 yd)');
  assert.equal(sayDistance(250 * M_PER_YARD), '250 yd');
  assert.match(sayDistance(3000 * M_PER_YARD), /^1\.70 mi/);
  assert.equal(sayDistance(null), null);
  assert.equal(sayDistance(NaN), null);
});

test('areas too small to be acres are given in square feet', () => {
  assert.match(sayArea(20), /sq ft$/);
  assert.equal(sayArea(2 * M2_PER_ACRE), '2.00 acres');
  assert.equal(sayArea(40 * M2_PER_ACRE), '40.0 acres');
  assert.equal(sayArea(NaN), null);
});

test('one drawn shape gives both readings at once', () => {
  const m = measure(box(MILE_M / 4));
  assert.equal(m.points, 4);
  assert.ok(Math.abs(m.acres - 40) < 0.1);
  assert.match(m.area, /acres/);
  assert.match(m.perimeter, /yd/);
  assert.ok(m.lengthM < m.perimeterM);
});

test('the copy the browser gets computes exactly what Node computes', async () => {
  // The guarantee that makes it safe to run this arithmetic in two places: the
  // page's copy is generated from these same functions, and compiled and
  // compared here on real shapes rather than assumed equivalent.
  const vm = await import('node:vm');
  const { browserSource } = await import('../measure.mjs');
  const ctx = vm.createContext({});
  new vm.Script(browserSource('M') + '\nM;').runInContext(ctx);
  const browser = vm.runInContext('M', ctx);

  const shapes = [
    box(MILE_M),
    box(MILE_M / 4),
    [[-90.65, 44.12], [-90.6488, 44.1219], [-90.6455, 44.1201]],
    [[-90.65, 44.12], [-90.6488, 44.1219]],
    [[-90.65, 44.12]],
    [],
  ];
  for (const s of shapes) {
    // Spread into plain local objects first: the vm's results carry that
    // realm's Object prototype, which a strict deep comparison rejects even
    // when every value matches.
    assert.deepStrictEqual({ ...browser.measure(s) }, { ...measure(s) }, JSON.stringify(s));
  }
  assert.equal(browser.sayDistance(250 * M_PER_YARD), sayDistance(250 * M_PER_YARD));
  assert.equal(browser.sayArea(40 * M2_PER_ACRE), sayArea(40 * M2_PER_ACRE));
});
