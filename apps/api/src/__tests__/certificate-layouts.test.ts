import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * Guards against silent divergence between the four copies of the certificate
 * layout that must stay in sync:
 *   - storage templates (API render source of truth): uk + en
 *   - web fallback assets (offline preview): uk + en
 *
 * The geometry (canvas/photo/fields/stampOverlay) is intentionally identical
 * across locales; only id/name/locale differ. If a coordinate is changed in one
 * place but not the others, the server PNG/PDF and the web preview would drift
 * apart — this test fails fast instead.
 */

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const STORAGE_TEMPLATES = path.join(
  REPOSITORY_ROOT,
  "storage",
  "certificates",
  "templates",
);
const WEB_ASSETS = path.join(
  REPOSITORY_ROOT,
  "apps",
  "web",
  "src",
  "assets",
  "certificates",
);

interface LayoutFile {
  id?: unknown;
  name?: unknown;
  locale?: unknown;
  [key: string]: unknown;
}

function readLayout(...segments: string[]): LayoutFile {
  const content = readFileSync(
    path.join(...segments, "layout.json"),
    "utf8",
  );

  return JSON.parse(content.replace(/^﻿/, "")) as LayoutFile;
}

function geometryOf(layout: LayoutFile): Record<string, unknown> {
  const { id, name, locale, ...geometry } = layout;

  return geometry;
}

const storageUk = readLayout(STORAGE_TEMPLATES, "volunteer-card-v1-uk");
const storageEn = readLayout(STORAGE_TEMPLATES, "volunteer-card-v1-en");
const webUk = readLayout(WEB_ASSETS, "volunteer-card-v1-uk");
const webEn = readLayout(WEB_ASSETS, "volunteer-card-v1-en");

test("storage uk/en templates carry the correct locale metadata", () => {
  assert.equal(storageUk.id, "volunteer-card-v1-uk");
  assert.equal(storageUk.locale, "uk");
  assert.equal(storageEn.id, "volunteer-card-v1-en");
  assert.equal(storageEn.locale, "en");
});

test("EN and UK storage layouts share identical geometry", () => {
  assert.deepEqual(geometryOf(storageEn), geometryOf(storageUk));
});

test("web fallback layout matches the storage layout (uk)", () => {
  assert.deepEqual(webUk, storageUk);
});

test("web fallback layout matches the storage layout (en)", () => {
  assert.deepEqual(webEn, storageEn);
});
