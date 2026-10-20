import { describe, expect, it } from "vitest";
import type {
  DeleteOutOfSelectionResponse,
  OutOfSelectionResponse,
  SyncRefreshAllResponse,
} from "@osp/contracts";
import type { OpWorkPackage } from "@osp/op-client";
import { createSyncEngine, type SyncEngine, type SyncOptions } from "@osp/sync";
import type { Repositories } from "@osp/db";
import { addConnection, buildTestApp, initVault, type TestApp } from "../test-utils";

/**
 * Increment 29 (SPEC_29 §1/§2/§6, `docs/INCREMENT_29_CONTRACTS.md`) — Agent B.
 *
 * The bug being closed (CONTRACTS §0a): a selection is a (project, version)
 * pair, but the old "orphans" pass asked only about the PROJECT. A cached row
 * whose project IS selected but whose version is NOT fell through both — the
 * paginated sync filtered it out by version, and the orphans pass considered its
 * project already covered — so it was never fetched again, by any run, forever.
 *
 * Everything below is asserted through the HTTP surface, and every coverage
 * number is expected to be RECOUNTED FROM THE DATABASE (CONTRACTS §4.1): a count
 * accumulated while fetching is the reporting that let this hide behind
 * `status: success` for weeks, so a test that only proves "the code did what the
 * code thinks it did" would be worthless here.
 */

function opWp(
  id: number,
  over: { projectOpId?: number; versionOpId?: number | null; subject?: string } = {},
): OpWorkPackage {
  const projectOpId = over.projectOpId ?? 100;
  return {
    _type: "WorkPackage",
    id,
    subject: over.subject ?? `WP ${id}`,
    estimatedTime: "PT4H",
    remainingTime: "PT4H",
    updatedAt: "2026-08-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: "/api/v3/statuses/1", title: "New" },
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: `/api/v3/projects/${projectOpId}`, title: `Project ${projectOpId}` },
      ...(over.versionOpId != null
        ? {
            version: {
              href: `/api/v3/versions/${over.versionOpId}`,
              title: `v${over.versionOpId}`,
            },
          }
        : {}),
    },
  };
}

/** A cached row, written directly so a test can control `cached_at` age. */
function cacheRow(over: {
  op_id: number;
  connection_id: number | null;
  project_op_id?: number;
  version_op_id?: number | null;
  version_name?: string | null;
  subject?: string;
}) {
  return {
    connection_id: over.connection_id,
    op_id: over.op_id,
    project_op_id: over.project_op_id ?? 100,
    subject: over.subject ?? `WP ${over.op_id}`,
    type_name: "Task",
    status_name: "New",
    status_is_closed: false,
    assignee_op_id: null,
    assignee_name: null,
    estimated_hours: 4,
    remaining_hours: 4,
    spent_hours: null,
    story_points: null,
    version_op_id: over.version_op_id ?? null,
    version_name: over.version_name ?? (over.version_op_id != null ? `v${over.version_op_id}` : null),
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-07-01T00:00:00Z",
    raw_json: "{}",
  };
}

/**
 * A sync engine that reproduces the ONE behaviour that matters here: a
 * selection-scoped `sync()` only ever re-caches rows matching that (project,
 * version) — precisely what `buildWorkPackagesFilters` does against real OP.
 * `syncByOpIds` delegates to the REAL engine over the fake OP client, so the
 * coverage pass exercises Agent A's genuine batching / staging / orphan
 * detection rather than a second stub of it.
 */
