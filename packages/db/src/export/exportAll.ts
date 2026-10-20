import type { PgTable } from "drizzle-orm/pg-core";
import type { OspDatabase } from "../repos";
import {
  CREDENTIAL_COLUMNS,
  EXPORT_TABLES,
  columnsOf,
  isJsonColumn,
  orderColumnOf,
} from "./tables";
import {
  EXPORT_SCHEMA_VERSION,
  type ExportEnvelope,
  type ExportRow,
} from "./types";

/**
 * Logical, engine-agnostic export of everything the app knows that OpenProject
 * does not (Increment 27, CONTRACTS §6).
 *
 * "Engine-agnostic" is meant literally: this reads through Drizzle table objects
 * and the §3 custom column types, never through raw SQL. So the values it emits
 * are the *TypeScript-facing* shapes — ISO-8601 strings for timestamps,
 * `true`/`false` for booleans, plain `YYYY-MM-DD` for dates, real numbers for
 * `double precision` — regardless of what the driver hands back underneath.
 * That is what makes an export taken from Postgres and one taken from PGlite
 * (or, via `scripts/migrate-sqlite-to-pg.ts`, from the old SQLite file)
 * interchangeable.
 */

export interface ExportOptions {
  /**
   * Carry `vault_meta` and the `op_connection` token ciphertext (CONTRACTS §6,
   * confirmed decision §9.2). **Default false**, because the default export is
   * meant to be safe to hand to someone; a credentialed one is secret material
   * whose only protection is the vault passphrase, which the importing side
   * must then also know.
   */
  includeCredentials?: boolean;
  /** Clock override, for deterministic tests. */
  now?: () => Date;
}

/**
 * Convert one database row (Drizzle TS-facing values, camelCase keys) into an
 * envelope row (snake_case keys, JSON columns parsed).
 */
function encodeRow(
  tableName: string,
  table: PgTable,
  row: Record<string, unknown>,
  scrubCredentials: boolean,
): ExportRow {
  const out: ExportRow = {};
  for (const [tsName, col] of Object.entries(columnsOf(table))) {
    const dbName = col.name;
    let value = row[tsName];

    if (scrubCredentials && (CREDENTIAL_COLUMNS as readonly string[]).includes(dbName)) {
      // Emitted as an explicit null rather than omitted, so the shape of a
      // credential-free export is identical to a credentialed one — a consumer
      // never has to distinguish "absent" from "withheld".
      out[dbName] = null;
      continue;
    }

    if (value !== null && value !== undefined && isJsonColumn(dbName)) {
      // jsonbText hands us the serialized string; the envelope stores the
      // parsed value so the export is readable and diffable rather than a wall
      // of backslash-escaped JSON-inside-JSON.
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch (err) {
          throw new Error(
            `${tableName}.${dbName} does not contain valid JSON ` +
              `(row id=${String(row.id ?? "?")}): ${(err as Error).message}`,
          );
        }
      }
    }

    out[dbName] = value ?? null;
  }
  return out;
}

/**
 * Read every included table and build the versioned envelope.
 *
 * Tables come out in foreign-key-safe order (see `EXPORT_TABLES`), and rows
 * within a table are ordered by primary key, so exporting the same database
 * twice yields byte-identical JSON — which is what makes an export usable as a
 * diffable backup and as the round-trip fixture the migration script verifies
 * itself against.
 */
export async function exportAll(
  db: OspDatabase,
  options: ExportOptions = {},
): Promise<ExportEnvelope> {
  const includeCredentials = options.includeCredentials ?? false;
  const now = options.now ?? (() => new Date());

  const tables: Record<string, ExportRow[]> = {};

  for (const spec of EXPORT_TABLES) {
    if (spec.credentialOnly && !includeCredentials) {
      // Omitted entirely, not emitted empty: an absent `vault_meta` is the
      // signal to importAll that it must leave the target's existing vault
      // alone rather than wiping it (see importAll's wipe step).
      continue;
    }
    const rows = (await db
      .select()
      .from(spec.table as never)
      .orderBy(orderColumnOf(spec.table) as never)) as unknown as Record<string, unknown>[];

    const scrub = spec.name === "op_connection" && !includeCredentials;
    tables[spec.name] = rows.map((r) => encodeRow(spec.name, spec.table, r, scrub));
  }

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: now().toISOString(),
    source: { app: "op-sprint-planner", increment: 27 },
    includes_credentials: includeCredentials,
    tables,
  };
}

/** Total row count across an envelope — handy for logs and the HTTP response. */
export function countRows(envelope: ExportEnvelope): number {
  return Object.values(envelope.tables).reduce((sum, rows) => sum + rows.length, 0);
}
