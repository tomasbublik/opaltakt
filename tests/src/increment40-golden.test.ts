import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import {
  S22_PROJECTS,
  S22_SERVER2_PROJECT,
  S22_SERVER2_WP,
  S22_WP,
} from "@osp/fixtures/scenarios";
import type {
  BacklogFilterOptionsResponse,
  BacklogItem,
  ClosureStatsResponse,
  SprintItemDetail,
  TicketEstimateLine,
} from "@osp/contracts";
import {
  activateSprint,
  addConnection,
  bootRealApp,
  call,
  connectToOp,
  rawQuery,
  type RealApp,
} from "./harness";
import { addDays, mockAdmin } from "./scenario-helpers";
// apps/api sources, imported directly (relative path) exactly like
// sprint-freeze.test.ts does — @osp/api is not a declared dependency.
import { freezeSprint } from "../../apps/api/src/logic/freeze";
import { createSprintLifecycle } from "../../apps/api/src/logic/sprintUpdate";

/**
 * GOLDEN TESTS — Increment 40: the OpenProject project of every ticket
 * (docs/INCREMENT_40_CONTRACTS.md §1–§3, Agent D; CAPACITY_BAR_RULES §6
 * invariant 10 extension).
 *
 * The user's complaint: no surface says which OP project a ticket belongs to
 * (only the browser URL `/projects/<identifier>/work_packages/<id>` does).
 * These encode the target behaviour end-to-end — REAL app (in-process
 * Fastify), REAL op-client + sync, against the stateful mock serving the
 * fictional S22 pair (fixtures/scenarios/s22-multi-project.ts):
 *
 *   A. one server, tickets from northwind + harbor-ops + a HIDDEN project:
 *      backlog, items/detailed and closure stats expose the right
 *      project_op_id / project_name / project_identifier per ticket; the
 *      hidden project's name comes from the WP payload and its identifier is
 *      null; filter-options `projects` are keyed entries; `projectKey`
 *      filters (and beats the legacy `projectId`).
 *   B. two servers, the SAME project op_id 8700 naming two different projects:
 *      names/identifiers never bleed across, `projectKey` isolates them.
 *   C. a FROZEN sprint keeps the pre-rename name/identifier after a mock
 *      rename + full resync, AND after deleting its cache rows and every
 *      `project` row (freeze is a snapshot — §1.3 / invariant 10).
 *
 * Written FIRST (the identity-golden pattern): RED until Agents A (schema +
 * project refresh) and B (resolver + surfaces) land.
 *
 * Guardrail: PGlite only (bootRealApp's ephemeral default) + ephemeral
 * recording mocks — no real database, no fixed port, nothing that can reach
 * the user's `osp`.
 */

const NW = S22_PROJECTS.northwind;
const HB = S22_PROJECTS.harbor;
const HIDDEN = S22_PROJECTS.hidden;

interface ProjectFields {
  project_op_id: number | null;
  project_name: string | null;
  project_identifier: string | null;
}

function pick(row: ProjectFields | undefined): ProjectFields | undefined {
  if (row === undefined) return undefined;
  return {
    project_op_id: row.project_op_id,
    project_name: row.project_name,
    project_identifier: row.project_identifier,
  };
}

/** Expected project fields per S22 server-one ticket (live, unrenamed). */
const EXPECT_ONE: Record<number, ProjectFields> = {
  [S22_WP.nwSettlement]: { project_op_id: NW.id, project_name: NW.name, project_identifier: NW.identifier },
  [S22_WP.nwRefundRetry]: { project_op_id: NW.id, project_name: NW.name, project_identifier: NW.identifier },
  [S22_WP.hbBerthImport]: { project_op_id: HB.id, project_name: HB.name, project_identifier: HB.identifier },
  [S22_WP.hbCraneAlert]: { project_op_id: HB.id, project_name: HB.name, project_identifier: HB.identifier },
  [S22_WP.hbGateFirmware]: { project_op_id: HB.id, project_name: HB.name, project_identifier: HB.identifier },
  // Hidden project: /projects/{id} 404s → identifier unknown; the name is the
  // WP payload's `_links.project.title` (§1.1).
  [S22_WP.hiddenAuthBump]: { project_op_id: HIDDEN.id, project_name: HIDDEN.name, project_identifier: null },
};

