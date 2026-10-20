import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorResponse, OffSprintTimeResponse, SprintResponse, SprintUpdateRunResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type { HalLink, OpStatus, OpTimeEntry, OpWorkPackage } from "@osp/op-client";
import {
  activateSprint,
  addConnection,
  buildTestApp,
  type FakeOpData,
  initVault,
  type TestApp,
  waitForActivation,
} from "../test-utils";

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §6) — unit tests for the
 * off-sprint time report: fetch windowing/exclusion/degradation
 * (apps/api/src/logic/sprintUpdate.ts's `fetchAndPersistOffSprintTime`), the
 * repo's replace semantics, and the GET endpoint's aggregation + identity
 * folding + locked-vault read. Harness mirrors sprint-lifecycle.test.ts
 * (buildTestApp/FakeOpData).
 */

const STATUSES: OpStatus[] = [{ _type: "Status", id: 1, name: "New", isClosed: false }];

function statusLink(): HalLink {
  return { href: "/api/v3/statuses/1", title: "New" };
}
function userLink(id: number, title?: string): HalLink {
  return { href: `/api/v3/users/${id}`, ...(title ? { title } : {}) };
}

function opWp(id: number, assignee?: { id: number; name: string }): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    estimatedTime: null,
    remainingTime: null,
    spentTime: null,
    updatedAt: "2026-06-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: statusLink(),
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
      ...(assignee ? { assignee: userLink(assignee.id, assignee.name) } : {}),
    },
  };
}

function opTimeEntry(
  id: number,
  wpId: number,
  wpTitle: string | undefined,
  hours: string,
  spentOn: string,
  actor: { id: number; name?: string },
): OpTimeEntry {
  return {
    _type: "TimeEntry",
    id,
    hours,
    spentOn,
    createdAt: `${spentOn}T09:00:00Z`,
    _links: {
      self: { href: `/api/v3/time_entries/${id}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}`, ...(wpTitle ? { title: wpTitle } : {}) },
      user: userLink(actor.id, actor.name),
    },
  };
}

/** POST /sprints/:id/items requires the wp already cached (mirrors
 * sprint-lifecycle.test.ts's seedCache — addItem 404s WORK_PACKAGE_NOT_FOUND
 * otherwise). */
