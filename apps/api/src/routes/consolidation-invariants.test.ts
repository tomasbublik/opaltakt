import {
  CapacityResponse,
  ClosureStatsResponse,
  SprintItemsDetailedResponse,
  type SyncRefreshAllResponse,
} from "@osp/contracts";
import type { NewTicketBaseline, NewWorkPackageCache, Repositories } from "@osp/db";
import type { OpClient, OpClientConfig } from "@osp/op-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  buildTestApp,
  initVault,
  makeFakeOpClient,
  waitForActivation,
  type TestApp,
} from "../test-utils";

/**
 * Consolidation Round — INVARIANT tests (Agent D, Phase 1).
 *
 * These encode the round's frozen "Invarianty jako VYNUCENÉ testy" list from
 * CONSOLIDATION_PLAN.md as tests that FAIL WHEN THE INVARIANT IS VIOLATED — a
 * permanent regression net, not a snapshot of current behavior. Several assert
 * the round's INTENDED end state and are RED until the matching Phase-2 fix
 * lands (each such block cites the exact CONSOLIDATION_PLAN.md concept below).
 *
 * NEW file on purpose (no collision with the per-concept fix files other agents
 * touch this round). Runs on buildTestApp's isolated in-memory DB — never a real
 * port/DB (SPEC_12 §0 hard guardrail; this harness is safe by construction).
 *
 * Invariant → block map:
 *   #1  no GET /api/v3/users (admin collection) — getUsers() never called
 *   #2  disconnected connection isolation (refresh-all isolates; activation
 *       requireAll fail-fast — BOTH deliberate, Escalation A)
 *   #3  identity never collides on a bare op_user_id across connections  (RED)
 *   #4  never a fabricated `User <id>` name                              (RED)
 *   #5  token never leaks to any HTTP response body
 *   #6  capacity is_done ⟺ Closure done bucket (Escalation B)            (RED)
 *   #7  no silent no-op — every op returns a clear success/error outcome
 *   #8  sprint_update_run crash recovery at boot (Concept 8)            (RED)
 *   #9  env isolation boot-throw — already covered elsewhere (cited, not dup'd)
 */

// ── shared seed helpers ──────────────────────────────────────────────────────
function wpRow(p: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: p.connection_id ?? null,
    op_id: p.op_id,
    project_op_id: p.project_op_id ?? 100,
    project_name: null,
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
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
  };
}

