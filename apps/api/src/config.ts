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
  const renamed = process.env.CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR;
  const deprecated = process.env.CERTIFICATES_TEMPLATE_DIRECTORY;

  if (deprecated) {
    console.warn(
      "[certificates] CERTIFICATES_TEMPLATE_DIRECTORY is deprecated and easily " +
        "confused with CERTIFICATES_TEMPLATES_DIRECTORY. Rename it to " +
        "CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR.",
    );
  }

  const singleTemplateDir = renamed ?? deprecated;

  if (singleTemplateDir && process.env.CERTIFICATES_TEMPLATES_DIRECTORY) {
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
    legacySingleTemplateDirectory: resolveLegacySingleTemplateDir(),
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
