import path from "node:path";
import {
  access,
  mkdir,
  readdir,
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
import {
  buildPdfFromImages,
  createPdfFromPng,
} from "./certificate-pdf";
import {
  composePrintSheet,
  getBackSlot,
  getFrontSlot,
  MAX_PRINT_SHEET_CARDS,
  type SheetCardPlacement,
} from "./certificate-print-sheet";
import type {
  CertificateLayout,
  CertificatePhotoCrop,
  RenderCertificateInput,
} from "./certificate.types";

export const DEFAULT_CERTIFICATE_TEMPLATE_ID = "volunteer-card-v1-uk";
export const ENGLISH_CERTIFICATE_TEMPLATE_ID = "volunteer-card-v1-en";
export const LEGACY_CERTIFICATE_TEMPLATE_ID = "volunteer-card-v1";

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * Assets a template directory must contain to be considered usable. layout.json
 * is validated separately (it is parsed); background.png is the minimum image
 * the renderer cannot work without.
 */
const REQUIRED_TEMPLATE_ASSETS = [
  "background.png",
] as const;
const LEGACY_TEMPLATE_ALIASES = new Map([
  [
    LEGACY_CERTIFICATE_TEMPLATE_ID,
    DEFAULT_CERTIFICATE_TEMPLATE_ID,
  ],
]);
const DEFAULT_CROP: CertificatePhotoCrop = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};
const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
/**
 * Dimension guardrails. The renderer composes the photo into a 377×519 slot; a
 * degenerate image (e.g. 1×1) passes a format check but then crashes the render
 * pipeline with a raw libvips error. Rejecting it at upload keeps the "a record
 * can always be exported" invariant during mass filling. The upper bound guards
 * against decompression bombs whose byte size is still under MAX_PHOTO_SIZE_BYTES.
 */
const MIN_PHOTO_DIMENSION = 200;
const MAX_PHOTO_DIMENSION = 10000;
// Hard pixel ceiling handed to sharp/libvips so a decompression bomb is refused
// during decode — before the width/height guardrails below can even read the
// metadata — rather than being allowed to allocate memory first. Matches the
// dimension cap (10000×10000 = 100 MP); any legitimate photo stays well under it.
const MAX_PHOTO_PIXELS = MAX_PHOTO_DIMENSION * MAX_PHOTO_DIMENSION;
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
  firstNameEn: string;
  lastNameEn: string;
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
  fullNameEn: string;
  photoUrl: string;
  exportUrls: {
    png: string;
    pdf: string;
  };
}

export interface CertificatePayload {
  fullName?: unknown;
  firstNameEn?: unknown;
  lastNameEn?: unknown;
  certificateNumber?: unknown;
  issuedAt?: unknown;
  validUntil?: unknown;
  templateId?: unknown;
  photoDataUrl?: unknown;
  photoFile?: CertificatePhotoFilePayload;
  photoCrop?: unknown;
}

export interface CertificatePhotoFilePayload {
  content: Buffer;
  fileName?: string;
  contentType?: string;
}

/**
 * Optional server-side filtering/pagination for the certificate list. All
 * fields are optional; an empty query returns every record (unchanged legacy
 * behaviour), so existing clients are unaffected.
 */
export interface CertificateListQuery {
  /** Case-sensitive substring match on full name or certificate number. */
  search?: string;
  /** Max rows to return. Accepts raw query strings; ignored unless a positive integer. */
  limit?: number | string;
  /** Rows to skip; only applied together with `limit`. Accepts raw query strings. */
  offset?: number | string;
}

export interface PrintSheetOptions {
  /** Template used for the front (main-language) cards; defaults per record. */
  frontTemplateId?: string;
  /** Template used for the back (English) cards; auto-resolved when omitted. */
  backTemplateId?: string;
}

export interface CertificateRepositoryOptions {
  storageRoot: string;
  /** Root directory of the multi-template catalogue (one sub-folder per template). */
  templatesDirectory?: string;
  /**
   * Legacy single-template override. When set, the API serves only the default
   * template from this directory and ignores `templatesDirectory`. Kept for
   * backwards compatibility with single-template deployments.
   */
  legacySingleTemplateDirectory?: string;
  defaultTemplateId?: string;
  legacyRegistryPath?: string;
}

export interface CertificateTemplateDefinition {
  id: string;
  name: string;
  locale: string;
  isDefault: boolean;
  layout: CertificateLayout;
}

