import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CertificateRepository,
  type CertificatePayload,
} from "./modules/certificates/certificate-records";

const PORT = Number(
  process.env.PORT ?? process.env.API_PORT ?? 3001,
);
const MAX_JSON_BYTES = 30 * 1024 * 1024;
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

async function readJsonBody(
  request: IncomingMessage,
): Promise<CertificatePayload> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    totalLength += buffer.length;

    if (totalLength > MAX_JSON_BYTES) {
      throw new Error("Размер запроса превышает лимит.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
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
        await readJsonBody(request),
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
          await readJsonBody(request),
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

export function createCertificateApiServer(): http.Server {
  const repository = createRepository();

  return http.createServer((request, response) => {
    applyCors(
      request,
      response,
    );

    handleCertificateRequest(
      request,
      response,
      repository,
    ).catch((error: unknown) => {
      const statusCode =
        error instanceof SyntaxError
          ? 400
          : error instanceof Error &&
              error.message.includes("не найден")
            ? 404
            : 400;

      sendError(
        response,
        statusCode,
        error,
      );
    });
  });
}

async function main(): Promise<void> {
  const repository = createRepository();

  if (process.argv.includes("--check")) {
    await repository.check();
    console.log("Certificates API storage and template check passed.");
    return;
  }

  createCertificateApiServer().listen(
    PORT,
    () => {
      console.log(`Certificates API is listening on http://localhost:${PORT}`);
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
