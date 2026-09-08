// Camera documents shaped exactly like the ones SpyPoint's API returns, as
// observed with `--inspect` against a real 4-camera FLEX-M account.
//
// EVERY identifying value here is synthetic: the coordinates, ids, ucid, SIM
// and serial are invented. This repository is public, and a real camera
// document contains the GPS position of a physical camera, so the real one
// must never be committed. The synthetic coordinates below are still
// arithmetically self-consistent — the DMS strings convert to the numeric
// array exactly — which is the whole point, since that relationship is what
// pins the [longitude, latitude] ordering.
export const FLEX_M = {
  activationDate: '2024-09-22T01:51:56.935Z',
  config: { name: 'North Ridge', gps: true, quality: 'high', temperatureUnit: 'F' },
  creationDate: '2024-09-22T01:51:56.935Z',
  dataMatrixKey: 'EXAMPLEKEY0',
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  status: {
    batteries: [20, 0, 0],
    batteryType: 'AA',
    activePowerSource: 0,
    powerSources: [
      { location: 'TRAY1', type: 'AA', percentage: 20, voltage: 9466, level: 'medium' },
    ],
    capability: { hdRequest: true, video: true, edgeAI: false },
    coordinates: [{
      dateTime: '2025-11-28T15:00:42.000Z',
      // N44 7.407360 == 44.123456 and W90 39.259260 == -90.654321.
      // Note which one lands in which slot of `coordinates` below.
      latitude: 'N44 7.407360',
      longitude: 'W90 39.259260',
      position: { type: 'Point', coordinates: [-90.654321, 44.123456] },
      geohash: 'ExAmPlEgEoHaSh',
    }],
    installDate: '2025-11-28T15:00:42.000Z',
    lastUpdate: '2025-11-28T15:00:42.000Z',
    memory: { size: 1871, used: 1758 },
    model: 'FLEX-M',
    modemFirmware: 'EXAMPLE00000000000',
    notifications: ['sd_card_one_partition'],
    signal: {
      bar: 4, dBm: -94, mcc: 311, mnc: 480, type: 'LTE',
      processed: { percentage: 100, bar: 4, lowSignal: false, level: 'high' },
    },
    sim: '00000000000000000000',
    temperature: { unit: 'F', value: 26 },
    version: '1.6.0-2-gb74a16f',
    batteryLevels: ['medium'],
  },
  ucid: '000000000000000',
  user: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  isCellular: true,
  subscriptions: [{
    cameraId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    paymentStatus: 'active',
    isActive: true,
    plan: { name: 'Free', id: 'Free', isFree: true, photoCountPerMonth: 100 },
    photoCount: 0,
    photoLimit: 100,
    // The window photoCount is measured over. Without it the count is a
    // bare fraction and no burn rate can be derived from it.
    startDateBillingCycle: '2025-11-01T00:00:00.000Z',
    endDateBillingCycle: '2025-11-30T23:59:59.999Z',
    monthEndBillingCycle: '2025-11-30T23:59:59.999Z',
    isFree: true,
  }],
};

// A deliberately different layout: no status.coordinates, location present only
// as bare top-level numbers. Guards the generic fallback hunts, so a rewrite
// tuned to the FLEX-M shape can't silently blank out other camera models.
export const LEGACY_SHAPE = {
  id: 'cccccccccccccccccccccccc',
  config: { name: 'Old Model' },
  latitude: 45.5,
  longitude: -91.25,
  model: 'FORCE-20',
  batteries: [55],
  status: {},
};

export const PHOTO = {
  id: 'dddddddddddddddddddddddd',
  camera: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  originDate: '2025-11-27T22:14:03.000Z',
  tag: ['deer'],
  small: { host: 'example-cdn.invalid', path: 'sm/photo.jpg', width: 400 },
  medium: { host: 'example-cdn.invalid', path: 'md/photo.jpg', width: 800 },
  large: { host: 'example-cdn.invalid', path: 'lg/photo.jpg', width: 1920 },
};

// A model whose document the current extraction CANNOT read: the battery is a
// remaining percentage under its own `power` object, the fix is a pair of bare
// `gps` numbers, the quota is worded differently and the last contact is called
// something else. Nothing here is a guess at a real SpyPoint model — it is a
// deliberately awkward shape, and its job is to prove that camera-shape.mjs
// reports the misread rather than letting it pass as a quiet camera.
//
// Keep it defeating the normalizer. If a future provider learns to read these
// keys, this fixture stops testing anything and should be made awkward again
// rather than deleted — the case it covers (a model nobody has met) never
// stops existing.
export const ODD_SHAPE = {
  id: 'eeeeeeeeeeeeeeeeeeeeeeee',
  config: { name: 'New Model' },
  power: { remainingPct: 64, chemistry: 'LITHIUM' },
  // Bare numbers, no `position`, no DMS, no geohash — and named `lon`, which
  // the position probe has to reach or the report would call this camera
  // simply silent about where it is.
  gps: { lastFix: { latDeg: 44.126, lonDeg: -90.658 } },
  reception: { strengthPct: 71 },
  quota: { used: 12, allowance: 100 },
  heartbeat: '2026-09-01T11:22:33.000Z',
  status: {},
};
