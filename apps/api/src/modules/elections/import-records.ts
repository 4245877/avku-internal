import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { HttpError } from "../../http/responses";
import {
  type ChangeContext,
  logCreate,
  logOperation,
} from "./change-log";
import {
  IMPORT_BATCH_KINDS,
  IMPORT_ROW_DECISIONS,
  type ImportBatchKind,
  type ImportRowDecision,
  LEGACY_STAGE_MAP,
  PERSON_ROLES,
  PRIORITIES,
  WORK_STAGES,
  badRequest,
  isForbiddenField,
  findMultipleHouseNumbers,
  normalizeAddress,
  normalizePhone,
  normalizeText,
  requireOneOf,
  stripForbiddenFields,
} from "./elections.types";
import { createAction } from "./activity-records";
import { createPerson, linkPersonToHouse } from "./people-records";

/**
 * Staging area for imported data.
 *
 * The rule the request sets is simple and absolute: nothing goes straight from
 * a file into a working table. A file becomes `import_rows` first — one row
 * per source row, original text preserved verbatim and never edited — then a
 * preview normalises addresses and phones *beside* the original, then a person
 * decides row by row, and only then does one transaction write the working
 * records.
 *
 * Two properties fall out of that and are the reason for the extra table:
 *
 *  • every created or updated record is recorded in `import_effects`, so a
 *    batch is reversible by id rather than by hand;
 *  • a row that could not be matched is `needs_review`, never silently dropped.
 *
 * Forbidden columns (political position, age band, passport, party membership,
 * payments…) are stripped during normalisation. The batch reports *how many*
 * values were removed and never what they were.
 */

export interface ImportBatch {
  id: string;
  campaignId: string | null;
  kind: string;
  fileName: string;
  status: string;
  totalRows: number;
  cleanedFieldsCount: number;
  report: ImportReport | null;
  createdBy: string;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

export interface ImportReport {
  created: number;
  updated: number;
  merged: number;
  skipped: number;
  needsReview: number;
  failed: number;
  cleanedFields: number;
  /** Rows whose address could not be matched to a house, by original text. */
  unmatchedAddresses: string[];
}

export interface NormalizedRow {
  street: string;
  number: string;
  addressNormalized: string;
  addressText: string;
  lat: number | null;
  lon: number | null;
  stage: string | null;
  priority: string | null;
  entrances: number | null;
  apartments: number | null;
  accessNote: string;
  surveyedAt: string | null;
  contactName: string;
  contactRole: string;
  phone: string;
  phoneNormalized: string;
  /** Free text kept for a human to classify. Never auto-converted. */
  freeText: string;
  osmType: string | null;
  osmId: number | null;
  /** Set when one cell listed several buildings; forces manual review. */
  multipleHouseNumbers?: string[];
}

export interface ImportRow {
  id: string;
  batchId: string;
  rowNumber: number;
  raw: unknown;
  normalized: NormalizedRow | null;
  status: string;
  decision: string | null;
  matchHouseId: string | null;
  matchPersonId: string | null;
  matchConfidence: string;
  notes: string[];
  createdEntityType: string | null;
  createdEntityId: string | null;
  cleanedFieldsCount: number;
  /** Candidate houses this row might be, for the reviewer to choose from. */
  candidates?: {
    id: string;
    address: string;
    reason: string;
  }[];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) {
    return fallback;
  }

  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Restores a count from a JSON pre-image, where every value is `unknown`. */
function toNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function rowToBatch(row: Record<string, unknown>): ImportBatch {
  return {
    id: String(row.id),
    campaignId: row.campaign_id == null ? null : String(row.campaign_id),
    kind: String(row.kind),
    fileName: String(row.file_name ?? ""),
    status: String(row.status),
    totalRows: Number(row.total_rows ?? 0),
    cleanedFieldsCount: Number(row.cleaned_fields_count ?? 0),
    report: parseJson<ImportReport | null>(
      row.report,
      null,
    ),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
    appliedAt: row.applied_at == null ? null : String(row.applied_at),
    rolledBackAt: row.rolled_back_at == null
      ? null
      : String(row.rolled_back_at),
  };
}

function rowToImportRow(row: Record<string, unknown>): ImportRow {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    rowNumber: Number(row.row_number),
    raw: parseJson<unknown>(
      row.raw,
      null,
    ),
    normalized: parseJson<NormalizedRow | null>(
      row.normalized,
      null,
    ),
    status: String(row.status),
    decision: row.decision == null ? null : String(row.decision),
    matchHouseId: row.match_house_id == null
      ? null
      : String(row.match_house_id),
    matchPersonId: row.match_person_id == null
      ? null
      : String(row.match_person_id),
    matchConfidence: String(row.match_confidence ?? ""),
    notes: parseJson<string[]>(
      row.notes,
      [],
    ),
    createdEntityType: row.created_entity_type == null
      ? null
      : String(row.created_entity_type),
    createdEntityId: row.created_entity_id == null
      ? null
      : String(row.created_entity_id),
    cleanedFieldsCount: Number(row.cleaned_fields_count ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * Header aliases seen in field spreadsheets. Matching is on the normalised
 * header, so case, apostrophes and extra spaces do not matter.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  street: [
    "вулиця",
    "вулица",
    "улица",
    "street",
    "вул",
  ],
  number: [
    "будинок",
    "буд",
    "номер",
    "дом",
    "number",
    "housenumber",
    "№",
  ],
  address: [
    "адреса",
    "адрес",
    "address",
    "повна адреса",
  ],
  lat: [
    "lat",
    "широта",
    "latitude",
  ],
  lon: [
    "lon",
    "lng",
    "довгота",
    "longitude",
  ],
  stage: [
    "етап",
    "статус",
    "стан обходу",
    "stage",
    "status",
  ],
  priority: [
    "пріоритет",
    "приоритет",
    "priority",
  ],
  entrances: [
    "підїзди",
    "підʼїзди",
    "подъезды",
    "entrances",
  ],
  apartments: [
    "квартири",
    "квартир",
    "квартиры",
    "apartments",
  ],
  contactName: [
    "контакт",
    "контактна особа",
    "піб",
    "фио",
    "имя",
    "name",
    "contact",
  ],
  contactRole: [
    "роль",
    "посада",
    "role",
  ],
  phone: [
    "телефон",
    "phone",
    "моб",
    "мобільний",
    "tel",
  ],
  note: [
    "примітка",
    "примітки",
    "нотатки",
    "коментар",
    "note",
    "notes",
    "comment",
  ],
  surveyedAt: [
    "дата",
    "дата обходу",
    "date",
    "visited",
  ],
  accessNote: [
    "доступ",
    "домофон",
    "access",
  ],
};

function pick(
  record: Record<string, unknown>,
  key: string,
): string {
  const aliases = COLUMN_ALIASES[key] ?? [];

  for (const [column, value] of Object.entries(record)) {
    const normalizedColumn = normalizeText(column);

    if (
      normalizedColumn === normalizeText(key) ||
      aliases.some((alias) => normalizedColumn === normalizeText(alias))
    ) {
      const text = String(value ?? "").trim();

      if (text) {
        return text;
      }
    }
  }

  return "";
}

/**
 * Free-text role labels seen in the old data and in field spreadsheets → the
 * shared `PERSON_ROLES` vocabulary.
 *
 * Matching is on the normalised text and is deliberately conservative: a label
 * that is not recognised becomes `other` and keeps its original wording in the
 * person's note, rather than being guessed into a role somebody will later act
 * on.
 */
const ROLE_LABEL_HINTS: [RegExp, string][] = [
  [/голов[аи].*осбб|осбб.*голов/, "osbb_head"],
  [/старш(ий|а).*(під|под).?(їзд|езд)|старш(ий|а) по (під|под)/, "entrance_elder"],
  [/старш(ий|а).*(будинк|дом)|старш(ий|а) по (будинк|дом)/, "building_elder"],
  [/консьєрж|консьерж|вахтер/, "concierge"],
  [/активіст|активист/, "activist"],
  [/координатор/, "coordinator"],
  [/жек|керуюч|управляюч|управител/, "manager_org"],
];

export function matchPersonRole(label: unknown): string {
  const text = normalizeText(label);

  if (!text) {
    return "other";
  }

  if ((PERSON_ROLES as readonly string[]).includes(text)) {
    return text;
  }

  for (const [pattern, role] of ROLE_LABEL_HINTS) {
    if (pattern.test(text)) {
      return role;
    }
  }

  return "other";
}

/**
 * `вул. Зодчих, 58-А` → `{ street, number }`.
 *
 * Three things the first version got wrong, all of them present in the archive:
 *
 *  • a leading settlement (`м. Київ, вул. Зодчих, 58`) made the *street* the
 *    last-but-one comma field, so the city ended up inside the street name;
 *  • `\w` does not match Cyrillic without the `u` flag, so `Зодчих 58а` parsed
 *    as a street called "Зодчих 58а" with no number at all;
 *  • `буд. 58` kept the `буд.` in the number.
 */
export function splitAddress(text: string): { street: string; number: string } {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      street: "",
      number: "",
    };
  }

  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  // Work from the right: the last field that looks like a house number is the
  // number, and everything before it that is not a settlement is the street.
  const numberIndex = parts.findLastIndex((part) => HOUSE_NUMBER_RE.test(part));

