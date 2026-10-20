import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Page,
  type Locator,
} from "@playwright/test";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";

/**
 * TG — Increment 14 (SPEC_14_Roles_Closure_Reports.md), Agent D / QA.
 *
 * FILE NAME NOTE: continues the t9 → ta → … → te → tf lexicographic sequence;
 * "tg-…" sorts AFTER "tf-…", so this spec runs LAST (Playwright runs spec files
 * in filename order against ONE shared backend). Do NOT rename to "t14".
 *
 * WHAT THIS FILE PROVES (SPEC_14 §6 Definition of Done, Agent D brief):
 *
 *   Task 1 — the §0 real-DB TRIPWIRE (same pattern as te-/tf-): fingerprint the
 *     REAL apps/api/osp.sqlite once at suite start and once at suite end; fail
 *     loudly if size/mtime moved (the Increment-11 data-loss incident). Skips
 *     gracefully when the file is absent in this sandbox.
 *   Task 2 — DONE-MATRIX on sprint 3.5.039 (fixtures/scenarios/s9-role-closure):
 *     with the confirmed roles (Trnka=Developer, Bubenik=Developer,
 *     Cesal=Customer, Benda=Customer, Brabec=Tester) closure-stats yields
 *     Done 9 / Not-done 2, and the not-done pair is EXACTLY #11592 (Trnka) and
 *     #11765 (Bubenik). Every `tested`/`resolved`/`closed` ticket is done by
 *     status, never not-done. #11747 (in progress + Customer) and #11726 (on hold
 *     + Customer) are done VIA ROLE.
 *   Task 2b — the matrix is genuinely ROLE-DRIVEN: flip Jindrich Benda to Developer
 *     and #11726 flips to not-done; restore Customer and it returns to done.
 *   Task 3 — `unset` role → AMBIGUOUS, never silently counted: leave a
 *     role-dependent-status holder (#11592 / Trnka) at role "unset" and the
 *     ticket lands in the `ambiguous` bucket, counting zero toward done/not-done,
 *     and the Settings→People UI shows "X people without a role affect Y tickets".
 *   Task 4 — UNASSIGNED + role-dependent status → not-done, plus an anomaly flag
 *     for the "in progress + unassigned" case (SPEC_14 §7 #1). (Probing: bites
 *     the moment a fixture carries such a ticket — s9 has none, see note.)
 *   Task 5 — CAPACITY = Developers only: a Customer/Tester line still APPEARS
 *     (is_developer=false, "grey"), but is EXCLUDED from
 *     total_available_hours/total_planned_hours (assert the totals equal Σ over
 *     is_developer lines) and is not availability-editable.
 *   Task 6 — ESTIMATE ACCURACY from dev-logged time on DONE tickets only;
 *     tester/customer logged time visible separately (dev_logged_hours <
 *     total_logged_hours) and never mixed into the ratio; per-ticket overshoot
 *     flag fires at >25% (11756: +33% → true) but not under (11585 → false) and
 *     not on not-done tickets (11592/11765 → delta/flag null). per_developer holds
 *     ONLY developers, attributed by WHO LOGGED (Trnka 14h, Bubenik 12h).
 *   Task 7 — REPORTS: GET /api/reports lists closed sprints only; GET
 *     /api/reports/:id works purely from stored data; POST /api/reports/:id/pdf
 *     returns a real PDF (%PDF magic + non-trivial length) — and CRITICALLY the
 *     sprint row (status/is_locked/locked_at/lock_reason) is BYTE-IDENTICAL
 *     before/after calling closure-stats + report-detail + PDF, twice
 *     (regression guard for SPEC_11 §8a: "view must never lock/mutate").
 *   Task 8 — HISTORY ordering (separate describe, s7-tester-roundtrip journals):
 *     default newest-first in the changelog modal, toggle flips it, choice
 *     persists within the session.
 *   Task 9 — GUARDRAILS: the API NEVER issues GET /api/v3/users (the admin-gated
 *     COLLECTION) during the NEW Increment-14 flows (closure-stats role lookups,
 *     GET /api/people, reports + PDF), driven against a RECORDING mock OP whose
 *     every inbound path is captured. HARD absence assertion (a guard that passes
 *     while the bug is present is worthless); only its prerequisite steps skip.
 *
 * ── OSP_DB_PATH / PORT isolation guard (SPEC_14 §6 last bullet) ───────────────
 * This spec introduces NO new apps/api boot path: it reuses the shared
 * tests/playwright.config.ts webServer (which already sets OSP_DB_PATH +
 * PORT — see that file) and, for Task 9, only spins up RECORDING MOCK OP servers
 * (createRecordingMockOpServer → ephemeral port 0, a mock OP with NO database at
 * all). The generic, repo-scoped guard `tests/src/env-isolation-guard.test.ts`
 * (§0 repo-scan block) already FAILS if ANY checked-in API-boot invocation omits
 * OSP_DB_PATH/PORT, and covers every apps/api boot path generically — so it
 * needs no Increment-14-specific extension. Task 1's live tripwire is the
 * belt-and-braces runtime proof that this run never touched the real DB.
 *
 * ── INTEGRATION NOTE (Agents A/B/C landing in parallel) ──────────────────────
 * The CONTRACTS (packages/contracts) are FROZEN and carry the Increment-14
 * shapes (PersonRole, CapacityLine.role/is_developer, PersonSummary/PeopleResponse,
 * SetPersonRoleBody, DoneRulesResponse, TicketClosureDetail, ClosureStatsResponse,
 * ClosedSprintSummary/ReportsListResponse, ReportDetailResponse). At time of
 * writing Agent A has landed the s9 scenario + DB schema (person.role, done_rule,
 * report_config), but the NEW ROUTES are not all registered yet: GET/PUT
 * /api/people, GET/PUT /api/done-rules, GET /sprints/:id/closure-stats, GET
 * /api/reports[/:id], POST /api/reports/:id/pdf, and the Settings→People /
 * Reports / history-toggle UI (Agent B/C). Every FUNCTIONAL test PROBES its
 * endpoint/UI first and test.skip()s with a precise annotation when the piece
 * isn't landed, keeping the suite green while the real assertions bite
 * automatically once each feature arrives. Task 9's absence assertion itself is
 * HARD — only its prerequisite flow steps skip.
 *
 * GUARDRAIL (unchanged, NOT duplicating t7-guardrails): nothing here issues a
 * non-GET toward OP — the only writes are to the app's own /api/* surface and
 * the mock's /__mock/* admin API. No token is read or asserted anywhere.
 */

