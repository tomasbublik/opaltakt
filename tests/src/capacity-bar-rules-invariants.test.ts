import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import { CapacityResponse, ClosureStatsResponse, SprintResponse, SyncRun } from "@osp/contracts";
import type {
  AssigneeInterval,
  DeveloperSegmentsInput,
  DeveloperSegmentsTicketInput,
  PersonRole,
  SprintStatus,
  TicketDoneBucket,
} from "@osp/contracts";
import { personKey } from "@osp/contracts";
import { developerSegments } from "../../apps/api/src/logic/developerSegments";
import { addDays, mockAdmin, type MockAdmin, S4 } from "./scenario-helpers";
import { activateSprint, bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * Increment 26 — CAPACITY_BAR_RULES.md §6 invariant regression suite (Agent D /
 * QA). docs/CAPACITY_BAR_RULES.md is the CANONICAL contract; this file encodes
 * its numbered invariants so each one FAILS LOUDLY if a future change ever
 * violates it.
 *
 * ── Increment 30 ────────────────────────────────────────────────────────────
 * §6 grew invariants **7 (Planned = current scope), 8 (the header equals the
 * sum of its own visible rows) and 9 (Planned and ±Change are never added
 * together)**. Their end-to-end coverage — including the §6.5 cross-surface
 * identity across Capacity / Closure / sprint detail / PDF — lives in
 * `inc30-current-scope-planned.test.ts`, driven by the sprint-shape
 * reproduction fixture `s21-inc30-current-scope-planned`. Invariants 7 and 9
 * ALSO get pure-engine coverage at the bottom of this file, so the contribution
 * table in `docs/INCREMENT_30_CONTRACTS.md` §2a is pinned in the same place as
 * the older invariants it sits beside.
 *
 * The core of the increment — "a developer's baseline ticket is GREEN
 * (`baseline_worked`) in active/closed regardless of logged time; the old
 * grey-hatched `baseline_idle` state is ABOLISHED" — is exercised straight
 * against the PURE `developerSegments` engine (invariants #1, #3, #4, #6, the
 * classification layer these rules live in) plus two end-to-end legs through the
 * REAL Fastify app (invariants #2, #5) that only the full lifecycle / two
 * endpoints can prove.
 *
 * SAFETY / GUARDRAIL (docs/CAPACITY_BAR_RULES.md incident note): the end-to-end
 * legs use the established `bootRealApp()` harness — an in-memory (or temp-file)
 * SQLite DB via `@osp/db` and the app driven purely by `app.inject` (NO
 * listening port), pointed at an ephemeral recording mock OP (port 0). Nothing
 * here can ever touch the user's real apps/api/osp.sqlite or a default port.
 */

// ═════════════════════════════════════════════════════════════════════════════
// PART A — pure `developerSegments` engine invariants (#1, #3, #4, #6).
// Hand-built DeveloperSegmentsInput (no DB, no OP) — the classification layer
// where the CAPACITY_BAR_RULES §2/§6 rules actually live.
// ═════════════════════════════════════════════════════════════════════════════

const ANCHOR = "2026-06-01T00:00:00Z";
const DEV_A = { op: 10, name: "Dev A" };
const DEV_B = { op: 11, name: "Dev B" };
const TESTER = { op: 20, name: "Tess Ter" };
const CUSTOMER = { op: 21, name: "Cust Omer" };
const OTHER = { op: 22, name: "Ot Her" };

const keyOf = (p: { op: number; name: string }): string => personKey(null, p.op, p.name);

function roleMap(entries: Array<[{ op: number; name: string }, PersonRole]>): Record<string, PersonRole> {
  const out: Record<string, PersonRole> = {};
  for (const [p, r] of entries) out[keyOf(p)] = r;
  return out;
}

function metaMap(
  people: Array<{ op: number; name: string }>,
): Record<string, { name: string; op_user_id: number | null; member_id: number | null }> {
  const out: Record<string, { name: string; op_user_id: number | null; member_id: number | null }> = {};
  for (const p of people) out[keyOf(p)] = { name: p.name, op_user_id: p.op, member_id: null };
  return out;
}

function iv(
  wp: number,
  holder: { op: number; name: string } | null,
  from: string,
  to: string | null,
): AssigneeInterval {
  return {
    wp_op_id: wp,
    holder_op_user_id: holder?.op ?? null,
    holder_name: holder?.name ?? null,
    holder_role: null,
    from,
    to,
  };
}

function ticket(over: Partial<DeveloperSegmentsTicketInput> & { wp_op_id: number }): DeveloperSegmentsTicketInput {
  return {
    subject: `WP ${over.wp_op_id}`,
    estimate_hours: 10,
    in_baseline_scope: true,
    done_bucket: "not_done" as TicketDoneBucket,
    assignee_intervals: [],
    status_transitions: [],
    logged_by_developer: {},
    ...over,
  };
}

function run(
  tickets: DeveloperSegmentsTicketInput[],
  roles: Record<string, PersonRole>,
  people: Array<{ op: number; name: string }>,
  extra: Partial<DeveloperSegmentsInput> = {},
): ReturnType<typeof developerSegments> {
  return developerSegments({
    baseline_anchor: ANCHOR,
    tickets,
    role_by_person: roles,
    person_meta: metaMap(people),
    ...extra,
  });
}

/** The two "green/red" kinds a developer segment can be (CAPACITY_BAR_RULES §2). */
const GREEN_KINDS = new Set(["baseline_worked"]);
const RED_KINDS = new Set(["acquired"]);
/** Kinds a baseline ticket the dev still holds must NEVER be (the abolished-idle guard). */
const HATCHED_OR_LEFT_KINDS = ["handoff", "removed", "idle", "churned"] as const;

describe("CAPACITY_BAR_RULES §6 #1 — ACTIVE/CLOSED baseline ticket is GREEN even with zero logged time", () => {
  it("a baseline ticket a developer still holds is `baseline_worked` (green, counts to Planned) with ZERO logged hours — never a hatched/idle kind, in active AND closed", () => {
    const t = ticket({
      wp_op_id: 1,
      estimate_hours: 8,
      assignee_intervals: [iv(1, DEV_A, ANCHOR, null)],
      logged_by_developer: {}, // exactly zero logged
    });
    // active/closed model: sprint_status "active", "closed", and omitted (the
    // backward-compatible default) all classify this the same way.
    for (const sprint_status of ["active", "closed", undefined] as const) {
      const extra = sprint_status ? { sprint_status: sprint_status as SprintStatus } : {};
      const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A], extra)[0]!;
      const seg = dev.segments[0]!;
      expect(seg.logged_hours, `status=${sprint_status}: zero logged`).toBe(0);
      expect(seg.kind, `status=${sprint_status}: baseline held → GREEN baseline_worked (Inc 26 abolished baseline_idle)`).toBe(
        "baseline_worked",
      );
      expect(GREEN_KINDS.has(seg.kind), `status=${sprint_status}: green kind`).toBe(true);
      expect(seg.counts_to_planned, `status=${sprint_status}: counts to Planned`).toBe(true);
      expect(dev.planned_hours, `status=${sprint_status}: Planned = estimate`).toBe(8);
      // The abolished-idle guard: a held baseline ticket is NEVER any hatched /
      // left-my-hands kind, and the old string is gone entirely.
      expect(HATCHED_OR_LEFT_KINDS as readonly string[]).not.toContain(seg.kind);
      expect(seg.kind).not.toBe("baseline_idle");
    }
  });
});

