import { describe, expect, it } from "vitest";
import type { BurndownSnapshot, DoneStatusRule } from "@osp/contracts";
import { ancestorDoubleCounts, leafEffort } from "./doubleCounting";
import { classifyStatus, isDone } from "./done";
import { computeCapacity } from "./capacity";
import { buildBurndown, idealCurve, workingDays } from "./burndown";
import { computeVelocity } from "./velocity";
import { buildClosureSplit, buildVersionDeepLink } from "./closure";

// (estimate-of-record resolution now lives in ./estimate.test.ts — SPEC_16 §5.)

describe("double counting (leaf-level sum)", () => {
  it("drops parents whose child is present; sums leaves only", () => {
    const r = leafEffort([
      { wp_op_id: 1, parent_op_id: null, hours: 10 }, // parent of 2 → dropped
      { wp_op_id: 2, parent_op_id: 1, hours: 4 }, // leaf
      { wp_op_id: 3, parent_op_id: null, hours: 6 }, // leaf (no child in set)
    ]);
    expect(r.total).toBe(10); // 4 + 6, NOT 10+4+6=20
    expect(r.leaves.map((l) => l.wp_op_id).sort()).toEqual([2, 3]);
    expect(r.warnings).toEqual([{ parent_op_id: 1, child_op_ids: [2] }]);
  });
});

// Increment 28 (INCREMENT_28_CONTRACTS §2a) — ancestor-aware detection, DISPLAY
// only. Deliberately a separate function: leafEffort's direct-parent-only
// traversal (tested above) must keep every existing total unchanged (§2b).
describe("ancestorDoubleCounts (Increment 28 §2a)", () => {
  it("links a direct parent/child pair, both directions", () => {
    const r = ancestorDoubleCounts([
      { wp_op_id: 1001, parent_op_id: null },
      { wp_op_id: 1002, parent_op_id: 1001 },
    ]);
    expect(r.get(1001)).toEqual({ double_count_children: [1002], double_count_parent_of: null });
    expect(r.get(1002)).toEqual({ double_count_children: [], double_count_parent_of: 1001 });
  });

  it("handles many children per parent and several independent groups", () => {
    const r = ancestorDoubleCounts([
      { wp_op_id: 11165, parent_op_id: null },
      { wp_op_id: 11811, parent_op_id: 11165 },
      { wp_op_id: 11810, parent_op_id: 11165 },
      { wp_op_id: 200, parent_op_id: null },
      { wp_op_id: 201, parent_op_id: 200 },
      { wp_op_id: 900, parent_op_id: null }, // unrelated, no collision
    ]);
    expect(r.get(11165)?.double_count_children).toEqual([11810, 11811]); // sorted
    expect(r.get(200)?.double_count_children).toEqual([201]);
    expect(r.get(900)).toEqual({ double_count_children: [], double_count_parent_of: null });
  });

  it("walks chains deeper than two: a grandparent lists BOTH descendants, the grandchild names its NEAREST ancestor", () => {
    const r = ancestorDoubleCounts([
      { wp_op_id: 1, parent_op_id: null },
      { wp_op_id: 2, parent_op_id: 1 },
      { wp_op_id: 3, parent_op_id: 2 },
    ]);
    expect(r.get(1)?.double_count_children).toEqual([2, 3]);
    expect(r.get(2)).toEqual({ double_count_children: [3], double_count_parent_of: 1 });
    expect(r.get(3)?.double_count_parent_of).toBe(2); // nearest, not 1
  });

  it("links grandparent ↔ grandchild when the INTERMEDIATE ticket is not in the sprint", () => {
    // 3's parent (2) is absent from the sprint; the edge 2→1 comes from the
    // work_package_cache lookup, never from a new OP call.
    const r = ancestorDoubleCounts(
      [
        { wp_op_id: 1, parent_op_id: null },
        { wp_op_id: 3, parent_op_id: 2 },
      ],
      new Map([[2, 1]]),
    );
    expect(r.get(1)?.double_count_children).toEqual([3]);
    expect(r.get(3)?.double_count_parent_of).toBe(1);
  });

  it("reports nothing when the absent intermediate leads nowhere", () => {
    const r = ancestorDoubleCounts(
      [
        { wp_op_id: 1, parent_op_id: null },
        { wp_op_id: 3, parent_op_id: 2 },
      ],
      new Map([[2, null]]),
    );
    expect(r.get(1)?.double_count_children).toEqual([]);
    expect(r.get(3)?.double_count_parent_of).toBeNull();
  });

  it("survives a cyclic parent chain (malformed OP data must not hang)", () => {
    const r = ancestorDoubleCounts([
      { wp_op_id: 1, parent_op_id: 2 },
      { wp_op_id: 2, parent_op_id: 1 },
      { wp_op_id: 3, parent_op_id: 3 }, // self-parent
    ]);
    expect(r.get(1)?.double_count_parent_of).toBe(2);
    expect(r.get(2)?.double_count_parent_of).toBe(1);
    expect(r.get(3)).toEqual({ double_count_children: [], double_count_parent_of: null });
  });

  it("an out-of-sprint cycle above the item also terminates", () => {
    const r = ancestorDoubleCounts([{ wp_op_id: 5, parent_op_id: 90 }], new Map([[90, 91], [91, 90]]));
    expect(r.get(5)).toEqual({ double_count_children: [], double_count_parent_of: null });
  });
});

