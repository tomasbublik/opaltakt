import { z } from "zod";
import {
  CapacityMode,
  ChangelogKind,
  ChangelogSource,
  ConnectionStatus,
  DoneCountsAs,
  IsoDate,
  IsoDateTime,
  KdfAlgo,
  LocalId,
  LockReason,
  OpId,
  BurndownSnapshotSource,
  DoneRuleKind,
  PersonRole,
  RetroAddSource,
  RetroSeedKind,
  SprintItemOrigin,
  SprintItemOutcome,
  SprintStatus,
  SyncKind,
  SyncStatus,
  UpdateRunKind,
  UpdateRunTriggeredBy,
} from "./common";

/**
 * Entity schemas mirroring the SQLite data model (SPEC §4, SPEC_02 §2).
 * These describe rows as returned by the API / repositories.
 * The Drizzle table definitions in @osp/db must stay column-compatible with these.
 */

// ── op_connection ───────────────────────────────────────────────────────────
// One stored OP server (SPEC_02: N connections, identified by base_url).
// The token lives ONLY in the AES-256-GCM fields (ct/nonce/tag, base64) and is
// decrypted ad-hoc just before an OP call. This entity is INTERNAL to the
// backend — API responses use the token-free `Connection` shape from api.ts.
export const OpConnection = z.object({
  id: LocalId,
  base_url: z.string().url(),
  /** Optional human label ("prod", "customer X"…). */
  label: z.string().nullable(),
  /**
   * LEGACY plaintext token from the pre-vault schema. Only non-null on rows
   * created before Increment 2; the first vault init encrypts it into the
   * token_ct fields and nulls this out. Never write new plaintext here.
   */
  token_encrypted: z.string().nullable(),
  /** AES-256-GCM ciphertext of the token, base64. */
  token_ct: z.string().nullable(),
  /** Per-row random 12-byte nonce, base64. */
  token_nonce: z.string().nullable(),
  /** GCM auth tag, base64. */
  token_tag: z.string().nullable(),
  default_project_op_id: OpId.nullable(),
  /** The server OP-facing operations (projects/sync/import) currently target. */
  is_current: z.boolean(),
  /** Disconnect/Connect toggle: false excludes this server from the projects/
   * import picker and refuses new OP calls, without deleting the connection. */
  enabled: z.boolean(),
  created_at: IsoDateTime,
  // Health (updated by piggyback on real traffic + the heartbeat, SPEC_02 §4):
  last_activity_at: IsoDateTime.nullable(),
  last_check_at: IsoDateTime.nullable(),
  last_status: ConnectionStatus,
  last_latency_ms: z.number().nullable(),
  last_error: z.string().nullable(),
});
export type OpConnection = z.infer<typeof OpConnection>;

// ── vault_meta ──────────────────────────────────────────────────────────────
// Singleton (id = 1). Holds the KDF configuration + passphrase verifier for the
// token vault (SPEC_02 §3). The derived key lives ONLY in backend memory.
export const VaultMeta = z.object({
  id: z.literal(1),
  kdf_algo: KdfAlgo,
  /** Random KDF salt, base64. */
  kdf_salt: z.string(),
  /** JSON-serialized KDF params (memory/iterations/parallelism or N/r/p). */
  kdf_params_json: z.string(),
  /** Encrypted known-constant blob (GCM tag appended), base64 — verifies the passphrase. */
  verifier_ct: z.string(),
  /** Nonce for the verifier, base64. */
  verifier_nonce: z.string(),
  created_at: IsoDateTime,
});
export type VaultMeta = z.infer<typeof VaultMeta>;

// ── project ─────────────────────────────────────────────────────────────────
// op_id is unique only WITHIN a server (SPEC_02: N connections) — connection_id
// disambiguates two servers that happen to share a numeric project id.
// Nullable only for rows that predate the multi-connection migration.
export const Project = z.object({
  id: LocalId,
  connection_id: LocalId.nullable(),
  op_id: OpId,
  identifier: z.string(),
  name: z.string(),
  last_synced_at: IsoDateTime.nullable(),
});
export type Project = z.infer<typeof Project>;

