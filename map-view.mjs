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
import { browserSource as coverSource } from './coverage.mjs';
import { browserSource as t3dSource } from './terrain3d.mjs';
import { browserSource as groundsSource } from './grounds.mjs';

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
  /* The map clips its overflow, so a form taller than 420px loses its ends —
     and with them the Save row. It was already close with sixteen wind buttons
     and a notes box; the lane section tipped it over and the buttons became
     literally unclickable. Scroll inside instead of growing past the edge. */
  .standform { position: absolute; left: 50%; top: 50%; z-index: 5;
               transform: translate(-50%, -50%); width: min(340px, 90%);
               max-height: calc(100% - 20px); overflow-y: auto;
               background: var(--panel); border: 1px solid var(--line);
               border-radius: 10px; padding: 16px; box-shadow: 0 6px 28px rgba(0,0,0,.4); }
  /* The stand form moves out of the middle.

     Dead centre was right while this was a form you filled in and closed. It
     is now a form you edit while dragging handles on the map behind it, and a
     panel in the centre covers the stand you just clicked — so the handles are
     underneath it. Measured with a real drag: the press landed on .winds, the
     tick grid, and the cone never moved. Only the stand form gets this; the
     marker and route forms share the class but not the problem. */
  .standform.aside { left: 10px; top: 10px; transform: none;
                     max-height: calc(100% - 20px); }
  /* No room beside it on a phone, so it becomes a sheet along the bottom and
     the stand is recentred above it — the same trade the tracing strip makes,
     for the same reason. */
  @media (max-width: 700px) {
    .standform.aside { left: 10px; right: 10px; top: auto; bottom: 10px;
                       width: auto; max-height: 60%; }
  }
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
  /* What is left of the sixteen tick-boxes: a read-out of what a stand was
     ticked with before lanes existed, and a way to drop it. Deliberately not
     styled as an input — it is not one any more. */
  .oldwinds { margin-top: 4px; padding: 8px 10px; border: 1px solid var(--line);
              border-radius: 6px; background: var(--bg); }
  .oldwinds b { font-size: 13px; }
  .oldwinds .hint { margin: 4px 0 7px; }
  .oldwinds button { border: 1px solid var(--line); background: var(--panel);
                     color: var(--muted); border-radius: 5px; padding: 4px 9px;
                     font: inherit; font-size: 12px; cursor: pointer; }
  .oldwinds button:hover { color: var(--bad); border-color: var(--bad); }
  .parcelcard .row { display: flex; justify-content: space-between; gap: 12px;
                     padding: 3px 0; color: var(--muted); }
  .parcelcard .row b { color: var(--ink); font-weight: 600; text-align: right; }
  .layers.open .layermenu { display: flex; }
  .layers.open .swatch { visibility: hidden; }
  .layermenu button.on { border-color: var(--accent); }
  /* Top-LEFT: the zoom buttons own the top-right and the layer switcher the
     bottom-left, so this is the only free corner. */
  /* The map tools, as a tree. Eight buttons in a flat stack had stopped
     reading as anything — a quarter of the map's height of undifferentiated
     grey. Grouped under branches they read the way they are used: you come to
     the map to do something ABOUT stands, or scouting, or the ground, and the
     other groups fold away. The guide lines are the point, not decoration:
     they are what says "Suggest a stand" belongs to Stands. */
  .maptools { position: absolute; left: 10px; top: 10px; z-index: 3;
              display: flex; flex-direction: column; gap: 0; width: 178px; }
  .tt-root { text-align: left; font-weight: 700; }
  .tt-root::before { content: '▾'; display: inline-block; margin-right: 6px;
                     transition: transform .15s ease; }
  #tooltree.closed .tt-root::before { transform: rotate(-90deg); }
  #tooltree.closed .tt-body { display: none; }
  .tt-body { display: flex; flex-direction: column; margin-top: 2px; }
  /* One trunk down the left; every row hangs a branch off it. The last row in
     each group closes its trunk with an L rather than running past the join. */
  .tt-group, .tt-leaf { position: relative; margin-left: 9px; padding-left: 12px; }
  .tt-group::before, .tt-leaf::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    border-left: 2px solid var(--line); }
  .tt-group:last-child::before, .tt-leaf:last-child::before { bottom: auto; height: 14px; }
  .tt-group > .tt-head::before, .tt-leaf > button::before {
    content: ''; position: absolute; left: -12px; top: 13px; width: 10px;
    border-top: 2px solid var(--line); }
  .tt-group > .tt-head, .tt-leaf > button { position: relative; }
  .tt-head { text-align: left; color: var(--muted); font-weight: 700; }
  .tt-head::after { content: '▾'; float: right; transition: transform .15s ease; }
  .tt-group.closed .tt-head::after { transform: rotate(-90deg); }
  .tt-group.closed .tt-kids { display: none; }
  .tt-kids { display: flex; flex-direction: column; position: relative;
             margin-left: 9px; padding-left: 12px; }
  .tt-kids::before { content: ''; position: absolute; left: 0; top: 0;
                     bottom: 11px; border-left: 2px solid var(--line); }
  .tt-kids > button { position: relative; text-align: left; }
  .tt-kids > button::before { content: ''; position: absolute; left: -12px;
                              top: 12px; width: 10px; border-top: 2px solid var(--line); }
  .maptools button { width: 100%; margin-top: 3px; }
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
  /* Shooting lanes. Drawn from the stand outward, with a node at the far end
     where the shot ends — the two together read as "I can shoot to there",
     which a bare line does not. */
  /* The cone is filled by a gradient defined per stand; the stops carry the
     colour so it stays in one place and follows the theme. No outline: an edge
     would draw a hard boundary where the whole point is that the shot fades
     out rather than stopping. */
  #contours path.lane { stroke: none; }
  #contours stop.lane-near { stop-color: #1b4fd8; stop-opacity: .72; }
  #contours stop.lane-mid  { stop-color: #2f6be0; stop-opacity: .34; }
  #contours stop.lane-far  { stop-color: #4a86ec; stop-opacity: 0; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) #contours stop.lane-near { stop-color: #3f7dff; stop-opacity: .70; }
    :root:not([data-theme="light"]) #contours stop.lane-mid  { stop-color: #5a92ff; stop-opacity: .32; }
  }
  /* The far end still gets a dot: it is where the shot ends, and while tracing
     it is the thing you look at to judge whether the lane went where you
     meant. */
  #contours circle.lanenode { fill: rgba(120,170,255,.9); stroke: rgba(10,25,70,.7);
                              stroke-width: 1; }
  /* Handles on the lane whose form is open: one at the tip for how far the
     shot goes, one on each rim edge for how wide it opens.

     The grabbing circle is sixteen pixels and invisible; the dot you see is
     five or six. That gap is deliberate — this gets used with cold fingers on
     a phone, where a five-pixel target cannot be hit, while a sixteen-pixel
     dot would cover the ground you are aiming at. pointer-events switches back
     on here because the SVG above turns it off for everything.

     touch-action:none stops the browser treating the drag as a page scroll,
     which on a phone would move the whole dashboard instead of the handle. */
  #contours circle.lanegrip { fill: transparent; stroke: none;
                              pointer-events: all; touch-action: none; cursor: grab; }
  #map.gripping #contours circle.lanegrip { cursor: grabbing; }
  #contours circle.lanedot { fill: rgba(210,230,255,.95); stroke: rgba(10,25,70,.85);
                             stroke-width: 1.4; pointer-events: none; }
  /* The tip is the one that moves the lane itself, so it reads as the primary
     handle; the width pair is drawn hollow so the two jobs are told apart
     before you grab one rather than after. */
  #contours circle.lanedot.tip { fill: rgba(255,235,140,.95); }
  #contours circle.lanedot.left, #contours circle.lanedot.right {
    fill: rgba(20,40,90,.55); stroke: rgba(210,230,255,.95); }
  /* The cone's own edges, drawn only while its form is open. Faint and dashed:
     they are there to show the width handles belong to the cone, not to put a
     hard boundary on a shot that fades. */
  #contours path.laneedge { fill: none; stroke: rgba(210,230,255,.55);
                            stroke-width: 1.2; stroke-dasharray: 5 4; }
  /* What the lane measures, written on the ground beside it.

     The form carries the same two numbers, and that was not enough: while you
     are dragging a handle your eyes are on the cone, and while tracing the
     form is a strip along the bottom whose row for this lane may have scrolled
     out of it. A number that only exists where you are not looking is a number
     you adjust by guessing.

     Stroked and then filled rather than given a background plate, because a
     box behind every tip would cover the ground the lane ends on — which is
     the thing being aimed at. */
  #contours text.lanesay { font: 700 11px ui-sans-serif, system-ui, sans-serif;
                           fill: #eaf1ff; stroke: rgba(6,14,36,.9); stroke-width: 3;
                           paint-order: stroke; text-anchor: middle;
                           dominant-baseline: middle; pointer-events: none; }
  /* Tracing puts the form away and moves it to a strip along the bottom.
     Measured while driving the feature: the full form covers 47% of the map,
     and a right-hand panel still swallowed two clicks out of three in a
     natural pattern around the stand. A short strip along one edge blocks far
     less of the ground you are trying to point at, and works better on a
     phone besides. */
  .standform.tracing { left: 10px; right: 10px; top: auto; bottom: 10px;
                       /* The base rule centres with a translate. Changing the
                          offsets without clearing it shifts the strip half its
                          own width off the left edge and clips the text. */
                       transform: none;
                       width: auto; max-width: none; max-height: 168px; padding: 10px 12px;
                       /* A column, so the lane list can be the part that
                          scrolls. The list already asked to (overflow-y and
                          min-height:0 below) and the request was inert without
                          this: it was laid out at full height below the
                          strip's bottom edge and simply vanished, taking the
                          rows with it the moment one grew past a single line.
                          Seen in a screenshot, not in a test. */
                       display: flex; flex-direction: column; }
  .standform.tracing .standmain { display: none; }
  /* Inside the strip the derived winds come first — they are the answer, and
     a fourth lane used to push them past the strip's height and out of sight
     at exactly the moment they changed. That ordering is done in the DOM, not
     with a CSS order property: an earlier flex version left the save row
     sorting alongside the heading, which was both wrong and hard to follow.
     Everything except the lane section is put away. */
  .standform.tracing h3 { margin: 0 0 4px; font-size: 13px; }
  .standform.tracing .standmain,
  .standform.tracing .formrow,
  .standform.tracing > button.danger { display: none; }
  /* The winds are the part allowed to grow, and therefore the part that
     scrolls when the strip runs out of room: the line that matters is its
     first, and what would be pushed off is the "this disagrees with what was
     ticked" note underneath it. */
  .standform.tracing .lanewinds { margin: 0 0 6px; flex: 1 1 auto;
                                  overflow-y: auto; min-height: 0; }
  .standform.tracing .lanetrace { margin: 0 0 6px; flex: 0 0 auto; }
  /* The heading already says what this is while tracing, so the section label
     under it is 18 pixels of repetition in the one place there is no room. */
  .standform.tracing > label { display: none; }
  /* Room for a row or two, scrolling past that, and it does not get squeezed
     to nothing when the winds above it run long — which is exactly what
     flex: 1 gave it. */
  .standform.tracing .lanelist { flex-direction: row; flex-wrap: wrap;
                                 overflow-y: auto; min-height: 0;
                                 flex: 0 0 auto; max-height: 56px; }
  .standform.tracing .lanerow { flex: 0 1 auto; }
  /* Naming a lane is not what you are doing while tracing — you are clicking
     points at the far end of one — and the name box is the whole reason a row
     needs a second line. Out of the strip, still in the panel. */
  .standform.tracing .lanerow .name { display: none; }
  .lanelist { display: flex; flex-direction: column; gap: 7px; margin-top: 6px; }
  /* The row wraps, because it is now four controls rather than two readouts
     and three hundred pixels of form does not hold them on one line. The name
     box is the one given a flexible basis, so what wraps away first is the
     optional field rather than the numbers that define the lane. */
  .lanerow { display: flex; gap: 6px; align-items: center; font-size: 12px;
             flex-wrap: wrap; }
  .lanerow .dir { font-weight: 700; min-width: 30px; }
  /* A number and its unit, read as one control. The unit is spelled out beside
     the box rather than left to a placeholder, because a placeholder vanishes
     the moment the box has a value in it — which here is always. */
  .lanenum { display: inline-flex; align-items: center; gap: 3px; }
  .lanenum input { width: 58px; padding: 3px 5px; font-size: 12px; text-align: right;
                   font-variant-numeric: tabular-nums; }
  .lanenum .u { color: var(--muted); white-space: nowrap; }
  /* The half-angle doubled, which is what is actually stored, kept beside the
     width it was computed from. Read-only on purpose: it is the same fact as
     the box next to it, and a second box for one value is how two inputs for
     one answer start again. */
  .lanerow .deg { color: var(--muted); font-variant-numeric: tabular-nums; }
  .lanerow .name { flex: 1 1 110px; min-width: 0; padding: 3px 6px; font-size: 12px; }
  .lanerow button { border: 1px solid var(--line); background: var(--bg); color: var(--muted);
                    border-radius: 5px; cursor: pointer; padding: 2px 7px; font-size: 12px; }
  .lanerow button:hover { color: var(--bad); border-color: var(--bad); }
  .lanetrace { margin-top: 7px; width: 100%; padding: 6px; border-radius: 6px;
               font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
               border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .lanetrace.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .lanewinds { margin-top: 7px; font-size: 12px; color: var(--muted); }
  .lanewinds b { color: var(--ink); }
  .lanewinds .no { color: var(--bad); }
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
  /* The stand's verdict for the coming sit, worn on the pin. Fixed colours
     rather than theme variables, because they sit on satellite imagery which
     does not change with the theme — and because green/orange/red is a code
     that must not drift. The glow is what makes them read at a glance from
     across the map, which is the entire point of putting the answer here
     instead of only in a panel. */
  .stand.rank-good { background: #2e9e57; box-shadow: 0 0 0 4px rgba(46,158,87,.30), 0 1px 4px rgba(0,0,0,.5); }
  .stand.rank-mid  { background: #d98f14; box-shadow: 0 0 0 4px rgba(217,143,20,.30), 0 1px 4px rgba(0,0,0,.5); }
  .stand.rank-bad  { background: #c8392e; box-shadow: 0 0 0 4px rgba(200,57,46,.32), 0 1px 4px rgba(0,0,0,.5); }
  /* The ground in three dimensions. Sits over the whole 2D map — tiles,
     tools, handles — because the two are different answers to different
     questions and showing both at once would be neither. The select panel
     stays above it (z below), so a pin clicked on the terrain opens the same
     report it opens flat. */
  #view3d { position: absolute; inset: 0; z-index: 7; background: #10131c; }
  #view3d canvas { position: absolute; inset: 0; width: 100%; height: 100%;
                   touch-action: none; cursor: grab; display: block; }
  #view3d.drag canvas { cursor: grabbing; }
  #pins3d { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
  /* The pins are the SAME classes the flat map uses, so a red stand is red in
     both worlds; only their positioning pipeline differs. Labels fade with
     nothing behind them, so they stay readable over bright ground. */
  #pins3d .stand, #pins3d .pin { pointer-events: auto; }
  .hud3d { position: absolute; left: 10px; top: 52px; z-index: 8; width: 220px;
           display: flex; flex-direction: column; gap: 8px;
           background: var(--panel); border: 1px solid var(--line);
           border-radius: 10px; padding: 10px 12px;
           box-shadow: 0 4px 18px rgba(0,0,0,.35); }
  .hud3d button { padding: 7px 10px; font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
                  border: 1px solid var(--line); border-radius: 6px; cursor: pointer;
                  background: var(--bg); color: var(--ink); }
  .hud3d label { display: flex; align-items: center; gap: 6px; font-size: 12px;
                 color: var(--muted); }
  .hud3d input[type=range] { flex: 1; min-width: 0; }
  .hud3d .hint3d { font-size: 11px; color: var(--muted); line-height: 1.45; }
  /* What you selected: the hunting report for a stand, or a camera's card.
     Left of the zoom buttons, under the top bar. */
  .selpanel { position: absolute; right: 54px; top: 52px; z-index: 9; width: 330px;
              max-width: calc(100% - 70px); max-height: calc(100% - 120px);
              overflow-y: auto; background: var(--panel); border: 1px solid var(--line);
              border-radius: 10px; padding: 12px 14px;
              box-shadow: 0 6px 28px rgba(0,0,0,.4); }
  .selpanel h3 { margin: 0 24px 2px 0; font-size: 15px; }
  .selpanel .close { position: absolute; right: 8px; top: 6px; cursor: pointer;
                     background: none; border: 0; color: var(--muted); font-size: 17px; }
  .selpanel .kind { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .selpanel .sitline { color: var(--muted); font-size: 12px; margin: 8px 0 4px; }
  .selpanel .sitline b { color: var(--ink); }
  .rankchip { display: inline-flex; align-items: center; gap: 6px; margin: 4px 0;
              font: 700 12px/1 ui-sans-serif, system-ui, sans-serif;
              padding: 5px 10px; border-radius: 999px; }
  .rankchip i { width: 9px; height: 9px; border-radius: 50%; }
  .rankchip.good { background: rgba(46,158,87,.15); color: #2e9e57; }
  .rankchip.good i { background: #2e9e57; }
  .rankchip.mid { background: rgba(217,143,20,.15); color: #b06d15; }
  .rankchip.mid i { background: #d98f14; }
  .rankchip.bad { background: rgba(200,57,46,.14); color: #c8392e; }
  .rankchip.bad i { background: #c8392e; }
  .rankchip.unknown { background: rgba(128,128,128,.14); color: var(--muted); }
  .rankchip.unknown i { background: var(--muted); }
  .selpanel ul.reasons { margin: 6px 0 0; padding-left: 18px; font-size: 12px;
                         color: var(--muted); }
  .selpanel ul.reasons li { margin: 3px 0; }
  .selpanel ul.reasons li.plus { color: var(--ok); }
  .selpanel ul.reasons li.minus { color: var(--bad); }
  .selpanel .fact { display: flex; justify-content: space-between; gap: 12px;
                    font-size: 12px; padding: 3px 0; color: var(--muted); }
  .selpanel .fact b { color: var(--ink); font-weight: 600; text-align: right; }
  .selpanel .camrow { font-size: 12px; color: var(--muted); padding: 2px 0; }
  .selpanel .camrow a { color: var(--accent); cursor: pointer; }
  .selpanel .btns { display: flex; gap: 8px; margin-top: 12px; }
  .selpanel .btns button { flex: 1; padding: 7px; border-radius: 6px; cursor: pointer;
                           font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
                           border: 1px solid var(--line); background: var(--bg);
                           color: var(--ink); }
  .selpanel .btns button.primary { background: var(--accent); color: #fff;
                                   border-color: var(--accent); }
  .selpanel .note { margin-top: 8px; font-size: 12px; color: var(--muted); }
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
    <div class="maptools" id="tooltree">
      <button class="tt-root" id="ttRoot" type="button">Tools</button>
      <div class="tt-body">
        <div class="tt-group">
          <button class="tt-head" type="button">Stands</button>
          <div class="tt-kids">
            <button id="addStand" type="button">+ Add stand</button>
            <button id="suggestBtn" type="button">Suggest a stand</button>
          </div>
        </div>
        <div class="tt-group">
          <button class="tt-head" type="button">Scouting</button>
          <div class="tt-kids">
            <button id="markBtn" type="button">+ Mark sign</button>
            <button id="routeBtn" type="button">+ Walk-in route</button>
          </div>
        </div>
        <div class="tt-group">
          <button class="tt-head" type="button">Ground</button>
          <div class="tt-kids">
            <button id="terrainBtn" type="button">Terrain</button>
            <button id="view3dBtn" type="button">3D view</button>
            <button id="measureBtn" type="button">Measure</button>
            <button id="whoOwns" type="button">Who owns this?</button>
          </div>
        </div>
        <div class="tt-leaf"><button id="offlineBtn" type="button">Save offline</button></div>
      </div>
    </div>
    <div id="view3d" hidden>
      <canvas id="gl3d"></canvas>
      <div id="pins3d"></div>
      <div class="hud3d">
        <button id="exit3d" type="button">&larr; Back to the map</button>
        <label>Relief
          <input id="exagg3d" type="range" min="1" max="4" step="0.5" value="1.5">
          <span id="exaggSay">1.5&times;</span>
        </label>
        <div class="hint3d" id="hint3d"></div>
      </div>
    </div>
    <div class="selpanel" id="selpanel" hidden></div>
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
${coverSource('COVER')}
${t3dSource('T3D')}
${groundsSource('GROUNDS')}

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

// Centre on a set of points, at the widest zoom whose pixel span still fits
// the viewport. A single point has no span, so it settles at 18 and is then
// clamped by the layer's own maximum when the first draw happens. A function
// rather than inline arithmetic because the ground switcher re-frames with
// exactly the same rule — two fitting rules is how "jump to the other
// property" and "open the map" would come to disagree about what fits.
function frameFor(pts) {
  const lats = pts.map(p => p[1]), lngs = pts.map(p => p[0]);
  const [m1, m2] = [Math.min(...lats), Math.max(...lats)];
  const [n1, n2] = [Math.min(...lngs), Math.max(...lngs)];
  const at = { lat: (m1 + m2) / 2, lng: (n1 + n2) / 2 };
  let z = 16;
  for (let zz = 18; zz >= 2; zz--) {
    const w = Math.abs(projX(n2, zz) - projX(n1, zz)), h = Math.abs(projY(m1, zz) - projY(m2, zz));
    if (w < mapEl.clientWidth - 90 && h < mapEl.clientHeight - 90) { z = zz; break; }
  }
  return { centre: at, zoom: z };
}

// Nothing placed at all: the continental US, wide, so panning to your ground
// and dropping the first stand is possible rather than blocked.
let zoom = 4, centre = { lat: 39.5, lng: -98.35 };
if (framePoints.length) ({ centre, zoom } = frameFor(framePoints));

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
    if (selected && selected.kind === 'camera' && selected.id === c.id) p.classList.add('sel');
    p.onclick = ev => { ev.stopPropagation(); showCameraPanel(c); };
    pinsEl.append(lab, p);
  }

  // Stands: teardrops rather than circles, so they read as a different KIND of
  // thing than a camera even at a glance or in greyscale.
  for (const s of STANDS) {
    const x = projX(s.lng, zoom) - left, y = projY(s.lat, zoom) - top;
    if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
    const lab = el('div', 'slabel', s.name);
    lab.style.left = x + 'px'; lab.style.top = y + 'px';
    const rank = rankOf(s.id);
    const pin = el('div', 'stand' + (rank ? ' rank-' + rank : '')
      + ((editing && editing.id === s.id)
        || (selected && selected.kind === 'stand' && selected.id === s.id) ? ' sel' : ''));
    pin.style.left = x + 'px'; pin.style.top = y + 'px';
    // The winds this stand is actually judged on, which since the tick-boxes
    // went is the lanes wherever they exist. Showing the ticked set here would
    // have the tooltip disagree with the ranking on any stand carrying both.
    const pinWinds = s.effectiveWinds && s.effectiveWinds.length ? s.effectiveWinds : s.winds;
    pin.title = s.name + ' \u2014 ' + s.type.replace('-', ' ')
      + (pinWinds && pinWinds.length ? ' \u00b7 good on ' + pinWinds.join(', ') : '')
      + (s.nearbyCameras && s.nearbyCameras.length
        ? ' \u00b7 covers ' + s.nearbyCameras.map(c => c.name + ' (' + c.metres + 'm)').join(', ')
        : '');
    pin.onclick = ev => { ev.stopPropagation(); showStandReport(s); };
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

/**
 * Save the GROUND for this view, not only its tiles: the elevation the 3D
 * view and the terrain layer are built from, and the imagery the 3D drapes.
 *
 * Fetching /api/terrain here does two jobs with one request. The server
 * fetches the ground from USGS and stores the grid in its database, so the
 * cabin with no internet can still answer; and the answer passes through the
 * service worker on its way here, which caches it on the phone, so the woods
 * with no server can too. Then the 3D drape tiles are pulled once through the
 * page for the same reason — each lands in the worker's cache on the way.
 *
 * Failures are partial and said out loud: tiles saved with no ground is still
 * a saved map, and claiming more than that is how you end up in the woods
 * with a 3D button that does not press.
 */
async function saveGroundForView() {
  const { radius, spacing } = terrainRequestForView();
  const res = await fetch('/api/terrain?lat=' + centre.lat + '&lng=' + centre.lng
    + '&radius=' + radius + '&spacing=' + spacing);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'the ground could not be read');
  if (!body.covered) return { line: 'No LiDAR under this view, so there is no 3D to save.' };
  // The drape at the same size the 3D view will ask for, so what is warmed is
  // what will be wanted. The canvas is thrown away; the tiles are the point.
  await textureFor3d(body.bounds);
  return {
    line: '<b>3D saved too</b> \u2014 the ground ('
      + body.stats.reliefFt + ' ft of relief) and its imagery. The 3D view of '
      + 'this ground now works with no signal at all.'
      + (body.note ? '<br><span class="warn">' + body.note + '</span>' : ''),
  };
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
    // The ground rides along with the tiles. Its failure must not undo the
    // tile save that already worked — the map without 3D is still a map.
    let ground;
    offlineBtn.textContent = 'Saving the ground\u2026';
    try {
      ground = await saveGroundForView();
    } catch (err) {
      ground = { line: '<span class="warn">Tiles saved, but the ground could not be: '
        + err.message + '. The 3D view of this ground will still need a connection.</span>' };
    }
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
      + r.refused.map(x => '<br><span class="warn">' + x.why + '</span>').join('')
      + '<br>' + ground.line);
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
  // Shares the stand form's class and its place on the map, so opening one
  // has to put the other away properly rather than just deleting the node.
  closeStandForm();
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
  // Shares the stand form's class and its place on the map, so opening one
  // has to put the other away properly rather than just deleting the node.
  closeStandForm();
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
  if (keep !== 'lane' && laneEdit) { laneEdit = null; }
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
// ---- shooting lanes ----------------------------------------------------
// What a stand can actually see and shoot, which is the thing you know when
// you are standing under the tree. The winds follow from it — ticking sixteen
// boxes was doing that derivation in your head every time, and getting it
// slightly wrong.
//
// Traced while the stand form is open: the form stays up, the map arms, and
// each click drops the far end of a lane. The winds are recomputed and shown
// as each one lands, because a derivation you only see after saving is one you
// cannot correct.
let laneEdit = null;    // { stand: {lat,lng}, lanes: [], onLanes, onNumbers } while tracing

// The lanes belonging to the stand form that is currently open, whether or not
// it is armed for tracing.
//
// This is separate from laneEdit for two reasons. Handles have to be grabbable
// without arming the map, or adjusting a lane you already have would mean
// entering a mode that drops a new one on the first stray click. And the map
// used to draw the SAVED lanes whenever the form was open but not tracing, so
// removing a lane redrew it and widening one would have shown nothing until
// after a save — the form's copy is the live one, and this is what makes the
// map read from it.
let laneForm = null;    // { standId, stand: {lat,lng}, lanes: [], onLanes, onNumbers }

// Which handle is being held, if any. Declared up here with the rest of the
// lane state rather than beside the listener that sets it, because the drawing
// code reads it — the cone tells you its width while you are dragging its
// width — and draw() runs before that part of the script has been reached.
let gripDrag = null;    // { i, kind } while a handle is held

/**
 * Put the stand form away and forget everything hanging off it.
 *
 * There are five ways out of that form — save, cancel, delete, opening another
 * stand, and opening the marker or route form, which share its class — and
 * before this they cleared different subsets of the state. Delete left the map
 * still armed for tracing with no form to show for it.
 */
function closeStandForm() {
  document.querySelector('.standform')?.remove();
  closeSelPanel();
  editing = null;
  laneEdit = null;
  laneForm = null;
  gripDrag = null;
  mapEl.classList.remove('placing');
}

// Drawn as a cone rather than a line, because a lane is an area you can shoot
// through, not a ray. Dark at the stand and fading out along it: past forty or
// fifty yards the shot gets harder and the ground less certainly yours, and a
// wedge of flat colour claims a confidence the distance does not support.
//
// The fade is one radial gradient per stand, centred on the stand and scaled
// to its longest lane, so every cone fades on the same true-distance scale.
// Giving each cone its own gradient would make a short lane fade as fast as a
// long one, which would read as "less certain" when it is the opposite.
//
// The cone's half-angle is the lane's own, and COVER.laneSpread is what
// supplies it — the same function the wind derivation calls. Reading the width
// here with a second copy of that rule is how a picture starts disagreeing
// with the model behind it, and the picture is what you would believe.
const laneHalfDeg = l => COVER.laneSpread(l);

// Yards, because a shot is thought about in yards — the same call measure.mjs
// makes for the same reason, and M_PER_YARD is taken from there rather than
// written again here. Everything stored and computed stays in metres; this is
// only the last step before a number is shown or the first after one is typed.
const toYd = m => Math.round(m / MEASURE.M_PER_YARD);
const fromYd = yd => yd * MEASURE.M_PER_YARD;

// Past this a lane gets a second look in the form. It is a judgement about
// shots rather than a rule about lanes — nothing is refused — and it is stated
// in yards because that is the unit the whole section now speaks in.
const LONG_LANE_YD = 300;

/** Screen bearing of a lane, in radians, measured the way a compass is. */
const screenBearing = (ax, ay, ex, ey) => Math.atan2(ex - ax, ay - ey);

/** A point on the cone's rim: t radians from north, r pixels out. */
const rimPoint = (ax, ay, r, t) => [ax + Math.sin(t) * r, ay - Math.cos(t) * r];

function conePath(ax, ay, ex, ey, halfDeg) {
  const r = Math.hypot(ex - ax, ey - ay);
  if (!(r > 1)) return null;
  const a = screenBearing(ax, ay, ex, ey);
  const h = halfDeg * Math.PI / 180;
  const [x1, y1] = rimPoint(ax, ay, r, a - h);
  const [x2, y2] = rimPoint(ax, ay, r, a + h);
  // Sweep 1: bearing grows clockwise on screen, the same way SVG measures a
  // positive sweep. Large-arc 0 while the cone stays under half a turn, which
  // the spread bounds guarantee — 80 degrees either side is 160 of a possible
  // 180. Computed rather than hard-coded anyway, because a bound that moves
  // and a flag that does not is a bug nobody would look for here.
  const large = 2 * halfDeg > 180 ? 1 : 0;
  return 'M' + ax.toFixed(1) + ' ' + ay.toFixed(1)
    + 'L' + x1.toFixed(1) + ' ' + y1.toFixed(1)
    + 'A' + r.toFixed(1) + ' ' + r.toFixed(1) + ' 0 ' + large + ' 1 '
    + x2.toFixed(1) + ' ' + y2.toFixed(1) + 'Z';
}

/**
 * The three handles on one lane of the open form.
 *
 * The tip carries the far end — drag it and the lane gets longer, shorter, or
 * swings onto different ground. The two rim handles carry the width, and
 * nothing else: a drag on one is read as an angle off the lane's bearing, so
 * the cone opens and closes about a centre line that stays where you put it.
 * Length and width being on separate handles is the whole point; a single
 * corner handle that did both would make it impossible to widen a lane without
 * also shortening it.
 *
 * Each handle is two circles. The visible one is small enough not to hide the
 * ground it sits on; the invisible one under it is a fingertip wide, because
 * this is used on a phone in the cold and a five-pixel target is not a target.
 */
// The width handles sit part of the way out the cone's edge, not at its far
// corners. At the corners they would be a tenth of the lane's length from the
// tip on a default 20-degree cone — measured: 10 pixels apart on a 60-pixel
// lane, so the tip's grab circle covered both of them and the first width drag
// dragged the tip instead. Pulled back to here they are 42% of the way out
// from the tip, which stays clear at every width a lane may be set to.
const WIDTH_GRIP_AT = 0.6;

function laneGrips(ax, ay, l, i, left, top) {
  const ex = projX(l.to[0], zoom) - left, ey = projY(l.to[1], zoom) - top;
  const r = Math.hypot(ex - ax, ey - ay);
  if (!(r > 1)) return [];
  const a = screenBearing(ax, ay, ex, ey);
  const h = laneHalfDeg(l) * Math.PI / 180;
  // Grab circles scale with the lane, because their spacing does. A fixed
  // sixteen pixels is right on a lane that fills the map and swallows all
  // three handles on one drawn short; the cap keeps a fingertip target
  // wherever there is room for one, and the floor keeps a very short lane
  // grabbable at all rather than perfect.
  const grab = Math.max(8, Math.min(16, r * 0.2));
  const dot = Math.max(3, Math.min(6, r * 0.075));
  const grip = (x, y, kind, vis) =>
    '<circle class="lanegrip" data-lane="' + i + '" data-grip="' + kind + '"'
    + ' cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + grab.toFixed(1) + '"></circle>'
    + '<circle class="lanedot ' + kind + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1)
    + '" r="' + vis.toFixed(1) + '"></circle>';
  const [lex, ley] = rimPoint(ax, ay, r, a - h);
  const [rex, rey] = rimPoint(ax, ay, r, a + h);
  const [lx, ly] = rimPoint(ax, ay, r * WIDTH_GRIP_AT, a - h);
  const [rx, ry] = rimPoint(ax, ay, r * WIDTH_GRIP_AT, a + h);
  return [
    // The rim edges, so the width handles read as sitting on the cone rather
    // than floating beside it.
    '<path class="laneedge" d="M' + ax.toFixed(1) + ' ' + ay.toFixed(1)
      + 'L' + lex.toFixed(1) + ' ' + ley.toFixed(1) + '"></path>',
    '<path class="laneedge" d="M' + ax.toFixed(1) + ' ' + ay.toFixed(1)
      + 'L' + rex.toFixed(1) + ' ' + rey.toFixed(1) + '"></path>',
    // The two width handles are close together on a narrow cone and that is
    // harmless: they do the same job, and a drag on either is read as an angle
    // off the centre line, so grabbing the "wrong" one still widens the lane
    // the way you pulled. Only the tip does something different, and only the
    // tip has to stay clear.
    grip(lx, ly, 'left', dot * 0.85),
    grip(rx, ry, 'right', dot * 0.85),
    grip(ex, ey, 'tip', dot),
    laneSay(ax, ay, l, i, r, a),
  ].filter(Boolean);
}

/**
 * What this lane measures, written beside it on the ground.
 *
 * Standing state is the reach, because that is the number you check against
 * the ground you can see — "is that really eighty yards to the field edge".
 * While a width handle is held it becomes the width instead: that is the
 * number the drag is changing, it is the one that has no other reading on the
 * map, and showing both at once would put two figures in the same place at the
 * moment one of them is moving.
 *
 * Both come off the geometry rather than being worked out here, so the label
 * on the cone, the boxes in the form and the winds underneath are three views
 * of one calculation.
 */
function laneSay(ax, ay, l, i, r, a) {
  const g = laneForm && COVER.laneGeometry(laneForm.stand, l);
  if (!g) return null;
  const wide = gripDrag && gripDrag.i === i && gripDrag.kind !== 'tip';
  const text = wide ? toYd(g.widthM) + ' yd wide' : toYd(g.metres) + ' yd';
  // Always just past the tip, on the centre line, whichever number it is
  // showing. Following the handle instead was the obvious thing and was wrong:
  // a width handle on a wide cone swings back around toward the stand, and the
  // readout landed on the stand's own label. Here it is clear of everything,
  // it is where the eye already is, and it does not move while a drag changes
  // what it says.
  const [x, y] = rimPoint(ax, ay, r + 16, a);
  return '<text class="lanesay" x="' + x.toFixed(1) + '" y="' + y.toFixed(1)
    + '">' + text + '</text>';
}

function lanePaths(left, top) {
  const out = [];
  const sets = [];
  // The open form's copy wins over the saved one for the stand it belongs to,
  // armed or not: it is the array the handles and the Remove buttons mutate,
  // and drawing the saved lanes beside it would show two answers at once.
  if (laneForm) sets.push({ from: laneForm.stand, lanes: laneForm.lanes, key: 'edit', live: true });
  for (const st of STANDS) {
    if (laneForm && laneForm.standId && st.id === laneForm.standId) continue;
    if (st.lanes && st.lanes.length) sets.push({ from: st, lanes: st.lanes, key: 's' + st.id });
  }
  for (const { from, lanes, key, live } of sets) {
    const ax = projX(from.lng, zoom) - left, ay = projY(from.lat, zoom) - top;
    const cones = [];
    const grips = [];
    let longest = 0;
    lanes.forEach((l, i) => {
      if (!l || !Array.isArray(l.to)) return;
      const ex = projX(l.to[0], zoom) - left, ey = projY(l.to[1], zoom) - top;
      longest = Math.max(longest, Math.hypot(ex - ax, ey - ay));
      const d = conePath(ax, ay, ex, ey, laneHalfDeg(l));
      if (d) cones.push(d);
      if (live) grips.push(...laneGrips(ax, ay, l, i, left, top));
      else out.push('<circle class="lanenode" cx="' + ex.toFixed(1) + '" cy="' + ey.toFixed(1)
        + '" r="3"></circle>');
    });
    // Handles last, so they sit above every cone and stay grabbable where two
    // lanes overlap.
    if (grips.length) out.push(...grips);
    if (!cones.length) continue;
    const id = 'lanefade-' + key;
    out.unshift('<defs><radialGradient id="' + id + '" gradientUnits="userSpaceOnUse" cx="'
      + ax.toFixed(1) + '" cy="' + ay.toFixed(1) + '" r="' + Math.max(1, longest).toFixed(1)
      + '"><stop offset="0" class="lane-near"/><stop offset="0.55" class="lane-mid"/>'
      + '<stop offset="1" class="lane-far"/></radialGradient></defs>');
    for (const d of cones) {
      // Inline style, not a fill attribute. The overlay carries a blanket
      // "#contours path { fill: none }" for the contour lines, and a CSS
      // declaration beats a presentation attribute — so fill="url(...)" drew
      // four perfectly correct cones filled with nothing at all. An inline
      // style outranks the stylesheet and the gradient shows.
      out.push('<path class="lane" style="fill:url(#' + id + ')" d="' + d + '"></path>');
    }
  }
  return out;
}

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
    // Where this ground actually came from, when it is not a live answer.
    // Two different fallbacks can be under it: the SERVER fell back to its
    // saved grid because USGS was unreachable (body.note), or the SERVICE
    // WORKER replayed a saved answer because the server itself was
    // unreachable (the stamp it puts on everything it stores). Either way the
    // ground is real and the date is said, because saved ground shown as live
    // is how you trust a contour that is not there.
    const swAt = res.headers.get('x-sw-cached-at');
    const staleLine = (body.note ? '<br><span class="warn">' + body.note + '</span>' : '')
      + (swAt ? '<br><span class="warn">The server is unreachable — this is the '
          + 'ground as saved ' + new Date(swAt).toLocaleString() + '.</span>' : '');
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
      + staleLine
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
    .concat(lanePaths(left, top))
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

// ---- the coming sit's verdict, per stand --------------------------------
// The ranking the tonight screen runs, fetched here so the map can wear it:
// each pin is tinted by whether the NEXT sit's wind works for that stand.
// One fetch at load and one after each save — the answer changes when the
// lanes do, and a colour that lags the edit that changed it would be worse
// than no colour.
let RANKING = null;    // { sit, byId: {standId: rankedRow} } or null

async function refreshRanking() {
  if (!D.live) return;
  try {
    const t = await (await fetch('/api/tonight')).json();
    const sit = t.sits && t.sits[0];
    if (!sit || !sit.stands || !sit.stands.length) { RANKING = null; draw(); return; }
    const byId = {};
    for (const r of sit.stands) byId[r.id] = r;
    RANKING = { sit, byId };
  } catch (err) { RANKING = null; }
  draw();
}

/**
 * One stand's colour: green, orange or red.
 *
 * Green is "the coming sit's wind works, nothing arguing"; red is "your scent
 * blows down a lane"; orange is every honest in-between — winds not recorded,
 * no forecast to judge against, or a thermal quietly working against a wind
 * that looks fine. Unknown is deliberately NOT green: a stand that has not
 * said its winds must not look like one that works.
 */
function rankOf(id) {
  const r = RANKING && RANKING.byId[id];
  if (!r) return null;
  if (r.huntable === false) return 'bad';
  if (r.huntable === true) {
    return r.reasons && r.reasons.some(x => x.points < 0) ? 'mid' : 'good';
  }
  return 'mid';
}

// ---- the select panel ----------------------------------------------------
// Clicking a pin used to jump straight into the edit form, which answers the
// wrong question: mostly you are not editing, you are deciding — is this the
// stand for the sit in front of me? So a click opens the report, and the form
// is one button further away.
const selPanel = document.getElementById('selpanel');
let selected = null;   // { kind: 'stand'|'camera', id } while the panel is up

function closeSelPanel() {
  selPanel.hidden = true;
  selPanel.textContent = '';
  selected = null;
}

function panelShell(title, kindLine) {
  selPanel.textContent = '';
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'close'; x.textContent = '\u00d7';
  x.onclick = () => { closeSelPanel(); draw(); };
  selPanel.appendChild(x);
  selPanel.appendChild(el('h3', null, title));
  if (kindLine) selPanel.appendChild(el('div', 'kind', kindLine));
  selPanel.hidden = false;
}

const RANK_WORDS = {
  good: 'Good for the coming sit',
  mid: 'Marginal \u2014 look at why',
  bad: 'Wrong wind \u2014 scent runs down a lane',
  unknown: 'Not ranked',
};

/** The hunting report for one stand. */
function showStandReport(s) {
  closeStandForm();
  clearMapModes();
  selected = { kind: 'stand', id: s.id };
  panelShell(s.name, s.type.replace('-', ' ')
    + (s.notes ? ' \u00b7 ' + s.notes : ''));

  const r = RANKING && RANKING.byId[s.id];
  const rank = rankOf(s.id) || 'unknown';
  const chip = el('div', 'rankchip ' + rank);
  chip.appendChild(document.createElement('i'));
  chip.appendChild(document.createTextNode(RANK_WORDS[rank]
    + (r ? ' \u00b7 ' + (r.total > 0 ? '+' : '') + r.total + ' pts' : '')));
  selPanel.appendChild(chip);

  if (r && RANKING.sit) {
    const sit = RANKING.sit;
    const line = el('div', 'sitline');
    line.appendChild(document.createTextNode('Ranked for '));
    line.appendChild(el('b', null, sit.when || sit.date + ' ' + sit.window));
    if (sit.windFrom) {
      line.appendChild(document.createTextNode(' \u00b7 wind '));
      line.appendChild(el('b', null, sit.windFrom));
      if (Number.isFinite(sit.windSpeed)) {
        line.appendChild(document.createTextNode(' at ' + Math.round(sit.windSpeed) + ' mph'));
      }
    }
    selPanel.appendChild(line);
    const ul = el('ul', 'reasons');
    for (const part of r.reasons || []) {
      const li = el('li', part.points > 0 ? 'plus' : part.points < 0 ? 'minus' : null,
        part.why + (part.points ? ' (' + (part.points > 0 ? '+' : '') + part.points + ')' : ''));
      ul.appendChild(li);
    }
    selPanel.appendChild(ul);
  } else {
    selPanel.appendChild(el('div', 'note', D.live
      ? 'No ranking yet \u2014 run the planner (node hunt-planner.mjs) and the '
        + 'coming sits can judge this stand.'
      : 'Ranking needs the server.'));
  }

  // The facts that decide the ranking, so the verdict can be argued with.
  const winds = s.effectiveWinds && s.effectiveWinds.length ? s.effectiveWinds : (s.winds || []);
  const windRow = el('div', 'fact');
  windRow.appendChild(el('span', null, 'Huntable winds'));
  windRow.appendChild(el('b', null, winds.length
    ? winds.join(', ') + (s.windSource === 'lanes' ? ' (from its lanes)' : '')
    : 'not recorded'));
  selPanel.appendChild(windRow);
  if (s.lanes && s.lanes.length) {
    const geo = COVER.laneGeometries({ lat: s.lat, lng: s.lng }, s.lanes);
    const longest = geo.length ? Math.max(...geo.map(g => g.metres)) : 0;
    const laneRowEl = el('div', 'fact');
    laneRowEl.appendChild(el('span', null, 'Shooting lanes'));
    laneRowEl.appendChild(el('b', null, geo.length + (geo.length === 1 ? ' lane' : ' lanes')
      + (longest ? ', longest ' + toYd(longest) + ' yd' : '')));
    selPanel.appendChild(laneRowEl);
  }
  if (s.nearbyCameras && s.nearbyCameras.length) {
    const head = el('div', 'fact');
    head.appendChild(el('span', null, 'Covered by'));
    selPanel.appendChild(head);
    for (const nc of s.nearbyCameras) {
      const row = el('div', 'camrow');
      const a = el('a', null, nc.name);
      a.onclick = () => {
        const cam = D.cameras.find(c => c.id === nc.id || c.name === nc.name);
        if (cam) showCameraPanel(cam);
      };
      row.appendChild(a);
      row.appendChild(document.createTextNode(' \u00b7 ' + nc.metres + ' m away'));
      selPanel.appendChild(row);
    }
  }

  const btns = el('div', 'btns');
  if (D.live) {
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'primary'; edit.textContent = 'Edit stand';
    edit.onclick = () => { closeSelPanel(); openStandForm(s); };
    btns.appendChild(edit);
  }
  const done = document.createElement('button');
  done.type = 'button'; done.textContent = 'Close';
  done.onclick = () => { closeSelPanel(); draw(); };
  btns.appendChild(done);
  selPanel.appendChild(btns);
  draw();
}

/** A camera's card, in the same panel. */
function showCameraPanel(c) {
  closeStandForm();
  clearMapModes();
  selected = { kind: 'camera', id: c.id };
  panelShell(c.name, 'camera');
  // The card the report drawer shows, reused whole — two renderings of one
  // camera is how they end up disagreeing about battery life.
  selPanel.appendChild(cameraCard(c, { withId: false }));
  const btns = el('div', 'btns');
  const more = document.createElement('button');
  more.type = 'button'; more.textContent = 'Show in camp report';
  more.onclick = () => { revealInDrawer('cam-' + c.id); };
  btns.appendChild(more);
  const done = document.createElement('button');
  done.type = 'button'; done.textContent = 'Close';
  done.onclick = () => { closeSelPanel(); draw(); };
  btns.appendChild(done);
  selPanel.appendChild(btns);
  draw();
}

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
  // The colours are derived from the stands, so they refresh together: a lane
  // just saved can flip tonight's verdict.
  refreshRanking();
  draw();
}
refreshRanking();

// The drop/edit form. A row with an id is an edit; {lat,lng} alone is new.
/**
 * Slide the map so a stand sits in the part of it the form does not cover.
 *
 * Opening a form over the thing it edits is only cosmetically wrong until the
 * thing it edits has handles on it, and then it is the whole feature: a cone
 * under the panel cannot be dragged, and nothing tells you why. The form moves
 * to one side and this moves the stand into what is left — a map app moving a
 * pin clear of a bottom sheet, which is the behaviour people already expect.
 *
 * Measured from the form's real box rather than a guess at its size, because
 * it grows with the number of lanes and shrinks on a phone.
 */
function centreClearOfForm(form, at) {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const map = mapEl.getBoundingClientRect();
  const box = form.getBoundingClientRect();
  // Beside the form where there is room for the stand plus some ground around
  // it; above it when the form is a sheet along the bottom.
  const beside = box.width < W * 0.6;
  const tx = beside ? Math.min(W - 20, (box.right - map.left + W) / 2) : W / 2;
  const ty = beside ? H / 2 : Math.max(20, (box.top - map.top) / 2);
  const n = TS * 2 ** zoom;
  const px = projX(at.lng, zoom) + (W / 2 - tx);
  const py = projY(at.lat, zoom) + (H / 2 - ty);
  centre = {
    lng: px / n * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) * 180 / Math.PI,
  };
  draw();
}

function openStandForm(stand) {
  if (V3) exitView3d();
  closeStandForm();
  editing = stand.id ? stand : null;
  const isNew = !stand.id;
  const chosen = new Set(stand.winds || []);

  const form = el('div', 'standform');
  const head = el('h3', null, isNew ? 'New stand' : 'Edit stand');
  form.appendChild(head);
  // Everything that is not the lane section lives in here, so tracing can put
  // it away: the form covers nearly half the map, and the ground you need to
  // click is very often underneath it.
  const fields = el('div', 'standmain');
  form.appendChild(fields);

  const name = document.createElement('input');
  name.value = stand.name || '';
  name.placeholder = 'East Ridge ladder';
  fields.append(el('label', null, 'Name'), name);

  const type = document.createElement('select');
  for (const [v, labelText] of TYPES) {
    const o = document.createElement('option');
    o.value = v; o.textContent = labelText;
    if ((stand.type || 'stand') === v) o.selected = true;
    type.appendChild(o);
  }
  fields.append(el('label', null, 'Type'), type);

  // --- shooting lanes -------------------------------------------------------
  // The input you actually have. Mark where you can shoot; the winds follow.
  const lanes = (stand.lanes || []).map(l => ({
    to: l.to.slice(),
    label: l.label ?? null,
    // Copied only when the stand has one, so a lane never gains a stored width
    // just by having its form opened.
    ...(Number.isFinite(l.spread) ? { spread: l.spread } : {}),
  }));
  // Where the lanes radiate from. One object, handed to the map below as well,
  // so the boxes in this form and the handles on the cone are measuring from
  // the same point rather than from two snapshots of it.
  const at = { lat: stand.lat, lng: stand.lng };
  form.insertBefore(el('label', null, 'Shooting lanes'), fields);
  const laneList = el('div', 'lanelist');
  const laneWinds = el('div', 'lanewinds');
  const traceBtn = document.createElement('button');
  traceBtn.type = 'button';
  traceBtn.className = 'lanetrace';

  // One entry per lane, in the same order, holding the fields that have to be
  // written as a drag moves them. Kept rather than looked up, because the row
  // is rebuilt only when the SET of lanes changes: rebuilding it to show a new
  // number would destroy the box you were typing that number into, which is
  // what made typing one impossible before this existed.
  const rows = [];

  /**
   * One lane: which way, how far, how wide, what it is called, and Remove.
   *
   * The reach and the width are BOXES, not readouts. The handles on the map
   * are still the fastest way to put a lane roughly where it goes, and rough
   * is exactly their limit — you know this one runs eighty yards to the field
   * edge and opens about twenty across at the end, because you have walked it,
   * and until now the only way to say so was to drag until a readout happened
   * to agree with the number already in your head.
   */
  const laneRow = i => {
    const r = el('div', 'lanerow');
    const dir = el('span', 'dir', '');
    r.appendChild(dir);

    const num = (unit, title) => {
      const box = el('span', 'lanenum');
      const inp = document.createElement('input');
      inp.type = 'number';
      // A phone shows a plain number pad for this rather than the full
      // keyboard, which matters because this gets used in a tree.
      inp.inputMode = 'decimal';
      inp.min = '1'; inp.step = '1';
      inp.title = title;
      box.append(inp, el('span', 'u', unit));
      r.appendChild(box);
      return inp;
    };
    const reach = num('yd out',
      'How far the shot reaches. Changing it slides the far end along the '
      + 'bearing the lane already has \u2014 to swing it onto different ground, '
      + 'drag the tip.');
    const width = num('yd wide',
      'How wide the opening is where the shot ends. A lane is a cone, so '
      + 'making it longer also makes it wider on the ground; the angle beside '
      + 'this box is the part that stays put.');
    const deg = el('span', 'deg', '');
    r.appendChild(deg);

    // The numbers follow every keystroke, the same way they follow a drag: a
    // derivation you only see after committing is one you cannot correct. What
    // does NOT happen here is a rebuild of this row — see syncRows.
    reach.oninput = () => {
      const yd = Number(reach.value);
      if (!Number.isFinite(yd) || yd <= 0) return;
      const to = COVER.laneAtReach(at, lanes[i], fromYd(yd));
      if (!to) return;
      lanes[i].to = to;
      afterEdit();
    };
    width.oninput = () => {
      const yd = Number(width.value);
      if (!Number.isFinite(yd) || yd <= 0) return;
      const g = COVER.laneGeometry(at, lanes[i]);
      const spread = g && COVER.spreadForWidthM(g.metres, fromYd(yd));
      if (!spread) return;
      lanes[i].spread = spread;
      afterEdit();
    };
    // On leaving the box, or pressing Enter in it, both are written back from
    // what was actually STORED — so a width beyond what a lane may open to
    // shows the value it was pulled back to rather than the one that was
    // refused, and the boxes always end up agreeing with the cone.
    //
    // Written here rather than by rebuilding the row, because a rebuild on
    // Enter would take the box out from under a finger still resting on it.
    const settle = () => {
      const g = COVER.laneGeometry(at, lanes[i]);
      if (g) {
        reach.value = String(toYd(g.metres));
        width.value = String(toYd(g.widthM));
      }
      afterEdit();
    };
    reach.onchange = width.onchange = settle;

    const label = document.createElement('input');
    label.className = 'name';
    label.placeholder = 'name it (optional)';
    label.value = lanes[i].label || '';
    label.oninput = () => { lanes[i].label = label.value.trim() || null; };
    r.appendChild(label);

    const x = document.createElement('button');
    x.type = 'button'; x.textContent = 'remove';
    x.onclick = () => { lanes.splice(i, 1); paintLanes(); draw(); };
    r.appendChild(x);
    return { el: r, dir, reach, width, deg };
  };

  /**
   * The numbers in the rows, written in place.
   *
   * A drag changes exactly the two values the boxes hold, and they have to
   * follow it — but replacing the rows to show that would take the box out
   * from under the caret mid-word. So the DOM is written rather than rebuilt,
   * and whichever field has the focus is left alone: it already says what its
   * owner is in the middle of typing.
   *
   * Geometry is asked for per lane rather than taken from the derived list,
   * which drops any lane it cannot place and would therefore hand row 1 the
   * numbers belonging to lane 2 — and, before this, handed its Remove button
   * the wrong lane as well.
   */
  const syncRows = () => {
    rows.forEach((row, i) => {
      const g = COVER.laneGeometry(at, lanes[i]);
      if (!g) {
        row.dir.textContent = '?';
        row.deg.textContent = '';
        return;
      }
      row.dir.textContent = g.point;
      // The FULL opening, not the half-angle the model works in: "40 degrees"
      // is what you would say standing in it, and the halving is an
      // implementation detail nobody should have to hold in their head.
      row.deg.textContent = Math.round(g.spreadDeg * 2) + '\u00b0';
      if (document.activeElement !== row.reach) row.reach.value = String(toYd(g.metres));
      if (document.activeElement !== row.width) row.width.value = String(toYd(g.widthM));
    });
  };

  /** The answer the lanes add up to, and the state of the trace button. */
  const paintWinds = () => {
    const derived = COVER.huntableFromLanes(at, lanes);
    laneWinds.textContent = '';
    if (!derived) {
      laneWinds.appendChild(el('span', null,
        'None marked. Press Trace and click where you can shoot to \u2014 '
        + 'one click per lane. Then say how far and how wide each one is, '
        + 'either by typing yards into its row or by dragging the tip and the '
        + 'side handles. The winds are worked out from the shape.'));
    } else if (!derived.winds.length) {
      const n = el('span', 'no');
      n.textContent = derived.why;
      laneWinds.appendChild(n);
    } else {
      laneWinds.appendChild(document.createTextNode('Huntable on '));
      const b = el('b', null, derived.winds.join(', '));
      laneWinds.appendChild(b);
      laneWinds.appendChild(document.createTextNode(
        ' \u2014 ' + derived.winds.length + ' of 16. The rest blow your scent down a lane.'));
      // Not forbidden — it might be a long field edge you genuinely watch —
      // but this is a long way for a shot, and a lane that long is usually a
      // misplaced click that quietly rules out winds you could have hunted.
      // Said in yards, like every other distance in this section.
      const far = derived.lanes.filter(g => toYd(g.metres) > LONG_LANE_YD);
      if (far.length) {
        const w = el('div', null, far.length === 1
          ? 'That ' + toYd(far[0].metres) + ' yd lane is a long way for a shot \u2014 worth '
            + 'checking you meant it, since it rules winds out either way.'
          : far.length + ' lanes are over ' + LONG_LANE_YD + ' yd, which is a long way '
            + 'for a shot.');
        w.style.marginTop = '4px';
        w.style.color = 'var(--warn)';
        laneWinds.appendChild(w);
      }
      // Only where an older ticked set exists to disagree with. It no longer
      // competes for the answer — the lanes have it — so this is reported as
      // something to look at rather than something to reconcile.
      const cmp = COVER.compareToManual(derived, [...chosen]);
      if (cmp && cmp.agree === false) {
        const d = el('div', null, 'Different from what was ticked before: ' + cmp.why);
        d.style.marginTop = '4px';
        d.style.color = 'var(--warn)';
        laneWinds.appendChild(d);
      }
    }
    traceBtn.textContent = laneEdit ? 'Done tracing' : (lanes.length ? '+ Another lane' : 'Trace a lane');
    traceBtn.classList.toggle('on', !!laneEdit);
    form.classList.toggle('tracing', !!laneEdit);
    head.textContent = laneEdit
      ? 'Click where you can shoot to'
      : (isNew ? 'New stand' : 'Edit stand');
  };

  /** A typed edit: everything follows it except the row that caused it. */
  const afterEdit = () => { syncRows(); paintWinds(); draw(); };

  /** Rebuild the list. For when a lane arrives or leaves, not for a number. */
  const paintLanes = () => {
    laneList.textContent = '';
    rows.length = 0;
    lanes.forEach((l, i) => {
      const row = laneRow(i);
      rows.push(row);
      laneList.appendChild(row.el);
    });
    syncRows();
    paintWinds();
  };

  traceBtn.onclick = ev => {
    ev.stopPropagation();
    if (laneEdit) { laneEdit = null; paintLanes(); draw(); return; }
    clearMapModes('lane');
    laneEdit = laneForm;
    mapEl.classList.add('placing');
    // Put the stand where you can see AND click around it. Whichever edge the
    // form is pinned to it can end up over the stand, and then most of the
    // ground you want to mark is behind it — which is exactly what happened:
    // two clicks in three landed on the panel instead of the map.
    //
    // paintLanes first: tracing collapses the form to a strip along the
    // bottom, and the recentre has to be measured from that box rather than
    // from the panel it just stopped being.
    paintLanes();
    centreClearOfForm(form, stand);
  };
  for (const n of [laneWinds, traceBtn, laneList]) form.insertBefore(n, fields);

  // --- winds ticked before there were lanes ---------------------------------
  //
  // The sixteen tick-boxes are gone (Kent's call, 2026-08-28). Two inputs for
  // one answer is how they drift apart, and the boxes were always the worse of
  // the two: they asked you to do in your head the derivation the lanes do
  // exactly.
  //
  // What is NOT gone is the data. A stand ticked before lanes existed is still
  // ranked on those winds when it has no lanes, so deleting the column would
  // silently un-rank stands that work today. They are shown, read-only, with
  // where they came from — and with a way to clear them, because removing the
  // only editor for a field that still drives the ranking would otherwise
  // leave a wrong set permanently unfixable.
  if (chosen.size) {
    // The label is held rather than dropped straight into the form, because
    // Clear has to take it away too — otherwise the heading outlives the thing
    // it heads and the form reads as having lost its contents.
    const oldLabel = el('label', null, 'Winds ticked before lanes');
    fields.appendChild(oldLabel);
    const old = el('div', 'oldwinds');
    old.appendChild(el('b', null, [...chosen].join(', ')));
    old.appendChild(el('div', 'hint', lanes.length
      ? 'Not used \u2014 this stand has lanes, and they decide. Kept in case '
        + 'they hold something the geometry cannot see.'
      : 'Used for now, because there are no lanes yet. Trace one and it takes '
        + 'over.'));
    const drop = document.createElement('button');
    drop.type = 'button'; drop.textContent = 'Clear them';
    drop.onclick = () => {
      chosen.clear();
      oldLabel.remove();
      old.remove();
      // Nothing is written until Save, the same as every other field here.
      paintLanes();
    };
    old.appendChild(drop);
    fields.appendChild(old);
  }

  // The map reads its lanes from here for as long as this form is open, armed
  // for tracing or not, so the handles work on the array the Remove buttons and
  // the label boxes are already editing.
  laneForm = {
    standId: stand.id || null,
    stand: at,
    lanes,
    // Two callbacks, because the two things that change the lanes need
    // different work and one of them cannot do the other's.
    //
    // A drag moves numbers the rows already hold: they are written rather than
    // rebuilt, at pointer rate and with a box possibly under the caret. A
    // click while tracing adds a lane that has no row yet, and syncing would
    // leave it invisible in the form while the cone for it sat on the map.
    onNumbers: () => { syncRows(); paintWinds(); },
    onLanes: paintLanes,
  };
  paintLanes();

  const notes = document.createElement('textarea');
  notes.rows = 2; notes.value = stand.notes || '';
  fields.append(el('label', null, 'Notes'), notes);

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
        lanes,
        notes: notes.value || null,
      };
      if (isNew) await apiWrite('POST', '/api/stands', body);
      else await apiWrite('PATCH', '/api/stands/' + stand.id, body);
      closeStandForm();
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
  cancel.onclick = () => { closeStandForm(); draw(); };
  row.append(save, cancel);

  if (!isNew) {
    const del = document.createElement('button');
    del.className = 'danger'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete ' + stand.name + '?')) return;
      await apiWrite('DELETE', '/api/stands/' + stand.id);
      closeStandForm();
      await refreshStands();
    };
    row.appendChild(del);
  }
  form.appendChild(row);
  form.classList.add('aside');
  mapEl.appendChild(form);
  // Measured after it is in the document, because its height depends on how
  // many lanes it is listing and its width on the size of the screen.
  centreClearOfForm(form, stand);
  // Only a new stand needs the cursor put in the name box. On one you are
  // editing it scrolls the panel down to that field — past the lane list and
  // past Save — and on a phone it opens the keyboard over the map as well.
  if (isNew) name.focus();
  draw();
}
// ---- the ground in three dimensions --------------------------------------
// The same elevation grid the hillshade reads, built into a mesh with the
// satellite imagery draped over it. All the arithmetic — quantized metres,
// mesh, matrices, projection — is T3D, emitted from terrain3d.mjs and tested
// in Node; what lives here is only what needs a browser: a GL context, tile
// images, and fingers.
const view3dBtn = document.getElementById('view3dBtn');
const view3dEl = document.getElementById('view3d');
const gl3dCanvas = document.getElementById('gl3d');
const pins3dEl = document.getElementById('pins3d');
const hint3dEl = document.getElementById('hint3d');
const exaggInput = document.getElementById('exagg3d');
const exaggSay = document.getElementById('exaggSay');

let V3 = null;          // everything the live view holds; null when flat
let view3dLoading = false;

if (!D.live) {
  view3dBtn.disabled = true;
  view3dBtn.title = '3D needs the server';
  view3dBtn.style.opacity = '0.6';
  view3dBtn.style.cursor = 'not-allowed';
}

/**
 * The imagery to drape: the current base layer's tiles for the terrain's
 * ground, stitched onto one canvas. Tiles come in powers-of-two chunks that
 * never line up with the grid edge, so the canvas is bigger than the ground
 * and the UV mapping (below) is what cuts it to fit. Served pages fetch
 * through their own cache, so most of these are already on disk.
 *
 * A tile that fails stays the dark fill rather than aborting the view —
 * offline, the ground you have looked at renders and the ground you have not
 * is dark, which is the truth.
 */
function textureFor3d(bounds) {
  const L = LAYERS[layerKey];
  let z = L.maxZoom;
  const widthPx = zz => projX(bounds.east, zz) - projX(bounds.west, zz);
  while (z > 11 && widthPx(z) > 2048) z -= 1;
  const x0 = Math.floor(projX(bounds.west, z) / TS), x1 = Math.floor(projX(bounds.east, z) / TS);
  const y0 = Math.floor(projY(bounds.north, z) / TS), y1 = Math.floor(projY(bounds.south, z) / TS);
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0 + 1) * TS;
  canvas.height = (y1 - y0 + 1) * TS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#232920';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(new Promise(done => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, (x - x0) * TS, (y - y0) * TS); done(); };
        img.onerror = () => done();
        img.src = layerUrl(layerKey, z, x, y);
      }));
    }
  }
  return Promise.all(jobs).then(() => ({ canvas, z, originX: x0 * TS, originY: y0 * TS }));
}

