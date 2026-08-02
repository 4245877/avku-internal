import type { DatabaseSync } from "node:sqlite";

import type { ElectionsViewer } from "./elections-access";
import { houseVisibilitySql } from "./elections-access";
import { OPEN_ISSUE_STATUSES, OPEN_TASK_STATUSES } from "./elections.types";
import { STALE_VERIFICATION_DAYS } from "./house-records";
import {
  type WorkspacePolygon,
  coversPoint,
  expandBox,
} from "./workspace-polygon";

/**
 * How far outside the boundary's own box a house may still be found.
 *
 * Comfortably more than the radius of any building, so the SQL box never
 * decides membership on its own — it is there to let the index skip most of the
 * table, and `coversPoint` makes the actual call.
 */
const BOUNDARY_SLACK_METERS = 120;

/**
 * What the map, the result list and the toolbar filters need — and nothing else.
 *
 * The card used to be paid for by every house on screen. One `GET /houses`
 * returned the full record for all of them: the free-text summary and priority
 * reason, the access note, the responsible people as objects, the precinct
 * links as objects, four fields describing the last action, every OSM attribute
 * and the building outline. Almost none of that is on screen until somebody
 * picks a building, and some of it is nobody's business until then — so the bulk
 * answer carries only what is drawn or filtered on, and `GET /houses/:id`
 * carries the rest.
 *
 * Two further rules keep it small:
 *
 *   • the outline is not here at all. It never changes, so it is served by
 *     `/houses/geometry` under its own version and cached by the browser
 *     instead of being downloaded again with every campaign update;
 *   • a field at its default is omitted rather than sent. On a district that
 *     has not been canvassed yet that is most of the payload, and the client
 *     fills the same defaults back in.
 */
export interface HouseMapRecord {
  id: string;
  /** Index into the shared street dictionary. */
  street: number;
  number: string;
  lat: number;
  lon: number;
  /** Present only when it differs from `not_started`. */
  stage?: string;
  /** Present only when it differs from `medium`. */
  priority?: string;
  type?: string;
  floors?: number;
  apartments?: number;
  entrances?: number;
  residents?: number;
  /**
   * Footprint area in m². The outline itself is not here, but the flat and
   * resident estimates are derived from its area, and one number is cheaper
   * than a ring by two orders of magnitude.
   */
  area?: number;
  /** Emails only — the filter matches on them and the row prints the first. */
  assignees?: string[];
  precincts?: string[];
  districts?: string[];
  lastActionAt?: string;
  nextActionAt?: string;
  openIssues?: number;
  openTasks?: number;
  overdueTasks?: number;
  todayTasks?: number;
  contacts?: number;
  quality?: string[];
  source?: string;
  name?: string;
}

export interface HouseMapPayload {
  houses: HouseMapRecord[];
  streets: string[];
  /** Rows the working-area boundary excluded, for the coverage notice. */
  outsideArea: number;
}

export interface ListHouseMapOptions {
  campaignId: string;
  viewer: ElectionsViewer;
  area: WorkspacePolygon | null;
}

/**
 * The bulk read.
 *
 * Every derived number is a grouped pass joined once, where the card's query
 * asks a correlated subquery per house. That is the whole difference between
 * the two at scale: the old shape ran nine subqueries against each of ~37 000
 * rows — including four separate ones that re-read the *same* last-action row,
 * each with its own sort, because four columns were wanted from it. Measured on
 * a 59 000-house database with a campaign's worth of visits, tasks and issues
 * behind it, that query took 1.72 s and this one takes 0.46 s.
 *
 * `EXPLAIN QUERY PLAN` confirms each CTE resolves through an existing index —
 * `idx_actions_house`, `idx_issues_house`, `idx_tasks_house`,
 * `idx_house_people_house` — so no new index is carried for this.
 */
