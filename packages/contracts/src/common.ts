import { z } from "zod";

/**
 * Shared primitives & enums used across entities and the REST API.
 * Field names & semantics mirror SPEC §4 exactly. Do not rename after Phase 0.
 */

/** Local SQLite auto-increment primary key. */
export const LocalId = z.number().int().positive();
export type LocalId = z.infer<typeof LocalId>;

/** An OpenProject numeric id (user / project / work package / version / status). */
export const OpId = z.number().int().positive();
export type OpId = z.infer<typeof OpId>;

/** ISO-8601 date-time string, e.g. "2026-07-01T10:00:00Z". */
export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Calendar date, "YYYY-MM-DD". */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export type IsoDate = z.infer<typeof IsoDate>;

// ── Enums (SPEC §4) ────────────────────────────────────────────────────────

/** sprint.status */
export const SprintStatus = z.enum(["planning", "active", "closed"]);
export type SprintStatus = z.infer<typeof SprintStatus>;

/** sprint.capacity_mode */
export const CapacityMode = z.enum(["per_person", "aggregate"]);
export type CapacityMode = z.infer<typeof CapacityMode>;

/**
 * sprint_item.outcome — items are never deleted, only re-outcomed.
 * `removed_mid_sprint` (Increment 5, SPEC_05) is DISTINCT from the classic
 * `removed` (removed while still "planning", or drift-reconciled because the
 * WP vanished from OP entirely): a mid-sprint removal keeps the ticket's
 * ALREADY-LOGGED hours counted in burndown/velocity while it stops counting
 * as a commitment — see apps/api/src/logic/scopeCapacity.ts.
 */
export const SprintItemOutcome = z.enum([
  "planned",
  "done",
  "carried",
  "removed",
  "removed_mid_sprint",
]);
export type SprintItemOutcome = z.infer<typeof SprintItemOutcome>;

/** sync_run.kind */
export const SyncKind = z.enum(["full", "incremental", "snapshot"]);
export type SyncKind = z.infer<typeof SyncKind>;

/**
 * sync_run.status. Increment 19 (SPEC_19 §2c): `"aborted"` is a user-cancelled
 * run — distinct from `"error"` (an unexpected failure). Both leave the cache
 * exactly as it was before the run started (SyncEngine buffers all upserted
 * rows in memory and only writes them once, after the LAST page completes
 * without cancellation — an aborted run never calls `workPackages.upsertMany`
 * at all, so there is nothing to roll back).
 */
export const SyncStatus = z.enum(["running", "success", "error", "aborted"]);
export type SyncStatus = z.infer<typeof SyncStatus>;

/** done_status_rule.counts_as */
export const DoneCountsAs = z.enum(["done", "rejected"]);
export type DoneCountsAs = z.infer<typeof DoneCountsAs>;

// ── Increment 2: connections & vault (SPEC_02) ─────────────────────────────

