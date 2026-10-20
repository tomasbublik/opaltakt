import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import { BurndownResponse, SprintResponse } from "@osp/contracts";
import {
  buildBurndown,
  idealCurve,
  workingDays,
} from "../../apps/api/src/logic/burndown";
import { bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * Burndown math on a KNOWN input (SPEC §6 + §9 Agent D duty #3).
 *
 * Fixed sprint: 2026-06-22 (Mon) → 2026-06-26 (Fri) = 5 WORKING days.
 * Total planned effort = 40h. The IDEAL curve is a straight line from the total
 * on day 0 down to 0 on the final working day; every number below is computed by
 * hand and asserted exactly.
 *
 *   day (working)   ideal_hours
 *   2026-06-22          40
 *   2026-06-23          30
 *   2026-06-24          20
 *   2026-06-25          10
 *   2026-06-26           0
 */

const START = "2026-06-22";
const END = "2026-06-26";
const TOTAL = 40;
const EXPECTED_DAYS = [
  "2026-06-22",
  "2026-06-23",
  "2026-06-24",
  "2026-06-25",
  "2026-06-26",
];
const EXPECTED_IDEAL = [40, 30, 20, 10, 0];

describe("burndown math — pure calc (hand-computed)", () => {
  it("workingDays lists inclusive weekdays and skips weekends", () => {
    expect(workingDays(START, END)).toEqual(EXPECTED_DAYS);
    // Fri 06-19 → Tue 06-23 spans a weekend (Sat 06-20, Sun 06-21 dropped).
    expect(workingDays("2026-06-19", "2026-06-23")).toEqual([
      "2026-06-19",
      "2026-06-22",
      "2026-06-23",
    ]);
  });

  it("idealCurve is a linear descent from total to 0 over the working days", () => {
    expect(idealCurve(TOTAL, 5)).toEqual(EXPECTED_IDEAL);
    // Degenerate spans.
    expect(idealCurve(TOTAL, 1)).toEqual([0]);
    expect(idealCurve(TOTAL, 0)).toEqual([]);
    // A different total keeps the ratios exact.
    expect(idealCurve(20, 5)).toEqual([20, 15, 10, 5, 0]);
  });

  it("buildBurndown merges persisted snapshots and leaves future days null", () => {
    const res = buildBurndown(
      { id: 7, start_date: START, end_date: END },
      TOTAL,
      [
        {
          id: 1,
          sprint_id: 7,
          snapshot_date: "2026-06-22",
          remaining_hours: 40,
          logged_hours: 0,
          ideal_hours: 40,
          done_count: 0,
          total_count: 1,
          source: "live",
        },
        {
          id: 2,
          sprint_id: 7,
          snapshot_date: "2026-06-24",
          remaining_hours: 22,
          logged_hours: 18,
          ideal_hours: 20,
          done_count: 0,
          total_count: 1,
          source: "live",
        },
      ],
    );
    expect(res.total_planned_hours).toBe(40);
    expect(res.points.map((p) => p.date)).toEqual(EXPECTED_DAYS);
    expect(res.points.map((p) => p.ideal_hours)).toEqual(EXPECTED_IDEAL);
    // Snapshotted days carry the recorded remaining/logged.
    expect(res.points[0]).toMatchObject({
      date: "2026-06-22",
      ideal_hours: 40,
      remaining_hours: 40,
      logged_hours: 0,
      done_count: 0,
      total_count: 1,
    });
    expect(res.points[2]).toMatchObject({
      date: "2026-06-24",
      ideal_hours: 20,
      remaining_hours: 22,
      logged_hours: 18,
    });
    // Days without a snapshot are null (future / not yet captured).
    for (const i of [1, 3, 4]) {
      expect(res.points[i]!.remaining_hours).toBeNull();
      expect(res.points[i]!.logged_hours).toBeNull();
      expect(res.points[i]!.done_count).toBeNull();
      expect(res.points[i]!.total_count).toBeNull();
    }
  });
});

describe("burndown math — driven through the real GET /sprints/:id/burndown", () => {
  let mock: RecordingMockOpServer;
  let harness: RealApp;
  let sprintId: number;

  beforeAll(async () => {
    mock = await createRecordingMockOpServer();
    harness = await bootRealApp();
    // Connect (vault init + connection) + sync so the WP cache is populated.
    await connectToOp(harness.app, mock.url, "t", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: "Burndown sprint",
      start_date: START,
      end_date: END,
    });
    sprintId = SprintResponse.parse(created.json).id;

    // WP 1003 is a leaf (parent null, no children in the sprint). Add it with an
    // explicit planned_hours snapshot of 40 → total leaf planned effort = 40.
    await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, {
      wp_op_id: 1003,
      planned_hours: 40,
    });

    // Seed two burndown snapshots directly (as the nightly job would).
    await harness.repos.burndown.upsert({
      sprint_id: sprintId,
      snapshot_date: "2026-06-22",
      remaining_hours: 40,
      logged_hours: 0,
      ideal_hours: 40,
      done_count: 0,
      total_count: 1,
      source: "live",
    });
    await harness.repos.burndown.upsert({
      sprint_id: sprintId,
      snapshot_date: "2026-06-24",
      remaining_hours: 22,
      logged_hours: 18,
      ideal_hours: 20,
      done_count: 0,
      total_count: 1,
      source: "live",
    });
  });

  afterAll(async () => {
    await harness.close();
    await mock.close();
  });

  it("returns the exact hand-computed ideal/remaining/logged series", async () => {
    const res = await call(
      harness.app,
      "GET",
      `/api/sprints/${sprintId}/burndown`,
    );
    expect(res.status).toBe(200);
    const bd = BurndownResponse.parse(res.json);

    expect(bd.total_planned_hours).toBe(40);
    expect(bd.points.map((p) => p.date)).toEqual(EXPECTED_DAYS);
    expect(bd.points.map((p) => p.ideal_hours)).toEqual(EXPECTED_IDEAL);
    expect(bd.points.map((p) => p.remaining_hours)).toEqual([
      40,
      null,
      22,
      null,
      null,
    ]);
    expect(bd.points.map((p) => p.logged_hours)).toEqual([
      0,
      null,
      18,
      null,
      null,
    ]);
  });
});
