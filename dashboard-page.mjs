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
import { registerSnippet } from './offline.mjs';
// Only the constant: the number of bits in a photo fingerprint, baked into
// the wind-match percentage. The page never hashes — review does that.
import { HASH_BITS } from './phash.mjs';

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
                       markers = [], tileSources = null, fields = []) {
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
    fields,
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
  /* Scoped to the top bar now that the header is one; the old header-element
     scoping quietly dropped these to bare blue links when the layout moved. */
  #topbar .tonight { align-self: center; white-space: nowrap;
    color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600;
    border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px;
    background: var(--panel); }
  #topbar .tonight:hover { border-color: var(--accent); }
  /* A GPS fix well older than the camera's last contact: the pin may be on
     ground the camera has left. Warn-coloured rather than hidden. */
  .gpsold { color: var(--warn); }
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
  /* A camera's own latest photos, on its card. A strip rather than a grid,
     because the card is narrow and the point is a glance — the big grid and
     the review screen exist for actually working through them. Scrolls
     sideways past what fits rather than growing the card. */
  .campics { display: flex; gap: 4px; margin-top: 10px; overflow-x: auto; }
  .campics a { flex: 0 0 auto; }
  .campics img { height: 54px; width: auto; border-radius: 5px; display: block;
                 border: 1px solid var(--line); }
  .campics-note { font-size: 11px; color: var(--muted); margin-top: 5px; }
  .campics-note a { color: var(--accent); }
  /* The lightbox: one photo at full size, over everything (the drawer sits
     at z 40). Click a photo anywhere — the grid or a camera card's strip —
     and it expands; the on-screen arrows, the arrow keys, or a swipe walk
     the list it came from. */
  .lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(10,12,8,.93);
              display: flex; flex-direction: column; align-items: center;
              justify-content: center; }
  .lightbox img { max-width: 96vw; max-height: 82vh; border-radius: 6px;
                  box-shadow: 0 8px 40px rgba(0,0,0,.6); }
  .lightbox .lb-cap { color: #e8ebe4; font-size: 13px; margin-top: 12px;
                      max-width: 92vw; text-align: center; }
  .lightbox .lb-cap .lb-n { color: #9aa294; margin-left: 8px;
                            font-variant-numeric: tabular-nums; }
  .lightbox button { position: absolute; border: 0; background: rgba(0,0,0,.4);
                     color: #fff; cursor: pointer; border-radius: 8px;
                     font: 700 26px/1 ui-sans-serif, system-ui, sans-serif; }
  .lightbox button:disabled { opacity: .25; cursor: default; }
  .lightbox .lb-x { top: 14px; right: 14px; width: 44px; height: 44px; font-size: 20px; }
  /* Tall, phone-sized hit areas: this gets used with cold thumbs. */
  .lightbox .lb-prev, .lightbox .lb-next { top: 50%; transform: translateY(-50%);
                     width: 52px; height: 96px; }
  .lightbox .lb-prev { left: 10px; }
  .lightbox .lb-next { right: 10px; }
  .photos figure { cursor: zoom-in; }
  .campics img { cursor: zoom-in; }
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

  /* ---- full-screen layout -------------------------------------------------
     The map used to be one card among many, 420px tall, with the report
     stacked around it. It is the thing this page IS — every tool on it needs
     ground to breathe — so it now fills the viewport, and the report slides in
     from the right instead of living underneath. Written as overrides after
     the shared map styles rather than edits to them, because the map CSS is
     shared text and the other pages still embed it un-fullscreened. */
  :root { --glass: rgba(255,255,255,.86); }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --glass: rgba(24,27,20,.86); }
  }
  html, body { height: 100%; }
  #map { position: fixed; inset: 0; height: auto; margin: 0;
         border: none; border-radius: 0; z-index: 0; }
  /* The slim bar across the top. Translucent so the map reads as running
     underneath it rather than stopping at it. */
  #topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 20;
            display: flex; align-items: center; justify-content: space-between;
            gap: 10px; padding: 6px 12px; background: var(--glass);
            border-bottom: 1px solid var(--line);
            backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px); }
  #topbar h1 { font-size: 15px; display: inline; margin: 0 8px 0 0; }
  .tb-id { min-width: 0; white-space: nowrap; overflow: hidden;
           text-overflow: ellipsis; }
  .tb-id .sub { display: inline; margin-right: 8px; font-size: 12px; }
  .tb-links { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
  #drawerBtn { padding: 6px 11px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
               border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
               background: var(--panel); color: var(--ink); }
  #drawerBtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  /* The ground switcher: which piece of land the map is looking at. Appears
     only once there are two grounds to choose between, so a single property
     never sees it. Capped in width so two long names cannot push the Camp
     report button off a phone screen. */
  #groundSel { max-width: 34vw; padding: 6px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
               border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
               background: var(--panel); color: var(--ink); }
  #groundName { width: 160px; max-width: 34vw; padding: 6px 8px;
                font: 12px/1 ui-sans-serif, system-ui, sans-serif;
                border: 1px solid var(--accent); border-radius: 6px;
                background: var(--panel); color: var(--ink); }
  /* On a phone the bar has no room for a fourth control — measured: the
     switcher pushed Camp report clean off a 390px screen, and a chip under
     the bar covered the Tools button (also measured; that corner is taken).
     Bottom-centre is the one clear spot — the layer swatch owns bottom-left,
     attribution bottom-right — and it is where a thumb already is. */
  /* 78px up, not 30: the bottom-centre is now a stack — the wrapped
     attribution pill along the very edge, the weather chip above it at 40px
     (both measured at 390px, where each lower offset collided), and the
     switcher on top. All three stay readable and tappable. */
  @media (max-width: 560px) {
    #groundSel, #groundName { position: fixed; top: auto; bottom: 78px;
                              left: 50%; transform: translateX(-50%); z-index: 6;
                              max-width: 46vw;
                              box-shadow: 0 1px 6px rgba(0,0,0,.35); }
    /* The open weather bar needs the bottom-centre the switcher floats in;
       the switcher steps aside for exactly as long as the bar is up. Phone
       width only — in the top bar the two never meet. */
    #groundSel.under-wxbar { visibility: hidden; }
  }
  /* Everything pinned to the map's top edge drops below the bar. */
  .zoom { top: 52px; }
  .maptools { top: 52px; }
  .standform.aside { top: 52px; }
  /* The report: the whole old page, in a drawer. Scrolls on its own, so a
     long camera list never moves the map behind it. */
  #drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 40;
            width: min(460px, 94vw); background: var(--bg);
            border-left: 1px solid var(--line);
            box-shadow: -10px 0 34px rgba(0,0,0,.35);
            overflow-y: auto; padding: 0 18px 48px;
            transform: translateX(103%); transition: transform .22s ease;
            overscroll-behavior: contain; }
  #drawer.open { transform: none; }
  .drawhead { position: sticky; top: 0; z-index: 2; display: flex;
              align-items: center; justify-content: space-between;
              margin: 0 -18px 10px; padding: 10px 18px;
              background: var(--glass); border-bottom: 1px solid var(--line);
              backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px); }
  .drawhead h2 { margin: 0; font-size: 15px; }
  .drawhead button { border: none; background: none; color: var(--muted);
                     font-size: 22px; line-height: 1; cursor: pointer; padding: 2px 6px; }
  .drawhead button:hover { color: var(--ink); }
  /* Attribution moves onto the map, where the map now is. */
  .attrib { position: fixed; right: 8px; bottom: 4px; z-index: 6; margin: 0;
            padding: 2px 8px; border-radius: 5px; background: var(--glass);
            font-size: 10px; }
