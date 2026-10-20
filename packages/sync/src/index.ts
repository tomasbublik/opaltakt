import type { OpId, SyncKind, SyncRun, WorkPackageCache } from "@osp/contracts";
import { DEFAULT_REMAINING_STATUSES } from "@osp/contracts";
import type {
  BurndownRepository,
  NewWorkPackageCache,
  ProjectRepository,
  RemainingStatusRuleRepository,
  SprintItemRepository,
  SprintRepository,
  SyncRunRepository,
  SyncWatermarkRepository,
  WorkPackageCacheRepository,
} from "@osp/db";
import type {
  OpClient,
  OpStatus,
  OpTimeEntry,
  OpWorkPackage,
} from "@osp/op-client";
import {
  fetchAllTimeEntries,
  fetchAllWorkPackages,
  isOpCancelledError,
  parseIsoDuration,
  parseOpId,
  withHardCancel,
} from "@osp/op-client";

/**
 * @osp/sync — sync engine + burndown snapshot writer (SPEC §5–6).
 *
 * PURE (no cron, no timers). apps/api (Agent B) wires node-cron and calls the
 * pure functions exposed here.
 *
 *  - incremental/full paginated sync (updatedAt >= last_synced_at),
 *  - time-entries aggregation for burndown / spent_hours,
 *  - reconciliation of drift (WP removed from OP → outcome=removed),
 *  - snapshot writer for active sprints (nightly job body).
 */

// ── Sync engine ──────────────────────────────────────────────────────────────

export interface SyncEngineDeps {
  op: OpClient;
  projects: ProjectRepository;
  workPackages: WorkPackageCacheRepository;
  sprintItems: SprintItemRepository;
  syncRuns: SyncRunRepository;
  /**
   * Needed for drift reconciliation (SPEC §6): enumerate sprints → their items.
   * Optional — when omitted, sync skips drift reconciliation.
   * NOTE (Agent A): added beyond the Phase-0 stub; Agent B should pass its
   * SprintRepository when wiring the scheduler so drift is reconciled.
   */
  sprints?: SprintRepository;
  /**
   * Increment 29 (contracts §3) — the per-(connection, project) incremental
   * watermark. OPTIONAL on purpose: unit tests and the snapshot writer build an
   * engine without it, and omitting it must degrade to the pre-Increment-29
   * `maxUpdatedAtOp` cutoff (still widened by the overlap window), never throw.
   */
  watermarks?: SyncWatermarkRepository;
}

export interface SyncOptions {
  projectOpId: OpId;
  /** Narrow the import to a single version of the project (additive imports). */
  versionOpId?: OpId | null;
  /** Omit to auto-pick: full on first run / version-scoped, else incremental. */
  kind?: SyncKind;
  /**
   * Increment 29 (contracts §3) — which OP connection this sync is running
   * against. The engine itself is connection-agnostic (it only ever sees a
   * pre-built OpClient); this is carried purely as the watermark KEY, so
   * connection A's run can never advance connection B's cutoff. Optional and
   * `null`-able: an omitted/legacy-null connection is its own watermark group,
   * exactly like `project.connection_id`'s legacy nulls.
   */
  connectionId?: number | null;
}

/**
 * Increment 29 (SPEC_29 §2, contracts §3) — how far BACK the incremental
 * `updatedAt >=` cutoff is moved from the stored watermark.
 *
 * The race, measured on #11948: `sync()` derived its cutoff from the newest
 * `updated_at_op` already cached. A work package edited in OP *while the run
 * was in flight* gets a timestamp below that maximum, so it never falls inside
 * any later `updatedAt >= cutoff` window and stays stale forever. Overlapping
 * the window by a fixed margin re-fetches a small band of already-current rows
 * (an idempotent upsert — harmless) in exchange for closing the hole. A
 * subtracted cutoff is NEVER clamped forward: a slightly wider window is always
 * the safe direction.
 */
export const SYNC_OVERLAP_WINDOW_MINUTES = 15;

/**
 * Increment 29 (contracts §2) — op ids per `syncByOpIds` OP request. Exported
 * so tests assert the batching against the named constant rather than a magic
 * number. 100 matches OpenProject's default maximum `pageSize`.
 */
export const ID_FETCH_BATCH_SIZE = 100;

/**
 * Result of {@link SyncEngine.syncByOpIds}.
 *
 * ⚠️ `run` is NULLABLE — contracts §2 mandates that an EMPTY `opIds` input
 * creates no `sync_run` at all, which the §2 code block's `run: SyncRun` cannot
 * express. Nullable is the honest typing (the alternative would be a cast that
 * hands the caller a `SyncRun` that does not exist). Callers skip the call when
 * their stale set is empty, so in practice `run` is non-null on every real call.
 */
export interface SyncByOpIdsResult {
  /** The run this fetch recorded, or null when `opIds` was empty (no run made). */
  run: SyncRun | null;
  /** op ids OP returned and this run committed to the live cache. */
  refreshedOpIds: OpId[];
  /** requested but ABSENT from OP's response → orphan candidates (contracts §4.2). */
  missingOpIds: OpId[];
}

export interface SyncEngine {
  /** Run a sync for a project; records a sync_run row. */
  sync(options: SyncOptions): Promise<SyncRun>;
  /**
   * Increment 29 (contracts §2) — refresh an explicit SET of work packages by
   * OP id, in batches of {@link ID_FETCH_BATCH_SIZE}, as ONE `sync_run`.
   *
   * This is the coverage pass's engine: after the selection-scoped syncs, every
   * cached row that was NOT refreshed (whatever the reason — a version outside
   * the selection, a ticket added by id, a project that left the selection) is
   * handed here by op id. It replaces apps/api's N+1 one-request-per-orphan loop
   * and yields orphan detection for free: an id that OP does not return is a
   * candidate (REPORTED, never deleted — contracts §4.2).
   *
   * Same rollback contract as `sync()`: staged per batch, committed exactly once
   * at the end, cancellation (DB flag or hard signal) drops staging and finishes
   * `"aborted"` having written nothing. Read-only to OP.
   */
  syncByOpIds(opIds: OpId[], signal?: AbortSignal): Promise<SyncByOpIdsResult>;
  /**
   * Fetch ONE work package by its OP id (a GET id-filter query) and cache it.
   * Returns the cached row, or null if OP has no such work package. Read-only.
   */
  importWorkPackage(opId: OpId): Promise<WorkPackageCache | null>;
  /** Fetch + map ONE work package into a cache row WITHOUT writing it — lets a
   * caller buffer several of these and upsert them together (or discard them
   * entirely on cancellation), same rollback contract as sync(). Increment 23
   * (SPEC_23 §3): accepts an optional external `signal` so a caller running
   * its OWN multi-item loop outside `sync()` (apps/api's orphans pass) can
   * register a controller via `registerHardCancelController` and have a
   * watchdog-triggered `hardCancelRun` actually interrupt THIS fetch too —
   * previously only `sync()`'s own invocations were ever interruptible. */
  fetchWorkPackageRow(opId: OpId, signal?: AbortSignal): Promise<NewWorkPackageCache | null>;
}

