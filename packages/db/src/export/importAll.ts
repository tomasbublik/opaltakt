import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { OspDatabase } from "../repos";
import {
  CACHE_TABLES_CLEARED_ON_IMPORT,
  EXPORT_TABLES,
  IGNORABLE_TABLE_NAMES,
  KNOWN_TABLE_NAMES,
  columnsOf,
  dbNameToTsName,
  isJsonColumn,
  orderColumnOf,
  type ExportTableSpec,
} from "./tables";
import {
  EXPORT_SCHEMA_VERSION,
  ExportFormatError,
  type ExportEnvelope,
  type ExportRow,
  type ImportResult,
} from "./types";

/**
 * Replace-mode import of a §6 envelope (Increment 27, confirmed decision §9.3).
 *
 * **Replace is the only mode.** Merge was considered and deliberately dropped
 * for this increment: every table here is keyed by a surrogate `id` that means
 * nothing across two databases, so a "merge" would have to invent an identity
 * rule per table (is a sprint the same sprint if the name and dates match?) and
 * would silently produce wrong capacity and burndown numbers when it guessed
 * wrong. Wipe-and-load has no such failure mode.
 *
 * The whole thing runs in ONE transaction, so a payload that fails halfway —
 * bad row, FK violation, disk full — leaves the database exactly as it was.
 * A half-populated planning database is worse than no import at all.
 */

/** Postgres refuses more than 65535 bind parameters in one statement. */
const MAX_BIND_PARAMS = 60_000;
/** Also cap by row count, to keep a single statement's SQL text sane. */
const MAX_ROWS_PER_INSERT = 500;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Structural validation of the payload. Everything that can be wrong with the
 * *file* is caught here, before a single row is touched, and surfaces as
 * `ExportFormatError` (→ HTTP 400) rather than a database error (→ 500).
 */
export function validateEnvelope(payload: unknown): ExportEnvelope {
  if (!isPlainObject(payload)) {
    throw new ExportFormatError("Import payload must be a JSON object.");
  }
  const version = payload.schema_version;
  if (typeof version !== "number") {
    throw new ExportFormatError(
      'Import payload is missing a numeric "schema_version" — it does not look ' +
        "like an OpalTakt export.",
    );
  }
  if (version !== EXPORT_SCHEMA_VERSION) {
    throw new ExportFormatError(
      `Unsupported export schema_version ${version}. This build reads only ` +
        `version ${EXPORT_SCHEMA_VERSION}. Re-export from a matching version of ` +
        `the app, or upgrade this one.`,
    );
  }
  if (!isPlainObject(payload.tables)) {
    throw new ExportFormatError('Import payload is missing its "tables" object.');
  }

  for (const [name, rows] of Object.entries(payload.tables)) {
    if (IGNORABLE_TABLE_NAMES.has(name)) continue;
    if (!KNOWN_TABLE_NAMES.has(name)) {
      throw new ExportFormatError(
        `Import payload contains unknown table "${name}". Known tables: ` +
          `${[...KNOWN_TABLE_NAMES].sort().join(", ")}.`,
      );
    }
    if (!Array.isArray(rows)) {
      throw new ExportFormatError(`tables.${name} must be an array of rows.`);
    }
    for (const [i, row] of rows.entries()) {
      if (!isPlainObject(row)) {
        throw new ExportFormatError(`tables.${name}[${i}] must be an object.`);
      }
    }
  }
  return payload as unknown as ExportEnvelope;
}

/** Envelope row (snake_case, parsed JSON) → Drizzle insert values (camelCase). */
function decodeRow(
  tableName: string,
  table: PgTable,
  row: ExportRow,
  rowIndex: number,
): Record<string, unknown> {
  const byDbName = dbNameToTsName(table);
  const values: Record<string, unknown> = {};

  for (const [dbName, raw] of Object.entries(row)) {
    const tsName = byDbName.get(dbName);
    if (!tsName) {
      throw new ExportFormatError(
        `tables.${tableName}[${rowIndex}] has unknown column "${dbName}". ` +
          `The export was probably produced by a different schema version.`,
      );
    }
    if (raw === null || raw === undefined) {
      values[tsName] = null;
      continue;
    }
    // jsonbText's TS-facing type is the serialized string; the envelope holds
    // the parsed value, so re-serialize on the way in. (A payload that already
    // carries a string is accepted too — hand-edited files happen.)
    values[tsName] = isJsonColumn(dbName) && typeof raw !== "string"
      ? JSON.stringify(raw)
      : raw;
  }
  return values;
}

