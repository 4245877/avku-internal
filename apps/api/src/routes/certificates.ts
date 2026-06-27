import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type { CertificateRepository } from "../modules/certificates/certificate-records";
import { readCertificatePayload } from "../http/body";
import { sendJson } from "../http/responses";

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

export async function handleCertificateRequest(
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
