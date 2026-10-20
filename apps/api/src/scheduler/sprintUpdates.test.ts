import { describe, expect, it, vi, afterEach } from "vitest";
import type { OpClient } from "@osp/op-client";
import type { SprintLifecycle } from "../logic/sprintUpdate";
import {
  startSprintUpdateScheduler,
  DEFAULT_SPRINT_UPDATE_TICK_MS,
  type SchedulableSprint,
  type SprintUpdateSchedulerDeps,
} from "./sprintUpdates";

type Call =
  | { fn: "update"; sprintId: number; triggeredBy: string }
  | { fn: "finish"; sprintId: number; triggeredBy: string; lockReason: string };

/** Fake SprintLifecycle recording every call; override per-sprint behavior
 * (e.g. to throw) via `impl`. */
function fakeLifecycle(impl?: Partial<SprintLifecycle>): {
  lifecycle: SprintLifecycle;
  calls: Call[];
} {
  const calls: Call[] = [];
  const lifecycle: SprintLifecycle = {
    activate: vi.fn(async () => {
      throw new Error("not used by scheduler");
    }),
    update: async (sprintId, triggeredBy) => {
      calls.push({ fn: "update", sprintId, triggeredBy });
      if (impl?.update) return impl.update(sprintId, triggeredBy);
      return {} as never;
    },
    finish: async (sprintId, triggeredBy, lockReason) => {
      calls.push({ fn: "finish", sprintId, triggeredBy, lockReason });
      if (impl?.finish) return impl.finish(sprintId, triggeredBy, lockReason);
      return {} as never;
    },
  };
  return { lifecycle, calls };
}

function sprint(over: Partial<SchedulableSprint> = {}): SchedulableSprint {
  return {
    id: 1,
    end_date: "2026-12-31",
    status: "active",
    is_locked: false,
    locked_at: null,
    frozen_at: null,
    ...over,
  };
}

const NOW = new Date("2026-07-10T12:00:00.000Z");

function makeDeps(
  over: Partial<SprintUpdateSchedulerDeps> = {},
): { deps: SprintUpdateSchedulerDeps; opClientFactory: ReturnType<typeof vi.fn>; lifecycleFactory: ReturnType<typeof vi.fn> } {
  const opClientFactory = vi.fn(() => ({}) as OpClient);
  const { lifecycle } = fakeLifecycle();
  const lifecycleFactory = vi.fn(() => lifecycle);
  const deps: SprintUpdateSchedulerDeps = {
    listSprints: vi.fn(async () => [sprint()]),
    isVaultLocked: () => false,
    getClientConfigForConnection: vi.fn(async () => ({ baseUrl: "http://mock", token: "t" })),
    opClientFactory,
    sprintLifecycleFactory: lifecycleFactory,
    // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — default grace of 3
    // days, matching report_config's own schema default; freezeSprint is a
    // no-op spy unless a test overrides it.
    getFreezeGraceDays: vi.fn(async () => 3),
    freezeSprint: vi.fn(async () => undefined),
    tickMs: 3_600_000,
    now: () => NOW,
    onError: vi.fn(),
    ...over,
  };
  return { deps, opClientFactory, lifecycleFactory };
}

