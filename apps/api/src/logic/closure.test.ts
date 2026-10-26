import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Repositories } from "@osp/db";
import {
  buildClosureSplit,
  computeAndStoreClosureReport,
  performClosure,
  type ClosureInputItem,
} from "./closure";

// ── SPEC_11 §8a — "View / regenerate closure report" must NOT lock ────────────

let handle: Awaited<ReturnType<typeof openDb>>;
let repos: Repositories;

beforeEach(async () => {
  handle = await openDb({ ephemeral: true });
  repos = handle.repositories;
});
afterEach(async () => {
  await handle.close();
});

/** Seed an ACTIVE sprint holding two tickets: one closed (done), one open. */
async function seedActiveSprint(): Promise<number> {
  const sprint = await repos.sprints.create({
    name: "S1",
    start_date: "2026-07-01",
    end_date: "2026-07-14",
    status: "planning",
    capacity_mode: "per_person",
  });
  await repos.workPackages.upsertMany([
    {
      op_id: 1001,
      project_op_id: 100,
      project_name: null,
      subject: "Done ticket",
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
      updated_at_op: "2026-07-02T00:00:00Z",
      raw_json: "{}",
    },
    {
      op_id: 1002,
      project_op_id: 100,
      project_name: null,
      subject: "Open ticket",
      type_name: "Task",
      status_name: "In progress",
      status_is_closed: false,
      assignee_op_id: 10,
      assignee_name: "Ann",
      estimated_hours: 4,
      remaining_hours: 4,
      spent_hours: null,
      story_points: null,
      version_op_id: null,
      version_name: null,
      priority: null,
      parent_op_id: null,
      percentage_done: null,
      updated_at_op: "2026-07-02T00:00:00Z",
      raw_json: "{}",
    },
  ]);
  await repos.sprintItems.add({
    sprint_id: sprint.id,
    wp_op_id: 1001,
    planned_hours: 8,
    outcome: "planned",
    origin: "baseline",
  });
  await repos.sprintItems.add({
    sprint_id: sprint.id,
    wp_op_id: 1002,
    planned_hours: 4,
    outcome: "planned",
    origin: "baseline",
  });
  await repos.sprints.activate(sprint.id, "2026-07-01T09:00:00Z", 12);
  return sprint.id;
}

