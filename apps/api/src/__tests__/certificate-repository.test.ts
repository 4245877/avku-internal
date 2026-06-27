import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { CertificateRepository } from "../modules/certificates/certificate-records";

/**
 * Repository-level edge cases that are awkward to reach over HTTP: graceful
 * degradation of a broken template, fail-fast on a broken default at startup,
 * stray directories, and legacy registry.json migration of records that predate
 * the localized templateId.
 */

const UK = "volunteer-card-v1-uk";
const EN = "volunteer-card-v1-en";

interface TemplateSpec {
  id: string;
  layout?: string;
  withBackground?: boolean;
}

async function writeTemplate(
  templatesDir: string,
  spec: TemplateSpec,
): Promise<void> {
  const dir = path.join(templatesDir, spec.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "layout.json"),
    spec.layout ??
      JSON.stringify({ id: spec.id, name: spec.id, locale: "xx" }),
    "utf8",
  );

  if (spec.withBackground ?? true) {
    await writeFile(path.join(dir, "background.png"), Buffer.from([0x89, 0x50]));
    await writeFile(path.join(dir, "stamp-overlay.png"), Buffer.from([0x89]));
  }
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "avku-cert-repo-"));
}

async function safeRemove(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // The repository keeps its SQLite handle open, which locks the file on
      // Windows; leftover temp dirs under the OS temp folder are harmless.
    }
  }
}

function makeRepository(
  storageRoot: string,
  templatesDirectory: string,
  legacyRegistryPath?: string,
): CertificateRepository {
  return new CertificateRepository({
    storageRoot,
    templatesDirectory,
    defaultTemplateId: UK,
    legacyRegistryPath,
  });
}

test("listTemplates skips broken templates and ignores stray folders", async () => {
  const storageRoot = await makeTempDir();
  const templatesDir = await makeTempDir();

  try {
    await writeTemplate(templatesDir, { id: UK });
    await writeTemplate(templatesDir, { id: EN });
    // Invalid layout.json — must be skipped, not crash the catalogue.
    await writeTemplate(templatesDir, {
      id: "volunteer-card-v1-br",
      layout: "{ not valid json",
    });
    // Valid layout but missing the required background.png — must be skipped.
    await writeTemplate(templatesDir, {
      id: "volunteer-card-v1-nb",
      withBackground: false,
    });
    // Stray folder with spaces/uppercase — must be ignored by the id pattern.
    await writeTemplate(templatesDir, { id: "volunteer-card-v1 ENG" });

    const repository = makeRepository(storageRoot, templatesDir);
    const templates = await repository.listTemplates();
    const ids = templates.map((template) => template.id);

    assert.deepEqual(ids, [UK, EN], "only the two healthy templates survive");
    assert.equal(templates[0].isDefault, true);
  } finally {
    await safeRemove(storageRoot, templatesDir);
  }
});

test("check() passes when the default template is healthy", async () => {
  const storageRoot = await makeTempDir();
  const templatesDir = await makeTempDir();

  try {
    await writeTemplate(templatesDir, { id: UK });
    await writeTemplate(templatesDir, { id: EN });

    const repository = makeRepository(storageRoot, templatesDir);
    await repository.check();
  } finally {
    await safeRemove(storageRoot, templatesDir);
  }
});

test("check() fails fast when the default template is broken", async () => {
  const storageRoot = await makeTempDir();
  const templatesDir = await makeTempDir();

  try {
    // Default present but with an unreadable layout.json.
    await writeTemplate(templatesDir, {
      id: UK,
      layout: "{ broken",
    });
    await writeTemplate(templatesDir, { id: EN });

    const repository = makeRepository(storageRoot, templatesDir);
    await assert.rejects(() => repository.check());
  } finally {
    await safeRemove(storageRoot, templatesDir);
  }
});

test("check() fails fast when the default template is missing", async () => {
  const storageRoot = await makeTempDir();
  const templatesDir = await makeTempDir();

  try {
    // Only a non-default template exists; the mandatory default is absent.
    await writeTemplate(templatesDir, { id: EN });

    const repository = makeRepository(storageRoot, templatesDir);
    await assert.rejects(() => repository.check());
  } finally {
    await safeRemove(storageRoot, templatesDir);
  }
});

test("legacy registry migration normalizes missing and aliased templateId", async () => {
  const storageRoot = await makeTempDir();
  const templatesDir = await makeTempDir();
  const legacyRegistryPath = path.join(storageRoot, "registry.json");

  try {
    await writeTemplate(templatesDir, { id: UK });

    await writeFile(
      legacyRegistryPath,
      JSON.stringify([
        {
          id: "legacy-no-template",
          fullName: "Іваненко Іван Іванович",
          certificateNumber: "L-1",
          issuedAt: "2026-01-01",
          validUntil: "2027-01-01",
          photoFileName: "legacy-1.png",
          photoCrop: { zoom: 1, offsetX: 0, offsetY: 0 },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "legacy-alias",
          fullName: "Петренко Петро Петрович",
          certificateNumber: "L-2",
          issuedAt: "2026-01-01",
          validUntil: "2027-01-01",
          photoFileName: "legacy-2.png",
          templateId: "volunteer-card-v1",
          photoCrop: { zoom: 1, offsetX: 0, offsetY: 0 },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
      "utf8",
    );

    const repository = makeRepository(
      storageRoot,
      templatesDir,
      legacyRegistryPath,
    );
    const records = await repository.list();
    const byId = new Map(records.map((record) => [record.id, record]));

    assert.equal(records.length, 2);
    assert.equal(byId.get("legacy-no-template")?.templateId, UK);
    assert.equal(byId.get("legacy-alias")?.templateId, UK);
  } finally {
    await safeRemove(storageRoot, templatesDir);
  }
});
