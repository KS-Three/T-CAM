/**
 * camera-shape.mjs — what shape did a camera arrive in, and what did the
 * normalizer fail to read out of it?
 *
 * A provider turns an undocumented, per-model JSON document into the flat row
 * `providers/README.md` describes. The extraction hunts by key name, which is
 * the right call for a schema nobody publishes — but it was written against
 * the models on one account, and a model shaped differently produces `null`
 * for every field it cannot find.
 *
 * That null is the problem this module exists for. `NULL` means unknown all
 * the way down, deliberately, so a camera reporting no figure stays
 * distinguishable from one reporting zero — which means a **misread** field
 * and an **unreported** field arrive looking exactly alike. On the card, on
 * the pin and in the health rules, a new model the extraction cannot read is
 * indistinguishable from a quiet camera. Nothing anywhere says "this document
 * had a battery percentage in it and we did not find it".
 *
 * Two halves, and they answer different questions:
 *
 * - **`blanksFor()` asks whether the document carries what the row is missing.**
 *   It does not claim to know which key is the battery — guessing that is how
 *   a wrong value gets written down as a fact. It reports every key whose path
 *   mentions the thing, and says the normalizer read none of them. "The
 *   document mentions power in three places and we took nothing" is a bug
 *   report you can act on. "No key in this document looks like a battery" is a
 *   camera that did not say, which is a different fact needing the opposite
 *   response. Keeping those apart is the entire point.
 *
 * - **`displayValue()` makes a dump safe to send to somebody.** Diagnosing a
 *   shape needs paths, types and the FORMAT of strings; it never needs the
 *   values. A camera document carries a GPS fix, which is the location of
 *   somebody's hunting property — so the format is kept and the value is not.
 *   `--inspect` used to print all of it and then ask the reader to trim it by
 *   hand, which is the trap this repo has already written down once: writing
 *   the warning is not the same as obeying it.
 */

/**
 * Every leaf of a document, as `[path, value]`.
 *
 * An all-number array is yielded whole AND then per element, so
 * `[-90.65, 44.12]` appears three times: once as the pair, which is the one
 * fact — a coordinate, in an order that is the classic way to get this wrong —
 * and once for each number, which is what a path-by-path reader needs. Anything
 * redacting this output has to cover both forms; a rule written for the pair
 * alone would print the two halves separately.
 *
 * This is the copy the sync uses. `providers/spypoint.mjs` keeps its own on
 * purpose: a provider is meant to be self-contained (see `providers/README.md`),
 * and reaching up into a root module to walk its own response would be the
 * first thread of an unpicked interface.
 */
