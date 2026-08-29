# State of play — 2026-08-29

Written so a fresh session (or a future you) can pick this up cold. What works,
what does not, what is next, and what is still unverified.

Design decisions and their reasoning are in [`design.md`](design.md). This file
is *status*; that one is *why*.

---

## This repo is PUBLIC — no real coordinates

`KS-Three/TrailCam` is public, deliberately (private repos would cost Actions
credits). A trail-camera fix is the location of somebody's hunting property, so
**test fixtures and defaults must not use Kent's real coordinates.**

They did until 2026-08-28. The exact fix from his SpyPoint account was in seven
committed files here — `check-terrain.mjs`'s default and six test files — and
in the sibling `KS-Three/EMB-Bot` repo's `spypoint/` proof of concept, in a
code comment and its README. Found by a code review. Every occurrence was
shifted by a constant offset onto invented ground (roughly 44.12 N, 90.65 W,
rural Jackson County), which keeps all the relative geometry inside each test
identical while pointing nowhere in particular.

**Kent's decision, 2026-08-28: scrub going forward, leave history alone.** The
commits that carried it are still in both repos' history and on any clone or
fork already taken — rewriting published history would not recall those, and it
would mean force-pushing `main`. Code search and casual reading no longer turn
it up, which is the part that was worth fixing.

Rules for anything added from here:

- Fixtures use the 44.12 / -90.65 cluster, or another invented point.
- Owner names and mailing addresses in fixtures stay obviously fake
  (`SOME FAMILY TRUST`, `1 EXAMPLE RD, ANYTOWN, WI 50000`) — they already are.
- Real coordinates belong in the database on Kent's machine, which is
  gitignored, and nowhere else.

## Working, verified

