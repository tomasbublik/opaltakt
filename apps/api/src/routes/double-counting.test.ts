import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CapacityResponse,
  DoubleCountFixResponse,
  ErrorResponse,
  SprintItemsDetailedResponse,
  SprintResponse,
} from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type { OpStatus } from "@osp/op-client";
import { addConnection, buildTestApp, initVault, type TestApp } from "../test-utils";

/**
 * Increment 28 (INCREMENT_28_CONTRACTS §2a/§2b/§2c) — parent/child double
 * counting inside ONE sprint: ancestor-aware detection on the items DTO, the
 * suppressed parent keeping its capacity line at 0 h, and the two bulk fixes.
 *
 * The base fixture is the exact §0c reproduction measured in Phase 0:
 * WP 1001 (Ada Lovelace, parent) + WP 1002 (Grace Hopper, child of 1001), 4 h
 * each, in a plain planning sprint.
 */

const STATUSES: OpStatus[] = [
  { _type: "Status", id: 7, name: "In progress", isClosed: false },
];

async function seedCache(
  repos: Repositories,
  id: number,
  o: { assignee?: { id: number; name: string }; estimated: number | null; parent?: number | null },
): Promise<void> {
  await repos.workPackages.upsertMany([
    {
      op_id: id,
      project_op_id: 100,
      project_name: null,
      subject: `WP ${id}`,
      type_name: "Task",
      status_name: "In progress",
      status_is_closed: false,
      assignee_op_id: o.assignee?.id ?? null,
      assignee_name: o.assignee?.name ?? null,
      estimated_hours: o.estimated,
      remaining_hours: o.estimated,
      spent_hours: null,
      story_points: null,
      version_op_id: null,
      version_name: null,
      priority: null,
      parent_op_id: o.parent ?? null,
      percentage_done: null,
      updated_at_op: "2026-06-01T00:00:00Z",
      raw_json: "{}",
    },
  ]);
}

