/**
 * tile-sources.mjs — where map imagery comes from, in one place.
 *
 * This exists because the list used to live inside the dashboard's inline
 * script, which was fine until the server needed to fetch the same tiles to
 * cache them. Two copies of a URL table is two copies that drift, and the
 * symptom of drift here is a map that silently shows the wrong imagery or
 * caches tiles nobody asks for. So the server owns the list, and the page is
 * handed whatever templates it should use.
 *
 * A source is described rather than coded, so the description can be sent to
 * the browser as JSON:
 *
 *   kind 'xyz'    — the usual slippy-map order, /{z}/{x}/{y}
 *   kind 'zyx'    — Esri and USGS put row before column, /{z}/{y}/{x}
 *   kind 'export' — ArcGIS MapServers with no tile cache: each tile is an
 *                   image request for a bounding box, which has to be in Web
 *                   Mercator metres to line up with everything else
 *
 * Both the server and the page expand templates with expandTile() below, so
 * there is one implementation and a test can prove they agree.
 */

// Half the circumference of the earth in Web Mercator metres — the constant
// that makes 'export' sources line up with slippy tiles.
export const MERC = 20037508.342789244;

export function tileBounds3857(z, x, y) {
  const size = 2 * MERC / 2 ** z;
  return [
    -MERC + x * size,
    MERC - (y + 1) * size,
    -MERC + (x + 1) * size,
    MERC - y * size,
  ].join(',');
}

export function expandTile(source, z, x, y) {
  return source.template
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
    .replace('{bbox3857}', () => tileBounds3857(z, x, y));
}

const DNR = 'https://dnrmaps.wi.gov/arcgis/rest/services/';
const dnrExport = service =>
  DNR + service + '/MapServer/export?bbox={bbox3857}'
  + '&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image';

/** Base maps: exactly one is shown at a time. */
export const BASE_SOURCES = {
  map: {
    key: 'map', label: 'Map', alt: 'Satellite', maxZoom: 19, kind: 'xyz',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    // OpenStreetMap's tile usage policy forbids bulk downloading. Caching what
    // you have actually looked at is ordinary client behaviour; pre-fetching an
    // area is not, which is why "save this view" is bounded and why this flag
    // exists rather than a comment nobody reads.
    bulkAllowed: false,
  },
  satellite: {
    key: 'satellite', label: 'Satellite', alt: 'Map', maxZoom: 19, kind: 'zyx',
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
    bulkAllowed: true,
  },
  hybrid: {
    key: 'hybrid', label: 'Hybrid', alt: 'Map', maxZoom: 19, kind: 'zyx',
    template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    overlayTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
    bulkAllowed: true,
  },
  topo: {
    key: 'topo', label: 'Terrain', alt: 'Map', maxZoom: 17, kind: 'zyx',
    template: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    credit: 'Topo © <a href="https://www.usgs.gov/">USGS</a> The National Map',
    bulkAllowed: true,
  },
};

/**
 * Wisconsin DNR overlays — the regulatory layers, free from the state, and any
 * number can be on at once.
 *
 * The labels are deliberately narrow. "Public land" would be wrong and
 * dangerously so: VPA is the Voluntary Public Access programme, meaning PRIVATE
 * land enrolled for public hunting — not state land, and not everywhere you may
 * legally hunt. None of this replaces reading the regulations.
 */
export const OVERLAY_SOURCES = {
  vpa: {
    key: 'vpa', label: 'VPA public access', kind: 'export', maxZoom: 19,
    template: dnrExport('WM_VPA/WM_VPA_HUNT_LEASE_LAND_WTM'),
    note: 'Private land enrolled in the DNR Voluntary Public Access programme. '
      + 'Not all public land, and not a substitute for the regulations.',
    credit: 'Public access © <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a>',
    bulkAllowed: true,
  },
  cwd: {
    key: 'cwd', label: 'CWD areas', kind: 'export', maxZoom: 19,
    template: dnrExport('WM_CWD/WM_CWD_WTM_Ext'),
    note: 'Chronic wasting disease management areas. Baiting and carcass '
      + 'transport rules differ inside these.',
    credit: 'CWD areas © <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a>',
    bulkAllowed: true,
  },
  units: {
    key: 'units', label: 'Deer zones', kind: 'export', maxZoom: 19,
    template: dnrExport('WM_CWD/WM_DEER_MANAGEMENT_ZONES_WTM_Ext'),
    note: 'DNR deer management zones — which unit your tag is valid in.',
    credit: 'Deer zones © <a href="https://dnr.wisconsin.gov/">Wisconsin DNR</a>',
    bulkAllowed: true,
  },
};

export const ALL_SOURCES = { ...BASE_SOURCES, ...OVERLAY_SOURCES };

// The hybrid base map paints a second, transparent tile of place names over the
// imagery. It is addressed as its own source so the cache and the proxy do not
// need a special case for it.
export const REFERENCE_SOURCE = {
  key: 'hybrid-ref', label: 'Place names', kind: 'zyx', maxZoom: 19,
  template: BASE_SOURCES.hybrid.overlayTemplate,
  credit: BASE_SOURCES.hybrid.credit,
  bulkAllowed: true,
};

export const sourceByKey = key =>
  key === REFERENCE_SOURCE.key ? REFERENCE_SOURCE : (ALL_SOURCES[key] ?? null);

/**
 * What the page is told. Two shapes:
 *
 *   served  — every template points at this server, which caches on the way
 *             through, so the page needs no knowledge of upstream URLs at all
 *   static  — the file written by the sync has no server to ask, so it gets the
 *             upstream templates and talks to them directly
 */
export function sourceDescriptors({ proxied }) {
  const strip = src => ({
    key: src.key, label: src.label, alt: src.alt ?? null, maxZoom: src.maxZoom,
    credit: src.credit, note: src.note ?? null,
    kind: proxied ? 'xyz' : src.kind,
    template: proxied ? `/tiles/${src.key}/{z}/{x}/{y}` : src.template,
  });
  return {
    base: Object.fromEntries(Object.entries(BASE_SOURCES).map(([k, v]) => [k, {
      ...strip(v),
      reference: k === 'hybrid'
        ? (proxied ? `/tiles/${REFERENCE_SOURCE.key}/{z}/{x}/{y}` : v.overlayTemplate)
        : null,
    }])),
    overlays: Object.fromEntries(Object.entries(OVERLAY_SOURCES).map(([k, v]) => [k, strip(v)])),
  };
}
