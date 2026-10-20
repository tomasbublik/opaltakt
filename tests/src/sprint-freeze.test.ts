import { afterEach, describe, expect, it } from "vitest";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import {
  AppConfigResponse,
  CapacityResponse,
  ClosureStatsResponse,
  SprintItemsDetailedResponse,
  SprintResponse,
  SyncRun,
} from "@osp/contracts";
import type { OutOfSelectionResponse, DeleteOutOfSelectionResponse, PersonRole } from "@osp/contracts";
import type {
  FrozenSprintItemFields,
  NewTicketBaseline,
  NewWorkPackageCache,
  Repositories,
} from "@osp/db";
import {
  activateSprint,
  bootRealApp,
  call,
  connectToOp,
  errorCode,
  rawQuery,
  type RealApp,
} from "./harness";
import { addDays, mockAdmin, type MockAdmin, S4 } from "./scenario-helpers";
// apps/api sources, imported directly (relative path) exactly like harness.ts
// does for buildApp/resolveDeps — @osp/api is not a declared dependency of
// this package. Landed by Agent A mid-session (docs/INCREMENT_31_CONTRACTS.md
// §2b): freezeDeadline is the pure end-of-local-day deadline math,
// freezeSprint(deps, sprintId) is the freeze action itself (deliberately
// UNCONDITIONAL — per its own doc comment the deadline check is the SWEEP's
// job, not this function's).
import { freezeDeadline, freezeSprint, type FreezeDeps } from "../../apps/api/src/logic/freeze";
import { createSprintLifecycle } from "../../apps/api/src/logic/sprintUpdate";
import {
  startSprintUpdateScheduler,
  type SprintUpdateSchedulerDeps,
} from "../../apps/api/src/scheduler/sprintUpdates";

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §5, Agent C) — sprint freeze
 * after a grace period + Import cleanup.
 *
 * ── PARALLELISM NOTE ─────────────────────────────────────────────────────────
 * Written strictly against the FROZEN contract (§1/§2/§3/§6) while Agent A
 * builds the apps/api logic in parallel. As of this file's authoring:
 *   - packages/db (schema, repos.sprints.setFrozen/reactivate,
 *     repos.sprintItems.listFrozenSnapshot/writeFreezeSnapshot,
 *     repos.reportConfig.setFreezeGraceDays, report_config.freeze_grace_days)
 *     IS landed — the tests below that seed a "frozen" sprint DIRECTLY via
 *     repos (§0's whole point: freeze is a snapshot, testable without the
 *     sweep) exercise real code today.
 *   - apps/api (the SPRINT_FROZEN update-gate, the freeze sweep itself in
 *     apps/api/src/logic/freeze.ts, the read-surface preference in
 *     computeClosureStats/buildCapacityResponse/buildSprintItemsDetailed, the
 *     GET/PUT /api/config route, and the out-of-selection `protected` rule)
 *     is NOT landed yet. Those tests are written against the contract's
 *     stated shapes and will fail until Agent A lands — see the per-test
 *     "BLOCKED ON AGENT A" comments for the exact missing symbol/route.
 *
 * Two seeding styles, matching the contract's own split:
 *   A) grace (§5.1) needs a REAL locked-via-finish sprint with an OP-backed
 *      update() pass — uses the S4 mock-OP scenario + bootRealApp, exactly
 *      like capacity-bar-rules-invariants.test.ts's "PART B" legs.
 *   B) freeze/invariant-10/import-protection (§5.3-5) don't need a live sweep
 *      at all — §0's "freeze is a snapshot" design means seeding
 *      `sprint.frozen_at` + `sprint_item.frozen_*` directly via repos
 *      (`freezeDirectly` below) is a FAITHFUL substitute for the real sweep,
 *      and lets these tests run with zero OP/mock dependency
 *      (identity-golden.test.ts's repos-seeding style).
 *
 * Guardrail: PGlite only (bootRealApp's ephemeral default) — no real
 * database, no default port, nothing that could touch the user's real `osp`.
 */

// ── shared fixture helpers (identity-golden.test.ts conventions) ────────────

function wp(p: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: p.connection_id ?? null,
    op_id: p.op_id,
    project_op_id: 100,
    subject: p.subject ?? `WP ${p.op_id}`,
    type_name: "Task",
    status_name: p.status_name ?? "In progress",
    status_is_closed: p.status_is_closed ?? false,
    assignee_op_id: p.assignee_op_id ?? null,
    assignee_name: p.assignee_name ?? null,
    estimated_hours: p.estimated_hours ?? null,
    remaining_hours: null,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: null,
    parent_op_id: p.parent_op_id ?? null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
  };
}

function baselineRow(
  sprintId: number,
  wpOpId: number,
  p: { assignee_op_id: number | null; assignee_name_raw: string | null; estimated_hours: number | null },
): NewTicketBaseline {
  return {
    sprint_id: sprintId,
    wp_op_id: wpOpId,
    captured_at: "2026-06-01T09:00:00Z",
    subject: `WP ${wpOpId}`,
    status_name: "In progress",
    status_is_closed: false,
    assignee_op_id: p.assignee_op_id,
    accountable_op_id: null,
    original_assignee_op_id: p.assignee_op_id,
    estimated_hours: p.estimated_hours,
    remaining_hours: null,
    spent_hours: null,
    version_op_id: null,
    raw_json: "{}",
    origin: "baseline",
    reconstructed: false,
    reconstruction_gaps_json: null,
    assignee_name_raw: p.assignee_name_raw,
  };
}

async function setRole(r: Repositories, opUserId: number, name: string, role: PersonRole): Promise<void> {
  const m = await r.teamMembers.upsert({ op_user_id: opUserId, name, default_hours_per_day: 8 });
  await r.teamMembers.setRole(m.id, role);
}

/**
 * §0's "freeze is a snapshot" made real, DIRECTLY via repos — no scheduler,
 * no OP round-trip. Mirrors what apps/api/src/logic/freeze.ts's
 * `freezeSprint` is contracted (§2b step 3) to write: one frozen_* row per
 * NON-REMOVED sprint_item, sourced from the live cache (falling back to the
 * ticket_baseline exactly like computeClosureStats does today — §2b),
 * followed by `sprint.frozen_at`.
 */
async function freezeDirectly(r: Repositories, sprintId: number, frozenAt: string): Promise<void> {
  const items = (await r.sprintItems.listBySprint(sprintId)).filter((i) => i.outcome !== "removed");
  const wps = await r.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id));
  const wpByOpId = new Map(wps.map((w) => [w.op_id, w]));
  const baselines = await r.ticketBaselines.listBySprint(sprintId);
  const baselineByOpId = new Map(baselines.map((b) => [b.wp_op_id, b]));
  const rows: Array<{ item_id: number } & FrozenSprintItemFields> = items.map((i) => {
    const live = wpByOpId.get(i.wp_op_id);
    const base = baselineByOpId.get(i.wp_op_id);
    return {
      item_id: i.id,
      frozen_effective_hours: live?.estimated_hours ?? base?.estimated_hours ?? i.planned_hours,
      frozen_assignee_op_id: live?.assignee_op_id ?? base?.assignee_op_id ?? null,
      frozen_assignee_name: live?.assignee_name ?? base?.assignee_name_raw ?? null,
      frozen_status_name: live?.status_name ?? base?.status_name ?? null,
      frozen_status_is_closed: live?.status_is_closed ?? base?.status_is_closed ?? null,
      frozen_parent_op_id: live?.parent_op_id ?? null,
      frozen_connection_id: live?.connection_id ?? null,
      // AMENDMENT (contracts §1): items/detailed needs the project id once the
      // cache row is gone — mirrored from freeze.ts's real snapshot writer.
      frozen_project_op_id: live?.project_op_id ?? null,
      // Increment 34 (INCREMENT_34_CONTRACTS.md §4): remaining at freeze time,
      // live-cache first, baseline fallback — mirrored from freeze.ts.
      frozen_remaining_hours: live?.remaining_hours ?? base?.remaining_hours ?? null,
    };
  });
  await r.sprintItems.writeFreezeSnapshot(sprintId, rows);
  await r.sprints.setFrozen(sprintId, frozenAt);
}

