import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AddConnectionResponse,
  BacklogResponse,
  BacklogFilterOptionsResponse,
  CancelSyncResponse,
  BurndownResponse,
  CapacityResponse,
  ClosureReportResponse,
  ErrorResponse,
  EstimateOverrideResponse,
  ImportsResponse,
  ProjectsResponse,
  SprintItemResponse,
  SprintItemsResponse,
  SprintResponse,
  SprintsResponse,
  SyncRun,
  SyncStatusResponse,
  VelocityResponse,
  VersionExportResponse,
} from "@osp/contracts";
import type { Repositories, NewWorkPackageCache } from "@osp/db";
import { createOpClient, ReadOnlyViolationError } from "@osp/op-client";
import {
  addConnection,
  buildTestApp,
  initVault,
  makeFakeOpClient,
  type TestApp,
} from "../test-utils";

function seedWp(
  repos: Repositories,
  p: Partial<NewWorkPackageCache> & { op_id: number },
): Promise<void> {
  return repos.workPackages.upsertMany([
    {
      op_id: p.op_id,
      project_op_id: p.project_op_id ?? 100,
      subject: p.subject ?? `WP ${p.op_id}`,
      type_name: p.type_name ?? "Task",
      status_name: p.status_name ?? "New",
      status_is_closed: p.status_is_closed ?? false,
      assignee_op_id: p.assignee_op_id ?? null,
      assignee_name: p.assignee_name ?? null,
      estimated_hours: p.estimated_hours ?? null,
      remaining_hours: p.remaining_hours ?? null,
      spent_hours: p.spent_hours ?? null,
      story_points: p.story_points ?? null,
      version_op_id: p.version_op_id ?? null,
      version_name: p.version_name ?? null,
      priority: p.priority ?? null,
      parent_op_id: p.parent_op_id ?? null,
      percentage_done: p.percentage_done ?? null,
      updated_at_op: p.updated_at_op ?? "2026-06-01T00:00:00Z",
      raw_json: p.raw_json ?? "{}",
    },
  ]);
}

/** Increment-2 setup: init (and thereby unlock) the vault, then add a server. */
async function connect(t: TestApp): Promise<void> {
  await initVault(t);
  await addConnection(t);
}

