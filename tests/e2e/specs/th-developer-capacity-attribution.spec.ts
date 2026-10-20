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
import { advanceDay, ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";

/**
 * TH — Increment 15 (SPEC_15_Developer_Capacity_Attribution.md), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tf → tg → "th-…" lexicographic sequence, so
 * this spec runs LAST (Playwright runs spec files in filename order against ONE
 * shared backend). Do NOT rename to "t15".
 *
 * WHAT THIS FILE PROVES (SPEC_15 §7 Verification = this spec's DoD):
 *
 *   The two bugs SPEC_15 fixes (§1):
 *     (1) a developer who RECEIVES tickets mid-sprint and LOGS time shows an
 *         EMPTY capacity bar + PLANNED 0 (the "Jan Belka 19h → 0h" bug); should
 *         show RED `acquired_worked` segments totalling the estimate, PLANNED =
 *         estimate, accuracy a NUMBER (not "—").
 *     (2) DELIVERED is misattributed to whoever CURRENTLY holds a finished
 *         ticket instead of the developer who DID THE WORK (max-logged, with a
 *         status-transition tie-break). A ticket built by a developer and handed
 *         to a TESTER must credit the DEVELOPER, not the tester.
 *
 *   Task 1 — §0 real-DB TRIPWIRE (same pattern as te-/tf-/tg-): fingerprint the
 *     REAL apps/api/osp.sqlite at suite start and end; fail loudly if it moved
 *     (Increment-11 data-loss incident). No-ops (with a note) when absent.
 *   Task 2 — JAN BELKA (SPEC_15 §7 bullet 1 / §2 row 5 / §3): 3 NON-baseline
 *     tickets he logged time on ⇒ `acquired_worked` (RED) segments, Σ estimate
 *     15h (SPEC_16 §5 supersedes Inc 15's own 19h — see JAN_ESTIMATE below),
 *     Σ logged marker 17.5h; his bar is NOT empty; PLANNED 15h (NOT 0);
 *     accuracy_pct ≈ 117% (17.5/15), NON-null.
 *   Task 3 — ZBYNEK TRNKA (SPEC_15 §7 bullet 2 / §2 row 2 / §3): baseline
 *     ticket, estimate 30h, logged 46.5h, handed to a tester ⇒ `delivered`
 *     (GREEN) segment length 30h with a logged marker at 46.5h (overshoot
 *     visible past the segment); PLANNED 30h (explicitly NOT 46.5h — the
 *     planned≠logged invariant); delivered_hours 30h credited to ZBYNEK (NOT the
 *     tester); accuracy ≈ 155% (46.5/30); overshoot ≈ +16.5h.
 *   Task 4 — DELIVERED ATTRIBUTION (SPEC_15 §3 decision #2): a done ticket handed
 *     off credits the max-logged developer, never the current holder; the tester
 *     recipient never appears in per_developer at all (role-gating).
 *   Task 5 — the SEVEN §2 rows: every observed (developer × ticket) segment
 *     obeys the SPEC_15 §3 sign table (counts_to_planned + planned_delta sign per
 *     kind); row 2 (`delivered`, handed to tester) is GREEN=`delivered`, NOT
 *     grey=`redistributed`; row 3 (reassigned to another DEVELOPER) is grey=
 *     `redistributed`; and all seven kinds materialise across the fixture.
 *   Task 6 — ROW 6 vs ROW 3 DISTINCTNESS (SPEC_15 §4): `idle_unworked` must NOT
 *     collapse into the plain grey `redistributed` — distinct at the DATA layer
 *     (different kind, planned_delta 0, counts_to_planned false) AND, when Agent
 *     C's bar is landed, a visually distinct segment element (different
 *     data-segment-kind / class), not merely "some segment present".
 *   Task 7 — LOGGED MARKER (SPEC_15 §4): only `delivered`/`acquired_worked` carry
 *     show_logged_marker=true; the overshoot (Zbynek 46.5 logged vs 30 estimate)
 *     is represented (logged_hours > estimate_hours on that segment).
 *   Task 8 — DEDUPE (SPEC_15 §3): a ticket worked by two developers contributes
 *     its estimate ONCE to the sprint-wide PLANNED total, though it may appear as
 *     a segment on both bars; DELIVERED is credited to at most ONE developer.
 *   Task 9 — ROLE-GATING (SPEC_15 §2/§5): per_developer holds ONLY developers; a
 *     tester/customer never gets developer capacity segments (their committed
 *     hours still show as the plain grey non-developer CapacityLine, unchanged).
 *   Task 10 — GUARDRAILS (SPEC_15 §7): the API never issues GET /api/v3/users
 *     (the admin-gated COLLECTION) while computing closure-stats/capacity, driven
 *     against a RECORDING mock OP. HARD absence assertion; only prereqs skip.
 *
 * ── SEQUENCING (Agents A/B/C landing in parallel) ────────────────────────────
 * The CONTRACTS (packages/contracts) are FROZEN with the Increment-15 shapes:
 * DeveloperSegmentKind (7 values), DeveloperTicketSegment, DeveloperCapacityBreakdown
 * (planned_hours/logged_hours/delivered_hours/accuracy_pct/overshoot_hours/segments),
 * served on ClosureStatsResponse.per_developer. At the time this spec was
 * WRITTEN, Agent A's fixture (assumed `s10-developer-work-attribution`) and Agent
 * B's `developerSegments` engine are NOT landed — closure-stats.per_developer is
 * still the Increment-14 `DeveloperClosureBreakdown` (no `segments`/`delivered_hours`).
 * Every functional test therefore PROBES its precondition and test.skip()s with a
 * precise annotation when the piece isn't there, so the suite stays green while
 * the real assertions bite AUTOMATICALLY once each feature arrives (Phase 2
 * integration). The exact DoD numbers below are the acceptance target.
 *
 * ── FIXTURE ASSUMPTIONS (Agent A not landed) ─────────────────────────────────
 * See ASSUMPTIONS block below. If Agent A ships different scenario name / version
 * / holder names, Phase 2 reconciles those three constants; the numeric DoD
 * was originally 19h/17.5h/92%/30h/46.5h/155%/+16.5h verbatim from SPEC_15
 * §3/§7 — Jan's estimate figure (19h→15h, accuracy 92%→117%) was SUPERSEDED
 * during Increment 16 Phase 2 integration by SPEC_16 §5's effective-estimate
 * rule; see the JAN_ESTIMATE constant's comment for the exact mechanism.
 *
 * ── OSP_DB_PATH / PORT isolation (SPEC_15 §7 last bullet) ─────────────────────
 * NO new apps/api boot path: reuses tests/playwright.config.ts's webServer (which
 * already sets OSP_DB_PATH + PORT) and, for Task 10, only spins up ephemeral
 * RECORDING MOCK OP servers (port 0, no DB). Task 1's live tripwire is the
 * belt-and-braces proof this run never touched the real DB.
 *
 * GUARDRAIL (unchanged): nothing here issues a non-GET toward OP — the only
 * writes are to the app's own /api/* surface and the mock's /__mock/* admin API.
 */

// ── Phase 2 reconciliation: Agent A landed `s10-developer-work-attribution`
// (fixtures/scenarios/s10-developer-work-attribution.ts) on OP version "3.5.040"
// (NOT "3.5.039" — that's S9's Increment-14 story; S10 deliberately uses its own
// version to avoid colliding with it), same 2026-07-06..07-10 window. ─────────
const SCENARIO = "s10-developer-work-attribution";
const PROJECT_OP_ID = 3;
const SPRINT_VERSION = "3.5.040"; // the DoD sprint (SPEC_15 §7), reconciled to Agent A's actual fixture
const SPRINT_WINDOW = { start: "2026-07-06", end: "2026-07-10" } as const;

// The two developers named in SPEC_15 §3/§7's DoD prose are "Jan Belka" and
// "Zbynek Trnka" — but the FIXTURE uses "Zbyněk Kovář" for the second one
// (and "Marek Sova" for the tester recipient below), NOT the spec's literal
// names: "Zbynek Trnka"/"Arend Kuiper" already identify a DIFFERENT person
// in Increment 14's s9-role-closure fixture, sharing this same app DB across
// e2e spec files. Identity is the NAME (Inc 13) and materialization is
// GLOBAL, not scenario-scoped, so reusing those exact names here would
// split-brain PersonKey resolution between the logger path (real
// actor_op_id) and the assignee-interval path (name-only) — confirmed via
// Phase 2 integration testing (running tg-roles-closure-reports.spec.ts
// before this file reproduces the split; this file alone does not). The
// STORY and every NUMBER (30h/46.5h/155%/+16.5h) are unchanged from SPEC_15
// §7 — only these two display names differ, to stay collision-free.
const JAN = "Jan Belka";
const ZBYNEK = "Zbyněk Kovář";

// The fixture's full named cast (s10-developer-work-attribution.ts's own doc
// comment "Roles are NOT part of this fixture" block) — reconciled 1:1 with
// Agent A's actual NAMED_USERS. Petr Novák (row 1), Milan Černý/Ota Horák
// (row 3/6), Radek Dostál (row 4), Ivo Svoboda (row 7) round out the seven-row
// matrix; Marek Sova is the tester recipient of Zbyněk's handoff (row 2 must
// be GREEN `delivered`, not grey); Pavel Král is the customer baseline holder
// T5c starts with before Belka acquires it.
const ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: JAN, role: "developer" },
  { name: ZBYNEK, role: "developer" },
  { name: "Petr Novák", role: "developer" },
  { name: "Milan Černý", role: "developer" },
  { name: "Ota Horák", role: "developer" },
  { name: "Radek Dostál", role: "developer" },
  { name: "Ivo Svoboda", role: "developer" },
  { name: "Marek Sova", role: "tester" },
  { name: "Pavel Král", role: "customer" },
];

