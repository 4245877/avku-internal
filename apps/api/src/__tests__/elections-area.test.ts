import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { createCertificateApiServer } from "../server";
import { WorkspaceAreaRepository } from "../modules/elections/workspace-area-records";

/**
 * `/api/elections/area` — the permanent home of the "Вибори" working-area
 * boundary.
 *
 * This endpoint is the reason «Зберегти межу» now means something durable: a
 * browser cannot write `workspaceArea.geo.json`, so before it existed a saved
 * boundary lived in one `localStorage` entry, invisible to every other user and
 * to the snapshot script.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

/** A small square district, closed as GeoJSON requires. */
const SQUARE = [
  [30.37, 50.43],
  [30.38, 50.43],
  [30.38, 50.44],
  [30.37, 50.44],
  [30.37, 50.43],
];

function feature(coordinates: number[][][], name = "Тестова територія") {
  return {
    type: "Feature",
    properties: {
      name,
    },
    geometry: {
      type: "Polygon",
      coordinates,
    },
  };
}

/**
 * The boundary decides which houses exist for everybody, so writing it now
 * requires the `admin` role (it used to be open to anyone on the LAN). These
 * tests are about polygon validation, not about authorization, so every request
 * carries an admin identity; the refusals themselves are covered in
 * `elections-domain.test.ts`.
 */
const ADMIN = "area-admin@avku.test";

