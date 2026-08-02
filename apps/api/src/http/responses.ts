import { createHash } from "node:crypto";
import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from "node:zlib";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Cross-origin allowlist. The normal UI is served same-origin (dev through the
 * Vite `/api` proxy, prod through nginx) and therefore never triggers CORS, so
 * the allowlist is empty by default. That deliberately withholds
 * `Access-Control-Allow-Origin` from arbitrary sites, which stops a page on any
 * other origin from reading responses of — or scripting writes to — this
 * unauthenticated API from a browser inside the LAN. Add trusted origins via
 * the comma-separated `AVKU_CORS_ALLOWED_ORIGINS` env var only if a genuine
 * cross-origin browser client is ever introduced.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  (process.env.AVKU_CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
);

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  // Always vary on Origin so a cached response for one origin is never reused
  // for another, regardless of whether we end up allowing this request.
  response.setHeader(
    "Vary",
    "Origin",
  );

  const origin = request.headers.origin;

  if (origin === undefined || !ALLOWED_ORIGINS.has(origin)) {
    return;
  }

  response.setHeader(
    "Access-Control-Allow-Origin",
    origin,
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type",
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
}

/**
 * Below this a compressed body is not worth the CPU — and for a response that
 * fits in one packet it is not worth the bytes either, since the framing
 * overhead can exceed what was saved.
 */
const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * Brotli's quality dial, chosen for a server answering interactively rather
 * than for a build step. On the map payload q4 lands within a few per cent of
 * q11's ratio for a small fraction of its cost; anything higher spends more
 * time compressing than the client saves downloading on a LAN.
 */
const BROTLI_QUALITY = 4;

/**
 * How a response may be cached, when the caller has an opinion.
 *
 * `immutable` is for a body that is addressed by its own version — the caller
 * promises the URL changes when the content does, which is what lets a browser
 * skip the request entirely rather than merely revalidate it.
 */
export interface JsonCacheOptions {
  cacheControl?: string;
  /** Extra input mixed into the ETag, e.g. the viewer whose rows these are. */
  etagSalt?: string;
}

function negotiateEncoding(request: IncomingMessage | undefined): "br" | "gzip" | null {
  const header = String(request?.headers["accept-encoding"] ?? "").toLowerCase();

  if (header.includes("br")) {
    return "br";
  }

  if (header.includes("gzip")) {
    return "gzip";
  }

  return null;
}

/**
 * True when the client already holds this exact representation.
 *
 * Compared against the *uncompressed* entity tag: the same rows are the same
 * answer whether they arrive gzipped or not, and a client that switches
 * encodings should still be told "unchanged" rather than handed the body again.
 */
function matchesIfNoneMatch(
  request: IncomingMessage | undefined,
  etag: string,
): boolean {
  const header = request?.headers["if-none-match"];

  if (!header) {
    return false;
  }

  return String(header)
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag);
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  options: JsonCacheOptions = {},
): void {
  const content = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  );
  const request = response.req as IncomingMessage | undefined;

  /*
   * Only a plain successful read is worth an entity tag. A 201 or a 400 is
   * about what just happened rather than about a resource the client can hold,
   * and revalidating one would be meaningless.
   */
  const isCacheable = statusCode === 200 && request?.method === "GET";

  if (!isCacheable) {
    response.writeHead(
      statusCode,
      {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": content.byteLength,
      },
    );
    response.end(content);
    return;
  }

  const etag = `"${
    createHash("sha1")
      .update(options.etagSalt ?? "")
      .update(content)
      .digest("base64url")
  }"`;

  if (matchesIfNoneMatch(
    request,
    etag,
  )) {
    // A 304 carries no body, so nothing is compressed and nothing is measured
    // against Content-Length — the client keeps what it already parsed.
    response.writeHead(
      304,
      {
        ETag: etag,
        "Cache-Control": options.cacheControl ?? "private, no-cache",
      },
    );
    response.end();
    return;
  }

  const encoding = content.byteLength >= COMPRESSION_THRESHOLD_BYTES
    ? negotiateEncoding(request)
    : null;

  let body = content;

  if (encoding === "br") {
    body = brotliCompressSync(
      content,
      {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: content.byteLength,
        },
      },
    );
  } else if (encoding === "gzip") {
    body = gzipSync(
      content,
      {
        level: 6,
      },
    );
  }

  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.byteLength,
    ETag: etag,
    "Cache-Control": options.cacheControl ?? "private, no-cache",
  };

  if (encoding) {
    headers["Content-Encoding"] = encoding;
    // Without this a shared cache could hand a gzipped body to a client that
    // asked for none. The CORS layer already varies on Origin; append rather
    // than replace so neither reason is lost.
    const existing = response.getHeader("Vary");
    headers.Vary = existing ? `${String(existing)}, Accept-Encoding` : "Accept-Encoding";
  }

  response.writeHead(
    statusCode,
    headers,
  );
  response.end(body);
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  sendJson(
    response,
    statusCode,
    {
      error: message,
    },
  );
}
