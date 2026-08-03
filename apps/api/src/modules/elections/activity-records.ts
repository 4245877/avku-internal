import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { HttpError } from "../../http/responses";
import {
  type ChangeContext,
  logCreate,
  logOperation,
  logUpdate,
} from "./change-log";
import {
  ACTION_RESULTS,
  ACTION_TYPES,
  CONFIDENTIALITY_LEVELS,
  EVENT_STATUSES,
  EVENT_TYPES,
  ISSUE_CATEGORIES,
  ISSUE_STATUSES,
  OPEN_ISSUE_STATUSES,
  OPEN_TASK_STATUSES,
  PRIORITIES,
  TASK_STATUSES,
  badRequest,
  optionalNullableText,
  optionalOneOf,
  optionalText,
  optionalTimestamp,
  requireLatitude,
  requireLongitude,
  requireOneOf,
  requireText,
  requireTimestamp,
} from "./elections.types";
import {
  activityVisibilitySql,
  type ElectionsViewer,
  hasAtLeast,
  houseVisibilitySql,
} from "./elections-access";
import { assertHouseExists } from "./house-records";

/**
 * The working records of a campaign: what was done, what is wrong, what has to
 * happen next, and where people are meeting.
 *
 * All five tables share one shape — campaign, optional house, an author from
 * the verified identity, a soft delete and a journal entry — because they
 * answer the same question at different granularities. Keeping them uniform is
 * what lets the house card show a single merged timeline.
 */

/* ------------------------------------------------------------------ *
 * Access guards shared by every mutation below
 * ------------------------------------------------------------------ */

/**
 * Refuses a record that belongs to a different campaign than the request is
 * working in.
 *
 * Without this, an id was enough: `PATCH /tasks/<id>?campaignId=<other>`
 * happily edited — and `DELETE` happily removed — a task belonging to a
 * campaign the caller was not looking at, including an archived one. The role
 * check passed because roles are global; nothing then re-checked the row.
 *
 * The answer is 404 rather than 403, for the same reason `getHouse` gives 404:
 * a 403 would confirm that a record with that id exists somewhere.
 */
export function assertRowInCampaign(
  row: Record<string, unknown>,
  campaignId: string | null | undefined,
  message: string,
): void {
  if (!campaignId) {
    return;
  }

  if (String(row.campaign_id ?? "") !== campaignId) {
    throw new HttpError(
      404,
      message,
    );
  }
}

/**
 * Refuses a record whose house the viewer may not work with.
 *
 * The role checks on the routes are coarse ("an agitator may edit tasks"). This
 * is the territorial half: an agitator may edit *their* tasks, not every task
 * in the campaign.
 */
