import type {
  BurndownSnapshot,
  CapacityEditAuditEntry,
  DoneRule,
  DoneStatusRule,
  EstimateOverride,
  ReportConfig,
  ImportSelection,
  OpConnection,
  Project,
  RemainingStatusRule,
  Sprint,
  SprintClosureReport,
  SprintItem,
  SprintItemOutcome,
  SprintMemberCapacity,
  SprintStatus,
  SprintUpdateRun,
  SyncKind,
  SyncRun,
  SyncStatus,
  TeamMember,
  TicketBaseline,
  TicketChangelogEntry,
  UserNameAlias,
  VaultMeta,
  WorkPackageCache,
} from "@osp/contracts";
import type { FrozenSprintItemSnapshot, OffSprintTimeEntry } from "./repositories";
import type {
  burndownSnapshot,
  capacityEditAudit,
  doneRule,
  doneStatusRule,
  estimateOverride,
  reportConfig,
  importSelection,
  offSprintTimeEntry,
  opConnection,
  project,
  remainingStatusRule,
  sprint,
  sprintClosureReport,
  sprintItem,
  sprintMemberCapacity,
  sprintUpdateRun,
  syncRun,
  teamMember,
  ticketBaseline,
  ticketChangelogEntry,
  userNameAlias,
  vaultMeta,
  workPackageCache,
} from "./schema";

/**
 * Row → contract entity mappers. Drizzle rows use camelCase property names
 * mapped to the snake_case SQL columns; the contract entities are snake_case,
 * so every read crosses this boundary and no Drizzle row leaks out (SPEC §4).
 */

type ConnectionRow = typeof opConnection.$inferSelect;
type VaultMetaRow = typeof vaultMeta.$inferSelect;
type ProjectRow = typeof project.$inferSelect;
type ImportSelectionRow = typeof importSelection.$inferSelect;
type WorkPackageRow = typeof workPackageCache.$inferSelect;
type EstimateOverrideRow = typeof estimateOverride.$inferSelect;
type SprintRow = typeof sprint.$inferSelect;
type SprintItemRow = typeof sprintItem.$inferSelect;
type TeamMemberRow = typeof teamMember.$inferSelect;
type CapacityRow = typeof sprintMemberCapacity.$inferSelect;
type DoneStatusRuleRow = typeof doneStatusRule.$inferSelect;
type DoneRuleRow = typeof doneRule.$inferSelect;
type ReportConfigRow = typeof reportConfig.$inferSelect;
type RemainingStatusRuleRow = typeof remainingStatusRule.$inferSelect;
type SyncRunRow = typeof syncRun.$inferSelect;
type TicketBaselineRow = typeof ticketBaseline.$inferSelect;
type SprintUpdateRunRow = typeof sprintUpdateRun.$inferSelect;
type ChangelogEntryRow = typeof ticketChangelogEntry.$inferSelect;
type BurndownRow = typeof burndownSnapshot.$inferSelect;
type ClosureRow = typeof sprintClosureReport.$inferSelect;
type UserNameAliasRow = typeof userNameAlias.$inferSelect;
type CapacityEditAuditRow = typeof capacityEditAudit.$inferSelect;
type OffSprintTimeEntryRow = typeof offSprintTimeEntry.$inferSelect;

export function mapConnection(r: ConnectionRow): OpConnection {
  return {
    id: r.id,
    base_url: r.baseUrl,
    label: r.label,
    token_encrypted: r.tokenEncrypted,
    token_ct: r.tokenCt,
    token_nonce: r.tokenNonce,
    token_tag: r.tokenTag,
    default_project_op_id: r.defaultProjectOpId,
    is_current: r.isCurrent,
    enabled: r.enabled,
    created_at: r.createdAt,
    last_activity_at: r.lastActivityAt,
    last_check_at: r.lastCheckAt,
    last_status: r.lastStatus as OpConnection["last_status"],
    last_latency_ms: r.lastLatencyMs,
    last_error: r.lastError,
  };
}

export function mapVaultMeta(r: VaultMetaRow): VaultMeta {
  return {
    id: 1,
    kdf_algo: r.kdfAlgo as VaultMeta["kdf_algo"],
    kdf_salt: r.kdfSalt,
    kdf_params_json: r.kdfParamsJson,
    verifier_ct: r.verifierCt,
    verifier_nonce: r.verifierNonce,
    created_at: r.createdAt,
  };
}

export function mapProject(r: ProjectRow): Project {
  return {
    id: r.id,
    connection_id: r.connectionId,
    op_id: r.opId,
    identifier: r.identifier,
    name: r.name,
    last_synced_at: r.lastSyncedAt,
  };
}

