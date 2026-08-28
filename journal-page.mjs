/**
 * journal-page.mjs — the season, and what it is entitled to claim.
 *
 * The page has two halves and they are deliberately unequal in tone.
 *
 * The top half is a record: how many sits, how many hours, what you saw, which
 * stands you sat. That is bookkeeping, it is always true, and it is worth
 * having on its own — nothing else in this program knows how much you actually
 * hunted.
 *
 * The bottom half is the one that matters and the one that is dangerous: does
 * the tool's own rating track what you see? Every prediction this program makes
 * has been unfalsifiable until this table had rows in it. The temptation, once
 * it does, is to draw a line through a dozen points and announce that the
 * planner works.
 *
 * So the page is built to make a refusal look like a finding rather than a
 * failure. "Not enough sits" and "you only hunt the good days" are rendered in
 * the same weight and the same place as a real answer would be, with the
 * reason spelled out, because they ARE the honest result at that point in a
 * season. The selection caveat — you choose the days, using this tool, so
 * nothing here can speak for the days you stayed home — sits under every
 * answer it does give and is not dismissable.
 */

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const BROWSER = String.raw`
const main = document.getElementById('main');
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};
const card = (heading) => {
  const c = el('section', 'card');
  if (heading) c.appendChild(el('h2', null, heading));
  return c;
};
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const fmt = (v, dash) => (num(v) === null ? (dash || '—') : String(v));

let DATA = null;

async function load() {
  try {
    const res = await fetch('/api/sits');
    DATA = await res.json();
    if (!res.ok) throw new Error(DATA.error || ('HTTP ' + res.status));
  } catch (err) {
    main.replaceChildren(problem('Could not read the journal: ' + err.message));
    return;
  }
  render();
}

function problem(text) {
  const c = card(null);
  c.appendChild(el('p', 'note bad', text));
  return c;
}

function render() {
  const parts = [];
  const s = DATA.summary;
  if (!s.sits) {
    const c = card(null);
    c.appendChild(el('h2', null, 'Nothing logged yet'));
    c.appendChild(el('p', 'note',
      'Every prediction this tool makes is unfalsifiable until this page has rows '
      + 'in it. After a sit, open Tonight and fill in what you saw — it takes '
      + 'thirty seconds and it is the only thing here that can ever prove the rest wrong.'));
    parts.push(c);
    main.replaceChildren.apply(main, parts);
    return;
  }

  parts.push(totalsCard(s));
  parts.push(calibrationCard(DATA.calibration));
  parts.push(windCard(DATA.wind));
  parts.push(standsCard(DATA.stands));
  parts.push(logCard(DATA.sits));
  main.replaceChildren.apply(main, parts);
}

function totalsCard(s) {
  const c = card('The season so far');
  const g = el('div', 'grid');
  const cell = (label, value, sub) => {
    const d = el('div');
    d.appendChild(el('span', null, label));
    d.appendChild(el('b', null, value));
    if (sub) d.appendChild(el('i', null, sub));
    g.appendChild(d);
  };
  cell('Sits', String(s.sits), s.uncounted ? s.uncounted + ' not counted' : null);
  cell('Hours', s.hours ? String(s.hours) : '—', s.hours ? null : 'no times recorded');
  cell('Deer', fmt(s.deer), num(s.deerPerSit) === null ? null : s.deerPerSit + ' per sit');
  cell('Bucks', String(s.bucks));
  cell('Blank sits', String(s.blankSits), 'saw nothing');
  cell('Shots', String(s.shots), s.harvests + ' harvested');
  c.appendChild(g);
  if (s.uncounted) {
    c.appendChild(el('p', 'note',
      s.uncounted + ' sit' + (s.uncounted === 1 ? ' has' : 's have') + ' no deer count. '
      + 'Those are left out of every average rather than treated as zeros — '
      + 'not counting and seeing nothing are different facts.'));
  }
  return c;
}

// The important one. A refusal is rendered exactly like an answer, because at
// this point in a season it IS the answer.
function calibrationCard(cal) {
  const c = card('Does the rating track what you see?');
  const verdict = el('div', 'verdict');
  const known = cal.rho !== null && cal.p !== null;
  verdict.classList.add(!known ? 'unknown'
    : cal.p <= 0.05 ? (cal.rho > 0 ? 'yes' : 'backwards') : 'unknown');
  verdict.appendChild(el('strong', null, cal.verdict));
  c.appendChild(verdict);
  c.appendChild(el('p', 'why', cal.why));

  if (known) {
    const stat = el('p', 'stat');
    stat.textContent = 'rho ' + cal.rho.toFixed(2) + ' · p ' + (cal.pText || cal.p)
      + ' · ' + cal.usable + ' sits';
    c.appendChild(stat);
  }

  // With one bucket there is nothing to compare, and a lone full-width bar
  // reads as a result. It is only ever "the only class of day, at 100% of
  // itself" — so the count is stated in words instead.
  if (cal.byRating && cal.byRating.length === 1) {
    const b = cal.byRating[0];
    c.appendChild(el('p', 'note',
      'Every logged sit was called ' + b.rating + ' (' + b.sits + ' of them, '
      + b.deerPerSit + ' deer per sit). One class of day cannot be compared '
      + 'against anything, so no chart is drawn for it.'));
  } else if (cal.byRating && cal.byRating.length) {
    const table = el('div', 'bars');
    const max = Math.max.apply(null, cal.byRating.map(b => b.deerPerSit).concat([0.001]));
    for (const b of cal.byRating) {
      const row = el('div', 'bar');
      row.appendChild(el('div', 'nm', b.rating));
      const track = el('div', 'track');
      const fill = el('i');
      fill.style.width = Math.max(2, 100 * b.deerPerSit / max) + '%';
      // A bucket too thin to mean anything is drawn faintly rather than left
      // out — that it is thin is itself the thing worth seeing.
      if (b.sits < 3) { fill.classList.add('thin'); row.classList.add('thin'); }
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('div', 'val', b.deerPerSit + ' / sit'));
      row.appendChild(el('div', 'n', b.sits + ' sit' + (b.sits === 1 ? '' : 's')));
      table.appendChild(row);
    }
    c.appendChild(table);
  }

  if (cal.caveat) c.appendChild(el('p', 'caveat', cal.caveat));
  return c;
}

function windCard(w) {
  const c = card('How good is the forecast here?');
  if (!w.sits) {
    c.appendChild(el('p', 'note', w.why));
    return c;
  }
  const g = el('div', 'grid');
  const cell = (label, value, sub) => {
    const d = el('div');
    d.appendChild(el('span', null, label));
    d.appendChild(el('b', null, value + '%'));
    if (sub) d.appendChild(el('i', null, sub));
    g.appendChild(d);
  };
  cell('Exact', String(w.exact), 'named the right point');
  cell('Close', String(w.close), 'within one point');
  c.appendChild(g);
  c.appendChild(el('p', 'note', w.why
    + ' This needs no deer at all, and it is worth knowing early: every other '
    + 'judgement here rests on the forecast wind being roughly right.'));
  return c;
}

function standsCard(sp) {
  const c = card('Which stands have produced');
  if (sp.note) c.appendChild(el('p', 'note', sp.note));
  const list = el('div', 'rows');
  for (const st of sp.stands) {
    const r = el('div', 'row' + (st.enough ? '' : ' thin'));
    r.appendChild(el('div', 'nm', st.name));
    r.appendChild(el('div', 'val',
      st.deerPerSit === null ? 'no counts' : st.deerPerSit + ' deer / sit'));
    r.appendChild(el('div', 'n', st.sits + ' sit' + (st.sits === 1 ? '' : 's')
      + (st.uncounted ? ' (' + st.uncounted + ' uncounted)' : '')));
    list.appendChild(r);
  }
  c.appendChild(list);
  c.appendChild(el('p', 'caveat',
    'Faint rows have fewer than ' + sp.minSits + ' counted sits. You also chose '
    + 'which stand to sit each time, usually on the wind — so this is partly a '
    + 'record of which stands the weather let you hunt.'));
  return c;
}

function logCard(sits) {
  const c = card('Every sit');
  const list = el('div', 'sits');
  for (const s of sits) {
    const r = el('div', 'sit');
    const head = el('div', 'head');
    head.appendChild(el('b', null, s.date + ' ' + s.window));
    head.appendChild(el('span', 'nm', s.stand_name || 'no stand recorded'));
    const pred = s.predicted && s.predicted.rating;
    if (pred) head.appendChild(el('span', 'pill', 'called ' + pred));
    r.appendChild(head);

    const bits = [];
    bits.push(s.deer === null ? 'not counted' : s.deer + ' deer');
    if (num(s.bucks)) bits.push(s.bucks + ' buck' + (s.bucks === 1 ? '' : 's'));
    if (s.predicted && s.predicted.windFrom) {
      bits.push('forecast ' + s.predicted.windFrom
        + (s.wind_from && s.wind_from !== s.predicted.windFrom ? ', got ' + s.wind_from : ''));
    } else if (s.wind_from) {
      bits.push('wind ' + s.wind_from);
    }
    if (s.harvested) bits.push('harvested');
    else if (s.shot) bits.push('took a shot');
    r.appendChild(el('div', 'bits', bits.join(' · ')));
    if (s.notes) r.appendChild(el('div', 'notes', s.notes));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete';
    del.onclick = async () => {
      del.disabled = true;
      try {
        const res = await fetch('/api/sits/' + s.id, { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        load();
      } catch (err) {
        del.disabled = false;
        del.textContent = 'Delete failed';
      }
    };
    r.appendChild(del);
    list.appendChild(r);
  }
  c.appendChild(list);
  return c;
}

load();
`;

