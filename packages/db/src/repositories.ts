import type {
  BurndownSnapshot,
  CapacityEditAuditEntry,
  DoneRule,
  DoneStatusRule,
  EstimateOverride,
  ImportSelection,
  LockReason,
  OpConnection,
  OpId,
  Project,
  RemainingStatusRule,
  ReportConfig,
  Sprint,
  SprintClosureReport,
  SprintItem,
  SprintItemOutcome,
  SprintMemberCapacity,
  SprintUpdateRun,
  SyncKind,
  SyncRun,
  SyncStatus,
  TeamMember,
  TicketBaseline,
  TicketChangelogEntry,
  UpdateRunKind,
  UpdateRunTriggeredBy,
  UserNameAlias,
  VaultMeta,
  WorkPackageCache,
} from "@osp/contracts";

/**
 * Repository INTERFACES for each aggregate the backend needs.
 * The implementations live in repos.ts, against Drizzle + PostgreSQL
 * (node-postgres in the app, PGlite in tests — Increment 27).
 * Only contract-derived types cross this boundary — no Drizzle rows leak out.
 */

// Insert shapes: entity minus the auto-managed columns.
/** New connection: token comes ONLY as an encrypted blob (never plaintext). */
export type NewConnection = {
  base_url: string;
  label: string | null;
  token_ct: string | null;
  token_nonce: string | null;
  token_tag: string | null;
  default_project_op_id: OpId | null;
};
// connection_id is OPTIONAL on insert (packages/sync builds these without any
// connection context — it only ever sees a pre-built OpClient) but always
// present (nullable) on read; omitting it inserts NULL ("unknown/legacy").
// Callers that DO know the connection (apps/api's routes) always pass it.
export type NewProject = Omit<Project, "id" | "connection_id"> & {
  connection_id?: number | null;
};
export type NewImportSelection = Omit<ImportSelection, "id" | "created_at" | "connection_id"> & {
  connection_id?: number | null;
};
export type NewWorkPackageCache = Omit<WorkPackageCache, "id" | "cached_at" | "connection_id"> & {
  connection_id?: number | null;
};
export type NewEstimateOverride = Omit<EstimateOverride, "id" | "updated_at">;
export type NewSprint = Omit<
  Sprint,
  | "id"
  | "created_at"
  | "closed_at"
  | "completed_hours"
  // Increment 4 lifecycle columns: written only by activate()/close(), never at create().
  | "activated_at"
  | "locked_at"
  | "is_locked"
  | "lock_reason"
  // Increment 5: frozen only by activate(), never at create().
  | "baseline_total_hours"
  // Increment 12: is_retrospective is toggled via update() while planning;
  // retro_seed_* are written by the retro/seed route; retro_replayed_at by the
  // retro activation replay. None are settable at create() (schema defaults:
  // is_retrospective=false, the rest null) — same precedent as the lifecycle
  // columns above (see SprintRepository.update's extended patch type).
  | "is_retrospective"
  | "retro_seed_kind"
  | "retro_seed_value"
  | "retro_replayed_at"
  // Increment 31: written only by SprintRepository.setFrozen() (never at
  // create()) and cleared by reactivate() — same precedent as the lifecycle
  // columns above.
  | "frozen_at"
>;
/** Increment 12: the retrospective-planning columns settable via update() but
 * never via create() (excluded from NewSprint above). */
export type SprintRetroPatch = Partial<
  Pick<Sprint, "is_retrospective" | "retro_seed_kind" | "retro_seed_value" | "retro_replayed_at">
>;
export type NewTicketBaseline = Omit<TicketBaseline, "id">;
export type NewSprintUpdateRun = Omit<
  SprintUpdateRun,
  "id" | "started_at" | "finished_at" | "wp_count" | "changes_count" | "status" | "error"
>;
export type NewChangelogEntry = Omit<TicketChangelogEntry, "id"> & {
  /**
   * Idempotence key (SPEC_04 §8): journal-sourced = `journal:<op_journal_id>`,
   * time-entry-sourced = `time_entry:<op_time_entry_id>`, diff-sourced (rare
   * fallback) = a caller-synthesized key. UNIQUE — insertMany silently skips
   * rows whose key already exists so a re-run without OP changes adds nothing.
   */
  dedup_key: string;
};
export type NewSprintItem = Omit<
  SprintItem,
  "id" | "added_at" | "removed_at" | "retro_source"