describe("done classification", () => {
  const rules: DoneStatusRule[] = [
    { id: 1, sprint_id: 1, status_name: "Rejected", counts_as: "rejected" },
    { id: 2, sprint_id: 1, status_name: "Deployed", counts_as: "done" },
  ];
  it("rejected rule beats closed; done rule promotes an open status; default closed→done", () => {
    expect(classifyStatus({ status_name: "Rejected", status_is_closed: true }, rules)).toBe("rejected");
    expect(classifyStatus({ status_name: "Deployed", status_is_closed: false }, rules)).toBe("done");
    expect(classifyStatus({ status_name: "Closed", status_is_closed: true }, rules)).toBe("done");
    expect(classifyStatus({ status_name: "In progress", status_is_closed: false }, rules)).toBe("open");
    expect(isDone({ status_name: "Closed", status_is_closed: true }, [])).toBe(true);
    expect(isDone({ status_name: "Rejected", status_is_closed: true }, rules)).toBe(false);
  });

  // Consolidation Round (Concept 3): status_name is compared case-insensitively
  // + trimmed (shared statusNamesEqual), not raw `===`. A persisted status whose
  // casing/whitespace differs from the rule's stored spelling must still match —
  // the Increment-21 casing-divergence bug pattern, previously live here.
  it("matches done/rejected rules by trimmed, case-insensitive status_name", () => {
    const caseRules: DoneStatusRule[] = [
      { id: 1, sprint_id: 1, status_name: "Closed", counts_as: "done" },
      { id: 2, sprint_id: 1, status_name: "Rejected", counts_as: "rejected" },
    ];
    // Rule says "Closed", cache says "closed " (lower-case + trailing space).
    expect(classifyStatus({ status_name: "closed ", status_is_closed: false }, caseRules)).toBe("done");
    expect(isDone({ status_name: "closed ", status_is_closed: false }, caseRules)).toBe(true);
    // Rejected rule still wins over a closed status regardless of casing.
    expect(classifyStatus({ status_name: "  REJECTED", status_is_closed: true }, caseRules)).toBe("rejected");
    expect(isDone({ status_name: "  REJECTED", status_is_closed: true }, caseRules)).toBe(false);
  });
});

