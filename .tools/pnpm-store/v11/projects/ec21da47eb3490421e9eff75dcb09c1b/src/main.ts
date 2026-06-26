import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CertificateRepository,
  type CertificatePhotoFilePayload,
  type CertificatePayload,
} from "./modules/certificates/certificate-records";
import {
  WarehouseRepository,
} from "./modules/warehouse/warehouse-records";

const PORT = Number(
  process.env.PORT ?? process.env.API_PORT ?? 3001,
);
const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
const TEMPLATE_ASSETS = new Map([
  [
    "background.png",
    "image/png",
  ],
  [
    "stamp-overlay.png",
    "image/png",
  ],
]);

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function getRepositoryRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
}

function createRepository(): CertificateRepository {
  const repositoryRoot = getRepositoryRoot();
  const storageRoot =
    process.env.CERTIFICATES_STORAGE_ROOT ??
    path.join(
      repositoryRoot,
      "storage",
      "certificates",
    );
  const templateDirectory =
    process.env.CERTIFICATES_TEMPLATE_DIRECTORY ??
    path.join(
      storageRoot,
      "templates",
      "volunteer-card-v1",
    );

  return new CertificateRepository({
    storageRoot,
    templateDirectory,
    legacyRegistryPath: process.env.CERTIFICATES_LEGACY_REGISTRY_PATH,
  });
}

function createWarehouseRepository(): WarehouseRepository {
  const repositoryRoot = getRepositoryRoot();
  const storageRoot =
    process.env.WAREHOUSE_STORAGE_ROOT ??
    path.join(
      repositoryRoot,
      "storage",
      "warehouse",
    );

  return new WarehouseRepository({
    storageRoot,
  });
}

function applyCors(
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

function sendJson(
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

function sendError(
  response: ServerResponse,
  statusCode: number,
  error: unknown,
): void {
  sendJson(
    response,
    statusCode,
    {
      error: error instanceof Error
        ? error.message
        : "Ошибка обработки запроса.",
    },
  );
}

interface MultipartPart {
  name: string;
  fileName?: string;
  contentType?: string;
  content: Buffer;
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    totalLength += buffer.length;

    if (totalLength > MAX_REQUEST_BYTES) {
      throw new HttpError(
        413,
        "Размер запроса превышает лимит 30 МБ.",
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function getMultipartBoundary(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];

  if (!boundary) {
    throw new Error("Не указан boundary для multipart/form-data.");
  }

  return boundary.trim();
}

function parseContentDisposition(value: string): {
  name: string;
  fileName?: string;
} {
  const name = /(?:^|;\s*)name="([^"]*)"/i.exec(value)?.[1];
  const fileName = /(?:^|;\s*)filename="([^"]*)"/i.exec(value)?.[1];

  if (!name) {
    throw new Error("Некорректная часть multipart/form-data.");
  }

  return {
    name,
    fileName: fileName || undefined,
  };
}

function parseMultipartBody(
  body: Buffer,
  contentType: string,
): MultipartPart[] {
  const boundary = getMultipartBoundary(contentType);
  const delimiter = `--${boundary}`;
  const segments = body
    .toString("latin1")
    .split(delimiter)
    .slice(1, -1);

  return segments.map((segment) => {
    const normalizedSegment = segment.startsWith("\r\n")
      ? segment.slice(2)
      : segment;
    const headerEndIndex = normalizedSegment.indexOf("\r\n\r\n");

    if (headerEndIndex === -1) {
      throw new Error("Некорректное multipart/form-data тело.");
    }

    const rawHeaders = normalizedSegment.slice(0, headerEndIndex);
    let rawContent = normalizedSegment.slice(headerEndIndex + 4);

    if (rawContent.endsWith("\r\n")) {
      rawContent = rawContent.slice(0, -2);
    }

    const headers = new Map<string, string>();

    for (const line of rawHeaders.split("\r\n")) {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex === -1) {
        continue;
      }

      headers.set(
        line.slice(0, separatorIndex).trim().toLowerCase(),
        line.slice(separatorIndex + 1).trim(),
      );
    }

    const disposition = parseContentDisposition(
      headers.get("content-disposition") ?? "",
    );

    return {
      ...disposition,
      contentType: headers.get("content-type"),
      content: Buffer.from(
        rawContent,
        "latin1",
      ),
    };
  });
}

function parsePhotoCropField(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Некорректные параметры кадрирования фотографии.");
  }
}