> & {
  /** Increment 25 (SPEC_25 §4): caller-supplied BACKDATED timestamp for a
   * retroactive add. Omitted/undefined falls back to `nowIso()` exactly like
   * every pre-Increment-25 caller (baseline/added_mid_sprint are still dated
   * to the moment they were clicked). */
  added_at?: string;
  /** Set only alongside `origin: "added_retroactively"`; omitted/undefined
   * persists as null (every non-retroactive add). */
  retro_source?: SprintItem["retro_source"];
};

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — the freeze-time snapshot
 * columns on `sprint_item`. Deliberately kept OUT of the `SprintItem` contract
 * entity (@osp/contracts) — they are a backend-internal input to the three
 * read surfaces §2c names (computeClosureStats / buildCapacityResponse /
 * buildSprintItemsDetailed), never serialized to the frontend directly. Kept
 * as a SEPARATE repository method (`listFrozenSnapshot`, below) rather than
 * added to `SprintItemRepository.listBySprint`'s return shape, so every
 * existing exact-shape caller/test of listBySprint/getBySprintAndWp/
 * findByWpOpIds is untouched by this increment.
 */
export interface FrozenSprintItemFields {
  frozen_effective_hours: number | null;
  frozen_assignee_op_id: OpId | null;
  frozen_assignee_name: string | null;
  frozen_status_name: string | null;
  frozen_status_is_closed: boolean | null;
  frozen_parent_op_id: OpId | null;
  frozen_connection_id: number | null;
  /** AMENDMENT (§5.5 golden test): SprintItemDetail.project_op_id has no
   * baseline fallback, so the snapshot carries the project id too. */
  frozen_project_op_id: OpId | null;
  /** Increment 34 (docs/INCREMENT_34_CONTRACTS.md §4) — the live REMAINING
   * hours at freeze time (`?? baseline remaining`), distinct from
   * `frozen_effective_hours` (the resolved bar-length estimate). Feeds §1's
   * `remEnd` for a frozen sprint. */
  frozen_remaining_hours: number | null;
  /** Increment 40 (INCREMENT_40_CONTRACTS §1.3) — project display name and
   * identifier AT FREEZE TIME (display-only; `frozen_project_op_id` stays the
   * identity). Null when unresolvable — renders `—`. */
  frozen_project_name: string | null;
  frozen_project_identifier: string | null;
}

/** One row of a written/read freeze snapshot — the sprint_item id plus its
 * wp_op_id (so read callers can key a lookup map the same way every other
 * per-ticket structure in closureStats.ts/capacity.ts already is) plus the
 * frozen fields themselves. */
export type FrozenSprintItemSnapshot = FrozenSprintItemFields & {
  item_id: number;
  wp_op_id: OpId;
};
/** Increment 14 (SPEC_14 §2): `role` is NOT settable via upsert (that would
 * let an ordinary capacity/provisioning call silently clobber a role a human
 * already set) — omitted on insert, the DB default ('unset') applies; a
 * pre-existing member's role is untouched by upsert's UPDATE path. The only
 * way to change it is TeamMemberRepository.setRole (PUT /api/people/:id/role). */
export type NewTeamMember = Omit<TeamMember, "id" | "role">;
export type NewSprintMemberCapacity = Omit<SprintMemberCapacity, "id">;
export type NewDoneStatusRule = Omit<DoneStatusRule, "id">;
export type NewRemainingStatusRule = Omit<RemainingStatusRule, "id">;
export type NewSyncRun = Omit<SyncRun, "id" | "started_at" | "finished_at">;
export type NewBurndownSnapshot = Omit<BurndownSnapshot, "id">;
export type NewClosureReport = Omit<SprintClosureReport, "id" | "generated_at">;
/** Increment 13 (SPEC_13 §1a/§1b, revised): a journal-name alias (created_at is
 * server-defaulted). Both `op_user_id` (pin to an OP account) and
 * `merge_into_name` (fold under a renamed person) are OPTIONAL — the escape
 * hatch supplies one or the other; an omitted field persists as null. */
export type NewUserNameAlias = Omit<
  UserNameAlias,
  "id" | "created_at" | "op_user_id" | "merge_into_name"
> & {
  op_user_id?: number | null;
  merge_into_name?: string | null;
};
/** Increment 13 (SPEC_13 §6): a capacity edit made on a retro sprint after it
 * left planning (edited_at is server-defaulted). */
export type NewCapacityEditAudit = Omit<CapacityEditAuditEntry, "id" | "edited_at">;

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2) — one OP time-entry logged
 * OUTSIDE a sprint's own tickets, by a roster developer, within the sprint's
 * calendar window. Deliberately kept OUT of the `@osp/contracts` entity set
 * (same precedent as `FrozenSprintItemFields` above): this is a backend-
 * internal replace-on-refresh CACHE row, never serialized directly — the only
 * public shape is the aggregated `OffSprintTimeResponse` (packages/contracts
 * api.ts), built by the route from `listBySprint`.
 */
