import { openDb } from "@osp/db";
import type { NewTicketBaseline, NewWorkPackageCache, Repositories } from "@osp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SprintLifecycle } from "./sprintUpdate";
import { performClosure, refreshClosureArtifacts } from "./closure";
import { computeClosureStats } from "./closureStats";
import { freezeDeadline, freezeSprint } from "./freeze";

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b/§6) — freeze engine unit
 * tests, PGlite (ephemeral, in-process — no real DB, per the repo-root
 * guardrail; `openDb({ ephemeral: true })` never touches Postgres at all).
 */

function wp(p: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: p.connection_id ?? null,
    op_id: p.op_id,
    project_op_id: 100,
    project_name: null,
    subject: p.subject ?? `WP ${p.op_id}`,
    type_name: "Task",
    status_name: p.status_name ?? "New",
    status_is_closed: p.status_is_closed ?? false,
    assignee_op_id: p.assignee_op_id ?? null,
    assignee_name: p.assignee_name ?? null,
    estimated_hours: p.estimated_hours ?? null,
    remaining_hours: p.remaining_hours ?? null,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: null,
    parent_op_id: p.parent_op_id ?? null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
  };
}

/** A no-op-by-default fake SprintLifecycle — freezeSprint only ever calls
 * `.update()`; activate/finish are never used. */
function fakeLifecycle(update?: SprintLifecycle["update"]): SprintLifecycle {
  return {
    activate: vi.fn(async () => {
      throw new Error("not used by freeze");
    }),
    update:
      update ??
      (async (sprintId, triggeredBy) => ({
        id: 1,
        sprint_id: sprintId,
        kind: "update",
        triggered_by: triggeredBy,
        started_at: "2026-06-20T00:00:00Z",
        finished_at: "2026-06-20T00:00:01Z",
        wp_count: 0,
        total_count: 0,
        changes_count: 0,
        status: "success",
        error: null,
      })),
    finish: vi.fn(async () => {
      throw new Error("not used by freeze");
    }),
  };
}

describe("freezeDeadline — pure end-of-local-day math", () => {
  it("adds graceDays to locked_at's LOCAL calendar day, landing at 23:59:59.999 local", () => {
    // locked_at is a UTC instant; the deadline must be computed off its LOCAL
    // date, then formatted back to an ISO instant (Z-suffixed) — comparable
    // lexicographically/numerically with any other ISO instant.
    const deadline = freezeDeadline("2026-07-01T08:00:00.000Z", 3);
    const expected = new Date(2026, 6, 4, 23, 59, 59, 999); // local July 4th
    expect(new Date(deadline).getTime()).toBe(expected.getTime());
  });

  it("graceDays = 0 lands at the end of locked_at's OWN local day", () => {
    const deadline = freezeDeadline("2026-07-10T12:00:00.000Z", 0);
    const expected = new Date(2026, 6, 10, 23, 59, 59, 999);
    expect(new Date(deadline).getTime()).toBe(expected.getTime());
  });

  it("is monotonic in graceDays", () => {
    const d0 = new Date(freezeDeadline("2026-01-01T00:00:00.000Z", 0)).getTime();
    const d5 = new Date(freezeDeadline("2026-01-01T00:00:00.000Z", 5)).getTime();
    const d60 = new Date(freezeDeadline("2026-01-01T00:00:00.000Z", 60)).getTime();
    expect(d0).toBeLessThan(d5);
    expect(d5).toBeLessThan(d60);
  });
});

