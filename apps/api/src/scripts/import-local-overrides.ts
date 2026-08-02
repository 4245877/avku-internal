import { readFile } from "node:fs/promises";

import { createElectionsRepository } from "../config";
import { findDefaultCampaign } from "../modules/elections/campaign-records";
import {
  applyBatch,
  attachLegacyOsmMatch,
  createBatch,
  getBatch,
  legacyExportToRows,
  listBatchRows,
} from "../modules/elections/import-records";

/**
 * Imports a browser export of the old `avku-elections-details-v1` overlay.
 *
 *   tsx src/scripts/import-local-overrides.ts <export.json>            # preview
 *   tsx src/scripts/import-local-overrides.ts <export.json> --apply    # commit
 *
 * The file comes from «Експортувати старі дані» in the "Вибори" header, which
 * is the *only* copy of work entered before the backend existed. Nothing is
 * written until `--apply`, and even then only rows that matched a house
 * outright; anything ambiguous is left in the batch as `needs_review` and
 * listed at the end, so no record is lost quietly.
 *
 * Political positions and age bands from the old resident records are stripped
 * during normalisation. The report counts them and never prints their values.
 */

async function main(): Promise<void> {
  const [filePath] = process.argv.slice(2).filter((argument) =>
    !argument.startsWith("--")
  );

  if (!filePath) {
    console.error(
      "Вкажіть файл експорту: tsx src/scripts/import-local-overrides.ts <export.json> [--apply]",
    );
    process.exitCode = 1;
    return;
  }

  const shouldApply = process.argv.includes("--apply");
  const actor = process.env.ELECTIONS_IMPORT_ACTOR ??
    "script:import-local-overrides";
  const document = JSON.parse(
    await readFile(
      filePath,
      "utf8",
    ),
  ) as Record<string, unknown>;

  const rows = legacyExportToRows(document as never);

  console.log(
    `[elections] У файлі ${
      Object.keys((document.entries ?? {}) as object).length
    } будинків із даними, розгорнуто у ${rows.length} рядків імпорту.`,
  );

  if (rows.length === 0) {
    console.log("[elections] Немає що імпортувати.");
    return;
  }

  const repository = createElectionsRepository();
  const batch = await repository.withTransaction((database) => {
    const created = createBatch(
      database,
      {
        kind: "legacy_local",
        fileName: filePath,
        campaignId: findDefaultCampaign(database)?.id ?? null,
        rows,
      },
      {
        actor,
        origin: "import",
      },
    );

    attachLegacyOsmMatch(
      database,
      created.id,
    );

    return getBatch(
      database,
      created.id,
    );
  });

  const database = await repository.getDatabase();
  const staged = listBatchRows(
    database,
    batch.id,
    {
      limit: 20_000,
    },
  );
  const ready = staged.filter((row) => row.status === "ready").length;
  const review = staged.filter((row) => row.status === "needs_review").length;

  console.log(`[elections] Партія ${batch.id}`);
  console.log(`  готово до застосування: ${ready}`);
  console.log(`  потребує рішення:       ${review}`);
  console.log(`  очищено полів:          ${batch.cleanedFieldsCount}`);

  for (const row of staged.filter((entry) => entry.status === "needs_review")) {
    console.warn(
      `  ! рядок ${row.rowNumber}: ${row.notes.join(" ") || "потребує рішення"}`,
    );
  }

  if (!shouldApply) {
    console.log(
      "[elections] Це попередній перегляд. Запустіть із --apply, щоб записати " +
        "готові рядки, або відкрийте партію на сторінці імпорту, щоб ухвалити " +
        "рішення щодо спірних.",
    );
    return;
  }

  const campaignId = findDefaultCampaign(database)?.id ?? null;
  const report = await repository.withTransaction((db) =>
    applyBatch(
      db,
      batch.id,
      campaignId,
      {
        actor,
        origin: "import",
      },
    ));

  console.log("[elections] Застосовано:");
  console.log(`  оновлено будинків:  ${report.updated}`);
  console.log(`  створено записів:   ${report.created}`);
  console.log(`  зіставлено:         ${report.merged}`);
  console.log(`  пропущено:          ${report.skipped}`);
  console.log(`  потребує рішення:   ${report.needsReview}`);
  console.log(`  помилок:            ${report.failed}`);
  console.log(`  очищено полів:      ${report.cleanedFields}`);
  console.log(
    `[elections] Відкотити повністю: POST /api/elections/import/${batch.id}/rollback`,
  );

  if (report.unmatchedAddresses.length > 0) {
    console.warn("[elections] Не зіставлені адреси (дані НЕ втрачено):");

    for (const address of report.unmatchedAddresses.slice(
      0,
      100,
    )) {
      console.warn(`  ? ${address}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    "[elections] Імпорт локальних даних не вдався:",
    error,
  );
  process.exitCode = 1;
});
