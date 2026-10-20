import type { DoneRule, PersonRole, TeamMember, TicketDoneBucket } from "@osp/contracts";

/**
 * Increment 14 (SPEC_14 §2) — the ROLE-AWARE done matrix: a ticket's "done-ness"
 * depends on its status AND the ROLE of whoever currently holds it, not the
 * status alone. This is deliberately SEPARATE from `done.ts`'s `classifyStatus`/
 * `isDone` (the pre-Increment-14 two-way done/rejected/open split driven by the
 * per-sprint `done_status_rule`) — that path stays untouched and keeps powering
 * the old closure report / velocity. This one powers the NEW closure statistics
 * and the Reports screen.
 *
 * The matrix (SPEC_14 §2, confirmed on real sprint 3.5.039):
 *   - status kind `always_done`   → done (the status alone proves dev work ended)
 *   - status kind `rejected`      → rejected (its own bucket)
 *   - status kind `role_dependent`:
 *       holder Developer                    → not_done (still in dev's hands)
 *       holder Tester / Customer / Other     → done     (left the dev's hands)
 *       holder role `unset`                  → ambiguous (admit, don't infer)
 *       genuinely UNASSIGNED (holderRole===null) → not_done  (can't claim delivery),
 *         and if the status is "in progress" this shouldn't happen at all →
 *         flag `anomaly: "unassigned_in_progress"` (surface, never swallow).
 *
 * Status names are matched case-insensitively / trimmed against
 * `DoneRule.status_name` (same convention as DEFAULT_REMAINING_STATUSES /
 * HIDDEN_BACKLOG_STATUSES). A status with NO matching rule falls back to the
 * closed-heuristic: a status OP marks closed (`status_is_closed`) counts as
 * `always_done` (it's clearly finished even if the matrix hasn't been told about
 * it); any other unmapped, still-open status is treated as `role_dependent`
 * (an unknown in-flight status is only "done" once it has left the developer's
 * hands — the same principle as new/confirmed/in progress).
 */

