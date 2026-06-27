import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  createCertificateRepository,
  createLogisticsRepository,
  createWarehouseRepository,
} from "./config";
import type { CertificateRepository } from "./modules/certificates/certificate-records";
import type { WarehouseRepository } from "./modules/warehouse/warehouse-records";
import type { LogisticsRepository } from "./modules/logistics/logistics-records";
import { handleCertificateRequest } from "./routes/certificates";
import { handleWarehouseRequest } from "./routes/warehouse";
import { handleLogisticsRequest } from "./routes/logistics";
import {
  applyCors,
  sendError,
} from "./http/responses";
import { sanitizeError } from "./http/errors";

async function dispatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  certificateRepository: CertificateRepository,
  warehouseRepository: WarehouseRepository,
  logisticsRepository: LogisticsRepository,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const pathname = decodeURIComponent(url.pathname);

  if (
    pathname === "/api/warehouse" ||
    pathname.startsWith("/api/warehouse/")
  ) {
    await handleWarehouseRequest(
      request,
      response,
      warehouseRepository,
      pathname,
    );
    return;
  }

  if (
    pathname === "/api/logistics" ||
    pathname.startsWith("/api/logistics/")
  ) {
    await handleLogisticsRequest(
      request,
      response,
      logisticsRepository,
      pathname,
    );
    return;
  }

  await handleCertificateRequest(
    request,
    response,
    certificateRepository,
  );
}

export interface CertificateApiRepositories {
  certificateRepository: CertificateRepository;
  warehouseRepository: WarehouseRepository;
  logisticsRepository: LogisticsRepository;
}

export function createCertificateApiServer(
  repositories?: CertificateApiRepositories,
): http.Server {
  const certificateRepository =
    repositories?.certificateRepository ?? createCertificateRepository();
  const warehouseRepository =
    repositories?.warehouseRepository ?? createWarehouseRepository();
  const logisticsRepository =
    repositories?.logisticsRepository ?? createLogisticsRepository();

  return http.createServer((request, response) => {
    applyCors(
      request,
      response,
    );

    dispatchRequest(
      request,
      response,
      certificateRepository,
      warehouseRepository,
      logisticsRepository,
    ).catch((error: unknown) => {
      const sanitized = sanitizeError(error);

      // Keep the detailed error (absolute paths, system codes, stack) in the
      // server logs only; the client receives a neutral, sanitized message.
      if (sanitized.internal) {
        console.error(
          `Unhandled API error (${request.method} ${request.url}):`,
          error,
        );
      }

      sendError(
        response,
        sanitized.statusCode,
        sanitized.message,
      );
    });
  });
}
