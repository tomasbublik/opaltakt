import { openDb } from "@osp/db";
import type { NewTicketBaseline, NewWorkPackageCache, Repositories } from "@osp/db";
import { describe, expect, it } from "vitest";
import type { SprintLifecycle } from "./sprintUpdate";
import { freezeSprint } from "./freeze";
import { computeClosureStats } from "./closureStats";
import { computeSprintCapacity, localOnlyCapacityDeps } from "./capacitySummary";
import { buildSprintItemsDetailed } from "./sprintItemsDetailed";
import { buildSprintStatusHtml, generateSprintStatusPdf } from "./statusReport";

/**
 * Increment 36 (docs/INCREMENT_36_CONTRACTS.md §2; CAPACITY_BAR_RULES §6
 * invariant 5) — unit tests for the sprint status PDF's HTML assembly, on
 * PGlite (ephemeral, in-process — no real DB). `renderPdf` is always injected
 * so no test here launches a real browser; that coverage lives in the golden
 * test (`tests/src/statuspdf-golden.test.ts`), which runs real Chromium.
 */

function wp(p: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: p.connection_id ?? null,
    op_id: p.op_id,
    project_op_id: 100,
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
    priority: p.priority ?? null,
    parent_op_id: p.parent_op_id ?? null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
  };
}

/** A no-op-by-default fake SprintLifecycle — freezeSprint only calls
 * `.update()`; mirrors `logic/freeze.test.ts`'s own helper. */
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

async function seedRepos(): Promise<Repositories> {
  const db = await openDb({ ephemeral: true });
  return db.repositories;
}

const GENERATED_AT = "2026-06-20T10:00:00Z";

