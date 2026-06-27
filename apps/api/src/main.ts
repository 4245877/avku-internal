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
  if (process.argv.includes("--check")) {
    await createCertificateRepository().check();
    await createWarehouseRepository().check();
    await createLogisticsRepository().check();
    console.log(
      "Certificates, warehouse and logistics API storage check passed.",
    );
    return;
  }

  createCertificateApiServer().listen(
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