interface NormalizedCertificatePayload {
  fullName: string;
  firstNameEn: string;
  lastNameEn: string;
  certificateNumber: string;
  issuedAt: string;
  validUntil: string;
  templateId: string;
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

function canonicalizeTemplateId(value: string): string {
  return LEGACY_TEMPLATE_ALIASES.get(value) ?? value;
}

function normalizeTemplateId(
  value: unknown,
  fallback = DEFAULT_CERTIFICATE_TEMPLATE_ID,
): string {
  if (value === undefined || value === null || value === "") {
    return canonicalizeTemplateId(fallback);
  }

  if (typeof value !== "string") {
    throw new Error("Template id must be a string.");
  }

  const templateId = canonicalizeTemplateId(
    normalizeWhitespace(value).toLowerCase(),
  );

  if (!TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new Error("Unsupported certificate template id.");
  }

  return templateId;
}

function compareTemplates(
  first: CertificateTemplateDefinition,
  second: CertificateTemplateDefinition,
): number {
  if (first.isDefault !== second.isDefault) {
    return first.isDefault ? -1 : 1;
  }

  return first.id.localeCompare(second.id);
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

function normalizeOptionalText(
  value: unknown,
  fieldName: string,
  fallback = "",
): string {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName}: значення має бути текстом.`);
  }

  return normalizeWhitespace(value);
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
    metadata = await sharp(content, {
      limitInputPixels: MAX_PHOTO_PIXELS,
    }).metadata();
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

  if (
    metadata.width < MIN_PHOTO_DIMENSION ||
    metadata.height < MIN_PHOTO_DIMENSION
  ) {
    throw new Error(
      `Фотографія замала. Мінімальний розмір — ${MIN_PHOTO_DIMENSION}×${MIN_PHOTO_DIMENSION} пікселів.`,
    );
  }

  if (
    metadata.width > MAX_PHOTO_DIMENSION ||
    metadata.height > MAX_PHOTO_DIMENSION
  ) {
    throw new Error(
      `Фотографія завелика. Максимальний розмір — ${MAX_PHOTO_DIMENSION}×${MAX_PHOTO_DIMENSION} пікселів.`,
    );
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
  fallbackTemplateId = DEFAULT_CERTIFICATE_TEMPLATE_ID,
  fallbackEnglishName: Pick<
    CertificateRecord,
    "firstNameEn" | "lastNameEn"
  > = {
    firstNameEn: "",
    lastNameEn: "",
  },
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
    firstNameEn: normalizeOptionalText(
      payload.firstNameEn,
      "Ім'я англійською",
      fallbackEnglishName.firstNameEn,
    ),
    lastNameEn: normalizeOptionalText(
      payload.lastNameEn,
      "Прізвище англійською",
      fallbackEnglishName.lastNameEn,
    ),
    certificateNumber,
    issuedAt,
    validUntil,
    templateId: normalizeTemplateId(
      payload.templateId,
      fallbackTemplateId,
    ),
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
    firstNameEn: String(row.first_name_en ?? ""),
    lastNameEn: String(row.last_name_en ?? ""),
    certificateNumber: String(row.certificate_number ?? ""),
    issuedAt: String(row.issued_at ?? ""),
    validUntil: String(row.valid_until ?? ""),
    photoFileName: String(row.photo_file_name ?? ""),
    photoCrop: normalizeCrop({
      zoom: row.photo_crop_zoom,
      offsetX: row.photo_crop_offset_x,
      offsetY: row.photo_crop_offset_y,
    }),
    templateId: normalizeTemplateId(row.template_id),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function getCount(row: Record<string, unknown> | undefined): number {
  return Number(row?.total ?? 0);
}

/**
 * Coerces an untrusted list-query bound into a safe positive integer, or
 * `undefined` when it is missing/invalid (so the caller falls back to "no
 * limit"/"no offset").
 */
function toPositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function toCertificateResponse(
  record: CertificateRecord,
): CertificateRecordResponse {
  const encodedId = encodeURIComponent(record.id);
  const encodedPhoto = encodeURIComponent(record.photoFileName);

  return {
    ...record,
    fullNameEn: [record.firstNameEn, record.lastNameEn]
      .filter(Boolean)
      .join(" "),
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

  private readonly templatesDirectory: string;

  private readonly singleTemplateDirectory: string | null;

  private readonly defaultTemplateId: string;

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
    this.templatesDirectory = options.templatesDirectory ??
      path.join(
        options.storageRoot,
        "templates",
      );
    this.singleTemplateDirectory = options.legacySingleTemplateDirectory ?? null;
    this.defaultTemplateId = normalizeTemplateId(options.defaultTemplateId);
  }

  async check(): Promise<void> {
    await this.ensureDirectories();
    await this.getDatabase();

    // The default template is mandatory: fail fast at startup if its layout.json
    // or required assets are missing/invalid, instead of letting the failure
    // surface only on the first render request.
    await this.loadTemplate(this.defaultTemplateId);

    // Validate the rest of the catalogue. Broken non-default templates are
    // logged and skipped by listTemplates (graceful degradation) so one bad
    // localisation (e.g. volunteer-card-v1-en) cannot block the API from
    // starting.
    await this.listTemplates();
  }

  getDefaultTemplateId(): string {
    return this.defaultTemplateId;
  }

  async listTemplates(): Promise<CertificateTemplateDefinition[]> {
    if (this.singleTemplateDirectory) {
      return this.collectTemplates([this.defaultTemplateId]);
    }

    const entries = await readdir(
      this.templatesDirectory,
      {
        withFileTypes: true,
      },
    );
    const templateIds = [
      ...new Set(
        entries
          .filter((entry) =>
            // Directories with names outside the id pattern (e.g. a stray
            // "volunteer-card-v1 ENG" with spaces/uppercase) are ignored here.
            entry.isDirectory() &&
            TEMPLATE_ID_PATTERN.test(entry.name),
          )
          .map((entry) => normalizeTemplateId(entry.name)),
      ),
    ];

    return this.collectTemplates(templateIds);
  }

  /**
   * Loads each template defensively: a single broken template (missing/invalid
   * layout.json or a missing required asset) is logged and excluded rather than
   * failing the whole catalogue. This keeps GET /templates and startup resilient
   * to one corrupted localisation.
   */
  private async collectTemplates(
    templateIds: string[],
  ): Promise<CertificateTemplateDefinition[]> {
    const definitions = await Promise.all(
      templateIds.map(async (templateId) => {
        try {
          return await this.loadTemplate(templateId);
        } catch (error) {
          console.warn(
            `[certificates] Skipping broken template "${templateId}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );

          return null;
        }
      }),
    );

    return definitions
      .filter((definition): definition is CertificateTemplateDefinition =>
        Boolean(definition),
      )
      .sort(compareTemplates);
  }

  async getTemplate(
    templateId = this.defaultTemplateId,
  ): Promise<CertificateTemplateDefinition> {
    return this.readTemplateDefinition(templateId);
  }

  /**
   * Resolves the template used for the English (back) side of a print sheet.
   * An explicit id wins; otherwise the first template whose locale is English
   * is used, falling back to the conventional English template id.
   */
  private async resolveEnglishTemplateId(
    explicitTemplateId?: string,
  ): Promise<string> {
    if (explicitTemplateId) {
      return normalizeTemplateId(explicitTemplateId);
    }

    const templates = await this.listTemplates();
    const englishTemplate = templates.find(
      (template) => template.locale.toLowerCase() === "en",
    );

    return englishTemplate
      ? englishTemplate.id
      : normalizeTemplateId(ENGLISH_CERTIFICATE_TEMPLATE_ID);
  }

  async list(
    query: CertificateListQuery = {},
  ): Promise<CertificateRecordResponse[]> {
    const database = await this.getDatabase();
    const parameters: (string | number)[] = [];
    let whereClause = "";
    const search = typeof query.search === "string" ? query.search.trim() : "";

    if (search) {
      // Escape LIKE wildcards so a literal "%" / "_" in the query is not
      // treated as a pattern. Substring match on name and number.
      const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

      whereClause =
        "WHERE (full_name LIKE ? ESCAPE '\\' OR " +
        "first_name_en LIKE ? ESCAPE '\\' OR " +
        "last_name_en LIKE ? ESCAPE '\\' OR " +
        "certificate_number LIKE ? ESCAPE '\\')";
      parameters.push(pattern, pattern, pattern, pattern);
    }

    let limitClause = "";
    const limit = toPositiveInteger(query.limit);

    if (limit !== undefined) {
      limitClause = " LIMIT ?";
      parameters.push(limit);

      const offset = toPositiveInteger(query.offset);

      if (offset !== undefined) {
        limitClause += " OFFSET ?";
        parameters.push(offset);
      }
    }

    const rows = database.prepare(`
      SELECT *
      FROM certificate_records
      ${whereClause}
      ORDER BY updated_at DESC, id DESC${limitClause}
    `).all(...parameters) as Record<string, unknown>[];

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
    await this.assertTemplateExists(normalizedPayload.templateId);
    const pendingPhoto = await this.savePhotoToTemporary(
      id,
      payload,
    );
    const record: CertificateRecord = {
      id,
      ...normalizedPayload,
      photoFileName: pendingPhoto.photoFileName,
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
      existingRecord.templateId,
      existingRecord,
    );
    await this.assertTemplateExists(normalizedPayload.templateId);
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

  async readTemplateLayout(
    templateId = this.defaultTemplateId,
  ): Promise<CertificateLayout> {
    const definition = await this.readTemplateDefinition(templateId);

    return definition.layout;
  }

  getTemplateAssetPath(
    fileName: string,
    templateId = this.defaultTemplateId,
  ): string {
    return path.join(
      this.getTemplateDirectory(templateId),
      path.basename(fileName),
    );
  }

  getPhotoPath(fileName: string): string {
    return path.join(
      this.photosDirectory,
      path.basename(fileName),
    );
  }

  async renderPng(
    id: string,
    templateId?: string,
  ): Promise<string> {
    const database = await this.getDatabase();
    const record = this.findRecordInDatabase(
      database,
      id,
    );
    const selectedTemplateId = normalizeTemplateId(
      templateId,
      record.templateId,
    );
    const template = await this.getTemplate(selectedTemplateId);
    const outputPath = this.getGeneratedPath(
      record.id,
      selectedTemplateId,
    );
    const nameParts = template.locale.toLowerCase() === "en" &&
        record.firstNameEn && record.lastNameEn
      ? {
        // The English artwork prints the given name on the first line and the
        // surname on the second. RenderCertificateInput keeps legacy field
        // names tied to the Ukrainian surname-first layout, so map explicitly.
        lastName: record.firstNameEn,
        firstName: record.lastNameEn,
        middleName: "",
      }
      : splitFullName(record.fullName);
    const templateDirectory = this.getTemplateDirectory(selectedTemplateId);

    try {
      await renderCertificate({
        templateDirectory,
        outputPath,
        photoPath: this.getPhotoPath(record.photoFileName),
        photoCrop: record.photoCrop,
        ...nameParts,
        certificateNumber: record.certificateNumber,
        issuedAt: record.issuedAt,
        validUntil: record.validUntil,
      });
    } catch (error) {
      // Missing files (ENOENT etc.) carry a `code` and are sanitized upstream
      // into a clean 404/500. Everything else here is a low-level rendering
      // failure (e.g. a raw libvips/libpng message) that must never reach the
      // client verbatim.
      if (error instanceof Error && "code" in error) {
        throw error;
      }

      throw new Error(
        "Не вдалося згенерувати зображення посвідчення. Перевірте фотографію та повторіть спробу.",
      );
    }

    return outputPath;
  }

  async renderPdf(
    id: string,
    templateId?: string,
  ): Promise<Buffer> {
    return createPdfFromPng(
      await this.renderPng(
        id,
        templateId,
      ),
    );
  }

  /**
   * Prepares a duplex-ready A4 print sheet for 1–4 certificates. The front page
   * carries the main-language cards; the back page carries the English versions
   * with each row mirrored horizontally so a card lines up behind its front
   * after a long-edge flip. Returns a two-page PDF sized to A4.
   */
  async renderPrintSheet(
    ids: string[],
    options: PrintSheetOptions = {},
  ): Promise<Buffer> {
    const uniqueIds = [...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => String(id ?? "").trim())
        .filter((id) => id.length > 0),
    )];

    if (uniqueIds.length === 0) {
      throw new Error("Виберіть хоча б одне посвідчення для друку.");
    }

    if (uniqueIds.length > MAX_PRINT_SHEET_CARDS) {
      throw new Error(
        `На один аркуш A4 можна розмістити не більше ${MAX_PRINT_SHEET_CARDS} посвідчень.`,
      );
    }

    const backTemplateId = await this.resolveEnglishTemplateId(
      options.backTemplateId,
    );
    const frontPlacements: SheetCardPlacement[] = [];
    const backPlacements: SheetCardPlacement[] = [];

    for (const [index, id] of uniqueIds.entries()) {
      const frontPngPath = await this.renderPng(
        id,
        options.frontTemplateId,
      );
      const backPngPath = await this.renderPng(
        id,
        backTemplateId,
      );

      frontPlacements.push({
        pngPath: frontPngPath,
        slot: getFrontSlot(index),
      });
      backPlacements.push({
        pngPath: backPngPath,
        slot: getBackSlot(index),
      });
    }

    const [frontPage, backPage] = await Promise.all([
      composePrintSheet(frontPlacements),
      composePrintSheet(backPlacements),
    ]);

    return buildPdfFromImages([
      frontPage,
      backPage,
    ]);
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

  private getTemplateDirectory(
    templateId = this.defaultTemplateId,
  ): string {
    const normalizedTemplateId = normalizeTemplateId(
      templateId,
      this.defaultTemplateId,
    );

    if (this.singleTemplateDirectory) {
      if (normalizedTemplateId !== this.defaultTemplateId) {
        throw new Error(`Certificate template not found: ${normalizedTemplateId}`);
      }

      return this.singleTemplateDirectory;
    }

    return path.join(
      this.templatesDirectory,
      normalizedTemplateId,
    );
  }

  private async readTemplateDefinition(
    templateId = this.defaultTemplateId,
  ): Promise<CertificateTemplateDefinition> {
    const normalizedTemplateId = normalizeTemplateId(
      templateId,
      this.defaultTemplateId,
    );
    const content = await readFile(
      path.join(
        this.getTemplateDirectory(normalizedTemplateId),
        "layout.json",
      ),
      "utf8",
    );
    const sourceLayout = JSON.parse(
      content.replace(/^\uFEFF/, ""),
    ) as CertificateLayout;
    const name = typeof sourceLayout.name === "string" && sourceLayout.name.trim()
      ? normalizeWhitespace(sourceLayout.name)
      : normalizedTemplateId;
    const locale = typeof sourceLayout.locale === "string" && sourceLayout.locale.trim()
      ? normalizeWhitespace(sourceLayout.locale)
      : "";
    const layout: CertificateLayout = {
      ...sourceLayout,
      id: normalizedTemplateId,
      name,
      locale,
    };

    return {
      id: normalizedTemplateId,
      name,
      locale,
      isDefault: normalizedTemplateId === this.defaultTemplateId,
      layout,
    };
  }

  /**
   * Reads and fully validates a template: its layout.json must exist and parse,
   * and every required asset (background.png) must be present. Throws if the
   * template is unusable.
   */
  private async loadTemplate(
    templateId = this.defaultTemplateId,
  ): Promise<CertificateTemplateDefinition> {
    const definition = await this.readTemplateDefinition(templateId);

    await this.assertRequiredTemplateAssets(definition.id);

    return definition;
  }

  private async assertRequiredTemplateAssets(
    templateId: string,
  ): Promise<void> {
    for (const asset of REQUIRED_TEMPLATE_ASSETS) {
      try {
        await access(this.getTemplateAssetPath(asset, templateId));
      } catch {
        // Keep the message path-free: it may reach API responses/logs.
        throw new Error(
          `Template "${templateId}" is missing required asset: ${asset}`,
        );
      }
    }
  }

  private async assertTemplateExists(templateId: string): Promise<void> {
    try {
      await this.readTemplateDefinition(templateId);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new Error(`Certificate template not found: ${templateId}`);
      }

      throw error;
    }
  }

  private migrateDatabase(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS certificate_records (
        id TEXT PRIMARY KEY NOT NULL,
        full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
        first_name_en TEXT NOT NULL DEFAULT '',
        last_name_en TEXT NOT NULL DEFAULT '',
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

    `);

    const columns = new Set(
      (database.prepare("PRAGMA table_info(certificate_records)").all() as
        Record<string, unknown>[])
        .map((column) => String(column.name ?? "")),
    );

    if (!columns.has("first_name_en")) {
      database.exec(
        "ALTER TABLE certificate_records " +
        "ADD COLUMN first_name_en TEXT NOT NULL DEFAULT ''",
      );
    }

    if (!columns.has("last_name_en")) {
      database.exec(
        "ALTER TABLE certificate_records " +
        "ADD COLUMN last_name_en TEXT NOT NULL DEFAULT ''",
      );
    }

    database.exec("PRAGMA user_version = 2");
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
      firstNameEn: normalizeOptionalText(
        source.firstNameEn,
        "Ім'я англійською",
      ),
      lastNameEn: normalizeOptionalText(
        source.lastNameEn,
        "Прізвище англійською",
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
      templateId: normalizeTemplateId(source.templateId),
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
        first_name_en,
        last_name_en,
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.fullName,
      record.firstNameEn,
      record.lastNameEn,
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
        first_name_en = ?,
        last_name_en = ?,
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
      record.firstNameEn,
      record.lastNameEn,
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

  private getGeneratedPath(
    id: string,
    templateId?: string,
  ): string {
    const suffix = templateId
      ? `-${normalizeTemplateId(templateId)}`
      : "";

    return path.join(
      this.generatedDirectory,
      `${id}${suffix}.png`,
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
