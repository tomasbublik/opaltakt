import type {
  ClosureReportResponse,
  LockReason,
  Sprint,
  SprintItemOrigin,
  SprintUpdateRun,
  UpdateRunTriggeredBy,
} from "@osp/contracts";
import { capacityEffectiveRole } from "@osp/contracts";
import type {
  OpActivity,
  OpClient,
  OpStatus,
  OpTimeEntry,
  OpWorkPackage,
} from "@osp/op-client";
import type { NewChangelogEntry, NewOffSprintTimeEntry, NewTicketBaseline, Repositories } from "@osp/db";
import type { SnapshotWriter } from "@osp/sync";
import { refreshProjectsBestEffort } from "./projectRefresh";
import {
  aggregateTimeEntries,
  registerSprintUpdateController,
  toWorkPackageCacheRow,
  unregisterSprintUpdateController,
} from "@osp/sync";
import {
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  deriveChangelogEvents,
  fetchActivitiesByWpIds,
  fetchAllTimeEntries,
  fetchAllWorkPackages,
  isOpCancelledError,
  OpCancelledError,
  OpHttpError,
  OpTimeoutError,
  parseIsoDuration,
  parseOpId,
  withHardCancel,
} from "@osp/op-client";
import type { SyncStatus } from "@osp/contracts";
import { AppError } from "../errors";
import { resolveNeededConnectionIds } from "./activationScope";
import { performClosure, readStoredClosureReport } from "./closure";
import { leafEffort } from "./doubleCounting";
import { effectiveEstimate } from "./estimate";
import {
  createUserNameResolver,
  unknownUserLabel,
  type UserNameResolver,
} from "./userNames";