export function mapImportSelection(r: ImportSelectionRow): ImportSelection {
  return {
    id: r.id,
    connection_id: r.connectionId,
    project_op_id: r.projectOpId,
    project_name: r.projectName,
    version_op_id: r.versionOpId,
    version_name: r.versionName,
    created_at: r.createdAt,
  };
}

export function mapWorkPackage(r: WorkPackageRow): WorkPackageCache {
  return {
    id: r.id,
    connection_id: r.connectionId,
    op_id: r.opId,
    project_op_id: r.projectOpId,
    project_name: r.projectName,
    subject: r.subject,
    type_name: r.typeName,
    status_name: r.statusName,
    status_is_closed: r.statusIsClosed,
    assignee_op_id: r.assigneeOpId,
    assignee_name: r.assigneeName,
    estimated_hours: r.estimatedHours,
    remaining_hours: r.remainingHours,
    spent_hours: r.spentHours,
    story_points: r.storyPoints,
    version_op_id: r.versionOpId,
    version_name: r.versionName,
    priority: r.priority,
    parent_op_id: r.parentOpId,
    percentage_done: r.percentageDone,
    updated_at_op: r.updatedAtOp,
    raw_json: r.rawJson,
    cached_at: r.cachedAt,
  };
}

export function mapEstimateOverride(r: EstimateOverrideRow): EstimateOverride {
  return {
    id: r.id,
    wp_op_id: r.wpOpId,
    planning_hours: r.planningHours,
    note: r.note,
    updated_at: r.updatedAt,
  };
}

export function mapSprint(r: SprintRow): Sprint {
  return {
    id: r.id,
    name: r.name,
    start_date: r.startDate,
    end_date: r.endDate,
    status: r.status as SprintStatus,
    capacity_mode: r.capacityMode as Sprint["capacity_mode"],
    completed_hours: r.completedHours,
    created_at: r.createdAt,
    closed_at: r.closedAt,
    activated_at: r.activatedAt,
    locked_at: r.lockedAt,
    is_locked: r.isLocked,
    lock_reason: r.lockReason as Sprint["lock_reason"],
    baseline_total_hours: r.baselineTotalHours,
    is_retrospective: r.isRetrospective,
    retro_seed_kind: r.retroSeedKind as Sprint["retro_seed_kind"],
    retro_seed_value: r.retroSeedValue,
    retro_replayed_at: r.retroReplayedAt,
    frozen_at: r.frozenAt,
  };
}

export function mapTicketBaseline(r: TicketBaselineRow): TicketBaseline {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    wp_op_id: r.wpOpId,
    captured_at: r.capturedAt,
    subject: r.subject,
    status_name: r.statusName,
    status_is_closed: r.statusIsClosed,
    assignee_op_id: r.assigneeOpId,
    accountable_op_id: r.accountableOpId,
    original_assignee_op_id: r.originalAssigneeOpId,
    estimated_hours: r.estimatedHours,
    remaining_hours: r.remainingHours,
    spent_hours: r.spentHours,
    version_op_id: r.versionOpId,
    raw_json: r.rawJson,
    origin: r.origin as TicketBaseline["origin"],
    reconstructed: r.reconstructed,
    reconstruction_gaps_json: r.reconstructionGapsJson,
    assignee_name_raw: r.assigneeNameRaw,
  };
}

export function mapUserNameAlias(r: UserNameAliasRow): UserNameAlias {
  return {
    id: r.id,
    connection_id: r.connectionId,
    journal_name: r.journalName,
    op_user_id: r.opUserId,
    // SPEC_13 §1b (revised): the "renamed person" escape hatch — fold this
    // journal_name's hours under another current display name.
    merge_into_name: r.mergeIntoName,
    created_at: r.createdAt,
  };
}

export function mapCapacityEditAudit(r: CapacityEditAuditRow): CapacityEditAuditEntry {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    edited_at: r.editedAt,
    changes_json: r.changesJson,
  };
}

export function mapSprintUpdateRun(r: SprintUpdateRunRow): SprintUpdateRun {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    kind: r.kind as SprintUpdateRun["kind"],
    triggered_by: r.triggeredBy as SprintUpdateRun["triggered_by"],
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    wp_count: r.wpCount,
    total_count: r.totalCount,
    changes_count: r.changesCount,
    status: r.status as SyncStatus,
    error: r.error,
  };
}

export function mapChangelogEntry(r: ChangelogEntryRow): TicketChangelogEntry {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    wp_op_id: r.wpOpId,
    update_run_id: r.updateRunId,
    occurred_at: r.occurredAt,
    actor_op_id: r.actorOpId,
    actor_name: r.actorName,
    kind: r.kind as TicketChangelogEntry["kind"],
    detail_json: r.detailJson,
    source: r.source as TicketChangelogEntry["source"],
    op_journal_id: r.opJournalId,
  };
}

