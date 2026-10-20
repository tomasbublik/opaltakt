/**
 * S18 — nightly AU ticket (SPEC_25: retroactive ticket add).
 *
 * A ticket is born, coded, merged AND tested overnight in Australia, before the
 * European workday even starts. It NEVER made it into a sprint and is NOT in the
 * backlog — its status is "Tested", one of apps/api's HIDDEN_BACKLOG_STATUSES
 * ("closed"/"resolved"/"rejected"/"tested"), so the backlog view hides it. The
 * only trace it left is real logged time: the developer (Dev Dvořák) burned it
 * down across two nights. The app must still let a planner ADD IT BY ID directly
 * to an active sprint and BACKDATE the scope change to the day work actually
 * began.
 *
 * WHY THIS FIXTURE EXISTS (SPEC_25 §4 / §8):
 *  - `fetchEarliestTimeEntryDate` (packages/op-client/src/paginate.ts) must find
 *    the EARLIEST `spentOn` = 2026-07-06 (the first of the two logged nights),
 *    which becomes the retroactive `added_at` (retro_source = 'first_time_entry').
 *  - The ticket is DONE (Tested): the done-matrix (Inc 14) marks it complete, the
 *    sprint list dims it (Inc 18), and because `remaining = 0` the effective
 *    estimate falls back to Work (Inc 16).
 *  - Its holder is a DEVELOPER (Dev Dvořák) who logged the time, so the capacity
 *    bar has someone to attribute a RED segment / DELIVERED hours to (SPEC_17
 *    case e: outside baseline + developer logged → red, counts to ±Change and
 *    Delivered, NOT to Planned).
 *
 * Distinct, memorable OP id: 25025 (SPEC_25 → "the nightly AU ticket"). Agent B
 * (apps/api) and Agent D (e2e) both target this id. Total logged: 6h — 4h on
 * 2026-07-06 (Mon) + 2h on 2026-07-07 (Tue). Earliest spentOn = 2026-07-06.
 *
 * The people are the shared cast (helpers.ts) — no new identity surface: dev =
 * Dev Dvořák (id 1, the developer + /users/me), tester = Tereza Testerová,
 * customer = Karel Zákazník. The two time entries are SEED entries (they predate
 * day 0 on purpose: the work happened "overnight" before we look), so the ticket
 * arrives already-done with a full logged history and an empty timeline.
 */
import type { Scenario } from "../scenario-types";
import { cast } from "./helpers";

/** The nightly Australian ticket's OP id — shared with Agent B/D. */
export const NIGHTLY_AU_WP_ID = 25025;

export const s18NightlyAuTicket: Scenario = {
  name: "s18-nightly-au-ticket",
  description:
    "SPEC_25 retroactive add: WP 25025 ('nightly AU ticket') was coded, merged and TESTED " +
    "overnight in Australia — it never entered a sprint and is NOT in the backlog (status " +
    "'Tested' is a HIDDEN_BACKLOG_STATUS). Its only trace is real logged time: Dev Dvořák " +
    "(developer) booked 4h on 2026-07-06 and 2h on 2026-07-07 (6h total, remaining 0). " +
    "ACCEPTANCE: the ticket can be ADDED BY ID (25025) to an active sprint, backdated to the " +
    "first spentOn 2026-07-06 (retro_source=first_time_entry); it lands as a mid-sprint " +
    "addition, dimmed (done), red capacity segment for Dev Dvořák, in Delivered and ±Change " +
    "but NOT Planned; burndown shows the scope jump on 2026-07-06, not today. SUGGESTED SETUP: " +
    "import Demo Project, create an ACTIVE sprint, then add ticket 25025 by id.",
  startDate: "2026-07-08",
  seed: {
    users: cast(),
    versions: [],
    workPackages: [
      {
        key: "nightly",
        id: NIGHTLY_AU_WP_ID,
        subject: "Nightly AU hotfix: clamp settlement batch window",
        project: 3,
        status: "Tested",
        // Held by the developer who did (and logged) the work — the Delivered /
        // red-segment attribution target (SPEC_17 case e).
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 5,
        // Done: remaining 0 → effectiveEstimate falls back to Work (Inc 16).
        remainingHours: 0,
      },
    ],
    // The two "overnight" nights of logged work, seeded BEFORE day 0 (startDate
    // 2026-07-08) — the ticket is already complete by the time a planner looks.
    // Earliest spentOn 2026-07-06 is the backdated added_at (SPEC_25 §4).
    timeEntries: [
      { wp: "nightly", user: "dev", hours: 4, spentOn: "2026-07-06" },
      { wp: "nightly", user: "dev", hours: 2, spentOn: "2026-07-07" },
    ],
  },
  // No timeline: the ticket arrives already-done with its full logged history.
  timeline: [],
};
