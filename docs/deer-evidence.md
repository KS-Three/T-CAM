# What the evidence actually says about deer movement

Every coefficient in `movement-model.mjs` traces to a row in this file. If a
number is in the code and not here, it is a guess wearing a lab coat and should
be deleted.

Written 2026-08-30 from a literature pass. The point of the exercise was not to
confirm what the planner already did — it was to find out where the planner was
repeating hunting-magazine folklore. **It was, in four places.** Those are
flagged below and the code now disagrees with its own former self.

---

## How to read the confidence column

| Tier | Means |
| --- | --- |
| **A** | GPS-collar or fetal-aging data, peer-reviewed, effect size published, and the study is at a comparable latitude / land use |
| **B** | GPS-collar or peer-reviewed, but southern latitudes, small n, or the effect is reported as a direction without a magnitude |
| **C** | Extension-service or research-organisation summary of collar work; numbers quoted second-hand |
| **D** | Hunting-industry compilation, logbook aggregation, or received wisdom with no traceable study. **Scores zero in the model.** |

A tier-D row is kept rather than deleted because the planner used to score
several of them, and someone will propose adding them back.

---

## 1. The rut, at this latitude — the strongest evidence we have

This is the one place where a study exists on *nearly the same ground*, and it
is the reason the rut calendar moved.

**Hunsaker et al. 2025, "The Breeding Season and Movement Ecology of Male
White-Tailed Deer in Southwest Wisconsin", *Ecology and Evolution*.**
188 collared males meeting analysis requirements (of 1,157 deer captured),
Dane / Iowa / Grant counties, Wisconsin, 2017–2020. GPS fixes **hourly during
the rut**, every 4 h otherwise; high-intensity window 15 Oct – 1 Dec. Age
structure 104 yearlings, 64 two-year-olds, 64 aged 3+.

| Finding | Number | Tier |
| --- | --- | --- |
| Peak rut, by changepoint analysis on movement rates, range sizes **and** conception dates independently | **23 Oct – 12 Nov** (start 23–27 Oct, end 9–15 Nov across analyses) | **A** |
| Peak movement week, all ages | **Week of 5–11 Nov** | **A** |
| Bucks aged 3+ at dawn during peak rut | **lower** movement than yearlings and 2-year-olds; shift toward nocturnal | **A** |
| Highest mean daily movement rate and largest daily range | **two-year-olds**, not the oldest bucks | **A** |
| Opening firearm weekend effect on movement *rate* | **none significant** | **A** |

Two corroborating sets, both tier C, both agreeing on the calendar:

- Midwest fetal-aging (Illinois Natural History Survey): mean conception
  **8 Nov** for adults, **11 Nov** yearlings, **2 Dec** for fawns — the fawn
  figure being the real basis of "second rut", not a myth.
- Corn Belt region-wide breeding median ≈ **13 Nov**.

**What changed in the code.** The old calendar scored 1–7 Nov as the year's best
(24) and 18–31 Oct as merely "pre-rut" (16). The Wisconsin changepoint puts
**23 Oct inside the peak**, so the last week of October was being under-scored by
a full tier on the one dataset from this latitude. It is now scored as peak.

---

## 2. Weather — where the planner was most wrong

### Cold fronts: the classic advice does not survive collar data

| Source | Finding | Tier |
| --- | --- | --- |
| Penn State Deer-Forest Study, October data | "**no overall difference in speed of movement or total distance travelled** before, during or after the front passed" | **B** |
| Diefenbach (Deer-Forest lead), on a monitored front | n = 7 deer, **no overall pattern**; explicitly unwilling to say fronts have an effect *or* that they do not | **B** |
| Mississippi State / Noble Foundation, Oklahoma, 32 deer on 3,000 acres | "**big temperature drops and high barometer readings didn't cause a big deer movement**"; movement tracked **time of year**, not weather | **B** |

**Folk-wisdom flag.** "A cold front gets deer on their feet" is the single most
repeated claim in hunting media and the best-supported answer from collar work is
*no measurable change in movement*. The planner scored a 20 °F drop at **+14** —
comparable to a whole rut phase. That was the largest unsupported number in the
program.

### Temperature: two peaks, not a slope

**Goethlich 2019, "Effects of Abiotic Factors on White-tailed Deer Activity in
South Carolina", MSc thesis, Auburn University.** Tier **B** (South Carolina;
thermal regime not Wisconsin's).

- Probability of activity is **bimodal in temperature** — one peak at the cool
  end, one at the warm end, with a **trough between them**. A monotonic
  "colder is better" term is the wrong shape.
