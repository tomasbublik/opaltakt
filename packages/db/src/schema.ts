import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { isoTimestamp, jsonbText } from "./columnTypes";

/**
 * Drizzle PostgreSQL schema — column-compatible with the entity schemas in
 * @osp/contracts (SPEC §4). Conventions (Increment 27, CONTRACTS §3):
 *  - timestamps: `isoTimestamp` — a real timestamptz that reads back as a
 *    contract-valid ISO-8601 string (see columnTypes.ts for why not the stock
 *    `timestamp({ mode: "string" })`, which silently fails contract validation).
 *  - dates (no time): `date({ mode: "string" })` → plain 'YYYY-MM-DD'.
 *  - booleans: native `boolean` (was INTEGER { mode: "boolean" }).
 *  - hours / points: `double precision` — deliberately NOT `numeric`, which
 *    node-postgres returns as a *string* and would silently break every hours
 *    and points calculation in the app.
 *  - JSON payloads: `jsonbText` — real jsonb storage, `string` to TypeScript.
 *  - ciphertext / salts: plain `text`, base64, byte-identical to before.
 *
 * Table, column, index and foreign-key names are unchanged from the SQLite
 * schema — this is a storage-engine cut, not a redesign.
 *
 * Agent B owns the repository IMPLEMENTATIONS (see repositories.ts for interfaces).
 */

// ── op_connection ────────────────────────────────────────────────────────────
// Multi-server registry (SPEC_02 §2). A server is identified by its base_url.
// The token is stored ONLY encrypted (AES-256-GCM ct/nonce/tag, base64);
// `token_encrypted` is the LEGACY plaintext slot from the pre-vault schema and
// is nulled out when the first vault init migrates it.
export const opConnection = pgTable(
  "op_connection",
  {
    id: serial("id").primaryKey(),
    baseUrl: text("base_url").notNull(),
    label: text("label"),
    // Legacy plaintext (pre-Increment-2 rows only); cleared on vault init.
    tokenEncrypted: text("token_encrypted"),
    tokenCt: text("token_ct"),
    tokenNonce: text("token_nonce"),
    tokenTag: text("token_tag"),
    defaultProjectOpId: integer("default_project_op_id"),
    // The server OP-facing operations (projects/sync/import) currently target.
    isCurrent: boolean("is_current").notNull().default(false),
    // Disconnect/Connect toggle: a disabled server is temporarily excluded from
    // the projects/import picker and refuses new OP calls, WITHOUT deleting the
    // stored connection or its cached data. Orthogonal to isCurrent.
    enabled: boolean("enabled").notNull().default(true),
    createdAt: isoTimestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    // Health (piggyback on real traffic + heartbeat, SPEC_02 §4):
    lastActivityAt: isoTimestamp("last_activity_at"),
    lastCheckAt: isoTimestamp("last_check_at"),
    // ok | fail | unknown
    lastStatus: text("last_status").notNull().default("unknown"),
    lastLatencyMs: doublePrecision("last_latency_ms"),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("op_connection_base_url_uq").on(t.baseUrl)],
);

