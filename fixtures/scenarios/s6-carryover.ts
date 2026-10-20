/**
 * S6 — carryover (SPEC_03 §7, covers §2 b + c).
 *
 * A sprint that ends with two UNFINISHED work packages sitting in "On hold"
 * (blocked, 4h left) and "Merge pending" (1h left) while the other three end
 * Resolved/Closed/Tested. Exercises the closure report (outcome=carried), the
 * return of carryover to the backlog and the version-export deep-link: the
 * seed contains BOTH v1.0 (the sprint's version) and v1.1 (the next one), so
 * moving the carryover to a new version in OP has a real target.
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

export const s6Carryover: Scenario = {
  name: "s6-carryover",
  description:
    "Sprint closure with leftovers: five WPs (1601-1605, all version v1.0); by sprint end " +
    "1601=Resolved, 1602=Closed, 1603=Tested, but 1604 is 'On hold' (4h left, blocked on SMS " +
    "provider credentials) and 1605 is 'Merge pending' (1h left). OPERATOR FLOW: import Demo " +
    "Project, create sprint 2026-07-01 -> 2026-07-09 with all five, advance through day 7 " +
    "(sync + snapshot daily), then CLOSE the sprint in the app: the closure report must show " +
    "1604+1605 as carried (open statuses, remaining > 0) and return them to the backlog; " +
    "finish with the version-export deep-link and re-target the carryover to version v1.1 in " +
    "OP (v1.1 is seeded so the target exists).",
  startDate: "2026-07-01",
  seed: {
    users: cast(),
    versions: [
      { key: "v1_0", id: 31, name: "v1.0", projectId: 3 },
      // The NEXT version — the deep-link target for the carried-over items.
      { key: "v1_1", id: 32, name: "v1.1", projectId: 3 },
    ],
    workPackages: [
      {
        key: "dashboard",
        id: 1601,
        subject: "Rework dashboard widgets",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 10,
        remainingHours: 10,
        version: "v1_0",
      },
      {
        key: "browser-pass",
        id: 1602,
        subject: "Cross-browser test pass",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 8,
        remainingHours: 8,
        version: "v1_0",
      },
      {
        key: "pagination",
        id: 1603,
        subject: "API pagination fixes",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 12,
        remainingHours: 12,
        version: "v1_0",
      },
      {
        key: "sms",
        id: 1604,
        subject: "Integrate SMS provider",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 9,
        remainingHours: 9,
        version: "v1_0",
      },
      {
        key: "rate-limiter",
        id: 1605,
        subject: "Rate limiter middleware",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v1_0",
      },
    ],
  },
  timeline: [
    // Day 0 (Wed): dev on the dashboard, tester starts the browser pass.
    on(
      0,
      ev.status("dashboard", "In progress"),
      ...work("dashboard", "dev", 6, 4),
      ev.status("browser-pass", "In progress"),
      ...work("browser-pass", "tester", 4, 4),
    ),
    // Day 1 (Thu): dashboard dev-complete, browser pass finished.
    on(
      1,
      ...work("dashboard", "dev", 4, 0),
      ev.status("dashboard", "Developed"),
      ...work("browser-pass", "tester", 4, 0),
    ),
    // Day 2 (Fri): browser pass signed off; dev moves to pagination.
    on(
      2,
      ev.status("browser-pass", "Closed"),
      ev.status("pagination", "In progress"),
      ...work("pagination", "dev", 6, 6),
    ),
    // Day 5 (Mon): pagination dev-complete; dashboard accepted.
    on(
      5,
      ...work("pagination", "dev", 6, 0),
      ev.status("pagination", "Developed"),
      ev.status("dashboard", "Resolved"),
    ),
    // Day 6 (Tue): tester verifies pagination -> Tested. The SMS integration
    // hits a blocker (waiting for provider sandbox credentials) with 4h left.
    on(
      6,
      ...work("pagination", "tester", 2, 0),
      ev.status("pagination", "Tested"),
      ev.status("sms", "In progress"),
      ...work("sms", "dev", 5, 4),
      ev.status("sms", "On hold"),
    ),
    // Day 7 (Wed): rate limiter coded but stuck in review at sprint end.
    on(
      7,
      ev.status("rate-limiter", "In progress"),
      ...work("rate-limiter", "dev", 5, 1),
      ev.status("rate-limiter", "Merge pending"),
    ),
    // Sprint end (2026-07-09): 1604 "On hold" (4h) and 1605 "Merge pending"
    // (1h) remain open -> the app's closure must carry exactly these two.
  ],
};
