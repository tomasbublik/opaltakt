import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  AddConnectionResponse,
  BacklogResponse,
  ImportsResponse,
  ProjectsResponse,
  SprintResponse,
  SyncRefreshAllResponse,
  SyncRun,
  VersionsResponse,
} from "@osp/contracts";
import {
  addConnection,
  bootRealApp,
  call,
  connectToOp,
  initAndUnlockVault,
  type RealApp,
} from "./harness";

/**
 * A↔B integration (SPEC §9 Agent D duty #1): boot the real Fastify app with a
 * real in-memory DB, pointed at the mock OP server as OpenProject. Exercise
 *   vault init → POST /api/connections → GET /api/projects → POST /api/sync →
 *   GET /api/backlog
 * and assert data flows from mock OP through sync into the cache into the backlog
 * response, every payload parsing against the frozen @osp/contracts schemas.
 */
describe("integration: OP → sync → cache → REST", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
  });

  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("vault init + POST /api/connections validates the token via GET /users/me", async () => {
    const vault = await initAndUnlockVault(harness.app);
    expect(vault.status).toBeGreaterThanOrEqual(200);
    expect(vault.status).toBeLessThan(300);

    const res = await addConnection(harness.app, mock.url, "test-token", {
      default_project_op_id: 3,
    });
    expect(res.status).toBe(201);
    const parsed = AddConnectionResponse.parse(res.json);
    expect(parsed.user?.op_id).toBe(1);
    expect(parsed.user?.name).toBe("Ada Lovelace");
    expect(parsed.default_project_op_id).toBe(3);
    expect(parsed.has_token).toBe(true);
    expect(parsed.health.last_status).toBe("ok");
    // The token must never be echoed back to the client (SPEC §2 / SPEC_02 §8).
    expect(JSON.stringify(res.json)).not.toContain("test-token");
  });

  it("GET /api/projects returns the mock OP project set", async () => {
    const res = await call(harness.app, "GET", "/api/projects");
    expect(res.status).toBe(200);
    const projects = ProjectsResponse.parse(res.json);
    expect(projects.map((p) => p.op_id)).toContain(3);
    const demo = projects.find((p) => p.op_id === 3);
    expect(demo?.identifier).toBe("demo-project");
  });

  it("POST /api/sync pulls work packages from mock OP into the cache", async () => {
    const res = await call(harness.app, "POST", "/api/sync", {
      project_op_id: 3,
    });
    expect(res.status).toBe(200);
    const run = SyncRun.parse(res.json);
    expect(run.status).toBe("success");
    // Three work packages live in the fixtures (paginated across 2 pages).
    expect(run.wp_count).toBe(3);

    // Cache is populated with the OP image, remaining_hours read directly.
    const cached = await harness.repos.workPackages.getByOpId(1001);
    expect(cached?.subject).toBe("Implement login");
    expect(cached?.estimated_hours).toBe(8);
    expect(cached?.remaining_hours).toBe(4);
    expect(cached?.status_is_closed).toBe(false);
    const closedWp = await harness.repos.workPackages.getByOpId(1003);
    expect(closedWp?.status_is_closed).toBe(true);
    // spentTime null on 1002 → fell back to Time Entries aggregation (0 here).
  });

  it("GET /api/backlog serves the synced cache (contract-valid)", async () => {
    const res = await call(harness.app, "GET", "/api/backlog?projectId=3");
    expect(res.status).toBe(200);
    const backlog = BacklogResponse.parse(res.json);
    // WP 1003 is "Closed" → hidden from the backlog (still cached). 1001 + 1002 remain.
    expect(backlog).toHaveLength(2);
    expect(backlog.some((b) => b.op_id === 1003)).toBe(false);
    const login = backlog.find((b) => b.op_id === 1001);
    // Increment 16 (SPEC_16 §5): effective estimate prefers Remaining work
    // over Work when Remaining is nonzero and differs from it. WP 1001's
    // fixture data is Work=8h/Remaining=4h (fixtures/data/work_packages.json),
    // so 4h (Remaining) is now correct — 8h was the pre-Increment-16 figure.
    expect(login?.effective_hours).toBe(4); // no override → Remaining work (4h), not Work (8h)
    expect(login?.override_hours).toBeNull();
    expect(login?.in_sprint).toBe(false);

    // hasEstimate filter narrows correctly (both visible fixtures have estimates).
    const filtered = await call(
      harness.app,
      "GET",
      "/api/backlog?projectId=3&hasEstimate=true",
    );
    expect(BacklogResponse.parse(filtered.json)).toHaveLength(2);
  });

  it("estimate-override flows into the effective planning estimate", async () => {
    const ov = await call(harness.app, "POST", "/api/estimate-override", {
      wp_op_id: 1001,
      planning_hours: 13,
      note: "re-scoped",
    });
    expect(ov.status).toBe(201);
    const res = await call(harness.app, "GET", "/api/backlog?projectId=3");
    const backlog = BacklogResponse.parse(res.json);
    const login = backlog.find((b) => b.op_id === 1001);
    expect(login?.override_hours).toBe(13);
    expect(login?.effective_hours).toBe(13); // override wins over OP estimate
  });

  it("a full sprint lifecycle round-trips through the API", async () => {
    // Create sprint, add a WP, verify backlog now flags it in_sprint.
    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "Sprint 1",
      start_date: "2026-06-22",
      end_date: "2026-06-26",
    });
    expect(created.status).toBe(201);
    const sprint = SprintResponse.parse(created.json);

    const add = await call(
      harness.app,
      "POST",
      `/api/sprints/${sprint.id}/items`,
      { wp_op_id: 1002 },
    );
    expect(add.status).toBe(201);

    const res = await call(harness.app, "GET", "/api/backlog?projectId=3");
    const backlog = BacklogResponse.parse(res.json);
    expect(backlog.find((b) => b.op_id === 1002)?.in_sprint).toBe(true);
  });

  it("adds a single work package by OP id (GET-only) and it appears in the backlog", async () => {
    // WP 1013 lives in project 7 (never synced as a project) — added by id alone.
    const add = await call(harness.app, "POST", "/api/work-packages", { op_id: 1013 });
    expect(add.status).toBe(201);
    expect((add.json as { op_id: number }).op_id).toBe(1013);

    const res = await call(harness.app, "GET", "/api/backlog");
    const backlog = BacklogResponse.parse(res.json);
    expect(backlog.some((b) => b.op_id === 1013)).toBe(true);

    // An unknown id → 404 (still only GETs OP).
    const miss = await call(harness.app, "POST", "/api/work-packages", { op_id: 99999 });
    expect(miss.status).toBe(404);
  });

  it("removing a ticket hides it; re-adding it by id brings it back", async () => {
    const inBacklog = async (opId: number) =>
      BacklogResponse.parse(
        (await call(harness.app, "GET", "/api/backlog?projectId=3")).json,
      ).some((b) => b.op_id === opId);

    expect(await inBacklog(1001)).toBe(true);

    const rm = await call(harness.app, "POST", "/api/backlog/remove", {
      wp_op_ids: [1001],
    });
    expect(rm.status).toBe(200);
    expect(await inBacklog(1001)).toBe(false); // hidden

    // Re-adding by id un-hides it (importWorkPackage clears the dismissal).
    const readd = await call(harness.app, "POST", "/api/work-packages", { op_id: 1001 });
    expect(readd.status).toBe(201);
    expect(await inBacklog(1001)).toBe(true);
  });

  it("a re-sync overwrites a stale assignee with the current OP value", async () => {
    // Simulate the WP having been reassigned in OP AFTER import by corrupting the
    // cached assignee, then confirm a sync ('Sync now' is a full refresh) restores
    // the current OP assignee — not just the hours.
    const current = await harness.repos.workPackages.getByOpId(1001);
    const { id: _id, cached_at: _c, ...row } = current!;
    await harness.repos.workPackages.upsertMany([
      { ...row, assignee_op_id: 99999, assignee_name: "Stale Person" },
    ]);
    expect((await harness.repos.workPackages.getByOpId(1001))?.assignee_name).toBe("Stale Person");

    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const synced = await harness.repos.workPackages.getByOpId(1001);
    expect(synced?.assignee_name).toBe("Ada Lovelace"); // assignee refreshed from OP
    expect(synced?.assignee_op_id).toBe(1);
  });

  it("'Sync now' refreshes individually-added tickets (un-imported project) too", async () => {
    // 1004 lives in project 7, which is NOT imported here — add it by id alone.
    await call(harness.app, "POST", "/api/work-packages", { op_id: 1004 });
    // Simulate it being reassigned in OP after the add.
    const cur = await harness.repos.workPackages.getByOpId(1004);
    const { id: _i, cached_at: _c, ...row } = cur!;
    await harness.repos.workPackages.upsertMany([
      { ...row, assignee_op_id: 99999, assignee_name: "Stale Person" },
    ]);

    // Sync now (refresh-all) — must also re-fetch the individually-added ticket.
    await call(harness.app, "POST", "/api/sync", {});

    const refreshed = await harness.repos.workPackages.getByOpId(1004);
    expect(refreshed?.assignee_name).toBe("Grace Hopper"); // restored from OP
    expect(refreshed?.assignee_op_id).toBe(2);
  });
});

