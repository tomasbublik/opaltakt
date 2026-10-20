import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mockOpServer } from "@osp/fixtures";
import { createOpClient } from "@osp/op-client";
import type { OpClient } from "@osp/op-client";
import type {
  Project,
  Sprint,
  SprintItem,
  WorkPackageCache,
} from "@osp/contracts";
import {
  aggregateTimeEntries,
  applyOverlapWindow,
  buildWorkPackagesFilters,
  computeSnapshot,
  countWorkingDays,
  createSyncEngine,
  hardCancelRun,
  ID_FETCH_BATCH_SIZE,
  SYNC_OVERLAP_WINDOW_MINUTES,
  hardCancelSprintUpdateRun,
  idealRemainingHours,
  reconcileDrift,
  registerHardCancelController,
  registerSprintUpdateController,
  resolveIncrementalCutoffSource,
  unregisterHardCancelController,
  unregisterSprintUpdateController,
  writeSnapshotForSprint,
} from "./index";
import type { OpRequestOptions } from "@osp/op-client";
import { isOpCancelledError } from "@osp/op-client";
import {
  FakeBurndownRepo,
  FakeProjectRepo,
  FakeRemainingStatusRuleRepo,
  FakeSprintItemRepo,
  FakeSprintRepo,
  FakeSyncRunRepo,
  FakeSyncWatermarkRepo,
  FakeWorkPackageCacheRepo,
} from "./fakes";

let op: OpClient;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockOpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = mockOpServer.address() as AddressInfo;
  op = createOpClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: "t" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    mockOpServer.close(() => resolve());
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function wpCache(over: Partial<WorkPackageCache> & { op_id: number }): WorkPackageCache {
  return {
    id: over.op_id,
    connection_id: null,
    project_op_id: 3,
    subject: "wp",
    type_name: "Task",
    status_name: "New",
    status_is_closed: false,
    assignee_op_id: null,
    assignee_name: null,
    estimated_hours: null,
    remaining_hours: null,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-06-20T00:00:00Z",
    raw_json: "{}",
    cached_at: "2026-06-20T00:00:00Z",
    ...over,
  };
}

function sprintItem(over: Partial<SprintItem> & { id: number; wp_op_id: number }): SprintItem {
  return {
    sprint_id: 1,
    added_at: "2026-06-22T00:00:00Z",
    planned_hours: null,
    outcome: "planned",
    removed_at: null,
    origin: "baseline",
    retro_source: null,
    ...over,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("buildWorkPackagesFilters (SPEC §5)", () => {
  it("scopes to project on full sync (no updatedAt clause)", () => {
    expect(buildWorkPackagesFilters({ projectOpId: 3 })).toEqual([
      { project: { operator: "=", values: ["3"] } },
    ]);
  });
  it("adds updatedAt >= since on incremental", () => {
    const f = buildWorkPackagesFilters({
      projectOpId: 3,
      updatedSince: "2026-06-28T14:30:00Z",
    });
    expect(f).toEqual([
      { project: { operator: "=", values: ["3"] } },
      { updatedAt: { operator: ">=d", values: ["2026-06-28T14:30:00Z"] } },
    ]);
  });
  it("adds a version clause alongside the project clause when versionOpId is set", () => {
    expect(buildWorkPackagesFilters({ projectOpId: 3, versionOpId: 200 })).toEqual([
      { project: { operator: "=", values: ["3"] } },
      { version: { operator: "=", values: ["200"] } },
    ]);
  });
});

describe("aggregateTimeEntries", () => {
  it("sums per WP, per day, and per WP/day", async () => {
    const entries = (await op.getTimeEntries({}))._embedded.elements;
    const agg = aggregateTimeEntries(entries);
    expect(agg.byWorkPackage.get(1001)).toBe(4); // 2h + 2h
    expect(agg.byWorkPackage.get(1003)).toBe(2);
    expect(agg.byDay.get("2026-06-24")).toBe(2);
    expect(agg.byWorkPackageDay.get(1001)?.get("2026-06-26")).toBe(2);
  });

  it("sums per LOGGER by _links.user, taking the name off the entry (SPEC_14 §3)", async () => {
    const entries = (await op.getTimeEntries({}))._embedded.elements;
    const agg = aggregateTimeEntries(entries);
    // All three fixture entries are logged by user 1 (Ada Lovelace): 3 × 2h.
    expect(agg.byLogger.get(1)).toEqual({ name: "Ada Lovelace", hours: 6 });
  });

  it("attributes by WHO LOGGED, never by assignee, and skips unattributed entries", () => {
    // Hand-built set: WP 500 is assigned to nobody relevant here — attribution
    // must follow _links.user, not the work package. User 7 logs on two WPs;
    // user 9 logs once; one entry has a null user href (unattributed) and must
    // NOT create a byLogger bucket while still counting toward byWorkPackage.
    const entries = [
      {
        _type: "TimeEntry",
        id: 1,
        hours: "PT3H",
        spentOn: "2026-07-01",
        _links: {
          self: { href: "/api/v3/time_entries/1" },
          workPackage: { href: "/api/v3/work_packages/500" },
          user: { href: "/api/v3/users/7", title: "Grace Hopper" },
        },
      },
      {
        _type: "TimeEntry",
        id: 2,
        hours: "PT1H30M",
        spentOn: "2026-07-02",
        _links: {
          self: { href: "/api/v3/time_entries/2" },
          workPackage: { href: "/api/v3/work_packages/501" },
          user: { href: "/api/v3/users/7", title: "Grace Hopper" },
        },
      },
      {
        _type: "TimeEntry",
        id: 3,
        hours: "PT2H",
        spentOn: "2026-07-02",
        _links: {
          self: { href: "/api/v3/time_entries/3" },
          workPackage: { href: "/api/v3/work_packages/500" },
          user: { href: "/api/v3/users/9", title: "Alan Turing" },
        },
      },
      {
        _type: "TimeEntry",
        id: 4,
        hours: "PT4H",
        spentOn: "2026-07-03",
        _links: {
          self: { href: "/api/v3/time_entries/4" },
          workPackage: { href: "/api/v3/work_packages/500" },
          user: { href: null }, // OP couldn't attribute an actor → skipped
        },
      },
    ] as unknown as Parameters<typeof aggregateTimeEntries>[0];

    const agg = aggregateTimeEntries(entries);
    expect(agg.byLogger.get(7)).toEqual({ name: "Grace Hopper", hours: 4.5 });
    expect(agg.byLogger.get(9)).toEqual({ name: "Alan Turing", hours: 2 });
    expect(agg.byLogger.size).toBe(2); // the null-href entry made no bucket
    // …but it still counts toward the WP total (4h unattributed on WP 500).
    expect(agg.byWorkPackage.get(500)).toBe(9); // 3 + 2 + 4
  });
});

describe("createSyncEngine — pagination-driven upsert (SPEC §5)", () => {
  it("pages all WPs, maps them, records a successful full run", async () => {
    const workPackages = new FakeWorkPackageCacheRepo();
    const projects = new FakeProjectRepo();
    projects.seed([
      { id: 1, op_id: 3, identifier: "demo", name: "Demo", last_synced_at: null },
    ] as Project[]);
    const sprintItems = new FakeSprintItemRepo();
    const syncRuns = new FakeSyncRunRepo();

    const engine = createSyncEngine({
      op,
      projects,
      workPackages,
      sprintItems,
      syncRuns,
    });
    const run = await engine.sync({ projectOpId: 3 });

    expect(run.kind).toBe("full");
    expect(run.status).toBe("success");
    expect(run.wp_count).toBe(3);
    expect(run.total_count).toBe(3); // progress total recorded for the UI bar
    expect([...workPackages.rows.keys()].sort()).toEqual([1001, 1002, 1003]);

    const wp1001 = workPackages.rows.get(1001)!;
    expect(wp1001.remaining_hours).toBe(4);
    expect(wp1001.status_is_closed).toBe(false);
    expect(wp1001.spent_hours).toBe(4); // direct spentTime PT4H
    expect(wp1001.parent_op_id).toBeNull();

    const wp1002 = workPackages.rows.get(1002)!;
    // spentTime null in OP and no time entries → null (no fabricated value).
    expect(wp1002.spent_hours).toBeNull();
    expect(wp1002.parent_op_id).toBe(1001);

    const wp1003 = workPackages.rows.get(1003)!;
    expect(wp1003.status_is_closed).toBe(true);
    expect(wp1003.remaining_hours).toBe(0);

    expect(projects.lastSynced.get(3)).toBeTruthy();
  });

  it("records an error run when OP is unreachable", async () => {
    const badOp = createOpClient({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      maxRetries: 0,
    });
    const syncRuns = new FakeSyncRunRepo();
    const engine = createSyncEngine({
      op: badOp,
      projects: new FakeProjectRepo(),
      workPackages: new FakeWorkPackageCacheRepo(),
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
    });
    const run = await engine.sync({ projectOpId: 3 });
    expect(run.status).toBe("error");
    expect(run.error).toBeTruthy();
  });
});

describe("reconcileDrift (SPEC §6)", () => {
  it("marks removed only for vanished WPs of the synced project", async () => {
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        start_date: "2026-06-22",
        end_date: "2026-06-26",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
      },
    ] as Sprint[]);
    const items = new FakeSprintItemRepo();
    items.seed([
      sprintItem({ id: 10, wp_op_id: 1001 }), // present → keep
      sprintItem({ id: 11, wp_op_id: 9999 }), // vanished, project 3 → removed
      sprintItem({ id: 12, wp_op_id: 1002, outcome: "done" }), // done → skip
      sprintItem({ id: 13, wp_op_id: 5555 }), // vanished but other project → skip
    ]);
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([
      wpCache({ op_id: 1001, project_op_id: 3 }),
      wpCache({ op_id: 9999, project_op_id: 3 }),
      wpCache({ op_id: 1002, project_op_id: 3 }),
      wpCache({ op_id: 5555, project_op_id: 7 }),
    ]);

    const result = await reconcileDrift(
      { sprints, sprintItems: items, workPackages },
      { projectOpId: 3, presentWpOpIds: new Set([1001, 1002]), now: "2026-07-01T00:00:00Z" },
    );

    expect(result.removedItemIds).toEqual([11]);
    expect(items.items.find((i) => i.id === 11)?.outcome).toBe("removed");
    expect(items.items.find((i) => i.id === 11)?.removed_at).toBe("2026-07-01T00:00:00Z");
    expect(items.items.find((i) => i.id === 10)?.outcome).toBe("planned");
    expect(items.items.find((i) => i.id === 13)?.outcome).toBe("planned");
  });
});