function scopedEngineFactory(
  getRepos: () => Repositories,
  syncCalls: SyncOptions[],
): (op: Parameters<typeof createSyncEngine>[0]["op"]) => SyncEngine {
  return (op) => {
    const repos = getRepos();
    const real = createSyncEngine({
      op,
      projects: repos.projects,
      workPackages: repos.workPackages,
      sprintItems: repos.sprintItems,
      syncRuns: repos.syncRuns,
      sprints: repos.sprints,
      watermarks: repos.watermarks,
    });
    return {
      async sync(options) {
        syncCalls.push(options);
        const run = await repos.syncRuns.start(options.kind ?? "full");
        const matching = (await repos.workPackages.find({})).filter(
          (w) =>
            w.project_op_id === options.projectOpId &&
            (options.versionOpId == null || w.version_op_id === options.versionOpId),
        );
        // Re-upsert = re-cache: this is what bumps `cached_at`, exactly as a
        // real page commit does.
        await repos.workPackages.upsertMany(
          matching.map((w) => ({
            connection_id: w.connection_id,
            op_id: w.op_id,
            project_op_id: w.project_op_id,
            subject: w.subject,
            type_name: w.type_name,
            status_name: w.status_name,
            status_is_closed: w.status_is_closed,
            assignee_op_id: w.assignee_op_id,
            assignee_name: w.assignee_name,
            estimated_hours: w.estimated_hours,
            remaining_hours: w.remaining_hours,
            spent_hours: w.spent_hours,
            story_points: w.story_points,
            version_op_id: w.version_op_id,
            version_name: w.version_name,
            priority: w.priority,
            parent_op_id: w.parent_op_id,
            percentage_done: w.percentage_done,
            updated_at_op: w.updated_at_op,
            raw_json: w.raw_json,
          })),
        );
        return repos.syncRuns.finish(
          run.id,
          "success",
          matching.length,
          null,
          new Date().toISOString(),
        );
      },
      syncByOpIds: (ids, signal) => real.syncByOpIds(ids, signal),
      importWorkPackage: (id) => real.importWorkPackage(id),
      fetchWorkPackageRow: (id, signal) => real.fetchWorkPackageRow(id, signal),
    };
  };
}

async function refreshAll(
  t: TestApp,
  payload: Record<string, unknown> = {},
): Promise<SyncRefreshAllResponse> {
  const res = await t.app.inject({ method: "POST", url: "/api/sync", payload });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<SyncRefreshAllResponse>();
}

