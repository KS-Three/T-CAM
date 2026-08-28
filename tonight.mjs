/**
 * tonight.mjs — which sit is the NEXT one, as opposed to the best one.
 *
 * The planner ranks the coming fortnight by quality and sorts the good days to
 * the top. That is the right answer to "when should I take a day off". It is
 * the wrong answer to "I am standing in the kitchen with my boots on, where do
 * I go", because the planner's number one might be nine days away.
 *
 * So this picks by the clock instead of by score: the sit that is happening
 * now or happening next. Its rating is still reported — often the honest
 * answer is "go, but it is a mediocre evening, and Saturday is much better" —
 * but the rating decides what is SAID, never which sit is shown.
 *
 * The cutoff is the close of shooting light, not the start of the window. At
 * ten past four on a November afternoon the evening sit has already begun and
 * is still the sit you want; only when the light is legally over does tonight
 * become tomorrow morning.
 */

import { shootingHours, lightNow, beInTreeBy, walkMinutes } from './legal-light.mjs';

/**
 * Attach real instants and shooting hours to one sit from plan.json.
 *
 * Older plans carry neither sunrise/sunset nor the property's UTC offset, so
 * two fallbacks exist and both are flagged rather than hidden. A time this
 * program is not sure about must not be displayed as though it were.
 */
export function resolveSit(sit, { rules, now = Date.now() } = {}) {
  if (!sit) return null;
  const offset = Number.isFinite(sit.utcOffsetSeconds) ? sit.utcOffsetSeconds : null;

  // The planner records the scoring window as offsets from sunrise and sunset,
  // so sunrise and sunset can be recovered from it when a plan predates them
  // being written down. Same arithmetic, stated once here.
  const sunrise = sit.sunrise ?? null;
  const sunset = sit.sunset ?? null;

  let hours = null;
  if (sunrise && sunset) {
    hours = shootingHours(sunrise, sunset, { rules, utcOffsetSeconds: offset });
  } else if (sit.start && sit.end) {
    // start = sunrise - 1.5h (AM) or sunset - 3.5h (PM); end likewise.
    const startMs = Date.parse(sit.start), endMs = Date.parse(sit.end);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      const riseMs = sit.window === 'AM' ? startMs + 1.5 * 3600000 : null;
      const setMs = sit.window === 'PM' ? endMs - 0.5 * 3600000 : null;
      // Only one of the two is recoverable per window, which is enough for
      // that window's own end of the day.
      const iso = ms => new Date(ms).toISOString().slice(0, 16);
      hours = shootingHours(
        riseMs !== null ? iso(riseMs) : iso(startMs),
        setMs !== null ? iso(setMs) : iso(endMs),
        { rules, utcOffsetSeconds: 0 },
      );
      if (hours) hours.exact = false;
    }
  }
  if (!hours) return null;

  return {
    ...sit,
    hours,
    light: lightNow(hours, now),
    // A sit is "over" once the light is, whatever the scoring window said.
    endsAt: hours.close,
    startsAt: hours.open,
  };
}

/**
 * The sit that is on now, or the next one to come.
 *
 * Returns the resolved sit plus the one after it, because "go tonight" and
 * "tomorrow morning is better" are frequently both true and the second half is
 * what stops you burning a stand on a bad evening.
 */
export function nextSits(sits = [], { now = Date.now(), rules, count = 2 } = {}) {
  const resolved = sits
    .map(s => resolveSit(s, { rules, now }))
    .filter(Boolean)
    .sort((a, b) => a.startsAt - b.startsAt);
  const upcoming = resolved.filter(s => s.endsAt > now);
  return {
    sits: upcoming.slice(0, count),
    // Everything in the plan is behind us — the plan is stale, which is a
    // different problem from having no plan and gets a different message.
    stale: resolved.length > 0 && upcoming.length === 0,
    lastEnded: resolved.length ? resolved.at(-1).endsAt : null,
  };
}

/**
 * How the sit is described in one line at the top of the page.
 *
 * Relative wording ("this evening", "tomorrow morning") beats a date, because
 * the whole point of the screen is that you are about to walk out of the door
 * and a date makes you do arithmetic.
 *
 * Worked out by comparing CALENDAR DAYS at the property, not by counting hours
 * until the sit. An hours-out threshold gets it wrong exactly where it matters
 * most: at half past five on a November evening, tomorrow's sunrise is under
 * thirteen hours away, and any "less than fourteen hours means today" rule
 * calls it "this morning" while it is still dark outside tonight.
 */
export function whenLabel(sit, now = Date.now()) {
  if (!sit) return null;
  const noun = sit.window === 'AM' ? 'morning' : 'evening';
  if (sit.light?.legal) return `this ${noun} — on now`;

  const days = dayGap(localDate(now, sit.utcOffsetSeconds), sit.date);
  if (days === null) return `${noun} of ${sit.date}`;
  if (days <= 0) return `this ${noun}`;
  if (days === 1) return `tomorrow ${noun}`;
  return `${days} days out — ${noun} of ${sit.date}`;
}

/** Today's date at the property, which is not always today where you are. */
export function localDate(now, utcOffsetSeconds) {
  const shifted = Number.isFinite(utcOffsetSeconds)
    ? now + utcOffsetSeconds * 1000
    : now - new Date(now).getTimezoneOffset() * 60000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** Whole days from one YYYY-MM-DD to another. */
export function dayGap(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * The whole plan for one sit at one stand: when to leave, how long the walk
 * is, and what the walk costs you in daylight.
 */
export function departure(sit, walk) {
  if (!sit?.hours) return null;
  const metres = Number.isFinite(walk?.lengthM) ? walk.lengthM : null;
  const mins = metres === null ? 0 : walkMinutes(metres);
  const plan = beInTreeBy(sit.hours, sit.window, { walkMinutes: mins });
  return { ...plan, walkKnown: metres !== null, metres };
}

export { walkMinutes };
