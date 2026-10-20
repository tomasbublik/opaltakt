import { createPersonResolver, type PersonResolver, type WorkPackageCache } from "@osp/contracts";
import type { Repositories } from "@osp/db";

/**
 * Identity unification (HANDOFF; golden tests `identity-golden*.test.ts`) —
 * assemble THE canonical person resolver from the DB: the global team_member
 * roster, every curated `user_name_alias`, and (optionally) the (name ↔ id)
 * pairs a set of cached work packages teaches. This is an ASSEMBLY helper, not
 * a second resolution rule — the one rule lives in `@osp/contracts`
 * (`createPersonResolver`); every read surface (closureStats, capacity route)
 * builds its resolver here so they cannot drift.
 */
export async function buildPersonResolver(
  repos: Pick<Repositories, "teamMembers" | "userNameAliases">,
  learnFrom: { wps?: readonly WorkPackageCache[] } = {},
): Promise<PersonResolver> {
  const [members, aliases] = await Promise.all([
    repos.teamMembers.list(),
    repos.userNameAliases.listAll(),
  ]);
  const resolver = createPersonResolver({
    members: members.map((m) => ({
      id: m.id,
      op_user_id: m.op_user_id,
      name: m.name,
      role: m.role,
    })),
    aliases: aliases.map((a) => ({
      connection_id: a.connection_id,
      journal_name: a.journal_name,
      op_user_id: a.op_user_id,
      merge_into_name: a.merge_into_name,
    })),
  });
  for (const w of learnFrom.wps ?? []) {
    if (w.assignee_op_id != null && w.assignee_name != null) {
      resolver.learn({
        name: w.assignee_name,
        op_user_id: w.assignee_op_id,
        connection_id: w.connection_id ?? null,
      });
    }
  }
  return resolver;
}
