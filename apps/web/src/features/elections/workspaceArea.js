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
 *
 * A saved boundary is persisted through `workspaceAreaStorage.js`: the API is
 * the permanent home, `localStorage` only a cache that lets the first render
 * open on the right territory. `hydrateWorkspaceArea()` reconciles the two on
 * start-up.
 *
 * Coordinates are GeoJSON order — `[lon, lat]` — and are converted to the
 * `{ lat, lon }` records the rest of the feature speaks.
 */

// The import attribute keeps this module loadable both by the bundler and by
// plain Node, which is how `scripts/fetch-osm-buildings.mjs` reads the boundary.
import areaDocument from './workspaceArea.geo.json' with { type: 'json' };
import {
  AREA_CENTER,
  distanceMeters,
  expandBox,
  ringAreaSquareMeters,
  ringBounds,
} from './geo.js';
import {
  isPointInPolygon,
  isRingSelfIntersecting,
  polygonIntersectsRing,
  ringBox,
} from './polygonGeometry.js';
import {
  clearCachedArea,
  deleteRemoteArea,
  fetchRemoteArea,
  readCachedArea,
  saveRemoteArea,
  writeCachedArea,
} from './workspaceAreaStorage.js';

/** Used when the polygon document carries no name of its own. */
const DEFAULT_AREA_NAME = 'Робоча територія';

/**
 * Slack added around the polygon before buildings are downloaded for it, in
 * metres. A building is kept when it *touches* the border, so the acquisition
 * box has to reach past the border by more than the longest building — 250 m
 * clears a Soviet-era apartment block end to end with room to spare.
 */
export const AREA_DOWNLOAD_MARGIN_METERS = 250;

