# Providers

A provider is one camera brand's cloud. Each exports the same small interface,
so the sync, the dashboard, the hunt planner and the tests never learn anything
brand-specific — a camera from any provider is just a row.

```js
export default {
  id: 'spypoint',                  // lowercase, used in config and on the CLI
  label: 'SpyPoint',               // shown to people
  envPrefix: 'SPYPOINT',           // reads <PREFIX>_EMAIL and <PREFIX>_PASSWORD

  async login(email, password),    // -> session (opaque; whatever the provider needs)
  async cameras(session),          // -> array of RAW provider camera documents
  async photos(session, cameraId, before, limit),  // -> { photos: [raw], raw: response }

  normalizeCamera(raw),            // raw document -> the shape below
  photoDate(raw),                  // -> ISO string or null
  photoUrl(raw, preferredSize),    // -> https URL or null
  photoId(raw),                    // -> stable unique string
  photoTags(raw),                  // -> array of strings
};
```

## The normalized camera

Every provider must produce this shape. Anything it cannot supply is `null` —
never invented, never a placeholder, because the dashboard and the health rules
distinguish "zero" from "unknown" and a fake value corrupts both.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the provider |
| `provider` | string | Filled in by the loader, not the provider |
| `name` | string | What the owner called it |
| `model` | string \| null | |
| `lat`, `lng` | number \| null | **Decimal degrees. Latitude, then longitude** |
| `gpsFix` | ISO string \| null | When the position was taken |
| `battery` | 0–100 \| null | Percent |
| `batteryLevel` | string \| null | e.g. `low`, `medium`, `high` |
| `batterySource` | string \| null | e.g. `AA`, `LITHIUM`, `SOLAR` |
| `signal` | 0–100 \| null | Percent |
| `signalBars`, `signalLevel`, `signalType` | | |
| `tempValue`, `tempUnit` | | |
| `memUsed`, `memSize` | number \| null | MB |
| `plan`, `photoCount`, `photoLimit` | | Subscription |
| `lastSeen` | ISO string \| null | Last contact. Drives the staleness warnings |

> **Coordinate order is the classic way to get this wrong.** GeoJSON, which
> SpyPoint uses, is `[longitude, latitude]` — the reverse of how people say it.
> Normalize to explicit `lat` and `lng` fields inside the provider so nothing
> downstream has to remember. Transposing them puts a Wisconsin camera in Asia
> and a map draws it without complaint, so add a fixture and assert both.

## Adding one

1. Write `providers/<id>.mjs` against the interface above.
2. Register it in `providers/index.mjs`.
3. Add a fixture under `fixtures/` with **synthetic** coordinates and ids — this
   repository is public — and a test that pins the coordinate order the way
   `test/extract.test.js` does.
4. Run `node --test`.

## Status

| Provider | State |
| --- | --- |
| `spypoint` | Working. Verified against a real 4-camera FLEX-M account |
| `moultrie` | **Not implemented.** See `moultrie.mjs` for what is needed and why |
