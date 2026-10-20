/**
 * One-off SQLite → PostgreSQL data migration (Increment 27, CONTRACTS §5).
 *
 *   pnpm --filter @osp/api exec tsx scripts/migrate-sqlite-to-pg.ts \
 *     --sqlite apps/api/osp.sqlite
 *
 * (or just `scripts/migrate-sqlite-to-pg.sh --sqlite apps/api/osp.sqlite`)
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *  1. Takes a **consistent, WAL-safe snapshot** of the source database, without
 *     ever opening the original read-write (see snapshotSqlite below — this is
 *     the single most important step in the script).
 *  2. Reads every included table out of that snapshot and builds the same §6
 *     JSON envelope the HTTP export produces, applying the §3 type mapping.
 *  3. Loads it into `DATABASE_URL` with `importAll()` — the *same* code path as
 *     POST /api/data/import, so there is one loader to trust, not two.
 *  4. Prints a per-table row-count parity table with an explicit OK/FAIL
 *     verdict, plus deep spot-checks of sprints, baselines, changelog and
 *     capacity, and exits non-zero if anything disagrees.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *  - **Non-destructive to the source.** The original `.sqlite`, `-wal` and
 *    `-shm` files are only ever read (byte-copied). Nothing opens them for
 *    writing, so not even a WAL checkpoint can alter them.
 *  - **Idempotent.** `importAll()` is replace-mode: it truncates the target's
 *    tables and reloads. Running this twice produces the same database, never
 *    duplicated rows.
 *  - **Refuses protected targets.** `osp` (the user's real data) and OSP_FOREIGN_DATABASES
 *    (an unrelated project sharing the Postgres instance) are rejected unless
 *    `--i-know-what-im-doing` is passed. The real cut has to be a deliberate act.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Column } from "drizzle-orm";
import {
  CACHE_TABLES_CLEARED_ON_IMPORT,
  EXPORT_TABLES,
  columnsOf,
  exportAll,
  importAll,
  isJsonColumn,
  openDb,
  type ExportEnvelope,
  type ExportRow,
} from "../packages/db/src/index";

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Args {
  sqlitePath: string;
  skipSnapshot: boolean;
  dryRun: boolean;
  force: boolean;
  keepSnapshot: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sqlitePath: "",
    skipSnapshot: false,
    dryRun: false,
    force: false,
    keepSnapshot: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--sqlite":
        args.sqlitePath = argv[++i] ?? "";
        break;
      case "--skip-snapshot":
        // The given file is ALREADY a consistent single-file snapshot.
        args.skipSnapshot = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--keep-snapshot":
        args.keepSnapshot = true;
        break;
      case "--i-know-what-im-doing":
        args.force = true;
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument "${a}". Try --help.`);
    }
  }
  if (!args.sqlitePath) fail("--sqlite <path-to-osp.sqlite> is required.");
  // The .sh wrapper runs us via `pnpm --filter @osp/api exec`, which sets
  // cwd=apps/api — so a relative --sqlite must be resolved against the
  // directory the human actually typed it in, not ours.
  args.sqlitePath = resolve(process.env.OSP_INVOKE_CWD || process.cwd(), args.sqlitePath);
  return args;
}

function printUsage(): void {
  process.stdout.write(
    `
migrate-sqlite-to-pg — one-off SQLite → PostgreSQL data migration

  DATABASE_URL=postgres://user@localhost:5432/osp_test_1 \\
    scripts/migrate-sqlite-to-pg.sh --sqlite apps/api/osp.sqlite

Options
  --sqlite <path>            Source SQLite database (read-only; never modified).
  --skip-snapshot            The file is already a consistent single-file
                             snapshot (no -wal alongside). Skips the copy step.
  --dry-run                  Build and validate the payload, print the source
                             row counts, and write NOTHING to Postgres.
  --keep-snapshot            Leave the temporary snapshot on disk (prints path).
  --i-know-what-im-doing     Allow a protected target database (osp, OSP_FOREIGN_DATABASES).
  -h, --help                 This text.

Environment
  DATABASE_URL               Target Postgres. Required (no default, by design).
`.trimStart(),
  );
}

function fail(message: string): never {
  process.stderr.write(`\n✖ ${message}\n\n`);
  process.exit(2);
}

// ── Target-database guard ────────────────────────────────────────────────────

/**
 * Databases an automated script must never write to. `osp` is the user's real
 * planning data; OSP_FOREIGN_DATABASES (env, comma-separated) belong to entirely
 * unrelated projects that share the same Postgres instance. This guard is the direct descendant of the
 * Increment-11 incident, where an agent with no explicit target destroyed a
 * user's entire sprint history.
 */