/**
 * SPEC_04 — the sprint lifecycle + scoped-diff + changelog algorithm.
 * PHASE 0 STUB: interfaces + the algorithm are frozen here; Agent B (Update/
 * Changelog engine) implements the function bodies below. Nothing in this
 * file's SHAPE should change without updating the routes/scheduler that
 * depend on it (apps/api/src/routes/index.ts, apps/api/src/scheduler/*).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TERMINOLOGY
 * ─────────────────────────────────────────────────────────────────────────
 * "Scoped" = only the sprint's CURRENT `sprint_item` rows (outcome !==
 * "removed"). Never the whole backlog/project — that's what @osp/sync's
 * project-scoped SyncEngine is for, and it is NOT reused here (different
 * concern: full-project import vs. one sprint's diff pass).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE OPERATIONS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * activate(sprintId):
 *   1. Sprint must be status="planning" (else throw AppError("SPRINT_NOT_PLANNING")
 *      — this is what makes activate() idempotency-safe / re-activation-proof).
 *   2. sprintUpdateRuns.start(sprintId, "activation", triggeredBy) — kind is
 *      ALWAYS "activation" here regardless of triggeredBy ("manual" from the
 *      route, or whatever PATCH passes through — see routes note below).
 *   3. List current sprint_item rows (outcome !== "removed") → wp_op_ids.
 *   4. Scoped fetch (see FETCHING below) → current OpWorkPackage[] for those ids.
 *   5. For each: build a NewTicketBaseline row (captured_at = activatedAt,
 *      raw_json = JSON.stringify(the OpWorkPackage)) and
 *      repos.ticketBaselines.upsertMany(rows) — upsertMany so a defensive
 *      re-run (should never happen given the planning-only guard, but the repo
 *      layer stays safe regardless) overwrites cleanly instead of duplicating.
 *   6. ALSO run the same "refresh work_package_cache + derive changelog since
 *      activatedAt" pass as update() would (see UPDATE CORE below) — this
 *      means activation immediately gets journal/time-entry changelog entries
 *      too if the ticket already had activity exactly at/after activatedAt
 *      (edge case, but cheap to just always run the shared core).
 *   7. repos.sprints.activate(sprintId, activatedAt) — status → "active".
 *   8. Write the FIRST burndown point: snapshotWriter.writeSnapshot(sprintId,
 *      activatedAt.slice(0, 10)) — reuse @osp/sync's existing writer verbatim,
 *      do NOT recompute burndown math here (it already does truth-correction
 *      and reads the work_package_cache rows update() just refreshed).
 *   9. sprintUpdateRuns.finish(runId, "success", wpCount, changesCount, null, now).
 *   10. Return the updated Sprint.
 *   On any thrown error: sprintUpdateRuns.finish(runId, "error", null, null,
 *   String(error), now) then rethrow.
 *
 * update(sprintId, triggeredBy):
 *   1. Sprint must have activated_at set (else AppError("SPRINT_NOT_ACTIVE")).
 *   2. [Increment 31, docs/INCREMENT_31_CONTRACTS.md §2a — SUPERSEDES the
 *      original "must NOT be is_locked" rule] Sprint must NOT be FROZEN (else
 *      AppError("SPRINT_FROZEN")) — a HARD error, mirroring the old
 *      SPRINT_LOCKED's role (unlike finish's idempotent-on-locked return).
 *      A locked-but-not-yet-frozen sprint (the post-finish GRACE WINDOW) is
 *      now ALLOWED to run update — the whole point of grace is that late time
 *      logs and final status flips still arrive without reactivating.
 *   3. sprintUpdateRuns.start(sprintId, "update", triggeredBy).
 *   4. Run UPDATE CORE (below).
 *   5. sprintUpdateRuns.finish(...) with wpCount/changesCount; return the run.
 *
 * finish(sprintId, triggeredBy, lockReason):
 *   1. If sprint.is_locked already: return the STORED closure report
 *      idempotently (SAME shape as the existing POST /close route already
 *      does for a re-call) — do NOT run another update pass, do NOT throw.
 *   2. Sprint must have activated_at set (else AppError("SPRINT_NOT_ACTIVE")).
 *   3. sprintUpdateRuns.start(sprintId, "final", triggeredBy).
 *   4. Run UPDATE CORE (below) — the closure report must reflect the FRESHEST
 *      OP state, which is the whole reason /finish exists instead of just
 *      reusing /close directly.
 *   5. sprintUpdateRuns.finish(..., "success", ...).
 *   6. Perform closure: reuse (extract, don't duplicate) the EXACT closure
 *      logic the existing POST /sprints/:id/close route already has inline
 *      (build ClosureInputItem[] from sprint_item + work_package_cache +
 *      done_status_rule, buildClosureSplit, persist per-item outcome
 *      done/carried, persist sprint_closure_report, compute completedHours).
 *      Suggested refactor: pull that block out of routes/index.ts into a new
 *      exported function in ./closure.ts (e.g. `performClosure(repos,
 *      sprintId, generatedAt)`) and have BOTH /close and finish() call it —
 *      do not fork the logic.
 *   7. repos.sprints.close(sprintId, completedHours, closedAt, lockReason) —
 *      this ATOMICALLY sets status="closed", is_locked=true, locked_at,
 *      lock_reason (see packages/db SprintRepository.close, already wired).
 *   8. Return the ClosureReportResponse (same shape POST /close already
 *      returns — ClosureScreen.tsx and the web tests read it unmodified).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * UPDATE CORE (shared by activate/update/finish)
 * ─────────────────────────────────────────────────────────────────────────
 * Given: sprintId, the OpClient, activatedAt (sprint.activated_at — always
 * set by the time this runs), the update_run_id just started.
 *
 * A) SCOPED FETCH
 *    wpOpIds = current (outcome !== "removed") sprint_item wp_op_id list.
 *    If empty: nothing to do, wpCount=0, changesCount=0, done.
 *    op.getWorkPackages({ filters: [{ id: { operator: "=",
 *      values: wpOpIds.map(String) } }], pageSize: 100 }) — page through with
 *    offset like the existing sync engine does (packages/sync's
 *    fetchAllWorkPackages pattern; a sprint's ticket count will almost never
 *    exceed one page, but don't assume it).
 *    op.getStatuses() once (for status_is_closed / isClosed lookups).
 *
 * B) REFRESH work_package_cache
 *    Aggregate time entries the SAME way the project sync does:
 *      op.getTimeEntries({ filters: [
 *        { entity_type: { operator: "=", values: ["WorkPackage"] } },
 *        { entity_id: { operator: "=", values: wpOpIds.map(String) } },
 *      ] }) — `workPackage` is a DEPRECATED filter attribute that real
 *      OpenProject 400s on (SPEC_07 §3); entity_type+entity_id is the
 *      supported way to scope time entries to specific tickets. Page through
 *      all pages —
 *      then @osp/sync's `aggregateTimeEntries(entries)` for the spentHours
 *      fallback per ticket (mirrors toWorkPackageCacheRow's 3rd arg usage in
 *      the existing project sync — see packages/sync/src/index.ts).
 *    For each fetched OpWorkPackage: toWorkPackageCacheRow(wp, statusById,
 *      spentFallbackHours) → repos.workPackages.upsertMany(rows). This is the
 *      "přepiš scoped cache aktuálním stavem" step — reuses the EXACT mapper
 *      the project sync already uses, so backlog/capacity/burndown all see
 *      fresh sprint-ticket data without a separate code path.
 *
 * C) DERIVE CHANGELOG — journals (primary source for everything except
 *    time_logged)
 *    For each wpOpId: op.getActivities(wpOpId) → OpActivity[]. Filter to
 *    `createdAt >= activatedAt` (lexicographic ISO string compare is fine —
 *    both are the engine's zero-padded ISO stamps). For each surviving
 *    activity, `@osp/op-client`'s `deriveChangelogEvents(activity, statusById)`
 *    (SPEC_10 §d) is the single source of truth — it walks EVERY entry in
 *    `details[]` (an activity can carry more than one field change at once,
 *    e.g. a "return from tester" bundling an assignee change with other
 *    fields — reading only `details[0]`, like this code used to, silently
 *    dropped every change past the first) PLUS a content-free
 *    `comment_added` draft when `activity.comment` is non-empty (previously
 *    dropped entirely — no row at all). Each returned draft becomes one row:
 *      dedupKey = `journal:${activity.id}:${draft.dedupSuffix}`
 *      kind/detail = draft.kind / draft.detail (JSON.parse-ready)
 *      actor: activity._links.user.href → parseOpId; actorName from
 *      .title ?? null. Both null when href is null (OP couldn't attribute it).
 *      occurred_at = activity.createdAt (same for every draft from one activity).
 *    A status transition into a closed status (per the statusById map from A)
 *    already yields its own trailing "closed" draft from
 *    deriveChangelogEvents — no separate handling needed here.
 *    A detail whose `property` isn't recognized (forward-compat — a real OP
 *    server can send fields this app doesn't map, e.g. priority/category)
 *    yields NO draft at all — SILENTLY skipped, never an "other"/
 *    "unrecognized property" row (SPEC_10 §d: bug #11762 was this exact
 *    fallback stringifying a missing/unmapped `property` into a visible,
 *    confusing changelog row).
 *
 * D) DERIVE CHANGELOG — time entries (source of `time_logged` ONLY; journals
 *    never produce this kind)
 *    op.getTimeEntries({ filters: [
 *      { entity_type: { operator: "=", values: ["WorkPackage"] } },
 *      { entity_id: { operator: "=", values: wpOpIds.map(String) } },
 *    ] }) — the fetch itself is deliberately UNWINDOWED (fetchConnectionScope;
 *    the spentOn>=d filter this spec text originally listed was never
 *    implemented, and the full series also feeds spent-hours aggregation);
 *    the window is applied CLIENT-SIDE at derivation. FOLLOWUPS #8: that
 *    lower bound is the sprint's CALENDAR start (start_date), not the
 *    activation date this originally specified, so Closure's Logged and the
 *    burnup share one window (see the derivation site's comment for the full
 *    rationale). For each entry:
 *      dedupKey = `time_entry:${entry.id}`
 *      kind="time_logged", detail={kind:"time_logged",
 *        hours: parseIsoDuration(entry.hours) ?? 0, spent_on: entry.spentOn}
 *      actor from entry._links.user (href → parseOpId, title → name).
 *      occurred_at = entry.createdAt ?? `${entry.spentOn}T12:00:00Z` (fallback
 *      for a real-OP time entry that might omit createdAt — the mock always
 *      sets it, so this fallback is defensive only).
 *      source="time_entry", op_journal_id=null.
 *
 * E) PERSIST
 *    rows = (C) ++ (D), each also carrying sprint_id, wp_op_id, update_run_id.
 *    changesCount = await repos.ticketChangelog.insertMany(rows) — this is
 *    where idempotence actually happens (UNIQUE dedup_key, insertMany skips
 *    existing keys and returns the count ACTUALLY inserted). A second update
 *    run with no OP changes therefore inserts 0 rows — do not pre-filter
 *    "already seen" yourself, let the repository's dedup do it; that keeps
 *    this function pure-ish and the dedup logic in one place.
 *
 * F) BURNDOWN POINT
 *    await snapshotWriter.writeSnapshot(sprintId, todayDate) — todayDate is
 *    `now().toISOString().slice(0,10)` UNLESS the caller is a scenario/test
 *    driving a specific logical date (the mock's advance-day helper already
 *    calls the APP's own POST /api/snapshot separately for that — this
 *    function should just use "now", it does not need a date parameter).
 *
 * wpCount = wpOpIds.length (from A). Return { wpCount, changesCount } to the
 * caller (activate/update/finish) for sprintUpdateRuns.finish(...).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * JOURNAL PROPERTY → CHANGELOG KIND MAPPING (frozen — SPEC_10 §d moved the
 * implementation to @osp/op-client's deriveChangelogEvents/deriveDetailEvents,
 * see that module's doc comment for the exact per-property shapes; this repo
 * table is kept here as the quick-reference index, do not hand-roll a SECOND
 * mapping anywhere else)
 * ─────────────────────────────────────────────────────────────────────────
 *   "status"        → status_changed  { from: old.title, to: new.title } (+ trailing "closed" draft on a→closed transition)
 *   "assignee"       → assignee_changed { from: old?.title ?? null, to: new?.title ?? null }
 *   "accountable"    → accountable_changed { from, to } (same shape)
 *   "estimatedTime"  → estimate_changed { from: parseIsoDuration(old.title), to: parseIsoDuration(new.title) }
 *   "remainingTime"  → remaining_changed { from: parseIsoDuration(old.title), to: parseIsoDuration(new.title) }
 *   "version"        → version_changed { from: old?.title ?? null, to: new?.title ?? null }
 *   (comment, non-empty) → comment_added {} — no content stored, author/time
 *      already live on the changelog entry itself (SPEC_10 §4 decision #3).
 *   anything else    → skipped silently, no row (SPEC_10 §d)
 * (old/new here are the OpActivityDetail HAL links — old.title/new.title is
 * always where the display value lives, per OpActivity's doc comment: a
 * reference field's title is the name, a scalar field's title is the ISO
 * duration string. old.href === null means "was empty".)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LOCK ENFORCEMENT (routes/index.ts, Agent B) — every sprint-scoped MUTATING
 * endpoint must check `sprint.is_locked` and throw AppError("SPRINT_LOCKED")
 * once true: POST/DELETE .../items, PUT .../capacity (in ADDITION to its
 * existing planning-only check), PATCH /sprints/:id. The one exception is
 * POST .../finish, which is idempotent-on-locked (returns the stored report,
 * see finish() step 1 above) rather than erroring.
 * [Increment 31, docs/INCREMENT_31_CONTRACTS.md §2a — SUPERSEDES POST
 * .../update's entry above] `POST .../update` no longer checks `is_locked` at
 * all (neither here nor at the route) — it checks `frozen_at` INSIDE
 * `sprintLifecycle.update()` itself (SPRINT_FROZEN once frozen; ALLOWED while
 * merely locked — the post-finish grace window). Every other endpoint in this
 * list is unaffected: the lock still means "no planning changes"; only update
 * runs got a grace re-opening.
 *
 * PATCH /sprints/:id ACTIVATION SHORTCUT: when a PATCH body sets
 * status:"active" and the sprint is currently "planning", the route should
 * delegate to sprintLifecycle.activate(id) and return ITS result instead of a
 * plain repos.sprints.update() status flip — this is how the EXISTING
 * SprintBoardScreen "Activate" button (which calls PATCH, not a new endpoint)
 * gets baseline capture for free, with zero frontend changes required. Any
 * OTHER fields in the same PATCH body should be applied via the normal
 * update() path (before or after activation — order doesn't matter, they
 * don't overlap).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCHEDULER CONTRACT (Agent A — apps/api/src/scheduler/*, does not touch this
 * file, calls it through the interface below)
 * ─────────────────────────────────────────────────────────────────────────
 * A NEW scheduler module (e.g. scheduler/sprintUpdates.ts, mirroring
 * scheduler/heartbeat.ts's shape: startX(deps): {stop(), tickNow()}) ticks
 * periodically (default 30 min, SPEC_04 §9.1) and, for every sprint with
 * status="active" && !is_locked:
 *   - calls sprintLifecycle.update(sprintId, "scheduler")
 *   - if `now >= endOfLocalDay(sprint.end_date)` (see END-OF-DAY below):
 *     calls sprintLifecycle.finish(sprintId, "end_date", "end_date") instead
 *     of update() for that sprint this tick (finish already runs an update
 *     pass internally — do not call both).
 * END-OF-DAY: a sprint's end_date "23:59:59.999" WITHOUT a timezone
 * designator, parsed by `new Date(...)`, is LOCAL time per the JS Date spec
 * (only bare YYYY-MM-DD is UTC) — this gives "local TZ end of day" for free:
 *   const deadline = new Date(`${sprint.end_date}T23:59:59.999`);
 *   const due = now.getTime() >= deadline.getTime();
 *
 * [Increment 31, docs/INCREMENT_31_CONTRACTS.md §2b — ADDS a second, disjoint
 * group to the SAME tick] For every sprint with status="closed" && is_locked
 * && frozen_at===null (the post-finish GRACE WINDOW):
 *   - calls sprintLifecycle.update(sprintId, "scheduler") every tick too (late
 *     time logs / status flips still arrive during grace — this is the whole
 *     point of the window), independently of the group above;
 *   - if `now >= freezeDeadline(sprint.locked_at, freeze_grace_days)` (see
 *     `logic/freeze.ts` — end-of-local-day of `locked_at + freeze_grace_days`,
 *     the SAME end-of-local-day convention as END-OF-DAY above, just anchored
 *     at `locked_at` instead of `end_date`): calls `freezeSprint(sprintId)`
 *     (`logic/freeze.ts`), which does its OWN best-effort final update
 *     internally — do not skip the grace update above just because freeze is
 *     about to run; they are independent per §2b's own bullet list.
 * `apps/api/src/server.ts`'s `buildServer()` additionally runs ONE
 * freeze-only sweep at boot (`logic/freeze.ts`'s `sweepOverdueFreezes`) so an
 * app that was down past a deadline freezes as soon as it restarts, not on
 * the next tick.
 * The scheduler needs the SAME vault-locked / no-token guards as the existing
 * heartbeat (skip a sprint's tick silently, do not throw, when the vault is
 * locked or the connection has no token — see scheduler/heartbeat.ts for the
 * established pattern). Wiring (apps/api/src/index.ts) is Agent B's job, same
 * split as Increment 2's heartbeat.
 */

