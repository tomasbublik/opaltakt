import { z } from "zod";
import {
  AggregateHealthColor,
  BurndownSnapshotSource,
  CapacityMode,
  ConnectionStatus,
  DeveloperSegmentKind,
  DoneRuleKind,
  IsoDate,
  IsoDateTime,
  LocalId,
  OpId,
  PersonRole,
  SprintItemOrigin,
  SprintItemOutcome,
  SprintStatus,
  TicketDoneBucket,
  UpdateRunTriggeredBy,
} from "./common";
import {
  CapacityEditAuditEntry,
  DoneRule,
  EstimateOverride,
  ImportSelection,
  Project,
  Sprint,
  SprintItem,
  SprintMemberCapacity,
  SprintUpdateRun,
  SyncRun,
  TeamMember,
  TicketChangelogEntry,
  UserNameAlias,
  WorkPackageCache,
} from "./entities";

/**
 * Request & response schemas for every REST endpoint in SPEC §7.
 * Naming convention: `<Verb><Resource>Body` / `<Verb><Resource>Query` /
 * `<...>Params` for inputs, `<Resource>Response` for outputs.
 * Path params are exposed as `*Params` schemas so route handlers can validate them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vault (SPEC_02 §3/§5) — master passphrase unlocks all stored tokens.
// The passphrase/key NEVER appears in any response; only status flags do.
// ─────────────────────────────────────────────────────────────────────────────
export const VaultStatusResponse = z.object({
  initialized: z.boolean(),
  locked: z.boolean(),
});
export type VaultStatusResponse = z.infer<typeof VaultStatusResponse>;

export const VaultInitBody = z.object({ passphrase: z.string().min(8) });
export type VaultInitBody = z.infer<typeof VaultInitBody>;

export const VaultUnlockBody = z.object({ passphrase: z.string().min(1) });
export type VaultUnlockBody = z.infer<typeof VaultUnlockBody>;

export const VaultChangePassphraseBody = z.object({
  old_passphrase: z.string().min(1),
  new_passphrase: z.string().min(8),
});
export type VaultChangePassphraseBody = z.infer<typeof VaultChangePassphraseBody>;

/** Explicit confirmation — reset irreversibly deletes all encrypted tokens. */
export const VaultResetBody = z.object({ confirm: z.literal(true) });
export type VaultResetBody = z.infer<typeof VaultResetBody>;

export const VaultResetResponse = z.object({
  /** Connections whose stored token was deleted (their base_url/label remain). */
  cleared_tokens: z.number().int(),
});
export type VaultResetResponse = z.infer<typeof VaultResetResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Connections (SPEC_02 §5) — multi-server registry. NO token in any response.
// ─────────────────────────────────────────────────────────────────────────────
export const ConnectionHealth = z.object({
  last_activity_at: IsoDateTime.nullable(),
  last_check_at: IsoDateTime.nullable(),
  last_status: ConnectionStatus,
  last_latency_ms: z.number().nullable(),
  last_error: z.string().nullable(),
});
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

