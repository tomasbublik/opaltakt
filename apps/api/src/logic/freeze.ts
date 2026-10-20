import type { Repositories } from "@osp/db";
import { DEFAULT_ACTIVATION_TIMEOUT_MS, withTimeout, type OpClient } from "@osp/op-client";
import type { AppDeps } from "../deps";
import { connTokenBlob } from "../vault/index";
import { baselineRemaining, refreshClosureArtifacts } from "./closure";
import { effectiveEstimate } from "./estimate";
import type { SprintLifecycle } from "./sprintUpdate";

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §0/§2b) — the freeze engine.
 *
 * §0's design pillar: freeze is a SNAPSHOT, never a sync carve-out. This file
 * does not touch the sync engine or its scope selection at all — it only
 * (a) runs one last best-effort lifecycle update so late grace-window data
 * lands, (b) re-bakes the closure artifacts from whatever is now live, (c)
 * copies the resulting per-item numbers onto `sprint_item.frozen_*`, and
 * (d) flips `sprint.frozen_at`. After that, every read surface listed in §2c
 * prefers the snapshot — the live `work_package_cache` row becomes
 * irrelevant to this sprint, so it may keep refreshing or be deleted
 * (Import cleanup) without moving a single number (CAPACITY_BAR_RULES §6
 * invariant 10).
 */

/**
 * Pure helper — the instant after which a closed+locked sprint's post-finish
 * grace period is due. End-of-LOCAL-day convention, generalized from
 * `scheduler/sprintUpdates.ts`'s `endOfLocalDay(end_date)` (which formats a
 * bare `YYYY-MM-DD` date-only string and relies on `new Date(...)` parsing a
 * timezone-less string as local time) to an arbitrary INSTANT
 * (`sprint.locked_at`, a full timestamptz) plus a day count: read
 * `lockedAt`'s LOCAL calendar date via the multi-arg `Date` accessors (always
 * local, no string-parsing timezone subtlety to get right), add
 * `graceDays`, and land on 23:59:59.999 of that day. `graceDays = 0` means
 * "due at the end of the very day the sprint finished" — the documented
 * "freeze at the first sweep after finish" case (`report_config` doc
 * comment), since any sweep tick from that moment through midnight qualifies.
 */