// ── vault_meta ───────────────────────────────────────────────────────────────
// Singleton (id = 1): KDF config + passphrase verifier for the token vault
// (SPEC_02 §3). The derived key itself NEVER touches the database.
export const vaultMeta = pgTable("vault_meta", {
  // Explicit id, NOT serial — always 1 (enforced by the repository).
  id: integer("id").primaryKey(),
  // argon2id | scrypt
  kdfAlgo: text("kdf_algo").notNull(),
  kdfSalt: text("kdf_salt").notNull(),
  kdfParamsJson: jsonbText("kdf_params_json").notNull(),
  verifierCt: text("verifier_ct").notNull(),
  verifierNonce: text("verifier_nonce").notNull(),
  createdAt: isoTimestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── project ──────────────────────────────────────────────────────────────────
// op_id is only unique WITHIN a server (SPEC_02: N connections) — two servers
// can both have a project op_id=7. connectionId is nullable purely so the
// migration can ADD COLUMN without a table rebuild; every row written by the
// application from this point on always sets it (backfilled for pre-existing
// rows in the same migration, from whichever connection was is_current then).
export const project = pgTable(
  "project",
  {
    id: serial("id").primaryKey(),
    connectionId: integer("connection_id").references(() => opConnection.id),
    opId: integer("op_id").notNull(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    lastSyncedAt: isoTimestamp("last_synced_at"),
  },
  (t) => [uniqueIndex("project_connection_op_id_uq").on(t.connectionId, t.opId)],
);

// ── work_package_cache ───────────────────────────────────────────────────────
export const workPackageCache = pgTable(
  "work_package_cache",
  {
    id: serial("id").primaryKey(),
    // Nullable for the same ADD COLUMN reason as project.connectionId above.
    connectionId: integer("connection_id").references(() => opConnection.id),
    opId: integer("op_id").notNull(),
    projectOpId: integer("project_op_id").notNull(),
    // Increment 40 (INCREMENT_40_CONTRACTS §1.1): raw `_links.project.title`
    // at the last fetch — display-only, never a join key.
    projectName: text("project_name"),
    subject: text("subject").notNull(),
    typeName: text("type_name").notNull(),
    statusName: text("status_name").notNull(),
    statusIsClosed: boolean("status_is_closed").notNull(),
    assigneeOpId: integer("assignee_op_id"),
    assigneeName: text("assignee_name"),
    estimatedHours: doublePrecision("estimated_hours"),
    remainingHours: doublePrecision("remaining_hours"),
    spentHours: doublePrecision("spent_hours"),
    storyPoints: doublePrecision("story_points"),
    versionOpId: integer("version_op_id"),
    versionName: text("version_name"),
    priority: text("priority"),
    parentOpId: integer("parent_op_id"),
    percentageDone: doublePrecision("percentage_done"),
    updatedAtOp: isoTimestamp("updated_at_op").notNull(),
    rawJson: jsonbText("raw_json").notNull(),
    cachedAt: isoTimestamp("cached_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    // Ticket identity stays globally keyed on op_id alone — unchanged from
    // before this migration, and consistent with every other WP-keyed table
    // (sprint_item, ticket_baseline, backlog_dismissal all key by wp_op_id
    // globally too). connectionId here is attribution only (which server a
    // cached ticket came from, for import-removal cascade), not identity.
    uniqueIndex("wp_cache_op_id_uq").on(t.opId),
    index("wp_cache_project_idx").on(t.projectOpId),
    index("wp_cache_assignee_idx").on(t.assigneeOpId),
    index("wp_cache_connection_idx").on(t.connectionId),
  ],
);

// ── work_package_cache_staging (Increment 20, SPEC_20 §2) ───────────────────
// Mirrors work_package_cache's columns exactly, plus syncRunId. A running
// sync writes HERE, in small committed batches, never touching the live
// table — so work_package_cache is never locked and every read (backlog,
// filters, sprint board) stays fully available for the sync's entire
// duration. On success, every row for that run is merged into the live
// cache in one short, batched operation; on abort/error/crash it's simply
// dropped (`DELETE ... WHERE sync_run_id = ?`) and the live cache is
// untouched — "abort = rollback" (SPEC_19 §6) without ever holding a
// long-lived write lock (SPEC_19's actual mistake: buffering in a JS array
// and writing it all in ONE final unbatched pass was still a single giant
// synchronous burst of per-row statements with no event-loop yields —
// staging batches solve BOTH problems, not just "when" the write happens).
export const workPackageCacheStaging = pgTable(
  "work_package_cache_staging",
  {
    id: serial("id").primaryKey(),
    syncRunId: integer("sync_run_id")
      .notNull()
      .references(() => syncRun.id),
    connectionId: integer("connection_id").references(() => opConnection.id),
    opId: integer("op_id").notNull(),
    projectOpId: integer("project_op_id").notNull(),
    // Increment 40 (INCREMENT_40_CONTRACTS §1.1): raw `_links.project.title`
    // at the last fetch — display-only, never a join key.
    projectName: text("project_name"),
    subject: text("subject").notNull(),
    typeName: text("type_name").notNull(),
    statusName: text("status_name").notNull(),
    statusIsClosed: boolean("status_is_closed").notNull(),
    assigneeOpId: integer("assignee_op_id"),
    assigneeName: text("assignee_name"),
    estimatedHours: doublePrecision("estimated_hours"),
    remainingHours: doublePrecision("remaining_hours"),
    spentHours: doublePrecision("spent_hours"),
    storyPoints: doublePrecision("story_points"),
    versionOpId: integer("version_op_id"),
    versionName: text("version_name"),
    priority: text("priority"),
    parentOpId: integer("parent_op_id"),
    percentageDone: doublePrecision("percentage_done"),
    updatedAtOp: isoTimestamp("updated_at_op").notNull(),
    rawJson: jsonbText("raw_json").notNull(),
    cachedAt: isoTimestamp("cached_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    // Scopes a merge/drop to exactly one run's rows. No unique index on
    // opId — staging may legitimately hold nothing special about ordering;
    // the merge upserts into the live cache by opId same as today, so a
    // duplicate within one run's staging rows just merges harmlessly.
    index("wp_cache_staging_run_idx").on(t.syncRunId),
  ],
);

// ── estimate_override ────────────────────────────────────────────────────────
export const estimateOverride = pgTable(
  "estimate_override",
  {
    id: serial("id").primaryKey(),
    wpOpId: integer("wp_op_id").notNull(),
    planningHours: doublePrecision("planning_hours").notNull(),
    note: text("note"),
    updatedAt: isoTimestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex("estimate_override_wp_uq").on(t.wpOpId)],
);

// ── sprint ───────────────────────────────────────────────────────────────────
export const sprint = pgTable("sprint", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Date-only (no time): a real PG `date`, read back as plain 'YYYY-MM-DD'.
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }).notNull(),
  // planning | active | closed
  status: text("status").notNull().default("planning"),
  // per_person | aggregate
  capacityMode: text("capacity_mode").notNull().default("per_person"),
  completedHours: doublePrecision("completed_hours"),
  createdAt: isoTimestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  closedAt: isoTimestamp("closed_at"),
  // ── Increment 4: lifecycle (SPEC_04 §2) ──────────────────────────────────
  activatedAt: isoTimestamp("activated_at"),
  lockedAt: isoTimestamp("locked_at"),
  isLocked: boolean("is_locked").notNull().default(false),
  // finished | end_date
  lockReason: text("lock_reason"),
  // ── Increment 5: baseline anchor for scope-creep tracking (SPEC_05 §2) ───
  // Frozen once at activation (Σ baseline items' effective hours); null before.
  baselineTotalHours: doublePrecision("baseline_total_hours"),
  // ── Increment 12: retrospective planning (SPEC_12 §2/§7) ─────────────────
  isRetrospective: boolean("is_retrospective").notNull().default(false),
  // version | ids | manual
  retroSeedKind: text("retro_seed_kind"),
  retroSeedValue: text("retro_seed_value"),
  retroReplayedAt: isoTimestamp("retro_replayed_at"),
  // ── Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1/§2b) ──────────────────
  // Set EXACTLY ONCE by the freeze sweep, once `locked_at + freeze_grace_days`
  // elapses for a closed+locked sprint; cleared (together with every
  // sprint_item.frozen_* column below) by reactivate(). A frozen sprint's
  // read surfaces (computeClosureStats/buildCapacityResponse/
  // buildSprintItemsDetailed) prefer the frozen_* snapshot over the live
  // work_package_cache — CAPACITY_BAR_RULES §5a/§6 invariant 10.
  frozenAt: isoTimestamp("frozen_at"),
});

// ── sprint_item ──────────────────────────────────────────────────────────────
export const sprintItem = pgTable(
  "sprint_item",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    wpOpId: integer("wp_op_id").notNull(),
    addedAt: isoTimestamp("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    plannedHours: doublePrecision("planned_hours"),
    // planned | done | carried | removed | removed_mid_sprint — never deleted (SPEC §4, SPEC_05 §3)
    outcome: text("outcome").notNull().default("planned"),
    removedAt: isoTimestamp("removed_at"),
    // baseline | added_mid_sprint | added_retroactively (SPEC_05 §3, SPEC_25
    // §6). Existing rows default to "baseline".
    origin: text("origin").notNull().default("baseline"),
    // Increment 25 (SPEC_25 §4/§6): 'first_time_entry' | 'created_at' | null —
    // set only when origin = 'added_retroactively', which OP fact `added_at`
    // (above) was backdated from.
    retroSource: text("retro_source"),
    // ── Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — freeze snapshot ──
    // All nullable, written ONLY by freeze.ts's `freezeSprint` (never at add
    // time) for every non-removed item, and nulled again by reactivate().
    // Deliberately NOT part of the @osp/contracts `SprintItem` entity — these
    // are a backend-internal input to the three read surfaces listed in §2c,
    // never serialized to the frontend directly (it already gets effective_
    // hours/assignee_name/status_name/etc. from those surfaces' own DTOs).
    //
    // `frozenEffectiveHours` — the `effectiveEstimate` (CAPACITY_BAR_RULES §3,
    // incl. estimate overrides) of record AT FREEZE TIME.
    frozenEffectiveHours: doublePrecision("frozen_effective_hours"),
    // The FINAL holder at freeze time.
    frozenAssigneeOpId: integer("frozen_assignee_op_id"),
    frozenAssigneeName: text("frozen_assignee_name"),
    frozenStatusName: text("frozen_status_name"),
    frozenStatusIsClosed: boolean("frozen_status_is_closed"),
    // Parent edge for the leaf double-count guard (doubleCounting.ts) — without
    // it, deleting the cache row would silently un-suppress a parent/child pair.
    frozenParentOpId: integer("frozen_parent_op_id"),
    // Identity scope for the frozen assignee (createPersonResolver handles a
    // null connection, but the known value is stored so resolution is exact).
    frozenConnectionId: integer("frozen_connection_id"),
    // AMENDMENT (INCREMENT_31_CONTRACTS §1, found by the §5.5 golden test):
    // SprintItemDetail.project_op_id has no baseline fallback (ticket_baseline
    // carries no project column), so without this a frozen sprint whose cache
    // rows were deleted emitted project_op_id 0 and failed its own schema.
    frozenProjectOpId: integer("frozen_project_op_id"),
    // Increment 34 (docs/INCREMENT_34_CONTRACTS.md §4) — the live REMAINING
    // hours at freeze time (`?? baseline remaining` — freeze.ts), distinct
    // from `frozenEffectiveHours` above (the resolved bar-length estimate).
    // Feeds the §1 "Delivered = burned remaining" `remEnd` for a frozen
    // sprint (CAPACITY_BAR_RULES §6 invariant 10 composed with invariant 11).
    frozenRemainingHours: doublePrecision("frozen_remaining_hours"),
    // Increment 40 (INCREMENT_40_CONTRACTS §1.3) — the project's display name
    // and identifier AT FREEZE TIME, so a frozen sprint keeps showing the name
    // it had even after a rename in OP or deletion of the cache/project row
    // (CAPACITY_BAR_RULES §6 invariant 10, extended).
    frozenProjectName: text("frozen_project_name"),
    frozenProjectIdentifier: text("frozen_project_identifier"),
  },
  (t) => [
    index("sprint_item_sprint_idx").on(t.sprintId),
    index("sprint_item_wp_idx").on(t.wpOpId),
    uniqueIndex("sprint_item_sprint_wp_uq").on(t.sprintId, t.wpOpId),
  ],
);

// ── team_member ──────────────────────────────────────────────────────────────
export const teamMember = pgTable("team_member", {
  id: serial("id").primaryKey(),
  opUserId: integer("op_user_id"),
  name: text("name").notNull(),
  defaultHoursPerDay: doublePrecision("default_hours_per_day").notNull(),
  // developer | tester | customer | other | unset (Increment 14, SPEC_14 §2).
  // Never guessed — seeds "unset", stays "unset" until a human sets it.
  role: text("role").notNull().default("unset"),
});

// ── sprint_member_capacity ───────────────────────────────────────────────────
export const sprintMemberCapacity = pgTable(
  "sprint_member_capacity",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    memberId: integer("member_id")
      .notNull()
      .references(() => teamMember.id),
    availableHours: doublePrecision("available_hours").notNull(),
    ptoDays: doublePrecision("pto_days").notNull().default(0),
  },
  (t) => [
    uniqueIndex("sprint_member_uq").on(t.sprintId, t.memberId),
    // Increment 27 (CONTRACTS §3e): explicit index where SQLite relied on a
    // scan — every capacity read is scoped by sprint_id.
    index("sprint_member_capacity_sprint_idx").on(t.sprintId),
  ],
);

// ── capacity_edit_audit (Increment 13, SPEC_13 §6) ──────────────────────────
export const capacityEditAudit = pgTable(
  "capacity_edit_audit",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    editedAt: isoTimestamp("edited_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    changesJson: jsonbText("changes_json").notNull(),
  },
  (t) => [index("capacity_edit_audit_sprint_idx").on(t.sprintId)],
);

// ── user_name_alias (Increment 13, SPEC_13 §1a) ─────────────────────────────
// journal_name → op_user_id, scoped per connection (ids are per-server).
export const userNameAlias = pgTable(
  "user_name_alias",
  {
    id: serial("id").primaryKey(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => opConnection.id),
    journalName: text("journal_name").notNull(),
    // Increment 13 (revised, SPEC_13 §1b): now the ESCAPE HATCH, not the
    // required step — nullable. Either opUserId (pin to a specific OP
    // account, e.g. disambiguating two people who share a display name) or
    // mergeIntoName (fold a renamed person's old journal name under their
    // current display name — no numeric id needed) may be set; at least one
    // should be, enforced at the contract/route level, not here.
    opUserId: integer("op_user_id"),
    mergeIntoName: text("merge_into_name"),
    createdAt: isoTimestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("user_name_alias_conn_name_uq").on(t.connectionId, t.journalName),
  ],
);

// ── done_status_rule ─────────────────────────────────────────────────────────
export const doneStatusRule = pgTable(
  "done_status_rule",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    statusName: text("status_name").notNull(),
    // done | rejected
    countsAs: text("counts_as").notNull(),
  },
  (t) => [index("done_status_rule_sprint_idx").on(t.sprintId)],
);

