import type { NewWorkPackageCache } from "@osp/db";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../test-utils";

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2) — route-level coverage for
 * `POST /sprints/:id/status-pdf` with an INJECTED `pdfRenderer` (mirrors
 * `routes/roles-closure-reports.test.ts`'s reports-PDF test), so this never
 * launches a real browser. Real-Chromium coverage across every sprint state
 * lives in the golden test (`tests/src/statuspdf-golden.test.ts`).
 */

function seedWp(op_id: number, overrides: Partial<NewWorkPackageCache> = {}): NewWorkPackageCache {
  return {
    connection_id: null,
    op_id,
    project_op_id: 100,
    project_name: null,
    subject: `WP ${op_id}`,
    type_name: "Task",
    status_name: "In progress",
    status_is_closed: false,
    assignee_op_id: 10,
    assignee_name: "Dev One",
    estimated_hours: 8,
    remaining_hours: null,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: "High",
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
    ...overrides,
  };
}

describe("POST /sprints/:id/status-pdf (Increment 36)", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it("404s only on an unknown sprint", async () => {
    t = await buildTestApp({ pdfRenderer: async () => Buffer.from("%PDF-1.4 stub") });
    const res = await t.app.inject({ method: "POST", url: "/api/sprints/999999/status-pdf" });
    expect(res.statusCode).toBe(404);
  });

  it("streams application/pdf for planning, active AND closed sprints; never mutates the sprint row", async () => {
    t = await buildTestApp({ pdfRenderer: async () => Buffer.from("%PDF-1.4 stub") });
    for (const status of ["planning", "active", "closed"] as const) {
      const sprint = await t.repos.sprints.create({
        name: `Route Status PDF ${status}`,
        start_date: "2026-06-01",
        end_date: "2026-06-14",
        status,
        capacity_mode: "per_person",
      });
      await t.repos.workPackages.upsertMany([seedWp(2000 + sprint.id)]);
      await t.repos.sprintItems.add({
        sprint_id: sprint.id,
        wp_op_id: 2000 + sprint.id,
        planned_hours: 8,
        outcome: "planned",
        origin: "baseline",
      });
      const before = await t.repos.sprints.getById(sprint.id);

      const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprint.id}/status-pdf` });
      expect(res.statusCode, `${status}: ${res.body}`).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain("sprint-status-");
      expect(res.rawPayload.toString()).toBe("%PDF-1.4 stub");

      // ⛔ View ≠ lock (SPEC_11 §8a): the sprint row is byte-identical after.
      expect(await t.repos.sprints.getById(sprint.id)).toEqual(before);
    }
  });
});
