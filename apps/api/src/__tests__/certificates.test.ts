import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import sharp from "sharp";

import { createCertificateApiServer } from "../server";

/**
 * HTTP-surface tests for the localized certificate templates (uk + en):
 * template catalogue, asset serving, 404/path-traversal hardening, record
 * create/read with an explicit templateId (JSON + multipart), and PNG/PDF
 * rendering using the stored template.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;
let photoDataUrl: string;
let photoPngBuffer: Buffer;

const UK = "volunteer-card-v1-uk";
const EN = "volunteer-card-v1-en";
const LEGACY = "volunteer-card-v1";

let certificateCounter = 0;

function nextCertificateNumber(): string {
  certificateCounter += 1;

  return `CERT-${Date.now()}-${certificateCounter}`;
}

function leaksFilesystemPath(message: string): boolean {
  return (
    /[A-Za-z]:[\\/]/.test(message) ||
    message.includes("storage") ||
    message.includes("templates") ||
    message.includes("/app/") ||
    message.includes(".png")
  );
}

async function makePhotoBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 600,
      height: 800,
      channels: 3,
      background: { r: 120, g: 150, b: 190 },
    },
  })
    .png()
    .toBuffer();
}

async function api(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined
      ? undefined
      : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  return {
    status: response.status,
    json: text ? JSON.parse(text) : undefined,
  };
}

function baseRecordPayload(templateId: string): Record<string, unknown> {
  return {
    fullName: "Шевченко Тарас Григорович",
    firstNameEn: "Taras",
    lastNameEn: "Shevchenko",
    certificateNumber: nextCertificateNumber(),
    issuedAt: "2026-06-19",
    validUntil: "2027-06-19",
    templateId,
    photoDataUrl,
    photoCrop: { zoom: 1, offsetX: 0, offsetY: 0 },
  };
}

before(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "avku-cert-"));
  process.env.DATA_ROOT = dataRoot;
  delete process.env.CERTIFICATES_STORAGE_ROOT;
  // Use the repository's real template catalogue (storage/certificates/templates).
  delete process.env.CERTIFICATES_TEMPLATES_DIRECTORY;
  delete process.env.CERTIFICATES_TEMPLATE_DIRECTORY;
  delete process.env.CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR;
  delete process.env.CERTIFICATES_DEFAULT_TEMPLATE_ID;
  delete process.env.CERTIFICATES_LEGACY_REGISTRY_PATH;

  photoPngBuffer = await makePhotoBuffer();
  photoDataUrl = `data:image/png;base64,${photoPngBuffer.toString("base64")}`;

  server = createCertificateApiServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  try {
    await rm(dataRoot, { recursive: true, force: true });
  } catch {
    // Open SQLite handles can keep files locked on Windows; ignore.
  }
});

test("GET /api/certificates/templates lists uk + en with uk as default", async () => {
  const { status, json } = await api("GET", "/api/certificates/templates");

  assert.equal(status, 200);

  const catalog = json as {
    defaultId: string;
    templates: { id: string; isDefault: boolean; name: string }[];
  };

  assert.equal(catalog.defaultId, UK);

  const ids = catalog.templates.map((template) => template.id);
  assert.ok(ids.includes(UK), "uk template present");
  assert.ok(ids.includes(EN), "en template present");

  const uk = catalog.templates.find((template) => template.id === UK);
  const en = catalog.templates.find((template) => template.id === EN);
  assert.equal(uk?.isDefault, true);
  assert.equal(en?.isDefault, false);
});

test("default template is volunteer-card-v1-uk", async () => {
  const { status, json } = await api("GET", "/api/certificates/template");

  assert.equal(status, 200);
  assert.equal((json as { id: string }).id, UK);
});

test("legacy alias volunteer-card-v1 resolves to uk", async () => {
  const { status, json } = await api(
    "GET",
    `/api/certificates/template?templateId=${LEGACY}`,
  );

  assert.equal(status, 200);
  assert.equal((json as { id: string }).id, UK);
});

test("template assets are served with the correct Content-Type", async () => {
  for (const templateId of [UK, EN]) {
    for (const asset of ["background.png", "stamp-overlay.png"]) {
      const response = await fetch(
        `${baseUrl}/api/certificates/templates/${templateId}/${asset}`,
      );

      assert.equal(response.status, 200, `${templateId}/${asset} status`);
      assert.equal(
        response.headers.get("content-type"),
        "image/png",
        `${templateId}/${asset} content-type`,
      );

      const body = Buffer.from(await response.arrayBuffer());
      assert.ok(body.length > 0, `${templateId}/${asset} non-empty`);
    }
  }
});

test("valid-but-missing templateId asset yields a clean 404 (no path leak)", async () => {
  const response = await fetch(
    `${baseUrl}/api/certificates/templates/volunteer-card-v1-fr/background.png`,
  );

  assert.equal(response.status, 404);

  const payload = (await response.json()) as { error?: string };
  assert.ok(payload.error, "error message present");
  assert.ok(
    !leaksFilesystemPath(payload.error ?? ""),
    `error must not leak a filesystem path: ${payload.error}`,
  );
});

test("path traversal attempts are rejected without serving files", async () => {
  const attempts = [
    "/api/certificates/templates/..%2f..%2fpackage.json/background.png",
    "/api/certificates/templates/%2e%2e/background.png",
    "/api/certificates/templates/..%2fvolunteer-card-v1-uk/background.png",
    "/api/certificates/templates/%2e%2e%2f%2e%2e%2fconfig.ts/background.png",
  ];

  for (const attempt of attempts) {
    const response = await fetch(`${baseUrl}${attempt}`);

    assert.notEqual(response.status, 200, `${attempt} must not return 200`);

    const contentType = response.headers.get("content-type") ?? "";
    assert.ok(
      contentType.includes("application/json"),
      `${attempt} must not stream a file (got ${contentType})`,
    );

    const payload = (await response.json()) as { error?: string };
    assert.ok(
      !leaksFilesystemPath(payload.error ?? ""),
      `${attempt} error must not leak a path: ${payload.error}`,
    );
  }
});

test("create via JSON stores templateId=en and read returns it", async () => {
  const created = await api(
    "POST",
    "/api/certificates",
    baseRecordPayload(EN),
  );

  assert.equal(created.status, 201);
  const record = created.json as {
    id: string;
    templateId: string;
    firstNameEn: string;
    lastNameEn: string;
    fullNameEn: string;
  };
  assert.equal(record.templateId, EN);
  assert.equal(record.firstNameEn, "Taras");
  assert.equal(record.lastNameEn, "Shevchenko");
  assert.equal(record.fullNameEn, "Taras Shevchenko");

  const fetched = await api("GET", `/api/certificates/${record.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.json as { templateId: string }).templateId, EN);
});

test("create via multipart/form-data stores templateId=en", async () => {
  const form = new FormData();
  form.set("fullName", "Шевченко Тарас Григорович");
  form.set("certificateNumber", nextCertificateNumber());
  form.set("issuedAt", "2026-06-19");
  form.set("validUntil", "2027-06-19");
  form.set("templateId", EN);
  form.set("photoCrop", JSON.stringify({ zoom: 1, offsetX: 0, offsetY: 0 }));
  form.set(
    "photo",
    new Blob([new Uint8Array(photoPngBuffer)], { type: "image/png" }),
    "photo.png",
  );

  const response = await fetch(`${baseUrl}/api/certificates`, {
    method: "POST",
    body: form,
  });

  assert.equal(response.status, 201);
  const record = (await response.json()) as { id: string; templateId: string };
  assert.equal(record.templateId, EN);

  const fetched = await api("GET", `/api/certificates/${record.id}`);
  assert.equal((fetched.json as { templateId: string }).templateId, EN);
});

test("create with the legacy alias canonicalizes to uk", async () => {
  const created = await api(
    "POST",
    "/api/certificates",
    baseRecordPayload(LEGACY),
  );

  assert.equal(created.status, 201);
  assert.equal((created.json as { templateId: string }).templateId, UK);
});

test("create without templateId falls back to the default uk", async () => {
  const payload = baseRecordPayload(EN);
  delete payload.templateId;

  const created = await api("POST", "/api/certificates", payload);

  assert.equal(created.status, 201);
  assert.equal((created.json as { templateId: string }).templateId, UK);
});

test("create with a valid-but-unknown templateId yields 404", async () => {
  const created = await api(
    "POST",
    "/api/certificates",
    baseRecordPayload("volunteer-card-v1-zz"),
  );

  assert.equal(created.status, 404);
  assert.ok(
    !leaksFilesystemPath((created.json as { error?: string }).error ?? ""),
  );
});

test("PNG/PDF export uses the stored template, not the default", async () => {
  const ukRecord = (await api("POST", "/api/certificates", baseRecordPayload(UK)))
    .json as { id: string };
  const enRecord = (await api("POST", "/api/certificates", baseRecordPayload(EN)))
    .json as { id: string };

  const ukPng = await fetch(`${baseUrl}/api/certificates/${ukRecord.id}/export.png`);
  const enPng = await fetch(`${baseUrl}/api/certificates/${enRecord.id}/export.png`);

  assert.equal(ukPng.status, 200);
  assert.equal(ukPng.headers.get("content-type"), "image/png");
  assert.equal(enPng.status, 200);

  const ukBytes = Buffer.from(await ukPng.arrayBuffer());
  const enBytes = Buffer.from(await enPng.arrayBuffer());
  assert.ok(ukBytes.length > 0 && enBytes.length > 0);
  // uk and en backgrounds differ, so identical field data must still produce
  // different renders — proving the stored templateId drives the render.
  assert.ok(
    !ukBytes.equals(enBytes),
    "uk and en renders must differ (stored template is used)",
  );

  const enPdf = await fetch(`${baseUrl}/api/certificates/${enRecord.id}/export.pdf`);
  assert.equal(enPdf.status, 200);
  assert.equal(enPdf.headers.get("content-type"), "application/pdf");

  const pdfBytes = Buffer.from(await enPdf.arrayBuffer());
  assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("a uk record can be rendered with the en template without changing it", async () => {
  const record = (await api("POST", "/api/certificates", baseRecordPayload(UK)))
    .json as { id: string; templateId: string };
  const rendered = await fetch(
    `${baseUrl}/api/certificates/${record.id}/export.png?templateId=${EN}`,
  );

  assert.equal(rendered.status, 200);
  assert.ok((await rendered.arrayBuffer()).byteLength > 0);

  const fetched = await api("GET", `/api/certificates/${record.id}`);
  assert.equal((fetched.json as { templateId: string }).templateId, UK);
});

test("updating a record preserves the stored templateId when omitted", async () => {
  const created = (await api("POST", "/api/certificates", baseRecordPayload(EN)))
    .json as { id: string; certificateNumber: string; templateId: string };
  assert.equal(created.templateId, EN);

  const updated = await api("PUT", `/api/certificates/${created.id}`, {
    fullName: "Шевченко Тарас Григорович",
    certificateNumber: created.certificateNumber,
    issuedAt: "2026-06-19",
    validUntil: "2028-06-19",
  });

  assert.equal(updated.status, 200);
  const updatedRecord = updated.json as {
    templateId: string;
    firstNameEn: string;
    lastNameEn: string;
  };
  assert.equal(updatedRecord.templateId, EN);
  assert.equal(updatedRecord.firstNameEn, "Taras");
  assert.equal(updatedRecord.lastNameEn, "Shevchenko");
});

test("concurrent creates all succeed (write transactions are serialized)", async () => {
  // Regression guard: writes share one synchronous SQLite connection whose
  // BEGIN IMMEDIATE is held across an async photo rename. Without serialization
  // an overlapping write fails with "cannot start a transaction within a
  // transaction". Fire several at once and require every one to persist.
  const concurrency = 8;
  const responses = await Promise.all(
    Array.from({ length: concurrency }, () =>
      api("POST", "/api/certificates", baseRecordPayload(UK)),
    ),
  );

  for (const response of responses) {
    assert.equal(
      response.status,
      201,
      `expected 201, got ${response.status}: ${JSON.stringify(response.json)}`,
    );
  }

  const ids = new Set(
    responses.map((response) => (response.json as { id: string }).id),
  );
  assert.equal(ids.size, concurrency, "every concurrent create got a unique id");
});

test("GET /api/certificates supports search and limit", async () => {
  const marker = `Пошуковий-${Date.now()}`;
  const payload = { ...baseRecordPayload(UK), fullName: marker };
  const created = (await api("POST", "/api/certificates", payload)).json as {
    id: string;
  };

  const found = await api(
    "GET",
    `/api/certificates?search=${encodeURIComponent(marker)}`,
  );
  assert.equal(found.status, 200);
  const matches = found.json as { id: string; fullName: string }[];
  assert.ok(
    matches.some((record) => record.id === created.id),
    "search returns the matching record",
  );
  assert.ok(
    matches.every((record) => record.fullName.includes(marker)),
    "search only returns matching records",
  );

  const limited = await api("GET", "/api/certificates?limit=1");
  assert.equal(limited.status, 200);
  assert.equal((limited.json as unknown[]).length, 1, "limit caps the result set");
});

test("rejects a photo below the minimum dimension", async () => {
  const tinyPhoto = await sharp({
    create: {
      width: 50,
      height: 50,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();

  const response = await api("POST", "/api/certificates", {
    ...baseRecordPayload(UK),
    photoDataUrl: `data:image/png;base64,${tinyPhoto.toString("base64")}`,
  });

  assert.equal(response.status, 400);
  assert.match((response.json as { error: string }).error, /Мінімальний розмір/);
});
