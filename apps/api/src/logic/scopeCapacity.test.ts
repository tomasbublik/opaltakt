import { describe, expect, it } from "vitest";
import {
  accumulateCapacitySegments,
  currentCommittedHours,
  type CapacitySegmentItemInput,
} from "./scopeCapacity";
import { computeCapacity, type CapacityItemInput } from "./capacity";

// SPEC_05 §2 — the frozen capacity-segment math.

function seg(
  o: Partial<CapacitySegmentItemInput> & { wp_op_id: number },
): CapacitySegmentItemInput {
  return {
    parent_op_id: null,
    assignee_op_id: 10,
    assignee_name: "Ann",
    planned_hours: 5,
    origin: "baseline",
    outcome: "planned",
    ...o,
  };
}

// SPEC_09 §3: every pre-Increment-9 case here omits original_assignee_op_id,
// so the grey redistribution fields stay 0 — asserted alongside the
// pre-existing baseline/added/removed fields in every .toEqual() below.
const NO_GREY = { redistributed_out_hours: 0, redistributed_in_hours: 0 };

describe("accumulateCapacitySegments (SPEC_05 §2)", () => {
  it("attributes baseline / added / removed to the right member", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 10, origin: "baseline" }),
      seg({ wp_op_id: 2, planned_hours: 5, origin: "added_mid_sprint" }),
      seg({ wp_op_id: 3, planned_hours: 4, assignee_op_id: 11, assignee_name: "Bob" }),
    ]);
    expect(m.get(10)).toEqual({ baseline_hours: 10, added_hours: 5, removed_hours: 0, ...NO_GREY });
    expect(m.get(11)).toEqual({ baseline_hours: 4, added_hours: 0, removed_hours: 0, ...NO_GREY });
  });

  it("a baseline ticket removed mid-sprint counts toward BOTH baseline AND removed (frozen)", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 10, origin: "baseline", outcome: "planned" }),
      seg({ wp_op_id: 2, planned_hours: 6, origin: "baseline", outcome: "removed_mid_sprint" }),
    ]);
    // baseline is frozen at activation: still 16, but 6 shows as a reduction.
    expect(m.get(10)).toEqual({ baseline_hours: 16, added_hours: 0, removed_hours: 6, ...NO_GREY });
    expect(currentCommittedHours(m.get(10)!)).toBe(10); // 16 + 0 - 6
  });

  it("an added-then-removed ticket nets to zero (neither red nor blue → no entry)", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 7, origin: "added_mid_sprint", outcome: "removed_mid_sprint" }),
    ]);
    // It bumps nothing, so the member gets no segment entry at all; the caller
    // (computeCapacity) treats a missing entry as 0/0/0.
    expect(m.get(10)).toBeUndefined();
  });

  it("classic 'removed' baseline (planning) is NOT a mid-sprint reduction", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 8, origin: "baseline", outcome: "removed" }),
    ]);
    // Still frozen in baseline, but only removed_mid_sprint drives the blue segment.
    expect(m.get(10)).toEqual({ baseline_hours: 8, added_hours: 0, removed_hours: 0, ...NO_GREY });
  });

  it("groups unassigned work under the 'unassigned' key", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 3, assignee_op_id: null, assignee_name: null }),
    ]);
    expect(m.get("unassigned")).toEqual({ baseline_hours: 3, added_hours: 0, removed_hours: 0, ...NO_GREY });
  });

  it("currentCommittedHours = baseline + added - removed", () => {
    expect(
      currentCommittedHours({ baseline_hours: 16, added_hours: 5, removed_hours: 6, ...NO_GREY }),
    ).toBe(15);
  });

  it("SPEC_09 §3: a reassigned baseline ticket greys the sender AND the receiver, bar stays baseline-length", () => {
    // Jan (10) had 30h baseline; 10h of it (wp2) is reassigned to Daniel (20),
    // who owned nothing at activation.
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 20, assignee_op_id: 10, original_assignee_op_id: 10 }),
      seg({ wp_op_id: 2, planned_hours: 10, assignee_op_id: 20, original_assignee_op_id: 10 }),
    ]);
    const jan = m.get(10)!;
    expect(jan).toEqual({
      baseline_hours: 30,
      added_hours: 0,
      removed_hours: 0,
      redistributed_out_hours: 10,
      redistributed_in_hours: 0,
    });
    expect(currentCommittedHours(jan)).toBe(30); // bar stays baseline-length
    const daniel = m.get(20)!;
    expect(daniel).toEqual({
      baseline_hours: 0,
      added_hours: 0,
      removed_hours: 0,
      redistributed_out_hours: 0,
      redistributed_in_hours: 10,
    });
    expect(currentCommittedHours(daniel)).toBe(10); // pure receiver, no baseline of his own
  });

  it("SPEC_09 §3: a done baseline ticket that stayed with its owner greys WITHOUT a receiver", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 12, assignee_op_id: 10, original_assignee_op_id: 10, is_done: true }),
    ]);
    expect(m.get(10)).toEqual({
      baseline_hours: 12,
      added_hours: 0,
      removed_hours: 0,
      redistributed_out_hours: 12,
      redistributed_in_hours: 0,
    });
    expect(m.size).toBe(1); // no phantom receiver entry
  });

  it("SPEC_09 §3: a baseline ticket removed mid-sprint is NOT also greyed (removed_hours already covers it)", () => {
    const m = accumulateCapacitySegments([
      seg({
        wp_op_id: 1,
        planned_hours: 6,
        assignee_op_id: 10,
        original_assignee_op_id: 10,
        outcome: "removed_mid_sprint",
        is_done: true,
      }),
    ]);
    expect(m.get(10)).toEqual({
      baseline_hours: 6,
      added_hours: 0,
      removed_hours: 6,
      ...NO_GREY,
    });
  });

  it("SPEC_09 §3: omitting original_assignee_op_id opts a caller out of grey tracking entirely", () => {
    const m = accumulateCapacitySegments([
      seg({ wp_op_id: 1, planned_hours: 9, assignee_op_id: 10 }), // no original_assignee_op_id
    ]);
    expect(m.get(10)).toEqual({ baseline_hours: 9, added_hours: 0, removed_hours: 0, ...NO_GREY });
  });
});