- Post-rut: **higher** temperatures → morning and night activity; **lower**
  temperatures → day and evening activity. Temperature moves *when*, not
  *whether*.
- The finding that matters most for a planner:
  **"weather factors mattered least at dawn and dusk."** Significant
  weather relationships showed up in the *daytime* and *nighttime* blocks and
  were least likely in the morning and evening blocks — i.e. exactly the hours
  a hunter sits, weather explains the least.

Penn State on a warm snap in Oct/Nov: "**couldn't discern any difference** in the
amount or timing of deer movement"; collared bucks held ≈ **½ mph, 24 h/day**.
Tier **B**.

### Wind: the planner had the sign backwards

| Source | Finding | Tier |
| --- | --- | --- |
| Penn State Deer-Forest | "**least** amount of deer movement during **calm** conditions, and activity **steadily increased as wind speeds increased**" | **B** |
| Goethlich 2019 (Auburn) | "little difference in the probability of deer movement regardless of wind during the pre-rut and rut" | **B** |
| Webb et al. 2010, *International Journal of Ecology* | **no clear relationship** between wind speed and movement for either sex | **B** |
| Webb et al. 2010 | wind affected **females more than males**, greatest at **night**: probability of activity **fell** as wind rose | **B** |
| Aggregated collar reporting | deer moved farther at 1–3 mph than at < 1 mph; distance **peaked at 10+ mph** | **C** |

**Folk-wisdom flag.** "Deer hold in cover above 15–20 mph" is not supported;
if anything the relationship runs the other way. The planner scored 18+ mph at
**−9**. That penalty is gone.

The residual reason to prefer a *moderate* wind is about **the hunter, not the
deer**: a steady breeze gives a predictable scent cone, and dead calm makes scent
pool unpredictably. That is a scent-management argument and the code now says so
in those words instead of claiming deer stop moving.

### Rain

- Goethlich: **slight increase** in buck movement in drizzle; **average**
  movement in steady rain. Tier **B**.
- Deer-Forest: bucks **reduced movement by as much as half** on rainy days;
  **does unaffected**. Critically — "a little rain has **no effect** on buck
  activity **if there is a strong wind blowing**." Tier **B**.

The two disagree on drizzle. The model therefore treats light rain as **neutral**
and only penalises measurable rain, with the wind interaction noted.

### Barometric pressure

| Source | Claim | Tier |
| --- | --- | --- |
| Hunting-industry logbook compilations (HuntWise and similar) | peak activity 30.00–30.40 inHg; buck:doe sighting ratio 1:1 in that band vs 1:3 at 29.8–30.00 | **D** |
| Mississippi State / Noble Foundation | high barometer readings **did not** produce a movement response | **B** |

**Folk-wisdom flag.** The "active band" the planner scored at **+5** traces to
aggregated hunter logbooks, not a study, and the one collar test of it found
nothing. Pressure now scores **zero** and is reported as an observation only.
It is retained in the output because Kent will want to judge it against his own
sits, which is exactly what the journal is for.

---

## 3. The October lull — real, but not what it is usually called

Collar consensus (tier **B/C**): **daily movement does not dip in October.** It
rises steadily from the summer low through to the rut. What changes is *where*
bucks move and how much of it is visible: movement shifts toward cover, daylight
activity in open areas falls, hunting pressure begins, and leaf drop changes
sightlines.

So the lull is a **detection and visibility** phenomenon, not a movement one.
That distinction has a direct consequence for this program: a mid-October dip
belongs in the **camera-detection** half of the model, not the movement half,
and the reason string must say so or it teaches Kent something false.

---

## 4. Excursions — the number that should change how November is hunted

From collar work on **182 bucks** (tier **C**, aggregated reporting):

| Finding | Number |
| --- | --- |
| Mean excursion distance beyond the home range | ≈ **1.5 miles** (range ¼ – 8 miles) |
| Pre-rut and post-rut excursions occurring at **night** | ≈ **70 %** |
| **Peak-rut** excursions occurring in **daylight** | ≈ **70 %** |

That inversion is the mechanism behind "sit all day in the first half of
November", and it is the best-supported reason in the program to rate those days
highly — better supported than any weather term.

Mississippi State (below) adds: excursions cluster in the breeding season and
early spring, with **very few in summer and early fall**.

---

## 5. Space use, time budget, and individual variation

