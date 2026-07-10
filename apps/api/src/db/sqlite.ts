import path from "node:path";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/**
 * Shared SQLite connection helpers used by every repository module.
 *
 * Centralises the connection pragmas, directory bootstrap and transaction
 * wrapper that were previously duplicated across the certificate, warehouse
 * and logistics repositories.
 */

export interface OpenSqliteDatabaseOptions {
  /** Directory that must exist before the database file is created. */
  storageRoot: string;
  /** Absolute path to the SQLite database file. */
  databasePath: string;
  /** Schema/seed migration applied right after the connection is opened. */
  migrate: (database: DatabaseSync) => void;
}

const CONNECTION_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`;

export async function openSqliteDatabase(
  options: OpenSqliteDatabaseOptions,
): Promise<DatabaseSync> {
  await mkdir(
    options.storageRoot,
    {
      recursive: true,
    },
  );

  const database = new DatabaseSync(options.databasePath);

  database.exec(CONNECTION_PRAGMAS);
  options.migrate(database);

  return database;
}

/**
 * Per-connection serialization chain for write transactions.
 *
 * `DatabaseSync` is a single synchronous connection shared across all requests.
 * A transaction body may `await` real I/O (e.g. moving an uploaded photo into
 * place) while `BEGIN IMMEDIATE` is held. Without serialization, a second
 * concurrent write would issue its own `BEGIN IMMEDIATE` on the same connection
 * during that await and fail with "cannot start a transaction within a
 * transaction". We therefore queue every transaction on a per-database promise
 * chain so at most one runs at a time. Reads (plain `prepare().all()`/`.get()`)
 * do not go through here and remain concurrent.
 */
const writeChains = new WeakMap<DatabaseSync, Promise<unknown>>();

export async function runInTransaction<T>(
  database: DatabaseSync,
  operation: () => Promise<T>,
): Promise<T> {
  const runExclusive = async (): Promise<T> => {
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
  };

  const previous = writeChains.get(database) ?? Promise.resolve();
  // Run after the previous transaction settles, regardless of its outcome.
  const next = previous.then(runExclusive, runExclusive);

  // Store a non-rejecting tail so one failed transaction cannot poison the
  // queue for every subsequent writer.
  writeChains.set(
    database,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next;
}

export function getNumber(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  return Number(row?.[key] ?? 0);
}

export function resolveDatabasePath(
  storageRoot: string,
  fileName: string,
): string {
  return path.join(
    storageRoot,
    fileName,
  );
}
