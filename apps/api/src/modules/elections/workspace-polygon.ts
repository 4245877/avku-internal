import { createHash } from "node:crypto";

import type { WorkspaceAreaDocument } from "./workspace-area-records";

/**
 * The working-area boundary, in the form the house reads need it.
 *
 * The polygon already existed on the server — it is validated and stored by
 * `workspace-area-records` — but nothing on the server ever asked it which
 * houses it covered. The client did, after downloading all of them, and then
 * discarded about four in five. This is the same test, moved to the side that
 * can act on the answer before the bytes are sent.
 */
export interface WorkspacePolygon {
  /** Rings as flat `[lon, lat, lon, lat, …]`, outer ring first. */
  rings: number[][];
  box: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** Stable identity of this boundary, for cache keys. */
  signature: string;
}

export function toWorkspacePolygon(
  document: WorkspaceAreaDocument | null | undefined,
): WorkspacePolygon | null {
  const coordinates = document?.geometry?.coordinates;

  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return null;
  }

  const rings: number[][] = [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const ring of coordinates) {
    if (!Array.isArray(ring) || ring.length < 3) {
      continue;
    }

    const flat: number[] = [];

    for (const position of ring) {
      if (!Array.isArray(position) || position.length < 2) {
        continue;
      }

      const lon = Number(position[0]);
      const lat = Number(position[1]);

      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        continue;
      }

      flat.push(
        lon,
        lat,
      );

      // Only the outer ring bounds the territory; a hole cannot extend it.
      if (rings.length === 0) {
        minLat = Math.min(
          minLat,
          lat,
        );
        maxLat = Math.max(
          maxLat,
          lat,
        );
        minLon = Math.min(
          minLon,
          lon,
        );
        maxLon = Math.max(
          maxLon,
          lon,
        );
      }
    }

    if (flat.length >= 6) {
      rings.push(flat);
    }
  }

  if (rings.length === 0 || !Number.isFinite(minLat)) {
    return null;
  }

  return {
    rings,
    box: {
      minLat,
      maxLat,
      minLon,
      maxLon,
    },
    signature: createHash("sha1")
      .update(JSON.stringify(rings))
      .digest("base64url")
      .slice(
        0,
        16,
      ),
  };
}

/** Ray casting against one ring of flat `[lon, lat, …]` pairs. */
function ringContains(
  ring: number[],
  lat: number,
  lon: number,
): boolean {
  let inside = false;
  const count = ring.length / 2;

  for (let index = 0, previous = count - 1; index < count; previous = index++) {
    const lonI = ring[index * 2];
    const latI = ring[index * 2 + 1];
    const lonJ = ring[previous * 2];
    const latJ = ring[previous * 2 + 1];

    if (
      latI > lat !== latJ > lat &&
      lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/** Metres per degree of latitude — good to a fraction of a per cent anywhere. */
const METERS_PER_DEGREE_LAT = 111_320;

/** Grows a lat/lon box by a margin in metres. */
export function expandBox(
  box: WorkspacePolygon["box"],
  marginMeters: number,
): WorkspacePolygon["box"] {
  const latMargin = marginMeters / METERS_PER_DEGREE_LAT;
  const midLatitude = (box.minLat + box.maxLat) / 2;
  const lonMargin = latMargin / Math.max(
    Math.cos((midLatitude * Math.PI) / 180),
    0.01,
  );

  return {
    minLat: box.minLat - latMargin,
    maxLat: box.maxLat + latMargin,
    minLon: box.minLon - lonMargin,
    maxLon: box.maxLon + lonMargin,
  };
}

/** Shortest distance from a point to a segment, in degrees of latitude. */
function distanceToSegment(
  lat: number,
  lon: number,
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  lonScale: number,
): number {
  // Longitude is squeezed towards the poles; scaling it makes the two axes
  // comparable so an ordinary Euclidean distance is metric enough here.
  const x = lon * lonScale;
  const y = lat;
  const xA = lonA * lonScale;
  const yA = latA;
  const xB = lonB * lonScale;
  const yB = latB;

  const dx = xB - xA;
  const dy = yB - yA;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(x - xA, y - yA);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((x - xA) * dx + (y - yA) * dy) / lengthSquared,
    ),
  );

  return Math.hypot(
    x - (xA + t * dx),
    y - (yA + t * dy),
  );
}

function distanceToBoundaryMeters(
  area: WorkspacePolygon,
  lat: number,
  lon: number,
): number {
  const lonScale = Math.cos((lat * Math.PI) / 180);
  let nearest = Infinity;

  for (const ring of area.rings) {
    const count = ring.length / 2;

    for (let index = 0, previous = count - 1; index < count; previous = index++) {
      const distance = distanceToSegment(
        lat,
        lon,
        ring[index * 2 + 1],
        ring[index * 2],
        ring[previous * 2 + 1],
        ring[previous * 2],
        lonScale,
      );

      if (distance < nearest) {
        nearest = distance;
      }
    }
  }

  return nearest * METERS_PER_DEGREE_LAT;
}

function containsPoint(
  area: WorkspacePolygon,
  lat: number,
  lon: number,
): boolean {
  if (!ringContains(
    area.rings[0],
    lat,
    lon,
  )) {
    return false;
  }

  // Any further ring is a hole punched in the territory.
  for (let index = 1; index < area.rings.length; index++) {
    if (ringContains(
      area.rings[index],
      lat,
      lon,
    )) {
      return false;
    }
  }

  return true;
}

/**
 * Whether the boundary covers this house.
 *
 * The rule being preserved is the client's: a building counts when it lies
 * inside the polygon **or crosses its border**, because a house on the edge of
 * the district is still a house to canvass. The client could apply that
 * literally — it had the outline in front of it. Here the outline is in another
 * response by design, so a house whose centre falls outside is kept when the
 * boundary passes within its own footprint radius: `√(area/π)`, the radius of a
 * circle of the same area. On the live territory that is the difference between
 * 1 440 houses and 1 441, and the one house is a block on Мала Кільцева whose
 * centre sits a few metres the wrong side of a line drawn through it.
 *
 * A house with no recorded area is judged on its centre alone — there is
 * nothing to be generous with.
 */
export function coversPoint(
  area: WorkspacePolygon,
  lat: number,
  lon: number,
  footprintAreaSqm: number | null = null,
): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }

  const radiusMeters = footprintAreaSqm && footprintAreaSqm > 0
    ? Math.sqrt(footprintAreaSqm / Math.PI)
    : 0;
  // The box is widened by the same slack, or a straddling house would be
  // rejected before the polygon ever saw it.
  const latSlack = radiusMeters / METERS_PER_DEGREE_LAT;
  const lonSlack = latSlack / Math.max(
    Math.cos((lat * Math.PI) / 180),
    0.01,
  );

  if (
    lat < area.box.minLat - latSlack || lat > area.box.maxLat + latSlack ||
    lon < area.box.minLon - lonSlack || lon > area.box.maxLon + lonSlack
  ) {
    return false;
  }

  if (containsPoint(
    area,
    lat,
    lon,
  )) {
    return true;
  }

  if (radiusMeters === 0) {
    return false;
  }

  return distanceToBoundaryMeters(
    area,
    lat,
    lon,
  ) <= radiusMeters;
}
