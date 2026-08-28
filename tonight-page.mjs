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

let DATA = null;
let clockTimer = null;

async function load() {
  let payload;
  try {
    const res = await fetch('/api/tonight');
    payload = await res.json();
    if (!res.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + res.status);
  } catch (err) {
    main.replaceChildren(problem('Could not work out tonight: ' + err.message));
    return;
  }
  DATA = payload;
  render();
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

  const sit = sits[0];
  parts.push(verdictCard(sit));
  parts.push(lightCard(sit));
  const walk = walkCard(sit);
  if (walk) parts.push(walk);
  parts.push(conditionsCard(sit));
  const others = othersCard(sit);
  if (others) parts.push(others);
  const better = betterDayCard();
  if (better) parts.push(better);
  if (sits[1]) parts.push(nextCard(sits[1]));
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
  row(rows, sit.window === 'AM' ? 'Opens' : 'Closes',
    sit.window === 'AM' ? h.openLocal + ' (sunrise ' + h.sunriseLocal + ')'
                        : h.closeLocal + ' (sunset ' + h.sunsetLocal + ')');
  row(rows, 'Legal window', h.openLocal + ' to ' + h.closeLocal);

  const d = sit.depart;
  if (d) {
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
  if (h.exact === false) {
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
    if (now < h.open) {
      node.textContent = dur((h.open - now) / 60000) + ' until light';
      node.style.color = 'var(--muted)';
    } else if (now > h.close) {
      node.textContent = 'light is over';
      node.style.color = 'var(--bad)';
      load();
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

  .note { color: var(--muted); font-size: 14px; }
  .bad-note { color: var(--bad); }
  .loading { color: var(--muted); padding: 30px 0; text-align: center; }
</style>

<header>
  <h1>Tonight</h1>
  <nav>
    <a href="/">Map</a>
    <a href="/review">Review</a>
  </nav>
</header>

<main id="main"><div class="loading">Working out where to sit…</div></main>

<script>
${BROWSER}
</script>
</html>`;
}
