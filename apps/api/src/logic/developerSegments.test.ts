import type {
  AssigneeInterval,
  DeveloperSegmentsInput,
  DeveloperSegmentsTicketInput,
  PersonRole,
  TicketDoneBucket,
} from "@osp/contracts";
import { describe, expect, it } from "vitest";
import { personKey } from "@osp/contracts";
import { developerSegments } from "./developerSegments";

/**
 * Increment 17 (SPEC_17 §1, "v2") — the pure developerSegments engine. Every
 * case is a hand-constructed DeveloperSegmentsInput (no DB, no Agent-A fixture)
 * exercising exactly one §1 row (a–g) or one DELIVERED tie-break branch, plus
 * the two structural guarantees this increment adds: Planned can NEVER go
 * negative (BUG 2), and a dev→dev HANDOFF receiver who logged gets a RED
 * `acquired` segment (BUG 1, the #11762 regression).
 */

const ANCHOR = "2026-06-01T00:00:00Z";

// Named people, keyed exactly as the engine keys them (id:<opId>).
const DEV_A = { op: 10, name: "Dev A" };
const DEV_B = { op: 11, name: "Dev B" };
const DEV_C = { op: 12, name: "Dev C" };
const TESTER = { op: 20, name: "Tess Ter" };

// The test tickets carry no connection_id (→ null in the engine), so keys are
// built with a null connection to match the engine's interval-holder keys.
const keyOf = (p: { op: number; name: string }): string => personKey(null, p.op, p.name);

function roleMap(
  entries: Array<[{ op: number; name: string }, PersonRole]>,
): Record<string, PersonRole> {
  const out: Record<string, PersonRole> = {};
  for (const [p, r] of entries) out[keyOf(p)] = r;
  return out;
}

function metaMap(
  people: Array<{ op: number; name: string }>,
): Record<string, { name: string; op_user_id: number | null; member_id: number | null }> {
  const out: Record<string, { name: string; op_user_id: number | null; member_id: number | null }> =
    {};
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
  const input: DeveloperSegmentsInput = {
    baseline_anchor: ANCHOR,
    tickets,
    role_by_person: roles,
    person_meta: metaMap(people),
    ...extra,
  };
  return developerSegments(input);
}