// ── import_selection ─────────────────────────────────────────────────────────
// One additive import: a project, optionally narrowed to a single version.
// "Sync now" refreshes every recorded selection so version-limited imports stay
// limited (they aren't broadened back to the whole project).
export const ImportSelection = z.object({
  id: LocalId,
  connection_id: LocalId.nullable(),
  project_op_id: OpId,
  project_name: z.string(),
  version_op_id: OpId.nullable(),
  version_name: z.string().nullable(),
  created_at: IsoDateTime,
});
export type ImportSelection = z.infer<typeof ImportSelection>;

// ── work_package_cache ──────────────────────────────────────────────────────
// Last known image of an OP work package. NOT the source of truth (SPEC §4).
export const WorkPackageCache = z.object({
  id: LocalId,
  connection_id: LocalId.nullable(),
  op_id: OpId,
  project_op_id: OpId,
  /** Increment 40 (INCREMENT_40_CONTRACTS §3): raw `_links.project.title` at
   * the last fetch — display-only, never a join key. Null when OP sent none. */
  project_name: z.string().nullable(),
  subject: z.string(),
  type_name: z.string(),
  status_name: z.string(),
  status_is_closed: z.boolean(),
  assignee_op_id: OpId.nullable(),
  assignee_name: z.string().nullable(),
  /** OP estimatedTime, in hours. */
  estimated_hours: z.number().nullable(),
  /** OP remainingTime, in hours — read directly, do NOT derive (SPEC §5). */
  remaining_hours: z.number().nullable(),
  /** OP spentTime, in hours; may be null (needs permission) — fall back to Time Entries. */
  spent_hours: z.number().nullable(),
  /** Only when Backlogs module active; otherwise null (SPEC §5). */
  story_points: z.number().nullable(),
  version_op_id: OpId.nullable(),
  version_name: z.string().nullable(),
  priority: z.string().nullable(),
  parent_op_id: OpId.nullable(),
  percentage_done: z.number().nullable(),
  updated_at_op: IsoDateTime,
  /** Full raw OP work package JSON (HAL), stored as string. */
  raw_json: z.string(),
  cached_at: IsoDateTime,
});
export type WorkPackageCache = z.infer<typeof WorkPackageCache>;

// ── estimate_override ───────────────────────────────────────────────────────
export const EstimateOverride = z.object({
  id: LocalId,
  wp_op_id: OpId,
  planning_hours: z.number(),
  note: z.string().nullable(),
  updated_at: IsoDateTime,
});
export type EstimateOverride = z.infer<typeof EstimateOverride>;

// ── sprint ──────────────────────────────────────────────────────────────────
export const Sprint = z.object({
  id: LocalId,
  name: z.string(),
  start_date: IsoDate,
  end_date: IsoDate,
  status: SprintStatus,
  capacity_mode: CapacityMode,
  /** Filled at closure; total completed hours (velocity input). */
  completed_hours: z.number().nullable(),
  created_at: IsoDateTime,
  closed_at: IsoDateTime.nullable(),
  // ── Increment 4: lifecycle (SPEC_04 §2) ─────────────────────────────────
  /** Set once, by the FIRST activation (planning → active). Never cleared. */
  activated_at: IsoDateTime.nullable(),
  /** Set once, when `is_locked` flips true (finish or end-date auto-lock). */
  locked_at: IsoDateTime.nullable(),
  /** True once locked — every sprint-scoped mutation then 409s (SPRINT_LOCKED). */
  is_locked: z.boolean(),
  lock_reason: LockReason.nullable(),
  /**
   * Increment 31 (docs/INCREMENT_31_CONTRACTS.md): set by the freeze sweep once
   * the post-finish grace period (`report_config.freeze_grace_days`, anchored at
   * `locked_at`) elapses. A frozen sprint reads its numbers from the
   * `sprint_item.frozen_*` snapshot (never the live cache), rejects update runs
   * with SPRINT_FROZEN, and no longer protects its tickets on the Import page.
   * Cleared (with the snapshot) by reactivate.
   */
  frozen_at: IsoDateTime.nullable(),
  /**
   * Increment 5 (SPEC_05 §2): Σ baseline items' effective hours, frozen at
   * activation alongside `activated_at` — never recomputed afterward. Anchors
   * the burndown ideal line so scope creep after activation is visible
   * (current totals move; this doesn't). Null before activation.
   */
  baseline_total_hours: z.number().nullable(),
  // ── Increment 12: retrospective planning (SPEC_12 §2/§7) ─────────────────
  /**
   * Checked only while `status="planning"` (frontend disables it afterward).
   * Changes what activate() does: fills baseline at `start_date` state
   * (reconstructed from OP journals) and replays day-by-day instead of the
   * ordinary "capture current state" activation. Immutable once activated.
   */
  is_retrospective: z.boolean(),
  retro_seed_kind: RetroSeedKind.nullable(),
  /** e.g. an OP version name ("3.5.039") or the raw pasted id list. */
  retro_seed_value: z.string().nullable(),
  /** When the day-by-day replay finished (activation for a retro sprint). */
  retro_replayed_at: IsoDateTime.nullable(),
});
export type Sprint = z.infer<typeof Sprint>;

