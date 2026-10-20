import type {
  AddConnectionResponse,
  AppConfigResponse,
  BacklogItem,
  BurndownResponse,
  CapacityAuditResponse,
  CapacityEditAuditEntry,
  ChangelogEntryView,
  ClosedSprintSummary,
  ClosureReportResponse,
  ClosureStatsResponse,
  Connection,
  ConnectionHealth,
  ConnectionsHealthResponse,
  DeveloperCapacityBreakdown,
  DeveloperClosureBreakdown,
  DeveloperTicketSegment,
  PersonSummary,
  Project,
  ReportDetailResponse,
  ReportsListResponse,
  RetroPreviewResponse,
  RetroSeedCandidate,
  RetroSeedResponse,
  Sprint,
  SprintItemDetail,
  SprintPeopleResponse,
  SprintPersonEntry,
  SprintUpdateRun,
  SyncRun,
  SyncStatusResponse,
  TicketClosureDetail,
  TicketEstimateLine,
  UserAliasResponse,
  VaultStatusResponse,
  VelocityResponse,
} from "@osp/contracts";
import type { DoubleCountFields } from "../lib/doubleCounting";
import type { OffSprintTimeResponse } from "../api-client";

/** Test data factories. Not a *.test file, so Vitest does not run it directly. */

export function makeBacklogItem(over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 1,
    connection_id: 1,
    op_id: 1,
    project_op_id: 100,
    project_name: "Demo Project",
    subject: "Do the thing",
    type_name: "Task",
    status_name: "New",
    status_is_closed: false,
    assignee_op_id: null,
    assignee_name: null,
    estimated_hours: null,
    remaining_hours: null,
    spent_hours: null,
    story_points: null,
    version_op_id: null,
    version_name: null,
    priority: null,
    parent_op_id: null,
    percentage_done: null,
    updated_at_op: "2026-06-01T00:00:00Z",
    raw_json: "{}",
    cached_at: "2026-06-01T00:00:00Z",
    override_hours: null,
    effective_hours: null,
    in_sprint: false,
    connection_base_url: "https://op.example.com",
    connection_label: null,
    stale: false,
    ...over,
  };
}

/**
 * GET /sprints/:id/items/detailed (SPEC_07 §5) — a BacklogItem plus the
 * sprint_item fields, all on one row. Convenience wrapper over
 * {@link makeBacklogItem}: pass BacklogItem overrides AND/OR the
 * sprint-only fields (outcome/origin/planned_hours/no_longer_in_backlog) in
 * one call, since production data for a sprint card now comes entirely from
 * this one endpoint (no more cross-referencing a separate backlog fetch).
 */
export function makeSprintItemDetail(
  over: Partial<BacklogItem> &
    Partial<
      Pick<
        SprintItemDetail,
        | "outcome"
        | "origin"
        | "planned_hours"
        | "no_longer_in_backlog"
        | "added_at"
        | "removed_at"
        | "has_history"
        | "done_bucket"
        | "is_done"
        | "holder_role"
        | "ambiguous_reason"
        | "multi_sprint"
      >
    > &
    // Increment 28 (docs/INCREMENT_28_CONTRACTS.md §2a): Agent B's two new
    // always-present fields — not yet on the real `SprintItemDetail` contract
    // type while this agent works ahead of that landing (see
    // ../lib/doubleCounting.ts's doc comment), so accepted/returned here as a
    // local augmentation rather than a `Pick` off the contract type itself.
    Partial<DoubleCountFields> = {},
): SprintItemDetail & DoubleCountFields {
  const base = makeBacklogItem(over);
  const outcome = over.outcome ?? "planned";
  return {
    ...base,
    sprint_item_id: base.op_id,
    outcome,
    origin: over.origin ?? "baseline",
    planned_hours: over.planned_hours ?? base.effective_hours,
    added_at: over.added_at ?? "2026-06-01T00:00:00Z",
    removed_at:
      over.removed_at ?? (outcome === "removed" || outcome === "removed_mid_sprint" ? "2026-06-05T00:00:00Z" : null),
    no_longer_in_backlog: over.no_longer_in_backlog ?? false,
    // Increment 9 (SPEC_09 §2): default true so every existing fixture-using
    // test keeps seeing the History button unless a test explicitly opts a
    // ticket out via `has_history: false`.
    has_history: over.has_history ?? true,
    // Increment 18 (SPEC_18 §3): default to a plain, still-open, fully-lit
    // ticket — a test caring about dimming/ambiguous state overrides these
    // explicitly (done_bucket/is_done/holder_role/ambiguous_reason).
    done_bucket: over.done_bucket ?? "not_done",
    is_done: over.is_done ?? false,
    holder_role: over.holder_role ?? null,
    ambiguous_reason: over.ambiguous_reason ?? null,
    // Increment 28 (§2a): default to "nothing flagged" — a test exercising
    // the double-counting badges/warning overrides these explicitly.
    double_count_children: over.double_count_children ?? [],
    double_count_parent_of: over.double_count_parent_of ?? null,
    // Increment 34 (§3): single-sprint by default; multi-sprint badge tests
    // override explicitly.
    multi_sprint: over.multi_sprint ?? null,
  };
}

