import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClosureReportResponse,
  ErrorResponse,
  SprintResponse,
  SprintUpdateRunResponse,
  SprintUpdateRunsResponse,
  TicketChangelogResponse,
  VelocityResponse,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type {
  HalLink,
  OpActivity,
  OpActivityDetail,
  OpStatus,
  OpTimeEntry,
  OpWorkPackage,
} from "@osp/op-client";
import { createSnapshotWriter } from "@osp/sync";
import {
  activateSprint,
  addConnection,
  buildTestApp,
  type FakeOpData,
  initVault,
  type TestApp,
  waitForActivation,
} from "../test-utils";

// ── OP fixture builders ──────────────────────────────────────────────────────
const STATUSES: OpStatus[] = [
  { _type: "Status", id: 1, name: "New", isClosed: false },
  { _type: "Status", id: 7, name: "In progress", isClosed: false },
  { _type: "Status", id: 12, name: "Closed", isClosed: true },
];

function statusLink(id: number): HalLink {
  const s = STATUSES.find((x) => x.id === id)!;
  return { href: `/api/v3/statuses/${id}`, title: s.name };
}
function userLink(id: number | null, title?: string): HalLink {
  return id === null ? { href: null } : { href: `/api/v3/users/${id}`, ...(title ? { title } : {}) };
}

function opWp(
  id: number,
  o: {
    subject?: string;
    statusId?: number;
    assignee?: { id: number; name: string } | null;
    estimatedTime?: string | null;
    remainingTime?: string | null;
  } = {},
): OpWorkPackage {
  const statusId = o.statusId ?? 1;
  return {
    _type: "WorkPackage",
    id,
    subject: o.subject ?? `WP ${id}`,
    estimatedTime: o.estimatedTime ?? null,
    remainingTime: o.remainingTime ?? null,
    spentTime: null,
    updatedAt: "2026-06-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: statusLink(statusId),
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
      ...(o.assignee ? { assignee: userLink(o.assignee.id, o.assignee.name) } : {}),
    },
  };
}

/**
 * Build a real-shaped `{format, raw, html}` activity detail (SPEC_11 §5) — the
 * parser reads the html/raw text, not the old speculative {property, old, new}.
 */
function textDetail(field: string, from: string | null, to: string): OpActivityDetail {
  const htmlInner =
    from === null ? `set to <i>${to}</i>` : `changed from <i>${from}</i> to <i>${to}</i>`;
  const rawInner = from === null ? `set to ${to}` : `changed from ${from} to ${to}`;
  return {
    format: "custom",
    raw: `${field} ${rawInner}`,
    html: `<strong>${field}</strong> ${htmlInner}`,
  };
}

function opActivity(
  id: number,
  createdAt: string,
  detail: OpActivityDetail | null,
  actor: { id: number; name: string } | null,
): OpActivity {
  return {
    _type: "Activity",
    id,
    createdAt,
    details: detail ? [detail] : [],
    comment: null,
    _links: {
      self: { href: `/api/v3/activities/${id}` },
      workPackage: { href: "/api/v3/work_packages/1001" },
      user: actor ? userLink(actor.id, actor.name) : userLink(null),
    },
  };
}

function opTimeEntry(
  id: number,
  wpId: number,
  hours: string,
  spentOn: string,
  actor: { id: number; name: string },
  createdAt: string,
): OpTimeEntry {
  return {
    _type: "TimeEntry",
    id,
    hours,
    spentOn,
    createdAt,
    _links: {
      self: { href: `/api/v3/time_entries/${id}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}` },
      user: userLink(actor.id, actor.name),
    },
  };
}

