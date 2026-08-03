import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { createCertificateApiServer } from "../server";
import { createElectionsRepository } from "../config";
import { importOsmSnapshot } from "../modules/elections/osm-snapshot-import";
import type { AccessAuthenticator } from "../http/access-auth";

/**
 * The "Вибори" domain API.
 *
 * The cases below are the acceptance criteria of the rebuild, expressed as
 * requests: an OSM re-import must not orphan data, two campaigns must not
 * overwrite each other, a write without a role must be 403, an agitator must
 * not see somebody else's contacts, a default export must carry no personal
 * data, and an import must be reversible by batch id.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

const ADMIN = "admin@avku.test";
const MANAGER = "manager@avku.test";
const COORDINATOR = "coordinator@avku.test";
const AGITATOR = "agitator@avku.test";
const OTHER_AGITATOR = "other@avku.test";

/**
 * Stands in for Cloudflare Access: the caller's identity comes from a header
 * the test controls, exactly as a verified JWT would supply it in production.
 * `null` reproduces an unauthenticated request.
 */
const testAuthenticator: AccessAuthenticator = {
  enabled: true,
  authenticate: async (request) => {
    const email = request.headers["x-test-user"];

    if (typeof email !== "string" || !email) {
      return null;
    }

    return {
      email,
    };
  },
};

interface ApiResponse<T = any> {
  status: number;
  json: T;
  text: string;
}

async function api(
  method: string,
  pathname: string,
  options: { as?: string | null; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};

  if (options.as) {
    headers["x-test-user"] = options.as;
  }

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(
    `${baseUrl}${pathname}`,
    {
      method,
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    },
  );
  const text = await response.text();

  return {
    status: response.status,
    text,
    json: text.startsWith("{") || text.startsWith("[")
      ? JSON.parse(text)
      : undefined,
  };
}