describe("createSyncEngine — version-scoped import (SPEC §5)", () => {
  it("forces a FULL run and skips drift reconciliation for a version-scoped sync", async () => {
    // Prior cached data for project 3 → maxUpdatedAtOp is non-null, so an
    // unscoped sync would auto-pick "incremental". A version scope forces "full".
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([
      wpCache({ op_id: 1001, project_op_id: 3, version_op_id: 100 }),
      wpCache({ op_id: 1002, project_op_id: 3, version_op_id: 100 }),
    ]);

    const projects = new FakeProjectRepo();
    projects.seed([
      { id: 1, op_id: 3, identifier: "demo", name: "Demo", last_synced_at: null },
    ] as Project[]);

    // A sprint with a "planned" item whose WP (1001, version 100) is NOT in the
    // version-101 result. A wrongly-run drift reconciliation would mark it removed.
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        start_date: "2026-06-22",
        end_date: "2026-06-26",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
      },
    ] as Sprint[]);
    const sprintItems = new FakeSprintItemRepo();
    sprintItems.seed([sprintItem({ id: 20, wp_op_id: 1001 })]);
    const syncRuns = new FakeSyncRunRepo();

    const engine = createSyncEngine({
      op,
      projects,
      workPackages,
      sprintItems,
      syncRuns,
      sprints,
    });

    // version 101 in the mock returns only WP 1003 (a strict subset of project 3).
    const run = await engine.sync({ projectOpId: 3, versionOpId: 101 });

    // (a) version-scoped forces full even with prior cached data.
    expect(run.kind).toBe("full");
    expect(run.status).toBe("success");
    expect(run.wp_count).toBe(1); // only WP 1003 matches version 101
    expect(workPackages.rows.has(1003)).toBe(true);

    // (b) drift reconciliation was skipped: the sprint item for WP 1001 (a
    // different version, absent from the version-filtered result) stays planned.
    expect(sprintItems.items.find((i) => i.id === 20)?.outcome).toBe("planned");
    expect(sprintItems.items.find((i) => i.id === 20)?.removed_at).toBeNull();
  });
});

describe("createSyncEngine — importWorkPackage (SPEC §5)", () => {
  it("imports a single WP by op id and caches it; returns null for a missing one", async () => {
    const workPackages = new FakeWorkPackageCacheRepo();
    const engine = createSyncEngine({
      op,
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
    });

    const imported = await engine.importWorkPackage(1001);
    expect(imported).not.toBeNull();
    expect(imported!.op_id).toBe(1001);
    expect(imported!.subject).toBe("Implement login");
    expect(imported!.status_name).toBe("In progress");
    // The WP was upserted into the cache fake.
    expect(workPackages.rows.get(1001)?.subject).toBe("Implement login");
    expect(workPackages.upserts.some((u) => u.op_id === 1001)).toBe(true);

    // OP has no WP 999999 → null, and nothing new cached for it.
    const missing = await engine.importWorkPackage(999999);
    expect(missing).toBeNull();
    expect(workPackages.rows.has(999999)).toBe(false);
  });
});

// A controllable fake OpClient exposing only the three methods sync() touches
// (getStatuses / getTimeEntries / getWorkPackages), so a test can drive
// multi-page pagination and observe/trigger a cancel between pages. PAGE_SIZE
// inside the engine is 100, so "multiple pages" means total > 100.
function fakeWp(id: number): unknown {
  return { id, subject: `wp-${id}`, _links: {}, updatedAt: "2026-06-20T00:00:00Z" };
}

function fakePagingOp(opts: {
  total: number;
  /** Called once per getWorkPackages page with its 1-based offset. */
  onPage?: (offset: number) => void;
}): OpClient {
  const emptyCollection = <T,>(): unknown => ({
    _type: "Collection",
    total: 0,
    count: 0,
    pageSize: 100,
    offset: 1,
    _embedded: { elements: [] as T[] },
    _links: { self: { href: "/" } },
  });
  return {
    getStatuses: async () => emptyCollection(),
    getTimeEntries: async () => emptyCollection(),
    getWorkPackages: async (query: { pageSize?: number; offset?: number }) => {
      const pageSize = query.pageSize ?? 100;
      const offset = query.offset ?? 1;
      opts.onPage?.(offset);
      const start = (offset - 1) * pageSize;
      const ids: number[] = [];
      for (let i = start; i < Math.min(start + pageSize, opts.total); i += 1) {
        ids.push(1000 + i);
      }
      return {
        _type: "WorkPackageCollection",
        total: opts.total,
        count: ids.length,
        pageSize,
        offset,
        _embedded: { elements: ids.map(fakeWp) },
        _links: { self: { href: "/" } },
      };
    },
  } as unknown as OpClient;
}