export function assertActivityVisible(
  database: DatabaseSync,
  row: Record<string, unknown>,
  campaignId: string,
  viewer: ElectionsViewer,
  message: string,
  personColumns: string[] = [],
): void {
  if (hasAtLeast(
    viewer,
    "manager",
  )) {
    return;
  }

  const visibility = activityVisibilitySql(
    viewer,
    campaignId,
    ":guardHouseId",
    personColumns.map((_, index) => `:guardPerson${index}`),
  );
  const parameters: Record<string, unknown> = {
    ...visibility.parameters,
    guardHouseId: row.house_id == null ? null : String(row.house_id),
  };

  personColumns.forEach((column, index) => {
    const value = row[column];

    parameters[`guardPerson${index}`] = value == null
      ? null
      : String(value).toLowerCase();
  });

  const allowed = database.prepare(
    `SELECT ${visibility.sql} AS ok`,
  ).get(parameters as never) as Record<string, unknown> | undefined;

  if (!allowed || Number(allowed.ok) !== 1) {
    throw new HttpError(
      404,
      message,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export interface ActionRecord {
  id: string;
  campaignId: string;
  houseId: string | null;
  personId: string | null;
  eventId: string | null;
  type: string;
  result: string;
  happenedAt: string;
  comment: string;
  nextStep: string;
  nextActionAt: string | null;
  authorEmail: string;
  source: string;
  createdAt: string;
  attachments: AttachmentRecord[];
}

function rowToAction(row: Record<string, unknown>): ActionRecord {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    houseId: row.house_id == null ? null : String(row.house_id),
    personId: row.person_id == null ? null : String(row.person_id),
    eventId: row.event_id == null ? null : String(row.event_id),
    type: String(row.type),
    result: String(row.result),
    happenedAt: String(row.happened_at),
    comment: String(row.comment ?? ""),
    nextStep: String(row.next_step ?? ""),
    nextActionAt: row.next_action_at == null
      ? null
      : String(row.next_action_at),
    authorEmail: String(row.author_email),
    source: String(row.source ?? ""),
    createdAt: String(row.created_at),
    attachments: [],
  };
}

/**
 * The work log, limited to the houses the viewer may see.
 *
 * `viewer` is required rather than optional on purpose: this list used to be
 * campaign-wide for anybody who asked, so an agitator assigned to one building
 * could read every visit comment in the district.
 */
export function listActions(
  database: DatabaseSync,
  campaignId: string,
  viewer: ElectionsViewer,
  filters: { houseId?: string; limit?: number } = {},
): ActionRecord[] {
  const visibility = activityVisibilitySql(
    viewer,
    campaignId,
    "a.house_id",
    ["a.author_email"],
  );
  const conditions = [
    "a.campaign_id = :campaignId",
    "a.deleted_at IS NULL",
    visibility.sql,
  ];
  const parameters: Record<string, unknown> = {
    ...visibility.parameters,
    campaignId,
  };

  if (filters.houseId) {
    conditions.push("a.house_id = :filterHouseId");
    parameters.filterHouseId = filters.houseId;
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(filters.limit ?? 200)),
    500,
  );

  const rows = database.prepare(`
    SELECT a.* FROM actions a
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.happened_at DESC, a.created_at DESC
    LIMIT ${limit}
  `).all(parameters as never) as Record<string, unknown>[];

  const actions = rows.map(rowToAction);

  attachAttachments(
    database,
    "action",
    actions,
  );

  return actions;
}

export interface ActionInput {
  houseId?: unknown;
  personId?: unknown;
  eventId?: unknown;
  type?: unknown;
  result?: unknown;
  happenedAt?: unknown;
  comment?: unknown;
  nextStep?: unknown;
  nextActionAt?: unknown;
}

/**
 * Records one piece of field work.
 *
 * `author_email` comes from `context.actor` — the identity the server resolved
 * — and there is no input field for it. That is the whole difference from the
 * old `updatedBy`, which was a text box anybody could sign with any name.
 */
export function createAction(
  database: DatabaseSync,
  campaignId: string,
  input: ActionInput,
  context: ChangeContext,
): string {
  const houseId = optionalNullableText(
    input.houseId,
    "houseId",
    200,
  );

  if (houseId) {
    assertHouseExists(
      database,
      houseId,
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO actions (
      id, campaign_id, house_id, person_id, event_id, type, result,
      happened_at, comment, next_step, next_action_at, author_email,
      source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignId,
    houseId,
    optionalNullableText(
      input.personId,
      "personId",
      200,
    ),
    optionalNullableText(
      input.eventId,
      "eventId",
      200,
    ),
    requireOneOf(
      input.type,
      ACTION_TYPES,
      "type",
    ),
    requireOneOf(
      input.result,
      ACTION_RESULTS,
      "result",
    ),
    optionalTimestamp(
      input.happenedAt,
      "happenedAt",
    ) ?? now,
    optionalText(
      input.comment,
      "comment",
      4000,
    ),
    optionalText(
      input.nextStep,
      "nextStep",
      500,
    ),
    optionalTimestamp(
      input.nextActionAt,
      "nextActionAt",
    ),
    context.actor,
    "manual",
    now,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "action",
    id,
    {
      houseId,
      type: String(input.type),
      result: String(input.result),
    },
  );

  return id;
}

const ACTION_UPDATABLE = [
  "type",
  "result",
  "happenedAt",
  "comment",
  "nextStep",
  "nextActionAt",
] as const;

/**
 * Corrects a logged action.
 *
 * The log used to be append-or-delete, which meant a mistyped comment or the
 * wrong result had to be deleted and re-entered — losing the original author
 * and timestamp, and putting a gap in the history where a correction belongs.
 * `author_email` is never in the input here either: an edit does not change who
 * did the work, and the journal records who edited it separately.
 */
export function updateAction(
  database: DatabaseSync,
  actionId: string,
  input: ActionInput,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  const row = database.prepare(`
    SELECT * FROM actions WHERE id = ? AND deleted_at IS NULL
  `).get(actionId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Дію не знайдено.",
    );
  }

  assertRowInCampaign(
    row,
    context.campaignId,
    "Дію не знайдено.",
  );

  if (viewer && context.campaignId) {
    assertActivityVisible(
      database,
      row,
      context.campaignId,
      viewer,
      "Дію не знайдено.",
      ["author_email"],
    );
  }

  const before = rowToAction(row);
  const next = {
    type: input.type === undefined
      ? before.type
      : requireOneOf(
        input.type,
        ACTION_TYPES,
        "type",
      ),
    result: input.result === undefined
      ? before.result
      : requireOneOf(
        input.result,
        ACTION_RESULTS,
        "result",
      ),
    happenedAt: input.happenedAt === undefined
      ? before.happenedAt
      : (optionalTimestamp(
        input.happenedAt,
        "happenedAt",
      ) ?? before.happenedAt),
    comment: input.comment === undefined
      ? before.comment
      : optionalText(
        input.comment,
        "comment",
        4000,
      ),
    nextStep: input.nextStep === undefined
      ? before.nextStep
      : optionalText(
        input.nextStep,
        "nextStep",
        500,
      ),
    nextActionAt: input.nextActionAt === undefined
      ? before.nextActionAt
      : optionalTimestamp(
        input.nextActionAt,
        "nextActionAt",
      ),
  };

  database.prepare(`
    UPDATE actions SET
      type = ?, result = ?, happened_at = ?, comment = ?, next_step = ?,
      next_action_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.type,
    next.result,
    next.happenedAt,
    next.comment,
    next.nextStep,
    next.nextActionAt,
    new Date().toISOString(),
    actionId,
  );

  logUpdate(
    database,
    {
      ...context,
      campaignId: before.campaignId,
    },
    "action",
    actionId,
    before as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    ACTION_UPDATABLE,
  );
}

export function deleteAction(
  database: DatabaseSync,
  actionId: string,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  softDelete(
    database,
    "actions",
    "action",
    actionId,
    context,
    viewer,
    ["author_email"],
  );
}

/* ------------------------------------------------------------------ *
 * Issues
 * ------------------------------------------------------------------ */

export interface IssueRecord {
  id: string;
  campaignId: string;
  houseId: string | null;
  entrance: string;
  category: string;
  title: string;
  description: string;
  origin: string;
  priority: string;
  status: string;
  assigneeEmail: string | null;
  dueAt: string | null;
  resolution: string;
  confidentiality: string;
  openedAt: string;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  isOpen: boolean;
  attachments: AttachmentRecord[];
}

function rowToIssue(
  row: Record<string, unknown>,
  redactDescription: boolean,
): IssueRecord {
  const status = String(row.status);

  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    houseId: row.house_id == null ? null : String(row.house_id),
    entrance: String(row.entrance ?? ""),
    category: String(row.category),
    title: String(row.title),
    description: redactDescription ? "" : String(row.description ?? ""),
    origin: String(row.origin ?? ""),
    priority: String(row.priority),
    status,
    assigneeEmail: row.assignee_email == null
      ? null
      : String(row.assignee_email),
    dueAt: row.due_at == null ? null : String(row.due_at),
    resolution: String(row.resolution ?? ""),
    confidentiality: String(row.confidentiality ?? "normal"),
    openedAt: String(row.opened_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
    isOpen: (OPEN_ISSUE_STATUSES as readonly string[]).includes(status),
    attachments: [],
  };
}

export function listIssues(
  database: DatabaseSync,
  campaignId: string,
  viewer: ElectionsViewer,
  filters: { houseId?: string; status?: string; limit?: number } = {},
): IssueRecord[] {
  const visibility = activityVisibilitySql(
    viewer,
    campaignId,
    "i.house_id",
    [
      "i.assignee_email",
      "i.created_by",
    ],
  );
  const conditions = [
    "i.campaign_id = :campaignId",
    "i.deleted_at IS NULL",
    visibility.sql,
  ];
  const parameters: Record<string, unknown> = {
    ...visibility.parameters,
    campaignId,
  };

  if (filters.houseId) {
    conditions.push("i.house_id = :filterHouseId");
    parameters.filterHouseId = filters.houseId;
  }

  if (filters.status === "open") {
    conditions.push(
      `i.status IN (${OPEN_ISSUE_STATUSES.map((s) => `'${s}'`).join(", ")})`,
    );
  } else if (filters.status) {
    conditions.push("i.status = :filterStatus");
    parameters.filterStatus = filters.status;
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(filters.limit ?? 200)),
    500,
  );

  const rows = database.prepare(`
    SELECT i.* FROM issues i
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1
                    WHEN 'waiting' THEN 2 ELSE 3 END,
      COALESCE(i.due_at, i.opened_at)
    LIMIT ${limit}
  `).all(parameters as never) as Record<string, unknown>[];

  // A `restricted` issue keeps its title and status for everybody — the house
  // card still has to show that something is open — but its description is only
  // rendered for a coordinator and above.
  const canReadRestricted = hasAtLeast(
    viewer,
    "coordinator",
  );

  const issues = rows.map((row) =>
    rowToIssue(
      row,
      String(row.confidentiality ?? "normal") === "restricted" &&
        !canReadRestricted,
    ));

  attachAttachments(
    database,
    "issue",
    issues,
  );

  return issues;
}

export interface IssueInput {
  houseId?: unknown;
  entrance?: unknown;
  category?: unknown;
  title?: unknown;
  description?: unknown;
  origin?: unknown;
  priority?: unknown;
  status?: unknown;
  assigneeEmail?: unknown;
  dueAt?: unknown;
  resolution?: unknown;
  confidentiality?: unknown;
  openedAt?: unknown;
}

export function createIssue(
  database: DatabaseSync,
  campaignId: string,
  input: IssueInput,
  context: ChangeContext,
): string {
  const houseId = optionalNullableText(
    input.houseId,
    "houseId",
    200,
  );

  if (houseId) {
    assertHouseExists(
      database,
      houseId,
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO issues (
      id, campaign_id, house_id, entrance, category, title, description,
      origin, priority, status, assignee_email, due_at, resolution,
      confidentiality, opened_at, source, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'manual', ?, ?, ?)
  `).run(
    id,
    campaignId,
    houseId,
    optionalText(
      input.entrance,
      "entrance",
      20,
    ),
    requireOneOf(
      input.category,
      ISSUE_CATEGORIES,
      "category",
    ),
    requireText(
      input.title,
      "title",
      300,
    ),
    optionalText(
      input.description,
      "description",
      6000,
    ),
    optionalText(
      input.origin,
      "origin",
      200,
    ),
    optionalOneOf(
      input.priority,
      PRIORITIES,
      "priority",
      "medium",
    ),
    optionalOneOf(
      input.status,
      ISSUE_STATUSES,
      "status",
      "open",
    ),
    optionalNullableText(
      input.assigneeEmail,
      "assigneeEmail",
      320,
    ),
    optionalTimestamp(
      input.dueAt,
      "dueAt",
    ),
    optionalOneOf(
      input.confidentiality,
      CONFIDENTIALITY_LEVELS,
      "confidentiality",
      "normal",
    ),
    optionalTimestamp(
      input.openedAt,
      "openedAt",
    ) ?? now,
    context.actor,
    now,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "issue",
    id,
    {
      houseId,
      category: String(input.category),
    },
  );

  return id;
}

const ISSUE_UPDATABLE = [
  "category",
  "title",
  "description",
  "priority",
  "status",
  "assigneeEmail",
  "dueAt",
  "resolution",
  "confidentiality",
  "entrance",
] as const;

export function updateIssue(
  database: DatabaseSync,
  issueId: string,
  input: IssueInput,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  const row = database.prepare(`
    SELECT * FROM issues WHERE id = ? AND deleted_at IS NULL
  `).get(issueId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Звернення не знайдено.",
    );
  }

  assertRowInCampaign(
    row,
    context.campaignId,
    "Звернення не знайдено.",
  );

  if (viewer && context.campaignId) {
    assertActivityVisible(
      database,
      row,
      context.campaignId,
      viewer,
      "Звернення не знайдено.",
      [
        "assignee_email",
        "created_by",
      ],
    );
  }

  const before = rowToIssue(
    row,
    false,
  );
  const next = {
    category: input.category === undefined
      ? before.category
      : requireOneOf(
        input.category,
        ISSUE_CATEGORIES,
        "category",
      ),
    title: input.title === undefined
      ? before.title
      : requireText(
        input.title,
        "title",
        300,
      ),
    description: input.description === undefined
      ? before.description
      : optionalText(
        input.description,
        "description",
        6000,
      ),
    priority: input.priority === undefined
      ? before.priority
      : requireOneOf(
        input.priority,
        PRIORITIES,
        "priority",
      ),
    status: input.status === undefined
      ? before.status
      : requireOneOf(
        input.status,
        ISSUE_STATUSES,
        "status",
      ),
    assigneeEmail: input.assigneeEmail === undefined
      ? before.assigneeEmail
      : optionalNullableText(
        input.assigneeEmail,
        "assigneeEmail",
        320,
      ),
    dueAt: input.dueAt === undefined
      ? before.dueAt
      : optionalTimestamp(
        input.dueAt,
        "dueAt",
      ),
    resolution: input.resolution === undefined
      ? before.resolution
      : optionalText(
        input.resolution,
        "resolution",
        4000,
      ),
    confidentiality: input.confidentiality === undefined
      ? before.confidentiality
      : requireOneOf(
        input.confidentiality,
        CONFIDENTIALITY_LEVELS,
        "confidentiality",
      ),
    entrance: input.entrance === undefined
      ? before.entrance
      : optionalText(
        input.entrance,
        "entrance",
        20,
      ),
  };

  const now = new Date().toISOString();
  const isClosing = !(OPEN_ISSUE_STATUSES as readonly string[]).includes(
    next.status,
  );

  database.prepare(`
    UPDATE issues SET
      category = ?, title = ?, description = ?, priority = ?, status = ?,
      assignee_email = ?, due_at = ?, resolution = ?, confidentiality = ?,
      entrance = ?, updated_at = ?,
      closed_at = CASE WHEN ? = 1 THEN COALESCE(closed_at, ?) ELSE NULL END
    WHERE id = ?
  `).run(
    next.category,
    next.title,
    next.description,
    next.priority,
    next.status,
    next.assigneeEmail,
    next.dueAt,
    next.resolution,
    next.confidentiality,
    next.entrance,
    now,
    isClosing ? 1 : 0,
    now,
    issueId,
  );

  logUpdate(
    database,
    {
      ...context,
      campaignId: before.campaignId,
    },
    "issue",
    issueId,
    before as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    ISSUE_UPDATABLE,
  );
}

export function deleteIssue(
  database: DatabaseSync,
  issueId: string,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  softDelete(
    database,
    "issues",
    "issue",
    issueId,
    context,
    viewer,
    [
      "assignee_email",
      "created_by",
    ],
  );
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export interface TaskRecord {
  id: string;
  campaignId: string;
  houseId: string | null;
  houseAddress: string;
  issueId: string | null;
  eventId: string | null;
  title: string;
  description: string;
  assigneeEmail: string | null;
  dueAt: string | null;
  status: string;
  priority: string;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  isOverdue: boolean;
  isDueToday: boolean;
  isUnassigned: boolean;
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  const status = String(row.status);
  const dueAt = row.due_at == null ? null : String(row.due_at);
  const isOpen = (OPEN_TASK_STATUSES as readonly string[]).includes(status);
  const today = new Date().toISOString().slice(
    0,
    10,
  );

  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    houseId: row.house_id == null ? null : String(row.house_id),
    houseAddress: String(row.house_address ?? ""),
    issueId: row.issue_id == null ? null : String(row.issue_id),
    eventId: row.event_id == null ? null : String(row.event_id),
    title: String(row.title),
    description: String(row.description ?? ""),
    assigneeEmail: row.assignee_email == null
      ? null
      : String(row.assignee_email),
    dueAt,
    status,
    priority: String(row.priority),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    isOverdue: Boolean(isOpen && dueAt && dueAt < new Date().toISOString()),
    isDueToday: Boolean(isOpen && dueAt && dueAt.slice(
      0,
      10,
    ) === today),
    isUnassigned: isOpen && !row.assignee_email,
  };
}

export function listTasks(
  database: DatabaseSync,
  campaignId: string,
  viewer: ElectionsViewer,
  filters: {
    houseId?: string;
    assigneeEmail?: string;
    status?: string;
    scope?: "today" | "overdue" | "unassigned" | "open";
    limit?: number;
  } = {},
): TaskRecord[] {
  const visibility = activityVisibilitySql(
    viewer,
    campaignId,
    "t.house_id",
    [
      "t.assignee_email",
      "t.created_by",
    ],
  );
  const conditions = [
    "t.campaign_id = :campaignId",
    "t.deleted_at IS NULL",
    visibility.sql,
  ];
  const parameters: Record<string, unknown> = {
    ...visibility.parameters,
    campaignId,
  };
  const openList = OPEN_TASK_STATUSES.map((s) => `'${s}'`).join(", ");

  if (filters.houseId) {
    conditions.push("t.house_id = :filterHouseId");
    parameters.filterHouseId = filters.houseId;
  }

  if (filters.assigneeEmail) {
    conditions.push("t.assignee_email = :filterAssignee");
    parameters.filterAssignee = filters.assigneeEmail.toLowerCase();
  }

  if (filters.status) {
    conditions.push("t.status = :filterStatus");
    parameters.filterStatus = filters.status;
  }

  if (filters.scope === "overdue") {
    conditions.push(
      `t.status IN (${openList}) AND t.due_at IS NOT NULL AND t.due_at < :nowStamp`,
    );
    parameters.nowStamp = new Date().toISOString();
  } else if (filters.scope === "today") {
    conditions.push(
      `t.status IN (${openList}) AND substr(t.due_at, 1, 10) = :todayStamp`,
    );
    parameters.todayStamp = new Date().toISOString().slice(
      0,
      10,
    );
  } else if (filters.scope === "unassigned") {
    conditions.push(
      `t.status IN (${openList}) AND (t.assignee_email IS NULL OR t.assignee_email = '')`,
    );
  } else if (filters.scope === "open") {
    conditions.push(`t.status IN (${openList})`);
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(filters.limit ?? 200)),
    500,
  );

  const rows = database.prepare(`
    SELECT t.*, h.address AS house_address
    FROM tasks t
    LEFT JOIN houses h ON h.id = t.house_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE WHEN t.status IN (${openList}) THEN 0 ELSE 1 END,
      t.due_at IS NULL,
      t.due_at
    LIMIT ${limit}
  `).all(parameters as never) as Record<string, unknown>[];

  return rows.map(rowToTask);
}

