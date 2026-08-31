/**
 * providers/spypoint.mjs — the SpyPoint cloud, behind the shared provider
 * interface described in ./README.md.
 *
 * UNOFFICIAL. Endpoints mirrored from the community clients hstern/pyspypoint
 * and coloradude/spypoint-api-wrapper, which agree on all of them, and since
 * confirmed against a real 4-camera FLEX-M account. SpyPoint can change this
 * without notice; when a response stops looking right the caller is told
 * loudly rather than fed a guess.
 */

// Overridable so the sync can be exercised end to end against a local stand-in
// server in the tests. Nothing in normal use sets this.
const API = process.env.SPYPOINT_API_BASE || 'https://restapi.spypoint.com/api/v3';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, route, { token, body } = {}) {
  await sleep(250); // no published rate limits, so stay deliberately slow
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(API + route, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < 3) { await sleep(1500 * attempt); continue; }
      throw new Error(`${method} ${route}: network failure after ${attempt} tries (${err.message})`);
    }
    if (res.status >= 500 && attempt < 3) { await sleep(1500 * attempt); continue; }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      const e = new Error(`${method} ${route} -> HTTP ${res.status}${text ? ` ${text}` : ''}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }
}

// The camera/photo schemas are undocumented (both community clients pass the
// JSON through untouched), so extraction hunts by key name instead of
// hardcoding paths. Run --inspect to see what your account actually returns.
function* walk(obj, prefix = '') {
  if (obj === null || typeof obj !== 'object') {
    if (prefix) yield [prefix, obj];
    return;
  }
  if (Array.isArray(obj)) {
    if (prefix && obj.length > 0 && obj.every(x => typeof x === 'number')) yield [prefix, obj];
    for (let i = 0; i < obj.length; i++) yield* walk(obj[i], `${prefix}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(obj)) yield* walk(v, prefix ? `${prefix}.${k}` : k);
}

const leafKey = p => p.replace(/\[\d+\]/g, '').split('.').pop();

