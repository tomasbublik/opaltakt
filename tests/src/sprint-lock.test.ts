import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  BacklogResponse,
  BurndownResponse,
  ClosureReportResponse,
  SprintResponse,
  SprintUpdateRunsResponse,
} from "@osp/contracts";
import {
  startSprintUpdateScheduler,
  type SprintUpdateSchedulerDeps,
} from "../../apps/api/src/scheduler/sprintUpdates";
import { activateSprint, bootRealApp, call, connectToOp, errorCode, type RealApp } from "./harness";

/**
 * SPEC_04 §8 — immutability gate + scheduler auto-lock (Agent D, review-grade).
 *
 * Once a sprint is locked (manual finish OR end-date auto-lock) EVERY sprint
 * mutation must 409 SPRINT_LOCKED and the DB must not change; finish is
 * idempotent-on-locked (returns the stored report, no new "final" run). The
 * scheduler must lock a past-end sprint (lock_reason="end_date"), keep a
 * future-end one active (a plain "update" run), stay GET-only, and no-op
 * entirely when the vault is locked.
 *
 * These run in FIXTURE mode (no scenario) — the lock/scheduler contract is
 * independent of changelog content, so no logical-clock alignment is needed.
 */

const TOKEN = "lock-token";

async function firstBacklogIds(harness: RealApp): Promise<number[]> {
  const res = await call(harness.app, "GET", "/api/backlog?projectId=3");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return BacklogResponse.parse(res.json).map((b) => b.op_id);
}

/** Read one sprint (there is no GET /sprints/:id — fetch the list and pick). */
async function getSprint(harness: RealApp, id: number) {
  const res = await call(harness.app, "GET", "/api/sprints");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const found = (res.json as Array<{ id: number }>).find((s) => s.id === id);
  expect(found, `sprint ${id} not found in GET /api/sprints`).toBeDefined();
  return SprintResponse.parse(found);
}