/**
 * MULTI-PROJECT IMPORT (this week's feature). Boots its OWN real app + mock so it
 * is fully isolated from the describe above (fresh in-memory DB per block), mirroring
 * read-only-guard.test.ts / burndown.test.ts. The mock OP has two projects:
 *   Demo Project (op_id 3): WPs 1001-1003, versions Sprint Backlog(100)/v1.0(101)
 *   Platform     (op_id 7): WPs 1004-1020, versions R1(200)/R2(201)
 * Open v200(R1) Platform WPs are 1004/1005/1008/1015 (1012 Resolved & 1019 Tested
 * are hidden). 1007 is an R2-only (v201) WP — never fetched by a v200 import.
 */
describe("integration: multi-project additive import → union backlog", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    // Connect (vault init + add connection), then hydrate the project-name cache
    // (GET /projects upserts it) so backlog items can carry project_name
    // ("Platform" / "Demo Project").
    await connectToOp(harness.app, mock.url, "t", 3);
    await call(harness.app, "GET", "/api/projects");
  });

  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("GET /api/versions?projectId=7 returns ONLY the Platform versions (per-project scoping)", async () => {
    const res = await call(harness.app, "GET", "/api/versions?projectId=7");
    expect(res.status).toBe(200);
    const versions = VersionsResponse.parse(res.json);
    // Exactly R1(200) + R2(201) — none of Demo's Sprint Backlog(100)/v1.0(101).
    expect(new Set(versions.map((v) => v.op_id))).toEqual(new Set([200, 201]));
    expect(versions.find((v) => v.op_id === 200)?.name).toBe("R1");
    expect(versions.find((v) => v.op_id === 201)?.name).toBe("R2");
    expect(versions.some((v) => v.op_id === 100 || v.op_id === 101)).toBe(false);
  });

  it("additive import of Platform·R1 + whole Demo yields a UNION backlog (version filter respected)", async () => {
    // Import ONLY Platform version 200 (R1), then the whole Demo project.
    const p7 = await call(harness.app, "POST", "/api/sync", {
      project_op_id: 7,
      version_op_id: 200,
    });
    expect(p7.status).toBe(200);
    expect(SyncRun.parse(p7.json).status).toBe("success");

    const p3 = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(p3.status).toBe(200);
    expect(SyncRun.parse(p3.json).status).toBe("success");

    // No projectId → union across every imported project.
    const res = await call(harness.app, "GET", "/api/backlog");
    expect(res.status).toBe(200);
    const backlog = BacklogResponse.parse(res.json);
    const byId = new Map(backlog.map((b) => [b.op_id, b]));

    // Open Platform·R1 WPs are present, tagged with project_name "Platform".
    for (const opId of [1004, 1005, 1008, 1015]) {
      expect(byId.has(opId)).toBe(true);
      expect(byId.get(opId)?.project_op_id).toBe(7);
      expect(byId.get(opId)?.project_name).toBe("Platform");
    }
    // Open Demo WPs are present too, tagged "Demo Project".
    for (const opId of [1001, 1002]) {
      expect(byId.has(opId)).toBe(true);
      expect(byId.get(opId)?.project_name).toBe("Demo Project");
    }
    // Version filter respected at import time: 1007 is an R2-only (v201) Platform
    // WP that a v200 import never fetched → absent from the union.
    expect(byId.has(1007)).toBe(false);
    // Hidden statuses stay hidden even inside v200 (1012 Resolved, 1019 Tested).
    expect(byId.has(1012)).toBe(false);
    expect(byId.has(1019)).toBe(false);
    // Every union item carries a non-null project_name.
    expect(backlog.every((b) => b.project_name !== null)).toBe(true);

    // projectId=7 filters the union down to just Platform.
    const only7 = await call(harness.app, "GET", "/api/backlog?projectId=7");
    const platform = BacklogResponse.parse(only7.json);
    expect(platform.length).toBeGreaterThan(0);
    expect(platform.every((b) => b.project_op_id === 7)).toBe(true);
    expect(platform.every((b) => b.project_name === "Platform")).toBe(true);
    expect(platform.some((b) => b.op_id === 1004)).toBe(true);
    expect(platform.some((b) => b.op_id === 1001)).toBe(false); // no Demo WPs
  });

  it("GET /api/imports reflects BOTH recorded selections (Platform·R1 + Demo·all)", async () => {
    const res = await call(harness.app, "GET", "/api/imports");
    expect(res.status).toBe(200);
    const imports = ImportsResponse.parse(res.json);
    expect(imports).toHaveLength(2);

    const platform = imports.find(
      (s) => s.project_op_id === 7 && s.version_op_id === 200,
    );
    expect(platform).toBeDefined();
    expect(platform?.project_name).toBe("Platform");
    expect(platform?.version_name).toBe("R1");

    const demo = imports.find((s) => s.project_op_id === 3);
    expect(demo).toBeDefined();
    expect(demo?.version_op_id).toBeNull(); // whole project (all versions)
    expect(demo?.project_name).toBe("Demo Project");
  });

  it("POST /api/sync with an empty body {} refreshes every recorded selection", async () => {
    const res = await call(harness.app, "POST", "/api/sync", {});
    expect(res.status).toBe(200);
    // Increment 23 (SPEC_23 §1) — refresh-all now returns a per-connection
    // breakdown (SyncRefreshAllResponse), not a bare SyncRun.
    const refreshed = SyncRefreshAllResponse.parse(res.json);
    expect(refreshed.connections.length).toBeGreaterThan(0);
    for (const outcome of refreshed.connections) {
      expect(outcome.status, JSON.stringify(outcome)).toBe("synced");
    }

    // Refresh keeps version-limited imports limited: still no R2-only WP leaks in.
    const backlog = BacklogResponse.parse(
      (await call(harness.app, "GET", "/api/backlog")).json,
    );
    expect(backlog.some((b) => b.op_id === 1004)).toBe(true);
    expect(backlog.some((b) => b.op_id === 1007)).toBe(false);
  });
});
