import type { DatabaseSync } from "node:sqlite";

/**
 * The cross-cutting history of the "Вибори" module, plus the journal of who
 * looked at contact details and who exported data.
 *
 * Two rules make this useful rather than decorative:
 *
 *  • the author is always the identity the server resolved, never a name a
 *    client sent — the old free-text `updatedBy` field is gone;
 *  • an update writes one row per changed field, so "who cleared the phone on
 *    this house" is a single query rather than a diff of two snapshots.
 *
 * Values are stored as text. Nothing secret is written here: the recorder is
 * given the fields to log explicitly, and callers pass the working record, not
 * request bodies or headers.
 */

export type ChangeOrigin = "api" | "import" | "script" | "bulk";

export interface ChangeContext {
  /** Verified identity of whoever caused the change. */
  actor: string;
  origin?: ChangeOrigin;
  /** Import batch id or bulk-operation id — groups a whole operation. */
  batchId?: string | null;
  campaignId?: string | null;
  at?: string;
}

export interface ChangeLogEntry {
  id: number;
  entity: string;
  entityId: string;
  operation: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  changedAt: string;
  origin: string;
  batchId: string | null;
  campaignId: string | null;
}

function toStorableValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

/**
 * Long free-text fields are truncated in the journal. The history is for
 * answering "who changed this and roughly to what", and storing two full copies
 * of every note edit would grow the log faster than the data it describes.
 */
const MAX_LOGGED_VALUE_LENGTH = 2000;

function clip(value: string | null): string | null {
  if (value === null || value.length <= MAX_LOGGED_VALUE_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_LOGGED_VALUE_LENGTH)}…`;
}

function insertRow(
  database: DatabaseSync,
  context: ChangeContext,
  entity: string,
  entityId: string,
  operation: string,
  field: string | null,
  oldValue: unknown,
  newValue: unknown,
): void {
  database.prepare(`
    INSERT INTO change_log (
      entity, entity_id, operation, field, old_value, new_value,
      changed_by, changed_at, origin, batch_id, campaign_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entity,
    entityId,
    operation,
    field,
    clip(toStorableValue(oldValue)),
    clip(toStorableValue(newValue)),
    context.actor,
    context.at ?? new Date().toISOString(),
    context.origin ?? "api",
    context.batchId ?? null,
    context.campaignId ?? null,
  );
}

/** Records the creation of a record as a single row. */
export function logCreate(
  database: DatabaseSync,
  context: ChangeContext,
  entity: string,
  entityId: string,
  summary?: unknown,
): void {
  insertRow(
    database,
    context,
    entity,
    entityId,
    "create",
    null,
    null,
    summary ?? null,
  );
}

/**
 * Records an update as one row per field that actually changed. Fields whose
 * value is unchanged are skipped, so a save that touched nothing writes nothing
 * and the history stays readable.
 *
 * Returns the number of fields recorded, which callers use to decide whether an
 * update happened at all.
 */
export function logUpdate(
  database: DatabaseSync,
  context: ChangeContext,
  entity: string,
  entityId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): number {
  let changed = 0;

  for (const field of fields) {
    const oldValue = toStorableValue(before[field]);
    const newValue = toStorableValue(after[field]);

    if (oldValue === newValue) {
      continue;
    }

    insertRow(
      database,
      context,
      entity,
      entityId,
      "update",
      field,
      oldValue,
      newValue,
    );
    changed += 1;
  }

  return changed;
}

/** Soft delete, restore, merge, archive — anything that is not a field edit. */
export function logOperation(
  database: DatabaseSync,
  context: ChangeContext,
  entity: string,
  entityId: string,
  operation: string,
  detail?: unknown,
): void {
  insertRow(
    database,
    context,
    entity,
    entityId,
    operation,
    null,
    null,
    detail ?? null,
  );
}

export interface ChangeLogQuery {
  entity?: string;
  entityId?: string;
  /**
   * Any of these ids, rather than one. A house's own history is not all under
   * its id: campaign state is journalled as `<campaignId>:<houseId>`, because
   * that pair is the row's identity. Asking for the house id alone returned a
   * journal with every stage change missing from it — which is most of what
   * anybody opens the history to see.
   */
  entityIds?: string[];
  batchId?: string;
  campaignId?: string;
  limit?: number;
  /**
   * Limits the answer to the log of buildings the caller holds, plus whatever
   * they did themselves. Omitted by callers that have already established the
   * right to the rows they are asking for — `GET /houses/:id/history` resolves
   * the house through `getHouse` first, so re-filtering there would be a second
   * check of the same fact.
   */
  visibility?: ChangeLogVisibility;
}

/**
 * Who may read a journal row when the caller is below `manager`.
 *
 * The cross-cutting journal is addressed by entity id, not by house, so an
 * unrestricted read of it hands over edits made to buildings, residents and
 * imports anywhere in the district — names and old field values included. It
 * answered any coordinator before this.
 *
 * Two things are legitimately theirs: the history of a building they hold, and
 * the record of their own actions. Everything else is refused. Rows about a
 * person, a task or an import batch are not attributed to a building at all, so
 * they are reachable only through the "I did this" half — deliberately strict,
 * because guessing wrong here leaks the row itself.
 */