export function freezeDeadline(lockedAt: string, graceDays: number): string {
  const locked = new Date(lockedAt);
  const deadline = new Date(
    locked.getFullYear(),
    locked.getMonth(),
    locked.getDate() + graceDays,
    23,
    59,
    59,
    999,
  );
  return deadline.toISOString();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface FreezeDeps {
  repos: Repositories;
  /**
   * Already resolved for THIS sprint's connections (SPEC_10 §e — same shape
   * the scheduler builds for its own update()/finish() calls per due sprint).
   * `freezeSprint` calls `.update()` on it exactly once, best-effort.
   */
  sprintLifecycle: SprintLifecycle;
  now: () => Date;
  /**
   * Increment 34 — an alternative to `now` for callers that already have a
   * formatted ISO instant (e.g. golden/integration tests that don't want to
   * round-trip through `Date`). Wins over `now` when both are supplied.
   */
  nowIso?: () => string;
  /** Increment 34 — sink for the step-1 "final update failed" warning,
   * defaulting to `console.warn` (unchanged behaviour for every existing
   * caller). Lets a test assert on/silence the message without mocking the
   * console global. */
  log?: (message: string) => void;
}

/**
 * Freeze one sprint (docs/INCREMENT_31_CONTRACTS.md §2b step 2). Caller
 * (the scheduler tick / boot sweep) is responsible for having already decided
 * this sprint is due (`status="closed" && is_locked && frozen_at == null &&
 * now() >= freezeDeadline(locked_at, freeze_grace_days)`) — this function
 * does not re-check the deadline itself, mirroring `sprintLifecycle.update()`
 * not re-checking `is_locked`'s own timing.
 *
 * Step 1 (the final lifecycle update) is the ONE piece of this that talks to
 * OpenProject, and is wrapped in the ordinary `sprint_update_run` job guard
 * via `sprintLifecycle.update(sprintId, "freeze")` — reusing that machinery
 * (kind "update", triggered_by "freeze") is what gives this pass crash
 * recovery (`sprintUpdateRuns.recoverOrphaned()`) and watchdog coverage, per
 * the contract. Steps 2–4 are pure local DB writes with no I/O that can hang,
 * so they run directly in this function's body rather than inside a second
 * wrapping job — reusing the SAME already-finished run for bookkeeping they
 * did not produce would be misleading, and giving them their own run would
 * imply they need the same crash-recovery/watchdog treatment OP calls do,
 * which they don't.
 */
export async function freezeSprint(deps: FreezeDeps, sprintId: number): Promise<void> {
  const { repos, sprintLifecycle } = deps;
  const log = deps.log ?? ((message: string) => console.warn(message));

  // 1. Best-effort final update — an OP outage or a locked vault must NOT
  //    block freezing (docs/INCREMENT_31_CONTRACTS.md §2b step 2.1). Whatever
  //    late time logs/status flips made it through the grace window are
  //    picked up if this succeeds; if it doesn't, freezing proceeds on
  //    whatever is already cached — never worse than not freezing at all.
  try {
    await sprintLifecycle.update(sprintId, "freeze");
  } catch (err) {
    log(
      `[freeze] sprint ${sprintId}: final update failed, freezing from already-cached data: ${errMessage(err)}`,
    );
  }

  const nowIso = deps.nowIso ? deps.nowIso() : deps.now().toISOString();

  // 2. Re-bake closure artifacts (outcome baking + closure report) from
  //    whatever is live NOW, WITHOUT touching closed_at/locked_at/lock_reason
  //    — the sprint is already closed+locked; this only refreshes the
  //    artifacts a grace-window update may have changed underneath them.
  await refreshClosureArtifacts(repos, sprintId, nowIso);

  // 3. Snapshot every non-removed item (docs/INCREMENT_31_CONTRACTS.md §1).
  const items = (await repos.sprintItems.listBySprint(sprintId)).filter(
    (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
  );
  if (items.length > 0) {
    const [wps, baselines, overrides, sprint] = await Promise.all([
      repos.workPackages.getManyByOpIds(items.map((i) => i.wp_op_id)),
      repos.ticketBaselines.listBySprint(sprintId),
      repos.estimateOverrides.getManyByWpOpIds(items.map((i) => i.wp_op_id)),
      repos.sprints.getById(sprintId),
    ]);
    const wpById = new Map(wps.map((w) => [w.op_id, w]));
    const baselineByWp = new Map(baselines.map((b) => [b.wp_op_id, b]));
    const overrideByWp = new Map(overrides.map((o) => [o.wp_op_id, o.planning_hours]));

    const rows = items.map((it) => {
      const wp = wpById.get(it.wp_op_id) ?? null;
      const b = baselineByWp.get(it.wp_op_id) ?? null;
      // Estimate of record — IDENTICAL resolution to computeClosureStats
      // today (closureStats.ts's own comment block, Increment 28/§5a): live
      // cache row (falling back to the frozen ticket_baseline) through
      // effectiveEstimate (incl. estimate overrides); a retrospective
      // sprint's reconstructed historical figure or the complete absence of
      // any live source both keep the item's own `planned_hours` snapshot
      // instead.
      const liveEstimated = wp?.estimated_hours ?? b?.estimated_hours ?? null;
      const liveRemaining = wp?.remaining_hours ?? b?.remaining_hours ?? null;
      const hasLiveSource = wp != null || b != null;
      const frozen_effective_hours =
        sprint?.is_retrospective === true || !hasLiveSource
          ? it.planned_hours
          : effectiveEstimate(liveEstimated, liveRemaining, overrideByWp.get(it.wp_op_id) ?? null);
      return {
        item_id: it.id,
        frozen_effective_hours,
        // Assignee/status: live cache preferred, falling back to the frozen
        // baseline (docs/INCREMENT_31_CONTRACTS.md §2b step 3) — the same
        // fallback classification/holder resolution already uses elsewhere
        // in this file's sibling closureStats.ts.
        frozen_assignee_op_id: wp?.assignee_op_id ?? b?.assignee_op_id ?? null,
        frozen_assignee_name: wp?.assignee_name ?? b?.assignee_name_raw ?? null,
        frozen_status_name: wp?.status_name ?? b?.status_name ?? null,
        frozen_status_is_closed: wp?.status_is_closed ?? b?.status_is_closed ?? null,
        // Parent edge + connection: `ticket_baseline` carries neither column
        // (SPEC_09's baseline otisk was never meant to reconstruct ancestry
        // or server attribution), so these are live-cache-only — null when
        // the cache row is already gone, exactly like `wp?.parent_op_id`
        // reads everywhere else in this codebase.
        frozen_parent_op_id: wp?.parent_op_id ?? null,
        frozen_connection_id: wp?.connection_id ?? null,
        // AMENDMENT (§5.5 golden test): items/detailed needs the project id
        // after the cache row is gone — ticket_baseline has no project column.
        frozen_project_op_id: wp?.project_op_id ?? null,
        // Increment 34 (docs/INCREMENT_34_CONTRACTS.md §4) — the live
        // REMAINING hours at freeze time, falling back to the baseline's
        // (never the resolved effective_hours above — a ticket can have a
        // real estimate but no remaining value at all, and that absence must
        // survive as null, not silently become the estimate). The baseline
        // fallback is gap-aware: a journal-gapped reconstructed remaining is
        // unknown, not a number (closure.ts's baselineRemaining).
        frozen_remaining_hours: wp?.remaining_hours ?? baselineRemaining(b),
      };
    });
    await repos.sprintItems.writeFreezeSnapshot(sprintId, rows);
  }

  // 4. Flip frozen_at LAST — every read surface gates on it, so it must only
  //    ever become non-null once the snapshot it points readers at already
  //    exists.
  await repos.sprints.setFrozen(sprintId, nowIso);
}

/**
 * Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — the ONE boot-time sweep
 * `apps/api/src/server.ts`'s `buildServer()` runs (same place
 * `recoverOrphanedRuns` runs), so an app that was down past a sprint's freeze
 * deadline freezes it as soon as it comes back up, instead of waiting for the
 * next 30-minute scheduler tick. Deliberately NOT wired into `buildApp` —
 * `buildApp` is what test harnesses (`test-utils.ts`'s `buildTestApp`) and
 * the read-only `diag.ts` boot, and both must stay write-free at boot.
 *
 * Self-contained (does its own sprint listing AND its own per-connection OP
 * client resolution — the same `connTokenBlob` + vault decrypt + `withTimeout`
 * pattern `index.ts`'s scheduler wiring uses) rather than sharing state with
 * the periodic scheduler, because this runs exactly once, before the
 * scheduler (or anything else) exists yet.
 *
 * Deliberately does NOT gate on `deps.vault.isLocked()` the way the periodic
 * scheduler tick gates its routine updates — an ordinary update is pointless
 * without OP access, but freezing must proceed even with a locked vault
 * (docs/INCREMENT_31_CONTRACTS.md §2b step 2.1: "an OP outage must not block
 * freezing"); `freezeSprint`'s own step 1 already swallows that failure.
 */
export async function sweepOverdueFreezes(
  deps: Pick<AppDeps, "repos" | "vault" | "opClientFactory" | "sprintLifecycleFactory" | "now">,
  onError: (err: unknown) => void = (err) => console.error("[freeze] boot sweep:", err),
): Promise<void> {
  const sprints = await deps.repos.sprints.list();
  const due = sprints.filter(
    (s) => s.status === "closed" && s.is_locked && s.frozen_at === null && s.locked_at !== null,
  );
  if (due.length === 0) return;
  const graceDays = (await deps.repos.reportConfig.get()).freeze_grace_days;
  const nowMs = deps.now().getTime();
  const overdue = due.filter(
    (s) => nowMs >= new Date(freezeDeadline(s.locked_at as string, graceDays)).getTime(),
  );
  await Promise.all(
    overdue.map(async (sprint) => {
      try {
        const buildClientForConnection = async (connectionId: number): Promise<OpClient> => {
          if (deps.vault.isLocked()) {
            throw new Error(`sprint ${sprint.id}: vault locked`);
          }
          const conn = await deps.repos.connections.getById(connectionId);
          if (!conn || !conn.enabled) {
            throw new Error(
              `sprint ${sprint.id}: connection ${connectionId} unavailable (disabled/missing)`,
            );
          }
          const blob = connTokenBlob(conn);
          if (!blob) {
            throw new Error(`sprint ${sprint.id}: connection ${connectionId} has no stored token`);
          }
          return withTimeout(
            deps.opClientFactory({ baseUrl: conn.base_url, token: deps.vault.decryptToken(blob) }),
            DEFAULT_ACTIVATION_TIMEOUT_MS,
          );
        };
        const sprintLifecycle = deps.sprintLifecycleFactory({ buildClientForConnection });
        await freezeSprint({ repos: deps.repos, sprintLifecycle, now: deps.now }, sprint.id);
      } catch (err) {
        onError(err);
      }
    }),
  );
}
