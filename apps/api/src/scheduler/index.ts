import cron, { type ScheduledTask } from "node-cron";
import type { SnapshotWriter } from "@osp/sync";

/**
 * Nightly scheduler (SPEC §5). For each ACTIVE sprint it runs the injected
 * @osp/sync snapshot writer, which does an incremental sync + writes a
 * burndown_snapshot. Without this job, burndown only starts the day the app is
 * first opened — it is mandatory, not nice-to-have.
 *
 * The snapshot writer is INJECTED so tests never need a real OP. Default cron is
 * 02:00 nightly, configurable via `cron` or OSP_SNAPSHOT_CRON.
 */
export interface SchedulerDeps {
  snapshotWriter: SnapshotWriter;
  /** Cron expression; configurable. Default: "0 2 * * *" (02:00 nightly). */
  cron?: string;
  /** ISO-date provider (defaults to today's date). */
  today?: () => string;
  /** Error sink (defaults to console.error). */
  onError?: (err: unknown) => void;
}

export interface Scheduler {
  stop(): void;
  /** Run the nightly body once, immediately (used by tests / manual trigger). */
  runNow(): Promise<void>;
}

export const DEFAULT_SNAPSHOT_CRON = "0 2 * * *";

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const cronExpr =
    deps.cron ?? process.env.OSP_SNAPSHOT_CRON ?? DEFAULT_SNAPSHOT_CRON;
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  const onError = deps.onError ?? ((err) => console.error("[scheduler]", err));

  const runNow = async (): Promise<void> => {
    await deps.snapshotWriter.writeSnapshotsForActiveSprints(today());
  };

  const task: ScheduledTask = cron.schedule(cronExpr, () => {
    void runNow().catch(onError);
  });

  return {
    stop: () => task.stop(),
    runNow,
  };
}