export interface ChangeLogVisibility {
  /** SQL predicate selecting visible houses, with `chlh` as the house alias. */
  houseSql: string;
  parameters: Record<string, unknown>;
  actorEmail: string;
}

const MAX_HISTORY_ROWS = 500;

export function readChangeLog(
  database: DatabaseSync,
  query: ChangeLogQuery,
): ChangeLogEntry[] {
  const conditions: string[] = [];
  const parameters: Record<string, unknown> = {};
  let index = 0;
  const bind = (value: unknown): string => {
    index += 1;
    const name = `p${index}`;

    parameters[name] = value;

    return `:${name}`;
  };

  if (query.entity) {
    conditions.push(`entity = ${bind(query.entity)}`);
  }

  if (query.entityId) {
    conditions.push(`entity_id = ${bind(query.entityId)}`);
  }

  if (query.entityIds && query.entityIds.length > 0) {
    conditions.push(
      `entity_id IN (${query.entityIds.map((id) => bind(id)).join(", ")})`,
    );
  }

  if (query.batchId) {
    conditions.push(`batch_id = ${bind(query.batchId)}`);
  }

  if (query.campaignId) {
    conditions.push(`campaign_id = ${bind(query.campaignId)}`);
  }

  if (query.visibility) {
    const { houseSql, actorEmail } = query.visibility;

    Object.assign(
      parameters,
      query.visibility.parameters,
    );
    conditions.push(`(
      (entity = 'house' AND EXISTS (
        SELECT 1 FROM houses chlh
        WHERE chlh.id = change_log.entity_id
          AND chlh.deleted_at IS NULL
          AND (${houseSql})
      ))
      OR LOWER(changed_by) = ${bind(actorEmail.toLowerCase())}
    )`);
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? 200)),
    MAX_HISTORY_ROWS,
  );

  const statement = database.prepare(`
    SELECT id, entity, entity_id, operation, field, old_value, new_value,
           changed_by, changed_at, origin, batch_id, campaign_id
    FROM change_log
    ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY id DESC
    LIMIT ${limit}
  `);
  // An unfiltered read binds nothing, and node:sqlite rejects an anonymous
  // object against a statement that declares no parameters.
  const rows = (Object.keys(parameters).length > 0
    ? statement.all(parameters as never)
    : statement.all()) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: Number(row.id),
    entity: String(row.entity),
    entityId: String(row.entity_id),
    operation: String(row.operation),
    field: row.field == null ? null : String(row.field),
    oldValue: row.old_value == null ? null : String(row.old_value),
    newValue: row.new_value == null ? null : String(row.new_value),
    changedBy: String(row.changed_by),
    changedAt: String(row.changed_at),
    origin: String(row.origin),
    batchId: row.batch_id == null ? null : String(row.batch_id),
    campaignId: row.campaign_id == null ? null : String(row.campaign_id),
  }));
}

/* ------------------------------------------------------------------ *
 * Access journal — reading contacts, and taking data out.
 * ------------------------------------------------------------------ */

export interface AccessLogInput {
  kind: "pii_view" | "export";
  actor: string;
  campaignId?: string | null;
  entity?: string;
  entityId?: string;
  scope?: string;
  reason?: string;
  recordCount?: number;
  includesPersonal?: boolean;
}

export function logAccess(
  database: DatabaseSync,
  input: AccessLogInput,
): void {
  database.prepare(`
    INSERT INTO access_log (
      kind, actor_email, at, campaign_id, entity, entity_id,
      scope, reason, record_count, includes_personal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.kind,
    input.actor,
    new Date().toISOString(),
    input.campaignId ?? null,
    input.entity ?? "",
    input.entityId ?? "",
    input.scope ?? "",
    input.reason ?? "",
    Math.max(0, Math.trunc(input.recordCount ?? 0)),
    input.includesPersonal ? 1 : 0,
  );
}

export interface AccessLogEntry {
  id: number;
  kind: string;
  actor: string;
  at: string;
  campaignId: string | null;
  entity: string;
  entityId: string;
  scope: string;
  reason: string;
  recordCount: number;
  includesPersonal: boolean;
}

export function readAccessLog(
  database: DatabaseSync,
  options: { limit?: number; kind?: string } = {},
): AccessLogEntry[] {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? 200)),
    MAX_HISTORY_ROWS,
  );
  const parameters: string[] = [];
  let where = "";

  if (options.kind) {
    where = "WHERE kind = ?";
    parameters.push(options.kind);
  }

  const rows = database.prepare(`
    SELECT id, kind, actor_email, at, campaign_id, entity, entity_id,
           scope, reason, record_count, includes_personal
    FROM access_log
    ${where}
    ORDER BY id DESC
    LIMIT ${limit}
  `).all(...parameters) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    actor: String(row.actor_email),
    at: String(row.at),
    campaignId: row.campaign_id == null ? null : String(row.campaign_id),
    entity: String(row.entity ?? ""),
    entityId: String(row.entity_id ?? ""),
    scope: String(row.scope ?? ""),
    reason: String(row.reason ?? ""),
    recordCount: Number(row.record_count ?? 0),
    includesPersonal: Number(row.includes_personal ?? 0) === 1,
  }));
}
