import { describe, expect, it } from "vitest";
import type {
  BacklogFilterOptionsResponse,
  BacklogResponse,
  SyncRefreshAllResponse,
} from "@osp/contracts";
import { addConnection, buildTestApp, initVault, type TestApp } from "../test-utils";

/**
 * Increment 23 (SPEC_23) — Agent B's two primary bugs, at the route level.
 *
 * Bug #1: "Sync now" (refresh-all) must ISOLATE a disconnected connection —
 * skip + report it, never let its CONNECTION_DISABLED throw abort the whole
 * batch so a healthy connection stops syncing too.
 *
 * Bug #2: the assignee/version filter must key on (connection, op_id), not a
 * bare op_id that collides across servers (Alan Turing@mock and Cameron
 * Dalby@Acme are both OP user id 3) — otherwise the dropdown merges them and
 * selecting one leaks the OTHER server's tickets.
 */

function wpRow(over: {
  op_id: number;
  connection_id: number;
  assignee_op_id?: number | null;
  assignee_name?: string | null;
  version_op_id?: number | null;
  version_name?: string | null;
}) {
  return {
    connection_id: over.connection_id,
    op_id: over.op_id,
    project_op_id: 100,
    project_name: null,
    subject: `WP ${over.op_id}`,
    type_name: "Task",
    status_name: "New",
    status_is_closed: false,
    assignee_op_id: over.assignee_op_id ?? null,
    assignee_name: over.assignee_name ?? null,
    estimated_hours: 4,
    remaining_hours: 4,
    spent_hours: null,
    story_points: null,
    version_op_id: over.version_op_id ?? null,
    version_name: over.version_name ?? null,
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-07-01T00:00:00Z",
    raw_json: "{}",
  };
}

describe("Increment 23 §1 — refresh-all isolates a disconnected connection", () => {
  it("skips the disabled connection, syncs the healthy one, never 409s the batch", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const healthy = (await addConnection(t, {
      base_url: "https://healthy.example.com",
      label: "Acme",
    })) as { id: number };
    const dead = (await addConnection(t, {
      base_url: "https://dead.example.com",
      label: "mock",
    })) as { id: number };

    // Both have a recorded import selection (so both form a connection group).
    await t.repos.importSelections.upsert({
      connection_id: healthy.id,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: null,
      version_name: null,
    });
    await t.repos.importSelections.upsert({
      connection_id: dead.id,
      project_op_id: 200,
      project_name: "Project B",
      version_op_id: null,
      version_name: null,
    });

    // Disconnect the "mock" connection — the exact confirmed-409 scenario.
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${dead.id}`,
      payload: { enabled: false },
    });

    const res = await t.app.inject({ method: "POST", url: "/api/sync", payload: {} });
    expect(res.statusCode, res.payload).toBe(200);
    const body = res.json<SyncRefreshAllResponse>();

    // A per-connection breakdown, NOT a bare SyncRun and NOT a 409.
    expect(Array.isArray(body.connections)).toBe(true);
    const byId = new Map(body.connections.map((c) => [c.connection_id, c]));
    expect(byId.get(healthy.id)?.status).toBe("synced");
    expect(byId.get(dead.id)?.status).toBe("skipped");
    expect(byId.get(dead.id)?.message).toBe("disconnected");
    expect(byId.get(dead.id)?.connection_label).toBe("mock");
    // `last` is the healthy connection's successful run.
    expect(body.last?.status).toBe("success");
    await t.close();
  });

  it("reconnecting the connection makes it sync again (nothing was destroyed)", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const dead = (await addConnection(t, { base_url: "https://x.example.com" })) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: dead.id,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: null,
      version_name: null,
    });
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${dead.id}`,
      payload: { enabled: false },
    });
    const skipped = (
      await t.app.inject({ method: "POST", url: "/api/sync", payload: {} })
    ).json<SyncRefreshAllResponse>();
    expect(skipped.connections[0]?.status).toBe("skipped");

    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${dead.id}`,
      payload: { enabled: true },
    });
    const synced = (
      await t.app.inject({ method: "POST", url: "/api/sync", payload: {} })
    ).json<SyncRefreshAllResponse>();
    expect(synced.connections[0]?.status).toBe("synced");
    await t.close();
  });

  it("a connection whose sub-sync FINISHES as error is reported error, still isolated", async () => {
    // The engine catches a fetch/HTTP failure and finishes the run as status
    // "error" WITHOUT throwing — that connection must surface an "error"
    // outcome (not a misleading "synced"), while a healthy connection still
    // syncs (SPEC_23 §1.4). The factory runs at request time, by which point
    // `repos` is captured.
    let repos: TestApp["repos"] | null = null;
    const t = await buildTestApp({
      syncEngineFactory: () => ({
        async sync(options) {
          const r = repos!;
          const run = await r.syncRuns.start(options.kind ?? "full");
          // project 200 → the "broken" connection's project.
          const status = options.projectOpId === 200 ? "error" : "success";
          return r.syncRuns.finish(
            run.id,
            status,
            0,
            status === "error" ? "boom" : null,
            new Date().toISOString(),
          );
        },
        // Increment 29: this stub has no cached rows to cover, so the route's
        // coverage pass never calls it (it skips an empty `stale` set).
        syncByOpIds: () =>
          Promise.resolve({ run: null, refreshedOpIds: [], missingOpIds: [] }),
        importWorkPackage: () => Promise.resolve(null),
        fetchWorkPackageRow: () => Promise.resolve(null),
      }),
    });
    repos = t.repos;
    await initVault(t);
    const good = (await addConnection(t, { base_url: "https://good.example.com" })) as { id: number };
    const broken = (await addConnection(t, { base_url: "https://broken.example.com" })) as {
      id: number;
    };
    await t.repos.importSelections.upsert({
      connection_id: good.id,
      project_op_id: 100,
      project_name: "P100",
      version_op_id: null,
      version_name: null,
    });
    await t.repos.importSelections.upsert({
      connection_id: broken.id,
      project_op_id: 200,
      project_name: "P200",
      version_op_id: null,
      version_name: null,
    });
    const body = (
      await t.app.inject({ method: "POST", url: "/api/sync", payload: {} })
    ).json<SyncRefreshAllResponse>();
    const byId = new Map(body.connections.map((c) => [c.connection_id, c]));
    expect(byId.get(good.id)?.status).toBe("synced");
    expect(byId.get(broken.id)?.status).toBe("error");
    expect(byId.get(broken.id)?.message).toBe("boom");
    await t.close();
  });

  it("single-project sync targeting a disabled connection STILL 409s (SPEC_23 §7 decision 2)", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${conn.id}`,
      payload: { enabled: false },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { project_op_id: 100, connection_id: conn.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONNECTION_DISABLED");
    await t.close();
  });
});