describe("capacity occupancy", () => {
  it("per-assignee load, overload flag, unassigned bucket, aggregate totals", () => {
    const res = computeCapacity(
      "per_person",
      [
        { member_id: 1, op_user_id: 10, name: "Ann", available_hours: 40 },
        { member_id: 2, op_user_id: 11, name: "Bob", available_hours: 20 },
      ],
      [
        { wp_op_id: 1, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 30 },
        { wp_op_id: 2, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 20 },
        { wp_op_id: 3, parent_op_id: null, assignee_op_id: 11, assignee_name: "Bob", planned_hours: 10 },
        { wp_op_id: 4, parent_op_id: null, assignee_op_id: null, assignee_name: null, planned_hours: 5 },
      ],
    );
    const ann = res.lines.find((l) => l.op_user_id === 10)!;
    const bob = res.lines.find((l) => l.op_user_id === 11)!;
    const unassigned = res.lines.find((l) => l.op_user_id === null && l.member_id === null)!;
    expect(ann.planned_hours).toBe(50);
    expect(ann.overloaded).toBe(true);
    expect(bob.planned_hours).toBe(10);
    expect(bob.overloaded).toBe(false);
    expect(unassigned.planned_hours).toBe(5);
    expect(res.total_available_hours).toBe(60);
    expect(res.total_planned_hours).toBe(65);
  });

  it("SPEC_10 §c roster: capacity-set participants (available>0) appear; work stays under its current assignee", () => {
    const res = computeCapacity(
      "per_person",
      [
        // SPEC_10 §4 #2: capacity EXPLICITLY set for this sprint (available>0) is
        // a declared participant → shows with 0 planned (NOT a 0h/0h phantom).
        { member_id: 1, op_user_id: 200, name: "Alan Turing", available_hours: 56 },
        { member_id: 2, op_user_id: 201, name: "Grace Hopper", available_hours: 4 },
        // Zbynek is both an assignee and has saved availability.
        { member_id: 3, op_user_id: 101, name: "Zbynek", available_hours: 40 },
      ],
      [
        { wp_op_id: 1, parent_op_id: null, assignee_op_id: 100, assignee_name: "Cameron Dalby", planned_hours: 24 },
        { wp_op_id: 2, parent_op_id: null, assignee_op_id: 100, assignee_name: "Cameron Dalby", planned_hours: 12 },
        { wp_op_id: 3, parent_op_id: null, assignee_op_id: 101, assignee_name: "Zbynek", planned_hours: 30 },
      ],
    );
    // Capacity-set participants appear (available>0), with 0 planned + no work.
    const alan = res.lines.find((l) => l.op_user_id === 200)!;
    expect(alan).toMatchObject({ name: "Alan Turing", available_hours: 56, planned_hours: 0, has_sprint_work: false });
    const grace = res.lines.find((l) => l.op_user_id === 201)!;
    expect(grace).toMatchObject({ name: "Grace Hopper", available_hours: 4, planned_hours: 0, has_sprint_work: false });
    // Cameron's 36h shows under Cameron — not mis-attributed to a member name.
    const chris = res.lines.find((l) => l.op_user_id === 100)!;
    expect(chris.name).toBe("Cameron Dalby");
    expect(chris.planned_hours).toBe(36);
    expect(chris.available_hours).toBe(0); // no saved capacity row
    expect(res.lines.find((l) => l.op_user_id === 101)!.available_hours).toBe(40);
    expect(res.total_planned_hours).toBe(66);
    expect(res.total_available_hours).toBe(100); // 56 (Alan) + 4 (Grace) + 40 (Zbynek)
  });

  it("leaf-level: parent with in-sprint child does not inflate assignee load", () => {
    const res = computeCapacity(
      "per_person",
      [{ member_id: 1, op_user_id: 10, name: "Ann", available_hours: 40 }],
      [
        { wp_op_id: 5, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 8 },
        { wp_op_id: 6, parent_op_id: 5, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 3 },
      ],
    );
    expect(res.total_planned_hours).toBe(3);
    expect(res.lines.find((l) => l.op_user_id === 10)!.planned_hours).toBe(3);
  });
});

