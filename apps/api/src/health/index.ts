import { EventEmitter } from "node:events";
import type { AggregateHealthColor, ConnectionStatus } from "@osp/contracts";
import type { Repositories } from "@osp/db";

/**
 * Per-connection health tracking (SPEC_02 §4). Every real OP call ("activity",
 * piggybacked via the instrumented client) and every explicit health check
 * ("check", heartbeat / test-now) lands here: the outcome is written to the
 * connection's health columns and an in-process event notifies subscribers
 * (the SSE stream re-sends the health payload on it).
 */

/** Outcome of one OP interaction — matches Agent A's OpHealthResult shape. */
export interface HealthResult {
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

/** "activity" = piggyback on real traffic; "check" = explicit health check. */
export type HealthKind = "activity" | "check";

export interface HealthTracker {
  record(connectionId: number, result: HealthResult, kind: HealthKind): Promise<void>;
  /** Push an immediate SSE update for a change that isn't itself a health
   * probe outcome (Increment 8 §2: the Disconnect/Connect toggle) — without
   * this, the header dot only catches up on the next refreshKey-triggered
   * poll instead of instantly, like every other health change does. */
  notify(): void;
  /** Subscribe to health changes; returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/**
 * Aggregate indicator color across ALL stored connections (SPEC_02 §4):
 * no connections or vault locked → neutral; all ok → green; ≥1 ok and ≥1
 * not-ok → orange; ≥1 fail and 0 ok → red; all unknown → neutral.
 */
export function computeAggregate(
  statuses: ConnectionStatus[],
  vaultLocked: boolean,
): AggregateHealthColor {
  if (vaultLocked || statuses.length === 0) return "neutral";
  const okCount = statuses.filter((s) => s === "ok").length;
  if (okCount === statuses.length) return "green";
  if (okCount > 0) return "orange";
  return statuses.includes("fail") ? "red" : "neutral";
}

export function createHealthTracker(
  repos: Repositories,
  now: () => Date,
): HealthTracker {
  const emitter = new EventEmitter();
  // One listener per open SSE stream — don't warn on many clients.
  emitter.setMaxListeners(0);
  return {
    async record(connectionId, result, kind): Promise<void> {
      await repos.connections.updateHealth(connectionId, {
        last_status: result.ok ? "ok" : "fail",
        last_latency_ms: result.latency_ms,
        last_error: result.error,
        ...(kind === "activity"
          ? { last_activity_at: now().toISOString() }
          : { last_check_at: now().toISOString() }),
      });
      emitter.emit("change");
    },
    notify(): void {
      emitter.emit("change");
    },
    onChange(listener) {
      emitter.on("change", listener);
      return () => {
        emitter.off("change", listener);
      };
    },
  };
}
