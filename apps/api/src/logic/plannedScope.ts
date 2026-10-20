import { leafEffort } from "./doubleCounting";

/**
 * Increment 30 — THE canonical `Planned` computation.
 *
 * `docs/CAPACITY_BAR_RULES.md` §0 has always required "one function … never a
 * second computation", but until Increment 30 two existed:
 *
 *   • `computeCapacity` summed the estimate of every ticket CURRENTLY assigned
 *     to a person (`capacity.lines[].planned_hours`);
 *   • `computeClosureStats` summed `planned_delta_hours` over the developer's
 *     `baseline_worked` segments (`per_developer[].planned_hours`).
 *
 * They answer different questions and diverge the moment anything is added,
 * removed or handed off after activation (the reported case: 32 h currently
 * assigned vs 10 h still baseline-green). `CAPACITY_BAR_RULES.md` §5 was
 * rewritten to make CURRENT SCOPE the definition of Planned, and this module is
 * the single implementation of it. Capacity, Closure, Sprint detail and the PDF
 * all read a value produced here.
 *
 * The rule, per holder:
 *   **Σ `effectiveEstimate` over the sprint's items that are (a) currently in
 *   scope and (b) currently assigned to that holder — with parent/child
 *   double-count suppression applied.**
 *
 * Two properties this file deliberately guarantees:
 *   1. Structurally >= 0. Nothing ever subtracts from Planned; scope that LEFT a
 *      developer is reported by `scope_change_hours`, never as a negative
 *      Planned (`CAPACITY_BAR_RULES.md` §5, the Increment-17 BUG 2 fix).
 *   2. A holder whose only ticket is leaf-SUPPRESSED (a parent whose child is
 *      also in the sprint) still appears — at 0 h — via `suppressed_holders`.
 *      `CAPACITY_BAR_RULES.md` §5a: "a developer must never disappear from the
 *      panel because of leaf suppression". Increment 26 shipped exactly that
 *      regression and Increment 28 fixed it; do not reintroduce it.
 *
 * The holder key is generic on purpose — the two callers legitimately identify
 * people differently (`computeCapacity` groups by OP user id / team_member id,
 * `computeClosureStats` by the connection-scoped `personKey`). The RULE is
 * shared; the identity scheme stays each caller's own.
 */

/** One sprint item, as seen by the canonical Planned rule. */
export interface PlannedScopeItem<K> {
  wp_op_id: number;
  /** Parent work package, for the leaf-level double-count guard (SPEC §6). */
  parent_op_id: number | null;
  /**
   * The item's CURRENT holder, in the caller's own identity scheme, or `null`
   * for a genuinely unassigned item (its hours land in `unassigned_hours`).
   */
  holder_key: K | null;
  /**
   * The item's estimate of record — `effectiveEstimate` (CAPACITY_BAR_RULES §3),
   * resolved by the caller. `null` counts as 0 h (the holder still appears).
   */
  estimate_hours: number | null;
  /**
   * Is the item still in the sprint's scope? `false` for a removed /
   * removed-mid-sprint item, which contributes 0 h but whose holder keeps their
   * line (their blue reduction still renders from the segment fields).
   * Optional, defaults to `true` — callers that pre-filter removals can omit it.
   */
  in_scope?: boolean;
}

export interface PlannedScope<K> {
  /**
   * Canonical Planned per holder. Every non-null holder seen gets an entry, so a
   * 0 h holder is present rather than missing (see guarantee 2 above).
   */
  by_holder: ReadonlyMap<K, number>;
  /** Canonical Planned of the genuinely-unassigned bucket. */
  unassigned_hours: number;
  /** wp_op_ids that COUNT (leaves within the set) — the double-count guard's output. */
  leaf_ids: ReadonlySet<number>;
  /** Holders that hold at least one leaf-SUPPRESSED item (kept visible at 0 h). */
  suppressed_holders: ReadonlySet<K>;
}

export function computePlannedScope<K>(
  items: readonly PlannedScopeItem<K>[],
): PlannedScope<K> {
  // Leaf-level effort only (SPEC §6 double-counting): a parent whose child is
  // also in the sprint contributes nothing, so the pair is not counted twice.
  const { leaves } = leafEffort(
    items.map((i) => ({
      wp_op_id: i.wp_op_id,
      parent_op_id: i.parent_op_id,
      hours: i.estimate_hours,
    })),
  );
  const leaf_ids = new Set(leaves.map((l) => l.wp_op_id));

  const by_holder = new Map<K, number>();
  const suppressed_holders = new Set<K>();
  let unassigned_hours = 0;

  for (const it of items) {
    const counts = leaf_ids.has(it.wp_op_id) && (it.in_scope ?? true);
    const hours = counts ? (it.estimate_hours ?? 0) : 0;
    if (it.holder_key == null) {
      unassigned_hours += hours;
      continue;
    }
    by_holder.set(it.holder_key, (by_holder.get(it.holder_key) ?? 0) + hours);
    if (!leaf_ids.has(it.wp_op_id)) suppressed_holders.add(it.holder_key);
  }

  return { by_holder, unassigned_hours, leaf_ids, suppressed_holders };
}
