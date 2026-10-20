import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";

/**
 * TR — Increment 25 (SPEC_25 "Retroaktivní přidání ticketu do sprintu — noční
 * AU tickety"), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tq → "tr-…" lexicographic sequence, so this
 * spec runs LAST (Playwright runs spec files in filename order against ONE
 * shared backend). Do NOT rename.
 *
 * WHAT THIS FILE PROVES (SPEC_25 §8 = this spec's DoD): a ticket that was
 * coded, merged AND tested overnight in Australia — DONE before Europe wakes up,
 * with real logged time, and NEVER in the backlog (its status "Tested" is a
 * HIDDEN_BACKLOG_STATUS) — can still be recorded. The new
 * `POST /sprints/:id/items/by-id` live-fetches it from OP by id (ignoring
 * backlog/filter/version/status), BACKDATES its sprint membership to the day the
 * work actually happened (earliest logged spentOn, else createdAt), and lands it
 * as `origin="added_retroactively"`. From there every EXISTING rule (Inc 14/16/
 * 17/18) processes it correctly with nothing new to invent:
 *
 *   §1  Add outside backlog — 25025 (status "Tested", NOT in the backlog) is
 *       added by id to an ACTIVE sprint; it then appears among the sprint's
 *       items with origin="added_retroactively".
 *   §2  Backdating — the returned SprintItem's `added_at` = the EARLIEST logged
 *       spentOn (2026-07-06), NOT "today"; `retro_source === "first_time_entry"`.
 *   §3  Capacity — the developer who logged (Dev Dvořák) gets a RED `acquired`
 *       segment (SPEC_17 case e); the ticket is NOT in his Planned, IS in his
 *       ±Change (positive) and IS in Delivered; his logged reflects the 6h.
 *   §4  Estimate — remaining=0 ⟹ effectiveEstimate falls back to Work (Inc 16),
 *       so the segment's estimate_hours is the Work (5h), never 0.
 *   §5  Burndown — the scope bump lands on the BACKDATED day (total_count 0 on
 *       days before 2026-07-06, 1 from 2026-07-06 onward) — not day 1, not today.
 *   §6  Changelog — a scope_added entry carries backdated_to=2026-07-06; the UI
 *       renders "added to sprint retroactively (as of 06/07/2026)".
 *   §7  Closure/Report — 25025 is in Closure's `done` bucket, in the developer's
 *       LOGGED and DELIVERED; the PDF surface renders (application/pdf).
 *   §8  Locked sprint — POST .../items/by-id on a locked sprint → 409
 *       SPRINT_LOCKED (immutability holds, hint: Reactivate).
 *   §9  Connection — the item always carries a stamped source connection; an
 *       explicit DISABLED connection_id → 409 CONNECTION_DISABLED.
 *   §10 Badge/dimming (browser) — the item renders with the SAME "added" badge
 *       as an ordinary mid-sprint add (NO separate "retro" badge — confirmed
 *       decision, SPEC_25 §9.2) and IS dimmed (it's done).
 *   §11 Guardrail — every OP request during the flow is a GET, never
 *       GET /api/v3/users; and the §0 real-DB tripwire holds.
 *
 * §0 real-DB TRIPWIRE (same pattern as tk-/tj-/tq-): fingerprint the REAL
 * apps/api/osp.sqlite at start/end; fail loudly if it moved (Increment-11
 * data-loss incident). No-ops (with a note) when the file is absent.
 *
 * ── FIXTURE (Agent A) ───────────────────────────────────────────────────────
 * s18-nightly-au-ticket (project 3): ONE work package #25025 "Nightly AU
 * hotfix", status "Tested" (hidden from the backlog), held+logged by developer
 * Dev Dvořák — 4h on 2026-07-06 + 2h on 2026-07-07 (6h total, remaining 0,
 * Work=5h). Earliest spentOn 2026-07-06 is the backdated added_at.
 *
 * ── OSP_DB_PATH / PORT isolation (guardrail) ────────────────────────────────
 * NO new apps/api boot path: reuses tests/playwright.config.ts's webServer
 * (which already sets OSP_DB_PATH + PORT to throwaway values). The one extra
 * server this spec starts is a RECORDING mock OP (createRecordingMockOpServer,
 * ephemeral port) used only to prove the read-only-to-OP invariant — it is a
 * mock OpenProject, never apps/api, and never the user's DB.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s18-nightly-au-ticket";
const PROJECT_OP_ID = 3;
const WP_NIGHTLY = 25025; // the "nightly AU ticket" (Agent A fixture id)
const DEV = "Dev Dvořák"; // logged the work → red `acquired` segment / DELIVERED
const TESTER = "Tereza Testerová";
const CUSTOMER = "Karel Zákazník";

// The real day the work happened (earliest logged spentOn) — the backdate target.
const BACKDATED_DAY = "2026-07-06"; // a Monday
const BACKDATED_DAY_UK = "06/07/2026"; // formatDate() British DD/MM/YYYY (Inc 16)
// A WORKING day strictly before the backdate that IS in the burndown (the chart
// is weekdays-only, so 2026-07-04/05 — Sat/Sun — are not points; 2026-07-03 Fri is).
const DAY_BEFORE_BACKDATE = "2026-07-03";

// A CURRENT ongoing window: start on a Monday well before the backdated day (so a
// working day precedes it — clean burndown before/after), end in the future so
// the sprint is genuinely `active` today (not auto-locked).
const SPRINT_START = "2026-06-29"; // Monday
const SPRINT_END = "2026-08-31";

// effectiveEstimate (Inc 16): remaining=0 ⟹ fall back to Work (5h), never 0.
const EXPECTED_WORK_HOURS = 5;
const EXPECTED_LOGGED_HOURS = 6;

type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
const ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: DEV, role: "developer" },
  { name: TESTER, role: "tester" },
  { name: CUSTOMER, role: "customer" },
];

// ── minimal contract subsets ─────────────────────────────────────────────────
interface SprintRow {
  id: number;
  name: string;
  status: string;
  is_locked?: boolean;
}
interface SprintItemResponse {
  id: number;
  sprint_id: number;
  wp_op_id: number;
  added_at: string;
  planned_hours: number | null;
  origin: string;
  retro_source: string | null;
}
interface DeveloperSegment {
  wp_op_id: number;
  kind: string;
  estimate_hours: number | null;
  logged_hours: number;
  change_delta_hours: number;
  planned_delta_hours: number;
  in_baseline: boolean;
}
interface DeveloperBreakdown {
  name: string;
  planned_hours: number;
  // Increment-30 addition: Σ green (baseline) — what `planned_hours` meant
  // before Increment 30 redefined it as CURRENT SCOPE.
  baseline_hours: number;
  scope_change_hours: number;
  delivered_hours: number;
  logged_hours: number;
  segments: DeveloperSegment[];
}
interface ClosureBucketItem {
  wp_op_id: number;
  subject: string;
}
interface ClosureStatsResponse {
  total_delivered_hours: number;
  done: { count: number; items: ClosureBucketItem[] };
  per_developer: DeveloperBreakdown[];
}
interface BurndownPoint {
  date: string;
  total_count: number | null;
}
interface BurndownResponse {
  points: BurndownPoint[];
}
interface ChangelogEntryView {
  wp_op_id?: number;
  detail: { kind: string; hours?: number | null; backdated_to?: string };
}
interface SprintItemDetail {
  op_id: number;
  origin?: string;
  is_done?: boolean;
  connection_base_url?: string | null;
  connection_label?: string | null;
}
interface PersonSummary {
  id: number;
  name: string;
  role: PersonRole;
}
interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
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
    return null; // absent in this sandbox — "if it exists, we never touch it".
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
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}. This is the Increment-11 incident: ` +
        `the suite must ONLY ever touch its throwaway temp DB (tests/playwright.config.ts).`,
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function notImplemented(status: number): boolean {
  return status === 404;
}
async function getSprint(ctx: APIRequestContext, id: number): Promise<SprintRow | undefined> {
  const res = await ctx.get("/api/sprints");
  if (!res.ok()) return undefined;
  return ((await res.json()) as SprintRow[]).find((s) => s.id === id);
}
async function waitSprintStatus(ctx: APIRequestContext, id: number, status: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sprint = await getSprint(ctx, id);
    if (sprint?.status === status) return;
    if (Date.now() > deadline) throw new Error(`sprint ${id} did not reach "${status}" within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function addById(
  ctx: APIRequestContext,
  sprintId: number,
  wp: number,
  connectionId?: number,
): Promise<{ status: number; item: SprintItemResponse | null; error: ErrorEnvelope | null }> {
  const res = await ctx.post(`/api/sprints/${sprintId}/items/by-id`, {
    data: { wp_op_id: wp, ...(connectionId !== undefined ? { connection_id: connectionId } : {}) },
  });
  const status = res.status();
  if (status === 201) return { status, item: (await res.json()) as SprintItemResponse, error: null };
  let error: ErrorEnvelope | null = null;
  try {
    error = (await res.json()) as ErrorEnvelope;
  } catch {
    /* non-JSON body */
  }
  return { status, item: null, error };
}
async function getClosureStats(
  ctx: APIRequestContext,
  sprintId: number,
): Promise<{ status: number; stats: ClosureStatsResponse | null }> {
  const res = await ctx.get(`/api/sprints/${sprintId}/closure-stats`);
  if (!res.ok()) return { status: res.status(), stats: null };
  return { status: res.status(), stats: (await res.json()) as ClosureStatsResponse };
}
function segmentsLanded(stats: ClosureStatsResponse | null): boolean {
  return !!stats && Array.isArray(stats.per_developer) && stats.per_developer.every((d) => Array.isArray(d.segments));
}
async function setRoles(ctx: APIRequestContext): Promise<"no-route" | "ok" | "partial"> {
  const res = await ctx.get("/api/people");
  if (!res.ok()) return "no-route";
  const people = (await res.json()) as PersonSummary[];
  let anyFound = false;
  for (const { name, role } of ROLES) {
    const person = people.find((p) => p.name === name);
    if (!person) continue;
    anyFound = true;
    const put = await ctx.put(`/api/people/${person.id}/role`, { data: { role } });
    if (notImplemented(put.status())) return "no-route";
    expect(put.ok(), `PUT role ${name}=${role}: ${put.status()} ${await put.text()}`).toBeTruthy();
  }
  return anyFound ? "ok" : "partial";
}
function devByName(stats: ClosureStatsResponse, name: string): DeveloperBreakdown | undefined {
  return stats.per_developer.find((d) => d.name === name);
}