describe("createSyncEngine — buffer-then-commit + cancellation (SPEC_19 §2c)", () => {
  it("buffers all pages and writes the cache exactly ONCE on success", async () => {
    const workPackages = new FakeWorkPackageCacheRepo();
    const syncRuns = new FakeSyncRunRepo();
    // total 150 > PAGE_SIZE 100 → two pages.
    const engine = createSyncEngine({
      op: fakePagingOp({ total: 150 }),
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
    });

    const run = await engine.sync({ projectOpId: 3 });

    expect(run.status).toBe("success");
    expect(run.wp_count).toBe(150);
    // The whole point of the buffering change: ONE write, not one-per-page.
    expect(workPackages.upsertManyCalls).toBe(1);
    expect(workPackages.rows.size).toBe(150);
  });

  it("aborts mid-loop on requestCancel: status=aborted and the cache is NEVER written", async () => {
    const workPackages = new FakeWorkPackageCacheRepo();
    const syncRuns = new FakeSyncRunRepo();
    // After page 1 is served, request a cancel — the pre-fetch poll on the next
    // iteration must observe it and stop before page 2, writing nothing.
    const op2 = fakePagingOp({
      total: 150,
      onPage: (offset) => {
        if (offset === 1) {
          const id = syncRuns.runs.at(-1)!.id;
          void syncRuns.requestCancel(id);
        }
      },
    });
    const engine = createSyncEngine({
      op: op2,
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
    });

    const run = await engine.sync({ projectOpId: 3 });

    expect(run.status).toBe("aborted");
    // processed reflects page 1's fetched-but-uncommitted rows (audit only).
    expect(run.wp_count).toBe(100);
    // The cache stays byte-identical to before the sync: no write at all.
    expect(workPackages.upsertManyCalls).toBe(0);
    expect(workPackages.rows.size).toBe(0);
  });

  it("a cancel that lands during the LAST page's fetch (no further pre-fetch checkpoint to catch it) still aborts and writes nothing", async () => {
    // Regression: the in-loop poll only runs BEFORE each fetch, so a cancel
    // requested while the FINAL page's request is already in flight has no
    // subsequent iteration to observe it — confirmed live against a real dev
    // instance, where such a run finished "success" (cache written) despite
    // cancel_requested=true. A final post-loop check closes this.
    const workPackages = new FakeWorkPackageCacheRepo();
    const syncRuns = new FakeSyncRunRepo();
    // total 150 → exactly two pages; request cancel once page 2 (the LAST
    // page) starts, i.e. after the pre-fetch poll for page 2 already passed.
    const op2 = fakePagingOp({
      total: 150,
      onPage: (offset) => {
        if (offset === 2) {
          const id = syncRuns.runs.at(-1)!.id;
          void syncRuns.requestCancel(id);
        }
      },
    });
    const engine = createSyncEngine({
      op: op2,
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
    });

    const run = await engine.sync({ projectOpId: 3 });

    expect(run.status).toBe("aborted");
    // Both pages had already been fetched (audit-only count); nothing committed.
    expect(run.wp_count).toBe(150);
    expect(workPackages.upsertManyCalls).toBe(0);
    expect(workPackages.rows.size).toBe(0);
  });

  it("fetchWorkPackageRow maps a row WITHOUT writing; importWorkPackage still writes", async () => {
    const workPackages = new FakeWorkPackageCacheRepo();
    const engine = createSyncEngine({
      op,
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
    });

    const row = await engine.fetchWorkPackageRow(1001);
    expect(row).not.toBeNull();
    expect(row!.op_id).toBe(1001);
    expect(row!.subject).toBe("Implement login");
    // Fetch-only contract: nothing written to the cache.
    expect(workPackages.upsertManyCalls).toBe(0);
    expect(workPackages.rows.size).toBe(0);

    // A missing WP yields null, still no write.
    expect(await engine.fetchWorkPackageRow(999999)).toBeNull();
    expect(workPackages.upsertManyCalls).toBe(0);

    // importWorkPackage keeps its own write (unchanged behaviour).
    const imported = await engine.importWorkPackage(1001);
    expect(imported!.op_id).toBe(1001);
    expect(workPackages.upsertManyCalls).toBe(1);
    expect(workPackages.rows.get(1001)?.subject).toBe("Implement login");
  });
});

// Increment 20 (SPEC_20 §1) — an AbortSignal-aware fake OpClient. It routes its
// typed methods through `this.request`, so withHardCancel's injected per-request
// signal actually reaches the "network" call (the plain object-literal
// fakePagingOp above never sees a signal). A chosen 1-based getWorkPackages call
// index HANGS until its signal aborts — modelling a request OP never answers.
function fakeHardCancelOp(opts: {
  /** Total WPs a non-hanging getWorkPackages page reports. */
  total?: number;
  /** 1-based getWorkPackages call index that hangs until aborted. */
  hangOnWpCall: number;
  /** Fired with the 1-based call index on every getWorkPackages request. */
  onWpCall?: (n: number) => void;
}): OpClient {
  const emptyCollection = (): unknown => ({
    _type: "Collection",
    total: 0,
    count: 0,
    pageSize: 100,
    offset: 1,
    _embedded: { elements: [] as unknown[] },
    _links: { self: { href: "/" } },
  });
  let wpCalls = 0;
  const c = {
    request(options: OpRequestOptions): Promise<unknown> {
      const path = options.path;
      if (path.includes("/statuses") || path.includes("/time_entries")) {
        return Promise.resolve(emptyCollection());
      }
      // work_packages
      wpCalls += 1;
      const n = wpCalls;
      opts.onWpCall?.(n);
      if (n === opts.hangOnWpCall) {
        return new Promise<never>((_resolve, reject) => {
          const s = options.signal;
          const abort = (): void =>
            reject(s?.reason ?? new DOMException("Aborted", "AbortError"));
          if (s?.aborted) {
            abort();
            return;
          }
          s?.addEventListener("abort", abort, { once: true });
        });
      }
      const total = opts.total ?? 1;
      const query = (options.query ?? {}) as { pageSize?: number; offset?: number };
      const pageSize = query.pageSize ?? 100;
      const offset = query.offset ?? 1;
      const start = (offset - 1) * pageSize;
      const ids: number[] = [];
      for (let i = start; i < Math.min(start + pageSize, total); i += 1) ids.push(1000 + i);
      return Promise.resolve({
        _type: "WorkPackageCollection",
        total,
        count: ids.length,
        pageSize,
        offset,
        _embedded: { elements: ids.map(fakeWp) },
        _links: { self: { href: "/" } },
      });
    },
    getStatuses(this: OpClient) {
      return this.request({ path: "/api/v3/statuses" });
    },
    getTimeEntries(this: OpClient, query: unknown) {
      return this.request({ path: "/api/v3/time_entries", query: query as never });
    },
    getWorkPackages(this: OpClient, query: unknown) {
      return this.request({ path: "/api/v3/work_packages", query: query as never });
    },
  } as unknown as OpClient;
  return c;
}