</style>
</head>
<body>
${mapMarkup}
<div id="topbar">
  <div class="tb-id">
    <h1>Trail Cameras</h1>
    <div class="sub" id="sub"></div>
    <div class="sub" id="plan"></div>
  </div>
  <div class="tb-links">
    <select id="groundSel" hidden title="Which ground to look at"></select>
    <a class="tonight first" id="tonightLink" href="/tonight" hidden>Tonight &rarr;</a>
    <a class="tonight" id="journalLink" href="/journal" hidden>Journal</a>
    <button id="drawerBtn" type="button">Camp report</button>
  </div>
</div>
<div id="drawer">
  <div class="drawhead">
    <h2>Camp report</h2>
    <button id="drawerClose" type="button" title="Close">&times;</button>
  </div>
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
  <div class="grid" id="cards"></div>
  <h2 class="section">Recent photos</h2>
  <div id="photoArea"></div>
</div>
<script type="application/json" id="data">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
if (D.live) { ${registerSnippet().trim()} }
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c;
  if (x !== undefined) n.textContent = x; return n; };
const fmtDate = s => { if (!s) return 'never';
  const d = new Date(s); return isNaN(d) ? 'never' : d.toLocaleDateString(); };
/** Whole days between two instants, or null if either is unusable. Used to
 *  age a GPS fix against the camera's own last contact rather than against
 *  today, so a camera silent for a month is not accused of a stale fix. */
