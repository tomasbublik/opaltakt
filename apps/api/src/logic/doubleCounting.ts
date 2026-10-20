/**
 * Double-counting guard (SPEC §6): plan at LEAF level. When a parent AND one of
 * its children are both in the sprint, only the leaves count toward the effort
 * sum; a parent that has a child present in the set is dropped from the sum and
 * flagged as a warning for the UI.
 */
export interface EffortItem {
  wp_op_id: number;
  parent_op_id: number | null;
  hours: number | null;
}

export interface DoubleCountWarning {
  parent_op_id: number;
  child_op_ids: number[];
}

export interface LeafEffortResult<T extends EffortItem> {
  /** Items that count toward the effort sum (leaves within the set). */
  leaves: T[];
  /** Sum of leaf hours (nulls treated as 0). */
  total: number;
  warnings: DoubleCountWarning[];
}

export function leafEffort<T extends EffortItem>(
  items: T[],
): LeafEffortResult<T> {
  const present = new Set(items.map((i) => i.wp_op_id));
  // Map parent → children that are also present in the set.
  const childrenByParent = new Map<number, number[]>();
  for (const it of items) {
    if (it.parent_op_id !== null && present.has(it.parent_op_id)) {
      const arr = childrenByParent.get(it.parent_op_id) ?? [];
      arr.push(it.wp_op_id);
      childrenByParent.set(it.parent_op_id, arr);
    }
  }
  const leaves = items.filter((i) => !childrenByParent.has(i.wp_op_id));
  const total = leaves.reduce((sum, i) => sum + (i.hours ?? 0), 0);
  const warnings: DoubleCountWarning[] = [...childrenByParent.entries()].map(
    ([parent_op_id, child_op_ids]) => ({ parent_op_id, child_op_ids }),
  );
  return { leaves, total, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Increment 28 (INCREMENT_28_CONTRACTS §2a) — ancestor-aware detection, DISPLAY
// ONLY.
//
// ⚠️ This is deliberately a SEPARATE function from `leafEffort()` above, and
// `leafEffort()`'s direct-parent-only traversal MUST NOT be changed: those
// leaf-sum semantics are what keep every existing total (total_planned_hours,
// scope_planned_hours, baseline_total_hours, Closure's numbers) byte-identical.
// Contracts §2b: a grandparent + grandchild pair whose middle ticket is absent
// therefore STILL double-counts in the sum — this increment's job is to make
// that visible and one-click fixable, not to silently re-do the arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

/** The minimum a row needs for ancestry detection (a cached `parent_op_id`). */
export interface AncestryItem {
  wp_op_id: number;
  parent_op_id: number | null;
}

export interface DoubleCountLinks {
  /** wp_op_ids of items in the SAME set descending from this one (direct or deeper). */
  double_count_children: number[];
  /** The NEAREST ancestor of this item that is also in the set, else null. */
  double_count_parent_of: number | null;
}

/**
 * Defensive bound on a single upward walk. Malformed OP data (a parent chain
 * that loops, or is absurdly deep) must never hang a request — the `seen` set
 * already breaks true cycles, this caps pathological depth as well.
 */
const MAX_ANCESTOR_DEPTH = 64;

/**
 * Ancestor-aware parent/child links for one set of sprint items.
 *
 * - `double_count_children` = every item in the set that descends from this one,
 *   at ANY depth (ascending order, stable).
 * - `double_count_parent_of` = the NEAREST ancestor also in the set, else null.
 *
 * `extraParents` supplies `wp_op_id → parent_op_id` edges for tickets that are
 * NOT in the sprint, so a grandparent and a grandchild still link up when the
 * intermediate ticket is absent from the sprint. Those edges come from
 * `work_package_cache` (already populated from `_links.parent`) — never from a
 * new OpenProject call.
 */
export function ancestorDoubleCounts(
  items: readonly AncestryItem[],
  extraParents: ReadonlyMap<number, number | null> = new Map(),
): Map<number, DoubleCountLinks> {
  const present = new Set(items.map((i) => i.wp_op_id));
  // Effective parent edge for any id we may traverse: an item's OWN
  // parent_op_id always wins over the out-of-sprint lookup.
  const parentOf = new Map<number, number | null>(extraParents);
  for (const it of items) parentOf.set(it.wp_op_id, it.parent_op_id);

  const result = new Map<number, DoubleCountLinks>();
  for (const it of items) {
    result.set(it.wp_op_id, { double_count_children: [], double_count_parent_of: null });
  }

  for (const it of items) {
    const seen = new Set<number>([it.wp_op_id]);
    let cursor = parentOf.get(it.wp_op_id) ?? null;
    let nearest: number | null = null;
    let depth = 0;
    while (cursor !== null && depth < MAX_ANCESTOR_DEPTH) {
      depth += 1;
      if (seen.has(cursor)) break; // cycle guard — malformed OP data
      seen.add(cursor);
      if (present.has(cursor)) {
        if (nearest === null) nearest = cursor;
        const ancestor = result.get(cursor);
        if (ancestor) ancestor.double_count_children.push(it.wp_op_id);
      }
      cursor = parentOf.get(cursor) ?? null;
    }
    const self = result.get(it.wp_op_id);
    if (self) self.double_count_parent_of = nearest;
  }

  for (const links of result.values()) links.double_count_children.sort((a, b) => a - b);
  return result;
}