function multipartPartsToPayload(parts: MultipartPart[]): CertificatePayload {
  const fields = new Map<string, string>();
  let photoFile: CertificatePhotoFilePayload | undefined;

  for (const part of parts) {
    if (part.fileName) {
      if (part.name === "photo" || part.name === "photoFile") {
        photoFile = {
          content: part.content,
          fileName: part.fileName,
          contentType: part.contentType,
        };
      }

      continue;
    }

    fields.set(
      part.name,
      part.content.toString("utf8"),
    );
  }

  return {
    fullName: fields.get("fullName"),
    certificateNumber: fields.get("certificateNumber"),
    issuedAt: fields.get("issuedAt"),
    validUntil: fields.get("validUntil"),
    photoCrop: parsePhotoCropField(fields.get("photoCrop")),
    photoFile,
  };
}

async function readCertificatePayload(
  request: IncomingMessage,
): Promise<CertificatePayload> {
  const body = await readRequestBody(request);

  if (body.length === 0) {
    return {};
  }

  const contentTypeHeader = request.headers["content-type"];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(";")
    : contentTypeHeader ?? "";

  if (contentType.includes("multipart/form-data")) {
    return multipartPartsToPayload(
      parseMultipartBody(
        body,
        contentType,
      ),
    );
  }

  return JSON.parse(
    body.toString("utf8"),
  ) as CertificatePayload;
}

function getDownloadName(
  extension: "png" | "pdf",
): string {
  return `certificate.${extension}`;
}

function getImageContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return "image/png";
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const body = await readRequestBody(request);

  if (body.length === 0) {
    return {};
  }

  const parsed = JSON.parse(body.toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(
      400,
      "Очікується тіло запиту у форматі JSON.",
    );
  }

  return parsed as Record<string, unknown>;
}

async function handleWarehouseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: WarehouseRepository,
  pathname: string,
): Promise<void> {
  if (request.method === "GET" && pathname === "/api/warehouse") {
    sendJson(
      response,
      200,
      await repository.list(),
    );
    return;
  }

  if (request.method === "POST" && pathname === "/api/warehouse") {
    sendJson(
      response,
      201,
      await repository.create(
        await readJsonBody(request),
      ),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/warehouse/export.csv") {
    const content = await repository.exportCsv();
    const buffer = Buffer.from(`﻿${content}`, "utf8");

    response.writeHead(
      200,
      {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": buffer.length,
        "Content-Disposition": 'attachment; filename="warehouse-stock.csv"',
      },
    );
    response.end(buffer);
    return;
  }

  const warehouseActionMatch =
    /^\/api\/warehouse\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);

  if (warehouseActionMatch) {
    const [, id, action] = warehouseActionMatch;

    if (request.method === "GET" && !action) {
      sendJson(
        response,
        200,
        await repository.get(id),
      );
      return;
    }

    if (request.method === "PUT" && !action) {
      sendJson(
        response,
        200,
        await repository.update(
          id,
          await readJsonBody(request),
        ),
      );
      return;
    }

    if (request.method === "DELETE" && !action) {
      await repository.remove(id);
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }

    if (request.method === "POST" && action === "movements") {
      sendJson(
        response,
        201,
        await repository.addMovement(
          id,
          await readJsonBody(request),
        ),
      );
      return;
    }
  }

  sendJson(
    response,
    404,
    {
      error: "Маршрут не найден.",
    },
  );
}