const daysBetween = (a, b) => {
  const t1 = Date.parse(a || ''), t2 = Date.parse(b || '');
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.floor((t2 - t1) / 86400000);
};

document.getElementById('sub').textContent =
  D.cameras.length + ' camera' + (D.cameras.length === 1 ? '' : 's') +
  ' \u00b7 synced ' + new Date(D.generatedAt).toLocaleString();
const planned = D.cameras.find(c => c.plan);
if (planned) document.getElementById('plan').textContent =
  planned.plan + ' plan \u00b7 ' + planned.photoCount + '/' + planned.photoLimit + ' photos this cycle';

// ---- the report drawer -------------------------------------------------
// The old page, on demand. Open it, find your card, close it, and the map is
// exactly where you left it — the drawer scrolls on its own.
const drawer = document.getElementById('drawer');
const drawerBtn = document.getElementById('drawerBtn');
const setDrawer = open => {
  drawer.classList.toggle('open', open);
  drawerBtn.classList.toggle('on', open);
};
drawerBtn.onclick = () => setDrawer(!drawer.classList.contains('open'));
document.getElementById('drawerClose').onclick = () => setDrawer(false);
/** Open the drawer and bring one element into view — how a pin reaches its card. */
function revealInDrawer(id) {
  setDrawer(true);
  // After the slide-in, or the scroll math runs against a drawer that is
  // still off-screen and lands somewhere arbitrary.
  setTimeout(() => document.getElementById(id)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 240);
}

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
const journalLink = document.getElementById('journalLink');
if (D.live && journalLink) journalLink.hidden = false;

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
// ---- lightbox ---------------------------------------------------------
// Click a photo and it expands over the page; the arrows, the arrow keys, or
// a swipe walk the list. WHICH list is the click site's call — the drawer
// grid hands over every downloaded photo, a camera's strip hands over that
// camera's — so the navigation matches what you were already looking at.
let lb = null;   // { list, i, img, capText, n, prev, next, el, onKey } while open

// What is known about a frame, said once, the same way everywhere a photo is
// captioned: your confirmed tags as fact, the camera's unconfirmed words as a
// claim, and the wind match with its measured number \u2014 a real similarity to
// frames you reviewed as empty, never an invented confidence.
function photoSay(p) {
  const parts = [];
  if (p.confirmed) parts.push(p.confirmed);
  if (p.claims) parts.push('camera thinks: ' + p.claims);
  if (p.wind) {
    parts.push('likely wind \u00b7 ' + Math.round((${HASH_BITS} - p.wind.bits) / ${HASH_BITS} * 100)
      + '% match to ' + p.wind.of + ' reviewed-empty frame' + (p.wind.of === 1 ? '' : 's'));
  }
  return parts.length ? ' \u00b7 ' + parts.join(' \u00b7 ') : '';
}

function lbShow(i) {
  lb.i = i;
  const p = lb.list[i];
  lb.img.src = p.file;
  lb.img.alt = p.cameraName + ' ' + fmtDate(p.date);
  lb.capText.textContent = p.cameraName + ' \u00b7 ' + fmtDate(p.date) + photoSay(p);
  lb.n.textContent = (i + 1) + ' of ' + lb.list.length;
  // The ends stop rather than wrap: a loop makes "have I seen them all?"
  // unanswerable, and on a stand check that is the whole question.
  lb.prev.disabled = i === 0;
  lb.next.disabled = i === lb.list.length - 1;
  // The neighbours are fetched while this one is on screen, so the next
  // press is instant — and since every photo passes through the service
  // worker on its way, each one looked at is one more saved for the woods.
  for (const j of [i - 1, i + 1]) {
    if (lb.list[j] && lb.list[j].file) { const pre = new Image(); pre.src = lb.list[j].file; }
  }
}

function closeLightbox() {
  if (!lb) return;
  removeEventListener('keydown', lb.onKey);
  lb.el.remove();
  lb = null;
}

