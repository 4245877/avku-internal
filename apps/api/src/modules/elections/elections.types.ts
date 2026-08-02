/**
 * Server-authoritative vocabulary for the "Вибори" module.
 *
 * Every status, stage, category and role the API accepts is listed here and
 * validated here. The client ships the same lists for its labels, but nothing
 * the client sends is trusted: a stage, a result or a role that is not in these
 * tables is rejected with 400 rather than written through.
 *
 * Two things are deliberately absent and must stay absent: a resident's
 * political position and their age band. They were removed from the module in
 * this change (see `docs/elections-audit-and-plan.md` §4.1) — a person is
 * recorded only as a contact with a working role.
 */

import { HttpError } from "../../http/responses";

/** Where a house stands in one campaign's field work. Colour on the map. */
export const WORK_STAGES = [
  "not_started",
  "contact_setup",
  "in_progress",
  "revisit_needed",
  "done",
  "blocked",
  "not_applicable",
] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

/**
 * Legacy `canvassStatus` values → the shared stage vocabulary. The old list had
 * no equivalent of "revisit needed" or "not applicable", so nothing maps onto
 * them; they only ever arrive from new work.
 */
export const LEGACY_STAGE_MAP: Record<string, WorkStage> = {
  planned: "not_started",
  inProgress: "in_progress",
  done: "done",
  refused: "blocked",
};

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CAMPAIGN_STATUSES = ["draft", "active", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const ACTION_TYPES = [
  "call",
  "visit",
  "meeting",
  "material",
  "comment",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_RESULTS = [
  "contacted",
  "no_answer",
  "refused",
  "scheduled",
  "materials_left",
  "info_only",
] as const;
export type ActionResult = (typeof ACTION_RESULTS)[number];

export const ISSUE_CATEGORIES = [
  "utilities",
  "yard",
  "lighting",
  "roof",
  "elevator",
  "waste",
  "road",
  "safety",
  "social",
  "other",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const ISSUE_STATUSES = [
  "open",
  "in_progress",
  "waiting",
  "resolved",
  "rejected",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Issue statuses that still count as open work on a house. */
export const OPEN_ISSUE_STATUSES: readonly IssueStatus[] = [
  "open",
  "in_progress",
  "waiting",
];

/**
 * `restricted` hides an issue's description from anyone below `coordinator`.
 * It is a confidentiality flag on a neighbourhood problem, not a category of
 * person — nothing about a resident is ever classified here.
 */
export const CONFIDENTIALITY_LEVELS = ["normal", "restricted"] as const;
export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVELS)[number];

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Task statuses that can still be due or overdue. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress"];

/**
 * A contact's working role in the building. Every value describes a function
 * somebody performs, which is the only reason the module holds a name at all.
 */
export const PERSON_ROLES = [
  "osbb_head",
  "building_elder",
  "entrance_elder",
  "concierge",
  "activist",
  "coordinator",
  "manager_org",
  "other",
] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const CONTACT_TYPES = [
  "phone",
  "email",
  "telegram",
  "viber",
  "other",
] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const EVENT_TYPES = [
  "meeting",
  "cleanup",
  "tent",
  "temporary_point",
  "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ["planned", "active", "done", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ASSIGNMENT_SCOPES = ["house", "precinct"] as const;
export type AssignmentScope = (typeof ASSIGNMENT_SCOPES)[number];

export const ASSIGNMENT_ROLES = [
  "agitator",
  "coordinator",
  "observer",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ASSIGNMENT_STATUSES = ["active", "ended"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const HOUSE_TYPES = [
  "apartments",
  "private",
  "dormitory",
  "public",
  "commercial",
  "other",
] as const;
export type HouseType = (typeof HOUSE_TYPES)[number];

export const ATTACHMENT_KINDS = ["photo", "document", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * Who may read an attachment. `restricted` is for anything a field worker has
 * no business seeing; personnel, legal and financial documents do not belong in
 * this module at all and are refused by the upload route.
 */
export const ATTACHMENT_ACCESS_LEVELS = ["team", "restricted"] as const;
export type AttachmentAccessLevel = (typeof ATTACHMENT_ACCESS_LEVELS)[number];

/** Records an attachment can hang off. */
export const ATTACHMENT_OWNER_TYPES = [
  "house",
  "action",
  "issue",
  "task",
  "event",
  "person",
] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

export const IMPORT_BATCH_KINDS = [
  "legacy_local",
  "csv",
  "osm",
  "manual",
] as const;
export type ImportBatchKind = (typeof IMPORT_BATCH_KINDS)[number];

export const IMPORT_BATCH_STATUSES = [
  "draft",
  "previewed",
  "applied",
  "rolled_back",
  "failed",
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_ROW_STATUSES = [
  "pending",
  "ready",
  "needs_review",
  "applied",
  "skipped",
  "failed",
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const IMPORT_ROW_DECISIONS = ["create", "merge", "skip", "review"] as const;
export type ImportRowDecision = (typeof IMPORT_ROW_DECISIONS)[number];

/**
 * Fields the module refuses to store, whatever the source.
 *
 * The first two are the political-profiling fields this change removes; the
 * rest are categories the request lists as out of scope for a canvassing tool.
 * The importer counts how many values it dropped and never logs or reports what
 * they contained.
 */
export const FORBIDDEN_IMPORT_FIELDS: readonly string[] = [
  "stance",
  "agegroup",
  "age_group",
  "political",
  "politics",
  "party",
  "partymember",
  "party_member",
  "passport",
  "passportnumber",
  "passport_number",
  "criminal",
  "conviction",
  "signature",
  "payment",
  "salary",
  "payout",
  "birthdate",
  "birthday",
  "dateofbirth",
  "date_of_birth",
  "dob",
];

const FORBIDDEN_LOOKUP = new Set(FORBIDDEN_IMPORT_FIELDS);

/** True when a source column must never reach a working table. */
export function isForbiddenField(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, "_");

  return (
    FORBIDDEN_LOOKUP.has(key) || FORBIDDEN_LOOKUP.has(key.replace(/_/g, ""))
  );
}

/**
 * Strips every forbidden field from a raw record.
 *
 * Returns the surviving values and a *count* of what was dropped. The count is
 * deliberately all the caller gets: the import report is allowed to say "12
 * fields cleaned", never which values they were.
 */
export function stripForbiddenFields(
  record: Record<string, unknown>,
): { value: Record<string, unknown>; cleanedCount: number } {
  const value: Record<string, unknown> = {};
  let cleanedCount = 0;

  for (const [key, entry] of Object.entries(record)) {
    if (isForbiddenField(key)) {
      // Only a non-empty value counts as something that had to be removed;
      // an empty column present in every row is not a finding worth reporting.
      if (entry !== null && entry !== undefined && String(entry).trim() !== "") {
        cleanedCount += 1;
      }

      continue;
    }

    value[key] = entry;
  }

  return {
    value,
    cleanedCount,
  };
}

/* ------------------------------------------------------------------ *
 * Validation helpers shared by every write route.
 * ------------------------------------------------------------------ */

export function badRequest(message: string): never {
  throw new HttpError(
    400,
    message,
  );
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const candidate = typeof value === "string" ? value.trim() : "";

  if (!(allowed as readonly string[]).includes(candidate)) {
    badRequest(
      `Поле «${field}» має бути одним із: ${allowed.join(", ")}.`,
    );
  }

  return candidate as T;
}

export function optionalOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return requireOneOf(
    value,
    allowed,
    field,
  );
}

export function requireText(
  value: unknown,
  field: string,
  maxLength = 500,
): string {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text) {
    badRequest(`Поле «${field}» обовʼязкове.`);
  }

  if (text.length > maxLength) {
    badRequest(
      `Поле «${field}» задовге (максимум ${maxLength} символів).`,
    );
  }

  return text;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength = 4000,
): string {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value).trim();

  if (text.length > maxLength) {
    badRequest(
      `Поле «${field}» задовге (максимум ${maxLength} символів).`,
    );
  }

  return text;
}

export function optionalNullableText(
  value: unknown,
  field: string,
  maxLength = 4000,
): string | null {
  const text = optionalText(
    value,
    field,
    maxLength,
  );

  return text === "" ? null : text;
}

export function optionalCount(
  value: unknown,
  field: string,
  max: number,
): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    badRequest(`Поле «${field}» має бути цілим невідʼємним числом.`);
  }

  if (parsed > max) {
    badRequest(`Поле «${field}»: значення завелике (максимум ${max}).`);
  }

  return parsed;
}

/**
 * ISO-8601 instant or date. Stored as given after a parse check, so a date-only
 * value (`2026-05-12`) stays date-only instead of acquiring a midnight in a
 * timezone nobody chose.
 */
export function optionalTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const text = String(value).trim();

  if (Number.isNaN(Date.parse(text))) {
    badRequest(`Поле «${field}» має бути датою у форматі ISO-8601.`);
  }

  return text;
}

export function requireTimestamp(
  value: unknown,
  field: string,
): string {
  const parsed = optionalTimestamp(
    value,
    field,
  );

  if (!parsed) {
    badRequest(`Поле «${field}» обовʼязкове.`);
  }

  return parsed;
}

export function requireLatitude(value: unknown, field = "lat"): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < -90 || parsed > 90) {
    badRequest(`Поле «${field}» має бути широтою в діапазоні −90…90.`);
  }

  return parsed;
}

