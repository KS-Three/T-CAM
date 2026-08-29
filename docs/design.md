# TrailCam design decisions

Settled 2026-08-27 by working through the open questions one at a time. Each
entry records the call **and the reasoning**, because the reasoning is what
tells a future reader whether a decision still holds when circumstances change.

Where a decision was reversed during that discussion, the reversal is kept —
the discarded option is usually the tempting one, and knowing why it was
dropped is worth more than a tidy list.

---

## 1. Scope: local, multi-account

One machine, no server, no hosting, no login system. `accounts.json` (gitignored)
holds several `{provider, label, credentials}` entries — Kent's SpyPoint, friends'
Moultrie — and everything syncs onto one map.

**Why not hosted:** running a service means custody of other people's camera
passwords and the GPS coordinates of their hunting spots, plus auth, sessions and
a security posture. A large obligation for a personal tool, and the local path
already works.

## 2. Storage: SQLite via `node:sqlite`

One `trailcam.db` for cameras, photos, detections, tags, properties and weather.
JPEGs stay as files on disk; raw API JSON is kept alongside for forensics.

Node 22+ ships `node:sqlite`, so **zero dependencies survives**. Verified working
(queries, aggregates) before committing to it. It emits an `ExperimentalWarning`
that should be suppressed so the tool doesn't look broken.

**Why not flat files:** honestly, at 4 cameras over a season — maybe 5–20k photos
— JSONL in memory would work. SQLite wins on the two things that matter here:
the questions are joins ("which bucks moved on a north wind in the pre-rut"), and
the data Kent *adds* — naming a buck, correcting a species — needs safe updates,
which append-only files handle badly.

## 3. Sighting grain: animal-in-photo

A `detections` table: `photo_id`, `species`, `count`, `individual_id` (nullable).
One photo can hold "2 does + 1 spike" as separate rows. Seeded automatically from
the camera AI's species tag as a single row, refined by hand only where it matters
— i.e. for bucks.

**Why not photo-level tags:** a photo-level tag physically cannot express two
different bucks in one frame, so buck identity would need this layer added later
anyway — after a season of data had already been recorded the other way.

### The camera's tag is a suggestion, never a sighting (settled 2026-08-29)

The first real photos surfaced the shape of this. SpyPoint's AI tag is stored
as an unconfirmed `camera-ai` detection, and the review screen showed it
exactly like a human tag — so a visit arrived looking already tagged, Enter
felt natural, and the guess stayed unconfirmed for ever. Unconfirmed means
invisible to the stand ranking, correctly; the trap was that nothing invited
the person to turn the guess into evidence.

The decision, in three parts:

- **Agreeing writes YOUR tag; the claim is never promoted.** Y (or a click)
  creates a manual confirmed detection. The `camera-ai` rows stay behind,
  unconfirmed and unedited — they are the record of what the vendor's AI
  said, which is what a later "how often is it right here" question needs.
  Confirming the machine's row in place would erase the distinction between
  "the machine said deer" and "I saw a deer" in the one place it is kept.
- **The vendor's vocabulary maps only where it cannot be wrong.**
  `VENDOR_SPECIES` in `db.mjs` knows `buck` means deer (antlered is a
  judgement, recorded by naming the buck, not a species); a word it does not
  know is shown verbatim with no one-key agreement. SpyPoint's vocabulary is
  undocumented, so guessing a species from an unrecognized word would put a
  claim in the machine's mouth. The table grows one confirmed word at a time.
- **Claims group at visit grain, by mapped species.** The camera tags every
  frame, so one deer arrives as six claims; six agree-buttons would count six
  animals for one. One button per species is one animal to agree about — the
  same grain everything else tags at.

## 4. Buck identity: named by hand, assisted by grouping

Kent creates a buck ("Split G2") and assigns it. The tool makes that fast:

- **Burst grouping.** Cameras are set to multiShot 2, so every trigger yields two
  photos; photos within a few minutes at one camera are one visit and get labelled
  once.
