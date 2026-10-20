import { openDb } from "@osp/db";
import { describe, expect, it } from "vitest";
import { buildReportDetail, buildReportsList, generateReportPdf, renderReportHtml } from "./report";
import { instant } from "../test-utils";



async function seedClosedSprint() {
  const db = await openDb({ ephemeral: true });
  const r = db.repositories;
  const sprint = await r.sprints.create({
    name: "3.5.039",
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    status: "planning",
    capacity_mode: "per_person",
  });
  await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
  await r.workPackages.upsertMany([
    {
      connection_id: null, op_id: 1, project_op_id: 100, subject: "A", type_name: "Task",
      status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One",
      estimated_hours: 8, remaining_hours: null, spent_hours: null, story_points: null,
      version_op_id: null, version_name: null, priority: null, parent_op_id: null,
      percentage_done: null, updated_at_op: "2026-06-01T00:00:00Z", raw_json: "{}",
    },
  ]);
  const closed = await r.sprints.close(sprint.id, 8, "2026-06-14T18:00:00Z", "finished");
  return { db, r, sprint: closed };
}

describe("reports (SPEC_14 §4) — read-only, from stored data", () => {
  it("lists closed sprints newest-closed first", async () => {
    const { r } = await seedClosedSprint();
    // A planning sprint must NOT appear.
    await r.sprints.create({ name: "planning one", start_date: "2026-07-01", end_date: "2026-07-14", status: "planning", capacity_mode: "per_person" });
    const list = await buildReportsList(r);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("3.5.039");
    expect(instant(list[0]!.closed_at)).toBe(instant("2026-06-14T18:00:00Z"));
  });

  it("builds a detail (stats + burndown) and renders HTML without a live OP call", async () => {
    const { r, sprint } = await seedClosedSprint();
    const detail = await buildReportDetail(r, sprint.id, "2026-06-20T00:00:00Z");
    expect(detail.sprint.sprint_id).toBe(sprint.id);
    expect(detail.stats.sprint_id).toBe(sprint.id);
    expect(detail.burndown.sprint_id).toBe(sprint.id);
    const html = renderReportHtml(detail);
    expect(html).toContain("3.5.039");
    expect(html).toContain("Burndown");
  });

  it("generateReportPdf writes to exports/ + returns the same bytes; NEVER mutates sprint state", async () => {
    const { r, sprint } = await seedClosedSprint();
    const before = await r.sprints.getById(sprint.id);
    const writes: Array<{ path: string; len: number }> = [];
    const res = await generateReportPdf(r, sprint.id, {
      generatedAt: "2026-06-20T10:00:00Z",
      exportsDir: "/tmp/osp-agentB-report-test",
      renderPdf: async () => Buffer.from("%PDF-1.4 fake"),
      mkdir: async () => {},
      writeFile: async (path, data) => { writes.push({ path, len: data.length }); },
    });
    expect(res.bytes.toString()).toBe("%PDF-1.4 fake");
    expect(res.file_path).toMatch(/report-3-5-039-2026-06-20T10-00-00Z\.pdf$/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(res.file_path);

    // ⛔ View ≠ lock (SPEC_11 §8a regression guard): the sprint row is byte-identical.
    const after = await r.sprints.getById(sprint.id);
    expect(after).toEqual(before);
  });

  it("repeated detail reads leave the sprint row untouched", async () => {
    const { r, sprint } = await seedClosedSprint();
    const before = await r.sprints.getById(sprint.id);
    await buildReportDetail(r, sprint.id, "2026-06-20T00:00:00Z");
    await buildReportDetail(r, sprint.id, "2026-06-21T00:00:00Z");
    expect(await r.sprints.getById(sprint.id)).toEqual(before);
  });
});

// Increment 33 (docs/INCREMENT_33_CONTRACTS.md §2) — "Outside the sprint" in
// the report detail + its HTML/PDF rendering. The detail JSON needs no new
// contract: ReportDetailResponse.stats IS ClosureStatsResponse, which already
// carries off_sprint (Increment 33 §1, packages/contracts/src/api.ts).
describe("reports — off-sprint section (Increment 33 §2)", () => {
  it("ReportDetailResponse.stats.off_sprint carries the aggregated block; the HTML omits the section when there is none", async () => {
    const { r, sprint } = await seedClosedSprint();
    const detail = await buildReportDetail(r, sprint.id, "2026-06-20T00:00:00Z");
    // seedClosedSprint logs no off-sprint time at all.
    expect(detail.stats.off_sprint.total_hours).toBe(0);
    const html = renderReportHtml(detail);
    expect(html).not.toContain("Outside the sprint");
  });

  it("renders the 'Outside the sprint' section with the share sentence, per-person totals and ticket lists", async () => {
    const { r, sprint } = await seedClosedSprint();
    await r.offSprintTime.replaceForSprint(sprint.id, [
      {
        sprint_id: sprint.id, connection_id: null, op_time_entry_id: 801, wp_op_id: 555,
        wp_subject: "Unrelated ticket", actor_op_id: 10, actor_name: "Dev One",
        spent_on: "2026-06-05", hours: 4, fetched_at: "2026-06-13T00:00:00Z",
      },
    ]);
    const detail = await buildReportDetail(r, sprint.id, "2026-06-20T00:00:00Z");

    // seedClosedSprint's wp1 is "Tested"/done, not dev-attributed by logger —
    // no time_logged changelog row was seeded, so sprint_logged_hours is 0 and
    // this off-only 4h is 100% "outside the sprint".
    expect(detail.stats.off_sprint.total_hours).toBe(4);
    expect(detail.stats.off_sprint.sprint_logged_hours).toBe(0);
    expect(detail.stats.off_sprint.share_pct).toBe(100);
    expect(detail.stats.off_sprint.per_person).toEqual([
      {
        op_user_id: 10, name: "Dev One", total_hours: 4, share_pct: 100,
        tickets: [{ wp_op_id: 555, subject: "Unrelated ticket", hours: 4, connection_id: null }],
      },
    ]);

    const html = renderReportHtml(detail);
    expect(html).toContain("Outside the sprint");
    expect(html).toContain("100 % of developer time");
    expect(html).toContain("Dev One");
    expect(html).toContain("#555 Unrelated ticket");
    expect(html).toContain("4 h");
  });
});

// Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3; CAPACITY_BAR_RULES §5c) —
// "Scope origin" section: headline, donut and two-row table, read straight
// off the already-computed `stats.scope_origin` block.
describe("reports — scope origin section (Increment 35 §3)", () => {
  async function seedMixedOriginSprint() {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "3.5.040",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await r.workPackages.upsertMany([
      {
        connection_id: null, op_id: 1, project_op_id: 100, subject: "Baseline ticket", type_name: "Task",
        status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One",
        estimated_hours: 10, remaining_hours: null, spent_hours: null, story_points: null,
        version_op_id: null, version_name: null, priority: null, parent_op_id: null,
        percentage_done: null, updated_at_op: "2026-06-01T00:00:00Z", raw_json: "{}",
      },
      {
        connection_id: null, op_id: 2, project_op_id: 100, subject: "Added ticket", type_name: "Task",
        status_name: "In progress", status_is_closed: false, assignee_op_id: 10, assignee_name: "Dev One",
        estimated_hours: 4, remaining_hours: null, spent_hours: null, story_points: null,
        version_op_id: null, version_name: null, priority: null, parent_op_id: null,
        percentage_done: null, updated_at_op: "2026-06-01T00:00:00Z", raw_json: "{}",
      },
    ]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 10, outcome: "planned", origin: "baseline" });
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 2, planned_hours: 4, outcome: "planned", origin: "added_mid_sprint" });
    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    await r.ticketChangelog.insertMany([
      {
        sprint_id: sprint.id, wp_op_id: 1, update_run_id: run.id, occurred_at: "2026-06-05T09:00:00Z",
        actor_op_id: 10, actor_name: "Dev One", kind: "time_logged",
        detail_json: JSON.stringify({ kind: "time_logged", hours: 8, spent_on: "2026-06-05" }),
        source: "time_entry", op_journal_id: null, dedup_key: "te:base",
      },
      {
        sprint_id: sprint.id, wp_op_id: 2, update_run_id: run.id, occurred_at: "2026-06-06T09:00:00Z",
        actor_op_id: 10, actor_name: "Dev One", kind: "time_logged",
        detail_json: JSON.stringify({ kind: "time_logged", hours: 2, spent_on: "2026-06-06" }),
        source: "time_entry", op_journal_id: null, dedup_key: "te:added",
      },
    ]);
    const closed = await r.sprints.close(sprint.id, 14, "2026-06-14T18:00:00Z", "finished");
    return { db, r, sprint: closed };
  }

  it("renders the section even for an all-baseline sprint (one included item), with a null-share headline", async () => {
    // seedClosedSprint (top of file) seeds exactly one baseline ticket with no
    // added scope — the section still renders (baseline.ticket_count === 1),
    // just with an all-baseline table and a null share headline.
    const { r, sprint } = await seedClosedSprint();
    const detail = await buildReportDetail(r, sprint.id, "2026-06-20T00:00:00Z");
    expect(detail.stats.scope_origin.added.ticket_count).toBe(0);
    expect(detail.stats.scope_origin.added_logged_share_pct).toBeNull();
    const html = renderReportHtml(detail);
    expect(html).toContain("Scope origin");
    expect(html).toContain("no developer time logged yet");
  });

  it("renders headline, donut and two-row table for a mixed baseline/added sprint", async () => {
    const { r, sprint } = await seedMixedOriginSprint();
    const detail = await buildReportDetail(r, sprint.id, "2026-06-20T00:00:00Z");
    expect(detail.stats.scope_origin.baseline).toEqual({ ticket_count: 1, estimate_hours: 10, dev_logged_hours: 8 });
    expect(detail.stats.scope_origin.added).toEqual({ ticket_count: 1, estimate_hours: 4, dev_logged_hours: 2 });
    expect(detail.stats.scope_origin.added_logged_share_pct).toBeCloseTo(20, 5);

    const html = renderReportHtml(detail);
    expect(html).toContain("Scope origin");
    expect(html).toContain("Added during sprint: 1 ticket, 2 h logged");
    expect(html).toContain("20 % of developer time");
    expect(html).toContain("Planned before activation");
    // The donut is present (an <svg> with the scope-origin aria-label).
    expect(html).toContain('aria-label="Scope origin split"');
    // Two-row table with both groups' figures.
    expect(html).toContain("10 h");
    expect(html).toContain("4 h");
  });

  it("degrades gracefully (no section) on a sprint with no included items at all", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "Empty", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "planning", capacity_mode: "per_person",
    });
    const closed = await r.sprints.close(sprint.id, 0, "2026-06-14T18:00:00Z", "finished");
    const detail = await buildReportDetail(r, closed.id, "2026-06-20T00:00:00Z");
    expect(detail.stats.scope_origin.baseline.ticket_count).toBe(0);
    expect(detail.stats.scope_origin.added.ticket_count).toBe(0);
    const html = renderReportHtml(detail);
    expect(html).not.toContain("Scope origin");
  });
});