export function* walk(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') {
    if (prefix) yield [prefix, obj];
    return;
  }
  if (Array.isArray(obj)) {
    if (prefix && obj.length > 0 && obj.every(x => typeof x === 'number')) yield [prefix, obj];
    for (let i = 0; i < obj.length; i++) yield* walk(obj[i], `${prefix}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(obj)) yield* walk(v, prefix ? `${prefix}.${k}` : k);
}

/** The last named segment of a path, with array indices dropped. */
export const leafKey = p => String(p).replace(/\[\d+\]/g, '').split('.').pop();

// Anything on a path mentioning a position. Matched against the WHOLE path,
// not the leaf: the number that matters is `status.coordinates[0].position
// .coordinates`, whose leaf key repeats the word but whose siblings —
// `dateTime`, `geohash` — do not all carry it themselves.
const LOCATION_RE = /lat|lon|lng|coord|geohash|position|gps/i;

// Identifiers for a device, an account or a person. Matched against the leaf
// key, because these are named exactly and a loose match here would redact
// half the document and leave the dump useless.
const IDENTITY_RE =
  /^(id|cameraid|userid|user|owner|ucid|sim|iccid|imei|serial|datamatrixkey|token|email|phone|mac|address)$/i;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// A full ISO date, optionally with a time. Strict on purpose — see displayValue.
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

/** Decimal places a number is written with — the precision, without the value. */
const decimals = n => {
  const m = String(n).match(/\.(\d+)/);
  return m ? m[1].length : 0;
};

/**
 * A string's format with its content removed: digits to `#`, letters by case.
 *
 * This is the part of a redacted string worth keeping. `N44 7.407360` and
 * `44.123456` are the same fact in two formats, and which one a model sends is
 * exactly what a normalizer has to be taught — so `A## #.######` earns its
 * place in the dump while the digits do not.
 */
export const skeleton = s =>
  String(s).replace(/\d/g, '#').replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A');

const truncate = (s, n = 80) => (s && s.length > n ? s.slice(0, n - 3) + '...' : s);

/**
 * What to print for one leaf, with identifying content removed.
 *
 * Redacts by default. `--inspect` output exists to be shared — with a helper,
 * on an issue, in a chat — and the half that identifies a place or a device is
 * never the half a shape diagnosis needs. Pass `raw: true` to see the true
 * values, which is a deliberate act rather than the default.
 *
 * A camera's NAME survives redaction. It is what tells two cameras apart in a
 * dump, the sync already prints it on every line, and it is not a coordinate.
 */
export function displayValue(path, value, { raw = false } = {}) {
  if (raw) return truncate(JSON.stringify(value));
  const located = LOCATION_RE.test(String(path));
  const identity = IDENTITY_RE.test(leafKey(path));
  if (!located && !identity) return truncate(JSON.stringify(value));
  // A timestamp sitting under a position — `status.coordinates[0].dateTime` —
  // is not a position, and it is the field that says which of several fixes is
  // newest, which this repo has already had one field bug about. Keep it.
  //
  // The test is deliberately the ISO shape and not Date.parse: `Date.parse`
  // reads "90.6" as June 1990 and "-90" as 1990, so a date-ish rule would hand
  // back low-precision coordinate strings unredacted. No coordinate notation
  // can wear a four-digit year and two hyphens.
  if (typeof value === 'string' && ISO_TIME_RE.test(value)) return truncate(JSON.stringify(value));

  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (Array.isArray(value)) {
    return '[' + value.map(v => (isNum(v) ? `<number ${decimals(v)}dp>` : '<...>')).join(', ') + ']';
  }
  if (isNum(value)) return `<number ${decimals(value)}dp>`;
  if (typeof value === 'string') return `"${truncate(skeleton(value), 40)}"`;
  return `<${typeof value}>`;
}

/**
 * The lines of a shape dump: one `path = value` per leaf.
 *
 * Returned rather than printed so a test can read them, which is also what
 * lets the redaction be asserted instead of eyeballed.
 */
export function shapeLines(obj, { raw = false } = {}) {
  if (obj === null || obj === undefined) return ['(nothing returned)'];
  const out = [];
  for (const [p, v] of walk(obj)) out.push(`${p} = ${displayValue(p, v, { raw })}`);
  return out;
}

// A leaf worth offering as a candidate. Objects never reach here — walk only
// yields leaves — and an empty string is not a value a normalizer missed.
const usable = v => isNum(v)
  || (typeof v === 'string' && v.trim() !== '')
  || (Array.isArray(v) && v.length > 0 && v.every(isNum));

/**
 * A value that could be a moment in time.
 *
 * The time probes need this because their key patterns are necessarily loose:
 * `/last/` reaches `gps.lastFix.latDeg`, and a latitude offered as a candidate
 * for "last contact" is worse than no candidate at all — it reads as an
 * answer. A bare number passes only when it is large enough to be an epoch, so
 * a percentage cannot masquerade as a date.
 */
const timeish = v => {
  if (isNum(v)) return v > 1e9;
  return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Date.parse(v));
};

const MAX_CANDIDATES = 6;

/**
 * The fields worth noticing the absence of, and where a document would mention
 * them.
 *
 * `fields` are names from the normalized row (`providers/README.md`). `mentions`
 * is matched against the whole path, loosely and on purpose: this is a search
 * for anything the reader should look at, not a claim about which key is the
 * right one. Being too narrow here is the failure mode that matters — a probe
 * that misses the new model's key reports "nothing looks like it", which reads
 * as a camera that did not say, and that is precisely the wrong answer.
 */
export const PROBES = [
  { label: 'position', fields: ['lat', 'lng'], mentions: LOCATION_RE },
  { label: 'battery', fields: ['battery'], mentions: /batter|power|volt/i },
  { label: 'signal', fields: ['signal'],
    // Wide on purpose: a model calling this `reception` or `network` and being
    // reported as "did not say" is the failure that matters here.
    mentions: /signal|rssi|dbm|bar|reception|cellular|network|lte/i },
  { label: 'last contact', fields: ['lastSeen'],
    mentions: /last|seen|contact|sync|update|heartbeat|check.?in|activ/i,
    ok: timeish },
  { label: 'model', fields: ['model'], mentions: /model/i },
  { label: 'temperature', fields: ['tempValue'], mentions: /temp/i },
  { label: 'SD card', fields: ['memUsed', 'memSize'], mentions: /mem|storage|card|disk/i },
  { label: 'photo quota', fields: ['photoCount', 'photoLimit'], mentions: /photo|quota|count|limit/i },
  { label: 'billing cycle', fields: ['cycleStart', 'cycleEnd'],
    mentions: /billing|cycle|period|renew|expir/i, ok: timeish },
];


/**
 * Which fields came through unknown, and whether the raw document mentions
 * them anyway.
 *
 * Provider-agnostic by construction: it takes the raw document and the
 * normalized row, and knows nothing about how one became the other. That is
 * what lets it report on a brand added later without being taught anything.
 *
 * A probe fires when ANY of its fields is null, not all of them: a camera that
 * gave a latitude and no longitude is more broken than one that gave neither,
 * and a rule that waited for both to be missing would stay silent through it.
 */
export function blanksFor(raw, row, { raw: showRaw = false } = {}) {
  if (!row) return [];
  const leaves = [...walk(raw ?? {})];
  const out = [];
  for (const probe of PROBES) {
    const missing = probe.fields.filter(f => row[f] === null || row[f] === undefined);
    if (!missing.length) continue;
    const candidates = [];
    for (const [p, v] of leaves) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const ok = probe.ok ?? usable;
      if (!probe.mentions.test(p) || !ok(v)) continue;
      candidates.push({ path: p, display: displayValue(p, v, { raw: showRaw }) });
    }
    out.push({ label: probe.label, missing, candidates });
  }
  return out;
}

/**
 * The blanks as printable lines, or an empty array when there is nothing to
 * say.
 *
 * Says which of the two situations each blank is, in words, because the
 * response differs: a mentioned-but-unread field is a normalizer to teach, and
 * an unmentioned one is a camera that did not report. Reading a list of bare
 * nulls and working out which is which is the job this is doing for you.
 */
export function blankLines(blanks) {
  const lines = [];
  for (const b of blanks) {
    const what = b.missing.join(' and ');
    if (!b.candidates.length) {
      lines.push(`${b.label} (${what}) — nothing in the document mentions it; `
        + 'the camera did not report this');
      continue;
    }
    lines.push(`${b.label} (${what}) — read nothing, but the document mentions:`);
    for (const c of b.candidates) lines.push(`    ${c.path} = ${c.display}`);
  }
  return lines;
}
