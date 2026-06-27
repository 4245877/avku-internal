import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORT,
  createCertificateRepository,
  createLogisticsRepository,
  createWarehouseRepository,
} from "./config";
import { createCertificateApiServer } from "./server";

async function main(): Promise<void> {
  const certificateRepository = createCertificateRepository();
  const warehouseRepository = createWarehouseRepository();
  const logisticsRepository = createLogisticsRepository();

  // Validate storage and templates before accepting traffic. The default
  // certificate template is mandatory, so a missing/broken default fails fast
  // here instead of on the first render; broken non-default templates (e.g. a
  // damaged English card) are logged and skipped, not fatal.
  await certificateRepository.check();
  await warehouseRepository.check();
  await logisticsRepository.check();

  if (process.argv.includes("--check")) {
    console.log(
      "Certificates, warehouse and logistics API storage check passed.",
    );
    return;
  }

  createCertificateApiServer({
    certificateRepository,
    warehouseRepository,
    logisticsRepository,
  }).listen(
    PORT,
    () => {
      console.log(`AVKU API is listening on http://localhost:${PORT}`);
    },
  );
}

function isMainModule(): boolean {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { createCertificateApiServer };
