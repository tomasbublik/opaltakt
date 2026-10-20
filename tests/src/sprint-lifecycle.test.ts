import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  BurndownResponse,
  SprintResponse,
  SprintUpdateRun,
  SyncRun,
  TicketChangelogResponse,
  type ChangelogEntryView,
} from "@osp/contracts";
import { addDays, mockAdmin, type MockAdmin, S1 } from "./scenario-helpers";
import { activateSprint, bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * SPEC_04 §8 — the core sprint-lifecycle acceptance gate (Agent D, review-grade).
 *
 * Drives the REAL Fastify app + REAL sync/lifecycle engine against a recording
 * mock loaded with S1 (accountable-handoff). Proves the frozen algorithm in
 * apps/api/src/logic/sprintUpdate.ts end to end: activation baseline, SCOPED-ONLY
 * updates, changelog attribution (actor + kind) with the S1 handoff verbatim,
 * time_logged from time entries only, idempotence via dedup, the `closed`
 * companion row (via S6), and burndown decline across update runs.
 *
 * CLOCK: the app is booted with a MUTABLE logical clock aligned to the mock's
 * calendar (see harness.ts `now`). Activation happens at 2026-07-01T00:00:00Z
 * (before any journal), then the clock is advanced in lockstep with the mock so
 * (1) the changelog `createdAt >= activated_at` filter keeps every scenario
 * journal and (2) each update's burndown point lands on that logical date.
 */

interface S1Ctx {
  mock: RecordingMockOpServer;
  admin: MockAdmin;
  harness: RealApp;
  dir: string;
  sprintId: number;
  activatedSprint: unknown;
  changelog1101: ChangelogEntryView[];
  burndown: BurndownResponse;
  firstUpdate: SprintUpdateRun;
  idempotentUpdate: SprintUpdateRun;
  changelogCountBeforeIdempotent: number;
  changelogCountAfterIdempotent: number;
}

// Cast (fixtures/scenarios/helpers.ts CAST): dev=1, tester=2, customer=3.
const DEV = { id: 1, name: "Dev Dvořák" };
const TESTER = { id: 2, name: "Tereza Testerová" };
const CUSTOMER = { id: 3, name: "Karel Zákazník" };

const MAIN = 1101; // in the sprint (the handoff ticket)
const BG_DOCS = 1103; // in the sprint (background, drives burndown)
const BACKLOG_ONLY = 1102; // imported to backlog but NEVER added to the sprint

function expectOk(
  res: { status: number; json: unknown },
  what: string,
): void {
  expect(
    res.status,
    `${what} — expected 2xx but got ${res.status}: ${JSON.stringify(res.json)}`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status, `${what}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
}

describe("SPEC_04 §8 — sprint lifecycle end-to-end (S1 accountable-handoff)", () => {
  let ctx: S1Ctx;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "osp-sprint-lifecycle-"));
    const mock = await createRecordingMockOpServer();
    const admin = mockAdmin(mock.url);
    await admin.requireScenario(S1); // clear "BLOCKED ON AGENT M2" message if absent

    // Mutable logical clock — starts BEFORE any scenario journal (day 0 seed is
    // 08:00Z, mutations 09:00Z; activation at 00:00Z predates them all).
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    const harness = await bootRealApp({
      now: () => clock.now,
    });

    const loaded = await admin.load(S1);
    const d0 = loaded.date!; // "2026-07-01"
    expect(d0).toBe("2026-07-01");

    await connectToOp(harness.app, mock.url, "s1-token", 3);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expectOk(sync, "initial sync");
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S1 handoff sprint",
      start_date: d0,
      end_date: addDays(d0, 8), // 2026-07-09
    });
    expectOk(created, "create sprint");
    const sprintId = SprintResponse.parse(created.json).id;

    // Sprint scope = {1101, 1103}. 1102 is imported (backlog) but NOT a member.
    for (const wpId of [MAIN, BG_DOCS]) {
      const added = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
        wp_op_id: wpId,
      });
      expectOk(added, `add item ${wpId}`);
    }

    // ── ACTIVATE (planning → active, baseline + first burndown point) ──────────
    // SPEC_09 §1: activation is now ASYNC — POST /activate returns the started
    // run, not the Sprint; activateSprint() polls until it settles, then we
    // re-fetch the sprint's actual post-activation state via GET /sprints.
    const activated = await activateSprint(harness.app, sprintId);
    expectOk(activated, "POST /activate");
    const sprintsAfterActivate = await call(harness.app, "GET", "/api/sprints");
    const activatedSprint = (sprintsAfterActivate.json as Array<{ id: number }>).find(
      (s) => s.id === sprintId,
    );

    // ── Day-by-day through the whole S1 story (days 1..8), update each day ─────
    let firstUpdate: SprintUpdateRun | undefined;
    for (let n = 1; n <= 8; n += 1) {
      const adv = await admin.advanceDay();
      expect(adv.day).toBe(n);
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
      const upd = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {
        triggered_by: "manual",
      });
      expectOk(upd, `POST /update day ${n}`);
      const run = SprintUpdateRun.parse(upd.json);
      firstUpdate ??= run;
    }

    // ── Idempotence: one more update with NO mock advance → 0 new rows ─────────
    const before = await harness.repos.ticketChangelog.listBySprint(sprintId);
    const idemRes = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {
      triggered_by: "manual",
    });
    expectOk(idemRes, "POST /update (idempotent re-run)");
    const idempotentUpdate = SprintUpdateRun.parse(idemRes.json);
    const after = await harness.repos.ticketChangelog.listBySprint(sprintId);

    // ── Read back the changelog + burndown ────────────────────────────────────
    const clRes = await call(
      harness.app,
      "GET",
      `/api/sprints/${sprintId}/tickets/${MAIN}/changelog`,
    );
    expectOk(clRes, "GET changelog 1101");
    const changelog1101 = TicketChangelogResponse.parse(clRes.json);

    const bdRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/burndown`);
    expectOk(bdRes, "GET burndown");
    const burndown = BurndownResponse.parse(bdRes.json);

    ctx = {
      mock,
      admin,
      harness,
      dir,
      sprintId,
      activatedSprint,
      changelog1101,
      burndown,
      firstUpdate: firstUpdate!,
      idempotentUpdate,
      changelogCountBeforeIdempotent: before.length,
      changelogCountAfterIdempotent: after.length,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.harness.close();
    await ctx.mock.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });

  // (a) Activation captures a baseline + first burndown point.
  it("activation flips planning→active, sets activated_at, and captures a ticket_baseline for exactly the sprint's tickets", async () => {
    const sprint = SprintResponse.parse(ctx.activatedSprint);
    expect(sprint.status).toBe("active");
    expect(sprint.activated_at, "activated_at must be set on activation").not.toBeNull();
    expect(sprint.is_locked).toBe(false);

    const baselines = await ctx.harness.repos.ticketBaselines.listBySprint(ctx.sprintId);
    const byWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
    // Baseline captured for the two sprint members, and NOT for the backlog-only WP.
    expect(new Set(baselines.map((b) => b.wp_op_id))).toEqual(new Set([MAIN, BG_DOCS]));
    expect(byWp.has(BACKLOG_ONLY)).toBe(false);

    const main = byWp.get(MAIN)!;
    expect(main.status_name).toBe("New");
    expect(main.status_is_closed).toBe(false);
    expect(main.estimated_hours).toBe(16);
    expect(main.assignee_op_id).toBe(DEV.id);
    // accountable is a SEPARATE link, seeded to the customer.
    expect(main.accountable_op_id).toBe(CUSTOMER.id);

    // First burndown point lands on the activation date (2026-07-01).
    expect(ctx.burndown.points.map((p) => p.date)).toContain("2026-07-01");
  });

  // (b) Scoped-only: the backlog-only WP is never queried, never in the changelog.
  it("update is SCOPED — the backlog-only WP (1102) is never fetched for activities and produces no changelog", async () => {
    const activityPaths = ctx.mock.requests
      .filter((r) => /\/api\/v3\/work_packages\/\d+\/activities$/.test(r.path))
      .map((r) => r.path);
    // The engine DID query the two sprint tickets' activities…
    expect(activityPaths).toContain(`/api/v3/work_packages/${MAIN}/activities`);
    expect(activityPaths).toContain(`/api/v3/work_packages/${BG_DOCS}/activities`);
    // …and NEVER the backlog-only ticket's (proves scope, not whole-backlog).
    expect(activityPaths).not.toContain(`/api/v3/work_packages/${BACKLOG_ONLY}/activities`);

    const all = await ctx.harness.repos.ticketChangelog.listBySprint(ctx.sprintId);
    expect(all.some((e) => e.wp_op_id === BACKLOG_ONLY)).toBe(false);
  });

  // (c) The §8 acceptance test verbatim: attribution + handoff, no accountable, no closed.
  it("changelog shows the S1 handoff with correct actors, in order, and never accountable_changed nor closed", () => {
    const cl = ctx.changelog1101;
    expect(cl.length).toBeGreaterThan(0);

    // Oldest-first contract: occurred_at is non-decreasing.
    for (let i = 1; i < cl.length; i += 1) {
      expect(
        cl[i]!.occurred_at >= cl[i - 1]!.occurred_at,
        `changelog must be oldest-first at index ${i}`,
      ).toBe(true);
    }

    const statuses = cl.filter((e) => e.kind === "status_changed");
    const firstStatus = statuses[0]!;
    expect(firstStatus.detail).toMatchObject({ kind: "status_changed", from: "New", to: "Confirmed" });
    expect(firstStatus.actor_op_id).toBe(DEV.id);
    expect(firstStatus.actor_name).toBe(DEV.name);

    // →Developed, attributed to the outgoing developer.
    const developed = statuses.find(
      (e) => e.detail.kind === "status_changed" && e.detail.to === "Developed",
    );
    expect(developed, "expected a status_changed →Developed").toBeDefined();
    expect(developed!.actor_op_id).toBe(DEV.id);

    // assignee dev→tester (actor = OUTGOING dev), then tester→customer (actor tester).
    const assignments = cl.filter((e) => e.kind === "assignee_changed");
    const devToTester = assignments.find(
      (e) => e.detail.kind === "assignee_changed" && e.detail.from === DEV.name && e.detail.to === TESTER.name,
    );
    const testerToCustomer = assignments.find(
      (e) =>
        e.detail.kind === "assignee_changed" &&
        e.detail.from === TESTER.name &&
        e.detail.to === CUSTOMER.name,
    );
    expect(devToTester, "expected assignee_changed dev→tester").toBeDefined();
    expect(devToTester!.actor_op_id).toBe(DEV.id); // outgoing person
    expect(testerToCustomer, "expected assignee_changed tester→customer").toBeDefined();
    expect(testerToCustomer!.actor_op_id).toBe(TESTER.id);

    // Relative order: Developed (day6) before the dev→tester handoff (day6, next
    // tick) before the tester→customer parking (day8).
    expect(cl.indexOf(developed!)).toBeLessThan(cl.indexOf(devToTester!));
    expect(cl.indexOf(devToTester!)).toBeLessThan(cl.indexOf(testerToCustomer!));

    // The whole point of S1: accountable is seeded and NEVER changes → no rows.
    expect(cl.filter((e) => e.kind === "accountable_changed")).toEqual([]);
    // The ticket never reaches an isClosed status → no `closed` companion row.
    expect(cl.filter((e) => e.kind === "closed")).toEqual([]);
  });

  // (d) time_logged comes only from time entries.
  it("time_logged entries carry the right hours/spentOn/actor and are sourced from time_entry (never journal)", () => {
    const logged = ctx.changelog1101.filter((e) => e.kind === "time_logged");
    // main WP: dev 6h @07-03, dev 6h @07-06, dev 4h @07-07, tester 2h @07-08.
    expect(logged).toHaveLength(4);
    for (const e of logged) {
      expect(e.source).toBe("time_entry");
      expect(e.op_journal_id).toBeNull();
      expect(e.detail.kind).toBe("time_logged");
    }
    const triples = logged.map((e) => {
      const d = e.detail as { kind: "time_logged"; hours: number; spent_on: string };
      return `${e.actor_op_id}|${d.hours}|${d.spent_on}`;
    });
    expect(new Set(triples)).toEqual(
      new Set([
        `${DEV.id}|6|2026-07-03`,
        `${DEV.id}|6|2026-07-06`,
        `${DEV.id}|4|2026-07-07`,
        `${TESTER.id}|2|2026-07-08`,
      ]),
    );
  });

  // (f) Idempotence via dedup.
  it("a second update with no new OP activity inserts ZERO changelog rows (changes_count===0, count unchanged)", () => {
    expect(ctx.idempotentUpdate.changes_count).toBe(0);
    expect(ctx.changelogCountAfterIdempotent).toBe(ctx.changelogCountBeforeIdempotent);
  });

  // (g) Burndown remaining declines across the update runs.
  it("burndown remaining_hours declines monotonically across the update-driven snapshots", () => {
    const remaining = ctx.burndown.points
      .filter((p) => p.remaining_hours !== null)
      .map((p) => ({ date: p.date, r: p.remaining_hours! }))
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(remaining.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < remaining.length; i += 1) {
      expect(
        remaining[i]!.r,
        `remaining must not increase from ${remaining[i - 1]!.date} to ${remaining[i]!.date}`,
      ).toBeLessThanOrEqual(remaining[i - 1]!.r);
    }
    expect(remaining.at(-1)!.r).toBeLessThan(remaining[0]!.r);
  });

  // The hard invariant across the whole lifecycle: GET-only against OP.
  it("the whole activate→update lifecycle touched OpenProject with GET only", () => {
    const v3 = ctx.mock.requests.filter((r) => r.path.startsWith("/api/v3/"));
    expect(v3.length).toBeGreaterThan(0);
    expect(new Set(v3.map((r) => r.method))).toEqual(new Set(["GET"]));
  });
});

