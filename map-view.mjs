/**
 * map-view.mjs — the map, and everything that lives on it.
 *
 * Split out of dashboard-page.mjs on 2026-08-28, the same way that file was
 * split out of spypoint-sync.mjs the same day. The dashboard had become a
 * 2,100-line script of which about 1,300 lines were the map: base and overlay
 * layers, panning and zoom, camera and stand pins, scouting markers, walk-in
 * routes, the measure tool, LiDAR terrain with its contours and features,
 * parcel lookup, and the offline tile cache. The dashboard proper — the
 * alerts, the wind rose, the review queue, the sit ranking, the camera cards,
 * the photo grid — is under 400 lines and was hard to find inside it.
 *
 * The boundary turned out to be almost clean. Exactly two names crossed it:
 * `plural`, a general formatting helper that happened to be declared in the
 * terrain section, and one stray line that kicked off the route fetch from
 * inside the wind-rose section. Both are dealt with rather than papered over —
 * `plural` moved to the shared preamble, the bootstrap moved back next to the
 * routes it starts.
 *
 * WHY THE PIECES ARE STRINGS. The page is one document and one script: the map
 * shares `D`, `el` and `fmtDate` with the rest of the dashboard, and pulling
 * them apart into modules would mean inventing a module loader for a page that
 * does not need one. So this file owns the map's markup, styles and script as
 * text, and the dashboard composes them. The split is in the SOURCE, which is
 * where the 1,300 lines were a problem.
 *
 * WHY String.raw. In an ordinary template literal a backslash escape resolves
 * when the page is BUILT rather than when the browser reads it, which has made
 * a generated page here a syntax error three times over, with `node --check`
 * passing each time. String.raw makes escapes literal, so what is written is
 * what the browser gets. Two consequences worth knowing:
 *
 *   - There must be no backtick below. A backtick still closes the literal.
 *   - A `\uXXXX` in a JS string now reaches the browser as an escape and is
 *     resolved there, which is the same character by a different route. In
 *     MARKUP it would not be — there is no JS parser to resolve it — so the
 *     zoom-out button uses the HTML entity instead.
 *
 * test/page-scripts.test.js compiles the composed page, so a mistake here is
 * caught rather than shipped.
 */

import { browserSource as measureSource } from './measure.mjs';

export const mapStyles = `
  .plabel { position: absolute; transform: translate(-50%, -170%); font-size: 11px;
            font-weight: 600; white-space: nowrap; padding: 1px 5px; border-radius: 4px;
            background: rgba(0,0,0,.72); color: #fff; pointer-events: none; }
  .zoom { position: absolute; right: 10px; top: 10px; display: grid; gap: 4px; z-index: 5; }
  .zoom button { width: 30px; height: 30px; font-size: 17px; cursor: pointer;
                 border: 1px solid var(--line); background: var(--panel);
                 color: var(--ink); border-radius: 6px; }
  .attrib { font-size: 11px; color: var(--muted); margin-bottom: 24px; }
  .attrib a { color: inherit; }
  .slabel { position: absolute; transform: translate(-50%, -230%); font-size: 11px;
            font-weight: 600; white-space: nowrap; padding: 1px 5px; border-radius: 4px;
            background: rgba(0,0,0,.65); color: #fff; pointer-events: none; }
  .maptools button { padding: 7px 11px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
                     border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
                     background: var(--panel); color: var(--ink);
                     box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  #terrain { opacity: .72; mix-blend-mode: multiply; }
  #contours path { fill: none; stroke: rgba(255,238,170,.55); stroke-width: 1; }
  #contours path.index { stroke: rgba(255,225,120,.95); stroke-width: 1.8; }
  #contours path.ridgeline { stroke: rgba(255,170,105,.9); stroke-width: 2.2;
                             stroke-dasharray: 7 5; stroke-linecap: round; }
  .tfeat { position: absolute; z-index: 2; pointer-events: auto; cursor: help; }
  .tfeat.saddle { width: 13px; height: 13px; transform: translate(-50%,-50%) rotate(45deg);
                  background: rgba(255,215,0,.92); border: 2px solid #3a2c00; }
  .tfeat.bench { width: 13px; height: 9px; transform: translate(-50%,-50%);
                 background: rgba(160,235,160,.92); border: 2px solid #123a12; border-radius: 2px; }
  .tlegend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .tlegend span { display: inline-flex; align-items: center; gap: 4px; }
  .tlegend i { width: 14px; height: 0; border-top-width: 3px; border-top-style: solid; }
  .ovsep { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
           color: var(--muted); padding: 6px 4px 2px; border-top: 1px solid var(--line);
           margin-top: 4px; }
  .layermenu button.ovbtn { background: none; height: auto; width: auto; padding: 4px 6px;
    font: 600 11px/1.3 ui-sans-serif, system-ui, sans-serif; color: var(--ink);
    text-align: left; border: 0; cursor: pointer; }
  .mklabel { position: absolute; transform: translate(-50%, -190%); font-size: 10px;
             white-space: nowrap; padding: 1px 4px; border-radius: 4px;
             background: rgba(0,0,0,.6); color: #fff; pointer-events: none; }
  #contours path.parcel { stroke: rgba(255,90,90,.95); stroke-width: 2.6; fill: rgba(255,90,90,.10);
                          stroke-dasharray: none; }
  #contours path.route.draft { stroke-dasharray: 6 5; }
  .measurebox .big { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
  #contours path.measure { stroke: rgba(255,235,120,.95); stroke-width: 2.6; fill: none;
                           stroke-linecap: round; stroke-linejoin: round; }
  #contours circle.measure { fill: rgba(255,235,120,.95); stroke: rgba(40,35,0,.6);
                             stroke-width: 1; }
  .routetip { position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
              z-index: 6; background: var(--panel); border: 1px solid var(--accent);
              border-radius: 8px; padding: 7px 12px; font-size: 12px; color: var(--ink);
              box-shadow: 0 2px 12px rgba(0,0,0,.35); }
  .terrainnote b { color: var(--ink); }
  .standform { position: absolute; left: 50%; top: 50%; z-index: 5;
               transform: translate(-50%, -50%); width: min(340px, 90%);
               background: var(--panel); border: 1px solid var(--line);
               border-radius: 10px; padding: 16px; box-shadow: 0 6px 28px rgba(0,0,0,.4); }
  .standform h3 { margin: 0 0 10px; font-size: 15px; }
  .standform label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; }
  .standform input, .standform select, .standform textarea {
    width: 100%; padding: 7px 9px; font: inherit; font-size: 13px; color: var(--ink);
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
  .formrow { display: flex; gap: 8px; margin-top: 14px; }
  .formrow button { flex: 1; padding: 8px; font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
                    border-radius: 6px; cursor: pointer; border: 1px solid var(--line);
                    background: var(--bg); color: var(--ink); }
  .formrow button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .formrow button.danger { color: var(--bad); }
  /* The marker form's Delete sits outside .formrow, so it needs its own rule
     rather than inheriting one scoped to that row. */
  .standform > button.danger { color: var(--bad); background: var(--bg); cursor: pointer;
    border: 1px solid var(--line); border-radius: 6px; padding: 7px 11px; font: inherit;
    font-size: 13px; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .parcelcard h4 { margin: 0 0 8px; font-size: 14px; }
  .parcelcard .close { position: absolute; right: 8px; top: 6px; cursor: pointer;
                       border: 0; background: none; color: var(--muted); font-size: 18px;
                       line-height: 1; padding: 2px 6px; }
  .swatch { width: 74px; height: 58px; padding: 0; border-radius: 6px; cursor: pointer;
            border: 2px solid #fff; box-shadow: 0 1px 5px rgba(0,0,0,.45);
            background-size: cover; background-position: center; position: relative;
            display: block; overflow: hidden; }
  .swatch span { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 0 4px;
                 font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; color: #fff;
                 text-shadow: 0 1px 3px rgba(0,0,0,.9); background: rgba(0,0,0,.35); }
  .layermenu { position: absolute; left: 0; bottom: 0; display: none; gap: 8px;
               background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
               padding: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
  .layermenu button { width: 74px; height: 58px; padding: 0; border-radius: 6px;
                      cursor: pointer; border: 2px solid transparent; overflow: hidden;
                      background-size: cover; background-position: center; position: relative; }
  .layermenu button span { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 0 4px;
                           font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; color: #fff;
                           text-shadow: 0 1px 3px rgba(0,0,0,.9); background: rgba(0,0,0,.35); }
  #map { height: 420px; border: 1px solid var(--line); border-radius: 10px;
         position: relative; overflow: hidden; background: var(--panel);
         cursor: grab; touch-action: none; margin-bottom: 8px; }
  #map.drag { cursor: grabbing; }
  #tiles img { position: absolute; width: 256px; height: 256px; user-select: none;
               -webkit-user-drag: none; }
  .pin { position: absolute; width: 18px; height: 18px; border-radius: 50%;
         border: 2px solid #fff; transform: translate(-50%, -50%);
         box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer; }
  .pin.ok { background: var(--ok); } .pin.warn { background: var(--warn); }
  .pin.bad { background: var(--bad); }
  .stand.sel { outline: 3px solid var(--warn); outline-offset: 2px; }
  .maptools button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  #map.placing { cursor: crosshair; }
  #map.terrain-on #terrain, #map.terrain-on #contours { display: block; }
  .mark.old { opacity: .45; }
  .layermenu button.ovbtn.on { color: var(--accent); }
  .measurebox .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  #contours path.measure.ring { fill: rgba(255,235,120,.14); }
  .terrainnote .warn { color: var(--warn); }
  .winds { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; margin-top: 4px; }
  .winds button { padding: 5px 0; font: 600 10px/1 ui-sans-serif, system-ui, sans-serif;
                  border: 1px solid var(--line); border-radius: 4px; cursor: pointer;
                  background: var(--bg); color: var(--muted); }
  .winds button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .parcelcard .row { display: flex; justify-content: space-between; gap: 12px;
                     padding: 3px 0; color: var(--muted); }
  .parcelcard .row b { color: var(--ink); font-weight: 600; text-align: right; }
  .layers.open .layermenu { display: flex; }
  .layers.open .swatch { visibility: hidden; }
  .layermenu button.on { border-color: var(--accent); }
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
  /* A walked track, drawn solid and cooler than the route it was meant to
     follow. The pair being visibly different is the entire value: seeing the
     drawn line and the walked line diverge is what tells you the plan was not
     what happened. */
  #contours path.track { stroke: rgba(120,205,255,.95); stroke-width: 2.6; fill: none;
                         stroke-linecap: round; stroke-linejoin: round; }
  #contours path.track.rough { stroke-dasharray: 7 4; }
  #contours path.route { stroke: rgba(190,140,255,.95); stroke-width: 3; fill: none;
                         stroke-linecap: round; stroke-linejoin: round; }
  /* The measuring readout. Sits under the tip rather than beside it, because
     the numbers change on every click and a moving box beside a moving box is
     hard to read. */
  /* Suggested stands. Deliberately a different SHAPE from a real stand pin,
     not merely a different colour: these are places to go and walk, and one
     must never be mistaken at a glance for somewhere you actually hunt. */
  .sugg { position: absolute; width: 20px; height: 20px; cursor: pointer; z-index: 3;
          transform: translate(-50%, -50%); border-radius: 3px;
          background: rgba(255,225,120,.30); border: 2px dashed #d9a441; }
  .sugg.sel { background: rgba(255,225,120,.65); border-style: solid; }
  .sugglabel { position: absolute; transform: translate(-50%, -50%); font-size: 11px;
               font-weight: 700; line-height: 1; color: #241c05; z-index: 4;
               pointer-events: none; }
  /* The line from a suggestion to the ground it watches. Without it the pin is
     a dot in a field, and the thing you most need to see — which way you would
     be looking — is invisible. */
  #contours path.sugg-look { stroke: rgba(217,164,65,.9); stroke-width: 2.2; fill: none;
                             stroke-dasharray: 5 4; }
  .suggcard { position: absolute; right: 10px; bottom: 10px; z-index: 6; width: 290px;
              max-width: calc(100% - 20px); max-height: 62%; overflow: auto;
              background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
              padding: 12px 14px; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
  .suggcard h4 { margin: 0 0 2px; font-size: 14px; padding-right: 18px; }
  .suggcard .meta { color: var(--muted); font-size: 12px; }
  .suggcard ul { margin: 8px 0 0; padding-left: 16px; font-size: 12.5px; color: var(--muted); }
  .suggcard li.minus { color: var(--warn); }
  .suggcard .caveat { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line);
                      color: var(--muted); font-size: 11.5px; }
  .suggcard .close { position: absolute; right: 8px; top: 6px; cursor: pointer;
                     background: none; border: 0; color: var(--muted); font-size: 17px; }
  .suggcard .pick { display: flex; gap: 8px; margin-top: 10px; }
  .suggcard .pick button { flex: 1; padding: 7px; border-radius: 6px;
                           font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
                           border: 1px solid var(--line); background: var(--bg);
                           color: var(--ink); cursor: pointer; }
  .suggcard .pick button.primary { background: var(--accent); color: #fff;
                                   border-color: var(--accent); }
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
`;

