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
  CAMPAIGN_STATUSES,
  type CampaignStatus,
  badRequest,
  optionalNullableText,
  optionalOneOf,
  optionalText,
  optionalTimestamp,
  requireText,
} from "./elections.types";

/**
 * Campaigns and polling precincts — the two axes the rest of the module hangs
 * off.
 *
 * A campaign owns its territory and its headquarters. Both used to be constants
 * in the client bundle (`geo.js:AREA_CENTER`, `osmBuildings.js:HEADQUARTERS_OSM_ID`),
 * which made "run a second campaign" a code change and "keep last campaign's
 * results" impossible. Archiving is a status change, so a closed campaign keeps
 * every row that ever pointed at it.
 */

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  startsOn: string | null;
  endsOn: string | null;
  areaGeoJson: unknown | null;
  hqHouseId: string | null;
  hqAddress: string;
  hqLat: number | null;
  hqLon: number | null;
  note: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Precinct {
  id: string;
  number: string;
  district: string;
  address: string;
  lat: number | null;
  lon: number | null;
  boundaryGeoJson: unknown | null;
  source: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
  yearStats: PrecinctYearStat[];
}

export interface PrecinctYearStat {
  year: number;
  registeredVoters: number | null;
  turnout: number | null;
  note: string;
}

function parseJson(value: unknown): unknown | null {
  if (value == null) {
    return null;
  }

  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    // A hand-edited row must not take the whole list down with it.
    return null;
  }
}

