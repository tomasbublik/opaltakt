import Fastify from "fastify";
import type { NewWorkPackageCache } from "@osp/db";
import { ErrorResponse, type RouteAccess } from "@osp/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { registerAuth, type AuthUser } from "../auth/index";
import {
  addConnection,
  buildTestApp,
  fakeAuthAs,
  fakeEntraConfig,
  fakeOidc,
  initVault,
  makeFakeOpClient,
  testUser,
  type TestApp,
} from "../test-utils";

/**
 * Increment 39 (docs/INCREMENT_39_CONTRACTS.md §5) — fail-closed authorization.
 *
 * (a) EVERY registered /api route must appear in EXPECTED_ACCESS with exactly
 *     the declared access — adding a route without a decision fails here.
 * (b) A Viewer gets 403 FORBIDDEN_ROLE on every planner route (no side effects,
 *     no OpenProject client ever built) and 200 on reads + report PDFs.
 * (c) Anonymous → 401 UNAUTHENTICATED, signed in without a role → 403 NO_ROLE.
 */

// The decision table. GETs classified "planner" because they CONTACT
// OpenProject (verified in routes/index.ts): /projects, /versions,
// /sprints/:id/retro/preview. Import-screen reads (/imports,
// /backlog/out-of-selection) and the full dump (/data/export) are planner by
// §5. Viewer GETs /sprints/:id/capacity and /sprints/:id/people CAN reach OP
// opportunistically (identity directory / display-name fallback) — for a
// Viewer they run their local-only path (see the "no OP traffic" test below).
const EXPECTED_ACCESS: Record<string, RouteAccess> = {
  "GET /api/version":                                   "public",
  "GET /api/auth/me":                                   "public",
  "GET /api/auth/login":                                "public",
  "GET /api/auth/callback":                             "public",
  "POST /api/auth/logout":                              "public",
  "GET /api/vault/status":                              "viewer",
  "POST /api/vault/init":                               "planner",
  "POST /api/vault/unlock":                             "planner",
  "POST /api/vault/lock":                               "planner",
  "POST /api/vault/change-passphrase":                  "planner",
  "POST /api/vault/reset":                              "planner",
  "GET /api/connections":                               "viewer",
  "POST /api/connections":                              "planner",
  "PATCH /api/connections/:id":                         "planner",
  "DELETE /api/connections/:id":                        "planner",
  "POST /api/connections/:id/test":                     "planner",
  "GET /api/connections/health":                        "viewer",
  "GET /api/connections/health/stream":                 "viewer",
  "GET /api/projects":                                  "planner",
  "POST /api/sync":                                     "planner",
  "GET /api/versions":                                  "planner",
  "GET /api/imports":                                   "planner",
  "DELETE /api/imports/:id":                            "planner",
  "POST /api/work-packages":                            "planner",
  "POST /api/snapshot":                                 "planner",
  "GET /api/sync/status":                               "viewer",
  "POST /api/sync/:runId/cancel":                       "planner",
  "GET /api/backlog/filter-options":                    "viewer",
  "GET /api/backlog":                                   "viewer",
  "GET /api/backlog/out-of-selection":                  "planner",
  "POST /api/backlog/out-of-selection/delete":          "planner",
  "POST /api/backlog/remove":                           "planner",
  "POST /api/estimate-override":                        "planner",
  "GET /api/sprints":                                   "viewer",
  "POST /api/sprints":                                  "planner",
  "PATCH /api/sprints/:id":                             "planner",
  "DELETE /api/sprints/:id":                            "planner",
  "POST /api/sprints/:id/reactivate":                   "planner",
  "GET /api/sprints/:id/items":                         "viewer",
  "GET /api/sprints/:id/items/detailed":                "viewer",
  "POST /api/sprints/:id/items":                        "planner",
  "POST /api/sprints/:id/items/:wpId/carry":            "planner",
  "POST /api/sprints/:id/items/by-id":                  "planner",
  "DELETE /api/sprints/:id/items/:wpId":                "planner",
  "POST /api/sprints/:id/double-count/remove-parents":  "planner",
  "POST /api/sprints/:id/double-count/remove-children": "planner",
  "GET /api/sprints/:id/capacity":                      "viewer",
  "PUT /api/sprints/:id/capacity":                      "planner",
  "GET /api/sprints/:id/capacity-audit":                "viewer",
  "GET /api/sprints/:id/off-sprint-time":               "viewer",
  "GET /api/sprints/:id/people":                        "viewer",
  "GET /api/user-aliases":                              "viewer",
  "POST /api/user-aliases":                             "planner",
  "DELETE /api/user-aliases/:id":                       "planner",
  "GET /api/people":                                    "viewer",
  "PUT /api/people/:id/role":                           "planner",
  "GET /api/done-rules":                                "viewer",
  "PUT /api/done-rules":                                "planner",
  "GET /api/config":                                    "viewer",
  "PUT /api/config":                                    "planner",
  "GET /api/sprints/:id/closure-stats":                 "viewer",
  "GET /api/reports":                                   "viewer",
  "GET /api/reports/:id":                               "viewer",
  "POST /api/reports/:id/pdf":                          "viewer",
  "POST /api/sprints/:id/status-pdf":                   "viewer",
  "GET /api/sprints/:id/burndown":                      "viewer",
  "POST /api/sprints/:id/rebuild-burndown":             "planner",
  "POST /api/sprints/:id/retro/seed":                   "planner",
  "GET /api/sprints/:id/retro/preview":                 "planner",
  "GET /api/sprints/:id/velocity":                      "viewer",
  "POST /api/sprints/:id/close":                        "planner",
  "POST /api/sprints/:id/activate":                     "planner",
  "POST /api/sprints/:id/update":                       "planner",
  "GET /api/sprints/:id/updates":                       "viewer",
  "POST /api/sprints/:id/updates/:runId/cancel":        "planner",
  "POST /api/sprints/:id/finish":                       "planner",
  "GET /api/sprints/:id/tickets/:wpId/changelog":       "viewer",
  "GET /api/sprints/:id/version-export":                "viewer",
  "GET /api/data/export":                               "planner",
  "POST /api/data/import":                              "planner",
};