// ── sprint_item ─────────────────────────────────────────────────────────────
// Never deleted (velocity history) — only `outcome` changes (SPEC §4).
export const SprintItem = z.object({
  id: LocalId,
  sprint_id: LocalId,
  wp_op_id: OpId,
  added_at: IsoDateTime,
  /** Snapshot of the estimate-of-record at the moment of adding. */
  planned_hours: z.number().nullable(),
  outcome: SprintItemOutcome,
  removed_at: IsoDateTime.nullable(),
  /**
   * Increment 5 (SPEC_05 §3): was this item part of the sprint's baseline
   * (present at activation, or added before the sprint was ever activated —
   * i.e. normal planning) or added while the sprint was already `active`?
   * Existing pre-Increment-5 rows default to "baseline" (DB column default).
   */
  origin: SprintItemOrigin,
  /** Increment 25 (SPEC_25 §4/§6): set ONLY when origin === "added_retroactively"
   * — which OP fact `added_at` was backdated from. Null for baseline/
   * added_mid_sprint (their added_at is simply "when it was clicked", no
   * backdating occurred). */
  retro_source: RetroAddSource.nullable(),
});
export type SprintItem = z.infer<typeof SprintItem>;

// ── team_member ─────────────────────────────────────────────────────────────
export const TeamMember = z.object({
  id: LocalId,
  op_user_id: OpId.nullable(),
  name: z.string(),
  default_hours_per_day: z.number(),
  /** Increment 14 (SPEC_14 §2) — seeds "unset"; never guessed. */
  role: PersonRole,
});
export type TeamMember = z.infer<typeof TeamMember>;

// ── sprint_member_capacity ──────────────────────────────────────────────────
export const SprintMemberCapacity = z.object({
  id: LocalId,
  sprint_id: LocalId,
  member_id: LocalId,
  available_hours: z.number(),
  pto_days: z.number(),
});
export type SprintMemberCapacity = z.infer<typeof SprintMemberCapacity>;

// ── capacity_edit_audit (Increment 13, SPEC_13 §6) ──────────────────────────
// Only written on a capacity edit AFTER a sprint leaves "planning" — the
// normal planning-phase capacity flow needs no audit (it's the ordinary,
// expected editing window). A retrospective sprint uniquely allows editing
// past that point (its capacity is a reconstructed historical figure, not a
// live commitment); this table is the trail for those edits.
export const CapacityEditAuditEntry = z.object({
  id: LocalId,
  sprint_id: LocalId,
  edited_at: IsoDateTime,
  /** Snapshot of what changed: `{ [member_id]: { available_hours: {from,to}, pto_days: {from,to} } }`. */
  changes_json: z.string(),
});
export type CapacityEditAuditEntry = z.infer<typeof CapacityEditAuditEntry>;

// ── done_status_rule ────────────────────────────────────────────────────────
export const DoneStatusRule = z.object({
  id: LocalId,
  sprint_id: LocalId,
  status_name: z.string(),
  counts_as: DoneCountsAs,
});
export type DoneStatusRule = z.infer<typeof DoneStatusRule>;