/** Below this a "polygon" is a line or a point, not a territory. */
const MIN_AREA_SQM = 1;

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
  if (!Array.isArray(coordinates)) {
    fail('кільце не є масивом координат');
  }

  const ring = coordinates.map((position) => {
    if (!Array.isArray(position) || position.length < 2) {
      fail('координата не є парою [довгота, широта]');
    }

    const [lon, lat] = position;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      fail('координата не є числом');
    }

    // Range checks, not a swap detector: at Kyiv's own coordinates (lat 50,
    // lon 30) writing the pair as `[lat, lon]` produces two values that are
    // both still in range, so nothing here can catch that particular mistake —
    // the map showing the district in the wrong place is what catches it. What
    // these do catch is every out-of-range value: a truncated file, a metre
    // grid pasted in by hand, a swap anywhere past 90° of longitude.
    if (lat < -90 || lat > 90) {
      fail(
        `широта ${lat} поза діапазоном −90…90 — перевірте порядок координат ` +
          '[довгота, широта]',
      );
    }

    if (lon < -180 || lon > 180) {
      fail(`довгота ${lon} поза діапазоном −180…180`);
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
  const geometry = readGeometry(document);

  if (!Array.isArray(geometry.coordinates)) {
    fail('Polygon не містить масиву кілець');
  }

  const rings = geometry.coordinates.map(ringFromCoordinates);

  if (!rings[0] || rings[0].length < 3) {
    fail('зовнішнє кільце має містити щонайменше 3 точки');
  }

  // Three collinear clicks parse as a ring but enclose nothing, and every
  // predicate downstream would then answer "outside" for the whole city. The
  // threshold is not zero because the shoelace sum of a collinear ring only
  // cancels to zero in exact arithmetic; a square metre is far below any
  // territory somebody meant to draw and far above that residue.
  if (ringAreaSquareMeters(rings[0]) < MIN_AREA_SQM) {
    fail('зовнішнє кільце не охоплює жодної площі');
  }

  // A figure-of-eight has no unambiguous inside: the dimming mask (even-odd
  // fill) and the house filter (crossing number) would disagree about which
  // half is the district, so it is rejected rather than half-honoured.
  if (isRingSelfIntersecting(rings[0])) {
    fail('контур перетинає сам себе');
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
 * Parses a stored or downloaded boundary document. Either source is data that
 * has been through a hand edit, a browser upgrade or an older release, so
 * anything unreadable is dropped in favour of the shipped file: a bad entry
 * must never leave the page without a map.
 */
function tryBuildArea(document) {
  if (!document) {
    return null;
  }

  try {
    return buildArea(document, { isCustom: true });
  } catch {
    return null;
  }
}

let currentArea = tryBuildArea(readCachedArea()) ?? SHIPPED_WORKSPACE_AREA;

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
  if (area === currentArea) {
    return area;
  }

  currentArea = area;
  listeners.forEach((listener) => listener(area));

  return area;
}

/** True when a document describes the very outline the repository ships. */
function isShippedOutline(area) {
  return (
    area.rings.length === SHIPPED_WORKSPACE_AREA.rings.length &&
    ringsAreEqual(area.outerRing, SHIPPED_WORKSPACE_AREA.outerRing)
  );
}

/**
 * Reconciles the boundary shown on first paint — which came from the local
 * cache — with the one the API holds, which is the permanent source.
 *
 * Called once when the page mounts. A server that answers replaces whatever was
 * cached, including replacing a stale local override with the shipped file; a
 * server that cannot be reached changes nothing, so the page keeps working
 * offline on the last boundary this browser saw.
 */
export async function hydrateWorkspaceArea({ signal } = {}) {
  const { isReachable, document } = await fetchRemoteArea({ signal });

  if (!isReachable) {
    // The cache is re-read rather than assumed to be what is already in force:
    // another tab may have saved a boundary since this module was imported.
    const cached = currentArea.isCustom ? currentArea : tryBuildArea(readCachedArea());

    return {
      area: cached ? applyArea(cached) : currentArea,
      source: cached ? 'cache' : 'shipped',
    };
  }

  const remote = tryBuildArea(document);

  if (!remote) {
    // The server is authoritative about there being no custom boundary, so a
    // local cache left over from an older session has to go with it.
    clearCachedArea();

    return { area: applyArea(SHIPPED_WORKSPACE_AREA), source: 'shipped' };
  }

  if (isShippedOutline(remote)) {
    clearCachedArea();

    return { area: applyArea(SHIPPED_WORKSPACE_AREA), source: 'shipped' };
  }

  writeCachedArea(document);

  return {
    area: currentArea.isCustom && ringsAreEqual(currentArea.outerRing, remote.outerRing)
      ? currentArea
      : applyArea(remote),
    source: 'server',
  };
}

/**
 * Puts a traced boundary in force and makes it permanent.
 *
 * The polygon applies to the map and the dataset synchronously — the caller
 * should not have to wait for a round trip to see its own outline — and the
 * write to the API is awaited afterwards. `storage` says how durable the result
 * actually is, because "saved" and "saved for everybody" are different promises
 * and the UI has to be able to tell them apart:
 *
 *   'server' — written to the API; every browser and the snapshot script see it.
 *   'local'  — the API refused or is down; cached, so it survives a reload here.
 *   'memory' — storage refused too; the boundary lasts until the tab closes.
 */
export async function saveWorkspaceArea(document, { signal } = {}) {
  const area = buildArea(document, { isCustom: true });

  // Tracing back to the shipped outline is a return to it, not a new boundary
  // that happens to look identical — otherwise "drawn by hand" would stick to
  // the territory for good, and the override would outlive the file it copies.
  if (isShippedOutline(area)) {
    return restoreShippedWorkspaceArea({ signal });
  }

  const isCached = writeCachedArea(document);

  applyArea(area);

  const { isSaved, error } = await saveRemoteArea(document, { signal });

  return {
    area,
    isPersisted: isSaved || isCached,
    storage: isSaved ? 'server' : isCached ? 'local' : 'memory',
    error: isSaved ? null : error,
  };
}

/** Drops a saved boundary and goes back to the one in the repository. */
export async function restoreShippedWorkspaceArea({ signal } = {}) {
  clearCachedArea();
  applyArea(SHIPPED_WORKSPACE_AREA);

  const { isSaved, error } = await deleteRemoteArea({ signal });

  return {
    area: SHIPPED_WORKSPACE_AREA,
    isPersisted: isSaved,
    storage: isSaved ? 'server' : 'local',
    error: isSaved ? null : error,
  };
}

/**
 * Forgets any saved boundary without touching the server — the reset tests and
 * the Node snapshot script use this, where "what the API holds" is not part of
 * the question being asked.
 */
export function resetWorkspaceAreaToShipped() {
  clearCachedArea();

  return applyArea(SHIPPED_WORKSPACE_AREA);
}

/** Puts a boundary document in force without persisting it anywhere. */
export function applyWorkspaceAreaDocument(document) {
  return applyArea(buildArea(document, { isCustom: true }));
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

/**
 * Whether the working area covers this point.
 *
 * The fallback for a house with no outline to test. Since the backend started
 * cutting the set itself, the outlines arrive separately from the houses and
 * may not be here yet — and a house is still a house without one, so "is it in
 * the district" has to be answerable from its centre. This is also the test the
 * server applies, so the two agree.
 */
export function coversLocation(location) {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
    return false;
  }

  return isPointInPolygon(location, currentArea.rings);
}

/**
 * Keeps only the houses the working area covers.
 *
 * A house with an outline is judged on the outline — one hanging a few metres
 * over the line is still a house to canvass. A house without one is judged on
 * its centre, which is the only thing there is to judge.
 */
export function filterHousesToWorkspace(houses) {
  return houses.filter((house) =>
    Array.isArray(house.footprint) && house.footprint.length >= 3
      ? coversFootprint(house.footprint)
      : coversLocation(house.location),
  );
}

/**
 * The box buildings are downloaded for: the polygon's own bounding box plus a
 * margin.
 *
 * This is what replaced "a circle of radius R around the campaign address".
 * That model only ever worked while the territory happened to be centred on
 * that address: re-trace the boundary two streets west and the circle either
 * misses half the new district or has to grow to several times its area to
 * reach it. The bounding box follows the polygon wherever it is drawn, and the
 * polygon itself still does the filtering afterwards.
 */
export function workspaceBoundingBox({
  area = currentArea,
  marginMeters = AREA_DOWNLOAD_MARGIN_METERS,
} = {}) {
  return expandBox(area.box, marginMeters);
}

/**
 * Radius that covers the whole polygon from a given origin, in metres. Only the
 * legacy circular Overpass query needs it; kept because a snapshot recorded
 * before the switch to bounding boxes describes its coverage that way.
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
    box: currentArea.box,
    areaSqm: currentArea.areaSqm,
    vertexCount: currentArea.vertexCount,
    isCustom: currentArea.isCustom,
    label: `${AREA_CENTER.address}, ${AREA_CENTER.city}, ${AREA_CENTER.postalCode}`,
  };
}
