import type { MultiSprintBadge } from "@osp/contracts";
import type { Repositories } from "@osp/db";

/**
 * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3) — cross-sprint TICKET
 * MEMBERSHIP, the one shared computation behind both the "sprint 2/3" badge
 * (§3) and the cumulative dev-logged aggregation (§2, closureStats.ts only).
 *
 * A wp is a "member" of a sprint iff it has a `sprint_item` row there with
 * outcome !== "removed" — deliberately INCLUDING `removed_mid_sprint` (a
 * ticket pulled from an earlier sprint mid-flight still really was worked on
 * there) — ordered by that sprint's `start_date`, then id (a same-day
 * tie-break, e.g. two sprints seeded/activated on one calendar date).
 *
 * Batched (§0 pillar 2 — local data only, no N+1): one `findByWpOpIds` call
 * across every wp in the caller's set, one batch of `sprints.getById`, capped
 * by the number of DISTINCT sprints those wps ever touched — never per-ticket.
 */

export interface SprintMembership {
  /** wp_op_id → sprint ids it's a member of, sorted start_date asc, then id asc. */
  sprintIdsByWp: ReadonlyMap<number, readonly number[]>;
  /** Every sprint referenced above, keyed by id (for start_date/status lookups). */
  sprintById: ReadonlyMap<number, { id: number; start_date: string; end_date: string }>;
}

export async function computeSprintMembership(
  repos: Pick<Repositories, "sprintItems" | "sprints">,
  wpOpIds: readonly number[],
): Promise<SprintMembership> {
  if (wpOpIds.length === 0) {
    return { sprintIdsByWp: new Map(), sprintById: new Map() };
  }
  const rows = (await repos.sprintItems.findByWpOpIds([...wpOpIds])).filter(
    (r) => r.outcome !== "removed",
  );
  const sprintIds = [...new Set(rows.map((r) => r.sprint_id))];
  const sprints = await Promise.all(sprintIds.map((id) => repos.sprints.getById(id)));
  const sprintById = new Map<number, { id: number; start_date: string; end_date: string }>();
  for (const s of sprints) {
    if (s) sprintById.set(s.id, { id: s.id, start_date: s.start_date, end_date: s.end_date });
  }

  const byWp = new Map<number, number[]>();
  for (const r of rows) {
    if (!sprintById.has(r.sprint_id)) continue; // defensive: sprint row vanished
    const arr = byWp.get(r.wp_op_id) ?? [];
    arr.push(r.sprint_id);
    byWp.set(r.wp_op_id, arr);
  }
  for (const arr of byWp.values()) {
    arr.sort((a, b) => {
      const sa = sprintById.get(a)!;
      const sb = sprintById.get(b)!;
      return sa.start_date.localeCompare(sb.start_date) || a - b;
    });
  }
  return { sprintIdsByWp: byWp, sprintById };
}

/** This sprint's 1-based position among ALL member sprints of `wpOpId`; null
 * when the ticket is single-sprint (total === 1) or membership is unknown. */
export function multiSprintBadge(
  membership: SprintMembership,
  wpOpId: number,
  currentSprintId: number,
): MultiSprintBadge | null {
  const ids = membership.sprintIdsByWp.get(wpOpId);
  if (!ids || ids.length <= 1) return null;
  const idx = ids.indexOf(currentSprintId);
  if (idx === -1) return null; // defensive: current sprint's own row was filtered out somehow
  return { sequence: idx + 1, total: ids.length };
}
