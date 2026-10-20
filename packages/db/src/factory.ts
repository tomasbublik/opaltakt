import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { createRepositories, type OspDatabase, type Repositories } from "./repos";
import { schema } from "./schema";

/**
 * DB connection factory (Increment 27 — PostgreSQL).
 *
 * `openDb()` is **async** (`Promise<DbHandle>`): opening a pool / booting an
 * in-process PGlite instance is asynchronous, unlike better-sqlite3 was. Every
 * call site must `await` it.
 *
 * ── THE API, for the four agents calling this ────────────────────────────────
 *
 *   // 1. Real Postgres — the app, e2e, live-verify, the migration script:
 *   const handle = await openDb({ url: process.env.DATABASE_URL });
 *
 *   // 2. Ephemeral in-process PGlite — vitest unit/integration tests.
 *   //    This is the structural replacement for the old ":memory:".
 *   const handle = await openDb({ ephemeral: true });
 *
 *   // Either form accepts `migrate: false` to skip running migrations on open
 *   // (default is true — migrations always run on open, exactly as before).
 *   const handle = await openDb({ url, migrate: false });
 *
 *   handle.db            // typed Drizzle handle (OspDatabase)
 *   handle.raw           // pg.Pool | PGlite — for tests that issue raw SQL
 *   handle.engine        // "pg" | "pglite" — narrow `raw` without guessing
 *   handle.repositories  // ready-to-inject repository implementations
 *   await handle.close() // close() is async now too
 *
 * `DbHandle.sqlite` is GONE; use `DbHandle.raw`. Raw SQL differs slightly per
 * engine (`pool.query(sql, params)` vs `pglite.query(sql, params)`), but both
 * expose `.query(text, values) => { rows }`, which covers every current raw
 * call site.
 *
 * ⚠️ PGlite quirk (CONTRACTS §7, VERIFIED): PGlite rejects **multiple SQL
 * commands in one prepared statement** (`cannot insert multiple commands into
 * a prepared statement`, SQLSTATE 42601). Drizzle's own migrator is fine (it
 * splits on `--> statement-breakpoint`), but never hand-write a multi-statement
 * string through `handle.raw` — issue one statement per call. `PGlite.exec()`
 * is the escape hatch if a multi-statement script is genuinely unavoidable.
 *
 * ⚠️ Foreign keys are now enforced natively and unconditionally (SQLite needed
 * `PRAGMA foreign_keys = ON`, which tests could and did get away without).
 * Insert order matters: parent rows before child rows.
 */

/** Absolute path to the generated migrations folder (packages/db/drizzle). */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

/** Which engine backs a handle — lets callers narrow `raw` without guessing. */
export type DbEngine = "pg" | "pglite";

export interface DbHandle {
  /** Typed Drizzle handle. */
  db: OspDatabase;
  /**
   * Underlying driver client — a `pg.Pool` for `{ url }`, a `PGlite` instance
   * for `{ ephemeral: true }`. Replaces the old `sqlite` field. Both expose
   * `.query(text, values)`; use `engine` to narrow when you need more.
   */
  raw: Pool | PGlite;
  /** Which driver `raw` is. */
  engine: DbEngine;
  /** Ready-to-inject repository implementations. */
  repositories: Repositories;
  /** Close the underlying connection / pool. Async, unlike the SQLite one. */
  close(): Promise<void>;
}

/** Open a real PostgreSQL database (app, e2e, scripts). */
export interface OpenPgOptions {
  /** Postgres connection string, e.g. `postgres://user@localhost:5432/osp`. */
  url: string;
  ephemeral?: false;
  /** Run migrations on open (default true). */
  migrate?: boolean;
  /** Max pooled connections (default 10). */
  poolMax?: number;
}

/** Open a throwaway in-process PGlite database (vitest). */
export interface OpenEphemeralOptions {
  ephemeral: true;
  url?: undefined;
  /** Run migrations on open (default true). */
  migrate?: boolean;
}

export type OpenDbOptions = OpenPgOptions | OpenEphemeralOptions;

/**
 * Opens the database, runs the Drizzle migrations that live in
 * packages/db/drizzle, and returns the typed handle plus ready-to-inject
 * repositories.
 */
export async function openDb(options: OpenDbOptions): Promise<DbHandle> {
  const runMigrations = options.migrate ?? true;

  if (options.ephemeral === true) {
    // Unit/integration tests: a fresh in-process PostgreSQL 16.4 (PGlite),
    // one per test, no server, no ports, no cleanup — the direct replacement
    // for the old ":memory:" SQLite database.
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    await client.waitReady;
    const db: OspDatabase = drizzle(client, { schema });
    if (runMigrations) {
      await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    }
    return {
      db,
      raw: client,
      engine: "pglite",
      repositories: createRepositories(db),
      close: async () => {
        await client.close();
      },
    };
  }

  const { url, poolMax = 10 } = options;
  if (!url) {
    throw new Error(
      "openDb({ url }) requires a non-empty Postgres connection string. " +
        "Pass { ephemeral: true } for a throwaway in-process test database.",
    );
  }
  const pgModule = await import("pg");
  // `pg` is CJS; the Pool constructor sits on the default export under ESM.
  const PoolCtor = (pgModule.default ?? pgModule).Pool;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new PoolCtor({ connectionString: url, max: poolMax });
  // MANDATORY, not defensive politeness: `pg.Pool` is an EventEmitter, and an
  // 'error' event with no listener is re-thrown by Node as an uncaught
  // exception that KILLS THE PROCESS. The pool emits it whenever the server
  // drops an IDLE connection — a Postgres restart, an admin
  // `pg_terminate_backend` (57P01), a network blip, a failover. That means
  // without this handler the API crashes on routine database maintenance.
  // Observed for real: the Increment 27 e2e run took down the API with
  // "Unhandled 'error' event … 57P01 terminating connection due to
  // administrator command" when its throwaway database was dropped.
  //
  // This is a failure class that did not exist under better-sqlite3 (an
  // in-process file handle has no server that can hang up on it), so there was
  // no prior art in this codebase to copy. Swallowing here is correct: the
  // erroring connection is already removed from the pool by `pg`, and the next
  // checkout transparently opens a fresh one. A query in flight still rejects
  // through its own promise, so no error is actually hidden from a caller.
  pool.on("error", (err: Error) => {
    console.warn(`[db] idle Postgres connection dropped: ${err.message}`);
  });
  const db: OspDatabase = drizzle(pool, { schema });
  try {
    if (runMigrations) {
      await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    }
  } catch (err) {
    // Never leak a pool (and its open sockets) if migrations blow up on boot.
    await pool.end().catch(() => undefined);
    throw err;
  }
  return {
    db,
    raw: pool,
    engine: "pg",
    repositories: createRepositories(db),
    close: async () => {
      await pool.end();
    },
  };
}
