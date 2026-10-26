import { describe, expect, it, vi } from "vitest";
import type { Project } from "@osp/contracts";
import type { OpClient, OpProject, OpRequestOptions } from "@osp/op-client";
import { OpHttpError } from "@osp/op-client";
import { createSyncEngine, refreshProjects, toWorkPackageCacheRow } from "./index";
import {
  FakeProjectRepo,
  FakeSprintItemRepo,
  FakeSyncRunRepo,
  FakeWorkPackageCacheRepo,
} from "./fakes";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.A3/A4) — project_name from
 * the WP payload, and the best-effort `refreshProjects`. Fictional projects
 * only (northwind, harbor-ops).
 */

const PROJECTS: Record<number, OpProject> = {
  11: { _type: "Project", id: 11, identifier: "northwind", name: "Northwind Payments" },
  12: { _type: "Project", id: 12, identifier: "harbor-ops", name: "Harbor Ops" },
};

/** A fake OpClient whose every typed method routes through `this.request`,
 * like the real impl — so the hard-cancel wrapper genuinely composes and
 * every OP call is visible (method + path) to the test. */
function fakeOp(opts: {
  wps?: unknown[];
  /** Per-project override: throw this instead of answering. */
  fail?: Record<number, unknown>;
  hang?: Set<number>;
}): { op: OpClient; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  const collection = (elements: unknown[]) => ({
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: 100,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: "/" } },
  });
  const op = {
    request(o: OpRequestOptions): Promise<unknown> {
      calls.push({ method: o.method ?? "GET", path: o.path });
      const m = /^\/api\/v3\/projects\/(\d+)$/.exec(o.path);
      if (m) {
        const id = Number(m[1]);
        if (opts.hang?.has(id)) {
          return new Promise((_res, rej) =>
            o.signal?.addEventListener("abort", () => rej(o.signal?.reason), { once: true }),
          );
        }
        if (opts.fail?.[id] !== undefined) return Promise.reject(opts.fail[id]);
        const p = PROJECTS[id];
        if (!p) return Promise.reject(new OpHttpError(404, o.path, "{}"));
        return Promise.resolve(p);
      }
      if (o.path === "/api/v3/work_packages") return Promise.resolve(collection(opts.wps ?? []));
      return Promise.resolve(collection([]));
    },
    getProject(this: OpClient, id: number) {
      return this.request({ path: `/api/v3/projects/${id}` });
    },
    getStatuses(this: OpClient) {
      return this.request({ path: "/api/v3/statuses" });
    },
    getTimeEntries(this: OpClient) {
      return this.request({ path: "/api/v3/time_entries" });
    },
    getWorkPackages(this: OpClient) {
      return this.request({ path: "/api/v3/work_packages" });
    },
  } as unknown as OpClient;
  return { op, calls };
}

function opWp(id: number, projectId: number | null, title: string | null): unknown {
  return {
    _type: "WorkPackage",
    id,
    subject: `wp-${id}`,
    updatedAt: "2026-06-20T00:00:00Z",
    _links:
      projectId === null
        ? {}
        : { project: { href: `/api/v3/projects/${projectId}`, title } },
  };
}

describe("toWorkPackageCacheRow — project_name (Increment 40 §1.1)", () => {
  it("reads _links.project.title; null when the link or title is absent", () => {
    const row = toWorkPackageCacheRow(opWp(1, 11, "Northwind Payments") as never, new Map(), null, 5);
    expect(row.project_op_id).toBe(11);
    expect(row.project_name).toBe("Northwind Payments");
    expect(toWorkPackageCacheRow(opWp(2, null, null) as never, new Map(), null, 5).project_name).toBeNull();
    expect(toWorkPackageCacheRow(opWp(3, 12, null) as never, new Map(), null, 5).project_name).toBeNull();
  });
});