function baselineRow(
  sprintId: number,
  p: { wp_op_id: number; status_name: string; status_is_closed?: boolean; original_assignee_op_id: number | null; assignee_name_raw?: string | null; estimated_hours?: number | null },
): NewTicketBaseline {
  return {
    sprint_id: sprintId,
    wp_op_id: p.wp_op_id,
    captured_at: "2026-06-01T09:00:00Z",
    subject: `WP ${p.wp_op_id}`,
    status_name: p.status_name,
    status_is_closed: p.status_is_closed ?? false,
    assignee_op_id: p.original_assignee_op_id,
    accountable_op_id: null,
    original_assignee_op_id: p.original_assignee_op_id,
    estimated_hours: p.estimated_hours ?? null,
    remaining_hours: null,
    spent_hours: null,
    version_op_id: null,
    raw_json: "{}",
    origin: "baseline",
    reconstructed: false,
    reconstruction_gaps_json: null,
    assignee_name_raw: p.assignee_name_raw ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #1 — OP is GET-only; GET /api/v3/users (the admin-gated COLLECTION,
// i.e. op.getUsers()) is NEVER called anywhere. One consolidated, repo-wide
// check: drive a broad set of operations (sync, activation, capacity, closure,
// reports, people, backlog) through the real routes and assert the forbidden
// collection method was never invoked. (The HTTP-boundary form of this guard —
// asserting the recording mock's request log has zero `/api/v3/users` GETs —
// already exists per-spec in tests/e2e/specs/{to,tf,tj,th}-*.spec.ts; this is
// its fast, deterministic, method-level consolidation. CONSOLIDATION_PLAN.md
// Concept 4: getUsers() "has zero non-test callers and should be … covered by
// an invariant test that it's never called".)
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #1 — GET /api/v3/users (op.getUsers) is never called during any operation", () => {
  it("stays uncalled across sync / activation / capacity / closure / reports / people / backlog", async () => {
    let getUsersCalls = 0;
    const opClientFactory = (_config: OpClientConfig): OpClient => {
      const base = makeFakeOpClient({
        workPackages: [],
        usersById: { 3: { _type: "User", id: 3, name: "Alan Turing", login: "alan" } },
        users: [{ _type: "User", id: 3, name: "Alan Turing", login: "alan" }],
      });
      return {
        ...base,
        getUsers: (...args: Parameters<OpClient["getUsers"]>) => {
          getUsersCalls += 1;
          return base.getUsers(...args);
        },
      };
    };

    const t = await buildTestApp({ opClientFactory });
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.importSelections.upsert({
      connection_id: conn.id,
      project_op_id: 100,
      project_name: "Project A",
      version_op_id: null,
      version_name: null,
    });

    // A sprint with a developer's tickets so every read surface has real work.
    const sprint = await t.repos.sprints.create({
      name: "S1", start_date: "2026-06-01", end_date: "2026-06-14", status: "planning", capacity_mode: "per_person",
    });
    const dev = await t.repos.teamMembers.upsert({ op_user_id: 3, name: "Alan Turing", default_hours_per_day: 8 });
    await t.repos.teamMembers.setRole(dev.id, "developer");
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, connection_id: conn.id, status_name: "Tested", status_is_closed: true, assignee_op_id: 3, assignee_name: "Alan Turing", estimated_hours: 8 }),
      wpRow({ op_id: 2, connection_id: conn.id, status_name: "In progress", assignee_op_id: 3, assignee_name: "Alan Turing", estimated_hours: 5 }),
    ]);
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 2, planned_hours: 5, outcome: "planned", origin: "baseline" });

    // Drive a broad set of write operations through the real routes.
    await t.app.inject({ method: "POST", url: "/api/sync", payload: {} }); // refresh-all
    await t.app.inject({ method: "POST", url: `/api/sprints/${sprint.id}/activate` }); // OP fetch + baseline capture
    await waitForActivation(t, sprint.id);

    for (const url of [
      `/api/sprints/${sprint.id}/capacity`,
      `/api/sprints/${sprint.id}/closure-stats`,
      `/api/sprints/${sprint.id}/items/detailed`,
      "/api/people",
      "/api/backlog",
      "/api/backlog/filter-options",
      "/api/reports",
    ]) {
      await t.app.inject({ method: "GET", url });
    }

    expect(
      getUsersCalls,
      "op.getUsers() (GET /api/v3/users, the admin-gated user COLLECTION) must NEVER be called — identity comes from _links.assignee/accountable + GET /api/v3/memberships (Inc 13 §1a)",
    ).toBe(0);
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #2 — a disconnected connection never blocks an operation over OTHER
// connections, WHERE that policy applies. Per the frozen Escalation A decision:
// refresh-all/sync ISOLATE (skip+continue); Activation/Update/Finish deliberately
// REQUIRE-ALL (fail-fast when any needed connection is down — a partial frozen
// baseline would be misleading). Both are asserted explicitly.
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #2 — connection-down policy is explicit per operation (Escalation A)", () => {
  it("refresh-all ISOLATES: a disconnected connection is skipped, the healthy one still syncs", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const healthy = (await addConnection(t, { base_url: "https://healthy.example.com", label: "healthy" })) as { id: number };
    const dead = (await addConnection(t, { base_url: "https://dead.example.com", label: "dead" })) as { id: number };
    for (const [c, proj] of [[healthy, 100], [dead, 200]] as const) {
      await t.repos.importSelections.upsert({ connection_id: c.id, project_op_id: proj, project_name: `P${proj}`, version_op_id: null, version_name: null });
    }
    await t.app.inject({ method: "PATCH", url: `/api/connections/${dead.id}`, payload: { enabled: false } });

    const res = await t.app.inject({ method: "POST", url: "/api/sync", payload: {} });
    expect(res.statusCode, res.payload).toBe(200); // NOT a 409 that aborts the whole batch
    const body = res.json<SyncRefreshAllResponse>();
    const byId = new Map(body.connections.map((c) => [c.connection_id, c]));
    expect(byId.get(healthy.id)?.status).toBe("synced");
    expect(byId.get(dead.id)?.status).toBe("skipped");
    expect(byId.get(dead.id)?.message).toBe("disconnected");
    await t.close();
  });

  it("activation REQUIRE-ALL: a sprint spanning a healthy + a down connection fails fast, sprint stays planning", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const a = (await addConnection(t, { base_url: "https://a.example.com", label: "A" })) as { id: number };
    const b = (await addConnection(t, { base_url: "https://b.example.com", label: "B" })) as { id: number };
    const sprint = await t.repos.sprints.create({
      name: "Span", start_date: "2026-06-01", end_date: "2026-06-14", status: "planning", capacity_mode: "per_person",
    });
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, connection_id: a.id, estimated_hours: 4 }),
      wpRow({ op_id: 2, connection_id: b.id, estimated_hours: 4 }),
    ]);
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 4, outcome: "planned", origin: "baseline" });
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 2, planned_hours: 4, outcome: "planned", origin: "baseline" });
    // Take connection B (which the sprint genuinely needs) down.
    await t.app.inject({ method: "PATCH", url: `/api/connections/${b.id}`, payload: { enabled: false } });

    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprint.id}/activate` });
    // Fail fast: a clear 409 BEFORE any partial baseline is frozen — never a
    // silent "activated with B's tickets missing".
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ACTIVATION_CONNECTIONS_UNAVAILABLE");
    const after = await t.repos.sprints.getById(sprint.id);
    expect(after?.status, "a require-all activation must leave the sprint in planning, never half-activated").toBe("planning");
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #3 — identity never collides across connections on a bare op_user_id,
// in developer-segment / closure-stats ATTRIBUTION (not just the assignee-filter
// dropdown, which tp-sync-disconnected-assignee-identity already covers). The
// confirmed collision: OP user id 3 = Alan Turing on the mock, Cameron Dalby
// on Acme. closureStats.ts keys its personKey map by BARE op_user_id, so their
// delivered work folds onto one `id:3` key — one of the two people vanishes from
// per_developer.
//
// RED until CONSOLIDATION_PLAN.md Concept 4: closureStats must build its
// personKey/role/name maps through the connection-scoped identity resolver (or
// at minimum key by (connection_id, op_user_id)), not bare op_user_id.
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #3 — closure attribution never conflates two people sharing a numeric id across connections (RED until Concept 4)", () => {
  it("both Alan Turing (mock id 3) and Cameron Dalby (Acme id 3) survive as distinct developers", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const mock = (await addConnection(t, { base_url: "https://mock.example.com", label: "mock" })) as { id: number };
    const acme = (await addConnection(t, { base_url: "https://acme.example.com", label: "Acme" })) as { id: number };

    // Only ONE team_member can hold bare op_user_id 3 — itself the collision.
    const dev = await t.repos.teamMembers.upsert({ op_user_id: 3, name: "Alan Turing", default_hours_per_day: 8 });
    await t.repos.teamMembers.setRole(dev.id, "developer");

    const sprint = await t.repos.sprints.create({
      name: "Cross", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person",
    });
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, connection_id: mock.id, status_name: "Tested", status_is_closed: true, assignee_op_id: 3, assignee_name: "Alan Turing", estimated_hours: 8 }),
      wpRow({ op_id: 2, connection_id: acme.id, status_name: "Tested", status_is_closed: true, assignee_op_id: 3, assignee_name: "Cameron Dalby", estimated_hours: 6 }),
    ]);
    for (const [wp, hrs, name] of [[1, 8, "Alan Turing"], [2, 6, "Cameron Dalby"]] as const) {
      await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wp, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }
    await t.repos.ticketBaselines.upsertMany([
      baselineRow(sprint.id, { wp_op_id: 1, status_name: "Tested", status_is_closed: true, original_assignee_op_id: 3, assignee_name_raw: "Alan Turing", estimated_hours: 8 }),
      baselineRow(sprint.id, { wp_op_id: 2, status_name: "Tested", status_is_closed: true, original_assignee_op_id: 3, assignee_name_raw: "Cameron Dalby", estimated_hours: 6 }),
    ]);
    const run = await t.repos.sprintUpdateRuns.start(sprint.id, "update", "manual");
    await t.repos.ticketChangelog.insertMany([
      { sprint_id: sprint.id, wp_op_id: 1, update_run_id: run.id, occurred_at: "2026-06-05T09:00:00Z", actor_op_id: 3, actor_name: "Alan Turing", kind: "time_logged", detail_json: JSON.stringify({ kind: "time_logged", hours: 8, spent_on: "2026-06-05" }), source: "time_entry", op_journal_id: null, dedup_key: "te:mock:1" },
      { sprint_id: sprint.id, wp_op_id: 2, update_run_id: run.id, occurred_at: "2026-06-06T09:00:00Z", actor_op_id: 3, actor_name: "Cameron Dalby", kind: "time_logged", detail_json: JSON.stringify({ kind: "time_logged", hours: 6, spent_on: "2026-06-06" }), source: "time_entry", op_journal_id: null, dedup_key: "te:acme:2" },
    ]);

    const stats = ClosureStatsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/closure-stats` })).json(),
    );
    const devNames = new Set(stats.per_developer.map((d) => d.name));
    // Alan (mock) and Cameron (Acme) are two DIFFERENT people who merely
    // share OP user id 3 on DIFFERENT connections. Both must survive as distinct
    // developers. Today they collide on the bare `id:3` personKey and the engine
    // emits NEITHER (per_developer is empty) — connection-scoped keying
    // ((connection_id, op_user_id)) is what splits them back apart.
    const msg =
      "closure attribution folded two people sharing OP user id 3 across connections onto one bare `id:3` key — must key identity by (connection_id, op_user_id) (CONSOLIDATION_PLAN.md Concept 4). per_developer=" +
      JSON.stringify(stats.per_developer.map((d) => d.name));
    expect(devNames.has("Alan Turing"), msg).toBe(true);
    expect(devNames.has("Cameron Dalby"), msg).toBe(true);
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #4 — never a fabricated `User <id>` name anywhere a real name should
// have been resolvable. closureStats.ts:86 fabricates `` `User ${id}` `` for a
// holder/logger whose name didn't resolve — the exact pattern Increment 13
// banned. The correct fallback is `unknownUserLabel(id)` → "Unknown user (id)".
//
// RED until CONSOLIDATION_PLAN.md Concept 4: use `unknownUserLabel`, never
// `User <id>`.
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #4 — closure never fabricates a `User <id>` name (RED until Concept 4)", () => {
  const FABRICATED = /^User \d+$/;

  it("a holder with an id but no resolvable name is labelled unknown, not `User <id>`", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const sprint = await t.repos.sprints.create({
      name: "Fab", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person",
    });
    // op id 777 with NO cached name and NO team_member → nothing to resolve to.
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, status_name: "Tested", status_is_closed: true, assignee_op_id: 777, assignee_name: null, estimated_hours: 4 }),
    ]);
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 4, outcome: "planned", origin: "baseline" });

    const stats = ClosureStatsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/closure-stats` })).json(),
    );
    const surfacedNames = [
      ...stats.per_developer.map((d) => d.name),
      ...[...stats.done.items, ...stats.not_done.items, ...stats.rejected.items, ...stats.ambiguous.items]
        .map((i) => i.holder_name)
        .filter((n): n is string => n != null),
    ];
    const fabricated = surfacedNames.filter((n) => FABRICATED.test(n));
    expect(
      fabricated,
      "closure surfaced fabricated `User <id>` name(s) — must use unknownUserLabel() (\"Unknown user (id)\") instead (CONSOLIDATION_PLAN.md Concept 4 / Inc 13 invariant)",
    ).toEqual([]);
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #5 — the OP token never leaks to any HTTP response body (frontend,
// error responses, or the read surfaces closure/capacity/reports expose).
// Extends Increment 2's vault security-gate coverage to more response surfaces.
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #5 — the connection token never appears in any HTTP response body", () => {
  it("stays absent from connections, backlog, capacity, closure, reports and error bodies", async () => {
    const SECRET = "super-secret-op-token-do-not-leak-42";
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t, { token: SECRET })) as { id: number };

    const sprint = await t.repos.sprints.create({
      name: "Tok", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person",
    });
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, connection_id: conn.id, status_name: "Tested", status_is_closed: true, assignee_op_id: 3, assignee_name: "Alan Turing", estimated_hours: 4 }),
    ]);
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 4, outcome: "planned", origin: "baseline" });

    const surfaces = [
      { method: "GET" as const, url: "/api/connections" },
      { method: "GET" as const, url: `/api/connections/${conn.id}` },
      { method: "GET" as const, url: "/api/backlog" },
      { method: "GET" as const, url: `/api/sprints/${sprint.id}/capacity` },
      { method: "GET" as const, url: `/api/sprints/${sprint.id}/closure-stats` },
      { method: "GET" as const, url: `/api/sprints/${sprint.id}/items/detailed` },
      { method: "GET" as const, url: "/api/reports" },
      { method: "GET" as const, url: "/api/people" },
      { method: "GET" as const, url: "/api/sprints/999999/capacity" }, // error body
    ];
    for (const s of surfaces) {
      const res = await t.app.inject(s);
      expect(res.payload.includes(SECRET), `token leaked into ${s.method} ${s.url} (status ${res.statusCode})`).toBe(false);
    }
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #6 — dimmed ⟺ Closure `done`, extended to capacity's OWN grey-
// redistribution is_done. A developer-held ticket in a "done"-by-status-only
// state (per-sprint done_status_rule) but role_dependent by the matrix must be
// `not_done` on EVERY surface. Closure + dimming already agree (role-aware, Inc
// 18); capacity still uses the status-only isDone() (routes/index.ts:743), so it
// greys the ticket out (redistributed_out_hours > 0) while Closure calls it
// not_done — the exact equivalence violation.
//
// RED until CONSOLIDATION_PLAN.md Concept 6 / Escalation B: migrate capacity's
// grey is_done to classifyWithRole (isDoneBucket(...)).
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #6 — capacity is_done equals Closure's done bucket (RED until Concept 6)", () => {
  it("a developer-held role_dependent ticket is not_done in Closure AND stays green in capacity", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);
    const sprint = await t.repos.sprints.create({
      name: "Grey", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person",
    });
    const dev = await t.repos.teamMembers.upsert({ op_user_id: 50, name: "Dana Dev", default_hours_per_day: 8 });
    await t.repos.teamMembers.setRole(dev.id, "developer");

    // "QA review": OPEN (status_is_closed=false), but the sprint's own
    // done_status_rule counts it as done → old status-only isDone() = true.
    // It is NOT in the global done_rule matrix, so classifyWithRole treats it as
    // role_dependent → a DEVELOPER holder ⇒ not_done.
    await t.repos.doneStatusRules.replaceForSprint(sprint.id, [
      { sprint_id: sprint.id, status_name: "QA review", counts_as: "done" },
    ]);
    await t.repos.workPackages.upsertMany([
      wpRow({ op_id: 1, status_name: "QA review", status_is_closed: false, assignee_op_id: 50, assignee_name: "Dana Dev", estimated_hours: 10 }),
    ]);
    await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 10, outcome: "planned", origin: "baseline" });
    await t.repos.ticketBaselines.upsertMany([
      baselineRow(sprint.id, { wp_op_id: 1, status_name: "QA review", original_assignee_op_id: 50, assignee_name_raw: "Dana Dev", estimated_hours: 10 }),
    ]);

    // Closure (role-aware) — the anchor: this ticket is NOT done.
    const stats = ClosureStatsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/closure-stats` })).json(),
    );
    expect(stats.not_done.items.map((i) => i.wp_op_id)).toContain(1);
    expect(stats.done.items.map((i) => i.wp_op_id)).not.toContain(1);

    // Dimming (already role-aware, Inc 18) agrees — should be GREEN today.
    const detailed = SprintItemsDetailedResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/items/detailed` })).json(),
    );
    expect(detailed.find((i) => i.op_id === 1)?.done_bucket).toBe("not_done");
    expect(detailed.find((i) => i.op_id === 1)?.is_done).toBe(false);

    // Capacity MUST agree: not-done ⇒ the ticket stays live green on the dev's
    // bar, so no hours are greyed out (redistributed_out). Status-only isDone
    // currently greys them (redistributed_out === 10) — this is the RED assert.
    const cap = CapacityResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/capacity` })).json(),
    );
    const line = cap.lines.find((l) => l.op_user_id === 50);
    expect(line, "the developer must have a capacity line").toBeTruthy();
    expect(
      line?.redistributed_out_hours,
      "capacity greyed out a ticket Closure/dimming call not_done — capacity's is_done must use the role-aware matrix (CONSOLIDATION_PLAN.md Concept 6 / Escalation B)",
    ).toBe(0);
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #7 — no silent no-op: every sync/activation/import/cancel either
// returns a clear success result or a clear error, never a 200 that silently did
// nothing. (Increment 22's "honest sync outcomes" is the direct precedent.)
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #7 — operations always yield a clear success or error, never a silent no-op", () => {
  it("a single-project sync targeting a DISABLED connection returns a clear 409, not a silent 200", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.app.inject({ method: "PATCH", url: `/api/connections/${conn.id}`, payload: { enabled: false } });
    const res = await t.app.inject({
      method: "POST", url: "/api/sync", payload: { project_op_id: 100, connection_id: conn.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONNECTION_DISABLED");
    await t.close();
  });

  it("a zero-change refresh-all still reports a definite success outcome per connection", async () => {
    const t = await buildTestApp();
    await initVault(t);
    const conn = (await addConnection(t)) as { id: number };
    await t.repos.importSelections.upsert({ connection_id: conn.id, project_op_id: 100, project_name: "P", version_op_id: null, version_name: null });
    const res = await t.app.inject({ method: "POST", url: "/api/sync", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json<SyncRefreshAllResponse>();
    // A definite, inspectable outcome — never an empty/ambiguous 200.
    expect(body.connections.length).toBeGreaterThan(0);
    expect(body.connections.every((c) => c.status !== undefined)).toBe(true);
    expect(body.connections.find((c) => c.connection_id === conn.id)?.status).toBe("synced");
    await t.close();
  });

  it("activating an EMPTY sprint still resolves to a definite outcome (active), not a silent stay-planning", async () => {
    const t = await buildTestApp();
    await initVault(t);
    await addConnection(t);
    const sprint = await t.repos.sprints.create({
      name: "Empty", start_date: "2026-06-01", end_date: "2026-06-14", status: "planning", capacity_mode: "per_person",
    });
    const res = await t.app.inject({ method: "POST", url: `/api/sprints/${sprint.id}/activate` });
    expect(res.statusCode).toBe(200);
    await waitForActivation(t, sprint.id);
    expect((await t.repos.sprints.getById(sprint.id))?.status).toBe("active");
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #8 — no permanent lock: a crashed/orphaned run recovers at boot.
// sync_run already has SyncRunRepository.recoverOrphaned() (marks stuck
// 'running' rows aborted, called at every buildServer() boot). sprint_update_run
// (activation/update/finish/retro-replay) has NO equivalent — a crash mid-
// activation leaves a `running` row forever.
//
// RED until CONSOLIDATION_PLAN.md Concept 8: bring sprint_update_run up to the
// same crash-recovery hardening as sync_run (a recoverOrphaned() that a fresh
// boot runs unconditionally).
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #8 — a crashed sprint_update_run is recoverable, never a permanent lock (RED until Concept 8)", () => {
  it("sprintUpdateRuns exposes recoverOrphaned() that marks a stuck 'running' row aborted", async () => {
    const t = await buildTestApp();
    const sprint = await t.repos.sprints.create({
      name: "Crash", start_date: "2026-06-01", end_date: "2026-06-14", status: "planning", capacity_mode: "per_person",
    });
    // Simulate a process killed mid-activation: a `running` row with no live owner.
    await t.repos.sprintUpdateRuns.start(sprint.id, "activation", "manual");

    // The hardening Concept 8 requires: a boot-time recovery, mirroring
    // SyncRunRepository.recoverOrphaned(). Absent today ⇒ RED.
    const repos = t.repos as Repositories & {
      sprintUpdateRuns: { recoverOrphaned?: () => Promise<number> };
    };
    expect(
      typeof repos.sprintUpdateRuns.recoverOrphaned,
      "SprintUpdateRunRepository needs a recoverOrphaned() (parity with sync_run) so a crash mid-activation can't lock the run forever (CONSOLIDATION_PLAN.md Concept 8)",
    ).toBe("function");
    const recovered = await repos.sprintUpdateRuns.recoverOrphaned!();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const latest = await t.repos.sprintUpdateRuns.latestBySprint(sprint.id);
    expect(latest?.status, "the orphaned 'running' row must be recovered to a terminal status").not.toBe("running");
    await t.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariant #9 — environment isolation: apps/api throws immediately at boot if
// DATABASE_URL / PORT is unset (Increment 27 replaced OSP_DB_PATH with
// DATABASE_URL; the guardrail is unchanged and, on Postgres, matters more —
// a wrong URL lands inside an EXISTING populated database rather than making a
// new empty file). ALREADY covered — not duplicated here:
//   - apps/api/src/server.test.ts  → buildServer() rejects /DATABASE_URL is not set/
//   - tests/src/env-isolation-guard.test.ts → the full guard: a deny-by-default
//     policy over connection strings, spawning the real entrypoint with BOTH
//     vars deleted to assert a non-zero "refusing to start" exit, and repo
//     scans that no checked-in script boots bare or names a real database.
// This block only DOCUMENTS the coverage so the invariant has a home in this
// consolidated file (SPEC_12 §0 hard guardrail).
// ═══════════════════════════════════════════════════════════════════════════
describe("Invariant #9 — env isolation boot-throw (coverage lives in server.test.ts + tests/src/env-isolation-guard.test.ts)", () => {
  let t: TestApp;
  beforeEach(async () => { t = await buildTestApp(); });
  afterEach(async () => { await t.close(); });

  it("the test harness itself only ever runs on an isolated in-memory DB (no real port/DB reachable)", async () => {
    // A cheap live tripwire: buildTestApp never binds a port and never opens a
    // real file — a route works purely in-memory. The real boot-throw is proven
    // by the two cited suites above.
    const res = await t.app.inject({ method: "GET", url: "/api/vault/status" });
    expect(res.statusCode).toBe(200);
  });
});