export const mapMarkup = String.raw`
  <div id="map"><div id="tiles"></div><canvas id="terrain"></canvas><svg id="contours"></svg><div id="pins"></div>
    <div class="zoom"><button id="zin" title="Zoom in">+</button><button id="zout" title="Zoom out">&minus;</button></div>
    <div class="maptools">
      <button id="addStand" type="button">+ Add stand</button>
      <button id="whoOwns" type="button">Who owns this?</button>
      <button id="terrainBtn" type="button">Terrain</button>
      <button id="markBtn" type="button">+ Mark sign</button>
      <button id="offlineBtn" type="button">Save offline</button>
      <button id="routeBtn" type="button">+ Walk-in route</button>
      <button id="measureBtn" type="button">Measure</button>
      <button id="suggestBtn" type="button">Suggest a stand</button>
    </div>
    <div class="layers">
      <button id="layerToggle" class="swatch" type="button" title="Change map type">
        <span id="layerLabel"></span>
      </button>
      <div class="layermenu" id="layerMenu"></div>
    </div>
  </div>
  <div class="attrib"><span id="credit"></span>. Drag to pan, scroll to zoom.</div>
`;

export const mapScript = String.raw`
${measureSource('MEASURE')}

// ---- map --------------------------------------------------------------
const TS = 256;

// Base layers, laid out like Google Maps: a Map/Satellite thumbnail toggle in
// the bottom-left corner, with Hybrid offered once satellite is showing.
//
// Google's own tiles are deliberately NOT used — serving them outside their
// Maps API breaches their terms. Esri's World Imagery is free for this kind of
// use with attribution and reaches z19 over rural Wisconsin, which is close
// enough to pick out field edges, funnels and standing crops. USGS imagery was
// measured too: sharper where it exists, but it 404s above z16 here, so it is
// offered as an option rather than the default.
// Imagery, as described by the server (see tile-sources.mjs). Templates are
// expanded here with the same substitution the server uses, so a served page
// asks its own cache and the static file talks to the tile services directly —
// with one code path either way.
const LAYERS = D.tiles.base;
const OVERLAYS = D.tiles.overlays;

const MERC = 20037508.342789244;
function tileBounds3857(z, x, y) {
  const size = 2 * MERC / 2 ** z;
  return [-MERC + x * size, MERC - (y + 1) * size,
          -MERC + (x + 1) * size, MERC - y * size].join(',');
}
const expandTile = (tpl, z, x, y) => tpl
  .replace('{z}', z).replace('{x}', x).replace('{y}', y)
  .replace('{bbox3857}', () => tileBounds3857(z, x, y));

const layerUrl = (key, z, x, y) => expandTile(LAYERS[key].template, z, x, y);
const referenceUrl = (key, z, x, y) => LAYERS[key].reference
  ? expandTile(LAYERS[key].reference, z, x, y) : null;
const overlayUrl = (key, z, x, y) => expandTile(OVERLAYS[key].template, z, x, y);

// Remembered per browser, like the base layer.
let overlayOn = new Set();
try {
  const saved = JSON.parse(localStorage.getItem('trailcam.overlays') || '[]');
  overlayOn = new Set(saved.filter(k => OVERLAYS[k]));
} catch { /* private window, or blocked site data */ }
const saveOverlays = () => {
  try { localStorage.setItem('trailcam.overlays', JSON.stringify([...overlayOn])); }
  catch { /* ignore */ }
};

// Remembered per browser. Wrapped because a private window or blocked site
// data makes storage throw rather than return null.
let layerKey = 'satellite';
try { layerKey = localStorage.getItem('trailcam.layer') || 'satellite'; } catch { /* ignore */ }
if (!LAYERS[layerKey]) layerKey = 'satellite';
const saveLayer = k => { try { localStorage.setItem('trailcam.layer', k); } catch { /* ignore */ } };
const located = D.cameras.filter(c => typeof c.lat === 'number' && typeof c.lng === 'number');
const mapEl = document.getElementById('map');
const tilesEl = document.getElementById('tiles');
const pinsEl = document.getElementById('pins');

// Web Mercator, in pixels at the current zoom.
const projX = (lng, z) => (lng + 180) / 360 * TS * 2 ** z;
const projY = (lat, z) => {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TS * 2 ** z;
};

// Where to point the map when it opens.
//
// This used to frame the cameras and nothing else, and if no camera reported
// GPS the map replaced itself with a one-line apology — taking every stand,
// marker, route and the measure tool down with it. That is backwards: a camera
// is one of the things ON the map, not the reason there is one. Somebody who
// has dropped four stands and no cameras has MORE to look at, not less.
//
// So it frames everything with coordinates, and the map is always drawn.
const framePoints = [
  ...located.map(c => [c.lng, c.lat]),
  ...(D.stands || []).map(s => [s.lng, s.lat]),
  ...(D.markers || []).map(m => [m.lng, m.lat]),
].filter(([lng, lat]) => typeof lat === 'number' && typeof lng === 'number');

// Nothing placed at all: the continental US, wide, so panning to your ground
// and dropping the first stand is possible rather than blocked.
let zoom = 4, centre = { lat: 39.5, lng: -98.35 };
if (framePoints.length) {
  const lats = framePoints.map(p => p[1]), lngs = framePoints.map(p => p[0]);
  const [m1, m2] = [Math.min(...lats), Math.max(...lats)];
  const [n1, n2] = [Math.min(...lngs), Math.max(...lngs)];
  centre = { lat: (m1 + m2) / 2, lng: (n1 + n2) / 2 };
  // Widest zoom whose pixel span still fits, so everything lands on screen.
  // A single point has no span, so this settles at 18 and is then clamped by
  // the layer's own maximum when the first draw happens.
  zoom = 16;
  for (let z = 18; z >= 2; z--) {
    const w = Math.abs(projX(n2, z) - projX(n1, z)), h = Math.abs(projY(m1, z) - projY(m2, z));
    if (w < mapEl.clientWidth - 90 && h < mapEl.clientHeight - 90) { zoom = z; break; }
  }
}

function draw() {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const cx = projX(centre.lng, zoom), cy = projY(centre.lat, zoom);
  const left = cx - W / 2, top = cy - H / 2;
  const n = 2 ** zoom;
  tilesEl.textContent = ''; pinsEl.textContent = '';
  drawTerrain(left, top, W, H);
  for (let tx = Math.floor(left / TS); tx <= Math.floor((left + W) / TS); tx++) {
    for (let ty = Math.floor(top / TS); ty <= Math.floor((top + H) / TS); ty++) {
      if (ty < 0 || ty >= n) continue;
      const L = LAYERS[layerKey];
      const wx = ((tx % n) + n) % n;
      const place = img => {
        img.alt = ''; img.loading = 'lazy';
        img.style.left = (tx * TS - left) + 'px';
        img.style.top = (ty * TS - top) + 'px';
        // Offline — in a cabin, or a tile server having a bad day — a failed
        // tile otherwise leaves a broken-image icon in every cell. Hide it and
        // let the blank panel show through; the pins are what matter and they
        // stay correctly positioned regardless.
        img.onerror = () => { img.style.display = 'none'; };
        tilesEl.appendChild(img);
      };
      const base = new Image();
      base.src = layerUrl(layerKey, zoom, wx, ty);
      place(base);
      // Hybrid draws place names and boundaries as a transparent PNG over the
      // imagery, in a second pass so it always lands on top.
      const refUrl = referenceUrl(layerKey, zoom, wx, ty);
      if (refUrl) {
        const ov = new Image();
        ov.src = refUrl;
        ov.style.pointerEvents = 'none';
        place(ov);
      }
      // DNR regulatory overlays, each a transparent PNG in its own pass.
      for (const key of overlayOn) {
        const dnr = new Image();
        dnr.src = overlayUrl(key, zoom, wx, ty);
        dnr.style.pointerEvents = 'none';
        dnr.style.opacity = '0.55';
        place(dnr);
      }
    }
  }
  for (const c of located) {
    const x = projX(c.lng, zoom) - left, y = projY(c.lat, zoom) - top;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const lab = el('div', 'plabel', c.name);
    lab.style.left = x + 'px'; lab.style.top = y + 'px';
    const p = el('div', 'pin ' + c.health.level);
    p.style.left = x + 'px'; p.style.top = y + 'px';
    p.title = c.name + ' \u2014 last contact ' + fmtDate(c.lastSeen);
    p.onclick = () => document.getElementById('cam-' + c.id)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pinsEl.append(lab, p);
  }

  // Stands: teardrops rather than circles, so they read as a different KIND of
  // thing than a camera even at a glance or in greyscale.
  for (const s of STANDS) {
    const x = projX(s.lng, zoom) - left, y = projY(s.lat, zoom) - top;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const lab = el('div', 'slabel', s.name);
    lab.style.left = x + 'px'; lab.style.top = y + 'px';
    const pin = el('div', 'stand' + (editing && editing.id === s.id ? ' sel' : ''));
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    pin.title = s.name + ' \u2014 ' + s.type.replace('-', ' ')
      + (s.winds && s.winds.length ? ' \u00b7 good on ' + s.winds.join(', ') : '')
      + (s.nearbyCameras && s.nearbyCameras.length
        ? ' \u00b7 covers ' + s.nearbyCameras.map(c => c.name + ' (' + c.metres + 'm)').join(', ')
        : '');
    pin.onclick = ev => { ev.stopPropagation(); openStandForm(s); };
    pinsEl.append(lab, pin);
  }

  drawMarkers(left, top, W, H);
  drawSuggestions(left, top, W, H);
}
// ---- offline ----------------------------------------------------------
// Tiles you have looked at are already cached — every one came through this
// server on its way to the page. This button is for the ground you have NOT
// looked at yet: the view in front of you, a few zoom levels deep, saved
// before you lose signal.
const offlineBtn = document.getElementById('offlineBtn');

function visibleBounds() {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const nw = pixelToLatLng(0, 0), se = pixelToLatLng(W, H);
  return { west: nw.lng, north: nw.lat, east: se.lng, south: se.lat };
}

offlineBtn.onclick = async ev => {
  ev.stopPropagation();
  if (!D.live) return;
  offlineBtn.disabled = true;
  const label = offlineBtn.textContent;
  offlineBtn.textContent = 'Saving\u2026';
  try {
    // This zoom and three closer: enough to walk in on, without pulling down
    // a county. The server caps it regardless.
    const zooms = [zoom, zoom + 1, zoom + 2, zoom + 3]
      .filter(z => z <= LAYERS[layerKey].maxZoom);
    const res = await fetch('/api/tiles/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bounds: visibleBounds(), zooms,
        sources: [layerKey, ...overlayOn],
      }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'save failed');
    const stats = await (await fetch('/api/tiles/stats')).json();
    const mb = (stats.bytes / 1048576).toFixed(1);
    terrainNote(
      '<b>Saved for offline.</b> ' + r.saved + ' new tiles, '
      + r.alreadyHad + ' already held'
      + (r.failed ? ', ' + r.failed + ' failed' : '') + '.<br>'
      + 'Cache now holds ' + stats.tiles + ' tiles (' + mb + ' MB).'
      // Both of these are said out loud rather than swallowed: a truncated
      // download that reports success is how you end up in the woods with
      // half a map.
      + (r.capped
        ? '<br><span class="warn">Stopped at the ' + r.max + '-tile limit \u2014 '
          + r.skipped + ' tiles not saved. Zoom in and save a smaller area.</span>'
        : '')
      + r.refused.map(x => '<br><span class="warn">' + x.why + '</span>').join(''));
  } catch (err) {
    terrainNote('Could not save tiles: ' + err.message);
  } finally {
    offlineBtn.disabled = false;
    offlineBtn.textContent = label;
  }
};
if (!D.live) {
  offlineBtn.disabled = true;
  offlineBtn.title = 'Offline maps need the server';
  offlineBtn.style.opacity = '0.6';
  offlineBtn.style.cursor = 'not-allowed';
}
// ---- scouting markers -------------------------------------------------
// Sign you found on the ground. Both paid apps are built around this layer,
// and it is the one that turns a generic map into YOUR map.
let MARKERS = D.markers || [];
let marking = false;
const markBtn = document.getElementById('markBtn');

// Colour AND letter for each kind. Colour alone fails on a sunlit phone.
const MARK_STYLE = {
  rub: ['#d8b25a', 'R'], scrape: ['#c98a4b', 'S'], bed: ['#9fd3a0', 'B'],
  trail: ['#a8c8e8', 'T'], 'food-plot': ['#b8e07a', 'F'], water: ['#7fc4e8', 'W'],
  access: ['#e0a8d8', 'A'], other: ['#cccccc', '?'],
};

// Sign goes stale. A rub found last November is history in October, so an old
// marker is drawn faded rather than as if you saw it this morning.
const STALE_SIGN_DAYS = 45;

async function refreshMarkers() {
  MARKERS = await (await fetch('/api/markers')).json();
  draw();
}

function drawMarkers(left, top, W, H) {
  for (const m of MARKERS) {
    const x = projX(m.lng, zoom) - left, y = projY(m.lat, zoom) - top;
    if (x < -30 || y < -30 || x > W + 30 || y > H + 30) continue;
    const [colour, letter] = MARK_STYLE[m.kind] || MARK_STYLE.other;
    const stale = m.daysOld !== null && m.daysOld > STALE_SIGN_DAYS;
    const pin = el('div', 'mark' + (stale ? ' old' : ''), letter);
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    pin.style.background = colour;
    pin.title = m.label + (m.name ? ' \u2014 ' + m.name : '')
      + (m.daysOld === null ? ' \u2014 no date recorded'
         : m.daysOld === 0 ? ' \u2014 found today'
         : ' \u2014 found ' + m.daysOld + ' days ago')
      // The newline below is escaped TWICE on purpose. This whole script is
      // emitted from a template literal, so a single-escaped newline is turned
      // into a REAL line break when the page is built — which lands a raw
      // newline inside a quoted string and makes the entire dashboard script a
      // syntax error. (Writing that warning out in full here broke it a second
      // time, because the comment is inside the same template literal.)
      // Unicode escapes such as the em-dash are safe: they produce an ordinary
      // character rather than a control one.
      + (m.notes ? '\n' + m.notes : '');
    pin.onclick = ev => { ev.stopPropagation(); openMarkerForm(m); };
    pinsEl.appendChild(pin);
    if (m.name) {
      const lab = el('div', 'mklabel', m.name);
      lab.style.left = x + 'px'; lab.style.top = y + 'px';
      pinsEl.appendChild(lab);
    }
  }
}

markBtn.onclick = ev => {
  ev.stopPropagation();
  if (!D.live) return;
  marking = !marking;
  if (marking) clearMapModes('mark');
  markBtn.classList.toggle('on', marking);
  markBtn.textContent = marking ? 'Click the map\u2026' : '+ Mark sign';
  mapEl.classList.toggle('placing', marking);
};
if (!D.live) {
  markBtn.disabled = true;
  markBtn.title = 'Markers need the server';
  markBtn.style.opacity = '0.6';
  markBtn.style.cursor = 'not-allowed';
}

function openMarkerForm(marker) {
  document.querySelector('.standform')?.remove();
  const isNew = !marker.id;
  const form = el('div', 'standform');
  form.appendChild(el('h3', null, isNew ? 'Mark sign' : 'Edit sign'));

  const kind = document.createElement('select');
  for (const [value, label] of Object.entries(
    { rub: 'Rub', scrape: 'Scrape', bed: 'Bed', trail: 'Trail',
      'food-plot': 'Food plot', water: 'Water', access: 'Access route', other: 'Other' })) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    if ((marker.kind || 'rub') === value) o.selected = true;
    kind.appendChild(o);
  }
  form.append(el('label', null, 'What is it'), kind);

  const name = document.createElement('input');
  name.value = marker.name || '';
  name.placeholder = 'Fence-line rub';
  form.append(el('label', null, 'Name (optional)'), name);

  // Defaulted to today because that is nearly always right, and because sign
  // with no date cannot be aged later.
  const found = document.createElement('input');
  found.type = 'date';
  found.value = (marker.found_at || new Date().toISOString()).slice(0, 10);
  form.append(el('label', null, 'When you found it'), found);

  const notes = document.createElement('textarea');
  notes.rows = 2;
  notes.value = marker.notes || '';
  form.append(el('label', null, 'Notes'), notes);

  const row = el('div', 'formrow');
  const save = el('button', 'primary', isNew ? 'Drop pin' : 'Save');
  const cancel = el('button', null, 'Cancel');
  row.append(save, cancel);
  form.appendChild(row);

  if (!isNew) {
    const del = el('button', 'danger', 'Delete');
    del.style.marginTop = '8px';
    del.onclick = async () => {
      await apiWrite('DELETE', '/api/markers/' + marker.id);
      form.remove();
      refreshMarkers();
    };
    form.appendChild(del);
  }

  cancel.onclick = () => form.remove();
  save.onclick = async () => {
    const body = {
      kind: kind.value, name: name.value.trim() || null,
      lat: marker.lat, lng: marker.lng,
      foundAt: found.value || null, notes: notes.value.trim() || null,
    };
    try {
      if (isNew) await apiWrite('POST', '/api/markers', body);
      else await apiWrite('PATCH', '/api/markers/' + marker.id, body);
      form.remove();
      refreshMarkers();
    } catch (err) {
      form.appendChild(el('div', 'hint', 'Could not save: ' + err.message));
    }
  };
  mapEl.appendChild(form);
  name.focus();
}
// ---- walk-in routes ---------------------------------------------------
// The classic way a good stand is wasted: not sitting it on the wrong wind, but
// walking to it across the ground you were about to hunt. A route is judged the
// same way a stand is — against the wind — and the two have to agree.
let ROUTES = [];
let drawing = null;      // the route being drawn: { standId, points: [] }
const routeBtn = document.getElementById('routeBtn');

async function refreshRoutes() {
  ROUTES = await (await fetch('/api/routes')).json();
  draw();
}

function routePaths(left, top) {
  const out = [];
  for (const r of ROUTES) {
    if (!r.points || r.points.length < 2) continue;
    out.push('<path class="route" d="' + svgPath(r.points, left, top, false) + '"></path>');
  }
  if (drawing && drawing.points.length >= 2) {
    out.push('<path class="route draft" d="' + svgPath(drawing.points, left, top, false) + '"></path>');
  }
  return out;
}

function routeTip(text) {
  document.querySelector('.routetip')?.remove();
  if (!text) return;
  const t = el('div', 'routetip');
  t.innerHTML = text;
  mapEl.appendChild(t);
}

routeBtn.onclick = ev => {
  ev.stopPropagation();
  if (!D.live) return;
  if (drawing) return finishRoute();
  if (!STANDS.length) {
    return terrainNote('Drop a stand first \u2014 a route is the way in to one, '
      + 'so there is nothing to judge it against until a stand exists.');
  }
  clearMapModes('route');
  drawing = { standId: null, points: [] };
  routeBtn.classList.add('on');
  routeBtn.textContent = 'Finish route';
  mapEl.classList.add('placing');
  routeTip('Click along your walk in. <b>Enter</b> or <b>Finish route</b> when done, '
    + '<b>Esc</b> to cancel.');
};
if (!D.live) {
  routeBtn.disabled = true;
  routeBtn.title = 'Routes need the server';
  routeBtn.style.opacity = '0.6';
  routeBtn.style.cursor = 'not-allowed';
}

function cancelRoute() {
  drawing = null;
  routeBtn.classList.remove('on');
  routeBtn.textContent = '+ Walk-in route';
  mapEl.classList.remove('placing');
  routeTip(null);
  draw();
}

async function finishRoute() {
  if (!drawing) return;
  const points = drawing.points;
  if (points.length < 2) return cancelRoute();
  const pts = points.slice();
  cancelRoute();
  openRouteForm(pts);
}

function openRouteForm(points) {
  document.querySelector('.standform')?.remove();
  const form = el('div', 'standform');
  form.appendChild(el('h3', null, 'Walk-in route'));

  const name = document.createElement('input');
  name.placeholder = 'From the gate';
  form.append(el('label', null, 'Name'), name);

  // Which stand this is the way IN to. A route without one cannot be judged,
  // so it is required rather than optional.
  const sel = document.createElement('select');
  for (const st of STANDS) {
    const o = document.createElement('option');
    o.value = String(st.id); o.textContent = st.name;
    sel.appendChild(o);
  }
  form.append(el('label', null, 'The way in to'), sel);

  // The end of the walk is the last point, so the nearest stand to it is very
  // likely the one meant — offered as a default rather than assumed silently.
  const last = points[points.length - 1];
  let best = null, bestM = Infinity;
  for (const st of STANDS) {
    const m = Math.hypot((st.lng - last[0]) * 80000, (st.lat - last[1]) * 111000);
    if (m < bestM) { bestM = m; best = st; }
  }
  if (best) sel.value = String(best.id);

  const row = el('div', 'formrow');
  const save = el('button', 'primary', 'Save route');
  const cancel = el('button', null, 'Discard');
  row.append(save, cancel);
  form.appendChild(row);
  cancel.onclick = () => { form.remove(); draw(); };
  save.onclick = async () => {
    try {
      await apiWrite('POST', '/api/routes', {
        standId: Number(sel.value), name: name.value.trim() || null, points,
      });
      form.remove();
      await refreshRoutes();
      const saved = ROUTES[ROUTES.length - 1];
      if (saved?.winds) {
        terrainNote('<b>' + (saved.name || 'Route') + '</b> \u2014 ' + saved.lengthM + ' m.<br>'
          + 'Clean on <b>' + saved.winds.clean.join(' ') + '</b>.<br>'
          + (saved.winds.dirty.length
            ? '<span class="warn">Blows your scent over the stand on '
              + saved.winds.dirty.join(' ') + '.</span>'
            : 'Upwind of the stand on every wind.'));
      }
    } catch (err) {
      form.appendChild(el('div', 'hint', 'Could not save: ' + err.message));
    }
  };
  mapEl.appendChild(form);
  name.focus();
}

addEventListener('keydown', e => {
  if (!drawing) return;
  if (isTyping(e.target)) return;
  if (e.key === 'Enter') { e.preventDefault(); finishRoute(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelRoute(); }
});
if (D.live) refreshRoutes().catch(() => {});

// ---- measuring ---------------------------------------------------------
// How far is that, and how many acres is this. Two questions the map got asked
// constantly and could not answer, and the only map tool here that needs
// nothing from the server: it is arithmetic on points you clicked, so it works
// on the static page and with the laptop shut in the truck.
//
// The arithmetic itself is measure.mjs, emitted into this page rather than
// rewritten for it, so the acreage the map shows and the acreage the tests
// check are computed by the same code.
let measuring = null;    // { points: [] }
const measureBtn = document.getElementById('measureBtn');

/**
 * Arming one map mode disarms every other one.
 *
 * This used to be done pairwise, each button naming the modes it happened to
 * know about, and the list had already rotted: "+ Add stand" turned nothing
 * off, "Who owns this?" turned off only stand placing, and adding measuring
 * broke Add stand outright — measuring took the click first, so the button
 * armed and then silently did nothing. That is the same shape of failure the
 * onMapGround whitelist was written to end, and it gets the same treatment.
 * One function knows all the modes; a mode added tomorrow is disarmed here or
 * not at all, rather than in four places somebody has to remember.
 */
function clearMapModes(keep) {
  if (keep !== 'stand' && placing) {
    placing = false;
    addBtn.classList.remove('on');
    addBtn.textContent = '+ Add stand';
  }
  if (keep !== 'mark' && marking) {
    marking = false;
    markBtn.classList.remove('on');
    markBtn.textContent = '+ Mark sign';
  }
  if (keep !== 'parcel' && identifying) {
    identifying = false;
    ownBtn.classList.remove('on');
    ownBtn.textContent = 'Who owns this?';
  }
  if (keep !== 'route' && drawing) cancelRoute();
  if (keep !== 'measure' && measuring) stopMeasuring();
  // The caller puts it back if it is arming something. Leaving it on is how
  // the map ends up stuck showing a crosshair with no mode behind it.
  mapEl.classList.remove('placing');
}

function measurePaths(left, top) {
  if (!measuring || !measuring.points.length) return [];
  const pts = measuring.points;
  const out = [];
  if (pts.length >= 2) {
    // Shown closed once there are three points, because that is the moment it
    // starts having an area and the fill is what says so.
    const ring = pts.length >= 3;
    out.push('<path class="measure' + (ring ? ' ring' : '') + '" d="'
      + svgPath(pts, left, top, ring) + '"></path>');
  }
  for (const p of pts) {
    const px = projX(p[0], zoom) - left, py = projY(p[1], zoom) - top;
    out.push('<circle class="measure" cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1)
      + '" r="4"></circle>');
  }
  return out;
}

// One box, carrying both the numbers and the next instruction. Two stacked
// panels at the top of the map cover the shape you are drawing under them,
// which is the one thing you need to see while drawing it.
function measureBox() {
  document.querySelector('.measurebox')?.remove();
  if (!measuring) return;
  const m = MEASURE.measure(measuring.points);
  const box = el('div', 'measurebox');
  if (!m.points) {
    box.appendChild(el('div', 'sub', 'Click a point on the map to start.'));
  } else if (m.points === 1) {
    box.appendChild(el('div', 'sub', 'Click another point for a distance.'));
  } else {
    box.appendChild(el('div', 'big', m.length));
    if (m.area) {
      box.appendChild(el('div', 'big', m.area));
      box.appendChild(el('div', 'sub', 'around ' + m.perimeter + ' of edge'));
    } else {
      box.appendChild(el('div', 'sub', 'one more point gives you an area'));
    }
  }
  const keys = el('div', 'sub');
  keys.innerHTML = '<b>Backspace</b> undo &middot; <b>Esc</b> clear';
  keys.style.marginTop = '5px';
  keys.style.opacity = '.75';
  box.appendChild(keys);
  mapEl.appendChild(box);
}

measureBtn.onclick = ev => {
  ev.stopPropagation();
  if (measuring) return stopMeasuring();
  clearMapModes('measure');
  measuring = { points: [] };
  measureBtn.classList.add('on');
  measureBtn.textContent = 'Done';
  mapEl.classList.add('placing');
  measureBox();
  draw();
};

function stopMeasuring() {
  measuring = null;
  measureBtn.classList.remove('on');
  measureBtn.textContent = 'Measure';
  mapEl.classList.remove('placing');
  document.querySelector('.measurebox')?.remove();
  draw();
}

// A control the user is typing into. TEXTAREA was missing, so with measure
// armed, Backspace in a stand or marker notes box deleted a map point instead
// of a character — and clicking a pin does not disarm measure, so the state is
// one click away.
const isTyping = t => t && (t.tagName === 'INPUT' || t.tagName === 'SELECT'
  || t.tagName === 'TEXTAREA' || t.isContentEditable);

addEventListener('keydown', e => {
  if (!measuring) return;
  if (isTyping(e.target)) return;
  if (e.key === 'Escape') { e.preventDefault(); stopMeasuring(); }
  else if (e.key === 'Backspace') {
    e.preventDefault();
    measuring.points.pop();
    measureBox();
    draw();
  }
});
// ---- recorded tracks ---------------------------------------------------
// Where you actually walked, drawn beside the route you drew. A track whose
// fixes were poor is dashed rather than hidden: it still says roughly where
// you went, and pretending otherwise either way would be worse.
let TRACKS = [];

async function refreshTracks() {
  const res = await fetch('/api/tracks?limit=50');
  if (!res.ok) return;
  TRACKS = (await res.json()).tracks || [];
  draw();
}

function trackPaths(left, top) {
  return TRACKS
    .filter(t => t.points && t.points.length >= 2)
    .map(t => '<path class="track'
      + (t.quality && (t.quality.level === 'poor' || t.quality.level === 'rough') ? ' rough' : '')
      + '" d="' + svgPath(t.points, left, top, false) + '"></path>');
}
if (D.live) refreshTracks().catch(() => {});

// ---- suggest a stand ---------------------------------------------------
// Everything this needs was already on the map and never put together: the
// landforms from the terrain layer, the winds no stand covers from the wind
// history, and the sign you have marked. A suggestion is a piece of ground
// PLUS the side of it the wind lets you sit — the same saddle gives a
// different stand depending on which side you hang, and which side is decided
// by the winds you are currently missing.
//
// Drawn as dashed squares, not teardrops: one must never be mistaken at a
// glance for somewhere you actually hunt.
let SUGGESTIONS = [];
let suggestSel = null;
const suggestBtn = document.getElementById('suggestBtn');

function suggestPaths(left, top) {
  // The line from each suggestion to the ground it watches. Without it the pin
  // is a dot in a field and the thing you most need to see — which way you
  // would be looking — is invisible.
  return SUGGESTIONS.map(c => '<path class="sugg-look" d="'
    + svgPath([[c.lng, c.lat], [c.feature.lng, c.feature.lat]], left, top, false)
    + '"></path>');
}

function drawSuggestions(left, top, W, H) {
  for (const c of SUGGESTIONS) {
    const x = projX(c.lng, zoom) - left, y = projY(c.lat, zoom) - top;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    // Just the rank. Five labels reading "WNW - 13 winds" pile on top of each
    // other and say nothing you can act on without opening the card anyway.
    const lab = el('div', 'sugglabel', String(SUGGESTIONS.indexOf(c) + 1));
    lab.style.left = x + 'px'; lab.style.top = y + 'px';
    const pin = el('div', 'sugg' + (suggestSel === c ? ' sel' : ''));
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    pin.title = 'Suggested: looking ' + c.facing + ' at a ' + c.feature.kind;
    pin.onclick = ev => { ev.stopPropagation(); suggestSel = c; showSuggestion(c); draw(); };
    pinsEl.append(lab, pin);
  }
}

function closeSuggestCard() {
  document.querySelector('.suggcard')?.remove();
}

function showSuggestion(c) {
  closeSuggestCard();
  const card = el('div', 'suggcard');
  const x = document.createElement('button');
  x.className = 'close'; x.textContent = '\u00d7'; x.title = 'Close';
  x.onclick = ev => { ev.stopPropagation(); suggestSel = null; closeSuggestCard(); draw(); };
  card.appendChild(x);

  card.appendChild(el('h4', null, '#' + (SUGGESTIONS.indexOf(c) + 1) + ' \u2014 looking '
    + c.facing + ' at a ' + c.feature.kind));
  card.appendChild(el('div', 'meta',
    c.setbackM + ' m back \u00b7 huntable on ' + c.winds.length + ' of 16 winds'
    + (c.coversGaps.length ? ' \u00b7 fills ' + c.coversGaps.join(', ') : '')));

  const ul = el('ul');
  for (const r of c.reasons) {
    const li = el('li', r.points < 0 ? 'minus' : null, r.why);
    ul.appendChild(li);
  }
  card.appendChild(ul);

  const winds = el('div', 'meta');
  winds.style.marginTop = '8px';
  winds.textContent = 'Good winds: ' + c.winds.join(', ');
  card.appendChild(winds);

  const pick = el('div', 'pick');
  const hang = document.createElement('button');
  hang.className = 'primary';
  hang.textContent = 'Hang it here';
  hang.onclick = ev => {
    ev.stopPropagation();
    // Straight into the normal stand form, with the winds already ticked. The
    // suggestion is a starting point you then edit, not a stand.
    closeSuggestCard();
    openStandForm({ lat: c.lat, lng: c.lng, winds: c.winds, type: 'stand' });
  };
  const drop = document.createElement('button');
  drop.textContent = 'Not this one';
  drop.onclick = ev => {
    ev.stopPropagation();
    SUGGESTIONS = SUGGESTIONS.filter(s => s !== c);
    suggestSel = null;
    closeSuggestCard();
    draw();
  };
  pick.append(hang, drop);
  card.appendChild(pick);

  if (SUGGEST_CAVEAT) card.appendChild(el('div', 'caveat', SUGGEST_CAVEAT));
  mapEl.appendChild(card);
}

let SUGGEST_CAVEAT = null;

async function loadSuggestions() {
  suggestBtn.disabled = true;
  suggestBtn.textContent = 'Thinking\u2026';
  terrainNote('Reading the ground and your wind history\u2026');
  try {
    const q = '?lat=' + centre.lat.toFixed(6) + '&lng=' + centre.lng.toFixed(6);
    const res = await fetch('/api/suggest-stands' + q);
    const body = await res.json();
    // The endpoint says WHY it could not answer — no stands yet, no LiDAR
    // coverage, the terrain service down. Without this check all three came
    // out as the blandest possible lie: "Nothing to suggest here."
    if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
    SUGGESTIONS = body.candidates || [];
    SUGGEST_CAVEAT = body.caveat || null;
    const lines = [];
    if (SUGGESTIONS.length) {
      lines.push('<b>' + SUGGESTIONS.length + ' spot'
        + (SUGGESTIONS.length === 1 ? '' : 's') + ' worth walking.</b> Tap one for why.');
    }
    if (body.note) lines.push(body.note);
    for (const n of body.notes || []) lines.push(n);
    if (!body.windHistoryLoaded && SUGGESTIONS.length) {
      lines.push('No wind history cached yet \u2014 load "Which stands earn their keep" '
        + 'and press this again to rank by the winds you are missing.');
    }
    terrainNote(lines.join('<br>') || 'Nothing to suggest here.');
    suggestBtn.classList.toggle('on', SUGGESTIONS.length > 0);
    draw();
  } catch (err) {
    terrainNote('Could not work out suggestions: ' + err.message);
  } finally {
    suggestBtn.disabled = false;
    suggestBtn.textContent = SUGGESTIONS.length ? 'Clear suggestions' : 'Suggest a stand';
  }
}

suggestBtn.onclick = ev => {
  ev.stopPropagation();
  if (!D.live) return;
  if (SUGGESTIONS.length) {
    SUGGESTIONS = [];
    suggestSel = null;
    closeSuggestCard();
    suggestBtn.classList.remove('on');
    suggestBtn.textContent = 'Suggest a stand';
    terrainNote(null);
    draw();
    return;
  }
  loadSuggestions();
};
if (!D.live) {
  suggestBtn.disabled = true;
  suggestBtn.title = 'Suggestions need the server';
  suggestBtn.style.opacity = '0.6';
  suggestBtn.style.cursor = 'not-allowed';
}

// ---- terrain ----------------------------------------------------------
// The ground itself, from free USGS LiDAR. This is the layer the paid apps
// charge for, and on subtle ground it is the one that actually tells you where
// to sit: a two-foot bench does not show up on satellite imagery at all.
const terrainCanvas = document.getElementById('terrain');
const contoursEl = document.getElementById('contours');
let PARCEL_RINGS = null;     // boundary of the parcel last looked up
let TERRAIN = null;          // the loaded payload
let terrainImage = null;     // an offscreen canvas holding the hillshade
let terrainOn = false;
let terrainLoading = false;
const terrainBtn = document.getElementById('terrainBtn');


function terrainNote(html) {
  document.querySelector('.terrainnote')?.remove();
  if (!html) return;
  const n = el('div', 'terrainnote');
  n.innerHTML = html;
  mapEl.appendChild(n);
}

/** base64 -> bytes, without pulling in anything. */
function unb64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildTerrainImage(t) {
  const { cols, rows } = t.hillshade;
  const shade = unb64(t.hillshade.shade), alpha = unb64(t.hillshade.alpha);
  const off = document.createElement('canvas');
  off.width = cols; off.height = rows;
  const ctx = off.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    const v = shade[i];
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(img, 0, 0);
  return off;
}

/**
 * How much ground to ask for, and how finely.
 *
 * A fixed patch is wrong in both directions: zoomed out it covers a third of
 * the screen, zoomed in it fetches far more than you can see. So the radius
 * follows the visible map, and the spacing is then chosen to keep the sample
 * count — and therefore the wait, and the load on a public service — roughly
 * constant however much ground was asked for.
 */
function terrainRequestForView() {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  // Metres per pixel at this zoom and latitude, from the Web Mercator scale.
  const mpp = 156543.03392 * Math.cos(centre.lat * Math.PI / 180) / 2 ** zoom;
  const halfSpan = Math.max(W, H) / 2 * mpp;
  const radius = Math.min(1500, Math.max(150, Math.round(halfSpan)));
  // Aim for about 90 cells across. The wait is ENTIRELY round trips — measured
  // at 95% of it, with all the hillshade, contour and feature maths together
  // costing 146 ms — so the sample count is what decides how long you stare at
  // the button. 90 across is ~8k samples and 9 requests where 120 was ~14k and
  // 15, for a spacing of about 10 m on a typical view: still finer than the
  // structure being drawn, since a 2 ft draw is tens of metres wide.
  const spacing = Math.min(50, Math.max(5, Math.round(2 * radius / 90)));
  return { radius, spacing };
}

/** Is the map still looking at the ground we loaded? */
function terrainCoversView() {
  if (!TERRAIN) return false;
  const b = TERRAIN.bounds;
  return centre.lat >= b.south && centre.lat <= b.north
      && centre.lng >= b.west && centre.lng <= b.east;
}

async function loadTerrain() {
  if (terrainLoading) return;
  terrainLoading = true;
  const { radius, spacing } = terrainRequestForView();
  terrainBtn.textContent = 'Reading ground\u2026';
  // A ticking counter, because the whole wait is round trips to USGS and the
  // server cannot answer until they are all done. Without it a ten-second fetch
  // on a slower connection is indistinguishable from a hung button — which is
  // exactly how the first version got reported as broken.
  const started = Date.now();
  const area = radius >= 1000 ? (radius * 2 / 1000).toFixed(1) + ' km' : radius * 2 + ' m';
  const tick = () => terrainNote(
    'Reading LiDAR elevation from USGS for about ' + area + ' of ground\u2026 <b>'
    + ((Date.now() - started) / 1000).toFixed(0) + 's</b><br>'
    + 'Nearly all of this is waiting on the elevation service. '
    + 'Once fetched, this ground is cached and redraws instantly.');
  tick();
  const ticker = setInterval(tick, 1000);
  try {
    const res = await fetch('/api/terrain?lat=' + centre.lat + '&lng=' + centre.lng
      + '&radius=' + radius + '&spacing=' + spacing);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'terrain lookup failed');
    if (!body.covered) {
      // The server says WHY, and it is not always the same reason — no
      // coverage, or a map that has no location at all because no camera
      // reported GPS. "Nothing to draw" would hide the difference.
      terrainNote(body.why || 'No LiDAR coverage here. That is different from flat ground.');
      terrainOn = false;
      return;
    }
    TERRAIN = body;
    terrainImage = buildTerrainImage(body);
    terrainOn = true;
    mapEl.classList.add('terrain-on');
    const st = body.stats, c = body.contours;
    // The exaggeration is stated, deliberately. A hillshade stretched 23x is a
    // diagram, and a reader who thinks it is a photograph will read these as
    // real hills. On ground this flat, saying so is the honest part.
    const F = body.features;
    const flat = st.medianSlopeDeg < 2;
    terrainNote(
      '<b>' + st.reliefFt + ' ft</b> of relief here (' + st.minFt + '\u2013' + st.maxFt + ' ft). '
      + 'Contours every <b>' + c.intervalFt + ' ft</b>. '
      + 'Median slope <b>' + st.medianSlopeDeg + '\u00b0</b>.<br>'
      + 'Hillshade exaggerated <b>' + body.hillshade.zFactor + '\u00d7</b> vertically \u2014 '
      + 'at true scale this ground would look flat.'
      + '<div class="tlegend">'
      + '<span><i style="border-color:rgba(120,190,255,.95)"></i>'
      + plural(F.drainages.length, 'draw') + '</span>'
      + '<span><i style="border-color:rgba(255,170,105,.9);border-top-style:dashed"></i>'
      + plural(F.ridges.length, 'ridge') + '</span>'
      + (F.saddles.length ? '<span>\u25c6 ' + plural(F.saddles.length, 'saddle') + '</span>' : '')
      + (F.benches.length ? '<span>\u25ac ' + plural(F.benches.length, 'bench', 'benches') + '</span>' : '')
      + '</div>'
      // Why the list is empty, rather than an empty list. A detector that finds
      // nothing and says nothing is indistinguishable from a broken one.
      + (F.quiet
        ? '<span class="warn">No saddles or benches: this ground is too gentle '
          + '(median ' + F.medianSlopeDeg + '\u00b0) for either to mean anything. '
          + 'Draws and ridges still hold \u2014 a two-foot draw still carries a trail.</span>'
        : '')
      + (flat ? '<br><span class="warn">Thermals need real slope; this ground has none.</span>' : '')
      + '<br>Loaded for this view \u2014 pan, then press Terrain again for new ground.');
  } catch (err) {
    terrainNote('Terrain unavailable: ' + err.message);
    terrainOn = false;
  } finally {
    clearInterval(ticker);
    terrainLoading = false;
    terrainBtn.textContent = 'Terrain';
    terrainBtn.classList.toggle('on', terrainOn);
    mapEl.classList.toggle('terrain-on', terrainOn);
    draw();
  }
}

terrainBtn.onclick = ev => {
  ev.stopPropagation();
  if (!D.live) return;
  // Pressing Terrain while looking at ground we have not loaded fetches it,
  // rather than switching on a hillshade of somewhere else entirely.
  if (!TERRAIN || (!terrainOn && !terrainCoversView())) return loadTerrain();
  terrainOn = !terrainOn;
  terrainBtn.classList.toggle('on', terrainOn);
  mapEl.classList.toggle('terrain-on', terrainOn);
  if (!terrainOn) terrainNote(null);
  draw();
};
if (!D.live) {
  terrainBtn.disabled = true;
  terrainBtn.title = 'Terrain needs the server';
  terrainBtn.style.opacity = '0.6';
  terrainBtn.style.cursor = 'not-allowed';
}

/** Project one ring or path into an SVG path string. */
function svgPath(points, left, top, close) {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const px = projX(points[i][0], zoom) - left;
    const py = projY(points[i][1], zoom) - top;
    d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
  }
  return d + (close ? 'Z' : '');
}

function parcelPaths(left, top) {
  const out = PARCEL_RINGS
    ? PARCEL_RINGS.map(ring => '<path class="parcel" d="' + svgPath(ring, left, top, true) + '"></path>')
    : [];
  return out.concat(routePaths(left, top))
    .concat(trackPaths(left, top))
    .concat(measurePaths(left, top))
    .concat(suggestPaths(left, top));
}

/** The parcel boundary alone, when the terrain layer is off. */
function drawOverlayOnly(left, top, W, H) {
  const paths = parcelPaths(left, top);
  if (!paths.length) { contoursEl.innerHTML = ''; contoursEl.style.display = 'none'; return; }
  contoursEl.style.display = 'block';
  contoursEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  contoursEl.setAttribute('width', W);
  contoursEl.setAttribute('height', H);
  contoursEl.innerHTML = paths.join('');
}

/** Paint the hillshade and contours for the current pan and zoom. */
function drawTerrain(left, top, W, H) {
  // The parcel outline is not terrain, but it lives in the same SVG so it pans
  // and zooms with everything else. It must draw whether or not the terrain
  // layer is switched on, so it comes before that check.
  if (!terrainOn || !TERRAIN) return drawOverlayOnly(left, top, W, H);
  const b = TERRAIN.bounds;
  // Project the terrain patch's own corners, so it stays pinned to the ground
  // through every pan and zoom rather than to the screen.
  const x0 = projX(b.west, zoom) - left, x1 = projX(b.east, zoom) - left;
  const y0 = projY(b.north, zoom) - top, y1 = projY(b.south, zoom) - top;

  terrainCanvas.width = W; terrainCanvas.height = H;
  const ctx = terrainCanvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (terrainImage) ctx.drawImage(terrainImage, x0, y0, x1 - x0, y1 - y0);

  // Contours as one path per line. Every fifth line is drawn heavier, the way a
  // paper topo does it, so you can count elevation without reading labels.
  const step = TERRAIN.contours.intervalFt || 1;
  const parts = [];
  for (const line of TERRAIN.contours.lines) {
    let d = '';
    for (let i = 0; i < line.path.length; i++) {
      const px = projX(line.path[i][0], zoom) - left;
      const py = projY(line.path[i][1], zoom) - top;
      d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    }
    const index = Math.round(line.levelFt / step) % 5 === 0;
    parts.push('<path class="' + (index ? 'index' : '') + '" d="' + d + '"></path>');
  }

  // Drainages and ridges on top of the contours, because they are the reading
  // of the ground rather than the ground itself.
  const F = TERRAIN.features;
  if (F) {
    const trace = (line, cls) => {
      let d = '';
      for (let i = 0; i < line.path.length; i++) {
        const px = projX(line.path[i][0], zoom) - left;
        const py = projY(line.path[i][1], zoom) - top;
        d += (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
      }
      parts.push('<path class="' + cls + '" d="' + d + '"></path>');
    };
    for (const r of F.ridges) trace(r, 'ridgeline');
    for (const dr of F.drainages) trace(dr, 'drain');
  }
  parts.push(...parcelPaths(left, top));
  contoursEl.style.display = 'block';
  contoursEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  contoursEl.setAttribute('width', W);
  contoursEl.setAttribute('height', H);
  contoursEl.innerHTML = parts.join('');

  // Saddles and benches are places, not lines, so they get pins.
  if (!F) return;
  for (const sd of F.saddles) {
    const m = el('div', 'tfeat saddle');
    m.style.left = (projX(sd.lng, zoom) - left) + 'px';
    m.style.top = (projY(sd.lat, zoom) - top) + 'px';
    m.title = 'Saddle \u2014 the low crossing on this ridge, about '
      + sd.reliefFt + ' ft below the high ground either side. Deer cross where it is cheapest.';
    pinsEl.appendChild(m);
  }
  for (const bn of F.benches) {
    const m = el('div', 'tfeat bench');
    m.style.left = (projX(bn.lng, zoom) - left) + 'px';
    m.style.top = (projY(bn.lat, zoom) - top) + 'px';
    m.title = 'Bench \u2014 a flat shelf (' + bn.slopeDeg + '\u00b0) with '
      + bn.steepAround + '% steeper ground around it. Deer bed on these and travel along them.';
    pinsEl.appendChild(m);
  }
}
// ---- stands -----------------------------------------------------------
let STANDS = D.stands || [];
let placing = false;
let editing = null;

const WINDS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const TYPES = [['stand','Ladder / hang-on'],['tripod','Tripod'],['ground-blind','Ground blind'],
               ['box-blind','Box blind'],['saddle','Saddle'],['other','Other']];

/** Screen pixel -> coordinates. The inverse of projX/projY, used when a click
 *  on the map has to become a real position for a new pin. */
function pixelToLatLng(px, py) {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const n = TS * 2 ** zoom;
  const cx = projX(centre.lng, zoom) - W / 2 + px;
  const cy = projY(centre.lat, zoom) - H / 2 + py;
  return {
    lng: cx / n * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / n))) * 180 / Math.PI,
  };
}
// ---- who owns this ----------------------------------------------------
let identifying = false;
const ownBtn = document.getElementById('whoOwns');

// Two different things, and conflating them cost an afternoon: REPLACING the
// card (which showParcelCard does on every lookup) must leave the boundary
// alone, while DISMISSING it should take the boundary with it. When close did
// both, every lookup drew the outline and then immediately wiped it, because
// showParcelCard opens by clearing whatever card is already there.
function removeParcelCard() { document.querySelector('.parcelcard')?.remove(); }

function closeParcelCard() {
  removeParcelCard();
  // A red outline left on the map with nothing explaining it reads as a
  // permanent property line, so the two go together.
  if (PARCEL_RINGS) { PARCEL_RINGS = null; draw(); }
}

function showParcelCard(title, rows, note) {
  removeParcelCard();
  const card = el('div', 'parcelcard');
  const x = document.createElement('button');
  x.className = 'close'; x.textContent = '\u00d7'; x.title = 'Close';
  x.onclick = closeParcelCard;
  card.appendChild(x);
  card.appendChild(el('h4', null, title));
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === '') continue;
    const r = el('div', 'row');
    r.append(el('span', null, k), el('b', null, String(v)));
    card.appendChild(r);
  }
  if (note) card.appendChild(el('div', 'hint', note));
  mapEl.appendChild(card);
}

async function lookupParcel(lat, lng) {
  showParcelCard('Looking up\u2026', [], null);
  try {
    const res = await fetch('/api/parcel?lat=' + lat + '&lng=' + lng);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'lookup failed');
    if (!body.found) {
      PARCEL_RINGS = null;
      draw();
      return showParcelCard('No parcel here', [],
        'Wisconsin parcels only. Outside the state, or on water, there is nothing to look up.');
    }
    const p = body.parcel;
    PARCEL_RINGS = p.rings || null;
    draw();
    showParcelCard(p.owner || 'Owner not recorded', [
      ['Acres', p.acres],
      ['Class', p.propClassName || p.propClass],
      ['County', p.county],
      ['Parcel ID', p.parcelId],
      ['Mailing address', p.mailingAddress],
      ['School district', p.schoolDistrict],
    ], 'Public record from the Wisconsin statewide parcel map.');
  } catch (err) {
    showParcelCard('Lookup failed', [['Reason', err.message]],
      'The parcel service may be down; the rest of the map is unaffected.');
  }
}

if (!D.live) {
  ownBtn.disabled = true;
  ownBtn.title = 'Ownership lookup needs the server';
  ownBtn.style.opacity = '0.6';
  ownBtn.style.cursor = 'not-allowed';
} else {
  ownBtn.onclick = ev => {
    ev.stopPropagation();
    identifying = !identifying;
    if (identifying) clearMapModes('parcel');
    ownBtn.classList.toggle('on', identifying);
    ownBtn.textContent = identifying ? 'Click the map\u2026' : 'Who owns this?';
    mapEl.classList.toggle('placing', identifying);
  };
}

const addBtn = document.getElementById('addStand');
if (!D.live) {
  // Opened as a file rather than served. Say why the control is unavailable —
  // a button that silently does nothing is worse than one that is absent, and
  // an absent one with no explanation is a close second.
  addBtn.textContent = 'Stands need the server';
  addBtn.title = 'Run start-trailcam.cmd and open http://127.0.0.1:8787 to add stands';
  addBtn.disabled = true;
  addBtn.style.opacity = '0.6';
  addBtn.style.cursor = 'not-allowed';
} else {
  addBtn.onclick = ev => {
    ev.stopPropagation();
    placing = !placing;
    if (placing) clearMapModes('stand');
    addBtn.classList.toggle('on', placing);
    addBtn.textContent = placing ? 'Click the map\u2026' : '+ Add stand';
    mapEl.classList.toggle('placing', placing);
  };
}

// Used by stands and markers alike, so it is named for what it does.
async function apiWrite(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || ('request failed: ' + res.status));
  }
  return res.status === 200 || res.status === 201 ? res.json() : null;
}

async function refreshStands() {
  STANDS = await (await fetch('/api/stands')).json();
  draw();
}

// The drop/edit form. A row with an id is an edit; {lat,lng} alone is new.
function openStandForm(stand) {
  document.querySelector('.standform')?.remove();
  editing = stand.id ? stand : null;
  const isNew = !stand.id;
  const chosen = new Set(stand.winds || []);

  const form = el('div', 'standform');
  form.appendChild(el('h3', null, isNew ? 'New stand' : 'Edit stand'));

  const name = document.createElement('input');
  name.value = stand.name || '';
  name.placeholder = 'East Ridge ladder';
  form.append(el('label', null, 'Name'), name);

  const type = document.createElement('select');
  for (const [v, labelText] of TYPES) {
    const o = document.createElement('option');
    o.value = v; o.textContent = labelText;
    if ((stand.type || 'stand') === v) o.selected = true;
    type.appendChild(o);
  }
  form.append(el('label', null, 'Type'), type);

  form.appendChild(el('label', null, 'Huntable on these winds (the wind comes FROM)'));
  const windBox = el('div', 'winds');
  for (const w of WINDS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = w;
    b.className = chosen.has(w) ? 'on' : '';
    b.onclick = () => {
      if (chosen.has(w)) chosen.delete(w); else chosen.add(w);
      b.classList.toggle('on');
    };
    windBox.appendChild(b);
  }
  form.appendChild(windBox);
  form.appendChild(el('div', 'hint',
    'Leave blank if unsure \u2014 the tool then says "unknown" rather than recommending it.'));

  const notes = document.createElement('textarea');
  notes.rows = 2; notes.value = stand.notes || '';
  form.append(el('label', null, 'Notes'), notes);

  const row = el('div', 'formrow');
  const save = document.createElement('button');
  save.className = 'primary'; save.textContent = isNew ? 'Drop pin' : 'Save';
  save.onclick = async () => {
    save.disabled = true;
    try {
      const body = {
        name: name.value, type: type.value,
        lat: stand.lat, lng: stand.lng,
        goodWinds: [...chosen],
        notes: notes.value || null,
      };
      if (isNew) await apiWrite('POST', '/api/stands', body);
      else await apiWrite('PATCH', '/api/stands/' + stand.id, body);
      form.remove(); editing = null;
      await refreshStands();
    } catch (err) {
      save.disabled = false;
      let e = form.querySelector('.stale-note');
      if (!e) { e = el('div', 'stale-note'); form.appendChild(e); }
      e.textContent = err.message;
    }
  };
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => { form.remove(); editing = null; draw(); };
  row.append(save, cancel);

  if (!isNew) {
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete ' + stand.name + '?')) return;
      await apiWrite('DELETE', '/api/stands/' + stand.id);
      form.remove(); editing = null;
      await refreshStands();
    };
    row.appendChild(del);
  }
  form.appendChild(row);
  mapEl.appendChild(form);
  name.focus();
  draw();
}
// ---- map type control -------------------------------------------------
const layersEl = document.querySelector('.layers');
const toggleEl = document.getElementById('layerToggle');
const menuEl = document.getElementById('layerMenu');
const creditEl = document.getElementById('credit');

// Each swatch previews a real tile from that layer over the cameras, so the
// buttons look like where you actually hunt rather than a generic icon.
const previewTile = key => {
  const L = LAYERS[key];
  const z = Math.min(14, L.maxZoom);
  const n = 2 ** z;
  const x = Math.floor((centre.lng + 180) / 360 * n);
  const s = Math.sin(centre.lat * Math.PI / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return layerUrl(key, z, ((x % n) + n) % n, Math.max(0, Math.min(n - 1, y)));
};

function paintControl() {
  const L = LAYERS[layerKey];
  // Google shows the layer you would switch TO, not the one you are on.
  const other = LAYERS[layerKey] === LAYERS.map ? 'satellite' : 'map';
  toggleEl.style.backgroundImage = 'url("' + previewTile(other) + '")';
  document.getElementById('layerLabel').textContent = LAYERS[other].label;
  creditEl.innerHTML = [L.credit, ...[...overlayOn].map(k => OVERLAYS[k].credit)].join('. ');

  menuEl.textContent = '';
  for (const [key, def] of Object.entries(LAYERS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = key === layerKey ? 'on' : '';
    b.style.backgroundImage = 'url("' + previewTile(key) + '")';
    b.title = def.label;
    b.appendChild(el('span', null, def.label));
    b.onclick = ev => {
      ev.stopPropagation();
      layerKey = key; saveLayer(key);
      if (zoom > LAYERS[key].maxZoom) zoom = LAYERS[key].maxZoom;
      layersEl.classList.remove('open');
      paintControl(); draw();
    };
    menuEl.appendChild(b);
  }

  // Overlays are checkboxes rather than a choice: they stack on any base map,
  // and several can be on at once.
  const sep = el('div', 'ovsep', 'Overlays \u2014 Wisconsin DNR');
  menuEl.appendChild(sep);
  for (const [key, def] of Object.entries(OVERLAYS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ovbtn' + (overlayOn.has(key) ? ' on' : '');
    b.title = def.note;
    b.textContent = (overlayOn.has(key) ? '\u2611 ' : '\u2610 ') + def.label;
    b.onclick = ev => {
      ev.stopPropagation();
      if (overlayOn.has(key)) overlayOn.delete(key); else overlayOn.add(key);
      saveOverlays();
      paintControl(); draw();
    };
    menuEl.appendChild(b);
  }
}

toggleEl.onclick = e => { e.stopPropagation(); layersEl.classList.add('open'); };
layersEl.onmouseenter = () => layersEl.classList.add('open');
layersEl.onmouseleave = () => layersEl.classList.remove('open');
document.addEventListener('click', () => layersEl.classList.remove('open'));

/**
 * Is this event on the map GROUND, rather than on something laid over it?
 *
 * Every control here — toolbar, zoom, layer switcher, stand form, parcel card,
 * pins — is a child of #map, so both the click handler and the drag handler
 * below have to tell "clicked the ground" from "pressed a button".
 *
 * This whitelists the background on purpose. It replaced two separate
 * blacklists that had drifted: the drag handler still excluded only .zoom and
 * .layers, so a pointerdown on any newer control started a map drag AND called
 * setPointerCapture — which retargets the following click to #map. The button
 * never received its own click, so "+ Add stand" and "Who owns this?" both did
 * nothing, the stand form could not be typed into, and a stand pin could not
 * be reopened. A whitelist cannot rot that way: a control added tomorrow is
 * excluded by default rather than by someone remembering to add it.
 */
const onMapGround = t =>
  t === mapEl || t === tilesEl || t === pinsEl || !!t.closest('#tiles');

mapEl.addEventListener('click', e => {
  if (!onMapGround(e.target)) return;
  // The click that ends a pan is not a tap on the ground.
  if (dragged) { dragged = false; return; }
  if (identifying) {
    const r0 = mapEl.getBoundingClientRect();
    const ix = e.clientX - r0.left, iy = e.clientY - r0.top;
    if (ix < 0 || iy < 0 || ix > r0.width || iy > r0.height) return;
    const at0 = pixelToLatLng(ix, iy);
    identifying = false;
    ownBtn.classList.remove('on');
    ownBtn.textContent = 'Who owns this?';
    mapEl.classList.remove('placing');
    lookupParcel(at0.lat, at0.lng);
    return;
  }
  if (measuring) {
    const rr = mapEl.getBoundingClientRect();
    const mx2 = e.clientX - rr.left, my2 = e.clientY - rr.top;
    if (mx2 < 0 || my2 < 0 || mx2 > rr.width || my2 > rr.height) return;
    const at2 = pixelToLatLng(mx2, my2);
    measuring.points.push([at2.lng, at2.lat]);
    measureBox();
    draw();
    return;
  }
  if (drawing) {
    const rd = mapEl.getBoundingClientRect();
    const dx = e.clientX - rd.left, dy = e.clientY - rd.top;
    if (dx < 0 || dy < 0 || dx > rd.width || dy > rd.height) return;
    const at = pixelToLatLng(dx, dy);
    drawing.points.push([at.lng, at.lat]);
    routeTip(drawing.points.length + ' point' + (drawing.points.length === 1 ? '' : 's')
      + ' \u2014 <b>Enter</b> to finish, <b>Esc</b> to cancel.');
    draw();
    return;
  }
  if (marking) {
    const rm = mapEl.getBoundingClientRect();
    const mx = e.clientX - rm.left, my = e.clientY - rm.top;
    if (mx < 0 || my < 0 || mx > rm.width || my > rm.height) return;
    const at = pixelToLatLng(mx, my);
    marking = false;
    markBtn.classList.remove('on');
    markBtn.textContent = '+ Mark sign';
    mapEl.classList.remove('placing');
    openMarkerForm({ lat: at.lat, lng: at.lng });
    return;
  }
  if (!placing) return;
  const r = mapEl.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  if (px < 0 || py < 0 || px > r.width || py > r.height) return;
  const at = pixelToLatLng(px, py);
  placing = false;
  addBtn.classList.remove('on');
  addBtn.textContent = '+ Add stand';
  mapEl.classList.remove('placing');
  openStandForm({ lat: at.lat, lng: at.lng });
});

let drag = null;
// A pan ends in a click, and every map mode treats a click as "put something
// here" — so dragging the map to see the rest of a shape dropped a measure
// point where you let go. Anything past a few pixels is a drag, not a tap;
// the threshold also absorbs the wobble of a finger on glass.
const DRAG_SLOP_PX = 5;
let dragged = false;
mapEl.addEventListener('pointerdown', e => {
  // Same test as the click handler, deliberately: pressing a control must not
  // start a drag, and must not capture the pointer away from that control.
  if (!onMapGround(e.target)) return;
  drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
  dragged = false;
  mapEl.classList.add('drag');
  mapEl.setPointerCapture(e.pointerId);
});
mapEl.addEventListener('pointermove', e => {
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x0) > DRAG_SLOP_PX
      || Math.abs(e.clientY - drag.y0) > DRAG_SLOP_PX) dragged = true;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { ...drag, x: e.clientX, y: e.clientY };
  const cx = projX(centre.lng, zoom) - dx, cy = projY(centre.lat, zoom) - dy;
  const n = TS * 2 ** zoom;
  centre.lng = cx / n * 360 - 180;
  centre.lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / n))) * 180 / Math.PI;
  draw();
});
for (const ev of ['pointerup', 'pointercancel'])
  mapEl.addEventListener(ev, () => { drag = null; mapEl.classList.remove('drag'); });
// Each layer has its own deepest usable zoom — USGS topo stops well short of
// the imagery — so clamp against the active layer rather than a fixed 19,
// otherwise zooming in past coverage silently paints blank tiles.
const setZoom = z => {
  zoom = Math.max(2, Math.min(LAYERS[layerKey].maxZoom, z));
  draw();
};
document.getElementById('zin').onclick = () => setZoom(zoom + 1);
document.getElementById('zout').onclick = () => setZoom(zoom - 1);
mapEl.addEventListener('wheel', e => {
  e.preventDefault();
  setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });
addEventListener('resize', draw);
paintControl();
draw();
// Said once, in the note strip, rather than by hiding the map. Both facts are
// worth telling apart: a camera that has not reported GPS is a camera problem,
// and having nothing placed at all is a "drop your first pin" problem.
if (!framePoints.length) {
  terrainNote('Nothing has coordinates yet. Pan to your ground and press '
    + '<b>+ Add stand</b>, or run a sync once a camera reports GPS.');
} else if (!located.length) {
  terrainNote('No camera has reported GPS, so the map is framed on your stands '
    + 'and markers instead.');
}
`;
