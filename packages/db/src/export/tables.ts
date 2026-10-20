import { getTableColumns, type Column } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { schema } from "../schema";

/**
 * The export/import table registry (Increment 27, CONTRACTS §6).
 *
 * This file is the single place that decides *what* travels in a JSON export.
 * Both `exportAll()` and `importAll()` read it, and so does the SQLite→Postgres
 * migration script — so there is exactly one list to keep honest, not three.
 */

export interface ExportTableSpec {
  /** Physical table name — the key used in the envelope's `tables` map. */
  name: string;
  /** Drizzle table object, used for both reads and writes. */
  table: PgTable;
  /**
   * True for tables that only travel when `includeCredentials` is set
   * (`vault_meta` — KDF salt/params + passphrase verifier).
   */
  credentialOnly?: boolean;
}

/**
 * INCLUDED tables, in **foreign-key-safe insertion order** (parents first).
 * Deletion during a replace-import walks this list backwards.
 *
 * The list is exhaustive and matches CONTRACTS §6 literally: 20 unconditional
 * tables plus `vault_meta`, which rides along only with credentials.
 *
 * Everything here is *local, unrecoverable* state — planning decisions a human
 * made that exist nowhere else. Nothing here can be rebuilt from OpenProject,
 * which is precisely the criterion for inclusion.
 */
export const EXPORT_TABLES: readonly ExportTableSpec[] = [
  // ── no dependencies ──────────────────────────────────────────────────────
  { name: "op_connection", table: schema.opConnection as unknown as PgTable },
  { name: "vault_meta", table: schema.vaultMeta as unknown as PgTable, credentialOnly: true },
  { name: "team_member", table: schema.teamMember as unknown as PgTable },
  { name: "estimate_override", table: schema.estimateOverride as unknown as PgTable },
  { name: "done_rule", table: schema.doneRule as unknown as PgTable },
  { name: "report_config", table: schema.reportConfig as unknown as PgTable },
  { name: "backlog_dismissal", table: schema.backlogDismissal as unknown as PgTable },
  { name: "sprint", table: schema.sprint as unknown as PgTable },
  // ── → op_connection ──────────────────────────────────────────────────────
  { name: "project", table: schema.project as unknown as PgTable },
  { name: "user_name_alias", table: schema.userNameAlias as unknown as PgTable },
  { name: "import_selection", table: schema.importSelection as unknown as PgTable },
  // ── → sprint ─────────────────────────────────────────────────────────────
  { name: "sprint_item", table: schema.sprintItem as unknown as PgTable },
  { name: "ticket_baseline", table: schema.ticketBaseline as unknown as PgTable },
  { name: "burndown_snapshot", table: schema.burndownSnapshot as unknown as PgTable },
  { name: "sprint_closure_report", table: schema.sprintClosureReport as unknown as PgTable },
  { name: "capacity_edit_audit", table: schema.capacityEditAudit as unknown as PgTable },
  { name: "done_status_rule", table: schema.doneStatusRule as unknown as PgTable },
  { name: "remaining_status_rule", table: schema.remainingStatusRule as unknown as PgTable },
  { name: "sprint_update_run", table: schema.sprintUpdateRun as unknown as PgTable },
  // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2): a replace-on-refresh
  // report, not history — but still a local planning artefact OP can't hand
  // back (a re-fetch after import would need the roster + the run to have
  // happened again), so it round-trips like every other sprint-scoped table.
  { name: "off_sprint_time_entry", table: schema.offSprintTimeEntry as unknown as PgTable },
  // ── → sprint + team_member ───────────────────────────────────────────────
  { name: "sprint_member_capacity", table: schema.sprintMemberCapacity as unknown as PgTable },
  // ── → sprint + sprint_update_run ─────────────────────────────────────────
  { name: "ticket_changelog_entry", table: schema.ticketChangelogEntry as unknown as PgTable },
];

/**
 * EXCLUDED from the payload (CONTRACTS §6, confirmed decision §9.1): every one
 * of these is a cache of OpenProject state and is rebuilt by a single "Sync now".
 * Shipping ~137 work packages of `raw_json` would multiply the export size for
 * data the user can regenerate in seconds.
 */
export const EXCLUDED_TABLES = [
  "work_package_cache",
  "work_package_cache_staging",
  "sync_run",
] as const;

