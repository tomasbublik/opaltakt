import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { CapacityResponse, SprintResponse, SyncRun } from "@osp/contracts";
import type { NewWorkPackageCache } from "@osp/db";
import { ancestorDoubleCounts, leafEffort } from "../../apps/api/src/logic/doubleCounting";
import { activateSprint, bootRealApp, call, connectToOp, errorCode, type RealApp } from "./harness";

/**
 * INCREMENT 28 — Agent D / QA. Double-counting: ancestor-aware MARKING, the
 * one-click bulk fix, and the §0c "a developer vanishes from Capacity" defect.
 *
 * ── WHY THIS LIVES IN VITEST AND NOT ONLY IN PLAYWRIGHT ─────────────────────
 * The mock OpenProject's PARENT links are static: `fixtures/data/work_packages.json`
 * models exactly ONE parent/child edge (1001 → 1002) and NO scenario in
 * `fixtures/scenarios/*` sets `parent` at all (verified: zero occurrences). The
 * e2e spec `tt-double-counting.spec.ts` therefore proves the real browser path
 * on that one real pair, and this file proves the shapes the fixture data
 * cannot express — several children under one parent, several independent
 * groups, and a GRANDPARENT + GRANDCHILD whose intermediate ticket is NOT in
 * the sprint (INCREMENT_28_CONTRACTS §2a/§6). Those edges are created by
 * re-upserting already-synced `work_package_cache` rows with a different
 * `parent_op_id` — the app then behaves exactly as if OpenProject had sent
 * `_links.parent` that way; no OP call and no fixture change is involved.
 *
 * ⛔ ISOLATION (the Increment-11 incident): `bootRealApp()` uses in-process
 * PGlite — no `DATABASE_URL`, no server, no port, nothing that can reach the
 * user's real `osp` database or `atlas-core`. The mock OP listens on an ephemeral
 * port. `tests/src/env-isolation-guard.test.ts` polices this mechanically.
 *
 * WHAT IT PINS
 *   PART A  pure `ancestorDoubleCounts` — multi-child, multi-group, deep
 *           chains, absent intermediates, cycles; plus the deliberate
 *           DIVERGENCE from `leafEffort()` (§2b rule 1: display is
 *           ancestor-aware, the SUM stays direct-parent-only).
 *   PART B  the real Fastify app: §0c (a suppressed parent's developer keeps a
 *           line at 0 h) proved as a genuine BEFORE/AFTER — every pre-existing
 *           total must be byte-identical, only a new 0 h line may appear.
 *   PART C  the §2c bulk-fix endpoints: remove-parents / remove-children, the
 *           narrowing body, the "can never remove an unflagged ticket" rule,
 *           recomputation afterwards, and 409 on a locked sprint.
 */

// ═════════════════════════════════════════════════════════════════════════════
// PART A — the pure detector (no DB, no OP)
// ═════════════════════════════════════════════════════════════════════════════

type Item = { wp_op_id: number; parent_op_id: number | null };
const item = (wp: number, parent: number | null = null): Item => ({
  wp_op_id: wp,
  parent_op_id: parent,
});

/** Compact view of one id's links, so failures read as data not as objects. */
function linksOf(
  map: ReturnType<typeof ancestorDoubleCounts>,
  wp: number,
): { children: number[]; parent: number | null } {
  const l = map.get(wp);
  if (!l) throw new Error(`no links for ${wp}`);
  return { children: l.double_count_children, parent: l.double_count_parent_of };
}