// The DoD numbers (SPEC_15 §3/§7). Jan's estimate is SUPERSEDED by Increment 16
// (SPEC_16 §5, "effective estimate = Remaining work when it's nonzero and
// differs from Work"): his mid-sprint-created ticket t5a (12005) is added with
// Work=Remaining=8h, but the SAME retro-replay day also logs 4h against it
// (remaining 8→4) before the add's `planned_hours` snapshot is captured — so
// its effective estimate is now 4h (Remaining), not 8h (Work), dropping his
// three-ticket sum from 19h (8+6+5, Increment 15's own figure) to 15h
// (4+6+5). Logged hours are unaffected (still 7+6+4.5=17.5h — logging isn't
// estimate-derived). Live-verified against an isolated scratch instance
// during Increment 16 Phase 2 integration.
const JAN_ESTIMATE = 15;
const JAN_LOGGED = 17.5;
const JAN_ACCURACY = (JAN_LOGGED / JAN_ESTIMATE) * 100; // ≈ 116.7%
const ZBYNEK_ESTIMATE = 30;
const ZBYNEK_LOGGED = 46.5;
const ZBYNEK_ACCURACY = (ZBYNEK_LOGGED / ZBYNEK_ESTIMATE) * 100; // ≈ 155%
const ZBYNEK_OVERSHOOT = ZBYNEK_LOGGED - ZBYNEK_ESTIMATE; // +16.5h

// ── v2 kind set + contribution/change tables (SPEC_17 §1, mirrors
// @osp/contracts — REPLACES SPEC_15's single signed table; the old kind names
// active/delivered/redistributed/removed_no_work/acquired_worked/
// idle_unworked/churned_away are GONE, renamed with a real semantic split.
// (Increment 17 briefly added a separate grey-hatched `baseline_idle` kind for
// a held-but-unlogged baseline ticket; Increment 26 ABOLISHED it and merged it
// back into the always-green `baseline_worked` — so this mirror is 6 kinds.)
// Reconciled during Increment 17/26 Phase 2 integration — see Agent D's report
// for the full old→new mapping this file was updated against. ─────────────
type DeveloperSegmentKind =
  | "baseline_worked"
  | "handoff"
  | "removed"
  | "acquired"
  | "idle"
  | "churned";
// ⚠️ CHANGED in Increment 30 (`docs/INCREMENT_30_CONTRACTS.md` §2a's table,
// `docs/CAPACITY_BAR_RULES.md` §5 + invariant 7). `Planned` is now CURRENT
// SCOPE, so the kinds a developer STILL HOLDS and that are STILL IN SCOPE —
// `baseline_worked`, `acquired`, `idle` — all contribute. `handoff` / `removed`
// / `churned` stay 0 because the ticket is no longer that developer's scope.
// `SEGMENT_CHANGE_SIGN` below is deliberately UNTOUCHED (§2a forbids it).
const SEGMENT_PLANNED_CONTRIBUTION: Record<DeveloperSegmentKind, 0 | 1> = {
  baseline_worked: 1,
  handoff: 0,
  removed: 0,
  acquired: 1,
  idle: 1,
  churned: 0,
};
const SEGMENT_CHANGE_SIGN: Record<DeveloperSegmentKind, -1 | 0 | 1> = {
  acquired: 1,
  removed: -1,
  baseline_worked: 0,
  handoff: 0,
  idle: 0,
  churned: 0,
};
const LOGGED_MARKER_KINDS: ReadonlySet<DeveloperSegmentKind> = new Set<DeveloperSegmentKind>([
  "baseline_worked",
  "acquired",
]);
const ALL_KINDS: readonly DeveloperSegmentKind[] = [
  "baseline_worked",
  "handoff",
  "removed",
  "acquired",
  "idle",
  "churned",
];
// s10-developer-work-attribution.ts (Increment 15's own fixture) exercises all
// six v2 kinds: every baseline developer in that story either logs (→
// baseline_worked) or loses the ticket entirely (→ handoff/removed), plus the
// acquire/idle/churn non-baseline rows. Increment 26 abolished the old
// grey-hatched `baseline_idle` row (a held-but-unlogged baseline ticket now
// merges into the always-green `baseline_worked`), so there is no longer a
// seventh kind to exclude — s10 covers the full 6-kind set.
const KINDS_COVERED_BY_S10: readonly DeveloperSegmentKind[] = ALL_KINDS;

// ── minimal contract subsets (mirrors tf-/tg-'s local-interface style) ────────
type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
type TicketDoneBucket = "done" | "not_done" | "rejected" | "ambiguous";