export interface TaskInput {
  houseId?: unknown;
  issueId?: unknown;
  eventId?: unknown;
  title?: unknown;
  description?: unknown;
  assigneeEmail?: unknown;
  dueAt?: unknown;
  status?: unknown;
  priority?: unknown;
}

export function createTask(
  database: DatabaseSync,
  campaignId: string,
  input: TaskInput,
  context: ChangeContext,
): string {
  const houseId = optionalNullableText(
    input.houseId,
    "houseId",
    200,
  );

  if (houseId) {
    assertHouseExists(
      database,
      houseId,
    );
  }

  const issueId = optionalNullableText(
    input.issueId,
    "issueId",
    200,
  );

  if (issueId) {
    const issue = database.prepare(`
      SELECT id FROM issues WHERE id = ? AND deleted_at IS NULL
    `).get(issueId);

    if (!issue) {
      throw new HttpError(
        400,
        "Вказаного звернення не існує.",
      );
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO tasks (
      id, campaign_id, house_id, issue_id, event_id, title, description,
      assignee_email, due_at, status, priority, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignId,
    houseId,
    issueId,
    optionalNullableText(
      input.eventId,
      "eventId",
      200,
    ),
    requireText(
      input.title,
      "title",
      300,
    ),
    optionalText(
      input.description,
      "description",
      4000,
    ),
    optionalNullableText(
      input.assigneeEmail,
      "assigneeEmail",
      320,
    ),
    optionalTimestamp(
      input.dueAt,
      "dueAt",
    ),
    optionalOneOf(
      input.status,
      TASK_STATUSES,
      "status",
      "todo",
    ),
    optionalOneOf(
      input.priority,
      PRIORITIES,
      "priority",
      "medium",
    ),
    context.actor,
    now,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "task",
    id,
    {
      houseId,
      title: String(input.title),
    },
  );

  return id;
}

const TASK_UPDATABLE = [
  "title",
  "description",
  "assigneeEmail",
  "dueAt",
  "status",
  "priority",
] as const;

export function updateTask(
  database: DatabaseSync,
  taskId: string,
  input: TaskInput,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  const row = database.prepare(`
    SELECT t.*, '' AS house_address FROM tasks t
    WHERE t.id = ? AND t.deleted_at IS NULL
  `).get(taskId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Задачу не знайдено.",
    );
  }

  assertRowInCampaign(
    row,
    context.campaignId,
    "Задачу не знайдено.",
  );

  if (viewer && context.campaignId) {
    assertActivityVisible(
      database,
      row,
      context.campaignId,
      viewer,
      "Задачу не знайдено.",
      [
        "assignee_email",
        "created_by",
      ],
    );
  }

  const before = rowToTask(row);
  const next = {
    title: input.title === undefined
      ? before.title
      : requireText(
        input.title,
        "title",
        300,
      ),
    description: input.description === undefined
      ? before.description
      : optionalText(
        input.description,
        "description",
        4000,
      ),
    assigneeEmail: input.assigneeEmail === undefined
      ? before.assigneeEmail
      : optionalNullableText(
        input.assigneeEmail,
        "assigneeEmail",
        320,
      ),
    dueAt: input.dueAt === undefined
      ? before.dueAt
      : optionalTimestamp(
        input.dueAt,
        "dueAt",
      ),
    status: input.status === undefined
      ? before.status
      : requireOneOf(
        input.status,
        TASK_STATUSES,
        "status",
      ),
    priority: input.priority === undefined
      ? before.priority
      : requireOneOf(
        input.priority,
        PRIORITIES,
        "priority",
      ),
  };

  const now = new Date().toISOString();
  const isDone = next.status === "done";

  database.prepare(`
    UPDATE tasks SET
      title = ?, description = ?, assignee_email = ?, due_at = ?,
      status = ?, priority = ?, updated_at = ?,
      completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE NULL END
    WHERE id = ?
  `).run(
    next.title,
    next.description,
    next.assigneeEmail,
    next.dueAt,
    next.status,
    next.priority,
    now,
    isDone ? 1 : 0,
    now,
    taskId,
  );

  logUpdate(
    database,
    {
      ...context,
      campaignId: before.campaignId,
    },
    "task",
    taskId,
    before as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    TASK_UPDATABLE,
  );
}

export function deleteTask(
  database: DatabaseSync,
  taskId: string,
  context: ChangeContext,
  viewer?: ElectionsViewer,
): void {
  softDelete(
    database,
    "tasks",
    "task",
    taskId,
    context,
    viewer,
    [
      "assignee_email",
      "created_by",
    ],
  );
}

/* ------------------------------------------------------------------ *
 * Events, shifts and material hand-outs
 * ------------------------------------------------------------------ */

export interface EventRecord {
  id: string;
  campaignId: string;
  type: string;
  title: string;
  description: string;
  lat: number | null;
  lon: number | null;
  address: string;
  houseId: string | null;
  startsAt: string;
  endsAt: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
  shifts: ShiftRecord[];
}

export interface ShiftRecord {
  id: string;
  campaignId: string;
  eventId: string | null;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string;
  note: string;
  members: { id: string; email: string; role: string; status: string }[];
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    type: String(row.type),
    title: String(row.title),
    description: String(row.description ?? ""),
    lat: row.lat == null ? null : Number(row.lat),
    lon: row.lon == null ? null : Number(row.lon),
    address: String(row.address ?? ""),
    houseId: row.house_id == null ? null : String(row.house_id),
    startsAt: String(row.starts_at),
    endsAt: row.ends_at == null ? null : String(row.ends_at),
    status: String(row.status),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
    shifts: [],
  };
}

