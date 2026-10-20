import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapacityResponse, ClosureStatsResponse, SprintResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type { OpStatus } from "@osp/op-client";
import { addConnection, buildTestApp, initVault, type TestApp } from "../test-utils";

/**
 * Increment 28 (INCREMENT_28_CONTRACTS §1a) — ONE estimate of record.
 *
 * `computeClosureStats` used to read `sprint_item.planned_hours`, the snapshot
 * frozen when the item was ADDED. An estimate that changed afterwards therefore
 * left the Capacity panel's "Planned" headline (`scope_planned_hours`),
 * Closure's totals and the GREEN BAR'S LENGTH (`segments[].estimate_hours`) on
 * the stale value, while `capacity.lines[].planned_hours` — computed from the
 * live `effectiveEstimate` — showed the new one. That is the reported symptom
 * ("the number appears in the list but the green bar stays old") and it is a
 * direct violation of the binding `docs/CAPACITY_BAR_RULES.md` §3.
 */

const STATUSES: OpStatus[] = [{ _type: "Status", id: 7, name: "In progress", isClosed: false }];

async function seedCache(
  repos: Repositories,
  id: number,
  o: { assignee: { id: number; name: string }; estimated: number | null; remaining?: number | null },
): Promise<void> {
  await repos.workPackages.upsertMany([
    {
      op_id: id,
      project_op_id: 100,
      subject: `WP ${id}`,
      type_name: "Task",
      status_name: "In progress",
      status_is_closed: false,
      assignee_op_id: o.assignee.id,
      assignee_name: o.assignee.name,
      estimated_hours: o.estimated,
      remaining_hours: o.remaining === undefined ? o.estimated : o.remaining,
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

describe("Increment 28 §1a — closure stats resolve the LIVE estimate of record", () => {
  let t: TestApp;
  let repos!: Repositories;

  beforeEach(async () => {
    t = await buildTestApp({
      opData: { statuses: STATUSES, workPackages: [], activitiesByWpId: {}, timeEntries: [] },
    });
    repos = t.repos;
    await initVault(t);
    await addConnection(t);
  });
  afterEach(async () => {
    await t.close();
  });

  /** Materialize the holder as a team_member and mark them a developer, so the
   * developerSegments engine (developers only) actually produces Planned. */
  async function makeDeveloper(name: string): Promise<void> {
    const people = (await t.app.inject({ method: "GET", url: "/api/people" })).json() as {
      id: number;
      name: string;
    }[];
    const person = people.find((p) => p.name === name);
    if (!person) throw new Error(`person ${name} not materialized`);
    await t.app.inject({
      method: "PUT",
      url: `/api/people/${person.id}/role`,
      payload: { role: "developer" },
    });
  }

  async function setup(): Promise<number> {
    await seedCache(repos, 1401, { assignee: { id: 1, name: "Dev Dvorak" }, estimated: 5 });
    const sprintId = SprintResponse.parse(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/sprints",
          payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
        })
      ).json(),
    ).id;
    await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items`,
      payload: { wp_op_id: 1401 },
    });
    await makeDeveloper("Dev Dvorak");
    return sprintId;
  }

  async function numbers(sprintId: number) {
    const cap = CapacityResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).json(),
    );
    const cs = ClosureStatsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/closure-stats` })).json(),
    );
    const barLengths = cs.per_developer.flatMap((d) =>
      d.segments.map((s) => s.estimate_hours ?? 0),
    );
    return {
      line: cap.lines.find((l) => l.op_user_id === 1)?.planned_hours,
      headline: cap.scope_planned_hours,
      closure: cs.total_planned_hours,
      bars: barLengths,
      frozenSnapshot: (await repos.sprintItems.getBySprintAndWp(sprintId, 1401))?.planned_hours,
    };
  }

  it("an override saved AFTER the item was added moves Planned and the bar, not just the line", async () => {
    const sprintId = await setup();
    const before = await numbers(sprintId);
    expect(before).toMatchObject({ line: 5, headline: 5, closure: 5, frozenSnapshot: 5 });
    expect(before.bars).toEqual([5]);

    await t.app.inject({
      method: "POST",
      url: "/api/estimate-override",
      payload: { wp_op_id: 1401, planning_hours: 40 },
    });

    const after = await numbers(sprintId);
    // The frozen add-time snapshot is deliberately NOT rewritten…
    expect(after.frozenSnapshot).toBe(5);
    // …yet every surface now reports the live estimate of record, together.
    expect(after.line).toBe(40);
    expect(after.headline).toBe(40);
    expect(after.closure).toBe(40);
    expect(after.bars).toEqual([40]); // CAPACITY_BAR_RULES §3 — bar length
  });

  it("an OP-side estimate change pulled into the cache moves the same numbers", async () => {
    const sprintId = await setup();
    // The ticket was worked down: Work 5 h, Remaining 3 h → effectiveEstimate 3.
    await seedCache(repos, 1401, {
      assignee: { id: 1, name: "Dev Dvorak" },
      estimated: 5,
      remaining: 3,
    });
    const after = await numbers(sprintId);
    expect(after.frozenSnapshot).toBe(5);
    expect(after).toMatchObject({ line: 3, headline: 3, closure: 3 });
    expect(after.bars).toEqual([3]);
  });

  it("untouched data is unchanged: no estimate change → the snapshot value everywhere", async () => {
    const sprintId = await setup();
    const n = await numbers(sprintId);
    expect(n).toMatchObject({ line: 5, headline: 5, closure: 5, frozenSnapshot: 5 });
    expect(n.bars).toEqual([5]);
  });

  it("falls back to the frozen snapshot when there is no live source at all", async () => {
    const sprintId = await setup();
    // Simulate an import-removal cascade that purged the cache row of a
    // still-planning sprint (no ticket_baseline exists yet either).
    await repos.workPackages.deleteMany([1401]);
    const cs = ClosureStatsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/closure-stats` })).json(),
    );
    const line = cs.per_ticket.find((p) => p.wp_op_id === 1401);
    expect(line?.estimate_hours).toBe(5);
  });
});
