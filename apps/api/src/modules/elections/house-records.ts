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
  HOUSE_TYPES,
  OPEN_ISSUE_STATUSES,
  OPEN_TASK_STATUSES,
  PRIORITIES,
  WORK_STAGES,
  badRequest,
  normalizeAddress,
  optionalCount,
  optionalNullableText,
  optionalOneOf,
  optionalText,
  optionalTimestamp,
  requireLatitude,
  requireLongitude,
  requireText,
} from "./elections.types";
import type { ElectionsViewer } from "./elections-access";
import { canSeeContacts, houseVisibilitySql } from "./elections-access";

/**
 * Houses, and the state of a house within one campaign.
 *
 * The split is the point of the whole change. `houses` holds what a building
 * *is* — address, outline, entrances, who manages it — and never changes when a
 * campaign starts or ends. `house_campaign_state` holds what has been done
 * about it *this* campaign. Running a second campaign over the same street
 * therefore adds rows; it does not overwrite last year's work.
 *
 * Derived numbers — last action, open issues, overdue tasks — are computed from
 * the related tables on read. They are never stored, so they cannot drift away
 * from the records they summarise.
 */

/** Data older than this is flagged as stale rather than silently trusted. */
export const STALE_VERIFICATION_DAYS = 90;

export interface HouseCampaignState {
  stage: string;
  priority: string;
  priorityReason: string;
  summary: string;
  /** What is planned here next, in words. `nextActionAt` is only its date. */
  nextStep: string;
  nextActionAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  lastActionAt: string | null;
  lastActionId: string | null;
  lastActionType: string | null;
  lastActionResult: string | null;
  openIssuesCount: number;
  overdueTasksCount: number;
  todayTasksCount: number;
  openTasksCount: number;
  assignees: HouseAssignee[];
}

export interface HouseAssignee {
  id: string;
  email: string;
  role: string;
  scope: string;
  validFrom: string;
  validTo: string | null;
}

export interface HousePrecinctLink {
  id: string;
  precinctId: string;
  precinctNumber: string;
  district: string;
  entrance: string;
  apartmentFrom: number | null;
  apartmentTo: number | null;
}

export interface HouseRecord {
  id: string;
  osmType: string | null;
  osmId: number | null;
  osmStatus: string;
  osmTimestamp: string | null;
  street: string;
  streetShort: string;
  number: string;
  /** Corpus or letter — "корпус 2", "літера А". Not part of `number`. */
  block: string;
  address: string;
  fullAddress: string;
  addressNormalized: string;
  city: string;
  postalCode: string;
  location: { lat: number; lon: number };
  footprint: { lat: number; lon: number }[];
  footprintAreaSqm: number | null;
  name: string | null;
  type: string;
  building: string;
  floors: number | null;
  builtYear: number | null;
  entrances: number | null;
  apartments: number | null;
  households: number | null;
  residentsCount: number | null;
  managingOrg: string;
  accessNote: string;
  source: string;
  geocodeStatus: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
  precincts: HousePrecinctLink[];
  campaign: HouseCampaignState;
  /** Machine-readable data-quality findings — never auto-corrected. */
  quality: string[];
  /** True when the viewer may see names and phone numbers for this house. */
  canSeeContacts: boolean;
  contactsCount: number;
}

function parseFootprint(value: unknown): { lat: number; lon: number }[] {
  if (value == null) {
    return [];
  }

  try {
    const parsed = JSON.parse(String(value)) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((point): point is { lat: number; lon: number } =>
        Boolean(point) &&
        typeof point === "object" &&
        Number.isFinite((point as { lat?: unknown }).lat) &&
        Number.isFinite((point as { lon?: unknown }).lon))
      .map((point) => ({
        lat: Number(point.lat),
        lon: Number(point.lon),
      }));
  } catch {
    return [];
  }
}

function daysSince(iso: string | null): number | null {
  if (!iso) {
    return null;
  }

  const parsed = Date.parse(iso);

  if (Number.isNaN(parsed)) {
    return null;
  }

  return (Date.now() - parsed) / 86_400_000;
}

/**
 * Data-quality findings for one house.
 *
 * Every one of these is *reported*, never fixed: the request is explicit that a
 * doubtful value must not be corrected automatically. `duplicateAddress` in
 * particular is a finding rather than a constraint — the live OSM snapshot
 * genuinely contains 225 repeated street+number pairs, so rejecting them would
 * reject reality.
 */
function describeQuality(
  row: Record<string, unknown>,
  state: HouseCampaignState,
): string[] {
  const quality: string[] = [];

  if (!Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lon))) {
    quality.push("missingCoordinates");
  }

  if (!String(row.street ?? "").trim() || !String(row.number ?? "").trim()) {
    quality.push("incompleteAddress");
  }

  if (!String(row.source ?? "").trim()) {
    quality.push("missingSource");
  }

  const age = daysSince(row.verified_at == null ? null : String(row.verified_at));

  if (age === null) {
    quality.push("neverVerified");
  } else if (age > STALE_VERIFICATION_DAYS) {
    quality.push("staleVerification");
  }

  if (Number(row.duplicate_address_count ?? 1) > 1) {
    quality.push("duplicateAddress");
  }

  if (String(row.osm_status) === "missing") {
    quality.push("missingInOsm");
  }

  if (state.assignees.length === 0) {
    quality.push("noAssignee");
  }

  if (state.overdueTasksCount > 0) {
    quality.push("overdueTasks");
  }

  return quality;
}