describe("Increment 23 §2 — assignee/version identity is connection-scoped", () => {
  it("distinct entries for a numeric id that collides across two connections", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const mock = (await addConnection(t, {
      base_url: "https://mock.example.com",
      label: "mock",
    })) as { id: number };
    const acme = (await addConnection(t, {
      base_url: "https://acme.example.com",
      label: "Acme",
    })) as { id: number };

    // The confirmed collision: OP user id 3 is Alan Turing on the mock and
    // Cameron Dalby on Acme — same id, different person/server.
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, connection_id: mock.id, assignee_op_id: 3, assignee_name: "Alan Turing" }),
      wpRow({
        op_id: 2,
        connection_id: acme.id,
        assignee_op_id: 3,
        assignee_name: "Cameron Dalby",
      }),
    ]);

    const opts = (
      await t.app.inject({ method: "GET", url: "/api/backlog/filter-options" })
    ).json<BacklogFilterOptionsResponse>();

    // BOTH people appear — Cameron is no longer silently merged away.
    const names = opts.assignees.map((a) => a.name).sort();
    expect(names).toEqual(["Alan Turing", "Cameron Dalby"]);
    // Keyed by (connection_id, op_id), not bare id.
    const byName = new Map(opts.assignees.map((a) => [a.name, a]));
    expect(byName.get("Alan Turing")?.key).toBe(`${mock.id}:3`);
    expect(byName.get("Alan Turing")?.connection_id).toBe(mock.id);
    expect(byName.get("Cameron Dalby")?.key).toBe(`${acme.id}:3`);
    expect(byName.get("Cameron Dalby")?.connection_id).toBe(acme.id);
    // Both still carry the colliding numeric id for legacy display.
    expect(byName.get("Alan Turing")?.id).toBe(3);
    expect(byName.get("Cameron Dalby")?.id).toBe(3);

    // Selecting Alan Turing (mock) returns ONLY the mock ticket — no leak of
    // Cameron's Acme ticket, even though both are OP user id 3.
    const alan = (
      await t.app.inject({
        method: "GET",
        url: `/api/backlog?assigneeKey=${encodeURIComponent(`${mock.id}:3`)}`,
      })
    ).json<BacklogResponse>();
    expect(alan.map((w) => w.op_id)).toEqual([1]);

    const chris = (
      await t.app.inject({
        method: "GET",
        url: `/api/backlog?assigneeKey=${encodeURIComponent(`${acme.id}:3`)}`,
      })
    ).json<BacklogResponse>();
    expect(chris.map((w) => w.op_id)).toEqual([2]);

    // Legacy bare-id ?assignee=3 still matches BOTH (backward compatibility).
    const legacy = (
      await t.app.inject({ method: "GET", url: "/api/backlog?assignee=3" })
    ).json<BacklogResponse>();
    expect(legacy.map((w) => w.op_id).sort()).toEqual([1, 2]);
    await t.close();
  });

  it("versionKey scopes a colliding version id to its own connection", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const a = (await addConnection(t, { base_url: "https://a.example.com" })) as { id: number };
    const b = (await addConnection(t, { base_url: "https://b.example.com" })) as { id: number };
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 10, connection_id: a.id, version_op_id: 5, version_name: "v-A" }),
      wpRow({ op_id: 20, connection_id: b.id, version_op_id: 5, version_name: "v-B" }),
    ]);
    const opts = (
      await t.app.inject({ method: "GET", url: "/api/backlog/filter-options" })
    ).json<BacklogFilterOptionsResponse>();
    expect(opts.versions.map((v) => v.name).sort()).toEqual(["v-A", "v-B"]);

    const onlyA = (
      await t.app.inject({
        method: "GET",
        url: `/api/backlog?versionKey=${encodeURIComponent(`${a.id}:5`)}`,
      })
    ).json<BacklogResponse>();
    expect(onlyA.map((w) => w.op_id)).toEqual([10]);
    await t.close();
  });
});
