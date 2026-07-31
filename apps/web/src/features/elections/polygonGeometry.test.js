import { describe, expect, it } from 'vitest';

import {
  boxesOverlap,
  isPointInPolygon,
  isPointInRing,
  isRingInsideRing,
  isRingSelfIntersecting,
  polygonIntersectsRing,
  ringBox,
  ringsOverlap,
  segmentsIntersect,
} from './polygonGeometry.js';

/** A square ring, given its centre and half-size in degrees. */
function square({ lat = 0, lon = 0, size = 1 } = {}) {
  return [
    { lat: lat - size, lon: lon - size },
    { lat: lat - size, lon: lon + size },
    { lat: lat + size, lon: lon + size },
    { lat: lat + size, lon: lon - size },
  ];
}

const OUTER = square({ size: 10 });
const HOLE = square({ size: 2 });

describe('ringBox', () => {
  it('spans every vertex', () => {
    expect(ringBox(square({ lat: 5, lon: -3, size: 2 }))).toEqual({
      minLat: 3,
      maxLat: 7,
      minLon: -5,
      maxLon: -1,
    });
  });
});

describe('boxesOverlap', () => {
  it('accepts touching boxes and rejects separated ones', () => {
    const box = ringBox(square({ size: 1 }));

    expect(boxesOverlap(box, ringBox(square({ lon: 2, size: 1 })))).toBe(true);
    expect(boxesOverlap(box, ringBox(square({ lon: 2.5, size: 1 })))).toBe(false);
  });
});

describe('isPointInRing', () => {
  it('separates inside from outside for a convex ring', () => {
    expect(isPointInRing({ lat: 0, lon: 0 }, OUTER)).toBe(true);
    expect(isPointInRing({ lat: 0, lon: 11 }, OUTER)).toBe(false);
  });

  it('handles a concave ring instead of falling back to its bounding box', () => {
    // A "U": the notch in the middle of the top edge is outside the ring.
    const uShape = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 6 },
      { lat: 6, lon: 6 },
      { lat: 6, lon: 4 },
      { lat: 2, lon: 4 },
      { lat: 2, lon: 2 },
      { lat: 6, lon: 2 },
      { lat: 6, lon: 0 },
    ];

    expect(isPointInRing({ lat: 1, lon: 3 }, uShape)).toBe(true);
    expect(isPointInRing({ lat: 5, lon: 3 }, uShape)).toBe(false);
  });

  it('counts a vertex on the ray once, not once per edge meeting there', () => {
    const diamond = [
      { lat: 0, lon: 0 },
      { lat: 2, lon: 2 },
      { lat: 4, lon: 0 },
      { lat: 2, lon: -2 },
    ];

    // The scan line runs exactly through the left and right vertices.
    expect(isPointInRing({ lat: 2, lon: 0 }, diamond)).toBe(true);
    expect(isPointInRing({ lat: 2, lon: -3 }, diamond)).toBe(false);
  });
});

describe('isPointInPolygon', () => {
  it('treats later rings as holes', () => {
    expect(isPointInPolygon({ lat: 5, lon: 5 }, [OUTER, HOLE])).toBe(true);
    expect(isPointInPolygon({ lat: 0, lon: 0 }, [OUTER, HOLE])).toBe(false);
    expect(isPointInPolygon({ lat: 0, lon: 0 }, [OUTER])).toBe(true);
  });

  it('is false for an empty ring list', () => {
    expect(isPointInPolygon({ lat: 0, lon: 0 }, [])).toBe(false);
  });
});

describe('segmentsIntersect', () => {
  const from = { lat: 0, lon: 0 };
  const to = { lat: 0, lon: 4 };

  it('detects a crossing', () => {
    expect(segmentsIntersect(from, to, { lat: -1, lon: 2 }, { lat: 1, lon: 2 })).toBe(true);
  });

  it('detects a touch at an endpoint', () => {
    expect(segmentsIntersect(from, to, { lat: 0, lon: 4 }, { lat: 3, lon: 4 })).toBe(true);
  });

  it('detects a collinear overlap', () => {
    expect(segmentsIntersect(from, to, { lat: 0, lon: 2 }, { lat: 0, lon: 6 })).toBe(true);
  });

  it('rejects parallel and disjoint segments', () => {
    expect(segmentsIntersect(from, to, { lat: 1, lon: 0 }, { lat: 1, lon: 4 })).toBe(false);
    expect(segmentsIntersect(from, to, { lat: 0, lon: 5 }, { lat: 0, lon: 9 })).toBe(false);
  });
});

describe('ringsOverlap', () => {
  it('accepts a ring that crosses the border', () => {
    expect(ringsOverlap(OUTER, square({ lon: 10, size: 1 }))).toBe(true);
  });

  it('accepts a ring fully inside, in either nesting direction', () => {
    expect(ringsOverlap(OUTER, square({ size: 1 }))).toBe(true);
    expect(ringsOverlap(square({ size: 1 }), OUTER)).toBe(true);
  });

  it('rejects a ring that is entirely elsewhere', () => {
    expect(ringsOverlap(OUTER, square({ lon: 30, size: 1 }))).toBe(false);
  });

  it('rejects degenerate rings', () => {
    expect(ringsOverlap(OUTER, [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }])).toBe(false);
  });
});

describe('isRingInsideRing', () => {
  it('is true only when nothing pokes out', () => {
    expect(isRingInsideRing(square({ size: 1 }), OUTER)).toBe(true);
    expect(isRingInsideRing(square({ lon: 10, size: 1 }), OUTER)).toBe(false);
  });
});

describe('polygonIntersectsRing', () => {
  const rings = [OUTER, HOLE];

  it('accepts a building inside the polygon', () => {
    expect(polygonIntersectsRing(rings, square({ lon: 5, size: 0.5 }))).toBe(true);
  });

  it('accepts a building straddling the border', () => {
    expect(polygonIntersectsRing(rings, square({ lon: 10, size: 0.5 }))).toBe(true);
  });

  it('rejects a building outside the polygon', () => {
    expect(polygonIntersectsRing(rings, square({ lon: 20, size: 0.5 }))).toBe(false);
  });

  it('rejects a building that only sits inside a hole', () => {
    expect(polygonIntersectsRing(rings, square({ size: 0.5 }))).toBe(false);
  });

  it('accepts a building reaching out of a hole into the polygon', () => {
    expect(polygonIntersectsRing(rings, square({ lon: 2, size: 0.5 }))).toBe(true);
  });
});

describe('isRingSelfIntersecting', () => {
  it('accepts a plain outline whose edges only meet at vertices', () => {
    expect(isRingSelfIntersecting(OUTER)).toBe(false);
    expect(isRingSelfIntersecting(square({ size: 1 }))).toBe(false);
  });

  it('accepts anything too short to cross itself', () => {
    expect(isRingSelfIntersecting([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }])).toBe(false);
  });

  it('catches the figure-of-eight a mis-ordered vertex makes', () => {
    const bowtie = [
      { lat: 0, lon: 0 },
      { lat: 1, lon: 1 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 0 },
    ];

    expect(isRingSelfIntersecting(bowtie)).toBe(true);
  });
});
