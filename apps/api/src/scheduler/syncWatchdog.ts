import type { SyncRun } from "@osp/contracts";

/**
 * Sync watchdog (Increment 20, SPEC_20 §3/§6). The Increment-0 incident: a
 * large sync hit a request that never resolved, the app froze, and the user
 * had to restart the backend to unstick it. Two independent safety nets, both
 * checked every tick against the single running sync run (only one runs at a
 * time — the POST /sync guard enforces it):
 *
 *  1. NO-PROGRESS: if `now - last_progress_at` (falling back to `started_at`
 *     before the first progress lands) exceeds `noProgressMs` (default 60s),
 *     the run is stuck — hard-cancel it, drop its staging rows (true rollback,
 *     the live cache was never touched), and finish it as `"error"`.
 *  2. MAX-DURATION: if `now - started_at` exceeds `maxDurationMs` (default
 *     15 min), the run has simply run too long even if it's still making
 *     progress — hard-cancel + drop staging, but finish it as `"aborted"`
 *     (SPEC_20 §2: "po překročení automaticky abort + rollback").
 *
 * `hardCancelRun` (physically aborting the in-flight OP request) is INJECTED so
 * tests never need a live @osp/sync engine. All collaborators are injected, the
 * same convention as sprintUpdates.ts — this module is wired ONLY from
 * index.ts's `main()` under `SCHEDULER_ENABLED`, so the vitest suite (which
 * calls `buildServer()` directly, never `main()`) never spins its timer.
 */

export interface SyncWatchdogDeps {
  /** The single running sync run, or null when idle. */
  currentRun(): Promise<SyncRun | null>;
  /** Physically abort the in-flight OP request for this run (idempotent —
   * false if nothing is registered). Wired to @osp/sync's `hardCancelRun`. */
  hardCancel(runId: number): boolean;
  /**
   * Increment 23 (SPEC_23 §3) — set the DB `cancel_requested` flag, same as
   * `POST /sync/:runId/cancel` does. Previously `abortRun` called ONLY
   * `hardCancel` (the physical AbortController abort) and never this — any
   * OTHER loop cooperatively polling `isCancelled()` between its own steps
   * (e.g. apps/api's orphans pass, which checks the DB flag between items
   * exactly like `sync()`'s own between-page check) had no way to observe a
   * watchdog-triggered cancellation, so it kept running to completion
   * regardless of the watchdog's "no progress"/"max duration" verdict. Wired
   * to `SyncRunRepository.requestCancel`.
   */
  requestCancel(runId: number): Promise<unknown>;
  /** Drop this run's staging rows WITHOUT touching the live cache (rollback). */
  dropStaging(syncRunId: number): Promise<void>;
  /** Transition the run to a terminal status with a diagnostic message. */
  finish(
    id: number,
    status: SyncRun["status"],
    wpCount: number | null,
    error: string | null,
    finishedAt: string,
  ): Promise<unknown>;
  tickMs?: number; // default 5s — must be well under noProgressMs
  noProgressMs?: number; // default 60_000 (SPEC_20 §6)
  maxDurationMs?: number; // default 15 * 60_000 (SPEC_20 §6)
  now?: () => Date;
  onError?: (err: unknown) => void; // a tick throwing must never crash the process
}

export interface SyncWatchdog {
  stop(): void;
  /** Run one tick immediately (tests/manual). */
  tickNow(): Promise<void>;
}

export const DEFAULT_SYNC_WATCHDOG_TICK_MS = 5_000;
export const DEFAULT_NO_PROGRESS_MS = 60_000;
export const DEFAULT_MAX_DURATION_MS = 15 * 60_000;

export function startSyncWatchdog(deps: SyncWatchdogDeps): SyncWatchdog {
  const tickMs = deps.tickMs ?? DEFAULT_SYNC_WATCHDOG_TICK_MS;
  const noProgressMs = deps.noProgressMs ?? DEFAULT_NO_PROGRESS_MS;
  const maxDurationMs = deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? ((err) => console.error("[syncWatchdog]", err));

  // Overlapping-tick guard: a slow finish/dropStaging shouldn't stack ticks.
  let running = false;

  async function abortRun(
    run: SyncRun,
    status: SyncRun["status"],
    message: string,
    at: Date,
  ): Promise<void> {
    deps.hardCancel(run.id);
    await deps.requestCancel(run.id);
    await deps.dropStaging(run.id);
    await deps.finish(run.id, status, run.wp_count, message, at.toISOString());
  }

  async function tickNow(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const current = await deps.currentRun();
      if (current === null) return;

      const at = now();
      const nowMs = at.getTime();

      // No-progress: compare against the heartbeat, falling back to started_at
      // before any progress has landed. Ends the run as "error" (a stuck run,
      // distinct from a user-requested "aborted").
      const reference = current.last_progress_at ?? current.started_at;
      if (nowMs - Date.parse(reference) > noProgressMs) {
        await abortRun(
          current,
          "error",
          "Sync watchdog: no progress for 60s, aborting",
          at,
        );
        return;
      }

      // Max total duration: checked independently — a run CAN be progressing
      // steadily and still be worth cutting off. Ends as "aborted" (SPEC_20 §2).
      if (nowMs - Date.parse(current.started_at) > maxDurationMs) {
        await abortRun(
          current,
          "aborted",
          "Sync watchdog: exceeded 15m max duration, aborting",
          at,
        );
        return;
      }
    } catch (err) {
      // A watchdog tick throwing must never crash the process or stop future ticks.
      onError(err);
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    void tickNow();
  }, tickMs);
  // Never keep the process alive just for this watchdog.
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
    tickNow,
  };
}
