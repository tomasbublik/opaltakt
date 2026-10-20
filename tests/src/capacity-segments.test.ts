import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  CapacityResponse,
  SprintResponse,
  SyncRun,
  type CapacityLine,
} from "@osp/contracts";
import { addDays, mockAdmin, type MockAdmin, S4 } from "./scenario-helpers";
import { activateSprint, bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * SPEC_05 §8 — CAPACITY SEGMENT MATH gate (Agent D, review-grade).
 *
 * Drives the REAL Fastify app + REAL sync/lifecycle engine against a recording
 * mock loaded with S4 (volatile-sprint) — the scenario SPEC_05 §7 built for
 * exactly this: activate → add-mid-sprint (urgent) → remove-one → verify the
 * green/red/blue segments and the current-committed delta.
 *
 * The acceptance bar is the FROZEN design note at the top of
 * apps/api/src/logic/scopeCapacity.ts:
 *   baseline_hours = Σ planned_hours of origin="baseline" items REGARDLESS of
 *                    current outcome (frozen at activation, never shrinks).
 *   added_hours    = Σ planned_hours of origin="added_mid_sprint" items,
 *                    EXCLUDING outcome="removed_mid_sprint" (add-then-remove=0).
 *   removed_hours  = Σ planned_hours of origin="baseline" AND
 *                    outcome="removed_mid_sprint" items ONLY.
 *   available_hours frozen at activation, NEVER changes on scope change.
 *   planned_hours (back-compat) = baseline + added - removed = current committed.
 *   overloaded = available > 0 && current_committed > available.
 *   baseline_total_hours = null pre-activation; the leaf-effort baseline sum after.
 *
 * These cases go through the REAL HTTP routes (POST /items, DELETE /items/:wp,
 * GET /capacity) — this is an INTEGRATION gate, not a unit test of the pure
 * accumulateCapacitySegments helper (that lives in apps/api unit tests).
 *
 * CLOCK: booted with a MUTABLE logical clock aligned to the mock's calendar
 * (2026-07-0X) so mid-sprint add/remove timestamps line up with the scenario
 * calendar exactly as Increment 4's lifecycle suite needs.
 */

// Cast (fixtures/scenarios/helpers.ts): dev=1, tester=2, customer=3.
const DEV = { id: 1, name: "Dev Dvořák" };
const TESTER = { id: 2, name: "Tereza Testerová" };

// S4 seed (project 3): estimates are frozen fixture data.
const SESSION = 1401; // dev, est 12  (baseline)
const E2E = 1403; // tester, est 8  (baseline)
const DB_DRIVER = 1405; // dev, est 6  (baseline — the one we remove)
const URGENT_LOGIN = 1451; // dev, est 6 — appears in OP on day 3, added mid-sprint

const DEV_AVAILABLE = 20;
const TESTER_AVAILABLE = 10;

function expectOk(res: { status: number; json: unknown }, what: string): void {
  expect(
    res.status,
    `${what} — expected 2xx but got ${res.status}: ${JSON.stringify(res.json)}`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status, `${what}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
}

function line(cap: CapacityResponse, opUserId: number): CapacityLine {
  const l = cap.lines.find((x) => x.op_user_id === opUserId);
  if (!l) throw new Error(`no capacity line for op_user_id=${opUserId}`);
  return l;
}

interface Ctx {
  mock: RecordingMockOpServer;
  admin: MockAdmin;
  harness: RealApp;
  dir: string;
  sprintId: number;
  activatedSprint: unknown;
  capacityPlanning: CapacityResponse;
  capA: CapacityResponse; // post-activate
  capB: CapacityResponse; // post-add (URGENT_LOGIN → dev)
  capC: CapacityResponse; // post-remove (DB_DRIVER, a dev baseline)
  sprintsList: unknown;
}

describe("SPEC_05 §8 — capacity segments end-to-end (S4 volatile-sprint)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "osp-capacity-segments-"));
    const mock = await createRecordingMockOpServer();
    const admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);

    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    const harness = await bootRealApp({
      now: () => clock.now,
    });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    expect(d0).toBe("2026-07-01");

    await connectToOp(harness.app, mock.url, "s4-token", 3);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expectOk(sync, "initial sync");
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 capacity sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    expectOk(created, "create sprint");
    const sprintId = SprintResponse.parse(created.json).id;

    // Baseline scope: dev {1401:12, 1405:6} = 18, tester {1403:8} = 8.
    for (const wpId of [SESSION, E2E, DB_DRIVER]) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wpId }),
        `add baseline item ${wpId}`,
      );
    }

    // Per-person capacity (frozen at activation): dev 20, tester 10 so we can
    // watch overload flip when scope creep pushes dev's committed past 20.
    expectOk(
      await call(harness.app, "PUT", `/api/sprints/${sprintId}/capacity`, {
        members: [
          { op_user_id: DEV.id, name: DEV.name, available_hours: DEV_AVAILABLE, pto_days: 0 },
          { op_user_id: TESTER.id, name: TESTER.name, available_hours: TESTER_AVAILABLE, pto_days: 0 },
        ],
      }),
      "set capacity",
    );

    // (f) + (e): pre-activation the segments are all 0 and baseline_total is null.
    const planningRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(planningRes, "GET capacity (planning)");
    const capacityPlanning = CapacityResponse.parse(planningRes.json);

    // ── ACTIVATE (planning → active) ─────────────────────────────────────────
    // SPEC_09 §1: async activation — wait for the run, then re-fetch the real
    // post-activation Sprint (POST /activate itself now returns the run, not
    // the Sprint).
    const activated = await activateSprint(harness.app, sprintId);
    expectOk(activated, "POST /activate");
    const sprintsAfterActivate = await call(harness.app, "GET", "/api/sprints");
    const activatedSprint = (sprintsAfterActivate.json as Array<{ id: number }>).find(
      (s) => s.id === sprintId,
    );

    const aRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(aRes, "GET capacity (post-activate)");
    const capA = CapacityResponse.parse(aRes.json);

    // Advance to day 3 so the urgent WPs (1451..1453) exist in OP — we DO NOT
    // re-sync, proving the mid-sprint add can dočíst a cold-cache WP from OP.
    for (let n = 1; n <= 3; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
    }

    // (b) Add URGENT_LOGIN (dev, est 6) to the ACTIVE sprint.
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: URGENT_LOGIN }),
      "add mid-sprint URGENT_LOGIN",
    );
    const bRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(bRes, "GET capacity (post-add)");
    const capB = CapacityResponse.parse(bRes.json);

    // (c) Remove DB_DRIVER (dev baseline, est 6) from the ACTIVE sprint.
    expectOk(
      await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${DB_DRIVER}`),
      "remove mid-sprint DB_DRIVER",
    );
    const cRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(cRes, "GET capacity (post-remove)");
    const capC = CapacityResponse.parse(cRes.json);

    const list = await call(harness.app, "GET", "/api/sprints");
    expectOk(list, "GET /sprints");

    ctx = {
      mock,
      admin,
      harness,
      dir,
      sprintId,
      activatedSprint,
      capacityPlanning,
      capA,
      capB,
      capC,
      sprintsList: list.json,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.harness.close();
    await ctx.mock.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });

  // (f) Planning-phase behavioral invariant (MUST hold): planned/available/
  // overloaded/added/removed behave exactly as before Increment 5, and
  // baseline_total_hours is null before activation (e).
  it("planning-phase preserves pre-Increment-5 planned/available + added=removed=0 + null baseline_total", () => {
    expect(ctx.capacityPlanning.baseline_total_hours).toBeNull();
    for (const l of ctx.capacityPlanning.lines) {
      expect(l.added_hours, `${l.name} added_hours`).toBe(0);
      expect(l.removed_hours, `${l.name} removed_hours`).toBe(0);
    }
    // planned_hours behaves exactly as before Increment 5 (live effective sum).
    expect(line(ctx.capacityPlanning, DEV.id).planned_hours).toBe(18);
    expect(line(ctx.capacityPlanning, TESTER.id).planned_hours).toBe(8);
    expect(line(ctx.capacityPlanning, DEV.id).overloaded).toBe(false);
  });

  // (f) RECONCILED (was tracked as a deviation from scopeCapacity.ts's original
  // "literal zero" wording — see Agent D's report): a planning-phase sprint
  // reports baseline_hours = the live planned sum (NOT a literal 0) on every
  // line, added/removed = 0. This is INTENTIONAL: computeCapacity derives
  // segments purely from each item's origin/outcome, and a planning-phase item
  // is always origin="baseline"/outcome="planned" (mid-sprint add/remove only
  // exist once a sprint is active) — so segments naturally degenerate to
  // "everything is baseline" without a separate activation gate. This is BETTER
  // than a forced literal zero: a zero baseline would render an EMPTY capacity
  // bar during planning even with real planned work, a visual regression vs.
  // pre-Increment-5. baseline_hours == planned_hours here is the correct,
  // intended behavior — the design doc's header comment has been updated to
  // match. See computeCapacity's own doc comment in apps/api/src/logic/capacity.ts.
  it("planning-phase reports baseline_hours = the live planned sum (not a literal 0) — CONFIRMED, not a bug", () => {
    for (const l of ctx.capacityPlanning.lines) {
      expect(l.baseline_hours, `${l.name} baseline_hours`).toBe(l.planned_hours);
      expect(l.added_hours, `${l.name} added_hours`).toBe(0);
      expect(l.removed_hours, `${l.name} removed_hours`).toBe(0);
    }
  });

  // (a) Post-activation: baseline_hours = each person's baseline sum, others 0.
  it("activation freezes baseline_hours per person; added=removed=0; planned=baseline", () => {
    const dev = line(ctx.capA, DEV.id);
    expect(dev.baseline_hours).toBe(18); // 1401(12) + 1405(6)
    expect(dev.added_hours).toBe(0);
    expect(dev.removed_hours).toBe(0);
    expect(dev.planned_hours).toBe(18);
    expect(dev.available_hours).toBe(DEV_AVAILABLE);
    expect(dev.overloaded).toBe(false);

    const tester = line(ctx.capA, TESTER.id);
    expect(tester.baseline_hours).toBe(8); // 1403(8)
    expect(tester.added_hours).toBe(0);
    expect(tester.removed_hours).toBe(0);
    expect(tester.planned_hours).toBe(8);
  });

  // (e) baseline_total_hours surfaces post-activation and matches the sprint.
  it("baseline_total_hours = Σ leaf baseline effort (26h) and matches the activated sprint", () => {
    expect(ctx.capA.baseline_total_hours).toBe(26); // 12 + 8 + 6
    const activated = SprintResponse.parse(ctx.activatedSprint);
    expect(activated.baseline_total_hours).toBe(26);
    // …and the same value surfaces on GET /sprints.
    const fromList = (ctx.sprintsList as Array<{ id: number; baseline_total_hours: number | null }>).find(
      (s) => s.id === ctx.sprintId,
    );
    expect(fromList?.baseline_total_hours).toBe(26);
  });

  // (b) Mid-sprint add: red grows, baseline unchanged, available UNCHANGED, overload flips.
  it("adding a mid-sprint ticket grows added_hours only; baseline + available unchanged; overload flips true", () => {
    const dev = line(ctx.capB, DEV.id);
    expect(dev.baseline_hours).toBe(18); // frozen — unchanged
    expect(dev.added_hours).toBe(6); // URGENT_LOGIN
    expect(dev.removed_hours).toBe(0);
    expect(dev.planned_hours).toBe(24); // 18 + 6 - 0 (current committed)
    expect(dev.available_hours).toBe(DEV_AVAILABLE); // NEVER grows (SPEC_05 §1)
    expect(dev.overloaded).toBe(true); // 24 > 20

    // Tester untouched by dev's scope change.
    const tester = line(ctx.capB, TESTER.id);
    expect(tester.baseline_hours).toBe(8);
    expect(tester.added_hours).toBe(0);
    expect(tester.planned_hours).toBe(8);
    expect(tester.overloaded).toBe(false);

    // baseline_total_hours stays frozen through scope creep.
    expect(ctx.capB.baseline_total_hours).toBe(26);
  });

  // (c) Mid-sprint remove of a baseline: blue grows, baseline STAYS, committed drops.
  it("removing a baseline ticket grows removed_hours; baseline_hours frozen; committed drops; overload clears", () => {
    const dev = line(ctx.capC, DEV.id);
    expect(dev.baseline_hours).toBe(18); // frozen — does NOT shrink on removal
    expect(dev.added_hours).toBe(6); // URGENT_LOGIN still committed
    expect(dev.removed_hours).toBe(6); // DB_DRIVER (a baseline) removed
    expect(dev.planned_hours).toBe(18); // 18 + 6 - 6
    expect(dev.available_hours).toBe(DEV_AVAILABLE);
    expect(dev.overloaded).toBe(false); // 18 <= 20 again
    expect(ctx.capC.baseline_total_hours).toBe(26); // still frozen
  });

  // §8 / §2: green + red + blue combine on ONE person and the derived bars sum right.
  it("dev shows green+red+blue combined; derived bar segments sum to the frozen numbers", () => {
    const dev = line(ctx.capC, DEV.id);
    // Frontend-derived bars (SPEC_05 §2): green = baseline - removed, red =
    // added, blue = removed. All three non-zero on the same member.
    const green = dev.baseline_hours - dev.removed_hours;
    const red = dev.added_hours;
    const blue = dev.removed_hours;
    expect(green).toBe(12);
    expect(red).toBe(6);
    expect(blue).toBe(6);
    // current committed = green + red = 18 = planned_hours.
    expect(green + red).toBe(dev.planned_hours);
  });
});

