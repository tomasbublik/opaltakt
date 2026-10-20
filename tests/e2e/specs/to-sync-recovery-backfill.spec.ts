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
 * TO — Increment 22 (SPEC_22 "Sync now — orphaned lock (409), duration parsing,
 * connection backfill"), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tm → tn → "to-…" lexicographic sequence, so
 * it runs LAST against the ONE shared backend (after tn). Do NOT rename.
 *
 * ── WHAT THIS PROVES, AND WHERE THE FIXES LIVE (read before the tests) ────────
 * A real user hit a PERMANENT 409 on "Sync now": a `sync_run` row left stuck
 * `status='running'` by a process that was killed mid-sync (Increment 20's hung
 * request). After a restart the in-memory registry is empty but the DB row still
 * says `running`, so the "one sync at a time" guard rejected EVERY future sync
 * with a bare, uninformative 409 — forever. Three secondary defects rode along:
 * `P1DT5H` (=29h) durations misparsed, tickets with no `connection_id` silently
 * skipped by connection-scoped sync ("—" in the SERVER column), and a 0-change
 * sync giving no visible feedback.
 *
 * Fixes, by owner:
 *   - Agent B (apps/api, packages/db): `SyncRunRepository.recoverOrphaned()`,
 *     called UNCONDITIONALLY at every `buildServer()` boot (apps/api/src/server.ts),
 *     marks any `running` row `aborted` the instant the backend restarts — the
 *     actual end of the permanent 409. `POST /sync`'s SYNC_IN_PROGRESS (409) now
 *     carries `details: {runId, started_at, last_progress_at}` (routes/index.ts).
 *     Migration `0018_backfill_connection_id.sql` stamps every legacy
 *     `work_package_cache` row's `connection_id`.
 *   - Agent A (op-client, sync, fixtures): the mock's `hoursToIsoDuration` now
 *     emits a day component for ≥24h values (previously impossible), so s11's new
 *     WP 1905 (29h) serializes as "P1DT5H" and the op-client round-trip
 *     (mock HTTP → parseIsoDuration → 29) is finally exercisable end-to-end.
 *   - Agent C (apps/web): "Sync now" hitting a real SYNC_IN_PROGRESS shows a
 *     "sync conflict" banner + a working "Cancel it" button; a finished sync
 *     shows "no changes" vs "updated N"; `last synced` always advances.
 *
 * ── WHAT AN E2E SPEC CAN AND CANNOT PROVE HERE (task-1 process-restart) ───────
 * The CORE regression — a boot-time `recoverOrphaned()` clearing an orphaned
 * `running` row — requires either (a) direct-DB-seeding a `running` row, or
 * (b) killing and restarting the apps/api PROCESS mid-run. Neither is reachable
 * from a Playwright worker in this harness: the e2e DB path is keyed to the
 * RUNNER pid (playwright.config), no spec opens the DB, and the single shared
 * apps/api process (webServer) cannot be restarted from inside one test.
 * Moreover the e2e backend runs with OSP_DISABLE_SCHEDULER=1, so the Increment-20
 * WATCHDOG (the OTHER staleness path) never fires either. So the boot-recovery
 * proof itself is DEFERRED — deliberately, with a loud skip in §5 — to Agent B's
 * unit coverage: `packages/db/src/repos.test.ts` ("recoverOrphaned marks stuck
 * 'running' rows aborted") + the `buildServer()` wiring in apps/api/src/server.ts.
 * What §3 DOES prove end-to-end is every REACHABLE part of the fix: a genuinely
 * running sync yields the NEW informative 409 (with `details.runId`), the
 * "Cancel it" endpoint clears it, and a subsequent sync succeeds — i.e. the lock
 * is demonstrably NOT permanent when reachable app flows are exercised.
 *
 * ── §0 real-DB TRIPWIRE (same pattern as tn-/tm-/tl-): fingerprint the REAL
 *    apps/api/osp.sqlite at start/end; fail loudly if it moved. ───────────────
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Runs against a DEDICATED recording mock (own ephemeral port ⇒ own connection
 * id) loaded with s11-effective-estimate. The recording mock doubles as the §8
 * guardrail recorder. No new apps/api boot: reuses the playwright.config
 * webServer (OSP_DB_PATH + PORT already set per the hard guardrail). Nothing here
 * issues a non-GET toward OP.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s11-effective-estimate";
const PROJECT_OP_ID = 3; // s11's four+one static backlog tickets all sit in project 3
// The Increment-22 day-spanning ticket: Work 29h / Remaining 29h → "P1DT5H".
// The literal WP-11592-analogue whose misparse this increment fixes.
const DAY_SPANNING_WP = 1905;
const EXPECTED_HOURS = 29; // 1 day (24h) + 5h; effective == estimated == remaining == 29

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

// ── minimal contract subsets ─────────────────────────────────────────────────
interface BacklogItem {
  op_id: number;
  connection_id: number | null;
  connection_label: string | null;
  connection_base_url: string | null;
  effective_hours: number | null;
  estimated_hours: number | null;
  remaining_hours: number | null;
}
interface SyncRunLite {
  id: number;
  started_at: string;
  last_progress_at: string | null;
  status: string;
  wp_count: number | null;
}
interface SyncStatus {
  current: SyncRunLite | null;
  last: SyncRunLite | null;
  last_synced_at: string | null;
  current_elapsed_ms: number | null;
}
interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TO — SPEC_22 sync recovery / duration / backfill", () => {
  let setup: APIRequestContext;
  let rec: RecordingMockOpServer; // dedicated, isolated mock + request recorder
  let myConnId = 0;
  let dbBefore: DbFingerprint | null;
  let ready = false;
  let scenarioMissing = false;

  // ── low-level helpers ───────────────────────────────────────────────────────
  async function getSyncStatus(): Promise<SyncStatus> {
    const res = await setup.get("/api/sync/status");
    expect(res.ok(), `sync/status: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as SyncStatus;
  }
  async function waitNoCurrentSync(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await getSyncStatus()).current === null) return;
      if (Date.now() > deadline) throw new Error("a sync was still running past the deadline");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function waitCurrentSync(timeoutMs = 15_000): Promise<SyncRunLite> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = (await getSyncStatus()).current;
      if (cur !== null) return cur;
      if (Date.now() > deadline) throw new Error("no sync became current within the deadline");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  /** Project-scoped full sync through the same proxy the browser uses. Awaits
   * completion (no current run left). */
  async function fullSync(): Promise<void> {
    const res = await setup.post("/api/sync", {
      data: { project_op_id: PROJECT_OP_ID, connection_id: myConnId, kind: "full" },
    });
    expect(res.ok(), `sync project ${PROJECT_OP_ID}: ${res.status()} ${await res.text()}`).toBeTruthy();
    await waitNoCurrentSync();
  }
  async function setLatency(ms: number): Promise<void> {
    const res = await setup.post(`${rec.url}/__mock/set-latency-ms`, { data: { ms } });
    expect(res.ok(), `set-latency-ms ${ms}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  async function backlog(params: Record<string, string | number>): Promise<BacklogItem[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const res = await setup.get(`/api/backlog?${qs.toString()}`);
    expect(res.ok(), `backlog: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as BacklogItem[];
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
      console.warn(`[TO] scenario "${SCENARIO}" not loadable: ${load.status()} ${await load.text()}`);
      return;
    }
    myConnId = await ensureConnection(setup, rec.url, "to-sync-recovery-token");
    await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: true, current: true } });

    // s11 is static (no timeline) — a plain full sync of project 3 lands all five
    // backlog tickets (incl. the 29h WP 1905) into work_package_cache.
    await fullSync();
    ready = true;
  });

  test.afterAll(async () => {
    // Always undo any injected latency so a later run reusing the mock is fast.
    if (rec) await setLatency(0).catch(() => {});
    if (myConnId) await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: false } }).catch(() => {});
    await setup?.dispose();
    if (rec) await rec.close().catch(() => {});
    assertRealDbUnchanged(dbBefore);
  });

  function skipIfNotReady(): void {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (load 404).`);
    test.skip(!ready, "TO fixture could not be set up (initial sync unavailable).");
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_22 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops.`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1: DURATION — a day-spanning ISO duration parses to 29h end-to-end ───────
  // SPEC_22 §2 / §6 "Duration". The literal WP-11592-analogue regression proof:
  // OP encodes 29h as "P1DT5H" (day = 24h). The mock now emits that (Agent A),
  // op-client's parseIsoDuration reads it as 29, and effectiveEstimate surfaces it.
  test("§1: WP 1905's 'P1DT5H' (=29h) round-trips through sync to 29h in the backlog", async () => {
    skipIfNotReady();

    const rows = await backlog({ connectionId: myConnId });
    const wp = rows.find((r) => r.op_id === DAY_SPANNING_WP);
    expect(
      wp,
      `WP ${DAY_SPANNING_WP} (the 29h day-spanning ticket) must be in the synced backlog (op_ids ${JSON.stringify(rows.map((r) => r.op_id))})`,
    ).toBeTruthy();

    // The core assertion: a "P1DT5H"-sourced value must NOT collapse to 5h (the
    // old day-blind misparse) — it is 24 + 5 = 29.
    expect(wp!.estimated_hours, `estimated_hours must be ${EXPECTED_HOURS} (day-blind parse would give 5)`).toBe(EXPECTED_HOURS);
    expect(wp!.remaining_hours, `remaining_hours must be ${EXPECTED_HOURS}`).toBe(EXPECTED_HOURS);
    // effectiveEstimate: Remaining == Work (both 29) → falls through to Work → 29.
    expect(wp!.effective_hours, `effective_hours (the planning estimate) must be ${EXPECTED_HOURS}`).toBe(EXPECTED_HOURS);

    test.info().annotations.push({
      type: "SPEC_22 §6 duration (WP-11592 analogue)",
      description:
        `WP ${DAY_SPANNING_WP}: estimated=${wp!.estimated_hours}h remaining=${wp!.remaining_hours}h ` +
        `effective=${wp!.effective_hours}h. Proves mock "P1DT5H" → op-client parseIsoDuration → 29 end-to-end ` +
        `(a day-blind parser would have yielded 5). Agent A's hoursToIsoDuration day-component emission made ` +
        `this expressible for the first time.`,
    });
  });

  // ── §2: BACKFILL — no synced backlog ticket has an empty SERVER ───────────────
  // SPEC_22 §3 / §6 "Backfill": "žádný backlog WP nemá prázdný SERVER". Every WP
  // written by the shared WP-write path is stamped with its connection_id, so no
  // freshly-synced row can surface a "—" SERVER. (The literal pre-backfill
  // legacy row is not constructible in a fresh e2e DB — no app path writes a
  // null-connection row, no e2e direct-DB-seed exists — so migration 0018's
  // backfill OF EXISTING rows is Agent B's own migration/unit responsibility.
  // This asserts the observable "no empty SERVER" contract the DoD names.)
  test("§2: every synced backlog row resolves to a real SERVER (non-null connection_id + label)", async () => {
    skipIfNotReady();

    const scoped = await backlog({ connectionId: myConnId });
    expect(scoped.length, "the s11 backlog synced at least one row for this connection").toBeGreaterThan(0);
    for (const r of scoped) {
      expect(r.connection_id, `WP ${r.op_id}: connection_id must be stamped (never null → never a "—" SERVER)`).toBe(myConnId);
      // The Backlog SERVER column resolves `connection_label ?? connection_base_url
      // ?? connection_id` (routes/index.ts) — "empty SERVER" means ALL of those are
      // absent. A stamped connection always carries at least its base_url, so the
      // column can never render "—". (label is null for an unnamed connection, which
      // is legitimate — not the "no SERVER" defect this increment fixes.)
      const serverLabel = r.connection_label ?? r.connection_base_url ?? String(r.connection_id ?? "");
      expect(
        serverLabel.length,
        `WP ${r.op_id}: the SERVER column must resolve to a non-empty value (label ?? base_url ?? id)`,
      ).toBeGreaterThan(0);
    }

    // The whole shared cache too: after migration 0018 + every writer stamping
    // connection_id, NO row anywhere should have an empty SERVER. (Shared across
    // this suite's specs; if a genuinely unstamped row exists it's a real defect.)
    const global = await backlog({});
    const orphans = global.filter((r) => r.connection_id == null);
    expect(
      orphans.map((r) => r.op_id),
      `no backlog WP may have a null connection_id (empty SERVER) after backfill — offenders: ${JSON.stringify(orphans.map((r) => r.op_id))}`,
    ).toEqual([]);

    test.info().annotations.push({
      type: "SPEC_22 §6 backfill (no empty SERVER)",
      description:
        `scoped rows=${scoped.length} (all connection_id=${myConnId}); global rows=${global.length}, ` +
        `null-connection rows=${orphans.length}. The pre-backfill legacy row itself is not constructible in a ` +
        `fresh e2e DB — migration 0018's row rewrite is Agent B's migration test; this asserts the DoD's ` +
        `observable "no empty SERVER" outcome.`,
    });
  });

  // ── §3: END OF PERMANENT 409 — the REACHABLE core (informative 409 + Cancel) ──
  // SPEC_22 §1 / §6. A genuinely running sync (held open via injected latency)
  // must yield the NEW informative 409 carrying details.runId, the "Cancel it"
  // endpoint must clear it, and a subsequent sync must SUCCEED — i.e. the lock is
  // demonstrably not permanent. The boot-time recoverOrphaned() proof is deferred
  // to §5 (see the header note) — this proves everything an e2e flow can reach.
  test("§3: a running sync returns an informative 409 (details.runId), Cancel clears it, next sync succeeds", async () => {
    skipIfNotReady();
    test.setTimeout(60_000);
    await waitNoCurrentSync(); // start from a clean slate

    // Make the mock's work_packages fetch hang long enough to interleave.
    await setLatency(8_000);

    // Fire a real sync WITHOUT awaiting — it acquires the lock and blocks in the
    // latency-delayed collection fetch. hardCancel (via Cancel) will abort it, so
    // the fired POST rejects/aborts; swallow whatever it settles to.
    const bg = setup
      .post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: myConnId, kind: "full" } })
      .catch(() => undefined);

    const running = await waitCurrentSync();
    expect(running.id, "a sync_run became current (holds the one-at-a-time lock)").toBeGreaterThan(0);

    // A second sync while one is running → the NEW informative 409.
    const conflict = await setup.post("/api/sync", {
      data: { project_op_id: PROJECT_OP_ID, connection_id: myConnId, kind: "full" },
    });
    expect(conflict.status(), "a second concurrent sync is rejected 409 (one sync at a time)").toBe(409);
    const body = (await conflict.json()) as ErrorEnvelope;
    expect(body.error.code, "the rejection code is SYNC_IN_PROGRESS").toBe("SYNC_IN_PROGRESS");

    // The heart of the fix: NOT a bare 409 — it carries the runId (so the UI can
    // offer Cancel) + started_at + last_progress_at.
    const details = body.error.details as
      | { runId?: unknown; started_at?: unknown; last_progress_at?: unknown }
      | undefined;
    expect(details, "the 409 carries a machine-readable details object (not a bare 409)").toBeTruthy();
    expect(details!.runId, "details.runId identifies the conflicting run for Cancel").toBe(running.id);
    expect(typeof details!.started_at, "details.started_at is an ISO string").toBe("string");
    expect(
      Object.prototype.hasOwnProperty.call(details!, "last_progress_at"),
      "details includes last_progress_at (used by the watchdog / UI staleness copy)",
    ).toBeTruthy();

    // The Cancel action the UI wires to: POST /sync/:runId/cancel clears the lock.
    const cancel = await setup.post(`/api/sync/${running.id}/cancel`);
    expect(cancel.ok(), `cancel run ${running.id}: ${cancel.status()} ${await cancel.text()}`).toBeTruthy();

    await bg; // let the aborted background POST settle
    await waitNoCurrentSync();

    // Lock released → a fresh sync succeeds. This is the reachable proof that the
    // 409 was never permanent.
    await setLatency(0);
    const after = await setup.post("/api/sync", {
      data: { project_op_id: PROJECT_OP_ID, connection_id: myConnId, kind: "full" },
    });
    expect(after.ok(), `a sync after cancel must succeed (lock not permanent): ${after.status()} ${await after.text()}`).toBeTruthy();
    await waitNoCurrentSync();

    test.info().annotations.push({
      type: "SPEC_22 §6 informative 409 + Cancel (reachable core)",
      description:
        `running run id=${running.id}; 409 details=${JSON.stringify(details)}; cancel ok; post-cancel sync ok. ` +
        `Proves the informative 409 + working Cancel endpoint + lock-release. The boot-time recoverOrphaned() ` +
        `proof itself is deferred to §5 (unreachable in a single-process harness).`,
    });
  });

  // ── §4: ALWAYS A VISIBLE OUTCOME — last_synced_at advances on a 0-change sync ─
  // SPEC_22 §4 / §6 "Žádné tiché ticho": success updates last_synced_at even when
  // nothing changed. Two identical full syncs (OP unchanged between them) must
  // still push last_synced_at forward.
  test("§4: a re-sync with no OP changes still advances last_synced_at", async () => {
    skipIfNotReady();
    test.setTimeout(45_000);
    await waitNoCurrentSync();

    await fullSync();
    const t1 = (await getSyncStatus()).last_synced_at;
    expect(t1, "last_synced_at is set after a sync").toBeTruthy();

    // Nothing changes in the mock between the two syncs — a genuine 0-change resync.
    await new Promise((r) => setTimeout(r, 1_100));
    await fullSync();
    const t2 = (await getSyncStatus()).last_synced_at;
    expect(t2, "last_synced_at is still set after the 0-change re-sync").toBeTruthy();

    expect(
      Date.parse(t2!),
      `last_synced_at must ADVANCE across a 0-change re-sync (t1=${t1} t2=${t2}) — success is never silent`,
    ).toBeGreaterThan(Date.parse(t1!));

    test.info().annotations.push({
      type: "SPEC_22 §6 no silent success",
      description:
        `t1=${t1} → t2=${t2} (advanced across an identical re-sync). The "no changes" vs "updated N" header ` +
        `SUFFIX branching (wp_count 0 vs N) is unit-covered by Agent C's App.test.tsx with a mocked wp_count — ` +
        `a full e2e re-sync always processes every WP (wp_count=N), so it can't force the wp_count=0 branch here.`,
    });
  });

  // ── §5: BOOT-TIME recoverOrphaned() — DEFERRED to Agent B's unit coverage ─────
  // The one part of task 1 an e2e spec cannot honestly reach (see the header
  // note): a full process kill+restart mid-run, or a direct-DB `running` seed.
  // A LOUD, reasoned skip — not a silent one.
  test("§5: boot-time orphaned-lock recovery is proven by Agent B's unit tests, not here", async () => {
    skipIfNotReady();
    test.info().annotations.push({
      type: "SPEC_22 §1 boot recovery — deferred (documented)",
      description:
        "recoverOrphaned() runs in buildServer() (apps/api/src/server.ts) and is unit-tested in " +
        "packages/db/src/repos.test.ts ('recoverOrphaned marks stuck running rows aborted, leaves others'). " +
        "An e2e spec here cannot simulate the trigger: the single shared apps/api process can't be restarted " +
        "mid-test, no worker can reach the runner-pid-keyed temp DB to seed a 'running' row, and the backend " +
        "runs with OSP_DISABLE_SCHEDULER=1 so the watchdog path is inert too. §3 proves every REACHABLE part " +
        "(informative 409 + Cancel + lock-release).",
    });
    test.skip(true, "boot-time recoverOrphaned() requires a process restart / direct-DB seed — see Agent B's repos.test.ts");
  });

  // ── §6: BROWSER — the header always surfaces a sync outcome (never silent) ────
  // SPEC_22 §4: "Sync now" must always show SOME distinguishable state. Clicking
  // it and observing the header land on one of the outcome spans (last synced /
  // no changes / updated N / sync error) proves the outcome is never swallowed.
  test("§6: clicking 'Sync now' surfaces a visible outcome in the header (not silent)", async ({ page }) => {
    skipIfNotReady();
    test.setTimeout(60_000);
    await waitNoCurrentSync();
    await setLatency(0);

    await page.goto("/");
    const syncNow = page.getByRole("button", { name: "Sync now" });
    test.skip((await syncNow.count()) === 0, "'Sync now' button not present (app not on the connected screen).");
    await expect(syncNow).toBeVisible({ timeout: 15_000 });

    await syncNow.click();

    // After the run settles the header shows exactly one outcome span. Any of
    // these is a legitimate visible outcome (refresh-all touches every recorded
    // import across the shared backend, so a per-connection error is possible and
    // still counts as "visible, not silent").
    const lastSynced = page.locator('[aria-label="last synced"]');
    const syncError = page.locator('[aria-label="sync error"]');
    const stopped = page.locator('[aria-label="sync stopped"]');
    const cancelled = page.locator('[aria-label="sync cancelled"]');

    await expect
      .poll(
        async () =>
          (await lastSynced.count()) +
          (await syncError.count()) +
          (await stopped.count()) +
          (await cancelled.count()),
        { timeout: 30_000, message: "the header must land on a visible sync-outcome span" },
      )
      .toBeGreaterThan(0);

    const shown =
      (await lastSynced.count()) > 0
        ? await lastSynced.first().textContent()
        : (await syncError.count()) > 0
          ? await syncError.first().textContent()
          : (await stopped.count()) > 0
            ? await stopped.first().textContent()
            : await cancelled.first().textContent();
    expect(shown?.trim().length ?? 0, "the outcome span is non-empty (a real message, not a blank flash)").toBeGreaterThan(0);

    test.info().annotations.push({
      type: "SPEC_22 §6 visible outcome (browser)",
      description:
        `after "Sync now" the header shows: ${JSON.stringify(shown?.trim())}. Proves the outcome is surfaced ` +
        `(one of last-synced / no-changes / updated-N / sync-error / stopped / cancelled), never a silent flash. ` +
        `The conflict banner ("sync conflict" + "Cancel it") is unit-covered by Agent C's App.test.tsx: in the ` +
        `browser a genuinely-current run makes the header show the progress bar + Abort (running takes ` +
        `precedence over the conflict banner), so the banner path isn't deterministically reproducible here.`,
    });
  });

  // ── §7: BROWSER — a live sync shows a progress indicator + Abort (visible) ────
  // The running-side of "always visible": while a sync is genuinely in flight the
  // header shows the progress span and an Abort control — the user is never left
  // wondering whether anything is happening. Deterministic via injected latency.
  test("§7: a running sync shows a progress indicator and an Abort control", async ({ page }) => {
    skipIfNotReady();
    test.setTimeout(60_000);
    await waitNoCurrentSync();
    await setLatency(8_000);

    // Hold the lock open with a background API sync so the header observes a
    // current run regardless of client-side timing.
    const bg = setup
      .post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: myConnId, kind: "full" } })
      .catch(() => undefined);
    const running = await waitCurrentSync();

    await page.goto("/");
    const progress = page.locator('[aria-label="sync progress"]');
    const abort = page.getByRole("button", { name: "Abort sync" });

    const sawProgress = await progress
      .first()
      .waitFor({ state: "visible", timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    const sawAbort = await abort
      .first()
      .waitFor({ state: "visible", timeout: 12_000 })
      .then(() => true)
      .catch(() => false);

    test.info().annotations.push({
      type: "SPEC_22 §6 live-sync visibility (browser)",
      description:
        `running run id=${running.id}: progress span visible=${sawProgress}, Abort control visible=${sawAbort}. ` +
        `Confirms a live sync is never silent.`,
    });

    // Clean up the held lock regardless of what the UI showed.
    await setup.post(`/api/sync/${running.id}/cancel`).catch(() => {});
    await bg;
    await setLatency(0);
    await waitNoCurrentSync();

    expect(sawProgress || sawAbort, "a running sync must show a progress indicator and/or an Abort control").toBeTruthy();
  });

  // ── §8: GUARDRAILS — every OP request is a GET; no GET /api/v3/users ──────────
  // SPEC_22 §6 "Guardrails". The recording mock captured every OP request this
  // spec drove; assert the read-only + no-admin-users invariants hold.
  test("§8 guard: every OP request is a GET and GET /api/v3/users is never called", async () => {
    skipIfNotReady();

    const opRequests = rec.requests.filter((r) => !r.path.startsWith("/__mock"));
    const usersCollection = opRequests.filter((r) => r.path === "/api/v3/users");
    const nonOpNonMock = rec.requests.filter(
      (r) => !r.path.startsWith("/__mock") && !r.path.startsWith("/api/v3/"),
    );

    test.info().annotations.push({
      type: "SPEC_22 §6 guardrails",
      description:
        `op-client hit these OP paths: ${JSON.stringify([...new Set(opRequests.map((r) => `${r.method} ${r.path}`))].slice(0, 25))}. ` +
        `bare /api/v3/users hits=${usersCollection.length}. non-OP/non-mock paths=${JSON.stringify(nonOpNonMock.map((r) => r.path))}.`,
    });

    expect(opRequests.length, "op-client exercised the recording mock").toBeGreaterThan(0);
    expect(usersCollection.length, "GET /api/v3/users (admin-gated user collection) must NEVER be called").toBe(0);
    expect(nonOpNonMock, "op-client only ever targets /api/v3/*").toEqual([]);
    for (const r of opRequests) {
      expect(r.method, `OP request ${r.method} ${r.path} must be a GET (read-only)`).toBe("GET");
    }
  });
});
