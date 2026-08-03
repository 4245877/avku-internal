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
 * Territory and campaign scoping for the writes that reach a building
 * *indirectly*.
 *
 * The house endpoints resolve their target through `getHouse`, which applies
 * the visibility clause, so they were already safe. The endpoints here take the
 * id of something attached to a house — a resident, a resident's link, a
 * precinct link, an attachment — and used to act on it without ever asking
 * which building it belonged to. Every test below was confirmed to fail against
 * the API as it stood:
 *
 *  • `PATCH /people/:id` renamed a resident of any building in the district;
 *  • `POST /people/:id/links` filed a resident into any building;
 *  • `DELETE /person-links/:id` unpicked any resident from any building;
 *  • `POST /houses/:id/precincts` attached any building to a precinct the
 *    caller held — which is how `houseVisibilitySql` decides what they may see,
 *    so it granted them the building and its residents' phone numbers;
 *  • `DELETE /house-precincts/:id` cut any building out of any precinct;
 *  • `DELETE /attachments/:id` destroyed a photo the caller could not read;
 *  • none of the above, nor `POST /merge/*`, refused an archived campaign;
 *  • `GET /history` handed any coordinator the whole database's change log.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

const ADMIN = "t-admin@avku.test";
const MANAGER = "t-manager@avku.test";
const COORDINATOR = "t-coordinator@avku.test";
const AGITATOR = "t-agitator@avku.test";
const NO_ROLE = "t-norole@avku.test";

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
    street: "вулиця Межова",
    streetShort: "вул. Межова",
    number,
    address: `вул. Межова, ${number}`,
    fullAddress: `вулиця Межова, ${number}, Київ`,
    name: null,
    type: "apartments",
    building: "apartments",
    floors: 5,
    builtYear: 1980,
    footprintAreaSqm: 900,
    location: {
      lat,
      lon: 30.401,
    },
    footprint: [
      {
        lat,
        lon: 30.401,
      },
      {
        lat: lat + 0.0001,
        lon: 30.4011,
      },
      {
        lat: lat + 0.0002,
        lon: 30.4012,
      },
    ],
  };
}

const SNAPSHOT = {
  osmTimestamp: "2026-07-02T16:51:45Z",
  houses: [
    building(
      7101,
      "1",
      50.441,
    ),
    building(
      7102,
      "2",
      50.442,
    ),
    building(
      7103,
      "3",
      50.443,
    ),
  ],
};

let campaignId = "";
let archivedCampaignId = "";
let heldPrecinctId = "";
let loosePrecinctId = "";
/** Two buildings the coordinator holds through `heldPrecinctId`. */
let heldHouseId = "";
let heldHouseTwoId = "";
/** A building nobody in this test is assigned to. */
let farHouseId = "";
let insidePersonId = "";
let outsidePersonId = "";
let outsideLinkId = "";
let farAttachmentId = "";
let farPrecinctLinkId = "";