export interface OffSprintTimeEntry {
  id: number;
  sprint_id: number;
  connection_id: number | null;
  op_time_entry_id: number;
  wp_op_id: OpId;
  wp_subject: string | null;
  actor_op_id: OpId;
  actor_name: string | null;
  /** 'YYYY-MM-DD', matching sprint.start_date/end_date's mode. */
  spent_on: string;
  hours: number;
  fetched_at: string;
}
export type NewOffSprintTimeEntry = Omit<OffSprintTimeEntry, "id">;

/** Encrypted-token triple (base64), as produced by @osp/crypto. */
export interface TokenBlob {
  ct: string;
  nonce: string;
  tag: string;
}

/** Patch for the health columns; only the given fields are written. */
export interface ConnectionHealthPatch {
  last_activity_at?: string | null;
  last_check_at?: string | null;
  last_status?: OpConnection["last_status"];
  last_latency_ms?: number | null;
  last_error?: string | null;
}

export interface ConnectionRepository {
  /** The connection OP-facing operations target: is_current, else newest. */
  getCurrent(): Promise<OpConnection | null>;
  getById(id: number): Promise<OpConnection | null>;
  getByBaseUrl(baseUrl: string): Promise<OpConnection | null>;
  list(): Promise<OpConnection[]>;
  /** Insert; throws on duplicate base_url (UNIQUE). Auto-current when first. */
  create(input: NewConnection): Promise<OpConnection>;
  update(
    id: number,
    patch: Partial<Omit<NewConnection, "base_url">>,
  ): Promise<OpConnection>;
  /** Delete a connection; re-points is_current to the newest remaining row. */
  delete(id: number): Promise<boolean>;
  /** Make this row the current one (clears the flag on every other row). */
  setCurrent(id: number): Promise<void>;
  /** Disconnect/Connect toggle (independent of is_current). */
  setEnabled(id: number, enabled: boolean): Promise<void>;
  updateHealth(id: number, patch: ConnectionHealthPatch): Promise<void>;
  /** Rows still carrying a legacy plaintext token (pre-vault schema). */
  listLegacyPlaintext(): Promise<OpConnection[]>;
  /** Store the encrypted token and clear the legacy plaintext slot. */
  setEncryptedToken(id: number, blob: TokenBlob): Promise<void>;
  /** Vault reset: drop all token material (base_url/label survive). Returns count. */
  clearAllTokens(): Promise<number>;
}

export interface VaultMetaRepository {
  get(): Promise<VaultMeta | null>;
  /** Create or replace the singleton row (id = 1). */
  save(meta: Omit<VaultMeta, "id" | "created_at">): Promise<VaultMeta>;
  /** Vault reset: delete the singleton (vault becomes uninitialized). */
  delete(): Promise<void>;
}

/** Increment 40 — one `(connection_id, op_id)` project key. `connection_id`
 * null addresses the legacy connection-less rows (`none:<id>`) only. */
export interface ProjectKeyPair {
  connection_id: number | null;
  op_id: OpId;
}

export interface ProjectRepository {
  list(): Promise<Project[]>;
  /** ⚠️ COLLISION-UNSAFE legacy lookup — op_id is unique only WITHIN a
   * connection, so this picks an arbitrary match when two servers share a
   * numeric project id. Kept ONLY for callers that genuinely have no
   * connection; everything else uses getByConnectionAndOpId(s)
   * (INCREMENT_40_CONTRACTS §0 pillar 2). */
  getByOpId(opId: OpId): Promise<Project | null>;
  getByConnectionAndOpId(connectionId: number, opId: OpId): Promise<Project | null>;
  /** Increment 40 — batch exact-key lookup. Returns only rows that exist
   * (order by id, NOT by input); a null `connection_id` matches only rows
   * whose connection_id IS NULL. Empty input → []. */
  getByConnectionAndOpIds(pairs: ReadonlyArray<ProjectKeyPair>): Promise<Project[]>;
  upsertMany(rows: NewProject[]): Promise<void>;
  /** Increment 40 — connection-scoped: stamps only the `(connectionId, opId)`
   * row (null → the legacy connection-less row). A missing row is a no-op. */
  setLastSyncedAt(connectionId: number | null, opId: OpId, at: string): Promise<void>;
}

export interface ImportSelectionRepository {
  list(): Promise<ImportSelection[]>;
  getById(id: number): Promise<ImportSelection | null>;
  /** Record a selection; de-duplicates on (connection_id, project_op_id, version_op_id). */
  upsert(sel: NewImportSelection): Promise<ImportSelection>;
  delete(id: number): Promise<boolean>;
}

export interface BacklogDismissalRepository {
  /** WP op ids the user removed from the backlog view (local-only). */
  listOpIds(): Promise<number[]>;
  /** Hide these WP op ids from the backlog (idempotent). */
  add(opIds: number[]): Promise<void>;
  /** Un-hide these WP op ids (e.g. when re-added by id). */
  remove(opIds: number[]): Promise<void>;
}

