import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import {
  S21_ESTIMATE,
  S21_PROJECT_ID,
  S21_REESTIMATED_HOURS,
  S21_USERS,
  S21_WP,
} from "@osp/fixtures/scenarios";
import {
  CapacityResponse,
  ClosureStatsResponse,
  ReportDetailResponse,
  SprintResponse,
  SyncRun,
} from "@osp/contracts";
import type {
  AssigneeInterval,
  DeveloperCapacityBreakdown,
  DeveloperSegmentsTicketInput,
  PersonRole,
} from "@osp/contracts";
import { personKey } from "@osp/contracts";
import { developerSegments } from "../../apps/api/src/logic/developerSegments";
import { renderReportHtml } from "../../apps/api/src/logic/report";
import { addDays, mockAdmin, type MockAdmin } from "./scenario-helpers";
import { activateSprint, bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * Increment 30 — Agent D (QA / verification).
 *
 * `docs/INCREMENT_30_CONTRACTS.md` §1.1 changed the binding meaning of
 * **Planned**: it is now CURRENT SCOPE (Σ `effectiveEstimate` of the tickets
 * currently in the sprint and currently assigned to that developer), not the
 * retained baseline. `docs/CAPACITY_BAR_RULES.md` §5 was rewritten in the same
 * change and grew invariants **7, 8, 9**. This file is their regression suite,
 * plus the §6.5 cross-surface identity check that only became genuinely
 * testable once one computation feeds all four surfaces.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 * The evidence behind SPEC_30 §0 lives in the USER'S REAL DATABASE, which is
 * off-limits to every agent for any reason, read-only included (contracts §6.1).
 * So per the product owner's decision (contracts §1.3) the sprint's SHAPE is
 * reproduced as `fixtures/scenarios/s21-inc30-current-scope-planned.ts` and
 * MEASURED here. **Not one production number is asserted anywhere in this
 * file** — every expectation below is hand-computed from that fixture, and the
 * derivation is written out next to the assertion that uses it.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * `bootRealApp()` — ephemeral in-process PGlite plus `app.inject` (no listening
 * port), against a recording mock OpenProject on port 0. No `DATABASE_URL`, no
 * `PORT`, nothing that could reach `osp` / `atlas-core` / the legacy sqlite file.
 *
 * ── Why every state transition happens in `beforeAll` ───────────────────────
 * The fixture is STATEFUL: activate → handoff → mid-sprint add → scope removal.
 * Building any of that drift inside an `it` makes later legs depend on earlier
 * ones, which produced false greens in Increment 29 (a failed test discards the
 * worker and re-runs setup). The whole story is therefore driven once, in
 * `beforeAll`, and each snapshot frozen; every `it` is a pure assertion over
 * already-captured data.
 */

const SCENARIO = "s21-inc30-current-scope-planned";

const STASTNA = S21_USERS.stastna.name;
const REZAC = S21_USERS.rezac.name;
const HAJKOVA = S21_USERS.hajkova.name;
const PRAZAK = S21_USERS.prazak.name;
const DOLINSKY = S21_USERS.dolinsky.name;

const E = S21_ESTIMATE;

// ═════════════════════════════════════════════════════════════════════════════
// HAND-COMPUTED EXPECTATIONS  (see the fixture header for the full shape)
//
// Roles: Stastna / Rezac / Prazak / Dolinsky = developer; Hajkova = TESTER.
// Every ticket's effectiveEstimate == its seeded `estimatedHours`, because
// remaining always mirrors work (fixture header) — except #86012, re-estimated
// 6 h → 14 h on day 3, AFTER Rezac acquired it.
//
// Baseline scope (captured at activation): 86001, 86002, 86003, 86004, 86005,
// 86008, 86010, 86011. Added after activation: 86006, 86007, 86012. Removed
// from scope after activation: 86004.
//
// FINAL STATE (snapshot D) — Planned = Σ effectiveEstimate of the tickets
// CURRENTLY in the sprint and CURRENTLY assigned to that developer:
//
//   Ludmila Stastna   #86001 baseline_worked  12
//                     #86002 baseline_worked   6   (zero logged — still green)
//                     #86003 handoff           —   (moved to Rezac → 0)
//                     #86004 removed from scope —   (out of scope → 0)
//                     #86007 idle              4   (added, held, unworked)
//                     ────────────────────────────
//                     Planned  12 + 6 + 4       = 22
//                     Baseline 12 + 6 + 8 + 5   = 31   (Increment 38: signed up
//                                                      for at Activate — incl.
//                                                      the handoff and the
//                                                      removed #86004)
//                     ±Change                   = −5   (#86004 removed)
//
//   Bohumil Rezac     #86005 baseline_worked  10
//                     #86003 acquired          8   (received the handoff, logged)
//                     #86006 acquired          9   (added after activation, logged)
//                     #86012 acquired         14   (added, logged, RE-ESTIMATED)
//                     ────────────────────────────
//                     Planned  10 + 8 + 9 + 14  = 41
//                     Baseline 10               = 10
//                     ±Change   8 + 9 + 14      = +31
//                     (Until Increment 38 the app measured 18 / +23 here: #86003
//                     was attributed to its RECEIVER at the anchor — see the
//                     "FIXED in Increment 38" block at the end of this file.)
//
//   Oskar Prazak      #86010 the PARENT of #86011, both in the sprint → the
//                     leaf guard suppresses its 20 h FROM PLANNED. Prazak holds
//                     NOTHING else, so Planned = 0 — but he must NOT disappear,
//                     and per contracts §2b(ii) his `baseline_hours` stays
//                     INTACT at 20 (the suppression is a Planned-sum rule, not
//                     a segment rule; §2a leaves the segments alone).
//
//   Ivan Dolinsky     #86011 baseline_worked  15 → Planned = Baseline = 15
//
//   Vendula Hajkova   #86008, 7 h, logged 3 h — a TESTER: solid grey, no
//                     developer row at all, excluded from every aggregate.
//
//   AGGREGATE (developers only): 22 + 41 +  0 + 15 = 78 Planned
//                                31 + 10 + 20 + 15 = 76 Baseline
//
// 78 ≠ 76 by construction: that gap IS invariant 7. A surface still reporting
// the baseline sum under the name "Planned" reads 76 and fails here.
// ═════════════════════════════════════════════════════════════════════════════

const PLANNED_FINAL: Record<string, number> = {
  [STASTNA]: E[S21_WP.retainedWorked]! + E[S21_WP.retainedUnworked]! + E[S21_WP.addedHeldUnworked]!, // 22
  [REZAC]:
    E[S21_WP.rezacBaseline]! + E[S21_WP.handedOff]! + E[S21_WP.addedAndWorked]! + S21_REESTIMATED_HOURS, // 41
  [PRAZAK]: 0,
  [DOLINSKY]: E[S21_WP.dcChild]!, // 15
};
/**
 * Baseline per `CAPACITY_BAR_RULES.md` §5 (Increment 38): what each developer
 * was signed up for at Activate — handed-off (#86003) and removed (#86004)
 * tickets included, on their ACTIVATION holder.
 */
const BASELINE_FINAL: Record<string, number> = {
  [STASTNA]:
    E[S21_WP.retainedWorked]! +
    E[S21_WP.retainedUnworked]! +
    E[S21_WP.handedOff]! +
    E[S21_WP.scopeRemoved]!, // 31
  [REZAC]: E[S21_WP.rezacBaseline]!, // 10
  // contracts §2b(ii): the leaf guard suppresses the parent from PLANNED, not
  // from the segment set — so Prazak's Baseline keeps the full 20 h.
  [PRAZAK]: E[S21_WP.dcParent]!, // 20
  [DOLINSKY]: E[S21_WP.dcChild]!, // 15
};
const CHANGE_FINAL: Record<string, number> = {
  [STASTNA]: -E[S21_WP.scopeRemoved]!, // −5 (removed from the sprint after activation)
  [REZAC]: E[S21_WP.handedOff]! + E[S21_WP.addedAndWorked]! + S21_REESTIMATED_HOURS, // +31
  [PRAZAK]: 0,
  [DOLINSKY]: 0,
};
const TOTAL_PLANNED_FINAL = 22 + 41 + 0 + 15; // 78
const TOTAL_BASELINE_FINAL = 31 + 10 + 20 + 15; // 76
const TOTAL_CHANGE_FINAL = -5 + 31; // 26

/** Planned per developer at each earlier snapshot — see `beforeAll` for the story. */
// A: straight after activation (baseline only; nothing has moved yet).
const PLANNED_A: Record<string, number> = {
  [STASTNA]:
    E[S21_WP.retainedWorked]! +
    E[S21_WP.retainedUnworked]! +
    E[S21_WP.handedOff]! +
    E[S21_WP.scopeRemoved]!, // 31
  [REZAC]: E[S21_WP.rezacBaseline]!, // 10
  [PRAZAK]: 0,
  [DOLINSKY]: E[S21_WP.dcChild]!, // 15
};
// B: after the day-2 dev→dev handoff of #86003 (8 h) — Stastna 31→23, Rezac 10→18.
const PLANNED_B: Record<string, number> = {
  [STASTNA]: PLANNED_A[STASTNA]! - E[S21_WP.handedOff]!, // 23
  [REZAC]: PLANNED_A[REZAC]! + E[S21_WP.handedOff]!, // 18
  [PRAZAK]: 0,
  [DOLINSKY]: E[S21_WP.dcChild]!, // 15
};
// C: after adding #86006 (9, Rezac), #86007 (4, Stastna), #86012 (now 14, Rezac).
const PLANNED_C: Record<string, number> = {
  [STASTNA]: PLANNED_B[STASTNA]! + E[S21_WP.addedHeldUnworked]!, // 27
  [REZAC]: PLANNED_B[REZAC]! + E[S21_WP.addedAndWorked]! + S21_REESTIMATED_HOURS, // 41
  [PRAZAK]: 0,
  [DOLINSKY]: E[S21_WP.dcChild]!, // 15
};

interface Snapshot {
  label: string;
  capacity: CapacityResponse;
  closure: ClosureStatsResponse;
}

interface Ctx {
  mock: RecordingMockOpServer;
  admin: MockAdmin;
  harness: RealApp;
  sprintId: number;
  A: Snapshot;
  B: Snapshot;
  C: Snapshot;
  D: Snapshot;
  report: ReportDetailResponse;
  pdfHtml: string;
  /** `ticket_baseline.original_assignee_op_id` for #86003 — the FROZEN record of
   * who held the handed-off ticket at activation (used by the Increment 38 block). */
  baselineOriginalAssignee: number | null;
}

let ctx: Ctx;

function expectOk(res: { status: number; json: unknown }, what: string): void {
  expect(res.status, `${what}: HTTP ${res.status} ${JSON.stringify(res.json)}`).toBeGreaterThanOrEqual(
    200,
  );
  expect(res.status, `${what}: HTTP ${res.status} ${JSON.stringify(res.json)}`).toBeLessThan(300);
}

/** Per-developer Planned from the CLOSURE surface, keyed by name. */
function closurePlanned(s: Snapshot): Record<string, number> {
  return Object.fromEntries(s.closure.per_developer.map((d) => [d.name, d.planned_hours]));
}

/** Per-person Planned from the CAPACITY LINES surface, keyed by name. */
function linePlanned(s: Snapshot): Record<string, number> {
  return Object.fromEntries(s.capacity.lines.map((l) => [l.name, l.planned_hours]));
}

function dev(s: Snapshot, name: string): DeveloperCapacityBreakdown {
  const d = s.closure.per_developer.find((x) => x.name === name);
  expect(d, `${s.label}: "${name}" must appear in closure.per_developer`).toBeTruthy();
  return d!;
}

/** A developer's segment for one work package (or undefined when absent). */
function seg(s: Snapshot, name: string, wp: number) {
  return dev(s, name).segments.find((x) => x.wp_op_id === wp);
}

describe("Increment 30 — Planned = current scope (CAPACITY_BAR_RULES §6 invariants 7-9, §6.5)", () => {
  beforeAll(async () => {
    const mock = await createRecordingMockOpServer();
    const admin = mockAdmin(mock.url);
    await admin.requireScenario(SCENARIO);

    const loaded = await admin.load(SCENARIO);
    const d0 = loaded.date!;
    // The app clock tracks the mock's LOGICAL calendar, never wall time — that
    // is what keeps the sprint window valid and the changelog's
    // `createdAt >= activated_at` filter from discarding scenario journals.
    // (It also means this suite cannot rot the way a hardcoded-month e2e window
    // did in commit a612a61: nothing here compares against `new Date()`.)
    const clock = { now: new Date(`${d0}T00:00:00.000Z`) };
    const harness = await bootRealApp({ now: () => clock.now });

    await connectToOp(harness.app, mock.url, "s21-token", S21_PROJECT_ID);
    const sync = await call(harness.app, "POST", "/api/sync", { project_op_id: S21_PROJECT_ID });
    expectOk(sync, "initial sync");
    expect(SyncRun.parse(sync.json).status, "initial sync succeeded").toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "Inc30 current-scope sprint",
      start_date: d0,
      end_date: addDays(d0, 9),
    });
    expectOk(created, "create sprint");
    const sprintId = SprintResponse.parse(created.json).id;

    // ── BASELINE scope: everything except the three the test adds later ──────
    const BASELINE_ITEMS = [
      S21_WP.retainedWorked,
      S21_WP.retainedUnworked,
      S21_WP.handedOff,
      S21_WP.scopeRemoved,
      S21_WP.rezacBaseline,
      S21_WP.testerHeld,
      S21_WP.dcParent,
      S21_WP.dcChild,
    ];
    for (const wp of BASELINE_ITEMS) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add baseline item #${wp}`,
      );
    }

    // ── Roles. `GET /api/people` materialises holders from SPRINT items, so it
    //    has to run after the baseline is in place. Hajkova is the tester; the
    //    other four are developers.
    const people = await call(harness.app, "GET", "/api/people");
    expectOk(people, "GET /api/people");
    const rows = people.json as Array<{ id: number; name: string; role: PersonRole }>;
    const roleFor: Record<string, PersonRole> = {
      [STASTNA]: "developer",
      [REZAC]: "developer",
      [PRAZAK]: "developer",
      [DOLINSKY]: "developer",
      [HAJKOVA]: "tester",
    };
    for (const [name, role] of Object.entries(roleFor)) {
      const person = rows.find((p) => p.name === name);
      expect(person, `GET /api/people materialised "${name}"`).toBeTruthy();
      expectOk(
        await call(harness.app, "PUT", `/api/people/${person!.id}/role`, { role }),
        `set ${name} role=${role}`,
      );
    }

    // ── ACTIVATE — this captures the baseline (CAPACITY_BAR_RULES §1) ────────
    expectOk(await activateSprint(harness.app, sprintId), "activate");

    const snapshot = async (label: string): Promise<Snapshot> => {
      const capRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
      expectOk(capRes, `${label}: GET capacity`);
      const closRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/closure-stats`);
      expectOk(closRes, `${label}: GET closure-stats`);
      return {
        label,
        capacity: CapacityResponse.parse(capRes.json),
        closure: ClosureStatsResponse.parse(closRes.json),
      };
    };

    const A = await snapshot("A (post-activation)");

    // ── Days 1..3: work is logged, #86003 is handed off (day 2), #86012 is
    //    re-estimated (day 3). Sync + update each day so the cache AND the
    //    changelog (which is what developerSegments reads) both catch up.
    const totalDays = loaded.total_days;
    expect(totalDays, "the fixture's timeline reaches day 3").toBe(3);
    for (let n = 1; n <= totalDays; n += 1) {
      const adv = await admin.advanceDay();
      expect(adv.day, "advance-day is sequential").toBe(n);
      clock.now = new Date(`${adv.date}T12:00:00.000Z`);
      expectOk(
        await call(harness.app, "POST", "/api/sync", { project_op_id: S21_PROJECT_ID }),
        `sync day ${n}`,
      );
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {
          triggered_by: "manual",
        }),
        `sprint update day ${n}`,
      );
    }

    const B = await snapshot("B (after the dev->dev handoff)");

    // ── Mid-sprint ADDITIONS (origin = added_mid_sprint) ─────────────────────
    for (const wp of [S21_WP.addedAndWorked, S21_WP.addedHeldUnworked, S21_WP.acquiredThenReestimated]) {
      expectOk(
        await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp }),
        `add mid-sprint item #${wp}`,
      );
    }
    // One more update so the newly-added tickets' own time entries reach the
    // changelog — without it #86006/#86012 would read `idle`, not `acquired`.
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, { triggered_by: "manual" }),
      "sprint update after mid-sprint adds",
    );

    const C = await snapshot("C (after the mid-sprint additions)");

    // ── Mid-sprint REMOVAL of #86004 from Stastna's scope ────────────────────
    expectOk(
      await call(harness.app, "DELETE", `/api/sprints/${sprintId}/items/${S21_WP.scopeRemoved}`),
      `remove #${S21_WP.scopeRemoved} from scope`,
    );

    const D = await snapshot("D (final — after the scope removal)");

    // ── The two remaining §6.5 surfaces: sprint detail/report, and the PDF ───
    const repRes = await call(harness.app, "GET", `/api/reports/${sprintId}`);
    expectOk(repRes, "GET /reports/:id (sprint detail)");
    const report = ReportDetailResponse.parse(repRes.json);
    // `generateReportPdf` = buildReportDetail → renderReportHtml → renderer, so
    // rendering the HTML from the SAME detail payload is the PDF's own content,
    // minus a chromium dependency this suite has no reason to take on.
    const pdfHtml = renderReportHtml(report);

    const baselineRows = await harness.repos.ticketBaselines.listBySprint(sprintId);
    const baselineOriginalAssignee =
      baselineRows.find((b) => b.wp_op_id === S21_WP.handedOff)?.original_assignee_op_id ?? null;

    ctx = { mock, admin, harness, sprintId, A, B, C, D, report, pdfHtml, baselineOriginalAssignee };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.harness.close();
    await ctx.mock.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D2 — the measurement itself.
  // ───────────────────────────────────────────────────────────────────────────
  describe("D2 — the measured reproduction (contracts §2)", () => {
    it("every developer's Planned is Σ effectiveEstimate of the tickets currently in the sprint and currently theirs — 22 / 41 / 0 / 15", () => {
      const got = closurePlanned(ctx.D);
      for (const [name, expected] of Object.entries(PLANNED_FINAL)) {
        expect(
          got[name],
          `${name}: Planned must be CURRENT SCOPE (${expected} h) — see this file's derivation table`,
        ).toBeCloseTo(expected, 3);
      }
    });

    it("Baseline is retained separately and is a DIFFERENT number from Planned (31 / 10 / 20 / 15 against 22 / 41 / 0 / 15)", () => {
      // contracts §3: Baseline got its own label. Increment 38: it is what each
      // developer was signed up for at Activate (CAPACITY_BAR_RULES §5).
      for (const [name, expected] of Object.entries(BASELINE_FINAL)) {
        expect(dev(ctx.D, name).baseline_hours, `${name}: Baseline = signed up for at Activate`).toBeCloseTo(
          expected,
          3,
        );
      }
      expect(dev(ctx.D, STASTNA).baseline_hours).not.toBeCloseTo(
        dev(ctx.D, STASTNA).planned_hours,
        3,
      );
      expect(dev(ctx.D, REZAC).baseline_hours).not.toBeCloseTo(dev(ctx.D, REZAC).planned_hours, 3);
    });

    it("±Change keeps its Increment-17 semantics untouched: only `acquired` (+) and `removed` (−) move it, never a handoff at the sender", () => {
      // contracts §2a: `counts_to_change` / `change_delta_hours` are NOT touched
      // by this increment. Increment 38: a baseline ticket removed from the
      // sprint subtracts at its activation holder (Stastna −5).
      for (const [name, expected] of Object.entries(CHANGE_FINAL)) {
        expect(dev(ctx.D, name).scope_change_hours, `${name}: ±Change`).toBeCloseTo(expected, 3);
      }
    });

    it("the aggregate is 78 h Planned against 76 h Baseline — the gap that makes invariant 7 testable", () => {
      expect(ctx.D.closure.total_planned_hours, "Σ per-developer Planned").toBeCloseTo(
        TOTAL_PLANNED_FINAL,
        3,
      );
      expect(ctx.D.closure.total_baseline_hours, "Σ per-developer Baseline").toBeCloseTo(
        TOTAL_BASELINE_FINAL,
        3,
      );
      // If a surface ever regressed to "Planned = Σ baseline", the two would
      // collapse onto each other and this is the assertion that catches it.
      expect(
        ctx.D.closure.total_planned_hours,
        "Planned must NOT equal the baseline sum",
      ).not.toBeCloseTo(TOTAL_BASELINE_FINAL, 3);
    });

    it("the segment KINDS are exactly the reproduced shape — baseline_worked / acquired / idle, colours unchanged (contracts §2a)", () => {
      expect(seg(ctx.D, STASTNA, S21_WP.retainedWorked)?.kind).toBe("baseline_worked");
      expect(seg(ctx.D, STASTNA, S21_WP.retainedUnworked)?.kind).toBe("baseline_worked");
      expect(seg(ctx.D, STASTNA, S21_WP.addedHeldUnworked)?.kind).toBe("idle");
      expect(seg(ctx.D, REZAC, S21_WP.rezacBaseline)?.kind).toBe("baseline_worked");
      // #86003 (the handed-off ticket) — see the "FIXED in Increment 38" block.
      expect(seg(ctx.D, REZAC, S21_WP.addedAndWorked)?.kind).toBe("acquired");
      expect(seg(ctx.D, REZAC, S21_WP.acquiredThenReestimated)?.kind).toBe("acquired");
      expect(seg(ctx.D, DOLINSKY, S21_WP.dcChild)?.kind).toBe("baseline_worked");
      // The removed ticket is out of scope, so it is no longer any developer's
      // segment at all.
      expect(seg(ctx.D, STASTNA, S21_WP.scopeRemoved)).toBeUndefined();
    });

    it("contracts §2a's contribution table holds per segment: baseline_worked + acquired + idle count to Planned; handoff does not", () => {
      // ⚠️ The kind-based SUM below reproduces `planned_hours` for THIS fixture's
      // shapes, and that is all it is asserted to do. It is NOT a general law:
      // the canonical Planned is decided by "who holds the ticket now", while a
      // segment's KIND is decided by "who held it at the anchor and did they
      // log". They part company in at least two shapes this fixture deliberately
      // does not contain, both measured on s10 in
      // `tests/e2e/specs/tj-capacity-numbers-consistency.spec.ts`:
      //   • a baseline ticket handed to a NON-developer keeps a green
      //     `baseline_worked` segment (counts_to_planned true) while leaving the
      //     developer's canonical Planned entirely;
      //   • a baseline ticket abandoned to UNASSIGNED gets a `removed` segment
      //     (counts_to_planned false) yet stays in Planned via the frozen
      //     baseline-holder fallback.
      // Contracts §2 is explicit that the canonical value wins for anything
      // displayed as "Planned"; §2b(iii) already records the multi-hop case of
      // the same root cause. See the D5 block for both measurements.
      const COUNTS = { baseline_worked: true, acquired: true, idle: true } as Record<string, boolean>;
      for (const name of [STASTNA, REZAC, DOLINSKY]) {
        const d = dev(ctx.D, name);
        for (const s of d.segments) {
          expect(s.counts_to_planned, `${name} #${s.wp_op_id} (${s.kind}): counts_to_planned`).toBe(
            COUNTS[s.kind] ?? false,
          );
        }
        // …and the developer's Planned is exactly the sum over those kinds.
        const fromKinds = d.segments
          .filter((s) => COUNTS[s.kind] === true)
          .reduce((sum, s) => sum + (s.estimate_hours ?? 0), 0);
        expect(
          d.planned_hours,
          `${name}: Planned == Σ estimate over {baseline_worked, acquired, idle}`,
        ).toBeCloseTo(fromKinds, 3);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D3 / §6.7 — Planned is CURRENT SCOPE: every movement lands immediately.
  // ───────────────────────────────────────────────────────────────────────────
  describe("CAPACITY_BAR_RULES §6 invariant 7 — Planned = current scope", () => {
    it("post-activation Planned is the whole baseline per holder: Stastna 31, Rezac 10, Dolinsky 15", () => {
      const got = closurePlanned(ctx.A);
      for (const [name, expected] of Object.entries(PLANNED_A)) {
        expect(got[name], `A: ${name}`).toBeCloseTo(expected, 3);
      }
    });

    it("a HANDOFF moves Planned immediately: #86003's 8 h leave Stastna (31→23) and arrive at Rezac (10→18), total unchanged", () => {
      // The discriminator. Under the pre-Increment-30 rule the receiver's
      // `acquired` segment contributed 0, so Rezac would still read 10 and the
      // sprint would appear to have LOST 8 h of scope to nobody.
      const got = closurePlanned(ctx.B);
      for (const [name, expected] of Object.entries(PLANNED_B)) {
        expect(got[name], `B: ${name} after the handoff`).toBeCloseTo(expected, 3);
      }
      expect(
        ctx.B.closure.total_planned_hours,
        "a handoff redistributes scope; it does not destroy it",
      ).toBeCloseTo(ctx.A.closure.total_planned_hours, 3);
      // Increment 38: the sender's Baseline does NOT move with a handoff.
      expect(dev(ctx.B, STASTNA).baseline_hours).toBeCloseTo(dev(ctx.A, STASTNA).baseline_hours, 3);
    });

    it("an ADDITION moves Planned immediately: Stastna 23→27 (idle +4), Rezac 18→41 (acquired +9 +14)", () => {
      const got = closurePlanned(ctx.C);
      for (const [name, expected] of Object.entries(PLANNED_C)) {
        expect(got[name], `C: ${name} after the mid-sprint adds`).toBeCloseTo(expected, 3);
      }
      // Specifically: an added-but-NEVER-WORKED ticket still enters Planned. It
      // is `idle` (orange-hatched, ±Change 0) yet it IS current scope — this is
      // the row contracts §2a marks NEW.
      expect(dev(ctx.C, STASTNA).scope_change_hours, "…while ±Change ignores it").toBeCloseTo(0, 3);
    });

    it("a REMOVAL moves Planned immediately: Stastna 27→22 when #86004's 5 h leave scope", () => {
      expect(closurePlanned(ctx.C)[STASTNA]).toBeCloseTo(PLANNED_C[STASTNA]!, 3);
      expect(closurePlanned(ctx.D)[STASTNA], "D: after removing #86004").toBeCloseTo(
        PLANNED_C[STASTNA]! - E[S21_WP.scopeRemoved]!,
        3,
      );
      // Nobody else moves.
      for (const name of [REZAC, DOLINSKY, PRAZAK]) {
        expect(closurePlanned(ctx.D)[name], `${name} is unaffected by Stastna's removal`).toBeCloseTo(
          closurePlanned(ctx.C)[name]!,
          3,
        );
      }
    });

    it("NO surface reports the baseline sum under the name 'Planned' — Capacity, Closure, sprint detail and the PDF all read 78, never 71", () => {
      const surfaces: Array<[string, number]> = [
        ["capacity.scope_planned_hours (Capacity panel header)", ctx.D.capacity.scope_planned_hours],
        ["capacity.total_planned_hours (developer workload total)", ctx.D.capacity.total_planned_hours],
        ["closure.total_planned_hours", ctx.D.closure.total_planned_hours],
        ["report detail stats.total_planned_hours", ctx.report.stats.total_planned_hours],
      ];
      for (const [what, value] of surfaces) {
        expect(value, `${what} must be current scope (78), not the baseline sum (76)`).toBeCloseTo(
          TOTAL_PLANNED_FINAL,
          3,
        );
      }
      // The PDF prints its KPIs as "<n> h" followed by the label.
      expect(ctx.pdfHtml, "PDF 'Planned' KPI").toContain(
        `<div class="v">${TOTAL_PLANNED_FINAL} h</div><div class="l">Planned</div>`,
      );
      expect(ctx.pdfHtml, "PDF 'Baseline' KPI is the separately-labelled figure").toContain(
        `<div class="v">${TOTAL_BASELINE_FINAL} h</div><div class="l">Baseline</div>`,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D3 / §6.8 — the header is reproducible from the rows displayed beneath it.
  // ───────────────────────────────────────────────────────────────────────────
  describe("CAPACITY_BAR_RULES §6 invariant 8 — the header equals the sum of its own visible rows", () => {
    it("the Capacity header is Σ of the DEVELOPER lines rendered under it — a user can add up what they see", () => {
      // contracts §0c: the measured defect was a developer-filtered header sat
      // above rows that included non-developers. The header is developers-only
      // (§0), so it must reconcile against the developer rows specifically.
      const devLines = ctx.D.capacity.lines.filter((l) => l.is_developer);
      const sum = devLines.reduce((s, l) => s + l.planned_hours, 0);
      expect(
        ctx.D.capacity.scope_planned_hours,
        `header ${ctx.D.capacity.scope_planned_hours} must equal Σ visible developer rows ${sum} ` +
          `(${devLines.map((l) => `${l.name}=${l.planned_hours}`).join(", ")})`,
      ).toBeCloseTo(sum, 3);
      expect(sum, "…and that sum is the hand-computed 78").toBeCloseTo(TOTAL_PLANNED_FINAL, 3);
    });

    it("the Closure header is Σ per_developer[].planned_hours, and Baseline's header likewise", () => {
      const p = ctx.D.closure.per_developer.reduce((s, d) => s + d.planned_hours, 0);
      const b = ctx.D.closure.per_developer.reduce((s, d) => s + d.baseline_hours, 0);
      expect(ctx.D.closure.total_planned_hours).toBeCloseTo(p, 3);
      expect(ctx.D.closure.total_baseline_hours).toBeCloseTo(b, 3);
    });

    it("the PDF's per-developer Planned column sums to the PDF's own Planned KPI", () => {
      const rows = ctx.report.stats.per_developer;
      expect(rows.length, "the PDF renders a row per developer").toBeGreaterThan(0);
      const sum = rows.reduce((s, r) => s + r.planned_hours, 0);
      expect(ctx.report.stats.total_planned_hours).toBeCloseTo(sum, 3);
      for (const r of rows) {
        expect(ctx.pdfHtml, `PDF row for ${r.name}`).toContain(`<td>${r.name}</td>`);
      }
    });

    it("the TESTER is visible as a grey line but is never plannable capacity — she is in no header", () => {
      const line = ctx.D.capacity.lines.find((l) => l.name === HAJKOVA);
      expect(line, "the tester still APPEARS on the Capacity panel").toBeTruthy();
      expect(line!.is_developer, "…as a non-developer (solid grey, §0/§2)").toBe(false);
      expect(line!.role).toBe("tester");
      expect(line!.planned_hours, "…carrying her real committed hours").toBeCloseTo(
        E[S21_WP.testerHeld]!,
        3,
      );
      // But excluded from every aggregate, and from the developer breakdown.
      expect(
        ctx.D.closure.per_developer.map((d) => d.name),
        "a non-developer never gets a developer row",
      ).not.toContain(HAJKOVA);
      expect(
        ctx.D.capacity.scope_planned_hours,
        "her 7 h are in no header",
      ).toBeCloseTo(TOTAL_PLANNED_FINAL, 3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D3 / §6.9 — Planned and ±Change are never added together.
  // ───────────────────────────────────────────────────────────────────────────
  describe("CAPACITY_BAR_RULES §6 invariant 9 — Planned + ±Change is a double count", () => {
    it("Baseline + ±Change is the composition that balances for a developer whose every ticket is baseline-or-acquired (Rezac: 10 + 31 = 41 = Planned)", () => {
      const r = dev(ctx.D, REZAC);
      expect(r.baseline_hours + r.scope_change_hours, "Baseline + ±Change == Planned").toBeCloseTo(
        r.planned_hours,
        3,
      );
      // Whereas the forbidden composition inflates by the full ±Change.
      expect(r.planned_hours + r.scope_change_hours).toBeCloseTo(
        r.planned_hours + CHANGE_FINAL[REZAC]!,
        3,
      );
      expect(
        r.planned_hours + r.scope_change_hours,
        "Planned + ±Change double-counts the acquired work — it is not anyone's scope",
      ).not.toBeCloseTo(r.planned_hours, 3);
    });

    it("MEASURED asymmetry: an `idle` ticket enters Planned but neither Baseline nor ±Change, and a handoff stays in the sender's Baseline — so Baseline + ±Change misses Stastna's Planned by exactly #86003's 8 h − #86007's 4 h", () => {
      // Recorded, not "fixed": contracts §2a puts `idle` in Planned and
      // deliberately leaves ±Change alone. So `Baseline + ±Change` balances a
      // flow story, while `Planned` is the stock — the two only coincide when a
      // developer holds no idle work. Anything displaying Planned must use the
      // canonical value, never a reconstruction from Baseline and ±Change.
      const s = dev(ctx.D, STASTNA);
      expect(s.baseline_hours + s.scope_change_hours).toBeCloseTo(
        s.planned_hours - E[S21_WP.addedHeldUnworked]! + E[S21_WP.handedOff]!,
        3,
      );
      const idle = seg(ctx.D, STASTNA, S21_WP.addedHeldUnworked)!;
      expect(idle.kind).toBe("idle");
      expect(idle.counts_to_planned, "idle IS current scope").toBe(true);
      expect(idle.counts_to_change, "…but ±Change ignores it (Increment 17, untouched)").toBe(false);
    });

    it("the aggregate obeys it too: total_baseline + Σ±Change ≠ total_planned + Σ±Change, and only the former is ever a meaningful figure", () => {
      const change = ctx.D.closure.per_developer.reduce((s, d) => s + d.scope_change_hours, 0);
      expect(change, "Σ ±Change = Rezac's +31 and Stastna's −5 (removed from the sprint)").toBeCloseTo(
        TOTAL_CHANGE_FINAL,
        3,
      );
      expect(
        ctx.D.closure.total_planned_hours + change,
        `Planned + ±Change (${TOTAL_PLANNED_FINAL + TOTAL_CHANGE_FINAL} h) corresponds to no scope that exists`,
      ).toBeCloseTo(TOTAL_PLANNED_FINAL + TOTAL_CHANGE_FINAL, 3);
      expect(ctx.D.closure.total_baseline_hours + change).toBeCloseTo(
        TOTAL_BASELINE_FINAL + TOTAL_CHANGE_FINAL,
        3,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D3 / §6.5 — one computation, four surfaces.
  // ───────────────────────────────────────────────────────────────────────────
  describe("CAPACITY_BAR_RULES §6 invariant 5 — Capacity == Closure == sprint detail == PDF", () => {
    it("the three headline numbers agree across all four surfaces", () => {
      const c = ctx.D.closure;
      expect(ctx.D.capacity.scope_planned_hours, "Capacity vs Closure: Planned").toBeCloseTo(
        c.total_planned_hours,
        3,
      );
      expect(ctx.D.capacity.scope_delivered_hours, "Capacity vs Closure: Delivered").toBeCloseTo(
        c.total_delivered_hours,
        3,
      );
      expect(ctx.report.stats.total_planned_hours, "sprint detail vs Closure: Planned").toBeCloseTo(
        c.total_planned_hours,
        3,
      );
      expect(ctx.report.stats.total_baseline_hours, "sprint detail vs Closure: Baseline").toBeCloseTo(
        c.total_baseline_hours,
        3,
      );
      expect(ctx.report.stats.total_delivered_hours, "sprint detail vs Closure: Delivered").toBeCloseTo(
        c.total_delivered_hours,
        3,
      );
      // The PDF renders from that same detail payload (see beforeAll).
      expect(ctx.pdfHtml).toContain(
        `<div class="v">${TOTAL_PLANNED_FINAL} h</div><div class="l">Planned</div>`,
      );
    });

    it("the per-developer TABLE is identical between the Capacity lines and the Closure breakdown — name for name, hour for hour", () => {
      // Not "both non-zero": every developer row must carry the same number on
      // both surfaces, which is what §6.5 has always demanded and what two
      // separate computations could never guarantee.
      const lines = linePlanned(ctx.D);
      for (const d of ctx.D.closure.per_developer) {
        expect(
          lines,
          `every developer in the Closure breakdown has a Capacity line (${d.name})`,
        ).toHaveProperty(d.name);
        expect(lines[d.name], `${d.name}: Capacity line vs Closure breakdown`).toBeCloseTo(
          d.planned_hours,
          3,
        );
      }
      // …and no developer line exists that the Closure breakdown omits.
      const closureNames = new Set(ctx.D.closure.per_developer.map((d) => d.name));
      for (const l of ctx.D.capacity.lines.filter((x) => x.is_developer)) {
        expect(closureNames.has(l.name), `Capacity developer line "${l.name}" is in Closure too`).toBe(
          true,
        );
      }
    });

    it("Planned is non-trivially non-zero on every surface, so the parity above cannot be a 0 === 0 pass", () => {
      expect(ctx.D.capacity.scope_planned_hours).toBeGreaterThan(0);
      expect(ctx.D.closure.total_planned_hours).toBeGreaterThan(0);
      expect(ctx.report.stats.total_planned_hours).toBeGreaterThan(0);
      expect(ctx.D.closure.per_developer.filter((d) => d.planned_hours > 0).length).toBeGreaterThan(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D4 — regression surface. Assert, don't rebuild.
  // ───────────────────────────────────────────────────────────────────────────
  describe("D4 — regressions this increment must not reopen", () => {
    it("§5a: the suppressed PARENT's holder keeps a capacity line at 0 h with has_sprint_work — Prazak never vanishes", () => {
      // The Increment-26 defect fixed in Increment 28. #86010 (20 h) is the
      // parent of #86011, both in the sprint, so its hours are suppressed —
      // and Prazak holds nothing else.
      const line = ctx.D.capacity.lines.find((l) => l.name === PRAZAK);
      expect(line, "Prazak must still have a Capacity line").toBeTruthy();
      expect(line!.planned_hours, "…contributing exactly 0 h (his only ticket is suppressed)").toBe(0);
      expect(line!.has_sprint_work, "…and not removable — it is re-derived from the items").toBe(true);
      expect(line!.is_developer).toBe(true);
    });

    it("§5a + §6.5: the suppression is applied on the CLOSURE surface identically — Prazak is present at 0 h there too", () => {
      // Split from the test above on purpose: if the leaf guard lives on only
      // one of the two surfaces, this is the assertion that names which.
      const names = ctx.D.closure.per_developer.map((d) => d.name);
      expect(names, "Prazak appears in the developer breakdown").toContain(PRAZAK);
      expect(dev(ctx.D, PRAZAK).planned_hours, "suppressed parent contributes 0 to Planned").toBeCloseTo(
        0,
        3,
      );
      expect(
        ctx.D.closure.total_planned_hours,
        "…so the 20 h never enter the aggregate either",
      ).toBeCloseTo(TOTAL_PLANNED_FINAL, 3);
      // contracts §2b(ii): B5 is NOT regressed by closure adopting the leaf
      // filter — the suppression applies to the PLANNED SUM, while the row and
      // its `baseline_hours` (and therefore its green segment) survive intact.
      expect(
        dev(ctx.D, PRAZAK).baseline_hours,
        "…while Baseline keeps the parent's full 20 h (§2b(ii): Planned-sum rule, not a segment rule)",
      ).toBeCloseTo(E[S21_WP.dcParent]!, 3);
      expect(seg(ctx.D, PRAZAK, S21_WP.dcParent)?.kind, "the parent's green segment still exists").toBe(
        "baseline_worked",
      );
    });

    it("invariant 1 unchanged: a retained baseline ticket with ZERO logged time is still green `baseline_worked`, never hatched", () => {
      const s = seg(ctx.D, STASTNA, S21_WP.retainedUnworked)!;
      expect(s.logged_hours, "#86002 was never logged on").toBe(0);
      expect(s.kind, "…and is green anyway (Increment 26 abolished baseline_idle)").toBe(
        "baseline_worked",
      );
      for (const forbidden of ["idle", "handoff", "removed", "churned", "baseline_idle"]) {
        expect(s.kind).not.toBe(forbidden);
      }
    });

    it("invariant 3 unchanged: only post-activation tickets use the change kinds", () => {
      for (const wp of [S21_WP.retainedWorked, S21_WP.retainedUnworked]) {
        const s = seg(ctx.D, STASTNA, wp)!;
        expect(s.in_baseline, `#${wp} was in the baseline`).toBe(true);
        expect(s.kind).toBe("baseline_worked");
      }
      for (const wp of [S21_WP.addedAndWorked, S21_WP.acquiredThenReestimated]) {
        const s = seg(ctx.D, REZAC, wp)!;
        expect(s.in_baseline, `#${wp} was added after activation`).toBe(false);
        expect(s.kind).toBe("acquired");
      }
    });

    it("invariant 4 unchanged: `handoff` keeps its own kind (blue-hatched) and is NOT the non-developer grey — proven on the pure engine, since the app cannot currently produce one on a live sprint", () => {
      // Two separate claims live in invariant 4 and both are checked:
      //  (1) a handoff is its OWN kind — exercised straight against the engine
      //      here (the real app's live-sprint handoff is covered by the
      //      Increment 38 block below); `capacity-bar-rules-invariants.test.ts`
      //      §6 #6 keeps the same engine-level coverage.
      const ANCHOR = "2026-08-03T00:00:00Z";
      const sender = { op: 911, name: "Handoff Sender" };
      const receiver = { op: 912, name: "Handoff Receiver" };
      const k = (p: { op: number; name: string }) => personKey(null, p.op, p.name);
      const out = developerSegments({
        baseline_anchor: ANCHOR,
        sprint_status: "active",
        tickets: [
          {
            wp_op_id: 86098,
            subject: "Engine-level handoff",
            estimate_hours: 8,
            in_baseline_scope: true,
            done_bucket: "not_done",
            assignee_intervals: [
              {
                wp_op_id: 86098,
                holder_op_user_id: sender.op,
                holder_name: sender.name,
                holder_role: null,
                from: ANCHOR,
                to: "2026-08-05T09:00:00Z",
              },
              {
                wp_op_id: 86098,
                holder_op_user_id: receiver.op,
                holder_name: receiver.name,
                holder_role: null,
                from: "2026-08-05T09:00:00Z",
                to: null,
              },
            ],
            status_transitions: [],
            logged_by_developer: { [k(receiver)]: 3 },
          },
        ],
        role_by_person: {
          [k(sender)]: "developer" as PersonRole,
          [k(receiver)]: "developer" as PersonRole,
        },
        person_meta: {
          [k(sender)]: { name: sender.name, op_user_id: sender.op, member_id: null },
          [k(receiver)]: { name: receiver.name, op_user_id: receiver.op, member_id: null },
        },
      });
      const h = out.find((d) => d.name === sender.name)!.segments[0]!;
      expect(h.kind, "the sender's segment is `handoff`, never repainted to a role-grey").toBe(
        "handoff",
      );
      expect(h.counts_to_planned, "…and it left the sender's current scope").toBe(false);
      expect(h.counts_to_change, "…without being subtracted from ±Change (SPEC_17 §7 #1)").toBe(false);
      expect(out.find((d) => d.name === receiver.name)!.planned_hours, "…arriving whole at the receiver").toBe(8);

      //  (2) the non-developer grey is a different thing entirely — it produces
      //      no developer segment at all. Checked on the real app.
      expect(ctx.D.closure.per_developer.some((d) => d.name === HAJKOVA)).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FIXED in Increment 38 — formerly "🔴 FINDING (pre-existing)".
  // ───────────────────────────────────────────────────────────────────────────
  describe("FIXED in Increment 38 — on a LIVE sprint a dev→dev handoff stays with the ACTIVATION holder", () => {
    /**
     * Until Increment 38 #86003 (Stastna at activation, Rezac from day 2) showed
     * up as REZAC's green `baseline_worked` and Stastna had no segment at all:
     * `closureStats.ts` resolved the baseline holder from the snapshot's id
     * paired with the CURRENT assignee's name, and identity is the name. The
     * holder now comes from the activation snapshot alone (`ticket_baseline`'s
     * id + the name in its frozen OP payload).
     */
    it("the sender carries a blue-hatched `handoff`, the receiver a red `acquired`", () => {
      expect(seg(ctx.D, STASTNA, S21_WP.handedOff)?.kind).toBe("handoff");
      expect(seg(ctx.D, STASTNA, S21_WP.handedOff)?.in_baseline).toBe(true);
      expect(seg(ctx.D, REZAC, S21_WP.handedOff)?.kind).toBe("acquired");
      expect(seg(ctx.D, REZAC, S21_WP.handedOff)?.in_baseline).toBe(false);
    });

    it("segments agree with the stored ticket_baseline: it says Stastna, so does the attribution", () => {
      expect(ctx.baselineOriginalAssignee, "frozen baseline holder of #86003").toBe(
        S21_USERS.stastna.id,
      );
    });

    it("Baseline stays with the sender, ±Change credits the receiver, Planned unaffected", () => {
      expect(dev(ctx.D, STASTNA).baseline_hours).toBeCloseTo(BASELINE_FINAL[STASTNA]!, 3);
      expect(dev(ctx.D, REZAC).baseline_hours).toBeCloseTo(E[S21_WP.rezacBaseline]!, 3);
      expect(dev(ctx.D, REZAC).scope_change_hours).toBeCloseTo(CHANGE_FINAL[REZAC]!, 3);
      expect(dev(ctx.D, REZAC).planned_hours).toBeCloseTo(PLANNED_FINAL[REZAC]!, 3);
      expect(ctx.D.closure.total_planned_hours).toBeCloseTo(TOTAL_PLANNED_FINAL, 3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // D5 — the measured residual (contracts §2a).
  // ───────────────────────────────────────────────────────────────────────────
  describe("D5 — the contracts §2a residual, MEASURED (acquired estimate-at-acquisition vs live)", () => {
    it("through the real app the residual is ZERO — and the reason is that `estimate_at_acquisition` is never populated", () => {
      // #86012 was acquired by Rezac at 6 h and re-estimated to 14 h on day 3.
      // The canonical Planned uses the LIVE effectiveEstimate (14). The segment's
      // own `estimate_hours` is documented as the estimate AT ACQUISITION — but
      // `closureStats.ts` deliberately never fills `estimate_at_acquisition`
      // (its own comment: "left as the documented fallback rather than
      // half-implemented"), so `estimateAtAcquisition()` returns the live value
      // and the two coincide. The residual is therefore latent, not active.
      const s = seg(ctx.D, REZAC, S21_WP.acquiredThenReestimated)!;
      expect(s.estimate_hours, "the acquired segment carries the LIVE 14 h").toBeCloseTo(
        S21_REESTIMATED_HOURS,
        3,
      );
      const sumPlannedDelta = dev(ctx.D, REZAC).segments.reduce(
        (sum, x) => sum + x.planned_delta_hours,
        0,
      );
      const residual = dev(ctx.D, REZAC).planned_hours - sumPlannedDelta;
      expect(
        residual,
        `MEASURED residual for Rezac = canonical Planned (${dev(ctx.D, REZAC).planned_hours}) − ` +
          `Σ planned_delta_hours (${sumPlannedDelta})`,
      ).toBeCloseTo(0, 3);
    });

    it("the estimate change DID reach Planned — 14 h, not the 6 h at acquisition (Increment 28's one-estimate-of-record, still holding)", () => {
      expect(
        dev(ctx.D, REZAC).planned_hours,
        "Rezac's Planned uses the re-estimated 14 h",
      ).toBeCloseTo(PLANNED_FINAL[REZAC]!, 3);
      const perTicket = ctx.D.closure.per_ticket.find(
        (t) => t.wp_op_id === S21_WP.acquiredThenReestimated,
      );
      expect(perTicket?.estimate_hours, "…and so does the per-ticket estimate of record").toBeCloseTo(
        S21_REESTIMATED_HOURS,
        3,
      );
    });

    it("the residual is REAL the moment `estimate_at_acquisition` IS supplied — measured at 8 h on the pure engine", () => {
      // Same ticket, same numbers, driven straight into `developerSegments` with
      // the acquisition-instant estimate populated (which is what the field is
      // FOR). This quantifies exactly what would break if a future increment
      // implemented the reconstruction without also re-deriving Planned from the
      // canonical current-scope rule: the bar's Σ planned_delta_hours would read
      // 6 h while the canonical Planned reads 14 h — an 8 h residual.
      const ANCHOR = "2026-08-03T00:00:00Z";
      const ACQUIRED_AT = "2026-08-05T09:00:00Z";
      const devA = { op: S21_USERS.rezac.id, name: REZAC };
      const key = personKey(null, devA.op, devA.name);
      const interval: AssigneeInterval = {
        wp_op_id: S21_WP.acquiredThenReestimated,
        holder_op_user_id: devA.op,
        holder_name: devA.name,
        holder_role: null,
        from: ACQUIRED_AT,
        to: null,
      };
      const ticket: DeveloperSegmentsTicketInput = {
        wp_op_id: S21_WP.acquiredThenReestimated,
        subject: "Re-key the archived terminal certificate store",
        estimate_hours: S21_REESTIMATED_HOURS, // the LIVE estimate of record
        in_baseline_scope: false, // added after activation
        done_bucket: "not_done",
        assignee_intervals: [interval],
        status_transitions: [],
        logged_by_developer: { [key]: 2 },
        estimate_at_acquisition: { [ACQUIRED_AT]: E[S21_WP.acquiredThenReestimated]! }, // 6 h
      };
      const out = developerSegments({
        baseline_anchor: ANCHOR,
        sprint_status: "active",
        tickets: [ticket],
        role_by_person: { [key]: "developer" as PersonRole },
        person_meta: { [key]: { name: devA.name, op_user_id: devA.op, member_id: null } },
      });
      const s = out[0]!.segments[0]!;
      expect(s.kind).toBe("acquired");
      expect(s.estimate_hours, "the segment falls back to the ACQUISITION estimate").toBeCloseTo(
        E[S21_WP.acquiredThenReestimated]!,
        3,
      );
      const residual = S21_REESTIMATED_HOURS - s.planned_delta_hours;
      expect(
        residual,
        "MEASURED latent residual: canonical Planned 14 h − Σ planned_delta_hours 6 h",
      ).toBeCloseTo(8, 3);
      // Recorded as a Phase-2 finding, NOT coerced: contracts §2a is explicit
      // that the canonical value wins for anything displayed as "Planned".
    });

    it("RESIDUAL 2 (contracts §2b(iii)) — a MULTI-HOP handoff A→B→C annotates one 12 h ticket TWICE in Σ planned_delta_hours, while canonical Planned gives A 0 / B 0 / C 12", () => {
      // The structurally stronger residual, and the reason §2 makes the
      // canonical computation authoritative while the segment field stays
      // purely presentational: `acquired` is per-DEVELOPER-who-ever-held-and-
      // logged, so a ticket that passes through two hands produces two
      // `acquired` segments of the SAME 12 h. No sum over segments can ever
      // recover "current scope" from that; only "currently assigned to" can.
      const ANCHOR = "2026-08-03T00:00:00Z";
      const WP = 86099; // engine-only id; never seeded, never synced
      const EST = 12;
      const A = { op: 901, name: "Multi Hop A" };
      const B = { op: 902, name: "Multi Hop B" };
      const C = { op: 903, name: "Multi Hop C" };
      const k = (p: { op: number; name: string }) => personKey(null, p.op, p.name);
      const hop = (p: { op: number; name: string }, from: string, to: string | null): AssigneeInterval => ({
        wp_op_id: WP,
        holder_op_user_id: p.op,
        holder_name: p.name,
        holder_role: null,
        from,
        to,
      });
      const out = developerSegments({
        baseline_anchor: ANCHOR,
        sprint_status: "active",
        tickets: [
          {
            wp_op_id: WP,
            subject: "Multi-hop handoff",
            estimate_hours: EST,
            in_baseline_scope: true, // A's baseline at the anchor
            done_bucket: "not_done",
            assignee_intervals: [
              hop(A, ANCHOR, "2026-08-04T09:00:00Z"),
              hop(B, "2026-08-04T09:00:00Z", "2026-08-05T09:00:00Z"),
              hop(C, "2026-08-05T09:00:00Z", null),
            ],
            status_transitions: [],
            // B and C both worked it; A did not — so B and C are each `acquired`.
            logged_by_developer: { [k(B)]: 3, [k(C)]: 4 },
          },
        ],
        role_by_person: {
          [k(A)]: "developer" as PersonRole,
          [k(B)]: "developer" as PersonRole,
          [k(C)]: "developer" as PersonRole,
        },
        person_meta: {
          [k(A)]: { name: A.name, op_user_id: A.op, member_id: null },
          [k(B)]: { name: B.name, op_user_id: B.op, member_id: null },
          [k(C)]: { name: C.name, op_user_id: C.op, member_id: null },
        },
      });
      const byName = new Map(out.map((d) => [d.name, d]));
      expect(byName.get(A.name)!.segments[0]!.kind, "A handed it on → handoff").toBe("handoff");
      expect(byName.get(B.name)!.segments[0]!.kind, "B held it and logged → acquired").toBe("acquired");
      expect(byName.get(C.name)!.segments[0]!.kind, "C holds it and logged → acquired").toBe("acquired");

      // THE MEASUREMENT: Σ planned_delta_hours over all three developers.
      const sumDelta = out.reduce(
        (s, d) => s + d.segments.reduce((t, x) => t + x.planned_delta_hours, 0),
        0,
      );
      // ⚠️ UPDATED by contracts §2c: this used to measure `EST * 2`. Since
      // `counts_to_planned` is derived from the CURRENT HOLDER instead of the
      // segment kind, only C — who actually holds the ticket — annotates it.
      // B's segment keeps its `acquired` kind and its bar length; only the
      // Planned annotation drops to 0. This is the double count dissolving.
      expect(
        sumDelta,
        `MEASURED: Σ planned_delta_hours = ${sumDelta} h for ONE ${EST} h ticket — only the ` +
          `CURRENT holder (C) annotates it; A handed it on and B passed it along`,
      ).toBeCloseTo(EST, 3);

      // …whereas "currently in scope AND currently assigned to" gives the only
      // answer that can be true: C alone holds it.
      expect(byName.get(A.name)!.planned_hours, "A: handed off → 0").toBeCloseTo(0, 3);
      expect(byName.get(C.name)!.planned_hours, "C: current holder → the full 12 h").toBeCloseTo(EST, 3);
      const canonicalTotal = EST; // exactly one holder, exactly one estimate
      // §2c made the segment sum AGREE with canonical Planned here — the whole
      // point of deriving the flag from the holder. Residual 1 (an acquired
      // ticket re-estimated after acquisition) is now the ONLY case where these
      // two legitimately diverge; it is measured separately above.
      expect(
        sumDelta,
        "§2c: the segment sum no longer overstates canonical Planned on a multi-hop handoff",
      ).toBeCloseTo(canonicalTotal, 3);

      // ✅ §2b(iv) is now FIXED — product-owner variant A, `CAPACITY_BAR_RULES.md`
      // §5. This block previously asserted the defect as-it-was (B +12 AND C +12,
      // Σ 24 h for one 12 h ticket) because §2a forbade touching ±Change. That
      // decision has since been taken: a POSITIVE ±Change is credited only to the
      // developer who currently HOLDS the ticket.
      expect(byName.get(B.name)!.scope_change_hours, "B passed it on → no longer credited").toBeCloseTo(0, 3);
      expect(byName.get(C.name)!.scope_change_hours, "C holds it → C alone carries the +estimate").toBeCloseTo(
        EST,
        3,
      );
      const sumChange = out.reduce((s, d) => s + d.scope_change_hours, 0);
      expect(
        sumChange,
        "Σ ±Change counts the ticket exactly once, however many hops it took",
      ).toBeCloseTo(EST, 3);
      // Guard the property itself, not just this shape: no matter how long the
      // chain grows, the estimate can be credited at most once.
      const credited = out.filter((d) => d.scope_change_hours > 0);
      expect(
        credited.length,
        `at most one developer is credited (found: ${credited.map((d) => d.name).join(", ") || "none"})`,
      ).toBeLessThanOrEqual(1);
    });
  });
});
