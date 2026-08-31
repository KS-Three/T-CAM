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

### Wind is recognized locally, against your own empties (settled 2026-08-29)

Kent asked for auto-recognition — people, animals, wind — with confidence,
shown on the photo previews. The split that settles it:

- **People and animals come from SpyPoint's AI**, which already tags them and
  is ingested as claims. Their API carries **no confidence number**, so the
  previews say "camera thinks: buck" in words — an invented percentage would
  be a lie wearing precision. If a real score ever shows up in the raw photo
  JSON (`--inspect` would reveal it), surfacing it is easy.
- **Wind — the empty frame — is the one class recognized here**, because it
  is the class the vendor stays silent on and the majority of what a camera
  sends. No model: a frame is fingerprinted (dHash, 256-bit) and matched
  against frames YOU reviewed as empty on that camera. The confidence shown
  is that measured match. The baseline grows with every "nothing here" press,
  it is per camera, and night frames simply match other night frames.
- **The browser does the hashing.** Pixels need a JPEG decoder; Node has none
  and zero-dependencies is not dying for one, while every browser ships one.
  The review screen hashes each frame on a canvas as it loads and posts the
  hash; the server only stores and compares.
- **Hash size was measured, not copied.** The classic 9×8 dHash let an
  animal-sized blob covering 15% of the frame move TWO bits of 64 — inside
  any usable gate, so a deer frame matched the empty baseline in the browser
  drive. At 17×16 (256 bits) the same blob rewrites dozens of bits while
  exposure drift still moves none. The gate is 12 bits — under 5% — because
  the cost of a miss is one more frame reviewed by hand, and the cost of a
  false match is a deer suggested away.
- **A person's call always wins.** A confirmed detection anywhere in a visit
  removes it from the baseline; the wind line reads "N agrees — your eyes
  overrule"; and nothing is ever auto-marked.

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

### Owner search is statewide and capped (settled 2026-08-31)

"Who owns this?" answers about a place. The other half of the question is about
a NAME: the neighbour who gave you permission on forty acres, and where else
that name owns ground worth asking about. Same layer, same privacy stance,
opposite direction — a query about a person rather than about a point, which is
what the calls below are about.

- **Statewide, not scoped to the county or the view.** The whole value is
  finding the OTHER ground a name owns, which is by definition somewhere you
  are not currently looking. County scoping was considered and dropped: it
  keeps result counts down, but it fails the one question the feature exists to
  answer. Largest first instead, because acreage is what makes a row worth
  reading — a hunter scanning "SMITH" wants the 300-acre block, not the town
  lot.
- **Fifty rows is the cap, and the cap is part of the feature.** Not a
  performance detail: fifty is a look-up, ten thousand is a mailing list, and
  the difference matters on a layer carrying home addresses. `limit` can ask
  for fewer and cannot ask for more. One row beyond the cap is requested so
  truncation is KNOWN — a list that stops silently at fifty reads as "these are
  all of them", which for a common surname is a lie.
- **Nothing is stored, same as the point lookup.** Results live in memory for
  an hour and die with the process. There is no bulk export, and no way to walk
  the layer through this endpoint.
- **Typed names are filtered to a name's alphabet, not escaped.** Everything
  outside `A-Z 0-9 & . , ' -` is dropped before the WHERE clause is built,
  which kills injection at the source and also removes the LIKE wildcards `%`
  and `_` — typed by accident, those turn a search for a person into a scan of
  the state. The apostrophe stays, because O'Brien is a name, and is doubled in
  the clause.
- **Boundaries ride with the list.** Each row carries its own generalised rings
  (about five metres, invisible at parcel scale), so clicking a result draws
  and frames it with no second request. The map is framed on the boundary
  itself, which is why a town lot and a 300-acre block each fill the screen.

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

### A suggestion has to survive four filters, and three of them drop (settled 2026-08-31)

The suggester's first real outing produced five spots: three standing on a
state highway, two in somebody's yard, and none of them on the property Kent
was looking at. Every one of those was a separate hole, and the reasoning
behind each patch matters more than the patch.

- **"Your ground" is a set of PARCELS, not an owner's name.** The first version
  took the commonest owner string under your stands and kept anything matching
  it. That works until it meets a real account: one property deeded to a person
  and the other to that same person's revocable trust is two owner strings, one
  vote each, and a tie-break silently decided which of the two properties the
  tool believed in. Now the anchors' parcels are collected whole — id, owner
  and boundary — and a candidate is on your ground when it falls *inside* one
  of those shapes. That answer costs no request and compares no strings; a
  parcel is a shape on record, and a shape either contains a point or does not.
  Owner name survives only as a fallback for matching a parcel next door.