function openLightbox(list, i) {
  closeLightbox();
  const box = el('div', 'lightbox');
  const img = new Image();
  img.draggable = false;             // a swipe must not become an image drag
  const cap = el('div', 'lb-cap');
  const capText = el('span');
  const n = el('span', 'lb-n');
  cap.append(capText, n);
  const mk = (cls, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = label;
    b.onclick = ev => { ev.stopPropagation(); fn(); };
    return b;
  };
  const prev = mk('lb-prev', '\u2039', () => { if (lb.i > 0) lbShow(lb.i - 1); });
  const next = mk('lb-next', '\u203a', () => { if (lb.i < lb.list.length - 1) lbShow(lb.i + 1); });
  const x = mk('lb-x', '\u00d7', closeLightbox);
  box.append(img, cap, prev, next, x);
  // The backdrop closes; the photo itself does not, because a tap on the
  // picture is how a phone zooms about, not a request to leave.
  box.onclick = ev => { if (ev.target === box) closeLightbox(); };
  const onKey = ev => {
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === 'ArrowLeft' && lb.i > 0) lbShow(lb.i - 1);
    else if (ev.key === 'ArrowRight' && lb.i < lb.list.length - 1) lbShow(lb.i + 1);
  };
  addEventListener('keydown', onKey);
  // A swipe is the phone's arrow key; pointer events make it a mouse drag
  // too, which costs nothing.
  let downX = null;
  box.onpointerdown = ev => { downX = ev.clientX; };
  box.onpointerup = ev => {
    if (downX === null) return;
    const dx = ev.clientX - downX;
    downX = null;
    if (dx > 40 && lb.i > 0) lbShow(lb.i - 1);
    else if (dx < -40 && lb.i < lb.list.length - 1) lbShow(lb.i + 1);
  };
  document.body.appendChild(box);
  lb = { list, i, img, capText, n, prev, next, el: box, onKey };
  lbShow(i);
}

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

