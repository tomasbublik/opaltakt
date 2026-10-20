/**
 * S9 — role-driven closure matrix (SPEC_14 §2, real sprint 3.5.039).
 *
 * The canonical fixture for Increment 14's central claim: "done" cannot be read
 * off the STATUS alone — it needs STATUS × the ROLE of the ticket's holder. This
 * scenario reproduces the exact 11-ticket sprint 3.5.039 from SPEC_14 §2, whose
 * confirmed answer is **Done 9 / Not done 2** once roles are set. The two
 * NOT-DONE tickets are the only ones held by a Developer in a role-dependent
 * status (`in progress`): #11592 (Zbynek Trnka) and #11765 (Tobias Bubenik).
 * Every `tested`/`resolved`/`closed` ticket is done by STATUS regardless of role;
 * #11726 (`on hold`, Jindrich Benda) and #11747 (`in progress`, David Cesal) are
 * done only because their holders are Customers ("left the developer's hands").
 *
 * ROLES ARE NOT PART OF THIS FIXTURE. Role is a LOCAL, per-app-instance attribute
 * (`team_member.role`, set via `PUT /api/people/:id/role` — Agent B), applied on
 * top of the team_member rows auto-materialized from these assignees. This file
 * only provides the OP-side truth (subject / status / assignee / logged time) so
 * that, once the roles below are set, the done-matrix comes out as SPEC_14 §2:
 *
 *   holder → role to set later:
 *     Zbynek Trnka  → Developer   (11592 stays NOT done)
 *     Tobias Bubenik    → Developer   (11765 stays NOT done)
 *     Jindrich Benda     → Customer    (11726 on hold  → done via role)
 *     David Cesal  → Customer    (11747 in progress → done via role)
 *     Daniel Brabec     → Tester      (no ticket held; logs tester time on 11687)
 *     everyone else   → status alone already proves done
 *
 * Logged time is attributed by WHO LOGGED IT (SPEC_14 §3), never by assignee:
 *   - Developers (Trnka, Bubenik) log the "dev-logged" hours that estimate
 *     accuracy is computed from. Their logs land both UNDER estimate (11585:
 *     4h/8h; 11765: 8h/8h → 0% overshoot) and OVER it (11592: 6h/4h → +50%;
 *     11756: 8h/6h → +33%), so the >25% overshoot flag has both true and false
 *     cases, on done AND not-done tickets.
 *   - Daniel Brabec (Tester) logs 3h and David Cesal (Customer) logs 10h —
 *     non-dev time that must show SEPARATELY and never mix into estimate
 *     accuracy, and that makes total-logged differ from dev-logged per ticket.
 *
 * Calendar: a plain finished-sprint window 2026-07-06 (Mon) → 2026-07-10 (Fri).
 * All work packages carry version "3.5.039" so a sprint can be seeded from that
 * OP version (matching the real sprint name). No timeline churn — the seed IS
 * the end-of-sprint state; the story here is the role matrix, not the burndown.
 *
 * SUGGESTED SETUP: import Demo Project, create a sprint from version "3.5.039"
 * over 2026-07-06 → 2026-07-10, set the roles above under Settings → People,
 * then open closure → expect Done 9 / Not done 2 (#11592, #11765).
 */
import type { Scenario, ScenarioUser, TimeEntrySeed } from "../scenario-types";
import { cast } from "./helpers";

/**
 * The named sprint-3.5.039 cast, added ON TOP of the shared dev/tester/customer
 * trio (kept so the /users/me identity invariant still holds). Ids are in a
 * dedicated 101+ block so they never collide with the shared cast (1–3).
 */
const NAMED_USERS: readonly ScenarioUser[] = [
  { key: "kolar", id: 101, name: "Vojtech Kolar", login: "vojtech.kolar" },
  { key: "trnka", id: 102, name: "Zbynek Trnka", login: "zbynek.trnka" },
  { key: "cesal", id: 103, name: "David Cesal", login: "david.cesal" },
  { key: "kuiper", id: 104, name: "Arend Kuiper", login: "arend.kuiper" },
  { key: "benda", id: 105, name: "Jindrich Benda", login: "jindrich.benda" },
  { key: "dalby", id: 106, name: "Cameron Dalby", login: "cameron.dalby" },
  { key: "bily", id: 107, name: "Jan Bily", login: "jan.bily" },
  { key: "bubenik", id: 108, name: "Tobias Bubenik", login: "tobias.bubenik" },
  { key: "brabec", id: 109, name: "Daniel Brabec", login: "daniel.brabec" },
];

/**
 * Time entries attributed by LOGGER (SPEC_14 §3). Developers' logs feed estimate
 * accuracy; tester/customer logs are the "shown separately" non-dev time.
 */
