import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitCsvLine, detectRoles, inspectCsv, rowTime, loadMovement,
  byHour, byBucket, studyCentre, dateRange,
} from '../collar.mjs';

const tmpFile = (name, text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-collar-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
};

/**
 * A stand-in in the shape the real dataset documents: 30-minute fixes, sexes,
 * coordinates. Movement carries a strong DAWN AND DUSK pattern plus a planted
 * cold-weather effect, so the analysis can be checked against an answer that
 * is known rather than against itself.
 */
function fixture({ coldFactor = 1.4, days = 40, deer = 8 } = {}) {
  const rows = ['AnimalID,Sex,Timestamp,Latitude,Longitude,MoveRate,TempC'];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let d0 = 0; d0 < deer; d0++) {
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const t = new Date(Date.UTC(2015, 9, 1 + d, h, 0, 0));
        const dawn = Math.exp(-((h - 6.5) ** 2) / 2.2);
        const dusk = Math.exp(-((h - 18) ** 2) / 2.2);
        const temp = 12 - 14 * Math.cos((d / days) * Math.PI * 2) + rnd() * 8;
        const cold = temp < 5 ? coldFactor : 1;
        const rate = Math.max(0, (12 + 150 * (dawn + dusk)) * cold * (0.8 + rnd() * 0.4));
        rows.push(['D' + d0, d0 % 2 ? 'F' : 'M', t.toISOString(),
          (33.8 + rnd() * 0.02).toFixed(5), (-81.2 + rnd() * 0.02).toFixed(5),
          rate.toFixed(1), temp.toFixed(1)].join(','));
      }
    }
  }
  return tmpFile('RateofMovementData.csv', rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

test('CSV lines split, including quoted fields with commas', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitCsvLine('a,"say ""hi""",b'), ['a', 'say "hi"', 'b']);
  assert.deepEqual(splitCsvLine('a, b , c'), ['a', 'b', 'c'], 'and whitespace is trimmed');
});

test('columns are matched to roles by name', () => {
  const { roles } = detectRoles(
    ['AnimalID', 'Sex', 'Timestamp', 'Latitude', 'Longitude', 'MoveRate', 'TempC']);
  assert.equal(roles.animal, 'AnimalID');
  assert.equal(roles.sex, 'Sex');
  assert.equal(roles.timestamp, 'Timestamp');
  assert.equal(roles.lat, 'Latitude');
  assert.equal(roles.lng, 'Longitude');
  assert.equal(roles.rate, 'MoveRate');
  assert.equal(roles.temp, 'TempC');
});

test('other authors\' naming still lands in the right roles', () => {
  // Published ecology CSVs name their columns however the authors felt that
  // week, which is why the schema is detected and then REPORTED rather than
  // assumed.
  const { roles } = detectRoles(['deer_id', 'step_length', 'date_time', 'sex']);
  assert.equal(roles.animal, 'deer_id');
  assert.equal(roles.rate, 'step_length');
  assert.equal(roles.timestamp, 'date_time');
});

test('inspecting a file says what it found and what it is missing', async () => {
  const f = fixture({ days: 2, deer: 1 });
  const info = await inspectCsv(f);
  assert.equal(info.columns.length, 7);
  assert.equal(info.roles.rate, 'MoveRate');
  assert.deepEqual(info.missing, []);
  assert.equal(info.sampleRows.length, 3);
  assert.equal(info.canTimestamp, true);

  const bare = tmpFile('bare.csv', 'foo,bar\n1,2\n');
  const b = await inspectCsv(bare);
  assert.deepEqual(b.missing, ['rate'], 'a file with no movement column says so');
});

test('a file with no rate column refuses to load rather than guessing', async () => {
  const bare = tmpFile('bare.csv', 'foo,bar\n1,2\n');
  await assert.rejects(() => loadMovement(bare), /no movement-rate column/);
});

test('timestamps parse from a single column or from date plus hour', () => {
  assert.equal(rowTime({ t: '2015-10-01T06:30:00Z' }, { timestamp: 't' }).getUTCHours(), 6);
  const split = rowTime({ d: '2015-10-01', h: '18' }, { date: 'd', hour: 'h' });
  assert.equal(split.getUTCHours(), 18);
  assert.equal(rowTime({ d: 'not a date' }, { date: 'd' }), null);
  assert.equal(rowTime({}, { timestamp: 't' }), null, 'and a missing time is null, not now');
});

test('rows without a usable rate or time are counted, not silently dropped', async () => {
  const f = tmpFile('mixed.csv', [
    'AnimalID,Timestamp,MoveRate',
    'D1,2015-10-01T06:00:00Z,42',
    'D1,2015-10-01T07:00:00Z,',          // blank rate: unknown, NOT zero
    'D1,,19',                            // no time
    'D1,2015-10-01T08:00:00Z,-5',        // negative distance is not a rate
    'D1,2015-10-01T09:00:00Z,17',
  ].join('\n'));
  const { records, total, skipped } = await loadMovement(f);
  assert.equal(total, 5);
  assert.equal(records.length, 2, 'only the two rows with both a rate and a time');
  assert.equal(skipped, 3, 'a file that is mostly unusable can say so');
});

// ---------------------------------------------------------------------------
// What the data says
// ---------------------------------------------------------------------------