export interface WorkPackageCacheFilter {
  /** Omit to search across ALL cached projects (additive multi-project backlog). */
  projectOpId?: OpId;
  /** Increment 19 (SPEC_19 §1.2): matched case-insensitively/trimmed, same
   * convention as HIDDEN_BACKLOG_STATUSES/DEFAULT_DONE_RULES elsewhere — a
   * real OP instance's status naming can drift in casing across
   * projects/versions, and an exact match silently returning zero rows is
   * exactly the reported bug. */
  statusName?: string;
  assigneeOpId?: OpId;
  versionOpId?: OpId;
  /**
   * Increment 23 (SPEC_23 §2) — scope the match to ONE source connection, so
   * an `assigneeOpId`/`versionOpId` (a per-server OP id that COLLIDES across
   * servers — Alan Turing@mock and Cameron Dalby@Acme are both OP user
   * id 3) matches only the intended connection's rows, not every server's.
   * `undefined` → no connection constraint (legacy bare-id behaviour);
   * `null` → `connection_id IS NULL` (legacy connection-less rows, the
   * `none:` key); a number → `connection_id = <that connection>`. Expressed
   * as an AND in SQL alongside the id filters rather than a broad-fetch +
   * JS post-filter (SPEC_23 §2.3). */
  connectionId?: number | null;
  /** Increment 19 (SPEC_19 §1) — was missing; same case-insensitive/trimmed
   * matching as statusName. */
  priority?: string;
  hasEstimate?: boolean;
}

/**
 * Increment 29 (SPEC_29 §2, `docs/INCREMENT_29_CONTRACTS.md` §3) — the
 * incremental-sync watermark, keyed **per (connection, project)**.
 *
 * Why this exists at all: `sync()` used to derive its incremental cutoff from
 * `maxUpdatedAtOp(projectOpId)` — the newest `updated_at_op` already cached. A
 * work package that changes in OP *while a run is in flight* gets a timestamp
 * BELOW that maximum, so it never falls inside any later
 * `updatedAt >= cutoff` window, and it stays stale forever (the confirmed
 * #11948 case: fetched 05:53:11.843, changed in OP 05:53:38.991, then missed by
 * every subsequent "successful" sync). The stored watermark is the run's
 * `started_at` and the filter subtracts `SYNC_OVERLAP_WINDOW_MINUTES`.
 *
 * Why per (connection, PROJECT) and not per connection alone, as SPEC_29 §2.3
 * words it: a single per-connection watermark would be advanced by project A's
 * sync and then used as project B's cutoff, silently skipping B's changes in
 * between — the very bug being fixed, one scope up. Per (connection, project)
 * is the strictly stronger reading, and the spec's actual requirement (a
 * watermark is never shared ACROSS connections) holds.
 *
 * Contract: `set()` is called ONLY after a fully successful run, after
 * `commitStaging`. An `aborted`/`error` run must leave the row untouched — a
 * watermark that moved on a failed run is a permanent hole in coverage.
 * This is deliberately NOT `project.last_synced_at` (best-effort display).
 */
export interface SyncWatermarkRepository {
  /** The stored `watermark_at`, or null when this pair has never succeeded. */
  get(connectionId: number | null, projectOpId: OpId): Promise<string | null>;
  /** Upsert on `(connection_id, project_op_id)`. `watermarkAt` MUST be the
   * run's `started_at` — never `finished_at`, never "now" at commit time. */
  set(
    connectionId: number | null,
    projectOpId: OpId,
    watermarkAt: string,
  ): Promise<void>;
  /** Full refresh (SPEC_29 §6.2): drop every watermark for one connection so
   * the cutoffs are rebuilt from scratch. */
  clearForConnection(connectionId: number | null): Promise<void>;
}

export interface WorkPackageCacheRepository {
  getByOpId(opId: OpId): Promise<WorkPackageCache | null>;
  find(filter: WorkPackageCacheFilter): Promise<WorkPackageCache[]>;
  getManyByOpIds(opIds: OpId[]): Promise<WorkPackageCache[]>;
  upsertMany(rows: NewWorkPackageCache[]): Promise<void>;
  /** Newest updated_at_op currently cached for a project (drives incremental sync). */
  maxUpdatedAtOp(projectOpId: OpId): Promise<string | null>;
  /** Hard-delete cached rows (import-removal cascade, SPEC: never for tickets
   * still in an active/closed sprint — the caller filters those out first). */
  deleteMany(opIds: OpId[]): Promise<void>;
  /** Stamp connection_id on every cached row of a project (SPEC_07 §1/§4):
   * packages/sync builds cache rows without connection context (it only ever
   * sees a pre-built OpClient), so the route calls this right after a sync
   * completes, using the connection IT resolved for that sync. */
  setConnectionIdForProject(projectOpId: OpId, connectionId: number): Promise<void>;
  /** Same, for a specific set of op ids (orphan/individually-added tickets,
   * which can span multiple projects). */
  setConnectionIdForOpIds(opIds: OpId[], connectionId: number): Promise<void>;

