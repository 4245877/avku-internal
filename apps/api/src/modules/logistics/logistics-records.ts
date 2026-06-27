import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  getNumber,
  openSqliteDatabase,
  resolveDatabasePath,
  runInTransaction,
} from "../../db/sqlite";
import type {
  DocumentState,
  LogisticsEvent,
  LogisticsEventType,
  ManifestLine,
  Transfer,
  TransferEventPayload,
  TransferPayload,
  TransferResponse,
  TransferStatus,
} from "./logistics.types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PHOTO_COUNT = 1000;
const MAX_MANIFEST_LINES = 60;
const TRANSFER_STATUSES = new Set<TransferStatus>([
  "planned",
  "transferred",
  "report",
]);
const DOCUMENT_STATES = new Set<DocumentState>([
  "missing",
  "pending",
  "ready",
]);
const EVENT_TYPES = new Set<LogisticsEventType>([
  "created",
  "status",
  "act",
  "photo",
  "note",
]);
const STATUS_LABELS: Record<TransferStatus, string> = {
  planned: "Заплановано",
  transferred: "Передано",
  report: "Потрібно дозавантажити звіт",
};
const ACT_LABELS: Record<DocumentState, string> = {
  missing: "Акт не створено",
  pending: "Акт підготовлено",
  ready: "Акт підписано",
};

export interface LogisticsRepositoryOptions {
  storageRoot: string;
}

interface NormalizedTransferPayload {
  route: string;
  recipient: string;
  driver: string;
  transferDate: string;
  status: TransferStatus;
  routeConfirmed: boolean;
  actState: DocumentState;
  actReference: string;
  photoState: DocumentState;
  photoCount: number;
  requestId: string;
  warehouseId: string;
  reportId: string;
  notes: string;
  manifest: ManifestLine[];
}

function normalizeWhitespace(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeRequiredText(
  value: unknown,
  fieldName: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName}: обов'язкове поле.`);
  }

  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    throw new Error(`${fieldName}: обов'язкове поле.`);
  }

  return normalizedValue;
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === "string"
    ? normalizeWhitespace(value)
    : "";
}

function normalizeMultilineText(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/[ \t]+/g, " ")
    : "";
}

function normalizeCount(
  value: unknown,
  fieldName: string,
  maxValue: number,
): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : 0;

  if (
    !Number.isFinite(numericValue) ||
    !Number.isInteger(numericValue) ||
    numericValue < 0
  ) {
    throw new Error(`${fieldName}: вкажіть ціле число від 0.`);
  }

  if (numericValue > maxValue) {
    throw new Error(`${fieldName}: значення завелике.`);
  }

  return numericValue;
}

function normalizeDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return new Date().toISOString().slice(0, 10);
  }

  if (!DATE_PATTERN.test(value)) {
    throw new Error("Дата має бути у форматі YYYY-MM-DD.");
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Некоректна дата.");
  }

  return value;
}

function normalizeRequiredDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Дата передачі: обов'язкове поле.");
  }

  return normalizeDate(value);
}

function normalizeStatus(value: unknown): TransferStatus {
  if (
    typeof value === "string" &&
    TRANSFER_STATUSES.has(value as TransferStatus)
  ) {
    return value as TransferStatus;
  }

  return "planned";
}

function normalizeDocumentState(value: unknown): DocumentState {
  if (
    typeof value === "string" &&
    DOCUMENT_STATES.has(value as DocumentState)
  ) {
    return value as DocumentState;
  }

  return "missing";
}

function normalizeEventType(value: unknown): LogisticsEventType {
  if (
    typeof value === "string" &&
    EVENT_TYPES.has(value as LogisticsEventType)
  ) {
    return value as LogisticsEventType;
  }

  return "note";
}

function normalizeManifest(value: unknown): ManifestLine[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("Склад передачі має бути списком позицій.");
  }

  const manifest: ManifestLine[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const name = normalizeOptionalText(record.name);
    const quantity = normalizeOptionalText(record.quantity);

    if (!name && !quantity) {
      continue;
    }

    if (!name) {
      throw new Error("Вкажіть назву для кожної позиції передачі.");
    }

    manifest.push({
      name,
      quantity,
    });

    if (manifest.length > MAX_MANIFEST_LINES) {
      throw new Error("Забагато позицій у складі передачі.");
    }
  }

  return manifest;
}

