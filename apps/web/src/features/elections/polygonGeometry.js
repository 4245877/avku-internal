/**
 * Ring geometry for the working-area polygon.
 *
 * Everything here works on WGS84 rings — arrays of `{ lat, lon }` with no
 * repeated closing vertex — and treats lon/lat as plain planar coordinates.
 * Over a city district that is exact enough: the only error is the meridian
 * convergence inside one bounding box, which cannot move a vertex across an
 * edge it was not already sitting on. Anything spanning a pole or the
 * antimeridian would need a real projection; the district does not.
 *
 * The predicates the map depends on are {@link isPointInPolygon} (is this
 * address ours?) and {@link polygonIntersectsRing} (does this building touch
 * our territory at all?) — a house on the border belongs to the district, so
 * "intersects" and not "is contained" is the rule everywhere.
 */

/** Axis-aligned bounding box of a ring, in degrees. */
export function ringBox(ring) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;

  for (const point of ring) {
    minLat = Math.min(minLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLat = Math.max(maxLat, point.lat);
    maxLon = Math.max(maxLon, point.lon);
  }

  return { minLat, minLon, maxLat, maxLon };
}

/**
 * The part of `ring` that falls inside `box`, as a ring — empty when the two do
 * not overlap at all.
 *
 * Sutherland–Hodgman against the four half-planes of the box, which is exact
 * here because the clip region is convex. It exists so that "the dataset does
 * not cover the territory" can be answered in ground area rather than as a
 * bounding-box yes/no: a boundary traced by hand routinely pokes a metre past
 * the downloaded box in one corner, and a warning that cannot tell that sliver
 * from a missing neighbourhood is a warning people learn to ignore.
 */
export function clipRingToBox(ring, box) {
  const edges = [
    { keep: (point) => point.lon >= box.minLon, axis: 'lon', at: box.minLon },
    { keep: (point) => point.lon <= box.maxLon, axis: 'lon', at: box.maxLon },
    { keep: (point) => point.lat >= box.minLat, axis: 'lat', at: box.minLat },
    { keep: (point) => point.lat <= box.maxLat, axis: 'lat', at: box.maxLat },
  ];

  return edges.reduce((current, edge) => {
    if (current.length === 0) {
      return current;
    }

    const clipped = [];

    for (let index = 0; index < current.length; index += 1) {
      const from = current[(index + current.length - 1) % current.length];
      const to = current[index];
      const isFromInside = edge.keep(from);
      const isToInside = edge.keep(to);

      if (isFromInside !== isToInside) {
        clipped.push(intersectAtEdge(from, to, edge));
      }

      if (isToInside) {
        clipped.push(to);
      }
    }

    return clipped;
  }, ring);
}

/** Where the segment `from → to` crosses one axis-aligned edge of a box. */
function intersectAtEdge(from, to, edge) {
  const span = to[edge.axis] - from[edge.axis];
  const ratio = span === 0 ? 0 : (edge.at - from[edge.axis]) / span;
  const other = edge.axis === 'lon' ? 'lat' : 'lon';

  return {
    [edge.axis]: edge.at,
    [other]: from[other] + (to[other] - from[other]) * ratio,
  };
}

/** True when two boxes share at least one point — the cheap early reject. */
export function boxesOverlap(first, second) {
  return (
    first.minLat <= second.maxLat &&
    first.maxLat >= second.minLat &&
    first.minLon <= second.maxLon &&
    first.maxLon >= second.minLon
  );
}

/**
 * Crossing-number test. A vertex exactly on the ray is counted once, by the
 * usual half-open rule on the latitude span, so a point never counts twice for
 * two edges that meet there.
 */
export function isPointInRing(point, ring) {
  let isInside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const current = ring[index];
    const other = ring[previous];
    const straddles = current.lat > point.lat !== other.lat > point.lat;

    if (!straddles) {
      continue;
    }

    const crossingLon =
      current.lon +
      ((point.lat - current.lat) / (other.lat - current.lat)) * (other.lon - current.lon);

    if (point.lon < crossingLon) {
      isInside = !isInside;
    }
  }

  return isInside;
}

/**
 * Point-in-polygon for a GeoJSON-style ring list: `rings[0]` is the outer ring,
 * every later ring is a hole. A point inside a hole is outside the polygon.
 */
