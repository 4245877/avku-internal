import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

import { createCertificateApiServer } from "../server";
import { CertificateRepository, type CertificateRecordResponse } from "../modules/certificates/certificate-records";

let dataRoot: string;
let server: http.Server;
let baseUrl: string;
let photoBuffer: Buffer;
let photoDataUrl: string;
let number = 0;
const templatesDirectory = path.resolve("../../storage/certificates/templates");

function draftPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "draft",
    fullName: "Тестовий Волонтер Аудитний",
    certificateNumber: `DRAFT-${++number}`,
    ...extra,
  };
}

async function api(method: string, pathname: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

before(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "avku-drafts-"));
  process.env.DATA_ROOT = dataRoot;
  delete process.env.CERTIFICATES_STORAGE_ROOT;
  delete process.env.CERTIFICATES_TEMPLATES_DIRECTORY;
  delete process.env.CERTIFICATES_TEMPLATE_DIRECTORY;
  delete process.env.CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR;
  delete process.env.CERTIFICATES_DEFAULT_TEMPLATE_ID;
  delete process.env.CERTIFICATES_LEGACY_REGISTRY_PATH;
  photoBuffer = await sharp({
    create: { width: 600, height: 800, channels: 3, background: { r: 150, g: 120, b: 90 } },
  }).png().toBuffer();
  photoDataUrl = `data:image/png;base64,${photoBuffer.toString("base64")}`;
  server = createCertificateApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataRoot, { recursive: true, force: true });
});