export function makeSprint(over: Partial<Sprint> = {}): Sprint {
  return {
    id: 1,
    name: "Sprint 1",
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    status: "planning",
    capacity_mode: "per_person",
    completed_hours: null,
    created_at: "2026-06-01T00:00:00Z",
    closed_at: null,
    activated_at: null,
    locked_at: null,
    is_locked: false,
    lock_reason: null,
    // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1/§2c): set exactly once
    // by the freeze sweep, cleared by reactivate — null by default so every
    // pre-existing fixture-using test keeps seeing an unfrozen sprint unless
    // it opts in explicitly.
    frozen_at: null,
    baseline_total_hours: null,
    // Increment 12 (SPEC_12 §2/§7): retrospective planning fields — off by
    // default, matching every pre-Increment-12 sprint (never opted in).
    is_retrospective: false,
    retro_seed_kind: null,
    retro_seed_value: null,
    retro_replayed_at: null,
    ...over,
  };
}

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    connection_id: 1,
    op_id: 100,
    identifier: "demo",
    name: "Demo Project",
    last_synced_at: null,
    ...over,
  };
}

export function makeConnectionHealth(over: Partial<ConnectionHealth> = {}): ConnectionHealth {
  return {
    last_activity_at: "2026-07-01T11:59:00Z",
    last_check_at: "2026-07-01T11:59:30Z",
    last_status: "ok",
    last_latency_ms: 42,
    last_error: null,
    ...over,
  };
}

export function makeConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: 1,
    base_url: "https://op.example.com",
    label: null,
    default_project_op_id: 100,
    is_current: true,
    enabled: true,
    has_token: true,
    created_at: "2026-06-01T00:00:00Z",
    health: makeConnectionHealth(),
    ...over,
  };
}

export function makeAddConnectionResponse(
  over: Partial<AddConnectionResponse> = {},
): AddConnectionResponse {
  return {
    ...makeConnection(),
    user: { op_id: 5, name: "Head of Dev", login: "hod" },
    ...over,
  };
}

export function makeHealth(
  over: Partial<ConnectionsHealthResponse> = {},
): ConnectionsHealthResponse {
  return {
    aggregate: "green",
    connections: [makeConnection()],
    ...over,
  };
}

export function makeVaultStatus(over: Partial<VaultStatusResponse> = {}): VaultStatusResponse {
  return { initialized: true, locked: false, ...over };
}

/** Increment 19 (SPEC_19 §2b/§2c): `cancel_requested` + the `"aborted"`
 * status value are now part of every SyncRun. */
