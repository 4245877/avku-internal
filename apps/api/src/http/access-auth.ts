import { type IncomingMessage } from "node:http";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { HttpError } from "./responses";

/**
 * Application-level authentication for Cloudflare Access ("Phase 2").
 *
 * Every request that arrives through the Cloudflare Tunnel carries a signed
 * assertion in the `Cf-Access-Jwt-Assertion` header. We trust ONLY that JWT:
 * its signature is checked against Cloudflare's public keys, so it cannot be
 * forged even by a client that reaches the origin directly. The sibling
 * `Cf-Access-Authenticated-User-Email` header is plain text and is never
 * trusted on its own — a raw `curl -H` could set it.
 *
 * A request with no JWT is treated as trusted local (LAN) access, which keeps
 * the current behaviour for the LAN entry point. When the two Access env vars
 * are unset the whole mechanism is disabled and every request is treated as
 * local — safe, because external traffic is still gated by Cloudflare Access at
 * the edge.
 */

const JWT_HEADER = "cf-access-jwt-assertion";
const EMAIL_HEADER = "cf-access-authenticated-user-email";
const UNAUTHENTICATED_MESSAGE = "Необхідна автентифікація Cloudflare Access.";

/** Identity extracted from a verified Access JWT. */
export interface AccessIdentity {
  email: string;
}

/**
 * `null` marks a trusted local request (no JWT presented); a non-null value is
 * an Access-authenticated user.
 */
export type AccessContext = AccessIdentity | null;

type VerifyKey = Parameters<typeof jwtVerify>[1];

export interface AccessAuthOptions {
  /** Cloudflare Access team domain, e.g. `avku.cloudflareaccess.com`. */
  teamDomain?: string;
  /** Application Audience (AUD) tag of the Access application. */
  audience?: string;
  /**
   * Verification-key resolver, injectable for tests. Defaults to Cloudflare's
   * rotating remote JWKS at `https://<team>/cdn-cgi/access/certs`.
   */
  createVerifyKey?: (certsUrl: URL) => VerifyKey;
}

export interface AccessAuthenticator {
  /** True only when both the team domain and audience are configured. */
  readonly enabled: boolean;
  /**
   * Resolves the caller's identity, or `null` for trusted local access. Throws
   * {@link HttpError} 401 when a JWT is present but invalid, or when an Access
   * identity header is presented without a verifiable JWT.
   */
  authenticate(request: IncomingMessage): Promise<AccessContext>;
}

function readHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();

  return trimmed ? trimmed : undefined;
}

export function createAccessAuthenticator(
  options: AccessAuthOptions,
): AccessAuthenticator {
  const teamDomain = options.teamDomain?.trim();
  const audience = options.audience?.trim();

  if (!teamDomain || !audience) {
    // Disabled: behave exactly as before Phase 2 — every request is local.
    return {
      enabled: false,
      authenticate: async () => null,
    };
  }

  const issuer = `https://${teamDomain}`;
  const createVerifyKey =
    options.createVerifyKey ?? ((certsUrl) => createRemoteJWKSet(certsUrl));
  const verifyKey = createVerifyKey(
    new URL(`${issuer}/cdn-cgi/access/certs`),
  );

  return {
    enabled: true,
    authenticate: async (request) => {
      const token = readHeader(request, JWT_HEADER);

      if (!token) {
        // An identity header without the signed assertion is a spoofing attempt
        // (genuine Access always sends both), so refuse it. A request with
        // neither header is ordinary trusted local traffic.
        if (readHeader(request, EMAIL_HEADER)) {
          throw new HttpError(401, UNAUTHENTICATED_MESSAGE);
        }

        return null;
      }

      let email: unknown;

      try {
        const { payload } = await jwtVerify(token, verifyKey, {
          issuer,
          audience,
          // Cloudflare signs Access JWTs with RS256; pinning the algorithm
          // rejects "alg" confusion / "none" downgrade attempts.
          algorithms: ["RS256"],
        });

        email = payload.email;
      } catch {
        throw new HttpError(401, UNAUTHENTICATED_MESSAGE);
      }

      if (typeof email !== "string" || !email.trim()) {
        throw new HttpError(401, UNAUTHENTICATED_MESSAGE);
      }

      return { email: email.trim().toLowerCase() };
    },
  };
}