- **"No parcel here" is an answer; "the service did not reply" is not.** These
  were one branch, and both were kept-and-flagged. But the state parcel layer
  covers the whole state — its gaps are highway right-of-way, rail corridor and
  open water, which is precisely why three suggestions could stand on Highway
  21 wearing a note nobody read. The layer *answering* that there is no parcel
  now drops the spot. The layer *failing to answer* still keeps it and flags
  it, because dropping on a hiccup would hide good ground silently, and that
  refusal is the older decision and still the right one.

- **Ownership is not habitability.** One of the two real properties carries property class
  1 alongside 4/5/5M: it is Kent's ground *and* there is a house on it, so no
  ownership test can ever exclude the yard. That needs a different question,
  asked of a different source — OpenStreetMap, for buildings and classified
  roads (`builtup.mjs`). Two judgement calls in it, both parameters: 120 m off
  a building, 60 m off a road. And `service`, `track`, `path` and `footway` are
  deliberately NOT roads — a two-track through the woods is where you want to
  be, and treating farm lanes as highway would refuse the best ground on an
  agricultural property. A spot that fails this is dropped, not marked down: a
  stand eighty metres off the blacktop is not a worse stand, it is not a stand.

- **Anything off the screen is left out.** The endpoint worked a fixed circle
  around the map centre whatever the zoom, so at hunting zoom most of its
  answer was beyond the edge and arrived as a pin you had to go looking for.
  The map now sends its bounds. The clip runs FIRST, before any lookup, so
  every spot it removes is a parcel query not spent.

- **The boundary is fetched BEFORE generating, not after.** With all four
  filters in and the generator still working the whole circle, the two real
  properties came back with one suggestion and zero: a terrain radius is a
  circle, a property is not, and on a twenty the circle is four-fifths the
  neighbour's, so the shortlist was spent on ground certain to be thrown away.
  The parcels under your pins are now resolved once, up front, and the
  landforms are narrowed to the ones inside them before any wind is paired with
  anything — same lookups, used twice. It restored the same two requests to
  five suggestions and three. Two guards on it: an anchor filter that empties
  the list is *ignored* rather than obeyed, because "no landforms on your
  ground" and "nothing to say" look identical on a map; and the per-candidate
  ownership check still runs afterwards, so a parcel you own next door — with
  no pin on it, therefore not in the boundary set — is still found.

**And the suggester — alone — scopes to one ground.** This is the per-property
filtering the grounds entry above says is a new decision rather than a default,
so: it applies to `/api/suggest-stands` and nothing else. The planner and
/tonight still rank across both lands, because "the best sit tonight is at the
other place" is a real answer. "Hang a new stand here" is not — it is a
question about one property, and answering it with every pin you own is what
let a stand forty kilometres away decide whose ground this one is.

### Which property is ASKED, never inferred (settled 2026-08-31)

The four filters above all worked, and the feature still opened wrong. Driving
it in a browser: the map's default view frames everything, which on two
properties forty kilometres apart is a centre sitting in open country between
them. `groundAt` correctly answered "neither" — and the code then fell back to
every stand you own and let the owner vote pick a deed. The first press a
person makes returned zero suggestions, judged against a property nineteen
kilometres away. The bug the parcel work existed to kill, alive again in the
one view the app opens on.

There is no better inference available. Between two properties the honest
answer really is *neither*, and any rule that produces a property from that
position is guessing. So the question moved to the person:

- **`/api/my-properties`** enumerates what you hunt — the same proximity
  clusters the map's switcher shows, plus the real parcels under their pins:
  owner, acreage, county, and the boundary rings. Still nothing configured.
- **The picker asks once and remembers.** Ticking a property outlines it on
  the map before anything is searched, so the ground the tool is about to
  reason over is a shape you can look at. Shift-click reopens it.
- **A refusal is a first-class answer.** With no selection and a map centre
  over nothing, the endpoint returns `needsProperty` and the list — it does
  not guess, and it does not silently return an empty shortlist either.
- **Labels come off the deed.** `describeGround` says what is *on* a ground,
  and two properties hunted the same way describe identically — a picker whose
  two rows both read "2 cameras, 1 stand" is not a picker. Acreage and county
  distinguish them ("38 acres, Jackson County").

