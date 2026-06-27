import { type IncomingMessage } from "node:http";

import type {
  CertificatePayload,
  CertificatePhotoFilePayload,
} from "../modules/certificates/certificate-records";
import { HttpError } from "./responses";
import {
  type MultipartPart,
  parseMultipartBody,
} from "./multipart";

export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

export async function readRequestBody(
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
    templateId: fields.get("templateId"),
    photoCrop: parsePhotoCropField(fields.get("photoCrop")),
    photoFile,
  };
}

export async function readCertificatePayload(
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

export async function readJsonBody(
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
