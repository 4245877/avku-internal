import { describe, expect, it } from 'vitest';

import {
  AREA_CENTER,
  AREA_RADIUS_METERS,
  distanceMeters,
  formatDistance,
  isInsideArea,
  polygonBounds,
  polygonCentroid,
  polygonToPath,
  polylineToPath,
  projectFootprint,
  projectToMeters,
  unprojectFromMeters,
} from './geo.js';

describe('projection', () => {
  it('places the campaign address at the grid origin', () => {
    const origin = projectToMeters(AREA_CENTER);

    expect(origin.x).toBeCloseTo(0, 6);
    expect(origin.y).toBeCloseTo(0, 6);
  });

  it('round-trips a point through the local grid', () => {
    const point = { x: 1234.5, y: -678.9 };
    const projected = projectToMeters(unprojectFromMeters(point));

    expect(projected.x).toBeCloseTo(point.x, 6);
    expect(projected.y).toBeCloseTo(point.y, 6);
  });

  it('grows x to the east and y to the south', () => {
    const east = projectToMeters({ lat: AREA_CENTER.lat, lon: AREA_CENTER.lon + 0.01 });
    const south = projectToMeters({ lat: AREA_CENTER.lat - 0.01, lon: AREA_CENTER.lon });

    expect(east.x).toBeGreaterThan(0);
    expect(east.y).toBeCloseTo(0, 6);
    expect(south.y).toBeGreaterThan(0);
    expect(south.x).toBeCloseTo(0, 6);
  });

  it('agrees with the great-circle distance at district scale', () => {
    for (const offset of [{ x: 1000, y: 0 }, { x: 0, y: 2000 }, { x: -1500, y: 1500 }]) {
      const expected = Math.hypot(offset.x, offset.y);
      const measured = distanceMeters(AREA_CENTER, unprojectFromMeters(offset));

      // Equirectangular error stays well under a metre inside a 3 km radius.
      expect(Math.abs(measured - expected)).toBeLessThan(1);
    }
  });
});

describe('isInsideArea', () => {
  it('accepts points inside the radius and rejects points outside it', () => {
    expect(isInsideArea(unprojectFromMeters({ x: 2900, y: 0 }))).toBe(true);
    expect(isInsideArea(unprojectFromMeters({ x: 3100, y: 0 }))).toBe(false);
    expect(isInsideArea(unprojectFromMeters({ x: 2500, y: 2500 }))).toBe(false);
  });

  it('uses the module radius by default', () => {
    expect(AREA_RADIUS_METERS).toBe(3000);
  });
});

describe('polygon helpers', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('finds the centroid of a square', () => {
    expect(polygonCentroid(square)).toEqual({ x: 5, y: 5 });
  });

  it('falls back to the first vertex for a degenerate ring', () => {
    expect(polygonCentroid([{ x: 3, y: 4 }, { x: 3, y: 4 }])).toEqual({ x: 3, y: 4 });
  });

  it('computes axis-aligned bounds', () => {
    expect(polygonBounds(square)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it('serialises closed and open paths', () => {
    expect(polygonToPath(square)).toBe('M0.0 0.0 L10.0 0.0 L10.0 10.0 L0.0 10.0 Z');
    expect(polylineToPath(square.slice(0, 2))).toBe('M0.0 0.0 L10.0 0.0');
  });
});

describe('projectFootprint', () => {
  const footprint = [
    { lat: AREA_CENTER.lat, lon: AREA_CENTER.lon },
    { lat: AREA_CENTER.lat, lon: AREA_CENTER.lon + 0.0005 },
    { lat: AREA_CENTER.lat - 0.0003, lon: AREA_CENTER.lon + 0.0005 },
  ];

  it('projects every vertex of the ring', () => {
    const projected = projectFootprint(footprint);

    expect(projected).toHaveLength(3);
    expect(projected[0].x).toBeCloseTo(0, 6);
    expect(projected[1].x).toBeGreaterThan(0);
  });

  it('caches by ring identity so edits do not re-project the district', () => {
    expect(projectFootprint(footprint)).toBe(projectFootprint(footprint));
  });
});

describe('formatDistance', () => {
  it('rounds short distances to tens of metres', () => {
    expect(formatDistance(0)).toBe('0 м');
    expect(formatDistance(124)).toBe('120 м');
    expect(formatDistance(949)).toBe('950 м');
  });

  it('switches to kilometres with a decimal comma', () => {
    expect(formatDistance(1000)).toBe('1,0 км');
    expect(formatDistance(2500)).toBe('2,5 км');
  });

  it('handles missing values', () => {
    expect(formatDistance(undefined)).toBe('—');
    expect(formatDistance(Number.NaN)).toBe('—');
  });
});
