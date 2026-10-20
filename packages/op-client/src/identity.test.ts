import { describe, expect, it } from "vitest";
import {
  resolveIdentity,
  type JournalNameAlias,
  type OpUserIndexEntry,
} from "./identity";

// A (name → id) index that deliberately contains the SPEC_13 §1 discriminating
// pair: "Jan Belka" and "Jan Bily" are DIFFERENT real people (ids 10 and 11).
// Any resolver that fuzzy-matched would collapse them — the whole point of §1 is
// that it must not. (In the revised model this index is built from non-admin
// sources — `_links.assignee`/`accountable`, memberships — NOT the admin-gated
// `GET /api/v3/users` collection; the matching algorithm below is unchanged.)
const INDEX: OpUserIndexEntry[] = [
  { op_user_id: 10, name: "Jan Belka" },
  { op_user_id: 11, name: "Jan Bily" },
  { op_user_id: 12, name: "Arend Kuiper" },
  { op_user_id: 13, name: "John Arden" },
];

/** Terse alias literal with the fields not under test defaulted to null. */
function alias(a: Partial<JournalNameAlias> & { journal_name: string }): JournalNameAlias {
  return { op_user_id: null, merge_into_name: null, ...a };
}

describe("resolveIdentity — exact match (SPEC_13 §1)", () => {
  it("resolves 'Jan Belka' to Jan Belka's id via exact, NEVER Jan Bily's", () => {
    const r = resolveIdentity("Jan Belka", INDEX, []);
    expect(r).toEqual({ status: "resolved", op_user_id: 10, via: "exact" });
    // The bug this guards: an off-by-one/fuzzy match onto 11 (Jan Bily).
    if (r.status === "resolved") expect(r.op_user_id).not.toBe(11);
  });

  it("resolves 'Jan Bily' to Jan Bily's id (the neighbouring name is unaffected)", () => {
    expect(resolveIdentity("Jan Bily", INDEX, [])).toEqual({
      status: "resolved",
      op_user_id: 11,
      via: "exact",
    });
  });

  it("is case-sensitive and whole-string — 'jan belka' / 'Jan' do NOT match", () => {
    expect(resolveIdentity("jan belka", INDEX, []).status).toBe("unresolved");
    expect(resolveIdentity("Jan", INDEX, []).status).toBe("unresolved");
    expect(resolveIdentity("Jan Belka ", INDEX, []).status).toBe("unresolved");
  });
});

describe("resolveIdentity — unresolved is informational, not a blocker (SPEC_13 §1a)", () => {
  it("an unknown name with NO matching alias → unresolved, carrying the name", () => {
    // Not a failure: the caller still gives this person a capacity line by name.
    expect(resolveIdentity("Someone Missing", INDEX, [])).toEqual({
      status: "unresolved",
      journal_name: "Someone Missing",
    });
  });

  it("never substitutes a different user for an unknown name", () => {
    const r = resolveIdentity("Ghost User", INDEX, [
      alias({ journal_name: "Different Name", op_user_id: 99 }),
    ]);
    expect(r.status).toBe("unresolved");
  });

  it("empty index AND empty aliases → unresolved, never throws", () => {
    expect(() => resolveIdentity("Jan Belka", [], [])).not.toThrow();
    expect(resolveIdentity("Jan Belka", [], [])).toEqual({
      status: "unresolved",
      journal_name: "Jan Belka",
    });
  });
});

describe("resolveIdentity — alias by op_user_id (SPEC_13 §1b disambiguation)", () => {
  it("an unresolved name WITH a matching id-pinned alias resolves via 'alias'", () => {
    // "Jan Belká" (renamed in OP; old accented name frozen in the journal) is not
    // in the index, but a curated alias pins it onto user 10.
    const aliases = [alias({ journal_name: "Jan Belká", op_user_id: 10 })];
    expect(resolveIdentity("Jan Belká", INDEX, aliases)).toEqual({
      status: "resolved",
      op_user_id: 10,
      via: "alias",
    });
  });

  it("alias match is also exact — a near-miss alias name does NOT resolve", () => {
    const aliases = [alias({ journal_name: "Old Name", op_user_id: 7 })];
    expect(resolveIdentity("old name", INDEX, aliases).status).toBe("unresolved");
  });

  it("EXACT index match WINS over an alias for the same name", () => {
    // Both an index user AND an alias exist for "Jan Belka"; the live index
    // (authoritative) must win → via:"exact", user 10, not the alias's 999.
    const aliases = [alias({ journal_name: "Jan Belka", op_user_id: 999 })];
    expect(resolveIdentity("Jan Belka", INDEX, aliases)).toEqual({
      status: "resolved",
      op_user_id: 10,
      via: "exact",
    });
  });

  it("first matching alias wins when several map the same journal name", () => {
    const aliases = [
      alias({ journal_name: "Mystery", op_user_id: 20 }),
      alias({ journal_name: "Mystery", op_user_id: 21 }),
    ];
    expect(resolveIdentity("Mystery", INDEX, aliases)).toEqual({
      status: "resolved",
      op_user_id: 20,
      via: "alias",
    });
  });
});

describe("resolveIdentity — alias by merge_into_name (SPEC_13 §1a rename/fold)", () => {
  it("folds under a canonical name whose id is UNKNOWN → 'renamed' (no id invented)", () => {
    // A renamed person: journal carries "Jan B." which we merge under the current
    // display name "Jan Novak", but that name isn't in the index yet → renamed.
    const aliases = [alias({ journal_name: "Jan B.", merge_into_name: "Jan Novak" })];
    expect(resolveIdentity("Jan B.", INDEX, aliases)).toEqual({
      status: "renamed",
      canonical_name: "Jan Novak",
      via: "alias",
    });
  });

  it("chains straight through to 'resolved' when the canonical name IS in the index", () => {
    // "Arend K." folds under "Arend Kuiper", which the index knows (id 12) →
    // resolve straight through via alias for a nicer caller experience.
    const aliases = [alias({ journal_name: "Arend K.", merge_into_name: "Arend Kuiper" })];
    expect(resolveIdentity("Arend K.", INDEX, aliases)).toEqual({
      status: "resolved",
      op_user_id: 12,
      via: "alias",
    });
  });

  it("op_user_id wins over merge_into_name when both are set on one alias", () => {
    const aliases = [
      alias({ journal_name: "Ambiguous", op_user_id: 13, merge_into_name: "Arend Kuiper" }),
    ];
    expect(resolveIdentity("Ambiguous", INDEX, aliases)).toEqual({
      status: "resolved",
      op_user_id: 13,
      via: "alias",
    });
  });

  it("a malformed alias (neither field set) is ignored → unresolved", () => {
    const aliases = [alias({ journal_name: "Nobody" })];
    expect(resolveIdentity("Nobody", INDEX, aliases)).toEqual({
      status: "unresolved",
      journal_name: "Nobody",
    });
  });
});
