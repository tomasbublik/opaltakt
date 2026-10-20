/**
 * S10 — developer capacity bar driven by REAL work (SPEC_15 §2/§3/§7).
 *
 * The canonical fixture for Increment 15's authoritative 7-row table: a
 * DEVELOPER's per-ticket capacity segment is decided by *was the dev the holder
 * at the baseline anchor?* × *did the dev log time?* × *where did the ticket go?*
 * — NOT by the start-date otisk alone (the "Jan Belka 19h → empty bar / PLANNED
 * 0" bug this increment fixes).
 *
 * Sprint window: Mon 2026-07-06 → Fri 2026-07-10, version "3.5.040", project 3.
 * The baseline anchor is the sprint start_date (2026-07-06). Every baseline
 * holder is established by the SEED assignee (never reassigned before/at the
 * anchor); every reassignment is on day ≥ 1, so it is unambiguously mid-sprint.
 *
 * ── The eight tickets map onto ALL SEVEN §2 rows ────────────────────────────
 *   T1 12001  active           row 1  Petr Novák (dev): baseline, still his,
 *                                     'In progress' (not done), logged 5h.
 *   T2 12002  delivered        row 2  Zbyněk Kovář (dev): baseline est 30h,
 *                                     logs 46.5h (overshoot), status→Developed
 *                                     while HE holds it, THEN handed to a
 *                                     TESTER (Marek Sova) → green (dodáno) +
 *                                     logged marker 46.5h; DELIVERED 30 to
 *                                     KOVÁŘ (max logged), accuracy ≈ 155%,
 *                                     overshoot +16.5h.
 *   T3 12003  redistributed    row 3  Milan Černý (dev): baseline, reassigned
 *                                     to ANOTHER DEVELOPER (Ota Horák) → grey
 *                                     for Černý (−30 estimate, PLANNED −10).
 *          +  idle_unworked    row 6  Ota Horák (dev): NOT baseline, acquired
 *                                     T3 mid-sprint, logs NOTHING, still holds →
 *                                     hatched "přiřazeno, nepracováno".
 *   T4 12004  removed_no_work  row 4  Radek Dostál (dev): baseline, logs
 *                                     NOTHING, unassigned (abandoned) on day 2
 *                                     → blue (ubrat), PLANNED −6.
 *   T5a 12005 acquired_worked  row 5  Jan Belka (dev): CREATED mid-sprint (day 1),
 *                                     est 8h, Belka logs 7h.
 *   T5b 12006 acquired_worked  row 5  Jan Belka: baseline held by a TESTER,
 *                                     reassigned to Belka on day 2, est 6h,
 *                                     Belka logs 6h.
 *   T5c 12007 acquired_worked  row 5  Jan Belka: baseline held by a CUSTOMER,
 *                                     reassigned to Belka on day 2, est 5h,
 *                                     Belka logs 4.5h.
 *   T6 12008  churned_away     row 7  Ivo Svoboda (dev): NOT baseline, briefly
 *                                     assigned T6 on day 1, logs NOTHING, moves
 *                                     it on (unassigned, NOT back to the tester
 *                                     — that would flip it "done" via the
 *                                     role-matrix with no developer ever having
 *                                     logged a minute, wrongly crediting
 *                                     Svoboda's DELIVERED) day 3 → blue
 *                                     (churn), informative only.
 *
 * ── The two headline DoD checks (SPEC_15 §7) ────────────────────────────────
 *   • Jan Belka: 3 non-baseline tickets, est 8+6+5 = **19h**, logged
 *     7+6+4.5 = **17.5h** → three RED acquired_worked segments; PLANNED 0→**19h**;
 *     all three reach a done status held by Belka (max logger) so DELIVERED
 *     **19h** to Belka, accuracy 17.5/19 ≈ **92%** (never "—", bar not empty).
 *   • Zbyněk Kovář: baseline est **30h**, logs **46.5h**, developed + handed
 *     to the tester → GREEN (dodáno) 30h + logged marker 46.5h; PLANNED **30h**
 *     (NOT 46.5!); DELIVERED **30h** to KOVÁŘ (not to Marek); accuracy ≈
 *     **155%**; overshoot **+16.5h**.
 *
 * ── Roles are NOT part of this fixture (same as S9) ─────────────────────────
 * Role is a LOCAL attribute (team_member.role via PUT /api/people/:id/role).
 * Set these under Settings → People before opening closure/capacity:
 *   Jan Belka, Zbyněk Kovář, Petr Novák, Milan Černý, Ota Horák,
 *   Radek Dostál, Ivo Svoboda → **developer**
 *   Marek Sova → **tester**     Pavel Král → **customer**
 * With no role set, the developer segments do not apply (role-gating, §2/§5) and
 * the redistribution/handoff colours can't be told apart — the story only reads
 * correctly once the roles above are set.
 *
 * ── ⚠️ Agent D (QA): use the RETROSPECTIVE path — this is mandatory ─────────
 * All logged time is dated inside 2026-07-06..07-10, i.e. the scenario-calendar
 * PAST relative to the real wall clock. A LIVE activation only derives
 * `time_logged` for spentOn ≥ real activation instant, so it would MISS every
 * hour here and Belka's/Trnka's bars would stay empty. Drive it as a
 * retrospective sprint instead:
 *   1. POST /__mock/load/s10-developer-work-attribution, then advance to the
 *      last day (goto-day 4) so the whole timeline (day-0 baseline
 *      round-trips, reassigns, status changes, time entries) is applied.
 *   2. Create a sprint named/keyed for version "3.5.040" over 2026-07-06 →
 *      2026-07-10 with **is_retrospective: true** BEFORE adding items.
 *   3. Seed it from OP version "3.5.040" (retro/seed) — this pulls T1..T4, T5b,
 *      T5c, T6 as baseline candidates and correctly routes T5a (created day 1)
 *      as a mid-sprint addition (created_after_start_date).
 *   4. Set the roles above, Activate (replays journals + time entries), then
 *      read GET /api/sprints/:id/closure-stats.
 * NOTE the mock journals only CHANGES, not WP birth (no v1 "Assignee set to X"),
 * so a baseline holder that is never reassigned has NO assignee journal by
 * default — this fixture's day-0 timeline entry (see below) explicitly
 * re-establishes each divergent ticket's seed assignee via a real (non-no-op)
 * unassign→reassign round-trip, so `stateAtDate`'s fold has genuine pre-anchor
 * coverage instead of silently falling back to the ticket's FINAL live
 * assignee (which is exactly the divergence this fixture needs to tell apart
 * from the baseline). T1/T6 don't need it — their baseline and final assignee
 * coincide. Companion fix: `stateAtDate` (packages/op-client/src/reconstruct.ts)
 * also now takes the WP's own `createdAt` as an extra "did it exist yet"
 * signal, so a ticket untouched before the anchor is no longer misread as
 * `not_yet_created` just because it has no journal entry that early.
 */