function normalizeTransferPayload(
  payload: TransferPayload,
): NormalizedTransferPayload {
  const actState = normalizeDocumentState(payload.actState);
  const photoState = normalizeDocumentState(payload.photoState);

  return {
    route: normalizeRequiredText(payload.route, "Маршрут"),
    recipient: normalizeRequiredText(payload.recipient, "Отримувач"),
    driver: normalizeRequiredText(payload.driver, "Водій або волонтер"),
    transferDate: normalizeRequiredDate(payload.transferDate),
    status: normalizeStatus(payload.status),
    routeConfirmed: Boolean(payload.routeConfirmed),
    actState,
    actReference: normalizeOptionalText(payload.actReference),
    photoState,
    photoCount: normalizeCount(
      payload.photoCount,
      "Кількість фото",
      MAX_PHOTO_COUNT,
    ),
    requestId: normalizeOptionalText(payload.requestId),
    warehouseId: normalizeOptionalText(payload.warehouseId),
    reportId: normalizeOptionalText(payload.reportId),
    notes: normalizeMultilineText(payload.notes),
    manifest: normalizeManifest(payload.manifest),
  };
}

function getActLabel(state: DocumentState, reference: string): string {
  if (state === "ready") {
    return reference || ACT_LABELS.ready;
  }

  return ACT_LABELS[state];
}

function getPhotoLabel(state: DocumentState, count: number): string {
  if (state === "ready") {
    return count > 0 ? `${count} фото завантажено` : "Фото завантажено";
  }

  if (state === "pending") {
    return "Очікується після передачі";
  }

  return "Фото немає";
}

function parseManifest(value: unknown): ManifestLine[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object",
      )
      .map((entry) => ({
        name: String(entry.name ?? ""),
        quantity: String(entry.quantity ?? ""),
      }));
  } catch {
    return [];
  }
}