/**
 * Increment 20 (SPEC_20 §1/§6) — the HARD-cancel registry. Increment 19's
 * `SyncRunRepository.isCancelled()` is a DB flag polled BETWEEN pages; it
 * cannot interrupt a single hung `await` (the real Increment 19 incident: a
 * page fetch that never resolves — no timeout — leaves the loop stuck
 * forever, so the "between pages" checkpoint is never reached at all). This
 * registry physically aborts whatever OP request is in flight for a given
 * run, the moment cancellation is requested — reaction time bounded by the
 * per-request timeout (≤30s) rather than by "however long the current page
 * takes to resolve, if ever."
 *
 * `sync()` registers a fresh `AbortController` for its own `run.id` right
 * after `syncRuns.start()`, uses `.signal` (composed with a per-request
 * timeout) for every `deps.op.*` call made for the rest of that invocation,
 * and unregisters it in a `finally` (success, error, AND cancellation all
 * unregister — a run's controller must never outlive the run). `apps/api`'s
 * `POST /sync/:runId/cancel` route calls `hardCancelRun(runId)` in ADDITION
 * to (not instead of) `syncRuns.requestCancel(runId)` — the DB flag stays
 * the UI/audit source of truth for `cancel_requested`; this is what actually
 * makes the cancellation happen promptly. A module-level Map is safe here:
 * `apps/api` is confirmed single-process/single-threaded (no cluster/worker
 * threads), so this Map is the same JS heap object the route handler and
 * the in-flight `sync()` call both see.
 *
 * Idempotent by construction: calling `.abort()` on an already-aborted (or
 * already-unregistered/missing) controller is a no-op per the standard
 * AbortController API — `hardCancelRun` returns `false` when no run with
 * that id is currently registered (already finished, or never existed),
 * `true` when it found and aborted one. Never throws.
 */
/** Module-scope singleton — see `hardCancelRun` doc comment for why this is
 * safe. Agent A: register/unregister around every `sync()` invocation. */
const runningSyncControllers = new Map<number, AbortController>();

export function hardCancelRun(runId: number): boolean {
  const controller = runningSyncControllers.get(runId);
  if (controller === undefined) return false;
  controller.abort(new DOMException("Sync cancelled by user", "AbortError"));
  return true;
}

/**
 * Increment 23 (SPEC_23 §3) — lets a caller OUTSIDE `sync()` (apps/api's
 * "orphans" pass, which creates its own `sync_run` directly via
 * `syncRuns.start()` rather than calling `engine.sync()`) participate in the
 * SAME hard-cancel registry `hardCancelRun`/the watchdog use. Before this
 * export, a `sync_run` created by the orphans loop was NEVER registered here
 * at all — `hardCancelRun(thatRunId)` was unconditionally a no-op, so a
 * watchdog-flagged stuck orphans run could never actually be interrupted,
 * only marked aborted in the DB while the underlying fetch kept running.
 * Caller owns registering the controller before I/O and unregistering it in
 * a `finally`, mirroring exactly what `sync()` does for its own runs below.
 */
export function registerHardCancelController(runId: number, controller: AbortController): void {
  runningSyncControllers.set(runId, controller);
}
export function unregisterHardCancelController(runId: number): void {
  runningSyncControllers.delete(runId);
}

/**
 * Consolidation Round (Concept 8) — the SAME hard-cancel machine as
 * `runningSyncControllers` above, but for `sprint_update_run` ids
 * (activation/update/finish/retro-replay). A DELIBERATELY SEPARATE Map: a
 * `sync_run` id and a `sprint_update_run` id are two independent
 * auto-increment id spaces that both start at 1, so a single shared registry
 * would let `hardCancelRun(5)` abort the wrong run. Same single-process safety
 * argument as the sync registry (see `hardCancelRun`'s doc comment). The sprint
 * lifecycle registers a controller when a run starts and unregisters it in a
 * `finally`; `POST /sprints/:id/updates/:runId/cancel` calls
 * `hardCancelSprintUpdateRun(runId)` to physically abort the in-flight OP
 * request — the parity fix for "an activation/update/retro run could only be
 * withTimeout-capped per request, never actually cancelled."
 */
const runningSprintUpdateControllers = new Map<number, AbortController>();

export function hardCancelSprintUpdateRun(runId: number): boolean {
  const controller = runningSprintUpdateControllers.get(runId);
  if (controller === undefined) return false;
  controller.abort(new DOMException("Sprint update cancelled by user", "AbortError"));
  return true;
}
export function registerSprintUpdateController(runId: number, controller: AbortController): void {
  runningSprintUpdateControllers.set(runId, controller);
}
export function unregisterSprintUpdateController(runId: number): void {
  runningSprintUpdateControllers.delete(runId);
}

/**
 * Build the OpenProject `filters` array for a work_packages listing.
 * Always scopes to a project; adds an `updatedAt >= since` clause for
 * incremental syncs (SPEC §5). Exported for unit testing.
 */
export function buildWorkPackagesFilters(args: {
  projectOpId: OpId;
  versionOpId?: OpId | null;
  updatedSince?: string | null;
}): unknown[] {
  const filters: unknown[] = [
    { project: { operator: "=", values: [String(args.projectOpId)] } },
  ];
  if (args.versionOpId != null) {
    filters.push({
      version: { operator: "=", values: [String(args.versionOpId)] },
    });
  }
  if (args.updatedSince) {
    filters.push({
      updatedAt: { operator: ">=d", values: [args.updatedSince] },
    });
  }
  return filters;
}

