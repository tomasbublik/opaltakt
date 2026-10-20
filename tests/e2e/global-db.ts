import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  FORBIDDEN_DATABASES,
  assertThrowawayDatabase,
  judgeDatabaseUrl,
} from "../src/db-isolation";

const exec = promisify(execFile);

/**
 * ⛔ Throwaway-Postgres provisioning for the Playwright e2e run (Increment 27,
 * CONTRACTS §7).
 *
 * Unit tests run on in-process PGlite, but e2e drives the REAL stack, so it
 * runs against the REAL Postgres 17 server (PGlite is 16.4 — that skew is
 * precisely why e2e uses the real thing). Which means this file is the one
 * place in the test suite that opens a connection to a shared database server,
 * and therefore the one place that could repeat the Increment-11 disaster.
 *
 * Three rules it enforces, in this order:
 *   1. The database name is generated, never configured — `osp_e2e_<pid>`.
 *      Nothing a stray env var says can redirect it.
 *   2. Every URL is run through `assertThrowawayDatabase()` before it is used
 *      for ANYTHING, including the DROP.
 *   3. CREATE/DROP go through the `postgres` admin database and touch nothing
 *      else; the drop is name-checked a second time immediately before firing.
 *
 * `psql` is used rather than the `pg` driver on purpose: this runs inside
 * Playwright's config load, before any workspace package is guaranteed
 * resolvable, and shelling out keeps the config dependency-free.
 */

/** The server the e2e stack talks to (host/port/user only — never a database). */
const PG_HOST = process.env.OSP_E2E_PG_HOST ?? "127.0.0.1";
const PG_PORT = process.env.OSP_E2E_PG_PORT ?? "5432";
const PG_USER = process.env.OSP_E2E_PG_USER ?? os.userInfo().username;

/** Admin connection — used ONLY to CREATE/DROP the throwaway database. */
const ADMIN_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/postgres`;

/**
 * The throwaway database for this run. Derived from the pid so concurrent runs
 * cannot collide, and hard-coded in shape so it always satisfies the guardrail.
 *
 * ⚠️ It must be computed ONCE per run, not once per process. Playwright loads
 * this config module in the main process AND again in every worker, and those
 * have different pids — so a bare `osp_e2e_${process.pid}` gave the specs a
 * different database name than the one the API was actually booted against
 * (found the hard way: the spec queried `osp_e2e_64742` while the server used
 * `osp_e2e_64630`). Stashing it in the environment fixes that: the main process
 * computes it first, and workers — forked from it — inherit the value.
 */
export const E2E_DB_NAME = process.env.OSP_E2E_DB_NAME ?? `osp_e2e_${process.pid}`;
process.env.OSP_E2E_DB_NAME = E2E_DB_NAME;
export const E2E_DATABASE_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${E2E_DB_NAME}`;

// Fail at MODULE LOAD if the generated URL is somehow not throwaway-shaped —
// before Playwright has a chance to hand it to a server it spawns.
assertThrowawayDatabase(E2E_DATABASE_URL);

async function psql(url: string, sql: string): Promise<string> {
  // Guardrail: every single psql invocation is name-checked, admin URL included
  // (`postgres` is on the denylist for *data* access, so it is allow-listed
  // here explicitly and only here, for CREATE/DROP DATABASE).
  if (url !== ADMIN_URL) assertThrowawayDatabase(url);
  const { stdout } = await exec(
    "psql",
    [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql],
    { env: { ...process.env, PGCONNECT_TIMEOUT: "5" } },
  );
  return stdout.trim();
}

/**
 * The shell prefix that provisions the throwaway database, for use INSIDE the
 * API webServer command.
 *
 * ⚠️ Why not `globalSetup`? Playwright starts `webServer` entries BEFORE it
 * runs `globalSetup` — verified the hard way: the API booted, tried to migrate
 * `osp_e2e_<pid>`, and died with `3D000 database does not exist`. So creation
 * has to happen in the same command that boots the server, immediately before
 * it. (Teardown is fine in `globalTeardown`, which genuinely does run last.)
 *
 * The name is interpolated from `E2E_DB_NAME`, which is generated, not
 * configured, and was already validated by `assertThrowawayDatabase` at module
 * load — so no shell interpolation can point this at a real database.
 */
