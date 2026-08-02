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
import { migrateElectionsDatabase } from "../modules/elections/elections-schema";
import { normalizeAddress } from "../modules/elections/elections.types";
import type { AccessAuthenticator } from "../http/access-auth";

/**
 * Regression tests for the holes the technical review of the "Вибори" module
 * found. Each `test` below reproduces one defect that was confirmed against the
 * running API before it was fixed:
 *
 *  • an unassigned coordinator was handed the whole campaign, and with it every
 *    contact in it;
 *  • `/actions`, `/tasks`, `/issues`, `/events`, `/assignments`, `/materials`,
 *    `/precincts` and `/campaigns` answered *anybody*, including a request with
 *    no identity at all, with the campaign's full contents;
 *  • those same lists ignored territory, so an agitator assigned to one house
 *    read every visit comment, task and issue in the district;
 *  • a record could be edited and deleted "from" a different campaign by
 *    passing its id with another `?campaignId=`, an archived one included;
 *  • an archived campaign kept accepting new work;
 *  • an attachment not tied to a house was downloadable by any role-holder, and
 *    was served inline without `nosniff`;
 *  • a coordinator could assign themselves to any house and so grant themselves
 *    the campaign one row at a time;
 *  • rolling an import back overwrote values users had corrected since.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

const ADMIN = "h-admin@avku.test";
const MANAGER = "h-manager@avku.test";
const COORDINATOR = "h-coordinator@avku.test";
const LOOSE_COORDINATOR = "h-loose-coordinator@avku.test";
const AGITATOR = "h-agitator@avku.test";
const NO_ROLE = "h-norole@avku.test";

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

function building(
  osmId: number,
  number: string,
  lat: number,
): Record<string, unknown> {
  return {
    id: `way/${osmId}`,
    osmType: "way",
    osmId,
    street: "вулиця Зодчих",
    streetShort: "вул. Зодчих",
    number,
    address: `вул. Зодчих, ${number}`,
    fullAddress: `вулиця Зодчих, ${number}, Київ`,
    name: null,
    type: "apartments",
    building: "apartments",
    floors: 9,
    builtYear: 1978,
    footprintAreaSqm: 1200,
    location: {
      lat,
      lon: 30.364,
    },
    footprint: [
      {
        lat,
        lon: 30.364,
      },
      {
        lat: lat + 0.0001,
        lon: 30.3641,
      },
      {
        lat: lat + 0.0002,
        lon: 30.3642,
      },
    ],
  };
}

/** Two buildings: one the agitator is assigned to, one they are not. */
const SNAPSHOT = {
  osmTimestamp: "2026-07-02T16:51:45Z",
  houses: [
    building(
      9001,
      "58-А",
      50.4307,
    ),
    building(
      9002,
      "60",
      50.4317,
    ),
  ],
};

let campaignId = "";
let otherCampaignId = "";
let ownHouseId = "";
let foreignHouseId = "";