interface PersonSummary {
  id: number;
  op_user_id: number | null;
  name: string;
  role: PersonRole;
  ticket_count: number;
}
interface DeveloperTicketSegment {
  wp_op_id: number;
  subject: string;
  kind: DeveloperSegmentKind;
  estimate_hours: number | null;
  logged_hours: number;
  counts_to_planned: boolean;
  planned_delta_hours: number;
  counts_to_change: boolean;
  change_delta_hours: number;
  show_logged_marker: boolean;
  in_baseline: boolean;
  reason: string | null;
  current_holder_name: string | null;
  current_holder_role: PersonRole | null;
}
/** DeveloperCapacityBreakdown (SPEC_15) — superset of Inc-14's DeveloperClosureBreakdown. */
interface DeveloperCapacityBreakdown {
  member_id: number | null;
  op_user_id: number | null;
  name: string;
  planned_hours: number;
  logged_hours: number;
  delivered_estimate_hours: number; // deprecated alias == delivered_hours
  accuracy_pct: number | null;
  overshoot_hours: number;
  // Increment-15 additions:
  delivered_hours: number;
  segments: DeveloperTicketSegment[];
  // Increment-17 addition: the bar's signed second number ("±Change").
  scope_change_hours: number;
  // Increment-30 addition: Σ green (baseline) — exactly what `planned_hours`
  // meant before Increment 30, now separately labelled while `planned_hours`
  // became CURRENT SCOPE (CAPACITY_BAR_RULES §5).
  baseline_hours: number;
}
interface ClosureBucket {
  count: number;
  items: Array<{ wp_op_id: number; bucket: TicketDoneBucket }>;
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
  per_developer: DeveloperCapacityBreakdown[];
}
interface CapacityLine {
  member_id: number | null;
  name: string;
  available_hours: number;
  planned_hours: number;
  role: PersonRole;
  is_developer: boolean;
}
interface CapacityResponse {
  lines: CapacityLine[];
  total_available_hours: number;
  total_planned_hours: number;
}
interface SprintRow {
  id: number;
  name: string;
  status: string;
  is_locked?: boolean;
  is_retrospective?: boolean;
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
async function waitSprintTerminal(ctx: APIRequestContext, id: number, timeoutMs = 40_000): Promise<SprintRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getSprint(ctx, id);
    if (s && (s.status === "closed" || s.is_locked)) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function getPeople(ctx: APIRequestContext): Promise<PersonSummary[] | null> {
  const res = await ctx.get("/api/people");
  if (!res.ok()) return null;
  return (await res.json()) as PersonSummary[];
}
async function setRoleByName(ctx: APIRequestContext, name: string, role: PersonRole): Promise<"no-route" | "not-found" | "ok"> {
  const people = await getPeople(ctx);
  if (people === null) return "no-route";
  const person = people.find((p) => p.name === name);
  if (!person) return "not-found";
  const res = await ctx.put(`/api/people/${person.id}/role`, { data: { role } });
  if (notImplemented(res.status())) return "no-route";
  expect(res.ok(), `PUT /api/people/${person.id}/role (${name}=${role}): ${res.status()} ${await res.text()}`).toBeTruthy();
  return "ok";
}
/** Apply the assumed role set. false when the people/role route isn't landed. */
async function applyRoles(ctx: APIRequestContext): Promise<boolean> {
  for (const { name, role } of ROLES) {
    const r = await setRoleByName(ctx, name, role);
    if (r === "no-route") return false;
    // "not-found" tolerated per-name (person may not exist in Agent A's fixture).
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
function devByName(stats: ClosureStatsResponse, name: string): DeveloperCapacityBreakdown | undefined {
  return stats.per_developer.find((d) => d.name === name);
}
/** True when Agent B's Increment-15 engine has landed (segments present). */
function inc15Landed(stats: ClosureStatsResponse | null): boolean {
  return !!stats && stats.per_developer.length > 0 && Array.isArray(stats.per_developer[0]?.segments);
}
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// ── setup: build a CLOSED retrospective sprint 3.5.039 from Agent A's fixture ─
test.describe.serial("TH — SPEC_15 developer capacity attribution (real-work driven)", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let sprintId = 0;
  let dbBefore: DbFingerprint | null;
  /** True once the s10 scenario loaded AND the sprint reached a terminal state. */
  let sprintReady = false;
  /** Distinguishes "Agent A fixture missing" from later "Agent B engine missing". */
  let scenarioMissing = false;

  test.beforeAll(async () => {
    // Retro seed + day-by-day replay easily exceeds the 30s hook default — same
    // reason te-/tf-/tg- raise it for their retro-heavy setup.
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb(); // (Task 1) FIRST: fingerprint the real DB.

    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    // Load Agent A's fixture. A 404/failed load ⇒ not landed yet: mark missing so
    // every functional test below skips with a precise "fixture not found" note.
    try {
      await loadScenario(setup, SCENARIO);
    } catch (err) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TH] scenario "${SCENARIO}" not loadable (Agent A fixture not landed): ${String(err)}`);
      return;
    }

    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });

    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // s10's mock engine only reveals a timeline day's journals/time-entries once
    // the mock's clock has been advanced past it (fixtures/mock-op-server/engine.ts
    // gates applyDayEvents behind advance-day — day 0 applies on load, days 1-4
    // are gated). Reveal the whole 5-day timeline (reassigns, status transitions,
    // the day-2 version churn, all logged hours) BEFORE seeding/activating, same
    // convention as tf-/tg-'s multi-day retro setups.
    for (let day = 1; day <= 4; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api });
    }

    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TH 3.5.040"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    sprintId = ((await created.json()) as { id: number }).id;

    // Mark retrospective BEFORE seeding items: SPEC_15's fixture has PAST-dated
    // time entries (relative to the test's wall-clock now). A NORMAL activation
    // only derives time_logged changelog rows for spentOn >= the REAL activation
    // instant — the seeded entries would be silently dropped, zeroing logged
    // hours (the "real-clock-vs-scenario-calendar gotcha", project memory). Retro
    // mode replays from sprint.start_date on the scenario's own calendar, and it
    // is ALSO the mechanism that routes a mid-sprint / created-after-start ticket
    // as a red scope addition (SPEC_12/§13) — exactly what row 5 (acquired_worked)
    // relies on.
    const retro = await setup.patch(`/api/sprints/${sprintId}`, { data: { is_retrospective: true } });
    expect(retro.ok(), `mark retrospective: ${retro.status()} ${await retro.text()}`).toBeTruthy();

    // Seed the whole sprint from the OP version (fixture-id-agnostic). Fall back
    // to adding every project backlog ticket when retro/seed isn't available.
    let seeded = 0;
    const seed = await setup.post(`/api/sprints/${sprintId}/retro/seed`, {
      data: { kind: "version", value: SPRINT_VERSION },
    });
    if (seed.ok()) {
      const body = (await seed.json()) as { candidates?: unknown[] };
      seeded = Array.isArray(body.candidates) ? body.candidates.length : 0;
    }
    if (seeded === 0) {
      const backlogRes = await setup.get(`/api/backlog?projectId=${PROJECT_OP_ID}`);
      if (backlogRes.ok()) {
        const backlog = (await backlogRes.json()) as Array<{ op_id: number }>;
        for (const wp of backlog) {
          await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp.op_id } }).catch(() => {});
          seeded += 1;
        }
      }
    }
    // No items ⇒ the fixture didn't materialise the expected tickets; leave
    // sprintReady=false so tests skip with a clear note rather than false-fail.
    if (seeded === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[TH] scenario "${SCENARIO}" loaded but produced 0 sprint items — Agent A fixture shape differs.`);
      return;
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
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup?.dispose();

    // (Task 1) LAST: the real apps/api/osp.sqlite must be byte-identical.
    const dbAfter = fingerprintRealDb();
    if (dbBefore === null || dbAfter === null) {
      // eslint-disable-next-line no-console
      console.warn(`[§0 tripwire] ${REAL_DB} absent — nothing to compare (invariant holds vacuously).`);
      return;
    }
    if (dbAfter.size !== dbBefore.size || dbAfter.mtimeMs !== dbBefore.mtimeMs) {
      throw new Error(
        `[§0 TRIPWIRE FAILED] ${REAL_DB} changed during the e2e run — ` +
          `before=${JSON.stringify(dbBefore)} after=${JSON.stringify(dbAfter)}. This is the Increment-11 incident: ` +
          `the suite must ONLY ever touch its throwaway temp DB (tests/playwright.config.ts).`,
      );
    }
  });

  /** Shared precondition for every functional test: fixture + engine landed. */
  async function statsOrSkip(): Promise<ClosureStatsResponse> {
    test.skip(scenarioMissing, `Agent A fixture "${SCENARIO}" not landed (scenario 404) — Phase 2 wires this up.`);
    test.skip(!sprintReady, `s10 sprint could not be created/activated/finished (routes unavailable or 0 items).`);
    const rolesOk = await applyRoles(setup);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed (Agent B).");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B).");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;
    test.skip(
      !inc15Landed(s),
      "closure-stats.per_developer has no `segments` — Agent B's Increment-15 developerSegments engine not landed yet.",
    );
    return s;
  }

