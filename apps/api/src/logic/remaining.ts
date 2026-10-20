import { DEFAULT_REMAINING_STATUSES, type RemainingStatusRule } from "@osp/contracts";

/**
 * Burndown "Remaining" (blue-line) classification (SPEC_11 §6). Mirrors the
 * shape of ./done.ts: a PURE, override-free predicate driven by the sprint's
 * `remaining_status_rule` rows.
 *
 * A ticket counts toward Remaining only when its status is in the sprint's
 * remaining allowlist — a POSITIVE allowlist, so On Hold / Developed / Tested /
 * Resolved / Closed / Rejected are excluded by construction (they simply aren't
 * in the default set). Like `done_status_rule`, the table is EMPTY by default:
 * when a sprint has zero rows we fall back to DEFAULT_REMAINING_STATUSES
 * (New, Confirmed, In progress). Matching is case-insensitive/trimmed — the
 * same convention as apps/api's HIDDEN_BACKLOG_STATUSES — because OP status
 * display names vary in case per project/server.
 */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** The effective set of "still dev-pending" status names for a sprint. */
export function remainingStatusSet(rules: RemainingStatusRule[]): Set<string> {
  const names =
    rules.length > 0 ? rules.map((r) => r.status_name) : [...DEFAULT_REMAINING_STATUSES];
  return new Set(names.map(norm));
}

/**
 * True when this WP's status counts toward the burndown Remaining line. Note
 * the CALLER still applies the "has a non-null estimate" filter (SPEC_11 §6:
 * only tickets WITH an estimate contribute) — this predicate is status-only,
 * exactly like isDone() is status-only.
 */
export function isRemaining(
  wp: { status_name: string },
  rules: RemainingStatusRule[],
): boolean {
  return remainingStatusSet(rules).has(norm(wp.status_name));
}