const PROTECTED_DATABASES = new Set([
  "osp",
  "postgres",
  "template0",
  "template1",
  ...(process.env.OSP_FOREIGN_DATABASES ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== ""),
]);

export function databaseNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    fail(`DATABASE_URL is not a valid connection URL: ${url}`);
  }
}

function resolveTarget(force: boolean): { url: string; dbName: string } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail(
      "DATABASE_URL is not set — refusing to run. There is no default target " +
        "(CONTRACTS §1): a script silently picking a database is exactly what " +
        "destroyed a user's data in Increment 11.",
    );
  }
  const dbName = databaseNameFromUrl(url);
  if (!dbName) fail("DATABASE_URL has no database name in its path.");
  if (PROTECTED_DATABASES.has(dbName) && !force) {
    fail(
      `Refusing to write to the protected database "${dbName}".\n` +
        `  • "osp" is the user's real planning data.\n` +
        `  • OSP_FOREIGN_DATABASES belong to different projects on the same server.\n` +
        `  • "postgres"/"template*" are administrative.\n\n` +
        `  This script REPLACES every row in the target. If you genuinely mean\n` +
        `  to perform the real cut into "${dbName}", take a backup first\n` +
        `  (scripts/backup.sh) and re-run with --i-know-what-im-doing.`,
    );
  }
  return { url, dbName };
}

// ── WAL-safe snapshot ────────────────────────────────────────────────────────

/**
 * ⚠️ THE TRAP THIS FUNCTION EXISTS FOR (CONTRACTS §5).
 *
 * The live database is a 1.9 MB `osp.sqlite` with a **5.1 MB `osp.sqlite-wal`**
 * beside it. A plain `cp osp.sqlite copy.sqlite` produces a file that opens
 * cleanly, passes `PRAGMA integrity_check`, and reports *the same row counts* —
 * while silently serving **stale row contents**, because every committed change
 * still sitting in the WAL is missing. Measured on the real database: a naive
 * copy showed sprint #4 as `status='planning'`, `is_locked=0`, `completed_hours=NULL`
 * when it is in fact `closed`, locked, 84.0 h. Row counts matched exactly, so a
 * count-only parity check would have declared that migration a success.
 *
 * The fix is `.backup`, which checkpoints the WAL into one consistent file.
 *
 * We do NOT run `.backup` against the user's original, though: the sqlite3 CLI
 * opens it read-write and can checkpoint/truncate the WAL on close, i.e. modify
 * files we promised only to read. Instead we byte-copy all three files
 * (`.sqlite`, `-wal`, `-shm`) to a temp directory — the equivalence CONTRACTS §5
 * explicitly allows — and run `.backup` on the *copy*. The original is never
 * opened by SQLite at all.
 */