/**
 * (e) The `closed`-kind companion row — reuses S6, where WP 1602 (browser-pass)
 * transitions Confirmed → In progress → Closed (isClosed=true) on day 2. The
 * engine must emit BOTH a status_changed AND a `closed` row with the SAME
 * occurred_at + actor, and re-running the update must produce neither again.
 */
describe("SPEC_04 §8 — the `closed` companion changelog row + its dedup (S6)", () => {
  const S6 = "s6-carryover";
  const BROWSER_PASS = 1602;
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let secondRunChanges: number | null;
  let closedRows: ChangelogEntryView[];
  let statusToClosed: ChangelogEntryView | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-sprint-closed-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S6);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S6);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s6-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S6 closed-kind sprint",
      start_date: d0,
      end_date: addDays(d0, 9),
    });
    sprintId = SprintResponse.parse(created.json).id;
    const added = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
      wp_op_id: BROWSER_PASS,
    });
    expectOk(added, "add 1602");
    expectOk(await activateSprint(harness.app, sprintId), "activate S6 sprint");

    // Advance to day 2 (browser-pass → Closed), update once.
    for (let n = 1; n <= 2; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
    }
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {}),
      "update S6 day 2",
    );

    // Re-run with no advance → dedup must add nothing.
    const rerun = await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {});
    expectOk(rerun, "S6 idempotent re-run");
    secondRunChanges = SprintUpdateRun.parse(rerun.json).changes_count;

    const cl = TicketChangelogResponse.parse(
      (await call(
        harness.app,
        "GET",
        `/api/sprints/${sprintId}/tickets/${BROWSER_PASS}/changelog`,
      )).json,
    );
    closedRows = cl.filter((e) => e.kind === "closed");
    statusToClosed = cl.find(
      (e) => e.detail.kind === "status_changed" && e.detail.to === "Closed",
    );
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("emits BOTH status_changed→Closed and a `closed` row with the SAME occurred_at + actor", () => {
    expect(statusToClosed, "expected a status_changed →Closed").toBeDefined();
    expect(closedRows, "expected exactly one `closed` companion row").toHaveLength(1);
    const closed = closedRows[0]!;
    expect(closed.detail).toMatchObject({ kind: "closed", status: "Closed" });
    expect(closed.source).toBe("journal");
    // Same journal event → same timestamp + actor as the status_changed row.
    expect(closed.occurred_at).toBe(statusToClosed!.occurred_at);
    expect(closed.actor_op_id).toBe(statusToClosed!.actor_op_id);
    // browser-pass assignee (never reassigned) = tester → both attributed to tester.
    expect(closed.actor_op_id).toBe(TESTER.id);
  });

  it("re-running the update does NOT duplicate the status_changed or `closed` row (dedup incl. the :closed key)", () => {
    expect(secondRunChanges).toBe(0);
    expect(closedRows).toHaveLength(1); // still exactly one after the re-run
  });
});
