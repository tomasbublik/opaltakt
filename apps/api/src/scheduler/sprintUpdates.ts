import { DEFAULT_ACTIVATION_TIMEOUT_MS, withTimeout, type OpClient } from "@osp/op-client";
import { freezeDeadline } from "../logic/freeze";
import type { SprintLifecycle } from "../logic/sprintUpdate";

/**
 * Sprint-update scheduler (SPEC_04 §9.1). Every `tickMs` it runs one update
 * pass over every ACTIVE, unlocked sprint — a diff against OP that refreshes
 * the scoped ticket cache and derives changelog entries — and auto-locks any
 * sprint whose end_date has passed local end-of-day, generalizing the base
 * spec's nightly snapshot job into ongoing sprint maintenance.
 *
 * SPEC_10 §e: each due sprint resolves its OWN needed connections (inside the
 * per-sprint loop, via the lifecycle's `buildClientForConnection`), instead of
 * one shared OpClient serving the whole tick. A sprint whose needed connection
 * is unavailable this tick is logged via `onError` and skipped — it must NOT
 * abort the other sprints' ticks (per-sprint try/catch below), and an
 * unrelated/disconnected connection some OTHER sprint uses is never contacted
 * for a sprint that doesn't need it.
 *
 * All collaborators are INJECTED so tests never need a real vault/DB/OP.
 */

export interface SchedulableSprint {
  id: number;
  end_date: string; // YYYY-MM-DD
  status: "planning" | "active" | "closed";
  is_locked: boolean;
  /** Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — when the sprint's
   * lock happened (finish or end-date auto-lock); null for an unlocked
   * sprint. The grace deadline anchors HERE, never `end_date`. */
  locked_at: string | null;
  /** Increment 31 — non-null once the freeze sweep has already run for this
   * sprint. A closed+locked+`frozen_at === null` sprint is the post-finish
   * GRACE WINDOW this scheduler now also services. */
  frozen_at: string | null;
}

export interface SprintUpdateSchedulerDeps {
  /** Sprints to consider this tick — caller (index.ts) filters to
   * status="active" && !is_locked; this module doesn't rely on that being
   * pre-filtered and re-checks defensively before acting on each sprint. */
  listSprints(): Promise<SchedulableSprint[]>;
  /** true → skip the whole tick (vault locked; no tokens available). */
  isVaultLocked(): boolean;
  /** SPEC_10 §e — a SPECIFIC connection's decrypted client config, or null when
   * there's no such connection / it's disabled / no stored token. The lifecycle
   * only asks for the connections a sprint's tickets actually live on. */
  getClientConfigForConnection(
    connectionId: number,
  ): Promise<{ baseUrl: string; token: string } | null>;
  opClientFactory(config: { baseUrl: string; token: string }): OpClient;
  /** Build the lifecycle for one sprint's tick, given a per-connection resolver
   * (SPEC_10 §e). Wired to deps.sprintLifecycleFactory in index.ts. */
  sprintLifecycleFactory(opts: {
    buildClientForConnection: (connectionId: number) => Promise<OpClient>;
  }): SprintLifecycle;
  /** Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — current
   * `report_config.freeze_grace_days`, read fresh EVERY tick (not cached) so
   * a Settings edit takes effect on the very next tick, no restart needed. */
  getFreezeGraceDays(): Promise<number>;
  /**
   * Increment 31 (§2b step 2) — freeze this sprint, reusing the
   * ALREADY-BUILT per-connection `sprintLifecycle` for THIS tick's grace
   * update (above) rather than resolving connections a second time. Wired in
   * index.ts to `logic/freeze.ts`'s `freezeSprint` with `deps.repos` filled
   * in — this module stays decoupled from `@osp/db`.
   */
  freezeSprint(sprintId: number, sprintLifecycle: SprintLifecycle): Promise<void>;
  tickMs?: number; // default 30 * 60 * 1000 (SPEC_04 §9.1: every 30 min)
  /** Per-connection OP timeout (SPEC_09 §1 default 15s). */
  timeoutMs?: number;
  now?: () => Date;
  onError?: (err: unknown) => void; // default console.error; one sprint's failure must not stop the others
}

