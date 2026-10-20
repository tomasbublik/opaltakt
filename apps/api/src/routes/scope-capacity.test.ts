import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapacityResponse,
  ErrorResponse,
  SprintResponse,
  TicketChangelogResponse,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type {
  HalLink,
  OpClient,
  OpClientConfig,
  OpStatus,
  OpWorkPackage,
} from "@osp/op-client";
import { createSnapshotWriter } from "@osp/sync";
import {
  activateSprint,
  addConnection,
  buildTestApp,
  type FakeOpData,
  initVault,
  makeFakeOpClient,
  type TestApp,
} from "../test-utils";

// ── OP fixtures ──────────────────────────────────────────────────────────────
const STATUSES: OpStatus[] = [
  { _type: "Status", id: 7, name: "In progress", isClosed: false },
  { _type: "Status", id: 12, name: "Closed", isClosed: true },
];

function statusLink(id: number): HalLink {
  const s = STATUSES.find((x) => x.id === id)!;
  return { href: `/api/v3/statuses/${id}`, title: s.name };
}
function userLink(id: number, title: string): HalLink {
  return { href: `/api/v3/users/${id}`, title };
}

function opWp(
  id: number,
  o: {
    assignee?: { id: number; name: string };
    estimatedTime?: string;
    statusId?: number;
    spentTime?: string;
  } = {},
): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    estimatedTime: o.estimatedTime ?? null,
    remainingTime: o.estimatedTime ?? null,
    spentTime: o.spentTime ?? null,
    updatedAt: "2026-06-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: statusLink(o.statusId ?? 7),
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
      ...(o.assignee ? { assignee: userLink(o.assignee.id, o.assignee.name) } : {}),
    },
  };
}

/** Seed the local cache for a baseline (planning) ticket with a real estimate. */
async function seedCache(
  repos: Repositories,
  id: number,
  o: {
    assignee?: { id: number; name: string };
    estimated: number | null;
    statusId?: number;
    spent?: number;
  },
): Promise<void> {
  const status = STATUSES.find((s) => s.id === (o.statusId ?? 7))!;
  await repos.workPackages.upsertMany([
    {
      op_id: id,
      project_op_id: 100,
      subject: `WP ${id}`,
      type_name: "Task",
      status_name: status.name,
      status_is_closed: status.isClosed,
      assignee_op_id: o.assignee?.id ?? null,
      assignee_name: o.assignee?.name ?? null,
      estimated_hours: o.estimated,
      remaining_hours: o.estimated,
      spent_hours: o.spent ?? null,
      story_points: null,
      version_op_id: null,
      version_name: null,
      priority: null,
      parent_op_id: null,
      percentage_done: null,
      updated_at_op: "2026-06-01T00:00:00Z",
      raw_json: "{}",
    },
  ]);
}

async function createSprint(t: TestApp, name = "Sprint 3.5.039"): Promise<number> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/sprints",
    payload: { name, start_date: "2026-06-01", end_date: "2026-06-14" },
  });
  return SprintResponse.parse(res.json()).id;
}

async function addItem(t: TestApp, sprintId: number, wpId: number): Promise<number> {
  const r = await t.app.inject({
    method: "POST",
    url: `/api/sprints/${sprintId}/items`,
    payload: { wp_op_id: wpId },
  });
  if (r.statusCode !== 201) throw new Error(`addItem failed: ${r.statusCode} ${r.payload}`);
  return r.statusCode;
}

async function setCapacity(
  t: TestApp,
  sprintId: number,
  members: { op_user_id: number; available_hours: number; name: string }[],
): Promise<void> {
  const r = await t.app.inject({
    method: "PUT",
    url: `/api/sprints/${sprintId}/capacity`,
    payload: { members: members.map((m) => ({ ...m, pto_days: 0 })) },
  });
  if (r.statusCode !== 200) throw new Error(`setCapacity failed: ${r.statusCode} ${r.payload}`);
}

