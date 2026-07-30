/**
 * Base map providers for the "Вибори" map.
 *
 * The default set is key-free OpenStreetMap raster tiles: real streets, real
 * house outlines, real yards, real house numbers, rendered by the same project
 * the building dataset comes from. Two more OSM-derived styles and Esri's
 * orthophoto are available from the layer switcher.
 *
 * Commercial providers plug in here and nowhere else. Set the matching token in
 * `.env` and the layer appears in the switcher automatically:
 *
 *   VITE_MAPTILER_KEY=…   MapTiler Streets (vector-derived raster)
 *   VITE_MAPBOX_TOKEN=…   Mapbox Streets
 *
 * Google Maps is deliberately not a tile layer: its terms forbid pulling tiles
 * into a third-party renderer, so switching to it means swapping Leaflet for the
 * Maps JavaScript API — a change contained to `useLeafletMap` and this file.
 */

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const BASE_PROVIDERS = [
  {
    id: 'osm',
    label: 'Схема OSM',
    hint: 'Вулиці, будинки та номери',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
    maxNativeZoom: 19,
  },
  {
    id: 'carto-voyager',
    label: 'Світла схема',
    hint: 'Спокійніші кольори під розмітку',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd',
    attribution: `${OSM_ATTRIBUTION}, © <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 20,
    maxNativeZoom: 20,
  },
  {
    id: 'carto-light',
    label: 'Мінімальна',
    hint: 'Майже без кольору — для щільних районів',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd',
    attribution: `${OSM_ATTRIBUTION}, © <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 20,
    maxNativeZoom: 20,
  },
  {
    id: 'esri-imagery',
    label: 'Супутник',
    hint: 'Ортофото Esri',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Знімки © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    maxZoom: 20,
    maxNativeZoom: 19,
    isImagery: true,
  },
];

function commercialProviders(env) {
  const providers = [];

  if (env.VITE_MAPTILER_KEY) {
    providers.push({
      id: 'maptiler-streets',
      label: 'MapTiler',
      hint: 'Комерційний провайдер',
      url: `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}{r}.png?key=${env.VITE_MAPTILER_KEY}`,
      attribution: `${OSM_ATTRIBUTION}, © <a href="https://www.maptiler.com/copyright/">MapTiler</a>`,
      maxZoom: 22,
      maxNativeZoom: 20,
    });
  }

  if (env.VITE_MAPBOX_TOKEN) {
    providers.push({
      id: 'mapbox-streets',
      label: 'Mapbox',
      hint: 'Комерційний провайдер',
      url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}{r}?access_token=${env.VITE_MAPBOX_TOKEN}`,
      tileSize: 512,
      zoomOffset: -1,
      attribution: `${OSM_ATTRIBUTION}, © <a href="https://www.mapbox.com/about/maps/">Mapbox</a>`,
      maxZoom: 22,
      maxNativeZoom: 20,
    });
  }

  return providers;
}

/** Every base layer available in this build, in switcher order. */
export const BASEMAPS = [...BASE_PROVIDERS, ...commercialProviders(import.meta.env)];

const requestedDefault = import.meta.env.VITE_MAP_BASEMAP;

export const DEFAULT_BASEMAP_ID =
  BASEMAPS.find((basemap) => basemap.id === requestedDefault)?.id ?? BASEMAPS[0].id;

export function getBasemap(id) {
  return BASEMAPS.find((basemap) => basemap.id === id) ?? BASEMAPS[0];
}