export interface ClassifyWithRoleResult {
  bucket: TicketDoneBucket;
  /** Set only for the `ambiguous` bucket (SPEC_14 §2: "role není nastavena pro X"). */
  ambiguous_reason: string | null;
  /** Set only for the "in progress + genuinely unassigned" case (§2/§7 #1). */
  anomaly: "unassigned_in_progress" | null;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** True when a status name reads as "in progress" (case-insensitive/trimmed). */
function isInProgress(statusName: string): boolean {
  return norm(statusName) === "in progress";
}

export function classifyWithRole(
  wp: { status_name: string; status_is_closed?: boolean },
  /** The holder's team_member.role, or null when the ticket is genuinely
   * unassigned (no holder at all — distinct from an "unset"-role holder). */
  holderRole: PersonRole | null,
  rules: DoneRule[],
  /** The holder's display name — only used to phrase the ambiguous reason. */
  holderName?: string | null,
): ClassifyWithRoleResult {
  const status = norm(wp.status_name);
  const matched = rules.find((r) => norm(r.status_name) === status);
  // Fallback for an unmapped status: closed → always_done, else role_dependent.
  const kind = matched?.kind ?? (wp.status_is_closed ? "always_done" : "role_dependent");

  if (kind === "always_done") {
    return { bucket: "done", ambiguous_reason: null, anomaly: null };
  }
  if (kind === "rejected") {
    return { bucket: "rejected", ambiguous_reason: null, anomaly: null };
  }

  // role_dependent — the outcome hinges on who holds it.
  if (holderRole === null) {
    // Genuinely unassigned: can't claim it was delivered → not done. An
    // "in progress" ticket with no assignee shouldn't exist → surface it.
    return {
      bucket: "not_done",
      ambiguous_reason: null,
      anomaly: isInProgress(wp.status_name) ? "unassigned_in_progress" : null,
    };
  }
  if (holderRole === "developer") {
    return { bucket: "not_done", ambiguous_reason: null, anomaly: null };
  }
  if (holderRole === "unset") {
    return {
      bucket: "ambiguous",
      ambiguous_reason: `role není nastavena pro ${holderName ?? "neznámá osoba"}`,
      anomaly: null,
    };
  }
  // tester / customer / other — the work left the developer's hands → done.
  return { bucket: "done", ambiguous_reason: null, anomaly: null };
}

/**
 * Increment 18 (SPEC_18 §3) — "jeden zdroj pravdy": the role-lookup half of
 * `classifyWithRole`'s inputs, factored out so BOTH `computeClosureStats`
 * (closure) and the sprint-list `/items/detailed` route (dimming) resolve a
 * holder's role identically instead of each hand-rolling their own
 * op_user_id/name → team_member lookup. `computeClosureStats` layers its own
 * extra `nameToOpUserFromLogs` id-alignment (SPEC_17 BUG 1) on TOP of this for
 * journal-reconstructed interval holders; the sprint list uses the CURRENT
 * holder straight from `work_package_cache`, which already carries a real
 * `assignee_op_id` from OP, so no extra alignment step is needed there.
 */
export interface MemberIndex {
  byOpUser: Map<number, TeamMember>;
  /** Increment 21 (SPEC_21 §3.4/§4): keyed on the TRIMMED/LOWER-CASED name, not
   * the raw display name. The holder name fed to `roleForHolder` for a
   * closed/historical ticket is `ticket_baseline.assignee_name_raw` — the raw,
   * journal-reconstructed text (Increment 13), whose casing can drift from the
   * `team_member` row's stored name (e.g. a person whose only team_member row
   * came from live sync's canonical `assignee_name` while the retro baseline
   * stored the activity-HTML casing). An exact-name lookup would then silently
   * miss the real member and misclassify the ticket as `ambiguous`/role-unset.
   * This mirrors the same `norm()` (trim+lowercase) the status side already
   * uses in `classifyWithRole`. The STORED display name is still what
   * `roleForHolder` returns as `resolvedName`, so nothing user-visible changes. */
  byName: Map<string, TeamMember>;
}

export function buildMemberIndex(members: TeamMember[]): MemberIndex {
  const byOpUser = new Map<number, TeamMember>();
  const byName = new Map<string, TeamMember>();
  for (const m of members) {
    if (m.op_user_id != null && !byOpUser.has(m.op_user_id)) byOpUser.set(m.op_user_id, m);
    const nameKey = norm(m.name);
    if (nameKey !== "" && !byName.has(nameKey)) byName.set(nameKey, m);
  }
  return { byOpUser, byName };
}

/**
 * Resolve a holder's role from an op_user_id and/or display name. Returns
 * `role: null` only for a genuinely unassigned ticket (both inputs empty) —
 * distinct from a resolved holder with no team_member row, which is
 * `role: "unset"` (routed to `ambiguous` by `classifyWithRole`, never guessed).
 */
export function roleForHolder(
  opUserId: number | null,
  name: string | null,
  idx: MemberIndex,
): { role: PersonRole | null; resolvedName: string | null } {
  if (opUserId == null && (name == null || name === "")) return { role: null, resolvedName: null };
  let m: TeamMember | undefined;
  if (opUserId != null) m = idx.byOpUser.get(opUserId);
  // Increment 21 (SPEC_21 §4): normalize the lookup name the same way the index
  // key is built (trim+lowercase), so a casing-divergent raw baseline name
  // still resolves to its real team_member. resolvedName keeps the STORED
  // display name (name if given, else the member's), never the lowercased key.
  if (!m && name) m = idx.byName.get(norm(name));
  return { role: m?.role ?? "unset", resolvedName: name ?? m?.name ?? null };
}

/** SPEC_18 §2/§6: dimming/`is_done` treats `done` AND `rejected` as "no longer
 * active work", even though Closure keeps them as separate buckets/counts. */
export function isDoneBucket(bucket: TicketDoneBucket): boolean {
  return bucket === "done" || bucket === "rejected";
}
