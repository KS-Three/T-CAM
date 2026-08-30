/**
 * tonight-page.mjs — the screen you read with your boots in your hand.
 *
 * Every fact on this page already existed somewhere in the program. The
 * planner knew which evenings are worth taking off work for; the stand ranking
 * knew which stand suits a WNW wind; the routes knew which way in stays upwind;
 * the wind history knew whether that stand earns its keep at all. What did not
 * exist was the assembly, and assembly is the whole job: nobody standing in
 * the kitchen at 2pm is going to open four screens and cross-reference them.
 *
 * Two design rules, and both are about NOT being the dashboard.
 *
 * 1. It answers one question and then stops. Where do I sit, which way do I
 *    walk in, and when do I have to leave. The map, the photos, the seven-year
 *    wind rose and the ranked fortnight are all one tap away and none of them
 *    are here.
 *
 * 2. It is driven by the clock, not by the score. The dashboard shows the BEST
 *    sits; this shows the NEXT one, which is regularly a mediocre evening. When
 *    it is mediocre the page says so, plainly, next to the stand — "go, but
 *    Saturday is much better" is useful and "prime" printed over a fair evening
 *    is a lie you would notice once and never trust again.
 *
 * Built for a phone held one-handed, because that is where it gets read.
 *
 * NOTE ON EDITING THIS FILE. The browser script below lives inside a template
 * literal, so a backslash escape or a backtick resolves when the PAGE IS BUILT
 * rather than when it runs, and `node --check` passes either way because the
 * module is still valid JavaScript — it is the generated page that breaks. That
 * has bitten this project three times. test/page-scripts.test.js compiles the
 * generated script to catch it; keep escapes out of here anyway.
 */

import { queueSource, trackerSource, registerSnippet } from './offline.mjs';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');


/**
 * The browser half, kept as a String.raw literal on purpose.
 *
 * Inside an ordinary template literal a backslash escape resolves at page-build
 * time: writing a newline escape in browser code produces a real line break in
 * the generated page, which is a syntax error there and passes `node --check`
 * here. String.raw makes escapes literal, so the browser sees what is written.
 * Backticks would still close the literal, so there are none below.
 */