const EXPECT_TWO: Record<number, ProjectFields> = {
  [S22_SERVER2_WP.nlRouteOptimiser]: {
    project_op_id: S22_SERVER2_PROJECT.id,
    project_name: S22_SERVER2_PROJECT.name,
    project_identifier: S22_SERVER2_PROJECT.identifier,
  },
  [S22_SERVER2_WP.nlDockManifest]: {
    project_op_id: S22_SERVER2_PROJECT.id,
    project_name: S22_SERVER2_PROJECT.name,
    project_identifier: S22_SERVER2_PROJECT.identifier,
  },
};

// ── plumbing ─────────────────────────────────────────────────────────────────

interface World {
  harness: RealApp;
  mock1: RecordingMockOpServer;
  mock2?: RecordingMockOpServer;
  conn1: number;
  conn2?: number;
  d0: string;
}

async function ok(app: RealApp["app"], method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<unknown> {
  const res = await call(app, method, url, body);
  expect(res.status, `${method} ${url} → ${JSON.stringify(res.json).slice(0, 400)}`).toBeLessThan(300);
  return res.json;
}

/**
 * Server one: load S22, connect, import both visible projects, visit the
 * project picker (GET /api/projects — the hidden one is not listed), and add
 * the hidden project's ticket by id (the realistic way such a ticket arrives:
 * the user can see the WP but not its project).
 */
async function setUpWorld(opts: { secondServer: boolean }): Promise<World> {
  const mock1 = await createRecordingMockOpServer();
  const admin1 = mockAdmin(mock1.url);
  await admin1.requireScenario("s22-multi-project");
  const loaded = await admin1.load("s22-multi-project");
  const harness = await bootRealApp();
  const app = harness.app;

  const c1 = await connectToOp(app, mock1.url, "s22-token-one");
  expect(c1.status, JSON.stringify(c1.json)).toBeLessThan(300);
  const conn1 = (c1.json as { id: number }).id;

  await ok(app, "GET", "/api/projects");
  await ok(app, "POST", "/api/sync", { project_op_id: NW.id, connection_id: conn1 });
  await ok(app, "POST", "/api/sync", { project_op_id: HB.id, connection_id: conn1 });
  await ok(app, "POST", "/api/work-packages", { op_id: S22_WP.hiddenAuthBump });

  const world: World = { harness, mock1, conn1, d0: loaded.date! };
  if (opts.secondServer) {
    const mock2 = await createRecordingMockOpServer();
    const admin2 = mockAdmin(mock2.url);
    await admin2.load("s22-multi-project-server2");
    const c2 = await addConnection(app, mock2.url, "s22-token-two", { label: "Second server" });
    expect(c2.status, JSON.stringify(c2.json)).toBeLessThan(300);
    const conn2 = (c2.json as { id: number }).id;
    expect(conn2).not.toBe(conn1);
    await ok(app, "GET", "/api/projects");
    await ok(app, "POST", "/api/sync", { project_op_id: S22_SERVER2_PROJECT.id, connection_id: conn2 });
    world.mock2 = mock2;
    world.conn2 = conn2;
  }
  return world;
}

async function tearDown(w: World | undefined): Promise<void> {
  if (!w) return;
  await w.harness.close();
  await w.mock1.close();
  await w.mock2?.close();
}

async function backlog(app: RealApp["app"], query = ""): Promise<BacklogItem[]> {
  return (await ok(app, "GET", `/api/backlog${query}`)) as BacklogItem[];
}

async function filterOptions(app: RealApp["app"], query = ""): Promise<BacklogFilterOptionsResponse> {
  return (await ok(app, "GET", `/api/backlog/filter-options${query}`)) as BacklogFilterOptionsResponse;
}

async function itemsDetailed(app: RealApp["app"], sprintId: number): Promise<SprintItemDetail[]> {
  return (await ok(app, "GET", `/api/sprints/${sprintId}/items/detailed`)) as SprintItemDetail[];
}

async function closurePerTicket(app: RealApp["app"], sprintId: number): Promise<TicketEstimateLine[]> {
  return ((await ok(app, "GET", `/api/sprints/${sprintId}/closure-stats`)) as ClosureStatsResponse).per_ticket;
}

async function createSprint(w: World, name: string, wpIds: number[]): Promise<number> {
  const created = (await ok(w.harness.app, "POST", "/api/sprints", {
    name,
    start_date: w.d0,
    end_date: addDays(w.d0, 8),
  })) as { id: number };
  for (const wp of wpIds) await ok(w.harness.app, "POST", `/api/sprints/${created.id}/items`, { wp_op_id: wp });
  return created.id;
}

function byWp<T extends { op_id?: number; wp_op_id?: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((r) => [(r.wp_op_id ?? r.op_id)!, r]));
}