describe("REST contract (app.inject, in-memory DB, faked OP/sync)", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("GET /health", async () => {
    const res = await t.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("POST /connections validates via OP and returns a parseable response", async () => {
    await initVault(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { base_url: "https://op.example.com", token: "tok", default_project_op_id: 100 },
    });
    expect(res.statusCode).toBe(201);
    const parsed = AddConnectionResponse.parse(res.json());
    expect(parsed.user?.op_id).toBe(1);
    expect(parsed.default_project_op_id).toBe(100);
    expect(parsed.has_token).toBe(true);
    expect(parsed.health.last_status).toBe("ok");
  });

  it("POST /connections with a failing token STORES the server with health fail (no user)", async () => {
    // SPEC_02 §7: an unreachable/rejecting server must still be addable.
    const t2 = await buildTestApp({
      opClientFactory: () => ({
        ...makeFakeOpClient(),
        getCurrentUser: () => Promise.reject({ status: 401, message: "bad token" }),
      }),
    });
    await initVault(t2);
    const res = await t2.app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { base_url: "https://op.example.com", token: "bad" },
    });
    expect(res.statusCode).toBe(201);
    const parsed = AddConnectionResponse.parse(res.json());
    expect(parsed.user).toBeUndefined();
    expect(parsed.health.last_status).toBe("fail");
    expect(parsed.has_token).toBe(true);
    await t2.close();
  });

  it("GET /projects without a connection → NO_CONNECTION", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("NO_CONNECTION");
  });

  it("GET /projects returns cached OP projects", async () => {
    await connect(t);
    const res = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    const parsed = ProjectsResponse.parse(res.json());
    expect(parsed.some((p) => p.op_id === 100 && p.identifier === "proj-a")).toBe(true);
  });

  it("POST /sync then GET /sync/status parse; last_synced_at is set", async () => {
    await connect(t);
    const sync = await t.app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { project_op_id: 100 },
    });
    expect(sync.statusCode).toBe(200);
    expect(SyncRun.parse(sync.json()).status).toBe("success");

    const status = await t.app.inject({ method: "GET", url: "/api/sync/status" });
    const parsed = SyncStatusResponse.parse(status.json());
    expect(parsed.current).toBeNull();
    expect(parsed.last?.status).toBe("success");
    expect(parsed.last_synced_at).not.toBeNull();
  });

  it("POST /sync while a run is 'running' → 409 SYNC_IN_PROGRESS with details (Increment 22)", async () => {
    await connect(t);
    // Seed a DB-backed 'running' run (the "one sync at a time" guard reads the
    // DB, NOT an in-memory flag — SPEC_22 §1.4): this fresh row alone blocks a
    // POST /sync even though no sync is actually executing in-process.
    const running = await t.repos.syncRuns.start("full");

    const res = await t.app.inject({ method: "POST", url: "/api/sync", payload: {} });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: {
        code: string;
        message: string;
        details?: { runId?: number; started_at?: string; last_progress_at?: string | null };
      };
    };
    expect(body.error.code).toBe("SYNC_IN_PROGRESS");
    // Informative, not a bare 409: message names the start time, details carry
    // the runId the frontend needs to wire POST /sync/:runId/cancel.
    expect(body.error.message).toContain(running.started_at);
    expect(body.error.details?.runId).toBe(running.id);
    expect(body.error.details?.started_at).toBe(running.started_at);
    expect(body.error.details).toHaveProperty("last_progress_at");

    // Once the run finishes, the guard clears and a subsequent sync proceeds.
    await t.repos.syncRuns.finish(running.id, "success", 0, null, new Date().toISOString());
    const ok = await t.app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { project_op_id: 100 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("sync/status last_synced_at falls back when no default project is set", async () => {
    // Connect WITHOUT a default project → the default-project path yields null and
    // the endpoint must fall back to the most-recently-synced project / last run.
    await initVault(t);
    await t.app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { base_url: "https://op.example.com", token: "tok" },
    });
    await t.app.inject({ method: "POST", url: "/api/sync", payload: { project_op_id: 100 } });
    const status = await t.app.inject({ method: "GET", url: "/api/sync/status" });
    const parsed = SyncStatusResponse.parse(status.json());
    expect(parsed.last_synced_at).not.toBeNull(); // fallback, not "never"
  });

  it("GET /imports reflects recorded additive import selections", async () => {
    await connect(t);
    const empty = ImportsResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/imports" })).json(),
    );
    expect(empty).toEqual([]);

    // A project sync records an additive selection (the route persists it).
    await t.app.inject({ method: "POST", url: "/api/sync", payload: { project_op_id: 100 } });
    const after = ImportsResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/imports" })).json(),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.project_op_id).toBe(100);
    expect(after[0]!.version_op_id).toBeNull();
  });

  it("POST /estimate-override parses", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/estimate-override",
      payload: { wp_op_id: 42, planning_hours: 6, note: "tighter" },
    });
    expect(res.statusCode).toBe(201);
    const parsed = EstimateOverrideResponse.parse(res.json());
    expect(parsed.planning_hours).toBe(6);
  });

  it("GET /backlog returns effective estimate + in_sprint flag", async () => {
    await seedWp(t.repos, { op_id: 1, estimated_hours: 8, assignee_op_id: 10, assignee_name: "Ann" });
    await seedWp(t.repos, { op_id: 2, estimated_hours: null });
    await t.app.inject({
      method: "POST",
      url: "/api/estimate-override",
      payload: { wp_op_id: 2, planning_hours: 3 },
    });
    const res = await t.app.inject({ method: "GET", url: "/api/backlog?projectId=100" });
    expect(res.statusCode).toBe(200);
    const parsed = BacklogResponse.parse(res.json());
    const one = parsed.find((x) => x.op_id === 1)!;
    const two = parsed.find((x) => x.op_id === 2)!;
    expect(one.effective_hours).toBe(8);
    expect(two.effective_hours).toBe(3); // override supplies estimate
    expect(two.override_hours).toBe(3);
    expect(one.in_sprint).toBe(false);

    const filtered = await t.app.inject({
      method: "GET",
      url: "/api/backlog?projectId=100&hasEstimate=true",
    });
    expect(BacklogResponse.parse(filtered.json())).toHaveLength(2);
  });

  it("GET /backlog hides Closed/Resolved/Rejected/Tested statuses (still cached)", async () => {
    await seedWp(t.repos, { op_id: 1, status_name: "New", estimated_hours: 5 });
    await seedWp(t.repos, { op_id: 2, status_name: "Closed", status_is_closed: true });
    await seedWp(t.repos, { op_id: 3, status_name: "Resolved", status_is_closed: true });
    await seedWp(t.repos, { op_id: 4, status_name: "Rejected", status_is_closed: true });
    await seedWp(t.repos, { op_id: 5, status_name: "Tested" });
    const res = await t.app.inject({ method: "GET", url: "/api/backlog?projectId=100" });
    const backlog = BacklogResponse.parse(res.json());
    expect(backlog.map((b) => b.op_id)).toEqual([1]); // only the open one
    // The hidden ones are still cached (add-to-sprint would find them).
    expect(await t.repos.workPackages.getByOpId(2)).not.toBeNull();
  });

  it("POST /backlog/remove hides selected work packages from the backlog", async () => {
    await seedWp(t.repos, { op_id: 1, status_name: "New", estimated_hours: 5 });
    await seedWp(t.repos, { op_id: 2, status_name: "New", estimated_hours: 3 });

    const before = BacklogResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/backlog" })).json(),
    );
    expect(before.map((b) => b.op_id).sort()).toEqual([1, 2]);

    const rm = await t.app.inject({
      method: "POST",
      url: "/api/backlog/remove",
      payload: { wp_op_ids: [1] },
    });
    expect(rm.statusCode).toBe(200);
    expect((rm.json() as { removed: number }).removed).toBe(1);

    const after = BacklogResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/backlog" })).json(),
    );
    expect(after.map((b) => b.op_id)).toEqual([2]);
    // Still cached (dismissal only affects the backlog view).
    expect(await t.repos.workPackages.getByOpId(1)).not.toBeNull();
    // Empty selection is rejected by the contract.
    const bad = await t.app.inject({
      method: "POST",
      url: "/api/backlog/remove",
      payload: { wp_op_ids: [] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /backlog/filter-options cascades — an option never yields 0 rows (Increment 19)", async () => {
    // Two versions with disjoint statuses/priorities/assignees. Selecting v1
    // must NOT offer v2's "New" status (the reported "Version + Status → 0
    // results" bug): a status that can't occur for the current version never
    // appears as an option in the first place.
    await seedWp(t.repos, {
      op_id: 1, version_op_id: 501, version_name: "v1",
      status_name: "In progress", priority: "High", assignee_op_id: 10, assignee_name: "Ann",
    });
    await seedWp(t.repos, {
      op_id: 2, version_op_id: 502, version_name: "v2",
      status_name: "New", priority: "Low", assignee_op_id: 11, assignee_name: "Bob",
    });

    const opts = BacklogFilterOptionsResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/backlog/filter-options?version=501" })).json(),
    );
    // Facets reflect ONLY v1's row (their own field excluded → versions shows both).
    expect(opts.statuses).toEqual(["In progress"]);
    expect(opts.priorities).toEqual(["High"]);
    expect(opts.assignees.map((a) => a.id)).toEqual([10]);
    expect(opts.versions.map((v) => v.id).sort()).toEqual([501, 502]); // own field dropped

    // Every offered status yields ≥1 row for the current version — case-
    // insensitive matching means the verbatim option round-trips cleanly.
    for (const s of opts.statuses) {
      const rows = BacklogResponse.parse(
        (
          await t.app.inject({
            method: "GET",
            url: `/api/backlog?version=501&status=${encodeURIComponent(s)}`,
          })
        ).json(),
      );
      expect(rows.length).toBeGreaterThan(0);
    }
    // The excluded status is genuinely never offered (bug prevention).
    expect(opts.statuses).not.toContain("New");
  });

  it("POST /sync/:runId/cancel — 404 unknown, sets cancel_requested on a running run (Increment 19)", async () => {
    const missing = await t.app.inject({ method: "POST", url: "/api/sync/999999/cancel" });
    expect(missing.statusCode).toBe(404);

    const run = await t.repos.syncRuns.start("full"); // a live "running" run
    const res = await t.app.inject({ method: "POST", url: `/api/sync/${run.id}/cancel` });
    expect(res.statusCode).toBe(200);
    const parsed = CancelSyncResponse.parse(res.json());
    expect(parsed.id).toBe(run.id);
    expect(parsed.cancel_requested).toBe(true);
    expect(parsed.status).toBe("running"); // flag only — engine flips status
    // Idempotent: a second cancel is not an error.
    expect((await t.app.inject({ method: "POST", url: `/api/sync/${run.id}/cancel` })).statusCode).toBe(200);
  });

  it("GET /sync/status includes current_elapsed_ms (Increment 19)", async () => {
    // Idle → null.
    const idle = SyncStatusResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/sync/status" })).json(),
    );
    expect(idle.current).toBeNull();
    expect(idle.current_elapsed_ms).toBeNull();

    // A running run → a non-negative elapsed based on started_at.
    await t.repos.syncRuns.start("full");
    const running = SyncStatusResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/sync/status" })).json(),
    );
    expect(running.current).not.toBeNull();
    expect(running.current_elapsed_ms).not.toBeNull();
    expect(running.current_elapsed_ms!).toBeGreaterThanOrEqual(0);
  });

  it("sprint CRUD + items + closed-guard", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Sprint 1", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    expect(create.statusCode).toBe(201);
    const sprint = SprintResponse.parse(create.json());
    expect(sprint.status).toBe("planning");

    const list = await t.app.inject({ method: "GET", url: "/api/sprints" });
    expect(SprintsResponse.parse(list.json())).toHaveLength(1);

    // PATCH not found
    const nf = await t.app.inject({
      method: "PATCH",
      url: "/api/sprints/9999",
      payload: { name: "x" },
    });
    expect(nf.statusCode).toBe(404);
    expect(ErrorResponse.parse(nf.json()).error.code).toBe("SPRINT_NOT_FOUND");

    // add item
    await seedWp(t.repos, { op_id: 1, estimated_hours: 8 });
    const add = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/items`,
      payload: { wp_op_id: 1 },
    });
    expect(add.statusCode).toBe(201);
    const item = SprintItemResponse.parse(add.json());
    expect(item.planned_hours).toBe(8); // effective estimate snapshot

    // duplicate → conflict
    const dup = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/items`,
      payload: { wp_op_id: 1 },
    });
    expect(dup.statusCode).toBe(409);
    expect(ErrorResponse.parse(dup.json()).error.code).toBe("ITEM_ALREADY_IN_SPRINT");

    // delete (→ removed) then re-add allowed
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/sprints/${sprint.id}/items/1`,
    });
    expect(del.statusCode).toBe(200);
    expect(SprintItemResponse.parse(del.json()).outcome).toBe("removed");
    const readd = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/items`,
      payload: { wp_op_id: 1 },
    });
    expect(readd.statusCode).toBe(201);
  });

  it("GET /sprints/:id/items returns ONLY that sprint's items (no cross-sprint leakage)", async () => {
    await seedWp(t.repos, { op_id: 1, estimated_hours: 8 });
    await seedWp(t.repos, { op_id: 2, estimated_hours: 4 });

    const mk = async (name: string) =>
      SprintResponse.parse(
        (
          await t.app.inject({
            method: "POST",
            url: "/api/sprints",
            payload: { name, start_date: "2026-06-01", end_date: "2026-06-14" },
          })
        ).json(),
      );
    const a = await mk("Sprint A");
    const b = await mk("Sprint B");

    // WP 1 goes into sprint A only.
    await t.app.inject({ method: "POST", url: `/api/sprints/${a.id}/items`, payload: { wp_op_id: 1 } });

    const itemsA = SprintItemsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${a.id}/items` })).json(),
    );
    const itemsB = SprintItemsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${b.id}/items` })).json(),
    );

    expect(itemsA.map((i) => i.wp_op_id)).toEqual([1]);
    expect(itemsB).toEqual([]); // the newly created sprint B is empty
  });

  it("PUT /capacity computes lines and totals (parseable)", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    const ann = await t.repos.teamMembers.upsert({ op_user_id: 10, name: "Ann", default_hours_per_day: 8 });
    await seedWp(t.repos, { op_id: 1, estimated_hours: 50, assignee_op_id: 10, assignee_name: "Ann" });
    await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/items`,
      payload: { wp_op_id: 1 },
    });
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprint.id}/capacity`,
      payload: { members: [{ member_id: ann.id, available_hours: 40, pto_days: 0 }] },
    });
    expect(res.statusCode).toBe(200);
    const parsed = CapacityResponse.parse(res.json());
    expect(parsed.total_available_hours).toBe(40);
    expect(parsed.total_planned_hours).toBe(50);
    const line = parsed.lines.find((l) => l.op_user_id === 10)!;
    expect(line.overloaded).toBe(true);
  });

  it("capacity by op_user_id auto-provisions (deduped), GET reads it, and it locks off planning (#7)", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    await seedWp(t.repos, { op_id: 1, estimated_hours: 20, assignee_op_id: 42, assignee_name: "Zoe" });
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprint.id}/items`, payload: { wp_op_id: 1 } });

    // No team member for op_user_id 42 yet → PUT must auto-provision one.
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprint.id}/capacity`,
      payload: { members: [{ op_user_id: 42, name: "Zoe", available_hours: 30 }] },
    });
    expect(put.statusCode).toBe(200);
    const zoe = CapacityResponse.parse(put.json()).lines.find((l) => l.op_user_id === 42)!;
    expect(zoe.available_hours).toBe(30);
    expect(zoe.planned_hours).toBe(20);

    // GET returns the persisted capacity.
    const got = await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/capacity` });
    expect(CapacityResponse.parse(got.json()).total_available_hours).toBe(30);

    // A second PUT for the same op_user_id must not create a duplicate member.
    await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprint.id}/capacity`,
      payload: { members: [{ op_user_id: 42, available_hours: 25 }] },
    });
    expect((await t.repos.teamMembers.list()).filter((m) => m.op_user_id === 42)).toHaveLength(1);

    // Activate → capacity is now locked.
    await t.app.inject({ method: "PATCH", url: `/api/sprints/${sprint.id}`, payload: { status: "active" } });
    const locked = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprint.id}/capacity`,
      payload: { members: [{ op_user_id: 42, available_hours: 10 }] },
    });
    expect(locked.statusCode).toBe(409);
    expect(ErrorResponse.parse(locked.json()).error.code).toBe("SPRINT_NOT_PLANNING");
  });

  it("capacity counts only sprint items shown in the backlog (hidden statuses excluded)", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    // Ann's ticket is New (visible); Bob's is Tested (hidden from the backlog).
    await seedWp(t.repos, { op_id: 1, status_name: "New", estimated_hours: 8, assignee_op_id: 10, assignee_name: "Ann" });
    await seedWp(t.repos, { op_id: 2, status_name: "Tested", status_is_closed: false, estimated_hours: 20, assignee_op_id: 20, assignee_name: "Bob" });
    for (const wp of [1, 2]) {
      await t.app.inject({ method: "POST", url: `/api/sprints/${sprint.id}/items`, payload: { wp_op_id: wp } });
    }
    const cap = CapacityResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/capacity` })).json(),
    );
    // Bob's Tested ticket is hidden → no phantom Bob line, no inflated load.
    expect(cap.lines.some((l) => l.op_user_id === 20)).toBe(false);
    expect(cap.lines.find((l) => l.op_user_id === 10)?.planned_hours).toBe(8);
    expect(cap.total_planned_hours).toBe(8);
  });

  it("GET /burndown reads persisted snapshots (parseable)", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    await seedWp(t.repos, { op_id: 1, estimated_hours: 80 });
    await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/items`,
      payload: { wp_op_id: 1 },
    });
    await t.repos.burndown.upsert({
      sprint_id: sprint.id,
      snapshot_date: "2026-06-01",
      remaining_hours: 80,
      logged_hours: 0,
      ideal_hours: 80,
      done_count: 0,
      total_count: 1,
      source: "live",
    });
    const res = await t.app.inject({
      method: "GET",
      url: `/api/sprints/${sprint.id}/burndown`,
    });
    const parsed = BurndownResponse.parse(res.json());
    expect(parsed.total_planned_hours).toBe(80);
    expect(parsed.points).toHaveLength(10);
    expect(parsed.points[0]!.remaining_hours).toBe(80);
  });

  it("GET /velocity parses (nulls when no closed history)", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    const res = await t.app.inject({
      method: "GET",
      url: `/api/sprints/${sprint.id}/velocity`,
    });
    const parsed = VelocityResponse.parse(res.json());
    expect(parsed.average_completed_hours).toBeNull();
  });

  it("full closure flow: close → report, then version-export deep-link", async () => {
    await connect(t);
    await t.app.inject({ method: "GET", url: "/api/projects" }); // cache identifier
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    await seedWp(t.repos, { op_id: 1, status_name: "Closed", status_is_closed: true, estimated_hours: 8, version_name: "v1" });
    await seedWp(t.repos, { op_id: 2, status_name: "In progress", status_is_closed: false, estimated_hours: 5, version_name: "v1" });
    for (const wp of [1, 2]) {
      await t.app.inject({
        method: "POST",
        url: `/api/sprints/${sprint.id}/items`,
        payload: { wp_op_id: wp },
      });
    }
    const close = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/close`,
    });
    expect(close.statusCode).toBe(200);
    const report = ClosureReportResponse.parse(close.json());
    expect(report.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(report.not_done.map((d) => d.wp_op_id)).toEqual([2]);

    // second close → SPEC_11 §8a "regenerate": returns the SAME report content
    // (200, not 409) WITHOUT locking the sprint (it's still planning here). A
    // regenerate re-stamps generated_at (>= the first), by design.
    const again = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/close`,
    });
    expect(again.statusCode).toBe(200);
    const reportAgain = ClosureReportResponse.parse(again.json());
    expect(reportAgain.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(reportAgain.not_done.map((d) => d.wp_op_id)).toEqual([2]);
    expect(reportAgain.generated_at >= report.generated_at).toBe(true);
    // The sprint is NOT locked by viewing/regenerating the report (§8a).
    expect((await t.repos.sprints.getById(sprint.id))!.is_locked).toBe(false);

    const ve = await t.app.inject({
      method: "GET",
      url: `/api/sprints/${sprint.id}/version-export`,
    });
    const vexp = VersionExportResponse.parse(ve.json());
    expect(vexp.wp_op_ids).toEqual([2]); // carried
    expect(vexp.deep_link).toContain("/projects/proj-a/work_packages?query_props=");
  });

  it("adding an item to a closed sprint → SPRINT_CLOSED", async () => {
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprint = SprintResponse.parse(create.json());
    await seedWp(t.repos, { op_id: 1 });
    await t.repos.sprints.close(sprint.id, 0, "2026-06-14T00:00:00Z", "finished");
    const add = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprint.id}/items`,
      payload: { wp_op_id: 1 },
    });
    expect(add.statusCode).toBe(409);
    expect(ErrorResponse.parse(add.json()).error.code).toBe("SPRINT_CLOSED");
  });

  it("read-only invariant: the real op-client refuses non-GET before any network call", () => {
    const client = createOpClient({ baseUrl: "https://op.example.com", token: "t" });
    expect(() => client.request({ path: "/api/v3/work_packages", method: "POST" as "GET" })).toThrow(
      ReadOnlyViolationError,
    );
  });
});
