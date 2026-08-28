# State of play — 2026-08-28

Written so a fresh session (or a future you) can pick this up cold. What works,
what does not, what is next, and what is still unverified.

Design decisions and their reasoning are in [`design.md`](design.md). This file
is *status*; that one is *why*.

---

## Working, verified

| | Verified how |
| --- | --- |
| **SpyPoint sync** — cameras, status, photos | Live, against a real 4-camera FLEX-M account |
| **SQLite store** — cameras, photos, detections, bucks, properties, stands, weather, sits | 393 tests; sync verified end-to-end against a stand-in API |
| **Local server** — dashboard served from the database, LAN-reachable | Tests including raw-socket path-traversal checks |
| **Map** — satellite / hybrid / street / terrain, pan, zoom, offline-tolerant | Driven in a real browser |
| **Stands** — drop, name, type, move, delete, good-winds | Browser-verified end to end with a real mouse: arm, click, type, save, reopen |
| **Parcel ownership** — click for owner, acres, class, county, mailing address | Live against the Wisconsin service at a real camera; button-to-card path re-verified with a real mouse |
| **Hunt planner** — ranks sits by rut, fronts, pressure, wind, rain, moon | Unit-tested; live forecast fetch verified |
| **LiDAR terrain** — hillshade + adaptive contours from free USGS 3DEP | Live at 1 m resolution at the Green Lake camera |
| **Terrain features** — draws, ridges, saddles, benches | Cross-checked geometrically: 87% of drainage points sit below their flanks, 88% of ridge points above |
| **Stand ranking** — which stand for a given sit, wind + thermals | Unit-tested; thermal direction checked against physics in both windows |
| **Parcel boundaries drawn**, DNR VPA / CWD / deer-zone overlays | Live against both services, browser-verified |
| **Scouting markers** — rubs, scrapes, beds, trails, plots, water, access | Browser-verified end to end with a real mouse |
| **Offline map cache** — tiles kept on disk, bounded "save this view" | Browser-verified: the page contacts no external host directly |
| **Review screen** (`/review`) — visits, tagging, bucks, keyboard-driven | Driven end to end in a browser against generated stand-in frames |
| **Wind history** — which winds blow during season, and what each stand is worth | Live: 9,751 huntable hours across 7 seasons at the property |
| **Walk-in routes** — draw the approach, judged against the wind like a stand | Browser-verified end to end; geometry checked against hand-reasoned cases |
| **Collar ingest** (`calibrate-planner.mjs`) — reads a published GPS dataset | Verified against a fixture with a planted effect; **awaiting the real file** |
| **Tonight** (`/tonight`) — one screen: the stand, the walk in, when to leave | Driven in a browser in both themes, and end to end over the API |
| **Legal shooting light** — Wisconsin's 30-before / 20-after, with a countdown | Unit-tested, and run under three machine timezones to prove the times do not move |
| **Measure tool** — click-to-measure distance and acreage on the map | Browser-driven; acreage checked against a survey section (640) and a quarter-quarter (40) |
| **Stand suggester** — where to hang the next one, and which side of it | Live against USGS terrain at the property; wind geometry cross-checked against `routes.mjs` on every candidate × all 16 winds |
| **Sit journal** (`/journal`) — what actually happened, and what it may claim | 29 tests, most of them about refusing to answer; the whole loop driven in a browser |
| **Ownership-aware suggestions** — spots on the neighbour's dropped, crossings named | Tested against stub owners; `?parcels=off` for outside Wisconsin |
| **Offline** — /tonight, the map and sit logging with no server reachable | Driven end to end: server killed, page served by the worker, sit queued, server restarted, sit arrived |

Run it: `start-trailcam.cmd`. It syncs, plans, then serves on
`http://127.0.0.1:8787` and prints a LAN address for a phone on the same Wi-Fi.

## Not working / not built

- **No photos exist yet.** The account's cameras have been silent since
  November 2025. Photo download and paging are written and unit-tested but have
  **never run against a real photo**. Everything downstream — tagging, buck
  identity, movement analysis — is therefore unexercised.
- **Moultrie is not implemented** and refuses with an explanation. Blocked on
  one session capture: [`moultrie-capture.md`](moultrie-capture.md).
