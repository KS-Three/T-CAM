# TrailCam

Sync your SpyPoint trail cameras to your own machine: **where each camera is**,
**how it's doing**, and **what it photographed** — plus an offline dashboard
with a map, so you can see all of it at a glance without the app.

Zero dependencies. One file. Node 20+.

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

```powershell
# Windows PowerShell — one line at a time
cd $HOME
curl.exe -L -o spypoint-sync.mjs https://raw.githubusercontent.com/KS-Three/TrailCam/main/spypoint-sync.mjs
$env:SPYPOINT_EMAIL = "you@example.com"; $env:SPYPOINT_PASSWORD = "your-password"
node spypoint-sync.mjs
start $HOME\spypoint-data\dashboard.html
```

On macOS or Linux, `export SPYPOINT_EMAIL=...` and `open`/`xdg-open` instead.

Credentials are read only from `SPYPOINT_EMAIL` and `SPYPOINT_PASSWORD`. They
are never written to disk, never logged, and never stored in this repo.

## Commands

| Command | What it does |
| --- | --- |
| `node spypoint-sync.mjs` | Full sync: cameras, photos, dashboard |
| `node spypoint-sync.mjs --dry-run` | Lists cameras and what *would* download. Writes nothing |
| `node spypoint-sync.mjs --inspect` | Dumps the raw API field names for one camera and one photo |
| `node hunt-planner.mjs` | Ranks the next two weeks of sits at your camera locations |

| Flag | Meaning |
| --- | --- |
| `--out DIR` | Output directory (default `./spypoint-data`, or `$SPYPOINT_OUT`) |
| `--max N` | Max new downloads per camera per run (default 500; `0` = unlimited) |
| `--limit N` | Photos per API request (default 100) |
| `--size S` | `large` (default) / `medium` / `small`; falls back downward |
| `--cameras A,B` | Only cameras whose name or id contains one of these |
| `--quiet` | Errors and final summary only |

## Output

```
spypoint-data/
  dashboard.html      map + camera cards + photo grid, opens offline
  cameras.csv         location, battery, signal, temperature, memory, plan, last seen
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
- **A camera only has photos while it's transmitting.** Cameras silent for more
  than 30 days are flagged before the sync runs, because an empty result from a
  dormant camera is the expected outcome, not a failure.
- **Be gentle.** Requests are paced (~250 ms between API calls, ~150 ms between
  downloads) with no retry storms. Hourly is plenty — cameras only upload a few
  times a day on their own schedule.

## Hunt planner

```bash
node hunt-planner.mjs                            # uses your synced camera locations
node hunt-planner.mjs --days 14 --json plan.json
node hunt-planner.mjs --lat 44.1 --lng -90.6     # works with no sync data at all
```

Pulls a real forecast for each camera's coordinates and scores every morning
and evening sit for the next N days, ranked, with the reasoning printed:

```
  PRIME   58  Thu, Nov 5 AM (from 5:21 AM)  North Ridge
         28°F, wind NW 9 mph, Seeking
         +24  Seeking — bucks cruising for the first does
         +14  temperature 21°F below yesterday — strong cold front
         +8   pressure rising 0.19 inHg — front clearing
```

### What the score is built from

Additive and deliberately transparent, in rough order of effect size:

| Factor | Why |
| --- | --- |
| **Rut phase** | Photoperiod-driven, so the dates barely move year to year. The calendar in the source is for ~43–45°N (Wisconsin); further south it all slides later |
| **Temperature drop** | A day-over-day fall in the high is the most reliable non-rut trigger. A warm-up scores negative |
| **Barometric trend** | Rising behind a departing front is the classic signal; a steep fall means deer sit it out |
| **Wind** | A curve, not more-is-better — a steady breeze is cover, dead calm pools your scent, a gale shuts movement down |
| **Rain** | A drizzle is fine and quiets the woods; a downpour ends the sit |
| **Cloud cover** | Low light stretches the morning window |
| **Moon** | Included, weighted small, and labelled as such — solunar theory is genuinely contested and the effect is minor next to a front or the rut |

Out of season the weather cannot rescue a date, so those sits are capped —
otherwise a flawless August morning outranks a windy day in the rut. The cap
appears as a printed reason rather than being applied silently.

### What it is not

**It knows nothing about your deer.** It has never seen a photo. It does not
know which buck uses which trail, where anything beds, or what happened on your
ground last November. It ranks *when* the weather and calendar favour a sit; you
still choose *where*, and the wind direction is printed for every sit so you can.

Every factor is published whitetail behaviour, not a pattern learned from your
cameras. Once photos accumulate, those sightings can be scored against these
same factors to find which ones actually predict movement on your ground — and
at that point the evidence should correct this model, not the reverse.

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

Zoom is clamped per layer, so switching to a shallower layer doesn't leave you
staring at blank tiles past its coverage. Scroll wheel zooms; drag pans.

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
| Hunt planner — weather, rut, moon | **Working**, no sighting data required |
| Photo download and paging | Written, **never run against real photos** |
| Sighting log — deer per camera per hour | Blocked: needs photos |
| Individual buck identification | Blocked: needs photos. Realistically manual tagging with assisted matching — automated re-identification from trail-camera images is not a solved problem |
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
