import { describe, expect, it, vi } from "vitest";
import type { SnapshotWriter } from "@osp/sync";
import { startScheduler } from "./index";

describe("nightly scheduler", () => {
  it("runNow drives the injected snapshot writer for active sprints", async () => {
    const writeSnapshotsForActiveSprints = vi.fn().mockResolvedValue(undefined);
    const writer: SnapshotWriter = {
      writeSnapshot: vi.fn().mockResolvedValue(undefined),
      writeSnapshotsForActiveSprints,
    };
    const scheduler = startScheduler({
      snapshotWriter: writer,
      cron: "0 2 * * *",
      today: () => "2026-06-10",
    });
    await scheduler.runNow();
    scheduler.stop();
    expect(writeSnapshotsForActiveSprints).toHaveBeenCalledTimes(1);
    expect(writeSnapshotsForActiveSprints).toHaveBeenCalledWith("2026-06-10");
  });
});
