import { afterEach, describe, expect, it } from "vitest";
import type { Repositories } from "@osp/db";
import type { ClosureStatsResponse, VelocityResponse } from "@osp/contracts";
import { bootRealApp, call, rawQuery, type RealApp } from "./harness";

/**
 * GOLDEN TESTS — Increment 37: Velocity shows Closure's numbers
 * (docs/INCREMENT_37_CONTRACTS.md §4; CAPACITY_BAR_RULES §6 invariant 5,
 * Increment-37 extension).
 *
 * The user-visible bug these encode (real data, 2026-09-01): Atlas.Core 3.6.001
 * showed Planned 353.7 h / Completed 120 h on Velocity but Planned 171 h /
 * Delivered 206.5 h on Closure — Velocity read Σ ALL leaf estimates and the
 * close-time bake instead of Closure's own totals; sprint 3.5.041's breakdown
 * (13.5 h) didn't even sum to its displayed total (12 h).
 *
 * Written BEFORE the implementation: RED until Agent A lands. PGlite only.
 */

const DEV = { op: 931, name: "Velocity Dev" };
const TESTER = { op: 932, name: "Velocity Tester" };
const DEV_WP = 9801; // dev-held, done, burned 10h
const TESTER_WP = 9802; // tester-held, done — in old leaf-planned, NOT in closure Planned

async function seedClosedSprint(r: Repositories, raw: RealApp["raw"]): Promise<number> {
  for (const [p, role] of [
    [DEV, "developer"],
    [TESTER, "tester"],
  ] as const) {
    const m = await r.teamMembers.upsert({ op_user_id: p.op, name: p.name, default_hours_per_day: 8 });
    await r.teamMembers.setRole(m.id, role);
  }

  const sprint = await r.sprints.create({
    name: "Velocity golden",
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    status: "closed",
    capacity_mode: "per_person",
  });
  // Bake a DELIBERATELY WRONG close-time completed figure — the view must not
  // show it any more (it used to be the whole bug).
  await rawQuery(raw, `UPDATE sprint SET completed_hours = 999 WHERE id = ${sprint.id}`);

  const people = { [DEV_WP]: DEV, [TESTER_WP]: TESTER } as const;
  await r.workPackages.upsertMany(
    [DEV_WP, TESTER_WP].map((op) => ({
      connection_id: null,
      op_id: op,
      project_op_id: 100,
      project_name: null,
      subject: `WP ${op}`,
      type_name: "Task",
      status_name: "Closed",
      status_is_closed: true,
      assignee_op_id: people[op as keyof typeof people].op,
      assignee_name: people[op as keyof typeof people].name,
      estimated_hours: op === DEV_WP ? 10 : 6,
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
    })),
  );
  const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
  for (const op of [DEV_WP, TESTER_WP]) {
    const person = people[op as keyof typeof people];
    const est = op === DEV_WP ? 10 : 6;
    await r.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: op,
      planned_hours: est,
      outcome: "done",
      origin: "baseline",
    });
    await r.ticketBaselines.upsertMany([
      {
        sprint_id: sprint.id,
        wp_op_id: op,
        captured_at: "2026-06-01T09:00:00Z",
        subject: `WP ${op}`,
        status_name: "In progress",
        status_is_closed: false,
        assignee_op_id: person.op,
        accountable_op_id: null,
        original_assignee_op_id: person.op,
        estimated_hours: est,
        remaining_hours: est,
        spent_hours: null,
        version_op_id: null,
        raw_json: "{}",
        origin: "baseline",
        reconstructed: false,
        reconstruction_gaps_json: null,
        assignee_name_raw: person.name,
      },
    ]);
  }
  // Dev logs inside the window so the done-ticket credit lands on the developer.
  await r.ticketChangelog.insertMany([
    {
      sprint_id: sprint.id,
      wp_op_id: DEV_WP,
      update_run_id: run.id,
      occurred_at: "2026-06-02T12:00:00Z",
      actor_op_id: DEV.op,
      actor_name: DEV.name,
      kind: "time_logged",
      detail_json: JSON.stringify({ kind: "time_logged", hours: 9, spent_on: "2026-06-02" }),
      source: "time_entry",
      op_journal_id: null,
      dedup_key: `s${sprint.id}:time_entry:vel-${DEV_WP}`,
    },
  ]);
  return sprint.id;
}

describe("GOLDEN Increment 37 — Velocity ≡ Closure (invariant 5)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("a closed sprint's velocity row shows Closure's Planned and Delivered, and the breakdown sums exactly (today: leaf-planned + the stale bake)", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    const closedId = await seedClosedSprint(r, harness.raw);
    const viewer = await r.sprints.create({
      name: "Viewer",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });

    const closureRes = await call(harness.app, "GET", `/api/sprints/${closedId}/closure-stats`);
    expect(closureRes.status).toBe(200);
    const closure = closureRes.json as ClosureStatsResponse;
    // Sanity on the seed itself: the tester-held ticket keeps Closure Planned
    // (developers' current scope) strictly below the old all-items leaf sum.
    expect(closure.total_planned_hours).toBeCloseTo(10, 5);
    expect(closure.total_delivered_hours).toBeCloseTo(10, 5);

    const velRes = await call(harness.app, "GET", `/api/sprints/${viewer.id}/velocity`);
    expect(velRes.status).toBe(200);
    const vel = velRes.json as VelocityResponse;
    const row = vel.history.find((h) => h.sprint_id === closedId);
    expect(row, "closed sprint must appear in velocity history").toBeTruthy();

    // 1. Planned ≡ Closure's Planned header (NOT Σ all leaf estimates = 16).
    expect(row!.planned_hours).toBeCloseTo(closure.total_planned_hours, 5);
    // 2. Completed ≡ Closure's Delivered header (NOT the baked 999).
    expect(row!.completed_hours).toBeCloseTo(closure.total_delivered_hours, 5);
    // 3. The per-connection breakdown partitions the displayed figure EXACTLY.
    const breakdownSum = row!.by_connection.reduce((s, b) => s + b.completed_hours, 0);
    expect(breakdownSum).toBeCloseTo(row!.completed_hours, 5);
  });
});