function key(method: string, url: string): string {
  return `${method} ${url}`;
}

describe("(a) route access table — every /api route has an explicit, expected decision", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it("registered routes == EXPECTED_ACCESS, access matches exactly", async () => {
    t = await buildTestApp();
    const registered = t.app.routeAccess.filter((r) => r.url.startsWith("/api") && r.method !== "HEAD");
    const actual = new Map(registered.map((r) => [key(r.method, r.url), r.access]));

    const missingDecision = [...actual.keys()].filter((k) => !(k in EXPECTED_ACCESS));
    expect(missingDecision, "routes registered without an entry in EXPECTED_ACCESS").toEqual([]);
    const stale = Object.keys(EXPECTED_ACCESS).filter((k) => !actual.has(k));
    expect(stale, "EXPECTED_ACCESS entries with no registered route").toEqual([]);
    for (const [k, access] of actual) {
      expect(access, k).toBe(EXPECTED_ACCESS[k]);
    }
    // Auto-generated HEAD routes inherit their GET's declaration.
    for (const h of t.app.routeAccess.filter((r) => r.method === "HEAD" && r.url.startsWith("/api"))) {
      expect(h.access, `HEAD ${h.url}`).toBe(EXPECTED_ACCESS[key("GET", h.url)]);
    }
    // /health is public too (outside /api, declared anyway).
    expect(t.app.routeAccess.find((r) => r.method === "GET" && r.url === "/health")?.access).toBe("public");
  });

});

describe("(a) the onRoute guard — fail closed at startup", () => {
  it("startup refuses an /api route without config.access", async () => {
    const app = Fastify({ logger: false });
    await registerAuth(app, { config: { mode: "none" } });
    await expect(
      (async () => {
        await app.register(
          async (r) => {
            r.get("/forgotten", async () => ({ ok: true }));
          },
          { prefix: "/api" },
        );
        await app.ready();
      })(),
    ).rejects.toThrow(/declares no valid config\.access/);
    await app.close().catch(() => {});
  });

  it("startup refuses an unknown access value", async () => {
    const app = Fastify({ logger: false });
    await registerAuth(app, { config: { mode: "none" } });
    await expect(
      (async () => {
        app.post("/api/x", { config: { access: "admin" as never } }, async () => ({}));
        await app.ready();
      })(),
    ).rejects.toThrow(/config\.access/);
    await app.close().catch(() => {});
  });
});

function seedWp(op_id: number, connection_id: number | null, o: Partial<NewWorkPackageCache> = {}): NewWorkPackageCache {
  return {
    connection_id,
    op_id,
    project_op_id: 100,
    subject: `WP ${op_id}`,
    type_name: "Task",
    status_name: "In progress",
    status_is_closed: false,
    assignee_op_id: 42,
    assignee_name: "Zoe Dev",
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
    ...o,
  };
}

const PLANNER = testUser(["Planner"], "Pat Planner");
const VIEWER = testUser(["Viewer"], "Vic Viewer");

