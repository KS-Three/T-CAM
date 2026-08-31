/**
 * quota.mjs — how much of a camera's monthly photo allowance is gone, and
 * whether the rest of it will survive the billing cycle.
 *
 * SpyPoint's free plan transmits 100 photos per camera per cycle. When that
 * runs out the camera keeps taking pictures and stops sending them, silently:
 * nothing fails, nothing is reported, the photo grid simply stops growing.
 * That is the failure this module exists to see coming.
 *
 * The numbers come from the camera's own subscription document
 * (`photoCount` / `photoLimit`, `startDateBillingCycle` / `endDateBillingCycle`),
 * so this is SpyPoint's accounting rather than a count of what was downloaded.
 * The two differ on purpose: a photo that was transmitted, counted against the
 * quota, and then deleted from the cloud is gone from the photo tree but not
 * from the bill.
 *
 * Quota is PER CAMERA. One camera being maxed out says nothing about the
 * others, and reporting any single camera's usage as the account's is how the
 * one that actually stopped sending stays hidden.
 */

const isNum = v => typeof v === 'number' && Number.isFinite(v);

const DAY = 86400000;

/** Fraction of the allowance spent before the percentage alone raises a flag. */
const WARN_AT = 0.8;

/**
 * A burn-rate projection needs a day of history to divide by. Less than this
 * and one busy morning reads as a rate of 40/day and predicts catastrophe on
 * the 2nd of the month.
 */
const MIN_ELAPSED_DAYS = 1;

/**
 * Near the end of a cycle the projection stops meaning anything: the counter
 * is about to reset, so "dry in two days" and "the cycle ends in two days"
 * are the same sentence and only one of them is worth printing.
 */
const PROJECTION_FLOOR_DAYS = 3;

const parse = iso => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

/** Whole days, rounded toward zero, never negative. */
const daysBetween = (from, to) => Math.max(0, Math.floor((to - from) / DAY));

const ymd = ms => new Date(ms).toISOString().slice(0, 10);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Read one camera's quota position.
 *
 * Every derived field is null when the inputs cannot support it, and a null
 * never alarms: an unlimited or unrecognised plan must read as 'ok' rather
 * than as 0/0 spent. Only a limit that is a real positive number is a limit.
 */
export function quotaOf(cam, now = Date.now()) {
  const limit = isNum(cam?.photoLimit) && cam.photoLimit > 0 ? cam.photoLimit : null;
  const used = isNum(cam?.photoCount) && cam.photoCount >= 0 ? cam.photoCount : null;

  const base = {
    plan: cam?.plan ?? null,
    used, limit,
    remaining: null, pct: null,
    cycleStart: cam?.cycleStart ?? null,
    cycleEnd: cam?.cycleEnd ?? null,
    daysElapsed: null, daysLeft: null,
    perDay: null, dryOn: null, daysEarly: null,
    level: 'ok', note: null,
  };
  if (limit === null || used === null) return base;

  // A camera can be reported over its own limit; the allowance still cannot go
  // negative, and neither can the bar that draws it.
  const remaining = Math.max(0, limit - used);
  const pct = Math.min(1, used / limit);

  const start = parse(cam?.cycleStart);
  const end = parse(cam?.cycleEnd);
  const daysLeft = end !== null ? daysBetween(now, end) : null;
  // Fractional, because the rate is divided by it — flooring 1.4 days to 1
  // overstates the burn by 40% on the second of the month.
  const elapsed = start !== null ? Math.max(0, (now - start) / DAY) : null;
  const daysElapsed = elapsed === null ? null : Math.floor(elapsed);

  const q = { ...base, remaining, pct, daysElapsed, daysLeft };

  if (remaining === 0) {
    q.level = 'bad';
    q.note = daysLeft === null
      ? 'quota spent'
      : `quota spent, ${plural(daysLeft, 'day')} left in cycle`;
    return q;
  }

  // Burn rate, and the date the allowance runs out if it keeps up.
  if (elapsed !== null && elapsed >= MIN_ELAPSED_DAYS && used > 0) {
    q.perDay = used / elapsed;
    const dryInDays = remaining / q.perDay;
    q.dryOn = ymd(now + dryInDays * DAY);
    if (daysLeft !== null) q.daysEarly = Math.max(0, Math.floor(daysLeft - dryInDays));
  }

  const projects = q.dryOn !== null
    && daysLeft !== null
    && daysLeft > PROJECTION_FLOOR_DAYS
    && q.daysEarly > 0;

  if (pct >= WARN_AT) {
    q.level = 'warn';
    // What is LEFT, not what is used: the bar beside this already draws the
    // fraction spent, and "only 15 left" is the half that decides anything.
    q.note = `only ${plural(remaining, 'photo')} left`
      + (daysLeft !== null ? `, ${plural(daysLeft, 'day')} of cycle to go` : '');
  } else if (projects) {
    q.level = 'warn';
    q.note = `${q.perDay.toFixed(1)}/day — quota dry ${q.dryOn}, `
      + `${plural(q.daysEarly, 'day')} before the cycle ends`;
  } else if (q.perDay !== null) {
    q.note = `${q.perDay.toFixed(1)}/day — lasts the cycle`;
  }
  return q;
}

/** A one-line summary for the terminal. Returns null when there is nothing to say. */
export function quotaLine(q) {
  if (q.limit === null || q.used === null) return null;
  const bar = q.pct === null ? '' : `[${'#'.repeat(Math.round(q.pct * 10))
    .padEnd(10, '-')}] `;
  return `${bar}${q.used}/${q.limit}${q.note ? `  ${q.note}` : ''}`;
}

export { WARN_AT, PROJECTION_FLOOR_DAYS, MIN_ELAPSED_DAYS };
