/**
 * analysis.mjs — the WHERE half of the answer.
 *
 * The planner answers WHEN: which afternoon is worth sitting, from published
 * deer behaviour and a forecast. It never looks at a photo. This file answers
 * the other half — *given those conditions, which of your cameras has actually
 * produced?* — and it looks at nothing else.
 *
 * The split is deliberate and its reasoning is in design.md §9. The short
 * version: fitting the planner's weather factors to observed sightings is
 * hopeless in one season, because there is one rut and every factor is
 * confounded with the calendar. But "it is raining this afternoon, which stand?"
 * is a comparison BETWEEN CAMERAS DURING THE SAME WEATHER, and rut phase, date,
 * moon and pressure are then held constant for free.
 *
 * That guarantee has a condition the design left implicit, and this file makes
 * it explicit because it is load-bearing: **the cameras must have been watching
 * at the same time.** A camera that ran through November and one hung last
 * Tuesday differ for reasons that have nothing to do with rain. So the ranked
 * comparison runs over the days every compared camera was watching, and says
 * which days those were. Each camera's own-window figures are returned too, and
 * are deliberately NOT ranked against each other.
 *
 * Three refusals, all of them the point rather than an inconvenience:
 *
 * - **Untagged photos are not evidence.** Only confirmed detections count
 *   (`detectionsWithWeather`'s default). A camera's own AI guess is a claim.
 * - **A rate needs hours behind it.** Below `MIN_HOURS` of a condition a camera
 *   is not ranked at all — it reads "not enough rain here yet" rather than
 *   producing a number from three hours.
 * - **No common window, no ranking.** If the cameras have no days in common,
 *   the table says so and names the camera that shortened it.
 *
 * And raw counts are always shown beside any rate. Design.md §"The evidence
 * bar": with one season most real differences will not clear a formal
 * significance test, so a strict test answers "no difference" almost every time
 * — correct and useless. A hunter reading 7-versus-1 on his own ground judges
 * it correctly; a bare verdict hides that it rests on almost nothing.
 */

/**
 * A camera needs this many hours of a condition before its rate is ranked.
 * Ten is the design's starting number, chosen to be obviously arbitrary rather
 * than falsely precise — it is a floor against dividing by three, not a
 * significance threshold.
 */
export const MIN_HOURS = 10;

/** Eight sectors, not sixteen: a wind rose split 16 ways over one season puts
 *  a handful of hours in each bin and every rate becomes noise. */
export const OCTANTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export const octantOf = deg =>
  OCTANTS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

/**
 * How many hours back the pressure trend looks. Three hours is the interval a
 * barometer's own "rising / falling" needle uses, and it is short enough that a
 * front's passage still shows in it.
 */
export const TREND_HOURS = 3;

/**
 * The conditions a hunter can name and a forecast can supply.
 *
 * Every bucket is derived from a column already in `weather_hours`, so the same
 * cut can be applied to tonight's forecast and to five years of archive without
 * a second definition. `bucketOf` returns null for an hour it cannot place —
 * a missing reading is unknown, never "no rain" (Number(null) is 0, and this
 * file is not going to be the fourth place that bites).
 *
 * Every bucket carries a `phrase` as well as a `label`: the label heads a box,
 * the phrase goes inside a sentence ("no rain in the 21-day window"). Building
 * the sentence by lowercasing the label is the obvious shortcut and it is
 * wrong — a compass point is not a word, and the first browser drive of this
 * section printed "No ne wind in the 21-day window".
 */