  // ── Task 1: §0 tripwire armed ───────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_15 §7 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present in this sandbox — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── Task 2: JAN BELKA — the empty-bar / PLANNED-0 bug is fixed ───────────────
  // Numbers per Increment 16 (SPEC_16 §5 effective-estimate supersedes Inc 15's
  // own 19h/92% figures — see the JAN_ESTIMATE comment above for why) AND
  // Increment 17 (SPEC_17 §1 v2 model): a NOT-in-baseline ticket a developer
  // logged on is now `acquired` (renamed from `acquired_worked`), and
  // `acquired` counts to the bar's SECOND number (signed Change), NEVER the
  // first (Planned) — Planned is now STRUCTURALLY reserved for baseline-only
  // segments (BUG 2's fix). So Jan's headline figure moves from "PLANNED 19h"
  // (Inc 15) → "PLANNED 15h" (Inc 16) → **"PLANNED 0h, Change +15h"** (Inc 17)
  // — his bar is still NOT empty (Change carries his real work), it's just a
  // DIFFERENT number now that correctly reflects "he has zero RETAINED
  // baseline work, but gained 15h of scope he actually did."
  // ⚠️ CHANGED AGAIN in Increment 30 (contracts §2a / CAPACITY_BAR_RULES §5 +
  // invariant 7): `Planned` is now CURRENT SCOPE, so the three tickets Jan
  // actually holds DO count. His headline moves once more:
  //   "PLANNED 19h" (Inc 15) → "PLANNED 15h" (Inc 16) → "PLANNED 0h / Change
  //   +15h" (Inc 17) → **"PLANNED 15h / Change +15h"** (Inc 30).
  // Recomputed by hand, not renamed: Planned = Σ effectiveEstimate of the three
  // acquired tickets = JAN_ESTIMATE = 15 h; Change is unchanged at +15 h. That
  // the two are now EQUAL for Jan is not a bug — it is precisely why invariant 9
  // forbids adding them (30 h is nobody's scope); `Baseline (0) + Change (+15)`
  // is the composition that balances.
  test("Jan Belka: 3 non-baseline tickets he logged on ⇒ RED acquired segments Σ15h + 17.5h logged marker; Planned 15h (current scope, Inc 30) with Baseline 0h and Change +15h; accuracy ≈117% (not '—')", async () => {
    const s = await statsOrSkip();
    const jan = devByName(s, JAN);
    expect(jan, `${JAN} must appear in per_developer (his bar must NOT be empty — SPEC_15 §1 bug)`).toBeTruthy();
    const d = jan as DeveloperCapacityBreakdown;

    const acquired = d.segments.filter((seg) => seg.kind === "acquired");
    test.info().annotations.push({
      type: "SPEC_17 §1 Jan Belka",
      description:
        `segments=${JSON.stringify(d.segments.map((x) => ({ wp: x.wp_op_id, kind: x.kind, est: x.estimate_hours, logged: x.logged_hours })))} ` +
        `planned=${d.planned_hours} scope_change=${d.scope_change_hours} accuracy=${d.accuracy_pct}`,
    });

    // Row e: NOT in baseline + logged > 0 ⇒ acquired (RED), 3 of them.
    expect(acquired.length, "Jan holds 3 acquired (mid-sprint received + logged) tickets").toBe(3);
    for (const seg of acquired) {
      expect(seg.in_baseline, "an acquired ticket is NOT in the baseline").toBe(false);
      expect(seg.show_logged_marker, "acquired carries a logged marker (SPEC_17 §1)").toBe(true);
      // Increment 30 §2a: `acquired` IS current scope, so it counts to Planned —
      // AND (unchanged from Increment 17) to Change. Both, deliberately.
      expect(seg.counts_to_planned, "acquired counts to Planned (Increment 30 §2a)").toBe(true);
      expect(seg.counts_to_change, "acquired counts to Change (+estimate)").toBe(true);
      expect(seg.change_delta_hours, "acquired's change_delta is positive (+estimate)").toBeGreaterThan(0);
    }
    // Bar LENGTH = Σ effective estimate = 15h (SPEC_16 §5 remaining-work
    // preference on t5a); logged marker Σ = 17.5h.
    expect(sum(acquired.map((x) => x.estimate_hours ?? 0)), "Σ acquired estimate = 15h").toBeCloseTo(JAN_ESTIMATE, 3);
    expect(sum(acquired.map((x) => x.logged_hours)), "Σ acquired logged = 17.5h").toBeCloseTo(JAN_LOGGED, 3);

    // Increment 30: Jan's PLANNED is 15h — the three acquired tickets are his
    // CURRENT scope. His BASELINE is 0h (he never held anything at the anchor),
    // and that separately-labelled figure is what SPEC_17 used to call Planned.
    expect(d.planned_hours, "Jan's Planned is 15h — current scope (CAPACITY_BAR_RULES §5, Inc 30)").toBeCloseTo(
      JAN_ESTIMATE,
      3,
    );
    expect(d.baseline_hours, "Jan's Baseline is 0h — he has no RETAINED baseline work").toBeCloseTo(0, 3);
    expect(d.scope_change_hours, "Jan's Change is +15h — his bar is NOT empty (SPEC_15 §1 bug, now tracked via Change)").toBeCloseTo(
      JAN_ESTIMATE,
      3,
    );
    // Invariant 9, live: the two are equal here, and adding them (30h) would be
    // a double count. `Baseline + Change` is the composition that balances.
    expect(d.baseline_hours + d.scope_change_hours, "Baseline + Change == Planned").toBeCloseTo(
      d.planned_hours,
      3,
    );
    // accuracy is a NUMBER (~117%), never "—" — unaffected by the Planned/Change
    // split, since DELIVERED attribution is a separate computation (Inc 15).
    expect(d.accuracy_pct, "Jan's accuracy is a number, not null/'—'").not.toBeNull();
    expect(d.accuracy_pct as number, "Jan accuracy ≈ 117% (17.5/15)").toBeCloseTo(JAN_ACCURACY, 0);
  });

