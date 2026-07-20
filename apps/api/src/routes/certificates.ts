import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import sharp from "sharp";

import type {
  CertificateRepository,
  CertificateTemplateDefinition,
} from "../modules/certificates/certificate-records";
import {
  readCertificatePayload,
  readJsonBody,
} from "../http/body";
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

// Editor previews only ever paint the photo into a 377x519 frame, so the stored
// original (routinely 3000px / several MB) is orders of magnitude larger than
// needed. Serving a downscaled variant keeps the cropper responsive over the
// Cloudflare tunnel, where a multi-megabyte photo per record switch is the
// difference between an instant preview and a blank frame for several seconds.
// Exports are unaffected: the renderer reads the original file from disk.
const MAX_PREVIEW_WIDTH = 1600;
const PREVIEW_CACHE_LIMIT = 160;

type PreviewEntry = {
  body: Buffer;
  contentType: string;
};

const previewCache = new Map<string, PreviewEntry>();

function rememberPreview(key: string, entry: PreviewEntry): void {
  // Small insertion-ordered LRU: re-inserting on read/write keeps hot photos in.
  previewCache.delete(key);
  previewCache.set(key, entry);

  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldestKey = previewCache.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    previewCache.delete(oldestKey);
  }
}

function parsePreviewWidth(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const width = Number(value);

  if (!Number.isFinite(width) || width <= 0) {
    return null;
  }

  return Math.min(Math.round(width), MAX_PREVIEW_WIDTH);
}

/**
 * Downscaled JPEG for on-screen use, cached per (file, width, mtime) so a photo
 * is re-encoded once rather than on every request. `withoutEnlargement` keeps
 * small originals untouched; `rotate()` bakes in EXIF orientation so the preview
 * matches what the renderer produces.
 */
async function readPhotoPreview(
  photoPath: string,
  width: number,
): Promise<PreviewEntry> {
  const { mtimeMs } = await stat(photoPath);
  const cacheKey = `${photoPath}:${width}:${mtimeMs}`;
  const cached = previewCache.get(cacheKey);

  if (cached) {
    rememberPreview(cacheKey, cached);
    return cached;
  }

  const body = await sharp(photoPath)
    .rotate()
    .resize({
      width,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({
      quality: 82,
      mozjpeg: true,
    })
    .toBuffer();
  const entry: PreviewEntry = {
    body,
    contentType: "image/jpeg",
  };

  rememberPreview(cacheKey, entry);

  return entry;
}

function getTemplateAssetUrl(
  templateId: string,
  fileName: string,
): string {
  return `/api/certificates/templates/${encodeURIComponent(templateId)}/${fileName}`;
}

function toTemplateResponse(
  template: CertificateTemplateDefinition,
): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    locale: template.locale,
    isDefault: template.isDefault,
    layout: template.layout,
    assets: {
      backgroundUrl: getTemplateAssetUrl(
        template.id,
        "background.png",
      ),
      stampOverlayUrl: getTemplateAssetUrl(
        template.id,
        "stamp-overlay.png",
      ),
    },
  };
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

  if (request.method === "GET" && pathname === "/api/certificates/templates") {
    const templates = await repository.listTemplates();

    sendJson(
      response,
      200,
      {
        defaultId: repository.getDefaultTemplateId(),
        templates: templates.map(toTemplateResponse),
      },
    );
    return;
  }

  const localizedTemplateAssetMatch =
    /^\/api\/certificates\/templates\/([^/]+)\/([^/]+)$/.exec(pathname);

  if (
    request.method === "GET" &&
    localizedTemplateAssetMatch &&
    TEMPLATE_ASSETS.has(localizedTemplateAssetMatch[2])
  ) {
    const [, templateId, fileName] = localizedTemplateAssetMatch;
    const content = await readFile(
      repository.getTemplateAssetPath(
        fileName,
        templateId,
      ),
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

  const localizedTemplateMatch =
    /^\/api\/certificates\/templates\/([^/]+)$/.exec(pathname);

  if (request.method === "GET" && localizedTemplateMatch) {
    sendJson(
      response,
      200,
      toTemplateResponse(
        await repository.getTemplate(localizedTemplateMatch[1]),
      ),
    );
    return;
  }

  if (request.method === "GET" && pathname === "/api/certificates/template") {
    const templateId = url.searchParams.get("templateId") ??
      url.searchParams.get("id") ??
      repository.getDefaultTemplateId();

    sendJson(
      response,
      200,
      toTemplateResponse(
        await repository.getTemplate(templateId),
      ),
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
    const photoPath = repository.getPhotoPath(fileName);
    // `?w=` asks for a downscaled preview; without it the original is served, so
    // existing links and any consumer needing full resolution keep working.
    const previewWidth = parsePreviewWidth(url.searchParams.get("w"));

    if (previewWidth === null) {
      const content = await readFile(photoPath);

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

    const preview = await readPhotoPreview(photoPath, previewWidth);

    response.writeHead(
      200,
      {
        "Content-Type": preview.contentType,
        "Content-Length": preview.body.length,
        // A preview is derived from an immutable stored file at a fixed width,
        // so it can be cached far longer than the original's short TTL.
        "Cache-Control": "private, max-age=86400",
      },
    );
    response.end(preview.body);
    return;
  }

  if (request.method === "GET" && pathname === "/api/certificates") {
    // All query parameters are optional; without them the full list is
    // returned, preserving the original contract for existing clients.
    sendJson(
      response,
      200,
      await repository.list({
        search:
          url.searchParams.get("search") ??
          url.searchParams.get("q") ??
          undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
      }),
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

  if (
    request.method === "POST" &&
    pathname === "/api/certificates/print-sheet"
  ) {
    const body = await readJsonBody(request);
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => String(id))
      : [];
    const content = await repository.renderPrintSheet(
      ids,
      {
        frontTemplateId:
          typeof body.frontTemplateId === "string"
            ? body.frontTemplateId
            : undefined,
        backTemplateId:
          typeof body.backTemplateId === "string"
            ? body.backTemplateId
            : undefined,
      },
    );

    response.writeHead(
      200,
      {
        "Content-Type": "application/pdf",
        "Content-Length": content.length,
        "Content-Disposition": 'attachment; filename="certificates-a4.pdf"',
      },
    );
    response.end(content);
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
      const filePath = await repository.renderPng(
        id,
        url.searchParams.get("templateId") ?? undefined,
      );
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
      const content = await repository.renderPdf(
        id,
        url.searchParams.get("templateId") ?? undefined,
      );

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
