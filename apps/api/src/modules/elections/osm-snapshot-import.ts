import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { type ChangeContext, logOperation } from "./change-log";
import { normalizeAddress } from "./elections.types";

/**
 * Imports the shipped OpenStreetMap snapshot into `houses`.
 *
 * This is the operation the whole "own house id" decision exists for. A house
 * is matched on `(osm_type, osm_id)`; when it is found the OSM-derived
 * attributes are refreshed **and the internal id is left alone**, so every
 * action, issue, task, contact and campaign state recorded against that
 * building survives a regenerated snapshot. Before this change the house id
 * *was* the OSM id, and a mapper redrawing an outline silently orphaned
 * everything anybody had entered about it.
 *
 * An object that has disappeared from OSM is marked `osm_status = 'missing'`
 * rather than deleted: the building is usually still standing, and the data
 * about it is certainly still wanted.
 *
 * Nothing here stores the geometry estimates the snapshot carries. They are
 * derived numbers, and storing them would make a guess indistinguishable from a
 * measurement once it aged.
 */

export interface SnapshotHouse {
  id?: string;
  osmType?: string;
  osmId?: number;
  street?: string;
  streetShort?: string;
  number?: string;
  address?: string;
  fullAddress?: string;
  name?: string | null;
  type?: string;
  building?: string;
  floors?: number | null;
  builtYear?: number | null;
  footprintAreaSqm?: number;
  location?: { lat: number; lon: number };
  footprint?: { lat: number; lon: number }[];
}

export interface SnapshotDocument {
  osmTimestamp?: string;
  coverage?: { box?: unknown };
  houses?: SnapshotHouse[];
}

export interface SnapshotImportReport {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  markedMissing: number;
  skipped: number;
  /** Rows the snapshot could not describe well enough to store. */
  problems: string[];
}

const OSM_MANAGED_COLUMNS = [
  "street",
  "street_short",
  "number",
  "address",
  "full_address",
  "address_normalized",
  "lat",
  "lon",
  "footprint",
  "footprint_area_sqm",
  "name",
  "type",
  "building",
  "floors",
  "built_year",
  "osm_timestamp",
] as const;

const KNOWN_TYPES = new Set([
  "apartments",
  "private",
  "dormitory",
  "public",
  "commercial",
  "other",
]);

function readSnapshotRow(
  house: SnapshotHouse,
): Record<string, unknown> | null {
  const location = house.location;

  if (
    !location ||
    !Number.isFinite(location.lat) ||
    !Number.isFinite(location.lon)
  ) {
    return null;
  }

  const idParts = String(house.id ?? "").split("/");
  const osmType = house.osmType ?? (idParts.length === 2 ? idParts[0] : null);
  const osmId = house.osmId ?? (idParts.length === 2 ? Number(idParts[1]) : NaN);

  if (
    (osmType !== "way" && osmType !== "relation") ||
    !Number.isFinite(osmId)
  ) {
    return null;
  }

  const street = String(house.street ?? "");
  const number = String(house.number ?? "");

  return {
    osm_type: osmType,
    osm_id: Math.trunc(osmId),
    street,
    street_short: String(house.streetShort ?? street),
    number,
    address: String(house.address ?? ""),
    full_address: String(house.fullAddress ?? ""),
    address_normalized: normalizeAddress(
      street,
      number,
    ),
    lat: location.lat,
    lon: location.lon,
    footprint: JSON.stringify(house.footprint ?? []),
    footprint_area_sqm: Number.isFinite(house.footprintAreaSqm)
      ? Number(house.footprintAreaSqm)
      : null,
    name: house.name == null || house.name === "" ? null : String(house.name),
    type: KNOWN_TYPES.has(String(house.type)) ? String(house.type) : "other",
    building: String(house.building ?? ""),
    floors: Number.isFinite(house.floors) ? Number(house.floors) : null,
    built_year: Number.isFinite(house.builtYear) ? Number(house.builtYear) : null,
  };
}

/**
 * Applies a snapshot to the database.
 *
 * Idempotent by construction: a second run over an unchanged file reports every
 * house as `unchanged` and writes nothing. The caller supplies the transaction.
 */
