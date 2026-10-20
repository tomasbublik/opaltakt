/**
 * S14 — backlog filter-matrix + pagination scale (SPEC_19 §1/§3 + §2).
 *
 * Two jobs in one fixture, deliberately kept separate from every project-3
 * scenario so an e2e spec can scope to its OWN project ids / connection and
 * assert EXACT dropdown option lists without cross-scenario cache pollution:
 *
 *  A) FILTER MATRIX (SPEC_19 §1/§3 cascading options + case-insensitive match).
 *     A realistic spread across Status / Assignee / Version / Priority /
 *     Project so every facet has real, distinguishable combinations to exercise
 *     — and so the CASCADING option logic (each facet respects every OTHER
 *     active filter) has a case where a naive, non-cascading design would offer
 *     an "individually valid, jointly empty" pair.
 *
 *  B) PAGINATION SCALE (SPEC_19 §2 abort test). Project 90 holds 120 work
 *     packages — with the sync engine's PAGE_SIZE = 100 that is 2 real pages, so
 *     the between-pages cancel check is genuinely reached mid-sync (a 1-page
 *     sync can never be aborted — the loop breaks and commits before the next
 *     poll). Combined with the mock's injected per-page latency
 *     (`POST /__mock/set-latency-ms`) the "click Abort while a sync is in
 *     flight" window is deterministic, not a race.
 *
 * ── THE "INDIVIDUALLY VALID, JOINTLY EMPTY" COMBINATION (the actual fix) ─────
 * SPEC_19 §1's literal bug narrative (dropdown "In progress" vs stored
 * "in progress") does NOT reproduce with today's internally-consistent mock
 * casing, so this fixture reproduces the SAME CLASS of bug structurally: a
 * combination that LOOKS selectable but returns 0 rows under a non-cascading
 * options design, which the new cascading options must never OFFER.
 *
 *   Version "3.5.040" (id 4610, key v_iso) holds tickets whose status is
 *   EXCLUSIVELY "In progress" (8 of them). The status "Merge pending" exists
 *   elsewhere in the SAME backlog/connection (version "3.5.041", v_mixed) but
 *   NEVER on a v_iso ticket.
 *
 *   → NON-cascading (the bug): Status offers "Merge pending" and Version offers
 *     "3.5.040" independently, so a user can pick  version=3.5.040 + status=
 *     "Merge pending"  → 0 rows (exactly the reported dead-end).
 *   → CASCADING (the fix): with version=3.5.040 selected, the Status facet is
 *     computed from v_iso's rows only → it offers ["In progress"] and NOTHING
 *     else, so "Merge pending" is never selectable alongside it. Symmetrically,
 *     with status="Merge pending" selected the Version facet drops "3.5.040".
 *     Every combination the UI can actually reach returns ≥1 row.
 *
 *   The mirror also holds: "In progress" lives ONLY on v_iso within project 90,
 *   so  version=3.5.041 + status="In progress"  is the same trap in reverse.
 *
 * ── HIDDEN-STATUS "never offered" bonus ─────────────────────────────────────
 * v_mixed also carries 4 tickets in HIDDEN_BACKLOG_STATUSES (Closed / Tested /
 * Resolved / Rejected). They ARE cached (so they count toward the 120-ticket /
 * 2-page sync total) but are excluded from the /backlog view — so a correct
 * filter-options response must never offer any of those four as a Status
 * option. That is the other half of "only real, achievable values appear".
 *
 * ── EXPECTED OUTCOME (facets scoped to projectId=90, the isolated set) ───────
 *   Statuses  : [Confirmed, Developed, In progress, Merge pending, New, On hold]
 *               (6 visible; the 4 hidden statuses NEVER appear)
 *   Versions  : [3.5.040 (4610), 3.5.041 (4611)]
 *   Assignees : Radek Prochazka(220), Simona Nemcova(221), Filip Ruzicka(222),
 *               Andrea Kolarova(223), Martin Vesely(224) — 5 people
 *   Priorities: [High, Immediate, Low, Normal]
 *   Cascades  : version=4610 ⇒ statuses=[In progress]; status="Merge pending"
 *               ⇒ versions=[4611]; assignee=223/224 ⇒ versions=[4611] (Andrea
 *               and Martin hold work only in v_mixed); priority=Immediate ⇒
 *               versions=[4611].
 *   v_iso backlog rows (project 90, version 4610) = exactly 8, all In progress.
 *   Project facet (scoped to the connection) = [OSP Filter Demo (90),
 *               OSP Filter Demo B (91)].
 *
 * ROLES-TO-SET: none — this scenario is about backlog filtering + sync abort,
 * not the role-aware done matrix. No timeline / no time entries (the seed IS
 * the state; every ticket keeps the frozen `${startDate}T08:00:00Z` stamp, so
 * an INCREMENTAL re-sync — updatedAt >= max — legitimately re-fetches all 120,
 * giving the incremental-abort case its own 2-page window too, SPEC_19 §5).
 *
 * FRESH-NAME / FRESH-ID NOTE (Increment 15 collision gotcha): the 5 assignees
 * (ids 220-224) and both projects (90/91) appear in NO other fixture
 * (grep-verified against fixtures/scenarios/s*.ts); versions 4610/4611/4680 and
 * every WP id (19001-19305) are likewise unique. Identity here is by OP user id
 * (backlog filters on assignee op_id, not name), so even the shared e2e DB
 * cannot confuse a filter facet across specs.
 */
import type { Scenario, ScenarioProject, ScenarioUser, WorkPackageSeed } from "../scenario-types";
import { cast } from "./helpers";