const BROWSER = String.raw`
const main = document.getElementById('main');

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};
const card = (heading) => {
  const c = el('div', 'card');
  if (heading) c.appendChild(el('h2', null, heading));
  return c;
};
const row = (parent, k, v) => {
  const r = el('div', 'row');
  r.appendChild(el('div', 'k', k));
  const val = el('div', 'v');
  if (v instanceof Node) val.appendChild(v); else val.textContent = v;
  r.appendChild(val);
  parent.appendChild(r);
  return r;
};
const num = (v, digits) => (typeof v === 'number' && isFinite(v)
  ? v.toFixed(digits === undefined ? 0 : digits) : null);

// "1 h 40 m", "25 m", "now". Minutes on their own past an hour read badly on a
// phone at a glance, which is the only place this is read.
const dur = (mins) => {
  if (!isFinite(mins)) return '?';
  const m = Math.max(0, Math.round(mins));
  if (m === 0) return 'now';
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? h + ' h ' + r + ' m' : h + ' h';
};

const RATING_CLASS = { prime: 'ok', good: 'ok', fair: 'warn', poor: 'bad' };
// How much to believe the pick, which is a different question from how good
// the evening is. A prime evening at a stand nothing is known about is a
// confident WHEN and a guessed WHERE, and the page has to be able to say that.
const CONF_CLASS = { high: 'ok', moderate: 'warn', low: 'bad', none: 'bad' };
// Evidence tiers, spelled out. A letter on its own is a code nobody can read.
const TIER_WORD = {
  A: 'collar data at this latitude', B: 'peer-reviewed, southern or direction-only',
  C: 'extension summary of collar work', D: 'no traceable study — scores nothing',
};

let DATA = null;
let clockTimer = null;
// Which sit we have already rolled over from. startClock() calls tick()
// immediately and load() calls startClock(), so an unguarded reload from
// inside tick() re-enters itself: online the server hands back the NEXT sit
// and it settles, but offline the worker keeps answering with the same
// expired one and the phone spins at exactly close of light.
let rolledOverFrom = null;

let CACHED_AT = null;   // set when the answer came from the offline cache

async function load() {
  let payload;
  try {
    const res = await fetch('/api/tonight');
    payload = await res.json();
    if (!res.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + res.status);
    // The service worker stamps anything it answers from cache. Old data is
    // fine in the truck; old data passed off as live is not.
    CACHED_AT = res.headers.get('x-sw-cached-at');
  } catch (err) {
    main.replaceChildren(problem('Could not work out tonight: ' + err.message));
    return;
  }
  DATA = payload;
  render();
  loadIndividuals();
  // Anything logged in the woods goes home the next time the server answers.
  // A load that succeeded from the network is exactly that moment.
  if (!CACHED_AT && typeof TRACKER !== 'undefined' && TRACKER.pending()) {
    TRACKER.flush().catch(() => { /* it stays queued */ });
  }
  if (!CACHED_AT && typeof SITQ !== 'undefined' && SITQ.pending()) {
    SITQ.flush().then(r => {
      if (r.sent || r.rejected) {
        const n = el('div', 'note');
        n.textContent = (r.sent ? r.sent + ' sit' + (r.sent === 1 ? '' : 's')
          + ' logged offline ' + (r.sent === 1 ? 'has' : 'have') + ' been synced.' : '')
          + (r.rejected ? ' ' + r.rejected + ' could not be accepted by the server and '
            + (r.rejected === 1 ? 'was' : 'were') + ' dropped.' : '');
        main.prepend(n);
      }
    });
  }
}

function problem(text) {
  const c = card(null);
  c.appendChild(el('div', 'note bad-note', text));
  return c;
}

function render() {
  const parts = [];
  const sits = (DATA && DATA.sits) || [];

  if (!sits.length) {
    parts.push(problem(DATA && DATA.note ? DATA.note : 'Nothing to plan yet.'));
    main.replaceChildren.apply(main, parts);
    return;
  }

  if (CACHED_AT) {
    const off = card(null);
    const when = new Date(CACHED_AT);
    off.appendChild(el('div', 'note',
      'No connection to the server — this is the plan as it stood '
      + (isNaN(when) ? 'when you last had signal'
        : when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))
      + '. The countdown is still live; sits you log will sync when you are back.'));
    parts.push(off);
  }

  const sit = sits[0];
  parts.push(verdictCard(sit));
  parts.push(whyCard(sit));
  parts.push(lightCard(sit));
  const walk = walkCard(sit);
  if (walk) parts.push(walk);
  parts.push(conditionsCard(sit));
  const others = othersCard(sit);
  if (others) parts.push(others);
  parts.push(trackCard(sit));
  parts.push(logCard(sit));
  const better = betterDayCard();
  if (better) parts.push(better);
  // Only when it is a DIFFERENT sit. When the next one up is also the best one
  // coming, both cards name the same evening and the page says it twice — the
  // better-day card says strictly more, so it wins.
  const b = DATA && DATA.best;
  const dupe = b && sits[1] && b.date === sits[1].date && b.window === sits[1].window;
  if (sits[1] && !(better && dupe)) parts.push(nextCard(sits[1]));
  if (DATA.note) {
    const n = card(null);
    n.appendChild(el('div', 'note', DATA.note));
    parts.push(n);
  }
  if (!DATA.hasTerrain) {
    const n = card(null);
    n.appendChild(el('div', 'note',
      'Thermals are not included yet: open the map and press Terrain to load elevation.'));
    parts.push(n);
  }
  main.replaceChildren.apply(main, parts);
  startClock();
}

function verdictCard(sit) {
  const c = card(null);
  c.className = 'card verdict';
  c.appendChild(el('div', 'when', sit.when || ''));

  const pick = sit.pick;
  if (!pick) {
    c.classList.add('none');
    c.appendChild(el('div', 'stand', 'No stand to send you to'));
    c.appendChild(el('div', 'why', sit.summary || ''));
    return c;
  }
  c.appendChild(el('div', 'stand', pick.name));

  const line = el('div', 'why');
  const rating = el('span', 'pill ' + (RATING_CLASS[sit.rating] || 'muted'), sit.rating || '?');
  line.appendChild(rating);
  // The confidence sits next to the rating deliberately. Given further down it
  // reads as a disclaimer nobody scrolls to; given here it is part of the
  // answer, and a 'low' beside a 'PRIME' is exactly the pairing that stops a
  // good-looking number being believed more than it has earned.
  const conf = pick.confidence;
  if (conf) {
    line.appendChild(document.createTextNode(' '));
    line.appendChild(el('span', 'pill ' + (CONF_CLASS[conf.tier] || 'muted'),
      conf.tier + ' confidence'));
  }
  line.appendChild(document.createTextNode(' '));
  // The wind reason is the one that decided it, so it is the one shown.
  const windReason = (pick.reasons || []).find(r => /wind is/.test(r.why));
  line.appendChild(document.createTextNode(windReason ? windReason.why : (sit.summary || '')));
  c.appendChild(line);

  // A stand that is NOT huntable on this wind, shown because it came top of a
  // bad field, must never look like a recommendation.
  if (pick.huntable === false) {
    const w = el('div', 'why');
    w.appendChild(el('span', 'pill bad', 'not on this wind'));
    w.appendChild(document.createTextNode(' This is the best of a bad set, not a good sit.'));
    c.appendChild(w);
  } else if (pick.huntable === null) {
    const w = el('div', 'why');
    w.appendChild(el('span', 'pill warn', 'winds not set'));
    w.appendChild(document.createTextNode(
      ' Open this stand on the map and tick the winds it is huntable on.'));
    c.appendChild(w);
  }

  // Recent pressure, said in a sentence rather than left as two points off a
  // score nobody can feel. Kent asked for the note specifically: he would
  // rather be told the ground has been walked and make the call himself than
  // have a stand quietly demoted for it.
  if (pick.pressure && pick.pressure.note) {
    const p = el('div', 'why');
    p.appendChild(el('span', 'pill warn', 'pressure'));
    p.appendChild(document.createTextNode(' ' + pick.pressure.note
      + ' ' + pick.pressure.why.charAt(0).toUpperCase() + pick.pressure.why.slice(1) + '.'));
    c.appendChild(p);
  }

  // The thermal warning, when the ground has enough slope to make one. This is
  // the case where the forecast wind is fine and the thermal quietly undoes it.
  const thermal = (pick.reasons || []).find(r => r.points < 0 && /thermal/.test(r.why));
  if (thermal) {
    const t = el('div', 'why');
    t.appendChild(el('span', 'pill warn', 'thermal'));
    t.appendChild(document.createTextNode(' ' + thermal.why));
    c.appendChild(t);
  }
  return c;
}

/**
 * Why — the reasons behind both halves of the answer, with what each rests on.
 *
 * The program has always HAD these reasons; it printed them to a console
 * nobody reads and showed one of them on the page. Putting them here is the
 * point of the whole exercise: a recommendation you can argue with beats one
 * you have to trust, and the evidence tier is what makes arguing possible.
 */
/**
 * Whether one of YOUR bucks does something the population does not.
 *
 * Fetched after the page has drawn, because the tests behind it walk a season
 * of weather per buck and this screen is read with boots in hand.
 *
 * The framing matters and is deliberate: the population weight for moon and
 * barometer is zero and stays zero — no collar study supports it. This asks a
 * narrower question that Kent's own photographs CAN answer, about one named
 * animal on one property, and it only ever speaks when it has enough of them.
 */
async function loadIndividuals() {
  let data;
  try {
    const res = await fetch('/api/individuals');
    if (!res.ok) return;
    data = await res.json();
  } catch (err) { return; }
  const found = (data.results || []).filter(function (r) {
    return r.verdict && r.verdict.indexOf('follows') === 0;
  });
  if (!found.length) return;

  const sit = (DATA && DATA.sits && DATA.sits[0]) || {};
  const c = card('Your bucks');
  found.forEach(function (r) {
    const row = el('div', 'reason');
    row.appendChild(el('span', 'pts muted', 'Y'));
    // Does tonight actually look like what he responds to? That is the only
    // reason this is on the tonight screen rather than in a report.
    let tonight = '';
    const illum = sit.moonIllum, press = sit.pressure;
    if (r.factor === 'moon' && typeof illum === 'number') {
      const bright = illum >= 0.6, wantsBright = r.direction === 'bright moons';
      tonight = ' Tonight is ' + Math.round(illum * 100) + '% lit — '
        + (bright === wantsBright ? 'his kind of night.' : 'not his kind of night.');
    } else if (r.factor === 'barometer' && typeof press === 'number') {
      const high = press >= 30.1, wantsHigh = r.direction === 'high pressure';
      tonight = ' Tonight is ' + press.toFixed(2) + ' inHg — '
        + (high === wantsHigh ? 'his kind of evening.' : 'not his kind of evening.');
    }
    row.appendChild(document.createTextNode(
      r.individual + ' ' + r.verdict + ' (' + r.sightings + ' of your pictures).' + tonight));
    c.appendChild(row);
  });
  c.appendChild(el('div', 'note',
    'The population weight for the moon and the barometer is zero — no collar study '
    + 'supports it, and that has not changed. This is a different question: whether '
    + 'THIS animal, on THIS ground, in your own photographs, does something the '
    + 'population does not. ' + data.tests + ' test'
    + (data.tests === 1 ? ' was' : 's were') + ' run, and the bar was tightened to '
    + 'account for that.'));
  // Next to the reasoning it belongs with. Appended to the end it lands under
  // the sit-logging form, which is past where anyone reads before leaving.
  const anchor = document.getElementById('whyCard');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(c, anchor.nextSibling);
  else main.appendChild(c);
}

function whyCard(sit) {
  const c = card('Why');
  c.id = 'whyCard';
  const pick = sit.pick;

  const list = (title, rows, opts) => {
    if (!rows || !rows.length) return;
    c.appendChild(el('div', 'sub', title));
    const ul = el('div', 'reasons');
    rows.forEach(function (r) {
      const row = el('div', 'reason');
      const pts = r.points > 0 ? '+' + r.points : String(r.points);
      row.appendChild(el('span', 'pts ' + (r.points > 0 ? 'ok' : r.points < 0 ? 'bad' : 'muted'), pts));
      row.appendChild(document.createTextNode(' ' + (r.why || r.reason || '')));
      // The tier is the honest part. A factor scoring zero because nothing
      // supports it is worth more on screen than one quietly left out.
      if (r.tier) {
        const t = el('span', 'tier', ' [' + r.tier + ']');
        t.title = TIER_WORD[r.tier] || '';
        row.appendChild(t);
      }
      ul.appendChild(row);
    });
    c.appendChild(ul);
  };

  // WHEN: why this evening rates what it does.
  const when = (sit.reasons || []).filter(function (r) { return r.points !== 0; })
    .sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); }).slice(0, 4);
  list('This evening', when);
  if (sit.whenEvidence && sit.whenEvidence.tier) {
    c.appendChild(el('div', 'note', 'The rating rests mostly on ' + sit.whenEvidence.note + '.'));
  }
  if (sit.advice) c.appendChild(el('div', 'note', sit.advice));

  // WHERE: why this stand.
  if (pick) {
    const where = (pick.reasons || []).filter(function (r) { return r.points !== 0; })
      .sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); }).slice(0, 5);
    list(pick.name, where);
  }

  // What your own cameras contributed, and what they could not.
  if (sit.evidence) {
    if (sit.evidence.note) {
      c.appendChild(el('div', 'note', sit.evidence.note));
    } else if (sit.evidence.condition) {
      const rows = (sit.evidence.rows || []).filter(function (r) { return r.enough; });
      if (rows.length) {
        c.appendChild(el('div', 'sub', 'Your cameras, on ' + sit.evidence.condition));
        const ul = el('div', 'reasons');
        rows.forEach(function (r) {
          const row = el('div', 'reason');
          row.appendChild(el('span', 'pts muted', r.per100 === null ? '—' : r.per100.toFixed(1)));
          row.appendChild(document.createTextNode(
            ' ' + r.name + ' — ' + r.detections + ' deer in ' + r.hours + ' camera-hours'
            + (r.nocturnalShare === null ? '' : ', ' + r.nocturnalShare + '% after dark')));
          ul.appendChild(row);
        });
        c.appendChild(ul);
        c.appendChild(el('div', 'note',
          'Per 100 camera-hours. Cameras are compared against each other in the '
          + 'same weather, so the date, the rut and the moon are held constant.'));
      }
    }
  }

  // And the things that would make the answer better, which are the only rows
  // worth showing that scored nothing.
  const todo = pick ? (pick.reasons || []).filter(function (r) {
    return r.points === 0 && /trace|log|draw|mark/i.test(r.why || '');
  }) : [];
  if (todo.length) {
    c.appendChild(el('div', 'sub', 'To make this answer firmer'));
    const ul = el('div', 'reasons');
    todo.forEach(function (r) {
      ul.appendChild(el('div', 'reason todo', r.why));
    });
    c.appendChild(ul);
  }
  if (pick && pick.confidence && pick.confidence.factors && pick.confidence.factors.length) {
    c.appendChild(el('div', 'note',
      'Confidence ' + pick.confidence.tier + ': ' + pick.confidence.factors.join('; ') + '.'));
  }
  return c;
}

function lightCard(sit) {
  const c = card('Shooting light');
  const h = sit.hours;
  if (!h) {
    c.appendChild(el('div', 'note', 'No sunrise or sunset recorded for this sit.'));
    return c;
  }
  const clock = el('div', 'clock');
  clock.id = 'countdown';
  c.appendChild(clock);

  const rows = el('div', 'rows');
  rows.style.marginTop = '8px';
  if (sit.window === 'AM' && h.openLocal) {
    row(rows, 'Opens', h.openLocal + ' (sunrise ' + h.sunriseLocal + ')');
  } else if (sit.window === 'PM' && h.closeLocal) {
    row(rows, 'Closes', h.closeLocal + ' (sunset ' + h.sunsetLocal + ')');
  }
  // Only when BOTH ends are known. A plan too old to record sunrise and
  // sunset gives one bound per window and the other is not recoverable —
  // printing a made-up second bound as "the legal window" is the one mistake
  // this whole file is written to avoid.
  if (h.openLocal && h.closeLocal) {
    row(rows, 'Legal window', h.openLocal + ' to ' + h.closeLocal);
  } else {
    row(rows, 'Legal window', (sit.window === 'AM' ? 'opens ' + h.openLocal
      : 'closes ' + h.closeLocal) + ' — the other end is not in this plan');
  }

  const d = sit.depart;
  if (d && isFinite(d.sitBy) && isFinite(d.leaveBy)) {
    row(rows, 'Be settled by', clockOf(d.sitBy, sit));
    const walkTxt = d.walkKnown
      ? dur(d.walkMinutes) + ' walk plus ' + d.settleMin + ' min to settle'
      : 'no route recorded, so ' + d.settleMin + ' min to settle only';
    row(rows, 'Leave by', clockOf(d.leaveBy, sit) + ' — ' + walkTxt);
  }
  c.appendChild(rows);

  const caveat = el('div', 'caveat');
  const rules = DATA.shootingHours || {};
  caveat.textContent = (rules.beforeSunriseMin || 30) + ' min before sunrise to '
    + (rules.afterSunsetMin || 20) + ' min after sunset. ' + (rules.caveat || '');
  if (h.partial) {
    caveat.textContent += ' This plan predates sunrise and sunset being recorded, so '
      + 'only the ' + (h.partial === 'AM' ? 'opening' : 'closing')
      + ' of light is known for it. Re-run the planner for the full window.';
  } else if (h.exact === false) {
    caveat.textContent += ' These times were worked out without a recorded timezone '
      + 'for the property, so treat the minute as approximate and re-run the planner.';
  }
  c.appendChild(caveat);
  return c;
}

// A real instant rendered on the property clock, not the phone clock. The two
// are the same in Wisconsin and different everywhere else, and the whole point
// of recording the offset was to stop that mattering.
function clockOf(ms, sit) {
  if (!isFinite(ms)) return '?';
  try {
    return new Date(ms).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: sit.timezone || undefined,
    }).toLowerCase();
  } catch (err) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      .toLowerCase();
  }
}

function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  const tick = () => {
    const node = document.getElementById('countdown');
    if (!node || !DATA || !DATA.sits.length) return;
    const sit = DATA.sits[0];
    const h = sit.hours;
    if (!h) return;
    const now = Date.now();
    if (!isFinite(h.open) || !isFinite(h.close)) {
      // Half a day. Count down to the end this window actually has, and say
      // nothing about the other.
      const edge = sit.window === 'AM' ? h.open : h.close;
      if (!isFinite(edge)) { node.textContent = 'shooting light not known'; return; }
      const mins = (edge - now) / 60000;
      node.textContent = mins > 0
        ? dur(mins) + (sit.window === 'AM' ? ' until light' : ' of light left')
        : (sit.window === 'AM' ? 'light has opened' : 'light is over');
      node.style.color = 'var(--muted)';
      return;
    }
    if (now < h.open) {
      node.textContent = dur((h.open - now) / 60000) + ' until light';
      node.style.color = 'var(--muted)';
    } else if (now > h.close) {
      node.textContent = 'light is over';
      node.style.color = 'var(--bad)';
      const id = sit.date + sit.window;
      if (rolledOverFrom !== id) {
        rolledOverFrom = id;
        clearInterval(clockTimer);
        clockTimer = null;
        load();
      }
    } else {
      const left = (h.close - now) / 60000;
      node.textContent = dur(left) + ' of light left';
      node.style.color = left <= 30 ? 'var(--warn)' : 'var(--ok)';
    }
  };
  tick();
  clockTimer = setInterval(tick, 30000);
}

function walkCard(sit) {
  const c = card('The walk in');
  const w = sit.walk;
  if (!w) {
    c.appendChild(el('div', 'note',
      'No route recorded to this stand. Draw one on the map and it gets checked '
      + 'against the wind the same way the stand is.'));
    return c;
  }
  const head = el('div', 'row');
  head.appendChild(el('div', 'nm', w.name || 'Route'));
  const verdict = w.ok === true ? el('span', 'pill ok', 'clean')
    : w.ok === false ? el('span', 'pill bad', 'blows over the stand')
    : el('span', 'pill muted', 'cannot judge');
  head.appendChild(verdict);
  c.appendChild(head);
  c.appendChild(el('div', 'note', w.why || ''));

  const rows = el('div', 'rows');
  rows.style.marginTop = '8px';
  if (isFinite(w.lengthM)) {
    row(rows, 'Length', Math.round(w.lengthM) + ' m (' + Math.round(w.lengthM * 1.0936) + ' yd)');
  }
  if (w.crossed && w.crossed.length) {
    row(rows, 'Blows across', w.crossed.map(x => (x.target && x.target.name) || 'a marker').join(', '));
  }
  c.appendChild(rows);

  // Offer the clean alternative rather than only reporting the problem.
  if (w.ok === false && sit.pick && sit.pick.routes) {
    const clean = sit.pick.routes.filter(r => r.ok === true);
    if (clean.length) {
      c.appendChild(el('div', 'note', 'Clean on this wind instead: '
        + clean.map(r => r.name || 'a route').join(', ')));
    }
  }
  return c;
}

function conditionsCard(sit) {
  const c = card('Conditions');
  const g = el('div', 'grid');
  const cell = (label, value) => {
    const d = el('div');
    d.appendChild(el('span', null, label));
    d.appendChild(el('b', null, value));
    g.appendChild(d);
  };
  cell('Wind', (sit.windFrom || '?') + (num(sit.windSpeed) ? ' ' + num(sit.windSpeed) + ' mph' : ''));
  cell('Temp', num(sit.temp) !== null ? num(sit.temp) + '°F' : '?');
  cell('Rain', num(sit.rain, 2) !== null ? num(sit.rain, 2) + '"' : '?');
  cell('Rut', sit.rut || '?');
  cell('Moon', sit.moon || '?');
  c.appendChild(g);
  return c;
}

function othersCard(sit) {
  const rest = (sit.stands || []).filter(s => !sit.pick || s.id !== sit.pick.id);
  if (!rest.length) return null;
  const c = card('The other stands');
  const list = el('div', 'others');
  for (const s of rest.slice(0, 6)) {
    const r = el('div', 'other');
    const left = el('div');
    left.appendChild(el('div', 'nm', s.name));
    const top = (s.reasons || []).slice().sort((a, b) => a.points - b.points)[0];
    left.appendChild(el('div', 'rs', top ? top.why : ''));
    r.appendChild(left);
    r.appendChild(el('div', 'sc', String(Math.round(s.total))));
    list.appendChild(r);
  }
  c.appendChild(list);
  return c;
}

// Worth saying only when the gap is real. A couple of points between two sits
// is inside the noise of an additive score, and "wait for Thursday" on that
// basis is advice that would burn a perfectly good evening.
const BETTER_BY = 15;

function betterDayCard() {
  const b = DATA && DATA.best;
  if (!b || !(b.betterBy >= BETTER_BY)) return null;
  const c = card('There is a better day coming');
  const line = el('div', 'why');
  line.appendChild(el('b', null, b.when || (b.date + ' ' + b.window)));
  line.appendChild(document.createTextNode(' scores ' + b.betterBy
    + ' higher on a ' + (b.windFrom || '?') + ' wind. '));
  line.appendChild(el('span', 'pill ' + (RATING_CLASS[b.rating] || 'muted'), b.rating || '?'));
  c.appendChild(line);
  c.appendChild(el('div', 'note',
    'Sitting a stand leaves scent in it. If tonight is marginal, saving it is a real option.'));
  return c;
}

// Logging the sit HERE, on the screen that made the prediction, is the whole
// reason this is not a separate app. The rating, the forecast wind and the
// stand are all on the page already, so they are frozen into the record
// exactly as they were said — and re-running the planner tomorrow cannot
// quietly rewrite what was predicted today.
// Recording the walk in.
//
// Sits on the tonight screen rather than the map because that is where you
// already are when you put your boots on, and because the stand and route it
// should be attached to are on this page and nowhere else.
function trackCard(sit) {
  const c = card('The walk in, recorded');
  if (!TRACKER.supported()) {
    c.appendChild(el('div', 'note', 'This browser has no GPS, so a walk cannot be recorded here.'));
    return c;
  }

  const status = el('div', 'note');
  const row = el('div', 'rec');
  const btn = document.createElement('button');
  row.appendChild(btn);

  const paint = (rec) => {
    row.querySelectorAll('.recdot').forEach(d => d.remove());
    if (rec) {
      btn.className = 'stop';
      btn.textContent = 'Stop and save';
      row.prepend(el('div', 'recdot'));
      const mins = Math.round((Date.now() - rec.startedAt) / 60000);
      status.textContent = rec.fixes.length + ' fix'
        + (rec.fixes.length === 1 ? '' : 'es') + ' over ' + mins + ' min. '
        + 'Lock the screen if you like — it keeps recording, and nothing is lost '
        + 'if the phone closes the page. GPS costs battery, so stop it when you sit.';
    } else {
      btn.className = 'go';
      btn.textContent = 'Record the walk in';
      status.textContent = 'Records where you actually walk, which is the thing the '
        + 'route you drew cannot tell you. Saved when you stop; it waits for signal.';
    }
  };

  btn.onclick = async () => {
    if (TRACKER.recording()) {
      btn.disabled = true;
      const done = TRACKER.finish({
        standId: sit.pick ? sit.pick.id : null,
        routeId: sit.walk ? sit.walk.id : null,
        name: (sit.pick ? sit.pick.name : 'Walk') + ' \u2014 ' + sit.date,
      });
      btn.disabled = false;
      if (!done) { paint(null); status.textContent = 'Too few fixes to keep. Nothing saved.'; return; }
      const r = await TRACKER.flush();
      paint(null);
      if (r.sent && r.saved.length) {
        const t = r.saved[r.saved.length - 1];
        status.textContent = 'Saved: ' + t.length_m + ' m'
          + (t.seconds ? ' in ' + Math.round(t.seconds / 60) + ' min' : '')
          + '. ' + t.quality.why;
        if (t.vsRoute && t.vsRoute.comparable) {
          const v = el('div', 'note');
          v.style.marginTop = '6px';
          v.textContent = t.vsRoute.why;
          if (!t.vsRoute.followed) v.style.color = 'var(--warn)';
          c.appendChild(v);
        }
      } else if (r.rejected) {
        status.textContent = 'The server would not accept that track.';
      } else {
        status.textContent = 'Saved on this phone (' + TRACKER.pending()
          + ' waiting). It uploads when you are back in signal.';
      }
      return;
    }
    const started = TRACKER.start({}, rec => paint(rec));
    if (!started.ok) { status.textContent = started.why; return; }
    paint(TRACKER.current());
  };

  c.append(row, status);
  // A recording already in progress — the page was reopened mid-walk.
  if (TRACKER.recording()) { TRACKER.start({}, rec => paint(rec)); paint(TRACKER.current()); }
  else paint(null);
  return c;
}

function logCard(sit) {
  const c = card('How did it go?');
  const intro = el('div', 'note',
    'Worth thirty seconds: until this is filled in, nothing this tool tells you '
    + 'can ever be shown to be wrong.');
  c.appendChild(intro);

  const form = el('div', 'logform');
  const field = (label, node, wide) => {
    const wrap = el('div', wide ? 'wide' : null);
    wrap.appendChild(el('label', null, label));
    wrap.appendChild(node);
    form.appendChild(wrap);
    return node;
  };
  const number = (min) => {
    const i = document.createElement('input');
    i.type = 'number'; i.min = String(min); i.inputMode = 'numeric';
    i.placeholder = '';
    return i;
  };
  const deer = field('Deer seen', number(0));
  const bucks = field('Bucks', number(0));

  const wind = document.createElement('select');
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = 'as forecast';
  wind.appendChild(blank);
  for (const p of ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                   'S','SSW','SW','WSW','W','WNW','NW','NNW']) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    wind.appendChild(o);
  }
  field('Wind actually', wind);

  const notes = document.createElement('textarea');
  notes.placeholder = 'came off the point at last light, two does then a young buck';
  field('Notes', notes, true);
  c.appendChild(form);

  const checks = el('div', 'checks');
  const mk = (text) => {
    const l = document.createElement('label');
    const b = document.createElement('input');
    b.type = 'checkbox';
    l.append(b, document.createTextNode(text));
    checks.appendChild(l);
    return b;
  };
  const shot = mk('Took a shot');
  const harvested = mk('Harvested');
  c.appendChild(checks);

  const row = el('div', 'logrow');
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Log this sit';
  const status = el('div', 'note');
  status.style.marginTop = '8px';
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Saving\u2026';
    // A blank count stays blank. "I saw nothing" is a zero and "I did not
    // count" is neither, and the analysis depends on telling them apart.
    const body = {
      standId: sit.pick ? sit.pick.id : null,
      date: sit.date,
      window: sit.window,
      predicted: {
        score: sit.score, rating: sit.rating,
        windFrom: sit.windFrom, temp: sit.temp,
      },
      windFrom: wind.value || sit.windFrom || null,
      temp: sit.temp,
      deer: deer.value === '' ? null : Number(deer.value),
      bucks: bucks.value === '' ? null : Number(bucks.value),
      shot: shot.checked,
      harvested: harvested.checked,
      notes: notes.value.trim() || null,
    };
    // The two failures are different and must not share a handler. A fetch
    // that THROWS means no server: queue it. A server that ANSWERS with an
    // error has seen the sit and rejected it, and queueing that would tell
    // you it was saved and then drop it on the next flush.
    let res;
    try {
      res = await fetch('/api/sits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return queueOffline(err);
    }
    try {
      const saved = await res.json();
      if (!res.ok) throw new Error(saved.error || ('HTTP ' + res.status));
      form.remove(); checks.remove(); row.remove();
      intro.textContent = 'Logged. ' + (body.deer === null
        ? 'No count recorded for this one.'
        : body.deer + ' deer.')
        + ' It is in the journal now.';
      const link = document.createElement('a');
      link.href = '/journal';
      link.textContent = 'See the journal';
      link.style.color = 'var(--accent)';
      status.textContent = '';
      status.appendChild(link);
    } catch (err) {
      // The server answered and refused it, or sent something unreadable.
      // Say so and leave the form filled in so it can be corrected.
      status.textContent = 'The server would not accept this: ' + err.message;
      save.disabled = false;
      save.textContent = 'Log this sit';
    }

    function queueOffline(err) {
      // No server. The sit is worth more than the error: queue it on the
      // phone and it goes home on the next load that reaches the server.
      const queued = typeof SITQ !== 'undefined' ? SITQ.enqueue(body) : 0;
      if (queued) {
        form.remove(); checks.remove(); row.remove();
        intro.textContent = 'No connection — saved on this phone ('
          + queued + ' waiting). It syncs itself the next time this page '
          + 'reaches the server.';
        status.textContent = '';
      } else {
        status.textContent = 'Could not save, and could not queue it either: ' + err.message;
        save.disabled = false;
        save.textContent = 'Log this sit';
      }
    }
  };
  row.appendChild(save);
  c.append(row, status);
  return c;
}

function nextCard(sit) {
  // A sentence, not a key/value row: the label is a phrase like "7 days out —
  // morning of 2026-09-03", which in a two-column row squeezes the answer into
  // a strip four words wide.
  const c = card('After that');
  const line = el('div', 'why');
  line.appendChild(el('b', null, sit.when || 'Next sit'));
  line.appendChild(document.createTextNode(': '
    + (sit.pick ? sit.pick.name : 'no stand suits it')
    + ' on a ' + (sit.windFrom || '?') + ' wind'));
  line.appendChild(document.createTextNode(' '));
  line.appendChild(el('span', 'pill ' + (RATING_CLASS[sit.rating] || 'muted'), sit.rating || '?'));
  c.appendChild(line);
  return c;
}

load();
// Coming back to the tab after an hour must not show an hour-old countdown.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
`;

