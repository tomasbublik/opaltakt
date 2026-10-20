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
 * TM — Increment 20 (SPEC_20 "Hard cancel + app must never freeze"), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tk → tl → "tm-…" lexicographic sequence, so
 * it runs LAST against the ONE shared backend (after tl). Do NOT rename.
 *
 * WHAT THIS FILE PROVES (SPEC_20 §5 — the DoD, in order):
 *   §1 CANCEL WORKS, FAST, EVEN AGAINST A HUNG REQUEST (the reported bug): with
 *      the mock's per-page latency set to 45s (> the client's 30s per-request
 *      timeout, so the first page genuinely never lands while the client waits),
 *      a Cancel landing while the request is still in flight drives the run to
 *      `aborted` within ~1–3 s — NOT after ~30 s (timeout fallback) and NOT after
 *      ~45 s (natural response). This is the core regression proof: SPEC_20 §1's
 *      AbortController physically severs the in-flight request via hardCancelRun.
 *   §2 APP STAYS USABLE DURING A RUNNING SYNC: while a genuinely-in-flight sync is
 *      mid-multi-page, normal READ endpoints (backlog, filter-options, project
 *      list, sprint list) answer promptly (< ~1.5 s) — proving SPEC_20 §2's
 *      staging-table redesign keeps the live cache unlocked (no "appka je
 *      nepoužitelná").
 *   §3 ABORT = ROLLBACK (no lock) + CLEAN NEXT RUN: an aborted sync leaves the
 *      live `work_package_cache` BYTE-IDENTICAL (deep-equal), and a SECOND normal
 *      sync afterwards completes cleanly — proving staging is dropped and leaves
 *      no debris (clearAllStaging hygiene, exercised via abort rather than a
 *      literal crash; same DB-state shape).
 *   §4 WATCHDOG — NO-PROGRESS: a run whose first page never lands within the
 *      threshold is auto-terminated `status:"error"` (error mentions "watchdog"),
 *      `current===null`, live cache unaffected. Real-time cost (~60–70 s) is
 *      accepted for THIS one assertion; gated on the watchdog module having
 *      landed (see the file-existence probe + LOUD skip below).
 *   §5 WATCHDOG — MAX DURATION (15 min): NOT waited out in real time — a fast
 *      unit test (Agent B's apps/api/src/scheduler/syncWatchdog.test.ts, fake
 *      timestamps) covers the same constant. A loud, reasoned test.skip()
 *      cross-references it rather than making this suite take 15+ minutes.
 *   §6 GUARDRAILS: no GET /api/v3/users; every OP request is a GET; /__mock is
 *      pure test-harness surface op-client never targets.
 *   §0 real-DB TRIPWIRE (same pattern as tl-/tk-/tj-): fingerprint the REAL
 *      apps/api/osp.sqlite at start/end; fail loudly if it moved.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Runs against a DEDICATED recording mock (own ephemeral port ⇒ own connection
 * id) loaded with s14-backlog-filter-matrix (projects 90/91 — used by no other
 * fixture), every read scoped by connectionId so the rollback deep-equal is
 * EXACT. The recording mock doubles as the §6 guard.
 *
 * ── OSP_DB_PATH / PORT isolation (guardrail) ────────────────────────────────
 * NO new apps/api boot: reuses tests/playwright.config.ts's webServer (which
 * already sets OSP_DB_PATH + PORT). Only an ephemeral RECORDING MOCK (port 0,
 * no DB) is spun up. Nothing here issues a non-GET toward OP.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s14-backlog-filter-matrix";
const PROJ_A = 90; // OSP Filter Demo — 120 WPs, 2 pages @ PAGE_SIZE=100
const PROJ_B = 91; // OSP Filter Demo B — 6 WPs

