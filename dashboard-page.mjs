/**
 * dashboard-page.mjs — the whole dashboard: markup, styles and application
 * script, as one self-contained HTML file.
 *
 * This used to live inside spypoint-sync.mjs, which grew to 2,400 lines of
 * which barely a tenth was actually syncing. Splitting it out is not tidiness
 * for its own sake — the page is emitted from a single template literal, and
 * while that literal sat in the middle of the sync script it kept swallowing
 * things. An escape written with one backslash resolves when the PAGE IS BUILT
 * rather than when the browser reads it, so a newline became a real line break
 * inside a quoted string; a backtick in a comment closed the literal early.
 * Each turned the entire dashboard into a syntax error while `node --check` on
 * the module still passed, because the module was fine. It happened three
 * times.
 *
 * The literal is still a literal — that is how the page is built — but it now
 * lives in a file whose only job is the page, next to the tests that compile
 * it, rather than buried in the middle of unrelated download logic.
 *
 * Written as a single self-contained file next to the synced data, with the
 * camera rows baked in as JSON. That keeps coordinates on this machine (no
 * server, no upload) and makes the page work by double-clicking it — a page
 * that fetched cameras.csv over file:// would be blocked by the browser.
 *
 * The slippy map is hand-rolled rather than pulled from a CDN so the page has
 * no dependency to break. Only the raster tiles come from the network; with no
 * connection the pins still lay out correctly over blank tiles, and the camera
 * cards below are unaffected.
 */

import { sourceDescriptors } from './tile-sources.mjs';
import { mapStyles, mapMarkup, mapScript } from './map-view.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

const fmtLoc = r => (r.lat !== null && r.lng !== null ? `${r.lat},${r.lng}` : '?');

const fmtPct = (v, suffix = '%') => (isNum(v) ? `${v}${suffix}` : '?');

// A camera that has not phoned home in months has no new photos to fetch, and
// that is far and away the likeliest reason for an empty sync. Say so loudly
// rather than letting "0 new photos" read as a broken script.
function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

const STALE_DAYS = 30;

