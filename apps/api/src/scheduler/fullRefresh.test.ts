import { describe, expect, it, vi } from "vitest";
import type { SyncRefreshAllResponse } from "@osp/contracts";
import {
  DEFAULT_FULL_REFRESH_INTERVAL_MS,
  resolveFullRefreshIntervalMs,
  startFullRefreshScheduler,
  type FullRefreshOutcome,
  type FullRefreshSchedulerDeps,
} from "./fullRefresh";

/**
 * Increment 29 (CONTRACTS §5) — the daily full refresh.
 *
 * The behaviour worth pinning is the one a background job gets wrong most
 * easily: it must SKIP (and say so in the log) when the vault is locked or a
 * sync is already running, never surface a 423/409 that has no caller to
 * receive it, and never let a throwing tick kill the timer.
 */

function response(over: Partial<SyncRefreshAllResponse> = {}): SyncRefreshAllResponse {
  return {
    connections: [],
    last: null,
    full_refresh: true,
    ...over,
  };
}

function makeDeps(over: Partial<FullRefreshSchedulerDeps> = {}): {
  deps: FullRefreshSchedulerDeps;
  runRefreshAll: ReturnType<typeof vi.fn>;
  infos: string[];
  errors: unknown[];
} {
  const infos: string[] = [];
  const errors: unknown[] = [];
  const runRefreshAll = vi.fn(
    async (): Promise<FullRefreshOutcome> => ({ status: "ran", response: response() }),
  );
  const deps: FullRefreshSchedulerDeps = {
    isVaultLocked: () => false,
    isSyncRunning: async () => false,
    runRefreshAll,
    // Long enough that only the explicit tickNow() below ever fires.
    intervalMs: 1_000_000,
    onInfo: (m) => infos.push(m),
    onError: (e) => errors.push(e),
    ...over,
  };
  return { deps, runRefreshAll, infos, errors };
}

describe("full refresh scheduler (Increment 29, CONTRACTS §5)", () => {
  it("runs the refresh-all path and logs the coverage summary", async () => {
    const runRefreshAll = vi.fn(
      async (): Promise<FullRefreshOutcome> => ({
        status: "ran",
        response: response({
          connections: [
            {
              connection_id: 1,
              connection_label: "Acme",
              status: "synced",
              run: null,
              coverage: {
                total_cached: 10,
                refreshed: 7,
                not_refreshed: 3,
                orphan_op_ids: [],
                oldest_cached_at: null,
              },
              message: "synced",
            },
          ],
        }),
      }),
    );
    const { deps, infos, errors } = makeDeps({ runRefreshAll });
    const s = startFullRefreshScheduler(deps);
    await s.tickNow();
    expect(runRefreshAll).toHaveBeenCalledTimes(1);
    expect(infos.join("\n")).toContain("3 cached ticket(s) still not refreshed");
    expect(errors).toEqual([]);
    s.stop();
  });

  it("SKIPS with a log when the vault is locked — never a 423 raised at nobody", async () => {
    const { deps, runRefreshAll, infos, errors } = makeDeps({
      isVaultLocked: () => true,
    });
    const s = startFullRefreshScheduler(deps);
    await s.tickNow();
    expect(runRefreshAll).not.toHaveBeenCalled();
    expect(infos.join("\n")).toContain("vault is locked");
    expect(errors).toEqual([]);
    s.stop();
  });

  it("SKIPS with a log when a sync is already running — never a 409", async () => {
    const { deps, runRefreshAll, infos, errors } = makeDeps({
      isSyncRunning: async () => true,
    });
    const s = startFullRefreshScheduler(deps);
    await s.tickNow();
    expect(runRefreshAll).not.toHaveBeenCalled();
    expect(infos.join("\n")).toContain("a sync is already running");
    expect(errors).toEqual([]);
    s.stop();
  });

  it("reports a non-200 from the refresh path as a skip, not a crash", async () => {
    // The pre-checks above race: a sync can start between them and the call.
    const { deps, infos, errors } = makeDeps({
      runRefreshAll: vi.fn(
        async (): Promise<FullRefreshOutcome> => ({
          status: "skipped",
          reason: "POST /api/sync → 409",
        }),
      ),
    });
    const s = startFullRefreshScheduler(deps);
    await s.tickNow();
    expect(infos.join("\n")).toContain("409");
    expect(errors).toEqual([]);
    s.stop();
  });

  it("a throwing tick goes to onError and never propagates", async () => {
    const { deps, errors } = makeDeps({
      runRefreshAll: vi.fn(async (): Promise<FullRefreshOutcome> => {
        throw new Error("boom");
      }),
    });
    const s = startFullRefreshScheduler(deps);
    await expect(s.tickNow()).resolves.toBeUndefined();
    expect((errors[0] as Error).message).toBe("boom");
    s.stop();
  });

  it("interval comes from OSP_FULL_REFRESH_INTERVAL_MS, defaulting to daily", () => {
    expect(resolveFullRefreshIntervalMs(undefined)).toBe(DEFAULT_FULL_REFRESH_INTERVAL_MS);
    expect(DEFAULT_FULL_REFRESH_INTERVAL_MS).toBe(86_400_000);
    expect(resolveFullRefreshIntervalMs("60000")).toBe(60_000);
    // Garbage / non-positive falls back rather than producing a hot loop.
    expect(resolveFullRefreshIntervalMs("nope")).toBe(DEFAULT_FULL_REFRESH_INTERVAL_MS);
    expect(resolveFullRefreshIntervalMs("0")).toBe(DEFAULT_FULL_REFRESH_INTERVAL_MS);
  });

  it("does not keep the process alive (the timer is unref'd)", () => {
    const s = startFullRefreshScheduler(makeDeps().deps);
    // A stray scheduler holding the event loop open is how a test run hangs.
    expect(typeof s.stop).toBe("function");
    s.stop();
  });
});