const TIME_ENTRIES: readonly TimeEntrySeed[] = [
  // Developer logs → estimate accuracy source (both under and over estimate).
  { wp: "t11585", user: "bubenik", hours: 4, spentOn: "2026-07-07" }, // 4h / est 8 → under (done)
  { wp: "t11592", user: "trnka", hours: 6, spentOn: "2026-07-08" }, // 6h / est 4 → +50% flag (not done)
  { wp: "t11756", user: "trnka", hours: 8, spentOn: "2026-07-09" }, // 8h / est 6 → +33% flag (done)
  { wp: "t11765", user: "bubenik", hours: 8, spentOn: "2026-07-09" }, // 8h / est 8 → 0% (not done)
  // Non-dev time → shown separately, must never enter estimate accuracy.
  { wp: "t11687", user: "brabec", hours: 3, spentOn: "2026-07-06" }, // tester time
  { wp: "t11625", user: "cesal", hours: 5, spentOn: "2026-07-07" }, // customer time
  { wp: "t11747", user: "cesal", hours: 5, spentOn: "2026-07-08" }, // customer time (Cesal 10h total)
];

export const s9RoleClosure: Scenario = {
  name: "s9-role-closure",
  description:
    "Sprint 3.5.039 done-matrix fixture (SPEC_14 §2): 11 project-3 tickets on version 3.5.039 whose " +
    "correct closure is Done 9 / Not done 2. The only NOT-DONE tickets are #11592 (Zbynek Trnka) and " +
    "#11765 (Tobias Bubenik) — Developers holding an 'in progress' ticket. #11726 (on hold, Jindrich Benda = " +
    "Customer) and #11747 (in progress, David Cesal = Customer) are done via role; every tested/resolved/" +
    "closed ticket is done by status. Roles are NOT in this fixture — set them under Settings -> People, then " +
    "closure must yield exactly Done 9 / Not done 2. Dev-logged hours (Trnka/Bubenik) drive estimate accuracy " +
    "with both under- and over-estimate cases; Daniel Brabec (tester, 3h) and David Cesal (customer, 10h) log " +
    "non-dev time shown separately.",
  startDate: "2026-07-06",
  seed: {
    users: [...cast(), ...NAMED_USERS.map((u) => ({ ...u }))],
    versions: [{ key: "v_3_5_039", id: 3539, name: "3.5.039", projectId: 3 }],
    workPackages: [
      // Done by STATUS (tested/resolved/closed) — role is irrelevant here.
      {
        key: "t11585",
        id: 11585,
        subject: "Payment retry: honour idempotency key on gateway timeout",
        project: 3,
        status: "Tested",
        assignee: "kolar",
        estimatedHours: 8,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      {
        key: "t11625",
        id: 11625,
        subject: "ISO 8583 field 55 EMV tag parsing edge case",
        project: 3,
        status: "Resolved",
        assignee: "cesal",
        estimatedHours: 5,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      {
        key: "t11687",
        id: 11687,
        subject: "HSM key ceremony logging gap",
        project: 3,
        status: "Tested",
        assignee: "kuiper",
        estimatedHours: 6,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      {
        key: "t11756",
        id: 11756,
        subject: "Settlement batch cutover timezone bug",
        project: 3,
        status: "Tested",
        assignee: "dalby",
        estimatedHours: 6,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      {
        key: "t11762",
        id: 11762,
        subject: "Fix payment-gateway timeout on retry",
        project: 3,
        status: "Closed",
        assignee: "bily",
        estimatedHours: 10,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      {
        key: "t11771",
        id: 11771,
        subject: "Tokenization vault rotation race",
        project: 3,
        status: "Tested",
        assignee: "kuiper",
        estimatedHours: 4,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      {
        key: "t11773",
        id: 11773,
        subject: "3-D Secure challenge fallback UX",
        project: 3,
        status: "Tested",
        assignee: "kuiper",
        estimatedHours: 4,
        remainingHours: 0,
        version: "v_3_5_039",
      },
      // Done by ROLE (role-dependent status + a NON-developer holder).
      {
        key: "t11726",
        id: 11726,
        subject: "Merchant onboarding: awaiting customer sign-off",
        project: 3,
        status: "On hold",
        assignee: "benda", // → Customer: on hold + customer = DONE
        estimatedHours: 3,
        remainingHours: 3,
        version: "v_3_5_039",
      },
      {
        key: "t11747",
        id: 11747,
        subject: "Chargeback representment: customer to supply evidence",
        project: 3,
        status: "In progress",
        assignee: "cesal", // → Customer: in progress + customer = DONE (left dev hands)
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_3_5_039",
      },
      // NOT DONE (role-dependent status + a Developer holder) — the only two.
      {
        key: "t11592",
        id: 11592,
        subject: "Refactor authorization pipeline retry backoff",
        project: 3,
        status: "In progress",
        assignee: "trnka", // → Developer: in progress + developer = NOT DONE
        estimatedHours: 4,
        remainingHours: 2,
        version: "v_3_5_039",
      },
      {
        key: "t11765",
        id: 11765,
        subject: "Reconciliation service memory growth under load",
        project: 3,
        status: "In progress",
        assignee: "bubenik", // → Developer: in progress + developer = NOT DONE
        estimatedHours: 8,
        remainingHours: 4,
        version: "v_3_5_039",
      },
    ],
    timeEntries: TIME_ENTRIES.map((te) => ({ ...te })),
  },
  // The seed IS the end-of-sprint state; the matrix, not a burndown, is the point.
  timeline: [],
};
