import { describe, expect, it } from 'vitest';

import {
  AREA_CENTER,
  AREA_RADIUS_METERS,
  distanceMeters,
  formatDistance,
  isInsideArea,
  projectToMeters,
  ringAreaSquareMeters,
  ringBounds,
  ringCentroid,
  ringDimensions,
  unprojectFromMeters,
} from './geo.js';

/** Builds a WGS84 ring from local-grid offsets, in metres. */
const ringOf = (points) => points.map((point) => unprojectFromMeters(point));

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

describe('AREA_CENTER', () => {
  it('is the OSM position of вулиця Зодчих, 58А', () => {
    expect(AREA_CENTER.lat).toBeCloseTo(50.43076, 4);
    expect(AREA_CENTER.lon).toBeCloseTo(30.36405, 4);
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

describe('ring helpers', () => {
  // A 40 × 20 m block, the shape of a small apartment building.
  const block = ringOf([
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ]);

  it('finds the centroid of a rectangle', () => {
    const centroid = projectToMeters(ringCentroid(block));

    expect(centroid.x).toBeCloseTo(20, 2);
    expect(centroid.y).toBeCloseTo(10, 2);
  });

  it('falls back to the first vertex for a degenerate ring', () => {
    const point = { lat: 50.1, lon: 30.1 };

    expect(ringCentroid([point, point])).toEqual(point);
  });

  it('measures ground area in square metres', () => {
    expect(ringAreaSquareMeters(block)).toBeCloseTo(800, 0);
  });

  it('reports the long side and the depth of a footprint', () => {
    const { length, width } = ringDimensions(block);

    expect(length).toBeCloseTo(40, 1);
    expect(width).toBeCloseTo(20, 1);
  });

  it('measures a rotated footprint by its own axes, not the compass', () => {
    const angle = Math.PI / 6;
    const rotated = ringOf(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 20 },
        { x: 0, y: 20 },
      ].map((point) => ({
        x: point.x * Math.cos(angle) - point.y * Math.sin(angle),
        y: point.x * Math.sin(angle) + point.y * Math.cos(angle),
      })),
    );

    const { length, width } = ringDimensions(rotated);

    expect(length).toBeCloseTo(40, 0);
    expect(width).toBeCloseTo(20, 0);
  });

  it('returns Leaflet-shaped bounds', () => {
    const [[south, west], [north, east]] = ringBounds(block);

    expect(north).toBeGreaterThan(south);
    expect(east).toBeGreaterThan(west);
    expect(south).toBeCloseTo(Math.min(...block.map((point) => point.lat)), 9);
    expect(east).toBeCloseTo(Math.max(...block.map((point) => point.lon)), 9);
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