export const GROUPS = [
  {
    key: 'rain',
    label: 'Rain',
    ask: 'Does rain move deer past a different camera?',
    buckets: [
      { key: 'wet', label: 'Raining', phrase: 'rain' },
      { key: 'dry', label: 'Dry', phrase: 'dry weather' },
    ],
    // A hundredth of an inch is the smallest thing the archive reports; below
    // it the ground is not wet and the woods are not quiet.
    bucketOf: h => (h.precip_in == null ? null : h.precip_in >= 0.01 ? 'wet' : 'dry'),
  },
  {
    key: 'temp',
    label: 'Temperature',
    ask: 'Which camera produces when it turns cold?',
    buckets: [
      { key: 'freezing', label: 'Below freezing', phrase: 'sub-freezing weather' },
      { key: 'cold', label: '32–45 °F', phrase: 'weather between 32 and 45 °F' },
      { key: 'mild', label: '45–60 °F', phrase: 'weather between 45 and 60 °F' },
      { key: 'warm', label: 'Above 60 °F', phrase: 'weather above 60 °F' },
    ],
    bucketOf: h => (h.temp_f == null ? null
      : h.temp_f < 32 ? 'freezing'
        : h.temp_f < 45 ? 'cold'
          : h.temp_f < 60 ? 'mild' : 'warm'),
  },
  {
    key: 'winddir',
    label: 'Wind direction',
    ask: 'Where do deer travel on each wind?',
    buckets: OCTANTS.map(p => ({ key: p, label: `${p} wind`, phrase: `${p} wind` })),
    bucketOf: h => (h.wind_dir == null ? null : octantOf(h.wind_dir)),
  },
  {
    key: 'windspeed',
    label: 'Wind strength',
    ask: 'Does a hard wind push deer somewhere else?',
    buckets: [
      { key: 'calm', label: 'Calm (under 5 mph)', phrase: 'calm air' },
      { key: 'steady', label: 'Steady (5–12 mph)', phrase: 'steady wind' },
      { key: 'strong', label: 'Strong (over 12 mph)', phrase: 'strong wind' },
    ],
    bucketOf: h => (h.wind_mph == null ? null
      : h.wind_mph < 5 ? 'calm' : h.wind_mph <= 12 ? 'steady' : 'strong'),
  },
  {
    key: 'sky',
    label: 'Sky',
    ask: 'Does an overcast day stretch movement at one camera more than another?',
    buckets: [
      { key: 'overcast', label: 'Overcast (70%+)', phrase: 'overcast' },
      { key: 'mixed', label: 'Broken cloud', phrase: 'broken cloud' },
      { key: 'clear', label: 'Clear (under 30%)', phrase: 'clear sky' },
    ],
    bucketOf: h => (h.cloud_pct == null ? null
      : h.cloud_pct >= 70 ? 'overcast' : h.cloud_pct >= 30 ? 'mixed' : 'clear'),
  },
  {
    key: 'pressure',
    label: 'Barometer',
    ask: 'Which camera fires as a front clears?',
    buckets: [
      { key: 'rising', label: 'Rising', phrase: 'rising barometer' },
      { key: 'steady', label: 'Steady', phrase: 'steady barometer' },
      { key: 'falling', label: 'Falling', phrase: 'falling barometer' },
    ],
    // The planner's own thresholds, so the two halves describe a front the
    // same way (hunt-planner.mjs scoreSit: ±0.12 inHg).
    bucketOf: h => (h.trend_inhg == null ? null
      : h.trend_inhg >= 0.12 ? 'rising'
        : h.trend_inhg <= -0.12 ? 'falling' : 'steady'),
  },
];

export const groupBy = key => GROUPS.find(g => g.key === key) ?? null;

const dateOf = hourUtc => (typeof hourUtc === 'string' ? hourUtc.slice(0, 10) : null);

/**
 * Annotate hours with the pressure change over the last `TREND_HOURS`.
 *
 * Walked by timestamp rather than by index: a gap in the archive would
 * otherwise make hour N and hour N-3 six hours apart and invent a front. An
 * hour with no partner three hours back gets null and falls out of the
 * barometer cut rather than being called steady.
 */
