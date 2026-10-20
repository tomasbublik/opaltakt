import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import {
  assertThrowawayDatabase,
  judgeDatabaseUrl,
  throwawayDatabaseName,
} from "./db-isolation";

const exec = promisify(execFile);

/**
 * ⛔ Throwaway REAL-Postgres databases for the handful of vitest tests that
 * cannot run on PGlite (Increment 27, CONTRACTS §7).
 *
 * The default engine for unit/integration tests is in-process PGlite — no
 * server, no ports, nothing shared, safe by construction. A few tests, though,
 * are specifically ABOUT storage outliving the process:
 *
 *   • the vault restart proof (boot app #1, close it, boot app #2 over the same
 *     storage, show the token still decrypts) — PGlite dies with the process;
 *   • the boot-time orphaned-`sync_run` recovery proof, which must seed a stale
 *     row from one handle and recover it from an independently-opened one;
 *   • the "no plaintext at rest" proof, which reads the persisted bytes back
 *     via `pg_dump` and greps them.
 *
 * Those get a database of their own here. Everything about this module is
 * paranoid on purpose — it is the only part of the vitest suite that can reach
 * a shared server:
 *
 *   1. Names are GENERATED (`osp_test_<pid>_<random>`), never configured. No
 *      env var can redirect a test onto a real database.
 *   2. Every URL passes `assertThrowawayDatabase()` before use, and the DROP
 *      re-checks the name independently, immediately before firing.
 *   3. `psql` is shelled out to rather than adding a driver dependency, and
 *      only ever against the `postgres` admin database for CREATE/DROP.
 *   4. If the server is unreachable the helpers report it instead of throwing,
 *      so a developer without Docker running gets a clear SKIP rather than a
 *      wall of red — the PGlite-based bulk of the suite still runs.
 */

const PG_HOST = process.env.OSP_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = process.env.OSP_TEST_PG_PORT ?? "5432";
const PG_USER = process.env.OSP_TEST_PG_USER ?? os.userInfo().username;

/** Admin connection — used ONLY to CREATE/DROP a throwaway database. */
const ADMIN_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/postgres`;

async function psqlAdmin(sql: string): Promise<string> {
  const { stdout } = await exec(
    "psql",
    [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-t", "-A", "-c", sql],
    { env: { ...process.env, PGCONNECT_TIMEOUT: "5" } },
  );
  return stdout.trim();
}

let availability: boolean | null = null;

/**
 * Is the real Postgres server reachable? Cached per process. Tests that need a
 * real database should `if (!(await pgAvailable())) return;` with a
 * `console.warn`, so the suite degrades to a visible skip rather than a
 * failure on a machine where Docker is not running.
 */
export async function pgAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    await psqlAdmin("select 1");
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

export interface ThrowawayDb {
  name: string;
  url: string;
  /** Drop the database. Idempotent; never throws. */
  drop(): Promise<void>;
}

/** Create a freshly-named, empty throwaway database on the real server. */
export async function createThrowawayDb(): Promise<ThrowawayDb> {
  const name = throwawayDatabaseName("test");
  const url = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${name}`;
  // Guardrail: prove the generated name is throwaway-shaped BEFORE creating it,
  // so `drop()` can never be handed something it must refuse.
  assertThrowawayDatabase(url);
  await psqlAdmin(`CREATE DATABASE "${name}"`);
  let dropped = false;
  return {
    name,
    url,
    drop: async () => {
      if (dropped) return;
      dropped = true;
      // Independent second check immediately before the destructive statement.
      const verdict = judgeDatabaseUrl(url);
      if (!verdict.ok || verdict.database !== name) {
        // eslint-disable-next-line no-console
        console.error(`[pg-throwaway] REFUSING to drop ${name}: ${verdict.reason}`);
        return;
      }
      try {
        await psqlAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[pg-throwaway] could not drop ${name} (leftover): ${String(err)}`);
      }
    },
  };
}

/**
 * All persisted bytes of a throwaway database, as a string — the Postgres
 * analogue of "read the closed SQLite file (+ WAL/SHM) off disk".
 *
 * `pg_dump --data-only` serialises every row of every table exactly as stored,
 * so grepping this proves a secret is (or is not) at rest, without needing
 * filesystem access to the server's data directory.
 */
export async function dumpDatabaseBytes(url: string): Promise<string> {
  assertThrowawayDatabase(url);
  const { stdout } = await exec("pg_dump", ["--data-only", "--no-owner", url], {
    env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}
