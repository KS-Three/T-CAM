/**
 * camera-days.mjs — was the camera actually watching that day?
 *
 * This exists to fix a denominator. "A deer passed here on 9 of the last 10
 * days" is only a fact if the camera was capable of reporting on all ten. A
 * camera that has spent its transmission quota, or gone silent, or had its
 * battery die, produces exactly the same evidence as a camera that watched an
 * empty trail: nothing. Counting those as deer-absent days inflates every
 * estimate built on top, and always in the same direction.
 *
 * It is the same argument `weather_hours` already makes for the weather: the
 * hours with NO detection are the control group, and without them any apparent
 * pattern is an artefact.
 *
 * ## Why this could not be added later
 *
 * The `cameras` table holds CURRENT state only — `photo_count`, `last_seen`,
 * battery and signal are overwritten on every sync. Nothing anywhere remembers
 * what a camera was doing yesterday. So this cannot be backfilled: whatever is
 * not recorded as it happens is gone for good, and every day without a row is
 * a day permanently missing from the denominator.
 *
 * ## A missing day is UNKNOWN, never live
 *
 * The sync only writes a row on the days it runs. If the laptop was off for a
 * week there are no rows for that week, and that must read as "we do not know",
 * not as "the camera was watching and saw nothing". Anything reading this log
 * has to treat absence as absence of evidence. `summarise()` below counts
 * unknown days explicitly rather than letting them default into anything.
 */

import { quotaOf } from './quota.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * How long a camera may go without reporting before that day counts as silent
 * rather than live.
 *
 * Deliberately much shorter than the dashboard's 30-day staleness flag, which
 * answers a different question ("is this camera lost?"). Here the question is
 * "could it have told me about a deer yesterday?", and a camera that has not
 * checked in for two days could not have.
 */
export const SILENT_AFTER_H = 48;

/**
 * The day an instant falls in at a given longitude, as YYYY-MM-DD.
 *
 * SOLAR local time, not UTC, and not a named timezone. In Wisconsin a dusk
 * visit at 20:00 local is about 01:00 UTC the NEXT day — so a UTC boundary
 * files every evening under tomorrow, and "9 of 10 days" quietly counts each
 * evening against the wrong morning. Every dusk sighting, not an edge case.
 *
 * Longitude over a timezone database because the sun is what the deer and the
 * light bands are keyed to, there is no timezone table in a dependency-free
 * program, and an hour of DST error cannot move a dawn or a dusk across a day
 * boundary the way six hours of UTC offset does.
 *
 * With no longitude it falls back to UTC and says nothing it cannot support.
 */
export const solarOffsetMs = lng =>
  (typeof lng === 'number' && Number.isFinite(lng) ? (lng / 15) * 3600000 : 0);

export const dayOf = (iso, lng) => {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  return new Date(t + solarOffsetMs(lng)).toISOString().slice(0, 10);
};

/**
 * What state a camera is in right now.
 *
 *   live        transmitting, allowance remaining — an empty day means an
 *               empty trail, and counts in the denominator
 *   quota-dark  the allowance is spent. The camera is still taking pictures
 *               and still reporting its battery; it simply cannot send a
 *               photograph. An empty day says nothing about deer.
 *   silent      no contact within SILENT_AFTER_H. Battery, signal, theft,
 *               a dead SIM — the cause does not matter, the evidence is
 *               equally absent.
 *   unknown     not enough information to say. Never treated as live.
 *
 * Order matters: silence is checked FIRST. A camera that is both out of quota
 * and out of contact is silent — the stronger fact, and the one that would
 * still be true if the quota reset tomorrow.
 */
export function dayState(cam, now = Date.now()) {
  if (!cam) return 'unknown';

  const seen = Date.parse(cam.lastSeen ?? '');
  if (Number.isFinite(seen)) {
    if (now - seen > SILENT_AFTER_H * 3600 * 1000) return 'silent';
  } else if (cam.lastSeen !== undefined) {
    // It reported a last-contact field and it was unreadable or empty: a
    // camera that has never checked in has not been watching.
    return 'unknown';
  } else {
    return 'unknown';
  }

  // In contact. The only remaining way to be unable to send a photograph is
  // to have spent the allowance — which quota.mjs already decides, from the
  // camera's own subscription document rather than from a second rule here.
  const q = quotaOf(cam, now);
  if (q.limit !== null && q.remaining === 0) return 'quota-dark';

  return 'live';
}

/**
 * One day's row, ready to store.
 *
 * `photos` is a convenience count only. Anything measuring WHEN a deer came
 * must read `photos.taken_at` and bin it itself — a per-day tally cannot
 * answer a question about first light, and a day boundary in UTC cuts an
 * evening sit off from the morning that belongs with it.
 */
export function cameraDayRow(cam, { now = Date.now(), photos = 0 } = {}) {
  return {
    cameraId: cam.id,
    day: dayOf(new Date(now).toISOString(), cam.lng),
    state: dayState(cam, now),
    photos,
    battery: isNum(cam.battery) ? cam.battery : null,
    signal: isNum(cam.signal) ? cam.signal : null,
    lastSeen: cam.lastSeen ?? null,
    photoCount: isNum(cam.photoCount) ? cam.photoCount : null,
    photoLimit: isNum(cam.photoLimit) ? cam.photoLimit : null,
    observedAt: new Date(now).toISOString(),
  };
}

/**
 * Count a span of days, saying plainly how much of it is usable.
 *
 * `live` is the ONLY denominator anything downstream may divide by. The other
 * three are reported separately and never folded in, because the whole point
 * of the table is that they are not evidence of absence.
 */
export function summarise(rows, { from, to } = {}) {
  const byDay = new Map();
  for (const r of rows ?? []) if (r?.day) byDay.set(r.day, r.state ?? 'unknown');

  const days = [];
  if (from && to) {
    // Walk the requested span so days with NO row are counted as unknown
    // rather than silently vanishing from both numerator and denominator.
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z');
      t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      days.push({ day: d, state: byDay.get(d) ?? 'unknown' });
    }
  } else {
    for (const [day, state] of [...byDay].sort()) days.push({ day, state });
  }

  const count = s => days.filter(d => d.state === s).length;
  return {
    days,
    live: count('live'),
    quotaDark: count('quota-dark'),
    silent: count('silent'),
    unknown: count('unknown'),
    span: days.length,
  };
}

/** "3 of 7 days usable — 2 quota-dark, 1 silent, 1 never recorded". */
export function summaryLine(s) {
  if (!s || !s.span) return 'no days recorded';
  const bits = [];
  if (s.quotaDark) bits.push(`${s.quotaDark} quota-dark`);
  if (s.silent) bits.push(`${s.silent} silent`);
  if (s.unknown) bits.push(`${s.unknown} never recorded`);
  return `${s.live} of ${s.span} days usable`
    + (bits.length ? ` — ${bits.join(', ')}` : '');
}
