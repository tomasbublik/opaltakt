import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from "@playwright/test";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_DATABASE_URL, E2E_DB_NAME, E2E_URLS } from "../../playwright.config";
import { FORBIDDEN_DATABASES, assertThrowawayDatabase } from "../../src/db-isolation";
import {
  ensureConnection,
  ensureVaultReady,
  openWindowEnd,
  uniqueSprintName,
} from "../fixtures/helpers";

/**
 * TU — Increment 29 (SPEC_29 "Sync nepokrývá celý backlog + ztráta změn během
 * běhu", frozen as `docs/INCREMENT_29_CONTRACTS.md`), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → ts → tt → "tu-…" lexicographic sequence, so
 * Playwright (which runs spec files in filename order against ONE shared
 * backend) runs it after every earlier spec and before `tz-db-isolation`.
 * Do NOT rename.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES, AND WHY IT IS SHAPED THIS WAY
 * ═════════════════════════════════════════════════════════════════════════════
 * The run prompt merged three specs; contracts §0 measured that two of them are
 * already SHIPPED. So this file has two halves and says which is which on every
 * test:
 *
 *   BUILD surface (SPEC_29, this increment) — §B1…§B5.
 *   REGRESSION surface (SPEC_23 + SPEC_28, already shipped) — §A1…§A3, §C1…§C3.
 *
 * ── The bug, precisely (contracts §0a) ──────────────────────────────────────
 * An import selection is a (project, version) PAIR and a version-scoped sync
 * sends `version = X` to OpenProject. The pre-Increment-29 orphans pass only
 * asked "is this row's PROJECT in the selection?". A cached row whose project
 * IS selected but whose version is NOT therefore fell into NEITHER set: the
 * paginated sync filtered it out, the orphans pass thought its project was
 * covered. It was never fetched again — by any run, forever. That is #11948
 * (Northwind / "Backlog TOP"): estimate PT8H in OP, empty in the cache, `cached_at`
 * frozen a week back, and every run still reporting `status: success`.
 *
 * The fixture (`s19-sync-coverage`) reproduces it the way it really happens: a
 * ticket imported while it was in the SELECTED version, then MOVED to another
 * version in OP. From that moment a version-scoped sync stops returning it.
 * The old orphans pass provably cannot see it, so §B1/§B2 are red on the old
 * code by construction — not by a mocked-out shortcut.
 *
 * ── The contract's own design rule, which the assertions follow ─────────────
 * Contracts §0a: the rule must NOT be "enumerate the known ways a row can
 * escape the selection" — that reasoning is what produced the half-fix. It is
 * EMPIRICAL: after a run, any cached row for that connection whose `cached_at`
 * is older than the run's start was, by definition, not refreshed. So §B1's
 * headline assertion is exactly that — a `cached_at` sweep over the whole
 * connection, done IN THE DATABASE, not a whitelist of ids.
 *
 * ── ISOLATION (the Increment-11 guardrail) ──────────────────────────────────
 * No new `apps/api` boot: this reuses `tests/playwright.config.ts`'s webServer,
 * which already pins a GENERATED throwaway Postgres database (`osp_e2e_<pid>`,
 * `assertThrowawayDatabase`-checked at module load, at CREATE and again before
 * the DROP) and non-default ports. Every direct SQL read below re-checks the
 * URL before it runs. Two DEDICATED recording mocks on ephemeral ports give
 * this spec its own connections + its own request recorders; nothing here
 * issues a non-GET toward OpenProject.
 *
 * ── WHY DIRECT SQL AT ALL ───────────────────────────────────────────────────
 * `cached_at`, `sync_watermark` and "the row still exists after an orphan
 * report" are not exposed by any HTTP surface, and contracts §4.1 explicitly
 * requires coverage to be COUNTED IN THE DATABASE rather than accumulated in a
 * JS variable. An assertion that only reads the API's own summary could not
 * tell a correct count from a self-consistent lie — which is exactly the
 * reporting that let this bug hide behind a green status for weeks.
 */

// ── fixture constants (see fixtures/scenarios/s19-sync-coverage.ts) ──────────
const SCENARIO = "s19-sync-coverage";
const SCENARIO_ORPHANED = "s20-sync-coverage-orphaned";
const EFT_SCENARIO = "s17-assignee-collision-acme"; // §A2's other server

const PROJECT_CORE = 8500;
const PROJECT_ARCHIVE = 8501; // never imported — only reachable by id
const EFT_PROJECT = 8400;
const VERSION_SELECTED = 8510; // the import selection is scoped to THIS
const VERSION_UNSELECTED = 8511; // …and this one is the coverage hole

const WP_CAP_A = 85001; // 5h → 20h on day 3 (capacity / atomic-swap leg)
const WP_CAP_B = 85002; // 3h, stable
const WP_DRIFT_ESTIMATE = 85010; // ⚠️ the #11948 analogue: no estimate → 8h
const WP_DRIFT_PLAIN = 85011; // deletable out-of-selection row
const WP_DRIFT_IN_SPRINT = 85012; // out-of-selection but PROTECTED (in a sprint)
const WP_BULK_A = 85013; // drifted, never in a sprint — the BROWSER bulk delete
const WP_BULK_B = 85014; // …its partner, so "many on one confirmation" is real
const WP_RACE = 85030; // 6h → 12h, changed DURING a run
const WP_ORPHAN = 85040; // present in s19, absent from s20
const WP_BY_ID = 85020; // project 8501, Increment-25 add-by-id path

const NEVER_CACHED_OP_ID = 8599999; // for the "not_cached" delete bucket

const DEV = "Dev Dvořák";
const CUSTOMER = "Karel Zákazník"; // OP user id 3 on OUR server…
const EFT_CAMERON = "Cameron Dalby"; // …and OP user id 3 on the other
const COLLIDING_OP_USER_ID = 3;

/** Contracts §2 — op ids per `syncByOpIds` OP request. */
const ID_FETCH_BATCH_SIZE = 100;
/** Contracts §3 — the incremental overlap window, in minutes. */
const SYNC_OVERLAP_WINDOW_MINUTES = 15;

// ── §0 legacy tripwire: the pre-Postgres DB file that is still off-limits ────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", ".."); // tests/e2e/specs → root
const REAL_SQLITE = path.join(REPO_ROOT, "apps", "api", "osp.sqlite");
interface DbFingerprint {
  size: number;
  mtimeMs: number;
}
function fingerprintRealDb(): DbFingerprint | null {
  try {
    const st = fs.statSync(REAL_SQLITE);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
function assertRealDbUnchanged(before: DbFingerprint | null): void {
  const after = fingerprintRealDb();
  if (before === null || after === null) return;
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(
      `[§0 TRIPWIRE FAILED] ${REAL_SQLITE} changed during the e2e run — ` +
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}. ` +
        "It is the retained pre-migration rollback copy and is read-only, forever.",
    );
  }
}

// ── minimal contract subsets (packages/contracts is FROZEN; never edited) ────
interface SyncRunLite {
  id: number;
  status: "running" | "success" | "error" | "aborted";
  started_at: string;
  finished_at: string | null;
  wp_count: number | null;
  error: string | null;
}
interface SyncCoverage {
  total_cached: number;
  refreshed: number;
  not_refreshed: number;
  orphan_op_ids: number[];
  oldest_cached_at: string | null;
}
interface ConnectionSyncOutcome {
  connection_id: number;
  connection_label: string | null;
  status: "synced" | "skipped" | "error";
  run: SyncRunLite | null;
  message: string;
  coverage: SyncCoverage | null;
}
interface SyncRefreshAllResponse {
  connections: ConnectionSyncOutcome[];
  last: SyncRunLite | null;
  full_refresh: boolean;
}
interface SyncStatus {
  current: SyncRunLite | null;
  last: SyncRunLite | null;
  last_synced_at: string | null;
}
interface BacklogItem {
  op_id: number;
  subject: string;
  connection_id: number | null;
  assignee_op_id: number | null;
  assignee_name: string | null;
  project_op_id: number;
  version_op_id: number | null;
  estimated_hours: number | null;
  remaining_hours: number | null;
  effective_hours: number | null;
}
interface FilterOptionEntry {
  id: number;
  name: string;
  key: string;
  connection_id: number | null;
}
interface FilterOptions {
  assignees: FilterOptionEntry[];
}
interface OutOfSelectionEntry {
  op_id: number;
  subject: string;
  project_op_id: number;
  project_name: string | null;
  version_op_id: number | null;
  version_name: string | null;
  connection_id: number | null;
  connection_label: string | null;
  cached_at: string;
  updated_at_op: string;
  // `in_sprint` stays "member of ANY sprint" (informational — Increment 31,
  // docs/INCREMENT_31_CONTRACTS.md §3). `protected` is now the actual
  // deletability rule (member of a NON-frozen sprint); `frozen_sprint_names`
  // lists FROZEN memberships separately. None of THIS file's fixture sprints
  // are ever frozen, so `protected` and the old "in_sprint-implies-protected"
  // reading coincide here — see the B5a/B5b notes below on why only the field
  // read, not the expected VALUES, changed.
  in_sprint: boolean;
  sprint_names: string[];
  frozen_sprint_names: string[];
  protected: boolean;
}
interface OutOfSelectionResponse {
  entries: OutOfSelectionEntry[];
  total: number;
  protected_count: number;
}
interface DeleteOutOfSelectionResponse {
  removed: number[];
  protected: Array<{ op_id: number; sprint_names: string[] }>;
  rejected: Array<{ op_id: number; reason: "in_selection" | "not_cached" }>;
}
interface CapacityLineLike {
  name: string;
  planned_hours: number;
  available_hours: number;
}
interface CapacityLike {
  lines: CapacityLineLike[];
  total_planned_hours: number;
}
interface SprintItemLike {
  op_id: number;
  effective_hours: number | null;
  outcome: string;
}
interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}

// ── direct SQL against THE THROWAWAY DATABASE ONLY ───────────────────────────
const exec = promisify(execFile);
async function sql(query: string): Promise<string[]> {
  // Belt and braces on every single call, admin URL included nowhere: this may
  // only ever open a session on the generated `osp_e2e_<pid>` database.
  assertThrowawayDatabase(E2E_DATABASE_URL);
  const { stdout } = await exec(
    "psql",
    [E2E_DATABASE_URL, "-X", "-q", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", query],
    { env: { ...process.env, PGCONNECT_TIMEOUT: "5" } },
  );
  const out = stdout.trim();
  return out === "" ? [] : out.split("\n");
}
async function sqlOne(query: string): Promise<string | null> {
  const rows = await sql(query);
  return rows[0] ?? null;
}
/** One `work_package_cache` row, read straight out of the throwaway database.
 * Empty string means SQL NULL (psql's -A -t rendering, coalesced above). */
interface CacheRow {
  op_id: string;
  connection_id: string;
  project_op_id: string;
  version_op_id: string;
  estimated_hours: string;
  remaining_hours: string;
  cached_at: string;
  updated_at_op: string;
}

/** Postgres literal for an ISO instant. */
function ts(iso: string): string {
  return `timestamptz '${iso.replace(/'/g, "''")}'`;
}