describe("createSyncEngine — HARD cancel of a hung request (SPEC_20 §1)", () => {
  it("hardCancelRun interrupts a hung getWorkPackages promptly: aborted, staging dropped, never committed", async () => {
    const workPackages = new FakeWorkPackageCacheRepo();
    const syncRuns = new FakeSyncRunRepo();
    // Page 1's fetch hangs forever. hardCancelRun must interrupt the single
    // `await` — the real Increment 19 incident, where the between-pages poll is
    // never reached because the loop is stuck inside one request.
    const op2 = fakeHardCancelOp({
      hangOnWpCall: 1,
      onWpCall: (n) => {
        if (n === 1) {
          const id = syncRuns.runs.at(-1)!.id;
          // Cancel a beat after the hang is in flight (not the 30s timeout).
          setTimeout(() => hardCancelRun(id), 10);
        }
      },
    });
    const engine = createSyncEngine({
      op: op2,
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
    });

    const t0 = Date.now();
    const run = await engine.sync({ projectOpId: 3 });
    const elapsed = Date.now() - t0;

    expect(run.status).toBe("aborted");
    expect(elapsed).toBeLessThan(1000); // nowhere near the 30s per-request timeout
    // Crash-hygiene ran, and the abort path dropped this run's staging; nothing
    // was ever merged into the live cache.
    expect(workPackages.clearAllStagingCalls).toBe(1);
    expect(workPackages.dropStagingCalls).toBeGreaterThanOrEqual(1);
    expect(workPackages.commitStagingCalls).toBe(0);
    expect(workPackages.upsertManyCalls).toBe(0);
    expect(workPackages.rows.size).toBe(0);
  });

  it("also interrupts the drift-reconciliation pagination (incremental sync's second, previously unguarded loop)", async () => {
    // Prior cached data → maxUpdatedAtOp non-null → auto kind = incremental, so
    // drift reconciliation runs collectProjectWorkPackageIds — a SECOND
    // pagination loop that must ALSO be hard-cancellable.
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([wpCache({ op_id: 1001, project_op_id: 3 })]);
    const syncRuns = new FakeSyncRunRepo();
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        start_date: "2026-06-22",
        end_date: "2026-06-26",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
      },
    ] as Sprint[]);
    const projects = new FakeProjectRepo();
    projects.seed([
      { id: 1, op_id: 3, identifier: "demo", name: "Demo", last_synced_at: null },
    ] as Project[]);

    // Call #1 = main loop page (total 1 → loop ends, commit succeeds); call #2 =
    // the drift-reconciliation fetch, which hangs.
    const op2 = fakeHardCancelOp({
      total: 1,
      hangOnWpCall: 2,
      onWpCall: (n) => {
        if (n === 2) {
          const id = syncRuns.runs.at(-1)!.id;
          setTimeout(() => hardCancelRun(id), 10);
        }
      },
    });
    const engine = createSyncEngine({
      op: op2,
      projects,
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
      sprints,
    });

    const t0 = Date.now();
    const run = await engine.sync({ projectOpId: 3 });
    const elapsed = Date.now() - t0;

    expect(run.kind).toBe("incremental");
    expect(run.status).toBe("aborted"); // the drift-loop hang was interrupted
    expect(elapsed).toBeLessThan(1000);
    // The main loop's page committed before drift ran; the abort still drops
    // (now-empty) staging for the run without error.
    expect(workPackages.commitStagingCalls).toBe(1);
    expect(workPackages.dropStagingCalls).toBeGreaterThanOrEqual(1);
  });
});