/** Rows per INSERT statement, bounded by Postgres's bind-parameter ceiling. */
function chunkSize(table: PgTable): number {
  const columnCount = Object.keys(columnsOf(table)).length || 1;
  return Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_BIND_PARAMS / columnCount)));
}

async function countRowsIn(tx: OspDatabase, table: PgTable): Promise<number> {
  const [row] = (await tx
    .select({ c: sql<number>`cast(count(*) as int)` })
    .from(table as never)) as unknown as { c: number }[];
  return Number(row?.c ?? 0);
}

/**
 * Re-align a table's identity sequence with the ids we just inserted.
 *
 * ⚠️ NOT IN THE FROZEN CONTRACT, and the kind of omission that only bites in
 * production. Importing explicit `id` values into a `serial` column does not
 * advance the backing sequence — so the very next `INSERT` the app performs
 * reuses id 1 and dies on a duplicate-key violation. SQLite had no equivalent
 * problem (its `AUTOINCREMENT` reads `MAX(rowid)`), which is exactly why it is
 * easy to miss in a port.
 *
 * `pg_get_serial_sequence` returns NULL for the three non-serial primary keys
 * (`vault_meta.id`, `report_config.id`, `backlog_dismissal.wp_op_id` —
 * CONTRACTS §3c) and `setval(NULL, …)` is strict, so this is a safe no-op there.
 */
async function resetSequence(tx: OspDatabase, spec: ExportTableSpec): Promise<void> {
  const pk = orderColumnOf(spec.table);
  // Identifiers come from our own registry, never from the payload.
  await tx.execute(
    sql.raw(
      `SELECT setval(
         pg_get_serial_sequence('${spec.name}', '${pk.name}'),
         COALESCE((SELECT MAX("${pk.name}") FROM "${spec.name}"), 0) + 1,
         false
       )`,
    ),
  );
}

export interface ImportOptions {
  /**
   * Skip the cache-clearing step. Only for tests that assert on the FK
   * behaviour itself — production imports must clear the cache (see
   * `CACHE_TABLES_CLEARED_ON_IMPORT`).
   */
  keepCache?: boolean;
}

export async function importAll(
  db: OspDatabase,
  payload: unknown,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const envelope = validateEnvelope(payload);
  const carriesVault = Array.isArray(envelope.tables.vault_meta);

  const inserted: Record<string, number> = {};
  const deleted: Record<string, number> = {};

  await db.transaction(async (tx) => {
    const t = tx as unknown as OspDatabase;

    // ── 1. Wipe ────────────────────────────────────────────────────────────
    // Caches first (child → parent): they hold FKs into op_connection and
    // sync_run, which the next step deletes. See the long comment on
    // CACHE_TABLES_CLEARED_ON_IMPORT — this step is not in the frozen contract
    // and the wipe fails with a foreign-key violation without it.
    if (!options.keepCache) {
      for (const spec of CACHE_TABLES_CLEARED_ON_IMPORT) {
        deleted[spec.name] = await countRowsIn(t, spec.table);
        await t.delete(spec.table as never);
      }
    }

    // Included tables, children before parents.
    for (const spec of [...EXPORT_TABLES].reverse()) {
      // A credential-free export omits vault_meta entirely. Wiping it anyway
      // would destroy the target's KDF salt and verifier — i.e. lock the user
      // out of a vault whose passphrase they still know — for no reason. So
      // the vault is replaced only when the payload actually carries one.
      if (spec.credentialOnly && !carriesVault) continue;
      deleted[spec.name] = await countRowsIn(t, spec.table);
      await t.delete(spec.table as never);
    }

    // ── 2. Load ────────────────────────────────────────────────────────────
    for (const spec of EXPORT_TABLES) {
      const rows = envelope.tables[spec.name];
      // A credential-free payload omits vault_meta, and the wipe step left the
      // target's own vault in place. Report nothing for it rather than "0
      // inserted", which would read as "your vault was emptied".
      if (spec.credentialOnly && !Array.isArray(rows)) continue;
      if (!Array.isArray(rows) || rows.length === 0) {
        inserted[spec.name] = 0;
        await resetSequence(t, spec);
        continue;
      }
      const values = rows.map((row, i) => decodeRow(spec.name, spec.table, row, i));
      const size = chunkSize(spec.table);
      for (let i = 0; i < values.length; i += size) {
        await t.insert(spec.table as never).values(values.slice(i, i + size) as never);
      }
      inserted[spec.name] = values.length;
      await resetSequence(t, spec);
    }
  });

  return {
    mode: "replace",
    inserted,
    deleted,
    total_inserted: Object.values(inserted).reduce((a, b) => a + b, 0),
    included_credentials: carriesVault || envelope.includes_credentials === true,
    requires_resync: !options.keepCache,
  };
}