export function withTrends(hours, { hoursBack = TREND_HOURS } = {}) {
  const byKey = new Map();
  for (const h of hours) if (h.hour_utc) byKey.set(h.hour_utc, h);
  return hours.map(h => {
    const t = Date.parse(h.hour_utc);
    if (Number.isNaN(t) || h.pressure_inhg == null) return { ...h, trend_inhg: null };
    const then = byKey.get(new Date(t - hoursBack * 3600000).toISOString().slice(0, 13) + ':00:00Z');
    if (!then || then.pressure_inhg == null) return { ...h, trend_inhg: null };
    return { ...h, trend_inhg: h.pressure_inhg - then.pressure_inhg };
  });
}

/**
 * The days a camera was demonstrably watching: the days it produced a photo.
 *
 * This is the denominator's honesty. Counting every archived hour instead would
 * charge a camera hung last week with a whole autumn of "saw nothing", and it
 * would read as dead ground. Using the photo span end to end would still credit
 * a camera through a month it spent in a drawer with a flat battery.
 *
 * The cost is stated rather than hidden: a day the camera was live and simply
 * triggered nothing at all does not count. On motion-triggered cameras that is
 * a rare day, and it is also a day with no evidence either way.
 */
export function coverageDays(photos) {
  const by = new Map();
  for (const p of photos) {
    const d = dateOf(p.hour_utc) ?? (p.taken_at ? String(p.taken_at).slice(0, 10) : null);
    if (!d) continue;
    if (!by.has(p.camera_id)) by.set(p.camera_id, new Set());
    by.get(p.camera_id).add(d);
  }
  return by;
}

/** Sightings counted as VISITS, not frames. A camera set to multiShot fires
 *  twelve times at one doe; counting frames would make burst length look like
 *  deer activity. A visit with no id falls back to its own photo. */
const visitKey = row => (row.visit_id == null ? `p:${row.photo_id}` : `v:${row.visit_id}`);

/**
 * The comparison itself. Pure — it takes loaded rows and returns the table, so
 * the reasoning can be tested without a database and the database test can
 * check the loading separately.
 */
