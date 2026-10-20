/**
 * S5 — burndown-happy (SPEC_03 §7).
 *
 * The baseline: a clean sprint. Five WPs summing 60h, steady paired
 * logTime + setRemaining every working day, everything Resolved/Closed by
 * day 8. The burndown should be a tidy staircase with no scope changes:
 *   remaining total: 60 -> 49 -> 38 -> 30 -> (weekend) -> 19 -> 8 -> 2 -> 0.
 */
import type { Scenario } from "../scenario-types";
import { burn, cast, ev, mergeTimelines, on } from "./helpers";

export const s5BurndownHappy: Scenario = {
  name: "s5-burndown-happy",
  description:
    "Baseline happy-path burndown: five WPs (1501-1505) summing 60h, clean daily logging with " +
    "explicit remaining, zero scope churn, everything Resolved/Closed by day 8. Total remaining " +
    "steps 60/49/38/30/(weekend)/19/8/2/0. SUGGESTED SETUP: import Demo Project, create sprint " +
    "2026-07-01 -> 2026-07-09 with all five WPs, then advance a day at a time with the " +
    "sync+snapshot helper enabled and watch the burndown draw itself.",
  startDate: "2026-07-01",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      {
        key: "reports",
        id: 1501,
        subject: "Implement report scheduling",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 16,
        remainingHours: 16,
      },
      {
        key: "settings",
        id: 1502,
        subject: "Migrate settings storage",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 14,
        remainingHours: 14,
      },
      {
        key: "test-plan",
        id: 1503,
        subject: "Test plan for the reporting module",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 12,
        remainingHours: 12,
      },
      {
        key: "staging",
        id: 1504,
        subject: "Verify migrations on staging",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 10,
        remainingHours: 10,
      },
      {
        key: "csv",
        id: 1505,
        subject: "Add CSV export to lists",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        estimatedHours: 8,
        remainingHours: 8,
      },
    ],
  },
  // Working days: 0,1,2 (Wed-Fri), weekend, 5,6,7,8 (Mon-Thu).
  timeline: mergeTimelines(
    // dev: reports (days 0-2) -> settings (2,5,6) -> csv (7,8).
    [on(0, ev.status("reports", "In progress"))],
    burn("reports", "dev", 16, [[0, 6], [1, 6], [2, 4]]),
    [on(2, ev.status("reports", "Resolved"), ev.status("settings", "In progress"))],
    burn("settings", "dev", 14, [[2, 2], [5, 6], [6, 6]]),
    [on(6, ev.status("settings", "Closed"))],
    [on(7, ev.status("csv", "In progress"))],
    burn("csv", "dev", 8, [[7, 6], [8, 2]]),
    [on(8, ev.status("csv", "Resolved"))],

    // tester: test-plan (days 0-2) -> staging (5,6).
    [on(0, ev.status("test-plan", "In progress"))],
    burn("test-plan", "tester", 12, [[0, 5], [1, 5], [2, 2]]),
    [on(2, ev.status("test-plan", "Resolved"))],
    [on(5, ev.status("staging", "In progress"))],
    burn("staging", "tester", 10, [[5, 5], [6, 5]]),
    [on(6, ev.status("staging", "Closed"))],
  ),
};
