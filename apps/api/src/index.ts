import { instrumentOpClient, type OpClient } from "@osp/op-client";
import type { SnapshotWriter } from "@osp/sync";
import type { AppDeps } from "./deps";
import { freezeSprint } from "./logic/freeze";
import { connTokenBlob } from "./vault/index";
import { buildServer } from "./server";
import { resolveAuthConfig, type AuthConfig } from "./auth/index";
import { startScheduler, type Scheduler } from "./scheduler/index";
import { startHeartbeat, type Heartbeat } from "./scheduler/heartbeat";
import {
  startSprintUpdateScheduler,
  type SprintUpdateScheduler,
} from "./scheduler/sprintUpdates";
import { startSyncWatchdog, type SyncWatchdog } from "./scheduler/syncWatchdog";
import {
  startFullRefreshScheduler,
  type FullRefreshOutcome,
  type FullRefreshScheduler,
} from "./scheduler/fullRefresh";
import { hardCancelRun } from "@osp/sync";
import type { SyncRefreshAllResponse } from "@osp/contracts";

/**
 * Entry point. Boots the Fastify server and wires the background jobs:
 *  - the nightly snapshot scheduler (SPEC §5) — vault-aware: the OP client can
 *    only be built at RUN time (the vault is locked at boot), so a lazy writer
 *    decrypts the token ad-hoc per run and skips with a warning when locked;
 *  - the connection heartbeat (SPEC_02 §4) probing idle servers.
 * Both are guarded off during tests.
 */
/**
 * Increment 12 §0 — no default port either (belt-and-suspenders alongside
 * server.ts's DATABASE_URL guard): every boot states its port explicitly, so
 * an agent's process can never silently land on the same port the user's own
 * dev session normally uses. See server.ts's `resolveDbPath` doc for the
 * incident this whole guardrail responds to.
 */
