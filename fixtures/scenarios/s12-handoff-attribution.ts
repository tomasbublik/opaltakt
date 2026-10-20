/**
 * S12 — dev→dev handoff attribution, "red for the receiver" (SPEC_17 §1/§3).
 *
 * The canonical fixture for Increment 17's BUG 1: a ticket ACQUIRED by a
 * developer via a mid-sprint developer→developer REASSIGNMENT (NOT a fresh
 * add to the sprint) must still turn RED (`acquired`, case e) for that
 * developer once they log real time — v1 only detected the red case for the
 * sprint-ADD path, so the mid-chain receiver got NOTHING.
 *
 * ── The headline ticket: a faithful reproduction of real #11762 ─────────────
 * The sample #11762 (fixtures/samples/op_activities_11762.json) has this
 * assignee chain (see fixtures/samples/op_activities_11762.json):
 *   Cameron Dalby (baseline) → Tobias Bubenik → Daniel Brabec → Tobias Bubenik
 *   → Daniel Brabec → Jan Bily (final).
 * Tobias Bubenik genuinely LOGGED TIME on it during one of his two holds (the
 * real "Work set to 12h" activity was only an ESTIMATE change, but the app's
 * real "who logged" signal is TIME ENTRIES — so this fixture seeds a GENUINE
 * time entry for Tobias, not an inference from the estimate activity).
 *
 * `t_handoff` (id 12762, evokes the real #11762 without colliding with
 * s9-role-closure.ts's DIFFERENT already-baselined #11762) compresses that
 * chain into the 5-day sprint window while keeping the exact bug SHAPE — a
 * developer who holds the ticket in the MIDDLE of the chain (twice, non-
 * contiguously), not first, not last, and logs 12h:
 *   Cameron Dalby (baseline, dev)
 *     → day 1  Tobias Bubenik (dev) — logs 8h
 *     → day 2  Daniel Beneš (dev)
 *     → day 3  Tobias Bubenik (dev) again — logs 4h more (12h total)
 *     → day 4  Daniel Beneš (dev, FINAL holder), status → Developed.
 * Expected v2 segments (§1 table):
 *   • Cameron Dalby → `handoff` (c, BLUE-hatched): baseline, final holder is
 *     another developer (Daniel Beneš). Planned 0, Change 0.
 *   • Tobias Bubenik      → `acquired` (e, RED + logged marker): NOT baseline for
 *     him, LOGGED 12h. Planned 0, Change +12h. ← the BUG-1 regression assertion.
 *   • Daniel Beneš      → `idle` (f, ORANGE-hatched): NOT baseline, no log, still
 *     holds at the end. Planned 0, Change 0 (informative).
 *
 * ── Full v2 row coverage (a–g) for Agent D — one dedicated ticket per row ────
 *   t_a   12701  `baseline_worked` (a, GREEN)         Lukáš Pokorný (dev):
 *                baseline, logs 10h/est 10h, Developed while he holds it.
 *   t_b   12702  `baseline_worked` (GREEN)            Jakub Fiala (dev):
 *                baseline, logs NOTHING, still holds (In progress). Planned +7.
 *                (Increment 26: a held baseline ticket is green regardless of
 *                logged time — the former grey-hatched baseline_idle is abolished.)
 *   t_c/e/f 12762 handoff + acquired + idle           (the headline ticket above)
 *   t_d   12703  `removed`         (d, BLUE solid)    Roman Kraus (dev):
 *                baseline, logs NOTHING, unassigned (abandoned) day 2, nobody
 *                picks it up. Planned 0, Change −6.
 *   t_g   12704  `churned`         (g, BLUE solid)    Vít Urban (dev):
 *                baseline held by a TESTER (Eva Doležalová), briefly reassigned
 *                to Urban day 1, Urban logs NOTHING, unassigned again day 3
 *                (moved on). Not baseline → not `removed`; informative only.
 *
 * ── Planned / Change roll-up the fixture is built to produce (§1) ────────────
 *   PLANNED (Σ estimate over {a,b}, ≥ 0, per developer):
 *     Lukáš Pokorný 10 · Jakub Fiala 7 · everyone else 0.
 *   CHANGE  (Σ{e} − Σ{d}, per developer):
 *     Tobias Bubenik +12 · Roman Kraus −6 · everyone else 0.
 *   No developer's PLANNED is ever negative (BUG 2, SPEC_17 §4).
 *
 * ── Name-collision handling (Increment 15/16 lesson, verified) ──────────────
 * Cameron Dalby (id 106) and Tobias Bubenik (id 108) are REUSED VERBATIM from
 * s9-role-closure.ts — same real people, same numeric ids, and both are
 * developers in BOTH stories (Bubenik is already role=developer in s9's tg-spec;
 * Dalby's role is irrelevant to s9, whose #11756 is done by STATUS "Tested"),
 * so reusing them can never split-brain PersonKey resolution or flip an s9
 * assertion. The real chain's "Daniel Brabec" and "Jan Bily" are NOT reused:
 * Daniel Brabec is a TESTER in s9 (his tester role is load-bearing for s9's
 * "non-dev time shown separately" claim) and would need to be a developer here,
 * an INCOMPATIBLE role — so his analog is a distinct person "Daniel Beneš" (new
 * id 141). Every other named person is freshly invented in a dedicated 141+ id
 * block with a surname absent from all existing scenarios.
 *
 * ── Agent D (QA): drive via the RETROSPECTIVE path (mandatory, as with s10) ──
 * All logged time is dated inside 2026-07-06..07-10 (scenario-calendar PAST),
 * so a LIVE activation would miss every hour. Load s12, goto-day 4, create a
 * retrospective sprint over version "3.5.042" (2026-07-06 → 2026-07-10), set
 * the roles below, activate, then read closure/capacity.
 *   Cameron Dalby, Tobias Bubenik, Daniel Beneš, Lukáš Pokorný, Jakub Fiala,
 *   Roman Kraus, Vít Urban → developer
 *   Eva Doležalová → tester      Klára Sedláčková → customer
 * Like s10, each divergent ticket's day-0 timeline entry re-establishes its
 * seed assignee via a real unassign→reassign round-trip so retro reconstruction
 * (stateAtDate) has genuine pre-anchor coverage instead of falling back to the
 * ticket's final live assignee.
 */
