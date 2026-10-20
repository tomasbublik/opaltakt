import { describe, expect, it, vi } from "vitest";
import type { SyncRun } from "@osp/contracts";
import {
  startSyncWatchdog,
  DEFAULT_SYNC_WATCHDOG_TICK_MS,
  DEFAULT_NO_PROGRESS_MS,
  DEFAULT_MAX_DURATION_MS,
  type SyncWatchdogDeps,
} from "./syncWatchdog";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const nowMs = NOW.getTime();

function run(over: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 1,
    started_at: NOW.toISOString(),
    finished_at: null,
    kind: "full",
    wp_count: 5,
    total_count: 100,
    status: "running",
    error: null,
    cancel_requested: false,
    last_progress_at: NOW.toISOString(),
    ...over,
  };
}

function makeDeps(over: Partial<SyncWatchdogDeps> = {}): {
  deps: SyncWatchdogDeps;
  hardCancel: ReturnType<typeof vi.fn>;
  requestCancel: ReturnType<typeof vi.fn>;
  dropStaging: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
} {
  const hardCancel = vi.fn(() => true);
  const requestCancel = vi.fn(async () => ({}));
  const dropStaging = vi.fn(async () => {});
  const finish = vi.fn(async () => ({}));
  const deps: SyncWatchdogDeps = {
    currentRun: vi.fn(async () => null),
    hardCancel,
    requestCancel,
    dropStaging,
    finish,
    now: () => NOW,
    onError: vi.fn(),
    ...over,
  };
  return { deps, hardCancel, requestCancel, dropStaging, finish };
}

describe("sync watchdog", () => {
  it("defaults: 5s tick, 60s no-progress, 15m max-duration", () => {
    expect(DEFAULT_SYNC_WATCHDOG_TICK_MS).toBe(5_000);
    expect(DEFAULT_NO_PROGRESS_MS).toBe(60_000);
    expect(DEFAULT_MAX_DURATION_MS).toBe(15 * 60_000);
  });

  it("no running sync → does nothing", async () => {
    const { deps, hardCancel, requestCancel, dropStaging, finish } = makeDeps({
      currentRun: async () => null,
    });
    const w = startSyncWatchdog(deps);
    await w.tickNow();
    w.stop();
    expect(hardCancel).not.toHaveBeenCalled();
    expect(requestCancel).not.toHaveBeenCalled();
    expect(dropStaging).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("a healthy, actively-progressing run is left alone", async () => {
    const { deps, hardCancel, dropStaging, finish } = makeDeps({
      // Progress 5s ago, started 2 min ago — both well within thresholds.
      currentRun: async () =>
        run({
          started_at: new Date(nowMs - 2 * 60_000).toISOString(),
          last_progress_at: new Date(nowMs - 5_000).toISOString(),
        }),
    });
    const w = startSyncWatchdog(deps);
    await w.tickNow();
    w.stop();
    expect(hardCancel).not.toHaveBeenCalled();
    expect(dropStaging).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("a stale run (no progress > 60s) is hard-cancelled + rolled back + finished as error", async () => {
    const { deps, hardCancel, requestCancel, dropStaging, finish } = makeDeps({
      currentRun: async () =>
        run({
          id: 42,
          wp_count: 7,
          // Progress 90s ago; started recently enough that only the no-progress
          // rule (not max-duration) fires.
          started_at: new Date(nowMs - 90_000).toISOString(),
          last_progress_at: new Date(nowMs - 90_000).toISOString(),
        }),
    });
    const w = startSyncWatchdog(deps);
    await w.tickNow();
    w.stop();

    expect(hardCancel).toHaveBeenCalledWith(42);
    // Increment 23 (SPEC_23 §3): the watchdog must ALSO set the DB
    // cancel_requested flag so a cooperatively-polling loop (orphans pass)
    // actually observes the abort — the literal "logged an abort but never
    // set the flag" bug.
    expect(requestCancel).toHaveBeenCalledWith(42);
    expect(dropStaging).toHaveBeenCalledWith(42);
    expect(finish).toHaveBeenCalledWith(
      42,
      "error",
      7,
      "Sync watchdog: no progress for 60s, aborting",
      NOW.toISOString(),
    );
  });

  it("falls back to started_at when no progress has landed yet", async () => {
    const { deps, hardCancel, finish } = makeDeps({
      currentRun: async () =>
        run({
          id: 3,
          started_at: new Date(nowMs - 61_000).toISOString(),
          last_progress_at: null, // heartbeat never fired
        }),
    });
    const w = startSyncWatchdog(deps);
    await w.tickNow();
    w.stop();
    expect(hardCancel).toHaveBeenCalledWith(3);
    expect(finish).toHaveBeenCalledWith(
      3,
      "error",
      expect.anything(),
      "Sync watchdog: no progress for 60s, aborting",
      NOW.toISOString(),
    );
  });

  it("a run exceeding max duration (but still progressing) is finished as aborted", async () => {
    const { deps, hardCancel, requestCancel, dropStaging, finish } = makeDeps({
      currentRun: async () =>
        run({
          id: 9,
          wp_count: 900,
          // Started 16 min ago but progressed 2s ago — no-progress rule does
          // NOT fire, only max-duration does.
          started_at: new Date(nowMs - 16 * 60_000).toISOString(),
          last_progress_at: new Date(nowMs - 2_000).toISOString(),
        }),
    });
    const w = startSyncWatchdog(deps);
    await w.tickNow();
    w.stop();

    expect(hardCancel).toHaveBeenCalledWith(9);
    expect(requestCancel).toHaveBeenCalledWith(9);
    expect(dropStaging).toHaveBeenCalledWith(9);
    expect(finish).toHaveBeenCalledWith(
      9,
      "aborted",
      900,
      "Sync watchdog: exceeded 15m max duration, aborting",
      NOW.toISOString(),
    );
  });

  it("a tick that throws is caught and does not stop subsequent ticks", async () => {
    const onError = vi.fn();
    let call = 0;
    const currentRun = vi.fn(async (): Promise<SyncRun | null> => {
      call += 1;
      if (call === 1) throw new Error("db hiccup");
      return null; // second tick is healthy
    });
    const { deps } = makeDeps({ currentRun, onError });
    const w = startSyncWatchdog(deps);
    await w.tickNow(); // throws internally → caught
    await w.tickNow(); // still runs
    w.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(currentRun).toHaveBeenCalledTimes(2);
  });

  it("stop() halts further ticks", async () => {
    const currentRun = vi.fn(async () => null);
    const { deps } = makeDeps({ currentRun, tickMs: 15 });
    const w = startSyncWatchdog(deps);
    await new Promise((r) => setTimeout(r, 70));
    expect(currentRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    w.stop();
    const after = currentRun.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(currentRun.mock.calls.length).toBe(after);
  });
});