/**
 * A fully repo-seeded sprint — create → activate → close — with NO OP/mock
 * dependency at all (repos.sprints.activate/close are unconditional writes;
 * the real routes' guards are enforced by the CALLER in production, so
 * calling them directly here is a legitimate seeding shortcut, exactly like
 * identity-golden.test.ts's `seed351()`/`seed36()` build sprints straight
 * into "active" status).
 */
async function seedClosedSprint(
  r: Repositories,
  opts: {
    name: string;
    tickets: Array<{ wpOpId: number; assigneeOpId: number; assigneeName: string; estimatedHours: number; parentOpId?: number }>;
    lockedAt: string;
    startDate: string;
    endDate: string;
    frozen?: boolean;
  },
): Promise<number> {
  const sprint = await r.sprints.create({
    name: opts.name,
    start_date: opts.startDate,
    end_date: opts.endDate,
    status: "planning",
    capacity_mode: "per_person",
  });
  await r.workPackages.upsertMany(
    opts.tickets.map((t) =>
      wp({
        op_id: t.wpOpId,
        assignee_op_id: t.assigneeOpId,
        assignee_name: t.assigneeName,
        estimated_hours: t.estimatedHours,
        parent_op_id: t.parentOpId ?? null,
      }),
    ),
  );
  for (const t of opts.tickets) {
    await r.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: t.wpOpId,
      planned_hours: t.estimatedHours,
      outcome: "planned",
      origin: "baseline",
    });
  }
  await r.ticketBaselines.upsertMany(
    opts.tickets.map((t) =>
      baselineRow(sprint.id, t.wpOpId, {
        assignee_op_id: t.assigneeOpId,
        assignee_name_raw: t.assigneeName,
        estimated_hours: t.estimatedHours,
      }),
    ),
  );
  const totalHours = opts.tickets.reduce((s, t) => s + t.estimatedHours, 0);
  await r.sprints.activate(sprint.id, opts.lockedAt, totalHours);
  await r.sprints.close(sprint.id, totalHours, opts.lockedAt, "finished");
  if (opts.frozen) await freezeDirectly(r, sprint.id, opts.lockedAt);
  return sprint.id;
}

/** A window guaranteed to contain the REAL "today" (reactivate's date-window
 * gate compares against the wall clock, not a mock/injected one — see
 * SPEC_11 §8b / sprint-lifecycle.test.ts's own reactivate tests). */
function windowAroundToday(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 10);
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 10);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function insertTimeLog(
  r: Repositories,
  sprintId: number,
  wpOpId: number,
  actorOpId: number,
  actorName: string,
  hours: number,
  occurredAt: string,
  dedupKey: string,
  /** FOLLOWUPS #8: Logged counts spent_on within [start_date, end_date] at
   * read time too — a LATE log (occurred after finish) is only visible when
   * BACKDATED into the sprint window via spent_on, which is grace's whole
   * point. Defaults to occurredAt's own day for in-window callers. */
  spentOn: string = occurredAt.slice(0, 10),
): Promise<void> {
  const run = await r.sprintUpdateRuns.start(sprintId, "update", "manual");
  await r.ticketChangelog.insertMany([
    {
      sprint_id: sprintId,
      wp_op_id: wpOpId,
      update_run_id: run.id,
      occurred_at: occurredAt,
      actor_op_id: actorOpId,
      actor_name: actorName,
      kind: "time_logged" as const,
      detail_json: JSON.stringify({ kind: "time_logged", hours, spent_on: spentOn }),
      source: "time_entry" as const,
      op_journal_id: null,
      dedup_key: dedupKey,
    },
  ]);
  await r.sprintUpdateRuns.finish(run.id, "success", 0, 1, null, occurredAt);
}

