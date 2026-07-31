/**
 * Base cartography for the "Вибори" map.
 *
 * The page offers two modes and nothing else, because those are the two
 * questions a canvasser actually asks: «Карта» — which street is this and what
 * is its number, and «Супутник» — what does the courtyard, the entrance and the
 * parking actually look like. Both are *layer sets*, not single tile layers:
 *
 *   streets    one raster street map (roads, street names, house numbers).
 *   satellite  orthophoto **plus** a transparent label overlay, so the hybrid
 *              view keeps roads, street names and house numbers over the
 *              imagery instead of turning into an unlabelled photo.
 *
 * Both modes share one zoom window (`MAP_MAX_ZOOM`), which is what lets the
 * switch keep the current zoom: a mode with a lower ceiling would make Leaflet
 * clamp the view the moment it is selected. Where a provider has no tiles that
 * deep, `maxNativeZoom` upscales its last real level instead.
 *
 * Providers, and why these:
 *
 *   OpenStreetMap raster — the street map. Same project the building dataset
 *     comes from, no key, house numbers from z18. Usage policy: attribution,
 *     no bulk download, a real Referer (see `infra/nginx/app.conf`).
 *   Esri World Imagery — the orthophoto. Public ArcGIS Online service under
 *     the Esri Master License Agreement; attribution required, tile export for
 *     offline use is not permitted. Real imagery over Kyiv reaches z19.
 *   CARTO Voyager labels — the transparent hybrid overlay. Free for
 *     non-commercial use with attribution; it is the piece that carries street
 *     names *and* house numbers over the photo.
 *
 * Commercial providers plug in here and nowhere else — set a token in `.env`
 * and both modes move to it, one provider for the whole map:
 *
 *   VITE_MAPTILER_KEY=…   MapTiler Streets + MapTiler Satellite Hybrid
 *   VITE_MAPBOX_TOKEN=…   Mapbox Streets + Mapbox Satellite Streets
 *
 * Google Maps is deliberately absent: its terms forbid pulling tiles into a
 * third-party renderer, so using it would mean swapping Leaflet for the Maps
 * JavaScript API — not a tile-layer change.
 */

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const CARTO_ATTRIBUTION = '© <a href="https://carto.com/attributions">CARTO</a>';

/** The service's own `copyrightText`, as its terms of use require. */
const ESRI_ATTRIBUTION =
  'Знімки © <a href="https://www.esri.com/">Esri</a>, Vantor, Earthstar Geographics';

/**
 * The zoom ceiling of the map itself, shared by every mode. Deeper than any
 * provider serves on purpose: the last real tile level is stretched rather than
 * refused, which is what a canvasser standing in a courtyard wants.
 */
export const MAP_MAX_ZOOM = 20;

/** CSS hooks: the theme treats a street map and an orthophoto differently. */
const STREETS_CLASS = 'elections-basemap-tiles';
const IMAGERY_CLASS = 'elections-basemap-imagery';
const LABELS_CLASS = 'elections-basemap-labels';

/** Leaflet pane holding the hybrid labels — above tiles, below the houses. */
export const LABELS_PANE = 'elections-basemap-labels';

const osmStreets = () => ({
  base: {
    id: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTRIBUTION,
    // No @2x tiles exist, and `detectRetina` would silently double the request
    // count against a donated service to get the same pixels.
    detectRetina: false,
    maxNativeZoom: 19,
    className: STREETS_CLASS,
  },
  overlays: [],
  provider: 'OpenStreetMap',
});

const esriHybrid = () => ({
  base: {
    id: 'esri-imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: ESRI_ATTRIBUTION,
    detectRetina: false,
    // The service answers above this, but with a "no imagery" placeholder
    // rather than pixels — upscaling z19 is the honest picture.
    maxNativeZoom: 19,
    className: IMAGERY_CLASS,
  },
  overlays: [
    {
      id: 'carto-voyager-labels',
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
      subdomains: 'abcd',
      attribution: `${OSM_ATTRIBUTION}, ${CARTO_ATTRIBUTION}`,
      detectRetina: true,
      maxNativeZoom: 20,
      className: LABELS_CLASS,
      pane: LABELS_PANE,
    },
  ],
  provider: 'Esri World Imagery + CARTO',
});

