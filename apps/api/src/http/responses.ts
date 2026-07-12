import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

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

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const content = JSON.stringify(payload);

  response.writeHead(
    statusCode,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(content),
    },
  );
  response.end(content);
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
