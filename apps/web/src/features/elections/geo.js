/**
 * Geodesy helpers for the "Вибори" map.
 *
 * All house geometry is stored and rendered in WGS84 (lat/lon) — the same
 * coordinates OpenStreetMap, Google Maps and Mapbox speak — so a footprint that
 * comes out of the API lands exactly on the real building in the base tiles.
 *
 * A few derived numbers (footprint area, centroid, entrance estimates) are
 * easier to compute on a plane, so this module also exposes a local
 * equirectangular projection around the campaign address. Across a city
 * district its error stays under a metre, which is far below the accuracy of
 * the source data itself.
 */

const EARTH_RADIUS_METERS = 6378137;
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Campaign anchor — вулиця Зодчих, 58А, Київ, 03170 (Святошинський район).
 *
 * Coordinates are the OSM position of the building itself
 * (way/180170140), not a hand-placed guess.
 */
export const AREA_CENTER = {
  lat: 50.4307636,
  lon: 30.3640481,
  address: 'вулиця Зодчих, 58А',
  city: 'Київ',
  postalCode: '03170',
  district: 'Святошинський район',
};

/**
 * Radius of the *original* OSM download around the campaign address, in metres.
 *
 * Kept only as the fallback for a snapshot old enough to record no coverage box
 * of its own: everything that acquires data now works from the bounding box of
 * the working-area polygon (see `workspaceBoundingBox()`), because a circle
 * around a fixed address cannot follow a boundary that was re-traced somewhere
 * else on the map.
 */
export const AREA_RADIUS_METERS = 3000;

/** Degrees of latitude per metre — constant everywhere on the ellipsoid. */
const DEGREES_PER_METER = 1 / (DEGREES_TO_RADIANS * EARTH_RADIUS_METERS);

/**
 * Grows a lat/lon box by a margin measured in metres on the ground.
 *
 * The longitude margin is divided by the cosine of the latitude, so the slack
 * is the same number of metres east–west as it is north–south rather than the
 * same number of degrees — at Kyiv's latitude that is a 1.57× difference, which
 * is the width of a city block at the margins this is used with.
 */
export function expandBox(box, marginMeters = 0) {
  const latitudeMargin = marginMeters * DEGREES_PER_METER;
  const midLatitude = (box.minLat + box.maxLat) / 2;
  const scale = Math.max(Math.cos(midLatitude * DEGREES_TO_RADIANS), 1e-6);

  return {
    minLat: Math.max(-90, box.minLat - latitudeMargin),
    maxLat: Math.min(90, box.maxLat + latitudeMargin),
    minLon: Math.max(-180, box.minLon - latitudeMargin / scale),
    maxLon: Math.min(180, box.maxLon + latitudeMargin / scale),
  };
}

/** True when `outer` contains every point of `inner`. */
export function boxCoversBox(outer, inner) {
  return (
    outer.minLat <= inner.minLat &&
    outer.maxLat >= inner.maxLat &&
    outer.minLon <= inner.minLon &&
    outer.maxLon >= inner.maxLon
  );
}

/**
 * How far `inner` reaches past `outer` on its worst side, in metres — zero when
 * `outer` covers it.
 *
 * `boxCoversBox` answers yes or no; a banner that says "the dataset does not
 * reach your territory" has to be able to say by how much, because thirty
 * metres of hand-traced slack and two missing streets are not the same problem
 * and must not read the same way.
 */
export function boxShortfallMeters(outer, inner) {
  const midLatitude = (inner.minLat + inner.maxLat) / 2;
  const scale = Math.max(Math.cos(midLatitude * DEGREES_TO_RADIANS), 1e-6);
  const latitudeGap = Math.max(0, outer.minLat - inner.minLat, inner.maxLat - outer.maxLat);
  const longitudeGap = Math.max(0, outer.minLon - inner.minLon, inner.maxLon - outer.maxLon);

  return Math.max(latitudeGap, longitudeGap * scale) / DEGREES_PER_METER;
}

/** True when a point falls inside a lat/lon box, borders included. */
export function isPointInBox(point, box) {
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lon >= box.minLon &&
    point.lon <= box.maxLon
  );
}

/** A box as Overpass writes it: `(south,west,north,east)`. */
export function formatBoxForOverpass(box, precision = 6) {
  return [box.minLat, box.minLon, box.maxLat, box.maxLon]
    .map((value) => Number(value.toFixed(precision)))
    .join(',');
}

/** The circle a legacy snapshot was downloaded as, expressed as a box. */
export function boxFromCircle(center, radiusMeters) {
  return expandBox(
    { minLat: center.lat, maxLat: center.lat, minLon: center.lon, maxLon: center.lon },
    radiusMeters,
  );
}

