import { describe, expect, it } from "vitest";
import type { OpClient, OpClientConfig, OpStatus, OpTimeEntry, OpWorkPackage } from "@osp/op-client";
import type { CapacityResponse, SprintItem, SprintResponse } from "@osp/contracts";
import {
  activateSprint,
  addConnection,
  buildTestApp,
  initVault,
  instant,
  makeFakeOpClient,
  rawQuery,
} from "../test-utils";

/**
 * Increment 25 (SPEC_25) — POST /sprints/:id/items/by-id: add a done/tested
 * "overnight AU" ticket to a sprint directly by OP id, live-fetched from OP,
 * with its membership BACKDATED to the day work actually happened (earliest
 * time-entry spentOn, else the ticket's createdAt). origin=added_retroactively.
 */

const STATUSES: OpStatus[] = [
  { _type: "Status", id: 1, name: "New", isClosed: false },
  { _type: "Status", id: 3, name: "Tested", isClosed: false },
  { _type: "Status", id: 7, name: "Closed", isClosed: true },
];

/** A done ("tested") ticket with a given estimate/remaining/createdAt. */
function mkWp(
  id: number,
  opts: { est?: string | null; rem?: string | null; createdAt?: string; statusId?: number } = {},
): OpWorkPackage {
  const statusId = opts.statusId ?? 3;
  const status = STATUSES.find((s) => s.id === statusId)!;
  return {
    _type: "WorkPackage",
    id,
    subject: `Nightly ticket ${id}`,
    estimatedTime: opts.est ?? "PT6H",
    remainingTime: opts.rem ?? "PT0H",
    spentTime: null,
    createdAt: opts.createdAt,
    updatedAt: "2026-07-10T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: `/api/v3/statuses/${statusId}`, title: status.name },
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
    },
  };
}

function timeEntry(id: number, wpId: number, spentOn: string, hours = "PT4H"): OpTimeEntry {
  return {
    _type: "TimeEntry",
    id,
    hours,
    spentOn,
    _links: {
      self: { href: `/api/v3/time_entries/${id}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}` },
      user: { href: "/api/v3/users/10", title: "Dev Dan" },
    },
  };
}

async function makeSprint(
  t: Awaited<ReturnType<typeof buildTestApp>>,
  active: boolean,
): Promise<number> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/sprints",
    payload: { name: active ? "Active" : "Planning", start_date: "2026-07-01", end_date: "2026-07-14" },
  });
  const id = (res.json() as SprintResponse).id;
  if (active) await activateSprint(t, id);
  return id;
}

