import type { ActivationBlockingConnection } from "@osp/contracts";

/**
 * SPEC_09 §1 — scoped + async sprint activation. GENERALIZED by SPEC_10 §e to
 * update/finish/auto-lock too — see "SPEC_10 §e" section below the original
 * SPEC_09 note; `resolveNeededConnectionIds`/`validateNeededConnections`
 * (pure, tested below) were ALREADY connection-operation-agnostic despite
 * this file's activation-era name, so no change to them was needed, only to
 * who calls them.
 * PHASE 0 DESIGN NOTE: the connection-scoping math is frozen here (pure,
 * tested below); Agent A (packages/op-client — per-connection timeout) and
 * Agent B (apps/api/src/logic/sprintUpdate.ts + routes/index.ts + scheduler —
 * the async job + multi-connection orchestration) wire it in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG (SPEC_09 §1, #1 + #7)
 * ─────────────────────────────────────────────────────────────────────────
 * Today's `POST /sprints/:id/activate` (routes/index.ts) resolves ONE
 * OpClient via `requireOpClient()` (the "current" connection) and awaits
 * `sprintLifecycleFactory(op).activate(id)` INLINE — the HTTP response
 * blocks until it returns. `runUpdateCore` (sprintUpdate.ts) then assumes
 * EVERY sprint ticket lives on that one connection (scheduler/sprintUpdates.ts
 * says as much in its own comment). A sprint whose tickets are all from a
 * mock/local server still pays: (a) no per-connection timeout, so an
 * unrelated disconnected server the CURRENT connection happens to be lags
 * the whole button for minutes, and (b) `requireOpClient()`/downstream calls
 * can throw CONNECTION_DISABLED for a server that isn't even needed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIX — shape
 * ─────────────────────────────────────────────────────────────────────────
 * 1. Resolve "needed connections" LOCALLY (no OP call): distinct non-null
 *    `work_package_cache.connection_id` values across the sprint's current
 *    (non-removed) sprint_item rows. `resolveNeededConnectionIds` below is
 *    this exact pure step — feed it the sprint's wp_op_ids' cached rows.
 *    A wp with NO cache row (connection unknown locally) can't be
 *    pre-validated; it surfaces as a run-time error from whichever
 *    connection's fetch turns out to 404/differ, same as today.
 * 2. Pre-validate BEFORE starting anything (`validateNeededConnections`
 *    below, pure): every needed connection must exist AND be enabled. If
 *    not, the route throws AppError("ACTIVATION_CONNECTIONS_UNAVAILABLE", …,
 *    { connections: blocking }) synchronously — no run is created, nothing
 *    is contacted. This is what makes #4 ("say it BEFORE, not mid-run")
 *    hold: a disconnected-but-irrelevant server never blocks anything (its
 *    id is never in `neededConnectionIds`), and a disconnected NEEDED server
 *    is reported instantly, not after a timeout.
 * 3. If the vault is locked, that also blocks EVERY needed connection at
 *    once — surface it the same way: one blocking entry per needed
 *    connection with `reason: "vault_locked"` (don't special-case a
 *    separate VAULT_LOCKED throw here; the UI already knows how to render
 *    ActivationBlockingConnection rows uniformly).
 * 4. Route creates the sprint_update_run (kind="activation") immediately —
 *    `total_count` = the sprint's current item count (known up front, exactly
 *    like `runUpdateCore`'s existing `sprintUpdateRuns.progress(runId, 0,
 *    wpOpIds.length)` already does) — and returns it as
 *    ActivateSprintResponse. The route does NOT await the OP fetch.
 * 5. The actual work (build one OpClient per needed connection via the
 *    EXISTING `requireOpClientForConnection(connId)`, partition the sprint's
 *    wp_op_ids by their connection, run each connection's scoped fetch
 *    CONCURRENTLY with a per-connection timeout, merge results, upsert
 *    ticket_baseline/work_package_cache, derive changelog, THEN
 *    `repos.sprints.activate(...)` to flip planning→active) runs in the
 *    background — `void runScopedActivation(...).catch(err =>
 *    repos.sprintUpdateRuns.finish(run.id, "error", ..., String(err)))`,
 *    mirroring the fire-and-forget style scheduler/sprintUpdates.ts already
 *    uses for the periodic update tick. On success it calls
 *    `repos.sprints.activate(...)` and `sprintUpdateRuns.finish(run.id,
 *    "success", wpCount, totalCount, changesCount, now)`. On failure the
 *    sprint STAYS "planning" (never half-activated) and the run's `error`
 *    names which connection failed — retriable via the same button.
 * 6. Per-connection timeout: mirror `checkOpHealth`'s AbortController +
 *    `setTimeout(() => controller.abort(), timeoutMs)` pattern
 *    (packages/op-client/src/health.ts) — Agent A adds an equivalent small
 *    helper (e.g. `withTimeout(op, ms)` or a `signal` threaded into
 *    `fetchScopedWorkPackages`/`fetchAllTimeEntries`/`fetchActivitiesByWpIds`)
 *    rather than inventing a new retry/backoff subsystem. Suggested default:
 *    15000 ms per connection — generous for a real OP scoped-by-id query,
 *    short enough that a hung server doesn't visibly stall the progress bar.
 *    Run connections with `Promise.allSettled`, not `Promise.all` — one
 *    connection's timeout must not cancel/lose another connection's
 *    already-fetched data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PARTIAL FAILURE — keep it simple for v1
 * ─────────────────────────────────────────────────────────────────────────
 * A connection that PASSED pre-validation (enabled, vault unlocked) but
 * fails/times out DURING the run (rare — real transient network issue) fails
 * the WHOLE activation run with a clear per-connection-attributed error
 * message (`sprint_update_run.error`), sprint stays "planning". Do not build
 * partial-baseline / retry-just-this-connection machinery for v1 — the
 * pre-validation step is what SPEC_09 §1 actually asks for; an in-flight
 * failure after that point is the same class of rare error `runUpdateCore`
 * already lets bubble up as SYNC_FAILED-equivalent today.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FRONTEND POLLING — no new endpoint
 * ─────────────────────────────────────────────────────────────────────────
 * `GET /sprints/:id/updates` already returns SprintUpdateRun[] newest-first,
 * kind included. SprintControls.updateNow() (apps/web/SprintBoardScreen.tsx)
 * ALREADY polls this exact endpoint on a 500ms interval for "Update Sprint"
 * — Agent C's async `activate()` should be the SAME pattern (kick off, start
 * polling, stop on settle), filtered to the run this activate() call itself
 * started (or simply the newest run — activation and update never race,
 * since update requires status="active" and activation requires "planning").
 */