export function makeSyncRun(over: Partial<SyncRun> = {}): SyncRun {
  return {
    id: 1,
    started_at: "2026-07-01T12:00:00Z",
    finished_at: null,
    kind: "full",
    wp_count: 0,
    total_count: null,
    status: "running",
    error: null,
    cancel_requested: false,
    last_progress_at: null,
    ...over,
  };
}

export function makeSyncStatus(over: Partial<SyncStatusResponse> = {}): SyncStatusResponse {
  return { current: null, last: null, last_synced_at: null, current_elapsed_ms: null, ...over };
}

export function makeBurndown(over: Partial<BurndownResponse> = {}): BurndownResponse {
  return {
    sprint_id: 1,
    start_date: "2026-06-01",
    end_date: "2026-06-03",
    total_planned_hours: 20,
    points: [
      // Increment 12 (SPEC_12 §1/§5): every point now carries a source ("live"
      // here — the pre-Increment-12 default; a rebuild/replay response would
      // use "reconstructed" instead, see RebuildBurndownResponse).
      { date: "2026-06-01", ideal_hours: 20, remaining_hours: 20, logged_hours: 0, done_count: 0, total_count: 4, source: "live" },
      { date: "2026-06-02", ideal_hours: 10, remaining_hours: 12, logged_hours: 8, done_count: 1, total_count: 4, source: "live" },
      { date: "2026-06-03", ideal_hours: 0, remaining_hours: 5, logged_hours: 15, done_count: 3, total_count: 4, source: "live" },
    ],
    ...over,
  };
}

export function makeVelocity(over: Partial<VelocityResponse> = {}): VelocityResponse {
  return {
    history: [
      // by_connection (SPEC_11 §9): per-server split of completed_hours, empty
      // by default (single/unknown-source sprint) — tests override explicitly.
      { sprint_id: 2, name: "Sprint 2", end_date: "2026-05-30", planned_hours: 40, completed_hours: 32, by_connection: [] },
      { sprint_id: 1, name: "Sprint 1", end_date: "2026-05-16", planned_hours: 40, completed_hours: 28, by_connection: [] },
    ],
    window: 2,
    average_completed_hours: 30,
    recommended_capacity_hours: 30,
    ...over,
  };
}

export function makeSprintUpdateRun(over: Partial<SprintUpdateRun> = {}): SprintUpdateRun {
  return {
    id: 1,
    sprint_id: 1,
    kind: "update",
    triggered_by: "manual",
    started_at: "2026-07-01T09:00:00Z",
    finished_at: "2026-07-01T09:00:05Z",
    wp_count: 5,
    total_count: 5,
    changes_count: 0,
    status: "success",
    error: null,
    ...over,
  };
}

export function makeChangelogEntry(over: Partial<ChangelogEntryView> = {}): ChangelogEntryView {
  return {
    id: 1,
    sprint_id: 1,
    wp_op_id: 1,
    update_run_id: 1,
    occurred_at: "2026-07-01T09:00:00Z",
    actor_op_id: 5,
    actor_name: "Dev Dvořák",
    kind: "status_changed",
    detail: { kind: "status_changed", from: "New", to: "In progress" },
    source: "journal",
    op_journal_id: 100,
    ...over,
  };
}

/** Increment 12 (SPEC_12 §2/§4): one retro/seed or retro/preview candidate,
 * reconstructed to the sprint's start_date. Defaults to a clean (non-gappy)
 * reconstruction — tests override `reconstructed`/`gaps` explicitly to model
 * a "partially reconstructed" row (SPEC_12 §4/§9 — must be visible). */
export function makeRetroSeedCandidate(over: Partial<RetroSeedCandidate> = {}): RetroSeedCandidate {
  return {
    wp_op_id: 1,
    subject: "Do the thing",
    estimate_at_start_date: 8,
    assignee_at_start_date: "Alice",
    status_at_start_date: "In progress",
    reconstructed: false,
    gaps: [],
    // Increment 13 (SPEC_13 §1): defaults to a clean exact-match resolution
    // (op_user_id 7, mirrors "Alice" elsewhere in this file's fixtures) —
    // tests override explicitly to model `unresolved`/`alias`/no-assignee.
    assignee_op_id_at_start_date: 7,
    assignee_resolution: "exact",
    // Increment 13 (SPEC_13 §2): defaults to "existed at start_date" — tests
    // override explicitly to model a ticket created after the sprint began.
    created_after_start_date: false,
    created_at_op: "2026-05-01T00:00:00Z",
    ...over,
  };
}