function snapshotSqlite(sourcePath: string): { snapshot: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "osp-migrate-"));
  const stagedMain = join(dir, basename(sourcePath));
  const snapshot = join(dir, "snapshot.sqlite");

  copyFileSync(sourcePath, stagedMain);
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${sourcePath}${suffix}`;
    if (!existsSync(side)) continue;
    copyFileSync(side, `${stagedMain}${suffix}`);
    if (suffix === "-wal") {
      const mb = (statSync(side).size / 1024 / 1024).toFixed(1);
      log(`  carried ${basename(side)} (${mb} MB) — the write-ahead log a plain cp would drop`);
    }
  }

  execFileSync("sqlite3", [stagedMain, `.backup '${snapshot}'`], { stdio: "pipe" });
  // `.backup` preserves WAL journal mode, and SQLite cannot open a WAL database
  // read-only without being able to create its -shm/-wal sidecars ("unable to
  // open database file (14)"). Switching the snapshot to a rollback journal
  // makes it a genuinely self-contained single file — which is the whole point
  // of taking it — so every later read can be `-readonly`.
  execFileSync("sqlite3", [snapshot, "PRAGMA journal_mode=DELETE;"], { stdio: "pipe" });
  return {
    snapshot,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Reading the snapshot ─────────────────────────────────────────────────────

/**
 * Query the snapshot through the `sqlite3` CLI in JSON mode.
 *
 * WHY the CLI and not a driver: `better-sqlite3` is being REMOVED from the
 * dependency graph by this very increment, and re-adding it — even as a
 * script-only dependency — would put a native, node-version-sensitive build
 * back into a repo that has just finished getting rid of it, purely to read one
 * file once. The `sqlite3` CLI ships with macOS (3.51 here), emits proper JSON
 * (`-json`), preserves SQLite's own type affinity in that JSON (integers as
 * numbers, REALs as numbers, NULL as null), and disappears the moment this
 * script has run. Zero new dependencies, zero native builds, zero lifetime.
 */
function sqliteJson(dbPath: string, sql: string): Record<string, unknown>[] {
  const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const trimmed = out.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as Record<string, unknown>[];
}

function sqliteCount(dbPath: string, table: string): number {
  const rows = sqliteJson(dbPath, `SELECT COUNT(*) AS c FROM "${table}"`);
  return Number(rows[0]?.c ?? 0);
}

function sqliteTableExists(dbPath: string, table: string): boolean {
  const rows = sqliteJson(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
  );
  return rows.length > 0;
}

// ── §3 type mapping, applied on the way out of SQLite ────────────────────────

/**
 * SQLite's `CURRENT_TIMESTAMP` default renders as `"YYYY-MM-DD HH:MM:SS"` — no
 * `T`, no zone — and it is **UTC**.
 *
 * ⚠️ REAL DATA HITS THIS, and the frozen contract does not mention it. The
 * user's `user_name_alias` rows carry exactly that shape (`2026-07-15 19:49:46`)
 * because they were written by the column default rather than by the app. Fed
 * to `isoTimestamp`'s `toDriver` unchanged, `new Date("2026-07-15 19:49:46")`
 * parses as **local** time — in CEST that is a silent two-hour shift
 * (`…T17:49:46Z`) applied to real timestamps, with nothing to flag it.
 *
 * So: recognise that exact shape and pin it to UTC before it reaches the driver.
 */
const SQLITE_DEFAULT_TS = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/;

export function normaliseSqliteTimestamp(value: string): string {
  const m = SQLITE_DEFAULT_TS.exec(value);
  if (!m) return value;
  return new Date(`${m[1]}T${m[2]}${m[3] ?? ""}Z`).toISOString();
}

type ColumnKind = "boolean" | "timestamp" | "json" | "plain";

function kindOf(col: Column): ColumnKind {
  if (isJsonColumn(col.name)) return "json";
  const sqlType = col.getSQLType();
  if (sqlType === "boolean") return "boolean";
  if (sqlType.startsWith("timestamp")) return "timestamp";
  return "plain";
}

function convert(
  tableName: string,
  colName: string,
  kind: ColumnKind,
  raw: unknown,
): unknown {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case "boolean":
      // SQLite stored these as INTEGER 0/1.
      return raw === 1 || raw === "1" || raw === true;
    case "timestamp":
      return typeof raw === "string" ? normaliseSqliteTimestamp(raw) : raw;
    case "json":
      if (typeof raw !== "string") return raw;
      try {
        return JSON.parse(raw);
      } catch (err) {
        fail(
          `${tableName}.${colName} does not hold valid JSON in the source ` +
            `database: ${(err as Error).message}`,
        );
      }
    // eslint-disable-next-line no-fallthrough
    default:
      return raw;
  }
}

interface BuildResult {
  envelope: ExportEnvelope;
  sourceCounts: Record<string, number>;
  warnings: string[];
}

/**
 * Read the snapshot and build a §6 envelope.
 *
 * Credentials are ALWAYS included here (unlike the default HTTP export): this
 * is the user moving their own database onto a new engine, and dropping
 * `vault_meta` plus the token ciphertext would leave them with a vault they
 * cannot open and connections they must re-authenticate by hand.
 */
function buildEnvelopeFromSqlite(dbPath: string): BuildResult {
  const tables: Record<string, ExportRow[]> = {};
  const sourceCounts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const spec of EXPORT_TABLES) {
    if (!sqliteTableExists(dbPath, spec.name)) {
      warnings.push(`table "${spec.name}" does not exist in the source database — imported empty`);
      tables[spec.name] = [];
      sourceCounts[spec.name] = 0;
      continue;
    }
    const cols = columnsOf(spec.table);
    const kinds = new Map<string, { ts: string; kind: ColumnKind }>();
    for (const [tsName, col] of Object.entries(cols)) {
      kinds.set(col.name, { ts: tsName, kind: kindOf(col) });
    }

    const rows = sqliteJson(dbPath, `SELECT * FROM "${spec.name}"`);
    sourceCounts[spec.name] = rows.length;

    const out: ExportRow[] = rows.map((row) => {
      const encoded: ExportRow = {};
      for (const [dbName, raw] of Object.entries(row)) {
        const meta = kinds.get(dbName);
        if (!meta) {
          // A column SQLite has and the Postgres schema does not. Dropping it is
          // correct (it no longer exists) but must never be silent.
          const key = `${spec.name}.${dbName}`;
          if (!warnings.some((w) => w.includes(key))) {
            warnings.push(`dropped source column ${key} — not present in the Postgres schema`);
          }
          continue;
        }
        encoded[dbName] = convert(spec.name, dbName, meta.kind, raw);
      }
      // Columns Postgres has and SQLite did not: leave them out entirely so the
      // column default applies, rather than forcing NULL into a NOT NULL column.
      for (const [dbName] of kinds) {
        if (!(dbName in row)) {
          const key = `${spec.name}.${dbName}`;
          if (!warnings.some((w) => w.includes(key))) {
            warnings.push(`source has no column ${key} — Postgres default will apply`);
          }
        }
      }
      return encoded;
    });

    tables[spec.name] = out;
  }

  // Excluded tables are still counted, so the parity report can say so out loud
  // instead of leaving a reader to wonder where they went.
  for (const spec of CACHE_TABLES_CLEARED_ON_IMPORT) {
    sourceCounts[spec.name] = sqliteTableExists(dbPath, spec.name)
      ? sqliteCount(dbPath, spec.name)
      : 0;
  }

  return {
    envelope: {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      source: { app: "op-sprint-planner", increment: 27 },
      includes_credentials: true,
      tables,
    },
    sourceCounts,
    warnings,
  };
}

// ── Verification ─────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

/** Tables CONTRACTS §5 names explicitly for value-level spot-checking. */
const SPOT_CHECK_TABLES = [
  "sprint",
  "ticket_baseline",
  "ticket_changelog_entry",
  "sprint_member_capacity",
];

/**
 * ⚠️ A REAL DIVERGENCE FROM THE FROZEN CONTRACT, found by this spot check.
 *
 * CONTRACTS §3a promises `isoTimestamp` round-trips a timestamp string
 * unchanged: `"2026-08-10T07:39:19.488Z"` in → identical string out. That holds
 * only when the input **already carries milliseconds**. `Date#toISOString()`
 * always emits three fractional digits, so a value stored without them comes
 * back re-rendered:
 *
 *     "2026-07-06T23:59:59Z"   →   "2026-07-06T23:59:59.000Z"
 *
 * The user's real data is full of these — every retro-reconstructed
 * `sprint.activated_at` and `ticket_baseline.captured_at` is an exact
 * `23:59:59Z` end-of-day marker. Same instant (`activated_at = timestamptz
 * '2026-07-06T23:59:59Z'` is true in Postgres), still valid ISO-8601, still
 * passes `IsoDateTime` — but *not* the byte-identical string §3a describes.
 *
 * So timestamp columns are compared as **instants**, and the count of
 * re-rendered values is reported rather than hidden: it is a real, if benign,
 * observable change, and anything asserting on these strings byte-for-byte
 * needs to know.
 */
