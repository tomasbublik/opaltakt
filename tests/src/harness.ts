import { openDb, type DbHandle, type Repositories } from "@osp/db";
import { assertThrowawayDatabase } from "./db-isolation";
// Boot the REAL Fastify app + REAL @osp/sync engine. We import apps/api source
// directly (relative path) because @osp/api is not a declared dependency of the
// tests package and importing its package entrypoint would auto-start a server
// (apps/api/src/index.ts has a top-level `void main()`). app.ts / deps.ts are
// side-effect-free. See BUG LIST note in the Agent D report re: adding @osp/api
// as an explicit dependency.
import { buildApp } from "../../apps/api/src/app";
import { resolveDeps, type AppDeps } from "../../apps/api/src/deps";

// Derive the Fastify app type from buildApp's return so we don't import "fastify"
// directly (it isn't a declared dependency of @osp/tests; only @osp/api owns it).
type App = Awaited<ReturnType<typeof buildApp>>;
export type { App };

/**
 * Integration harness (Agent D, SPEC §9 + SPEC_02 §8): the REAL Fastify app
 * wired to a REAL Postgres-shaped DB (via @osp/db) and the REAL @osp/op-client
 * + @osp/sync, pointed at the mock OpenProject server. Nothing is faked — this
 * exercises the true data path (OP → sync → cache → REST).
 *
 * Increment 2: the old single "connect" step (POST /api/connection) is GONE.
 * Connecting now means: initialize/unlock the token VAULT, then register a
 * connection via POST /api/connections. See initAndUnlockVault/addConnection.
 *
 * Increment 27 (SQLite → Postgres, CONTRACTS §7): the storage engine under
 * this harness is **PGlite** — an in-process PostgreSQL, the structural
 * replacement for SQLite's `:memory:`. One fresh instance per boot (~235 ms),
 * no server, no ports, no cleanup, workers stay parallel. `openDb()` is now
 * async and `DbHandle.sqlite` is now `DbHandle.raw`.
 */
export interface RealApp {
  app: App;
  repos: Repositories;
  deps: AppDeps;
  /**
   * Raw driver handle (PGlite client, or a `pg.Pool` when a real-Postgres URL
   * was supplied) — for raw seeding/inspection in the vault tests. Prefer the
   * `rawQuery` helper below over touching this directly, so the handful of
   * raw-SQL tests share ONE driver-shape assumption.
   */
  raw: DbHandle["raw"];
  close(): Promise<void>;
}

export interface BootRealAppOptions {
  /**
   * A REAL Postgres connection string. Almost everything should leave this
   * unset and get a fresh ephemeral PGlite instance instead.
   *
   * It exists for the tests that need storage to OUTLIVE the app process —
   * chiefly the vault RESTART proof, which boots a second app over the SAME
   * storage to show tokens survive encrypted across restarts. PGlite is
   * in-process and ephemeral, so those tests must use the real server, on a
   * throwaway database created by `tests/src/pg-throwaway.ts`.
   *
   * Hard-validated against the isolation guardrail: a non-throwaway database
   * name throws before a single byte is written.
   */
  databaseUrl?: string;
  /**
   * Clock override (resolveDeps `now`). Increment-4 lifecycle tests inject a
   * MUTABLE logical clock so the app's `activated_at` / burndown-point dates
   * line up with the mock's logical calendar (2026-07-0X) instead of real wall
   * time — otherwise the changelog's `createdAt >= activated_at` filter would
   * discard every (past-dated) scenario journal. Threaded verbatim into the
   * sprint-lifecycle engine, snapshot writer, health tracker and vault.
   */
  now?: () => Date;
}

export async function bootRealApp(
  options: BootRealAppOptions = {},
): Promise<RealApp> {
  // ⛔ Guardrail: any real-Postgres URL must be a throwaway database. PGlite
  // (the default) cannot reach a shared server, so it needs no check.
  if (options.databaseUrl !== undefined) {
    assertThrowawayDatabase(options.databaseUrl);
  }
  const handle = await openDb(
    options.databaseUrl !== undefined
      ? { url: options.databaseUrl }
      : { ephemeral: true },
  ); // migrations applied
  const repos = handle.repositories;
  // real op-client + sync factories (+ optional injected clock)
  const deps = resolveDeps(
    options.now === undefined
      ? { repos, db: handle.db }
      : { repos, db: handle.db, now: options.now },
  );
  // Increment 39 — in-process harness, no HTTP sign-in: synthetic Planner.
  const app = await buildApp(deps, { auth: { config: { mode: "none" } } });
  await app.ready();
  let closed = false;
  return {
    app,
    repos,
    deps,
    raw: handle.raw,
    close: async () => {
      if (closed) return; // idempotent — afterAll safety nets may double-close
      closed = true;
      await app.close();
      await handle.close();
    },
  };
}