function findFirst(obj, keyRe, pred = () => true) {
  for (const [p, v] of walk(obj)) {
    if (keyRe.test(leafKey(p)) && pred(v)) return { path: p, value: v };
  }
  return null;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const first = a => (Array.isArray(a) ? a[0] : undefined);

/**
 * The newest entry of a list that carries `dateTime` stamps.
 *
 * status.coordinates is an ARRAY of fixes, and taking [0] was a guess about
 * its order that held only while every camera had exactly one fix in it. Move
 * a camera and it carries several — and if the older one sits first, the map
 * pins that camera where it used to be while its battery, signal and photos
 * all update around it. That reads as "the GPS did not update", which is
 * exactly the report this fixes; nothing in the document is malformed, so
 * nothing anywhere complains.
 *
 * An undated entry loses to a dated one but is never dropped: one undated fix
 * is still the only answer there is.
 */
const newestBy = list => {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.reduce((best, x) => {
    const t = Date.parse(x?.dateTime ?? '');
    const bt = Date.parse(best?.dateTime ?? '');
    if (!Number.isFinite(t)) return best;
    if (!Number.isFinite(bt)) return x;
    return t > bt ? x : best;
  }, list[0]);
};


// Field paths below were confirmed against a real 4-camera FLEX-M account on
// 2026-08-27 via --inspect. The generic findFirst() hunts remain as fallbacks,
// since other SpyPoint models may lay their documents out differently.
//
// Location arrives as a GeoJSON Point (status.coordinates[0].position), so
// `coordinates` is [longitude, latitude] — NOT the other way round. This was
// verified, not assumed: the same object carries DMS strings, and converting
// them reproduces the numeric array with longitude in slot 0. Transposing it
// drops a Wisconsin camera into Asia, and a map renders that without
// complaining, so test/extract.test.js pins the ordering. Do not "fix" this.
function cameraSummary(cam) {
  const st = cam?.status ?? {};
  // Newest fix, NOT coordinates[0] — see newestBy above.
  const gps = newestBy(st.coordinates);
  const pos = gps?.position?.coordinates;
  const geo = Array.isArray(pos) && isNum(pos[0]) && isNum(pos[1]);
  const power = first(st.powerSources);
  // status.signal is an object, so an earlier "first number named signal" hunt
  // silently found nothing and every camera reported an unknown signal.
  const sig = st.signal ?? {};
  const sub = first(cam?.subscriptions);

  return {
    id: String(cam?.id ?? ''),
    name: cam?.config?.name
      ?? findFirst(cam, /^name$/i, v => typeof v === 'string' && v.length > 0)?.value
      ?? String(cam?.id ?? 'camera'),
    model: st.model ?? findFirst(cam, /^model$/i, v => typeof v === 'string')?.value ?? null,
    lat: geo ? pos[1] : findFirst(cam, /^lat(itude)?$/i, isNum)?.value ?? null,
    lng: geo ? pos[0] : findFirst(cam, /^(lng|lon|long|longitude)$/i, isNum)?.value ?? null,
    gpsFix: gps?.dateTime ?? null,
    battery: power?.percentage ?? first(st.batteries)
      ?? findFirst(cam, /batter/i, isNum)?.value ?? null,
    batteryLevel: power?.level ?? first(st.batteryLevels) ?? null,
    batterySource: power?.type ?? st.batteryType ?? null,
    signal: sig.processed?.percentage ?? null,
    signalBars: sig.processed?.bar ?? sig.bar ?? null,
    signalLevel: sig.processed?.level ?? null,
    signalType: sig.type ?? null,
    tempValue: st.temperature?.value ?? null,
    tempUnit: st.temperature?.unit ?? null,
    memUsed: st.memory?.used ?? null,
    memSize: st.memory?.size ?? null,
    plan: sub?.plan?.name ?? null,
    photoCount: sub?.photoCount ?? null,
    photoLimit: sub?.photoLimit ?? sub?.plan?.photoCountPerMonth ?? null,
    // The billing cycle the counts above are measured against. Without these
    // the usage is a bare fraction with no rate behind it, and the camera that
    // is about to go silent looks the same as the one that will coast to the
    // end of the month. `monthEndBillingCycle` is the same instant on every
    // document seen so far; it stands in only if the primary is missing.
    cycleStart: sub?.startDateBillingCycle ?? null,
    cycleEnd: sub?.endDateBillingCycle ?? sub?.monthEndBillingCycle ?? null,
    lastSeen: st.lastUpdate
      ?? findFirst(cam, /last.?(update|sync|comm|photo)/i, v => typeof v === 'string')?.value ?? null,
  };
}

const DATE_KEYS = ['originDate', 'date', 'createDate', 'creationDate', 'dateTime'];

export default {
  id: 'spypoint',
  label: 'SpyPoint',
  envPrefix: 'SPYPOINT',
  implemented: true,

  async login(email, password) {
    let auth;
    try {
      auth = await api('POST', '/user/login', { body: { username: email, password } });
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        const e = new Error('SpyPoint rejected the login — check SPYPOINT_EMAIL / SPYPOINT_PASSWORD.');
        e.credentials = true;
        throw e;
      }
      throw err;
    }
    if (!auth?.token) {
      throw new Error('login response carried no token — the API may have changed. '
        + `Keys seen: ${Object.keys(auth ?? {}).join(', ')}`);
    }
    return { token: auth.token, uuid: auth.uuid ?? null };
  },

  async cameras(session) {
    const list = await api('GET', '/camera/all', { token: session.token });
    if (!Array.isArray(list)) {
      throw new Error('camera/all did not return an array — the API may have changed.');
    }
    return list;
  },

  async photos(session, cameraId, before, limit = 100) {
    const raw = await api('POST', '/photo/all', {
      token: session.token,
      body: { camera: [cameraId], dateEnd: before, favorite: false, hd: false, limit, tag: [] },
    });
    return { photos: raw?.photos ?? [], raw };
  },

  normalizeCamera: cameraSummary,

  photoDate(p) {
    for (const k of DATE_KEYS) {
      if (typeof p?.[k] === 'string' && !Number.isNaN(Date.parse(p[k]))) return p[k];
    }
    const hit = findFirst(p, /date|time/i,
      v => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
    return hit?.value ?? null;
  },

  photoUrl(p, prefer = 'large') {
    for (const size of [prefer, 'large', 'medium', 'small']) {
      const s = p?.[size];
      if (!s?.host || !s?.path) continue;
      // host is normally a bare CDN hostname, but tolerate one that already
      // carries a scheme: blindly prefixing would yield "https://https://..."
      // and a broken link that only shows up as a failed download.
      return s.host.includes('://')
        ? `${s.host.replace(/\/$/, '')}/${s.path}`
        : `https://${s.host}/${s.path}`;
    }
    return null;
  },

  photoId: p => String(p?.id ?? ''),
  photoTags: p => p?.tag ?? p?.tags ?? [],
};

export { walk, findFirst, cameraSummary, newestBy };
