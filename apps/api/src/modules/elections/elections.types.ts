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

/**
 * Street-type words, in the spellings the archive actually uses.
 *
 * The old data mixes Ukrainian and Russian, full words and abbreviations, and
 * writes the same street as `вул. Зодчих`, `вулиця Зодчих` and `ул. Зодчих`.
 * The key has to survive all three or duplicate detection never fires — which
 * it did not: the OSM snapshot stores the long form, so every spreadsheet using
 * the short one looked like a brand-new building.
 */
const STREET_TYPE_WORDS = [
  "вулиця",
  "вулиця",
  "вулица",
  "вул",
  "улица",
  "ул",
  "street",
  "st",
  "проспект",
  "просп",
  "прт",
  "пр",
  "avenue",
  "ave",
  "провулок",
  "пров",
  "переулок",
  "пер",
  "площа",
  "площадь",
  "пл",
  "майдан",
  "бульвар",
  "бульв",
  "бр",
  "шосе",
  "шоссе",
  "ш",
  "набережна",
  "набережная",
  "наб",
  "проїзд",
  "проезд",
  "тупик",
];

/** `буд. 58`, `д.58`, `№ 58` — the number's own decorations. */
const HOUSE_NUMBER_PREFIXES = [
  "будинок",
  "буд",
  "дом",
  "д",
  "house",
  "№",
  "n",
];

/** `корп. 2`, `к.2`, `літера А` — the part after the number proper. */
const BUILDING_PART_WORDS = [
  "корпус",
  "корп",
  "кор",
  "к",
  "літера",
  "литера",
  "лит",
  "буква",
  "секція",
  "секция",
];

/**
 * Latin characters that look like Cyrillic ones and get typed instead of them.
 * `58A` (Latin A) and `58А` (Cyrillic А) are the same house to a human and two
 * different houses to a database.
 */
const LOOKALIKE_LATIN: Record<string, string> = {
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  i: "і",
  k: "к",
  m: "м",
  o: "о",
  p: "р",
  t: "т",
  x: "х",
  y: "у",
};

function stripLeadingPlace(value: string): string {
  // `м. Київ, вул. Зодчих` → `вул. Зодчих`. Only a leading settlement or region
  // component is dropped, never a trailing one.
  return value.replace(
    /^\s*(?:м|міс(?:то)?|г|гор(?:од)?|с|сел(?:о|ище)?|смт|обл(?:асть)?|район|р-н)\s*\.?\s*[^,]*,\s*/giu,
    "",
  );
}

/**
 * A street name reduced to the part that identifies it.
 *
 * Drops the settlement prefix, every street-type word wherever it sits, and all
 * punctuation, so `м. Київ, вул. Зодчих`, `вулиця Зодчих` and `Зодчих вул.` all
 * become `зодчих`.
 */
export function normalizeStreet(value: unknown): string {
  const base = normalizeText(stripLeadingPlace(String(value ?? "")));
  const words = base
    .replace(/[.,;]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !STREET_TYPE_WORDS.includes(word));

  return words.join(" ").trim();
}

/**
 * A house number reduced to a comparable token.
 *
 * `58-А`, `58 А`, `58/А`, `буд. 58а` and `58A` (Latin) all become `58а`;
 * `12 корп. 2` and `12к2` both become `12к2`.
 */
export function normalizeHouseNumber(value: unknown): string {
  let text = normalizeText(value).replace(/[.,;]/g, " ");

  for (const prefix of HOUSE_NUMBER_PREFIXES) {
    text = text.replace(
      new RegExp(`(^|\\s)${prefix}\\s*`, "gu"),
      "$1",
    );
  }

  for (const word of BUILDING_PART_WORDS) {
    text = text.replace(
      new RegExp(`(^|[\\s\\-/])${word}\\s*(?=\\d)`, "gu"),
      "$1к",
    );
  }

  return text
    .replace(/[\s\-/\\]+/g, "")
    .replace(
      /[a-z]/g,
      (character) => LOOKALIKE_LATIN[character] ?? character,
    )
    .trim();
}

/**
 * `вулиця Зодчих` + `58-А` → `зодчих|58а`, the duplicate-check key.
 *
 * Both halves are canonicalised rather than merely lowercased. The previous
 * version only lowercased, which meant the key carried whichever street-type
 * word and whichever hyphen the source happened to use, and two spellings of
 * one address never met.
 */
export function normalizeAddress(street: unknown, number: unknown): string {
  return `${normalizeStreet(street)}|${normalizeHouseNumber(number)}`;
}

/**
 * The house numbers listed in one cell, when there is more than one.
 *
 * The archive routinely puts a whole run of buildings in a single field —
 * `Зодчих 58, 60, 62` or `58 і 60`. Guessing which one the row is about is
 * exactly the kind of silent damage the import must not do, so this only
 * reports the ambiguity and the row goes to a human.
 */
export function findMultipleHouseNumbers(value: unknown): string[] {
  const text = String(value ?? "").trim();

  if (!text) {
    return [];
  }

  // `\b` is ASCII-only even under `u`, so the conjunctions are matched by the
  // whitespace around them rather than by a word boundary.
  const separated = text.split(
    /\s*(?:,|;|\+|\/{2,})\s*|\s+(?:і|й|та|и|and)\s+/giu,
  );
  const numbers = separated
    .map((part) => part.trim())
    .filter((part) => /^\d+\s*[-/]?\s*[a-zа-яіїєґ]?$/iu.test(part));

  return numbers.length > 1 ? numbers : [];
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
