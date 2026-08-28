/**
 * collar.mjs — reading somebody else's collared deer, carefully.
 *
 * The planner scores sits using numbers I chose: rut phase 2 to 24, a cold
 * front, a pressure trend, wind, rain, cloud, moon "deliberately small". Every
 * one of those is judgement dressed as arithmetic. Published GPS-collar data
 * can replace some of them with effect sizes that were actually measured.
 *
 * What this can and cannot do, because the distinction governs the whole file:
 *
 *   It CANNOT say where your deer are. The reference dataset is 111 deer in
 *   SOUTH CAROLINA, 2009-2018. Different ground, different years, different
 *   animals. Nothing here becomes movement prediction.
 *
 *   It CAN measure how movement responds to conditions — the hour of the day, a
 *   temperature drop, a falling barometer. Those shapes travel. A deer moves
 *   more at first light in Carolina and in Wisconsin alike.
 *
 * And one thing it must NOT do: touch the rut calendar. Carolina deer rut on
 * dates that have nothing to do with Wisconsin's, so any seasonal signal in
 * this data is about their calendar, not yours. The calibration deliberately
 * refuses to produce a rut weight.
 *
 * Nothing here writes to the planner. It reports measured values beside the
 * current ones and stops, because changing what the tool recommends on the
 * strength of another state's deer is Kent's call to make, not a script's.
 *
 * The file is read with the schema DETECTED rather than assumed. Published
 * ecology CSVs name their columns however the authors felt that week, and a
 * loader that guesses silently is how you end up analysing the wrong column.
 */

import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Split one CSV line, honouring quotes. Small and sufficient: these files are
 * machine-written exports, not hand-edited spreadsheets with embedded newlines.
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * What each column is FOR, guessed from its name and then reported so a person
 * can see whether the guess was right.
 *
 * Patterns are ordered: the first match wins, so the specific ones come before
 * the loose ones. `distance` before `dist` matters less than `movement rate`
 * before `rate`, but the ordering is what stops "sex" matching "sexratio".
 */
export const COLUMN_ROLES = [
  ['rate', /^(mov(e|ement)?[_ ]?rate|rate[_ ]?of[_ ]?mov|speed|step[_ ]?length|dist(ance)?[_ ]?m|displacement)/i],
  ['timestamp', /^(timestamp|date[_ ]?time|datetime|acquisition|fix[_ ]?time|gmt|utc|t)$|date.?time/i],
  ['date', /^(date|day|localdate)$/i],
  ['hour', /^(hour|hr|time[_ ]?of[_ ]?day|tod)$/i],
  ['animal', /^(animal|deer|individual|id|collar|tag|animalid|deerid)/i],
  ['sex', /^(sex|gender|m_f)$/i],
  ['lat', /^(lat|latitude|y)$/i],
  ['lng', /^(lon|lng|long|longitude|x)$/i],
  ['temp', /^(temp|temperature|tempc|tempf|air[_ ]?temp)/i],
];

export function detectRoles(header) {
  const roles = {};
  const unmatched = [];
  for (const name of header) {
    const hit = COLUMN_ROLES.find(([, re]) => re.test(name));
    if (hit && roles[hit[0]] === undefined) roles[hit[0]] = name;
    else unmatched.push(name);
  }
  return { roles, unmatched };
}

/**
 * Look at a CSV without loading it: the header, the detected roles, a few rows,
 * and what is missing. This is what to run FIRST on a newly downloaded file —
 * it either confirms the loader will work or shows exactly which column to name
 * by hand.
 */