/** A test app whose acting user can be switched between requests. */
async function switchableApp(): Promise<{ t: TestApp; as: (u: AuthUser | null) => void; opBuilds: () => number; resetOp: () => void }> {
  let who: AuthUser | null = PLANNER;
  let builds = 0;
  const t = await buildTestApp({
    auth: { config: fakeEntraConfig(), oidc: fakeOidc(), resolveUser: () => who },
    opClientFactory: () => {
      builds += 1;
      return makeFakeOpClient();
    },
    pdfRenderer: async () => Buffer.from("%PDF-1.4 stub"),
  });
  return {
    t,
    as: (u) => {
      who = u;
    },
    opBuilds: () => builds,
    resetOp: () => {
      builds = 0;
    },
  };
}

describe("(b) Viewer — reads yes, mutations / OP traffic / config never", () => {
  let ctx: Awaited<ReturnType<typeof switchableApp>>;
  afterEach(async () => ctx.t.close());

  async function seed(): Promise<number> {
    const { t } = ctx;
    await initVault(t);
    await addConnection(t);
    const conn = (await t.repos.connections.getCurrent())!;
    const create = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "S", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    expect(create.statusCode).toBe(201);
    const sprintId = (create.json() as { id: number }).id;
    await t.repos.workPackages.upsertMany([seedWp(1, conn.id), seedWp(2, conn.id, { assignee_op_id: 43, assignee_name: "Yan Dev" })]);
    for (const wp of [1, 2]) {
      const r = await t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/items`, payload: { wp_op_id: wp } });
      expect(r.statusCode).toBe(201);
    }
    return sprintId;
  }

  it("403 FORBIDDEN_ROLE on representative planner routes, with no side effects and no OP client built", async () => {
    ctx = await switchableApp();
    const sprintId = await seed();
    const sprintsBefore = (await ctx.t.repos.sprints.list()).length;
    const itemsBefore = (await ctx.t.repos.sprintItems.listBySprint(sprintId)).length;
    ctx.as(VIEWER);
    ctx.resetOp();

    const denied: Array<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; payload?: unknown }> = [
      { method: "POST", url: "/api/sprints", payload: { name: "X", start_date: "2026-07-01", end_date: "2026-07-14" } },
      { method: "PATCH", url: `/api/sprints/${sprintId}`, payload: { name: "renamed" } },
      { method: "DELETE", url: `/api/sprints/${sprintId}` },
      { method: "POST", url: `/api/sprints/${sprintId}/items`, payload: { wp_op_id: 1 } },
      { method: "DELETE", url: `/api/sprints/${sprintId}/items/1` },
      { method: "POST", url: `/api/sprints/${sprintId}/activate` },
      { method: "POST", url: `/api/sprints/${sprintId}/close` },
      { method: "PUT", url: `/api/sprints/${sprintId}/capacity`, payload: { members: [] } },
      { method: "POST", url: "/api/sync", payload: {} },
      { method: "POST", url: "/api/work-packages", payload: {} },
      { method: "POST", url: "/api/estimate-override", payload: { wp_op_id: 1, planning_hours: 1 } },
      { method: "POST", url: "/api/vault/unlock", payload: { passphrase: "x" } },
      { method: "POST", url: "/api/vault/lock" },
      { method: "POST", url: "/api/connections", payload: {} },
      { method: "PUT", url: "/api/config", payload: {} },
      { method: "PUT", url: "/api/done-rules", payload: {} },
      { method: "POST", url: "/api/data/import", payload: {} },
      { method: "GET", url: "/api/data/export" },
      { method: "GET", url: "/api/projects" },
      { method: "GET", url: "/api/versions?projectId=100" },
      { method: "GET", url: `/api/sprints/${sprintId}/retro/preview` },
      { method: "GET", url: "/api/imports" },
      { method: "GET", url: "/api/backlog/out-of-selection" },
    ];
    for (const d of denied) {
      const res = await ctx.t.app.inject({ method: d.method, url: d.url, ...(d.payload !== undefined ? { payload: d.payload as object } : {}) });
      expect(res.statusCode, `${d.method} ${d.url}`).toBe(403);
      expect(ErrorResponse.parse(res.json()).error.code, `${d.method} ${d.url}`).toBe("FORBIDDEN_ROLE");
    }
    expect((await ctx.t.repos.sprints.list()).length).toBe(sprintsBefore);
    expect((await ctx.t.repos.sprintItems.listBySprint(sprintId)).length).toBe(itemsBefore);
    expect(ctx.t.deps.vault.isLocked()).toBe(false); // the lock attempt did nothing
    expect(ctx.opBuilds(), "a Viewer must never cause an OpenProject client to be built").toBe(0);
  });

  it("200 on reads and the status PDF — and capacity/people reads cause NO OP traffic for a Viewer", async () => {
    ctx = await switchableApp();
    const sprintId = await seed();

    // Control: the same reads as a Planner DO reach for OP (identity directory
    // / name fallback) — so the Viewer's zero below is meaningful.
    ctx.resetOp();
    expect((await ctx.t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).statusCode).toBe(200);
    const plannerBuilds = ctx.opBuilds();
    expect(plannerBuilds).toBeGreaterThan(0);
    type Cap = { lines: Array<{ name: string; op_user_id: number | null; planned_hours: number }> };
    const project = (c: Cap) =>
      c.lines.map((l) => ({ name: l.name, op_user_id: l.op_user_id, planned_hours: l.planned_hours }));
    const plannerCapacity = project(
      (await ctx.t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).json() as Cap,
    );

    ctx.as(VIEWER);
    ctx.resetOp();
    const reads = [
      "/api/sprints",
      `/api/sprints/${sprintId}/items`,
      `/api/sprints/${sprintId}/items/detailed`,
      `/api/sprints/${sprintId}/capacity`,
      `/api/sprints/${sprintId}/capacity-audit`,
      `/api/sprints/${sprintId}/people`,
      `/api/sprints/${sprintId}/off-sprint-time`,
      `/api/sprints/${sprintId}/burndown`,
      `/api/sprints/${sprintId}/velocity`,
      `/api/sprints/${sprintId}/updates`,
      `/api/sprints/${sprintId}/tickets/1/changelog`,
      `/api/sprints/${sprintId}/version-export`,
      "/api/backlog",
      "/api/backlog/filter-options",
      "/api/people",
      "/api/done-rules",
      "/api/config",
      "/api/connections",
      "/api/connections/health",
      "/api/sync/status",
      "/api/vault/status",
      "/api/reports",
      "/api/auth/me",
    ];
    for (const url of reads) {
      const res = await ctx.t.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    // Same numbers for the Viewer (fake OP adds nothing the cache doesn't know).
    expect(
      project((await ctx.t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).json() as Cap),
    ).toEqual(plannerCapacity);
    const pdf = await ctx.t.app.inject({ method: "POST", url: `/api/sprints/${sprintId}/status-pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(ctx.opBuilds(), "Viewer reads must not build an OP client").toBe(0);

    const me = (await ctx.t.app.inject({ method: "GET", url: "/api/auth/me" })).json() as { role: string };
    expect(me.role).toBe("Viewer");
  });

  it("Planner + Viewer roles together → Planner", async () => {
    ctx = await switchableApp();
    ctx.as(testUser(["Viewer", "Planner"]));
    const res = await ctx.t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Both", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("(c) anonymous and no-role", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it("anonymous (entra) → 401 UNAUTHENTICATED on viewer AND planner routes; public stays open", async () => {
    t = await buildTestApp({ auth: fakeAuthAs(null) });
    for (const [method, url] of [
      ["GET", "/api/sprints"],
      ["GET", "/api/sprints/1/capacity"],
      ["POST", "/api/sprints"],
      ["GET", "/api/data/export"],
      ["GET", "/api/connections/health/stream"],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(ErrorResponse.parse(res.json()).error.code).toBe("UNAUTHENTICATED");
    }
    expect((await t.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/version" })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/auth/login" })).statusCode).toBe(302);
  });

  it("signed in with no role → 403 NO_ROLE on viewer and planner routes", async () => {
    t = await buildTestApp({ auth: fakeAuthAs(testUser([])) });
    for (const [method, url] of [
      ["GET", "/api/sprints"],
      ["POST", "/api/sprints"],
      ["GET", "/api/connections/health/stream"],
    ] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(ErrorResponse.parse(res.json()).error.code).toBe("NO_ROLE");
    }
  });

  it("an anonymous request is rejected before its body is parsed (data import)", async () => {
    t = await buildTestApp({ auth: fakeAuthAs(null) });
    const res = await t.app.inject({
      method: "POST",
      url: "/api/data/import",
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("the in-process scheduler header acts as Planner; a forged one does not", async () => {
    t = await buildTestApp({ auth: fakeAuthAs(null) });
    const ok = await t.app.inject({ method: "GET", url: "/api/sprints", headers: t.app.internalAuthHeaders() });
    expect(ok.statusCode).toBe(200);
    const forged = await t.app.inject({
      method: "GET",
      url: "/api/sprints",
      headers: { "x-osp-internal-auth": "00".repeat(32) },
    });
    expect(forged.statusCode).toBe(401);
  });
});