/** Increment 13 (REVISED, SPEC_13 §1a/§3): one person GET /sprints/:id/people
 * lists — every retro-reconstructed name, with op_user_id present WHEN known
 * (null is the normal, non-blocking default; tests override to model a
 * linked account). */
export function makeSprintPersonEntry(over: Partial<SprintPersonEntry> = {}): SprintPersonEntry {
  return {
    connection_id: 1,
    name: "Jan Belka",
    op_user_id: null,
    hours: 19,
    ticket_count: 3,
    ...over,
  };
}

export function makeSprintPeopleResponse(
  over: Partial<SprintPersonEntry>[] = [{}],
): SprintPeopleResponse {
  return over.map((o) => makeSprintPersonEntry(o));
}

/** Increment 13 (SPEC_13 §1a/§1b): POST /user-aliases / one row of the alias
 * table — the escape hatch for a duplicate display name or a renamed person,
 * never a precondition (SPEC_13 §1a). Defaults to an op_user_id pairing;
 * tests override to model a merge_into_name (rename) alias instead. */
export function makeUserAlias(over: Partial<UserAliasResponse> = {}): UserAliasResponse {
  return {
    id: 1,
    connection_id: 1,
    journal_name: "Jan Belka",
    op_user_id: 42,
    merge_into_name: null,
    created_at: "2026-07-10T09:00:00Z",
    ...over,
  };
}

/** Increment 13 (SPEC_13 §6): one capacity_edit_audit row. */
export function makeCapacityAuditEntry(over: Partial<CapacityEditAuditEntry> = {}): CapacityEditAuditEntry {
  return {
    id: 1,
    sprint_id: 1,
    edited_at: "2026-07-12T09:00:00Z",
    changes_json: JSON.stringify({ 1: { available_hours: { from: 0, to: 8 } } }),
    ...over,
  };
}

export function makeCapacityAuditResponse(
  over: Partial<CapacityEditAuditEntry>[] = [],
): CapacityAuditResponse {
  return over.map((o) => makeCapacityAuditEntry(o));
}

export function makeRetroSeedResponse(over: Partial<RetroSeedResponse> = {}): RetroSeedResponse {
  return {
    sprint_id: 1,
    candidates: [makeRetroSeedCandidate()],
    ...over,
  };
}

export function makeRetroPreview(over: Partial<RetroPreviewResponse> = {}): RetroPreviewResponse {
  return {
    sprint_id: 1,
    start_date: "2026-06-01",
    items: [makeRetroSeedCandidate()],
    ...over,
  };
}

