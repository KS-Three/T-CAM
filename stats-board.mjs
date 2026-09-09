/**
 * stats-board.mjs — the statistics board, as markup, styles and script.
 *
 * The camp report used to open with two paragraphs of the planner's prose.
 * Kent asked for the opposite: numbers, cut the way a sports broadcast cuts
 * them, with the sample size next to every figure so a strong claim and a thin
 * one do not look alike. This draws what `patterns.mjs` computes.
 *
 * Composed into `dashboard-page.mjs` the way `map-view.mjs` is — one script
 * scope shared with the map and the report, so `el`, `plural` and `D` are the
 * page's own. Everything here is prefixed `sb` for that reason.
 *
 * ## Four decisions worth not undoing
 *
 * 1. THE SMALL MULTIPLES SHARE ONE SCALE. Every 24-hour chart is drawn against
 *    the same maximum, so a quiet camera looks quiet. Scaling each chart to its
 *    own peak is the classic way to make four cameras look identical.
 *
 * 2. A REFUSAL IS DRAWN AS A REFUSAL. `rate === null` means the hours cannot
 *    support a number; it gets a dash and a hatch, never an empty cell and
 *    never a zero. A measured zero — nothing seen in four hundred hours — is a
 *    real finding and gets the number 0.
 *
 * 3. THE HEAT IS AN OVERLAY, NOT A TEXT BACKGROUND. The cell's colour rides in
 *    an absolutely-positioned layer under the number rather than on the cell
 *    itself, because the rose ramp runs light-on-dark in one theme and
 *    dark-on-light in the other, and text sitting directly on it would be
 *    legible in exactly one of them.
 *
 * 4. BOTH SOURCES ARE ALWAYS VISIBLE, NEVER TOTALLED. Your tags and the
 *    camera's unreviewed guesses get their own row in every table and their
 *    own line in every chart. There is no control that merges them, because
 *    the merged number would not mean anything.
 *
 * String.raw throughout: no backtick may appear anywhere below. `\uXXXX` inside
 * an emitted JS string resolves in the browser; inside emitted MARKUP it never
 * resolves, so the markup uses HTML entities.
 */

export const statsMarkup = String.raw`
<section id="statboard">
  <div class="sb-top">
    <div id="sbTotals" class="sb-totals"></div>
    <div class="sb-key">
      <span class="sb-chip yours"><i></i>Your tags</span>
      <span class="sb-chip camera"><i></i>The camera&rsquo;s guesses</span>
    </div>
  </div>
  <div id="sbNote" class="sb-note"></div>

  <h3 class="sb-h">Which cameras are producing <em>per 100 hours the camera was actually watching</em></h3>
  <div id="sbBoardArea"></div>

  <h3 class="sb-h">When they move <em>camera-local solar time; the shaded bands are dawn and dusk</em></h3>
  <div id="sbCurveArea"></div>

  <h3 class="sb-h">Under what conditions <em id="sbAxisNote"></em></h3>
  <div id="sbAxisBtns" class="sb-axisbtns"></div>
  <div id="sbMatrixArea"></div>

  <h3 class="sb-h">Named bucks <em>your confirmed tags only &mdash; the camera says &ldquo;deer&rdquo;, never which one</em></h3>
  <div id="sbBuckArea"></div>
</section>
`;