  // ── Increment 20 (SPEC_20 §2) — staging, replaces "buffer in a JS array,
  // upsertMany() once at the end" (Increment 19's fix, which itself turned
  // out to still be a single giant synchronous burst with no event-loop
  // yields, AND still left work_package_cache untouched-but-unwritten for
  // the sync's whole duration only by accident of timing, not by design).
  // A sync now writes to work_package_cache_staging in small, independently
  // committed batches as pages arrive — work_package_cache is NEVER touched
  // until a short, explicit merge at the very end, so every read (backlog,
  // filters, sprint board) stays available for the sync's ENTIRE duration,
  // not just "usually, if nothing blocks."

  /** Append one batch of rows to staging for this run, in ONE committed
   * transaction. Call with modest batch sizes (a single OP page's worth is
   * the natural unit, ~100 rows) — never the whole run's rows at once, which
   * would just recreate Increment 19's giant-burst problem one table over. */
  stageBatch(syncRunId: number, rows: NewWorkPackageCache[]): Promise<void>;
  /** Atomically merge every staged row for `syncRunId` into the live cache
   * (upserted by op_id, same conflict semantics as the old `upsertMany`),
   * batched internally so a large merge doesn't block the event loop for
   * its whole duration either, then clears this run's staging rows. Returns
   * the number of rows merged. Call ONLY on a fully successful, uncancelled
   * run — this is the single moment work_package_cache is written. */
  commitStaging(syncRunId: number): Promise<number>;
  /** The abort/error path: delete every staged row for `syncRunId` WITHOUT
   * touching work_package_cache at all — true rollback, no write ever
   * happened as far as the live cache is concerned. */
  dropStaging(syncRunId: number): Promise<void>;
  /** Crash-recovery hygiene: delete ALL staging rows regardless of which run
   * they belong to. Called once at the very start of every `sync()` — if a
   * prior process died mid-run (the exact SPEC_20 §0 incident, "restart the
   * backend to unstick it"), its orphaned staging rows are cleared before
   * this run writes anything, so staging never accumulates indefinitely
   * across crashes. Safe unconditionally: only one sync runs at a time, and
   * work_package_cache is never touched by anything in this table. */
  clearAllStaging(): Promise<void>;
}

export interface EstimateOverrideRepository {
  getByWpOpId(wpOpId: OpId): Promise<EstimateOverride | null>;
  getManyByWpOpIds(wpOpIds: OpId[]): Promise<EstimateOverride[]>;
  upsert(input: NewEstimateOverride): Promise<EstimateOverride>;
}

export interface SprintRepository {
  list(): Promise<Sprint[]>;
  getById(id: number): Promise<Sprint | null>;
  listByStatus(status: Sprint["status"]): Promise<Sprint[]>;
  create(input: NewSprint): Promise<Sprint>;
  update(
    id: number,
    patch: Partial<NewSprint & { status: Sprint["status"] }> & SprintRetroPatch,
  ): Promise<Sprint>;
  /** planning → active; sets activated_at. Unconditional write — the caller
   * (apps/api logic) enforces "only from planning". */
  /** SPEC_05 §2: baselineTotalHours freezes Sprint.baseline_total_hours atomically. */
  activate(id: number, activatedAt: string, baselineTotalHours: number): Promise<Sprint>;
  /** → closed AND locked, atomically (SPEC_04: closing IS the lock event). */
  close(
    id: number,
    completedHours: number,
    closedAt: string,
    lockReason: LockReason,
  ): Promise<Sprint>;
  /**
   * SPEC_11 §8b — reverse a lock: status="active", is_locked=false,
   * lock_reason=null, locked_at=null, closed_at=null (completed_hours and the
   * frozen baseline_total_hours are DELIBERATELY kept). The caller (apps/api
   * logic) enforces the "was locked" + "today ∈ [start,end]" guards and writes
   * the audit sprint_update_run — this is an unconditional write, mirroring
   * activate()/close().
   *
   * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b step 3): ALSO clears
   * `frozen_at` and NULLs every `sprint_item.frozen_*` column for this sprint
   * — a reactivated sprint is live again, and a later re-finish re-freezes
   * from fresh data rather than reading a stale snapshot.
   */
  reactivate(id: number): Promise<Sprint>;
  /**
   * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1/§2b step 4) — set once by
   * the freeze sweep (`apps/api/src/logic/freeze.ts`), after the snapshot
   * (`sprintItems.writeFreezeSnapshot`) has already been written. Unconditional
   * write, mirroring activate()/close()/reactivate() — the caller enforces
   * "was closed+locked and past its grace deadline".
   */
  setFrozen(id: number, frozenAt: string): Promise<Sprint>;
  /**
   * SPEC_11 §2 — hard-delete a sprint AND all its dependent history in ONE
   * transaction (ticket_changelog_entry, sprint_update_run, ticket_baseline,
   * burndown_snapshot, sprint_closure_report, sprint_member_capacity,
   * remaining_status_rule, done_status_rule, sprint_item, then sprint). Works
   * in EVERY status — an intentional destructive escape hatch (client-confirmed
   * modal), distinct from the closed-sprint EDIT immutability. Never touches OP.
   * Returns false if the sprint didn't exist.
   */
  deleteWithCascade(id: number): Promise<boolean>;
}

