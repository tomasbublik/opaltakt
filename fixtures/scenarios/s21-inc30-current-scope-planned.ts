/**
 * S21 — the Increment-30 "current scope vs baseline" reproduction fixture
 * (`docs/INCREMENT_30_CONTRACTS.md` §1.3 / §4.4, `docs/CAPACITY_BAR_RULES.md`
 * §5 + §6 invariants 7–9).
 *
 * ── Why this scenario exists ────────────────────────────────────────────────
 * SPEC_30 §0's evidence (an active sprint where one developer's Capacity line
 * read 32 h while the same developer's bar summed to 10 h) lives in the USER'S
 * REAL DATABASE, which is off-limits to every agent for any reason — including
 * read-only. The product owner's decision (contracts §1.3) is therefore:
 * REPRODUCE that sprint's SHAPE here, as data we own, and measure the
 * reproduction. **No production number is asserted anywhere; every expected
 * value in `tests/src/inc30-current-scope-planned.test.ts` is hand-computed
 * from THIS file.**
 *
 * ── The shape (contracts §2a's table, one leg per row) ──────────────────────
 * An ACTIVE sprint that contains, simultaneously:
 *   • baseline work RETAINED by a developer, worked   → green `baseline_worked`
 *   • baseline work RETAINED, ZERO logged             → green `baseline_worked`
 *                                                       (Increment 26 abolished
 *                                                       `baseline_idle`)
 *   • a baseline ticket HANDED OFF developer→developer → sender `handoff`,
 *                                                       receiver `acquired`
 *   • a baseline ticket REMOVED from scope after activation
 *   • a ticket ADDED after activation and WORKED       → red `acquired`
 *   • a ticket ADDED after activation, HELD, NOT worked → orange-hatched `idle`
 *   • a TESTER holding real, logged sprint work        → solid grey, never
 *                                                       plannable capacity
 *   • a parent/child pair whose parent's holder owns NOTHING else — the
 *     Increment-26 "vanishing developer" (fixed in Increment 28): the leaf
 *     guard suppresses the parent's hours, but its holder MUST keep a line at
 *     0 h with `has_sprint_work` true (`CAPACITY_BAR_RULES.md` §5a)
 *   • an ACQUIRED ticket whose estimate CHANGES AFTER acquisition — the §2a
 *     residual Agent D is required to measure, not to paper over
 *
 * That combination is exactly what makes the pre-Increment-30 definition of
 * `Planned` (Σ green baseline) and the new one (Σ effectiveEstimate of the
 * tickets currently in the sprint and currently assigned to that developer)
 * disagree — by construction, and by a hand-checkable margin.
 *
 * ── Estimate arithmetic is deliberately trivial ─────────────────────────────
 * `effectiveEstimate` (`CAPACITY_BAR_RULES.md` §3) is
 * `override > (remaining ≠ 0 AND remaining ≠ work ? remaining : work)`. Every
 * seeded ticket here has `remainingHours === estimatedHours`, and every logged
 * workday's mandatory paired `setRemaining` re-states the SAME value — so
 * `remaining === work` always, the rule falls through to Work, and a ticket's
 * effective estimate is simply its `estimatedHours` for the entire scenario.
 * The ONE exception is `#86012`, whose estimate is deliberately moved on day 3
 * (Work AND Remaining together, so it stays a clean fall-through) — that is
 * the measured-residual leg and nothing else depends on it.
 *
 * ── Identity hygiene (Increment 15's lesson) ────────────────────────────────
 * e2e fixtures share an "identity = name" space, so every person, project,
 * version and work-package id below is NEW:
 *   • people 301–305, names not used by any other scenario;
 *   • project 8600, version 8610 (86xx/8600 band was unused — 8300/8310 are
 *     s16, 8400/8410 s17, 85xxx s19/s20, 83001–84090 s16/s17);
 *   • work packages 86001–86012.
 * The common dev/tester/customer cast is kept as well (the registry invariant
 * in scenarios.test.ts requires it and a single `me: true` identity); none of
 * those three holds a ticket in project 8600, so they never enter this
 * scenario's sprint.
 *
 * ── Roles are NOT fixture data ──────────────────────────────────────────────
 * `person.role` (developer / tester / …) is app-side state. The test assigns
 * it via `PUT /api/people/:id/role`; this file only decides WHO holds WHAT.
 * The intended casting is:
 *   Ludmila Stastna  (301) → developer   — retains, hands off, gains an idle add
 *   Bohumil Rezac    (302) → developer   — retains, receives the handoff, acquires
 *   Vendula Hajkova  (303) → TESTER      — holds logged work, never plannable
 *   Oskar Prazak     (304) → developer   — holds ONLY the suppressed parent
 *   Ivan Dolinsky    (305) → developer   — holds the child that suppresses it
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

/** Project + version ids owned exclusively by this scenario. */
export const S21_PROJECT_ID = 8600;
export const S21_VERSION_ID = 8610;

