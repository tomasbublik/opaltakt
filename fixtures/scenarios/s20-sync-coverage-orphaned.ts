/**
 * S20 — S19 with one work package REMOVED (SPEC_29 §1.4 / contracts §4.2).
 *
 * ── WHY A SECOND SCENARIO RATHER THAN AN ADMIN ROUTE ────────────────────────
 * An orphan is "a row in the local cache that OpenProject no longer returns".
 * The mock engine has no delete-work-package operation — deliberately: every
 * mutation is a declarative timeline event, and OP itself is READ-ONLY to this
 * app, so there is no app path that could delete an OP ticket either. The one
 * honest way to make a ticket disappear from a mock instance is to load a
 * DIFFERENT scenario into it.
 *
 * So S20 is S19 minus `vanishing` (#85040), DERIVED from S19 rather than
 * copy-pasted, so the two can never drift apart. Loading S20 into a mock that
 * already served S19 (then `goto-day` back to the same logical day) leaves the
 * OP side identical in every respect EXCEPT that #85040 is gone — which is
 * precisely the condition the coverage pass must report as an orphan and, just
 * as importantly, must NOT act on: a row hidden by permissions looks exactly
 * like a deleted one, and hard-deleting the user's sprint history on a guess is
 * not a recoverable mistake.
 *
 * Nothing in S19's timeline touches `vanishing`, so the timeline is reused
 * verbatim; the filter below is still written as a filter (not an assumption)
 * so adding an event later cannot silently produce an invalid scenario.
 */
import type { Scenario } from "../scenario-types";
import { S19_ORPHAN_WP, s19SyncCoverage } from "./s19-sync-coverage";

/** The one work package S20 does NOT have. Re-exported for the e2e spec. */
export const S20_MISSING_WP = S19_ORPHAN_WP;

const missingKey = s19SyncCoverage.seed.workPackages.find(
  (w) => w.id === S19_ORPHAN_WP,
)?.key;

export const s20SyncCoverageOrphaned: Scenario = {
  ...s19SyncCoverage,
  name: "s20-sync-coverage-orphaned",
  description:
    "s19-sync-coverage with work package 85040 removed, and nothing else changed. Loading it into a " +
    "mock that already served s19 (then fast-forwarding to the same logical day) makes #85040 a row " +
    "that exists in the local work_package_cache but that OpenProject no longer returns — the exact " +
    "condition SPEC_29 §1.4 requires the sync to REPORT as an orphan and contracts §4.2 forbids it " +
    "from deleting. It is also the only deterministic way to force not_refreshed > 0 after a " +
    "successful run, which is what the UI must warn about. SUGGESTED SETUP: run the s19 flow, then " +
    "load this scenario into the same mock instance and Sync now.",
  seed: {
    ...s19SyncCoverage.seed,
    users: s19SyncCoverage.seed.users.map((u) => ({ ...u })),
    workPackages: s19SyncCoverage.seed.workPackages.filter(
      (w) => w.id !== S19_ORPHAN_WP,
    ),
    timeEntries: (s19SyncCoverage.seed.timeEntries ?? []).filter(
      (te) => te.wp !== missingKey,
    ),
  },
  timeline: s19SyncCoverage.timeline.map((d) => ({
    day: d.day,
    events: d.events.filter((e) =>
      e.t === "addWorkPackage" ? e.wp.key !== missingKey : e.wp !== missingKey,
    ),
  })),
};