/**
 * ⚠️ NOT IN THE FROZEN CONTRACT — found while implementing, and load-bearing.
 *
 * A replace-import deletes every row of `op_connection`. Under SQLite that was
 * harmless because `PRAGMA foreign_keys` was only advisory in practice; under
 * Postgres the FKs are real, and three EXCLUDED tables point at rows we are
 * about to delete:
 *
 *   work_package_cache.connection_id          → op_connection.id
 *   work_package_cache_staging.connection_id  → op_connection.id
 *   work_package_cache_staging.sync_run_id    → sync_run.id
 *
 * So the import must clear these too, or the wipe fails with a foreign-key
 * violation. That is also the semantically correct outcome: a cache keyed to
 * the *old* connection ids is meaningless once the connections themselves are
 * replaced, and every row of it is re-syncable. Hence `requires_resync: true`
 * in the result, and the "run Sync now" prompt CONTRACTS §6 already calls for.
 *
 * Order is child → parent, i.e. the order they must be deleted in.
 */
export const CACHE_TABLES_CLEARED_ON_IMPORT: readonly ExportTableSpec[] = [
  { name: "work_package_cache_staging", table: schema.workPackageCacheStaging as unknown as PgTable },
  { name: "work_package_cache", table: schema.workPackageCache as unknown as PgTable },
  { name: "sync_run", table: schema.syncRun as unknown as PgTable },
];

/**
 * Token ciphertext on `op_connection`. Nulled out unless the export explicitly
 * asks for credentials (CONTRACTS §6, confirmed decision §9.2). `token_encrypted`
 * is the legacy pre-vault plaintext slot and is treated as a secret too — it is
 * null on any modern row, but an ancient database might still carry one.
 */
export const CREDENTIAL_COLUMNS = [
  "token_ct",
  "token_nonce",
  "token_tag",
  "token_encrypted",
] as const;

/** Every table name the envelope may legitimately contain. */
export const KNOWN_TABLE_NAMES: ReadonlySet<string> = new Set(
  EXPORT_TABLES.map((t) => t.name),
);

/** Table names we knowingly ignore if a hand-made payload contains them. */
export const IGNORABLE_TABLE_NAMES: ReadonlySet<string> = new Set(EXCLUDED_TABLES);

/**
 * A `*_json` column is a `jsonbText` column (CONTRACTS §3b). The suffix rule is
 * exact for this schema — all eight jsonb columns end in `_json`
 * (`kdf_params_json`, `raw_json` ×2, `changes_json`, `done_json`,
 * `not_done_json`, `version_change_json`, `reconstruction_gaps_json`,
 * `detail_json`) and no non-jsonb column does. Asserted by
 * `assertJsonSuffixRuleHolds()` below so a future column can't quietly break it.
 */
export function isJsonColumn(dbColumnName: string): boolean {
  return dbColumnName.endsWith("_json");
}

/** `{ tsPropertyName → Column }` for a table. */
export function columnsOf(table: PgTable): Record<string, Column> {
  return getTableColumns(table) as unknown as Record<string, Column>;
}

/** `{ dbColumnName → tsPropertyName }` for a table. */
export function dbNameToTsName(table: PgTable): Map<string, string> {
  const map = new Map<string, string>();
  for (const [tsName, col] of Object.entries(columnsOf(table))) {
    map.set(col.name, tsName);
  }
  return map;
}

/**
 * The column an export is ordered by, so two exports of the same database are
 * byte-comparable. Every table in this schema has a single-column primary key —
 * `id` everywhere except `backlog_dismissal`, which is keyed by `wp_op_id`.
 */
export function orderColumnOf(table: PgTable): Column {
  const cols = columnsOf(table);
  const primary = Object.values(cols).find((c) => c.primary);
  if (primary) return primary;
  const first = Object.values(cols)[0];
  if (!first) throw new Error("table has no columns");
  return first;
}

/**
 * Development-time guard for the `*_json` suffix rule `isJsonColumn()` relies
 * on: every column whose Drizzle SQL type is `jsonb` must end in `_json`, and
 * vice versa. Called by the export unit tests, not on the hot path.
 */
export function assertJsonSuffixRuleHolds(): void {
  const offenders: string[] = [];
  const all = [...EXPORT_TABLES, ...CACHE_TABLES_CLEARED_ON_IMPORT];
  for (const spec of all) {
    for (const col of Object.values(columnsOf(spec.table))) {
      const sqlType = col.getSQLType();
      const isJsonb = sqlType === "jsonb";
      if (isJsonb !== isJsonColumn(col.name)) {
        offenders.push(`${spec.name}.${col.name} (sql=${sqlType})`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `The "*_json means jsonb" rule the JSON export relies on is broken for: ` +
        `${offenders.join(", ")}. Either rename the column to end in "_json" or ` +
        `replace isJsonColumn() with an explicit allow-list.`,
    );
  }
}
