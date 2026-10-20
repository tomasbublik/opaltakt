import type { VelocityHistoryEntry, VelocityResponse } from "@osp/contracts";

/**
 * Velocity (SPEC §6): average completed_hours over the last N closed sprints →
 * recommended capacity for the next sprint. Input must be newest-first.
 */
export const DEFAULT_VELOCITY_WINDOW = 3;

export function computeVelocity(
  closedNewestFirst: VelocityHistoryEntry[],
  window: number = DEFAULT_VELOCITY_WINDOW,
): VelocityResponse {
  const history = closedNewestFirst.slice(0, Math.max(0, window));
  if (history.length === 0) {
    return {
      history,
      window: history.length,
      average_completed_hours: null,
      recommended_capacity_hours: null,
    };
  }
  const avg =
    history.reduce((s, h) => s + h.completed_hours, 0) / history.length;
  return {
    history,
    window: history.length,
    average_completed_hours: avg,
    recommended_capacity_hours: avg,
  };
}