describe("Increment 28 §2a — ancestorDoubleCounts (display detection)", () => {
  it("flags SEVERAL children under ONE parent, ascending and deduplicated", () => {
    const links = ancestorDoubleCounts([
      item(100),
      item(102, 100),
      item(101, 100),
      item(103, 100),
    ]);
    expect(linksOf(links, 100)).toEqual({ children: [101, 102, 103], parent: null });
    for (const child of [101, 102, 103]) {
      expect(linksOf(links, child)).toEqual({ children: [], parent: 100 });
    }
  });

  it("keeps SEVERAL INDEPENDENT groups apart — no cross-contamination", () => {
    const links = ancestorDoubleCounts([
      item(200),
      item(201, 200),
      item(202, 200),
      item(300),
      item(301, 300),
      item(400), // a lone ticket, in neither group
    ]);
    expect(linksOf(links, 200)).toEqual({ children: [201, 202], parent: null });
    expect(linksOf(links, 300)).toEqual({ children: [301], parent: null });
    expect(linksOf(links, 400)).toEqual({ children: [], parent: null });
    expect(linksOf(links, 201).parent).toBe(200);
    expect(linksOf(links, 301).parent).toBe(300);
  });

  it("GRANDPARENT + GRANDCHILD link up when the intermediate ticket is NOT in the sprint", () => {
    // Sprint holds 500 (grandparent) and 502 (grandchild). 501 (the parent of
    // 502, child of 500) is NOT in the sprint — its edge comes from the cache.
    const links = ancestorDoubleCounts(
      [item(500), item(502, 501)],
      new Map<number, number | null>([[501, 500]]),
    );
    expect(linksOf(links, 502)).toEqual({ children: [], parent: 500 });
    expect(linksOf(links, 500)).toEqual({ children: [502], parent: null });
  });

  it("reports the NEAREST in-sprint ancestor, not the topmost one", () => {
    // 600 → 601 → 602, all three in the sprint. 602's nearest is 601, but BOTH
    // 600 and 601 must list 602 as a descendant.
    const links = ancestorDoubleCounts([item(600), item(601, 600), item(602, 601)]);
    expect(linksOf(links, 602)).toEqual({ children: [], parent: 601 });
    expect(linksOf(links, 601)).toEqual({ children: [602], parent: 600 });
    expect(linksOf(links, 600)).toEqual({ children: [601, 602], parent: null });
  });

  it("walks a chain of absent intermediates several levels deep", () => {
    // 700 (in) → 701 (out) → 702 (out) → 703 (in).
    const links = ancestorDoubleCounts(
      [item(700), item(703, 702)],
      new Map<number, number | null>([
        [702, 701],
        [701, 700],
      ]),
    );
    expect(linksOf(links, 703).parent).toBe(700);
    expect(linksOf(links, 700).children).toEqual([703]);
  });

  it("never flags a ticket whose ancestors are all OUTSIDE the sprint", () => {
    const links = ancestorDoubleCounts(
      [item(800, 801)],
      new Map<number, number | null>([
        [801, 802],
        [802, null],
      ]),
    );
    expect(linksOf(links, 800)).toEqual({ children: [], parent: null });
  });

  it("survives malformed OpenProject data: a parent CYCLE terminates", () => {
    const links = ancestorDoubleCounts([item(900, 901), item(901, 900)]);
    // Each is the other's ancestor — the point is only that it TERMINATES and
    // that both ends stay consistent, never that a cycle is meaningful.
    expect(linksOf(links, 900).parent).toBe(901);
    expect(linksOf(links, 901).parent).toBe(900);
  });

  it("is a no-op for an empty or single-item sprint", () => {
    expect(ancestorDoubleCounts([]).size).toBe(0);
    const one = ancestorDoubleCounts([item(1000, 999)]);
    expect(linksOf(one, 1000)).toEqual({ children: [], parent: null });
  });

  /**
   * INCREMENT_28_CONTRACTS §2b rule 1 — this divergence is DELIBERATE and
   * load-bearing: display detection is ancestor-aware, the effort SUM stays
   * direct-parent-only so no existing total moves. If someone ever "unifies"
   * the two, this test is the alarm.
   */
  it("§2b rule 1: leafEffort stays DIRECT-parent-only while detection is ancestor-aware", () => {
    const sprint = [item(500), item(502, 501)]; // grandparent + grandchild
    const extra = new Map<number, number | null>([[501, 500]]);

    // Detection SEES the collision…
    expect(linksOf(ancestorDoubleCounts(sprint, extra), 500).children).toEqual([502]);

    // …but the sum still counts BOTH tickets (501 is absent, so 500 is not a
    // direct parent of anything present and is therefore not suppressed).
    const effort = leafEffort([
      { wp_op_id: 500, parent_op_id: null, hours: 10 },
      { wp_op_id: 502, parent_op_id: 501, hours: 4 },
    ]);
    expect(effort.total).toBe(14);
    expect(effort.warnings).toEqual([]);
    expect(effort.leaves.map((l) => l.wp_op_id).sort((a, b) => a - b)).toEqual([500, 502]);
  });
});


// ═════════════════════════════════════════════════════════════════════════════
// PART B / C — the real Fastify app over PGlite + the mock OP
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Scenario `s13-sprint-list-dimming` (project 3) — static (no timeline, no time
 * entries), several distinct holders, real estimates. `effectiveEstimate` per
 * CAPACITY_BAR_RULES §3 (`override` > (`remaining ≠ 0 ∧ ≠ work` ? `remaining` : `work`)):
 *
 *   11765  In progress    Tobias Bubenik      work  8 / rem 4 → 4
 *   11739  New            Zbynek Trnka    work  6 / rem 6 → 6
 *   11212  In progress    Vojtech Kolar     work  4 / rem 2 → 2
 *   11747  In progress    David Cesal    work  4 / rem 4 → 4
 *   11818  In progress    Ondrej Marek      work  7 / rem 5 → 5
 *   11761  Developed      Zbynek Trnka    work  8 / rem 0 → 8
 *   11687  Developed      Cameron Dalby work  6 / rem 0 → 6
 *   11785  Merge pending  Arend Kuiper      work  5 / rem 0 → 5
 *
 * ⚠️ TWO fixture facts these ids were chosen around, both learned the hard way:
 *
 * 1. Every status above is OUTSIDE `HIDDEN_BACKLOG_STATUSES` (closed /
 *    resolved / rejected / tested — `apps/api/src/routes/index.ts`). A planning
 *    sprint's capacity DROPS a non-baseline item whose status is hidden, so a
 *    "Tested" ticket silently contributes 0 h and every total here would be
 *    wrong for a reason that has nothing to do with double counting.
 *
 * 2. A SCENARIO, not the static fixture mode. The fixture-mode mock honours
 *    only the FIRST value of an `id` filter (`filterValueFrom`,
 *    `fixtures/mock-op-server/index.ts`), so activation's
 *    `fetchScopedWorkPackages` — one `id = [a,b,c]` filter — fetches exactly
 *    ONE ticket there. The scenario engine implements the filter properly
 *    (`c.values.includes(...)`, `fixtures/mock-op-server/hal.ts`).
 */
