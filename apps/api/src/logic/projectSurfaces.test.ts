import { openDb } from "@osp/db";
import type { NewTicketBaseline, NewWorkPackageCache, Repositories } from "@osp/db";
import { describe, expect, it } from "vitest";
import type { SprintLifecycle } from "./sprintUpdate";
import { freezeSprint } from "./freeze";
import { computeClosureStats } from "./closureStats";
import { buildSprintItemsDetailed } from "./sprintItemsDetailed";
import { buildSprintStatusHtml } from "./statusReport";
import { buildReportDetail, renderReportHtml } from "./report";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.B2/§2.B4/§2.B5) — every
 * ticket surface carries the OP project via the ONE resolver; a FROZEN sprint
 * keeps its freeze-time project through a rename, a cache deletion and a
 * `project` row deletion (CAPACITY_BAR_RULES §6 invariant 10, extended).
 * Fictional projects only. PGlite, no server, no OP.
 */

const GENERATED_AT = "2026-06-20T10:00:00Z";

function wp(p: {
  op_id: number;
  connection_id: number | null;
  project_op_id: number;
  project_name: string | null;
  subject: string;
  status_is_closed?: boolean;
}): NewWorkPackageCache {
  return {
    connection_id: p.connection_id,
    op_id: p.op_id,
    project_op_id: p.project_op_id,
    project_name: p.project_name,
    subject: p.subject,
    type_name: "Task",
    status_name: p.status_is_closed ? "Closed" : "In progress",
    status_is_closed: p.status_is_closed ?? false,
    assignee_op_id: 10,
    assignee_name: "Dev One",
    estimated_hours: 4,
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
  };
}

function baseline(
  sprintId: number,
  wpOpId: number,
  subject: string,
  projectHref: string | null,
  projectTitle: string | null,
): NewTicketBaseline {
  return {
    sprint_id: sprintId,
    wp_op_id: wpOpId,
    captured_at: "2026-06-01T09:00:00Z",
    subject,
    status_name: "In progress",
    status_is_closed: false,
    assignee_op_id: 10,
    accountable_op_id: null,
    original_assignee_op_id: 10,
    estimated_hours: 4,
    remaining_hours: 4,
    spent_hours: null,
    version_op_id: null,
    raw_json: JSON.stringify({ id: wpOpId, _links: { project: { href: projectHref, title: projectTitle } } }),
    origin: "baseline",
    reconstructed: false,
    reconstruction_gaps_json: null,
    assignee_name_raw: "Dev One",
  };
}

function fakeLifecycle(): SprintLifecycle {
  return {
    activate: async () => {
      throw new Error("not used");
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
      throw new Error("not used");
    },
  };
}

interface Seeded {
  r: Repositories;
  raw: { query(sql: string): Promise<unknown> };
  sprintId: number;
  connA: number;
  connB: number;
}

/** Two servers sharing project op_id 42 (northwind on A, harbor-ops on B),
 * plus a third ticket whose cache row is gone and whose project only lives in
 * its activation baseline payload. */
