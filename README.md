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

## Quick start

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

## Status

Verified against a real 4-camera FLEX-M account:

- Login, camera listing, and every field above — **working**.
- Photo download and paging — **untested against real photos**. The test
  account's cameras had been offline for months, so the list was legitimately
  empty. The code mirrors the community clients but has not yet moved a real
  photo.
