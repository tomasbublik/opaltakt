/**
 * SPEC_13 §1/§1a (REVISED) — journal-name → OP-user identity resolution.
 *
 * THE ROOT PROBLEM (SPEC_13 §1): an OpenProject journal carries the assignee as
 * a DISPLAY-NAME STRING only ("Assignee changed from Daniel Brabec to Jan Bily")
 * — never a numeric user id. `_links.user` on an activity is the AUTHOR of the
 * change, NOT the assignee. So reconstruction (reconstruct.ts) can recover a
 * name string but nothing else.
 *
 * THE REVISED PRINCIPLE (SPEC_13 §1a): **a person's identity IS their name.** A
 * journal-derived name gets a capacity line, hours and editable availability
 * IMMEDIATELY — an OP user id is never required to work with a person. The id is
 * opportunistic ENRICHMENT, folded in ONLY when it can be sourced WITHOUT admin
 * rights (from a work package's `_links.assignee`/`accountable`, or from
 * `GET /api/v3/memberships`'s `_links.principal` — NEVER from the admin-gated
 * `GET /api/v3/users` collection). `userIndex` below is therefore built from
 * those non-admin sources, not from a full user directory.
 *
 * So `unresolved` is NOT a failure/blocking state anymore — it means only "no OP
 * id known yet, informational". The caller (apps/api, Agent B) still gives an
 * unresolved name a full capacity line; the id just isn't attached yet. What is
 * still forbidden is GUESSING an id: identity is joined NAME → id by EXACT string
 * match only, in a strict order, so "Jan Belka" is NEVER conflated with the
 * different real person "Jan Bily" (SPEC_13 §1a point 4 — the matching algorithm
 * was always correct; only the DATA SOURCE for `userIndex` was wrong before).
 *
 * Resolution order:
 *   1) EXACT string match of `journalName` against `userIndex` (case-sensitive,
 *      whole-string) → `resolved` via "exact".
 *   2) EXACT alias match on `journal_name` (SPEC_13 §1a/§1b, the exception-only
 *      escape hatch). An alias can either:
 *        - pin the name to a specific `op_user_id` (two real users share a
 *          display name) → `resolved` via "alias"; or
 *        - fold the name under a different `merge_into_name` with NO id (a
 *          renamed OP user; two spellings of one person). If that canonical name
 *          itself matches `userIndex` exactly we chain straight through to
 *          `resolved` via "alias"; otherwise `renamed` (caller folds by name).
 *   3) Otherwise `unresolved`, carrying the journal name back.
 *
 * This is a PURE function — no I/O, no DB, no network. Keeping resolution in ONE
 * pure primitive is what guarantees SPEC_13 §1a point 5: preview, planning
 * capacity, and post-activation capacity all resolve identity IDENTICALLY.
 */

/**
 * One (name → id) hint the caller has gathered from a NON-admin OP source
 * (a work package's `_links.assignee`/`accountable`, or a membership's
 * `_links.principal`). NOT the admin-gated `GET /api/v3/users` collection.
 */
export interface OpUserIndexEntry {
  op_user_id: number;
  name: string;
}

/**
 * One human-curated alias (SPEC_13 §1a/§1b `user_name_alias`) — the
 * exception-only escape hatch, NOT part of the normal flow. At least one of
 * `op_user_id` / `merge_into_name` is expected to be set:
 * - `op_user_id` set: pin this journal name to a specific real user (disambiguate
 *   two distinct OP users that share a display name).
 * - `merge_into_name` set (id null): fold this journal name's person under a
 *   different current display name (an OP user renamed after old journals were
 *   written, or two spellings of one person).
 * If both are set, `op_user_id` wins (it's the more specific instruction).
 */
export interface JournalNameAlias {
  journal_name: string;
  op_user_id: number | null;
  merge_into_name: string | null;
}

/**
 * The outcome of resolving one journal name.
 * - `resolved`: an OP id is known; `via` records HOW ("exact" name match against
 *   the non-admin index, vs. a curated "alias").
 * - `renamed`: an alias folds this journal name under a different canonical
 *   display name, and no OP id is known for it. The caller treats
 *   `canonical_name` as the person (merging this name's hours into it) and MAY
 *   re-resolve `canonical_name` later if an id surfaces. No id is invented here.
 * - `unresolved`: no exact match and no alias — "no OP id known yet". This is
 *   INFORMATIONAL, not a blocker: the person still exists by name (`journal_name`)
 *   and still gets a capacity line. Never substitutes a different user.
 */
export type IdentityResolution =
  | { status: "resolved"; op_user_id: number; via: "exact" | "alias" }
  | { status: "renamed"; canonical_name: string; via: "alias" }
  | { status: "unresolved"; journal_name: string };

/**
 * Resolve a journal-derived assignee display name to an OP user id (when one is
 * known) or fold it under a canonical name — see the file header for the full
 * order and rationale. Pure; NEVER fuzzy-matches, never picks "closest".
 *
 * EXACT INDEX MATCH BEATS ALIAS when both exist for the same name: a live index
 * hit means the current connection has an unambiguous real user by that exact
 * name TODAY, which is more authoritative than a historical alias (aliases exist
 * to paper over names the index CAN'T supply, e.g. renamed users).
 *
 * Empty `userIndex`/`aliases` never throw — they just yield `unresolved`.
 */
export function resolveIdentity(
  journalName: string,
  userIndex: OpUserIndexEntry[],
  aliases: JournalNameAlias[],
): IdentityResolution {
  // 1) Exact index match — case-sensitive, whole-string. First wins (the index
  //    should not carry duplicate names; if it does, the first is as good as any
  //    and we still never fuzzy-match across DIFFERENT names).
  const direct = findByName(userIndex, journalName);
  if (direct !== null) {
    return { status: "resolved", op_user_id: direct, via: "exact" };
  }

  // 2) Exact alias match — only reached when the index has no such name.
  for (const alias of aliases) {
    if (alias.journal_name !== journalName) continue;

    // 2a) Pinned to a specific id (disambiguation) — the more specific
    //     instruction, so it wins even if merge_into_name is also set.
    if (alias.op_user_id !== null) {
      return { status: "resolved", op_user_id: alias.op_user_id, via: "alias" };
    }

    // 2b) Folded under another display name (a renamed person, no id). If that
    //     canonical name ITSELF has an exact index hit, chain straight through
    //     to a resolved id for a nicer caller experience; otherwise report
    //     `renamed` so the caller folds this name's hours under canonical_name.
    if (alias.merge_into_name !== null) {
      const canonical = findByName(userIndex, alias.merge_into_name);
      if (canonical !== null) {
        return { status: "resolved", op_user_id: canonical, via: "alias" };
      }
      return { status: "renamed", canonical_name: alias.merge_into_name, via: "alias" };
    }

    // Malformed alias (neither field set) — ignore it and keep looking.
  }

  // 3) No exact match, no usable alias → unresolved (informational, not a
  //    blocker). Never substitute another user.
  return { status: "unresolved", journal_name: journalName };
}

/** First exact (case-sensitive, whole-string) name hit's id, or null. */
function findByName(userIndex: OpUserIndexEntry[], name: string): number | null {
  for (const entry of userIndex) {
    if (entry.name === name) return entry.op_user_id;
  }
  return null;
}