import type { Scenario, ScenarioUser, TimeEntrySeed } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

/** Named cast. Dalby (106) + Bubenik (108) are REUSED verbatim from
 * s9-role-closure.ts (same real people, consistent developer role). Everyone
 * else is a fresh person in a dedicated 141+ id block with a collision-free
 * surname (Daniel Brabec is NOT reused — he is a TESTER in s9, incompatible with
 * the developer role his analog needs here; his stand-in is "Daniel Beneš"). */
const NAMED_USERS: readonly ScenarioUser[] = [
  { key: "dalby", id: 106, name: "Cameron Dalby", login: "cameron.dalby" }, // REUSED (s9)
  { key: "bubenik", id: 108, name: "Tobias Bubenik", login: "tobias.bubenik" }, // REUSED (s9)
  { key: "benes", id: 141, name: "Daniel Beneš", login: "daniel.benes" }, // Daniel Brabec analog
  { key: "pokorny", id: 142, name: "Lukáš Pokorný", login: "lukas.pokorny" },
  { key: "fiala", id: 143, name: "Jakub Fiala", login: "jakub.fiala" },
  { key: "kraus", id: 144, name: "Roman Kraus", login: "roman.kraus" },
  { key: "urban", id: 145, name: "Vít Urban", login: "vit.urban" },
  { key: "dolezal", id: 146, name: "Eva Doležalová", login: "eva.dolezalova" },
  { key: "sedlackova", id: 147, name: "Klára Sedláčková", login: "klara.sedlackova" },
];

/**
 * Time entries attributed by LOGGER (SPEC_14 §3 / §15 max-logged). The only
 * developers who log are the ones the model needs to have logged: Tobias Bubenik
 * on the handoff ticket (the BUG-1 red trigger) and Lukáš Pokorný on his
 * baseline_worked ticket. All others deliberately log NOTHING.
 *
 * These are ALSO emitted inline via the `work()` helper in the timeline (which
 * pairs logTime with setRemaining); listing them here as seed timeEntries would
 * DOUBLE-count, so the timeline is the single source — this constant is left
 * empty on purpose and documented for readers looking for "where Tobias logs".
 */
const TIME_ENTRIES: readonly TimeEntrySeed[] = [];