/** One stored OP server as returned by the API — token-free by construction. */
export const Connection = z.object({
  id: LocalId,
  base_url: z.string().url(),
  label: z.string().nullable(),
  default_project_op_id: OpId.nullable(),
  /** True → OP-facing operations (projects/sync/import) target this server. */
  is_current: z.boolean(),
  /** False → temporarily excluded from the projects/import picker and refuses
   * new OP calls, without deleting the connection (Disconnect/Connect toggle). */
  enabled: z.boolean(),
  /** True when an encrypted token is stored (false after a vault reset). */
  has_token: z.boolean(),
  created_at: IsoDateTime,
  health: ConnectionHealth,
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionsResponse = z.array(Connection);
export type ConnectionsResponse = z.infer<typeof ConnectionsResponse>;

export const ConnectionIdParams = z.object({
  id: z.coerce.number().int().positive(),
});
export type ConnectionIdParams = z.infer<typeof ConnectionIdParams>;

/**
 * POST /api/connections. Requires an UNLOCKED vault (423 otherwise). The token
 * is validated via GET /users/me, encrypted and stored. Validation failure does
 * NOT reject the connection — it is stored with health `fail` (so a currently
 * unreachable server can still be registered); `user` is present only when
 * validation succeeded.
 */
export const AddConnectionBody = z.object({
  base_url: z.string().url(),
  token: z.string().min(1),
  label: z.string().optional(),
  default_project_op_id: OpId.optional(),
});
export type AddConnectionBody = z.infer<typeof AddConnectionBody>;

export const OpUserSummary = z.object({
  op_id: OpId,
  name: z.string(),
  login: z.string().optional(),
});
export type OpUserSummary = z.infer<typeof OpUserSummary>;

export const AddConnectionResponse = Connection.extend({
  user: OpUserSummary.optional(),
});
export type AddConnectionResponse = z.infer<typeof AddConnectionResponse>;

/** PATCH /api/connections/:id — label / default project / new token / make current / connect-disconnect. */
export const UpdateConnectionBody = z.object({
  label: z.string().nullable().optional(),
  default_project_op_id: OpId.nullable().optional(),
  /** Replace the stored token (requires an unlocked vault). */
  token: z.string().min(1).optional(),
  /** Set true to make this the current server (clears the flag elsewhere). */
  current: z.literal(true).optional(),
  /** Disconnect/Connect toggle — false excludes this server from the projects/
   * import picker and refuses new OP calls, without deleting the connection. */
  enabled: z.boolean().optional(),
});
export type UpdateConnectionBody = z.infer<typeof UpdateConnectionBody>;

export const DeleteConnectionResponse = z.object({ deleted: z.boolean() });
export type DeleteConnectionResponse = z.infer<typeof DeleteConnectionResponse>;

/** GET /api/connections/health (+ the SSE stream payload). */
export const ConnectionsHealthResponse = z.object({
  aggregate: AggregateHealthColor,
  connections: z.array(Connection),
});
export type ConnectionsHealthResponse = z.infer<typeof ConnectionsHealthResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/projects  (from OP, across every ENABLED connection)
// ─────────────────────────────────────────────────────────────────────────────
/** A project tagged with the server it came from — lets the Import picker
 * group projects by server (base_url + port identifies a server, SPEC ask). */
export const ProjectWithConnection = Project.extend({
  connection_base_url: z.string().nullable(),
  connection_label: z.string().nullable(),
});
export type ProjectWithConnection = z.infer<typeof ProjectWithConnection>;
export const ProjectsResponse = z.array(ProjectWithConnection);
export type ProjectsResponse = z.infer<typeof ProjectsResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/versions?projectId&connectionId  (from OP — versions of one project)
// ─────────────────────────────────────────────────────────────────────────────
export const OpVersionSummary = z.object({ op_id: OpId, name: z.string() });
export type OpVersionSummary = z.infer<typeof OpVersionSummary>;
export const VersionsResponse = z.array(OpVersionSummary);
export type VersionsResponse = z.infer<typeof VersionsResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/imports  (recorded additive import selections)
// ─────────────────────────────────────────────────────────────────────────────
export const ImportSelectionWithConnection = ImportSelection.extend({
  connection_base_url: z.string().nullable(),
  connection_label: z.string().nullable(),
});
export type ImportSelectionWithConnection = z.infer<typeof ImportSelectionWithConnection>;
export const ImportsResponse = z.array(ImportSelectionWithConnection);
export type ImportsResponse = z.infer<typeof ImportsResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/imports/:id  (remove an import + cascade to the local backlog)
// ─────────────────────────────────────────────────────────────────────────────
export const ImportIdParams = z.object({
  id: z.coerce.number().int().positive(),
});
export type ImportIdParams = z.infer<typeof ImportIdParams>;

/** Never touches the connected OP server; never removes a ticket that's in an
 * active or closed/historical sprint (SPEC: only backlog + planning-sprint items). */
export const RemoveImportResponse = z.object({
  deleted: z.boolean(),
  /** Backlog/planning-sprint tickets actually removed locally. */
  removed_ticket_count: z.number().int(),
  /** Tickets left untouched because they're in an active or closed sprint. */
  protected_ticket_count: z.number().int(),
});
export type RemoveImportResponse = z.infer<typeof RemoveImportResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/work-packages  (add a single ticket to the backlog by OP id)
// ─────────────────────────────────────────────────────────────────────────────
export const ImportWorkPackageBody = z.object({ op_id: OpId });
export type ImportWorkPackageBody = z.infer<typeof ImportWorkPackageBody>;
export const ImportWorkPackageResponse = WorkPackageCache;
export type ImportWorkPackageResponse = z.infer<typeof ImportWorkPackageResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sync  &  GET /api/sync/status
// ─────────────────────────────────────────────────────────────────────────────
export const TriggerSyncBody = z.object({
  /** Import/refresh this project. Omit to REFRESH every recorded import selection. */
  project_op_id: OpId.optional(),
  /** Narrow the import to a single version of the project (additive). */
  version_op_id: OpId.optional(),
  /** Which server project_op_id belongs to. Omit to use the current connection
   * (back-compat). Ignored when project_op_id is omitted — a full refresh
   * always targets each recorded import selection's OWN connection. */
  connection_id: LocalId.optional(),
  /** Omit for auto (incremental unless first run / version-scoped). */
  kind: z.enum(["full", "incremental"]).optional(),
  /** Increment 29 (SPEC_29 §6.2) — run this refresh-all as a FULL REFRESH:
   * clear every `sync_watermark` row for each connection before syncing it, so
   * the overlap-window cutoffs are rebuilt from scratch and a permanently
   * missed change cannot survive indefinitely. Meaningful ONLY for refresh-all
   * (no `project_op_id`); ignored otherwise, exactly like `connection_id`.
   * Set by the "Full refresh" button and by the daily scheduler. */
  full_refresh: z.boolean().optional(),
});
export type TriggerSyncBody = z.infer<typeof TriggerSyncBody>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/snapshot — write burndown snapshots for every ACTIVE sprint, as of
// a given date (defaults to today). This is the nightly job body, exposed so
// operators/tooling (e.g. the scenario mock's advance-day helper, SPEC_03 §6)
// can build a burndown day-by-day without waiting for the cron.
// ─────────────────────────────────────────────────────────────────────────────
export const TriggerSnapshotBody = z.object({
  /** Snapshot date (YYYY-MM-DD); defaults to the server's today. */
  date: IsoDate.optional(),
});
export type TriggerSnapshotBody = z.infer<typeof TriggerSnapshotBody>;

export const SnapshotResponse = z.object({
  date: IsoDate,
  /** How many active sprints got a snapshot written. */
  active_sprints: z.number().int(),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponse>;

export const SyncStatusResponse = z.object({
  current: SyncRun.nullable(),
  last: SyncRun.nullable(),
  last_synced_at: z.string().datetime({ offset: true }).nullable(),
  /**
   * Increment 19 (SPEC_19 §2b): `Date.now() - Date.parse(current.started_at)`,
   * computed fresh on every poll (never persisted — `started_at` is the one
   * source of truth) so the frontend's existing 1s-interval poll of this
   * endpoint can render a live `mm:ss`. Null whenever `current` is null.
   */
  current_elapsed_ms: z.number().int().nullable(),
});
export type SyncStatusResponse = z.infer<typeof SyncStatusResponse>;

/** POST /api/sync/:runId/cancel (SPEC_19 §2c) — the updated run, `status`
 * still `"running"` (cancellation is observed asynchronously by the engine's
 * page loop; see `SyncRun.cancel_requested`) unless it had already finished
 * (finishing before the request lands is not an error — the endpoint is
 * idempotent, returning the run unchanged). */
export const CancelSyncResponse = SyncRun;
export type CancelSyncResponse = z.infer<typeof CancelSyncResponse>;

/**
 * Increment 23 (SPEC_23 §1) — one connection's outcome within a "Sync now"
 * refresh-all pass. The root bug this fixes: `POST /sync` with no
 * `project_op_id` (refresh-all) used to enumerate every connection and let a
 * SINGLE disconnected/unreachable one's `CONNECTION_DISABLED` throw abort the
 * ENTIRE request — one dead mock server permanently blocked syncing every
 * OTHER, perfectly healthy connection too. Now each connection is isolated:
 * `"skipped"` for a connection that's disabled/unreachable BEFORE any sync
 * attempt (never fatal to the batch), `"error"` for one that started syncing
 * but failed partway (also never fatal to the batch — SPEC_23 §1.4:
 * `CONNECTION_DISABLED` is fatal ONLY for an operation that needs THAT one
 * specific connection, e.g. a single-project sync targeting it explicitly —
 * `POST /sync` WITH `project_op_id` set is unaffected by this type, it still
 * throws directly, unchanged).
 */
/**
 * Increment 29 (SPEC_29 §1/§4) — how much of ONE connection's cached backlog a
 * refresh-all pass actually re-read. The bug this exists to make impossible:
 * every run reported `status: "success"` while roughly half the cache had not
 * been touched in a week, because the sync's scope was the import selection
 * rather than the cache's contents (see `docs/INCREMENT_29_CONTRACTS.md` §0a —
 * a row whose PROJECT is selected but whose VERSION is not fell through both
 * the paginated sync and the orphans pass).
 *
 * Every field is recomputed FROM THE DATABASE after the pass finishes, never
 * accumulated while fetching: a count derived from "what we believe we sent"
 * is precisely the reporting that let this hide behind a green status.
 */
export const SyncCoverage = z.object({
  /** Cached rows belonging to this connection at the end of the pass. */
  total_cached: z.number().int(),
  /** …of which `cached_at >= ` the moment this connection's group started. */
  refreshed: z.number().int(),
  /** `total_cached - refreshed`. **> 0 obliges the UI to warn** — a partial
   * refresh must never render as an unqualified success. */
  not_refreshed: z.number().int(),
  /** Cached rows OP no longer returns when asked for them by id. REPORTED,
   * never auto-deleted: a row hidden by permissions is indistinguishable from
   * a deleted one, and hard-deleting the user's sprint history on a guess is
   * not recoverable. Deletion stays an explicit user action (§6). */
  orphan_op_ids: z.array(OpId),
  /** Age of the stalest row for this connection — lets the UI say "oldest
   * record: …" instead of only a count. Null when the connection has none. */
  oldest_cached_at: IsoDateTime.nullable(),
});
export type SyncCoverage = z.infer<typeof SyncCoverage>;

export const ConnectionSyncOutcome = z.object({
  connection_id: LocalId,
  connection_label: z.string().nullable(),
  status: z.enum(["synced", "skipped", "error"]),
  /** Present only when `status === "synced"`. */
  run: SyncRun.nullable(),
  /** Human-readable reason — "disconnected", "unreachable", or an error
   * message — always populated so the UI never shows a bare status with no
   * explanation (SPEC_22 §4's "no silent no-op" principle, extended here to
   * the per-connection granularity refresh-all now has). */
  message: z.string(),
  /** Increment 29 — null for a `skipped`/`error` outcome: nothing was
   * attempted there, and a zeroed coverage block would read as "everything is
   * stale" rather than "not measured". */
  coverage: SyncCoverage.nullable(),
});
export type ConnectionSyncOutcome = z.infer<typeof ConnectionSyncOutcome>;

/**
 * POST /api/sync response shape for a REFRESH-ALL call (no `project_op_id`
 * in the request body) — a single-project sync (`project_op_id` given) keeps
 * returning a plain `SyncRun`, unchanged; the frontend discriminates by
 * checking for a `connections` array (see `isSyncRefreshAllResponse` in
 * `apps/web/src/api-client.ts`, Agent C's addition).
 */
export const SyncRefreshAllResponse = z.object({
  /** Every connection group this refresh-all pass touched — one entry per
   * connection with at least one import selection (or the orphans pass). */
  connections: z.array(ConnectionSyncOutcome),
  /** The most recently SUCCESSFUL run across all connections, if any — kept
   * so a caller that only cares about "did anything sync" (e.g. bumping a
   * generic "last synced" display) doesn't need to scan `connections`
   * itself. Null when every connection was skipped/errored. */
  last: SyncRun.nullable(),
  /** Increment 29 (SPEC_29 §6.2) — this pass ran as a FULL REFRESH: every
   * `sync_watermark` row for the connection was cleared first, so no stale
   * incremental cutoff could survive it. `SyncKind` is deliberately NOT
   * extended with a fourth value (it is a closed enum the UI switches on);
   * this flag is how a caller distinguishes the daily/on-demand full refresh
   * from an ordinary "Sync now". */
  full_refresh: z.boolean(),
});
export type SyncRefreshAllResponse = z.infer<typeof SyncRefreshAllResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/backlog?projectId&status&assignee&version&priority&hasEstimate  (from cache)
// ─────────────────────────────────────────────────────────────────────────────
export const BacklogQuery = z.object({
  /** Omit to return the union across ALL imported projects (additive backlog). */
  projectId: OpId.optional(),
  status: z.string().optional(),
  /** @deprecated legacy bare-OP-id match — UNSAFE across connections, see
   * `FilterOptionEntry`'s doc comment. Kept only for backward compatibility;
   * a request supplying `assigneeKey` ignores this field entirely. */
  assignee: OpId.optional(),
  /** @deprecated legacy bare-OP-id match — see `assignee` above; superseded
   * by `versionKey`. */
  version: OpId.optional(),
  /** Increment 19 (SPEC_19 §1) — was missing; Priority couldn't be filtered
   * server-side before, only client-side. */
  priority: z.string().optional(),
  /** Coerced from ?hasEstimate=true|false. */
  hasEstimate: z.coerce.boolean().optional(),
  /** Filter to tickets sourced from one connection (SPEC_07 §4). */
  connectionId: LocalId.optional(),
  /**
   * Increment 23 (SPEC_23 §2) — the connection-safe replacement for
   * `assignee`. Matches `FilterOptionEntry.key`, i.e.
   * `${connection_id}:${op_user_id}` (or `none:${op_user_id}` for legacy
   * connection-less rows) — NEVER a bare `op_user_id`, which collides across
   * servers (the Alan Turing@mock / Cameron Dalby@Acme incident, both
   * OP user id 3 on their own server). Takes precedence over `assignee` when
   * both are supplied.
   */
  assigneeKey: z.string().optional(),
  /** Increment 23 (SPEC_23 §2) — the connection-safe replacement for
   * `version`, same `key` format and collision rationale as `assigneeKey`. */
  versionKey: z.string().optional(),
  /** Increment 40 (INCREMENT_40_CONTRACTS §2.B3) — the connection-safe
   * project filter: `${connection_id}:${project_op_id}` (or `none:<id>`), same
   * format/rationale as `assigneeKey`. Takes precedence over the
   * collision-unsafe legacy `projectId` when both are supplied. */
  projectKey: z.string().optional(),
});
export type BacklogQuery = z.infer<typeof BacklogQuery>;

/**
 * GET /api/backlog/filter-options (SPEC_19 §1/§3) — the SINGLE source of
 * truth for every backlog filter dropdown's OPTION LIST, replacing each
 * screen's own client-side `[...new Set(items.map(...))]` derivation. Takes
 * the SAME shape as `BacklogQuery` (minus `hasEstimate`, not a value facet)
 * so the caller passes its CURRENTLY selected filters as query params.
 *
 * CASCADING (SPEC_19 §6 decision 2, "options from currently displayed data"):
 * each facet in the response is computed from the backlog cache with EVERY
 * OTHER active filter applied EXCEPT that facet's own field — e.g. `statuses`
 * reflects `projectId`/`assignee`/`version`/`priority`/`connectionId` but
 * ignores any `status` already selected. This is what actually prevents the
 * reported bug (Version 3.5.040 + Status "In progress" → 0 results): a status
 * that cannot occur for the currently-selected Version simply never appears
 * as an option in the first place, for EVERY filter combination, not only the
 * one in the bug report. Same HIDDEN_BACKLOG_STATUSES + local-dismissal
 * exclusion as `GET /api/backlog` itself (never offer an option that would
 * always yield zero visible rows). Values are the VERBATIM stored strings —
 * never hardcoded, never re-cased — so selecting one and round-tripping it
 * through `BacklogQuery` is guaranteed to match by construction; case-
 * insensitive comparison (SPEC_19 §1.2) is an ADDITIONAL safety net on the
 * matching side, not a substitute for cascading, correctly-sourced options.
 */
export const BacklogFilterOptionsQuery = BacklogQuery.omit({ hasEstimate: true });
export type BacklogFilterOptionsQuery = z.infer<typeof BacklogFilterOptionsQuery>;

/**
 * Increment 23 (SPEC_23 §2) — extended to be safe to match/dedup ACROSS
 * connections. `id` alone used to be the sole key, but `id` is an
 * `op_user_id`/`op_version_id` that's only unique WITHIN one OP server —
 * two people on two different connections can share the same numeric id
 * (the confirmed incident: Alan Turing on the mock and Cameron Dalby on
 * Acme are both OP user id 3). Matching/deduping by bare `id` silently
 * merged them in the dropdown and, worse, made selecting one return the
 * OTHER's tickets too — a cross-server data leak, not just a display bug.
 *
 * `key` is the composite, collision-proof identifier every caller should
 * actually match and dedup on: `${connection_id}:${id}` for a row with a
 * known connection, or `none:${id}` for a legacy row cached before
 * `connection_id` backfill (Increment 22) ever ran. `id`/`name` are kept
 * for display and backward-compatible legacy matching (`BacklogQuery.
 * assignee`/`version`) — never use them alone for equality across
 * connections.
 */
const FilterOptionEntry = z.object({
  id: OpId,
  name: z.string(),
  key: z.string(),
  connection_id: LocalId.nullable(),
  connection_label: z.string().nullable(),
});

export const BacklogFilterOptionsResponse = z.object({
  /** Increment 40: keyed like assignees/versions (`key` =
   * `${connection_id}:${project_op_id}`) — was `string[]` of names, which
   * merged two same-named projects on different servers. */
  projects: z.array(FilterOptionEntry),
  statuses: z.array(z.string()),
  assignees: z.array(FilterOptionEntry),
  versions: z.array(FilterOptionEntry),
  priorities: z.array(z.string()),
  servers: z.array(z.object({ id: LocalId, name: z.string() })),
});
export type BacklogFilterOptionsResponse = z.infer<typeof BacklogFilterOptionsResponse>;

/** A cached work package plus the effective planning estimate (override-aware). */
export const BacklogItem = WorkPackageCache.extend({
  /** Project display name, RESOLVED via `resolveProjectRef` (Increment 40 —
   * frozen snapshot → cache `_links.project.title` → connection-scoped
   * `project` row → baseline raw_json); null if unknown. Display-only. */
  project_name: z.string().nullable(),
  /** Increment 40: the project's short `identifier` (the `/projects/<identifier>/`
   * URL segment), from the connection-scoped `project` row (or the frozen
   * snapshot); null when OP never told us (e.g. 404 on /projects/{id}). */
  project_identifier: z.string().nullable(),
  /** planning_hours from estimate_override, else null. */
  override_hours: z.number().nullable(),
  /** Estimate-of-record used for planning (override ?? estimated_hours). */
  effective_hours: z.number().nullable(),
  /** True when this WP is currently assigned to any non-closed sprint. */
  in_sprint: z.boolean(),
  /** The server this ticket was imported from (SPEC_07 §4), for the backlog's
   * sort/filter-by-server column; null for legacy rows with no recorded
   * connection. */
  connection_base_url: z.string().nullable(),
  connection_label: z.string().nullable(),
  /** True when the source connection is disconnected or currently unreachable
   * (health last_status "fail") — SPEC_07 §1: the row still works fully
   * (add to sprint, override), it's just visibly not-live data. */
  stale: z.boolean(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

export const BacklogResponse = z.array(BacklogItem);
export type BacklogResponse = z.infer<typeof BacklogResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/backlog/remove  (hide work packages from the backlog — local only)
// ─────────────────────────────────────────────────────────────────────────────
export const RemoveFromBacklogBody = z.object({
  wp_op_ids: z.array(OpId).min(1),
});
export type RemoveFromBacklogBody = z.infer<typeof RemoveFromBacklogBody>;
export const RemoveFromBacklogResponse = z.object({ removed: z.number().int() });
export type RemoveFromBacklogResponse = z.infer<typeof RemoveFromBacklogResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 29 (SPEC_29 §1.5) — cached tickets that no longer fall under any
// import selection.
//
// They keep being SYNCED (§1: sync scope is the cache's contents, not the
// selection — that is the whole point of this increment), but the user must be
// able to tidy them away. Distinct from `POST /api/backlog/remove`, which only
// HIDES a ticket from the backlog view via a dismissal row: this pair LISTS and
// hard-DELETES the `work_package_cache` row itself.
//
// Local only. Nothing here writes to OpenProject — the read-only invariant is
// not relaxed by a delete endpoint.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A row is out of selection when NO import selection `S` of the same connection
 * covers it: `S.project_op_id === R.project_op_id` and
 * (`S.version_op_id === null` — project-wide, covers every version — or
 * `S.version_op_id === R.version_op_id`). That version asymmetry is the exact
 * gap this increment closes (`docs/INCREMENT_29_CONTRACTS.md` §0a).
 */
export const OutOfSelectionEntry = z.object({
  op_id: OpId,
  subject: z.string(),
  project_op_id: OpId,
  project_name: z.string().nullable(),
  version_op_id: OpId.nullable(),
  version_name: z.string().nullable(),
  connection_id: LocalId.nullable(),
  connection_label: z.string().nullable(),
  cached_at: IsoDateTime,
  updated_at_op: IsoDateTime,
  /** Member of SOME sprint (any status) — informational; the deletability rule
   * is `protected` below (Increment 31 revised the old "any sprint protects"
   * stance: a FROZEN sprint reads from its own snapshot, so deleting its cache
   * rows is provably harmless — docs/INCREMENT_31_CONTRACTS.md §3). */
  in_sprint: z.boolean(),
  /** Names of the sprints this ticket belongs to that still PROTECT it
   * (planning / active / closed-within-grace, i.e. not frozen). */
  sprint_names: z.array(z.string()),
  /** Names of FROZEN sprints this ticket belongs to (no longer protecting). */
  frozen_sprint_names: z.array(z.string()),
  /** THE deletability rule: true iff at least one non-frozen sprint references
   * the ticket. Bulk delete excludes protected rows; the UI disables them. */
  protected: z.boolean(),
});
export type OutOfSelectionEntry = z.infer<typeof OutOfSelectionEntry>;

export const OutOfSelectionResponse = z.object({
  entries: z.array(OutOfSelectionEntry),
  total: z.number().int(),
  /** How many of `entries` are `in_sprint` (and thus undeletable). */
  protected_count: z.number().int(),
});
export type OutOfSelectionResponse = z.infer<typeof OutOfSelectionResponse>;

export const DeleteOutOfSelectionBody = z.object({
  op_ids: z.array(OpId).min(1),
});
export type DeleteOutOfSelectionBody = z.infer<typeof DeleteOutOfSelectionBody>;

/**
 * Every id is re-validated SERVER-SIDE (the client's list can be stale by the
 * time it posts). Partial success is the normal outcome and is a 200, never an
 * error — the UI reports the buckets.
 */
export const DeleteOutOfSelectionResponse = z.object({
  removed: z.array(OpId),
  /** In a sprint → never deleted, whatever the client asked for. */
  protected: z.array(
    z.object({ op_id: OpId, sprint_names: z.array(z.string()) }),
  ),
  rejected: z.array(
    z.object({
      op_id: OpId,
      reason: z.enum(["in_selection", "not_cached"]),
    }),
  ),
});
export type DeleteOutOfSelectionResponse = z.infer<
  typeof DeleteOutOfSelectionResponse
>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/estimate-override
// ─────────────────────────────────────────────────────────────────────────────
export const CreateEstimateOverrideBody = z.object({
  wp_op_id: OpId,
  planning_hours: z.number(),
  note: z.string().optional(),
});
export type CreateEstimateOverrideBody = z.infer<typeof CreateEstimateOverrideBody>;

export const EstimateOverrideResponse = EstimateOverride;
export type EstimateOverrideResponse = z.infer<typeof EstimateOverrideResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Sprints CRUD
// ─────────────────────────────────────────────────────────────────────────────
export const SprintIdParams = z.object({ id: z.coerce.number().int().positive() });
export type SprintIdParams = z.infer<typeof SprintIdParams>;

export const SprintsResponse = z.array(Sprint);
export type SprintsResponse = z.infer<typeof SprintsResponse>;

export const SprintResponse = Sprint;
export type SprintResponse = z.infer<typeof SprintResponse>;

export const CreateSprintBody = z.object({
  name: z.string().min(1),
  start_date: IsoDate,
  end_date: IsoDate,
  capacity_mode: CapacityMode.default("per_person"),
});
export type CreateSprintBody = z.infer<typeof CreateSprintBody>;

export const UpdateSprintBody = z
  .object({
    name: z.string().min(1),
    start_date: IsoDate,
    end_date: IsoDate,
    status: SprintStatus,
    capacity_mode: CapacityMode,
    /**
     * Increment 12 (SPEC_12 §2): only settable while `status="planning"` —
     * the route 409s if the sprint isn't planning (checkbox is disabled
     * client-side too). Once activated it's immutable (no further PATCH may
     * change it, planning or not).
     */
    is_retrospective: z.boolean(),
  })
  .partial();
export type UpdateSprintBody = z.infer<typeof UpdateSprintBody>;

/**
 * Increment 11 (SPEC_11 §2): DELETE /sprints/:id — hard delete, works in
 * planning/active/closed/locked (an explicit, confirmed escape hatch; NOT an
 * edit, so it does not violate the closed-sprint immutability rule from
 * Increment 4). Cascades sprint_item, ticket_baseline, ticket_changelog_entry,
 * burndown_snapshot, sprint_update_run, sprint_member_capacity,
 * sprint_closure_report, remaining_status_rule, done_status_rule. Never
 * touches OP. Confirmation ("Are you sure?") is a frontend-only modal — the
 * route itself deletes unconditionally once called.
 *
 * Increment 12 (SPEC_12 §6): a JSON snapshot (sprint + items + baselines +
 * changelog + burndown + capacity + closure) is written to
 * `exports/sprint-<name>-<timestamp>.json` BEFORE the cascade runs — a cheap
 * insurance policy after the Increment-11 incident. `export_path` is that
 * file's path (relative to the repo root), always present — delete never
 * proceeds if the export itself fails to write.
 */
export const DeleteSprintResponse = z.object({
  sprint_id: LocalId,
  deleted: z.literal(true),
  export_path: z.string(),
});
export type DeleteSprintResponse = z.infer<typeof DeleteSprintResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 12 (SPEC_12) — retrospective planning, history rebuild
//
// POST /api/sprints/:id/retro/seed        — bulk-add candidate tickets (by OP
//   version or a pasted id list), each reconstructed to its start_date state.
//   Only valid while status="planning" AND is_retrospective=true. Persists
//   retro_seed_kind/retro_seed_value on the sprint, adds sprint_item rows
//   (origin="baseline", planned_hours = reconstructed estimate), and returns
//   the same per-ticket preview the caller would get from a subsequent GET
//   .../retro/preview.
// GET  /api/sprints/:id/retro/preview     — read-only re-view of the CURRENT
//   sprint_items' start_date-reconstructed state (estimate/assignee/status +
//   gaps) — works whether items got there via retro/seed or plain manual add
//   (SPEC_12 §2 path C) on a retrospective sprint. Drives the "this is what it
//   looked like on start_date" table before Activate.
// POST /api/sprints/:id/activate          — unchanged endpoint; behavior forks
//   internally on is_retrospective (SPEC_12 §2: baseline @ start_date + a
//   day-by-day replay instead of "capture current state"). Response shape is
//   still the existing ActivateSprintResponse (SprintUpdateRun) — the
//   frontend polls GET .../updates exactly as for a normal activation/update.
// POST /api/sprints/:id/rebuild-burndown  — recompute burndown_snapshot rows
//   from OP journals + time entries for ANY sprint (SPEC_12 §5), including a
//   locked one — a pure read/recompute, NEVER touches sprint.status/is_locked
//   (same "view ≠ lock" principle as SPEC_11 §8a's closure-report split).
// ─────────────────────────────────────────────────────────────────────────────
export const RetroSeedBody = z.object({
  kind: z.enum(["version", "ids"]),
  /** An OP version name (kind="version") or a free-form pasted id list
   * (kind="ids" — comma/whitespace/newline separated, parsed server-side). */
  value: z.string().min(1),
});
export type RetroSeedBody = z.infer<typeof RetroSeedBody>;

/** One candidate ticket's start_date-reconstructed state (SPEC_12 §2/§4). */
export const RetroSeedCandidate = z.object({
  wp_op_id: OpId,
  subject: z.string(),
  /** Work/estimate at start_date, from the initial "set to"/nearest prior
   * "changed to" journal entry. Null when there's truly no data. */
  estimate_at_start_date: z.number().nullable(),
  assignee_at_start_date: z.string().nullable(),
  status_at_start_date: z.string().nullable(),
  /** True when ANY of the fields above had to fall back (no journal entry
   * to reconstruct from) — never silently guessed (SPEC_12 §4). */
  reconstructed: z.boolean(),
  /** Field names that hit a gap, e.g. ["estimate_at_start_date"]. Empty when
   * everything reconstructed cleanly (including when reconstructed=false). */
  gaps: z.array(z.string()),
  /**
   * Increment 13 (SPEC_13 §1): the OP user id `assignee_at_start_date` was
   * resolved to — via exact-match against the connection's user list, or a
   * `user_name_alias` row — or null when unresolved (no auto-guessing) or
   * when there's no assignee name to resolve at all. Capacity/roster code
   * MUST key off this (or a fresh re-resolution of `assignee_at_start_date`),
   * never off a ticket's current/live assignee id.
   */
  assignee_op_id_at_start_date: OpId.nullable(),
  /** How `assignee_op_id_at_start_date` was obtained; null when there was no
   * name to resolve (`assignee_at_start_date` is itself null). */
  assignee_resolution: z.enum(["exact", "alias", "unresolved"]).nullable(),
  /**
   * Increment 13 (SPEC_13 §2): true when this ticket's OWN creation activity
   * is AFTER the sprint's start_date — it did not exist yet at start_date, so
   * every "at_start_date" field above is informational fallback ONLY, never a
   * real baseline. Renders as "created <created_at_op>" in the UI, not as a
   * silently-gapped baseline row; the replay routes it as a scope addition at
   * its actual creation date (red segment), mirroring version-based scope
   * churn (SPEC_12 §3) rather than inventing new mechanics.
   */
  created_after_start_date: z.boolean(),
  /** The ticket's actual creation moment (earliest activity's createdAt),
   * when known — present regardless of `created_after_start_date`. */
  created_at_op: IsoDateTime.nullable(),
});
export type RetroSeedCandidate = z.infer<typeof RetroSeedCandidate>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 13 (REVISED, SPEC_13 §1/§1a/§1b) — a person IS their name. OP user
// id is opportunistic enrichment (from _links.assignee/_links.accountable on
// work packages already being fetched, and GET /api/v3/memberships — NEVER
// from GET /api/v3/users, which is admin-gated on real OpenProject and
// silently starved this whole feature in production), never a precondition
// for a capacity line existing or being editable.
//
// GET    /api/sprints/:id/people   — every person holding retro-reconstructed
//   work in this sprint: name, hours, ticket count, and op_user_id WHEN known
//   (null otherwise — informational, not a blocking state).
// POST   /api/user-aliases         — the ESCAPE HATCH for the rare case a name
//   needs manual help: pin `journal_name` to a specific `op_user_id` (two
//   different real people share a display name) or fold it under
//   `merge_into_name` (a renamed person's old journal name). At least one of
//   the two must be set. Applies retroactively (resolution happens at READ
//   time, never baked into a row).
// DELETE /api/user-aliases/:id     — undo a mistaken pairing.
// ─────────────────────────────────────────────────────────────────────────────
export const SprintPersonEntry = z.object({
  connection_id: LocalId,
  name: z.string(),
  /** The OP user id this name is currently known to belong to, if any —
   * from a live _links.assignee/accountable title match, a memberships
   * lookup, or a user_name_alias. Null is normal and non-blocking. */
  op_user_id: OpId.nullable(),
  /** Σ effective hours this name holds as a start_date-reconstructed
   * assignee across the sprint's tickets. */
  hours: z.number(),
  ticket_count: z.number().int(),
});
export type SprintPersonEntry = z.infer<typeof SprintPersonEntry>;

export const SprintPeopleResponse = z.array(SprintPersonEntry);
export type SprintPeopleResponse = z.infer<typeof SprintPeopleResponse>;

export const CreateUserAliasBody = z
  .object({
    connection_id: LocalId,
    journal_name: z.string().min(1),
    op_user_id: OpId.optional(),
    merge_into_name: z.string().min(1).optional(),
  })
  .refine((b) => b.op_user_id !== undefined || b.merge_into_name !== undefined, {
    message: "at least one of op_user_id or merge_into_name is required",
  });
export type CreateUserAliasBody = z.infer<typeof CreateUserAliasBody>;

export const UserAliasResponse = UserNameAlias;
export type UserAliasResponse = z.infer<typeof UserAliasResponse>;

export const UserAliasesResponse = z.array(UserNameAlias);
export type UserAliasesResponse = z.infer<typeof UserAliasesResponse>;

export const RetroSeedResponse = z.object({
  sprint_id: LocalId,
  candidates: z.array(RetroSeedCandidate),
});
export type RetroSeedResponse = z.infer<typeof RetroSeedResponse>;

export const RetroPreviewResponse = z.object({
  sprint_id: LocalId,
  start_date: IsoDate,
  items: z.array(RetroSeedCandidate),
});
export type RetroPreviewResponse = z.infer<typeof RetroPreviewResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Sprint items  (GET /:id/items, POST /:id/items, DELETE /:id/items/:wpId)
// ─────────────────────────────────────────────────────────────────────────────
/** GET /api/sprints/:id/items — the items belonging to ONE sprint (incl. removed). */
export const SprintItemsResponse = z.array(SprintItem);
export type SprintItemsResponse = z.infer<typeof SprintItemsResponse>;

/**
 * GET /api/sprints/:id/items/detailed (SPEC_07 §5) — sprint_item rows ENRICHED
 * with their ticket's display fields, sourced DIRECTLY from work_package_cache
 * (falling back to the frozen ticket_baseline snapshot for an active/closed
 * sprint whose cache row is gone) — deliberately NOT the dismissal-filtered
 * GET /api/backlog list. A backlog dismissal (or, for a planning sprint, the
 * ticket's cache row disappearing entirely) must never make an item vanish
 * from a sprint that already committed to it; `no_longer_in_backlog` surfaces
 * that fact as a badge instead. An active/closed sprint's roster is otherwise
 * immutable with respect to backlog-side changes — this endpoint is what
 * makes that guarantee hold on screen, not just in the database.
 */
export const SprintItemDetail = BacklogItem.extend({
  sprint_item_id: LocalId,
  outcome: SprintItemOutcome,
  origin: SprintItemOrigin,
  planned_hours: z.number().nullable(),
  added_at: IsoDateTime,
  removed_at: IsoDateTime.nullable(),
  /** True when this ticket is no longer present in the live backlog (locally
   * dismissed, or its cache row is gone) — shown as a badge, never used to
   * drop the item from the list. */
  no_longer_in_backlog: z.boolean(),
  /**
   * Increment 9 (SPEC_09 §2): true when this ticket has at least one
   * ticket_changelog_entry row for this sprint. Drives the History button —
   * render it ONLY when true, so it's never shown just to open on "No
   * history yet." Compute with ONE `ticketChangelog.listBySprint(id)` call
   * (already exists) turned into a `Set<wp_op_id>`, not a per-item query —
   * this route already builds several such maps from batched fetches, follow
   * the same shape.
   */
  has_history: z.boolean(),
  /**
   * Increment 18 (SPEC_18 §3): the SAME role-aware done-matrix classification
   * used by Closure (`classifyWithRole`, SPEC_14 §2) — computed from the
   * ticket's CURRENT status + CURRENT holder's role, via the shared
   * `buildMemberIndex`/`roleForHolder`/`classifyWithRole` functions in
   * `apps/api/src/logic/doneRole.ts`. This is the ONE source of truth for
   * both the Closure "Done" bucket and sprint-list dimming — never a
   * separate, partial status list again.
   */
  done_bucket: TicketDoneBucket,
  /**
   * Derived: true when `done_bucket` is `"done"` OR `"rejected"` — SPEC_18 §2/§6
   * treats both as "no longer active work" and dims them, even though Closure
   * keeps them as separate buckets/counts. Drives the sprint-list dim class;
   * the frontend never re-derives this from status/role itself.
   */
  is_done: z.boolean(),
  /** The current holder's role, or null when genuinely unassigned. Same
   * resolution as `TicketClosureDetail.holder_role` (SPEC_14). */
  holder_role: PersonRole.nullable(),
  /** Set only when `done_bucket === "ambiguous"` — role-dependent status held
   * by a role-`unset` person. Powers the sprint-list "role?" indicator
   * (SPEC_18 §5/§6 #2: stays lit, never guessed). */
  ambiguous_reason: z.string().nullable(),
  /**
   * Increment 28 (INCREMENT_28_CONTRACTS §2a) — ancestor-aware double-count
   * detection, the ONE source of truth (the frontend must not recompute it).
   * wp_op_ids of items in THIS sprint that descend from this one, direct or
   * deeper. Non-empty → render the "Parent" badge. Always present (`[]` when
   * there is no collision, and for a removed item, which is out of scope).
   */
  double_count_children: z.array(OpId),
  /**
   * Increment 28 (§2a): wp_op_id of the NEAREST ancestor of this item that is
   * also in THIS sprint, else null. Non-null → render "Child of #<id>". The
   * chain is walked through `work_package_cache.parent_op_id`, so a grandparent
   * still links to a grandchild when the intermediate ticket is not in the
   * sprint. Never triggers an OpenProject call.
   */
  double_count_parent_of: OpId.nullable(),
  /** Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3): "sprint 2/3" badge —
   * this sprint's position among all sprints containing the wp; null when
   * single-sprint. NOTE: `MultiSprintBadge` is declared later in this file, so
   * the inline shape is repeated here (zod consts are order-sensitive). */
  multi_sprint: z
    .object({ sequence: z.number().int().positive(), total: z.number().int().positive() })
    .nullable(),
});
export type SprintItemDetail = z.infer<typeof SprintItemDetail>;
export const SprintItemsDetailedResponse = z.array(SprintItemDetail);
export type SprintItemsDetailedResponse = z.infer<typeof SprintItemsDetailedResponse>;

/**
 * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §5) — carry an unfinished ticket
 * from a (typically closed) sprint into a chosen open one. The source sprint is
 * never mutated; the target-side add reuses the existing planning-add /
 * mid-sprint-add paths, entering at the current estimate of record.
 */
export const CarrySprintItemBody = z.object({ target_sprint_id: LocalId });
export type CarrySprintItemBody = z.infer<typeof CarrySprintItemBody>;

export const CarrySprintItemResponse = z.object({
  carried: z.literal(true),
  target_sprint_id: LocalId,
  wp_op_id: OpId,
});
export type CarrySprintItemResponse = z.infer<typeof CarrySprintItemResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 28 (INCREMENT_28_CONTRACTS §2c) — one-click double-count fix
//   POST /api/sprints/:id/double-count/remove-parents
//   POST /api/sprints/:id/double-count/remove-children
// Both remove through the EXISTING removal semantics (DELETE /sprints/:id/
// items/:wpId): on an ACTIVE sprint that is `removed_mid_sprint`, so the row
// and its already-logged hours are kept per SPEC_05 — never a hard delete that
// loses history. Both are allowed in `planning` and `active` and answer 409
// `SPRINT_LOCKED` on a locked sprint (Increment 4 immutability).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional narrowing: when `wp_op_ids` is given, only those tickets are removed
 * — and only if they are actually flagged (parents / children respectively), so
 * the endpoint can never be used to remove an unrelated ticket. Omitted (or an
 * empty/absent body) → every flagged ticket of that side.
 */
export const DoubleCountFixBody = z.object({
  wp_op_ids: z.array(OpId).optional(),
});
export type DoubleCountFixBody = z.infer<typeof DoubleCountFixBody>;

/** The tickets actually removed + the sprint's items AFTER the removal, so the
 * client re-renders from one round-trip (it still bumps `refreshKey` per §1). */
export const DoubleCountFixResponse = z.object({
  removed_wp_op_ids: z.array(OpId),
  items: SprintItemsDetailedResponse,
});
export type DoubleCountFixResponse = z.infer<typeof DoubleCountFixResponse>;

export const AddSprintItemBody = z.object({
  wp_op_id: OpId,
  /** Override the snapshot estimate; defaults to effective estimate-of-record. */
  planned_hours: z.number().optional(),
});
export type AddSprintItemBody = z.infer<typeof AddSprintItemBody>;

/**
 * Increment 25 (SPEC_25 §3/§6) — POST /sprints/:id/items/by-id. Fetches the
 * work package DIRECTLY from OP by id, ignoring backlog/filters/version/
 * status entirely (a done/tested ticket that never surfaced in the backlog is
 * exactly the intended target). Distinct from AddSprintItemBody: no
 * `planned_hours` override (the estimate is always resolved fresh from the
 * live OP ticket, SPEC_25 §2 "remaining=0 → effectiveEstimate falls back to
 * Work"), and connection is explicit rather than inferred from a cached row.
 */
export const AddSprintItemByIdBody = z.object({
  wp_op_id: OpId,
  /** Omitted → the current connection (same default as every other
   * connection-optional endpoint, `requireOpClient()`). An explicit choice is
   * only meaningful when more than one connection is configured. */
  connection_id: LocalId.optional(),
});
export type AddSprintItemByIdBody = z.infer<typeof AddSprintItemByIdBody>;

export const AddSprintItemByIdResponse = SprintItem;
export type AddSprintItemByIdResponse = z.infer<typeof AddSprintItemByIdResponse>;

export const SprintItemParams = z.object({
  id: z.coerce.number().int().positive(),
  wpId: z.coerce.number().int().positive(),
});
export type SprintItemParams = z.infer<typeof SprintItemParams>;

export const SprintItemResponse = SprintItem;
export type SprintItemResponse = z.infer<typeof SprintItemResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/sprints/:id/capacity
// ─────────────────────────────────────────────────────────────────────────────
export const SetCapacityBody = z.object({
  capacity_mode: CapacityMode.optional(),
  members: z.array(
    z
      .object({
        /** Existing team member, OR identify by OP user id (auto-provisioned). */
        member_id: LocalId.optional(),
        op_user_id: OpId.optional(),
        /** Display name used when auto-provisioning a member from op_user_id. */
        name: z.string().optional(),
        available_hours: z.number(),
        pto_days: z.number().default(0),
      })
      .refine((m) => m.member_id != null || m.op_user_id != null, {
        message: "each capacity entry needs a member_id or op_user_id",
      }),
  ),
});
export type SetCapacityBody = z.infer<typeof SetCapacityBody>;

/** Per-assignee load vs capacity (SPEC §6: per assignee + aggregate). */
export const CapacityLine = z.object({
  member_id: LocalId.nullable(), // null = unassigned bucket
  op_user_id: OpId.nullable(),
  name: z.string(),
  available_hours: z.number(),
  planned_hours: z.number(),
  overloaded: z.boolean(),
  /**
   * True when this person is the assignee of a work package in the sprint (even a
   * 0-estimate one). Such a line can't be removed from capacity — it is re-derived
   * from the sprint items. A capacity-only person (no sprint work) is removable.
   */
  has_sprint_work: z.boolean(),
  /**
   * Increment 5 (SPEC_05 §2) scope-change segments for the stacked capacity
   * bar — all 0 for a sprint that's never been activated (nothing to diff
   * against yet; `planned_hours` alone is the live total exactly as before).
   * Bar segments the frontend derives: green = baseline_hours - removed_hours
   * (baseline still in scope), red = added_hours (stacked above green), blue
   * = removed_hours (the reduction). `planned_hours` stays the CURRENT total
   * committed (baseline + added - removed) for backward compatibility.
   */
  baseline_hours: z.number(),
  added_hours: z.number(),
  removed_hours: z.number(),
  /**
   * Increment 9 (SPEC_09 §3/§4/§8): grey redistribution segments, layered
   * INSIDE the existing baseline_hours (not a new committed-total component
   * for the sender — see `redistributed_in_hours` below for the receiver
   * side). Both 0 for a sprint whose baseline items were never reassigned or
   * completed, so the bar collapses to the pre-Increment-9 green/red/blue
   * shape unchanged.
   *
   * `redistributed_out_hours` ("grey sent"): Σ effective-hours of this
   * person's BASELINE items (origin="baseline", outcome NOT removed/
   * removed_mid_sprint — those are already fully accounted by
   * removed_hours) that are no longer "live green" — either done, or
   * reassigned to someone else. Bar-length-neutral: the frontend derives
   * green = baseline_hours - removed_hours - redistributed_out_hours, so
   * this person's bar stays exactly baseline_hours long (SPEC_09 §3's "bar
   * původního vlastníka zůstává stejně dlouhý").
   *
   * `redistributed_in_hours` ("grey received"): Σ effective-hours of OTHER
   * people's baseline items that are now assigned to THIS person (current
   * assignee != original assignee). Purely additive — may push this
   * person's line above their own baseline_hours/available_hours (SPEC_09
   * §4: intentional, a receiving line can be a person who owned nothing at
   * activation). Included in `planned_hours` (current committed total) so
   * the number and the overload flag both reflect it.
   */
  redistributed_out_hours: z.number(),
  redistributed_in_hours: z.number(),
  /**
   * Increment 13 (REVISED, SPEC_13 §1/§3): a retrospective-sprint line's
   * identity IS `name` — always present, always the thing hours/availability
   * key off. `op_user_id` is OPPORTUNISTIC enrichment (from a live
   * _links.assignee/accountable match, a memberships lookup, or a manual
   * `user_name_alias`) and is null whenever no OP account is known yet — this
   * is normal, NEVER blocks the line from existing, summing hours, or having
   * its availability edited. (There is no more separate "unresolved" bucket
   * distinct from a normal person line — `op_user_id === null` on an
   * otherwise-ordinary line IS that state.) Still distinct from the
   * pre-existing `member_id === null` UNASSIGNED bucket, which means a ticket
   * genuinely has no assignee at all, not "assignee known by name only."
   */
  /**
   * Increment 14 (SPEC_14 §2 consequence #1) — "capacity = Developers only".
   * `role` is this person's team_member.role ("unset" for the unassigned
   * bucket, which has no person). `is_developer` (role === "developer") is
   * pre-derived so the frontend never re-implements the check: a
   * non-developer line still APPEARS (so a tester/customer's committed hours
   * are visible as "grey" — work that left the developer's hands) but is
   * EXCLUDED from total_available_hours/total_planned_hours below and is not
   * availability-editable. Every pre-Increment-14 caller/fixture that never
   * set a role defaults to "developer" (`is_developer: true`) so existing
   * tests/behavior are unaffected.
   */
  role: PersonRole,
  is_developer: z.boolean(),
});
export type CapacityLine = z.infer<typeof CapacityLine>;

/**
 * Increment 9 (SPEC_09 §1/§4): a connection the sprint's current tickets need
 * that isn't usable right now — returned as the `details.connections` array
 * on an ACTIVATION_CONNECTIONS_UNAVAILABLE error, so the UI can offer a
 * Reconnect action per blocking server BEFORE the (now async) activation run
 * even starts.
 */
export const ActivationBlockingConnection = z.object({
  connection_id: LocalId,
  base_url: z.string(),
  label: z.string().nullable(),
  reason: z.enum(["disabled", "not_found", "vault_locked"]),
});
export type ActivationBlockingConnection = z.infer<typeof ActivationBlockingConnection>;

export const CapacityResponse = z.object({
  capacity_mode: CapacityMode,
  members: z.array(SprintMemberCapacity),
  /** Computed load per assignee incl. an "unassigned" line. */
  lines: z.array(CapacityLine),
  total_available_hours: z.number(),
  /** DEVELOPER-WORKLOAD total (Inc 14 §2 consequence #1: `is_developer` lines
   * + the unassigned bucket ONLY — a tester/customer holder's hours are
   * excluded). Used for the overload-vs-availability comparison; UNCHANGED by
   * Increment 16 — existing role-filtered semantics/tests still apply. This is
   * DELIBERATELY NOT the same number as `scope_planned_hours` below; do not
   * conflate the two. */
  total_planned_hours: z.number(),
  /**
   * Increment 5: the sprint's frozen baseline total (Sprint.baseline_total_hours,
   * mirrored here for convenience) — null before activation. The UI computes
   * the "+X / -Y" delta as total_planned_hours - baseline_total_hours.
   */
  baseline_total_hours: z.number().nullable(),
  /**
   * The Capacity panel HEADER's "Planned" number — REDEFINED in Increment 17
   * (SPEC_17 §2/§4a, superseding Increment 16's definition): now
   * `Σ per_developer[].planned_hours` (every developer's OWN Planned number,
   * itself `Σ estimate of their baseline_worked segments` — SPEC_17 §1,
   * Increment 26 merged `baseline_idle` into `baseline_worked`) computed via
   * the EXACT SAME shared `developerSegments`
   * pipeline `ClosureStatsResponse.total_planned_hours` uses, so the two
   * headers ALWAYS agree by construction, not by coincidence (SPEC_17 §4a
   * "jeden výpočet, čtyři plochy" — one computation feeds the Capacity panel,
   * the Closure card, the sprint Detail/report, AND the PDF). Deliberately
   * developer-scoped (a `handoff` ticket's estimate belongs to NEITHER the
   * sending nor the receiving developer's Planned — SPEC_17 §1 row c — so it
   * is correctly absent here too, unlike Increment 16's unconditional
   * "every surviving sprint_item regardless of holder" sum, which this
   * replaces). `total_planned_hours` above is UNCHANGED and stays a
   * genuinely DIFFERENT, narrower figure (Inc 14's role+leaf-filtered
   * per-line workload total) — do not conflate the two.
   */
  scope_planned_hours: z.number(),
  /**
   * Increment 17 (SPEC_17 §2/§4a) — the Capacity panel HEADER's "Delivered"
   * number: `Σ per_developer[].delivered_hours` (completed tickets credited to
   * a developer — baseline work finished, or acquired/handoff work finished,
   * by whoever logged the most on it — SPEC_15's DELIVERED tie-break,
   * unchanged). Computed via the SAME shared pipeline as `scope_planned_hours`
   * and `ClosureStatsResponse.total_delivered_hours` — always identical to
   * that field for the same sprint. Grows over time for a still-running
   * sprint. Explicitly NOT `scope_planned_hours + scope_change_hours-summed`
   * (a plausible-looking but WRONG combination a naive implementation might
   * reach for — SPEC_17 §2 "NE 'první+druhé'").
   */
  scope_delivered_hours: z.number(),
});
export type CapacityResponse = z.infer<typeof CapacityResponse>;

/**
 * Increment 13 (SPEC_13 §6) — GET /api/sprints/:id/capacity-audit: the trail
 * of capacity edits made AFTER a retrospective sprint left "planning" (the
 * only case that writes to it — see CapacityEditAuditEntry's own doc).
 */
export const CapacityAuditResponse = z.array(CapacityEditAuditEntry);
export type CapacityAuditResponse = z.infer<typeof CapacityAuditResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sprints/:id/burndown
// ─────────────────────────────────────────────────────────────────────────────
export const BurndownPoint = z.object({
  date: IsoDate,
  ideal_hours: z.number(),
  remaining_hours: z.number().nullable(), // null for future days
  logged_hours: z.number().nullable(),
  done_count: z.number().int().nullable(),
  total_count: z.number().int().nullable(),
  /** Increment 12 (SPEC_12 §1/§5) — null for a future/un-snapshotted day
   * (same days `remaining_hours`/`logged_hours` are null for). */
  source: BurndownSnapshotSource.nullable(),
});
export type BurndownPoint = z.infer<typeof BurndownPoint>;

export const BurndownResponse = z.object({
  sprint_id: LocalId,
  start_date: IsoDate,
  end_date: IsoDate,
  total_planned_hours: z.number(),
  points: z.array(BurndownPoint),
});
export type BurndownResponse = z.infer<typeof BurndownResponse>;

/** POST /sprints/:id/rebuild-burndown — recomputed burndown, same shape as
 * GET .../burndown (every point source="reconstructed" — SPEC_12 §5/§7). */
export const RebuildBurndownResponse = BurndownResponse;
export type RebuildBurndownResponse = z.infer<typeof RebuildBurndownResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sprints/:id/off-sprint-time (Increment 32, INCREMENT_32_CONTRACTS §4)
// "What are the developers ACTUALLY working on" — every roster developer's OP
// time logged OUTSIDE this sprint's own tickets, within its calendar window.
// Read-only aggregate of the `off_sprint_time_entry` rows a sprint update run
// wrote (§3); works with a locked vault (no OP call on this path).
// ─────────────────────────────────────────────────────────────────────────────
export const OffSprintTicketEntry = z.object({
  wp_op_id: OpId,
  /** From `_links.workPackage.title` — typically NOT a locally-imported
   * ticket (the whole point of this report), so null is normal, not an error. */
  subject: z.string().nullable(),
  hours: z.number(),
  connection_id: LocalId.nullable(),
});
export type OffSprintTicketEntry = z.infer<typeof OffSprintTicketEntry>;

export const OffSprintPersonEntry = z.object({
  op_user_id: OpId,
  /** Canonical display name (createPersonResolver, folded like every other
   * identity surface — IDENTITY_MODEL.md). */
  name: z.string(),
  total_hours: z.number(),
  tickets: z.array(OffSprintTicketEntry),
});
export type OffSprintPersonEntry = z.infer<typeof OffSprintPersonEntry>;

export const OffSprintTimeResponse = z.object({
  window: z.object({ from: IsoDate, to: IsoDate }),
  /** max(fetched_at) across the sprint's stored rows; null = never fetched
   * (e.g. a brand-new sprint that hasn't run an update pass yet). */
  fetched_at: IsoDateTime.nullable(),
  total_hours: z.number(),
  /** Sorted by total_hours desc, then name (§4). */
  per_person: z.array(OffSprintPersonEntry),
});
export type OffSprintTimeResponse = z.infer<typeof OffSprintTimeResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sprints/:id/velocity
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Increment 11 (SPEC_11 §9): one OP server's share of a closed sprint's
 * completed_hours, attributed by the DONE items' work_package_cache.connection_id.
 * A sprint with tickets from only one server still gets a single-entry array —
 * the frontend doesn't need to special-case "no breakdown".
 */
export const VelocityConnectionBreakdown = z.object({
  connection_id: LocalId,
  base_url: z.string(),
  label: z.string().nullable(),
  completed_hours: z.number(),
});
export type VelocityConnectionBreakdown = z.infer<typeof VelocityConnectionBreakdown>;

export const VelocityHistoryEntry = z.object({
  sprint_id: LocalId,
  name: z.string(),
  end_date: IsoDate,
  planned_hours: z.number(),
  completed_hours: z.number(),
  /** Per-server split of this sprint's completed_hours (SPEC_11 §9). */
  by_connection: z.array(VelocityConnectionBreakdown),
});
export type VelocityHistoryEntry = z.infer<typeof VelocityHistoryEntry>;

export const VelocityResponse = z.object({
  /** Most recent closed sprints, newest first. */
  history: z.array(VelocityHistoryEntry),
  /** Number of sprints averaged. */
  window: z.number().int(),
  average_completed_hours: z.number().nullable(),
  recommended_capacity_hours: z.number().nullable(),
});
export type VelocityResponse = z.infer<typeof VelocityResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sprints/:id/close  →  closure report
// GET  /api/sprints/:id/version-export  →  deep-link + ids
//
// Increment 11 (SPEC_11 §8a) FIX — /close is READ-ONLY w.r.t. sprint state:
// it computes + persists a fresh sprint_closure_report row (done/not_done/
// version_change) and returns it, but never touches sprint.status/is_locked/
// locked_at/lock_reason. It is safe to call repeatedly on an ACTIVE sprint
// ("View / regenerate closure report") — before this fix, /close always
// called the SAME lock-performing path finish() uses, so viewing a report
// silently locked a still-running sprint. POST /sprints/:id/finish remains
// the ONLY route that locks (final scoped update pass, THEN generates the
// same report via the shared computation, THEN sets is_locked=true,
// lock_reason="finished"). The response shape (ClosureReportResponse) is
// unchanged by this fix — only the side effects differ.
// ─────────────────────────────────────────────────────────────────────────────
/** One line in a closure report (serialized into sprint_closure_report.*_json). */
export const ClosureItem = z.object({
  wp_op_id: OpId,
  subject: z.string(),
  status_name: z.string(),
  assignee_name: z.string().nullable(),
  planned_hours: z.number().nullable(),
  remaining_hours: z.number().nullable(),
  version_name: z.string().nullable(),
});
export type ClosureItem = z.infer<typeof ClosureItem>;

export const ClosureReportResponse = z.object({
  sprint_id: LocalId,
  generated_at: z.string().datetime({ offset: true }),
  done: z.array(ClosureItem),
  not_done: z.array(ClosureItem),
  /** Candidates to move to a new version in OP (carried / not done). */
  version_change: z.array(ClosureItem),
});
export type ClosureReportResponse = z.infer<typeof ClosureReportResponse>;

export const VersionExportResponse = z.object({
  sprint_id: LocalId,
  /** WP ids to bulk-edit the version for. */
  wp_op_ids: z.array(OpId),
  /** Deep-link into the OP work-package table filtered on those ids (read-only). */
  deep_link: z.string().url(),
});
export type VersionExportResponse = z.infer<typeof VersionExportResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 4 (SPEC_04) — sprint lifecycle: activate / update / finish, and the
// per-ticket changelog. Full algorithm: apps/api/src/logic/sprintUpdate.ts.
//
// POST /api/sprints/:id/activate  — planning → active; captures ticket_baseline
//   for every current sprint item, writes the first burndown point. 409
//   SPRINT_NOT_PLANNING if not currently "planning" (idempotency guard).
// POST /api/sprints/:id/update    — scoped diff pass (manual "Update Sprint" or
//   scheduler). 409 SPRINT_NOT_ACTIVE if never activated; 409 SPRINT_LOCKED
//   once locked (this one is a hard error, unlike finish's idempotent return).
// POST /api/sprints/:id/finish    — final update pass + irreversible lock
//   (lock_reason="finished") + closure report, reusing the SAME closure logic
//   as the pre-existing POST /close. Calling finish on an ALREADY-locked sprint
//   is idempotent: returns the stored report, like /close already does.
// GET  /api/sprints/:id/updates   — history of update runs (activation/update/
//   final), newest first — drives the "last updated N ago, M changes" UI.
// GET  /api/sprints/:id/tickets/:wpId/changelog — one ticket's attributed
//   event history since the sprint's activation, oldest first.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Increment 9 (SPEC_09 §1): activation is now SCOPED + ASYNC (a background
 * job), so this no longer returns the (possibly not-yet-flipped) Sprint. It
 * returns the STARTED sprint_update_run (kind="activation", status
 * "running", total_count = the sprint's item count known immediately,
 * wp_count advancing as the background pass works through connections) —
 * the SAME shape SprintUpdateRunResponse already uses for "Update Sprint".
 * The frontend polls the existing GET /sprints/:id/updates (no new
 * endpoint) exactly like SprintControls.updateNow() already does; the
 * sprint's status only flips planning→active once the run finishes
 * successfully — a failed activation leaves the sprint in "planning",
 * retriable, never half-activated.
 */
export const ActivateSprintResponse = SprintUpdateRun;
export type ActivateSprintResponse = z.infer<typeof ActivateSprintResponse>;

export const UpdateSprintRunBody = z.object({
  /** Defaults to "manual" (a human clicked "Update Sprint"). */
  triggered_by: UpdateRunTriggeredBy.optional(),
});
export type UpdateSprintRunBody = z.infer<typeof UpdateSprintRunBody>;

export const SprintUpdateRunResponse = SprintUpdateRun;
export type SprintUpdateRunResponse = z.infer<typeof SprintUpdateRunResponse>;

export const SprintUpdateRunsResponse = z.array(SprintUpdateRun);
export type SprintUpdateRunsResponse = z.infer<typeof SprintUpdateRunsResponse>;

export const FinishSprintBody = z.object({
  triggered_by: UpdateRunTriggeredBy.optional(),
});
export type FinishSprintBody = z.infer<typeof FinishSprintBody>;

/**
 * Increment 11 (SPEC_11 §8b): POST /sprints/:id/reactivate — unlocks a
 * locked/closed sprint back to "active" (update/add/remove work again). Only
 * offered/allowed while today's date ∈ [sprint.start_date, sprint.end_date]
 * (inclusive) — the route throws 409 REACTIVATE_WINDOW_CLOSED outside that
 * window, and 409 SPRINT_NOT_LOCKED if the sprint isn't locked to begin with.
 * Always "manual" — a human confirms a yes/no modal — but triggered_by is
 * still accepted for consistency with the other run-audit endpoints and to
 * leave room for a future automated path. Recorded as a sprint_update_run
 * row (kind="reactivate", no scoped fetch) for audit (who/when); the report
 * itself only carries "when" — "who" is implicit (single-user app).
 */
export const ReactivateSprintBody = z.object({
  triggered_by: UpdateRunTriggeredBy.optional(),
});
export type ReactivateSprintBody = z.infer<typeof ReactivateSprintBody>;

export const ReactivateSprintResponse = Sprint;
export type ReactivateSprintResponse = z.infer<typeof ReactivateSprintResponse>;

/**
 * `detail_json` (TicketChangelogEntry), parsed — one variant per ChangelogKind.
 * Names/hours are display-ready; ids stay in the entry's own actor_op_id, not
 * here (assignee/accountable "who" is the CHANGELOG ENTRY's actor for that
 * specific transition only when it makes sense — see the algorithm doc; the
 * from/to pair below is always about the FIELD's value, not who changed it).
 */
export const ChangelogDetail = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time_logged"), hours: z.number(), spent_on: IsoDate }),
  z.object({ kind: z.literal("status_changed"), from: z.string(), to: z.string() }),
  z.object({
    kind: z.literal("assignee_changed"),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("accountable_changed"),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  /** Emitted ALONGSIDE status_changed when the new status isClosed=true. */
  z.object({ kind: z.literal("closed"), status: z.string() }),
  z.object({
    kind: z.literal("estimate_changed"),
    from: z.number().nullable(),
    to: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("remaining_changed"),
    from: z.number().nullable(),
    to: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("version_changed"),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  /** Escape hatch for a journal property the app doesn't map to a specific kind. */
  z.object({ kind: z.literal("other"), note: z.string() }),
  /**
   * Increment 10 (SPEC_10 §d): a non-empty comment on an OP activity —
   * content deliberately NOT stored (SPEC_10 §4 decision #3), just the fact.
   */
  z.object({ kind: z.literal("comment_added") }),
  // Increment 5 (SPEC_05 §3): local scope changes, source="local" (no OP journal).
  z.object({
    kind: z.literal("scope_added"),
    hours: z.number().nullable(),
    /** Increment 25 (SPEC_25 §4): present ONLY for a retroactive add — the
     * calendar day (YYYY-MM-DD) scope actually changed (sprint_item.added_at),
     * for the changelog's "(as of DD/MM/YYYY)" phrasing. Absent for an
     * ordinary mid-sprint add (occurred_at IS the scope-change day already). */
    backdated_to: IsoDate.optional(),
  }),
  z.object({
    kind: z.literal("scope_removed"),
    hours: z.number().nullable(),
    /** Hours already logged on this ticket at the moment of removal (SPEC_05 §1: kept in burndown). */
    logged_hours: z.number().nullable(),
  }),
]);
export type ChangelogDetail = z.infer<typeof ChangelogDetail>;

/** GET .../changelog element: TicketChangelogEntry with detail_json parsed. */
export const ChangelogEntryView = TicketChangelogEntry.omit({ detail_json: true }).extend({
  detail: ChangelogDetail,
});
export type ChangelogEntryView = z.infer<typeof ChangelogEntryView>;

export const TicketChangelogParams = z.object({
  id: z.coerce.number().int().positive(),
  wpId: z.coerce.number().int().positive(),
});
export type TicketChangelogParams = z.infer<typeof TicketChangelogParams>;

export const TicketChangelogResponse = z.array(ChangelogEntryView);
export type TicketChangelogResponse = z.infer<typeof TicketChangelogResponse>;
// (Increment 14 SPEC_14 §1: default newest-first + a toggle is purely a
// FRONTEND display concern — this endpoint keeps returning oldest-first, as
// today; no contract change needed for the ordering itself.)

// ─────────────────────────────────────────────────────────────────────────────
// Increment 14 (SPEC_14 §2) — GET/PUT /api/people, GET/PUT /api/done-rules
// ─────────────────────────────────────────────────────────────────────────────
/** GET /api/people — every person (team_member) seen in tickets/journals,
 * with a role and how many tickets they currently hold (live sprint items +
 * baselines they're the holder of — Agent B picks the exact count query;
 * used only for the Settings→People "X people without a role affect Y
 * tickets" counter and the per-row display, not for any done-matrix math). */
export const PersonSummary = TeamMember.extend({
  ticket_count: z.number().int(),
});
export type PersonSummary = z.infer<typeof PersonSummary>;

export const PeopleResponse = z.array(PersonSummary);
export type PeopleResponse = z.infer<typeof PeopleResponse>;

export const PersonIdParams = z.object({ id: z.coerce.number().int().positive() });
export type PersonIdParams = z.infer<typeof PersonIdParams>;

export const SetPersonRoleBody = z.object({ role: PersonRole });
export type SetPersonRoleBody = z.infer<typeof SetPersonRoleBody>;

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §3) — GET/PUT /api/config: the
 * app-level settings singleton (`report_config` row). `freeze_grace_days` is the
 * post-finish grace period (days, anchored at `locked_at`) before the freeze
 * sweep makes a finished sprint locally immutable; 0 = freeze at the first
 * sweep after finish.
 */
export const AppConfigResponse = z.object({
  overshoot_threshold_pct: z.number(),
  freeze_grace_days: z.number().int().min(0).max(60),
});
export type AppConfigResponse = z.infer<typeof AppConfigResponse>;

export const UpdateAppConfigBody = z
  .object({
    overshoot_threshold_pct: z.number().positive().optional(),
    freeze_grace_days: z.number().int().min(0).max(60).optional(),
  })
  .refine((b) => b.overshoot_threshold_pct !== undefined || b.freeze_grace_days !== undefined, {
    message: "at least one field is required",
  });
export type UpdateAppConfigBody = z.infer<typeof UpdateAppConfigBody>;

/** GET /api/done-rules — the global role-aware done matrix (seeded from
 * DEFAULT_DONE_RULES in @osp/contracts/common, editable via PUT). */
export const DoneRulesResponse = z.array(DoneRule);
export type DoneRulesResponse = z.infer<typeof DoneRulesResponse>;

export const UpdateDoneRulesBody = z.object({
  rules: z.array(z.object({ status_name: z.string(), kind: DoneRuleKind })),
});
export type UpdateDoneRulesBody = z.infer<typeof UpdateDoneRulesBody>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 14 (SPEC_14 §2/§3) — GET /api/sprints/:id/closure-stats
//
// Distinct from — and additive to — the existing ClosureReportResponse
// (done/not_done/version_change) above: that older split is driven by the
// per-sprint done_status_rule (DoneCountsAs: done|rejected, status alone) and
// keeps powering /close, /finish, and the version-export deep-link UNCHANGED.
// ClosureStatsResponse is the NEW role-aware view (done_rule, global,
// always_done|role_dependent|rejected) that powers the Reports/Detail screen
// and the closure buckets UI. Both coexist; nothing about the old one moves.
// ─────────────────────────────────────────────────────────────────────────────
/** One ticket's role-aware done classification (SPEC_14 §2 matrix) + why. */
export const TicketClosureDetail = z.object({
  wp_op_id: OpId,
  subject: z.string(),
  status_name: z.string(),
  /** The ticket's current holder (assignee) — null when genuinely unassigned. */
  holder_name: z.string().nullable(),
  holder_op_user_id: OpId.nullable(),
  /** Null when holder_name is null (nothing to look a role up for). */
  holder_role: PersonRole.nullable(),
  bucket: TicketDoneBucket,
  /** Set only when bucket === "ambiguous" (SPEC_14 §2: "role není nastavena pro X"). */
  ambiguous_reason: z.string().nullable(),
  /** Set only for the "in progress + unassigned" case (SPEC_14 §2/§7 #1) — a
   * state that shouldn't occur; surfaced, never silently swallowed. */
  anomaly: z.enum(["unassigned_in_progress"]).nullable(),
});
export type TicketClosureDetail = z.infer<typeof TicketClosureDetail>;

const ClosureBucket = z.object({
  count: z.number().int(),
  items: z.array(TicketClosureDetail),
});

/** Per ticket: estimate vs. dev-logged vs. total-logged (SPEC_14 §3). Only
 * done tickets get a non-null accuracy-relevant delta; not-done tickets still
 * appear here with delta/overshoot_flag null ("zatím spáleno", not accuracy —
 * see estimate_hours/dev_logged_hours which are always populated). */
/** Increment 34 (docs/INCREMENT_34_CONTRACTS.md §3) — this sprint's 1-based
 * position among ALL sprints containing the wp (ordered by start_date, then
 * id; any outcome except `removed`); null when the ticket is single-sprint. */
export const MultiSprintBadge = z.object({
  sequence: z.number().int().positive(),
  total: z.number().int().positive(),
});
export type MultiSprintBadge = z.infer<typeof MultiSprintBadge>;

/**
 * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §2; CAPACITY_BAR_RULES §5c) —
 * one side of the scope-origin split. `estimate_hours` = Σ planned_hours
 * (frozen at plan/add time, null rows contribute 0 but still count);
 * `dev_logged_hours` = Σ per-ticket calendar-window dev-logged (THIS sprint's
 * window, not the Increment-34 cumulative figure).
 */
export const ScopeOriginGroup = z.object({
  ticket_count: z.number(),
  estimate_hours: z.number(),
  dev_logged_hours: z.number(),
});
export type ScopeOriginGroup = z.infer<typeof ScopeOriginGroup>;

export const TicketEstimateLine = z.object({
  wp_op_id: OpId,
  subject: z.string(),
  bucket: TicketDoneBucket,
  /** Increment 35 (§2): the sprint_item row's origin, so the per-ticket table
   * can badge rows that arrived during the sprint. */
  origin: SprintItemOrigin,
  estimate_hours: z.number().nullable(),
  dev_logged_hours: z.number(),
  total_logged_hours: z.number(),
  /** Increment 34 (§2, invariant 12): Σ calendar-window dev-logged rows over
   * EVERY sprint the ticket is a member of — equals dev_logged_hours for a
   * single-sprint ticket. `delta_hours`/`overshoot_flag` of a DONE ticket
   * measure against THIS, not the single window. */
  cumulative_dev_logged_hours: z.number(),
  /** cumulative_dev_logged_hours - estimate_hours (Increment 34 §2); null when
   * not done or no estimate. */
  delta_hours: z.number().nullable(),
  /** delta_hours / estimate_hours > overshoot_threshold_pct/100; null when delta_hours is null. */
  overshoot_flag: z.boolean().nullable(),
  /** Increment 34 (§3): "sprint 2/3" badge data; null = single-sprint. */
  multi_sprint: MultiSprintBadge.nullable(),
  /** Increment 40 (§3): the ticket's OP project via `resolveProjectRef` —
   * frozen snapshot for a frozen sprint. Display-only; never affects numbers. */
  project_op_id: OpId.nullable(),
  project_name: z.string().nullable(),
  project_identifier: z.string().nullable(),
});
export type TicketEstimateLine = z.infer<typeof TicketEstimateLine>;

/** Per-developer rollup (SPEC_14 §3 table) — Developers ONLY (consequence #1;
 * a tester/customer's logged time is visible only in total_logged_hours /
 * dev_logged_hours on the parent ClosureStatsResponse, never broken out per
 * person here). */
export const DeveloperClosureBreakdown = z.object({
  member_id: LocalId.nullable(),
  op_user_id: OpId.nullable(),
  name: z.string(),
  /** Baseline estimate of tickets they held at activation. */
  planned_hours: z.number(),
  /** THEIR OWN time entries — attributed by who logged, not by assignee. */
  logged_hours: z.number(),
  /** Estimate-sum of tickets they delivered (bucket === "done"). */
  delivered_estimate_hours: z.number(),
  /** logged_hours / delivered_estimate_hours over DONE tickets only; null
   * when delivered_estimate_hours is 0 (nothing done yet to score). */
  accuracy_pct: z.number().nullable(),
  overshoot_hours: z.number(),
});
export type DeveloperClosureBreakdown = z.infer<typeof DeveloperClosureBreakdown>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 15 (SPEC_15) — developer capacity bar driven by REAL work.
//
// SUPERSEDES the buggy per-developer rollup above. Two problems the old
// DeveloperClosureBreakdown had (SPEC_15 §1/§3):
//   1. PLANNED/DELIVERED came from the START-DATE otisk only — a developer who
//      received tickets mid-sprint and actually logged time on them showed an
//      EMPTY bar and PLANNED 0 (the "Jan Belka 19h → 0h" bug).
//   2. DELIVERED was attributed to the CURRENT holder — so a ticket a developer
//      built and handed to a tester/customer credited DELIVERED to the tester
//      (accuracy "—"), not the developer who did the work.
//
// ROLLOUT DECISION (documented, non-breaking): DeveloperCapacityBreakdown is a
// strict SUPERSET of DeveloperClosureBreakdown — it keeps every existing field
// (so report.ts / ClosureStats.tsx / fixtures compile unchanged) and ADDS
// `delivered_hours` (the correctly max-logged-attributed number) + `segments`.
// The pre-existing `delivered_estimate_hours` is RETAINED as a DEPRECATED alias
// whose VALUE is now the same corrected figure as `delivered_hours` (the bug
// was in the engine's attribution, not the field's meaning), so old readers get
// the fix for free while new code migrates to the clearer `delivered_hours` +
// `segments`. `ClosureStatsResponse.per_developer` switches to this type; the
// old `DeveloperClosureBreakdown` schema stays exported but unused by the
// response (Phase 1 may retire it once every reader has migrated).
//
// SURFACE: no new endpoint. Both the per-developer capacity BARS and the
// closure per-developer TABLE read from GET /api/sprints/:id/closure-stats
// (already READ-ONLY, already works for active AND closed sprints from stored
// data alone). `segments` rides along on each per_developer entry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE row of a developer's capacity bar — a single (developer × ticket) pair,
 * classified into a DeveloperSegmentKind by the SPEC_17 §1 table (v2). The
 * same ticket may appear as a segment on MORE THAN ONE developer's bar (e.g.
 * a handoff sender AND the receiving developer who logged time both carry a
 * segment for it — `handoff` for the sender, `acquired` for the receiver);
 * DELIVERED de-dup happens at the per-developer `delivered_hours` level,
 * never here.
 */
export const DeveloperTicketSegment = z.object({
  wp_op_id: OpId,
  subject: z.string(),
  kind: DeveloperSegmentKind,
  /**
   * Bar LENGTH = the ticket's estimate (never the logged time — "délka baru =
   * odhad, marker = realita"). For an `acquired` (row e) segment this is the
   * estimate AT THE MOMENT OF ACQUISITION (reconstructed, fallback current).
   * For baseline rows it's the item's frozen planned_hours. Null when the
   * ticket genuinely has no estimate (renderer draws a zero-length bar; the
   * logged marker can still extend past it).
   */
  estimate_hours: z.number().nullable(),
  /**
   * THIS developer's OWN logged hours on this ticket (attribution by who
   * logged, never by assignee — Increment 14). Drives the logged marker on
   * `baseline_worked`/`acquired` segments; on other kinds it is informational
   * (typically 0, but not required to be).
   */
  logged_hours: z.number(),
  /** True for kinds that move Planned (bar number 1) — `baseline_worked` ONLY
   * (row a; Increment 26 merged the former `baseline_idle` row b into it).
   * == (SEGMENT_PLANNED_CONTRIBUTION[kind] === 1). ALWAYS a non-negative
   * contribution (SPEC_17 §1/§4 BUG 2 fix — nothing that counts_to_planned
   * ever subtracts). */
  counts_to_planned: z.boolean(),
  /** SEGMENT_PLANNED_CONTRIBUTION[kind] × (estimate_hours ?? 0) — always >= 0.
   * Σ over a dev's segments = that developer's Planned (bar number 1). */
  planned_delta_hours: z.number(),
  /** True for kinds that move Change (bar number 2, signed) — `acquired`
   * (+, row e) or `removed` (−, row d) ONLY. == (SEGMENT_CHANGE_SIGN[kind]
   * !== 0). `handoff` (row c) is DELIBERATELY 0/false here — SPEC_17 §7 #1:
   * its estimate is credited on the RECEIVING developer's own `acquired`
   * segment instead, never subtracted from the sender's Change (that would
   * double-count the same hours in opposite directions across two bars). */
  counts_to_change: z.boolean(),
  /** SEGMENT_CHANGE_SIGN[kind] × (estimate_hours ?? 0) — signed: positive for
   * `acquired`, negative for `removed`, 0 otherwise. Σ over a dev's segments =
   * that developer's Change (bar number 2, SPEC_17 §1's "±Změna"). */
  change_delta_hours: z.number(),
  /** Pre-derived (kind ∈ SEGMENT_LOGGED_MARKER_KINDS) so Agent C never
   * re-implements the rule — true only for `baseline_worked`/`acquired`. */
  show_logged_marker: z.boolean(),
  /** True when this developer held the ticket at the sprint's baseline anchor
   * (start_date, or activated_at for a live sprint) — rows a-d. False for the
   * acquired/idle/churned rows e-g. */
  in_baseline: z.boolean(),
  /** Short human tooltip provenance, e.g. "developed and delivered",
   * "reassigned to another developer", "assigned, not yet worked". Null when
   * the kind alone is self-explanatory. */
  reason: z.string().nullable(),
  /** The ticket's CURRENT holder (for `handoff`/`idle`/`churned` tooltips:
   * who it went to / who still sits on it). Null when genuinely unassigned. */
  current_holder_name: z.string().nullable(),
  /** The current holder's role — lets the tooltip say "another developer"
   * (handoff, row c) vs "tester/customer" (rows d/g). Null when unassigned. */
  current_holder_role: PersonRole.nullable(),
});
export type DeveloperTicketSegment = z.infer<typeof DeveloperTicketSegment>;

/**
 * Per-developer rollup for Increment 15 (SPEC_15 §2/§3) — Developers ONLY
 * (role === "developer"; a tester/customer/other never appears here). Superset
 * of DeveloperClosureBreakdown (see the section header for the rollout call).
 *
 * The five headline numbers are GENUINELY DISTINCT (SPEC_15 §3 — "neplest"):
 *   • planned_hours   = Σ segments' planned_delta_hours (rows 1,2,5 add their
 *                       estimate; 3,4 subtract; 6,7 excluded). NEVER logged.
 *                       This REPLACES the old start-date-otisk PLANNED that read
 *                       0 for a mid-sprint receiver — hence overriding the
 *                       inherited `planned_hours` doc from the extended schema.
 *   • logged_hours    = this developer's total logged time in the sprint
 *                       (across all tickets, by logger).
 *   • delivered_hours = Σ estimate of the tickets this developer DELIVERED,
 *                       attributed by MAX LOGGED TIME (+ the §3 status-transition
 *                       tie-break), NOT by current holder. Each done ticket is
 *                       credited to at MOST ONE developer (dedupe).
 *   • accuracy_pct    = (this dev's logged hours ON their delivered tickets) /
 *                       delivered_hours × 100. NON-NULL whenever
 *                       delivered_hours > 0 (SPEC_15 §3 — a delivering developer
 *                       is never shown "—"). Overrides the inherited doc, which
 *                       keyed off the old delivered_estimate_hours.
 *   • overshoot_hours = (logged on delivered) − delivered_hours (may be > or <
 *                       0; e.g. Zbynek 46.5 logged − 30 estimate = +16.5).
 *
 * `delivered_estimate_hours` (inherited) is a DEPRECATED alias — set equal to
 * `delivered_hours`. New code reads `delivered_hours`.
 */
export const DeveloperCapacityBreakdown = DeveloperClosureBreakdown.extend({
  /**
   * ⚠️ REDEFINED in Increment 30 (`docs/CAPACITY_BAR_RULES.md` §5, rewritten in
   * that same change; `docs/INCREMENT_30_CONTRACTS.md` §2) — **Planned is now
   * CURRENT SCOPE**, not the baseline sum.
   *
   * = Σ `effectiveEstimate` over the tickets **currently in the sprint and
   * currently assigned to this developer**, whatever colour their segments are.
   * A removal, an addition or a handoff moves it immediately. In segment terms
   * the contributing kinds are `baseline_worked` + `acquired` + `idle`
   * (§2a's table); `handoff`/`removed`/`churned` contribute 0 because the
   * ticket is no longer this developer's current scope.
   *
   * Why it changed: the previous definition (Σ `baseline_worked` only) answered
   * "what were they signed up for at activation?", while the Capacity panel's
   * own per-person line had always shown "what are they on the hook for now?".
   * Those diverge as soon as anything moves post-activation — the reported case
   * read 32 h on one surface and 10 h on the other. Current scope won.
   *
   * This is computed ONCE (the canonical `computeCapacity` rule) and read by
   * Capacity, Closure, Sprint detail and the PDF — never recomputed per
   * surface (`CAPACITY_BAR_RULES.md` §0). Still ALWAYS >= 0: nothing subtracts
   * from this field; scope lost is reported via `scope_change_hours`, which is
   * what let a developer's Planned go negative back in v1 ("Jan Bílý −8h").
   *
   * ⚠️ NEVER add this to `scope_change_hours` — Planned already contains every
   * post-activation movement, so the sum would double-count added work
   * (`CAPACITY_BAR_RULES.md` §6 invariant 9). The composition that balances is
   * `baseline_hours + scope_change_hours`.
   */
  planned_hours: z.number(),
  /**
   * Increment 38 (`docs/CAPACITY_BAR_RULES.md` §5) — what this developer was
   * SIGNED UP FOR at the most recent Activate: Σ of the activation-time
   * estimate (`baseline_commit_hours`, frozen in `ticket_baseline`) over every
   * baseline ticket they held at the activation anchor — INCLUDING tickets
   * later handed off (`handoff`, or passed on to a tester), dropped
   * (`removed`) or taken out of the sprint (`removed_mid_sprint`). It never
   * moves during the sprint: later reassignments move Planned, later
   * re-estimates move the bar lengths, neither moves Baseline.
   *
   * Replaces Increment 30's "Σ estimate of RETAINED `baseline_worked`
   * segments" — that made a developer whose baseline was entirely handed on
   * read Baseline 0 (the Cameron Dalby case: 87 h at Activate, shown as
   * 4 h). In a PLANNING sprint there is no activation yet, so it stays the
   * live Σ of the green segments (== Planned).
   */
  baseline_hours: z.number(),
  /** Correctly max-logged-attributed DELIVERED estimate sum (see doc above).
   * `delivered_estimate_hours` is kept as a deprecated alias with the SAME value. */
  delivered_hours: z.number(),
  /** Every (this-developer × ticket) segment feeding the capacity bar, one per
   * SPEC_17 §1 row (a-g). Ordered by the engine (recommend: baseline rows
   * first, then acquired, then informative) — Agent C renders in array order. */
  segments: z.array(DeveloperTicketSegment),
  /**
   * The bar's SECOND number ("±Změna", SPEC_17 §1) — SIGNED:
   * Σ estimate_hours(`acquired`) − Σ estimate_hours(`removed`). Positive = net
   * scope gained (mid-sprint work taken on from ANY source — a fresh add OR a
   * dev→dev handoff — and actually logged, BUG 1 fix), negative = net scope
   * lost (baseline work dropped/removed with zero work done by this dev),
   * 0 = no net change. `handoff` (row c — handed to ANOTHER developer) is
   * DELIBERATELY EXCLUDED here (SPEC_17 §1/§7 #1): the ticket's estimate is
   * credited on the RECEIVING developer's own `acquired` segment instead (if
   * they log time on it), so subtracting it here too would double-count the
   * same hours in opposite directions across two bars — a sender's Change is
   * simply UNAFFECTED by a handoff, it's neither a gain nor a loss for THIS
   * number (Delivered's own max-logged attribution is what tracks who gets
   * credit for FINISHING it). `idle`/`churned` (rows f/g) are also excluded
   * (sign 0, purely informative, never affected this dev's Planned or Change).
   * The bar's THIRD number ("Kapacita"/capacity) is NOT here — it's the
   * separate CapacityLine.available_hours for this person.
   */
  scope_change_hours: z.number(),
});
export type DeveloperCapacityBreakdown = z.infer<typeof DeveloperCapacityBreakdown>;

/**
 * Increment 15 (SPEC_15 §5) — a single point-in-time-generalized ASSIGNEE
 * INTERVAL for ONE ticket: who held it, from when, to when. This is the shape
 * Agent A's changelog-folding function must PRODUCE (op-client), and Agent B's
 * developerSegments engine CONSUMES. It generalizes reconstruct.ts's
 * `stateAtDate` (a single snapshot) into the full timeline needed to answer
 * "was dev X the holder at the baseline anchor?" and "who held it at the
 * dev-done status transition?" (the DELIVERED tie-break).
 *
 * Semantics (mirror stateAtDate exactly — SPEC_15 §5):
 *   • Identity is the NAME (Increment 13) — journals carry a display name, not
 *     an id. `holder_op_user_id`/`holder_role` are OPPORTUNISTIC enrichment
 *     (resolved from team_member/alias by the producer OR left null for the
 *     consumer to resolve); never a precondition.
 *   • `from` = the interval's start (ISO datetime): the anchor date for the
 *     baseline interval, or the assignee_changed event's occurred_at for a
 *     later one, or the ticket's creation time when it was created AFTER the
 *     anchor (not_yet_created — no baseline interval then).
 *   • `to` = null for the OPEN, current interval; otherwise the next
 *     assignee_changed event's occurred_at.
 *   • A "cleared"/unassigned interval is represented with holder_name = null
 *     (a real observed state, not a gap — same as stateAtDate's `to: null`).
 */
export const AssigneeInterval = z.object({
  wp_op_id: OpId,
  /** OP user id when known (enrichment); null when only the name is known. */
  holder_op_user_id: OpId.nullable(),
  /** Display name (the identity). Null for an explicitly-unassigned interval. */
  holder_name: z.string().nullable(),
  /** Opportunistic team_member.role of the holder; null when unresolved/unassigned. */
  holder_role: PersonRole.nullable(),
  /** ISO datetime the holder took the ticket (see semantics above). */
  from: IsoDateTime,
  /** ISO datetime they lost it, or null for the currently-open interval. */
  to: IsoDateTime.nullable(),
});
export type AssigneeInterval = z.infer<typeof AssigneeInterval>;

/**
 * Increment 15 (SPEC_15 §6) — the INPUT contract for the pure
 * `developerSegments(input): DeveloperCapacityBreakdown[]` engine (Agent B,
 * apps/api/src/logic). A type-level contract, not runtime-validated: it names
 * exactly what Agent A must hand over and what Agent B may assume. Output is
 * `DeveloperCapacityBreakdown[]`, one per person, ROLE-GATED to
 * role === "developer" (SPEC_15 §2/§5). All inputs are already-synced LOCAL
 * data — NO OP call, NO `GET /api/v3/users` (SPEC_15 §5/§7).
 */
export interface DeveloperSegmentsTicketInput {
  wp_op_id: number;
  subject: string;
  /** The OP connection this ticket was cached from (work_package_cache.
   * connection_id), or null when unknown. Scopes every interval-holder
   * personKey so the same numeric op_user_id on two different servers never
   * folds into one identity (Increment-23 cross-server-collision class). */
  connection_id?: number | null;
  /** The estimate-of-record (sprint_item.planned_hours / frozen baseline). */
  estimate_hours: number | null;
  /** Estimate reconstructed at each holder's acquisition instant, keyed by the
   * interval's `from` ISO — for Row 5's "estimate at moment of acquisition"
   * (fallback estimate_hours). Empty/absent → use estimate_hours. */
  estimate_at_acquisition?: Record<string, number | null>;
  /** True when this ticket was in the sprint's baseline set (origin
   * "baseline") vs added/acquired mid-sprint — mirrors ticket_baseline.origin. */
  in_baseline_scope: boolean;
  /**
   * Increment 38 — the estimate this ticket carried AT ACTIVATION (frozen
   * `ticket_baseline` snapshot, override-aware; a retro sprint's reconstructed
   * `planned_hours`). Feeds the baseline holder's `baseline_hours` (and the
   * `removed` segment's −Change) so Baseline = "what they were signed up for at
   * the last Activate" regardless of later re-estimates. Omitted → falls back
   * to `estimate_hours` (pre-Increment-38 callers/tests unchanged).
   */
  baseline_commit_hours?: number | null;
  /**
   * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §1) — the burned-remaining
   * Delivered inputs. `remaining_start_hours` = ticket_baseline.remaining at
   * activation; `remaining_end_hours` = current remaining (live, or the frozen
   * snapshot). BOTH optional: an omitted pair behaves as
   * `remStart = estimate, remEnd = done ? 0 : remStart`, which reproduces the
   * pre-Increment-34 Delivered exactly (invariant 11's reduction) — so every
   * older caller/unit test keeps its meaning without edits.
   */
  remaining_start_hours?: number | null;
  remaining_end_hours?: number | null;
  /** The ticket's role-aware done bucket (from classifyWithRole) — a "done"
   * ticket is a DELIVERED candidate (SPEC_15 §3). */
  done_bucket: TicketDoneBucket;
  /** Full assignee timeline (Agent A), oldest first. */
  assignee_intervals: AssigneeInterval[];
  /** Chronological status transitions {from,to,at} for the DELIVERED tie-break
   * (folded from ticket_changelog_entry status_changed rows). */
  status_transitions: Array<{ from: string | null; to: string; at: string }>;
  /** Developer-logged hours on THIS ticket, keyed by developer personKey
   * (op_user_id-or-name, whatever the engine keys people by). Non-developer
   * loggers are excluded upstream. */
  logged_by_developer: Record<string, number>;
  /** Earliest time-entry spentOn per developer personKey — final tie-break
   * input for DELIVERED (SPEC_15 §3 fallback). */
  first_logged_at_by_developer?: Record<string, string>;
}

export interface DeveloperSegmentsInput {
  /** The baseline anchor: sprint.start_date for a retro sprint, else the
   * activation moment (activated_at). Holder-at-anchor = baseline holder. */
  baseline_anchor: string;
  tickets: DeveloperSegmentsTicketInput[];
  /** person role lookup by personKey → PersonRole ("unset"/absent → non-dev,
   * excluded from output). Also used to resolve interval holder_role. */
  role_by_person: Record<string, PersonRole>;
  /** Display name + optional op_user_id/member_id per personKey, for output
   * identity (SPEC_13 "person = name"). */
  person_meta: Record<
    string,
    { name: string; op_user_id: number | null; member_id: number | null }
  >;
  /** The live done_rule always_done status names for the tie-break (defaults to
   * DEV_DONE_TRANSITION_STATUSES when omitted). */
  dev_done_statuses?: readonly string[];
  /** Increment 24 (SPEC_24 §2/§3) — makes the engine state-aware. Omitted/
   * `"active"`/`"closed"` run the full SPEC_17 §1 a–g classification unchanged.
   * `"planning"` collapses it: a ticket's CURRENT developer holder gets a single
   * full-green `baseline_worked` segment sized at its estimate (no baseline
   * anchor, handoff, acquired, idle, or churned distinction exists before
   * activation — there is no baseline and no real logged work yet); a
   * non-developer holder gets nothing here (already correctly grey via the
   * plain role-based CapacityLine elsewhere). */
  sprint_status?: SprintStatus;
  /** Identity unification (golden tests `identity-golden*.test.ts`) — the ONE
   * canonical person-key resolution (`createPersonResolver().resolve(…).key`),
   * threaded in by closureStats so an interval HOLDER resolves through exactly
   * the same fold as loggers and current holders (id/name/connection variants
   * of one person land on one key). Omitted (pure engine unit tests) → the raw
   * `personKey` fallback, exactly as good as the inputs given. */
  resolve_key?: (
    connectionId: number | null,
    opUserId: number | null,
    name: string | null,
  ) => string | null;
  /**
   * Increment 38 — baseline tickets taken OUT of the sprint after activation
   * (`removed_mid_sprint`). They are not in `tickets` (nothing to paint — the
   * Capacity panel draws them from its own `removed_hours`), but they were
   * part of what their activation holder signed up for, so they count into
   * that developer's `baseline_hours` and subtract from `scope_change_hours`
   * (Baseline + ±Change keeps balancing). Omitted → none.
   */
  removed_baseline?: Array<{
    wp_op_id: number;
    connection_id?: number | null;
    holder_op_user_id: number | null;
    holder_name: string | null;
    commit_hours: number | null;
  }>;
}

export const ClosureStatsResponse = z.object({
  sprint_id: LocalId,
  generated_at: IsoDateTime,
  /**
   * ⚠️ REDEFINED AGAIN in Increment 30 (`docs/CAPACITY_BAR_RULES.md` §5 +
   * invariants 7–8): `Σ per_developer[].planned_hours` where each of those is
   * now **CURRENT SCOPE** (Σ `effectiveEstimate` of the tickets currently in
   * the sprint and currently assigned to that developer), not the retained
   * baseline. Developers only — non-developers are not plannable capacity
   * (`CAPACITY_BAR_RULES.md` §0), so a tester's or a customer's hours never
   * enter this total.
   *
   * A `handoff` ticket counts on the RECEIVER (it is their current scope) and
   * not on the sender — under the pre-Increment-30 definition it counted on
   * neither, which is why this total is no longer systematically smaller than
   * Increment 16's.
   *
   * **Invariant 8 — the header equals the sum of the rows displayed beneath
   * it.** A user must be able to reproduce this number by adding up the
   * developer rows they can see. Computed ONCE and shared with
   * `CapacityResponse`, the sprint Detail/report and the PDF — never
   * recomputed per surface.
   */
  total_planned_hours: z.number(),
  /**
   * Increment 30 — `Σ per_developer[].baseline_hours`, the aggregate of the
   * figure `total_planned_hours` used to be (Σ retained baseline). Kept as its
   * own labelled total because `scope_change_hours` is measured against it and
   * the burndown anchors on it. Developers only, like every aggregate here
   * (`CAPACITY_BAR_RULES.md` §0 — non-developers are not plannable capacity).
   *
   * ⚠️ `total_baseline_hours + Σ scope_change_hours` is the composition that
   * balances; `total_planned_hours + Σ scope_change_hours` double-counts
   * (invariant 9).
   */
  total_baseline_hours: z.number(),
  /** Σ `per_developer[].delivered_hours`. Displayed BETWEEN `total_planned_hours`
   * and `total_logged_hours` (Planned / Delivered / Logged (all) / Logged
   * (Developers) / Estimate effectivity / Overshoot). For a still-RUNNING
   * sprint this grows over time as work is delivered — it is NOT a
   * final/frozen figure the way `total_planned_hours` is. Identical, by
   * construction, to `CapacityResponse.scope_delivered_hours` and the
   * Delivered figure in the sprint Detail/report and the PDF. */
  total_delivered_hours: z.number(),
  total_logged_hours: z.number(),
  /** Σ logged_hours of Developer-role loggers only (SPEC_14 §2 consequence #3). */
  dev_logged_hours: z.number(),
  done: ClosureBucket,
  not_done: ClosureBucket,
  rejected: ClosureBucket,
  /** Role-`unset`-holder tickets — NEVER counted into done or not_done. */
  ambiguous: ClosureBucket,
  /** Subset of not_done/ambiguous items flagged anomaly !== null — surfaced
   * separately too so the UI can call it out without scanning every bucket. */
  anomalies: z.array(TicketClosureDetail),
  /** Σ dev_logged_hours / Σ estimate_hours over DONE tickets only; null when
   * no done ticket has both a dev-logged hour and an estimate yet. */
  estimate_accuracy_pct: z.number().nullable(),
  /** Σ (dev_logged_hours - estimate_hours) over DONE tickets, clamped to ≥ 0. */
  overshoot_hours: z.number(),
  /** Echoed from report_config so the UI can show what threshold flagged a row. */
  overshoot_threshold_pct: z.number(),
  /** Increment 15 (SPEC_15): now DeveloperCapacityBreakdown (superset of the
   * old DeveloperClosureBreakdown) — carries corrected `delivered_hours` +
   * capacity-bar `segments`. Both the per-developer BARS and the closure TABLE
   * read from here. */
  per_developer: z.array(DeveloperCapacityBreakdown),
  per_ticket: z.array(TicketEstimateLine),
  /**
   * Increment 33 (docs/INCREMENT_33_CONTRACTS.md §1) — the off-sprint logged
   * time report, folded into Closure/Reports/PDF. STRICTLY SEPARATE from every
   * sprint metric above: nothing here is ever added into Planned / Delivered /
   * Logged / burndown (pinned by an invariant test). `share_pct` (user
   * decision 1a) = off / (off + sprint) × 100 — "X % of all developer time in
   * the sprint's calendar window went to tickets outside the sprint"; null
   * when both sides are 0. `sprint_logged_hours` is the comparison base:
   * Σ per_developer[].logged_hours (developer-scoped on BOTH sides, calendar
   * window on both sides — decision 1b).
   */
  off_sprint: z.object({
    total_hours: z.number(),
    sprint_logged_hours: z.number(),
    share_pct: z.number().nullable(),
    per_person: z.array(
      z.object({
        op_user_id: OpId.nullable(),
        name: z.string(),
        total_hours: z.number(),
        /** This person's off / (off + their sprint logged) × 100; null when 0/0. */
        share_pct: z.number().nullable(),
        tickets: z.array(OffSprintTicketEntry),
      }),
    ),
  }),
  /**
   * Increment 35 (docs/INCREMENT_35_CONTRACTS.md §2; CAPACITY_BAR_RULES §5c +
   * invariant 13) — the scope-origin split: what was planned/committed BEFORE
   * the Activate click (`baseline`) vs what arrived during the sprint
   * (`added` = origin added_mid_sprint OR added_retroactively). Purely
   * DERIVED from figures this response already carries — it feeds no other
   * number. Items with outcome `removed` (dropped in planning) are excluded;
   * `removed_mid_sprint` items stay in their origin group.
   */
  scope_origin: z.object({
    baseline: ScopeOriginGroup,
    added: ScopeOriginGroup,
    /** added.dev_logged / (baseline.dev_logged + added.dev_logged) × 100;
     * null when both are 0. */
    added_logged_share_pct: z.number().nullable(),
    /** added.estimate_hours / (Σ both groups' estimates) × 100; null when 0. */
    added_estimate_share_pct: z.number().nullable(),
  }),
});
export type ClosureStatsResponse = z.infer<typeof ClosureStatsResponse>;

// ─────────────────────────────────────────────────────────────────────────────
// Increment 14 (SPEC_14 §4) — GET /api/reports, GET /api/reports/:id,
// POST /api/reports/:id/pdf
//
// ⛔ Every route in this group is READ-ONLY w.r.t. sprint state (same
// "View ≠ lock" principle as SPEC_11 §8a's closure-report split, which the
// old /close route violates-if-you're-not-careful) — none of them may touch
// sprint.status/is_locked/locked_at/lock_reason, called on a closed sprint
// any number of times, including POST .../pdf.
// ─────────────────────────────────────────────────────────────────────────────
/** GET /api/reports — closed sprints only, newest-closed first. */
export const ClosedSprintSummary = z.object({
  sprint_id: LocalId,
  name: z.string(),
  start_date: IsoDate,
  end_date: IsoDate,
  closed_at: IsoDateTime.nullable(),
});
export type ClosedSprintSummary = z.infer<typeof ClosedSprintSummary>;

export const ReportsListResponse = z.array(ClosedSprintSummary);
export type ReportsListResponse = z.infer<typeof ReportsListResponse>;

export const ReportSprintParams = z.object({ id: z.coerce.number().int().positive() });
export type ReportSprintParams = z.infer<typeof ReportSprintParams>;

/** GET /api/reports/:id — everything the Detail screen's charts need,
 * reusing existing response shapes (BurndownResponse) rather than duplicating
 * them; works BACKWARDS from stored data alone (baseline, changelog,
 * snapshots, closure) — no live OP call. */
export const ReportDetailResponse = z.object({
  sprint: ClosedSprintSummary,
  stats: ClosureStatsResponse,
  burndown: BurndownResponse,
});
export type ReportDetailResponse = z.infer<typeof ReportDetailResponse>;

/**
 * POST /api/reports/:id/pdf — unlike every other endpoint in this file, the
 * response is NOT this JSON envelope: the route streams `application/pdf`
 * bytes directly (Content-Disposition: attachment). GeneratePdfResult below
 * is the internal return type of the logic function Agent B writes
 * (apps/api/src/logic/report.ts or similar) — the byte content plus the
 * exports/report-<sprint>-<timestamp>.pdf path it was ALSO written to
 * (SPEC_14 §4) — not a wire type. Documented here so Agent D's e2e assertions
 * on both the download and the on-disk file have one shared source of truth
 * for the filename shape.
 */
export const GeneratePdfResult = z.object({
  file_path: z.string(),
  generated_at: IsoDateTime,
});
export type GeneratePdfResult = z.infer<typeof GeneratePdfResult>;

/**
 * GET /api/version — which build is running. `version` is the root
 * package.json SemVer (the single source of truth, tagged `v<version>` in git);
 * `git_sha` comes from OSP_GIT_SHA (set at image build) or the local checkout;
 * `schema_migration` is the newest Drizzle migration this build ships.
 */
export const VersionResponse = z.object({
  version: z.string(),
  git_sha: z.string().nullable(),
  schema_migration: z.string().nullable(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;