export function compare({ cameras, hoursByLocation, detections, coverage }, {
  group = 'rain', minHours = MIN_HOURS,
} = {}) {
  const g = groupBy(group);
  if (!g) throw new Error(`unknown condition group "${group}" — one of ${GROUPS.map(x => x.key).join(', ')}`);

  const shape = {
    group: { key: g.key, label: g.label, ask: g.ask, buckets: g.buckets },
    minHours,
    cameras: [],
    common: null,
    buckets: [],
    refusal: null,
  };

  const withPhotos = cameras.filter(c => (coverage.get(c.id)?.size ?? 0) > 0);
  if (!withPhotos.length) {
    return { ...shape, refusal: { code: 'no-photos', says: 'No camera has photos yet, so there is nothing to compare.' } };
  }

  // Per-camera coverage, reported whatever happens next: the window is the
  // thing most likely to explain a surprising answer, so it is never implicit.
  shape.cameras = withPhotos.map(c => {
    const days = [...(coverage.get(c.id) ?? [])].sort();
    return { id: c.id, name: c.name, days: days.length, from: days[0], to: days[days.length - 1], inCommon: 0 };
  });

  const anyHours = withPhotos.some(c => (hoursByLocation.get(c.locationId)?.length ?? 0) > 0);
  if (!anyHours) {
    return { ...shape, refusal: { code: 'no-weather', says: 'No weather hours are stored yet, so no condition can be told from another. The sync backfills them.' } };
  }

  if (!detections.length) {
    return {
      ...shape,
      refusal: {
        code: 'nothing-tagged',
        says: 'Nothing is tagged yet. Only a tag you confirmed counts as a sighting here — the camera’s own guess is a claim, not evidence. Tag visits in Review and this fills in.',
      },
    };
  }

  // The overlap: days EVERY compared camera was watching. This is what makes
  // camera-versus-camera sound — see the header note.
  let common = null;
  for (const c of withPhotos) {
    const days = coverage.get(c.id);
    common = common === null ? new Set(days) : new Set([...common].filter(d => days.has(d)));
  }
  const commonDays = [...common].sort();
  for (const row of shape.cameras) {
    row.inCommon = [...(coverage.get(row.id) ?? [])].filter(d => common.has(d)).length;
  }
  shape.common = { days: commonDays.length, from: commonDays[0] ?? null, to: commonDays[commonDays.length - 1] ?? null };

  if (!commonDays.length) {
    // Name the camera that costs the overlap: "camera X has no day in common"
    // is actionable, "no common window" is not.
    const shortest = [...shape.cameras].sort((a, b) => a.days - b.days)[0];
    return {
      ...shape,
      refusal: {
        code: 'no-common-window',
        says: `These cameras have no day in common — ${shortest.name} covers ${shortest.days} day${shortest.days === 1 ? '' : 's'} (${shortest.from} to ${shortest.to}). Comparing them would compare different weeks, not different ground.`,
      },
    };
  }

  // Condition-hours per camera per bucket, over the common days only.
  const hourBucket = new Map(); // locationId -> Map(hour_utc -> bucketKey)
  for (const [loc, rows] of hoursByLocation) {
    const m = new Map();
    for (const h of rows) {
      if (!common.has(dateOf(h.hour_utc))) continue;
      const b = g.bucketOf(h);
      if (b) m.set(h.hour_utc, b);
    }
    hourBucket.set(loc, m);
  }

  const seen = new Map(); // cameraId -> Map(bucketKey -> Set(visitKey))
  for (const d of detections) {
    if (!common.has(dateOf(d.hour_utc))) continue;
    const cam = withPhotos.find(c => c.id === d.camera_id);
    if (!cam) continue;
    const b = hourBucket.get(cam.locationId)?.get(d.hour_utc);
    if (!b) continue;
    if (!seen.has(cam.id)) seen.set(cam.id, new Map());
    const m = seen.get(cam.id);
    if (!m.has(b)) m.set(b, new Set());
    m.get(b).add(visitKey(d));
  }

  shape.buckets = g.buckets.map(b => {
    const cams = withPhotos.map(c => {
      // No second filter against this camera's own days is needed, and adding
      // one would be dead code: the window is the INTERSECTION, so every
      // camera covered every day in it by construction. Cameras on one ground
      // therefore get identical hours here, which is the point — they are
      // judged over exactly the same weather. Two cameras on two grounds
      // differ, because they have different weather locations and different
      // rain; that comparison is still conditional rather than confounded, and
      // it matches the switcher's decision to rank across both lands.
      let hours = 0;
      for (const bucket of (hourBucket.get(c.locationId) ?? new Map()).values()) {
        if (bucket === b.key) hours++;
      }
      const sightings = seen.get(c.id)?.get(b.key)?.size ?? 0;
      return {
        id: c.id,
        name: c.name,
        sightings,
        hours,
        // Per hundred hours rather than per hour: a real rate here is a few
        // sightings across a few hundred hours, and "0.02" reads as nothing.
        per100: hours >= minHours ? Math.round(1000 * sightings / hours) / 10 : null,
      };
    });
    const ranked = cams.filter(c => c.per100 !== null).sort((a, b2) => b2.per100 - a.per100 || b2.sightings - a.sightings);
    const thin = cams.filter(c => c.per100 === null && c.hours > 0);
    const absent = cams.filter(c => c.hours === 0);
    return {
      key: b.key,
      label: b.label,
      phrase: b.phrase,
      // The hours available at all in this bucket, across the common window —
      // the number that says whether the bucket is worth reading.
      hours: Math.max(0, ...cams.map(c => c.hours)),
      ranked,
      thin,
      absent,
      says: ranked.length ? null
        : thin.length
          ? `Not enough ${b.phrase} yet: ${thin.map(c => `${c.name} ${c.hours} h`).join(', ')}. ${minHours} hours is the floor before a rate means anything.`
          : `No ${b.phrase} in the ${commonDays.length}-day window these cameras share.`,
    };
  });

  return shape;
}