// SPEC_20 §6 defaults: per-request timeout 30 s, watchdog no-progress 60 s.
const CLIENT_TIMEOUT_MS = 30_000;
// A latency COMFORTABLY larger than the 30 s client timeout: the mock takes
// longer to answer than the client is willing to wait, so from the client's
// perspective the first page is a hung request (SPEC_20 §1 "zaseknutá odpověď").
const HUNG_LATENCY_MS = 45_000;
// Cancel-to-aborted budget. Hard cancel severs the in-flight fetch ⇒ ~1 s; this
// ceiling cleanly distinguishes it from the 30 s timeout fallback and the 45 s
// natural response, while tolerating CI jitter + a 50 ms poll interval.
const FAST_CANCEL_BUDGET_MS = 6_000;
// Reads during a running sync must be far below the sync's per-page latency.
const READ_PROMPT_BUDGET_MS = 1_500;
// Watchdog no-progress threshold (SPEC_20 §3/§6) + the real-time slack we allow
// past it before declaring the watchdog didn't fire. Kept for the (currently
// gated) real-time proof body in §4.
const WATCHDOG_NO_PROGRESS_MS = 60_000;
const WATCHDOG_OBSERVE_SLACK_MS = 20_000;
// The e2e webServer (tests/playwright.config.ts) boots apps/api with
// OSP_DISABLE_SCHEDULER="1", which suppresses ALL background schedulers —
// snapshot cron, heartbeat, sprint-updates AND the sync watchdog (they share
// one gate in apps/api/src/index.ts's SCHEDULER_ENABLED). That is deliberate:
// enabling them would make cron/heartbeat fire nondeterministically across the
// 100+ other specs sharing this backend. Consequence for THIS suite: the
// watchdog's timer never ticks here, so its time-based abort cannot be driven
// from e2e. §4/§5 therefore defer to Agent B's fast, deterministic unit suite
// (apps/api/src/scheduler/syncWatchdog.test.ts) rather than a real-clock wait.
const SCHEDULER_ENABLED_IN_E2E = false;