  if (numberIndex > 0) {
    const street = parts
      .slice(
        0,
        numberIndex,
      )
      .filter((part) => !SETTLEMENT_RE.test(part))
      .join(", ")
      .trim();

    return {
      street: street || parts.slice(
        0,
        numberIndex,
      ).join(", ").trim(),
      number: stripNumberPrefix(parts[numberIndex]),
    };
  }

  const single = parts.length > 1
    ? parts.filter((part) => !SETTLEMENT_RE.test(part)).join(", ").trim() ||
      trimmed
    : trimmed;

  // No usable comma split: the trailing token that starts with a digit is the
  // house number. `u` makes the letter suffix match Cyrillic too.
  const match = /^(.*?)[\s,]+((?:буд|б|д|№)\s*\.?\s*)?(\d[\p{L}\d\-/ʼ'’ ]*)$/u
    .exec(single);

  if (match && match[3]) {
    return {
      street: match[1].trim().replace(
        /[,\s]+$/u,
        "",
      ),
      number: stripNumberPrefix(match[3]),
    };
  }

  return {
    street: single,
    number: "",
  };
}

/** `буд. 58-А` / `№58` → `58-А`. */
function stripNumberPrefix(value: string): string {
  return value
    .replace(
      /^\s*(?:будинок|буд|дом|д|house|№|n)\s*\.?\s*/iu,
      "",
    )
    .trim();
}

/** A field that is a house number rather than a street or a settlement. */
const HOUSE_NUMBER_RE =
  /^\s*(?:будинок|буд|дом|д|house|№|n)?\s*\.?\s*\d[\p{L}\d\-/ʼ'’ .]*$/u;

const SETTLEMENT_RE =
  /^\s*(?:м|міс(?:то)?|г|гор(?:од)?|с|сел(?:о|ище)?|смт|обл(?:асть)?|район|р-н)\s*\.?\s+/iu;

function readNumber(value: string): number | null {
  const parsed = Number(value.replace(
    ",",
    ".",
  ));

  return Number.isFinite(parsed) ? parsed : null;
}

function readCount(value: string): number | null {
  const digits = value.replace(/\D/g, "");

  return digits ? Number(digits) : null;
}

function readDate(value: string): string | null {
  if (!value) {
    return null;
  }

  // `12.05.2026` and `12/05/2026` are how field sheets write dates; `Date.parse`
  // reads the first as an American month/day and the second not at all.
  const dotted = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(value.trim());

  if (dotted) {
    return `${dotted[3]}-${dotted[2].padStart(2, "0")}-${
      dotted[1].padStart(2, "0")
    }`;
  }

  return Number.isNaN(Date.parse(value)) ? null : value.trim();
}

/**
 * A raw source row → the preview record.
 *
 * Nothing here writes to the database, and nothing here decides anything: it
 * produces the normalised view a reviewer compares against the original.
 */
export function normalizeImportRow(
  raw: Record<string, unknown>,
): { normalized: NormalizedRow; cleanedCount: number; notes: string[] } {
  const stripped = stripForbiddenFields(raw);
  const value = stripped.value;
  // Some sources (the legacy browser overlay) drop forbidden values while they
  // are still being flattened into rows, so the count arrives pre-computed
  // rather than being derivable from the columns that made it this far.
  const preCleaned = Number(raw.__cleanedFields ?? 0);
  const cleanedCount = stripped.cleanedCount +
    (Number.isFinite(preCleaned) ? Math.max(0, Math.trunc(preCleaned)) : 0);
  const notes: string[] = [];

  if (cleanedCount > 0) {
    notes.push(
      `Видалено ${cleanedCount} значень із заборонених полів (політичні ` +
        "позиції, вік, паспортні та кадрові дані).",
    );
  }

  const addressText = pick(
    value,
    "address",
  );
  const explicitStreet = pick(
    value,
    "street",
  );
  const explicitNumber = pick(
    value,
    "number",
  );

  const parsedAddress = addressText
    ? splitAddress(addressText)
    : {
      street: "",
      number: "",
    };

  const street = explicitStreet || parsedAddress.street;
  const number = explicitNumber || parsedAddress.number;

  // One cell listing a run of buildings — `Зодчих 58, 60, 62`, `58 і 60` — is
  // routine in the archive. Picking one of them would attach the row's contact
  // and its work history to an arbitrary building, so the row is stopped here
  // and a person splits it.
  const listedNumbers = findMultipleHouseNumbers(
    explicitNumber || addressText.replace(
      parsedAddress.street,
      "",
    ),
  );
  const hasMultipleHouses = listedNumbers.length > 1;

  if (hasMultipleHouses) {
    notes.push(
      `У клітинці перелічено кілька будинків (${listedNumbers.join(", ")}) — ` +
        "рядок треба розділити вручну, по одному будинку на запис.",
    );
  }

  if (!street) {
    notes.push("Не розпізнано вулицю.");
  }

  if (!number) {
    notes.push("Не розпізнано номер будинку.");
  }

  const rawStage = normalizeText(pick(
    value,
    "stage",
  ));
  const stage = (WORK_STAGES as readonly string[]).includes(rawStage)
    ? rawStage
    : LEGACY_STAGE_MAP[pick(
      value,
      "stage",
    )] ?? null;

  const rawPriority = normalizeText(pick(
    value,
    "priority",
  ));
  const priority = (PRIORITIES as readonly string[]).includes(rawPriority)
    ? rawPriority
    : null;

  const phone = pick(
    value,
    "phone",
  );
  const phoneNormalized = phone ? normalizePhone(phone) : "";

  if (phone && phoneNormalized.replace(/\D/g, "").length < 10) {
    notes.push("Телефон не схожий на повний номер.");
  }

  const lat = readNumber(pick(
    value,
    "lat",
  ));
  const lon = readNumber(pick(
    value,
    "lon",
  ));

  const freeText = pick(
    value,
    "note",
  );

  if (freeText) {
    notes.push(
      "Є вільний текст — його треба вручну віднести до звернення, задачі або дії.",
    );
  }

  return {
    normalized: {
      street,
      number,
      addressNormalized: normalizeAddress(
        street,
        number,
      ),
      addressText: addressText || [
        street,
        number,
      ].filter(Boolean).join(", "),
      lat,
      lon,
      stage,
      priority,
      entrances: readCount(pick(
        value,
        "entrances",
      )),
      apartments: readCount(pick(
        value,
        "apartments",
      )),
      accessNote: pick(
        value,
        "accessNote",
      ),
      surveyedAt: readDate(pick(
        value,
        "surveyedAt",
      )),
      contactName: pick(
        value,
        "contactName",
      ),
      contactRole: pick(
        value,
        "contactRole",
      ),
      phone,
      phoneNormalized,
      freeText,
      osmType: null,
      osmId: null,
      multipleHouseNumbers: listedNumbers,
    },
    cleanedCount,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Batches
 * ------------------------------------------------------------------ */

export function listBatches(database: DatabaseSync): ImportBatch[] {
  const rows = database.prepare(`
    SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 100
  `).all() as Record<string, unknown>[];

  return rows.map(rowToBatch);
}

export function getBatch(
  database: DatabaseSync,
  batchId: string,
): ImportBatch {
  const row = database.prepare(
    "SELECT * FROM import_batches WHERE id = ?",
  ).get(batchId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Партію імпорту не знайдено.",
    );
  }

  return rowToBatch(row);
}

export function listBatchRows(
  database: DatabaseSync,
  batchId: string,
  options: { status?: string; limit?: number } = {},
): ImportRow[] {
  const conditions = ["batch_id = ?"];
  const parameters: unknown[] = [batchId];

  if (options.status) {
    conditions.push("status = ?");
    parameters.push(options.status);
  }

  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? 500)),
    2000,
  );

  const rows = database.prepare(`
    SELECT * FROM import_rows
    WHERE ${conditions.join(" AND ")}
    ORDER BY row_number
    LIMIT ${limit}
  `).all(...parameters as never[]) as Record<string, unknown>[];

  return rows.map(rowToImportRow);
}

/**
 * Finds the houses a row might refer to.
 *
 * Three independent keys, strongest first: the OSM link, the normalised
 * address, and — for a contact row — the normalised phone of somebody already
 * linked to a house. A single strong match becomes a proposed `merge`; several
 * matches, or none, becomes `needs_review`. Nothing is merged on a guess.
 */
function findHouseCandidates(
  database: DatabaseSync,
  normalized: NormalizedRow,
): { id: string; address: string; reason: string }[] {
  const candidates = new Map<string, { id: string; address: string; reason: string }>();

  if (normalized.osmId !== null && normalized.osmType) {
    const row = database.prepare(`
      SELECT id, address FROM houses
      WHERE osm_type = ? AND osm_id = ? AND deleted_at IS NULL
    `).get(
      normalized.osmType,
      normalized.osmId,
    ) as Record<string, unknown> | undefined;

    if (row) {
      candidates.set(
        String(row.id),
        {
          id: String(row.id),
          address: String(row.address),
          reason: "osm",
        },
      );
    }
  }

  if (normalized.addressNormalized && normalized.addressNormalized !== "|") {
    const rows = database.prepare(`
      SELECT id, address FROM houses
      WHERE address_normalized = ? AND deleted_at IS NULL
      LIMIT 10
    `).all(normalized.addressNormalized) as Record<string, unknown>[];

    for (const row of rows) {
      const id = String(row.id);

      if (!candidates.has(id)) {
        candidates.set(
          id,
          {
            id,
            address: String(row.address),
            reason: "address",
          },
        );
      }
    }
  }

  if (normalized.phoneNormalized) {
    const rows = database.prepare(`
      SELECT DISTINCT h.id, h.address FROM person_contacts pc
      JOIN house_people hp ON hp.person_id = pc.person_id AND hp.deleted_at IS NULL
      JOIN houses h ON h.id = hp.house_id AND h.deleted_at IS NULL
      WHERE pc.value_normalized = ? AND pc.deleted_at IS NULL
      LIMIT 10
    `).all(normalized.phoneNormalized) as Record<string, unknown>[];

    for (const row of rows) {
      const id = String(row.id);

      if (!candidates.has(id)) {
        candidates.set(
          id,
          {
            id,
            address: String(row.address),
            reason: "phone",
          },
        );
      }
    }
  }

  return [...candidates.values()];
}

export interface CreateBatchInput {
  kind: ImportBatchKind;
  fileName: string;
  campaignId: string | null;
  rows: Record<string, unknown>[];
}

const MAX_IMPORT_ROWS = 20_000;

/**
 * Stages a file: writes every source row verbatim, builds the preview and
 * proposes a decision. Nothing is written to a working table here.
 */
export function createBatch(
  database: DatabaseSync,
  input: CreateBatchInput,
  context: ChangeContext,
): ImportBatch {
  if (!(IMPORT_BATCH_KINDS as readonly string[]).includes(input.kind)) {
    badRequest("Невідомий тип імпорту.");
  }

  if (input.rows.length === 0) {
    badRequest("У файлі немає жодного рядка.");
  }

  if (input.rows.length > MAX_IMPORT_ROWS) {
    badRequest(
      `Забагато рядків в одному імпорті (максимум ${MAX_IMPORT_ROWS}).`,
    );
  }

  const batchId = randomUUID();
  const now = new Date().toISOString();
  let cleanedTotal = 0;

  database.prepare(`
    INSERT INTO import_batches (
      id, campaign_id, kind, file_name, status, total_rows,
      cleaned_fields_count, created_by, created_at
    ) VALUES (?, ?, ?, ?, 'draft', ?, 0, ?, ?)
  `).run(
    batchId,
    input.campaignId,
    input.kind,
    input.fileName.slice(
      0,
      300,
    ),
    input.rows.length,
    context.actor,
    now,
  );

  input.rows.forEach((raw, index) => {
    const { normalized, cleanedCount, notes } = normalizeImportRow(raw);

    cleanedTotal += cleanedCount;

    const candidates = findHouseCandidates(
      database,
      normalized,
    );
    let status = "ready";
    let decision: ImportRowDecision = "create";
    let matchHouseId: string | null = null;
    let confidence = "";

    if (candidates.length === 1) {
      matchHouseId = candidates[0].id;
      decision = "merge";
      confidence = candidates[0].reason;
    } else if (candidates.length > 1) {
      status = "needs_review";
      decision = "review";
      confidence = "ambiguous";
      notes.push(
        `Знайдено ${candidates.length} схожих будинків — потрібен вибір людини.`,
      );
    } else if (!normalized.street || !normalized.number) {
      status = "needs_review";
      decision = "review";
      notes.push("Адресу не розпізнано — рядок не буде застосовано без рішення.");
    } else {
      // A row with an address but no match would create a new house. The module
      // does not create houses out of thin air during a data import, so it goes
      // to review rather than quietly adding a building to the map.
      status = "needs_review";
      decision = "review";
      notes.push(
        "Будинок за цією адресою не знайдено — підтвердьте створення або " +
          "виберіть існуючий.",
      );
    }

    if (normalized.lat !== null && normalized.lon !== null) {
      const inRange = normalized.lat >= -90 && normalized.lat <= 90 &&
        normalized.lon >= -180 && normalized.lon <= 180;

      if (!inRange) {
        status = "needs_review";
        decision = "review";
        notes.push("Координати поза допустимим діапазоном.");
      }
    }

    // Overrides any match found above: a cell naming several buildings must not
    // be merged into whichever one the address parser happened to land on.
    if ((normalized.multipleHouseNumbers?.length ?? 0) > 1) {
      status = "needs_review";
      decision = "review";
      matchHouseId = null;
      confidence = "multipleHouses";
    }

    database.prepare(`
      INSERT INTO import_rows (
        id, batch_id, row_number, raw, normalized, status, decision,
        match_house_id, match_confidence, notes, cleaned_fields_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      batchId,
      index + 1,
      JSON.stringify(raw),
      JSON.stringify(normalized),
      status,
      decision,
      matchHouseId,
      confidence,
      JSON.stringify(notes),
      cleanedCount,
      now,
    );
  });

  database.prepare(`
    UPDATE import_batches
    SET status = 'previewed', cleaned_fields_count = ?
    WHERE id = ?
  `).run(
    cleanedTotal,
    batchId,
  );

  logCreate(
    database,
    {
      ...context,
      origin: "import",
      batchId,
    },
    "importBatch",
    batchId,
    {
      kind: input.kind,
      rows: input.rows.length,
      cleanedFields: cleanedTotal,
    },
  );

  return getBatch(
    database,
    batchId,
  );
}

export interface RowDecisionInput {
  rowId: string;
  decision: ImportRowDecision;
  matchHouseId?: string | null;
}

/** Applies a reviewer's per-row choices before the batch is committed. */
export function setRowDecisions(
  database: DatabaseSync,
  batchId: string,
  decisions: RowDecisionInput[],
  context: ChangeContext,
): number {
  const batch = getBatch(
    database,
    batchId,
  );

  if (batch.status === "applied") {
    throw new HttpError(
      409,
      "Партію вже застосовано — рішення змінити не можна.",
    );
  }

  const now = new Date().toISOString();
  let updated = 0;

  for (const entry of decisions) {
    const decision = requireOneOf(
      entry.decision,
      IMPORT_ROW_DECISIONS,
      "decision",
    );

    if (decision === "merge" && !entry.matchHouseId) {
      badRequest("Для обʼєднання треба вказати будинок.");
    }

    const result = database.prepare(`
      UPDATE import_rows SET
        decision = ?,
        match_house_id = COALESCE(?, match_house_id),
        status = CASE ? WHEN 'skip' THEN 'skipped' ELSE 'ready' END,
        updated_at = ?
      WHERE id = ? AND batch_id = ? AND status != 'applied'
    `).run(
      decision,
      entry.matchHouseId ?? null,
      decision,
      now,
      entry.rowId,
      batchId,
    );

    updated += Number(result.changes ?? 0);
  }

  logOperation(
    database,
    {
      ...context,
      origin: "import",
      batchId,
    },
    "importBatch",
    batchId,
    "decisions",
    {
      updated,
    },
  );

  return updated;
}

/**
 * How an unapplied row is named in the report.
 *
 * A legacy row is keyed by OSM id and carries no address text at all, so
 * falling back to "the address" alone would list it as an empty string — which
 * reads as no finding and is exactly the silent loss the report exists to
 * prevent. Every unapplied row gets an identifier, in decreasing usefulness.
 */
function describeRow(row: ImportRow): string {
  const address = row.normalized?.addressText?.trim();

  if (address) {
    return address;
  }

  const raw = (row.raw ?? {}) as Record<string, unknown>;
  const legacyKey = raw.__legacyHouseKey;

  if (legacyKey) {
    return `OSM ${String(legacyKey)}`;
  }

  return `рядок ${row.rowNumber}`;
}

/**
 * Records what the batch did to one record.
 *
 * `previous` is the pre-import image, `applied` is what the import left in
 * place. Rollback needs both: the first to know what to restore, the second to
 * know whether restoring is still the right thing to do.
 */
function recordEffect(
  database: DatabaseSync,
  batchId: string,
  entity: string,
  entityId: string,
  operation: "insert" | "update",
  previous?: unknown,
  applied?: unknown,
): void {
  database.prepare(`
    INSERT INTO import_effects (
      batch_id, entity, entity_id, operation, previous, applied
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    entity,
    entityId,
    operation,
    previous === undefined ? null : JSON.stringify(previous),
    applied === undefined ? null : JSON.stringify(applied),
  );
}

/**
 * Writes the batch into the working tables.
 *
 * The caller runs this inside one transaction, so a failure part-way leaves
 * nothing behind. Rows marked `review` are not applied — they stay in the batch
 * as unfinished business, and the report says how many there are.
 */
export function applyBatch(
  database: DatabaseSync,
  batchId: string,
  campaignId: string | null,
  context: ChangeContext,
): ImportReport {
  const batch = getBatch(
    database,
    batchId,
  );

  if (batch.status === "applied") {
    throw new HttpError(
      409,
      "Партію вже застосовано.",
    );
  }

  if (batch.status === "rolled_back") {
    throw new HttpError(
      409,
      "Партію вже відкочено — застосувати її повторно не можна.",
    );
  }

  const rows = listBatchRows(
    database,
    batchId,
    {
      limit: MAX_IMPORT_ROWS,
    },
  );
  const importContext: ChangeContext = {
    ...context,
    origin: "import",
    batchId,
    campaignId,
  };
  const report: ImportReport = {
    created: 0,
    updated: 0,
    merged: 0,
    skipped: 0,
    needsReview: 0,
    failed: 0,
    cleanedFields: batch.cleanedFieldsCount,
    unmatchedAddresses: [],
  };
  const now = new Date().toISOString();
  const source = `import:${batchId}`;

  for (const row of rows) {
    if (row.status === "applied") {
      continue;
    }

    if (row.decision === "skip" || row.status === "skipped") {
      report.skipped += 1;
      continue;
    }

    if (row.decision === "review" || row.status === "needs_review") {
      report.needsReview += 1;
      report.unmatchedAddresses.push(describeRow(row));
      continue;
    }

    const normalized = row.normalized;

    if (!normalized || !row.matchHouseId) {
      report.needsReview += 1;
      report.unmatchedAddresses.push(describeRow(row));
      continue;
    }

    const houseRow = database.prepare(`
      SELECT id, entrances, apartments, access_note, source
      FROM houses WHERE id = ? AND deleted_at IS NULL
    `).get(row.matchHouseId) as Record<string, unknown> | undefined;

    if (!houseRow) {
      report.failed += 1;
      database.prepare(`
        UPDATE import_rows SET status = 'failed', updated_at = ? WHERE id = ?
      `).run(
        now,
        row.id,
      );
      continue;
    }

    const houseId = String(houseRow.id);

    // Permanent attributes: only fill gaps. An import never overwrites a value
    // somebody confirmed in the field with one from a spreadsheet.
    const nextEntrances = houseRow.entrances == null
      ? normalized.entrances
      : Number(houseRow.entrances);
    const nextApartments = houseRow.apartments == null
      ? normalized.apartments
      : Number(houseRow.apartments);
    const nextAccessNote = String(houseRow.access_note ?? "") ||
      normalized.accessNote;

    recordEffect(
      database,
      batchId,
      "house",
      houseId,
      "update",
      {
        entrances: houseRow.entrances,
        apartments: houseRow.apartments,
        access_note: houseRow.access_note,
      },
      {
        entrances: nextEntrances,
        apartments: nextApartments,
        access_note: nextAccessNote,
      },
    );

    database.prepare(`
      UPDATE houses SET
        entrances = ?, apartments = ?, access_note = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextEntrances,
      nextApartments,
      nextAccessNote,
      now,
      houseId,
    );

    report.updated += 1;

    if (campaignId && (normalized.stage || normalized.priority)) {
      const existingState = database.prepare(`
        SELECT stage, priority FROM house_campaign_state
        WHERE campaign_id = ? AND house_id = ?
      `).get(
        campaignId,
        houseId,
      ) as Record<string, unknown> | undefined;

      const appliedStage = normalized.stage ??
        String(existingState?.stage ?? "not_started");
      const appliedPriority = normalized.priority ??
        String(existingState?.priority ?? "medium");

      recordEffect(
        database,
        batchId,
        "houseCampaignState",
        `${campaignId}:${houseId}`,
        existingState ? "update" : "insert",
        existingState ?? undefined,
        {
          stage: appliedStage,
          priority: appliedPriority,
        },
      );

      database.prepare(`
        INSERT INTO house_campaign_state (
          campaign_id, house_id, stage, priority, created_at, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, house_id) DO UPDATE SET
          stage = excluded.stage,
          priority = excluded.priority,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(
        campaignId,
        houseId,
        normalized.stage ?? String(existingState?.stage ?? "not_started"),
        normalized.priority ?? String(existingState?.priority ?? "medium"),
        now,
        now,
        context.actor,
      );
    }

    if (normalized.contactName) {
      const personId = createPerson(
        database,
        {
          fullName: normalized.contactName,
          role: matchPersonRole(normalized.contactRole),
          // The original wording is kept as a note when it did not map onto a
          // known role, so nothing a canvasser wrote down is thrown away.
          note: matchPersonRole(normalized.contactRole) === "other" &&
              normalized.contactRole
            ? `Роль за імпортом: ${normalized.contactRole}`
            : "",
          source,
          houseId,
          contacts: normalized.phone
            ? [
              {
                type: "phone",
                value: normalized.phone,
                label: normalized.contactRole,
                isPrimary: true,
              },
            ]
            : [],
        },
        importContext,
      );

      recordEffect(
        database,
        batchId,
        "person",
        personId,
        "insert",
      );
      report.created += 1;
    }

    if (campaignId && normalized.surveyedAt) {
      const actionId = createAction(
        database,
        campaignId,
        {
          houseId,
          type: "visit",
          result: "info_only",
          happenedAt: normalized.surveyedAt,
          comment: "Перенесено з імпорту: зафіксована дата обходу.",
        },
        importContext,
      );

      recordEffect(
        database,
        batchId,
        "action",
        actionId,
        "insert",
      );
    }

    report.merged += 1;

    database.prepare(`
      UPDATE import_rows SET
        status = 'applied', created_entity_type = 'house',
        created_entity_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      houseId,
      now,
      row.id,
    );
  }

  database.prepare(`
    UPDATE import_batches
    SET status = 'applied', applied_at = ?, report = ?
    WHERE id = ?
  `).run(
    now,
    JSON.stringify(report),
    batchId,
  );

  logOperation(
    database,
    importContext,
    "importBatch",
    batchId,
    "apply",
    report,
  );

  return report;
}

/**
 * Undoes everything a batch wrote.
 *
 * Inserts are soft-deleted, updates are restored from the pre-image captured at
 * apply time, and the effects are replayed newest-first so a chain of changes
 * unwinds in the right order.
 */
export function rollbackBatch(
  database: DatabaseSync,
  batchId: string,
  context: ChangeContext,
): { reverted: number; keptUserEdits: string[] } {
  const batch = getBatch(
    database,
    batchId,
  );

  if (batch.status !== "applied") {
    throw new HttpError(
      409,
      "Відкотити можна лише застосовану партію.",
    );
  }

  const effects = database.prepare(`
    SELECT entity, entity_id, operation, previous, applied
    FROM import_effects WHERE batch_id = ? ORDER BY id DESC
  `).all(batchId) as Record<string, unknown>[];

  const now = new Date().toISOString();
  const softDeleteTables: Record<string, string> = {
    house: "houses",
    person: "people",
    action: "actions",
    issue: "issues",
    task: "tasks",
  };
  let reverted = 0;
  // Fields left as the user set them because they no longer hold the value the
  // import wrote. Reported back so the rollback is not silently partial.
  const keptUserEdits: string[] = [];

  for (const effect of effects) {
    const entity = String(effect.entity);
    const entityId = String(effect.entity_id);

    if (String(effect.operation) === "insert") {
      const table = softDeleteTables[entity];

      if (table) {
        database.prepare(`
          UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?
        `).run(
          now,
          now,
          entityId,
        );
        reverted += 1;
      } else if (entity === "houseCampaignState") {
        const [campaignId, houseId] = entityId.split(":");

        database.prepare(`
          DELETE FROM house_campaign_state
          WHERE campaign_id = ? AND house_id = ?
        `).run(
          campaignId,
          houseId,
        );
        reverted += 1;
      }

      continue;
    }

    const previous = parseJson<Record<string, unknown> | null>(
      effect.previous,
      null,
    );

    if (!previous) {
      continue;
    }

    const applied = parseJson<Record<string, unknown> | null>(
      effect.applied,
      null,
    );

    if (entity === "house") {
      const current = database.prepare(`
        SELECT entrances, apartments, access_note FROM houses WHERE id = ?
      `).get(entityId) as Record<string, unknown> | undefined;

      if (!current) {
        continue;
      }

      // Restore a field only where it still holds what the import put there.
      // Anything a user has corrected since is theirs and survives the
      // rollback — undoing an import must not undo a week of field work.
      const restore = <T>(
        field: string,
        currentValue: unknown,
        previousValue: T,
      ): { value: T | unknown; kept: boolean } => {
        if (!applied) {
          return {
            value: previousValue,
            kept: false,
          };
        }

        const wasApplied = String(applied[field] ?? "") ===
          String(currentValue ?? "");

        if (!wasApplied) {
          keptUserEdits.push(`house.${field}`);
        }

        return {
          value: wasApplied ? previousValue : currentValue,
          kept: !wasApplied,
        };
      };

      const entrances = restore(
        "entrances",
        current.entrances,
        toNullableInteger(previous.entrances),
      );
      const apartments = restore(
        "apartments",
        current.apartments,
        toNullableInteger(previous.apartments),
      );
      const accessNote = restore(
        "access_note",
        current.access_note,
        String(previous.access_note ?? ""),
      );

      database.prepare(`
        UPDATE houses SET
          entrances = ?, apartments = ?, access_note = ?, updated_at = ?
        WHERE id = ?
      `).run(
        entrances.value as number | null,
        apartments.value as number | null,
        String(accessNote.value ?? ""),
        now,
        entityId,
      );
      reverted += 1;
    } else if (entity === "houseCampaignState") {
      const [campaignId, houseId] = entityId.split(":");
      const current = database.prepare(`
        SELECT stage, priority FROM house_campaign_state
        WHERE campaign_id = ? AND house_id = ?
      `).get(
        campaignId,
        houseId,
      ) as Record<string, unknown> | undefined;

      if (!current) {
        continue;
      }

      const stageUntouched = !applied ||
        String(applied.stage ?? "") === String(current.stage ?? "");
      const priorityUntouched = !applied ||
        String(applied.priority ?? "") === String(current.priority ?? "");

      if (!stageUntouched) {
        keptUserEdits.push("houseCampaignState.stage");
      }

      if (!priorityUntouched) {
        keptUserEdits.push("houseCampaignState.priority");
      }

      database.prepare(`
        UPDATE house_campaign_state SET stage = ?, priority = ?, updated_at = ?
        WHERE campaign_id = ? AND house_id = ?
      `).run(
        stageUntouched
          ? String(previous.stage ?? "not_started")
          : String(current.stage),
        priorityUntouched
          ? String(previous.priority ?? "medium")
          : String(current.priority),
        now,
        campaignId,
        houseId,
      );
      reverted += 1;
    }
  }

  database.prepare(`
    UPDATE import_batches SET status = 'rolled_back', rolled_back_at = ?
    WHERE id = ?
  `).run(
    now,
    batchId,
  );
  database.prepare(`
    UPDATE import_rows SET status = 'pending', updated_at = ?
    WHERE batch_id = ? AND status = 'applied'
  `).run(
    now,
    batchId,
  );

  logOperation(
    database,
    {
      ...context,
      origin: "import",
      batchId,
    },
    "importBatch",
    batchId,
    "rollback",
    {
      reverted,
      keptUserEdits: keptUserEdits.length,
    },
  );

  return {
    reverted,
    keptUserEdits,
  };
}

/* ------------------------------------------------------------------ *
 * Legacy browser data
 * ------------------------------------------------------------------ */

export interface LegacyDetailsExport {
  key?: string;
  exportedAt?: string;
  entries?: Record<string, Record<string, unknown>>;
}

/**
 * The old `avku-elections-details-v1` overlay → generic import rows.
 *
 * The overlay is keyed by OSM id, which is exactly the matching attribute the
 * `houses` table keeps, so these rows normally match a house outright instead
 * of going through address parsing.
 *
 * The three fields the old model held that must not survive — a resident's
 * political position and age band — are dropped by `stripForbiddenFields`
 * before anything is written, and free-text notes are carried through as text
 * for a human to classify rather than being turned into issues automatically.
 */
export function legacyExportToRows(
  document: LegacyDetailsExport,
): Record<string, unknown>[] {
  const entries = document.entries ?? {};
  const rows: Record<string, unknown>[] = [];

  for (const [houseKey, details] of Object.entries(entries)) {
    const [osmType, osmIdText] = String(houseKey).split("/");
    const record = (details ?? {}) as Record<string, unknown>;
    const residents = Array.isArray(record.residents) ? record.residents : [];
    const contacts = Array.isArray(record.contacts) ? record.contacts : [];

    /*
     * The political position and age band the old resident record carried are
     * dropped here, while the row is being built — so they never reach
     * `import_rows.raw`, which is stored verbatim and kept for good. Only the
     * number of removed values travels on; what they contained is not recorded
     * anywhere, not in the batch, not in the report and not in the log.
     */
    let cleanedFields = 0;

    for (const resident of residents) {
      const entry = (resident ?? {}) as Record<string, unknown>;

      for (const [key, item] of Object.entries(entry)) {
        if (isForbiddenField(key) && String(item ?? "").trim() !== "") {
          cleanedFields += 1;
        }
      }
    }

    // Each legacy contact becomes its own row, so a house with three phones
    // produces three reviewable rows rather than one lossy merge.
    const contactRows = contacts.length > 0
      ? contacts
      : [
        null,
      ];

    contactRows.forEach((contact, index) => {
      const contactRecord = (contact ?? {}) as Record<string, unknown>;
      const resident = residents[index] as Record<string, unknown> | undefined;

      rows.push({
        __legacyHouseKey: houseKey,
        // Reported once per house, on its first row.
        __cleanedFields: index === 0 ? cleanedFields : 0,
        __osmType: osmType,
        __osmId: osmIdText,
        street: "",
        number: "",
        address: "",
        stage: String(record.canvassStatus ?? ""),
        priority: String(record.priority ?? ""),
        entrances: record.entrances ?? "",
        apartments: record.apartments ?? "",
        accessNote: String(record.accessNote ?? ""),
        surveyedAt: String(record.surveyedAt ?? ""),
        // Only the name and the working role survive from a resident record.
        // The person's own name wins over the contact's label: the label
        // usually describes the role ("голова ОСББ"), and naming somebody after
        // their job loses the one thing that identifies them.
        contactName: String(resident?.name || contactRecord.label || ""),
        contactRole: String(contactRecord.label ?? ""),
        phone: contactRecord.type === "phone" || contactRecord.type === "viber"
          ? String(contactRecord.value ?? "")
          : "",
        note: index === 0 ? String(record.notes ?? "") : "",
        // Carried so the reviewer can see who the old free-text field claimed
        // made the change. It is never written to an author column.
        legacyUpdatedBy: String(record.updatedBy ?? ""),
      });
    });
  }

  return rows;
}

/** Resolves legacy rows against the OSM link before the generic matcher runs. */
export function attachLegacyOsmMatch(
  database: DatabaseSync,
  batchId: string,
): number {
  const rows = listBatchRows(
    database,
    batchId,
    {
      limit: MAX_IMPORT_ROWS,
    },
  );
  const now = new Date().toISOString();
  let matched = 0;

  for (const row of rows) {
    const raw = (row.raw ?? {}) as Record<string, unknown>;
    const osmType = String(raw.__osmType ?? "");
    const osmId = Number(raw.__osmId);

    if (!osmType || !Number.isFinite(osmId)) {
      continue;
    }

    const house = database.prepare(`
      SELECT id, address FROM houses
      WHERE osm_type = ? AND osm_id = ? AND deleted_at IS NULL
    `).get(
      osmType,
      osmId,
    ) as Record<string, unknown> | undefined;

    const notes = row.notes.slice();

    if (!house) {
      notes.push(
        `Будинок ${osmType}/${osmId} не знайдено в базі — рядок потребує ` +
          "ручного рішення, дані не втрачено.",
      );

      database.prepare(`
        UPDATE import_rows SET status = 'needs_review', decision = 'review',
          notes = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify(notes),
        now,
        row.id,
      );
      continue;
    }

    const normalized = {
      ...(row.normalized ?? {}),
      osmType,
      osmId,
      addressText: String(house.address),
    };

    database.prepare(`
      UPDATE import_rows SET
        status = 'ready', decision = 'merge', match_house_id = ?,
        match_confidence = 'osm', normalized = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(house.id),
      JSON.stringify(normalized),
      now,
      row.id,
    );
    matched += 1;
  }

  return matched;
}
