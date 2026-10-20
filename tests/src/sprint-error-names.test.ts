import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRecordingMockOpServer,
  type RecordingMockOpServer,
} from "@osp/fixtures";
import { ErrorResponse, SprintResponse } from "@osp/contracts";
import { addDays, mockAdmin, type MockAdmin, S4 } from "./scenario-helpers";
import { activateSprint, bootRealApp, call, connectToOp, type RealApp } from "./harness";

/**
 * SPEC_05 §6 bug-fix #2 — lifecycle error messages reference the sprint by its
 * REAL NAME (as the user typed it), never a bare internal id like "Sprint 2",
 * and carry `sprintName` in the error `details` payload.
 *
 * One sprint named "Sprint 3.5.039" (the spec's own example) is driven through
 * three illegal transitions, capturing the error each time:
 *   - SPRINT_NOT_ACTIVE   : POST /update before activation
 *   - SPRINT_NOT_PLANNING : POST /activate on an already-active sprint
 *   - SPRINT_FROZEN       : POST /update after the freeze (Increment 31 —
 *     a merely-locked sprint now ACCEPTS update during the grace window,
 *     so the hard refusal, and this name-carrying probe, moved to freeze)
 */

const SPRINT_NAME = "Sprint 3.5.039";
const SESSION = 1401;

function expectOk(res: { status: number; json: unknown }, what: string): void {
  expect(
    res.status,
    `${what} — expected 2xx but got ${res.status}: ${JSON.stringify(res.json)}`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status, `${what}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
}

describe("SPEC_05 §6 — lifecycle errors carry the sprint NAME, not an internal id", () => {
  let mock: RecordingMockOpServer;
  let admin: MockAdmin;
  let harness: RealApp;
  let dir: string;
  let sprintId: number;
  let notActive: unknown;
  let notPlanning: unknown;
  let locked: unknown;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "osp-error-names-"));
    mock = await createRecordingMockOpServer();
    admin = mockAdmin(mock.url);
    await admin.requireScenario(S4);
    const clock = { now: new Date("2026-07-01T00:00:00.000Z") };
    harness = await bootRealApp({ now: () => clock.now });

    const loaded = await admin.load(S4);
    const d0 = loaded.date!;
    await connectToOp(harness.app, mock.url, "s4-token", 3);
    await call(harness.app, "POST", "/api/sync", { project_op_id: 3 });

    const created = await call(harness.app, "POST", "/api/sprints", {
      name: SPRINT_NAME,
      start_date: d0,
      end_date: addDays(d0, 8),
    });
    expectOk(created, "create sprint");
    sprintId = SprintResponse.parse(created.json).id;
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/items`, { wp_op_id: SESSION }),
      "add item",
    );

    // (1) SPRINT_NOT_ACTIVE — update while still planning.
    notActive = (await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {})).json;

    // Activate, then (2) SPRINT_NOT_PLANNING — activate again.
    expectOk(await activateSprint(harness.app, sprintId), "activate");
    notPlanning = (await call(harness.app, "POST", `/api/sprints/${sprintId}/activate`)).json;

    // Finish (lock) — Increment 31 (docs/INCREMENT_31_CONTRACTS.md §2a):
    // POST /update on a merely-LOCKED sprint now SUCCEEDS (the post-finish
    // grace window), so the lock probe moved to the freeze gate: freeze the
    // sprint directly (the sweep's own repo write — the gate only reads
    // frozen_at) and capture (3) SPRINT_FROZEN — update after freeze.
    expectOk(await call(harness.app, "POST", `/api/sprints/${sprintId}/finish`, {}), "finish");
    expectOk(
      await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {}),
      "update during grace (locked, unfrozen)",
    );
    await harness.repos.sprints.setFrozen(sprintId, new Date().toISOString());
    locked = (await call(harness.app, "POST", `/api/sprints/${sprintId}/update`, {})).json;
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    if (mock) await mock.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const assertNamed = (raw: unknown, expectedCode: string): void => {
    const parsed = ErrorResponse.parse(raw);
    expect(parsed.error.code).toBe(expectedCode);
    // details.sprintName is the EXACT user-typed name.
    const details = parsed.error.details as { sprintName?: unknown } | undefined;
    expect(details?.sprintName).toBe(SPRINT_NAME);
    // The message text references the real name…
    expect(parsed.error.message).toContain(SPRINT_NAME);
    // …and NEVER the bare internal id ("Sprint <dbId>").
    expect(new RegExp(`Sprint ${sprintId}\\b`).test(parsed.error.message)).toBe(false);
  };

  it("SPRINT_NOT_ACTIVE references the sprint by name + carries details.sprintName", () => {
    assertNamed(notActive, "SPRINT_NOT_ACTIVE");
  });

  it("SPRINT_NOT_PLANNING references the sprint by name + carries details.sprintName", () => {
    assertNamed(notPlanning, "SPRINT_NOT_PLANNING");
  });

  it("SPRINT_FROZEN references the sprint by name + carries details.sprintName", () => {
    // Increment 31: the hard update refusal moved from lock-time to
    // freeze-time — same name-carrying contract, new code.
    assertNamed(locked, "SPRINT_FROZEN");
  });
});