describe("computeCapacity segment fields (SPEC_05 §2)", () => {
  const members = [
    { member_id: 1, op_user_id: 10, name: "Ann", available_hours: 40 },
    { member_id: 2, op_user_id: 11, name: "Bob", available_hours: 20 },
  ];
  // Ann: baseline 10 (wp1), baseline-then-removed 6 (wp2), added 5 (wp4). Bob: baseline 4.
  const items: CapacityItemInput[] = [
    { wp_op_id: 1, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 10, origin: "baseline", outcome: "planned" },
    { wp_op_id: 2, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 6, origin: "baseline", outcome: "removed_mid_sprint" },
    { wp_op_id: 4, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 5, origin: "added_mid_sprint", outcome: "planned" },
    { wp_op_id: 3, parent_op_id: null, assignee_op_id: 11, assignee_name: "Bob", planned_hours: 4, origin: "baseline", outcome: "planned" },
  ];

  it("populates baseline/added/removed and current-committed planned_hours per member", () => {
    const res = computeCapacity("per_person", members, items);
    const ann = res.lines.find((l) => l.op_user_id === 10)!;
    expect(ann.baseline_hours).toBe(16);
    expect(ann.added_hours).toBe(5);
    expect(ann.removed_hours).toBe(6);
    expect(ann.planned_hours).toBe(15); // 16 + 5 - 6
    expect(ann.available_hours).toBe(40); // frozen — unchanged by scope changes
    const bob = res.lines.find((l) => l.op_user_id === 11)!;
    expect(bob).toMatchObject({ baseline_hours: 4, added_hours: 0, removed_hours: 0, planned_hours: 4 });
    // Total committed = 15 (Ann) + 4 (Bob).
    expect(res.total_planned_hours).toBe(19);
  });

  it("overloaded flips against current_committed, not available growth", () => {
    // committed(Ann) = 15. Available 20 → not overloaded; available 14 → overloaded.
    const notOver = computeCapacity("per_person", [{ member_id: 1, op_user_id: 10, name: "Ann", available_hours: 20 }], items);
    expect(notOver.lines.find((l) => l.op_user_id === 10)!.overloaded).toBe(false);
    const over = computeCapacity("per_person", [{ member_id: 1, op_user_id: 10, name: "Ann", available_hours: 14 }], items);
    expect(over.lines.find((l) => l.op_user_id === 10)!.overloaded).toBe(true);
  });

  it("has_sprint_work is false for a person whose only item is added-then-removed (net zero)", () => {
    const res = computeCapacity(
      "per_person",
      [{ member_id: 9, op_user_id: 99, name: "Zoe", available_hours: 8 }],
      [
        { wp_op_id: 5, parent_op_id: null, assignee_op_id: 99, assignee_name: "Zoe", planned_hours: 7, origin: "added_mid_sprint", outcome: "removed_mid_sprint" },
      ],
    );
    const zoe = res.lines.find((l) => l.op_user_id === 99)!;
    expect(zoe.planned_hours).toBe(0);
    expect(zoe.has_sprint_work).toBe(false);
    expect(zoe).toMatchObject({ baseline_hours: 0, added_hours: 0, removed_hours: 0 });
  });

  it("planning items (no origin/outcome) behave exactly as pre-Increment-5", () => {
    const res = computeCapacity("per_person", members, [
      { wp_op_id: 1, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 30 },
      { wp_op_id: 2, parent_op_id: null, assignee_op_id: 11, assignee_name: "Bob", planned_hours: 10 },
    ]);
    const ann = res.lines.find((l) => l.op_user_id === 10)!;
    expect(ann).toMatchObject({ planned_hours: 30, baseline_hours: 30, added_hours: 0, removed_hours: 0, has_sprint_work: true });
    expect(res.total_planned_hours).toBe(40);
  });
});