describe("SPEC_05 live scope + capacity segments (mid-sprint add/remove)", () => {
  let t: TestApp;
  let opData: FakeOpData;
  let repos!: Repositories;
  // Counts EVERY method call on any OP client the routes build (read-only guard).
  const opCalls = { count: 0 };
  const nowRef = { value: "2026-06-02T08:00:00.000Z" };

  function spyFactory(): (config: OpClientConfig) => OpClient {
    return () => {
      const real = makeFakeOpClient(opData);
      return new Proxy(real, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (typeof v === "function") {
            return (...args: unknown[]) => {
              opCalls.count += 1;
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v;
        },
      });
    };
  }

  beforeEach(async () => {
    opData = { statuses: STATUSES, workPackages: [], activitiesByWpId: {}, timeEntries: [] };
    opCalls.count = 0;
    nowRef.value = "2026-06-02T08:00:00.000Z";
    t = await buildTestApp({
      opData,
      now: () => new Date(nowRef.value),
      opClientFactory: spyFactory(),
      snapshotWriterFactory: (op) =>
        createSnapshotWriter({
          op,
          sprints: repos.sprints,
          sprintItems: repos.sprintItems,
          workPackages: repos.workPackages,
          burndown: repos.burndown,
          remainingStatusRules: repos.remainingStatusRules,
        }),
    });
    repos = t.repos;
    await initVault(t);
    await addConnection(t);
  });
  afterEach(async () => {
    await t.close();
  });

  // SPEC_09 §1: activation is async now — kick it off and poll /updates until
  // the background run settles (shared helper), so the assertions that follow
  // (baselines, capacity segments) see the completed post-activation state.
  async function activate(sprintId: number): Promise<void> {
    await activateSprint(t, sprintId);
  }

  it("activation freezes baseline_total_hours as the leaf-effort sum", async () => {
    opData.workPackages = [
      opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H" }),
      opWp(2, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT6H" }),
      opWp(3, { assignee: { id: 11, name: "Bob" }, estimatedTime: "PT4H" }),
    ];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    await seedCache(repos, 2, { assignee: { id: 10, name: "Ann" }, estimated: 6 });
    await seedCache(repos, 3, { assignee: { id: 11, name: "Bob" }, estimated: 4 });
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1);
    await addItem(t, sprintId, 2);
    await addItem(t, sprintId, 3);
    await activate(sprintId);

    const sprint = await repos.sprints.getById(sprintId);
    expect(sprint!.baseline_total_hours).toBe(20);
    // Every activation baseline row carries origin="baseline".
    const baselines = await repos.ticketBaselines.listBySprint(sprintId);
    expect(baselines.map((b) => b.origin)).toEqual(["baseline", "baseline", "baseline"]);
  });

  it("mid-sprint add: reads WP from OP (not cache), upserts cache + baseline(origin=added_mid_sprint) + scope_added changelog", async () => {
    opData.workPackages = [opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H" })];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1);
    await activate(sprintId);

    // New ticket that was NEVER in the local cache — only present in OP.
    opData.workPackages.push(opWp(4, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT5H" }));
    expect(await repos.workPackages.getByOpId(4)).toBeNull();

    nowRef.value = "2026-06-03T09:00:00.000Z";
    const add = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items`,
      payload: { wp_op_id: 4 },
    });
    expect(add.statusCode).toBe(201);

    // Cache was upserted from OP.
    const cached = await repos.workPackages.getByOpId(4);
    expect(cached).not.toBeNull();
    expect(cached!.estimated_hours).toBe(5);
    // Increment 22 (SPEC_22 §3.2): a brand-new mid-sprint add is stamped with
    // the connection it was fetched from AT WRITE TIME — never left an
    // un-attributed ("SERVER —") null row that no refresh-all group could claim.
    const currentConn = await repos.connections.getCurrent();
    expect(cached!.connection_id).toBe(currentConn!.id);

    // sprint_item carries origin=added_mid_sprint.
    const item = await repos.sprintItems.getBySprintAndWp(sprintId, 4);
    expect(item!.origin).toBe("added_mid_sprint");
    expect(item!.outcome).toBe("planned");

    // ticket_baseline row exists with origin=added_mid_sprint, captured_at=now.
    const baseline = await repos.ticketBaselines.getBySprintAndWp(sprintId, 4);
    expect(baseline!.origin).toBe("added_mid_sprint");
    expect(baseline!.captured_at).toBe("2026-06-03T09:00:00.000Z");

    // scope_added changelog with the added hours, source=local, actor=Planner.
    const cl = TicketChangelogResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/tickets/4/changelog` })).json(),
    );
    expect(cl).toHaveLength(1);
    expect(cl[0]!.kind).toBe("scope_added");
    expect(cl[0]!.source).toBe("local");
    expect(cl[0]!.actor_name).toBe("Planner");
    expect(cl[0]!.actor_op_id).toBeNull();
    expect(cl[0]!.detail).toEqual({ kind: "scope_added", hours: 5 });
  });

  it("mid-sprint remove: marks removed_mid_sprint (row NOT deleted), scope_removed changelog, ZERO OP calls", async () => {
    // The ticket has 3 logged hours in OP; after the activation cache-refresh
    // that lands in work_package_cache.spent_hours, so the scope_removed
    // changelog can carry it (best-effort from cache).
    opData.workPackages = [
      opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H", spentTime: "PT3H" }),
    ];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1);
    await activate(sprintId);

    nowRef.value = "2026-06-04T10:00:00.000Z";
    opCalls.count = 0; // remove must not touch OP at all
    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/${sprintId}/items/1` });
    expect(del.statusCode).toBe(200);
    expect(opCalls.count).toBe(0);

    // Row is NOT deleted — it flips to removed_mid_sprint with a removed_at stamp.
    const item = await repos.sprintItems.getBySprintAndWp(sprintId, 1);
    expect(item).not.toBeNull();
    expect(item!.outcome).toBe("removed_mid_sprint");
    expect(item!.removed_at).toBe("2026-06-04T10:00:00.000Z");

    const cl = TicketChangelogResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/tickets/1/changelog` })).json(),
    );
    const removed = cl.find((c) => c.kind === "scope_removed")!;
    expect(removed.source).toBe("local");
    expect(removed.detail).toEqual({ kind: "scope_removed", hours: 10, logged_hours: 3 });

    // Live-verify regression (integration found this): a mid-sprint-removed
    // ticket is no longer a commitment (SPEC_05 §1) — it must NOT reappear as
    // "not done"/carried at closure, and the backlog's in_sprint flag must
    // flip back to false so the ticket is shown as available again.
    const backlog = (await t.app.inject({ method: "GET", url: "/api/backlog" })).json() as Array<{
      op_id: number;
      in_sprint: boolean;
    }>;
    expect(backlog.find((b) => b.op_id === 1)?.in_sprint).toBe(false);

    const finish = (await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` })).json() as {
      done: Array<{ wp_op_id: number }>;
      not_done: Array<{ wp_op_id: number }>;
    };
    expect(finish.done.some((i) => i.wp_op_id === 1)).toBe(false);
    expect(finish.not_done.some((i) => i.wp_op_id === 1)).toBe(false);
  });

  it("capacity response carries stacked segments + baseline_total_hours after add & remove", async () => {
    opData.workPackages = [
      opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H" }),
      opWp(2, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT6H" }),
      opWp(3, { assignee: { id: 11, name: "Bob" }, estimatedTime: "PT4H" }),
    ];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    await seedCache(repos, 2, { assignee: { id: 10, name: "Ann" }, estimated: 6 });
    await seedCache(repos, 3, { assignee: { id: 11, name: "Bob" }, estimated: 4 });
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1);
    await addItem(t, sprintId, 2);
    await addItem(t, sprintId, 3);
    await setCapacity(t, sprintId, [
      { op_user_id: 10, name: "Ann", available_hours: 40 },
      { op_user_id: 11, name: "Bob", available_hours: 20 },
    ]);
    await activate(sprintId);

    // Add wp4 (Ann, 5h) and remove wp2 (Ann, baseline 6h) mid-sprint.
    opData.workPackages.push(opWp(4, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT5H" }));
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/items`, payload: { wp_op_id: 4 } });
    await t.app.inject({ method: "DELETE", url: `/api/sprints/${sprintId}/items/2` });

    const cap = CapacityResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).json(),
    );
    expect(cap.baseline_total_hours).toBe(20); // frozen at activation (10+6+4)
    const ann = cap.lines.find((l) => l.op_user_id === 10)!;
    expect(ann.baseline_hours).toBe(16); // 10 + 6 (frozen even though 6 removed)
    expect(ann.added_hours).toBe(5);
    expect(ann.removed_hours).toBe(6);
    expect(ann.planned_hours).toBe(15); // committed = 16 + 5 - 6
    expect(ann.available_hours).toBe(40); // unchanged by scope changes
    const bob = cap.lines.find((l) => l.op_user_id === 11)!;
    expect(bob).toMatchObject({ baseline_hours: 4, added_hours: 0, removed_hours: 0, planned_hours: 4 });
  });

  it("dismissing a committed ticket from the Backlog screen does NOT zero its capacity (SPEC_07 §5)", async () => {
    opData.workPackages = [opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H" })];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1);
    await setCapacity(t, sprintId, [{ op_user_id: 10, name: "Ann", available_hours: 40 }]);
    await activate(sprintId);

    // The sprint board's /items/detailed keeps showing a dismissed-but-committed
    // ticket (badged "no longer in backlog") — capacity must agree, not silently
    // drop it from the load just because it left the Backlog screen's own list.
    const dismiss = await t.app.inject({
      method: "POST",
      url: "/api/backlog/remove",
      payload: { wp_op_ids: [1] },
    });
    expect(dismiss.statusCode).toBe(200);

    const cap = CapacityResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).json(),
    );
    const ann = cap.lines.find((l) => l.op_user_id === 10)!;
    expect(ann.baseline_hours).toBe(10);
    expect(ann.planned_hours).toBe(10);
  });

  it("burndown ideal line is anchored on the frozen baseline_total_hours once active", async () => {
    opData.workPackages = [opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H" })];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1);
    await activate(sprintId);

    // Add wp4 mid-sprint (+5h): live scope grows, but the ideal anchor must NOT.
    opData.workPackages.push(opWp(4, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT5H" }));
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/items`, payload: { wp_op_id: 4 } });

    const bd = (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/burndown` })).json();
    expect(bd.total_planned_hours).toBe(10); // frozen baseline, NOT the live 15
  });

  it("errors reference the sprint's NAME (message + details.sprintName), not its numeric id", async () => {
    const sprintId = await createSprint(t, "Sprint 3.5.039");
    // Update before activation → SPRINT_NOT_ACTIVE, carrying the real name.
    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(res.statusCode).toBe(409);
    const err = ErrorResponse.parse(res.json());
    expect(err.error.code).toBe("SPRINT_NOT_ACTIVE");
    expect(err.error.message).toContain("Sprint 3.5.039");
    expect(err.error.message).not.toMatch(/Sprint \d+ /);
    expect((err.error.details as { sprintName?: string }).sprintName).toBe("Sprint 3.5.039");
  });

  it("immutability: add/remove on a locked (finished) sprint → 409, with the sprint name", async () => {
    opData.workPackages = [opWp(1, { assignee: { id: 10, name: "Ann" }, estimatedTime: "PT10H" })];
    await seedCache(repos, 1, { assignee: { id: 10, name: "Ann" }, estimated: 10 });
    const sprintId = await createSprint(t, "Sprint 3.5.039");
    await addItem(t, sprintId, 1);
    await activate(sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });

    const add = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items`,
      payload: { wp_op_id: 1 },
    });
    expect(add.statusCode).toBe(409); // SPRINT_CLOSED (lock ⟹ closed)
    expect(ErrorResponse.parse(add.json()).error.message).toContain("Sprint 3.5.039");

    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/${sprintId}/items/1` });
    expect(del.statusCode).toBe(409);
    const delErr = ErrorResponse.parse(del.json());
    expect((delErr.error.details as { sprintName?: string }).sprintName).toBe("Sprint 3.5.039");
  });
});
