# TrailCam

Sync your SpyPoint trail cameras to your own machine: **where each camera is**,
**how it's doing**, and **what it photographed** — plus an offline dashboard
with a map, so you can see all of it at a glance without the app.

No npm install, no build step, no accounts beyond your camera's. Node 20+
and SQLite, which ships with Node itself.

> ### This repository is public
>
> The tool's *output* is not meant to be. Camera coordinates are the physical
> locations of your cameras, and the photos are what they saw. `.gitignore`
> excludes the entire `spypoint-data/` output directory, plus photos, CSVs and
> the credential-bearing scheduler wrapper. **Check `git status` before your
> first commit**, and keep it that way.

## Easiest way to run it

Double-click **`start-trailcam.cmd`**.

It checks Node is installed, asks for your SpyPoint login the first time
(offering to remember it, encrypted to your Windows account), syncs your
cameras, builds the hunt plan, and opens the dashboard in your browser. Run it
again any time to refresh.

If you'd rather paste one line:

```powershell
cd $HOME\TrailCam; .\start-trailcam.cmd
```

The saved login lives in `.credentials.xml`, encrypted with Windows DPAPI so
only your Windows account on that machine can read it. It never leaves the PC
and is gitignored. Delete it to be asked again.

## Quick start (manual)

This is several modules now, not the single file it started as, so clone it
rather than downloading one script.

```powershell
# Windows PowerShell — one line at a time
cd $HOME
git clone https://github.com/KS-Three/T-CAM.git TrailCam
cd TrailCam
$env:SPYPOINT_EMAIL = "you@example.com"; $env:SPYPOINT_PASSWORD = "your-password"
node --disable-warning=ExperimentalWarning spypoint-sync.mjs
node --disable-warning=ExperimentalWarning serve.mjs --open
```

On macOS or Linux, `export SPYPOINT_EMAIL=...` instead of `$env:`.

**Just want to look at it?** The server needs no login and no sync — it serves
whatever is already in the database, and an empty one still gives you a map you
can drop stands on:

```powershell
cd $HOME\TrailCam
node --disable-warning=ExperimentalWarning serve.mjs --open
```

`--disable-warning=ExperimentalWarning` only silences Node's notice about
`node:sqlite`; everything works without it.

Credentials are read only from `SPYPOINT_EMAIL` and `SPYPOINT_PASSWORD`. They
are never written to disk, never logged, and never stored in this repo.

## Commands

| Command | What it does |
| --- | --- |
| `node spypoint-sync.mjs` | Full sync: cameras, photos, dashboard |
| `node spypoint-sync.mjs --dry-run` | Lists cameras and what *would* download. Writes nothing |
| `node spypoint-sync.mjs --inspect` | Dumps the raw API field names for one camera and one photo |
| `node hunt-planner.mjs` | Ranks the next two weeks of sits at your camera locations |
| `node serve.mjs` | Serves everything from the database at http://127.0.0.1:8787 |
| `node serve.mjs --open` | The same, and opens a browser |
| `node serve.mjs --host 0.0.0.0` | Also reachable from a phone on the same Wi-Fi |
| `node spypoint-sync.mjs --provider <id>` | Sync a different camera brand |

### The pages

| Page | What it is for |
| --- | --- |
| `/` | The map, full screen: every stand wearing tonight's verdict, with the camp report in a drawer |
| `/tonight` | One screen: which stand, the walk in, when to leave, log the sit |
| `/journal` | The season, and what it is entitled to claim from it |
| `/review` | Tagging photos — keyboard-driven, built for volume. The camera's own AI guess shows up as a suggestion to agree with (Y), never as a tag you didn't make. It also learns what your cameras' empty frames look like from every "nothing here" you press, and flags likely wind with a measured match — no cloud, no model |

`/tonight` is the one to put on a phone's home screen: it installs as an app
and keeps working with no signal.

Hunt more than one piece of land and the map notices: a dropdown appears (top
bar on a desktop, bottom-centre on a phone) listing each ground it found by
clustering what you've placed. Pick one and the map jumps there; the choice
sticks. Name a ground once and it stops being "Ground 2 — 2 stands" and starts
being "Dan's place", on the map and in the records underneath.

| Flag | Meaning |
| --- | --- |
| `--out DIR` | Output directory (default `./spypoint-data`, or `$SPYPOINT_OUT`) |
| `--max N` | Max new downloads per camera per run (default 500; `0` = unlimited) |
| `--limit N` | Photos per API request (default 100) |
| `--size S` | `large` (default) / `medium` / `small`; falls back downward |
| `--cameras A,B` | Only cameras whose name or id contains one of these |
| `--quiet` | Errors and final summary only |

## Camera brands

Each brand's cloud sits behind a provider, so the sync, the map, the dashboard
and the hunt planner never learn anything brand-specific — a camera is just a
row, and cameras from different brands appear together on one map with a brand
label on each card.

