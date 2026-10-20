/**
 * Versioned JSON export envelope (Increment 27, CONTRACTS §6).
 *
 * The format is deliberately **logical** — entities and their column values —
 * not a SQL dump. That one property is what lets the same payload serve three
 * jobs at once:
 *
 *   1. the one-off SQLite → Postgres migration (`scripts/migrate-sqlite-to-pg.ts`),
 *   2. `GET /api/data/export` → `POST /api/data/import` local → server transfer,
 *   3. a human-readable, diffable backup that outlives any storage engine.
 *
 * A `pg_dump` can do none of those; conversely this format is not a substitute
 * for `pg_dump` as an operational backup (see `scripts/backup.sh`). Both exist.
 */

/** The only format version this build reads or writes. */
export const EXPORT_SCHEMA_VERSION = 1;

/** A single exported row: **database** column names (snake_case) → value. */
export type ExportRow = Record<string, unknown>;

export interface ExportEnvelope {
  /** Format version. Bumped only on a breaking change; unknown values are rejected. */
  schema_version: number;
  /** ISO-8601 UTC instant the export was produced. */
  exported_at: string;
  source: {
    app: "op-sprint-planner";
    increment: number;
  };
  /**
   * True when `vault_meta` and the `op_connection` token ciphertext are present.
   * A `true` export is **secret material** — it is only as safe as the vault
   * passphrase, and the same passphrase is required at import time.
   */
  includes_credentials: boolean;
  /**
   * Table name → rows, in a **foreign-key-safe insertion order** (parents first).
   * Postgres enforces FKs natively and unconditionally now, unlike SQLite where
   * `PRAGMA foreign_keys` had to be switched on, so this ordering is load-bearing
   * rather than cosmetic.
   */
  tables: Record<string, ExportRow[]>;
}

/** Result of a replace-mode import. */
export interface ImportResult {
  /** Only mode in Increment 27 (CONTRACTS §6, confirmed decision §9.3). */
  mode: "replace";
  /** Table name → rows inserted. */
  inserted: Record<string, number>;
  /** Table name → rows deleted by the wipe step. */
  deleted: Record<string, number>;
  /** Total rows inserted across all tables. */
  total_inserted: number;
  /** Whether the payload carried credentials (and they were restored). */
  included_credentials: boolean;
  /**
   * True when the OP work-package cache was cleared and the user must run
   * "Sync now" to repopulate it. Always true for a replace import — the cache
   * is excluded from the payload by design (re-syncable from OP).
   */
  requires_resync: boolean;
}

/**
 * Thrown for anything wrong with the *payload* (bad version, unknown table,
 * unknown column, malformed envelope) — as opposed to a database error. The
 * HTTP layer maps this to 400 rather than 500.
 */
export class ExportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportFormatError";
  }
}
