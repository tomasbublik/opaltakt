import { describe, expect, it } from "vitest";
import type { BacklogItem, CapacityLine } from "@osp/contracts";
import {
  applyAvailability,
  assigneeKey,
  backlogPeople,
  capacityLineKey,
  isUnassignedBucketLine,
  mergeCapacityLines,
  UNASSIGNED_KEY,
} from "./capacity";

function wp(over: Partial<BacklogItem>): BacklogItem {
  return {
    id: 1,
    connection_id: 1,
    op_id: 1,
    project_op_id: 1,
    project_name: "P",
    project_identifier: null,
    subject: "WP",
    type_name: "Task",
    status_name: "New",
    status_is_closed: false,
    assignee_op_id: null,
    assignee_name: null,
    estimated_hours: null,
    remaining_hours: null,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
    cached_at: "2026-06-01T00:00:00Z",
    override_hours: null,
    effective_hours: null,
    in_sprint: true,
    connection_base_url: "https://op.example.com",
    connection_label: null,
    stale: false,
    ...over,
  };
}

describe("assigneeKey", () => {
  it("buckets null assignees as unassigned", () => {
    expect(assigneeKey(wp({ assignee_op_id: null }))).toBe(UNASSIGNED_KEY);
    expect(assigneeKey(wp({ assignee_op_id: 7 }))).toBe("7");
  });
});

function serverLine(over: Partial<CapacityLine>): CapacityLine {
  return {
    member_id: null,
    op_user_id: 7,
    name: "Alice",
    available_hours: 0,
    planned_hours: 0,
    overloaded: false,
    has_sprint_work: false,
    baseline_hours: 0,
    added_hours: 0,
    removed_hours: 0,
    redistributed_out_hours: 0,
    redistributed_in_hours: 0,
    // Increment 14 (SPEC_14 §2): back-compat default for every pre-Increment-14
    // test line — a real non-developer line is modelled explicitly via `over`.
    role: "developer",
    is_developer: true,
    ...over,
  };
}

describe("capacityLineKey", () => {
  it("keys by op_user_id, unassigned when both op_user_id and member_id are null", () => {
    expect(capacityLineKey(serverLine({ op_user_id: 7 }))).toBe("7");
    expect(capacityLineKey(serverLine({ op_user_id: null, member_id: null }))).toBe(UNASSIGNED_KEY);
  });

  // Increment 13 (REVISED, SPEC_13 §1a/§3): a retro-reconstructed person's
  // identity is their NAME — such a line has op_user_id null but a real
  // member_id (the roster row the backend provisions for that name), and
  // must key DISTINCTLY from both the unassigned bucket and any other
  // name-only line, so two different unlinked names never collide.
  it("keys by member_id when op_user_id is null but member_id is set (a name-only retro line)", () => {
    const janBelka = capacityLineKey(serverLine({ op_user_id: null, member_id: 101, name: "Jan Belka" }));
    const johnArden = capacityLineKey(serverLine({ op_user_id: null, member_id: 102, name: "John Arden" }));
    expect(janBelka).not.toBe(UNASSIGNED_KEY);
    expect(johnArden).not.toBe(UNASSIGNED_KEY);
    expect(janBelka).not.toBe(johnArden);
  });
});

describe("isUnassignedBucketLine", () => {
  it("is true only when both op_user_id and member_id are null", () => {
    expect(isUnassignedBucketLine(serverLine({ op_user_id: null, member_id: null }))).toBe(true);
    expect(isUnassignedBucketLine(serverLine({ op_user_id: 7, member_id: null }))).toBe(false);
    // A name-only retro line (SPEC_13 §1a) is a normal person, NOT the
    // unassigned bucket, even though it has no op_user_id.
    expect(isUnassignedBucketLine(serverLine({ op_user_id: null, member_id: 101 }))).toBe(false);
  });
});