test("draft HTTP lifecycle: create without photo/dates, read, edit, upload, fill and explicitly activate", async () => {
  const payload = draftPayload({ validUntil: "2027-12-31", firstNameEn: "Volunteer", lastNameEn: "Test" });
  const created = await api("POST", "/api/certificates", payload);
  assert.equal(created.status, 201);
  const draft = created.json as CertificateRecordResponse;
  assert.equal(draft.status, "draft");
  assert.equal(draft.issuedAt, null);
  assert.equal(draft.photoFileName, null);
  assert.equal(draft.photoUrl, "");
  assert.deepEqual(draft.exportUrls, { png: "", pdf: "" });
  assert.equal(draft.validUntil, "2027-12-31");
  assert.equal(draft.fullNameEn, "Volunteer Test");

  const fetched = await api("GET", `/api/certificates/${draft.id}`);
  assert.deepEqual(fetched.json, draft);
  const list = await api("GET", `/api/certificates?search=${draft.certificateNumber}`);
  assert.ok((list.json as CertificateRecordResponse[]).some((record) => record.id === draft.id && record.status === "draft"));
  const sql = new DatabaseSync(path.join(dataRoot, "certificates/certificates.sqlite"));
  const stored = sql.prepare("SELECT issued_at, photo_file_name, status FROM certificate_records WHERE id = ?").get(draft.id);
  assert.deepEqual({ ...stored }, { issued_at: null, photo_file_name: null, status: "draft" });
  sql.close();

  const activationWithoutDateOrPhoto = await api("PATCH", `/api/certificates/${draft.id}/activate`);
  assert.equal(activationWithoutDateOrPhoto.status, 400);
  assert.deepEqual((await api("GET", `/api/certificates/${draft.id}`)).json, draft, "rejected activation changes no data or timestamps");
  const silentActivation = await api("PUT", `/api/certificates/${draft.id}`, { ...payload, status: "active" });
  assert.equal(silentActivation.status, 400);

  const form = new FormData();
  form.set("status", "draft");
  form.set("certificateNumber", draft.certificateNumber);
  form.set("fullName", "Тестовий Волонтер Перевірений");
  form.set("issuedAt", "");
  form.set("validUntil", "2027-12-31");
  form.set("photo", new Blob([new Uint8Array(photoBuffer)], { type: "image/png" }), "photo.png");
  const savedResponse = await fetch(`${baseUrl}/api/certificates/${draft.id}`, { method: "PUT", body: form });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as CertificateRecordResponse;
  assert.equal(saved.status, "draft");
  assert.equal(saved.issuedAt, null);
  assert.equal(saved.fullName, "Тестовий Волонтер Перевірений");
  assert.equal(saved.firstNameEn, "Volunteer", "omitted Latin name is preserved");
  assert.ok(saved.photoUrl);
  const savedPhoto = await fetch(`${baseUrl}${saved.photoUrl}`);
  assert.equal(savedPhoto.status, 200);
  assert.ok(Buffer.from(await savedPhoto.arrayBuffer()).equals(photoBuffer));
  assert.equal((await api("PATCH", `/api/certificates/${draft.id}/activate`)).status, 400, "photo alone cannot activate without date");

  const filledResponse = await api("PUT", `/api/certificates/${draft.id}`, {
    ...payload, fullName: saved.fullName, issuedAt: "2026-10-05",
  });
  assert.equal(filledResponse.status, 200);
  const filled = filledResponse.json as CertificateRecordResponse;
  assert.equal(filled.status, "draft", "saving complete data does not silently activate");
  assert.equal(filled.photoFileName, saved.photoFileName);
  for (const action of ["export.png", "export.pdf"]) {
    assert.equal((await api("GET", `/api/certificates/${draft.id}/${action}`)).status, 400, "even complete drafts cannot be exported");
  }
  assert.equal((await api("POST", "/api/certificates/print-sheet", { ids: [draft.id] })).status, 400);
  assert.equal((await api("PATCH", `/api/certificates/${draft.id}/renew`)).status, 400);
  assert.deepEqual((await api("GET", `/api/certificates/${draft.id}`)).json, filled, "rejected final-state actions preserve draft data");

  const activatedResponse = await api("PATCH", `/api/certificates/${draft.id}/activate`);
  assert.equal(activatedResponse.status, 200);
  const active = activatedResponse.json as CertificateRecordResponse;
  assert.equal(active.status, "active");
  assert.equal(active.issuedAt, "2026-10-05");
  assert.equal(active.photoFileName, filled.photoFileName);
  assert.ok(active.exportUrls.png);
  assert.equal((await fetch(`${baseUrl}${active.exportUrls.png}`)).status, 200);
  assert.equal((await fetch(`${baseUrl}${active.exportUrls.pdf}`)).status, 200);
  assert.equal((await api("PUT", `/api/certificates/${draft.id}`, { ...payload, issuedAt: active.issuedAt })).status, 400, "cannot downgrade active record through PUT");
  assert.deepEqual((await api("GET", `/api/certificates/${draft.id}`)).json, active);
});

test("draft create via multipart supports missing dates and photo; deletion needs no photo", async () => {
  const form = new FormData();
  const payload = draftPayload();
  form.set("status", "draft");
  form.set("fullName", String(payload.fullName));
  form.set("certificateNumber", String(payload.certificateNumber));
  form.set("issuedAt", "");
  form.set("validUntil", "");
  const response = await fetch(`${baseUrl}/api/certificates`, { method: "POST", body: form });
  assert.equal(response.status, 201);
  const draft = await response.json() as CertificateRecordResponse;
  assert.equal(draft.issuedAt, null);
  assert.equal(draft.validUntil, null);
  assert.equal(draft.photoUrl, "");
  assert.equal((await api("DELETE", `/api/certificates/${draft.id}`)).status, 200);
  assert.equal((await api("GET", `/api/certificates/${draft.id}`)).status, 404);
});

