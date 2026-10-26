import type { Project } from "@osp/contracts";
import { describe, expect, it } from "vitest";
import { createProjectResolver, projectLinkFromRawJson } from "./projectRef";
import { planPdfProjects } from "./pdfProjects";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.B1/§2.B5) — the ONE project
 * resolver, every chain step. Fictional projects only (§0 pillar 5).
 */

let nextId = 1;
function proj(connection_id: number | null, op_id: number, identifier: string, name: string): Project {
  return { id: nextId++, connection_id, op_id, identifier, name, last_synced_at: null };
}

const baselineJson = (href: string | null, title: string | null): string =>
  JSON.stringify({ id: 1, _links: { project: { href, title } } });

describe("createProjectResolver — chain: frozen → live cache → baseline raw_json → null", () => {
  const projects = [
    proj(1, 42, "northwind", "Northwind Payments"),
    proj(2, 42, "harbor-ops", "Harbor Ops"), // SAME op_id, other server
    proj(1, 7, "tidewater", "Tidewater"),
    proj(null, 9, "legacy-nine", "Legacy Nine"),
  ];
  const r = createProjectResolver(projects);

  it("frozen snapshot wins and is returned as-is (no cache/project-table read)", () => {
    const ref = r.resolve({
      frozen: { op_id: 42, name: "Northwind (old name)", identifier: "northwind-old" },
    });
    expect(ref).toEqual({ op_id: 42, name: "Northwind (old name)", identifier: "northwind-old" });
  });

  it("frozen all-null stays null (unresolvable legacy freeze renders —), never falls to live data", () => {
    expect(
      r.resolve({
        frozen: { op_id: null, name: null, identifier: null },
        baselineRawJson: baselineJson("/api/v3/projects/42", "Northwind Payments"),
      }),
    ).toEqual({ op_id: null, name: null, identifier: null });
  });

  it("live cache row: the connection-scoped row's name wins over a (possibly stale) WP payload title", () => {
    // A project rename does not bump the WP's updatedAt, so the cached title
    // can lag; the row is refreshed on every sync run touching the project.
    expect(
      r.resolve({ wp: { connection_id: 1, project_op_id: 42, project_name: "Northwind (old WP title)" } }),
    ).toEqual({ op_id: 42, name: "Northwind Payments", identifier: "northwind" });
  });

  it("live cache row without a project row (hidden/404 project) uses the WP payload title", () => {
    expect(
      r.resolve({ wp: { connection_id: 9, project_op_id: 77, project_name: "Lighthouse Internal" } }),
    ).toEqual({ op_id: 77, name: "Lighthouse Internal", identifier: null });
  });

  it("live cache row without a payload title falls back to the project row's name", () => {
    expect(r.resolve({ wp: { connection_id: 1, project_op_id: 42, project_name: null } })).toEqual({
      op_id: 42,
      name: "Northwind Payments",
      identifier: "northwind",
    });
  });

  it("cross-server: the same project op_id on two connections resolves to two different projects", () => {
    const a = r.resolve({ wp: { connection_id: 1, project_op_id: 42, project_name: null } });
    const b = r.resolve({ wp: { connection_id: 2, project_op_id: 42, project_name: null } });
    expect(a.name).toBe("Northwind Payments");
    expect(b.name).toBe("Harbor Ops");
    expect(a.identifier).toBe("northwind");
    expect(b.identifier).toBe("harbor-ops");
  });

  it("a connection with no project row for that op_id gets no identifier (never another server's)", () => {
    expect(r.resolve({ wp: { connection_id: 3, project_op_id: 42, project_name: "Payload Title" } })).toEqual({
      op_id: 42,
      name: "Payload Title",
      identifier: null,
    });
  });

  it("legacy connection-less wp: `none:<id>` row matches", () => {
    expect(r.resolve({ wp: { connection_id: null, project_op_id: 9, project_name: null } })).toEqual({
      op_id: 9,
      name: "Legacy Nine",
      identifier: "legacy-nine",
    });
  });

  it("legacy connection-less wp: a UNIQUE bare op_id matches", () => {
    expect(r.resolve({ wp: { connection_id: null, project_op_id: 7, project_name: null } }).identifier).toBe(
      "tidewater",
    );
  });

  it("legacy connection-less wp: an AMBIGUOUS bare op_id gives null identifier (no guessing)", () => {
    expect(r.resolve({ wp: { connection_id: null, project_op_id: 42, project_name: "From payload" } })).toEqual({
      op_id: 42,
      name: "From payload",
      identifier: null,
    });
  });

  it("project_op_id 0 → op_id null (never 'Project 0'); falls through to the baseline", () => {
    expect(r.resolve({ wp: { connection_id: 1, project_op_id: 0, project_name: null } })).toEqual({
      op_id: null,
      name: null,
      identifier: null,
    });
    expect(
      r.resolve({
        wp: { connection_id: 1, project_op_id: 0, project_name: null },
        baselineRawJson: baselineJson("/api/v3/projects/7", "Tidewater"),
        connectionId: 1,
      }),
    ).toEqual({ op_id: 7, name: "Tidewater", identifier: "tidewater" });
  });

  it("baseline raw_json fallback: href → op_id, row name (else title) → name, identifier via the keyed lookup", () => {
    expect(
      r.resolve({ baselineRawJson: baselineJson("/api/v3/projects/42", "Harbor Ops (baseline)"), connectionId: 2 }),
    ).toEqual({ op_id: 42, name: "Harbor Ops", identifier: "harbor-ops" });
  });

  it("baseline without a connection and an ambiguous op_id → null identifier", () => {
    expect(
      r.resolve({ baselineRawJson: baselineJson("/api/v3/projects/42", "Somebody"), connectionId: null }),
    ).toEqual({ op_id: 42, name: "Somebody", identifier: null });
  });

  it("nothing known → all null; corrupt baseline JSON never throws", () => {
    expect(r.resolve({})).toEqual({ op_id: null, name: null, identifier: null });
    expect(r.resolve({ baselineRawJson: "{not json" })).toEqual({ op_id: null, name: null, identifier: null });
    expect(r.resolve({ baselineRawJson: "{}" })).toEqual({ op_id: null, name: null, identifier: null });
  });

  it("lookup(): connection-scoped row access for op_id-only callers", () => {
    expect(r.lookup(2, 42)?.identifier).toBe("harbor-ops");
    expect(r.lookup(3, 42)).toBeNull();
    expect(r.lookup(null, 42)).toBeNull();
    expect(r.lookup(1, 0)).toBeNull();
  });

  it("projectLinkFromRawJson parses href/title", () => {
    expect(projectLinkFromRawJson(baselineJson("/api/v3/projects/12", "X"))).toEqual({ op_id: 12, title: "X" });
    expect(projectLinkFromRawJson(null)).toEqual({ op_id: null, title: null });
  });
});