const SCENARIO = "s13-sprint-list-dimming";
const PROJECT_OP_ID = 3;

const WP = {
  parentA: 11765, // Bubenik   — parent of BOTH children below
  childA1: 11739, // Trnka
  childA2: 11212, // Kolar
  parentB: 11747, // Cesal — parent of one child
  childB1: 11818, // Marek
  grandparent: 11761, // Trnka
  intermediate: 11687, // Dalby — deliberately NEVER added to a sprint
  grandchild: 11785, // Kuiper
} as const;

const EFF: Record<number, number> = {
  [WP.parentA]: 4,
  [WP.childA1]: 6,
  [WP.childA2]: 2,
  [WP.parentB]: 4,
  [WP.childB1]: 5,
  [WP.grandparent]: 8,
  [WP.grandchild]: 5,
};

const BUBENIK = "Tobias Bubenik";
const TRNKA = "Zbynek Trnka";
const KOLAR = "Vojtech Kolar";
const CESAL = "David Cesal";
const MAREK = "Ondrej Marek";
const KUIPER = "Arend Kuiper";

interface DetailRow {
  op_id: number;
  outcome: string;
  double_count_children: number[];
  double_count_parent_of: number | null;
}

function expectOk(res: { status: number; json: unknown }, what: string): void {
  expect(res.status, `${what}: ${res.status} ${JSON.stringify(res.json)}`).toBeGreaterThanOrEqual(200);
  expect(res.status, `${what}: ${res.status} ${JSON.stringify(res.json)}`).toBeLessThan(300);
}