describe("computeCapacity roster rule (SPEC_10 §c)", () => {
  it("a capacity-only member with available_hours=0 and zero items does NOT appear (no 0h/0h phantom)", () => {
    const res = computeCapacity(
      "per_person",
      [{ member_id: 1, op_user_id: 10, name: "Jan Bily", available_hours: 0 }],
      [],
    );
    expect(res.lines).toHaveLength(0);
    expect(res.total_available_hours).toBe(0);
    expect(res.total_planned_hours).toBe(0);
  });

  it("a capacity-only member with available_hours>0 and zero items DOES appear (declared participant)", () => {
    const res = computeCapacity(
      "per_person",
      [{ member_id: 2, op_user_id: 11, name: "Vojtech Kolar", available_hours: 12 }],
      [],
    );
    expect(res.lines).toHaveLength(1);
    const line = res.lines[0]!;
    expect(line).toMatchObject({
      op_user_id: 11,
      member_id: 2,
      name: "Vojtech Kolar",
      available_hours: 12,
      planned_hours: 0,
      has_sprint_work: false,
      baseline_hours: 0,
      added_hours: 0,
      removed_hours: 0,
      overloaded: false,
    });
    expect(res.total_available_hours).toBe(12);
    expect(res.total_planned_hours).toBe(0);
  });

  it("a member with a real sprint item appears regardless of any capacity row", () => {
    // No capacity rows at all, but an assigned item → a line (available 0).
    const res = computeCapacity("per_person", [], [
      { wp_op_id: 1, parent_op_id: null, assignee_op_id: 42, assignee_name: "Worker", planned_hours: 5, origin: "baseline", outcome: "planned" },
    ]);
    const line = res.lines.find((l) => l.op_user_id === 42)!;
    expect(line).toMatchObject({ name: "Worker", available_hours: 0, planned_hours: 5, has_sprint_work: true });
  });

  it("mixes participants and skips a 0h/0h non-participant in the same sprint", () => {
    const res = computeCapacity(
      "per_person",
      [
        { member_id: 1, op_user_id: 10, name: "Ann", available_hours: 20 }, // has an item
        { member_id: 2, op_user_id: 11, name: "Bob", available_hours: 8 }, // capacity-only, avail>0 → shows
        { member_id: 3, op_user_id: 12, name: "Ghost", available_hours: 0 }, // 0h/0h, no item → hidden
      ],
      [{ wp_op_id: 1, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 10, origin: "baseline", outcome: "planned" }],
    );
    const ids = res.lines.map((l) => l.op_user_id).sort();
    expect(ids).toEqual([10, 11]);
    expect(res.lines.find((l) => l.op_user_id === 12)).toBeUndefined();
  });

  it("a baseline owner fully reassigned away still gets a line with grey redistributed_out (roster union of segments, no capacity row)", () => {
    // wp1 (10h, baseline) was originally owned by user 10 but is now assigned to
    // user 20. User 10 owns ZERO current items AND has NO capacity row, yet must
    // still show a line so their redistributed_out grey segment can render —
    // this proves the roster now unions segmentsByAssignee.keys(), not just
    // current assignees (SPEC_09 §3 gap called out in the SPEC_10 §c note).
    const res = computeCapacity(
      "per_person",
      [], // deliberately no capacity rows for anyone
      [
        {
          wp_op_id: 1,
          parent_op_id: null,
          assignee_op_id: 20,
          assignee_name: "Bob",
          planned_hours: 10,
          origin: "baseline",
          outcome: "planned",
          original_assignee_op_id: 10, // user 10 was the original owner (o_t)
          is_done: false,
        },
      ],
    );
    const orig = res.lines.find((l) => l.op_user_id === 10)!;
    expect(orig, "fully-reassigned original owner still gets a line").toBeDefined();
    expect(orig.baseline_hours).toBe(10);
    expect(orig.redistributed_out_hours).toBe(10);
    expect(orig.available_hours).toBe(0); // no capacity row
    // Increment 30 (CAPACITY_BAR_RULES.md §5 + invariants 7–8) — Planned is
    // CURRENT SCOPE, so the fully-reassigned original owner is on the hook for
    // nothing: 10 → 0. Their line, their frozen `baseline_hours` and their grey
    // `redistributed_out` segment are all still here (the bar is unchanged), it
    // is only the NUMBER that moved.
    //
    // This was a genuine double-count, not a cosmetic change: the old value came
    // from `currentCommittedHours` = baseline + added − removed + redistributed_in,
    // which never subtracts `redistributed_out`. The same 10 h therefore sat in
    // BOTH lines (10 at the sender as baseline, 10 at Bob as redistributed_in),
    // and `total_planned_hours` counted a one-ticket sprint as 20 h.
    expect(orig.planned_hours).toBe(0);
    // Bob is the current holder and received the redistributed hours.
    const bob = res.lines.find((l) => l.op_user_id === 20)!;
    expect(bob.redistributed_in_hours).toBe(10);
    expect(bob.planned_hours).toBe(10); // the ticket counts exactly once, on its holder
    // Invariant 8: the aggregate is reproducible by adding up the visible rows.
    expect(res.total_planned_hours).toBe(10); // was 20 before Increment 30
    expect(res.total_planned_hours).toBe(res.lines.reduce((s, l) => s + l.planned_hours, 0));
  });

  // SPEC_11 §5a — the reported "Jan Bílý gets NO bar" bug. A baseline ticket
  // owned by X at activation, reassigned to Y (who has ZERO other sprint
  // involvement), must give Y a capacity LINE with a GREY redistributed_in
  // segment AND a real name — never a missing bar, never a fabricated
  // "User <id>". This proves the line generation is NOT gated on baseline
  // membership: Y appears via the roster union (current assignee + segment
  // receiver), so the fix is purely name-resolution, not line-generation.
  it("SPEC_11 §5a: a reassignment recipient with no other work still gets a grey bar + a real name", () => {
    const res = computeCapacity(
      "per_person",
      [], // no capacity rows — Y (the recipient) is a pure segment receiver
      [
        {
          wp_op_id: 11762,
          parent_op_id: null,
          // Current assignee is Jan Bílý (op id 63) — reassigned FROM Daniel
          // Brabec (op id 20, the frozen original owner o_t).
          assignee_op_id: 63,
          assignee_name: "Jan Bílý",
          planned_hours: 12,
          origin: "baseline",
          outcome: "planned",
          original_assignee_op_id: 20,
          is_done: false,
        },
      ],
    );
    const jan = res.lines.find((l) => l.op_user_id === 63)!;
    expect(jan, "reassignment recipient must get a capacity line").toBeDefined();
    expect(jan.redistributed_in_hours).toBe(12); // the grey bar
    expect(jan.planned_hours).toBe(12); // committed = redistributed_in
    expect(jan.has_sprint_work).toBe(true);
    expect(jan.name).toBe("Jan Bílý"); // real name from the current WP assignee
    expect(jan.name).not.toMatch(/^User \d+$/); // NEVER fabricated

    // The original owner (Daniel, id 20) still shows his grey redistributed_out;
    // with no current WP + no capacity row his name comes from the resolved map
    // (SPEC_11 §4) — not a fabricated "User 20".
    const resNamed = computeCapacity(
      "per_person",
      [],
      [
        {
          wp_op_id: 11762,
          parent_op_id: null,
          assignee_op_id: 63,
          assignee_name: "Jan Bílý",
          planned_hours: 12,
          origin: "baseline",
          outcome: "planned",
          original_assignee_op_id: 20,
          is_done: false,
        },
      ],
      new Map([[20, "Daniel Brabec"]]),
    );
    const daniel = resNamed.lines.find((l) => l.op_user_id === 20)!;
    expect(daniel.redistributed_out_hours).toBe(12);
    expect(daniel.name).toBe("Daniel Brabec");
    expect(daniel.name).not.toMatch(/^User \d+$/);
  });

  // SPEC_11 §4 — with NO resolved name available, an unnamed segment-only owner
  // is labelled readably ("Unknown user (<id>)"), never "User <id>".
  it("SPEC_11 §4: an unresolvable roster id is 'Unknown user (<id>)', never 'User <id>'", () => {
    const res = computeCapacity(
      "per_person",
      [],
      [
        {
          wp_op_id: 1,
          parent_op_id: null,
          assignee_op_id: 63,
          assignee_name: "Jan Bílý",
          planned_hours: 8,
          origin: "baseline",
          outcome: "planned",
          original_assignee_op_id: 18, // owner with no name anywhere
          is_done: false,
        },
      ],
    );
    const owner = res.lines.find((l) => l.op_user_id === 18)!;
    expect(owner.name).toBe("Unknown user (18)");
    expect(owner.name).not.toBe("User 18");
  });
});