// ── Increment 4: sprint lifecycle repositories (SPEC_04 §2) ─────────────────

export interface TicketBaselineRepository {
  listBySprint(sprintId: number): Promise<TicketBaseline[]>;
  getBySprintAndWp(sprintId: number, wpOpId: OpId): Promise<TicketBaseline | null>;
  /** Keyed on (sprint_id, wp_op_id); re-activation attempts overwrite, never duplicate. */
  upsertMany(rows: NewTicketBaseline[]): Promise<void>;
}

export interface SprintUpdateRunRepository {
  start(sprintId: number, kind: UpdateRunKind, triggeredBy: UpdateRunTriggeredBy): Promise<SprintUpdateRun>;
  /** Running progress during the per-ticket changelog derivation loop
   * (Increment 8 §3) — same shape as SyncRunRepository.progress(). */
  progress(id: number, processed: number, total: number | null): Promise<void>;
  finish(
    id: number,
    status: SyncStatus,
    wpCount: number | null,
    changesCount: number | null,
    error: string | null,
    finishedAt: string,
  ): Promise<SprintUpdateRun>;
  listBySprint(sprintId: number): Promise<SprintUpdateRun[]>;
  latestBySprint(sprintId: number): Promise<SprintUpdateRun | null>;
  /**
   * Consolidation Round (Concept 8) — crash recovery, mirroring
   * SyncRunRepository.recoverOrphaned() exactly. Marks every row STILL
   * `status='running'` as `'aborted'` (diagnostic `error`, `finished_at = now`)
   * and returns the count. `sprint_update_run` drives
   * activation/update/finish/retro-replay; a process killed mid-run leaves its
   * row stuck `running` forever with no boot recovery (the exact permanent-lock
   * class Increment 22 fixed for `sync_run`), and the watchdog never looks at
   * this table. Called ONCE at every boot (buildServer + buildTestApp), BEFORE
   * any route can run — a fresh process can never own a pre-existing `running`
   * row, so every such row is unconditionally orphaned. Returns rows recovered
   * (0 in the common case).
   */
  recoverOrphaned(): Promise<number>;
}

export interface TicketChangelogRepository {
  /** One ticket's history, oldest first (GET .../tickets/:wpId/changelog). */
  listByTicket(sprintId: number, wpOpId: OpId): Promise<TicketChangelogEntry[]>;
  listBySprint(sprintId: number): Promise<TicketChangelogEntry[]>;
  /** Insert, skipping any row whose dedup_key already exists. Returns the
   * number ACTUALLY inserted (post-dedup) — feeds sprint_update_run.changes_count. */
  insertMany(rows: NewChangelogEntry[]): Promise<number>;
}

export interface SprintItemRepository {
  listBySprint(sprintId: number): Promise<SprintItem[]>;
  getBySprintAndWp(sprintId: number, wpOpId: OpId): Promise<SprintItem | null>;
  /** All items across all sprints for a set of WPs (backlog "in_sprint" flag). */
  findByWpOpIds(wpOpIds: OpId[]): Promise<SprintItem[]>;
  add(input: NewSprintItem): Promise<SprintItem>;
  setOutcome(
    id: number,
    outcome: SprintItemOutcome,
    removedAt?: string | null,
  ): Promise<SprintItem>;
  /** Hard-delete rows (import-removal cascade — only ever used for items in a
   * still-"planning" sprint; active/closed sprint membership is untouchable). */
  deleteMany(ids: number[]): Promise<void>;
  /**
   * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2c) — read the freeze-time
   * snapshot for every item of `sprintId`. Returns a row (possibly all-null
   * frozen fields, if the item was somehow never snapshotted) for every
   * sprint_item, whether or not the sprint is actually frozen — callers decide
   * whether to prefer it based on `sprint.frozen_at`. Cheap (one indexed
   * query); no reason to special-case "sprint isn't frozen" at the repo layer.
   */
  listFrozenSnapshot(sprintId: number): Promise<FrozenSprintItemSnapshot[]>;
  /**
   * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b step 3) — write the
   * freeze-time snapshot. `item_id` is `sprint_item.id` (NOT wp_op_id) and
   * must belong to `sprintId` — the caller's responsibility (freeze.ts derives
   * every row from `listBySprint(sprintId)`, so this always holds in
   * practice), mirroring `setOutcome`'s own id-trust contract. One UPDATE per
   * row (freeze runs at most once per grace deadline — not a hot path).
   */
  writeFreezeSnapshot(
    sprintId: number,
    rows: Array<{ item_id: number } & FrozenSprintItemFields>,
  ): Promise<void>;
}

