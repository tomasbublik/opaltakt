/**
 * S2 — status-spectrum (SPEC_03 §7, covers §2 b).
 *
 * Exactly one work package per each of the 10 canonical statuses, nothing
 * moves (no timeline). Sanity fodder for backlog filters and for configuring
 * the done_status_rule: /api/v3/statuses must report Rejected/Resolved/Closed
 * as isClosed=true and everything else as open.
 */
import type { Scenario, WorkPackageSeed } from "../scenario-types";
import { CANONICAL_STATUSES } from "../scenario-types";
import { cast } from "./helpers";

// One WP per canonical status; ids 1201… in spectrum order. Open items keep
// remaining == estimate, dev-done/verification statuses are near zero and
// closed statuses are fully burned so filter results look believable.
const REMAINING_BY_STATUS: Record<string, number> = {
  "New": 8,
  "Confirmed": 6,
  "In progress": 3,
  "Developed": 0,
  "Merge pending": 1,
  "Tested": 0,
  "On hold": 4,
  "Rejected": 0,
  "Resolved": 0,
  "Closed": 0,
};

const ASSIGNEES: ReadonlyArray<string | null> = [
  "dev", // New
  "dev", // Confirmed
  "dev", // In progress
  "tester", // Developed — handed over for verification
  "dev", // Merge pending
  "customer", // Tested — waiting for acceptance
  "dev", // On hold
  null, // Rejected — nobody works on it
  "customer", // Resolved
  null, // Closed
];

const workPackages: WorkPackageSeed[] = CANONICAL_STATUSES.map((status, i) => ({
  key: `wp-${status.name.toLowerCase().replace(/\s+/g, "-")}`,
  id: 1201 + i,
  subject: `WP in status ${status.name}`,
  project: 3,
  status: status.name,
  assignee: ASSIGNEES[i] ?? null,
  accountable: "customer",
  estimatedHours: 8,
  remainingHours: REMAINING_BY_STATUS[status.name] ?? 8,
}));

export const s2StatusSpectrum: Scenario = {
  name: "s2-status-spectrum",
  description:
    "One WP per each of the 10 canonical statuses (ids 1201-1210, subjects 'WP in status X'), " +
    "static — no timeline. Use it to sanity-check backlog status filters, the isClosed mapping " +
    "(Rejected/Resolved/Closed are the only closed statuses) and the done_status_rule config: " +
    "flipping Developed/Merge pending/Tested in and out of the rule must move exactly one WP " +
    "each. SUGGESTED SETUP: import Demo Project and browse the backlog; optionally create " +
    "sprint 2026-07-01 -> 2026-07-09 and pull a few statuses in to see done vs rejected split.",
  startDate: "2026-07-01",
  seed: {
    users: cast(),
    versions: [],
    workPackages,
  },
  timeline: [],
};
