# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read these before changing anything:

- **[`docs/state-of-play.md`](docs/state-of-play.md)** — what works, how each
  piece was verified, what is next. **Update its table when you finish a
  feature**, with how you verified it. It is written for a fresh session
  starting cold; keep it that way.
- **[`docs/design.md`](docs/design.md)** — settled decisions *and their
  reasoning*. Do not relitigate one without reading its entry.
- **[`README.md`](README.md)** — what the tool does, for the person using it.
  It is written in the repo's voice: plain sentences, judgement calls said out
  loud. Match it.

## This repository is PUBLIC — no real coordinates

A trail-camera fix is the location of somebody's hunting property. Fixtures,
defaults and tests use the invented 44.12 N / 90.65 W cluster (rural Jackson
County, WI — points at nothing). Real data lives only in the gitignored output
directory (`spypoint-data/` by default) on Kent's machine. Never commit a real
coordinate, and never point a fixture at one.

## Commands

```bash
node --test                          # the whole suite (~600 tests, ~2min). No install step — there are NO dependencies, ever (Node 22+, node:sqlite).
node --test test/coverage.test.js    # one file
node serve.mjs --out DIR --port 8787 # serve a dashboard from DIR's trailcam.db
node spypoint-sync.mjs               # sync (needs SPYPOINT_EMAIL / SPYPOINT_PASSWORD env; --dry-run, --inspect for schema dumps)
node hunt-planner.mjs --days 14      # rank the coming sits
```

Kent runs it via `start-trailcam.cmd` (Windows), which is sync → plan → serve.
The server bakes its git commit into the page banner and `/api/health`
(`build.commit`, plus `stale: true` when files moved after start) — use that to
confirm which code is actually running.

## Architecture

Flat `.mjs` modules at the repo root; no bundler, no framework, no package.json.

**Pages are assembled strings.** `serve.mjs` serves HTML that
`dashboard-page.mjs` (and `review-page.mjs`, `tonight-page.mjs`) compose as
template literals: markup, a `<style>` block, and ONE inline script per page.
`map-view.mjs` owns the entire map (markup/styles/script as exported text) and
the dashboard composes it in; the two share one script scope (`el`, `fmtDate`,
`plural`, `D` — the baked JSON state).

- `map-view.mjs` uses **String.raw**: no backtick may appear anywhere inside;
  `\uXXXX` inside emitted JS strings resolves in the browser (fine), inside
  emitted *markup* it never resolves (use HTML entities).
- `dashboard-page.mjs` is a normal template literal: `\u` escapes resolve at
  build time.
- `test/page-scripts.test.js` **compiles every page in a vm** — the failure
  mode is a build-time-resolved escape becoming a syntax error the module
  itself never shows. A new page needs a line there.

**One definition, emitted.** Arithmetic the browser needs (measuring, lane/wind
geometry, 3D mesh) is NOT retyped into page scripts: `measure.mjs`,
`coverage.mjs`, `terrain3d.mjs` each export `browserSource()` which serializes
the very functions Node runs, and tests compile the emitted copy and compare it
against the exports on the same inputs. If the map needs a formula, ship it
across this way; a second copy is how the picture and the model drift.

**Data layer** (`db.mjs`): one SQLite file per output dir. `MIGRATIONS` is an
append-only array — add version N+1, never edit an entry that has shipped.
Winds/lanes: a stand's huntable winds derive from its shooting lanes
(`coverage.mjs`; `windsForStand()` decides lanes-vs-ticked and says which);
blank means *unknown*, never "any wind" — several tests pin that refusal.

**Photo path contract:** `photos.file_path` is relative to `out/photos/`
(e.g. `East_Side/2026-08/id.jpg`, forward slashes, NO `photos/` prefix — the
serving route prepends it; migration 11 heals prefixed rows and
`test/sync-integration.test.js` pins the shape). The on-disk/static-page form
(`photos/…`) exists only at the download site and in `photos.jsonl`.

**Offline** (`offline.mjs`): a service worker — pages/API network-first,
`/tiles/` and `/photos/` cache-first, `/api/terrain` falls back to the newest
cached answer whose *bounds contain* the requested point (URLs carry the float
map centre, so exact matching never hits twice). Terrain grids also live
forever in SQLite server-side; tiles in a disk cache (`tile-cache.mjs`). The
offline test asserts the page contacts no external host — never point an
`<img>` or fetch at a vendor URL from a page.

## Verifying UI work

The bar in this repo is "driven in a browser with a real mouse", not "the test
matches the source text". `tools/cdp-driver.mjs` is a dependency-free CDP
harness for that: launch headless Chromium, load the served page, click, type,
screenshot, read state back. Look at the screenshots — several shipped bugs
(invisible cones, vanished panels) were only ever visible in one. Structural
tests on the emitted script text are the repo's pattern for pinning UI
decisions afterwards.

## Workflow

Work on a `claude/...` branch, push, open a **draft PR** with the verification
story in the body; Kent reviews and merges quickly, usually without comments.
After a merge, restart the branch from `origin/main` (`git checkout -B <branch>
origin/main`) rather than stacking on merged history. Update
`docs/state-of-play.md` (and README where behaviour changed) in the same PR as
the feature.