- **Perceptual hashing** (pure JS, no dependencies) to collapse near-identical
  frames.
- **Ranked one-click buttons** — bucks named recently at nearby cameras first.

Assistance speeds up the eyes; it never proposes an identity.

### Reversed twice, and why the final answer is right

Automated matching was chosen, then dropped once costed, then challenged again
with a specific proposal (SAM 2 / a local antler recognizer). That challenge is
what settled it:

- **SAM 2 segments; it does not identify.** It outputs a mask — "here is the
  antler" — with no notion of *which* animal. Every serious animal re-ID pipeline
  pairs it with a separate embedding model (DINOv2/DINOv3).
- **Even done properly it drifts.** A 2026 livestock paper using the newer SAM 3
  with DINOv3 reports identity switches around one per 500 frames per animal at
  >92% tracking accuracy, which "accumulate into materially wrong per-individual
  daily-budget statistics." That is the exact failure mode to avoid — and it is
  the *favourable* case: video at 5 Hz with motion continuity, versus stills, at
  night, in IR, from arbitrary angles.
- **The economics invert the argument.** A cloud-vision assist would cost roughly
  1¢ per comparison, about **$2 a season**, when limited to comparing a new
  sighting against recently-seen named bucks. The local pipeline needs Python,
  PyTorch and model checkpoints — ending zero-dependency and the double-click
  launcher — and is weeks of work to save that $2, with a real chance it never
  becomes trustworthy.

A wrong identity silently corrupts every movement pattern built on it. Manual is
slower and always right.

## 5. App shape: local web server

`node serve.mjs` on Node's built-in `http` — still zero dependencies, still
entirely on the PC, bound so a phone on the same Wi-Fi can reach it. It serves
the dashboard and the review screen, and writes tags to SQLite.

**Why a server at all:** a static HTML file cannot write to disk. The moment
tagging exists, the current architecture stops working.

The data layer sits behind a **small HTTP API**, deliberately, so a later phone
app talks to the same interface instead of forcing a rewrite. That costs nothing
now.

## 6. Remote access: deferred, gated on the rest working

A domain and a phone app come **last**, and only if the whole thing proves out.

The shape it should take when it arrives — a **hosted mirror** — is worth
recording now: the PC keeps doing the syncing, so camera passwords never leave
it, and only the *result* (cameras, photos, tags, plan) is pushed up. A breach
then exposes photos and pin locations, not anyone's account.

**Why not a Tailscale tunnel instead:** it depends on the laptop being awake, at
home, with the server running — which for a laptop is not most mornings.

## 7. Weather: full hourly table, including the quiet hours

Every hour, every camera location, all season — temperature, pressure, wind,
rain, moon — stored whether or not a photo exists. Detections link to an hour.
Open-Meteo's archive is free and backfills decades.

**This is the decision the analysis depends on.** Recording weather only for
photos that exist means every hour in the dataset contains a deer, so nothing can
be learned about the hours that don't. The quiet hours are the control group;
without them, any "pattern" is an artefact.

## 8. Bucks are global; cameras belong to properties

Bucks are top-level records. Cameras belong to a property ("Home 40", a friend's
place). A sighting links a buck to whichever camera saw it, so one buck can appear
on Kent's ground on Tuesday and a friend's two miles away on Thursday.

**Why:** deer ignore property lines, and cross-property movement is the most
valuable thing this dataset could surface — and it is invisible if identity is
walled off per property. The cost is that Kent's naming judgement is authoritative
across everyone's cameras.

### Grounds are discovered, named once (settled 2026-08-29)

Two hunting lands made the map's frame-on-everything open at a zoom where each
parcel is a speck, so the map got a switcher — and the design question was how
things end up belonging to a property at all.

