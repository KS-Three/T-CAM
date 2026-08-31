import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  harvestState, toGrid, bestShiftRmse, classify, averageCurves,
  referenceFields, CUT_LEVEL, MIN_REFERENCE_FIELDS, QUERY_BUDGET, STALE_DAYS,
} from '../cropseason.mjs';
import { cropHistory, rotationPrior } from '../cropscan.mjs';

const LAT = 44.12, LNG = -90.65;
const square = [[LNG - 0.001, LAT - 0.001], [LNG + 0.001, LAT - 0.001],
  [LNG + 0.001, LAT + 0.001], [LNG - 0.001, LAT + 0.001]];

const day = (n) => new Date(Date.UTC(2026, 3, 1) + n * 86400000)
  .toISOString().slice(0, 10);

/** A season of readings from [dayOffset, ndvi] pairs. */
const series = (pairs) => pairs.map(([d, ndvi]) => ({
  date: day(d), ndvi, clear: ndvi === null ? 0 : 50, pixels: 50,
}));

/** A phenology bump peaking on a given day of the season. */
function bump(peakDay, { amp = 0.75, width = 38, floor = 0.15, every = 7, span = 180 } = {}) {
  const out = [];
  for (let d = 0; d <= span; d += every) {
    out.push([d, floor + amp * Math.exp(-0.5 * ((d - peakDay) / width) ** 2)]);
  }
  return series(out);
}

// ---------------------------------------------------------------------------
// standing or cut

test('a field still near its peak is standing', () => {
  const s = harvestState(series([[0, 0.2], [30, 0.6], [60, 0.88], [90, 0.86]]));
  assert.equal(s.state, 'standing');
  assert.match(s.why, /0\.86/);
});

test('a fast fall to bare ground is a harvest', () => {
  const s = harvestState(series([[0, 0.2], [40, 0.85], [80, 0.82], [87, 0.22]]));
  assert.equal(s.state, 'cut');
  assert.equal(s.since, day(87));
  assert.match(s.why, /7 days/);
});

test('the same fall seen across a cloudy gap is not claimed as a harvest', () => {
  // Identical start and end, but the looks are three weeks apart, so a
  // drydown and a combine are genuinely indistinguishable.
  const s = harvestState(series([[0, 0.2], [40, 0.85], [60, 0.82], [90, 0.22]]));
  assert.equal(s.state, 'cut-or-senesced');
  assert.match(s.why, /30 days apart/);
  assert.match(s.why, /cannot be told apart/);
});

test('a field past its peak but not bare is senescing', () => {
  const s = harvestState(series([[0, 0.2], [40, 0.90], [80, 0.75], [95, 0.52]]));
  assert.equal(s.state, 'senescing');
  assert.ok(s.latest < s.peak);
});

test('too few looks is unknown, not a guess', () => {
  const s = harvestState(series([[0, 0.2], [40, 0.85]]));
  assert.equal(s.state, 'unknown');
  assert.match(s.why, /only 2 cloud-free looks/);
});

test('ground that never greened has no crop to lose', () => {
  const s = harvestState(series([[0, 0.18], [40, 0.24], [80, 0.21], [95, 0.19]]));
  assert.equal(s.state, 'unknown');
  assert.match(s.why, /never got green/);
});

test('cloudy readings are ignored rather than treated as zero', () => {
  const s = harvestState(series([[0, 0.2], [40, 0.85], [55, null], [80, 0.82], [87, 0.22]]));
  assert.equal(s.state, 'cut', 'a null in the middle did not read as a crash');
});

test('a fall that stops above bare ground is not a harvest', () => {
  const s = harvestState(series([[0, 0.2], [40, 0.90], [80, 0.88], [87, 0.62]]));
  assert.notEqual(s.state, 'cut');
  assert.ok(s.latest > CUT_LEVEL);
});

// ---------------------------------------------------------------------------
// curve handling

test('a curve is resampled onto an even grid', () => {
  const g = toGrid(series([[0, 0.2], [8, 0.4], [16, 0.6]]), 4);
  assert.equal(g.t0, day(0));
  assert.equal(g.values.length, 5);
  assert.ok(Math.abs(g.values[0] - 0.2) < 1e-9);
  assert.ok(Math.abs(g.values[2] - 0.4) < 1e-9);
  assert.ok(Math.abs(g.values[1] - 0.3) < 1e-9, 'interpolated between looks');
});

test('a curve with too few looks has no grid', () => {
  assert.equal(toGrid(series([[0, 0.2], [8, 0.4]])), null);
});

test('averaging curves takes the median and survives gaps', () => {
  const avg = averageCurves([[0.1, 0.5, NaN], [0.2, 0.6, 0.9], [0.3, 0.7, NaN]]);
  assert.ok(Math.abs(avg[0] - 0.2) < 1e-9);
  assert.ok(Math.abs(avg[1] - 0.6) < 1e-9);
  assert.ok(Math.abs(avg[2] - 0.9) < 1e-9, 'one good value still counts');
});

/**
 * The bug this is named for. Corn and soybean phenology are about four weeks
 * apart. Allowing the alignment to shift that far lets the corn curve slide
 * onto the soybean one, and the difference being measured disappears.
 */