/** Load what `compare` needs out of the database. */
export function loadInputs(db, { species = 'deer' } = {}) {
  const cameras = db.prepare(
    'SELECT id, name, weather_location_id FROM cameras ORDER BY name',
  ).all().map(c => ({ id: c.id, name: c.name, locationId: c.weather_location_id }));

  const hoursByLocation = new Map();
  const locs = [...new Set(cameras.map(c => c.locationId).filter(v => v != null))];
  for (const loc of locs) {
    const rows = db.prepare(
      'SELECT * FROM weather_hours WHERE location_id = ? ORDER BY hour_utc',
    ).all(loc);
    hoursByLocation.set(loc, withTrends(rows));
  }

  const photos = db.prepare('SELECT camera_id, hour_utc, taken_at FROM photos').all();

  // Confirmed only, and joined to the photo so a visit can be the unit. This is
  // detectionsWithWeather's own rule; the weather is re-derived here from the
  // full archive instead, because a sighting's hour must be counted against the
  // SAME hour table the denominator comes from.
  const detections = db.prepare(`
    SELECT d.id, d.species, ph.id AS photo_id, ph.visit_id, ph.camera_id, ph.hour_utc
    FROM detections d
    JOIN photos ph ON ph.id = d.photo_id
    WHERE d.confirmed = 1 AND (? IS NULL OR d.species = ?)
  `).all(species ?? null, species ?? null);

  return { cameras, hoursByLocation, detections, coverage: coverageDays(photos) };
}

/** The whole answer, from a database. */
export function whereTable(db, { group = 'rain', species = 'deer', minHours = MIN_HOURS } = {}) {
  const out = compare(loadInputs(db, { species }), { group, minHours });
  return { ...out, species: species ?? null };
}

/**
 * Which bucket of each group tonight's conditions fall in, so the table can
 * open on the row that matters rather than on whichever came first.
 *
 * Takes a plain hour — the same shape `weather_hours` stores — which is what
 * the planner's own sit summary can be reduced to. A field it cannot place is
 * simply absent from the result: an unplaceable forecast must not silently
 * select "dry".
 */
export function bucketsForConditions(hour) {
  const out = {};
  for (const g of GROUPS) {
    const b = g.bucketOf(hour ?? {});
    if (b) out[g.key] = b;
  }
  return out;
}

/**
 * Sightings against the stands that watch the same ground.
 *
 * A camera is not a place to sit — `allStands` already knows which cameras a
 * stand covers and how far off they are. This turns "camera A produced in the
 * rain" into "sit the stand near camera A", which is the sentence the tool
 * exists to produce, and refuses where no stand covers the camera at all
 * rather than inventing a nearest one.
 *
 * **Distance breaks the tie, and that is not cosmetic.** Two stands can both
 * cover the camera that produced — `allStands` counts anything within 400 m —
 * and on equal rates the list is then decided by whatever order the stands came
 * out of the database. The first browser drive put a box blind 222 m from the
 * producing camera ahead of a ladder 40 m from it, both quoting the same rate.
 * Same number, and one of them is the wrong tree.
 */
export function standsForBucket(bucket, stands) {
  if (!bucket?.ranked?.length) return [];
  const best = new Map();
  for (const s of stands) {
    for (const nc of s.nearbyCameras ?? []) {
      const row = bucket.ranked.find(r => r.id === nc.id);
      if (!row) continue;
      const prev = best.get(s.id);
      // A stand takes its best covering camera, and among equally productive
      // ones the nearest — the same reasoning as the sort below.
      if (!prev || row.per100 > prev.per100
        || (row.per100 === prev.per100 && nc.metres < prev.metres)) {
        best.set(s.id, {
          standId: s.id, stand: s.name, camera: row.name, metres: nc.metres,
          per100: row.per100, sightings: row.sightings, hours: row.hours,
        });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.per100 - a.per100 || a.metres - b.metres);
}
