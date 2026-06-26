import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  WarehouseItem,
  WarehouseItemPayload,
  WarehouseItemResponse,
  WarehouseMovement,
  WarehouseMovementPayload,
  WarehouseMovementType,
} from "./warehouse.types";

const NO_RESERVE_LABELS = new Set([
  "",
  "немає резерву",
  "нет резерва",
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_QUANTITY = 1_000_000;
const MOVEMENT_TYPES = new Set<WarehouseMovementType>([
  "receipt",
  "issue",
  "reserve",
  "note",
]);
const CATEGORY_CODE_PREFIXES = new Map<string, string>([
  ["дрони", "DRN"],
  ["генератори", "GEN"],
  ["продукти", "FOOD"],
  ["медикаменти", "MED"],
  ["сітки", "NET"],
  ["свічки", "CND"],
  ["одяг", "CLT"],
]);

export interface WarehouseRepositoryOptions {
  storageRoot: string;
}

interface NormalizedItemPayload {
  name: string;
  category: string;
  quantity: number;
  unit: string;
  availableNow: number;
  condition: string;
  location: string;
  reservedFor: string;
  needsCheck: boolean;
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

function normalizeReservedFor(value: unknown): string {
  const text = normalizeOptionalText(value);

  return NO_RESERVE_LABELS.has(text.toLowerCase()) ? "" : text;
}

function normalizeCount(
  value: unknown,
  fieldName: string,
): number {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (
    !Number.isFinite(numericValue) ||
    !Number.isInteger(numericValue) ||
    numericValue < 0
  ) {
    throw new Error(`${fieldName}: вкажіть ціле число від 0.`);
  }

  if (numericValue > MAX_QUANTITY) {
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

function normalizeItemPayload(
  payload: WarehouseItemPayload,
): NormalizedItemPayload {
  const name = normalizeRequiredText(payload.name, "Назва позиції");
  const category = normalizeRequiredText(payload.category, "Категорія");
  const unit = normalizeRequiredText(payload.unit, "Одиниця виміру");
  const quantity = normalizeCount(payload.quantity, "Кількість");
  const availableNow = normalizeCount(payload.availableNow, "Доступно зараз");

  if (availableNow > quantity) {
    throw new Error("Доступно зараз не може перевищувати загальну кількість.");
  }

  return {
    name,
    category,
    quantity,
    unit,
    availableNow,
    condition: normalizeOptionalText(payload.condition),
    location: normalizeOptionalText(payload.location),
    reservedFor: normalizeReservedFor(payload.reservedFor),
    needsCheck: Boolean(payload.needsCheck),
  };
}

function getCategoryPrefix(category: string): string {
  const mapped = CATEGORY_CODE_PREFIXES.get(category.trim().toLowerCase());

  if (mapped) {
    return mapped;
  }

  const latin = category
    .normalize("NFKD")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();

  return (latin.slice(0, 3) || "ITM").padEnd(3, "X");
}

function transliterateMovementType(type: unknown): WarehouseMovementType {
  if (
    typeof type === "string" &&
    MOVEMENT_TYPES.has(type as WarehouseMovementType)
  ) {
    return type as WarehouseMovementType;
  }

  return "note";
}

function rowToItem(row: Record<string, unknown>): WarehouseItem {
  return {
    id: String(row.id ?? ""),
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    category: String(row.category ?? ""),
    quantity: Number(row.quantity ?? 0),
    unit: String(row.unit ?? ""),
    availableNow: Number(row.available_now ?? 0),
    condition: String(row.condition ?? ""),
    location: String(row.location ?? ""),
    reservedFor: String(row.reserved_for ?? ""),
    needsCheck: Number(row.needs_check ?? 0) === 1,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function rowToMovement(row: Record<string, unknown>): WarehouseMovement {
  return {
    id: String(row.id ?? ""),
    itemId: String(row.item_id ?? ""),
    type: transliterateMovementType(row.type),
    date: String(row.date ?? ""),
    title: String(row.title ?? ""),
    meta: String(row.meta ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function getNumber(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  return Number(row?.[key] ?? 0);
}

function toRepositoryError(error: unknown): Error {
  if (error instanceof Error) {
    if (
      "code" in error &&
      error.code === "ERR_SQLITE_ERROR" &&
      error.message.includes("warehouse_items.code")
    ) {
      return new Error("Код позиції вже існує. Спробуйте ще раз.");
    }

    return error;
  }

  return new Error("Помилка обробки складської позиції.");
}

export class WarehouseRepository {
  private readonly databasePath: string;

  private readonly storageRoot: string;

  private database: DatabaseSync | null = null;

  constructor(options: WarehouseRepositoryOptions) {
    this.storageRoot = options.storageRoot;
    this.databasePath = path.join(
      options.storageRoot,
      "warehouse.sqlite",
    );
  }

  async check(): Promise<void> {
    await this.getDatabase();
  }

  async list(): Promise<WarehouseItemResponse[]> {
    const database = await this.getDatabase();
    const itemRows = database.prepare(`
      SELECT *
      FROM warehouse_items
      ORDER BY updated_at DESC, code ASC
    `).all() as Record<string, unknown>[];
    const movementRows = database.prepare(`
      SELECT *
      FROM warehouse_movements
      ORDER BY date ASC, created_at ASC
    `).all() as Record<string, unknown>[];
    const movementsByItem = new Map<string, WarehouseMovement[]>();

    for (const row of movementRows) {
      const movement = rowToMovement(row);
      const bucket = movementsByItem.get(movement.itemId) ?? [];

      bucket.push(movement);
      movementsByItem.set(movement.itemId, bucket);
    }

    return itemRows.map((row) => {
      const item = rowToItem(row);

      return {
        ...item,
        movement: movementsByItem.get(item.id) ?? [],
      };
    });
  }

  async get(id: string): Promise<WarehouseItemResponse> {
    const database = await this.getDatabase();
    const item = this.findItem(database, id);

    return {
      ...item,
      movement: this.listMovements(database, id),
    };
  }

  async create(
    payload: WarehouseItemPayload,
  ): Promise<WarehouseItemResponse> {
    const normalized = normalizeItemPayload(payload);
    const now = new Date().toISOString();
    const id = randomUUID();
    const database = await this.getDatabase();
    let createdItem: WarehouseItem | null = null;

    try {
      await this.runInTransaction(database, async () => {
        const code = this.generateCode(database, normalized.category);
        const item: WarehouseItem = {
          id,
          code,
          ...normalized,
          createdAt: now,
          updatedAt: now,
        };

        this.insertItem(database, item);
        this.insertMovement(database, {
          id: randomUUID(),
          itemId: id,
          type: "receipt",
          date: now.slice(0, 10),
          title: "Створено позицію",
          meta: `Початковий залишок: ${normalized.quantity} ${normalized.unit}`,
          createdAt: now,
        });
        createdItem = item;
      });
    } catch (error) {
      throw toRepositoryError(error);
    }

    return this.get((createdItem as WarehouseItem).id);
  }

  async update(
    id: string,
    payload: WarehouseItemPayload,
  ): Promise<WarehouseItemResponse> {
    const normalized = normalizeItemPayload(payload);
    const database = await this.getDatabase();

    try {
      await this.runInTransaction(database, async () => {
        const existing = this.findItem(database, id);
        const updated: WarehouseItem = {
          ...existing,
          ...normalized,
          updatedAt: new Date().toISOString(),
        };

        this.updateItem(database, updated);
      });
    } catch (error) {
      throw toRepositoryError(error);
    }

    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const database = await this.getDatabase();

    await this.runInTransaction(database, async () => {
      this.findItem(database, id);
      database.prepare(`
        DELETE FROM warehouse_items
        WHERE id = ?
      `).run(id);
    });
  }

  async addMovement(
    id: string,
    payload: WarehouseMovementPayload,
  ): Promise<WarehouseItemResponse> {
    const database = await this.getDatabase();

    await this.runInTransaction(database, async () => {
      const existing = this.findItem(database, id);
      const { item, movement } = this.applyMovement(existing, payload);

      this.updateItem(database, item);
      this.insertMovement(database, movement);
    });

    return this.get(id);
  }

  async exportCsv(): Promise<string> {
    const items = await this.list();
    const header = [
      "Код",
      "Назва",
      "Категорія",
      "Кількість",
      "Одиниця",
      "Доступно зараз",
      "Стан",
      "Місце зберігання",
      "Резерв",
      "Потребує перевірки",
      "Оновлено",
    ];
    const rows = items.map((item) => [
      item.code,
      item.name,
      item.category,
      String(item.quantity),
      item.unit,
      String(item.availableNow),
      item.condition,
      item.location,
      item.reservedFor || "Немає резерву",
      item.needsCheck ? "так" : "ні",
      item.updatedAt,
    ]);

    return [header, ...rows]
      .map((row) => row.map(toCsvCell).join(","))
      .join("\r\n");
  }

  private applyMovement(
    item: WarehouseItem,
    payload: WarehouseMovementPayload,
  ): {
    item: WarehouseItem;
    movement: WarehouseMovement;
  } {
    const type = transliterateMovementType(payload.type);
    const date = normalizeDate(payload.date);
    const now = new Date().toISOString();
    const next: WarehouseItem = {
      ...item,
      updatedAt: now,
    };
    let title = normalizeOptionalText(payload.title);
    let meta = normalizeOptionalText(payload.meta);

    if (type === "note") {
      if (!title) {
        title = "Нотатка";
      }
    } else if (type === "receipt") {
      const amount = this.normalizeMovementAmount(payload.amount);

      next.quantity = Math.min(item.quantity + amount, MAX_QUANTITY);
      next.availableNow = Math.min(item.availableNow + amount, next.quantity);
      title = title || "Надходження";
      meta = meta || `+${amount} ${item.unit}`;
    } else if (type === "issue") {
      const amount = this.normalizeMovementAmount(payload.amount);

      if (amount > item.availableNow) {
        throw new Error("Не можна видати більше, ніж доступно зараз.");
      }

      next.availableNow = item.availableNow - amount;
      next.quantity = item.quantity - amount;
      title = title || "Видача";
      meta = meta || `-${amount} ${item.unit}`;
    } else {
      const amount = this.normalizeMovementAmount(payload.amount, true);
      const reservedFor = normalizeReservedFor(payload.reservedFor);

      if (amount > item.availableNow) {
        throw new Error("Не можна зарезервувати більше, ніж доступно зараз.");
      }

      next.availableNow = item.availableNow - amount;
      next.reservedFor = reservedFor || item.reservedFor;
      title = title || "Резерв";
      meta = meta ||
        `${amount} ${item.unit}${reservedFor ? ` для: ${reservedFor}` : ""}`;
    }

    return {
      item: next,
      movement: {
        id: randomUUID(),
        itemId: item.id,
        type,
        date,
        title,
        meta,
        createdAt: now,
      },
    };
  }

  private normalizeMovementAmount(
    value: unknown,
    allowZero = false,
  ): number {
    const amount = normalizeCount(value, "Кількість операції");

    if (!allowZero && amount === 0) {
      throw new Error("Кількість операції має бути більше нуля.");
    }

    return amount;
  }

  private generateCode(
    database: DatabaseSync,
    category: string,
  ): string {
    const prefix = getCategoryPrefix(category);
    const row = database.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM warehouse_items
    `).get() as Record<string, unknown> | undefined;
    const nextSeq = getNumber(row, "max_seq") + 1;

    return `WH-${prefix}-${String(nextSeq).padStart(3, "0")}`;
  }

  private async getDatabase(): Promise<DatabaseSync> {
    if (this.database) {
      return this.database;
    }

    await mkdir(this.storageRoot, { recursive: true });

    const database = new DatabaseSync(this.databasePath);

    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrateDatabase(database);
    this.database = database;

    return database;
  }

  private migrateDatabase(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS warehouse_items (
        id TEXT PRIMARY KEY NOT NULL,
        seq INTEGER NOT NULL,
        code TEXT NOT NULL UNIQUE CHECK (length(trim(code)) > 0),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        category TEXT NOT NULL CHECK (length(trim(category)) > 0),
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
        available_now INTEGER NOT NULL
          CHECK (available_now >= 0 AND available_now <= quantity),
        condition TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        reserved_for TEXT NOT NULL DEFAULT '',
        needs_check INTEGER NOT NULL DEFAULT 0 CHECK (needs_check IN (0, 1)),
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
      );

      CREATE TABLE IF NOT EXISTS warehouse_movements (
        id TEXT PRIMARY KEY NOT NULL,
        item_id TEXT NOT NULL
          REFERENCES warehouse_items(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        meta TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
      );

      CREATE INDEX IF NOT EXISTS idx_warehouse_items_updated_at
        ON warehouse_items(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_warehouse_movements_item
        ON warehouse_movements(item_id, date ASC);

      PRAGMA user_version = 1;
    `);

    this.seedIfEmpty(database);
  }

  private seedIfEmpty(database: DatabaseSync): void {
    const row = database.prepare(`
      SELECT COUNT(*) AS total
      FROM warehouse_items
    `).get() as Record<string, unknown> | undefined;

    if (getNumber(row, "total") > 0) {
      return;
    }

    const now = new Date().toISOString();

    for (const seed of WAREHOUSE_SEED) {
      const id = randomUUID();
      const code = this.generateCode(database, seed.category);

      this.insertItem(database, {
        id,
        code,
        name: seed.name,
        category: seed.category,
        quantity: seed.quantity,
        unit: seed.unit,
        availableNow: seed.availableNow,
        condition: seed.condition,
        location: seed.location,
        reservedFor: seed.reservedFor,
        needsCheck: seed.needsCheck,
        createdAt: now,
        updatedAt: now,
      });
      this.insertMovement(database, {
        id: randomUUID(),
        itemId: id,
        type: "receipt",
        date: now.slice(0, 10),
        title: "Створено позицію",
        meta: `Початковий залишок: ${seed.quantity} ${seed.unit}`,
        createdAt: now,
      });
    }
  }

  private async runInTransaction<T>(
    database: DatabaseSync,
    operation: () => Promise<T>,
  ): Promise<T> {
    database.exec("BEGIN IMMEDIATE");

    try {
      const result = await operation();

      database.exec("COMMIT");

      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Keep the original failure visible.
      }

      throw error;
    }
  }

  private insertItem(
    database: DatabaseSync,
    item: WarehouseItem,
  ): void {
    database.prepare(`
      INSERT INTO warehouse_items (
        id, seq, code, name, category, quantity, unit, available_now,
        condition, location, reserved_for, needs_check, created_at, updated_at
      )
      VALUES (
        ?,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM warehouse_items),
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      item.id,
      item.code,
      item.name,
      item.category,
      item.quantity,
      item.unit,
      item.availableNow,
      item.condition,
      item.location,
      item.reservedFor,
      item.needsCheck ? 1 : 0,
      item.createdAt,
      item.updatedAt,
    );
  }

  private updateItem(
    database: DatabaseSync,
    item: WarehouseItem,
  ): void {
    database.prepare(`
      UPDATE warehouse_items
      SET
        name = ?,
        category = ?,
        quantity = ?,
        unit = ?,
        available_now = ?,
        condition = ?,
        location = ?,
        reserved_for = ?,
        needs_check = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      item.name,
      item.category,
      item.quantity,
      item.unit,
      item.availableNow,
      item.condition,
      item.location,
      item.reservedFor,
      item.needsCheck ? 1 : 0,
      item.updatedAt,
      item.id,
    );
  }

  private insertMovement(
    database: DatabaseSync,
    movement: WarehouseMovement,
  ): void {
    database.prepare(`
      INSERT INTO warehouse_movements (
        id, item_id, type, date, title, meta, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      movement.id,
      movement.itemId,
      movement.type,
      movement.date,
      movement.title,
      movement.meta,
      movement.createdAt,
    );
  }

  private listMovements(
    database: DatabaseSync,
    itemId: string,
  ): WarehouseMovement[] {
    const rows = database.prepare(`
      SELECT *
      FROM warehouse_movements
      WHERE item_id = ?
      ORDER BY date ASC, created_at ASC
    `).all(itemId) as Record<string, unknown>[];

    return rows.map(rowToMovement);
  }

  private findItem(
    database: DatabaseSync,
    id: string,
  ): WarehouseItem {
    const row = database.prepare(`
      SELECT *
      FROM warehouse_items
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error("Складську позицію не знайдено.");
    }

    return rowToItem(row);
  }
}

function toCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

interface WarehouseSeedItem {
  name: string;
  category: string;
  quantity: number;
  unit: string;
  availableNow: number;
  condition: string;
  location: string;
  reservedFor: string;
  needsCheck: boolean;
}

const WAREHOUSE_SEED: WarehouseSeedItem[] = [
  {
    name: 'FPV комплекти 7"',
    category: "Дрони",
    quantity: 12,
    unit: "компл.",
    availableNow: 4,
    condition: "Нові, перевірені",
    location: "Київ, склад A / стелаж 2",
    reservedFor: "93 ОМБр, заявка REQ-2026-031",
    needsCheck: false,
  },
  {
    name: "Генератори 3 кВт",
    category: "Генератори",
    quantity: 6,
    unit: "шт.",
    availableNow: 6,
    condition: "Після сервісу, готові",
    location: "Львів, склад B / зона техніки",
    reservedFor: "",
    needsCheck: false,
  },
  {
    name: "Продуктові набори",
    category: "Продукти",
    quantity: 80,
    unit: "наборів",
    availableNow: 35,
    condition: "Термін придатності до 2027-01",
    location: "Київ, склад A / суха зона",
    reservedFor: "Центр ВПО Харків, заявка REQ-2026-044",
    needsCheck: false,
  },
  {
    name: "Аптечки тактичні",
    category: "Медикаменти",
    quantity: 24,
    unit: "шт.",
    availableNow: 0,
    condition: "Потребують доукомплектації турнікетами",
    location: "Київ, склад A / медична шафа",
    reservedFor: "Медики Сумського напрямку, REQ-2026-039",
    needsCheck: true,
  },
  {
    name: "Маскувальні сітки 6x4",
    category: "Сітки",
    quantity: 18,
    unit: "шт.",
    availableNow: 18,
    condition: "Готові, упаковані",
    location: "Дніпро, партнерський склад / зона видачі",
    reservedFor: "",
    needsCheck: false,
  },
  {
    name: "Окопні свічки",
    category: "Свічки",
    quantity: 240,
    unit: "шт.",
    availableNow: 120,
    condition: "Готові до відвантаження",
    location: "Львів, склад B / коробки C4-C7",
    reservedFor: "Бахмутський напрямок, REQ-2026-047",
    needsCheck: false,
  },
  {
    name: "Термобілизна, мікс розмірів",
    category: "Одяг",
    quantity: 46,
    unit: "компл.",
    availableNow: 46,
    condition: "Новий одяг, розмірна сітка в описі",
    location: "Київ, склад A / стелаж 5",
    reservedFor: "",
    needsCheck: false,
  },
];
