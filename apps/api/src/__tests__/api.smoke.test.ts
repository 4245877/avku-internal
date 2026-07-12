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

// `fetch` forbids setting the `Origin` header, so drive CORS checks through the
// low-level client where an arbitrary Origin can actually be sent.
function rawRequest(
  method: string,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}${pathname}`,
      { method, headers },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
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

test("CORS withholds cross-origin access from an unlisted Origin", async () => {
  const simple = await rawRequest("GET", "/api/warehouse", {
    Origin: "https://evil.example",
  });

  assert.equal(simple.status, 200);
  // The unauthenticated API must not hand its data to a page on another origin:
  // with no allowlist configured, no Access-Control-Allow-Origin is emitted.
  assert.equal(simple.headers["access-control-allow-origin"], undefined);

  const preflight = await rawRequest("OPTIONS", "/api/warehouse", {
    Origin: "https://evil.example",
    "Access-Control-Request-Method": "DELETE",
  });

  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  assert.equal(preflight.headers["access-control-allow-methods"], undefined);
});

test("CSV export neutralises spreadsheet formula injection", async () => {
  const created = await api("POST", "/api/warehouse", {
    name: '=HYPERLINK("http://evil.example","x")',
    category: "Тест",
    unit: "шт.",
    quantity: 1,
    availableNow: 1,
  });

  assert.equal(created.status, 201);

  const response = await fetch(`${baseUrl}/api/warehouse/export.csv`);
  const csv = await response.text();

  // The formula is defused with a leading apostrophe...
  assert.ok(csv.includes("'=HYPERLINK("));
  // ...and never survives as a cell a spreadsheet would evaluate, i.e. a "="
  // directly after a line start, a delimiter, or an opening quote.
  assert.ok(!/(^|[",])=HYPERLINK/m.test(csv));
});