/** Build a name→isClosed lookup from the statuses collection. */
async function loadStatusClosedMap(op: OpClient): Promise<Map<number, OpStatus>> {
  const statuses = await op.getStatuses();
  const byId = new Map<number, OpStatus>();
  for (const s of statuses._embedded.elements) byId.set(s.id, s);
  return byId;
}

/**
 * Map an OP work package (HAL) into a cache-insert row.
 *
 * `connectionId` is REQUIRED (Consolidation round, Concept 5): every cache row
 * MUST carry which OP connection it came from. It was previously left unset here
 * and stamped separately by each caller — a gap ONE caller (the live Update/
 * Finish pass) silently fell through, letting a brand-new WP land with a NULL
 * connection_id (the "SERVER —" bug class, Increment 22). Making it a required
 * parameter turns a future missing stamp into a compile error, not a silent gap.
 * Pass `null` only where the connection is genuinely unknown at map time (the
 * connection-agnostic background sync engine, which stamps post-hoc via
 * setConnectionIdForProject/setConnectionIdForOpIds).
 */
export function toWorkPackageCacheRow(
  wp: OpWorkPackage,
  statusById: Map<number, OpStatus>,
  spentFallbackHours: number | null,
  connectionId: number | null,
): NewWorkPackageCache {
  const statusId = parseOpId(wp._links.status?.href ?? null);
  const status = statusId !== null ? statusById.get(statusId) : undefined;
  const spentDirect = parseIsoDuration(wp.spentTime ?? null);
  return {
    connection_id: connectionId,
    op_id: wp.id,
    project_op_id: parseOpId(wp._links.project?.href ?? null) ?? 0,
    subject: wp.subject,
    type_name: wp._links.type?.title ?? "",
    status_name: wp._links.status?.title ?? status?.name ?? "",
    status_is_closed: status?.isClosed ?? false,
    assignee_op_id: parseOpId(wp._links.assignee?.href ?? null),
    assignee_name: wp._links.assignee?.title ?? null,
    estimated_hours: parseIsoDuration(wp.estimatedTime),
    remaining_hours: parseIsoDuration(wp.remainingTime),
    spent_hours: spentDirect ?? spentFallbackHours,
    story_points: wp.storyPoints ?? null,
    version_op_id: parseOpId(wp._links.version?.href ?? null),
    version_name: wp._links.version?.title ?? null,
    priority: wp._links.priority?.title ?? null,
    parent_op_id: parseOpId(wp._links.parent?.href ?? null),
    percentage_done: wp.percentageDone ?? null,
    updated_at_op: wp.updatedAt,
    raw_json: JSON.stringify(wp),
  };
}

/** SPEC_20 §6 — the product default per-OP-request timeout (exactly 30 s). */
const OP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Increment 29 (contracts §3) — move an ISO instant back by
 * {@link SYNC_OVERLAP_WINDOW_MINUTES}. An unparseable input is returned
 * unchanged: a malformed stored timestamp must never silently become "now" or
 * throw mid-sync; leaving it as-is preserves today's behaviour exactly.
 * Exported for unit testing.
 */
export function applyOverlapWindow(at: string): string {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  return new Date(ms - SYNC_OVERLAP_WINDOW_MINUTES * 60_000).toISOString();
}

/**
 * Increment 29 (contracts §3, AMENDED) — pick the instant the incremental
 * `updatedAt >=` cutoff is derived from: the EARLIER of the stored watermark
 * and `maxUpdatedAtOp`, never simply "the watermark if there is one".
 *
 * The two timestamps live in DIFFERENT CLOCK DOMAINS, and the first version of
 * this code conflated them:
 *  - `watermark_at` is the run's `started_at`, stamped by the APP server;
 *  - `maxUpdatedAtOp` is an `updatedAt` value produced by the OP server, and the
 *    cutoff is sent BACK to OP to be compared against that same OP clock.
 * The 15-minute window is the tolerance for that skew. Where the skew exceeds
 * it, a watermark-only cutoff lands LATER than the previous one and the
 * incremental sync returns FEWER rows than before — coverage moving backwards,
 * in the change whose entire purpose is coverage. (Reproduced by
 * `tests/src/scenario-e2e.test.ts` S4: the scenario mock's `updatedAt` values
 * sit on the July-2026 scenario calendar while the app's real clock is August,
 * so a watermark cutoff lands a month past every row and the sync returned
 * nothing. Production makes no promise that the app host and the OP host share
 * a clock either.)
 *
 * Taking the minimum costs the watermark nothing: the race it exists to fix is
 * exactly the case where a row cached DURING a run carries an `updatedAt` newer
 * than the run's start (`lastUpdated > watermarkAt`), and there the minimum IS
 * the watermark. In the opposite case the window is merely wider — and
 * contracts §3's standing rule is that a cutoff is never clamped forward,
 * because a slightly wider window is always the safe direction.
 *
 * Unparseable stored values are treated as "no opinion" rather than being
 * compared as NaN (which would make every comparison false and silently pick
 * the wrong side). Exported for unit testing.
 */