describe("POST /sprints/:id/items/by-id (SPEC_25)", () => {
  it("happy path: done ticket with time entries → backdated to earliest spentOn, retro_source=first_time_entry", async () => {
    const t = await buildTestApp({
      opData: {
        statuses: STATUSES,
        workPackages: [mkWp(5001, { est: "PT6H", rem: "PT0H", createdAt: "2026-07-01T02:00:00Z" })],
        timeEntries: [
          timeEntry(1, 5001, "2026-07-08"),
          timeEntry(2, 5001, "2026-07-06"), // earliest
          timeEntry(3, 5001, "2026-07-07"),
        ],
      },
    });
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    const sprintId = await makeSprint(t, true);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5001 },
    });
    expect(res.statusCode, res.payload).toBe(201);
    const item = res.json() as SprintItem;
    expect(item.origin).toBe("added_retroactively");
    expect(item.retro_source).toBe("first_time_entry");
    expect(instant(item.added_at)).toBe(instant("2026-07-06T00:00:00Z"));
    // Done ticket (remaining=0) → effectiveEstimate falls back to Work (6h).
    expect(item.planned_hours).toBe(6);

    // Cached + connection stamped (Increment 22 — never an un-attributed row).
    const cached = await t.repos.workPackages.getByOpId(5001);
    expect(cached?.connection_id).toBe(conn.id);
    // Baseline captured NOW (not backdated) with the retroactive origin.
    const baseline = (await t.repos.ticketBaselines.listBySprint(sprintId)).find(
      (b) => b.wp_op_id === 5001,
    );
    expect(baseline).toBeDefined();

    // Changelog logged with the backdated day (audit trail).
    const changelog = await t.repos.ticketChangelog.listBySprint(sprintId);
    const added = changelog.find((c) => c.wp_op_id === 5001 && c.kind === "scope_added");
    expect(added).toBeDefined();
    expect(added?.actor_name).toBe("Planner");
    expect(JSON.parse(added!.detail_json).backdated_to).toBe("2026-07-06");

    // Burndown backdated: the scope bump lands on 2026-07-06, not day 1.
    const snaps = await t.repos.burndown.listBySprint(sprintId);
    const day = (d: string) => snaps.find((s) => s.snapshot_date === d)!;
    expect(day("2026-07-05").total_count).toBe(0);
    expect(day("2026-07-06").total_count).toBe(1);
    await t.close();
  });

  // FOLLOWUPS #6 (user decision: variant A, 2026-08-19) — a retroactively-added
  // ticket is BY DEFINITION always in a finished/hidden status, so the SPEC_07
  // hidden-status filter used to drop its capacity line unconditionally while
  // the shared closure header counted it (invariant 8 broken on the user's
  // real closed sprint: 88h ≠ 80h). `added_retroactively` now bypasses that
  // filter exactly like frozen baseline items do.
  it("retro-added done ticket keeps its holder's capacity line — invariant 8 (header = Σ developer lines) holds", async () => {
    const wp = mkWp(5002, { est: "PT8H", rem: "PT0H", createdAt: "2026-07-01T02:00:00Z" });
    wp._links.assignee = { href: "/api/v3/users/9", title: "Retro Dev" };
    const t = await buildTestApp({
      opData: {
        statuses: STATUSES,
        workPackages: [wp],
        timeEntries: [timeEntry(1, 5002, "2026-07-06")],
      },
    });
    await initVault(t);
    await addConnection(t);
    const sprintId = await makeSprint(t, true);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5002 },
    });
    expect(res.statusCode, res.payload).toBe(201);

    const capRes = await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` });
    expect(capRes.statusCode).toBe(200);
    const cap = capRes.json() as CapacityResponse;
    const line = cap.lines.find((l) => l.name === "Retro Dev");
    expect(
      line,
      "the done retro ticket's holder keeps a capacity line (hidden-status filter bypassed for added_retroactively)",
    ).toBeDefined();
    expect(line!.planned_hours).toBe(8);
    const devSum = cap.lines
      .filter((l) => l.is_developer)
      .reduce((s, l) => s + l.planned_hours, 0);
    expect(cap.scope_planned_hours, "invariant 8: header equals Σ developer lines").toBeCloseTo(devSum, 5);
    await t.close();
  });

  it("no time entries → falls back to the ticket's createdAt, retro_source=created_at (planning sprint still logs)", async () => {
    const t = await buildTestApp({
      opData: {
        statuses: STATUSES,
        workPackages: [mkWp(5002, { createdAt: "2026-07-03T08:30:00Z" })],
        timeEntries: [],
      },
    });
    await initVault(t);
    await addConnection(t);
    const sprintId = await makeSprint(t, false); // planning

    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5002 },
    });
    expect(res.statusCode, res.payload).toBe(201);
    const item = res.json() as SprintItem;
    expect(item.retro_source).toBe("created_at");
    expect(instant(item.added_at)).toBe(instant("2026-07-03T08:30:00Z"));
    expect(item.origin).toBe("added_retroactively");

    // Deliberate SPEC_25 difference: a planning-stage retroactive add STILL logs.
    const changelog = await t.repos.ticketChangelog.listBySprint(sprintId);
    const added = changelog.find((c) => c.wp_op_id === 5002 && c.kind === "scope_added");
    expect(added).toBeDefined();
    expect(JSON.parse(added!.detail_json).backdated_to).toBe("2026-07-03");
    await t.close();
  });

  it("duplicate add → ITEM_ALREADY_IN_SPRINT", async () => {
    const t = await buildTestApp({
      opData: { statuses: STATUSES, workPackages: [mkWp(5003)], timeEntries: [timeEntry(1, 5003, "2026-07-05")] },
    });
    await initVault(t);
    await addConnection(t);
    const sprintId = await makeSprint(t, true);

    const first = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5003 },
    });
    expect(first.statusCode).toBe(201);
    const dup = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5003 },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("ITEM_ALREADY_IN_SPRINT");
    await t.close();
  });

  it("ticket not found on OP → WORK_PACKAGE_NOT_FOUND", async () => {
    const t = await buildTestApp({
      opData: { statuses: STATUSES, workPackages: [], timeEntries: [] },
    });
    await initVault(t);
    await addConnection(t);
    const sprintId = await makeSprint(t, true);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 9999 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("WORK_PACKAGE_NOT_FOUND");
    await t.close();
  });

  it("locked sprint → SPRINT_LOCKED with a Reactivate hint in details", async () => {
    const t = await buildTestApp({
      opData: { statuses: STATUSES, workPackages: [mkWp(5004)], timeEntries: [] },
    });
    await initVault(t);
    await addConnection(t);
    const sprintId = await makeSprint(t, true);
    // Force a locked-but-not-closed state (in a real app close() sets both, so
    // SPRINT_CLOSED would fire first; this isolates the SPRINT_LOCKED branch).
    // Postgres: `$1` placeholder and a real boolean (SQLite used `?` and `1`).
    await rawQuery(t.raw, "UPDATE sprint SET is_locked = true WHERE id = $1", [sprintId]);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5004 },
    });
    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe("SPRINT_LOCKED");
    const details = err.details as { hint?: string; reactivatable?: boolean; sprintName?: string };
    expect(details.hint).toBe("reactivate");
    // Sprint window (2026-07-01..2026-07-14) is in the past vs the real clock, so
    // the Reactivate escape hatch is closed — the frontend can dim the action.
    expect(details.reactivatable).toBe(false);
    expect(details.sprintName).toBe("Active");
    await t.close();
  });

  it("disconnected explicit connection_id → CONNECTION_DISABLED (legitimately fatal, Inc 23 §7.2)", async () => {
    const t = await buildTestApp({
      opClientFactory: (config: OpClientConfig): OpClient =>
        makeFakeOpClient({ statuses: STATUSES, workPackages: [mkWp(5005)], timeEntries: [] }),
    });
    await initVault(t);
    const a = (await addConnection(t, { base_url: "https://op-a.example.com" })) as { id: number };
    const b = (await addConnection(t, { base_url: "https://op-b.example.com" })) as { id: number };
    await t.app.inject({ method: "PATCH", url: `/api/connections/${b.id}`, payload: { enabled: false } });
    const sprintId = await makeSprint(t, true);

    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items/by-id`,
      payload: { wp_op_id: 5005, connection_id: b.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONNECTION_DISABLED");
    // The still-enabled connection a is untouched (no cache row written).
    expect(await t.repos.workPackages.getByOpId(5005)).toBeNull();
    expect(a.id).toBeGreaterThan(0);
    await t.close();
  });
});
