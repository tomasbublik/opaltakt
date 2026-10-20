import type { SyncRefreshAllResponse } from "@osp/contracts";

/**
 * Periodic FULL REFRESH (Increment 29, SPEC_29 §6.2 / CONTRACTS §5).
 *
 * The coverage pass closes the hole for any connection the user actually syncs.
 * This job is the belt-and-braces half: once a day it runs the SAME internal
 * refresh-all path with `full_refresh: true`, which clears every stored
 * `sync_watermark` row per connection first, so no incremental cutoff — however
 * it got skewed — can survive indefinitely on a machine nobody clicks "Sync
 * now" on.
 *
 * Two hard rules, both about a BACKGROUND job having no caller to complain to:
 *
 *  1. It **skips, with a log** when the vault is locked or a sync is already
 *     running. Surfacing the route's 423/409 here would be an error raised at
 *     nobody: the user hasn't asked for anything, and the next tick will do the
 *     work anyway. `runRefreshAll` is expected to REPORT those conditions
 *     (`skipped`/`already_running`/`vault_locked`), not throw them.
 *  2. A tick that throws anyway must never crash the process or stop future
 *     ticks — `onError` absorbs it, same as every other scheduler here.
 *
 * All collaborators are INJECTED (the established convention in this folder —
 * heartbeat.ts / sprintUpdates.ts / syncWatchdog.ts), so tests never need a
 * real vault, DB or OP.
 */

export type FullRefreshOutcome =
  | { status: "ran"; response: SyncRefreshAllResponse }
  | { status: "skipped"; reason: string };

export interface FullRefreshSchedulerDeps {
  /** true → skip this tick entirely (no token can be decrypted anyway). */
  isVaultLocked(): boolean;
  /** true → a sync is already in flight; skip rather than 409 into the void. */
  isSyncRunning(): Promise<boolean>;
  /**
   * Run the internal refresh-all path with `full_refresh: true`. Wired in
   * index.ts to the very same `POST /api/sync` handler the UI calls — a second
   * implementation of the refresh loop is exactly what this increment is
   * removing, not adding.
   */
  runRefreshAll(): Promise<FullRefreshOutcome>;
  /** Interval; default OSP_FULL_REFRESH_INTERVAL_MS, else 24 h. */
  intervalMs?: number;
  /** Informational sink (defaults to console.info) — a skip must be VISIBLE. */
  onInfo?: (message: string) => void;
  onError?: (err: unknown) => void;
}

export interface FullRefreshScheduler {
  stop(): void;
  /** Run one tick immediately (tests / manual trigger). */
  tickNow(): Promise<void>;
}

export const DEFAULT_FULL_REFRESH_INTERVAL_MS = 86_400_000; // 24 h

/** `OSP_FULL_REFRESH_INTERVAL_MS` when it is a positive integer, else the default. */
export function resolveFullRefreshIntervalMs(
  raw: string | undefined = process.env.OSP_FULL_REFRESH_INTERVAL_MS,
): number {
  if (raw === undefined || raw === "") return DEFAULT_FULL_REFRESH_INTERVAL_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_FULL_REFRESH_INTERVAL_MS;
  return ms;
}

export function startFullRefreshScheduler(
  deps: FullRefreshSchedulerDeps,
): FullRefreshScheduler {
  const intervalMs = deps.intervalMs ?? resolveFullRefreshIntervalMs();
  const onInfo = deps.onInfo ?? ((m) => console.info("[fullRefresh]", m));
  const onError = deps.onError ?? ((err) => console.error("[fullRefresh]", err));

  // Overlapping-tick guard: a full refresh of a large instance can outlast the
  // interval on a pathological setup; never stack two of them.
  let running = false;

  async function tickNow(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (deps.isVaultLocked()) {
        onInfo("skipped: the vault is locked (no token can be decrypted)");
        return;
      }
      if (await deps.isSyncRunning()) {
        onInfo("skipped: a sync is already running");
        return;
      }
      const outcome = await deps.runRefreshAll();
      if (outcome.status === "skipped") {
        onInfo(`skipped: ${outcome.reason}`);
        return;
      }
      const stale = outcome.response.connections.reduce(
        (sum, c) => sum + (c.coverage?.not_refreshed ?? 0),
        0,
      );
      onInfo(
        `full refresh done: ${outcome.response.connections.length} connection(s), ` +
          `${stale} cached ticket(s) still not refreshed`,
      );
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    void tickNow();
  }, intervalMs);
  // Never keep the process alive just for this scheduler.
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
    tickNow,
  };
}
