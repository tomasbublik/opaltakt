import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  BacklogResponse,
  BurndownResponse,
  ClosureReportResponse,
  SprintItemResponse,
  SprintItemsResponse,
  SprintResponse,
  SyncRefreshAllResponse,
  SyncRun,
  VelocityResponse,
  VersionExportResponse,
} from "@osp/contracts";
import {
  addDays,
  mockAdmin,
  OPERATOR_MARK,
  S3,
  S4,
  S5,
  S6,
  type MockAdmin,
} from "./scenario-helpers";
import { bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * SPEC_03 §9 "End-to-end" + Phase 2 smoke: the REAL app (Fastify + sync +
 * vault) against the scenario mock. The test is TWO clients at once:
 *
 *   - the app operator (driving /api/* of the Sprint Planner), and
 *   - the mock operator (driving /__mock/* directly, tagged ?operator=1).
 *
 * The recording mock then proves the hard invariant: the app itself produced
 * exclusively GET /api/v3/* traffic — every non-GET request the mock ever saw
 * is one of OUR tagged /__mock/* admin calls.
 */

interface Ctx {
  mock: RecordingMockOpServer;
  admin: MockAdmin;
  harness: RealApp;
  dir: string;
}

async function bootCtx(): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), "osp-scenario-e2e-"));
  const mock = await createRecordingMockOpServer();
  const harness = await bootRealApp();
  return { mock, admin: mockAdmin(mock.url), harness, dir };
}

async function closeCtx(ctx: Ctx | undefined): Promise<void> {
  if (!ctx) return;
  await ctx.harness.close();
  await ctx.mock.close();
  await rm(ctx.dir, { recursive: true, force: true });
}

/** The recording-based read-only proof, shared by the e2e tests below. */
function assertAppTrafficReadOnly(mock: RecordingMockOpServer): void {
  const v3 = mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
  expect(v3.length).toBeGreaterThan(0);
  expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));

  // Every non-GET the mock ever saw lives in the operator namespace…
  const nonGet = mock.requests.filter((r) => r.method !== "GET");
  for (const r of nonGet) {
    expect(r.path.startsWith("/__mock/"), `${r.method} ${r.path}`).toBe(true);
  }
  // …and every /__mock request carries OUR operator tag — i.e. the app made none.
  const adminReqs = mock.requests.filter((r) => r.path.startsWith("/__mock/"));
  for (const r of adminReqs) {
    expect(r.search.includes(OPERATOR_MARK), `${r.method} ${r.path}${r.search}`).toBe(
      true,
    );
  }
}

/**
 * Increment 23 (SPEC_23 §1) — `POST /api/sync` returns a bare `SyncRun` for a
 * single-project call (`project_op_id` given) UNCHANGED, but a
 * `SyncRefreshAllResponse` (per-connection breakdown) for a refresh-all call
 * (`{}`/no `project_op_id`) — discriminate on that, mirroring apps/web's own
 * `isSyncRefreshAllResponse` type guard, and assert every connection in the
 * breakdown actually synced (these scenario tests run against one healthy
 * connection, so "ok" means "synced", not "skipped"/"error").
 */
async function syncOk(
  ctx: Ctx,
  body: Record<string, unknown> = {},
): Promise<void> {
  const res = await call(ctx.harness.app, "POST", "/api/sync", body);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  if (body.project_op_id != null) {
    expect(SyncRun.parse(res.json).status).toBe("success");
    return;
  }
  const refreshed = SyncRefreshAllResponse.parse(res.json);
  expect(refreshed.connections.length).toBeGreaterThan(0);
  for (const outcome of refreshed.connections) {
    expect(outcome.status, JSON.stringify(outcome)).toBe("synced");
  }
}

