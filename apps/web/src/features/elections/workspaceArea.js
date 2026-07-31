/**
 * The working area of the "Вибори" module — an arbitrary GeoJSON polygon.
 *
 * The boundary ships in one file, `workspaceArea.geo.json`, and nothing else in
 * the app is allowed to define territory: the map fits its initial view to this
 * polygon, dims everything outside it, and the dataset is filtered against it.
 *
 * The polygon is traced over the live map in the boundary editor (see
 * `useWorkspaceEditor.js`), and a boundary saved there takes effect at once —
 * so the *current* area is a tiny store rather than a constant: the shipped file
 * is the starting point, a saved outline overrides it, and everything that
 * depends on territory reads `getWorkspaceArea()` and re-reads it on change.
 * The override lives in `localStorage`, which is the same place the survey
 * edits live until a backend lands.
 *
 * Coordinates are GeoJSON order — `[lon, lat]` — and are converted to the
 * `{ lat, lon }` records the rest of the feature speaks.
 */

// The import attribute keeps this module loadable both by the bundler and by
// plain Node, which is how `scripts/fetch-osm-buildings.mjs` reads the boundary.
import areaDocument from './workspaceArea.geo.json' with { type: 'json' };
import { AREA_CENTER, distanceMeters, ringAreaSquareMeters, ringBounds } from './geo.js';
import { isPointInPolygon, polygonIntersectsRing, ringBox } from './polygonGeometry.js';

/** Where a boundary saved from the editor is kept. */
const AREA_STORAGE_KEY = 'avku-elections-area-v1';

/** Used when the polygon document carries no name of its own. */
const DEFAULT_AREA_NAME = 'Робоча територія';

/** A malformed polygon is never worth guessing about — it has to fail loudly. */
function fail(reason) {
  throw new Error(
    `Межа робочої території: ${reason}. Очікується GeoJSON Feature з геометрією ` +
      'Polygon — обведіть територію в режимі «Редагувати межу».',
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

/** Decimal places a boundary is stored at — a little over 10 cm on the ground. */
const COORDINATE_PRECISION = 6;

const round = (value) => Number(value.toFixed(COORDINATE_PRECISION));

/** An open `{ lat, lon }` ring → a closed GeoJSON linear ring. */
export function coordinatesFromRing(ring, precision = COORDINATE_PRECISION) {
  const coordinates = ring.map((point) => [
    Number(point.lon.toFixed(precision)),
    Number(point.lat.toFixed(precision)),
  ]);

  return [...coordinates, coordinates[0]];
}

/**
 * Whether two rings describe the same outline. Storing a boundary rounds its
 * coordinates, so the comparison has to round too — otherwise an outline would
 * read as different from itself the moment it was saved.
 */
export function ringsAreEqual(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (point, index) =>
        round(point.lat) === round(right[index].lat) &&
        round(point.lon) === round(right[index].lon),
    )
  );
}

function readRings(document) {
  const rings = readGeometry(document).coordinates.map(ringFromCoordinates);

  if (!rings[0] || rings[0].length < 3) {
    fail('зовнішнє кільце має містити щонайменше 3 точки');
  }

  return rings;
}

/**
 * Everything the app needs to know about a territory, derived once: the rings
 * themselves plus the bounds, bounding box and ground area computed from them.
 * The object is frozen and replaced wholesale on save, so its identity is a
 * usable "has the territory changed" signal for React.
 */
function buildArea(document, { isCustom = false } = {}) {
  const rings = readRings(document);
  const outerRing = rings[0];

  return Object.freeze({
    document,
    rings,
    outerRing,
    bounds: ringBounds(outerRing),
    box: ringBox(outerRing),
    // Holes are subtracted from the outer ring rather than added to it.
    areaSqm: rings.reduce(
      (total, ring, index) =>
        index === 0 ? ringAreaSquareMeters(ring) : total - ringAreaSquareMeters(ring),
      0,
    ),
    name: String(document?.properties?.name ?? '').trim() || DEFAULT_AREA_NAME,
    vertexCount: outerRing.length,
    isCustom,
  });
}