// ── done_rule (Increment 14, SPEC_14 §2) ─────────────────────────────────────
// GLOBAL (no sprint_id) — the role-aware done matrix, distinct from and
// additive to done_status_rule above (which stays per-sprint and keeps
// driving the pre-Increment-14 closure report / velocity path unchanged).
export const doneRule = pgTable(
  "done_rule",
  {
    id: serial("id").primaryKey(),
    statusName: text("status_name").notNull(),
    // always_done | role_dependent | rejected
    kind: text("kind").notNull(),
  },
  (t) => [uniqueIndex("done_rule_status_uq").on(t.statusName)],
);

// ── report_config (Increment 14, SPEC_14 §3/§7 #5) ──────────────────────────
// Singleton (id = 1): the one configurable knob closure statistics need.
export const reportConfig = pgTable("report_config", {
  // Explicit id, NOT serial — always 1 (enforced by the repository).
  id: integer("id").primaryKey(),
  overshootThresholdPct: doublePrecision("overshoot_threshold_pct").notNull().default(25),
  // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §1) — days of post-finish
  // grace (anchored at `sprint.locked_at`) before the freeze sweep snapshots
  // and locks a closed sprint. `report_config` is hereby the app's settings
  // singleton, not only a report-statistics knob.
  freezeGraceDays: integer("freeze_grace_days").notNull().default(3),
});