// ── (a)(b)(c) manual finish → immutable ──────────────────────────────────────
describe("SPEC_04 §8 — a finished sprint is immutable at the API layer", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let sprintId: number;
  let memberWp: number;
  let extraWp: number;
  let finishReport1: ClosureReportResponse;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await connectToOp(harness.app, mock.url, TOKEN, 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const ids = await firstBacklogIds(harness);
    expect(ids.length, "fixture backlog must have >= 2 WPs").toBeGreaterThanOrEqual(2);
    memberWp = ids[0]!;
    extraWp = ids[1]!;

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "lock sprint",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
    });
    sprintId = SprintResponse.parse(created.json).id;
    await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: memberWp });

    const activated = await activateSprint(harness.app, sprintId);
    expect(activated.status, `activate: ${JSON.stringify(activated.json)}`).toBe(200);

    const finish = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`, {});
    expect(finish.status, `finish: ${JSON.stringify(finish.json)}`).toBe(200);
    finishReport1 = ClosureReportResponse.parse(finish.json);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
  });

  it("finish returns a ClosureReportResponse and locks the sprint (is_locked, lock_reason=finished, locked_at)", async () => {
    expect(finishReport1.sprint_id).toBe(sprintId);
    const sprint = await getSprint(harness, sprintId);
    expect(sprint.is_locked).toBe(true);
    expect(sprint.lock_reason).toBe("finished");
    expect(sprint.locked_at).not.toBeNull();
    expect(sprint.activated_at).not.toBeNull();
  });

  // The invariant Agent D owns: a locked sprint is TRULY immutable for every
  // PLANNING mutation — refused (409) with a lifecycle code, DB never changes.
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2a): POST /update is the ONE
  // deliberate exception while merely locked — the post-finish GRACE window
  // accepts update runs (late time logs / final status flips); the hard update
  // refusal moved to the FREEZE (SPRINT_FROZEN), asserted separately below.
  async function attemptPlanningMutations() {
    return {
      "POST /items": await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: extraWp }),
      "DELETE /items/:wpId": await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${memberWp}`),
      "PUT /capacity": await call(harness.app, "PUT", `/api/sprints/${sprintId}/capacity`, {
        members: [{ op_user_id: 1, name: "Anyone", available_hours: 8, pto_days: 0 }],
      }),
      "PATCH /sprints/:id": await call(harness.app, "PATCH", `/api/sprints/${sprintId}`, { name: "renamed" }),
    } as Record<string, { status: number; json: unknown }>;
  }

  it("every PLANNING mutation is refused (409, lifecycle code) and the DB is unchanged; update alone is allowed during grace", async () => {
    const itemsBefore = await call(harness.app, "GET", `/api/sprints/${sprintId}/items`);
    const countBefore = (itemsBefore.json as unknown[]).length;

    const attempts = await attemptPlanningMutations();
    for (const [what, res] of Object.entries(attempts)) {
      expect(res.status, `${what} should 409, got ${res.status}: ${JSON.stringify(res.json)}`).toBe(409);
      // A locked sprint is also a closed sprint (close() sets both atomically),
      // so the refusal surfaces as SPRINT_LOCKED or SPRINT_CLOSED — either proves
      // immutability. The exact-code conformance is checked separately below.
      expect(
        ["SPRINT_LOCKED", "SPRINT_CLOSED"],
        `${what} must be a lock/closed refusal, got ${errorCode(res.json)}`,
      ).toContain(errorCode(res.json));
    }

    // Increment 31 §2a — the grace window: update on locked-but-unfrozen SUCCEEDS.
    const graceUpdate = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {});
    expect(
      graceUpdate.status,
      `POST /update during grace should succeed, got ${graceUpdate.status}: ${JSON.stringify(graceUpdate.json)}`,
    ).toBe(200);

    // DB provably unchanged by the REFUSED mutations: item set intact, name
    // not renamed. (The grace update legitimately appends an update run.)
    const itemsAfter = await call(harness.app, "GET", `/api/sprints/${sprintId}/items`);
    expect((itemsAfter.json as unknown[]).length).toBe(countBefore);
    const sprint = await getSprint(harness, sprintId);
    expect(sprint.name).toBe("lock sprint");
  });

  // Frozen-doc §LOCK ENFORCEMENT says EVERY mutating endpoint should throw
  // SPRINT_LOCKED. Reality: PUT /capacity, PATCH, POST /update do; POST/DELETE
  // .../items instead return SPRINT_CLOSED because their pre-existing
  // status==="closed" guard fires before the is_locked guard (Agent B documented
  // this as intentional: locked ⟹ closed). This test PINS that split so the
  // documented deviation is visible and can't drift unnoticed. See Agent D report.
  it("[deviation] lock error codes: capacity/patch = SPRINT_LOCKED (frozen doc); items = SPRINT_CLOSED; update = SPRINT_FROZEN only once frozen", async () => {
    const attempts = await attemptPlanningMutations();
    const code = (k: string) => errorCode(attempts[k]!.json);
    expect(code("PUT /capacity")).toBe("SPRINT_LOCKED");
    expect(code("PATCH /sprints/:id")).toBe("SPRINT_LOCKED");
    // Documented divergence from the frozen doc's literal "SPRINT_LOCKED for all":
    expect(code("POST /items")).toBe("SPRINT_CLOSED");
    expect(code("DELETE /items/:wpId")).toBe("SPRINT_CLOSED");

    // Increment 31 (§2a): update's hard refusal is the FREEZE, not the lock.
    // Freeze directly (the gate reads only frozen_at) and assert the new code.
    await harness.repos.sprints.setFrozen(sprintId, new Date().toISOString());
    const frozenUpdate = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {});
    expect(frozenUpdate.status, JSON.stringify(frozenUpdate.json)).toBe(409);
    expect(errorCode(frozenUpdate.json)).toBe("SPRINT_FROZEN");
  });

  it("POST /finish AGAIN is idempotent: returns the STORED report, no new `final` update run", async () => {
    // Precondition: still locked from the beforeAll finish.
    expect((await getSprint(harness, sprintId)).is_locked).toBe(true);
    const runsBefore = SprintUpdateRunsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/updates`)).json,
    );
    const finalsBefore = runsBefore.filter((r) => r.kind === "final").length;

    const finish2 = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`, {});
    expect(finish2.status, JSON.stringify(finish2.json)).toBe(200);
    const report2 = ClosureReportResponse.parse(finish2.json);

    // Substantive content is identical (the done/not_done/version split is stable).
    expect(report2.sprint_id).toBe(finishReport1.sprint_id);
    expect(report2.done).toEqual(finishReport1.done);
    expect(report2.not_done).toEqual(finishReport1.not_done);
    expect(report2.version_change).toEqual(finishReport1.version_change);

    // The re-finish returns the STORED report: its generated_at matches the
    // persisted closure row (read fresh). NB: this can differ by ~1ms from the
    // FIRST finish's *response* generated_at — see Agent D report (minor: the
    // finish response's generated_at isn't guaranteed byte-identical to the row).
    const stored = await harness.repos.closureReports.getBySprint(sprintId);
    expect(report2.generated_at).toBe(stored!.generated_at);

    // The hard idempotency gate: NO new "final" run was created by the re-finish.
    const runsAfter = SprintUpdateRunsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/updates`)).json,
    );
    const finalsAfter = runsAfter.filter((r) => r.kind === "final").length;
    expect(finalsAfter, "a re-finish must NOT create another final run").toBe(finalsBefore);
  });

  it("the whole finish/lock flow touched OpenProject with GET only", () => {
    const v3 = mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));
  });
});

// ── (e) PATCH activation shortcut ─────────────────────────────────────────────
describe("SPEC_04 §8 — PATCH {status:active} activates like POST /activate (no-frontend-change contract)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await connectToOp(harness.app, mock.url, TOKEN, 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
  });

  it("PATCH status:active on a planning sprint captures baseline (activated_at set) + a first burndown point", async () => {
    const ids = await firstBacklogIds(harness);
    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "patch-activate sprint",
      start_date: "2026-07-01",
      end_date: "2026-07-09",
    });
    const sprintId = SprintResponse.parse(created.json).id;
    await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: ids[0]! });

    const patched = await call(harness.app, "PATCH", `/api/sprints/${sprintId}`, {
      status: "active",
    });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    const sprint = SprintResponse.parse(patched.json);
    expect(sprint.status).toBe("active");
    expect(sprint.activated_at, "PATCH activation must set activated_at like /activate").not.toBeNull();

    // Baseline captured, and the activation burndown point exists.
    const baselines = await harness.repos.ticketBaselines.listBySprint(sprintId);
    expect(baselines.map((b) => b.wp_op_id)).toContain(ids[0]!);
    const bd = BurndownResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/burndown`)).json,
    );
    expect(bd.points.length).toBeGreaterThan(0);
  });
});