/**
 * The full read query.
 *
 * All the derived counters are correlated sub-selects rather than a chain of
 * joins: each one is a single indexed lookup per house, and the alternative —
 * joining four one-to-many tables at once — multiplies rows before it can
 * aggregate them. For ~6 000 houses this returns in a few tens of milliseconds.
 */
function buildHouseSelect(
  visibilitySql: string,
  extraWhere = "",
): string {
  const openIssues = OPEN_ISSUE_STATUSES.map((status) => `'${status}'`).join(", ");
  const openTasks = OPEN_TASK_STATUSES.map((status) => `'${status}'`).join(", ");

  const sql = `
    SELECT
      h.*,
      (
        SELECT COUNT(*) FROM houses d
        WHERE d.address_normalized = h.address_normalized
          AND d.deleted_at IS NULL
      ) AS duplicate_address_count,
      s.stage, s.priority, s.priority_reason, s.summary, s.next_step,
      s.next_action_at,
      s.updated_at AS state_updated_at, s.updated_by AS state_updated_by,
      (
        SELECT a.id FROM actions a
        WHERE a.house_id = h.id AND a.campaign_id = :campaignId
          AND a.deleted_at IS NULL
        ORDER BY a.happened_at DESC, a.created_at DESC LIMIT 1
      ) AS last_action_id,
      (
        SELECT a.happened_at FROM actions a
        WHERE a.house_id = h.id AND a.campaign_id = :campaignId
          AND a.deleted_at IS NULL
        ORDER BY a.happened_at DESC, a.created_at DESC LIMIT 1
      ) AS last_action_at,
      (
        SELECT a.type FROM actions a
        WHERE a.house_id = h.id AND a.campaign_id = :campaignId
          AND a.deleted_at IS NULL
        ORDER BY a.happened_at DESC, a.created_at DESC LIMIT 1
      ) AS last_action_type,
      (
        SELECT a.result FROM actions a
        WHERE a.house_id = h.id AND a.campaign_id = :campaignId
          AND a.deleted_at IS NULL
        ORDER BY a.happened_at DESC, a.created_at DESC LIMIT 1
      ) AS last_action_result,
      (
        SELECT COUNT(*) FROM issues i
        WHERE i.house_id = h.id AND i.campaign_id = :campaignId
          AND i.deleted_at IS NULL AND i.status IN (${openIssues})
      ) AS open_issues_count,
      (
        SELECT COUNT(*) FROM tasks t
        WHERE t.house_id = h.id AND t.campaign_id = :campaignId
          AND t.deleted_at IS NULL AND t.status IN (${openTasks})
      ) AS open_tasks_count,
      (
        SELECT COUNT(*) FROM tasks t
        WHERE t.house_id = h.id AND t.campaign_id = :campaignId
          AND t.deleted_at IS NULL AND t.status IN (${openTasks})
          AND t.due_at IS NOT NULL AND t.due_at < :now
      ) AS overdue_tasks_count,
      (
        SELECT COUNT(*) FROM tasks t
        WHERE t.house_id = h.id AND t.campaign_id = :campaignId
          AND t.deleted_at IS NULL AND t.status IN (${openTasks})
          AND t.due_at IS NOT NULL AND substr(t.due_at, 1, 10) = :today
      ) AS today_tasks_count,
      (
        SELECT COUNT(*) FROM house_people hp
        JOIN person_contacts pc ON pc.person_id = hp.person_id
          AND pc.deleted_at IS NULL
        WHERE hp.house_id = h.id AND hp.deleted_at IS NULL
      ) AS contacts_count
    FROM houses h
    LEFT JOIN house_campaign_state s
      ON s.house_id = h.id AND s.campaign_id = :campaignId
    WHERE h.deleted_at IS NULL
      AND (${visibilitySql})
      ${extraWhere}
    ORDER BY h.street, h.number
  `;

  return sql;
}

/**
 * Most parameters one statement may bind, less a little headroom for the
 * fixed ones around the list.
 *
 * SQLite's own ceiling is 32 766. Nothing enforced it here, so a read that
 * bound one parameter per house — twice per house, in the assignment query
 * below — stopped working entirely somewhere above sixteen thousand visible
 * buildings, and did it as a 400 rather than as a slow page. Batching keeps the
 * statement inside the limit whatever the campaign grows to.
 */
const MAX_BOUND_IDS = 8_000;

function chunkIds(houseIds: string[], perStatement: number): string[][] {
  const chunks: string[][] = [];

  for (let index = 0; index < houseIds.length; index += perStatement) {
    chunks.push(houseIds.slice(
      index,
      index + perStatement,
    ));
  }

  return chunks;
}