/**
 * Consolidation Round (Concept 9 / Escalation A) — the app has TWO deliberately
 * different multi-connection policies for a sprint whose tickets span several OP
 * connections when one of them is down. They DISAGREE on purpose; this named
 * enum + the cross-referencing doc comments exist so a future engineer never
 * "fixes" one to match the other without realizing the divergence is intentional
 * (the exact "make one path behave like the other" mistake this round exists to
 * prevent). The frozen decision (CONSOLIDATION_PLAN.md, Escalation A):
 *
 *  - `requireAll` — Activation / Update / Finish (this file's
 *    `validateNeededConnections` gate + sprintUpdate.ts's
 *    `runScopedFetchAndPersist`): EVERY needed connection must be up. If ANY is
 *    disabled/unreachable/vault-locked the whole operation fails FAST
 *    (409 ACTIVATION_CONNECTIONS_UNAVAILABLE) BEFORE any run is created or any
 *    baseline frozen. Rationale: a frozen baseline / committed update pass built
 *    from only SOME of a sprint's connections would be silently WRONG (a
 *    baseline_total_hours missing one server's tickets), not merely incomplete —
 *    worse than a clear failure demanding the user reconnect first.
 *
 *  - `isolate` — background sync / refresh-all (routes/index.ts's
 *    `ConnectionSyncOutcome` loop): SKIP a down connection, report it
 *    (status:"skipped", message:"disconnected"), and keep syncing the healthy
 *    ones. Rationale: a refresh just re-reads existing data — a partial refresh
 *    is strictly better than none, and each connection reports its own outcome.
 *
 * Both are asserted explicitly by consolidation-invariants.test.ts Invariant #2.
 */
