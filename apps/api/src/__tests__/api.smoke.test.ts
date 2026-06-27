import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { createCertificateApiServer } from "../server";

/**
 * End-to-end smoke tests that exercise the public HTTP surface against an
 * isolated, temporary `DATA_ROOT`. They guard the contract of every domain
 * (health, certificates, warehouse, logistics) without touching the real
 * storage volumes.
 */

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

async function api(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(
    `${baseUrl}${pathname}`,
    {
      method,
      headers: body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const text = await response.text();

  return {
    status: response.status,
    json: text ? JSON.parse(text) : undefined,
  };
}

before(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "avku-api-smoke-"));
  process.env.DATA_ROOT = dataRoot;
  delete process.env.CERTIFICATES_STORAGE_ROOT;
  delete process.env.WAREHOUSE_STORAGE_ROOT;
  delete process.env.LOGISTICS_STORAGE_ROOT;

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

  // Best-effort cleanup: open SQLite handles can keep the file locked on
  // Windows, so a failed temp removal must not fail the test run.
  try {
    await rm(dataRoot, { recursive: true, force: true });
  } catch {
    // The temporary directory lives under the OS temp folder; leaving it
    // behind is harmless.
  }
});

test("GET /api/health reports ok", async () => {
  const { status, json } = await api("GET", "/api/health");

  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
});

test("GET /api/certificates returns an empty list initially", async () => {
  const { status, json } = await api("GET", "/api/certificates");

  assert.equal(status, 200);
  assert.ok(Array.isArray(json));
  assert.equal((json as unknown[]).length, 0);
});

test("warehouse supports create, get and CSV export", async () => {
  const created = await api("POST", "/api/warehouse", {
    name: "Тестова позиція",
    category: "Тест",
    unit: "шт.",
    quantity: 5,
    availableNow: 3,
  });

  assert.equal(created.status, 201);
  const item = created.json as { id: string; code: string };
  assert.ok(item.id);
  assert.match(item.code, /^WH-/);

  const fetched = await api("GET", `/api/warehouse/${item.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.json as { id: string }).id, item.id);

  const list = await api("GET", "/api/warehouse");
  assert.equal(list.status, 200);
  assert.ok(
    (list.json as { id: string }[]).some((row) => row.id === item.id),
  );

  const csv = await fetch(`${baseUrl}/api/warehouse/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(
    csv.headers.get("content-type") ?? "",
    /text\/csv/,
  );
});

test("logistics seeds data and supports create", async () => {
  const list = await api("GET", "/api/logistics");

  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json));
  assert.ok((list.json as unknown[]).length > 0);

  const created = await api("POST", "/api/logistics", {
    route: "Київ — Харків",
    recipient: "Підрозділ",
    driver: "Волонтер",
    transferDate: "2026-06-27",
  });

  assert.equal(created.status, 201);
  assert.match((created.json as { code: string }).code, /^TR-/);
});

test("unknown warehouse id yields 404", async () => {
  const { status, json } = await api(
    "GET",
    "/api/warehouse/does-not-exist",
  );

  assert.equal(status, 404);
  assert.ok((json as { error?: string }).error);
});

test("unknown route yields 404", async () => {
  const { status, json } = await api("GET", "/api/unknown");

  assert.equal(status, 404);
  assert.deepEqual(json, { error: "Маршрут не найден." });
});