describe("CAPACITY_BAR_RULES §6 #3 — only tickets added AFTER the current activation anchor use red/blue/orange-hatched", () => {
  it("a ticket present at the current baseline is `baseline_worked` (never acquired/removed/idle); a ticket added strictly after the anchor is `acquired` — the change kinds only attach to post-anchor tickets", () => {
    // Baseline ticket: DEV_A held it AT the anchor and still holds it, zero log.
    const baseline = ticket({
      wp_op_id: 100,
      estimate_hours: 6,
      in_baseline_scope: true,
      assignee_intervals: [iv(100, DEV_A, ANCHOR, null)],
      logged_by_developer: {},
    });
    // Post-anchor ticket: NOT in baseline for DEV_A, acquired after the anchor,
    // logged → acquired (red, +Change). Its interval starts strictly after ANCHOR.
    const postAnchor = ticket({
      wp_op_id: 101,
      estimate_hours: 5,
      in_baseline_scope: false,
      assignee_intervals: [iv(101, DEV_A, "2026-06-05T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 3 },
    });
    const dev = run([baseline, postAnchor], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const segBaseline = dev.segments.find((s) => s.wp_op_id === 100)!;
    const segPost = dev.segments.find((s) => s.wp_op_id === 101)!;

    // The at-baseline ticket NEVER produces a change kind.
    expect(segBaseline.kind, "ticket present at the current baseline is baseline_worked (green)").toBe("baseline_worked");
    for (const changeKind of ["acquired", "removed", "idle", "churned"]) {
      expect(segBaseline.kind, `at-baseline ticket is never "${changeKind}"`).not.toBe(changeKind);
    }
    // Only the strictly-post-anchor ticket is a change kind.
    expect(segPost.kind, "a ticket added after the anchor + worked is acquired (red)").toBe("acquired");
    expect(RED_KINDS.has(segPost.kind)).toBe(true);
    expect(segPost.counts_to_change, "acquired feeds Change").toBe(true);
    // ⚠️ CHANGED in Increment 30 (docs/INCREMENT_30_CONTRACTS.md §2a, whose table
    // this line encodes; CAPACITY_BAR_RULES §5 + invariant 7). `Planned` is now
    // CURRENT SCOPE, so an `acquired` ticket — added after activation and still
    // this developer's — DOES count toward it. Recomputed by hand, not renamed:
    //   Planned = 6 (baseline #100) + 5 (acquired #101)  = 11
    //   Change  =                     5 (acquired #101)  =  5   (unchanged;
    //            SEGMENT_CHANGE_SIGN is explicitly untouched by §2a)
    // The two numbers are now deliberately NOT disjoint — which is exactly why
    // invariant 9 forbids ever adding them together.
    expect(segPost.counts_to_planned, "Increment 30 §2a: acquired IS current scope").toBe(true);
    expect(dev.planned_hours, "Planned = baseline 6 + acquired 5 (current scope)").toBe(11);
    expect(dev.scope_change_hours, "Change counts only the post-anchor ticket").toBe(5);
  });
});

describe("CAPACITY_BAR_RULES §6 #4 — a non-developer never produces a green/red developer segment", () => {
  it("a tester / customer / other holder produces NO developer segment row (never green or red), even when they hold a done, worked, baseline ticket", () => {
    for (const nonDev of [
      { p: TESTER, role: "tester" as PersonRole },
      { p: CUSTOMER, role: "customer" as PersonRole },
      { p: OTHER, role: "other" as PersonRole },
    ]) {
      const t = ticket({
        wp_op_id: 200,
        estimate_hours: 10,
        in_baseline_scope: true,
        done_bucket: "done",
        assignee_intervals: [iv(200, nonDev.p, ANCHOR, null)],
        logged_by_developer: {},
      });
      const out = run([t], roleMap([[nonDev.p, nonDev.role]]), [nonDev.p]);
      expect(out, `${nonDev.role} holder produces no developer breakdown at all`).toHaveLength(0);
    }
  });

  it("when a done ticket has no developer candidate at all, no green/red row is fabricated for the non-developer holder", () => {
    const t = ticket({
      wp_op_id: 201,
      estimate_hours: 10,
      done_bucket: "done",
      assignee_intervals: [iv(201, TESTER, ANCHOR, null)],
      logged_by_developer: {},
    });
    const out = run([t], roleMap([[TESTER, "tester"]]), [TESTER]);
    expect(out).toHaveLength(0);
  });
});

describe("CAPACITY_BAR_RULES §6 #6 — developerSegments is state-aware (one function, planning vs active/closed)", () => {
  it("the SAME reassignment-history ticket yields DIFFERENT, state-correct segment sets in planning vs active — proving the two branches coexist in one function", () => {
    // DEV_B held it at the anchor, then it moved to DEV_A (who holds it now).
    const t = ticket({
      wp_op_id: 300,
      estimate_hours: 12,
      in_baseline_scope: true,
      assignee_intervals: [
        iv(300, DEV_B, ANCHOR, "2026-06-02T00:00:00Z"),
        iv(300, DEV_A, "2026-06-02T00:00:00Z", null),
      ],
      logged_by_developer: {},
    });
    const roles = roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]);

    // PLANNING (Increment 24 collapse): only the CURRENT holder gets ONE
    // full-green baseline_worked segment; the former holder gets nothing.
    const planning = run([t], roles, [DEV_A, DEV_B], { sprint_status: "planning" });
    expect(planning, "planning: exactly one developer row (the current holder)").toHaveLength(1);
    expect(planning[0]!.name).toBe("Dev A");
    expect(planning[0]!.segments[0]!.kind, "planning: current holder is green baseline_worked").toBe("baseline_worked");

    // ACTIVE (full v2 model): DEV_B is the baseline holder who handed to another
    // developer → `handoff`; DEV_A holds it non-baseline, no log → `idle`.
    const active = run([t], roles, [DEV_A, DEV_B], { sprint_status: "active" });
    const activeKinds = new Map(active.map((d) => [d.name, d.segments[0]!.kind]));
    expect(activeKinds.get("Dev B"), "active: baseline holder handed to another dev → handoff").toBe("handoff");
    expect(activeKinds.get("Dev A"), "active: non-baseline current holder, no log → idle").toBe("idle");

    // The state-aware SETS genuinely differ — planning is not merely the active
    // model re-labelled.
    const planningKinds = planning.map((d) => `${d.name}:${d.segments[0]!.kind}`).sort();
    const activeKindsArr = active.map((d) => `${d.name}:${d.segments[0]!.kind}`).sort();
    expect(planningKinds).not.toEqual(activeKindsArr);
  });

  it("no regression from either state: a zero-logged baseline ticket the dev still holds is baseline_worked (green) in BOTH planning and active — Increment 24 collapse and Increment 26 merge agree", () => {
    const t = ticket({
      wp_op_id: 301,
      estimate_hours: 9,
      in_baseline_scope: true,
      assignee_intervals: [iv(301, DEV_A, ANCHOR, null)],
      logged_by_developer: {},
    });
    const roles = roleMap([[DEV_A, "developer"]]);
    const planning = run([t], roles, [DEV_A], { sprint_status: "planning" })[0]!;
    const active = run([t], roles, [DEV_A], { sprint_status: "active" })[0]!;
    // Planning reaches green via the Inc-24 collapse branch; active reaches green
    // via the Inc-26-merged baseline branch — the SAME zero-logged case, both green.
    expect(planning.segments[0]!.kind).toBe("baseline_worked");
    expect(active.segments[0]!.kind).toBe("baseline_worked");
    expect(planning.planned_hours).toBe(9);
    expect(active.planned_hours).toBe(9);
  });
});

describe("CAPACITY_BAR_RULES §6 #7 — Planned = CURRENT SCOPE (Increment 30, contracts §2a)", () => {
  /**
   * ONE developer holding, at the same time, every shape §2a's table
   * distinguishes — so the contribution rule is pinned kind by kind rather than
   * inferred from a single happy case.
   */
  const anchoredTo = (holder: { op: number; name: string } | null, from: string, to: string | null) =>
    (wp: number) => iv(wp, holder, from, to);
  const AFTER = "2026-06-05T00:00:00Z";

  it("baseline_worked + acquired + idle count toward Planned; handoff / removed / churned do not — and Planned is Σ of exactly those three", () => {
    const tickets = [
      // baseline_worked — retained, worked. 6 h.
      ticket({
        wp_op_id: 400,
        estimate_hours: 6,
        assignee_intervals: [anchoredTo(DEV_A, ANCHOR, null)(400)],
        logged_by_developer: { [keyOf(DEV_A)]: 2 },
      }),
      // acquired — added after the anchor, worked. 5 h. NEW in Increment 30.
      ticket({
        wp_op_id: 401,
        estimate_hours: 5,
        in_baseline_scope: false,
        assignee_intervals: [anchoredTo(DEV_A, AFTER, null)(401)],
        logged_by_developer: { [keyOf(DEV_A)]: 1 },
      }),
      // idle — added after the anchor, held, never worked. 4 h. NEW in Inc 30.
      ticket({
        wp_op_id: 402,
        estimate_hours: 4,
        in_baseline_scope: false,
        assignee_intervals: [anchoredTo(DEV_A, AFTER, null)(402)],
        logged_by_developer: {},
      }),
      // handoff — DEV_A's baseline, now another developer's. 9 h, contributes 0.
      ticket({
        wp_op_id: 403,
        estimate_hours: 9,
        assignee_intervals: [
          anchoredTo(DEV_A, ANCHOR, AFTER)(403),
          anchoredTo(DEV_B, AFTER, null)(403),
        ],
        logged_by_developer: { [keyOf(DEV_B)]: 2 },
      }),
      // removed — DEV_A's baseline, gone to a non-developer, never logged. 7 h, 0.
      ticket({
        wp_op_id: 404,
        estimate_hours: 7,
        assignee_intervals: [
          anchoredTo(DEV_A, ANCHOR, AFTER)(404),
          anchoredTo(TESTER, AFTER, null)(404),
        ],
        logged_by_developer: {},
      }),
      // churned — DEV_A picked it up after the anchor, never logged, moved on. 3 h, 0.
      ticket({
        wp_op_id: 405,
        estimate_hours: 3,
        in_baseline_scope: false,
        assignee_intervals: [
          anchoredTo(DEV_A, AFTER, "2026-06-07T00:00:00Z")(405),
          anchoredTo(DEV_B, "2026-06-07T00:00:00Z", null)(405),
        ],
        logged_by_developer: {},
      }),
    ];
    const roles = roleMap([[DEV_A, "developer"], [DEV_B, "developer"], [TESTER, "tester"]]);
    const a = run(tickets, roles, [DEV_A, DEV_B, TESTER], { sprint_status: "active" }).find(
      (d) => d.name === DEV_A.name,
    )!;

    const kindOf = new Map(a.segments.map((s) => [s.wp_op_id, s.kind]));
    expect(kindOf.get(400)).toBe("baseline_worked");
    expect(kindOf.get(401)).toBe("acquired");
    expect(kindOf.get(402)).toBe("idle");
    expect(kindOf.get(403)).toBe("handoff");
    expect(kindOf.get(404)).toBe("removed");
    expect(kindOf.get(405)).toBe("churned");

    // contracts §2a's table, asserted cell by cell.
    const CONTRIBUTES: Record<string, boolean> = {
      baseline_worked: true,
      acquired: true,
      idle: true,
      handoff: false,
      removed: false,
      churned: false,
    };
    for (const s of a.segments) {
      expect(s.counts_to_planned, `#${s.wp_op_id} (${s.kind}) counts_to_planned`).toBe(
        CONTRIBUTES[s.kind],
      );
    }
    // Planned = 6 + 5 + 4 = 15 — everything the developer currently holds that is
    // still in scope, and NOTHING that left their hands.
    expect(a.planned_hours, "Planned = baseline_worked 6 + acquired 5 + idle 4").toBe(15);
    // The three excluded kinds total 19 h and must be entirely absent from it.
    expect(a.planned_hours, "handoff/removed/churned never enter Planned").not.toBe(15 + 19);
  });
});

describe("CAPACITY_BAR_RULES §6 #9 — `Planned + ±Change` is a double count (Increment 30)", () => {
  it("an acquired ticket's estimate is already inside Planned, so adding ±Change on top counts it twice; Baseline + ±Change is the composition that balances", () => {
    const tickets = [
      ticket({
        wp_op_id: 500,
        estimate_hours: 10,
        assignee_intervals: [iv(500, DEV_A, ANCHOR, null)],
        logged_by_developer: { [keyOf(DEV_A)]: 4 },
      }),
      ticket({
        wp_op_id: 501,
        estimate_hours: 6,
        in_baseline_scope: false,
        assignee_intervals: [iv(501, DEV_A, "2026-06-05T00:00:00Z", null)],
        logged_by_developer: { [keyOf(DEV_A)]: 2 },
      }),
    ];
    const a = run(tickets, roleMap([[DEV_A, "developer"]]), [DEV_A], { sprint_status: "active" })[0]!;
    const baseline = a.segments
      .filter((s) => s.kind === "baseline_worked")
      .reduce((sum, s) => sum + (s.estimate_hours ?? 0), 0);

    expect(a.planned_hours, "Planned = 10 baseline + 6 acquired").toBe(16);
    expect(a.scope_change_hours, "±Change = +6 acquired").toBe(6);
    expect(baseline, "Baseline = the retained 10").toBe(10);
    // The contract-sanctioned composition.
    expect(baseline + a.scope_change_hours, "Baseline + ±Change == Planned").toBe(a.planned_hours);
    // The forbidden one — it counts the acquired 6 h twice (22, not 16).
    expect(a.planned_hours + a.scope_change_hours).toBe(22);
    expect(
      a.planned_hours + a.scope_change_hours,
      "Planned + ±Change is nobody's scope — it double-counts the acquired work",
    ).not.toBe(a.planned_hours);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B — end-to-end invariants through the REAL app (#2, #5).
// bootRealApp + an ephemeral recording mock OP loaded with S4 (volatile sprint,
// dev/tester cast). Isolated: in-memory/temp SQLite + app.inject (no port).
// ═════════════════════════════════════════════════════════════════════════════

// S4 seed (project 3): op_user_id 1 = "Dev Dvořák" (developer); baseline dev
// tickets 1401 (est 12) and 1405 (est 6).
const DEV = { op_user_id: 1, name: "Dev Dvořák" };
const WP_A = 1401; // dev baseline, est 12
const WP_B = 1405; // dev baseline, est 6

interface PersonRow {
  id: number;
  name: string;
  role: PersonRole;
}

/** GET /api/people → find by name → PUT /people/:id/role. Returns true on success. */
async function setDeveloperRole(harness: RealApp, name: string): Promise<boolean> {
  const people = await call(harness.app, "GET", "/api/people");
  if (people.status !== 200) return false;
  const person = (people.json as PersonRow[]).find((p) => p.name === name);
  if (!person) return false;
  const res = await call(harness.app, "PUT", `/api/people/${person.id}/role`, { role: "developer" });
  return res.status >= 200 && res.status < 300;
}

async function getClosure(harness: RealApp, sprintId: number): Promise<ClosureStatsResponse> {
  const res = await call(harness.app, "GET", `/api/sprints/${sprintId}/closure-stats`);
  expect(res.status, `closure-stats ${res.status}: ${JSON.stringify(res.json)}`).toBe(200);
  return ClosureStatsResponse.parse(res.json);
}

describe("CAPACITY_BAR_RULES §6 #5 — the Capacity endpoint and the Closure endpoint return IDENTICAL Planned for the same sprint (bootRealApp + S4)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-barrules-parity-"));
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
      name: "bar-rules parity sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;
    for (const wp of [WP_A, WP_B]) {
      const added = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: wp });
      expect(added.status, `add ${wp}: ${JSON.stringify(added.json)}`).toBeLessThan(300);
    }
    expect(await setDeveloperRole(harness, DEV.name), `set ${DEV.name} role=developer`).toBe(true);
    await activateSprint(harness.app, sprintId);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("capacity.scope_planned_hours === closure.total_planned_hours === Σ per_developer[].planned_hours, and all are > 0", async () => {
    const capRes = await call(harness.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expect(capRes.status).toBe(200);
    const cap = CapacityResponse.parse(capRes.json);
    const closure = await getClosure(harness, sprintId);

    const perDevPlanned = closure.per_developer.reduce((s, d) => s + d.planned_hours, 0);

    // The "one computation, four surfaces" contract (CAPACITY_BAR_RULES §5 /
    // SPEC_17 §4a): both endpoints read the SAME computeClosureStats() run.
    expect(cap.scope_planned_hours, "capacity.scope_planned_hours === closure.total_planned_hours").toBeCloseTo(
      closure.total_planned_hours,
      3,
    );
    expect(closure.total_planned_hours, "closure.total_planned_hours === Σ per_developer[].planned_hours").toBeCloseTo(
      perDevPlanned,
      3,
    );
    // The developer holds two baseline tickets, zero logged → both green
    // baseline_worked → a real, non-zero Planned (proves the parity isn't the
    // trivial 0 === 0).
    expect(closure.total_planned_hours, "Planned is a real, non-zero rollup").toBeGreaterThan(0);
    const dev = closure.per_developer.find((d) => d.name === DEV.name);
    expect(dev, `${DEV.name} appears in per_developer`).toBeTruthy();
    for (const seg of dev!.segments) {
      expect(seg.kind, `#${seg.wp_op_id}: held baseline, zero logged → green baseline_worked (Inc 26)`).toBe("baseline_worked");
    }
  });
});

describe("CAPACITY_BAR_RULES §6 #2 — re-activation RE-CAPTURES the baseline (bootRealApp + S4)", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-barrules-reactivate-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    expect(SyncRun.parse((await call(harness.app, "POST", "/api/sync", { project_op_id: 3 })).json).status).toBe("success");

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "bar-rules reactivate sprint",
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    sprintId = SprintResponse.parse(created.json).id;

    // FIRST activation: baseline #1 = { WP_A } only.
    const addA = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: WP_A });
    expect(addA.status).toBeLessThan(300);
    expect(await setDeveloperRole(harness, DEV.name), `set ${DEV.name} role=developer`).toBe(true);
    await activateSprint(harness.app, sprintId);

    // Back to planning (the real "Back to planning" PATCH), then add a NEW ticket
    // that was NOT present at the first activation.
    const back = await call(harness.app, "PATCH", `/api/sprints/${sprintId}`, { status: "planning" });
    expect(back.status, `back-to-planning ${back.status}: ${JSON.stringify(back.json)}`).toBeLessThan(300);
    const addB = await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: WP_B });
    expect(addB.status, `add WP_B: ${JSON.stringify(addB.json)}`).toBeLessThan(300);

    // SECOND activation: baseline #2 must RE-CAPTURE = { WP_A, WP_B }.
    await activateSprint(harness.app, sprintId);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("a ticket added between the first and second activation is `baseline_worked` (green) at the second activation — re-captured into the new baseline, NOT treated as an after-anchor acquired/idle/removed", async () => {
    const closure = await getClosure(harness, sprintId);
    const dev = closure.per_developer.find((d) => d.name === DEV.name);
    expect(dev, `${DEV.name} appears in per_developer after re-activation`).toBeTruthy();

    const segByWp = new Map(dev!.segments.map((s) => [s.wp_op_id, s]));
    // BOTH tickets are in the re-captured baseline → both green baseline_worked.
    for (const wp of [WP_A, WP_B]) {
      const seg = segByWp.get(wp);
      expect(seg, `#${wp} has a segment after re-activation`).toBeTruthy();
      expect(
        seg!.kind,
        `#${wp} is baseline_worked (green) at the SECOND activation — re-captured baseline (CAPACITY_BAR_RULES §1/§6 #2)`,
      ).toBe("baseline_worked");
      expect(seg!.counts_to_planned, `#${wp} counts to Planned`).toBe(true);
    }
    // The re-added ticket specifically must NOT read as an after-anchor change kind.
    const segB = segByWp.get(WP_B)!;
    for (const changeKind of ["acquired", "removed", "idle", "churned"]) {
      expect(segB.kind, `#${WP_B} (added before the 2nd activation) is not "${changeKind}"`).not.toBe(changeKind);
    }
    // Planned reflects BOTH re-captured baseline tickets (12 + 6 = 18).
    expect(dev!.planned_hours, "Planned = both re-captured baseline tickets").toBeGreaterThan(0);
  });
});