test("active default remains strict and active record updates cannot erase required dates", async () => {
  const full = { ...draftPayload(), status: "active", issuedAt: "2026-10-05", validUntil: "2027-10-05", photoDataUrl };
  const noPhoto: Record<string, unknown> = { ...full };
  delete noPhoto.photoDataUrl;
  assert.equal((await api("POST", "/api/certificates", noPhoto)).status, 400);
  const noDate = { ...full, issuedAt: null };
  assert.equal((await api("POST", "/api/certificates", noDate)).status, 400);
  const defaultActive: Record<string, unknown> = { ...full };
  delete defaultActive.status;
  const created = await api("POST", "/api/certificates", defaultActive);
  assert.equal(created.status, 201);
  const active = created.json as CertificateRecordResponse;
  assert.equal(active.status, "active");
  assert.equal((await api("PUT", `/api/certificates/${active.id}`, { ...full, issuedAt: null })).status, 400);
  assert.deepEqual((await api("GET", `/api/certificates/${active.id}`)).json, active);
  assert.deepEqual((await api("PATCH", `/api/certificates/${active.id}/activate`)).json, active, "active activation is idempotent");
});

test("drafts still validate provided dates, ranges, names, numbers, photo content and status", async () => {
  for (const extra of [
    { issuedAt: "2026-02-30" }, { issuedAt: "unknown" }, { validUntil: "2026-13-01" },
    { issuedAt: "2027-01-01", validUntil: "2026-01-01" },
    { fullName: "" }, { certificateNumber: "" }, { status: "published" },
    { photoDataUrl: "bad-image" }, { photoDataUrl: 42 },
  ]) {
    const response = await api("POST", "/api/certificates", draftPayload(extra));
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  const tiny = await sharp({ create: { width: 50, height: 50, channels: 3, background: "red" } }).png().toBuffer();
  assert.equal((await api("POST", "/api/certificates", draftPayload({ photoDataUrl: `data:image/png;base64,${tiny.toString("base64")}` }))).status, 400);
});

test("one number remains unique across draft and active records (case insensitive)", async () => {
  const payload = draftPayload();
  assert.equal((await api("POST", "/api/certificates", payload)).status, 201);
  const duplicate = await api("POST", "/api/certificates", { ...payload, certificateNumber: String(payload.certificateNumber).toLowerCase() });
  assert.equal(duplicate.status, 400);
  assert.match((duplicate.json as { error: string }).error, /вже існує/);
  const activeDuplicate = await api("POST", "/api/certificates", {
    ...payload, status: "active", issuedAt: "2026-10-05", validUntil: "2027-10-05", photoDataUrl,
  });
  assert.equal(activeDuplicate.status, 400);
});

test("activation rejects nonexistent or corrupted stored photo rather than trusting filename", async () => {
  const response = await api("POST", "/api/certificates", draftPayload({ issuedAt: "2026-10-05", validUntil: "2027-10-05", photoDataUrl }));
  const draft = response.json as CertificateRecordResponse;
  const photoPath = path.join(dataRoot, "certificates/photos", draft.photoFileName!);
  await unlink(photoPath);
  assert.equal((await api("PATCH", `/api/certificates/${draft.id}/activate`)).status, 400);
  await writeFile(photoPath, "not an image");
  assert.equal((await api("PATCH", `/api/certificates/${draft.id}/activate`)).status, 400);
  assert.deepEqual((await api("GET", `/api/certificates/${draft.id}`)).json, draft);
});

const LEGACY_SCHEMA = `
  CREATE TABLE certificate_records (
    id TEXT PRIMARY KEY NOT NULL,
    full_name TEXT NOT NULL,
    first_name_en TEXT NOT NULL DEFAULT '',
    last_name_en TEXT NOT NULL DEFAULT '',
    certificate_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
    issued_at TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    photo_file_name TEXT NOT NULL,
    photo_crop_zoom REAL NOT NULL DEFAULT 1 CHECK (photo_crop_zoom >= 1 AND photo_crop_zoom <= 3),
    photo_crop_offset_x REAL NOT NULL DEFAULT 0,
    photo_crop_offset_y REAL NOT NULL DEFAULT 0,
    photo_crop_rotation REAL NOT NULL DEFAULT 0,
    template_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX old_certificate_name_index ON certificate_records(full_name);
  PRAGMA user_version = 3;
`;

test("transactional draft migration preserves all 15 old columns and existing photos; rerun is idempotent", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "avku-draft-migration-"));
  try {
    const dbPath = path.join(storageRoot, "certificates.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(LEGACY_SCHEMA);
    db.prepare("INSERT INTO certificate_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "legacy-record", "Існуючий Волонтер", "Existing", "Volunteer", "001", "2026-01-02", "2027-01-02",
      "existing.png", 2.75, -0.4, 0.6, -37, "volunteer-card-v1-uk", "2026-01-02T10:11:12.000Z", "2026-02-03T13:14:15.000Z",
    );
    const before = { ...db.prepare("SELECT * FROM certificate_records").get() };
    db.close();
    await mkdir(path.join(storageRoot, "photos"));
    const photoPath = path.join(storageRoot, "photos/existing.png");
    await writeFile(photoPath, photoBuffer);
    const repository = new CertificateRepository({ storageRoot, templatesDirectory });
    const migrated = await repository.get("legacy-record");
    assert.equal(migrated.status, "active");
    assert.equal(migrated.createdAt, before.created_at);
    assert.equal(migrated.updatedAt, before.updated_at);
    assert.ok((await readFile(photoPath)).equals(photoBuffer), "migration does not alter old photo bytes");
    const migratedDb = new DatabaseSync(dbPath);
    const after = { ...migratedDb.prepare("SELECT * FROM certificate_records").get() };
    assert.equal(after.status, "active");
    delete after.status;
    assert.deepEqual(after, before, "every previous field is preserved byte-for-byte");
    assert.ok(migratedDb.prepare("SELECT name FROM sqlite_master WHERE name = 'old_certificate_name_index'").get());
    assert.equal(migratedDb.prepare("PRAGMA user_version").get()?.user_version, 4);
    assert.throws(() => migratedDb.prepare("UPDATE certificate_records SET issued_at = NULL WHERE id = 'legacy-record'").run(), /constraint/i);
    const draft = await repository.create({ status: "draft", fullName: "Чернетка", certificateNumber: "002" });
    assert.throws(() => migratedDb.prepare("UPDATE certificate_records SET status = 'active' WHERE id = ?").run(draft.id), /constraint/i);
    assert.throws(() => migratedDb.prepare("UPDATE certificate_records SET status = 'unknown' WHERE id = ?").run(draft.id), /constraint/i);
    const snapshot = migratedDb.prepare("SELECT * FROM certificate_records ORDER BY id").all();
    migratedDb.close();
    const restarted = new CertificateRepository({ storageRoot, templatesDirectory });
    await restarted.list();
    const reopenedDb = new DatabaseSync(dbPath);
    assert.deepEqual(reopenedDb.prepare("SELECT * FROM certificate_records ORDER BY id").all(), snapshot);
    assert.equal(reopenedDb.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    reopenedDb.close();
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("failed migration rolls back the schema, rows, indexes and version marker together", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "avku-draft-migration-fail-"));
  try {
    const dbPath = path.join(storageRoot, "certificates.sqlite");
    const db = new DatabaseSync(dbPath);
    // Simulate a damaged old database that the new constraints must refuse.
    db.exec(LEGACY_SCHEMA.replace("issued_at TEXT NOT NULL", "issued_at TEXT"));
    db.prepare("INSERT INTO certificate_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "bad-legacy", "Волонтер", "", "", "003", null, "2027-01-02", "existing.png", 1, 0, 0, 0,
      "volunteer-card-v1-uk", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z",
    );
    const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const dataBefore = db.prepare("SELECT * FROM certificate_records").all();
    db.close();
    const repository = new CertificateRepository({ storageRoot, templatesDirectory });
    await assert.rejects(() => repository.list(), /constraint/i);
    const reopened = new DatabaseSync(dbPath);
    assert.deepEqual(reopened.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(), schemaBefore);
    assert.deepEqual(reopened.prepare("SELECT * FROM certificate_records").all(), dataBefore);
    assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 3);
    reopened.close();
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