**Mississippi State University Extension P3927, "Understanding Buck Movement"** —
GPS collars, 50,000-acre private study area on the Big Black River, Mississippi.
Tier **B** (southern, but the individual-variation findings are structural).

| Finding | Number |
| --- | --- |
| Median annual home range, adult bucks | **859 acres** |
| Spread | **27 %** under 500 acres; **22–25 %** over 2,000 acres |
| Daily home range, even at peak rut | ≈ **200 acres** |
| Daily distance travelled, early rut | **> 7,000 yards/day** |
| Bucks with a "mobile" two-range lifestyle | ≈ **one third**; mean range **12,406 acres** |
| "Sedentary" bucks | ≈ **two thirds**; mean range **786 acres** |
| Mean stay in one range segment, mobile bucks | **79 days** |
| Mobile-buck excursions | ≈ 5 miles; sedentary ≈ 1 mile, ≈ 12 hours |

**Time budget by period** — the reason dawn and dusk are worth sitting:

| Period | Bedded | Feeding / tending | Walking |
| --- | --- | --- | --- |
| Dawn | 38 % | 43 % | **19 %** |
| Day | **64 %** | 27 % | 9 % |
| Dusk | 35 % | 44 % | **21 %** |
| Night | 47 % | 39 % | 14 % |

**Auburn / Ditchkoff, South Carolina**, 54 bucks + 57 does, ~10 years, 14,000
acres, 30-minute fixes. Tier **B**:

| Finding | Number |
| --- | --- |
| Buck daytime movement in **food plots** | **250 yd/hr** (does 150) |
| Buck daytime movement in **hardwood drains** | ≈ **50 yd/hr** (does ≈ 75) |
| Night movement, both sexes, all cover types | **150–200 yd/hr** |
| Daytime cover selection, both sexes | hardwood drains and planted pines |
| Night cover selection | food plots, most preferred |

The practical reading: **bucks are not slow at night, they are slow in cover by
day.** A daytime buck in the open is moving fast and briefly, which is why a
camera on a field edge under-represents daytime use relative to a camera on a
travel corridor.

**Individual variation is large enough to break population averages.** A third of
bucks having a home range fifteen times the other two thirds' means any "the
deer here do X" statement is an average over two different animals. This is the
formal justification for the program's refusal to predict *where* from other
people's deer.

---

## 6. Hunting pressure — the best-supported human variable

| Source | Finding | Tier |
| --- | --- | --- |
| Collar work reported by Deer & Deer Hunting | daytime movement fell **22 % by Saturday** and **34 % by Sunday** relative to the start of the weekend; greatest daytime movement **Thursday and Friday**, just before hunters arrived; recovery by Thursday/Friday | **C** |
| Mississippi State P3927 | hunter observations of collared bucks *known to be present* fell **62 % by the second weekend** | **B** |
| Little et al. 2016, *Basic and Applied Ecology* — 37 adult males, 1,861 ha, southern Oklahoma; treatments control / 1 hunter per 101 ha / 1 hunter per 30 ha | with greater hunter density: **increased** path complexity and use of security cover; with **prolonged** exposure: reduced movement rate, sought security cover, and **observation rates fell** | **B** |
| Mississippi State P3927 | selection **decreased as hunting pressure increased** across crop, upland hardwood, pine, herbaceous and bottomland hardwood alike | **B** |
| Hunsaker 2025 (Wisconsin) | opening firearm weekend: **no significant effect on movement rate** | **A** |

The last row is not a contradiction — it is the same distinction as the October
lull. **Pressure changes where deer are and whether you see them, far more than
how far they walk.** The 62 % collapse in observations of bucks *known to still
be there* is the cleanest statement of it in the literature.

**This is the largest actionable effect in the whole document, and the app was
not modelling it at all**, despite already recording every sit in the `sits`
table.

---

## 7. Moon — tested repeatedly, and it is not there

| Source | Finding | Tier |
| --- | --- | --- |
| Penn State Deer-Forest | moon phase has "**little to no impact** on deer mobility by night or day" | **B** |
| Mississippi State P3927 | "**absolutely no pattern** of variation that can be associated with moon phase"; "movement rates are **not influenced** by the phase of the moon" | **B** |

**Folk-wisdom flag.** The planner scored ±2 for moon illumination and called it
"deliberately small". The honest weight is **zero**. It is still displayed,
because a number the user can see and dismiss is better than one removed without
explanation — but it contributes nothing.

---

## 8. Food: mast and crops