describe("Increment 28 §0c/§2b/§2c — double counting through the real app", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;

  /** `GET /sprints/:id/items/detailed`, keyed by op_id. */
  async function details(sprintId: number): Promise<Map<number, DetailRow>> {
    const res = await call(harness.app, "GET", `/api/sprints/${sprintId}/items/detailed`);
    expectOk(res, `items/detailed ${sprintId}`);
    return new Map((res.json as DetailRow[]).map((r) => [r.op_id, r]));
  }

  async function capacity(sprintId: number) {
    const res = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(res, `capacity ${sprintId}`);
    return CapacityResponse.parse(res.json);
  }

  /** Planned hours per person name, from the capacity LINES. */
  function plannedByName(cap: {
    lines: Array<{ name: string; planned_hours: number }>;
  }): Record<string, number> {
    return Object.fromEntries(cap.lines.map((l) => [l.name, l.planned_hours]));
  }

  async function createSprint(name: string): Promise<number> {
    const res = await call(harness.app, "POST", "/api/sprints", {
      name,
      start_date: "2026-07-06",
      end_date: "2026-07-17",
    });
    expectOk(res, `create sprint ${name}`);
    return SprintResponse.parse(res.json).id;
  }

  async function addItems(sprintId: number, wps: readonly number[]): Promise<void> {
    for (const wp of wps) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add #${wp} to sprint ${sprintId}`,
      );
    }
  }

  /**
   * Rewrite ONE cached work package's `parent_op_id`. Reads the row the sync
   * just wrote and re-upserts it with a different parent — exactly the row the
   * sync would have persisted had OpenProject reported that `_links.parent`.
   * Everything else on the row is preserved verbatim.
   */
  async function setParent(opId: number, parentOpId: number | null): Promise<void> {
    const row = await harness.repos.workPackages.getByOpId(opId);
    if (!row) throw new Error(`work_package_cache has no row for ${opId} — sync did not run?`);
    const { id: _id, cached_at: _cachedAt, ...rest } = row;
    await harness.repos.workPackages.upsertMany([
      { ...rest, parent_op_id: parentOpId } as NewWorkPackageCache,
    ]);
    const after = await harness.repos.workPackages.getByOpId(opId);
    expect(after?.parent_op_id, `parent edge ${opId} → ${parentOpId} persisted`).toBe(parentOpId);
  }

  /**
   * (Re-)apply the synthetic parent edges. Runs before EVERY test, and again
   * after anything that re-reads a ticket from OpenProject: a mid-sprint add
   * and activation both refresh the cached row straight from OP, and the mock
   * has no parent links to refresh them WITH — so an edge that only exists in
   * this test's cache write gets flattened back to null. Re-applying is
   * precisely "as if OpenProject still reported that `_links.parent`".
   */
  async function applyParentEdges(): Promise<void> {
    await setParent(WP.childA1, WP.parentA);
    await setParent(WP.childA2, WP.parentA);
    await setParent(WP.childB1, WP.parentB);
    await setParent(WP.intermediate, WP.grandparent);
    await setParent(WP.grandchild, WP.intermediate);
  }

  /**
   * `closureStats` counts DEVELOPERS only (Increment 14) and the scenario bakes
   * no roles, so leaving everyone "unset" makes every Closure-side total 0 for
   * reasons unrelated to this increment. Capacity LINES are unaffected either
   * way (unset → developer, `capacityRoleForMemberRole`). People are
   * materialised lazily by `GET /api/people` — and, non-obviously, ONLY from
   * tickets that are in SOME sprint (`buildPeople` iterates sprints, not the
   * work-package cache), so a plain sync leaves it empty. Hence the throwaway
   * roster sprint the caller creates first.
   */
  async function makeEveryoneADeveloper(): Promise<void> {
    const people = await call(harness.app, "GET", "/api/people");
    expectOk(people, "GET /api/people");
    const rows = people.json as Array<{ id: number; name: string; role: string }>;
    expect(rows.length, "GET /api/people materialised the scenario's holders").toBeGreaterThan(0);
    for (const p of rows) {
      if (p.role === "developer") continue;
      expectOk(
        await call(harness.app, "PUT", `/api/people/${p.id}/role`, { role: "developer" }),
        `role developer for ${p.name}`,
      );
    }
  }

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await connectToOp(harness.app, mock.url, "inc28-token", PROJECT_OP_ID);
    const load = await fetch(`${mock.url}/__mock/load/${SCENARIO}`, { method: "POST" });
    expect(load.ok, `load scenario ${SCENARIO}: ${load.status}`).toBe(true);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: PROJECT_OP_ID });
    expect(SyncRun.parse(sync.json).status, `sync project ${PROJECT_OP_ID}`).toBe("success");
    // A throwaway roster sprint holding every ticket this file uses, purely so
    // `GET /api/people` has something to materialise people FROM. It is never
    // asserted on; each test below builds its own sprint.
    const rosterSprint = await createSprint("Inc28 roster (setup only)");
    await addItems(rosterSprint, Object.values(WP));
    await makeEveryoneADeveloper();
    await applyParentEdges();
  }, 60_000);

  beforeEach(async () => {
    await applyParentEdges();
  });

  afterAll(async () => {
    await harness?.close();
    await mock?.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PART B — §0c: the parent's developer stops vanishing, and NO total moves.
  // ───────────────────────────────────────────────────────────────────────────
  it("§0c/§2b: adding a suppressed PARENT adds a 0 h line and moves NO existing total", async () => {
    const sprintId = await createSprint("Inc28 §0c before/after");

    // BEFORE — only the children are in the sprint.
    await addItems(sprintId, [WP.childA1, WP.childA2, WP.childB1]);
    const before = await capacity(sprintId);
    const beforePlanned = plannedByName(before);
    expect(beforePlanned[TRNKA]).toBe(EFF[WP.childA1]);
    expect(beforePlanned[KOLAR]).toBe(EFF[WP.childA2]);
    expect(beforePlanned[MAREK]).toBe(EFF[WP.childB1]);
    expect(beforePlanned[BUBENIK], "the parentA holder has nothing yet").toBeUndefined();
    expect(beforePlanned[CESAL], "the parentB holder has nothing yet").toBeUndefined();
    expect(before.total_planned_hours).toBe(
      EFF[WP.childA1]! + EFF[WP.childA2]! + EFF[WP.childB1]!,
    );

    // AFTER — add the two parents, which the leaf guard suppresses.
    await addItems(sprintId, [WP.parentA, WP.parentB]);
    const after = await capacity(sprintId);
    const afterPlanned = plannedByName(after);

    // (1) The previously-MISSING developers now have a line, at exactly 0 h.
    //     Pre-Increment-28 these lines did not exist at all (§0c, measured).
    for (const holder of [BUBENIK, CESAL]) {
      expect(after.lines.map((l) => l.name), `${holder} has a capacity line`).toContain(holder);
      expect(afterPlanned[holder], `${holder}'s suppressed parent contributes 0 h`).toBe(0);
    }

    // (2) NOTHING else moved — the whole point of §2b.
    expect(afterPlanned[TRNKA]).toBe(beforePlanned[TRNKA]);
    expect(afterPlanned[KOLAR]).toBe(beforePlanned[KOLAR]);
    expect(afterPlanned[MAREK]).toBe(beforePlanned[MAREK]);
    expect(after.total_planned_hours, "leaf-filtered total unchanged").toBe(
      before.total_planned_hours,
    );
    expect(after.total_available_hours).toBe(before.total_available_hours);

    // (3) …and the roll-up is byte-identical line for line, bar the new ones.
    const strip = (cap: typeof before) =>
      cap.lines
        .filter((l) => l.name !== BUBENIK && l.name !== CESAL)
        .sort((a, b) => a.name.localeCompare(b.name));
    expect(strip(after)).toEqual(strip(before));

    // (4) The suppressed parents ARE flagged for display, on both ends.
    const d = await details(sprintId);
    expect(d.get(WP.parentA)?.double_count_children).toEqual(
      [WP.childA1, WP.childA2].sort((a, b) => a - b),
    );
    expect(d.get(WP.parentB)?.double_count_children).toEqual([WP.childB1]);
    expect(d.get(WP.childA1)?.double_count_parent_of).toBe(WP.parentA);
    expect(d.get(WP.childA2)?.double_count_parent_of).toBe(WP.parentA);
    expect(d.get(WP.childB1)?.double_count_parent_of).toBe(WP.parentB);
  });

  /**
   * The §0c defect survived activation too ("the parent frozen out of baseline
   * too"). What is provable HERE is the half that matters on screen: an ACTIVE
   * sprint's Capacity panel still shows the parent's developer.
   *
   * `baseline_total_hours` is deliberately NOT asserted: `computeBaselineTotalHours`
   * (`apps/api/src/logic/sprintUpdate.ts`) derives the leaf suppression from the
   * FRESHLY-FETCHED OpenProject payload's `_links.parent`, not from
   * `work_package_cache.parent_op_id` that every other code path reads — so a
   * cache-only edge is invisible to it by construction. See the Agent D report:
   * that is a second, independent implementation of the leaf rule.
   */
  it("§0c: the parent's developer stays visible on an ACTIVE sprint too", async () => {
    const sprintId = await createSprint("Inc28 §0c activation");
    await addItems(sprintId, [WP.childA1, WP.childA2, WP.parentA]);
    expectOk(await activateSprint(harness.app, sprintId), "activate");
    await applyParentEdges(); // activation re-cached from OP, which has no parents

    const cap = await capacity(sprintId);
    expect(cap.lines.map((l) => l.name), "the parent's developer is not frozen out").toContain(
      BUBENIK,
    );
    expect(plannedByName(cap)[BUBENIK]).toBe(0);
    expect(cap.total_planned_hours).toBe(EFF[WP.childA1]! + EFF[WP.childA2]!);

    const d = await details(sprintId);
    expect(d.get(WP.parentA)?.double_count_children).toEqual(
      [WP.childA1, WP.childA2].sort((a, b) => a - b),
    );
  });

  /**
   * CAPACITY_BAR_RULES §5 invariant 5 — "Planned / Delivered and the
   * per-developer table are identical across Capacity panel, Closure, Sprint
   * detail, PDF". `scope_planned_hours` (the Capacity panel's own "Planned")
   * and Closure's `total_planned_hours` come from the SAME `developerSegments`
   * pipeline, so they must agree even with a collision present.
   */
  it("§5 invariant 5: Capacity's scope_planned_hours == Closure's total_planned_hours, collision or not", async () => {
    const sprintId = await createSprint("Inc28 panel agreement");
    await addItems(sprintId, [WP.parentA, WP.childA1, WP.childA2]);

    const cap = await capacity(sprintId);
    const closure = await call(harness.app, "GET", `/api/sprints/${sprintId}/closure-stats`);
    expectOk(closure, "closure-stats");
    const stats = closure.json as {
      total_planned_hours: number;
      total_baseline_hours: number;
      total_delivered_hours: number;
      per_developer: Array<{ name: string; planned_hours: number; baseline_hours: number }>;
    };

    expect(cap.scope_planned_hours).toBe(stats.total_planned_hours);
    expect(cap.scope_delivered_hours).toBe(stats.total_delivered_hours);

    // ⚠️ CHANGED in Increment 30 — a DELIBERATE semantic change, adjudicated in
    // `docs/INCREMENT_30_CONTRACTS.md` §2b(ii), which explicitly SUPERSEDES the
    // Increment 28 statement this assertion used to pin ("Closure has no leaf
    // filtering by design").
    //
    // That design is exactly what let `cap.total_planned_hours` (leaf-filtered,
    // 8) and `cap.scope_planned_hours` (not, 12) disagree INSIDE A SINGLE
    // RESPONSE — the user could not reproduce the header from the rows beneath
    // it. That is now `CAPACITY_BAR_RULES.md` §6 invariant 8, and §5a (binding)
    // says the parent's hours are suppressed FROM THE SUM. So the canonical
    // answer is the leaf-filtered one and both fields now read 8.
    //
    // Recomputed by hand, not renamed:
    //   parentA is suppressed (both its children are in the sprint) → 0
    //   childA1 + childA2                                           → 8
    const leafOnly = EFF[WP.childA1]! + EFF[WP.childA2]!;
    expect(stats.total_planned_hours, "Planned is leaf-filtered on BOTH surfaces now").toBe(leafOnly);
    expect(cap.total_planned_hours, "…and the two Capacity fields finally agree").toBe(leafOnly);

    // §2b(ii) also states B5 is NOT regressed. Proven, not assumed: the parent's
    // holder keeps a Closure row whose `baseline_hours` still carries the full
    // parent estimate (the suppression is a Planned-SUM rule, not a segment
    // rule), plus a 0 h Capacity line that cannot be removed.
    const bubenik = stats.per_developer.find((d) => d.name === BUBENIK);
    expect(bubenik, "the parent's holder still has a Closure row").toBeTruthy();
    expect(bubenik!.planned_hours, "…contributing 0 h to Planned (suppressed)").toBe(0);
    expect(bubenik!.baseline_hours, "…while Baseline keeps the parent's hours intact").toBe(
      EFF[WP.parentA],
    );
    const bubenikLine = cap.lines.find((l) => l.name === BUBENIK);
    expect(bubenikLine, "…and a Capacity line exists (the developer never vanishes)").toBeTruthy();
    expect(bubenikLine!.planned_hours).toBe(0);
    expect(bubenikLine!.has_sprint_work, "…flagged as re-derived from the items").toBe(true);
  });

  it("§2a/§6: a GRANDPARENT and GRANDCHILD are flagged even though the intermediate ticket is not in the sprint", async () => {
    const sprintId = await createSprint("Inc28 grandparent chain");
    await addItems(sprintId, [WP.grandparent, WP.grandchild]);

    const d = await details(sprintId);
    expect(d.has(WP.intermediate), "the intermediate ticket really is absent").toBe(false);
    expect(d.get(WP.grandparent)?.double_count_children).toEqual([WP.grandchild]);
    expect(d.get(WP.grandchild)?.double_count_parent_of).toBe(WP.grandparent);

    // §2b rule 1: the SUM still counts both — the collision is marked, not
    // silently re-arithmetic'd. Nobody is suppressed, so nobody sits at 0 h.
    const cap = await capacity(sprintId);
    expect(cap.total_planned_hours).toBe(EFF[WP.grandparent]! + EFF[WP.grandchild]!);
    expect(plannedByName(cap)[TRNKA]).toBe(EFF[WP.grandparent]);
    expect(plannedByName(cap)[KUIPER]).toBe(EFF[WP.grandchild]);
  });

  it("a REMOVED item is neither a parent nor a child of a collision", async () => {
    const sprintId = await createSprint("Inc28 removed not flagged");
    await addItems(sprintId, [WP.parentA, WP.childA1, WP.childA2]);
    expectOk(
      await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${WP.childA1}`),
      "remove one child",
    );

    const d = await details(sprintId);
    expect(d.get(WP.childA1)?.double_count_parent_of, "a removed row is out of scope").toBeNull();
    expect(d.get(WP.childA1)?.double_count_children).toEqual([]);
    expect(d.get(WP.parentA)?.double_count_children, "only the surviving child").toEqual([
      WP.childA2,
    ]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PART C — §2c the one-click fix.
  // ───────────────────────────────────────────────────────────────────────────
  it("§2c: 'Remove parent(s)' clears every collision and recomputes capacity", async () => {
    const sprintId = await createSprint("Inc28 remove parents");
    await addItems(sprintId, [WP.parentA, WP.childA1, WP.childA2, WP.parentB, WP.childB1]);
    const before = await capacity(sprintId);

    const res = await call(
      harness.app,
      "POST",
      `/api/sprints/${sprintId}/double-count/remove-parents`,
    );
    expectOk(res, "remove-parents");
    const body = res.json as { removed_wp_op_ids: number[]; items: DetailRow[] };
    expect(body.removed_wp_op_ids.sort((a, b) => a - b)).toEqual(
      [WP.parentA, WP.parentB].sort((a, b) => a - b),
    );

    // The warning is gone: nothing is flagged any more, on either side.
    for (const row of body.items) {
      expect(row.double_count_children, `#${row.op_id} children`).toEqual([]);
      expect(row.double_count_parent_of, `#${row.op_id} parent`).toBeNull();
    }

    // …and the numbers recompute. Removing a SUPPRESSED parent contributes no
    // hours, so the leaf-filtered total is unchanged — the collision was the
    // problem, not the arithmetic (§2b).
    const after = await capacity(sprintId);
    expect(after.total_planned_hours).toBe(before.total_planned_hours);
    expect(plannedByName(after)[TRNKA]).toBe(EFF[WP.childA1]);
    expect(plannedByName(after)[KOLAR]).toBe(EFF[WP.childA2]);
    expect(plannedByName(after)[MAREK]).toBe(EFF[WP.childB1]);
    // The parents' holders held ONLY the removed tickets — with nothing left
    // they drop out again.
    expect(after.lines.map((l) => l.name)).not.toContain(BUBENIK);
    expect(after.lines.map((l) => l.name)).not.toContain(CESAL);
  });

  it("§2c: 'Remove children' clears every collision and hands the hours back to the parents", async () => {
    const sprintId = await createSprint("Inc28 remove children");
    await addItems(sprintId, [WP.parentA, WP.childA1, WP.childA2, WP.parentB, WP.childB1]);

    const res = await call(
      harness.app,
      "POST",
      `/api/sprints/${sprintId}/double-count/remove-children`,
    );
    expectOk(res, "remove-children");
    const body = res.json as { removed_wp_op_ids: number[]; items: DetailRow[] };
    expect(body.removed_wp_op_ids.sort((a, b) => a - b)).toEqual(
      [WP.childA1, WP.childA2, WP.childB1].sort((a, b) => a - b),
    );
    for (const row of body.items) {
      expect(row.double_count_children).toEqual([]);
      expect(row.double_count_parent_of).toBeNull();
    }

    // With no children left, the parents are no longer suppressed — they now
    // carry their own hours, and the total is the two parents' estimates.
    const after = await capacity(sprintId);
    expect(plannedByName(after)[BUBENIK]).toBe(EFF[WP.parentA]);
    expect(plannedByName(after)[CESAL]).toBe(EFF[WP.parentB]);
    expect(after.total_planned_hours).toBe(EFF[WP.parentA]! + EFF[WP.parentB]!);
  });

  it("§2c: an explicit wp_op_ids body may only NARROW the flagged set, never reach an unflagged ticket", async () => {
    const sprintId = await createSprint("Inc28 narrowing body");
    await addItems(sprintId, [WP.parentA, WP.childA1, WP.childA2, WP.parentB, WP.childB1]);

    // Narrow to ONE parent, and simultaneously try to smuggle in a ticket that
    // is not flagged as a parent at all (childA1 is a CHILD).
    const res = await call(
      harness.app,
      "POST",
      `/api/sprints/${sprintId}/double-count/remove-parents`,
      { wp_op_ids: [WP.parentB, WP.childA1] },
    );
    expectOk(res, "narrowed remove-parents");
    const body = res.json as { removed_wp_op_ids: number[] };
    expect(body.removed_wp_op_ids, "only the flagged parent in the list").toEqual([WP.parentB]);

    const d = await details(sprintId);
    expect(d.get(WP.childA1)?.outcome, "the smuggled child is untouched").toBe("planned");
    expect(d.get(WP.parentA)?.double_count_children, "the other group survives").toEqual(
      [WP.childA1, WP.childA2].sort((a, b) => a - b),
    );
  });

  it("§2c: on an ACTIVE sprint the bulk fix keeps the row (removed_mid_sprint), never a hard delete", async () => {
    const sprintId = await createSprint("Inc28 active bulk fix");
    await addItems(sprintId, [WP.parentA, WP.childA1]);
    expectOk(await activateSprint(harness.app, sprintId), "activate");
    await applyParentEdges();

    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/double-count/remove-parents`),
      "remove-parents on an active sprint",
    );
    const d = await details(sprintId);
    expect(d.get(WP.parentA)?.outcome, "SPEC_05: the row survives with its history").toBe(
      "removed_mid_sprint",
    );
  });

  it("§2c: BOTH bulk endpoints answer 409 on a locked sprint, but the MARKING still renders", async () => {
    const sprintId = await createSprint("Inc28 locked bulk fix");
    await addItems(sprintId, [WP.parentA, WP.childA1]);
    expectOk(await activateSprint(harness.app, sprintId), "activate");
    expectOk(await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`), "finish (locks)");
    await applyParentEdges();

    for (const side of ["remove-parents", "remove-children"] as const) {
      const res = await call(harness.app, "POST", `/api/sprints/${sprintId}/double-count/${side}`);
      expect(res.status, `${side} on a locked sprint`).toBe(409);
      expect(errorCode(res.json), `${side} error code`).toMatch(/SPRINT_LOCKED|SPRINT_CLOSED/);
    }

    // §2c: badges stay on a locked sprint, only the ACTIONS disappear.
    const d = await details(sprintId);
    expect(d.get(WP.parentA)?.double_count_children).toEqual([WP.childA1]);
    expect(d.get(WP.childA1)?.double_count_parent_of).toBe(WP.parentA);
  });

  it("guardrail: none of the above issued a non-GET request to OpenProject", () => {
    const mutating = mock.requests.filter(
      (r) => r.path.startsWith("/api/v3/") && r.method !== "GET",
    );
    expect(mutating, `non-GET OP traffic: ${JSON.stringify(mutating)}`).toEqual([]);
    // Increment 13 §1a: the admin-gated user COLLECTION is never called.
    // `/users/me` (connection validation) and `/users/:id` stay legitimate.
    const userCollection = mock.requests.filter((r) => r.path === "/api/v3/users");
    expect(userCollection, "GET /api/v3/users (the COLLECTION) is forbidden").toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — Increment 28 §1: an estimate change must recalculate EVERY surface.
//
// ⚠️ FINDING (Agent D). Contracts §0a concluded "§1 is a FRONTEND-ONLY bug —
// GET /sprints/:id/capacity reflects the new effectiveEstimate immediately".
// That was measured on `capacity.lines[].planned_hours` ALONE. Two other
// numbers on the very same response come from a DIFFERENT estimate of record:
//
//   computeCapacity      → live `effectiveEstimate(work, remaining, override)`
//   computeClosureStats  → `sprint_item.planned_hours`, the snapshot FROZEN
//                          when the ticket was added (closureStats.ts:291,
//                          "Estimate-of-record for this ticket = the item's
//                          frozen planned snapshot") — nothing updates it
//                          afterwards.
//
// `scope_planned_hours` (the Capacity panel's own "Planned" figure), Closure's
// `total_planned_hours`, every `per_developer[].planned_hours`, and the
// `segments[].estimate_hours` the GREEN BAR is drawn from all read the frozen
// path. So after an override — or after a sync pulls a new `remainingTime` —
// the bar length and the headline Planned figure keep showing the OLD estimate
// no matter how many times the frontend re-fetches. That is the user-reported
// symptom, and no `refreshKey` change can fix it.
//
// This block encodes the CONTRACT (INCREMENT_28_CONTRACTS §1 + CAPACITY_BAR_RULES
// §3 "bar length = effectiveEstimate" and §5 invariant 5 "identical across
// Capacity panel, Closure, Sprint detail, PDF"), so it fails until the two
// paths agree.
// ═════════════════════════════════════════════════════════════════════════════

describe("Increment 28 §1 — an estimate override recalculates EVERY capacity surface", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let sprintId = 0;

  const WP_UNDER_TEST = 11797; // Tobias Bubenik, Confirmed, work 5 / rem 5 → effEst 5
  const BASE_EFF = 5;
  const OVERRIDE_HOURS = 40;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    await connectToOp(harness.app, mock.url, "inc28-est-token", PROJECT_OP_ID);
    const load = await fetch(`${mock.url}/__mock/load/${SCENARIO}`, { method: "POST" });
    expect(load.ok, `load scenario ${SCENARIO}`).toBe(true);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: PROJECT_OP_ID });
    expect(SyncRun.parse(sync.json).status).toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "Inc28 §1 estimate change",
      start_date: "2026-07-06",
      end_date: "2026-07-17",
    });
    expectOk(created, "create sprint");
    sprintId = SprintResponse.parse(created.json).id;
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
        wp_op_id: WP_UNDER_TEST,
      }),
      `add #${WP_UNDER_TEST}`,
    );

    // Closure counts DEVELOPERS only — without a role every figure below is 0
    // for a reason unrelated to this test.
    const people = await call(harness.app, "GET", "/api/people");
    expectOk(people, "GET /api/people");
    for (const p of people.json as Array<{ id: number; name: string }>) {
      expectOk(
        await call(harness.app, "PUT", `/api/people/${p.id}/role`, { role: "developer" }),
        `role for ${p.name}`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
    await mock?.close();
  });

  it("every estimate-of-record on GET /capacity agrees BEFORE the override (the baseline)", async () => {
    const res = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(res, "capacity");
    const cap = CapacityResponse.parse(res.json);
    expect(cap.lines.find((l) => l.name === BUBENIK)?.planned_hours).toBe(BASE_EFF);
    expect(cap.scope_planned_hours).toBe(BASE_EFF);
    expect(cap.total_planned_hours).toBe(BASE_EFF);
  });

  it("§1: after POST /estimate-override the LINE, the Planned header, Closure and the BAR all move", async () => {
    expectOk(
      await call(harness.app, "POST", "/api/estimate-override", {
        wp_op_id: WP_UNDER_TEST,
        planning_hours: OVERRIDE_HOURS,
      }),
      "save override",
    );

    const res = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expectOk(res, "capacity after override");
    const cap = CapacityResponse.parse(res.json);
    const closureRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/closure-stats`);
    expectOk(closureRes, "closure-stats after override");
    const closure = closureRes.json as {
      total_planned_hours: number;
      per_developer: Array<{
        name: string;
        planned_hours: number;
        segments: Array<{ wp_op_id: number; kind: string; estimate_hours: number | null }>;
      }>;
    };

    // (1) The per-line workload — already correct today (contracts §0a).
    expect(
      cap.lines.find((l) => l.name === BUBENIK)?.planned_hours,
      "capacity LINE follows the override",
    ).toBe(OVERRIDE_HOURS);
    expect(cap.total_planned_hours).toBe(OVERRIDE_HOURS);

    // (2) The Capacity panel's own "Planned" header — CAPACITY_BAR_RULES §5
    //     invariant 5 makes this the SAME number as Closure's.
    expect(cap.scope_planned_hours, "Capacity panel Planned follows the override").toBe(
      OVERRIDE_HOURS,
    );
    expect(closure.total_planned_hours, "Closure Planned follows the override").toBe(
      OVERRIDE_HOURS,
    );
    expect(cap.scope_planned_hours).toBe(closure.total_planned_hours);

    // (3) The GREEN BAR's length — CAPACITY_BAR_RULES §3 "bar length =
    //     effectiveEstimate", and §3's precedence puts `override` first.
    const dev = closure.per_developer.find((d) => d.name === BUBENIK);
    expect(dev, `${BUBENIK} is in per_developer`).toBeTruthy();
    expect(dev!.planned_hours, "the per-developer Planned follows the override").toBe(
      OVERRIDE_HOURS,
    );
    const seg = dev!.segments.find((s) => s.wp_op_id === WP_UNDER_TEST);
    expect(seg, `a segment exists for #${WP_UNDER_TEST}`).toBeTruthy();
    expect(seg!.kind, "planning → one solid green segment (Increment 24/26)").toBe(
      "baseline_worked",
    );
    expect(seg!.estimate_hours, "the bar is drawn at the OVERRIDE, not the frozen snapshot").toBe(
      OVERRIDE_HOURS,
    );
  });

});