// ── remaining_status_rule (Increment 11, SPEC_11 §6) ─────────────────────────
// Parallel to done_status_rule: which statuses count as "still dev-pending"
// for the burndown Remaining line. Matched case-insensitively against
// work_package_cache.status_name (see HIDDEN_BACKLOG_STATUSES for the same
// pattern). Seeded with the default set (New, Confirmed, In progress) at the
// same point done_status_rule rows get seeded; editable later without code
// changes by editing rows for a sprint_id.
export const remainingStatusRule = pgTable(
  "remaining_status_rule",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    statusName: text("status_name").notNull(),
  },
  (t) => [index("remaining_status_rule_sprint_idx").on(t.sprintId)],
);

// ── sync_run ─────────────────────────────────────────────────────────────────
export const syncRun = pgTable("sync_run", {
  id: serial("id").primaryKey(),
  startedAt: isoTimestamp("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: isoTimestamp("finished_at"),
  // full | incremental | snapshot
  kind: text("kind").notNull(),
  wpCount: integer("wp_count"),
  // Total work packages to process (known after the first page) — drives the
  // sync progress bar; wpCount is the running "processed so far".
  totalCount: integer("total_count"),
  // running | success | error | aborted (Increment 19, SPEC_19 §2c)
  status: text("status").notNull().default("running"),
  error: text("error"),
  // Increment 19 (SPEC_19 §2c) — set by POST /sync/:runId/cancel; the
  // engine's page loop polls this between pages and stops as soon as it
  // sees it, writing NOTHING to work_package_cache for that run.
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  // Increment 20 (SPEC_20 §3) — bumped on every progress() call (heartbeat).
  // The watchdog compares now-vs-this, not now-vs-startedAt, so a slow-but-
  // steadily-advancing large sync is never mistaken for a hung one.
  lastProgressAt: isoTimestamp("last_progress_at"),
});

// ── sync_watermark (Increment 29, SPEC_29 §2 / CONTRACTS §3) ────────────────
// The incremental-sync cutoff, keyed per (connection, project).
//
// Before this table, `sync()` derived its cutoff from `maxUpdatedAtOp(project)`
// — the newest `updated_at_op` already cached. A work package edited in OP
// *while a run is in flight* gets a timestamp BELOW that maximum, so it never
// falls inside any later `updatedAt >= cutoff` window and stays stale forever
// (the confirmed #11948 case). The stored `watermark_at` is the successful
// run's `started_at`, and the engine subtracts SYNC_OVERLAP_WINDOW_MINUTES from
// it — a slightly wider window is always the safe direction.
//
// Per (connection, PROJECT), not per connection alone: a single per-connection
// watermark would be advanced by project A's sync and then used as project B's
// cutoff, silently skipping B's changes in between — the very bug being fixed,
// one scope up. See SyncWatermarkRepository in repositories.ts for the full
// rationale and the "written ONLY after a fully successful run" contract.
export const syncWatermark = pgTable(
  "sync_watermark",
  {
    id: serial("id").primaryKey(),
    // Nullable for the same ADD COLUMN reason as project.connectionId — a
    // legacy null group resolves to the current connection, as everywhere else.
    connectionId: integer("connection_id").references(() => opConnection.id),
    projectOpId: integer("project_op_id").notNull(),
    watermarkAt: isoTimestamp("watermark_at").notNull(),
  },
  (t) => [
    uniqueIndex("sync_watermark_connection_project_uq").on(
      t.connectionId,
      t.projectOpId,
    ),
  ],
);

// ── burndown_snapshot ────────────────────────────────────────────────────────
export const burndownSnapshot = pgTable(
  "burndown_snapshot",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    // Date-only (no time) — plain 'YYYY-MM-DD'.
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    remainingHours: doublePrecision("remaining_hours").notNull(),
    loggedHours: doublePrecision("logged_hours").notNull(),
    idealHours: doublePrecision("ideal_hours").notNull(),
    doneCount: integer("done_count").notNull(),
    totalCount: integer("total_count").notNull(),
    // live | reconstructed (Increment 12, SPEC_12 §1/§5) — existing rows
    // default to "live" (they were all written by the nightly job).
    source: text("source").notNull().default("live"),
  },
  (t) => [
    uniqueIndex("burndown_sprint_date_uq").on(t.sprintId, t.snapshotDate),
    // Increment 27 (CONTRACTS §3e): explicit index where SQLite relied on a
    // scan — the burndown series is always read per sprint.
    index("burndown_snapshot_sprint_idx").on(t.sprintId),
  ],
);