| Provider | State |
| --- | --- |
| `spypoint` | **Working.** Verified against a real 4-camera FLEX-M account |
| `moultrie` | **Not implemented** — see below |

`providers/README.md` documents the interface and how to add a brand.

### Why Moultrie isn't supported yet

Moultrie is a much harder target than SpyPoint, and not for lack of looking
(measured 2026-08-27):

- **No community client exists.** SpyPoint has two independent ones that agree
  on every endpoint, which is why that provider was short work. The only
  Moultrie project of any relevance,
  [lzilioli/moultrie-scraper](https://github.com/lzilioli/moultrie-scraper),
  drives a headless browser with Puppeteer rather than calling an API — what
  people resort to when there is no easy API.
- **The web app is Blazor WebAssembly** (.NET 8). Its endpoints are compiled
  into `.wasm` assemblies, so there is no JavaScript bundle to read them out of.
- **It authenticates with Microsoft MSAL** — OAuth with browser redirects, not
  SpyPoint's `POST /user/login` returning a bearer token. A standalone client
  would need the full authorization-code + PKCE flow and token refresh.
- **No official API or developer programme.**

Rather than stub it with invented endpoints — a provider returning
plausible-looking wrong data would be drawn on the map and fed to the hunt
planner without complaint — `providers/moultrie.mjs` refuses with an
explanation, and records what was found so the next attempt starts from
evidence.

**One capture unblocks it**, about five minutes for anyone with a Moultrie
account: [`docs/moultrie-capture.md`](docs/moultrie-capture.md). It yields the
real API host, the endpoints, the field names and how the token is carried —
after which implementing the provider is ordinary work rather than guesswork.

## Data store

Cameras, photos, detections, bucks, properties and hourly weather live in
`spypoint-data/trailcam.db`, a SQLite file. `node:sqlite` is built into Node 22+,
so this adds **no dependencies**. Photos stay as JPEGs on disk; the raw API JSON
for every camera and photo is kept in the database alongside the parsed fields,
so nothing is lost when a provider's shape turns out to differ.

Run with `--disable-warning=ExperimentalWarning` (the launcher does) — `node:sqlite`
prints an experimental notice on every run that otherwise makes a working tool
look broken.

Schema highlights, and why:

| Choice | Reason |
| --- | --- |
| `NULL` means unknown, never `0` | A camera at 0% battery is urgent; one that reports no figure is a different thing, and the health rules must tell them apart |
| `lat` and `lng` are separate named columns | Never a positional pair — the ordering is the classic way to get this wrong |
| Detections are per **animal** | So one frame can hold two different bucks |
| `source` is `camera-ai` or `manual` | An unreviewed machine tag is never mistaken for a human identification |
| Bucks are global; cameras belong to properties | A buck seen on two properties is one buck |
| Weather is stored for **every** hour | The hours with no detections are the control group; without them no pattern can be tested |
| Weather locations match on distance, not a grid | Two cameras 200 m apart can round into different grid cells; distance matching keeps them on one record |
| IDs are `provider:native_id` | Two accounts, or two brands, can never collide |

Migrations are versioned and applied once, each in a transaction. **Never edit a
migration that has shipped** — add another; this file holds data the user cares
about.

## The local server

`start-trailcam.cmd` now finishes by starting a small server instead of opening
a file:

```powershell
node serve.mjs                      # http://127.0.0.1:8787
node serve.mjs --host 0.0.0.0       # also reachable from a phone on your Wi-Fi
node serve.mjs --port 8080 --open
```

**Why a server at all:** a static HTML file cannot save anything. The moment you
want to click a photo and say "that's Split G2", the page needs somewhere to
write — that is what this provides, and it is the groundwork for the tagging
screen.

Node's built-in `http` module, so still no dependencies. It binds to
**127.0.0.1 by default** — nothing outside this computer can reach it until you
explicitly pass `--host 0.0.0.0`, which is a deliberate choice because it
exposes your camera locations to anything else on that network.

The browser talks to a small JSON API rather than a page with data baked in:

| Endpoint | Returns |
| --- | --- |
| `GET /` | The dashboard, rendered from the database |
| `GET /api/state` | Everything the page needs in one call |
| `GET /api/cameras` | Cameras with their property names |
| `GET /api/photos?limit=N` | Photos newest first, with species tags |
| `GET /api/health` | Store contents, and which commit the process is running |
| `GET /photos/...` | A synced image |

That boundary is deliberate: the phone app, when it comes, speaks to exactly
this interface instead of forcing a rewrite.

### "The new feature isn't there"

The pages are built from template literals when the module is imported, which
happens once, at startup. There is no build step and no file watcher — so a
server you started before a `git pull` keeps serving the old page indefinitely,
with nothing in the browser to say so. **Restart the server after every pull.**

Two ways to check rather than guess. The startup banner names the commit:

```
  TrailCam is running — running main 377aa7a.
```

And the running server will tell you if the files on disk have moved on since
it booted:

```powershell
curl.exe -s http://127.0.0.1:8787/api/health
# {"ok":true,...,"build":{"commit":"377aa7a","branch":"main",
#   "startedAt":"2026-08-28T14:02:10.114Z","stale":true,"staleSince":"map-view.mjs"}}
```

`"stale": true` means exactly one thing: a source file changed after this
process started, so stop it with Ctrl+C and start it again. `staleSince` names
the file that changed.

If the banner shows the right commit and `stale` is false but the browser still
looks old, it is the browser: hard-reload (Ctrl+Shift+R), and if that fails,
DevTools → Application → Service Workers → Unregister. The worker is
network-first for pages, so this should be rare — it only serves a cached page
when the server is unreachable.

Photo paths come from the URL and are therefore untrusted — they are resolved
and checked to be inside the photo directory before anything is read. A test
sends the raw un-normalized bytes down a socket to prove the *server* refuses,
rather than proving a polite HTTP client rewrote the path first.

## Stands, tripods and blinds

Cameras tell you where deer are; a stand is where *you* can be, and those are
not the same place. Press **+ Add stand** on the map, click where it sits, and
give it a name and type — ladder/hang-on, tripod, ground blind, box blind,
saddle, or other. Stand pins are green teardrops against the cameras' round
pins, so the two kinds are distinguishable by shape as well as colour. Click a
pin to edit, move or delete it.

Each stand automatically lists the cameras within 400 m and how far away they
are. That is the link which turns *"camera A has been busy"* into *"sit the
stand that covers camera A"*.

### Good winds

The winds a stand is huntable on — the wind carrying your scent away from where
deer come from — are the single most important thing about it, and cannot be
derived from anything the cameras report.

**Blank means unknown, not "any wind".** A stand with no winds answers `null`
rather than `true`, because treating "I haven't said yet" as "yes" would send
you to sit somewhere the deer will smell you. A test pins that behaviour.

### Shooting lanes, which is where the winds come from

There used to be sixteen tick-boxes. They asked the wrong question. You do not
know a stand's winds directly; you know where you can see and shoot from it —
the lane cut through the popple, the field edge, the opening over the crossing —
and the winds follow from that. Ticking boxes was doing that derivation in your
head, every time, and getting it slightly wrong.

**The boxes are gone** (2026-08-28). Two inputs for one answer is how they drift
apart, and the boxes were the worse of the two.

So mark the shape instead. Open a stand, press **Trace a lane**, and click where
you can shoot to. Each lane is drawn as a cone from the stand, dark at your feet
and fading out along it, because past forty or fifty yards the shot gets harder
and a wedge of flat colour would claim a confidence the distance does not
support.

Each lane carries **three handles**, and they do different jobs on purpose:

- the **tip** moves the far end — how far the shot reaches, and which way it
  points;
- the **two side handles** open and close the cone, and change nothing else. The
  centre line stays where you put it.

#### Or just say the numbers

Handles put a lane roughly where it goes, and rough is their limit. You already
know this one runs eighty-five yards to the field edge and opens about thirty
across at the end, because you have walked it — and until 2026-08-28 the only
way to say so was to drag until a readout happened to agree with the figure
already in your head.

So every lane's row in the form carries **two boxes: how far out, and how wide
across the end**, both in yards.

- **Yards, not metres.** Everything stored and computed stays metric, the way
  the rest of the program does. Yards are the last step before a number is
  shown and the first after one is typed, which is the call
  [`measure.mjs`](measure.mjs) already made for the same reason: the answers get
  used in American conversations.
- **Yards across, not degrees.** The stored width is a half-angle, which is the
  right thing to *store* — it is what the wind test needs and it does not change
  when the lane gets longer. It is the wrong thing to *ask for*. Nobody under a
  tree knows an opening in degrees. The angle is still shown beside the box,
  because it is the part that stays put: a lane is a cone, so lengthening one
  widens it on the ground.
- **Typing a distance does not swing the lane.** It slides the far end along the
  bearing the lane already has. Aiming it somewhere else is the tip handle's
  job, and mixing the two would be the single corner handle all over again.
- **A width no lane could open to is pulled back rather than refused**, and the
  box shows what it landed on, so the number you are looking at is always the
  number the winds were computed from.

The cone also **says its own reach on the ground**, next to its tip, and says
its width there instead while a width handle is held. The form has the same two
numbers, and that was not enough: while you drag your eyes are on the cone, and
while tracing the form is a strip along the bottom whose row for this lane may
have scrolled out of it.

Widening a lane really does cost you winds. Scent travels downwind, and a stand
is unhuntable on a wind whose downwind direction falls within the plume's
half-angle of any lane's bearing — so the wider you open a lane, the more of the
compass blows your scent across ground you are watching. The winds are
recomputed as you drag, because a derivation you only see after saving is one
you cannot correct.

A lane you have never set a width on stores no width at all and uses the
default, so changing that default later moves every lane that was never adjusted
and leaves alone every lane that was. Dragging a side handle or typing in the
width box both count as setting one.

**Winds ticked before the boxes went are kept**, because a stand ticked back
then is still ranked on them when it has no lanes — dropping the column to tidy
up would have silently un-ranked stands that work today. The stand form shows
them read-only, says whether they are being used, and offers to clear them:
removing the only editor for a field that still drives the ranking would
otherwise leave a wrong set permanently unfixable. Where a stand carries both,
the disagreement is reported rather than resolved. Trace a lane and it takes
over without being asked to.

| Endpoint | |
| --- | --- |
| `GET /api/stands` | Every stand, with parsed winds, lanes, the winds those lanes imply (each with its bearing, reach and width across the end), and nearby cameras |
| `POST /api/stands` | Drop a pin |
| `PATCH /api/stands/:id` | Rename, move, retype, or change winds or lanes |
| `DELETE /api/stands/:id` | Remove one |
| `GET /api/stand-types` | The allowed types and compass points |

Updates are partial, so a rename cannot silently clear the winds — a real risk,
since that would quietly turn a known-good stand into one the tool refuses to
recommend.

## Who owns this ground

Press **Who owns this?** on the map and click anywhere: owner name, acreage,
property class, county, town, school district and the owner's mailing address —
which is how you write to ask permission.

This is the headline feature of the paid hunting apps, and in Wisconsin it is
free. The data is the [Wisconsin Statewide Parcel
Map](https://maps.sco.wisc.edu/Parcels/), aggregated from every county by the
State Cartographer's Office: 3.5 million parcels, public record, queryable by
point.

**Wisconsin only.** Other states publish parcel data in wildly varying shapes
and several do not publish owner names at all. A point outside the state
returns "no parcel here" rather than pretending. The endpoint is overridable
via `TRAILCAM_PARCEL_URL`, so pointing at another state's service is a config
change rather than a rewrite.

### On privacy

Owner names and mailing addresses are public record, and the mailing address is
the practical point. It is still someone's home address, so lookups are made
**on demand** and held only in memory for the life of the process. Nothing is
written to the database or to disk, and there is no bulk download.

### Two failure modes kept distinct

- **No parcel there** — outside Wisconsin, or on water. A real answer, returned
  as `found: false` with HTTP 200.
- **The lookup broke** — returned as HTTP 502.

Conflating them would have the map claim nobody owns ground that plainly is
owned. ArcGIS makes this easy to get wrong: it reports its own errors *inside*
a 200 response, so checking the status code alone would turn a broken service
into "no parcel here". A test pins that.

## Output

```
spypoint-data/
  dashboard.html      map + camera cards + photo grid, opens offline
  cameras.csv         location, battery, signal, temperature, memory, plan,
                      photo quota and its billing cycle, last seen
  cameras.raw.json    the untouched camera documents
  photos.jsonl        one line per photo (id, camera, date, species tags, url)
  photos/<camera>/<YYYY-MM>/<photoId>.jpg
```

**Re-running is safe and cheap.** A photo whose `<photoId>.jpg` already exists
under `photos/` is skipped, so the photo tree *is* the sync state — each run
re-reads the photo *list* (metadata only) and downloads just what's missing.
Delete a file to re-fetch it.

## How it works

There is no official SpyPoint developer API. This talks to the same private
REST API the SpyPoint app itself uses, at `restapi.spypoint.com/api/v3`, with
your own credentials:

| Endpoint | Purpose |
| --- | --- |
| `POST /user/login` | Exchange email + password for a bearer token |
| `GET /camera/all` | Camera documents: GPS, battery, signal, memory, plan |
| `POST /photo/all` | Paged photo list with CDN download URLs |

Endpoints were cross-checked against two independent community clients,
[hstern/pyspypoint](https://github.com/hstern/pyspypoint) and
[coloradude/spypoint-api-wrapper](https://github.com/coloradude/spypoint-api-wrapper),
which agree on all of them.

Because the API is undocumented, field extraction reads the known paths first
and falls back to hunting by key name, keeping the raw JSON alongside so
nothing is lost when a camera model differs. Run `--inspect` to see exactly
what your account returns.

### Coordinates are `[longitude, latitude]`

Location arrives as a GeoJSON Point at
`status.coordinates[0].position.coordinates`. GeoJSON puts **longitude first**,
and this was verified rather than assumed: the same object carries DMS strings
(`"N44 7.407360"`, `"W90 39.259260"`) which convert to exactly the numeric
array, longitude in slot 0. A test pins this. Don't "fix" it to `[lat, lng]` —
transposing it silently drops a Wisconsin camera into Asia, and a map will
render that without complaining.

## Tests

```bash
node --test
```

No install step, no dependencies. The suite covers coordinate ordering
(including the independent DMS cross-check), signal and battery extraction,
fallbacks for differently-shaped cameras, malformed input, staleness maths,
health thresholds, and HTML escaping in the dashboard.

Fixtures under `fixtures/` mirror real API responses but every identifying
value — coordinates, ids, ucid, SIM — is synthetic, because this repo is
public.

## Caveats

- **Unofficial API.** SpyPoint can change it without notice. When a response
  doesn't look right, the script exits nonzero with a clear message rather than
  guessing. Treat eventual breakage as expected, not as a bug.
- **Photos are the transmitted versions** — the compressed cellular uploads.
  Full-resolution originals stay on the camera's SD card; HD retrieval still
  goes through the SpyPoint app and your plan.
- **The plan's photo cap is not something this can lift.** It applies to what
  the camera transmits, so the cloud never holds more than the allowance and
  neither can any client. What this does instead is see the wall coming, and
  keep every photo that *was* transmitted, permanently, on your own disk. See
  [Photo quota](#photo-quota).
- **A camera only has photos while it's transmitting.** Cameras silent for more
  than 30 days are flagged before the sync runs, because an empty result from a
  dormant camera is the expected outcome, not a failure.
- **Be gentle.** Requests are paced (~250 ms between API calls, ~150 ms between
  downloads) with no retry storms. Hourly is plenty — cameras only upload a few
  times a day on their own schedule.

## Photo quota

A SpyPoint plan meters **transmission**, per camera, per billing cycle — 100
photos a month on the free plan. Spend the allowance and the camera carries on
taking pictures and quietly stops sending them. Nothing fails, nothing is
reported, and the only symptom is a photo grid that stops growing. Cameras have
gone dark for a fortnight this way.

So every sync now reads each camera's own allowance and says where it stands:

```
Photo quota this billing cycle:
  Fremont South  [#---------] 10/100   0.3/day - lasts the cycle
  Fremont North  [##########] 100/100  quota spent, 14 days left in cycle
  East Side      [######----] 60/100   3.6/day - quota dry 2026-09-11, 2 days before the cycle ends
  South Side     [#########-] 88/100   only 12 photos left, 14 days of cycle to go

QUOTA: 3 of 4 camera(s) are at or near their limit:
```

Two rules raise a flag, and the second is the one worth having:

- **80% of the allowance spent** — the obvious one, and on its own it arrives
  too late to do anything about.
- **The burn rate will not last the cycle.** Photos so far, divided by days
  elapsed, against what is left. East Side above is only 60% spent and still in
  trouble; a camera on a field edge during a corn harvest can spend a month's
  allowance in four days. This fires while there is still time to move it,
  slow its trigger down, or decide it is worth paying for.

Both are per camera. There is no account-wide number that means anything here —
one camera at 100/100 and three at 10/100 average out to "fine".

Quota also colours the camera card, its map pin and the Needs attention list on
the dashboard, the same way a flat battery does, because it is the same kind of
failure: the camera is up, reporting, and sending nothing.

**None of this raises the cap.** The limit is enforced at transmission, before
any of this can see it — no client can download a photo that was never sent.
The full-resolution originals of everything, including whatever was never
transmitted, are on the camera's SD card.

## Hunt planner

```bash
node hunt-planner.mjs                            # uses your synced camera locations
node hunt-planner.mjs --days 14 --json plan.json
node hunt-planner.mjs --lat 44.1 --lng -90.6     # works with no sync data at all
```

Pulls a real forecast for each camera's coordinates and scores every morning
and evening sit for the next N days, ranked, with the reasoning printed:

```
  strong  37  Sat, Nov 7 PM (from 1:02 PM)  Creek Bottom
         31°F, wind NW 9 mph, Peak rut — best week
         evidence A — collar/fetal data at this latitude
         +30  [A] Peak rut — best week — highest mean movement rate of the year
         +4   [B] 7°F below the seasonal normal — cold pushes activity into the evening
         +3   [C] wind 9 mph — steady enough to give a predictable scent cone
         Sit all day if you can. During the peak, about 70% of rut excursions
         happen in daylight — against about 30% in the weeks either side.
```

### What the score is built from — and what each part rests on

Every factor carries the **tier of evidence** behind it, and the tiers are the
point. They were added after a literature pass
([`docs/deer-evidence.md`](docs/deer-evidence.md)) found that GPS-collar studies
flatly contradict several things this tool used to score.

| Tier | Means |
| --- | --- |
| **Y** | Measured on *your* ground — traced lanes, your photographs, your logged sits |
| **A** | Collar or fetal-aging data, peer-reviewed, at this latitude |
| **B** | Peer-reviewed, but southern latitudes or direction-only |
| **C** | Extension-service summary of collar work |
| **D** | Received wisdom with no traceable study — **scores zero** |

| Factor | Tier | Why |
| --- | --- | --- |
| **Rut phase** | A | Photoperiod-driven, so the dates barely move. Recalibrated to southwest Wisconsin: 188 collared bucks put the peak rut at **23 Oct – 12 Nov**, best week 5–11 Nov |
| **Temperature anomaly** | B | Against the seasonal normal, and it moves *which window* is worth sitting rather than whether to go at all |
| **Cold front** | B | Kept small and labelled contested. Collar studies find **no** movement change across a front |
| **Wind** | B/C | Scored as *scent management*, about you rather than the deer — collar data has activity **rising** with wind, not falling |
| **Rain** | B | Heavy rain is a real penalty; drizzle is neutral because two collar studies disagree about it |
| **Barometric pressure** | D | Reported, **scores nothing**. The famous "active band" traces to logbook compilations |
| **Moon** | D | Reported, **scores nothing**. Two collar datasets find no lunar pattern at all |

A tier-D factor stays on the screen, visibly contributing zero, rather than
disappearing without explanation and being proposed again next season.

Out of season the weather cannot rescue a date, so those sits are capped —
otherwise a flawless August morning outranks a windy day in the rut. The cap
appears as a printed reason rather than being applied silently.

### The other half: what your own cameras have seen

The planner still answers **when**. `evidence.mjs` answers **where**, from your
own photographs, and the two are kept apart deliberately — see decision 9 in
[`docs/design.md`](docs/design.md).

Fitting the planner to one season of sightings is hopeless: there is one rut a
year, so rut phase, date and "that Tuesday" are perfectly confounded. But that
objection only touches *time*. "It is blowing north-west this afternoon, which
stand?" is a comparison **between cameras during the same weather** — every
camera gets the same wind in the same hour of the same rut phase, so date, rut
and moon are held constant for free, and the comparison is sound in the first
season.

So each camera gets a rate **per hundred camera-hours** under conditions
matching the coming sit, and the denominator is real: it comes from the weather
table, which is filled for every hour whether or not a photo exists. Conditions
are tried from narrow to broad — *dusk on a NW wind*, then *any daylight on a NW
wind*, then *dusk, any wind* — and the first rung with enough matched hours at
two or more cameras is the one reported, by name, so it is obvious how narrow
the claim is.

Below ten matched camera-hours nothing is ranked at all. It says so instead.

### And how much to believe it

Every recommendation now carries a **confidence**, assembled from what is
*known* rather than from what was scored: whether the winds came from lane
geometry you traced or boxes you ticked, whether your own photographs had
enough matched hours to count, whether your sits are logged, and whether the
next stand down is close enough that the order is arbitrary.

A high score on no evidence reads *low confidence*, and lists what would fix
it. That pairing — `strong` beside `moderate confidence` — is the whole point.

### What it is not

**The planner still knows nothing about your deer.** It has never seen a photo.
It ranks *when* the weather and calendar favour a sit. Where your photographs do
enter, they enter through `evidence.mjs`, per camera, with their counts shown
and a refusal when there are too few.

Every factor is published whitetail behaviour, not a pattern learned from your
cameras. Once photos accumulate, those sightings can be scored against these
same factors to find which ones actually predict movement on your ground — and
at that point the evidence should correct this model, not the reverse.

## The map is the app

The dashboard used to be a page of cards with a map in the middle. It is now
the other way around (2026-08-28): **the map fills the screen**, and everything
else overlays it or slides in over it.

- **The tool tree** (top-left) replaces the flat stack of buttons: Stands,
  Scouting and Ground branches with guide lines, collapsible per branch and
  from the root — which is what makes it usable on a phone, where the open
  tree is a third of the screen.
- **Camp report** (top-right) slides the old page in from the right: alerts,
  best sits, wind history, the review queue, camera cards, recent photos. It
  scrolls on its own, so browsing it never moves the map underneath.
- **Click a stand and its hunting report opens** — not the edit form. The
  panel carries the coming sit's verdict as a coloured chip, the ranking's
  reasons word for word, the winds it is judged on and where they came from,
  its lanes, and the cameras covering it. Edit is one button further away,
  because mostly you are not editing — you are deciding.
- **Click a camera and its card opens** in the same panel: the exact card the
  drawer shows, built by one function so the two can never disagree. The card
  carries the camera's **latest photos** — a strip of thumbnails from what the
  page already holds, with the newest date and a jump to Review. **Click any
  photo — here or in the drawer's grid — and it expands over the page**; the
  on-screen arrows, the arrow keys, or a swipe walk through the rest. Which
  photos "the rest" means follows from where you clicked: the grid walks every
  downloaded photo, a camera's strip walks that camera's own. The ends stop
  rather than wrap, so "have I seen them all" stays answerable. Only photos on disk are shown: a photo the sync has listed but
  not downloaded exists only at the vendor's URL, and drawing from there would
  both leak a request off-property and break exactly where the strip is wanted
  — in the woods. The card says which of those states a photo-less camera is
  in, because "listed but not downloaded" and "nothing yet" have different
  fixes.
- **Stand pins wear tonight's verdict**: green when the coming sit's wind
  works, red when it would run your scent down a lane, orange for every honest
  in-between — winds not recorded, no forecast yet, or a thermal quietly
  arguing with a wind that looks fine. Unknown is deliberately not green. The
  colours refresh with the stands, so a lane you just saved can flip tonight's
  answer in front of you.
- **The weather strip** (bottom-centre) shows the wind and temperature right
  now — an arrow pointing the way the air is moving, the compass word hunters
  actually use for where it is from, and the sky in one word. Tap it and it
  opens into the hourly forecast with a scrubber across the coming week: drag
  forward and watch the wind swing and the front arrive, because the wind
  three days out is what decides which stand gets hunted Saturday. The
  forecast comes through the server and is cached, so in the truck the strip
  shows the last fetch **and says how old it is** rather than passing Tuesday
  off as live. Everything stays in the property's own clock — the times are
  never re-read in whatever timezone your phone happens to be in.
- **Crop fields** (Scouting → + Crop field): click around a field edge, say
  what grows in it, and it draws as a very faint wash of that crop's colour
  with a name chip at its centre — faint on purpose, because the imagery
  underneath is the actual information. When a new outline closes, the form
  asks USDA's Cropland Data Layer what the satellite says grows there and
  pre-selects it; you correct it if the satellite is wrong, and a category the
  mapping does not recognise is shown verbatim rather than guessed into a
  crop — the same rule the camera's AI words follow. **Record the cut** when
  it happens: it is a date, not a tick-box, because a cornfield cut yesterday
  and one cut a month ago are different hunting facts. A cut field goes
  dashed and its chip says when.
- **Walk-in routes can finally be edited.** Every route wears a small chip at
  its midpoint; tap it for rename, a different stand, **Redraw the line** (the
  shape is redrawn, the name and verdict-keeping survive) and Delete. The
  server could always do all four — the map just never offered them.
- **"Plan the walk in"**, on any stand's report, proposes the entry path for
  the coming sit's wind: from your nearest **Access** marker (or one click
  saying where the truck is), swinging wide of every wedge of ground your
  scent would blow across — the stand itself, the other stands, your marked
  beds and food plots — and arriving from the stand's downwind side. The
  proposal is dashed teal until you press **Save as route**, whereupon it is
  judged like any hand-drawn route. The card reasons in sentences and owns
  the model's limits: scent is a 200 m cone either side of downwind, thermals
  are not in it, and the line stops twenty metres short because the last
  steps to the tree cannot be clean on any wind.

### 3D

Press **3D view** (under Ground) and the map stands up: the satellite imagery
draped over the same USGS 3DEP LiDAR the hillshade reads, lit from the same
north-west the hillshade uses, with your stands and cameras riding the ground
in their ranking colours. Drag to orbit, scroll to zoom, shift-drag to slide;
on a phone, one finger orbits and two zoom.

The **Relief slider** stretches hills from true scale (1×) to 4×, and the HUD
says so while it is stretched — this ground is gentle, and a rendering that
quietly exaggerated it would be a diagram wearing a photograph's clothes. The
lighting stays honest under the slider: the mesh carries the ground's true
slope and the shader rebuilds normals for the current setting, rather than
baking normals that are only right for one.

There is no mapping library behind this — the page keeps its no-dependency
rule (the offline test literally asserts it contacts no external host). The
mesh, matrices and projection are a few hundred lines in
[`terrain3d.mjs`](terrain3d.mjs), tested in Node and emitted into the page the
same way the measuring and lane arithmetic are, so the mesh the browser drapes
and the mesh the tests measure cannot drift. Elevations travel quantized to
two bytes a sample (millimetre error against 3DEP's own tenth-of-a-metre), and
tiles come through the server's own cache like every other tile. Like Terrain,
it needs real 3DEP coverage; a view without any says so instead of rendering a
guess.

#### 3D in the woods

Press **Save offline** and the ground is saved with the tiles: the elevation
grid the mesh is built from, and the imagery the 3D drapes. One save covers
three different ways of being disconnected, because each layer keeps its own
copy:

- **The cabin** — server up, internet down. The elevation grids live in the
  server's database forever once fetched, and when USGS is unreachable the
  server answers with the saved ground that covers the spot rather than a 502,
  saying so in the note.
- **The woods** — no server at all. The service worker on the phone caches
  every terrain answer it has ever carried, and replays the newest one whose
  bounds contain the point being asked about — matching by *coverage*, not by
  URL, because the terrain URL carries the map centre at full float precision
  and no two pans ever produce the same one. The drape tiles were pulled
  through the worker at save time, so the imagery is there too.
- **Nothing saved** — the failure surfaces honestly. Ground invented from
  nothing would be worse than none.

Either fallback dates its answer ("the ground as saved Tuesday 7:41 pm"),
because saved ground passed off as live is how you trust a contour that is
not there.

## Map layers

The dashboard map has a Google-style type switcher in the bottom-left corner —
a thumbnail showing what you'd switch to, with the full set on hover or tap.
**Satellite is the default**, since imagery is far more useful than street
tiles for reading field edges, funnels and standing crops. The choice is
remembered per browser.

| Layer | Source | Max zoom |
| --- | --- | --- |
| **Satellite** (default) | Esri World Imagery | 19 |
| **Hybrid** | Esri imagery + place/boundary labels | 19 |
| **Map** | OpenStreetMap | 19 |
| **Terrain** | USGS Topo | 17 |
| **LiDAR** | USGS 3DEP bare-earth hillshade, rendered on demand | 17 |

Zoom is clamped per layer, so switching to a shallower layer doesn't leave you
staring at blank tiles past its coverage.

Zooming is built to stay under control (2026-08-29, after the map kept ending
up on the whole hemisphere). The wheel **accumulates** — a light trackpad
flick used to be one whole level per event, dozens per flick — and every zoom
holds the ground under your cursor still, so zooming in walks toward what you
are pointing at instead of sliding away from it. On a phone, **pinch** zooms
(two fingers used to fight the pan and throw the map around, which was
usually how it got lost in the first place), and **double-tap** steps in one.
When the view is lost anyway, the **⌂ button** under the zoom controls is one
press back to your ground.

### LiDAR

The **LiDAR** layer is the bare-earth hillshade the paid apps sell, from the
same free USGS 3DEP the Terrain button already reads — but browsable: pan
anywhere and the ground texture is simply there, no button to press. On it a
two-foot ditch, an old logging road, a knob a deer beds behind all read at a
glance, under canopy the satellite cannot see through. **LiDAR shade** in the
overlays list is the same rendering laid over the imagery instead of replacing
it, so the draw and the standing corn read together.

Three honest notes. The shading is **stretched to each rendered window's own
relief** — that is why flat sand country shows its two-foot draws at all
(a fixed hillshade paints it solid white; measured) — so grey levels are
relative: compare shapes within a view, not brightness across views, and
expect a faint tone step at the odd tile edge. Tiles are **rendered on
demand by USGS**, so the first look at new ground takes seconds; every tile
is then cached like the rest, offline included. And it needs 3DEP coverage,
which most of the country has and not every corner does.

This layer is for *scanning* ground by eye. The **Terrain** button is still
the analysis: it fetches the actual elevations and finds the draws, ridges,
saddles and benches, names them, and feeds the stand suggester and 3D view.

Google's own tiles are deliberately **not** used — serving them outside the
Google Maps API breaches their terms. Esri's imagery is free for this with
attribution and was measured to z19 over rural Wisconsin. USGS imagery is
sharper where it exists but 404s above z16 there, so it isn't the default.

Tiles that fail to load are hidden rather than left as broken-image icons: the
map still lays out correctly with no connection, and the camera pins — the part
that matters — are drawn from local data either way.

## Roadmap

The end goal is pattern analysis: individual bucks, movement against weather and
season, and stand recommendations grounded in what actually happened. That work
is gated on sighting data.

| | Status |
| --- | --- |
| Camera locations, status, health | **Working** |
| Offline map dashboard | **Working** |
| Hunt planner — rut, weather, evidence tiers | **Working**, no sighting data required |
| Stand choice from your own photos | **Working** once photos exist — refuses below 10 matched camera-hours |
| Photo download and paging | **Working** — first real run 2026-08-29 found and fixed the one path bug |
| Sighting log — deer per camera per hour | **Working** — the review screen, with the camera's own AI guess offered as a suggestion; only what a person confirms counts |
| Individual buck identification | **Working, by hand** — name a buck in review and every later tag is one click. Assisted matching stays future work; automated re-identification from trail-camera images is not a solved problem |
| Movement vs. weather, learned from your ground | Blocked: needs a season of sightings |
| Stand recommendations from observed patterns | Blocked: needs all of the above |

### It writes to the dashboard

`hunt-planner.mjs` saves `spypoint-data/plan.json` and rebuilds
`dashboard.html` with a **Best sits ahead** section at the top — so there is one
page to open, not a console to read:

```powershell
node hunt-planner.mjs
start $HOME\TrailCam\spypoint-data\dashboard.html
```

The two tools can be run in either order. A sync carries the last plan forward
instead of wiping it, and the planner rebuilds the page around your existing
cameras and photos. A plan older than 12 hours is labelled as stale on the page,
since a forecast goes off quickly.

Cameras on one property share a forecast, so ranking each separately would fill
the list with the same morning repeated once per camera. Sits are collapsed to
one row per window, keeping the best-scoring camera and naming the others.