before(async () => {
  dataRoot = await mkdtemp(path.join(
    tmpdir(),
    "avku-elections-hardening-",
  ));
  process.env.DATA_ROOT = dataRoot;
  process.env.ELECTIONS_ADMIN_EMAILS = ADMIN;
  delete process.env.ELECTIONS_DEV_AUTH;
  delete process.env.ELECTIONS_DEV_ROLE;
  delete process.env.ELECTIONS_LOCAL_EMAIL;

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

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const repository = createElectionsRepository();

  await repository.withTransaction((database) =>
    importOsmSnapshot(
      database,
      SNAPSHOT as never,
      {
        actor: "test",
        origin: "script",
      },
    ));

  for (
    const [email, role] of [
      [
        MANAGER,
        "manager",
      ],
      [
        COORDINATOR,
        "coordinator",
      ],
      [
        LOOSE_COORDINATOR,
        "coordinator",
      ],
      [
        AGITATOR,
        "agitator",
      ],
    ]
  ) {
    await api(
      "GET",
      "/api/me",
      {
        as: email,
      },
    );
    await api(
      "PUT",
      `/api/elections/roles/${encodeURIComponent(email)}`,
      {
        as: ADMIN,
        body: {
          role,
        },
      },
    );
  }

  // An identified employee who was never granted a role at all.
  await api(
    "GET",
    "/api/me",
    {
      as: NO_ROLE,
    },
  );

  campaignId = (await api(
    "POST",
    "/api/elections/campaigns",
    {
      as: ADMIN,
      body: {
        name: "Основна кампанія",
        status: "active",
      },
    },
  )).json.id;

  otherCampaignId = (await api(
    "POST",
    "/api/elections/campaigns",
    {
      as: ADMIN,
      body: {
        name: "Друга кампанія",
        status: "active",
      },
    },
  )).json.id;

  const houses = (await api(
    "GET",
    `/api/elections/houses?campaignId=${campaignId}`,
    {
      as: MANAGER,
    },
  )).json.houses;

  ownHouseId = houses[0].id;
  foreignHouseId = houses[1].id;

  for (const email of [
    AGITATOR,
    COORDINATOR,
  ]) {
    await api(
      "POST",
      `/api/elections/assignments?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          scope: "house",
          scopeId: ownHouseId,
          employeeEmail: email,
        },
      },
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

describe("territory is granted, never assumed", () => {
  test("a coordinator with no assignment sees no houses at all", async () => {
    // This used to return the whole campaign: `houseVisibilitySql` fell back to
    // "everything" when a coordinator had no assignment, so the widest possible
    // access was produced by forgetting to grant any.
    const listed = await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: LOOSE_COORDINATOR,
      },
    );

    assert.equal(
      listed.status,
      200,
    );
    assert.deepEqual(
      listed.json.houses,
      [],
    );
  });

  test("an assigned coordinator sees exactly their territory", async () => {
    const listed = await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      listed.json.houses.length,
      1,
    );
    assert.equal(
      listed.json.houses[0].id,
      ownHouseId,
    );
  });

  test("a coordinator cannot assign outside their own territory", async () => {
    // Otherwise the territorial limit is decorative: a coordinator could add
    // themselves to every other house one row at a time.
    const refused = await api(
      "POST",
      `/api/elections/assignments?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          scope: "house",
          scopeId: foreignHouseId,
          employeeEmail: COORDINATOR,
        },
      },
    );

    assert.equal(
      refused.status,
      403,
      refused.text,
    );

    const still = await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      still.json.houses.length,
      1,
    );
  });
});

describe("the work log is not public", () => {
  before(async () => {
    // Recorded against the house the agitator is *not* assigned to.
    await api(
      "POST",
      `/api/elections/actions?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: foreignHouseId,
          type: "visit",
          result: "contacted",
          comment: "СЕКРЕТНИЙ-КОМЕНТАР",
        },
      },
    );
    await api(
      "POST",
      `/api/elections/tasks?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: foreignHouseId,
          title: "СЕКРЕТНА-ЗАДАЧА",
        },
      },
    );
    await api(
      "POST",
      `/api/elections/issues?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: foreignHouseId,
          category: "social",
          title: "СЕКРЕТНЕ-ЗВЕРНЕННЯ",
          description: "родина потребує допомоги",
        },
      },
    );
  });

  for (
    const collection of [
      "actions",
      "tasks",
      "issues",
      "events",
      "assignments",
      "materials",
      "precincts",
      "campaigns",
    ]
  ) {
    test(`GET /${collection} refuses a request with no identity`, async () => {
      const anonymous = await api(
        "GET",
        `/api/elections/${collection}?campaignId=${campaignId}`,
      );

      assert.equal(
        anonymous.status,
        401,
        `${collection} answered an anonymous caller: ${anonymous.text}`,
      );
    });

    test(`GET /${collection} refuses an employee with no role`, async () => {
      const roleless = await api(
        "GET",
        `/api/elections/${collection}?campaignId=${campaignId}`,
        {
          as: NO_ROLE,
        },
      );

      assert.equal(
        roleless.status,
        401,
        `${collection} answered a roleless employee: ${roleless.text}`,
      );
    });
  }

  test("an agitator's action list holds only their own houses", async () => {
    const listed = await api(
      "GET",
      `/api/elections/actions?campaignId=${campaignId}`,
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      listed.status,
      200,
    );
    assert.equal(
      listed.text.includes("СЕКРЕТНИЙ-КОМЕНТАР"),
      false,
      "a visit comment for somebody else's building must never be returned",
    );

    for (const action of listed.json) {
      assert.notEqual(
        action.houseId,
        foreignHouseId,
      );
    }
  });

  test("an agitator's task list holds only their own houses", async () => {
    const listed = await api(
      "GET",
      `/api/elections/tasks?campaignId=${campaignId}`,
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      listed.text.includes("СЕКРЕТНА-ЗАДАЧА"),
      false,
    );
  });

  test("an agitator's issue list holds only their own houses", async () => {
    const listed = await api(
      "GET",
      `/api/elections/issues?campaignId=${campaignId}`,
      {
        as: AGITATOR,
      },
    );

    assert.equal(
      listed.text.includes("СЕКРЕТНЕ-ЗВЕРНЕННЯ"),
      false,
    );
    assert.equal(
      listed.text.includes("родина потребує допомоги"),
      false,
    );
  });

  test("a manager still sees the whole campaign", async () => {
    const listed = await api(
      "GET",
      `/api/elections/actions?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      listed.text.includes("СЕКРЕТНИЙ-КОМЕНТАР"),
      true,
    );
  });

  test("an agitator cannot edit a task on a house they cannot see", async () => {
    const tasks = await api(
      "GET",
      `/api/elections/tasks?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );
    const target = tasks.json.find((task: any) =>
      task.title === "СЕКРЕТНА-ЗАДАЧА");

    const refused = await api(
      "PATCH",
      `/api/elections/tasks/${target.id}?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          status: "done",
        },
      },
    );

    assert.equal(
      refused.status,
      404,
      refused.text,
    );
  });
});