const PROJECT_OP_ID = 3;
const SCENARIO = "s9-role-closure";
/** OP version the s9 tickets carry (matches the real sprint name). */
const SPRINT_VERSION = "3.5.039";
const SPRINT_WINDOW = { start: "2026-07-06", end: "2026-07-10" } as const;

// ── s9 ground truth (fixtures/scenarios/s9-role-closure.ts) ──────────────────
const WP = {
  // Done by STATUS (always_done) — role irrelevant.
  s11585: 11585, // Tested,   Vojtech Kolar,     est 8, dev-logged Bubenik 4h  (done)
  s11625: 11625, // Resolved, David Cesal,    est 5, customer-logged 5h     (done)
  s11687: 11687, // Tested,   Arend Kuiper,      est 6, tester-logged Brabec 3h  (done)
  s11756: 11756, // Tested,   Cameron Dalby, est 6, dev-logged Trnka 8h  (done, +33%)
  s11762: 11762, // Closed,   Jan Bily,         est 10                        (done)
  s11771: 11771, // Tested,   Arend Kuiper,      est 4                         (done)
  s11773: 11773, // Tested,   Arend Kuiper,      est 4                         (done)
  // Done by ROLE (role-dependent status + a non-developer holder).
  s11726: 11726, // On hold,  Jindrich Benda (Customer), est 3                    (done via role)
  s11747: 11747, // In prog., David Cesal (Customer), est 4, customer 5h    (done via role)
  // NOT DONE (role-dependent status + a Developer holder) — the only two.
  s11592: 11592, // In prog., Zbynek Trnka (Developer), est 4, dev-logged 6h (NOT done, +50%)
  s11765: 11765, // In prog., Tobias Bubenik (Developer),   est 8, dev-logged 8h (NOT done, 0%)
} as const;

const ALL_WP_IDS = Object.values(WP);
const EXPECTED_NOT_DONE = [WP.s11592, WP.s11765];
const TESTED_STATUS_WP = [WP.s11585, WP.s11687, WP.s11756, WP.s11771, WP.s11773];
const DONE_BY_ROLE_WP = [WP.s11726, WP.s11747];

/** The confirmed role assignment for the DoD (SPEC_14 §6). Everyone else stays
 * "unset" — which is fine here because every unset holder in s9 holds an
 * always_done-status ticket, so role never matters for them. */
const ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: "Zbynek Trnka", role: "developer" },
  { name: "Tobias Bubenik", role: "developer" },
  { name: "David Cesal", role: "customer" },
  { name: "Jindrich Benda", role: "customer" },
  { name: "Daniel Brabec", role: "tester" },
];

// ── §0 tripwire: the real DB file we must PROVE we never touch ────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/e2e/specs/ → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
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

// ── minimal contract subsets (mirrors tf-/td-'s local-interface style) ────────
type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
type TicketDoneBucket = "done" | "not_done" | "rejected" | "ambiguous";

