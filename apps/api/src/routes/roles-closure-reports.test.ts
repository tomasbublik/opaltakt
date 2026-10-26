import {
  CapacityResponse,
  ClosureStatsResponse,
  DoneRulesResponse,
  PeopleResponse,
  ReportDetailResponse,
  ReportsListResponse,
} from "@osp/contracts";
import type { NewWorkPackageCache, Repositories } from "@osp/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../test-utils";

function seedWp(repos: Repositories, p: Partial<NewWorkPackageCache> & { op_id: number }): Promise<void> {
  return repos.workPackages.upsertMany([
    {
      connection_id: null, op_id: p.op_id, project_op_id: 100, project_name: null, subject: p.subject ?? `WP ${p.op_id}`,
      type_name: "Task", status_name: p.status_name ?? "New", status_is_closed: p.status_is_closed ?? false,
      assignee_op_id: p.assignee_op_id ?? null, assignee_name: p.assignee_name ?? null,
      estimated_hours: p.estimated_hours ?? null, remaining_hours: null, spent_hours: null, story_points: null,
      version_op_id: null, version_name: null, priority: null, parent_op_id: null, percentage_done: null,
      updated_at_op: "2026-06-01T00:00:00Z", raw_json: "{}",
    },
  ]);
}

describe("Increment 14 — people / done-rules / closure-stats / reports routes", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await buildTestApp({ pdfRenderer: async () => Buffer.from("%PDF-1.4 stub") });
  });
  afterEach(async () => {
    await t.close();
  });

  it("GET /api/done-rules returns the seeded matrix; PUT replaces it", async () => {
    const got = await t.app.inject({ method: "GET", url: "/api/done-rules" });
    expect(got.statusCode).toBe(200);
    const rules = DoneRulesResponse.parse(got.json());
    expect(rules.length).toBe(10);
    expect(rules.find((r) => r.status_name === "Rejected")!.kind).toBe("rejected");

    const put = await t.app.inject({
      method: "PUT",
      url: "/api/done-rules",
      payload: { rules: [{ status_name: "Done", kind: "always_done" }] },
    });
    expect(put.statusCode).toBe(200);
    expect(DoneRulesResponse.parse(put.json())).toHaveLength(1);
  });

  it("GET /api/people materializes assignees; PUT /api/people/:id/role sets the role", async () => {
    const sprint = await t.repos.sprints.create({ name: "S", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person" });
    await seedWp(t.repos, { op_id: 1, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });

    const people = PeopleResponse.parse((await t.app.inject({ method: "GET", url: "/api/people" })).json());
    const dev = people.find((p) => p.name === "Dev One")!;
    expect(dev).toBeTruthy();
    expect(dev.role).toBe("unset");
    expect(dev.ticket_count).toBe(1);

    const put = await t.app.inject({ method: "PUT", url: `/api/people/${dev.id}/role`, payload: { role: "developer" } });
    expect(put.statusCode).toBe(200);
    expect(put.json().role).toBe("developer");

    const missing = await t.app.inject({ method: "PUT", url: "/api/people/9999/role", payload: { role: "tester" } });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /api/sprints/:id/closure-stats classifies by status × role", async () => {
    const sprint = await t.repos.sprints.create({ name: "S", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person" });
    const dev = await t.repos.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await t.repos.teamMembers.setRole(dev.id, "developer");
    await seedWp(t.repos, { op_id: 1, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 });
    await seedWp(t.repos, { op_id: 2, status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 4 });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 2, planned_hours: 4, outcome: "planned", origin: "baseline" });

    const res = await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/closure-stats` });
    expect(res.statusCode).toBe(200);
    const stats = ClosureStatsResponse.parse(res.json());
    expect(stats.done.count).toBe(1); // wp2 tested
    expect(stats.not_done.count).toBe(1); // wp1 in progress + developer
  });

  it("reports: list closed sprints, detail, and PDF — none mutate sprint state", async () => {
    const sprint = await t.repos.sprints.create({ name: "R", start_date: "2026-06-01", end_date: "2026-06-14", status: "planning", capacity_mode: "per_person" });
    await seedWp(t.repos, { op_id: 1, status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
    await t.repos.sprints.close(sprint.id, 8, "2026-06-14T18:00:00Z", "finished");
    const before = await t.repos.sprints.getById(sprint.id);

    const list = ReportsListResponse.parse((await t.app.inject({ method: "GET", url: "/api/reports" })).json());
    expect(list.map((s) => s.sprint_id)).toContain(sprint.id);

    const detail = ReportDetailResponse.parse((await t.app.inject({ method: "GET", url: `/api/reports/${sprint.id}` })).json());
    expect(detail.sprint.sprint_id).toBe(sprint.id);

    const pdf = await t.app.inject({ method: "POST", url: `/api/reports/${sprint.id}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("attachment");
    expect(pdf.rawPayload.toString()).toBe("%PDF-1.4 stub");

    // ⛔ View ≠ lock: the closed sprint row is byte-identical after all reads.
    expect(await t.repos.sprints.getById(sprint.id)).toEqual(before);
  });

  it("SPEC_17 §4a/§6: Planned/Delivered identical across Capacity, Closure and Report detail", async () => {
    // One computation, four surfaces. Build a sprint with real developer work
    // (a done ticket the dev logged on) so Planned AND Delivered are both > 0,
    // then assert the numbers match across the Capacity header, the Closure card
    // and the Report detail (the PDF renders the SAME ReportDetailResponse).
    const sprint = await t.repos.sprints.create({
      name: "X", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person",
    });
    const dev = await t.repos.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await t.repos.teamMembers.setRole(dev.id, "developer");
    await seedWp(t.repos, { op_id: 1, status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 });
    await seedWp(t.repos, { op_id: 2, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 5 });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 2, planned_hours: 5, outcome: "planned", origin: "baseline" });
    // The dev logs time on the done ticket → Delivered is credited to them.
    const run = await t.repos.sprintUpdateRuns.start(sprint.id, "update", "manual");
    await t.repos.ticketChangelog.insertMany([
      {
        sprint_id: sprint.id, wp_op_id: 1, update_run_id: run.id, occurred_at: "2026-06-05T09:00:00Z",
        actor_op_id: 10, actor_name: "Dev One", kind: "time_logged",
        detail_json: JSON.stringify({ kind: "time_logged", hours: 9, spent_on: "2026-06-05" }),
        source: "time_entry", op_journal_id: null, dedup_key: "te:x1",
      },
    ]);

    const cap = CapacityResponse.parse((await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/capacity` })).json());
    const stats = ClosureStatsResponse.parse((await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/closure-stats` })).json());

    // Sanity: the guard is not vacuously comparing zeros.
    expect(stats.total_planned_hours).toBe(13); // two baseline_worked segments (8 + 5); Increment 26 merged the former baseline_idle row into baseline_worked
    expect(stats.total_delivered_hours).toBe(8); // done ticket credited to the dev
    // Capacity header == Closure (byte-identical by construction — same computeClosureStats run).
    expect(cap.scope_planned_hours).toBe(stats.total_planned_hours);
    expect(cap.scope_delivered_hours).toBe(stats.total_delivered_hours);

    // Report detail (and thus the PDF, which renders it) reuses the same computation.
    await t.repos.sprints.close(sprint.id, 8, "2026-06-14T18:00:00Z", "finished");
    const detail = ReportDetailResponse.parse((await t.app.inject({ method: "GET", url: `/api/reports/${sprint.id}` })).json());
    expect(detail.stats.total_planned_hours).toBe(stats.total_planned_hours);
    expect(detail.stats.total_delivered_hours).toBe(stats.total_delivered_hours);
  });
});
