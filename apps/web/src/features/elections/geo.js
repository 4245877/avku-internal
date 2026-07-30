/**
 * Geodesy helpers for the "Вибори" map.
 *
 * House geometry is stored in WGS84 (lat/lon) so it can be swapped for real
 * API/cadastre data without touching the renderer. The map itself works in a
 * flat local metre grid: `x` grows east, `y` grows south (screen direction),
 * with the campaign address as the origin. At a 3 km radius the equirectangular
 * error is well under a metre, so a full projection library is not needed.
 */

const EARTH_RADIUS_METERS = 6378137;
const DEGREES_TO_RADIANS = Math.PI / 180;

/** Campaign anchor — вулиця Якуба Коласа, 6, Київ, 03146 (Святошинський район). */
export const AREA_CENTER = {
  lat: 50.4569,
  lon: 30.3618,
  address: 'вулиця Якуба Коласа, 6',
  city: 'Київ',
  postalCode: '03146',
  district: 'Святошинський район',
};

/** Radius of the covered territory, in metres. */
export const AREA_RADIUS_METERS = 3000;

/** Projects a WGS84 point onto the local metre grid around `origin`. */
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

/** Area-weighted centroid of a closed ring of local-grid points. */
export function polygonCentroid(points) {
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
    return { ...points[0] };
  }

  return {
    x: centroidX / (3 * doubleArea),
    y: centroidY / (3 * doubleArea),
  };
}

/** Axis-aligned bounds of local-grid points. */
export function polygonBounds(points) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }

  return bounds;
}

/** Serialises local-grid points into an SVG path (`d`) for a closed shape. */
export function polygonToPath(points) {
  return `${points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(' ')} Z`;
}

/** Serialises local-grid points into an SVG path (`d`) for an open polyline. */
export function polylineToPath(points) {
  return points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(' ');
}

/*
 * Footprint rings never change while a house is being edited, so the projected
 * geometry is cached against the ring itself. Editing a house replaces the
 * house object but keeps the same `footprint` array, which keeps the map from
 * re-projecting a few thousand vertices on every keystroke.
 */
const projectionCache = new WeakMap();

/** Projects (and caches) a WGS84 footprint ring into local-grid points. */
export function projectFootprint(footprint) {
  const cached = projectionCache.get(footprint);

  if (cached) {
    return cached;
  }

  const projected = footprint.map((point) => projectToMeters(point));

  projectionCache.set(footprint, projected);

  return projected;
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
