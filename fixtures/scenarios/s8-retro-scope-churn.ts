/**
 * S8 — retrospective scope churn (SPEC_12 §2/§3/§11).
 *
 * A version-tagged, multi-CALENDAR-DAY history purpose-built for the
 * retrospective-planning flow: seed a sprint from OP version "3.5.039" and
 * REPLAY it after the fact. Three tickets exercise the three retro cases:
 *
 *   - `baseline` (1801): version 3.5.039 the whole time → a plain baseline item,
 *     reconstructed to its start_date state (Confirmed, dev, 8h).
 *   - `entrant` (1802): starts on the NEIGHBOUR version 3.5.038, then on day 2
 *     its "Version changed from 3.5.038 to 3.5.039" journal makes it ENTER the
 *     sprint scope mid-window → Agent B's red / added_mid_sprint segment
 *     (versionScopeEvents → one "entered" at 2026-07-08).
 *   - `leaver` (1803): starts on 3.5.039, then on day 2 moves AWAY to 3.5.038 →
 *     LEAVES scope → Agent B's blue / removed segment (one "left" at
 *     2026-07-08).
 *
 * This is the only scenario with real Version-CHANGE journals; the S1–S7 set
 * only ever seeds a static version (S6) and never churns it, so §3 had no
 * end-to-end fixture before this. Calendar: day 0 = Mon 2026-07-06; days run
 * through Fri 2026-07-10 (all weekdays, no weekend gap), so the version change
 * on day 2 lands on Wed 2026-07-08 — comfortably after a start_date of
 * 2026-07-06 (proving "not baseline; a mid-sprint change").
 *
 * SUGGESTED SETUP: import Demo Project, create a RETROSPECTIVE sprint named for
 * version 3.5.039 over 2026-07-06 → 2026-07-10, seed from version "3.5.039",
 * then Activate → the replay reconstructs baselines + the day-2 churn.
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

export const s8RetroScopeChurn: Scenario = {
  name: "s8-retro-scope-churn",
  description:
    "Retro replay fixture (SPEC_12 §3): three project-3 tickets over Mon 2026-07-06 → Fri " +
    "2026-07-10. 1801 stays on version 3.5.039 (pure baseline); 1802 starts on 3.5.038 and its " +
    "version CHANGES to 3.5.039 on Wed 2026-07-08 (enters scope mid-sprint → red); 1803 starts " +
    "on 3.5.039 and moves to 3.5.038 the same day (leaves scope → blue). Seeding a retrospective " +
    "sprint from version 3.5.039 and replaying must reconstruct start_date baselines AND surface " +
    "the day-2 version churn as added/removed, not as baseline.",
  startDate: "2026-07-06",
  seed: {
    users: cast(),
    versions: [
      { key: "v_target", id: 41, name: "3.5.039", projectId: 3 },
      { key: "v_prev", id: 40, name: "3.5.038", projectId: 3 },
    ],
    workPackages: [
      {
        key: "baseline",
        id: 1801,
        subject: "Baseline: refactor retry backoff",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 8,
        remainingHours: 8,
        version: "v_target",
      },
      {
        key: "entrant",
        id: 1802,
        subject: "Entrant: pulled into the release mid-sprint",
        project: 3,
        status: "In progress",
        assignee: "tester",
        accountable: "customer",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_prev",
      },
      {
        key: "leaver",
        id: 1803,
        subject: "Leaver: bumped to the next release",
        project: 3,
        status: "Confirmed",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_target",
      },
    ],
  },
  timeline: [
    // Day 0 (Mon 07-06): dev picks up the baseline; the tester works the entrant.
    on(
      0,
      ev.status("baseline", "In progress"),
      ...work("baseline", "dev", 2, 6),
      ...work("entrant", "tester", 1, 5),
    ),
    // Day 1 (Tue 07-07): baseline burns down; the leaver starts.
    on(
      1,
      ...work("baseline", "dev", 2, 4),
      ev.status("leaver", "In progress"),
      ...work("leaver", "dev", 1, 3),
    ),
    // Day 2 (Wed 07-08): THE CHURN — entrant enters version 3.5.039 (red),
    // leaver moves out to 3.5.038 (blue). Baseline keeps burning.
    on(
      2,
      ev.version("entrant", "v_target"),
      ev.version("leaver", "v_prev"),
      ...work("baseline", "dev", 2, 2),
    ),
    // Day 3 (Thu 07-09): entrant dev-complete; baseline dev-complete.
    on(
      3,
      ...work("entrant", "tester", 2, 3),
      ev.status("entrant", "Developed"),
      ev.status("baseline", "Developed"),
    ),
    // Day 4 (Fri 07-10): baseline verified; entrant verified.
    on(
      4,
      ...work("baseline", "dev", 2, 0),
      ev.status("baseline", "Tested"),
      ev.status("entrant", "Tested"),
    ),
  ],
};