test('the alignment window stays inside the corn/soybean gap', () => {
  const corn = toGrid(bump(75)).values;      // peaks earlier
  const soy = toGrid(bump(105)).values;      // peaks about a month later

  const wide = bestShiftRmse(soy, corn, { maxShift: 24, penalty: 0 });
  const narrow = bestShiftRmse(soy, corn, { maxShift: 12, penalty: 0 });

  assert.ok(wide.rmse < narrow.rmse / 2,
    `a wide window collapses the difference: ${wide.rmse.toFixed(3)} vs ${narrow.rmse.toFixed(3)}`);
  assert.ok(narrow.rmse > 0.05,
    `a narrow window preserves it: ${narrow.rmse.toFixed(3)}`);
});

test('a curve matched against itself is a perfect fit at zero shift', () => {
  const c = toGrid(bump(90)).values;
  const { rmse, shift } = bestShiftRmse(c, c);
  assert.ok(rmse < 1e-9, `rmse ${rmse}`);
  assert.equal(shift, 0);
});

test('curves that never overlap report no fit', () => {
  const { rmse } = bestShiftRmse([1, 2, 3], [NaN, NaN, NaN]);
  assert.equal(Number.isFinite(rmse), false);
});

// ---------------------------------------------------------------------------
// classification

const REFS = () => ({ corn: toGrid(bump(75)).values, soybeans: toGrid(bump(105)).values });

test('a corn-shaped season is called corn', () => {
  const r = classify(bump(75), REFS());
  assert.equal(r.verdict, 'corn');
  assert.equal(r.ranked[0].crop, 'corn');
});

test('a soybean-shaped season is called soybeans', () => {
  const r = classify(bump(105), REFS());
  assert.equal(r.verdict, 'soybeans');
});

test('a clear curve overrules a confident rotation prior', () => {
  const prior = [{ crop: 'corn', p: 0.95 }, { crop: 'soybeans', p: 0.05 }];
  const r = classify(bump(105), REFS(), prior);
  assert.equal(r.verdict, 'soybeans',
    `the imagery must win when it is unambiguous (got ${JSON.stringify(r.ranked)})`);
});

test('the rotation prior still decides an ambiguous curve', () => {
  const prior = [{ crop: 'corn', p: 0.95 }, { crop: 'soybeans', p: 0.05 }];
  const r = classify(bump(90), REFS(), prior);   // halfway between the two
  assert.equal(r.verdict, 'corn');
});

test('a near tie is refused rather than called', () => {
  const r = classify(bump(90), REFS());
  assert.equal(r.verdict, null);
  assert.match(r.why, /too close to call/);
  assert.equal(r.ranked.length, 2, 'the ranking is still reported');
});

test('a curve matching nothing nearby is refused', () => {
  // A flat season resembles neither reference.
  const flat = series(Array.from({ length: 26 }, (_, i) => [i * 7, 0.5]));
  const r = classify(flat, REFS());
  assert.equal(r.verdict, null);
  assert.match(r.why, /too close to call|matches this curve/);
});

test('classification without reference curves refuses', () => {
  const r = classify(bump(105), { corn: toGrid(bump(75)).values });
  assert.equal(r.verdict, null);
  assert.match(r.why, /no local reference curves/);
});

test('classification without enough looks refuses', () => {
  const r = classify(series([[0, 0.2], [8, 0.4]]), REFS());
  assert.equal(r.verdict, null);
  assert.match(r.why, /not enough cloud-free looks/);
});

// ---------------------------------------------------------------------------
// reference search

/** A stub CropScape that answers from a map of category by grid cell. */
async function fakeCdl(categoryFor) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ x: Number(u.searchParams.get('x')), y: Number(u.searchParams.get('y')) });
    const category = categoryFor(calls.length - 1);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<Result>{value: 1, category: "${category}"}</Result>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_CDL_URL = `http://127.0.0.1:${server.address().port}/q`;
  return { server, calls };
}

test('reference fields are found when both crops are about', async t => {
  const { server, calls } = await fakeCdl(i => (i % 2 ? 'Corn' : 'Soybeans'));
  t.after(() => { server.close(); delete process.env.TRAILCAM_CDL_URL; });

  const refs = await referenceFields(square, { year: 2025 });
  assert.equal(refs.enough, true);
  assert.ok(refs.corn.length >= MIN_REFERENCE_FIELDS, `corn ${refs.corn.length}`);
  assert.ok(refs.soybeans.length >= MIN_REFERENCE_FIELDS, `soy ${refs.soybeans.length}`);
  assert.ok(calls.length <= QUERY_BUDGET, `stayed within budget: ${calls.length}`);
  assert.equal(refs.radius, 2000, 'the nearest radius sufficed, so it stopped there');
});

