import { describe, expect, it } from "vitest";
import type { BurndownPoint } from "@osp/contracts";
import { isIsolatedSnapshotPoint } from "./burndownDots";

// The user-reported symptom this pins: a sprint's FIRST day after activation
// has exactly one snapshot, and with `dot={false}` the chart rendered nothing
// at all — no segment to draw, dots suppressed. An isolated snapshot value
// must produce a dot; the moment a neighbouring day exists, the line takes
// over and the dot disappears again.

function point(over: Partial<BurndownPoint> & { date: string }): BurndownPoint {
  return {
    ideal_hours: 100,
    remaining_hours: null,
    logged_hours: null,
    done_count: null,
    total_count: null,
    source: null,
    ...over,
  };
}

describe("isIsolatedSnapshotPoint — dot only when a value has no drawable neighbour", () => {
  it("a single snapshot day in the sprint (activation day) gets a dot", () => {
    const points = [
      point({ date: "2026-08-17" }),
      point({ date: "2026-08-18", remaining_hours: 190.2, logged_hours: 185.6, source: "live" }),
      point({ date: "2026-08-19" }),
    ];
    expect(isIsolatedSnapshotPoint(points, 1, "remaining_hours")).toBe(true);
    expect(isIsolatedSnapshotPoint(points, 1, "logged_hours")).toBe(true);
  });

  it("no dot once a neighbouring day has data — the line draws the segment instead", () => {
    const points = [
      point({ date: "2026-08-18", remaining_hours: 190.2 }),
      point({ date: "2026-08-19", remaining_hours: 180 }),
      point({ date: "2026-08-20" }),
    ];
    expect(isIsolatedSnapshotPoint(points, 0, "remaining_hours")).toBe(false);
    expect(isIsolatedSnapshotPoint(points, 1, "remaining_hours")).toBe(false);
  });

  it("a null point never gets a dot, whatever its neighbours", () => {
    const points = [
      point({ date: "2026-08-18", remaining_hours: 190.2 }),
      point({ date: "2026-08-19" }),
      point({ date: "2026-08-20", remaining_hours: 170 }),
    ];
    expect(isIsolatedSnapshotPoint(points, 1, "remaining_hours")).toBe(false);
  });

  it("per-series independence: Remaining isolated while Logged has neighbours (and vice versa)", () => {
    const points = [
      point({ date: "2026-08-18", logged_hours: 3 }),
      point({ date: "2026-08-19", remaining_hours: 190.2, logged_hours: 5 }),
      point({ date: "2026-08-20" }),
    ];
    expect(isIsolatedSnapshotPoint(points, 1, "remaining_hours")).toBe(true);
    expect(isIsolatedSnapshotPoint(points, 1, "logged_hours")).toBe(false);
  });

  it("edges: an isolated value on the first or last day still gets a dot; out-of-range never does", () => {
    const first = [point({ date: "2026-08-17", remaining_hours: 10 }), point({ date: "2026-08-18" })];
    const last = [point({ date: "2026-08-17" }), point({ date: "2026-08-18", remaining_hours: 10 })];
    expect(isIsolatedSnapshotPoint(first, 0, "remaining_hours")).toBe(true);
    expect(isIsolatedSnapshotPoint(last, 1, "remaining_hours")).toBe(true);
    expect(isIsolatedSnapshotPoint(first, -1, "remaining_hours")).toBe(false);
    expect(isIsolatedSnapshotPoint(first, 2, "remaining_hours")).toBe(false);
  });

  it("a middle isolated island (data, gap, data, gap, data) dots only truly isolated values", () => {
    const points = [
      point({ date: "d1", remaining_hours: 9 }),
      point({ date: "d2" }),
      point({ date: "d3", remaining_hours: 7 }),
      point({ date: "d4" }),
      point({ date: "d5", remaining_hours: 5 }),
    ];
    expect(isIsolatedSnapshotPoint(points, 0, "remaining_hours")).toBe(true);
    expect(isIsolatedSnapshotPoint(points, 2, "remaining_hours")).toBe(true);
    expect(isIsolatedSnapshotPoint(points, 4, "remaining_hours")).toBe(true);
  });
});