export function journalHtml() {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sit journal — TrailCam</title>
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
  header h1 { margin: 0; font-size: 18px; }
  header nav { margin-left: auto; display: flex; gap: 14px; }
  header a { color: var(--accent); text-decoration: none; font-size: 14px; }
  main { max-width: 760px; margin: 0 auto; padding: 16px 18px 60px;
         display: flex; flex-direction: column; gap: 14px; }

  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: 12px; padding: 16px 18px; }
  .card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase;
             letter-spacing: .08em; color: var(--muted); font-weight: 600; }
  .note { color: var(--muted); font-size: 14px; margin: 8px 0 0; }
  .note.bad { color: var(--bad); }
  .caveat { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--line);
            color: var(--muted); font-size: 12.5px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
          gap: 12px 16px; }
  .grid div span { display: block; color: var(--muted); font-size: 12px;
                   text-transform: uppercase; letter-spacing: .06em; }
  .grid div b { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .grid div i { display: block; font-style: normal; color: var(--muted); font-size: 12px; }

  /* A refusal is rendered exactly like an answer. At this point in a season it
     IS the answer, and making it look like a failed panel would push someone
     towards believing the number that is not there yet. */
  .verdict { font-size: 23px; font-weight: 650; line-height: 1.2; }
  .verdict.yes strong { color: var(--ok); }
  .verdict.backwards strong { color: var(--bad); }
  .verdict.unknown strong { color: var(--muted); }
  .why { margin: 6px 0 0; font-size: 15px; }
  .stat { margin: 8px 0 0; color: var(--muted); font-size: 13px;
          font-variant-numeric: tabular-nums; }

  .bars { display: flex; flex-direction: column; gap: 7px; margin-top: 14px; }
  .bar { display: grid; grid-template-columns: 58px 1fr 76px 58px; gap: 8px;
         align-items: center; font-size: 13px; }
  @media (max-width: 400px) { .bar { grid-template-columns: 52px 1fr 66px; }
                              .bar .n { display: none; } }
  .bar .nm { text-transform: capitalize; font-weight: 600; }
  .bar .track { height: 9px; background: var(--bg); border-radius: 5px;
                border: 1px solid var(--line); overflow: hidden; }
  .bar .track i { display: block; height: 100%; background: var(--accent); }
  .bar .track i.thin { background: var(--muted); }
  .bar.thin { opacity: .55; }
  .bar .val, .bar .n { color: var(--muted); font-variant-numeric: tabular-nums;
                       text-align: right; }

  .rows { display: flex; flex-direction: column; gap: 8px; }
  .rows .row { display: grid; grid-template-columns: 1fr 120px 120px; gap: 4px 10px;
               align-items: baseline; font-size: 14px; }
  /* On a phone the three columns squeeze the stand name to two words and a
     hyphen. Stack instead: the name gets the full width and the numbers sit
     under it, left-aligned so they still read as a pair. */
  @media (max-width: 520px) {
    .rows .row { grid-template-columns: 1fr auto; }
    .rows .nm { grid-column: 1 / -1; }
    .rows .val { text-align: left; }
  }
  .rows .row.thin { opacity: .6; }
  .rows .nm { font-weight: 600; }
  .rows .val, .rows .n { color: var(--muted); font-size: 13px; text-align: right; }

  .sits { display: flex; flex-direction: column; }
  .sits .sit { position: relative; padding: 11px 0; border-top: 1px solid var(--line); }
  .sits .sit:first-child { border-top: 0; }
  .sits .head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
                padding-right: 70px; }
  .sits .head .nm { color: var(--muted); font-size: 13px; }
  .sits .pill { font-size: 11px; font-weight: 600; letter-spacing: .03em;
                border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
                color: var(--muted); }
  .sits .bits { color: var(--muted); font-size: 13.5px; margin-top: 2px; }
  .sits .notes { font-size: 14px; margin-top: 4px; }
  .sits .del { position: absolute; right: 0; top: 9px; background: none; cursor: pointer;
               border: 1px solid var(--line); border-radius: 6px; padding: 4px 9px;
               color: var(--muted); font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; }
  .sits .del:hover { color: var(--bad); border-color: var(--bad); }
</style>

<header>
  <h1>Sit journal</h1>
  <nav>
    <a href="/">Map</a>
    <a href="/tonight">Tonight</a>
    <a href="/review">Review</a>
  </nav>
</header>

<main id="main"><p class="note">Reading the journal…</p></main>

<script>
${BROWSER}
</script>
</html>`;
}