export function mapSprintItem(r: SprintItemRow): SprintItem {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    wp_op_id: r.wpOpId,
    added_at: r.addedAt,
    planned_hours: r.plannedHours,
    outcome: r.outcome as SprintItemOutcome,
    removed_at: r.removedAt,
    origin: r.origin as SprintItem["origin"],
    retro_source: (r.retroSource as SprintItem["retro_source"]) ?? null,
  };
}

export function mapTeamMember(r: TeamMemberRow): TeamMember {
  return {
    id: r.id,
    op_user_id: r.opUserId,
    name: r.name,
    default_hours_per_day: r.defaultHoursPerDay,
    role: r.role as TeamMember["role"],
  };
}

export function mapCapacity(r: CapacityRow): SprintMemberCapacity {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    member_id: r.memberId,
    available_hours: r.availableHours,
    pto_days: r.ptoDays,
  };
}

export function mapDoneStatusRule(r: DoneStatusRuleRow): DoneStatusRule {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    status_name: r.statusName,
    counts_as: r.countsAs as DoneStatusRule["counts_as"],
  };
}

export function mapRemainingStatusRule(r: RemainingStatusRuleRow): RemainingStatusRule {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    status_name: r.statusName,
  };
}

export function mapDoneRule(r: DoneRuleRow): DoneRule {
  return {
    id: r.id,
    status_name: r.statusName,
    kind: r.kind as DoneRule["kind"],
  };
}

export function mapReportConfig(r: ReportConfigRow): ReportConfig {
  return {
    id: r.id,
    overshoot_threshold_pct: r.overshootThresholdPct,
    freeze_grace_days: r.freezeGraceDays,
  };
}

/** Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — row → contract shape for
 * `SprintItemRepository.listFrozenSnapshot`/`writeFreezeSnapshot`. Not a
 * "mapper" in the `mapX(Row): Entity` sense above (there is no contract
 * entity for this shape — see the doc comment on `FrozenSprintItemSnapshot`
 * in repositories.ts), kept here anyway so every row→JS-shape translation for
 * `sprint_item` lives in one file. */
export function mapFrozenSprintItemSnapshot(r: SprintItemRow): FrozenSprintItemSnapshot {
  return {
    item_id: r.id,
    wp_op_id: r.wpOpId,
    frozen_effective_hours: r.frozenEffectiveHours,
    frozen_assignee_op_id: r.frozenAssigneeOpId,
    frozen_assignee_name: r.frozenAssigneeName,
    frozen_status_name: r.frozenStatusName,
    frozen_status_is_closed: r.frozenStatusIsClosed,
    frozen_parent_op_id: r.frozenParentOpId,
    frozen_connection_id: r.frozenConnectionId,
    frozen_project_op_id: r.frozenProjectOpId,
    frozen_remaining_hours: r.frozenRemainingHours,
    frozen_project_name: r.frozenProjectName,
    frozen_project_identifier: r.frozenProjectIdentifier,
  };
}

export function mapSyncRun(r: SyncRunRow): SyncRun {
  return {
    id: r.id,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    kind: r.kind as SyncKind,
    wp_count: r.wpCount,
    total_count: r.totalCount,
    status: r.status as SyncStatus,
    error: r.error,
    cancel_requested: r.cancelRequested,
    last_progress_at: r.lastProgressAt,
  };
}

export function mapBurndown(r: BurndownRow): BurndownSnapshot {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    snapshot_date: r.snapshotDate,
    remaining_hours: r.remainingHours,
    logged_hours: r.loggedHours,
    ideal_hours: r.idealHours,
    done_count: r.doneCount,
    total_count: r.totalCount,
    source: r.source as BurndownSnapshot["source"],
  };
}

export function mapClosureReport(r: ClosureRow): SprintClosureReport {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    generated_at: r.generatedAt,
    done_json: r.doneJson,
    not_done_json: r.notDoneJson,
    version_change_json: r.versionChangeJson,
  };
}

/** Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2) — row → shape for
 * `OffSprintTimeRepository`. Not a `mapX(Row): Entity` in the @osp/contracts
 * sense (there is no contract entity for this row — see the doc comment on
 * `OffSprintTimeEntry` in repositories.ts, same precedent as
 * `mapFrozenSprintItemSnapshot` above). */
export function mapOffSprintTimeEntry(r: OffSprintTimeEntryRow): OffSprintTimeEntry {
  return {
    id: r.id,
    sprint_id: r.sprintId,
    connection_id: r.connectionId,
    op_time_entry_id: r.opTimeEntryId,
    wp_op_id: r.wpOpId,
    wp_subject: r.wpSubject,
    actor_op_id: r.actorOpId,
    actor_name: r.actorName,
    spent_on: r.spentOn,
    hours: r.hours,
    fetched_at: r.fetchedAt,
  };
}