Two consequences worth stating, because they reverse earlier decisions here:

- **The search circle is derived from the property, not the map.** Centre and
  radius come from the parcel boundary (the pins' extent when there is no
  parcel). A fixed radius around the map centre made the answer depend on the
  zoom, which is how framing a property at zoom 18 — a window smaller than the
  search radius — turned three suggestions into one.
- **The viewport no longer filters.** It is still sent, and the answer still
  counts what is off the edge, because a pin you cannot see reads as the tool
  ignoring you. But you said which property you meant, and a spot on it is on
  it whatever the zoom happens to be. Clipping to the screen *and* scoping to
  the property was two answers to one question.

None of this upgrades the caveat. These are still places to go and WALK: OSM is
incomplete, the parcel layer is a tax record rather than a survey, and nothing
here knows whether there is a tree.

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

## 11. Decoding GeoTIFF: allowed, because the reason not to was wrong

Two places in this repo had already refused to decode raster imagery.
`terrain.mjs` says a point-sampling service "is a gift — decoding GeoTIFF or
LERC would mean a dependency, and this project has none". `cropscan.mjs` says
tracing field outlines out of the CDL raster would be "hundreds of lines to
save the eight clicks an outline takes".

The second is still true and nothing here changes it. The first was **wrong
about GeoTIFF**, and the difference is worth writing down rather than
rediscovering.

Probed against the live Sentinel-2 bucket on 2026-08-31, an L2A band is:

    10980x10980, uint16, 1 sample/pixel, tiled 1024x1024, 121 tiles
    compression 8 (Adobe Deflate), predictor 2 (horizontal differencing)

Deflate is `node:zlib`. The predictor is a running sum along each row. The tile
index sits in the header, so a few acres cost one range request for the header
and one per tile actually touched, not the 120 MB the image weighs. That is
`cog.mjs`, about 180 lines, and **zero dependencies survives** — the
double-click launcher is untouched. LERC would still mean a dependency, and
3DEP is still sampled as points rather than decoded, so `terrain.mjs` keeps its
approach for good reasons.

**What actually justified the change** was not the line count but that there is
no alternative. Terrain could dodge rasters because USGS samples points for
you; imagery has no keyless equivalent — Esri's Sentinel-2 ImageServer serves
metadata anonymously but will not answer pixel queries, and everything else
wants an account. Refusing to decode meant refusing the feature.

**The cost, stated plainly:** this is the first binary format the project
parses, and a reader tested only against fixtures the tests themselves wrote
proves only that it agrees with that writer. Hence `check-crops.mjs`, which
runs the real path against the real bucket, and a cross-check against an
independent implementation — `cog.mjs` reads NDVI 0.8268 at a point where
rasterio reads 0.8200 as a block mean.

## 12. A crop scan reports; it never edits the field

`fields.crop` and `fields.cut_at` are Kent's. A satellite scan is an opinion,
and it lives in its own table (`field_scans`, migration 17) where it can sit
beside the record and disagree with it out loud.

This is the rule the map has followed since crop fields were added — the CDL
pre-selects a crop for a NEW outline and never touches a choice already made —
extended to the case that rule did not cover: a background job that could
rewrite the column later. It is also §4's argument about buck identity applied
to ground instead of animals. A wrong classification that silently overwrites
an entered fact corrupts everything built on it, and the entered fact was
right.

**What this costs:** the feature cannot be fully automatic, which is what was
originally asked for. Kent still confirms. That is the trade, taken knowingly.

**What is honestly weak.** Corn and soybeans separate strongly in NDVI —
measured near Ames, Iowa for 2025, a 0.40 gap on 19 June and 0.26 on 28 August,
indistinguishable in mid-July — but reading that separation needs local fields
of a known crop to calibrate against, and this property has almost none. A 2 km
sample came back 40% woody wetland, 16% corn and **4% soybeans**: one soybean
point in twenty-five. So crop identification is off by default, refuses when it
cannot calibrate, and says why. Harvest detection needs no reference data at
all — a field is compared against its own peak — and is the reason the feature
is worth having on this ground.

**A harvest and a hard drydown look identical in one number.** They are
separated by how fast the fall happened, which is only knowable when two clear
looks sit close together. When cloud has left a three-week hole the answer is
`cut-or-senesced`, and it says so. Every state also carries how stale it is: on
Kent's own ground the last three passes were all clouded out, so "standing" was
really "standing as of sixteen days ago", and a field can come off in a
morning.

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