export function resolveIncrementalCutoffSource(
  watermarkAt: string | null,
  lastUpdated: string | null,
): string | null {
  if (watermarkAt === null) return lastUpdated;
  if (lastUpdated === null) return watermarkAt;
  const w = Date.parse(watermarkAt);
  const l = Date.parse(lastUpdated);
  if (!Number.isFinite(w)) return lastUpdated;
  if (!Number.isFinite(l)) return watermarkAt;
  return w < l ? watermarkAt : lastUpdated;
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  // Single-ticket fetches (importWorkPackage/fetchWorkPackageRow) aren't part of
  // a cancellable multi-page "run", but a hung single-ticket read must still
  // time out rather than hang forever — wrap ONCE at construction (timeout only,
  // no per-run external signal). `sync()` builds its OWN wrapper per invocation,
  // composing this same timeout with the run-specific hard-cancel signal.
  const opTimed = withHardCancel(deps.op, { timeoutMs: OP_REQUEST_TIMEOUT_MS });

  return {
    async sync(options: SyncOptions): Promise<SyncRun> {
      const { projectOpId } = options;
      const versionOpId = options.versionOpId ?? null;
      const connectionId = options.connectionId ?? null;
      // Decide kind: explicit → honour; else full on first run OR version-scoped
      // import (fetch the whole matching subset), incremental afterwards.
      // NOTE (Increment 29): the kind auto-pick still keys off maxUpdatedAtOp —
      // contracts §3 rule 3 says "maxUpdatedAtOp null → full, UNCHANGED", so an
      // empty project cache stays a full sync even if a watermark row exists
      // (the safe direction; a watermark-only incremental over an empty cache
      // would fetch a thin recent band and call it coverage).
      const lastUpdated = await deps.workPackages.maxUpdatedAtOp(projectOpId);
      const kind: SyncKind =
        options.kind ??
        (versionOpId !== null || lastUpdated === null ? "full" : "incremental");
      // Increment 29 (contracts §3) — the incremental cutoff, in order:
      //   1. the (connection, project) watermark  → watermark_at − 15 min
      //   2. no watermark row                     → maxUpdatedAtOp − 15 min
      //   3. neither                              → full (handled above)
      // `deps.watermarks` omitted degrades to rule 2 and never throws.
      const watermarkAt =
        deps.watermarks === undefined
          ? null
          : await deps.watermarks.get(connectionId, projectOpId);
      const cutoffSource = resolveIncrementalCutoffSource(watermarkAt, lastUpdated);

      const run = await deps.syncRuns.start(kind);
      // SPEC_20 §1 — register a hard-cancel controller for this run BEFORE any OP
      // I/O, and wrap the client so every request composes both a 30 s per-request
      // timeout AND this run's external cancel signal. `POST /sync/:runId/cancel`
      // calls `hardCancelRun(run.id)`, which aborts this controller and physically
      // interrupts whatever request is in flight — the fix for "a single hung page
      // fetch never reaches the between-pages checkpoint."
      const controller = new AbortController();
      registerHardCancelController(run.id, controller);
      const op = withHardCancel(deps.op, {
        timeoutMs: OP_REQUEST_TIMEOUT_MS,
        signal: controller.signal,
      });

      // Hoisted so both the loop and the bottom catch can read the running count.
      let processed = 0;

      // Shared "finish as aborted" path: staging holds this run's partial rows,
      // so a cancellation (DB flag OR hard signal) must drop them — a rollback
      // that leaves work_package_cache byte-identical to before the run.
      const finishAborted = async (): Promise<SyncRun> => {
        await deps.workPackages.dropStaging(run.id);
        return deps.syncRuns.finish(
          run.id,
          "aborted",
          processed,
          null,
          new Date().toISOString(),
        );
      };

      try {
        // Crash-recovery hygiene (SPEC_20 §2): a prior process killed mid-run
        // (the exact incident: "restart the backend to unstick it") can leave
        // orphaned staging rows. Clear them before this run stages anything.
        await deps.workPackages.clearAllStaging();

        const updatedSince =
          kind === "incremental" && cutoffSource !== null
            ? applyOverlapWindow(cutoffSource)
            : null;
        const filters = buildWorkPackagesFilters({ projectOpId, versionOpId, updatedSince });

        // Statuses + PROJECT-SCOPED time entries up front. Scoping time entries by
        // project (instead of a global fetch) is the main real-OP speedup.
        // `project_id` is the real supported filter attribute (SPEC_07 §3's
        // list: entity_type/entity_id/project_id/user_id/ongoing/spent_on/
        // created_at/updated_at/activity_id) — plain `project` isn't on it.
        const teFilters = [
          { project_id: { operator: "=", values: [String(projectOpId)] } },
        ];
        const [statusById, entries] = await Promise.all([
          loadStatusClosedMap(op),
          fetchAllTimeEntries(op, { filters: teFilters }),
        ]);
        const agg = aggregateTimeEntries(entries);

        // Page through work packages, writing each page to STAGING (SPEC_20 §2)
        // as it arrives — small, independently committed batches, never a single
        // giant end-of-run burst. work_package_cache itself is untouched until
        // the explicit merge after a fully successful loop, so every reader stays
        // available for the sync's whole duration. Cancellation is caught two
        // ways: the DB flag polled BETWEEN pages (low-latency for the fast case),
        // and the hard AbortController (interrupts a single hung request/backoff).
        const PAGE_SIZE = 100;
        const wps: OpWorkPackage[] = [];
        let offset = 1;
        for (;;) {
          // Poll before every fetch — a cancel that landed while the previous
          // page's I/O was in flight is honoured before spending another request.
          if (await deps.syncRuns.isCancelled(run.id)) {
            return await finishAborted();
          }
          const page = await op.getWorkPackages({
            filters,
            pageSize: PAGE_SIZE,
            offset,
          });
          const total = page.total;
          if (offset === 1) await deps.syncRuns.progress(run.id, 0, total);
          const els = page._embedded.elements;
          if (els.length > 0) {
            const rows = els.map((wp) =>
              // The background engine has no connection context — it only ever
              // sees a pre-built OpClient; the route stamps connection_id post-hoc
              // via setConnectionIdForProject after the run commits.
              toWorkPackageCacheRow(wp, statusById, agg.byWorkPackage.get(wp.id) ?? null, null),
            );
            // One staging write per PAGE, independently committed.
            await deps.workPackages.stageBatch(run.id, rows);
            wps.push(...els);
            processed += els.length;
            await deps.syncRuns.progress(run.id, processed, total);
          }
          if (offset * PAGE_SIZE >= total || els.length === 0) break;
          offset += 1;
        }

        // One more check before committing: the in-loop poll only fires BETWEEN
        // pages, so a cancel that lands while the LAST page's request is in
        // flight has no later "next page" checkpoint to catch it. Without this,
        // that race would commit staging on a run whose cancel_requested=true.
        // Now the abort path drops the staged rows rather than writing nothing.
        if (await deps.syncRuns.isCancelled(run.id)) {
          return await finishAborted();
        }

        // The loop completed without a cancel — merge every staged row into the
        // live cache in one short, batched operation (the ONLY moment
        // work_package_cache is written).
        await deps.workPackages.commitStaging(run.id);

        // Record project last-synced marker (best-effort; project may be absent).
        const now = new Date().toISOString();
        const project = await deps.projects.getByOpId(projectOpId);
        if (project !== null) {
          await deps.projects.setLastSyncedAt(projectOpId, now);
        }

        // Drift reconciliation (SPEC §6) — needs the full present set + sprints.
        // Skip for version-scoped syncs: they only see one version's WPs, so a
        // sprint item from another version would be wrongly marked removed.
        // NOTE (SPEC_20 §1): the incremental branch runs a SECOND pagination loop
        // (collectProjectWorkPackageIds) that must ALSO go through the
        // hard-cancel-aware `op`, or the exact class of hang stays reachable here.
        if (deps.sprints !== undefined && versionOpId === null) {
          const presentWpOpIds =
            kind === "full"
              ? new Set(wps.map((w) => w.id))
              : await collectProjectWorkPackageIds(op, projectOpId);
          await reconcileDrift(
            {
              sprints: deps.sprints,
              sprintItems: deps.sprintItems,
              workPackages: deps.workPackages,
            },
            { projectOpId, presentWpOpIds, now },
          );
        }

        // Increment 29 (contracts §3) — advance the watermark ONLY on a fully
        // successful run, and only to the run's OWN `started_at`: anything a
        // work package did while this run was in flight has a timestamp at or
        // after that instant, so the next incremental window still covers it.
        // `finished_at`/"now" would skip exactly the changes the fix is about.
        // Placed after drift reconciliation on purpose — a reconciliation
        // failure finishes the run "error", and an "error" run that had already
        // moved its watermark would be a permanent coverage hole.
        if (deps.watermarks !== undefined) {
          await deps.watermarks.set(connectionId, projectOpId, run.started_at);
        }

        return await deps.syncRuns.finish(
          run.id,
          "success",
          processed,
          null,
          new Date().toISOString(),
        );
      } catch (err) {
        // A hard-cancel signal firing surfaces from any wrapped `op` call as an
        // OpCancelledError — a genuine user cancellation, distinct from a
        // network/timeout failure: finish "aborted" and drop staging, same as
        // the DB-flag checkpoints.
        if (isOpCancelledError(err)) {
          return await finishAborted();
        }
        // Genuine failure: best-effort drop of any staged rows so a partial run
        // never leaves orphaned staging (don't let cleanup mask the real error).
        await deps.workPackages.dropStaging(run.id).catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        return await deps.syncRuns.finish(
          run.id,
          "error",
          null,
          message,
          new Date().toISOString(),
        );
      } finally {
        // The controller must NEVER outlive the run — success, error, AND
        // cancellation all unregister here.
        unregisterHardCancelController(run.id);
      }
    },

    async syncByOpIds(opIds: OpId[], signal?: AbortSignal): Promise<SyncByOpIdsResult> {
      // De-duplicate: the caller's stale set is built from cache rows, and a
      // repeated id would both waste a filter slot and be double-counted in
      // progress. Order is preserved (Set keeps insertion order).
      const requested = [...new Set(opIds)];
      // Contracts §2: an EMPTY input creates NO sync_run at all. Recording an
      // instant zero-work run would pollute the sync history the UI shows and,
      // worse, would become the "latest" run — so the guard is explicit rather
      // than relying on the caller always skipping the call.
      if (requested.length === 0) {
        return { run: null, refreshedOpIds: [], missingOpIds: [] };
      }

      // ONE run for the whole pass, kind "full" — SyncKind is a closed enum and
      // is deliberately NOT extended for this (contracts §2/§5).
      const run = await deps.syncRuns.start("full");
      // Same hard-cancel contract as sync(): register BEFORE any OP I/O, and
      // unregister in `finally`. The caller's optional signal is COMPOSED with
      // this run's controller so a watchdog `hardCancelRun(run.id)` really
      // interrupts an in-flight batch (Increment 20), and so does the caller's
      // own abort — either one aborts, neither one is lost.
      const controller = new AbortController();
      registerHardCancelController(run.id, controller);
      const composedSignal =
        signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, signal]);
      const op = withHardCancel(deps.op, {
        timeoutMs: OP_REQUEST_TIMEOUT_MS,
        signal: composedSignal,
      });

      const refreshedOpIds: OpId[] = [];
      const missingOpIds: OpId[] = [];
      let processed = 0;

      const finishAborted = async (): Promise<SyncByOpIdsResult> => {
        // True rollback: the staged rows of this run are dropped, so
        // work_package_cache is byte-identical to before the pass. Nothing was
        // committed, so nothing may be REPORTED as refreshed or missing either.
        await deps.workPackages.dropStaging(run.id);
        const aborted = await deps.syncRuns.finish(
          run.id,
          "aborted",
          processed,
          null,
          new Date().toISOString(),
        );
        return { run: aborted, refreshedOpIds: [], missingOpIds: [] };
      };

      try {
        // NOTE: deliberately NO clearAllStaging() here (contracts §1.5). This
        // pass runs after sync() within the same connection group; clearing all
        // staging from a second place is how a future concurrent-run bug gets in.
        const statusById = await loadStatusClosedMap(op);
        await deps.syncRuns.progress(run.id, 0, requested.length);

        for (let i = 0; i < requested.length; i += ID_FETCH_BATCH_SIZE) {
          // Poll before every batch — a cancel that landed during the previous
          // batch's I/O is honoured before spending another OP request.
          if (await deps.syncRuns.isCancelled(run.id)) return await finishAborted();

          const batch = requested.slice(i, i + ID_FETCH_BATCH_SIZE);
          // Multi-value `id` filter — real OP has always supported it (the mock
          // needed a parity fix to match ANY value rather than the first).
          // fetchAllWorkPackages rather than a single getWorkPackages call: with
          // pageSize === batch size one request is the norm, but an OP instance
          // capping pageSize lower would otherwise make the un-returned ids look
          // MISSING — a false orphan report shown to the user.
          const els = await fetchAllWorkPackages(op, {
            filters: [{ id: { operator: "=", values: batch.map(String) } }],
            pageSize: ID_FETCH_BATCH_SIZE,
          });

          const returned = new Set(els.map((wp) => wp.id));
          for (const id of batch) {
            if (!returned.has(id)) missingOpIds.push(id);
          }

          if (els.length > 0) {
            const rows = els.map((wp) =>
              // spent hours from the WP's own spentTime only: these ids can span
              // any number of projects, so the project-scoped time-entry
              // aggregation sync() does has no meaning here (and a per-WP fetch
              // would restore the N+1 this pass exists to remove). Same choice
              // fetchWorkPackageRow already makes. connection_id stays null —
              // the route stamps it via setConnectionIdForOpIds.
              toWorkPackageCacheRow(wp, statusById, null, null),
            );
            await deps.workPackages.stageBatch(run.id, rows);
            refreshedOpIds.push(...els.map((wp) => wp.id));
          }

          // Progress is measured in REQUESTED ids, not returned ones, so the
          // bar still reaches 100% when part of the set is orphaned.
          processed += batch.length;
          await deps.syncRuns.progress(run.id, processed, requested.length);
        }

        // The second checkpoint (Increment 19's real bug): the in-loop poll only
        // fires BEFORE a batch, so a cancel landing while the LAST batch is in
        // flight has no later checkpoint. Without this, such a run would commit
        // staging despite cancel_requested=true.
        if (await deps.syncRuns.isCancelled(run.id)) return await finishAborted();

        await deps.workPackages.commitStaging(run.id);

        const finished = await deps.syncRuns.finish(
          run.id,
          "success",
          // wp_count = rows actually committed to the live cache (orphans are
          // reported separately and were never fetched).
          refreshedOpIds.length,
          null,
          new Date().toISOString(),
        );
        return { run: finished, refreshedOpIds, missingOpIds };
      } catch (err) {
        if (isOpCancelledError(err)) return await finishAborted();
        // A batch that THROWS is not "everything in it is missing" — an HTTP/
        // network failure finishes the run "error" exactly like sync() does,
        // and reports no orphans at all (guessing here would let a transient
        // 500 be presented to the user as deleted tickets).
        await deps.workPackages.dropStaging(run.id).catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        const errored = await deps.syncRuns.finish(
          run.id,
          "error",
          null,
          message,
          new Date().toISOString(),
        );
        return { run: errored, refreshedOpIds: [], missingOpIds: [] };
      } finally {
        unregisterHardCancelController(run.id);
      }
    },

    async fetchWorkPackageRow(
      opId: OpId,
      signal?: AbortSignal,
    ): Promise<NewWorkPackageCache | null> {
      const op =
        signal === undefined
          ? opTimed
          : withHardCancel(deps.op, { timeoutMs: OP_REQUEST_TIMEOUT_MS, signal });
      return fetchWorkPackageRow(op, opId);
    },

    async importWorkPackage(opId: OpId): Promise<WorkPackageCache | null> {
      const row = await fetchWorkPackageRow(opTimed, opId);
      if (row === null) return null;
      await deps.workPackages.upsertMany([row]);
      return deps.workPackages.getByOpId(opId);
    },
  };
}

