import { DatabaseSync } from "node:sqlite";

import {
  openSqliteDatabase,
  resolveDatabasePath,
} from "../../db/sqlite";

/**
 * Employee directory backing Cloudflare Access ("Phase 2").
 *
 * Rows are provisioned just-in-time: the first time a verified Access JWT
 * carries a new email the employee is inserted (the Access allowlist has
 * already vetted them, so there is no separate "create user" step), and every
 * later sighting refreshes `last_seen`. The table is the seed for future roles
 * and per-user audit.
 */

export interface EmployeeRepositoryOptions {
  storageRoot: string;
}

export interface Employee {
  email: string;
  name: string | null;
  firstSeen: string;
  /**
   * Role in the "Вибори" module: `agitator` | `coordinator` | `manager` |
   * `admin`, or `null` for an employee nobody has granted anything to yet.
   * `null` means read-only — it is deliberately not a synonym for "trusted".
   */
  role: string | null;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();

  if (!email) {
    throw new Error("Email співробітника обов'язковий.");
  }

  return email;
}

export class EmployeeRepository {
  private readonly databasePath: string;

  private readonly storageRoot: string;

  private database: DatabaseSync | null = null;

  constructor(options: EmployeeRepositoryOptions) {
    this.storageRoot = options.storageRoot;
    this.databasePath = resolveDatabasePath(
      options.storageRoot,
      "employees.sqlite",
    );
  }

  async check(): Promise<void> {
    await this.getDatabase();
  }

  /**
   * Records that `email` was just seen, inserting the employee on first contact
   * and refreshing `last_seen` (and filling in a `name` if one arrives later)
   * on subsequent ones. The upsert is a single statement, so it is atomic on
   * the shared connection without an explicit transaction.
   */
  async recordSeen(
    email: string,
    name?: string | null,
  ): Promise<Employee> {
    const normalizedEmail = normalizeEmail(email);
    const normalizedName =
      typeof name === "string" && name.trim() ? name.trim() : null;
    const now = new Date().toISOString();
    const database = await this.getDatabase();

    database.prepare(`
      INSERT INTO employees (email, name, first_seen, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        last_seen = excluded.last_seen,
        name = COALESCE(excluded.name, employees.name)
    `).run(
      normalizedEmail,
      normalizedName,
      now,
      now,
    );

    return this.findByEmail(database, normalizedEmail);
  }

  async list(): Promise<Employee[]> {
    const database = await this.getDatabase();
    const rows = database.prepare(`
      SELECT email, name, first_seen, role
      FROM employees
      ORDER BY last_seen DESC
    `).all() as Record<string, unknown>[];

    return rows.map(rowToEmployee);
  }

  /**
   * Grants or clears an employee's elections role.
   *
   * The caller is responsible for checking that whoever is asking is an admin;
   * this only writes. Passing `null` revokes, which is how somebody who leaves
   * the field team stops being able to write without losing their history.
   */
  async setRole(
    email: string,
    role: string | null,
  ): Promise<Employee> {
    const database = await this.getDatabase();
    const normalizedEmail = normalizeEmail(email);
    const result = database.prepare(`
      UPDATE employees SET role = ? WHERE email = ?
    `).run(
      role,
      normalizedEmail,
    );

    if (Number(result.changes ?? 0) === 0) {
      // Roles are granted to people the Access allowlist has already admitted,
      // so an unknown address is a typo rather than a new hire.
      throw new Error("Співробітника не знайдено.");
    }

    return this.findByEmail(
      database,
      normalizedEmail,
    );
  }

  private findByEmail(
    database: DatabaseSync,
    email: string,
  ): Employee {
    const row = database.prepare(`
      SELECT email, name, first_seen, role
      FROM employees
      WHERE email = ?
    `).get(email) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error("Співробітника не знайдено.");
    }

    return rowToEmployee(row);
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
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE CHECK (length(trim(email)) > 0),
        name TEXT,
        first_seen TEXT NOT NULL CHECK (length(trim(first_seen)) > 0),
        last_seen TEXT NOT NULL CHECK (length(trim(last_seen)) > 0)
      );

      CREATE INDEX IF NOT EXISTS idx_employees_last_seen
        ON employees(last_seen DESC);
    `);

    // v2: the elections module needs roles, and this table was always the
    // intended home for them. Added rather than recreated so existing rows and
    // their `first_seen` history survive; the guard makes the step idempotent.
    const columns = database.prepare(
      "PRAGMA table_info(employees)",
    ).all() as Record<string, unknown>[];

    if (!columns.some((column) => String(column.name) === "role")) {
      database.exec("ALTER TABLE employees ADD COLUMN role TEXT");
    }

    database.exec("PRAGMA user_version = 2;");
  }
}

function rowToEmployee(row: Record<string, unknown>): Employee {
  return {
    email: String(row.email),
    name: row.name == null ? null : String(row.name),
    firstSeen: String(row.first_seen),
    role: row.role == null ? null : String(row.role),
  };
}