// ── (d) scheduler: end-date auto-lock, future stays active, vault-locked no-op ─
describe("SPEC_04 §8 — sprint-update scheduler (auto-lock on end date, GET-only, vault-locked no-op)", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let pastSprint: number;
  let futureSprint: number;
  let vaultLocked = false;
  const schedulerNow = { value: new Date("2026-07-20T00:00:00.000Z") };
  const tickErrors: unknown[] = [];

  function makeDeps(): SprintUpdateSchedulerDeps {
    return {
      listSprints: async () =>
        (await harness.repos.sprints.list()).map((s) => ({
          id: s.id,
          end_date: s.end_date,
          status: s.status,
          is_locked: s.is_locked,
          // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — SchedulableSprint
          // grew locked_at/frozen_at so the scheduler can also service the
          // post-finish grace window. This suite predates that increment and
          // has no locked/frozen sprints of its own to exercise it with —
          // pass the real columns through unchanged (none of this file's
          // sprints are ever closed+locked, so `dueGrace` stays empty here).
          locked_at: s.locked_at,
          frozen_at: s.frozen_at,
        })),
      isVaultLocked: () => vaultLocked,
      // SPEC_10 §e: per-connection resolver — the single mock connection serves
      // every needed connection id in this test's single-server setup.
      getClientConfigForConnection: async () => ({ baseUrl: mock.url, token: TOKEN }),
      opClientFactory: harness.deps.opClientFactory,
      sprintLifecycleFactory: harness.deps.sprintLifecycleFactory,
      // Increment 31 — this suite has no grace-window sprints, so these are
      // never actually invoked; present only to satisfy the DI interface.
      getFreezeGraceDays: async () => (await harness.repos.reportConfig.get()).freeze_grace_days,
      freezeSprint: async () => {
        throw new Error("sprint-lock.test.ts: freezeSprint should never be called (no grace-window sprints here)");
      },
      now: () => schedulerNow.value,
      tickMs: 3_600_000, // never fires on its own; tickNow() drives it
      onError: (e) => tickErrors.push(e),
    };
  }

  async function tickOnce(): Promise<void> {
    const sched = startSprintUpdateScheduler(makeDeps());
    try {
      await sched.tickNow();
    } finally {
      sched.stop();
    }
  }

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await connectToOp(harness.app, mock.url, TOKEN, 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    const ids = await firstBacklogIds(harness);

    // Past-end sprint: end_date well before schedulerNow → must auto-lock.
    const past = await call(harness.app, "POST", "/api/sprints", {
      name: "past sprint",
      start_date: "2026-07-01",
      end_date: "2026-07-05",
    });
    pastSprint = SprintResponse.parse(past.json).id;
    await call(harness.app, "POST", `/api/sprints/${pastSprint}/items`, { wp_op_id: ids[0]! });
    expect(
      (await activateSprint(harness.app, pastSprint)).status,
      "activate past sprint",
    ).toBe(200);

    // Future-end sprint: end_date after schedulerNow → stays active, plain update.
    const future = await call(harness.app, "POST", "/api/sprints", {
      name: "future sprint",
      start_date: "2026-07-01",
      end_date: "2026-09-01",
    });
    futureSprint = SprintResponse.parse(future.json).id;
    await call(harness.app, "POST", `/api/sprints/${futureSprint}/items`, { wp_op_id: ids[1] ?? ids[0]! });
    expect(
      (await activateSprint(harness.app, futureSprint)).status,
      "activate future sprint",
    ).toBe(200);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
  });

  beforeEach(() => {
    tickErrors.length = 0;
    mock.reset();
  });

  it("one tick auto-locks the past-end sprint (lock_reason=end_date + closure report) and only updates the future one", async () => {
    vaultLocked = false;
    await tickOnce();

    const past = await getSprint(harness, pastSprint);
    expect(
      past.is_locked,
      `past sprint must be locked by the tick. Scheduler errors: ${tickErrors.map(String).join(" | ") || "<none>"}`,
    ).toBe(true);
    expect(past.lock_reason).toBe("end_date");
    expect(past.locked_at).not.toBeNull();
    expect(
      await harness.repos.closureReports.getBySprint(pastSprint),
      "auto-lock must generate a closure report",
    ).not.toBeNull();

    // The future sprint stayed active and got a plain "update" run this tick.
    const future = await getSprint(harness, futureSprint);
    expect(future.is_locked).toBe(false);
    expect(future.status).toBe("active");
    const futureRuns = SprintUpdateRunsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${futureSprint}/updates`)).json,
    );
    expect(futureRuns.some((r) => r.kind === "update" && r.triggered_by === "scheduler")).toBe(true);
    // The past sprint's lock run was a "final" run (triggered_by end_date).
    const pastRuns = SprintUpdateRunsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${pastSprint}/updates`)).json,
    );
    expect(pastRuns.some((r) => r.kind === "final" && r.triggered_by === "end_date")).toBe(true);

    // GET-only against OP for the whole tick.
    const v3 = mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(v3.length).toBeGreaterThan(0);
    expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));
  }, 60_000);

  it("a locked vault makes the tick a complete no-op: zero OP traffic, zero DB change", async () => {
    vaultLocked = true;
    const runsBefore = SprintUpdateRunsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${futureSprint}/updates`)).json,
    ).length;

    await tickOnce();

    expect(mock.requests.length, "locked vault → no OP request at all").toBe(0);
    const runsAfter = SprintUpdateRunsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${futureSprint}/updates`)).json,
    ).length;
    expect(runsAfter, "no new update run may be created while the vault is locked").toBe(runsBefore);
    const future = await getSprint(harness, futureSprint);
    expect(future.is_locked).toBe(false);
  });
});
