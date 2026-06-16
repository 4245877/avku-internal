import path from "node:path";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { renderCertificate } from "./certificate-renderer";
import { createPdfFromPng } from "./certificate-pdf";
import type {
  CertificateLayout,
  CertificatePhotoCrop,
  RenderCertificateInput,
} from "./certificate.types";

const TEMPLATE_ID = "volunteer-card-v1";
const DEFAULT_CROP: CertificatePhotoCrop = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

const IMAGE_DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=\r\n]+)$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface CertificateRecord {
  id: string;
  fullName: string;
  certificateNumber: string;
  issuedAt: string;
  validUntil: string;
  photoFileName: string;
  photoCrop: CertificatePhotoCrop;
  templateId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CertificateRecordResponse extends CertificateRecord {
  photoUrl: string;
  exportUrls: {
    png: string;
    pdf: string;
  };
}

export interface CertificatePayload {
  fullName?: unknown;
  certificateNumber?: unknown;
  issuedAt?: unknown;
  validUntil?: unknown;
  photoDataUrl?: unknown;
  photoCrop?: Partial<CertificatePhotoCrop>;
}

export interface CertificateRepositoryOptions {
  storageRoot: string;
  templateDirectory: string;
}

function normalizeWhitespace(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DATE_PATTERN.test(value)
  ) {
    throw new Error("Дата должна быть в формате YYYY-MM-DD.");
  }

  const [year, month, day] = value
    .split("-")
    .map(Number);
  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Некорректная дата.");
  }

  return value;
}

