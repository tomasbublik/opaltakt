import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordedRequest,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  BurndownResponse,
  SprintResponse,
  SyncRun,
  TicketChangelogResponse,
  type ChangelogEntryView,
} from "@osp/contracts";
import { addDays, mockAdmin, type MockAdmin, S4 } from "./scenario-helpers";
import { activateSprint, bootRealApp, call, connectToOp, errorCode, type RealApp } from "./harness";

/**
 * SPEC_05 §8 — MID-SPRINT SCOPE CHANGE behavior + the read-only guard.
 *
 * The hard invariants gated here (SPEC_05 §8, scopeCapacity.ts §4):
 *   - mid-sprint ADD dočte the baseline WP from OP with GET only (the single-WP
 *     id fetch + a statuses fetch), NOT a full project re-sync; creates a
 *     ticket_baseline (origin=added_mid_sprint) + a sprint_item
 *     (origin=added_mid_sprint) + a `scope_added` changelog (source=local,
 *     actor=Planner) — even from a COLD cache.
 *   - mid-sprint REMOVE makes ZERO OP calls; the sprint_item ROW SURVIVES with
 *     outcome=removed_mid_sprint + removed_at; a `scope_removed` changelog lands.
 *   - a removed-with-logged ticket keeps its logged hours in the burndown while
 *     dropping from committed/count; total_planned stays baseline-anchored.
 *   - immutability: after Finish, add/remove both fail (409) with no side effect.
 */

const DEV = { id: 1, name: "Dev Dvořák" };
const SESSION = 1401; // dev, est 12 (baseline, has time logged days 1-2)
const E2E = 1403; // tester, est 8 (baseline)
const EMPTY_STATES = 1404; // tester, est 5 (baseline)
const URGENT_LOGIN = 1451; // dev, est 6 — appears in OP on day 3 only