function buildMapSelect(visibilitySql: string, boxSql: string): string {
  const openIssues = OPEN_ISSUE_STATUSES.map((status) => `'${status}'`).join(", ");
  const openTasks = OPEN_TASK_STATUSES.map((status) => `'${status}'`).join(", ");

  return `
    WITH duplicates AS (
      SELECT address_normalized, COUNT(*) AS n
      FROM houses
      WHERE deleted_at IS NULL
      GROUP BY address_normalized
      HAVING COUNT(*) > 1
    ),
    last_actions AS (
      SELECT house_id, MAX(happened_at) AS happened_at
      FROM actions
      WHERE campaign_id = :campaignId AND deleted_at IS NULL
      GROUP BY house_id
    ),
    issue_counts AS (
      SELECT house_id, COUNT(*) AS open_issues
      FROM issues
      WHERE campaign_id = :campaignId AND deleted_at IS NULL
        AND status IN (${openIssues})
      GROUP BY house_id
    ),
    task_counts AS (
      SELECT house_id,
        COUNT(*) AS open_tasks,
        SUM(CASE WHEN due_at IS NOT NULL AND due_at < :now THEN 1 ELSE 0 END)
          AS overdue_tasks,
        SUM(CASE WHEN due_at IS NOT NULL AND substr(due_at, 1, 10) = :today
          THEN 1 ELSE 0 END) AS today_tasks
      FROM tasks
      WHERE campaign_id = :campaignId AND deleted_at IS NULL
        AND status IN (${openTasks})
      GROUP BY house_id
    ),
    contact_counts AS (
      -- People who can actually be reached. The card's query counts contact
      -- rows, so a resident with three numbers counts three; nothing reads that
      -- number here beyond "is it zero", and one reachable person is one
      -- reachable person.
      SELECT hp.house_id, COUNT(*) AS contacts
      FROM house_people hp
      WHERE hp.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM person_contacts pc
          WHERE pc.person_id = hp.person_id AND pc.deleted_at IS NULL
        )
      GROUP BY hp.house_id
    )
    SELECT
      h.id, h.street, h.street_short, h.number, h.lat, h.lon, h.type, h.name,
      h.floors, h.entrances, h.apartments, h.households, h.residents_count,
      h.footprint_area_sqm, h.source, h.osm_status, h.verified_at,
      s.stage, s.priority, s.next_action_at,
      la.happened_at AS last_action_at,
      d.n AS duplicate_address_count,
      COALESCE(ic.open_issues, 0) AS open_issues_count,
      COALESCE(tc.open_tasks, 0) AS open_tasks_count,
      COALESCE(tc.overdue_tasks, 0) AS overdue_tasks_count,
      COALESCE(tc.today_tasks, 0) AS today_tasks_count,
      COALESCE(cc.contacts, 0) AS contacts_count
    FROM houses h
    LEFT JOIN house_campaign_state s
      ON s.house_id = h.id AND s.campaign_id = :campaignId
    LEFT JOIN last_actions la ON la.house_id = h.id
    LEFT JOIN duplicates d ON d.address_normalized = h.address_normalized
    LEFT JOIN issue_counts ic ON ic.house_id = h.id
    LEFT JOIN task_counts tc ON tc.house_id = h.id
    LEFT JOIN contact_counts cc ON cc.house_id = h.id
    WHERE h.deleted_at IS NULL
      AND (${visibilitySql})
      ${boxSql}
    ORDER BY h.street, h.number
  `;
}

/**
 * Reads a one-to-many table for every house in one pass.
 *
 * Not by `IN (…)`: binding one parameter per house is what made the endpoint
 * fail outright — SQLite refuses more than 32 766 of them, and the assignment
 * read bound two per house, so a campaign of more than ~16 000 visible
 * buildings returned "too many SQL variables" instead of a map. The set of
 * houses is already `campaign_id` plus the visibility clause, so the join can
 * say so directly and bind nothing per row.
 */