async function getClosure(app: RealApp["app"], sprintId: number): Promise<ClosureStatsResponse> {
  const res = await call(app, "GET", `/api/sprints/${sprintId}/closure-stats`);
  expect(res.status, `closure-stats ${res.status}: ${JSON.stringify(res.json)}`).toBe(200);
  return ClosureStatsResponse.parse(res.json);
}

async function getCapacity(app: RealApp["app"], sprintId: number): Promise<CapacityResponse> {
  const res = await call(app, "GET", `/api/sprints/${sprintId}/capacity`);
  expect(res.status, `capacity ${res.status}: ${JSON.stringify(res.json)}`).toBe(200);
  return CapacityResponse.parse(res.json);
}

/**
 * ⚠️ REAL GAP FOUND (not a "not implemented yet" — a genuine structural hole
 * contract §1/§2c leaves open, worth Agent A's/the orchestrator's attention
 * at Phase 2): `SprintItemDetail.project_op_id` (inherited from `BacklogItem`)
 * is a positive `OpId` with NO nullable escape hatch. The route resolves it
 * as `wp?.project_op_id ?? 0` (apps/api/src/routes/index.ts ~line 775) — 0
 * once the live cache row is gone. `ticket_baseline` (the OTHER existing
 * fallback source everywhere else in this codebase) has NO `project_op_id`
 * column AT ALL, and the §1 frozen snapshot columns don't add one either
 * (`frozen_parent_op_id`/`frozen_connection_id` exist; no
 * `frozen_project_op_id`). So even once §2c makes every OTHER field prefer
 * the frozen snapshot, `GET /sprints/:id/items/detailed` for a FROZEN sprint
 * whose cache row has since been deleted (exactly what Invariant 10 declares
 * safe) will still emit `project_op_id: 0` — failing its own response schema
 * (`OpId` requires `> 0`). Reproduced live below by §5.3's cache-DELETION leg
 * and §5.5's bulk-delete leg. Needs either a `frozen_project_op_id` column or
 * `project_op_id` becoming nullable on this one response shape.
 */
async function getItemsDetailed(app: RealApp["app"], sprintId: number): Promise<SprintItemsDetailedResponse> {
  const res = await call(app, "GET", `/api/sprints/${sprintId}/items/detailed`);
  expect(res.status, `items/detailed ${res.status}: ${JSON.stringify(res.json)}`).toBe(200);
  return SprintItemsDetailedResponse.parse(res.json);
}

/** Invariant 10 (CAPACITY_BAR_RULES §6.10) snapshot: the three read surfaces
 * for one sprint, with closure's `generated_at` normalized so a re-capture at
 * a later wall-clock instant still compares byte-identical. */