export function createE2eDatabaseCommand(): string {
  assertThrowawayDatabase(E2E_DATABASE_URL);
  // DROP first: a previous run killed with SIGKILL can leave the name behind.
  return (
    `psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -X -q ` +
    `-c 'DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)' ` +
    `-c 'CREATE DATABASE "${E2E_DB_NAME}"'`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Forbidden-database activity tripwire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the pre-run activity snapshot is parked so a spec can compare against
 * it after the whole stack has run. (globalSetup and the specs are separate
 * processes, so this has to go through the filesystem.)
 */
// Keyed on E2E_DB_NAME, NOT on process.pid — the main process and every
// Playwright worker have different pids, so a pid-keyed path would make the
// spec look for a snapshot file globalSetup never wrote (same trap as
// E2E_DB_NAME itself; see the note there).
export const FORBIDDEN_ACTIVITY_SNAPSHOT = path.join(
  os.tmpdir(),
  `osp-e2e-forbidden-activity-${E2E_DB_NAME}.json`,
);

export type ForbiddenActivity = Record<string, string>;

/**
 * Snapshot Postgres's own write counters for the databases we must never
 * touch. This is the Postgres-era successor to the "the real osp.sqlite mtime
 * is unchanged" tripwire: `pg_stat_database` is server-side METADATA, read
 * from the `postgres` admin database, so taking it never opens a session on
 * `osp` or another project's database — which is itself part of the invariant being proven.
 *
 * If the e2e run were ever misconfigured to point at a real database, the
 * transaction/tuple counters below would move, and the tz-db-isolation spec
 * fails loudly at the end of the run.
 */
export async function snapshotForbiddenActivity(): Promise<ForbiddenActivity> {
  const names = FORBIDDEN_DATABASES.filter((d) => d !== "postgres");
  const list = names.map((n) => `'${n}'`).join(",");
  const out = await psql(
    ADMIN_URL,
    `SELECT datname || '|' || numbackends || '|' || xact_commit || '|' ||
            tup_inserted || '|' || tup_updated || '|' || tup_deleted
       FROM pg_stat_database WHERE datname IN (${list}) ORDER BY datname`,
  );
  const snapshot: ForbiddenActivity = {};
  for (const line of out.split("\n").filter((l) => l.trim() !== "")) {
    const [name, ...rest] = line.split("|");
    if (name !== undefined) snapshot[name] = rest.join("|");
  }
  return snapshot;
}

export async function writeForbiddenActivitySnapshot(): Promise<void> {
  const snapshot = await snapshotForbiddenActivity();
  fs.writeFileSync(FORBIDDEN_ACTIVITY_SNAPSHOT, JSON.stringify(snapshot), "utf8");
}

export function readForbiddenActivitySnapshot(): ForbiddenActivity | null {
  try {
    return JSON.parse(
      fs.readFileSync(FORBIDDEN_ACTIVITY_SNAPSHOT, "utf8"),
    ) as ForbiddenActivity;
  } catch {
    return null;
  }
}

/** Drop the throwaway database. Never throws — teardown must not mask failures. */
export async function dropE2eDatabase(): Promise<void> {
  // Second, independent name check right before the destructive statement.
  const verdict = judgeDatabaseUrl(E2E_DATABASE_URL);
  if (!verdict.ok || verdict.database !== E2E_DB_NAME) {
    // eslint-disable-next-line no-console
    console.error(`[e2e] REFUSING to drop ${E2E_DB_NAME}: ${verdict.reason}`);
    return;
  }
  try {
    await psql(ADMIN_URL, `DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
    // eslint-disable-next-line no-console
    console.log(`[e2e] dropped throwaway database ${E2E_DB_NAME}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[e2e] could not drop ${E2E_DB_NAME} (leftover, harmless): ${String(err)}`);
  }
}