describe("burndown math", () => {
  it("working days skip weekends (Mon 2026-06-01 .. Sun 2026-06-14 → 10 days)", () => {
    const days = workingDays("2026-06-01", "2026-06-14");
    expect(days).toHaveLength(10);
    expect(days[0]).toBe("2026-06-01");
    expect(days[days.length - 1]).toBe("2026-06-12");
    expect(days).not.toContain("2026-06-06"); // Saturday
    expect(days).not.toContain("2026-06-07"); // Sunday
  });

  it("ideal curve is linear from total to 0 across working days", () => {
    const ideal = idealCurve(80, 10);
    expect(ideal[0]).toBe(80);
    expect(ideal[9]).toBe(0);
    expect(ideal[1]).toBeCloseTo((80 * 8) / 9, 6); // 71.111...
    expect(ideal[4]).toBeCloseTo((80 * 5) / 9, 6); // 44.444...
    expect(idealCurve(80, 1)).toEqual([0]);
  });

  it("buildBurndown maps snapshots to working days; future days are null", () => {
    const snapshots: BurndownSnapshot[] = [
      { id: 1, sprint_id: 7, snapshot_date: "2026-06-01", remaining_hours: 80, logged_hours: 0, ideal_hours: 80, done_count: 0, total_count: 5, source: "live" },
      { id: 2, sprint_id: 7, snapshot_date: "2026-06-02", remaining_hours: 64, logged_hours: 16, ideal_hours: 71.11, done_count: 1, total_count: 5, source: "live" },
    ];
    const res = buildBurndown(
      { id: 7, start_date: "2026-06-01", end_date: "2026-06-14" },
      80,
      snapshots,
    );
    expect(res.total_planned_hours).toBe(80);
    expect(res.points).toHaveLength(10);
    expect(res.points[0]).toMatchObject({ date: "2026-06-01", ideal_hours: 80, remaining_hours: 80, logged_hours: 0 });
    expect(res.points[1]).toMatchObject({ date: "2026-06-02", remaining_hours: 64, logged_hours: 16, done_count: 1 });
    expect(res.points[2]!.remaining_hours).toBeNull(); // 2026-06-03, no snapshot
    expect(res.points[2]!.logged_hours).toBeNull();
  });
});

describe("velocity", () => {
  it("averages completed hours over the last N closed sprints (newest first)", () => {
    const res = computeVelocity(
      [
        { sprint_id: 4, name: "S4", end_date: "2026-06-28", planned_hours: 70, completed_hours: 40, by_connection: [] },
        { sprint_id: 3, name: "S3", end_date: "2026-06-14", planned_hours: 70, completed_hours: 50, by_connection: [] },
        { sprint_id: 2, name: "S2", end_date: "2026-05-31", planned_hours: 70, completed_hours: 60, by_connection: [] },
        { sprint_id: 1, name: "S1", end_date: "2026-05-17", planned_hours: 70, completed_hours: 90, by_connection: [] },
      ],
      3,
    );
    expect(res.window).toBe(3);
    expect(res.average_completed_hours).toBe(50); // (40+50+60)/3
    expect(res.recommended_capacity_hours).toBe(50);
    expect(res.history).toHaveLength(3);
  });

  it("returns nulls with no closed sprints", () => {
    const res = computeVelocity([], 3);
    expect(res.window).toBe(0);
    expect(res.average_completed_hours).toBeNull();
    expect(res.recommended_capacity_hours).toBeNull();
  });
});

describe("closure report + version deep-link", () => {
  it("splits done/not-done, sums completed hours, offers not-done to carry", () => {
    const rules: DoneStatusRule[] = [
      { id: 1, sprint_id: 1, status_name: "Rejected", counts_as: "rejected" },
    ];
    const split = buildClosureSplit(
      [
        { wp_op_id: 1, subject: "A", status_name: "Closed", status_is_closed: true, assignee_name: "Ann", planned_hours: 8, remaining_hours: 0, version_name: "v1" },
        { wp_op_id: 2, subject: "B", status_name: "In progress", status_is_closed: false, assignee_name: "Bob", planned_hours: 5, remaining_hours: 5, version_name: "v1" },
        { wp_op_id: 3, subject: "C", status_name: "Rejected", status_is_closed: true, assignee_name: null, planned_hours: 3, remaining_hours: 0, version_name: "v1" },
      ],
      rules,
    );
    expect(split.done.map((d) => d.wp_op_id)).toEqual([1]);
    expect(split.not_done.map((d) => d.wp_op_id).sort()).toEqual([2, 3]);
    expect(split.completed_hours).toBe(8);
    expect(split.version_change).toEqual(split.not_done);
  });

  it("builds a URL-encoded OP deep-link filtered on the ids", () => {
    const link = buildVersionDeepLink("https://op.example.com/", "myproj", [3, 7]);
    expect(link.startsWith("https://op.example.com/projects/myproj/work_packages?query_props=")).toBe(true);
    const encoded = link.split("query_props=")[1]!;
    const decoded = JSON.parse(decodeURIComponent(encoded));
    expect(decoded).toEqual({
      c: ["id", "subject", "version"],
      t: "id:asc",
      f: [{ n: "id", o: "=", v: ["3", "7"] }],
    });
  });
});
