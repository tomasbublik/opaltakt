import { type FastifyInstance } from "fastify";
import { openDb } from "@osp/db";
import { buildApp } from "./app";
import type { AuthConfig } from "./auth/index";
import { resolveDeps, type AppDeps } from "./deps";
import { sweepOverdueFreezes } from "./logic/freeze";

/**
 * Boots a fully-wired server: opens the Postgres DB (running migrations), resolves
 * the real @osp/op-client + @osp/sync factories, and builds the Fastify app.
 *
 * Returns the app plus the resolved deps (the scheduler wiring in index.ts needs
 * the snapshotWriterFactory + repos).
 */
export interface BuiltServer {
  app: FastifyInstance;
  deps: AppDeps;
  close(): Promise<void>;
}

/**
 * Increment 12 §0 — HARD isolation guardrail, carried over to Postgres in
 * Increment 27. Post-incident (Increment 11): a background agent booted this
 * server with no `OSP_DB_PATH` override, silently fell back to `./osp.sqlite`
 * — the user's REAL database — and destroyed all their sprint history
 * live-testing the new Delete-sprint feature against it. OpenProject itself
 * was never touched (this app is GET-only to OP by a separate, unrelated
 * invariant), but the local planning data was gone for good since delete is
 * intentionally hard/irreversible.
 *
 * FIX: there is no default anymore. `DATABASE_URL` (which replaced
 * `OSP_DB_PATH` in Increment 27) MUST be set, always, by every caller — the
 * user's own real dev session included (see README.md / root package.json's
 * `dev` script). This is deliberately more friction than a fallback: a
 * forgotten override now throws immediately instead of silently opening real
 * data. Never reintroduce a fallback here — if a "convenience default" is ever
 * proposed again, that convenience is exactly what caused the incident.
 *
 * The failure mode is IDENTICAL under Postgres, only the storage engine
 * changed: the real data now lives in the `osp` database on the shared local
 * instance (which may also host unrelated projects' databases). No agent, test
 * or live-verify run may ever point `DATABASE_URL` at `osp` or at another
 * project's database —
 * always create and drop a throwaway `osp_test_*` / `osp_e2e_*` database.
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — refusing to start. There is no default " +
        "database (see SPEC_12 §0 / INCREMENT_27_CONTRACTS §1): an agent " +
        "silently opening the user's real database via a fallback is exactly " +
        "what destroyed a user's sprint history in Increment 11. Set " +
        "DATABASE_URL explicitly — e.g. " +
        "postgres://localhost:5432/osp (via your untracked .env.local) for a " +
        "personal dev session, or a THROWAWAY database " +
        "(postgres://…/osp_test_<something>) for any agent / test / live-verify " +
        "run. Never point an agent or test run at the real `osp` database, and " +
        "never at another project's database on the same Postgres instance.",
    );
  }
  return url;
}

/**
 * Consolidation Round (Concept 8) — the ONE crash-recovery step every boot path
 * runs, BEFORE any route can serve. A process killed mid-run leaves its
 * lifecycle row stuck `status='running'` forever with no owner:
 *   - sync_run (Increment 22): Increment 20's "one sync at a time" guard then
 *     409s every future POST /sync permanently ("restart didn't help").
 *   - sprint_update_run (this round): activation/update/finish/retro-replay all
 *     drive it; a crash mid-activation left it locked forever, unrecovered.
 * A fresh process can't own any pre-existing running row, so both repositories'
 * recoverOrphaned() mark them all aborted. Deliberately UNCONDITIONAL (not gated
 * behind SCHEDULER_ENABLED like the watchdog) — it also runs in every vitest
 * boot (buildTestApp routes through here too), a harmless no-op against a fresh
 * ephemeral PGlite DB (zero rows recovered). No Fastify app/logger exists yet at a real
 * boot, so a plain console.warn (only when non-zero) is the cleanest surface.
 */
export async function recoverOrphanedRuns(
  repos: Pick<AppDeps["repos"], "syncRuns" | "sprintUpdateRuns">,
): Promise<void> {
  const recoveredSync = await repos.syncRuns.recoverOrphaned();
  if (recoveredSync > 0) {
    console.warn(
      `[osp] startup: recovered ${recoveredSync} orphaned sync_run row(s) stuck ` +
        `'running' (no live process could own them) — marked 'aborted'`,
    );
  }
  const recoveredUpdate = await repos.sprintUpdateRuns.recoverOrphaned();
  if (recoveredUpdate > 0) {
    console.warn(
      `[osp] startup: recovered ${recoveredUpdate} orphaned sprint_update_run ` +
        `row(s) stuck 'running' (no live process could own them) — marked 'aborted'`,
    );
  }
}

export interface BuildServerOptions {
  /**
   * Increment 39 — resolves the auth mode (index.ts: from OSP_AUTH, throwing
   * when unset/invalid). Called AFTER the DATABASE_URL guard and BEFORE the
   * database is opened, so a misconfigured boot never touches any DB and the
   * pre-existing DATABASE_URL guard still fires first.
   */
  resolveAuth: () => AuthConfig;
}

export async function buildServer(options: BuildServerOptions): Promise<BuiltServer> {
  const databaseUrl = resolveDatabaseUrl();
  const authConfig = options.resolveAuth();
  const handle = await openDb({ url: databaseUrl });
  await recoverOrphanedRuns(handle.repositories);
  const deps = resolveDeps({ repos: handle.repositories, db: handle.db });
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — ONE freeze-only sweep
  // at boot, same place as recoverOrphanedRuns: an app that was stopped past
  // a closed sprint's grace deadline freezes it immediately on restart
  // instead of waiting for the next 30-minute scheduler tick. Best-effort —
  // a single sprint's failure (or a locked vault) is logged and never blocks
  // boot; see logic/freeze.ts's own doc comment for why buildApp (test
  // harnesses, diag.ts) deliberately does NOT get this call.
  await sweepOverdueFreezes(deps);
  const app = await buildApp(deps, { auth: { config: authConfig } });
  return {
    app,
    deps,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}
