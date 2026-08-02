import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { Employee } from "../modules/employees/employee-records";
import type { EmployeeRepository } from "../modules/employees/employee-records";
import type { WorkspaceAreaRepository } from "../modules/elections/workspace-area-records";
import type { WarehouseRepository } from "../modules/warehouse/warehouse-records";
import { ElectionsRepository, readAttachmentFields } from "../modules/elections/elections-records";
import {
  ELECTIONS_ROLES,
  type ElectionsRole,
  type ElectionsViewer,
  hasAtLeast,
  requireRole,
  resolveViewer,
} from "../modules/elections/elections-access";
import {
  archiveCampaign,
  createCampaign,
  createPrecinct,
  deletePrecinct,
  findCampaign,
  findDefaultCampaign,
  getCampaign,
  listCampaigns,
  listPrecincts,
  updateCampaign,
  updatePrecinct,
} from "../modules/elections/campaign-records";
import {
  findDuplicateHouses,
  getHouse,
  linkHouseToPrecinct,
  listHouses,
  mergeHouses,
  unlinkHouseFromPrecinct,
  updateHouseAttributes,
  updateHouseCampaignState,
} from "../modules/elections/house-records";
import {
  bulkAssignHouses,
  createAssignment,
  createPerson,
  deletePersonLink,
  endAssignment,
  linkPersonToHouse,
  listAssignments,
  listHousePeople,
  listVisibleHouseIds,
  mergePeople,
  searchPeople,
  updatePerson,
} from "../modules/elections/people-records";
import {
  createAction,
  createEvent,
  createIssue,
  createMaterialIssue,
  createShift,
  canReadAttachment,
  createTask,
  deleteAction,
  deleteAttachment,
  deleteEvent,
  deleteIssue,
  deleteTask,
  findAttachment,
  insertAttachment,
  listActions,
  listAttachments,
  listEvents,
  listIssues,
  listMaterialIssues,
  listTasks,
  updateIssue,
  updateTask,
} from "../modules/elections/activity-records";
import {
  applyBatch,
  attachLegacyOsmMatch,
  createBatch,
  getBatch,
  legacyExportToRows,
  listBatchRows,
  listBatches,
  rollbackBatch,
  setRowDecisions,
} from "../modules/elections/import-records";
import {
  logAccess,
  readAccessLog,
  readChangeLog,
} from "../modules/elections/change-log";
import {
  buildHousesCsv,
  countExportRows,
  type ExportContact,
} from "../modules/elections/elections-export";
import {
  ACTION_RESULTS,
  ACTION_TYPES,
  CONTACT_TYPES,
  EVENT_TYPES,
  ISSUE_CATEGORIES,
  ISSUE_STATUSES,
  PERSON_ROLES,
  PRIORITIES,
  TASK_STATUSES,
  WORK_STAGES,
  badRequest,
} from "../modules/elections/elections.types";
import { readJsonBody, readRequestBody } from "../http/body";
import { parseMultipartBody } from "../http/multipart";
import { HttpError, sendJson } from "../http/responses";

/**
 * `/api/elections/*` — the whole "Вибори" API.
 *
 * Three rules hold everywhere below:
 *
 *  1. **Every write checks a role first.** Before this change the module had no
 *     authorization at all, so anybody on the LAN could `PUT` the working-area
 *     boundary and thereby decide which houses exist for everyone.
 *  2. **The author is the server's answer, never the client's.** There is no
 *     request field anywhere for "who did this".
 *  3. **Composite writes run in one transaction** through
 *     `ElectionsRepository.withTransaction`, so a half-created person with no
 *     phone and no link to a house is not a state the database can reach.
 */

export interface ElectionsRouteDependencies {
  elections: ElectionsRepository;
  workspaceArea: WorkspaceAreaRepository;
  employees: EmployeeRepository;
  warehouse: WarehouseRepository;
}

function notFound(response: ServerResponse): void {
  sendJson(
    response,
    404,
    {
      error: "Маршрут не знайдено.",
    },
  );
}