const V3_VERT = 'attribute vec3 aPos; attribute vec2 aUV; attribute vec2 aSlope;'
  + 'uniform mat4 uMVP; uniform float uExagg;'
  + 'varying vec2 vUV; varying vec3 vNormal; varying float vDist;'
  + 'void main() {'
  + '  vec3 p = vec3(aPos.x, aPos.y * uExagg, aPos.z);'
  + '  gl_Position = uMVP * vec4(p, 1.0);'
  + '  vUV = aUV;'
  // The normal is rebuilt from the ground's true slope and the CURRENT
  // exaggeration, so lighting stays honest while the relief slider moves —
  // a stored normal is only right for one setting.
  + '  vNormal = normalize(vec3(-aSlope.x * uExagg, 1.0, -aSlope.y * uExagg));'
  + '  vDist = gl_Position.w;'
  + '}';
const V3_FRAG = 'precision mediump float;'
  + 'varying vec2 vUV; varying vec3 vNormal; varying float vDist;'
  + 'uniform sampler2D uTex; uniform vec3 uLight; uniform vec3 uSky; uniform float uFog;'
  + 'void main() {'
  + '  vec3 ground = texture2D(uTex, vUV).rgb;'
  + '  float diff = max(dot(normalize(vNormal), uLight), 0.0);'
  + '  vec3 lit = ground * (0.5 + 0.6 * diff);'
  + '  float f = clamp(vDist * uFog, 0.0, 0.8);'
  + '  gl_FragColor = vec4(mix(lit, uSky, f), 1.0);'
  + '}';

function glCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

/** Buffers, program and texture for one mesh. Rebuilt on every entry, because
 *  the ground under the view may have changed since last time. */
function initGL(mesh, texCanvas) {
  const gl = gl3dCanvas.getContext('webgl', { antialias: true })
    || gl3dCanvas.getContext('experimental-webgl');
  if (!gl) throw new Error('this browser has no WebGL');
  const prog = gl.createProgram();
  gl.attachShader(prog, glCompile(gl, gl.VERTEX_SHADER, V3_VERT));
  gl.attachShader(prog, glCompile(gl, gl.FRAGMENT_SHADER, V3_FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  const buf = (target, data) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };
  const attr = (name, buffer, size) => {
    const loc = gl.getAttribLocation(prog, name);
    // -1 means the compiler optimised the attribute away, which for THIS
    // shader always means a line went missing from it: every attribute here
    // is load-bearing. Shipping past it renders confidently wrong ground —
    // the texture sampled at one undefined texel painted the whole property
    // a uniform green, with no error anywhere — so it is a thrown error, not
    // a warning.
    if (loc < 0) throw new Error('shader lost attribute ' + name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  attr('aPos', buf(gl.ARRAY_BUFFER, mesh.positions), 3);
  attr('aUV', buf(gl.ARRAY_BUFFER, mesh.uvs), 2);
  attr('aSlope', buf(gl.ARRAY_BUFFER, mesh.slopes), 2);
  buf(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texCanvas);
  // The stitched canvas is not power-of-two sized, which WebGL 1 only accepts
  // clamped and unmipped.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.72, 0.80, 0.89, 1);   // haze at the horizon, not space

  const u = name => gl.getUniformLocation(prog, name);
  // Light from the north-west, matching the hillshade's azimuth 315 — the 2D
  // and 3D pictures of the same draw must shade the same side.
  const light = [-0.45, 0.77, -0.45];
  const ll = Math.hypot(...light);
  gl.uniform3f(u('uLight'), light[0] / ll, light[1] / ll, light[2] / ll);
  gl.uniform3f(u('uSky'), 0.72, 0.80, 0.89);
  return { gl, uMVP: u('uMVP'), uExagg: u('uExagg'), uFog: u('uFog'),
           count: mesh.indices.length,
           indexType: mesh.indices.BYTES_PER_ELEMENT === 4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
}

function size3dCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  gl3dCanvas.width = Math.round(W * dpr);
  gl3dCanvas.height = Math.round(H * dpr);
  if (V3) V3.res.gl.viewport(0, 0, gl3dCanvas.width, gl3dCanvas.height);
}

/** Every stand and camera on this ground, as DOM pins that ride the mesh. */
function build3dPins() {
  pins3dEl.textContent = '';
  const b = TERRAIN.bounds, g = TERRAIN.grid;
  const pins = [];
  const world = (lat, lng) => {
    const fc = (lng - b.west) / ((b.east - b.west) / (g.cols - 1));
    const fr = (lat - b.south) / ((b.north - b.south) / (g.rows - 1));
    const e = T3D.elevAtCell(V3.elev, g.cols, g.rows, fc, fr) - V3.mesh.meanElev;
    return [(fc - (g.cols - 1) / 2) * g.spacingM, e, ((g.rows - 1) / 2 - fr) * g.spacingM];
  };
  const inside = (lat, lng) =>
    lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
  for (const st of STANDS) {
    if (!inside(st.lat, st.lng)) continue;
    const rank = rankOf(st.id);
    const pin = el('div', 'stand' + (rank ? ' rank-' + rank : ''));
    pin.title = st.name;
    pin.onclick = ev => { ev.stopPropagation(); showStandReport(st); };
    const lab = el('div', 'slabel', st.name);
    pins3dEl.append(lab, pin);
    pins.push({ w: world(st.lat, st.lng), pin, lab });
  }
  for (const c of D.cameras) {
    if (typeof c.lat !== 'number' || !inside(c.lat, c.lng)) continue;
    const pin = el('div', 'pin ' + c.health.level);
    pin.title = c.name;
    pin.onclick = ev => { ev.stopPropagation(); showCameraPanel(c); };
    const lab = el('div', 'plabel', c.name);
    pins3dEl.append(lab, pin);
    pins.push({ w: world(c.lat, c.lng), pin, lab });
  }
  V3.pins = pins;
}

function render3d() {
  if (!V3) return;
  const { gl } = V3.res;
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const eye = T3D.orbitEye(V3.target, V3.yaw, V3.pitch, V3.dist);
  const mvp = T3D.mat4Multiply(
    T3D.mat4Perspective(55, W / H, 5, V3.spanM * 8),
    T3D.mat4LookAt(eye, V3.target));
  gl.uniformMatrix4fv(V3.res.uMVP, false, new Float32Array(mvp));
  gl.uniform1f(V3.res.uExagg, V3.exagg);
  // Fog starts mattering past a few spans of ground, so it scales with the
  // property rather than with a constant that suits one radius only.
  gl.uniform1f(V3.res.uFog, 0.9 / (V3.spanM * 5));
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.drawElements(gl.TRIANGLES, V3.res.count, V3.res.indexType, 0);

  for (const p of V3.pins) {
    const pt = T3D.projectPoint(mvp, p.w[0], p.w[1] * V3.exagg, p.w[2], W, H);
    p.pin.style.display = pt.visible ? '' : 'none';
    p.lab.style.display = pt.visible ? '' : 'none';
    if (!pt.visible) continue;
    p.pin.style.left = pt.x + 'px'; p.pin.style.top = pt.y + 'px';
    p.lab.style.left = pt.x + 'px'; p.lab.style.top = pt.y + 'px';
    const z = Math.max(1, Math.round((1 - pt.depth) * 500));
    p.pin.style.zIndex = z; p.lab.style.zIndex = z;
  }
  V3.raf = requestAnimationFrame(render3d);
}

function exitView3d() {
  if (!V3) return;
  cancelAnimationFrame(V3.raf);
  view3dEl.hidden = true;
  view3dBtn.classList.remove('on');
  pins3dEl.textContent = '';
  V3 = null;
}

async function enterView3d() {
  if (V3 || view3dLoading || !D.live) return;
  view3dLoading = true;
  view3dBtn.textContent = 'Building 3D…';
  try {
    // The same fetch, cache and coverage rules the flat terrain uses; a view
    // with no LiDAR under it says so through the terrain note rather than
    // rendering a guess.
    if (!TERRAIN || !TERRAIN.covered || !TERRAIN.elev || !terrainCoversView()) {
      await loadTerrain();
    }
    if (!TERRAIN || !TERRAIN.covered || !TERRAIN.elev) return;
    const b = TERRAIN.bounds, g = TERRAIN.grid;
    const elev = T3D.dequantizeElev(
      T3D.bytesToU16(unb64(TERRAIN.elev.b64)), TERRAIN.elev.min, TERRAIN.elev.scale);
    const tex = await textureFor3d(b);
    const uv = (c, r) => {
      const lng = b.west + c * (b.east - b.west) / (g.cols - 1);
      const lat = b.south + r * (b.north - b.south) / (g.rows - 1);
      return [(projX(lng, tex.z) - tex.originX) / tex.canvas.width,
              (projY(lat, tex.z) - tex.originY) / tex.canvas.height];
    };
    const mesh = T3D.buildTerrainMesh({
      cols: g.cols, rows: g.rows, dxM: g.spacingM, dyM: g.spacingM, elev, uv,
    });
    if (!mesh) return;
    size3dCanvas();
    const res = initGL(mesh, tex.canvas);
    const spanM = Math.max(g.cols, g.rows) * g.spacingM;
    V3 = {
      res, mesh, elev, spanM,
      target: [0, 0, 0],
      yaw: 0, pitch: 55, dist: spanM * 1.05,
      exagg: Number(exaggInput.value) || 1.5,
      pins: [], raf: 0,
    };
    size3dCanvas();
    build3dPins();
    view3dEl.hidden = false;
    view3dBtn.classList.add('on');
    say3dHint();
    render3d();
  } catch (err) {
    terrainNote('3D failed: ' + err.message);
    exitView3d();
  } finally {
    view3dLoading = false;
    view3dBtn.textContent = '3D view';
  }
}

/** The HUD line: how to drive it, and how honest the relief is. */
function say3dHint() {
  if (!hint3dEl) return;
  const st = TERRAIN && TERRAIN.stats;
  hint3dEl.textContent = 'Drag to orbit · scroll to zoom · shift-drag to slide.'
    + (st ? ' ' + st.reliefFt + ' ft of relief on this ground.' : '')
    + (V3 && V3.exagg > 1
      ? ' Hills stretched ' + V3.exagg + '× — slide to 1× for true scale.'
      : ' True vertical scale.');
}

view3dBtn.onclick = ev => {
  ev.stopPropagation();
  if (V3) exitView3d();
  else enterView3d();
};
document.getElementById('exit3d').onclick = () => exitView3d();
exaggInput.oninput = () => {
  if (V3) V3.exagg = Number(exaggInput.value) || 1;
  exaggSay.textContent = exaggInput.value + '×';
  say3dHint();
};

// One finger orbits; a second zooms and slides. Pointer events carry both.
const p3 = new Map();     // pointerId -> {x, y}
let pinch0 = null;        // {dist, cx, cy} at the moment the second finger lands
gl3dCanvas.addEventListener('pointerdown', e => {
  if (!V3) return;
  e.preventDefault();
  gl3dCanvas.setPointerCapture(e.pointerId);
  p3.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (p3.size === 2) {
    const [a, bb] = [...p3.values()];
    pinch0 = { dist: Math.hypot(a.x - bb.x, a.y - bb.y), d0: V3.dist };
  }
  view3dEl.classList.add('drag');
});
gl3dCanvas.addEventListener('pointermove', e => {
  if (!V3 || !p3.has(e.pointerId)) return;
  const prev = p3.get(e.pointerId);
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  p3.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (p3.size === 2 && pinch0) {
    const [a, bb] = [...p3.values()];
    const d = Math.hypot(a.x - bb.x, a.y - bb.y);
    if (d > 1) V3.dist = Math.max(60, Math.min(V3.spanM * 4, pinch0.d0 * pinch0.dist / d));
    return;
  }
  if (e.shiftKey || e.buttons === 2) {
    // Slide the target across the ground, in the direction the screen moves.
    const k = V3.dist * 0.0016;
    const basis = T3D.orbitBasis(V3.yaw);
    V3.target[0] += (-dx * basis.rightX + dy * basis.fwdX) * k;
    V3.target[2] += (-dx * basis.rightZ + dy * basis.fwdZ) * k;
  } else {
    V3.yaw = (V3.yaw + dx * 0.35 + 360) % 360;
    V3.pitch = Math.max(12, Math.min(85, V3.pitch + dy * 0.25));
  }
});
for (const ev of ['pointerup', 'pointercancel']) {
  gl3dCanvas.addEventListener(ev, e => {
    p3.delete(e.pointerId);
    if (p3.size < 2) pinch0 = null;
    if (!p3.size) view3dEl.classList.remove('drag');
  });
}
gl3dCanvas.addEventListener('wheel', e => {
  if (!V3) return;
  e.preventDefault();
  V3.dist = Math.max(60, Math.min(V3.spanM * 4, V3.dist * (e.deltaY > 0 ? 1.15 : 0.87)));
}, { passive: false });
gl3dCanvas.addEventListener('contextmenu', e => e.preventDefault());
addEventListener('resize', () => { if (V3) size3dCanvas(); });

// ---- the tool tree ------------------------------------------------------
// Groups fold, and the whole tree folds from its root — which is what makes
// this usable on a phone, where the open tree is a third of the screen. No
// state is kept: the tree opens fresh each visit, expanded, because a tool
// you cannot see is a tool you forget the map has.
document.getElementById('ttRoot').onclick = ev => {
  ev.stopPropagation();
  document.getElementById('tooltree').classList.toggle('closed');
};
for (const head of document.querySelectorAll('.tt-head')) {
  head.onclick = ev => {
    ev.stopPropagation();
    head.parentElement.classList.toggle('closed');
  };
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
  if (laneEdit) {
    const rl = mapEl.getBoundingClientRect();
    const lx = e.clientX - rl.left, ly = e.clientY - rl.top;
    if (lx < 0 || ly < 0 || lx > rl.width || ly > rl.height) return;
    const at = pixelToLatLng(lx, ly);
    laneEdit.lanes.push({ to: [at.lng, at.lat], label: null });
    // A new lane, so the list is rebuilt rather than written over: it has no
    // row yet, and there is nothing to write into.
    laneEdit.onLanes();
    draw();
    return;
  }
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

/**
 * Dragging a lane handle.
 *
 * Listened for on the contours SVG rather than on the handles themselves,
 * because that SVG is rebuilt wholesale on every draw — including the draw
 * this drag causes. A listener on the circle would be destroyed by the first
 * move, and on touch, where the browser captures the pointer to the original
 * target implicitly, the rest of the gesture would then go to a detached node
 * and simply stop arriving. Capturing to the SVG, which survives, is what
 * makes this work with a finger at all.
 *
 * The SVG carries pointer-events:none so it cannot swallow presses meant for
 * the ground; the handles switch it back on for themselves. Events still
 * bubble up through it either way, which is what this relies on.
 */
contoursEl.addEventListener('pointerdown', e => {
  if (!laneForm) return;
  const g = e.target.closest && e.target.closest('.lanegrip');
  if (!g) return;
  e.preventDefault();
  gripDrag = { i: Number(g.dataset.lane), kind: g.dataset.grip };
  // Capture is what makes touch work; a browser that refuses it still leaves a
  // usable mouse drag through ordinary bubbling, so this must not abort the
  // handler and leave the grip half-armed.
  try { contoursEl.setPointerCapture(e.pointerId); } catch (err) { /* mouse still fine */ }
  mapEl.classList.add('gripping');
});

contoursEl.addEventListener('pointermove', e => {
  if (!gripDrag || !laneForm) return;
  const lane = laneForm.lanes[gripDrag.i];
  if (!lane || !Array.isArray(lane.to)) return;
  const r = mapEl.getBoundingClientRect();
  const at = pixelToLatLng(e.clientX - r.left, e.clientY - r.top);

  if (gripDrag.kind === 'tip') {
    // Dragged onto the stand there is no lane left: no length, no bearing, and
    // a cone that collapses to nothing. Hold the last good position instead of
    // storing a degenerate one — the alternative is a lane that silently stops
    // counting toward the winds.
    //
    // Two floors, guarding different things. The metre one is the same floor
    // the reach box enforces, so a lane cannot be dragged to a size that could
    // not be typed. The pixel one is about getting it back: the handles scale
    // with the lane, so a cone pulled to nothing at a wide zoom would be too
    // small to grab again and could only be removed.
    const ax = projX(laneForm.stand.lng, zoom), ay = projY(laneForm.stand.lat, zoom);
    const px = projX(at.lng, zoom), py = projY(at.lat, zoom);
    const m = MEASURE.distanceM(laneForm.stand.lat, laneForm.stand.lng, at.lat, at.lng);
    if (m < COVER.MIN_LANE_REACH_M || Math.hypot(px - ax, py - ay) < 8) return;
    lane.to = [at.lng, at.lat];
  } else {
    // A width handle moves the EDGE, so what it means is the angle between the
    // lane's centre line and where the finger is — never the distance, which
    // is why the handle springs back to the rim rather than following out.
    const held = COVER.bearing(laneForm.stand.lat, laneForm.stand.lng, at.lat, at.lng);
    const centre = COVER.bearing(laneForm.stand.lat, laneForm.stand.lng, lane.to[1], lane.to[0]);
    const off = COVER.angleBetween(held, centre);
    const clamped = Math.min(COVER.MAX_LANE_SPREAD_DEG,
      Math.max(COVER.MIN_LANE_SPREAD_DEG, off));
    lane.spread = Math.round(clamped * 10) / 10;
  }
  laneForm.onNumbers();
  draw();
});

for (const ev of ['pointerup', 'pointercancel']) {
  contoursEl.addEventListener(ev, e => {
    if (!gripDrag) return;
    gripDrag = null;
    mapEl.classList.remove('gripping');
    try { contoursEl.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    draw();
  });
}

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
// ---- the ground switcher -------------------------------------------------
// Two hunting properties means a map framed on both opens at a zoom where
// each parcel is a speck, and "go look at the other place" is a minute of
// panning. The dropdown in the top bar jumps between them.
//
// Grounds are DISCOVERED, not configured: everything with coordinates,
// clustered by walking distance (GROUNDS.groundsFrom, 2 km single-linkage).
// Nothing gets filed anywhere for the dropdown to work, and a stand dropped
// on the far parcel next week lands in the right ground because geography
// says so. Naming one is the single deliberate act — it creates the property
// row and assigns the members, and the label afterwards comes from the
// members' own property names, majority-wins.
const groundSel = document.getElementById('groundSel');
let GROUND_LIST = [];
let groundChoice = 'all';
try { groundChoice = localStorage.getItem('trailcam.ground') || 'all'; } catch { /* ignore */ }
const saveGroundChoice = k => { try { localStorage.setItem('trailcam.ground', k); } catch { /* ignore */ } };
// An unnamed ground has no stable identity across sessions, so the remembered
// key falls back to a rounded centre: enough to survive a reload, and a
// mismatch just opens the map framed on everything, never on the wrong place.
const groundKey = g => g.name || ('at:' + g.centre.lat.toFixed(2) + ',' + g.centre.lng.toFixed(2));
const groundPoints = () => [
  ...located.map(c => ({ id: c.id, kind: 'camera', lat: c.lat, lng: c.lng, property: c.property || null })),
  ...STANDS.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map(s => ({ id: s.id, kind: 'stand', lat: s.lat, lng: s.lng, property: s.property_name || null })),
  ...MARKERS.filter(m => Number.isFinite(m.lat) && Number.isFinite(m.lng))
    .map(m => ({ id: m.id, kind: 'marker', lat: m.lat, lng: m.lng, property: m.property_name || null })),
];

function rebuildGrounds() {
  if (!groundSel) return;
  GROUND_LIST = GROUNDS.groundsFrom(groundPoints());
  // One ground is not a choice. The control appears when the land splits in
  // two — dropping the first pin on the far property is what summons it.
  if (GROUND_LIST.length < 2) { groundSel.hidden = true; return; }
  groundSel.hidden = false;
  groundSel.textContent = '';
  const opt = (value, label) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    groundSel.appendChild(o);
  };
  opt('all', 'Everything');
  GROUND_LIST.forEach((g, i) =>
    opt('g' + i, g.name || ('Ground ' + (i + 1) + ' — ' + GROUNDS.describeGround(g))));
  const current = GROUND_LIST.findIndex(g => groundKey(g) === groundChoice);
  // Naming is offered for the ground on screen, once it has no name yet — and
  // only where saving is possible at all (the static file cannot).
  if (D.live && current >= 0 && !GROUND_LIST[current].name) opt('name', '✎ Name this ground…');
  groundSel.value = current >= 0 ? 'g' + current : 'all';
}

function frameGround(g) {
  const b = g.bounds;
  ({ centre, zoom } = frameFor([[b.west, b.south], [b.east, b.north]]));
  draw();
}

/**
 * Naming happens in the bar, not in a prompt() — same reasoning as naming a
 * buck on the review screen: prompt blocks the page, cannot be styled, and
 * dies to a stray Escape.
 */
function nameGround(g) {
  if (!groundSel || document.getElementById('groundName')) return;
  const input = document.createElement('input');
  input.id = 'groundName';
  input.placeholder = 'Name this ground';
  input.maxLength = 60;
  groundSel.hidden = true;
  groundSel.after(input);
  input.focus();
  const done = () => { input.remove(); groundSel.hidden = false; rebuildGrounds(); };
  input.onblur = () => { if (document.getElementById('groundName')) done(); };
  input.onkeydown = async e => {
    e.stopPropagation();
    if (e.key === 'Escape') return done();
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name) return done();
    try {
      const res = await fetch('/api/properties', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name,
          cameraIds: g.ids.camera, standIds: g.ids.stand, markerIds: g.ids.marker }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error) || ('save failed: ' + res.status));
      // The page's own copies learn the name, so the label is right without a
      // reload and the next rebuild votes it straight back in.
      for (const c of located) if (g.ids.camera.includes(c.id)) c.property = name;
      for (const s of STANDS) if (g.ids.stand.includes(s.id)) s.property_name = name;
      for (const m of MARKERS) if (g.ids.marker.includes(m.id)) m.property_name = name;
      groundChoice = name;
      saveGroundChoice(name);
      done();
    } catch (err) {
      input.value = '';
      input.placeholder = err.message;
    }
  };
}

if (groundSel) {
  // On a phone the switcher floats bottom-centre (the bar has no room — see
  // the dashboard's stylesheet). That styling is position: fixed, and the top
  // bar's backdrop-filter makes the BAR the containing block for fixed
  // descendants — the chip pinned itself to the bar and vanished off its top
  // edge (measured). So at phone width the select moves to body, where fixed
  // means the screen; back into the bar when the screen widens again.
  const groundHome = groundSel.parentElement;
  const phoneQ = matchMedia('(max-width: 560px)');
  const placeGround = () => {
    if (phoneQ.matches) document.body.appendChild(groundSel);
    else groundHome.insertBefore(groundSel, groundHome.firstChild);
  };
  phoneQ.addEventListener('change', placeGround);
  placeGround();
  // Rebuilt as the list opens, so a stand dropped five minutes ago is already
  // in the right ground without every save path having to remember this.
  groundSel.addEventListener('pointerdown', rebuildGrounds);
  groundSel.onchange = () => {
    const v = groundSel.value;
    if (v === 'name') {
      const g = GROUND_LIST.find(x => groundKey(x) === groundChoice);
      rebuildGrounds();
      if (g) nameGround(g);
      return;
    }
    if (v === 'all') {
      groundChoice = 'all';
      saveGroundChoice('all');
      const pts = groundPoints().map(p => [p.lng, p.lat]);
      if (pts.length) { ({ centre, zoom } = frameFor(pts)); draw(); }
      return;
    }
    const g = GROUND_LIST[Number(v.slice(1))];
    if (!g) return;
    groundChoice = groundKey(g);
    saveGroundChoice(groundChoice);
    frameGround(g);
  };
  rebuildGrounds();
  // Reopen where you were: the remembered ground frames the FIRST draw below,
  // so there is no flash of the wrong place.
  const saved = GROUND_LIST.find(g => groundKey(g) === groundChoice);
  if (saved) {
    const b = saved.bounds;
    ({ centre, zoom } = frameFor([[b.west, b.south], [b.east, b.north]]));
  } else if (groundChoice !== 'all') {
    groundChoice = 'all';
  }
}
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