test('a wetland neighbourhood is refused, not extrapolated', async t => {
  // Kent's actual ground: mostly wetland and woods, one soybean point in 25.
  const { server, calls } = await fakeCdl(i =>
    (i === 3 ? 'Soybeans' : i % 5 === 0 ? 'Corn' : 'Woody Wetlands'));
  t.after(() => { server.close(); delete process.env.TRAILCAM_CDL_URL; });

  const refs = await referenceFields(square, { year: 2025 });
  assert.equal(refs.enough, false, 'one soybean field is not a reference set');
  assert.ok(refs.soybeans.length < MIN_REFERENCE_FIELDS);
  assert.ok(calls.length <= QUERY_BUDGET, `budget held: ${calls.length}`);
  assert.equal(refs.radius, 10000, 'it widened all the way before giving up');
});

test('the query budget is never exceeded, however empty the ground', async t => {
  const { server, calls } = await fakeCdl(() => 'Woody Wetlands');
  t.after(() => { server.close(); delete process.env.TRAILCAM_CDL_URL; });

  const refs = await referenceFields(square, { year: 2025, budget: 20 });
  assert.equal(refs.enough, false);
  assert.ok(calls.length <= 20, `asked ${calls.length} times against a budget of 20`);
});

test('a CropScape that refuses everything degrades to no references', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('<faultstring>Error: Failed to get value.</faultstring>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_CDL_URL = `http://127.0.0.1:${server.address().port}/q`;
  t.after(() => { server.close(); delete process.env.TRAILCAM_CDL_URL; });

  const refs = await referenceFields(square, { year: 2025, budget: 10 });
  assert.equal(refs.enough, false);
  assert.equal(refs.corn.length, 0);
});

// ---------------------------------------------------------------------------
// rotation

const hist = (...crops) => crops.map((crop, i) => ({
  year: 2020 + i, crop, category: crop, code: 0,
}));

test('a strict corn/soybean alternation predicts the other one', () => {
  const p = rotationPrior(hist('corn', 'soybeans', 'corn', 'soybeans', 'corn', 'soybeans'), 2026);
  assert.equal(p[0].crop, 'corn');
  const total = p.reduce((a, b) => a + b.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'probabilities are normalised');
});

test('the mirrored rotation predicts the mirrored crop', () => {
  const p = rotationPrior(hist('soybeans', 'corn', 'soybeans', 'corn', 'soybeans', 'corn'), 2026);
  assert.equal(p[0].crop, 'soybeans');
});

test('perennial cover is expected to stay put', () => {
  const p = rotationPrior(hist('alfalfa', 'alfalfa', 'alfalfa', 'alfalfa'), 2026);
  assert.equal(p[0].crop, 'alfalfa');
  assert.ok(p[0].p > 0.6);
});

test('no history means no prior, not a default guess', () => {
  assert.deepEqual(rotationPrior([], 2026), []);
  assert.deepEqual(rotationPrior([{ year: 2025, crop: null }], 2026), []);
});

test('history is read one year at a time and skips gaps', async t => {
  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'text/xml' });
    // Every third year is unavailable.
    if (n % 3 === 0) return res.end('<faultstring>no data</faultstring>');
    res.end(`<Result>{value: 1, category: "${n % 2 ? 'Corn' : 'Soybeans'}"}</Result>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.TRAILCAM_CDL_URL = `http://127.0.0.1:${server.address().port}/q`;
  t.after(() => { server.close(); delete process.env.TRAILCAM_CDL_URL; });

  const h = await cropHistory(LAT, LNG, { years: 6, now: new Date('2026-08-31') });
  assert.ok(h.length < 6, 'the refused years were dropped');
  assert.ok(h.length >= 3, `but the rest survived: ${h.length}`);
  assert.deepEqual(h.map(r => r.year), [...h.map(r => r.year)].sort(), 'oldest first');
});

// ---------------------------------------------------------------------------
// how old the answer is

test('an answer says how stale it is when cloud has hidden the field', () => {
  // Kent's own ground, 2026-08-31: the last three passes were all clouded out,
  // so the newest clear look was two weeks old. "Standing" then describes a
  // fortnight ago, and a field can come off in a morning.
  const s = harvestState(
    series([[0, 0.2], [40, 0.85], [80, 0.88], [100, 0.87]]),
    { now: new Date(Date.parse(day(100)) + 16 * 86400000) });

  assert.equal(s.state, 'standing');
  assert.equal(s.staleDays, 16);
  assert.equal(s.latestDate, day(100));
  assert.match(s.why, /16 days ago/);
  assert.match(s.why, /then rather than now/);
});

test('a fresh answer does not clutter itself with its own age', () => {
  const s = harvestState(
    series([[0, 0.2], [40, 0.85], [80, 0.88], [100, 0.87]]),
    { now: new Date(Date.parse(day(100)) + 2 * 86400000) });

  assert.equal(s.staleDays, 2);
  assert.ok(s.staleDays < STALE_DAYS);
  assert.doesNotMatch(s.why, /days ago/);
});

test('a harvest date is reported with its own age too', () => {
  const s = harvestState(
    series([[0, 0.2], [40, 0.85], [80, 0.82], [87, 0.22]]),
    { now: new Date(Date.parse(day(87)) + 30 * 86400000) });

  assert.equal(s.state, 'cut');
  assert.equal(s.since, day(87));
  assert.equal(s.staleDays, 30, 'a cut stays cut, but the reader still sees the age');
});