async function seedCache(repos: Repositories, wp: OpWorkPackage): Promise<void> {
  const statusId = Number(wp._links.status.href!.split("/").pop());
  const status = STATUSES.find((s) => s.id === statusId)!;
  await repos.workPackages.upsertMany([
    {
      op_id: wp.id,
      project_op_id: 100,
      subject: wp.subject,
      type_name: "Task",
      status_name: status.name,
      status_is_closed: status.isClosed,
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

describe("SPEC_04 sprint lifecycle (activate / update / finish, changelog, lock)", () => {
  let t: TestApp;
  let opData: FakeOpData;
  let repos!: Repositories;
  const nowRef = { value: "2026-06-02T08:00:00.000Z" };

  beforeEach(async () => {
    opData = { statuses: STATUSES, workPackages: [], activitiesByWpId: {}, timeEntries: [] };
    t = await buildTestApp({
      opData,
      now: () => new Date(nowRef.value),
      // Real snapshot writer (bound per-request to the fake OP client) so we can
      // assert an actual burndown_snapshot row is written on activation.
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
    nowRef.value = "2026-06-02T08:00:00.000Z";
    await initVault(t);
    await addConnection(t);
  });
  afterEach(async () => {
    await t.close();
  });

  it("activate captures baselines, writes a burndown row, and sets status active", async () => {
    const wp = opWp(1001, { subject: "Ticket A", statusId: 7, assignee: { id: 10, name: "Ann" }, remainingTime: "PT8H" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);

    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/activate` });
    expect(res.statusCode).toBe(200);
    // SPEC_09 §1: activation is async — the response is the STARTED run
    // (kind="activation"), not the Sprint; the sprint flips active in the background.
    const startedRun = SprintUpdateRunResponse.parse(res.json());
    expect(startedRun.kind).toBe("activation");
    expect(startedRun.total_count).toBe(1);
    await waitForActivation(t, sprintId);

    const sprint = (await repos.sprints.getById(sprintId))!;
    expect(sprint.status).toBe("active");
    expect(sprint.activated_at).toBe("2026-06-02T08:00:00.000Z");

    const baselines = await repos.ticketBaselines.listBySprint(sprintId);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.wp_op_id).toBe(1001);
    expect(baselines[0]!.status_name).toBe("In progress");
    expect(baselines[0]!.assignee_op_id).toBe(10);
    expect(baselines[0]!.remaining_hours).toBe(8);

    const burndown = await repos.burndown.listBySprint(sprintId);
    expect(burndown.length).toBeGreaterThanOrEqual(1);
    expect(burndown[0]!.snapshot_date).toBe("2026-06-02");

    const runs = await repos.sprintUpdateRuns.listBySprint(sprintId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe("activation");
    expect(runs[0]!.status).toBe("success");
  });

  it("re-activating an active sprint → SPRINT_NOT_PLANNING", async () => {
    const wp = opWp(1001, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);
    const again = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/activate` });
    expect(again.statusCode).toBe(409);
    expect(ErrorResponse.parse(again.json()).error.code).toBe("SPRINT_NOT_PLANNING");
  });

  it("update derives changelog (kind/actor/detail + closed companion), idempotent on re-run", async () => {
    const wp = opWp(1001, { statusId: 7, assignee: { id: 10, name: "Ann" }, remainingTime: "PT8H" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);

    // Activity happens AFTER activation → picked up by the update pass.
    opData.activitiesByWpId = {
      1001: [
        opActivity(
          9001,
          "2026-06-02T09:00:00.000Z",
          textDetail("Assignee", "Ann", "Bob"),
          { id: 10, name: "Ann" },
        ),
        opActivity(
          9002,
          "2026-06-02T10:00:00.000Z",
          textDetail("Status", "In progress", "Closed"),
          { id: 20, name: "Bob" },
        ),
      ],
    };
    opData.timeEntries = [
      opTimeEntry(7001, 1001, "PT4H", "2026-06-03", { id: 20, name: "Bob" }, "2026-06-03T09:00:00.000Z"),
    ];
    // Reflect the new OP state in the returned work package too (realistic).
    opData.workPackages = [opWp(1001, { statusId: 12, assignee: { id: 20, name: "Bob" }, remainingTime: "PT0H" })];

    const upd = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(upd.statusCode).toBe(200);
    const run = SprintUpdateRunResponse.parse(upd.json());
    expect(run.kind).toBe("update");
    expect(run.status).toBe("success");
    // assignee + status_changed + closed companion + time_logged = 4
    expect(run.changes_count).toBe(4);
    // Increment 8 §3: progress ends at "all processed" (1 ticket in this sprint).
    expect(run.wp_count).toBe(1);
    expect(run.total_count).toBe(1);

    const clRes = await t.app.inject({
      method: "GET",
      url: `/api/sprints/${sprintId}/tickets/1001/changelog`,
    });
    const changelog = TicketChangelogResponse.parse(clRes.json());
    expect(changelog.map((c) => c.kind)).toEqual([
      "assignee_changed",
      "status_changed",
      "closed",
      "time_logged",
    ]);

    const [assignee, status, closed, logged] = changelog;
    expect(assignee!.actor_name).toBe("Ann");
    expect(assignee!.detail).toEqual({ kind: "assignee_changed", from: "Ann", to: "Bob" });
    expect(status!.actor_op_id).toBe(20);
    expect(status!.detail).toEqual({ kind: "status_changed", from: "In progress", to: "Closed" });
    expect(closed!.detail).toEqual({ kind: "closed", status: "Closed" });
    expect(closed!.op_journal_id).toBe(9002);
    expect(logged!.source).toBe("time_entry");
    expect(logged!.detail).toEqual({ kind: "time_logged", hours: 4, spent_on: "2026-06-03" });

    // Idempotence: a second update with the SAME OP data inserts ZERO new rows.
    const upd2 = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(SprintUpdateRunResponse.parse(upd2.json()).changes_count).toBe(0);
    const changelog2 = TicketChangelogResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/tickets/1001/changelog` })).json(),
    );
    expect(changelog2).toHaveLength(4);
  });

  // FOLLOWUPS #8 (user decision 2026-08-19): the time_logged derivation window
  // is the sprint's CALENDAR window (spentOn >= start_date), NOT the activation
  // date. A sprint activated on Tuesday for a Monday start — or a retrospective
  // sprint whose "activation" is the replay moment — must still credit work
  // logged between start_date and the Activate click; the burnup line uses the
  // same bound, so Closure and the chart reconcile.
  it("time_logged window is start_date, not activation: pre-activation-but-in-window entries derive; pre-start_date ones never do", async () => {
    const wp = opWp(1001, { statusId: 7, assignee: { id: 10, name: "Ann" }, remainingTime: "PT8H" });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t); // start_date 2026-06-01
    await addItem(t, sprintId, 1001);
    // Clock is 2026-06-02T08:00 → activation date 2026-06-02, one day AFTER start.
    await activateSprint(t, sprintId);

    opData.timeEntries = [
      // (a) spentOn on start_date, BEFORE activation day — the old
      //     activation-date bound silently dropped exactly this entry.
      opTimeEntry(7101, 1001, "PT3H", "2026-06-01", { id: 10, name: "Ann" }, "2026-06-01T15:00:00.000Z"),
      // (b) spentOn before start_date — pre-sprint history, never derived.
      opTimeEntry(7102, 1001, "PT9H", "2026-05-28", { id: 10, name: "Ann" }, "2026-05-28T15:00:00.000Z"),
      // (c) spentOn after end_date (2026-06-14) — the successor sprint's work
      //     on a shared ticket; the window is closed on BOTH ends.
      opTimeEntry(7103, 1001, "PT7H", "2026-06-20", { id: 10, name: "Ann" }, "2026-06-20T15:00:00.000Z"),
    ];

    const upd = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(upd.statusCode).toBe(200);

    const clRes = await t.app.inject({
      method: "GET",
      url: `/api/sprints/${sprintId}/tickets/1001/changelog`,
    });
    const logged = TicketChangelogResponse.parse(clRes.json()).filter((c) => c.kind === "time_logged");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.detail).toEqual({ kind: "time_logged", hours: 3, spent_on: "2026-06-01" });
  });

  it("update before activation → SPRINT_NOT_ACTIVE", async () => {
    const sprintId = await createSprint(t);
    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_NOT_ACTIVE");
  });

  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2a) — SUPERSEDES the old
  // "any locked sprint → SPRINT_LOCKED" rule: a locked-but-NOT-frozen sprint
  // is the post-finish GRACE WINDOW, and update is now ALLOWED there (late
  // time logs/status flips still arrive without reactivating). Only a FROZEN
  // sprint rejects update, with the new SPRINT_FROZEN code.
  it("update on a locked-but-unfrozen sprint (grace window) is ALLOWED", async () => {
    const wp = opWp(1001, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });

    const sprintBeforeUpdate = await repos.sprints.getById(sprintId);
    expect(sprintBeforeUpdate?.is_locked).toBe(true);
    expect(sprintBeforeUpdate?.frozen_at).toBeNull();

    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(res.statusCode).toBe(200);
    const run = SprintUpdateRunResponse.parse(res.json());
    expect(run.status).toBe("success");
  });

  it("update on a FROZEN sprint → 409 SPRINT_FROZEN", async () => {
    const wp = opWp(1001, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });
    // Simulate the freeze sweep having already run (its own mechanics are
    // covered by logic/freeze.test.ts) — only the GATE is under test here.
    await repos.sprints.setFrozen(sprintId, nowRef.value);

    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_FROZEN");
  });

  it("GET /updates returns run history newest first", async () => {
    const wp = opWp(1001, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    const res = await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/updates` });
    const runs = SprintUpdateRunsResponse.parse(res.json());
    expect(runs).toHaveLength(2);
    expect(runs[0]!.kind).toBe("update"); // newest first
    expect(runs[1]!.kind).toBe("activation");
  });

  it("finish runs closure + locks the sprint, and is idempotent on re-call", async () => {
    const done = opWp(2001, { subject: "Done", statusId: 12 });
    const open = opWp(2002, { subject: "Open", statusId: 7 });
    opData.workPackages = [done, open];
    await seedCache(repos, done);
    await seedCache(repos, open);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 2001);
    await addItem(t, sprintId, 2002);
    await activateSprint(t, sprintId);

    const fin = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });
    expect(fin.statusCode).toBe(200);
    const report = ClosureReportResponse.parse(fin.json());
    expect(report.done.map((d) => d.wp_op_id)).toEqual([2001]);
    expect(report.not_done.map((d) => d.wp_op_id)).toEqual([2002]);

    const locked = await repos.sprints.getById(sprintId);
    expect(locked!.is_locked).toBe(true);
    expect(locked!.status).toBe("closed");
    expect(locked!.lock_reason).toBe("finished");

    const runsAfterFinish = (await repos.sprintUpdateRuns.listBySprint(sprintId)).length;

    // Idempotent re-finish: same report, NO new update run.
    const fin2 = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });
    expect(fin2.statusCode).toBe(200);
    const report2 = ClosureReportResponse.parse(fin2.json());
    expect(report2.generated_at).toBe(report.generated_at);
    expect((await repos.sprintUpdateRuns.listBySprint(sprintId)).length).toBe(runsAfterFinish);
  });

  it("PATCH status:active from planning captures a baseline (Activate button path)", async () => {
    const wp = opWp(1001, { statusId: 7, assignee: { id: 10, name: "Ann" } });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);

    const res = await t.app.inject({
      method: "PATCH",
      url: `/api/sprints/${sprintId}`,
      payload: { status: "active" },
    });
    expect(res.statusCode).toBe(200);
    expect(SprintResponse.parse(res.json()).status).toBe("active");
    const baselines = await repos.ticketBaselines.listBySprint(sprintId);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.wp_op_id).toBe(1001);
  });

  it("lock blocks mutations: PATCH / PUT capacity / items on a locked sprint → 409", async () => {
    const wp = opWp(1001, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 1001);
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });

    const patch = await t.app.inject({
      method: "PATCH",
      url: `/api/sprints/${sprintId}`,
      payload: { name: "renamed" },
    });
    expect(patch.statusCode).toBe(409);
    expect(ErrorResponse.parse(patch.json()).error.code).toBe("SPRINT_LOCKED");

    const cap = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprintId}/capacity`,
      payload: { members: [{ op_user_id: 10, available_hours: 8 }] },
    });
    expect(cap.statusCode).toBe(409);
    expect(ErrorResponse.parse(cap.json()).error.code).toBe("SPRINT_LOCKED");

    const addPost = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items`,
      payload: { wp_op_id: 1001 },
    });
    expect(addPost.statusCode).toBe(409); // SPRINT_CLOSED (lock ⟹ closed)

    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/${sprintId}/items/1001` });
    expect(del.statusCode).toBe(409);
  });

  // ── SPEC_11 §2 — delete sprint + cascade ────────────────────────────────────
  it("DELETE /sprints/:id hard-deletes the sprint + all history; a new sprint can be re-created", async () => {
    const done = opWp(3001, { subject: "Done", statusId: 12 });
    opData.workPackages = [done];
    await seedCache(repos, done);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 3001);
    // Capacity (planning-only) + activate + finish → seeds every dependent table.
    await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprintId}/capacity`,
      payload: { members: [{ op_user_id: 10, available_hours: 8 }] },
    });
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });

    // Sanity: dependent rows exist before delete.
    expect((await repos.ticketBaselines.listBySprint(sprintId)).length).toBeGreaterThan(0);
    expect((await repos.sprintUpdateRuns.listBySprint(sprintId)).length).toBeGreaterThan(0);
    expect((await repos.burndown.listBySprint(sprintId)).length).toBeGreaterThan(0);
    expect(await repos.closureReports.getBySprint(sprintId)).not.toBeNull();
    expect((await repos.capacities.listBySprint(sprintId)).length).toBeGreaterThan(0);

    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/${sprintId}` });
    expect(del.statusCode).toBe(200);
    // Increment 12 (SPEC_12 §6): the response now carries the pre-delete export
    // path (a JSON snapshot written before the cascade).
    expect(del.json()).toMatchObject({ sprint_id: sprintId, deleted: true });
    expect(del.json().export_path).toMatch(/^exports\/sprint-.*\.json$/);

    // GET now 404s, and every dependent table is empty for this sprint.
    const get = await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}` });
    expect(get.statusCode).toBe(404);
    expect(await repos.sprints.getById(sprintId)).toBeNull();
    expect(await repos.sprintItems.listBySprint(sprintId)).toEqual([]);
    expect(await repos.ticketBaselines.listBySprint(sprintId)).toEqual([]);
    expect(await repos.sprintUpdateRuns.listBySprint(sprintId)).toEqual([]);
    expect(await repos.burndown.listBySprint(sprintId)).toEqual([]);
    expect(await repos.closureReports.getBySprint(sprintId)).toBeNull();
    expect(await repos.capacities.listBySprint(sprintId)).toEqual([]);
    expect(await repos.ticketChangelog.listBySprint(sprintId)).toEqual([]);

    // Re-create works (no unique-constraint leftovers) — repeatable mock testing.
    const recreated = await createSprint(t);
    expect(recreated).toBeGreaterThan(0);
  });

  it("DELETE /sprints/:id on an unknown sprint → 404", async () => {
    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/999999` });
    expect(del.statusCode).toBe(404);
  });

  // ── SPEC_11 §8a — /close on an ACTIVE sprint returns a report WITHOUT locking ─
  it("POST /close on an ACTIVE sprint returns a report both times WITHOUT locking", async () => {
    const done = opWp(4001, { subject: "Done", statusId: 12 });
    const open = opWp(4002, { subject: "Open", statusId: 7 });
    opData.workPackages = [done, open];
    await seedCache(repos, done);
    await seedCache(repos, open);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 4001);
    await addItem(t, sprintId, 4002);
    await activateSprint(t, sprintId);

    for (let i = 0; i < 2; i++) {
      const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/close` });
      expect(res.statusCode).toBe(200);
      const report = ClosureReportResponse.parse(res.json());
      expect(report.done.map((d) => d.wp_op_id)).toEqual([4001]);
      const s = (await repos.sprints.getById(sprintId))!;
      expect(s.status).toBe("active"); // NOT locked by view/regenerate
      expect(s.is_locked).toBe(false);
    }
  });

  // ── SPEC_11 §8b — reactivate (date-gated, audited) ──────────────────────────
  it("POST /reactivate unlocks a finished sprint within its date window + audits it", async () => {
    const wp = opWp(5001, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t); // 2026-06-01 … 2026-06-14
    await addItem(t, sprintId, 5001);
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });
    expect((await repos.sprints.getById(sprintId))!.is_locked).toBe(true);

    const runsBefore = (await repos.sprintUpdateRuns.listBySprint(sprintId)).length;
    // nowRef default 2026-06-02 ∈ [start,end] → allowed.
    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/reactivate`, payload: {} });
    expect(res.statusCode).toBe(200);
    const sprint = SprintResponse.parse(res.json());
    expect(sprint.status).toBe("active");
    expect(sprint.is_locked).toBe(false);
    expect(sprint.lock_reason).toBeNull();
    expect(sprint.locked_at).toBeNull();
    expect(sprint.closed_at).toBeNull();

    // Audit: a kind="reactivate" run was recorded.
    const runs = await repos.sprintUpdateRuns.listBySprint(sprintId);
    expect(runs.length).toBe(runsBefore + 1);
    expect(runs[0]!.kind).toBe("reactivate");
    expect(runs[0]!.status).toBe("success");
    expect(runs[0]!.finished_at).not.toBeNull();

    // Update/add work again now that it's active.
    const upd = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(upd.statusCode).toBe(200);
  });

  it("POST /reactivate outside the [start,end] window → 409 (REACTIVATE_WINDOW_CLOSED)", async () => {
    const wp = opWp(5101, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 5101);
    await activateSprint(t, sprintId);
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });

    nowRef.value = "2026-07-20T08:00:00.000Z"; // past end_date 2026-06-14
    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/reactivate`, payload: {} });
    expect(res.statusCode).toBe(409);
    const err = ErrorResponse.parse(res.json());
    expect(err.error.code).toBe("CONFLICT");
    expect((err.error.details as { reason?: string }).reason).toBe("REACTIVATE_WINDOW_CLOSED");
    expect((await repos.sprints.getById(sprintId))!.is_locked).toBe(true); // unchanged
  });

  // ── SPEC_11 §9 — velocity: real total + per-server breakdown ─────────────────
  it("GET /velocity carries a REAL per-connection breakdown for closed sprints", async () => {
    const conn = (await repos.connections.list())[0]!;
    await repos.workPackages.upsertMany([
      {
        connection_id: conn.id,
        op_id: 7001,
        project_op_id: 100,
        subject: "Done A",
        type_name: "Task",
        status_name: "Closed",
        status_is_closed: true,
        assignee_op_id: 10,
        assignee_name: "Ann",
        estimated_hours: 8,
        remaining_hours: 0,
        spent_hours: null,
        story_points: null,
        version_op_id: null,
        version_name: null,
        priority: null,
        parent_op_id: null,
        percentage_done: null,
        updated_at_op: "2026-05-02T00:00:00Z",
        raw_json: "{}",
      },
    ]);
    const closed = await repos.sprints.create({
      name: "Closed A",
      start_date: "2026-05-01",
      end_date: "2026-05-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await repos.sprintItems.add({
      sprint_id: closed.id,
      wp_op_id: 7001,
      planned_hours: 8,
      outcome: "done",
      origin: "baseline",
    });
    await repos.sprints.close(closed.id, 8, "2026-05-14T18:00:00Z", "finished");

    const current = await createSprint(t);
    const res = await t.app.inject({ method: "GET", url: `/api/sprints/${current}/velocity` });
    const v = VelocityResponse.parse(res.json());
    const entry = v.history.find((h) => h.sprint_id === closed.id)!;
    expect(entry, "closed sprint appears in velocity history").toBeDefined();
    expect(entry.completed_hours).toBe(8);
    expect(entry.by_connection).toHaveLength(1);
    expect(entry.by_connection[0]!.connection_id).toBe(conn.id);
    expect(entry.by_connection[0]!.base_url).toBe(conn.base_url);
    expect(entry.by_connection[0]!.completed_hours).toBe(8);
  });

  it("POST /reactivate on a NOT-locked sprint → 409 (SPRINT_NOT_LOCKED)", async () => {
    const wp = opWp(5201, { statusId: 7 });
    opData.workPackages = [wp];
    await seedCache(repos, wp);
    const sprintId = await createSprint(t);
    await addItem(t, sprintId, 5201);
    await activateSprint(t, sprintId); // active but NOT locked

    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/reactivate`, payload: {} });
    expect(res.statusCode).toBe(409);
    const err = ErrorResponse.parse(res.json());
    expect((err.error.details as { reason?: string }).reason).toBe("SPRINT_NOT_LOCKED");
  });
});