async function snapshotAt(ctx: Ctx, date: string): Promise<void> {
  const res = await call(ctx.harness.app, "POST", "/api/snapshot", { date });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function backlogIds(ctx: Ctx): Promise<BacklogResponse> {
  const res = await call(ctx.harness.app, "GET", "/api/backlog?projectId=3");
  expect(res.status).toBe(200);
  return BacklogResponse.parse(res.json);
}

describe("scenario e2e — S4 volatile sprint (scope churn end to end)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootCtx();
    await ctx.admin.requireScenario(S4);
  }, 60_000);
  afterAll(async () => {
    await closeCtx(ctx);
  });

  it("urgent day-3 WPs reach the backlog via incremental sync; local scope-out and burndown reflect the churn; app stays GET-only", async () => {
    const { harness, admin } = ctx;
    const loaded = await admin.load(S4);
    const d0 = loaded.date!;

    await connectToOp(harness.app, ctx.mock.url, "scenario-token", 3);
    await syncOk(ctx, { project_op_id: 3 }); // first import: full

    const backlog0 = await backlogIds(ctx);
    expect(backlog0.length).toBeGreaterThan(0);

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 churn sprint",
      start_date: d0,
      end_date: addDays(d0, 11),
    });
    expect(created.status).toBe(201);
    const sprintId = SprintResponse.parse(created.json).id;

    for (const wp of backlog0) {
      const added = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
        wp_op_id: wp.op_id,
      });
      expect(added.status, JSON.stringify(added.json)).toBe(201);
    }
    const activated = await call(harness.app, "PATCH", `/api/sprints/${sprintId}`, {
      status: "active",
    });
    expect(activated.status).toBe(200);
    await snapshotAt(ctx, d0);

    // Days 1–2: the mock's clock moves; the app re-syncs and snapshots per day.
    const snapDates = [d0];
    for (let n = 1; n <= 2; n += 1) {
      const adv = await admin.advanceDay();
      expect(adv.day).toBe(n);
      await syncOk(ctx); // {} = refresh all imported (full)
      await snapshotAt(ctx, adv.date);
      snapDates.push(adv.date);
    }

    // Day 3 — the churn day. An INCREMENTAL sync must catch the new WPs.
    const adv3 = await admin.advanceDay();
    expect(adv3.day).toBe(3);
    await syncOk(ctx, { project_op_id: 3, kind: "incremental" });

    const backlog3 = await backlogIds(ctx);
    const before = new Set(backlog0.map((b) => b.op_id));
    const urgent = backlog3.filter((b) => !before.has(b.op_id));
    expect(
      urgent.length,
      "day 3 must surface 2-3 new URGENT WPs in the backlog (SPEC_03 §2d)",
    ).toBeGreaterThanOrEqual(2);
    expect(urgent.length).toBeLessThanOrEqual(3);

    // Baseline total before the local scope changes.
    const bdBefore = await call(harness.app, "GET", `/api/sprints/${sprintId}/burndown`);
    expect(bdBefore.status).toBe(200);
    const totalBefore = BurndownResponse.parse(bdBefore.json).total_planned_hours;

    // Scope IN: one urgent WP joins the running sprint.
    const urgentWp = urgent[0]!;
    const addedUrgent = await call(
      harness.app,
      "POST",
      `/api/sprints/${sprintId}/items`,
      { wp_op_id: urgentWp.op_id },
    );
    expect(addedUrgent.status).toBe(201);
    const urgentItem = SprintItemResponse.parse(addedUrgent.json);

    // Scope OUT is a LOCAL action (SPEC_03 §2 note): drop one original item.
    // Pick a flat WP (no parent, not a parent) so the leaf math stays additive.
    const parents = new Set(
      backlog3.map((b) => b.parent_op_id).filter((p): p is number => p != null),
    );
    const removable = backlog0.find(
      (b) =>
        b.op_id !== urgentWp.op_id &&
        b.parent_op_id === null &&
        !parents.has(b.op_id),
    );
    expect(removable, "s4 needs at least one flat original WP to scope out").toBeDefined();

    const itemsRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/items`);
    const items = SprintItemsResponse.parse(itemsRes.json);
    const removedItem = items.find((i) => i.wp_op_id === removable!.op_id)!;

    const del = await call(
      harness.app,
      "DELETE",
      `/api/sprints/${sprintId}/items/${removable!.op_id}`,
    );
    expect(del.status).toBe(200);
    await snapshotAt(ctx, adv3.date);
    snapDates.push(adv3.date);

    // Burndown: points exist for the logical dates; post-activation the total
    // stays ANCHORED to the activation baseline (SPEC_05 §4 / scopeCapacity.ts
    // §181-195: the ideal line is frozen so scope creep shows as remaining/logged
    // diverging from a FIXED reference — total_planned_hours no longer moves with
    // mid-sprint add/remove). `totalBefore` was read post-activation with no scope
    // change, so it already equals the frozen baseline.
    const bdRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/burndown`);
    expect(bdRes.status).toBe(200);
    const bd = BurndownResponse.parse(bdRes.json);
    const pointByDate = new Map(bd.points.map((p) => [p.date, p]));
    const snapshotted = snapDates.filter((d) => pointByDate.has(d)); // working days only
    expect(snapshotted.length).toBeGreaterThan(0);
    for (const d of snapshotted) {
      expect(
        pointByDate.get(d)!.remaining_hours,
        `snapshot for logical day ${d} must be on the curve`,
      ).not.toBeNull();
    }
    // Reference the once-used locals so the scope-change intent stays documented.
    void urgentItem;
    void removedItem;
    expect(bd.total_planned_hours).toBeCloseTo(totalBefore, 6);

    // THE invariant: the app spoke to OpenProject with GET /api/v3/* only.
    assertAppTrafficReadOnly(ctx.mock);
  }, 120_000);
});