// ── done_rule (Increment 14, SPEC_14 §2) ────────────────────────────────────
// GLOBAL (no sprint_id) — unlike done_status_rule above, which stays
// per-sprint and is still what the pre-Increment-14 closure report / velocity
// path reads. This table is the role-aware matrix; see DoneRuleKind's doc in
// common.ts for the always_done/role_dependent/rejected semantics.
export const DoneRule = z.object({
  id: LocalId,
  status_name: z.string(),
  kind: DoneRuleKind,
});
export type DoneRule = z.infer<typeof DoneRule>;

// ── report_config (Increment 14, SPEC_14 §3/§7 #5) ─────────────────────────
// Singleton (id always 1) — the app's settings row, not only reports
// (Increment 31, docs/INCREMENT_31_CONTRACTS.md §1).
export const ReportConfig = z.object({
  id: LocalId,
  overshoot_threshold_pct: z.number(),
  /** Increment 31 — days of post-finish grace (anchored at `sprint.locked_at`)
   * before the freeze sweep snapshots and locally-locks a closed sprint. Also
   * exposed (validated 0–60) via `AppConfigResponse`/`UpdateAppConfigBody` in
   * api.ts — this is the underlying stored row `GET/PUT /api/config` reads
   * and writes through `@osp/db`'s `ReportConfigRepository`. */
  freeze_grace_days: z.number().int(),
});
export type ReportConfig = z.infer<typeof ReportConfig>;

// ── remaining_status_rule (Increment 11, SPEC_11 §6) ───────────────────────
export const RemainingStatusRule = z.object({
  id: LocalId,
  sprint_id: LocalId,
  status_name: z.string(),
});
export type RemainingStatusRule = z.infer<typeof RemainingStatusRule>;

// ── sync_run ────────────────────────────────────────────────────────────────
export const SyncRun = z.object({
  id: LocalId,
  started_at: IsoDateTime,
  finished_at: IsoDateTime.nullable(),
  kind: SyncKind,
  wp_count: z.number().int().nullable(),
  /** Total WPs to process (known after first page); with wp_count drives progress. */
  total_count: z.number().int().nullable(),
  status: SyncStatus,
  error: z.string().nullable(),
  /**
   * Increment 19 (SPEC_19 §2c): set by `POST /api/sync/:runId/cancel` while
   * `status` is still `"running"`. The engine's page loop checks this BETWEEN
   * pages (network I/O already in flight for the current page always
   * finishes) and stops as soon as it sees it — surfaced so the UI can show
   * "cancelling…" for the brief window between the click landing and the
   * loop actually observing it and flipping `status` to `"aborted"`.
   */
  cancel_requested: z.boolean(),
  /**
   * Increment 20 (SPEC_20 §3) — bumped every time `progress()` is called
   * (i.e. on every page/item processed), independent of `started_at`. The
   * watchdog compares `now - last_progress_at` against a no-progress
   * threshold (not `now - started_at`, which would fire even for a
   * legitimately slow-but-advancing large sync) — a run that's genuinely
   * hung (no page has landed in over a minute) looks different from one
   * that's just processing a lot of pages steadily. Null only before the
   * first `progress()` call (the brief window right after `start()`).
   */
  last_progress_at: IsoDateTime.nullable(),
});
export type SyncRun = z.infer<typeof SyncRun>;

// ── burndown_snapshot ───────────────────────────────────────────────────────
export const BurndownSnapshot = z.object({
  id: LocalId,
  sprint_id: LocalId,
  snapshot_date: IsoDate,
  remaining_hours: z.number(),
  logged_hours: z.number(),
  ideal_hours: z.number(),
  done_count: z.number().int(),
  total_count: z.number().int(),
  /** Increment 12 (SPEC_12 §1/§5): written by the nightly job (`live`) vs
   * computed after the fact from OP journals/time-entries — retrospective
   * replay or "Rebuild burndown from OP history" (`reconstructed`). */
  source: BurndownSnapshotSource,
});
export type BurndownSnapshot = z.infer<typeof BurndownSnapshot>;