function readAssigneeEmails(
  database: DatabaseSync,
  campaignId: string,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  const rows = database.prepare(`
    SELECT a.employee_email AS email,
           CASE WHEN a.scope = 'house' THEN a.scope_id ELSE hp.house_id END AS house_id
    FROM assignments a
    LEFT JOIN house_polling_stations hp
      ON a.scope = 'precinct' AND hp.precinct_id = a.scope_id
    WHERE a.campaign_id = ?
      AND a.deleted_at IS NULL
      AND a.status = 'active'
  `).all(campaignId) as Record<string, unknown>[];

  for (const row of rows) {
    const houseId = row.house_id == null ? "" : String(row.house_id);

    if (!houseId) {
      continue;
    }

    const list = grouped.get(houseId);
    const email = String(row.email);

    if (list) {
      if (!list.includes(email)) {
        list.push(email);
      }
    } else {
      grouped.set(
        houseId,
        [email],
      );
    }
  }

  return grouped;
}

function readPrecinctTags(
  database: DatabaseSync,
): Map<string, { precincts: string[]; districts: string[] }> {
  const grouped = new Map<string, { precincts: string[]; districts: string[] }>();

  const rows = database.prepare(`
    SELECT hps.house_id, hps.precinct_id, p.district
    FROM house_polling_stations hps
    JOIN precincts p ON p.id = hps.precinct_id AND p.deleted_at IS NULL
  `).all() as Record<string, unknown>[];

  for (const row of rows) {
    const houseId = String(row.house_id);
    const entry = grouped.get(houseId) ?? {
      precincts: [],
      districts: [],
    };
    const precinctId = String(row.precinct_id);
    const district = String(row.district ?? "");

    if (!entry.precincts.includes(precinctId)) {
      entry.precincts.push(precinctId);
    }

    if (district && !entry.districts.includes(district)) {
      entry.districts.push(district);
    }

    grouped.set(
      houseId,
      entry,
    );
  }

  return grouped;
}

function daysSince(iso: string | null): number | null {
  if (!iso) {
    return null;
  }

  const parsed = Date.parse(iso);

  return Number.isNaN(parsed) ? null : (Date.now() - parsed) / 86_400_000;
}

/**
 * The same findings the card reports, computed from the columns the map read
 * actually selects. Kept here rather than shared with `house-records` because
 * that one works from a `SELECT h.*` row and this one must not have to.
 */
function describeMapQuality(
  row: Record<string, unknown>,
  assigneeCount: number,
  overdueTasks: number,
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

  if (assigneeCount === 0) {
    quality.push("noAssignee");
  }

  if (overdueTasks > 0) {
    quality.push("overdueTasks");
  }

  return quality;
}

