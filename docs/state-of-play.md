# State of play — 2026-08-27

Written so a fresh session (or a future you) can pick this up cold. What works,
what does not, what is next, and what is still unverified.

Design decisions and their reasoning are in [`design.md`](design.md). This file
is *status*; that one is *why*.

---

## Working, verified

| | Verified how |
| --- | --- |
| **SpyPoint sync** — cameras, status, photos | Live, against a real 4-camera FLEX-M account |
| **SQLite store** — cameras, photos, detections, bucks, properties, stands, weather | 100 tests; sync verified end-to-end against a stand-in API |
| **Local server** — dashboard served from the database, LAN-reachable | Tests including raw-socket path-traversal checks |
| **Map** — satellite / hybrid / street / terrain, pan, zoom, offline-tolerant | Driven in a real browser |
| **Stands** — drop, name, type, move, delete, good-winds | Browser-verified: pin saves 0 m from the click |
| **Parcel ownership** — click for owner, acres, class, county, mailing address | Live against the Wisconsin service at a real camera |
| **Hunt planner** — ranks sits by rut, fronts, pressure, wind, rain, moon | Unit-tested; live forecast fetch verified |

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

## Unfinished research

**Public GPS collar datasets.** Spartan Forge trains its movement prediction on
university collar data; the question was whether comparable open data exists.
[Movebank](https://datarepository.movebank.org/) is the obvious repository and
its web front end responds, but its study API **timed out** from this
environment, so nothing was actually retrieved. Genuinely unknown whether
usable white-tailed deer datasets are published there under a permissive
licence. Not attempted beyond that.

## What the paid apps do that this does not

Measured 2026-08-27, so the comparison is grounded rather than remembered.

| Feature | onX / Spartan Forge | Here |
| --- | --- | --- |
| Land ownership | onX: 161.5M parcels nationwide | **Yes, Wisconsin only, free** |
| Trail-camera integration | onX: Elite tier only | **Native** |
| LiDAR / canopy-strip terrain | Both, prominently | No — would need a rendered tile service |
| Historical imagery | Spartan Forge: 10 years UAV | No |
| Offline maps | onX | No |
| Movement prediction | Spartan Forge: neural net on university collar data | **No, and cannot match it** — the planner is weather + rut + your own cameras, and says so |
| Pin sharing with partners | Spartan Forge | No |

The honest line on prediction: without collar data, anything fancier here would
be the same inputs in a better costume.

## Next, in order

1. **Photos land** → verify the download path against real images, then build
   the tagging screen (step 4). Burst grouping should pay immediately: the
   cameras fire two frames per trigger.
2. **Parcel boundaries drawn on the map**, not just a click-to-identify card —
   the visual that makes onX feel like onX. The service returns geometry;
   nothing else is needed.
3. **Finish the collar-data question** from a machine that can reach Movebank.
4. Moultrie, if a capture arrives.

## Things that will bite you

- Run node with `--disable-warning=ExperimentalWarning`; `node:sqlite` prints an
  experimental notice that makes a working tool look broken. The launcher does.
- The dashboard **file** (`spypoint-data/dashboard.html`) cannot save anything.
  Stands and ownership need the served page at `127.0.0.1:8787`. The file says
  so on its buttons rather than failing silently.
- Requesting a field the parcel layer lacks rejects the *whole* query with
  "Invalid query parameters". The published schema says `CNTYNAME`; the live
  layer has `CONAME`.
- `Number(null)` is `0`, and 0,0 is a real place in the Atlantic. Missing
  coordinates must be rejected before conversion, not after.
- Never edit a shipped migration — add another.