// ── sprint_closure_report ────────────────────────────────────────────────────
export const sprintClosureReport = pgTable("sprint_closure_report", {
  id: serial("id").primaryKey(),
  sprintId: integer("sprint_id")
    .notNull()
    .references(() => sprint.id),
  generatedAt: isoTimestamp("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  doneJson: jsonbText("done_json").notNull(),
  notDoneJson: jsonbText("not_done_json").notNull(),
  versionChangeJson: jsonbText("version_change_json").notNull(),
});

// ── import_selection ─────────────────────────────────────────────────────────
// One additive import (a project, optionally a single version). Drives the
// backlog contents + what "Sync now" refreshes.
export const importSelection = pgTable(
  "import_selection",
  {
    id: serial("id").primaryKey(),
    // Nullable for the same ADD COLUMN reason as project.connectionId above.
    connectionId: integer("connection_id").references(() => opConnection.id),
    projectOpId: integer("project_op_id").notNull(),
    projectName: text("project_name").notNull(),
    versionOpId: integer("version_op_id"),
    versionName: text("version_name"),
    createdAt: isoTimestamp("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("import_selection_connection_idx").on(t.connectionId)],
);

// ── backlog_dismissal ────────────────────────────────────────────────────────
// Work packages the user removed from the backlog view. Local-only (never touches
// OP). The WP stays cached (so a sprint that already holds it still works); the
// backlog endpoint just hides dismissed op ids. Survives re-sync/re-import.
export const backlogDismissal = pgTable("backlog_dismissal", {
  // Explicit id, NOT serial — the OP work-package id IS the primary key.
  wpOpId: integer("wp_op_id").primaryKey(),
  dismissedAt: isoTimestamp("dismissed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ── ticket_baseline (Increment 4, SPEC_04 §2) ────────────────────────────────
// Otisk of a sprint ticket's OP state, captured at activation (forward-
// compatible: a ticket added mid-sprint in Increment 5 gets its own row).
export const ticketBaseline = pgTable(
  "ticket_baseline",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    wpOpId: integer("wp_op_id").notNull(),
    capturedAt: isoTimestamp("captured_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    subject: text("subject").notNull(),
    statusName: text("status_name").notNull(),
    statusIsClosed: boolean("status_is_closed").notNull(),
    assigneeOpId: integer("assignee_op_id"),
    accountableOpId: integer("accountable_op_id"),
    // Increment 9 (SPEC_09 §3, "o_t"): the assignee at THIS row's first
    // insert, frozen forever — repos.ticketBaselines.upsertMany must set this
    // ONLY in the INSERT values, never in the ON CONFLICT UPDATE set, or a
    // defensive re-capture would silently lose the original owner the grey
    // capacity math depends on. Nullable + backfilled from assigneeOpId in
    // the migration for pre-Increment-9 rows (best-effort, unrecoverable).
    originalAssigneeOpId: integer("original_assignee_op_id"),
    estimatedHours: doublePrecision("estimated_hours"),
    remainingHours: doublePrecision("remaining_hours"),
    spentHours: doublePrecision("spent_hours"),
    versionOpId: integer("version_op_id"),
    rawJson: jsonbText("raw_json").notNull(),
    // baseline | added_mid_sprint (SPEC_05 §3) — existing rows default to "baseline".
    origin: text("origin").notNull().default("baseline"),
    // ── Increment 12: reconstruction provenance (SPEC_12 §2/§4) ────────────
    reconstructed: boolean("reconstructed").notNull().default(false),
    reconstructionGapsJson: jsonbText("reconstruction_gaps_json"),
    // Increment 13 (SPEC_13 §1): raw journal-reconstructed assignee NAME —
    // identity resolution (exact-match/alias/unresolved) reads THIS at
    // request time, never trusts assigneeOpId above for retro identity.
    assigneeNameRaw: text("assignee_name_raw"),
  },
  (t) => [
    uniqueIndex("ticket_baseline_sprint_wp_uq").on(t.sprintId, t.wpOpId),
    index("ticket_baseline_sprint_idx").on(t.sprintId),
    // Increment 27 (CONTRACTS §3e): explicit index where SQLite relied on a
    // scan — baselines are also looked up per work package across sprints.
    index("ticket_baseline_wp_idx").on(t.wpOpId),
  ],
);

// ── sprint_update_run (Increment 4, SPEC_04 §2/§4) ───────────────────────────
export const sprintUpdateRun = pgTable(
  "sprint_update_run",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    // activation | update | final
    kind: text("kind").notNull(),
    // manual | scheduler | finish | end_date
    triggeredBy: text("triggered_by").notNull(),
    startedAt: isoTimestamp("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    finishedAt: isoTimestamp("finished_at"),
    // Running count (same semantics as sync_run.wp_count) — driven by
    // progress() during the per-ticket changelog derivation loop, Increment 8 §3.
    wpCount: integer("wp_count"),
    // Total tickets in scope, known immediately (a sprint's own item count).
    totalCount: integer("total_count"),
    changesCount: integer("changes_count"),
    // running | success | error
    status: text("status").notNull().default("running"),
    error: text("error"),
  },
  (t) => [index("sprint_update_run_sprint_idx").on(t.sprintId)],
);

// ── ticket_changelog_entry (Increment 4, SPEC_04 §2) ─────────────────────────
export const ticketChangelogEntry = pgTable(
  "ticket_changelog_entry",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id),
    wpOpId: integer("wp_op_id").notNull(),
    updateRunId: integer("update_run_id")
      .notNull()
      .references(() => sprintUpdateRun.id),
    occurredAt: isoTimestamp("occurred_at").notNull(),
    actorOpId: integer("actor_op_id"),
    actorName: text("actor_name"),
    // time_logged | status_changed | assignee_changed | accountable_changed |
    // closed | estimate_changed | remaining_changed | version_changed | other
    kind: text("kind").notNull(),
    detailJson: jsonbText("detail_json").notNull(),
    // journal | time_entry | diff
    source: text("source").notNull(),
    opJournalId: integer("op_journal_id"),
    // Idempotence key — see NewChangelogEntry in repositories.ts for the format.
    dedupKey: text("dedup_key").notNull(),
  },
  (t) => [
    uniqueIndex("ticket_changelog_dedup_uq").on(t.dedupKey),
    index("ticket_changelog_ticket_idx").on(t.sprintId, t.wpOpId),
  ],
);

// ── off_sprint_time_entry (Increment 32, docs/INCREMENT_32_CONTRACTS.md §2) ──
// "What are the developers ACTUALLY working on" — replace-on-refresh report of
// a sprint's roster's OP time entries logged OUTSIDE the sprint's own tickets,
// within its calendar window. Each sprint update run REPLACES this table's rows
// for that sprint wholesale (§0.3: "a report of current truth, not history"),
// so `ON DELETE CASCADE` is deliberately used here (unlike most sprint-scoped
// tables, which the app deletes in explicit dependency order in
// `SprintRepository.deleteWithCascade` — this table carries no audit trail a
// human would want preserved independently of the sprint it describes).
export const offSprintTimeEntry = pgTable(
  "off_sprint_time_entry",
  {
    id: serial("id").primaryKey(),
    sprintId: integer("sprint_id")
      .notNull()
      .references(() => sprint.id, { onDelete: "cascade" }),
    // The connection this entry's OP server came from — nullable for the same
    // "legacy/unknown connection" reason as project.connectionId elsewhere.
    connectionId: integer("connection_id").references(() => opConnection.id),
    opTimeEntryId: integer("op_time_entry_id").notNull(),
    wpOpId: integer("wp_op_id").notNull(),
    // Denormalized from `_links.workPackage.title` (§2) — the WP is typically
    // NOT in the local cache (that's the whole point: off-sprint tickets were
    // never imported), so this is never re-fetched or joined against the cache.
    wpSubject: text("wp_subject"),
    actorOpId: integer("actor_op_id").notNull(),
    actorName: text("actor_name"),
    // Date-only (no time), matching sprint.start_date/end_date's mode.
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    hours: doublePrecision("hours").notNull(),
    fetchedAt: isoTimestamp("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("off_sprint_time_entry_sprint_op_te_uq").on(t.sprintId, t.opTimeEntryId),
    index("off_sprint_time_entry_sprint_idx").on(t.sprintId),
  ],
);

/** All tables, for convenient `drizzle(client, { schema })` wiring. */
export const schema = {
  opConnection,
  vaultMeta,
  project,
  workPackageCache,
  workPackageCacheStaging,
  estimateOverride,
  sprint,
  sprintItem,
  teamMember,
  sprintMemberCapacity,
  capacityEditAudit,
  userNameAlias,
  doneStatusRule,
  doneRule,
  reportConfig,
  remainingStatusRule,
  syncRun,
  syncWatermark,
  burndownSnapshot,
  sprintClosureReport,
  importSelection,
  backlogDismissal,
  ticketBaseline,
  sprintUpdateRun,
  ticketChangelogEntry,
  offSprintTimeEntry,
};