/**
 * (d) THE net-zero edge case (SPEC_05 §2, most important): a ticket ADDED
 * mid-sprint and THEN removed mid-sprint contributes ZERO to both added_hours
 * and removed_hours (never double-booked). Isolated in its own harness so no
 * other scope change can mask it.
 */
describe("SPEC_05 §8 — add-then-remove nets to zero (the double-bookkeeping edge)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let injectedId: number;
  let capBefore: CapacityResponse;
  let capAfterAdd: CapacityResponse;
  let capAfterRemove: CapacityResponse;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-net-zero-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 net-zero sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    // dev baseline = 1401 (12h).
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: SESSION }),
      "add baseline 1401",
    );
    expectOk(
      await call(harness.app, "PUT", `/api/sprints/${sprintId}/capacity`, {
        members: [{ op_user_id: DEV.id, name: DEV.name, available_hours: DEV_AVAILABLE, pto_days: 0 }],
      }),
      "set capacity",
    );
    expectOk(await activateSprint(harness.app, sprintId), "activate");

    capBefore = CapacityResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`)).json,
    );

    // A brand-new escalation (assignee dev, est 5) injected straight into OP.
    const injected = await admin.injectUrgent();
    injectedId = injected.work_package.id;
    clock.now = new Date("2026-07-03T12:00:00.000Z");

    // ADD it mid-sprint…
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: injectedId }),
      "add injected mid-sprint",
    );
    capAfterAdd = CapacityResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`)).json,
    );

    // …then REMOVE the SAME ticket mid-sprint.
    expectOk(
      await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${injectedId}`),
      "remove injected mid-sprint",
    );
    capAfterRemove = CapacityResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`)).json,
    );
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("the add alone bumps added_hours; the subsequent remove of the SAME added ticket nets it to zero", () => {
    const devAdd = line(capAfterAdd, DEV.id);
    expect(devAdd.added_hours).toBeGreaterThan(0); // it was really added first
    expect(devAdd.planned_hours).toBe(12 + devAdd.added_hours);

    const devFinal = line(capAfterRemove, DEV.id);
    // Net zero: an added→removed ticket contributes to NEITHER red NOR blue.
    expect(devFinal.added_hours).toBe(0);
    expect(devFinal.removed_hours).toBe(0); // it was NOT a baseline → never in blue
    expect(devFinal.baseline_hours).toBe(12); // unchanged
    expect(devFinal.planned_hours).toBe(12); // back to baseline exactly
    // Still owns baseline work → line stays (has_sprint_work true).
    expect(devFinal.has_sprint_work).toBe(true);
  });
});