/** Six decimals is about 11 cm — finer than a building outline is surveyed. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function listHouseMap(
  database: DatabaseSync,
  options: ListHouseMapOptions,
): HouseMapPayload {
  const visibility = houseVisibilitySql(
    options.viewer,
    options.campaignId,
    "h",
  );
  const now = new Date();
  const area = options.area;

  /*
   * The boundary is applied in two steps. Its bounding box goes into SQL, where
   * `idx_houses_location` can use it to skip most of the table outright; the
   * polygon itself is then tested in JS on what survives. Doing the second step
   * in SQL would mean shipping a point-in-polygon function into SQLite for no
   * gain, and doing neither is what used to send four houses out of five to a
   * client that immediately threw them away.
   */
  const parameters: Record<string, unknown> = {
    ...visibility.parameters,
    campaignId: options.campaignId,
    now: now.toISOString(),
    today: now.toISOString().slice(
      0,
      10,
    ),
  };

  let boxSql = "";

  if (area) {
    // Widened, because a house that merely crosses the boundary is kept and its
    // centre can sit outside the polygon's own box. The margin is larger than
    // any building's radius, so the polygon test below is what actually decides.
    const box = expandBox(
      area.box,
      BOUNDARY_SLACK_METERS,
    );

    boxSql = "AND h.lat BETWEEN :minLat AND :maxLat " +
      "AND h.lon BETWEEN :minLon AND :maxLon";
    parameters.minLat = box.minLat;
    parameters.maxLat = box.maxLat;
    parameters.minLon = box.minLon;
    parameters.maxLon = box.maxLon;
  }

  const rows = database.prepare(
    buildMapSelect(
      visibility.sql,
      boxSql,
    ),
  ).all(parameters as never) as Record<string, unknown>[];

  const assignees = readAssigneeEmails(
    database,
    options.campaignId,
  );
  const precincts = readPrecinctTags(database);

  const streetIndex = new Map<string, number>();
  const streets: string[] = [];
  const houses: HouseMapRecord[] = [];
  let outsideArea = 0;

  for (const row of rows) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);

    if (area && !coversPoint(
      area,
      lat,
      lon,
      row.footprint_area_sqm == null ? null : Number(row.footprint_area_sqm),
    )) {
      outsideArea += 1;
      continue;
    }

    const id = String(row.id);
    // The short form is what the list and the search field print; the long one
    // is only ever "<street>, <number>", which the client can rebuild.
    const streetName = String(row.street_short ?? "") || String(row.street ?? "");
    let street = streetIndex.get(streetName);

    if (street === undefined) {
      street = streets.length;
      streets.push(streetName);
      streetIndex.set(
        streetName,
        street,
      );
    }

    const houseAssignees = assignees.get(id) ?? [];
    const overdueTasks = Number(row.overdue_tasks_count ?? 0);
    const tags = precincts.get(id);

    const record: HouseMapRecord = {
      id,
      street,
      number: String(row.number ?? ""),
      lat: round6(lat),
      lon: round6(lon),
    };

    const stage = String(row.stage ?? "not_started");

    if (stage !== "not_started") {
      record.stage = stage;
    }

    const priority = String(row.priority ?? "medium");

    if (priority !== "medium") {
      record.priority = priority;
    }

    const type = String(row.type ?? "other");

    if (type !== "other") {
      record.type = type;
    }

    if (row.name != null) {
      record.name = String(row.name);
    }

    if (row.floors != null) {
      record.floors = Number(row.floors);
    }

    if (row.entrances != null) {
      record.entrances = Number(row.entrances);
    }

    if (row.apartments != null) {
      record.apartments = Number(row.apartments);
    }

    if (row.residents_count != null) {
      record.residents = Number(row.residents_count);
    }

    if (row.footprint_area_sqm != null) {
      record.area = Math.round(Number(row.footprint_area_sqm));
    }

    if (houseAssignees.length > 0) {
      record.assignees = houseAssignees;
    }

    if (tags && tags.precincts.length > 0) {
      record.precincts = tags.precincts;
    }

    if (tags && tags.districts.length > 0) {
      record.districts = tags.districts;
    }

    if (row.last_action_at != null) {
      record.lastActionAt = String(row.last_action_at);
    }

    if (row.next_action_at != null) {
      record.nextActionAt = String(row.next_action_at);
    }

    const openIssues = Number(row.open_issues_count ?? 0);

    if (openIssues > 0) {
      record.openIssues = openIssues;
    }

    const openTasks = Number(row.open_tasks_count ?? 0);

    if (openTasks > 0) {
      record.openTasks = openTasks;
    }

    if (overdueTasks > 0) {
      record.overdueTasks = overdueTasks;
    }

    const todayTasks = Number(row.today_tasks_count ?? 0);

    if (todayTasks > 0) {
      record.todayTasks = todayTasks;
    }

    const contacts = Number(row.contacts_count ?? 0);

    if (contacts > 0) {
      record.contacts = contacts;
    }

    const source = String(row.source ?? "");

    if (source && source !== "osm") {
      record.source = source;
    }

    const quality = describeMapQuality(
      row,
      houseAssignees.length,
      overdueTasks,
    );

    if (quality.length > 0) {
      record.quality = quality;
    }

    houses.push(record);
  }

  return {
    houses,
    streets,
    outsideArea,
  };
}