describe("freezeSprint — snapshot correctness", () => {
  let db: Awaited<ReturnType<typeof openDb>>;
  let repos: Repositories;
  let sprintId: number;

  beforeEach(async () => {
    db = await openDb({ ephemeral: true });
    repos = db.repositories;
    const sprint = await repos.sprints.create({
      name: "Freeze Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    sprintId = sprint.id;

    await repos.workPackages.upsertMany([
      // wp1: live cache row, plain estimate.
      wp({ op_id: 1, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8, status_name: "In progress" }),
      // wp2: live cache row, an estimate override applies (should win).
      wp({ op_id: 2, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 5, status_name: "In progress" }),
      // wp3: live cache row with a parent edge (leaf double-count guard input).
      wp({ op_id: 3, assignee_op_id: 20, assignee_name: "Dev Two", estimated_hours: 4, parent_op_id: 99, status_name: "New" }),
      // wp4: to be DELETED before freeze — snapshot must fall back to baseline.
      wp({ op_id: 4, assignee_op_id: 20, assignee_name: "Dev Two", estimated_hours: 6, status_name: "Tested", status_is_closed: true }),
    ]);
    await repos.estimateOverrides.upsert({ wp_op_id: 2, planning_hours: 12, note: null });

    for (const [wpId, hrs] of [[1, 8], [2, 5], [3, 4], [4, 6]] as const) {
      await repos.sprintItems.add({
        sprint_id: sprintId,
        wp_op_id: wpId,
        planned_hours: hrs,
        outcome: "planned",
        origin: "baseline",
      });
    }
    const baseline = (wpId: number, hrs: number): NewTicketBaseline => ({
      sprint_id: sprintId,
      wp_op_id: wpId,
      captured_at: "2026-06-01T09:00:00Z",
      subject: `WP ${wpId}`,
      status_name: "Tested",
      status_is_closed: true,
      assignee_op_id: 20,
      accountable_op_id: null,
      original_assignee_op_id: 20,
      estimated_hours: hrs,
      remaining_hours: null,
      spent_hours: null,
      version_op_id: null,
      raw_json: "{}",
      origin: "baseline",
      reconstructed: false,
      reconstruction_gaps_json: null,
      assignee_name_raw: "Dev Two",
    });
    // wp4 gets a baseline row too — the fallback source once its cache row
    // is deleted below.
    await repos.ticketBaselines.upsertMany([baseline(4, 6)]);

    // Simulate a closed+locked sprint (freeze always follows a finish).
    await repos.sprints.close(sprintId, 0, "2026-06-20T00:00:00Z", "finished");

    // wp4's cache row is gone BEFORE freeze runs — the exact "Import cleanup
    // already ran during grace" scenario freeze's baseline fallback exists for.
    await repos.workPackages.deleteMany([4]);
  });

  it("snapshots effective_hours via the SAME resolution closureStats uses (incl. overrides), falling back to the baseline when the cache row is gone", async () => {
    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);

    const snapshot = await repos.sprintItems.listFrozenSnapshot(sprintId);
    const byWp = new Map(snapshot.map((s) => [s.wp_op_id, s]));

    expect(byWp.get(1)?.frozen_effective_hours).toBe(8); // plain estimate
    expect(byWp.get(2)?.frozen_effective_hours).toBe(12); // override wins
    expect(byWp.get(3)?.frozen_effective_hours).toBe(4);
    expect(byWp.get(4)?.frozen_effective_hours).toBe(6); // baseline fallback (cache gone)
  });

  it("Increment 34 §4: snapshots frozen_remaining_hours from the live cache, falling back to the baseline", async () => {
    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);

    const snapshot = await repos.sprintItems.listFrozenSnapshot(sprintId);
    const byWp = new Map(snapshot.map((s) => [s.wp_op_id, s]));

    // wp1/wp2/wp3: no remaining_hours set on their live cache row (wp() helper
    // defaults it to null) and no ticket_baseline of their own → null.
    expect(byWp.get(1)?.frozen_remaining_hours).toBeNull();
    // wp4: cache row is gone (deleted in beforeEach) → falls back to the
    // baseline, whose remaining_hours is also null in this fixture.
    expect(byWp.get(4)?.frozen_remaining_hours).toBeNull();
  });

  it("Increment 34 — accepts nowIso/log in place of now (freeze deps flexibility)", async () => {
    const messages: string[] = [];
    await freezeSprint(
      {
        repos,
        sprintLifecycle: fakeLifecycle(async () => {
          throw new Error("simulated outage");
        }),
        now: () => {
          throw new Error("must not be called when nowIso is supplied");
        },
        nowIso: () => "2026-06-20T00:00:05.000Z",
        log: (m) => messages.push(m),
      },
      sprintId,
    );
    const after = await repos.sprints.getById(sprintId);
    expect(after?.frozen_at).toBe("2026-06-20T00:00:05.000Z");
    expect(messages.some((m) => m.includes("simulated outage"))).toBe(true);
  });

  it("snapshots assignee/status/parent/connection from the live cache, falling back to the baseline", async () => {
    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);

    const snapshot = await repos.sprintItems.listFrozenSnapshot(sprintId);
    const byWp = new Map(snapshot.map((s) => [s.wp_op_id, s]));

    expect(byWp.get(3)).toMatchObject({
      frozen_assignee_op_id: 20,
      frozen_assignee_name: "Dev Two",
      frozen_status_name: "New",
      frozen_status_is_closed: false,
      frozen_parent_op_id: 99,
    });
    // wp4: cache row gone → falls back to the baseline's assignee/status.
    expect(byWp.get(4)).toMatchObject({
      frozen_assignee_op_id: 20,
      frozen_assignee_name: "Dev Two",
      frozen_status_name: "Tested",
      frozen_status_is_closed: true,
    });
  });

  it("sets sprint.frozen_at (last, after the snapshot already exists)", async () => {
    const before = await repos.sprints.getById(sprintId);
    expect(before?.frozen_at).toBeNull();

    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);

    const after = await repos.sprints.getById(sprintId);
    expect(after?.frozen_at).toBe("2026-06-20T00:00:05.000Z");
  });

  it("re-bakes closure artifacts (outcome baking) as part of freezing", async () => {
    // Before freeze, every item is still outcome "planned" (closure() was
    // never separately called in this test's setup — only sprints.close()).
    const before = await repos.sprintItems.listBySprint(sprintId);
    expect(before.every((i) => i.outcome === "planned")).toBe(true);

    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);

    const after = await repos.sprintItems.listBySprint(sprintId);
    const byWp = new Map(after.map((i) => [i.wp_op_id, i]));
    // Every item here has an OPEN cache status at freeze time (wp1/wp2/wp3 are
    // "In progress"/"New"; wp4's cache row was already deleted in beforeEach,
    // and refreshClosureArtifacts' outcome classification reads the LIVE
    // cache only — no baseline fallback, unrelated pre-existing behavior of
    // buildClosureData/closure.ts — so an absent row defaults to "open" too)
    // → every item bakes to "carried", none to "done".
    expect(byWp.get(1)?.outcome).toBe("carried");
    expect(byWp.get(2)?.outcome).toBe("carried");
    expect(byWp.get(3)?.outcome).toBe("carried");
    expect(byWp.get(4)?.outcome).toBe("carried");
  });

  it("a failing final update is best-effort — freezing still completes (OP outage must not block it)", async () => {
    const failingUpdate: SprintLifecycle["update"] = async () => {
      throw new Error("simulated OP outage");
    };
    await freezeSprint(
      { repos, sprintLifecycle: fakeLifecycle(failingUpdate), now: () => new Date("2026-06-20T00:00:05Z") },
      sprintId,
    );

    const after = await repos.sprints.getById(sprintId);
    expect(after?.frozen_at).not.toBeNull();
    const snapshot = await repos.sprintItems.listFrozenSnapshot(sprintId);
    expect(snapshot.some((s) => s.frozen_effective_hours != null)).toBe(true);
  });

  it("does not snapshot removed / removed_mid_sprint items", async () => {
    const items = await repos.sprintItems.listBySprint(sprintId);
    const wp1Item = items.find((i) => i.wp_op_id === 1)!;
    await repos.sprintItems.setOutcome(wp1Item.id, "removed_mid_sprint", "2026-06-10T00:00:00Z");

    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);

    const snapshot = await repos.sprintItems.listFrozenSnapshot(sprintId);
    const wp1Snapshot = snapshot.find((s) => s.wp_op_id === 1);
    expect(wp1Snapshot?.frozen_effective_hours).toBeNull();
  });

  it("a frozen sprint's computeClosureStats numbers survive the live cache being mutated and then deleted (CAPACITY_BAR_RULES §6 invariant 10)", async () => {
    await freezeSprint({ repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") }, sprintId);
    const before = await computeClosureStats(repos, sprintId, "2026-06-21T00:00:00Z");

    // (a) mutate the live cache rows that still exist.
    await repos.workPackages.upsertMany([
      wp({ op_id: 1, assignee_op_id: 99, assignee_name: "Someone Else", estimated_hours: 999, status_name: "Rejected" }),
      wp({ op_id: 2, assignee_op_id: 99, assignee_name: "Someone Else", estimated_hours: 999, status_name: "Rejected" }),
      wp({ op_id: 3, assignee_op_id: 99, assignee_name: "Someone Else", estimated_hours: 999, status_name: "Rejected" }),
    ]);
    const afterMutate = await computeClosureStats(repos, sprintId, "2026-06-21T00:00:00Z");
    expect(afterMutate.total_planned_hours).toBe(before.total_planned_hours);
    expect(afterMutate.per_ticket).toEqual(before.per_ticket);

    // (b) delete every remaining cache row outright (Import cleanup — Increment 31 §3
    // no longer protects a frozen sprint's tickets).
    await repos.workPackages.deleteMany([1, 2, 3]);
    const afterDelete = await computeClosureStats(repos, sprintId, "2026-06-21T00:00:00Z");
    expect(afterDelete.total_planned_hours).toBe(before.total_planned_hours);
    expect(afterDelete.per_ticket).toEqual(before.per_ticket);
  });
});