before(async () => {
  dataRoot = await mkdtemp(path.join(
    tmpdir(),
    "avku-elections-territory-",
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

  // An identified employee nobody granted anything to.
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
        name: "Кампанія території",
        status: "active",
      },
    },
  )).json.id;

  archivedCampaignId = (await api(
    "POST",
    "/api/elections/campaigns",
    {
      as: ADMIN,
      body: {
        name: "Закрита кампанія",
        status: "active",
      },
    },
  )).json.id;

  // The map list is compact — a street *index* and a number, no address — so
  // the three fixture buildings are told apart by their house number.
  const houses = (await api(
    "GET",
    `/api/elections/houses?campaignId=${campaignId}`,
    {
      as: ADMIN,
    },
  )).json.houses as { id: string; number: string }[];

  const ordered = [...houses].sort((left, right) =>
    left.number.localeCompare(right.number));

  heldHouseId = ordered[0].id;
  heldHouseTwoId = ordered[1].id;
  farHouseId = ordered[2].id;

  heldPrecinctId = (await api(
    "POST",
    `/api/elections/precincts?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        number: "7101",
        district: "Тест",
      },
    },
  )).json.id;

  loosePrecinctId = (await api(
    "POST",
    `/api/elections/precincts?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        number: "7102",
        district: "Тест",
      },
    },
  )).json.id;

  for (const houseId of [
    heldHouseId,
    heldHouseTwoId,
  ]) {
    await api(
      "POST",
      `/api/elections/houses/${houseId}/precincts?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          precinctId: heldPrecinctId,
        },
      },
    );
  }

  // The coordinator holds a precinct; the agitator holds a single house.
  await api(
    "POST",
    `/api/elections/assignments?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        scope: "precinct",
        scopeId: heldPrecinctId,
        employeeEmail: COORDINATOR,
        role: "coordinator",
      },
    },
  );
  await api(
    "POST",
    `/api/elections/assignments?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        scope: "house",
        scopeId: heldHouseId,
        employeeEmail: AGITATOR,
        role: "agitator",
      },
    },
  );

  insidePersonId = (await api(
    "POST",
    `/api/elections/houses/${heldHouseId}/people?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        fullName: "Мешканець Своєї Території",
        role: "building_elder",
        contacts: [
          {
            type: "phone",
            value: "+380671110001",
          },
        ],
      },
    },
  )).json.id;

  outsidePersonId = (await api(
    "POST",
    `/api/elections/houses/${farHouseId}/people?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        fullName: "Мешканець Чужої Території",
        role: "building_elder",
        contacts: [
          {
            type: "phone",
            value: "+380671110002",
          },
        ],
      },
    },
  )).json.id;

  outsideLinkId = ((await api(
    "GET",
    `/api/elections/houses/${farHouseId}/people?campaignId=${campaignId}`,
    {
      as: ADMIN,
    },
  )).json as { linkId: string }[])[0].linkId;

  farPrecinctLinkId = (await api(
    "POST",
    `/api/elections/houses/${farHouseId}/precincts?campaignId=${campaignId}`,
    {
      as: ADMIN,
      body: {
        precinctId: loosePrecinctId,
      },
    },
  )).json.id;

  const form = new FormData();

  form.append(
    "ownerType",
    "house",
  );
  form.append(
    "ownerId",
    farHouseId,
  );
  form.append(
    "houseId",
    farHouseId,
  );
  form.append(
    "fileName",
    "far.txt",
  );
  form.append(
    "file",
    new Blob(
      ["чужа світлина"],
      {
        type: "text/plain",
      },
    ),
    "far.txt",
  );

  farAttachmentId = ((await (await fetch(
    `${baseUrl}/api/elections/attachments?campaignId=${campaignId}`,
    {
      method: "POST",
      headers: {
        "x-test-user": ADMIN,
      },
      body: form,
    },
  )).json()) as { id: string }).id;

  await api(
    "POST",
    `/api/elections/campaigns/${archivedCampaignId}/archive`,
    {
      as: ADMIN,
    },
  );
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
});

describe("territory scoping for indirect writes", () => {
  test("a coordinator cannot rename a resident of a building they do not hold", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/people/${outsidePersonId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          fullName: "Перейменовано Чужим",
        },
      },
    );

    assert.equal(
      refused.status,
      404,
      `updatePerson reached another territory: ${refused.text}`,
    );

    // The name is checked through an account that may read it, so the test
    // fails on a write that happened despite the status code.
    const people = (await api(
      "GET",
      `/api/elections/houses/${farHouseId}/people?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    )).json as { fullName: string }[];

    assert.equal(
      people[0].fullName,
      "Мешканець Чужої Території",
      "the resident was renamed even though the request was refused",
    );
  });

  test("a coordinator can still rename a resident inside their own territory", async () => {
    const allowed = await api(
      "PATCH",
      `/api/elections/people/${insidePersonId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          fullName: "Мешканець Оновлений",
        },
      },
    );

    assert.equal(
      allowed.status,
      200,
      `the scoping check blocked legitimate work: ${allowed.text}`,
    );

    const people = (await api(
      "GET",
      `/api/elections/houses/${heldHouseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json as { fullName: string }[];

    assert.equal(
      people[0].fullName,
      "Мешканець Оновлений",
      "the allowed rename did not reach the database",
    );
  });

  test("a coordinator cannot file a resident into a building they do not hold", async () => {
    const refused = await api(
      "POST",
      `/api/elections/people/${insidePersonId}/links?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          houseId: farHouseId,
        },
      },
    );

    assert.equal(
      refused.status,
      404,
      `linkPersonToHouse reached another territory: ${refused.text}`,
    );

    const people = (await api(
      "GET",
      `/api/elections/houses/${farHouseId}/people?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    )).json as unknown[];

    assert.equal(
      people.length,
      1,
      "a resident was filed into a building outside the caller's territory",
    );
  });

  test("a coordinator cannot pull a stranger's record into their own building", async () => {
    const refused = await api(
      "POST",
      `/api/elections/people/${outsidePersonId}/links?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          houseId: heldHouseTwoId,
        },
      },
    );

    assert.equal(
      refused.status,
      404,
      `a person outside the territory was linked in: ${refused.text}`,
    );

    const people = (await api(
      "GET",
      `/api/elections/houses/${heldHouseTwoId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json as unknown[];

    assert.equal(
      people.length,
      0,
      "the stranger's phone number is now readable from the caller's own house",
    );
  });

  test("a coordinator cannot unpick a resident from a building they do not hold", async () => {
    const refused = await api(
      "DELETE",
      `/api/elections/person-links/${outsideLinkId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      refused.status,
      404,
      `deletePersonLink reached another territory: ${refused.text}`,
    );

    const people = (await api(
      "GET",
      `/api/elections/houses/${farHouseId}/people?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    )).json as unknown[];

    assert.equal(
      people.length,
      1,
      "the resident was unpicked even though the request was refused",
    );
  });
});