import type { Scenario, ScenarioUser } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

/** Named cast (ids in a dedicated 121+ block — never collide with the shared
 * dev/tester/customer trio 1–3 kept for the /users/me identity invariant).
 *
 * NOTE — "trnka"/"kuiper" keys use DISPLAY NAMES deliberately DIFFERENT from
 * SPEC_15's own prose example ("Zbynek Trnka"/"Arend Kuiper"): those exact
 * names are ALSO used by Increment 14's s9-role-closure fixture (a different
 * person, different op_user_id, same shared app DB across e2e spec files).
 * Identity is the NAME (Increment 13) — team_member materialization is
 * GLOBAL, not connection/scenario-scoped, so reusing an already-materialized
 * name here would silently graft this ticket's real work onto a DIFFERENT
 * (s9's) person's persisted identity, split-braining PersonKey resolution
 * between the logger path (real actor_op_id) and the assignee-interval path
 * (name-only, falls back to whichever team_member that name already
 * resolves to) — found and confirmed via Phase 2 integration testing (running
 * tg-roles-closure-reports.spec.ts before this file reproduces it; running
 * this file alone does not). The STORY and every NUMBER (30h baseline, 46.5h
 * logged, 155% accuracy, +16.5h overshoot) are unchanged from SPEC_15 §7 —
 * only these two display names differ, to stay collision-free. */
const NAMED_USERS: readonly ScenarioUser[] = [
  { key: "belka", id: 121, name: "Jan Belka", login: "jan.belka" },
  { key: "trnka", id: 122, name: "Zbyněk Kovář", login: "zbynek.kovar" },
  { key: "novak", id: 123, name: "Petr Novák", login: "petr.novak" },
  { key: "cerny", id: 124, name: "Milan Černý", login: "milan.cerny" },
  { key: "horak", id: 125, name: "Ota Horák", login: "ota.horak" },
  { key: "dostal", id: 126, name: "Radek Dostál", login: "radek.dostal" },
  { key: "svoboda", id: 127, name: "Ivo Svoboda", login: "ivo.svoboda" },
  { key: "kuiper", id: 128, name: "Marek Sova", login: "marek.sova" },
  { key: "kral", id: 129, name: "Pavel Král", login: "pavel.kral" },
];