export interface SprintLifecycle {
  /** planning → active: baseline + first burndown point. Throws
   * AppError("SPRINT_NOT_PLANNING") if not currently planning. */
  activate(sprintId: number): Promise<Sprint>;
  /** Scoped diff + changelog pass. Throws AppError("SPRINT_NOT_ACTIVE") /
   * AppError("SPRINT_FROZEN") (Increment 31, §2a — supersedes the original
   * SPRINT_LOCKED gate; a locked-but-not-frozen sprint's grace window now
   * allows update) per the rules above. */
  update(sprintId: number, triggeredBy: UpdateRunTriggeredBy): Promise<SprintUpdateRun>;
  /** Final update + irreversible lock + closure report. Idempotent once
   * already locked (returns the stored report, never errors). */
  finish(
    sprintId: number,
    triggeredBy: UpdateRunTriggeredBy,
    lockReason: LockReason,
  ): Promise<ClosureReportResponse>;
}

export interface SprintLifecycleDeps {
  repos: Repositories;
  /**
   * SPEC_10 §e — resolve a per-connection, already-timeout-wrapped OP client.
   * update()/finish()/activate() call this ONLY for the connections a sprint's
   * current tickets actually live on; an irrelevant/disconnected connection is
   * never resolved, and a NEEDED-but-unavailable one surfaces as a clear
   * per-connection error thrown by this resolver (e.g. CONNECTION_DISABLED /
   * VAULT_LOCKED — the route wraps requireOpClientForConnection + withTimeout).
   * Replaces the old single closure-bound `op: OpClient`.
   */
  buildClientForConnection: (connectionId: number) => Promise<OpClient>;
  /** Build a burndown-point writer bound to a given OP client — see UPDATE CORE
   * (F). Any needed connection's client works (the time-entries read is
   * best-effort); replaces the old single pre-bound `snapshotWriter`. */
  snapshotWriterFactory: (op: OpClient) => SnapshotWriter;
  now: () => Date;
}

/** Result of one UPDATE CORE pass, plus the per-connection freshly-fetched OP
 * data (each with its OWN status ids) so activate()/heal can capture baselines
 * without a second round-trip. */