describe("planPdfProjects — PDF 'Project' column, legend, single-project rule (§2.B4)", () => {
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));

  it("two projects → column + legend sorted by identifier", () => {
    const plan = planPdfProjects(
      [
        { key: "1:42", name: "Northwind Payments", identifier: "northwind" },
        { key: "1:7", name: "Harbor Ops", identifier: "harbor-ops" },
        { key: "1:42", name: "Northwind Payments", identifier: "northwind" },
      ],
      esc,
    );
    expect(plan.showColumn).toBe(true);
    expect(plan.headerHtml).toBeNull();
    expect(plan.thHtml).toBe("<th>Project</th>");
    expect(plan.tdHtml({ key: "1:42", name: "Northwind Payments", identifier: "northwind" })).toBe(
      '<td><span class="proj" title="Northwind Payments">northwind</span></td>',
    );
    expect(plan.legendHtml).toBe(
      '<p class="proj-legend">Projects: harbor-ops — Harbor Ops · northwind — Northwind Payments</p>',
    );
  });

  it("single project → no column, no legend, sub-header line instead", () => {
    const plan = planPdfProjects(
      [
        { key: "1:42", name: "Northwind Payments", identifier: "northwind" },
        { key: "1:42", name: "Northwind Payments", identifier: "northwind" },
      ],
      esc,
    );
    expect(plan.showColumn).toBe(false);
    expect(plan.thHtml).toBe("");
    expect(plan.tdHtml({ key: "1:42", name: "x", identifier: "y" })).toBe("");
    expect(plan.legendHtml).toBe("");
    expect(plan.headerHtml).toBe("Project: Northwind Payments (northwind)");
  });

  it("one project plus a — row → column stays (the single-project rule needs every row resolved)", () => {
    const plan = planPdfProjects(
      [
        { key: "1:42", name: "Northwind Payments", identifier: "northwind" },
        { key: null, name: null, identifier: null },
      ],
      esc,
    );
    expect(plan.showColumn).toBe(true);
    expect(plan.tdHtml({ key: null, name: null, identifier: null })).toBe("<td>—</td>");
    expect(plan.legendHtml).toContain("northwind — Northwind Payments");
  });

  it("identifier missing → name shown; all rows — → column, no legend", () => {
    const plan = planPdfProjects(
      [
        { key: "1:5", name: "Hidden Project", identifier: null },
        { key: "1:6", name: null, identifier: null },
      ],
      esc,
    );
    expect(plan.tdHtml({ key: "1:5", name: "Hidden Project", identifier: null })).toContain(">Hidden Project<");
    expect(plan.legendHtml).toBe('<p class="proj-legend">Projects: Hidden Project</p>');
    const none = planPdfProjects([{ key: null, name: null, identifier: null }], esc);
    expect(none.showColumn).toBe(true);
    expect(none.legendHtml).toBe("");
  });

  it("zero rows → nothing at all", () => {
    const plan = planPdfProjects([], esc);
    expect(plan).toMatchObject({ showColumn: false, headerHtml: null, thHtml: "", legendHtml: "" });
  });

  it("escapes name/identifier in cell, tooltip, legend and header", () => {
    const evil = { key: "1:1", name: `<b>"A&B"</b>`, identifier: "x<y" };
    const multi = planPdfProjects([evil, { key: "1:2", name: "Other", identifier: "other" }], esc);
    const td = multi.tdHtml(evil);
    expect(td).not.toContain("<b>");
    expect(td).toContain("x&lt;y");
    expect(td).toContain('title="&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;"');
    expect(multi.legendHtml).toContain("x&lt;y — &lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
    const single = planPdfProjects([evil], esc);
    expect(single.headerHtml).toBe("Project: &lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt; (x&lt;y)");
  });
});