- **Phone app** — deliberately last, gated on the rest proving out. The server's
  JSON API is the boundary it would speak to.
- **Steps 4 and 5** of the build plan: the tagging screen, then analysis.

## Public GPS collar data — answered 2026-08-28

The open question from the first week: Spartan Forge trains movement prediction
on university collar data, and it was unknown whether comparable open data
exists. **It does.**

Nine white-tailed deer GPS datasets on [Dryad](https://datadryad.org), all
**CC0** (public domain). The directly relevant ones:

| Dataset | Why it matters |
| --- | --- |
| *Spatiotemporal patterns of male and female white-tailed deer on a hunted landscape* (2022) | Carries a 23 MB `RateofMovementData.csv`. Sexes separated, and on **hunted** ground |
| *Does temporary baiting affect deer space use and movement?* (Jan 2026) | Recent, and movement sampled at camera-survey intervals |
| *Reproductive effort of males in scramble competition polygyny* | Buck movement through the rut |

Movebank is reachable but its study API needs an account; Dryad's catalogue API
answers freely, though **file downloads sit behind a bot challenge** — they
download fine from a browser, not from a script here.

**What this can and cannot be used for**, because the distinction decides
whether it is worth the effort:

- It **cannot** say where your deer are. These are other deer, in Alabama,
  Georgia, Canada and Florida, in other years, on other ground. Buying or
  downloading the files does not change that, and the movement-prediction row
  in the comparison table below stays a "no".
- It **can** replace the planner's hand-picked weights with measured effect
  sizes. `hunt-planner.mjs` scores sits using numbers chosen by judgement — rut
  phase 2–24, cold front, pressure trend, wind, rain, moon "deliberately
  small". A movement-rate dataset measures how much movement actually rises
  with a temperature drop, and how little the moon actually matters.
- Caveat that limits it: southern deer rut at different dates and in different
  heat than Wisconsin deer. The **shape** of a weather relationship transfers;
  the **timing** of the rut calendar does not, and must stay as it is.

That is calibrating WHEN, not predicting WHERE.

## What the paid apps do that this does not

Measured 2026-08-27, so the comparison is grounded rather than remembered.

| Feature | onX / Spartan Forge | Here |
| --- | --- | --- |
| Land ownership | onX: 161.5M parcels nationwide | **Yes, Wisconsin only, free — boundaries drawn** |
| Trail-camera integration | onX: Elite tier only | **Native** |
| LiDAR terrain | Both, prominently | **Yes — free USGS 3DEP, 1 m at the camera** |
| Terrain feature ID (saddles, benches, funnels) | Spartan Forge | **Yes, with absolute thresholds — it reports "none here" on flat ground** |
| Thermals | Spartan Forge charges for it | **Yes where there is slope; says so plainly where there is not** |
| Scouting waypoints | Both, core | **Yes, and dated — sign ages and fades** |
| Public land / CWD / deer zones | onX layer set | **Yes, from WI DNR** |
| Offline maps | onX paid tier | **Yes — viewed tiles always, bounded pre-fetch** |
| Which stands are worth having | Neither, directly | **Yes — season-long wind frequency per stand, and the gaps** |
| Historical imagery | Spartan Forge: 10 years UAV | No (NAIP endpoint timed out; unverified) |
| Movement prediction | Spartan Forge: neural net on university collar data | **No, and cannot match it** — the planner is weather + rut + your own cameras, and says so |
| Pin sharing with partners | Spartan Forge | No |
| Measure distance and area | Both, standard | **Yes — and it works with no server and no signal** |
| Legal shooting hours | onX has a solunar/hours panel | **Yes, with the DNR named as the authority rather than the app** |
| "Where do I sit tonight" in one screen | Neither does this in one place | **Yes — `/tonight`: stand, walk in, and when to leave** |
| Where to hang the NEXT stand | Neither, directly | **Yes — terrain plus the winds no stand of yours covers, with the reasoning shown** |
| A record of what you actually saw | onX has waypoints, not sits | **Yes — and it is used to check this tool's own predictions, including refusing to** |

The honest line on prediction: without collar data, anything fancier here would
be the same inputs in a better costume.

## The ground itself

Worth knowing before reading anything terrain-related: **this property is very
flat.** Measured, not guessed — a 600 m box at the Green Lake camera holds
12.5 ft of relief, with a median slope of 0.5 degrees and a maximum of 2.2.

Consequences, all of them deliberate in the code:

- Contour intervals and hillshade exaggeration are chosen from the relief
  present. A fixed 10 ft interval draws ONE line here; the auto-chosen interval
  is 2 ft, and the hillshade is stretched ~23x vertically (and says so).
- **Thermals do not meaningfully exist here.** Below 2 degrees the ranking
  reports "too flat for a thermal" and contributes nothing either way. This is
  the honest answer, not a gap — a confident arrow on a flat field is worse
  than silence, because it might be believed.
- Saddles and benches correctly find nothing at the camera. Drainages are the
  payoff on ground like this: flow accumulation is scale-free, and there are 14
  of them, the longest a 390 m draw with 7 ft of fall.

## Next, in order

1. **Log sits.** The journal is built and empty. Everything it can eventually
   say needs about a dozen sits with a spread of ratings — including some
   mediocre evenings, or there is no comparison group and it will keep
   refusing (correctly).
2. **Run the collar calibration** once `collar-data/RateofMovementData.csv` is
   downloaded — `node calibrate-planner.mjs --inspect` first, to confirm the
   detected columns before trusting any number it prints.
3. **Photos land** → verify the download path against real images, then fit the
   review screen to their actual shape. It is built and driven, but against
   generated frames, so expect adjustment around real timestamps and any
   species tags SpyPoint's own AI attaches.
4. **Analysis** (step 5) — WHEN/WHERE side by side with raw counts.
5. Moultrie, if a capture arrives.
6. Historical imagery, if a working NAIP endpoint can be found.

## The structural debt worth naming

**Both splits are done** (2026-08-28). `spypoint-sync.mjs` was 2,408 lines, of
which about 1,950 were the dashboard inside one template literal; the dashboard
was then 2,100 lines of which about 1,300 were the map. The files now are:

| File | Lines | Holds |
| --- | --- | --- |
| `spypoint-sync.mjs` | ~420 | the sync, and the files it writes |
| `dashboard-page.mjs` | ~600 | alerts, wind rose, review queue, sit ranking, cards, photos |
| `map-view.mjs` | ~1,600 | the map: layers, pins, markers, routes, measure, terrain, parcels |
| `tonight-page.mjs`, `journal-page.mjs`, `review-page.mjs` | ~500 each | one screen each |

The template-literal hazard that motivated it is still real for every page:
escapes inside such a literal resolve when the PAGE IS BUILT rather than when
the browser reads it, so a one-backslash newline becomes a real line break and
a stray backtick closes the literal — each of which makes the whole page a
syntax error while `node --check` on the module still passes. It happened three
times. Three things hold it down now, in increasing order of strength:

- `test/page-scripts.test.js` compiles the generated script of **every** page,
  so a new page added without a line there is the only way to ship a broken one.
- `map-view.mjs` and `tonight-page.mjs` keep their browser halves in
  `String.raw` literals, where escapes stay literal.
- Anything interpolated as a **value** (`${...}`) is inserted at runtime and
  never parsed as part of the surrounding literal, so its backticks and escapes
  arrive intact. That is how `measure.mjs` gets into the map.

Two traps found while doing it, both worth remembering:

- **Splitting CSS mechanically is harder than it looks.** Rules keep the
  comment written above them, so taking a rule's "root token" from its raw text
  read it out of the prose — "the measuring readout. Sits under the tip" gave a
  root of `.Sits`, and ten base rules were separated from the descendant rules
  styling the same element. Strip comments first. Four class names (`map`,
  `mark`, `stand`, `winds`) are plain English words the dashboard also uses and
  no text matching separates them; they are an explicit list in the split
  script's comment.
- **Verify a refactor by rebuilding the artefact and diffing it.** The page was
  composed before and after and compared line for line (once `\uXXXX` escapes
  are resolved). That caught more than the test suite would have.

Two smaller notes:

- **Map modes share one disarm.** Each toolbar button used to carry its own
  list of modes to turn off and the lists had rotted — "+ Add stand" turned
  nothing off at all. `clearMapModes()` is the single place that knows them, in
  the same spirit as the `onMapGround` whitelist, and `test/stands.test.js`
  pins it.
- **The map's empty state is fixed.** It used to replace itself with "No camera
  reported GPS coordinates", hiding every stand, marker, route and the measure
  tool — including the button to drop the stand that would have fixed it. It
  now frames on everything with coordinates and always draws.

## Things that will bite you

- Run node with `--disable-warning=ExperimentalWarning`; `node:sqlite` prints an
  experimental notice that makes a working tool look broken. The launcher does.
- The dashboard **file** (`spypoint-data/dashboard.html`) cannot save anything.
  Stands and ownership need the served page at `127.0.0.1:8787`. The file says
  so on its buttons rather than failing silently.
- Requesting a field the parcel layer lacks rejects the *whole* query with
  "Invalid query parameters". The published schema says `CNTYNAME`; the live
  layer has `CONAME`.
- `Number(null)` is `0`, and 0,0 is a real place in the Atlantic. Missing values
  must be rejected BEFORE conversion, not after. This has now bitten three
  separate times — the parcel lookup, route points, and a blank movement rate in
  the collar loader, where `Number('')` became "this deer did not move" and
  dragged every median down. One of the three sat directly under a comment
  warning about exactly this: writing the trap down is not the same as obeying
  it.
- Never edit a shipped migration — add another.
- **The dashboard is theme-aware** — light by default, dark under
  `prefers-color-scheme`. A colour hardcoded in chart code is therefore wrong in
  one of the two modes. The wind rose's ramp lives in the theme's custom
  properties (`--rose-1..5`) with separately validated steps per mode; the first
  version was validated against a dark surface the page does not use and came
  out at 1.36:1 against the real white panel, well under the floor. Run
  `dataviz/scripts/validate_palette.js` rather than judging it by eye.
- **The page script is emitted from a template literal, and that is a trap.**
  An escape written with one backslash resolves when the PAGE IS BUILT, not
  when the browser reads it: a single-escaped newline becomes a real line break
  inside a quoted string and makes the whole dashboard a syntax error. A
  backtick anywhere in that region — including inside a comment — closes the
  template early. `node --check` on the module passes throughout, because the
  module is fine; it is the page it produces that is broken. `test/dashboard-script.test.js`
  compiles the generated script with node:vm and is the only thing that catches it.
- **Terrain grid row 0 is the SOUTH edge**, with r increasing northward. Getting
  this backwards mirrors every aspect by 180 degrees, which points every thermal
  exactly the wrong way and looks entirely plausible.
- **Hillshade is a dot product, not the textbook trig identity.** The identity is
  easy to transcribe with the aspect convention inverted, which lights terrain
  from the south-east and makes every ridge read as a valley. It shipped that way
  once.
- **Parcel queries must pin `outSR=4326`.** Without it the geometry arrives in
  the layer's own projection, whose numbers are metres; drawn as degrees, the
  boundary lands off the coast of Africa.
- **Esri and USGS tiles are /z/y/x, not /z/x/y.** Swapping them gives a
  valid-looking URL for the wrong ground.
- **Do not bulk-download OpenStreetMap tiles.** Their policy forbids it and their
  tiles are donated. `bulkAllowed: false` in tile-sources.mjs enforces this;
  leave it alone.
- **Everything interactive on the map is a child of `#map`** — toolbar, stand
  form, parcel card, pins. So the drag handler and the click handler both have
  to tell a press on a control from a press on the ground, and they must use
  the *same* test. They once did not: the drag handler's list was a stale
  subset, so pressing any newer control started a drag and called
  `setPointerCapture`, which retargets the following click to `#map` — the
  button never saw its own click. Both toolbar buttons, the form's inputs and
  reopening a pin were all dead at once. `onMapGround()` is now the single
  shared predicate, and it whitelists the background rather than blacklisting
  the overlays, so a control added later is safe without anyone remembering.
- **A scripted `.click()` does not prove a button works.** The bug above was
  invisible to `element.click()` — which dispatches straight at the element —
  and only appeared under a real mouse press, because pointer capture is what
  broke it. Verify map controls by driving the mouse.
