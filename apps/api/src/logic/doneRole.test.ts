import { DEFAULT_DONE_RULES, type DoneRule, type TeamMember } from "@osp/contracts";
import { describe, expect, it } from "vitest";
import { buildMemberIndex, classifyWithRole, roleForHolder } from "./doneRole";

const rules: DoneRule[] = DEFAULT_DONE_RULES.map((r, i) => ({ id: i + 1, ...r }));

describe("classifyWithRole — SPEC_14 §2 matrix", () => {
  it("always_done statuses are done regardless of holder role", () => {
    for (const status of ["Developed", "Merge pending", "Tested", "Resolved", "Closed"]) {
      for (const role of ["developer", "tester", "customer", "other", "unset"] as const) {
        expect(classifyWithRole({ status_name: status }, role, rules).bucket).toBe("done");
      }
      // Even genuinely unassigned: an always_done status stands on its own.
      expect(classifyWithRole({ status_name: status }, null, rules).bucket).toBe("done");
    }
  });

  it("rejected is its own bucket", () => {
    expect(classifyWithRole({ status_name: "Rejected" }, "developer", rules).bucket).toBe("rejected");
    expect(classifyWithRole({ status_name: "Rejected" }, null, rules).bucket).toBe("rejected");
  });

  it("role_dependent: developer holder → not_done", () => {
    for (const status of ["New", "Confirmed", "In progress", "On hold"]) {
      expect(classifyWithRole({ status_name: status }, "developer", rules).bucket).toBe("not_done");
    }
  });

  it("role_dependent: tester/customer/other holder → done (left dev's hands)", () => {
    for (const role of ["tester", "customer", "other"] as const) {
      expect(classifyWithRole({ status_name: "In progress" }, role, rules).bucket).toBe("done");
      expect(classifyWithRole({ status_name: "On hold" }, role, rules).bucket).toBe("done");
    }
  });

  it("role_dependent + unset role → ambiguous with a reason naming the holder", () => {
    const r = classifyWithRole({ status_name: "In progress" }, "unset", rules, "Anna Nováková");
    expect(r.bucket).toBe("ambiguous");
    expect(r.ambiguous_reason).toContain("Anna Nováková");
    expect(r.anomaly).toBeNull();
  });

  it("role_dependent + genuinely unassigned → not_done", () => {
    const r = classifyWithRole({ status_name: "New" }, null, rules);
    expect(r.bucket).toBe("not_done");
    expect(r.anomaly).toBeNull();
  });

  it("in progress + unassigned → not_done AND flags the anomaly", () => {
    const r = classifyWithRole({ status_name: "In progress" }, null, rules);
    expect(r.bucket).toBe("not_done");
    expect(r.anomaly).toBe("unassigned_in_progress");
  });

  it("matches status names case-insensitively / trimmed", () => {
    expect(classifyWithRole({ status_name: "  IN PROGRESS " }, "developer", rules).bucket).toBe("not_done");
    expect(classifyWithRole({ status_name: "tested" }, "developer", rules).bucket).toBe("done");
  });

  it("unmapped status falls back: closed → done, open → role_dependent", () => {
    // Unknown but OP-closed → done.
    expect(
      classifyWithRole({ status_name: "Archived", status_is_closed: true }, "developer", rules).bucket,
    ).toBe("done");
    // Unknown + open + developer → not_done; + customer → done.
    expect(
      classifyWithRole({ status_name: "Needs review", status_is_closed: false }, "developer", rules).bucket,
    ).toBe("not_done");
    expect(
      classifyWithRole({ status_name: "Needs review", status_is_closed: false }, "customer", rules).bucket,
    ).toBe("done");
  });
});

