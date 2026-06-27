import path from "node:path";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

import {
  openSqliteDatabase,
  runInTransaction,
} from "../../db/sqlite";

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
const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_PHOTO_FORMATS = new Set([
  "jpeg",
  "png",
  "webp",
]);

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
  photoFile?: CertificatePhotoFilePayload;
  photoCrop?: unknown;
}

export interface CertificatePhotoFilePayload {
  content: Buffer;
  fileName?: string;
  contentType?: string;
}

export interface CertificateRepositoryOptions {
  storageRoot: string;
  templateDirectory: string;
  legacyRegistryPath?: string;
}

interface NormalizedCertificatePayload {
  fullName: string;
  certificateNumber: string;
  issuedAt: string;
  validUntil: string;
  photoCrop: CertificatePhotoCrop;
}

interface PendingPhotoFile {
  temporaryPath: string;
  finalPath: string;
  photoFileName: string;
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

function assertDateRange(
  issuedAt: string,
  validUntil: string,
): void {
  if (validUntil < issuedAt) {
    throw new Error("Дата завершения действия должна быть не раньше даты выдачи.");
  }
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
  value: unknown,
  fallback: CertificatePhotoCrop = DEFAULT_CROP,
): CertificatePhotoCrop {
  let source = value;

  if (typeof source === "string" && source.trim()) {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      source = undefined;
    }
  }

  const crop =
    source && typeof source === "object"
      ? source as Partial<CertificatePhotoCrop>
      : {};
  const zoom = Number(crop.zoom ?? fallback.zoom);
  const offsetX = Number(crop.offsetX ?? fallback.offsetX);
  const offsetY = Number(crop.offsetY ?? fallback.offsetY);

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

function getExtensionForImageFormat(format: string): string {
  if (format === "jpeg") {
    return "jpg";
  }

  if (format === "webp") {
    return "webp";
  }

  return "png";
}

async function validatePhotoBuffer(
  content: Buffer,
): Promise<{
  content: Buffer;
  extension: string;
}> {
  if (content.length === 0) {
    throw new Error("Файл фотографії порожній.");
  }

  if (content.length > MAX_PHOTO_SIZE_BYTES) {
    throw new Error("Розмір фотографії не повинен перевищувати 10 МБ.");
  }

  let metadata: sharp.Metadata;

  try {
    metadata = await sharp(content).metadata();
  } catch {
    throw new Error("Не вдалося прочитати фотографію. Завантажте справний файл PNG, JPEG або WebP.");
  }

  if (
    !metadata.format ||
    !SUPPORTED_PHOTO_FORMATS.has(metadata.format) ||
    !metadata.width ||
    !metadata.height
  ) {
    throw new Error("Фотографія має бути справним файлом PNG, JPEG або WebP.");
  }

  return {
    content,
    extension: getExtensionForImageFormat(metadata.format),
  };
}

async function parsePhotoDataUrl(
  dataUrl: unknown,
): Promise<{
  content: Buffer;
  extension: string;
}> {
  if (typeof dataUrl !== "string") {
    throw new Error("Фотографія обов'язкова.");
  }

  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);

  if (!match) {
    throw new Error("Фотографія має бути PNG, JPEG або WebP.");
  }

  const [, , base64Content] = match;

  return validatePhotoBuffer(
    Buffer.from(
      base64Content.replace(/\s+/g, ""),
      "base64",
    ),
  );
}

