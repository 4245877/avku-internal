import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AREA_CENTER, distanceMeters, unprojectFromMeters } from './geo.js';
import {
  SHIPPED_WORKSPACE_AREA,
  coordinatesFromRing,
  coversFootprint,
  filterHousesToWorkspace,
  getWorkspaceArea,
  getWorkspaceMeta,
  isInsideWorkspace,
  hydrateWorkspaceArea,
  resetWorkspaceAreaToShipped,
  restoreShippedWorkspaceArea,
  ringFromCoordinates,
  saveWorkspaceArea,
  subscribeToWorkspaceArea,
  toLeafletLatLngs,
  toWorkspaceFeature,
  workspaceBoundingBox,
  workspaceCoverRadiusMeters,
} from './workspaceArea.js';

/** A small square footprint at a metre offset from the campaign address. */
function footprintAt({ x, y }, size = 20) {
  return [
    { x: x - size, y: y - size },
    { x: x + size, y: y - size },
    { x: x + size, y: y + size },
    { x: x - size, y: y + size },
  ].map((point) => unprojectFromMeters(point));
}

describe('the shipped boundary file', () => {
  it('parses into at least one closed ring of real coordinates', () => {
    expect(SHIPPED_WORKSPACE_AREA.rings.length).toBeGreaterThanOrEqual(1);
    expect(SHIPPED_WORKSPACE_AREA.outerRing.length).toBeGreaterThanOrEqual(3);

    for (const point of SHIPPED_WORKSPACE_AREA.outerRing) {
      expect(Number.isFinite(point.lat)).toBe(true);
      expect(Number.isFinite(point.lon)).toBe(true);
    }
  });

  it('drops the repeated closing vertex GeoJSON requires', () => {
    expect(SHIPPED_WORKSPACE_AREA.outerRing[0]).not.toEqual(
      SHIPPED_WORKSPACE_AREA.outerRing.at(-1),
    );
  });

  it('covers the campaign address it was drawn around', () => {
    expect(isInsideWorkspace(AREA_CENTER)).toBe(true);
  });

  it('reports bounds that contain every vertex', () => {
    const [[south, west], [north, east]] = SHIPPED_WORKSPACE_AREA.bounds;

    for (const point of SHIPPED_WORKSPACE_AREA.outerRing) {
      expect(point.lat).toBeGreaterThanOrEqual(south);
      expect(point.lat).toBeLessThanOrEqual(north);
      expect(point.lon).toBeGreaterThanOrEqual(west);
      expect(point.lon).toBeLessThanOrEqual(east);
    }
  });

  it('measures a plausible district-sized ground area', () => {
    expect(SHIPPED_WORKSPACE_AREA.areaSqm).toBeGreaterThan(1e6);
    expect(SHIPPED_WORKSPACE_AREA.areaSqm).toBeLessThan(1e9);
  });
});

describe('ringFromCoordinates / coordinatesFromRing', () => {
  it('round-trips a ring through GeoJSON order', () => {
    const ring = [
      { lat: 50.1, lon: 30.1 },
      { lat: 50.2, lon: 30.2 },
      { lat: 50.3, lon: 30.05 },
    ];

    const coordinates = coordinatesFromRing(ring);

    expect(coordinates[0]).toEqual([30.1, 50.1]);
    expect(coordinates.at(-1)).toEqual(coordinates[0]);
    expect(ringFromCoordinates(coordinates)).toEqual(ring);
  });

  it('rejects a non-numeric coordinate instead of silently drawing NaN', () => {
    expect(() => ringFromCoordinates([['x', 50]])).toThrow(/координата/);
  });
});

describe('isInsideWorkspace', () => {
  it('rejects a point far outside the territory', () => {
    expect(isInsideWorkspace({ lat: AREA_CENTER.lat, lon: AREA_CENTER.lon + 1 })).toBe(false);
  });
});

describe('coversFootprint', () => {
  it('keeps a building well inside the territory', () => {
    expect(coversFootprint(footprintAt({ x: 0, y: 0 }))).toBe(true);
  });

  it('drops a building far outside it', () => {
    const radius = workspaceCoverRadiusMeters();

    expect(coversFootprint(footprintAt({ x: radius * 3, y: 0 }))).toBe(false);
  });

  it('keeps a building that straddles the border', () => {
    // Walk east until the boundary is crossed, then sit a footprint on it.
    let crossing = 0;

    while (crossing < 200000 && isInsideWorkspace(unprojectFromMeters({ x: crossing, y: 0 }))) {
      crossing += 10;
    }

    expect(coversFootprint(footprintAt({ x: crossing, y: 0 }, 30))).toBe(true);
  });

  it('ignores footprints that are not rings', () => {
    expect(coversFootprint(undefined)).toBe(false);
    expect(coversFootprint([{ lat: 50, lon: 30 }])).toBe(false);
  });
});

describe('filterHousesToWorkspace', () => {
  it('keeps only the houses the polygon covers', () => {
    const houses = [
      { id: 'inside', footprint: footprintAt({ x: 0, y: 0 }) },
      { id: 'far-away', footprint: footprintAt({ x: 200000, y: 0 }) },
    ];

    expect(filterHousesToWorkspace(houses).map((house) => house.id)).toEqual(['inside']);
  });
});