async function seedTwoServerSprint(): Promise<Seeded> {
  const db = await openDb({ ephemeral: true });
  const r = db.repositories;
  const connA = (
    await r.connections.create({
      base_url: "https://a.example.com", label: "A",
      token_ct: null, token_nonce: null, token_tag: null, default_project_op_id: null,
    })
  ).id;
  const connB = (
    await r.connections.create({
      base_url: "https://b.example.com", label: "B",
      token_ct: null, token_nonce: null, token_tag: null, default_project_op_id: null,
    })
  ).id;
  await r.projects.upsertMany([
    { connection_id: connA, op_id: 42, identifier: "northwind", name: "Northwind Payments", last_synced_at: null },
    { connection_id: connB, op_id: 42, identifier: "harbor-ops", name: "Harbor Ops", last_synced_at: null },
    { connection_id: connA, op_id: 7, identifier: "tidewater", name: "Tidewater", last_synced_at: null },
  ]);
  const sprint = await r.sprints.create({
    name: "Two Projects",
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    status: "active",
    capacity_mode: "per_person",
  });
  await r.workPackages.upsertMany([
    wp({ op_id: 1, connection_id: connA, project_op_id: 42, project_name: "Northwind Payments", subject: "NW ticket" }),
    wp({ op_id: 2, connection_id: connB, project_op_id: 42, project_name: "Harbor Ops", subject: "HO ticket" }),
  ]);
  for (const id of [1, 2, 3]) {
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: id, planned_hours: 4, outcome: "planned", origin: "baseline" });
  }
  await r.ticketBaselines.upsertMany([
    baseline(sprint.id, 1, "NW ticket", "/api/v3/projects/42", "Northwind Payments"),
    baseline(sprint.id, 2, "HO ticket", "/api/v3/projects/42", "Harbor Ops"),
    // No cache row for #3 — project only in the baseline payload, no
    // connection known ⇒ the bare op_id is used ONLY because it is unique
    // (op_id 7 exists on one server only).
    baseline(sprint.id, 3, "Baseline-only ticket", "/api/v3/projects/7", "Tidewater (at activation)"),
  ]);
  return { r, raw: db.raw as Seeded["raw"], sprintId: sprint.id, connA, connB };
}

describe("project fields on items/detailed + closure stats (live sprint)", () => {
  it("resolves per ticket, connection-scoped (same op_id on two servers ⇒ two projects), baseline fallback", async () => {
    const { r, sprintId } = await seedTwoServerSprint();
    const items = await buildSprintItemsDetailed(r, sprintId);
    const byId = new Map(items.map((i) => [i.op_id, i]));
    expect(byId.get(1)).toMatchObject({ project_op_id: 42, project_name: "Northwind Payments", project_identifier: "northwind" });
    expect(byId.get(2)).toMatchObject({ project_op_id: 42, project_name: "Harbor Ops", project_identifier: "harbor-ops" });
    expect(byId.get(3)).toMatchObject({ project_name: "Tidewater", project_identifier: "tidewater" });

    const stats = await computeClosureStats(r, sprintId, GENERATED_AT);
    const lines = new Map(stats.per_ticket.map((t) => [t.wp_op_id, t]));
    expect(lines.get(1)).toMatchObject({ project_op_id: 42, project_name: "Northwind Payments", project_identifier: "northwind" });
    expect(lines.get(2)).toMatchObject({ project_op_id: 42, project_name: "Harbor Ops", project_identifier: "harbor-ops" });
    expect(lines.get(3)).toMatchObject({ project_op_id: 7, project_name: "Tidewater" });
  });

  it("status PDF HTML: Project column after #, legend with both projects", async () => {
    const { r, sprintId } = await seedTwoServerSprint();
    const html = await buildSprintStatusHtml(r, sprintId, GENERATED_AT);
    expect(html).toContain("<th>#</th><th>Project</th><th>Subject</th>");
    expect(html).toContain('<span class="proj" title="Northwind Payments">northwind</span>');
    expect(html).toContain('<span class="proj" title="Harbor Ops">harbor-ops</span>');
    expect(html).toContain("Projects: harbor-ops — Harbor Ops · northwind — Northwind Payments · tidewater — Tidewater");
    expect(html).toContain(".proj{display:inline-block;max-width:14ch;");
    expect(html).not.toContain("Project: ");
  });
});

