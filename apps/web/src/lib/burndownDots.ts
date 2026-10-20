import type { BurndownPoint } from "@osp/contracts";

/**
 * Should the burndown chart draw a DOT for this point?
 *
 * The Remaining/Logged lines render with `dot={false}` and `connectNulls` — a
 * clean line once two or more snapshot days exist. But a line needs two points
 * to draw a segment, so a sprint's FIRST day after activation (exactly one
 * snapshot) rendered nothing at all: no segment to draw, dots suppressed. The
 * user-reported symptom was "the active sprint's burndown is completely empty
 * — not even the blue Remaining line".
 *
 * The fix is deliberately minimal: a dot appears only for an ISOLATED snapshot
 * value — one with no drawable neighbour on either side — so day one shows a
 * blue/green dot at the right height, and the moment a second day lands the
 * dot yields to the normal line unchanged.
 */
export function isIsolatedSnapshotPoint(
  points: readonly BurndownPoint[],
  index: number,
  key: "remaining_hours" | "logged_hours",
): boolean {
  if (index < 0 || index >= points.length) return false;
  if ((points[index]?.[key] ?? null) == null) return false;
  const prev = index > 0 ? (points[index - 1]?.[key] ?? null) : null;
  const next = index < points.length - 1 ? (points[index + 1]?.[key] ?? null) : null;
  return prev == null && next == null;
}