export const s12HandoffAttribution: Scenario = {
  name: "s12-handoff-attribution",
  description:
    "Increment 17 dev->dev handoff-attribution fixture (SPEC_17 §1/§3): 6 project-3 tickets on version " +
    "3.5.042 over Mon 2026-07-06 -> Fri 2026-07-10 reproducing real #11762 and covering all seven v2 " +
    "segment rows. Headline t_handoff (id 12762): Cameron Dalby baseline -> Tobias Bubenik (logs 12h, " +
    "held twice mid-chain) -> Daniel Benes (final) — Tobias MUST get a RED `acquired` segment (BUG 1), " +
    "Cameron a `handoff`, Daniel `idle`. Also: Lukas Pokorny baseline_worked (10h), Jakub Fiala " +
    "baseline_worked (green, 7h — Increment 26 merged the former baseline_idle into baseline_worked: a held " +
    "baseline ticket is green regardless of logged time), Roman Kraus removed (-6h), Vit Urban churned. PLANNED Pokorny 10/Fiala 7; " +
    "CHANGE Bubenik +12/Kraus -6; no negative PLANNED. Roles are NOT in the fixture — set them under " +
    "Settings -> People and drive via the RETROSPECTIVE path (seed from version 3.5.042, activate) because " +
    "all logged time is in the scenario-calendar past.",
  startDate: "2026-07-06",
  seed: {
    users: [...cast(), ...NAMED_USERS.map((u) => ({ ...u }))],
    versions: [{ key: "v_target", id: 4042, name: "3.5.042", projectId: 3 }],
    workPackages: [
      // Row a — baseline_worked: baseline dev, logs, developed while he holds it.
      {
        key: "t_a",
        id: 12701,
        subject: "Settlement export: retry idempotency on gateway timeout",
        project: 3,
        status: "In progress",
        assignee: "pokorny",
        estimatedHours: 10,
        remainingHours: 10,
        version: "v_target",
      },
      // Row b — baseline_worked (green): baseline dev, never logs, still holds
      // (In progress). Increment 26: a held baseline ticket is green regardless of
      // logged time; the former baseline_idle grey-hatched state is abolished.
      {
        key: "t_b",
        id: 12702,
        subject: "Reconciliation engine backpressure tuning",
        project: 3,
        status: "In progress",
        assignee: "fiala",
        estimatedHours: 7,
        remainingHours: 7,
        version: "v_target",
      },
      // Rows c + e + f — the headline #11762 reproduction. Baseline Cameron
      // Dalby; Tobias Bubenik acquires it (twice) and logs; Daniel Beneš ends up
      // holding it. est 12h mirrors the real "Work set to 12h".
      {
        key: "t_handoff",
        id: 12762,
        subject: "Field mapping in reversal message (handoff attribution)",
        project: 3,
        status: "In progress",
        assignee: "dalby",
        estimatedHours: 12,
        remainingHours: 12,
        version: "v_target",
      },
      // Row d — removed: baseline dev, no work, abandoned (unassigned) mid-sprint.
      {
        key: "t_d",
        id: 12703,
        subject: "Legacy HSM shim cleanup",
        project: 3,
        status: "Confirmed",
        assignee: "kraus",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_target",
      },
      // Row g — churned: baseline held by a TESTER, briefly on a dev who never
      // logs and then moves it on (unassigned).
      {
        key: "t_g",
        id: 12704,
        subject: "Chargeback representment: evidence intake triage",
        project: 3,
        status: "In progress",
        assignee: "dolezal",
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_target",
      },
      // A customer-held baseline ticket so a real customer exists in the roster
      // and role-gating (only developers get segments) has a non-dev holder to
      // exclude. Never worked, stays put — no developer segment at all.
      {
        key: "t_cust",
        id: 12705,
        subject: "Merchant onboarding: awaiting customer sign-off",
        project: 3,
        status: "On hold",
        assignee: "sedlackova",
        estimatedHours: 3,
        remainingHours: 3,
        version: "v_target",
      },
    ],
    timeEntries: TIME_ENTRIES.map((te) => ({ ...te })),
  },
  timeline: [
    // Day 0 (Mon 07-06): re-establish each divergent ticket's seed assignee via
    // a real unassign->reassign round-trip so retro reconstruction has genuine
    // pre-anchor journal coverage (see s10's day-0 note for the full rationale).
    // t_b (Fiala) and t_cust (customer) never diverge from their seed holder, so
    // they don't need it.
    on(
      0,
      ev.assign("t_a", null),
      ev.assign("t_a", "pokorny"),
      ev.assign("t_handoff", null),
      ev.assign("t_handoff", "dalby"),
      ev.assign("t_d", null),
      ev.assign("t_d", "kraus"),
      ev.assign("t_g", null),
      ev.assign("t_g", "dolezal"),
    ),
    // Day 1 (Tue 07-07): first work + the first handoff hop.
    on(
      1,
      // Row a: Pokorný logs the first 6h of his 10h.
      ...work("t_a", "pokorny", 6, 4),
      // Handoff: Cameron hands to Tobias (dev→dev); Tobias logs 8h (hold #1).
      ev.assign("t_handoff", "bubenik"),
      ...work("t_handoff", "bubenik", 8, 4),
      // Row g: tester hands the ticket to Vít Urban (a dev who will never log).
      ev.assign("t_g", "urban"),
    ),
    // Day 2 (Wed 07-08): the second handoff hop + the scope abandonment.
    on(
      2,
      // Handoff: Tobias hands to Daniel Beneš (dev→dev).
      ev.assign("t_handoff", "benes"),
      // Row d: Kraus abandons his ticket (unassigned), never logged.
      ev.assign("t_d", null),
    ),
    // Day 3 (Thu 07-09): Tobias returns to the handoff ticket; churn moves on.
    on(
      3,
      // Row a: Pokorný logs his final 4h (10h total) and marks it Developed.
      ...work("t_a", "pokorny", 4, 0),
      ev.status("t_a", "Developed"),
      // Handoff: Daniel hands BACK to Tobias (dev→dev, hold #2); Tobias logs 4h
      // more (12h total on a 12h-estimate ticket).
      ev.assign("t_handoff", "bubenik"),
      ...work("t_handoff", "bubenik", 4, 0),
      // Row g: Urban (never logged) moves it on — to unassigned (churned away).
      ev.assign("t_g", null),
    ),
    // Day 4 (Fri 07-10): the handoff ticket lands on Daniel Beneš, Developed.
    on(
      4,
      ev.assign("t_handoff", "benes"),
      ev.status("t_handoff", "Developed"),
    ),
  ],
};