// Increment 23 (SPEC_23 §3) — the watchdog-reliability fix. The production
// incident: a sync_run created NOT by engine.sync() but directly by apps/api's
// "orphans" pass (re-syncing individually-added tickets outside any import
// selection) ran for 3 REAL hours after the watchdog logged "no progress for
// 60s, aborting". Root cause: that pass never registered a controller in this
// module's runningSyncControllers map, so hardCancelRun(thatRunId) was a silent
// no-op. These tests prove an EXTERNAL caller can now register its own
// controller and have hardCancelRun / the watchdog actually interrupt it.
describe("hard-cancel registry — external (orphans-loop) registration (SPEC_23 §3)", () => {
  it("registerHardCancelController + hardCancelRun compose for a run NEVER created via sync()", () => {
    // Simulate the orphans loop: it owns its own run id (from syncRuns.start())
    // and its own AbortController — engine.sync() is never involved.
    const runId = 987_654; // arbitrary; not produced by any sync() here
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);

    registerHardCancelController(runId, controller);

    // The watchdog / cancel route calls hardCancelRun(runId): it must now find
    // and abort THIS externally-registered controller — the exact path that was
    // a silent no-op before the Increment-23 export.
    expect(hardCancelRun(runId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    unregisterHardCancelController(runId); // cleanup — no cross-test leakage
  });

  it("unregisterHardCancelController makes a subsequent hardCancelRun return false (no stale registration / double-abort)", () => {
    const runId = 123_321;
    const controller = new AbortController();
    registerHardCancelController(runId, controller);

    // Caller's finally block unregisters after its I/O completes normally...
    unregisterHardCancelController(runId);

    // ...so a later hardCancelRun (e.g. a watchdog racing an already-finished
    // run) finds nothing and is a no-op — false, and never touches a controller
    // whose run is done.
    expect(hardCancelRun(runId)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("returns true then false across an abort — after hardCancelRun+unregister, a re-cancel is a no-op", () => {
    const runId = 555_000;
    const controller = new AbortController();
    registerHardCancelController(runId, controller);

    expect(hardCancelRun(runId)).toBe(true); // first cancel aborts
    expect(controller.signal.aborted).toBe(true);
    unregisterHardCancelController(runId); // caller's finally after the abort

    // A second cancel for the same id (a duplicate watchdog tick) is harmless.
    expect(hardCancelRun(runId)).toBe(false);
  });

  it("fetchWorkPackageRow(opId, signal) fails FAST with OpCancelledError on an already-aborted signal (real wiring, not just a map entry)", async () => {
    // This is the actual proof the §3 wiring works end to end: an already-fired
    // external signal must abort the single-ticket fetch's OP request via
    // withHardCancel — not complete it. Using the real mock-server `op` shows
    // the abort short-circuits BEFORE any network round-trip.
    const engine = createSyncEngine({
      op,
      projects: new FakeProjectRepo(),
      workPackages: new FakeWorkPackageCacheRepo(),
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
    });

    const controller = new AbortController();
    controller.abort(new DOMException("Sync cancelled by user", "AbortError"));

    await expect(engine.fetchWorkPackageRow(1001, controller.signal)).rejects.toSatisfy(
      isOpCancelledError,
    );
  });

  it("an externally-registered controller interrupts a HUNG fetchWorkPackageRow via hardCancelRun (the full orphans-loop scenario)", async () => {
    // The end-to-end §3 proof: mirror EXACTLY what apps/api's orphans loop does —
    //   1. syncRuns.start() gives it a run id (here we take the fake's next id),
    //   2. it makes its own AbortController and registerHardCancelController(id, c),
    //   3. it fetches a ticket via fetchWorkPackageRow(opId, c.signal),
    //   4. the watchdog notices no progress and calls hardCancelRun(id).
    // Before the Increment-23 export, step 4 returned false (no-op) and the hung
    // fetch ran until manual restart. Now it aborts promptly.
    const syncRuns = new FakeSyncRunRepo();
    const run = await syncRuns.start("full"); // the orphans pass owns this run
    const controller = new AbortController();
    registerHardCancelController(run.id, controller);

    // A client whose getWorkPackages call #1 hangs until its signal aborts.
    const hungOp = fakeHardCancelOp({ hangOnWpCall: 1 });
    const engine = createSyncEngine({
      op: hungOp,
      projects: new FakeProjectRepo(),
      workPackages: new FakeWorkPackageCacheRepo(),
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
    });

    // Fire the watchdog a beat after the fetch is in flight (well under the 30s
    // per-request timeout — proving hardCancelRun, not the timeout, stopped it).
    let cancelReturned: boolean | null = null;
    setTimeout(() => {
      cancelReturned = hardCancelRun(run.id);
    }, 10);

    const t0 = Date.now();
    await expect(
      engine.fetchWorkPackageRow(2002, controller.signal),
    ).rejects.toSatisfy(isOpCancelledError);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000); // nowhere near the 30s timeout
    expect(cancelReturned).toBe(true); // hardCancelRun FOUND the external controller

    unregisterHardCancelController(run.id); // caller's finally
  });
});

// Consolidation Round (Concept 8) — the PARALLEL hard-cancel registry for
// sprint_update_run ids (activation/update/finish/retro-replay), mirroring the
// sync_run registry above. Deliberately a SEPARATE Map so the two independent
// id spaces (both auto-increment from 1) never collide.
describe("hard-cancel registry — sprint_update_run parallel registry (Concept 8)", () => {
  it("register + hardCancelSprintUpdateRun compose and abort the run's controller", () => {
    const runId = 4242;
    const controller = new AbortController();
    registerSprintUpdateController(runId, controller);
    expect(hardCancelSprintUpdateRun(runId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    unregisterSprintUpdateController(runId);
  });

  it("unregister makes a later cancel a no-op (no stale registration)", () => {
    const runId = 4343;
    const controller = new AbortController();
    registerSprintUpdateController(runId, controller);
    unregisterSprintUpdateController(runId);
    expect(hardCancelSprintUpdateRun(runId)).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("is ISOLATED from the sync_run registry — same numeric id never cross-cancels", () => {
    // The exact reason for a separate Map: a sync_run and a sprint_update_run
    // can both be id 7. Cancelling one must NEVER abort the other.
    const id = 7;
    const syncController = new AbortController();
    const updateController = new AbortController();
    registerHardCancelController(id, syncController);
    registerSprintUpdateController(id, updateController);

    // Cancel ONLY the sprint_update_run id 7.
    expect(hardCancelSprintUpdateRun(id)).toBe(true);
    expect(updateController.signal.aborted).toBe(true);
    expect(syncController.signal.aborted, "sync_run id 7 must be untouched").toBe(false);

    // ...and vice-versa.
    expect(hardCancelRun(id)).toBe(true);
    expect(syncController.signal.aborted).toBe(true);

    unregisterHardCancelController(id);
    unregisterSprintUpdateController(id);
  });
});

describe("working-day math (SPEC §6)", () => {
  it("counts weekdays inclusive, excluding weekends", () => {
    expect(countWorkingDays("2026-06-22", "2026-06-26")).toBe(5); // Mon–Fri
    expect(countWorkingDays("2026-06-19", "2026-06-23")).toBe(3); // Fri + Mon + Tue
  });
  it("ideal declines linearly to 0 across working days", () => {
    const args = { totalPlanned: 10, startDate: "2026-06-22", endDate: "2026-06-26" };
    // Canonical ideal (matches apps/api idealCurve): full at day 0 → 0 on last day.
    expect(idealRemainingHours({ ...args, date: "2026-06-22" })).toBe(10); // day 0 of 5
    expect(idealRemainingHours({ ...args, date: "2026-06-24" })).toBe(5); // day 2 of 5
    expect(idealRemainingHours({ ...args, date: "2026-06-26" })).toBe(0); // day 4 of 5
  });
});

describe("computeSnapshot / writeSnapshotForSprint (SPEC §6)", () => {
  it("computes remaining/logged/ideal/done on a known input", async () => {
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        start_date: "2026-06-22",
        end_date: "2026-06-26",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
      },
    ] as Sprint[]);
    const items = new FakeSprintItemRepo();
    items.seed([
      sprintItem({ id: 1, wp_op_id: 1001, planned_hours: 8 }),
      sprintItem({ id: 2, wp_op_id: 1003, planned_hours: 2 }),
    ]);
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([
      // SPEC_11 §6: Remaining counts a "New" ticket WITH an estimate only.
      wpCache({ op_id: 1001, status_is_closed: false, estimated_hours: 8, remaining_hours: 4 }),
      wpCache({ op_id: 1003, status_is_closed: true, remaining_hours: 0 }),
    ]);
    const burndown = new FakeBurndownRepo();
    const remainingStatusRules = new FakeRemainingStatusRuleRepo();

    const deps = { op, sprints, sprintItems: items, workPackages, burndown, remainingStatusRules };
    const snap = await computeSnapshot(deps, 1, "2026-06-24");
    expect(snap).toEqual({
      sprint_id: 1,
      snapshot_date: "2026-06-24",
      remaining_hours: 4, // wp1001 open+estimate (4) + wp1003 done (0)
      logged_hours: 2, // only 5001 (wp1003, 2026-06-24) is <= date
      ideal_hours: 5, // day 2 of 5: 10 * (5-3)/(5-1)
      done_count: 1,
      total_count: 2,
      source: "live",
    });

    await writeSnapshotForSprint(deps, 1, "2026-06-24");
    expect(burndown.snapshots).toHaveLength(1);
    expect(burndown.snapshots[0]!.remaining_hours).toBe(4);
  });

  // Increment 5 (SPEC_05 §1/§4): a mid-sprint-removed ticket stops counting as
  // a commitment (remaining/planned/done/total) but its ALREADY-LOGGED hours
  // stay in the burnup — only the classic pre-activation "removed" drops out
  // of logged too.
  it("excludes removed_mid_sprint from committed hours/counts but KEEPS its logged hours", async () => {
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        start_date: "2026-06-22",
        end_date: "2026-06-26",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
      },
    ] as Sprint[]);
    const items = new FakeSprintItemRepo();
    items.seed([
      sprintItem({ id: 1, wp_op_id: 1001, planned_hours: 8 }),
      // Descoped mid-sprint: has time logged (entry 5001, 2h on 2026-06-24)
      // that must survive in `logged_hours` despite dropping out everywhere else.
      sprintItem({ id: 2, wp_op_id: 1003, planned_hours: 2, outcome: "removed_mid_sprint" }),
    ]);
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([
      wpCache({ op_id: 1001, status_is_closed: false, estimated_hours: 8, remaining_hours: 4 }),
      // Still open with nonzero remaining — proves it's EXCLUDED, not just
      // incidentally zero.
      wpCache({ op_id: 1003, status_is_closed: false, estimated_hours: 6, remaining_hours: 6 }),
    ]);
    const burndown = new FakeBurndownRepo();
    const remainingStatusRules = new FakeRemainingStatusRuleRepo();

    const deps = { op, sprints, sprintItems: items, workPackages, burndown, remainingStatusRules };
    const snap = await computeSnapshot(deps, 1, "2026-06-24");
    expect(snap).toEqual({
      sprint_id: 1,
      snapshot_date: "2026-06-24",
      remaining_hours: 4, // only wp1001; wp1003's 6h open-remaining is NOT counted
      logged_hours: 2, // wp1003's own logged 2h — survives despite the removal
      ideal_hours: 4, // totalPlanned=8 (wp1001 only): 8*(5-3)/(5-1)
      done_count: 0,
      total_count: 1, // wp1003 doesn't count as a live ticket anymore
      source: "live",
    });
  });

  // Burnup lower bound (user-reported on REAL production data): long-lived
  // tickets carry years of logged history from before the sprint existed —
  // without a start_date bound the burnup line STARTED at ~168h instead of 0.
  // Mock tickets are born fresh, which is why no scenario ever showed it.
  it("excludes time logged BEFORE sprint start from the burnup (long-lived tickets carry history)", async () => {
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        // Starts AFTER the shared fixture's only time entry (wp1003, 2h,
        // spentOn 2026-06-24) — the pre-existing behaviour counted those 2h.
        start_date: "2026-06-25",
        end_date: "2026-06-30",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
      },
    ] as Sprint[]);
    const items = new FakeSprintItemRepo();
    items.seed([sprintItem({ id: 1, wp_op_id: 1003, planned_hours: 2 })]);
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([
      wpCache({ op_id: 1003, status_is_closed: false, estimated_hours: 6, remaining_hours: 6 }),
    ]);
    const burndown = new FakeBurndownRepo();
    const remainingStatusRules = new FakeRemainingStatusRuleRepo();

    const deps = { op, sprints, sprintItems: items, workPackages, burndown, remainingStatusRules };
    const snap = await computeSnapshot(deps, 1, "2026-06-26");
    // The ticket's 2h from 2026-06-24 predate start_date → burnup starts at 0.
    expect(snap!.logged_hours).toBe(0);
  });

  // Increment 5 (SPEC_05 §2): once a sprint has a frozen baseline, the ideal
  // line anchors on it instead of the live (post-scope-change) total, so
  // scope creep after activation is visible against a fixed reference.
  it("anchors the ideal line on baseline_total_hours once the sprint is activated", async () => {
    const sprints = new FakeSprintRepo();
    sprints.seed([
      {
        id: 1,
        name: "S1",
        start_date: "2026-06-22",
        end_date: "2026-06-26",
        status: "active",
        capacity_mode: "per_person",
        completed_hours: null,
        created_at: "2026-06-20T00:00:00Z",
        closed_at: null,
        activated_at: "2026-06-22T09:00:00Z",
        locked_at: null,
        is_locked: false,
        lock_reason: null,
        // Frozen baseline DIFFERS from the live committed total below (8h) —
        // proves the ideal line uses this, not a live recompute.
        baseline_total_hours: 20,
        is_retrospective: false,
        retro_seed_kind: null,
        retro_seed_value: null,
        retro_replayed_at: null,
        frozen_at: null,
      } satisfies Sprint,
    ]);
    const items = new FakeSprintItemRepo();
    items.seed([sprintItem({ id: 1, wp_op_id: 1001, planned_hours: 8 })]);
    const workPackages = new FakeWorkPackageCacheRepo();
    workPackages.seed([
      wpCache({ op_id: 1001, status_is_closed: false, estimated_hours: 8, remaining_hours: 4 }),
    ]);
    const burndown = new FakeBurndownRepo();
    const remainingStatusRules = new FakeRemainingStatusRuleRepo();

    const deps = { op, sprints, sprintItems: items, workPackages, burndown, remainingStatusRules };
    const snap = await computeSnapshot(deps, 1, "2026-06-24");
    // 20 * (5-3)/(5-1) = 10 — NOT 8 * (5-3)/(5-1) = 4 (the live total).
    expect(snap?.ideal_hours).toBe(10);
  });
});

