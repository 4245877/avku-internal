import type { HouseRecord } from "./house-records";

/**
 * Export builders for the "Вибори" module.
 *
 * Two shapes, and the difference between them is the point:
 *
 *   operational — addresses, stage, priority, counters. No names, no phones.
 *                 This is the default, and it is what reporting actually needs.
 *   full        — the operational columns plus contact names and numbers. Only
 *                 a manager can ask for it, it has to be requested explicitly,
 *                 and every call is written to the access journal.
 *
 * Neither shape has a column for a political position or an age band, at any
 * permission level. Those fields do not exist in the schema and there is no
 * flag that brings them back.
 */

export type ExportScope = "operational" | "full";

export interface ExportContact {
  houseId: string;
  fullName: string;
  role: string;
  contacts: { type: string; value: string }[];
}

const OPERATIONAL_COLUMNS = [
  "address",
  "street",
  "number",
  "precincts",
  "stage",
  "priority",
  "entrances",
  "apartments",
  "assignees",
  "lastActionAt",
  "nextActionAt",
  "openIssues",
  "overdueTasks",
  "verifiedAt",
  "source",
  "quality",
] as const;

const PERSONAL_COLUMNS = [
  "contactName",
  "contactRole",
  "contactPhones",
] as const;

/** RFC 4180 quoting — a field with a comma, quote or newline is quoted. */
function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);

  if (/[",\n\r;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function operationalRow(house: HouseRecord): (string | number)[] {
  return [
    house.address,
    house.street,
    house.number,
    house.precincts.map((link) => link.precinctNumber).join(" / "),
    house.campaign.stage,
    house.campaign.priority,
    house.entrances ?? "",
    house.apartments ?? "",
    house.campaign.assignees.map((assignee) => assignee.email).join(" "),
    house.campaign.lastActionAt ?? "",
    house.campaign.nextActionAt ?? "",
    house.campaign.openIssuesCount,
    house.campaign.overdueTasksCount,
    house.verifiedAt ?? "",
    house.source,
    house.quality.join(" "),
  ];
}

export interface BuildExportOptions {
  houses: HouseRecord[];
  scope: ExportScope;
  /** Contacts by house id — only consulted for the `full` scope. */
  contactsByHouse?: Map<string, ExportContact[]>;
}

/**
 * Builds the CSV body.
 *
 * The personal columns are not merely blanked for an operational export — they
 * are not emitted at all, so a file cannot be mistaken for a redacted version
 * of the full one.
 */
export function buildHousesCsv(options: BuildExportOptions): string {
  const isFull = options.scope === "full";
  const header = isFull
    ? [
      ...OPERATIONAL_COLUMNS,
      ...PERSONAL_COLUMNS,
    ]
    : [...OPERATIONAL_COLUMNS];
  const lines = [header.join(",")];

  for (const house of options.houses) {
    const base = operationalRow(house);

    if (!isFull) {
      lines.push(base.map(csvCell).join(","));
      continue;
    }

    const contacts = options.contactsByHouse?.get(house.id) ?? [];

    if (contacts.length === 0) {
      lines.push([
        ...base,
        "",
        "",
        "",
      ].map(csvCell).join(","));
      continue;
    }

    for (const contact of contacts) {
      lines.push([
        ...base,
        contact.fullName,
        contact.role,
        contact.contacts
          .filter((entry) => entry.type === "phone" || entry.type === "viber")
          .map((entry) => entry.value)
          .join(" "),
      ].map(csvCell).join(","));
    }
  }

  return `${lines.join("\r\n")}\r\n`;
}

/** Row count an export will produce, for the confirmation prompt and journal. */
export function countExportRows(options: BuildExportOptions): number {
  if (options.scope !== "full") {
    return options.houses.length;
  }

  return options.houses.reduce(
    (total, house) =>
      total + Math.max(
        1,
        options.contactsByHouse?.get(house.id)?.length ?? 1,
      ),
    0,
  );
}
