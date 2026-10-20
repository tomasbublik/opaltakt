import { describe, expect, it } from "vitest";

/**
 * GOLDEN A3 — the canonical personKey contract, as a UNIT test against the ONE
 * shared identity module (HANDOFF Fáze 2: a single `personKey`/`resolvePerson`
 * used by developerSegments.ts, closureStats.ts and capacity.ts alike; the
 * other definitions physically deleted).
 *
 * The module is expected at `@osp/contracts` (the shared, dependency-free
 * workspace package both apps already import). Until it exists, these tests are
 * RED — that is the point: they were written before the fix and must fail.
 *
 * Contract under test (HANDOFF §4 A3/A4 + §5):
 *   1. `connectionId = null` and `connectionId = <known>` yield the SAME key
 *      for the same person (today: `id:-:64` vs `id:1:64` — two rows).
 *   2. The id-carrying and the name-only appearance of one person yield the
 *      SAME key (today: `id:1:64` vs `nm:Jan Belka`).
 *   3. Aliases (`user_name_alias`) fold BEFORE keying — a curated journal
 *      spelling resolves to the same key as the roster name.
 *   4. The ONE split that must remain: the same numeric op_user_id on two
 *      DIFFERENT connections is two different people (Alan Turing ≠
 *      Cameron Dalby) and must NOT fold.
 */

interface ResolverModule {
  createPersonResolver?: (input: {
    members: Array<{
      id: number;
      op_user_id: number | null;
      name: string;
      role: string;
    }>;
    aliases?: Array<{
      connection_id: number;
      journal_name: string;
      op_user_id: number | null;
      merge_into_name: string | null;
    }>;
    learned_name_ids?: Array<{ name: string; op_user_id: number; connection_id: number | null }>;
  }) => {
    resolve: (
      connectionId: number | null,
      opUserId: number | null,
      name: string | null,
    ) => { key: string; name: string } | null;
  };
}

async function loadModule(): Promise<ResolverModule> {
  return (await import("@osp/contracts")) as unknown as ResolverModule;
}

describe("GOLDEN A3 — one canonical personKey (shared identity module)", () => {
  it("exports createPersonResolver from the shared module", async () => {
    const mod = await loadModule();
    expect(
      mod.createPersonResolver,
      "@osp/contracts must export the ONE canonical createPersonResolver",
    ).toBeTypeOf("function");
  });

  it("connectionId null vs known yields the SAME key for the same person", async () => {
    const { createPersonResolver } = await loadModule();
    const resolver = createPersonResolver!({
      members: [{ id: 1, op_user_id: 64, name: "Jan Belka", role: "developer" }],
    });
    const withConn = resolver.resolve(1, 64, "Jan Belka");
    const nullConn = resolver.resolve(null, 64, "Jan Belka");
    expect(withConn).not.toBeNull();
    expect(nullConn!.key).toBe(withConn!.key);
    // Even with no name attached (a bare id from a purged cache row):
    expect(resolver.resolve(null, 64, null)!.key).toBe(withConn!.key);
  });

  it("id-carrying and name-only appearances of one person yield the SAME key", async () => {
    const { createPersonResolver } = await loadModule();
    const resolver = createPersonResolver!({
      members: [{ id: 1, op_user_id: 64, name: "Jan Belka", role: "developer" }],
    });
    const byId = resolver.resolve(1, 64, null);
    const byName = resolver.resolve(1, null, "Jan Belka");
    expect(byName!.key).toBe(byId!.key);
  });

  it("a person known only from time-logs (not in team_member) still folds id/name/null-conn onto one key", async () => {
    const { createPersonResolver } = await loadModule();
    const resolver = createPersonResolver!({
      members: [],
      learned_name_ids: [{ name: "Zbynek Trnka", op_user_id: 305, connection_id: 1 }],
    });
    const byId = resolver.resolve(1, 305, "Zbynek Trnka");
    const byName = resolver.resolve(1, null, "Zbynek Trnka");
    const nullConn = resolver.resolve(null, 305, null);
    expect(byName!.key).toBe(byId!.key);
    expect(nullConn!.key).toBe(byId!.key);
  });

  it("aliases fold BEFORE keying — the curated journal spelling gets the roster person's key", async () => {
    const { createPersonResolver } = await loadModule();
    const resolver = createPersonResolver!({
      members: [{ id: 1, op_user_id: 64, name: "Jan Belka", role: "developer" }],
      aliases: [
        { connection_id: 1, journal_name: "Jan Bělka", op_user_id: 64, merge_into_name: null },
      ],
    });
    const canonical = resolver.resolve(1, 64, "Jan Belka");
    const aliased = resolver.resolve(1, null, "Jan Bělka");
    expect(aliased!.key).toBe(canonical!.key);
    expect(aliased!.name).toBe("Jan Belka");
  });

  it("A4 — the same numeric id on two DIFFERENT connections stays two people", async () => {
    const { createPersonResolver } = await loadModule();
    const resolver = createPersonResolver!({
      members: [{ id: 1, op_user_id: 3, name: "Alan Turing", role: "developer" }],
      learned_name_ids: [
        { name: "Alan Turing", op_user_id: 3, connection_id: 1 },
        { name: "Cameron Dalby", op_user_id: 3, connection_id: 2 },
      ],
    });
    const turing = resolver.resolve(1, 3, "Alan Turing");
    const dalby = resolver.resolve(2, 3, "Cameron Dalby");
    expect(turing!.key).not.toBe(dalby!.key);
  });
});
