import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

import { SignJWT, generateKeyPair } from "jose";

import {
  type AccessAuthenticator,
  createAccessAuthenticator,
} from "../http/access-auth";
import { HttpError } from "../http/responses";
import { createCertificateApiServer } from "../server";

/**
 * Exercises the real Cloudflare Access verification path: a local RSA keypair
 * stands in for Cloudflare's signing keys (injected via `createVerifyKey`), so
 * genuinely signed JWTs are minted and verified without any network calls.
 */

const TEAM_DOMAIN = "avku.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "test-aud-tag";

type GeneratedKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: GeneratedKey;
let publicKey: GeneratedKey;

let dataRoot: string;
let server: http.Server;
let baseUrl: string;

function makeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function enabledAuthenticator(): AccessAuthenticator {
  return createAccessAuthenticator({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    // Stand in for Cloudflare's remote JWKS: a key-resolver (the shape jose's
    // `createRemoteJWKSet` returns) that always yields our local public key.
    createVerifyKey: () => () => publicKey,
  });
}

async function signAccessJwt(
  overrides: {
    email?: unknown;
    issuer?: string;
    audience?: string;
    expirationTime?: string;
  } = {},
): Promise<string> {
  return new SignJWT({ email: overrides.email ?? "User@Example.com" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime(overrides.expirationTime ?? "2h")
    .sign(privateKey);
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 401;
}

function getMe(
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}/api/me`,
      { method: "GET", headers },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            json: body ? JSON.parse(body) : {},
          }),
        );
      },
    );

    request.on("error", reject);
    request.end();
  });
}

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;

  dataRoot = await mkdtemp(path.join(tmpdir(), "avku-access-"));
  process.env.DATA_ROOT = dataRoot;

  server = createCertificateApiServer(undefined, {
    authenticator: enabledAuthenticator(),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  try {
    await rm(dataRoot, { recursive: true, force: true });
  } catch {
    // Temp dir under the OS temp folder; leaving it behind is harmless.
  }
});

test("authenticator is disabled without team domain + audience", async () => {
  const auth = createAccessAuthenticator({});

  assert.equal(auth.enabled, false);
  // Disabled = pre-Phase-2 behaviour: everything is trusted local access.
  assert.equal(
    await auth.authenticate(makeRequest({ "cf-access-jwt-assertion": "x" })),
    null,
  );
});

test("a valid Access JWT resolves the normalised email", async () => {
  const identity = await enabledAuthenticator().authenticate(
    makeRequest({ "cf-access-jwt-assertion": await signAccessJwt() }),
  );

  assert.deepEqual(identity, { email: "user@example.com" });
});

test("a request with no Access headers is trusted local access", async () => {
  assert.equal(await enabledAuthenticator().authenticate(makeRequest({})), null);
});

test("an email header without a signed JWT is rejected", async () => {
  await assert.rejects(
    enabledAuthenticator().authenticate(
      makeRequest({
        "cf-access-authenticated-user-email": "spoof@evil.example",
      }),
    ),
    isUnauthorized,
  );
});

test("a JWT for the wrong audience is rejected", async () => {
  await assert.rejects(
    enabledAuthenticator().authenticate(
      makeRequest({
        "cf-access-jwt-assertion": await signAccessJwt({
          audience: "someone-else",
        }),
      }),
    ),
    isUnauthorized,
  );
});

test("a JWT from the wrong issuer is rejected", async () => {
  await assert.rejects(
    enabledAuthenticator().authenticate(
      makeRequest({
        "cf-access-jwt-assertion": await signAccessJwt({
          issuer: "https://attacker.cloudflareaccess.com",
        }),
      }),
    ),
    isUnauthorized,
  );
});

test("a malformed JWT is rejected", async () => {
  await assert.rejects(
    enabledAuthenticator().authenticate(
      makeRequest({ "cf-access-jwt-assertion": "not.a.jwt" }),
    ),
    isUnauthorized,
  );
});

test("GET /api/me returns and provisions the employee for a valid JWT", async () => {
  const me = await getMe({
    "cf-access-jwt-assertion": await signAccessJwt({ email: "worker@avku.org" }),
  });

  assert.equal(me.status, 200);
  assert.equal(me.json.email, "worker@avku.org");
  assert.equal(me.json.name, null);
  assert.ok(typeof me.json.firstSeen === "string" && me.json.firstSeen);
});

test("GET /api/me reports local access when no JWT is presented", async () => {
  const me = await getMe();

  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { email: null, local: true });
});

test("GET /api/me rejects an invalid JWT with 401", async () => {
  const me = await getMe({ "cf-access-jwt-assertion": "bad" });

  assert.equal(me.status, 401);
});
