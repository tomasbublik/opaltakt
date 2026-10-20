import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CarrySprintItemResponse, ErrorResponse } from "@osp/contracts";
import type { Repositories } from "@osp/db";
import type { HalLink, OpStatus, OpWorkPackage } from "@osp/op-client";
import {
  addConnection,
  buildTestApp,
  type FakeOpData,
  initVault,
  rawQuery,
  type TestApp,
} from "../test-utils";

/**
 * Route-level tests for POST /sprints/:id/items/:wpId/carry
 * (docs/INCREMENT_34_CONTRACTS.md §5 — Agent B's ownership: apps/api/src/routes/**).
 *
 * The cross-cutting golden scenario lives in
 * tests/src/multisprint-golden.test.ts ("GOLDEN Increment 34 — carry-over
 * endpoint (3c)") and pins the happy path + a couple of gates end to end.
 * These tests cover the route in isolation: both target-side add paths
 * (planning / active — reusing `addSprintItem`, the SAME implementation
 * POST /sprints/:id/items uses) and every gate named in the contract.
 */

const LONG_WP = 7001;

const STATUSES: OpStatus[] = [{ _type: "Status", id: 7, name: "In progress", isClosed: false }];

function statusLink(): HalLink {
  return { href: "/api/v3/statuses/7", title: "In progress" };
}

function opWp(id: number, estimatedTime: string, remainingTime: string): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    estimatedTime,
    remainingTime,
    spentTime: null,
    updatedAt: "2026-06-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: statusLink(),
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
    },
  };
}

