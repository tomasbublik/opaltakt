/**
 * S13 — sprint-list dimming = the SAME role-aware done-matrix as Closure
 * (SPEC_18 §3, reusing SPEC_14 §2's matrix / real sprint 3.5.039 tickets).
 *
 * Increment 18's central claim: a ticket card on the sprint board dims iff the
 * ticket `is_done` — and `is_done` is derived from the SAME `classifyWithRole`
 * done-matrix Closure uses (status kind × the ROLE of the current holder), NOT
 * from a hardcoded partial status list. This fixture seeds ONE finished-window
 * sprint whose 18 tickets exercise EVERY row of that matrix, so a single
 * scenario proves both the four `done_bucket` values and the `is_done`→dim map:
 *
 *   is_done (dim)  ⇔  done_bucket ∈ {done, rejected}
 *   NOT is_done    ⇔  done_bucket ∈ {not_done, ambiguous}
 *
 * ── Ticket layout (roles are set LIVE by the consuming spec, NOT baked here) ──
 * DONE by STATUS (always_done — role irrelevant, must DIM):
 *   #11644 Closed        Daniel Brabec
 *   #11762 Closed        Jan Bily
 *   #11761 Developed     Zbynek Trnka   (developer → still done: always_done ignores role)
 *   #11687 Developed     Cameron Dalby(role unset → still done, NOT ambiguous)
 *   #11785 Merge pending Arend Kuiper
 *   #11756 Merge pending Jindrich Benda
 *   #11585 Tested        Vojtech Kolar
 *   #11771 Tested        Arend Kuiper
 *   #11625 Resolved      David Cesal
 * DONE by ROLE (role_dependent status + a NON-developer holder, must DIM):
 *   #11212 In progress   Vojtech Kolar    (role → "other")
 *   #11747 In progress   David Cesal   (role → "customer")
 *   #11726 On hold       Jindrich Benda      (role → "customer")
 * REJECTED (its OWN closure bucket, but DIMS — is_done true for dimming):
 *   #11633 Rejected      Cameron Dalby
 * NOT DONE (role_dependent status + a DEVELOPER holder, must stay LIT):
 *   #11592 In progress   Zbynek Trnka   (role → "developer")
 *   #11765 In progress   Tobias Bubenik     (role → "developer")
 *   #11739 New           Zbynek Trnka   (role → "developer")
 *   #11797 Confirmed     Tobias Bubenik     (role → "developer")
 * AMBIGUOUS (role_dependent status held by a role-NEVER-set person — stays LIT
 * + shows the "role?" badge; NEVER guessed):
 *   #11818 In progress   Ondrej Marek     (FRESH name, role deliberately never set)
 *
 * Expected closure buckets once the roles above are set: done 12 / rejected 1 /
 * not_done 4 / ambiguous 1 (18 total). The dimmed set (is_done) is the 13
 * done+rejected tickets; the lit set is the 4 not_done + 1 ambiguous.
 *
 * ROLES-TO-SET (LIVE, via PUT /api/people/:id/role — Increment 14, identity =
 * the NAME): Vojtech Kolar→other, Jindrich Benda→customer, David Cesal→customer,
 * Zbynek Trnka→developer, Tobias Bubenik→developer. Ondrej Marek's role is left
 * UNSET on purpose (that is what makes #11818 ambiguous). Every always_done /
 * rejected holder needs NO role at all (status/rejected alone decides them).
 *
 * FRESH-NAME NOTE: Ondrej Marek (id 110) is introduced ONLY here — a person who
 * exists in NO other fixture — so his role is genuinely `unset` regardless of
 * cross-spec execution order on the shared e2e DB (the Increment-15 name-collision
 * gotcha). All other people REUSE s9-role-closure's named cast (ids 101–109) for
 * the same real individuals; s9 itself is FROZEN and untouched.
 *
 * TICKET-NUMBER NOTE: #11762/#11726/#11747/#11585/#11625/#11687/#11756/#11771/
 * #11592/#11765 are the SAME real 3.5.039 tickets s9 uses (reused verbatim for
 * traceability — a scenario loads in isolation, so there is no runtime collision).
 * #11644/#11212/#11761/#11785/#11633/#11739/#11797/#11818 are fresh numbers not
 * used by ANY other scenario (grep-verified against fixtures/scenarios/s*.ts).
 *
 * Calendar: a plain finished-sprint window 2026-07-06 (Mon) → 2026-07-10 (Fri),
 * like s9. No timeline churn and no time entries — Increment 18 is about the
 * done-matrix / dimming, not burndown or attribution; the seed IS the end state.
 */
import type { Scenario, ScenarioUser } from "../scenario-types";
import { cast } from "./helpers";