/** Two buildings, one of them a multipolygon, in the shape the snapshot uses. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    osmTimestamp: "2026-07-02T16:51:45Z",
    houses: [
      {
        id: "way/1001",
        osmType: "way",
        osmId: 1001,
        street: "вулиця Зодчих",
        streetShort: "вул. Зодчих",
        number: "58-А",
        address: "вул. Зодчих, 58-А",
        fullAddress: "вулиця Зодчих, 58-А, Київ",
        name: null,
        type: "apartments",
        building: "apartments",
        floors: 9,
        builtYear: 1978,
        footprintAreaSqm: 1200,
        location: {
          lat: 50.4307,
          lon: 30.364,
        },
        footprint: [
          {
            lat: 50.4307,
            lon: 30.364,
          },
          {
            lat: 50.4308,
            lon: 30.3641,
          },
          {
            lat: 50.4309,
            lon: 30.3642,
          },
        ],
      },
      {
        id: "relation/2002",
        osmType: "relation",
        osmId: 2002,
        street: "вулиця Тулузи",
        streetShort: "вул. Тулузи",
        number: "3",
        address: "вул. Тулузи, 3",
        fullAddress: "вулиця Тулузи, 3, Київ",
        name: null,
        type: "apartments",
        building: "residential",
        floors: 5,
        builtYear: null,
        footprintAreaSqm: 900,
        location: {
          lat: 50.44,
          lon: 30.37,
        },
        footprint: [
          {
            lat: 50.44,
            lon: 30.37,
          },
          {
            lat: 50.4401,
            lon: 30.3701,
          },
          {
            lat: 50.4402,
            lon: 30.3702,
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function seedSnapshot(document = snapshot()) {
  const repository = createElectionsRepository();

  return repository.withTransaction((database) =>
    importOsmSnapshot(
      database,
      document,
      {
        actor: "test",
        origin: "script",
      },
    ));
}

before(async () => {
  dataRoot = await mkdtemp(path.join(
    tmpdir(),
    "avku-elections-domain-",
  ));
  process.env.DATA_ROOT = dataRoot;
  // Bootstrap: the first admin comes from deployment configuration, because on
  // a fresh database nobody has a role and so nobody could grant one.
  process.env.ELECTIONS_ADMIN_EMAILS = ADMIN;
  delete process.env.ELECTIONS_DEV_AUTH;
  delete process.env.ELECTIONS_DEV_ROLE;

  server = createCertificateApiServer(
    undefined,
    {
      authenticator: testAuthenticator,
    },
  );

  await new Promise<void>((resolve) =>
    server.listen(
      0,
      "127.0.0.1",
      resolve,
    ));

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;

  await seedSnapshot();

  // Every later role is granted through the real endpoint, so the grant path is
  // itself under test.
  for (const [email, role] of [
    [
      MANAGER,
      "manager",
    ],
    [
      COORDINATOR,
      "coordinator",
    ],
    [
      AGITATOR,
      "agitator",
    ],
    [
      OTHER_AGITATOR,
      "agitator",
    ],
  ]) {
    // Provision the employee row by making one authenticated request as them.
    await api(
      "GET",
      "/api/me",
      {
        as: email,
      },
    );

    const granted = await api(
      "PUT",
      `/api/elections/roles/${encodeURIComponent(email)}`,
      {
        as: ADMIN,
        body: {
          role,
        },
      },
    );

    assert.equal(
      granted.status,
      200,
      `granting ${role} to ${email}: ${granted.text}`,
    );
  }
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

describe("OSM snapshot import", () => {
  test("creates one house per snapshot object with an internal id", async () => {
    const repository = createElectionsRepository();
    const database = await repository.getDatabase();
    const rows = database.prepare(
      "SELECT id, osm_type, osm_id FROM houses WHERE deleted_at IS NULL",
    ).all() as Record<string, unknown>[];

    assert.equal(
      rows.length,
      2,
    );

    for (const row of rows) {
      // The primary key must not be the OSM id in any form.
      assert.notEqual(
        String(row.id),
        `${String(row.osm_type)}/${Number(row.osm_id)}`,
      );
      assert.match(
        String(row.id),
        /^[0-9a-f-]{36}$/,
      );
    }
  });

  test("a second run over the same snapshot changes nothing", async () => {
    const report = await seedSnapshot();

    assert.equal(
      report.created,
      0,
    );
    assert.equal(
      report.updated,
      0,
    );
    assert.equal(
      report.unchanged,
      2,
    );
  });

  test("re-import keeps the internal id, so recorded work is not orphaned", async () => {
    const repository = createElectionsRepository();
    const database = await repository.getDatabase();
    const before = database.prepare(
      "SELECT id FROM houses WHERE osm_id = 1001",
    ).get() as Record<string, unknown>;

    // A mapper corrects the house number and adds a storey.
    const changed = snapshot();

    changed.houses[0].number = "58-Б";
    changed.houses[0].floors = 10;

    const report = await seedSnapshot(changed);
    const after = database.prepare(
      "SELECT id, number, floors FROM houses WHERE osm_id = 1001",
    ).get() as Record<string, unknown>;

    assert.equal(
      report.updated,
      1,
    );
    assert.equal(
      String(after.id),
      String(before.id),
      "the internal id must survive an OSM attribute change",
    );
    assert.equal(
      String(after.number),
      "58-Б",
    );

    // Put the snapshot back so later tests see the original address.
    await seedSnapshot();
  });

  test("an object that disappears from OSM is flagged, never deleted", async () => {
    const partial = snapshot();

    partial.houses = [partial.houses[0]];

    const report = await seedSnapshot(partial);

    assert.equal(
      report.markedMissing,
      1,
    );

    const repository = createElectionsRepository();
    const database = await repository.getDatabase();
    const row = database.prepare(
      "SELECT osm_status, deleted_at FROM houses WHERE osm_id = 2002",
    ).get() as Record<string, unknown>;

    assert.equal(
      String(row.osm_status),
      "missing",
    );
    assert.equal(
      row.deleted_at,
      null,
    );

    await seedSnapshot();
  });
});

describe("authorization", () => {
  test("an unauthenticated write is refused", async () => {
    const created = await api(
      "POST",
      "/api/elections/campaigns",
      {
        body: {
          name: "Анонімна кампанія",
        },
      },
    );

    assert.equal(
      created.status,
      401,
    );
  });

  test("an identified user with no role cannot write", async () => {
    await api(
      "GET",
      "/api/me",
      {
        as: "nobody@avku.test",
      },
    );

    const created = await api(
      "POST",
      "/api/elections/campaigns",
      {
        as: "nobody@avku.test",
        body: {
          name: "Кампанія без прав",
        },
      },
    );

    // Refused as 403: the caller is identified, so the missing piece is a
    // grant, not a login. 401 here sent them back to a sign-in that would
    // change nothing.
    assert.equal(
      created.status,
      403,
      "no role is not a role: the request must not be treated as authorized",
    );
  });

  test("the working-area boundary is admin-only", async () => {
    const square = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [
              30.37,
              50.43,
            ],
            [
              30.38,
              50.43,
            ],
            [
              30.38,
              50.44,
            ],
            [
              30.37,
              50.44,
            ],
            [
              30.37,
              50.43,
            ],
          ],
        ],
      },
    };

    const asCoordinator = await api(
      "PUT",
      "/api/elections/area",
      {
        as: COORDINATOR,
        body: {
          area: square,
        },
      },
    );

    assert.equal(
      asCoordinator.status,
      403,
    );

    const anonymous = await api(
      "PUT",
      "/api/elections/area",
      {
        body: {
          area: square,
        },
      },
    );

    assert.equal(
      anonymous.status,
      401,
      "a request with no identity must not be able to redraw the territory",
    );
  });

  test("granting roles is admin-only", async () => {
    const attempt = await api(
      "PUT",
      `/api/elections/roles/${encodeURIComponent(AGITATOR)}`,
      {
        as: MANAGER,
        body: {
          role: "admin",
        },
      },
    );

    assert.equal(
      attempt.status,
      403,
    );
  });
});

describe("campaigns and house state", () => {
  let firstCampaignId = "";
  let secondCampaignId = "";
  let houseId = "";

  test("an admin can create a campaign", async () => {
    const created = await api(
      "POST",
      "/api/elections/campaigns",
      {
        as: ADMIN,
        body: {
          name: "Кампанія 2026",
          status: "active",
          hqAddress: "вулиця Зодчих, 58А",
        },
      },
    );

    assert.equal(
      created.status,
      201,
      created.text,
    );
    firstCampaignId = created.json.id;
    assert.equal(
      created.json.status,
      "active",
    );
  });

  test("houses come back with campaign state merged in", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );

    assert.equal(
      listed.status,
      200,
      listed.text,
    );
    assert.equal(
      listed.json.houses.length,
      2,
    );

    const house = listed.json.houses[0];

    houseId = house.id;

    /*
     * The map payload is a projection, not the record. A field at its default
     * is omitted rather than sent — `stage` and `priority` are absent here
     * precisely because this house is at `not_started`/`medium`, and the client
     * fills those back in.
     */
    assert.equal(
      house.stage,
      undefined,
      "a house at the default stage does not carry one",
    );
    assert.equal(
      house.openIssues,
      undefined,
      "a zero counter is omitted rather than sent",
    );
    assert.equal(
      typeof house.lat,
      "number",
    );
    assert.equal(
      typeof house.street,
      "number",
      "the street is an index into the payload's dictionary",
    );
    assert.ok(Array.isArray(listed.json.streets));

    /*
     * The outline is not in the map payload at all — it is immutable, so it is
     * served under its own version by `/houses/geometry` and cached by the
     * browser rather than re-sent with every campaign update.
     */
    assert.equal(
      house.footprint,
      undefined,
    );
    assert.ok(listed.json.geometryVersion);

    // Nothing about a resident's politics or age exists in the payload.
    assert.equal(
      listed.text.includes("stance"),
      false,
    );
    assert.equal(
      listed.text.includes("ageGroup"),
      false,
    );
  });

  test("the server rejects a stage it does not know", async () => {
    const patched = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state`,
      {
        as: MANAGER,
        body: {
          stage: "вигадка",
        },
      },
    );

    assert.equal(
      patched.status,
      400,
      "the stage vocabulary is enforced by the server, not by the client",
    );
  });

  test("a house the caller cannot see answers 404 before any validation", async () => {
    // The agitator has no assignment yet. The answer must not distinguish
    // "no such house" from "not yours", and must not leak that the payload was
    // otherwise well formed.
    const patched = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state`,
      {
        as: AGITATOR,
        body: {
          stage: "in_progress",
        },
      },
    );

    assert.equal(
      patched.status,
      404,
    );
  });

  test("a second campaign does not overwrite the first one's state", async () => {
    const first = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${firstCampaignId}`,
      {
        as: MANAGER,
        body: {
          stage: "done",
          priority: "high",
        },
      },
    );

    assert.equal(
      first.status,
      200,
      first.text,
    );

    const secondCampaign = await api(
      "POST",
      "/api/elections/campaigns",
      {
        as: ADMIN,
        body: {
          name: "Кампанія 2027",
          status: "draft",
        },
      },
    );

    secondCampaignId = secondCampaign.json.id;

    const inSecond = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${secondCampaignId}`,
      {
        as: MANAGER,
        body: {
          stage: "not_started",
        },
      },
    );

    assert.equal(
      inSecond.status,
      200,
      inSecond.text,
    );

    const firstAgain = await api(
      "GET",
      `/api/elections/houses/${houseId}?campaignId=${firstCampaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      firstAgain.json.campaign.stage,
      "done",
      "the first campaign's result must survive work in the second",
    );
    assert.equal(
      firstAgain.json.campaign.priority,
      "high",
    );
  });

  test("archiving keeps the campaign's history readable", async () => {
    const archived = await api(
      "POST",
      `/api/elections/campaigns/${secondCampaignId}/archive`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      archived.status,
      200,
      archived.text,
    );
    assert.equal(
      archived.json.status,
      "archived",
    );
    assert.ok(archived.json.archivedAt);

    const readBack = await api(
      "GET",
      `/api/elections/campaigns/${secondCampaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      readBack.status,
      200,
    );

    const asAgitator = await api(
      "GET",
      `/api/elections/campaigns/${secondCampaignId}`,
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      asAgitator.status,
      403,
      "an archive is readable, but only by the roles allowed to open one",
    );
  });
});

