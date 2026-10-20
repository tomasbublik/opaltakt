import { describe, expect, it } from "vitest";
import type { ImportsResponse, ProjectsResponse, SprintResponse } from "@osp/contracts";
import type { OpClient, OpClientConfig, OpWorkPackage } from "@osp/op-client";
import {
  activateSprint,
  addConnection,
  buildTestApp,
  initVault,
  makeFakeOpClient,
} from "../test-utils";

/**
 * Multi-server registry follow-ups (found via live production use, not in the
 * original spec): grouped-by-server project picker, per-server Disconnect/
 * Connect toggle, and cascading import removal. See osp-sprint-lifecycle memory
 * for the companion SPRINT_NOT_ACTIVE self-heal fix from the same session.
 */

describe("GET /api/projects across multiple connections", () => {
  it("tags every project with its own server and excludes a disabled server's", async () => {
    const t = await buildTestApp({
      opClientFactory: (config: OpClientConfig): OpClient =>
        makeFakeOpClient({
          projects:
            config.baseUrl === "https://op-a.example.com"
              ? [{ _type: "Project", id: 1, identifier: "platform", name: "Platform" }]
              : [{ _type: "Project", id: 1, identifier: "demo", name: "Demo Project" }],
        }),
    });
    await initVault(t);
    const a = (await addConnection(t, { base_url: "https://op-a.example.com" })) as { id: number };
    const b = (await addConnection(t, { base_url: "https://op-b.example.com" })) as { id: number };

    const res = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    const projects = res.json<ProjectsResponse>();
    expect(projects).toHaveLength(2);
    const byName = new Map(projects.map((p) => [p.name, p]));
    expect(byName.get("Platform")?.connection_id).toBe(a.id);
    expect(byName.get("Platform")?.connection_base_url).toBe("https://op-a.example.com");
    expect(byName.get("Demo Project")?.connection_id).toBe(b.id);

    // Disconnect server B — its cached project drops out of the picker without
    // deleting anything (SPEC ask #4).
    const disc = await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${b.id}`,
      payload: { enabled: false },
    });
    expect(disc.statusCode).toBe(200);
    expect(disc.json().enabled).toBe(false);

    const res2 = await t.app.inject({ method: "GET", url: "/api/projects" });
    const projects2 = res2.json<ProjectsResponse>();
    expect(projects2.map((p) => p.name)).toEqual(["Platform"]);

    // Reconnect — it reappears (nothing was deleted).
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${b.id}`,
      payload: { enabled: true },
    });
    const res3 = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(res3.json<ProjectsResponse>().map((p) => p.name).sort()).toEqual([
      "Demo Project",
      "Platform",
    ]);
    await t.close();
  });

  it("a single connection keeps the original hard-fail behaviour (locked vault / no token)", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);
    await t.app.inject({ method: "POST", url: "/api/vault/lock" });
    const res = await t.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(423);
    await t.close();
  });
});