describe("classifyWithRole — real sprint 3.5.039 rows (SPEC_14 §2/§6, Done 9 / Not done 2)", () => {
  // status + current holder role → expected bucket.
  const rows: Array<[string, string, ReturnType<typeof classifyWithRole>["bucket"]]> = [
    ["tested", "tester", "done"], // #11585 Vojtech Kolar
    ["in progress", "developer", "not_done"], // #11592 Zbynek Trnka (Dev)
    ["resolved", "customer", "done"], // #11625 David Cesal
    ["tested", "other", "done"], // #11687 Arend Kuiper
    ["on hold", "customer", "done"], // #11726 Jindrich Benda (Zákazník)
    ["in progress", "customer", "done"], // #11747 David Cesal (Zákazník)
    ["tested", "tester", "done"], // #11756 Cameron Dalby
    ["closed", "developer", "done"], // #11762 Jan Bily
    ["in progress", "developer", "not_done"], // #11765 Tobias Bubenik (Dev)
    ["tested", "other", "done"], // #11771 Arend Kuiper
    ["tested", "other", "done"], // #11773 Arend Kuiper
  ];

  it("yields Done 9 / Not done 2 (exactly the two in-progress developer tickets)", () => {
    const buckets = rows.map(([status, role]) =>
      classifyWithRole({ status_name: status }, role as never, rules).bucket,
    );
    expect(buckets.filter((b) => b === "done")).toHaveLength(9);
    expect(buckets.filter((b) => b === "not_done")).toHaveLength(2);
    // No tested ticket is ever not-done.
    rows.forEach(([status], i) => {
      if (status === "tested") expect(buckets[i]).toBe("done");
    });
  });

  it("#11726 on hold + customer is done, but flips to not_done if Jindrich were a Developer", () => {
    expect(classifyWithRole({ status_name: "on hold" }, "customer", rules).bucket).toBe("done");
    expect(classifyWithRole({ status_name: "on hold" }, "developer", rules).bucket).toBe("not_done");
  });
});

describe("roleForHolder / buildMemberIndex — SPEC_21 §4 name matching", () => {
  const member = (over: Partial<TeamMember> & { name: string }): TeamMember => ({
    id: over.id ?? 1,
    op_user_id: over.op_user_id ?? null,
    name: over.name,
    default_hours_per_day: over.default_hours_per_day ?? 8,
    role: over.role ?? "developer",
  });

  it("op_user_id lookup wins and is exact (unaffected by name normalization)", () => {
    const idx = buildMemberIndex([member({ id: 1, op_user_id: 10, name: "Jan Bily", role: "tester" })]);
    const r = roleForHolder(10, "whatever", idx);
    expect(r.role).toBe("tester");
    // resolvedName keeps the passed display name when provided.
    expect(r.resolvedName).toBe("whatever");
  });

  it("genuinely unassigned (no id, no name) → role null", () => {
    const idx = buildMemberIndex([member({ name: "Jan Bily" })]);
    expect(roleForHolder(null, null, idx)).toEqual({ role: null, resolvedName: null });
    expect(roleForHolder(null, "", idx)).toEqual({ role: null, resolvedName: null });
  });

  it("resolves a casing-divergent raw baseline name to the real member (the SPEC_21 fix)", () => {
    // The only team_member row carries the canonical display casing (e.g. from
    // live sync's assignee_name), while the retro baseline stored the raw,
    // journal-reconstructed lower-case name. Exact match used to miss → unset.
    const idx = buildMemberIndex([member({ id: 7, name: "Jan Bily", role: "developer" })]);
    const r = roleForHolder(null, "  jan bily ", idx);
    expect(r.role).toBe("developer"); // was "unset" before the fix
    // resolvedName is still the STORED display name (the passed name here),
    // never the lower-cased index key.
    expect(r.resolvedName).toBe("  jan bily ");
  });

  it("a resolved holder with NO matching member row stays 'unset' (never guessed)", () => {
    const idx = buildMemberIndex([member({ name: "Someone Else" })]);
    const r = roleForHolder(null, "Ghost Person", idx);
    expect(r.role).toBe("unset");
    expect(r.resolvedName).toBe("Ghost Person");
  });
});