describe("refreshProjects (Increment 40 §2.A3)", () => {
  it("null connection → no-op: zero OP calls, zero writes", async () => {
    const { op, calls } = fakeOp({});
    const projects = new FakeProjectRepo();
    const r = await refreshProjects(op, { projects }, null, [11, 12]);
    expect(r).toEqual({ refreshed: [], skipped: [], cancelled: false });
    expect(calls).toEqual([]);
    expect(projects.upserts).toEqual([]);
  });

  it("one GET per DISTINCT real id; upserts keyed (connection, op_id); GET only", async () => {
    const { op, calls } = fakeOp({});
    const projects = new FakeProjectRepo();
    const r = await refreshProjects(op, { projects }, 7, [11, 12, 11, 0, 12]);
    expect(r.refreshed).toEqual([11, 12]);
    expect(calls).toEqual([
      { method: "GET", path: "/api/v3/projects/11" },
      { method: "GET", path: "/api/v3/projects/12" },
    ]);
    expect(projects.upserts).toEqual([
      { connection_id: 7, op_id: 11, identifier: "northwind", name: "Northwind Payments", last_synced_at: null },
      { connection_id: 7, op_id: 12, identifier: "harbor-ops", name: "Harbor Ops", last_synced_at: null },
    ]);
  });

  it("a 404 (hidden project) / 403 is logged and skipped; the others still refresh; never throws", async () => {
    const { op } = fakeOp({ fail: { 12: new OpHttpError(403, "/api/v3/projects/12", "{}") } });
    const projects = new FakeProjectRepo();
    const onSkip = vi.fn();
    const r = await refreshProjects(op, { projects }, 7, [404404, 12, 11], { onSkip });
    expect(r.refreshed).toEqual([11]);
    expect(r.skipped).toEqual([404404, 12]);
    expect(r.cancelled).toBe(false);
    expect(onSkip).toHaveBeenCalledTimes(2);
    expect((onSkip.mock.calls[0]![1] as OpHttpError).status).toBe(404);
    expect(projects.upserts.map((p) => p.op_id)).toEqual([11]);
  });

  it("a per-project timeout skips that project only", async () => {
    const { op } = fakeOp({ hang: new Set([12]) });
    const projects = new FakeProjectRepo();
    const r = await refreshProjects(op, { projects }, 7, [12, 11], {
      timeoutMs: 20,
      onSkip: () => {},
    });
    expect(r.skipped).toEqual([12]);
    expect(r.refreshed).toEqual([11]);
  });

  it("a DB failure and a throwing onSkip are both swallowed (best-effort)", async () => {
    const { op } = fakeOp({});
    const projects = new FakeProjectRepo();
    projects.upsertMany = async () => {
      throw new Error("db down");
    };
    const r = await refreshProjects(op, { projects }, 7, [11], {
      onSkip: () => {
        throw new Error("logger broke");
      },
    });
    expect(r).toEqual({ refreshed: [], skipped: [11], cancelled: false });
  });

  it("preserves an existing row's last_synced_at and updates identifier/name (rename)", async () => {
    const { op } = fakeOp({});
    const projects = new FakeProjectRepo();
    projects.seed([
      { id: 1, connection_id: 7, op_id: 11, identifier: "nw-old", name: "Old Name", last_synced_at: "2026-08-01T10:00:00.000Z" },
      // Same op_id on ANOTHER server — must stay untouched.
      { id: 2, connection_id: 8, op_id: 11, identifier: "lighthouse", name: "Lighthouse", last_synced_at: null },
    ] as Project[]);
    await refreshProjects(op, { projects }, 7, [11]);
    const all = await projects.list();
    expect(all.find((p) => p.connection_id === 7)).toMatchObject({
      identifier: "northwind",
      name: "Northwind Payments",
      last_synced_at: "2026-08-01T10:00:00.000Z",
    });
    expect(all.find((p) => p.connection_id === 8)).toMatchObject({
      identifier: "lighthouse",
      name: "Lighthouse",
    });
  });

  it("respects cancellation: an aborted signal stops before the next GET, without throwing", async () => {
    const { op, calls } = fakeOp({ hang: new Set([11]) });
    const projects = new FakeProjectRepo();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await refreshProjects(op, { projects }, 7, [11, 12], { signal: ac.signal });
    expect(r.cancelled).toBe(true);
    expect(r.refreshed).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual(["/api/v3/projects/11"]);
    expect(projects.upserts).toEqual([]);

    const pre = new AbortController();
    pre.abort();
    const { op: op2, calls: calls2 } = fakeOp({});
    const r2 = await refreshProjects(op2, { projects }, 7, [11], { signal: pre.signal });
    expect(r2.cancelled).toBe(true);
    expect(calls2).toEqual([]);
  });
});