/**
 * The named cast. Ids 101–109 REUSE s9-role-closure's block for the same real
 * people (kept identical so identity-by-name stays consistent across fixtures);
 * id 110 (Ondrej Marek) is unique to this scenario — the never-set-role holder.
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
  // FRESH — appears in no other fixture, so its role is genuinely never set.
  { key: "marek", id: 110, name: "Ondrej Marek", login: "ondrej.marek" },
];

export const s13SprintListDimming: Scenario = {
  name: "s13-sprint-list-dimming",
  description:
    "SPEC_18 sprint-list dimming fixture: 18 tickets exercising every row of the role-aware done-matrix so " +
    "the board's dim class (is_done) is proven to be Closure's classification, not a hardcoded status list. " +
    "Once the roles are set (Kolar=other, Benda/Cesal=customer, Trnka/Bubenik=developer; Ondrej Marek " +
    "left UNSET), closure buckets are done 12 / rejected 1 / not_done 4 / ambiguous 1. Dimmed (is_done) = the " +
    "13 done+rejected tickets; lit = the 4 developer-held role-dependent tickets + the 1 ambiguous (#11818, " +
    "role never set → 'role?' badge). No timeline / no time entries — the seed IS the end-of-sprint state.",
  startDate: "2026-07-06",
  seed: {
    users: [...cast(), ...NAMED_USERS.map((u) => ({ ...u }))],
    versions: [{ key: "v_3_5_043", id: 3543, name: "3.5.043", projectId: 3 }],
    workPackages: [
      // ── DONE by STATUS (always_done — role irrelevant, must DIM) ────────────
      {
        key: "t11644",
        id: 11644,
        subject: "Card scheme certification: finalize test evidence pack",
        project: 3,
        status: "Closed",
        assignee: "brabec",
        estimatedHours: 6,
        remainingHours: 0,
        version: "v_3_5_043",
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
        version: "v_3_5_043",
      },
      {
        key: "t11761",
        id: 11761,
        subject: "Authorization pipeline: idempotent capture path",
        project: 3,
        status: "Developed",
        assignee: "trnka", // developer holder — always_done still DONE (role ignored)
        estimatedHours: 8,
        remainingHours: 0,
        version: "v_3_5_043",
      },
      {
        key: "t11687",
        id: 11687,
        subject: "HSM key ceremony logging gap",
        project: 3,
        status: "Developed",
        assignee: "dalby", // role left unset — always_done still DONE, NOT ambiguous
        estimatedHours: 6,
        remainingHours: 0,
        version: "v_3_5_043",
      },
      {
        key: "t11785",
        id: 11785,
        subject: "Settlement export: encode MTI 0220 advice correctly",
        project: 3,
        status: "Merge pending",
        assignee: "kuiper",
        estimatedHours: 5,
        remainingHours: 0,
        version: "v_3_5_043",
      },
      {
        key: "t11756",
        id: 11756,
        subject: "Settlement batch cutover timezone bug",
        project: 3,
        status: "Merge pending",
        assignee: "benda",
        estimatedHours: 6,
        remainingHours: 0,
        version: "v_3_5_043",
      },
      {
        key: "t11585",
        id: 11585,
        subject: "Payment retry: honour idempotency key on gateway timeout",
        project: 3,
        status: "Tested",
        assignee: "kolar",
        estimatedHours: 8,
        remainingHours: 0,
        version: "v_3_5_043",
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
        version: "v_3_5_043",
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
        version: "v_3_5_043",
      },
      // ── DONE by ROLE (role_dependent status + NON-developer holder, must DIM) ─
      {
        key: "t11212",
        id: 11212,
        subject: "Merchant portal: export monthly reconciliation CSV",
        project: 3,
        status: "In progress",
        assignee: "kolar", // → role "other": in progress + other = DONE
        estimatedHours: 4,
        remainingHours: 2,
        version: "v_3_5_043",
      },
      {
        key: "t11747",
        id: 11747,
        subject: "Chargeback representment: customer to supply evidence",
        project: 3,
        status: "In progress",
        assignee: "cesal", // → role "customer": in progress + customer = DONE
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_3_5_043",
      },
      {
        key: "t11726",
        id: 11726,
        subject: "Merchant onboarding: awaiting customer sign-off",
        project: 3,
        status: "On hold",
        assignee: "benda", // → role "customer": on hold + customer = DONE
        estimatedHours: 3,
        remainingHours: 3,
        version: "v_3_5_043",
      },
      // ── REJECTED (its own closure bucket, but DIMS for the board) ────────────
      {
        key: "t11633",
        id: 11633,
        subject: "Speculative: rewrite settlement engine in Rust (declined)",
        project: 3,
        status: "Rejected",
        assignee: "dalby",
        estimatedHours: 12,
        remainingHours: 12,
        version: "v_3_5_043",
      },
      // ── NOT DONE (role_dependent status + DEVELOPER holder, must stay LIT) ────
      {
        key: "t11592",
        id: 11592,
        subject: "Refactor authorization pipeline retry backoff",
        project: 3,
        status: "In progress",
        assignee: "trnka", // → role "developer": in progress + developer = NOT DONE
        estimatedHours: 4,
        remainingHours: 2,
        version: "v_3_5_043",
      },
      {
        key: "t11765",
        id: 11765,
        subject: "Reconciliation service memory growth under load",
        project: 3,
        status: "In progress",
        assignee: "bubenik", // → role "developer": in progress + developer = NOT DONE
        estimatedHours: 8,
        remainingHours: 4,
        version: "v_3_5_043",
      },
      {
        key: "t11739",
        id: 11739,
        subject: "3-D Secure v2 challenge flow: device fingerprint plumbing",
        project: 3,
        status: "New",
        assignee: "trnka", // → role "developer": new + developer = NOT DONE
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_3_5_043",
      },
      {
        key: "t11797",
        id: 11797,
        subject: "Refund webhook: retry with exponential backoff",
        project: 3,
        status: "Confirmed",
        assignee: "bubenik", // → role "developer": confirmed + developer = NOT DONE
        estimatedHours: 5,
        remainingHours: 5,
        version: "v_3_5_043",
      },
      // ── AMBIGUOUS (role_dependent status held by a role-NEVER-set person) ─────
      {
        key: "t11818",
        id: 11818,
        subject: "Tokenization: migrate legacy PAN vault format",
        project: 3,
        status: "In progress",
        assignee: "marek", // Ondrej Marek — role deliberately NEVER set → AMBIGUOUS (stays lit + "role?")
        estimatedHours: 7,
        remainingHours: 5,
        version: "v_3_5_043",
      },
    ],
  },
  // The seed IS the end-of-sprint state; the done-matrix, not a burndown, is the point.
  timeline: [],
};
