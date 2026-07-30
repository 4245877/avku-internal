/**
 * The working area of the "Вибори" module — an arbitrary GeoJSON polygon.
 *
 * The boundary itself lives in one file, `workspaceArea.geo.json`, and nothing
 * else in the app is allowed to define territory: the map fits its initial view
 * to this polygon, dims everything outside it, and the dataset is filtered
 * against it, so replacing that one file moves the whole district.
 *
 * The file is traced over the real map in the temporary editing mode
 * (`?areaEdit=1`, see `useWorkspaceEditor.js`), which exports exactly the shape
 * this module expects. Coordinates are GeoJSON order — `[lon, lat]` — and are
 * converted to the `{ lat, lon }` records the rest of the feature speaks.
 */

// The import attribute keeps this module loadable both by the bundler and by
// plain Node, which is how `scripts/fetch-osm-buildings.mjs` reads the boundary.
import areaDocument from './workspaceArea.geo.json' with { type: 'json' };
import { AREA_CENTER, distanceMeters, ringAreaSquareMeters, ringBounds } from './geo.js';
import { isPointInPolygon, polygonIntersectsRing, ringBox } from './polygonGeometry.js';

/** The polygon file is a build-time import, so a bad edit must fail loudly. */
function fail(reason) {
  throw new Error(
    `workspaceArea.geo.json: ${reason}. Очікується GeoJSON Feature з геометрією Polygon — ` +
      'експортуйте межу з режиму редагування (?areaEdit=1).',
  );
}

/** Feature, FeatureCollection or a bare geometry → the Polygon geometry. */
function readGeometry(document) {
  if (!document || typeof document !== 'object') {
    fail('файл порожній або не є JSON-обʼєктом');
  }

  if (document.type === 'FeatureCollection') {
    const [first] = document.features ?? [];

    if (!first) {
      fail('FeatureCollection не містить жодного полігона');
    }

    return readGeometry(first);
  }

  const geometry = document.type === 'Feature' ? document.geometry : document;

  if (geometry?.type !== 'Polygon') {
    fail(`геометрія має тип "${geometry?.type ?? 'невідомо'}", а не "Polygon"`);
  }

  return geometry;
}

/**
 * A GeoJSON linear ring → an open `{ lat, lon }` ring. GeoJSON repeats the
 * first vertex to close the ring; every predicate here closes rings implicitly,
 * so the duplicate is dropped instead of being carried around.
 */
export function ringFromCoordinates(coordinates) {
  const ring = coordinates.map(([lon, lat]) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      fail('координата не є числом');
    }

    return { lat, lon };
  });

  const first = ring[0];
  const last = ring.at(-1);

  if (ring.length > 1 && first.lat === last.lat && first.lon === last.lon) {
    ring.pop();
  }

  return ring;
}

/** An open `{ lat, lon }` ring → a closed GeoJSON linear ring. */
export function coordinatesFromRing(ring, precision = 6) {
  const round = (value) => Number(value.toFixed(precision));
  const coordinates = ring.map((point) => [round(point.lon), round(point.lat)]);

  return [...coordinates, coordinates[0]];
}

function readRings(document) {
  const rings = readGeometry(document).coordinates.map(ringFromCoordinates);

  if (!rings[0] || rings[0].length < 3) {
    fail('зовнішнє кільце має містити щонайменше 3 точки');
  }

  return rings;
}

/** The polygon as it came from the file, for metadata and re-export. */
export const WORKSPACE_AREA_FEATURE = areaDocument;

/** `[outer, ...holes]`, each an open ring of `{ lat, lon }`. */
export const WORKSPACE_RINGS = readRings(areaDocument);

export const WORKSPACE_OUTER_RING = WORKSPACE_RINGS[0];

/** Leaflet's `[[south, west], [north, east]]` for the whole area. */
export const WORKSPACE_BOUNDS = ringBounds(WORKSPACE_OUTER_RING);

/** Ground area of the territory in square metres, holes excluded. */
export const WORKSPACE_AREA_SQM = WORKSPACE_RINGS.reduce(
  (total, ring, index) =>
    index === 0 ? ringAreaSquareMeters(ring) : total - ringAreaSquareMeters(ring),
  0,
);

const WORKSPACE_BOX = ringBox(WORKSPACE_OUTER_RING);

/** Human-readable name of the territory, if the file carries one. */
export const WORKSPACE_AREA_NAME =
  String(areaDocument?.properties?.name ?? '').trim() || 'Робоча територія';

/** Rings as Leaflet `[lat, lon]` pairs — outer first, then holes. */
export function toLeafletLatLngs(rings = WORKSPACE_RINGS) {
  return rings.map((ring) => ring.map((point) => [point.lat, point.lon]));
}

/** True when a single point (a house centroid, a click) is inside the area. */
export function isInsideWorkspace(point) {
  if (
    point.lat < WORKSPACE_BOX.minLat ||
    point.lat > WORKSPACE_BOX.maxLat ||
    point.lon < WORKSPACE_BOX.minLon ||
    point.lon > WORKSPACE_BOX.maxLon
  ) {
    return false;
  }

  return isPointInPolygon(point, WORKSPACE_RINGS);
}

/**
 * The rule that decides which buildings the module works with: a footprint
 * counts when it lies inside the polygon **or** crosses its border. A house on
 * the edge of the district is still a house to canvass, so it is never dropped
 * for hanging a few metres over the line.
 */
export function coversFootprint(footprint) {
  if (!Array.isArray(footprint) || footprint.length < 3) {
    return false;
  }

  return polygonIntersectsRing(WORKSPACE_RINGS, footprint);
}

/** Keeps only the houses the working area covers. */
export function filterHousesToWorkspace(houses) {
  return houses.filter((house) => coversFootprint(house.footprint));
}

/**
 * Radius that covers the whole polygon from the campaign address, in metres.
 * The OSM download is still a circular Overpass query — this is how wide it has
 * to be for the polygon to be fully inside the result.
 */
export function workspaceCoverRadiusMeters(origin = AREA_CENTER) {
  const farthest = WORKSPACE_OUTER_RING.reduce(
    (maximum, point) => Math.max(maximum, distanceMeters(origin, point)),
    0,
  );

  return Math.ceil(farthest);
}

/**
 * The editing mode's output: an open ring → the exact document shape this
 * module reads back, so an export can be dropped in as `workspaceArea.geo.json`
 * with no hand-editing.
 */
export function toWorkspaceFeature(ring, { name = WORKSPACE_AREA_NAME, note } = {}) {
  return {
    type: 'Feature',
    properties: {
      name,
      source: 'traced over the live map in the "Вибори" area editor',
      generatedAt: new Date().toISOString().slice(0, 10),
      ...(note ? { note } : {}),
    },
    geometry: {
      type: 'Polygon',
      coordinates: [coordinatesFromRing(ring)],
    },
  };
}

/** Static metadata about the covered territory, for the header and the API. */
export function getWorkspaceMeta() {
  return {
    name: WORKSPACE_AREA_NAME,
    center: AREA_CENTER,
    bounds: WORKSPACE_BOUNDS,
    areaSqm: WORKSPACE_AREA_SQM,
    vertexCount: WORKSPACE_OUTER_RING.length,
    label: `${AREA_CENTER.address}, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`,
  };
}