/**
 * Issue raw parameterised SQL against the underlying driver and return rows.
 *
 * `pg.Pool#query(text, values)` and `PGlite#query(text, params)` both resolve
 * to `{ rows }`, which is the entire API surface the raw-SQL tests need — so
 * this one helper keeps every test engine-agnostic and gives us a single place
 * to adapt if the driver shape ever changes.
 *
 * ⚠️ Postgres, not SQLite: placeholders are `$1, $2, …` (never `?`), booleans
 * are `true`/`false` (never `0`/`1`), and PGlite REJECTS multiple statements in
 * one call (SQLSTATE 42601) — issue them one at a time.
 */
export async function rawQuery<T = Record<string, unknown>>(
  raw: DbHandle["raw"],
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const driver = raw as { query: (sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
  const res = await driver.query(sql, params);
  return res.rows;
}

/** `rawQuery` for a statement expected to yield at most one row. */
export async function rawOne<T = Record<string, unknown>>(
  raw: DbHandle["raw"],
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await rawQuery<T>(raw, sql, params))[0];
}

/** Small typed helper around app.inject that returns parsed JSON + status. */
export async function call(
  app: App,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  const text = res.body;
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.statusCode, json };
}

/** Extract the `error.code` from a standard ErrorResponse envelope (or null). */
export function errorCode(json: unknown): string | null {
  const e = (json as { error?: { code?: unknown } } | null)?.error;
  return typeof e?.code === "string" ? e.code : null;
}

/**
 * SPEC_09 §1: activation is now an ASYNC background job — POST /activate
 * returns the started sprint_update_run immediately (status "running"); the
 * sprint's own status only flips planning→active once that run settles. Poll
 * GET /sprints/:id/updates until the newest "activation" run leaves
 * "running" (mirrors apps/api/src/test-utils.ts's identical helper — this
 * package boots its own copy of the real app via app.inject, so the
 * fire-and-forget background promise needs the SAME `setImmediate` pump to
 * advance past its first `await` before the test's next assertion runs).
 */
export async function waitForActivation(app: App, sprintId: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { json } = await call(app, "GET", `/api/sprints/${sprintId}/updates`);
    const runs = json as Array<{ kind: string; status: string; error: string | null }>;
    const act = runs.find((r) => r.kind === "activation");
    if (act && act.status !== "running") {
      if (act.status === "error") {
        throw new Error(`activation run errored: ${act.error}`);
      }
      return;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`activation for sprint ${sprintId} did not finish`);
}

/**
 * POST /sprints/:id/activate + wait for the background run to settle —
 * returns once the sprint has actually flipped to "active" (or throws on
 * error/timeout), so callers can treat this exactly like the old SYNCHRONOUS
 * activate() used to behave, pre-SPEC_09.
 */
export async function activateSprint(
  app: App,
  sprintId: number,
): Promise<{ status: number; json: unknown }> {
  const res = await call(app, "POST", `/api/sprints/${sprintId}/activate`);
  if (res.status < 200 || res.status >= 300) return res;
  await waitForActivation(app, sprintId);
  return res;
}

/** Default vault passphrase for tests (min 8 chars per VaultInitBody). */
export const TEST_PASSPHRASE = "osp-test-passphrase";

/**
 * Ensure the vault is initialized AND unlocked: POST /api/vault/init, and when
 * the vault already exists (re-used DB file), fall back to /api/vault/unlock.
 * Returns the response of the call that established the unlocked state.
 */
export async function initAndUnlockVault(
  app: App,
  passphrase: string = TEST_PASSPHRASE,
): Promise<{ status: number; json: unknown }> {
  const init = await call(app, "POST", "/api/vault/init", { passphrase });
  if (init.status >= 200 && init.status < 300) return init;
  return call(app, "POST", "/api/vault/unlock", { passphrase });
}

/**
 * Register an OP server via POST /api/connections (requires an unlocked vault).
 * Returns status + parsed body (an AddConnectionResponse on success).
 */
export async function addConnection(
  app: App,
  baseUrl: string,
  token: string,
  extra: { label?: string; default_project_op_id?: number } = {},
): Promise<{ status: number; json: unknown }> {
  return call(app, "POST", "/api/connections", {
    base_url: baseUrl,
    token,
    ...extra,
  });
}

/**
 * The Increment-2 equivalent of the old "connect" step: init/unlock the vault
 * with the default test passphrase, then add the mock OP as a connection.
 */
export async function connectToOp(
  app: App,
  baseUrl: string,
  token = "test-token",
  defaultProjectOpId?: number,
): Promise<{ status: number; json: unknown }> {
  await initAndUnlockVault(app);
  return addConnection(
    app,
    baseUrl,
    token,
    defaultProjectOpId === undefined
      ? {}
      : { default_project_op_id: defaultProjectOpId },
  );
}