describe("Increment 28 — double counting: detection, capacity visibility, bulk fixes", () => {
  let t: TestApp;
  let repos!: Repositories;

  beforeEach(async () => {
    t = await buildTestApp({ opData: { statuses: STATUSES, workPackages: [], activitiesByWpId: {}, timeEntries: [] } });
    repos = t.repos;
    await initVault(t);
    await addConnection(t);
  });
  afterEach(async () => {
    await t.close();
  });

  async function newSprint(name: string): Promise<number> {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name, start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    return SprintResponse.parse(res.json()).id;
  }
  async function addItem(sprintId: number, wpId: number): Promise<void> {
    const r = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items`,
      payload: { wp_op_id: wpId },
    });
    if (r.statusCode !== 201) throw new Error(`addItem ${wpId}: ${r.statusCode} ${r.payload}`);
  }
  async function detailed(sprintId: number) {
    const r = await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/items/detailed` });
    expect(r.statusCode).toBe(200);
    return SprintItemsDetailedResponse.parse(r.json());
  }
  async function capacity(sprintId: number) {
    const r = await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` });
    expect(r.statusCode).toBe(200);
    return CapacityResponse.parse(r.json());
  }

  /** The §0c fixture: 1001 (Ada, parent) + 1002 (Grace, child of 1001). */
  async function seedParentChild(): Promise<number> {
    await seedCache(repos, 1001, { assignee: { id: 1, name: "Ada Lovelace" }, estimated: 4 });
    await seedCache(repos, 1002, {
      assignee: { id: 2, name: "Grace Hopper" },
      estimated: 4,
      parent: 1001,
    });
    const sprintId = await newSprint("S-parent-child");
    await addItem(sprintId, 1001);
    await addItem(sprintId, 1002);
    return sprintId;
  }

  it("§2a: the items DTO carries the parent/child links, always present", async () => {
    const sprintId = await seedParentChild();
    const items = await detailed(sprintId);
    const parent = items.find((i) => i.op_id === 1001)!;
    const child = items.find((i) => i.op_id === 1002)!;
    expect(parent.double_count_children).toEqual([1002]);
    expect(parent.double_count_parent_of).toBeNull();
    expect(child.double_count_children).toEqual([]);
    expect(child.double_count_parent_of).toBe(1001);
  });

  it("§2a: links a grandparent to a grandchild when the intermediate ticket is NOT in the sprint", async () => {
    await seedCache(repos, 500, { assignee: { id: 1, name: "Ada Lovelace" }, estimated: 5 });
    // 600 exists in the cache (so its parent edge is known) but is NOT added.
    await seedCache(repos, 600, { estimated: 5, parent: 500 });
    await seedCache(repos, 700, { assignee: { id: 2, name: "Grace Hopper" }, estimated: 5, parent: 600 });
    const sprintId = await newSprint("S-gap");
    await addItem(sprintId, 500);
    await addItem(sprintId, 700);

    const items = await detailed(sprintId);
    expect(items.find((i) => i.op_id === 500)!.double_count_children).toEqual([700]);
    expect(items.find((i) => i.op_id === 700)!.double_count_parent_of).toBe(500);

    // §2b rule 1: the leaf sum stays DIRECT-parent-only, so this pair still
    // double-counts (5 + 5). Marking it is the whole point — the numbers are
    // deliberately untouched until the user clicks the fix.
    expect((await capacity(sprintId)).total_planned_hours).toBe(10);
  });

  it("§0c/§2b: the suppressed parent keeps a capacity line at 0 h — and no total moves", async () => {
    const sprintId = await seedParentChild();
    const cap = await capacity(sprintId);
    const ada = cap.lines.find((l) => l.op_user_id === 1);
    const grace = cap.lines.find((l) => l.op_user_id === 2)!;
    // The measured defect was Ada being ABSENT ENTIRELY.
    expect(ada).toBeDefined();
    expect(ada!.name).toBe("Ada Lovelace");
    expect(ada!.planned_hours).toBe(0);
    expect(ada!.baseline_hours).toBe(0);
    // Not removable: she IS the assignee of WP 1001 in this sprint.
    expect(ada!.has_sprint_work).toBe(true);
    // Every total is the pre-Increment-28 leaf-level number, unchanged.
    expect(grace.planned_hours).toBe(4);
    expect(cap.total_planned_hours).toBe(4);
    expect(cap.total_available_hours).toBe(0);
  });

  it("§2c: remove-parents removes the flagged parent and clears the collision", async () => {
    const sprintId = await seedParentChild();
    const r = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/double-count/remove-parents`,
    });
    expect(r.statusCode).toBe(200);
    const body = DoubleCountFixResponse.parse(r.json());
    expect(body.removed_wp_op_ids).toEqual([1001]);
    expect(body.items.find((i) => i.op_id === 1001)!.outcome).toBe("removed");
    // Badges gone on both sides.
    expect(body.items.every((i) => i.double_count_children.length === 0)).toBe(true);
    expect(body.items.every((i) => i.double_count_parent_of === null)).toBe(true);
  });

  it("§2c: remove-children removes every flagged descendant, including a deeper chain", async () => {
    await seedCache(repos, 10, { assignee: { id: 1, name: "Ada Lovelace" }, estimated: 3 });
    await seedCache(repos, 11, { assignee: { id: 2, name: "Grace Hopper" }, estimated: 3, parent: 10 });
    await seedCache(repos, 12, { assignee: { id: 2, name: "Grace Hopper" }, estimated: 3, parent: 11 });
    await seedCache(repos, 99, { assignee: { id: 3, name: "Alan Turing" }, estimated: 3 });
    const sprintId = await newSprint("S-chain");
    for (const wp of [10, 11, 12, 99]) await addItem(sprintId, wp);

    // Nearest-ancestor semantics before the fix.
    const before = await detailed(sprintId);
    expect(before.find((i) => i.op_id === 10)!.double_count_children).toEqual([11, 12]);
    expect(before.find((i) => i.op_id === 12)!.double_count_parent_of).toBe(11);

    const r = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/double-count/remove-children`,
    });
    const body = DoubleCountFixResponse.parse(r.json());
    expect(body.removed_wp_op_ids).toEqual([11, 12]);
    // The unrelated ticket is untouched.
    expect(body.items.find((i) => i.op_id === 99)!.outcome).toBe("planned");
    expect(body.items.find((i) => i.op_id === 10)!.outcome).toBe("planned");
  });

  it("§2c: an explicit wp_op_ids list can only NARROW the flagged set, never widen it", async () => {
    const sprintId = await seedParentChild();
    // 1001 is a PARENT, so remove-children must ignore it.
    const r1 = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/double-count/remove-children`,
      payload: { wp_op_ids: [1001] },
    });
    expect(DoubleCountFixResponse.parse(r1.json()).removed_wp_op_ids).toEqual([]);
    const r2 = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/double-count/remove-children`,
      payload: { wp_op_ids: [1002] },
    });
    expect(DoubleCountFixResponse.parse(r2.json()).removed_wp_op_ids).toEqual([1002]);
  });

  it("§2c: a locked sprint answers 409 SPRINT_LOCKED, but still renders its badges", async () => {
    const sprintId = await seedParentChild();
    await repos.sprints.close(sprintId, 0, "2026-06-14T00:00:00.000Z", "finished");
    for (const side of ["remove-parents", "remove-children"]) {
      const r = await t.app.inject({
        method: "POST",
        url: `/api/sprints/${sprintId}/double-count/${side}`,
      });
      expect(r.statusCode).toBe(409);
      expect(ErrorResponse.parse(r.json()).error.code).toBe("SPRINT_LOCKED");
    }
    // Detection is read-only, so the warning keeps rendering on a locked sprint.
    const items = await detailed(sprintId);
    expect(items.find((i) => i.op_id === 1001)!.double_count_children).toEqual([1002]);
  });
});