  // ── Task 3: ZBYNEK TRNKA — baseline_worked green + logged marker, planned≠logged ─
  test("Zbynek Trnka: baseline 30h, logged 46.5h, handed to a tester ⇒ GREEN baseline_worked 30h + 46.5h marker (overshoot); BASELINE 30h (NOT 46.5) but PLANNED 0h since Inc 30 (the ticket is the tester's now); delivered 30h to Zbynek; accuracy ≈155%; overshoot +16.5h", async () => {
    const s = await statsOrSkip();
    const zbynek = devByName(s, ZBYNEK);
    expect(zbynek, `${ZBYNEK} must appear in per_developer with a non-empty bar`).toBeTruthy();
    const d = zbynek as DeveloperCapacityBreakdown;

    const delivered = d.segments.find((seg) => seg.kind === "baseline_worked");
    test.info().annotations.push({
      type: "SPEC_17 §1 Zbynek Trnka",
      description:
        `segments=${JSON.stringify(d.segments.map((x) => ({ wp: x.wp_op_id, kind: x.kind, est: x.estimate_hours, logged: x.logged_hours })))} ` +
        `planned=${d.planned_hours} delivered=${d.delivered_hours} accuracy=${d.accuracy_pct} overshoot=${d.overshoot_hours}`,
    });

    // Row a: baseline + logged, final holder is a TESTER (not another
    // developer) ⇒ baseline_worked (GREEN, NOT handoff — handoff is reserved
    // for baseline→ANOTHER DEVELOPER, SPEC_17 §1 row c).
    expect(delivered, "Zbynek's baseline handed-to-tester ticket is a `baseline_worked` (green) segment").toBeTruthy();
    const seg = delivered as DeveloperTicketSegment;
    expect(seg.in_baseline, "the baseline_worked ticket WAS in the baseline").toBe(true);
    expect(seg.kind, "handing to a tester/customer is GREEN `baseline_worked`, NOT blue-hatched `handoff` (SPEC_17 §1/§7 #1)").toBe(
      "baseline_worked",
    );
    // Bar LENGTH = estimate (30), marker = logged reality (46.5) — the overshoot
    // extends past the segment ("délka baru = odhad, marker = realita").
    expect(seg.estimate_hours, "baseline_worked bar length = estimate 30h").toBeCloseTo(ZBYNEK_ESTIMATE, 3);
    expect(seg.logged_hours, "logged marker = 46.5h").toBeCloseTo(ZBYNEK_LOGGED, 3);
    expect(seg.show_logged_marker, "baseline_worked carries a logged marker").toBe(true);
    expect(seg.logged_hours, "overshoot is visible: logged (46.5) > estimate (30)").toBeGreaterThan(seg.estimate_hours ?? 0);
    // The handoff recipient is a tester (blue/green tooltip data), not a developer.
    if (seg.current_holder_role !== null) {
      expect(seg.current_holder_role, "the current holder (recipient) is NOT a developer").not.toBe("developer");
    }

    // The "bar length is the ESTIMATE, never the logged time" invariant — the
    // real subject of this block. It lives on the SEGMENT and on `baseline_hours`.
    // ⚠️ UPDATED by contracts §2c. This asserted `true`/+30 while the block was
    // written against §2a's KIND-based table. §2c derives the flag from the
    // CURRENT HOLDER instead: the ticket is the tester's now, so it is not
    // Zbynek's current scope and it annotates 0 — matching his `planned_hours`
    // of 0 asserted below. The kind is still `baseline_worked` and the bar is
    // still 30 h long (`estimate_hours`), which is what this block is really
    // about: bar length = estimate, never logged time.
    expect(seg.counts_to_planned, "handed to a tester → NOT Zbynek's current scope (§2c)").toBe(false);
    expect(seg.planned_delta_hours, "…so it annotates 0, even though the bar is still 30 h long").toBeCloseTo(0, 3);
    expect(seg.estimate_hours, "bar length is still the ESTIMATE (30), NOT the logged 46.5").toBeCloseTo(ZBYNEK_ESTIMATE, 3);
    expect(seg.counts_to_change, "baseline_worked does NOT count to Change (SPEC_17 §1)").toBe(false);
    expect(d.baseline_hours, "Zbynek's BASELINE is 30h (NOT 46.5h) — baseline≠logged").toBeCloseTo(ZBYNEK_ESTIMATE, 3);

    // ⚠️ CHANGED in Increment 30, and a MEASURED Phase-2 finding worth naming.
    // `planned_hours` is now CURRENT SCOPE — "what is this developer on the hook
    // for right now" — and Zbyněk's ticket is the TESTER's now. So his canonical
    // Planned is 0 even though his green `baseline_worked` segment still reports
    // `counts_to_planned` true and `planned_delta_hours` 30.
    //
    // 🔴 That is an INTERNAL INCONSISTENCY in the DTO, not a fixture quirk: the
    // number and the bar disagree for the same developer — the very class of
    // defect `docs/INCREMENT_30_CONTRACTS.md` §0b set out to remove. It is the
    // same root cause as §2b(iii)'s multi-hop residual, generalised: segment
    // KINDS are decided by "who held it at the anchor and did they log", while
    // canonical Planned is decided by "who holds it now", so no kind-based sum
    // can reproduce it. Per §2 the canonical value wins for anything displayed
    // as Planned; this asserts the measured behaviour so it cannot regress
    // silently and cannot be rediscovered as new.
    expect(
      d.planned_hours,
      "Zbynek's PLANNED is 0h — the ticket is the tester's now (Increment 30 current-scope rule)",
    ).toBeCloseTo(0, 3);

    // DELIVERED credited to ZBYNEK (who did the work), NOT the tester holder.
    expect(d.delivered_hours, "Zbynek delivered 30h (attributed to him, not the tester)").toBeCloseTo(ZBYNEK_ESTIMATE, 3);
    expect(d.delivered_estimate_hours, "deprecated alias delivered_estimate_hours == delivered_hours").toBeCloseTo(
      d.delivered_hours,
      3,
    );
    // accuracy ≈ 155%, overshoot ≈ +16.5h.
    expect(d.accuracy_pct, "Zbynek accuracy is a number, not '—'").not.toBeNull();
    expect(d.accuracy_pct as number, "Zbynek accuracy ≈ 155% (46.5/30)").toBeCloseTo(ZBYNEK_ACCURACY, 0);
    expect(d.overshoot_hours, "Zbynek overshoot ≈ +16.5h (46.5 − 30)").toBeCloseTo(ZBYNEK_OVERSHOOT, 1);
  });

  // ── Task 4: DELIVERED attribution by work, not current holder ────────────────
  test("DELIVERED is attributed to the max-logged developer, never the current holder; the tester recipient is absent from per_developer (role-gating)", async () => {
    const s = await statsOrSkip();

    // Zbynek's handed-off-to-tester ticket credits ZBYNEK.
    const zbynek = devByName(s, ZBYNEK);
    expect(zbynek?.delivered_hours, `${ZBYNEK} keeps DELIVERED credit for the ticket he built + handed off`).toBeGreaterThan(0);

    // The tester recipient(s) never appear as a developer breakdown at all.
    const devNames = new Set(s.per_developer.map((d) => d.name));
    for (const { name, role } of ROLES) {
      if (role !== "developer") {
        expect(devNames.has(name), `${name} (role ${role}) must NOT appear in per_developer (developers only)`).toBe(false);
      }
    }

    // Every done ticket is credited to at MOST one developer (dedupe): sum of
    // per-developer delivered_hours must not double-count a ticket. We assert
    // the weaker, robust invariant that each dev's delivered_hours equals the
    // Σ estimate of the baseline_worked/acquired (i.e. logged, done-eligible)
    // segments they OWN the DELIVERED credit for — i.e. delivered_hours never
    // exceeds their own segment estimates.
    for (const d of s.per_developer) {
      const ownDeliverableEstimate = sum(
        d.segments.filter((x) => x.kind === "baseline_worked" || x.kind === "acquired").map((x) => x.estimate_hours ?? 0),
      );
      expect(
        d.delivered_hours,
        `${d.name}'s delivered_hours (${d.delivered_hours}) cannot exceed the estimate of the tickets they worked (${ownDeliverableEstimate})`,
      ).toBeLessThanOrEqual(ownDeliverableEstimate + 1e-6);
    }
  });

