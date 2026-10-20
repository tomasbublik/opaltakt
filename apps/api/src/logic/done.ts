import type { DoneStatusRule } from "@osp/contracts";
import { statusNamesEqual } from "@osp/op-client";

/**
 * "Done" classification (SPEC §6). Default rule: a status counts as done when
 * `status_is_closed = true` and it is NOT in the rejected list. Explicit
 * done_status_rule rows override the default; rejected rules take priority.
 */
export type DoneClass = "done" | "rejected" | "open";

export function classifyStatus(
  wp: { status_name: string; status_is_closed: boolean },
  rules: DoneStatusRule[],
): DoneClass {
  // Consolidation Round (Concept 3): compare rule names against the WP's
  // status_name with the ONE shared trim+case-fold comparator, NOT a raw `===`.
  // Persisted status_name casing can diverge from a rule's stored casing (the
  // Increment-21 bug pattern) — a raw match here silently misclassifies.
  const matches = (counts: DoneStatusRule["counts_as"]): boolean =>
    rules.some((r) => r.counts_as === counts && statusNamesEqual(r.status_name, wp.status_name));
  if (matches("rejected")) return "rejected";
  if (matches("done")) return "done";
  // Default: closed & not rejected → done.
  return wp.status_is_closed ? "done" : "open";
}

/** True when this WP should be treated as completed (for velocity/closure). */
export function isDone(
  wp: { status_name: string; status_is_closed: boolean },
  rules: DoneStatusRule[],
): boolean {
  return classifyStatus(wp, rules) === "done";
}