/** The boundary as it ships in the repository — the fallback for everything. */
export const SHIPPED_WORKSPACE_AREA = buildArea(areaDocument);

/**
 * A saved boundary, if there is one. A stored polygon is user input that has
 * been through a browser upgrade, a private window and possibly a hand edit, so
 * anything unreadable is dropped in favour of the shipped file: a bad entry
 * here must never leave the page without a map.
 */
function readStoredArea() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(AREA_STORAGE_KEY);

    return stored ? buildArea(JSON.parse(stored), { isCustom: true }) : null;
  } catch {
    return null;
  }
}

let currentArea = readStoredArea() ?? SHIPPED_WORKSPACE_AREA;

const listeners = new Set();

/** The territory in force right now — a saved boundary, or the shipped one. */
export function getWorkspaceArea() {
  return currentArea;
}

/** Notifies on every change of territory; returns the unsubscribe function. */
export function subscribeToWorkspaceArea(listener) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function applyArea(area) {
  currentArea = area;
  listeners.forEach((listener) => listener(area));

  return area;
}

/**
 * Puts a traced boundary in force. Storage can refuse the write (private mode,
 * quota), which is worth telling the user about but not worth failing over —
 * the boundary still applies for the rest of the session.
 */
export function saveWorkspaceArea(document) {
  const area = buildArea(document, { isCustom: true });

  // Tracing back to the shipped outline is a return to it, not a new boundary
  // that happens to look identical — otherwise "drawn by hand" would stick to
  // the territory for good, and the override would outlive the file it copies.
  if (
    area.rings.length === SHIPPED_WORKSPACE_AREA.rings.length &&
    ringsAreEqual(area.outerRing, SHIPPED_WORKSPACE_AREA.outerRing)
  ) {
    return { area: restoreShippedWorkspaceArea(), isPersisted: true };
  }

  let isPersisted = false;

  try {
    window.localStorage.setItem(AREA_STORAGE_KEY, JSON.stringify(document));
    isPersisted = true;
  } catch {
    isPersisted = false;
  }

  applyArea(area);

  return { area, isPersisted };
}

/** Drops a saved boundary and goes back to the one in the repository. */
export function restoreShippedWorkspaceArea() {
  try {
    window.localStorage.removeItem(AREA_STORAGE_KEY);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }

  return applyArea(SHIPPED_WORKSPACE_AREA);
}

/** Rings as Leaflet `[lat, lon]` pairs — outer first, then holes. */
export function toLeafletLatLngs(rings = currentArea.rings) {
  return rings.map((ring) => ring.map((point) => [point.lat, point.lon]));
}

/** True when a single point (a house centroid, a click) is inside the area. */
export function isInsideWorkspace(point) {
  const { box, rings } = currentArea;

  if (
    point.lat < box.minLat ||
    point.lat > box.maxLat ||
    point.lon < box.minLon ||
    point.lon > box.maxLon
  ) {
    return false;
  }

  return isPointInPolygon(point, rings);
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

  return polygonIntersectsRing(currentArea.rings, footprint);
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
  const farthest = currentArea.outerRing.reduce(
    (maximum, point) => Math.max(maximum, distanceMeters(origin, point)),
    0,
  );

  return Math.ceil(farthest);
}

/**
 * The editor's output: an open ring → the exact document shape this module
 * reads back, so a saved boundary can also be dropped in as
 * `workspaceArea.geo.json` with no hand-editing.
 */
export function toWorkspaceFeature(ring, { name = currentArea.name, note } = {}) {
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

/** Metadata about the covered territory, for the header and the API. */
export function getWorkspaceMeta() {
  return {
    name: currentArea.name,
    center: AREA_CENTER,
    bounds: currentArea.bounds,
    areaSqm: currentArea.areaSqm,
    vertexCount: currentArea.vertexCount,
    isCustom: currentArea.isCustom,
    label: `${AREA_CENTER.address}, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`,
  };
}