describe("Increment 34 §4 — frozen_remaining_hours snapshots a real non-null value", () => {
  it("snapshots the live remaining hours, and reactivate clears it again", async () => {
    const db = await openDb({ ephemeral: true });
    const repos = db.repositories;
    const sprint = await repos.sprints.create({
      name: "Remaining Snapshot Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    await repos.workPackages.upsertMany([
      wp({ op_id: 1, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 150, remaining_hours: 100, status_name: "In progress" }),
    ]);
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 1,
      planned_hours: 150,
      outcome: "planned",
      origin: "baseline",
    });
    await repos.sprints.close(sprint.id, 0, "2026-06-20T00:00:00Z", "finished");

    await freezeSprint(
      { repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") },
      sprint.id,
    );
    const snapshot = await repos.sprintItems.listFrozenSnapshot(sprint.id);
    expect(snapshot[0]?.frozen_remaining_hours).toBe(100);

    await repos.sprints.reactivate(sprint.id);
    const afterReactivate = await repos.sprintItems.listFrozenSnapshot(sprint.id);
    expect(afterReactivate[0]?.frozen_remaining_hours).toBeNull();
  });
});

describe("reactivate clears the freeze + snapshot", () => {
  it("nulls frozen_at AND every sprint_item.frozen_* column", async () => {
    const db = await openDb({ ephemeral: true });
    const repos = db.repositories;
    const sprint = await repos.sprints.create({
      name: "Reactivate Test",
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      status: "active",
      capacity_mode: "per_person",
    });
    await repos.workPackages.upsertMany([
      wp({ op_id: 1, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 }),
    ]);
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 1,
      planned_hours: 8,
      outcome: "planned",
      origin: "baseline",
    });
    await repos.sprints.close(sprint.id, 0, "2026-06-20T00:00:00Z", "finished");
    await freezeSprint(
      { repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-25T00:00:00Z") },
      sprint.id,
    );

    const frozen = await repos.sprints.getById(sprint.id);
    expect(frozen?.frozen_at).not.toBeNull();
    const snapshotBefore = await repos.sprintItems.listFrozenSnapshot(sprint.id);
    expect(snapshotBefore[0]?.frozen_effective_hours).not.toBeNull();

    await repos.sprints.reactivate(sprint.id);

    const reactivated = await repos.sprints.getById(sprint.id);
    expect(reactivated?.frozen_at).toBeNull();
    expect(reactivated?.is_locked).toBe(false);
    const snapshotAfter = await repos.sprintItems.listFrozenSnapshot(sprint.id);
    expect(snapshotAfter[0]).toMatchObject({
      frozen_effective_hours: null,
      frozen_assignee_op_id: null,
      frozen_assignee_name: null,
      frozen_status_name: null,
      frozen_status_is_closed: null,
      frozen_parent_op_id: null,
      frozen_connection_id: null,
    });
  });
});

