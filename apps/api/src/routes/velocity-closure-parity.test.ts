import { describe, expect, it } from "vitest";
import { ClosureStatsResponse, VelocityResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type { SprintLifecycle } from "../logic/sprintUpdate";
import { freezeSprint } from "../logic/freeze";
import { buildTestApp } from "../test-utils";

/**
 * Increment 37 (docs/INCREMENT_37_CONTRACTS.md §2.4; CAPACITY_BAR_RULES §6
 * invariant 5 extension) — velocity-route-level unit tests for "Velocity
 * shows Closure's numbers": each history row must read the SAME
 * `computeClosureStats` totals Closure itself shows, and the per-connection
 * breakdown must sum EXACTLY to the row's `completed_hours`, by construction.
 *
 * `tests/src/velocity-golden.test.ts` (owned by the orchestrator, not
 * edited here) already covers the end-to-end RED→GREEN story; these tests
 * live in apps/api's own suite and additionally cover the dropped-credit and
 * frozen-sprint-stability cases the contract calls out by name.
 */

const DEV = { op: 931, name: "Parity Dev" };

/** A no-op-by-default fake SprintLifecycle — freezeSprint only ever calls
 * `.update()`; activate/finish are never used here. */
function fakeLifecycle(): SprintLifecycle {
  return {
    activate: async () => {
      throw new Error("not used by freeze");
    },
    update: async (sprintId, triggeredBy) => ({
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
    }),
    finish: async () => {
      throw new Error("not used by freeze");
    },
  };
}

async function seedDevAndTester(r: Repositories): Promise<void> {
  const dev = await r.teamMembers.upsert({
    op_user_id: DEV.op,
    name: DEV.name,
    default_hours_per_day: 8,
  });
  await r.teamMembers.setRole(dev.id, "developer");
}

/** A real connection row, inserted directly (no vault dance needed) — the
 * velocity route's `by_connection` breakdown needs a real, positive
 * `connection_id` to attach a work package to (LocalId rejects the `0`
 * fallback the route uses when no connection exists at all). */
async function seedConnection(r: Repositories): Promise<number> {
  const conn = await r.connections.create({
    base_url: "https://op.example.com",
    label: null,
    token_ct: null,
    token_nonce: null,
    token_tag: null,
    default_project_op_id: 100,
  });
  return conn.id;
}

describe("Increment 37 — GET /sprints/:id/velocity ≡ computeClosureStats (route level)", () => {
  it("row.planned_hours/completed_hours match closure-stats totals, and by_connection sums EXACTLY (invariant 5)", async () => {
    const t = await buildTestApp();
    try {
      await seedDevAndTester(t.repos);
      const connId = await seedConnection(t.repos);
      const closed = await t.repos.sprints.create({
        name: "Parity closed",
        start_date: "2026-06-01",
        end_date: "2026-06-14",
        status: "closed",
        capacity_mode: "per_person",
      });
      // Deliberately-wrong close-time bake — must not surface any more.
      await t.repos.sprints.close(closed.id, 999, "2026-06-14T18:00:00Z", "finished");

      await t.repos.workPackages.upsertMany([
        {
          connection_id: connId,
          op_id: 8001,
          project_op_id: 100,
          subject: "Done ticket",
          type_name: "Task",
          status_name: "Closed",
          status_is_closed: true,
          assignee_op_id: DEV.op,
          assignee_name: DEV.name,
          estimated_hours: 12,
          remaining_hours: 0,
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
      const run = await t.repos.sprintUpdateRuns.start(closed.id, "update", "manual");
      await t.repos.sprintItems.add({
        sprint_id: closed.id,
        wp_op_id: 8001,
        planned_hours: 12,
        outcome: "done",
        origin: "baseline",
      });
      await t.repos.ticketBaselines.upsertMany([
        {
          sprint_id: closed.id,
          wp_op_id: 8001,
          captured_at: "2026-06-01T09:00:00Z",
          subject: "Done ticket",
          status_name: "In progress",
          status_is_closed: false,
          assignee_op_id: DEV.op,
          accountable_op_id: null,
          original_assignee_op_id: DEV.op,
          estimated_hours: 12,
          remaining_hours: 12,
          spent_hours: null,
          version_op_id: null,
          raw_json: "{}",
          origin: "baseline",
          reconstructed: false,
          reconstruction_gaps_json: null,
          assignee_name_raw: DEV.name,
        },
      ]);
      await t.repos.ticketChangelog.insertMany([
        {
          sprint_id: closed.id,
          wp_op_id: 8001,
          update_run_id: run.id,
          occurred_at: "2026-06-02T12:00:00Z",
          actor_op_id: DEV.op,
          actor_name: DEV.name,
          kind: "time_logged",
          detail_json: JSON.stringify({ kind: "time_logged", hours: 12, spent_on: "2026-06-02" }),
          source: "time_entry",
          op_journal_id: null,
          dedup_key: `s${closed.id}:time_entry:parity-8001`,
        },
      ]);

      const viewer = await t.repos.sprints.create({
        name: "Viewer",
        start_date: "2026-07-01",
        end_date: "2026-07-14",
        status: "planning",
        capacity_mode: "per_person",
      });

      const closureRes = await t.app.inject({
        method: "GET",
        url: `/api/sprints/${closed.id}/closure-stats`,
      });
      expect(closureRes.statusCode).toBe(200);
      const closure = ClosureStatsResponse.parse(closureRes.json());

      const velRes = await t.app.inject({
        method: "GET",
        url: `/api/sprints/${viewer.id}/velocity`,
      });
      expect(velRes.statusCode).toBe(200);
      const vel = VelocityResponse.parse(velRes.json());
      const row = vel.history.find((h) => h.sprint_id === closed.id);
      expect(row, "closed sprint must appear in velocity history").toBeTruthy();

      expect(row!.planned_hours).toBeCloseTo(closure.total_planned_hours, 5);
      expect(row!.completed_hours).toBeCloseTo(closure.total_delivered_hours, 5);
      // Not the stale bake (999).
      expect(row!.completed_hours).not.toBeCloseTo(999, 5);

      const breakdownSum = row!.by_connection.reduce((s, b) => s + b.completed_hours, 0);
      expect(breakdownSum).toBeCloseTo(row!.completed_hours, 5);
    } finally {
      await t.close();
    }
  });

  it("a dropped-credit burn (unassigned + unlogged, baseline remaining > live remaining) is absent from the partition and the row still balances", async () => {
    const t = await buildTestApp();
    try {
      await seedDevAndTester(t.repos);
      const connId = await seedConnection(t.repos);
      const closed = await t.repos.sprints.create({
        name: "Parity dropped",
        start_date: "2026-06-01",
        end_date: "2026-06-14",
        status: "closed",
        capacity_mode: "per_person",
      });
      await t.repos.sprints.close(closed.id, 0, "2026-06-14T18:00:00Z", "finished");

      await t.repos.workPackages.upsertMany([
        // Credited: dev-held, done.
        {
          connection_id: connId,
          op_id: 8101,
          project_op_id: 100,
          subject: "Credited done ticket",
          type_name: "Task",
          status_name: "Closed",
          status_is_closed: true,
          assignee_op_id: DEV.op,
          assignee_name: DEV.name,
          estimated_hours: 6,
          remaining_hours: 0,
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
        // Dropped: unassigned, open, no logger — but its remaining shrank
        // since baseline (10 → 4), so it burned 6h nobody can be credited for.
        {
          connection_id: null,
          op_id: 8102,
          project_op_id: 100,
          subject: "Dropped burn ticket",
          type_name: "Task",
          status_name: "In progress",
          status_is_closed: false,
          assignee_op_id: null,
          assignee_name: null,
          estimated_hours: 10,
          remaining_hours: 4,
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
      const run = await t.repos.sprintUpdateRuns.start(closed.id, "update", "manual");
      await t.repos.sprintItems.add({
        sprint_id: closed.id,
        wp_op_id: 8101,
        planned_hours: 6,
        outcome: "done",
        origin: "baseline",
      });
      await t.repos.sprintItems.add({
        sprint_id: closed.id,
        wp_op_id: 8102,
        planned_hours: 10,
        outcome: "carried",
        origin: "baseline",
      });
      await t.repos.ticketBaselines.upsertMany([
        {
          sprint_id: closed.id,
          wp_op_id: 8101,
          captured_at: "2026-06-01T09:00:00Z",
          subject: "Credited done ticket",
          status_name: "In progress",
          status_is_closed: false,
          assignee_op_id: DEV.op,
          accountable_op_id: null,
          original_assignee_op_id: DEV.op,
          estimated_hours: 6,
          remaining_hours: 6,
          spent_hours: null,
          version_op_id: null,
          raw_json: "{}",
          origin: "baseline",
          reconstructed: false,
          reconstruction_gaps_json: null,
          assignee_name_raw: DEV.name,
        },
        {
          sprint_id: closed.id,
          wp_op_id: 8102,
          captured_at: "2026-06-01T09:00:00Z",
          subject: "Dropped burn ticket",
          status_name: "New",
          status_is_closed: false,
          assignee_op_id: null,
          accountable_op_id: null,
          original_assignee_op_id: null,
          estimated_hours: 10,
          remaining_hours: 10,
          spent_hours: null,
          version_op_id: null,
          raw_json: "{}",
          origin: "baseline",
          reconstructed: false,
          reconstruction_gaps_json: null,
          assignee_name_raw: null,
        },
      ]);
      await t.repos.ticketChangelog.insertMany([
        {
          sprint_id: closed.id,
          wp_op_id: 8101,
          update_run_id: run.id,
          occurred_at: "2026-06-02T12:00:00Z",
          actor_op_id: DEV.op,
          actor_name: DEV.name,
          kind: "time_logged",
          detail_json: JSON.stringify({ kind: "time_logged", hours: 6, spent_on: "2026-06-02" }),
          source: "time_entry",
          op_journal_id: null,
          dedup_key: `s${closed.id}:time_entry:parity-8101`,
        },
      ]);

      const viewer = await t.repos.sprints.create({
        name: "Viewer",
        start_date: "2026-07-01",
        end_date: "2026-07-14",
        status: "planning",
        capacity_mode: "per_person",
      });

      const closureRes = await t.app.inject({
        method: "GET",
        url: `/api/sprints/${closed.id}/closure-stats`,
      });
      const closure = ClosureStatsResponse.parse(closureRes.json());
      // Sanity: the dropped ticket's 6h burn does NOT inflate Delivered —
      // only the credited ticket's 6h estimate counts.
      expect(closure.total_delivered_hours).toBeCloseTo(6, 5);

      const velRes = await t.app.inject({
        method: "GET",
        url: `/api/sprints/${viewer.id}/velocity`,
      });
      const vel = VelocityResponse.parse(velRes.json());
      const row = vel.history.find((h) => h.sprint_id === closed.id)!;

      expect(row.completed_hours).toBeCloseTo(closure.total_delivered_hours, 5);
      expect(row.completed_hours).toBeCloseTo(6, 5);
      const breakdownSum = row.by_connection.reduce((s, b) => s + b.completed_hours, 0);
      expect(breakdownSum).toBeCloseTo(row.completed_hours, 5);
    } finally {
      await t.close();
    }
  });

  it("a FROZEN sprint's velocity row is IDENTICAL before and after its work_package_cache rows are deleted (invariant 10)", async () => {
    const t = await buildTestApp();
    try {
      await seedDevAndTester(t.repos);
      const connId = await seedConnection(t.repos);
      const closed = await t.repos.sprints.create({
        name: "Parity frozen",
        start_date: "2026-06-01",
        end_date: "2026-06-14",
        status: "active",
        capacity_mode: "per_person",
      });
      await t.repos.workPackages.upsertMany([
        {
          connection_id: connId,
          op_id: 8201,
          project_op_id: 100,
          subject: "Frozen done ticket",
          type_name: "Task",
          status_name: "Closed",
          status_is_closed: true,
          assignee_op_id: DEV.op,
          assignee_name: DEV.name,
          estimated_hours: 9,
          remaining_hours: 0,
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
      const run = await t.repos.sprintUpdateRuns.start(closed.id, "update", "manual");
      await t.repos.sprintItems.add({
        sprint_id: closed.id,
        wp_op_id: 8201,
        planned_hours: 9,
        outcome: "planned",
        origin: "baseline",
      });
      await t.repos.ticketBaselines.upsertMany([
        {
          sprint_id: closed.id,
          wp_op_id: 8201,
          captured_at: "2026-06-01T09:00:00Z",
          subject: "Frozen done ticket",
          status_name: "In progress",
          status_is_closed: false,
          assignee_op_id: DEV.op,
          accountable_op_id: null,
          original_assignee_op_id: DEV.op,
          estimated_hours: 9,
          remaining_hours: 9,
          spent_hours: null,
          version_op_id: null,
          raw_json: "{}",
          origin: "baseline",
          reconstructed: false,
          reconstruction_gaps_json: null,
          assignee_name_raw: DEV.name,
        },
      ]);
      await t.repos.ticketChangelog.insertMany([
        {
          sprint_id: closed.id,
          wp_op_id: 8201,
          update_run_id: run.id,
          occurred_at: "2026-06-02T12:00:00Z",
          actor_op_id: DEV.op,
          actor_name: DEV.name,
          kind: "time_logged",
          detail_json: JSON.stringify({ kind: "time_logged", hours: 9, spent_on: "2026-06-02" }),
          source: "time_entry",
          op_journal_id: null,
          dedup_key: `s${closed.id}:time_entry:parity-8201`,
        },
      ]);
      await t.repos.sprints.close(closed.id, 0, "2026-06-14T18:00:00Z", "finished");
      await freezeSprint(
        { repos: t.repos, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-15T00:00:05Z") },
        closed.id,
      );
      const frozen = await t.repos.sprints.getById(closed.id);
      expect(frozen?.frozen_at).not.toBeNull();

      const viewer = await t.repos.sprints.create({
        name: "Viewer",
        start_date: "2026-07-01",
        end_date: "2026-07-14",
        status: "planning",
        capacity_mode: "per_person",
      });

      const before = VelocityResponse.parse(
        (
          await t.app.inject({ method: "GET", url: `/api/sprints/${viewer.id}/velocity` })
        ).json(),
      );
      const rowBefore = before.history.find((h) => h.sprint_id === closed.id)!;
      expect(rowBefore).toBeTruthy();

      // Import cleanup: delete the live cache row outright — a frozen
      // sprint's numbers must not move (CAPACITY_BAR_RULES §6 invariant 10).
      await t.repos.workPackages.deleteMany([8201]);

      const after = VelocityResponse.parse(
        (
          await t.app.inject({ method: "GET", url: `/api/sprints/${viewer.id}/velocity` })
        ).json(),
      );
      const rowAfter = after.history.find((h) => h.sprint_id === closed.id)!;

      expect(rowAfter.planned_hours).toBe(rowBefore.planned_hours);
      expect(rowAfter.completed_hours).toBe(rowBefore.completed_hours);
      expect(rowAfter.by_connection).toEqual(rowBefore.by_connection);
    } finally {
      await t.close();
    }
  });
});