describe("buildSprintStatusHtml — reuses computeClosureStats / computeSprintCapacity / buildSprintItemsDetailed", () => {
  it("PLANNING sprint: all four blocks present, with values equal to the underlying computations", async () => {
    const r = await seedRepos();
    const sprint = await r.sprints.create({
      name: "Status PDF Planning",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await r.workPackages.upsertMany([
      wp({
        op_id: 1,
        subject: "Ticket One",
        assignee_op_id: 10,
        assignee_name: "Dev One",
        estimated_hours: 8,
        status_name: "New",
        priority: "High",
      }),
    ]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });

    const [stats, capacity, items] = await Promise.all([
      computeClosureStats(r, sprint.id, GENERATED_AT),
      computeSprintCapacity(localOnlyCapacityDeps(r), sprint.id, GENERATED_AT),
      buildSprintItemsDetailed(r, sprint.id),
    ]);

    const html = await buildSprintStatusHtml(r, sprint.id, GENERATED_AT);

    // (a) header
    expect(html).toContain("Status PDF Planning");
    expect(html).toContain("Planning");
    expect(html).toContain("01/06/2026");
    expect(html).toContain("14/06/2026");
    expect(html).toContain(GENERATED_AT);

    // (b) summary stats — straight off computeClosureStats, called independently above.
    expect(html).toContain(`${Math.round(stats.total_planned_hours * 10) / 10} h`);
    expect(html).toContain(`${Math.round(stats.total_baseline_hours * 10) / 10} h`);
    expect(html).toContain(`${Math.round(stats.total_delivered_hours * 10) / 10} h`);
    expect(html).toContain(`${Math.round(stats.total_logged_hours * 10) / 10} h`);

    // (c) capacity table — straight off computeSprintCapacity, called independently above.
    expect(capacity.lines.length).toBeGreaterThan(0);
    const devLine = capacity.lines.find((l) => l.name === "Dev One");
    expect(devLine).toBeTruthy();
    expect(html).toContain("Dev One");
    expect(html).toContain(`${Math.round(devLine!.planned_hours * 10) / 10} h`);

    // (d) ticket table — straight off buildSprintItemsDetailed, called independently above.
    expect(items).toHaveLength(1);
    expect(html).toContain(">1<"); // #id
    expect(html).toContain("Ticket One");
    expect(html).toContain("High"); // priority
    expect(html).toContain("New"); // status
  });

  it("ACTIVE sprint shows the Active state badge", async () => {
    const r = await seedRepos();
    const sprint = await r.sprints.create({
      name: "Status PDF Active",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    const html = await buildSprintStatusHtml(r, sprint.id, GENERATED_AT);
    expect(html).toContain("Active");
  });

  it("CLOSED (not yet frozen) sprint shows 'Finished', not 'Finished & frozen'", async () => {
    const r = await seedRepos();
    const sprint = await r.sprints.create({
      name: "Status PDF Closed",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await r.sprints.close(sprint.id, 0, "2026-06-14T18:00:00Z", "finished");
    const html = await buildSprintStatusHtml(r, sprint.id, GENERATED_AT);
    expect(html).toContain("Finished");
    expect(html).not.toContain("Finished &amp; frozen");
  });

  it("FROZEN sprint shows 'Finished & frozen'; priority renders em dash once the cache row is deleted (invariant 10 — numbers unaffected)", async () => {
    const r = await seedRepos();
    const sprint = await r.sprints.create({
      name: "Status PDF Frozen",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    await r.workPackages.upsertMany([
      wp({
        op_id: 7,
        subject: "Frozen Ticket",
        assignee_op_id: 30,
        assignee_name: "Dev Three",
        estimated_hours: 6,
        status_name: "Tested",
        status_is_closed: true,
        priority: "Normal",
      }),
    ]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 7, planned_hours: 6, outcome: "planned", origin: "baseline" });
    // A baseline row is the subject/status fallback once the cache row is
    // gone (freeze itself only snapshots the numeric/identity fields, never
    // `subject` — same fixture shape as `logic/freeze.test.ts`'s wp4).
    const baseline: NewTicketBaseline = {
      sprint_id: sprint.id,
      wp_op_id: 7,
      captured_at: "2026-06-01T09:00:00Z",
      subject: "Frozen Ticket",
      status_name: "Tested",
      status_is_closed: true,
      assignee_op_id: 30,
      accountable_op_id: null,
      original_assignee_op_id: 30,
      estimated_hours: 6,
      remaining_hours: null,
      spent_hours: null,
      version_op_id: null,
      raw_json: "{}",
      origin: "baseline",
      reconstructed: false,
      reconstruction_gaps_json: null,
      assignee_name_raw: "Dev Three",
    };
    await r.ticketBaselines.upsertMany([baseline]);
    await r.sprints.close(sprint.id, 6, "2026-06-14T18:00:00Z", "finished");
    await freezeSprint(
      {
        repos: r,
        sprintLifecycle: fakeLifecycle(),
        now: () => new Date("2026-06-20T00:00:05Z"),
      },
      sprint.id,
    );

    // Reference computations BEFORE deleting the cache row — invariant 10 says
    // these must be byte-identical to the same computations run AFTER.
    const [statsBefore, capacityBefore, itemsBefore] = await Promise.all([
      computeClosureStats(r, sprint.id, GENERATED_AT),
      computeSprintCapacity(localOnlyCapacityDeps(r), sprint.id, GENERATED_AT),
      buildSprintItemsDetailed(r, sprint.id),
    ]);

    // The "Import cleanup already ran" scenario the freeze snapshot exists for.
    await r.workPackages.deleteMany([7]);

    const [statsAfter, capacityAfter, itemsAfter] = await Promise.all([
      computeClosureStats(r, sprint.id, GENERATED_AT),
      computeSprintCapacity(localOnlyCapacityDeps(r), sprint.id, GENERATED_AT),
      buildSprintItemsDetailed(r, sprint.id),
    ]);
    expect(statsAfter).toEqual(statsBefore);
    expect(capacityAfter).toEqual(capacityBefore);
    expect(itemsAfter).toEqual(itemsBefore);

    const html = await buildSprintStatusHtml(r, sprint.id, GENERATED_AT);
    expect(html).toContain("Finished &amp; frozen");
    expect(html).toContain("Frozen Ticket");
    // Priority is NOT part of the freeze snapshot (contract §1) — with the
    // cache row gone, it must render as an em dash, never "Normal" or blank.
    const ticketRow = html.split("Frozen Ticket")[1]!.split("</tr>")[0]!;
    expect(ticketRow).toContain("—");
    expect(ticketRow).not.toContain("Normal");
  });

  it("renders the 'no capacity lines' / 'no tickets' fallbacks for an empty sprint", async () => {
    const r = await seedRepos();
    const sprint = await r.sprints.create({
      name: "Status PDF Empty",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    const html = await buildSprintStatusHtml(r, sprint.id, GENERATED_AT);
    expect(html).toContain("No capacity lines.");
    expect(html).toContain("No tickets.");
  });

  it("throws SPRINT_NOT_FOUND for an unknown sprint", async () => {
    const r = await seedRepos();
    await expect(buildSprintStatusHtml(r, 999_999, GENERATED_AT)).rejects.toThrow(/not found/i);
  });
});

describe("generateSprintStatusPdf — writes to exports/ + returns the same bytes; NEVER mutates sprint state", () => {
  it("writes sprint-status-<slug>-<stamp>.pdf and streams the injected bytes", async () => {
    const r = await seedRepos();
    const sprint = await r.sprints.create({
      name: "3.5.099",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    const before = await r.sprints.getById(sprint.id);
    const writes: Array<{ path: string; len: number }> = [];
    const res = await generateSprintStatusPdf(r, sprint.id, {
      generatedAt: "2026-06-20T10:00:00Z",
      exportsDir: "/tmp/osp-agentA-statusreport-test",
      renderPdf: async () => Buffer.from("%PDF-1.4 fake"),
      mkdir: async () => {},
      writeFile: async (path, data) => {
        writes.push({ path, len: data.length });
      },
    });
    expect(res.bytes.toString()).toBe("%PDF-1.4 fake");
    expect(res.file_path).toMatch(/sprint-status-3-5-099-2026-06-20T10-00-00Z\.pdf$/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(res.file_path);

    // ⛔ View ≠ lock (SPEC_11 §8a regression guard, same as report.test.ts):
    // the sprint row is byte-identical after generating the PDF.
    const after = await r.sprints.getById(sprint.id);
    expect(after).toEqual(before);
  });
});