function timestampColumnsOf(tableName: string): Set<string> {
  const spec = EXPORT_TABLES.find((t) => t.name === tableName);
  if (!spec) return new Set();
  const out = new Set<string>();
  for (const col of Object.values(columnsOf(spec.table))) {
    if (kindOf(col) === "timestamp") out.add(col.name);
  }
  return out;
}

interface RowComparison {
  equal: boolean;
  /** Columns that differ only in ISO rendering (same instant). */
  rerendered: string[];
  /** Columns that genuinely disagree. */
  differing: string[];
}

function compareRow(
  want: ExportRow | undefined,
  got: ExportRow | undefined,
  timestampCols: Set<string>,
): RowComparison {
  if (!want || !got) {
    return { equal: false, rerendered: [], differing: ["<missing row>"] };
  }
  const rerendered: string[] = [];
  const differing: string[] = [];
  for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
    const a = want[key];
    const b = got[key];
    if (deepEqual(a, b)) continue;
    if (
      timestampCols.has(key) &&
      typeof a === "string" &&
      typeof b === "string" &&
      Date.parse(a) === Date.parse(b) &&
      !Number.isNaN(Date.parse(a))
    ) {
      rerendered.push(key);
      continue;
    }
    differing.push(key);
  }
  return { equal: differing.length === 0, rerendered, differing };
}

