# Collar data

Drop downloaded GPS-collar datasets here. **Nothing in this folder is
committed** — see `.gitignore`. The data is CC0, so there is no licence reason
not to, but a 23 MB CSV does not belong in a git repository.

## What to download

**Spatiotemporal patterns of male and female white-tailed deer on a hunted
landscape** — <https://doi.org/10.5061/dryad.fttdz08wj>

The file that matters is `RateofMovementData.csv` (about 23 MB). Downloads sit
behind a bot check, so fetch it from a browser rather than a script.

Two others worth having, same place, same licence:

- *Does temporary baiting affect white-tailed deer space use and movement?* —
  <https://doi.org/10.5061/dryad.wm37pvn2f>
- *Reproductive effort and success of males in scramble competition polygyny*
  (buck movement through the rut) — <https://doi.org/10.5061/dryad.q8vh197>

## What this is for, and what it is not

These are other deer, in Alabama, Georgia, Canada and Florida, in other years,
on other ground. **They cannot say where your deer are**, and no amount of this
data changes that.

What they can do is replace the planner's hand-picked weights with measured
effect sizes. `hunt-planner.mjs` currently scores sits using numbers chosen by
judgement — rut phase 2 to 24, cold front, pressure trend, wind, rain, moon
"deliberately small". A movement-rate dataset measures how much movement
actually rises with a temperature drop, and how little the moon actually
matters.

The limit that matters: southern deer rut on different dates and in different
heat than Wisconsin deer. The **shape** of a weather relationship transfers;
the **timing** of the rut calendar does not, and must be left alone.

That is calibrating WHEN, not predicting WHERE.