export const statsStyles = String.raw`
  #statboard { margin: 0 0 6px; }
  #statboard .sb-top { display: flex; flex-wrap: wrap; gap: 10px 18px;
                       align-items: baseline; justify-content: space-between; }
  #statboard .sb-totals { font-size: 13px; color: var(--muted); }
  #statboard .sb-totals b { color: var(--ink); font-weight: 700; }
  #statboard .sb-key { display: flex; gap: 12px; font-size: 11px; color: var(--muted); }
  #statboard .sb-chip { display: inline-flex; align-items: center; gap: 5px; }
  #statboard .sb-chip i { width: 16px; height: 0; display: inline-block;
                          border-top: 2px solid var(--accent); }
  #statboard .sb-chip.camera i { border-top-style: dashed; border-top-color: var(--muted); }
  #statboard .sb-note { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
  #statboard .sb-h { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
                     color: var(--muted); margin: 18px 0 8px; font-weight: 700; }
  #statboard .sb-h em { text-transform: none; letter-spacing: 0; font-weight: 400;
                        font-style: normal; opacity: .8; }

  /* The scoreboard: paired bars, one per provenance, on a shared scale. */
  #statboard .sb-row { display: grid; grid-template-columns: 108px 1fr; gap: 10px;
                       align-items: center; padding: 5px 0;
                       border-top: 1px solid var(--line); }
  #statboard .sb-row:first-child { border-top: 0; }
  #statboard .sb-name { font-size: 12px; font-weight: 600; color: var(--ink);
                        overflow-wrap: anywhere; }
  #statboard .sb-bars { display: grid; gap: 3px; }
  #statboard .sb-bar { display: grid; grid-template-columns: 1fr auto; gap: 8px;
                       align-items: center; font-size: 11px; color: var(--muted); }
  #statboard .sb-track { height: 11px; background: var(--bg); border-radius: 3px;
                         border: 1px solid var(--line); overflow: hidden; }
  #statboard .sb-fill { height: 100%; background: var(--accent); }
  #statboard .sb-bar.camera .sb-fill { background: var(--muted); opacity: .55; }
  #statboard .sb-fig { font-variant-numeric: tabular-nums; white-space: nowrap; }
  #statboard .sb-fig b { color: var(--ink); font-size: 12px; }
  #statboard .sb-none { color: var(--warn); }

  /* Small multiples. One shared scale across every chart, stated on the page. */
  #statboard .sb-grid { display: grid; gap: 10px;
                        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
  #statboard .sb-card { border: 1px solid var(--line); border-radius: 8px;
                        padding: 8px 9px; background: var(--panel); }
  #statboard .sb-card h4 { margin: 0 0 2px; font-size: 12px; color: var(--ink); }
  #statboard .sb-sub { font-size: 11px; color: var(--muted); margin-bottom: 4px;
                       font-variant-numeric: tabular-nums; }
  #statboard svg.sb-chart { display: block; width: 100%; height: auto; }
  #statboard .sb-band { fill: var(--accent); opacity: .10; }
  #statboard .sb-axisline { stroke: var(--line); stroke-width: 1; }
  #statboard .sb-line { fill: none; stroke: var(--accent); stroke-width: 1.8;
                        stroke-linejoin: round; }
  #statboard .sb-line.camera { stroke: var(--muted); stroke-width: 1.4;
                               stroke-dasharray: 3 2.5; }
  #statboard text.sb-tick { fill: var(--muted); font: 9px ui-sans-serif, system-ui, sans-serif; }

  /* The condition matrix. */
  #statboard .sb-axisbtns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  #statboard .sb-axisbtns button { padding: 5px 9px; border-radius: 999px; cursor: pointer;
                                   font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
                                   border: 1px solid var(--line); background: var(--panel);
                                   color: var(--muted); }
  #statboard .sb-axisbtns button.on { background: var(--accent); color: #fff;
                                      border-color: var(--accent); }
  #statboard .sb-tierD { color: var(--warn); font-weight: 700; }
  #statboard .sb-scroll { overflow-x: auto; }
  #statboard table.sb-mx { border-collapse: collapse; font-size: 11px; width: 100%;
                           min-width: 340px; }
  #statboard table.sb-mx th { font-weight: 600; color: var(--muted); padding: 3px 4px;
                              text-align: center; white-space: nowrap; font-size: 10px; }
  #statboard table.sb-mx th.sb-rowhead { text-align: left; width: 108px; }
  #statboard table.sb-mx td { padding: 0; border: 1px solid var(--line); }
  #statboard .sb-cell { position: relative; display: block; padding: 4px 3px;
                        text-align: center; line-height: 1.15; }
  /* The heat rides UNDER the number, never as the cell's own background: the
     rose ramp inverts between themes and text on it would read in only one. */
  #statboard .sb-cell i { position: absolute; inset: 0; background: var(--accent);
                          pointer-events: none; }
  #statboard .sb-cell b, #statboard .sb-cell s { position: relative; }
  #statboard .sb-cell b { display: block; font-variant-numeric: tabular-nums;
                          font-size: 11.5px; color: var(--ink); }
  #statboard .sb-cell s { display: block; text-decoration: none; font-size: 9px;
                          color: var(--muted); }
  /* A cell whose hours cannot support a number. Hatched so it cannot be
     mistaken for a cold spot, which is what an empty or zero cell would read as. */
  #statboard .sb-cell.sb-thin { background-image: repeating-linear-gradient(
      45deg, transparent, transparent 3px, var(--line) 3px, var(--line) 4px); }
  #statboard .sb-cell.sb-thin b { color: var(--muted); }
  #statboard .sb-srclab { font-size: 9.5px; color: var(--muted); padding-left: 4px;
                          white-space: nowrap; }

  #statboard .sb-empty { font-size: 12px; color: var(--muted); padding: 10px 0; }
  /* No server: one honest line rather than four headings over four empty boxes. */
  #statboard.sb-off .sb-h, #statboard.sb-off .sb-axisbtns,
  #statboard.sb-off .sb-key, #statboard.sb-off .sb-note { display: none; }
  #statboard .sb-spark { vertical-align: middle; }
`;