describe("buildClosureSplit (pure)", () => {
  it("splits done (closed) vs not-done and sums completed hours", () => {
    const items: ClosureInputItem[] = [
      {
        wp_op_id: 1,
        subject: "A",
        status_name: "Closed",
        status_is_closed: true,
        assignee_name: "Ann",
        planned_hours: 8,
        remaining_hours: 0,
        version_name: null,
      },
      {
        wp_op_id: 2,
        subject: "B",
        status_name: "In progress",
        status_is_closed: false,
        assignee_name: "Ann",
        planned_hours: 4,
        remaining_hours: 4,
        version_name: null,
      },
    ];
    const split = buildClosureSplit(items, []);
    expect(split.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(split.not_done.map((d) => d.wp_op_id)).toEqual([2]);
    expect(split.version_change.map((d) => d.wp_op_id)).toEqual([2]);
    expect(split.completed_hours).toBe(8);
  });
});

describe("buildClosureSplit — Increment 34 §1: velocity is burned remaining (pure)", () => {
  it("a still-OPEN item's partial burn now counts too — not just done items' flat planned_hours", () => {
    const items: ClosureInputItem[] = [
      {
        wp_op_id: 1,
        subject: "A",
        status_name: "Closed",
        status_is_closed: true,
        assignee_name: "Ann",
        planned_hours: 8,
        remaining_hours: 0,
        version_name: null,
        remaining_start_hours: 8,
        remaining_end_hours: 0, // done → forced 0 regardless anyway
      },
      {
        wp_op_id: 2,
        subject: "B",
        status_name: "In progress",
        status_is_closed: false,
        assignee_name: "Ann",
        planned_hours: 20,
        remaining_hours: 12,
        version_name: null,
        remaining_start_hours: 20,
        remaining_end_hours: 12, // burned 8h this sprint, still open
      },
    ];
    const split = buildClosureSplit(items, []);
    expect(split.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(split.not_done.map((d) => d.wp_op_id)).toEqual([2]);
    // 8 (done item's full burn) + 8 (open item's partial burn) = 16 — NOT the
    // old 8 (done items only).
    expect(split.completed_hours).toBe(16);
  });

  it("a re-estimate UP mid-sprint clamps an open item's burn at 0, never negative", () => {
    const items: ClosureInputItem[] = [
      {
        wp_op_id: 3,
        subject: "C",
        status_name: "In progress",
        status_is_closed: false,
        assignee_name: "Ann",
        planned_hours: 30,
        remaining_hours: 25,
        version_name: null,
        remaining_start_hours: 10, // started with 10h remaining...
        remaining_end_hours: 25, // ...re-estimated UP to 25h remaining
      },
    ];
    const split = buildClosureSplit(items, []);
    expect(split.completed_hours).toBe(0);
  });

  it("omitted remaining_start/end_hours reduces to the OLD sum exactly (invariant 11)", () => {
    const items: ClosureInputItem[] = [
      {
        wp_op_id: 1,
        subject: "A",
        status_name: "Closed",
        status_is_closed: true,
        assignee_name: "Ann",
        planned_hours: 8,
        remaining_hours: 0,
        version_name: null,
      },
      {
        wp_op_id: 2,
        subject: "B",
        status_name: "In progress",
        status_is_closed: false,
        assignee_name: "Ann",
        planned_hours: 4,
        remaining_hours: 4,
        version_name: null,
      },
    ];
    const split = buildClosureSplit(items, []);
    expect(split.completed_hours, "old rule: Σ planned_hours over DONE items only").toBe(8);
  });
});

describe("computeAndStoreClosureReport (SPEC_11 §8a)", () => {
  it("returns a report on an ACTIVE sprint WITHOUT locking it — repeatably", async () => {
    const sprintId = await seedActiveSprint();

    const first = await computeAndStoreClosureReport(repos, sprintId);
    expect(first.done.map((d) => d.wp_op_id)).toEqual([1001]);
    expect(first.not_done.map((d) => d.wp_op_id)).toEqual([1002]);

    let sprint = (await repos.sprints.getById(sprintId))!;
    expect(sprint.status).toBe("active");
    expect(sprint.is_locked).toBe(false);
    expect(sprint.locked_at).toBeNull();
    expect(sprint.closed_at).toBeNull();

    // Regenerate: still active, still unlocked, still returns a report.
    const second = await computeAndStoreClosureReport(repos, sprintId);
    expect(second.done.map((d) => d.wp_op_id)).toEqual([1001]);
    sprint = (await repos.sprints.getById(sprintId))!;
    expect(sprint.status).toBe("active");
    expect(sprint.is_locked).toBe(false);

    // Items are NOT mutated to done/carried while the sprint keeps running.
    const items = await repos.sprintItems.listBySprint(sprintId);
    expect(items.every((i) => i.outcome === "planned")).toBe(true);
  });
});

describe("performClosure (SPEC_04 — finish path only)", () => {
  it("locks the sprint (status=closed, is_locked, lock_reason) and stamps outcomes", async () => {
    const sprintId = await seedActiveSprint();
    const report = await performClosure(repos, sprintId, "2026-07-14T18:00:00Z", "finished");
    expect(report.done.map((d) => d.wp_op_id)).toEqual([1001]);

    const sprint = (await repos.sprints.getById(sprintId))!;
    expect(sprint.status).toBe("closed");
    expect(sprint.is_locked).toBe(true);
    expect(sprint.lock_reason).toBe("finished");
    expect(sprint.completed_hours).toBe(8);

    const items = await repos.sprintItems.listBySprint(sprintId);
    expect(items.find((i) => i.wp_op_id === 1001)!.outcome).toBe("done");
    expect(items.find((i) => i.wp_op_id === 1002)!.outcome).toBe("carried");
  });

  it("Increment 34 §1: completed_hours (velocity) is the DONE ticket's burned-remaining slice, not its flat estimate, when a ticket_baseline diverges (multi-sprint shape)", async () => {
    const sprint = await repos.sprints.create({
      name: "Multi-sprint tail",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    // A 150h ticket that already burned 100h in a PRIOR sprint — this sprint
    // started with only 50h remaining and finishes it.
    await repos.workPackages.upsertMany([
      {
        op_id: 2001,
        project_op_id: 100,
        project_name: null,
        subject: "Multi-sprint tail",
        type_name: "Task",
        status_name: "Closed",
        status_is_closed: true,
        assignee_op_id: 10,
        assignee_name: "Ann",
        estimated_hours: 150,
        remaining_hours: 0,
        spent_hours: null,
        story_points: null,
        version_op_id: null,
        version_name: null,
        priority: null,
        parent_op_id: null,
        percentage_done: null,
        updated_at_op: "2026-07-02T00:00:00Z",
        raw_json: "{}",
      },
    ]);
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 2001,
      planned_hours: 150,
      outcome: "planned",
      origin: "baseline",
    });
    await repos.ticketBaselines.upsertMany([
      {
        sprint_id: sprint.id,
        wp_op_id: 2001,
        captured_at: "2026-07-01T09:00:00Z",
        subject: "Multi-sprint tail",
        status_name: "In progress",
        status_is_closed: false,
        assignee_op_id: 10,
        accountable_op_id: null,
        original_assignee_op_id: 10,
        estimated_hours: 150,
        remaining_hours: 50, // ← the activation-time snapshot: 50h left
        spent_hours: null,
        version_op_id: null,
        raw_json: "{}",
        origin: "baseline",
        reconstructed: false,
        reconstruction_gaps_json: null,
        assignee_name_raw: "Ann",
      },
    ]);
    await repos.sprints.activate(sprint.id, "2026-07-01T09:00:00Z", 12);

    const report = await performClosure(repos, sprint.id, "2026-07-14T18:00:00Z", "finished");
    expect(report.done.map((d) => d.wp_op_id)).toEqual([2001]);

    const closed = (await repos.sprints.getById(sprint.id))!;
    // NOT 150 (the flat estimate/planned_hours) — this sprint only had 50h
    // left to burn, so velocity credits exactly that slice.
    expect(closed.completed_hours).toBe(50);
  });
});
