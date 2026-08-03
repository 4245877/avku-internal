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
 * The server contract the full-screen house editor depends on.
 *
 * The editor is the first screen that writes the *whole* record rather than one
 * field at a time, and that changes what the API has to guarantee. Each case
 * below is one of those guarantees, and every one of them is a way a
 * many-field form silently destroys data when the server does not hold it up:
 *
 *  • the permanent record and the campaign state stay separate, whatever order
 *    the two requests arrive in;
 *  • a save built on a copy somebody else has already replaced is refused, not
 *    merged — otherwise the second person to press «Зберегти» rolls back every
 *    field the first one touched and nobody is told;
 *  • the check date and its author are the server's, never the request's;
 *  • a phone's "checked on" stamp survives an edit to the person's name;
 *  • deleting a *link* and deleting a *person* are different operations with
 *    different permissions;
 *  • an archived campaign and somebody else's territory refuse the editor's
 *    writes exactly as they refuse every other write, so a disabled button is
 *    never the only thing standing between a user and the data.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

const ADMIN = "admin@avku.test";
const MANAGER = "manager@avku.test";
const COORDINATOR = "coordinator@avku.test";
const AGITATOR = "agitator@avku.test";

const testAuthenticator: AccessAuthenticator = {
  enabled: true,
  authenticate: async (request) => {
    const email = request.headers["x-test-user"];

    return typeof email === "string" && email ? { email } : null;
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

function building(osmId: number, number: string, lat: number) {
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

let campaignId = "";
let archivedCampaignId = "";
/** The building the coordinator and the agitator both hold. */
let houseId = "";
/** A building nobody in this test is assigned to. */
let farHouseId = "";

before(async () => {
  dataRoot = await mkdtemp(path.join(
    tmpdir(),
    "avku-elections-editor-",
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
      {
        osmTimestamp: "2026-07-02T16:51:45Z",
        houses: [
          building(
            9001,
            "58",
            50.4307,
          ),
          building(
            9002,
            "60",
            50.4312,
          ),
        ],
      } as never,
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

  campaignId = (await api(
    "POST",
    "/api/elections/campaigns",
    {
      as: ADMIN,
      body: {
        name: "Кампанія редактора",
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

  const houses = (await api(
    "GET",
    `/api/elections/houses?campaignId=${campaignId}`,
    {
      as: ADMIN,
    },
  )).json.houses as { id: string; number: string }[];

  const ordered = [...houses].sort((left, right) =>
    left.number.localeCompare(right.number));

  houseId = ordered[0].id;
  farHouseId = ordered[1].id;

  // The coordinator and the agitator hold the first building and nothing else.
  for (const email of [
    COORDINATOR,
    AGITATOR,
  ]) {
    await api(
      "POST",
      `/api/elections/assignments?campaignId=${campaignId}`,
      {
        as: ADMIN,
        body: {
          scope: "house",
          scopeId: houseId,
          employeeEmail: email,
          role: "agitator",
        },
      },
    );
  }

  await api(
    "POST",
    `/api/elections/campaigns/${archivedCampaignId}/archive`,
    {
      as: MANAGER,
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
  delete process.env.ELECTIONS_ADMIN_EMAILS;
});

/** The house as the editor loads it. */
async function readHouse(as = MANAGER, id = houseId) {
  const response = await api(
    "GET",
    `/api/elections/houses/${id}?campaignId=${campaignId}`,
    {
      as,
    },
  );

  assert.equal(
    response.status,
    200,
    response.text,
  );

  return response.json;
}

describe("the fields the editor added", () => {
  test("a block, a data source and a next step all round-trip", async () => {
    const saved = await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          block: "корпус 2",
          source: "обхід 12.05",
          managingOrg: "ОСББ «Зодчих 58»",
        },
      },
    );

    assert.equal(
      saved.status,
      200,
      saved.text,
    );
    assert.equal(
      saved.json.block,
      "корпус 2",
    );
    assert.equal(
      saved.json.source,
      "обхід 12.05",
      "the source was in the input type but no statement ever wrote it",
    );

    const state = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          nextStep: "Передзвонити голові ОСББ",
          summary: "Обійшли 1–3 підʼїзд",
        },
      },
    );

    assert.equal(
      state.status,
      200,
      state.text,
    );
    assert.equal(
      state.json.campaign.nextStep,
      "Передзвонити голові ОСББ",
    );

    // Both survive a fresh read — not just the response of the write.
    const reread = await readHouse();

    assert.equal(
      reread.block,
      "корпус 2",
    );
    assert.equal(
      reread.campaign.nextStep,
      "Передзвонити голові ОСББ",
    );
  });

  test("the block joins the shown address and not the duplicate key", async () => {
    const house = await readHouse();

    assert.match(
      house.address,
      /корпус 2/,
      "the address a person reads has to carry the block",
    );
    assert.ok(
      !house.addressNormalized.includes("корпус"),
      "the normalised key is the duplicate-detection key: 58 with a block and " +
        "58 without one are the same house number",
    );
  });
});

describe("the house and the campaign state stay separate", () => {
  test("writing attributes leaves this campaign's state untouched", async () => {
    await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          stage: "in_progress",
          priority: "high",
        },
      },
    );

    await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          entrances: 6,
        },
      },
    );

    const house = await readHouse();

    assert.equal(
      house.entrances,
      6,
    );
    assert.equal(
      house.campaign.stage,
      "in_progress",
      "an attributes write must not reset the stage",
    );
    assert.equal(
      house.campaign.priority,
      "high",
    );
  });

  test("writing state leaves the building's own record untouched", async () => {
    await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          stage: "done",
        },
      },
    );

    const house = await readHouse();

    assert.equal(
      house.entrances,
      6,
      "a state write must not clear the entrance count",
    );
    assert.equal(
      house.block,
      "корпус 2",
    );
  });

  test("state written in one campaign is invisible in another", async () => {
    const other = (await api(
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

    const inOther = await api(
      "GET",
      `/api/elections/houses/${houseId}?campaignId=${other}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      inOther.json.campaign.stage,
      "not_started",
      "a second campaign starts clean over the same buildings",
    );
    assert.equal(
      inOther.json.entrances,
      6,
      "…while the building itself is the same building",
    );
  });
});

describe("a stale save is refused rather than merged", () => {
  test("a mismatched updatedAt is a 409 with a message a person can act on", async () => {
    const house = await readHouse();

    // Somebody else saves first.
    await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          managingOrg: "ЖЕК №4",
        },
      },
    );

    const stale = await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          managingOrg: "ОСББ «Зодчих 58»",
          expectedUpdatedAt: house.updatedAt,
        },
      },
    );

    assert.equal(
      stale.status,
      409,
      `a save built on a replaced copy must be refused: ${stale.text}`,
    );
    assert.match(
      stale.json.error,
      /змінив інший користувач/,
    );

    const after = await readHouse();

    assert.equal(
      after.managingOrg,
      "ЖЕК №4",
      "the refused write must not have landed",
    );
  });

  test("the campaign state carries its own token", async () => {
    const house = await readHouse();

    await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          summary: "Оновлено кимось іншим",
        },
      },
    );

    const stale = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          summary: "Моя версія",
          expectedUpdatedAt: house.campaign.updatedAt,
        },
      },
    );

    assert.equal(
      stale.status,
      409,
      stale.text,
    );
  });

  test("a write without a token still works, so scripts are unaffected", async () => {
    const forced = await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          managingOrg: "ОСББ «Зодчих 58»",
        },
      },
    );

    assert.equal(
      forced.status,
      200,
      forced.text,
    );
    assert.equal(
      forced.json.managingOrg,
      "ОСББ «Зодчих 58»",
    );
  });
});

describe("the check date belongs to the server", () => {
  test("`verified: true` stamps the clock and the caller, and a forged pair is ignored", async () => {
    const saved = await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          verified: true,
          // Both are deliberately not inputs. Sending them must change nothing.
          verifiedBy: "someone.else@avku.test",
          verifiedAt: "1999-01-01T00:00:00.000Z",
        },
      },
    );

    assert.equal(
      saved.status,
      200,
      saved.text,
    );
    assert.equal(
      saved.json.verifiedBy,
      COORDINATOR,
      "the author of a check is the verified identity, never a request field",
    );
    assert.notEqual(
      saved.json.verifiedAt,
      "1999-01-01T00:00:00.000Z",
    );
    assert.ok(
      Date.parse(saved.json.verifiedAt) > Date.now() - 60_000,
      "the check date comes from the server clock",
    );
  });
});

describe("contacts", () => {
  let personId = "";
  let linkId = "";

  test("a person is created with several channels", async () => {
    const created = await api(
      "POST",
      `/api/elections/houses/${houseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          fullName: "Коваленко Олена Петрівна",
          role: "osbb_head",
          entrance: "2",
          apartment: "12",
          contacts: [
            {
              type: "phone",
              value: "+380671234567",
              isPrimary: true,
              verified: true,
            },
            {
              type: "phone",
              value: "+380509876543",
              label: "робочий",
            },
          ],
        },
      },
    );

    assert.equal(
      created.status,
      201,
      created.text,
    );
    personId = created.json.id;

    const people = (await api(
      "GET",
      `/api/elections/houses/${houseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json;

    const person = people.find((one: any) => one.id === personId);

    assert.equal(
      person.contacts.length,
      2,
    );
    linkId = person.links[0].id;

    const primary = person.contacts.find((one: any) => one.isPrimary);

    assert.ok(
      primary.verifiedAt,
      "a channel marked checked carries the date it was checked",
    );
    assert.equal(
      primary.verifiedBy,
      COORDINATOR,
    );
  });

  /**
   * Contacts are replaced wholesale on every person edit, so without an
   * explicit carry-over, correcting a *name* would silently reset every phone
   * number to "never verified".
   */
  test("editing the name keeps each phone's checked-on stamp", async () => {
    const before = (await api(
      "GET",
      `/api/elections/houses/${houseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json.find((one: any) => one.id === personId);

    const stampedBefore = before.contacts.find((one: any) => one.verifiedAt);

    const updated = await api(
      "PATCH",
      `/api/elections/people/${personId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          fullName: "Коваленко Олена",
          contacts: before.contacts.map((one: any) => ({
            id: one.id,
            type: one.type,
            value: one.value,
            label: one.label,
            isPrimary: one.isPrimary,
          })),
        },
      },
    );

    assert.equal(
      updated.status,
      200,
      updated.text,
    );

    const after = (await api(
      "GET",
      `/api/elections/houses/${houseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json.find((one: any) => one.id === personId);

    assert.equal(
      after.fullName,
      "Коваленко Олена",
    );

    const stampedAfter = after.contacts.find(
      (one: any) => one.value === stampedBefore.value,
    );

    assert.equal(
      stampedAfter.verifiedAt,
      stampedBefore.verifiedAt,
      "a rename must not reset when the phone was last confirmed to work",
    );
  });

  test("the flat can be corrected without claiming the person moved in today", async () => {
    const patched = await api(
      "PATCH",
      `/api/elections/person-links/${linkId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          apartment: "14",
        },
      },
    );

    assert.equal(
      patched.status,
      200,
      patched.text,
    );

    const person = (await api(
      "GET",
      `/api/elections/houses/${houseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json.find((one: any) => one.id === personId);

    assert.equal(
      person.links[0].apartment,
      "14",
    );
  });

  test("removing the link keeps the person; only a manager removes the person", async () => {
    const refused = await api(
      "DELETE",
      `/api/elections/people/${personId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      refused.status,
      403,
      `deleting a person needs a manager: ${refused.text}`,
    );

    const unlinked = await api(
      "DELETE",
      `/api/elections/person-links/${linkId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      unlinked.status,
      200,
      unlinked.text,
    );

    const people = (await api(
      "GET",
      `/api/elections/houses/${houseId}/people?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    )).json;

    assert.ok(
      !people.some((one: any) => one.id === personId),
      "the person is no longer attached to this building",
    );

    const deleted = await api(
      "DELETE",
      `/api/elections/people/${personId}?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      deleted.status,
      200,
      deleted.text,
    );
  });
});

describe("the house's own history", () => {
  test("shows both the building's edits and its campaign-state changes", async () => {
    const history = await api(
      "GET",
      `/api/elections/houses/${houseId}/history?campaignId=${campaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      history.status,
      200,
      history.text,
    );

    const entities = new Set(history.json.map((one: any) => one.entity));

    assert.ok(
      entities.has("house"),
      "the building's own edits must be in its history",
    );
    assert.ok(
      entities.has("houseCampaignState"),
      "so must its stage and priority: campaign state is journalled under " +
        "`<campaignId>:<houseId>`, so asking for the house id alone returned a " +
        "history with every stage change missing from it",
    );

    const stage = history.json.find((one: any) => one.field === "stage");

    assert.ok(
      stage,
      "the stage changes made above have to appear",
    );
    assert.ok(
      stage.changedBy,
      "and each one names the identity the server resolved",
    );
  });
});

describe("events at one address", () => {
  test("the house's own events come back, and other houses' do not", async () => {
    await api(
      "POST",
      `/api/elections/events?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          type: "meeting",
          title: "Зустріч із мешканцями",
          houseId,
          startsAt: "2026-08-10T17:00:00.000Z",
        },
      },
    );

    await api(
      "POST",
      `/api/elections/events?campaignId=${campaignId}`,
      {
        as: MANAGER,
        body: {
          type: "cleanup",
          title: "Суботник в іншому дворі",
          houseId: farHouseId,
          startsAt: "2026-08-11T09:00:00.000Z",
        },
      },
    );

    const listed = await api(
      "GET",
      `/api/elections/houses/${houseId}/events?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
      },
    );

    assert.equal(
      listed.status,
      200,
      listed.text,
    );
    assert.equal(
      listed.json.length,
      1,
    );
    assert.equal(
      listed.json[0].title,
      "Зустріч із мешканцями",
    );
  });
});

describe("an action can be corrected, not only deleted", () => {
  test("the author survives the correction and the change is journalled", async () => {
    const created = await api(
      "POST",
      `/api/elections/actions?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          houseId,
          type: "visit",
          result: "no_answer",
          comment: "Ніхто не відчинив",
        },
      },
    );

    assert.equal(
      created.status,
      201,
      created.text,
    );

    const patched = await api(
      "PATCH",
      `/api/elections/actions/${created.json.id}?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          result: "contacted",
          comment: "Помилка: поговорили з сусідкою",
        },
      },
    );

    assert.equal(
      patched.status,
      200,
      patched.text,
    );

    const actions = (await api(
      "GET",
      `/api/elections/houses/${houseId}/actions?campaignId=${campaignId}`,
      {
        as: AGITATOR,
      },
    )).json;

    const action = actions.find((one: any) => one.id === created.json.id);

    assert.equal(
      action.result,
      "contacted",
    );
    assert.equal(
      action.authorEmail,
      AGITATOR,
      "an edit does not change who did the work",
    );
  });
});

/**
 * The rule the whole permission model rests on: a disabled button is a
 * courtesy, and the server is the boundary. Every case here is a request the
 * editor would never send, issued directly.
 */
describe("the editor's writes cannot be smuggled past the server", () => {
  test("an archived campaign refuses the house record and its state alike", async () => {
    const attributes = await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${archivedCampaignId}`,
      {
        as: MANAGER,
        body: {
          managingOrg: "Змінено в архіві",
        },
      },
    );

    assert.equal(
      attributes.status,
      409,
      `an archived campaign accepted a house edit: ${attributes.text}`,
    );

    const state = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${archivedCampaignId}`,
      {
        as: MANAGER,
        body: {
          stage: "done",
        },
      },
    );

    assert.equal(
      state.status,
      409,
      `an archived campaign accepted a state edit: ${state.text}`,
    );

    // …and it is still readable, which is the point of an archive.
    const readable = await api(
      "GET",
      `/api/elections/houses/${houseId}?campaignId=${archivedCampaignId}`,
      {
        as: MANAGER,
      },
    );

    assert.equal(
      readable.status,
      200,
      readable.text,
    );
  });

  test("an archived campaign refuses the editor's independent records too", async () => {
    for (
      const [pathname, body] of [
        [
          "actions",
          {
            houseId,
            type: "visit",
            result: "contacted",
          },
        ],
        [
          "tasks",
          {
            houseId,
            title: "Задача в архіві",
          },
        ],
        [
          "issues",
          {
            houseId,
            category: "utilities",
            title: "Звернення в архіві",
          },
        ],
      ] as [string, Record<string, unknown>][]
    ) {
      const refused = await api(
        "POST",
        `/api/elections/${pathname}?campaignId=${archivedCampaignId}`,
        {
          as: MANAGER,
          body,
        },
      );

      assert.equal(
        refused.status,
        409,
        `an archived campaign accepted a new ${pathname} row: ${refused.text}`,
      );
    }
  });

  test("a house outside the caller's territory answers 404, not 403", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/houses/${farHouseId}?campaignId=${campaignId}`,
      {
        as: COORDINATOR,
        body: {
          managingOrg: "Чужа територія",
        },
      },
    );

    // 404 rather than 403 deliberately: a 403 would confirm the house exists.
    assert.equal(
      refused.status,
      404,
      `a coordinator edited a building they do not hold: ${refused.text}`,
    );

    const stateRefused = await api(
      "PATCH",
      `/api/elections/houses/${farHouseId}/state?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          stage: "done",
        },
      },
    );

    assert.equal(
      stateRefused.status,
      404,
      stateRefused.text,
    );
  });

  test("an agitator may record work but not edit the building", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/houses/${houseId}?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          entrances: 12,
        },
      },
    );

    assert.equal(
      refused.status,
      403,
      `an agitator edited the permanent record: ${refused.text}`,
    );

    const allowed = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        as: AGITATOR,
        body: {
          stage: "revisit_needed",
        },
      },
    );

    assert.equal(
      allowed.status,
      200,
      allowed.text,
    );
  });

  test("a request with no identity at all is refused outright", async () => {
    const refused = await api(
      "PATCH",
      `/api/elections/houses/${houseId}/state?campaignId=${campaignId}`,
      {
        body: {
          stage: "done",
        },
      },
    );

    assert.equal(
      refused.status,
      401,
      refused.text,
    );
  });
});