export interface SprintUpdateScheduler {
  stop(): void;
  /** run one tick immediately (tests/manual) */
  tickNow(): Promise<void>;
}

export const DEFAULT_SPRINT_UPDATE_TICK_MS = 30 * 60 * 1000;

/** A sprint's end_date "23:59:59.999" WITHOUT a timezone designator is parsed
 * as LOCAL time by `new Date(...)` (only bare YYYY-MM-DD is UTC per the JS
 * Date spec) — this gives "local TZ end of day" for free. */
function endOfLocalDay(endDate: string): Date {
  return new Date(`${endDate}T23:59:59.999`);
}

export function startSprintUpdateScheduler(
  deps: SprintUpdateSchedulerDeps,
): SprintUpdateScheduler {
  const tickMs = deps.tickMs ?? DEFAULT_SPRINT_UPDATE_TICK_MS;
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? ((err) => console.error("[sprintUpdates]", err));

  // Overlapping-tick guard: if a tick is still in flight (slow OP calls), the
  // next interval fire is skipped rather than stacking update passes.
  let running = false;

  const timeoutMs = deps.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;

  async function tickNow(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // Vault locked → no token can be decrypted; skip the whole tick.
      if (deps.isVaultLocked()) return;

      const sprints = await deps.listSprints();
      const due = sprints.filter((s) => s.status === "active" && !s.is_locked);
      // Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2b) — the post-finish
      // GRACE WINDOW: closed, locked, not yet frozen. Serviced by the SAME
      // tick as active sprints (grace updates run "each tick", same
      // throttling), just a disjoint set (a sprint is never both).
      const dueGrace = sprints.filter(
        (s) => s.status === "closed" && s.is_locked && s.frozen_at === null && s.locked_at !== null,
      );

      const buildClientForConnectionFor = (sprintId: number) => {
        return async (connId: number): Promise<OpClient> => {
          const config = await deps.getClientConfigForConnection(connId);
          if (config === null) {
            throw new Error(
              `sprint ${sprintId}: connection ${connId} unavailable (disabled / no token)`,
            );
          }
          return withTimeout(deps.opClientFactory(config), timeoutMs);
        };
      };

      // Each sprint's pass runs independently, resolving its OWN needed
      // connections (SPEC_10 §e): the lifecycle asks buildClientForConnection
      // only for the connections this sprint's tickets live on. One sprint's
      // unavailable connection is logged + skipped, never aborting the others.
      await Promise.all([
        ...due.map(async (sprint) => {
          try {
            const sprintLifecycle = deps.sprintLifecycleFactory({
              buildClientForConnection: buildClientForConnectionFor(sprint.id),
            });
            if (now().getTime() >= endOfLocalDay(sprint.end_date).getTime()) {
              // finish() already runs its own update pass internally — do
              // not also call update() for this sprint on this tick.
              await sprintLifecycle.finish(sprint.id, "end_date", "end_date");
            } else {
              await sprintLifecycle.update(sprint.id, "scheduler");
            }
          } catch (err) {
            onError(err);
          }
        }),
        ...dueGrace.map(async (sprint) => {
          const sprintLifecycle = deps.sprintLifecycleFactory({
            buildClientForConnection: buildClientForConnectionFor(sprint.id),
          });
          // (1) Grace update — same cadence as an active sprint's tick (§2b
          // bullet 1). Its own failure must not block the freeze decision
          // below: freezeSprint retries an update itself, best-effort
          // (docs/INCREMENT_31_CONTRACTS.md §2b step 2.1).
          try {
            await sprintLifecycle.update(sprint.id, "scheduler");
          } catch (err) {
            onError(err);
          }
          // (2) Freeze once past `locked_at + freeze_grace_days` (§2b bullet 2).
          try {
            const graceDays = await deps.getFreezeGraceDays();
            const deadline = freezeDeadline(sprint.locked_at as string, graceDays);
            if (now().getTime() >= new Date(deadline).getTime()) {
              await deps.freezeSprint(sprint.id, sprintLifecycle);
            }
          } catch (err) {
            onError(err);
          }
        }),
      ]);
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    void tickNow();
  }, tickMs);
  // Never keep the process alive just for this scheduler.
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
    tickNow,
  };
}