export function makeClosureReport(over: Partial<ClosureReportResponse> = {}): ClosureReportResponse {
  return {
    sprint_id: 1,
    generated_at: "2026-06-14T18:00:00Z",
    done: [
      { wp_op_id: 1, subject: "Done thing", status_name: "Closed", assignee_name: "Alice", planned_hours: 5, remaining_hours: 0, version_name: "v1" },
    ],
    not_done: [
      { wp_op_id: 2, subject: "Unfinished thing", status_name: "In progress", assignee_name: "Bob", planned_hours: 8, remaining_hours: 6, version_name: "v1" },
    ],
    version_change: [
      { wp_op_id: 2, subject: "Unfinished thing", status_name: "In progress", assignee_name: "Bob", planned_hours: 8, remaining_hours: 6, version_name: "v1" },
    ],
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Increment 14 (SPEC_14 §2/§3/§4) — people/roles, closure statistics, reports
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/people row — defaults to a Developer with no ticket_count. */
export function makePersonSummary(over: Partial<PersonSummary> = {}): PersonSummary {
  return {
    id: 1,
    op_user_id: 7,
    name: "Alice",
    default_hours_per_day: 8,
    role: "developer",
    ticket_count: 3,
    ...over,
  };
}

/** One TicketClosureDetail — defaults to a clean "done" ticket, no anomaly. */
export function makeTicketClosureDetail(over: Partial<TicketClosureDetail> = {}): TicketClosureDetail {
  return {
    wp_op_id: 1,
    subject: "Do the thing",
    status_name: "Closed",
    holder_name: "Alice",
    holder_op_user_id: 7,
    holder_role: "developer",
    bucket: "done",
    ambiguous_reason: null,
    anomaly: null,
    ...over,
  };
}

export function makeDeveloperClosureBreakdown(
  over: Partial<DeveloperClosureBreakdown> = {},
): DeveloperClosureBreakdown {
  return {
    member_id: 1,
    op_user_id: 7,
    name: "Alice",
    planned_hours: 10,
    logged_hours: 9,
    delivered_estimate_hours: 10,
    accuracy_pct: 90,
    overshoot_hours: 0,
    ...over,
  };
}

/** Increment 17 (SPEC_17 §1) — one row of a developer's capacity bar. Defaults
 * to a clean `baseline_worked` (row a) segment: baseline, this developer
 * logged on it, counts to Planned. */
export function makeDeveloperTicketSegment(
  over: Partial<DeveloperTicketSegment> = {},
): DeveloperTicketSegment {
  return {
    wp_op_id: 1,
    subject: "Do the thing",
    kind: "baseline_worked",
    estimate_hours: 10,
    logged_hours: 0,
    counts_to_planned: true,
    planned_delta_hours: 10,
    counts_to_change: false,
    change_delta_hours: 0,
    show_logged_marker: false,
    in_baseline: true,
    reason: null,
    current_holder_name: null,
    current_holder_role: null,
    ...over,
  };
}

/** Increment 15 (SPEC_15 §2/§3) — the new SUPERSET of
 * DeveloperClosureBreakdown: keeps every old field (`delivered_estimate_hours`
 * now the deprecated alias, same value as `delivered_hours`) and adds the
 * corrected `delivered_hours` + `segments`. Defaults model the spec's own
 * "Zbynek Trnka" worked example (SPEC_15/§17 §1/§7): baseline 30h,
 * `baseline_worked` (this developer logged on it, still theirs), logged
 * 46.5h — accuracy ~155%, overshoot +16.5h, bar/DELIVERED never empty.
 * Increment 30 (`CAPACITY_BAR_RULES.md` §5, `INCREMENT_30_CONTRACTS.md` §2):
 * `planned_hours` is now CURRENT SCOPE (Σ `baseline_worked` + `acquired` +
 * `idle` — whatever this developer currently holds), not just the retained
 * baseline; the pre-Increment-30 meaning ("Σ baseline_worked, always >= 0")
 * moved to the new `baseline_hours` field instead, its own labelled figure.
 * The default scenario has no post-activation scope movement (one
 * `baseline_worked` segment, `scope_change_hours: 0`), so `baseline_hours`
 * equals `planned_hours` here — a test exercising Increment 30's divergence
 * overrides both explicitly (see SprintBoardScreen.test.tsx's "Planned
 * reflects current scope" cases). */
export function makeDeveloperCapacityBreakdown(
  over: Partial<DeveloperCapacityBreakdown> = {},
): DeveloperCapacityBreakdown {
  return {
    member_id: 1,
    op_user_id: 7,
    name: "Zbynek Trnka",
    planned_hours: 30,
    baseline_hours: 30,
    logged_hours: 46.5,
    delivered_estimate_hours: 30, // deprecated alias — same value as delivered_hours
    delivered_hours: 30,
    accuracy_pct: 155,
    overshoot_hours: 16.5,
    scope_change_hours: 0,
    segments: [
      makeDeveloperTicketSegment({
        wp_op_id: 1,
        subject: "Delivered ticket",
        kind: "baseline_worked",
        estimate_hours: 30,
        logged_hours: 46.5,
        show_logged_marker: true,
        reason: "developed and handed off to a tester",
        current_holder_name: "Arend Tester",
        current_holder_role: "tester",
      }),
    ],
    ...over,
  };
}

export function makeTicketEstimateLine(over: Partial<TicketEstimateLine> = {}): TicketEstimateLine {
  return {
    wp_op_id: 1,
    subject: "Do the thing",
    bucket: "done",
    // Increment 35 (§2): baseline by default — a test exercising the
    // added-during-sprint badge overrides explicitly.
    origin: "baseline",
    estimate_hours: 10,
    dev_logged_hours: 9,
    total_logged_hours: 9,
    // Increment 34 (§2/§3): single-sprint defaults — cumulative == window,
    // no badge; multi-sprint tests override explicitly.
    cumulative_dev_logged_hours: 9,
    multi_sprint: null,
    delta_hours: -1,
    overshoot_flag: false,
    ...over,
  };
}

/** GET /sprints/:id/closure-stats — defaults to one done ticket, everything
 * else empty, no anomalies. Tests override done/not_done/rejected/ambiguous
 * explicitly to model the SPEC_14 §2 done-matrix scenarios. */
export function makeClosureStats(over: Partial<ClosureStatsResponse> = {}): ClosureStatsResponse {
  return {
    sprint_id: 1,
    generated_at: "2026-06-14T18:00:00Z",
    // Increment 33: the off-sprint block is empty by default; tests exercising
    // the Closure off-sprint section set it explicitly.
    off_sprint: { total_hours: 0, sprint_logged_hours: 0, share_pct: null, per_person: [] },
    // Increment 35 (§2): zeroed scope-origin split by default — the section is
    // gated on it, so pre-existing tests keep seeing it hidden.
    scope_origin: {
      baseline: { ticket_count: 0, estimate_hours: 0, dev_logged_hours: 0 },
      added: { ticket_count: 0, estimate_hours: 0, dev_logged_hours: 0 },
      added_logged_share_pct: null,
      added_estimate_share_pct: null,
    },
    total_planned_hours: 10,
    // Increment 30 — Σ per_developer[].baseline_hours, the aggregate of what
    // total_planned_hours meant before Increment 30. Arbitrary/independent of
    // total_planned_hours by default, same pattern as every other total here
    // — a test exercising the Planned-vs-Baseline distinction sets both explicitly.
    total_baseline_hours: 10,
    // Increment 16 (SPEC_16 §3): Σ per_developer[].delivered_hours — matches
    // the default single per_developer row's delivered_hours (30) below.
    total_delivered_hours: 30,
    total_logged_hours: 9,
    dev_logged_hours: 9,
    done: { count: 1, items: [makeTicketClosureDetail()] },
    not_done: { count: 0, items: [] },
    rejected: { count: 0, items: [] },
    ambiguous: { count: 0, items: [] },
    anomalies: [],
    estimate_accuracy_pct: 90,
    overshoot_hours: 0,
    overshoot_threshold_pct: 25,
    per_developer: [makeDeveloperCapacityBreakdown()],
    per_ticket: [makeTicketEstimateLine()],
    ...over,
  };
}

export function makeClosedSprintSummary(over: Partial<ClosedSprintSummary> = {}): ClosedSprintSummary {
  return {
    sprint_id: 1,
    name: "Sprint 1",
    start_date: "2026-06-01",
    end_date: "2026-06-14",
    closed_at: "2026-06-14T18:00:00Z",
    ...over,
  };
}

export function makeReportsListResponse(
  over: Partial<ClosedSprintSummary>[] = [{}],
): ReportsListResponse {
  return over.map((o) => makeClosedSprintSummary(o));
}

export function makeReportDetail(over: Partial<ReportDetailResponse> = {}): ReportDetailResponse {
  return {
    sprint: makeClosedSprintSummary(),
    stats: makeClosureStats(),
    burndown: makeBurndown(),
    ...over,
  };
}

/** Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3) — GET/PUT /api/config. */
export function makeAppConfig(over: Partial<AppConfigResponse> = {}): AppConfigResponse {
  return {
    overshoot_threshold_pct: 25,
    freeze_grace_days: 3,
    ...over,
  };
}

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §4) — GET
 * /sprints/:id/off-sprint-time. Defaults to "never fetched, no rows" (the
 * quietest possible state); a test exercising the section overrides
 * `per_person`/`fetched_at` explicitly.
 */
export function makeOffSprintTimeResponse(
  over: Partial<OffSprintTimeResponse> = {},
): OffSprintTimeResponse {
  return {
    window: { from: "2026-06-01", to: "2026-06-14" },
    fetched_at: null,
    total_hours: 0,
    per_person: [],
    ...over,
  };
}

export function makeOffSprintTimePerson(
  over: Partial<OffSprintTimeResponse["per_person"][number]> = {},
): OffSprintTimeResponse["per_person"][number] {
  return {
    op_user_id: 9,
    name: "Carol",
    total_hours: 4,
    tickets: [{ wp_op_id: 555, subject: "Unplanned hotfix", hours: 4, connection_id: 1 }],
    ...over,
  };
}

/**
 * Increment 33 (docs/INCREMENT_33_CONTRACTS.md §1/§4) — the
 * `ClosureStatsResponse.off_sprint` block Closure/Reports render. Distinct
 * from `makeOffSprintTimeResponse` above (Increment 32's SprintBoardScreen
 * shape — no `share_pct`/`sprint_logged_hours`, different endpoint
 * entirely). Defaults to empty/zero so a test not exercising this section
 * gets the "renders nothing" state for free; a test exercising it overrides
 * `total_hours`/`sprint_logged_hours`/`share_pct`/`per_person` explicitly.
 */
export function makeClosureOffSprint(
  over: Partial<ClosureStatsResponse["off_sprint"]> = {},
): ClosureStatsResponse["off_sprint"] {
  return {
    total_hours: 0,
    sprint_logged_hours: 0,
    share_pct: null,
    per_person: [],
    ...over,
  };
}

/**
 * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §4) — the
 * `ClosureStatsResponse.scope_origin` block Closure/Reports render as the
 * "Scope origin" section. Defaults to empty/zero (mirrors `makeClosureStats`'
 * own default), so a test not exercising this section gets the "hidden"
 * state for free; a test exercising it overrides `baseline`/`added`/the two
 * share percentages explicitly.
 */
export function makeScopeOrigin(
  over: Partial<ClosureStatsResponse["scope_origin"]> = {},
): ClosureStatsResponse["scope_origin"] {
  return {
    baseline: { ticket_count: 0, estimate_hours: 0, dev_logged_hours: 0 },
    added: { ticket_count: 0, estimate_hours: 0, dev_logged_hours: 0 },
    added_logged_share_pct: null,
    added_estimate_share_pct: null,
    ...over,
  };
}

export function makeClosureOffSprintPerson(
  over: Partial<ClosureStatsResponse["off_sprint"]["per_person"][number]> = {},
): ClosureStatsResponse["off_sprint"]["per_person"][number] {
  return {
    op_user_id: 9,
    name: "Carol",
    total_hours: 4,
    share_pct: 40,
    tickets: [{ wp_op_id: 555, subject: "Unplanned hotfix", hours: 4, connection_id: 1 }],
    ...over,
  };
}

/** Increment 39: GET /api/auth/me — defaults to `none` mode, i.e. the synthetic local Planner. */
export function makeMe(over: Partial<import("@osp/contracts").AuthMeResponse> = {}): import("@osp/contracts").AuthMeResponse {
  return {
    mode: "none",
    user: { name: "Local user", email: null, roles: ["Planner"] },
    role: "Planner",
    ...over,
  };
}
