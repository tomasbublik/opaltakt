/**
 * S19 — sync coverage, the version-scoped escape route (SPEC_29 / Increment 29,
 * `docs/INCREMENT_29_CONTRACTS.md` §0a).
 *
 * ── WHY THIS FIXTURE EXISTS ─────────────────────────────────────────────────
 * The measured root cause of #11948 is NOT "a ticket that entered the cache
 * another way". It is one level finer, and no existing scenario can express it:
 *
 *   - an import selection is a (project, version) PAIR, and a version-scoped
 *     sync sends `version = X` to OpenProject;
 *   - the old orphans pass only asked "is this row's PROJECT in the selection?";
 *   - so a cached row whose project IS selected but whose version is NOT falls
 *     into NEITHER set. The paginated sync filters it out; the orphans pass
 *     thinks its project is covered. It is never fetched again, by any run,
 *     forever.
 *
 * The realistic way a row gets into that state — and the way this scenario
 * models it — is that the ticket was originally in the SELECTED version, got
 * cached by a normal import, and was then MOVED to another version in OP. From
 * that moment the version-scoped sync stops returning it and the cache keeps a
 * permanently stale copy. `drifted-estimate` (#85010) is exactly that: it also
 * gains its 8h estimate at the same moment, reproducing #11948's shape (OP says
 * PT8H, the cache says nothing, and every later "full" sync reports success).
 *
 * ── SUGGESTED SETUP (what tu-sync-coverage.spec.ts does) ────────────────────
 *   1. day 0: import project 8500 scoped to version 8510 ("Coverage Wave 1").
 *      All of its work packages are cached, including the five that are
 *      about to drift and the one that is about to vanish.
 *   2. `POST /sprints/:id/items/by-id` #85020 — project 8501 has NO import
 *      selection at all, i.e. the Increment-25 "added by id" path the OLD
 *      orphans pass already covered (kept here so the new pass is proven not to
 *      REGRESS it).
 *   3. advance to day 1: the five `drifted-*` tickets move to version 8511
 *      ("Coverage Backlog Deep"), #85010 gains its 8h estimate and the archive
 *      ticket's estimate changes too.
 *   4. "Sync now". Under the OLD code #85010 keeps a week-old `cached_at` and
 *      an empty estimate; under the coverage pass it comes back with 8h.
 *   5. day 2 exists for the mid-run RACE leg (#85030 changes while a sync is in
 *      flight), day 3 for the "capacity must not move during a sync" leg
 *      (#85001 doubles from 5h to 20h with the change already sitting in OP
 *      before the slow sync starts).
 *
 * ── IDS / NAMES ─────────────────────────────────────────────────────────────
 * Projects 8500/8501, versions 8510/8511 and work packages 85001–85040 are all
 * previously unused across `fixtures/scenarios/*` (checked — the neighbouring
 * band 83001–84090 belongs to s16/s17). The cast is the SHARED dev/tester/
 * customer cast, so this fixture mints NO new person name: the Increment-15
 * "identity = name" collision hazard is avoided by not creating a new identity
 * at all. Karel Zákazník's OP id 3 deliberately collides with s17's Cameron
 * Dalby (also id 3, a different server) — that is the SPEC_23 §2 cross-server
 * identity regression, re-asserted for free rather than re-fixtured.
 */
import type { Scenario } from "../scenario-types";
import { cast, on } from "./helpers";

/** The project whose version-scoped selection creates the coverage hole. */
export const S19_PROJECT_CORE = 8500;
/** A second project with NO import selection — the Increment-25 by-id path. */
export const S19_PROJECT_ARCHIVE = 8501;
/** The version an import selection is scoped to. */
export const S19_VERSION_SELECTED = 8510;
/** The version NOTHING selects — where the drifted tickets end up. */
export const S19_VERSION_UNSELECTED = 8511;

/** The ticket that is REMOVED in s20 — a cached row OP no longer returns. */
export const S19_ORPHAN_WP = 85040;