interface UpdateCoreResult {
  wpCount: number;
  changesCount: number;
  fetches: { partition: ScopedActivationPartition; fetched: ScopedFetch }[];
  allWps: OpWorkPackage[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the status id → OpStatus lookup (mirrors @osp/sync's private helper). */
async function loadStatusMap(op: OpClient): Promise<Map<number, OpStatus>> {
  const statuses = await op.getStatuses();
  const byId = new Map<number, OpStatus>();
  for (const s of statuses._embedded.elements) byId.set(s.id, s);
  return byId;
}

/** Scoped work-package fetch: only the given sprint ticket ids, paged. */
function fetchScopedWorkPackages(
  op: OpClient,
  wpOpIds: number[],
): Promise<OpWorkPackage[]> {
  if (wpOpIds.length === 0) return Promise.resolve([]);
  return fetchAllWorkPackages(op, {
    filters: [{ id: { operator: "=", values: wpOpIds.map(String) } }],
    pageSize: 100,
  });
}

/**
 * Build a ticket_baseline row from an OP work package. `origin` is "baseline"
 * at activation (the sprint's frozen otisk) or "added_mid_sprint" when a ticket
 * is added to an already-running sprint (SPEC_05 §3/§4) — exported so the
 * mid-sprint-add route (routes/index.ts) uses the EXACT same field mapping.
 */
export function buildBaseline(
  sprintId: number,
  wp: OpWorkPackage,
  statusById: Map<number, OpStatus>,
  capturedAt: string,
  origin: SprintItemOrigin,
): NewTicketBaseline {
  const statusId = parseOpId(wp._links.status?.href ?? null);
  const status = statusId !== null ? statusById.get(statusId) : undefined;
  return {
    sprint_id: sprintId,
    wp_op_id: wp.id,
    captured_at: capturedAt,
    subject: wp.subject,
    status_name: wp._links.status?.title ?? status?.name ?? "",
    status_is_closed: status?.isClosed ?? false,
    assignee_op_id: parseOpId(wp._links.assignee?.href ?? null),
    accountable_op_id: parseOpId(wp._links.accountable?.href ?? null),
    // SPEC_09 §3 ("o_t"): only meaningful on first insert — the repository
    // upsert deliberately excludes this column from its ON CONFLICT UPDATE,
    // so passing the CURRENT assignee here is correct for both a fresh
    // activation baseline and a fresh added_mid_sprint baseline (in both
    // cases this IS the ticket's original owner, by definition, the moment
    // this row is first written).
    original_assignee_op_id: parseOpId(wp._links.assignee?.href ?? null),
    estimated_hours: parseIsoDuration(wp.estimatedTime),
    remaining_hours: parseIsoDuration(wp.remainingTime),
    spent_hours: parseIsoDuration(wp.spentTime ?? null),
    version_op_id: parseOpId(wp._links.version?.href ?? null),
    raw_json: JSON.stringify(wp),
    origin,
    // Increment 12 (SPEC_12 §2/§4): a live activation/mid-sprint-add baseline is
    // read from OP's CURRENT state, not reconstructed — the retro path
    // (apps/api/src/logic/retro.ts) builds its own reconstructed baseline rows.
    reconstructed: false,
    reconstruction_gaps_json: null,
    // Increment 13 (SPEC_13 §1): a live (non-reconstructed) baseline's identity
    // comes straight from OP's assignee link — no journal-name resolution
    // needed, so there is no raw name to store.
    assignee_name_raw: null,
  };
}

/**
 * One scoped connection's fetch: the sprint tickets that live on THIS
 * connection plus the OP metadata needed to refresh the cache + derive changelog
 * (statuses, time entries, activities). Kept separate from persistence so scoped
 * activation (SPEC_09 §1) can fan this out per connection with Promise.allSettled
 * before touching the DB, while single-connection update()/finish() reuse it too.
 */
interface ScopedFetch {
  wps: OpWorkPackage[];
  statusById: Map<number, OpStatus>;
  timeEntries: OpTimeEntry[];
  activitiesByWp: Map<number, OpActivity[]>;
}

async function fetchConnectionScope(op: OpClient, wpOpIds: number[]): Promise<ScopedFetch> {
  const [statusById, wps] = await Promise.all([
    loadStatusMap(op),
    fetchScopedWorkPackages(op, wpOpIds),
  ]);
  // `workPackage`/`work_package` is a DEPRECATED, unsupported time_entries filter
  // on real OpenProject (SPEC_07 §3) — scope by entity_type + entity_id instead.
  const timeEntries = await fetchAllTimeEntries(op, {
    filters: [
      { entity_type: { operator: "=", values: ["WorkPackage"] } },
      { entity_id: { operator: "=", values: wpOpIds.map(String) } },
    ],
  });
  const activitiesByWp = await fetchActivitiesByWpIds(op, wpOpIds);
  return { wps, statusById, timeEntries, activitiesByWp };
}

/**
 * The persistence half of one scoped pass (SPEC_04 UPDATE CORE steps B–E),
 * factored out of runUpdateCore so scoped activation can call it once per
 * connection with that connection's OWN status ids (status ids are per-server;
 * merging them across connections would misclassify statuses). Returns the
 * changelog rows ACTUALLY inserted (post-dedup). `progressBase`/`progressTotal`
 * let a multi-connection activation report cumulative "X / Y" progress; a
 * single-connection caller passes 0 / wpOpIds.length.
 */
async function persistScopedPass(
  repos: Repositories,
  sprintId: number,
  activatedAt: string,
  updateRunId: number,
  wpOpIds: number[],
  fetched: ScopedFetch,
  progressBase: number,
  progressTotal: number,
  /** This pass's OP connection — stamped onto every refreshed cache row so a WP
   * first cached by THIS live Update/Finish path never lands with a NULL
   * connection_id (the "SERVER —" bug, Concept 5). This pass is per-connection. */
  connectionId: number,
  /**
   * SPEC_11 §4 — resolve a changelog actor's display name. Real OP activities/
   * time-entries carry NO `_links.user.title` (confirmed against the production
   * fixture), so `actorName` used to be `null` forever; this resolver fills it
   * via op.getUser (cached), falling back to a readable "Unknown user (<id>)".
   */
  nameResolver: UserNameResolver,
): Promise<number> {
  const { wps, statusById, timeEntries, activitiesByWp } = fetched;
  // Seed local names from the freshly-fetched work packages' assignee links so a
  // journal actor who happens to be a current assignee needs no extra round-trip.
  for (const wp of wps) {
    const aId = parseOpId(wp._links.assignee?.href ?? null);
    if (aId !== null) nameResolver.seed(aId, wp._links.assignee?.title ?? null);
  }
  /** actor name: link title (real OP omits it) → op.getUser → "Unknown user". */
  const resolveActor = async (
    href: string | null,
    title: string | null | undefined,
    opId: number | null,
  ): Promise<string | null> => {
    if (href === null) return null; // OP couldn't attribute an actor at all
    if (title) return title;
    if (opId === null) return null;
    return (await nameResolver.resolve(opId)) ?? unknownUserLabel(opId);
  };

  // B) REFRESH work_package_cache (same mapper the project sync uses).
  const agg = aggregateTimeEntries(timeEntries);
  await repos.workPackages.upsertMany(
    wps.map((wp) =>
      toWorkPackageCacheRow(wp, statusById, agg.byWorkPackage.get(wp.id) ?? null, connectionId),
    ),
  );

  const changelogRows: NewChangelogEntry[] = [];

  // C) DERIVE CHANGELOG — journals (everything except time_logged). Progress
  // advances per-ticket (Increment 8 §3) offset by progressBase across connections.
  await repos.sprintUpdateRuns.progress(updateRunId, progressBase, progressTotal);
  for (const [i, wpId] of wpOpIds.entries()) {
    for (const act of activitiesByWp.get(wpId) ?? []) {
      if (act.createdAt < activatedAt) continue; // only changes SINCE activation
      const actorHref = act._links.user.href;
      const actorOpId = parseOpId(actorHref);
      const actorName = await resolveActor(actorHref, act._links.user.title, actorOpId);
      // SPEC_10 §d: every recognized details[] entry (not just the first) +
      // a content-free comment_added when the activity carries a comment;
      // an unrecognized detail property is silently skipped (@osp/op-client's
      // deriveChangelogEvents — see its doc for the bug this replaces).
      for (const ev of deriveChangelogEvents(act, statusById)) {
        changelogRows.push({
          sprint_id: sprintId,
          wp_op_id: wpId,
          update_run_id: updateRunId,
          occurred_at: act.createdAt,
          actor_op_id: actorOpId,
          actor_name: actorName,
          kind: ev.kind,
          detail_json: JSON.stringify(ev.detail),
          source: "journal",
          op_journal_id: act.id,
          dedup_key: `s${sprintId}:journal:${act.id}:${ev.dedupSuffix}`,
        });
      }
    }
    await repos.sprintUpdateRuns.progress(updateRunId, progressBase + i + 1, progressTotal);
  }

  // D) DERIVE CHANGELOG — time entries (source of time_logged ONLY). Reuses the
  // (B) fetch, scoped client-side to this connection's tickets + spentOn within
  // the sprint's CALENDAR window (>= start_date).
  //
  // FOLLOWUPS #8 unification (user decision, 2026-08-19): the lower bound is
  // `sprint.start_date`, NOT the activation date it used to be. Work logged
  // between start_date and the (possibly much later) Activate click — a sprint
  // activated Tuesday for a Monday start, or a retrospective sprint whose
  // "activation" is the replay moment weeks after the fact — was silently
  // invisible to Closure's per-person Logged while the burnup (also
  // start_date-bounded, packages/sync computeSnapshot) counted it: 36.5h vs
  // 31h on the same screen pair, reconciled to the decimal. One calendar
  // window for both surfaces now. Journals (C) deliberately KEEP the
  // activation anchor — pre-activation status/assignee history is baseline/
  // reconstruction territory, not sprint-run changelog. Widening the window is
  // re-run-safe: the retro replay writes the SAME `s<id>:time_entry:<id>`
  // dedup keys, so the UNIQUE index silently skips anything already recorded.
  // The window is CLOSED on both ends: entries with spent_on after end_date
  // belong to whatever comes next — the same tickets routinely carry over into
  // the following sprint, and without the upper bound a grace-period update on
  // the finished sprint vacuumed the successor's ongoing work into its Logged
  // (measured live: +12.1h of next-sprint work on sprint "3.5.041").
  const sprintRow = await repos.sprints.getById(sprintId);
  const loggedFromDate = sprintRow?.start_date ?? activatedAt.slice(0, 10);
  const loggedToDate = sprintRow?.end_date ?? null;
  const wpIdSet = new Set(wpOpIds);
  for (const e of timeEntries) {
    const wpId = parseOpId(e._links.workPackage?.href ?? null);
    if (wpId === null || !wpIdSet.has(wpId)) continue;
    if (e.spentOn < loggedFromDate) continue;
    if (loggedToDate !== null && e.spentOn > loggedToDate) continue;
    const actorHref = e._links.user.href;
    const actorOpId = parseOpId(actorHref);
    changelogRows.push({
      sprint_id: sprintId,
      wp_op_id: wpId,
      update_run_id: updateRunId,
      occurred_at: e.createdAt ?? `${e.spentOn}T12:00:00Z`,
      actor_op_id: actorOpId,
      actor_name: await resolveActor(actorHref, e._links.user.title, actorOpId),
      kind: "time_logged",
      detail_json: JSON.stringify({
        kind: "time_logged",
        hours: parseIsoDuration(e.hours) ?? 0,
        spent_on: e.spentOn,
      }),
      source: "time_entry",
      op_journal_id: null,
      dedup_key: `s${sprintId}:time_entry:${e.id}`,
    });
  }

  // E) PERSIST — dedup in the repository (UNIQUE dedup_key); returns the count
  // ACTUALLY inserted, so a no-change re-run yields 0.
  return changelogRows.length > 0 ? await repos.ticketChangelog.insertMany(changelogRows) : 0;
}

/**
 * Leaf-effort (double-counting-guarded) sum of freshly-fetched OP work packages'
 * effective hours, used to freeze `sprint.baseline_total_hours` at activation
 * (SPEC_05 §4). Override-aware via the same estimateOverrides the capacity/
 * burndown paths use, so the frozen total matches what those screens show.
 */
async function computeBaselineTotalHours(
  repos: Repositories,
  wps: OpWorkPackage[],
): Promise<number> {
  if (wps.length === 0) return 0;
  const overrides = await repos.estimateOverrides.getManyByWpOpIds(wps.map((w) => w.id));
  const ovById = new Map(overrides.map((o) => [o.wp_op_id, o]));
  return leafEffort(
    wps.map((wp) => ({
      wp_op_id: wp.id,
      parent_op_id: parseOpId(wp._links.parent?.href ?? null),
      hours: effectiveEstimate(
        parseIsoDuration(wp.estimatedTime),
        parseIsoDuration(wp.remainingTime),
        ovById.get(wp.id)?.planning_hours ?? null,
      ),
    })),
  ).total;
}

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §3, step 2) — an OP 400 on our
 * `user`/`spent_on` filter is the SPEC_07 OP_QUERY_INVALID shape (the server
 * responded, it just rejected the query — never "unreachable"), the same
 * signal `mapOpError` keys its degrade-vs-fail split on elsewhere. Any other
 * error (timeout, 5xx, network) is a real failure and must NOT trigger the
 * degrade ladder below.
 */
function isQueryInvalid(err: unknown): boolean {
  return err instanceof OpHttpError && err.status === 400;
}

/**
 * §3, step 2 — the degrade ladder: try `user` + `spent_on` together; on a 400
 * drop `spent_on` first (the caller re-applies the full [start_date, end_date]
 * window client-side regardless of which level succeeds — §3, step 3 — so
 * losing the server-side lower bound only costs an optimization, never
 * correctness); if the server ALSO rejects the bare `user` filter, drop it too
 * (LAST RESORT — an unfiltered fetch) and let the caller's client-side roster
 * check do the narrowing. Any non-400 error propagates unattempted — this
 * function does not decide overall run success, `fetchAndPersistOffSprintTime`
 * below does, via its own try/catch.
 */
async function fetchOffSprintTimeEntriesDegrading(
  op: OpClient,
  rosterOpIds: string[],
  fromDate: string,
): Promise<OpTimeEntry[]> {
  const userFilter = { user: { operator: "=", values: rosterOpIds } };
  const spentOnFilter = { spent_on: { operator: ">=d", values: [fromDate] } };
  try {
    return await fetchAllTimeEntries(op, { filters: [userFilter, spentOnFilter] });
  } catch (err) {
    if (!isQueryInvalid(err)) throw err;
  }
  try {
    return await fetchAllTimeEntries(op, { filters: [userFilter] });
  } catch (err) {
    if (!isQueryInvalid(err)) throw err;
  }
  return await fetchAllTimeEntries(op, {});
}

/**
 * Increment 32 (docs/INCREMENT_32_CONTRACTS.md §1/§3) — "what are the
 * developers ACTUALLY working on": fetch every roster developer's OP time
 * entries logged during `runUpdateCore`'s partition set, keep only what falls
 * INSIDE the sprint's calendar window and OUTSIDE its own tickets, and REPLACE
 * the sprint's stored report (§0.3 — current truth, not an event log).
 *
 * §3, step 4: best-effort by design. ANY failure here (an unreachable
 * connection, a genuine non-400 OP error, even the final unfiltered fetch
 * 400ing) is caught, logged with a `[off-sprint]` prefix, and swallowed — the
 * sprint's PREVIOUS stored rows are left untouched and the caller (runUpdateCore)
 * never sees this as an update-run failure, mirroring freeze's own final-update
 * posture.
 */
async function fetchAndPersistOffSprintTime(
  repos: Repositories,
  sprintId: number,
  partitions: readonly ScopedActivationPartition[],
  now: () => Date,
): Promise<void> {
  try {
    const sprint = await repos.sprints.getById(sprintId);
    if (sprint === null) return; // defensive — the run already resolved this sprint

    // §1 — the roster: team_member rows with an OP id whose EFFECTIVE role
    // (unset defaults to developer, same rule /capacity and closure share)
    // is "developer". A member with no op_user_id can't be queried by the
    // `user` filter and is silently skipped (no fabrication).
    const members = await repos.teamMembers.list();
    const rosterOpIds = [
      ...new Set(
        members
          .filter((m) => m.op_user_id != null && capacityEffectiveRole(m.role) === "developer")
          .map((m) => m.op_user_id!),
      ),
    ];
    if (rosterOpIds.length === 0) {
      // Nothing to report — replace with empty so a roster that shrank to
      // zero developers doesn't leave a stale report behind (§0.3).
      await repos.offSprintTime.replaceForSprint(sprintId, []);
      return;
    }
    const rosterOpIdSet = new Set(rosterOpIds);
    const rosterOpIdStrings = rosterOpIds.map(String);

    // §3, step 3 — the exclusion set is the sprint's FULL item list, ANY
    // outcome (a removed-mid-sprint ticket is still "sprint work", not
    // off-sprint) — deliberately the UNFILTERED read, unlike step A's
    // `outcome !== "removed"` list used for the scoped ticket fetch above.
    const allItems = await repos.sprintItems.listBySprint(sprintId);
    const excludeWpIds = new Set(allItems.map((i) => i.wp_op_id));

    const fetchedAt = now().toISOString();
    const rows: NewOffSprintTimeEntry[] = [];
    for (const p of partitions) {
      const entries = await fetchOffSprintTimeEntriesDegrading(
        p.op,
        rosterOpIdStrings,
        sprint.start_date,
      );
      for (const e of entries) {
        // Client-side window is ALWAYS re-checked regardless of which degrade
        // level succeeded (§0 pillar 2 / §3 step 3: correctness lives here,
        // the OP-side filter is only ever an optimization).
        if (e.spentOn < sprint.start_date || e.spentOn > sprint.end_date) continue;
        const wpId = parseOpId(e._links.workPackage?.href ?? null);
        if (wpId === null || excludeWpIds.has(wpId)) continue;
        const actorOpId = parseOpId(e._links.user.href);
        // Client-side roster re-check ALWAYS applied too (not only on the
        // LAST-RESORT unfiltered path) — a no-op when the server already
        // filtered by `user`, and the thing that makes the last-resort path
        // correct without threading "which degrade level succeeded" state
        // through this loop. `actor_op_id` is NOT NULL on the row, so an
        // entry OP couldn't attribute is unstorable and skipped either way.
        if (actorOpId === null || !rosterOpIdSet.has(actorOpId)) continue;
        rows.push({
          sprint_id: sprintId,
          connection_id: p.connectionId,
          op_time_entry_id: e.id,
          wp_op_id: wpId,
          wp_subject: e._links.workPackage?.title ?? null,
          actor_op_id: actorOpId,
          actor_name: e._links.user.title ?? null,
          spent_on: e.spentOn,
          hours: parseIsoDuration(e.hours) ?? 0,
          fetched_at: fetchedAt,
        });
      }
    }
    await repos.offSprintTime.replaceForSprint(sprintId, rows);
  } catch (err) {
    console.error(`[off-sprint] sprint ${sprintId}: ${errMessage(err)}`);
  }
}

/** One connection's slice of a scoped activation (SPEC_09 §1). */
export interface ScopedActivationPartition {
  connectionId: number;
  /** Human-facing label (base_url/label) for per-connection error attribution. */
  label: string;
  /** The (withTimeout-wrapped) OP client for this connection — route-supplied. */
  op: OpClient;
  /** This connection's subset of the sprint's current wp_op_ids. */
  wpOpIds: number[];
}

export interface ScopedActivationDeps {
  repos: Repositories;
  snapshotWriter: SnapshotWriter;
  now: () => Date;
}

/** Result of the shared scoped fetch+persist core (SPEC_10 §e). */
export interface ScopedPassResult {
  /** Total sprint tickets across all partitions. */
  wpCount: number;
  /** Changelog rows ACTUALLY inserted (post-dedup) across all partitions. */
  changesCount: number;
  /** Per-connection fetched OP data (kept separate so a caller can capture
   * baselines with each connection's OWN status ids — status ids are per-server). */
  fetches: { partition: ScopedActivationPartition; fetched: ScopedFetch }[];
  /** All fetched work packages merged, for the baseline-total leaf-effort sum. */
  allWps: OpWorkPackage[];
}

/**
 * SPEC_10 §e — the shared fetch+persist core for ANY scoped multi-connection
 * pass (activation, update, finish). Fans out one fetchConnectionScope per
 * connection CONCURRENTLY (Promise.allSettled — one connection's timeout must
 * not lose another connection's already-fetched data), THROWS a single
 * per-connection-attributed error if ANY needed connection failed (the caller
 * finishes its run "error"). This all-or-nothing behaviour is the runtime
 * enforcement of activationScope.ts's CONNECTION_MULTI_POLICY.requireAll (the
 * pre-flight gate is validateNeededConnections; this is the in-flight one) —
 * deliberately the OPPOSITE of refresh-all's `isolate` policy. See Escalation A
 * in CONSOLIDATION_PLAN.md before "aligning" the two. On all-succeed it
 * refreshes the cache + derives changelog per
 * connection (each with its OWN status ids). Does NOT capture baselines, freeze
 * totals, flip status or write a burndown point — those are caller-specific
 * tails (activation captures baselines + flips planning→active; a plain
 * update/finish only needs wpCount/changesCount + a burndown point).
 */
/**
 * Consolidation Round (Concept 8) — wrap an already-timeout-bounded partition OP
 * client so this run's external cancel signal aborts any in-flight request.
 * `maxRetries: 0` + the same 15 s bound means this layer adds ONLY the cancel
 * signal: it never introduces the extra retry/timeout behaviour withHardCancel
 * gives the sync engine, so activation/update/finish's existing per-request
 * withTimeout semantics are unchanged. An external cancel rejects with
 * OpCancelledError (never retried), which the run's catch maps to "aborted".
 */
export function withRunCancelSignal(op: OpClient, signal: AbortSignal): OpClient {
  return withHardCancel(op, {
    signal,
    timeoutMs: DEFAULT_ACTIVATION_TIMEOUT_MS,
    maxRetries: 0,
  });
}

/**
 * Consolidation Round (Concept 8) — an honest terminal status for a run that
 * threw: a user-requested hard cancel (OpCancelledError propagated up from a
 * withRunCancelSignal-wrapped client) finishes "aborted"; anything else is a
 * genuine "error". Mirrors packages/sync's finishAborted vs. finish("error")
 * distinction.
 */
export function runFinishStatus(err: unknown): SyncStatus {
  return isOpCancelledError(err) ? "aborted" : "error";
}

async function runScopedFetchAndPersist(
  repos: Repositories,
  sprintId: number,
  activatedAt: string,
  runId: number,
  partitions: readonly ScopedActivationPartition[],
): Promise<ScopedPassResult> {
  const totalCount = partitions.reduce((s, p) => s + p.wpOpIds.length, 0);
  // Consolidation Round (Concept 8) — register a hard-cancel controller for THIS
  // sprint_update_run before any OP I/O, mirroring sync's engine
  // (packages/sync's `sync()`). `POST /sprints/:id/updates/:runId/cancel` calls
  // hardCancelSprintUpdateRun(runId), aborting this controller so an in-flight
  // OP request is physically interrupted — the fix for "a hung
  // activation/update/finish run could only be withTimeout-capped per request,
  // never actually cancelled." Every partition client is re-wrapped with the
  // run's signal (withRunCancelSignal ONLY threads the cancel signal — the
  // per-connection withTimeout bound the route already applied stays
  // authoritative). Unregistered in the finally — a run's controller must never
  // outlive the run.
  const controller = new AbortController();
  registerSprintUpdateController(runId, controller);
  try {
    const scoped = partitions.map((p) => ({
      ...p,
      op: withRunCancelSignal(p.op, controller.signal),
    }));
    // Fan out: one scoped fetch per connection, concurrently. allSettled (NOT
    // all) so one connection's timeout can't cancel another's fetched data.
    const settled = await Promise.allSettled(
      scoped.map((p) => fetchConnectionScope(p.op, p.wpOpIds)),
    );
    // A hard cancel that landed mid-fetch surfaces as one or more rejected
    // partitions; distinguish it from a genuine connection failure so the run
    // finishes "aborted" (not "error") and reports honestly.
    if (controller.signal.aborted) {
      throw new OpCancelledError("sprint_update_run", controller.signal.reason);
    }
    const failures: string[] = [];
    for (const [i, r] of settled.entries()) {
      if (r.status === "rejected") {
        const p = scoped[i]!;
        const reason = r.reason;
        failures.push(
          reason instanceof OpTimeoutError
            ? `${p.label} timed out after ${reason.timeoutMs}ms`
            : `${p.label}: ${errMessage(reason)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(`sprint update failed for connection(s): ${failures.join("; ")}`);
    }

    // All succeeded → persist per connection (each with its OWN status ids),
    // threading a cumulative processed count so progress stays monotonic.
    let processed = 0;
    let changesCount = 0;
    const fetches: { partition: ScopedActivationPartition; fetched: ScopedFetch }[] = [];
    const allWps: OpWorkPackage[] = [];
    for (const [i, p] of scoped.entries()) {
      const fetched = (settled[i] as PromiseFulfilledResult<ScopedFetch>).value;
      // One name resolver per connection (per-server user ids + cache), so a
      // changelog actor with no link title is resolved via THAT server's getUser.
      const nameResolver = createUserNameResolver(p.op);
      changesCount += await persistScopedPass(
        repos,
        sprintId,
        activatedAt,
        runId,
        p.wpOpIds,
        fetched,
        processed,
        totalCount,
        p.connectionId,
        nameResolver,
      );
      processed += p.wpOpIds.length;
      fetches.push({ partition: p, fetched });
      allWps.push(...fetched.wps);
    }
    // Increment 40 (§2.A3): refresh the touched projects' identifier/name for
    // this pass's connections — best-effort, never fails the run.
    // (`partition` is the run-cancel-wrapped client from `scoped` above.)
    for (const { partition: p, fetched } of fetches) {
      await refreshProjectsBestEffort(
        p.op,
        repos,
        p.connectionId,
        fetched.wps.map((wp) => parseOpId(wp._links.project?.href ?? null)),
      );
    }
    return { wpCount: totalCount, changesCount, fetches, allWps };
  } finally {
    unregisterSprintUpdateController(runId);
  }
}

/**
 * SPEC_09 §1 — the BACKGROUND body of scoped, async activation (the route
 * pre-validates connections + creates the run, then fire-and-forgets this).
 * Fetches every needed connection's tickets CONCURRENTLY (per-connection timeout
 * via the withTimeout-wrapped clients the route passes in) and ONLY if ALL
 * succeed: refreshes the cache, derives changelog, captures baselines (per
 * connection, with that connection's OWN status ids), freezes
 * baseline_total_hours, flips planning→active, writes the first burndown point,
 * and marks the run "success". A connection failing/timing out fails the WHOLE
 * run with a per-connection-attributed error and the sprint stays "planning"
 * (never half-activated, retriable via the same button). This function finishes
 * the run itself on BOTH paths, so the route's own `.catch` is only a
 * last-resort safety net.
 */
export async function runScopedActivation(
  deps: ScopedActivationDeps,
  sprintId: number,
  runId: number,
  activatedAt: string,
  partitions: readonly ScopedActivationPartition[],
): Promise<void> {
  const { repos, snapshotWriter } = deps;
  const nowIso = (): string => deps.now().toISOString();
  try {
    // Shared fetch+persist (throws a per-connection-attributed error on any
    // needed-connection failure → the catch below finishes the run "error").
    const pass = await runScopedFetchAndPersist(repos, sprintId, activatedAt, runId, partitions);

    // ── Activation-only tail ──
    // Capture the baseline otisk per connection (each with its OWN status ids).
    for (const { fetched } of pass.fetches) {
      if (fetched.wps.length > 0) {
        await repos.ticketBaselines.upsertMany(
          fetched.wps.map((wp) =>
            buildBaseline(sprintId, wp, fetched.statusById, activatedAt, "baseline"),
          ),
        );
      }
    }
    // Freeze the baseline total, flip planning→active, first burndown point.
    const baselineTotalHours = await computeBaselineTotalHours(repos, pass.allWps);
    await repos.sprints.activate(sprintId, activatedAt, baselineTotalHours);
    await snapshotWriter.writeSnapshot(sprintId, activatedAt.slice(0, 10));
    // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §3) — this is the OTHER
    // production path that reaches "activation" (the HTTP route's async
    // background body; createSprintLifecycle's own activate()/captureBaseline
    // go through runUpdateCore, which calls this too — see that call site's
    // comment). Same best-effort posture: never throws.
    await fetchAndPersistOffSprintTime(repos, sprintId, partitions, deps.now);
    await repos.sprintUpdateRuns.finish(
      runId,
      "success",
      pass.wpCount,
      pass.changesCount,
      null,
      nowIso(),
    );
  } catch (err) {
    // Sprint stays "planning" (activate() only runs on the success path).
    await repos.sprintUpdateRuns.finish(runId, runFinishStatus(err), null, null, errMessage(err), nowIso());
  }
}

/**
 * SPEC_10 §e — the lifecycle resolves per-connection clients on demand
 * (`buildClientForConnection`) instead of being bound to ONE OpClient. activate
 * (via PATCH shortcut), update, finish and healMissingActivation each contact
 * ONLY the connections their sprint's current tickets actually live on.
 */
export function createSprintLifecycle(deps: SprintLifecycleDeps): SprintLifecycle {
  const { repos, buildClientForConnection, snapshotWriterFactory } = deps;
  const nowIso = (): string => deps.now().toISOString();

  const NOOP_SNAPSHOT_WRITER: SnapshotWriter = {
    writeSnapshot: () => Promise.resolve(),
    writeSnapshotsForActiveSprints: () => Promise.resolve(),
  };

  /**
   * SPEC_10 §e — resolve this sprint's CURRENT items into per-connection
   * partitions. A ticket's connection comes from its work_package_cache row,
   * falling back to the CURRENT connection (pre-Increment-9 single-server
   * behavior). Only NEEDED connections are resolved via buildClientForConnection
   * (which throws a clear per-connection error if a needed one is unavailable);
   * an irrelevant/disconnected connection is never touched. Throws NO_CONNECTION
   * when items exist but no connection can be resolved at all (mirrors the old
   * requireOpClient() the route used to call).
   */
  async function buildPartitions(wpOpIds: number[]): Promise<ScopedActivationPartition[]> {
    const cacheRows = await repos.workPackages.getManyByOpIds(wpOpIds);
    const connByWp = new Map(cacheRows.map((w) => [w.op_id, w.connection_id]));
    const currentConn = await repos.connections.getCurrent();
    const scopeItems = wpOpIds.map((wp) => ({
      wp_op_id: wp,
      connection_id: connByWp.get(wp) ?? currentConn?.id ?? null,
    }));
    const neededIds = resolveNeededConnectionIds(scopeItems);
    if (neededIds.length === 0) {
      throw new AppError("NO_CONNECTION", "No OpenProject connection configured");
    }
    const connById = new Map((await repos.connections.list()).map((c) => [c.id, c]));
    const partitions: ScopedActivationPartition[] = [];
    for (const connId of neededIds) {
      const client = await buildClientForConnection(connId);
      const conn = connById.get(connId);
      partitions.push({
        connectionId: connId,
        label: conn?.label ?? conn?.base_url ?? `connection ${connId}`,
        op: client,
        wpOpIds: scopeItems.filter((s) => s.connection_id === connId).map((s) => s.wp_op_id),
      });
    }
    return partitions;
  }

  /** Best-effort burndown-point writer: a needed connection's client if one was
   * resolved, else the current connection's (or a no-op) — used only to
   * GUARANTEE a first point even for an EMPTY sprint activation. */
  async function bestEffortSnapshotWriter(
    partitions: readonly ScopedActivationPartition[],
  ): Promise<SnapshotWriter> {
    let client: OpClient | null = partitions[0]?.op ?? null;
    if (!client) {
      const currentConn = await repos.connections.getCurrent();
      if (currentConn) {
        try {
          client = await buildClientForConnection(currentConn.id);
        } catch {
          client = null;
        }
      }
    }
    return client ? snapshotWriterFactory(client) : NOOP_SNAPSHOT_WRITER;
  }

  /**
   * UPDATE CORE (shared by activate/update/finish): resolve the sprint's current
   * tickets into per-connection partitions → shared scoped fetch+persist
   * (refresh work_package_cache + derive changelog, per connection) → write a
   * burndown point. SPEC_10 §e generalized this from one bound OpClient to a
   * per-connection resolver, so a sprint with tickets on a different (or an
   * additional, disconnected-but-irrelevant) connection than "current" no longer
   * fails on CONNECTION_DISABLED. Reuses the SAME runScopedFetchAndPersist core
   * as scoped activation.
   */
  async function runUpdateCore(
    sprintId: number,
    activatedAt: string,
    updateRunId: number,
  ): Promise<UpdateCoreResult> {
    // A) SCOPED FETCH — only this sprint's live tickets.
    const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
      (i) => i.outcome !== "removed",
    );
    const wpOpIds = items.map((i) => i.wp_op_id);
    if (wpOpIds.length === 0) {
      return { wpCount: 0, changesCount: 0, fetches: [], allWps: [] };
    }
    const partitions = await buildPartitions(wpOpIds);
    // B–E) refresh cache + derive & persist changelog per connection.
    const pass = await runScopedFetchAndPersist(
      repos,
      sprintId,
      activatedAt,
      updateRunId,
      partitions,
    );
    // F) BURNDOWN POINT for the run's logical "now" (via a needed connection).
    await snapshotWriterFactory(partitions[0]!.op).writeSnapshot(sprintId, nowIso().slice(0, 10));

    // Increment 32 (docs/INCREMENT_32_CONTRACTS.md §3) — off-sprint time
    // report, AFTER step F so it runs on every path that reaches here
    // (manual updates, the 30-min scheduler, activation, grace updates) but
    // never on a frozen sprint (this function is never reached for one — the
    // SPRINT_FROZEN gate is in update()/finish() below). Best-effort by
    // design (see fetchAndPersistOffSprintTime's own doc) — never throws, so
    // it can never turn a successful update run into a reported failure.
    await fetchAndPersistOffSprintTime(repos, sprintId, partitions, deps.now);

    return {
      wpCount: pass.wpCount,
      changesCount: pass.changesCount,
      fetches: pass.fetches,
      allWps: pass.allWps,
    };
  }

  /**
   * Capture a baseline for `sprintId`'s CURRENT items and freeze it as of
   * `activatedAt`. Shared by activate() and healMissingActivation() below —
   * the only difference between them is whether the sprint's status also
   * needs to flip planning→active (repos.sprints.activate() sets it either
   * way, so this body is identical regardless).
   */
  async function captureBaseline(
    sprintId: number,
    activatedAt: string,
  ): Promise<Sprint & { activated_at: string }> {
    const run = await repos.sprintUpdateRuns.start(sprintId, "activation", "manual");
    try {
      const core = await runUpdateCore(sprintId, activatedAt, run.id);
      // Baseline otisk of the sprint's current tickets (captured_at = activatedAt),
      // per connection so each uses its OWN status ids.
      for (const { fetched } of core.fetches) {
        if (fetched.wps.length > 0) {
          await repos.ticketBaselines.upsertMany(
            fetched.wps.map((wp) =>
              buildBaseline(sprintId, wp, fetched.statusById, activatedAt, "baseline"),
            ),
          );
        }
      }
      // Freeze the baseline total (SPEC_05 §4): the leaf-effort sum of the SAME
      // tickets being baselined, override-aware — the ideal-line anchor for
      // burndown so scope creep stays visible against a FIXED total. Same
      // double-counting + effectiveEstimate helpers as sprintLeafPlanned/capacity.
      const baselineTotalHours = await computeBaselineTotalHours(repos, core.allWps);
      const updated = await repos.sprints.activate(sprintId, activatedAt, baselineTotalHours);
      // Guarantee a first burndown point even for an empty sprint (where the
      // shared core short-circuits before writing one).
      const snapshotWriter = await bestEffortSnapshotWriter(core.fetches.map((f) => f.partition));
      await snapshotWriter.writeSnapshot(sprintId, activatedAt.slice(0, 10));
      await repos.sprintUpdateRuns.finish(
        run.id,
        "success",
        core.wpCount,
        core.changesCount,
        null,
        nowIso(),
      );
      return updated as Sprint & { activated_at: string };
    } catch (err) {
      await repos.sprintUpdateRuns.finish(run.id, runFinishStatus(err), null, null, errMessage(err), nowIso());
      throw err;
    }
  }

  /**
   * Self-healing repair (found via live production use, not in the original
   * spec): a sprint can reach status="active" with activated_at STILL NULL —
   * either it predates the sprint-lifecycle feature entirely (activated_at
   * was added by a later migration with no default, so pre-existing "active"
   * rows got NULL, not a synthesized value), or it went through the
   * PATCH-shortcut's offline fallback while OP was briefly unreachable. That
   * combination made the sprint PERMANENTLY stuck: activate() only accepts
   * status="planning", so there was no way back in, and update()/finish()
   * both hard-required activated_at — the sprint just sat there 409ing
   * "not been activated" forever despite clearly being in active use.
   * Fix: the first time update()/finish() sees this combination, retroactively
   * capture a baseline from whatever the sprint holds RIGHT NOW (there's no
   * historical baseline to recover, so "now" is the best available anchor)
   * instead of throwing. A genuinely never-activated "planning" sprint is
   * UNCHANGED — this only fires for the specific broken combination.
   */
  async function healMissingActivation(
    sprintId: number,
    sprint: Sprint,
  ): Promise<Sprint & { activated_at: string }> {
    if (sprint.activated_at !== null) {
      return sprint as Sprint & { activated_at: string };
    }
    if (sprint.status !== "active") {
      throw new AppError(
        "SPRINT_NOT_ACTIVE",
        `Sprint "${sprint.name}" has not been activated`,
        { sprintName: sprint.name },
      );
    }
    return captureBaseline(sprintId, nowIso());
  }

  return {
    async activate(sprintId: number): Promise<Sprint> {
      const sprint = await repos.sprints.getById(sprintId);
      if (sprint === null) {
        throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
      }
      if (sprint.status !== "planning") {
        throw new AppError(
          "SPRINT_NOT_PLANNING",
          `Sprint "${sprint.name}" is not in planning (status: ${sprint.status})`,
          { sprintName: sprint.name },
        );
      }
      return captureBaseline(sprintId, nowIso());
    },

    async update(sprintId: number, triggeredBy: UpdateRunTriggeredBy): Promise<SprintUpdateRun> {
      const sprint = await repos.sprints.getById(sprintId);
      if (sprint === null) {
        throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
      }
      const activatedSprint: Sprint & { activated_at: string } =
        sprint.activated_at === null
          ? await healMissingActivation(sprintId, sprint)
          : (sprint as Sprint & { activated_at: string });
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2a) — a FROZEN sprint
      // rejects update runs outright (reactivate to unfreeze). A sprint that
      // is merely locked-but-not-yet-frozen is the post-finish GRACE WINDOW —
      // the whole point of this increment is that late time logs and final
      // status flips still arrive during it, so `is_locked` alone (the old
      // SPRINT_LOCKED gate) is deliberately NOT checked here any more; only
      // `frozen_at` is. Every OTHER `is_locked` check in this codebase (scope
      // edits, capacity writes, delete guards, …) is untouched — the lock
      // still means "no planning changes", grace only re-opens UPDATE RUNS.
      if (activatedSprint.frozen_at !== null) {
        throw new AppError(
          "SPRINT_FROZEN",
          `Sprint "${activatedSprint.name}" is frozen — reactivate it to unfreeze`,
          { sprintName: activatedSprint.name },
        );
      }
      const run = await repos.sprintUpdateRuns.start(sprintId, "update", triggeredBy);
      try {
        const core = await runUpdateCore(sprintId, activatedSprint.activated_at, run.id);
        return await repos.sprintUpdateRuns.finish(
          run.id,
          "success",
          core.wpCount,
          core.changesCount,
          null,
          nowIso(),
        );
      } catch (err) {
        await repos.sprintUpdateRuns.finish(run.id, runFinishStatus(err), null, null, errMessage(err), nowIso());
        throw err;
      }
    },

    async finish(
      sprintId: number,
      triggeredBy: UpdateRunTriggeredBy,
      lockReason: LockReason,
    ): Promise<ClosureReportResponse> {
      const sprint = await repos.sprints.getById(sprintId);
      if (sprint === null) {
        throw new AppError("SPRINT_NOT_FOUND", `Sprint ${sprintId} not found`);
      }
      // Idempotent once locked: return the stored report, no new run, no throw.
      if (sprint.is_locked) {
        return readStoredClosureReport(repos, sprintId, nowIso());
      }
      const activatedSprint: Sprint & { activated_at: string } =
        sprint.activated_at === null
          ? await healMissingActivation(sprintId, sprint)
          : (sprint as Sprint & { activated_at: string });
      // Final update pass so the closure report reflects the FRESHEST OP state.
      const run = await repos.sprintUpdateRuns.start(sprintId, "final", triggeredBy);
      try {
        const core = await runUpdateCore(sprintId, activatedSprint.activated_at, run.id);
        await repos.sprintUpdateRuns.finish(
          run.id,
          "success",
          core.wpCount,
          core.changesCount,
          null,
          nowIso(),
        );
      } catch (err) {
        await repos.sprintUpdateRuns.finish(run.id, runFinishStatus(err), null, null, errMessage(err), nowIso());
        throw err;
      }
      // Closure + irreversible lock (shared with POST /close).
      return performClosure(repos, sprintId, nowIso(), lockReason);
    },
  };
}
