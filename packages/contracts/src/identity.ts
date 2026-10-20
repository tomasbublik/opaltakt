import type { PersonRole } from "./common";

/**
 * THE canonical person identity — one `personKey`, one resolver, for every
 * surface (HANDOFF "Jedna identita osoby"; golden tests
 * `tests/src/identity-golden*.test.ts`).
 *
 * Why this exists: until this module, the repo had TWO independent `personKey`
 * definitions (apps/api/src/logic/developerSegments.ts and
 * apps/api/src/logic/capacity.ts) plus two ad-hoc `resolvePerson`-style
 * lookups (closureStats.ts, routes' `roleForParticipant`). Production data
 * proved they fragment one person into up to three keys —
 * `id:1:64` / `id:-:64` (connection unknown) / `nm:Jan Belka` (id unknown) —
 * which rendered as DUPLICATE rows in Closure "Per developer", made people
 * with no `team_member` row vanish entirely, and made the Capacity panel show
 * a partial fragment (10 h) while `/capacity` correctly said 32 h.
 * `CONSOLIDATION_PLAN.md`'s earlier "deliberately different, left as-is"
 * conclusion is hereby DISPROVED by that evidence.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * A person is GLOBAL (the `team_member` table has no `connection_id`; identity
 * IS the name — Increment 13). An `op_user_id` is a PER-CONNECTION alias of a
 * person: the same numeric id on two different connections may be two
 * different people (Alan Turing id 3 on the mock ≠ Cameron Dalby id 3 on
 * Acme — the Increment-23 collision class). Resolution therefore always
 * tries to reach the PERSON first, and only falls back to raw-key territory
 * when nothing about the person is known:
 *
 *   1. `tm:<team_member.id>` — the person has a roster row. Stable across
 *      connections, spellings (via aliases) and id-known/id-unknown inputs.
 *   2. `nm:<name>` — no roster row, but a name is known (given, recovered from
 *      the id via learned pairs, or folded via a curated alias).
 *      Connection-agnostic on purpose: identity IS the name; a genuine
 *      cross-connection same-name clash is resolved by an explicit
 *      `user_name_alias`, never by silently splitting one person into two.
 *   3. `id:<connection>:<op_user_id>` — nothing but a bare id. If the id is
 *      known on exactly one connection, that connection is adopted even when
 *      the caller passed null, so the key cannot fork on missing context.
 *
 * An id-based `team_member` match is accepted only when it does not contradict
 * the given name — that is what keeps the cross-connection collision split
 * (rule 4 of the golden contract) while still folding everything else.
 */

/** Canonical opaque person key. */
export type PersonKey = string;

/** The unassigned bucket key shared by capacity surfaces. */
export const UNASSIGNED_PERSON_KEY = "unassigned";

/**
 * RAW key builder — the LAST-RESORT shape used when no resolution context is
 * available (pure-engine unit tests, and the resolver's own fallback path).
 * Everything production-facing should key through `createPersonResolver`,
 * which folds id/name/connection variants of one person BEFORE keying;
 * this raw form is exactly as good as the information passed to it.
 */
export function personKey(
  connectionId: number | null,
  opUserId: number | null,
  name: string | null,
): PersonKey {
  return opUserId != null ? `id:${connectionId ?? "-"}:${opUserId}` : `nm:${name ?? ""}`;
}

/** A roster (team_member) row, as the resolver needs it. */
export interface ResolverMember {
  id: number;
  op_user_id: number | null;
  name: string;
  role: PersonRole;
}

/** A curated `user_name_alias` row (SPEC_13 §1b) — applied BEFORE keying. */
export interface ResolverAlias {
  connection_id: number;
  journal_name: string;
  op_user_id: number | null;
  merge_into_name: string | null;
}

/** A learned (name ↔ id) pair — from time-log actors, cached WP assignees, … */
export interface ResolverLearnedPair {
  name: string;
  op_user_id: number;
  /** The connection the pair was observed on (null = unknown provenance). */
  connection_id: number | null;
}

export interface PersonResolverInput {
  members: readonly ResolverMember[];
  aliases?: readonly ResolverAlias[];
  learned_name_ids?: readonly ResolverLearnedPair[];
}

/** One resolved person — the key plus everything the surfaces display. */
export interface ResolvedPersonIdentity {
  key: PersonKey;
  member_id: number | null;
  op_user_id: number | null;
  /** Canonical display name (roster > alias fold > given > recovered). */
  name: string;
  /** Raw roster role; "unset" when the person has no team_member row. */
  role: PersonRole;
}

export interface PersonResolver {
  /**
   * Resolve one appearance of a person. Returns null only when there is
   * genuinely nothing (no id AND no usable name) — the unassigned case.
   */
  resolve(
    connectionId: number | null,
    opUserId: number | null,
    name: string | null,
  ): ResolvedPersonIdentity | null;
  /** Key for a person known by their team_member id (retro-materialized lines). */
  memberKey(memberId: number): PersonKey;
  /** Feed a learned (name ↔ id) pair after construction (e.g. while scanning
   * time-log actors). Idempotent; first observation wins per (conn, name). */
  learn(pair: ResolverLearnedPair): void;
}