async function captureTriple(
  app: RealApp["app"],
  sprintId: number,
): Promise<{ closure: string; capacity: string; items: string }> {
  const closure = await getClosure(app, sprintId);
  const capacity = await getCapacity(app, sprintId);
  const items = await getItemsDetailed(app, sprintId);
  return {
    closure: JSON.stringify({ ...closure, generated_at: "NORMALIZED" }),
    capacity: JSON.stringify(capacity),
    items: JSON.stringify(items),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 — Grace: finish() still allows update(), and a late time log is counted.
// Needs a REAL OP-backed sprint (finish's final update pass fetches from OP) —
// S4 scenario, same shape as capacity-bar-rules-invariants.test.ts PART B.
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 31 §5.1 — grace: a finished-but-unfrozen sprint still accepts POST /update", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let sprintId: number;
  const DEV = { op_user_id: 1, name: "Dev Dvořák" };
  const WP_A = 1401; // S4 fixture: dev baseline, est 12

  afterEach(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
  });

  async function setUp(): Promise<void> {
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    harness = await bootRealApp();

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    expect(SyncRun.parse((await call(harness.app, "POST", "/api/sync", { project_op_id: 3 })).json).status).toBe(
      "success",
    );

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "increment31 grace sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    expect((await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: WP_A })).status).toBeLessThan(
      300,
    );
    await setRole(harness.repos, DEV.op_user_id, DEV.name, "developer");
    await activateSprint(harness.app, sprintId);
  }

  it("POST /finish locks the sprint (unfrozen); POST /update afterwards SUCCEEDS instead of 409 SPRINT_LOCKED", async () => {
    await setUp();
    const finish = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`);
    expect(finish.status, `finish: ${JSON.stringify(finish.json)}`).toBe(200);

    const afterFinish = await harness.repos.sprints.getById(sprintId);
    expect(afterFinish!.is_locked, "finish locks the sprint").toBe(true);
    expect(afterFinish!.frozen_at, "NOT frozen immediately — that's the whole point of grace").toBeNull();

    // ⚠️ BLOCKED ON AGENT A (docs/INCREMENT_31_CONTRACTS.md §2a): today's
    // createSprintLifecycle().update() throws AppError("SPRINT_LOCKED") for
    // ANY locked sprint, frozen or not (apps/api/src/logic/sprintUpdate.ts:
    // ~1033). §2a's new rule is: locked-but-NOT-frozen → update is ALLOWED.
    // This assertion is the direct contract-level proof of that gate.
    const update = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`);
    expect(
      update.status,
      `grace window: POST /update on a locked-but-unfrozen sprint must succeed (contract §2a) — ` +
        `got ${update.status} ${JSON.stringify(update.json)}`,
    ).toBe(200);
  });

  it("a time_logged changelog entry recorded AFTER finish is reflected in closure-stats per_developer[].logged_hours", async () => {
    await setUp();
    const finish = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`);
    expect(finish.status).toBe(200);
    const lockedAt = (await harness.repos.sprints.getById(sprintId))!.locked_at!;

    const before = await getClosure(harness.app, sprintId);
    const devBefore = before.per_developer.find((d) => d.name === DEV.name);
    const beforeLogged = devBefore?.logged_hours ?? 0;

    // A late log, RECORDED strictly after locked_at but BACKDATED via spent_on
    // into the sprint's calendar window — exactly what grace exists to admit
    // (docs §0: "people get a few days to log late time"; FOLLOWUPS #8: Logged
    // counts spent_on within [start_date, end_date], so a late entry is
    // visible precisely because its spent_on points back into the sprint).
    const lateAt = new Date(new Date(lockedAt).getTime() + 60_000).toISOString();
    const sprintRow = (await harness.repos.sprints.getById(sprintId))!;
    await insertTimeLog(
      harness.repos, sprintId, WP_A, DEV.op_user_id, DEV.name, 2.5, lateAt,
      "grace-late-log", sprintRow.end_date,
    );

    const after = await getClosure(harness.app, sprintId);
    const devAfter = after.per_developer.find((d) => d.name === DEV.name);
    expect(devAfter, `${DEV.name} still appears in per_developer after the late log`).toBeTruthy();
    expect(
      devAfter!.logged_hours,
      "the late (post-finish) time log is counted, not silently dropped by grace",
    ).toBeCloseTo(beforeLogged + 2.5, 5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — Freeze deadline math (pure) + the sweep's decision to freeze exactly at
// the deadline (BLOCKED ON AGENT A: apps/api/src/logic/freeze.ts doesn't exist
// yet — no freezeDeadline/freezeSprint export to import).
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 31 §5.2 — freeze deadline math + freezeSprint()", () => {
  it("freezeDeadline(locked_at, grace_days) = end of the LOCAL day, N calendar days after locked_at (endOfLocalDay convention, contracts §2b)", () => {
    const lockedAt = "2026-06-01T10:00:00.000Z";
    const deadline = freezeDeadline(lockedAt, 3);
    // Compute the expected instant with the SAME local-calendar-component
    // arithmetic freeze.ts documents (locked.getFullYear()/getMonth()/
    // getDate() + graceDays, 23:59:59.999) rather than a hardcoded literal —
    // a literal would silently depend on the test runner's own timezone.
    const locked = new Date(lockedAt);
    const expected = new Date(
      locked.getFullYear(),
      locked.getMonth(),
      locked.getDate() + 3,
      23,
      59,
      59,
      999,
    ).toISOString();
    expect(deadline).toBe(expected);

    // grace_days = 0 (docs §1: "0 = freeze at the first sweep after finish")
    // lands on the END of the SAME local day the sprint locked, not before it.
    const deadlineZero = freezeDeadline(lockedAt, 0);
    const expectedZero = new Date(
      locked.getFullYear(),
      locked.getMonth(),
      locked.getDate(),
      23,
      59,
      59,
      999,
    ).toISOString();
    expect(deadlineZero).toBe(expectedZero);
  });

  it("freezeSprint() is the unconditional freeze ACTION (deadline gating is the sweep's job, per its own doc comment) — it snapshots every item and sets frozen_at to `now`", async () => {
    const harness = await bootRealApp();
    try {
      const r = harness.repos;
      await setRole(r, 701, "Sweep Dev", "developer");
      const sprintId = await seedClosedSprint(r, {
        name: "freezeSprint() direct-call sprint",
        tickets: [{ wpOpId: 9001, assigneeOpId: 701, assigneeName: "Sweep Dev", estimatedHours: 5 }],
        lockedAt: "2026-06-01T00:00:00.000Z",
        startDate: "2026-05-25",
        endDate: "2026-06-01",
      });
      expect((await r.sprints.getById(sprintId))!.frozen_at, "precondition: not yet frozen").toBeNull();

      const frozenNow = new Date("2026-06-05T08:00:00.000Z");
      const lifecycle = createSprintLifecycle({
        repos: r,
        // No live OP connection for this repo-seeded sprint — freezeSprint's
        // step 1 (`sprintLifecycle.update(sprintId, "freeze")`) is documented
        // best-effort: an OP outage (here: NO_CONNECTION) must not block
        // freezing, only be logged and swallowed.
        buildClientForConnection: async () => {
          throw new Error("no live OP connection for this repo-seeded sprint");
        },
        snapshotWriterFactory: () => ({
          writeSnapshot: async () => {},
          writeSnapshotsForActiveSprints: async () => {},
        }),
        now: () => frozenNow,
      });
      const deps: FreezeDeps = { repos: r, sprintLifecycle: lifecycle, now: () => frozenNow };
      await freezeSprint(deps, sprintId);

      const after = await r.sprints.getById(sprintId);
      expect(after!.frozen_at, "freezeSprint() sets frozen_at to `now` (best-effort update failure notwithstanding)").toBe(
        frozenNow.toISOString(),
      );
      const snapshot = await r.sprintItems.listFrozenSnapshot(sprintId);
      const row = snapshot.find((s) => s.wp_op_id === 9001)!;
      expect(row.frozen_effective_hours, "the item's estimate was snapshotted").toBe(5);
      expect(row.frozen_assignee_op_id, "the item's holder was snapshotted").toBe(701);
    } finally {
      await harness.close();
    }
  });

  it("composing freezeDeadline + `now` reproduces the sweep's due/not-due decision (contracts §2b point 2: `now >= locked_at + freeze_grace_days`)", async () => {
    // This inlines the decision the future scheduler tick owns (contracts
    // §2b: "for those same sprints, when now >= locked_at + freeze_grace_days,
    // run freezeSprint(sprintId)") — apps/api/src/scheduler/sprintUpdates.ts
    // does not implement that wiring yet (only sprintUpdate.ts's SPRINT_FROZEN
    // update-gate has landed so far), so there is no tickNow()-level entry
    // point to call directly yet. Once it lands, this composition is exactly
    // what it must reduce to; until then it pins the primitives it will be
    // built from.
    const harness = await bootRealApp();
    try {
      const r = harness.repos;
      await setRole(r, 702, "Deadline Dev", "developer");
      const lockedAt = "2026-06-01T00:00:00.000Z";
      const graceDays = 3;
      const sprintId = await seedClosedSprint(r, {
        name: "sweep-decision sprint",
        tickets: [{ wpOpId: 9002, assigneeOpId: 702, assigneeName: "Deadline Dev", estimatedHours: 4 }],
        lockedAt,
        startDate: "2026-05-25",
        endDate: "2026-06-01",
      });
      await r.reportConfig.setFreezeGraceDays(graceDays);
      const deadline = new Date(freezeDeadline(lockedAt, graceDays));

      const lifecycleFor = (now: () => Date) =>
        createSprintLifecycle({
          repos: r,
          buildClientForConnection: async () => {
            throw new Error("no live OP connection");
          },
          snapshotWriterFactory: () => ({
            writeSnapshot: async () => {},
            writeSnapshotsForActiveSprints: async () => {},
          }),
          now,
        });

      // Just BEFORE the deadline: the sweep must NOT call freezeSprint.
      const justBefore = new Date(deadline.getTime() - 1);
      const dueBefore = justBefore.getTime() >= deadline.getTime();
      expect(dueBefore, "one millisecond before the deadline is not yet due").toBe(false);
      expect((await r.sprints.getById(sprintId))!.frozen_at, "still unfrozen (sweep would have skipped it)").toBeNull();

      // AT/AFTER the deadline: the sweep calls freezeSprint.
      const justAfter = new Date(deadline.getTime() + 1);
      const dueAfter = justAfter.getTime() >= deadline.getTime();
      expect(dueAfter, "one millisecond after the deadline is due").toBe(true);
      await freezeSprint({ repos: r, sprintLifecycle: lifecycleFor(() => justAfter), now: () => justAfter }, sprintId);
      expect((await r.sprints.getById(sprintId))!.frozen_at, "now frozen, exactly once due").toBe(
        justAfter.toISOString(),
      );
    } finally {
      await harness.close();
    }
  });

  it("the REAL scheduler (startSprintUpdateScheduler + tickNow()) freezes a due grace sprint and leaves a not-yet-due one alone", async () => {
    // Now that apps/api/src/scheduler/sprintUpdates.ts's SchedulableSprint/
    // SprintUpdateSchedulerDeps have actually landed (locked_at/frozen_at +
    // getFreezeGraceDays/freezeSprint), this drives the SAME entry point
    // production uses (index.ts's own `startSprintUpdateScheduler({...})`
    // call), wired to this harness's real repos — no fakes for the
    // freeze-relevant deps, only `now` is injected (as every scheduler test
    // in this codebase already does, sprint-lock.test.ts included).
    const harness = await bootRealApp();
    try {
      const r = harness.repos;
      await setRole(r, 703, "Real Sweep Dev", "developer");
      await setRole(r, 704, "Not Due Dev", "developer");
      const graceDays = 2;
      await r.reportConfig.setFreezeGraceDays(graceDays);

      // Two DIFFERENT locked_at values so a SINGLE tick, at a SINGLE `now`,
      // must treat them differently — proving the sweep decides per-sprint
      // from each one's own locked_at + freeze_grace_days, not from some
      // single shared cutoff.
      const dueSprintId = await seedClosedSprint(r, {
        name: "real-scheduler DUE sprint",
        tickets: [{ wpOpId: 9003, assigneeOpId: 703, assigneeName: "Real Sweep Dev", estimatedHours: 6 }],
        lockedAt: "2026-06-01T00:00:00.000Z", // deadline 2026-06-03 23:59:59.999 — well past by `now` below
        startDate: "2026-05-20",
        endDate: "2026-06-01",
      });
      const notDueSprintId = await seedClosedSprint(r, {
        name: "real-scheduler NOT-DUE sprint",
        tickets: [{ wpOpId: 9004, assigneeOpId: 704, assigneeName: "Not Due Dev", estimatedHours: 3 }],
        lockedAt: "2026-06-09T00:00:00.000Z", // deadline 2026-06-11 23:59:59.999 — still ahead of `now` below
        startDate: "2026-05-20",
        endDate: "2026-06-09",
      });

      const clock = { now: new Date("2026-06-10T12:00:00.000Z") };
      const deps: SprintUpdateSchedulerDeps = {
        listSprints: async () =>
          (await r.sprints.list()).map((s) => ({
            id: s.id,
            end_date: s.end_date,
            status: s.status,
            is_locked: s.is_locked,
            locked_at: s.locked_at,
            frozen_at: s.frozen_at,
          })),
        isVaultLocked: () => false,
        getClientConfigForConnection: async () => null, // no live connection — grace update() best-effort-fails, harmless
        opClientFactory: harness.deps.opClientFactory,
        sprintLifecycleFactory: harness.deps.sprintLifecycleFactory,
        getFreezeGraceDays: async () => (await r.reportConfig.get()).freeze_grace_days,
        freezeSprint: (sprintId, sprintLifecycle) => freezeSprint({ repos: r, sprintLifecycle, now: () => clock.now }, sprintId),
        now: () => clock.now,
        tickMs: 3_600_000, // never fires on its own; tickNow() drives it below
        onError: () => {}, // the best-effort grace update() failing (no connection) is EXPECTED noise
      };

      const scheduler = startSprintUpdateScheduler(deps);
      await scheduler.tickNow(); // ONE tick, ONE `now` — the two sprints must diverge
      scheduler.stop();
      expect(
        (await r.sprints.getById(dueSprintId))!.frozen_at,
        "past its own deadline: frozen by the real scheduler tick",
      ).not.toBeNull();
      expect(
        (await r.sprints.getById(notDueSprintId))!.frozen_at,
        "still ahead of its own deadline: left alone by the SAME tick",
      ).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — Invariant 10 (CAPACITY_BAR_RULES §6.10): a frozen sprint's numbers are
// IDENTICAL before/after mutating OR deleting its work_package_cache rows.
// Seeded via freezeDirectly() (§0: freeze is a snapshot) — no OP needed.
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 31 §5.3 — invariant 10: a frozen sprint is immutable to cache mutation/deletion", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  const DEV_A = { op: 801, name: "Frozen Dev A" };
  const DEV_B = { op: 802, name: "Frozen Dev B" };
  const WP_1 = 9101;
  const WP_2 = 9102;

  it("closure-stats + capacity + items/detailed are byte-identical across a cache MUTATION and then a cache DELETION", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    await setRole(r, DEV_A.op, DEV_A.name, "developer");
    await setRole(r, DEV_B.op, DEV_B.name, "developer");
    const sprintId = await seedClosedSprint(r, {
      name: "invariant-10 sprint",
      tickets: [
        { wpOpId: WP_1, assigneeOpId: DEV_A.op, assigneeName: DEV_A.name, estimatedHours: 10 },
        { wpOpId: WP_2, assigneeOpId: DEV_B.op, assigneeName: DEV_B.name, estimatedHours: 6 },
      ],
      lockedAt: "2026-06-01T00:00:00.000Z",
      startDate: "2026-05-20",
      endDate: "2026-06-01",
      frozen: true,
    });
    const frozen = await harness.repos.sprints.getById(sprintId);
    expect(
      frozen!.frozen_at,
      "precondition: the sprint is actually frozen (repos.sprints.setFrozen — landed by Agent A already)",
    ).not.toBeNull();

    // ⚠️ BLOCKED ON AGENT A (contracts §2c): today computeClosureStats /
    // buildCapacityResponse / buildSprintItemsDetailed read the LIVE
    // work_package_cache unconditionally — they don't yet know to prefer
    // sprint_item.frozen_* when sprint.frozen_at != null. Until that lands,
    // the "before" capture already reads live data (not the frozen snapshot),
    // and mutating/deleting the cache WILL move the numbers — this test is
    // the direct proof that must go green once §2c lands.
    const before = await captureTriple(harness.app, sprintId);

    // (a) MUTATE the live cache: change estimate, assignee, status.
    await r.workPackages.upsertMany([
      wp({ op_id: WP_1, assignee_op_id: DEV_B.op, assignee_name: DEV_B.name, estimated_hours: 999, status_name: "Closed", status_is_closed: true }),
      wp({ op_id: WP_2, assignee_op_id: DEV_A.op, assignee_name: DEV_A.name, estimated_hours: 1, status_name: "Rejected" }),
    ]);
    const afterMutate = await captureTriple(harness.app, sprintId);
    expect(afterMutate.closure, "closure-stats unchanged after cache mutation (invariant 10)").toBe(before.closure);
    expect(afterMutate.capacity, "capacity unchanged after cache mutation (invariant 10)").toBe(before.capacity);
    expect(afterMutate.items, "items/detailed unchanged after cache mutation (invariant 10)").toBe(before.items);

    // (b) DELETE the cache rows outright.
    await r.workPackages.deleteMany([WP_1, WP_2]);
    const afterDelete = await captureTriple(harness.app, sprintId);
    expect(afterDelete.closure, "closure-stats unchanged after cache DELETION (invariant 10)").toBe(before.closure);
    expect(afterDelete.capacity, "capacity unchanged after cache DELETION (invariant 10)").toBe(before.capacity);
    expect(afterDelete.items, "items/detailed unchanged after cache DELETION (invariant 10)").toBe(before.items);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — SPRINT_FROZEN gate + reactivate clears the freeze (frozen_at + every
// sprint_item.frozen_* column), and update() works again afterwards.
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 31 §5.4 — SPRINT_FROZEN gate and reactivate unfreezes", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("POST /update on a frozen sprint -> 409 SPRINT_FROZEN; POST /reactivate (inside the date window) clears frozen_at + every sprint_item.frozen_* column", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    await setRole(r, 811, "Reactivate Dev", "developer");
    const win = windowAroundToday();
    const sprintId = await seedClosedSprint(r, {
      name: "reactivate-frozen sprint",
      tickets: [{ wpOpId: 9201, assigneeOpId: 811, assigneeName: "Reactivate Dev", estimatedHours: 4 }],
      lockedAt: new Date().toISOString(),
      startDate: win.start,
      endDate: win.end,
      frozen: true,
    });

    // ⚠️ BLOCKED ON AGENT A (contracts §2a): the update route must gate on
    // `frozen_at != null` -> AppError("SPRINT_FROZEN", 409). Today it 409s
    // SPRINT_LOCKED for every locked sprint regardless of freeze, so the
    // status code may already match by coincidence but the error CODE will
    // not until the frozen-specific branch is added.
    const updateFrozen = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`);
    expect(updateFrozen.status, `frozen update: ${JSON.stringify(updateFrozen.json)}`).toBe(409);
    expect(errorCode(updateFrozen.json), "the error code must specifically be SPRINT_FROZEN, not SPRINT_LOCKED").toBe(
      "SPRINT_FROZEN",
    );

    const reactivate = await call(harness.app, "POST", `/api/sprints/${sprintId}/reactivate`, {});
    expect(reactivate.status, `reactivate: ${JSON.stringify(reactivate.json)}`).toBeLessThan(300);

    const sprintAfter = await harness.repos.sprints.getById(sprintId);
    expect(sprintAfter!.frozen_at, "reactivate clears frozen_at").toBeNull();
    expect(sprintAfter!.is_locked, "reactivate clears is_locked too (pre-existing SPEC_11 §8b behaviour)").toBe(false);

    const snapshotRows = await rawQuery<{
      frozen_effective_hours: number | null;
      frozen_assignee_op_id: number | null;
      frozen_status_name: string | null;
    }>(harness.raw, `SELECT frozen_effective_hours, frozen_assignee_op_id, frozen_status_name FROM sprint_item WHERE sprint_id = $1`, [
      sprintId,
    ]);
    expect(snapshotRows.length, "the sprint's item(s) exist").toBeGreaterThan(0);
    for (const row of snapshotRows) {
      expect(row.frozen_effective_hours, "reactivate NULLs frozen_effective_hours").toBeNull();
      expect(row.frozen_assignee_op_id, "reactivate NULLs frozen_assignee_op_id").toBeNull();
      expect(row.frozen_status_name, "reactivate NULLs frozen_status_name").toBeNull();
    }

    // update() works again post-reactivate — i.e. the LOCK/FREEZE GATE is
    // open. This repo-seeded sprint's ticket has no live OP connection
    // (connection_id null, no connections registered at all), so a full
    // round-trip 200 isn't achievable here without wiring OP into this
    // specific test — but the gate itself is exactly what §2b/§2a promise,
    // and it must never again answer SPRINT_FROZEN/SPRINT_LOCKED once
    // reactivated. (§5.1's grace-window test, and the S4-backed harness
    // reused across it and §5.4-in-spirit, cover a REAL OP-connected 200.)
    const updateAfter = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`);
    const codeAfter = errorCode(updateAfter.json) ?? "";
    expect(
      codeAfter,
      `the lock/freeze gate must be OPEN after reactivate — update() may still fail for an UNRELATED ` +
        `reason (no OP connection here), but never with SPRINT_FROZEN or SPRINT_LOCKED again: ` +
        `${updateAfter.status} ${JSON.stringify(updateAfter.json)}`,
    ).not.toMatch(/^SPRINT_(FROZEN|LOCKED)$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — Import protection: active/grace sprints protect, frozen sprints don't.
// Seeded via freezeDirectly() + zero import_selection rows (so every cached
// wp is trivially "out of selection" — outOfSelectionContext()'s `inSelection`
// predicate is `selections.some(...)` over an empty list, i.e. always false).
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 31 §5.5 — Import protection: frozen sprints stop protecting their tickets", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  const WP_ACTIVE = 9301;
  const WP_GRACE = 9302;
  const WP_FROZEN = 9303;

  async function setUp(): Promise<{ sprintActive: number; sprintGrace: number; sprintFrozen: number }> {
    harness = await bootRealApp();
    const r = harness.repos;
    await setRole(r, 901, "Import Protect Dev", "developer");

    // ACTIVE (planning -> activate, never closed) protects.
    const sprintActive = await r.sprints.create({
      name: "import-protect ACTIVE sprint",
      start_date: "2026-05-01",
      end_date: "2026-05-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await r.workPackages.upsertMany([wp({ op_id: WP_ACTIVE, assignee_op_id: 901, assignee_name: "Import Protect Dev", estimated_hours: 3 })]);
    await r.sprintItems.add({ sprint_id: sprintActive.id, wp_op_id: WP_ACTIVE, planned_hours: 3, outcome: "planned", origin: "baseline" });
    await r.sprints.activate(sprintActive.id, "2026-05-01T00:00:00.000Z", 3);

    // GRACE (closed + locked + NOT frozen) still protects.
    const sprintGrace = await seedClosedSprint(r, {
      name: "import-protect GRACE sprint",
      tickets: [{ wpOpId: WP_GRACE, assigneeOpId: 901, assigneeName: "Import Protect Dev", estimatedHours: 4 }],
      lockedAt: "2026-05-10T00:00:00.000Z",
      startDate: "2026-05-01",
      endDate: "2026-05-10",
    });

    // FROZEN — no longer protects.
    const sprintFrozen = await seedClosedSprint(r, {
      name: "import-protect FROZEN sprint",
      tickets: [{ wpOpId: WP_FROZEN, assigneeOpId: 901, assigneeName: "Import Protect Dev", estimatedHours: 5 }],
      lockedAt: "2026-04-20T00:00:00.000Z",
      startDate: "2026-04-10",
      endDate: "2026-04-20",
      frozen: true,
    });

    return { sprintActive: sprintActive.id, sprintGrace, sprintFrozen };
  }

  it("GET out-of-selection: active + grace tickets are protected:true; the frozen-only ticket is protected:false with frozen_sprint_names populated", async () => {
    const { sprintFrozen } = await setUp();
    const res = await call(harness!.app, "GET", "/api/backlog/out-of-selection");
    expect(res.status, `out-of-selection: ${JSON.stringify(res.json)}`).toBe(200);
    const body = res.json as OutOfSelectionResponse;
    const byId = new Map(body.entries.map((e) => [e.op_id, e]));

    const active = byId.get(WP_ACTIVE);
    const grace = byId.get(WP_GRACE);
    const frozen = byId.get(WP_FROZEN);
    expect(active, `#${WP_ACTIVE} listed`).toBeTruthy();
    expect(grace, `#${WP_GRACE} listed`).toBeTruthy();
    expect(frozen, `#${WP_FROZEN} listed`).toBeTruthy();

    expect(active!.protected, "active-sprint ticket is protected").toBe(true);
    expect(grace!.protected, "closed-in-grace-sprint ticket is protected").toBe(true);
    // ⚠️ BLOCKED ON AGENT A (contracts §3): the route today derives `in_sprint`
    // from "ANY sprint" with no `protected` field at all — this is the direct
    // proof of the revised rule (protected iff a NON-frozen sprint references
    // the ticket).
    expect(frozen!.protected, "frozen-sprint-ONLY ticket is NOT protected").toBe(false);
    expect(frozen!.in_sprint, "in_sprint stays true (informational: member of SOME sprint)").toBe(true);
    expect(frozen!.frozen_sprint_names.length, "frozen_sprint_names names the frozen sprint").toBeGreaterThan(0);
    const sprintFrozenRow = await harness!.repos.sprints.getById(sprintFrozen);
    expect(frozen!.frozen_sprint_names).toContain(sprintFrozenRow!.name);
  });

  it("bulk delete removes the frozen-only ticket, rejects the two protected ones, and the frozen sprint's numbers are unchanged afterwards", async () => {
    const { sprintFrozen } = await setUp();
    const before = await captureTriple(harness!.app, sprintFrozen);

    const del = await call(harness!.app, "POST", "/api/backlog/out-of-selection/delete", {
      op_ids: [WP_ACTIVE, WP_GRACE, WP_FROZEN],
    });
    expect(del.status, `delete: ${JSON.stringify(del.json)}`).toBe(200);
    const body = del.json as DeleteOutOfSelectionResponse;
    expect(body.removed, "only the frozen-only ticket is deletable").toEqual([WP_FROZEN]);
    const protectedIds = body.protected.map((p) => p.op_id).sort((a, b) => a - b);
    expect(protectedIds, "the active + grace tickets are rejected as protected").toEqual(
      [WP_ACTIVE, WP_GRACE].sort((a, b) => a - b),
    );

    expect(await harness!.repos.workPackages.getManyByOpIds([WP_FROZEN]), "the frozen ticket's cache row is gone").toHaveLength(0);
    expect(await harness!.repos.workPackages.getManyByOpIds([WP_ACTIVE]), "the active ticket survives").toHaveLength(1);
    expect(await harness!.repos.workPackages.getManyByOpIds([WP_GRACE]), "the grace ticket survives").toHaveLength(1);

    // Invariant 10, again: deleting the frozen sprint's own cache row through
    // THIS endpoint (not a raw repos.workPackages.deleteMany call) must be
    // just as harmless as §5.3 proved directly.
    const after = await captureTriple(harness!.app, sprintFrozen);
    expect(after.closure, "the frozen sprint's closure-stats are unchanged by the import cleanup").toBe(before.closure);
    expect(after.capacity, "the frozen sprint's capacity numbers are unchanged by the import cleanup").toBe(before.capacity);
    expect(after.items, "the frozen sprint's items/detailed are unchanged by the import cleanup").toBe(before.items);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 — Config: GET/PUT /api/config round-trips both fields; validation.
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 31 §5.6 — GET/PUT /api/config", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("GET /api/config defaults to {overshoot_threshold_pct: 25, freeze_grace_days: 3}", async () => {
    harness = await bootRealApp();
    // ⚠️ BLOCKED ON AGENT A (contracts §3): GET /api/config does not exist yet
    // (apps/api/src/routes/index.ts has no /config route) — expect 404 today.
    const res = await call(harness.app, "GET", "/api/config");
    expect(res.status, `GET /api/config: ${JSON.stringify(res.json)}`).toBe(200);
    const body = AppConfigResponse.parse(res.json);
    expect(body.overshoot_threshold_pct).toBe(25);
    expect(body.freeze_grace_days).toBe(3);
  });

  it("PUT /api/config round-trips overshoot_threshold_pct and freeze_grace_days independently", async () => {
    harness = await bootRealApp();
    const put1 = await call(harness.app, "PUT", "/api/config", { freeze_grace_days: 7 });
    expect(put1.status, `PUT freeze_grace_days: ${JSON.stringify(put1.json)}`).toBe(200);
    expect(AppConfigResponse.parse(put1.json).freeze_grace_days).toBe(7);
    // The OTHER field is untouched by a partial PUT.
    expect(AppConfigResponse.parse(put1.json).overshoot_threshold_pct).toBe(25);

    const put2 = await call(harness.app, "PUT", "/api/config", { overshoot_threshold_pct: 40 });
    expect(put2.status, `PUT overshoot_threshold_pct: ${JSON.stringify(put2.json)}`).toBe(200);
    const body2 = AppConfigResponse.parse(put2.json);
    expect(body2.overshoot_threshold_pct).toBe(40);
    expect(body2.freeze_grace_days, "freeze_grace_days survives the OTHER field's update").toBe(7);

    const get = await call(harness.app, "GET", "/api/config");
    expect(AppConfigResponse.parse(get.json)).toEqual({ overshoot_threshold_pct: 40, freeze_grace_days: 7 });
  });

  it("PUT /api/config rejects freeze_grace_days outside 0-60", async () => {
    harness = await bootRealApp();
    for (const bad of [61, -1]) {
      const res = await call(harness.app, "PUT", "/api/config", { freeze_grace_days: bad });
      expect(res.status, `freeze_grace_days=${bad}: ${JSON.stringify(res.json)}`).toBe(400);
    }
  });

  it("PUT /api/config with neither field present is rejected (the frozen zod .refine())", async () => {
    harness = await bootRealApp();
    const res = await call(harness.app, "PUT", "/api/config", {});
    expect(res.status, `empty body: ${JSON.stringify(res.json)}`).toBe(400);
  });
});