async function seedCache(repos: Repositories, wp: OpWorkPackage): Promise<void> {
  await repos.workPackages.upsertMany([
    {
      op_id: wp.id,
      project_op_id: 100,
      subject: wp.subject,
      type_name: "Task",
      status_name: "New",
      status_is_closed: false,
      assignee_op_id: wp._links.assignee ? Number(wp._links.assignee.href!.split("/").pop()) : null,
      assignee_name: wp._links.assignee?.title ?? null,
      estimated_hours: null,
      remaining_hours: null,
      spent_hours: null,
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

async function createSprint(t: TestApp): Promise<number> {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/sprints",
    payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
  });
  return SprintResponse.parse(res.json()).id;
}

async function addItem(t: TestApp, sprintId: number, wpId: number): Promise<void> {
  const r = await t.app.inject({
    method: "POST",
    url: `/api/sprints/${sprintId}/items`,
    payload: { wp_op_id: wpId },
  });
  if (r.statusCode !== 201) throw new Error(`addItem failed: ${r.statusCode} ${r.payload}`);
}

async function getOffSprintTime(t: TestApp, sprintId: number) {
  const res = await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/off-sprint-time` });
  expect(res.statusCode).toBe(200);
  return OffSprintTimeResponse.parse(res.json());
}

async function runUpdate(t: TestApp, sprintId: number): Promise<void> {
  const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
  expect(res.statusCode).toBe(200);
  expect(SprintUpdateRunResponse.parse(res.json()).status).toBe("success");
}

describe("Increment 32 — off-sprint time report", () => {
  let t: TestApp;
  let opData: FakeOpData;
  let repos!: Repositories;
  const nowRef = { value: "2026-06-02T08:00:00.000Z" };

  beforeEach(async () => {
    opData = { statuses: STATUSES, workPackages: [], activitiesByWpId: {}, timeEntries: [] };
    t = await buildTestApp({ opData, now: () => new Date(nowRef.value) });
    repos = t.repos;
    await initVault(t);
    await addConnection(t);
  });
  afterEach(async () => {
    await t.close();
  });

  /** Roster: two developers (Ann=10, Bob=20) + one non-developer (Cara=30). */
  async function seedRoster(): Promise<void> {
    await repos.teamMembers.upsert({ op_user_id: 10, name: "Ann", default_hours_per_day: 8 });
    await repos.teamMembers.upsert({ op_user_id: 20, name: "Bob", default_hours_per_day: 8 });
    const cara = await repos.teamMembers.upsert({
      op_user_id: 30,
      name: "Cara",
      default_hours_per_day: 8,
    });
    await repos.teamMembers.setRole(cara.id, "tester");
  }

  it("windows to [start_date, end_date] on BOTH ends (activation path)", async () => {
    await seedRoster();
    const wp = opWp(1001, { id: 10, name: "Ann" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);

    opData.timeEntries = [
      // Off-sprint ticket 2001, inside the window → included.
      opTimeEntry(7001, 2001, "Off-sprint ticket", "PT2H", "2026-06-05", { id: 10, name: "Ann" }),
      // Before start_date → excluded.
      opTimeEntry(7002, 2002, "Too early", "PT3H", "2026-05-31", { id: 10, name: "Ann" }),
      // After end_date → excluded.
      opTimeEntry(7003, 2003, "Too late", "PT4H", "2026-06-15", { id: 10, name: "Ann" }),
      // Exactly on the boundaries → included (inclusive both ends).
      opTimeEntry(7004, 2004, "On start", "PT1H", "2026-06-01", { id: 10, name: "Ann" }),
      opTimeEntry(7005, 2005, "On end", "PT1H", "2026-06-14", { id: 10, name: "Ann" }),
    ];

    const activateRes = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/activate` });
    expect(activateRes.statusCode).toBe(200);
    await waitForActivation(t, sprintId);

    const report = await getOffSprintTime(t, sprintId);
    expect(report.window).toEqual({ from: "2026-06-01", to: "2026-06-14" });
    expect(report.total_hours).toBe(4); // 2001(2h) + 2004(1h) + 2005(1h)
    expect(report.per_person).toHaveLength(1);
    const tickets = report.per_person[0]!.tickets.map((tk) => tk.wp_op_id).sort();
    expect(tickets).toEqual([2001, 2004, 2005]);
  });

  it("excludes entries on the sprint's own tickets, INCLUDING a removed_mid_sprint one", async () => {
    await seedRoster();
    const wp1001 = opWp(1001, { id: 10, name: "Ann" });
    opData.workPackages = [wp1001];
    await seedCache(repos, wp1001);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);

    // A ticket that WAS in the sprint but got removed mid-sprint — still
    // "sprint work", not off-sprint (§3 step 3: "ANY outcome").
    const removedItem = await repos.sprintItems.add({
      sprint_id: sprintId,
      wp_op_id: 1002,
      planned_hours: null,
      outcome: "planned",
      origin: "added_mid_sprint",
    });
    await repos.sprintItems.setOutcome(removedItem.id, "removed_mid_sprint", nowRef.value);

    opData.timeEntries = [
      // On the sprint's own live ticket → excluded.
      opTimeEntry(7101, 1001, "In-sprint ticket", "PT2H", "2026-06-05", { id: 10, name: "Ann" }),
      // On the removed-mid-sprint ticket → STILL excluded.
      opTimeEntry(7102, 1002, "Removed mid-sprint", "PT2H", "2026-06-05", { id: 10, name: "Ann" }),
      // Genuinely off-sprint → included.
      opTimeEntry(7103, 3001, "Off-sprint", "PT2H", "2026-06-05", { id: 10, name: "Ann" }),
      // Non-developer actor (Cara) → excluded by roster, even on an off-sprint ticket.
      opTimeEntry(7104, 3002, "Cara's off-sprint work", "PT2H", "2026-06-05", { id: 30, name: "Cara" }),
    ];
    await runUpdate(t, sprintId);

    const report = await getOffSprintTime(t, sprintId);
    expect(report.total_hours).toBe(2);
    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0]!.name).toBe("Ann");
    expect(report.per_person[0]!.tickets.map((tk) => tk.wp_op_id)).toEqual([3001]);
  });

  it("degrades user+spent_on → user-only → fully unfiltered when OP 400s on the `user` filter", async () => {
    await seedRoster();
    const wp = opWp(1001, { id: 10, name: "Ann" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);

    // Older-OP simulation: ANY query carrying a `user` filter 400s (SPEC_07
    // OP_QUERY_INVALID) — forces the ladder all the way to the unfiltered,
    // fully-client-side-filtered last resort.
    opData.timeEntriesRejectFilterKeys = ["user"];
    opData.timeEntries = [
      opTimeEntry(7201, 3001, "Off-sprint", "PT3H", "2026-06-05", { id: 10, name: "Ann" }),
      // A non-roster actor's entry — with NO server-side user filter honoured,
      // this only gets dropped by the CLIENT-SIDE roster re-check.
      opTimeEntry(7202, 3002, "Someone else", "PT5H", "2026-06-05", { id: 99, name: "Stranger" }),
    ];
    await runUpdate(t, sprintId);

    const report = await getOffSprintTime(t, sprintId);
    expect(report.total_hours).toBe(3);
    expect(report.per_person).toHaveLength(1);
    expect(report.per_person[0]!.name).toBe("Ann");
  });

  it("replaceForSprint semantics: a second run REPLACES the report (deleted-in-OP entry disappears)", async () => {
    await seedRoster();
    const wp = opWp(1001, { id: 10, name: "Ann" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);

    opData.timeEntries = [
      opTimeEntry(7301, 3001, "First entry", "PT2H", "2026-06-05", { id: 10, name: "Ann" }),
    ];
    await runUpdate(t, sprintId);
    const first = await getOffSprintTime(t, sprintId);
    expect(first.total_hours).toBe(2);
    expect(first.per_person[0]!.tickets.map((tk) => tk.wp_op_id)).toEqual([3001]);

    // The entry from run 1 is now GONE from OP (deleted/edited away) and a
    // different one exists instead — the stored report must reflect ONLY
    // what the second run saw, not a union of both runs.
    opData.timeEntries = [
      opTimeEntry(7302, 3002, "Second entry", "PT5H", "2026-06-06", { id: 10, name: "Ann" }),
    ];
    await runUpdate(t, sprintId);
    const second = await getOffSprintTime(t, sprintId);
    expect(second.total_hours).toBe(5);
    expect(second.per_person[0]!.tickets.map((tk) => tk.wp_op_id)).toEqual([3002]);
  });

  it("aggregates per person with identity folding (two spellings of one actor fold to one entry), sorted by total_hours desc", async () => {
    await seedRoster();
    const wp = opWp(1001, { id: 10, name: "Ann" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);

    // Curated alias (IDENTITY_MODEL.md "the cross-connection guard"): every
    // off_sprint_time_entry row carries a real (non-null) connection_id, and
    // the resolver's contradiction guard is CONNECTION-SCOPED — a differing
    // spelling under a known connection is normally treated as evidence of a
    // DIFFERENT person, not folded automatically. A curated `user_name_alias`
    // (op_user_id pin) is what makes "two spellings, one account" fold in
    // that case ("the human said so") — this is the realistic path for THIS
    // feature, since its rows are never connection-agnostic.
    const conn = (await repos.connections.getCurrent())!;
    await repos.userNameAliases.upsert({
      connection_id: conn.id,
      journal_name: "Robert (Bob)",
      op_user_id: 20,
    });

    opData.timeEntries = [
      // Bob (op id 20) logged under two different journal-name spellings —
      // both fold to the SAME roster person via the alias above.
      opTimeEntry(7401, 4001, "Bob's ticket A", "PT1H", "2026-06-05", { id: 20, name: "Bob" }),
      opTimeEntry(7402, 4002, "Bob's ticket B", "PT2H", "2026-06-06", { id: 20, name: "Robert (Bob)" }),
      // Ann logs fewer hours — must sort AFTER Bob (total_hours desc).
      opTimeEntry(7403, 4003, "Ann's ticket", "PT1H", "2026-06-05", { id: 10, name: "Ann" }),
    ];
    await runUpdate(t, sprintId);

    const report = await getOffSprintTime(t, sprintId);
    expect(report.per_person).toHaveLength(2);
    expect(report.per_person.map((p) => p.name)).toEqual(["Bob", "Ann"]);
    const bob = report.per_person[0]!;
    expect(bob.total_hours).toBe(3);
    expect(bob.tickets.map((tk) => tk.wp_op_id).sort()).toEqual([4001, 4002]);
    expect(report.fetched_at).not.toBeNull();
  });

  it("GET works with a LOCKED vault (stored rows only, no OP call on the read path)", async () => {
    await seedRoster();
    const wp = opWp(1001, { id: 10, name: "Ann" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);

    opData.timeEntries = [
      opTimeEntry(7501, 3001, "Off-sprint", "PT2H", "2026-06-05", { id: 10, name: "Ann" }),
    ];
    await runUpdate(t, sprintId);

    const lockRes = await t.app.inject({ method: "POST", url: "/api/vault/lock" });
    expect(lockRes.statusCode).toBe(200);

    const report = await getOffSprintTime(t, sprintId);
    expect(report.total_hours).toBe(2);
    expect(report.per_person[0]!.name).toBe("Ann");
  });

  it("a sprint that never ran an update pass reads an empty report (fetched_at null)", async () => {
    const sprintId = await createSprint(t);
    const report = await getOffSprintTime(t, sprintId);
    expect(report.fetched_at).toBeNull();
    expect(report.total_hours).toBe(0);
    expect(report.per_person).toEqual([]);
  });

  it("404s for an unknown sprint id", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/sprints/999999/off-sprint-time" });
    expect(res.statusCode).toBe(404);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_NOT_FOUND");
  });
});