- **Geography decides membership, not forms.** A "ground" is a cluster of
  everything placed, at a 2 km walking-distance gap (single-linkage, so a long
  skinny property chains into one piece). A stand dropped on the far parcel
  next week is in the right ground because it is THERE. No stand, marker, or
  camera form grew a property picker; a field filled in by hand on every save
  is busywork, and a field nobody fills is a lie.
- **Naming is the one deliberate act.** An unnamed ground is honestly labelled
  by its contents ("2 stands"); typing a name creates the `properties` row and
  assigns exactly the members that were on screen. Labels afterwards come from
  members' own property names, majority-wins, so one stray row cannot relabel
  a ground and new unassigned pins cannot unlabel one.
- **The switcher frames; it does not filter.** Pins elsewhere stay drawn, and
  the planner and /tonight keep ranking across both lands — you can drive to
  either, and "the best sit tonight is at the other place" is exactly the kind
  of answer this tool exists to give. If per-property filtering is ever wanted,
  it is a new decision, not a default.
- Two properties across the road from each other merge into one ground. That is
  accepted: ground you can walk between is one hunt, and the frame covers both.

## 9. The planner answers WHEN; the sightings answer WHERE

This is the decision the discussion improved most, and the reasoning is worth
keeping because the first analysis was wrong.

**The objection that was raised, and why it only applies to time.** Fitting the
planner's factors to observed sightings looked statistically hopeless: there is
one rut per season, so rut phase and calendar date are perfectly confounded. If a
cold front lands on 8 November and produces forty sightings, nothing can separate
"cold front" from "peak rut" from "that Tuesday" — several factors are
unidentifiable in principle, not merely noisy, until multiple seasons pull them
apart.

**Why that objection does not touch the useful case.** The question actually worth
asking is not "what weather makes deer move" — it is *"it's raining this
afternoon, which stand should I sit?"* That is a comparison **between cameras
during the same weather**, and every camera experiences the same rain at the same
moment. Rut phase, date, moon and pressure are therefore held constant across the
comparison automatically. The confounding that wrecks time-based fitting does not
apply to camera-versus-camera at all, and the comparison is sound even in the
first season.

So the two halves answer different questions and can be combined without
contaminating each other:

- **WHEN** — which afternoon is worth sitting. Pure published behaviour. Observed
  data never enters this scoring.
- **WHERE** — given those conditions, which stand has actually produced. Purely
  observed data, per camera.

Together: *"Rain this afternoon — hunt the stand near camera A."*

### The evidence bar

A recommendation is never given as a bare verdict. Every stand ranking carries its
counts inline:

```
Camera A — 7 buck sightings in 22 rain-hours
Camera C — 1 buck sighting in 19 rain-hours
```

Below a threshold of comparable hours (start at 10), a camera is not ranked at all
— it reads "not enough rain data at this camera yet" rather than producing a
number from nothing.

**Why show counts rather than apply a significance test:** with one season most
genuine differences will not clear a formal bar, so a strict test would answer
"no significant difference" almost every time — technically correct and useless in
year one. A hunter reading his own ground will judge 3-versus-1 correctly when the
raw counts are in front of him; a bare "hunt A" hides that it rests on almost
nothing.

## 10. Build order: evolve in place, never break it

Each step ships working:

1. SQLite layer alongside the current files
2. Sync writes to the database
3. Local server serves today's dashboard from it
4. Review and tagging screen
5. Analysis

The double-click launcher keeps working throughout. If work stops halfway there
is still a usable tool.

**Why it matters here specifically:** there are still zero photos, so everything
downstream of tagging is untestable until cameras are transmitting again. Building
it behind a working product means the untested half is never the only thing that
exists.

---

## What is still unverified

Honesty about the gaps, so nobody reads this as a status report:

- **No photos exist.** The account's cameras have been silent for ~9 months.
  Photo download, paging, tagging and every analysis feature are unexercised
  against real data.
- **The phone app is a stated intention**, not a design. Only its constraint —
  credentials stay home — is settled.
- **Moultrie is not implemented** and is blocked on a session capture. See
  `moultrie-capture.md`.