describe("sprint update scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an active unlocked sprint before its end date gets update('scheduler')", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { deps } = makeDeps({
      listSprints: async () => [sprint({ id: 42, end_date: "2026-12-31" })],
      sprintLifecycleFactory: () => lifecycle,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();

    expect(calls).toEqual([{ fn: "update", sprintId: 42, triggeredBy: "scheduler" }]);
  });

  it("a sprint past local end-of-day gets finish('end_date','end_date') instead of update", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { deps } = makeDeps({
      listSprints: async () => [sprint({ id: 7, end_date: "2026-07-09" })], // ends before NOW
      sprintLifecycleFactory: () => lifecycle,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();

    expect(calls).toEqual([
      { fn: "finish", sprintId: 7, triggeredBy: "end_date", lockReason: "end_date" },
    ]);
  });

  it("a sprint exactly at its local end-of-day deadline is also finished (>=)", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const deadline = new Date("2026-07-10T23:59:59.999");
    const { deps } = makeDeps({
      listSprints: async () => [sprint({ id: 9, end_date: "2026-07-10" })],
      sprintLifecycleFactory: () => lifecycle,
      now: () => deadline,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();

    expect(calls).toEqual([
      { fn: "finish", sprintId: 9, triggeredBy: "end_date", lockReason: "end_date" },
    ]);
  });

  it("a planning sprint is left alone", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { deps } = makeDeps({
      listSprints: async () => [sprint({ id: 1, status: "planning" })],
      sprintLifecycleFactory: () => lifecycle,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();
    expect(calls).toEqual([]);
  });

  it("an already-closed/locked sprint is left alone", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const { deps } = makeDeps({
      listSprints: async () => [
        sprint({ id: 1, status: "closed", is_locked: true }),
        sprint({ id: 2, status: "active", is_locked: true }), // defensively excluded even if status says active
      ],
      sprintLifecycleFactory: () => lifecycle,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();
    expect(calls).toEqual([]);
  });

  it("vault locked → zero calls to opClientFactory/sprintLifecycleFactory/anything", async () => {
    const { deps, opClientFactory, lifecycleFactory } = makeDeps({
      isVaultLocked: () => true,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();

    expect(deps.getClientConfigForConnection).not.toHaveBeenCalled();
    expect(deps.listSprints).not.toHaveBeenCalled();
    expect(opClientFactory).not.toHaveBeenCalled();
    expect(lifecycleFactory).not.toHaveBeenCalled();
  });

  it("a due sprint whose needed connection is unavailable is reported via onError and doesn't abort others (SPEC_10 §e)", async () => {
    const onError = vi.fn();
    const seen: number[] = [];
    // Sprint 1's update() resolves connection 99 (unavailable → null → throws);
    // sprint 2's resolves connection 7 (available). Each sprint gets its OWN
    // buildClientForConnection closure inside the per-sprint loop.
    const lifecycleFactory = vi.fn(
      (opts: { buildClientForConnection: (id: number) => Promise<OpClient> }): SprintLifecycle => ({
        activate: vi.fn(async () => ({}) as never),
        finish: vi.fn(async () => ({}) as never),
        update: async (sprintId) => {
          seen.push(sprintId);
          await opts.buildClientForConnection(sprintId === 1 ? 99 : 7);
          return {} as never;
        },
      }),
    );
    const { deps } = makeDeps({
      listSprints: async () => [sprint({ id: 1 }), sprint({ id: 2 })],
      getClientConfigForConnection: async (id) =>
        id === 7 ? { baseUrl: "http://mock", token: "t" } : null,
      sprintLifecycleFactory: lifecycleFactory,
      onError,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();

    // Both sprints attempted; only sprint 1's connection resolution failed.
    expect(seen.sort()).toEqual([1, 2]);
    expect(onError).toHaveBeenCalledTimes(1);
    // Each due sprint built its own lifecycle (per-sprint, not once per tick).
    expect(lifecycleFactory).toHaveBeenCalledTimes(2);
  });

  it("one sprint's lifecycle call throwing doesn't stop the others", async () => {
    const onError = vi.fn();
    const { lifecycle, calls } = fakeLifecycle({
      update: async (sprintId) => {
        if (sprintId === 1) throw new Error("op down");
        return {} as never;
      },
    });
    const { deps } = makeDeps({
      listSprints: async () => [sprint({ id: 1 }), sprint({ id: 2 })],
      sprintLifecycleFactory: () => lifecycle,
      onError,
    });
    const s = startSprintUpdateScheduler(deps);
    await s.tickNow();
    s.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    // Both sprints were attempted; sprint 2's call still happened despite 1's failure.
    expect(calls.map((c) => c.sprintId).sort()).toEqual([1, 2]);
  });

  it("overlap guard: a slow first tick blocks a second tick from starting concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listSprints = vi.fn(async (): Promise<SchedulableSprint[]> => {
      await gate;
      return [];
    });
    const { deps } = makeDeps({ listSprints });
    const s = startSprintUpdateScheduler(deps);

    const first = s.tickNow(); // blocks on the gate
    await s.tickNow(); // overlaps → must return immediately, no second listing
    expect(listSprints).toHaveBeenCalledTimes(1);

    release();
    await first;
    await s.tickNow();
    s.stop();
    expect(listSprints).toHaveBeenCalledTimes(2);
  });

  it("stop() stops further ticks", async () => {
    const isVaultLocked = vi.fn(() => true); // locked → ticks are cheap no-ops
    const { deps } = makeDeps({ isVaultLocked, tickMs: 20 });
    const s = startSprintUpdateScheduler(deps);
    await new Promise((r) => setTimeout(r, 90));
    expect(isVaultLocked.mock.calls.length).toBeGreaterThanOrEqual(2);

    s.stop();
    const after = isVaultLocked.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(isVaultLocked.mock.calls.length).toBe(after);
  });

  // ── Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — grace window ──────
  describe("grace window (closed + locked + unfrozen)", () => {
    it("gets a normal update('scheduler') every tick, independent of the active-sprint group", async () => {
      const { lifecycle, calls } = fakeLifecycle();
      const { deps } = makeDeps({
        listSprints: async () => [
          sprint({ id: 5, status: "closed", is_locked: true, locked_at: "2026-07-01T00:00:00.000Z" }),
        ],
        sprintLifecycleFactory: () => lifecycle,
      });
      const s = startSprintUpdateScheduler(deps);
      await s.tickNow();
      s.stop();

      expect(calls).toEqual([{ fn: "update", sprintId: 5, triggeredBy: "scheduler" }]);
    });

    it("not yet past locked_at + freeze_grace_days → update runs, freezeSprint is NOT called", async () => {
      const { lifecycle } = fakeLifecycle();
      const { deps } = makeDeps({
        // NOW = 2026-07-10T12:00. locked 2026-07-09 → deadline (3-day grace)
        // is end-of-local-day 2026-07-12 — still in the future.
        listSprints: async () => [
          sprint({ id: 5, status: "closed", is_locked: true, locked_at: "2026-07-09T08:00:00.000Z" }),
        ],
        sprintLifecycleFactory: () => lifecycle,
        getFreezeGraceDays: async () => 3,
      });
      const s = startSprintUpdateScheduler(deps);
      await s.tickNow();
      s.stop();

      expect(deps.freezeSprint).not.toHaveBeenCalled();
    });

    it("past locked_at + freeze_grace_days → freezeSprint is called with the SAME lifecycle the grace update used", async () => {
      const { lifecycle } = fakeLifecycle();
      const lifecycleFactory = vi.fn(() => lifecycle);
      const { deps } = makeDeps({
        // locked 2026-07-01 + 3 days grace → due by end of 2026-07-04, well
        // before NOW (2026-07-10).
        listSprints: async () => [
          sprint({ id: 5, status: "closed", is_locked: true, locked_at: "2026-07-01T08:00:00.000Z" }),
        ],
        sprintLifecycleFactory: lifecycleFactory,
        getFreezeGraceDays: async () => 3,
      });
      const s = startSprintUpdateScheduler(deps);
      await s.tickNow();
      s.stop();

      expect(deps.freezeSprint).toHaveBeenCalledTimes(1);
      expect(deps.freezeSprint).toHaveBeenCalledWith(5, lifecycle);
      // Only ONE lifecycle built for this sprint's tick — freeze reuses it,
      // never resolves connections a second time.
      expect(lifecycleFactory).toHaveBeenCalledTimes(1);
    });

    it("freeze_grace_days = 0 is due once local end-of-day of the locked_at day passes (not before)", async () => {
      // grace=0's deadline is still END OF THE LOCAL DAY `locked_at` falls on
      // (freezeDeadline's own contract, mirroring endOfLocalDay) — "the first
      // sweep after finish" means the first sweep AFTER that day ends, not
      // the very next tick. Same locked_at as the case below; only `now`
      // differs (before vs. at/after that day's local 23:59:59.999).
      const { lifecycle } = fakeLifecycle();
      const { deps: notYetDeps } = makeDeps({
        listSprints: async () => [
          sprint({ id: 5, status: "closed", is_locked: true, locked_at: "2026-07-10T12:00:00.000Z" }),
        ],
        sprintLifecycleFactory: () => lifecycle,
        getFreezeGraceDays: async () => 0,
        now: () => NOW, // 2026-07-10T12:00 — same local day, well before its end
      });
      const notYet = startSprintUpdateScheduler(notYetDeps);
      await notYet.tickNow();
      notYet.stop();
      expect(notYetDeps.freezeSprint).not.toHaveBeenCalled();

      const dueAt = new Date("2026-07-10T23:59:59.999"); // local end-of-day
      const { deps: dueDeps } = makeDeps({
        listSprints: async () => [
          sprint({ id: 5, status: "closed", is_locked: true, locked_at: "2026-07-10T12:00:00.000Z" }),
        ],
        sprintLifecycleFactory: () => lifecycle,
        getFreezeGraceDays: async () => 0,
        now: () => dueAt,
      });
      const due = startSprintUpdateScheduler(dueDeps);
      await due.tickNow();
      due.stop();
      expect(dueDeps.freezeSprint).toHaveBeenCalledTimes(1);
    });

    it("a frozen sprint (frozen_at set) is left alone entirely — no update, no freeze", async () => {
      const { lifecycle, calls } = fakeLifecycle();
      const { deps } = makeDeps({
        listSprints: async () => [
          sprint({
            id: 5,
            status: "closed",
            is_locked: true,
            locked_at: "2026-01-01T00:00:00.000Z",
            frozen_at: "2026-01-05T00:00:00.000Z",
          }),
        ],
        sprintLifecycleFactory: () => lifecycle,
      });
      const s = startSprintUpdateScheduler(deps);
      await s.tickNow();
      s.stop();

      expect(calls).toEqual([]);
      expect(deps.freezeSprint).not.toHaveBeenCalled();
    });

    it("the grace update failing doesn't block the freeze decision on the same sprint", async () => {
      const { lifecycle } = fakeLifecycle({
        update: async () => {
          throw new Error("op down");
        },
      });
      const onError = vi.fn();
      const { deps } = makeDeps({
        listSprints: async () => [
          sprint({ id: 5, status: "closed", is_locked: true, locked_at: "2026-07-01T08:00:00.000Z" }),
        ],
        sprintLifecycleFactory: () => lifecycle,
        getFreezeGraceDays: async () => 3,
        onError,
      });
      const s = startSprintUpdateScheduler(deps);
      await s.tickNow();
      s.stop();

      expect(onError).toHaveBeenCalledTimes(1); // the grace update's own failure
      expect(deps.freezeSprint).toHaveBeenCalledTimes(1); // still ran
    });
  });

  it("tickMs default is 30 minutes when omitted", () => {
    expect(DEFAULT_SPRINT_UPDATE_TICK_MS).toBe(30 * 60 * 1000);

    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const { deps } = makeDeps({ tickMs: undefined });
    const s = startSprintUpdateScheduler(deps);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_SPRINT_UPDATE_TICK_MS);
    s.stop();
    setIntervalSpy.mockRestore();
  });
});