const RANK = { ok: 0, warn: 1, bad: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

function healthOf(r) {
  let level = 'ok';
  const notes = [];
  const age = daysSince(r.lastSeen);
  if (age === null) { level = worst(level, 'warn'); notes.push('never reported'); }
  else if (age >= STALE_DAYS) { level = worst(level, 'bad'); notes.push(`silent ${age} days`); }
  else if (age >= 7) { level = worst(level, 'warn'); notes.push(`quiet ${age} days`); }

  if (isNum(r.battery)) {
    if (r.battery <= 10) { level = worst(level, 'bad'); notes.push(`battery ${r.battery}%`); }
    else if (r.battery <= 30) { level = worst(level, 'warn'); notes.push(`battery ${r.battery}%`); }
  }
  return { level, notes, age };
}

// Embedding JSON in a <script> block: the only sequence that can break out is
// a literal "</script>", and & / < are escaped so nothing in a camera name can
// inject markup.
const embed = data => JSON.stringify(data)
  .replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');


// `plan` is optional and comes from hunt-planner.mjs by way of plan.json, so a
// sync run picks up the last plan instead of wiping it off the page, and a
// planner run rebuilds this same page. Either tool can be run first.
function dashboardHtml(rows, photos, generatedAt, plan = null, stands = [], live = false,
                       markers = [], tileSources = null) {
  const payload = embed({
    generatedAt,
    staleDays: STALE_DAYS,
    cameras: rows.map(r => ({ ...r, health: healthOf(r) })),
    photos,
    plan,
    stands,
    // Only a SERVED page can save a pin: a file:// page has no server to POST
    // to, so the button would do nothing. This must be passed in rather than
    // hardcoded — it was hardcoded true at first, which put a dead button on
    // the static dashboard the sync writes.
    live,
    markers,
    // Where imagery comes from. The served page is handed templates pointing at
    // its own server, so every tile is cached on the way past and the page
    // needs no knowledge of upstream URLs; the static file gets the upstream
    // templates because it has no server to ask.
    tiles: tileSources ?? sourceDescriptors({ proxied: false }),
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail Cameras</title>
<style>
  ${mapStyles}
  /* Top-LEFT: the zoom buttons own the top-right and the layer switcher the
     bottom-left, so this is the only free corner. */
  .maptools { position: absolute; left: 10px; top: 10px; z-index: 3; display: flex;
              flex-direction: column; gap: 6px; }
  /* The terrain layers cover the whole map, so they MUST not take clicks —
     without pointer-events:none they would swallow every press meant for the
     ground and break stand placement and ownership lookup alike. */
  #terrain, #contours { position: absolute; left: 0; top: 0; width: 100%; height: 100%;
                        pointer-events: none; display: none; }
  /* Drainages and ridges are drawn in different colours AND different dash
     patterns, so they stay distinguishable printed, in bright sun, or by
     someone who does not separate blue from tan easily. */
  #contours path.drain { stroke: rgba(120,190,255,.95); stroke-width: 2.4; stroke-linecap: round; }
  /* A walk-in route. Drawn heavier than a contour and in a colour used for
     nothing else on the map, because it is the only line you put there
     yourself. */
  #contours path.route { stroke: rgba(190,140,255,.95); stroke-width: 3; fill: none;
                         stroke-linecap: round; stroke-linejoin: round; }
  /* The measuring readout. Sits under the tip rather than beside it, because
     the numbers change on every click and a moving box beside a moving box is
     hard to read. */
  .measurebox { position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
                z-index: 6; background: var(--panel); border: 1px solid var(--line);
                border-radius: 8px; padding: 8px 14px; color: var(--ink);
                box-shadow: 0 2px 12px rgba(0,0,0,.35); text-align: center;
                min-width: 190px; }
  /* Top-RIGHT, below the zoom buttons. It used to sit bottom-left, which was
     fine with three toolbar buttons and started covering the fifth one when the
     toolbar grew. The bottom-right corner is spoken for by the parcel card. */
  .terrainnote { position: absolute; right: 10px; top: 84px; z-index: 4; max-width: 250px;
                 max-height: calc(100% - 190px); overflow-y: auto;
                 background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
                 padding: 8px 10px; font-size: 11px; color: var(--muted);
                 box-shadow: 0 2px 10px rgba(0,0,0,.35); }
  /* Bottom-right: the toolbar owns the top-left, zoom the top-right and the
     layer switcher the bottom-left, so this is the last free corner. */
  .parcelcard { position: absolute; right: 10px; bottom: 10px; z-index: 5;
                width: min(300px, calc(100% - 20px)); background: var(--panel);
                border: 1px solid var(--line); border-radius: 10px; padding: 13px 15px;
                box-shadow: 0 4px 20px rgba(0,0,0,.35); font-size: 13px; }
  /* Map-type control, positioned like Google's: a thumbnail in the lower-left
     showing what you would switch TO, with the full list on hover or tap. */
  .layers { position: absolute; left: 10px; bottom: 10px; z-index: 3; }
  :root {
    --bg: #f6f7f5; --panel: #fff; --ink: #1a1c19; --muted: #5d6159;
    --line: #dcdfd8; --ok: #2f7d4f; --warn: #b06d15; --bad: #b3352b;
    --accent: #375a3f;
    /* Wind-rose ramp, light surface. Five steps rather than six: six single-hue
       steps cannot both clear the 2:1 floor against white AND keep visible
       lightness gaps between them — the validator rejected that, at 1.36:1. */
    --rose-1: #8fbc7c; --rose-2: #6fa25c; --rose-3: #4f8842;
    --rose-4: #356e2d; --rose-5: #1e541c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14160f; --panel: #1d2018; --ink: #e8eae2; --muted: #9aa08f;
      --line: #2f3428; --ok: #6bbb85; --warn: #e0a850; --bad: #e8776b;
      --accent: #8fbf9c;
      /* Dark mode gets its OWN steps, validated against the dark panel — not
         the light ramp flipped. On a dark surface more-is-lighter, so the ramp
         runs the other way. Both sets pass: monotone lightness, gaps >= 0.06,
         the step nearest the surface clearing it (2.18:1 light, 2.05:1 dark). */
      --rose-1: #3c5733; --rose-2: #547548; --rose-3: #6d9360;
      --rose-4: #8ab179; --rose-5: #a9cf96;
    }
  }
  /* The one-question screen. Server-only, so the static page hides it rather
     than offering a link that 404s off a file:// copy. */
  header .tonight { align-self: center; margin-left: auto; white-space: nowrap;
    color: var(--accent); text-decoration: none; font-size: 14px; font-weight: 600;
    border: 1px solid var(--line); border-radius: 999px; padding: 6px 14px; }
  header .tonight:hover { border-color: var(--accent); }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline;
           justify-content: space-between; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .alert { border-left: 3px solid var(--bad); background: var(--panel);
           padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px; }
  .alert h2 { margin: 0 0 6px; font-size: 14px; }
  .alert ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: 10px; padding: 14px 16px; }
  .card.bad { border-left: 3px solid var(--bad); }
  .card.warn { border-left: 3px solid var(--warn); }
  .card.ok { border-left: 3px solid var(--ok); }
  .card h3 { margin: 0 0 2px; font-size: 15px; }
  .model { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; gap: 10px;
         font-size: 13px; padding: 3px 0; }
  .row span:first-child { color: var(--muted); }
  .bar { height: 5px; border-radius: 3px; background: var(--line);
         overflow: hidden; margin-top: 3px; }
  .bar i { display: block; height: 100%; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 20px;
         border: 1px solid currentColor; margin-top: 9px; }
  .tag.ok { color: var(--ok); } .tag.warn { color: var(--warn); } .tag.bad { color: var(--bad); }
  a.coord { color: var(--accent); text-decoration: none; font-variant-numeric: tabular-nums; }
  a.coord:hover { text-decoration: underline; }
  h2.section { font-size: 15px; margin: 32px 0 12px; }
  .photos { display: grid; gap: 10px;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .photos figure { margin: 0; }
  .photos img { width: 100%; border-radius: 8px; display: block; border: 1px solid var(--line); }
  .photos figcaption { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 10px;
           padding: 20px; color: var(--muted); font-size: 14px; }
  .sit { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
         padding: 12px 14px; margin-bottom: 8px; display: grid;
         grid-template-columns: auto 1fr; gap: 4px 14px; align-items: start; }
  .sit .score { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums;
                text-align: center; min-width: 52px; }
  .sit .when { font-weight: 600; }
  .sit .cond { color: var(--muted); font-size: 13px; }
  .sit ul { margin: 6px 0 0; padding-left: 16px; font-size: 13px; color: var(--muted); }
  .sit li.neg { color: var(--bad); }
  .rating { display: block; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
  .r-prime .score, .r-prime .rating { color: var(--ok); }
  .r-strong .score, .r-strong .rating { color: var(--ok); }
  .r-good .score, .r-good .rating { color: var(--accent); }
  .r-fair .score, .r-fair .rating { color: var(--warn); }
  .r-poor .score, .r-poor .rating { color: var(--muted); }
  .stale-note { color: var(--warn); font-size: 12px; margin: -4px 0 12px; }
  /* Stand pins are a different SHAPE as well as colour: a teardrop against the
     cameras' circles, so the two are told apart without relying on colour. */
  .stand { position: absolute; width: 16px; height: 16px; cursor: pointer;
           transform: translate(-50%, -100%) rotate(-45deg);
           border: 2px solid #fff; border-radius: 50% 50% 50% 0;
           background: var(--accent); box-shadow: 0 1px 4px rgba(0,0,0,.5); }
  /* Sign markers carry a LETTER as well as a colour, so a rub and a scrape are
     told apart on a sunlit phone screen and in greyscale. */
  .mark { position: absolute; width: 18px; height: 18px; cursor: pointer;
          transform: translate(-50%, -50%); border-radius: 4px; border: 2px solid #fff;
          font: 700 10px/14px ui-sans-serif, system-ui, sans-serif; text-align: center;
          color: #10240f; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
  /* Wind rose. One series comparing magnitude by direction, so the colour job is
     SEQUENTIAL — a single hue, light to dark, not a set of categorical hues.
     Green to match this page rather than the reference blue, and both the light
     and dark ramps were run through the palette validator against the panel
     they actually sit on (see --rose-* above). The first attempt was validated
     against a dark surface this page does not use and failed outright on the
     real one, which is the argument for computing it rather than judging it. */
  .windwrap { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 20px;
              align-items: start; }
  @media (max-width: 720px) { .windwrap { grid-template-columns: 1fr; } }
  .rose { width: 300px; height: 300px; max-width: 100%; }
  .rose .ring { fill: none; stroke: var(--line); stroke-width: 1; }
  .rose .spoke { stroke: var(--line); stroke-width: 1; }
  .rose text { fill: var(--muted); font-size: 10px; text-anchor: middle;
               dominant-baseline: middle; }
  .rose text.cardinal { fill: var(--ink); font-size: 11px; font-weight: 600; }
  .rose path.petal { stroke: var(--panel); stroke-width: 2; cursor: help; }
  .rose path.petal:hover { stroke: var(--ink); }
  .windbars { display: flex; flex-direction: column; gap: 7px; }
  .wbar { display: grid; grid-template-columns: 132px 1fr 74px; gap: 10px;
          align-items: center; font-size: 13px; }
  .wbar .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wbar .track { height: 9px; background: var(--bg); border-radius: 5px; overflow: hidden; }
  .wbar .fill { height: 100%; border-radius: 5px; background: var(--accent); }
  .wbar .val { text-align: right; color: var(--muted); font-size: 12px; }
  .wbar.unset .val { color: var(--warn); }
  .windnote { margin-top: 12px; font-size: 13px; color: var(--muted); }
  .windnote b { color: var(--ink); }
  .windnote .gap { color: var(--warn); }
  .reviewlink { font-size: 12px; font-weight: 400; color: var(--accent);
                text-decoration: none; margin-left: 10px; }
  .sitplan { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
             margin-bottom: 10px; background: var(--panel); }
  .sitplan h3 { margin: 0 0 2px; font-size: 14px; }
  .sitplan .verdict { font-size: 13px; color: var(--ink); margin: 6px 0 10px; }
  .srow { display: flex; align-items: baseline; gap: 10px; padding: 5px 0;
          border-top: 1px solid var(--line); font-size: 13px; }
  .srow .nm { font-weight: 600; min-width: 150px; }
  .srow .verdict-tag { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
                       margin-left: 8px; }
  .srow.yes .verdict-tag { color: var(--ok); }
  .srow.no .verdict-tag { color: var(--bad); }
  .srow.unknown .verdict-tag { color: var(--muted); }
  .srow ul { margin: 2px 0 0; padding-left: 15px; color: var(--muted); font-size: 12px; }
  .srow li.minus { color: var(--warn); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Trail Cameras</h1>
      <div class="sub" id="sub"></div>
    </div>
    <div class="sub" id="plan"></div>
    <a class="tonight" id="tonightLink" href="/tonight" hidden>Tonight &rarr;</a>
  </header>
  <div id="alerts"></div>
  <h2 class="section" style="margin-top:0">Best sits ahead</h2>
  <div id="planArea"></div>
  <h2 class="section">Which stands earn their keep</h2>
  <div id="windArea"></div>
  <h2 class="section">Review photos <a class="reviewlink" id="reviewLink" href="/review">tag what is in them &rarr;</a></h2>
  <div id="reviewArea"></div>
  <h2 class="section">Where to sit</h2>
  <div id="standPlan"></div>
  <h2 class="section">Cameras</h2>
  ${mapMarkup}
  <div class="grid" id="cards"></div>
  <h2 class="section">Recent photos</h2>
  <div id="photoArea"></div>
</div>
<script type="application/json" id="data">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c;
  if (x !== undefined) n.textContent = x; return n; };
const fmtDate = s => { if (!s) return 'never';
  const d = new Date(s); return isNaN(d) ? 'never' : d.toLocaleDateString(); };

document.getElementById('sub').textContent =
  D.cameras.length + ' camera' + (D.cameras.length === 1 ? '' : 's') +
  ' \u00b7 synced ' + new Date(D.generatedAt).toLocaleString();
const planned = D.cameras.find(c => c.plan);
if (planned) document.getElementById('plan').textContent =
  planned.plan + ' plan \u00b7 ' + planned.photoCount + '/' + planned.photoLimit + ' photos this cycle';

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

${mapScript}

// ---- alerts -----------------------------------------------------------
const bad = D.cameras.filter(c => c.health.level !== 'ok');
if (bad.length) {
  const box = el('div', 'alert');
  box.appendChild(el('h2', null, 'Needs attention'));
  const ul = el('ul');
  for (const c of bad) ul.appendChild(el('li', null, c.name + ' \u2014 ' + c.health.notes.join(', ')));
  box.appendChild(ul);
  document.getElementById('alerts').appendChild(box);
}
// ---- which stands earn their keep -------------------------------------
// A stand's good winds decide whether you can sit it TONIGHT. This answers the
// other question: across a whole season, how often is it huntable at all? On
// Kent's ground the westerly quadrant carries most of the huntable hours, so a
// WNW stand earns its keep and an easterly one sits idle.
const windArea = document.getElementById('windArea');

// Sequential ramp, read from the theme so light and dark each get their own
// validated steps. One hue on purpose: this is a single series comparing
// MAGNITUDE, which is a sequential job — sixteen different hues would imply
// sixteen different KINDS of thing rather than sixteen amounts of one.
const ROSE_RAMP = ['var(--rose-1)', 'var(--rose-2)', 'var(--rose-3)',
                   'var(--rose-4)', 'var(--rose-5)'];

function roseSvg(ranked, size) {
  const cx = size / 2, cy = size / 2;
  const pad = 26;
  const rMax = size / 2 - pad;
  const peak = Math.max(...ranked.map(r => r.pct), 1);
  const byPoint = Object.fromEntries(ranked.map(r => [r.point, r.pct]));
  const points = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

  const parts = [];
  // Grid first, so it sits UNDER the data and stays recessive.
  for (const frac of [0.5, 1]) {
    parts.push('<circle class="ring" cx="' + cx + '" cy="' + cy + '" r="' + (rMax * frac).toFixed(1) + '"></circle>');
  }
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 - Math.PI / 2;
    parts.push('<line class="spoke" x1="' + cx + '" y1="' + cy
      + '" x2="' + (cx + Math.cos(a) * rMax).toFixed(1)
      + '" y2="' + (cy + Math.sin(a) * rMax).toFixed(1) + '"></line>');
  }

  // A 2px surface gap between neighbouring petals, as the mark spec asks: the
  // stroke is the panel colour, so adjacent fills never touch.
  const step = 2 * Math.PI / 16;
  points.forEach((p, i) => {
    const pct = byPoint[p] ?? 0;
    if (pct <= 0) return;
    const r = rMax * (pct / peak);
    const mid = i * step - Math.PI / 2;
    const a0 = mid - step / 2, a1 = mid + step / 2;
    const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
    const shade = ROSE_RAMP[Math.min(ROSE_RAMP.length - 1,
      Math.floor((pct / peak) * ROSE_RAMP.length))];
    parts.push('<path class="petal" fill="' + shade + '" d="M' + cx + ' ' + cy
      + ' L' + x0.toFixed(1) + ' ' + y0.toFixed(1)
      + ' A' + r.toFixed(1) + ' ' + r.toFixed(1) + ' 0 0 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1)
      + ' Z"><title>' + p + ' \u2014 ' + pct + '% of huntable hours</title></path>');
  });

  // Cardinals only. A label on all sixteen is the "number on every point"
  // anti-pattern; the exact values live in the hover and in the list beside it.
  [['N', 0], ['E', 1], ['S', 2], ['W', 3]].forEach(([label, i]) => {
    const a = i * Math.PI / 2 - Math.PI / 2;
    parts.push('<text class="cardinal" x="' + (cx + Math.cos(a) * (rMax + 13)).toFixed(1)
      + '" y="' + (cy + Math.sin(a) * (rMax + 13)).toFixed(1) + '">' + label + '</text>');
  });
  return '<svg class="rose" viewBox="0 0 ' + size + ' ' + size + '" role="img" '
    + 'aria-label="How often each wind blows during huntable hours">' + parts.join('') + '</svg>';
}

async function loadWindHistory() {
  if (!D.live) {
    windArea.appendChild(el('div', 'empty', 'Wind history needs the server.'));
    return;
  }
  windArea.appendChild(el('div', 'empty', 'Reading seven years of weather history\u2026'));
  let w;
  try {
    const res = await fetch('/api/wind-history');
    w = await res.json();
    if (!res.ok) throw new Error(w.error || 'wind history failed');
  } catch (err) {
    windArea.textContent = '';
    windArea.appendChild(el('div', 'empty', 'Wind history unavailable: ' + err.message));
    return;
  }
  windArea.textContent = '';

  const wrap = el('div', 'windwrap');
  const rose = el('div');
  rose.innerHTML = roseSvg(w.ranked, 300);
  rose.appendChild(el('div', 'windnote',
    w.hours.toLocaleString() + ' huntable hours across ' + w.years + ' seasons'));
  wrap.appendChild(rose);

  const right = el('div');
  const bars = el('div', 'windbars');
  const cov = w.coverage;
  const peak = Math.max(...cov.stands.map(s => s.pct || 0), 1);
  for (const st of cov.stands) {
    const row = el('div', 'wbar' + (st.pct === null ? ' unset' : ''));
    row.appendChild(el('div', 'nm', st.name));
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = st.pct === null ? '0%' : (100 * st.pct / peak) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    // Unknown is shown as unknown. A stand whose winds have not been recorded
    // is not a stand that is huntable zero percent of the time.
    row.appendChild(el('div', 'val', st.pct === null ? 'winds not set' : st.pct + '%'));
    row.title = st.pct === null
      ? 'Set this stand\u2019s good winds and it can be ranked'
      : st.winds.join(', ') + ' \u2014 AM ' + st.amPct + '%, PM ' + st.pmPct + '%';
    bars.appendChild(row);
  }
  right.appendChild(bars);

  const note = el('div', 'windnote');
  if (cov.seasonCovered !== null) {
    note.innerHTML = 'Your stands cover <b>' + cov.seasonCovered
      + '%</b> of huntable hours between them.';
  }
  if (cov.gaps.length) {
    const g = el('div', 'gap');
    g.textContent = 'No stand works on '
      + cov.gaps.map(x => x.point + ' (' + x.pct + '%)').join(', ')
      + ' \u2014 together '
      + Math.round(10 * cov.gaps.reduce((a, x) => a + x.pct, 0)) / 10
      + '% of the season.';
    note.appendChild(g);
  }
  if (cov.unsetStands) {
    note.appendChild(el('div', null,
      plural(cov.unsetStands, 'stand') + ' still ' + (cov.unsetStands === 1 ? 'has' : 'have')
      + ' no winds recorded, so ' + (cov.unsetStands === 1 ? 'it is' : 'they are') + ' not counted.'));
  }
  right.appendChild(note);
  wrap.appendChild(right);
  windArea.appendChild(wrap);
}
loadWindHistory();
// ---- review queue -----------------------------------------------------
// A pointer to the screen where photos become data. Everything downstream —
// buck identity, movement, the camera term in the stand ranking — waits on
// somebody having looked at a frame and said what was in it.
const reviewArea = document.getElementById('reviewArea');
const reviewLink = document.getElementById('reviewLink');

async function loadReviewCount() {
  if (!D.live) {
    reviewLink.style.display = 'none';
    reviewArea.appendChild(el('div', 'empty', 'Tagging needs the server.'));
    return;
  }
  try {
    const data = await (await fetch('/api/visits?unreviewed=1&limit=1')).json();
    reviewArea.textContent = '';
    if (!data.remaining) {
      reviewArea.appendChild(el('div', 'empty',
        data.visits.length === 0 && !data.remaining
          ? 'No photos to review. They appear here after a sync brings some in.'
          : 'All caught up \u2014 every visit has been looked at.'));
      return;
    }
    const box = el('div', 'sitplan');
    box.appendChild(el('h3', null,
      plural(data.remaining, 'visit') + ' waiting to be tagged'));
    box.appendChild(el('div', 'verdict',
      'A visit is one animal\u2019s appearance, not one frame \u2014 these cameras '
      + 'fire two frames per trigger, so you tag once per visit rather than once '
      + 'per photo.'));
    const go = el('a', null, 'Start reviewing \u2192');
    go.href = '/review';
    go.style.color = 'var(--accent)';
    go.style.fontWeight = '600';
    go.style.textDecoration = 'none';
    box.appendChild(go);
    reviewArea.appendChild(box);
  } catch {
    reviewArea.appendChild(el('div', 'empty', 'Could not load the review queue.'));
  }
}
loadReviewCount();
// ---- where to sit -----------------------------------------------------
// The planner ranks WHEN. This ranks WHERE within one of those windows, which
// is the question you act on while putting your boots by the door.
const tonightLink = document.getElementById('tonightLink');
if (D.live && tonightLink) tonightLink.hidden = false;

const standPlanEl = document.getElementById('standPlan');

async function loadStandPlan() {
  if (!D.live) {
    standPlanEl.appendChild(el('div', 'empty',
      'Stand ranking needs the server \u2014 open http://127.0.0.1:8787'));
    return;
  }
  let data;
  try {
    data = await (await fetch('/api/stand-plan?sits=3')).json();
  } catch {
    standPlanEl.appendChild(el('div', 'empty', 'Could not load the stand ranking.'));
    return;
  }
  standPlanEl.textContent = '';
  if (data.note) standPlanEl.appendChild(el('div', 'stale-note', data.note));
  if (!data.sits.length) return;

  for (const sit of data.sits) {
    const box = el('div', 'sitplan');
    const d = new Date(sit.date + 'T12:00:00');
    box.appendChild(el('h3', null,
      d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' ' + sit.window + ' \u2014 ' + sit.rating + ', wind ' + sit.windFrom));
    box.appendChild(el('div', 'verdict', sit.summary));

    for (const st of sit.stands) {
      const cls = st.huntable === true ? 'yes' : st.huntable === false ? 'no' : 'unknown';
      const row = el('div', 'srow ' + cls);
      const left = el('div');
      left.appendChild(el('span', 'nm', st.name));
      // "Unknown" is shown as unknown, never as a quiet yes: a stand whose
      // winds have not been recorded must not look like one that works.
      left.appendChild(el('span', 'verdict-tag',
        st.huntable === true ? 'huntable' : st.huntable === false ? 'wrong wind' : 'winds not set'));
      const ul = document.createElement('ul');
      for (const r of st.reasons) {
        const li = el('li', r.points < 0 ? 'minus' : null,
          r.why + (r.points ? ' (' + (r.points > 0 ? '+' : '') + r.points + ')' : ''));
        ul.appendChild(li);
      }
      left.appendChild(ul);
      row.appendChild(left);
      box.appendChild(row);
    }
    standPlanEl.appendChild(box);
  }
}
loadStandPlan();
// ---- camera cards -----------------------------------------------------
const MIXED_BRANDS = new Set(D.cameras.map(c => c.provider).filter(Boolean)).size > 1;
const cards = document.getElementById('cards');
const meter = (pct, colour) => {
  const b = el('div', 'bar'), i = el('i');
  i.style.width = Math.max(0, Math.min(100, pct)) + '%';
  i.style.background = colour; b.appendChild(i); return b;
};
const line = (k, v) => { const r = el('div', 'row');
  r.append(el('span', null, k), typeof v === 'string' ? el('span', null, v) : v); return r; };

for (const c of D.cameras) {
  const card = el('div', 'card ' + c.health.level);
  card.id = 'cam-' + c.id;
  card.appendChild(el('h3', null, c.name));
  // Name the brand only when more than one is present. On a single-brand
  // account it would be the same word on every card, which is just noise.
  const brand = MIXED_BRANDS && c.provider
    ? c.provider.charAt(0).toUpperCase() + c.provider.slice(1) : null;
  card.appendChild(el('div', 'model',
    [brand, c.model, c.signalType].filter(Boolean).join(' \u00b7 ') || '\u2014'));

  if (typeof c.battery === 'number') {
    const v = el('span', null, c.battery + '%' + (c.batteryLevel ? ' (' + c.batteryLevel + ')' : ''));
    card.appendChild(line('Battery', v));
    card.appendChild(meter(c.battery,
      c.battery <= 10 ? 'var(--bad)' : c.battery <= 30 ? 'var(--warn)' : 'var(--ok)'));
  }
  if (typeof c.signal === 'number') {
    card.appendChild(line('Signal', c.signal + '%' +
      (c.signalBars !== null ? ' \u00b7 ' + c.signalBars + ' bars' : '')));
    card.appendChild(meter(c.signal, 'var(--accent)'));
  }
  if (typeof c.tempValue === 'number')
    card.appendChild(line('Temperature', c.tempValue + '\u00b0' + (c.tempUnit || '')));
  if (typeof c.memUsed === 'number' && typeof c.memSize === 'number')
    card.appendChild(line('SD card', c.memUsed + ' / ' + c.memSize + ' MB'));
  card.appendChild(line('Last contact', fmtDate(c.lastSeen) +
    (c.health.age !== null ? ' (' + c.health.age + 'd)' : '')));

  if (typeof c.lat === 'number') {
    const a = document.createElement('a');
    a.className = 'coord';
    a.href = 'https://www.openstreetmap.org/?mlat=' + c.lat + '&mlon=' + c.lng + '#map=17/' + c.lat + '/' + c.lng;
    a.target = '_blank'; a.rel = 'noopener';
    a.textContent = c.lat.toFixed(6) + ', ' + c.lng.toFixed(6);
    card.appendChild(line('Location', a));
  }
  const t = el('span', 'tag ' + c.health.level,
    c.health.level === 'ok' ? 'healthy' : c.health.notes.join(' \u00b7 '));
  card.appendChild(t);
  cards.appendChild(card);
}
// ---- hunt plan --------------------------------------------------------
const planArea = document.getElementById('planArea');
if (!D.plan || !D.plan.sits || !D.plan.sits.length) {
  planArea.appendChild(el('div', 'empty',
    'No hunt plan yet. Run "node hunt-planner.mjs" to rank the coming sits by weather, rut phase and moon — it needs no photos, only your camera locations.'));
} else {
  // A forecast goes off quickly, so say plainly when the plan was built rather
  // than presenting week-old weather as if it were current.
  const built = new Date(D.plan.generatedAt);
  const hrs = (Date.now() - built.getTime()) / 3600000;
  if (hrs > 12) {
    planArea.appendChild(el('div', 'stale-note',
      'This plan was built ' + (hrs < 48 ? Math.round(hrs) + ' hours' : Math.round(hrs / 24) + ' days')
      + ' ago. Re-run "node hunt-planner.mjs" for a current forecast.'));
  }
  for (const s of D.plan.sits.slice(0, 8)) {
    const row = el('div', 'sit r' + '-' + s.rating.toLowerCase());
    const sc = el('div');
    sc.appendChild(el('div', 'score', String(Math.round(s.total))));
    sc.appendChild(el('span', 'rating', s.rating));
    const body = el('div');
    const when = new Date(s.start);
    body.appendChild(el('div', 'when',
      when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
      + ' · ' + s.window + ' from '
      + when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      + ' · ' + s.camera));
    body.appendChild(el('div', 'cond',
      Math.round(s.temp) + '°F · wind ' + s.windFrom + ' ' + Math.round(s.wind)
      + ' mph · ' + s.rut + ' · ' + s.moon + ' moon'
      + (s.alsoAt && s.alsoAt.length
        ? ' · same window also scored at ' + s.alsoAt.join(', ') : '')));
    const ul = el('ul');
    // A plan written by an older version of the planner, or edited by hand, may
    // not carry the reason breakdown. Missing reasons should cost you the
    // reasons, not the whole page — this threw and blanked everything below it.
    for (const p of s.parts ?? []) {
      const li = el('li', p.points < 0 ? 'neg' : null,
        (p.points > 0 ? '+' : '') + p.points + '  ' + p.reason);
      ul.appendChild(li);
    }
    body.appendChild(ul);
    row.append(sc, body);
    planArea.appendChild(row);
  }
  planArea.appendChild(el('div', 'sub',
    'Wind direction is where the wind comes FROM. This ranks WHEN to sit; you still choose WHERE.'));
}
// ---- photos -----------------------------------------------------------
const area = document.getElementById('photoArea');
if (!D.photos.length) {
  const why = D.cameras.every(c => c.health.age !== null && c.health.age >= D.staleDays)
    ? 'Every camera has been silent for months, so there is nothing to download. Photos will appear here after the cameras start transmitting again and you re-run the sync.'
    : 'No photos have been synced yet. Run the script without --dry-run to download them.';
  area.appendChild(el('div', 'empty', why));
} else {
  const g = el('div', 'photos');
  for (const p of D.photos.slice(0, 60)) {
    const f = document.createElement('figure');
    const i = new Image(); i.src = p.file; i.alt = p.cameraName + ' ' + fmtDate(p.date);
    i.loading = 'lazy';
    const cap = el('figcaption', null,
      p.cameraName + ' \u00b7 ' + fmtDate(p.date) + (p.tags && p.tags.length ? ' \u00b7 ' + p.tags.join(', ') : ''));
    f.append(i, cap); g.appendChild(f);
  }
  area.appendChild(g);
}
</script>
</body>
</html>
`;
}

export {
  dashboardHtml, healthOf, fmtLoc, fmtPct, daysSince, STALE_DAYS,
};
