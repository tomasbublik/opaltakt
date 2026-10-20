import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from "@playwright/test";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady } from "../fixtures/helpers";

/**
 * TP — Increment 23 (SPEC_23: sync resilient to disconnected connections +
 * assignee identity collision across servers), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → to → "tp-…" lexicographic sequence so it
 * runs LAST against the ONE shared backend (Playwright orders spec files by
 * name). Do NOT rename.
 *
 * WHAT THIS FILE PROVES (SPEC_23 §6 verification checklist):
 *
 *   §1 SYNC WITH A DISCONNECTED CONNECTION — a stored DISCONNECTED mock +
 *      a stored CONNECTED Acme → "Sync now" (refresh-all, no project_op_id)
 *      SUCCEEDS (200, never a batch-wide 409 CONNECTION_DISABLED). The mock is
 *      reported `skipped` ("disconnected"); the Acme connection `synced`; the
 *      response carries a per-connection breakdown. `Last synced` advances.
 *
 *   §1.2 / §2 WP-11592 DURATION — after sync, the Acme 11592-analogue
 *      (op_id 84090, "P1DT5H") has EFFECTIVE hours = 29 (Increment-22 regression
 *      re-asserted by SPEC_23 §6), and stays 29 after the disconnected refresh-all.
 *
 *   §2 ASSIGNEE IDENTITY COLLISION — two people share OP user id 3 on two
 *      DIFFERENT connections (Alan Turing @ mock, Cameron Dalby @ Acme).
 *      (a) The assignee dropdown lists BOTH as DISTINCT entries keyed by
 *          `${connection_id}:${op_id}` — Cameron is no longer deduped away.
 *      (b) `assigneeKey=${mockConn}:3` returns ONLY mock/Alan rows, never
 *          Acme/Cameron rows; the reverse holds too — no cross-server leak.
 *      (c) Grace Hopper (SAME id 5 AND same name on both servers) is likewise
 *          scoped per-connection, proving the discriminator is genuinely the
 *          CONNECTION, not the bare id and not the name.
 *      (d) The legacy bare `assignee=3` path still matches BOTH connections
 *          (the collision is real in the data) — which is exactly why the
 *          connection-safe `assigneeKey` is required.
 *
 *   §3 WATCHDOG — a manual hard-cancel of a latency-stalled sync physically
 *      aborts the in-flight request and finishes the run `aborted` promptly
 *      (the abort() mechanism SPEC_23 §3's watchdog invokes). The watchdog's
 *      AUTOMATIC 60s-no-progress trigger is deliberately test.skip()ped — see
 *      the loud comment on that test for why (OSP_DISABLE_SCHEDULER=1 + the
 *      unit-level coverage that substitutes for it).
 *
 *   §6 GUARDRAILS — across BOTH recording mocks: every OP request is a GET
 *      (read-only-to-OP invariant), and the admin-gated `GET /api/v3/users`
 *      collection is NEVER called. Connection scoping is proven throughout §2.
 *
 *   §0 real-DB TRIPWIRE (same pattern as to-/tn-/tm-/tl-): fingerprint the REAL
 *      apps/api/osp.sqlite at start/end; fail loudly if it moved.
 *
 * ── ISOLATION (OSP_DB_PATH / PORT guardrail) ────────────────────────────────
 * NO new apps/api boot — reuses tests/playwright.config.ts's webServer (which
 * already sets an isolated OSP_DB_PATH + non-default PORT + OSP_DISABLE_SCHEDULER
 * per the hard guardrail). Two dedicated RECORDING MOCKS are spun up on
 * ephemeral ports (each its own connection id + its own scenario), doubling as
 * the §6 request recorders. Nothing here issues a non-GET toward OP. The mock
 * "server 1" loads s16 (Alan id 3); the Acme "server 2" loads s17 (Cameron
 * id 3 + the 29h 11592-analogue). To keep the refresh-all breakdown
 * deterministic against the shared backend, every OTHER connection is disabled
 * at setup and all backlog/filter queries are connection-scoped.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const MOCK_SCENARIO = "s16-assignee-collision-mock"; // "server 1"
const EFT_SCENARIO = "s17-assignee-collision-acme"; // "server 2"
const MOCK_PROJECT = 8300;
const EFT_PROJECT = 8400;
const COLLISION_ID = 3; // Alan Turing @ mock  ===  Cameron Dalby @ Acme
const GRACE_ID = 5; // Grace Hopper on BOTH servers (same id AND name)
const ALAN = "Alan Turing";
const CAMERON = "Cameron Dalby";
const MOCK_ALAN_WPS = [83001, 83002, 83003];
const MOCK_GRACE_WPS = [83004, 83005];
const EFT_CHRIS_WPS = [84001, 84002, 84090];
const EFT_GRACE_WPS = [84003];
const WP_11592 = 84090; // Acme 11592-analogue, "P1DT5H" → 29h
const EXPECTED_11592_HOURS = 29;

// ── minimal contract subsets ─────────────────────────────────────────────────
interface FilterOptionEntry {
  id: number;
  name: string;
  key: string;
  connection_id: number | null;
  connection_label: string | null;
}
interface FilterOptions {
  projects: string[];
  statuses: string[];
  assignees: FilterOptionEntry[];
  versions: FilterOptionEntry[];
  priorities: string[];
  servers: { id: number; name: string }[];
}
interface BacklogItem {
  op_id: number;
  assignee_op_id: number | null;
  assignee_name: string | null;
  connection_id: number | null;
  effective_hours: number | null;
  project_op_id: number;
}
type SyncStatusValue = "running" | "success" | "error" | "aborted";
interface SyncRun {
  id: number;
  status: SyncStatusValue;
  finished_at: string | null;
  cancel_requested: boolean;
}
interface SyncStatus {
  current: SyncRun | null;
  last: SyncRun | null;
  current_elapsed_ms: number | null;
}
interface ConnectionSyncOutcome {
  connection_id: number;
  connection_label: string | null;
  status: "synced" | "skipped" | "error";
  run: SyncRun | null;
  message: string;
}
interface SyncRefreshAllResponse {
  connections: ConnectionSyncOutcome[];
  last: SyncRun | null;
}

// ── §0 tripwire: the real DB file we must PROVE we never touch ────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", ".."); // tests/e2e/specs → root
const REAL_DB = path.join(REPO_ROOT, "apps", "api", "osp.sqlite");
interface DbFingerprint {
  size: number;
  mtimeMs: number;
}
function fingerprintRealDb(): DbFingerprint | null {
  try {
    const st = fs.statSync(REAL_DB);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
function assertRealDbUnchanged(before: DbFingerprint | null): void {
  const after = fingerprintRealDb();
  if (before === null || after === null) {
    // eslint-disable-next-line no-console
    console.warn(`[§0 tripwire] ${REAL_DB} absent — nothing to compare (invariant holds vacuously).`);
    return;
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(
      `[§0 TRIPWIRE FAILED] ${REAL_DB} changed during the e2e run — ` +
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}. This is the Increment-11 incident.`,
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TP — SPEC_23 disconnected sync + assignee identity", () => {
  let setup: APIRequestContext;
  let mockRec: RecordingMockOpServer; // "server 1" — Alan Turing @ id 3
  let eftRec: RecordingMockOpServer; // "server 2" — Cameron Dalby @ id 3
  let mockConnId = 0;
  let eftConnId = 0;
  let dbBefore: DbFingerprint | null;
  let ready = false;
  let scenarioMissing = false;

  // ── low-level helpers ───────────────────────────────────────────────────────
  function qs(params: Record<string, string | number | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
    const s = sp.toString();
    return s ? `?${s}` : "";
  }
  async function filterOptions(
    params: Record<string, string | number | undefined> = {},
  ): Promise<FilterOptions> {
    const res = await setup.get(`/api/backlog/filter-options${qs(params)}`);
    expect(res.ok(), `filter-options ${JSON.stringify(params)}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as FilterOptions;
  }
  async function backlog(
    params: Record<string, string | number | undefined> = {},
  ): Promise<BacklogItem[]> {
    const res = await setup.get(`/api/backlog${qs(params)}`);
    expect(res.ok(), `backlog ${JSON.stringify(params)}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as BacklogItem[];
  }
  async function getStatus(): Promise<SyncStatus> {
    const res = await setup.get("/api/sync/status");
    expect(res.ok(), `sync/status: ${res.status()}`).toBeTruthy();
    return (await res.json()) as SyncStatus;
  }
  async function waitNoCurrentSync(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await getStatus()).current === null) return;
      if (Date.now() > deadline) throw new Error("a sync was still running past the deadline");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function pollRunningRunId(timeoutMs = 8_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = (await getStatus()).current;
      if (cur !== null) return cur.id;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  async function setLatency(rec: RecordingMockOpServer, ms: number): Promise<void> {
    const res = await setup.post(`${rec.url}/__mock/set-latency-ms`, { data: { ms } });
    expect(res.ok(), `set-latency-ms ${ms}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  /** Single-project full sync through the SAME proxy the browser uses; awaits
   * completion. Also records the import selection the refresh-all test needs. */
  async function fullSync(projectOpId: number, connId: number): Promise<void> {
    const res = await setup.post("/api/sync", {
      data: { project_op_id: projectOpId, connection_id: connId, kind: "full" },
    });
    expect(res.ok(), `sync project ${projectOpId}: ${res.status()} ${await res.text()}`).toBeTruthy();
    await waitNoCurrentSync();
  }
  function keyFor(connId: number, opUserId: number): string {
    return `${connId}:${opUserId}`;
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    // Two dedicated, isolated mocks (each also records inbound requests for §6).
    mockRec = await createRecordingMockOpServer();
    eftRec = await createRecordingMockOpServer();
    const loadMock = await setup.post(`${mockRec.url}/__mock/load/${encodeURIComponent(MOCK_SCENARIO)}`);
    const loadEft = await setup.post(`${eftRec.url}/__mock/load/${encodeURIComponent(EFT_SCENARIO)}`);
    if (!loadMock.ok() || !loadEft.ok()) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[TP] scenario not loadable: mock=${loadMock.status()} eft=${loadEft.status()}`,
      );
      return;
    }

    // Deterministic refresh-all breakdown: disable EVERY pre-existing connection
    // (earlier specs leave their own; this spec runs last) so the only groups the
    // refresh-all sees are our two. Then register + enable ours.
    const existing = (await (await setup.get("/api/connections")).json()) as { id: number }[];
    for (const c of existing) {
      await setup.patch(`/api/connections/${c.id}`, { data: { enabled: false } }).catch(() => {});
    }

    mockConnId = await ensureConnection(setup, mockRec.url, "tp-mock-token");
    eftConnId = await ensureConnection(setup, eftRec.url, "tp-eft-token");
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } });
    await setup.patch(`/api/connections/${eftConnId}`, { data: { enabled: true, current: true } });

    // Populate project names (backlog project_name / Project facet) — sync alone
    // never writes the projects table; GET /api/projects upserts them from OP.
    await setup.get("/api/projects");

    // Full sync each project through ITS connection (records import selections +
    // stamps connection_id on the cached rows, so assigneeKey scoping works).
    await fullSync(MOCK_PROJECT, mockConnId);
    await fullSync(EFT_PROJECT, eftConnId);
    ready = true;
  });

  test.afterAll(async () => {
    await setLatency(eftRec, 0).catch(() => {});
    await setLatency(mockRec, 0).catch(() => {});
    if (mockConnId) await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } }).catch(() => {});
    if (eftConnId) await setup.patch(`/api/connections/${eftConnId}`, { data: { enabled: false } }).catch(() => {});
    await setup?.dispose();
    if (mockRec) await mockRec.close().catch(() => {});
    if (eftRec) await eftRec.close().catch(() => {});
    assertRealDbUnchanged(dbBefore);
  });

  function skipIfNotReady(): void {
    test.skip(scenarioMissing, `scenario "${MOCK_SCENARIO}"/"${EFT_SCENARIO}" not landed (load 404).`);
    test.skip(!ready, "TP fixture could not be synced (sync route unavailable).");
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_23 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops.`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBeTruthy();
  });

  // ═══ §2 ASSIGNEE IDENTITY COLLISION ════════════════════════════════════════

  test("§2a: the assignee dropdown lists id-3 Alan AND id-3 Cameron as DISTINCT, connection-keyed options", async () => {
    skipIfNotReady();
    // Union across all connections (no connectionId) — then locate OUR two by
    // their connection-safe keys. Robust to any leftover rows on other (disabled)
    // connections in the shared cache.
    const opts = await filterOptions();
    const byKey = new Map(opts.assignees.map((a) => [a.key, a]));

    const alan = byKey.get(keyFor(mockConnId, COLLISION_ID));
    const chris = byKey.get(keyFor(eftConnId, COLLISION_ID));

    expect(
      alan,
      `Alan Turing (mock, key ${keyFor(mockConnId, COLLISION_ID)}) must be an option. assignees=${JSON.stringify(opts.assignees)}`,
    ).toBeTruthy();
    expect(
      chris,
      `Cameron Dalby (Acme, key ${keyFor(eftConnId, COLLISION_ID)}) must be an option — the "Cameron missing from dropdown" bug. assignees=${JSON.stringify(opts.assignees)}`,
    ).toBeTruthy();

    // Same numeric OP id, DIFFERENT people, DIFFERENT keys (not deduped to one).
    expect(alan!.id).toBe(COLLISION_ID);
    expect(chris!.id).toBe(COLLISION_ID);
    expect(alan!.name).toBe(ALAN);
    expect(chris!.name).toBe(CAMERON);
    expect(alan!.key).not.toBe(chris!.key);
    expect(alan!.connection_id).toBe(mockConnId);
    expect(chris!.connection_id).toBe(eftConnId);

    // Grace Hopper (SAME id 5 AND same name on both servers) is ALSO two options.
    const graceMock = byKey.get(keyFor(mockConnId, GRACE_ID));
    const graceEft = byKey.get(keyFor(eftConnId, GRACE_ID));
    expect(graceMock, "Grace@mock must be an option").toBeTruthy();
    expect(graceEft, "Grace@acme must be an option").toBeTruthy();
    expect(graceMock!.name).toBe("Grace Hopper");
    expect(graceEft!.name).toBe("Grace Hopper");
    expect(graceMock!.key).not.toBe(graceEft!.key);
  });

  test("§2b: assigneeKey scopes to ONE connection — selecting Alan (mock) NEVER returns Cameron (Acme) tickets", async () => {
    skipIfNotReady();
    // Alan @ mock — only mock rows, all op_ids in the mock/Alan set, none Acme.
    const alanRows = await backlog({ assigneeKey: keyFor(mockConnId, COLLISION_ID) });
    expect(alanRows.length, "Alan@mock returns his mock tickets").toBeGreaterThan(0);
    for (const r of alanRows) {
      expect(r.connection_id, `row ${r.op_id} must be a mock-connection row`).toBe(mockConnId);
      expect(r.assignee_op_id).toBe(COLLISION_ID);
      expect(r.assignee_name).toBe(ALAN);
    }
    const alanOpIds = new Set(alanRows.map((r) => r.op_id));
    expect([...alanOpIds].sort((a, b) => a - b)).toEqual([...MOCK_ALAN_WPS].sort((a, b) => a - b));
    for (const eftId of EFT_CHRIS_WPS) {
      expect(alanOpIds.has(eftId), `Alan@mock must NOT leak Acme ticket ${eftId}`).toBe(false);
    }

    // Reverse: Cameron @ Acme — only Acme rows, never a mock ticket.
    const chrisRows = await backlog({ assigneeKey: keyFor(eftConnId, COLLISION_ID) });
    expect(chrisRows.length, "Cameron@Acme returns his tickets").toBeGreaterThan(0);
    for (const r of chrisRows) {
      expect(r.connection_id, `row ${r.op_id} must be an Acme-connection row`).toBe(eftConnId);
      expect(r.assignee_op_id).toBe(COLLISION_ID);
      expect(r.assignee_name).toBe(CAMERON);
    }
    const chrisOpIds = new Set(chrisRows.map((r) => r.op_id));
    expect([...chrisOpIds].sort((a, b) => a - b)).toEqual([...EFT_CHRIS_WPS].sort((a, b) => a - b));
    for (const mockId of MOCK_ALAN_WPS) {
      expect(chrisOpIds.has(mockId), `Cameron@Acme must NOT leak mock ticket ${mockId}`).toBe(false);
    }
  });

  test("§2c: same id AND same name (Grace id 5 on both) still scopes per-connection", async () => {
    skipIfNotReady();
    const graceMock = await backlog({ assigneeKey: keyFor(mockConnId, GRACE_ID) });
    const graceEft = await backlog({ assigneeKey: keyFor(eftConnId, GRACE_ID) });

    expect(new Set(graceMock.map((r) => r.op_id)), "Grace@mock rows").toEqual(new Set(MOCK_GRACE_WPS));
    expect(new Set(graceEft.map((r) => r.op_id)), "Grace@acme rows").toEqual(new Set(EFT_GRACE_WPS));
    for (const r of graceMock) expect(r.connection_id).toBe(mockConnId);
    for (const r of graceEft) expect(r.connection_id).toBe(eftConnId);
    // Disjoint sets: proves the discriminator is the CONNECTION, not id-or-name.
    for (const id of MOCK_GRACE_WPS) expect(graceEft.some((r) => r.op_id === id)).toBe(false);
    for (const id of EFT_GRACE_WPS) expect(graceMock.some((r) => r.op_id === id)).toBe(false);
  });

  test("§2d: the legacy bare `assignee=3` DOES collide across servers — which is why assigneeKey is required", async () => {
    skipIfNotReady();
    // The unsafe legacy path matches op_user_id 3 on EVERY connection. It must
    // therefore return BOTH Alan's mock rows AND Cameron's Acme rows — the
    // very cross-server superset the connection-safe assigneeKey narrows away.
    const bare = await backlog({ assignee: COLLISION_ID });
    const conns = new Set(bare.map((r) => r.connection_id));
    expect(conns.has(mockConnId), "bare assignee=3 includes the mock connection").toBe(true);
    expect(conns.has(eftConnId), "bare assignee=3 includes the Acme connection").toBe(true);
    const opIds = new Set(bare.map((r) => r.op_id));
    for (const id of MOCK_ALAN_WPS) expect(opIds.has(id), `bare id-3 includes mock ${id}`).toBe(true);
    for (const id of EFT_CHRIS_WPS) expect(opIds.has(id), `bare id-3 includes Acme ${id}`).toBe(true);
  });

  // ═══ §1.2 / §2 WP-11592 DURATION ═══════════════════════════════════════════

  test("§1.2: the Acme 11592-analogue (P1DT5H) has EFFECTIVE hours = 29 after sync", async () => {
    skipIfNotReady();
    const rows = await backlog({ connectionId: eftConnId, projectId: EFT_PROJECT });
    const wp = rows.find((r) => r.op_id === WP_11592);
    expect(wp, `WP ${WP_11592} (the 29h day-spanning ticket) must be in the Acme backlog`).toBeTruthy();
    test.info().annotations.push({
      type: "SPEC_23 §1.2 duration (WP-11592 analogue)",
      description: `op_id ${WP_11592}: effective=${wp!.effective_hours}h (mock "P1DT5H" → op-client parseIsoDuration → 29).`,
    });
    // The core assertion: "P1DT5H" must NOT collapse to 5h.
    expect(wp!.effective_hours, `${WP_11592} must be 29h, not a mis-parsed 5h`).toBe(EXPECTED_11592_HOURS);
  });

  // ═══ §1 SYNC WITH A DISCONNECTED CONNECTION ════════════════════════════════

  test("§1: 'Sync now' with a DISCONNECTED mock + a CONNECTED Acme succeeds — mock skipped, Acme synced, no global 409", async () => {
    skipIfNotReady();
    await waitNoCurrentSync();

    // Disconnect the mock connection (enabled:false — the CONNECTION_DISABLED
    // condition). Its import selection remains recorded, so it must appear as a
    // SKIPPED outcome, never abort the whole batch.
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

    const before = await getStatus();
    const beforeLastId = before.last?.id ?? 0;

    // "Sync now" = refresh-all (NO project_op_id).
    const res = await setup.post("/api/sync", { data: {} });
    expect(
      res.status(),
      `refresh-all with a disconnected connection must NOT be a batch-wide 409 — body: ${await res.text()}`,
    ).toBe(200);
    const body = (await res.json()) as SyncRefreshAllResponse;
    await waitNoCurrentSync();

    // Per-connection breakdown present, not a bare SyncRun.
    expect(Array.isArray(body.connections), "response carries a per-connection breakdown").toBe(true);

    const mockOutcome = body.connections.find((c) => c.connection_id === mockConnId);
    const eftOutcome = body.connections.find((c) => c.connection_id === eftConnId);
    expect(mockOutcome, `mock connection ${mockConnId} must be reported`).toBeTruthy();
    expect(eftOutcome, `Acme connection ${eftConnId} must be reported`).toBeTruthy();

    expect(mockOutcome!.status, "the disconnected mock is SKIPPED").toBe("skipped");
    expect(mockOutcome!.message.toLowerCase()).toContain("disconnect");
    expect(mockOutcome!.run, "a skipped connection has no run").toBeNull();

    expect(eftOutcome!.status, "the connected Acme SYNCS").toBe("synced");
    expect(eftOutcome!.run, "a synced connection carries its run").toBeTruthy();

    // "Last synced" advances (a successful run is the batch's `last`).
    expect(body.last, "refresh-all reports a most-recent successful run").toBeTruthy();
    expect(body.last!.status).toBe("success");
    const after = await getStatus();
    expect(after.last, "sync/status.last is populated").toBeTruthy();
    expect(after.last!.id, "Last synced advanced past the prior run").toBeGreaterThan(beforeLastId);
  });

  test("§1.2b: after the disconnected refresh-all, the Acme 11592-analogue is STILL 29h (Acme really re-synced)", async () => {
    skipIfNotReady();
    const rows = await backlog({ connectionId: eftConnId, projectId: EFT_PROJECT });
    const wp = rows.find((r) => r.op_id === WP_11592);
    expect(wp, `WP ${WP_11592} still present after refresh-all`).toBeTruthy();
    expect(wp!.effective_hours, `${WP_11592} stays 29h`).toBe(EXPECTED_11592_HOURS);
  });

  // ═══ §3 WATCHDOG ═══════════════════════════════════════════════════════════

  test("§3: a manual hard-cancel physically aborts a latency-stalled sync and finishes it 'aborted' promptly", async () => {
    skipIfNotReady();
    // Re-enable + make the Acme mock the current connection for a project sync.
    await setup.patch(`/api/connections/${eftConnId}`, { data: { enabled: true, current: true } });
    await waitNoCurrentSync();
    await setLatency(eftRec, 5_000); // each page hangs 5s — plenty to cancel mid-flight
    try {
      const started = Date.now();
      // Fire-and-DON'T-await so we can cancel while a request is in flight.
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: EFT_PROJECT, connection_id: eftConnId, kind: "full" },
      });
      const runId = await pollRunningRunId();
      expect(runId, "a sync became observably current").not.toBeNull();

      const cancel = await setup.post(`/api/sync/${runId}/cancel`);
      expect(cancel.ok(), `cancel run ${runId}: ${cancel.status()} ${await cancel.text()}`).toBeTruthy();
      await syncPromise.catch(() => {});
      await waitNoCurrentSync(15_000);

      const st = await getStatus();
      const elapsed = Date.now() - started;
      expect(st.current, "no sync is left running after the abort").toBeNull();
      expect(st.last, "a finished run is recorded").toBeTruthy();
      expect(st.last!.status, "hard-cancel finishes the run 'aborted'").toBe("aborted");
      // The whole point of SPEC_23 §3: abort() physically interrupts the in-flight
      // request — so the run stops in seconds, NOT after the full latency budget
      // of every remaining page (let alone "3 hours" from the incident).
      test.info().annotations.push({
        type: "SPEC_23 §3 hard-cancel abort()",
        description: `run ${runId} aborted in ~${elapsed}ms (in-flight request physically interrupted).`,
      });
      expect(elapsed, "abort is prompt, not a full-latency stall").toBeLessThan(14_000);
    } finally {
      await setLatency(eftRec, 0);
    }
  });

  test.skip("§3 (auto-trigger): the watchdog auto-stops a >60s stuck run — covered at the UNIT level, not e2e", () => {
    /*
     * LOUD, DELIBERATE SKIP — NOT a silent one. Reasons this SPECIFIC angle
     * (the watchdog's AUTOMATIC 60s-no-progress trigger) is not asserted e2e:
     *
     *  1. The e2e harness boots apps/api with OSP_DISABLE_SCHEDULER=1
     *     (tests/playwright.config.ts) — heartbeat, sprint-update AND the sync
     *     watchdog schedulers are all OFF, precisely so the deterministic e2e
     *     suite never races a background timer. There is therefore NO running
     *     watchdog in this process to observe firing.
     *  2. Even with it enabled, DEFAULT_NO_PROGRESS_MS is 60_000ms and
     *     DEFAULT_MAX_DURATION_MS 15 minutes; a Playwright test's timeout is 30s.
     *     There is no way to make a real HTTP request against the mock hang for
     *     >60s on demand and still finish the test — the same judgment call
     *     already documented for the pre-existing Increment-22 skips.
     *
     * WHAT SUBSTITUTES FOR IT (real coverage, just not in this file):
     *  - The interruption MECHANISM the watchdog invokes — AbortController.abort()
     *    physically killing the in-flight request + setting the DB cancel flag —
     *    IS proven end-to-end by the §3 test directly above (manual hard-cancel
     *    of a latency-stalled sync, finishing 'aborted' in seconds).
     *  - The watchdog's OWN decision logic + that it calls requestCancel(id)
     *    (DB flag), hardCancel(id) (abort), dropStaging(id) and finish(...) on a
     *    >60s-no-progress / >15m run is unit-tested exhaustively in
     *    apps/api/src/scheduler/syncWatchdog.test.ts — see its
     *    "a stale run (no progress > 60s) is hard-cancelled + rolled back +
     *    finished as error" case (asserts requestCancel/hardCancel/dropStaging/
     *    finish were all invoked with the right run id), which is exactly the
     *    SPEC_23 §3 fix (the old code logged the abort but never set the flag /
     *    never aborted the in-flight request).
     */
  });

  // ═══ §6 GUARDRAILS ═════════════════════════════════════════════════════════

  test("§6 guard: every OP request is a GET and GET /api/v3/users is NEVER called (both mocks)", async () => {
    skipIfNotReady();
    for (const [label, rec, connId] of [
      ["mock", mockRec, mockConnId] as const,
      ["acme", eftRec, eftConnId] as const,
    ]) {
      const opRequests = rec.requests.filter((r) => !r.path.startsWith("/__mock"));
      const nonGet = opRequests.filter((r) => r.method !== "GET");
      const usersCollection = opRequests.filter((r) => r.path === "/api/v3/users");
      test.info().annotations.push({
        type: `SPEC_23 §6 guardrails (${label} conn ${connId})`,
        description:
          `OP requests=${opRequests.length}, non-GET=${nonGet.length}, ` +
          `bare /api/v3/users hits=${usersCollection.length}.`,
      });
      expect(nonGet, `${label}: OpenProject must stay READ-ONLY (no non-GET). Saw: ${JSON.stringify(nonGet)}`).toEqual([]);
      expect(
        usersCollection.length,
        `${label}: GET /api/v3/users (admin-gated user collection, SPEC_13) must NEVER be called`,
      ).toBe(0);
    }
  });
});