function readLimit(url: URL, fallback: number): number {
  const raw = Number(url.searchParams.get("limit"));

  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** The campaign a request works in: `?campaignId=…`, else the active one. */
async function resolveCampaignId(
  repository: ElectionsRepository,
  url: URL,
): Promise<string | null> {
  const database = await repository.getDatabase();
  const requested = url.searchParams.get("campaignId");

  if (requested) {
    // Validated rather than trusted: an unknown id must not silently fall back
    // to the active campaign and write somebody's visit into the wrong one.
    return getCampaign(
      database,
      requested,
    ).id;
  }

  return findDefaultCampaign(database)?.id ?? null;
}

/**
 * Refuses a write aimed at an archived campaign.
 *
 * Archiving is meant to close a campaign and keep it readable, but nothing
 * enforced that: `?campaignId=<archived>` accepted new actions, tasks and
 * issues exactly like a live one, so a finished campaign silently kept growing
 * and its numbers stopped being a record of what happened. Reads are
 * deliberately left alone — the whole point of an archive is that it can still
 * be consulted.
 */
async function assertCampaignWritable(
  repository: ElectionsRepository,
  campaignId: string | null,
): Promise<void> {
  if (!campaignId) {
    return;
  }

  const database = await repository.getDatabase();
  const campaign = findCampaign(
    database,
    campaignId,
  );

  if (campaign?.status === "archived") {
    throw new HttpError(
      409,
      "Кампанію заархівовано: дані доступні лише для читання. " +
        "Щоб продовжити роботу, поверніть кампанію в активний стан.",
    );
  }
}

function requireCampaign(campaignId: string | null): string {
  if (!campaignId) {
    throw new HttpError(
      409,
      "Немає активної кампанії. Створіть кампанію в розділі «Вибори».",
    );
  }

  return campaignId;
}

/**
 * Static vocabularies, so the client renders labels for exactly the values the
 * server will accept. Public: it contains no data, only the shape of the domain.
 */
function sendReferenceData(response: ServerResponse): void {
  sendJson(
    response,
    200,
    {
      workStages: WORK_STAGES,
      priorities: PRIORITIES,
      actionTypes: ACTION_TYPES,
      actionResults: ACTION_RESULTS,
      issueCategories: ISSUE_CATEGORIES,
      issueStatuses: ISSUE_STATUSES,
      taskStatuses: TASK_STATUSES,
      personRoles: PERSON_ROLES,
      contactTypes: CONTACT_TYPES,
      eventTypes: EVENT_TYPES,
      roles: ELECTIONS_ROLES,
    },
  );
}

/* ------------------------------------------------------------------ *
 * Houses
 * ------------------------------------------------------------------ */

async function handleHouses(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ElectionsRouteDependencies,
  viewer: ElectionsViewer,
  url: URL,
  segments: string[],
): Promise<boolean> {
  const repository = dependencies.elections;
  const database = await repository.getDatabase();
  const campaignId = await resolveCampaignId(
    repository,
    url,
  );

  if (segments.length === 1 && request.method === "GET") {
    if (!campaignId) {
      sendJson(
        response,
        200,
        {
          houses: [],
          campaign: null,
          campaigns: listCampaigns(database),
        },
      );
      return true;
    }

    const houses = listHouses(
      database,
      {
        campaignId,
        viewer,
      },
    );

    sendJson(
      response,
      200,
      {
        houses,
        campaign: findCampaign(
          database,
          campaignId,
        ),
        campaigns: listCampaigns(
          database,
          {
            includeArchived: hasAtLeast(
              viewer,
              "manager",
            ),
          },
        ),
        viewer: {
          email: viewer.email,
          role: viewer.role,
          isDevAuth: viewer.isDevAuth,
          isLocalAuth: viewer.isLocalAuth,
        },
      },
    );
    return true;
  }

  if (segments.length < 2) {
    return false;
  }

  const houseId = segments[1];
  const action = segments[2];
  const listOptions = {
    campaignId: requireCampaign(campaignId),
    viewer,
  };

  if (request.method !== "GET") {
    await assertCampaignWritable(
      repository,
      listOptions.campaignId,
    );
  }

  if (!action && request.method === "GET") {
    sendJson(
      response,
      200,
      getHouse(
        database,
        houseId,
        listOptions,
      ),
    );
    return true;
  }

  if (!action && request.method === "PATCH") {
    requireRole(
      viewer,
      "coordinator",
    );

    const body = await readJsonBody(request);

    sendJson(
      response,
      200,
      await repository.withTransaction((db) =>
        updateHouseAttributes(
          db,
          houseId,
          body,
          {
            actor: viewer.email,
            campaignId: listOptions.campaignId,
          },
          listOptions,
        )),
    );
    return true;
  }

  if (action === "state" && request.method === "PATCH") {
    // The stage and priority of a house are ordinary field work, so an agitator
    // may set them — unlike the building's permanent attributes above.
    requireRole(
      viewer,
      "agitator",
    );

    const body = await readJsonBody(request);

    sendJson(
      response,
      200,
      await repository.withTransaction((db) =>
        updateHouseCampaignState(
          db,
          houseId,
          listOptions.campaignId,
          body,
          {
            actor: viewer.email,
            campaignId: listOptions.campaignId,
          },
          listOptions,
        )),
    );
    return true;
  }

  if (action === "people" && request.method === "GET") {
    const house = getHouse(
      database,
      houseId,
      listOptions,
    );

    sendJson(
      response,
      200,
      listHousePeople(
        database,
        houseId,
        viewer,
        house.canSeeContacts,
        {
          campaignId: listOptions.campaignId,
        },
      ),
    );
    return true;
  }

  if (action === "people" && request.method === "POST") {
    requireRole(
      viewer,
      "agitator",
    );
    // Confirms the viewer may work with this house before a contact is created
    // against it.
    getHouse(
      database,
      houseId,
      listOptions,
    );

    const body = await readJsonBody(request);
    const personId = await repository.withTransaction((db) =>
      createPerson(
        db,
        {
          ...body,
          houseId,
        },
        {
          actor: viewer.email,
          campaignId: listOptions.campaignId,
        },
      ));

    sendJson(
      response,
      201,
      {
        id: personId,
      },
    );
    return true;
  }

  if (action === "actions" && request.method === "GET") {
    getHouse(
      database,
      houseId,
      listOptions,
    );
    sendJson(
      response,
      200,
      listActions(
        database,
        listOptions.campaignId,
        viewer,
        {
          houseId,
          limit: readLimit(
            url,
            200,
          ),
        },
      ),
    );
    return true;
  }

  if (action === "issues" && request.method === "GET") {
    getHouse(
      database,
      houseId,
      listOptions,
    );
    sendJson(
      response,
      200,
      listIssues(
        database,
        listOptions.campaignId,
        viewer,
        {
          houseId,
        },
      ),
    );
    return true;
  }

  if (action === "tasks" && request.method === "GET") {
    getHouse(
      database,
      houseId,
      listOptions,
    );
    sendJson(
      response,
      200,
      listTasks(
        database,
        listOptions.campaignId,
        viewer,
        {
          houseId,
        },
      ),
    );
    return true;
  }

  if (action === "attachments" && request.method === "GET") {
    getHouse(
      database,
      houseId,
      listOptions,
    );
    sendJson(
      response,
      200,
      listAttachments(
        database,
        "house",
        [houseId],
      ).get(houseId) ?? [],
    );
    return true;
  }

  if (action === "history" && request.method === "GET") {
    getHouse(
      database,
      houseId,
      listOptions,
    );
    sendJson(
      response,
      200,
      readChangeLog(
        database,
        {
          entityId: houseId,
          limit: readLimit(
            url,
            100,
          ),
        },
      ),
    );
    return true;
  }

  if (action === "precincts" && request.method === "POST") {
    requireRole(
      viewer,
      "coordinator",
    );

    const body = await readJsonBody(request);
    const id = await repository.withTransaction((db) =>
      linkHouseToPrecinct(
        db,
        houseId,
        body,
        {
          actor: viewer.email,
          campaignId: listOptions.campaignId,
        },
      ));

    sendJson(
      response,
      201,
      {
        id,
      },
    );
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Activity: actions, issues, tasks
 * ------------------------------------------------------------------ */

async function handleActivity(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ElectionsRouteDependencies,
  viewer: ElectionsViewer,
  url: URL,
  segments: string[],
): Promise<boolean> {
  const repository = dependencies.elections;
  const database = await repository.getDatabase();
  const [collection, recordId] = segments;
  // Reading the work log is not public. These three collections used to answer
  // anybody — including a request with no identity at all — with the whole
  // campaign's actions, tasks and issue descriptions.
  requireRole(
    viewer,
    "agitator",
  );

  const campaignId = requireCampaign(await resolveCampaignId(
    repository,
    url,
  ));
  const context = {
    actor: viewer.email ?? "",
    campaignId,
  };

  if (request.method !== "GET") {
    await assertCampaignWritable(
      repository,
      campaignId,
    );
  }

  if (collection === "actions") {
    if (request.method === "GET" && !recordId) {
      sendJson(
        response,
        200,
        listActions(
          database,
          campaignId,
          viewer,
          {
            houseId: url.searchParams.get("houseId") ?? undefined,
            limit: readLimit(
              url,
              200,
            ),
          },
        ),
      );
      return true;
    }

    if (request.method === "POST" && !recordId) {
      requireRole(
        viewer,
        "agitator",
      );

      const body = await readJsonBody(request);

      if (body.houseId) {
        // Refuses an action logged against a house the caller cannot see.
        getHouse(
          database,
          String(body.houseId),
          {
            campaignId,
            viewer,
          },
        );
      }

      const id = await repository.withTransaction((db) =>
        createAction(
          db,
          campaignId,
          body,
          context,
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return true;
    }

    if (request.method === "DELETE" && recordId) {
      requireRole(
        viewer,
        "coordinator",
      );
      await repository.withTransaction((db) =>
        deleteAction(
          db,
          recordId,
          context,
          viewer,
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return true;
    }
  }

  if (collection === "issues") {
    if (request.method === "GET" && !recordId) {
      sendJson(
        response,
        200,
        listIssues(
          database,
          campaignId,
          viewer,
          {
            houseId: url.searchParams.get("houseId") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            limit: readLimit(
              url,
              200,
            ),
          },
        ),
      );
      return true;
    }

    if (request.method === "POST" && !recordId) {
      requireRole(
        viewer,
        "agitator",
      );

      const body = await readJsonBody(request);

      if (body.houseId) {
        getHouse(
          database,
          String(body.houseId),
          {
            campaignId,
            viewer,
          },
        );
      }

      const id = await repository.withTransaction((db) =>
        createIssue(
          db,
          campaignId,
          body,
          context,
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return true;
    }

    if (request.method === "PATCH" && recordId) {
      requireRole(
        viewer,
        "agitator",
      );

      const body = await readJsonBody(request);

      await repository.withTransaction((db) =>
        updateIssue(
          db,
          recordId,
          body,
          context,
          viewer,
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return true;
    }

    if (request.method === "DELETE" && recordId) {
      requireRole(
        viewer,
        "coordinator",
      );
      await repository.withTransaction((db) =>
        deleteIssue(
          db,
          recordId,
          context,
          viewer,
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return true;
    }
  }

  if (collection === "tasks") {
    if (request.method === "GET" && !recordId) {
      const scope = url.searchParams.get("scope");

      sendJson(
        response,
        200,
        listTasks(
          database,
          campaignId,
          viewer,
          {
            houseId: url.searchParams.get("houseId") ?? undefined,
            assigneeEmail: url.searchParams.get("assignee") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            scope: scope === "today" || scope === "overdue" ||
                scope === "unassigned" || scope === "open"
              ? scope
              : undefined,
            limit: readLimit(
              url,
              200,
            ),
          },
        ),
      );
      return true;
    }

    if (request.method === "POST" && !recordId) {
      requireRole(
        viewer,
        "agitator",
      );

      const body = await readJsonBody(request);

      if (body.houseId) {
        getHouse(
          database,
          String(body.houseId),
          {
            campaignId,
            viewer,
          },
        );
      }

      const id = await repository.withTransaction((db) =>
        createTask(
          db,
          campaignId,
          body,
          context,
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return true;
    }

    if (request.method === "PATCH" && recordId) {
      requireRole(
        viewer,
        "agitator",
      );

      const body = await readJsonBody(request);

      await repository.withTransaction((db) =>
        updateTask(
          db,
          recordId,
          body,
          context,
          viewer,
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return true;
    }

    if (request.method === "DELETE" && recordId) {
      requireRole(
        viewer,
        "coordinator",
      );
      await repository.withTransaction((db) =>
        deleteTask(
          db,
          recordId,
          context,
          viewer,
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return true;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

async function handleImport(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ElectionsRouteDependencies,
  viewer: ElectionsViewer,
  url: URL,
  segments: string[],
): Promise<boolean> {
  const repository = dependencies.elections;
  const database = await repository.getDatabase();
  const [, batchId, action] = segments;

  // Import touches every table at once and can create records nobody reviewed,
  // so the whole area is admin-only.
  requireRole(
    viewer,
    "admin",
  );

  const context = {
    actor: viewer.email,
  };

  if (!batchId && request.method === "GET") {
    sendJson(
      response,
      200,
      listBatches(database),
    );
    return true;
  }

  if (!batchId && request.method === "POST") {
    const body = await readJsonBody(request);
    const campaignId = await resolveCampaignId(
      repository,
      url,
    );
    const kind = String(body.kind ?? "csv");
    const isLegacy = kind === "legacy_local";
    const rows = isLegacy
      ? legacyExportToRows(body.document as never)
      : (Array.isArray(body.rows) ? body.rows : []);

    if (!Array.isArray(rows) || rows.length === 0) {
      badRequest("У завантаженому файлі не знайдено жодного рядка даних.");
    }

    const batch = await repository.withTransaction((db) => {
      const created = createBatch(
        db,
        {
          kind: isLegacy ? "legacy_local" : "csv",
          fileName: String(body.fileName ?? ""),
          campaignId,
          rows: rows as Record<string, unknown>[],
        },
        context,
      );

      if (isLegacy) {
        // Legacy rows carry the OSM id the old overlay was keyed by, which is a
        // far stronger match than a parsed address string.
        attachLegacyOsmMatch(
          db,
          created.id,
        );
      }

      return getBatch(
        db,
        created.id,
      );
    });

    sendJson(
      response,
      201,
      {
        batch,
        rows: listBatchRows(
          database,
          batch.id,
          {
            limit: 500,
          },
        ),
      },
    );
    return true;
  }

  if (batchId && !action && request.method === "GET") {
    sendJson(
      response,
      200,
      {
        batch: getBatch(
          database,
          batchId,
        ),
        rows: listBatchRows(
          database,
          batchId,
          {
            status: url.searchParams.get("status") ?? undefined,
            limit: readLimit(
              url,
              500,
            ),
          },
        ),
      },
    );
    return true;
  }

  if (batchId && action === "decisions" && request.method === "POST") {
    const body = await readJsonBody(request);
    const decisions = Array.isArray(body.decisions) ? body.decisions : [];

    const updated = await repository.withTransaction((db) =>
      setRowDecisions(
        db,
        batchId,
        decisions as never,
        context,
      ));

    sendJson(
      response,
      200,
      {
        updated,
      },
    );
    return true;
  }

  if (batchId && action === "apply" && request.method === "POST") {
    const campaignId = await resolveCampaignId(
      repository,
      url,
    );
    const report = await repository.withTransaction((db) =>
      applyBatch(
        db,
        batchId,
        campaignId,
        context,
      ));

    sendJson(
      response,
      200,
      {
        report,
        batch: getBatch(
          database,
          batchId,
        ),
      },
    );
    return true;
  }

  if (batchId && action === "rollback" && request.method === "POST") {
    const result = await repository.withTransaction((db) =>
      rollbackBatch(
        db,
        batchId,
        context,
      ));

    sendJson(
      response,
      200,
      {
        ...result,
        batch: getBatch(
          database,
          batchId,
        ),
      },
    );
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

async function handleAttachments(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ElectionsRouteDependencies,
  viewer: ElectionsViewer,
  url: URL,
  segments: string[],
): Promise<boolean> {
  const repository = dependencies.elections;
  const database = await repository.getDatabase();
  const [, attachmentId, action] = segments;

  if (!attachmentId && request.method === "POST") {
    requireRole(
      viewer,
      "agitator",
    );

    const contentTypeHeader = request.headers["content-type"] ?? "";
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader.join(";")
      : contentTypeHeader;

    if (!contentType.includes("multipart/form-data")) {
      badRequest("Очікується multipart/form-data з файлом.");
    }

    const parts = parseMultipartBody(
      await readRequestBody(request),
      contentType,
    );
    const fields: Record<string, string> = {};
    let file: { content: Buffer; contentType: string; fileName: string } | null =
      null;

    for (const part of parts) {
      if (part.fileName) {
        file = {
          content: part.content,
          contentType: part.contentType ?? "application/octet-stream",
          fileName: part.fileName,
        };
        continue;
      }

      fields[part.name] = part.content.toString("utf8");
    }

    if (!file) {
      badRequest("У запиті немає файлу.");
    }

    const meta = readAttachmentFields({
      ...fields,
      fileName: fields.fileName || file.fileName,
    });
    const campaignId = await resolveCampaignId(
      repository,
      url,
    );

    await assertCampaignWritable(
      repository,
      campaignId,
    );

    if (meta.houseId) {
      getHouse(
        database,
        meta.houseId,
        {
          campaignId: requireCampaign(campaignId),
          viewer,
        },
      );
    }

    const stored = await repository.saveAttachmentFile({
      content: file.content,
      contentType: file.contentType,
    });

    const id = await repository.withTransaction((db) =>
      insertAttachment(
        db,
        {
          ...meta,
          campaignId,
          storedName: stored.storedName,
          contentType: stored.contentType,
          byteSize: file.content.length,
        },
        {
          actor: viewer.email,
          campaignId,
        },
      ));

    sendJson(
      response,
      201,
      {
        id,
        url: `/api/elections/attachments/${encodeURIComponent(id)}/file`,
      },
    );
    return true;
  }

  if (attachmentId && action === "file" && request.method === "GET") {
    requireRole(
      viewer,
      "agitator",
    );

    const attachment = findAttachment(
      database,
      attachmentId,
    );

    if (!attachment) {
      notFound(response);
      return true;
    }

    if (!canReadAttachment(
      database,
      attachment,
      await resolveCampaignId(
        repository,
        url,
      ),
      viewer,
    )) {
      // Same answer as a missing id: whether a given attachment exists is
      // itself information about somebody else's territory.
      notFound(response);
      return true;
    }

    const filePath = repository.resolveAttachmentPath(attachment.storedName);
    const stats = await stat(filePath);
    // Only real images are rendered in place. Anything else downloads, and
    // nothing is ever sniffed into a type the allowlist did not grant it.
    const isImage = attachment.contentType.startsWith("image/");

    response.writeHead(
      200,
      {
        "Content-Type": attachment.contentType,
        "Content-Length": stats.size,
        "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename*=UTF-8''${
          encodeURIComponent(attachment.fileName)
        }`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=300",
      },
    );

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);

      stream.on(
        "error",
        reject,
      );
      stream.on(
        "end",
        resolve,
      );
      stream.pipe(response);
    });

    return true;
  }

  if (attachmentId && !action && request.method === "DELETE") {
    requireRole(
      viewer,
      "coordinator",
    );
    await repository.withTransaction((db) =>
      deleteAttachment(
        db,
        attachmentId,
        {
          actor: viewer.email,
        },
      ));
    sendJson(
      response,
      200,
      {
        ok: true,
      },
    );
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ *
 * Dispatcher
 * ------------------------------------------------------------------ */

export async function handleElectionsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ElectionsRouteDependencies,
  pathname: string,
  employee: Employee | null,
  url: URL,
): Promise<void> {
  const viewer = resolveViewer({
    email: employee?.email ?? null,
    storedRole: employee?.role ?? null,
  });
  const repository = dependencies.elections;
  const segments = pathname
    .replace(
      /^\/api\/elections\/?/,
      "",
    )
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (segments[0] === "reference" && request.method === "GET") {
    sendReferenceData(response);
    return;
  }

  if (segments[0] === "me" && request.method === "GET") {
    sendJson(
      response,
      200,
      {
        email: viewer.email,
        role: viewer.role,
        isDevAuth: viewer.isDevAuth,
        isLocalAuth: viewer.isLocalAuth,
      },
    );
    return;
  }

  /* ---------------- Working-area boundary ---------------- */

  if (segments[0] === "area" && segments.length === 1) {
    if (request.method === "GET") {
      const stored = await dependencies.workspaceArea.read();

      if (!stored) {
        sendJson(
          response,
          404,
          {
            error: "Збереженої межі немає — діє межа з репозиторію.",
          },
        );
        return;
      }

      sendJson(
        response,
        200,
        stored,
      );
      return;
    }

    if (request.method === "PUT" || request.method === "POST") {
      // The boundary decides which houses exist for everybody, which is why it
      // is an admin action rather than a coordinator one.
      requireRole(
        viewer,
        "admin",
      );

      const body = await readJsonBody(request);
      const payload = "area" in body ? body.area : body;

      sendJson(
        response,
        200,
        await dependencies.workspaceArea.save(
          payload,
          viewer.email,
        ),
      );
      return;
    }

    if (request.method === "DELETE") {
      requireRole(
        viewer,
        "admin",
      );
      await dependencies.workspaceArea.clear();
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }
  }

  const database = await repository.getDatabase();

  /* ---------------- Campaigns ---------------- */

  if (segments[0] === "campaigns") {
    requireRole(
      viewer,
      "agitator",
    );

    const [, campaignId, action] = segments;

    if (!campaignId && request.method === "GET") {
      sendJson(
        response,
        200,
        listCampaigns(
          database,
          {
            includeArchived: hasAtLeast(
              viewer,
              "manager",
            ),
          },
        ),
      );
      return;
    }

    if (!campaignId && request.method === "POST") {
      requireRole(
        viewer,
        "admin",
      );

      const body = await readJsonBody(request);

      sendJson(
        response,
        201,
        await repository.withTransaction((db) =>
          createCampaign(
            db,
            body,
            {
              actor: viewer.email,
            },
          )),
      );
      return;
    }

    if (campaignId && !action && request.method === "GET") {
      const campaign = getCampaign(
        database,
        campaignId,
      );

      if (campaign.status === "archived" && !hasAtLeast(
        viewer,
        "manager",
      )) {
        throw new HttpError(
          403,
          "Архівна кампанія доступна лише менеджерам і адміністраторам.",
        );
      }

      sendJson(
        response,
        200,
        campaign,
      );
      return;
    }

    if (campaignId && !action && request.method === "PATCH") {
      requireRole(
        viewer,
        "admin",
      );

      const body = await readJsonBody(request);

      sendJson(
        response,
        200,
        await repository.withTransaction((db) =>
          updateCampaign(
            db,
            campaignId,
            body,
            {
              actor: viewer.email,
            },
          )),
      );
      return;
    }

    if (campaignId && action === "archive" && request.method === "POST") {
      requireRole(
        viewer,
        "manager",
      );
      sendJson(
        response,
        200,
        await repository.withTransaction((db) =>
          archiveCampaign(
            db,
            campaignId,
            {
              actor: viewer.email,
            },
          )),
      );
      return;
    }
  }

  /* ---------------- Precincts ---------------- */

  if (segments[0] === "precincts") {
    requireRole(
      viewer,
      "agitator",
    );

    const [, precinctId] = segments;

    if (!precinctId && request.method === "GET") {
      sendJson(
        response,
        200,
        listPrecincts(database),
      );
      return;
    }

    if (!precinctId && request.method === "POST") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);

      sendJson(
        response,
        201,
        await repository.withTransaction((db) =>
          createPrecinct(
            db,
            body,
            {
              actor: viewer.email,
            },
          )),
      );
      return;
    }

    if (precinctId && request.method === "PATCH") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);

      sendJson(
        response,
        200,
        await repository.withTransaction((db) =>
          updatePrecinct(
            db,
            precinctId,
            body,
            {
              actor: viewer.email,
            },
          )),
      );
      return;
    }

    if (precinctId && request.method === "DELETE") {
      requireRole(
        viewer,
        "admin",
      );
      await repository.withTransaction((db) =>
        deletePrecinct(
          db,
          precinctId,
          {
            actor: viewer.email,
          },
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }
  }

  if (segments[0] === "house-precincts" && segments[1] &&
    request.method === "DELETE") {
    requireRole(
      viewer,
      "coordinator",
    );
    await repository.withTransaction((db) =>
      unlinkHouseFromPrecinct(
        db,
        segments[1],
        {
          actor: viewer.email,
        },
      ));
    sendJson(
      response,
      200,
      {
        ok: true,
      },
    );
    return;
  }

  /* ---------------- Houses ---------------- */

  if (segments[0] === "houses") {
    if (await handleHouses(
      request,
      response,
      dependencies,
      viewer,
      url,
      segments,
    )) {
      return;
    }
  }

  /* ---------------- People ---------------- */

  if (segments[0] === "people") {
    const [, personId] = segments;

    if (personId && request.method === "PATCH") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);

      await repository.withTransaction((db) =>
        updatePerson(
          db,
          personId,
          body,
          {
            actor: viewer.email,
          },
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }

    if (personId && segments[2] === "links" && request.method === "POST") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);
      const id = await repository.withTransaction((db) =>
        linkPersonToHouse(
          db,
          {
            personId,
            houseId: String(body.houseId ?? ""),
            entrance: body.entrance,
            apartment: body.apartment,
            roleInHouse: body.roleInHouse,
            validFrom: body.validFrom,
            note: body.note,
          },
          {
            actor: viewer.email,
          },
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return;
    }
  }

  if (segments[0] === "person-links" && segments[1] &&
    request.method === "DELETE") {
    requireRole(
      viewer,
      "coordinator",
    );
    await repository.withTransaction((db) =>
      deletePersonLink(
        db,
        segments[1],
        {
          actor: viewer.email,
        },
      ));
    sendJson(
      response,
      200,
      {
        ok: true,
      },
    );
    return;
  }

  /* ---------------- Search (contacts, permission-aware) ---------------- */

  if (segments[0] === "search" && request.method === "GET") {
    requireRole(
      viewer,
      "agitator",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));
    const query = url.searchParams.get("q") ?? "";

    sendJson(
      response,
      200,
      searchPeople(
        database,
        query,
        // The candidate set is the viewer's own visible houses, so a phone
        // number cannot be used to discover a building they have no access to.
        listVisibleHouseIds(
          database,
          viewer,
          campaignId,
        ),
        readLimit(
          url,
          20,
        ),
      ),
    );
    return;
  }

  /* ---------------- Assignments ---------------- */

  if (segments[0] === "assignments") {
    // The assignment table maps every employee to the territory they work, so
    // it is a staffing map, not reference data. It used to answer anybody.
    requireRole(
      viewer,
      "agitator",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));

    if (request.method !== "GET") {
      await assertCampaignWritable(
        repository,
        campaignId,
      );
    }

    const [, assignmentId] = segments;

    if (!assignmentId && request.method === "GET") {
      sendJson(
        response,
        200,
        listAssignments(
          database,
          campaignId,
          {
            employeeEmail: url.searchParams.get("employee") ?? undefined,
            scopeId: url.searchParams.get("scopeId") ?? undefined,
          },
        ),
      );
      return;
    }

    if (!assignmentId && request.method === "POST") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);
      const id = await repository.withTransaction((db) =>
        createAssignment(
          db,
          campaignId,
          body,
          {
            actor: viewer.email,
            campaignId,
          },
          viewer,
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return;
    }

    if (assignmentId && request.method === "DELETE") {
      requireRole(
        viewer,
        "coordinator",
      );
      await repository.withTransaction((db) =>
        endAssignment(
          db,
          assignmentId,
          {
            actor: viewer.email,
            campaignId,
          },
          viewer,
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }
  }

  /* ---------------- Bulk operations ---------------- */

  if (segments[0] === "bulk" && request.method === "POST") {
    requireRole(
      viewer,
      "manager",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));
    const body = await readJsonBody(request);
    const houseIds = Array.isArray(body.houseIds)
      ? body.houseIds.map(String)
      : [];

    if (segments[1] === "preview") {
      // The confirmation step is served from the same place that would perform
      // the operation, so what the user confirms is what actually runs.
      const houses = listHouses(
        database,
        {
          campaignId,
          viewer,
        },
      ).filter((house) => houseIds.includes(house.id));

      sendJson(
        response,
        200,
        {
          affected: houses.length,
          requested: houseIds.length,
          houses: houses.slice(
            0,
            200,
          ).map((house) => ({
            id: house.id,
            address: house.address,
            stage: house.campaign.stage,
            assignees: house.campaign.assignees.map((a) => a.email),
          })),
        },
      );
      return;
    }

    if (segments[1] === "assign") {
      if (body.confirm !== true) {
        // A bulk write is never one click: the client has to echo an explicit
        // confirmation back, so a stray request cannot reassign a district.
        throw new HttpError(
          400,
          "Масову операцію треба підтвердити: передайте confirm: true.",
        );
      }

      const result = await repository.withTransaction((db) =>
        bulkAssignHouses(
          db,
          campaignId,
          houseIds,
          body,
          {
            actor: viewer.email,
            campaignId,
          },
        ));

      sendJson(
        response,
        200,
        result,
      );
      return;
    }
  }

  /* ---------------- Duplicates and merges ---------------- */

  if (segments[0] === "duplicates" && request.method === "GET") {
    requireRole(
      viewer,
      "manager",
    );
    sendJson(
      response,
      200,
      findDuplicateHouses(
        database,
        readLimit(
          url,
          100,
        ),
      ),
    );
    return;
  }

  if (segments[0] === "merge" && request.method === "POST") {
    requireRole(
      viewer,
      "manager",
    );

    const body = await readJsonBody(request);
    const keepId = String(body.keepId ?? "");
    const mergeId = String(body.mergeId ?? "");

    if (!keepId || !mergeId) {
      badRequest("Потрібно вказати keepId і mergeId.");
    }

    if (body.confirm !== true) {
      throw new HttpError(
        400,
        "Обʼєднання треба підтвердити: передайте confirm: true.",
      );
    }

    const entity = segments[1] === "people" ? "people" : "houses";
    const result = await repository.withTransaction((db) =>
      entity === "people"
        ? mergePeople(
          db,
          keepId,
          mergeId,
          {
            actor: viewer.email,
          },
        )
        : mergeHouses(
          db,
          keepId,
          mergeId,
          {
            actor: viewer.email,
          },
        ));

    sendJson(
      response,
      200,
      result ?? {
        ok: true,
      },
    );
    return;
  }

  /* ---------------- Activity ---------------- */

  if (
    segments[0] === "actions" || segments[0] === "issues" ||
    segments[0] === "tasks"
  ) {
    if (await handleActivity(
      request,
      response,
      dependencies,
      viewer,
      url,
      segments,
    )) {
      return;
    }
  }

  /* ---------------- Events, shifts, materials ---------------- */

  if (segments[0] === "events") {
    requireRole(
      viewer,
      "agitator",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));

    if (request.method !== "GET") {
      await assertCampaignWritable(
        repository,
        campaignId,
      );
    }

    if (!segments[1] && request.method === "GET") {
      sendJson(
        response,
        200,
        listEvents(
          database,
          campaignId,
        ),
      );
      return;
    }

    if (!segments[1] && request.method === "POST") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);
      const id = await repository.withTransaction((db) =>
        createEvent(
          db,
          campaignId,
          body,
          {
            actor: viewer.email,
            campaignId,
          },
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return;
    }

    if (segments[1] && request.method === "DELETE") {
      requireRole(
        viewer,
        "coordinator",
      );
      await repository.withTransaction((db) =>
        deleteEvent(
          db,
          segments[1],
          {
            actor: viewer.email,
            campaignId,
          },
        ));
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }
  }

  if (segments[0] === "shifts" && request.method === "POST") {
    requireRole(
      viewer,
      "coordinator",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));

    await assertCampaignWritable(
      repository,
      campaignId,
    );

    const body = await readJsonBody(request);
    const id = await repository.withTransaction((db) =>
      createShift(
        db,
        campaignId,
        body,
        {
          actor: viewer.email,
          campaignId,
        },
      ));

    sendJson(
      response,
      201,
      {
        id,
      },
    );
    return;
  }

  if (segments[0] === "materials") {
    requireRole(
      viewer,
      "coordinator",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));

    if (request.method !== "GET") {
      await assertCampaignWritable(
        repository,
        campaignId,
      );
    }

    if (request.method === "GET") {
      sendJson(
        response,
        200,
        listMaterialIssues(
          database,
          campaignId,
        ),
      );
      return;
    }

    if (request.method === "POST") {
      requireRole(
        viewer,
        "coordinator",
      );

      const body = await readJsonBody(request);
      // Resolved against the warehouse module rather than against a duplicate
      // catalogue here: an unknown id fails before anything is written.
      const item = await dependencies.warehouse.get(
        String(body.warehouseItemId ?? ""),
      );

      const id = await repository.withTransaction((db) =>
        createMaterialIssue(
          db,
          campaignId,
          body,
          {
            id: item.id,
            code: item.code,
            name: item.name,
            unit: item.unit,
          },
          {
            actor: viewer.email,
            campaignId,
          },
        ));

      sendJson(
        response,
        201,
        {
          id,
        },
      );
      return;
    }
  }

  /* ---------------- Attachments ---------------- */

  if (segments[0] === "attachments") {
    if (await handleAttachments(
      request,
      response,
      dependencies,
      viewer,
      url,
      segments,
    )) {
      return;
    }
  }

  /* ---------------- Import ---------------- */

  if (segments[0] === "import") {
    if (await handleImport(
      request,
      response,
      dependencies,
      viewer,
      url,
      segments,
    )) {
      return;
    }
  }

  /* ---------------- Export ---------------- */

  if (segments[0] === "export" && request.method === "GET") {
    requireRole(
      viewer,
      "coordinator",
    );

    const campaignId = requireCampaign(await resolveCampaignId(
      repository,
      url,
    ));
    const wantsFull = url.searchParams.get("scope") === "full";

    if (wantsFull) {
      // Personal data leaves the system only for a manager, only when asked for
      // explicitly, and never without a journal entry.
      requireRole(
        viewer,
        "manager",
      );
    }

    const houses = listHouses(
      database,
      {
        campaignId,
        viewer,
      },
    );
    const contactsByHouse = new Map<string, ExportContact[]>();

    if (wantsFull) {
      for (const house of houses) {
        const people = listHousePeople(
          database,
          house.id,
          viewer,
          true,
          {
            campaignId,
            journal: false,
          },
        );

        if (people.length > 0) {
          contactsByHouse.set(
            house.id,
            people.map((person) => ({
              houseId: house.id,
              fullName: person.fullName,
              role: person.role,
              contacts: person.contacts.map((contact) => ({
                type: contact.type,
                value: contact.value,
              })),
            })),
          );
        }
      }
    }

    const options = {
      houses,
      scope: wantsFull ? "full" as const : "operational" as const,
      contactsByHouse,
    };
    const csv = buildHousesCsv(options);

    await repository.withTransaction((db) => {
      logAccess(
        db,
        {
          kind: "export",
          actor: viewer.email,
          campaignId,
          scope: options.scope,
          reason: url.searchParams.get("reason") ?? "",
          recordCount: countExportRows(options),
          includesPersonal: wantsFull,
        },
      );
    });

    const buffer = Buffer.from(
      `﻿${csv}`,
      "utf8",
    );

    response.writeHead(
      200,
      {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": buffer.length,
        "Content-Disposition": `attachment; filename="elections-${options.scope}.csv"`,
      },
    );
    response.end(buffer);
    return;
  }

  /* ---------------- Journals ---------------- */

  if (segments[0] === "history" && request.method === "GET") {
    requireRole(
      viewer,
      "coordinator",
    );
    sendJson(
      response,
      200,
      readChangeLog(
        database,
        {
          entity: url.searchParams.get("entity") ?? undefined,
          entityId: url.searchParams.get("entityId") ?? undefined,
          batchId: url.searchParams.get("batchId") ?? undefined,
          campaignId: url.searchParams.get("campaignId") ?? undefined,
          limit: readLimit(
            url,
            200,
          ),
        },
      ),
    );
    return;
  }

  if (segments[0] === "access-log" && request.method === "GET") {
    requireRole(
      viewer,
      "admin",
    );
    sendJson(
      response,
      200,
      readAccessLog(
        database,
        {
          kind: url.searchParams.get("kind") ?? undefined,
          limit: readLimit(
            url,
            200,
          ),
        },
      ),
    );
    return;
  }

  /* ---------------- Role administration ---------------- */

  if (segments[0] === "roles") {
    if (request.method === "GET") {
      requireRole(
        viewer,
        "admin",
      );
      sendJson(
        response,
        200,
        await dependencies.employees.list(),
      );
      return;
    }

    if (request.method === "PUT" && segments[1]) {
      requireRole(
        viewer,
        "admin",
      );

      const body = await readJsonBody(request);
      const role = body.role === null || body.role === ""
        ? null
        : String(body.role);

      if (role !== null && !(ELECTIONS_ROLES as readonly string[]).includes(role)) {
        badRequest(
          `Роль має бути однією з: ${ELECTIONS_ROLES.join(", ")}.`,
        );
      }

      sendJson(
        response,
        200,
        await dependencies.employees.setRole(
          segments[1],
          role as ElectionsRole | null,
        ),
      );
      return;
    }
  }

  notFound(response);
}
