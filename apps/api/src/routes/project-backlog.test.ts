import { describe, expect, it } from "vitest";
import {
  BacklogFilterOptionsResponse,
  BacklogResponse,
  OutOfSelectionResponse,
} from "@osp/contracts";
import { addConnection, buildTestApp, initVault } from "../test-utils";

/**
 * Increment 40 (docs/INCREMENT_40_CONTRACTS.md §2.B2/§2.B3) — the backlog's
 * project column + filter, connection-safe. Two fictional servers share
 * project op_id 42 (northwind on A, harbor-ops on B): same id, different
 * project — exactly the Increment-23 collision class.
 */

function wpRow(over: {
  op_id: number;
  connection_id: number | null;
  project_op_id: number;
  project_name: string | null;
  status_name?: string;
}) {
  return {
    connection_id: over.connection_id,
    op_id: over.op_id,
    project_op_id: over.project_op_id,
    project_name: over.project_name,
    subject: `WP ${over.op_id}`,
    type_name: "Task",
    status_name: over.status_name ?? "New",
    status_is_closed: false,
    assignee_op_id: null,
    assignee_name: null,
    estimated_hours: 4,
    remaining_hours: 4,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-07-01T00:00:00Z",
    raw_json: "{}",
  };
}

async function seed() {
  const t = await buildTestApp();
  await initVault(t);
  const a = (await addConnection(t, { base_url: "https://a.example.com", label: "A" })) as { id: number };
  const b = (await addConnection(t, { base_url: "https://b.example.com", label: "B" })) as { id: number };
  await t.repos.projects.upsertMany([
    { connection_id: a.id, op_id: 42, identifier: "northwind", name: "Northwind Payments", last_synced_at: null },
    { connection_id: b.id, op_id: 42, identifier: "harbor-ops", name: "Harbor Ops", last_synced_at: null },
  ]);
  await t.repos.workPackages.upsertMany([
    wpRow({ op_id: 1, connection_id: a.id, project_op_id: 42, project_name: "Northwind Payments" }),
    wpRow({ op_id: 2, connection_id: b.id, project_op_id: 42, project_name: "Harbor Ops", status_name: "In progress" }),
    // Project unknown to the `project` table (e.g. 404 on /projects/{id}):
    // the WP payload title is still shown, identifier null.
    wpRow({ op_id: 3, connection_id: a.id, project_op_id: 77, project_name: "Hidden Payload Title" }),
  ]);
  return { t, a: a.id, b: b.id };
}

describe("Increment 40 — backlog project fields + connection-safe project filter", () => {
  it("GET /backlog resolves project_name/project_identifier per (connection, op_id)", async () => {
    const { t } = await seed();
    const rows = BacklogResponse.parse((await t.app.inject({ method: "GET", url: "/api/backlog" })).json());
    const byId = new Map(rows.map((r) => [r.op_id, r]));
    expect(byId.get(1)).toMatchObject({ project_name: "Northwind Payments", project_identifier: "northwind" });
    expect(byId.get(2)).toMatchObject({ project_name: "Harbor Ops", project_identifier: "harbor-ops" });
    expect(byId.get(3)).toMatchObject({ project_name: "Hidden Payload Title", project_identifier: null });
    await t.close();
  });

  it("filter-options: projects are keyed FilterOptionEntry[] — same op_id on two servers stays two entries", async () => {
    const { t, a, b } = await seed();
    const opts = BacklogFilterOptionsResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/backlog/filter-options" })).json(),
    );
    expect(opts.projects.map((p) => [p.key, p.name, p.id, p.connection_id])).toEqual([
      [`${b}:42`, "Harbor Ops", 42, b],
      [`${a}:77`, "Hidden Payload Title", 77, a],
      [`${a}:42`, "Northwind Payments", 42, a],
    ]);
    await t.close();
  });

  it("projectKey filters to ONE server's project; legacy projectId still matches both", async () => {
    const { t, a, b } = await seed();
    const onlyA = BacklogResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/backlog?projectKey=${encodeURIComponent(`${a}:42`)}` })).json(),
    );
    expect(onlyA.map((r) => r.op_id)).toEqual([1]);
    const onlyB = BacklogResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/backlog?projectKey=${encodeURIComponent(`${b}:42`)}` })).json(),
    );
    expect(onlyB.map((r) => r.op_id)).toEqual([2]);
    const legacy = BacklogResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/backlog?projectId=42" })).json(),
    );
    expect(legacy.map((r) => r.op_id).sort()).toEqual([1, 2]);
    await t.close();
  });

  it("projectKey takes precedence over projectId", async () => {
    const { t, a } = await seed();
    const rows = BacklogResponse.parse(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/backlog?projectId=77&projectKey=${encodeURIComponent(`${a}:42`)}`,
        })
      ).json(),
    );
    expect(rows.map((r) => r.op_id)).toEqual([1]);
    await t.close();
  });

  it("cascade: the project facet drops projectId AND projectKey; other facets honour projectKey", async () => {
    const { t, b } = await seed();
    const opts = BacklogFilterOptionsResponse.parse(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/backlog/filter-options?projectId=77&projectKey=${encodeURIComponent(`${b}:42`)}`,
        })
      ).json(),
    );
    // Own facet not narrowed by its own selection.
    expect(opts.projects).toHaveLength(3);
    // Statuses narrowed to server B's project 42 only.
    expect(opts.statuses).toEqual(["In progress"]);
    await t.close();
  });

  it("a projectKey whose connection contradicts another key yields no rows", async () => {
    const { t, a, b } = await seed();
    const rows = BacklogResponse.parse(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/backlog?projectKey=${encodeURIComponent(`${a}:42`)}&versionKey=${encodeURIComponent(`${b}:5`)}`,
        })
      ).json(),
    );
    expect(rows).toEqual([]);
    await t.close();
  });

  it("out-of-selection lists the connection-scoped project name", async () => {
    const { t } = await seed();
    const res = OutOfSelectionResponse.parse(
      (await t.app.inject({ method: "GET", url: "/api/backlog/out-of-selection" })).json(),
    );
    const byId = new Map(res.entries.map((e) => [e.op_id, e]));
    expect(byId.get(1)?.project_name).toBe("Northwind Payments");
    expect(byId.get(2)?.project_name).toBe("Harbor Ops");
    expect(byId.get(3)?.project_name).toBe("Hidden Payload Title");
    await t.close();
  });
});
