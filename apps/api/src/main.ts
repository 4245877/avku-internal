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

  const server = createCertificateApiServer({
    certificateRepository,
    warehouseRepository,
    logisticsRepository,
  });

  server.listen(
    PORT,
    () => {
      console.log(`AVKU API is listening on http://localhost:${PORT}`);
    },
  );

  installProcessSafetyNets(server);
}

/**
 * Long-running production safety nets:
 *  - graceful shutdown on SIGTERM/SIGINT so a deploy/restart drains in-flight
 *    requests instead of dropping them mid-write;
 *  - last-resort handlers so an unexpected rejection/exception is logged (and
 *    the process exits deliberately) rather than crashing with an opaque
 *    default trace.
 */
function installProcessSafetyNets(server: import("node:http").Server): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully…`);

    // Stop accepting new connections and let active ones finish.
    server.close((error) => {
      if (error) {
        console.error("Error during server shutdown:", error);
        process.exit(1);
      }

      process.exit(0);
    });

    // Failsafe: don't hang forever if a connection refuses to close.
    const forceExit = setTimeout(() => {
      console.error("Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000);

    forceExit.unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(1);
  });
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
