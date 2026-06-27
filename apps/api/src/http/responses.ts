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

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader(
    "Access-Control-Allow-Origin",
    request.headers.origin ?? "*",
  );
  response.setHeader(
    "Vary",
    "Origin",
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