/** OP user ids owned exclusively by this scenario. */
export const S21_USERS = {
  stastna: { id: 301, name: "Ludmila Stastna" },
  rezac: { id: 302, name: "Bohumil Rezac" },
  hajkova: { id: 303, name: "Vendula Hajkova" },
  prazak: { id: 304, name: "Oskar Prazak" },
  dolinsky: { id: 305, name: "Ivan Dolinsky" },
} as const;

/**
 * Work-package ids, named by the ROLE each plays in the reproduction. The test
 * imports these instead of repeating literals, so a renumbering can never make
 * an assertion silently target the wrong leg.
 */
export const S21_WP = {
  /** Baseline, Stastna, worked → green `baseline_worked`. */
  retainedWorked: 86001,
  /** Baseline, Stastna, ZERO logged → STILL green (Increment 26). */
  retainedUnworked: 86002,
  /** Baseline, Stastna → reassigned to Rezac on day 2 (dev→dev handoff). */
  handedOff: 86003,
  /** Baseline, Stastna → REMOVED from sprint scope after activation (test-side). */
  scopeRemoved: 86004,
  /** Baseline, Rezac, worked → green `baseline_worked`. */
  rezacBaseline: 86005,
  /** Added to the sprint AFTER activation, Rezac, worked → red `acquired`. */
  addedAndWorked: 86006,
  /** Added AFTER activation, Stastna, never worked → orange-hatched `idle`. */
  addedHeldUnworked: 86007,
  /** Baseline, held by the TESTER — solid grey, never plannable capacity. */
  testerHeld: 86008,
  /** Baseline PARENT, Prazak's ONLY ticket — leaf-suppressed to 0 h. */
  dcParent: 86010,
  /** Baseline CHILD of #86010, Dolinsky — the ticket that suppresses the parent. */
  dcChild: 86011,
  /** Added AFTER activation, Rezac, worked, then RE-ESTIMATED 6 h → 14 h. */
  acquiredThenReestimated: 86012,
} as const;

/**
 * Seeded (and therefore effective, see the header) estimate per ticket, in
 * hours — the single source of truth the test's hand arithmetic quotes.
 * `#86012` is listed at its estimate AT ACQUISITION; day 3 moves it to
 * `S21_REESTIMATED_HOURS`.
 */
export const S21_ESTIMATE: Record<number, number> = {
  [S21_WP.retainedWorked]: 12,
  [S21_WP.retainedUnworked]: 6,
  [S21_WP.handedOff]: 8,
  [S21_WP.scopeRemoved]: 5,
  [S21_WP.rezacBaseline]: 10,
  [S21_WP.addedAndWorked]: 9,
  [S21_WP.addedHeldUnworked]: 4,
  [S21_WP.testerHeld]: 7,
  [S21_WP.dcParent]: 20,
  [S21_WP.dcChild]: 15,
  [S21_WP.acquiredThenReestimated]: 6,
};

/** #86012's estimate AFTER the day-3 re-estimate (the §2a residual leg). */
export const S21_REESTIMATED_HOURS = 14;