export const CONNECTION_MULTI_POLICY = {
  /** Activation/Update/Finish — fail fast if ANY needed connection is down. */
  requireAll: "requireAll",
  /** Background sync / refresh-all — skip a down connection, continue. */
  isolate: "isolate",
} as const;
export type ConnectionMultiPolicy =
  (typeof CONNECTION_MULTI_POLICY)[keyof typeof CONNECTION_MULTI_POLICY];

/** One sprint item's locally-known source connection (from work_package_cache). */
export interface ActivationScopeItemInput {
  wp_op_id: number;
  /** null when the ticket has no cache row (unknown locally — see note above). */
  connection_id: number | null;
}

/**
 * Pure step 1: which connections does this sprint's CURRENT scope actually
 * need? Distinct, non-null, order-stable (first-seen) — order doesn't matter
 * functionally but stable output makes tests/snapshots deterministic.
 */
export function resolveNeededConnectionIds(items: readonly ActivationScopeItemInput[]): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const it of items) {
    if (it.connection_id === null || seen.has(it.connection_id)) continue;
    seen.add(it.connection_id);
    ids.push(it.connection_id);
  }
  return ids;
}

/** Minimal connection shape this pure validator needs — matches OpConnection. */
export interface ConnectionAvailabilityInput {
  id: number;
  base_url: string;
  label: string | null;
  enabled: boolean;
}

/**
 * Pure step 2: which of the needed connections are unusable right now, and
 * why. `vaultLocked` blocks every needed connection uniformly (a locked
 * vault means NO connection can be resolved into a client, regardless of its
 * own enabled/disabled state).
 *
 * This is the `requireAll` half of {@link CONNECTION_MULTI_POLICY}: it returns
 * EVERY blocking connection (not just the first), and its caller
 * (routes/index.ts's activate/update/finish) fails the whole operation if the
 * returned list is non-empty — never a partial run. Contrast refresh-all's
 * `isolate` policy, which would instead skip each blocking connection and
 * continue. Do NOT change this to isolate-and-continue without re-reading
 * Escalation A — the divergence is deliberate.
 */