function normalizeRequiredText(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName}: обязательное поле.`);
  }

  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    throw new Error(`${fieldName}: обязательное поле.`);
  }

  return normalizedValue;
}

function normalizeCrop(
  value: Partial<CertificatePhotoCrop> | undefined,
  fallback: CertificatePhotoCrop = DEFAULT_CROP,
): CertificatePhotoCrop {
  const zoom = Number(value?.zoom ?? fallback.zoom);
  const offsetX = Number(value?.offsetX ?? fallback.offsetX);
  const offsetY = Number(value?.offsetY ?? fallback.offsetY);

  return {
    zoom: Math.min(
      Math.max(
        Number.isFinite(zoom) ? zoom : DEFAULT_CROP.zoom,
        1,
      ),
      3,
    ),
    offsetX: Number.isFinite(offsetX) ? offsetX : DEFAULT_CROP.offsetX,
    offsetY: Number.isFinite(offsetY) ? offsetY : DEFAULT_CROP.offsetY,
  };
}

function getExtensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return "jpg";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  return "png";
}

function splitFullName(fullName: string): Pick<
  RenderCertificateInput,
  "lastName" | "firstName" | "middleName"
> {
  const [lastName = "", firstName = "", ...middleNameParts] =
    normalizeWhitespace(fullName).split(" ");

  return {
    lastName,
    firstName,
    middleName: middleNameParts.join(" "),
  };
}

function addOneYear(value: string): string {
  const sourceDate = new Date(`${value}T00:00:00.000Z`);
  const today = new Date();
  const todayUtc = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    ),
  );
  const baseDate =
    !Number.isNaN(sourceDate.getTime()) && sourceDate > todayUtc
      ? sourceDate
      : todayUtc;
  const nextDate = new Date(baseDate);

  nextDate.setUTCFullYear(nextDate.getUTCFullYear() + 1);

  return nextDate.toISOString().slice(0, 10);
}

export function toCertificateResponse(
  record: CertificateRecord,
): CertificateRecordResponse {
  const encodedId = encodeURIComponent(record.id);
  const encodedPhoto = encodeURIComponent(record.photoFileName);

  return {
    ...record,
    photoUrl: `/api/certificates/photos/${encodedPhoto}`,
    exportUrls: {
      png: `/api/certificates/${encodedId}/export.png`,
      pdf: `/api/certificates/${encodedId}/export.pdf`,
    },
  };
}

export class CertificateRepository {
  private readonly registryPath: string;

  private readonly photosDirectory: string;

  private readonly generatedDirectory: string;

  private readonly templateDirectory: string;

  constructor(options: CertificateRepositoryOptions) {
    this.registryPath = path.join(
      options.storageRoot,
      "registry.json",
    );
    this.photosDirectory = path.join(
      options.storageRoot,
      "photos",
    );
    this.generatedDirectory = path.join(
      options.storageRoot,
      "generated",
    );
    this.templateDirectory = options.templateDirectory;
  }

  async check(): Promise<void> {
    await this.ensureDirectories();
    await this.readTemplateLayout();
  }

  async list(): Promise<CertificateRecordResponse[]> {
    const records = await this.readRegistry();

    return records
      .sort((first, second) =>
        second.updatedAt.localeCompare(first.updatedAt),
      )
      .map(toCertificateResponse);
  }

  async get(id: string): Promise<CertificateRecordResponse> {
    return toCertificateResponse(
      await this.findRecord(id),
    );
  }

  async create(
    payload: CertificatePayload,
  ): Promise<CertificateRecordResponse> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const photoFileName = await this.savePhoto(
      id,
      payload.photoDataUrl,
    );
    const record: CertificateRecord = {
      id,
      fullName: normalizeRequiredText(
        payload.fullName,
        "ФИО",
      ),
      certificateNumber: normalizeRequiredText(
        payload.certificateNumber,
        "Номер удостоверения",
      ),
      issuedAt: normalizeDate(payload.issuedAt),
      validUntil: normalizeDate(payload.validUntil),
      photoFileName,
      photoCrop: normalizeCrop(payload.photoCrop),
      templateId: TEMPLATE_ID,
      createdAt: now,
      updatedAt: now,
    };

    const records = await this.readRegistry();
    await this.writeRegistry([
      record,
      ...records,
    ]);

    return toCertificateResponse(record);
  }

  async update(
    id: string,
    payload: CertificatePayload,
  ): Promise<CertificateRecordResponse> {
    const records = await this.readRegistry();
    const recordIndex = records.findIndex((record) => record.id === id);

    if (recordIndex === -1) {
      throw new Error("Удостоверение не найдено.");
    }

    const existingRecord = records[recordIndex];
    const photoFileName =
      typeof payload.photoDataUrl === "string" && payload.photoDataUrl
        ? await this.savePhoto(
          id,
          payload.photoDataUrl,
        )
        : existingRecord.photoFileName;
    const updatedRecord: CertificateRecord = {
      ...existingRecord,
      fullName: normalizeRequiredText(
        payload.fullName,
        "ФИО",
      ),
      certificateNumber: normalizeRequiredText(
        payload.certificateNumber,
        "Номер удостоверения",
      ),
      issuedAt: normalizeDate(payload.issuedAt),
      validUntil: normalizeDate(payload.validUntil),
      photoFileName,
      photoCrop: normalizeCrop(
        payload.photoCrop,
        existingRecord.photoCrop,
      ),
      updatedAt: new Date().toISOString(),
    };

    records[recordIndex] = updatedRecord;
    await this.writeRegistry(records);

    return toCertificateResponse(updatedRecord);
  }

  async renew(id: string): Promise<CertificateRecordResponse> {
    const records = await this.readRegistry();
    const recordIndex = records.findIndex((record) => record.id === id);

    if (recordIndex === -1) {
      throw new Error("Удостоверение не найдено.");
    }

    const updatedRecord: CertificateRecord = {
      ...records[recordIndex],
      validUntil: addOneYear(records[recordIndex].validUntil),
      updatedAt: new Date().toISOString(),
    };

    records[recordIndex] = updatedRecord;
    await this.writeRegistry(records);

    return toCertificateResponse(updatedRecord);
  }

  async readTemplateLayout(): Promise<CertificateLayout> {
    const content = await readFile(
      path.join(
        this.templateDirectory,
        "layout.json",
      ),
      "utf8",
    );

    return JSON.parse(
      content.replace(/^\uFEFF/, ""),
    ) as CertificateLayout;
  }

  getTemplateAssetPath(fileName: string): string {
    return path.join(
      this.templateDirectory,
      fileName,
    );
  }

  getPhotoPath(fileName: string): string {
    return path.join(
      this.photosDirectory,
      path.basename(fileName),
    );
  }

  async renderPng(id: string): Promise<string> {
    const record = await this.findRecord(id);
    const outputPath = path.join(
      this.generatedDirectory,
      `${record.id}.png`,
    );
    const nameParts = splitFullName(record.fullName);

    await renderCertificate({
      templateDirectory: this.templateDirectory,
      outputPath,
      photoPath: this.getPhotoPath(record.photoFileName),
      photoCrop: record.photoCrop,
      ...nameParts,
      certificateNumber: record.certificateNumber,
      issuedAt: record.issuedAt,
      validUntil: record.validUntil,
    });

    return outputPath;
  }

  async renderPdf(id: string): Promise<Buffer> {
    return createPdfFromPng(
      await this.renderPng(id),
    );
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(
        path.dirname(this.registryPath),
        {
          recursive: true,
        },
      ),
      mkdir(
        this.photosDirectory,
        {
          recursive: true,
        },
      ),
      mkdir(
        this.generatedDirectory,
        {
          recursive: true,
        },
      ),
    ]);
  }

  private async readRegistry(): Promise<CertificateRecord[]> {
    await this.ensureDirectories();

    try {
      const content = await readFile(
        this.registryPath,
        "utf8",
      );
      const parsedValue = JSON.parse(
        content.replace(/^\uFEFF/, ""),
      );

      return Array.isArray(parsedValue)
        ? parsedValue.map((record) => ({
          ...record,
          photoCrop: normalizeCrop(record.photoCrop),
        }))
        : [];
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }

      throw error;
    }
  }

  private async writeRegistry(
    records: CertificateRecord[],
  ): Promise<void> {
    await this.ensureDirectories();

    const temporaryPath = `${this.registryPath}.tmp`;

    await writeFile(
      temporaryPath,
      `${JSON.stringify(records, null, 2)}\n`,
      "utf8",
    );
    await rename(
      temporaryPath,
      this.registryPath,
    );
  }

  private async findRecord(
    id: string,
  ): Promise<CertificateRecord> {
    const records = await this.readRegistry();
    const record = records.find((item) => item.id === id);

    if (!record) {
      throw new Error("Удостоверение не найдено.");
    }

    return record;
  }

  private async savePhoto(
    id: string,
    dataUrl: unknown,
  ): Promise<string> {
    if (typeof dataUrl !== "string") {
      throw new Error("Фотография обязательна.");
    }

    const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);

    if (!match) {
      throw new Error("Фотография должна быть PNG, JPEG или WebP.");
    }

    await this.ensureDirectories();

    const [, mimeType, base64Content] = match;
    const photoFileName = `${id}-${Date.now()}.${getExtensionForMimeType(mimeType)}`;

    await writeFile(
      path.join(
        this.photosDirectory,
        photoFileName,
      ),
      Buffer.from(
        base64Content.replace(/\s+/g, ""),
        "base64",
      ),
    );

    return photoFileName;
  }
}