export function tonightHtml({ title = 'Tonight' } = {}) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#375a3f">
<title>${esc(title)} — TrailCam</title>
<style>
  :root {
    --bg: #f6f7f5; --panel: #fff; --ink: #1a1c19; --muted: #5d6159;
    --line: #dcdfd8; --ok: #2f7d4f; --warn: #b06d15; --bad: #b3352b;
    --accent: #375a3f;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14160f; --panel: #1d2018; --ink: #e8eae2; --muted: #9aa08f;
      --line: #2f3428; --ok: #6bbb85; --warn: #e0a850; --bad: #e8776b;
      --accent: #8fbf9c;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
           padding: 14px 18px; border-bottom: 1px solid var(--line); }
  header h1 { margin: 0; font-size: 18px; letter-spacing: .01em; }
  header nav { margin-left: auto; display: flex; gap: 14px; }
  header a { color: var(--accent); text-decoration: none; font-size: 14px; }
  main { max-width: 720px; margin: 0 auto; padding: 16px 18px 60px;
         display: flex; flex-direction: column; gap: 14px; }

  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: 12px; padding: 16px 18px; }
  .card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase;
             letter-spacing: .08em; color: var(--muted); font-weight: 600; }

  /* The verdict. Deliberately the only large type on the page. */
  .verdict .when { color: var(--muted); font-size: 14px; }
  .verdict .stand { font-size: 30px; font-weight: 650; line-height: 1.15;
                    margin: 4px 0 6px; }
  .verdict .why { font-size: 15px; }
  .verdict.none .stand { font-size: 21px; color: var(--muted); font-weight: 550; }

  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px;
          font-size: 12px; font-weight: 600; letter-spacing: .03em;
          border: 1px solid currentColor; }
  .pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); }
  .pill.bad { color: var(--bad); } .pill.muted { color: var(--muted); }
  .sub { font-weight: 600; margin: 12px 0 4px; font-size: 0.95rem; }
  .reasons { display: flex; flex-direction: column; gap: 5px; }
  .reason { display: flex; gap: 8px; align-items: baseline; font-size: 0.92rem;
    line-height: 1.35; }
  .reason.todo { color: var(--muted); font-style: italic; }
  .pts { flex: 0 0 auto; min-width: 2.6em; text-align: right;
    font-variant-numeric: tabular-nums; font-weight: 600; }
  .pts.ok { color: var(--ok); } .pts.bad { color: var(--bad); }
  .pts.muted { color: var(--muted); }
  .tier { color: var(--muted); font-size: 0.85em; }

  .rows { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 12px; align-items: baseline; }
  .row .k { color: var(--muted); font-size: 14px; min-width: 116px; flex: 0 0 auto; }
  .row .v { font-size: 15px; }
  .row .v b { font-variant-numeric: tabular-nums; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
          gap: 12px 16px; }
  .grid div span { display: block; color: var(--muted); font-size: 12px;
                   text-transform: uppercase; letter-spacing: .06em; }
  .grid div b { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }

  .clock { font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 650; }
  .caveat { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line);
            color: var(--muted); font-size: 12.5px; }

  .others { display: flex; flex-direction: column; gap: 10px; }
  .other { display: flex; gap: 12px; align-items: baseline;
           padding-top: 10px; border-top: 1px solid var(--line); }
  .other:first-child { padding-top: 0; border-top: 0; }
  .other .nm { font-weight: 600; }
  .other .rs { color: var(--muted); font-size: 13.5px; }
  .other .sc { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }

  .rec { display: flex; gap: 10px; align-items: center; margin-top: 10px; }
  .rec button { flex: 1; padding: 10px; border-radius: 8px; cursor: pointer;
                font: 600 14px/1 ui-sans-serif, system-ui, sans-serif;
                border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  .rec button.go { background: var(--accent); color: #fff; border-color: var(--accent); }
  .rec button.stop { background: var(--bad); color: #fff; border-color: var(--bad); }
  .recdot { width: 10px; height: 10px; border-radius: 50%; background: var(--bad);
            flex: 0 0 auto; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .recdot { animation: none; } }
  .logform { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
             gap: 10px 12px; margin-top: 10px; }
  .logform label { display: block; color: var(--muted); font-size: 12px;
                   text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
  .logform input, .logform select, .logform textarea {
    width: 100%; padding: 7px 9px; border-radius: 7px; border: 1px solid var(--line);
    background: var(--bg); color: var(--ink); font: inherit; font-size: 15px; }
  .logform .wide { grid-column: 1 / -1; }
  .logform textarea { min-height: 56px; resize: vertical; }
  .logrow { display: flex; gap: 8px; margin-top: 12px; }
  .logrow button { flex: 1; padding: 9px; border-radius: 8px; cursor: pointer;
                   font: 600 14px/1 ui-sans-serif, system-ui, sans-serif;
                   border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  .logrow button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .checks { display: flex; gap: 16px; align-items: center; margin-top: 10px; font-size: 14px; }
  .checks label { display: flex; gap: 6px; align-items: center; text-transform: none;
                  letter-spacing: 0; font-size: 14px; color: var(--ink); margin: 0; }
  .note { color: var(--muted); font-size: 14px; }
  .bad-note { color: var(--bad); }
  .loading { color: var(--muted); padding: 30px 0; text-align: center; }
</style>

<header>
  <h1>Tonight</h1>
  <nav>
    <a href="/">Map</a>
    <a href="/review">Review</a>
    <a href="/journal">Journal</a>
  </nav>
</header>

<main id="main"><div class="loading">Working out where to sit…</div></main>

<script>
${queueSource('SITQ')}
${trackerSource('TRACKER')}
${registerSnippet()}
${BROWSER}
</script>
</html>`;
}