// ── sprint_closure_report ───────────────────────────────────────────────────
// The *_json columns store serialized versions of the payload schemas in api.ts.
export const SprintClosureReport = z.object({
  id: LocalId,
  sprint_id: LocalId,
  generated_at: IsoDateTime,
  done_json: z.string(),
  not_done_json: z.string(),
  version_change_json: z.string(),
});
export type SprintClosureReport = z.infer<typeof SprintClosureReport>;

// ── ticket_baseline (Increment 4, SPEC_04 §2) ────────────────────────────────
// The otisk (snapshot) of a sprint ticket's OP state at the moment it entered
// this table's tracking — normally sprint activation. Forward-compatible with
// Increment 5 (tickets added to a running sprint get their OWN baseline row,
// captured_at = the moment they were added, not the sprint's activated_at).
export const TicketBaseline = z.object({
  id: LocalId,
  sprint_id: LocalId,
  wp_op_id: OpId,
  captured_at: IsoDateTime,
  subject: z.string(),
  status_name: z.string(),
  status_is_closed: z.boolean(),
  assignee_op_id: OpId.nullable(),
  /** Separate from assignee (SPEC_03 §2a / SPEC_04 §1). */
  accountable_op_id: OpId.nullable(),
  /**
   * Increment 9 (SPEC_09 §3, "o_t"): the assignee captured at THIS row's
   * insert — frozen forever, unlike `assignee_op_id` above which may be
   * refreshed on a defensive re-capture. Repository upsert must set this ONLY
   * on first insert (never touch it in an ON CONFLICT UPDATE) — otherwise a
   * re-run of captureBaseline would silently lose the original owner, which
   * is exactly the invariant the capacity grey-redistribution math (SPEC_09
   * §3) depends on. Existing pre-Increment-9 rows are backfilled from
   * `assignee_op_id` (best-effort — the true original assignee at THEIR
   * activation moment is unrecoverable, same caveat as every other additive
   * migration in this schema).
   */
  original_assignee_op_id: OpId.nullable(),
  estimated_hours: z.number().nullable(),
  remaining_hours: z.number().nullable(),
  spent_hours: z.number().nullable(),
  version_op_id: OpId.nullable(),
  /** Full raw OP work package JSON (HAL) as of captured_at. */
  raw_json: z.string(),
  /** SPEC_05 §3: activation baseline, or captured when added mid-sprint. */
  origin: SprintItemOrigin,
  /**
   * Increment 12 (SPEC_12 §2/§4): true when this row's fields came from
   * replaying OP journals/time-entries up to a past date (retrospective
   * planning or a manual rebuild) rather than reading OP's live current
   * state. Never silently guessed — see `reconstruction_gaps_json`.
   */
  reconstructed: z.boolean(),
  /**
   * Which fields (of estimate/assignee/status/etc.) had no journal entry to
   * reconstruct from and fell back to the nearest known value — a JSON
   * string array of field names, e.g. `["estimated_hours"]`, or null when
   * nothing was reconstructed / everything reconstructed cleanly. Surfaced
   * to the user as "partially reconstructed" (SPEC_12 §4 — never silent).
   */
  reconstruction_gaps_json: z.string().nullable(),
  /**
   * Increment 13 (SPEC_13 §1): the assignee's DISPLAY NAME as reconstructed
   * from OP journal text at `captured_at` — journals never carry a user id,
   * only a name string, so this is the raw material identity resolution
   * (exact-match against `GET /api/v3/users`, then `user_name_alias`, else
   * `unresolved`) works from. `assignee_op_id` above is NOT trustworthy for
   * a retrospective baseline row — do not use it for retro identity; always
   * re-resolve `assignee_name_raw` at read time (preview/capacity) so a
   * later alias applies retroactively without re-running reconstruction.
   * Null for a non-retrospective baseline (identity there is unambiguous —
   * comes straight from OP's live assignee link, no name resolution needed).
   */
  assignee_name_raw: z.string().nullable(),
});
export type TicketBaseline = z.infer<typeof TicketBaseline>;