export function isPointInPolygon(point, rings) {
  const [outer, ...holes] = rings;

  if (!outer || !isPointInRing(point, outer)) {
    return false;
  }

  return !holes.some((hole) => isPointInRing(point, hole));
}

function orientation(from, via, to) {
  const cross =
    (via.lon - from.lon) * (to.lat - from.lat) - (via.lat - from.lat) * (to.lon - from.lon);

  if (cross > 0) {
    return 1;
  }

  return cross < 0 ? -1 : 0;
}

/** True when `point` lies on segment `from`–`to`, which is known to be collinear. */
function isOnSegment(from, to, point) {
  return (
    Math.min(from.lat, to.lat) <= point.lat &&
    point.lat <= Math.max(from.lat, to.lat) &&
    Math.min(from.lon, to.lon) <= point.lon &&
    point.lon <= Math.max(from.lon, to.lon)
  );
}

/** True when segments `a1a2` and `b1b2` cross or touch. */
export function segmentsIntersect(a1, a2, b1, b2) {
  const first = orientation(a1, a2, b1);
  const second = orientation(a1, a2, b2);
  const third = orientation(b1, b2, a1);
  const fourth = orientation(b1, b2, a2);

  if (first !== second && third !== fourth) {
    return true;
  }

  // Collinear touches — a building sharing an edge with the border is inside.
  return (
    (first === 0 && isOnSegment(a1, a2, b1)) ||
    (second === 0 && isOnSegment(a1, a2, b2)) ||
    (third === 0 && isOnSegment(b1, b2, a1)) ||
    (fourth === 0 && isOnSegment(b1, b2, a2))
  );
}

/**
 * True when a ring crosses itself — a figure-of-eight rather than an outline.
 *
 * Hand-tracing a district over a map produces these by accident, and they are
 * worth catching: "inside" stops meaning anything obvious for a self-crossing
 * ring, so the dimming mask and the house filter would quietly disagree with
 * what the person drew. Edges that merely meet at a shared vertex are how a
 * ring is built and are skipped.
 */
export function isRingSelfIntersecting(ring) {
  if (ring.length < 4) {
    return false;
  }

  for (let index = 0; index < ring.length; index += 1) {
    const a1 = ring[index];
    const a2 = ring[(index + 1) % ring.length];

    for (let other = index + 1; other < ring.length; other += 1) {
      const isAdjacent =
        other === index + 1 || (index === 0 && other === ring.length - 1);

      if (isAdjacent) {
        continue;
      }

      if (segmentsIntersect(a1, a2, ring[other], ring[(other + 1) % ring.length])) {
        return true;
      }
    }
  }

  return false;
}

/** True when any edge of one ring crosses any edge of the other. */
export function ringEdgesCross(first, second) {
  for (let index = 0; index < first.length; index += 1) {
    const a1 = first[index];
    const a2 = first[(index + 1) % first.length];

    for (let other = 0; other < second.length; other += 1) {
      const b1 = second[other];
      const b2 = second[(other + 1) % second.length];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * True when two rings share any area or boundary: they cross, or one contains
 * the other. Both nesting directions matter — a building can sit well inside
 * the district, and the district can sit inside a building's bounding ring in
 * the degenerate case of a test fixture.
 */
export function ringsOverlap(first, second) {
  if (first.length < 3 || second.length < 3) {
    return false;
  }

  if (!boxesOverlap(ringBox(first), ringBox(second))) {
    return false;
  }

  // Containment first: it is one scan of one ring, while the crossing test is
  // every edge against every edge — and a building fully inside the district is
  // by far the common case.
  return (
    isPointInRing(second[0], first) ||
    isPointInRing(first[0], second) ||
    ringEdgesCross(first, second)
  );
}

/** True when every vertex of `ring` is inside `container` and nothing crosses. */
export function isRingInsideRing(ring, container) {
  return (
    ring.every((point) => isPointInRing(point, container)) && !ringEdgesCross(ring, container)
  );
}

/**
 * True when `ring` shares any ground with the polygon — the rule that decides
 * whether a building belongs to the working area. A ring that only reaches into
 * a hole does not count.
 */
export function polygonIntersectsRing(rings, ring) {
  const [outer, ...holes] = rings;

  if (!outer || !ringsOverlap(outer, ring)) {
    return false;
  }

  return !holes.some((hole) => isRingInsideRing(ring, hole));
}
