import type { OspDatabase, Repositories } from "@osp/db";
import {
  createOpClient,
  stateAtDate,
  versionScopeEvents,
  type OpClient,
  type OpClientConfig,
} from "@osp/op-client";
import type { ReconstructEngine } from "./logic/reconstruct";
import type { PdfRenderer } from "./logic/report";
import {
  createSnapshotWriter,
  createSyncEngine,
  type SnapshotWriter,
  type SyncEngine,
} from "@osp/sync";
import { createHealthTracker, type HealthTracker } from "./health/index";
import { createSprintLifecycle, type SprintLifecycle } from "./logic/sprintUpdate";
import { createAppVault, type AppVault } from "./vault/index";

/**
 * Dependency-injection surface for the API (SPEC §6/§7, SPEC_02 §3/§4). Every
 * collaborator is injected so contract tests can supply fakes and never touch a
 * real OP:
 *  - repos: the @osp/db repository implementations.
 *  - opClientFactory: builds a READ-ONLY OP client for a connection.
 *  - syncEngineFactory / snapshotWriterFactory: build @osp/sync collaborators
 *    bound to a given OP client (so POST /api/sync + the scheduler use the
 *    injected implementations).
 *  - vault: app-level token vault (unlock/lock, ad-hoc encrypt/decrypt,
 *    legacy migration, re-key, reset). The key lives only in its memory.
 *  - healthTracker: records per-connection health + notifies the SSE stream.
 *  - sprintLifecycleFactory: builds the Increment 4 activate/update/finish
 *    engine (apps/api/src/logic/sprintUpdate.ts) bound to a given OP client —
 *    same per-connection-factory pattern as syncEngineFactory. Routes AND the
 *    scheduler's sprint-update job both go through this, never construct the
 *    engine themselves.
 *  - now: clock override for deterministic tests.
 */
export interface AppDeps {
  repos: Repositories;
  /**
   * Increment 27 — the raw Drizzle handle (`DbHandle.db`), alongside `repos`.
   * The JSON export/import routes work at the whole-database level (every
   * table, in one transaction), which is deliberately below the repository
   * abstraction: repos expose per-entity operations, not "dump/replace
   * everything". Nothing else should reach for this.
   */
  db: OspDatabase;
  opClientFactory: (config: OpClientConfig) => OpClient;
  syncEngineFactory: (op: OpClient) => SyncEngine;
  snapshotWriterFactory: (op: OpClient) => SnapshotWriter;
  vault: AppVault;
  healthTracker: HealthTracker;
  /**
   * SPEC_10 §e — the lifecycle now takes a per-connection client RESOLVER, not a
   * single bound OpClient, so update()/finish()/activate() only contact the
   * connections their sprint's tickets actually live on. The route/scheduler
   * supplies `buildClientForConnection` (wrapping requireOpClientForConnection +
   * withTimeout); repos/snapshotWriterFactory/now are filled in here.
   */
  sprintLifecycleFactory: (opts: {
    buildClientForConnection: (connectionId: number) => Promise<OpClient>;
  }) => SprintLifecycle;
  /**
   * Increment 12 (SPEC_12 §1/§2) — the OP-journal reconstruction engine
   * (`@osp/op-client`'s stateAtDate/versionScopeEvents), injected so retro tests
   * can supply a deterministic fake with no OP round-trips. Consumed by
   * apps/api/src/logic/retro.ts.
   */
  reconstruct: ReconstructEngine;
  /**
   * SPEC_12 §6 — optional overrides for the pre-delete export writer (target
   * dir + fs primitives), so a test can point it at a scratch dir or force a
   * write failure to assert the delete aborts. Empty/undefined in production
   * (defaults: repo-root/exports + node:fs/promises).
   */
  sprintExport?: {
    exportsDir?: string;
    writeFile?: (path: string, data: string) => Promise<void>;
    mkdir?: (dir: string) => Promise<void>;
  };
  /**
   * Increment 14 (SPEC_14 §4) — optional override for the report PDF renderer,
   * so tests never launch a real headless Chromium. Undefined in production
   * (defaults to Playwright's chromium via apps/api/src/logic/report.ts).
   */
  pdfRenderer?: PdfRenderer;
  now: () => Date;
}

export interface PartialAppDeps {
  repos: Repositories;
  db: OspDatabase;
  opClientFactory?: (config: OpClientConfig) => OpClient;
  syncEngineFactory?: (op: OpClient) => SyncEngine;
  snapshotWriterFactory?: (op: OpClient) => SnapshotWriter;
  vault?: AppVault;
  healthTracker?: HealthTracker;
  sprintLifecycleFactory?: (opts: {
    buildClientForConnection: (connectionId: number) => Promise<OpClient>;
  }) => SprintLifecycle;
  reconstruct?: ReconstructEngine;
  sprintExport?: {
    exportsDir?: string;
    writeFile?: (path: string, data: string) => Promise<void>;
    mkdir?: (dir: string) => Promise<void>;
  };
  pdfRenderer?: PdfRenderer;
  now?: () => Date;
}

/**
 * Fill in the real @osp/op-client + @osp/sync + vault/health collaborators
 * around the given repos. Tests override any field with a fake.
 */
export function resolveDeps(partial: PartialAppDeps): AppDeps {
  const { repos } = partial;
  const now = partial.now ?? ((): Date => new Date());
  const snapshotWriterFactory: (op: OpClient) => SnapshotWriter =
    partial.snapshotWriterFactory ??
    ((op) =>
      createSnapshotWriter({
        op,
        sprints: repos.sprints,
        sprintItems: repos.sprintItems,
        workPackages: repos.workPackages,
        burndown: repos.burndown,
        remainingStatusRules: repos.remainingStatusRules,
      }));
  return {
    repos,
    db: partial.db,
    now,
    opClientFactory: partial.opClientFactory ?? ((config) => createOpClient(config)),
    vault: partial.vault ?? createAppVault(repos),
    healthTracker: partial.healthTracker ?? createHealthTracker(repos, now),
    syncEngineFactory:
      partial.syncEngineFactory ??
      ((op) =>
        createSyncEngine({
          op,
          projects: repos.projects,
          workPackages: repos.workPackages,
          sprintItems: repos.sprintItems,
          syncRuns: repos.syncRuns,
          sprints: repos.sprints,
          // Increment 29 (CONTRACTS §3) — without this the engine silently
          // degrades to the pre-Increment-29 `maxUpdatedAtOp` cutoff and the
          // mid-run race stays open. It is optional on the engine so unit
          // tests/the snapshot writer can omit it; the REAL app must not.
          watermarks: repos.watermarks,
        })),
    snapshotWriterFactory,
    sprintLifecycleFactory:
      partial.sprintLifecycleFactory ??
      (({ buildClientForConnection }) =>
        createSprintLifecycle({
          repos,
          buildClientForConnection,
          snapshotWriterFactory,
          now,
        })),
    reconstruct: partial.reconstruct ?? { stateAtDate, versionScopeEvents },
    sprintExport: partial.sprintExport,
    pdfRenderer: partial.pdfRenderer,
  };
}