function log(line = ""): void {
  process.stdout.write(`${line}\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Target guard FIRST, before anything else can fail for a lesser reason: the
  // one message the operator must never miss is "you are pointing at the real
  // database". A "no such file" complaining about the source would bury it.
  const { url, dbName } = args.dryRun
    ? { url: process.env.DATABASE_URL ?? "", dbName: "(dry run)" }
    : resolveTarget(args.force);
  if (!existsSync(args.sqlitePath)) fail(`No such SQLite file: ${args.sqlitePath}`);

  log("");
  log("═══ SQLite → PostgreSQL migration ═══════════════════════════════════════");
  log(`  source : ${args.sqlitePath}`);
  log(`  target : ${args.dryRun ? "(dry run — nothing will be written)" : dbName}`);
  log("");

  // 1. WAL-safe snapshot.
  let snapshotPath = args.sqlitePath;
  let cleanup = () => {};
  if (!args.skipSnapshot) {
    log("→ taking a consistent WAL-safe snapshot (the original is only read)…");
    const snap = snapshotSqlite(args.sqlitePath);
    snapshotPath = snap.snapshot;
    cleanup = args.keepSnapshot ? () => log(`  snapshot kept at ${snap.snapshot}`) : snap.cleanup;
    log(`  snapshot: ${snapshotPath}`);
    log("");
  }

  try {
    // 2. Read + map.
    log("→ reading the snapshot and applying the §3 type mapping…");
    const { envelope, sourceCounts, warnings } = buildEnvelopeFromSqlite(snapshotPath);
    const totalSource = Object.values(envelope.tables).reduce((s, r) => s + r.length, 0);
    log(`  ${Object.keys(envelope.tables).length} tables, ${totalSource} rows`);
    for (const w of warnings) log(`  ⚠ ${w}`);
    log("");

    if (args.dryRun) {
      printParity(sourceCounts, null);
      log("Dry run — nothing was written to Postgres.");
      return;
    }

    // 3. Load, reusing the HTTP import path verbatim.
    log("→ opening the target and running migrations…");
    const handle = await openDb({ url });
    try {
      log("→ importing (replace mode, single transaction)…");
      const result = await importAll(handle.db, envelope);
      log(`  inserted ${result.total_inserted} rows`);
      log("");

      // 4. Verify.
      const after = await exportAll(handle.db, { includeCredentials: true });
      const targetCounts: Record<string, number> = {};
      for (const [name, rows] of Object.entries(after.tables)) targetCounts[name] = rows.length;
      for (const spec of CACHE_TABLES_CLEARED_ON_IMPORT) targetCounts[spec.name] = 0;

      const countsOk = printParity(sourceCounts, targetCounts);
      const spotOk = printSpotChecks(envelope, after);

      log("");
      if (countsOk && spotOk) {
        log("═══ PARITY OK ═══════════════════════════════════════════════════════════");
        log("Every included table matches on row count AND on row content.");
        log('Run "Sync now" in the app to repopulate the work-package cache from OP.');
      } else {
        log("═══ PARITY FAIL ═════════════════════════════════════════════════════════");
        process.exitCode = 1;
      }
    } finally {
      await handle.close();
    }
  } finally {
    cleanup();
  }
}

function printParity(
  source: Record<string, number>,
  target: Record<string, number> | null,
): boolean {
  let ok = true;
  log("── Row-count parity ─────────────────────────────────────────────────────");
  log(
    `${"table".padEnd(30)}${"sqlite".padStart(9)}${"postgres".padStart(10)}   verdict`,
  );
  for (const spec of EXPORT_TABLES) {
    const s = source[spec.name] ?? 0;
    const t = target ? (target[spec.name] ?? 0) : null;
    const verdict = t === null ? "—" : s === t ? "OK" : "FAIL";
    if (verdict === "FAIL") ok = false;
    log(
      `${spec.name.padEnd(30)}${String(s).padStart(9)}${String(t ?? "—").padStart(10)}   ${verdict}`,
    );
  }
  for (const spec of CACHE_TABLES_CLEARED_ON_IMPORT) {
    const s = source[spec.name] ?? 0;
    log(
      `${spec.name.padEnd(30)}${String(s).padStart(9)}${String(target ? 0 : "—").padStart(10)}   EXCLUDED (re-syncable from OP)`,
    );
  }
  return ok;
}

function printSpotChecks(expected: ExportEnvelope, actual: ExportEnvelope): boolean {
  let ok = true;
  log("");
  log("── Value-level spot checks (CONTRACTS §5) ───────────────────────────────");
  for (const name of SPOT_CHECK_TABLES) {
    const want = expected.tables[name] ?? [];
    const got = actual.tables[name] ?? [];
    const tsCols = timestampColumnsOf(name);
    const mismatches: string[] = [];
    const rerenderedCols = new Set<string>();
    let rerenderedValues = 0;

    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const cmp = compareRow(want[i], got[i], tsCols);
      rerenderedValues += cmp.rerendered.length;
      for (const c of cmp.rerendered) rerenderedCols.add(c);
      if (!cmp.equal) {
        mismatches.push(
          `    row ${i} differs on [${cmp.differing.join(", ")}]\n` +
            `      sqlite   ${JSON.stringify(want[i])}\n` +
            `      postgres ${JSON.stringify(got[i])}`,
        );
      }
    }

    const note =
      rerenderedValues > 0
        ? `   (${rerenderedValues} timestamp value(s) in ${[...rerenderedCols].join("/")} ` +
          `re-rendered .000Z — same instant)`
        : "";

    if (mismatches.length === 0) {
      log(`${name.padEnd(30)}${String(want.length).padStart(6)} rows   IDENTICAL${note}`);
    } else {
      ok = false;
      log(`${name.padEnd(30)}${String(mismatches.length).padStart(6)} mismatches   FAIL${note}`);
      for (const m of mismatches.slice(0, 5)) log(m);
    }
  }
  return ok;
}

main().catch((err) => {
  process.stderr.write(`\n✖ migration failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