describe("a record belongs to exactly one campaign", () => {
  let taskId = "";
  let actionId = "";

  before(async () => {
    taskId = (await api(
      "POST",
      `/api/elections/tasks?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: ownHouseId,
          title: "Задача першої кампанії",
        },
      },
    )).json.id;

    actionId = (await api(
      "POST",
      `/api/elections/actions?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: ownHouseId,
          type: "call",
          result: "contacted",
        },
      },
    )).json.id;
  });

  test("a task cannot be edited from another campaign", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/tasks/${taskId}?campaignId=${otherCampaignId}`,
      {
        as: MANAGER,
        body: {
          title: "Змінено з чужої кампанії",
        },
      },
    );

    assert.equal(
      refused.status,
      404,
      refused.text,
    );

    const tasks = await api(
      "GET",
      `/api/elections/tasks?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      tasks.json.find((task: any) => task.id === taskId).title,
      "Задача першої кампанії",
    );
  });

  test("a task cannot be deleted from another campaign", async () => {
    const refused = await api(
      "DELETE",
      `/api/elections/tasks/${taskId}?campaignId=${otherCampaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      refused.status,
      404,
      refused.text,
    );
  });

  test("an action cannot be deleted from another campaign", async () => {
    const refused = await api(
      "DELETE",
      `/api/elections/actions/${actionId}?campaignId=${otherCampaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      refused.status,
      404,
      refused.text,
    );
  });

  test("the record is still editable from its own campaign", async () => {
    const allowed = await api(
      "PATCH",
      `/api/elections/tasks/${taskId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          status: "done",
        },
      },
    );

    assert.equal(
      allowed.status,
      200,
      allowed.text,
    );
  });
});

describe("an archived campaign is read-only", () => {
  let archivedId = "";

  before(async () => {
    archivedId = (await api(
      "POST",
      "/api/elections/campaigns",
      {
        as: ADMIN,
        body: {
          name: "Кампанія 2020",
          status: "active",
        },
      },
    )).json.id;

    await api(
      "POST",
      `/api/elections/actions?campaignId=${archivedId}`,
      {
        as: MANAGER,
        body: {
          houseId: ownHouseId,
          type: "visit",
          result: "contacted",
          comment: "Історичний запис",
        },
      },
    );

    await api(
      "POST",
      `/api/elections/campaigns/${archivedId}/archive`,
      {
        as: MANAGER,
        body: {},
      },
    );
  });

  test("a new action is refused", async () => {
    const refused = await api(
      "POST",
      `/api/elections/actions?campaignId=${archivedId}`,
      {
        as: MANAGER,
        body: {
          houseId: ownHouseId,
          type: "visit",
          result: "contacted",
        },
      },
    );

    assert.equal(
      refused.status,
      409,
      refused.text,
    );
  });

  test("the house state cannot be changed", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/houses/${ownHouseId}/state?campaignId=${archivedId}`,
      {
        as: MANAGER,
        body: {
          stage: "done",
        },
      },
    );

    assert.equal(
      refused.status,
      409,
      refused.text,
    );
  });

  test("its history is still readable", async () => {
    const listed = await api(
      "GET",
      `/api/elections/actions?campaignId=${archivedId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      listed.status,
      200,
    );
    assert.equal(
      listed.text.includes("Історичний запис"),
      true,
    );
  });

  test("the active campaign is unaffected", async () => {
    const allowed = await api(
      "POST",
      `/api/elections/actions?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: ownHouseId,
          type: "visit",
          result: "contacted",
        },
      },
    );

    assert.equal(
      allowed.status,
      201,
      allowed.text,
    );
  });
});