/**
 * Fetch ONE work package by its OP id (a GET id-filter query) and map it into a
 * cache-insert row, WITHOUT writing it. Returns null if OP has no such WP. The
 * shared fetch+map body behind both `importWorkPackage` (fetch+write) and
 * `fetchWorkPackageRow` (fetch only, caller owns the write). Read-only to OP.
 */
async function fetchWorkPackageRow(
  op: OpClient,
  opId: OpId,
): Promise<NewWorkPackageCache | null> {
  const statusById = await loadStatusClosedMap(op);
  const collection = await op.getWorkPackages({
    filters: [{ id: { operator: "=", values: [String(opId)] } }],
    pageSize: 1,
  });
  const wp = collection._embedded.elements[0];
  if (wp === undefined) return null;
  // spent_hours from the WP's own spentTime (no time-entry aggregation for a
  // single add); toWorkPackageCacheRow falls back to null when absent. The
  // connection is unknown here (this is the shared fetch-only body) — the
  // caller that owns the write stamps connection_id itself.
  return toWorkPackageCacheRow(wp, statusById, null, null);
}

// ── Time-entry aggregation (reusable) ────────────────────────────────────────

export interface TimeEntryAggregation {
  /** Total logged hours per work package op id. */
  byWorkPackage: Map<number, number>;
  /** Per work package op id → (spentOn date → hours). */
  byWorkPackageDay: Map<number, Map<string, number>>;
  /** Total logged hours per spentOn date (across all WPs). */
  byDay: Map<string, number>;
  /**
   * SPEC_14 §3 — total logged hours per LOGGER, keyed by the op_user_id of the
   * person who booked the time (`_links.user`), NEVER by the ticket's current
   * assignee. This is the load-bearing attribution rule for per-developer
   * closure stats (`dev_logged_hours`): "attribution is by WHO LOGGED THE
   * TIME." `name` is taken straight off the time entry's `_links.user.title`
   * (real OP + the mock both set it — see fixtures/mock-op-server/hal.ts's
   * timeEntryToHal), so no `GET /api/v3/users` call is ever needed. Entries
   * whose user link has a null href (OP couldn't attribute an actor) are
   * skipped here — they still count toward byWorkPackage/byDay totals.
   */
  byLogger: Map<number, { name: string; hours: number }>;
}

