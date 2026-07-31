import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAP_MODE_ID,
  MAP_MAX_ZOOM,
  MAP_MODES,
  MAP_MODE_STORAGE_KEY,
  buildMapModes,
  getMapMode,
  layersOf,
  readStoredMapMode,
  writeStoredMapMode,
} from './basemaps.js';

const modeOf = (modes, id) => modes.find((mode) => mode.id === id);

describe('map modes', () => {
  it('offers exactly the two modes the switcher shows', () => {
    expect(MAP_MODES.map((mode) => mode.id)).toEqual(['streets', 'satellite']);
    expect(MAP_MODES.map((mode) => mode.label)).toEqual(['Карта', 'Супутник']);
  });

  it('falls back to the first mode for an unknown id', () => {
    expect(getMapMode('nope').id).toBe('streets');
    expect(getMapMode(undefined).id).toBe('streets');
    expect(getMapMode('satellite').id).toBe('satellite');
  });

  it('defaults to a mode that exists', () => {
    expect(MAP_MODES.some((mode) => mode.id === DEFAULT_MAP_MODE_ID)).toBe(true);
  });
});

describe('key-free providers', () => {
  const modes = buildMapModes({});

  it('serves streets from OpenStreetMap', () => {
    const streets = modeOf(modes, 'streets');

    expect(streets.base.url).toContain('tile.openstreetmap.org');
    expect(streets.isImagery).toBe(false);
    expect(streets.overlays).toHaveLength(0);
  });

  /* The whole point of the satellite mode: a photo with the streets still on
   * it. A base layer with no label overlay would be a regression. */
  it('serves satellite as a hybrid — imagery plus a label overlay', () => {
    const satellite = modeOf(modes, 'satellite');

    expect(satellite.base.url).toContain('World_Imagery');
    expect(satellite.isImagery).toBe(true);
    expect(satellite.overlays).toHaveLength(1);
    expect(satellite.overlays[0].url).toContain('voyager_only_labels');
    expect(satellite.overlays[0].pane).toBeTruthy();
  });

  it('attributes every layer of every mode', () => {
    for (const mode of modes) {
      for (const layer of layersOf(mode)) {
        expect(layer.attribution).toBeTruthy();
      }
    }
  });

  it('never asks a keyless service for retina tiles it does not have', () => {
    expect(modeOf(modes, 'streets').base.detectRetina).toBe(false);
    expect(modeOf(modes, 'satellite').base.detectRetina).toBe(false);
  });
});

describe('commercial providers', () => {
  it('moves both modes to MapTiler when a key is configured', () => {
    const modes = buildMapModes({ VITE_MAPTILER_KEY: 'test-key' });

    expect(modeOf(modes, 'streets').base.url).toContain('api.maptiler.com');
    expect(modeOf(modes, 'streets').base.url).toContain('key=test-key');
    // MapTiler's hybrid style already carries the labels, so no overlay.
    expect(modeOf(modes, 'satellite').base.url).toContain('maps/hybrid');
    expect(modeOf(modes, 'satellite').overlays).toHaveLength(0);
  });

  it('moves both modes to Mapbox when a token is configured', () => {
    const modes = buildMapModes({ VITE_MAPBOX_TOKEN: 'test-token' });

    expect(modeOf(modes, 'streets').base.url).toContain('streets-v12');
    expect(modeOf(modes, 'satellite').base.url).toContain('satellite-streets-v12');
    expect(modeOf(modes, 'satellite').base.tileSize).toBe(512);
    expect(modeOf(modes, 'satellite').base.zoomOffset).toBe(-1);
  });

  it('prefers MapTiler when both tokens are present', () => {
    const modes = buildMapModes({
      VITE_MAPTILER_KEY: 'test-key',
      VITE_MAPBOX_TOKEN: 'test-token',
    });

    expect(modeOf(modes, 'streets').base.url).toContain('api.maptiler.com');
  });

  it('honours an explicit provider choice', () => {
    const modes = buildMapModes({
      VITE_MAP_PROVIDER: 'osm',
      VITE_MAPTILER_KEY: 'test-key',
    });

    expect(modeOf(modes, 'streets').base.url).toContain('tile.openstreetmap.org');
  });

  /* A provider named without its token would otherwise produce a map of 403s. */
  it('falls back to the keyless set when the named provider has no token', () => {
    const modes = buildMapModes({ VITE_MAP_PROVIDER: 'mapbox' });

    expect(modeOf(modes, 'streets').base.url).toContain('tile.openstreetmap.org');
  });
});

/*
 * One zoom window for every mode is what lets the switch keep the view: a mode
 * with a lower ceiling would make Leaflet clamp the zoom the moment it is
 * selected, and the user would land somewhere they never asked to be.
 */
describe('zoom window', () => {
  it('never lets a layer set cap the map', () => {
    for (const env of [{}, { VITE_MAPTILER_KEY: 'k' }, { VITE_MAPBOX_TOKEN: 't' }]) {
      for (const mode of buildMapModes(env)) {
        for (const layer of layersOf(mode)) {
          expect(layer.maxNativeZoom).toBeLessThanOrEqual(MAP_MAX_ZOOM);
          expect(layer.maxZoom).toBeUndefined();
        }
      }
    }
  });
});

describe('remembering the chosen mode', () => {
  afterEach(() => window.localStorage.clear());

  it('round-trips a mode through storage', () => {
    expect(writeStoredMapMode('satellite')).toBe(true);
    expect(window.localStorage.getItem(MAP_MODE_STORAGE_KEY)).toBe('satellite');
    expect(readStoredMapMode()).toBe('satellite');
  });

  it('reports no preference when nothing was stored', () => {
    expect(readStoredMapMode()).toBeNull();
  });

  /* A mode that no longer exists — a provider removed between deploys — must
   * not leave the map pointing at nothing. */
  it('ignores a stored mode this build does not have', () => {
    window.localStorage.setItem(MAP_MODE_STORAGE_KEY, 'terrain');

    expect(readStoredMapMode()).toBeNull();
  });
});