export const s21Inc30CurrentScopePlanned: Scenario = {
  name: "s21-inc30-current-scope-planned",
  description:
    "Increment 30 reproduction of the SPEC_30 §0 sprint SHAPE (never its data — the real database is " +
    "off-limits): one active-sprint project (8600 / version 8610) holding, at once, baseline work retained " +
    "and worked (#86001), baseline retained with ZERO logged time (#86002, still green per Increment 26), a " +
    "baseline ticket handed off developer->developer on day 2 (#86003 Stastna->Rezac), a baseline ticket the " +
    "test removes from scope after activation (#86004), a ticket added after activation and worked (#86006 " +
    "-> red acquired), a ticket added after activation and held unworked (#86007 -> orange-hatched idle), a " +
    "TESTER holding real logged work (#86008 -> solid grey, never plannable capacity), a parent/child pair " +
    "whose parent's holder owns nothing else (#86010 Prazak / #86011 Dolinsky -> the leaf guard must suppress " +
    "the parent's 20 h WITHOUT making Prazak vanish), and an acquired ticket re-estimated 6h->14h AFTER " +
    "acquisition (#86012 -> the contracts §2a residual to MEASURE). Every remainingHours mirrors its " +
    "estimatedHours so effectiveEstimate falls through to Work and the arithmetic stays hand-checkable.",
  startDate: "2026-08-03",
  seed: {
    // The common cast is kept for the registry's single-`me` invariant; none of
    // its three members holds a ticket in project 8600.
    users: [
      ...cast(),
      { key: "stastna", id: S21_USERS.stastna.id, name: S21_USERS.stastna.name, login: "ludmila.stastna" },
      { key: "rezac", id: S21_USERS.rezac.id, name: S21_USERS.rezac.name, login: "bohumil.rezac" },
      { key: "hajkova", id: S21_USERS.hajkova.id, name: S21_USERS.hajkova.name, login: "vendula.hajkova" },
      { key: "prazak", id: S21_USERS.prazak.id, name: S21_USERS.prazak.name, login: "oskar.prazak" },
      { key: "dolinsky", id: S21_USERS.dolinsky.id, name: S21_USERS.dolinsky.name, login: "ivan.dolinsky" },
    ],
    projects: [
      { id: S21_PROJECT_ID, identifier: "osp-inc30-scope", name: "OSP Increment 30 Scope" },
    ],
    versions: [
      { key: "v_inc30", id: S21_VERSION_ID, name: "Inc30 4.0.001", projectId: S21_PROJECT_ID },
    ],
    workPackages: [
      // ── Ludmila Stastna's baseline ───────────────────────────────────────
      {
        key: "retained-worked",
        id: S21_WP.retainedWorked,
        subject: "Harden the settlement reconciliation retry path",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "stastna",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.retainedWorked],
        remainingHours: S21_ESTIMATE[S21_WP.retainedWorked],
      },
      {
        key: "retained-unworked",
        id: S21_WP.retainedUnworked,
        subject: "Document the batch cut-over runbook",
        project: S21_PROJECT_ID,
        status: "New",
        assignee: "stastna",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.retainedUnworked],
        remainingHours: S21_ESTIMATE[S21_WP.retainedUnworked],
      },
      {
        key: "handed-off",
        id: S21_WP.handedOff,
        subject: "Replace the deprecated HSM key-ceremony helper",
        project: S21_PROJECT_ID,
        status: "New",
        assignee: "stastna",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.handedOff],
        remainingHours: S21_ESTIMATE[S21_WP.handedOff],
      },
      {
        key: "scope-removed",
        id: S21_WP.scopeRemoved,
        subject: "Prototype the alternate ISO 8583 field-63 layout",
        project: S21_PROJECT_ID,
        status: "New",
        assignee: "stastna",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.scopeRemoved],
        remainingHours: S21_ESTIMATE[S21_WP.scopeRemoved],
      },
      // ── Bohumil Rezac's baseline ─────────────────────────────────────────
      {
        key: "rezac-baseline",
        id: S21_WP.rezacBaseline,
        subject: "Split the acquirer routing table by scheme",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "rezac",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.rezacBaseline],
        remainingHours: S21_ESTIMATE[S21_WP.rezacBaseline],
      },
      // ── Tickets the TEST adds to the sprint only AFTER activation ────────
      // They exist in OP from day 0 (a real backlog ticket does); what makes
      // them "added after activation" is the sprint_item origin, not OP.
      {
        key: "added-and-worked",
        id: S21_WP.addedAndWorked,
        subject: "Hotfix: duplicate reversal on partial capture",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "rezac",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.addedAndWorked],
        remainingHours: S21_ESTIMATE[S21_WP.addedAndWorked],
      },
      {
        key: "added-held-unworked",
        id: S21_WP.addedHeldUnworked,
        subject: "Review the terminal-profile import mapping",
        project: S21_PROJECT_ID,
        status: "New",
        assignee: "stastna",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.addedHeldUnworked],
        remainingHours: S21_ESTIMATE[S21_WP.addedHeldUnworked],
      },
      {
        key: "acquired-then-reestimated",
        id: S21_WP.acquiredThenReestimated,
        subject: "Re-key the archived terminal certificate store",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "rezac",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.acquiredThenReestimated],
        remainingHours: S21_ESTIMATE[S21_WP.acquiredThenReestimated],
      },
      // ── The tester's ticket (solid grey, not plannable capacity) ─────────
      {
        key: "tester-held",
        id: S21_WP.testerHeld,
        subject: "Regression-test the settlement export against the golden file",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "hajkova",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.testerHeld],
        remainingHours: S21_ESTIMATE[S21_WP.testerHeld],
      },
      // ── The double-count pair. Parent FIRST (the engine resolves parents by
      //    key and requires them declared before their children).
      //    Prazak holds ONLY the parent: if the leaf guard drops suppressed
      //    items from the roster instead of zeroing them, he DISAPPEARS from
      //    the Capacity panel — the Increment-26 defect fixed in Increment 28.
      {
        key: "dc-parent",
        id: S21_WP.dcParent,
        subject: "EPIC: terminal estate migration",
        type: "Epic",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "prazak",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.dcParent],
        remainingHours: S21_ESTIMATE[S21_WP.dcParent],
      },
      {
        key: "dc-child",
        id: S21_WP.dcChild,
        subject: "Migrate the first estate batch (1..500)",
        project: S21_PROJECT_ID,
        status: "In progress",
        assignee: "dolinsky",
        parent: "dc-parent",
        version: "v_inc30",
        estimatedHours: S21_ESTIMATE[S21_WP.dcChild],
        remainingHours: S21_ESTIMATE[S21_WP.dcChild],
      },
    ],
  },
  timeline: [
    // ── Day 1 — baseline work happens; NO scope movement yet. Every paired
    //    setRemaining re-states the seeded estimate, so effectiveEstimate is
    //    unmoved (see the header).
    on(
      1,
      ...work("retained-worked", "stastna", 4, S21_ESTIMATE[S21_WP.retainedWorked]!),
      ...work("rezac-baseline", "rezac", 5, S21_ESTIMATE[S21_WP.rezacBaseline]!),
      ...work("tester-held", "hajkova", 3, S21_ESTIMATE[S21_WP.testerHeld]!),
      ...work("dc-child", "dolinsky", 6, S21_ESTIMATE[S21_WP.dcChild]!),
    ),
    // ── Day 2 — THE HANDOFF: #86003 moves Stastna → Rezac, and Rezac works on
    //    it (so the receiver's segment is `acquired` (red), not `idle`). Rezac
    //    also works the two tickets the test will add to the sprint next.
    on(
      2,
      ev.assign("handed-off", "rezac"),
      ...work("handed-off", "rezac", 3, S21_ESTIMATE[S21_WP.handedOff]!),
      ...work("added-and-worked", "rezac", 2, S21_ESTIMATE[S21_WP.addedAndWorked]!),
      ...work(
        "acquired-then-reestimated",
        "rezac",
        2,
        S21_ESTIMATE[S21_WP.acquiredThenReestimated]!,
      ),
    ),
    // ── Day 3 — the RESIDUAL leg: #86012's estimate changes AFTER Rezac
    //    acquired it. Work and Remaining move together so effectiveEstimate
    //    still falls through to Work (14 h), making the "live estimate" and the
    //    "estimate at acquisition" (6 h) differ by exactly 8 h.
    on(
      3,
      { t: "setEstimate", wp: "acquired-then-reestimated", hours: S21_REESTIMATED_HOURS },
      { t: "setRemaining", wp: "acquired-then-reestimated", hours: S21_REESTIMATED_HOURS },
    ),
  ],
};
