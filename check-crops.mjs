#!/usr/bin/env node
/**
 * check-crops.mjs — why is the field scan not working?
 *
 *   node --disable-warning=ExperimentalWarning check-crops.mjs
 *   node --disable-warning=ExperimentalWarning check-crops.mjs --lat 44.125 --lng -90.651
 *   node --disable-warning=ExperimentalWarning check-crops.mjs --field 2
 *   node --disable-warning=ExperimentalWarning check-crops.mjs --classify
 *
 * "Scan failed" in the browser is one line with no diagnosis behind it. This
 * walks the same path the server takes, one step at a time, and says which
 * step broke — so the answer is "CropScape is down again" or "there is not
 * enough corn and soybean ground near you" rather than a shrug.
 *
 * It also serves a purpose the test suite cannot. Those tests feed the reader
 * GeoTIFFs written by the tests themselves, which proves the reader agrees
 * with that writer and nothing more. This runs against the real bucket, so a
 * wrong assumption about how Sentinel-2 actually publishes its pixels shows up
 * here rather than as a quietly wrong harvest date in November.
 */

import process from 'node:process';
import path from 'node:path';
import { readHeader, valueAt } from './cog.mjs';
import {
  searchScenes, ndviSeries, ringCentre, toUtm, utmZone,
} from './sentinel.mjs';
import { cropAt, cropHistory, rotationPrior, latestCdlYear } from './cropscan.mjs';
import { harvestState, referenceFields } from './cropseason.mjs';
import { openDb, allFields } from './db.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const OUT = flag('out', process.env.TRAILCAM_OUT || 'spypoint-data');
const step = (n, what) => console.log(`\n${n}. ${what}`);
const ok = (m) => console.log(`   ok    ${m}`);
const bad = (m) => console.log(`   FAIL  ${m}`);
const note = (m) => console.log(`         ${m}`);

/** The ring to test: an explicit field, an explicit point, or the first field. */
function target() {
  const lat = flag('lat'), lng = flag('lng');
  if (lat && lng) {
    const la = Number(lat), ln = Number(lng), d = 0.0009;
    return {
      what: `the point ${la}, ${ln}`,
      ring: [[ln - d, la - d], [ln + d, la - d], [ln + d, la + d], [ln - d, la + d]],
      field: null,
    };
  }
  let db;
  try {
    db = openDb(OUT);
  } catch (err) {
    console.log(`Could not open the database in ${path.resolve(OUT)}: ${err.message}`);
    console.log('Pass --lat and --lng to test a point without one.');
    process.exit(1);
  }
  const fields = allFields(db);
  db.close();
  if (!fields.length) {
    console.log(`No crop fields are recorded in ${path.resolve(OUT)}.`);
    console.log('Outline one on the map, or pass --lat and --lng.');
    process.exit(1);
  }
  const wanted = flag('field');
  const f = wanted ? fields.find(x => String(x.id) === String(wanted)) : fields[0];
  if (!f) {
    console.log(`No field with id ${wanted}. Have: ${fields.map(x => x.id).join(', ')}`);
    process.exit(1);
  }
  return { what: `field ${f.id} (${f.name ?? 'unnamed'}, recorded as ${f.crop})`, ring: f.points, field: f };
}

const { what, ring, field } = target();
// Coordinates are the location of somebody's hunting ground, so this prints
// what it is doing without printing where.
console.log(`Checking ${what}.`);

let scenes = [];

step(1, 'the imagery catalogue');
try {
  const year = new Date().getUTCFullYear();
  const end = new Date().toISOString().slice(0, 10);
  scenes = await searchScenes(ring, { start: `${year}-04-01`, end });
  if (!scenes.length) bad('the catalogue has no scenes covering this ground');
  else {
    ok(`${scenes.length} scenes, ${scenes[0].date} to ${scenes[scenes.length - 1].date}`);
    note(`tile zone ${scenes[0].zone ?? '?'}, cloud ${scenes.map(s => Math.round(s.cloud ?? -1)).join('/')}%`);
  }
} catch (err) {
  bad(err.message);
  note('Earth Search may be down, or this machine has no route to it.');
}