  // ── Task 5: the v2 §1 rows s10 covers — two-table structural integrity ───────
  test("every observed segment obeys the contribution/change tables (Increment 30 §2a: `acquired` now counts to BOTH Planned and Change); baseline_worked≠handoff, handoff is blue-hatched not grey", async () => {
    const s = await statsOrSkip();
    const allSegments = s.per_developer.flatMap((d) => d.segments);
    expect(allSegments.length, "some developer segments exist").toBeGreaterThan(0);

    // Structural integrity: EVERY segment matches the frozen two-table split
    // (BUG 2's fix — Planned and Change are separate channels, never combined).
    for (const seg of allSegments) {
      const plannedContribution = SEGMENT_PLANNED_CONTRIBUTION[seg.kind];
      const changeSign = SEGMENT_CHANGE_SIGN[seg.kind];
      // ⚠️ UPDATED by contracts §2c: `counts_to_planned` is derived from the
      // CURRENT HOLDER, not from the kind, so the table is no longer an equality
      // — two segments of the same kind differ depending on who holds the ticket
      // now. It survives as an UPPER BOUND: current scope implies a kind marked
      // 1, so a kind marked 0 can never count.
      if (plannedContribution === 0) {
        expect(
          seg.counts_to_planned,
          `${seg.kind}#${seg.wp_op_id}: contribution 0 is an upper bound — can never be current scope`,
        ).toBe(false);
      }
      expect(
        seg.planned_delta_hours,
        `${seg.kind}#${seg.wp_op_id}: planned_delta == counts_to_planned × estimate(${seg.estimate_hours}) — NEVER negative`,
      ).toBeCloseTo(seg.counts_to_planned ? (seg.estimate_hours ?? 0) : 0, 3);
      expect(seg.planned_delta_hours, `${seg.kind}#${seg.wp_op_id}: Planned is structurally >= 0 (BUG 2 fix)`).toBeGreaterThanOrEqual(-1e-9);
      expect(seg.counts_to_change, `${seg.kind}#${seg.wp_op_id}: counts_to_change == (sign !== 0)`).toBe(changeSign !== 0);
      expect(
        seg.change_delta_hours,
        `${seg.kind}#${seg.wp_op_id}: change_delta == sign(${changeSign}) × estimate(${seg.estimate_hours})`,
      ).toBeCloseTo(changeSign * (seg.estimate_hours ?? 0), 3);
      // ⚠️ CHANGED in Increment 30 (contracts §2a): a segment CAN now contribute
      // to both numbers — `acquired` is current scope (Planned) AND a
      // post-activation gain (+Change). The old "never both" rule was an
      // artefact of Planned meaning "retained baseline", and its disappearance
      // is exactly what invariant 9 exists to guard: because the two channels
      // now overlap, `Planned + ±Change` double-counts and must never be shown.
      // `acquired` is the ONLY kind that may sit in both.
      if (seg.counts_to_planned && seg.counts_to_change) {
        expect(
          seg.kind,
          `${seg.kind}#${seg.wp_op_id}: only \`acquired\` may count to BOTH Planned and Change`,
        ).toBe("acquired");
      }
      expect(seg.show_logged_marker, `${seg.kind}#${seg.wp_op_id}: show_logged_marker == kind ∈ {baseline_worked, acquired}`).toBe(
        LOGGED_MARKER_KINDS.has(seg.kind),
      );
    }

    // Row a GREEN not blue-hatched: at least one `baseline_worked` handed to a non-developer.
    const workedToNonDev = allSegments.filter(
      (x) => x.kind === "baseline_worked" && x.current_holder_role !== null && x.current_holder_role !== "developer",
    );
    expect(workedToNonDev.length, "a dev-built ticket handed to a tester/customer is GREEN `baseline_worked` (SPEC_17 §1/§7 #1)").toBeGreaterThan(0);

    // Row c: at least one `handoff` whose recipient IS another developer —
    // v2 (BUG 2 fix): handoff contributes 0 to BOTH Planned and Change (its
    // estimate is credited on the RECEIVING developer's own `acquired`
    // segment instead, never subtracted here).
    const handoff = allSegments.filter((x) => x.kind === "handoff");
    expect(handoff.length, "a ticket reassigned to another developer is blue-hatched `handoff` (row c)").toBeGreaterThan(0);
    for (const seg of handoff) {
      expect(seg.counts_to_planned, "handoff does NOT count to Planned (SPEC_17 §1/§7 #1 — not a subtraction)").toBe(false);
      expect(seg.counts_to_change, "handoff does NOT count to Change either (credited on the receiver's own segment)").toBe(false);
      expect(seg.planned_delta_hours, "handoff's planned_delta is 0").toBeCloseTo(0, 6);
      expect(seg.change_delta_hours, "handoff's change_delta is 0").toBeCloseTo(0, 6);
    }

    // The full 6-kind v2 matrix s10 covers materialises (Increment 26 abolished
    // the old baseline_idle row — merged into baseline_worked; see
    // KINDS_COVERED_BY_S10's doc).
    const observed = new Set(allSegments.map((x) => x.kind));
    test.info().annotations.push({
      type: "SPEC_17 §1 row coverage (s10 subset)",
      description: `observed kinds: ${JSON.stringify([...observed])} (target: all of ${JSON.stringify(KINDS_COVERED_BY_S10)})`,
    });
    for (const kind of KINDS_COVERED_BY_S10) {
      expect(observed.has(kind), `SPEC_17 §1 row for kind "${kind}" must materialise in the s10 fixture`).toBe(true);
    }
  });