describe("field work", () => {
  let houseId = "";

  before(async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );

    houseId = listed.json.houses[0].id;

    // A coordinator holds the territory that was granted to them and nothing
    // else, so the grant has to be explicit before they can work this house.
    // There used to be an implicit fallback that handed an unassigned
    // coordinator the entire campaign; it is gone.
    await api(
      "POST",
      "/api/elections/assignments",
      {
        as: MANAGER,
        body: {
          scope: "house",
          scopeId: houseId,
          employeeEmail: COORDINATOR,
          role: "coordinator",
        },
      },
    );
  });

  test("an action is attributed to the caller, not to a field they sent", async () => {
    const created = await api(
      "POST",
      "/api/elections/actions",
      {
        as: COORDINATOR,
        body: {
          houseId,
          type: "visit",
          result: "no_answer",
          comment: "Ніхто не відчинив",
          // A client trying to sign somebody else's name must be ignored.
          authorEmail: "someone.else@avku.test",
          updatedBy: "Іван",
        },
      },
    );

    assert.equal(
      created.status,
      201,
      created.text,
    );

    const listed = await api(
      "GET",
      `/api/elections/houses/${houseId}/actions`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      listed.json[0].authorEmail,
      COORDINATOR,
    );
  });

  test("the house's last action is derived, not stored by hand", async () => {
    const house = await api(
      "GET",
      `/api/elections/houses/${houseId}`,
      {
        as: MANAGER,
      },
    );

    assert.ok(
      house.json.campaign.lastActionAt,
      "last action must come from the actions table",
    );
    assert.equal(
      house.json.campaign.lastActionType,
      "visit",
    );
  });

  test("overdue tasks are counted on the house", async () => {
    const created = await api(
      "POST",
      "/api/elections/tasks",
      {
        as: COORDINATOR,
        body: {
          houseId,
          title: "Передзвонити голові ОСББ",
          dueAt: "2020-01-01T10:00:00.000Z",
        },
      },
    );

    assert.equal(
      created.status,
      201,
      created.text,
    );

    const house = await api(
      "GET",
      `/api/elections/houses/${houseId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      house.json.campaign.overdueTasksCount,
      1,
    );
    assert.ok(house.json.quality.includes("overdueTasks"));

    const overdue = await api(
      "GET",
      "/api/elections/tasks?scope=overdue",
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      overdue.json.length,
      1,
    );
    assert.equal(
      overdue.json[0].isOverdue,
      true,
    );
  });

  test("an unassigned task is findable as such", async () => {
    const unassigned = await api(
      "GET",
      "/api/elections/tasks?scope=unassigned",
      {
        as: COORDINATOR,
      },
    );

    assert.ok(unassigned.json.length >= 1);
    assert.equal(
      unassigned.json[0].isUnassigned,
      true,
    );
  });

  test("open issues are counted on the house", async () => {
    const created = await api(
      "POST",
      "/api/elections/issues",
      {
        as: AGITATOR,
        body: {
          houseId,
          category: "lighting",
          title: "Не працює світло у 2 підʼїзді",
        },
      },
    );

    // The agitator is not assigned to this house yet, so the write is refused
    // at the house level rather than at the issue level.
    assert.equal(
      created.status,
      404,
    );

    const byCoordinator = await api(
      "POST",
      "/api/elections/issues",
      {
        as: COORDINATOR,
        body: {
          houseId,
          category: "lighting",
          title: "Не працює світло у 2 підʼїзді",
        },
      },
    );

    assert.equal(
      byCoordinator.status,
      201,
      byCoordinator.text,
    );

    const house = await api(
      "GET",
      `/api/elections/houses/${houseId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      house.json.campaign.openIssuesCount,
      1,
    );
  });

  test("a soft-deleted record leaves the counters but keeps its history", async () => {
    const issues = await api(
      "GET",
      `/api/elections/houses/${houseId}/issues`,
      {
        as: COORDINATOR,
      },
    );
    const issueId = issues.json[0].id;

    const removed = await api(
      "DELETE",
      `/api/elections/issues/${issueId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      removed.status,
      200,
    );

    const repository = createElectionsRepository();
    const database = await repository.getDatabase();
    const row = database.prepare(
      "SELECT deleted_at FROM issues WHERE id = ?",
    ).get(issueId) as Record<string, unknown>;

    assert.ok(
      row.deleted_at,
      "the row must still exist, flagged rather than removed",
    );

    const history = await api(
      "GET",
      `/api/elections/history?entityId=${issueId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.ok(
      history.json.some((entry: any) => entry.operation === "delete"),
    );
    assert.equal(
      history.json.every((entry: any) => entry.changedBy.includes("@")),
      true,
      "every history row must name a real identity",
    );
  });
});

describe("assignments and contact visibility", () => {
  let houseId = "";
  let otherHouseId = "";

  before(async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );

    houseId = listed.json.houses[0].id;
    otherHouseId = listed.json.houses[1].id;

    await api(
      "POST",
      "/api/elections/assignments",
      {
        as: COORDINATOR,
        body: {
          scope: "house",
          scopeId: houseId,
          employeeEmail: AGITATOR,
        },
      },
    );

    await api(
      "POST",
      `/api/elections/houses/${houseId}/people`,
      {
        as: COORDINATOR,
        body: {
          fullName: "Коваленко Олена Петрівна",
          role: "osbb_head",
          contacts: [
            {
              type: "phone",
              value: "+380671234567",
              isPrimary: true,
            },
          ],
        },
      },
    );
  });

  test("an agitator sees only the houses assigned to them", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      listed.json.houses.length,
      1,
    );
    assert.equal(
      listed.json.houses[0].id,
      houseId,
    );

    const foreign = await api(
      "GET",
      `/api/elections/houses/${otherHouseId}`,
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      foreign.status,
      404,
    );
  });

  test("an agitator sees contacts for their own house", async () => {
    const people = await api(
      "GET",
      `/api/elections/houses/${houseId}/people`,
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      people.status,
      200,
    );
    assert.equal(
      people.json[0].fullName,
      "Коваленко Олена Петрівна",
    );
    assert.equal(
      people.json[0].contacts[0].value,
      "+380671234567",
    );
    assert.equal(
      people.json[0].isMasked,
      false,
    );
  });

  test("another agitator cannot read those contacts at all", async () => {
    const people = await api(
      "GET",
      `/api/elections/houses/${houseId}/people`,
      {
        as: OTHER_AGITATOR,
      },
    );

    assert.equal(
      people.status,
      404,
    );
    assert.equal(
      people.text.includes("380671234567"),
      false,
      "an unrelated agitator must never receive the number in any form",
    );
  });

  /**
   * What the map is allowed to weigh.
   *
   * By this point the house has a resident with a phone number, an access note,
   * a visit log, an open issue and an overdue task — everything the card shows.
   * The map payload is drawn for the whole territory at once, so none of it may
   * travel with it: a canvasser opening the section downloads a map, not
   * everybody's phone number. Each of these was in the response before the
   * split, which is why they are asserted by name rather than in a loop.
   */
  test("the map payload carries no contact, note or record detail", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );

    assert.equal(
      listed.status,
      200,
      listed.text,
    );

    for (const forbidden of [
      "380671234567", // a resident's phone number
      "Коваленко", // a resident's name
      "Домофон", // the building's access note
      "comment", // what was said on a visit
      "description", // an issue's or a task's body
      "changedAt", // the change log
      "attachment", // uploaded files
      "priorityReason", // why somebody set this priority
      "summary", // the coordinator's free-text note
      "canSeeContacts", // a per-house permission flag the map never reads
    ]) {
      assert.equal(
        listed.text.includes(forbidden),
        false,
        `the map payload must not contain "${forbidden}"`,
      );
    }

    // The counters the filters run on do survive — they are numbers about the
    // house, not records about a person. They also have to agree with the card,
    // or the map would filter on one set of numbers and the card show another.
    const house = listed.json.houses.find(
      (candidate: { id: string }) => candidate.id === houseId,
    );

    assert.ok(house);

    const card = await api(
      "GET",
      `/api/elections/houses/${houseId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      house.openIssues ?? 0,
      card.json.campaign.openIssuesCount,
    );
    assert.equal(
      house.overdueTasks ?? 0,
      card.json.campaign.overdueTasksCount,
    );
    assert.equal(
      house.lastActionAt ?? null,
      card.json.campaign.lastActionAt,
      "the map shows when a house was last visited, not what was said",
    );
  });

  test("phone search finds the house an agitator may see", async () => {
    const found = await api(
      "GET",
      "/api/elections/search?q=0671234567",
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      found.status,
      200,
      found.text,
    );
    assert.equal(
      found.json.length,
      1,
    );
    assert.equal(
      found.json[0].matchedOn,
      "phone",
    );
    assert.equal(
      found.json[0].houseId,
      houseId,
    );
  });

  test("phone search reveals nothing to somebody without access", async () => {
    const found = await api(
      "GET",
      "/api/elections/search?q=0671234567",
      {
        as: OTHER_AGITATOR,
      },
    );

    assert.equal(
      found.status,
      200,
    );
    assert.deepEqual(
      found.json,
      [],
    );
  });

  test("houses without an assignee are flagged", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );
    const unassigned = listed.json.houses.filter((house: any) =>
      house.quality.includes("noAssignee")
    );

    assert.equal(
      unassigned.length,
      1,
    );
    assert.equal(
      unassigned[0].id,
      otherHouseId,
    );
  });
});

describe("bulk operations", () => {
  test("a bulk assignment without confirmation is refused", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );
    const houseIds = listed.json.houses.map((house: any) => house.id);

    const unconfirmed = await api(
      "POST",
      "/api/elections/bulk/assign",
      {
        as: MANAGER,
        body: {
          houseIds,
          employeeEmail: OTHER_AGITATOR,
        },
      },
    );

    assert.equal(
      unconfirmed.status,
      400,
    );
    assert.match(
      unconfirmed.json.error,
      /підтвердити/,
    );
  });

  test("a coordinator cannot run a bulk assignment", async () => {
    const refused = await api(
      "POST",
      "/api/elections/bulk/assign",
      {
        as: COORDINATOR,
        body: {
          houseIds: [],
          employeeEmail: OTHER_AGITATOR,
          confirm: true,
        },
      },
    );

    assert.equal(
      refused.status,
      403,
    );
  });

  test("a confirmed bulk assignment is applied and journalled", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );
    const houseIds = listed.json.houses.map((house: any) => house.id);

    const preview = await api(
      "POST",
      "/api/elections/bulk/preview",
      {
        as: MANAGER,
        body: {
          houseIds,
        },
      },
    );

    assert.equal(
      preview.json.affected,
      houseIds.length,
    );

    const applied = await api(
      "POST",
      "/api/elections/bulk/assign",
      {
        as: MANAGER,
        body: {
          houseIds,
          employeeEmail: OTHER_AGITATOR,
          confirm: true,
        },
      },
    );

    assert.equal(
      applied.status,
      200,
      applied.text,
    );
    assert.equal(
      applied.json.created,
      houseIds.length,
    );

    const history = await api(
      "GET",
      `/api/elections/history?batchId=${applied.json.batchId}`,
      {
        as: MANAGER,
      },
    );

    assert.ok(
      history.json.some((entry: any) => entry.operation === "bulk_assign"),
      "a bulk operation must be one identifiable entry in the journal",
    );
  });
});

describe("export", () => {
  test("the default export carries no personal data", async () => {
    const exported = await api(
      "GET",
      "/api/elections/export",
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      exported.status,
      200,
    );
    assert.equal(
      exported.text.includes("contactName"),
      false,
    );
    assert.equal(
      exported.text.includes("Коваленко"),
      false,
    );
    assert.equal(
      exported.text.includes("380671234567"),
      false,
    );
    assert.equal(
      exported.text.includes("stance"),
      false,
    );
  });

  test("a full export needs a manager and is written to the journal", async () => {
    const refused = await api(
      "GET",
      "/api/elections/export?scope=full",
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      refused.status,
      403,
    );

    const allowed = await api(
      "GET",
      "/api/elections/export?scope=full&reason=звіт",
      {
        as: MANAGER,
      },
    );

    assert.equal(
      allowed.status,
      200,
    );
    assert.equal(
      allowed.text.includes("Коваленко"),
      true,
    );

    const journal = await api(
      "GET",
      "/api/elections/access-log?kind=export",
      {
        as: ADMIN,
      },
    );

    const entry = journal.json.find((row: any) => row.includesPersonal);

    assert.ok(entry);
    assert.equal(
      entry.actor,
      MANAGER,
    );
    assert.equal(
      entry.reason,
      "звіт",
    );
  });
});

describe("import", () => {
  let batchId = "";
  let houseId = "";

  before(async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );

    houseId = listed.json.houses[0].id;
  });

  test("import is admin-only", async () => {
    const refused = await api(
      "POST",
      "/api/elections/import",
      {
        as: MANAGER,
        body: {
          kind: "csv",
          rows: [],
        },
      },
    );

    assert.equal(
      refused.status,
      403,
    );
  });

  test("a legacy browser export stages rows and drops forbidden fields", async () => {
    const staged = await api(
      "POST",
      "/api/elections/import",
      {
        as: ADMIN,
        body: {
          kind: "legacy_local",
          fileName: "avku-elections-details-v1.json",
          document: {
            key: "avku-elections-details-v1",
            entries: {
              "way/1001": {
                entrances: 4,
                apartments: 128,
                canvassStatus: "done",
                priority: "high",
                accessNote: "Домофон 45В",
                surveyedAt: "2026-05-12",
                notes: "Просили полагодити освітлення",
                updatedBy: "Іван",
                residents: [
                  {
                    id: "r1",
                    name: "Коваленко Олена",
                    apartment: "12",
                    // The two fields this rebuild removes. They must not reach
                    // any working table, and must not appear in the report.
                    stance: "against",
                    ageGroup: "56-70",
                    note: "",
                  },
                ],
                contacts: [
                  {
                    id: "c1",
                    type: "phone",
                    value: "067 111 22 33",
                    label: "голова ОСББ",
                  },
                ],
              },
              "way/999999": {
                entrances: 2,
                canvassStatus: "planned",
                contacts: [],
                residents: [],
              },
            },
          },
        },
      },
    );

    assert.equal(
      staged.status,
      201,
      staged.text,
    );
    batchId = staged.json.batch.id;

    const rows = staged.json.rows;

    assert.equal(
      rows.length,
      2,
    );

    const matched = rows.find((row: any) => row.matchHouseId === houseId);

    assert.ok(
      matched,
      "the OSM key must match the house it was recorded against",
    );
    assert.equal(
      matched.decision,
      "merge",
    );
    assert.equal(
      matched.matchConfidence,
      "osm",
    );

    const unmatched = rows.find((row: any) => row.matchHouseId === null);

    assert.equal(
      unmatched.status,
      "needs_review",
      "a house that is not in the database must never be dropped silently",
    );

    // The raw row is preserved verbatim, but the political fields were on the
    // resident record and are not carried into the normalised preview.
    assert.equal(
      JSON.stringify(rows).includes("against"),
      false,
    );
    assert.equal(
      JSON.stringify(rows).includes("56-70"),
      false,
    );
  });

  test("applying the batch writes the working records", async () => {
    const applied = await api(
      "POST",
      `/api/elections/import/${batchId}/apply`,
      {
        as: ADMIN,
      },
    );

    assert.equal(
      applied.status,
      200,
      applied.text,
    );
    assert.equal(
      applied.json.report.merged,
      1,
    );
    assert.equal(
      applied.json.report.needsReview,
      1,
    );
    assert.equal(
      applied.json.report.unmatchedAddresses.length,
      1,
    );

    const house = await api(
      "GET",
      `/api/elections/houses/${houseId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      house.json.entrances,
      4,
    );
    assert.equal(
      house.json.accessNote,
      "Домофон 45В",
    );

    const people = await api(
      "GET",
      `/api/elections/houses/${houseId}/people`,
      {
        as: MANAGER,
      },
    );

    assert.ok(
      people.json.some((person: any) => person.role === "osbb_head"),
    );
    assert.equal(
      JSON.stringify(people.json).includes("stance"),
      false,
    );
  });

  test("a duplicate import does not silently create duplicates", async () => {
    const again = await api(
      "POST",
      "/api/elections/import",
      {
        as: ADMIN,
        body: {
          kind: "legacy_local",
          document: {
            entries: {
              "way/1001": {
                entrances: 4,
                contacts: [
                  {
                    id: "c1",
                    type: "phone",
                    value: "067 111 22 33",
                    label: "голова ОСББ",
                  },
                ],
                residents: [],
              },
            },
          },
        },
      },
    );

    assert.equal(
      again.status,
      201,
    );
    assert.equal(
      again.json.rows[0].decision,
      "merge",
      "an existing house must be proposed as a merge, not created again",
    );
    assert.equal(
      again.json.rows[0].matchHouseId,
      houseId,
    );
  });

  test("the batch rolls back completely by id", async () => {
    const rolledBack = await api(
      "POST",
      `/api/elections/import/${batchId}/rollback`,
      {
        as: ADMIN,
      },
    );

    assert.equal(
      rolledBack.status,
      200,
      rolledBack.text,
    );
    assert.equal(
      rolledBack.json.batch.status,
      "rolled_back",
    );

    const house = await api(
      "GET",
      `/api/elections/houses/${houseId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      house.json.accessNote,
      "",
      "the pre-import value must be restored",
    );

    const people = await api(
      "GET",
      `/api/elections/houses/${houseId}/people`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      people.json.some((person: any) => person.source.startsWith("import:")),
      false,
      "records the batch created must be gone",
    );
  });
});

describe("merging duplicates", () => {
  test("a merge keeps the loser's records and needs confirmation", async () => {
    const listed = await api(
      "GET",
      "/api/elections/houses",
      {
        as: MANAGER,
      },
    );
    const [keep, merge] = listed.json.houses;

    const unconfirmed = await api(
      "POST",
      "/api/elections/merge",
      {
        as: MANAGER,
        body: {
          keepId: keep.id,
          mergeId: merge.id,
        },
      },
    );

    assert.equal(
      unconfirmed.status,
      400,
    );

    await api(
      "POST",
      "/api/elections/actions",
      {
        as: MANAGER,
        body: {
          houseId: merge.id,
          type: "call",
          result: "contacted",
        },
      },
    );

    const merged = await api(
      "POST",
      "/api/elections/merge",
      {
        as: MANAGER,
        body: {
          keepId: keep.id,
          mergeId: merge.id,
          confirm: true,
        },
      },
    );

    assert.equal(
      merged.status,
      200,
      merged.text,
    );

    const actions = await api(
      "GET",
      `/api/elections/houses/${keep.id}/actions`,
      {
        as: MANAGER,
      },
    );

    assert.ok(
      actions.json.some((action: any) => action.type === "call"),
      "the merged house's actions must move rather than disappear",
    );

    const gone = await api(
      "GET",
      `/api/elections/houses/${merge.id}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      gone.status,
      404,
    );
  });
});