describe("precinct links cannot be used to widen a territory", () => {
  test("attaching a foreign building to one's own precinct is refused", async () => {
    const before = (await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json.houses as unknown[];

    assert.equal(
      before.length,
      2,
      "fixture: the coordinator should start with exactly their precinct",
    );

    const refused = await api(
      "POST",
      `/api/elections/houses/${farHouseId}/precincts?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          precinctId: heldPrecinctId,
        },
      },
    );

    assert.equal(
      refused.status,
      404,
      `a foreign building was filed under the caller's own precinct: ${refused.text}`,
    );

    // The status code is not the point — the territory is. Before the fix this
    // read three houses, and the third one's contacts came with it.
    const after = (await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json.houses as unknown[];

    assert.equal(
      after.length,
      2,
      "the caller granted themselves a building by writing a precinct link",
    );
  });

  test("a coordinator cannot cut a foreign building out of its precinct", async () => {
    const refused = await api(
      "DELETE",
      `/api/elections/house-precincts/${farPrecinctLinkId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      refused.status,
      404,
      `unlinkHouseFromPrecinct reached another territory: ${refused.text}`,
    );

    const links = (await api(
      "GET",
      `/api/elections/houses/${farHouseId}?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    )).json.precincts as unknown[];

    assert.equal(
      links.length,
      1,
      "the precinct link was deleted even though the request was refused",
    );
  });

  test("a coordinator can still file and unfile their own building", async () => {
    const created = await api(
      "POST",
      `/api/elections/houses/${heldHouseId}/precincts?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          precinctId: loosePrecinctId,
        },
      },
    );

    assert.equal(
      created.status,
      201,
      `the scoping check blocked legitimate work: ${created.text}`,
    );

    const removed = await api(
      "DELETE",
      `/api/elections/house-precincts/${created.json.id}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      removed.status,
      200,
      `the scoping check blocked a legitimate unlink: ${removed.text}`,
    );
  });
});

describe("attachments", () => {
  test("a coordinator cannot delete an attachment they cannot read", async () => {
    const unreadable = await api(
      "GET",
      `/api/elections/attachments/${farAttachmentId}/file?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      unreadable.status,
      404,
      "fixture: the attachment must be unreadable for this caller",
    );

    const refused = await api(
      "DELETE",
      `/api/elections/attachments/${farAttachmentId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      refused.status,
      404,
      `deleteAttachment ignored the read check: ${refused.text}`,
    );

    const stillThere = await api(
      "GET",
      `/api/elections/attachments/${farAttachmentId}/file?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    );

    assert.equal(
      stillThere.status,
      200,
      "the attachment was destroyed even though the request was refused",
    );
  });
});

describe("an archived campaign refuses every write, not most of them", () => {
  test("a resident cannot be edited through an archived campaign", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/people/${insidePersonId}?campaignId=${archivedCampaignId}`,
      {
        as: MANAGER,
        body: {
          fullName: "Змінено В Архіві",
        },
      },
    );

    assert.equal(
      refused.status,
      409,
      `an archived campaign accepted a resident edit: ${refused.text}`,
    );
  });

  test("a resident cannot be linked through an archived campaign", async () => {
    const refused = await api(
      "POST",
      `/api/elections/people/${insidePersonId}/links?campaignId=${archivedCampaignId}`,
      {
        as: MANAGER,
        body: {
          houseId: heldHouseTwoId,
        },
      },
    );

    assert.equal(
      refused.status,
      409,
      `an archived campaign accepted a resident link: ${refused.text}`,
    );
  });

  test("a merge cannot be run through an archived campaign", async () => {
    const refused = await api(
      "POST",
      `/api/elections/merge/houses?campaignId=${archivedCampaignId}`,
      {
        as: MANAGER,
        body: {
          keepId: heldHouseId,
          mergeId: heldHouseTwoId,
          confirm: true,
        },
      },
    );

    assert.equal(
      refused.status,
      409,
      `an archived campaign accepted a merge: ${refused.text}`,
    );

    // A merge is the least reversible write in the module: prove the second
    // building is still there rather than trusting the status code.
    const survivor = await api(
      "GET",
      `/api/elections/houses/${heldHouseTwoId}?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    );

    assert.equal(
      survivor.status,
      200,
      "the merge ran anyway and folded the building away",
    );
  });
});

describe("the change log is not a way around territory", () => {
  test("a coordinator reads their own buildings and their own edits, and nothing else", async () => {
    // Give both buildings a history: one the caller holds, one they do not.
    await api(
      "PATCH",
      `/api/elections/houses/${heldHouseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          accessNote: "код домофону змінено",
        },
      },
    );
    await api(
      "PATCH",
      `/api/elections/houses/${farHouseId}?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          accessNote: "чужий запис",
        },
      },
    );

    const journal = (await api(
      "GET",
      `/api/elections/history?campaignId=${campaignId}&limit=500`,
      {
        as: COORDINATOR,
      },
    )).json as { entityId: string; newValue: string | null }[];

    assert.ok(
      journal.some((entry) => entry.entityId === heldHouseId),
      "the coordinator lost the history of a building they hold",
    );
    assert.equal(
      journal.filter((entry) => entry.entityId === farHouseId).length,
      0,
      "the change log handed over edits to a building outside the territory",
    );
    assert.equal(
      journal.filter((entry) => entry.newValue === "чужий запис").length,
      0,
      "the foreign value itself leaked through the journal",
    );
  });

  test("a manager still reads the journal whole", async () => {
    const journal = (await api(
      "GET",
      `/api/elections/history?campaignId=${campaignId}&limit=500`,
      {
        as: MANAGER,
      },
    )).json as { entityId: string }[];

    assert.ok(
      journal.some((entry) => entry.entityId === farHouseId),
      "the narrowing was applied to a role that is meant to see everything",
    );
  });

  test("the per-house journal still answers for a building the caller holds", async () => {
    const journal = (await api(
      "GET",
      `/api/elections/houses/${heldHouseId}/history?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json as unknown[];

    assert.ok(
      journal.length > 0,
      "the per-house history stopped answering for the caller's own building",
    );
  });
});

describe("an identified employee without a role is forbidden, not unauthenticated", () => {
  test("no identity at all is 401", async () => {
    const anonymous = await api(
      "GET",
      `/api/elections/history?campaignId=${campaignId}`,
      {
        as: null,
      },
    );

    assert.equal(
      anonymous.status,
      401,
      `an anonymous caller must be told to authenticate: ${anonymous.text}`,
    );
  });

  test("an identity with no role is 403", async () => {
    const roleless = await api(
      "GET",
      `/api/elections/history?campaignId=${campaignId}`,
      {
        as: NO_ROLE,
      },
    );

    assert.equal(
      roleless.status,
      403,
      `a signed-in employee was told to sign in again: ${roleless.text}`,
    );
  });
});

describe("forbidden columns never reach storage, not even the staging table", () => {
  /**
   * Confirmed against the running API before the fix: this row was uploaded
   * and `political_position`, `party`, `age_band`, `vote_intent` and `loyalty`
   * all came back in the response, because `import_rows.raw` stored the source
   * row untouched and the matcher only recognised exact column names.
   */
  const POISONED = [
    {
      address: "вул. Межова, 1",
      fullName: "Мешканець Із Профілем",
      phone: "+380671110099",
      political_position: "опозиція",
      party: "Партія Тест",
      age_band: "60+",
      vote_intent: "за",
      loyalty: "висока",
      voteIntent: "проти",
      "Політична позиція": "невідомо",
    },
  ];

  const SECRETS = [
    "опозиція",
    "Партія Тест",
    "60+",
    "висока",
    "проти",
    "невідомо",
  ];

  test("an ordinary import strips them from the staged rows", async () => {
    const staged = await api(
      "POST",
      `/api/elections/import?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          kind: "csv",
          fileName: "poisoned.csv",
          rows: POISONED,
        },
      },
    );

    assert.equal(
      staged.status,
      201,
      staged.text,
    );

    const leaked = SECRETS.filter((secret) => staged.text.includes(secret));

    assert.deepEqual(
      leaked,
      [],
      "the import response handed back forbidden values",
    );

    assert.ok(
      staged.json.batch.cleanedFieldsCount >= 7,
      `every forbidden column must be counted, got ${staged.json.batch.cleanedFieldsCount}`,
    );

    // The row itself survives — this is a strip, not a drop.
    assert.equal(
      staged.json.rows.length,
      1,
      "the row was discarded instead of cleaned",
    );
    assert.ok(
      staged.text.includes("Мешканець Із Профілем"),
      "the legitimate columns were stripped along with the forbidden ones",
    );
  });

  test("re-reading the batch does not surface them either", async () => {
    const staged = await api(
      "POST",
      `/api/elections/import?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          kind: "csv",
          fileName: "poisoned-2.csv",
          rows: POISONED,
        },
      },
    );
    const reread = await api(
      "GET",
      `/api/elections/import/${staged.json.batch.id}?campaignId=${campaignId}`,
      {
        as: ADMIN,
      },
    );

    const leaked = SECRETS.filter((secret) => reread.text.includes(secret));

    assert.deepEqual(
      leaked,
      [],
      "the stored staging row still holds forbidden values",
    );
  });

  test("the column names a real file uses are recognised", async () => {
    // Each of these was accepted by the old exact-name matcher.
    for (
      const column of [
        "political_position",
        "politicalPosition",
        "age_band",
        "ageBand",
        "vote_intent",
        "voteIntent",
        "loyalty",
        "party_membership",
      ]
    ) {
      const staged = await api(
        "POST",
        `/api/elections/import?campaignId=${campaignId}`,
        {
          as: ADMIN,
          body: {
            kind: "csv",
            fileName: `${column}.csv`,
            rows: [
              {
                address: "вул. Межова, 1",
                fullName: "Тест Колонки",
                [column]: "СЕКРЕТ",
              },
            ],
          },
        },
      );

      assert.equal(
        staged.text.includes("СЕКРЕТ"),
        false,
        `column "${column}" was imported instead of being stripped`,
      );
    }
  });

  test("an innocent column that merely contains a forbidden substring survives", async () => {
    // The stem list must not be so broad that ordinary columns disappear:
    // "average", "usage" and "language" all contain "age".
    const staged = await api(
      "POST",
      `/api/elections/import?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          kind: "csv",
          fileName: "innocent.csv",
          rows: [
            {
              address: "вул. Межова, 1",
              fullName: "Тест Невинних Колонок",
              average_floor: "СЕРЕДНЄ",
              language: "українська",
              usage: "житлове",
            },
          ],
        },
      },
    );

    for (const kept of ["СЕРЕДНЄ", "українська", "житлове"]) {
      assert.ok(
        staged.text.includes(kept),
        `an ordinary column carrying "${kept}" was stripped as if it were forbidden`,
      );
    }
  });
});

describe("the visibility clause still selects the same buildings", () => {
  test("a precinct assignment reaches exactly the precinct's buildings", async () => {
    // Guards the rewrite of `houseVisibilitySql` from two correlated EXISTS
    // subqueries into one id set: the shape changed for speed, and this pins
    // the answer it produces. The precinct branch is the half the rewrite
    // touched most, so it is the one asserted here.
    const houses = (await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json.houses as { id: string }[];

    assert.deepEqual(
      houses.map((house) => house.id).sort(),
      [
        heldHouseId,
        heldHouseTwoId,
      ].sort(),
      "the precinct branch of the visibility clause changed which buildings it selects",
    );
  });

  test("a house assignment reaches exactly that building", async () => {
    const houses = (await api(
      "GET",
      `/api/elections/houses?campaignId=${campaignId}`,
      {
        as: AGITATOR,
      },
    )).json.houses as { id: string }[];

    assert.deepEqual(
      houses.map((house) => house.id),
      [heldHouseId],
      "the house branch of the visibility clause changed which buildings it selects",
    );
  });
});
