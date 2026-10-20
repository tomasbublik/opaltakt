import type { BurndownPoint, BurndownResponse, BurndownSnapshot } from "@osp/contracts";

/**
 * Burndown math (SPEC §6). Two/three curves over the sprint's WORKING days
 * (weekends skipped):
 *  - ideal    : linear from total planned effort down to 0 across working days.
 *  - remaining: Σ remaining_hours of open tickets at snapshot_date (done → 0).
 *  - logged   : Σ time entries by spentOn up to the day (burnup).
 * remaining/logged come from persisted burndown_snapshot rows (history);
 * future days (no snapshot yet) are null.
 */

/** Inclusive list of working-day ISO dates (YYYY-MM-DD) between start & end. */
export function workingDays(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  for (
    let d = new Date(start);
    d.getTime() <= end.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dow = d.getUTCDay(); // 0 = Sun, 6 = Sat
    if (dow !== 0 && dow !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
  }
  return out;
}

/** Linear ideal remaining per working day: total at day 0 → 0 on the last day. */
export function idealCurve(totalPlanned: number, dayCount: number): number[] {
  if (dayCount <= 0) return [];
  if (dayCount === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < dayCount; i++) {
    out.push((totalPlanned * (dayCount - 1 - i)) / (dayCount - 1));
  }
  return out;
}

/** Round to 1 decimal place (SPEC_11 §7 tooltip formatting); null passes through. */
function round1(n: number): number;
function round1(n: number | null): number | null;
function round1(n: number | null): number | null {
  if (n === null) return null;
  return Math.round(n * 10) / 10;
}

export function buildBurndown(
  sprint: { id: number; start_date: string; end_date: string },
  totalPlanned: number,
  snapshots: BurndownSnapshot[],
): BurndownResponse {
  const days = workingDays(sprint.start_date, sprint.end_date);
  const ideal = idealCurve(totalPlanned, days.length);
  const byDate = new Map(snapshots.map((s) => [s.snapshot_date, s]));

  // SPEC_11 §7: numbers are rounded to 1 decimal at this response-construction
  // boundary (e.g. 54.333333 → 54.3), NOT by mutating stored snapshot precision.
  const points: BurndownPoint[] = days.map((date, i) => {
    const snap = byDate.get(date);
    return {
      date,
      ideal_hours: round1(ideal[i] ?? 0),
      remaining_hours: round1(snap ? snap.remaining_hours : null),
      logged_hours: round1(snap ? snap.logged_hours : null),
      done_count: snap ? snap.done_count : null,
      total_count: snap ? snap.total_count : null,
      // Increment 12 (SPEC_12 §1/§5): live vs reconstructed provenance; null for
      // a future/un-snapshotted day (same days remaining/logged are null for).
      source: snap ? snap.source : null,
    };
  });

  return {
    sprint_id: sprint.id,
    start_date: sprint.start_date,
    end_date: sprint.end_date,
    total_planned_hours: totalPlanned,
    points,
  };
}