function readAssignees(
  database: DatabaseSync,
  campaignId: string,
  houseIds: string[],
): Map<string, HouseAssignee[]> {
  const grouped = new Map<string, HouseAssignee[]>();

  if (houseIds.length === 0) {
    return grouped;
  }

  const rows: Record<string, unknown>[] = [];

  // The id list appears twice in the statement, so a batch may only be half
  // the ceiling wide.
  for (const chunk of chunkIds(
    houseIds,
    Math.floor(MAX_BOUND_IDS / 2),
  )) {
    // House-scoped assignments, plus precinct-scoped ones reaching the house
    // through `house_polling_stations`: somebody responsible for a precinct is
    // responsible for its houses, and "house without an assignee" has to know
    // that or it reports every house in a covered precinct.
    const placeholders = chunk.map(() => "?").join(", ");

    rows.push(...database.prepare(`
      SELECT a.id, a.employee_email, a.role, a.scope, a.valid_from, a.valid_to,
             a.scope_id AS scope_id, hp.house_id AS via_house_id
      FROM assignments a
      LEFT JOIN house_polling_stations hp
        ON a.scope = 'precinct' AND hp.precinct_id = a.scope_id
      WHERE a.campaign_id = ?
        AND a.deleted_at IS NULL
        AND a.status = 'active'
        AND (
          (a.scope = 'house' AND a.scope_id IN (${placeholders}))
          OR (a.scope = 'precinct' AND hp.house_id IN (${placeholders}))
        )
    `).all(
      campaignId,
      ...chunk,
      ...chunk,
    ) as Record<string, unknown>[]);
  }

  for (const row of rows) {
    const houseId = String(row.scope) === "house"
      ? String(row.scope_id)
      : String(row.via_house_id ?? "");

    if (!houseId) {
      continue;
    }

    const list = grouped.get(houseId) ?? [];

    list.push({
      id: String(row.id),
      email: String(row.employee_email),
      role: String(row.role),
      scope: String(row.scope),
      validFrom: String(row.valid_from),
      validTo: row.valid_to == null ? null : String(row.valid_to),
    });
    grouped.set(
      houseId,
      list,
    );
  }

  return grouped;
}

function readPrecinctLinks(
  database: DatabaseSync,
  houseIds: string[],
): Map<string, HousePrecinctLink[]> {
  const grouped = new Map<string, HousePrecinctLink[]>();

  if (houseIds.length === 0) {
    return grouped;
  }

  const rows: Record<string, unknown>[] = [];

  for (const chunk of chunkIds(
    houseIds,
    MAX_BOUND_IDS,
  )) {
    const placeholders = chunk.map(() => "?").join(", ");

    rows.push(...database.prepare(`
      SELECT hps.id, hps.house_id, hps.precinct_id, hps.entrance,
             hps.apartment_from, hps.apartment_to,
             p.number AS precinct_number, p.district
      FROM house_polling_stations hps
      JOIN precincts p ON p.id = hps.precinct_id AND p.deleted_at IS NULL
      WHERE hps.house_id IN (${placeholders})
      ORDER BY p.number, hps.entrance
    `).all(...chunk) as Record<string, unknown>[]);
  }

  for (const row of rows) {
    const houseId = String(row.house_id);
    const list = grouped.get(houseId) ?? [];

    list.push({
      id: String(row.id),
      precinctId: String(row.precinct_id),
      precinctNumber: String(row.precinct_number),
      district: String(row.district ?? ""),
      entrance: String(row.entrance ?? ""),
      apartmentFrom: row.apartment_from == null
        ? null
        : Number(row.apartment_from),
      apartmentTo: row.apartment_to == null ? null : Number(row.apartment_to),
    });
    grouped.set(
      houseId,
      list,
    );
  }

  return grouped;
}