export const s19SyncCoverage: Scenario = {
  name: "s19-sync-coverage",
  description:
    "Increment 29 / SPEC_29 coverage fixture: project 8500 is imported version-scoped (8510 " +
    '"Coverage Wave 1"), and on day 1 five tickets DRIFT to version 8511 "Coverage Backlog Deep" ' +
    "— a version nothing selects — so a version-scoped sync stops returning them while the old " +
    "orphans pass still considers their project covered. #85010 gains its 8h estimate at the same " +
    "moment (the #11948 shape: OP says PT8H, the cache says nothing, every later full sync reports " +
    "success). #85020 sits in project 8501, which has no import selection at all (the Increment-25 " +
    "add-by-id path). #85030 changes on day 2 for the mid-run race leg, #85001 on day 3 for the " +
    '"capacity must not move while a sync runs" leg, and #85040 is the ticket s20 removes so it ' +
    "becomes a reportable orphan. SUGGESTED SETUP: import 8500 scoped to version 8510, add #85020 " +
    "by id, advance a day, then Sync now and check every row's cached_at.",
  startDate: "2026-07-20",
  seed: {
    users: cast(),
    versions: [
      {
        key: "v_selected",
        id: S19_VERSION_SELECTED,
        name: "Coverage Wave 1",
        projectId: S19_PROJECT_CORE,
      },
      {
        key: "v_unselected",
        id: S19_VERSION_UNSELECTED,
        name: "Coverage Backlog Deep",
        projectId: S19_PROJECT_CORE,
      },
    ],
    projects: [
      { id: S19_PROJECT_CORE, identifier: "osp-coverage-core", name: "OSP Coverage Core" },
      {
        id: S19_PROJECT_ARCHIVE,
        identifier: "osp-coverage-archive",
        name: "OSP Coverage Archive",
      },
    ],
    workPackages: [
      {
        // Capacity subject. Its estimate DOUBLES on day 3 with the change
        // already in OP before a deliberately slow sync starts — the only way
        // to prove staging + atomic swap (numbers hold, then land at once).
        key: "cap-a",
        id: 85001,
        subject: "Split the settlement reconciliation job",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: 5,
        remainingHours: 5,
      },
      {
        key: "cap-b",
        id: 85002,
        subject: "Cache the merchant descriptor lookup",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: 3,
        remainingHours: 3,
      },
      {
        // ⚠️ THE #11948 ANALOGUE. Starts in the SELECTED version with NO
        // estimate, so a normal import caches it empty; on day 1 it drifts to
        // the unselected version AND gains its 8h estimate. From then on a
        // version-scoped sync cannot see it and the old orphans pass skips it
        // (its project is selected) — the cache keeps `estimated_hours = NULL`
        // and a frozen `cached_at` through any number of "successful" syncs.
        key: "drifted-estimate",
        id: 85010,
        subject: "Re-key the archived settlement ledger",
        project: S19_PROJECT_CORE,
        status: "In progress",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: null,
        remainingHours: null,
      },
      {
        // A second drifted row, deletable in the §6 bulk cleanup (never enters
        // a sprint). Assigned to `customer` (OP user id 3) so the cross-server
        // id-3 identity collision with s17's Cameron Dalby is exercisable.
        key: "drifted-plain",
        id: 85011,
        subject: "Archive the 2024 chargeback exports",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "customer",
        version: "v_selected",
        estimatedHours: 2,
        remainingHours: 2,
      },
      {
        // A third drifted row — this one goes INTO a sprint, so the bulk
        // cleanup must list it and refuse to delete it.
        key: "drifted-in-sprint",
        id: 85012,
        subject: "Verify the nightly reconciliation report",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "tester",
        version: "v_selected",
        estimatedHours: 4,
        remainingHours: 4,
      },
      {
        // Two more drifted rows, deletable and NEVER in a sprint. §B5 needs
        // BOTH an API-level bulk delete and a browser-level one, and a delete
        // is not repeatable — so the fixture supplies two disjoint pairs
        // rather than letting one leg depend on the other not having run.
        key: "drifted-bulk-a",
        id: 85013,
        subject: "Purge the 2023 terminal parameter snapshots",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: 1,
        remainingHours: 1,
      },
      {
        key: "drifted-bulk-b",
        id: 85014,
        subject: "Retire the unused acquirer sandbox profile",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: 1,
        remainingHours: 1,
      },
      {
        // The RACE subject: changed on day 2, which the spec applies WHILE a
        // latency-stalled sync is in flight. The following run must pick it up.
        key: "race-target",
        id: 85030,
        subject: "Tune the batch export throughput guard",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: 6,
        remainingHours: 6,
      },
      {
        // Present here, ABSENT from s20 — loading s20 into the same mock makes
        // this a cached row OpenProject no longer returns, i.e. a reportable
        // (and deliberately NOT auto-deleted) orphan.
        key: "vanishing",
        id: S19_ORPHAN_WP,
        subject: "Decommission the legacy FX rate feed",
        project: S19_PROJECT_CORE,
        status: "New",
        assignee: "dev",
        version: "v_selected",
        estimatedHours: 3,
        remainingHours: 3,
      },
      {
        // Project 8501 is NEVER imported — this ticket can only enter the cache
        // through `POST /sprints/:id/items/by-id` (Increment 25). Done + no
        // remaining work, exactly the "overnight AU ticket" that endpoint
        // exists for. `remainingHours: 0` ⇒ effectiveEstimate falls back to
        // Work, so the day-1 estimate change is visible as 7h → 9h.
        key: "archive-only",
        id: 85020,
        subject: "Overnight AU reconciliation rerun",
        project: S19_PROJECT_ARCHIVE,
        status: "Tested",
        assignee: "dev",
        estimatedHours: 7,
        remainingHours: 0,
      },
    ],
    timeEntries: [
      // Gives the by-id add a deterministic backdating anchor (earliest
      // spentOn) instead of falling through to createdAt.
      { wp: "archive-only", user: "dev", hours: 7, spentOn: "2026-07-20" },
    ],
  },
  timeline: [
    // ── day 1 — the drift that opens the coverage hole ──────────────────────
    on(
      1,
      { t: "setVersion", wp: "drifted-estimate", version: "v_unselected" },
      // …and the estimate that must reach the cache anyway (#11948).
      { t: "setEstimate", wp: "drifted-estimate", hours: 8 },
      { t: "setVersion", wp: "drifted-plain", version: "v_unselected" },
      { t: "setVersion", wp: "drifted-in-sprint", version: "v_unselected" },
      { t: "setVersion", wp: "drifted-bulk-a", version: "v_unselected" },
      { t: "setVersion", wp: "drifted-bulk-b", version: "v_unselected" },
      // The by-id ticket changes too: its project is in no selection at all, so
      // this proves the OLD escape route stays covered by the NEW pass.
      { t: "setEstimate", wp: "archive-only", hours: 9 },
    ),
    // ── day 2 — applied WHILE a sync is in flight (the race leg) ────────────
    on(
      2,
      { t: "setEstimate", wp: "race-target", hours: 12 },
      { t: "setRemaining", wp: "race-target", hours: 12 },
    ),
    // ── day 3 — pre-loaded before a slow sync (the atomic-swap leg) ─────────
    on(
      3,
      { t: "setEstimate", wp: "cap-a", hours: 20 },
      { t: "setRemaining", wp: "cap-a", hours: 20 },
    ),
  ],
};