test('the dawn and dusk peaks come back out', async () => {
  const { records } = await loadMovement(fixture());
  const h = byHour(records);
  assert.ok(h.hours[6].ratio > 3, `dawn is busy (${h.hours[6].ratio}x)`);
  assert.ok(h.hours[18].ratio > 3, `and so is dusk (${h.hours[18].ratio}x)`);
  assert.ok(h.hours[12].ratio < 1, 'midday is not');
  assert.ok(h.hours[2].ratio < 1, 'nor the small hours');
  // Reported as a ratio because the absolute rate depends on their fix interval
  // and ground, and does not transfer. The shape does.
  assert.ok(h.base > 0);
});

/**
 * A day where temperature tracks the CLOCK — coldest near dawn, warmest
 * mid-afternoon, as it is everywhere — and where movement depends on the hour
 * ALONE. There is no temperature effect in this data at all.
 */
function diurnalFixture({ days = 40, deer = 8 } = {}) {
  const rows = ['AnimalID,Timestamp,MoveRate,TempC'];
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let d0 = 0; d0 < deer; d0++) {
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const t = new Date(Date.UTC(2015, 9, 1 + d, h, 0, 0));
        const dawn = Math.exp(-((h - 6.5) ** 2) / 2.2);
        const dusk = Math.exp(-((h - 18) ** 2) / 2.2);
        // Coldest at 05:00, warmest at 15:00 — the correlation that does the damage.
        const temp = 14 - 9 * Math.cos((h - 15) / 24 * 2 * Math.PI) + rnd() * 2;
        const rate = Math.max(0, (12 + 150 * (dawn + dusk)) * (0.85 + rnd() * 0.3));
        rows.push(['D' + d0, t.toISOString(), rate.toFixed(1), temp.toFixed(1)].join(','));
      }
    }
  }
  return tmpFile('diurnal.csv', rows.join('\n'));
}

test('a temperature effect that does not exist is NOT invented', async () => {
  // The bug this pins, and it is the dangerous direction: it invents a
  // relationship rather than hiding one.
  //
  // Temperature correlates with the hour — coldest near dawn, warmest
  // mid-afternoon. Bucket raw movement by temperature and the cold buckets fill
  // with dawn fixes and the warm ones with midday fixes, so the diurnal cycle
  // comes out wearing a thermometer's clothes. This data has NO temperature
  // effect whatsoever; the naive reading finds a large one anyway.
  const { records } = await loadMovement(diurnalFixture());
  const edges = [0, 10, 18, 40];

  const naive = byBucket(records, r => r.temp, edges, { controlForHour: false });
  const naiveSpread = Math.max(...naive.buckets.map(b => b.ratio))
                    / Math.min(...naive.buckets.map(b => b.ratio));
  assert.ok(naiveSpread > 1.2,
    `uncontrolled, a nonexistent effect shows up as ${naiveSpread.toFixed(2)}x`);

  const fixed = byBucket(records, r => r.temp, edges);
  assert.equal(fixed.controlledForHour, true);
  const fixedSpread = Math.max(...fixed.buckets.map(b => b.ratio))
                    / Math.min(...fixed.buckets.map(b => b.ratio));
  assert.ok(fixedSpread < 1.15,
    `controlled for hour, it correctly finds almost nothing (${fixedSpread.toFixed(2)}x)`);
  assert.ok(fixedSpread < naiveSpread, 'and is strictly better than the naive reading');
});

test('a REAL weather effect still comes through once the hour is controlled for', async () => {
  // The other half: the control must not be so aggressive that it erases an
  // effect that is genuinely there.
  const { records } = await loadMovement(fixture({ coldFactor: 1.4 }));
  const fixed = byBucket(records, r => r.temp, [-20, 5, 15, 45]);
  const cold = fixed.buckets[0].ratio, warm = fixed.buckets.at(-1).ratio;
  assert.ok(cold / warm > 1.25 && cold / warm < 1.6,
    `the planted 1.4x is recovered as ${(cold / warm).toFixed(2)}x`);
});

test('buckets report how many rows are behind each number', async () => {
  const { records } = await loadMovement(fixture());
  const b = byBucket(records, r => r.temp, [-20, 5, 15, 45]);
  for (const x of b.buckets) {
    assert.ok(x.n > 0 && Number.isFinite(x.ratio), 'a ratio with no n is not evidence');
  }
  const none = byBucket(records, () => NaN, [-20, 5, 45]);
  assert.equal(none.unusable, records.length, 'and unusable rows are counted');
});

test('the study centre is rounded, and the date range reported', async () => {
  const { records } = await loadMovement(fixture({ days: 5, deer: 2 }));
  const c = studyCentre(records);
  // Rounded hard on purpose: the analysis needs the weather over the study
  // area, and nothing here needs a precise animal position.
  assert.equal(c.lat, Math.round(c.lat * 10) / 10);
  assert.equal(c.lng, Math.round(c.lng * 10) / 10);
  assert.ok(c.n > 0);

  const r = dateRange(records);
  assert.match(r.from, /^2015-10-01$/);
  assert.ok(r.to >= r.from);
});

test('with no coordinates there is no study centre, rather than a made-up one', async () => {
  const f = tmpFile('nocoords.csv',
    'AnimalID,Timestamp,MoveRate\nD1,2015-10-01T06:00:00Z,42\nD1,2015-10-01T07:00:00Z,17');
  const { records } = await loadMovement(f);
  assert.equal(studyCentre(records), null);
});