/** Local cache row — the shape a PLANNING target's add reads (SPEC: local cache read). */
async function seedCache(
  repos: Repositories,
  id: number,
  o: { estimated: number | null; remaining: number | null },
): Promise<void> {
  await repos.workPackages.upsertMany([
    {
      connection_id: null,
      op_id: id,
      project_op_id: 100,
      subject: `WP ${id}`,
      type_name: "Task",
      status_name: "In progress",
      status_is_closed: false,
      assignee_op_id: null,
      assignee_name: null,
      estimated_hours: o.estimated,
      remaining_hours: o.remaining,
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

async function createSprint(
  repos: Repositories,
  status: "planning" | "active" | "closed",
  name: string,
): Promise<number> {
  const sprint = await repos.sprints.create({
    name,
    start_date: "2026-06-15",
    end_date: "2026-06-28",
    status,
    capacity_mode: "per_person",
  });
  return sprint.id;
}

/** A closed+locked source sprint with one non-removed item — the typical carry-FROM state. */
async function createClosedSource(
  repos: Repositories,
  wpId: number,
  plannedHours: number,
): Promise<number> {
  const sprint = await repos.sprints.create({
    name: "carry source",
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    status: "active",
    capacity_mode: "per_person",
  });
  await repos.sprintItems.add({
    sprint_id: sprint.id,
    wp_op_id: wpId,
    planned_hours: plannedHours,
    outcome: "planned",
    origin: "baseline",
  });
  await repos.sprints.close(sprint.id, plannedHours, "2026-06-14T18:00:00.000Z", "finished");
  return sprint.id;
}

function carry(t: TestApp, sourceId: number, wpId: number, targetSprintId: number) {
  return t.app.inject({
    method: "POST",
    url: `/api/sprints/${sourceId}/items/${wpId}/carry`,
    payload: { target_sprint_id: targetSprintId },
  });
}

describe("POST /sprints/:id/items/:wpId/carry (Increment 34 §5)", () => {
  let t: TestApp;
  let opData: FakeOpData;

  beforeEach(async () => {
    opData = { statuses: STATUSES, workPackages: [], activitiesByWpId: {}, timeEntries: [] };
    t = await buildTestApp({ opData });
    await initVault(t);
    await addConnection(t);
  });
  afterEach(async () => {
    await t.close();
  });

  it("closed source -> planning target enters at the remaining-preferring estimate; source stays untouched", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    await seedCache(t.repos, LONG_WP, { estimated: 150, remaining: 100 });
    const targetId = await createSprint(t.repos, "planning", "carry target planning");

    const res = await carry(t, sourceId, LONG_WP, targetId);
    expect(res.statusCode, res.payload).toBe(201);
    const body = CarrySprintItemResponse.parse(res.json());
    expect(body).toEqual({ carried: true, target_sprint_id: targetId, wp_op_id: LONG_WP });

    const targetItem = await t.repos.sprintItems.getBySprintAndWp(targetId, LONG_WP);
    expect(targetItem?.planned_hours, "remaining-preferring: 100h left, not the 150h estimate").toBe(
      100,
    );
    expect(targetItem?.origin, "planning target -> normal baseline add").toBe("baseline");
    expect(targetItem?.outcome).toBe("planned");

    // Source untouched: same row, same planned_hours, still non-removed, and
    // the sprint itself is still closed+locked exactly as it was.
    const sourceItem = await t.repos.sprintItems.getBySprintAndWp(sourceId, LONG_WP);
    expect(sourceItem?.planned_hours).toBe(150);
    expect(sourceItem?.outcome).toBe("planned");
    const sourceSprint = await t.repos.sprints.getById(sourceId);
    expect(sourceSprint?.status).toBe("closed");
    expect(sourceSprint?.is_locked).toBe(true);
  });

  it("closed source -> active target: reuses the mid-sprint-add path (OP fetch, added_mid_sprint origin, scope_added changelog)", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    opData.workPackages = [opWp(LONG_WP, "PT150H", "PT100H")];
    const targetId = await createSprint(t.repos, "active", "carry target active");

    const res = await carry(t, sourceId, LONG_WP, targetId);
    expect(res.statusCode, res.payload).toBe(201);

    const targetItem = await t.repos.sprintItems.getBySprintAndWp(targetId, LONG_WP);
    expect(targetItem?.planned_hours, "remaining-preferring via the OP fetch").toBe(100);
    expect(targetItem?.origin).toBe("added_mid_sprint");

    const baselines = await t.repos.ticketBaselines.listBySprint(targetId);
    expect(baselines.find((b) => b.wp_op_id === LONG_WP)?.origin).toBe("added_mid_sprint");

    const changelog = await t.repos.ticketChangelog.listBySprint(targetId);
    expect(changelog.some((c) => c.wp_op_id === LONG_WP && c.kind === "scope_added")).toBe(true);
  });

  it("gate: target already contains the wp -> 409 ITEM_ALREADY_IN_SPRINT", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    await seedCache(t.repos, LONG_WP, { estimated: 150, remaining: 100 });
    const targetId = await createSprint(t.repos, "planning", "carry target dup");
    const first = await carry(t, sourceId, LONG_WP, targetId);
    expect(first.statusCode, first.payload).toBe(201);

    const dup = await carry(t, sourceId, LONG_WP, targetId);
    expect(dup.statusCode).toBe(409);
    expect(ErrorResponse.parse(dup.json()).error.code).toBe("ITEM_ALREADY_IN_SPRINT");
  });

  it("gate: frozen target -> 409 SPRINT_FROZEN", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    await seedCache(t.repos, LONG_WP, { estimated: 150, remaining: 100 });
    // Frozen target: status "active" (open per the status gate) but frozen —
    // isolates the SPRINT_FROZEN branch from the status-not-open branch.
    const targetId = await createSprint(t.repos, "active", "frozen target");
    await t.repos.sprints.setFrozen(targetId, "2026-06-20T00:00:00.000Z");

    const res = await carry(t, sourceId, LONG_WP, targetId);
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_FROZEN");
  });

  it("gate: locked (but not yet closed) target -> 409 SPRINT_LOCKED", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    await seedCache(t.repos, LONG_WP, { estimated: 150, remaining: 100 });
    const targetId = await createSprint(t.repos, "active", "locked target");
    // Contrived: locked-but-active never occurs via the app's own repo API
    // (close() always sets status=closed and is_locked=true together) — this
    // isolates the is_locked gate exactly as contracts §5 lists it,
    // independent of the status-not-open gate above it.
    await rawQuery(t.raw, "UPDATE sprint SET is_locked = true WHERE id = $1", [targetId]);

    const res = await carry(t, sourceId, LONG_WP, targetId);
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_LOCKED");
  });

  it("gate: target sprint status is closed (not planning/active) -> 409", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    await seedCache(t.repos, LONG_WP, { estimated: 150, remaining: 100 });
    const targetId = await createSprint(t.repos, "closed", "closed target");

    const res = await carry(t, sourceId, LONG_WP, targetId);
    expect(res.statusCode).toBe(409);
  });

  it("gate: missing source item -> 404 WORK_PACKAGE_NOT_FOUND", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    const targetId = await createSprint(t.repos, "planning", "carry target missing item");

    const res = await carry(t, sourceId, 99999, targetId);
    expect(res.statusCode).toBe(404);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("WORK_PACKAGE_NOT_FOUND");
  });

  it("gate: source sprint not found -> 404 SPRINT_NOT_FOUND", async () => {
    const targetId = await createSprint(t.repos, "planning", "carry target no source");
    const res = await carry(t, 999999, LONG_WP, targetId);
    expect(res.statusCode).toBe(404);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_NOT_FOUND");
  });

  it("gate: target sprint not found -> 404 SPRINT_NOT_FOUND", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    const res = await carry(t, sourceId, LONG_WP, 999999);
    expect(res.statusCode).toBe(404);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("SPRINT_NOT_FOUND");
  });

  it("gate: target same as source -> 409 CONFLICT", async () => {
    const sourceId = await createClosedSource(t.repos, LONG_WP, 150);
    const res = await carry(t, sourceId, LONG_WP, sourceId);
    expect(res.statusCode).toBe(409);
    expect(ErrorResponse.parse(res.json()).error.code).toBe("CONFLICT");
  });
});
