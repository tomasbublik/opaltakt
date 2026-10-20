/**
 * S1 — accountable-handoff (SPEC_03 §7, covers §2 a + b).
 *
 * One main work package travels new → confirmed → in progress → developed →
 * tested. At "Developed" the ASSIGNEE hops dev → tester, at "Tested" it is
 * parked on the customer — while the SEPARATE accountable link stays
 * "Karel Zákazník" the whole time (seeded, never touched by any event).
 * The ticket NEVER reaches a closed status (ends "Tested", isClosed=false).
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

// Calendar: day 0 = Wed 2026-07-01; days 3/4 are the weekend (no events).
export const s1AccountableHandoff: Scenario = {
  name: "s1-accountable-handoff",
  description:
    "Handoff after dev-complete: WP 1101 goes new->confirmed->in progress->developed->tested; " +
    "assignee hops dev->tester at Developed and tester->customer at Tested, while accountable " +
    "stays Karel Zakaznik the WHOLE time and the ticket never reaches a closed status " +
    "(isClosed=false). ACCEPTANCE: the app must NOT count WP 1101 as done from the " +
    "reassignment or from leaving the dev's plate alone — only a done_status_rule that " +
    "includes Developed/Tested may mark it dev-done. SUGGESTED SETUP: import Demo Project, " +
    "create sprint 2026-07-01 -> 2026-07-09 with all three WPs, then advance day by day " +
    "(days 3-4 are the weekend).",
  startDate: "2026-07-01",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      {
        key: "main",
        id: 1101,
        subject: "Implement invoice PDF export",
        project: 3,
        status: "New",
        assignee: "dev",
        accountable: "customer", // seeded up front; NO event ever changes it
        estimatedHours: 16,
        remainingHours: 16,
      },
      {
        key: "bg-login",
        id: 1102,
        subject: "Fix login form validation message",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 4,
        remainingHours: 4,
      },
      {
        key: "bg-docs",
        id: 1103,
        subject: "Update user guide for the release",
        project: 3,
        status: "Confirmed",
        assignee: "tester",
        estimatedHours: 6,
        remainingHours: 6,
      },
    ],
  },
  timeline: [
    // Day 1 (Thu): planning done, work starts on the background items.
    on(
      1,
      ev.status("main", "Confirmed"),
      ev.status("bg-login", "In progress"),
      ...work("bg-login", "dev", 2, 2),
      ev.status("bg-docs", "In progress"),
      ...work("bg-docs", "tester", 3, 3),
    ),
    // Day 2 (Fri): dev starts the main WP; docs finish dev-side.
    on(
      2,
      ev.status("main", "In progress"),
      ...work("main", "dev", 6, 10),
      ...work("bg-docs", "tester", 3, 0),
      ev.status("bg-docs", "Developed"),
    ),
    // Day 5 (Mon): steady progress; the login fix is dev-complete.
    on(
      5,
      ...work("main", "dev", 6, 4),
      ...work("bg-login", "dev", 2, 0),
      ev.status("bg-login", "Developed"),
    ),
    // Day 6 (Tue): main WP dev-complete → THE HANDOFF: status Developed and
    // assignee dev→tester. Accountable is deliberately NOT touched.
    on(
      6,
      ...work("main", "dev", 4, 0),
      ev.status("main", "Developed"),
      ev.assign("main", "tester"),
    ),
    // Day 7 (Wed): tester verifies (testing time logged, remaining stays 0).
    on(7, ...work("main", "tester", 2, 0)),
    // Day 8 (Thu): verified → Tested, parked on the customer for acceptance.
    // Still an OPEN status — the scenario ends without ever closing the WP.
    on(8, ev.status("main", "Tested"), ev.assign("main", "customer")),
  ],
};