describe("SPEC_10 §e — sprint operations scoped to the sprint's own connections", () => {
  it("Update and Finish a mock-only sprint never contact an unrelated disconnected connection", async () => {
    const ACME = "https://openproject.acme.example";
    const MOCK = "https://op-a.example.com";
    // Every OP client the app builds records its base_url here — the disconnected
    // acme connection must NEVER appear (SPEC_10 §e acceptance / DoD).
    const factoryCalls: string[] = [];
    const wp: OpWorkPackage = {
      _type: "WorkPackage",
      id: 1001,
      subject: "Mock ticket",
      estimatedTime: "PT8H",
      remainingTime: "PT8H",
      spentTime: null,
      updatedAt: "2026-06-01T00:00:00Z",
      _links: {
        self: { href: "/api/v3/work_packages/1001" },
        status: { href: "/api/v3/statuses/1", title: "New" },
        type: { href: "/api/v3/types/1", title: "Task" },
        project: { href: "/api/v3/projects/100", title: "Project A" },
      },
    };
    const t = await buildTestApp({
      opClientFactory: (config: OpClientConfig): OpClient => {
        factoryCalls.push(config.baseUrl);
        return makeFakeOpClient({
          statuses: [{ _type: "Status", id: 1, name: "New", isClosed: false }],
          workPackages: [wp],
        });
      },
    });
    await initVault(t);
    const mockConn = (await addConnection(t, { base_url: MOCK })) as { id: number };
    const acme = (await addConnection(t, { base_url: ACME })) as { id: number };
    // acme is present but DISCONNECTED — and unused by this sprint.
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${acme.id}`,
      payload: { enabled: false },
    });

    // The sprint's ONE ticket lives on the mock connection (connection_id = mock).
    await t.repos.workPackages.upsertMany([
      {
        op_id: 1001,
        connection_id: mockConn.id,
        project_op_id: 100,
        subject: "Mock ticket",
        type_name: "Task",
        status_name: "New",
        status_is_closed: false,
        assignee_op_id: null,
        assignee_name: null,
        estimated_hours: 8,
        remaining_hours: 8,
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

    const sprintRes = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "mock-only", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprintId = (sprintRes.json() as SprintResponse).id;
    await t.app.inject({
      method: "POST",
      url: `/api/sprints/${sprintId}/items`,
      payload: { wp_op_id: 1001 },
    });
    await activateSprint(t, sprintId);

    // Only care about which connections Update/Finish touch.
    factoryCalls.length = 0;

    const upd = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/update` });
    expect(upd.statusCode, upd.payload).toBe(200);

    const fin = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/finish` });
    expect(fin.statusCode, fin.payload).toBe(200);

    // The disconnected acme connection was never contacted: no CONNECTION_DISABLED,
    // and no OP client was ever built for its base_url during Update/Finish.
    expect(factoryCalls).not.toContain(ACME);
    expect(factoryCalls.length).toBeGreaterThan(0); // mock WAS contacted
    expect(factoryCalls.every((u) => u === MOCK)).toBe(true);
    await t.close();
  });
});

describe("POST /api/sync against a disabled connection", () => {
  it("refuses with CONNECTION_DISABLED, without touching the connection's data", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.app.inject({
      method: "PATCH",
      url: `/api/connections/${conn.id}`,
      payload: { enabled: false },
    });
    const res = await t.app.inject({
      method: "POST",
      url: "/api/sync",
      payload: { project_op_id: 100, connection_id: conn.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONNECTION_DISABLED");
    await t.close();
  });
});

describe("DELETE /api/imports/:id — cascade to the local backlog", () => {
  async function seedTicket(
    t: Awaited<ReturnType<typeof buildTestApp>>,
    opId: number,
    connectionId: number,
  ) {
    await t.repos.workPackages.upsertMany([
      {
        connection_id: connectionId,
        op_id: opId,
        project_op_id: 100,
        subject: `WP ${opId}`,
        type_name: "Task",
        status_name: "New",
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
      },
    ]);
  }

  it("removes backlog + planning-sprint tickets, but never active/closed-sprint tickets", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    const sel = await t.repos.importSelections.upsert({
      connection_id: conn.id,
      project_op_id: 100,
      project_name: "Platform",
      version_op_id: null,
      version_name: null,
    });

    // Four tickets from the same import: one plain backlog ticket, one in a
    // planning sprint, one in an active sprint, one in a closed sprint.
    await seedTicket(t, 1, conn.id); // backlog only
    await seedTicket(t, 2, conn.id); // planning sprint
    await seedTicket(t, 3, conn.id); // active sprint
    await seedTicket(t, 4, conn.id); // closed sprint

    const planning = await t.repos.sprints.create({
      name: "Planning sprint",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    const active = await t.repos.sprints.create({
      name: "Active sprint",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await t.repos.sprints.update(active.id, { status: "active" });
    const closed = await t.repos.sprints.create({
      name: "Closed sprint",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await t.repos.sprints.update(closed.id, { status: "closed" });

    await t.repos.sprintItems.add({
      sprint_id: planning.id,
      wp_op_id: 2,
      planned_hours: 4,
      outcome: "planned",
      origin: "baseline",
    });
    await t.repos.sprintItems.add({
      sprint_id: active.id,
      wp_op_id: 3,
      planned_hours: 4,
      outcome: "planned",
      origin: "baseline",
    });
    await t.repos.sprintItems.add({
      sprint_id: closed.id,
      wp_op_id: 4,
      planned_hours: 4,
      outcome: "planned",
      origin: "baseline",
    });

    const res = await t.app.inject({ method: "DELETE", url: `/api/imports/${sel.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      deleted: true,
      removed_ticket_count: 2, // backlog-only (1) + planning-sprint (2)
      protected_ticket_count: 2, // active-sprint (3) + closed-sprint (4)
    });

    // The import selection itself is gone.
    const imports = (await t.app.inject({ method: "GET", url: "/api/imports" })).json<ImportsResponse>();
    expect(imports.find((i) => i.id === sel.id)).toBeUndefined();

    // Removed tickets are gone from the cache entirely.
    expect(await t.repos.workPackages.getByOpId(1)).toBeNull();
    expect(await t.repos.workPackages.getByOpId(2)).toBeNull();
    // Protected tickets survive, and their sprint_item rows are untouched.
    expect(await t.repos.workPackages.getByOpId(3)).not.toBeNull();
    expect(await t.repos.workPackages.getByOpId(4)).not.toBeNull();
    expect(await t.repos.sprintItems.getBySprintAndWp(active.id, 3)).not.toBeNull();
    expect(await t.repos.sprintItems.getBySprintAndWp(closed.id, 4)).not.toBeNull();
    // The planning-sprint item row was deleted (not just the cache row).
    expect(await t.repos.sprintItems.getBySprintAndWp(planning.id, 2)).toBeNull();

    await t.close();
  });

  it("never calls OpenProject and 404s for an unknown import id", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);
    const res = await t.app.inject({ method: "DELETE", url: "/api/imports/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("IMPORT_NOT_FOUND");
    await t.close();
  });
});