describe("FROZEN sprint — project is the freeze-time snapshot (invariant 10 extended)", () => {
  it("identical before/after a rename, cache deletion and project-row deletion", async () => {
    const { r, raw, sprintId, connA, connB } = await seedTwoServerSprint();
    await r.sprints.close(sprintId, 8, "2026-06-14T18:00:00Z", "finished");
    await freezeSprint(
      { repos: r, sprintLifecycle: fakeLifecycle(), now: () => new Date("2026-06-20T00:00:05Z") },
      sprintId,
    );

    const itemsBefore = await buildSprintItemsDetailed(r, sprintId);
    const statsBefore = await computeClosureStats(r, sprintId, GENERATED_AT);
    const htmlBefore = await buildSprintStatusHtml(r, sprintId, GENERATED_AT);
    const nw = itemsBefore.find((i) => i.op_id === 1)!;
    expect(nw).toMatchObject({ project_name: "Northwind Payments", project_identifier: "northwind" });
    expect(itemsBefore.find((i) => i.op_id === 2)).toMatchObject({ project_name: "Harbor Ops", project_identifier: "harbor-ops" });
    expect(statsBefore.per_ticket.find((t) => t.wp_op_id === 2)).toMatchObject({
      project_op_id: 42, project_name: "Harbor Ops", project_identifier: "harbor-ops",
    });

    // Rename in OP (as a later sync would record it) …
    await r.projects.upsertMany([
      { connection_id: connA, op_id: 42, identifier: "northwind-renamed", name: "Northwind Renamed", last_synced_at: null },
      { connection_id: connB, op_id: 42, identifier: "harbor-renamed", name: "Harbor Renamed", last_synced_at: null },
    ]);
    await r.workPackages.upsertMany([
      wp({ op_id: 1, connection_id: connA, project_op_id: 42, project_name: "Northwind Renamed", subject: "NW ticket" }),
    ]);
    const itemsAfterRename = await buildSprintItemsDetailed(r, sprintId);
    expect(itemsAfterRename).toEqual(itemsBefore);

    // … then the cache rows and the project rows disappear entirely.
    await r.workPackages.deleteMany([1, 2]);
    await raw.query("DELETE FROM project");

    const itemsAfter = await buildSprintItemsDetailed(r, sprintId);
    const statsAfter = await computeClosureStats(r, sprintId, GENERATED_AT);
    const htmlAfter = await buildSprintStatusHtml(r, sprintId, GENERATED_AT);
    expect(itemsAfter).toEqual(itemsBefore);
    expect(statsAfter).toEqual(statsBefore);
    expect(htmlAfter).toEqual(htmlBefore);
    expect(htmlAfter).toContain("northwind");
    expect(htmlAfter).not.toContain("renamed");
  });
});

describe("report PDF HTML — single-project rule", () => {
  it("one project ⇒ no column/legend, `Project: <name> (<identifier>)` in the sub-header", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const conn = await r.connections.create({
      base_url: "https://a.example.com", label: "A",
      token_ct: null, token_nonce: null, token_tag: null, default_project_op_id: null,
    });
    await r.projects.upsertMany([
      { connection_id: conn.id, op_id: 42, identifier: "northwind", name: "Northwind Payments", last_synced_at: null },
    ]);
    const sprint = await r.sprints.create({
      name: "One Project", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "planning", capacity_mode: "per_person",
    });
    await r.workPackages.upsertMany([
      wp({ op_id: 1, connection_id: conn.id, project_op_id: 42, project_name: "Northwind Payments", subject: "A", status_is_closed: true }),
      wp({ op_id: 2, connection_id: conn.id, project_op_id: 42, project_name: "Northwind Payments", subject: "B" }),
    ]);
    for (const id of [1, 2]) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: id, planned_hours: 4, outcome: "planned", origin: "baseline" });
    }
    const html = renderReportHtml(await buildReportDetail(r, sprint.id, GENERATED_AT));
    expect(html).toContain("Project: Northwind Payments (northwind)");
    expect(html).not.toContain("<th>Project</th>");
    expect(html).not.toContain("Projects:");
    expect(html).toContain("<th>#</th><th>Subject</th>");

    // A second project ⇒ the column + legend come back.
    await r.workPackages.upsertMany([
      wp({ op_id: 3, connection_id: conn.id, project_op_id: 9, project_name: "Harbor <Ops> & Co", subject: "C" }),
    ]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 3, planned_hours: 4, outcome: "planned", origin: "baseline" });
    const html2 = renderReportHtml(await buildReportDetail(r, sprint.id, GENERATED_AT));
    expect(html2).toContain("<th>#</th><th>Project</th><th>Subject</th>");
    expect(html2).not.toContain("Project: Northwind");
    // No project row for op 9 ⇒ the WP-payload name is shown (escaped).
    expect(html2).toContain(">Harbor &lt;Ops&gt; &amp; Co<");
    expect(html2).toContain("Projects: Harbor &lt;Ops&gt; &amp; Co · northwind — Northwind Payments");
  });
});