describe("Increment 29 §1/§4 — sync coverage", () => {
  it("the §0a repro: a version-scoped selection leaves a row stale; the coverage pass refreshes it", async () => {
    const syncCalls: SyncOptions[] = [];
    let repos: Repositories | null = null;
    const t = await buildTestApp({
      // OP knows about BOTH work packages. The selection only covers version 5.
      opData: {
        statuses: [{ _type: "Status", id: 1, name: "New", isClosed: false }],
        workPackages: [
          opWp(1, { versionOpId: 5 }),
          opWp(2, { versionOpId: 9, subject: "Backlog TOP" }),
        ],
      },
      syncEngineFactory: scopedEngineFactory(() => repos!, syncCalls),
    });
    repos = t.repos;
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: conn.id,
      project_op_id: 100,
      project_name: "Project A",
      // VERSION-SCOPED — this is the whole point.
      version_op_id: 5,
      version_name: "v5",
    });
    await t.repos.workPackages.upsertMany([
      cacheRow({ op_id: 1, connection_id: conn.id, version_op_id: 5 }),
      // Same project, a version NOBODY selected: invisible to the selection
      // sync AND to the old project-only orphans pass.
      cacheRow({ op_id: 2, connection_id: conn.id, version_op_id: 9 }),
    ]);
    const before = await t.repos.workPackages.getByOpId(2);

    const body = await refreshAll(t);
    const outcome = body.connections.find((c) => c.connection_id === conn.id)!;
    expect(outcome.status).toBe("synced");
    // EVERY cached row is now refreshed — including the version nobody selected.
    expect(outcome.coverage).not.toBeNull();
    expect(outcome.coverage!.total_cached).toBe(2);
    expect(outcome.coverage!.refreshed).toBe(2);
    expect(outcome.coverage!.not_refreshed).toBe(0);
    expect(outcome.coverage!.orphan_op_ids).toEqual([]);

    // …and it really was re-cached in the DB, not merely counted.
    const after = await t.repos.workPackages.getByOpId(2);
    expect(Date.parse(after!.cached_at)).toBeGreaterThan(Date.parse(before!.cached_at));
    // Still owned by the right connection after the id-based refetch (the
    // engine writes connection_id null; the route stamps it).
    expect(after!.connection_id).toBe(conn.id);
    await t.close();
  });

  it("coverage numbers on a mixed cache are recounted from the DB", async () => {
    const syncCalls: SyncOptions[] = [];
    let repos: Repositories | null = null;
    const t = await buildTestApp({
      opData: {
        statuses: [{ _type: "Status", id: 1, name: "New", isClosed: false }],
        // OP returns 1 and 2, but NOT 3 — 3 is an orphan candidate.
        workPackages: [opWp(1), opWp(2, { projectOpId: 200 })],
      },
      syncEngineFactory: scopedEngineFactory(() => repos!, syncCalls),
    });
    repos = t.repos;
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: conn.id,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: null,
      version_name: null,
    });
    await t.repos.workPackages.upsertMany([
      cacheRow({ op_id: 1, connection_id: conn.id, project_op_id: 100 }),
      // Project 200 is NOT in the selection — the classic "added by id" row.
      cacheRow({ op_id: 2, connection_id: conn.id, project_op_id: 200 }),
      // Cached but gone from OP.
      cacheRow({ op_id: 3, connection_id: conn.id, project_op_id: 200 }),
    ]);

    const body = await refreshAll(t);
    const cov = body.connections.find((c) => c.connection_id === conn.id)!.coverage!;
    expect(cov.total_cached).toBe(3);
    expect(cov.refreshed).toBe(2);
    expect(cov.not_refreshed).toBe(1);
    expect(cov.orphan_op_ids).toEqual([3]);
    expect(cov.oldest_cached_at).not.toBeNull();
    // The stalest row IS the orphan (nothing re-cached it).
    const orphanRow = await t.repos.workPackages.getByOpId(3);
    expect(Date.parse(cov.oldest_cached_at!)).toBe(Date.parse(orphanRow!.cached_at));
    await t.close();
  });

  it("orphans are REPORTED, never deleted (CONTRACTS §4.2)", async () => {
    const syncCalls: SyncOptions[] = [];
    let repos: Repositories | null = null;
    const t = await buildTestApp({
      opData: {
        statuses: [{ _type: "Status", id: 1, name: "New", isClosed: false }],
        workPackages: [], // OP returns nothing at all
      },
      syncEngineFactory: scopedEngineFactory(() => repos!, syncCalls),
    });
    repos = t.repos;
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: conn.id,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: null,
      version_name: null,
    });
    // Project 400 is outside the selection, so the selection sync never
    // re-caches these — they reach the coverage pass, which asks OP for them
    // by id and gets nothing back.
    await t.repos.workPackages.upsertMany([
      cacheRow({ op_id: 7, connection_id: conn.id, project_op_id: 400 }),
      cacheRow({ op_id: 8, connection_id: conn.id, project_op_id: 400 }),
    ]);

    const body = await refreshAll(t);
    const cov = body.connections.find((c) => c.connection_id === conn.id)!.coverage!;
    expect(cov.orphan_op_ids.sort()).toEqual([7, 8]);
    // A row hidden by OP permissions is indistinguishable from a deleted one —
    // hard-deleting the user's sprint history on a guess is not recoverable.
    expect(await t.repos.workPackages.getByOpId(7)).not.toBeNull();
    expect(await t.repos.workPackages.getByOpId(8)).not.toBeNull();
    await t.close();
  });

  it("a skipped connection reports coverage: null, not a zeroed block", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: conn.id,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: null,
      version_name: null,
    });
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${conn.id}`,
      payload: { enabled: false },
    });
    const body = await refreshAll(t);
    const outcome = body.connections.find((c) => c.connection_id === conn.id)!;
    expect(outcome.status).toBe("skipped");
    // "Not measured", never "everything is stale".
    expect(outcome.coverage).toBeNull();
    await t.close();
  });
});

describe("Increment 29 §3/§5 — watermarks and full refresh", () => {
  it("every sync() call carries its connection id (the watermark KEY)", async () => {
    // Wiring assertion: omitting `connectionId` errors NOWHERE — it quietly
    // collapses every connection onto one legacy `(null, project)` watermark
    // group, i.e. exactly the cross-connection sharing CONTRACTS §3 forbids.
    const syncCalls: SyncOptions[] = [];
    let repos: Repositories | null = null;
    const t = await buildTestApp({
      opData: { statuses: [{ _type: "Status", id: 1, name: "New", isClosed: false }] },
      syncEngineFactory: scopedEngineFactory(() => repos!, syncCalls),
    });
    repos = t.repos;
    await initVault(t);
    const a = (await addConnection(t, { base_url: "https://a.example.com" })) as { id: number };
    const b = (await addConnection(t, { base_url: "https://b.example.com" })) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: a.id,
      project_op_id: 100,
      project_name: "P100",
      version_op_id: null,
      version_name: null,
    });
    await t.repos.importSelections.upsert({
      connection_id: b.id,
      project_op_id: 100,
      project_name: "P100",
      version_op_id: null,
      version_name: null,
    });

    await refreshAll(t);
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls.map((c) => c.connectionId).sort()).toEqual([a.id, b.id].sort());
    await t.close();
  });

  it("full_refresh clears the connection's watermarks; a plain sync does not", async () => {
    const syncCalls: SyncOptions[] = [];
    let repos: Repositories | null = null;
    const t = await buildTestApp({
      opData: { statuses: [{ _type: "Status", id: 1, name: "New", isClosed: false }] },
      syncEngineFactory: scopedEngineFactory(() => repos!, syncCalls),
    });
    repos = t.repos;
    await initVault(t);
    const a = (await addConnection(t, { base_url: "https://a.example.com" })) as { id: number };
    const b = (await addConnection(t, { base_url: "https://b.example.com" })) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: a.id,
      project_op_id: 100,
      project_name: "P100",
      version_op_id: null,
      version_name: null,
    });
    // Stored watermarks for BOTH connections (the fake engine never writes any).
    await t.repos.watermarks.set(a.id, 100, "2026-08-01T10:00:00Z");
    await t.repos.watermarks.set(b.id, 100, "2026-08-01T10:00:00Z");

    // A plain "Sync now" leaves them alone.
    const plain = await refreshAll(t);
    expect(plain.full_refresh).toBe(false);
    expect(await t.repos.watermarks.get(a.id, 100)).not.toBeNull();

    const full = await refreshAll(t, { full_refresh: true });
    expect(full.full_refresh).toBe(true);
    // Cleared for the connection that was refreshed…
    expect(await t.repos.watermarks.get(a.id, 100)).toBeNull();
    // …and untouched for a connection this pass never visited (no selection).
    expect(await t.repos.watermarks.get(b.id, 100)).not.toBeNull();
    await t.close();
  });

  it("full_refresh is IGNORED for a single-project sync (like connection_id)", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.watermarks.set(conn.id, 100, "2026-08-01T10:00:00Z");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { project_op_id: 100, connection_id: conn.id, full_refresh: true },
    });
    expect(res.statusCode, res.payload).toBe(200);
    // Clearing a whole connection's cutoffs as a side effect of importing ONE
    // project would widen every other project's window on that server.
    expect(await t.repos.watermarks.get(conn.id, 100)).not.toBeNull();
    await t.close();
  });
});

describe("Increment 29 §6 — out-of-selection listing and bulk delete", () => {
  /** Two selections: project 100 version-scoped to v5, project 300 project-wide. */
  async function seedSelectionAsymmetry(t: TestApp, connId: number): Promise<void> {
    await t.repos.importSelections.upsert({
      connection_id: connId,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: 5,
      version_name: "v5",
    });
    await t.repos.importSelections.upsert({
      connection_id: connId,
      project_op_id: 300,
      project_name: "Project C",
      version_op_id: null,
      version_name: null,
    });
  }

  it("lists exactly the rows no selection covers — the version asymmetry", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t, { label: "Acme" })) as { id: number };
    await seedSelectionAsymmetry(t, conn.id);
    await t.repos.workPackages.upsertMany([
      // covered: project 100, the selected version
      cacheRow({ op_id: 1, connection_id: conn.id, project_op_id: 100, version_op_id: 5 }),
      // NOT covered: project 100, a different version (the §0a asymmetry)
      cacheRow({ op_id: 2, connection_id: conn.id, project_op_id: 100, version_op_id: 9 }),
      // NOT covered: project 100, no version at all
      cacheRow({ op_id: 3, connection_id: conn.id, project_op_id: 100, version_op_id: null }),
      // covered: a PROJECT-WIDE selection covers every version…
      cacheRow({ op_id: 4, connection_id: conn.id, project_op_id: 300, version_op_id: 7 }),
      // …including no version
      cacheRow({ op_id: 5, connection_id: conn.id, project_op_id: 300, version_op_id: null }),
      // NOT covered: a project with no selection at all
      cacheRow({ op_id: 6, connection_id: conn.id, project_op_id: 400 }),
    ]);

    const res = await t.app.inject({
      method: "GET",
      url: "/api/backlog/out-of-selection",
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<OutOfSelectionResponse>();
    expect(body.entries.map((e) => e.op_id)).toEqual([2, 3, 6]);
    expect(body.total).toBe(3);
    expect(body.protected_count).toBe(0);
    expect(body.entries[0]!.connection_label).toBe("Acme");
    expect(body.entries[0]!.version_op_id).toBe(9);
    await t.close();
  });

  it("a ticket in ANY sprint is listed but flagged protected, whatever the status", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await seedSelectionAsymmetry(t, conn.id);
    await t.repos.workPackages.upsertMany([
      cacheRow({ op_id: 2, connection_id: conn.id, project_op_id: 100, version_op_id: 9 }),
      cacheRow({ op_id: 6, connection_id: conn.id, project_op_id: 400 }),
    ]);
    // A LOCKED, closed sprint — the status most likely to be forgotten by an
    // enumerated "planning/active/closed" rule.
    const sprint = await t.repos.sprints.create({
      name: "S-1",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 6, planned_hours: 4, outcome: "planned", origin: "baseline" });
    await t.repos.sprints.close(sprint.id, 4, "2026-07-14T00:00:00Z", "finished");

    const body = (
      await t.app.inject({ method: "GET", url: "/api/backlog/out-of-selection" })
    ).json<OutOfSelectionResponse>();
    const byId = new Map(body.entries.map((e) => [e.op_id, e]));
    expect(byId.get(2)!.in_sprint).toBe(false);
    expect(byId.get(6)!.in_sprint).toBe(true);
    expect(byId.get(6)!.sprint_names).toEqual(["S-1"]);
    expect(body.protected_count).toBe(1);
    await t.close();
  });

  it("bulk delete honours all three buckets and is a 200 on partial success", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await seedSelectionAsymmetry(t, conn.id);
    await t.repos.workPackages.upsertMany([
      // deletable
      cacheRow({ op_id: 2, connection_id: conn.id, project_op_id: 100, version_op_id: 9 }),
      cacheRow({ op_id: 6, connection_id: conn.id, project_op_id: 400 }),
      // protected (in a sprint)
      cacheRow({ op_id: 10, connection_id: conn.id, project_op_id: 400 }),
      // in selection (the client's list was stale)
      cacheRow({ op_id: 1, connection_id: conn.id, project_op_id: 100, version_op_id: 5 }),
    ]);
    const sprint = await t.repos.sprints.create({
      name: "S-1",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 10, planned_hours: 4, outcome: "planned", origin: "baseline" });

    const res = await t.app.inject({
      method: "POST",
      url: "/api/backlog/out-of-selection/delete",
      // 999 was never cached at all.
      payload: { op_ids: [2, 6, 10, 1, 999] },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<DeleteOutOfSelectionResponse>();
    expect(body.removed.sort()).toEqual([2, 6]);
    expect(body.protected).toEqual([{ op_id: 10, sprint_names: ["S-1"] }]);
    expect(body.rejected.sort((a, b) => a.op_id - b.op_id)).toEqual([
      { op_id: 1, reason: "in_selection" },
      { op_id: 999, reason: "not_cached" },
    ]);

    // Only the two deletable rows are gone; the sprint item survives untouched.
    expect(await t.repos.workPackages.getByOpId(2)).toBeNull();
    expect(await t.repos.workPackages.getByOpId(6)).toBeNull();
    expect(await t.repos.workPackages.getByOpId(10)).not.toBeNull();
    expect(await t.repos.workPackages.getByOpId(1)).not.toBeNull();
    expect(await t.repos.sprintItems.listBySprint(sprint.id)).toHaveLength(1);
    await t.close();
  });

  it("an empty op_ids list is a validation error, not a silent no-op", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/backlog/out-of-selection/delete",
      payload: { op_ids: [] },
    });
    expect(res.statusCode).toBe(400);
    await t.close();
  });
});