export function importOsmSnapshot(
  database: DatabaseSync,
  document: SnapshotDocument,
  context: ChangeContext,
  options: { markMissing?: boolean } = {},
): SnapshotImportReport {
  const houses = document.houses ?? [];
  const report: SnapshotImportReport = {
    total: houses.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    markedMissing: 0,
    skipped: 0,
    problems: [],
  };
  const now = new Date().toISOString();
  const osmTimestamp = document.osmTimestamp ?? null;
  const seen = new Set<string>();

  const findByOsm = database.prepare(`
    SELECT * FROM houses WHERE osm_type = ? AND osm_id = ?
  `);

  for (const house of houses) {
    const row = readSnapshotRow(house);

    if (!row) {
      report.skipped += 1;

      if (report.problems.length < 50) {
        report.problems.push(
          `Пропущено ${house.id ?? "(без id)"}: немає координат або OSM-ідентифікатора.`,
        );
      }

      continue;
    }

    row.osm_timestamp = osmTimestamp;
    seen.add(`${row.osm_type}/${row.osm_id}`);

    const existing = findByOsm.get(
      row.osm_type as string,
      row.osm_id as number,
    ) as Record<string, unknown> | undefined;

    if (!existing) {
      const id = randomUUID();

      database.prepare(`
        INSERT INTO houses (
          id, osm_type, osm_id, osm_timestamp, osm_status, street, street_short,
          number, address, full_address, address_normalized, lat, lon,
          footprint, footprint_area_sqm, name, type, building, floors,
          built_year, source, geocode_status, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'osm', 'osm', ?, ?
        )
      `).run(
        id,
        row.osm_type as string,
        row.osm_id as number,
        osmTimestamp,
        row.street as string,
        row.street_short as string,
        row.number as string,
        row.address as string,
        row.full_address as string,
        row.address_normalized as string,
        row.lat as number,
        row.lon as number,
        row.footprint as string,
        row.footprint_area_sqm as number | null,
        row.name as string | null,
        row.type as string,
        row.building as string,
        row.floors as number | null,
        row.built_year as number | null,
        now,
        now,
      );

      report.created += 1;
      continue;
    }

    const changed = OSM_MANAGED_COLUMNS.filter((column) => {
      const before = existing[column];
      const after = row[column];

      if (before == null && after == null) {
        return false;
      }

      return String(before ?? "") !== String(after ?? "");
    });

    const wasMissing = String(existing.osm_status) === "missing";

    if (changed.length === 0 && !wasMissing) {
      report.unchanged += 1;
      continue;
    }

    database.prepare(`
      UPDATE houses SET
        street = ?, street_short = ?, number = ?, address = ?, full_address = ?,
        address_normalized = ?, lat = ?, lon = ?, footprint = ?,
        footprint_area_sqm = ?, name = ?, type = ?, building = ?, floors = ?,
        built_year = ?, osm_timestamp = ?, osm_status = 'present', updated_at = ?
      WHERE id = ?
    `).run(
      row.street as string,
      row.street_short as string,
      row.number as string,
      row.address as string,
      row.full_address as string,
      row.address_normalized as string,
      row.lat as number,
      row.lon as number,
      row.footprint as string,
      row.footprint_area_sqm as number | null,
      row.name as string | null,
      row.type as string,
      row.building as string,
      row.floors as number | null,
      row.built_year as number | null,
      osmTimestamp,
      now,
      String(existing.id),
    );

    report.updated += 1;
  }

  if (options.markMissing !== false) {
    // Every house that came from OSM and is not in this snapshot. Marked, not
    // removed — the building is probably still there, and the work certainly is.
    const candidates = database.prepare(`
      SELECT id, osm_type, osm_id FROM houses
      WHERE osm_id IS NOT NULL AND deleted_at IS NULL AND osm_status = 'present'
    `).all() as Record<string, unknown>[];

    for (const candidate of candidates) {
      const key = `${String(candidate.osm_type)}/${Number(candidate.osm_id)}`;

      if (seen.has(key)) {
        continue;
      }

      database.prepare(`
        UPDATE houses SET osm_status = 'missing', updated_at = ? WHERE id = ?
      `).run(
        now,
        String(candidate.id),
      );

      report.markedMissing += 1;
    }
  }

  logOperation(
    database,
    {
      ...context,
      origin: "script",
    },
    "houses",
    "osm-snapshot",
    "import",
    report,
  );

  return report;
}