const maptiler = (key) => ({
  streets: {
    base: {
      id: 'maptiler-streets',
      url: `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}{r}.png?key=${key}`,
      attribution: `${OSM_ATTRIBUTION}, © <a href="https://www.maptiler.com/copyright/">MapTiler</a>`,
      detectRetina: true,
      maxNativeZoom: 20,
      className: STREETS_CLASS,
    },
    overlays: [],
    provider: 'MapTiler',
  },
  satellite: {
    base: {
      // MapTiler's hybrid style already carries roads, street names and house
      // numbers over the imagery, so this mode needs no overlay.
      id: 'maptiler-hybrid',
      url: `https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}{r}.jpg?key=${key}`,
      attribution: `${OSM_ATTRIBUTION}, © <a href="https://www.maptiler.com/copyright/">MapTiler</a>`,
      detectRetina: true,
      maxNativeZoom: 20,
      className: IMAGERY_CLASS,
    },
    overlays: [],
    provider: 'MapTiler Satellite Hybrid',
  },
});

const mapbox = (token) => {
  const style = (id) => ({
    url: `https://api.mapbox.com/styles/v1/mapbox/${id}/tiles/512/{z}/{x}/{y}{r}?access_token=${token}`,
    attribution: `${OSM_ATTRIBUTION}, © <a href="https://www.mapbox.com/about/maps/">Mapbox</a>`,
    // 512-pixel tiles cover two zoom levels' worth of ground, which is what the
    // offset corrects for.
    tileSize: 512,
    zoomOffset: -1,
    detectRetina: false,
    maxNativeZoom: 20,
  });

  return {
    streets: {
      base: { id: 'mapbox-streets', ...style('streets-v12'), className: STREETS_CLASS },
      overlays: [],
      provider: 'Mapbox',
    },
    satellite: {
      base: {
        id: 'mapbox-satellite-streets',
        ...style('satellite-streets-v12'),
        className: IMAGERY_CLASS,
      },
      overlays: [],
      provider: 'Mapbox Satellite Streets',
    },
  };
};

/**
 * Which provider serves both modes. A token makes it the map's provider; an
 * explicit `VITE_MAP_PROVIDER` wins over that, and falls back to the key-free
 * set rather than to a blank map when its token is missing.
 */
function resolveProvider(env) {
  const requested = env.VITE_MAP_PROVIDER;

  if (requested === 'osm') {
    return 'osm';
  }

  if (requested === 'maptiler' && env.VITE_MAPTILER_KEY) {
    return 'maptiler';
  }

  if (requested === 'mapbox' && env.VITE_MAPBOX_TOKEN) {
    return 'mapbox';
  }

  if (env.VITE_MAPTILER_KEY) {
    return 'maptiler';
  }

  if (env.VITE_MAPBOX_TOKEN) {
    return 'mapbox';
  }

  return 'osm';
}

/**
 * The two modes for a given environment. Pure, so a build's provider wiring can
 * be asserted in tests without touching `import.meta.env`.
 */
export function buildMapModes(env = {}) {
  const provider = resolveProvider(env);

  let streets = osmStreets();
  let satellite = esriHybrid();

  if (provider === 'maptiler') {
    ({ streets, satellite } = maptiler(env.VITE_MAPTILER_KEY));
  }

  if (provider === 'mapbox') {
    ({ streets, satellite } = mapbox(env.VITE_MAPBOX_TOKEN));
  }

  return [
    {
      id: 'streets',
      label: 'Карта',
      hint: 'Схема: вулиці, назви й номери будинків',
      icon: 'map',
      isImagery: false,
      ...streets,
    },
    {
      id: 'satellite',
      label: 'Супутник',
      hint: 'Знімки з дорогами, назвами вулиць і номерами будинків',
      icon: 'satellite',
      isImagery: true,
      ...satellite,
    },
  ];
}

/** Every mode available in this build, in switcher order. */
export const MAP_MODES = buildMapModes(import.meta.env ?? {});

const requestedDefault = (import.meta.env ?? {}).VITE_MAP_MODE;

export const DEFAULT_MAP_MODE_ID =
  MAP_MODES.find((mode) => mode.id === requestedDefault)?.id ?? MAP_MODES[0].id;

export function getMapMode(id) {
  return MAP_MODES.find((mode) => mode.id === id) ?? MAP_MODES[0];
}

/** Every tile layer a mode is made of, base first. */
export function layersOf(mode) {
  return [mode.base, ...mode.overlays];
}

/**
 * The chosen mode outlives the page: someone who works on imagery expects the
 * imagery back after a reload, and re-picking it every visit is the kind of
 * small friction that makes a tool feel unfinished.
 */
export const MAP_MODE_STORAGE_KEY = 'avku-elections-map-mode-v1';

export function readStoredMapMode() {
  try {
    const stored = window.localStorage?.getItem(MAP_MODE_STORAGE_KEY);

    return MAP_MODES.some((mode) => mode.id === stored) ? stored : null;
  } catch {
    // Private mode or storage disabled — the default is a fine answer.
    return null;
  }
}

export function writeStoredMapMode(id) {
  try {
    window.localStorage?.setItem(MAP_MODE_STORAGE_KEY, id);

    return true;
  } catch {
    return false;
  }
}