async function handleCertificateRequest(
  request: IncomingMessage,
  response: ServerResponse,
  repository: CertificateRepository,
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(
      response,
      200,
      {
        ok: true,
      },
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/certificates/template") {
    const layout = await repository.readTemplateLayout();

    sendJson(
      response,
      200,
      {
        id: layout.id,
        layout,
        assets: {
          backgroundUrl: "/api/certificates/template/background.png",
          stampOverlayUrl: "/api/certificates/template/stamp-overlay.png",
        },
      },
    );
    return;
  }

  const templateAssetMatch =
    /^\/api\/certificates\/template\/([^/]+)$/.exec(pathname);

  if (
    request.method === "GET" &&
    templateAssetMatch &&
    TEMPLATE_ASSETS.has(templateAssetMatch[1])
  ) {
    const fileName = templateAssetMatch[1];
    const content = await readFile(
      repository.getTemplateAssetPath(fileName),
    );

    response.writeHead(
      200,
      {
        "Content-Type": TEMPLATE_ASSETS.get(fileName) ?? "application/octet-stream",
        "Content-Length": content.length,
        "Cache-Control": "public, max-age=3600",
      },
    );
    response.end(content);
    return;
  }

  const photoMatch = /^\/api\/certificates\/photos\/([^/]+)$/.exec(pathname);

  if (request.method === "GET" && photoMatch) {
    const fileName = photoMatch[1];
    const content = await readFile(
      repository.getPhotoPath(fileName),
    );

    response.writeHead(
      200,
      {
        "Content-Type": getImageContentType(fileName),
        "Content-Length": content.length,
        "Cache-Control": "private, max-age=60",
      },
    );
    response.end(content);
    return;
  }

  if (request.method === "GET" && pathname === "/api/certificates") {
    sendJson(
      response,
      200,
      await repository.list(),
    );
    return;
  }

  if (request.method === "POST" && pathname === "/api/certificates") {
    sendJson(
      response,
      201,
      await repository.create(
        await readCertificatePayload(request),
      ),
    );
    return;
  }

  const certificateActionMatch =
    /^\/api\/certificates\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);

  if (certificateActionMatch) {
    const [, id, action] = certificateActionMatch;

    if (request.method === "GET" && !action) {
      sendJson(
        response,
        200,
        await repository.get(id),
      );
      return;
    }

    if (request.method === "PUT" && !action) {
      sendJson(
        response,
        200,
        await repository.update(
          id,
          await readCertificatePayload(request),
        ),
      );
      return;
    }

    if (request.method === "PATCH" && action === "renew") {
      sendJson(
        response,
        200,
        await repository.renew(id),
      );
      return;
    }

    if (request.method === "DELETE" && !action) {
      await repository.remove(id);
      sendJson(
        response,
        200,
        {
          ok: true,
        },
      );
      return;
    }

    if (request.method === "GET" && action === "export.png") {
      const filePath = await repository.renderPng(id);
      const content = await readFile(filePath);

      response.writeHead(
        200,
        {
          "Content-Type": "image/png",
          "Content-Length": content.length,
          "Content-Disposition": `attachment; filename="${getDownloadName("png")}"`,
        },
      );
      response.end(content);
      return;
    }

    if (request.method === "GET" && action === "export.pdf") {
      const content = await repository.renderPdf(id);

      response.writeHead(
        200,
        {
          "Content-Type": "application/pdf",
          "Content-Length": content.length,
          "Content-Disposition": `attachment; filename="${getDownloadName("pdf")}"`,
        },
      );
      response.end(content);
      return;
    }
  }

  sendJson(
    response,
    404,
    {
      error: "Маршрут не найден.",
    },
  );
}

function resolveErrorStatusCode(error: unknown): number {
  if (error instanceof HttpError) {
    return error.statusCode;
  }

  if (error instanceof SyntaxError) {
    return 400;
  }

  if (error instanceof Error && error.message.includes("не найден")) {
    return 404;
  }

  if (error instanceof Error && error.message.includes("не знайдено")) {
    return 404;
  }

  return 400;
}

async function dispatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  certificateRepository: CertificateRepository,
  warehouseRepository: WarehouseRepository,
): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const pathname = decodeURIComponent(url.pathname);

  if (
    pathname === "/api/warehouse" ||
    pathname.startsWith("/api/warehouse/")
  ) {
    await handleWarehouseRequest(
      request,
      response,
      warehouseRepository,
      pathname,
    );
    return;
  }

  await handleCertificateRequest(
    request,
    response,
    certificateRepository,
  );
}

export function createCertificateApiServer(): http.Server {
  const certificateRepository = createRepository();
  const warehouseRepository = createWarehouseRepository();

  return http.createServer((request, response) => {
    applyCors(
      request,
      response,
    );

    dispatchRequest(
      request,
      response,
      certificateRepository,
      warehouseRepository,
    ).catch((error: unknown) => {
      sendError(
        response,
        resolveErrorStatusCode(error),
        error,
      );
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    await createRepository().check();
    await createWarehouseRepository().check();
    console.log("Certificates and warehouse API storage check passed.");
    return;
  }

  createCertificateApiServer().listen(
    PORT,
    () => {
      console.log(`AVKU API is listening on http://localhost:${PORT}`);
    },
  );
}

function isMainModule(): boolean {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