// ── Cast: the common dev/tester/customer (keeps the /users/me invariant) plus
//    five FRESH assignees that exist in no other fixture. ─────────────────────
const ASSIGNEE_USERS: readonly ScenarioUser[] = [
  { key: "radek", id: 220, name: "Radek Prochazka", login: "radek.prochazka" },
  { key: "simona", id: 221, name: "Simona Nemcova", login: "simona.nemcova" },
  { key: "filip", id: 222, name: "Filip Ruzicka", login: "filip.ruzicka" },
  { key: "andrea", id: 223, name: "Andrea Kolarova", login: "andrea.kolarova" },
  { key: "martin", id: 224, name: "Martin Vesely", login: "martin.vesely" },
];

const PROJECTS: readonly ScenarioProject[] = [
  { id: 90, identifier: "osp-filter-demo", name: "OSP Filter Demo" },
  { id: 91, identifier: "osp-filter-demo-b", name: "OSP Filter Demo B" },
];

// Visible (non-hidden) canonical statuses used by v_mixed — deliberately NEVER
// "In progress" (that status is exclusive to v_iso, powering the jointly-empty
// pair). HIDDEN_BACKLOG_STATUSES (closed/tested/resolved/rejected) are handled
// separately below.
const V_MIXED_STATUSES = ["New", "Confirmed", "Developed", "Merge pending", "On hold"] as const;
const V_MIXED_PRIOS = ["Low", "Normal", "High", "Immediate"] as const;
const ISO_ASSIGNEES = ["radek", "simona", "filip"] as const; // Andrea/Martin absent → cascade proof
const ISO_PRIOS = ["High", "Normal"] as const;
const ALL_ASSIGNEES = ASSIGNEE_USERS.map((u) => u.key);

function buildWorkPackages(): WorkPackageSeed[] {
  const wps: WorkPackageSeed[] = [];

  // v_iso (3.5.040, project 90) — 8 tickets, status EXCLUSIVELY "In progress".
  for (let i = 0; i < 8; i += 1) {
    wps.push({
      key: `iso-${i}`,
      id: 19001 + i,
      subject: `Gateway 3.5.040 in-progress task ${i + 1}`,
      project: 90,
      status: "In progress",
      assignee: ISO_ASSIGNEES[i % ISO_ASSIGNEES.length]!,
      priority: ISO_PRIOS[i % ISO_PRIOS.length]!,
      estimatedHours: 4,
      remainingHours: 4,
      version: "v_iso",
    });
  }

  // v_mixed (3.5.041, project 90) — 108 VISIBLE tickets spanning 5 statuses /
  // 5 assignees / 4 priorities. Bulk that (with v_iso) makes project 90 span 2
  // pages at PAGE_SIZE=100.
  for (let i = 0; i < 108; i += 1) {
    wps.push({
      key: `mix-${i}`,
      id: 19100 + i,
      subject: `Gateway 3.5.041 backlog item ${i + 1}`,
      project: 90,
      status: V_MIXED_STATUSES[i % V_MIXED_STATUSES.length]!,
      assignee: ALL_ASSIGNEES[i % ALL_ASSIGNEES.length]!,
      priority: V_MIXED_PRIOS[i % V_MIXED_PRIOS.length]!,
      estimatedHours: (i % 3) + 1,
      remainingHours: (i % 3) + 1,
      version: "v_mixed",
    });
  }

  // v_mixed hidden-status tickets — cached (count toward the 2-page sync) but
  // excluded from /backlog, so filter-options must never offer these statuses.
  const HIDDEN = ["Closed", "Tested", "Resolved", "Rejected"] as const;
  HIDDEN.forEach((status, i) => {
    wps.push({
      key: `hidden-${i}`,
      id: 19208 + i,
      subject: `Gateway 3.5.041 completed (${status}) ${i + 1}`,
      project: 90,
      status,
      assignee: "radek",
      priority: "Normal",
      estimatedHours: 2,
      remainingHours: 0,
      version: "v_mixed",
    });
  });

  // v_core (project 91) — 6 tickets, purely so the Project facet has a real
  // second value to narrow on.
  for (let i = 0; i < 6; i += 1) {
    wps.push({
      key: `core-${i}`,
      id: 19300 + i,
      subject: `OSP Filter Demo B item ${i + 1}`,
      project: 91,
      status: i % 2 === 0 ? "New" : "In progress",
      assignee: "radek",
      priority: "Normal",
      estimatedHours: 3,
      remainingHours: 3,
      version: "v_core",
    });
  }

  return wps;
}

export const s14BacklogFilterMatrix: Scenario = {
  name: "s14-backlog-filter-matrix",
  description:
    "SPEC_19 backlog filter-matrix + pagination-scale fixture: 120 work packages in project 90 (2 pages at " +
    "PAGE_SIZE=100 for a deterministic sync-abort window) across versions 3.5.040/3.5.041, six visible statuses, " +
    "five assignees and four priorities, plus a small project 91 for the Project facet. Version 3.5.040 is " +
    "status-exclusively 'In progress' while 'Merge pending' lives only in 3.5.041 — the individually-valid, " +
    "jointly-empty pair that a non-cascading options design would offer but the SPEC_19 cascading logic must not. " +
    "Four hidden-status tickets prove filter-options never offers Closed/Tested/Resolved/Rejected.",
  startDate: "2026-07-06",
  seed: {
    users: [...cast(), ...ASSIGNEE_USERS.map((u) => ({ ...u }))],
    projects: PROJECTS.map((p) => ({ ...p })),
    versions: [
      { key: "v_iso", id: 4610, name: "3.5.040", projectId: 90 },
      { key: "v_mixed", id: 4611, name: "3.5.041", projectId: 90 },
      { key: "v_core", id: 4680, name: "Filter Demo Backlog", projectId: 91 },
    ],
    workPackages: buildWorkPackages(),
  },
  // The seed IS the state — backlog filtering + sync abort, not a burndown.
  timeline: [],
};
