import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { HttpError } from "../../http/responses";

/**
 * The working-area boundary of the "Вибори" module.
 *
 * A browser cannot write `workspaceArea.geo.json` — it is a file in the
 * repository — so before this existed «Зберегти межу» meant a `localStorage`
 * entry: invisible to every other user, invisible to
 * `scripts/fetch-osm-buildings.mjs`, and gone with the browser profile. This
 * repository is the permanent home the button now writes to.
 *
 * One document, not a collection: there is exactly one territory at a time, and
 * "no document" is a meaningful state — it means the boundary shipped in the
 * repository is the current one.
 *
 * The polygon is validated here rather than trusted from the client. It is the
 * trust boundary, and a malformed boundary is not a cosmetic problem: every
 * consumer decides which houses exist by asking whether they fall inside it.
 */

export interface WorkspaceAreaRepositoryOptions {
  storageRoot: string;
}

export interface WorkspaceAreaDocument {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

export interface StoredWorkspaceArea {
  area: WorkspaceAreaDocument;
  updatedAt: string;
  updatedBy: string | null;
}

/** Enough to enclose ground, and the same floor the editor enforces. */
const MIN_RING_POINTS = 3;
/**
 * A hand-traced district runs to a few hundred vertices. The cap is generous
 * for that and still stops a single request from storing an unbounded polygon
 * that every later read has to parse.
 */
const MAX_RING_POINTS = 10_000;
const MAX_RINGS = 64;
/** Twice the area, in square degrees, below which a ring encloses nothing. */
const DEGENERATE_AREA_EPSILON = 1e-12;

function reject(reason: string): never {
  throw new HttpError(
    400,
    `Некоректна межа робочої території: ${reason}.`,
  );
}

function readPosition(
  position: unknown,
  ringIndex: number,
): [number, number] {
  if (!Array.isArray(position) || position.length < 2) {
    reject(`кільце ${ringIndex} містить координату, що не є парою [довгота, широта]`);
  }

  const [longitude, latitude] = position as unknown[];

  if (typeof longitude !== "number" || !Number.isFinite(longitude)) {
    reject(`кільце ${ringIndex}: довгота не є скінченним числом`);
  }

  if (typeof latitude !== "number" || !Number.isFinite(latitude)) {
    reject(`кільце ${ringIndex}: широта не є скінченним числом`);
  }

  // GeoJSON is [longitude, latitude]. These are range checks and not a swap
  // detector: around Kyiv (lat 50 / lon 30) the swapped pair is still in range
  // for both, so that specific mistake is only visible on the map. What they do
  // stop is every out-of-range value reaching the file on disk.
  if (latitude < -90 || latitude > 90) {
    reject(
      `кільце ${ringIndex}: широта ${latitude} поза діапазоном −90…90 — ` +
        "координати мають бути в порядку [довгота, широта]",
    );
  }

  if (longitude < -180 || longitude > 180) {
    reject(`кільце ${ringIndex}: довгота ${longitude} поза діапазоном −180…180`);
  }

  return [longitude, latitude];
}

function isSamePosition(
  first: [number, number],
  second: [number, number],
): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

/** Twice the signed planar area of a ring — zero means it encloses nothing. */
function doubleSignedArea(ring: [number, number][]): number {
  let total = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];

    total += x1 * y2 - x2 * y1;
  }

  return total;
}

function orientation(
  from: [number, number],
  via: [number, number],
  to: [number, number],
): number {
  const cross =
    (via[0] - from[0]) * (to[1] - from[1]) - (via[1] - from[1]) * (to[0] - from[0]);

  if (cross > 0) {
    return 1;
  }

  return cross < 0 ? -1 : 0;
}

function isOnSegment(
  from: [number, number],
  to: [number, number],
  point: [number, number],
): boolean {
  return (
    Math.min(from[0], to[0]) <= point[0] &&
    point[0] <= Math.max(from[0], to[0]) &&
    Math.min(from[1], to[1]) <= point[1] &&
    point[1] <= Math.max(from[1], to[1])
  );
}

function segmentsIntersect(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number],
): boolean {
  const first = orientation(a1, a2, b1);
  const second = orientation(a1, a2, b2);
  const third = orientation(b1, b2, a1);
  const fourth = orientation(b1, b2, a2);

  if (first !== second && third !== fourth) {
    return true;
  }

  return (
    (first === 0 && isOnSegment(a1, a2, b1)) ||
    (second === 0 && isOnSegment(a1, a2, b2)) ||
    (third === 0 && isOnSegment(b1, b2, a1)) ||
    (fourth === 0 && isOnSegment(b1, b2, a2))
  );
}

/**
 * A figure-of-eight has no unambiguous inside: the map's dimming mask fills by
 * the even-odd rule while the house filter counts crossings, so the two would
 * disagree about which half is the district. Rejected rather than half-honoured.
 */