/** op_connection.last_status — health of one stored OP server. */
export const ConnectionStatus = z.enum(["ok", "fail", "unknown"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * Aggregate header-indicator color across ALL stored connections (SPEC_02 §4):
 * green = all ok; orange = at least one ok AND at least one fail/unknown;
 * red = at least one fail and none ok; neutral = nothing configured, vault
 * locked, or nothing tested yet (all unknown).
 */
export const AggregateHealthColor = z.enum(["green", "orange", "red", "neutral"]);
export type AggregateHealthColor = z.infer<typeof AggregateHealthColor>;

/** vault_meta.kdf_algo — key-derivation function for the token vault. */
export const KdfAlgo = z.enum(["argon2id", "scrypt"]);
export type KdfAlgo = z.infer<typeof KdfAlgo>;

// ── Increment 4: sprint lifecycle, scoped update, changelog (SPEC_04) ──────

/** sprint_update_run.kind — activation captures the baseline; update is a
 * manual/scheduled diff pass; final runs once right before locking.
 * `reactivate` (Increment 11, SPEC_11 §8) is a pure audit marker — it runs no
 * scoped fetch, just records that a locked sprint was unlocked back to
 * "active" (who/when, via triggered_by + started_at/finished_at). */
export const UpdateRunKind = z.enum(["activation", "update", "final", "reactivate"]);
export type UpdateRunKind = z.infer<typeof UpdateRunKind>;

/** sprint_update_run.triggered_by — who/what caused this run. */
export const UpdateRunTriggeredBy = z.enum([
  "manual",
  "scheduler",
  "finish",
  "end_date",
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b step 2): the freeze
  // sweep's own final update() run, wrapped in the SAME sprint_update_run
  // machinery (kind "update") as every other pass — so its crash recovery
  // and watchdog coverage apply here too, with a distinct trigger label so a
  // freeze's own final pass is distinguishable in the run history from an
  // ordinary grace-window update.
  "freeze",
]);
export type UpdateRunTriggeredBy = z.infer<typeof UpdateRunTriggeredBy>;

/** sprint.lock_reason — why a sprint became immutable. */
export const LockReason = z.enum(["finished", "end_date"]);
export type LockReason = z.infer<typeof LockReason>;

/**
 * ticket_changelog_entry.kind. `closed` is emitted ALONGSIDE `status_changed`
 * (never instead of it) exactly when a status transition's new status has
 * isClosed=true and the old one didn't — see apps/api/src/logic/sprintUpdate.ts
 * for the full derivation algorithm.
 */
export const ChangelogKind = z.enum([
  "time_logged",
  "status_changed",
  "assignee_changed",
  "accountable_changed",
  "closed",
  "estimate_changed",
  "remaining_changed",
  "version_changed",
  "other",
  // Increment 5 (SPEC_05 §3): local scope changes, source="local", never from OP.
  "scope_added",
  "scope_removed",
  /**
   * Increment 10 (SPEC_10 §d): a non-empty OP activity comment, no content
   * stored (just the fact — actor_op_id/actor_name/occurred_at on the entry
   * itself already carry who/when). Previously a pure-comment activity (no
   * details[]) was silently dropped entirely.
   */
  "comment_added",
]);
export type ChangelogKind = z.infer<typeof ChangelogKind>;

/** ticket_changelog_entry.source — journal = OP activity, time_entry = OP time
 * entry, diff = derived by comparing snapshots (fallback only, never primary),
 * local = a scope change made in the app itself (Increment 5) — OP has no
 * journal for "added/removed from a local sprint", so there's nothing to read. */
export const ChangelogSource = z.enum(["journal", "time_entry", "diff", "local"]);
export type ChangelogSource = z.infer<typeof ChangelogSource>;

// ── Increment 5: live scope changes + capacity segments (SPEC_05) ──────────

/** sprint_item.origin / ticket_baseline.origin — was this ticket present at
 * activation, added while the sprint was already running, or (Increment 25,
 * SPEC_25) added by ID for a ticket that was already done OUTSIDE the sprint
 * entirely (never synced into the backlog) — backdated to when it actually
 * happened, not "now". Renders identically to `added_mid_sprint` in the UI
 * (same "Added" badge, SPEC_25 §5) — the distinction is data-only (audit). */
export const SprintItemOrigin = z.enum(["baseline", "added_mid_sprint", "added_retroactively"]);
export type SprintItemOrigin = z.infer<typeof SprintItemOrigin>;

/** sprint_item.retro_source (Increment 25, SPEC_25 §4/§6) — which OP fact
 * `added_at` was backdated FROM, set only when origin === "added_retroactively":
 * the ticket's own first logged time entry (`spentOn`), or, when it has no
 * logged time at all, its OP `createdAt`. Null for every other origin. */
export const RetroAddSource = z.enum(["first_time_entry", "created_at"]);
export type RetroAddSource = z.infer<typeof RetroAddSource>;

// ── Increment 11: burndown Remaining rule, delete, reactivate (SPEC_11) ─────

/**
 * Default remaining_status_rule.status_name seed (SPEC_11 §6): only tickets
 * WITH an estimate in one of these statuses count toward burndown Remaining.
 * Matched case-insensitively/trimmed against work_package_cache.status_name
 * (same convention as apps/api's HIDDEN_BACKLOG_STATUSES) — OP status display
 * names vary in case per project/server, the rule does not.
 */
export const DEFAULT_REMAINING_STATUSES = ["New", "Confirmed", "In progress"] as const;

// ── Increment 12: retrospective planning, history rebuild (SPEC_12) ────────

/**
 * sprint.retro_seed_kind — how a retrospective sprint's candidate tickets
 * were selected: from an OP version (default/recommended, SPEC_12 §2 path A),
 * a pasted list of ids (path B), or built up via ordinary manual add-from-
 * backlog calls (path C — the sprint is still `is_retrospective`, but no bulk
 * seed call was ever made, so there's no kind/value to record). Null on a
 * non-retrospective sprint.
 */
export const RetroSeedKind = z.enum(["version", "ids", "manual"]);
export type RetroSeedKind = z.infer<typeof RetroSeedKind>;

/** burndown_snapshot.source — a live nightly-job point vs one computed by
 * retrospective replay / a manual rebuild (SPEC_12 §1/§5) from OP journals +
 * time entries instead of being written incrementally day-by-day. */
export const BurndownSnapshotSource = z.enum(["live", "reconstructed"]);
export type BurndownSnapshotSource = z.infer<typeof BurndownSnapshotSource>;

// ── Increment 14: person roles, role-aware done matrix, closure/reports ────

/**
 * team_member.role (SPEC_14 §2) — an attribute of the PERSON (builds on
 * Increment 13 "person = name"), not of any single ticket. Drives the
 * done-matrix's role-dependent branch AND "capacity = developers only".
 * `unset` is the seed default and is NEVER guessed — a role-dependent-status
 * ticket held by an `unset` person routes to the "ambiguous" bucket instead
 * of being silently counted either way (same "admit, don't infer" principle
 * Increment 13 applied to identity).
 */
export const PersonRole = z.enum(["developer", "tester", "customer", "other", "unset"]);
export type PersonRole = z.infer<typeof PersonRole>;

/**
 * done_rule.kind (SPEC_14 §2, global — NOT per-sprint, unlike
 * done_status_rule/DoneCountsAs above, which stays untouched and is still
 * used by the pre-Increment-14 velocity/closure-report path):
 *  - always_done: the status alone proves dev work ended, role irrelevant.
 *  - role_dependent: Developer holder → not done; Tester/Customer/Other → done
 *    (it left the developer's hands). An `unset`-role holder makes the ticket
 *    "ambiguous", not a guess.
 *  - rejected: its own bucket, outside done/not-done entirely.
 */
export const DoneRuleKind = z.enum(["always_done", "role_dependent", "rejected"]);
export type DoneRuleKind = z.infer<typeof DoneRuleKind>;

/** The bucket a ticket's role-aware done classification (SPEC_14 §2 matrix)
 * resolves to. Distinct from — and does not replace — the older two-value
 * DoneCountsAs-based split() used by the existing closure report. */
export const TicketDoneBucket = z.enum(["done", "not_done", "rejected", "ambiguous"]);
export type TicketDoneBucket = z.infer<typeof TicketDoneBucket>;

/**
 * Seed defaults for the global done_rule table (SPEC_14 §2 matrix, confirmed
 * on real sprint 3.5.039 — see DoD). Matched case-insensitively/trimmed
 * against work_package_cache.status_name, same convention as
 * DEFAULT_REMAINING_STATUSES / HIDDEN_BACKLOG_STATUSES.
 */
export const DEFAULT_DONE_RULES: ReadonlyArray<{
  status_name: string;
  kind: DoneRuleKind;
}> = [
  { status_name: "Developed", kind: "always_done" },
  { status_name: "Merge pending", kind: "always_done" },
  { status_name: "Tested", kind: "always_done" },
  { status_name: "Resolved", kind: "always_done" },
  { status_name: "Closed", kind: "always_done" },
  { status_name: "New", kind: "role_dependent" },
  { status_name: "Confirmed", kind: "role_dependent" },
  { status_name: "In progress", kind: "role_dependent" },
  { status_name: "On hold", kind: "role_dependent" },
  { status_name: "Rejected", kind: "rejected" },
];

/** report_config.overshoot_threshold_pct seed default (SPEC_14 §3/§7 #5). */
export const DEFAULT_OVERSHOOT_THRESHOLD_PCT = 25;

// ── Increment 15/17: developer capacity bar driven by real work ─────────────
// SPEC_17 §1 is "v2" of this model — it REPLACES SPEC_15 §2 wherever the two
// differ (not an additive rollout: the v1 kind set below is GONE, not kept
// alongside). The trigger was two real bugs in v1: (BUG 1) a ticket ACQUIRED
// via a dev→dev HANDOFF (not "added to the sprint") never got credited red
// even when the receiving developer logged real time on it — v1's red
// detection was accidentally add-path-only. (BUG 2) v1's single signed
// `planned_delta_hours` let a developer's PLANNED go NEGATIVE (redistributed/
// removed segments subtracted directly from the same number the green
// segments added to) — nonsensical for a "how much did I plan" figure.
//
// v2's fix reshapes the bar's two leading numbers into STRUCTURALLY SEPARATE
// channels instead of one signed total:
//   Planned (bar number 1) = Σ estimate of segments that count_to_planned
//     (kind `baseline_worked` ONLY — Increment 26 merged the former
//     `baseline_idle` row into it) — always >= 0, no subtraction ever lands
//     here.
//   Change (bar number 2, signed) = Σ estimate(`acquired`) − Σ estimate(`removed`)
//     — the ONLY two kinds that move this number; `handoff`/`idle`/`churned`
//     contribute 0 to BOTH numbers (purely informative segments).

/**
 * The colour/meaning of ONE per-ticket segment on a DEVELOPER's capacity bar
 * (SPEC_17 §1 authoritative table, replacing SPEC_15 §2). Segments exist ONLY
 * for people whose team_member.role === "developer" (role-gating unchanged);
 * a tester/customer/other never gets developer segments.
 *
 * Each value maps to exactly one row of SPEC_17 §1's table. The DATA a
 * renderer needs (kind + estimate_hours + logged_hours) lives on
 * DeveloperTicketSegment, so no contract change is ever needed to adjust a
 * colour/style — only to change WHICH kind a ticket×developer pair resolves to.
 *
 *   baseline_worked  — (a) In baseline, this dev still holds it (whether or
 *                      not they've logged time on it — Increment 26,
 *                      docs/CAPACITY_BAR_RULES.md §1/§2: baseline is ALWAYS
 *                      green, never hatched for "not yet logged"). GREEN
 *                      (+logged marker when logged > 0). Planned: +estimate.
 *                      Change: 0. "drží baseline ticket (pracoval na něm,
 *                      nebo zatím ne)".
 *                      Formerly split into a separate `baseline_idle`
 *                      (grey-hatched, "held but not logged") row — ABOLISHED
 *                      by Increment 26. Do not reintroduce it: see
 *                      docs/CAPACITY_BAR_RULES.md §2's explicit "ABOLISHED"
 *                      note and §6 invariant #1.
 *   handoff          — (c) In baseline, but the ticket's FINAL holder is
 *                      ANOTHER DEVELOPER (regardless of whether THIS dev ever
 *                      logged anything themselves). BLUE-HATCHED. Planned: 0
 *                      (NOT counted for the sender — SPEC_17 §7 #1, credit
 *                      belongs to whoever finishes it, tracked via Delivered's
 *                      own max-logged attribution, never via this dev's
 *                      Planned/Change). Change: 0. "přeřazeno jinému vývojáři".
 *   removed          — (d) In baseline, dropped out of this dev's hands
 *                      without being picked up by another developer — EITHER
 *                      the sprint_item itself was removed mid-sprint
 *                      (outcome="removed_mid_sprint") OR the ticket is simply
 *                      unassigned/held by a non-developer with zero logged
 *                      time from this dev. BLUE (solid, not hatched — distinct
 *                      from `handoff`'s blue-HATCHED). Planned: 0 (excluded,
 *                      not "retained"). Change: −estimate (BUG 2 fix: the
 *                      subtraction lives HERE, never in Planned).
 *                      "vyřazen ze sprintu / opuštěn bez práce".
 *   acquired         — (e) NOT in baseline for this dev AND this dev LOGGED
 *                      time on it. RED + logged marker. Planned: 0. Change:
 *                      +estimate. Applies REGARDLESS of HOW the ticket
 *                      reached this developer — a fresh mid-sprint add to the
 *                      sprint AND a dev→dev handoff/reassignment BOTH qualify
 *                      (BUG 1 fix: v1 only detected this for the add path).
 *                      "převzal (odkudkoli) a odpracoval".
 *   idle             — (f) NOT in baseline for this dev, no log, STILL holds
 *                      it. ORANGE-HATCHED — MUST be visually distinct from
 *                      `handoff`'s blue-hatched (both are "assigned, no log
 *                      [by this dev]", but idle (f) never entered Planned at
 *                      all, while a baseline ticket always does — conflating
 *                      the two hatches would visually hide that distinction).
 *                      Planned: 0. Change: 0 (purely informative).
 *                      "drží, mimo baseline, zatím bez logu".
 *   churned          — (g) NOT in baseline for this dev, no log, moved on to
 *                      someone else. BLUE (solid, same style as `removed` —
 *                      both mean "gone, no work done here" — but a DIFFERENT
 *                      kind: `removed` counts −estimate into Change,
 *                      `churned` counts nothing, since it was never this
 *                      dev's committed scope to lose). Planned: 0. Change: 0.
 *                      "krátce držel, mimo baseline, odešlo dál bez práce".
 */
export const DeveloperSegmentKind = z.enum([
  "baseline_worked",
  "handoff",
  "removed",
  "acquired",
  "idle",
  "churned",
]);
export type DeveloperSegmentKind = z.infer<typeof DeveloperSegmentKind>;

/**
 * ⚠️ SUPERSEDED in Increment 30 §2c (`docs/CAPACITY_BAR_RULES.md` §5) — kept as
 * a documented *necessary* condition, but it is NO LONGER what
 * `DeveloperTicketSegment.counts_to_planned` / `planned_delta_hours` are derived
 * from. Read this before using it for anything.
 *
 * Planned is CURRENT SCOPE: a segment contributes its estimate iff the ticket is
 * in the sprint **and the developer that segment belongs to is its holder right
 * now** — whatever colour the segment is. Segment KINDS cannot express that:
 * they encode "who held it at the baseline anchor, and did they log on it".
 * `handoff` in particular means "reassigned to another DEVELOPER", so a baseline
 * ticket handed to a TESTER stays `baseline_worked` on the sender and no kind
 * ever takes it out of their scope — the measured defect where one person's bar
 * annotated 30 h while their Planned read 0 h. The engine therefore tests the
 * holder directly (`apps/api/src/logic/developerSegments.ts`, `makeSegment`).
 *
 * What this map still tells you, correctly: being the current holder IMPLIES a
 * kind marked 1 here, so the kinds marked 0 can never be current scope. It is a
 * coarse upper bound on the flag, not the flag.
 *
 * Both fields stay structurally >= 0 (the Increment-17 BUG 2 fix holds: nothing
 * ever subtracts from Planned; scope LOST is reported by `scope_change_hours`).
 * `SEGMENT_CHANGE_SIGN` is deliberately NOT touched — ±Change keeps its
 * Increment-17 semantics.
 *
 * ⚠️ Neither this map nor `Σ planned_delta_hours` is the source of
 * `DeveloperCapacityBreakdown.planned_hours`: since Increment 30 that number
 * comes from the one canonical current-scope computation
 * (`apps/api/src/logic/plannedScope.ts`), read by the capacity panel, closure,
 * sprint detail and the PDF alike. With §2c the two agree in every case except
 * one measured residual: an `acquired` segment's `estimate_hours` is the
 * estimate AT ACQUISITION (the red bar's length) while the canonical Planned
 * uses the LIVE `effectiveEstimate`. **The canonical value wins for anything
 * displayed as "Planned".**
 */
export const SEGMENT_PLANNED_CONTRIBUTION: Record<DeveloperSegmentKind, 0 | 1> = {
  baseline_worked: 1,
  handoff: 0,
  removed: 0,
  acquired: 1,
  idle: 1,
  churned: 0,
};

/**
 * SPEC_17 §1 — how each segment kind moves a developer's CHANGE total (bar
 * number 2, signed): +1 for `acquired` (row e — mid-sprint scope gained AND
 * actually worked, regardless of add-vs-handoff origin, BUG 1 fix), −1 for
 * `removed` (row d — baseline scope lost with no work done), 0 for every
 * other kind (`handoff`'s −estimate would double-count against the RECEIVING
 * developer's own `acquired` +estimate on the SAME ticket — SPEC_17 §7 #1
 * explicitly excludes it; `baseline_worked` belongs to Planned, not Change;
 * `idle`/`churned` are purely informative).
 * `Change(dev) = Σ sign(kind) × estimate_hours` over the dev's segments.
 * `DeveloperTicketSegment.change_delta_hours` is pre-derived from this map so
 * consumers never re-implement the sign logic.
 */
/**
 * ⚠️ Increment 30 follow-up (`docs/CAPACITY_BAR_RULES.md` §5, product-owner
 * variant A): on the POSITIVE side this map is now only an **upper bound**, not
 * the flag itself — `acquired` counts to ±Change ONLY for the developer who
 * currently holds the ticket. Every acquirer in a chain used to receive
 * +estimate with nothing ever cancelling it (Increment 17 gives the handoff
 * sender 0, not −estimate), so one 12 h ticket passing A→B→C reported +24 h of
 * scope gained. The NEGATIVE side is unchanged and is NOT holder-gated:
 * `removed` means the ticket left the sprint altogether, and such a ticket is
 * never "current scope" for anyone. Same relationship
 * `SEGMENT_PLANNED_CONTRIBUTION` has to `counts_to_planned`.
 */
export const SEGMENT_CHANGE_SIGN: Record<DeveloperSegmentKind, -1 | 0 | 1> = {
  acquired: 1,
  removed: -1,
  baseline_worked: 0,
  handoff: 0,
  idle: 0,
  churned: 0,
};

/**
 * SPEC_17 §1/§4a (Increment 26 update) — the ONLY two segment kinds that ever
 * carry a "logged" marker (the thin overlay/extension showing real hours vs
 * the estimate-length bar, so an overshoot is visible) — rows a and e.
 * `acquired` still requires logged > 0 by definition; `baseline_worked` no
 * longer does (Increment 26 merged the old zero-logged `baseline_idle` row
 * into it) — the marker itself is a no-op visually when logged is 0, so this
 * set stays a purely "which kinds are eligible" list, not a "logged > 0"
 * guarantee. `DeveloperTicketSegment.show_logged_marker` is pre-derived from
 * this set.
 */
export const SEGMENT_LOGGED_MARKER_KINDS: ReadonlySet<DeveloperSegmentKind> =
  new Set<DeveloperSegmentKind>(["baseline_worked", "acquired"]);

/**
 * SPEC_15 §3 — the "dev-hotový" (developer-done) statuses used by the DELIVERED
 * tie-break: on a max-logged tie, DELIVERED goes to whoever HELD the ticket at
 * the moment its status transitioned INTO one of these. Derived from the live
 * done_rule matrix's `always_done` rows; these constants are the SEED default
 * and the safe fallback when the table is empty/unreachable — Agent B should
 * prefer the live `done_rule` table (kind === "always_done") and fall back to
 * this list. Confirmed against SPEC_15 §3's named set
 * (developed/merge pending/tested/resolved/closed).
 */
export const DEV_DONE_TRANSITION_STATUSES: readonly string[] = DEFAULT_DONE_RULES.filter(
  (r) => r.kind === "always_done",
).map((r) => r.status_name);

/**
 * SPEC_15 §3 — the "in-progress-like" source statuses for the DELIVERED
 * tie-break: the transition that credits DELIVERED is one going FROM one of
 * these INTO a DEV_DONE_TRANSITION_STATUSES status. Derived from the live
 * done_rule matrix's `role_dependent` rows (seed = New/Confirmed/In progress/
 * On hold); same live-table-preferred / constant-fallback convention as above.
 */
export const DEV_IN_PROGRESS_TRANSITION_STATUSES: readonly string[] = DEFAULT_DONE_RULES.filter(
  (r) => r.kind === "role_dependent",
).map((r) => r.status_name);
