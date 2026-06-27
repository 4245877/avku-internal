import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CertificateRepository,
  DEFAULT_CERTIFICATE_TEMPLATE_ID,
} from "./modules/certificates/certificate-records";
import { WarehouseRepository } from "./modules/warehouse/warehouse-records";
import { LogisticsRepository } from "./modules/logistics/logistics-records";

/**
 * Centralised runtime configuration: HTTP port and the storage roots that back
 * each repository. Storage layout is unified under a single `DATA_ROOT` with
 * per-domain subdirectories, while keeping the historical per-domain env
 * overrides and default paths (`<repo>/storage/<domain>`) for backwards
 * compatibility with existing SQLite files.
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

function getDataRoot(repositoryRoot: string): string {
  return (
    process.env.DATA_ROOT ??
    path.join(
      repositoryRoot,
      "storage",
    )
  );
}

export function createCertificateRepository(): CertificateRepository {
  const repositoryRoot = getRepositoryRoot();
  const dataRoot = getDataRoot(repositoryRoot);
  const storageRoot =
    process.env.CERTIFICATES_STORAGE_ROOT ??
    path.join(
      dataRoot,
      "certificates",
    );
  const templatesDirectory =
    process.env.CERTIFICATES_TEMPLATES_DIRECTORY ??
    path.join(
      repositoryRoot,
      "storage",
      "certificates",
      "templates",
    );

  return new CertificateRepository({
    storageRoot,
    templatesDirectory,
    templateDirectory: process.env.CERTIFICATES_TEMPLATE_DIRECTORY,
    defaultTemplateId: process.env.CERTIFICATES_DEFAULT_TEMPLATE_ID ??
      DEFAULT_CERTIFICATE_TEMPLATE_ID,
    legacyRegistryPath: process.env.CERTIFICATES_LEGACY_REGISTRY_PATH,
  });
}

export function createWarehouseRepository(): WarehouseRepository {
  const dataRoot = getDataRoot(getRepositoryRoot());
  const storageRoot =
    process.env.WAREHOUSE_STORAGE_ROOT ??
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
    process.env.LOGISTICS_STORAGE_ROOT ??
    path.join(
      dataRoot,
      "logistics",
    );

  return new LogisticsRepository({
    storageRoot,
  });
}