/**
 * Aggregate Time Entries per work package and per day (SPEC §5–6), and per
 * LOGGER (SPEC_14 §3). Feeds `spent_hours`, the burndown "logged" (burnup)
 * curve, and the per-developer closure breakdown. Pure function.
 */
export function aggregateTimeEntries(
  entries: OpTimeEntry[],
): TimeEntryAggregation {
  const byWorkPackage = new Map<number, number>();
  const byWorkPackageDay = new Map<number, Map<string, number>>();
  const byDay = new Map<string, number>();
  const byLogger = new Map<number, { name: string; hours: number }>();

  for (const e of entries) {
    const hours = parseIsoDuration(e.hours) ?? 0;
    const wpId = parseOpId(e._links.workPackage?.href ?? null);
    const day = e.spentOn;

    byDay.set(day, (byDay.get(day) ?? 0) + hours);

    if (wpId !== null) {
      byWorkPackage.set(wpId, (byWorkPackage.get(wpId) ?? 0) + hours);
      let perDay = byWorkPackageDay.get(wpId);
      if (perDay === undefined) {
        perDay = new Map<string, number>();
        byWorkPackageDay.set(wpId, perDay);
      }
      perDay.set(day, (perDay.get(day) ?? 0) + hours);
    }

    // Per-logger totals — attribution by whoever booked the time (_links.user).
    const userId = parseOpId(e._links.user?.href ?? null);
    if (userId !== null) {
      const existing = byLogger.get(userId);
      if (existing === undefined) {
        byLogger.set(userId, {
          name: e._links.user?.title ?? `User ${userId}`,
          hours,
        });
      } else {
        existing.hours += hours;
        // A later entry may carry the title when an earlier one didn't.
        if (
          (existing.name === "" || existing.name === `User ${userId}`) &&
          e._links.user?.title
        ) {
          existing.name = e._links.user.title;
        }
      }
    }
  }

  return { byWorkPackage, byWorkPackageDay, byDay, byLogger };
}

