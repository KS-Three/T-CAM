/**
 * measure.mjs — how far is that, and how big is this.
 *
 * The two questions a map gets asked constantly while planning: how far is the
 * walk from the truck to the stand, and how many acres is that food plot, that
 * bedding thicket, that piece of the neighbour's corn. Both are answers this
 * program already had all the inputs for and could not produce.
 *
 * Units are American on purpose, because the answers get used in American
 * conversations: yards for a shot, feet for anything close, acres for ground.
 * The metric figure travels alongside rather than instead, since every other
 * distance in this program is in metres and two units that disagree would be
 * worse than either.
 *
 * On area: the shoelace formula on latitude and longitude treated as flat
 * coordinates goes wrong by the cosine of the latitude, because a degree of
 * longitude is shorter on the ground than a degree of latitude everywhere but
 * the equator. At Kent's 44° N that is a factor of 1/cos(44°), about 1.39, and
 * it errs LARGE: a ten-acre plot would measure fourteen. So area is computed on
 * the sphere with the standard spherical-excess formula, and the tests check it
 * against a shape whose acreage is known independently — a survey section,
 * which is a mile square and 640 acres by definition.
 */

import { distanceM } from './db.mjs';

const R = 6371008.8;            // mean Earth radius, metres (WGS84 mean)
const rad = d => d * Math.PI / 180;

export const M_PER_YARD = 0.9144;
export const M_PER_FOOT = 0.3048;
export const M2_PER_ACRE = 4046.8564224;

/** Total length along a path of [lng, lat] points, in metres. */
export function pathLength(points = []) {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    m += distanceM(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0]);
  }
  return m;
}

/**
 * Area of a closed ring of [lng, lat] points, in square metres.
 *
 * Spherical excess. The ring is closed implicitly — the caller does not have to
 * repeat the first point, and repeating it changes nothing.
 *
 * Sign is discarded: a ring drawn clockwise and the same ring drawn
 * anticlockwise enclose the same ground, and returning a negative acreage for
 * one of them would be a bug report waiting to happen.
 */
export function ringArea(points = []) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [lng1, lat1] = points[i];
    const [lng2, lat2] = points[(i + 1) % points.length];
    sum += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs(sum * R * R / 2);
}

/** Perimeter of a closed ring, in metres — the path plus the closing leg. */
export function ringPerimeter(points = []) {
  if (points.length < 2) return 0;
  return pathLength([...points, points[0]]);
}

/**
 * A distance, said the way it would be said out loud.
 *
 * Under a hundred yards is a shot and gets feet; past that, yards; past a mile,
 * miles. Nobody says "eleven hundred and forty yards".
 */
export function sayDistance(metres) {
  if (!Number.isFinite(metres)) return null;
  const yd = metres / M_PER_YARD;
  const ft = metres / M_PER_FOOT;
  if (yd < 100) return `${Math.round(ft)} ft (${Math.round(yd)} yd)`;
  if (yd < 1760) return `${Math.round(yd)} yd`;
  return `${(yd / 1760).toFixed(2)} mi (${Math.round(yd)} yd)`;
}

/**
 * An area, said the same way.
 *
 * Acres below a tenth of one are meaningless on a hand-drawn shape, so those
 * are given in square feet instead — a ground blind's footprint, a waterhole.
 */
export function sayArea(m2) {
  if (!Number.isFinite(m2)) return null;
  const acres = m2 / M2_PER_ACRE;
  if (acres < 0.1) return `${Math.round(m2 / (M_PER_FOOT * M_PER_FOOT))} sq ft`;
  if (acres < 10) return `${acres.toFixed(2)} acres`;
  return `${acres.toFixed(1)} acres`;
}

/** Both readings for one drawn shape, with the metric figures kept alongside. */
export function measure(points = []) {
  const line = pathLength(points);
  const closed = points.length >= 3;
  return {
    points: points.length,
    lengthM: line,
    length: sayDistance(line),
    // A shape only has an area once it encloses something.
    areaM2: closed ? ringArea(points) : null,
    area: closed ? sayArea(ringArea(points)) : null,
    perimeterM: closed ? ringPerimeter(points) : null,
    perimeter: closed ? sayDistance(ringPerimeter(points)) : null,
    acres: closed ? ringArea(points) / M2_PER_ACRE : null,
  };
}

/**
 * The same functions, as source, for the map to use in the browser.
 *
 * The map has to measure while you drag points around, which means this
 * arithmetic has to exist client-side. Writing it twice is how the page and the
 * tests end up disagreeing about the acreage of the same shape — so there is
 * one definition, and it is emitted from the functions themselves rather than
 * copied. test/measure.test.js compiles what comes out of here and checks it
 * against the Node functions on the same shapes, so drift is not possible.
 *
 * Interpolating this into the page (rather than typing it there) also sidesteps
 * the template-literal trap: an interpolated VALUE is inserted at runtime and
 * is never parsed as part of the surrounding literal, so the backticks and
 * escapes inside these functions arrive intact.
 */
export function browserSource(globalName = 'MEASURE') {
  const consts = { R, M_PER_YARD, M_PER_FOOT, M2_PER_ACRE };
  const fns = { rad, distanceM, pathLength, ringArea, ringPerimeter, sayDistance, sayArea, measure };
  const body = [
    ...Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`),
    ...Object.entries(fns).map(([k, f]) => `const ${k} = ${f.toString()};`),
    // The unit constants cross as well as the functions. The map has to turn a
    // number of yards typed into a lane's reach box into metres, which is what
    // everything downstream measures in, and a second 0.9144 written on the
    // page is how the distance you typed stops being the distance you get.
    `return { ${Object.keys(fns).join(', ')}, M_PER_YARD, M_PER_FOOT, M2_PER_ACRE };`,
  ].join('\n');
  return `const ${globalName} = (function () {\n${body}\n})();`;
}
