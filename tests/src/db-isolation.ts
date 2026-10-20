/**
 * ⛔ THE DATABASE ISOLATION GUARDRAIL — Postgres edition (Increment 27).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS. Read the story before you edit anything in it.
 * ══════════════════════════════════════════════════════════════════════════
 * During Increment 11 a background agent booted `apps/api` with NEITHER an
 * explicit DB path NOR an explicit PORT. The server silently fell back to the
 * user's REAL database (`apps/api/osp.sqlite`), and while live-testing the new
 * "Delete sprint" feature it PERMANENTLY DESTROYED every sprint the user had:
 * baselines, changelog, burndown, capacity, closure. There was no undo and no
 * backup. OpenProject itself was never touched (this app is GET-only to OP by
 * a separate invariant) — the loss was purely local planning data.
 *
 * Increment 27 replaced SQLite with Postgres. The storage engine changed; the
 * failure mode did NOT. It actually got slightly worse in one respect: under
 * SQLite a wrong path produced a *new empty file*, whereas under Postgres a
 * wrong `DATABASE_URL` lands you inside an *existing populated database* — the
 * user's real `osp`, or a database belonging to an entirely unrelated
 * project sharing the same server. A stray `DELETE`/migration there is
 * cross-project data loss.
 *
 * So this module is the codified memory of that incident. It answers exactly
 * one question, mechanically and paranoidly:
 *
 *      "Is this connection string SAFE for an automated test to destroy?"
 *
 * The policy is DENY-BY-DEFAULT — a URL is unsafe unless its database name
 * positively matches a throwaway shape. That direction matters: a blocklist
 * alone would happily let a typo (`osp_prod`, `ospx`, a bare host with no
 * database at all) through, and "we forgot to blocklist that one" is precisely
 * how the original incident happened.
 *
 * ── DESIGN RULES (do not weaken any of these) ──────────────────────────────
 *  1. Deny by default. Unknown / unparseable / empty ⇒ REJECT.
 *  2. On top of the allowlist, a hard-coded EXPLICIT denylist for the names we
 *     know are catastrophic (`osp`, other projects' databases listed in
 *     `OSP_FOREIGN_DATABASES`) and for the admin databases.
 *     Redundant on purpose: two independent reasons to say no.
 *  3. Case-insensitive, whitespace-trimmed. Postgres identifiers are folded to
 *     lower case, and `OSP` must not sneak past a case-sensitive compare.
 *  4. No network access, no side effects. This is pure string logic so it can
 *     run inside a `beforeAll` before anything has connected to anything.
 *  5. It must be impossible to "pass" by supplying a URL that names no
 *     database at all (`postgres://localhost:5432`) — that resolves, server
 *     side, to a database named after the OS user, which on this machine is a
 *     real, populated one.
 *
 * ── WHAT COUNTS AS THROWAWAY ───────────────────────────────────────────────
 *  • PGlite (in-process, `pglite:` / `memory:` / no server at all) — the
 *    replacement for SQLite's `:memory:`. Cannot reach a shared server, so it
 *    is safe by construction.
 *  • A Postgres database named `osp_test_*`, `osp_e2e_*` or `osp_smoke_*`
 *    (CONTRACTS §1). Anything else is treated as somebody's real data.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/**
 * Databases of OTHER projects that share the same Postgres server. They are
 * machine-specific, so they live in the untracked `.env.local` at the repo root
 * (`OSP_FOREIGN_DATABASES=name1,name2`) or in the environment — never in the
 * source. Only that one key is read from `.env.local`: loading the whole file
 * would also import the developer's personal `DATABASE_URL`, which is exactly
 * what an automated run must never see.
 */