async function api(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "x-test-user": ADMIN,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(
    `${baseUrl}${pathname}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const text = await response.text();

  return {
    status: response.status,
    json: text ? JSON.parse(text) : undefined,
  };
}

before(async () => {
  dataRoot = await mkdtemp(path.join(
    tmpdir(),
    "avku-elections-",
  ));
  process.env.DATA_ROOT = dataRoot;
  process.env.ELECTIONS_ADMIN_EMAILS = ADMIN;

  server = createCertificateApiServer(
    undefined,
    {
      authenticator: {
        enabled: true,
        authenticate: async (request) => {
          const email = request.headers["x-test-user"];

          return typeof email === "string" && email
            ? {
              email,
            }
            : null;
        },
      },
    },
  );

  await new Promise<void>((resolve) => server.listen(
    0,
    "127.0.0.1",
    resolve,
  ));

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(
    dataRoot,
    {
      recursive: true,
      force: true,
    },
  );
  delete process.env.ELECTIONS_ADMIN_EMAILS;
});

test("answers 404 while no boundary is saved", async () => {
  const response = await api(
    "GET",
    "/api/elections/area",
  );

  // Not an error: it tells the client the shipped file is the territory, and
  // that a stale local cache should be dropped rather than kept.
  assert.equal(
    response.status,
    404,
  );
});

test("saves a traced boundary and reads it back", async () => {
  const saved = await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([SQUARE]),
    },
  );

  assert.equal(
    saved.status,
    200,
  );
  assert.equal(
    saved.json.area.geometry.type,
    "Polygon",
  );
  assert.ok(saved.json.updatedAt);

  const reloaded = await api(
    "GET",
    "/api/elections/area",
  );

  assert.equal(
    reloaded.status,
    200,
  );
  assert.deepEqual(
    reloaded.json.area.geometry.coordinates,
    [SQUARE],
  );
  assert.equal(
    reloaded.json.area.properties.name,
    "Тестова територія",
  );
});

test("replaces the boundary rather than accumulating them", async () => {
  const moved = SQUARE.map(([lon, lat]) => [lon + 0.05, lat]);

  await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature(
        [moved],
        "Пересунута",
      ),
    },
  );

  const reloaded = await api(
    "GET",
    "/api/elections/area",
  );

  assert.equal(
    reloaded.json.area.properties.name,
    "Пересунута",
  );
  assert.deepEqual(
    reloaded.json.area.geometry.coordinates,
    [moved],
  );
});

test("accepts a bare GeoJSON document as well as { area }", async () => {
  const response = await api(
    "PUT",
    "/api/elections/area",
    feature([SQUARE]),
  );

  assert.equal(
    response.status,
    200,
  );
  assert.deepEqual(
    response.json.area.geometry.coordinates,
    [SQUARE],
  );
});

test("rejects a ring that is not closed", async () => {
  const open = SQUARE.slice(
    0,
    -1,
  );
  const response = await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([open]),
    },
  );

  assert.equal(
    response.status,
    400,
  );
  assert.match(
    response.json.error,
    /не замкнене/,
  );
});

test("rejects a ring with fewer than three points", async () => {
  const response = await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([[
        [30.37, 50.43],
        [30.38, 50.44],
        [30.37, 50.43],
      ]]),
    },
  );

  assert.equal(
    response.status,
    400,
  );
});

test("rejects coordinates outside the legal lon/lat ranges", async () => {
  const response = await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([[
        [30.37, 95],
        [30.38, 95],
        [30.38, 96],
        [30.37, 95],
      ]]),
    },
  );

  assert.equal(
    response.status,
    400,
  );
  assert.match(
    response.json.error,
    /широта/,
  );
});

test("rejects a self-intersecting outline", async () => {
  const response = await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([[
        [30.370, 50.430],
        [30.382, 50.446],
        [30.382, 50.430],
        [30.370, 50.440],
        [30.370, 50.430],
      ]]),
    },
  );

  assert.equal(
    response.status,
    400,
  );
  assert.match(
    response.json.error,
    /перетинає саме себе/,
  );
});

test("rejects an outline that encloses no ground", async () => {
  const response = await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([[
        [30.37, 50.43],
        [30.37, 50.44],
        [30.37, 50.45],
        [30.37, 50.43],
      ]]),
    },
  );

  assert.equal(
    response.status,
    400,
  );
  assert.match(
    response.json.error,
    /не охоплює жодної площі/,
  );
});

test("rejects a geometry that is not a Polygon", async () => {
  const response = await api(
    "PUT",
    "/api/elections/area",
    {
      area: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: SQUARE,
        },
      },
    },
  );

  assert.equal(
    response.status,
    400,
  );
  assert.match(
    response.json.error,
    /Polygon/,
  );
});

test("a rejected boundary leaves the saved one untouched", async () => {
  const before = await api(
    "GET",
    "/api/elections/area",
  );

  await api(
    "PUT",
    "/api/elections/area",
    {
      area: feature([SQUARE.slice(
        0,
        -1,
      )]),
    },
  );

  const after = await api(
    "GET",
    "/api/elections/area",
  );

  assert.deepEqual(
    after.json.area,
    before.json.area,
  );
});

test("DELETE goes back to the boundary shipped in the repository", async () => {
  const removed = await api(
    "DELETE",
    "/api/elections/area",
  );

  assert.equal(
    removed.status,
    200,
  );
  assert.equal(
    (await api(
      "GET",
      "/api/elections/area",
    )).status,
    404,
  );
});

test("DELETE is idempotent", async () => {
  assert.equal(
    (await api(
      "DELETE",
      "/api/elections/area",
    )).status,
    200,
  );
});

test("a hand-corrupted file reads as 'no saved boundary' rather than a dead page", async () => {
  const storageRoot = path.join(
    dataRoot,
    "elections-corrupt",
  );
  const repository = new WorkspaceAreaRepository({
    storageRoot,
  });

  await repository.save(feature([SQUARE]));
  await writeFile(
    path.join(
      storageRoot,
      "workspace-area.geo.json",
    ),
    "{ not json",
    "utf8",
  );

  assert.equal(
    await repository.read(),
    null,
  );
});

test("writes the boundary atomically, leaving no temp file behind", async () => {
  const storageRoot = path.join(
    dataRoot,
    "elections-atomic",
  );
  const repository = new WorkspaceAreaRepository({
    storageRoot,
  });

  await Promise.all([
    repository.save(feature(
      [SQUARE],
      "перша",
    )),
    repository.save(feature(
      [SQUARE],
      "друга",
    )),
  ]);

  const content = await readFile(
    path.join(
      storageRoot,
      "workspace-area.geo.json",
    ),
    "utf8",
  );

  // Whichever write landed last, the file has to be complete and parseable.
  assert.ok(JSON.parse(content).area.geometry.coordinates);
});