step(2, 'reading pixels out of one scene');
if (!scenes.length) note('skipped: no scenes');
else {
  try {
    const s = scenes[scenes.length - 1];
    const [lng, lat] = ringCentre(ring);
    const zone = s.zone ?? utmZone(lng);
    const { x, y } = toUtm(lat, lng, zone);
    const red = await readHeader(s.red);
    ok(`${red.width}x${red.height}, tiles ${red.tileWidth}x${red.tileHeight}, `
      + `compression ${red.compression}, predictor ${red.predictor}`);
    const r = await valueAt(red, x, y);
    const nir = await readHeader(s.nir);
    const n = await valueAt(nir, x, y);
    if (r === null || n === null) bad('the field centre is outside this scene');
    else ok(`${s.date}: red ${r}, nir ${n}, NDVI ${((n - r) / (n + r)).toFixed(3)}`);
  } catch (err) {
    bad(err.message);
    note('If this mentions compression or BigTIFF, Sentinel-2 has changed how');
    note('it publishes and cog.mjs needs widening to match.');
  }
}

step(3, 'the season curve');
let series = [];
if (!scenes.length) note('skipped: no scenes');
else {
  series = await ndviSeries(ring, scenes);
  const clear = series.filter(r => r.ndvi !== null);
  if (!clear.length) {
    bad('no scene gave a usable reading');
    for (const r of series.slice(0, 4)) note(`${r.date}: ${r.why}`);
  } else {
    ok(`${clear.length} of ${series.length} looks were usable`);
    for (const r of series) {
      const v = r.ndvi === null ? '  --  ' : r.ndvi.toFixed(3);
      const bar = r.ndvi === null ? '' : '#'.repeat(Math.max(0, Math.round(r.ndvi * 40)));
      console.log(`         ${r.date}  ${v}  ${bar}${r.ndvi === null ? r.why : ''}`);
    }
  }
}

step(4, 'standing or cut');
if (!series.length) note('skipped: no curve');
else {
  const h = harvestState(series);
  ok(`${h.state} — ${h.why}`);
  if (field) {
    const recorded = field.cut_at ? `cut on ${field.cut_at}` : 'no cut date recorded';
    note(`the field says: ${field.crop}, ${recorded}`);
  }
}

step(5, 'CropScape, for the rotation');
try {
  const [lng, lat] = ringCentre(ring);
  const one = await cropAt(lat, lng);
  ok(`${one.year}: ${one.category}${one.crop ? ` (${one.crop})` : ''}`);
  const hist = await cropHistory(lat, lng);
  if (hist.length < 2) bad(`only ${hist.length} year(s) of history came back`);
  else {
    ok(hist.map(h => `${h.year} ${h.crop ?? h.category}`).join(', '));
    const p = rotationPrior(hist, latestCdlYear() + 1);
    note(`rotation suggests: ${p.slice(0, 3).map(x => `${x.crop} ${Math.round(x.p * 100)}%`).join(', ')}`);
  }
} catch (err) {
  bad(err.message);
  note('CropScape is frequently unwell. The harvest check above does not need');
  note('it; only crop identification does.');
}

if (has('classify')) {
  step(6, 'is there enough known ground nearby to identify the crop?');
  const refs = await referenceFields(ring, {});
  if (refs.enough) {
    ok(`${refs.corn.length} corn and ${refs.soybeans.length} soybean fields `
      + `within ${(refs.radius / 1000).toFixed(0)} km (${refs.queries} lookups)`);
  } else {
    bad(`only ${refs.corn.length} corn and ${refs.soybeans.length} soybean fields `
      + `within ${(refs.radius / 1000).toFixed(0)} km after ${refs.queries} lookups`);
    note('This is the expected answer on ground that is mostly wood and wetland.');
    note('Crop identification will refuse here; the harvest check still works.');
  }
} else {
  console.log('\n6. crop identification — skipped (pass --classify; it is slow)');
}

console.log('');