function resolvePort(): number {
  const raw = process.env.PORT;
  if (!raw) {
    throw new Error(
      "PORT is not set — refusing to start (SPEC_12 §0: every boot must " +
        "state its port explicitly, no default). Set PORT=<n> — 3001 for " +
        "your own real dev session, an ephemeral one for any agent/test run.",
    );
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT="${raw}" is not a valid port number`);
  }
  return port;
}

/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §1) — OSP_AUTH is required,
 * no default, same philosophy as PORT/DATABASE_URL: a forgotten setting must
 * fail loudly, never silently deploy an open app. `entra` additionally needs
 * every OSP_ENTRA_* / OSP_PUBLIC_URL / OSP_SESSION_SECRET var (all missing
 * ones are listed). Evaluated by buildServer right after the DATABASE_URL
 * guard, before any database is opened.
 */
function resolveAuth(): AuthConfig {
  return resolveAuthConfig(process.env);
}

const PORT = resolvePort();
const HOST = process.env.HOST ?? "127.0.0.1";

/** Don't spin cron/heartbeat timers during tests. */
const SCHEDULER_ENABLED =
  process.env.NODE_ENV !== "test" &&
  process.env.VITEST === undefined &&
  process.env.OSP_DISABLE_SCHEDULER !== "1";

/**
 * Build an instrumented OP client for the CURRENT connection, or null when the
 * vault is locked / no connection / no stored token. The token is decrypted
 * ad-hoc and goes out of scope with the client config.
 */
async function makeOpClient(deps: AppDeps): Promise<OpClient | null> {
  if (deps.vault.isLocked()) return null;
  const conn = await deps.repos.connections.getCurrent();
  if (!conn) return null;
  const blob = connTokenBlob(conn);
  if (!blob) return null;
  const client = deps.opClientFactory({
    baseUrl: conn.base_url,
    token: deps.vault.decryptToken(blob),
  });
  // Piggyback health onto the scheduler's real OP traffic too (SPEC_02 §4).
  return instrumentOpClient(client, (r) => {
    void deps.healthTracker.record(conn.id, r, "activity").catch(() => {});
  });
}

async function main(): Promise<void> {
  const { app, deps } = await buildServer({ resolveAuth });
  app.log.info(`auth mode: ${resolveAuth().mode}`);

  let scheduler: Scheduler | undefined;
  let heartbeat: Heartbeat | undefined;
  let sprintUpdates: SprintUpdateScheduler | undefined;
  let syncWatchdog: SyncWatchdog | undefined;
  let fullRefresh: FullRefreshScheduler | undefined;
  if (SCHEDULER_ENABLED) {
    // Lazy snapshot writer: the vault is locked at boot, so the OP client is
    // (re)built per run; locked vault / missing connection → warn and skip.
    const lazyWriter: SnapshotWriter = {
      async writeSnapshot(sprintId, date): Promise<void> {
        const op = await makeOpClient(deps);
        if (!op) {
          app.log.warn("snapshot skipped: vault locked or no connection/token");
          return;
        }
        await deps.snapshotWriterFactory(op).writeSnapshot(sprintId, date);
      },
      async writeSnapshotsForActiveSprints(date): Promise<void> {
        const op = await makeOpClient(deps);
        if (!op) {
          app.log.warn("nightly snapshot skipped: vault locked or no connection/token");
          return;
        }
        await deps.snapshotWriterFactory(op).writeSnapshotsForActiveSprints(date);
      },
    };
    scheduler = startScheduler({ snapshotWriter: lazyWriter });
    app.log.info("nightly snapshot scheduler started (vault-aware)");

    // Heartbeat: probes connections idle > 20 s (SPEC_02 §4). Tokens are
    // decrypted ad-hoc per check and never retained by the heartbeat.
    heartbeat = startHeartbeat({
      listConnections: async () =>
        (await deps.repos.connections.list()).map((c) => ({
          id: c.id,
          base_url: c.base_url,
          last_activity_at: c.last_activity_at,
          last_check_at: c.last_check_at,
          has_token: c.token_ct != null,
          enabled: c.enabled,
        })),
      isVaultLocked: () => deps.vault.isLocked(),
      getClientConfig: async (id) => {
        if (deps.vault.isLocked()) return null;
        const c = await deps.repos.connections.getById(id);
        if (!c) return null;
        const blob = connTokenBlob(c);
        if (!blob) return null;
        return { baseUrl: c.base_url, token: deps.vault.decryptToken(blob) };
      },
      recordCheck: (id, result) => deps.healthTracker.record(id, result, "check"),
      onError: (err) => app.log.error(err, "heartbeat check failed"),
    });
    app.log.info("connection heartbeat started");

    // Sprint-update scheduler (SPEC_04 §9.1): every 30 min, runs one scoped
    // update pass over each active/unlocked sprint and auto-locks any whose
    // end_date has passed local end-of-day. Vault-aware, same as the heartbeat:
    // it skips a tick cleanly when the vault is locked or no token is stored.
    sprintUpdates = startSprintUpdateScheduler({
      listSprints: async () =>
        (await deps.repos.sprints.list()).map((s) => ({
          id: s.id,
          end_date: s.end_date,
          status: s.status,
          is_locked: s.is_locked,
          // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b): grace-window
          // detection needs both.
          locked_at: s.locked_at,
          frozen_at: s.frozen_at,
        })),
      isVaultLocked: () => deps.vault.isLocked(),
      // SPEC_10 §e: resolve a SPECIFIC connection (disabled / no token → null,
      // so the lifecycle throws a clear per-connection error for a NEEDED one).
      getClientConfigForConnection: async (id) => {
        if (deps.vault.isLocked()) return null;
        const c = await deps.repos.connections.getById(id);
        if (!c || !c.enabled) return null;
        const blob = connTokenBlob(c);
        if (!blob) return null;
        return { baseUrl: c.base_url, token: deps.vault.decryptToken(blob) };
      },
      opClientFactory: (config) => deps.opClientFactory(config),
      sprintLifecycleFactory: (opts) => deps.sprintLifecycleFactory(opts),
      // Increment 31 — read fresh every tick, straight off the settings
      // singleton, so a Settings-tab edit takes effect on the very next tick.
      getFreezeGraceDays: async () => (await deps.repos.reportConfig.get()).freeze_grace_days,
      // Increment 31 — reuses the ALREADY-BUILT per-connection sprintLifecycle
      // the tick just constructed for this sprint's grace update; the freeze
      // engine itself lives in logic/freeze.ts (needs deps.repos, which this
      // scheduler module deliberately never sees).
      freezeSprint: (sprintId, sprintLifecycle) =>
        freezeSprint({ repos: deps.repos, sprintLifecycle, now: deps.now }, sprintId),
      onError: (err) => app.log.error(err, "sprint update tick failed"),
    });
    app.log.info("sprint update scheduler started (vault-aware)");

    // Sync watchdog (Increment 20, SPEC_20 §3/§6): every 5s, ensures a running
    // sync that goes silent for 60s (hung request) or runs longer than 15 min
    // is hard-cancelled + rolled back, so the app can never freeze indefinitely
    // and no manual backend restart is ever needed. No OP/vault access — pure
    // local-DB + the in-process AbortController registry.
    syncWatchdog = startSyncWatchdog({
      currentRun: () => deps.repos.syncRuns.current(),
      hardCancel: (runId) => hardCancelRun(runId),
      // Increment 23 (SPEC_23 §3): also set the DB cancel_requested flag so any
      // cooperatively-polling loop (the orphans pass) observes the abort — not
      // just the in-flight AbortController. Same repo method POST /sync/:runId/cancel uses.
      requestCancel: (runId) => deps.repos.syncRuns.requestCancel(runId),
      dropStaging: (syncRunId) => deps.repos.workPackages.dropStaging(syncRunId),
      finish: (id, status, wpCount, error, finishedAt) =>
        deps.repos.syncRuns.finish(id, status, wpCount, error, finishedAt),
      onError: (err) => app.log.error(err, "sync watchdog tick failed"),
    });
    app.log.info("sync watchdog started");

    // Periodic full refresh (Increment 29, CONTRACTS §5): once a day, run the
    // SAME refresh-all path the UI's "Sync now" uses, with full_refresh: true —
    // every connection's stored watermark is cleared first, so no stale
    // incremental cutoff can survive indefinitely on an instance nobody
    // manually syncs. Routed through app.inject deliberately: it is literally
    // the same handler, so the loop can never drift into a second
    // implementation (the mistake this increment exists to undo).
    fullRefresh = startFullRefreshScheduler({
      isVaultLocked: () => deps.vault.isLocked(),
      isSyncRunning: async () => (await deps.repos.syncRuns.current()) !== null,
      runRefreshAll: async (): Promise<FullRefreshOutcome> => {
        const res = await app.inject({
          method: "POST",
          url: "/api/sync",
          // Increment 39 — in-process call acts as a system Planner.
          headers: app.internalAuthHeaders(),
          payload: { full_refresh: true },
        });
        if (res.statusCode === 200)
          return { status: "ran", response: res.json<SyncRefreshAllResponse>() };
        // 423 (vault locked) / 409 (sync started between our pre-check and
        // here) / 400 (nothing imported yet) are all legitimate "nothing to do
        // right now" for a background job — reported, never thrown.
        return { status: "skipped", reason: `POST /api/sync → ${res.statusCode}` };
      },
      onInfo: (message) => app.log.info(`full refresh: ${message}`),
      onError: (err) => app.log.error(err, "full refresh tick failed"),
    });
    app.log.info("periodic full refresh scheduler started (vault-aware)");
  }

  const shutdown = async (): Promise<void> => {
    scheduler?.stop();
    heartbeat?.stop();
    sprintUpdates?.stop();
    syncWatchdog?.stop();
    fullRefresh?.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