| | Verified how |
| --- | --- |
| **SpyPoint sync** — cameras, status, photos | Live, against a real 4-camera FLEX-M account |
| **SQLite store** — cameras, photos, detections, bucks, properties, stands, weather, sits, tracks | 501 tests; sync verified end-to-end against a stand-in API |
| **Local server** — dashboard served from the database, LAN-reachable | Tests including raw-socket path-traversal checks |
| **Map** — satellite / hybrid / street / terrain, pan, zoom, offline-tolerant | Driven in a real browser |
| **Stands** — drop, name, type, move, delete, good-winds, shooting lanes | Browser-verified end to end with a real mouse: arm, click, type, save, reopen |
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
| **Track recording** — record the walk in off the phone's GPS, judged against the route you drew | Driven in a browser with real geolocation and with a scripted 3-minute walk: 180 fixes, teleport and bad fix both rejected, 275 m, compared to the route on save |
| **Shooting lanes** — mark where you can shoot; the winds are derived from the shape, not ticked | Cross-checked against `routes.mjs`, which computes scent independently, on every lane bearing × all 16 winds; the browser copy compiled in a vm and compared to Node's on the same lanes |
| **Lane handles** — drag the tip for reach, either side handle for width | Driven in a browser with a real mouse: 20° → 91° wide, then 52 m → 82 m with the width unchanged, saved, reopened from the server |
| **Lane sizes typed, in yards** — how far out and how wide across the end, rather than dragged at | Driven in a browser against the real server: 85 yd out and 62 yd across typed into the form, stored as a 20° half-angle, reloaded and reopened unchanged; the widened lane cost two winds |
| **Build stamp** — the server says which commit it is running, and whether the files have moved on since | Verified live: banner names the branch and sha, `/api/health` flipped to `stale: true` naming the touched file |
| **Full-screen map** — the dashboard IS the map; the old page slides in as the Camp report drawer | Driven in a browser, light and dark, desktop and phone width |
| **Tool tree** — Stands / Scouting / Ground branches with guide lines, collapsible from any node | Driven with a real mouse: branch folded, root folded, reopened |
| **Stand hunting report** — click a pin, get the coming sit's verdict, reasons, winds, lanes, covering cameras; Edit one button further | Driven live: red stand's panel named the lane the wind runs down; Edit opened the form and closed the panel |
| **Ranked pin colours** — green / orange / red from the coming sit, refreshed with the stands | Driven live against a plan fixture: three stands, three colours, all correct |
| **3D view** — imagery draped over the 3DEP grid, orbit/zoom/slide, relief slider 1–4×, pins riding the ground | Driven headless over real USGS LiDAR (222 ft of relief) and real Esri tiles: orbit moved the pins, report opened off the terrain, exit clean; mesh/matrix maths unit-tested in Node and compared against the browser copy |
| **3D offline** — Save offline keeps the ground and the drape; the server answers terrain from its database when USGS is down, and the service worker replays covering ground when the server is down | Driven end to end: saved with a real mouse (306 Esri tiles + the grid), server killed, page reloaded from the worker, map panned so no URL matched, 3D built and rendered with pins riding the ground; the cabin case separately, USGS pointed at a dead port and the note naming the fallback |
| **Camera photos on the card** — a camera's latest photos as a thumbnail strip on its card, map panel and drawer alike | Driven in a browser against seeded photos (real JPEG files on disk): three thumbs loaded, the buck tag in the tooltip, the photo-less camera showing its honest empty line, drawer and panel identical |
| **Photo path fix + healing migration** — real photos 404d as `/photos/photos/…`; sync fixed, migration 11 strips the prefix from rows already written | Replicated Kent's exact broken state (prefixed rows, files on disk, migration unrecorded), opened through the real server: paths healed on startup, photo served 200 image/jpeg, drawer grid and card strips all rendering with loaded thumbnails |
| **Photo lightbox** — click a photo anywhere and it expands; arrows/keys/swipe walk the list it came from | Driven in a browser against healed real-shape photos: opened from grid and card strip, arrowed to both ends (stops, no wrap), Esc and backdrop close, key handler detached on close |
| **Species suggestions in review** — the camera's own AI tag renders as "The camera thinks", apart from your tags; Y (or a click) agrees, writing YOUR confirmed tag while the claim stays behind unconfirmed | Driven in a browser with real keys against sync-shape rows: 'buck' offered as deer with the vendor's word shown, 'lynx' listed verbatim and refused a key, Y idempotent, naming refused until a person had tagged, the buck landing on the manual row, machine rows untouched, and the ranking counting exactly the one confirmed deer |
| **Ground switcher** — two hunting lands, one dropdown in the top bar; grounds discovered by clustering everything placed (2 km walking-distance gap), naming one creates the property row and assigns its members | Driven in a browser at desktop and emulated phone width: two clusters 21 km apart seeded, jumped between, named through real key events ("Dans Place" — its 2 stands assigned, the home ground's rows untouched), reload reopened framed on it; the phone chip measured clear of Tools and Camp report after two placement bugs that only measurement caught |
| **Zoom under control** — the wheel accumulates and anchors under the cursor, two fingers pinch, double-tap steps in, and a ⌂ button reframes on the ground | Driven with real input events: a 25-event trackpad flick cost 3 levels where it used to cost 25 (the "suddenly zoomed all the way out" report), one mouse notch moved exactly one, a pinch went 17→19 about the fingers without flinging the centre, ⌂ came home |
| **Weather strip** (bottom of the map) — wind arrow + compass word, temperature, sky, and an hourly scrubber a week out | Driven against a stubbed forecast: opened, scrubbed to Thursday, the readout swung N→SSE and fell 21 °F; the fetch-once/cache/stale-with-a-note paths tested against a live stub, a dead one, and a planted day-old cache row |
| **Crop fields** — outline, crop type, faint wash in the crop's colour, cut recorded as a DATE; USDA's Cropland Data Layer pre-selects the crop | Driven end to end with a real mouse: four corners clicked, the stubbed CDL pre-selected corn with the person's own choice protected, saved, reloaded baked into the page, "Cut today" went dashed with the date on the chip; the EPSG:5070 projection pinned at its defined origin and against ground distance |
| **Routes editable at last** — every route wears a chip; rename, re-stand, redraw the line, delete | Driven with a real mouse: renamed through the form, deleted through its confirm; redraw keeps the route's identity (API + structural tests); the server had PATCH/DELETE all along — the map just never offered them |
| **Suggested walk-in** — from an Access marker (or a click saying where the truck is) to a stand, bent around every wedge of ground the wind would carry scent across, arriving from downwind | Judged by `routes.mjs` independently of the code that planned it, on the plan's own wind and all 16; the first browser screenshot caught a 3-corner "clean" path sweeping through the beds — paths are now densified so the judged points ARE the walked line, and the driven rerun swung visibly wide and saved as an ordinary route |

Run it: `start-trailcam.cmd`. It syncs, plans, then serves on
`http://127.0.0.1:8787` and prints a LAN address for a phone on the same Wi-Fi.

## Not working / not built

- **Real photos arrived 2026-08-29** — the cameras came back to life after
  nine silent months: 4 cameras transmitting, 30 photos the first day. The
  first real run found exactly the class of bug this section predicted: the
  sync stored `file_path` with a `photos/` prefix (the on-disk shape) while
  every reader resolves the column against `out/photos` already, so each image
  URL doubled to `/photos/photos/…` and 404d — captions rendered over broken
  pictures. Fixed in the sync, healed for already-written rows by migration
  11, and the integration test now pins the path SHAPE rather than just its
  presence. The second real-shape adjustment followed on 2026-08-29: SpyPoint's
  own AI tags (stored as unconfirmed `camera-ai` claims) rendered in review
  exactly like human tags, so a visit arrived looking already tagged and Enter
  left the guess unconfirmed for ever — invisible to the ranking. The review
  screen now keeps the two apart (see the suggestions row above). What remains
  untested is the review loop under Kent's hands on the actual photos — and
  the vendor's tag VOCABULARY: the mapping table knows the words that cannot
  be wrong and shows everything else verbatim, so expect real tags to earn
  the table new entries.
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
| Track recording | onX, core | **Yes — and compared against the route you planned, which onX does not do** |
| Line of sight / viewshed | onX | No — the elevation grid is already here, so this is buildable |
| 3D terrain, weather layers, party sharing | onX | No |

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

## What a recorded track is, and is not

Worth reading before trusting one. A phone under November canopy is a bad GPS:
ten to thirty metres of scatter is normal, and every so often it returns a fix
a couple of hundred metres away for one sample. Stored raw that gives a track
whose length is wrong by a factor and a scent analysis naming ground you never
went near — and it looks entirely plausible on a map.

So `track.mjs` filters in four stages, and every stage's discards are counted
and shown: accuracy (the phone's own error estimate; **unknown accuracy counts
as bad, not good**), speed (measured against the last fix KEPT, or one outlier
drags the gate along with it), resolution, then Douglas–Peucker.

The resolution gate is the one that is easy to leave out. Simplification alone
does not fix a stationary cloud, because Douglas–Peucker preserves SHAPE and
noise has plenty of shape — it keeps the outermost fixes and the distance
survives. Measured: ten minutes standing still with ten-metre fixes gave 633 m
of phantom walking with simplification alone, 148 m gated at one sigma, and
under 20 m at two. **Two sigma is the right factor** because browsers report
accuracy as a 68% radius, so two fixes at one true position routinely differ by
twice it. The cost is honest: under heavy canopy you cannot resolve a bend
tighter than your error, so those bends are not drawn.

Consequences that are deliberate:

- **The phone posts raw fixes; the server filters.** The filtering is the part
  most likely to improve, and a track recorded today should get the benefit —
  impossible if the phone already discarded the evidence.
- **A track has no PATCH.** A route is a plan you can edit; a track is a
  measurement. The API returns 405.
- **An "unusable" track is refused, not saved.** Two surviving points still
  draw a confident line and still get compared to the planned route. Caught in
  a browser run where compressed timing tripped the speed gate and the page
  announced having strayed 140 m from a route it had never really measured.

## What a shooting lane is, and what it decides

Added 2026-08-28. This replaced sixteen wind tick-boxes as the primary input,
and the reasoning matters more than the code: **you do not know a stand's winds
directly.** You know where you can see and shoot from it — the lane cut through
the popple, the field edge, the opening over the crossing. Ticking boxes was
doing that derivation in your head, every time, and getting it slightly wrong.

**Trace a lane, and the winds follow.** Open a stand, press Trace, click where
you can shoot to. One click per lane.

**Why the geometry is exact rather than sampled.** A lane radiates FROM the
stand, so every point along it lies on one bearing from the stand — the far end,
the near end, and everything between. That collapses "does my scent reach any
part of this lane" into a single angular test against one bearing. It is the
one place in this program where the honest answer is also the cheap one.

**Three handles per lane**, doing deliberately different jobs:

- the **tip** moves the far end — how far the shot reaches and which way it
  points;
- the **two side handles** open and close the cone and change nothing else, so
  the centre line stays where you put it.

A single corner handle doing both would make it impossible to widen a lane
without also shortening it.

**Widening costs winds, and is meant to.** Each lane is tested against its own
half-angle, so the shape you drew is the shape you are judged on. The scent
plume still dominates — 30 degrees either side against a lane's 10 by default —
so a lane's width moves the answer at the margins, not wholesale.

**A lane never widened stores no width at all.** It reads back as "use the
default", so changing that default later moves every lane nobody adjusted and
leaves alone every lane somebody did. A stored copy of today's number would
outlive any change to it and quietly disagree with lanes traced after.

**The tick-boxes are gone; the data they wrote is not.** A stand ticked before
lanes existed is still ranked on those winds when it has no lanes, so dropping
the `good_winds` column to tidy up would have silently un-ranked stands that
work today. The form shows them read-only, says whether they are in use, and
offers to clear them — removing the only editor for a field that still drives
the ranking would otherwise leave a wrong set permanently unfixable. Where a
stand carries both, the disagreement is REPORTED rather than resolved; tracing a
lane takes over without being asked to.

The stand pin's tooltip names the winds a stand is JUDGED on, not what it was
ticked with. Built from the ticked set it would disagree with the ranking on any
stand carrying both.

Bounds: a half-angle under 3 degrees is a line, over 80 is a 160-degree fan you
can see across rather than shoot down. The map clamps a drag to those; the
database's own check is looser (above 0, below 90) because it is guarding
against nonsense arriving over the API, not enforcing a judgement.

## Next, in order

1. **Record a walk in, on the real phone.** The recorder is driven and tested
   but only against scripted geolocation. Real canopy, a real lock screen and
   iOS's own service-worker quirks are what it has not met.
2. **Log sits.** The journal is built and empty. Everything it can eventually
   say needs about a dozen sits with a spread of ratings — including some
   mediocre evenings, or there is no comparison group and it will keep
   refusing (correctly).
3. **Run the collar calibration** once `collar-data/RateofMovementData.csv` is
   downloaded — `node calibrate-planner.mjs --inspect` first, to confirm the
   detected columns before trusting any number it prints.
4. **Review the real photos.** The path is verified, the machine tags arrive
   as suggestions — what is left is the actual evening's work: tag the first
   real visits, name the first bucks, and note any vendor AI word the mapping
   table showed verbatim (`db.mjs` `VENDOR_SPECIES`) so it can be taught the
   ones that are beyond doubt.
5. **Analysis** (step 5) — WHEN/WHERE side by side with raw counts, on
   `detectionsWithWeather()`, which now refuses unconfirmed rows by default.
6. Moultrie, if a capture arrives.
7. Historical imagery, if a working NAIP endpoint can be found.

**Settled 2026-08-28: the sixteen wind tick-boxes are gone.** Kent's call. Two
inputs for one answer is how they drift apart, and the boxes were the worse of
the two. Lanes are now the only way to record what a stand can be hunted on.

## The structural debt worth naming

**Both splits are done** (2026-08-28). `spypoint-sync.mjs` was 2,408 lines, of
which about 1,950 were the dashboard inside one template literal; the dashboard
was then 2,100 lines of which about 1,300 were the map. The files now are:

| File | Lines (2026-08-29) | Holds |
| --- | --- | --- |
| `spypoint-sync.mjs` | ~430 | the sync, and the files it writes |
| `dashboard-page.mjs` | ~1,000 | alerts, wind rose, review queue, sit ranking, cards, photos |
| `map-view.mjs` | ~4,500 | the map: layers, pins, markers, routes, fields, lanes, measure, terrain, 3D, weather strip, parcels |
| `tonight-page.mjs`, `journal-page.mjs`, `review-page.mjs` | ~400–830 each | one screen each |

**`map-view.mjs` has grown well past the size that triggered the split.** It
was 1,600 lines when it came out of the dashboard on 2026-08-28, 2,400 by the
end of that day, and is ~4,500 after 2026-08-29 (3D, the ground switcher, then
zoom/weather/fields/route-editing/suggested walk-ins) — nearly twice the length
`spypoint-sync.mjs` was when it became unworkable. Nothing is wrong with it
yet, and splitting on a line count alone would be cargo-culting the last split;
but the seam named here last time has widened: the forms (stand, marker, route,
field — FOUR now, sharing a class and a close path) are the obvious first file,
and the weather strip is self-contained enough to be a second. The next person
to add a map feature should probably do that split first.

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
- **A server left running from before a `git pull` serves the old page for
  ever.** `serve.mjs` builds every page from template literals at import time —
  once, at startup — with no build step and no watcher, so the browser shows a
  feature missing that is right there in the repository, and nothing says why.
  This cost a full round trip on 2026-08-28: the lane tracing was reported as
  "not there" by a checkout three commits behind a running server. **Restart
  after every pull**, and when in doubt read the startup banner (it names the
  branch and commit) or `curl /api/health` — `build.stale` is true when a source
  file has changed since the process booted, and `build.staleSince` names it.
- **A panel in the middle of the map covers the thing it edits.** Harmless while
  a form was something you filled in and closed; fatal once the map behind it
  grew handles. Measured with a real drag: the press landed on the wind tick
  grid and the cone never moved. Any new map-side form has the same problem —
  `centreClearOfForm()` is the fix, and it measures the form's real box because
  the box changes with content and screen size.
- **Handles that sit where geometry puts them will pile up.** On a default
  20-degree cone the rim corners are a tenth of the lane's length from the tip —
  10 pixels on a 60-pixel lane — so the tip's grab circle covered both and a
  "widen" drag moved the far end instead. Targets have to scale with the thing
  they handle, and be pulled off each other deliberately.
- **An SVG rebuilt on every draw destroys the element you are dragging.** The
  overlay is `innerHTML`-replaced each frame, including the frame the drag
  itself causes. Listen on the SVG and capture the pointer to it, never to the
  handle: on touch the browser implicitly captures to the original target, and
  the rest of the gesture then goes to a detached node and simply stops
  arriving.
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
- **`backdrop-filter` makes a containing block.** `position: fixed` inside the
  top bar pins to the BAR, not the screen, because the bar's backdrop-filter
  (like `filter` and `transform`) becomes the containing block for fixed
  descendants. The ground switcher's phone chip did exactly that — computed
  `top: -14.5px`, visibly nowhere — so the script moves it to `body` before
  the fixed styling applies. Anything else made fixed from inside the bar or
  the drawer will repeat this.