/**
 * Building outlines, addressed by a version of their own.
 *
 * Split off from the map payload because the two age at completely different
 * rates: a stage changes several times a day, an outline changes when somebody
 * redraws it in OpenStreetMap. Bundling them meant re-downloading 1.6 MB of
 * unchanged geometry on every visit. Here the client asks for one `version`,
 * and as long as it asks for the same one the browser answers from its own
 * cache without reaching the server at all.
 */
export interface HouseGeometryPayload {
  version: string;
  /** `[lat, lon, lat, lon, …]` — half the JSON of an array of objects. */
  footprints: Record<string, number[]>;
}

export function readGeometryVersion(
  database: DatabaseSync,
  area: WorkspacePolygon | null,
): string {
  const row = database.prepare(`
    SELECT COUNT(*) AS n, MAX(updated_at) AS newest
    FROM houses
    WHERE deleted_at IS NULL
  `).get() as Record<string, unknown>;

  // The boundary is part of the identity: it decides which outlines are in the
  // answer, so redrawing it has to invalidate a cached copy.
  return [
    String(row.n ?? 0),
    String(row.newest ?? ""),
    area ? area.signature : "all",
  ].join("-");
}

export function listHouseGeometry(
  database: DatabaseSync,
  options: { viewer: ElectionsViewer; campaignId: string; area: WorkspacePolygon | null },
): HouseGeometryPayload {
  const visibility = houseVisibilitySql(
    options.viewer,
    options.campaignId,
    "h",
  );
  const area = options.area;
  const parameters: Record<string, unknown> = {
    ...visibility.parameters,
  };
  let boxSql = "";

  if (area) {
    // Widened, because a house that merely crosses the boundary is kept and its
    // centre can sit outside the polygon's own box. The margin is larger than
    // any building's radius, so the polygon test below is what actually decides.
    const box = expandBox(
      area.box,
      BOUNDARY_SLACK_METERS,
    );

    boxSql = "AND h.lat BETWEEN :minLat AND :maxLat " +
      "AND h.lon BETWEEN :minLon AND :maxLon";
    parameters.minLat = box.minLat;
    parameters.maxLat = box.maxLat;
    parameters.minLon = box.minLon;
    parameters.maxLon = box.maxLon;
  }

  const rows = database.prepare(`
    SELECT h.id, h.lat, h.lon, h.footprint, h.footprint_area_sqm
    FROM houses h
    WHERE h.deleted_at IS NULL
      AND h.footprint IS NOT NULL
      AND (${visibility.sql})
      ${boxSql}
  `).all(parameters as never) as Record<string, unknown>[];

  const footprints: Record<string, number[]> = {};

  for (const row of rows) {
    if (area && !coversPoint(
      area,
      Number(row.lat),
      Number(row.lon),
      row.footprint_area_sqm == null ? null : Number(row.footprint_area_sqm),
    )) {
      continue;
    }

    const flat = flattenFootprint(row.footprint);

    if (flat.length >= 6) {
      footprints[String(row.id)] = flat;
    }
  }

  return {
    version: readGeometryVersion(
      database,
      area,
    ),
    footprints,
  };
}

function flattenFootprint(value: unknown): number[] {
  if (value == null) {
    return [];
  }

  try {
    const parsed = JSON.parse(String(value)) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    const flat: number[] = [];

    for (const point of parsed) {
      const lat = (point as { lat?: unknown } | null)?.lat;
      const lon = (point as { lon?: unknown } | null)?.lon;

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        flat.push(
          round6(Number(lat)),
          round6(Number(lon)),
        );
      }
    }

    return flat;
  } catch {
    return [];
  }
}