export async function inspectCsv(file, { sample = 3 } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file), crlfDelay: Infinity,
  });
  let header = null;
  const rows = [];
  let lines = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    if (!header) { header = splitCsvLine(line); continue; }
    if (rows.length < sample) rows.push(splitCsvLine(line));
    if (rows.length >= sample && lines > 5000) break;   // enough to describe it
  }
  rl.close();
  if (!header) throw new Error(`${file} has no rows`);

  const { roles, unmatched } = detectRoles(header);
  return {
    file,
    columns: header,
    roles,
    unmatched,
    sampleRows: rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))),
    // Said plainly, because a missing rate column means the interesting half of
    // the analysis cannot run at all.
    missing: ['rate'].filter(k => !roles[k]),
    canTimestamp: !!(roles.timestamp || (roles.date && roles.hour) || roles.date),
  };
}

/** Parse whatever time columns exist into a Date, or null if they do not. */
export function rowTime(row, roles) {
  const raw = roles.timestamp ? row[roles.timestamp] : null;
  if (raw) {
    const t = new Date(raw.includes('T') || raw.includes(' ') ? raw : raw + 'T00:00:00Z');
    if (!Number.isNaN(t.getTime())) return t;
  }
  if (roles.date) {
    const d = row[roles.date];
    const h = roles.hour ? Number(row[roles.hour]) : 0;
    if (d) {
      const t = new Date(d.includes('T') ? d : `${d}T00:00:00Z`);
      if (!Number.isNaN(t.getTime())) {
        if (Number.isFinite(h)) t.setUTCHours(Math.floor(h));
        return t;
      }
    }
  }
  return null;
}

/**
 * Stream the file, keeping only what the analysis needs.
 *
 * Streamed rather than read whole because these are tens of megabytes and
 * hundreds of thousands of rows — 111 deer at a fix every 30 minutes over nine
 * years — and holding all of it as objects is pointless when four fields per
 * row will do.
 */
export async function loadMovement(file, { roles = null, limit = Infinity } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file), crlfDelay: Infinity,
  });
  let header = null;
  let use = roles;
  const records = [];
  let skipped = 0, total = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!header) {
      header = splitCsvLine(line);
      use = use ?? detectRoles(header).roles;
      if (!use.rate) {
        rl.close();
        throw new Error(
          'no movement-rate column found. Run the inspect step and pass the '
          + 'column name explicitly: --rate "<column>"');
      }
      continue;
    }
    if (records.length >= limit) break;
    total++;
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    const rawRate = row[use.rate];
    // Checked BEFORE conversion. Number('') is 0, so a blank movement rate was
    // being read as "this deer did not move" — which is a real claim, and a
    // different one from "not recorded". Averaged in, it drags every median
    // down and quietly understates every effect measured from it.
    const rate = (rawRate === undefined || rawRate === null || String(rawRate).trim() === '')
      ? NaN : Number(rawRate);
    const when = rowTime(row, use);
    // A row with no rate or no time cannot contribute to any of the questions
    // asked below. Counted rather than silently dropped, so a file that is
    // mostly unusable says so.
    if (!Number.isFinite(rate) || rate < 0 || !when) { skipped++; continue; }
    records.push({
      rate,
      when,
      hour: when.getUTCHours(),
      month: when.getUTCMonth() + 1,
      sex: use.sex ? (row[use.sex] || '').trim().toUpperCase()[0] || null : null,
      animal: use.animal ? row[use.animal] : null,
      lat: use.lat ? Number(row[use.lat]) : null,
      lng: use.lng ? Number(row[use.lng]) : null,
      temp: use.temp ? Number(row[use.temp]) : null,
    });
  }
  rl.close();
  return { records, roles: use, total, skipped };
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Movement by hour of day, as a multiple of the daily median.
 *
 * Reported as a RATIO rather than in metres, because the absolute rate depends
 * on this study's fix interval and terrain and does not transfer. "Deer move
 * 2.4x their daily median at first light" does transfer, and is the shape the
 * planner cares about.
 */