export function listEvents(
  database: DatabaseSync,
  campaignId: string,
  filters: { houseId?: string } = {},
): EventRecord[] {
  // The house filter is what makes an events *section* possible on the house
  // editor: without it the only way to show "meetings at this address" is to
  // download every event in the campaign and drop most of them in the browser.
  const rows = database.prepare(`
    SELECT * FROM events
    WHERE campaign_id = ? AND deleted_at IS NULL
      AND (? IS NULL OR house_id = ?)
    ORDER BY starts_at DESC
  `).all(
    campaignId,
    filters.houseId ?? null,
    filters.houseId ?? null,
  ) as Record<string, unknown>[];

  const events = rows.map(rowToEvent);
  const shifts = listShifts(
    database,
    campaignId,
  );

  for (const event of events) {
    event.shifts = shifts.filter((shift) => shift.eventId === event.id);
  }

  return events;
}

export interface EventInput {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  lat?: unknown;
  lon?: unknown;
  address?: unknown;
  houseId?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  status?: unknown;
}

/**
 * A meeting, a clean-up or a tent.
 *
 * It can be shown on the map and it can sit at a house's address, but it is
 * never stored as a house: it has a start and an end, and a building does not.
 */
export function createEvent(
  database: DatabaseSync,
  campaignId: string,
  input: EventInput,
  context: ChangeContext,
): string {
  const houseId = optionalNullableText(
    input.houseId,
    "houseId",
    200,
  );

  if (houseId) {
    assertHouseExists(
      database,
      houseId,
    );
  }

  const hasLat = input.lat !== undefined && input.lat !== null && input.lat !== "";
  const hasLon = input.lon !== undefined && input.lon !== null && input.lon !== "";

  if (hasLat !== hasLon) {
    badRequest("Координати події задаються парою «lat» і «lon».");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO events (
      id, campaign_id, type, title, description, lat, lon, address,
      house_id, starts_at, ends_at, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignId,
    requireOneOf(
      input.type,
      EVENT_TYPES,
      "type",
    ),
    requireText(
      input.title,
      "title",
      300,
    ),
    optionalText(
      input.description,
      "description",
      4000,
    ),
    hasLat ? requireLatitude(input.lat) : null,
    hasLon ? requireLongitude(input.lon) : null,
    optionalText(
      input.address,
      "address",
      300,
    ),
    houseId,
    requireTimestamp(
      input.startsAt,
      "startsAt",
    ),
    optionalTimestamp(
      input.endsAt,
      "endsAt",
    ),
    optionalOneOf(
      input.status,
      EVENT_STATUSES,
      "status",
      "planned",
    ),
    context.actor,
    now,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "event",
    id,
    {
      type: String(input.type),
      title: String(input.title),
    },
  );

  return id;
}

export function deleteEvent(
  database: DatabaseSync,
  eventId: string,
  context: ChangeContext,
): void {
  softDelete(
    database,
    "events",
    "event",
    eventId,
    context,
  );
}

/**
 * Whether the viewer may read an attachment.
 *
 * An attachment hanging off a house is governed by that house. One hanging off
 * an action or an event has no house to govern it, and used to be readable by
 * anybody holding the agitator role — so a photo attached to a district-wide
 * action was effectively public to the whole field team. Below coordinator,
 * such an attachment is now visible only to whoever uploaded it.
 */
export function canReadAttachment(
  database: DatabaseSync,
  attachment: { houseId: string | null; uploadedBy: string; accessLevel: string },
  campaignId: string | null,
  viewer: ElectionsViewer,
): boolean {
  if (
    attachment.accessLevel === "restricted" &&
    !hasAtLeast(
      viewer,
      "coordinator",
    )
  ) {
    return false;
  }

  if (hasAtLeast(
    viewer,
    "manager",
  )) {
    return true;
  }

  if (!attachment.houseId) {
    return attachment.uploadedBy.toLowerCase() ===
      (viewer.email ?? "").toLowerCase();
  }

  if (!campaignId) {
    return false;
  }

  const visibility = houseVisibilitySql(
    viewer,
    campaignId,
    "h",
  );
  const row = database.prepare(`
    SELECT 1 AS ok FROM houses h
    WHERE h.id = :attachmentHouseId AND h.deleted_at IS NULL
      AND ${visibility.sql}
  `).get({
    ...visibility.parameters,
    attachmentHouseId: attachment.houseId,
  } as never);

  return Boolean(row);
}

export function listShifts(
  database: DatabaseSync,
  campaignId: string,
): ShiftRecord[] {
  const rows = database.prepare(`
    SELECT * FROM shifts
    WHERE campaign_id = ? AND deleted_at IS NULL
    ORDER BY starts_at DESC
  `).all(campaignId) as Record<string, unknown>[];

  const shifts = rows.map((row) => ({
    id: String(row.id),
    campaignId: String(row.campaign_id),
    eventId: row.event_id == null ? null : String(row.event_id),
    title: String(row.title),
    startsAt: String(row.starts_at),
    endsAt: row.ends_at == null ? null : String(row.ends_at),
    location: String(row.location ?? ""),
    note: String(row.note ?? ""),
    members: [] as ShiftRecord["members"],
  }));

  if (shifts.length === 0) {
    return shifts;
  }

  const placeholders = shifts.map(() => "?").join(", ");
  const members = database.prepare(`
    SELECT id, shift_id, employee_email, role, status
    FROM shift_members WHERE shift_id IN (${placeholders})
    ORDER BY employee_email
  `).all(...shifts.map((shift) => shift.id)) as Record<string, unknown>[];

  const byShift = new Map<string, ShiftRecord["members"]>();

  for (const member of members) {
    const key = String(member.shift_id);
    const list = byShift.get(key) ?? [];

    list.push({
      id: String(member.id),
      email: String(member.employee_email),
      role: String(member.role ?? ""),
      status: String(member.status ?? "planned"),
    });
    byShift.set(
      key,
      list,
    );
  }

  for (const shift of shifts) {
    shift.members = byShift.get(shift.id) ?? [];
  }

  return shifts;
}

export interface ShiftInput {
  eventId?: unknown;
  title?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  location?: unknown;
  note?: unknown;
  members?: unknown;
}

export function createShift(
  database: DatabaseSync,
  campaignId: string,
  input: ShiftInput,
  context: ChangeContext,
): string {
  const eventId = optionalNullableText(
    input.eventId,
    "eventId",
    200,
  );

  if (eventId) {
    const event = database.prepare(`
      SELECT id FROM events WHERE id = ? AND deleted_at IS NULL
    `).get(eventId);

    if (!event) {
      throw new HttpError(
        400,
        "Вказаної події не існує.",
      );
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO shifts (
      id, campaign_id, event_id, title, starts_at, ends_at, location, note,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignId,
    eventId,
    requireText(
      input.title,
      "title",
      300,
    ),
    requireTimestamp(
      input.startsAt,
      "startsAt",
    ),
    optionalTimestamp(
      input.endsAt,
      "endsAt",
    ),
    optionalText(
      input.location,
      "location",
      300,
    ),
    optionalText(
      input.note,
      "note",
      2000,
    ),
    context.actor,
    now,
    now,
  );

  const members = Array.isArray(input.members) ? input.members : [];

  for (const member of members.slice(
    0,
    100,
  )) {
    const record = (member ?? {}) as Record<string, unknown>;
    const email = requireText(
      record.email,
      "members[].email",
      320,
    ).toLowerCase();

    database.prepare(`
      INSERT INTO shift_members (
        id, shift_id, employee_email, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shift_id, employee_email) DO UPDATE SET
        role = excluded.role, status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      randomUUID(),
      id,
      email,
      optionalText(
        record.role,
        "members[].role",
        100,
      ),
      optionalText(
        record.status,
        "members[].status",
        40,
      ) || "planned",
      now,
      now,
    );
  }

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "shift",
    id,
    {
      title: String(input.title),
      memberCount: members.length,
    },
  );

  return id;
}

export interface MaterialIssueRecord {
  id: string;
  campaignId: string;
  warehouseItemId: string;
  warehouseItemCode: string;
  warehouseItemName: string;
  quantity: number;
  unit: string;
  issuedToEmail: string;
  issuedToName: string;
  houseId: string | null;
  eventId: string | null;
  issuedAt: string;
  note: string;
  createdBy: string;
}

export function listMaterialIssues(
  database: DatabaseSync,
  campaignId: string,
): MaterialIssueRecord[] {
  const rows = database.prepare(`
    SELECT * FROM material_issues
    WHERE campaign_id = ? AND deleted_at IS NULL
    ORDER BY issued_at DESC
  `).all(campaignId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: String(row.id),
    campaignId: String(row.campaign_id),
    warehouseItemId: String(row.warehouse_item_id),
    warehouseItemCode: String(row.warehouse_item_code ?? ""),
    warehouseItemName: String(row.warehouse_item_name ?? ""),
    quantity: Number(row.quantity),
    unit: String(row.unit ?? ""),
    issuedToEmail: String(row.issued_to_email ?? ""),
    issuedToName: String(row.issued_to_name ?? ""),
    houseId: row.house_id == null ? null : String(row.house_id),
    eventId: row.event_id == null ? null : String(row.event_id),
    issuedAt: String(row.issued_at),
    note: String(row.note ?? ""),
    createdBy: String(row.created_by ?? ""),
  }));
}

export interface MaterialIssueInput {
  warehouseItemId?: unknown;
  quantity?: unknown;
  issuedToEmail?: unknown;
  issuedToName?: unknown;
  houseId?: unknown;
  eventId?: unknown;
  issuedAt?: unknown;
  note?: unknown;
}

/**
 * Records a hand-out of campaign material.
 *
 * The item comes from the existing warehouse module: this table stores its id,
 * and copies the code, name and unit only so the list reads without a second
 * lookup. No parallel catalogue is created — the caller resolves the item
 * against `WarehouseRepository` before this runs, so an unknown id never lands.
 */
export function createMaterialIssue(
  database: DatabaseSync,
  campaignId: string,
  input: MaterialIssueInput,
  resolvedItem: { id: string; code: string; name: string; unit: string },
  context: ChangeContext,
): string {
  const quantity = Number(input.quantity);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    badRequest("Поле «quantity» має бути додатним цілим числом.");
  }

  const houseId = optionalNullableText(
    input.houseId,
    "houseId",
    200,
  );

  if (houseId) {
    assertHouseExists(
      database,
      houseId,
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  database.prepare(`
    INSERT INTO material_issues (
      id, campaign_id, warehouse_item_id, warehouse_item_code,
      warehouse_item_name, quantity, unit, issued_to_email, issued_to_name,
      house_id, event_id, issued_at, note, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignId,
    resolvedItem.id,
    resolvedItem.code,
    resolvedItem.name,
    quantity,
    resolvedItem.unit,
    optionalText(
      input.issuedToEmail,
      "issuedToEmail",
      320,
    ).toLowerCase(),
    optionalText(
      input.issuedToName,
      "issuedToName",
      200,
    ),
    houseId,
    optionalNullableText(
      input.eventId,
      "eventId",
      200,
    ),
    optionalTimestamp(
      input.issuedAt,
      "issuedAt",
    ) ?? now,
    optionalText(
      input.note,
      "note",
      1000,
    ),
    context.actor,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId,
    },
    "materialIssue",
    id,
    {
      warehouseItemId: resolvedItem.id,
      quantity,
    },
  );

  return id;
}

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

export interface AttachmentRecord {
  id: string;
  ownerType: string;
  ownerId: string;
  houseId: string | null;
  kind: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  accessLevel: string;
  note: string;
  uploadedBy: string;
  createdAt: string;
  url: string;
}

function rowToAttachment(row: Record<string, unknown>): AttachmentRecord {
  const id = String(row.id);

  return {
    id,
    ownerType: String(row.owner_type),
    ownerId: String(row.owner_id),
    houseId: row.house_id == null ? null : String(row.house_id),
    kind: String(row.kind),
    fileName: String(row.file_name),
    contentType: String(row.content_type ?? ""),
    byteSize: Number(row.byte_size ?? 0),
    accessLevel: String(row.access_level ?? "team"),
    note: String(row.note ?? ""),
    uploadedBy: String(row.uploaded_by),
    createdAt: String(row.created_at),
    url: `/api/elections/attachments/${encodeURIComponent(id)}/file`,
  };
}

export function listAttachments(
  database: DatabaseSync,
  ownerType: string,
  ownerIds: string[],
): Map<string, AttachmentRecord[]> {
  const grouped = new Map<string, AttachmentRecord[]>();

  if (ownerIds.length === 0) {
    return grouped;
  }

  const placeholders = ownerIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT * FROM attachments
    WHERE owner_type = ? AND owner_id IN (${placeholders})
      AND deleted_at IS NULL
    ORDER BY created_at DESC
  `).all(
    ownerType,
    ...ownerIds,
  ) as Record<string, unknown>[];

  for (const row of rows) {
    const key = String(row.owner_id);
    const list = grouped.get(key) ?? [];

    list.push(rowToAttachment(row));
    grouped.set(
      key,
      list,
    );
  }

  return grouped;
}

function attachAttachments<T extends { id: string; attachments: AttachmentRecord[] }>(
  database: DatabaseSync,
  ownerType: string,
  records: T[],
): void {
  if (records.length === 0) {
    return;
  }

  const grouped = listAttachments(
    database,
    ownerType,
    records.map((record) => record.id),
  );

  for (const record of records) {
    record.attachments = grouped.get(record.id) ?? [];
  }
}

export function findAttachment(
  database: DatabaseSync,
  attachmentId: string,
): (AttachmentRecord & { storedName: string }) | null {
  const row = database.prepare(`
    SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL
  `).get(attachmentId) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    ...rowToAttachment(row),
    storedName: String(row.stored_name),
  };
}

export interface AttachmentInput {
  ownerType: string;
  ownerId: string;
  houseId: string | null;
  campaignId: string | null;
  kind: string;
  fileName: string;
  storedName: string;
  contentType: string;
  byteSize: number;
  accessLevel: string;
  note: string;
}

export function insertAttachment(
  database: DatabaseSync,
  input: AttachmentInput,
  context: ChangeContext,
): string {
  const id = randomUUID();

  database.prepare(`
    INSERT INTO attachments (
      id, campaign_id, owner_type, owner_id, house_id, kind, file_name,
      stored_name, content_type, byte_size, access_level, note,
      uploaded_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.campaignId,
    input.ownerType,
    input.ownerId,
    input.houseId,
    input.kind,
    input.fileName,
    input.storedName,
    input.contentType,
    input.byteSize,
    input.accessLevel,
    input.note,
    context.actor,
    new Date().toISOString(),
  );

  logCreate(
    database,
    context,
    "attachment",
    id,
    {
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      kind: input.kind,
    },
  );

  return id;
}

/**
 * Removes an attachment, but only one the caller could have read.
 *
 * Reading an attachment goes through {@link canReadAttachment}; deleting one
 * used to go through nothing at all, so a coordinator could destroy a photo
 * belonging to a building in somebody else's territory by id alone. The same
 * predicate now guards both, and an attachment the caller cannot read answers
 * as if it did not exist.
 */
export function deleteAttachment(
  database: DatabaseSync,
  attachmentId: string,
  context: ChangeContext,
  viewer: ElectionsViewer,
  campaignId: string | null,
): void {
  const attachment = findAttachment(
    database,
    attachmentId,
  );

  if (
    !attachment || !canReadAttachment(
      database,
      attachment,
      campaignId,
      viewer,
    )
  ) {
    throw new HttpError(
      404,
      "Запис не знайдено.",
    );
  }

  softDelete(
    database,
    "attachments",
    "attachment",
    attachmentId,
    context,
  );
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const SOFT_DELETABLE = new Set([
  "actions",
  "issues",
  "tasks",
  "events",
  "shifts",
  "attachments",
  "material_issues",
]);

/**
 * Nothing in this module is removed with `DELETE`. A row that disappears takes
 * the answer to "who deleted it" with it, which is exactly the question the
 * history is for.
 */
function softDelete(
  database: DatabaseSync,
  table: string,
  entity: string,
  id: string,
  context: ChangeContext,
  viewer?: ElectionsViewer,
  personColumns: string[] = [],
): void {
  if (!SOFT_DELETABLE.has(table)) {
    throw new Error(`Table ${table} is not soft-deletable.`);
  }

  const selected = [
    "id",
    "campaign_id",
    ...(table === "attachments" || table === "shifts" ? [] : ["house_id"]),
    ...personColumns,
  ].join(", ");
  const row = database.prepare(`
    SELECT ${selected} FROM ${table} WHERE id = ? AND deleted_at IS NULL
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Запис не знайдено.",
    );
  }

  assertRowInCampaign(
    row,
    context.campaignId,
    "Запис не знайдено.",
  );

  if (viewer && context.campaignId && "house_id" in row) {
    assertActivityVisible(
      database,
      row,
      context.campaignId,
      viewer,
      "Запис не знайдено.",
      personColumns,
    );
  }

  const now = new Date().toISOString();
  const hasUpdatedAt = table !== "material_issues" && table !== "attachments";

  database.prepare(`
    UPDATE ${table}
    SET deleted_at = ?${hasUpdatedAt ? ", updated_at = ?" : ""}
    WHERE id = ?
  `).run(
    ...(hasUpdatedAt
      ? [
        now,
        now,
        id,
      ]
      : [
        now,
        id,
      ]),
  );

  logOperation(
    database,
    {
      ...context,
      campaignId: row.campaign_id == null ? null : String(row.campaign_id),
    },
    entity,
    id,
    "delete",
  );
}
