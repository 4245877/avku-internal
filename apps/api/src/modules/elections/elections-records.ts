import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  openSqliteDatabase,
  resolveDatabasePath,
  runInTransaction,
} from "../../db/sqlite";
import { HttpError } from "../../http/responses";
import { migrateElectionsDatabase } from "./elections-schema";
import {
  ATTACHMENT_ACCESS_LEVELS,
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  badRequest,
  optionalOneOf,
  optionalText,
} from "./elections.types";

/**
 * The one connection every "Вибори" table shares.
 *
 * Foreign keys only work inside a single SQLite file, and this module is all
 * about the relations — a house to its campaign state, a task to its issue, an
 * import batch to the rows it created. So unlike `warehouse` or `certificates`,
 * which each own one table group, this repository owns the whole domain
 * database and the per-entity modules are functions over its connection.
 *
 * Writes go through {@link withTransaction}, which serialises them on the
 * shared connection (see `db/sqlite.ts`) — a composite operation such as
 * "create the person, their phone and the link to the house" either lands
 * whole or not at all.
 */

export interface ElectionsRepositoryOptions {
  storageRoot: string;
}

/** Attachments are capped well below the 30 MB request limit. */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/**
 * What a field worker can usefully attach: a photo of an entrance or a notice
 * board, or a scanned document. Executables, archives and office macros are
 * refused — this is a canvassing tool, not a file share.
 */
const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

export class ElectionsRepository {
  private readonly storageRoot: string;

  private readonly databasePath: string;

  private readonly attachmentsDirectory: string;

  private database: DatabaseSync | null = null;

  constructor(options: ElectionsRepositoryOptions) {
    this.storageRoot = options.storageRoot;
    this.databasePath = resolveDatabasePath(
      options.storageRoot,
      "elections.sqlite",
    );
    this.attachmentsDirectory = path.join(
      options.storageRoot,
      "attachments",
    );
  }

  async check(): Promise<void> {
    await this.getDatabase();
  }

  async getDatabase(): Promise<DatabaseSync> {
    if (this.database) {
      return this.database;
    }

    this.database = await openSqliteDatabase({
      storageRoot: this.storageRoot,
      databasePath: this.databasePath,
      migrate: (database) => {
        migrateElectionsDatabase(database);
      },
    });

    return this.database;
  }

  /** Runs `operation` inside one transaction on the shared connection. */
  async withTransaction<T>(
    operation: (database: DatabaseSync) => Promise<T> | T,
  ): Promise<T> {
    const database = await this.getDatabase();

    return runInTransaction(
      database,
      async () => operation(database),
    );
  }

  /* ---------------------------------------------------------------- *
   * Attachment files
   * ---------------------------------------------------------------- */

  /**
   * Writes an uploaded file and returns the generated storage name.
   *
   * The stored name is a fresh UUID plus an extension derived from the
   * *content type we allow*, never from the uploaded file name — so a name like
   * `../../etc/passwd` or `photo.jpg.sh` cannot influence the path or the
   * extension. The write is atomic (temp file, then rename), matching how the
   * workspace-area repository persists the boundary.
   */
  async saveAttachmentFile(input: {
    content: Buffer;
    contentType: string;
  }): Promise<{ storedName: string; contentType: string }> {
    const contentType = input.contentType.split(";")[0].trim().toLowerCase();
    const extension = ALLOWED_ATTACHMENT_TYPES[contentType];

    if (!extension) {
      throw new HttpError(
        415,
        "Дозволені лише зображення (JPEG, PNG, WebP, HEIC), PDF та текстові файли.",
      );
    }

    if (input.content.length === 0) {
      throw new HttpError(
        400,
        "Файл порожній.",
      );
    }

    if (input.content.length > MAX_ATTACHMENT_BYTES) {
      throw new HttpError(
        413,
        `Файл завеликий (максимум ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} МБ).`,
      );
    }

    await mkdir(
      this.attachmentsDirectory,
      {
        recursive: true,
      },
    );

    const storedName = `${randomUUID()}${extension}`;
    const finalPath = path.join(
      this.attachmentsDirectory,
      storedName,
    );
    const temporaryPath = `${finalPath}.tmp`;

    await writeFile(
      temporaryPath,
      input.content,
    );

    try {
      await rename(
        temporaryPath,
        finalPath,
      );
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return {
      storedName,
      contentType,
    };
  }

  /**
   * Absolute path of a stored attachment.
   *
   * `storedName` comes from the database, but it is re-validated against the
   * generated shape and the resolved path is re-checked to be inside the
   * attachments directory. A hand-edited database row is still not a way out of
   * the storage root.
   */
  resolveAttachmentPath(storedName: string): string {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i.test(storedName)) {
      throw new HttpError(
        400,
        "Некоректне імʼя файлу вкладення.",
      );
    }

    const resolved = path.resolve(
      this.attachmentsDirectory,
      storedName,
    );
    const root = path.resolve(this.attachmentsDirectory);

    if (resolved !== path.join(
      root,
      path.basename(resolved),
    )) {
      throw new HttpError(
        400,
        "Некоректний шлях до вкладення.",
      );
    }

    return resolved;
  }

  async removeAttachmentFile(storedName: string): Promise<void> {
    await unlink(this.resolveAttachmentPath(storedName)).catch(() => undefined);
  }
}

export interface AttachmentUploadFields {
  ownerType?: unknown;
  ownerId?: unknown;
  houseId?: unknown;
  kind?: unknown;
  accessLevel?: unknown;
  note?: unknown;
  fileName?: unknown;
}

/**
 * Validates the metadata that comes alongside an uploaded file.
 *
 * The display file name is sanitised to a plain base name here as well — it is
 * never used to build a path, but it is rendered in the UI, and a name carrying
 * directory separators is a bug report waiting to happen.
 */
export function readAttachmentFields(
  fields: AttachmentUploadFields,
): {
  ownerType: string;
  ownerId: string;
  houseId: string | null;
  kind: string;
  accessLevel: string;
  note: string;
  fileName: string;
} {
  const ownerType = optionalOneOf(
    fields.ownerType,
    ATTACHMENT_OWNER_TYPES,
    "ownerType",
    "house",
  );
  const ownerId = optionalText(
    fields.ownerId,
    "ownerId",
    200,
  );

  if (!ownerId) {
    badRequest("Поле «ownerId» обовʼязкове.");
  }

  const rawName = optionalText(
    fields.fileName,
    "fileName",
    300,
  ) || "file";

  return {
    ownerType,
    ownerId,
    houseId: optionalText(
      fields.houseId,
      "houseId",
      200,
    ) || null,
    kind: optionalOneOf(
      fields.kind,
      ATTACHMENT_KINDS,
      "kind",
      "photo",
    ),
    accessLevel: optionalOneOf(
      fields.accessLevel,
      ATTACHMENT_ACCESS_LEVELS,
      "accessLevel",
      "team",
    ),
    note: optionalText(
      fields.note,
      "note",
      500,
    ),
    fileName: path.basename(rawName).replace(
      /[\\/]/g,
      "_",
    ).slice(
      0,
      200,
    ),
  };
}