// ── Drift reconciliation (SPEC §6) ───────────────────────────────────────────

export interface ReconcileDeps {
  sprints: SprintRepository;
  sprintItems: SprintItemRepository;
  workPackages: WorkPackageCacheRepository;
}

/** Collect all current work-package op ids for a project from OP. */
export async function collectProjectWorkPackageIds(
  op: OpClient,
  projectOpId: OpId,
): Promise<Set<number>> {
  const filters = buildWorkPackagesFilters({ projectOpId });
  const wps = await fetchAllWorkPackages(op, { filters });
  return new Set(wps.map((w) => w.id));
}

/**
 * Mark sprint_items whose work package has disappeared from OP (or moved to
 * another project) with outcome="removed" — never deleting them (SPEC §6).
 *
 * Only items whose cached WP belongs to `projectOpId` are considered, so
 * multi-project sprints are not wrongly touched when syncing one project.
 * Only currently-active ("planned") items are reconciled.
 */
export async function reconcileDrift(
  deps: ReconcileDeps,
  args: { projectOpId: OpId; presentWpOpIds: Set<number>; now?: string },
): Promise<{ removedItemIds: number[] }> {
  const now = args.now ?? new Date().toISOString();
  const removedItemIds: number[] = [];
  const sprints = await deps.sprints.list();

  for (const sprint of sprints) {
    const items = await deps.sprintItems.listBySprint(sprint.id);
    for (const item of items) {
      if (item.outcome !== "planned") continue;
      const cached = await deps.workPackages.getByOpId(item.wp_op_id);
      // Can't tell which project it belonged to → leave it alone.
      if (cached === null) continue;
      if (cached.project_op_id !== args.projectOpId) continue;
      if (!args.presentWpOpIds.has(item.wp_op_id)) {
        await deps.sprintItems.setOutcome(item.id, "removed", now);
        removedItemIds.push(item.id);
      }
    }
  }

  return { removedItemIds };
}

// ── Burndown snapshot writer (SPEC §6) ───────────────────────────────────────

export interface SnapshotWriterDeps {
  op: OpClient;
  sprints: SprintRepository;
  sprintItems: SprintItemRepository;
  workPackages: WorkPackageCacheRepository;
  burndown: BurndownRepository;
  /** SPEC_11 §6 — the burndown "Remaining" allowlist (empty ⇒ default set). */
  remainingStatusRules: RemainingStatusRuleRepository;
}

/**
 * SPEC_11 §6 — the effective "still dev-pending" status set for a sprint's
 * Remaining (blue) line. Empty rule table ⇒ DEFAULT_REMAINING_STATUSES
 * (New/Confirmed/In progress). Case-insensitive/trimmed, matching apps/api's
 * remaining.ts (kept in sync; packages/sync can't import apps/api).
 */
function remainingStatusSet(rules: { status_name: string }[]): Set<string> {
  const names =
    rules.length > 0 ? rules.map((r) => r.status_name) : [...DEFAULT_REMAINING_STATUSES];
  return new Set(names.map((n) => n.trim().toLowerCase()));
}

export interface SnapshotWriter {
  /** Write the burndown_snapshot for one sprint on a given date. */
  writeSnapshot(sprintId: number, date: string): Promise<void>;
  /** Write snapshots for every active sprint (nightly job body). */
  writeSnapshotsForActiveSprints(date: string): Promise<void>;
}

