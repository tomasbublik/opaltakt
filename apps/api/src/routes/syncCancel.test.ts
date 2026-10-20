import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Increment 20 (SPEC_20 §2/§3): POST /sync/:runId/cancel must physically abort
// the in-flight request via @osp/sync's hardCancelRun IN ADDITION to flipping
// the DB cancel_requested flag. We spy on the real export (delegating to the
// actual implementation so nothing else in the sync module changes behaviour)
// and assert the route calls it. Scoped to this file so the module mock never
// leaks into the rest of the suite.
vi.mock("@osp/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@osp/sync")>();
  return {
    ...actual,
    hardCancelRun: vi.fn((runId: number) => actual.hardCancelRun(runId)),
  };
});

import { hardCancelRun } from "@osp/sync";
import { buildTestApp, type TestApp } from "../test-utils";

describe("POST /sync/:runId/cancel — hard cancel wiring (Increment 20)", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
    vi.mocked(hardCancelRun).mockClear();
  });

  afterEach(async () => {
    await t.close();
  });

  it("calls BOTH requestCancel AND hardCancelRun for a running run", async () => {
    const run = await t.repos.syncRuns.start("full");
    const res = await t.app.inject({ method: "POST", url: `/api/sync/${run.id}/cancel` });
    expect(res.statusCode).toBe(200);

    // The DB flag was set (requestCancel)...
    expect(res.json().cancel_requested).toBe(true);
    // ...AND the in-flight request was physically aborted (hardCancelRun).
    expect(hardCancelRun).toHaveBeenCalledWith(run.id);
  });

  it("still hard-cancels (idempotent no-op) even for an unknown run before 404", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/sync/999999/cancel" });
    expect(res.statusCode).toBe(404);
    // hardCancelRun is idempotent and returns false when nothing is registered,
    // so calling it for an unknown id is harmless.
    expect(hardCancelRun).toHaveBeenCalledWith(999999);
  });
});