  // ── Task 6: `idle` (row f) is DISTINCT from `handoff` (row c) — §4 ───────────
  // ⚠️ Increment 30 (contracts §2a) SEPARATED these two numerically as well:
  // `idle` is work the developer STILL HOLDS, so it now counts to Planned,
  // while `handoff` left their hands and stays 0/0. They used to share an
  // identical 0/0 signature — the exact conflation risk SPEC_17 §1/§7 #2 warned
  // about — and the numbers now distinguish them on their own. The VISUAL
  // distinctness requirement is unchanged and still checked below. s10 has
  // BOTH: Ota Horák (idle, on the ticket Milan Černý's is `handoff` for).
  test("idle (row f) is distinct from handoff (row c): since Increment 30 `idle` counts to Planned (still-held scope) while `handoff` is 0/0 — and the two stay visually distinct", async ({
    page,
  }) => {
    const s = await statsOrSkip();
    const allSegments = s.per_developer.flatMap((d) => d.segments);
    const idle = allSegments.filter((x) => x.kind === "idle");
    const handoff = allSegments.filter((x) => x.kind === "handoff");
    expect(idle.length, "the fixture has an idle (non-baseline, unworked, still held) ticket").toBeGreaterThan(0);
    expect(handoff.length, "the fixture has a handoff (baseline, given to another developer) ticket").toBeGreaterThan(0);

    // DATA-layer (Increment 30 §2a): `idle` is still-held scope, so it counts
    // to Planned at its full estimate while contributing nothing to Change.
    // `handoff` left the developer's hands and contributes to neither. Their
    // numeric signatures now DIFFER — but the kind strings were always the
    // authoritative distinction, and remain so.
    for (const seg of idle) {
      expect(seg.kind, "idle is its own kind, not folded into handoff").toBe("idle");
      expect(seg.counts_to_planned, "idle IS current scope (Increment 30 §2a)").toBe(true);
      expect(seg.counts_to_change, "idle is not a post-activation gain (±Change untouched)").toBe(false);
      expect(seg.planned_delta_hours, "idle contributes its full estimate to Planned").toBeCloseTo(
        seg.estimate_hours ?? 0,
        6,
      );
      expect(seg.change_delta_hours, "idle contributes 0 to Change").toBeCloseTo(0, 6);
    }
    for (const seg of handoff) {
      expect(seg.counts_to_planned, "handoff left this developer's scope entirely").toBe(false);
      expect(seg.counts_to_change, "…and is not a Change at the sender either").toBe(false);
    }

    // VISUAL distinctness (Agent C): the two kinds must render as visibly
    // different segment elements — a distinct data-segment-kind / class, not
    // just "some segment present" (SPEC_17 §1/§7 #2: three hatches, three
    // meanings — must not collapse).
    await page.goto("/");
    const idleEl = page.locator('[data-segment-kind="idle"]').first();
    const handoffEl = page.locator('[data-segment-kind="handoff"]').first();
    const idleVisible = await idleEl.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
    if (!idleVisible) {
      test.info().annotations.push({
        type: "SPEC_17 §1/§7 #2 visual distinctness",
        description:
          "no [data-segment-kind] capacity-bar markup found — Agent C's developer capacity bar not landed; data-layer distinctness proven, skipping the visual check.",
      });
      test.skip(true, "Agent C capacity-bar rendering not landed");
      return;
    }
    const idleClass = (await idleEl.getAttribute("class")) ?? "";
    const handoffPresent = await handoffEl.count();
    if (handoffPresent > 0) {
      const handoffClass = (await handoffEl.getAttribute("class")) ?? "";
      expect(idleClass, "idle and handoff render with DIFFERENT classes (orange-hatched vs blue-hatched, must not collapse)").not.toBe(
        handoffClass,
      );
    }
  });

  // ── Task 7: logged marker only on baseline_worked/acquired; overshoot shown ─
  test("only baseline_worked/acquired carry a logged marker; the marker shows real hours (Zbynek's overshoot logged 46.5 > estimate 30)", async () => {
    const s = await statsOrSkip();
    for (const seg of s.per_developer.flatMap((d) => d.segments)) {
      expect(seg.show_logged_marker, `show_logged_marker for ${seg.kind} matches the frozen set`).toBe(
        LOGGED_MARKER_KINDS.has(seg.kind),
      );
    }
    const zbynekDelivered = devByName(s, ZBYNEK)?.segments.find((x) => x.kind === "baseline_worked");
    expect(zbynekDelivered?.logged_hours, "Zbynek's logged marker exceeds his estimate (overshoot visible)").toBeGreaterThan(
      zbynekDelivered?.estimate_hours ?? 0,
    );
  });

  // ── Task 8: dedupe, and the Closure/Capacity parity ─────────────────────────
  // ⚠️ REWRITTEN in Increment 30. SPEC_17's argument was "only `baseline_worked`
  // counts to Planned, and a ticket has exactly ONE baseline holder, therefore
  // no ticket can be counted twice". §2a made `acquired` and `idle` count too,
  // and `acquired` is per-developer-who-held-and-logged — so on a MULTI-HOP
  // handoff (A→B→C, which s12 has) BOTH B and C carry an `acquired` segment for
  // the same ticket and the segment-level flag is true twice. That is precisely
  // `docs/INCREMENT_30_CONTRACTS.md` §2b(iii), measured — and precisely why §2
  // makes the canonical current-scope computation authoritative and the segment
  // field purely presentational. The de-dup guarantee therefore moves from the
  // SEGMENT flag to the NUMBERS, which is where it was always needed.
  test("dedupe holds at the NUMBERS: total_planned_hours == Σ per_developer[].planned_hours exactly, even where a multi-hop handoff flags counts_to_planned on two developers (contracts §2b(iii))", async () => {
    const s = await statsOrSkip();

    // MEASURED, recorded rather than asserted-away: which tickets carry
    // counts_to_planned on more than one developer, and why.
    const plannedHoldersByWp = new Map<number, Set<string>>();
    for (const d of s.per_developer) {
      for (const seg of d.segments) {
        if (!seg.counts_to_planned) continue;
        const holders = plannedHoldersByWp.get(seg.wp_op_id) ?? new Set<string>();
        holders.add(d.name);
        plannedHoldersByWp.set(seg.wp_op_id, holders);
      }
    }
    const multi = [...plannedHoldersByWp.entries()].filter(([, h]) => h.size > 1);
    test.info().annotations.push({
      type: "INCREMENT_30_CONTRACTS §2b(iii) multi-hop planned flag",
      description: `tickets whose counts_to_planned is true on >1 developer: ${JSON.stringify(
        multi.map(([wp, h]) => ({ wp, devs: [...h] })),
      )} — a multi-hop handoff gives every hop an \`acquired\` segment. The segment sum is therefore NOT Planned; the canonical current-scope computation is.`,
    });
    // Only ever the change kinds can do this — a ticket still has exactly one
    // holder at the anchor, so `baseline_worked` can never appear twice.
    for (const [wp, holders] of multi) {
      const kinds = s.per_developer
        .filter((d) => holders.has(d.name))
        .flatMap((d) => d.segments.filter((x) => x.wp_op_id === wp && x.counts_to_planned).map((x) => x.kind));
      expect(
        kinds.filter((k) => k === "baseline_worked").length,
        `wp #${wp}: at most ONE developer can hold it at the baseline anchor`,
      ).toBeLessThanOrEqual(1);
    }

    // The de-dup that actually matters: the sprint-wide total is Σ of the
    // per-developer canonical values, exactly — no segment sum involved.
    const sumOfPerDev = sum(s.per_developer.map((d) => d.planned_hours));
    expect(
      s.total_planned_hours,
      "sprint-wide total_planned_hours == Σ per_developer[].planned_hours exactly (SPEC_17 §4a one computation)",
    ).toBeCloseTo(sumOfPerDev, 3);

    // A ticket CAN still legitimately appear as an `acquired` (Change-counting)
    // segment on more than one developer (e.g. two devs both log time on the
    // same non-baseline ticket) — that's fine, Change has no sprint-wide total
    // to double-count into.
    const acquiredHoldersByWp = new Map<number, Set<string>>();
    for (const d of s.per_developer) {
      for (const seg of d.segments) {
        if (seg.kind !== "acquired") continue;
        const holders = acquiredHoldersByWp.get(seg.wp_op_id) ?? new Set<string>();
        holders.add(d.name);
        acquiredHoldersByWp.set(seg.wp_op_id, holders);
      }
    }
    test.info().annotations.push({
      type: "SPEC_17 §1 acquired multi-holder (informative)",
      description: `tickets with >1 developer holding an \`acquired\` segment: ${JSON.stringify(
        [...acquiredHoldersByWp.entries()].filter(([, h]) => h.size > 1).map(([wp, h]) => ({ wp, devs: [...h] })),
      )} — legitimate, Change has no sprint-wide total to double-count.`,
    });
  });