export function byHour(records, { sex = null } = {}) {
  const use = sex ? records.filter(r => r.sex === sex) : records;
  const base = median(use.map(r => r.rate));
  if (!base) return null;
  const out = [];
  for (let h = 0; h < 24; h++) {
    const hits = use.filter(r => r.hour === h).map(r => r.rate);
    out.push({
      hour: h,
      n: hits.length,
      ratio: hits.length ? Math.round(100 * median(hits) / base) / 100 : null,
    });
  }
  return { base, hours: out, n: use.length };
}

/**
 * Movement against a condition, in buckets.
 *
 * Deliberately a plain bucketed comparison rather than a regression: the
 * question is "how much more do they move when it is colder", and a ratio per
 * bucket answers it in a form that can be read, argued with, and dropped
 * straight into an additive score. A fitted coefficient would look more
 * authoritative and say less.
 */
export function byBucket(records, valueOf, edges, { controlForHour = true } = {}) {
  const base = median(records.map(r => r.rate));
  if (!base) return null;

  /**
   * Movement is dominated by the hour of the day — dawn and dusk run several
   * times the daily median — and temperature is CORRELATED with the hour:
   * coldest near dawn, warmest mid-afternoon.
   *
   * That correlation is the whole problem. Bucket raw movement by temperature
   * and the cold buckets fill up with dawn fixes and the warm ones with midday
   * fixes, so what comes out is the diurnal cycle wearing a thermometer's
   * clothes — a large, confident, entirely spurious "deer move more in the
   * cold". The bias runs toward OVERSTATING the effect, which is the dangerous
   * direction: it invents a relationship rather than hiding one.
   *
   * So each record is first expressed as a ratio to ITS OWN hour's median, and
   * the buckets compare those. What comes out is "more or less than usual FOR
   * THIS TIME OF DAY", which is the thing actually being asked.
   */
  const hourMedians = new Map();
  if (controlForHour) {
    for (let h = 0; h < 24; h++) {
      const m = median(records.filter(r => r.hour === h).map(r => r.rate));
      if (m) hourMedians.set(h, m);
    }
  }
  const normalised = r => {
    if (!controlForHour) return r.rate / base;
    const m = hourMedians.get(r.hour);
    return m ? r.rate / m : null;
  };

  const buckets = edges.slice(0, -1).map((lo, i) => ({
    lo, hi: edges[i + 1], rates: [],
  }));
  let unusable = 0;
  for (const r of records) {
    const v = valueOf(r);
    const n = normalised(r);
    if (!Number.isFinite(v) || !Number.isFinite(n)) { unusable++; continue; }
    const b = buckets.find(x => v >= x.lo && v < x.hi);
    if (b) b.rates.push(n);
  }
  return {
    base,
    unusable,
    controlledForHour: controlForHour,
    // Already a ratio to the hour's own median, so it is NOT divided by base
    // again — doing that was the bug that flattened every bucket to 1.00.
    buckets: buckets.map(b => ({
      lo: b.lo, hi: b.hi, n: b.rates.length,
      ratio: b.rates.length ? Math.round(100 * median(b.rates)) / 100 : null,
      mean: b.rates.length ? Math.round(mean(b.rates) * 100) / 100 : null,
    })),
  };
}

/**
 * The study's own centre, so historical weather can be fetched for it.
 *
 * Rounded hard on purpose. These are the locations of collared animals on
 * private research land; the analysis needs the weather over the study area,
 * which a tenth of a degree gives, and nothing here needs or keeps a precise
 * animal position.
 */
export function studyCentre(records) {
  const pts = records.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  if (!pts.length) return null;
  return {
    lat: Math.round(mean(pts.map(p => p.lat)) * 10) / 10,
    lng: Math.round(mean(pts.map(p => p.lng)) * 10) / 10,
    n: pts.length,
  };
}

export function dateRange(records) {
  if (!records.length) return null;
  let min = records[0].when, max = records[0].when;
  for (const r of records) {
    if (r.when < min) min = r.when;
    if (r.when > max) max = r.when;
  }
  return { from: min.toISOString().slice(0, 10), to: max.toISOString().slice(0, 10) };
}
