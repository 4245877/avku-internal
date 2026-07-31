import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  createAccessAuthenticatorFromEnv,
  createCertificateRepository,
  createEmployeeRepository,
  createLogisticsRepository,
  createWarehouseRepository,
  createWorkspaceAreaRepository,
} from "./config";
import type { CertificateRepository } from "./modules/certificates/certificate-records";
import type { WarehouseRepository } from "./modules/warehouse/warehouse-records";
import type { LogisticsRepository } from "./modules/logistics/logistics-records";
import type { EmployeeRepository } from "./modules/employees/employee-records";
import type { WorkspaceAreaRepository } from "./modules/elections/workspace-area-records";
import type { AccessAuthenticator } from "./http/access-auth";
import { handleCertificateRequest } from "./routes/certificates";
import { handleWarehouseRequest } from "./routes/warehouse";
import { handleLogisticsRequest } from "./routes/logistics";
import { handleElectionsRequest } from "./routes/elections";
import { handleMeRequest } from "./routes/employees";
import {
  applyCors,
  sendError,
} from "./http/responses";
import { sanitizeError } from "./http/errors";

async function dispatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repositories: CertificateApiRepositories,
  authenticator: AccessAuthenticator,
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

  // Verify Cloudflare Access before touching any domain route: a forged/invalid
  // JWT is rejected here (401); a request with no JWT is trusted local access.
  // When an Access identity is present it is recorded (JIT provisioning +
  // last_seen) so the API knows who is acting.
  const identity = await authenticator.authenticate(request);
  const employee = identity
    ? await repositories.employeeRepository.recordSeen(identity.email)
    : null;

  if (request.method === "GET" && pathname === "/api/me") {
    handleMeRequest(
      response,
      employee,
    );
    return;
  }

  if (
    pathname === "/api/warehouse" ||
    pathname.startsWith("/api/warehouse/")
  ) {
    await handleWarehouseRequest(
      request,
      response,
      repositories.warehouseRepository,
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
      repositories.logisticsRepository,
      pathname,
    );
    return;
  }

  if (pathname.startsWith("/api/elections/")) {
    await handleElectionsRequest(
      request,
      response,
      repositories.workspaceAreaRepository,
      pathname,
      employee,
    );
    return;
  }

  await handleCertificateRequest(
    request,
    response,
    repositories.certificateRepository,
  );
}

export interface CertificateApiRepositories {
  certificateRepository: CertificateRepository;
  warehouseRepository: WarehouseRepository;
  logisticsRepository: LogisticsRepository;
  employeeRepository: EmployeeRepository;
  workspaceAreaRepository: WorkspaceAreaRepository;
}

export interface CertificateApiServerOptions {
  /** Overrides the env-derived Cloudflare Access authenticator (for tests). */
  authenticator?: AccessAuthenticator;
}

export function createCertificateApiServer(
  repositories?: Partial<CertificateApiRepositories>,
  options?: CertificateApiServerOptions,
): http.Server {
  const resolvedRepositories: CertificateApiRepositories = {
    certificateRepository:
      repositories?.certificateRepository ?? createCertificateRepository(),
    warehouseRepository:
      repositories?.warehouseRepository ?? createWarehouseRepository(),
    logisticsRepository:
      repositories?.logisticsRepository ?? createLogisticsRepository(),
    employeeRepository:
      repositories?.employeeRepository ?? createEmployeeRepository(),
    workspaceAreaRepository:
      repositories?.workspaceAreaRepository ?? createWorkspaceAreaRepository(),
  };
  const authenticator =
    options?.authenticator ?? createAccessAuthenticatorFromEnv();

  return http.createServer((request, response) => {
    applyCors(
      request,
      response,
    );

    dispatchRequest(
      request,
      response,
      resolvedRepositories,
      authenticator,
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
