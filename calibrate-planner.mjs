#!/usr/bin/env node
/**
 * calibrate-planner.mjs — measure what the planner currently guesses.
 *
 *   node --disable-warning=ExperimentalWarning calibrate-planner.mjs --inspect
 *   node --disable-warning=ExperimentalWarning calibrate-planner.mjs
 *   node ... calibrate-planner.mjs --file collar-data/RateofMovementData.csv --rate "MoveRate"
 *
 * Run --inspect FIRST on a newly downloaded file. It prints the columns and
 * which ones it thinks are what; if it has guessed wrong, name the right one
 * with --rate and friends rather than letting it analyse the wrong column.
 *
 * This REPORTS and stops. It does not edit hunt-planner.mjs, and that is
 * deliberate: the reference data is 111 deer in South Carolina, and quietly
 * rewriting what the tool recommends for Wisconsin on the strength of another
 * state's animals is not a script's decision to make.
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { inspectCsv, loadMovement, byHour, byBucket, studyCentre, dateRange } from './collar.mjs';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const DEFAULT_DIR = 'collar-data';
const file = val('--file', null) ?? (() => {
  if (!fs.existsSync(DEFAULT_DIR)) return null;
  const csv = fs.readdirSync(DEFAULT_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  return csv.length ? path.join(DEFAULT_DIR, csv[0]) : null;
})();

if (!file || !fs.existsSync(file)) {
  console.log(`
No collar data found.

  Expected a .csv in ${DEFAULT_DIR}/ , or pass --file <path>.

  See ${DEFAULT_DIR}/README.md for what to download and why. In short:
  https://doi.org/10.5061/dryad.fttdz08wj  ->  RateofMovementData.csv
`);
  process.exitCode = 1;
} else {
  const info = await inspectCsv(file);
  console.log(`\n${path.basename(file)}  (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)\n`);
  console.log('Columns found:');
  for (const c of info.columns) {
    const role = Object.entries(info.roles).find(([, name]) => name === c)?.[0];
    console.log(`  ${c.padEnd(28)} ${role ? '-> ' + role : ''}`);
  }
  if (info.missing.length) {
    console.log(`\n  Could not find: ${info.missing.join(', ')}`);
    console.log('  Name it by hand, e.g.  --rate "<the movement column>"');
  }

  if (has('--inspect')) {
    console.log('\nFirst rows:');
    for (const r of info.sampleRows) console.log('  ' + JSON.stringify(r).slice(0, 220));
    console.log('');
  } else {
    const roles = { ...info.roles };
    for (const k of ['rate', 'timestamp', 'date', 'hour', 'sex', 'lat', 'lng', 'temp']) {
      const given = val('--' + k, null);
      if (given) roles[k] = given;
    }
    if (!roles.rate) {
      console.log('\nCannot analyse without a movement-rate column. Stopping.\n');
      process.exitCode = 1;
    } else {
      const limit = Number(val('--limit', '0')) || Infinity;
      console.log('\nReading…');
      const { records, total, skipped } = await loadMovement(file, { roles, limit });
      const range = dateRange(records);
      const centre = studyCentre(records);
      console.log(`  ${records.length.toLocaleString()} usable of ${total.toLocaleString()} rows`
        + (skipped ? `  (${skipped.toLocaleString()} had no rate or no time)` : ''));
      if (range) console.log(`  ${range.from} to ${range.to}`);
      if (centre) console.log(`  study area near ${centre.lat}, ${centre.lng}`);

      const hours = byHour(records);
      if (hours) {
        console.log(`\nMovement by hour, as a multiple of the daily median`);
        console.log(`(a ratio, not metres — the absolute rate depends on their fix`);
        console.log(` interval and ground and does not transfer; the shape does)\n`);
        const peak = Math.max(...hours.hours.map(h => h.ratio ?? 0));
        for (const h of hours.hours) {
          if (h.ratio === null) continue;
          const bar = '#'.repeat(Math.round(24 * h.ratio / peak));
          console.log(`  ${String(h.hour).padStart(2, '0')}:00  ${h.ratio.toFixed(2)}x  ${bar}`);
        }
      }

      if (roles.temp) {
        const t = byBucket(records, r => r.temp, [-20, 0, 5, 10, 15, 20, 25, 30, 45]);
        if (t) {
          console.log('\nMovement against temperature (study units, as recorded):\n');
          for (const b of t.buckets) {
            if (!b.n) continue;
            console.log(`  ${String(b.lo).padStart(4)} to ${String(b.hi).padStart(4)}   `
              + `${b.ratio.toFixed(2)}x   n=${b.n.toLocaleString()}`);
          }
        }
      } else {
        console.log('\nNo temperature column in this file.');
        console.log('  The weather join is the next step: fetch the archive for the study');
        console.log('  area and date range above, and bucket movement against it.');
      }

      console.log(`
What this is worth, stated plainly:

  These are South Carolina deer, 2009-2018. The hour-of-day shape above is
  real and transfers — deer move at first and last light everywhere. A
  temperature or pressure response would transfer as a SHAPE too.

  The rut calendar does NOT transfer and is not touched here. Carolina deer
  rut on dates unrelated to Wisconsin's, so any seasonal signal in this file
  is about their calendar, not yours.

  Nothing has been written to hunt-planner.mjs. Compare the shape above with
  the weights in that file and decide what, if anything, is worth changing.
`);
    }
  }
}
