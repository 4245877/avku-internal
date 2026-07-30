/**
 * Geodesy helpers for the "Вибори" map.
 *
 * All house geometry is stored and rendered in WGS84 (lat/lon) — the same
 * coordinates OpenStreetMap, Google Maps and Mapbox speak — so a footprint that
 * comes out of the API lands exactly on the real building in the base tiles.
 *
 * A few derived numbers (footprint area, centroid, entrance estimates) are
 * easier to compute on a plane, so this module also exposes a local
 * equirectangular projection around the campaign address. Inside a 3 km radius
 * its error stays under a metre, which is far below the accuracy of the source
 * data itself.
 */

const EARTH_RADIUS_METERS = 6378137;
const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Campaign anchor — вулиця Якуба Коласа, 6, Київ, 03146 (Святошинський район).
 *
 * Coordinates are the OSM position of the building itself
 * (way/1001457592), not a hand-placed guess.
 */
export const AREA_CENTER = {
  lat: 50.4345086,
  lon: 30.3774787,
  address: 'вулиця Якуба Коласа, 6',
  city: 'Київ',
  postalCode: '03146',
  district: 'Святошинський район',
};

/** Radius of the covered territory, in metres. */
export const AREA_RADIUS_METERS = 3000;

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

/** True when a point sits inside the covered territory. */
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
