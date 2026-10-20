/**
 * S3 — epic-over-40h (SPEC_03 §7, covers §2 c).
 *
 * One 80h epic burns ~6-8h/day across TWO suggested sprints:
 *   Sprint A: 2026-07-01 -> 2026-07-08   (epic ends UNFINISHED, 44h remaining)
 *   Sprint B: 2026-07-09 -> 2026-07-16   (epic finishes on the last day, Tested)
 * Exercises multi-sprint sprint_items, carryover (outcome=carried), remaining
 * rollover and a burndown that crosses a sprint boundary. A few small WPs run
 * alongside so neither sprint is a single-ticket sprint.
 */
import type { Scenario } from "../scenario-types";
import { burn, cast, ev, mergeTimelines, on } from "./helpers";

// Calendar: day 0 = Wed 2026-07-01. Working days (weekends 3/4 and 10/11 are
// silent): Sprint A -> 0,1,2,5,6,7 ; Sprint B -> 8,9,12,13,14,15.
const SPRINT_A_DAYS: ReadonlyArray<readonly [number, number]> = [
  [0, 6], [1, 6], [2, 6], [5, 6], [6, 6], [7, 6], // 36h — 44h left at A's end
];
const SPRINT_B_DAYS: ReadonlyArray<readonly [number, number]> = [
  [8, 6], [9, 6], [12, 8], [13, 8], [14, 8], [15, 8], // 44h — hits 0 on day 15
];

export const s3EpicOver40h: Scenario = {
  name: "s3-epic-over-40h",
  description:
    "An 80h epic (WP 1301) spans two sprints: dev logs 6h/day, later 8h/day, remaining drops " +
    "from 80 to 44 by the end of Sprint A and to 0 (status Tested) on the last day of Sprint B. " +
    "Tests multi-sprint sprint_items, carryover (outcome=carried), remaining rollover and the " +
    "burndown across the boundary. SUGGESTED SETUP: import Demo Project, create Sprint A " +
    "2026-07-01 -> 2026-07-08 (epic + WP 1302/1303) and Sprint B 2026-07-09 -> 2026-07-16 " +
    "(epic carried over + WP 1304); close Sprint A around day 7 and carry the epic forward.",
  startDate: "2026-07-01",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      {
        key: "epic",
        id: 1301,
        subject: "EPIC: Payment gateway integration",
        type: "Epic",
        project: 3,
        status: "In progress",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 80,
        remainingHours: 80,
      },
      // Small companions so the sprints aren't single-ticket.
      {
        key: "tests-checkout",
        id: 1302,
        subject: "Write acceptance tests for checkout",
        project: 3,
        status: "In progress",
        assignee: "tester",
        accountable: "customer",
        estimatedHours: 8,
        remainingHours: 8,
      },
      {
        key: "provider-docs",
        id: 1303,
        subject: "Update payment provider documentation",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 4,
        remainingHours: 4,
      },
      {
        key: "regression",
        id: 1304,
        subject: "Regression test suite for the gateway",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 10,
        remainingHours: 10,
      },
    ],
  },
  timeline: mergeTimelines(
    // The epic: a steady dev burn across both sprints (80h total).
    burn("epic", "dev", 80, [...SPRINT_A_DAYS, ...SPRINT_B_DAYS]),
    // …finished and verified on the very last day of Sprint B.
    [on(15, ev.status("epic", "Tested"))],

    // Sprint A companions (tester).
    burn("tests-checkout", "tester", 8, [[0, 4], [1, 4]]),
    [on(1, ev.status("tests-checkout", "Resolved"))],
    [on(2, ev.status("provider-docs", "In progress"))],
    burn("provider-docs", "tester", 4, [[2, 4]]),
    [on(2, ev.status("provider-docs", "Closed"))],

    // Sprint B companion (tester).
    [on(8, ev.status("regression", "In progress"))],
    burn("regression", "tester", 10, [[8, 5], [9, 5]]),
    [on(9, ev.status("regression", "Tested"))],
  ),
};