// ── board navigation (mirrors tq-'s gotoSprintBoardAndSelect) ─────────────────
async function gotoSprintBoardAndSelect(page: Page, sprintId: number): Promise<void> {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Screens" }).getByRole("button", { name: "Sprint board", exact: true }).click();
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
  await page.locator(`[data-testid="wp-card-${WP_NIGHTLY}"]`).waitFor({ state: "visible", timeout: 15_000 });
}

// ═════════════════════════════════════════════════════════════════════════════
// NOTE: intentionally a PLAIN describe (not `.serial`): the beforeAll builds
// the one active sprint + retro item every read-only leg shares, and the
// negative/guard legs create+delete their OWN sprints and restore any connection
// toggles in a finally. Playwright runs a file's tests sequentially on one
// worker, so ordering/state is preserved — but a single genuine-bug FAILURE
// (e.g. §3b, the un-ingested logged-time gap) must NOT abort every other DoD
// leg, which `.serial` would do. Each leg reports independently.
test.describe("TR — SPEC_25 retroactive ticket add (nightly AU ticket)", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let sprintId = 0;
  let addedItem: SprintItemResponse | null = null;
  let addStatus = 0;
  let dbBefore: DbFingerprint | null;
  let scenarioMissing = false;
  let notActive = false;
  let routeMissing = false;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    try {
      await loadScenario(setup, SCENARIO);
    } catch (err) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TR] scenario "${SCENARIO}" not loadable: ${String(err)}`);
      return;
    }
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
    // Sync so the project/people surface exists locally (the ticket itself is
    // fetched fresh by the by-id route; sync is just to populate the roster).
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } }).catch(() => {});

    // Create a plain (NON-retrospective) sprint spanning the backdated day, then
    // ACTIVATE it EMPTY — the ticket only exists via by-id (it's not in backlog).
    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TR retro-add"), start_date: SPRINT_START, end_date: SPRINT_END },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    sprintId = ((await created.json()) as { id: number }).id;

    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    if (!activated.ok()) {
      notActive = true;
      // eslint-disable-next-line no-console
      console.warn(`[TR] empty-sprint activation failed: ${activated.status()} ${await activated.text()}`);
      return;
    }
    await waitSprintStatus(setup, sprintId, "active");

    // THE new capability: add the done/tested nightly ticket by id to the ACTIVE sprint.
    const res = await addById(setup, sprintId, WP_NIGHTLY);
    addStatus = res.status;
    addedItem = res.item;
    if (notImplemented(res.status)) {
      routeMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TR] POST /sprints/:id/items/by-id not landed (404) — Agent B route missing.`);
      return;
    }
    expect(res.status, `add-by-id #${WP_NIGHTLY}: ${res.status} ${JSON.stringify(res.error)}`).toBe(201);

    // Roles are set LIVE (identity = name); the developer must be role=developer
    // for the capacity/closure leg to attribute the red segment.
    await setRoles(setup).catch(() => {});
  });

  test.afterAll(async () => {
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup?.dispose();
    assertRealDbUnchanged(dbBefore);
  });

  /** Precondition gate for every leg that needs the active sprint + landed add. */
  function skipUnlessAdded(): void {
    test.skip(scenarioMissing, `Agent A fixture "${SCENARIO}" not landed (scenario 404).`);
    test.skip(notActive, "empty-sprint activation unavailable — cannot reach an ACTIVE sprint to add into.");
    test.skip(routeMissing, "POST /sprints/:id/items/by-id not landed (Agent B route missing).");
    test.skip(addStatus !== 201 || addedItem === null, `add-by-id did not return 201 (got ${addStatus}).`);
  }

  // ── §0 tripwire armed ─────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_25 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1 add outside backlog ─────────────────────────────────────────────────
  test("§1: a Tested ticket NOT in the backlog is added by id to the ACTIVE sprint (origin=added_retroactively)", async () => {
    skipUnlessAdded();
    const item = addedItem as SprintItemResponse;

    // It was NOT in the backlog (status "Tested" is a HIDDEN_BACKLOG_STATUS).
    const backlogRes = await setup.get(`/api/backlog?projectId=${PROJECT_OP_ID}`);
    if (backlogRes.ok()) {
      const backlog = (await backlogRes.json()) as Array<{ op_id: number }>;
      expect(
        backlog.some((b) => b.op_id === WP_NIGHTLY),
        `#${WP_NIGHTLY} must NOT be in the backlog (done/tested ticket is hidden) — the whole point of add-by-id`,
      ).toBe(false);
    }

    // …yet it IS now a member of the sprint, flagged added_retroactively.
    expect(item.wp_op_id, "returned item is #25025").toBe(WP_NIGHTLY);
    expect(item.origin, "origin is added_retroactively").toBe("added_retroactively");

    const detailed = await setup.get(`/api/sprints/${sprintId}/items/detailed`);
    if (detailed.ok()) {
      const rows = (await detailed.json()) as SprintItemDetail[];
      const row = rows.find((r) => r.op_id === WP_NIGHTLY);
      expect(row, `#${WP_NIGHTLY} appears in items/detailed`).toBeTruthy();
      expect((row as SprintItemDetail).origin, "detailed row origin is added_retroactively").toBe("added_retroactively");
    }
  });

  // ── §2 backdating ──────────────────────────────────────────────────────────
  test("§2: added_at is BACKDATED to the earliest logged spentOn (2026-07-06), not today; retro_source=first_time_entry", async () => {
    skipUnlessAdded();
    const item = addedItem as SprintItemResponse;
    test.info().annotations.push({
      type: "SPEC_25 §2 backdating",
      description: `added_at=${item.added_at} retro_source=${item.retro_source} (expected day ${BACKDATED_DAY})`,
    });
    expect(item.added_at.slice(0, 10), "added_at day = earliest spentOn").toBe(BACKDATED_DAY);
    expect(item.retro_source, "retro_source = first_time_entry (logged time exists)").toBe("first_time_entry");

    const today = new Date().toISOString().slice(0, 10);
    expect(item.added_at.slice(0, 10), "added_at is NOT 'today'").not.toBe(today);

    // The `created_at` FALLBACK branch (no logged time → retro_source="created_at")
    // is not exercisable from the s18 fixture (its only WP has logged time). It is
    // covered by Agent B's unit tests; a future fixture WP with zero time entries
    // would let this spec assert it end-to-end too.
    test.info().annotations.push({
      type: "SPEC_25 §2 created_at fallback",
      description:
        "NOT exercised end-to-end here: s18 only ships the logged-time ticket #25025. The created_at fallback " +
        "(retro_source='created_at') needs an Agent-A fixture WP with zero time entries; covered by B's unit tests meanwhile.",
    });
  });

  /** Shared: the developer's closure-stats breakdown + their #25025 segment. */
  async function devBreakdownOrSkip(): Promise<{ dev: DeveloperBreakdown; seg: DeveloperSegment }> {
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B).");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;
    test.skip(!segmentsLanded(s), "closure-stats.per_developer has no `segments` — engine not landed.");
    const dev = devByName(s, DEV);
    test.skip(
      dev === undefined,
      `${DEV} not in per_developer — role not resolvable to "developer" yet (people/role route or roster missing).`,
    );
    const d = dev as DeveloperBreakdown;
    const seg = d.segments.find((x) => x.wp_op_id === WP_NIGHTLY);
    test.info().annotations.push({
      type: "SPEC_25 §3 developer",
      description: JSON.stringify({
        name: d.name,
        planned: d.planned_hours,
        change: d.scope_change_hours,
        delivered: d.delivered_hours,
        logged: d.logged_hours,
        seg,
      }),
    });
    expect(seg, `${DEV} has a segment for #${WP_NIGHTLY}`).toBeTruthy();
    return { dev: d, seg: seg as DeveloperSegment };
  }

  // ── §3a capacity: in Delivered; in Planned since Increment 30, NOT in Baseline ─
  // ⚠️ CHANGED in Increment 30 (`docs/INCREMENT_30_CONTRACTS.md` §2a,
  // `docs/CAPACITY_BAR_RULES.md` §5 + invariant 7). `Planned` is now CURRENT
  // SCOPE, and a retroactively-added ticket IS in the sprint and IS assigned to
  // this developer — so it counts. The claim this test was really making,
  // "it was never PLANNED FOR at activation", is still asserted, but against
  // `baseline_hours`, which is the field that now carries that meaning.
  // Recomputed by hand: the developer has no baseline work at all, so
  // Baseline = 0 while Planned = the retro ticket's effective estimate (> 0).
  test("§3a: the retro ticket is credited to DELIVERED, enters Planned as current scope (Inc 30), and stays out of Baseline", async () => {
    skipUnlessAdded();
    const { dev, seg } = await devBreakdownOrSkip();
    // It is CURRENT SCOPE — the segment carries its estimate into Planned.
    expect(seg.planned_delta_hours, "the retro ticket is current scope (Increment 30 §2a)").toBeGreaterThan(0);
    expect(dev.planned_hours, `${DEV} Planned includes the retro ticket (current scope)`).toBeGreaterThan(0);
    // …but it was never BASELINE work: nothing was his at the activation anchor.
    expect(dev.baseline_hours, `${DEV} Baseline excludes the retro ticket (=0, no baseline work)`).toBe(0);
    expect(seg.in_baseline, "the retro ticket was not in the baseline").toBe(false);
    // IS in Delivered (the done ticket is attributed to the sole developer).
    expect(dev.delivered_hours, `${DEV} Delivered includes the done retro ticket`).toBeGreaterThan(0);
  });

  // ── §3b capacity: RED `acquired` segment driven by the developer's logged time ─
  // ⚠️ CURRENTLY FAILS — a GENUINE cross-agent gap, not a spec bug: the retro
  // ticket's time entries (spentOn 2026-07-06/07) are never ingested as
  // `time_logged` changelog rows, so closure-stats sees 0 logged for the
  // developer and classifies the segment `idle` (grey) instead of `acquired`
  // (red). Root cause: sprintUpdate.ts's time-entry pass gates on
  // `spentOn >= activatedDate` (line ~522) — correct for normal sprints, but it
  // structurally drops a RETRO ticket's pre-activation work; AND the by-id route
  // itself (which already reads the earliest spentOn for backdating) never
  // persists the entries it read. SPEC_25 §2/§8 REQUIRE this red segment +
  // LOGGED, so this assertion is the honest DoD signal for Phase 2 to fix.
  test("§3b: the logging developer gets a RED `acquired` segment with their 6h logged (SPEC_17 case e)", async () => {
    skipUnlessAdded();
    const { dev, seg } = await devBreakdownOrSkip();
    expect(
      seg.logged_hours,
      `${DEV}'s 6h on #${WP_NIGHTLY} must be ingested (currently 0 — sprintUpdate gates time entries on spentOn>=activatedDate AND the by-id route never persists them)`,
    ).toBe(EXPECTED_LOGGED_HOURS);
    expect(dev.logged_hours, `${DEV} total logged in the sprint = 6h`).toBe(EXPECTED_LOGGED_HOURS);
    // RED = `acquired` (SPEC_17 case e: outside baseline + developer logged).
    expect(seg.kind, `#${WP_NIGHTLY} classifies as the RED "acquired" kind (needs logged>0)`).toBe("acquired");
    // acquired moves ±Change positively.
    expect(seg.change_delta_hours, "acquired moves ±Change positively").toBeGreaterThan(0);
    expect(dev.scope_change_hours, `${DEV} ±Change is positive`).toBeGreaterThan(0);
  });

  // ── §4 estimate: effectiveEstimate falls back to Work when remaining=0 ───────
  test("§4: remaining=0 ⟹ the segment estimate_hours reflects Work (5h), not 0 (Increment 16 effectiveEstimate)", async () => {
    skipUnlessAdded();
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed.");
    const s = stats as ClosureStatsResponse;
    test.skip(!segmentsLanded(s), "closure-stats.per_developer has no `segments`.");
    const dev = devByName(s, DEV);
    test.skip(dev === undefined, `${DEV} not in per_developer (role unresolved).`);
    const seg = (dev as DeveloperBreakdown).segments.find((x) => x.wp_op_id === WP_NIGHTLY);
    test.skip(seg === undefined, `no segment for #${WP_NIGHTLY}.`);
    const s2 = seg as DeveloperSegment;
    expect(s2.estimate_hours, "estimate_hours = Work (effectiveEstimate fallback), NOT 0").toBe(EXPECTED_WORK_HOURS);
    expect(s2.estimate_hours, "estimate_hours is not zero").not.toBe(0);
    // The item's frozen planned_hours snapshot equals the same Work fallback.
    expect((addedItem as SprintItemResponse).planned_hours, "item.planned_hours snapshot = Work").toBe(
      EXPECTED_WORK_HOURS,
    );
  });

  // ── §5 burndown backdating ──────────────────────────────────────────────────
  test("§5: the scope increase lands on the BACKDATED day (total_count 0 before 2026-07-06, 1 from it) — not day 1, not today", async () => {
    skipUnlessAdded();
    const res = await setup.get(`/api/sprints/${sprintId}/burndown`);
    test.skip(notImplemented(res.status()), "GET /sprints/:id/burndown not landed.");
    expect(res.ok(), `burndown: ${res.status()} ${await res.text()}`).toBeTruthy();
    const burndown = (await res.json()) as BurndownResponse;
    const byDate = new Map(burndown.points.map((p) => [p.date, p]));
    test.info().annotations.push({
      type: "SPEC_25 §5 burndown total_count by day",
      description: JSON.stringify(
        burndown.points
          .filter((p) => p.date >= "2026-07-04" && p.date <= "2026-07-08")
          .map((p) => ({ date: p.date, total_count: p.total_count })),
      ),
    });

    const before = byDate.get(DAY_BEFORE_BACKDATE);
    const onDay = byDate.get(BACKDATED_DAY);
    test.skip(
      before === undefined || onDay === undefined,
      `burndown lacks points around the backdated day (before=${!!before} on=${!!onDay}) — reconstruction window differs.`,
    );
    // Before the backdated day the retro item is NOT yet in scope.
    expect((before as BurndownPoint).total_count, `#${WP_NIGHTLY} NOT counted before ${BACKDATED_DAY} (no day-1 leak)`).toBe(
      0,
    );
    // From the backdated day it IS — the scope bump lands on the real day.
    expect((onDay as BurndownPoint).total_count, `#${WP_NIGHTLY} counted from ${BACKDATED_DAY} onward`).toBe(1);
  });

  // ── §6 changelog carries backdated_to ──────────────────────────────────────
  test("§6: a scope_added changelog entry records backdated_to=2026-07-06", async () => {
    skipUnlessAdded();
    const res = await setup.get(`/api/sprints/${sprintId}/tickets/${WP_NIGHTLY}/changelog`);
    test.skip(notImplemented(res.status()), "GET /sprints/:id/tickets/:wpId/changelog not landed.");
    expect(res.ok(), `changelog: ${res.status()} ${await res.text()}`).toBeTruthy();
    const entries = (await res.json()) as ChangelogEntryView[];
    const scopeAdds = entries.filter((e) => e.detail?.kind === "scope_added");
    test.info().annotations.push({
      type: "SPEC_25 §6 scope_added entries",
      description: JSON.stringify(scopeAdds.map((e) => e.detail)),
    });
    const retro = scopeAdds.find((e) => e.detail.backdated_to === BACKDATED_DAY);
    expect(retro, `a scope_added entry has backdated_to=${BACKDATED_DAY}`).toBeTruthy();
  });

  // ── §7 closure/report: done bucket + PDF ────────────────────────────────────
  test("§7: the ticket is in Closure's `done` bucket and in the developer's DELIVERED; the PDF surface renders", async () => {
    skipUnlessAdded();
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed.");
    const s = stats as ClosureStatsResponse;

    // done bucket contains the retro ticket (Tested → done via the done-matrix).
    const inDone = s.done?.items?.some((i) => i.wp_op_id === WP_NIGHTLY) ?? false;
    expect(inDone, `#${WP_NIGHTLY} is in Closure's done bucket`).toBe(true);
    expect(s.total_delivered_hours, "sprint-level Delivered reflects the delivered retro ticket").toBeGreaterThan(0);

    // PDF surface: streams application/pdf, READ-ONLY on sprint state.
    const pdf = await setup.post(`/api/reports/${sprintId}/pdf`, { data: {} });
    if (notImplemented(pdf.status())) {
      test.info().annotations.push({ type: "SPEC_25 §7 PDF", description: "POST /reports/:id/pdf not landed." });
    } else {
      expect(pdf.ok(), `PDF: ${pdf.status()} ${await pdf.text()}`).toBeTruthy();
      expect(pdf.headers()["content-type"] ?? "", "PDF content-type").toContain("application/pdf");
    }
  });

  // ── §8 locked/immutable sprint rejects the add ──────────────────────────────
  // A finished sprint is BOTH is_locked=true AND status="closed" (SprintStatus is
  // only planning|active|closed — there is no distinct "locked" status). The
  // by-id route checks `status === "closed"` BEFORE `is_locked`, so a finished
  // sprint legitimately surfaces SPRINT_CLOSED (a MORE specific immutability
  // rejection). The dedicated SPRINT_LOCKED branch (with the Reactivate hint) is
  // only reachable for a locked-but-NOT-closed sprint, which normal flows (finish
  // AND retro auto-lock both call performClosure → closed) don't produce. Either
  // 409 code proves the DoD: an immutable sprint refuses the retroactive add.
  test("§8: POST .../items/by-id against a locked/finished (immutable) sprint → 409 (SPRINT_LOCKED or SPRINT_CLOSED); immutability holds", async () => {
    test.skip(scenarioMissing, `Agent A fixture "${SCENARIO}" not landed.`);
    test.setTimeout(90_000);

    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TR locked"), start_date: SPRINT_START, end_date: SPRINT_END },
    });
    expect(created.ok(), `create locked-test sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    const lockedId = ((await created.json()) as { id: number }).id;
    try {
      const activated = await setup.post(`/api/sprints/${lockedId}/activate`);
      test.skip(!activated.ok(), `activate unavailable: ${activated.status()} ${await activated.text()}`);
      await waitSprintStatus(setup, lockedId, "active");
      const finish = await setup.post(`/api/sprints/${lockedId}/finish`, { data: {} });
      test.skip(!finish.ok(), `finish (lock) unavailable: ${finish.status()} ${await finish.text()}`);
      const sprint = await getSprint(setup, lockedId);
      expect(sprint?.is_locked, "sprint is locked after finish").toBeTruthy();

      const res = await addById(setup, lockedId, WP_NIGHTLY);
      test.skip(notImplemented(res.status), "POST /sprints/:id/items/by-id not landed.");
      test.info().annotations.push({
        type: "SPEC_25 §8 rejection",
        description: `locked/finished sprint rejected the add with code=${res.error?.error?.code} (status ${res.status}).`,
      });
      expect(res.status, `locked add rejected with 409 (got ${res.status})`).toBe(409);
      expect(
        ["SPRINT_LOCKED", "SPRINT_CLOSED"],
        `error code is an immutability rejection (got ${res.error?.error?.code})`,
      ).toContain(res.error?.error?.code);
    } finally {
      await setup.delete(`/api/sprints/${lockedId}`).catch(() => {});
    }
  });

  // ── §9 connection: stamped source + disabled → CONNECTION_DISABLED ──────────
  test("§9: the added item carries a stamped source connection; an explicit DISABLED connection → 409 CONNECTION_DISABLED", async () => {
    skipUnlessAdded();

    // (a) The happy-path item's WP row was stamped with a source connection
    //     (Increment 22 "never leave an un-attributed SERVER — row").
    const detailed = await setup.get(`/api/sprints/${sprintId}/items/detailed`);
    if (detailed.ok()) {
      const rows = (await detailed.json()) as SprintItemDetail[];
      const row = rows.find((r) => r.op_id === WP_NIGHTLY);
      expect(row, `#${WP_NIGHTLY} in items/detailed`).toBeTruthy();
      expect(
        (row as SprintItemDetail).connection_base_url,
        `#${WP_NIGHTLY} has a stamped source connection (never "SERVER —")`,
      ).not.toBeNull();
    }

    // (b) A disabled explicit target is legitimately fatal (Inc 23 §7.2).
    const distinctUrl = "http://127.0.0.1:59999/tr-inc25-disabled";
    const list = (await (await setup.get("/api/connections")).json()) as Array<{ id: number; base_url: string }>;
    let disabledId = list.find((c) => c.base_url === distinctUrl)?.id;
    if (disabledId === undefined) {
      const add = await setup.post("/api/connections", { data: { base_url: distinctUrl, token: "tr-disabled" } });
      test.skip(!add.ok(), `could not create a disabled test connection: ${add.status()} ${await add.text()}`);
      disabledId = ((await add.json()) as { id: number }).id;
    }
    await setup.patch(`/api/connections/${disabledId}`, { data: { enabled: false } });

    // Fresh sprint so #25025 isn't already present (would hit ITEM_ALREADY_IN_SPRINT first).
    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TR conn-disabled"), start_date: SPRINT_START, end_date: SPRINT_END },
    });
    const negId = ((await created.json()) as { id: number }).id;
    try {
      const res = await addById(setup, negId, WP_NIGHTLY, disabledId);
      test.skip(notImplemented(res.status), "POST /sprints/:id/items/by-id not landed.");
      expect(res.status, `disabled connection → 409 (got ${res.status})`).toBe(409);
      expect(res.error?.error?.code, "error code is CONNECTION_DISABLED").toBe("CONNECTION_DISABLED");
    } finally {
      await setup.delete(`/api/sprints/${negId}`).catch(() => {});
      await setup.patch(`/api/connections/${disabledId}`, { data: { enabled: true } }).catch(() => {});
    }
  });

  // ── §10 browser: SAME "added" badge, dimmed, and the retro changelog phrasing ─
  test("§10 (browser): the retro item shows the ordinary 'added' badge (no separate 'retro' label), is dimmed, and its changelog says 'retroactively (as of 06/07/2026)'", async ({
    page,
  }) => {
    skipUnlessAdded();
    await gotoSprintBoardAndSelect(page, sprintId);

    const card = page.locator(`[data-testid="wp-card-${WP_NIGHTLY}"]`);
    await expect(card, `#${WP_NIGHTLY} card renders in the active sprint`).toBeVisible();

    // Dimmed — it's done (Tested), Inc 18. `is_done` drives status-dimmed.
    await expect(card, `#${WP_NIGHTLY} is dimmed (done)`).toHaveClass(/status-dimmed/);

    // The SAME "added" badge as an ordinary mid-sprint add — NO separate retro badge.
    await expect(card.locator("span.badge.added"), `#${WP_NIGHTLY} carries the shared 'added' badge`).toHaveCount(1);
    await expect(card.getByText("retro", { exact: false })).toHaveCount(0);

    // Best-effort: open the ticket changelog and confirm the retroactive phrasing.
    const historyBtn = card.getByLabel(`View changelog for #${WP_NIGHTLY}`);
    if (await historyBtn.count()) {
      await historyBtn.first().click();
      const body = page.locator("body");
      await expect(body).toContainText(/retroactively/i);
      await expect(body).toContainText(BACKDATED_DAY_UK);
    } else {
      test.info().annotations.push({
        type: "SPEC_25 §10 changelog UI",
        description:
          `no "View changelog for #${WP_NIGHTLY}" control surfaced (has_history gate) — the API leg (§6) already ` +
          `proves backdated_to=${BACKDATED_DAY}; the rendered phrasing is asserted in apps/web unit tests.`,
      });
    }
  });

  // ── §11 guardrail: GET-only toward OP, never GET /api/v3/users ───────────────
  test("§11 guard: the add-by-id flow issues only GETs toward OpenProject and never GET /api/v3/users", async () => {
    test.skip(scenarioMissing, `Agent A fixture "${SCENARIO}" not landed.`);
    test.setTimeout(90_000);
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let recSprintId: number | null = null;
    try {
      rec = await createRecordingMockOpServer();
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);
      recConnId = await ensureConnection(setup, rec.url, "tr-guard-token");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      const created = await setup.post("/api/sprints", {
        data: { name: uniqueSprintName("TR guard"), start_date: SPRINT_START, end_date: SPRINT_END },
      });
      recSprintId = ((await created.json()) as { id: number }).id;
      const activated = await setup.post(`/api/sprints/${recSprintId}/activate`);
      if (activated.ok()) await waitSprintStatus(setup, recSprintId, "active").catch(() => {});

      // Record ONLY the by-id flow (fetch WP + earliest time-entry + statuses).
      rec.reset();
      const res = await addById(setup, recSprintId, WP_NIGHTLY, recConnId);
      test.skip(notImplemented(res.status), "POST /sprints/:id/items/by-id not landed.");

      const opReqs = rec.requests.filter((r) => r.path.startsWith("/api/v3/"));
      const sawOpRead = opReqs.length > 0;
      test.info().annotations.push({
        type: "SPEC_25 §11 OP traffic",
        description: `add-by-id (status ${res.status}) hit OP paths: ${JSON.stringify([
          ...new Set(opReqs.map((r) => `${r.method} ${r.path}`)),
        ])}`,
      });
      test.skip(!sawOpRead, "add-by-id did not reach the recording mock's OP surface (nothing to judge).");

      // Every OP request is a GET (read-only-to-OP invariant).
      const nonGet = opReqs.filter((r) => r.method !== "GET");
      expect(
        nonGet.length,
        `the app issued ${nonGet.length} non-GET request(s) toward OP: ${JSON.stringify(
          nonGet.map((r) => `${r.method} ${r.path}`),
        )} — it must be GET-only`,
      ).toBe(0);
      // Never the admin-gated user COLLECTION.
      const usersColl = opReqs.filter((r) => r.path === "/api/v3/users");
      expect(usersColl.length, "GET /api/v3/users (admin-gated collection) must never be issued").toBe(0);
    } finally {
      if (recSprintId) await setup.delete(`/api/sprints/${recSprintId}`).catch(() => {});
      if (recConnId) await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (rec) await rec.close().catch(() => {});
    }
  });
});