  // ── Task 9: role-gating — developers only; testers/customers grey, excluded ──
  test("role-gating: per_developer holds ONLY developers; a tester/customer keeps a grey non-developer CapacityLine (is_developer=false) and never gets developer segments", async () => {
    const s = await statsOrSkip();

    // per_developer contains only developers.
    const people = (await getPeople(setup)) ?? [];
    const roleOf = new Map(people.map((p) => [p.name, p.role]));
    for (const d of s.per_developer) {
      const role = roleOf.get(d.name);
      // Unknown role (person not in the directory) is tolerated; a KNOWN role must be developer.
      if (role) expect(role, `${d.name} in per_developer must be a developer`).toBe("developer");
    }

    // Non-developers still appear on the plain capacity roster as grey lines.
    const cap = await getCapacity(setup, sprintId);
    if (cap && cap.lines.some((l) => typeof l.is_developer === "boolean")) {
      const nonDev = cap.lines.filter((l) => l.is_developer === false && l.member_id !== null);
      const devAvail = sum(cap.lines.filter((l) => l.is_developer).map((l) => l.available_hours));
      const devPlanned = sum(cap.lines.filter((l) => l.is_developer).map((l) => l.planned_hours));
      expect(cap.total_available_hours, "totals exclude non-developers (SPEC_14 §2 consequence #1, unchanged)").toBeCloseTo(
        devAvail,
        5,
      );
      // total_planned_hours sums is_developer lines PLUS the plain capacity
      // model's own pre-existing "unassigned bucket" (Inc 5/9, unrelated to
      // SPEC_15) — this fixture genuinely has unassigned items (t4/t6, rows
      // 4/7), so the total is developer-lines-planned PLUS that bucket, not
      // exactly equal to it. Assert the non-negative bucket relationship
      // rather than exact equality (which only held by coincidence in a
      // fixture with zero unassigned items).
      expect(
        cap.total_planned_hours,
        "totals exclude non-developers, i.e. total >= Σ(developer lines) with only a non-negative unassigned-bucket remainder",
      ).toBeGreaterThanOrEqual(devPlanned - 1e-6);
      // No non-developer name leaks into the developer breakdown.
      const devNames = new Set(s.per_developer.map((d) => d.name));
      for (const l of nonDev) {
        expect(devNames.has(l.name), `non-developer ${l.name} (${l.role}) must not have a developer breakdown`).toBe(false);
      }
    }
  });

  // ── Task 10: GUARD — no GET /api/v3/users during closure-stats/capacity ──────
  // Same technique as tg-'s Task 9 / tf-'s Task 2e: route ALL OP traffic to a
  // RECORDING mock and assert the bare user-COLLECTION path is never requested.
  test("guard: no GET /api/v3/users (admin-gated COLLECTION) while computing developer capacity / closure-stats (SPEC_15 §7)", async () => {
    test.skip(scenarioMissing, `Agent A fixture "${SCENARIO}" not landed — nothing to drive against the recording mock.`);
    test.setTimeout(150_000);
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let recSprintId: number | null = null;
    try {
      rec = await createRecordingMockOpServer();
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);
      // Reveal the full 5-day timeline on this ephemeral recording instance too
      // (same day-gating as the shared mock — see the beforeAll comment above).
      await setup.post(`${rec.url}/__mock/goto-day/4`);

      recConnId = await ensureConnection(setup, rec.url, "rec-guard-token");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: recConnId } });
      expect(sync.ok(), `scoped sync to recording mock: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      const created = await setup.post("/api/sprints", {
        data: { name: uniqueSprintName("TH NoUsersColl"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
      });
      recSprintId = ((await created.json()) as { id: number }).id;
      await setup.patch(`/api/sprints/${recSprintId}`, { data: { is_retrospective: true } }).catch(() => {});
      const seed = await setup.post(`/api/sprints/${recSprintId}/retro/seed`, {
        data: { kind: "version", value: SPRINT_VERSION },
      });
      if (!seed.ok()) {
        const backlogRes = await setup.get(`/api/backlog?projectId=${PROJECT_OP_ID}`);
        if (backlogRes.ok()) {
          for (const wp of (await backlogRes.json()) as Array<{ op_id: number }>) {
            await setup.post(`/api/sprints/${recSprintId}/items`, { data: { wp_op_id: wp.op_id } }).catch(() => {});
          }
        }
      }
      const activated = await setup.post(`/api/sprints/${recSprintId}/activate`);
      if (activated.ok()) {
        await waitSprintStatus(setup, recSprintId, "active").catch(() => {});
        await setup.post(`/api/sprints/${recSprintId}/finish`, { data: {} }).catch(() => {});
        await waitSprintTerminal(setup, recSprintId);
      }

      // Judge only the Increment-15 READ flows: clear the recording after setup.
      rec.reset();
      await setup.get("/api/people").catch(() => {});
      await applyRoles(setup).catch(() => {});
      await setup.get(`/api/sprints/${recSprintId}/closure-stats`).catch(() => {}); // developer capacity + segments
      await setup.get(`/api/sprints/${recSprintId}/capacity`).catch(() => {});
      await setup.get(`/api/sprints/${recSprintId}/people`).catch(() => {});

      // PRECONDITION: the flows actually reached OP (some /api/v3/* read) — else
      // "no /api/v3/users" is vacuous. A resolver that wrongly calls fetchAllUsers
      // hits /api/v3/users, itself a /api/v3/* read, so it trips sawOpRead=true AND
      // usersCollectionHits>0 together — the hard assertion below fires.
      const sawOpRead = rec.requests.some((r) => r.path.startsWith("/api/v3/"));
      if (!sawOpRead) {
        test.info().annotations.push({
          type: "SPEC_15 users-collection guard",
          description: `no /api/v3/* read reached the recording mock during the Inc-15 flows (routes likely not landed) — absence assertion vacuous; skipping. Observed=${JSON.stringify([...new Set(rec.requests.map((r) => r.path))])}`,
        });
        test.skip(true, "Increment-15 flows did not exercise OP on the recording mock yet");
        return;
      }

      const usersCollectionHits = rec.requests.filter((r) => r.path === "/api/v3/users");
      test.info().annotations.push({
        type: "SPEC_15 users-collection guard",
        description:
          `Inc-15 flows hit these OP paths: ${JSON.stringify([...new Set(rec.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => `${r.method} ${r.path}`))])}. ` +
          `bare /api/v3/users hits=${usersCollectionHits.length}.`,
      });
      expect(
        usersCollectionHits.length,
        `SPEC_15 guardrail: the API issued GET /api/v3/users (the admin-gated user COLLECTION) ${usersCollectionHits.length}× while computing developer capacity — it must NEVER call it (ids come from _links.assignee/accountable + GET /api/v3/memberships, Inc 13 §1a).`,
      ).toBe(0);
    } finally {
      if (recSprintId !== null) await setup.delete(`/api/sprints/${recSprintId}`).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (recConnId !== null) await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      if (rec !== null) await rec.close().catch(() => {});
    }
  });
});