describe("scenario e2e — S6 carryover (closure report + version export)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootCtx();
    await ctx.admin.requireScenario(S6);
  }, 60_000);
  afterAll(async () => {
    await closeCtx(ctx);
  });

  it("close splits done vs the two unfinished (On hold + Merge pending); carried outcomes; version-export deep-links exactly those two", async () => {
    const { harness, admin } = ctx;
    const loaded = await admin.load(S6);
    const d0 = loaded.date!;
    const fiveIds = loaded.work_packages.map((w) => w.id);
    expect(fiveIds).toHaveLength(5);

    await connectToOp(harness.app, ctx.mock.url, "scenario-token", 3);

    // Fast-forward to the end of the sprint's story, then pull the final truth.
    await admin.gotoDay(loaded.total_days);
    await syncOk(ctx, { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S6 closing sprint",
      start_date: d0,
      end_date: addDays(d0, Math.max(loaded.total_days, 5)),
    });
    expect(created.status).toBe(201);
    const sprintId = SprintResponse.parse(created.json).id;

    for (const opId of fiveIds) {
      const added = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
        wp_op_id: opId,
      });
      expect(added.status, `WP ${opId}: ${JSON.stringify(added.json)}`).toBe(201);
    }
    await call(harness.app, "PATCH", `/api/sprints/${sprintId}`, { status: "active" });

    // "Tested per rules": dev-done statuses are configurable (SPEC §6 / SPEC_03
    // §2b). Seed the rule the same way the app's config layer stores it.
    await harness.repos.doneStatusRules.replaceForSprint(sprintId, [
      { sprint_id: sprintId, status_name: "Tested", counts_as: "done" },
    ]);

    // Increment 11 (SPEC_11 §8a): /close is now a non-locking "view/regenerate"
    // read — persisting outcomes + the irreversible lock is exclusive to
    // /finish. This test asserts locked-in outcomes, so it must call /finish.
    const closed = await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`);
    expect(closed.status).toBe(200);
    const report = ClosureReportResponse.parse(closed.json);

    // The scenario contract: exactly two unfinished — "On hold" + "Merge pending".
    expect(report.done.length + report.not_done.length).toBe(5);
    expect(report.not_done).toHaveLength(2);
    expect(new Set(report.not_done.map((i) => i.status_name))).toEqual(
      new Set(["On hold", "Merge pending"]),
    );
    for (const d of report.done) {
      expect(["Closed", "Resolved", "Tested"]).toContain(d.status_name);
    }

    // Outcomes persisted: the two unfinished are CARRIED, the rest done.
    const itemsRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/items`);
    const items = SprintItemsResponse.parse(itemsRes.json);
    const notDoneIds = new Set(report.not_done.map((i) => i.wp_op_id));
    for (const item of items) {
      expect(item.outcome, `WP ${item.wp_op_id}`).toBe(
        notDoneIds.has(item.wp_op_id) ? "carried" : "done",
      );
    }

    // Version export deep-links EXACTLY the two carryover ids.
    const exportRes = await call(
      harness.app,
      "GET",
      `/api/sprints/${sprintId}/version-export`,
    );
    expect(exportRes.status).toBe(200);
    const exported = VersionExportResponse.parse(exportRes.json);
    expect(new Set(exported.wp_op_ids)).toEqual(notDoneIds);
    for (const id of notDoneIds) {
      expect(exported.deep_link).toContain(String(id));
    }

    assertAppTrafficReadOnly(ctx.mock);
  }, 120_000);
});

