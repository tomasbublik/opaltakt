/**
 * Estimate-of-record resolution (SPEC_16 §5, superseding the old SPEC §6 rule).
 *
 * Precedence, highest first:
 *   1) `overrideHours` (a local `estimate_override.planning_hours`), when set —
 *      UNCHANGED top-precedence behaviour.
 *   2) `remainingHours` (OP `remainingTime`), when it is BOTH non-zero AND
 *      differs from `estimatedHours` — a ticket that has been worked down (e.g.
 *      Work 24h, Remaining 18h) plans/reports at its remaining work, not its
 *      original estimate (SPEC_16 §5 example: ticket 11765 → 18h, not 24h).
 *   3) otherwise `estimatedHours` (OP `estimatedTime`, "Work").
 *
 * The `!= 0` guard is deliberate: a fully-done ticket with `remainingHours === 0`
 * is NOT a "zero estimate" — it falls through to case 3 and keeps its Work value.
 * Likewise a never-touched ticket where `remainingHours === estimatedHours`
 * (both 10h) falls through to case 3 unchanged, so untouched tickets keep their
 * pre-Increment-16 behaviour.
 *
 * Null handling (documented choice): the case-2 comparison does NOT require
 * `estimatedHours` to be non-null. When `estimatedHours` is null and a non-zero
 * `remainingHours` is present, `remainingHours !== estimatedHours` is trivially
 * true, so the remaining value applies — a ticket that only ever carried a
 * "Remaining work" figure still gets a usable estimate. When everything is null
 * the result is null.
 */
export function effectiveEstimate(
  estimatedHours: number | null,
  remainingHours: number | null,
  overrideHours: number | null,
): number | null {
  if (overrideHours != null) return overrideHours;
  if (remainingHours != null && remainingHours !== 0 && remainingHours !== estimatedHours) {
    return remainingHours;
  }
  return estimatedHours;
}