describe('workspaceCoverRadiusMeters', () => {
  it('reaches every vertex of the polygon from the campaign address', () => {
    const radius = workspaceCoverRadiusMeters();

    for (const point of SHIPPED_WORKSPACE_AREA.outerRing) {
      expect(distanceMeters(AREA_CENTER, point)).toBeLessThanOrEqual(radius);
    }
  });
});

describe('toWorkspaceFeature', () => {
  it('produces a document the loader can read back', () => {
    const ring = [
      { lat: 50.1, lon: 30.1 },
      { lat: 50.2, lon: 30.2 },
      { lat: 50.3, lon: 30.05 },
    ];

    const feature = toWorkspaceFeature(ring, { name: 'Тест' });

    expect(feature.type).toBe('Feature');
    expect(feature.geometry.type).toBe('Polygon');
    expect(feature.properties.name).toBe('Тест');
    expect(ringFromCoordinates(feature.geometry.coordinates[0])).toEqual(ring);
  });
});

describe('toLeafletLatLngs', () => {
  it('flips coordinates into Leaflet order', () => {
    expect(toLeafletLatLngs([[{ lat: 1, lon: 2 }]])).toEqual([[[1, 2]]]);
  });
});

describe('getWorkspaceMeta', () => {
  it('describes the territory without mentioning a radius', () => {
    const meta = getWorkspaceMeta();

    expect(meta.vertexCount).toBe(SHIPPED_WORKSPACE_AREA.outerRing.length);
    expect(meta.areaSqm).toBe(SHIPPED_WORKSPACE_AREA.areaSqm);
    expect(meta.bounds).toEqual(SHIPPED_WORKSPACE_AREA.bounds);
    expect(meta).not.toHaveProperty('radiusMeters');
  });
});

describe('saving a traced boundary', () => {
  /** A small square around the campaign address, in metres. */
  const tracedRing = [
    { x: -400, y: -400 },
    { x: 400, y: -400 },
    { x: 400, y: 400 },
    { x: -400, y: 400 },
  ].map((point) => unprojectFromMeters(point));

  // These tests are about the store, not about persistence: an unreachable API
  // is the interesting case here, because it is what proves the boundary still
  // takes effect and still survives a reload through the local cache.
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWorkspaceAreaToShipped();
  });

  it('puts the traced polygon in force for every territory predicate', async () => {
    const outside = unprojectFromMeters({ x: 2000, y: 0 });

    expect(isInsideWorkspace(outside)).toBe(true);

    await saveWorkspaceArea(toWorkspaceFeature(tracedRing));

    expect(isInsideWorkspace(AREA_CENTER)).toBe(true);
    expect(isInsideWorkspace(outside)).toBe(false);
    expect(getWorkspaceArea().isCustom).toBe(true);
    expect(getWorkspaceMeta().vertexCount).toBe(4);
  });

  it('re-cuts the house dataset to the new boundary', async () => {
    const houses = [
      { id: 'near', footprint: footprintAt({ x: 0, y: 0 }) },
      { id: 'far', footprint: footprintAt({ x: 2000, y: 0 }) },
    ];

    expect(filterHousesToWorkspace(houses).map((house) => house.id)).toEqual([
      'near',
      'far',
    ]);

    await saveWorkspaceArea(toWorkspaceFeature(tracedRing));

    expect(filterHousesToWorkspace(houses).map((house) => house.id)).toEqual(['near']);
  });

  it('notifies subscribers on save and on a return to the shipped boundary', async () => {
    const seen = [];
    const unsubscribe = subscribeToWorkspaceArea((area) => seen.push(area.vertexCount));

    await saveWorkspaceArea(toWorkspaceFeature(tracedRing));
    await restoreShippedWorkspaceArea();
    unsubscribe();
    await saveWorkspaceArea(toWorkspaceFeature(tracedRing));

    expect(seen).toEqual([4, SHIPPED_WORKSPACE_AREA.outerRing.length]);
  });

  it('survives a reload through storage', async () => {
    await saveWorkspaceArea(toWorkspaceFeature(tracedRing, { name: 'Квартал' }));

    const stored = JSON.parse(window.localStorage.getItem('avku-elections-area-v1'));

    expect(stored.properties.name).toBe('Квартал');
    expect(ringFromCoordinates(stored.geometry.coordinates[0])).toHaveLength(4);
  });

  it('refuses a polygon that encloses nothing', async () => {
    await expect(
      saveWorkspaceArea(toWorkspaceFeature(tracedRing.slice(0, 2))),
    ).rejects.toThrow(/щонайменше 3 точки/);
    expect(getWorkspaceArea().isCustom).toBe(false);
  });

  it('treats saving the shipped outline as a return to it, not a new boundary', async () => {
    await saveWorkspaceArea(toWorkspaceFeature(tracedRing));
    await saveWorkspaceArea(toWorkspaceFeature(SHIPPED_WORKSPACE_AREA.outerRing));

    expect(getWorkspaceArea()).toBe(SHIPPED_WORKSPACE_AREA);
    expect(window.localStorage.getItem('avku-elections-area-v1')).toBeNull();
  });

  it('restores the shipped boundary and forgets the saved one', async () => {
    await saveWorkspaceArea(toWorkspaceFeature(tracedRing));
    await restoreShippedWorkspaceArea();

    expect(getWorkspaceArea()).toBe(SHIPPED_WORKSPACE_AREA);
    expect(window.localStorage.getItem('avku-elections-area-v1')).toBeNull();
  });
});