export interface TeamMemberRepository {
  list(): Promise<TeamMember[]>;
  getById(id: number): Promise<TeamMember | null>;
  getByOpUserId(opUserId: number): Promise<TeamMember | null>;
  /** SPEC_13 §1a (revised) — reuse an existing member by EXACT display name so a
   * reconstructed person auto-materialized across sprints isn't duplicated (the
   * name IS the identity). Case-sensitive, whole-string; first match wins. */
  getByName(name: string): Promise<TeamMember | null>;
  upsert(input: NewTeamMember & { id?: number }): Promise<TeamMember>;
  /** Increment 14 (SPEC_14 §2) — the ONLY way team_member.role changes.
   * Implement in packages/db/src/repos.ts (Agent B). */
  setRole(id: number, role: TeamMember["role"]): Promise<TeamMember>;
}

export interface CapacityRepository {
  listBySprint(sprintId: number): Promise<SprintMemberCapacity[]>;
  /** Replace the full capacity set for a sprint. */
  replaceForSprint(
    sprintId: number,
    rows: NewSprintMemberCapacity[],
  ): Promise<SprintMemberCapacity[]>;
}

export interface DoneStatusRuleRepository {
  listBySprint(sprintId: number): Promise<DoneStatusRule[]>;
  replaceForSprint(
    sprintId: number,
    rows: NewDoneStatusRule[],
  ): Promise<DoneStatusRule[]>;
}

/**
 * Increment 14 (SPEC_14 §2) — the GLOBAL role-aware done matrix (no sprintId,
 * unlike DoneStatusRuleRepository above). Migration 0014 seeds the ten
 * DEFAULT_DONE_RULES rows; `list()` always returns them (never empty) unless
 * an admin explicitly edited the matrix via `replace`. Implement in
 * packages/db/src/repos.ts (Agent B) as `doneRuleRepository(db)`, registered
 * on `Repositories.doneRules`.
 */
export interface DoneRuleRepository {
  list(): Promise<DoneRule[]>;
  /** Full replace — PUT /api/done-rules sends the complete edited matrix. */
  replace(rows: Array<{ status_name: string; kind: DoneRule["kind"] }>): Promise<DoneRule[]>;
}

/**
 * Increment 14 (SPEC_14 §3/§7 #5) — the report_config singleton (id always 1,
 * seeded by migration 0014). Implement in packages/db/src/repos.ts (Agent B)
 * as `reportConfigRepository(db)`, registered on `Repositories.reportConfig`.
 */
export interface ReportConfigRepository {
  get(): Promise<ReportConfig>;
  setOvershootThresholdPct(pct: number): Promise<ReportConfig>;
  /** Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — validated 0–60 by the
   * caller (route/freeze sweep math); the repository itself performs no range
   * check, mirroring setOvershootThresholdPct's own division of labour. */
  setFreezeGraceDays(days: number): Promise<ReportConfig>;
}

/**
 * SPEC_11 §6 — the burndown "Remaining" (blue) allowlist. Mirrors
 * DoneStatusRuleRepository minus counts_as; empty by default (fall back to
 * DEFAULT_REMAINING_STATUSES when a sprint has zero rows — see
 * apps/api/src/logic/remaining.ts).
 */
export interface RemainingStatusRuleRepository {
  listBySprint(sprintId: number): Promise<RemainingStatusRule[]>;
  replaceForSprint(
    sprintId: number,
    rows: NewRemainingStatusRule[],
  ): Promise<RemainingStatusRule[]>;
}