describe("sync engine wiring (Increment 40 §2.A3)", () => {
  function engineFor(op: OpClient) {
    const projects = new FakeProjectRepo();
    const workPackages = new FakeWorkPackageCacheRepo();
    const engine = createSyncEngine({
      op,
      projects,
      workPackages,
      sprintItems: new FakeSprintItemRepo(),
      syncRuns: new FakeSyncRunRepo(),
    });
    return { engine, projects, workPackages };
  }

  it("sync() with a connection: commits project_name and refreshes every touched project; stamps last_synced_at connection-scoped", async () => {
    const { op, calls } = fakeOp({
      wps: [opWp(1, 11, "Northwind Payments"), opWp(2, 12, "Harbor Ops")],
    });
    const { engine, projects, workPackages } = engineFor(op);
    const run = await engine.sync({ projectOpId: 11, connectionId: 7 });
    expect(run.status).toBe("success");
    expect(workPackages.rows.get(1)?.project_name).toBe("Northwind Payments");
    expect(workPackages.rows.get(2)?.project_name).toBe("Harbor Ops");
    expect(projects.upserts.map((p) => `${p.connection_id}:${p.op_id}:${p.identifier}`)).toEqual([
      "7:11:northwind",
      "7:12:harbor-ops",
    ]);
    expect(projects.lastSynced.has("7:11")).toBe(true);
    expect(projects.lastSynced.has("none:11")).toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("sync() without a connection: no project GETs at all", async () => {
    const { op, calls } = fakeOp({ wps: [opWp(1, 11, "Northwind Payments")] });
    const { engine, projects } = engineFor(op);
    await engine.sync({ projectOpId: 11 });
    expect(calls.some((c) => c.path.startsWith("/api/v3/projects/"))).toBe(false);
    expect(projects.upserts).toEqual([]);
  });

  it("sync() still succeeds when the project is hidden (404) — best-effort", async () => {
    const { op } = fakeOp({ wps: [opWp(1, 31, "Hidden Project")] });
    const { engine, workPackages } = engineFor(op);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await engine.sync({ projectOpId: 31, connectionId: 7 });
    warn.mockRestore();
    expect(run.status).toBe("success");
    // The name still comes from the WP payload.
    expect(workPackages.rows.get(1)?.project_name).toBe("Hidden Project");
  });

  it("importWorkPackage(opId, connectionId) stamps the connection and refreshes the project", async () => {
    const { op } = fakeOp({ wps: [opWp(5, 12, "Harbor Ops")] });
    const { engine, projects } = engineFor(op);
    const wp = await engine.importWorkPackage(5, 7);
    expect(wp?.connection_id).toBe(7);
    expect(wp?.project_name).toBe("Harbor Ops");
    expect(projects.upserts.map((p) => `${p.connection_id}:${p.op_id}`)).toEqual(["7:12"]);
  });

  it("importWorkPackage(opId) without a connection keeps the old behaviour (no project GET)", async () => {
    const { op, calls } = fakeOp({ wps: [opWp(5, 12, "Harbor Ops")] });
    const { engine, projects } = engineFor(op);
    const wp = await engine.importWorkPackage(5);
    expect(wp?.connection_id ?? null).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v3/projects/"))).toBe(false);
    expect(projects.upserts).toEqual([]);
  });
});