/** Projects a WGS84 point onto a local metre plane around `origin`. */
export function projectToMeters(point, origin = AREA_CENTER) {
  const latitudeScale = Math.cos(origin.lat * DEGREES_TO_RADIANS);

  return {
    x: (point.lon - origin.lon) * DEGREES_TO_RADIANS * EARTH_RADIUS_METERS * latitudeScale,
    y: -(point.lat - origin.lat) * DEGREES_TO_RADIANS * EARTH_RADIUS_METERS,
  };
}

/** Inverse of {@link projectToMeters}. */
export function unprojectFromMeters(point, origin = AREA_CENTER) {
  const latitudeScale = Math.cos(origin.lat * DEGREES_TO_RADIANS);

  return {
    lat: origin.lat - point.y / (DEGREES_TO_RADIANS * EARTH_RADIUS_METERS),
    lon: origin.lon + point.x / (DEGREES_TO_RADIANS * EARTH_RADIUS_METERS * latitudeScale),
  };
}

/** Great-circle distance between two WGS84 points, in metres. */
export function distanceMeters(from, to) {
  const latitudeDelta = (to.lat - from.lat) * DEGREES_TO_RADIANS;
  const longitudeDelta = (to.lon - from.lon) * DEGREES_TO_RADIANS;

  const chord =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from.lat * DEGREES_TO_RADIANS) *
      Math.cos(to.lat * DEGREES_TO_RADIANS) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

/**
 * True when a point sits inside the download radius. Membership of the working
 * area itself is decided by the polygon — `isInsideWorkspace` in
 * `workspaceArea.js` — which is what the UI and the dataset go through.
 */
export function isInsideArea(point, radiusMeters = AREA_RADIUS_METERS) {
  return distanceMeters(AREA_CENTER, point) <= radiusMeters;
}

/**
 * Area-weighted centroid of a closed WGS84 ring. Computed on the local plane
 * and converted back, so it stays inside concave footprints — unlike the plain
 * average of the vertices, which drifts towards the densely mapped side.
 */
export function ringCentroid(ring) {
  const points = ring.map((point) => projectToMeters(point));
  let doubleArea = 0;
  let centroidX = 0;
  let centroidY = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;

    doubleArea += cross;
    centroidX += (current.x + next.x) * cross;
    centroidY += (current.y + next.y) * cross;
  }

  if (doubleArea === 0) {
    return { lat: ring[0].lat, lon: ring[0].lon };
  }

  return unprojectFromMeters({
    x: centroidX / (3 * doubleArea),
    y: centroidY / (3 * doubleArea),
  });
}

/** Ground area of a closed WGS84 ring, in square metres. */
export function ringAreaSquareMeters(ring) {
  const points = ring.map((point) => projectToMeters(point));
  let doubleArea = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];

    doubleArea += current.x * next.y - next.x * current.y;
  }

  return Math.abs(doubleArea) / 2;
}

/**
 * Longest and shortest side of the minimum-area rectangle around a ring, in
 * metres. For a residential block that is its street frontage and its depth,
 * which is what entrance and apartment estimates are built on.
 */
export function ringDimensions(ring) {
  const points = ring.map((point) => projectToMeters(point));
  let best = null;

  // Rotating calipers, cheap edition: the minimum-area rectangle of a convex
  // hull always shares an edge with it, and building outlines are close enough
  // to convex that testing every edge of the ring itself is accurate to ~1 m.
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const edgeLength = Math.hypot(next.x - current.x, next.y - current.y);

    if (edgeLength < 1e-6) {
      continue;
    }

    const cosine = (next.x - current.x) / edgeLength;
    const sine = (next.y - current.y) / edgeLength;
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let minAcross = Infinity;
    let maxAcross = -Infinity;

    for (const point of points) {
      const along = point.x * cosine + point.y * sine;
      const across = -point.x * sine + point.y * cosine;

      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minAcross = Math.min(minAcross, across);
      maxAcross = Math.max(maxAcross, across);
    }

    const width = maxAlong - minAlong;
    const depth = maxAcross - minAcross;

    if (!best || width * depth < best.area) {
      best = { area: width * depth, length: Math.max(width, depth), width: Math.min(width, depth) };
    }
  }

  return best
    ? { length: best.length, width: best.width }
    : { length: 0, width: 0 };
}

/** Axis-aligned WGS84 bounds of a ring, as Leaflet's `[[s, w], [n, e]]`. */
export function ringBounds(ring) {
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

  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}

/** Human-readable ground area for the UI. */
export function formatAreaSquareMeters(squareMeters) {
  if (!Number.isFinite(squareMeters) || squareMeters <= 0) {
    return '—';
  }

  if (squareMeters < 100000) {
    return `${Math.round(squareMeters / 100) * 100} м²`;
  }

  return `${(squareMeters / 1e6).toFixed(2).replace('.', ',')} км²`;
}

/** Human-readable distance for the UI. */
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) {
    return '—';
  }

  if (meters < 950) {
    return `${Math.round(meters / 10) * 10} м`;
  }

  return `${(meters / 1000).toFixed(1).replace('.', ',')} км`;
}