describe("applyAvailability", () => {
  it("overlays typed availability and recomputes overload + totals", () => {
    const lines = [
      serverLine({ op_user_id: 7, name: "Alice", available_hours: 20, planned_hours: 15 }),
      serverLine({ op_user_id: 9, name: "Bob", available_hours: 20, planned_hours: 4 }),
    ];
    // Bob's availability drops to 2 -> now overloaded; Alice untouched (keeps 20).
    const res = applyAvailability(lines, { "9": 2 });

    const alice = res.lines.find((l) => l.name === "Alice")!;
    const bob = res.lines.find((l) => l.name === "Bob")!;
    expect(alice.available_hours).toBe(20);
    expect(alice.overloaded).toBe(false);
    expect(bob.available_hours).toBe(2);
    expect(bob.overloaded).toBe(true);

    expect(res.total_available_hours).toBe(22);
    expect(res.total_planned_hours).toBe(19);
    expect(res.overloaded).toBe(true);
  });

  it("falls back to the server available hours when no override is present", () => {
    const lines = [serverLine({ op_user_id: 7, available_hours: 30, planned_hours: 10 })];
    const res = applyAvailability(lines, {});
    expect(res.lines[0]!.available_hours).toBe(30);
    expect(res.lines[0]!.overloaded).toBe(false);
    expect(res.overloaded).toBe(false);
  });

  // Increment 14 (SPEC_14 §2 consequence #1): "capacity = Developers only" —
  // a tester/customer/other line (and the unassigned bucket, role "unset")
  // still appears in `lines` (its hours stay visible as grey work) but is
  // excluded from the aggregate totals and the overload flag.
  it("excludes non-developer lines from aggregate totals but keeps them in `lines`", () => {
    const lines = [
      serverLine({ op_user_id: 7, name: "Alice", available_hours: 20, planned_hours: 15, role: "developer", is_developer: true }),
      serverLine({ op_user_id: 9, name: "Dan (tester)", available_hours: 66, planned_hours: 40, role: "tester", is_developer: false }),
      serverLine({ op_user_id: null, member_id: null, name: "Unassigned", available_hours: 0, planned_hours: 3, role: "unset", is_developer: false }),
    ];
    const res = applyAvailability(lines, {});

    expect(res.lines).toHaveLength(3);
    const tester = res.lines.find((l) => l.name === "Dan (tester)")!;
    expect(tester.planned_hours).toBe(40);
    expect(tester.available_hours).toBe(66);

    // Only Alice (the developer) counts toward the aggregate.
    expect(res.total_available_hours).toBe(20);
    expect(res.total_planned_hours).toBe(15);
    expect(res.overloaded).toBe(false);
  });
});

describe("backlogPeople", () => {
  it("returns distinct real assignees, skipping the unassigned bucket", () => {
    const people = backlogPeople([
      wp({ op_id: 1, assignee_op_id: 7, assignee_name: "Alice" }),
      wp({ op_id: 2, assignee_op_id: 7, assignee_name: "Alice" }),
      wp({ op_id: 3, assignee_op_id: 9, assignee_name: "Bob" }),
      wp({ op_id: 4, assignee_op_id: null, assignee_name: null }),
    ]);
    expect(people).toEqual([
      { op_user_id: 7, name: "Alice" },
      { op_user_id: 9, name: "Bob" },
    ]);
  });

  it("falls back to a stable label when a name is missing", () => {
    const people = backlogPeople([wp({ assignee_op_id: 42, assignee_name: null })]);
    expect(people).toEqual([{ op_user_id: 42, name: "User #42" }]);
  });
});

describe("mergeCapacityLines", () => {
  it("synthesizes a zero line for a backlog person with no server line", () => {
    const lines = mergeCapacityLines([], [{ op_user_id: 9, name: "Bob" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      op_user_id: 9,
      name: "Bob",
      available_hours: 0,
      planned_hours: 0,
      overloaded: false,
    });
  });

  it("keeps the server line (with planned load) and de-dupes by op_user_id", () => {
    const server = [serverLine({ op_user_id: 7, name: "Alice", available_hours: 20, planned_hours: 15 })];
    const lines = mergeCapacityLines(server, [
      { op_user_id: 7, name: "Alice" },
      { op_user_id: 9, name: "Bob" },
    ]);
    const alice = lines.find((l) => l.op_user_id === 7)!;
    const bob = lines.find((l) => l.op_user_id === 9)!;
    expect(lines).toHaveLength(2);
    expect(alice.planned_hours).toBe(15); // server value preserved, not reset
    expect(alice.available_hours).toBe(20);
    expect(bob.planned_hours).toBe(0);
  });

  it("orders assigned members alphabetically with the unassigned bucket last", () => {
    const server = [serverLine({ op_user_id: null, member_id: null, name: "Unassigned", planned_hours: 3 })];
    const lines = mergeCapacityLines(server, [
      { op_user_id: 5, name: "Zoe" },
      { op_user_id: 2, name: "Amy" },
    ]);
    expect(lines.map((l) => l.name)).toEqual(["Amy", "Zoe", "Unassigned"]);
    expect(lines[lines.length - 1]!.op_user_id).toBeNull();
  });

  // Increment 13 (REVISED, SPEC_13 §1a/§3): a name-only retro line (real
  // member_id, no op_user_id) sorts alphabetically among ordinary people —
  // it is NOT pushed down next to the genuinely-unassigned bucket just
  // because op_user_id is null.
  it("sorts a name-only retro line alphabetically, not next to the unassigned bucket", () => {
    const server = [
      serverLine({ op_user_id: null, member_id: null, name: "Unassigned", planned_hours: 3 }),
      serverLine({ op_user_id: null, member_id: 101, name: "Jan Belka", planned_hours: 19 }),
      serverLine({ op_user_id: 7, name: "Zoe" }),
    ];
    const lines = mergeCapacityLines(server, []);
    expect(lines.map((l) => l.name)).toEqual(["Jan Belka", "Zoe", "Unassigned"]);
  });
});