function expectProjects(
  label: string,
  rows: Map<number, ProjectFields>,
  expected: Record<number, ProjectFields>,
  ids: number[],
): void {
  for (const id of ids) {
    expect(pick(rows.get(id)), `${label}: #${id}`).toEqual(expected[id]);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// A — one server, two visible projects + one hidden project
// ═════════════════════════════════════════════════════════════════════════════

describe("GOLDEN Increment 40 A — every ticket surface names its project (S22, one server)", () => {
  let w: World | undefined;
  let sprintId = 0;
  const SPRINT_WPS = [S22_WP.nwSettlement, S22_WP.nwRefundRetry, S22_WP.hbBerthImport, S22_WP.hbCraneAlert, S22_WP.hiddenAuthBump];

  beforeAll(async () => {
    w = await setUpWorld({ secondServer: false });
    sprintId = await createSprint(w, "inc40 multi-project sprint", SPRINT_WPS);
    await activateSprint(w.harness.app, sprintId);
  });
  afterAll(async () => {
    await tearDown(w);
  });

  it("GET /api/backlog: project_op_id / project_name / project_identifier per ticket (hidden ⇒ payload name, null identifier)", async () => {
    const rows = byWp(await backlog(w!.harness.app));
    expectProjects("backlog", rows, EXPECT_ONE, Object.keys(EXPECT_ONE).map(Number));
  });

  it("GET /sprints/:id/items/detailed: same project fields (live sprint)", async () => {
    const rows = byWp(await itemsDetailed(w!.harness.app, sprintId));
    expectProjects("items/detailed", rows, EXPECT_ONE, SPRINT_WPS);
  });

  it("GET /sprints/:id/closure-stats per_ticket: project_op_id / name / identifier (§3 TicketEstimateLine)", async () => {
    const rows = byWp(await closurePerTicket(w!.harness.app, sprintId));
    expectProjects("closure per_ticket", rows, EXPECT_ONE, SPRINT_WPS);
  });

  it("filter-options `projects` are keyed FilterOptionEntry[] sorted by name, the hidden project named from the payload", async () => {
    const opts = await filterOptions(w!.harness.app);
    const c = w!.conn1;
    expect(opts.projects.map((p) => ({ id: p.id, name: p.name, key: p.key, connection_id: p.connection_id }))).toEqual([
      { id: HB.id, name: HB.name, key: `${c}:${HB.id}`, connection_id: c },
      { id: HIDDEN.id, name: HIDDEN.name, key: `${c}:${HIDDEN.id}`, connection_id: c },
      { id: NW.id, name: NW.name, key: `${c}:${NW.id}`, connection_id: c },
    ]);
  });

  it("`projectKey` filters the backlog to one project and takes precedence over the legacy `projectId`", async () => {
    const c = w!.conn1;
    const harbor = await backlog(w!.harness.app, `?projectKey=${encodeURIComponent(`${c}:${HB.id}`)}`);
    expect(harbor.map((r) => r.op_id).sort()).toEqual(
      [S22_WP.hbBerthImport, S22_WP.hbCraneAlert, S22_WP.hbGateFirmware].sort(),
    );
    const both = await backlog(
      w!.harness.app,
      `?projectId=${NW.id}&projectKey=${encodeURIComponent(`${c}:${HB.id}`)}`,
    );
    expect(new Set(both.map((r) => r.project_op_id)), "projectKey wins over projectId").toEqual(new Set([HB.id]));
    const hidden = await backlog(w!.harness.app, `?projectKey=${encodeURIComponent(`${c}:${HIDDEN.id}`)}`);
    expect(hidden.map((r) => r.op_id)).toEqual([S22_WP.hiddenAuthBump]);
  });

  it("the app stayed GET-only towards OpenProject and did ask /projects/{id} for the hidden project (best-effort 404)", () => {
    const api = w!.mock1.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(api.filter((r) => r.method !== "GET"), "never a non-GET to /api/v3").toEqual([]);
    expect(api.some((r) => r.path === "/api/v3/users"), "never the admin-gated /users").toBe(false);
    expect(
      api.some((r) => r.path === `/api/v3/projects/${HIDDEN.id}`),
      "refreshProjects asks for the hidden project and survives its 404",
    ).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B — two servers, the SAME project op_id naming two different projects
// ═════════════════════════════════════════════════════════════════════════════

describe("GOLDEN Increment 40 B — cross-server project op_id collision (S22 pair)", () => {
  let w: World | undefined;

  beforeAll(async () => {
    w = await setUpWorld({ secondServer: true });
  });
  afterAll(async () => {
    await tearDown(w);
  });

  it("backlog: same project_op_id 8700, different name AND identifier per connection", async () => {
    const rows = byWp(await backlog(w!.harness.app));
    expectProjects("server one", rows, EXPECT_ONE, [S22_WP.nwSettlement, S22_WP.nwRefundRetry]);
    expectProjects("server two", rows, EXPECT_TWO, [S22_SERVER2_WP.nlRouteOptimiser, S22_SERVER2_WP.nlDockManifest]);
    expect(rows.get(S22_SERVER2_WP.nlRouteOptimiser)?.connection_id).toBe(w!.conn2);
    expect(rows.get(S22_WP.nwSettlement)?.connection_id).toBe(w!.conn1);
  });

  it("filter-options: two distinct keyed entries for op_id 8700 (never deduped by id or name)", async () => {
    const opts = await filterOptions(w!.harness.app);
    const p8700 = opts.projects.filter((p) => p.id === NW.id);
    expect(
      p8700.map((p) => ({ key: p.key, name: p.name })).sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual(
      [
        { key: `${w!.conn1}:${NW.id}`, name: NW.name },
        { key: `${w!.conn2}:${NW.id}`, name: S22_SERVER2_PROJECT.name },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it("projectKey isolates each server's 8700 — no cross-server leak", async () => {
    const one = await backlog(w!.harness.app, `?projectKey=${encodeURIComponent(`${w!.conn1}:${NW.id}`)}`);
    expect(one.map((r) => r.op_id).sort()).toEqual([S22_WP.nwSettlement, S22_WP.nwRefundRetry].sort());
    const two = await backlog(w!.harness.app, `?projectKey=${encodeURIComponent(`${w!.conn2}:${NW.id}`)}`);
    expect(two.map((r) => r.op_id).sort()).toEqual(
      [S22_SERVER2_WP.nlRouteOptimiser, S22_SERVER2_WP.nlDockManifest].sort(),
    );
  });

  it("items/detailed + closure per_ticket of a sprint mixing both servers' 8700 keep the two names apart", async () => {
    const ids = [S22_WP.nwSettlement, S22_SERVER2_WP.nlRouteOptimiser];
    const sprintId = await createSprint(w!, "inc40 cross-server sprint", ids);
    const expected = { ...EXPECT_ONE, ...EXPECT_TWO };
    expectProjects("items/detailed", byWp(await itemsDetailed(w!.harness.app, sprintId)), expected, ids);
    expectProjects("closure per_ticket", byWp(await closurePerTicket(w!.harness.app, sprintId)), expected, ids);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C — a frozen sprint keeps its project AS IT WAS at freeze time
// ═════════════════════════════════════════════════════════════════════════════

describe("GOLDEN Increment 40 C — frozen sprint keeps the pre-rename project (invariant 10 extension)", () => {
  let w: World | undefined;
  let sprintId = 0;
  const FROZEN_WPS = [S22_WP.nwSettlement, S22_WP.hbBerthImport, S22_WP.hiddenAuthBump];

  beforeAll(async () => {
    w = await setUpWorld({ secondServer: false });
    const app = w.harness.app;
    sprintId = await createSprint(w, "inc40 frozen sprint", FROZEN_WPS);
    await activateSprint(app, sprintId);
    await ok(app, "POST", `/api/sprints/${sprintId}/finish`);
    // Freeze NOW (the sweep's deadline gating is not under test). The final
    // best-effort update is skipped via a client-less lifecycle, exactly like
    // sprint-freeze.test.ts — the cache is already current.
    const frozenNow = new Date();
    const lifecycle = createSprintLifecycle({
      repos: w.harness.repos,
      buildClientForConnection: async () => {
        throw new Error("freeze's final update is not under test");
      },
      snapshotWriterFactory: () => ({
        writeSnapshot: async () => {},
        writeSnapshotsForActiveSprints: async () => {},
      }),
      now: () => frozenNow,
    });
    await freezeSprint({ repos: w.harness.repos, sprintLifecycle: lifecycle, now: () => frozenNow, log: () => {} }, sprintId);
    expect((await w.harness.repos.sprints.getById(sprintId))!.frozen_at, "precondition: frozen").not.toBeNull();
  });
  afterAll(async () => {
    await tearDown(w);
  });

  it("freezes the project fields into the snapshot (frozen_project_op_id / name / identifier)", async () => {
    const snap = await w!.harness.repos.sprintItems.listFrozenSnapshot(sprintId);
    const items = await w!.harness.repos.sprintItems.listBySprint(sprintId);
    const wpOf = new Map(items.map((i) => [i.id, i.wp_op_id]));
    const got = new Map(
      snap.map((s) => [
        wpOf.get(s.item_id)!,
        {
          project_op_id: s.frozen_project_op_id,
          project_name: s.frozen_project_name,
          project_identifier: s.frozen_project_identifier,
        },
      ]),
    );
    expectProjects("frozen snapshot", got, EXPECT_ONE, FROZEN_WPS);
  });

  it("after a mock RENAME + full resync, live surfaces follow the rename but the frozen sprint does not; nor after deleting cache + project rows", async () => {
    const app = w!.harness.app;
    const before = {
      items: byWp(await itemsDetailed(app, sprintId)),
      closure: byWp(await closurePerTicket(app, sprintId)),
    };
    expectProjects("frozen items/detailed (pre-rename)", before.items, EXPECT_ONE, FROZEN_WPS);
    expectProjects("frozen closure (pre-rename)", before.closure, EXPECT_ONE, FROZEN_WPS);

    // Rename two projects in "OpenProject" (op_id unchanged — identity).
    const admin = mockAdmin(w!.mock1.url);
    await admin.renameProject(NW.id, { name: "Northwind Card Services", identifier: "nw-cards" });
    await admin.renameProject(HIDDEN.id, { name: "Lighthouse Core" });
    // A project rename does not bump any WP's updatedAt (real OP behaves the
    // same), so only a FULL refresh is guaranteed to re-read every WP payload.
    await ok(app, "GET", "/api/projects");
    await ok(app, "POST", "/api/sync", { full_refresh: true });

    // Sanity: the LIVE (non-frozen) surface did pick the rename up — otherwise
    // the frozen assertions below would pass vacuously.
    const live = byWp(await backlog(app));
    expect(pick(live.get(S22_WP.nwRefundRetry)), "live backlog follows the rename").toEqual({
      project_op_id: NW.id,
      project_name: "Northwind Card Services",
      project_identifier: "nw-cards",
    });

    const afterRename = {
      items: byWp(await itemsDetailed(app, sprintId)),
      closure: byWp(await closurePerTicket(app, sprintId)),
    };
    expectProjects("frozen items/detailed (post-rename)", afterRename.items, EXPECT_ONE, FROZEN_WPS);
    expectProjects("frozen closure (post-rename)", afterRename.closure, EXPECT_ONE, FROZEN_WPS);

    // Now remove every live source a careless reader could fall back to.
    await rawQuery(w!.harness.raw, "DELETE FROM work_package_cache WHERE op_id = ANY($1::int[])", [FROZEN_WPS]);
    await rawQuery(w!.harness.raw, "DELETE FROM project");
    const gone = await rawQuery<{ n: number }>(
      w!.harness.raw,
      "SELECT count(*)::int AS n FROM work_package_cache WHERE op_id = ANY($1::int[])",
      [FROZEN_WPS],
    );
    expect(gone[0]!.n, "precondition: cache rows deleted").toBe(0);

    const afterDelete = {
      items: byWp(await itemsDetailed(app, sprintId)),
      closure: byWp(await closurePerTicket(app, sprintId)),
    };
    expectProjects("frozen items/detailed (cache+project deleted)", afterDelete.items, EXPECT_ONE, FROZEN_WPS);
    expectProjects("frozen closure (cache+project deleted)", afterDelete.closure, EXPECT_ONE, FROZEN_WPS);
  });
});
