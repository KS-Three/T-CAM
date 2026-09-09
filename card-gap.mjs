/**
 * card-gap.mjs — photos the camera numbered that the cloud never received.
 *
 * Every photo document SpyPoint returns carries the camera's own file name
 * (`originName`: `PICT0431.JPG` on a FLEX-M, `1392.jpg` on a FLEX-M2), and
 * the camera numbers its files consecutively. So the numbers that are absent
 * between two photos that did arrive are photos that exist on the SD card
 * and were never transmitted — the quota-blocked ones, which SpyPoint's own
 * support page says are never sent later, not even after the cycle resets.
 * The card is the only copy. This module counts them, so the walk out to
 * pull a card is made on a number rather than a hunch.
 *
 * What it knows and what it does not:
 *
 *   - It counts NUMBERS the camera issued that never reached this database.
 *     A photo deleted in the app after a sync is still here, so it does not
 *     count; one deleted before any sync ever saw it does, because from
 *     here it is indistinguishable from one that was never sent.
 *   - A counter that restarts (a formatted card, or 9999 rolling over) is a
 *     reset, and nothing across it is counted. A reset that lands INSIDE a
 *     hole hides the part of the hole before it: an undercount, never an
 *     invented photo. The reset threshold is a drop of more than RESET_JUMP;
 *     a smaller step backwards in time is the same run arriving out of
 *     order, which a FLEX-M2 does at activation.
 *   - A gap's window is the two photos either side of it. The camera took
 *     the missing ones somewhere in between; when exactly, only the card
 *     knows.
 *   - Photos held back by a lost signal are queued and sent at the next
 *     sync, so a hole that closes on its own was never a hole. One that
 *     persists across syncs is a real one, and the only remedy is the card.
 */

import { originCounters } from './db.mjs';

/** A gap whose later edge is within this many days still raises a flag. */
export const RECENT_DAYS = 30;

/**
 * A counter that falls by more than this, in time order, has restarted.
 * Real out-of-order arrivals are a handful of frames; a format or a wrap is
 * hundreds to thousands.
 */
export const RESET_JUMP = 100;

const DAY = 86400000;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Month/day in local time, the way the rest of the page writes a date. */
const md = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };

/**
 * The camera's file counter from its file name, or null when there is none.
 * The last run of digits in the base name, so a directory prefix or a numeric
 * extension cannot leak in.
 */
export function counterOf(originName) {
  if (typeof originName !== 'string') return null;
  const base = originName.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  const runs = base.match(/\d+/g);
  if (!runs) return null;
  return parseInt(runs[runs.length - 1], 10);
}

/**
 * One camera's photos → what its counter says never arrived.
 *
 * `photos` is any array of `{ originName, takenAt }`. Anything without both a
 * readable counter and a timestamp cannot be placed and is skipped, counted
 * in `skipped` so the report can say so rather than silently ignore it.
 */
export function cardGapOf(photos, now = Date.now()) {
  const placed = [];
  let skipped = 0;
  for (const p of photos ?? []) {
    const n = counterOf(p?.originName);
    const t = Date.parse(p?.takenAt ?? '');
    if (n === null || !Number.isFinite(t)) { skipped++; continue; }
    placed.push({ n, t, at: p.takenAt });
  }
  placed.sort((a, b) => a.t - b.t || a.n - b.n);

  // Walk in time. Each epoch is one run of the counter; a Map so a number seen
  // twice keeps its earliest time and counts once.
  const epochs = [];
  let epoch = null;
  let prev = null;
  for (const p of placed) {
    if (epoch === null || (prev !== null && p.n < prev - RESET_JUMP)) {
      epoch = new Map();
      epochs.push(epoch);
    }
    if (!epoch.has(p.n)) epoch.set(p.n, p.at);
    prev = p.n;
  }

  const gaps = [];
  for (const ep of epochs) {
    const ns = [...ep.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ns.length; i++) {
      const a = ns[i - 1], b = ns[i];
      if (b - a > 1) {
        gaps.push({ afterN: a, afterAt: ep.get(a), beforeN: b, beforeAt: ep.get(b), missing: b - a - 1 });
      }
    }
  }
  gaps.sort((x, y) => Date.parse(y.beforeAt) - Date.parse(x.beforeAt));

  const missing = gaps.reduce((s, g) => s + g.missing, 0);
  const recent = gaps
    .filter(g => now - Date.parse(g.beforeAt) <= RECENT_DAYS * DAY)
    .reduce((s, g) => s + g.missing, 0);

  const g = {
    counted: placed.length, skipped, missing, recent, gaps,
    resets: Math.max(0, epochs.length - 1),
    level: recent > 0 ? 'warn' : 'ok',
    // The newest gap's dates, and the gap count when there are several —
    // carried on the reading so the card shows the same words the note does.
    window: null,
    note: null,
  };
  if (missing > 0) {
    g.window = windowOf(g);
    g.note = `${plural(missing, 'photo')} on the card never sent, ${g.window}`;
  }
  return g;
}

/** "9/3 to 9/8", or one date when the gap sits inside a day; gap count when several. */
function windowOf(g) {
  const [newest] = g.gaps;
  const from = md(newest.afterAt), to = md(newest.beforeAt);
  return (from === to ? from : `${from} to ${to}`)
    + (g.gaps.length > 1 ? `, in ${plural(g.gaps.length, 'gap')}` : '');
}

/** A one-line summary for the terminal. Null when there is nothing to say. */
export function cardGapLine(g) {
  if (!g || g.missing === 0) return null;
  return `${plural(g.missing, 'photo')}, ${windowOf(g)}`;
}

/**
 * Every camera in the database → its reading, keyed by the camera's database
 * id (`provider:nativeId`), which is what both dashboards attach it under.
 */
export function cardGapsByCamera(db, now = Date.now()) {
  const out = {};
  for (const [cameraId, photos] of Object.entries(originCounters(db))) {
    out[cameraId] = cardGapOf(photos, now);
  }
  return out;
}
