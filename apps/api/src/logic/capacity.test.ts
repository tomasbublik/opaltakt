import { describe, expect, it } from "vitest";
import { computeCapacity } from "./capacity";

describe("computeCapacity — SPEC_14 §2 'capacity = Developers only'", () => {
  it("a tester (66h) and customer (10h) appear as lines but do NOT move the totals", () => {
    const res = computeCapacity(
      "per_person",
      [
        { member_id: 1, op_user_id: 10, name: "Dev One", available_hours: 40, role: "developer" },
        { member_id: 2, op_user_id: 20, name: "Daniel Brabec", available_hours: 66, role: "tester" },
        { member_id: 3, op_user_id: 30, name: "David Cesal", available_hours: 10, role: "customer" },
      ],
      [
        { wp_op_id: 1, parent_op_id: null, assignee_op_id: 10, assignee_name: "Dev One", planned_hours: 24, role: "developer" },
        { wp_op_id: 2, parent_op_id: null, assignee_op_id: 20, assignee_name: "Daniel Brabec", planned_hours: 8, role: "tester" },
        { wp_op_id: 3, parent_op_id: null, assignee_op_id: 30, assignee_name: "David Cesal", planned_hours: 5, role: "customer" },
      ],
    );

    // All three still appear.
    const dev = res.lines.find((l) => l.op_user_id === 10)!;
    const tester = res.lines.find((l) => l.op_user_id === 20)!;
    const customer = res.lines.find((l) => l.op_user_id === 30)!;
    expect(dev.is_developer).toBe(true);
    expect(tester).toMatchObject({ role: "tester", is_developer: false, available_hours: 66 });
    expect(customer).toMatchObject({ role: "customer", is_developer: false, available_hours: 10 });

    // Totals reflect the developer only — tester/customer are excluded.
    expect(res.total_available_hours).toBe(40);
    expect(res.total_planned_hours).toBe(24);
  });

  it("omitting role keeps every pre-Increment-14 caller developer-eligible (unchanged totals)", () => {
    const res = computeCapacity(
      "per_person",
      [{ member_id: 1, op_user_id: 10, name: "Ann", available_hours: 40 }],
      [
        { wp_op_id: 1, parent_op_id: null, assignee_op_id: 10, assignee_name: "Ann", planned_hours: 30 },
        { wp_op_id: 2, parent_op_id: null, assignee_op_id: null, assignee_name: null, planned_hours: 5 },
      ],
    );
    const ann = res.lines.find((l) => l.op_user_id === 10)!;
    expect(ann).toMatchObject({ role: "developer", is_developer: true });
    // Unassigned bucket is non-developer but its planned hours stay in the total
    // (pre-Increment-14 behavior preserved).
    const unassigned = res.lines.find((l) => l.member_id === null && l.op_user_id === null)!;
    expect(unassigned).toMatchObject({ role: "unset", is_developer: false, planned_hours: 5 });
    expect(res.total_available_hours).toBe(40);
    expect(res.total_planned_hours).toBe(35); // 30 dev + 5 unassigned
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Increment 28 (INCREMENT_28_CONTRACTS §0c/§2b) — the measured defect: a parent
// whose child is also in the sprint used to be filtered out of computeCapacity's
// input entirely, so a developer holding ONLY that parent produced no line at
// all, while closureStats (no leaf filter) still counted them — a violation of
// CAPACITY_BAR_RULES §5 invariant 5.
// ─────────────────────────────────────────────────────────────────────────────
describe("computeCapacity — a leaf-suppressed parent keeps its line at 0 h", () => {
  // The exact reproduction from contracts §0c: WP 1001 (Ada Lovelace, parent),
  // WP 1002 (Grace Hopper, child of 1001), both 4 h, plain planning sprint.
  const run = () =>
    computeCapacity(
      "per_person",
      [],
      [
        { wp_op_id: 1001, parent_op_id: null, assignee_op_id: 1, assignee_name: "Ada Lovelace", planned_hours: 4, role: "developer" },
        { wp_op_id: 1002, parent_op_id: 1001, assignee_op_id: 2, assignee_name: "Grace Hopper", planned_hours: 4, role: "developer" },
      ],
    );

  it("Ada (parent holder) gets a line, correctly named and role-coloured", () => {
    const res = run();
    const ada = res.lines.find((l) => l.op_user_id === 1);
    expect(ada).toBeDefined();
    expect(ada).toMatchObject({ name: "Ada Lovelace", role: "developer", is_developer: true });
  });

  it("that line contributes ZERO to every roll-up — no total moves", () => {
    const res = run();
    const ada = res.lines.find((l) => l.op_user_id === 1)!;
    const grace = res.lines.find((l) => l.op_user_id === 2)!;
    expect(ada.planned_hours).toBe(0);
    expect(ada.baseline_hours).toBe(0);
    expect(ada.added_hours).toBe(0);
    expect(ada.removed_hours).toBe(0);
    expect(ada.redistributed_in_hours).toBe(0);
    expect(ada.redistributed_out_hours).toBe(0);
    // Increment 28 follow-up: the CapacityLine contract defines has_sprint_work
    // as "is the assignee of a work package in the sprint (even a 0-estimate
    // one)" — so a suppressed parent's holder is NOT removable from capacity.
    expect(ada.has_sprint_work).toBe(true);
    expect(ada.overloaded).toBe(false);
    expect(ada.available_hours).toBe(0);
    // The child is completely untouched, and the totals are the pre-Increment-28
    // leaf-level numbers exactly (4, not 8 — leafEffort's semantics are intact).
    expect(grace.planned_hours).toBe(4);
    expect(res.total_planned_hours).toBe(4);
    expect(res.total_available_hours).toBe(0);
  });

  it("a suppressed item never invents an Unassigned bucket", () => {
    const res = computeCapacity(
      "per_person",
      [],
      [
        { wp_op_id: 1, parent_op_id: null, assignee_op_id: null, assignee_name: null, planned_hours: 9 },
        { wp_op_id: 2, parent_op_id: 1, assignee_op_id: 5, assignee_name: "Kid", planned_hours: 3 },
      ],
    );
    // The parent is unassigned AND suppressed → its 9 h must not appear anywhere,
    // and no "Unassigned" line may be conjured out of a 0-hour contribution.
    expect(res.lines.map((l) => l.name)).toEqual(["Kid"]);
    expect(res.total_planned_hours).toBe(3);
  });

  it("does not overwrite the name/role a countable item already established", () => {
    const res = computeCapacity(
      "per_person",
      [],
      [
        // Same person (op user 7) holds a countable leaf AND a suppressed parent
        // whose cached assignee_name differs (stale spelling). The countable
        // item's name must win, exactly as before Increment 28.
        { wp_op_id: 10, parent_op_id: null, assignee_op_id: 7, assignee_name: "Alan Turing", planned_hours: 5, role: "developer" },
        { wp_op_id: 20, parent_op_id: null, assignee_op_id: 7, assignee_name: "A. Turing", planned_hours: 6, role: "tester" },
        { wp_op_id: 21, parent_op_id: 20, assignee_op_id: 8, assignee_name: "Kid", planned_hours: 2, role: "developer" },
      ],
    );
    const alan = res.lines.find((l) => l.op_user_id === 7)!;
    expect(alan.name).toBe("Alan Turing");
    expect(alan.role).toBe("developer");
    expect(alan.planned_hours).toBe(5); // the suppressed 6 h is NOT added
    expect(res.total_planned_hours).toBe(7); // 5 + 2
  });
});