export const s10DeveloperWorkAttribution: Scenario = {
  name: "s10-developer-work-attribution",
  description:
    "Increment 15 developer-capacity fixture (SPEC_15 §2/§7): 8 project-3 tickets on version 3.5.040 " +
    "over Mon 2026-07-06 → Fri 2026-07-10 exercising all seven segment rows. Jan Belka owns 3 " +
    "non-baseline tickets (est 19h, logged 17.5h → red acquired_worked; PLANNED 19h; accuracy ≈ 92%); " +
    "Zbyněk Kovář develops a 30h baseline ticket, logs 46.5h and hands it to tester Marek Sova " +
    "(green delivered + marker; DELIVERED 30h to Trnka not Kuiper; accuracy ≈ 155%). Also: Novák active " +
    "(row1), Černý redistributed→Horák (row3) with Horák idle (row6), Dostál abandoned+scope-removed " +
    "(row4), Svoboda churned-away (row7). Roles are NOT in the fixture — set them under Settings → " +
    "People, then drive it via the RETROSPECTIVE path (seed from version 3.5.040, activate) because " +
    "all logged time is in the scenario-calendar past.",
  startDate: "2026-07-06",
  seed: {
    users: [...cast(), ...NAMED_USERS.map((u) => ({ ...u }))],
    versions: [
      { key: "v_target", id: 4040, name: "3.5.040", projectId: 3 },
      { key: "v_next", id: 4041, name: "3.5.041", projectId: 3 },
    ],
    workPackages: [
      // Row 1 — active: baseline, still his, not done.
      {
        key: "t1",
        id: 12001,
        subject: "Batch settlement retry: idempotency key on gateway timeout",
        project: 3,
        status: "In progress",
        assignee: "novak",
        estimatedHours: 8,
        remainingHours: 8,
        version: "v_target",
      },
      // Row 2 — delivered: baseline, developed + handed to a tester, overshoot.
      {
        key: "t2",
        id: 12002,
        subject: "Reconciliation engine memory growth under load",
        project: 3,
        status: "In progress",
        assignee: "trnka",
        estimatedHours: 30,
        remainingHours: 30,
        version: "v_target",
      },
      // Row 3 (Černý) + Row 6 (Horák) — redistributed to another dev who idles.
      {
        key: "t3",
        id: 12003,
        subject: "Refactor authorization pipeline retry backoff",
        project: 3,
        status: "In progress",
        assignee: "cerny",
        estimatedHours: 10,
        remainingHours: 10,
        version: "v_target",
      },
      // Row 4 — removed_no_work: baseline, no work, leaves the sprint version.
      {
        key: "t4",
        id: 12004,
        subject: "Legacy HSM shim cleanup",
        project: 3,
        status: "Confirmed",
        assignee: "dostal",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_target",
      },
      // Row 5b — acquired_worked: baseline held by a TESTER, handed to Belka.
      {
        key: "t5b",
        id: 12006,
        subject: "Tokenization vault rotation race",
        project: 3,
        status: "In progress",
        assignee: "kuiper",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_target",
      },
      // Row 5c — acquired_worked: baseline held by a CUSTOMER, handed to Belka.
      {
        key: "t5c",
        id: 12007,
        subject: "3-D Secure challenge fallback UX",
        project: 3,
        status: "In progress",
        assignee: "kral",
        estimatedHours: 5,
        remainingHours: 5,
        version: "v_target",
      },
      // Row 7 — churned_away: baseline held by a tester, briefly on Svoboda.
      {
        key: "t6",
        id: 12008,
        subject: "Chargeback representment: evidence intake",
        project: 3,
        status: "In progress",
        assignee: "kuiper",
        estimatedHours: 4,
        remainingHours: 4,
        version: "v_target",
      },
      // T5a (Row 5a) is CREATED mid-sprint on day 1 — see the timeline, not here.
    ],
  },
  timeline: [
    // Day 0 (Mon 07-06, applied immediately on load): re-establish each
    // ticket's seed assignee via a REAL journal-producing round-trip
    // (unassign → reassign). The mock only journals CHANGES, never a WP's
    // birth (fixtures/mock-op-server/engine.ts: "journals model CHANGES, not
    // birth"), and a plain reassign to the SAME person is a documented no-op
    // that emits nothing — so a ticket's SEED assignee otherwise has ZERO
    // journal coverage before the sprint's baseline anchor, and retro
    // reconstruction (stateAtDate) can only fall back to the ticket's FINAL
    // (post-timeline) live assignee for that field. That silently swaps in
    // the WRONG holder for every ticket whose assignee later diverges from
    // its seed (Trnka→Kuiper, Černý→Horák, Dostál→unassigned, Kuiper→Belka,
    // Král→Belka) — exactly the divergence SPEC_15's baseline-vs-current
    // model depends on telling apart. Round-tripping through null makes both
    // legs a genuine value change, so each generates a real, anchor-visible
    // activity. T1 (Novák) and T6 (never reassigned before day 1 / ends back
    // on its seed holder) don't need this — their fallback-to-current value
    // already matches their true baseline.
    on(
      0,
      ev.assign("t2", null),
      ev.assign("t2", "trnka"),
      ev.assign("t3", null),
      ev.assign("t3", "cerny"),
      ev.assign("t4", null),
      ev.assign("t4", "dostal"),
      ev.assign("t5b", null),
      ev.assign("t5b", "kuiper"),
      ev.assign("t5c", null),
      ev.assign("t5c", "kral"),
    ),
    // Day 1 (Tue 07-07): first work + the two mid-sprint arrivals begin.
    on(
      1,
      // T1 active: Novák logs 5h, stays In progress (not done).
      ...work("t1", "novak", 5, 3),
      // T2 delivered: Trnka starts logging his overshoot (15h of 46.5h).
      ...work("t2", "trnka", 15, 15),
      // T5a created mid-sprint, assigned to Belka; Belka logs 4h.
      ev.add({
        key: "t5a",
        id: 12005,
        subject: "Urgent: gateway TLS renegotiation failure",
        project: 3,
        status: "In progress",
        assignee: "belka",
        estimatedHours: 8,
        remainingHours: 8,
        version: "v_target",
      }),
      ...work("t5a", "belka", 4, 4),
      // T6 churn: tester hands to Svoboda (who will never log).
      ev.assign("t6", "svoboda"),
    ),
    // Day 2 (Wed 07-08): reassignments + the scope removal.
    on(
      2,
      // T2 delivered: Trnka logs 15h more (remaining → 0).
      ...work("t2", "trnka", 15, 0),
      // T3 redistributed: Černý hands to another developer, Horák (who idles).
      ev.assign("t3", "horak"),
      // T4 removed_no_work: Dostál abandons it (unassigned), never logged.
      ev.assign("t4", null),
      // T5a: Belka logs 3h more (7h total).
      ...work("t5a", "belka", 3, 1),
      // T5b acquired: tester hands to Belka, who logs 3h.
      ev.assign("t5b", "belka"),
      ...work("t5b", "belka", 3, 3),
      // T5c acquired: customer hands to Belka (Belka logs on day 3).
      ev.assign("t5c", "belka"),
    ),
    // Day 3 (Thu 07-09): dev-done transitions + handoffs + the churn move-on.
    on(
      3,
      // T2 delivered: Trnka logs the final 16.5h (overshoot), marks Developed
      // WHILE he holds it (credits DELIVERED to him), THEN hands to the tester.
      ...work("t2", "trnka", 16.5, 0),
      ev.status("t2", "Developed"),
      ev.assign("t2", "kuiper"),
      // Belka finishes and delivers his three acquired tickets (he is the max
      // logger on each → DELIVERED credited to Belka, accuracy 17.5/19 ≈ 92%).
      ...work("t5b", "belka", 3, 0),
      ev.status("t5b", "Developed"),
      ...work("t5c", "belka", 4.5, 0),
      ev.status("t5c", "Developed"),
      ev.status("t5a", "Developed"),
      // T6 churn: Svoboda (never logged) moves it on — to UNASSIGNED, not back
      // to the tester. Handing it back to a tester would flip it "done" via
      // the role-aware matrix (Inc 14: role_dependent status + non-developer
      // holder = done) with ZERO developer ever having logged a minute on it
      // — the DELIVERED cascade's maxLogged==0 fallback would then credit
      // Svoboda (the only developer who EVER held it, however briefly) for
      // work he never did. Unassigned + "In progress" correctly buckets
      // not_done (with an informative unassigned_in_progress anomaly), so no
      // DELIVERED attribution is attempted for it at all — matching row 7's
      // "informative only" intent.
      ev.assign("t6", null),
    ),
    // Day 4 (Fri 07-10): quiet close — T1 deliberately stays In progress (not
    // done), Horák still idles on T3, Dostál's T4 stays unassigned/untouched.
    on(4),
  ],
};