export function validateNeededConnections(
  neededConnectionIds: readonly number[],
  connections: readonly ConnectionAvailabilityInput[],
  vaultLocked: boolean,
): ActivationBlockingConnection[] {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const blocking: ActivationBlockingConnection[] = [];
  for (const id of neededConnectionIds) {
    const conn = byId.get(id);
    if (!conn) {
      blocking.push({ connection_id: id, base_url: "unknown", label: null, reason: "not_found" });
      continue;
    }
    if (vaultLocked) {
      blocking.push({
        connection_id: conn.id,
        base_url: conn.base_url,
        label: conn.label,
        reason: "vault_locked",
      });
      continue;
    }
    if (!conn.enabled) {
      blocking.push({
        connection_id: conn.id,
        base_url: conn.base_url,
        label: conn.label,
        reason: "disabled",
      });
    }
  }
  return blocking;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * SPEC_10 §e — generalize connection-scoping to update/finish/auto-lock
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG: `POST /sprints/:id/update` and `POST /sprints/:id/finish`
 * (routes/index.ts) still each resolve ONE OpClient via `requireOpClient()`
 * (the "current" connection) and hand it to
 * `deps.sprintLifecycleFactory(op).update(...)`/`.finish(...)`, which
 * internally calls `runUpdateCore` — bound, via `createSprintLifecycle`'s
 * closure, to that SAME single `op` for its entire lifetime. A sprint whose
 * tickets all live on a DIFFERENT (or additionally on a disconnected,
 * irrelevant) connection than "current" hits CONNECTION_DISABLED on Update
 * Sprint / Finish, exactly the SPEC_09 §1 bug, just on a different route.
 * The scheduler (scheduler/sprintUpdates.ts) has the SAME shape one level up:
 * it resolves ONE client/lifecycle pair ONCE per tick and reuses it for
 * EVERY due sprint's update()/finish() call, regardless of which connections
 * each individual sprint actually needs.
 *
 * THE FIX — reuse, don't reinvent: `runScopedActivation` (sprintUpdate.ts,
 * already implemented for SPEC_09 §1) already does "fetch every needed
 * connection concurrently via Promise.allSettled, persist per connection,
 * fail the whole run with a per-connection-attributed error if any needed
 * connection fails" — exactly what update()/finish() need too, MINUS the
 * activation-specific tail (freezing baseline_total_hours, flipping
 * planning→active). Split `runScopedActivation` into:
 *   1. A shared core — e.g. `runScopedFetchAndPersist(deps, sprintId,
 *      activatedAt, runId, partitions): Promise<{wpCount, changesCount,
 *      allWps, failures}>` — everything runScopedActivation's `try` block
 *      already does UP TO (not including) "Freeze the baseline total, flip
 *      planning→active, first burndown point". Return the failures array
 *      instead of throwing, so callers decide how to report them (activation
 *      throws to trigger its own run.finish("error", ...); update/finish can
 *      do the same, synchronously, no fire-and-forget needed here — SPEC_10
 *      does NOT ask update/finish to become async jobs, only to stop
 *      contacting irrelevant/disconnected connections, and the SEC_09
 *      withTimeout cap (15s default) already bounds worst-case latency per
 *      connection, which is what actually made activation intolerably slow
 *      before it existed).
 *   2. `runScopedActivation` keeps its existing activation-only tail, now
 *      calling the extracted core instead of duplicating the fetch/persist
 *      loop.
 *   3. NEW: update()/finish() (createSprintLifecycle, sprintUpdate.ts) each
 *      resolve their OWN partitions per call instead of using one bound
 *      `op`. `SprintLifecycleDeps` needs to change from a single bound `op:
 *      OpClient` to something that can build a client PER connection id —
 *      e.g. replace `op: OpClient` with `buildClientForConnection:
 *      (connectionId: number) => Promise<OpClient>` (a small closure the
 *      route/scheduler supplies, wrapping their own
 *      requireOpClientForConnection/equivalent + withTimeout). `update()`/
 *      `finish()` then: list the sprint's current items → local
 *      work_package_cache lookup → `resolveNeededConnectionIds` →
 *      `validateNeededConnections` (throw ACTIVATION_CONNECTIONS_UNAVAILABLE-
 *      style — consider a more neutrally-named error since this now also
 *      fires for update/finish, e.g. keep the SAME error code since its
 *      shape/handling is already correct and frontend-visible, or add a
 *      sibling; your call, just keep the {connections: blocking} detail
 *      shape) → `buildClientForConnection` per needed id → partitions →
 *      `runScopedFetchAndPersist`. `healMissingActivation` (the self-healing
 *      path) needs the same treatment since it also calls `runUpdateCore`.
 *   4. Route wiring (routes/index.ts): `/update` and `/finish` handlers stop
 *      calling `requireOpClient()` + `sprintLifecycleFactory(op)` and instead
 *      construct the lifecycle with a `buildClientForConnection` closure
 *      (mirroring `/activate`'s existing `requireOpClientForConnection`
 *      per-id calls) — no behavior change for a single-connection sprint,
 *      only for a multi/other-connection one.
 *   5. Scheduler (scheduler/sprintUpdates.ts): `SprintUpdateSchedulerDeps`
 *      currently exposes `getClientConfig()` (the ONE current connection)
 *      and builds ONE `sprintLifecycleFactory(op)` for the whole tick. Change
 *      to a per-connection resolver — e.g. `getClientConfigForConnection
 *      (connectionId): Promise<{baseUrl, token} | null>` plus
 *      `listConnections(): Promise<{id, enabled}[]>` — and build EACH due
 *      sprint's own `buildClientForConnection` closure + lifecycle inside
 *      the `due.map(async (sprint) => ...)` loop, not once outside it. A
 *      sprint whose needed connection is unavailable this tick logs via the
 *      existing `onError` and is skipped — it must NOT abort other sprints'
 *      ticks (already true structurally, just don't regress it).
 *
 * TESTS THAT MUST STILL PASS (regression bar, not exhaustive): every
 * existing single-connection activate/update/finish/scheduler test in
 * apps/api/src/routes/*.test.ts and apps/api/src/scheduler/*.test.ts — this
 * is a pure generalization, a sprint whose tickets all share ONE connection
 * (every existing test's setup) must behave IDENTICALLY to before.
 */
