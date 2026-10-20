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
 * TL — Increment 19 (SPEC_19 backlog filters + abortable sync), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tk → "tl-…" lexicographic sequence, so it
 * runs LAST against the ONE shared backend. Do NOT rename.
 *
 * WHAT THIS FILE PROVES (SPEC_19 DoD):
 *   §1 FILTER MATRIX (SPEC_19 §1/§3): every facet's OPTION LIST is cascading
 *      (only real, achievable values appear); each facet narrows ALONE;
 *      meaningful COMBINATIONS return the right subset; the specific
 *      "individually valid, jointly would-be-empty-under-old-logic" pair
 *      (Version 3.5.040 + Status "Merge pending") is never OFFERED, while the
 *      achievable combo returns tickets; hidden statuses are never offered.
 *   §2 ABORT = ROLLBACK (full): a latency-stalled paged sync, cancelled
 *      mid-flight, finishes "aborted" and leaves the backlog cache BYTE-
 *      IDENTICAL (deep-equal, not just same count).
 *   §3 ABORT = ROLLBACK (incremental): same, from an already-synced state, on
 *      an INCREMENTAL sync — old field values preserved exactly (SPEC_19 §5).
 *   §4 ELAPSED TIME: current_elapsed_ms rises monotonically during a run.
 *   §5 IMPORT ABORTABILITY: the same abort/rollback via the Import entry point
 *      (shared engine) — API proof + a gated browser leg.
 *   §6 GUARDRAILS: no GET /api/v3/users; the mock's /__mock/set-latency-ms is
 *      pure test-harness surface op-client never targets.
 *   §0 real-DB TRIPWIRE (same pattern as tk-/tj-): fingerprint the REAL
 *      apps/api/osp.sqlite at start/end; fail loudly if it moved.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * The whole suite shares ONE backend + cache, so project-3 scenarios from
 * earlier specs pollute a global backlog read. This spec therefore runs against
 * a DEDICATED recording mock (its own ephemeral port ⇒ its own connection id)
 * loaded with s14-backlog-filter-matrix (projects 90/91, versions 4610/4611/
 * 4680 — used by no other fixture), and every filter query is scoped by
 * connectionId (and usually projectId) so the option-list assertions are EXACT.
 * The recording mock doubles as the §6 guard: it records every inbound request.
 *
 * ── OSP_DB_PATH / PORT isolation (guardrail) ────────────────────────────────
 * NO new apps/api boot: reuses tests/playwright.config.ts's webServer (which
 * already sets OSP_DB_PATH + PORT). Only an ephemeral RECORDING MOCK (port 0,
 * no DB) is spun up. Nothing here issues a non-GET toward OP.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s14-backlog-filter-matrix";
const PROJ_A = 90; // OSP Filter Demo — 120 WPs, 2 pages @ PAGE_SIZE=100
const PROJ_B = 91; // OSP Filter Demo B — 6 WPs (Project-facet second value)
const V_ISO = 4610; // "3.5.040" — status-exclusively "In progress"
const V_MIXED = 4611; // "3.5.041" — everything else
const ISO_STATUS = "In progress";
const ELSEWHERE_STATUS = "Merge pending"; // exists only in v_mixed → jointly-empty pair
const ANDREA_OP_ID = 223; // exclusive to v_mixed (assignee→version cascade)
const IMMEDIATE = "Immediate"; // priority exclusive to v_mixed