function rowToTransfer(row: Record<string, unknown>): Transfer {
  return {
    id: String(row.id ?? ""),
    code: String(row.code ?? ""),
    route: String(row.route ?? ""),
    recipient: String(row.recipient ?? ""),
    driver: String(row.driver ?? ""),
    transferDate: String(row.transfer_date ?? ""),
    status: normalizeStatus(row.status),
    routeConfirmed: Number(row.route_confirmed ?? 0) === 1,
    actState: normalizeDocumentState(row.act_state),
    actReference: String(row.act_reference ?? ""),
    photoState: normalizeDocumentState(row.photo_state),
    photoCount: Number(row.photo_count ?? 0),
    requestId: String(row.request_id ?? ""),
    warehouseId: String(row.warehouse_id ?? ""),
    reportId: String(row.report_id ?? ""),
    notes: String(row.notes ?? ""),
    manifest: parseManifest(row.manifest),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function rowToEvent(row: Record<string, unknown>): LogisticsEvent {
  return {
    id: String(row.id ?? ""),
    transferId: String(row.transfer_id ?? ""),
    type: normalizeEventType(row.type),
    date: String(row.date ?? ""),
    title: String(row.title ?? ""),
    meta: String(row.meta ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function toRepositoryError(error: unknown): Error {
  if (error instanceof Error) {
    if (
      "code" in error &&
      error.code === "ERR_SQLITE_ERROR" &&
      error.message.includes("logistics_transfers.code")
    ) {
      return new Error("Код передачі вже існує. Спробуйте ще раз.");
    }

    return error;
  }

  return new Error("Помилка обробки передачі.");
}

export class LogisticsRepository {
  private readonly databasePath: string;

  private readonly storageRoot: string;

  private database: DatabaseSync | null = null;

  constructor(options: LogisticsRepositoryOptions) {
    this.storageRoot = options.storageRoot;
    this.databasePath = resolveDatabasePath(
      options.storageRoot,
      "logistics.sqlite",
    );
  }

  async check(): Promise<void> {
    await this.getDatabase();
  }

  async list(): Promise<TransferResponse[]> {
    const database = await this.getDatabase();
    const transferRows = database.prepare(`
      SELECT *
      FROM logistics_transfers
      ORDER BY transfer_date DESC, updated_at DESC
    `).all() as Record<string, unknown>[];
    const eventRows = database.prepare(`
      SELECT *
      FROM logistics_events
      ORDER BY date ASC, created_at ASC
    `).all() as Record<string, unknown>[];
    const eventsByTransfer = new Map<string, LogisticsEvent[]>();

    for (const row of eventRows) {
      const event = rowToEvent(row);
      const bucket = eventsByTransfer.get(event.transferId) ?? [];

      bucket.push(event);
      eventsByTransfer.set(event.transferId, bucket);
    }

    return transferRows.map((row) => {
      const transfer = rowToTransfer(row);

      return {
        ...transfer,
        events: eventsByTransfer.get(transfer.id) ?? [],
      };
    });
  }

  async get(id: string): Promise<TransferResponse> {
    const database = await this.getDatabase();
    const transfer = this.findTransfer(database, id);

    return {
      ...transfer,
      events: this.listEvents(database, id),
    };
  }

  async create(
    payload: TransferPayload,
  ): Promise<TransferResponse> {
    const normalized = normalizeTransferPayload(payload);
    const now = new Date().toISOString();
    const id = randomUUID();
    const database = await this.getDatabase();

    try {
      await runInTransaction(database, async () => {
        const { code, seq } = this.generateCode(database);
        const transfer: Transfer = {
          id,
          code,
          ...normalized,
          createdAt: now,
          updatedAt: now,
        };

        this.insertTransfer(database, transfer, seq);
        this.insertEvent(database, {
          id: randomUUID(),
          transferId: id,
          type: "created",
          date: now.slice(0, 10),
          title: "Створено передачу",
          meta: `Маршрут: ${normalized.route}`,
          createdAt: now,
        });
      });
    } catch (error) {
      throw toRepositoryError(error);
    }

    return this.get(id);
  }

  async update(
    id: string,
    payload: TransferPayload,
  ): Promise<TransferResponse> {
    const normalized = normalizeTransferPayload(payload);
    const database = await this.getDatabase();

    try {
      await runInTransaction(database, async () => {
        const existing = this.findTransfer(database, id);
        const updated: Transfer = {
          ...existing,
          ...normalized,
          updatedAt: new Date().toISOString(),
        };

        this.updateTransfer(database, updated);
      });
    } catch (error) {
      throw toRepositoryError(error);
    }

    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const database = await this.getDatabase();

    await runInTransaction(database, async () => {
      this.findTransfer(database, id);
      database.prepare(`
        DELETE FROM logistics_transfers
        WHERE id = ?
      `).run(id);
    });
  }

  async addEvent(
    id: string,
    payload: TransferEventPayload,
  ): Promise<TransferResponse> {
    const database = await this.getDatabase();

    await runInTransaction(database, async () => {
      const existing = this.findTransfer(database, id);
      const { transfer, event } = this.applyEvent(existing, payload);

      this.updateTransfer(database, transfer);
      this.insertEvent(database, event);
    });

    return this.get(id);
  }

  async exportCsv(): Promise<string> {
    const transfers = await this.list();
    const header = [
      "Код",
      "Маршрут",
      "Отримувач",
      "Водій або волонтер",
      "Дата передачі",
      "Статус",
      "Акт",
      "Фото",
      "Заявка",
      "Склад",
      "Звіт",
      "Позицій у передачі",
      "Оновлено",
    ];
    const rows = transfers.map((transfer) => [
      transfer.code,
      transfer.route,
      transfer.recipient,
      transfer.driver,
      transfer.transferDate,
      STATUS_LABELS[transfer.status],
      getActLabel(transfer.actState, transfer.actReference),
      getPhotoLabel(transfer.photoState, transfer.photoCount),
      transfer.requestId,
      transfer.warehouseId,
      transfer.reportId,
      String(transfer.manifest.length),
      transfer.updatedAt,
    ]);

    return [header, ...rows]
      .map((row) => row.map(toCsvCell).join(","))
      .join("\r\n");
  }

  private applyEvent(
    transfer: Transfer,
    payload: TransferEventPayload,
  ): {
    transfer: Transfer;
    event: LogisticsEvent;
  } {
    const type = normalizeEventType(payload.type);
    const date = normalizeDate(payload.date);
    const now = new Date().toISOString();
    const next: Transfer = {
      ...transfer,
      updatedAt: now,
    };
    let title = normalizeOptionalText(payload.title);
    let meta = normalizeOptionalText(payload.meta);

    if (type === "status") {
      const status = normalizeStatus(payload.status);

      next.status = status;

      if (status === "transferred") {
        next.routeConfirmed = true;
      }

      title = title || "Оновлено статус";
      meta = meta || STATUS_LABELS[status];
    } else if (type === "act") {
      const actState = normalizeDocumentState(payload.actState);
      const actReference = normalizeOptionalText(payload.actReference);

      next.actState = actState;
      next.actReference =
        actState === "missing" ? "" : actReference || transfer.actReference;
      title = title || "Оновлено акт передачі";
      meta = meta || getActLabel(next.actState, next.actReference);
    } else if (type === "photo") {
      const photoState = normalizeDocumentState(payload.photoState);
      const photoCount = normalizeCount(
        payload.photoCount,
        "Кількість фото",
        MAX_PHOTO_COUNT,
      );

      next.photoState = photoState;
      next.photoCount = photoState === "missing" ? 0 : photoCount;
      title = title || "Оновлено фото передачі";
      meta = meta || getPhotoLabel(next.photoState, next.photoCount);
    } else {
      title = title || "Нотатка";
    }

    return {
      transfer: next,
      event: {
        id: randomUUID(),
        transferId: transfer.id,
        type,
        date,
        title,
        meta,
        createdAt: now,
      },
    };
  }

  private generateCode(database: DatabaseSync): {
    code: string;
    seq: number;
  } {
    const row = database.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM logistics_transfers
    `).get() as Record<string, unknown> | undefined;
    const seq = getNumber(row, "max_seq") + 1;
    const year = new Date().getFullYear();

    return {
      code: `TR-${year}-${String(seq).padStart(3, "0")}`,
      seq,
    };
  }

  private async getDatabase(): Promise<DatabaseSync> {
    if (this.database) {
      return this.database;
    }

    this.database = await openSqliteDatabase({
      storageRoot: this.storageRoot,
      databasePath: this.databasePath,
      migrate: (database) => {
        this.migrateDatabase(database);
      },
    });

    return this.database;
  }

  private migrateDatabase(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS logistics_transfers (
        id TEXT PRIMARY KEY NOT NULL,
        seq INTEGER NOT NULL,
        code TEXT NOT NULL UNIQUE CHECK (length(trim(code)) > 0),
        route TEXT NOT NULL CHECK (length(trim(route)) > 0),
        recipient TEXT NOT NULL CHECK (length(trim(recipient)) > 0),
        driver TEXT NOT NULL CHECK (length(trim(driver)) > 0),
        transfer_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        route_confirmed INTEGER NOT NULL DEFAULT 0
          CHECK (route_confirmed IN (0, 1)),
        act_state TEXT NOT NULL DEFAULT 'missing',
        act_reference TEXT NOT NULL DEFAULT '',
        photo_state TEXT NOT NULL DEFAULT 'missing',
        photo_count INTEGER NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
        request_id TEXT NOT NULL DEFAULT '',
        warehouse_id TEXT NOT NULL DEFAULT '',
        report_id TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        manifest TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
      );

      CREATE TABLE IF NOT EXISTS logistics_events (
        id TEXT PRIMARY KEY NOT NULL,
        transfer_id TEXT NOT NULL
          REFERENCES logistics_transfers(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        meta TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
      );

      CREATE INDEX IF NOT EXISTS idx_logistics_transfers_date
        ON logistics_transfers(transfer_date DESC);
      CREATE INDEX IF NOT EXISTS idx_logistics_events_transfer
        ON logistics_events(transfer_id, date ASC);

      PRAGMA user_version = 1;
    `);

    this.seedIfEmpty(database);
  }

  private seedIfEmpty(database: DatabaseSync): void {
    const row = database.prepare(`
      SELECT COUNT(*) AS total
      FROM logistics_transfers
    `).get() as Record<string, unknown> | undefined;

    if (getNumber(row, "total") > 0) {
      return;
    }

    const now = new Date().toISOString();

    for (const seed of LOGISTICS_SEED) {
      const id = randomUUID();
      const seq = Number(seed.code.split("-").at(-1) ?? 0);

      this.insertTransfer(
        database,
        {
          id,
          code: seed.code,
          route: seed.route,
          recipient: seed.recipient,
          driver: seed.driver,
          transferDate: seed.transferDate,
          status: seed.status,
          routeConfirmed: seed.routeConfirmed,
          actState: seed.actState,
          actReference: seed.actReference,
          photoState: seed.photoState,
          photoCount: seed.photoCount,
          requestId: seed.requestId,
          warehouseId: seed.warehouseId,
          reportId: seed.reportId,
          notes: seed.notes,
          manifest: seed.manifest,
          createdAt: now,
          updatedAt: now,
        },
        seq,
      );
      this.insertEvent(database, {
        id: randomUUID(),
        transferId: id,
        type: "created",
        date: seed.transferDate,
        title: "Створено передачу",
        meta: `Маршрут: ${seed.route}`,
        createdAt: now,
      });
    }
  }

  private insertTransfer(
    database: DatabaseSync,
    transfer: Transfer,
    seq: number,
  ): void {
    database.prepare(`
      INSERT INTO logistics_transfers (
        id, seq, code, route, recipient, driver, transfer_date, status,
        route_confirmed, act_state, act_reference, photo_state, photo_count,
        request_id, warehouse_id, report_id, notes, manifest,
        created_at, updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      transfer.id,
      seq,
      transfer.code,
      transfer.route,
      transfer.recipient,
      transfer.driver,
      transfer.transferDate,
      transfer.status,
      transfer.routeConfirmed ? 1 : 0,
      transfer.actState,
      transfer.actReference,
      transfer.photoState,
      transfer.photoCount,
      transfer.requestId,
      transfer.warehouseId,
      transfer.reportId,
      transfer.notes,
      JSON.stringify(transfer.manifest),
      transfer.createdAt,
      transfer.updatedAt,
    );
  }

  private updateTransfer(
    database: DatabaseSync,
    transfer: Transfer,
  ): void {
    database.prepare(`
      UPDATE logistics_transfers
      SET
        route = ?,
        recipient = ?,
        driver = ?,
        transfer_date = ?,
        status = ?,
        route_confirmed = ?,
        act_state = ?,
        act_reference = ?,
        photo_state = ?,
        photo_count = ?,
        request_id = ?,
        warehouse_id = ?,
        report_id = ?,
        notes = ?,
        manifest = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      transfer.route,
      transfer.recipient,
      transfer.driver,
      transfer.transferDate,
      transfer.status,
      transfer.routeConfirmed ? 1 : 0,
      transfer.actState,
      transfer.actReference,
      transfer.photoState,
      transfer.photoCount,
      transfer.requestId,
      transfer.warehouseId,
      transfer.reportId,
      transfer.notes,
      JSON.stringify(transfer.manifest),
      transfer.updatedAt,
      transfer.id,
    );
  }

  private insertEvent(
    database: DatabaseSync,
    event: LogisticsEvent,
  ): void {
    database.prepare(`
      INSERT INTO logistics_events (
        id, transfer_id, type, date, title, meta, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.transferId,
      event.type,
      event.date,
      event.title,
      event.meta,
      event.createdAt,
    );
  }

  private listEvents(
    database: DatabaseSync,
    transferId: string,
  ): LogisticsEvent[] {
    const rows = database.prepare(`
      SELECT *
      FROM logistics_events
      WHERE transfer_id = ?
      ORDER BY date ASC, created_at ASC
    `).all(transferId) as Record<string, unknown>[];

    return rows.map(rowToEvent);
  }

  private findTransfer(
    database: DatabaseSync,
    id: string,
  ): Transfer {
    const row = database.prepare(`
      SELECT *
      FROM logistics_transfers
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error("Передачу не знайдено.");
    }

    return rowToTransfer(row);
  }
}

function toCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

interface LogisticsSeedTransfer {
  code: string;
  route: string;
  recipient: string;
  driver: string;
  transferDate: string;
  status: TransferStatus;
  routeConfirmed: boolean;
  actState: DocumentState;
  actReference: string;
  photoState: DocumentState;
  photoCount: number;
  requestId: string;
  warehouseId: string;
  reportId: string;
  notes: string;
  manifest: ManifestLine[];
}

const LOGISTICS_SEED: LogisticsSeedTransfer[] = [
  {
    code: "TR-2026-052",
    route: "Київ - Харків - Куп'янський напрямок",
    recipient: "Медична рота, Харківська область",
    driver: "Ірина Коваль / бус Renault Master",
    transferDate: "2026-06-27",
    status: "planned",
    routeConfirmed: true,
    actState: "pending",
    actReference: "",
    photoState: "pending",
    photoCount: 0,
    requestId: "REQ-2026-044",
    warehouseId: "WH-FOOD-027, WH-MED-009",
    reportId: "REP-2026-019",
    notes:
      "Перед виїздом перевірити медичну комплектацію та додати турнікети.",
    manifest: [
      { name: "Продуктові набори", quantity: "45 наборів" },
      {
        name: "Аптечки тактичні",
        quantity: "24 шт. після доукомплектації",
      },
    ],
  },
  {
    code: "TR-2026-049",
    route: "Львів - Дніпро - стабпункт",
    recipient: "Стабілізаційний пункт, Дніпропетровська область",
    driver: "Андрій Мельник / волонтерський екіпаж",
    transferDate: "2026-06-24",
    status: "transferred",
    routeConfirmed: true,
    actState: "ready",
    actReference: "ACT-2026-049.pdf",
    photoState: "ready",
    photoCount: 8,
    requestId: "REQ-2026-039",
    warehouseId: "WH-GEN-014",
    reportId: "REP-2026-017",
    notes: "Отримувач підтвердив генератори і свічки у день передачі.",
    manifest: [
      { name: "Генератори 3 кВт", quantity: "2 шт." },
      { name: "Окопні свічки", quantity: "120 шт." },
    ],
  },
  {
    code: "TR-2026-046",
    route: "Київ - Суми - прикордонна громада",
    recipient: "Волонтерський штаб Сумської області",
    driver: "Богдан Колодій / Нова пошта гуманітарна",
    transferDate: "2026-06-21",
    status: "report",
    routeConfirmed: true,
    actState: "ready",
    actReference: "ACT-2026-046.pdf",
    photoState: "missing",
    photoCount: 0,
    requestId: "REQ-2026-036",
    warehouseId: "WH-CLT-033",
    reportId: "REP-2026-014",
    notes:
      "Потрібно отримати фото від штабу або водія для закриття звіту.",
    manifest: [
      { name: "Термобілизна", quantity: "18 компл." },
      { name: "Маскувальні сітки 6x4", quantity: "6 шт." },
    ],
  },
  {
    code: "TR-2026-043",
    route: "Дніпро - Запоріжжя - Оріхів",
    recipient: "Підрозділ радіозв'язку",
    driver: "Сергій Романенко / пікап L200",
    transferDate: "2026-06-18",
    status: "transferred",
    routeConfirmed: true,
    actState: "ready",
    actReference: "ACT-2026-043.pdf",
    photoState: "ready",
    photoCount: 5,
    requestId: "REQ-2026-031",
    warehouseId: "WH-DRN-001",
    reportId: "REP-2026-012",
    notes:
      "Партію закрито, залишок FPV комплектів повернувся у вільний склад.",
    manifest: [
      { name: 'FPV комплекти 7"', quantity: "8 компл." },
      { name: "Акумулятори та антени", quantity: "8 наборів" },
    ],
  },
  {
    code: "TR-2026-054",
    route: "Львів - Київ - Чернігів",
    recipient: "Чернігівський центр підтримки ВПО",
    driver: "Марія Савчук / волонтер",
    transferDate: "2026-06-29",
    status: "planned",
    routeConfirmed: false,
    actState: "missing",
    actReference: "",
    photoState: "pending",
    photoCount: 0,
    requestId: "REQ-2026-048",
    warehouseId: "WH-FOOD-027, WH-CND-006",
    reportId: "REP-2026-021",
    notes: "Підтвердити слот отримувача до кінця дня 2026-06-27.",
    manifest: [
      { name: "Продуктові набори", quantity: "20 наборів" },
      { name: "Окопні свічки", quantity: "60 шт." },
    ],
  },
];