- **McShea & Schwede 1993, *Journal of Mammalogy* 74(4)** — 10 radio-collared
  does, Front Royal, Virginia, 1986–89. Deer **expanded home range to include
  acorn-producing stands** during mast-fall; acorns ≈ **50 % of foraging time**
  at peak; consumption ≈ **0.75 acorns per minute** of searching; searching
  continued well after mast-fall. Tier **B**.
  → A good acorn year pulls deer **off field edges and into oak stands**, which
  is a camera-placement effect, not a movement effect.
- **Standing corn**: selection for standing corn documented at both population
  and home-range levels (female deer, north-central South Dakota, winter
  2005–06). Standing corn supplies bedding, food and cover simultaneously.
  Tier **B**. Practical consequence, tier **D** but widely reported: mature
  bucks in standing corn are close to unhuntable until it comes off.
- **Harvest** dramatically reduces available food and changes travel patterns.
  Tier **C**.

The app already stores field polygons with a crop type **and a cut date**, and
scored none of it. A cut date is the single most informative food fact on the
property and it was sitting unused.

---

## 9. Camera detection bias — the meta-variable

Everything the WHERE half concludes is filtered through detection probability, so
this governs how much any camera-derived number is allowed to claim.

| Finding | Number | Tier |
| --- | --- | --- |
| Survey length capturing ≈ 90 % of unique deer | **14 days** | **C** |
| Survey length capturing ≈ 85 % | **10 days** | **C** |
| Standard survey design | 1 camera / 100 acres, 14 days | **C** |
| Detection-probability gain from a second camera at a site | **+22 % to +400 %** depending on species | **B** (PLOS ONE, multi-species array study) |

Established methods for turning photo timestamps into activity estimates —
these are what the evidence module implements in spirit, at the scale the data
supports:

- **Circular kernel density** on time-of-day (Ridout & Linkie 2009). Times are
  circular; a linear histogram gets midnight wrong.
- **Overlap coefficient Δ** — area under the minimum of two density estimates,
  0 = disjoint, 1 = identical. The right way to compare two cameras' activity
  patterns, or a buck's against legal light.
- **Rowcliffe et al. 2014**, *Methods in Ecology and Evolution* — activity level
  from camera data, with non-parametric bootstrap CIs.
- **Double-anchoring** detection times to sunrise and sunset for crepuscular
  species, so a November 07:00 and a September 07:00 are comparable.

The 14-day / 90 % figure is the basis for the evidence module's refusal
threshold: below roughly two weeks of camera-days in a condition, a camera has
not seen enough of the deer using it for a rate to mean anything.

---

## 10. Scent and wind play

| Finding | Number | Tier |
| --- | --- | --- |
| Olfactory receptors | ≈ **290 million** (human ≈ 6 million) | **C** |
| UGA Warnell — measured downwind detection | ≈ **100 yards** | **C** |
| Commonly cited typical range | up to **300 yards** | **D** |
| "Ideal conditions" claim (Rue III: 50–70 % humidity, 50–70 °F, light breeze) | **½ mile or more** | **D** |

The tier-A/B evidence supports **100 yards as the number to design around** and
does not support the half-mile figure. The existing scent-cone geometry in
`coverage.mjs` and `routes.mjs` — a 30° half-angle plume tested against lane
bearings — is unaffected by this and remains the right model; what changes is
that nothing in the program should claim a half-mile scent reach.

**On "bed with the wind at their back":** widely repeated, and no GPS-collar
study establishing it turned up in this pass. It is **tier D** and is not
modelled. The program continues to reason about *the hunter's* scent reaching
*known* deer locations, which needs no assumption about bedding orientation.

---

## What this document changed in the code

| Was | Now | Because |
| --- | --- | --- |
| Cold front +14 / +9 / +4 | ≤ +3, labelled contested | §2 — collar data finds no movement change |
| Wind 18+ mph **−9** | no deer penalty; a scent-predictability term instead | §2 — activity *rises* with wind |
| Barometer "active band" +5 | **0**, reported only | §2 — the source is logbooks, tier D |
| Moon ±2 | **0**, reported only | §7 — two collar studies find nothing |
| Peak rut 1–7 Nov | peak **23 Oct – 12 Nov**, best 5–11 Nov | §1 — Wisconsin changepoint analysis |
| October lull as a movement penalty | a **visibility** penalty, worded as one | §3 |
| Hunting pressure: not modelled | modelled from the `sits` table | §6 — largest actionable effect found |
| Crop state: stored, not scored | scored from crop type and cut date | §8 |
| Confidence: not reported | reported everywhere, from evidence volume | §9 |