const norm = (s: string): string => s.trim();

/**
 * Capacity-surface role defaulting (Increment 14's documented back-compat
 * rule, now shared): only an EXPLICIT tester/customer/other marks a person
 * non-developer; "unset" (including "not in team_member at all") stays
 * plannable. This is what the capacity route always did
 * (`capacityRoleForMemberRole`) — closure adopting the SAME default is what
 * stops a logging-but-unrostered person from silently vanishing from
 * `per_developer` while `/capacity` counts them (the Zbynek Trnka defect).
 * The done-matrix deliberately does NOT use this — there "unset" must stay
 * ambiguous ("admit, don't infer").
 */
export function capacityEffectiveRole(role: PersonRole | null | undefined): PersonRole {
  return role == null || role === "unset" ? "developer" : role;
}

export function createPersonResolver(input: PersonResolverInput): PersonResolver {
  const membersById = new Map<number, ResolverMember>();
  const memberByOpUser = new Map<number, ResolverMember>();
  const ambiguousMemberOpIds = new Set<number>();
  const memberByName = new Map<string, ResolverMember>();
  for (const m of input.members) {
    membersById.set(m.id, m);
    if (m.op_user_id != null) {
      if (memberByOpUser.has(m.op_user_id)) ambiguousMemberOpIds.add(m.op_user_id);
      else memberByOpUser.set(m.op_user_id, m);
    }
    const n = norm(m.name);
    if (n && !memberByName.has(n)) memberByName.set(n, m);
  }

  // Aliases: exact journal-name match, connection-scoped; a null-connection
  // lookup may still use a name that exactly one connection curates.
  const aliasByConnName = new Map<string, ResolverAlias>();
  const aliasesByName = new Map<string, ResolverAlias[]>();
  for (const a of input.aliases ?? []) {
    const n = norm(a.journal_name);
    const scoped = `${a.connection_id}:${n}`;
    if (!aliasByConnName.has(scoped)) aliasByConnName.set(scoped, a);
    const arr = aliasesByName.get(n) ?? [];
    arr.push(a);
    aliasesByName.set(n, arr);
  }

  // Learned (name ↔ id) pairs. Two indexes:
  //   name → ids (per connection + global)  — enrich a name-only appearance;
  //   (conn, id) → name and id → names      — recover a name from a bare id,
  //                                            and detect cross-conn collisions.
  const idByConnName = new Map<string, number>();
  const idsByName = new Map<string, Set<number>>();
  const nameByConnId = new Map<string, string>();
  const namesById = new Map<number, Set<string>>();
  const connsById = new Map<number, Set<number>>();
  const learn = (p: ResolverLearnedPair): void => {
    const n = norm(p.name);
    if (!n) return;
    if (p.connection_id != null) {
      const ck = `${p.connection_id}:${n}`;
      if (!idByConnName.has(ck)) idByConnName.set(ck, p.op_user_id);
      const ik = `${p.connection_id}:${p.op_user_id}`;
      if (!nameByConnId.has(ik)) nameByConnId.set(ik, n);
      let conns = connsById.get(p.op_user_id);
      if (!conns) connsById.set(p.op_user_id, (conns = new Set()));
      conns.add(p.connection_id);
    }
    let ids = idsByName.get(n);
    if (!ids) idsByName.set(n, (ids = new Set()));
    ids.add(p.op_user_id);
    let names = namesById.get(p.op_user_id);
    if (!names) namesById.set(p.op_user_id, (names = new Set()));
    names.add(n);
  };
  for (const p of input.learned_name_ids ?? []) learn(p);
  // Roster rows are learned pairs too (connection unknown — the roster is global).
  for (const m of input.members) {
    if (m.op_user_id != null) {
      const n = norm(m.name);
      if (n) {
        let ids = idsByName.get(n);
        if (!ids) idsByName.set(n, (ids = new Set()));
        ids.add(m.op_user_id);
        let names = namesById.get(m.op_user_id);
        if (!names) namesById.set(m.op_user_id, (names = new Set()));
        names.add(n);
      }
    }
  }

  const memberKey = (memberId: number): PersonKey => `tm:${memberId}`;

  const resolve = (
    connectionId: number | null,
    opUserIdIn: number | null,
    nameIn: string | null,
  ): ResolvedPersonIdentity | null => {
    let name = nameIn != null && norm(nameIn) !== "" ? norm(nameIn) : null;
    let opUserId = opUserIdIn;
    if (opUserId == null && name == null) return null;

    // 1) Alias fold FIRST (SPEC_13 §1b) — the curated mapping beats everything.
    // A curated id pin means "this journal spelling IS this account", so the
    // contradiction guards below must not veto the member match it produces.
    let aliasPinnedId = false;
    if (name != null) {
      let alias: ResolverAlias | undefined;
      if (connectionId != null) {
        alias = aliasByConnName.get(`${connectionId}:${name}`);
      } else {
        const candidates = aliasesByName.get(name) ?? [];
        // Null-connection appearance: usable only when unambiguous.
        if (candidates.length === 1) alias = candidates[0];
      }
      if (alias) {
        if (alias.op_user_id != null && (opUserId == null || opUserId === alias.op_user_id)) {
          opUserId = alias.op_user_id;
          aliasPinnedId = true;
        }
        if (alias.merge_into_name != null) name = norm(alias.merge_into_name);
      }
    }

    // 2) Roster match — the person, if we can reach them without contradiction.
    //
    // The contradiction guard is CONNECTION-SCOPED on purpose: a bare
    // op_user_id is only ambiguous ACROSS connections (Alan Turing id 3 on the
    // mock ≠ Cameron Dalby id 3 on Acme), so only an appearance that
    // carries a connection AND a name disagreeing with the roster person is
    // evidence of a different person. With NO connection context (a purged
    // cache row, a pure unit-test fixture) a differing spelling on the SAME id
    // is a spelling variant and must FOLD — that is SPEC_13 §1a's "two
    // spellings that resolve to the same account merge", and rejecting it here
    // is exactly the fragmentation this module exists to end.
    // A name that is ITSELF a (different) roster person always wins over the
    // id match — identity IS the name (Increment 13).
    let member: ResolverMember | undefined;
    const nameMember = name != null ? memberByName.get(name) : undefined;
    if (opUserId != null && !ambiguousMemberOpIds.has(opUserId)) {
      const byId = memberByOpUser.get(opUserId);
      if (byId) {
        const connName =
          connectionId != null ? nameByConnId.get(`${connectionId}:${opUserId}`) : undefined;
        const contradicts =
          connectionId != null &&
          ((name != null && norm(byId.name) !== name) ||
            (connName != null && norm(byId.name) !== connName));
        const nameIsOtherPerson = nameMember != null && nameMember.id !== byId.id;
        if (aliasPinnedId || (!contradicts && !nameIsOtherPerson)) member = byId;
      }
    }
    if (!member && !aliasPinnedId) member = nameMember;

    // 3) Enrich: recover the missing half from the roster / learned pairs.
    if (opUserId == null && name != null) {
      opUserId =
        member?.op_user_id ??
        (connectionId != null ? idByConnName.get(`${connectionId}:${name}`) : undefined) ??
        (() => {
          const ids = idsByName.get(name);
          return ids && ids.size === 1 ? [...ids][0] : undefined;
        })() ??
        null;
      // The recovered id may now reach a roster row the name alone couldn't.
      if (!member && opUserId != null && !ambiguousMemberOpIds.has(opUserId)) {
        const byId = memberByOpUser.get(opUserId);
        if (byId && (name == null || norm(byId.name) === name)) member = byId;
      }
    }
    if (name == null && opUserId != null) {
      name =
        member?.name != null
          ? norm(member.name)
          : (connectionId != null ? nameByConnId.get(`${connectionId}:${opUserId}`) : undefined) ??
            (() => {
              const names = namesById.get(opUserId);
              return names && names.size === 1 ? [...names][0] : undefined;
            })() ??
            null;
      // A recovered name can also reach an alias or a roster row.
      if (!member && name != null) member = memberByName.get(name);
    }

    // 4) The canonical key: the roster person first; else the (resolved or
    //    given) op id — the id is the account, so two spellings of an
    //    unrostered person with one id still fold; the connection-agnostic
    //    name key only for a person with NO id anywhere (identity IS the
    //    name, Increment 13).
    if (member) {
      return {
        key: memberKey(member.id),
        member_id: member.id,
        op_user_id: opUserId ?? member.op_user_id,
        name: member.name,
        role: member.role,
      };
    }
    if (opUserId != null) {
      // Adopt the one connection that knows this id (so a null-connection
      // appearance — a purged cache row — cannot fork the key); an id known on
      // several connections keeps the caller's own scope (two different people
      // may legitimately share the number — the Increment-23 collision class).
      const conns = connsById.get(opUserId);
      const adoptedConn =
        connectionId ?? (conns && conns.size === 1 ? [...conns][0]! : null);
      return {
        key: personKey(adoptedConn, opUserId, null),
        member_id: null,
        op_user_id: opUserId,
        name: name ?? `Unknown user (${opUserId})`,
        role: "unset",
      };
    }
    return {
      key: `nm:${name!}`,
      member_id: null,
      op_user_id: null,
      name: name!,
      role: "unset",
    };
  };

  return { resolve, memberKey, learn };
}