/** Count weekdays (Mon–Fri) in the inclusive date range [start, end]. */
export function countWorkingDays(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  let count = 0;
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const dow = new Date(ms).getUTCDay(); // 0=Sun … 6=Sat
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

/**
 * Ideal remaining effort on `date`: linear decline of total planned effort
 * across the sprint's working days (weekends excluded, SPEC §6). Reaches 0 on
 * the final working day; clamped to [0, totalPlanned].
 */
export function idealRemainingHours(args: {
  totalPlanned: number;
  startDate: string;
  endDate: string;
  date: string;
}): number {
  const totalWorkDays = countWorkingDays(args.startDate, args.endDate);
  if (totalWorkDays <= 0) return 0;
  // Single-day sprint: ideal reaches 0 on its only (final) working day.
  if (totalWorkDays === 1) return 0;
  if (args.date < args.startDate) return args.totalPlanned;
  // Working days elapsed from start through `date` (clamped to the sprint end);
  // day 0 of the sprint has 0 burned, so the day-index is `elapsed - 1`. This
  // matches apps/api's canonical `idealCurve` (full at day 0 → 0 on last day).
  const clampedEnd = args.date < args.endDate ? args.date : args.endDate;
  const elapsed = countWorkingDays(args.startDate, clampedEnd);
  const remaining =
    args.totalPlanned * ((totalWorkDays - elapsed) / (totalWorkDays - 1));
  return Math.max(0, Math.min(args.totalPlanned, remaining));
}

/**
 * Compute (but do not persist) the burndown snapshot numbers for a sprint on a
 * given date. Pure aside from the OP time-entries read. Exported for testing.
 */
export async function computeSnapshot(
  deps: Pick<
    SnapshotWriterDeps,
    "op" | "sprints" | "sprintItems" | "workPackages" | "burndown" | "remainingStatusRules"
  >,
  sprintId: number,
  date: string,
): Promise<{
  sprint_id: number;
  snapshot_date: string;
  remaining_hours: number;
  logged_hours: number;
  ideal_hours: number;
  done_count: number;
  total_count: number;
  /** Increment 12 (SPEC_12 §1): the nightly job writes "live" points; the
   * retrospective replay / rebuild path builds its own "reconstructed" rows
   * (apps/api/src/logic/retro.ts) rather than going through computeSnapshot. */
  source: "live";
} | null> {
  const sprint = await deps.sprints.getById(sprintId);
  if (sprint === null) return null;

  const allItems = await deps.sprintItems.listBySprint(sprintId);
  // Committed = still a live obligation. Excludes BOTH the classic pre-
  // activation "removed" and Increment 5's "removed_mid_sprint" (SPEC_05 §1:
  // a descoped ticket no longer counts as a commitment) — drives
  // remaining/totalPlanned/doneCount/total_count.
  const items = allItems.filter(
    (it) => it.outcome !== "removed" && it.outcome !== "removed_mid_sprint",
  );
  // Logged/burnup keeps counting a ticket descoped mid-sprint (SPEC_05 §1:
  // hours already logged during the sprint stay in the burndown/velocity even
  // after removal) — only the classic pre-activation "removed" drops out.
  const loggedItems = allItems.filter((it) => it.outcome !== "removed");
  const wpIds = items.map((it) => it.wp_op_id);
  const caches = await deps.workPackages.getManyByOpIds(wpIds);
  const cacheById = new Map(caches.map((c) => [c.op_id, c]));

  // Leaf-level effort (SPEC §6 double-counting): drop a parent from the HOURS
  // sums when one of its children is also in the sprint, so parent+child don't
  // both contribute. Counts (done/total) still include every ticket. This keeps
  // the persisted planned/remaining/ideal consistent with the API's leafEffort.
  const parentsWithChildPresent = new Set<number>();
  for (const item of items) {
    const parentId = cacheById.get(item.wp_op_id)?.parent_op_id ?? null;
    if (parentId !== null) parentsWithChildPresent.add(parentId);
  }

  // SPEC_11 §6: the Remaining (blue) line counts ONLY tickets WITH an estimate
  // whose status is in the sprint's remaining allowlist (New/Confirmed/In
  // progress by default) — a POSITIVE allowlist, so On Hold/Developed/Tested/
  // Resolved/Closed/Rejected contribute 0 by construction (they aren't listed).
  const remainingRules = await deps.remainingStatusRules.listBySprint(sprintId);
  const remainingSet = remainingStatusSet(remainingRules);

  let remaining = 0;
  let totalPlanned = 0;
  let doneCount = 0;
  for (const item of items) {
    const wp = cacheById.get(item.wp_op_id);
    const isDone = wp?.status_is_closed ?? false;
    if (isDone) doneCount += 1;
    // Non-leaf parent: counted in done/total, excluded from hours sums.
    if (parentsWithChildPresent.has(item.wp_op_id)) continue;
    totalPlanned += item.planned_hours ?? 0;
    // Remaining: dev-pending status AND a non-null estimate (SPEC_11 §6).
    const inRemainingStatus =
      wp != null && remainingSet.has((wp.status_name ?? "").trim().toLowerCase());
    if (inRemainingStatus && wp.estimated_hours != null) {
      remaining += wp.remaining_hours ?? 0;
    }
  }

  // Logged (burnup): Σ time entries with start_date <= spentOn <= date for the
  // sprint's WPs (incl. mid-sprint-removed tickets — see loggedItems above).
  //
  // The LOWER bound (sprint.start_date) exists because real production tickets
  // are long-lived: without it, every hour ever logged on a ticket — years
  // before the sprint existed — inflated the burnup line, which then STARTED
  // at ~168h instead of 0 on the user's first real sprint. Mock-scenario
  // tickets are born fresh (zero history), so no test or demo ever showed the
  // offset. The burnup answers "how much was worked DURING the sprint" —
  // matching the chart's own x-axis and Closure's sprint-scoped logging.
  // start_date (not activated_at) so day-one work logged before the formal
  // Activate click still counts.
  const entries = await fetchAllTimeEntries(deps.op, {});
  const agg = aggregateTimeEntries(entries);
  const loggedWpIdSet = new Set(loggedItems.map((it) => it.wp_op_id));
  let logged = 0;
  for (const [wpId, perDay] of agg.byWorkPackageDay) {
    if (!loggedWpIdSet.has(wpId)) continue;
    for (const [day, hours] of perDay) {
      if (day >= sprint.start_date && day <= date) logged += hours;
    }
  }

  // SPEC_11 §7: Logged is CUMULATIVE and must never regress — a day where
  // nobody logged new time renders as a FLAT line at yesterday's value, never a
  // drop to 0 (the reported bug). Even though the fresh figure above is already
  // a spentOn<=date cumulative sum, a transient OP read (deleted/reassigned time
  // entry, scoped fetch) can lower it — so clamp to the running max of every
  // EARLIER snapshot's logged_hours, making the stored series monotonic.
  const priorSnapshots = await deps.burndown.listBySprint(sprintId);
  for (const s of priorSnapshots) {
    if (s.snapshot_date < date && s.logged_hours > logged) logged = s.logged_hours;
  }

  // Ideal line anchors on the FROZEN activation baseline once one exists
  // (SPEC_05 §2: scope creep after activation must be visible against a fixed
  // reference) — falls back to the live committed total pre-activation, same
  // as before Increment 5.
  const idealTotal = sprint.baseline_total_hours ?? totalPlanned;
  const ideal = idealRemainingHours({
    totalPlanned: idealTotal,
    startDate: sprint.start_date,
    endDate: sprint.end_date,
    date,
  });

  return {
    sprint_id: sprintId,
    snapshot_date: date,
    remaining_hours: remaining,
    logged_hours: logged,
    ideal_hours: ideal,
    done_count: doneCount,
    total_count: items.length,
    source: "live",
  };
}

/**
 * Write the burndown_snapshot row for one sprint on `date`. PURE async
 * function (no cron) — apps/api schedules the call. Skips silently if the
 * sprint no longer exists.
 */
export async function writeSnapshotForSprint(
  deps: SnapshotWriterDeps,
  sprintId: number,
  date: string,
): Promise<void> {
  const snapshot = await computeSnapshot(deps, sprintId, date);
  if (snapshot === null) return;
  await deps.burndown.upsert(snapshot);
}

/**
 * Write burndown_snapshot rows for every ACTIVE sprint on `date`. This is the
 * nightly job body Agent B calls from its node-cron wiring (SPEC §5). PURE.
 */
export async function writeSnapshotsForActiveSprints(
  deps: SnapshotWriterDeps,
  date: string,
): Promise<void> {
  const active = await deps.sprints.listByStatus("active");
  for (const sprint of active) {
    await writeSnapshotForSprint(deps, sprint.id, date);
  }
}

export function createSnapshotWriter(deps: SnapshotWriterDeps): SnapshotWriter {
  return {
    writeSnapshot(sprintId: number, date: string): Promise<void> {
      return writeSnapshotForSprint(deps, sprintId, date);
    },
    writeSnapshotsForActiveSprints(date: string): Promise<void> {
      return writeSnapshotsForActiveSprints(deps, date);
    },
  };
}