describe("attachments", () => {
  async function upload(
    as: string,
    fields: Record<string, string>,
    content: string,
  ): Promise<ApiResponse> {
    const boundary = "----avkuhardening";
    const parts = Object.entries(fields).flatMap(([name, value]) => [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${name}"`,
      "",
      value,
    ]);
    const body = [
      ...parts,
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      "Content-Type: text/plain",
      "",
      content,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await fetch(
      `${baseUrl}/api/elections/attachments?campaignId=${campaignId}`,
      {
        method: "POST",
        headers: {
          "x-test-user": as,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
    );
    const text = await response.text();

    return {
      status: response.status,
      text,
      json: text.startsWith("{") ? JSON.parse(text) : undefined,
    };
  }

  test("one with no house is not readable by an unrelated role-holder", async () => {
    // There is no house to govern access, so it used to be readable by anybody
    // holding the agitator role — the whole field team.
    const uploaded = await upload(
      MANAGER,
      {
        ownerType: "action",
        ownerId: "some-action",
      },
      "ТАЄМНИЙ-ВМІСТ",
    );

    assert.equal(
      uploaded.status,
      201,
      uploaded.text,
    );

    const response = await fetch(
      `${baseUrl}/api/elections/attachments/${uploaded.json.id}/file`,
      {
        headers: {
          "x-test-user": AGITATOR,
        },
      },
    );

    assert.equal(
      response.status,
      404,
    );
    assert.equal(
      (await response.text()).includes("ТАЄМНИЙ-ВМІСТ"),
      false,
    );
  });

  test("the uploader can still read their own", async () => {
    const uploaded = await upload(
      AGITATOR,
      {
        ownerType: "action",
        ownerId: "own-action",
      },
      "ВЛАСНИЙ-ВМІСТ",
    );

    const response = await fetch(
      `${baseUrl}/api/elections/attachments/${uploaded.json.id}/file`,
      {
        headers: {
          "x-test-user": AGITATOR,
        },
      },
    );

    assert.equal(
      response.status,
      200,
    );
    assert.equal(
      (await response.text()).includes("ВЛАСНИЙ-ВМІСТ"),
      true,
    );
  });

  test("a non-image downloads and is never content-sniffed", async () => {
    const uploaded = await upload(
      MANAGER,
      {
        ownerType: "house",
        ownerId: ownHouseId,
        houseId: ownHouseId,
      },
      "звичайний текст",
    );

    const response = await fetch(
      `${baseUrl}/api/elections/attachments/${uploaded.json.id}/file`,
      {
        headers: {
          "x-test-user": MANAGER,
        },
      },
    );

    assert.equal(
      response.status,
      200,
    );
    assert.equal(
      response.headers.get("x-content-type-options"),
      "nosniff",
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment;/,
    );
  });

  test("an agitator reads one attached to their own house", async () => {
    const uploaded = await upload(
      MANAGER,
      {
        ownerType: "house",
        ownerId: ownHouseId,
        houseId: ownHouseId,
      },
      "фото підʼїзду",
    );

    const response = await fetch(
      `${baseUrl}/api/elections/attachments/${uploaded.json.id}/file?campaignId=${campaignId}`,
      {
        headers: {
          "x-test-user": AGITATOR,
        },
      },
    );

    assert.equal(
      response.status,
      200,
    );
  });
});

describe("rolling an import back", () => {
  test("a value the user corrected afterwards survives", async () => {
    // The rollback used to restore the pre-import image unconditionally, so
    // undoing a spreadsheet import also undid every hand correction made since.
    const batch = await api(
      "POST",
      `/api/elections/import?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          kind: "csv",
          fileName: "будинки.csv",
          rows: [
            {
              "Адреса": "вул. Зодчих, 58-А",
              "Підʼїзди": "4",
            },
          ],
        },
      },
    );

    assert.equal(
      batch.status,
      201,
      batch.text,
    );

    const row = batch.json.rows[0];

    // The abbreviated street now matches the snapshot's full form outright.
    assert.equal(
      row.matchHouseId,
      ownHouseId,
      "an abbreviated street must match the house the snapshot created",
    );

    const batchId = batch.json.batch.id;

    await api(
      "POST",
      `/api/elections/import/${batchId}/apply?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          confirm: true,
        },
      },
    );

    const imported = await api(
      "GET",
      `/api/elections/houses/${ownHouseId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      imported.json.entrances,
      4,
    );

    // A user corrects it in the field.
    await api(
      "PATCH",
      `/api/elections/houses/${ownHouseId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          entrances: 9,
        },
      },
    );

    const rolled = await api(
      "POST",
      `/api/elections/import/${batchId}/rollback?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          confirm: true,
        },
      },
    );

    assert.equal(
      rolled.status,
      200,
      rolled.text,
    );
    assert.deepEqual(
      rolled.json.keptUserEdits,
      ["house.entrances"],
      "the rollback must report what it deliberately left alone",
    );

    const after = await api(
      "GET",
      `/api/elections/houses/${ownHouseId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      after.json.entrances,
      9,
      "the correction made after the import must survive its rollback",
    );
  });

  test("an untouched value is still rolled back", async () => {
    const batch = await api(
      "POST",
      `/api/elections/import?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          kind: "csv",
          fileName: "доступ.csv",
          rows: [
            {
              "Адреса": "вул. Зодчих, 60",
              "Домофон": "код 45В",
            },
          ],
        },
      },
    );
    const batchId = batch.json.batch.id;

    await api(
      "POST",
      `/api/elections/import/${batchId}/apply?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          confirm: true,
        },
      },
    );

    const imported = await api(
      "GET",
      `/api/elections/houses/${foreignHouseId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      imported.json.accessNote,
      "код 45В",
    );

    const rolled = await api(
      "POST",
      `/api/elections/import/${batchId}/rollback?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          confirm: true,
        },
      },
    );

    assert.deepEqual(
      rolled.json.keptUserEdits,
      [],
    );

    const after = await api(
      "GET",
      `/api/elections/houses/${foreignHouseId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      after.json.accessNote,
      "",
      "nothing touched it since, so the import's value is undone",
    );
  });

  test("a cell naming several houses is never merged into one", async () => {
    const batch = await api(
      "POST",
      `/api/elections/import?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          kind: "csv",
          fileName: "домові.csv",
          rows: [
            {
              "Вулиця": "вул. Зодчих",
              "Будинок": "58-А, 60",
              "Телефон": "0671112233",
              "ПІБ": "Тестенко Тест",
            },
          ],
        },
      },
    );

    const row = batch.json.rows[0];

    assert.equal(
      row.status,
      "needs_review",
      row.text ?? JSON.stringify(row),
    );
    assert.equal(
      row.matchHouseId,
      null,
      "a row naming two buildings must not be attached to either of them",
    );
    assert.equal(
      row.notes.some((note: string) => note.includes("кілька будинків")),
      true,
      `the reviewer must be told why: ${JSON.stringify(row.notes)}`,
    );
  });
});