describe("refreshClosureArtifacts extraction — performClosure stays byte-identical for existing callers", () => {
  it("performClosure = refreshClosureArtifacts + close, same outcome/report as before the split", async () => {
    const db = await openDb({ ephemeral: true });
    const repos = db.repositories;
    const sprint = await repos.sprints.create({
      name: "Extraction Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    await repos.workPackages.upsertMany([
      wp({ op_id: 1, status_name: "Tested", status_is_closed: true, estimated_hours: 5 }),
      wp({ op_id: 2, status_name: "In progress", estimated_hours: 3 }),
    ]);
    for (const [wpId, hrs] of [[1, 5], [2, 3]] as const) {
      await repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }

    const result = await performClosure(repos, sprint.id, "2026-06-15T00:00:00Z", "finished");

    expect(result.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(result.not_done.map((d) => d.wp_op_id)).toEqual([2]);
    const closedSprint = await repos.sprints.getById(sprint.id);
    expect(closedSprint?.status).toBe("closed");
    expect(closedSprint?.is_locked).toBe(true);
    expect(closedSprint?.completed_hours).toBe(5);

    const items = await repos.sprintItems.listBySprint(sprint.id);
    expect(items.find((i) => i.wp_op_id === 1)?.outcome).toBe("done");
    expect(items.find((i) => i.wp_op_id === 2)?.outcome).toBe("carried");
  });

  it("refreshClosureArtifacts alone bakes outcomes + the report WITHOUT closing/locking the sprint", async () => {
    const db = await openDb({ ephemeral: true });
    const repos = db.repositories;
    const sprint = await repos.sprints.create({
      name: "Refresh Only Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    await repos.workPackages.upsertMany([
      wp({ op_id: 1, status_name: "Tested", status_is_closed: true, estimated_hours: 5 }),
    ]);
    await repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 5, outcome: "planned", origin: "baseline" });

    const { report, completed_hours } = await refreshClosureArtifacts(repos, sprint.id, "2026-06-15T00:00:00Z");

    expect(report.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(completed_hours).toBe(5);
    const stillOpen = await repos.sprints.getById(sprint.id);
    expect(stillOpen?.status).toBe("active"); // NOT closed
    expect(stillOpen?.is_locked).toBe(false); // NOT locked
    const items = await repos.sprintItems.listBySprint(sprint.id);
    expect(items[0]?.outcome).toBe("done"); // outcome WAS baked
  });
});

describe("report_config — freeze_grace_days round-trip (Increment 31 §1/§3)", () => {
  it("get()/setFreezeGraceDays() round-trip, defaulting to 3", async () => {
    const db = await openDb({ ephemeral: true });
    const repos = db.repositories;

    const initial = await repos.reportConfig.get();
    expect(initial.freeze_grace_days).toBe(3);
    expect(initial.overshoot_threshold_pct).toBe(25);

    const updated = await repos.reportConfig.setFreezeGraceDays(10);
    expect(updated.freeze_grace_days).toBe(10);
    // setOvershootThresholdPct is independent — round-trips without disturbing
    // the freeze_grace_days just set.
    const updated2 = await repos.reportConfig.setOvershootThresholdPct(40);
    expect(updated2.overshoot_threshold_pct).toBe(40);
    expect(updated2.freeze_grace_days).toBe(10);

    const final = await repos.reportConfig.get();
    expect(final).toMatchObject({ freeze_grace_days: 10, overshoot_threshold_pct: 40 });
  });
});