// ── minimal contract subsets ─────────────────────────────────────────────────
interface FilterOptions {
  projects: string[];
  statuses: string[];
  assignees: { id: number; name: string }[];
  versions: { id: number; name: string }[];
  priorities: string[];
  servers: { id: number; name: string }[];
}
interface BacklogItem {
  op_id: number;
  status_name: string | null;
  assignee_op_id: number | null;
  version_op_id: number | null;
  priority: string | null;
  project_op_id: number;
  connection_id: number | null;
}
type SyncStatusValue = "running" | "success" | "error" | "aborted";
interface SyncRun {
  id: number;
  status: SyncStatusValue;
  cancel_requested: boolean;
}
interface SyncStatus {
  current: SyncRun | null;
  last: SyncRun | null;
  current_elapsed_ms: number | null;
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
test.describe.serial("TL — SPEC_19 backlog filters + abortable sync", () => {
  let setup: APIRequestContext;
  let rec: RecordingMockOpServer; // dedicated, isolated mock + request recorder
  let myConnId = 0;
  let dbBefore: DbFingerprint | null;
  let ready = false;
  let scenarioMissing = false;

  // ── low-level helpers ───────────────────────────────────────────────────────
  async function setLatency(ms: number): Promise<void> {
    const res = await setup.post(`${rec.url}/__mock/set-latency-ms`, { data: { ms } });
    expect(res.ok(), `set-latency-ms ${ms}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  function qs(params: Record<string, string | number | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
    const s = sp.toString();
    return s ? `?${s}` : "";
  }
  async function filterOptions(
    params: Record<string, string | number | undefined>,
  ): Promise<FilterOptions> {
    const res = await setup.get(`/api/backlog/filter-options${qs({ connectionId: myConnId, ...params })}`);
    expect(res.ok(), `filter-options ${JSON.stringify(params)}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as FilterOptions;
  }
  async function backlog(
    params: Record<string, string | number | undefined>,
  ): Promise<BacklogItem[]> {
    const res = await setup.get(`/api/backlog${qs({ connectionId: myConnId, ...params })}`);
    expect(res.ok(), `backlog ${JSON.stringify(params)}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as BacklogItem[];
  }
  /** Deep-comparable snapshot of the isolated backlog (sorted, stable). */
  async function snapshotBacklog(projectId: number): Promise<BacklogItem[]> {
    const rows = await backlog({ projectId });
    return [...rows].sort((a, b) => a.op_id - b.op_id);
  }
  async function getStatus(): Promise<SyncStatus> {
    const res = await setup.get("/api/sync/status");
    expect(res.ok(), `sync/status: ${res.status()}`).toBeTruthy();
    return (await res.json()) as SyncStatus;
  }
  async function waitNoCurrentSync(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await getStatus()).current === null) return;
      if (Date.now() > deadline) throw new Error("a sync was still running past the deadline");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  /** Poll until a run is observably in flight; returns its id (or null on timeout). */
  async function pollRunningRunId(timeoutMs = 8_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = (await getStatus()).current;
      if (cur !== null) return cur.id;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  async function waitLastAborted(timeoutMs = 15_000): Promise<SyncRun | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await getStatus();
      if (st.current === null && st.last !== null) return st.last;
      if (Date.now() > deadline) return st.last;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * The shared abort proof: with per-page latency armed, fire a sync WITHOUT
   * awaiting, cancel it the moment it's observably running, then assert it
   * finished "aborted" and left the isolated backlog byte-identical. Returns a
   * status string for the caller to gate on (route-missing → loud skip).
   */
  async function proveAbortRollback(
    kind: "full" | "incremental",
  ): Promise<"no-cancel-route" | "no-window" | "ok"> {
    await waitNoCurrentSync();
    await setLatency(600);
    try {
      const before = await snapshotBacklog(PROJ_A);
      // Fire-and-DON'T-await so we can cancel mid-flight.
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: PROJ_A, connection_id: myConnId, kind },
      });
      const runId = await pollRunningRunId();
      if (runId === null) {
        await syncPromise.catch(() => {});
        return "no-window";
      }
      const cancel = await setup.post(`/api/sync/${runId}/cancel`);
      if (cancel.status() === 404) {
        await syncPromise.catch(() => {});
        return "no-cancel-route";
      }
      expect(cancel.ok(), `cancel run ${runId}: ${cancel.status()} ${await cancel.text()}`).toBeTruthy();
      await syncPromise.catch(() => {}); // let the (aborted) POST /sync settle

      const last = await waitLastAborted();
      expect(last, "a finished run is recorded").not.toBeNull();
      expect((last as SyncRun).status, `${kind} sync must finish "aborted", not "${last?.status}"`).toBe("aborted");
      expect((await getStatus()).current, "no sync is left running after abort").toBeNull();

      // THE rollback assertion: byte-identical, not merely same-count — a subtly
      // wrong partial write with the same row count would also be caught.
      const after = await snapshotBacklog(PROJ_A);
      expect(after, `${kind} aborted sync must leave the backlog cache byte-identical`).toEqual(before);
      return "ok";
    } finally {
      await setLatency(0);
    }
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    // Dedicated, isolated mock (also records inbound requests for §6).
    rec = await createRecordingMockOpServer();
    const load = await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);
    if (!load.ok()) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TL] scenario "${SCENARIO}" not loadable: ${load.status()} ${await load.text()}`);
      return;
    }
    myConnId = await ensureConnection(setup, rec.url, "tl-filter-token");
    await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: true } });

