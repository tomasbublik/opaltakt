import type { UserNameAlias } from "@osp/contracts";
import type {
  JournalNameAlias,
  OpClient,
  OpUserIndexEntry,
  OpWorkPackage,
} from "@osp/op-client";
import { fetchProjectMemberships, parseOpId, resolveIdentity } from "@osp/op-client";

/**
 * SPEC_13 §1a (REVISED) — THE ONE identity resolver, used by EVERY view that
 * turns a journal-derived assignee NAME into an OP user id: retro seed/preview
 * candidate building (logic/retro.ts), the retrospective capacity roster and the
 * GET /people listing (routes/index.ts). There is deliberately a SINGLE
 * implementation so preview, planning-capacity and post-activation capacity all
 * resolve identity byte-for-byte identically (SPEC_13 §1a point 5's guard).
 *
 * WHAT CHANGED FROM THE PRIOR BUILD (validated against real production): the OP
 * user COLLECTION (`GET /api/v3/users`, via the old `fetchAllUsers`) is
 * admin-gated — a normal token gets nothing back, so almost every name came
 * back `unresolved` and blocked. This resolver NEVER touches that endpoint.
 * Instead the name→id index is composed from sources a NON-admin token can read:
 *   1. `_links.assignee` / `_links.accountable` (title + href) on work packages
 *      ALREADY fetched for reconstruction — the id is parsed out of the href;
 *   2. `GET /api/v3/memberships` for the sprint's project(s) (`fetchProject-
 *      Memberships`) — each membership's `_links.principal` is (name → id).
 * Aliases (`user_name_alias`) apply on top as the rare escape hatch.
 *
 * Crucially, an UNRESOLVED name is NOT a blocking state anymore — the caller
 * still gives it a full capacity line (its op_user_id is simply null). Identity
 * joins NAME → id by EXACT match only (never fuzzy); the id is opportunistic
 * enrichment layered over a person whose identity IS their name.
 *
 * Resolution happens FRESH at read time (no per-name caching that survives an
 * alias being added), so posting a new alias immediately re-buckets that name's
 * hours on the very next capacity/preview/people read — no reconstruction re-run.
 */

/** How one journal name resolved, in the shape the candidate/roster code wants. */
export interface ResolvedIdentity {
  /** The resolved OP user id, or null when no id is known yet (normal, NOT a
   * blocker) / there was no name to resolve. */
  op_user_id: number | null;
  /** How the id was obtained: "exact" (non-admin index), "alias" (a curated
   * `user_name_alias`, incl. a `merge_into_name` fold), "unresolved" (no id
   * known yet — informational), or null when there was no name to resolve. */
  resolution: "exact" | "alias" | "unresolved" | null;
  /**
   * SPEC_13 §1b — when a `merge_into_name` alias folds this journal name under a
   * different current display name that ITSELF has no known id, the canonical
   * name to attribute this name's hours to (the caller groups by name, so it
   * substitutes this before roster-grouping). Null in every other case (use the
   * journal name itself).
   */
  canonical_name: string | null;
}

export interface IdentityResolver {
  /** Resolve a single journal-derived display name. */
  resolve(journalName: string | null | undefined): ResolvedIdentity;
}

/**
 * NON-admin sources to compose the connection's name→id index from (SPEC_13
 * §1a). Both optional — with neither, the index is empty and every name is
 * `unresolved` (still non-blocking; aliases from the DB still apply).
 */
export interface IdentityIndexSources {
  /** Work packages already fetched for this connection — their assignee /
   * accountable `_links` (title + href) seed the index for free. */
  workPackages?: readonly OpWorkPackage[];
  /** Pre-extracted (name → id) hints — e.g. from the local work_package_cache's
   * assignee columns on a route that never re-fetches the live WPs. Same
   * non-admin provenance as `workPackages`, just already unpacked. */
  nameIdHints?: readonly OpUserIndexEntry[];
  /** OP project ids whose memberships to fetch as a roster of (name → id). */
  projectOpIds?: readonly number[];
}

/**
 * Build a resolver for ONE connection. `op` may be null (locked vault / no
 * client on a resilient read path) — memberships are then skipped, so the index
 * falls back to work-package links (if supplied) + DB aliases (offline-safe),
 * and otherwise `unresolved`. A failed membership fetch is swallowed per-project
 * — a read endpoint must not 500 because one roster call momentarily failed.
 */
export async function createIdentityResolver(
  op: OpClient | null,
  aliases: readonly UserNameAlias[],
  sources: IdentityIndexSources = {},
): Promise<IdentityResolver> {
  const byName = new Map<string, number>();
  const add = (name: string | null | undefined, href: string | null | undefined): void => {
    if (!name) return;
    const id = parseOpId(href ?? null);
    if (id === null) return;
    // First writer wins — never fuzzy across DIFFERENT names, and a stable id
    // for a repeated name keeps resolution deterministic across views.
    if (!byName.has(name)) byName.set(name, id);
  };

  // 1) assignee/accountable on work packages already in hand (SPEC_13 §1a #3).
  for (const wp of sources.workPackages ?? []) {
    add(wp._links.assignee?.title, wp._links.assignee?.href);
    add(wp._links.accountable?.title, wp._links.accountable?.href);
  }
  // 1b) pre-extracted hints (local cache assignee columns) — same provenance.
  for (const h of sources.nameIdHints ?? []) {
    if (!byName.has(h.name)) byName.set(h.name, h.op_user_id);
  }

  // 2) project memberships — the roster, readable by any non-admin token.
  if (op && sources.projectOpIds && sources.projectOpIds.length > 0) {
    for (const pid of new Set(sources.projectOpIds)) {
      try {
        const memberships = await fetchProjectMemberships(op, pid);
        for (const m of memberships) {
          add(m._links.principal?.title, m._links.principal?.href);
        }
      } catch {
        // A membership fetch failing must NOT 500 a read — skip this project.
      }
    }
  }

  const userIndex: OpUserIndexEntry[] = [...byName].map(([name, op_user_id]) => ({
    name,
    op_user_id,
  }));
  const aliasEntries: JournalNameAlias[] = aliases.map((a) => ({
    journal_name: a.journal_name,
    op_user_id: a.op_user_id,
    merge_into_name: a.merge_into_name,
  }));

  return {
    resolve(journalName): ResolvedIdentity {
      if (journalName == null || journalName === "") {
        return { op_user_id: null, resolution: null, canonical_name: null };
      }
      const r = resolveIdentity(journalName, userIndex, aliasEntries);
      if (r.status === "resolved") {
        return { op_user_id: r.op_user_id, resolution: r.via, canonical_name: null };
      }
      if (r.status === "renamed") {
        // A rename alias whose canonical name has no id either — fold this name's
        // hours under canonical_name (via "alias"), still with no id attached.
        return { op_user_id: null, resolution: "alias", canonical_name: r.canonical_name };
      }
      return { op_user_id: null, resolution: "unresolved", canonical_name: null };
    },
  };
}
