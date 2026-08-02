import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { createElectionsRepository } from "../config";
import {
  createCampaign,
  findDefaultCampaign,
} from "../modules/elections/campaign-records";
import {
  importOsmSnapshot,
  type SnapshotDocument,
} from "../modules/elections/osm-snapshot-import";

/**
 * One-off (and repeatable) import of the shipped OSM snapshot into the houses
 * table.
 *
 *   pnpm --filter @avku/api exec tsx src/scripts/import-osm-snapshot.ts
 *   … --snapshot <path>          use a different snapshot file
 *   … --campaign "Вибори 2026"   create the first campaign if none exists
 *   … --keep-missing             do not flag objects absent from the snapshot
 *
 * Safe to run as often as you like: houses are matched on their OSM link, so a
 * second run over an unchanged file reports everything as unchanged and touches
 * nothing. Re-running after `pnpm --filter @avku/web data:houses` is the
 * intended way to pull fresh OSM attributes in without losing campaign data.
 */

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  if (index === -1) {
    return undefined;
  }

  const value = process.argv[index + 1];

  return value && !value.startsWith("--") ? value : "";
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function defaultSnapshotPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
    "apps/web/public/data/elections/houses.json",
  );
}

async function main(): Promise<void> {
  const snapshotPath = readFlag("snapshot") || defaultSnapshotPath();
  const actor = process.env.ELECTIONS_IMPORT_ACTOR ?? "script:import-osm-snapshot";

  console.log(`[elections] Читаю снапшот: ${snapshotPath}`);

  const document = JSON.parse(
    await readFile(
      snapshotPath,
      "utf8",
    ),
  ) as SnapshotDocument;

  console.log(
    `[elections] У файлі ${document.houses?.length ?? 0} будинків, ` +
      `osmTimestamp=${document.osmTimestamp ?? "—"}`,
  );

  const repository = createElectionsRepository();
  const report = await repository.withTransaction((database) => {
    const result = importOsmSnapshot(
      database,
      document,
      {
        actor,
        origin: "script",
      },
      {
        markMissing: !hasFlag("keep-missing"),
      },
    );

    const campaignName = readFlag("campaign");

    if (campaignName && !findDefaultCampaign(database)) {
      const campaign = createCampaign(
        database,
        {
          name: campaignName,
          status: "active",
        },
        {
          actor,
          origin: "script",
        },
      );

      console.log(
        `[elections] Створено кампанію «${campaign.name}» (${campaign.id}).`,
      );
    }

    return result;
  });

  const database = await repository.getDatabase();
  const total = database.prepare(
    "SELECT COUNT(*) AS total FROM houses WHERE deleted_at IS NULL",
  ).get() as Record<string, unknown>;

  console.log("[elections] Звіт імпорту:");
  console.log(`  у снапшоті:        ${report.total}`);
  console.log(`  створено:          ${report.created}`);
  console.log(`  оновлено:          ${report.updated}`);
  console.log(`  без змін:          ${report.unchanged}`);
  console.log(`  зникло з OSM:      ${report.markedMissing}`);
  console.log(`  пропущено:         ${report.skipped}`);
  console.log(`  усього в базі:     ${Number(total.total)}`);

  for (const problem of report.problems) {
    console.warn(`  ! ${problem}`);
  }
}

main().catch((error: unknown) => {
  console.error(
    "[elections] Імпорт снапшота не вдався:",
    error,
  );
  process.exitCode = 1;
});