export interface SyncRunRepository {
  start(kind: SyncKind): Promise<SyncRun>;
  /** Update running progress: processed so far + (optionally) the known
   * total. Increment 20 (SPEC_20 §3): also stamps `last_progress_at = now`
   * every call — this IS the heartbeat the watchdog reads; no separate
   * heartbeat method exists, calling this at least once per page/item IS
   * the contract. */
  progress(id: number, processed: number, total: number | null): Promise<void>;
  finish(
    id: number,
    status: SyncStatus,
    wpCount: number | null,
    error: string | null,
    finishedAt: string,
  ): Promise<SyncRun>;
  latest(): Promise<SyncRun | null>;
  current(): Promise<SyncRun | null>;
  getById(id: number): Promise<SyncRun | null>;
  /** Increment 19 (SPEC_19 §2c) — sets `cancel_requested=true` on a still-
   * `running` run; a no-op (but not an error) if it already finished by the
   * time this lands, so `POST /sync/:runId/cancel` is safely idempotent.
   * Does NOT itself change `status` — the engine's page loop observes this
   * flag and transitions to `"aborted"` via `finish()`. */
  requestCancel(id: number): Promise<SyncRun | null>;
  /** Cheap poll used BETWEEN pages inside the engine's loop — avoids
   * round-tripping the whole row when only the flag is needed. */
  isCancelled(id: number): Promise<boolean>;
  /**
   * Increment 22 (SPEC_22 §1) — crash recovery: marks every row STILL
   * `status='running'` as `'aborted'` (with a diagnostic `error` message,
   * `finished_at = now`). Called ONCE at every `buildServer()` boot, BEFORE
   * any route can run — a fresh process's in-memory `hardCancelRun` registry
   * is always empty, so any `running` row at boot time is unconditionally
   * orphaned (no live process could possibly own it — the exact Increment-20
   * incident: a killed process leaves its row stuck `running` forever,
   * permanently 409-blocking every future `POST /sync` via the "one sync at
   * a time" guard). This is DELIBERATELY unconditional (not gated behind
   * `SCHEDULER_ENABLED` like the watchdog) — it runs in `buildServer()`
   * itself, so it also fires in tests (a harmless no-op there — a fresh
   * `:memory:` DB never has a `running` row) and in EVERY real boot
   * regardless of scheduler config. Complements, doesn't replace, the
   * ongoing watchdog (Increment 20) — this is the INSTANT fix at boot;
   * the watchdog is the ongoing safety net for a run that goes stale WITHIN
   * a single process's lifetime. Returns the number of rows recovered (0 in
   * the common case — logged by the caller only when non-zero).
   */
  recoverOrphaned(): Promise<number>;
}

export interface BurndownRepository {
  listBySprint(sprintId: number): Promise<BurndownSnapshot[]>;
  getBySprintAndDate(
    sprintId: number,
    date: string,
  ): Promise<BurndownSnapshot | null>;
  upsert(input: NewBurndownSnapshot): Promise<BurndownSnapshot>;
}

export interface ClosureReportRepository {
  getBySprint(sprintId: number): Promise<SprintClosureReport | null>;
  upsert(input: NewClosureReport): Promise<SprintClosureReport>;
}

// ── Increment 13: identity aliases + retro capacity audit (SPEC_13 §1a/§6) ───

/**
 * SPEC_13 §1a — human-confirmed journal-name → OP-user mappings, scoped per
 * connection (op user ids are per-server). NOT cascaded by a sprint delete:
 * aliases are connection-scoped and apply retroactively across every sprint,
 * so they must outlive any single sprint ("platí retroaktivně").
 */
export interface UserNameAliasRepository {
  listByConnection(connectionId: number): Promise<UserNameAlias[]>;
  /** Every alias across all connections — the canonical person resolver
   * (identity golden tests) folds journal spellings BEFORE keying, and a
   * closure/capacity read spans every connection at once. */
  listAll(): Promise<UserNameAlias[]>;
  getById(id: number): Promise<UserNameAlias | null>;
  /** Create the alias; a duplicate (connection_id, journal_name) UPSERTs the
   * op_user_id (correcting a mistaken alias by re-posting is reasonable UX). */
  upsert(input: NewUserNameAlias): Promise<UserNameAlias>;
  delete(id: number): Promise<boolean>;
}

/**
 * SPEC_13 §6 — the audit trail of capacity edits made on a retrospective sprint
 * AFTER it left planning (the only case that writes here). Cascaded on sprint
 * delete (it is sprint-scoped history, unlike aliases).
 */
export interface CapacityEditAuditRepository {
  listBySprint(sprintId: number): Promise<CapacityEditAuditEntry[]>;
  add(input: NewCapacityEditAudit): Promise<CapacityEditAuditEntry>;
}

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §2/§3) — the sprint's roster-
 * wide "off-sprint" time-entry report. `replaceForSprint` is transactional
 * delete+insert (mirrors CapacityRepository/DoneStatusRuleRepository above):
 * every sprint update run REPLACES the full set, so an entry edited/deleted in
 * OP simply stops appearing on the next run — this is current truth, not an
 * event log (§0.3).
 */
export interface OffSprintTimeRepository {
  listBySprint(sprintId: number): Promise<OffSprintTimeEntry[]>;
  replaceForSprint(
    sprintId: number,
    rows: NewOffSprintTimeEntry[],
  ): Promise<OffSprintTimeEntry[]>;
}