function expectOk(res: { status: number; json: unknown }, what: string): void {
  expect(
    res.status,
    `${what} — expected 2xx but got ${res.status}: ${JSON.stringify(res.json)}`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status, `${what}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
}

const v3 = (rs: RecordedRequest[]): RecordedRequest[] =>
  rs.filter((r) => r.path.startsWith("/api/v3/"));

// ═══════════════════════════════════════════════════════════════════════════
describe("SPEC_05 §8 — mid-sprint ADD (behavior + read-only, S4)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let addWindow: RecordedRequest[]; // /api/v3 traffic caused by the ADD only
  let changelog: ChangelogEntryView[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-scope-add-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 add sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    for (const wp of [SESSION, E2E]) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add baseline ${wp}`,
      );
    }
    expectOk(await activateSprint(harness.app, sprintId), "activate");

    // Advance to day 3 so 1451 exists in OP — but DO NOT re-sync (cold cache).
    for (let n = 1; n <= 3; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
    }

    // Isolate the ADD's OP traffic: reset the recorder immediately before it.
    mock.reset();
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: URGENT_LOGIN }),
      "add URGENT_LOGIN mid-sprint",
    );
    addWindow = v3([...mock.requests]);

    changelog = TicketChangelogResponse.parse(
      (await call(
        harness.app,
        "GET",
        `/api/sprints/${sprintId}/tickets/${URGENT_LOGIN}/changelog`,
      )).json,
    );
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("dočte the baseline WP from OP with GET only — a single-WP id fetch + statuses, NOT a full re-sync", () => {
    expect(addWindow.length).toBeGreaterThan(0);
    // (1) Everything the add touched on OP was a GET.
    expect(new Set(addWindow.map((r) => r.method))).toEqual(new Set(["GET"]));
    // (2) It fetched the single WP by id filter (the URGENT_LOGIN id in the query).
    const wpLists = addWindow.filter((r) => r.path === "/api/v3/work_packages");
    expect(wpLists.length).toBeGreaterThan(0);
    expect(
      wpLists.some((r) => r.search.includes(String(URGENT_LOGIN)) && r.search.includes("filters")),
      "expected an id-filtered single-WP fetch for the added ticket",
    ).toBe(true);
    // (3) NOT a full project re-sync: every work_packages LIST hit is id-filtered
    //     (a full sync would page the unfiltered collection).
    for (const r of wpLists) {
      expect(r.search.includes("filters"), `unfiltered work_packages walk: ${r.search}`).toBe(true);
    }
    // (4) It read statuses (for status_is_closed) — small + cheap.
    expect(addWindow.some((r) => r.path === "/api/v3/statuses")).toBe(true);
    // (5) No mutation reached OpenProject, anywhere in the add window.
    expect(addWindow.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("creates a ticket_baseline with origin=added_mid_sprint + captured_at", async () => {
    const baseline = await harness.repos.ticketBaselines.getBySprintAndWp(sprintId, URGENT_LOGIN);
    expect(baseline, "a baseline row must exist for the mid-sprint add").not.toBeNull();
    expect(baseline!.origin).toBe("added_mid_sprint");
    expect(baseline!.captured_at).toBeTruthy();
    // captured_at is "now" (the logical clock at add time). S4 day 3 = 2026-07-04
    // (d0 2026-07-01 + 3), which is when the urgent WPs land in OP.
    expect(baseline!.captured_at.startsWith("2026-07-04")).toBe(true);
  });

  it("creates a sprint_item with origin=added_mid_sprint, outcome=planned", async () => {
    const item = await harness.repos.sprintItems.getBySprintAndWp(sprintId, URGENT_LOGIN);
    expect(item, "a sprint_item must exist for the added ticket").not.toBeNull();
    expect(item!.origin).toBe("added_mid_sprint");
    expect(item!.outcome).toBe("planned");
    expect(item!.planned_hours).toBe(6); // effective estimate snapshot
  });

  it("emits a scope_added changelog entry: source=local, actor=Planner (op_id null)", () => {
    const added = changelog.filter((e) => e.kind === "scope_added");
    expect(added.length).toBe(1);
    const e = added[0]!;
    expect(e.source).toBe("local");
    expect(e.actor_name).toBe("Planner");
    expect(e.actor_op_id).toBeNull();
    expect(e.op_journal_id).toBeNull();
    expect(e.detail.kind).toBe("scope_added");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("SPEC_05 §8 — mid-sprint ADD from a COLD cache (never synced WP)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let injectedId: number;
  let cacheBeforeWasCold: boolean;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-scope-cold-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 cold-cache sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: SESSION }),
      "add baseline 1401",
    );
    expectOk(await activateSprint(harness.app, sprintId), "activate");

    // A brand-new WP straight into OP; never part of any sync/backlog.
    injectedId = (await admin.injectUrgent()).work_package.id;
    clock.now = new Date("2026-07-03T12:00:00.000Z");
    // The cache is cold: the app has never seen this WP.
    cacheBeforeWasCold = (await harness.repos.workPackages.getByOpId(injectedId)) == null;

    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: injectedId }),
      "add never-synced WP mid-sprint",
    );
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("adds a WP the app never synced — proving the dočti-baseline-from-OP cold path", async () => {
    expect(cacheBeforeWasCold, "precondition: the WP must be absent from the cache before the add").toBe(true);
    const item = await harness.repos.sprintItems.getBySprintAndWp(sprintId, injectedId);
    expect(item, "sprint_item created from a cold cache").not.toBeNull();
    expect(item!.origin).toBe("added_mid_sprint");
    const baseline = await harness.repos.ticketBaselines.getBySprintAndWp(sprintId, injectedId);
    expect(baseline?.origin).toBe("added_mid_sprint");
    // The cold fetch also upserted the work_package_cache (now warm).
    expect(await harness.repos.workPackages.getByOpId(injectedId)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("SPEC_05 §8 — mid-sprint REMOVE (zero OP calls, row survives, S4)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let removeWindowAll: RecordedRequest[]; // ALL traffic during the DELETE
  let rowsBefore: number;
  let rowsAfter: number;
  let removedItem: { outcome: string; removed_at: string | null } | null;
  let changelog: ChangelogEntryView[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-scope-remove-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 remove sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    for (const wp of [SESSION, E2E]) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add baseline ${wp}`,
      );
    }
    expectOk(await activateSprint(harness.app, sprintId), "activate");

    rowsBefore = (await harness.repos.sprintItems.listBySprint(sprintId)).length;

    // Isolate the DELETE's traffic: reset immediately before it.
    clock.now = new Date("2026-07-02T12:00:00.000Z");
    mock.reset();
    expectOk(
      await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${E2E}`),
      "remove E2E mid-sprint",
    );
    removeWindowAll = [...mock.requests];

    const items = await harness.repos.sprintItems.listBySprint(sprintId);
    rowsAfter = items.length;
    const it = items.find((i) => i.wp_op_id === E2E);
    removedItem = it ? { outcome: it.outcome, removed_at: it.removed_at } : null;

    changelog = TicketChangelogResponse.parse(
      (await call(
        harness.app,
        "GET",
        `/api/sprints/${sprintId}/tickets/${E2E}/changelog`,
      )).json,
    );
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("makes ZERO OpenProject calls (SPEC_05 §8: odebrání nevolá OP vůbec)", () => {
    expect(v3(removeWindowAll), "the remove must not touch /api/v3/* at all").toEqual([]);
    // Belt-and-suspenders: no mutation anywhere (only operator /__mock allowed).
    for (const r of removeWindowAll.filter((r) => r.method !== "GET")) {
      expect(r.path.startsWith("/__mock/"), `${r.method} ${r.path}`).toBe(true);
    }
  });

  it("never deletes the row — same row survives with outcome=removed_mid_sprint + removed_at", () => {
    expect(rowsAfter).toBe(rowsBefore); // no row removed
    expect(removedItem).not.toBeNull();
    expect(removedItem!.outcome).toBe("removed_mid_sprint");
    expect(removedItem!.removed_at).toBeTruthy();
    expect(removedItem!.removed_at!.startsWith("2026-07-02")).toBe(true);
  });

  it("emits a scope_removed changelog entry: source=local, actor=Planner (op_id null)", () => {
    const removed = changelog.filter((e) => e.kind === "scope_removed");
    expect(removed.length).toBe(1);
    const e = removed[0]!;
    expect(e.source).toBe("local");
    expect(e.actor_name).toBe("Planner");
    expect(e.actor_op_id).toBeNull();
    expect(e.detail.kind).toBe("scope_removed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2d) A removed-with-logged ticket keeps its logged hours in the burndown while
// dropping from committed/count; total_planned stays baseline-anchored.
describe("SPEC_05 §8 — removed-with-logged-time survives in burndown (S4)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let baselineTotal: number | null;
  let bdBefore: BurndownResponse;
  let bdAfter: BurndownResponse;

  const latestLogged = (bd: BurndownResponse): number => {
    const pts = bd.points.filter((p) => p.logged_hours !== null);
    return pts.length ? pts[pts.length - 1]!.logged_hours! : 0;
  };
  const latestCount = (bd: BurndownResponse): number => {
    const pts = bd.points.filter((p) => p.total_count !== null);
    return pts.length ? pts[pts.length - 1]!.total_count! : 0;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-scope-burndown-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 burndown sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    // SESSION (1401) accrues 12h logged over days 1-2; EMPTY_STATES (1404) too.
    for (const wp of [SESSION, EMPTY_STATES]) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add baseline ${wp}`,
      );
    }
    const activated = await activateSprint(harness.app, sprintId);
    expectOk(activated, "activate");
    const sprintsAfterActivate = await call(harness.app, "GET", "/api/sprints");
    const activatedSprint = (sprintsAfterActivate.json as Array<{ id: number }>).find(
      (s) => s.id === sprintId,
    );
    baselineTotal = SprintResponse.parse(activatedSprint).baseline_total_hours;

    // Advance + update days 1-2 so 1401 logs its 12h into burndown snapshots.
    for (let n = 1; n <= 2; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {}),
        `update day ${n}`,
      );
    }
    bdBefore = BurndownResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/burndown`)).json,
    );

    // Remove SESSION (12h already logged) mid-sprint. The next update must land
    // on a WORKING day so buildBurndown includes its snapshot — S4 day 3/4 are
    // the weekend (2026-07-04 Sat / 07-05 Sun), so advance to day 5 (Monday).
    expectOk(
      await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${SESSION}`),
      "remove SESSION mid-sprint",
    );
    for (let n = 3; n <= 5; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
    }
    expectOk(await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {}), "update day 5");
    bdAfter = BurndownResponse.parse(
      (await call(harness.app, "GET", `/api/sprints/${sprintId}/burndown`)).json,
    );
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("total_planned_hours stays baseline-anchored (frozen) even after a 12h ticket is removed", () => {
    expect(baselineTotal).toBe(17); // 1401(12) + 1404(5)
    expect(bdBefore.total_planned_hours).toBe(17);
    // Removing SESSION does NOT shrink the ideal-line anchor — scope creep visible.
    expect(bdAfter.total_planned_hours).toBe(17);
  });

  it("the removed ticket's already-logged hours stay counted in the burndown", () => {
    // 1401 logged 12h; that logged time survives the mid-sprint removal.
    expect(latestLogged(bdBefore)).toBeGreaterThanOrEqual(12);
    expect(latestLogged(bdAfter)).toBeGreaterThanOrEqual(latestLogged(bdBefore));
  });

  it("the removed ticket drops from the committed count", () => {
    expect(latestCount(bdAfter)).toBeLessThan(latestCount(bdBefore));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2e) Immutability: after Finish, add + remove both fail with no side effect.
describe("SPEC_05 §8 — immutability: locked sprint rejects add/remove (S4)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let addRes: { status: number; json: unknown };
  let removeRes: { status: number; json: unknown };
  let baselineCountBefore: number;
  let baselineCountAfter: number;
  let itemsBefore: number;
  let itemsAfter: number;
  let opWindow: RecordedRequest[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-scope-lock-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "S4 lock sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    for (const wp of [SESSION, E2E]) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add baseline ${wp}`,
      );
    }
    expectOk(await activateSprint(harness.app, sprintId), "activate");
    // Finish → irreversible lock.
    expectOk(await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`, {}), "finish");

    baselineCountBefore = (await harness.repos.ticketBaselines.listBySprint(sprintId)).length;
    itemsBefore = (await harness.repos.sprintItems.listBySprint(sprintId)).length;

    // Advance to day 3 so URGENT_LOGIN exists — the add would otherwise cold-fetch.
    for (let n = 1; n <= 3; n += 1) {
      const adv = await admin.advanceDay();
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
    }
    mock.reset();
    addRes = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: URGENT_LOGIN });
    removeRes = await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${E2E}`);
    opWindow = v3([...mock.requests]);

    baselineCountAfter = (await harness.repos.ticketBaselines.listBySprint(sprintId)).length;
    itemsAfter = (await harness.repos.sprintItems.listBySprint(sprintId)).length;
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("add + remove both 409 on a locked/closed sprint (SPRINT_CLOSED or SPRINT_LOCKED)", () => {
    // NOTE: SPEC_05 §4/§8 says "423"; the frozen error mapping (unchanged since
    // Increment 4) returns 409 for SPRINT_CLOSED/SPRINT_LOCKED — see report.
    expect(addRes.status).toBe(409);
    expect(["SPRINT_CLOSED", "SPRINT_LOCKED"]).toContain(errorCode(addRes.json));
    expect(removeRes.status).toBe(409);
    expect(["SPRINT_CLOSED", "SPRINT_LOCKED"]).toContain(errorCode(removeRes.json));
  });

  it("no DB side effect (no new baseline, no new/changed item) and no OP mutation", () => {
    expect(baselineCountAfter).toBe(baselineCountBefore);
    expect(itemsAfter).toBe(itemsBefore);
    // The rejected add must not have dočetl anything from OP.
    expect(opWindow.filter((r) => r.method !== "GET")).toEqual([]);
  });
});