export function requireLongitude(value: unknown, field = "lon"): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < -180 || parsed > 180) {
    badRequest(`Поле «${field}» має бути довготою в діапазоні −180…180.`);
  }

  return parsed;
}

/* ------------------------------------------------------------------ *
 * Normalisation — the keys duplicate detection and search run on.
 * ------------------------------------------------------------------ */

/**
 * Lowercases and drops the apostrophe variants Ukrainian input mixes freely.
 * Mirrors `normalizeText` in the web module so a house found by the client's
 * search is the same house the server's duplicate check would match.
 */
export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[ʼ'’`ʹ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `вулиця Зодчих` + `58-А` → `вулиця зодчих|58-а`, the duplicate-check key. */
export function normalizeAddress(street: unknown, number: unknown): string {
  return `${normalizeText(street)}|${normalizeText(number)}`;
}

/**
 * Phone → E.164-ish digits, for duplicate detection and search.
 *
 * Ukrainian numbers are written half a dozen ways (`067…`, `+38067…`,
 * `38 (067) …`), and a contact typed one way must be findable by any other. A
 * value that is not a plausible phone at all is returned digit-stripped rather
 * than rejected — the record still has to be storable.
 */
export function normalizePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.length === 10 && digits.startsWith("0")) {
    return `+38${digits}`;
  }

  if (digits.length === 12 && digits.startsWith("380")) {
    return `+${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("80")) {
    return `+3${digits}`;
  }

  return `+${digits}`;
}

/** Normalised form of any contact value, by channel. */
export function normalizeContactValue(
  type: ContactType,
  value: unknown,
): string {
  if (type === "phone" || type === "viber") {
    return normalizePhone(value);
  }

  if (type === "email") {
    return String(value ?? "").trim().toLowerCase();
  }

  if (type === "telegram") {
    return String(value ?? "").trim().toLowerCase().replace(/^@/, "");
  }

  return normalizeText(value);
}