export const statsScript = String.raw`
// ---------------------------------------------------------------------------
// The statistics board
// ---------------------------------------------------------------------------
const sbById = i => document.getElementById(i);
const sbTotals = sbById('sbTotals'), sbNote = sbById('sbNote');
const sbBoardArea = sbById('sbBoardArea'), sbCurveArea = sbById('sbCurveArea');
const sbAxisBtns = sbById('sbAxisBtns'), sbMatrixArea = sbById('sbMatrixArea');
const sbAxisNote = sbById('sbAxisNote'), sbBuckArea = sbById('sbBuckArea');
let SB = null;
let sbAxisKey = 'light';

/** One decimal below ten, none above: 12.4 and 0.9 both want two useful digits. */
const sbNum = v => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

/** A rate, or the dash that means the hours cannot support one. */
const sbRate = r => (r === null ? '—' : sbNum(r));

const sbHours = h => (h >= 1000 ? (h / 1000).toFixed(1) + 'k h' : h + ' h');

/** Why a cell refused, in the words a person would use. */
const sbWhy = (c, minHours) => (c.hours === 0
  ? 'never watched under these conditions'
  : c.hours + ' hours here, and ' + minHours + ' is the fewest that can support a rate');

function sbEmpty(where, text) {
  where.textContent = '';
  where.appendChild(el('div', 'sb-empty', text));
}

// ---- the scoreboard -------------------------------------------------------
function sbDrawBoard() {
  sbBoardArea.textContent = '';
  const rows = SB.board.yours.map(r => r.id);
  const byId = {};
  for (const s of SB.sources) {
    byId[s.key] = {};
    for (const r of SB.board[s.key]) byId[s.key][r.id] = r;
  }
  let max = 0;
  for (const s of SB.sources) for (const r of SB.board[s.key]) if (r.rate !== null && r.rate > max) max = r.rate;
  if (max <= 0) max = 1;

  for (const id of rows) {
    const row = el('div', 'sb-row');
    row.appendChild(el('div', 'sb-name', byId.yours[id].name));
    const bars = el('div', 'sb-bars');
    for (const s of SB.sources) {
      const r = byId[s.key][id];
      const bar = el('div', 'sb-bar ' + s.key);
      const track = el('div', 'sb-track');
      const fill = el('div', 'sb-fill');
      fill.style.width = (r.rate === null ? 0 : (r.rate / max) * 100) + '%';
      track.appendChild(fill);
      bar.appendChild(track);
      const fig = el('div', 'sb-fig');
      if (r.rate === null) {
        const none = el('b', 'sb-none', '—');
        none.title = sbWhy(r, SB.minHours);
        fig.appendChild(none);
      } else {
        fig.appendChild(el('b', null, sbNum(r.rate)));
      }
      fig.appendChild(document.createTextNode(' · ' + r.hits + ' in ' + sbHours(r.hours)));
      bar.appendChild(fig);
      bar.title = s.label + ': ' + r.hits + ' detections in ' + r.hours + ' watched hours';
      bars.appendChild(bar);
    }
    row.appendChild(bars);
    sbBoardArea.appendChild(row);
  }
}

// ---- the 24-hour small multiples -----------------------------------------
const SB_W = 236, SB_H = 74, SB_PAD = 14;

function sbPath(curve, max) {
  const pts = [];
  for (const c of curve) {
    const x = SB_PAD + (c.hour / 23) * (SB_W - SB_PAD - 4);
    const v = c.rate === null ? 0 : c.rate;
    const y = SB_H - 12 - (max <= 0 ? 0 : (v / max) * (SB_H - 24));
    pts.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return pts.join(' ');
}

function sbChart(cam, max) {
  const parts = [];
  // Dawn and dusk, as the range they actually occupied across the season.
  if (cam.light) {
    for (const w of [cam.light.sunrise, cam.light.sunset]) {
      const a = Math.max(0, w.min - 1.5), b = Math.min(24, w.max + 1.5);
      const x1 = SB_PAD + (a / 23) * (SB_W - SB_PAD - 4);
      const x2 = SB_PAD + (b / 23) * (SB_W - SB_PAD - 4);
      parts.push('<rect class="sb-band" x="' + x1.toFixed(1) + '" y="4" width="'
        + Math.max(0, x2 - x1).toFixed(1) + '" height="' + (SB_H - 16) + '"></rect>');
    }
  }
  parts.push('<line class="sb-axisline" x1="' + SB_PAD + '" y1="' + (SB_H - 12)
    + '" x2="' + (SB_W - 4) + '" y2="' + (SB_H - 12) + '"></line>');
  for (const h of [0, 6, 12, 18]) {
    const x = SB_PAD + (h / 23) * (SB_W - SB_PAD - 4);
    parts.push('<text class="sb-tick" x="' + x.toFixed(1) + '" y="' + (SB_H - 2)
      + '" text-anchor="middle">' + h + '</text>');
  }
  parts.push('<text class="sb-tick" x="2" y="12">' + sbNum(max) + '</text>');
  for (const s of SB.sources) {
    const curve = SB.byCamera[s.key][cam.id].curve;
    parts.push('<polyline class="sb-line ' + s.key + '" points="' + sbPath(curve, max) + '"></polyline>');
  }
  return '<svg class="sb-chart" viewBox="0 0 ' + SB_W + ' ' + SB_H + '" role="img" aria-label="'
    + 'Detections per 100 camera-hours by hour of day at ' + cam.name + '">'
    + parts.join('') + '</svg>';
}

function sbDrawCurves() {
  sbCurveArea.textContent = '';
  // ONE scale across every chart. Per-chart scaling would draw the quiet
  // camera exactly like the busy one, which is the whole question.
  let max = 0;
  for (const s of SB.sources) {
    for (const cam of SB.cameras) {
      for (const c of SB.byCamera[s.key][cam.id].curve) {
        if (c.rate !== null && c.rate > max) max = c.rate;
      }
    }
  }
  if (max <= 0) max = 1;
  const grid = el('div', 'sb-grid');
  for (const cam of SB.cameras) {
    const card = el('div', 'sb-card');
    card.appendChild(el('h4', null, cam.name));
    const days = Math.round(cam.hours / 24);
    // plural() already carries the number.
    card.appendChild(el('div', 'sb-sub',
      plural(days, 'day') + ' watching · ' + cam.weatherHours + ' h with weather'));
    const holder = el('div');
    holder.innerHTML = sbChart(cam, max);
    card.appendChild(holder);
    grid.appendChild(card);
  }
  sbCurveArea.appendChild(grid);
  sbCurveArea.appendChild(el('div', 'sb-note',
    'All four charts share one scale, topping out at ' + sbNum(max)
    + ' per 100 camera-hours, so a quiet camera looks quiet.'));
}

// ---- the condition matrix ------------------------------------------------
function sbDrawAxisButtons() {
  sbAxisBtns.textContent = '';
  for (const a of SB.axes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.className = a.key === sbAxisKey ? 'on' : '';
    b.onclick = () => { sbAxisKey = a.key; sbDrawAxisButtons(); sbDrawMatrix(); };
    sbAxisBtns.appendChild(b);
  }
}

function sbDrawMatrix() {
  sbMatrixArea.textContent = '';
  const axis = SB.axes.find(a => a.key === sbAxisKey);
  sbAxisNote.textContent = '';
  if (axis.tier === 'D') {
    const warn = el('span', 'sb-tierD', 'tier D');
    sbAxisNote.appendChild(warn);
    sbAxisNote.appendChild(document.createTextNode(' — ' + axis.note));
  } else {
    sbAxisNote.textContent = axis.note;
  }

  let max = 0, unknown = 0;
  for (const s of SB.sources) {
    for (const cam of SB.cameras) {
      const a = SB.byCamera[s.key][cam.id].axes.find(x => x.key === sbAxisKey);
      unknown = Math.max(unknown, a.unknown);
      for (const b of a.buckets) if (b.rate !== null && b.rate > max) max = b.rate;
    }
  }
  if (max <= 0) max = 1;

  const table = document.createElement('table');
  table.className = 'sb-mx';
  const head = table.insertRow();
  head.appendChild(el('th', 'sb-rowhead', 'Camera'));
  head.appendChild(el('th', null, ''));
  for (const b of axis.buckets) head.appendChild(el('th', null, b.label));

  for (const cam of SB.cameras) {
    let first = true;
    for (const s of SB.sources) {
      const a = SB.byCamera[s.key][cam.id].axes.find(x => x.key === sbAxisKey);
      const tr = table.insertRow();
      const nameCell = el('th', 'sb-rowhead', first ? cam.name : '');
      if (first) nameCell.rowSpan = SB.sources.length;
      if (first) tr.appendChild(nameCell);
      first = false;
      const srcCell = tr.insertCell();
      srcCell.appendChild(el('span', 'sb-srclab', s.short));
      for (const b of a.buckets) {
        const td = tr.insertCell();
        const cell = el('span', 'sb-cell' + (b.rate === null ? ' sb-thin' : ''));
        if (b.rate !== null) {
          const heat = el('i');
          // Capped well below opaque: the number sits on top of this and has
          // to stay readable in both themes.
          heat.style.opacity = (0.06 + (b.rate / max) * 0.42).toFixed(3);
          cell.appendChild(heat);
        }
        cell.appendChild(el('b', null, sbRate(b.rate)));
        cell.appendChild(el('s', null, b.hours + 'h'));
        cell.title = cam.name + ' · ' + s.label + ' · ' + b.label + ': '
          + (b.rate === null ? sbWhy(b, SB.minHours)
            : b.hits + ' in ' + b.hours + ' watched hours');
        td.appendChild(cell);
      }
    }
  }
  const scroll = el('div', 'sb-scroll');
  scroll.appendChild(table);
  sbMatrixArea.appendChild(scroll);
  const foot = el('div', 'sb-note',
    'Rate per 100 camera-hours; the small figure is the hours behind it. '
    + 'A hatched cell has too few hours to support a number — that is not a zero.');
  sbMatrixArea.appendChild(foot);
  if (unknown > 0) {
    sbMatrixArea.appendChild(el('div', 'sb-note',
      'Up to ' + unknown + ' watched hours at a camera have no ' + axis.label.toLowerCase()
      + ' recorded and are in no column.'));
  }
}

// ---- named bucks ----------------------------------------------------------
function sbSpark(curve, max) {
  const w = 108, h = 20;
  const pts = curve.map(c => {
    const x = (c.hour / 23) * w;
    const v = c.rate === null ? 0 : c.rate;
    return x.toFixed(1) + ',' + (h - (max <= 0 ? 0 : (v / max) * (h - 2))).toFixed(1);
  }).join(' ');
  return '<svg class="sb-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h
    + '" role="img" aria-label="his hours"><polyline class="sb-line" points="' + pts + '"></polyline></svg>';
}

function sbDrawBucks() {
  sbBuckArea.textContent = '';
  if (!SB.bucks.length) {
    sbEmpty(sbBuckArea, 'No bucks named yet. Name one in review and his own pattern appears here.');
    return;
  }
  let max = 0;
  for (const b of SB.bucks) for (const c of b.curve) if (c.rate !== null && c.rate > max) max = c.rate;
  const grid = el('div', 'sb-grid');
  for (const b of SB.bucks) {
    const card = el('div', 'sb-card');
    card.appendChild(el('h4', null, b.name));
    if (!b.hits) {
      card.appendChild(el('div', 'sb-sub', 'Named, never photographed yet.'));
    } else {
      const best = b.perCamera.find(p => p.rate !== null);
      card.appendChild(el('div', 'sb-sub', b.hits + ' confirmed · most often at '
        + (best ? best.name + ' (' + sbNum(best.rate) + ')' : 'no camera with enough hours')));
      const holder = el('div');
      holder.innerHTML = sbSpark(b.curve, max);
      card.appendChild(holder);
    }
    grid.appendChild(card);
  }
  sbBuckArea.appendChild(grid);
}

// ---- loading --------------------------------------------------------------
function sbDrawTotals() {
  sbTotals.textContent = '';
  const days = SB.cameras.reduce((n, c) => n + c.hours, 0) / 24;
  const bits = SB.sources.map(s => s.total + ' ' + s.label.toLowerCase());
  sbTotals.appendChild(el('b', null, Math.round(days).toLocaleString() + ' camera-days watched'));
  sbTotals.appendChild(document.createTextNode(' · ' + bits.join(' · ')));
}

async function loadStats() {
  if (!D.live) {
    document.getElementById('statboard').classList.add('sb-off');
    sbEmpty(sbBoardArea, 'The statistics need the server — start-trailcam.cmd, then reload.');
    return;
  }
  sbEmpty(sbBoardArea, 'Counting what the cameras watched…');
  let p;
  try {
    const res = await fetch('/api/patterns');
    p = await res.json();
    if (!res.ok) throw new Error(p.error || 'patterns failed');
  } catch (err) {
    sbEmpty(sbBoardArea, 'Statistics unavailable: ' + err.message);
    return;
  }
  SB = p;
  sbBoardArea.textContent = '';
  if (!SB.cameras.length) {
    sbEmpty(sbBoardArea, SB.note || 'No cameras with coordinates yet.');
    return;
  }
  sbDrawTotals();
  sbNote.textContent = 'Every figure is a rate per 100 hours the camera was actually watching '
    + '— quota-dark and silent days are in neither the top nor the bottom of the fraction. '
    + 'Your tags and the camera’s guesses are counted separately and never added together.';
  sbDrawBoard();
  sbDrawCurves();
  sbDrawAxisButtons();
  sbDrawMatrix();
  sbDrawBucks();
  // The map shades its pins off the same numbers. A function declaration in
  // the map's half of this shared scope, so it is hoisted and safe to call.
  if (typeof mapOnPatterns === 'function') mapOnPatterns(SB);
}
loadStats();
`;