// One builder for a camera's card, wherever it is shown. The map's select
// panel shows the same card for a clicked pin, and two renderings of one
// camera is how they would end up disagreeing about battery life. The id
// goes only on the report drawer's copy — ids must stay unique, and the
// drawer's is the one revealInDrawer scrolls to.
function cameraCard(c, { withId = true } = {}) {
  const card = el('div', 'card ' + c.health.level);
  if (withId) card.id = 'cam-' + c.id;
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
    // WHEN that position was fixed, which is not the same as when the camera
    // last checked in. A camera that has been moved keeps reporting battery,
    // signal and photos from its new spot while its GPS fix stays weeks old,
    // and the pin sits where it used to be with nothing on screen saying so —
    // the exact way this went unnoticed. A fix much older than the last
    // contact is called out rather than merely printed.
    if (c.gpsFix) {
      const fixAge = daysBetween(c.gpsFix, c.lastSeen);
      const stale = fixAge !== null && fixAge >= 7;
      const v = el('span', stale ? 'gpsold' : null, fmtDate(c.gpsFix)
        + (stale ? ' — ' + fixAge + 'd before its last contact' : ''));
      v.title = stale
        ? 'The camera has reported since, but not a new position. If you have '
          + 'moved it, the pin is still on the old spot.'
        : 'When the camera last fixed its own position.';
      card.appendChild(line('GPS fix', v));
    }
  }
  const t = el('span', 'tag ' + c.health.level,
    c.health.level === 'ok' ? 'healthy' : c.health.notes.join(' \u00b7 '));
  card.appendChild(t);

  // What this camera has seen lately, on the card itself — the map's select
  // panel shows this same card, so clicking a pin answers "any deer here?"
  // without a trip to the drawer.
  //
  // Filtered from the photos the page already carries rather than fetched:
  // D.photos is the newest 200 across the account, which is plenty for a
  // strip. Only DOWNLOADED photos are drawn. A photo the sync has listed but
  // not fetched has only the vendor's own URL, and an <img> pointing there
  // would make the page contact an external host directly — which the
  // offline test forbids, and which would break the strip in the woods.
  const listed = D.photos.filter(p => p.cameraId === c.id);
  const mine = listed.filter(p => p.file);
  if (mine.length) {
    const strip = el('div', 'campics');
    mine.slice(0, 8).forEach((p, idx) => {
      const a = document.createElement('a');
      // The href survives for a middle-click or long-press; a plain click
      // stays on the page and expands the photo instead. The strip shows the
      // latest eight, but the arrows keep going through everything this
      // camera has on disk.
      a.href = p.file;
      a.onclick = ev => { ev.preventDefault(); openLightbox(mine, idx); };
      const i = new Image();
      i.src = p.file; i.loading = 'lazy';
      i.alt = c.name + ' ' + fmtDate(p.date);
      i.title = fmtDate(p.date) + photoSay(p);
      a.appendChild(i);
      strip.appendChild(a);
    });
    card.appendChild(strip);
    // No claim of a total: D.photos is the newest 200 across the account, so
    // this camera's count within it is not its lifetime tally, and "8 of 41"
    // would read as one.
    const shown = Math.min(8, mine.length);
    const note = el('div', 'campics-note',
      (mine.length > shown ? 'Latest ' + shown + ' photos' : plural(shown, 'photo'))
      + ' here \u00b7 newest ' + fmtDate(mine[0].date) + (D.live ? ' \u00b7 ' : ''));
    if (D.live) {
      const rl = document.createElement('a');
      rl.href = '/review'; rl.textContent = 'tag them in Review';
      note.appendChild(rl);
    }
    card.appendChild(note);
  } else if (listed.length) {
    // Listed and downloaded are different facts, and conflating them would
    // hide the fix: the sync has SEEN these photos and not fetched them.
    card.appendChild(el('div', 'campics-note',
      listed.length + ' photo' + (listed.length === 1 ? '' : 's')
      + ' listed but not downloaded \u2014 run the sync without --dry-run.'));
  } else {
    card.appendChild(el('div', 'campics-note', 'No photos from this camera yet.'));
  }
  return card;
}
for (const c of D.cameras) cards.appendChild(cameraCard(c));
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
    // A plan may carry no usable start instant — an older planner, a hand-edited
    // file, a partial write. That should cost you the START TIME, not put
    // "Invalid Date" in the headline twice, which is what it did. The date and
    // window are always present, so they are what the row is built from.
    const when = s.start ? new Date(s.start) : null;
    const timed = when && !isNaN(when);
    // Rendered on the property's clock where the plan recorded one, so the day
    // does not shift for a reader in another timezone.
    const opts = s.timezone ? { timeZone: s.timezone } : {};
    const day = timed
      ? when.toLocaleDateString(undefined,
          Object.assign({ weekday: 'long', month: 'short', day: 'numeric' }, opts))
      : (s.date || 'date not recorded');
    body.appendChild(el('div', 'when',
      day + ' · ' + s.window
      + (timed
        ? ' from ' + when.toLocaleTimeString(undefined,
            Object.assign({ hour: 'numeric', minute: '2-digit' }, opts))
        : '')
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
  // Only photos ON DISK get a picture. A photo the sync has listed but not
  // downloaded has no file, and an <img> with a null src renders as a broken
  // icon wearing a real caption — which reads as "the app lost my photo"
  // when the truth is "the sync has not fetched this one yet". So those are
  // counted in a line instead of drawn, the same rule the camera cards use.
  const onDisk = D.photos.filter(p => p.file);
  if (onDisk.length) {
    const g = el('div', 'photos');
    onDisk.slice(0, 60).forEach((p, i) => {
      const f = document.createElement('figure');
      const im = new Image(); im.src = p.file; im.alt = p.cameraName + ' ' + fmtDate(p.date);
      im.loading = 'lazy';
      const cap = el('figcaption', null,
        p.cameraName + ' \u00b7 ' + fmtDate(p.date) + photoSay(p));
      f.append(im, cap);
      // The grid shows sixty; the arrows walk the whole list.
      f.onclick = () => openLightbox(onDisk, i);
      g.appendChild(f);
    });
    area.appendChild(g);
  }
  const listedOnly = D.photos.length - onDisk.length;
  if (listedOnly) {
    area.appendChild(el('div', onDisk.length ? 'stale-note' : 'empty',
      plural(listedOnly, 'photo') + ' listed at SpyPoint but not downloaded yet \u2014 '
      + 'the sync fetches them on its next run.'));
  }
}
</script>
</body>
</html>
`;
}

export {
  dashboardHtml, healthOf, fmtLoc, fmtPct, daysSince, STALE_DAYS,
};