describe("scenario e2e — S3 epic across two sprints (carryover lite)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await bootCtx();
    await ctx.admin.requireScenario(S3);
  }, 60_000);
  afterAll(async () => {
    await closeCtx(ctx);
  });

  it("the 80h epic burns through sprint A, carries over, and finishes in sprint B; burndown/velocity stay sane", async () => {
    const { harness, admin } = ctx;
    const loaded = await admin.load(S3);
    const d0 = loaded.date!;
    const epic = loaded.work_packages.find((w) => w.estimated_hours === 80);
    expect(epic, "s3 must seed the 80h epic").toBeDefined();

    await connectToOp(harness.app, ctx.mock.url, "scenario-token", 3);
    await syncOk(ctx, { project_op_id: 3 });

    // ── Sprint A: the epic starts here ───────────────────────────────────────
    const createdA = await call(harness.app, "POST", "/api/sprints", {
      name: "S3 sprint A",
      start_date: d0,
      end_date: addDays(d0, 4),
    });
    const sprintA = SprintResponse.parse(createdA.json).id;
    const addedA = await call(harness.app, "POST", `/api/sprints/${sprintA}/items`, {
      wp_op_id: epic!.id,
    });
    expect(addedA.status).toBe(201);
    await call(harness.app, "PATCH", `/api/sprints/${sprintA}`, { status: "active" });
    await snapshotAt(ctx, d0);

    const snapDates = [d0];
    for (let n = 1; n <= 3; n += 1) {
      const adv = await admin.advanceDay();
      await syncOk(ctx);
      await snapshotAt(ctx, adv.date);
      snapDates.push(adv.date);
    }

    const bdARes = await call(harness.app, "GET", `/api/sprints/${sprintA}/burndown`);
    expect(bdARes.status).toBe(200);
    const bdA = BurndownResponse.parse(bdARes.json);
    // Monotone decline across the snapshotted (working) days.
    const remaining = bdA.points
      .filter((p) => snapDates.includes(p.date) && p.remaining_hours !== null)
      .map((p) => p.remaining_hours!);
    expect(remaining.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < remaining.length; i += 1) {
      expect(remaining[i]!).toBeLessThanOrEqual(remaining[i - 1]!);
    }
    expect(remaining.at(-1)!).toBeLessThan(remaining[0]!);

    // ── Close A: the epic is NOT done → carried ─────────────────────────────
    // Increment 11 (SPEC_11 §8a): outcomes + lock are exclusive to /finish now.
    const closedA = await call(harness.app, "POST", `/api/sprints/${sprintA}/finish`);
    expect(closedA.status).toBe(200);
    const reportA = ClosureReportResponse.parse(closedA.json);
    expect(reportA.not_done.map((i) => i.wp_op_id)).toContain(epic!.id);
    const itemsA = SprintItemsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintA}/items`)).json,
    );
    expect(itemsA.find((i) => i.wp_op_id === epic!.id)?.outcome).toBe("carried");

    // ── Sprint B: re-add the carried epic and let the scenario finish ───────
    const createdB = await call(harness.app, "POST", "/api/sprints", {
      name: "S3 sprint B",
      start_date: addDays(d0, 5),
      end_date: addDays(d0, Math.max(loaded.total_days + 2, 10)),
    });
    const sprintB = SprintResponse.parse(createdB.json).id;
    const addedB = await call(harness.app, "POST", `/api/sprints/${sprintB}/items`, {
      wp_op_id: epic!.id,
    });
    expect(addedB.status, JSON.stringify(addedB.json)).toBe(201);
    await call(harness.app, "PATCH", `/api/sprints/${sprintB}`, { status: "active" });

    await admin.gotoDay(loaded.total_days); // play the story to its end
    await syncOk(ctx);
    const finalState = await admin.state();
    await snapshotAt(ctx, finalState.date!);

    // The epic ended near zero in a dev-done state. NOTE (SPEC_03 §2a/§2c —
    // this is the point of the whole exercise): "done" must NOT require
    // isClosed. The epic finishes as "Tested" (an OPEN status); only a
    // done_status_rule may count it as dev-done.
    const cached = await harness.repos.workPackages.getByOpId(epic!.id);
    expect(cached).toBeDefined();
    expect(cached!.remaining_hours ?? 0).toBeLessThanOrEqual(1); // burned to ~0
    expect(["Developed", "Merge pending", "Tested", "Resolved", "Closed"]).toContain(
      cached!.status_name,
    );

    // Close sprint B with the dev-done rule: the carried epic finally counts DONE.
    await harness.repos.doneStatusRules.replaceForSprint(sprintB, [
      { sprint_id: sprintB, status_name: "Tested", counts_as: "done" },
    ]);
    const closedB = await call(harness.app, "POST", `/api/sprints/${sprintB}/finish`);
    expect(closedB.status).toBe(200);
    const reportB = ClosureReportResponse.parse(closedB.json);
    expect(reportB.done.map((i) => i.wp_op_id)).toContain(epic!.id);
    const itemsB = SprintItemsResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintB}/items`)).json,
    );
    expect(itemsB.find((i) => i.wp_op_id === epic!.id)?.outcome).toBe("done");

    // Burndown + velocity endpoints answer sanely for both sprints (no 500s).
    for (const id of [sprintA, sprintB]) {
      const bd = await call(harness.app, "GET", `/api/sprints/${id}/burndown`);
      expect(bd.status).toBe(200);
      BurndownResponse.parse(bd.json);
      const vel = await call(harness.app, "GET", `/api/sprints/${id}/velocity`);
      expect(vel.status).toBe(200);
      VelocityResponse.parse(vel.json);
    }
    // Sprint A is closed history now — velocity for B must see it.
    const velB = VelocityResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintB}/velocity`)).json,
    );
    expect(velB.history.map((h) => h.sprint_id)).toContain(sprintA);

    assertAppTrafficReadOnly(ctx.mock);
  }, 120_000);
});

describe("scenario e2e — advance-day app helper (SPEC_03 §6, optional sync+snapshot)", () => {
  let ctx: Ctx;
  let appUrl: string;

  beforeAll(async () => {
    ctx = await bootCtx();
    await ctx.admin.requireScenario(S5);
    // The mock calls the app over REAL HTTP → listen on an ephemeral port
    // (same pattern as the SSE test in connections-health.test.ts).
    await ctx.harness.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = ctx.harness.app.server.address() as AddressInfo;
    appUrl = `http://127.0.0.1:${addr.port}`;
  }, 60_000);
  afterAll(async () => {
    await closeCtx(ctx);
  });

  it("advance-day {app_url} reports sync.ok + snapshot.ok and a burndown row appears; a locked vault is reported as a failure", async () => {
    const { harness, admin } = ctx;
    const loaded = await admin.load(S5);
    const d0 = loaded.date!;

    await connectToOp(harness.app, ctx.mock.url, "scenario-token", 3);
    await syncOk(ctx, { project_op_id: 3 });

    const backlog = await backlogIds(ctx);
    expect(backlog.length).toBeGreaterThan(0);
    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S5 happy sprint",
      start_date: d0,
      end_date: addDays(d0, 9),
    });
    const sprintId = SprintResponse.parse(created.json).id;
    await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
      wp_op_id: backlog[0]!.op_id,
    });
    await call(harness.app, "PATCH", `/api/sprints/${sprintId}`, {
      status: "active",
    });

    // ── happy path: the mock advances AND drives the app's sync + snapshot ──
    const adv = await admin.advanceDay({ app_url: appUrl });
    expect(adv.day).toBe(1);
    expect(adv.app?.sync?.ok, JSON.stringify(adv.app)).toBe(true);
    expect(adv.app?.snapshot?.ok, JSON.stringify(adv.app)).toBe(true);

    const rows = await harness.repos.burndown.listBySprint(sprintId);
    expect(
      rows.map((r) => r.snapshot_date),
      "the helper-triggered snapshot must land for the new logical date",
    ).toContain(adv.date);

    // ── failure report: locked vault ⇒ ok:false with the 423/VAULT_LOCKED why ─
    const lock = await call(harness.app, "POST", "/api/vault/lock");
    expect(lock.status).toBeGreaterThanOrEqual(200);
    expect(lock.status).toBeLessThan(300);

    const advLocked = await admin.advanceDay({ app_url: appUrl });
    expect(advLocked.day).toBe(2);
    expect(advLocked.app?.sync?.ok).toBe(false);
    expect(advLocked.app?.sync?.detail ?? "").toMatch(/423|VAULT_LOCKED/i);

    assertAppTrafficReadOnly(ctx.mock);
  }, 120_000);
});
