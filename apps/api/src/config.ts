import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CertificateRepository,
  DEFAULT_CERTIFICATE_TEMPLATE_ID,
} from "./modules/certificates/certificate-records";
import { WarehouseRepository } from "./modules/warehouse/warehouse-records";
import { LogisticsRepository } from "./modules/logistics/logistics-records";
import { EmployeeRepository } from "./modules/employees/employee-records";
import { WorkspaceAreaRepository } from "./modules/elections/workspace-area-records";
import { ElectionsRepository } from "./modules/elections/elections-records";
import {
  type AccessAuthenticator,
  createAccessAuthenticator,
} from "./http/access-auth";

/**
 * Centralised runtime configuration: HTTP port and the storage roots that back
 * each repository. Storage layout is unified under a single `DATA_ROOT` with
 * per-domain subdirectories, while keeping the historical per-domain env
 * overrides. Local runs still default to `<repo>/storage`, but production must
 * set DATA_ROOT explicitly so runtime data cannot silently be created inside
 * the repository.
 */

export const PORT = Number(
  process.env.PORT ?? process.env.API_PORT ?? 3001,
);

function getRepositoryRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value && value !== "" ? value : undefined;
}

function getDataRoot(repositoryRoot: string): string {
  const dataRoot = readEnv("DATA_ROOT");

  if (dataRoot) {
    return dataRoot;
  }

  if (readEnv("NODE_ENV") === "production") {
    throw new Error(
      "DATA_ROOT must be set when NODE_ENV=production. Use DATA_ROOT=/data " +
        "inside Docker or DATA_ROOT=/var/lib/avku-internal/data on the host.",
    );
  }

  return path.join(
    repositoryRoot,
    "storage",
  );
}

/**
 * Resolves the legacy single-template directory override.
 *
 * Source of truth for templates is the multi-template catalogue at
 * `CERTIFICATES_TEMPLATES_DIRECTORY` (plural). The single-template mode is a
 * legacy escape hatch that pins the API to one template directory; it was
 * historically named `CERTIFICATES_TEMPLATE_DIRECTORY` (singular), which is one
 * character away from the plural and easy to set by mistake — that typo would
 * silently hide every non-default template (e.g. the English card). The
 * override is therefore exposed under the unambiguous
 * `CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR`; the old singular name still works
 * but logs a deprecation warning.
 */
function resolveLegacySingleTemplateDir(): string | undefined {
  const renamed = readEnv("CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR");
  const deprecated = readEnv("CERTIFICATES_TEMPLATE_DIRECTORY");

  if (deprecated) {
    console.warn(
      "[certificates] CERTIFICATES_TEMPLATE_DIRECTORY is deprecated and easily " +
        "confused with CERTIFICATES_TEMPLATES_DIRECTORY. Rename it to " +
        "CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR.",
    );
  }

  const singleTemplateDir = renamed ?? deprecated;

  if (singleTemplateDir && readEnv("CERTIFICATES_TEMPLATES_DIRECTORY")) {
    console.warn(
      "[certificates] Both a single-template override and " +
        "CERTIFICATES_TEMPLATES_DIRECTORY are set. Single-template mode wins, " +
        "so only the default template will be served. Unset the override to " +
        "serve the full template catalogue.",
    );
  }

  return singleTemplateDir;
}

export function createCertificateRepository(): CertificateRepository {
  const repositoryRoot = getRepositoryRoot();
  const dataRoot = getDataRoot(repositoryRoot);
  const storageRoot =
    readEnv("CERTIFICATES_STORAGE_ROOT") ??
    path.join(
      dataRoot,
      "certificates",
    );
  const templatesDirectory =
    readEnv("CERTIFICATES_TEMPLATES_DIRECTORY") ??
    path.join(
      repositoryRoot,
      "storage",
      "certificates",
      "templates",
    );

  return new CertificateRepository({
    storageRoot,
    templatesDirectory,
    legacySingleTemplateDirectory: resolveLegacySingleTemplateDir(),
    defaultTemplateId: readEnv("CERTIFICATES_DEFAULT_TEMPLATE_ID") ??
      DEFAULT_CERTIFICATE_TEMPLATE_ID,
    legacyRegistryPath: readEnv("CERTIFICATES_LEGACY_REGISTRY_PATH"),
  });
}

export function createWarehouseRepository(): WarehouseRepository {
  const dataRoot = getDataRoot(getRepositoryRoot());
  const storageRoot =
    readEnv("WAREHOUSE_STORAGE_ROOT") ??
    path.join(
      dataRoot,
      "warehouse",
    );

  return new WarehouseRepository({
    storageRoot,
  });
}

export function createLogisticsRepository(): LogisticsRepository {
  const dataRoot = getDataRoot(getRepositoryRoot());
  const storageRoot =
    readEnv("LOGISTICS_STORAGE_ROOT") ??
    path.join(
      dataRoot,
      "logistics",
    );

  return new LogisticsRepository({
    storageRoot,
  });
}

export function createEmployeeRepository(): EmployeeRepository {
  const dataRoot = getDataRoot(getRepositoryRoot());
  const storageRoot =
    readEnv("EMPLOYEES_STORAGE_ROOT") ??
    path.join(
      dataRoot,
      "employees",
    );

  return new EmployeeRepository({
    storageRoot,
  });
}

function getElectionsStorageRoot(): string {
  const dataRoot = getDataRoot(getRepositoryRoot());

  return (
    readEnv("ELECTIONS_STORAGE_ROOT") ??
    path.join(
      dataRoot,
      "elections",
    )
  );
}

export function createWorkspaceAreaRepository(): WorkspaceAreaRepository {
  return new WorkspaceAreaRepository({
    storageRoot: getElectionsStorageRoot(),
  });
}

/**
 * The "Вибори" domain database. Shares the elections storage root with the
 * boundary file, so a deployment that already sets `ELECTIONS_STORAGE_ROOT`
 * needs no new configuration.
 */
export function createElectionsRepository(): ElectionsRepository {
  return new ElectionsRepository({
    storageRoot: getElectionsStorageRoot(),
  });
}

/**
 * Builds the Cloudflare Access authenticator from the environment. When
 * `AVKU_ACCESS_TEAM_DOMAIN` / `AVKU_ACCESS_AUD` are unset the authenticator is
 * disabled and every request is treated as trusted local access — the
 * pre-Phase-2 behaviour, which stays safe because external traffic is gated by
 * Cloudflare Access at the edge.
 */
export function createAccessAuthenticatorFromEnv(): AccessAuthenticator {
  return createAccessAuthenticator({
    teamDomain: readEnv("AVKU_ACCESS_TEAM_DOMAIN"),
    audience: readEnv("AVKU_ACCESS_AUD"),
  });
}