// ── Increment 29 (SPEC_29 §1–2, contracts §2–3) ──────────────────────────────

/**
 * A fake OpClient for the BULK-BY-ID path. Records the `id` filter values of
 * every getWorkPackages call (so the batching itself is asserted, not just the
 * end state) and answers each call with whichever of the requested ids exist in
 * `existing` — the rest are genuinely absent from OP, i.e. orphan candidates.
 */
function fakeIdFetchOp(opts: {
  existing: number[];
  /** Filled with the requested id values, one entry per getWorkPackages call. */
  calls: string[][];
  /** Called with the 1-based call index BEFORE the response is produced. */
  onCall?: (n: number) => void;
  /** 1-based call index that rejects with a network-ish error. */
  throwOnCall?: number;
}): OpClient {
  const existing = new Set(opts.existing);
  const emptyCollection = (): unknown => ({
    _type: "Collection",
    total: 0,
    count: 0,
    pageSize: 100,
    offset: 1,
    _embedded: { elements: [] as unknown[] },
    _links: { self: { href: "/" } },
  });
  let n = 0;
  return {
    getStatuses: async () => emptyCollection(),
    getTimeEntries: async () => emptyCollection(),
    getWorkPackages: async (query: { filters?: unknown[]; pageSize?: number }) => {
      n += 1;
      const clause = (query.filters ?? []).find(
        (f): f is { id: { values: string[] } } =>
          typeof f === "object" && f !== null && "id" in f,
      );
      const values = clause?.id.values ?? [];
      opts.calls.push(values);
      opts.onCall?.(n);
      if (opts.throwOnCall === n) throw new Error("OP exploded");
      const ids = values.map(Number).filter((id) => existing.has(id));
      return {
        _type: "WorkPackageCollection",
        total: ids.length,
        count: ids.length,
        pageSize: query.pageSize ?? 100,
        offset: 1,
        _embedded: { elements: ids.map(fakeWp) },
        _links: { self: { href: "/" } },
      };
    },
  } as unknown as OpClient;
}

function idEngineDeps(op2: OpClient): {
  op: OpClient;
  projects: FakeProjectRepo;
  workPackages: FakeWorkPackageCacheRepo;
  sprintItems: FakeSprintItemRepo;
  syncRuns: FakeSyncRunRepo;
} {
  return {
    op: op2,
    projects: new FakeProjectRepo(),
    workPackages: new FakeWorkPackageCacheRepo(),
    sprintItems: new FakeSprintItemRepo(),
    syncRuns: new FakeSyncRunRepo(),
  };
}

