/**
 * legal-light.mjs — sunrise, sunset, and when it is legal to shoot.
 *
 * This is the one number in this whole program that can cost you a citation
 * rather than a sit, so it is built more carefully than the rest and it says
 * out loud what it is not.
 *
 * WHAT IT IS. Wisconsin's general rule for deer is that shooting hours run
 * from 30 minutes before sunrise to 20 minutes after sunset. That is the rule
 * this file applies, and the offsets are parameters rather than constants
 * because other states differ (a half hour either side is the commonest, and
 * some states use civil twilight instead of a fixed offset entirely).
 *
 * WHAT IT IS NOT. The DNR publishes an official shooting-hours table, by zone
 * and by date, and THAT table is the legal authority — not this arithmetic,
 * and not the sunrise time this app got from a weather API. The two should
 * agree to the minute, but "should" is not a defence. Every surface that shows
 * these times also shows that sentence; do not remove it to tidy up a layout.
 *
 * THE TIMEZONE TRAP, which is the real reason this file exists separately.
 *
 * Open-Meteo is asked for `timezone=auto`, so it returns times as naive local
 * strings for the property — "2026-11-05T06:32", with no offset on the end.
 * `new Date("2026-11-05T06:32")` parses that in the timezone of whatever
 * machine is running, which is only correct when the machine sits in the same
 * zone as the deer. On Kent's laptop in Wisconsin it is right; in a cloud
 * container it is UTC, and every time in the app silently slides six hours.
 *
 * Scoring never noticed, because it compares two times that were both parsed
 * the same wrong way and the error cancels. A countdown to legal light does
 * not have that luxury: it compares a forecast time against the actual clock.
 * So times are resolved against the offset Open-Meteo reports for the
 * property, and when a plan is too old to carry one this says so rather than
 * quietly falling back to the machine's guess.
 */

/** Wisconsin, deer. Minutes either side of sunrise and sunset. */
export const WISCONSIN_DEER = {
  beforeSunriseMin: 30,
  afterSunsetMin: 20,
  authority: 'Wisconsin DNR',
  // Shown wherever a time from this file is shown.
  caveat: 'The DNR shooting-hours table is the legal authority, not this app.',
};

/**
 * Turn a naive local timestamp into a real instant, using the property's own
 * UTC offset rather than the machine's.
 *
 * Returns `{ ms, exact }`. `exact` is false when there was no offset to work
 * with and the machine's zone had to stand in — a caller showing a countdown
 * should degrade rather than lie about the minute.
 */
export function localInstant(naive, utcOffsetSeconds) {
  if (typeof naive !== 'string' || !naive) return { ms: NaN, exact: false };
  // An explicit offset or a trailing Z means it is already unambiguous.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(naive)) {
    return { ms: Date.parse(naive), exact: true };
  }
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return { ms: NaN, exact: false };
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
  if (!Number.isFinite(utcOffsetSeconds)) {
    // No offset recorded. Parse the way the rest of the program historically
    // did, and flag it, so the page can say "times are your computer's clock".
    return { ms: Date.parse(naive), exact: false };
  }
  return { ms: asUtc - utcOffsetSeconds * 1000, exact: true };
}

/**
 * Shooting hours for one day.
 *
 * `sunrise` and `sunset` are whatever the forecast gave — naive local strings
 * for the property. Everything comes back as both a real instant and the local
 * clock face, because a hunter reads the clock face and a countdown needs the
 * instant.
 */
export function shootingHours(sunrise, sunset, {
  rules = WISCONSIN_DEER, utcOffsetSeconds = null,
} = {}) {
  const rise = localInstant(sunrise, utcOffsetSeconds);
  const set = localInstant(sunset, utcOffsetSeconds);
  if (!Number.isFinite(rise.ms) || !Number.isFinite(set.ms)) return null;
  const open = rise.ms - rules.beforeSunriseMin * 60000;
  const close = set.ms + rules.afterSunsetMin * 60000;
  return {
    sunrise: rise.ms, sunset: set.ms, open, close,
    // The clock face at the property, which is what a printed table shows.
    sunriseLocal: clockFace(sunrise), sunsetLocal: clockFace(sunset),
    openLocal: shiftClock(sunrise, -rules.beforeSunriseMin),
    closeLocal: shiftClock(sunset, rules.afterSunsetMin),
    minutes: Math.round((close - open) / 60000),
    exact: rise.exact && set.exact,
    rules,
  };
}

/** "2026-11-05T16:42" -> "4:42 pm". */
export function clockFace(naive) {
  const m = String(naive ?? '').match(/[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  let h = +m[1];
  const suffix = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
}

/** The same, offset by some minutes, staying on the local clock. */
export function shiftClock(naive, deltaMin) {
  const m = String(naive ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi) + deltaMin * 60000);
  return clockFace(t.toISOString().slice(0, 16));
}

/**
 * Where the clock stands right now against those hours.
 *
 * The phases are the ones that change what you do: still time to walk in,
 * you are late, it is legal, the light is going, it is over.
 */
export function lightNow(hours, now = Date.now()) {
  if (!hours) return null;
  const min = ms => Math.round(ms / 60000);
  if (now < hours.open) {
    return {
      phase: 'before', legal: false,
      minutesToOpen: min(hours.open - now),
      minutesToClose: min(hours.close - now),
    };
  }
  if (now > hours.close) {
    return { phase: 'after', legal: false, minutesSinceClose: min(now - hours.close) };
  }
  const left = min(hours.close - now);
  return {
    phase: left <= 30 ? 'last-light' : 'open',
    legal: true,
    minutesToClose: left,
  };
}

/**
 * How long before shooting light you should already be sitting.
 *
 * Not a legal number and not pretending to be one — it is the walk plus the
 * settle, and the settle is the part people cut. Thirty minutes of quiet
 * before the light is worth more than thirty minutes of extra sit.
 */
export const SETTLE_MIN = 30;

export function beInTreeBy(hours, window, { walkMinutes = 0 } = {}) {
  if (!hours) return null;
  // A morning sit is judged against the opening of light; an evening sit
  // against deer moving in the last couple of hours, so the target is earlier
  // than "before dark" by a wide margin.
  const target = window === 'AM'
    ? hours.open
    : hours.close - 2.5 * 3600000;
  const leaveBy = target - (SETTLE_MIN + walkMinutes) * 60000;
  return { sitBy: target, leaveBy, walkMinutes, settleMin: SETTLE_MIN };
}

/**
 * Walking time for a route, at a deliberately slow pace.
 *
 * 2 mph, not 3: you are in the dark, in boots, carrying a bow or a rifle, and
 * trying not to snap sticks. Planning at road-walking pace is how people
 * arrive sweating, which is its own scent problem.
 */
export const WALK_MPS = 0.9;
export const walkMinutes = metres =>
  (Number.isFinite(metres) ? Math.ceil(metres / WALK_MPS / 60) : null);