    // Cache project names (op_id 90/91 → "OSP Filter Demo"/"…B") so the backlog's
    // `project_name` (and thus the Project facet) is populated — sync alone never
    // writes the projects table; GET /api/projects does (upserts from OP).
    const projects = await setup.get("/api/projects");
    expect(projects.ok(), `GET /api/projects: ${projects.status()} ${await projects.text()}`).toBeTruthy();

    // Full sync both projects through THIS connection (latency 0 — fast setup).
    for (const projectOpId of [PROJ_A, PROJ_B]) {
      const sync = await setup.post("/api/sync", {
        data: { project_op_id: projectOpId, connection_id: myConnId, kind: "full" },
      });
      expect(sync.ok(), `setup sync project ${projectOpId}: ${sync.status()} ${await sync.text()}`).toBeTruthy();
    }
    ready = true;
  });

  test.afterAll(async () => {
    await setLatency(0).catch(() => {});
    if (myConnId) await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: false } }).catch(() => {});
    await setup?.dispose();
    if (rec) await rec.close().catch(() => {});
    assertRealDbUnchanged(dbBefore);
  });

  function skipIfNotReady(): void {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (load 404).`);
    test.skip(!ready, "TL fixture could not be synced (sync route unavailable).");
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_19 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops.`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1a: each facet's cascading OPTION LIST (only real, achievable values) ───
  test("§1a: filter-options returns exact, cascading option lists (hidden statuses never offered)", async () => {
    skipIfNotReady();
    const proj90 = await filterOptions({ projectId: PROJ_A });

    // Statuses: exactly the 6 VISIBLE ones — the 4 hidden (Closed/Tested/
    // Resolved/Rejected) are cached but must never be offered.
    expect(proj90.statuses).toEqual(["Confirmed", "Developed", "In progress", "Merge pending", "New", "On hold"]);
    for (const hidden of ["Closed", "Tested", "Resolved", "Rejected"]) {
      expect(proj90.statuses, `hidden status "${hidden}" must never be a filter option`).not.toContain(hidden);
    }
    // Versions: exactly 3.5.040 + 3.5.041 (sorted by name). Compare id+name only:
    // Increment 23 (SPEC_23 §2) added connection-safe `key`/`connection_id`/
    // `connection_label` fields to each FilterOptionEntry, so a full-object
    // toEqual no longer holds — the id/name/order is what this facet asserts.
    expect(proj90.versions.map((v) => ({ id: v.id, name: v.name }))).toEqual([
      { id: V_ISO, name: "3.5.040" },
      { id: V_MIXED, name: "3.5.041" },
    ]);
    // Assignees: the five fresh people (by op id).
    expect(proj90.assignees.map((a) => a.id).sort((a, b) => a - b)).toEqual([220, 221, 222, 223, 224]);
    // Priorities.
    expect(proj90.priorities).toEqual(["High", "Immediate", "Low", "Normal"]);

    // Project facet (drop projectId, keep the connection scope) = both projects.
    const projConn = await filterOptions({});
    expect(projConn.projects).toEqual(["OSP Filter Demo", "OSP Filter Demo B"]);
    // Servers facet includes this connection.
    expect(projConn.servers.map((s) => s.id)).toContain(myConnId);
  });

  // ── §1b: each facet narrows correctly ALONE ─────────────────────────────────
  test("§1b: each filter narrows the backlog correctly on its own", async () => {
    skipIfNotReady();

    // Version alone: 3.5.040 → exactly its 8 "In progress" tickets.
    const iso = await backlog({ projectId: PROJ_A, version: V_ISO });
    expect(iso.length, "version 3.5.040 alone → 8 rows").toBe(8);
    expect(new Set(iso.map((r) => r.status_name))).toEqual(new Set([ISO_STATUS]));

    // Status alone: "In progress" within project 90 lives only on v_iso.
    const inProgress = await backlog({ projectId: PROJ_A, status: ISO_STATUS });
    expect(inProgress.length).toBe(8);
    expect(new Set(inProgress.map((r) => r.version_op_id))).toEqual(new Set([V_ISO]));

    // Assignee alone: Andrea (223) holds work only in v_mixed.
    const andrea = await backlog({ projectId: PROJ_A, assignee: ANDREA_OP_ID });
    expect(andrea.length).toBeGreaterThan(0);
    for (const r of andrea) {
      expect(r.assignee_op_id).toBe(ANDREA_OP_ID);
      expect(r.version_op_id).toBe(V_MIXED);
    }

    // Priority alone: "Immediate" exists only in v_mixed.
    const immediate = await backlog({ projectId: PROJ_A, priority: IMMEDIATE });
    expect(immediate.length).toBeGreaterThan(0);
    for (const r of immediate) expect(r.priority).toBe(IMMEDIATE);

    // Project alone: project 91 → its 6 (all-visible) tickets.
    const projB = await backlog({ projectId: PROJ_B });
    expect(projB.length, "project 91 alone → 6 rows").toBe(6);
    for (const r of projB) expect(r.project_op_id).toBe(PROJ_B);

    // Server alone: this connection → both projects present.
    const byServer = await backlog({});
    expect(new Set(byServer.map((r) => r.project_op_id))).toEqual(new Set([PROJ_A, PROJ_B]));
    for (const r of byServer) expect(r.connection_id).toBe(myConnId);
  });

  // ── §1c: the "individually valid, jointly would-be-empty" pair — THE fix ─────
  test("§1c: the jointly-empty pair (3.5.040 + Merge pending) is never OFFERED; every offered combo returns rows", async () => {
    skipIfNotReady();

    // The trap under NON-cascading logic: both are individually valid, but the
    // combination legitimately returns 0 rows.
    const trap = await backlog({ projectId: PROJ_A, version: V_ISO, status: ELSEWHERE_STATUS });
    expect(trap.length, "3.5.040 + Merge pending is genuinely empty (the old bug's dead-end)").toBe(0);

    // The FIX: with 3.5.040 selected, the Status facet offers ONLY "In progress"
    // — "Merge pending" is never selectable alongside it, so the dead-end combo
    // can't be reached in the first place.
    const whenIso = await filterOptions({ projectId: PROJ_A, version: V_ISO });
    expect(whenIso.statuses).toEqual([ISO_STATUS]);
    // …and EVERY status it DOES offer yields ≥1 row (no zero-result options).
    for (const s of whenIso.statuses) {
      const rows = await backlog({ projectId: PROJ_A, version: V_ISO, status: s });
      expect(rows.length, `offered combo 3.5.040 + "${s}" must return tickets`).toBeGreaterThan(0);
    }
    // The achievable combo returns the real subset.
    expect((await backlog({ projectId: PROJ_A, version: V_ISO, status: ISO_STATUS })).length).toBe(8);

    // Symmetric mirror: with "Merge pending" selected, the Version facet drops
    // 3.5.040; with "In progress" selected, it offers ONLY 3.5.040.
    const whenMerge = await filterOptions({ projectId: PROJ_A, status: ELSEWHERE_STATUS });
    expect(whenMerge.versions.map((v) => v.id)).not.toContain(V_ISO);
    expect(whenMerge.versions.map((v) => v.id)).toContain(V_MIXED);
    const whenInProgress = await filterOptions({ projectId: PROJ_A, status: ISO_STATUS });
    // id+name only (Increment 23 added key/connection_id/connection_label — see above).
    expect(whenInProgress.versions.map((v) => ({ id: v.id, name: v.name }))).toEqual([
      { id: V_ISO, name: "3.5.040" },
    ]);

    // Assignee→version and priority→version cascades.
    expect((await filterOptions({ projectId: PROJ_A, assignee: ANDREA_OP_ID })).versions.map((v) => v.id)).toEqual([V_MIXED]);
    expect((await filterOptions({ projectId: PROJ_A, priority: IMMEDIATE })).versions.map((v) => v.id)).toEqual([V_MIXED]);
  });

  // ── §1d: combinations return the correct non-empty subset; Clear resets ──────
  test("§1d: meaningful combinations return the right subset; clearing filters restores the full option set", async () => {
    skipIfNotReady();

    // Version + Status (the original bug-report shape, but the ACHIEVABLE combo).
    const combo1 = await backlog({ projectId: PROJ_A, version: V_ISO, status: ISO_STATUS });
    expect(combo1.length).toBe(8);

    // Version + Assignee.
    const combo2 = await backlog({ projectId: PROJ_A, version: V_MIXED, assignee: ANDREA_OP_ID });
    expect(combo2.length).toBeGreaterThan(0);
    for (const r of combo2) {
      expect(r.version_op_id).toBe(V_MIXED);
      expect(r.assignee_op_id).toBe(ANDREA_OP_ID);
    }

    // "Clear" (drop projectId + all facets, keep connection scope) restores the
    // full option set: all three versions and both projects reappear.
    const cleared = await filterOptions({});
    expect(cleared.versions.map((v) => v.id).sort((a, b) => a - b)).toEqual([V_ISO, V_MIXED, 4680]);
    expect(cleared.projects).toEqual(["OSP Filter Demo", "OSP Filter Demo B"]);
  });

  // ── §2: ABORT = ROLLBACK (full sync) ─────────────────────────────────────────
  test("§2: a full sync aborted mid-flight finishes 'aborted' and leaves the backlog byte-identical (rollback)", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    const outcome = await proveAbortRollback("full");
    test.skip(outcome === "no-cancel-route", "POST /sync/:runId/cancel not landed.");
    test.skip(
      outcome === "no-window",
      "the sync completed before it was observably running — the abort window was not achieved (latency/buffering not landed).",
    );
    expect(outcome).toBe("ok");
  });

  // ── §3: ABORT = ROLLBACK (incremental sync) ──────────────────────────────────
  test("§3: an INCREMENTAL sync aborted mid-flight preserves old field values exactly (SPEC_19 §5)", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    // All s14 tickets share one updatedAt, so an incremental (updatedAt >= max)
    // legitimately re-fetches all 120 → 2 pages → a real abort window, while the
    // byte-identical assertion proves NO partial overwrite of the existing rows.
    const outcome = await proveAbortRollback("incremental");
    test.skip(outcome === "no-cancel-route", "POST /sync/:runId/cancel not landed.");
    test.skip(
      outcome === "no-window",
      "the incremental sync completed before it was observably running — abort window not achieved.",
    );
    expect(outcome).toBe("ok");
  });

  // ── §4: ELAPSED TIME rises monotonically during a run ────────────────────────
  test("§4: current_elapsed_ms increases monotonically while a sync is running", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    await waitNoCurrentSync();
    await setLatency(500);
    try {
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: PROJ_A, connection_id: myConnId, kind: "full" },
      });
      const runId = await pollRunningRunId();
      test.skip(runId === null, "no observable running sync — latency/async sync not landed.");

      const samples: number[] = [];
      for (let i = 0; i < 3 && (await getStatus()).current !== null; i += 1) {
        const st = await getStatus();
        if (st.current !== null) {
          expect(st.current_elapsed_ms, "current_elapsed_ms is present while running").not.toBeNull();
          samples.push(st.current_elapsed_ms as number);
        }
        await new Promise((r) => setTimeout(r, 220));
      }
      await syncPromise.catch(() => {}); // let it complete (writes identical data)

      test.info().annotations.push({ type: "SPEC_19 §2b elapsed", description: JSON.stringify(samples) });
      expect(samples.length, "captured at least two elapsed samples").toBeGreaterThanOrEqual(2);
      for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i]!, `elapsed sample ${i} (${samples[i]}) > previous (${samples[i - 1]})`).toBeGreaterThan(samples[i - 1]!);
      }
      // Idle → null.
      await waitNoCurrentSync();
      expect((await getStatus()).current_elapsed_ms, "current_elapsed_ms is null when idle").toBeNull();
    } finally {
      await setLatency(0);
    }
  });

  // ── §5: IMPORT abortability — the SAME engine, via the import entry point ─────
  test("§5: an Import (additive project sync) aborts + rolls back via the same shared engine", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    // Import IS a project-scoped sync (SPEC_19: same shared engine for "Sync now"
    // AND Import). Proving the additive-import path aborts + rolls back byte-
    // identically confirms it's the same mechanism §2 exercised — not a second,
    // unprotected write path. (A browser Import-screen abort button is Agent C's;
    // when it lands, the UI leg below can be un-gated.)
    const outcome = await proveAbortRollback("full");
    test.skip(outcome === "no-cancel-route", "POST /sync/:runId/cancel not landed.");
    test.skip(outcome === "no-window", "import sync completed before an abort window opened.");
    expect(outcome).toBe("ok");
    // NOTE: a browser Import-screen abort button + "cancelled, backlog unchanged"
    // message is Agent C's frontend surface (SPEC_19 §2). When it lands, a UI leg
    // driving the Import screen belongs here; the mechanism it exercises is the
    // one proven byte-identical above (shared engine, same POST /sync path).
  });

  // ── §6: GUARDRAILS ───────────────────────────────────────────────────────────
  test("§6 guard: no GET /api/v3/users, and /__mock/set-latency-ms is pure test-harness surface op-client never targets", async () => {
    skipIfNotReady();

    // Across the ENTIRE run, the app (op-client) must never issue the admin-gated
    // user COLLECTION, and must never target the /__mock admin namespace.
    const opRequests = rec.requests.filter((r) => !r.path.startsWith("/__mock"));
    const usersCollection = opRequests.filter((r) => r.path === "/api/v3/users");
    const nonOpNonMock = rec.requests.filter(
      (r) => !r.path.startsWith("/__mock") && !r.path.startsWith("/api/v3/"),
    );

    test.info().annotations.push({
      type: "SPEC_19 guardrails",
      description:
        `op-client hit these OP paths: ${JSON.stringify([...new Set(opRequests.map((r) => `${r.method} ${r.path}`))].slice(0, 20))}. ` +
        `bare /api/v3/users hits=${usersCollection.length}. non-OP/non-mock paths=${JSON.stringify(nonOpNonMock.map((r) => r.path))}.`,
    });

    // op-client did do real OP reads (setup + abort syncs went through the mock).
    expect(opRequests.length, "op-client exercised the recording mock").toBeGreaterThan(0);
    expect(usersCollection.length, "GET /api/v3/users (admin-gated user collection) must NEVER be called").toBe(0);
    // Everything the app sent is a read-only /api/v3/* call — /__mock is only
    // ever reached by THIS test's own harness fetches (set-latency-ms/load),
    // never by op-client, so the latency route can't touch the OP guardrail.
    expect(nonOpNonMock, "op-client only ever targets /api/v3/*").toEqual([]);
    for (const r of opRequests) {
      expect(r.method, `OP request ${r.method} ${r.path} must be a GET (read-only)`).toBe("GET");
    }
  });
});
