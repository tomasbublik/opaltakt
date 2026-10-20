import type { SprintItemDetail } from "@osp/contracts";

/**
 * Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2a) — two always-present
 * fields Agent B is adding directly to `SprintItemDetail` in
 * `packages/contracts` (owned by Agent B, not this frontend-only agent):
 *
 *   double_count_children: wp_op_ids of items in THIS sprint descending from
 *     this one (direct or deeper — ancestor-aware, §2a).
 *   double_count_parent_of: the wp_op_id of the NEAREST ancestor of this item
 *     that is also in the sprint, else null.
 *
 * This file may run ahead of that contract change landing, so the fields are
 * modelled here as a local augmentation rather than assumed present on the
 * imported `SprintItemDetail` type. `withDoubleCount` defaults them to
 * "nothing flagged" (`[]` / `null`) if the backend hasn't shipped them yet,
 * so the UI stays inert (no badges, no warning) instead of crashing. Once
 * `packages/contracts` carries the real fields, this becomes a no-op
 * pass-through of the same shape — nothing here needs to change.
 */
export interface DoubleCountFields {
  double_count_children: number[];
  double_count_parent_of: number | null;
}

export type SprintItemDetailDC = SprintItemDetail & DoubleCountFields;

export function withDoubleCount(item: SprintItemDetail): SprintItemDetailDC {
  const dc = item as SprintItemDetail & Partial<DoubleCountFields>;
  return {
    ...item,
    double_count_children: dc.double_count_children ?? [],
    double_count_parent_of: dc.double_count_parent_of ?? null,
  };
}

/**
 * SPEC §2d — one warning group: a flagged parent (per the backend's
 * ancestor-aware detection) and the child tickets — also in this sprint —
 * that descend from it. Built straight off the enriched sprint items; there
 * is deliberately no client-side re-derivation of the parent/child
 * relationship (SPEC §2a: "ONE implementation, backend").
 */
export interface DoubleCountGroup {
  parent_op_id: number;
  child_op_ids: number[];
}

export function doubleCountGroups(items: readonly SprintItemDetailDC[]): DoubleCountGroup[] {
  return items
    .filter((it) => it.double_count_children.length > 0)
    .map((it) => ({ parent_op_id: it.op_id, child_op_ids: it.double_count_children }));
}

/** Shared badge/warning copy (SPEC §2a/§2d), British English (Increment 16 convention). */
export const DOUBLE_COUNT_TOOLTIP =
  "A parent and its child are both in the sprint — hours may be counted twice. Plan at leaf level.";
