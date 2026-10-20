import type { OpClient, OpUser } from "@osp/op-client";

/**
 * SPEC_11 §4 — user-name resolution that NEVER fabricates "User <id>".
 *
 * The reported "User 18" bug came from stringifying a numeric OP user id into a
 * display name whenever a name couldn't be resolved (a journal/time-entry link
 * carries only `/api/v3/users/:id`, no title — see fixture_op_activities_11762).
 * This helper resolves a name in order:
 *   1. a locally-known name (seeded from work_package_cache.assignee_name, team
 *      members, or any already-resolved id);
 *   2. Agent A's `op.getUser(id)` OpClient method (added in parallel — see the
 *      duck-typed probe below), memoized so the SAME id isn't fetched twice;
 *   3. `null` — the caller then labels it readably as `unknownUserLabel(id)`
 *      (`Unknown user (18)`), NEVER `User 18`.
 */

/**
 * `op.getUser(id)` is being added to the OpClient interface by Agent A IN
 * PARALLEL, so it isn't declared on the frozen `OpClient` type yet. Probe for
 * it at runtime (duck-typing) so this code compiles today and transparently
 * starts resolving real names the moment the method lands. Documented
 * signature: `getUser(id: number): Promise<OpUser | null>` (null on 404).
 */
type MaybeGetUser = { getUser?: (id: number) => Promise<OpUser | null> };

export function opGetUser(
  op: OpClient,
): ((id: number) => Promise<OpUser | null>) | null {
  const fn = (op as OpClient & MaybeGetUser).getUser;
  return typeof fn === "function" ? fn.bind(op) : null;
}

/** Readable label for an id we could not resolve to a real name. Never "User <id>". */
export function unknownUserLabel(opUserId: number): string {
  return `Unknown user (${opUserId})`;
}

export interface UserNameResolver {
  /** Seed a locally-known name (idempotent; ignores empty/nullish). */
  seed(opUserId: number, name: string | null | undefined): void;
  /** Real name if resolvable (local cache → op.getUser), else null. Never fabricates. */
  resolve(opUserId: number): Promise<string | null>;
  /** Local-only lookup (no OP round-trip) — for hot paths that can't await. */
  local(opUserId: number): string | null;
}

/**
 * Build a resolver bound to an OPTIONAL OP client (pass `null` for a purely
 * local resolver — e.g. a read endpoint that must not fail on a locked vault).
 * The op.getUser cache is per-resolver, so callers that resolve the SAME id
 * repeatedly (a capacity/changelog pass) pay at most one round-trip per id.
 */
export function createUserNameResolver(op: OpClient | null): UserNameResolver {
  const local = new Map<number, string>();
  const opCache = new Map<number, string | null>();
  const getUser = op ? opGetUser(op) : null;
  return {
    seed(opUserId, name) {
      if (name) local.set(opUserId, name);
    },
    local(opUserId) {
      return local.get(opUserId) ?? null;
    },
    async resolve(opUserId) {
      const known = local.get(opUserId);
      if (known) return known;
      if (getUser) {
        if (opCache.has(opUserId)) return opCache.get(opUserId) ?? null;
        try {
          const user = await getUser(opUserId);
          const name = user?.name ?? null;
          opCache.set(opUserId, name);
          if (name) local.set(opUserId, name);
          return name;
        } catch {
          // A single unresolvable id must never break a whole capacity/changelog
          // pass — treat it as "unknown" and let the caller label it readably.
          opCache.set(opUserId, null);
          return null;
        }
      }
      return null;
    },
  };
}