function isSelfIntersecting(ring: [number, number][]): boolean {
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

/** An open ring — the closing vertex GeoJSON repeats is dropped for the checks. */
function readRing(
  coordinates: unknown,
  ringIndex: number,
): [number, number][] {
  if (!Array.isArray(coordinates)) {
    reject(`кільце ${ringIndex} не є масивом координат`);
  }

  if (coordinates.length > MAX_RING_POINTS) {
    reject(`кільце ${ringIndex} містить понад ${MAX_RING_POINTS} точок`);
  }

  const ring = coordinates.map((position) => readPosition(position, ringIndex));

  if (ring.length < MIN_RING_POINTS + 1) {
    reject(
      `кільце ${ringIndex} має містити щонайменше ${MIN_RING_POINTS} точок ` +
        "і повторювати першу в кінці",
    );
  }

  if (!isSamePosition(ring[0], ring[ring.length - 1])) {
    reject(`кільце ${ringIndex} не замкнене — остання точка має дорівнювати першій`);
  }

  const open = ring.slice(0, -1);

  if (open.length < MIN_RING_POINTS) {
    reject(`кільце ${ringIndex} має містити щонайменше ${MIN_RING_POINTS} точок`);
  }

  // Not `=== 0`: the shoelace sum of a collinear ring only cancels exactly in
  // exact arithmetic. In square degrees this threshold is well under a square
  // metre of ground, so it rejects lines and points and nothing else.
  if (Math.abs(doubleSignedArea(open)) < DEGENERATE_AREA_EPSILON) {
    reject(`кільце ${ringIndex} не охоплює жодної площі`);
  }

  if (isSelfIntersecting(open)) {
    reject(`кільце ${ringIndex} перетинає саме себе`);
  }

  return open;
}

/**
 * Validates and canonicalises a boundary sent by the editor. Accepts the same
 * shapes the web loader does — a bare geometry, a Feature, or a
 * FeatureCollection — and always stores a Feature, so a later read never has to
 * branch on which one arrived.
 */
export function normalizeWorkspaceArea(payload: unknown): WorkspaceAreaDocument {
  if (!payload || typeof payload !== "object") {
    reject("тіло запиту не є GeoJSON-обʼєктом");
  }

  const document = payload as Record<string, unknown>;

  if (document.type === "FeatureCollection") {
    const [first] = (document.features as unknown[]) ?? [];

    if (!first) {
      reject("FeatureCollection не містить жодного полігона");
    }

    return normalizeWorkspaceArea(first);
  }

  const isFeature = document.type === "Feature";
  const geometry = (isFeature ? document.geometry : document) as
    | Record<string, unknown>
    | undefined
    | null;

  if (!geometry || typeof geometry !== "object" || geometry.type !== "Polygon") {
    reject(
      `геометрія має тип "${String(geometry?.type ?? "невідомо")}", а не "Polygon"`,
    );
  }

  const rings = geometry.coordinates;

  if (!Array.isArray(rings) || rings.length === 0) {
    reject("Polygon не містить жодного кільця");
  }

  if (rings.length > MAX_RINGS) {
    reject(`Polygon містить понад ${MAX_RINGS} кілець`);
  }

  rings.forEach((ring, index) => readRing(ring, index));

  const properties = isFeature && document.properties && typeof document.properties === "object"
    ? (document.properties as Record<string, unknown>)
    : {};

  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: rings as number[][][],
    },
  };
}

export class WorkspaceAreaRepository {
  private readonly storageRoot: string;
  private readonly filePath: string;
  /** Serialises writes so two saves cannot interleave their temp file. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceAreaRepositoryOptions) {
    this.storageRoot = options.storageRoot;
    this.filePath = path.join(
      options.storageRoot,
      "workspace-area.geo.json",
    );
  }

  /** The saved boundary, or `null` when the shipped file is the territory. */
  async read(): Promise<StoredWorkspaceArea | null> {
    let content: string;

    try {
      content = await readFile(
        this.filePath,
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }

    try {
      const stored = JSON.parse(content) as Partial<StoredWorkspaceArea>;

      return {
        // Re-validated on read: the file is on disk and could have been edited
        // by hand, and serving a broken polygon would take the map down for
        // everybody rather than for whoever wrote it.
        area: normalizeWorkspaceArea(stored.area),
        updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : "",
        updatedBy: typeof stored.updatedBy === "string" ? stored.updatedBy : null,
      };
    } catch {
      // A corrupted file must not be a dead page: falling back to "no saved
      // boundary" puts the shipped one in force, which always works.
      console.error(`[elections] Пошкоджений файл межі: ${this.filePath}`);

      return null;
    }
  }

  /** Makes a traced boundary the permanent one. */
  async save(
    payload: unknown,
    updatedBy: string | null = null,
  ): Promise<StoredWorkspaceArea> {
    const record: StoredWorkspaceArea = {
      area: normalizeWorkspaceArea(payload),
      updatedAt: new Date().toISOString(),
      updatedBy,
    };

    await this.enqueue(async () => {
      await mkdir(
        this.storageRoot,
        {
          recursive: true,
        },
      );

      // Written to a sibling and renamed: a boundary half-written by a crash or
      // a full disk would otherwise be read back as corrupt on the next load.
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;

      await writeFile(
        temporaryPath,
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );
      await rename(
        temporaryPath,
        this.filePath,
      );
    });

    return record;
  }

  /** Drops the saved boundary, so the shipped file is the territory again. */
  async clear(): Promise<void> {
    await this.enqueue(() =>
      rm(
        this.filePath,
        {
          force: true,
        },
      ),
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(
      operation,
      operation,
    );

    this.writeChain = result.catch(() => undefined);

    return result;
  }
}