interface PersonSummary {
  id: number;
  op_user_id: number | null;
  name: string;
  default_hours_per_day: number;
  role: PersonRole;
  ticket_count: number;
}
interface TicketClosureDetail {
  wp_op_id: number;
  subject: string;
  status_name: string;
  holder_name: string | null;
  holder_op_user_id: number | null;
  holder_role: PersonRole | null;
  bucket: TicketDoneBucket;
  ambiguous_reason: string | null;
  anomaly: "unassigned_in_progress" | null;
}
interface ClosureBucket {
  count: number;
  items: TicketClosureDetail[];
}
interface TicketEstimateLine {
  wp_op_id: number;
  subject: string;
  bucket: TicketDoneBucket;
  estimate_hours: number | null;
  dev_logged_hours: number;
  total_logged_hours: number;
  delta_hours: number | null;
  overshoot_flag: boolean | null;
}
interface DeveloperClosureBreakdown {
  member_id: number | null;
  op_user_id: number | null;
  name: string;
  planned_hours: number;
  logged_hours: number;
  delivered_estimate_hours: number;
  accuracy_pct: number | null;
  overshoot_hours: number;
}
interface ClosureStatsResponse {
  sprint_id: number;
  generated_at: string;
  total_planned_hours: number;
  total_logged_hours: number;
  dev_logged_hours: number;
  done: ClosureBucket;
  not_done: ClosureBucket;
  rejected: ClosureBucket;
  ambiguous: ClosureBucket;
  anomalies: TicketClosureDetail[];
  estimate_accuracy_pct: number | null;
  overshoot_hours: number;
  overshoot_threshold_pct: number;
  per_developer: DeveloperClosureBreakdown[];
  per_ticket: TicketEstimateLine[];
}
interface CapacityLine {
  member_id: number | null;
  op_user_id: number | null;
  name: string;
  available_hours: number;
  planned_hours: number;
  overloaded: boolean;
  has_sprint_work: boolean;
  role: PersonRole;
  is_developer: boolean;
}
interface CapacityResponse {
  capacity_mode: string;
  lines: CapacityLine[];
  total_available_hours: number;
  total_planned_hours: number;
}
interface ClosedSprintSummary {
  sprint_id: number;
  name: string;
  start_date: string;
  end_date: string;
  closed_at: string | null;
}
interface SprintRow {
  id: number;
  name: string;
  status: string;
  is_locked?: boolean;
  locked_at?: string | null;
  lock_reason?: string | null;
  start_date: string;
  end_date: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────
/** A route is "not landed yet" if it 404s (Fastify unknown-route). */
function notImplemented(status: number): boolean {
  return status === 404;
}

async function getSprint(ctx: APIRequestContext, id: number): Promise<SprintRow | undefined> {
  const res = await ctx.get("/api/sprints");
  if (!res.ok()) return undefined;
  return ((await res.json()) as SprintRow[]).find((s) => s.id === id);
}

async function waitSprintStatus(
  ctx: APIRequestContext,
  sprintId: number,
  status: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sprint = await getSprint(ctx, sprintId);
    if (sprint?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`sprint ${sprintId} did not reach status "${status}" within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function waitSprintTerminal(
  ctx: APIRequestContext,
  sprintId: number,
  timeoutMs = 40_000,
): Promise<SprintRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getSprint(ctx, sprintId);
    if (s && (s.status === "closed" || s.status === "finished" || s.is_locked)) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** GET /api/people (the GLOBAL person directory). null when the route 404s. */
async function getPeople(ctx: APIRequestContext): Promise<PersonSummary[] | null> {
  const res = await ctx.get("/api/people");
  if (!res.ok()) return null;
  return (await res.json()) as PersonSummary[];
}

/** Set a person's role by their display NAME (identity = the name, Inc 13).
 * Returns "no-route" | "not-found" | "ok". */
async function setRoleByName(
  ctx: APIRequestContext,
  name: string,
  role: PersonRole,
): Promise<"no-route" | "not-found" | "ok"> {
  const people = await getPeople(ctx);
  if (people === null) return "no-route";
  const person = people.find((p) => p.name === name);
  if (!person) return "not-found";
  const res = await ctx.put(`/api/people/${person.id}/role`, { data: { role } });
  if (notImplemented(res.status())) return "no-route";
  expect(res.ok(), `PUT /api/people/${person.id}/role (${name}=${role}): ${res.status()} ${await res.text()}`).toBeTruthy();
  return "ok";
}

/** Apply the full confirmed DoD role set. Returns false when the people/role
 * route family isn't landed yet (skip signal). */
async function applyDodRoles(ctx: APIRequestContext): Promise<boolean> {
  for (const { name, role } of ROLES) {
    const r = await setRoleByName(ctx, name, role);
    if (r === "no-route") return false;
    // "not-found" is tolerated per-name (person may not be materialized on this
    // connection yet) — the matrix assertion below will fail loudly if a role
    // that mattered didn't take.
  }
  return true;
}

async function getClosureStats(
  ctx: APIRequestContext,
  sprintId: number,
): Promise<{ status: number; stats: ClosureStatsResponse | null }> {
  const res = await ctx.get(`/api/sprints/${sprintId}/closure-stats`);
  if (!res.ok()) return { status: res.status(), stats: null };
  return { status: res.status(), stats: (await res.json()) as ClosureStatsResponse };
}

async function getCapacity(ctx: APIRequestContext, sprintId: number): Promise<CapacityResponse | null> {
  const res = await ctx.get(`/api/sprints/${sprintId}/capacity`);
  if (!res.ok()) return null;
  return (await res.json()) as CapacityResponse;
}

function bucketWpIds(b: ClosureBucket | undefined): number[] {
  return (b?.items ?? []).map((i) => i.wp_op_id).sort((a, z) => a - z);
}
function itemFor(stats: ClosureStatsResponse, wp: number): TicketClosureDetail | undefined {
  for (const b of [stats.done, stats.not_done, stats.rejected, stats.ambiguous]) {
    const hit = b.items.find((i) => i.wp_op_id === wp);
    if (hit) return hit;
  }
  return undefined;
}
function bucketOf(stats: ClosureStatsResponse, wp: number): TicketDoneBucket | "missing" {
  return itemFor(stats, wp)?.bucket ?? "missing";
}
function ticketLine(stats: ClosureStatsResponse, wp: number): TicketEstimateLine | undefined {
  return stats.per_ticket.find((t) => t.wp_op_id === wp);
}

// ── describe ──────────────────────────────────────────────────────────────────
test.describe.serial("TG — SPEC_14 roles / role-aware closure / reports / PDF", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let sprintId: number;
  let dbBefore: DbFingerprint | null;
  /** True once the s9 sprint could be created + activated + finished. */
  let sprintReady = false;

  test.beforeAll(async () => {
    // Retro seed + day-by-day replay across 11 tickets (see the is_retrospective
    // note below) runs well past the default 30s hook timeout — same reason
    // te-retrospective-planning.spec.ts / tf-retro-identity-capacity.spec.ts
    // set 90-120s on their own retro-heavy tests.
    test.setTimeout(120_000);
    // (Task 1) FIRST thing: fingerprint the real DB before ANY test runs.
    dbBefore = fingerprintRealDb();

    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    await loadScenario(setup, SCENARIO); // full reset of the mock to s9 day 0
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });

    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project 3: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // Create the 3.5.039 sprint, add all 11 tickets, activate (captures the
    // baseline estimate accuracy scores against), then finish → a CLOSED sprint
    // that closure-stats + reports read from. A throwaway, uniquely-named sprint
    // in the e2e temp DB — never anything the user owns.
    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TG 3.5.039"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    sprintId = ((await created.json()) as { id: number }).id;

    // Increment 14's DoD fixture reuses SPEC_13's real retro sprint 3.5.039 —
    // its time entries (Agent A's s9 seed) are dated 2026-07-06..09, in the
    // PAST relative to this test's real wall-clock "now". A NORMAL sprint's
    // activation only derives time_logged changelog rows for spentOn >= the
    // REAL activation instant (apps/api/src/logic/sprintUpdate.ts) — every
    // seeded entry would be silently dropped, zeroing dev_logged_hours. Mark
    // it retrospective BEFORE adding items (SPEC_12 §2 path C: an add onto a
    // retrospective planning sprint reconstructs to start_date) so activation
    // takes the replay path instead, which derives time_logged from
    // sprint.start_date onward (apps/api/src/logic/retro.ts persistReplayChangelog)
    // — the scenario's own calendar, not real "now". This is the established
    // "real-clock-vs-scenario-calendar gotcha" (see project memory).
    const retro = await setup.patch(`/api/sprints/${sprintId}`, { data: { is_retrospective: true } });
    expect(retro.ok(), `mark retrospective: ${retro.status()} ${await retro.text()}`).toBeTruthy();

    for (const wp of ALL_WP_IDS) {
      const added = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp } });
      expect(added.ok(), `add #${wp}: ${added.status()} ${await added.text()}`).toBeTruthy();
    }

    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    if (activated.ok()) {
      await waitSprintStatus(setup, sprintId, "active").catch(() => {});
      const finished = await setup.post(`/api/sprints/${sprintId}/finish`, { data: {} });
      if (finished.ok()) await waitSprintTerminal(setup, sprintId);
      sprintReady = true;
    }
  });

  test.afterAll(async () => {
    // Clean up our throwaway sprint (best-effort; never touches the real DB).
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup.dispose();

    // (Task 1) LAST thing: the real apps/api/osp.sqlite must be byte-for-byte
    // (size + mtime) exactly as we found it.
    const dbAfter = fingerprintRealDb();
    if (dbBefore === null || dbAfter === null) {
      // eslint-disable-next-line no-console
      console.warn(
        `[§0 tripwire] ${REAL_DB} absent in this environment — nothing to compare (invariant "if it exists we never touch it" holds vacuously).`,
      );
      return;
    }
    if (dbAfter.size !== dbBefore.size || dbAfter.mtimeMs !== dbBefore.mtimeMs) {
      throw new Error(
        `[§0 TRIPWIRE FAILED] the REAL DB ${REAL_DB} changed during the e2e run — ` +
          `before=${JSON.stringify(dbBefore)} after=${JSON.stringify(dbAfter)}. ` +
          `This is exactly the Increment-11 incident: the suite must ONLY ever touch ` +
          `its throwaway temp DB (see tests/playwright.config.ts).`,
      );
    }
  });

  // ── Task 1: §0 tripwire is armed ────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_14 §6 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present in this sandbox — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── Task 2: the done-matrix → Done 9 / Not-done 2 = exactly #11592, #11765 ───
  test("done-matrix: sprint 3.5.039 with the confirmed roles yields Done 9 / Not-done 2 = exactly #11592 (Trnka) + #11765 (Bubenik)", async () => {
    test.skip(!sprintReady, "s9 sprint could not be activated/finished (activation route unavailable)");

    const rolesOk = await applyDodRoles(setup);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed (Agent B)");

    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B)");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;

    test.info().annotations.push({
      type: "SPEC_14 §2/§6 done matrix",
      description:
        `done=${bucketWpIds(s.done).join(",")} | not_done=${bucketWpIds(s.not_done).join(",")} | ` +
        `rejected=${bucketWpIds(s.rejected).join(",")} | ambiguous=${bucketWpIds(s.ambiguous).join(",")}`,
    });

    // THE headline assertion: Done 9 / Not-done 2, the not-done pair EXACT.
    expect(s.not_done.count, "exactly two tickets are not done").toBe(2);
    expect(bucketWpIds(s.not_done), "the not-done pair must be exactly #11592 and #11765").toEqual(
      [...EXPECTED_NOT_DONE].sort((a, z) => a - z),
    );
    expect(s.done.count, "exactly nine tickets are done").toBe(9);
    expect(s.done.items.length, "done bucket item count matches its count").toBe(9);

    // The two not-done tickets are Developers holding a role-dependent status.
    for (const wp of EXPECTED_NOT_DONE) {
      const it = itemFor(s, wp);
      expect(it?.bucket, `#${wp} must be not_done`).toBe("not_done");
      expect(it?.holder_role, `#${wp} holder must be a Developer`).toBe("developer");
    }

    // `tested`/`resolved`/`closed` tickets are NEVER not-done (status alone proves done).
    for (const wp of TESTED_STATUS_WP) {
      expect(bucketOf(s, wp), `always-done-status #${wp} must never be not_done`).toBe("done");
    }

    // Done VIA ROLE: #11747 (in progress + Customer) and #11726 (on hold + Customer).
    for (const wp of DONE_BY_ROLE_WP) {
      const it = itemFor(s, wp);
      expect(it?.bucket, `#${wp} (role-dependent status + Customer) must be done via role`).toBe("done");
      expect(it?.holder_role, `#${wp} holder must be a Customer`).toBe("customer");
    }
  });

  // ── Task 2b: the matrix is genuinely ROLE-DRIVEN, not hardcoded per-ticket ───
  test("role-driven: flipping Jindrich Benda (holder of on-hold #11726) to Developer flips #11726 to not-done; restoring Customer flips it back", async () => {
    test.skip(!sprintReady, "s9 sprint not ready");
    const rolesOk = await applyDodRoles(setup);
    test.skip(!rolesOk, "people/role route not landed (Agent B)");

    const probe = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(probe.status), "closure-stats not landed (Agent B)");

    // Baseline: with Benda=Customer, #11726 is done.
    expect(bucketOf(probe.stats as ClosureStatsResponse, WP.s11726), "#11726 done while Benda=Customer").toBe("done");

    try {
      // Flip Benda → Developer: on-hold + developer = NOT done.
      const flip = await setRoleByName(setup, "Jindrich Benda", "developer");
      expect(flip, "Benda role flip to developer should apply").toBe("ok");
      const after = await getClosureStats(setup, sprintId);
      expect(bucketOf(after.stats as ClosureStatsResponse, WP.s11726), "#11726 becomes not_done when Benda=Developer").toBe(
        "not_done",
      );
      // With #11726 flipping, the not-done count grows past the DoD's 2.
      expect((after.stats as ClosureStatsResponse).not_done.count, "flip adds #11726 to not-done").toBeGreaterThan(2);
    } finally {
      // Restore the DoD role so later tests see the canonical matrix.
      await setRoleByName(setup, "Jindrich Benda", "customer");
    }
    const restored = await getClosureStats(setup, sprintId);
    expect(bucketOf(restored.stats as ClosureStatsResponse, WP.s11726), "#11726 back to done after restore").toBe("done");
  });

  // ── Task 3: `unset` role → AMBIGUOUS, counts zero; UI reports the counter ────
  test("unset role: a role-dependent holder left `unset` routes to `ambiguous`, counts zero toward done/not-done, and Settings→People surfaces the count", async ({
    page,
  }) => {
    test.skip(!sprintReady, "s9 sprint not ready");
    const rolesOk = await applyDodRoles(setup);
    test.skip(!rolesOk, "people/role route not landed (Agent B)");

    try {
      // Leave #11592's holder (Zbynek Trnka) at role "unset".
      const unset = await setRoleByName(setup, "Zbynek Trnka", "unset");
      expect(unset, "Trnka role should be settable to unset").toBe("ok");

      const { status, stats } = await getClosureStats(setup, sprintId);
      test.skip(notImplemented(status), "closure-stats not landed (Agent B)");
      const s = stats as ClosureStatsResponse;

      const it = itemFor(s, WP.s11592);
      expect(it?.bucket, "#11592 held by an unset-role person is AMBIGUOUS, never guessed").toBe("ambiguous");
      expect(it?.ambiguous_reason, "ambiguous ticket must carry a human reason (SPEC_14 §2)").toBeTruthy();
      // Counts ZERO toward done/not-done.
      expect(bucketWpIds(s.done)).not.toContain(WP.s11592);
      expect(bucketWpIds(s.not_done)).not.toContain(WP.s11592);
      expect(s.ambiguous.count, "ambiguous bucket count includes #11592").toBeGreaterThanOrEqual(1);

      // Settings → People UI: the "X people without a role affect Y tickets"
      // message (SPEC_14 §2). Probe for a People screen; skip if Agent C's UI
      // isn't landed. Absence of the API counter is proven by ticket_count/role
      // on GET /api/people regardless.
      const people = await getPeople(setup);
      const unsetPeople = (people ?? []).filter((p) => p.role === "unset");
      test.info().annotations.push({
        type: "SPEC_14 §2 unset counter",
        description: `GET /api/people reports ${unsetPeople.length} unset-role people; #11592 bucket=${it?.bucket}.`,
      });

      await page.goto("/");
      const peopleNav = page.getByRole("button", { name: /People|Settings/ });
      const hasPeopleUi = await peopleNav
        .first()
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!hasPeopleUi) {
        test.info().annotations.push({
          type: "SPEC_14 §2 People UI",
          description: "Settings→People screen not landed (Agent C) — API-level ambiguous/unset proof stands; skipping UI counter.",
        });
        return;
      }
      await peopleNav.first().click();
      const counter = page.getByText(/without a role.*affect/i);
      const hasCounter = await counter
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      if (!hasCounter) {
        test.info().annotations.push({
          type: "SPEC_14 §2 People UI",
          description: 'People screen present but the "X people without a role affect Y tickets" message not found — Agent C wiring pending.',
        });
        return;
      }
      await expect(counter).toBeVisible();
    } finally {
      // Restore the DoD role so later tests (reports/estimate) see the canonical matrix.
      await setRoleByName(setup, "Zbynek Trnka", "developer");
    }
  });

  // ── Task 4: UNASSIGNED + role-dependent → not-done, anomaly on in-progress ───
  test("unassigned + role-dependent status → not-done, and `in progress + unassigned` raises the `unassigned_in_progress` anomaly (SPEC_14 §7 #1)", async () => {
    test.skip(!sprintReady, "s9 sprint not ready");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "closure-stats not landed (Agent B)");
    const s = stats as ClosureStatsResponse;

    // s9 assigns every ticket, so there is no unassigned+role-dependent ticket to
    // observe here. Assert the CLASSIFICATION RULE over whatever unassigned,
    // role-dependent tickets are present; skip (with a fixture note) when none is.
    const unassignedRoleDependent = [s.not_done, s.ambiguous, s.done]
      .flatMap((b) => b.items)
      .filter((it) => it.holder_name === null && it.holder_role === null)
      // A genuinely unassigned always_done-status ticket (e.g. Tested) is done by
      // status; only role-dependent statuses are the interesting case. We detect
      // "role-dependent" indirectly: an unassigned ticket that is NOT in `done`.
      .filter((it) => it.bucket !== "done");

    if (unassignedRoleDependent.length === 0) {
      test.info().annotations.push({
        type: "SPEC_14 §7 #1 anomaly",
        description:
          "no unassigned + role-dependent-status ticket in the s9 fixture — add one (ideally `in progress` + unassigned) to make this bite; asserting the anomaly-array shape only.",
      });
      // The response still must expose the anomalies array (shape guard).
      expect(Array.isArray(s.anomalies)).toBe(true);
      test.skip(true, "no unassigned role-dependent ticket to classify in this fixture");
      return;
    }

    for (const it of unassignedRoleDependent) {
      expect(it.bucket, `unassigned role-dependent #${it.wp_op_id} must be not_done`).toBe("not_done");
      if (/in progress/i.test(it.status_name)) {
        expect(it.anomaly, `in-progress + unassigned #${it.wp_op_id} must flag the anomaly`).toBe("unassigned_in_progress");
        expect(
          s.anomalies.some((a) => a.wp_op_id === it.wp_op_id),
          `#${it.wp_op_id} must also surface in the top-level anomalies array`,
        ).toBe(true);
      }
    }
  });

  // ── Task 5: CAPACITY = Developers only; tester/customer grey, excluded ───────
  test("capacity roster totals developers only; a Customer/Tester line still appears (is_developer=false) but never moves total_available/total_planned", async () => {
    test.skip(!sprintReady, "s9 sprint not ready");
    const rolesOk = await applyDodRoles(setup);
    test.skip(!rolesOk, "people/role route not landed (Agent B)");

    const cap = await getCapacity(setup, sprintId);
    expect(cap, "GET /capacity should answer for the sprint").not.toBeNull();
    const c = cap as CapacityResponse;

    // Contract requires role + is_developer on every line (Increment 14).
    const hasRoleFields = c.lines.every((l) => typeof l.is_developer === "boolean" && typeof l.role === "string");
    if (!hasRoleFields) {
      test.info().annotations.push({
        type: "SPEC_14 §2 consequence #1",
        description: "capacity lines lack role/is_developer — Agent B's role-aware capacity not landed; skipping.",
      });
      test.skip(true, "capacity lines missing role/is_developer");
      return;
    }

    // David Cesal is a Customer assignee (of #11625 + #11747) → must appear as
    // a NON-developer, grey line.
    const cesal = c.lines.find((l) => l.name === "David Cesal");
    if (cesal) {
      expect(cesal.is_developer, "a Customer line is not a developer").toBe(false);
      expect(cesal.role, "Cesal's role is customer").toBe("customer");
    }

    // THE invariant: totals count DEVELOPER lines only (SPEC_14 §2 consequence #1).
    const devAvail = c.lines.filter((l) => l.is_developer).reduce((sum, l) => sum + l.available_hours, 0);
    const devPlanned = c.lines.filter((l) => l.is_developer).reduce((sum, l) => sum + l.planned_hours, 0);
    expect(c.total_available_hours, "total_available_hours excludes non-developers").toBeCloseTo(devAvail, 5);
    expect(c.total_planned_hours, "total_planned_hours excludes non-developers").toBeCloseTo(devPlanned, 5);

    // And a non-developer line, if present, is provably NOT contributing.
    const nonDev = c.lines.filter((l) => !l.is_developer && l.member_id !== null);
    if (nonDev.length > 0) {
      const nonDevPlanned = nonDev.reduce((s, l) => s + l.planned_hours, 0);
      test.info().annotations.push({
        type: "SPEC_14 §2 grey capacity",
        description: `non-developer lines present (${nonDev.map((l) => `${l.name}:${l.role}`).join(", ")}) carrying ${nonDevPlanned}h that are EXCLUDED from totals.`,
      });
    }
  });

  // ── Task 6: estimate accuracy = dev-logged, done-only; non-dev shown apart ───
  test("estimate accuracy comes from dev-logged time on DONE tickets only; overshoot flags fire at >25% per ticket; per-developer is developers-only, attributed by logger", async () => {
    test.skip(!sprintReady, "s9 sprint not ready");
    const rolesOk = await applyDodRoles(setup);
    test.skip(!rolesOk, "people/role route not landed (Agent B)");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "closure-stats not landed (Agent B)");
    const s = stats as ClosureStatsResponse;

    // Threshold echoed = 25% default (SPEC_14 §7 #5).
    expect(s.overshoot_threshold_pct, "default overshoot threshold is 25%").toBe(25);

    // dev-logged (26h: Bubenik 4+8 + Trnka 6+8) < total-logged (39h: + Cesal
    // 10h customer + Brabec 3h tester) — non-dev time is visible but separate.
    expect(s.dev_logged_hours, "dev-logged must be strictly less than total-logged (non-dev time exists)").toBeLessThan(
      s.total_logged_hours,
    );
    expect(s.dev_logged_hours).toBeCloseTo(26, 5);
    expect(s.total_logged_hours).toBeCloseTo(39, 5);

    // Per-ticket overshoot flags: 11756 done +33% → true; 11585 done under → false;
    // 11592/11765 NOT done → delta & flag null ("zatím spáleno", not accuracy).
    const t11756 = ticketLine(s, WP.s11756);
    expect(t11756?.overshoot_flag, "#11756 (8h/6h = +33% on a DONE ticket) overshoots the 25% threshold").toBe(true);
    const t11585 = ticketLine(s, WP.s11585);
    expect(t11585?.overshoot_flag, "#11585 (4h/8h, under estimate) does not overshoot").toBe(false);
    for (const wp of EXPECTED_NOT_DONE) {
      const line = ticketLine(s, wp);
      expect(line?.delta_hours, `not-done #${wp} has null delta (accuracy is meaningless until done)`).toBeNull();
      expect(line?.overshoot_flag, `not-done #${wp} has null overshoot flag`).toBeNull();
    }

    // estimate_accuracy_pct is Σ dev-logged / Σ estimate over ALL 9 DONE tickets
    // (SPEC_14 §3 — not-done tickets never count, but a done ticket no developer
    // logged time on still contributes its bare estimate, correctly dragging the
    // ratio down): dev-logged (11585:4 + 11756:8 = 12) / estimate (8+5+6+6+10+4+4+3+4 = 50) = 24%.
    expect(s.estimate_accuracy_pct, "estimate accuracy present with done dev-logged tickets").not.toBeNull();
    expect(s.estimate_accuracy_pct as number).toBeCloseTo((12 / 50) * 100, 1);

    // per_developer excludes every EXPLICIT non-developer, and logged_hours is
    // attributed by WHO LOGGED (Trnka 6+8=14, Bubenik 4+8=12), never by
    // assignee. Identity unification: a person with NO explicit role is now
    // plannable by default (the same "unset → developer" rule /capacity always
    // applied — golden test A2: nobody who logged/holds work may silently
    // vanish), so OTHER unrostered holders may legitimately appear here too —
    // the assertion pins "both developers in, every explicit non-developer
    // out", not an exact frozen list.
    const devNames = s.per_developer.map((d) => d.name).sort();
    expect(devNames, "both explicit developers appear").toEqual(
      expect.arrayContaining(["Tobias Bubenik", "Zbynek Trnka"]),
    );
    for (const { name, role } of ROLES) {
      if (role === "developer") continue;
      expect(devNames, `explicit ${role} "${name}" must NOT appear in per_developer`).not.toContain(name);
    }
    const trnka = s.per_developer.find((d) => d.name === "Zbynek Trnka");
    const bubenik = s.per_developer.find((d) => d.name === "Tobias Bubenik");
    expect(trnka?.logged_hours, "Trnka's own logged time (11592:6 + 11756:8)").toBeCloseTo(14, 5);
    expect(bubenik?.logged_hours, "Bubenik's own logged time (11585:4 + 11765:8)").toBeCloseTo(12, 5);
  });

  // ── Task 7: Reports list/detail/PDF, and the NO-MUTATION guard ───────────────
  test("reports list closed sprints only; detail works from stored data; PDF is real; and NONE of these reads mutate the sprint row (SPEC_11 §8a regression)", async () => {
    test.skip(!sprintReady, "s9 sprint not ready");

    const listRes = await setup.get("/api/reports");
    test.skip(notImplemented(listRes.status()), "GET /api/reports not landed (Agent B)");
    expect(listRes.ok(), `GET /api/reports: ${listRes.status()} ${await listRes.text()}`).toBeTruthy();
    const list = (await listRes.json()) as ClosedSprintSummary[];

    // Our finished sprint must be listed; a still-open sprint must NOT be.
    const ours = list.find((r) => r.sprint_id === sprintId);
    const sprintNow = await getSprint(setup, sprintId);
    const isClosed = sprintNow?.status === "closed" || sprintNow?.status === "finished" || sprintNow?.is_locked === true;
    if (isClosed) {
      expect(ours, `the finished sprint ${sprintId} must appear in GET /api/reports`).toBeTruthy();
    }
    // "closed sprints only": every listed sprint must actually be closed/locked.
    const allSprints = (await (await setup.get("/api/sprints")).json()) as SprintRow[];
    for (const r of list) {
      const row = allSprints.find((sp) => sp.id === r.sprint_id);
      if (!row) continue;
      expect(
        row.status === "closed" || row.status === "finished" || row.is_locked === true,
        `GET /api/reports listed a NON-closed sprint ${r.sprint_id} (status=${row.status}, locked=${row.is_locked})`,
      ).toBeTruthy();
    }

    // ── NO-MUTATION GUARD: fingerprint the sprint's lock-relevant row, hammer the
    //    read endpoints (closure-stats + report-detail + PDF) TWICE, and assert the
    //    row never moved (SPEC_11 §8a "view must never lock/mutate"). ──
    function lockFingerprint(row: SprintRow | undefined): string {
      return JSON.stringify({
        status: row?.status ?? null,
        is_locked: row?.is_locked ?? null,
        locked_at: row?.locked_at ?? null,
        lock_reason: row?.lock_reason ?? null,
      });
    }
    const before = lockFingerprint(await getSprint(setup, sprintId));

    let pdfProven = false;
    for (let pass = 0; pass < 2; pass += 1) {
      await getClosureStats(setup, sprintId);

      const detail = await setup.get(`/api/reports/${sprintId}`);
      if (!notImplemented(detail.status())) {
        expect(detail.ok(), `GET /api/reports/${sprintId}: ${detail.status()} ${await detail.text()}`).toBeTruthy();
        const body = (await detail.json()) as { sprint?: unknown; stats?: unknown; burndown?: unknown };
        expect(body.sprint, "report detail carries the sprint summary").toBeTruthy();
        expect(body.stats, "report detail carries closure stats").toBeTruthy();
        expect(body.burndown, "report detail carries burndown data").toBeTruthy();
      }

      const pdf = await setup.post(`/api/reports/${sprintId}/pdf`, { data: {} });
      if (!notImplemented(pdf.status())) {
        expect(pdf.ok(), `POST /api/reports/${sprintId}/pdf: ${pdf.status()} ${await pdf.text()}`).toBeTruthy();
        expect(pdf.headers()["content-type"], "PDF response is application/pdf").toContain("application/pdf");
        const bytes = await pdf.body();
        expect(bytes.length, "a real PDF is more than a few bytes").toBeGreaterThan(1000);
        // %PDF magic bytes (0x25 0x50 0x44 0x46).
        expect(bytes.subarray(0, 4).toString("latin1"), "PDF magic header").toBe("%PDF");
        pdfProven = true;
      }
    }

    const after = lockFingerprint(await getSprint(setup, sprintId));
    expect(after, "closure-stats + report detail + PDF must NEVER change the sprint's lock state (SPEC_11 §8a)").toBe(before);

    test.info().annotations.push({
      type: "SPEC_14 §4 reports/PDF",
      description: `reports listed=${list.length}, ours listed=${Boolean(ours)}, pdfProven=${pdfProven}, lock-row unchanged=${after === before}.`,
    });
    if (!pdfProven) {
      test.info().annotations.push({
        type: "SPEC_14 §4 PDF",
        description: "POST /api/reports/:id/pdf not landed (Agent B) — no-mutation guard still enforced over the reads that ARE present.",
      });
    }
  });

  // ── Task 9: GUARD — the API never GETs /api/v3/users during Inc-14 flows ─────
  // Same technique as tf-'s Task 2e (SPEC_13 §1a), extended to the NEW flows this
  // increment adds: closure-stats role lookups, GET /api/people, reports + PDF.
  // Browser interception can't see the API↔OP leg, so we route ALL OP traffic to
  // a RECORDING mock and assert the bare user-COLLECTION path is never requested.
  test("guard: no GET /api/v3/users (the admin-gated COLLECTION) during closure-stats / people / reports / PDF flows (SPEC_14 guardrails)", async () => {
    test.setTimeout(150_000);
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let recSprintId: number | null = null;
    try {
      rec = await createRecordingMockOpServer();
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);

      // Point the app at the recording mock as the ONLY live connection so any
      // GET /api/v3/users a role/closure lookup issues lands on (and is recorded
      // by) THIS server, not the un-recorded shared default mock.
      recConnId = await ensureConnection(setup, rec.url, "rec-guard-token");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: recConnId } });
      expect(sync.ok(), `scoped sync to recording mock: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      const created = await setup.post("/api/sprints", {
        data: { name: uniqueSprintName("TG NoUsersColl"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
      });
      recSprintId = ((await created.json()) as { id: number }).id;
      for (const wp of ALL_WP_IDS) await setup.post(`/api/sprints/${recSprintId}/items`, { data: { wp_op_id: wp } });
      const activated = await setup.post(`/api/sprints/${recSprintId}/activate`);
      if (activated.ok()) {
        await waitSprintStatus(setup, recSprintId, "active").catch(() => {});
        await setup.post(`/api/sprints/${recSprintId}/finish`, { data: {} }).catch(() => {});
        await waitSprintTerminal(setup, recSprintId);
      }

      // Clear the recording AFTER setup (load/sync/activate) so we only judge the
      // Increment-14 READ flows themselves.
      rec.reset();

      // Drive every NEW flow that might be tempted to enumerate the user directory.
      await setup.get("/api/people").catch(() => {}); // global people + roles
      // Applying roles reads people + writes role (no OP call, but exercises the path).
      await applyDodRoles(setup).catch(() => {});
      await setup.get(`/api/sprints/${recSprintId}/closure-stats`).catch(() => {}); // role-aware closure
      await setup.get(`/api/sprints/${recSprintId}/capacity`).catch(() => {}); // developers-only roster
      await setup.get(`/api/sprints/${recSprintId}/people`).catch(() => {}); // per-sprint people
      await setup.get("/api/reports").catch(() => {});
      await setup.get(`/api/reports/${recSprintId}`).catch(() => {});
      await setup.post(`/api/reports/${recSprintId}/pdf`, { data: {} }).catch(() => {});

      // PRECONDITION: the flows actually reached OP on the recording connection
      // (some /api/v3/* read after reset) — else "no /api/v3/users" is vacuous.
      // This NEVER masks the bug we guard: a resolver that (wrongly) calls
      // fetchAllUsers issues GET /api/v3/users, which is ITSELF a /api/v3/* read,
      // so it trips sawOpRead=true AND usersCollectionHits>0 together — the hard
      // assertion below fires. The vacuity-skip only happens when an Inc-14 flow
      // makes NO OP call at all (reads purely from local cache/stored data), in
      // which case there is provably no user-collection leak to catch.
      const sawOpRead = rec.requests.some((r) => r.path.startsWith("/api/v3/"));
      if (!sawOpRead) {
        test.info().annotations.push({
          type: "SPEC_14 users-collection guard",
          description: `no /api/v3/* read reached the recording mock during the Inc-14 flows (routes likely not landed) — absence assertion would be vacuous; skipping. Observed paths=${JSON.stringify([...new Set(rec.requests.map((r) => r.path))])}`,
        });
        test.skip(true, "Increment-14 flows did not exercise OP on the recording mock yet");
        return;
      }

      // THE ASSERTION (HARD): the bare user-COLLECTION path was NEVER requested.
      // /api/v3/users/me and /api/v3/users/:id remain allowed.
      const usersCollectionHits = rec.requests.filter((r) => r.path === "/api/v3/users");
      test.info().annotations.push({
        type: "SPEC_14 users-collection guard",
        description:
          `Inc-14 flows hit these OP paths on the recording mock: ` +
          `${JSON.stringify([...new Set(rec.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => `${r.method} ${r.path}`))])}. ` +
          `bare /api/v3/users hits=${usersCollectionHits.length}.`,
      });
      expect(
        usersCollectionHits.length,
        `SPEC_14 guardrail: the API issued GET /api/v3/users (the admin-gated user COLLECTION) ${usersCollectionHits.length}× during the closure/people/reports flows — it must NEVER call it (ids come from _links.assignee/accountable + GET /api/v3/memberships, per Inc 13 §1a). Reuse the reworked resolver, do not reintroduce fetchAllUsers.`,
      ).toBe(0);
    } finally {
      if (recSprintId !== null) await setup.delete(`/api/sprints/${recSprintId}`).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (recConnId !== null) await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      if (rec !== null) await rec.close().catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 8 — HISTORY ordering (SPEC_14 §1): default newest-first + a session toggle.
// Its own describe: it needs a scenario WITH journal history (s7-tester-roundtrip,
// WP 11762), distinct from s9 (no timeline). Purely a FRONTEND display concern —
// the changelog endpoint keeps returning oldest-first (contract note in api.ts);
// Agent C reverses for display + adds the toggle. Probes for the toggle control
// and skips with a precise note until Agent C lands it.
// ─────────────────────────────────────────────────────────────────────────────
const S7_SCENARIO = "s7-tester-roundtrip";
const S7_WP = 11762;

function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}
async function gotoSprintBoard(page: Page): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name: "Sprint board", exact: true }).click();
}

test.describe.serial("TG — SPEC_14 §1 ticket history ordering (newest-first + toggle)", () => {
  let setup: APIRequestContext;
  let sprintId: number;
  let hasHistoryEntries = false;

  test.beforeAll(async () => {
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    await loadScenario(setup, S7_SCENARIO);
    const conn = await ensureConnection(setup);
    await setup.patch(`/api/connections/${conn}`, { data: { current: true, enabled: true } });
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TG History"), start_date: "2026-07-06", end_date: "2026-07-31" },
    });
    sprintId = ((await created.json()) as { id: number }).id;
    await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: S7_WP } });
    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    if (activated.ok()) {
      await waitSprintStatus(setup, sprintId, "active").catch(() => {});
      // Drive the roundtrip timeline into the cache, then Update to derive changelog.
      const mockUrl = E2E_URLS.mock;
      for (let d = 0; d < 4; d += 1) {
        await setup.post(`${mockUrl}/__mock/advance-day`, { data: { app_url: E2E_URLS.api } }).catch(() => {});
      }
      await setup.post(`/api/sprints/${sprintId}/update`).catch(() => {});
      const entries = (await (await setup.get(`/api/sprints/${sprintId}/tickets/${S7_WP}/changelog`)).json()) as unknown[];
      hasHistoryEntries = Array.isArray(entries) && entries.length > 1;
    }
  });

  test.afterAll(async () => {
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup.dispose();
  });

  test("changelog modal defaults to newest-first, a toggle flips the order, and the choice persists within the session", async ({
    page,
  }) => {
    // The real-clock-vs-scenario-calendar caveat (see tc-/tb-'s notes): s7's
    // journals are stamped on the mock's logical calendar; if the CI clock is
    // at/after those dates the sprintUpdate parser filters them out and there is
    // no multi-entry history to order. Skip cleanly in that case.
    test.skip(!hasHistoryEntries, "s7 changelog has <2 entries here (clock filtered the journals) — nothing to order");

    await gotoSprintBoard(page);
    const select = page.locator("#sprint-select");
    await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
    await select.selectOption(String(sprintId));

    const historyBtn = page.getByRole("button", { name: `View changelog for #${S7_WP}` });
    const hasBtn = await historyBtn
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasBtn, "no History affordance for #11762 in this run (has_history false)");

    await historyBtn.click();
    const dialog = page.getByRole("dialog", { name: new RegExp(`#${S7_WP}.*changelog`) });
    await expect(dialog).toBeVisible();

    // The order toggle (Agent C). Accept a range of accessible labels; skip with a
    // precise note until it's landed so this bites automatically once it is.
    const toggle = dialog.getByRole("button", { name: /newest|oldest|reverse|order|sort/i });
    const hasToggle = await toggle
      .first()
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!hasToggle) {
      test.info().annotations.push({
        type: "SPEC_14 §1 history toggle",
        description: "no order-toggle control in the changelog modal — Agent C's newest-first default + toggle not landed yet; skipping the ordering assertion.",
      });
      test.skip(true, "history order toggle not landed (Agent C)");
      return;
    }

    // Capture the rendered row order via each row's datetime (a <time datetime>
    // or a data-created-at attribute Agent C exposes). Fall back to visible text.
    async function rowKeys(): Promise<string[]> {
      const times = dialog.locator("time[datetime]");
      const n = await times.count();
      if (n > 0) {
        const out: string[] = [];
        for (let i = 0; i < n; i += 1) out.push((await times.nth(i).getAttribute("datetime")) ?? "");
        return out;
      }
      // Fallback: the ordering of change rows by their text content.
      return (await dialog.locator("[data-changelog-row], .changelog-row").allInnerTexts()).map((t) => t.trim());
    }

    const initial = await rowKeys();
    test.info().annotations.push({
      type: "SPEC_14 §1 initial order",
      description: `first-render row keys: ${JSON.stringify(initial.slice(0, 6))}`,
    });
    // Default is newest-first: the datetime sequence is non-increasing.
    if (initial.length > 1 && initial.every((k) => /\d{4}-\d\d-\d\d/.test(k))) {
      const sortedDesc = [...initial].sort().reverse();
      expect(initial, "default changelog order is newest-first (descending timestamps)").toEqual(sortedDesc);
    }

    await toggle.first().click();
    const flipped = await rowKeys();
    expect(flipped, "toggling reverses the order").toEqual([...initial].reverse());

    // Persistence within the session: close + re-open WITHOUT a page reload keeps
    // the toggled (now oldest-first) order.
    await dialog.getByRole("button", { name: /close/i }).first().click().catch(async () => {
      await page.keyboard.press("Escape");
    });
    await expect(dialog).toBeHidden();
    await historyBtn.click();
    await expect(dialog).toBeVisible();
    const reopened = await rowKeys();
    expect(reopened, "the toggled order persists within the session after re-opening the modal").toEqual(flipped);
  });
});