async function parsePhotoPayload(
  payload: CertificatePayload,
): Promise<{
  content: Buffer;
  extension: string;
}> {
  if (payload.photoFile) {
    return validatePhotoBuffer(payload.photoFile.content);
  }

  return parsePhotoDataUrl(payload.photoDataUrl);
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

function normalizeCertificatePayload(
  payload: CertificatePayload,
  fallbackCrop: CertificatePhotoCrop = DEFAULT_CROP,
): NormalizedCertificatePayload {
  const fullName = normalizeRequiredText(
    payload.fullName,
    "ПІБ",
  );
  const certificateNumber = normalizeRequiredText(
    payload.certificateNumber,
    "Номер посвідчення",
  );
  const issuedAt = normalizeDate(payload.issuedAt);
  const validUntil = normalizeDate(payload.validUntil);

  assertDateRange(
    issuedAt,
    validUntil,
  );

  return {
    fullName,
    certificateNumber,
    issuedAt,
    validUntil,
    photoCrop: normalizeCrop(
      payload.photoCrop,
      fallbackCrop,
    ),
  };
}

function isSqliteConstraintError(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === "ERR_SQLITE_ERROR" &&
    error.message.includes("constraint");
}

function toRepositoryError(error: unknown): Error {
  if (error instanceof Error) {
    if (error.message.includes("certificate_records.certificate_number")) {
      return new Error("Номер посвідчення вже існує.");
    }

    if (isSqliteConstraintError(error)) {
      return new Error("Дані посвідчення не пройшли перевірку обмежень.");
    }

    return error;
  }

  return new Error("Помилка обробки посвідчення.");
}

function rowToRecord(row: Record<string, unknown>): CertificateRecord {
  return {
    id: String(row.id ?? ""),
    fullName: String(row.full_name ?? ""),
    certificateNumber: String(row.certificate_number ?? ""),
    issuedAt: String(row.issued_at ?? ""),
    validUntil: String(row.valid_until ?? ""),
    photoFileName: String(row.photo_file_name ?? ""),
    photoCrop: normalizeCrop({
      zoom: row.photo_crop_zoom,
      offsetX: row.photo_crop_offset_x,
      offsetY: row.photo_crop_offset_y,
    }),
    templateId: String(row.template_id ?? TEMPLATE_ID),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function getCount(row: Record<string, unknown> | undefined): number {
  return Number(row?.total ?? 0);
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
  private readonly databasePath: string;

  private readonly legacyRegistryPath: string;

  private readonly photosDirectory: string;

  private readonly generatedDirectory: string;

  private readonly templateDirectory: string;

  private database: DatabaseSync | null = null;

  constructor(options: CertificateRepositoryOptions) {
    this.databasePath = path.join(
      options.storageRoot,
      "certificates.sqlite",
    );
    this.legacyRegistryPath = options.legacyRegistryPath ??
      path.join(
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
    await this.getDatabase();
    await this.readTemplateLayout();
  }

  async list(): Promise<CertificateRecordResponse[]> {
    const database = await this.getDatabase();
    const rows = database.prepare(`
      SELECT *
      FROM certificate_records
      ORDER BY updated_at DESC, id DESC
    `).all() as Record<string, unknown>[];

    return rows
      .map(rowToRecord)
      .map(toCertificateResponse);
  }

  async get(id: string): Promise<CertificateRecordResponse> {
    const database = await this.getDatabase();

    return toCertificateResponse(
      this.findRecordInDatabase(
        database,
        id,
      ),
    );
  }

  async create(
    payload: CertificatePayload,
  ): Promise<CertificateRecordResponse> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const normalizedPayload = normalizeCertificatePayload(payload);
    const pendingPhoto = await this.savePhotoToTemporary(
      id,
      payload,
    );
    const record: CertificateRecord = {
      id,
      ...normalizedPayload,
      photoFileName: pendingPhoto.photoFileName,
      templateId: TEMPLATE_ID,
      createdAt: now,
      updatedAt: now,
    };
    const database = await this.getDatabase();

    try {
      await runInTransaction(
        database,
        async () => {
          await rename(
            pendingPhoto.temporaryPath,
            pendingPhoto.finalPath,
          );
          this.insertRecord(
            database,
            record,
          );
        },
      );
    } catch (error) {
      await this.cleanupFiles([
        pendingPhoto.temporaryPath,
        pendingPhoto.finalPath,
      ]);
      throw toRepositoryError(error);
    }

    return toCertificateResponse(record);
  }

  async update(
    id: string,
    payload: CertificatePayload,
  ): Promise<CertificateRecordResponse> {
    const database = await this.getDatabase();
    const existingRecord = this.findRecordInDatabase(
      database,
      id,
    );
    const normalizedPayload = normalizeCertificatePayload(
      payload,
      existingRecord.photoCrop,
    );
    const shouldReplacePhoto =
      Boolean(payload.photoFile) ||
      (typeof payload.photoDataUrl === "string" && Boolean(payload.photoDataUrl));
    const pendingPhoto = shouldReplacePhoto
      ? await this.savePhotoToTemporary(
        id,
        payload,
      )
      : null;
    const updatedRecord: CertificateRecord = {
      ...existingRecord,
      ...normalizedPayload,
      photoFileName: pendingPhoto?.photoFileName ?? existingRecord.photoFileName,
      updatedAt: new Date().toISOString(),
    };

    try {
      await runInTransaction(
        database,
        async () => {
          if (pendingPhoto) {
            await rename(
              pendingPhoto.temporaryPath,
              pendingPhoto.finalPath,
            );
          }

          this.updateRecord(
            database,
            updatedRecord,
          );
        },
      );
    } catch (error) {
      if (pendingPhoto) {
        await this.cleanupFiles([
          pendingPhoto.temporaryPath,
          pendingPhoto.finalPath,
        ]);
      }
      throw toRepositoryError(error);
    }

    if (
      pendingPhoto &&
      existingRecord.photoFileName !== updatedRecord.photoFileName
    ) {
      await this.cleanupFiles([
        this.getPhotoPath(existingRecord.photoFileName),
        this.getGeneratedPath(existingRecord.id),
      ]);
    }

    return toCertificateResponse(updatedRecord);
  }

  async renew(id: string): Promise<CertificateRecordResponse> {
    const database = await this.getDatabase();
    const updatedRecord = await runInTransaction(
      database,
      async () => {
        const record = this.findRecordInDatabase(
          database,
          id,
        );
        const updated: CertificateRecord = {
          ...record,
          validUntil: addOneYear(record.validUntil),
          updatedAt: new Date().toISOString(),
        };

        this.updateRecord(
          database,
          updated,
        );

        return updated;
      },
    );

    return toCertificateResponse(updatedRecord);
  }

  async remove(id: string): Promise<void> {
    const database = await this.getDatabase();
    const removedRecord = await runInTransaction(
      database,
      async () => {
        const record = this.findRecordInDatabase(
          database,
          id,
        );
        database.prepare(`
          DELETE FROM certificate_records
          WHERE id = ?
        `).run(id);

        return record;
      },
    );

    if (removedRecord) {
      await this.cleanupFiles([
        this.getPhotoPath(removedRecord.photoFileName),
        this.getGeneratedPath(removedRecord.id),
      ]);
    }
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
    const database = await this.getDatabase();
    const record = this.findRecordInDatabase(
      database,
      id,
    );
    const outputPath = this.getGeneratedPath(record.id);
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
        path.dirname(this.databasePath),
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

  private async getDatabase(): Promise<DatabaseSync> {
    if (this.database) {
      return this.database;
    }

    await this.ensureDirectories();

    this.database = await openSqliteDatabase({
      storageRoot: path.dirname(this.databasePath),
      databasePath: this.databasePath,
      migrate: (database) => {
        this.migrateDatabase(database);
      },
    });
    await this.migrateLegacyRegistry(this.database);

    return this.database;
  }

  private migrateDatabase(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS certificate_records (
        id TEXT PRIMARY KEY NOT NULL,
        full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
        certificate_number TEXT NOT NULL COLLATE NOCASE UNIQUE
          CHECK (length(trim(certificate_number)) > 0),
        issued_at TEXT NOT NULL
          CHECK (issued_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        valid_until TEXT NOT NULL
          CHECK (
            valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
            valid_until >= issued_at
          ),
        photo_file_name TEXT NOT NULL CHECK (length(trim(photo_file_name)) > 0),
        photo_crop_zoom REAL NOT NULL DEFAULT 1
          CHECK (photo_crop_zoom >= 1 AND photo_crop_zoom <= 3),
        photo_crop_offset_x REAL NOT NULL DEFAULT 0,
        photo_crop_offset_y REAL NOT NULL DEFAULT 0,
        template_id TEXT NOT NULL CHECK (length(trim(template_id)) > 0),
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
      );

      CREATE INDEX IF NOT EXISTS idx_certificate_records_updated_at
        ON certificate_records(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_certificate_records_valid_until
        ON certificate_records(valid_until);

      PRAGMA user_version = 1;
    `);
  }

  private async migrateLegacyRegistry(database: DatabaseSync): Promise<void> {
    const existingCount = getCount(
      database.prepare(`
        SELECT COUNT(*) AS total
        FROM certificate_records
      `).get() as Record<string, unknown> | undefined,
    );

    if (existingCount > 0) {
      return;
    }

    const legacyRecords = await this.readLegacyRegistry();

    if (legacyRecords.length === 0) {
      return;
    }

    await runInTransaction(
      database,
      async () => {
        for (const record of legacyRecords) {
          this.insertRecord(
            database,
            record,
          );
        }
      },
    );
  }

  private async readLegacyRegistry(): Promise<CertificateRecord[]> {
    try {
      const content = await readFile(
        this.legacyRegistryPath,
        "utf8",
      );
      const parsedValue = JSON.parse(
        content.replace(/^\uFEFF/, ""),
      );

      if (!Array.isArray(parsedValue)) {
        return [];
      }

      return parsedValue.map((record) =>
        this.normalizeLegacyRecord(record),
      );
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

  private normalizeLegacyRecord(record: unknown): CertificateRecord {
    if (!record || typeof record !== "object") {
      throw new Error("Некоректний запис у legacy registry.json.");
    }

    const source = record as Record<string, unknown>;
    const issuedAt = normalizeDate(source.issuedAt);
    const validUntil = normalizeDate(source.validUntil);

    assertDateRange(
      issuedAt,
      validUntil,
    );

    return {
      id: normalizeRequiredText(
        source.id,
        "ID",
      ),
      fullName: normalizeRequiredText(
        source.fullName,
        "ПІБ",
      ),
      certificateNumber: normalizeRequiredText(
        source.certificateNumber,
        "Номер посвідчення",
      ),
      issuedAt,
      validUntil,
      photoFileName: normalizeRequiredText(
        source.photoFileName,
        "Файл фотографії",
      ),
      photoCrop: normalizeCrop(source.photoCrop),
      templateId: typeof source.templateId === "string" && source.templateId.trim()
        ? normalizeWhitespace(source.templateId)
        : TEMPLATE_ID,
      createdAt: typeof source.createdAt === "string" && source.createdAt.trim()
        ? source.createdAt
        : new Date().toISOString(),
      updatedAt: typeof source.updatedAt === "string" && source.updatedAt.trim()
        ? source.updatedAt
        : new Date().toISOString(),
    };
  }

  private insertRecord(
    database: DatabaseSync,
    record: CertificateRecord,
  ): void {
    database.prepare(`
      INSERT INTO certificate_records (
        id,
        full_name,
        certificate_number,
        issued_at,
        valid_until,
        photo_file_name,
        photo_crop_zoom,
        photo_crop_offset_x,
        photo_crop_offset_y,
        template_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.fullName,
      record.certificateNumber,
      record.issuedAt,
      record.validUntil,
      record.photoFileName,
      record.photoCrop.zoom,
      record.photoCrop.offsetX,
      record.photoCrop.offsetY,
      record.templateId,
      record.createdAt,
      record.updatedAt,
    );
  }

  private updateRecord(
    database: DatabaseSync,
    record: CertificateRecord,
  ): void {
    database.prepare(`
      UPDATE certificate_records
      SET
        full_name = ?,
        certificate_number = ?,
        issued_at = ?,
        valid_until = ?,
        photo_file_name = ?,
        photo_crop_zoom = ?,
        photo_crop_offset_x = ?,
        photo_crop_offset_y = ?,
        template_id = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      record.fullName,
      record.certificateNumber,
      record.issuedAt,
      record.validUntil,
      record.photoFileName,
      record.photoCrop.zoom,
      record.photoCrop.offsetX,
      record.photoCrop.offsetY,
      record.templateId,
      record.updatedAt,
      record.id,
    );
  }

  private findRecordInDatabase(
    database: DatabaseSync,
    id: string,
  ): CertificateRecord {
    const row = database.prepare(`
      SELECT *
      FROM certificate_records
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error("Удостоверение не найдено.");
    }

    return rowToRecord(row);
  }

  private async removeFileIfExists(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }

      throw error;
    }
  }

  private getGeneratedPath(id: string): string {
    return path.join(
      this.generatedDirectory,
      `${id}.png`,
    );
  }

  private async savePhotoToTemporary(
    id: string,
    payload: CertificatePayload,
  ): Promise<PendingPhotoFile> {
    await this.ensureDirectories();

    const { content, extension } = await parsePhotoPayload(payload);
    const photoFileName = `${id}-${Date.now()}.${extension}`;
    const temporaryPath = path.join(
      this.photosDirectory,
      `${photoFileName}.${randomUUID()}.tmp`,
    );
    const finalPath = path.join(
      this.photosDirectory,
      photoFileName,
    );

    await writeFile(
      temporaryPath,
      content,
      {
        flag: "wx",
      },
    );

    return {
      temporaryPath,
      finalPath,
      photoFileName,
    };
  }

  private async cleanupFiles(filePaths: string[]): Promise<void> {
    await Promise.all(
      filePaths.map(async (filePath) => {
        try {
          await this.removeFileIfExists(filePath);
        } catch {
          // Cleanup must not hide the database operation result.
        }
      }),
    );
  }
}