// ── user_name_alias (Increment 13, SPEC_13 §1a) ─────────────────────────────
// A human-confirmed mapping from a journal-derived display name to a real OP
// user, scoped per connection (user ids are per-server). Resolves both
// genuinely ambiguous names (SPEC_13's "Jan Belka" vs "Jan Bily" — NEVER
// auto-guessed) and OP users renamed after the fact (old journal text still
// carries their former name; one alias fixes every historical reference).
export const UserNameAlias = z.object({
  id: LocalId,
  connection_id: LocalId,
  journal_name: z.string(),
  /**
   * Increment 13 (REVISED, SPEC_13 §1/§1a/§1b): a person's identity is their
   * NAME — not a numeric OP id (a normal API token can't even list OP's
   * users to build an id index; `GET /api/v3/users` is admin-gated on real
   * OpenProject instances). A journal-derived name gets a capacity line
   * immediately, with hours and editable availability, NEVER blocked on
   * having an id. `user_name_alias` is now the EXCEPTION-HANDLING escape
   * hatch, for: two distinct real OP users who happen to share a display
   * name (pin this journal_name to the right one via op_user_id), or a
   * renamed person (fold their old journal name under their current display
   * name via merge_into_name). At least one of the two should be set.
   */
  op_user_id: OpId.nullable(),
  /** Fold this journal_name's hours under another (current) display name —
   * handles an OP user renamed after old journal entries were written. */
  merge_into_name: z.string().nullable(),
  created_at: IsoDateTime,
});
export type UserNameAlias = z.infer<typeof UserNameAlias>;

// ── sprint_update_run (Increment 4, SPEC_04 §2/§4) ───────────────────────────
// One scoped-diff pass over a sprint's tickets (activation captures the
// baseline; update / final refresh + derive changelog entries).
export const SprintUpdateRun = z.object({
  id: LocalId,
  sprint_id: LocalId,
  kind: UpdateRunKind,
  triggered_by: UpdateRunTriggeredBy,
  started_at: IsoDateTime,
  finished_at: IsoDateTime.nullable(),
  /** Tickets processed SO FAR (same running-count semantics as sync_run's
   * wp_count — poll GET /sprints/:id/updates while status="running" to drive
   * an "updated X / Y tickets" progress display, Increment 8 §3). Equals the
   * final ticket count once status leaves "running". */
  wp_count: z.number().int().nullable(),
  /** Total tickets in scope for this run (known immediately — a sprint's own
   * item count, not paginated) — the "Y" in "X / Y". */
  total_count: z.number().int().nullable(),
  /** New ticket_changelog_entry rows this run actually inserted (post-dedup). */
  changes_count: z.number().int().nullable(),
  status: SyncStatus,
  error: z.string().nullable(),
});
export type SprintUpdateRun = z.infer<typeof SprintUpdateRun>;

// ── ticket_changelog_entry (Increment 4, SPEC_04 §2) ─────────────────────────
// One attributed event for one sprint ticket, derived from OP journals
// (status/assignee/accountable/estimate/remaining/version changes) or OP time
// entries (time_logged). Never deleted; idempotent inserts via `dedup_key`
// (see apps/api/src/logic/sprintUpdate.ts for the exact derivation algorithm).
export const TicketChangelogEntry = z.object({
  id: LocalId,
  sprint_id: LocalId,
  wp_op_id: OpId,
  update_run_id: LocalId,
  occurred_at: IsoDateTime,
  /** Null when OP didn't attribute an actor (e.g. an unassigned ticket's change). */
  actor_op_id: OpId.nullable(),
  actor_name: z.string().nullable(),
  kind: ChangelogKind,
  /** JSON-serialized ChangelogDetail (api.ts) matching `kind` — see api.ts. */
  detail_json: z.string(),
  source: ChangelogSource,
  /** The OP journal (activity) id this entry came from; null for time_entry/diff rows. */
  op_journal_id: z.number().int().nullable(),
});
export type TicketChangelogEntry = z.infer<typeof TicketChangelogEntry>;
