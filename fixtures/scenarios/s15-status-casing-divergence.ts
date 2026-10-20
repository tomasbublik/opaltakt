/**
 * S15 — status-name casing divergence (SPEC_21 / Increment 21).
 *
 * Purpose-built to REPRODUCE the "duplicate Status filter entries" bug and prove
 * the fix. The root cause: two writers of `status_name` disagreed on casing —
 *   - LIVE SYNC reads the work package's own `_links.status.title`, which is
 *     always OP's canonical spelling ("In progress");
 *   - JOURNAL RECONSTRUCTION (retro seed/replay) parses the LITERAL activity
 *     prose, which historically preserved whatever casing was submitted at the
 *     time ("in progress", lower-case).
 * So the same logical status showed up TWICE in the filter dropdown.
 *
 * To make the mock able to express this at all, `setStatus` gained an optional
 * `statusDisplayText` (see scenario-types.ts / ev.status's `displayText`): the
 * transition's journal renders that raw string, while the WP's live status link
 * still resolves to the canonical status object. Ticket `casing` (1901) below
 * transitions to "In progress" with the journal DISPLAYING "in progress":
 *   - a live sync sees status = "In progress";
 *   - a retrospective replay reconstructing its state after day 1 reads
 *     "in progress" from the journal — the SAME logical status, different casing.
 * Pre-fix this yields two Status filter entries; post-fix (op-client's
 * normalizeStatusName in reconstruct.ts) the reconstructed value canonicalizes
 * to "In progress" and the duplicate disappears.
 *
 * SUGGESTED SETUP (Agent D / e2e): import Demo Project, create a RETROSPECTIVE
 * sprint for version 3.5.039 over 2026-07-06 → 2026-07-09, Activate to replay,
 * then open the Status filter — it must list "In progress" exactly once.
 *
 * Calendar: day 0 = Mon 2026-07-06 … day 3 = Thu 2026-07-09 (weekdays only).
 */
import type { Scenario } from "../scenario-types";
import { cast, ev, on, work } from "./helpers";

export const s15StatusCasingDivergence: Scenario = {
  name: "s15-status-casing-divergence",
  description:
    "Status-casing bug fixture (SPEC_21): ticket 1901 on version 3.5.039 transitions to " +
    "\"In progress\" but its journal DISPLAYS the lower-case \"in progress\" (via statusDisplayText). " +
    "Live sync writes the canonical \"In progress\"; a retro replay reconstructs \"in progress\" from " +
    "the journal — pre-fix that is two Status filter entries, post-fix normalizeStatusName collapses " +
    "them to one canonical \"In progress\".",
  startDate: "2026-07-06",
  seed: {
    users: cast(),
    versions: [{ key: "v_target", id: 41, name: "3.5.039", projectId: 3 }],
    workPackages: [
      {
        key: "casing",
        id: 1901,
        subject: "Casing: journal renders lower-case, link stays canonical",
        project: 3,
        status: "New",
        assignee: "dev",
        accountable: "customer",
        estimatedHours: 6,
        remainingHours: 6,
        version: "v_target",
      },
    ],
  },
  timeline: [
    // Day 1 (Tue 07-07): dev picks it up — the LIVE status becomes canonical
    // "In progress", but the journal for THIS transition displays "in progress".
    on(1, ev.status("casing", "In progress", "in progress"), ...work("casing", "dev", 2, 4)),
    // Day 2 (Wed 07-08): keep burning; still In progress.
    on(2, ...work("casing", "dev", 2, 2)),
    // Day 3 (Thu 07-09): dev-complete (canonical journal casing this time).
    on(3, ...work("casing", "dev", 2, 0), ev.status("casing", "Developed")),
  ],
};