describe("syncByOpIds — bulk fetch by op id (Increment 29, contracts §2)", () => {
  it("batches at ID_FETCH_BATCH_SIZE: one OP call per batch, no batch larger than the constant", async () => {
    const calls: string[][] = [];
    const ids = Array.from({ length: 250 }, (_, i) => 2000 + i);
    const deps = idEngineDeps(fakeIdFetchOp({ existing: ids, calls }));
    const engine = createSyncEngine(deps);

    const result = await engine.syncByOpIds(ids);

    expect(ID_FETCH_BATCH_SIZE).toBe(100);
    expect(calls.length).toBe(3); // 100 + 100 + 50
    expect(calls.map((c) => c.length)).toEqual([100, 100, 50]);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(ID_FETCH_BATCH_SIZE);
    // Every requested id was asked for exactly once, as strings.
    expect(calls.flat().sort()).toEqual(ids.map(String).sort());

    expect(result.run?.status).toBe("success");
    expect(result.run?.kind).toBe("full"); // SyncKind is NOT extended
    expect(result.refreshedOpIds.length).toBe(250);
    expect(result.missingOpIds).toEqual([]);
    // Staged per batch, merged into the live cache exactly ONCE.
    expect(deps.workPackages.stageBatchCalls).toBe(3);
    expect(deps.workPackages.commitStagingCalls).toBe(1);
    expect(deps.workPackages.upsertManyCalls).toBe(1);
    expect(deps.workPackages.rows.size).toBe(250);
    // contracts §1.5: this pass must NEVER clear all staging.
    expect(deps.workPackages.clearAllStagingCalls).toBe(0);
    // Progress denominator is the REQUESTED count, and the bar reaches it.
    expect(result.run?.total_count).toBe(250);
  });

  it("reports ids OP did not return as missingOpIds (orphan candidates) without deleting anything", async () => {
    const calls: string[][] = [];
    const requested = [2001, 2002, 2003, 2004];
    const deps = idEngineDeps(fakeIdFetchOp({ existing: [2001, 2003], calls }));
    deps.workPackages.seed([wpCache({ op_id: 2002 }), wpCache({ op_id: 2004 })]);
    const engine = createSyncEngine(deps);

    const result = await engine.syncByOpIds(requested);

    expect(result.refreshedOpIds.sort()).toEqual([2001, 2003]);
    expect(result.missingOpIds.sort()).toEqual([2002, 2004]);
    // Reported, NEVER deleted (contracts §4.2) — the cached rows survive.
    expect(deps.workPackages.rows.has(2002)).toBe(true);
    expect(deps.workPackages.rows.has(2004)).toBe(true);
    // wp_count counts what was actually committed, not what was asked for.
    expect(result.run?.wp_count).toBe(2);
  });

  it("de-duplicates the requested ids and never creates a run for an EMPTY set", async () => {
    const calls: string[][] = [];
    const deps = idEngineDeps(fakeIdFetchOp({ existing: [2001], calls }));
    const engine = createSyncEngine(deps);

    const empty = await engine.syncByOpIds([]);
    expect(empty.run).toBeNull();
    expect(empty.refreshedOpIds).toEqual([]);
    expect(empty.missingOpIds).toEqual([]);
    expect(deps.syncRuns.runs.length).toBe(0); // no sync_run row at all
    expect(calls.length).toBe(0);

    const dup = await engine.syncByOpIds([2001, 2001, 2001]);
    expect(calls).toEqual([["2001"]]);
    expect(dup.refreshedOpIds).toEqual([2001]);
  });

  it("a cancel landing during the LAST batch still aborts: staging dropped, cache never written", async () => {
    // The Increment 19 bug, reproduced for this pass: the in-loop poll fires
    // only BEFORE a batch, so a cancel requested while the final batch is in
    // flight needs the extra pre-commit checkpoint to be caught at all.
    const calls: string[][] = [];
    const ids = Array.from({ length: 150 }, (_, i) => 2000 + i); // 2 batches
    const deps = idEngineDeps(
      fakeIdFetchOp({
        existing: ids,
        calls,
        onCall: (n) => {
          if (n === 2) void deps.syncRuns.requestCancel(deps.syncRuns.runs.at(-1)!.id);
        },
      }),
    );
    const engine = createSyncEngine(deps);

    const result = await engine.syncByOpIds(ids);

    expect(result.run?.status).toBe("aborted");
    expect(deps.workPackages.commitStagingCalls).toBe(0);
    expect(deps.workPackages.upsertManyCalls).toBe(0);
    expect(deps.workPackages.rows.size).toBe(0);
    expect(deps.workPackages.dropStagingCalls).toBeGreaterThanOrEqual(1);
    // An aborted pass committed nothing, so it may report nothing either.
    expect(result.refreshedOpIds).toEqual([]);
    expect(result.missingOpIds).toEqual([]);
  });

  it("a cancel requested BEFORE the first batch stops without a single OP request", async () => {
    const calls: string[][] = [];
    const deps = idEngineDeps(fakeIdFetchOp({ existing: [2001, 2002], calls }));
    const engine = createSyncEngine(deps);
    // Pre-mark the NEXT run id as cancelled: FakeSyncRunRepo hands out ids from
    // 1, so requesting a cancel for run 1 after it starts is what the poll sees.
    const original = deps.syncRuns.start.bind(deps.syncRuns);
    deps.syncRuns.start = async (kind) => {
      const run = await original(kind);
      await deps.syncRuns.requestCancel(run.id);
      return run;
    };

    const result = await engine.syncByOpIds([2001, 2002]);

    expect(result.run?.status).toBe("aborted");
    expect(calls.length).toBe(0);
    expect(deps.workPackages.commitStagingCalls).toBe(0);
  });

  it("a batch that THROWS finishes the run in error and reports NO orphans", async () => {
    // A failed HTTP call must never be read as "every id in that batch is gone"
    // — that would surface a transient 500 to the user as deleted tickets.
    const calls: string[][] = [];
    const ids = Array.from({ length: 150 }, (_, i) => 2000 + i);
    const deps = idEngineDeps(fakeIdFetchOp({ existing: ids, calls, throwOnCall: 2 }));
    const engine = createSyncEngine(deps);

    const result = await engine.syncByOpIds(ids);

    expect(result.run?.status).toBe("error");
    expect(result.run?.error).toContain("OP exploded");
    expect(result.missingOpIds).toEqual([]);
    expect(result.refreshedOpIds).toEqual([]);
    expect(deps.workPackages.commitStagingCalls).toBe(0);
    expect(deps.workPackages.rows.size).toBe(0);
  });

  it("hardCancelRun interrupts a hung batch, and so does the CALLER's own signal", async () => {
    // Both halves of the composed signal must work: the run registry (watchdog /
    // POST /sync/:runId/cancel) and the signal the coverage-pass caller owns.
    for (const mode of ["registry", "caller"] as const) {
      const workPackages = new FakeWorkPackageCacheRepo();
      const syncRuns = new FakeSyncRunRepo();
      const external = new AbortController();
      const op2 = fakeHardCancelOp({
        hangOnWpCall: 1,
        onWpCall: (n) => {
          if (n !== 1) return;
          const id = syncRuns.runs.at(-1)!.id;
          setTimeout(() => {
            if (mode === "registry") hardCancelRun(id);
            else external.abort();
          }, 10);
        },
      });
      const engine = createSyncEngine({
        op: op2,
        projects: new FakeProjectRepo(),
        workPackages,
        sprintItems: new FakeSprintItemRepo(),
        syncRuns,
      });

      const t0 = Date.now();
      const result = await engine.syncByOpIds([2001, 2002], external.signal);
      expect(result.run?.status, mode).toBe("aborted");
      expect(Date.now() - t0).toBeLessThan(1000); // not the 30 s request timeout
      expect(workPackages.commitStagingCalls, mode).toBe(0);
      expect(workPackages.rows.size, mode).toBe(0);
      // The controller never outlives the run (unregistered in `finally`).
      expect(hardCancelRun(result.run!.id), mode).toBe(false);
    }
  });
});

/** Records the `filters` of every getWorkPackages call, then serves one page. */
function fakeFilterCapturingOp(captured: unknown[][]): OpClient {
  const emptyCollection = (): unknown => ({
    _type: "Collection",
    total: 0,
    count: 0,
    pageSize: 100,
    offset: 1,
    _embedded: { elements: [] as unknown[] },
    _links: { self: { href: "/" } },
  });
  return {
    getStatuses: async () => emptyCollection(),
    getTimeEntries: async () => emptyCollection(),
    getWorkPackages: async (query: { filters?: unknown[] }) => {
      captured.push(query.filters ?? []);
      return {
        _type: "WorkPackageCollection",
        total: 1,
        count: 1,
        pageSize: 100,
        offset: 1,
        _embedded: { elements: [fakeWp(1001)] },
        _links: { self: { href: "/" } },
      };
    },
  } as unknown as OpClient;
}

function updatedSinceOf(filters: unknown[]): string | null {
  for (const f of filters) {
    const clause = (f as { updatedAt?: { values: string[] } }).updatedAt;
    if (clause !== undefined) return clause.values[0] ?? null;
  }
  return null;
}

