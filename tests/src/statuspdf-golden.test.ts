import { afterEach, describe, expect, it } from "vitest";
import type { Repositories } from "@osp/db";
import { bootRealApp, type RealApp } from "./harness";

/**
 * GOLDEN TESTS — Increment 36: any-state sprint status PDF
 * (docs/INCREMENT_36_CONTRACTS.md §4; CAPACITY_BAR_RULES §6 invariant 5).
 *
 * The route must exist and stream a real PDF for EVERY sprint state — the
 * whole point is "generate at any moment and send it to delivery managers".
 * Written BEFORE the implementation: RED (404) until Agent A lands. The
 * HTML-level number equality is covered by Agent A's unit tests with an
 * injected renderer; HERE the real chromiumPdfRenderer runs (Playwright is
 * a repo dependency and the e2e suite already launches it on this machine).
 */

async function seedSprint(
  r: Repositories,
  status: "planning" | "active" | "closed",
): Promise<number> {
  const sprint = await r.sprints.create({
    name: `Status PDF ${status}`,
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    status,
    capacity_mode: "per_person",
  });
  await r.workPackages.upsertMany([
    {
      connection_id: null,
      op_id: 9701,
      project_op_id: 100,
      project_name: null,
      subject: "Status PDF ticket",
      type_name: "Task",
      status_name: "In progress",
      status_is_closed: false,
      assignee_op_id: 921,
      assignee_name: "Pdf Dev",
      estimated_hours: 12,
      remaining_hours: 8,
      spent_hours: null,
      story_points: null,
      version_op_id: null,
      version_name: null,
      priority: "High",
      parent_op_id: null,
      percentage_done: null,
      updated_at_op: "2026-06-01T00:00:00Z",
      raw_json: "{}",
    },
  ]);
  await r.sprintItems.add({
    sprint_id: sprint.id,
    wp_op_id: 9701,
    planned_hours: 12,
    outcome: "planned",
    origin: "baseline",
  });
  return sprint.id;
}

/** Raw inject (not the JSON `call` helper) — the response body is binary. */
async function postStatusPdf(app: RealApp["app"], sprintId: number) {
  return app.inject({ method: "POST", url: `/api/sprints/${sprintId}/status-pdf` });
}

describe("GOLDEN Increment 36 — POST /sprints/:id/status-pdf (any state)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("streams a real PDF for planning, active AND closed sprints (today: 404)", async () => {
    harness = await bootRealApp();
    for (const status of ["planning", "active", "closed"] as const) {
      const sprintId = await seedSprint(harness.repos, status);
      const res = await postStatusPdf(harness.app, sprintId);
      expect(res.statusCode, `${status}: ${res.body?.slice?.(0, 200)}`).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      const bytes = res.rawPayload;
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
      expect(bytes.length).toBeGreaterThan(5_000);
    }
  }, 120_000);

  it("404s only on an unknown sprint", async () => {
    harness = await bootRealApp();
    const res = await postStatusPdf(harness.app, 999_999);
    expect(res.statusCode).toBe(404);
  });
});