function readForeignDatabases(): string[] {
  let raw = process.env.OSP_FOREIGN_DATABASES;
  if (raw === undefined) {
    const envLocal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env.local");
    try {
      raw = parseEnv(fs.readFileSync(envLocal, "utf8")).OSP_FOREIGN_DATABASES;
    } catch {
      raw = undefined; // no .env.local — nothing extra to protect
    }
  }
  return (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
}

/** Other projects' databases on this server (see readForeignDatabases). */
export const FOREIGN_DATABASES: readonly string[] = readForeignDatabases();

/** Databases that must NEVER be opened by a test, for any reason. */
export const FORBIDDEN_DATABASES: readonly string[] = [
  "osp", // the user's REAL planning data — the Increment-11 victim
  "postgres", // admin DB: connect only to CREATE/DROP a throwaway
  "template0",
  "template1",
  os.userInfo().username.toLowerCase(), // the server's default DB when POSTGRES_DB is unset — real data
  ...FOREIGN_DATABASES, // other projects on the same server
];

/**
 * The only database-name shapes an automated run may create, write and drop.
 * Deliberately anchored at both ends: `osp_test` (no suffix), `xosp_test_1`
 * and `osp_test_1_real` must all be judged on their full name, never on a
 * substring match.
 */
export const THROWAWAY_DB_PATTERN = /^osp_(?:test|e2e|smoke)_[a-z0-9_]+$/;

/** In-process PGlite — no server, nothing shared, safe by construction. */
export function isPgliteUrl(url: string | undefined | null): boolean {
  if (url === undefined || url === null) return false;
  const u = url.trim().toLowerCase();
  return u === "pglite" || u.startsWith("pglite:") || u.startsWith("memory:");
}

/**
 * Extract the database name from a Postgres URL. Returns `null` when the URL
 * is unparseable OR names no database — both of which are REJECTED by
 * `assertThrowawayDatabase`, per design rule 5.
 */
export function databaseNameFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // `new URL("postgres://h/db").pathname` === "/db"; a bare host gives "" or "/".
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, "")).trim();
  return name === "" ? null : name.toLowerCase();
}

export interface IsolationVerdict {
  ok: boolean;
  /** Human-readable reason, always populated (also on success, for logging). */
  reason: string;
  /** Resolved database name, or null for PGlite / unparseable. */
  database: string | null;
}

/** Pure, side-effect-free verdict on a connection string. */
export function judgeDatabaseUrl(
  url: string | undefined | null,
  forbidden: readonly string[] = FORBIDDEN_DATABASES,
): IsolationVerdict {
  if (url === undefined || url === null || url.trim() === "") {
    return {
      ok: false,
      database: null,
      reason:
        "DATABASE_URL is empty/unset. There is NO default — an implicit fallback " +
        "is exactly what destroyed the user's data in Increment 11.",
    };
  }
  if (isPgliteUrl(url)) {
    return { ok: true, database: null, reason: "in-process PGlite — no shared server" };
  }
  const scheme = url.trim().toLowerCase();
  if (!scheme.startsWith("postgres://") && !scheme.startsWith("postgresql://")) {
    return {
      ok: false,
      database: null,
      reason: `unrecognised connection string scheme: ${JSON.stringify(url)}`,
    };
  }
  const database = databaseNameFromUrl(url);
  if (database === null) {
    return {
      ok: false,
      database: null,
      reason:
        "the URL names no database. Postgres would then connect to a database " +
        "named after the OS user — a real, populated one on this machine.",
    };
  }
  if (forbidden.includes(database)) {
    return {
      ok: false,
      database,
      reason:
        `database ${JSON.stringify(database)} is on the EXPLICIT denylist. ` +
        "It holds real data belonging to the user or to another project.",
    };
  }
  if (!THROWAWAY_DB_PATTERN.test(database)) {
    return {
      ok: false,
      database,
      reason:
        `database ${JSON.stringify(database)} is not throwaway-shaped. ` +
        `Automated runs may only touch ${THROWAWAY_DB_PATTERN} (CONTRACTS §1).`,
    };
  }
  return { ok: true, database, reason: `throwaway database ${JSON.stringify(database)}` };
}

/**
 * Throw unless `url` is safe for a test to create/populate/DROP.
 * Call this at every point a test is about to hand a connection string to
 * `openDb()`, to a spawned API server, or to `psql`.
 */
export function assertThrowawayDatabase(url: string | undefined | null): void {
  const verdict = judgeDatabaseUrl(url);
  if (verdict.ok) return;
  throw new Error(
    "⛔ REFUSING to run against a non-throwaway database.\n" +
      `   URL      : ${url === undefined ? "<unset>" : JSON.stringify(url)}\n` +
      `   Database : ${verdict.database ?? "<none>"}\n` +
      `   Reason   : ${verdict.reason}\n` +
      "   In Increment 11 an agent booted this app against the user's real DB " +
      "and permanently destroyed every sprint. Use a throwaway " +
      "(osp_test_* / osp_e2e_* / osp_smoke_*) or in-process PGlite.",
  );
}

/** Convenience for tests/tools that need a fresh, uniquely-named throwaway. */
export function throwawayDatabaseName(prefix: "test" | "e2e" | "smoke" = "test"): string {
  const unique = `${process.pid}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return `osp_${prefix}_${unique}`.toLowerCase();
}