describe("schema migration", () => {
  test("running it again on a live database changes nothing", async () => {
    const repository = createElectionsRepository();
    const database = await repository.getDatabase();

    const before = database.prepare(
      "SELECT COUNT(*) AS n FROM houses",
    ).get() as Record<string, unknown>;

    // Twice, exactly as an API restart would.
    migrateElectionsDatabase(database);
    migrateElectionsDatabase(database);

    const after = database.prepare(
      "SELECT COUNT(*) AS n FROM houses",
    ).get() as Record<string, unknown>;

    assert.equal(
      Number(after.n),
      Number(before.n),
    );
    assert.equal(
      Number(
        (database.prepare("PRAGMA user_version").get() as Record<
          string,
          unknown
        >).user_version,
      ),
      2,
    );
    assert.equal(
      database.prepare("PRAGMA foreign_key_check").all().length,
      0,
      "no foreign key may be left dangling",
    );
    assert.equal(
      Number(
        (database.prepare("PRAGMA foreign_keys").get() as Record<
          string,
          unknown
        >).foreign_keys,
      ),
      1,
      "foreign key enforcement must be on after a migration",
    );
  });

  test("every stored address key matches the shared rule", async () => {
    // The first version of the v2 step recomputed these keys in SQL, and
    // SQLite's `LOWER()` is ASCII-only without ICU — so every Cyrillic street
    // kept its capital letter and all 5 896 rows ended up with a key that
    // matched nothing. The rule has exactly one implementation; this asserts
    // the database agrees with it.
    const repository = createElectionsRepository();
    const database = await repository.getDatabase();
    const rows = database.prepare(`
      SELECT street, number, address_normalized FROM houses
      WHERE deleted_at IS NULL
    `).all() as Record<string, unknown>[];

    assert.ok(rows.length > 0);

    for (const row of rows) {
      assert.equal(
        String(row.address_normalized),
        normalizeAddress(
          row.street,
          row.number,
        ),
        `stored key for ${String(row.street)} ${String(row.number)}`,
      );
    }
  });
});
