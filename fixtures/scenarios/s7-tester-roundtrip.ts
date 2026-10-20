/**
 * S7 — tester-roundtrip (SPEC_10 §d, reproduces bug #11762).
 *
 * ONE work package makes the round trip that broke the changelog parser: dev
 * develops it, HANDS IT to the tester (assignee change), the tester LOGS TIME,
 * POSTS A COMMENT, then RETURNS it to the dev (assignee change back). The old
 * inline parser only read `details[0]` and choked on the return activity,
 * showing `unrecognized property "undefined"` instead of the reassignment and
 * dropping the comment entirely. This scenario gives the robust parser
 * (packages/op-client/src/journal.ts) and the QA suite real, faithfully-shaped
 * OP activities to assert against.
 *
 * ACCEPTANCE (SPEC_10 §d): the ticket's history must show assignee dev→tester,
 * the logged 0.7h, a content-free comment_added, and assignee tester→dev — with
 * NO `unrecognized property "undefined"` and NO empty `—` row.
 *
 * Calendar: day 0 = Mon 2026-07-06; days 1–4 are Tue–Fri (all weekdays, no
 * weekend gap) so the four handoff steps land on consecutive working days.
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

export const s7TesterRoundtrip: Scenario = {
  name: "s7-tester-roundtrip",
  description:
    "Reproduces bug #11762: WP 11762 is developed by dev, then travels dev->tester (assignee " +
    "change, day 1), the tester logs 0.7h (day 2), posts a comment (day 3), and RETURNS it " +
    "tester->dev (assignee change, day 4). The return activity is exactly the shape that broke " +
    "the old details[0]-only parser. ACCEPTANCE: the changelog shows both reassignments, the " +
    "logged time, and a content-free comment_added — and NEVER an 'unrecognized property " +
    "\"undefined\"' or an empty '—' row. SUGGESTED SETUP: import Demo Project, create a sprint " +
    "over WP 11762, then advance day by day (0=Mon 2026-07-06 through 4=Fri 2026-07-10).",
  startDate: "2026-07-06",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      {
        key: "wp",
        id: 11762,
        subject: "Fix payment-gateway timeout on retry",
        project: 3,
        status: "In progress",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 8,
        remainingHours: 2,
      },
    ],
  },
  timeline: [
    // Day 1 (Tue): dev-complete -> hand off to the tester. Default actor is the
    // OUTGOING assignee (dev), i.e. "dev handed it over".
    on(1, ev.assign("wp", "tester")),
    // Day 2 (Wed): the tester verifies and logs 0.7h (remaining edges down).
    on(2, ...work("wp", "tester", 0.7, 1.3)),
    // Day 3 (Thu): the tester leaves a comment (content-free comment_added).
    on(3, ev.comment("wp", "tester", "Reproduced on staging; kicking it back to dev.")),
    // Day 4 (Fri): THE RETURN -> assignee tester->dev. Default actor is the
    // outgoing tester, i.e. "returned from the tester" (the #11762 activity).
    on(4, ev.assign("wp", "dev")),
  ],
};
