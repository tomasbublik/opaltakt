import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { openDb } from "@osp/db";
import { buildServer } from "./server";
import { resolveAuthConfig } from "./auth/config";

const exec = promisify(execFile);

/**
 * Increment 12 §0 — the hard isolation guardrail. `buildServer()` must NEVER
 * fall back to a default database: the whole point is that a forgotten
 * `DATABASE_URL` throws loudly instead of silently opening the user's REAL
 * database (which is exactly what destroyed their sprint history in
 * Increment 11 — see server.ts's `resolveDatabaseUrl` doc comment). This test
 * is the mechanical guarantee behind that prose: it fires on ANY invocation
 * (agent, CI, a stray script), not just the ones covered by a Playwright/e2e
 * config that remembered to set the var.
 *
 * ── Increment 27 (SQLite → Postgres) ────────────────────────────────────────
 * `OSP_DB_PATH` is gone; `DATABASE_URL` replaces it, likewise REQUIRED with no
 * default. The guardrail got MORE important, not less: under SQLite a wrong
 * path made a new empty file, whereas a wrong `DATABASE_URL` lands inside an
 * existing, populated database — the user's `osp`, or `atlas-core` belonging to
 * an unrelated project on the same server.
 *
 * The positive cases below need a real server (there is no `:memory:` in
 * Postgres and `buildServer()` deliberately accepts only a URL), so they run
 * against a GENERATED throwaway database `osp_test_<pid>_<rand>` and SKIP with
 * a warning when Docker Postgres is not running. The NEGATIVE case — the one
 * that actually protects the user — always runs, everywhere.
 */

const PG_HOST = process.env.OSP_TEST_PG_HOST ?? "127.0.0.1";
const PG_PORT = process.env.OSP_TEST_PG_PORT ?? "5432";
const PG_USER = process.env.OSP_TEST_PG_USER ?? os.userInfo().username;
const ADMIN_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/postgres`;

/**
 * Local mirror of the guardrail in tests/src/db-isolation.ts. Duplicated on
 * purpose: `@osp/api` does not depend on `@osp/tests`, and this check must not
 * be skippable by an import going missing. Deny-by-default — only a generated
 * `osp_test_*` / `osp_e2e_*` / `osp_smoke_*` name is ever touchable.
 */
const THROWAWAY_DB_PATTERN = /^osp_(?:test|e2e|smoke)_[a-z0-9_]+$/;
function assertThrowaway(name: string): void {
  if (!THROWAWAY_DB_PATTERN.test(name)) {
    throw new Error(
      `⛔ REFUSING to touch database ${JSON.stringify(name)} — not throwaway-shaped. ` +
        "In Increment 11 an agent ran against the user's real DB and destroyed every sprint.",
    );
  }
}

async function psqlAdmin(sql: string): Promise<void> {
  await exec("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-c", sql], {
    env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
  });
}

async function pgAvailable(): Promise<boolean> {
  try {
    await psqlAdmin("select 1");
    return true;
  } catch {
    return false;
  }
}

interface Throwaway {
  url: string;
  drop(): Promise<void>;
}

async function createThrowawayDb(): Promise<Throwaway> {
  const name = `osp_test_api_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  assertThrowaway(name);
  await psqlAdmin(`CREATE DATABASE "${name}"`);
  return {
    url: `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${name}`,
    drop: async () => {
      assertThrowaway(name); // independent re-check right before the DROP
      try {
        await psqlAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch {
        /* leftover throwaway DB is harmless */
      }
    },
  };
}

const REAL_PG = await pgAvailable();
if (!REAL_PG) {
  console.warn(
    "[server.test] real Postgres unreachable — SKIPPING the positive boot/recovery " +
      "proofs. The DATABASE_URL-is-required guard still runs.",
  );
}
const itIfPg = REAL_PG ? it : it.skip;

/** Increment 39 — buildServer needs an auth resolver; these boot tests use `none`. */
const NONE_AUTH = { resolveAuth: () => ({ mode: "none" as const }) };

describe("server bootstrap — §0 isolation guardrail (SPEC_12 / CONTRACTS §1)", () => {
  it("buildServer() throws when DATABASE_URL is not set — never falls back to a real database", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(buildServer(NONE_AUTH)).rejects.toThrow(/DATABASE_URL is not set/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it("Increment 39: buildServer() refuses a missing OSP_AUTH BEFORE opening any database", async () => {
    const prev = process.env.DATABASE_URL;
    // Unreachable on purpose: had buildServer tried to connect, the error
    // would be a connection error, not the OSP_AUTH refusal.
    process.env.DATABASE_URL = "postgres://127.0.0.1:1/osp_test_never_opened";
    try {
      await expect(
        buildServer({ resolveAuth: () => resolveAuthConfig({}) }),
      ).rejects.toThrow(/OSP_AUTH is not set/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      else delete process.env.DATABASE_URL;
    }
  });

  itIfPg("buildServer() succeeds when DATABASE_URL points at an explicit (throwaway) database", async () => {
    const throwaway = await createThrowawayDb();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = throwaway.url;
    try {
      const { close } = await buildServer(NONE_AUTH);
      await close();
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      else delete process.env.DATABASE_URL;
      await throwaway.drop();
    }
  });
});

/**
 * Increment 22 (SPEC_22 §1) — crash recovery at boot. A process killed
 * mid-sync leaves its sync_run row stuck status='running' forever; the guard
 * then 409s every future POST /sync permanently. buildServer() must mark any
 * such row 'aborted' before any route can run. Uses a real throwaway Postgres
 * database (not an ephemeral PGlite instance) so the seeded stale row survives
 * across two independent handles — the seeding handle and the one
 * buildServer() opens itself — proving this recovery is DB-based, not tied to
 * the process that created the run.
 */
describe("server bootstrap — §1 orphaned sync_run recovery (SPEC_22)", () => {
  itIfPg("marks a pre-existing 'running' sync_run 'aborted' during buildServer()", async () => {
    const throwaway = await createThrowawayDb();
    const prev = process.env.DATABASE_URL;
    try {
      // Seed a stale 'running' run via one handle, then close it (the "killed
      // process" — its in-memory registry is gone, the DB row lingers).
      const seed = await openDb({ url: throwaway.url });
      const stuck = await seed.repositories.syncRuns.start("full");
      expect((await seed.repositories.syncRuns.current())?.id).toBe(stuck.id);
      await seed.close();

      // A fresh boot against the SAME database must recover it before serving.
      process.env.DATABASE_URL = throwaway.url;
      const { close } = await buildServer(NONE_AUTH);
      await close();

      // Re-open to confirm the row is now aborted → the guard is unblocked.
      const check = await openDb({ url: throwaway.url });
      const row = await check.repositories.syncRuns.getById(stuck.id);
      expect(row?.status).toBe("aborted");
      expect(row?.error).toMatch(/Recovered at startup/);
      expect(await check.repositories.syncRuns.current()).toBeNull();
      await check.close();
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      else delete process.env.DATABASE_URL;
      await throwaway.drop();
    }
  });
});