function rowToCampaign(row: Record<string, unknown>): Campaign {
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as CampaignStatus,
    startsOn: row.starts_on == null ? null : String(row.starts_on),
    endsOn: row.ends_on == null ? null : String(row.ends_on),
    areaGeoJson: parseJson(row.area_geojson),
    hqHouseId: row.hq_house_id == null ? null : String(row.hq_house_id),
    hqAddress: String(row.hq_address ?? ""),
    hqLat: row.hq_lat == null ? null : Number(row.hq_lat),
    hqLon: row.hq_lon == null ? null : Number(row.hq_lon),
    note: String(row.note ?? ""),
    createdBy: String(row.created_by ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}

const CAMPAIGN_COLUMNS = `
  id, name, status, starts_on, ends_on, area_geojson, hq_house_id,
  hq_address, hq_lat, hq_lon, note, created_by, created_at, updated_at,
  archived_at
`;

export function listCampaigns(
  database: DatabaseSync,
  options: { includeArchived?: boolean } = {},
): Campaign[] {
  const rows = database.prepare(`
    SELECT ${CAMPAIGN_COLUMNS}
    FROM campaigns
    WHERE deleted_at IS NULL
      ${options.includeArchived ? "" : "AND status != 'archived'"}
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      COALESCE(starts_on, created_at) DESC
  `).all() as Record<string, unknown>[];

  return rows.map(rowToCampaign);
}

export function findCampaign(
  database: DatabaseSync,
  id: string,
): Campaign | null {
  const row = database.prepare(`
    SELECT ${CAMPAIGN_COLUMNS}
    FROM campaigns
    WHERE id = ? AND deleted_at IS NULL
  `).get(id) as Record<string, unknown> | undefined;

  return row ? rowToCampaign(row) : null;
}

export function getCampaign(
  database: DatabaseSync,
  id: string,
): Campaign {
  const campaign = findCampaign(
    database,
    id,
  );

  if (!campaign) {
    throw new HttpError(
      404,
      "Кампанію не знайдено.",
    );
  }

  return campaign;
}

/**
 * The campaign a request works in when it does not name one.
 *
 * `active` first, then the most recent draft. Returns `null` on an empty
 * database rather than inventing a campaign — the routes answer with an empty
 * dataset and the UI offers to create one.
 */
export function findDefaultCampaign(database: DatabaseSync): Campaign | null {
  const row = database.prepare(`
    SELECT ${CAMPAIGN_COLUMNS}
    FROM campaigns
    WHERE deleted_at IS NULL AND status IN ('active', 'draft')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
             COALESCE(starts_on, created_at) DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;

  return row ? rowToCampaign(row) : null;
}

export interface CampaignInput {
  name?: unknown;
  status?: unknown;
  startsOn?: unknown;
  endsOn?: unknown;
  areaGeoJson?: unknown;
  hqHouseId?: unknown;
  hqAddress?: unknown;
  hqLat?: unknown;
  hqLon?: unknown;
  note?: unknown;
}

function readCoordinate(
  value: unknown,
  field: string,
  limit: number,
): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
    badRequest(`Поле «${field}» поза допустимим діапазоном.`);
  }

  return parsed;
}

function assertHouseExists(
  database: DatabaseSync,
  houseId: string | null,
): void {
  if (!houseId) {
    return;
  }

  const row = database.prepare(`
    SELECT id FROM houses WHERE id = ? AND deleted_at IS NULL
  `).get(houseId);

  if (!row) {
    throw new HttpError(
      400,
      "Будинок штабу не знайдено.",
    );
  }
}

export function createCampaign(
  database: DatabaseSync,
  input: CampaignInput,
  context: ChangeContext,
): Campaign {
  const now = new Date().toISOString();
  const id = randomUUID();
  const hqHouseId = optionalNullableText(
    input.hqHouseId,
    "hqHouseId",
    200,
  );

  assertHouseExists(
    database,
    hqHouseId,
  );

  const record = {
    id,
    name: requireText(
      input.name,
      "name",
      200,
    ),
    status: optionalOneOf(
      input.status,
      CAMPAIGN_STATUSES,
      "status",
      "draft",
    ),
    startsOn: optionalTimestamp(
      input.startsOn,
      "startsOn",
    ),
    endsOn: optionalTimestamp(
      input.endsOn,
      "endsOn",
    ),
    areaGeoJson: input.areaGeoJson == null
      ? null
      : JSON.stringify(input.areaGeoJson),
    hqHouseId,
    hqAddress: optionalText(
      input.hqAddress,
      "hqAddress",
      300,
    ),
    hqLat: readCoordinate(
      input.hqLat,
      "hqLat",
      90,
    ),
    hqLon: readCoordinate(
      input.hqLon,
      "hqLon",
      180,
    ),
    note: optionalText(
      input.note,
      "note",
      2000,
    ),
  };

  if (record.startsOn && record.endsOn && record.endsOn < record.startsOn) {
    badRequest("Дата завершення кампанії раніша за дату початку.");
  }

  database.prepare(`
    INSERT INTO campaigns (
      id, name, status, starts_on, ends_on, area_geojson, hq_house_id,
      hq_address, hq_lat, hq_lon, note, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.name,
    record.status,
    record.startsOn,
    record.endsOn,
    record.areaGeoJson,
    record.hqHouseId,
    record.hqAddress,
    record.hqLat,
    record.hqLon,
    record.note,
    context.actor,
    now,
    now,
  );

  logCreate(
    database,
    {
      ...context,
      campaignId: id,
    },
    "campaign",
    id,
    {
      name: record.name,
      status: record.status,
    },
  );

  return getCampaign(
    database,
    id,
  );
}

const CAMPAIGN_UPDATABLE = [
  "name",
  "status",
  "startsOn",
  "endsOn",
  "areaGeoJson",
  "hqHouseId",
  "hqAddress",
  "hqLat",
  "hqLon",
  "note",
] as const;

export function updateCampaign(
  database: DatabaseSync,
  id: string,
  input: CampaignInput,
  context: ChangeContext,
): Campaign {
  const before = getCampaign(
    database,
    id,
  );
  const now = new Date().toISOString();

  const hqHouseId = input.hqHouseId === undefined
    ? before.hqHouseId
    : optionalNullableText(
      input.hqHouseId,
      "hqHouseId",
      200,
    );

  assertHouseExists(
    database,
    hqHouseId,
  );

  const next = {
    name: input.name === undefined
      ? before.name
      : requireText(
        input.name,
        "name",
        200,
      ),
    status: input.status === undefined
      ? before.status
      : optionalOneOf(
        input.status,
        CAMPAIGN_STATUSES,
        "status",
        before.status,
      ),
    startsOn: input.startsOn === undefined
      ? before.startsOn
      : optionalTimestamp(
        input.startsOn,
        "startsOn",
      ),
    endsOn: input.endsOn === undefined
      ? before.endsOn
      : optionalTimestamp(
        input.endsOn,
        "endsOn",
      ),
    areaGeoJson: input.areaGeoJson === undefined
      ? before.areaGeoJson
      : input.areaGeoJson,
    hqHouseId,
    hqAddress: input.hqAddress === undefined
      ? before.hqAddress
      : optionalText(
        input.hqAddress,
        "hqAddress",
        300,
      ),
    hqLat: input.hqLat === undefined
      ? before.hqLat
      : readCoordinate(
        input.hqLat,
        "hqLat",
        90,
      ),
    hqLon: input.hqLon === undefined
      ? before.hqLon
      : readCoordinate(
        input.hqLon,
        "hqLon",
        180,
      ),
    note: input.note === undefined
      ? before.note
      : optionalText(
        input.note,
        "note",
        2000,
      ),
  };

  if (next.startsOn && next.endsOn && next.endsOn < next.startsOn) {
    badRequest("Дата завершення кампанії раніша за дату початку.");
  }

  database.prepare(`
    UPDATE campaigns SET
      name = ?, status = ?, starts_on = ?, ends_on = ?, area_geojson = ?,
      hq_house_id = ?, hq_address = ?, hq_lat = ?, hq_lon = ?, note = ?,
      updated_at = ?,
      archived_at = CASE WHEN ? = 'archived'
        THEN COALESCE(archived_at, ?) ELSE NULL END
    WHERE id = ?
  `).run(
    next.name,
    next.status,
    next.startsOn,
    next.endsOn,
    next.areaGeoJson == null ? null : JSON.stringify(next.areaGeoJson),
    next.hqHouseId,
    next.hqAddress,
    next.hqLat,
    next.hqLon,
    next.note,
    now,
    next.status,
    now,
    id,
  );

  logUpdate(
    database,
    {
      ...context,
      campaignId: id,
    },
    "campaign",
    id,
    before as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    CAMPAIGN_UPDATABLE,
  );

  return getCampaign(
    database,
    id,
  );
}

/**
 * Archiving a campaign is a status change and nothing else: every house state,
 * action, issue and task that pointed at it still does, and stays readable to
 * the roles allowed to open an archive.
 */
export function archiveCampaign(
  database: DatabaseSync,
  id: string,
  context: ChangeContext,
): Campaign {
  const campaign = getCampaign(
    database,
    id,
  );

  if (campaign.status === "archived") {
    return campaign;
  }

  const now = new Date().toISOString();

  database.prepare(`
    UPDATE campaigns
    SET status = 'archived', archived_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    now,
    now,
    id,
  );

  logOperation(
    database,
    {
      ...context,
      campaignId: id,
    },
    "campaign",
    id,
    "archive",
    {
      previousStatus: campaign.status,
    },
  );

  return getCampaign(
    database,
    id,
  );
}

/* ------------------------------------------------------------------ *
 * Precincts
 * ------------------------------------------------------------------ */

function rowToPrecinct(
  row: Record<string, unknown>,
  yearStats: PrecinctYearStat[],
): Precinct {
  return {
    id: String(row.id),
    number: String(row.number),
    district: String(row.district ?? ""),
    address: String(row.address ?? ""),
    lat: row.lat == null ? null : Number(row.lat),
    lon: row.lon == null ? null : Number(row.lon),
    boundaryGeoJson: parseJson(row.boundary_geojson),
    source: String(row.source ?? "manual"),
    verifiedAt: row.verified_at == null ? null : String(row.verified_at),
    verifiedBy: row.verified_by == null ? null : String(row.verified_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    yearStats,
  };
}

function readYearStats(
  database: DatabaseSync,
  precinctIds: string[],
): Map<string, PrecinctYearStat[]> {
  const grouped = new Map<string, PrecinctYearStat[]>();

  if (precinctIds.length === 0) {
    return grouped;
  }

  const placeholders = precinctIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT precinct_id, year, registered_voters, turnout, note
    FROM precinct_year_stats
    WHERE precinct_id IN (${placeholders})
    ORDER BY year DESC
  `).all(...precinctIds) as Record<string, unknown>[];

  for (const row of rows) {
    const key = String(row.precinct_id);
    const list = grouped.get(key) ?? [];

    list.push({
      year: Number(row.year),
      registeredVoters: row.registered_voters == null
        ? null
        : Number(row.registered_voters),
      turnout: row.turnout == null ? null : Number(row.turnout),
      note: String(row.note ?? ""),
    });
    grouped.set(
      key,
      list,
    );
  }

  return grouped;
}

const PRECINCT_COLUMNS = `
  id, number, district, address, lat, lon, boundary_geojson, source,
  verified_at, verified_by, created_at, updated_at
`;

export function listPrecincts(database: DatabaseSync): Precinct[] {
  const rows = database.prepare(`
    SELECT ${PRECINCT_COLUMNS}
    FROM precincts
    WHERE deleted_at IS NULL
    ORDER BY CAST(number AS INTEGER), number
  `).all() as Record<string, unknown>[];

  const stats = readYearStats(
    database,
    rows.map((row) => String(row.id)),
  );

  return rows.map((row) =>
    rowToPrecinct(
      row,
      stats.get(String(row.id)) ?? [],
    ));
}

export function findPrecinct(
  database: DatabaseSync,
  id: string,
): Precinct | null {
  const row = database.prepare(`
    SELECT ${PRECINCT_COLUMNS}
    FROM precincts
    WHERE id = ? AND deleted_at IS NULL
  `).get(id) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return rowToPrecinct(
    row,
    readYearStats(
      database,
      [id],
    ).get(id) ?? [],
  );
}

export interface PrecinctInput {
  number?: unknown;
  district?: unknown;
  address?: unknown;
  lat?: unknown;
  lon?: unknown;
  boundaryGeoJson?: unknown;
  source?: unknown;
  verifiedAt?: unknown;
}

export function createPrecinct(
  database: DatabaseSync,
  input: PrecinctInput,
  context: ChangeContext,
): Precinct {
  const now = new Date().toISOString();
  const id = randomUUID();
  const number = requireText(
    input.number,
    "number",
    32,
  );

  const existing = database.prepare(`
    SELECT id FROM precincts WHERE number = ? AND deleted_at IS NULL
  `).get(number);

  if (existing) {
    throw new HttpError(
      409,
      `Дільниця №${number} уже існує.`,
    );
  }

  database.prepare(`
    INSERT INTO precincts (
      id, number, district, address, lat, lon, boundary_geojson,
      source, verified_at, verified_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    number,
    optionalText(
      input.district,
      "district",
      200,
    ),
    optionalText(
      input.address,
      "address",
      300,
    ),
    readCoordinate(
      input.lat,
      "lat",
      90,
    ),
    readCoordinate(
      input.lon,
      "lon",
      180,
    ),
    input.boundaryGeoJson == null
      ? null
      : JSON.stringify(input.boundaryGeoJson),
    optionalText(
      input.source,
      "source",
      120,
    ) || "manual",
    optionalTimestamp(
      input.verifiedAt,
      "verifiedAt",
    ),
    context.actor,
    now,
    now,
  );

  logCreate(
    database,
    context,
    "precinct",
    id,
    {
      number,
    },
  );

  return findPrecinct(
    database,
    id,
  ) as Precinct;
}

export function updatePrecinct(
  database: DatabaseSync,
  id: string,
  input: PrecinctInput,
  context: ChangeContext,
): Precinct {
  const before = findPrecinct(
    database,
    id,
  );

  if (!before) {
    throw new HttpError(
      404,
      "Дільницю не знайдено.",
    );
  }

  const next = {
    number: input.number === undefined
      ? before.number
      : requireText(
        input.number,
        "number",
        32,
      ),
    district: input.district === undefined
      ? before.district
      : optionalText(
        input.district,
        "district",
        200,
      ),
    address: input.address === undefined
      ? before.address
      : optionalText(
        input.address,
        "address",
        300,
      ),
    lat: input.lat === undefined
      ? before.lat
      : readCoordinate(
        input.lat,
        "lat",
        90,
      ),
    lon: input.lon === undefined
      ? before.lon
      : readCoordinate(
        input.lon,
        "lon",
        180,
      ),
    boundaryGeoJson: input.boundaryGeoJson === undefined
      ? before.boundaryGeoJson
      : input.boundaryGeoJson,
    source: input.source === undefined
      ? before.source
      : optionalText(
        input.source,
        "source",
        120,
      ) || before.source,
    verifiedAt: input.verifiedAt === undefined
      ? before.verifiedAt
      : optionalTimestamp(
        input.verifiedAt,
        "verifiedAt",
      ),
  };

  if (next.number !== before.number) {
    const clash = database.prepare(`
      SELECT id FROM precincts
      WHERE number = ? AND id != ? AND deleted_at IS NULL
    `).get(
      next.number,
      id,
    );

    if (clash) {
      throw new HttpError(
        409,
        `Дільниця №${next.number} уже існує.`,
      );
    }
  }

  database.prepare(`
    UPDATE precincts SET
      number = ?, district = ?, address = ?, lat = ?, lon = ?,
      boundary_geojson = ?, source = ?, verified_at = ?, verified_by = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    next.number,
    next.district,
    next.address,
    next.lat,
    next.lon,
    next.boundaryGeoJson == null
      ? null
      : JSON.stringify(next.boundaryGeoJson),
    next.source,
    next.verifiedAt,
    context.actor,
    new Date().toISOString(),
    id,
  );

  logUpdate(
    database,
    context,
    "precinct",
    id,
    before as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    [
      "number",
      "district",
      "address",
      "lat",
      "lon",
      "source",
      "verifiedAt",
    ],
  );

  return findPrecinct(
    database,
    id,
  ) as Precinct;
}

export function deletePrecinct(
  database: DatabaseSync,
  id: string,
  context: ChangeContext,
): void {
  const precinct = findPrecinct(
    database,
    id,
  );

  if (!precinct) {
    throw new HttpError(
      404,
      "Дільницю не знайдено.",
    );
  }

  database.prepare(`
    UPDATE precincts SET deleted_at = ?, updated_at = ? WHERE id = ?
  `).run(
    new Date().toISOString(),
    new Date().toISOString(),
    id,
  );

  logOperation(
    database,
    context,
    "precinct",
    id,
    "delete",
    {
      number: precinct.number,
    },
  );
}
