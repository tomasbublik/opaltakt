import { describe, expect, it } from "vitest";
import type { SnapshotWriter } from "@osp/sync";
import { addConnection, buildTestApp, initVault } from "../test-utils";

/**
 * POST /api/snapshot (SPEC_03 §6): runs the nightly snapshot body on demand for
 * a caller-chosen date, so external tooling (the scenario mock's advance-day
 * helper) can build a burndown day-by-day.
 */
describe("POST /api/snapshot", () => {
  function recordingWriter(dates: string[]): SnapshotWriter {
    return {
      writeSnapshot: () => Promise.resolve(),
      writeSnapshotsForActiveSprints: (date) => {
        dates.push(date);
        return Promise.resolve();
      },
    };
  }

  it("writes snapshots for the given date and reports active sprints", async () => {
    const dates: string[] = [];
    const t = await buildTestApp({
      snapshotWriterFactory: () => recordingWriter(dates),
    });
    await initVault(t);
    await addConnection(t);
    // One active + one planning sprint → only the active one counts.
    const s = await t.repos.sprints.create({
      name: "S1",
      start_date: "2026-07-01",
      end_date: "2026-07-14",
      status: "planning",
      capacity_mode: "per_person",
    });
    await t.repos.sprints.update(s.id, { status: "active" });
    await t.repos.sprints.create({
      name: "S2",
      start_date: "2026-07-15",
      end_date: "2026-07-28",
      status: "planning",
      capacity_mode: "per_person",
    });

    const res = await t.app.inject({
      method: "POST",
      url: "/api/snapshot",
      payload: { date: "2026-07-03" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ date: "2026-07-03", active_sprints: 1 });
    expect(dates).toEqual(["2026-07-03"]);
    await t.close();
  });

  it("defaults the date to today and needs an unlocked vault", async () => {
    const dates: string[] = [];
    const t = await buildTestApp({
      snapshotWriterFactory: () => recordingWriter(dates),
      now: () => new Date("2026-07-10T12:00:00Z"),
    });
    await initVault(t);
    await addConnection(t);

    const ok = await t.app.inject({ method: "POST", url: "/api/snapshot" });
    expect(ok.statusCode).toBe(200);
    expect(dates).toEqual(["2026-07-10"]);

    await t.app.inject({ method: "POST", url: "/api/vault/lock" });
    const locked = await t.app.inject({ method: "POST", url: "/api/snapshot" });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe("VAULT_LOCKED");
    await t.close();
  });
});