describe("incremental cutoff = watermark − overlap window (Increment 29, contracts §3)", () => {
  const CACHED_MAX = "2026-06-28T12:00:00.000Z";

  function cachedProject(): FakeWorkPackageCacheRepo {
    const workPackages = new FakeWorkPackageCacheRepo();
    // Non-null maxUpdatedAtOp → the kind auto-pick chooses "incremental".
    workPackages.seed([wpCache({ op_id: 1001, project_op_id: 3, updated_at_op: CACHED_MAX })]);
    return workPackages;
  }

  it("subtracts exactly SYNC_OVERLAP_WINDOW_MINUTES from the watermark — the race case the watermark exists for", async () => {
    // The race, concretely: the previous run STARTED at 11:00 and a work package
    // it cached carries updated_at_op 12:00 (it changed while the run was in
    // flight). maxUpdatedAtOp alone would cut off at 12:00 and skip that row
    // forever; the watermark pulls the cutoff back to the run's start.
    const captured: unknown[][] = [];
    const watermarks = new FakeSyncWatermarkRepo();
    watermarks.seed(7, 3, "2026-06-28T11:00:00.000Z"); // earlier than CACHED_MAX
    const engine = createSyncEngine({
      op: fakeFilterCapturingOp(captured),
      projects: new FakeProjectRepo(),
      workPackages: cachedProject(), // maxUpdatedAtOp = 2026-06-28T12:00
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
      watermarks,
    });

    const run = await engine.sync({ projectOpId: 3, connectionId: 7 });

    expect(SYNC_OVERLAP_WINDOW_MINUTES).toBe(15);
    expect(run.kind).toBe("incremental");
    // 11:00 − 15 min — the watermark wins because it is the EARLIER instant.
    expect(updatedSinceOf(captured[0]!)).toBe("2026-06-28T10:45:00.000Z");
    expect(applyOverlapWindow("2026-06-28T11:00:00.000Z")).toBe("2026-06-28T10:45:00.000Z");
  });

  it("NEVER lets the cutoff move forward: a watermark AHEAD of maxUpdatedAtOp (clock skew) is ignored", async () => {
    // The bug this test pins. `watermark_at` is the APP server's `started_at`;
    // `maxUpdatedAtOp`/the `updatedAt >=` filter live on the OP server's clock.
    // Where the skew exceeds the 15-minute window, a watermark-only cutoff lands
    // LATER than the previous one and the sync returns FEWER rows — coverage
    // going backwards. Found live by tests/src/scenario-e2e.test.ts S4, where
    // the scenario mock's July calendar is a month behind the real clock.
    for (const skewedWatermark of [
      "2026-06-28T12:30:00.000Z", // skew just past the window
      "2026-07-28T12:00:00.000Z", // a month ahead (the S4 shape)
    ]) {
      const captured: unknown[][] = [];
      const watermarks = new FakeSyncWatermarkRepo();
      watermarks.seed(7, 3, skewedWatermark);
      const engine = createSyncEngine({
        op: fakeFilterCapturingOp(captured),
        projects: new FakeProjectRepo(),
        workPackages: cachedProject(),
        sprintItems: new FakeSprintItemRepo(),
        syncRuns: new FakeSyncRunRepo(),
        watermarks,
      });

      await engine.sync({ projectOpId: 3, connectionId: 7 });

      const cutoff = updatedSinceOf(captured[0]!);
      // The standing invariant: the resolved cutoff is NEVER later than
      // maxUpdatedAtOp − window, whatever the watermark says.
      expect(cutoff, skewedWatermark).toBe("2026-06-28T11:45:00.000Z");
      expect(cutoff! <= applyOverlapWindow(CACHED_MAX), skewedWatermark).toBe(true);
    }
  });

  it("resolveIncrementalCutoffSource takes the EARLIER instant and tolerates nulls/garbage", () => {
    const early = "2026-06-28T11:00:00.000Z";
    const late = "2026-06-28T12:00:00.000Z";
    // Whichever argument holds it, the earlier instant wins.
    expect(resolveIncrementalCutoffSource(early, late)).toBe(early);
    expect(resolveIncrementalCutoffSource(late, early)).toBe(early);
    expect(resolveIncrementalCutoffSource(early, early)).toBe(early);
    // One side missing → the other, unchanged (rules 1/2 of contracts §3).
    expect(resolveIncrementalCutoffSource(null, late)).toBe(late);
    expect(resolveIncrementalCutoffSource(late, null)).toBe(late);
    expect(resolveIncrementalCutoffSource(null, null)).toBeNull();
    // Unparseable = "no opinion", never a NaN comparison that silently picks
    // the wrong side.
    expect(resolveIncrementalCutoffSource("not-a-date", late)).toBe(late);
    expect(resolveIncrementalCutoffSource(late, "not-a-date")).toBe(late);
  });

  it("a watermark for ANOTHER connection is never used as this connection's cutoff", async () => {
    const captured: unknown[][] = [];
    const watermarks = new FakeSyncWatermarkRepo();
    watermarks.seed(99, 3, "2026-06-29T10:00:00.000Z"); // a different connection
    const engine = createSyncEngine({
      op: fakeFilterCapturingOp(captured),
      projects: new FakeProjectRepo(),
      workPackages: cachedProject(),
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
      watermarks,
    });

    await engine.sync({ projectOpId: 3, connectionId: 7 });

    // Falls back to rule 2 (cached max − window), never connection 99's value.
    expect(updatedSinceOf(captured[0]!)).toBe("2026-06-28T11:45:00.000Z");
  });

  it("with no watermark row (or no watermarks dep at all) falls back to maxUpdatedAtOp − window", async () => {
    for (const withRepo of [true, false]) {
      const captured: unknown[][] = [];
      const engine = createSyncEngine({
        op: fakeFilterCapturingOp(captured),
        projects: new FakeProjectRepo(),
        workPackages: cachedProject(),
        sprintItems: new FakeSprintItemRepo(),
        syncRuns: new FakeSyncRunRepo(),
        ...(withRepo ? { watermarks: new FakeSyncWatermarkRepo() } : {}),
      });

      const run = await engine.sync({ projectOpId: 3 });

      expect(run.status, String(withRepo)).toBe("success");
      expect(updatedSinceOf(captured[0]!), String(withRepo)).toBe("2026-06-28T11:45:00.000Z");
    }
  });

  it("an empty project cache still forces a FULL run (rule 3, unchanged) even with a watermark", async () => {
    const captured: unknown[][] = [];
    const watermarks = new FakeSyncWatermarkRepo();
    watermarks.seed(null, 3, "2026-06-29T10:00:00.000Z");
    const engine = createSyncEngine({
      op: fakeFilterCapturingOp(captured),
      projects: new FakeProjectRepo(),
      workPackages: new FakeWorkPackageCacheRepo(), // nothing cached
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
      watermarks,
    });

    const run = await engine.sync({ projectOpId: 3 });

    expect(run.kind).toBe("full");
    expect(updatedSinceOf(captured[0]!)).toBeNull();
  });
});

describe("watermark writes (Increment 29, contracts §3)", () => {
  it("writes the run's started_at — never finished_at/now — and only after success", async () => {
    const watermarks = new FakeSyncWatermarkRepo();
    const syncRuns = new FakeSyncRunRepo();
    // A run that takes measurable time, so started_at and finished_at are
    // DIFFERENT instants — otherwise "it stored started_at" would pass even for
    // an implementation that stored finished_at, which is the whole point.
    const slowOp = fakeFilterCapturingOp([]);
    const engine = createSyncEngine({
      op: {
        ...slowOp,
        getStatuses: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return slowOp.getStatuses();
        },
      } as unknown as OpClient,
      projects: new FakeProjectRepo(),
      workPackages: new FakeWorkPackageCacheRepo(),
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
      watermarks,
    });

    const run = await engine.sync({ projectOpId: 3, connectionId: 7 });

    expect(run.status).toBe("success");
    expect(watermarks.sets).toEqual([
      { connectionId: 7, projectOpId: 3, watermarkAt: run.started_at },
    ]);
    expect(await watermarks.get(7, 3)).toBe(run.started_at);
    // The distinction that matters: a watermark at finished_at/"now" would skip
    // everything edited in OP while the run was in flight.
    expect(run.finished_at! > run.started_at).toBe(true); // the two really differ
    expect(watermarks.sets[0]!.watermarkAt).not.toBe(run.finished_at);
    // Keyed per connection — another connection's cutoff is untouched.
    expect(await watermarks.get(8, 3)).toBeNull();
  });

  it("an ABORTED run leaves the watermark untouched", async () => {
    const watermarks = new FakeSyncWatermarkRepo();
    watermarks.seed(7, 3, "2026-06-01T00:00:00.000Z");
    const syncRuns = new FakeSyncRunRepo();
    const workPackages = new FakeWorkPackageCacheRepo();
    const op2 = fakePagingOp({
      total: 150,
      onPage: (offset) => {
        if (offset === 1) void syncRuns.requestCancel(syncRuns.runs.at(-1)!.id);
      },
    });
    const engine = createSyncEngine({
      op: op2,
      projects: new FakeProjectRepo(),
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns,
      watermarks,
    });

    const run = await engine.sync({ projectOpId: 3, connectionId: 7, kind: "full" });

    expect(run.status).toBe("aborted");
    expect(watermarks.sets).toEqual([]); // not merely unchanged — never written
    expect(await watermarks.get(7, 3)).toBe("2026-06-01T00:00:00.000Z");
  });

  it("an ERRORED run leaves the watermark untouched", async () => {
    const watermarks = new FakeSyncWatermarkRepo();
    watermarks.seed(7, 3, "2026-06-01T00:00:00.000Z");
    const badOp = createOpClient({ baseUrl: "http://127.0.0.1:1", token: "t", maxRetries: 0 });
    const engine = createSyncEngine({
      op: badOp,
      projects: new FakeProjectRepo(),
      workPackages: new FakeWorkPackageCacheRepo(),
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
      watermarks,
    });

    const run = await engine.sync({ projectOpId: 3, connectionId: 7 });

    expect(run.status).toBe("error");
    expect(watermarks.sets).toEqual([]);
    expect(await watermarks.get(7, 3)).toBe("2026-06-01T00:00:00.000Z");
  });
});