function rowToHouse(
  row: Record<string, unknown>,
  assignees: HouseAssignee[],
  precincts: HousePrecinctLink[],
  viewerCanSeeContacts: boolean,
): HouseRecord {
  const state: HouseCampaignState = {
    stage: String(row.stage ?? "not_started"),
    priority: String(row.priority ?? "medium"),
    priorityReason: String(row.priority_reason ?? ""),
    summary: String(row.summary ?? ""),
    nextStep: String(row.next_step ?? ""),
    nextActionAt: row.next_action_at == null
      ? null
      : String(row.next_action_at),
    updatedAt: row.state_updated_at == null
      ? null
      : String(row.state_updated_at),
    updatedBy: row.state_updated_by == null
      ? null
      : String(row.state_updated_by),
    lastActionAt: row.last_action_at == null
      ? null
      : String(row.last_action_at),
    lastActionId: row.last_action_id == null
      ? null
      : String(row.last_action_id),
    lastActionType: row.last_action_type == null
      ? null
      : String(row.last_action_type),
    lastActionResult: row.last_action_result == null
      ? null
      : String(row.last_action_result),
    openIssuesCount: Number(row.open_issues_count ?? 0),
    overdueTasksCount: Number(row.overdue_tasks_count ?? 0),
    todayTasksCount: Number(row.today_tasks_count ?? 0),
    openTasksCount: Number(row.open_tasks_count ?? 0),
    assignees,
  };

  return {
    id: String(row.id),
    osmType: row.osm_type == null ? null : String(row.osm_type),
    osmId: row.osm_id == null ? null : Number(row.osm_id),
    osmStatus: String(row.osm_status ?? "present"),
    osmTimestamp: row.osm_timestamp == null
      ? null
      : String(row.osm_timestamp),
    street: String(row.street ?? ""),
    streetShort: String(row.street_short ?? ""),
    number: String(row.number ?? ""),
    block: String(row.block ?? ""),
    address: String(row.address ?? ""),
    fullAddress: String(row.full_address ?? ""),
    addressNormalized: String(row.address_normalized ?? ""),
    city: String(row.city ?? ""),
    postalCode: String(row.postal_code ?? ""),
    location: {
      lat: Number(row.lat),
      lon: Number(row.lon),
    },
    footprint: parseFootprint(row.footprint),
    footprintAreaSqm: row.footprint_area_sqm == null
      ? null
      : Number(row.footprint_area_sqm),
    name: row.name == null ? null : String(row.name),
    type: String(row.type ?? "other"),
    building: String(row.building ?? ""),
    floors: row.floors == null ? null : Number(row.floors),
    builtYear: row.built_year == null ? null : Number(row.built_year),
    entrances: row.entrances == null ? null : Number(row.entrances),
    apartments: row.apartments == null ? null : Number(row.apartments),
    households: row.households == null ? null : Number(row.households),
    residentsCount: row.residents_count == null
      ? null
      : Number(row.residents_count),
    managingOrg: String(row.managing_org ?? ""),
    accessNote: String(row.access_note ?? ""),
    source: String(row.source ?? ""),
    geocodeStatus: String(row.geocode_status ?? "osm"),
    verifiedAt: row.verified_at == null ? null : String(row.verified_at),
    verifiedBy: row.verified_by == null ? null : String(row.verified_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    precincts,
    campaign: state,
    quality: describeQuality(
      row,
      state,
    ),
    canSeeContacts: viewerCanSeeContacts,
    contactsCount: Number(row.contacts_count ?? 0),
  };
}

export interface ListHousesOptions {
  campaignId: string;
  viewer: ElectionsViewer;
}

/**
 * Every house the viewer is allowed to work with, with this campaign's state
 * merged in.
 *
 * Visibility is applied in SQL, not after the fact: an agitator's query never
 * loads a house they are not assigned to, so there is no window in which a
 * phone number for somebody else's building exists in the response at all.
 */
export function listHouses(
  database: DatabaseSync,
  options: ListHousesOptions,
): HouseRecord[] {
  const visibility = houseVisibilitySql(
    options.viewer,
    options.campaignId,
    "h",
  );
  const now = new Date();

  const rows = database.prepare(
    buildHouseSelect(visibility.sql),
  ).all({
    ...visibility.parameters,
    campaignId: options.campaignId,
    now: now.toISOString(),
    today: now.toISOString().slice(
      0,
      10,
    ),
  } as never) as Record<string, unknown>[];

  const houseIds = rows.map((row) => String(row.id));
  const assignees = readAssignees(
    database,
    options.campaignId,
    houseIds,
  );
  const precincts = readPrecinctLinks(
    database,
    houseIds,
  );

  return rows.map((row) => {
    const id = String(row.id);

    return rowToHouse(
      row,
      assignees.get(id) ?? [],
      precincts.get(id) ?? [],
      canSeeContacts(
        options.viewer,
        assignees.get(id) ?? [],
      ),
    );
  });
}

export function findHouse(
  database: DatabaseSync,
  houseId: string,
  options: ListHousesOptions,
): HouseRecord | null {
  const visibility = houseVisibilitySql(
    options.viewer,
    options.campaignId,
    "h",
  );
  const now = new Date();

  const rows = database.prepare(
    buildHouseSelect(
      visibility.sql,
      "AND h.id = :houseId",
    ),
  ).all({
    ...visibility.parameters,
    campaignId: options.campaignId,
    houseId,
    now: now.toISOString(),
    today: now.toISOString().slice(
      0,
      10,
    ),
  } as never) as Record<string, unknown>[];

  const row = rows[0];

  if (!row) {
    return null;
  }

  const assignees = readAssignees(
    database,
    options.campaignId,
    [houseId],
  ).get(houseId) ?? [];

  return rowToHouse(
    row,
    assignees,
    readPrecinctLinks(
      database,
      [houseId],
    ).get(houseId) ?? [],
    canSeeContacts(
      options.viewer,
      assignees,
    ),
  );
}

/**
 * Refuses to go on unless the viewer may work with this house.
 *
 * The same answer as {@link getHouse} gives, without assembling the record:
 * this exists for the write paths that take an id of something *attached* to a
 * house — a resident link, a precinct link, an attachment — where the house
 * itself is never loaded and the check would otherwise be skipped entirely.
 *
 * Cheap on purpose. `getHouse` reads a wide row plus assignees and precinct
 * links to build a `HouseRecord`; a guard that throws away everything it built
 * would put that cost on every such write for nothing.
 */
export function assertHouseVisible(
  database: DatabaseSync,
  houseId: string,
  options: ListHousesOptions,
): void {
  const visibility = houseVisibilitySql(
    options.viewer,
    options.campaignId,
    "h",
  );
  const row = database.prepare(`
    SELECT 1 AS ok FROM houses h
    WHERE h.id = :houseId
      AND h.deleted_at IS NULL
      AND (${visibility.sql})
  `).get({
    ...visibility.parameters,
    houseId,
  } as never) as Record<string, unknown> | undefined;

  if (!row) {
    // Same answer as an unknown id, for the same reason as `getHouse`.
    throw new HttpError(
      404,
      "Будинок не знайдено.",
    );
  }
}

export function getHouse(
  database: DatabaseSync,
  houseId: string,
  options: ListHousesOptions,
): HouseRecord {
  const house = findHouse(
    database,
    houseId,
    options,
  );

  if (!house) {
    // Deliberately the same answer for "does not exist" and "not yours": a 403
    // here would confirm that a house at that id exists.
    throw new HttpError(
      404,
      "Будинок не знайдено.",
    );
  }

  return house;
}

/** Existence check that ignores visibility — for foreign-key validation. */
export function houseExists(
  database: DatabaseSync,
  houseId: string,
): boolean {
  const row = database.prepare(`
    SELECT id FROM houses WHERE id = ? AND deleted_at IS NULL
  `).get(houseId);

  return Boolean(row);
}

export function assertHouseExists(
  database: DatabaseSync,
  houseId: string,
): void {
  if (!houseExists(
    database,
    houseId,
  )) {
    throw new HttpError(
      400,
      "Вказаного будинку не існує.",
    );
  }
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export interface HouseAttributesInput {
  street?: unknown;
  number?: unknown;
  block?: unknown;
  streetShort?: unknown;
  address?: unknown;
  fullAddress?: unknown;
  city?: unknown;
  postalCode?: unknown;
  lat?: unknown;
  lon?: unknown;
  type?: unknown;
  building?: unknown;
  floors?: unknown;
  builtYear?: unknown;
  entrances?: unknown;
  apartments?: unknown;
  households?: unknown;
  residentsCount?: unknown;
  managingOrg?: unknown;
  accessNote?: unknown;
  name?: unknown;
  source?: unknown;
  geocodeStatus?: unknown;
  verified?: unknown;
  /** The `updatedAt` the editor loaded. See {@link assertNotStale}. */
  expectedUpdatedAt?: unknown;
}

const HOUSE_ATTRIBUTE_FIELDS = [
  "street",
  "number",
  "block",
  "streetShort",
  "address",
  "fullAddress",
  "city",
  "postalCode",
  "lat",
  "lon",
  "type",
  "building",
  "floors",
  "builtYear",
  "entrances",
  "apartments",
  "households",
  "residentsCount",
  "managingOrg",
  "accessNote",
  "source",
  "name",
] as const;

/**
 * Refuses a write built on a copy somebody else has already replaced.
 *
 * Without it the module is last-write-wins on a form that holds twenty fields:
 * two coordinators open the same house, the second one saves, and every field
 * the first one did not touch is silently rolled back to what it was when their
 * screen was drawn. The client sends the `updatedAt` it loaded; a mismatch is a
 * 409 the editor turns into "this record has changed, reload it" rather than a
 * save that quietly destroys somebody's work.
 *
 * Optional on purpose. Scripts, the importer and the quick actions in the card
 * write single fields and have no stale copy to be wrong about; only the
 * full-record editor sends it.
 */
function assertNotStale(
  expected: unknown,
  actual: string | null,
): void {
  if (expected === undefined || expected === null || expected === "") {
    return;
  }

  if (String(expected) !== String(actual ?? "")) {
    throw new HttpError(
      409,
      "Запис змінив інший користувач, поки ця форма була відкрита. " +
        "Оновіть картку, щоб побачити актуальні дані, і повторіть зміни.",
    );
  }
}

/**
 * Updates the permanent attributes of a building.
 *
 * `verified: true` stamps `verified_at`/`verified_by` from the server clock and
 * the caller's identity. There is no way to set either by hand — the whole
 * point of the field is that it says who actually checked.
 */
export function updateHouseAttributes(
  database: DatabaseSync,
  houseId: string,
  input: HouseAttributesInput,
  context: ChangeContext,
  options: ListHousesOptions,
): HouseRecord {
  const before = getHouse(
    database,
    houseId,
    options,
  );

  assertNotStale(
    input.expectedUpdatedAt,
    before.updatedAt,
  );

  const next = {
    street: input.street === undefined
      ? before.street
      : optionalText(
        input.street,
        "street",
        200,
      ),
    number: input.number === undefined
      ? before.number
      : optionalText(
        input.number,
        "number",
        40,
      ),
    block: input.block === undefined
      ? before.block
      : optionalText(
        input.block,
        "block",
        40,
      ),
    streetShort: input.streetShort === undefined
      ? before.streetShort
      : optionalText(
        input.streetShort,
        "streetShort",
        200,
      ),
    city: input.city === undefined
      ? before.city
      : optionalText(
        input.city,
        "city",
        120,
      ),
    postalCode: input.postalCode === undefined
      ? before.postalCode
      : optionalText(
        input.postalCode,
        "postalCode",
        20,
      ),
    lat: input.lat === undefined
      ? before.location.lat
      : requireLatitude(input.lat),
    lon: input.lon === undefined
      ? before.location.lon
      : requireLongitude(input.lon),
    type: input.type === undefined
      ? before.type
      : optionalOneOf(
        input.type,
        HOUSE_TYPES,
        "type",
        before.type as never,
      ),
    building: input.building === undefined
      ? before.building
      : optionalText(
        input.building,
        "building",
        80,
      ),
    floors: input.floors === undefined
      ? before.floors
      : optionalCount(
        input.floors,
        "floors",
        200,
      ),
    builtYear: input.builtYear === undefined
      ? before.builtYear
      : optionalCount(
        input.builtYear,
        "builtYear",
        2200,
      ),
    entrances: input.entrances === undefined
      ? before.entrances
      : optionalCount(
        input.entrances,
        "entrances",
        60,
      ),
    apartments: input.apartments === undefined
      ? before.apartments
      : optionalCount(
        input.apartments,
        "apartments",
        2000,
      ),
    households: input.households === undefined
      ? before.households
      : optionalCount(
        input.households,
        "households",
        2000,
      ),
    residentsCount: input.residentsCount === undefined
      ? before.residentsCount
      : optionalCount(
        input.residentsCount,
        "residentsCount",
        6000,
      ),
    managingOrg: input.managingOrg === undefined
      ? before.managingOrg
      : optionalText(
        input.managingOrg,
        "managingOrg",
        300,
      ),
    accessNote: input.accessNote === undefined
      ? before.accessNote
      : optionalText(
        input.accessNote,
        "accessNote",
        1000,
      ),
    name: input.name === undefined
      ? before.name
      : optionalNullableText(
        input.name,
        "name",
        300,
      ),
    // Where the record came from — "osm", "обхід 12.05", an ОСББ list. It was
    // in the input type and in the change-log field list, but no statement ever
    // wrote it, so the form silently discarded whatever was typed.
    source: input.source === undefined
      ? before.source
      : optionalText(
        input.source,
        "source",
        120,
      ),
  };

  if (
    next.apartments !== null &&
    next.entrances !== null &&
    next.apartments < next.entrances
  ) {
    badRequest("Квартир не може бути менше, ніж підʼїздів.");
  }

  const now = new Date().toISOString();
  const isVerifying = input.verified === true;
  const addressNormalized = normalizeAddress(
    next.street,
    next.number,
  );
  // The block joins the *displayed* address and stays out of
  // `address_normalized`: the normalised key is the duplicate-detection key,
  // and "58" with a block and "58" without one are genuinely the same number.
  const numberLabel = [
    next.number,
    next.block,
  ].filter(Boolean).join(", ");
  const address = input.address === undefined
    ? (next.street ? `${next.streetShort || next.street}, ${numberLabel}` : before.address)
    : optionalText(
      input.address,
      "address",
      300,
    );
  const fullAddress = input.fullAddress === undefined
    ? [
      next.street ? `${next.street}, ${numberLabel}` : address,
      next.city,
      next.postalCode,
    ].filter(Boolean).join(", ")
    : optionalText(
      input.fullAddress,
      "fullAddress",
      400,
    );

  database.prepare(`
    UPDATE houses SET
      street = ?, number = ?, block = ?, street_short = ?, address = ?,
      full_address = ?,
      address_normalized = ?, city = ?, postal_code = ?, lat = ?, lon = ?,
      type = ?, building = ?, floors = ?, built_year = ?, entrances = ?,
      apartments = ?, households = ?, residents_count = ?, managing_org = ?,
      access_note = ?, name = ?, source = ?, geocode_status = ?, updated_at = ?,
      verified_at = CASE WHEN ? = 1 THEN ? ELSE verified_at END,
      verified_by = CASE WHEN ? = 1 THEN ? ELSE verified_by END
    WHERE id = ?
  `).run(
    next.street,
    next.number,
    next.block,
    next.streetShort || next.street,
    address,
    fullAddress,
    addressNormalized,
    next.city,
    next.postalCode,
    next.lat,
    next.lon,
    next.type,
    next.building,
    next.floors,
    next.builtYear,
    next.entrances,
    next.apartments,
    next.households,
    next.residentsCount,
    next.managingOrg,
    next.accessNote,
    next.name,
    next.source,
    input.geocodeStatus === undefined
      ? before.geocodeStatus
      : optionalOneOf(
        input.geocodeStatus,
        [
          "osm",
          "manual",
          "imported",
          "unverified",
        ] as const,
        "geocodeStatus",
        before.geocodeStatus as never,
      ),
    now,
    isVerifying ? 1 : 0,
    now,
    isVerifying ? 1 : 0,
    context.actor,
    houseId,
  );

  logUpdate(
    database,
    context,
    "house",
    houseId,
    {
      ...before,
      lat: before.location.lat,
      lon: before.location.lon,
    } as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    HOUSE_ATTRIBUTE_FIELDS,
  );

  if (isVerifying) {
    logOperation(
      database,
      context,
      "house",
      houseId,
      "verify",
      {
        verifiedAt: now,
      },
    );
  }

  return getHouse(
    database,
    houseId,
    options,
  );
}

export interface HouseStateInput {
  stage?: unknown;
  priority?: unknown;
  priorityReason?: unknown;
  summary?: unknown;
  nextStep?: unknown;
  nextActionAt?: unknown;
  /** The state's own `updatedAt`, as the editor loaded it. */
  expectedUpdatedAt?: unknown;
}

/**
 * Upserts one house's state in one campaign.
 *
 * The row is created on first touch rather than seeded for every house at
 * campaign start: 6 000 rows of `not_started` carry no information, and their
 * absence reads as exactly that.
 */
export function updateHouseCampaignState(
  database: DatabaseSync,
  houseId: string,
  campaignId: string,
  input: HouseStateInput,
  context: ChangeContext,
  options: ListHousesOptions,
): HouseRecord {
  const before = getHouse(
    database,
    houseId,
    options,
  );

  assertNotStale(
    input.expectedUpdatedAt,
    before.campaign.updatedAt,
  );

  const now = new Date().toISOString();

  const next = {
    stage: input.stage === undefined
      ? before.campaign.stage
      : optionalOneOf(
        input.stage,
        WORK_STAGES,
        "stage",
        before.campaign.stage as never,
      ),
    priority: input.priority === undefined
      ? before.campaign.priority
      : optionalOneOf(
        input.priority,
        PRIORITIES,
        "priority",
        before.campaign.priority as never,
      ),
    priorityReason: input.priorityReason === undefined
      ? before.campaign.priorityReason
      : optionalText(
        input.priorityReason,
        "priorityReason",
        500,
      ),
    summary: input.summary === undefined
      ? before.campaign.summary
      : optionalText(
        input.summary,
        "summary",
        1000,
      ),
    nextStep: input.nextStep === undefined
      ? before.campaign.nextStep
      : optionalText(
        input.nextStep,
        "nextStep",
        500,
      ),
    nextActionAt: input.nextActionAt === undefined
      ? before.campaign.nextActionAt
      : optionalTimestamp(
        input.nextActionAt,
        "nextActionAt",
      ),
  };

  database.prepare(`
    INSERT INTO house_campaign_state (
      campaign_id, house_id, stage, priority, priority_reason, summary,
      next_step, next_action_at, created_at, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id, house_id) DO UPDATE SET
      stage = excluded.stage,
      priority = excluded.priority,
      priority_reason = excluded.priority_reason,
      summary = excluded.summary,
      next_step = excluded.next_step,
      next_action_at = excluded.next_action_at,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(
    campaignId,
    houseId,
    next.stage,
    next.priority,
    next.priorityReason,
    next.summary,
    next.nextStep,
    next.nextActionAt,
    now,
    now,
    context.actor,
  );

  logUpdate(
    database,
    {
      ...context,
      campaignId,
    },
    "houseCampaignState",
    `${campaignId}:${houseId}`,
    before.campaign as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    [
      "stage",
      "priority",
      "priorityReason",
      "summary",
      "nextStep",
      "nextActionAt",
    ],
  );

  return getHouse(
    database,
    houseId,
    options,
  );
}

/* ------------------------------------------------------------------ *
 * Precinct links
 * ------------------------------------------------------------------ */

export interface HousePrecinctInput {
  precinctId?: unknown;
  entrance?: unknown;
  apartmentFrom?: unknown;
  apartmentTo?: unknown;
  note?: unknown;
  source?: unknown;
}

/**
 * Files a building under a polling station.
 *
 * The visibility check is not bookkeeping — it closes a privilege escalation.
 * `houseVisibilitySql` grants a viewer every house linked to a precinct they
 * are assigned to, so a coordinator who may write this link freely can attach
 * any building in the district to their own precinct and thereby grant
 * themselves the building *and its residents' phone numbers*. Verified before
 * the fix: a coordinator holding two houses issued one request and read three.
 */
export function linkHouseToPrecinct(
  database: DatabaseSync,
  houseId: string,
  input: HousePrecinctInput,
  context: ChangeContext,
  options: ListHousesOptions,
): string {
  assertHouseExists(
    database,
    houseId,
  );
  assertHouseVisible(
    database,
    houseId,
    options,
  );

  const precinctId = requireText(
    input.precinctId,
    "precinctId",
    200,
  );
  const precinct = database.prepare(`
    SELECT id FROM precincts WHERE id = ? AND deleted_at IS NULL
  `).get(precinctId);

  if (!precinct) {
    throw new HttpError(
      400,
      "Вказаної дільниці не існує.",
    );
  }

  const apartmentFrom = optionalCount(
    input.apartmentFrom,
    "apartmentFrom",
    10_000,
  );
  const apartmentTo = optionalCount(
    input.apartmentTo,
    "apartmentTo",
    10_000,
  );

  if (
    apartmentFrom !== null &&
    apartmentTo !== null &&
    apartmentTo < apartmentFrom
  ) {
    badRequest("Кінець діапазону квартир менший за початок.");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    database.prepare(`
      INSERT INTO house_polling_stations (
        id, house_id, precinct_id, entrance, apartment_from, apartment_to,
        source, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      houseId,
      precinctId,
      optionalText(
        input.entrance,
        "entrance",
        20,
      ),
      apartmentFrom,
      apartmentTo,
      optionalText(
        input.source,
        "source",
        120,
      ) || "manual",
      optionalText(
        input.note,
        "note",
        500,
      ),
      now,
      now,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new HttpError(
        409,
        "Такий звʼязок будинку з дільницею вже існує.",
      );
    }

    throw error;
  }

  logCreate(
    database,
    context,
    "housePrecinct",
    id,
    {
      houseId,
      precinctId,
    },
  );

  return id;
}

export function unlinkHouseFromPrecinct(
  database: DatabaseSync,
  linkId: string,
  context: ChangeContext,
  options: ListHousesOptions,
): void {
  const row = database.prepare(`
    SELECT id, house_id, precinct_id FROM house_polling_stations WHERE id = ?
  `).get(linkId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new HttpError(
      404,
      "Звʼязок не знайдено.",
    );
  }

  // The mirror of `linkHouseToPrecinct`: this row decides who reaches the
  // building, and it is addressed by its own id, so without the check any
  // coordinator could cut a building out of a colleague's precinct.
  assertHouseVisible(
    database,
    String(row.house_id),
    options,
  );

  database.prepare("DELETE FROM house_polling_stations WHERE id = ?")
    .run(linkId);

  logOperation(
    database,
    context,
    "housePrecinct",
    linkId,
    "delete",
    {
      houseId: String(row.house_id),
      precinctId: String(row.precinct_id),
    },
  );
}

/* ------------------------------------------------------------------ *
 * Duplicate detection and merging
 * ------------------------------------------------------------------ */

export interface HouseDuplicateGroup {
  addressNormalized: string;
  houses: {
    id: string;
    address: string;
    osmId: number | null;
    lat: number;
    lon: number;
    source: string;
  }[];
}

/** Houses sharing a normalised address — candidates for a merge, not proof. */
export function findDuplicateHouses(
  database: DatabaseSync,
  limit = 100,
): HouseDuplicateGroup[] {
  const rows = database.prepare(`
    SELECT id, address, address_normalized, osm_id, lat, lon, source
    FROM houses
    WHERE deleted_at IS NULL
      AND address_normalized IN (
        SELECT address_normalized FROM houses
        WHERE deleted_at IS NULL AND address_normalized != ''
        GROUP BY address_normalized HAVING COUNT(*) > 1
      )
    ORDER BY address_normalized, address
    LIMIT ?
  `).all(limit * 8) as Record<string, unknown>[];

  const grouped = new Map<string, HouseDuplicateGroup>();

  for (const row of rows) {
    const key = String(row.address_normalized);
    const group = grouped.get(key) ?? {
      addressNormalized: key,
      houses: [],
    };

    group.houses.push({
      id: String(row.id),
      address: String(row.address),
      osmId: row.osm_id == null ? null : Number(row.osm_id),
      lat: Number(row.lat),
      lon: Number(row.lon),
      source: String(row.source ?? ""),
    });
    grouped.set(
      key,
      group,
    );
  }

  return [...grouped.values()].slice(
    0,
    limit,
  );
}

/**
 * Folds one house into another, keeping everything that was ever recorded.
 *
 * Related rows are repointed rather than deleted, the loser is soft-deleted and
 * keeps a `merged_into` pointer, and the whole operation is one entry in the
 * journal. Nothing about this is automatic: the route requires a manager and an
 * explicit pair of ids.
 */
export function mergeHouses(
  database: DatabaseSync,
  keepId: string,
  mergeId: string,
  context: ChangeContext,
): { movedRows: Record<string, number> } {
  if (keepId === mergeId) {
    badRequest("Не можна обʼєднати будинок сам із собою.");
  }

  assertHouseExists(
    database,
    keepId,
  );
  assertHouseExists(
    database,
    mergeId,
  );

  const movedRows: Record<string, number> = {};
  const now = new Date().toISOString();

  // `house_campaign_state` has a composite primary key, so a straight UPDATE
  // would collide whenever both houses have state in the same campaign. The
  // loser's state is only carried over for campaigns the winner has no row in.
  const stateMoved = database.prepare(`
    UPDATE house_campaign_state
    SET house_id = ?
    WHERE house_id = ?
      AND campaign_id NOT IN (
        SELECT campaign_id FROM house_campaign_state WHERE house_id = ?
      )
  `).run(
    keepId,
    mergeId,
    keepId,
  );

  movedRows.houseCampaignState = Number(stateMoved.changes ?? 0);

  database.prepare("DELETE FROM house_campaign_state WHERE house_id = ?")
    .run(mergeId);

  for (const table of [
    "actions",
    "issues",
    "tasks",
    "house_people",
    "attachments",
    "material_issues",
    "events",
  ]) {
    const result = database.prepare(`
      UPDATE ${table} SET house_id = ? WHERE house_id = ?
    `).run(
      keepId,
      mergeId,
    );

    movedRows[table] = Number(result.changes ?? 0);
  }

  // A precinct link that already exists on the winner would violate the unique
  // index, so only the genuinely new ones move across.
  const precinctMoved = database.prepare(`
    UPDATE house_polling_stations
    SET house_id = ?
    WHERE house_id = ?
      AND precinct_id NOT IN (
        SELECT precinct_id FROM house_polling_stations WHERE house_id = ?
      )
  `).run(
    keepId,
    mergeId,
    keepId,
  );

  movedRows.housePollingStations = Number(precinctMoved.changes ?? 0);

  database.prepare("DELETE FROM house_polling_stations WHERE house_id = ?")
    .run(mergeId);

  const assignmentsMoved = database.prepare(`
    UPDATE assignments SET scope_id = ?
    WHERE scope = 'house' AND scope_id = ?
  `).run(
    keepId,
    mergeId,
  );

  movedRows.assignments = Number(assignmentsMoved.changes ?? 0);

  database.prepare(`
    UPDATE houses SET deleted_at = ?, merged_into = ?, updated_at = ?
    WHERE id = ?
  `).run(
    now,
    keepId,
    now,
    mergeId,
  );

  logOperation(
    database,
    context,
    "house",
    keepId,
    "merge",
    {
      mergedFrom: mergeId,
      movedRows,
    },
  );
  logOperation(
    database,
    context,
    "house",
    mergeId,
    "merged_into",
    {
      keepId,
    },
  );

  return {
    movedRows,
  };
}