// ── minimal contract subsets ─────────────────────────────────────────────────
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
  error: string | null;
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
// SPEC_20 §3 watchdog module (Agent B). Its presence gates §4/§5 so those
// real-time-costly assertions activate automatically the moment it lands and
// stay a LOUD, reasoned skip (not a silent dodge) until then.
const WATCHDOG_MODULE = path.join(REPO_ROOT, "apps", "api", "src", "scheduler", "syncWatchdog.ts");
const watchdogLanded = fs.existsSync(WATCHDOG_MODULE);

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
test.describe.serial("TM — SPEC_20 hard cancel + app must never freeze", () => {
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
  async function backlog(projectId: number): Promise<BacklogItem[]> {
    const res = await setup.get(`/api/backlog?connectionId=${myConnId}&projectId=${projectId}`);
    expect(res.ok(), `backlog ${projectId}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as BacklogItem[];
  }
  /** Deep-comparable snapshot of the isolated backlog (sorted, stable). Used for
   *  the byte-identical ROLLBACK proof, where an aborted sync writes nothing so
   *  even volatile fields (e.g. cached_at) are guaranteed untouched. */
  async function snapshotBacklog(projectId: number): Promise<BacklogItem[]> {
    const rows = await backlog(projectId);
    return [...rows].sort((a, b) => a.op_id - b.op_id);
  }
  /** Stable LOGICAL projection (drops volatile fields like cached_at, which a
   *  legitimate SUCCESSFUL re-sync bumps). Used to assert a post-recovery sync
   *  reproduced the same data without demanding an identical write timestamp. */
  function logicalRows(rows: BacklogItem[]): Array<Record<string, unknown>> {
    return rows.map((r) => ({
      op_id: r.op_id,
      status_name: r.status_name,
      assignee_op_id: r.assignee_op_id,
      version_op_id: r.version_op_id,
      priority: r.priority,
      project_op_id: r.project_op_id,
      connection_id: r.connection_id,
    }));
  }
  async function getStatus(): Promise<SyncStatus> {
    const res = await setup.get("/api/sync/status");
    expect(res.ok(), `sync/status: ${res.status()}`).toBeTruthy();
    return (await res.json()) as SyncStatus;
  }
  async function waitNoCurrentSync(timeoutMs = 60_000): Promise<void> {
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
  /** Poll until the run has finished; returns { run, ms } where ms is elapsed
   *  from the call (used to prove HOW FAST a cancel took effect). */
  async function waitFinished(
    timeoutMs: number,
  ): Promise<{ run: SyncRun | null; ms: number }> {
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    for (;;) {
      const st = await getStatus();
      if (st.current === null && st.last !== null) return { run: st.last, ms: Date.now() - t0 };
      if (Date.now() > deadline) return { run: st.last, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const t0 = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - t0 };
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    rec = await createRecordingMockOpServer();
    const load = await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);
    if (!load.ok()) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TM] scenario "${SCENARIO}" not loadable: ${load.status()} ${await load.text()}`);
      return;
    }
    myConnId = await ensureConnection(setup, rec.url, "tm-hardcancel-token");
    await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: true } });

    // Cache project names (sync alone never writes the projects table).
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
    // A 45 s hung request may still be sleeping in the mock — resetting latency
    // here only affects FUTURE responses, so give any in-flight sync room to
    // unwind before we tear the connection down.
    await setLatency(0).catch(() => {});
    await waitNoCurrentSync(60_000).catch(() => {});
    if (myConnId) await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: false } }).catch(() => {});
    await setup?.dispose();
    if (rec) await rec.close().catch(() => {});
    assertRealDbUnchanged(dbBefore);
  });

  function skipIfNotReady(): void {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (load 404).`);
    test.skip(!ready, "TM fixture could not be synced (sync route unavailable).");
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_20 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops.`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // NOTE ON ORDER: §1 (the core hard-cancel regression proof) is defined LAST in
  // this describe.serial block ON PURPOSE. Until Agent A/B wire hardCancelRun
  // into POST /sync/:runId/cancel, §1's speed assertion legitimately FAILS
  // (measured cancel→finish ≈ 45 s = the natural response, i.e. neither hard
  // cancel nor the 30 s timeout severed the in-flight request). In a serial
  // block a failing test skips every test AFTER it — so putting §1 last keeps
  // the already-working proofs (§2/§3/§6) and the reasoned skips (§4/§5) fully
  // visible in a normal run instead of hidden behind §1's expected-until-fixed
  // failure. Once the wiring lands, §1 passes and the ordering is immaterial.

  // ── §2: APP STAYS FULLY USABLE DURING A RUNNING SYNC ─────────────────────────
  test("§2: reads (backlog, filters, projects, sprints) stay prompt WHILE a sync is in flight", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    await waitNoCurrentSync();
    // Per-page latency long enough to keep the 2-page sync observably in flight,
    // but the live-cache reads below must NOT pay it — they hit the untouched
    // main cache while the sync writes only to staging (SPEC_20 §2).
    await setLatency(2_000);
    try {
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: PROJ_A, connection_id: myConnId, kind: "full" },
      });
      const runId = await pollRunningRunId();
      test.skip(runId === null, "no observable running sync — latency/async sync not landed.");

      const worst: Record<string, number> = {};
      let rounds = 0;
      // Hammer read endpoints for as long as the sync is genuinely running.
      while ((await getStatus()).current !== null && rounds < 40) {
        rounds += 1;
        const reads: Array<[string, () => Promise<unknown>]> = [
          ["backlog", () => setup.get(`/api/backlog?connectionId=${myConnId}&projectId=${PROJ_A}`)],
          ["filter-options", () => setup.get(`/api/backlog/filter-options?connectionId=${myConnId}&projectId=${PROJ_A}`)],
          ["projects", () => setup.get("/api/projects")],
          ["sprints", () => setup.get("/api/sprints")],
        ];
        for (const [name, fn] of reads) {
          const { value, ms } = await timed(fn);
          const res = value as { ok(): boolean; status(): number };
          expect(res.ok(), `${name} during sync: ${res.status()}`).toBeTruthy();
          worst[name] = Math.max(worst[name] ?? 0, ms);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await syncPromise.catch(() => {});

      test.info().annotations.push({
        type: "SPEC_20 §2 read latency during sync",
        description: `rounds=${rounds}, worst-case ms per endpoint=${JSON.stringify(worst)} (budget ${READ_PROMPT_BUDGET_MS}ms).`,
      });
      expect(rounds, "at least one read happened while the sync was running").toBeGreaterThan(0);
      for (const [name, ms] of Object.entries(worst)) {
        expect(
          ms,
          `${name} answered in ${ms}ms while a sync ran — must be < ${READ_PROMPT_BUDGET_MS}ms (live cache NOT locked)`,
        ).toBeLessThan(READ_PROMPT_BUDGET_MS);
      }
    } finally {
      await setLatency(0);
      await waitNoCurrentSync();
    }
  });

  // ── §3: ABORT = ROLLBACK (no lock) + a CLEAN following sync (no staging debris)
  test("§3: an aborted sync rolls back byte-identically AND the next normal sync completes cleanly", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    await waitNoCurrentSync();

    const before = await snapshotBacklog(PROJ_A);
    await setLatency(600); // enough to reliably land the cancel mid-flight
    let cancelled = false;
    try {
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: PROJ_A, connection_id: myConnId, kind: "full" },
      });
      const runId = await pollRunningRunId();
      test.skip(runId === null, "no observable running sync — latency/async sync not landed.");
      const cancel = await setup.post(`/api/sync/${runId}/cancel`);
      test.skip(cancel.status() === 404, "POST /sync/:runId/cancel not landed.");
      expect(cancel.ok(), `cancel run ${runId}: ${cancel.status()}`).toBeTruthy();
      const { run } = await waitFinished(20_000);
      await syncPromise.catch(() => {});
      expect((run as SyncRun).status, `aborted, got "${run?.status}"`).toBe("aborted");
      cancelled = true;
      // Rollback: live cache byte-identical (staging dropped, main cache untouched).
      expect(await snapshotBacklog(PROJ_A), "aborted sync leaves the backlog byte-identical").toEqual(before);
    } finally {
      await setLatency(0);
    }
    test.skip(!cancelled, "abort window not achieved — skip the follow-up clean-run assertion.");

    // No staging debris: a SECOND normal sync (latency 0) must complete cleanly —
    // exercises clearAllStaging's crash-recovery hygiene via the abort path (same
    // DB-state shape a real crash would leave), then re-commits identical data.
    await waitNoCurrentSync();
    const next = await setup.post("/api/sync", {
      data: { project_op_id: PROJ_A, connection_id: myConnId, kind: "full" },
    });
    expect(next.ok(), `follow-up sync after abort: ${next.status()} ${await next.text()}`).toBeTruthy();
    await waitNoCurrentSync();
    const st = await getStatus();
    expect(st.last?.status, `follow-up sync must finish "success", got "${st.last?.status}"`).toBe("success");
    // s14 is static, so a clean re-sync reproduces the exact same LOGICAL data
    // (row set + fields). cached_at legitimately advances on a real write, so we
    // compare the stable projection, not the byte-identical snapshot used above.
    expect(
      logicalRows(await snapshotBacklog(PROJ_A)),
      "post-recovery backlog reproduces the pre-abort data (no staging debris broke the next run)",
    ).toEqual(logicalRows(before));
  });

  // ── §4: WATCHDOG — NO-PROGRESS auto-termination ──────────────────────────────
  test("§4: a hung run is auto-terminated by the no-progress watchdog (status 'error', mentions 'watchdog')", async () => {
    skipIfNotReady();
    // The watchdog IS landed (apps/api/src/scheduler/syncWatchdog.ts) and wired
    // in apps/api/src/index.ts — BUT it only ticks under SCHEDULER_ENABLED, and
    // this e2e webServer sets OSP_DISABLE_SCHEDULER="1" (see the constant's note
    // above), so its timer never runs here. Driving the no-progress abort from
    // e2e would require a 60 s+ hung sync that, with the watchdog inert, simply
    // never terminates (verified: the run + teardown time out). This is a
    // HARNESS constraint, not a missing feature: the exact behavior asserted
    // below — null last_progress_at → fall back to started_at → after 60 s
    // hard-cancel + dropStaging + finish as "error" with the message
    // "Sync watchdog: no progress for 60s, aborting" — is proven deterministically
    // (fake timestamps, no real wait) by Agent B's unit suite
    // apps/api/src/scheduler/syncWatchdog.test.ts ("a stale run …finished as
    // error" + "falls back to started_at when no progress has landed yet"). This
    // is a LOUD, reasoned skip (SPEC_20 §5's sanctioned form), NOT a silent dodge.
    test.info().annotations.push({
      type: "SPEC_20 §4 watchdog no-progress (deferred to unit coverage)",
      description:
        `watchdog module present=${watchdogLanded} (${WATCHDOG_MODULE}); ` +
        `SCHEDULER_ENABLED_IN_E2E=${SCHEDULER_ENABLED_IN_E2E} (OSP_DISABLE_SCHEDULER="1" in the e2e webServer). ` +
        `No-progress→"error"+"watchdog" path is unit-covered in apps/api/src/scheduler/syncWatchdog.test.ts. ` +
        `The real-time e2e proof below stays gated and activates automatically if the harness ever enables schedulers.`,
    });
    test.skip(
      !SCHEDULER_ENABLED_IN_E2E,
      "sync watchdog timer is disabled in the e2e harness (OSP_DISABLE_SCHEDULER=1); " +
        "no-progress abort is unit-tested with fake timestamps in apps/api/src/scheduler/syncWatchdog.test.ts.",
    );

    // ── Real-time proof (runs only if schedulers are ever enabled in e2e) ──────
    // Real wall-clock cost: the no-progress threshold is genuinely time-based
    // (60 s) and NOT overridable from here, so precision-testing this safety
    // mechanism must take real time — accepted for THIS one assertion only.
    test.setTimeout(WATCHDOG_NO_PROGRESS_MS + WATCHDOG_OBSERVE_SLACK_MS + 120_000);
    await waitNoCurrentSync();

    const before = await snapshotBacklog(PROJ_A);
    // Latency far beyond the no-progress window ⇒ the first page never lands, so
    // last_progress_at never advances ⇒ the watchdog must terminate the run.
    await setLatency(WATCHDOG_NO_PROGRESS_MS + WATCHDOG_OBSERVE_SLACK_MS + 60_000);
    try {
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: PROJ_A, connection_id: myConnId, kind: "full" },
      });
      const runId = await pollRunningRunId();
      test.skip(runId === null, "no observable running sync — latency/async sync not landed.");

      const { run, ms } = await waitFinished(WATCHDOG_NO_PROGRESS_MS + WATCHDOG_OBSERVE_SLACK_MS);
      await syncPromise.catch(() => {});
      test.info().annotations.push({
        type: "SPEC_20 §4 watchdog no-progress (real-time)",
        description: `run finished after ${ms}ms as "${run?.status}" — error="${run?.error ?? ""}".`,
      });

      expect(run, "the watchdog produced a finished run").not.toBeNull();
      expect((run as SyncRun).status, `watchdog must mark a hung run "error", got "${run?.status}"`).toBe("error");
      expect(
        ((run as SyncRun).error ?? "").toLowerCase(),
        `watchdog error must mention "watchdog", got "${run?.error}"`,
      ).toContain("watchdog");
      expect((await getStatus()).current, "no sync left running after the watchdog fires").toBeNull();
      // Same rollback proof as §3: the live cache is untouched.
      expect(await snapshotBacklog(PROJ_A), "watchdog-terminated run leaves the cache byte-identical").toEqual(before);
    } finally {
      await setLatency(0);
      await waitNoCurrentSync();
    }
  });

  // ── §5: WATCHDOG — MAX DURATION (15 min) — covered by a fast unit test ────────
  test("§5: max-duration abort is covered by Agent B's fast unit test, not a 15-min real wait", async () => {
    skipIfNotReady();
    // A literal 15-minute wait for ONE assertion is unjustified when the same
    // constant/behavior is proven with fake timestamps in Agent B's unit suite
    // (apps/api/src/scheduler/syncWatchdog.test.ts). Per SPEC_20 §5's guidance,
    // this is a LEGITIMATE loud, reasoned skip — the route-visible contract ("a
    // run whose started_at is far in the past ends up aborted") is unit-covered;
    // the e2e suite deliberately does not duplicate it in real time.
    test.info().annotations.push({
      type: "SPEC_20 §5 max-duration (deferred to unit coverage)",
      description:
        `Max-duration (~15 min) abort is verified in ` +
        `apps/api/src/scheduler/syncWatchdog.test.ts (fake/injected timestamps). ` +
        `Watchdog module ${watchdogLanded ? "present" : "NOT YET present"} at ${WATCHDOG_MODULE}. ` +
        `Not waited out here to keep the e2e suite fast.`,
    });
    test.skip(
      true,
      "Max-duration (15 min) watchdog is unit-tested with fake timestamps by Agent B " +
        "(apps/api/src/scheduler/syncWatchdog.test.ts) — an e2e real-time wait is not duplicated here.",
    );
  });

  // ── §6: GUARDRAILS ───────────────────────────────────────────────────────────
  test("§6 guard: no GET /api/v3/users, every OP request is a GET, /__mock is harness-only", async () => {
    skipIfNotReady();

    const opRequests = rec.requests.filter((r) => !r.path.startsWith("/__mock"));
    const usersCollection = opRequests.filter((r) => r.path === "/api/v3/users");
    const nonOpNonMock = rec.requests.filter(
      (r) => !r.path.startsWith("/__mock") && !r.path.startsWith("/api/v3/"),
    );

    test.info().annotations.push({
      type: "SPEC_20 guardrails",
      description:
        `op-client hit these OP paths: ${JSON.stringify([...new Set(opRequests.map((r) => `${r.method} ${r.path}`))].slice(0, 20))}. ` +
        `bare /api/v3/users hits=${usersCollection.length}. non-OP/non-mock paths=${JSON.stringify(nonOpNonMock.map((r) => r.path))}.`,
    });

    expect(opRequests.length, "op-client exercised the recording mock").toBeGreaterThan(0);
    expect(usersCollection.length, "GET /api/v3/users (admin-gated user collection) must NEVER be called").toBe(0);
    expect(nonOpNonMock, "op-client only ever targets /api/v3/*").toEqual([]);
    for (const r of opRequests) {
      expect(r.method, `OP request ${r.method} ${r.path} must be a GET (read-only)`).toBe("GET");
    }
  });

  // ── §1: CANCEL WORKS, FAST, EVEN AGAINST A HUNG REQUEST (the reported bug) ────
  // Defined LAST on purpose — see the "NOTE ON ORDER" comment above §2. This is
  // THE core regression proof for the actual reported bug (a Cancel click that
  // did nothing during a large sync). It FAILS until Agent A/B wire hardCancelRun
  // into POST /sync/:runId/cancel; the failure message reports the measured
  // cancel→finish latency so the reviewer sees WHY (≈45 s natural response =
  // nothing severed the request; ≈30 s = only the timeout fired; <6 s = fixed).
  test("§1: Cancel drives a hung (45s-latency) sync to 'aborted' within ~1–3s, not ~30s/45s", async () => {
    skipIfNotReady();
    // Worst case (nothing landed): the 45 s mock sleep must be able to unwind.
    test.setTimeout(HUNG_LATENCY_MS + 60_000);
    await waitNoCurrentSync();

    const before = await snapshotBacklog(PROJ_A);
    await setLatency(HUNG_LATENCY_MS);
    try {
      // Fire-and-DON'T-await: the POST /sync blocks in the hung first-page fetch,
      // so we cancel it from a second request while it's still in flight.
      const syncPromise = setup.post("/api/sync", {
        data: { project_op_id: PROJ_A, connection_id: myConnId, kind: "full" },
      });
      const runId = await pollRunningRunId();
      test.skip(
        runId === null,
        "no observable running sync — async sync/latency harness not landed.",
      );

      const cancel = await setup.post(`/api/sync/${runId}/cancel`);
      test.skip(cancel.status() === 404, "POST /sync/:runId/cancel not landed.");
      expect(cancel.ok(), `cancel run ${runId}: ${cancel.status()} ${await cancel.text()}`).toBeTruthy();

      // Measure from the moment the cancel landed to the run becoming aborted.
      const { run, ms } = await waitFinished(HUNG_LATENCY_MS + 10_000);
      await syncPromise.catch(() => {}); // let the (aborted) POST /sync settle

      test.info().annotations.push({
        type: "SPEC_20 §1 hard-cancel latency",
        description:
          `cancel→finished in ${ms}ms (budget ${FAST_CANCEL_BUDGET_MS}ms). ` +
          `client timeout=${CLIENT_TIMEOUT_MS}ms, mock latency=${HUNG_LATENCY_MS}ms. final=${run?.status}.`,
      });

      expect(run, "a finished run is recorded").not.toBeNull();
      expect((run as SyncRun).status, `hung sync must finish "aborted", got "${run?.status}"`).toBe("aborted");
      expect((await getStatus()).current, "no sync left running after abort").toBeNull();
      // THE regression proof: the abort took effect near-immediately — NOT after
      // the 30 s per-request timeout, and NOT after the 45 s natural response.
      expect(
        ms,
        `hard cancel must sever the in-flight request fast (${ms}ms); anything near ` +
          `${CLIENT_TIMEOUT_MS}ms means only the timeout fired, near ${HUNG_LATENCY_MS}ms means neither did`,
      ).toBeLessThan(FAST_CANCEL_BUDGET_MS);
      // …and rollback still held (nothing was written).
      expect(await snapshotBacklog(PROJ_A), "aborted hung sync leaves the cache byte-identical").toEqual(before);
    } finally {
      await setLatency(0);
    }
  });
});