describe("developerSegments — SPEC_17 §1 seven-row classification (v2)", () => {
  it("(a) baseline_worked: baseline dev logged, still theirs → +Planned, 0 Change, marker", () => {
    const t = ticket({
      wp_op_id: 1,
      estimate_hours: 10,
      done_bucket: "not_done",
      assignee_intervals: [iv(1, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 4 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    expect(seg.kind).toBe("baseline_worked");
    expect(seg.counts_to_planned).toBe(true);
    expect(seg.planned_delta_hours).toBe(10);
    expect(seg.counts_to_change).toBe(false);
    expect(seg.change_delta_hours).toBe(0);
    expect(seg.show_logged_marker).toBe(true);
    expect(seg.in_baseline).toBe(true);
    expect(dev.planned_hours).toBe(10);
    expect(dev.scope_change_hours).toBe(0);
  });

  it("(a) baseline_worked still applies when handed to a TESTER (not another dev)", () => {
    const t = ticket({
      wp_op_id: 2,
      estimate_hours: 30,
      done_bucket: "done",
      assignee_intervals: [iv(2, DEV_A, ANCHOR, "2026-06-05T00:00:00Z"), iv(2, TESTER, "2026-06-05T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 46.5 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [TESTER, "tester"]]), [DEV_A, TESTER]);
    expect(out).toHaveLength(1); // tester produces no developer row
    const dev = out[0]!;
    const seg = dev.segments[0]!;
    // Colour, kind and BAR LENGTH are untouched — §1–§4 of the bar rules did
    // not move, and this stays a full-length green segment.
    expect(seg.kind).toBe("baseline_worked");
    expect(seg.estimate_hours).toBe(30);
    expect(seg.current_holder_role).toBe("tester");
    // Increment 30 §2c — the ANNOTATION is holder-derived, not kind-derived. The
    // ticket now sits with a TESTER, so it is not this developer's current scope:
    // counts_to_planned true → false, planned_delta 30 → 0. This is the measured
    // Zbynek Trnka defect: with the §2a kind table the green bar annotated 30 h
    // while the canonical number said 0 h, for one person, on screen, at once.
    // `handoff` could never have caught it — that kind means "reassigned to
    // another DEVELOPER", so a hand-off to a tester stays baseline_worked.
    expect(seg.counts_to_planned).toBe(false);
    expect(seg.planned_delta_hours).toBe(0);
    // ...and the number the annotation now agrees with. Not a new opinion:
    // `computeCapacity` has always attributed this ticket to the TESTER's
    // (non-developer, excluded) line — before Increment 30 Closure said 30 and
    // Capacity said 0 for the same sprint.
    expect(dev.planned_hours).toBe(0);
    expect(dev.segments.reduce((s, x) => s + x.planned_delta_hours, 0)).toBe(0);
    // The 30 h are not lost — they are the RETAINED BASELINE, under its own label.
    expect(dev.baseline_hours).toBe(30);
    // DELIVERED credited to the dev; accuracy 155%, overshoot +16.5.
    expect(dev.delivered_hours).toBe(30);
    expect(dev.delivered_estimate_hours).toBe(30); // deprecated alias == delivered_hours
    expect(dev.accuracy_pct).toBeCloseTo(155, 5);
    expect(dev.overshoot_hours).toBeCloseTo(16.5, 5);
  });

  it("(Increment 26) baseline dev, no log, STILL holds → baseline_worked (GREEN), +Planned (distinct from removed)", () => {
    const t = ticket({
      wp_op_id: 3,
      estimate_hours: 8,
      done_bucket: "not_done",
      assignee_intervals: [iv(3, DEV_A, ANCHOR, null)],
      logged_by_developer: {},
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    // Increment 26 (CAPACITY_BAR_RULES.md §6 #1): a held-but-unlogged baseline
    // ticket is green baseline_worked, NOT the abolished grey-hatched baseline_idle.
    expect(seg.kind).toBe("baseline_worked");
    expect(seg.counts_to_planned).toBe(true);
    expect(seg.planned_delta_hours).toBe(8);
    expect(seg.change_delta_hours).toBe(0);
    // Marker flag follows baseline_worked's SEGMENT_LOGGED_MARKER_KINDS membership;
    // it's a visual no-op at logged=0, so no bar changes despite flipping true.
    expect(seg.show_logged_marker).toBe(true);
    expect(seg.logged_hours).toBe(0);
    expect(dev.planned_hours).toBe(8); // counts to Planned even with zero log
    expect(dev.scope_change_hours).toBe(0);
  });

  // CAPACITY_BAR_RULES.md §6 invariant #1 — MUST fail if the abolished baseline_idle
  // hatched-idle state is ever reintroduced. A baseline ticket held by the SAME
  // developer with exactly zero logged hours renders GREEN (baseline_worked), never
  // any hatched "held but not yet logged" kind.
  it("INVARIANT §6#1: baseline ticket, same dev, ZERO logged → baseline_worked (green), never hatched idle", () => {
    const t = ticket({
      wp_op_id: 26,
      estimate_hours: 12,
      done_bucket: "not_done",
      assignee_intervals: [iv(26, DEV_A, ANCHOR, null)],
      logged_by_developer: {}, // exactly zero logged for the baseline holder
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    expect(seg.logged_hours).toBe(0);
    expect(seg.kind).toBe("baseline_worked");
    // The old hatched-idle kind must no longer exist anywhere in the output.
    expect(seg.kind).not.toBe("baseline_idle" as unknown as typeof seg.kind);
    expect(seg.counts_to_planned).toBe(true);
    expect(seg.counts_to_change).toBe(false);
    expect(seg.in_baseline).toBe(true);
    expect(dev.planned_hours).toBe(12);
    expect(dev.scope_change_hours).toBe(0);
  });

  it("(c) handoff: baseline dev → ANOTHER developer → 0 Planned, 0 Change (NOT −estimate)", () => {
    const t = ticket({
      wp_op_id: 4,
      estimate_hours: 8,
      done_bucket: "not_done",
      assignee_intervals: [iv(4, DEV_A, ANCHOR, "2026-06-04T00:00:00Z"), iv(4, DEV_B, "2026-06-04T00:00:00Z", null)],
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    const a = out.find((d) => d.name === "Dev A")!;
    expect(a.segments[0]!.kind).toBe("handoff");
    expect(a.segments[0]!.counts_to_planned).toBe(false);
    expect(a.segments[0]!.counts_to_change).toBe(false);
    expect(a.segments[0]!.planned_delta_hours).toBe(0);
    expect(a.segments[0]!.change_delta_hours).toBe(0); // sender is NOT charged −8
    expect(a.planned_hours).toBe(0);
    expect(a.scope_change_hours).toBe(0);
    // Increment 38 — Baseline = what A signed up for at activation; a later
    // handoff moves Planned, never Baseline.
    expect(a.baseline_hours).toBe(8);
    // Dev B holds it now, logged nothing → idle (kind/colour unchanged).
    const b = out.find((d) => d.name === "Dev B")!;
    expect(b.segments[0]!.kind).toBe("idle");
    // Increment 30 (INCREMENT_30_CONTRACTS §2a) — B currently holds the ticket,
    // so its 8 h ARE B's current scope: 0 → 8. Under the pre-Increment-30
    // definition the estimate counted on NEITHER developer and simply vanished
    // from the sprint's Planned; now it follows the ticket to whoever holds it.
    expect(b.planned_hours).toBe(8);
    expect(b.baseline_hours).toBe(0); // ...but it is not B's BASELINE work
    expect(b.scope_change_hours).toBe(0); // idle still moves neither ±Change side
  });

  it("(c) handoff wins over baseline_worked even if the sender logged (final holder is another dev)", () => {
    const t = ticket({
      wp_op_id: 41,
      estimate_hours: 8,
      done_bucket: "not_done",
      assignee_intervals: [iv(41, DEV_A, ANCHOR, "2026-06-04T00:00:00Z"), iv(41, DEV_B, "2026-06-04T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 3 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    const a = out.find((d) => d.name === "Dev A")!;
    expect(a.segments[0]!.kind).toBe("handoff");
    expect(a.planned_hours).toBe(0); // logged, but handoff → 0 Planned for the sender
  });

  it("(d) removed: baseline dev, no log, dropped to unassigned → 0 Planned, −estimate Change", () => {
    const t = ticket({
      wp_op_id: 5,
      estimate_hours: 6,
      done_bucket: "not_done",
      assignee_intervals: [iv(5, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"), iv(5, null, "2026-06-03T00:00:00Z", null)],
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    expect(seg.kind).toBe("removed");
    expect(seg.counts_to_planned).toBe(false);
    expect(seg.planned_delta_hours).toBe(0);
    expect(seg.counts_to_change).toBe(true);
    expect(seg.change_delta_hours).toBe(-6);
    expect(seg.current_holder_name).toBeNull();
    expect(dev.planned_hours).toBe(0);
    expect(dev.scope_change_hours).toBe(-6);
  });

  it("(d) removed: baseline dev, no log, dropped to a NON-developer holder → −estimate Change", () => {
    const t = ticket({
      wp_op_id: 51,
      estimate_hours: 6,
      done_bucket: "not_done",
      assignee_intervals: [iv(51, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"), iv(51, TESTER, "2026-06-03T00:00:00Z", null)],
    });
    const dev = run([t], roleMap([[DEV_A, "developer"], [TESTER, "tester"]]), [DEV_A, TESTER])[0]!;
    expect(dev.segments[0]!.kind).toBe("removed");
    expect(dev.scope_change_hours).toBe(-6);
  });

  it("(e) acquired: non-baseline dev logged → Planned = LIVE estimate, +estimate(at acquisition) Change, red+marker", () => {
    const t = ticket({
      wp_op_id: 6,
      estimate_hours: 25, // current estimate
      estimate_at_acquisition: { "2026-06-05T00:00:00Z": 19 },
      in_baseline_scope: false,
      done_bucket: "done",
      assignee_intervals: [iv(6, DEV_A, "2026-06-05T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 17.5 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    expect(seg.kind).toBe("acquired");
    expect(seg.estimate_hours).toBe(19); // AT ACQUISITION, not the current 25
    // Increment 30 (§2a) — an `acquired` ticket IS current scope for its holder,
    // so the segment now annotates as counting: false → true, 0 → 19.
    expect(seg.counts_to_planned).toBe(true);
    expect(seg.planned_delta_hours).toBe(19);
    expect(seg.counts_to_change).toBe(true);
    expect(seg.change_delta_hours).toBe(19);
    expect(seg.in_baseline).toBe(false);
    expect(seg.show_logged_marker).toBe(true);
    // ⚠️ THE MEASURED §2a RESIDUAL, pinned deliberately (INCREMENT_30_CONTRACTS
    // §2a's "measure, do not paper over"): Planned is 25 — the LIVE
    // effectiveEstimate of the ticket this developer currently holds — while
    // Σ planned_delta_hours is 19, the estimate AT ACQUISITION that gives the red
    // segment its length. A 6 h gap, and it is CORRECT: the canonical value wins
    // for anything displayed as "Planned" (bar length stays reconstructed
    // history; the number is today's commitment). Do NOT "fix" this by coercing
    // either side — that would either lie about the bar or freeze the number.
    expect(dev.planned_hours).toBe(25);
    expect(dev.segments.reduce((s, x) => s + x.planned_delta_hours, 0)).toBe(19);
    expect(dev.baseline_hours).toBe(0); // acquired is never retained baseline
    expect(dev.scope_change_hours).toBe(19);
    expect(dev.delivered_hours).toBe(19);
    expect(dev.accuracy_pct).toBeCloseTo(92.105, 2);
  });

  it("(e) acquired estimate falls back to current estimate when no acquisition-map entry", () => {
    const t = ticket({
      wp_op_id: 61,
      estimate_hours: 12,
      in_baseline_scope: false,
      done_bucket: "not_done",
      assignee_intervals: [iv(61, DEV_A, "2026-06-05T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 4 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.segments[0]!.estimate_hours).toBe(12);
    expect(dev.scope_change_hours).toBe(12);
  });

  it("(f) idle: non-baseline dev holds, never logged → Planned = estimate, 0 Change", () => {
    const t = ticket({
      wp_op_id: 7,
      estimate_hours: 5,
      in_baseline_scope: false,
      assignee_intervals: [iv(7, DEV_A, "2026-06-05T00:00:00Z", null)],
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    expect(seg.kind).toBe("idle");
    // Increment 30 (§2a) — held right now, so it IS current scope: false → true,
    // 0 → 5. The orange-hatched colour and the bar length are unchanged, and
    // ±Change still ignores `idle` entirely (Increment-17 semantics preserved).
    expect(seg.counts_to_planned).toBe(true);
    expect(seg.counts_to_change).toBe(false);
    expect(seg.planned_delta_hours).toBe(5);
    expect(seg.change_delta_hours).toBe(0);
    expect(dev.planned_hours).toBe(5); // was 0 before Increment 30
    expect(dev.baseline_hours).toBe(0);
    expect(dev.scope_change_hours).toBe(0);
  });

  it("(g) churned: non-baseline dev held, no log, moved on → 0 Planned, 0 Change", () => {
    const t = ticket({
      wp_op_id: 8,
      estimate_hours: 5,
      in_baseline_scope: false,
      assignee_intervals: [
        iv(8, DEV_A, "2026-06-05T00:00:00Z", "2026-06-07T00:00:00Z"),
        iv(8, TESTER, "2026-06-07T00:00:00Z", null),
      ],
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [TESTER, "tester"]]), [DEV_A, TESTER]);
    expect(out).toHaveLength(1);
    const seg = out[0]!.segments[0]!;
    expect(seg.kind).toBe("churned");
    expect(seg.change_delta_hours).toBe(0);
    expect(out[0]!.scope_change_hours).toBe(0); // NOT −5 (churn never charges Change)
  });

  it("null estimate_hours contributes 0 to both numbers", () => {
    const t = ticket({
      wp_op_id: 9,
      estimate_hours: null,
      done_bucket: "not_done",
      assignee_intervals: [iv(9, DEV_A, ANCHOR, null)],
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.segments[0]!.kind).toBe("baseline_worked"); // Increment 26: held baseline = green
    expect(dev.planned_hours).toBe(0);
    expect(dev.scope_change_hours).toBe(0);
  });

  it("role-gates: a tester/customer never gets any developer segment/row", () => {
    const t = ticket({
      wp_op_id: 10,
      estimate_hours: 10,
      done_bucket: "done",
      assignee_intervals: [iv(10, TESTER, ANCHOR, null)],
      logged_by_developer: {},
    });
    const out = run([t], roleMap([[TESTER, "tester"]]), [TESTER]);
    expect(out).toHaveLength(0);
  });

  it("dedupe: a handoff ticket both dev A and dev B logged shows on BOTH bars", () => {
    // Baseline dev A hands to dev B; both logged. A: handoff(0/0), B: acquired(+).
    const t = ticket({
      wp_op_id: 11,
      estimate_hours: 10,
      done_bucket: "done",
      assignee_intervals: [iv(11, DEV_A, ANCHOR, "2026-06-04T00:00:00Z"), iv(11, DEV_B, "2026-06-04T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 3, [keyOf(DEV_B)]: 7 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    const a = out.find((d) => d.name === "Dev A")!;
    const b = out.find((d) => d.name === "Dev B")!;
    expect(a.segments[0]!.kind).toBe("handoff");
    expect(a.planned_hours).toBe(0);
    expect(a.scope_change_hours).toBe(0);
    expect(b.segments[0]!.kind).toBe("acquired");
    // Increment 30 — the 10 h follow the ticket to B, who holds it now: 0 → 10.
    // Sender A stays at 0 (handoff), so the estimate is counted EXACTLY ONCE
    // across the two bars — which is what makes invariant 8's "header == Σ rows"
    // hold. `scope_change_hours` is untouched by this increment.
    expect(b.planned_hours).toBe(10);
    expect(b.baseline_hours).toBe(0);
    expect(a.planned_hours + b.planned_hours).toBe(10);
    expect(b.scope_change_hours).toBe(10);
    // DELIVERED credited to exactly ONE developer (max logged = B's 7).
    expect(b.delivered_hours).toBe(10);
    expect(a.delivered_hours).toBe(0);
  });
});

describe("developerSegments — Planned is structurally non-negative (SPEC_17 §4 BUG 2)", () => {
  it("a developer with heavy removed + handoff activity NEVER goes negative on Planned", () => {
    // One small baseline_worked (+4 Planned) alongside three removed baselines
    // (−4, −6, −8 Change) and a handoff (0). v1's signed total would have driven
    // Planned to 4−18 = −14; v2 keeps Planned = 4 and puts the loss in Change.
    const worked = ticket({
      wp_op_id: 20,
      estimate_hours: 4,
      assignee_intervals: [iv(20, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 2 },
    });
    const mkRemoved = (wp: number, est: number): DeveloperSegmentsTicketInput =>
      ticket({
        wp_op_id: wp,
        estimate_hours: est,
        assignee_intervals: [iv(wp, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"), iv(wp, null, "2026-06-03T00:00:00Z", null)],
      });
    const handoff = ticket({
      wp_op_id: 24,
      estimate_hours: 100,
      assignee_intervals: [iv(24, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"), iv(24, DEV_B, "2026-06-03T00:00:00Z", null)],
    });
    const dev = run(
      [worked, mkRemoved(21, 4), mkRemoved(22, 6), mkRemoved(23, 8), handoff],
      roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]),
      [DEV_A, DEV_B],
    ).find((d) => d.name === "Dev A")!;
    expect(dev.planned_hours).toBe(4); // ONLY the baseline_worked, never subtracted
    expect(dev.planned_hours).toBeGreaterThanOrEqual(0);
    expect(dev.scope_change_hours).toBe(-18); // −(4+6+8), handoff excluded
  });

  it("a developer whose baseline was ENTIRELY removed has Planned 0 (never negative)", () => {
    const t = ticket({
      wp_op_id: 25,
      estimate_hours: 40,
      assignee_intervals: [iv(25, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"), iv(25, null, "2026-06-03T00:00:00Z", null)],
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.planned_hours).toBe(0);
    expect(dev.planned_hours).toBeGreaterThanOrEqual(0);
    expect(dev.scope_change_hours).toBe(-40);
  });
});

describe("developerSegments — BUG 1: dev→dev handoff receiver gets RED (ticket 11762)", () => {
  it("mid-chain receiver who LOGGED gets `acquired`; baseline holder gets `handoff`", () => {
    // Real regression chain (SPEC_17 §3): Cameron Dalby (baseline) → Tobiáš
    // Bubeník → Daniel Brabec → Tobiáš → Daniel → Jan Bílý (final/current). Tobiáš
    // logged time during one of his two holds. He is NEITHER baseline NOR the
    // final holder — a MIDDLE-of-chain developer — yet must get a RED `acquired`.
    const CHRIS = { op: 100, name: "Cameron Dalby" };
    const TOBIAS = { op: 261, name: "Tobiáš Bubeník" };
    const DANIEL = { op: 102, name: "Daniel Brabec" };
    const JAN = { op: 103, name: "Jan Bílý" };
    const t = ticket({
      wp_op_id: 11762,
      estimate_hours: 12,
      in_baseline_scope: true,
      done_bucket: "done",
      assignee_intervals: [
        iv(11762, CHRIS, ANCHOR, "2026-06-02T00:00:00Z"),
        iv(11762, TOBIAS, "2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z"),
        iv(11762, DANIEL, "2026-06-03T00:00:00Z", "2026-06-04T00:00:00Z"),
        iv(11762, TOBIAS, "2026-06-04T00:00:00Z", "2026-06-05T00:00:00Z"),
        iv(11762, DANIEL, "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z"),
        iv(11762, JAN, "2026-06-06T00:00:00Z", null),
      ],
      logged_by_developer: { [keyOf(TOBIAS)]: 12 },
    });
    const out = run(
      [t],
      roleMap([[CHRIS, "developer"], [TOBIAS, "developer"], [DANIEL, "developer"], [JAN, "developer"]]),
      [CHRIS, TOBIAS, DANIEL, JAN],
    );

    const chris = out.find((d) => d.name === "Cameron Dalby")!;
    const tobias = out.find((d) => d.name === "Tobiáš Bubeník")!;
    const daniel = out.find((d) => d.name === "Daniel Brabec")!;
    const jan = out.find((d) => d.name === "Jan Bílý")!;

    // Cameron: baseline holder, final holder is another developer → handoff.
    expect(chris.segments[0]!.kind).toBe("handoff");
    expect(chris.planned_hours).toBe(0);
    expect(chris.scope_change_hours).toBe(0);

    // Tobiáš: THE FIX — middle-of-chain, logged → RED acquired (not nothing).
    expect(tobias.segments.map((s) => s.kind)).toContain("acquired");
    const tSeg = tobias.segments.find((s) => s.kind === "acquired")!;
    expect(tSeg.show_logged_marker).toBe(true);
    expect(tobias.planned_hours).toBe(0);
    // ⚠️ UPDATED — Increment 30 follow-up, variant A (`CAPACITY_BAR_RULES.md` §5):
    // these two asserted 12. A positive ±Change is now credited ONLY to the
    // developer who currently holds the ticket, and Tobiáš is a MIDDLE-of-chain
    // holder — Jan holds it at the end. His red `acquired` segment, its colour
    // and its 12 h bar length are all unchanged (that is what BUG 1 fixed and it
    // still holds); only the ±Change annotation drops to 0.
    //
    // Sprint-wide this chain now nets to 0, which is the point: the ticket was
    // in Cameron's BASELINE and merely moved between people — the sprint
    // gained no scope. Under the old rule Tobiáš alone reported +12 for it, and a
    // longer chain reported +12 per logging holder.
    expect(tSeg.change_delta_hours).toBe(0);
    expect(tobias.scope_change_hours).toBe(0);
    // …and his real work has NOT vanished from the numbers: he logged the most,
    // so DELIVERED is still credited to him. "Who did the work" lives in
    // Delivered and in logged hours; ±Change answers "how did this person's
    // scope move", and a ticket he no longer holds has moved on.
    expect(tobias.delivered_hours).toBe(12);

    // Daniel: held twice, no log, not current → churned (informative).
    expect(daniel.segments.every((s) => s.kind === "churned")).toBe(true);
    expect(daniel.scope_change_hours).toBe(0);
    // Jan: current holder, no log → idle.
    expect(jan.segments[0]!.kind).toBe("idle");

    // No developer's Planned is ever negative.
    for (const d of out) expect(d.planned_hours).toBeGreaterThanOrEqual(0);
  });
});

describe("developerSegments — DELIVERED tie-break cascade (SPEC_15 §3, unchanged in v2)", () => {
  it("unique max logger wins", () => {
    const t = ticket({
      wp_op_id: 200,
      estimate_hours: 20,
      done_bucket: "done",
      assignee_intervals: [iv(200, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 10, [keyOf(DEV_B)]: 4 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    expect(out.find((d) => d.name === "Dev A")!.delivered_hours).toBe(20);
    expect(out.find((d) => d.name === "Dev B")!.delivered_hours).toBe(0);
  });

  it("tie resolved by the transition holder (who pushed it across the line)", () => {
    const t = ticket({
      wp_op_id: 201,
      estimate_hours: 20,
      done_bucket: "done",
      assignee_intervals: [
        iv(201, DEV_A, ANCHOR, "2026-06-06T00:00:00Z"),
        iv(201, DEV_B, "2026-06-06T00:00:00Z", null),
      ],
      status_transitions: [{ from: "In progress", to: "Developed", at: "2026-06-08T00:00:00Z" }],
      logged_by_developer: { [keyOf(DEV_A)]: 10, [keyOf(DEV_B)]: 10 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    expect(out.find((d) => d.name === "Dev B")!.delivered_hours).toBe(20);
    expect(out.find((d) => d.name === "Dev A")!.delivered_hours).toBe(0);
  });

  it("tie with NO qualifying transition falls to the baseline assignee", () => {
    const t = ticket({
      wp_op_id: 202,
      estimate_hours: 20,
      done_bucket: "done",
      assignee_intervals: [
        iv(202, DEV_A, ANCHOR, "2026-06-06T00:00:00Z"),
        iv(202, DEV_B, "2026-06-06T00:00:00Z", null),
      ],
      status_transitions: [],
      logged_by_developer: { [keyOf(DEV_A)]: 10, [keyOf(DEV_B)]: 10 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    expect(out.find((d) => d.name === "Dev A")!.delivered_hours).toBe(20);
    expect(out.find((d) => d.name === "Dev B")!.delivered_hours).toBe(0);
  });

  it("tie where neither transition nor baseline is in the tied set → earliest logger", () => {
    const t = ticket({
      wp_op_id: 203,
      estimate_hours: 20,
      done_bucket: "done",
      assignee_intervals: [iv(203, DEV_C, ANCHOR, null)],
      status_transitions: [],
      logged_by_developer: { [keyOf(DEV_A)]: 10, [keyOf(DEV_B)]: 10 },
      first_logged_at_by_developer: {
        [keyOf(DEV_A)]: "2026-06-09",
        [keyOf(DEV_B)]: "2026-06-05",
      },
    });
    const out = run(
      [t],
      roleMap([[DEV_A, "developer"], [DEV_B, "developer"], [DEV_C, "developer"]]),
      [DEV_A, DEV_B, DEV_C],
    );
    expect(out.find((d) => d.name === "Dev B")!.delivered_hours).toBe(20);
  });

  it("maxLogged === 0 over held devs → deterministic (op_user_id asc)", () => {
    const t = ticket({
      wp_op_id: 204,
      estimate_hours: 15,
      done_bucket: "done",
      in_baseline_scope: false,
      assignee_intervals: [
        iv(204, DEV_B, "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z"),
        iv(204, DEV_A, "2026-06-06T00:00:00Z", null),
      ],
      logged_by_developer: {},
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]), [DEV_A, DEV_B]);
    expect(out.find((d) => d.name === "Dev A")!.delivered_hours).toBe(15);
    expect(out.find((d) => d.name === "Dev B")!.delivered_hours).toBe(0);
  });

  it("no developer candidate at all → unattributed (4e admit-don't-infer)", () => {
    const t = ticket({
      wp_op_id: 205,
      estimate_hours: 15,
      done_bucket: "done",
      assignee_intervals: [iv(205, TESTER, ANCHOR, null)],
      logged_by_developer: {},
    });
    const out = run([t], roleMap([[TESTER, "tester"]]), [TESTER]);
    expect(out).toHaveLength(0);
  });

  it("logged without ever being assigned → time counts, but NO segment", () => {
    const t = ticket({
      wp_op_id: 206,
      estimate_hours: 8,
      in_baseline_scope: false,
      done_bucket: "not_done",
      assignee_intervals: [iv(206, TESTER, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 5 },
    });
    const out = run([t], roleMap([[DEV_A, "developer"], [TESTER, "tester"]]), [DEV_A, TESTER]);
    const a = out.find((d) => d.name === "Dev A")!;
    expect(a.logged_hours).toBe(5); // time still counted
    expect(a.segments).toHaveLength(0); // but no acquired (never assigned)
    expect(a.planned_hours).toBe(0);
    expect(a.scope_change_hours).toBe(0);
  });
});

describe("developerSegments — SPEC_24 §2/§3 planning is state-aware (green, not hatched)", () => {
  it("planning: developer's current ticket is a single full-green baseline_worked segment, no logged work needed", () => {
    const t = ticket({
      wp_op_id: 301,
      estimate_hours: 8,
      done_bucket: "not_done",
      assignee_intervals: [iv(301, DEV_A, ANCHOR, null)],
      logged_by_developer: {},
    });
    const dev = run(
      [t],
      roleMap([[DEV_A, "developer"]]),
      [DEV_A],
      { sprint_status: "planning" },
    )[0]!;
    expect(dev.segments).toHaveLength(1);
    const seg = dev.segments[0]!;
    expect(seg.kind).toBe("baseline_worked");
    expect(seg.counts_to_planned).toBe(true);
    expect(seg.planned_delta_hours).toBe(8);
    expect(seg.counts_to_change).toBe(false);
    expect(dev.planned_hours).toBe(8);
    expect(dev.scope_change_hours).toBe(0);
  });

  it("planning: a non-developer (tester) holder produces no segment at all", () => {
    const t = ticket({
      wp_op_id: 302,
      estimate_hours: 6,
      done_bucket: "not_done",
      assignee_intervals: [iv(302, TESTER, ANCHOR, null)],
      logged_by_developer: {},
    });
    const out = run(
      [t],
      roleMap([[TESTER, "tester"]]),
      [TESTER],
      { sprint_status: "planning" },
    );
    expect(out).toHaveLength(0);
  });

  it("planning: never emits handoff/removed/acquired/idle/churned even with prior reassignment history", () => {
    const t = ticket({
      wp_op_id: 303,
      estimate_hours: 12,
      done_bucket: "not_done",
      assignee_intervals: [
        iv(303, DEV_B, ANCHOR, "2026-06-02T00:00:00Z"),
        iv(303, DEV_A, "2026-06-02T00:00:00Z", null),
      ],
      logged_by_developer: {},
    });
    const out = run(
      [t],
      roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]),
      [DEV_A, DEV_B],
      { sprint_status: "planning" },
    );
    const a = out.find((d) => d.name === "Dev A")!;
    const b = out.find((d) => d.name === "Dev B");
    expect(a.segments).toHaveLength(1);
    expect(a.segments[0]!.kind).toBe("baseline_worked");
    expect(a.planned_hours).toBe(12);
    expect(b).toBeUndefined(); // former holder, no longer current → nothing in planning
  });

  it("omitted sprint_status still runs the full active/closed model (backward compatible)", () => {
    const t = ticket({
      wp_op_id: 304,
      estimate_hours: 10,
      done_bucket: "not_done",
      assignee_intervals: [iv(304, DEV_A, ANCHOR, null)],
      logged_by_developer: {},
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    // Increment 26: a held baseline ticket with no log is green baseline_worked
    // in the active/closed model too (former baseline_idle merged in).
    expect(dev.segments[0]!.kind).toBe("baseline_worked");
  });
});

/**
 * Increment 30 — `Planned` is CURRENT SCOPE, computed ONCE in
 * `plannedScope.ts` and read by Capacity / Closure / Sprint detail / PDF
 * (`docs/CAPACITY_BAR_RULES.md` §5, invariants 7–9).
 *
 * `INCREMENT_30_CONTRACTS.md` §2a predicted ONE residual between the canonical
 * number and `Σ planned_delta_hours` (the segment annotation) and asked for it to
 * be MEASURED rather than papered over. Measuring found TWO, both pinned below
 * with real numbers. In both, the canonical value is the correct one and wins.
 */
describe("Increment 30 — canonical Planned vs the segment annotation (measured residuals)", () => {
  it("RESIDUAL 1 (predicted): acquired uses the estimate AT ACQUISITION, Planned uses the LIVE estimate — 24 vs 15, a 9 h gap", () => {
    // One ticket, acquired mid-sprint at 15 h, since re-estimated to 24 h, still
    // held and worked by the same developer.
    const t = ticket({
      wp_op_id: 900,
      estimate_hours: 24, // live effectiveEstimate today
      estimate_at_acquisition: { "2026-06-06T00:00:00Z": 15 },
      in_baseline_scope: false,
      done_bucket: "not_done",
      assignee_intervals: [iv(900, DEV_A, "2026-06-06T00:00:00Z", null)],
      logged_by_developer: { [keyOf(DEV_A)]: 6 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    const seg = dev.segments[0]!;
    expect(seg.kind).toBe("acquired");
    expect(seg.estimate_hours, "the RED BAR keeps its acquisition-time length").toBe(15);
    expect(seg.planned_delta_hours, "the annotation follows the bar").toBe(15);
    // The displayed number is today's commitment, not the reconstructed history.
    expect(dev.planned_hours, "Planned is the LIVE estimate of what he holds now").toBe(24);
    expect(dev.planned_hours - seg.planned_delta_hours, "measured residual").toBe(9);
  });

  it("RESIDUAL 2 (NOT predicted by §2a): a multi-hop ticket leaves an `acquired` segment on a developer who no longer holds it", () => {
    // A (baseline) → B works on it → B passes it to C, who also works on it.
    // Both B and C end up with `acquired` segments (each logged), but only C
    // holds it now, so only C is on the hook for its 12 h.
    const t = ticket({
      wp_op_id: 901,
      estimate_hours: 12,
      in_baseline_scope: true,
      done_bucket: "not_done",
      assignee_intervals: [
        iv(901, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"),
        iv(901, DEV_B, "2026-06-03T00:00:00Z", "2026-06-07T00:00:00Z"),
        iv(901, DEV_C, "2026-06-07T00:00:00Z", null),
      ],
      logged_by_developer: { [keyOf(DEV_B)]: 5, [keyOf(DEV_C)]: 4 },
    });
    const out = run(
      [t],
      roleMap([[DEV_A, "developer"], [DEV_B, "developer"], [DEV_C, "developer"]]),
      [DEV_A, DEV_B, DEV_C],
    );
    const a = out.find((d) => d.name === "Dev A")!;
    const b = out.find((d) => d.name === "Dev B")!;
    const c = out.find((d) => d.name === "Dev C")!;
    expect(a.segments[0]!.kind).toBe("handoff");
    expect(b.segments[0]!.kind).toBe("acquired");
    expect(c.segments[0]!.kind).toBe("acquired");
    // Under §2a's kind table the annotation said "current scope" on BOTH B and C
    // — 12 + 12 = 24 for a 12 h ticket. §2c's holder-derived rule DISSOLVES that:
    // only C holds it, so only C's segment annotates. The kinds and the bar
    // lengths are unchanged; B still shows a red `acquired` bar 12 h long for the
    // work he really did, it just no longer claims to be his current scope.
    expect(b.segments[0]!.counts_to_planned).toBe(false);
    expect(b.segments[0]!.planned_delta_hours).toBe(0);
    expect(b.segments[0]!.estimate_hours, "B's red bar keeps its length").toBe(12);
    expect(c.segments[0]!.counts_to_planned).toBe(true);
    expect(c.segments[0]!.planned_delta_hours).toBe(12);
    expect(a.planned_hours, "sender: not current scope").toBe(0);
    expect(b.planned_hours, "middle hop: passed it on, not current scope").toBe(0);
    expect(c.planned_hours, "current holder carries the full 12 h").toBe(12);
    // INVARIANT 8, structurally: the ticket is counted exactly ONCE across rows —
    // now in BOTH the canonical numbers and the segment annotations.
    expect(a.planned_hours + b.planned_hours + c.planned_hours).toBe(12);
    expect(
      out.reduce((s, d) => s + d.segments.reduce((t, x) => t + x.planned_delta_hours, 0), 0),
      "§2c: Σ planned_delta_hours no longer double-counts a multi-hop ticket",
    ).toBe(12);
  });

  it("§2c: `counts_to_planned` follows the HOLDER, not the kind — the same green kind annotates differently", () => {
    // Two identical `baseline_worked` segments on the same developer. One ticket
    // he still holds; the other he developed and handed to a tester. Same kind,
    // same colour, same bar length — opposite annotations, because Planned asks
    // "who holds it NOW" and the kind cannot answer that.
    const retained = ticket({
      wp_op_id: 920,
      estimate_hours: 11,
      assignee_intervals: [iv(920, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 3 },
    });
    const withTester = ticket({
      wp_op_id: 921,
      estimate_hours: 13,
      done_bucket: "done",
      assignee_intervals: [
        iv(921, DEV_A, ANCHOR, "2026-06-05T00:00:00Z"),
        iv(921, TESTER, "2026-06-05T00:00:00Z", null),
      ],
      logged_by_developer: { [keyOf(DEV_A)]: 9 },
    });
    const dev = run(
      [retained, withTester],
      roleMap([[DEV_A, "developer"], [TESTER, "tester"]]),
      [DEV_A, TESTER],
    )[0]!;
    const kept = dev.segments.find((s) => s.wp_op_id === 920)!;
    const gone = dev.segments.find((s) => s.wp_op_id === 921)!;
    expect(kept.kind).toBe("baseline_worked");
    expect(gone.kind).toBe("baseline_worked"); // SAME kind
    expect(kept.estimate_hours).toBe(11);
    expect(gone.estimate_hours).toBe(13); // SAME full bar length
    expect(kept.counts_to_planned).toBe(true);
    expect(gone.counts_to_planned).toBe(false); // DIFFERENT annotation
    // The header the user reads equals the rows they can see (invariant 8), and
    // Baseline still carries both tickets (invariant: Baseline ≠ Planned).
    expect(dev.planned_hours).toBe(11);
    expect(dev.segments.reduce((s, x) => s + x.planned_delta_hours, 0)).toBe(11);
    expect(dev.baseline_hours).toBe(24);
  });

  it("INVARIANT 7: a removal, an addition and a handoff each move Planned immediately", () => {
    const retained = ticket({
      wp_op_id: 910,
      estimate_hours: 6,
      assignee_intervals: [iv(910, DEV_A, ANCHOR, null)],
    });
    const handedAway = ticket({
      wp_op_id: 911,
      estimate_hours: 7,
      assignee_intervals: [iv(911, DEV_A, ANCHOR, "2026-06-04T00:00:00Z"), iv(911, DEV_B, "2026-06-04T00:00:00Z", null)],
    });
    const droppedToUnassigned = ticket({
      wp_op_id: 912,
      estimate_hours: 9,
      assignee_intervals: [iv(912, DEV_A, ANCHOR, "2026-06-04T00:00:00Z"), iv(912, null, "2026-06-04T00:00:00Z", null)],
    });
    const addedMidSprint = ticket({
      wp_op_id: 913,
      estimate_hours: 4,
      in_baseline_scope: false,
      assignee_intervals: [iv(913, DEV_A, "2026-06-05T00:00:00Z", null)],
    });
    const out = run(
      [retained, handedAway, droppedToUnassigned, addedMidSprint],
      roleMap([[DEV_A, "developer"], [DEV_B, "developer"]]),
      [DEV_A, DEV_B],
    );
    const a = out.find((d) => d.name === "Dev A")!;
    const b = out.find((d) => d.name === "Dev B")!;
    // A: retained 6 + added 4 = 10. The handed-away 7 left immediately, the
    // dropped 9 left immediately. Baseline (Increment 38: signed up for at
    // activation) keeps all three baseline tickets: 6 + 7 + 9 = 22.
    expect(a.planned_hours).toBe(10);
    expect(a.baseline_hours).toBe(22);
    // B: received the 7 h handoff and nothing else; none of it is B's baseline.
    expect(b.planned_hours).toBe(7);
    expect(b.baseline_hours).toBe(0);
    // INVARIANT 9: Baseline + ±Change balances; Planned + ±Change would not.
    expect(a.baseline_hours + a.scope_change_hours, "22 baseline − 9 removed").toBe(13);
  });
});

describe("developerSegments — Increment 34 §1: Delivered = burned remaining (engine level)", () => {
  it("an OPEN ticket with a positive burn is credited to the window's max logger", () => {
    const t = ticket({
      wp_op_id: 9401,
      estimate_hours: 150,
      done_bucket: "not_done",
      remaining_start_hours: 150,
      remaining_end_hours: 100,
      assignee_intervals: [iv(9401, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 50 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.delivered_hours, "burned 150→100 = 50h, all logged by Dev A").toBe(50);
  });

  it("an OPEN ticket with no logger falls back to the CURRENT holder", () => {
    const t = ticket({
      wp_op_id: 9402,
      estimate_hours: 20,
      done_bucket: "not_done",
      remaining_start_hours: 20,
      remaining_end_hours: 5, // burned 15h, but nobody logged it this window
      in_baseline_scope: false,
      assignee_intervals: [iv(9402, DEV_A, ANCHOR, null)],
      logged_by_developer: {},
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.delivered_hours, "no logger → current holder still gets credit").toBe(15);
  });

  it("an OPEN ticket burned but neither logged nor currently held is DROPPED (admit, don't infer)", () => {
    const t = ticket({
      wp_op_id: 9403,
      estimate_hours: 20,
      done_bucket: "not_done",
      remaining_start_hours: 20,
      remaining_end_hours: 5,
      in_baseline_scope: false,
      // Held by DEV_A in the past, now unassigned — nobody logged this window.
      assignee_intervals: [iv(9403, DEV_A, ANCHOR, "2026-06-03T00:00:00Z"), iv(9403, null, "2026-06-03T00:00:00Z", null)],
      logged_by_developer: {},
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    // Dev A is still `seen` (they held the ticket earlier — a `removed`/other
    // segment), but delivered_hours must be 0 — nobody currently qualifies.
    expect(dev.delivered_hours).toBe(0);
  });

  it("a re-estimate UP mid-sprint clamps burned remaining at 0, never negative (invariant 11)", () => {
    const t = ticket({
      wp_op_id: 9404,
      estimate_hours: 30,
      done_bucket: "not_done",
      remaining_start_hours: 10, // started with only 10h remaining...
      remaining_end_hours: 25, // ...then re-estimated UP to 25h remaining
      assignee_intervals: [iv(9404, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 3 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.delivered_hours, "remStart 10 < remEnd 25 → clamped at 0, never negative").toBe(0);
  });

  it("a DONE ticket's credited amount is burned remaining, not the flat estimate, when remaining inputs are supplied", () => {
    const t = ticket({
      wp_op_id: 9405,
      estimate_hours: 150,
      done_bucket: "done",
      remaining_start_hours: 100, // this developer only had 100h left to burn...
      remaining_end_hours: 0, // ...and finished it (done → remEnd forced 0)
      assignee_intervals: [iv(9405, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 40 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    // NOT 150 (the flat estimate) — the ticket only had 100h left at this
    // sprint's start, so this sprint delivers exactly that, not the whole
    // ticket (a multi-sprint ticket's earlier sprint already delivered 50h).
    expect(dev.delivered_hours).toBe(100);
  });

  it("single-sprint reduction stays byte-identical when remaining inputs are OMITTED (invariant 11)", () => {
    // No remaining_start_hours/remaining_end_hours at all — the OLD literal
    // algorithm applies: a done ticket delivers its estimate-of-record.
    const t = ticket({
      wp_op_id: 9406,
      estimate_hours: 8,
      done_bucket: "done",
      assignee_intervals: [iv(9406, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 7 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.delivered_hours).toBe(8);
  });

  it("an OMITTED-inputs OPEN ticket delivers nothing — the pre-Increment-34 behaviour", () => {
    const t = ticket({
      wp_op_id: 9407,
      estimate_hours: 20,
      done_bucket: "not_done",
      assignee_intervals: [iv(9407, DEV_A, ANCHOR, null)],
      logged_by_developer: { [keyOf(DEV_A)]: 12 },
    });
    const dev = run([t], roleMap([[DEV_A, "developer"]]), [DEV_A])[0]!;
    expect(dev.delivered_hours, "no remaining inputs → open tickets never deliver (old rule)").toBe(0);
  });
});