/**
 * How many times this run has built the fixture.
 *
 * Playwright discards the worker process after a failed test and starts a new
 * one, which re-runs `beforeAll` — new mock servers, new connections, the
 * scenario back at day 0. A module-level counter cannot see that (the module is
 * reloaded too), so the count goes through a file keyed on the run's database
 * name, the same trick `global-db.ts` uses for its activity snapshot. It exists
 * so a rebuild is REPORTED rather than silently changing what later assertions
 * are measuring.
 */
const FIXTURE_BUILD_MARKER = path.join(
  os.tmpdir(),
  `osp-e2e-tu-fixture-${E2E_DB_NAME}.count`,
);
let fixtureBuilds = 0;
function recordFixtureBuild(): void {
  let previous = 0;
  try {
    // `osp_e2e_<pid>` can repeat once the OS recycles pids, so a marker left by
    // an older run would otherwise report a rebuild that never happened. An
    // hour is far longer than the whole suite and far shorter than pid reuse.
    const stat = fs.statSync(FIXTURE_BUILD_MARKER);
    if (Date.now() - stat.mtimeMs < 60 * 60 * 1000) {
      previous = Number(fs.readFileSync(FIXTURE_BUILD_MARKER, "utf8")) || 0;
    }
  } catch {
    previous = 0;
  }
  fixtureBuilds = previous + 1;
  try {
    fs.writeFileSync(FIXTURE_BUILD_MARKER, String(fixtureBuilds), "utf8");
  } catch {
    /* best effort — the marker is diagnostic, never load-bearing */
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NOTE: a PLAIN describe, not `.serial`, for the reason tr-retroactive-ticket-add
// documents: the legs are ordered and stateful (Playwright runs a file's tests
// sequentially on one worker), but a genuine RED on one Definition-of-Done item
// must not abort every other item — an honest PASS/FAIL matrix is the whole
// deliverable here, and `.serial` would replace the rest of it with "skipped".
test.describe("TU — SPEC_29 sync coverage, race, reporting and cleanup", () => {
  let setup: APIRequestContext;
  let mine: RecordingMockOpServer; // our server: s19
  let eft: RecordingMockOpServer; // the other server: s17 (§A2 collision)
  let myConnId = 0;
  let eftConnId = 0;
  let sprintCapId = 0; // §C1/§C2 capacity subject
  let sprintProtId = 0; // §B5 protection subject
  let dbBefore: DbFingerprint | null = null;
  let ready = false;
  let setupError = "";
  /** #85010 as the cache held it the INSTANT the drift happened — the
   * premise §B1's assertions are about. Captured here because a later sync
   * legitimately refreshes the live row. */
  let preDriftRow: CacheRow | null = null;

  // ── low-level helpers ──────────────────────────────────────────────────────
  function qs(params: Record<string, string | number | undefined>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
    const s = sp.toString();
    return s === "" ? "" : `?${s}`;
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
  async function waitCurrentSync(timeoutMs = 20_000): Promise<SyncRunLite> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cur = (await getStatus()).current;
      if (cur !== null) return cur;
      if (Date.now() > deadline) throw new Error("no sync became current within the deadline");
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  async function setLatency(rec: RecordingMockOpServer, ms: number): Promise<void> {
    await setup.post(`${rec.url}/__mock/set-latency-ms`, { data: { ms } }).catch(() => undefined);
  }
  async function gotoDay(rec: RecordingMockOpServer, day: number): Promise<void> {
    const res = await setup.post(`${rec.url}/__mock/goto-day/${day}`);
    expect(res.ok(), `goto-day ${day}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  async function loadInto(rec: RecordingMockOpServer, name: string): Promise<boolean> {
    const res = await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(name)}`);
    return res.ok();
  }
  /** A project[+version]-scoped import/sync — this is what RECORDS the import
   * selection the whole increment turns on. */
  async function importSelection(
    projectOpId: number,
    versionOpId: number | null,
    connId: number,
  ): Promise<void> {
    const res = await setup.post("/api/sync", {
      data: {
        project_op_id: projectOpId,
        ...(versionOpId !== null ? { version_op_id: versionOpId } : {}),
        connection_id: connId,
        kind: "full",
      },
    });
    expect(
      res.ok(),
      `import project ${projectOpId} version ${versionOpId ?? "*"}: ${res.status()} ${await res.text()}`,
    ).toBeTruthy();
    await waitNoCurrentSync();
  }
  /** "Sync now" — the refresh-all path (no project_op_id). Returns the response
   * plus the client-side instant captured immediately BEFORE the request, which
   * is a safe lower bound for every connection group's `groupStartedAt`. */
  async function syncNow(
    opts: { fullRefresh?: boolean } = {},
  ): Promise<{ before: string; body: SyncRefreshAllResponse; status: number; raw: string }> {
    await waitNoCurrentSync();
    const before = new Date().toISOString();
    const res = await setup.post("/api/sync", {
      data: opts.fullRefresh === true ? { full_refresh: true } : {},
    });
    const raw = await res.text();
    let body: SyncRefreshAllResponse;
    try {
      body = JSON.parse(raw) as SyncRefreshAllResponse;
    } catch {
      body = { connections: [], last: null, full_refresh: false };
    }
    await waitNoCurrentSync();
    return { before, body, status: res.status(), raw };
  }
  function myOutcome(body: SyncRefreshAllResponse): ConnectionSyncOutcome | undefined {
    return body.connections.find((c) => c.connection_id === myConnId);
  }
  async function backlog(
    params: Record<string, string | number | undefined> = {},
  ): Promise<BacklogItem[]> {
    const res = await setup.get(`/api/backlog${qs({ pageSize: 500, ...params })}`);
    expect(res.ok(), `backlog: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as BacklogItem[];
  }
  async function outOfSelection(): Promise<{ status: number; body: OutOfSelectionResponse | null; raw: string }> {
    const res = await setup.get("/api/backlog/out-of-selection");
    const raw = await res.text();
    let body: OutOfSelectionResponse | null = null;
    try {
      body = JSON.parse(raw) as OutOfSelectionResponse;
    } catch {
      /* non-JSON (e.g. a 404 HTML body) */
    }
    return { status: res.status(), body, raw };
  }
  async function getCapacity(sprintId: number): Promise<CapacityLike> {
    const res = await setup.get(`/api/sprints/${sprintId}/capacity`);
    expect(res.ok(), `capacity ${sprintId}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as CapacityLike;
  }
  async function getItems(sprintId: number): Promise<SprintItemLike[]> {
    const res = await setup.get(`/api/sprints/${sprintId}/items/detailed`);
    expect(res.ok(), `items/detailed ${sprintId}: ${res.status()}`).toBeTruthy();
    return (await res.json()) as SprintItemLike[];
  }
  function lineFor(cap: CapacityLike, name: string): CapacityLineLike | undefined {
    return cap.lines.find((l) => l.name === name);
  }
  /** Rows of OUR connection whose cached_at predates `iso` — the empirical
   * "was not refreshed" set of contracts §0a, computed in the DATABASE. */
  async function staleOpIds(iso: string): Promise<number[]> {
    const rows = await sql(
      `SELECT op_id FROM work_package_cache
        WHERE connection_id = ${myConnId} AND cached_at < ${ts(iso)}
        ORDER BY op_id`,
    );
    return rows.map((r) => Number(r));
  }
  async function cacheRow(opId: number): Promise<CacheRow | null> {
    const row = await sqlOne(
      `SELECT op_id, connection_id, project_op_id,
              coalesce(version_op_id::text,'') , coalesce(estimated_hours::text,''),
              coalesce(remaining_hours::text,''),
              to_char(cached_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              to_char(updated_at_op AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         FROM work_package_cache WHERE op_id = ${opId}`,
    );
    if (row === null) return null;
    const [op_id, connection_id, project_op_id, version_op_id, estimated_hours, remaining_hours, cached_at, updated_at_op] =
      row.split("|");
    return {
      op_id: op_id ?? "",
      connection_id: connection_id ?? "",
      project_op_id: project_op_id ?? "",
      version_op_id: version_op_id ?? "",
      estimated_hours: estimated_hours ?? "",
      remaining_hours: remaining_hours ?? "",
      cached_at: cached_at ?? "",
      updated_at_op: updated_at_op ?? "",
    };
  }
  /** `sync_watermark.watermark_at` for (our connection, project), or null. */
  async function watermark(projectOpId: number): Promise<string | null> {
    return sqlOne(
      `SELECT to_char(watermark_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         FROM sync_watermark
        WHERE connection_id = ${myConnId} AND project_op_id = ${projectOpId}`,
    );
  }
  async function watermarkTableExists(): Promise<boolean> {
    const n = await sqlOne(
      `SELECT count(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_name='sync_watermark'`,
    );
    return Number(n ?? "0") > 0;
  }
  /** Every id value the op-client asked OUR mock for via an `id` filter. */
  function idFilterBatches(rec: RecordingMockOpServer): string[][] {
    const out: string[][] = [];
    for (const r of rec.requests) {
      if (r.path !== "/api/v3/work_packages") continue;
      const filters = new URLSearchParams(r.search).get("filters");
      if (filters === null) continue;
      try {
        const clauses = JSON.parse(filters) as Array<Record<string, { values?: unknown }>>;
        for (const clause of clauses) {
          const spec = clause["id"];
          if (spec && Array.isArray(spec.values)) out.push(spec.values.map(String));
        }
      } catch {
        /* lenient, like the mock's own parser */
      }
    }
    return out;
  }

  // ── setup ──────────────────────────────────────────────────────────────────
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    try {
      await ensureVaultReady(setup);

      mine = await createRecordingMockOpServer();
      eft = await createRecordingMockOpServer();
      if (!(await loadInto(mine, SCENARIO))) {
        setupError = `scenario "${SCENARIO}" not loadable`;
        return;
      }
      if (!(await loadInto(eft, EFT_SCENARIO))) {
        setupError = `scenario "${EFT_SCENARIO}" not loadable`;
        return;
      }

      // Deterministic refresh-all breakdown: every connection an earlier spec
      // left behind is disabled, so the only groups this spec's "Sync now"
      // touches are ours. (They are reported `skipped`, which §A1 also uses.)
      const existing = (await (await setup.get("/api/connections")).json()) as { id: number }[];
      for (const c of existing) {
        await setup.patch(`/api/connections/${c.id}`, { data: { enabled: false } }).catch(() => {});
      }

      myConnId = await ensureConnection(setup, mine.url, "tu-coverage-token");
      eftConnId = await ensureConnection(setup, eft.url, "tu-eft-token");
      await setup.patch(`/api/connections/${eftConnId}`, { data: { enabled: true } });
      await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: true, current: true } });

      // Populate project names (sync alone never writes the projects table).
      await setup.get("/api/projects");

      // ── day 0: the ONLY import selection is (8500, version 8510) ───────────
      // Everything in project 8500 currently sits in version 8510, so all six
      // of its tickets are cached — including the three about to drift out.
      await importSelection(PROJECT_CORE, VERSION_SELECTED, myConnId);
      // The other server, for §A2's cross-connection identity regression.
      await importSelection(EFT_PROJECT, null, eftConnId);

      // Sprint A — the capacity subject (#85001 5h + #85002 3h, both Dev).
      const capRes = await setup.post("/api/sprints", {
        data: {
          name: uniqueSprintName("TU capacity"),
          start_date: new Date().toISOString().slice(0, 10),
          end_date: openWindowEnd(21),
        },
      });
      expect(capRes.ok(), `create capacity sprint: ${capRes.status()} ${await capRes.text()}`).toBeTruthy();
      sprintCapId = ((await capRes.json()) as { id: number }).id;
      for (const wp of [WP_CAP_A, WP_CAP_B]) {
        const add = await setup.post(`/api/sprints/${sprintCapId}/items`, { data: { wp_op_id: wp } });
        expect(add.ok(), `add #${wp} to capacity sprint: ${add.status()} ${await add.text()}`).toBeTruthy();
      }

      // Sprint B — the protection subject. #85012 comes from the backlog (it is
      // still in the selected version at day 0); #85020 can ONLY arrive via the
      // Increment-25 by-id path, because project 8501 is never imported.
      const protRes = await setup.post("/api/sprints", {
        data: {
          name: uniqueSprintName("TU protected"),
          start_date: new Date().toISOString().slice(0, 10),
          end_date: openWindowEnd(21),
        },
      });
      expect(protRes.ok(), `create protection sprint: ${protRes.status()} ${await protRes.text()}`).toBeTruthy();
      sprintProtId = ((await protRes.json()) as { id: number }).id;
      const addDrift = await setup.post(`/api/sprints/${sprintProtId}/items`, {
        data: { wp_op_id: WP_DRIFT_IN_SPRINT },
      });
      expect(
        addDrift.ok(),
        `add #${WP_DRIFT_IN_SPRINT} to protection sprint: ${addDrift.status()} ${await addDrift.text()}`,
      ).toBeTruthy();
      const addById = await setup.post(`/api/sprints/${sprintProtId}/items/by-id`, {
        data: { wp_op_id: WP_BY_ID, connection_id: myConnId },
      });
      expect(
        addById.ok(),
        `add #${WP_BY_ID} BY ID (Increment 25): ${addById.status()} ${await addById.text()}`,
      ).toBeTruthy();

      // ── day 1: THE DRIFT — deliberately part of the FIXTURE, not of a test ──
      // ⚠️ This cost a debugging session: Playwright discards the worker process
      // after a failed test and starts a new one, which re-runs `beforeAll`. A
      // day-advance performed INSIDE a test is therefore lost the moment any
      // earlier test goes red — the rebuilt mock is back at day 0, the drift has
      // not happened, and every later coverage assertion passes VACUOUSLY (§B1,
      // §B4 and §B4b all reported green against a fixture that no longer had a
      // stale row in it). Everything the whole file depends on is built here, so
      // a restart reproduces it byte for byte.
      await gotoDay(mine, 1);
      preDriftRow = await cacheRow(WP_DRIFT_ESTIMATE);
      recordFixtureBuild();

      ready = true;
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    if (mine) await setLatency(mine, 0);
    if (eft) await setLatency(eft, 0);
    if (myConnId) await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: false } }).catch(() => {});
    if (eftConnId) await setup.patch(`/api/connections/${eftConnId}`, { data: { enabled: false } }).catch(() => {});
    await setup?.dispose();
    if (mine) await mine.close().catch(() => {});
    if (eft) await eft.close().catch(() => {});
    assertRealDbUnchanged(dbBefore);
  });

  function requireReady(): void {
    expect(ready, `TU fixture setup failed: ${setupError || "(no detail)"}`).toBe(true);
    if (fixtureBuilds > 1) {
      test.info().annotations.push({
        type: "⚠️ fixture rebuilt",
        description:
          `beforeAll has now run ${fixtureBuilds} times — Playwright restarted the worker after an ` +
          "earlier failure. Fresh mocks + fresh connections were created and the scenario replayed to " +
          "day 1; anything a LATER test mutated (day 2/3, the s20 orphan swap) is gone. Read this " +
          "file's results from the FIRST failure onwards with that in mind.",
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §0 — isolation
  // ═══════════════════════════════════════════════════════════════════════════
  test("§0: this spec's direct SQL only ever targets the generated throwaway database", async () => {
    assertThrowawayDatabase(E2E_DATABASE_URL);
    expect(E2E_DB_NAME).toMatch(/^osp_e2e_\d+$/);
    expect(E2E_DB_NAME).not.toBe("osp");
    expect(FORBIDDEN_DATABASES).not.toContain(E2E_DB_NAME);
    // Prove the connection actually works, so a later "0 rows" can never be a
    // silently-broken query masquerading as a passing assertion.
    const tables = await sqlOne(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
    );
    expect(Number(tables ?? "0"), "the throwaway database holds the app schema").toBeGreaterThan(10);
    test.info().annotations.push({
      type: "guardrail 0",
      description: `direct SQL bound to ${E2E_DB_NAME}; legacy sqlite fingerprint ${JSON.stringify(dbBefore)}.`,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §A — REGRESSION surface (SPEC_23, already shipped — contracts §0)
  // ═══════════════════════════════════════════════════════════════════════════

  // A2 first, then A1: A1 DISABLES the other connection, and the assignee facet
  // leg wants both servers live.
  test("§A2: the Assignee facet does not leak across servers — two people share OP id 3 and stay distinct", async () => {
    requireReady();
    const res = await setup.get("/api/backlog/filter-options");
    expect(res.ok(), `filter-options: ${res.status()} ${await res.text()}`).toBeTruthy();
    const options = (await res.json()) as FilterOptions;

    const mineEntry = options.assignees.find(
      (a) => a.connection_id === myConnId && a.id === COLLIDING_OP_USER_ID,
    );
    const eftEntry = options.assignees.find(
      (a) => a.connection_id === eftConnId && a.id === COLLIDING_OP_USER_ID,
    );
    expect(
      mineEntry,
      `our server's OP user ${COLLIDING_OP_USER_ID} (${CUSTOMER}) must be offered as its own option`,
    ).toBeTruthy();
    expect(
      eftEntry,
      `the other server's OP user ${COLLIDING_OP_USER_ID} (${EFT_CAMERON}) must NOT be deduped away`,
    ).toBeTruthy();
    expect(mineEntry!.name).toBe(CUSTOMER);
    expect(eftEntry!.name).toBe(EFT_CAMERON);
    expect(mineEntry!.key, "the facet key is connection-scoped").not.toBe(eftEntry!.key);

    // …and selecting one never returns the other's tickets.
    const mineRows = await backlog({ assigneeKey: `${myConnId}:${COLLIDING_OP_USER_ID}` });
    const eftRows = await backlog({ assigneeKey: `${eftConnId}:${COLLIDING_OP_USER_ID}` });
    expect(
      mineRows.every((r) => r.connection_id === myConnId),
      `assigneeKey ${myConnId}:3 leaked rows from another server: ${JSON.stringify(
        mineRows.filter((r) => r.connection_id !== myConnId).map((r) => r.op_id),
      )}`,
    ).toBe(true);
    expect(
      eftRows.every((r) => r.connection_id === eftConnId),
      "assigneeKey <eft>:3 leaked rows from our server",
    ).toBe(true);
    expect(mineRows.some((r) => r.op_id === WP_DRIFT_PLAIN)).toBe(true);

    test.info().annotations.push({
      type: "A2 — SPEC_23 §2 (regression, already shipped)",
      description:
        `${CUSTOMER} (${myConnId}:3) and ${EFT_CAMERON} (${eftConnId}:3) are listed as distinct ` +
        `options and scope disjointly. Deeper coverage (Grace Hopper's same-id-AND-same-name case, the ` +
        `legacy bare assignee=3 collision) lives in tp-sync-disconnected-assignee-identity.spec.ts §2a–§2d.`,
    });
  });

  test("§A1: a disconnected connection is skipped, never aborts the batch; CONNECTION_DISABLED stays fatal alone", async () => {
    requireReady();
    test.setTimeout(120_000);
    // Disconnect the OTHER server; ours stays healthy.
    await setup.patch(`/api/connections/${eftConnId}`, { data: { enabled: false } });

    const { body, status, raw } = await syncNow();
    expect(status, `refresh-all with a disconnected connection must be 200, not a batch-wide 409: ${raw}`).toBe(200);

    const eftOutcome = body.connections.find((c) => c.connection_id === eftConnId);
    expect(eftOutcome, "the disconnected connection is REPORTED, not silently dropped").toBeTruthy();
    expect(eftOutcome!.status, `disconnected ⇒ "skipped" (got ${JSON.stringify(eftOutcome)})`).toBe("skipped");
    expect(eftOutcome!.message.length, "a skipped connection always carries a reason").toBeGreaterThan(0);

    const ours = myOutcome(body);
    expect(ours, "our healthy connection must still be in the breakdown").toBeTruthy();
    expect(ours!.status, "a dead neighbour must not stop a healthy connection syncing").toBe("synced");

    // …but a SINGLE-connection operation against the disabled one is still fatal.
    const single = await setup.post("/api/sync", {
      data: { project_op_id: EFT_PROJECT, connection_id: eftConnId, kind: "full" },
    });
    expect(single.ok(), "a single-project sync of a disabled connection must NOT succeed").toBeFalsy();
    const err = (await single.json()) as ErrorEnvelope;
    expect(err.error.code, `single-connection sync error code (got ${JSON.stringify(err)})`).toBe(
      "CONNECTION_DISABLED",
    );

    test.info().annotations.push({
      type: "A1 — SPEC_23 §1 (regression, already shipped)",
      description:
        `outcomes=${JSON.stringify(body.connections.map((c) => [c.connection_id, c.status]))}; ` +
        `single-connection sync of the disabled server → ${err.error.code}.`,
    });
  });

  test("§A3: a hard cancel really stops a stalled run within seconds, and the watermark does NOT move", async () => {
    requireReady();
    test.setTimeout(120_000);
    await waitNoCurrentSync();

    const watermarkBefore = (await watermarkTableExists()) ? await watermark(PROJECT_CORE) : null;

    await setLatency(mine, 45_000); // far longer than any legitimate wait
    const bg = setup
      .post("/api/sync", {
        data: { project_op_id: PROJECT_CORE, version_op_id: VERSION_SELECTED, connection_id: myConnId, kind: "full" },
      })
      .catch(() => undefined);
    const running = await waitCurrentSync();

    const t0 = Date.now();
    const cancel = await setup.post(`/api/sync/${running.id}/cancel`);
    expect(cancel.ok(), `cancel run ${running.id}: ${cancel.status()} ${await cancel.text()}`).toBeTruthy();
    await bg;
    await waitNoCurrentSync(30_000);
    const elapsed = Date.now() - t0;
    await setLatency(mine, 0);

    const last = (await getStatus()).last;
    expect(last?.status, `the cancelled run must finish "aborted" (got ${JSON.stringify(last)})`).toBe("aborted");
    expect(
      elapsed,
      `Cancel must physically abort the in-flight request (45s latency injected) — took ${elapsed}ms`,
    ).toBeLessThan(20_000);

    // Contracts §3: an aborted run leaves `sync_watermark` untouched.
    if (await watermarkTableExists()) {
      const after = await watermark(PROJECT_CORE);
      expect(
        after,
        `an ABORTED run must not move the watermark (before=${watermarkBefore} after=${after})`,
      ).toBe(watermarkBefore);
    } else {
      expect(
        false,
        "sync_watermark table is missing — Agent B's migration 0002 has not landed (contracts §3)",
      ).toBe(true);
    }

    test.info().annotations.push({
      type: "A3 — SPEC_23 §3 + B3 watermark-on-abort",
      description:
        `cancel→aborted in ${elapsed}ms; watermark(project ${PROJECT_CORE}) stayed ${watermarkBefore}. ` +
        "The AUTOMATIC no-progress watchdog is covered by tm-hard-cancel-no-freeze.spec.ts §4 " +
        "(this harness runs with OSP_DISABLE_SCHEDULER=1, so the timer never fires here).",
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §B — BUILD surface (SPEC_29)
  // ═══════════════════════════════════════════════════════════════════════════

  test("§B1 setup: the drift happens in OpenProject, and the OLD pass provably cannot see it", async () => {
    requireReady();
    // The drift itself (day 1: #85010/#85011/#85012 move to version 8511 and
    // #85010 gains 8h) is built in `beforeAll` — see the note there. This leg
    // only VERIFIES the premise; it must never mutate, or a worker restart
    // would leave the rest of the file measuring a different fixture.

    // Sanity on the OP side (this is the mock's own state, not the app's).
    // NOTE: `/__mock/state` reports a version by its scenario KEY, not its
    // display name (engine.ts's state summary) — asserting the name silently
    // fails for the right reason.
    const state = (await (await setup.get(`${mine.url}/__mock/state`)).json()) as {
      day: number;
      work_packages: Array<{ id: number; version: string | null; estimated_hours: number | null }>;
    };
    expect(state.day, "the mock is at day 1 (the drift has been applied)").toBe(1);
    const drifted = state.work_packages.find((w) => w.id === WP_DRIFT_ESTIMATE);
    expect(drifted?.version, "#85010 now lives in the UNSELECTED version, in OP").toBe("v_unselected");
    expect(drifted?.estimated_hours, "#85010's OP estimate is now 8h (the #11948 shape)").toBe(8);

    // The version-scoped listing OP actually answers must no longer contain it
    // — that is the half of the bug the paginated sync is responsible for.
    const filters = encodeURIComponent(
      JSON.stringify([
        { project: { operator: "=", values: [String(PROJECT_CORE)] } },
        { version: { operator: "=", values: [String(VERSION_SELECTED)] } },
      ]),
    );
    const listed = (await (
      await setup.get(`${mine.url}/api/v3/work_packages?filters=${filters}&pageSize=100`)
    ).json()) as { _embedded: { elements: Array<{ id: number }> } };
    expect(
      listed._embedded.elements.map((e) => e.id),
      "the selection's own listing cannot reach the drifted tickets any more",
    ).not.toContain(WP_DRIFT_ESTIMATE);

    // And the CACHE held the pre-drift copy at the moment the drift happened —
    // the state in which every later "successful" sync used to leave it
    // untouched forever. Read from the snapshot `beforeAll` took right after the
    // day-1 advance, NOT from the live table: by the time this leg runs a sync
    // has legitimately refreshed it, and re-reading live would assert the
    // opposite of what it means to.
    expect(preDriftRow, "#85010 was cached by the day-0 import").toBeTruthy();
    expect(
      preDriftRow!.version_op_id,
      "at drift time the cache still said version 8510 — from then on the paginated sync filters it out",
    ).toBe(String(VERSION_SELECTED));
    expect(preDriftRow!.estimated_hours, "…and its estimate was still empty").toBe("");

    test.info().annotations.push({
      type: "B1 premise (contracts §0a)",
      description:
        `#${WP_DRIFT_ESTIMATE}: OP version=8511 estimate=8h, cache version=8510 estimate=∅. Its PROJECT ` +
        "is in the import selection (so the old orphans pass skips it) and its VERSION is not (so the " +
        "paginated sync filters it out) — it falls into neither set.",
    });
  });

  test("§B1: after 'Sync now', NO cached row of that connection is older than the run's start", async () => {
    requireReady();
    test.setTimeout(180_000);

    const idBatchesBeforeRun = idFilterBatches(mine).length;
    const { before, body, status, raw } = await syncNow();
    expect(status, `refresh-all: ${raw}`).toBe(200);

    // The empirical rule (contracts §0a), computed IN THE DATABASE over the
    // WHOLE connection — deliberately not a whitelist of ids.
    const stale = await staleOpIds(before);
    const detail = await Promise.all(stale.map(async (id) => ({ id, row: await cacheRow(id) })));
    expect(
      stale,
      "every work_package_cache row for this connection must have been refreshed by the run " +
        `(rows still older than ${before}: ${JSON.stringify(detail)})`,
    ).toEqual([]);

    // The individual paths the DoD names, spelled out so a failure says WHICH.
    for (const [opId, why] of [
      [WP_DRIFT_ESTIMATE, "project selected, VERSION not — the measured root cause"],
      [WP_DRIFT_PLAIN, "project selected, VERSION not"],
      [WP_DRIFT_IN_SPRINT, "project selected, VERSION not, and in a sprint"],
      [WP_BY_ID, "added by id (Increment 25) — project in NO selection"],
      [WP_CAP_A, "inside the selection (the ordinary path)"],
    ] as const) {
      const row = await cacheRow(opId);
      expect(row, `#${opId} (${why}) must be in the cache`).toBeTruthy();
      expect(
        Date.parse(row!.cached_at),
        `#${opId} (${why}) has a STALE cached_at ${row!.cached_at} < ${before}`,
      ).toBeGreaterThanOrEqual(Date.parse(before));
    }

    // A row with no connection at all would be attributed to the CURRENT
    // connection by the `?? currentConnId` rule and silently join our coverage.
    const nullConn = await sql("SELECT op_id FROM work_package_cache WHERE connection_id IS NULL ORDER BY op_id");
    expect(nullConn, "no cached row may be left without a connection_id (the 'SERVER —' class)").toEqual([]);

    // ── HOW it fetched them (contracts §2) — asserted in the SAME test on
    // purpose. A separate leg would have to re-read the recorder after the fact,
    // and by then a second sync (or a worker restart) has changed what there is
    // to see: the stale set is empty the moment it has been refreshed once.
    const batches = idFilterBatches(mine).slice(idBatchesBeforeRun);
    expect(
      batches.length,
      "the stale rows must be fetched with a MULTI-VALUE `id` filter (contracts §2) — not one OP " +
        "request per row, and not a project listing",
    ).toBeGreaterThan(0);
    for (const b of batches) {
      expect(
        b.length,
        `an id batch of ${b.length} exceeds ID_FETCH_BATCH_SIZE=${ID_FETCH_BATCH_SIZE}`,
      ).toBeLessThanOrEqual(ID_FETCH_BATCH_SIZE);
    }
    const asked = new Set(batches.flat());
    expect(
      asked.has(String(WP_DRIFT_ESTIMATE)),
      `#${WP_DRIFT_ESTIMATE} was never requested BY ID (batches this run: ${JSON.stringify(batches)}) — ` +
        "reaching it by id is the whole point; a project listing cannot see it",
    ).toBe(true);

    test.info().annotations.push({
      type: "B1 — SPEC_29 §1 coverage + contracts §2 bulk id fetch",
      description:
        `sync started ≥ ${before}; stale rows afterwards: ${stale.length}; id batches this run: ` +
        `${JSON.stringify(batches.map((b) => b.length))}. coverage=` +
        JSON.stringify(myOutcome(body)?.coverage ?? null),
    });
  });

  test("§B2: the #11948 shape — OP says PT8H, the cache was empty, after a sync it is 8h and fresh", async () => {
    requireReady();
    test.setTimeout(120_000);
    // Self-sufficient on purpose: a worker restart (Playwright discards the
    // worker after ANY failed test) rebuilds the fixture at day 1 with a
    // pre-drift cache, and this leg would then measure a fixture no sync had
    // touched. One refresh-all costs little and makes the result mean the same
    // thing whether or not an earlier leg went red.
    await syncNow();
    const row = await cacheRow(WP_DRIFT_ESTIMATE);
    expect(row, `#${WP_DRIFT_ESTIMATE} must still be cached`).toBeTruthy();
    expect(
      Number(row!.estimated_hours),
      `#${WP_DRIFT_ESTIMATE}: estimated_hours must be 8 after the sync (was empty; OP says PT8H). ` +
        `Row: ${JSON.stringify(row)}`,
    ).toBe(8);
    expect(
      row!.version_op_id,
      "…and the row must have caught up with the version move too",
    ).toBe(String(VERSION_UNSELECTED));

    // updated_at_op must match what OP actually reports for that ticket.
    // NOTE: scenario mode serves no `GET /api/v3/work_packages/:id` route (only
    // the filtered collection), which is also why the coverage pass fetches by
    // an `id` FILTER rather than per-id URLs.
    const opFilters = encodeURIComponent(
      JSON.stringify([{ id: { operator: "=", values: [String(WP_DRIFT_ESTIMATE)] } }]),
    );
    const opList = (await (
      await setup.get(`${mine.url}/api/v3/work_packages?filters=${opFilters}&pageSize=1`)
    ).json()) as {
      _embedded: { elements: Array<{ id: number; updatedAt: string; estimatedTime: string | null }> };
    };
    const opWp = opList._embedded.elements[0];
    expect(opWp, `OpenProject must still serve #${WP_DRIFT_ESTIMATE}`).toBeTruthy();
    expect(opWp!.estimatedTime, "the mock really is serving PT8H").toBe("PT8H");
    expect(
      Date.parse(row!.updated_at_op),
      `cached updated_at_op ${row!.updated_at_op} must equal OP's ${opWp!.updatedAt}`,
    ).toBe(Date.parse(opWp!.updatedAt));

    // …and the planning surface sees it (effectiveEstimate: remaining is null,
    // so Work wins — CAPACITY_BAR_RULES §3).
    const rows = await backlog({ connectionId: myConnId });
    const item = rows.find((r) => r.op_id === WP_DRIFT_ESTIMATE);
    expect(item, `#${WP_DRIFT_ESTIMATE} must be visible in the backlog`).toBeTruthy();
    expect(item!.effective_hours, "the planning estimate the user actually sees").toBe(8);

    test.info().annotations.push({
      type: "B2 — SPEC_29 §0/§5 (#11948)",
      description: `#${WP_DRIFT_ESTIMATE}: ${JSON.stringify(row)}; OP estimatedTime=${opWp!.estimatedTime}.`,
    });
  });

  test("§B1c: the Increment-25 by-id ticket is refreshed too (its project is in no selection)", async () => {
    requireReady();
    test.setTimeout(120_000);
    await syncNow(); // self-sufficient — see the note in §B2
    const row = await cacheRow(WP_BY_ID);
    expect(row, `#${WP_BY_ID} must be cached (added by id)`).toBeTruthy();
    expect(row!.project_op_id, "…in the never-imported project").toBe(String(PROJECT_ARCHIVE));
    expect(
      Number(row!.estimated_hours),
      `#${WP_BY_ID}: the day-1 estimate change (7h → 9h) must have reached the cache`,
    ).toBe(9);
  });

  test("§B3: a work package changed DURING a run is picked up by the FOLLOWING run", async () => {
    requireReady();
    test.setTimeout(180_000);
    await waitNoCurrentSync();

    const beforeRace = await cacheRow(WP_RACE);
    expect(Number(beforeRace?.estimated_hours ?? "0"), "#85030 starts at 6h").toBe(6);

    // Hold a real run open, then mutate OP WHILE it is in flight (day 2 sets
    // #85030 to 12h). This is SPEC_29 §2's race, reproduced literally.
    await setLatency(mine, 4_000);
    const bg = setup.post("/api/sync", { data: {} }).catch(() => undefined);
    const running = await waitCurrentSync();
    await gotoDay(mine, 2); // ← the change lands mid-run
    await bg;
    await waitNoCurrentSync(120_000);
    await setLatency(mine, 0);

    // The following run MUST see it. (Whether run #1 happened to catch it is
    // timing-dependent and deliberately not asserted — the contract's promise
    // is about the NEXT window, which is what the overlap window buys.)
    const second = await syncNow();
    expect(second.status, `second run: ${second.raw}`).toBe(200);
    const afterRace = await cacheRow(WP_RACE);
    expect(
      Number(afterRace?.estimated_hours ?? "0"),
      `#${WP_RACE} changed in OP during run ${running.id} and must be 12h after the following run ` +
        `(got ${JSON.stringify(afterRace)})`,
    ).toBe(12);

    test.info().annotations.push({
      type: "B3 — SPEC_29 §2 race",
      description:
        `#${WP_RACE}: 6h → 12h, changed while run ${running.id} was in flight, caught by the next run.`,
    });
  });

  test("§B3b: on success the watermark moves and equals the run's started_at; never finished_at", async () => {
    requireReady();
    expect(
      await watermarkTableExists(),
      "sync_watermark must exist (contracts §3 / migration 0002)",
    ).toBe(true);

    await waitNoCurrentSync();
    const res = await setup.post("/api/sync", {
      data: { project_op_id: PROJECT_CORE, version_op_id: VERSION_SELECTED, connection_id: myConnId, kind: "full" },
    });
    expect(res.ok(), `project sync: ${res.status()} ${await res.text()}`).toBeTruthy();
    const run = (await res.json()) as SyncRunLite;
    await waitNoCurrentSync();

    const mark = await watermark(PROJECT_CORE);
    expect(mark, `sync_watermark row for (connection ${myConnId}, project ${PROJECT_CORE})`).toBeTruthy();
    expect(
      Date.parse(mark!),
      `watermark_at must be the run's started_at (${run.started_at}), never its finished_at ` +
        `(${run.finished_at}) and never "now at commit time" — got ${mark}`,
    ).toBe(Date.parse(run.started_at));

    // Per (connection, project), not per connection alone (contracts §3).
    const columns = await sql(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sync_watermark' ORDER BY column_name`,
    );
    expect(columns, "the column is connection_id — never source_connection_id").toContain("connection_id");
    expect(columns).not.toContain("source_connection_id");
    expect(columns).toContain("project_op_id");

    test.info().annotations.push({
      type: "B3b — contracts §3 watermark",
      description:
        `run ${run.id} started_at=${run.started_at} finished_at=${run.finished_at} → watermark_at=${mark}. ` +
        `The Δ=${SYNC_OVERLAP_WINDOW_MINUTES}min window itself is NOT observable end-to-end here: the mock ` +
        "stamps updatedAt from the SCENARIO calendar (…T09:00:00Z of the logical day), which has no " +
        "relation to the real-clock watermark, so no fixture can place a change inside a 15-minute " +
        "real-clock band. That discrimination is Agent A's unit test on applyOverlapWindow(); what is " +
        "asserted here is every part the stack really exposes.",
    });
  });

  test("§B4: the response reports refreshed / total_cached, and a skipped connection reports no coverage", async () => {
    requireReady();
    const { body, before } = await syncNow();

    const ours = myOutcome(body);
    expect(ours, "our connection is in the breakdown").toBeTruthy();
    expect(ours!.coverage, "a SYNCED connection must carry a coverage block (contracts §4.3)").toBeTruthy();
    const cov = ours!.coverage!;

    // Contracts §4.1 — recomputed FROM THE DATABASE, so cross-check it there.
    const totalDb = Number(
      (await sqlOne(`SELECT count(*) FROM work_package_cache WHERE connection_id = ${myConnId}`)) ?? "0",
    );
    const refreshedDb = Number(
      (await sqlOne(
        `SELECT count(*) FROM work_package_cache
          WHERE connection_id = ${myConnId} AND cached_at >= ${ts(before)}`,
      )) ?? "0",
    );
    expect(cov.total_cached, "total_cached must match the database").toBe(totalDb);
    expect(cov.refreshed, "refreshed must match the database, not a JS counter").toBe(refreshedDb);
    expect(cov.not_refreshed, "not_refreshed = total_cached - refreshed").toBe(
      cov.total_cached - cov.refreshed,
    );
    expect(cov.oldest_cached_at, "oldest_cached_at lets the UI say 'oldest record: …'").toBeTruthy();

    const skipped = body.connections.filter((c) => c.status === "skipped");
    expect(
      skipped.length,
      "earlier specs' connections are disabled by this spec's setup, so at least one skipped outcome exists",
    ).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(
        s.coverage,
        `a skipped connection must report coverage: null — a zeroed block would read as "everything is stale" ` +
          `(connection ${s.connection_id})`,
      ).toBeNull();
    }

    test.info().annotations.push({
      type: "B4 — SPEC_29 §1.5 reporting",
      description: `coverage=${JSON.stringify(cov)} (db total=${totalDb} refreshed=${refreshedDb}).`,
    });
  });

  test("§B4b: an orphan is REPORTED and NOT deleted, and it forces not_refreshed > 0", async () => {
    requireReady();
    test.setTimeout(180_000);

    // Make #85040 vanish from OpenProject the only honest way available: load
    // the same fixture MINUS that ticket into our own mock, then fast-forward
    // to the same logical day so nothing else about the OP side changes.
    expect(await loadInto(mine, SCENARIO_ORPHANED), `scenario "${SCENARIO_ORPHANED}" must load`).toBe(true);
    await gotoDay(mine, 2);
    const gone = await setup.get(`${mine.url}/api/v3/work_packages/${WP_ORPHAN}`);
    expect(gone.status(), `#${WP_ORPHAN} must be absent from OP now`).toBe(404);

    const { body } = await syncNow();
    const cov = myOutcome(body)?.coverage ?? null;
    expect(cov, "our connection must still report coverage").toBeTruthy();
    expect(
      cov!.orphan_op_ids,
      `#${WP_ORPHAN} is cached but OP no longer returns it — it must be REPORTED`,
    ).toContain(WP_ORPHAN);
    expect(
      cov!.not_refreshed,
      "an unrefreshable orphan makes not_refreshed > 0 — which is what obliges the UI to warn",
    ).toBeGreaterThan(0);

    // …and it must still be there. Contracts §4.2: a row hidden by permissions
    // is indistinguishable from a deleted one; guessing wrong and hard-deleting
    // the user's sprint history is not recoverable.
    const stillCached = await cacheRow(WP_ORPHAN);
    expect(stillCached, `#${WP_ORPHAN} must NOT be auto-deleted from work_package_cache`).toBeTruthy();

    test.info().annotations.push({
      type: "B4b — SPEC_29 §1.4 / contracts §4.2 orphans",
      description: `orphan_op_ids=${JSON.stringify(cov!.orphan_op_ids)}, not_refreshed=${cov!.not_refreshed}, row kept.`,
    });
  });

  test("§B4d: 'Full refresh' clears every stale cutoff — from the button, and from the scheduler path", async () => {
    requireReady();
    test.setTimeout(180_000);

    const { before, body, status, raw } = await syncNow({ fullRefresh: true });
    expect(status, `full refresh: ${raw}`).toBe(200);
    expect(body.full_refresh, "the response must flag the pass as a FULL refresh (contracts §4.3)").toBe(true);

    // Contracts §5: every sync_watermark row for the connection is deleted
    // first, so none may survive from before this pass.
    const survivors = await sql(
      `SELECT project_op_id,
              to_char(watermark_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         FROM sync_watermark
        WHERE connection_id = ${myConnId} AND watermark_at < ${ts(before)}`,
    );
    expect(
      survivors,
      `a full refresh must leave NO watermark older than the pass itself (survivors: ${JSON.stringify(survivors)})`,
    ).toEqual([]);

    // …and an ordinary "Sync now" is NOT a full refresh (the flag discriminates).
    const plain = await syncNow();
    expect(plain.body.full_refresh, "an ordinary Sync now reports full_refresh: false").toBe(false);

    // The periodic driver: the scheduler module must exist and follow the
    // established scheduler shape. Its TIMER cannot fire here — this harness
    // boots apps/api with OSP_DISABLE_SCHEDULER=1 (tests/playwright.config.ts),
    // exactly as tm-/tp- document for the watchdog — so what is proven end-to-end
    // is the path it invokes (`full_refresh: true`, asserted above), and the
    // start/stop wiring is Agent B's unit responsibility.
    const schedulerFile = path.join(REPO_ROOT, "apps", "api", "src", "scheduler", "fullRefresh.ts");
    expect(
      fs.existsSync(schedulerFile),
      `contracts §5 requires ${schedulerFile} (periodic full refresh, OSP_FULL_REFRESH_INTERVAL_MS)`,
    ).toBe(true);

    test.info().annotations.push({
      type: "B4d — SPEC_29 §6.2 full refresh",
      description:
        `button path: full_refresh=${body.full_refresh}, watermarks surviving the clear: ${survivors.length}; ` +
        "scheduler timer deferred (OSP_DISABLE_SCHEDULER=1 in this harness).",
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §C — REGRESSION surface (SPEC_28 / SPEC_20 §2), asserted THROUGH a sync
  // ═══════════════════════════════════════════════════════════════════════════

  test("§C1: a developer's capacity total equals the sum of their tickets' effective estimates, and matches the DB", async () => {
    requireReady();
    const cap = await getCapacity(sprintCapId);
    const dev = lineFor(cap, DEV);
    expect(dev, `a capacity line for ${DEV} (got: ${cap.lines.map((l) => l.name).join(", ")})`).toBeTruthy();

    const items = (await getItems(sprintCapId)).filter(
      (i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint",
    );
    const sumItems = items.reduce((acc, i) => acc + (i.effective_hours ?? 0), 0);
    expect(
      dev!.planned_hours,
      `the Capacity line must equal Σ of the sprint items' effective estimates ` +
        `(items: ${JSON.stringify(items.map((i) => [i.op_id, i.effective_hours]))})`,
    ).toBeCloseTo(sumItems, 5);

    // …and both must equal what the DATABASE says, resolved by the documented
    // rule (CAPACITY_BAR_RULES §3): override > (remaining ≠ 0 ∧ ≠ work) ? remaining : work.
    const overrides = await sql(
      `SELECT wp_op_id FROM estimate_override WHERE wp_op_id IN (${WP_CAP_A}, ${WP_CAP_B})`,
    );
    expect(overrides, "no local override may be in play for this leg").toEqual([]);
    let sumDb = 0;
    for (const opId of [WP_CAP_A, WP_CAP_B]) {
      const row = await cacheRow(opId);
      expect(row, `#${opId} cached`).toBeTruthy();
      const work = row!.estimated_hours === "" ? null : Number(row!.estimated_hours);
      const remaining = row!.remaining_hours === "" ? null : Number(row!.remaining_hours);
      sumDb += remaining !== null && remaining !== 0 && remaining !== work ? remaining : (work ?? 0);
    }
    expect(
      dev!.planned_hours,
      `the Capacity number must equal the DATABASE's estimates (db Σ = ${sumDb}) — this is the ` +
        '"40 h + 4 h = 44 h but the UI shows 4 h" regression',
    ).toBeCloseTo(sumDb, 5);

    test.info().annotations.push({
      type: "C1 — SPEC_28 (regression). Deeper coverage: ts-estimate-recalculation.spec.ts §4",
      description:
        `${DEV}: capacity=${dev!.planned_hours}h, Σ items=${sumItems}h, Σ db=${sumDb}h. ts-…§4 already ` +
        "asserts Capacity / item list / Closure / Sprint-detail agreement after an estimate change; " +
        "this leg adds the DB cross-check and re-asserts it AFTER a sync (contracts §7).",
    });
  });

  test("§C2: capacity numbers do not move WHILE a sync runs, and land all at once when it finishes", async () => {
    requireReady();
    test.setTimeout(180_000);
    await waitNoCurrentSync();

    const beforeCap = (await getCapacity(sprintCapId)).total_planned_hours;
    const beforeDev = lineFor(await getCapacity(sprintCapId), DEV)?.planned_hours ?? 0;

    // Put the change in OP FIRST (day 3: #85001 5h → 20h), so it is the SYNC
    // that would move the numbers — then slow the sync down and watch.
    await gotoDay(mine, 3);
    expect(
      lineFor(await getCapacity(sprintCapId), DEV)?.planned_hours,
      "the change is in OP but not yet synced — capacity must not have moved yet",
    ).toBeCloseTo(beforeDev, 5);

    // ⚠️ ONE sync run, not a refresh-all. Atomicity is a property of a RUN:
    // staging is committed once per `engine.sync()`. A refresh-all is a
    // SEQUENCE of runs (one per import selection, plus the coverage pass), so
    // its numbers legitimately land run by run — sampling across the whole
    // batch measures the batch, not the swap, and reports a design as a defect.
    await setLatency(mine, 3_000);
    const bg = setup
      .post("/api/sync", {
        data: {
          project_op_id: PROJECT_CORE,
          version_op_id: VERSION_SELECTED,
          connection_id: myConnId,
          kind: "full",
        },
      })
      .catch(() => undefined);
    await waitCurrentSync();

    const samples: number[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await getStatus()).current !== null) {
      samples.push(lineFor(await getCapacity(sprintCapId), DEV)?.planned_hours ?? -1);
      await new Promise((r) => setTimeout(r, 200));
    }
    await bg;
    await waitNoCurrentSync(120_000);
    await setLatency(mine, 0);

    expect(samples.length, "at least one capacity read landed while the sync was running").toBeGreaterThan(0);
    expect(
      [...new Set(samples)],
      `capacity moved MID-RUN (samples: ${JSON.stringify(samples)}) — staging + atomic swap ` +
        "(contracts §0 / SPEC_20 §2) means the live cache is untouched until the single commit",
    ).toEqual([beforeDev]);

    const afterDev = lineFor(await getCapacity(sprintCapId), DEV)?.planned_hours ?? -1;
    expect(
      afterDev,
      `after the run commits, #${WP_CAP_A}'s new 20h estimate must land (was ${beforeDev}h)`,
    ).toBeCloseTo(beforeDev + 15, 5);

    test.info().annotations.push({
      type: "C2 — SPEC_20 §2 staging + atomic swap (regression)",
      description:
        `total before=${beforeCap}h; ${DEV} ${beforeDev}h → ${afterDev}h; ${samples.length} mid-run samples, ` +
        `all ${JSON.stringify([...new Set(samples)])}. Measured over ONE run: a refresh-all commits per ` +
        "sub-run, so its numbers land in steps — that is the shipped design, not a regression.",
    });
  });

  test("§C3: double counting is already covered by tt-double-counting.spec.ts — not duplicated here", async () => {
    requireReady();
    const tt = path.join(__dirname, "tt-double-counting.spec.ts");
    expect(fs.existsSync(tt), "tt-double-counting.spec.ts must exist (SPEC_28 §2 coverage)").toBe(true);
    const body = fs.readFileSync(tt, "utf8");
    for (const leg of [
      "'Parent' badge", // parent badge
      "Child of #1001", // child badge
      "the warning lists the CONCRETE pair",
      "Remove children",
      "Remove parent(s)",
      "on a LOCKED sprint the badges still render",
    ]) {
      expect(body.includes(leg), `tt-double-counting.spec.ts must still cover: ${leg}`).toBe(true);
    }
    test.info().annotations.push({
      type: "C3 — SPEC_28 §2 (regression, NOT duplicated)",
      description:
        "tt-double-counting.spec.ts §1–§4 already assert the parent badge, the 'Child of #…' badge, the " +
        "warning naming concrete pairs, both fix actions and marking-only-on-locked. Re-implementing them " +
        "here would create a second source of truth for the same contract; this leg only pins that the " +
        "coverage still exists.",
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §B5 — bulk cleanup (destructive: runs LAST)
  // ═══════════════════════════════════════════════════════════════════════════

  test("§B5a: the out-of-selection listing respects the version asymmetry and flags protected rows", async () => {
    requireReady();
    const { status, body, raw } = await outOfSelection();
    expect(status, `GET /api/backlog/out-of-selection: ${raw}`).toBe(200);
    expect(body, "the endpoint must answer with an OutOfSelectionResponse").toBeTruthy();

    const byId = new Map(body!.entries.map((e) => [e.op_id, e]));
    // Out of selection: same project, DIFFERENT version (the §0a asymmetry)…
    for (const opId of [WP_DRIFT_ESTIMATE, WP_DRIFT_PLAIN, WP_DRIFT_IN_SPRINT]) {
      const entry = byId.get(opId);
      expect(
        entry,
        `#${opId} (project ${PROJECT_CORE} IS selected, version ${VERSION_UNSELECTED} is NOT) must be listed. ` +
          `Listed: ${JSON.stringify([...byId.keys()])}`,
      ).toBeTruthy();
      expect(entry!.version_op_id).toBe(VERSION_UNSELECTED);
      expect(entry!.connection_id).toBe(myConnId);
    }
    // …and a project with no selection at all.
    expect(byId.get(WP_BY_ID), `#${WP_BY_ID} (project ${PROJECT_ARCHIVE}, never imported) must be listed`).toBeTruthy();
    // But NOT the rows the selection genuinely covers.
    for (const opId of [WP_CAP_A, WP_CAP_B, WP_RACE]) {
      expect(
        byId.has(opId),
        `#${opId} is inside the (project ${PROJECT_CORE}, version ${VERSION_SELECTED}) selection — it must NOT be listed`,
      ).toBe(false);
    }
    // A project-wide selection covers EVERY version: the other server imported
    // project 8400 with version_op_id = null, so nothing of its is out.
    const eftRows = body!.entries.filter((e) => e.connection_id === eftConnId);
    expect(
      eftRows.map((e) => e.op_id),
      "a version-less (project-wide) selection covers every version — the other asymmetry",
    ).toEqual([]);

    // Protection is flagged, with the reason the UI shows. Increment 31
    // (docs/INCREMENT_31_CONTRACTS.md §3): `protected` is now the actual
    // deletability rule, not `in_sprint` — but neither of this fixture's two
    // sprints is ever frozen, so the EXPECTED set of flagged tickets is
    // unchanged from before the increment; only which field is read changed.
    const protectedIds = body!.entries.filter((e) => e.protected).map((e) => e.op_id).sort((a, b) => a - b);
    expect(protectedIds, "the two tickets sitting in a (non-frozen) sprint are flagged").toEqual(
      [WP_BY_ID, WP_DRIFT_IN_SPRINT].sort((a, b) => a - b),
    );
    // `in_sprint` stays true for the same two rows — it is still "member of
    // ANY sprint", informational only now (§3) — and neither carries a frozen
    // membership (this fixture never freezes a sprint).
    expect(
      body!.entries.filter((e) => e.in_sprint).map((e) => e.op_id).sort((a, b) => a - b),
      "in_sprint (informational) still flags the same two rows — nothing here is frozen",
    ).toEqual(protectedIds);
    expect(byId.get(WP_DRIFT_IN_SPRINT)!.sprint_names.length, "…and named").toBeGreaterThan(0);
    expect(byId.get(WP_DRIFT_IN_SPRINT)!.frozen_sprint_names, "no frozen membership in this fixture").toEqual([]);
    expect(body!.protected_count).toBe(protectedIds.length);
    expect(body!.total).toBe(body!.entries.length);

    test.info().annotations.push({
      type: "B5a — SPEC_29 §1.5 / contracts §6 listing (Increment 31 §3: protected, not in_sprint)",
      description: `entries=${JSON.stringify(body!.entries.map((e) => [e.op_id, e.version_op_id, e.protected]))}`,
    });
  });

  test("§B5b: ONE bulk delete removes many, protects sprint tickets, rejects the rest — and writes nothing to OP", async () => {
    requireReady();
    const opWritesBefore = mine.requests.filter((r) => r.method !== "GET" && !r.path.startsWith("/__mock")).length;

    // One confirmation, one request, five ids covering every bucket.
    const res = await setup.post("/api/backlog/out-of-selection/delete", {
      data: {
        // ⚠️ WP_RACE, not WP_CAP_A: the buckets are evaluated in the order
        // contracts §6 lists them, so a ticket that is BOTH in a sprint and in
        // the selection is reported `protected`, never `in_selection`. #85001
        // sits in the capacity sprint; #85030 is in the selection and in no
        // sprint, which is the case this bucket is actually about.
        op_ids: [WP_DRIFT_ESTIMATE, WP_DRIFT_PLAIN, WP_DRIFT_IN_SPRINT, WP_RACE, NEVER_CACHED_OP_ID],
      },
    });
    const raw = await res.text();
    expect(res.status(), `partial success is a 200, never an error: ${raw}`).toBe(200);
    const body = JSON.parse(raw) as DeleteOutOfSelectionResponse;

    expect(
      body.removed.sort((a, b) => a - b),
      "both deletable out-of-selection rows go in ONE call",
    ).toEqual([WP_DRIFT_ESTIMATE, WP_DRIFT_PLAIN].sort((a, b) => a - b));
    expect(body.protected.map((p) => p.op_id), "a ticket in a sprint is protected, whatever the client asked").toEqual([
      WP_DRIFT_IN_SPRINT,
    ]);
    expect(body.protected[0]!.sprint_names.length, "…and the response says which sprint").toBeGreaterThan(0);
    const rejected = new Map(body.rejected.map((r) => [r.op_id, r.reason]));
    expect(rejected.get(WP_RACE), "a row that IS in the selection is re-validated server-side").toBe("in_selection");
    expect(rejected.get(NEVER_CACHED_OP_ID), "an id that isn't cached at all").toBe("not_cached");

    // The database really changed — and only where it was allowed to.
    expect(await cacheRow(WP_DRIFT_ESTIMATE), `#${WP_DRIFT_ESTIMATE} is gone from the cache`).toBeNull();
    expect(await cacheRow(WP_DRIFT_PLAIN), `#${WP_DRIFT_PLAIN} is gone from the cache`).toBeNull();
    expect(await cacheRow(WP_DRIFT_IN_SPRINT), `#${WP_DRIFT_IN_SPRINT} SURVIVES (it is in a sprint)`).toBeTruthy();
    expect(await cacheRow(WP_RACE), `#${WP_RACE} survives (still in the selection)`).toBeTruthy();

    // Sprint history is untouched by construction (protected rows are never
    // deleted) — assert it rather than assume it.
    const items = await getItems(sprintProtId);
    expect(
      items.map((i) => i.op_id).sort((a, b) => a - b),
      "the protection sprint's items are unchanged",
    ).toEqual([WP_BY_ID, WP_DRIFT_IN_SPRINT].sort((a, b) => a - b));

    // Local only: a delete endpoint does NOT relax the read-only invariant.
    const opWritesAfter = mine.requests.filter((r) => r.method !== "GET" && !r.path.startsWith("/__mock")).length;
    expect(opWritesAfter, "the cleanup must never write to OpenProject").toBe(opWritesBefore);

    test.info().annotations.push({
      type: "B5b — contracts §6 bulk delete",
      description: `response=${raw}`,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §G — standing guardrails, across BOTH recording mocks
  // ═══════════════════════════════════════════════════════════════════════════
  test("§G: every OpenProject request is a GET, /api/v3/users is never called, and no token leaks", async () => {
    requireReady();
    for (const [label, rec] of [["ours", mine], ["other server", eft]] as const) {
      const opRequests = rec.requests.filter((r) => !r.path.startsWith("/__mock"));
      expect(opRequests.length, `${label}: the mock was actually exercised`).toBeGreaterThan(0);
      for (const r of opRequests) {
        expect(r.method, `${label}: ${r.method} ${r.path} must be a GET (OpenProject is READ-ONLY)`).toBe("GET");
        expect(
          r.path.startsWith("/api/v3/"),
          `${label}: op-client must only ever target /api/v3/* (saw ${r.path})`,
        ).toBe(true);
      }
      expect(
        opRequests.filter((r) => r.path === "/api/v3/users").length,
        `${label}: the admin-gated GET /api/v3/users collection must NEVER be called`,
      ).toBe(0);
    }

    // The token never leaves the vault: no API response may echo it.
    const conns = await (await setup.get("/api/connections")).text();
    for (const token of ["tu-coverage-token", "tu-eft-token"]) {
      expect(conns.includes(token), `GET /api/connections leaked ${token}`).toBe(false);
    }

    test.info().annotations.push({
      type: "G — SPEC_29 §5 guardrails",
      description:
        `ours: ${mine.requests.filter((r) => !r.path.startsWith("/__mock")).length} OP requests; ` +
        `other: ${eft.requests.filter((r) => !r.path.startsWith("/__mock")).length}. All GET, no /api/v3/users.`,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §UI — the browser legs, deliberately LAST
  //
  // Playwright discards the worker process after a failed test and re-runs
  // `beforeAll`, which rebuilds the mocks and replays the scenario to day 1 —
  // so a red test in the MIDDLE of this file silently changes the fixture every
  // later test is measuring (it produced three false greens before these were
  // moved). Agent C's surfaces are the most likely to be unlanded, so they run
  // after everything that depends on shared state, including §G.
  // ═══════════════════════════════════════════════════════════════════════════
  test("§B4c: with rows left unrefreshed the UI says so — a partial refresh is never an unqualified success", async ({
    page,
  }) => {
    requireReady();
    test.setTimeout(180_000);
    await waitNoCurrentSync();

    // Re-establish the orphan unconditionally: this leg runs last, so it must
    // not depend on §B4b's mutation surviving (a worker restart rebuilds the
    // mock from s19, where #85040 still exists and nothing is unrefreshable).
    expect(await loadInto(mine, SCENARIO_ORPHANED), `scenario "${SCENARIO_ORPHANED}" must load`).toBe(true);
    await gotoDay(mine, 3);
    const precondition = await syncNow();
    const cov = myOutcome(precondition.body)?.coverage ?? null;
    expect(
      cov?.not_refreshed ?? 0,
      `the precondition for this leg is a run that leaves rows unrefreshed (coverage=${JSON.stringify(cov)})`,
    ).toBeGreaterThan(0);

    await page.goto("/");
    const syncNowBtn = page.getByRole("button", { name: "Sync now" });
    await expect(syncNowBtn, "the 'Sync now' control must be reachable").toBeVisible({ timeout: 15_000 });
    await syncNowBtn.click();

    // Agent C owns the exact copy; the CONTRACT is that something visible names
    // the shortfall. Accept any of the shapes the increment describes rather
    // than pinning one unfrozen string, but require one of them to appear.
    const warning = page
      .locator('[aria-label="sync coverage warning"], [data-testid="sync-coverage-warning"]')
      .or(page.getByText(/not refreshed|nerefresh|stale|oldest record|refreshed \d+\s*\/\s*\d+/i));
    await expect
      .poll(async () => warning.count(), {
        timeout: 45_000,
        message:
          "after a run that left rows unrefreshed the header/banner must warn visibly " +
          "(SPEC_29 §1.5 'no silent success')",
      })
      .toBeGreaterThan(0);
    const shown = (await warning.first().innerText()).trim();
    expect(shown.length, "the warning is a real message, not a blank element").toBeGreaterThan(0);

    test.info().annotations.push({
      type: "B4c — SPEC_29 §1.5 visible warning (browser)",
      description: `UI showed: ${JSON.stringify(shown)}`,
    });
  });

  test("§B5c: the browser offers the cleanup and removes several tickets on ONE confirmation", async ({ page }) => {
    requireReady();
    test.setTimeout(180_000);
    await waitNoCurrentSync();
    // Own pair of rows (#85013/#85014) so this leg never depends on §B5b's
    // deletions not having happened — a delete is not a repeatable action.
    await syncNow();
    expect(await cacheRow(WP_BULK_A), `#${WP_BULK_A} must be cached before the UI removes it`).toBeTruthy();
    expect(await cacheRow(WP_BULK_B), `#${WP_BULK_B} must be cached before the UI removes it`).toBeTruthy();

    await page.goto("/");
    await page.getByRole("navigation", { name: "Screens" }).getByRole("button", { name: "Import" }).click();

    const panel = page
      .locator(".panel")
      .filter({ has: page.getByRole("heading", { name: /out-of-selection/i }) });
    await expect(
      panel,
      "SPEC_29 §1.5 requires a visible 'outside the current import selection' list",
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(String(WP_BULK_A)).first()).toBeVisible();

    // Bulk selection: "Select all" covers only the REMOVABLE rows — a ticket in
    // a sprint must not even be selectable, or one careless click would delete
    // sprint history.
    await panel.getByRole("checkbox", { name: "Select all" }).check();
    const remove = panel.getByRole("button", { name: /Remove selected/i });
    await expect(remove, "the bulk action names how many rows it will remove").toBeEnabled();
    const removeLabel = (await remove.innerText()).trim();

    // ONE confirmation for the whole set.
    await remove.click();
    await page.getByTestId("out-of-selection-confirm-button").click();

    const result = page.getByTestId("out-of-selection-result");
    await expect(result, "the UI reports the buckets it got back").toBeVisible({ timeout: 30_000 });
    const resultText = (await result.innerText()).trim();

    // The DATABASE is the proof, not the toast.
    expect(await cacheRow(WP_BULK_A), `#${WP_BULK_A} removed by the ONE confirmation`).toBeNull();
    expect(await cacheRow(WP_BULK_B), `#${WP_BULK_B} removed by the SAME confirmation`).toBeNull();
    expect(
      await cacheRow(WP_DRIFT_IN_SPRINT),
      `#${WP_DRIFT_IN_SPRINT} is in a sprint — "Select all" must never have offered it`,
    ).toBeTruthy();
    expect(await cacheRow(WP_BY_ID), `#${WP_BY_ID} is in a sprint and survives too`).toBeTruthy();

    test.info().annotations.push({
      type: "B5c — SPEC_29 §1.5 cleanup UI (browser)",
      description:
        `Import screen → "${removeLabel}" → one confirmation → "${resultText}". #${WP_BULK_A} and ` +
        `#${WP_BULK_B} are gone from work_package_cache; the two sprint-held tickets survive.`,
    });
  });
});
