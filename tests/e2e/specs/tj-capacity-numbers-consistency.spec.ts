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
import { advanceDay, ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";

/**
 * TJ — Increment 17 (SPEC_17_Capacity_Numbers_Consistency.md), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → th → ti → "tj-…" lexicographic sequence, so
 * this spec runs LAST (Playwright runs spec files in filename order against ONE
 * shared backend). Do NOT rename to "t17".
 *
 * WHAT THIS FILE PROVES (SPEC_17 §6 Verification = this spec's DoD):
 *
 *   §1 BUG 1 — the handoff RECEIVER gets red. When a baseline ticket is handed
 *     dev→dev and the RECEIVING developer logs real time, the receiver must get
 *     an `acquired` (red) segment (counts_to_change=true, +estimate) and the
 *     SENDER a `handoff` (blue-hatched) segment (both counts false). Before Inc
 *     17 the receiver had NOTHING (red was detected only for the "added to the
 *     sprint" path, not the dev→dev handoff path — the 11762 / Tobiáš-Bubeník
 *     bug). NEITHER dev's segment for the ticket counts toward Planned.
 *   §2 BUG 2 — no developer's Planned is ever negative. Across the WHOLE
 *     per_developer[] every `planned_hours >= 0` (the "Jan Bílý −8h" bug);
 *     STRUCTURAL proof too: a `removed` segment has counts_to_planned=false and
 *     its estimate shows ONLY in change_delta_hours (negative), never subtracted
 *     from Planned. Driven on s10 (has `removed`/`handoff` churn that produced
 *     the negative in v1).
 *   §3 Cross-surface consistency (SPEC_17 §4a "jeden výpočet, čtyři plochy"):
 *     capacity.scope_planned_hours === closure.total_planned_hours (EXACT);
 *     capacity.scope_delivered_hours === closure.total_delivered_hours; each
 *     closure total === Σ of its own per_developer[] column; and (report leg,
 *     when the sprint can be CLOSED) GET /api/reports/:id .stats matches the
 *     live closure numbers exactly.
 *   §4 Segment style distinctness (SPEC_17 §1/§7 #2, Increment 26): green
 *     `baseline_worked`, `handoff`, `idle` are THREE different kinds with the
 *     frozen counts_to_planned/counts_to_change signatures (baseline_worked:
 *     planned; handoff & idle: neither) — behaviourally handoff==idle in the
 *     NUMBERS but must be VISUALLY distinct (page-level [data-segment-kind]
 *     class probe). The former grey-hatched `baseline_idle` kind (held baseline,
 *     not logged) was ABOLISHED by Increment 26 and merged into the always-green
 *     `baseline_worked`; the s12 row-b ticket that used to be baseline_idle is
 *     now asserted green (docs/CAPACITY_BAR_RULES.md §6 #1).
 *   §0 real-DB TRIPWIRE (same pattern as th-/ti-): fingerprint the REAL
 *     apps/api/osp.sqlite at each block's start/end; fail loudly if it moved
 *     (Increment-11 data-loss incident). No-ops (with a note) when absent.
 *   §0 users-collection GUARD — the API never issues GET /api/v3/users (the
 *     admin-gated COLLECTION) while computing the Inc-17 flows (closure-stats +
 *     capacity + reports), driven against a RECORDING mock OP.
 *
 * ── v1 → v2 KIND RENAME (REPLACING, not additive — SPEC_17 §1) ────────────────
 * The frozen contracts (packages/contracts) replace Increment-15/16's 7 kind
 * names ENTIRELY:
 *   active→baseline_worked, delivered→(baseline_worked when the dev logged),
 *   redistributed→handoff, removed_no_work→removed, acquired_worked→acquired,
 *   idle_unworked→idle, churned_away→churned. (Increment 17 briefly added a
 *   `baseline_idle` kind for a held-but-unlogged baseline ticket; Increment 26
 *   ABOLISHED it, merging it into the always-green `baseline_worked` — so the v2
 *   set is 6 kinds.) This spec asserts the v2 names. th-/ti- still hard-code the v1
 *   names in their OWN local mirrors and WILL fail once Agent B's v2 engine lands
 *   — that is EXPECTED fallout of a replacing contract change and is reported for
 *   Phase 2 (those two files are NOT mine to edit).
 *
 * ── SEQUENCING (Agents A/B/C landing in parallel) ────────────────────────────
 * At WRITE time, apps/api still emits the v1 kind names (Agent B's v2
 * `developerSegments` not landed) and Agent A's BUG-1 (dev→dev handoff) fixture
 * is not committed. Every functional test PROBES its precondition and
 * test.skip()s with a precise annotation until the piece arrives, so the suite
 * stays green while the real assertions bite AUTOMATICALLY at Phase 2. v2 is
 * detected by (a) a v2-only kind name appearing in per_developer[].segments and
 * (b) the Inc-17-only CapacityResponse.scope_delivered_hours field.
 *
 * ── FIXTURE ASSUMPTIONS (Agent A BUG-1 fixture not landed) ────────────────────
 * §1 needs a NEW scenario in which a baseline ticket held by a DEVELOPER is
 * handed to ANOTHER developer who then LOGS time (the 11762 story: Cameron
 * Dalby → Tobiáš Bubeník[logs] → …). Its exact registered name is unknown, so
 * beforeAll tries a small candidate list (BUG1_SCENARIO_CANDIDATES) and skips
 * §1 cleanly if none load. The assertions are written NAME-AGNOSTIC where
 * possible (find the wp that is `handoff` on one dev and `acquired` on another),
 * so they bind to whatever names Agent A ships. Phase 2 reconciles the candidate
 * list to the real fixture name. §2/§3/§4 reuse s10 (already landed) so their
 * assertions run against real v2 output the moment Agent B lands, independent of
 * Agent A's fixture. No NEW named person is introduced by this spec.
 *
 * ── OSP_DB_PATH / PORT isolation (SPEC_17 guardrails) ─────────────────────────
 * NO new apps/api boot path: reuses tests/playwright.config.ts's webServer (which
 * already sets OSP_DB_PATH + PORT) and, for the users-collection guard, only
 * spins up ephemeral RECORDING MOCK OP servers (port 0, no DB). Nothing here
 * issues a non-GET toward OP — the only writes are to the app's own /api/*
 * surface and the mock's /__mock/* admin API.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const PROJECT_OP_ID = 3;
const SPRINT_WINDOW = { start: "2026-07-06", end: "2026-07-10" } as const;

// s10 — the reliably-landed churn fixture (Increment 15). Reused verbatim for
// §2/§3/§4; its `handoff`(v2)/`removed`(v2) developers are exactly what produced
// v1's negative Planned. Version + cast reconciled 1:1 with th-/ti-.
const S10_SCENARIO = "s10-developer-work-attribution";
const S10_VERSION = "3.5.040";
type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
const S10_ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: "Jan Belka", role: "developer" },
  { name: "Zbyněk Kovář", role: "developer" },
  { name: "Petr Novák", role: "developer" },
  { name: "Milan Černý", role: "developer" },
  { name: "Ota Horák", role: "developer" },
  { name: "Radek Dostál", role: "developer" },
  { name: "Ivo Svoboda", role: "developer" },
  { name: "Marek Sova", role: "tester" },
  { name: "Pavel Král", role: "customer" },
];

// BUG-1 fixture (Agent A, dev→dev handoff, receiver logs — the 11762 story).
// Reconciled to Agent A's landed `s12-handoff-attribution` (version "3.5.042",
// project 3): a compressed faithful repro of real #11762, ticket 12762 held
// mid-chain by Tobias Bubenik (dev, logs 12h → `acquired`/red), baseline
// Cameron Dalby (→ `handoff`), final holder Daniel Beneš (→ `idle`). The
// candidate list keeps earlier guesses so the spec still binds if Phase 2
// renames it. Fixture also carries one dedicated ticket per §1 row a–g.
const BUG1_SCENARIO_CANDIDATES = [
  "s12-handoff-attribution",
  "s12-handoff-acquisition",
  "s12-dev-handoff-red",
  "s12-11762-handoff",
  "s12-handoff",
] as const;
const BUG1_VERSION = "3.5.042"; // s12's target version (reconciled to the landed fixture)
// s12's cast (reconciled 1:1 with s12-handoff-attribution.ts's NAMED_USERS).
// Cameron Dalby (106) + Tobias Bubenik (108) are REUSED VERBATIM from
// s9-role-closure (both developers in both stories — no PersonKey split-brain);
// Daniel Beneš (141, the "Daniel Brabec" analog, kept distinct because Brabec is a
// TESTER in s9) is the final idle holder; Eva Doležalová is the tester baseline
// holder of the churned ticket. Applied best-effort ("not-found" tolerated).
const BUG1_ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: "Cameron Dalby", role: "developer" }, // baseline holder → handoff (sender)
  { name: "Tobias Bubenik", role: "developer" }, // acquired via handoff + LOGGED 12h → red (BUG 1)
  { name: "Daniel Beneš", role: "developer" }, // final holder → idle
  { name: "Lukáš Pokorný", role: "developer" }, // row a baseline_worked
  { name: "Jakub Fiala", role: "developer" }, // row b: held baseline, never logs → baseline_worked (green) post-Inc26 (was baseline_idle)
  { name: "Roman Kraus", role: "developer" }, // row d removed
  { name: "Vít Urban", role: "developer" }, // row g churned
  { name: "Eva Doležalová", role: "tester" }, // tester baseline holder of the churned ticket
];

// ── v2 (SPEC_17 §1) segment kinds + frozen sign tables (mirror @osp/contracts) ─
type DeveloperSegmentKind =
  | "baseline_worked"
  | "handoff"
  | "removed"
  | "acquired"
  | "idle"
  | "churned";
const V2_KINDS: readonly DeveloperSegmentKind[] = [
  "baseline_worked",
  "handoff",
  "removed",
  "acquired",
  "idle",
  "churned",
];
const V2_KIND_SET: ReadonlySet<string> = new Set(V2_KINDS);
/** SPEC_17 §1 + Increment 26: only baseline_worked moves Planned (bar number 1) —
 * the former baseline_idle row merged into baseline_worked. */
// ⚠️ CHANGED in Increment 30 (`docs/INCREMENT_30_CONTRACTS.md` §2a,
// `docs/CAPACITY_BAR_RULES.md` §5 + invariant 7): `Planned` is CURRENT SCOPE,
// so every kind the developer STILL HOLDS and that is STILL IN SCOPE counts —
// `baseline_worked`, `acquired`, `idle`. The three "left my hands" kinds stay 0.
// `CHANGE_SIGN` below is deliberately UNTOUCHED (§2a forbids changing it).
const PLANNED_CONTRIB: Record<DeveloperSegmentKind, 0 | 1> = {
  baseline_worked: 1,
  handoff: 0,
  removed: 0,
  acquired: 1,
  idle: 1,
  churned: 0,
};
/** SPEC_17 §1: Change (bar number 2, signed) = +acquired − removed; all else 0. */
const CHANGE_SIGN: Record<DeveloperSegmentKind, -1 | 0 | 1> = {
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

// ── minimal contract subsets (Inc-17 fields present; v1-name responses simply
//    fail the v2 gate below and skip, they don't crash) ─────────────────────────
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
  kind: string; // string (not the v2 union) so a v1 response parses without crashing
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
interface DeveloperCapacityBreakdown {
  member_id: number | null;
  op_user_id: number | null;
  name: string;
  planned_hours: number;
  logged_hours: number;
  delivered_hours: number;
  delivered_estimate_hours: number;
  accuracy_pct: number | null;
  overshoot_hours: number;
  scope_change_hours?: number;
  // Increment-30 addition: Σ green (baseline) — exactly what `planned_hours`
  // meant before Increment 30 redefined it as CURRENT SCOPE.
  baseline_hours: number;
  segments: DeveloperTicketSegment[];
}
interface ClosureStatsResponse {
  sprint_id: number;
  generated_at: string;
  total_planned_hours: number;
  total_delivered_hours?: number;
  total_logged_hours: number;
  dev_logged_hours: number;
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
  scope_planned_hours?: number;
  scope_delivered_hours?: number;
}
interface SprintRow {
  id: number;
  name: string;
  status: string;
  is_locked?: boolean;
  is_retrospective?: boolean;
}
interface ReportDetailResponse {
  stats: ClosureStatsResponse;
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
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
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
/** Apply a role set. false when the people/role route isn't landed. */
async function applyRoles(ctx: APIRequestContext, roles: ReadonlyArray<{ name: string; role: PersonRole }>): Promise<boolean> {
  for (const { name, role } of roles) {
    const r = await setRoleByName(ctx, name, role);
    if (r === "no-route") return false;
    // "not-found" tolerated per-name (person may not exist in the fixture).
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
function allSegments(stats: ClosureStatsResponse): DeveloperTicketSegment[] {
  return stats.per_developer.flatMap((d) => d.segments ?? []);
}
/** Agent B's Increment-15+ engine landed (per_developer `segments` present). */
function segmentsLanded(stats: ClosureStatsResponse | null): boolean {
  return !!stats && stats.per_developer.length > 0 && Array.isArray(stats.per_developer[0]?.segments);
}
/** Agent B's Increment-17 v2 engine landed: a v2-only kind name appears. */
function v2KindsLanded(stats: ClosureStatsResponse | null): boolean {
  return !!stats && allSegments(stats).some((s) => V2_KIND_SET.has(s.kind));
}

// ── shared retrospective setup (copied from th-/ti-; returns readiness) ───────
interface RetroSetup {
  sprintId: number;
  ready: boolean;
  missing: boolean;
}
async function buildRetroSprint(
  ctx: APIRequestContext,
  opts: { scenario: string; version: string; label: string },
): Promise<RetroSetup> {
  const created = await ctx.post("/api/sprints", {
    data: { name: uniqueSprintName(opts.label), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
  });
  if (!created.ok()) return { sprintId: 0, ready: false, missing: false };
  const sprintId = ((await created.json()) as { id: number }).id;

  // Mark retrospective BEFORE seeding: the fixture's time entries are scenario-
  // calendar PAST; retro replay is what routes them AND a mid-sprint handoff as
  // a red addition (the th-/ti- "real-clock-vs-scenario-calendar" gotcha).
  await ctx.patch(`/api/sprints/${sprintId}`, { data: { is_retrospective: true } }).catch(() => {});

  let seeded = 0;
  const seed = await ctx.post(`/api/sprints/${sprintId}/retro/seed`, {
    data: { kind: "version", value: opts.version },
  });
  if (seed.ok()) {
    const body = (await seed.json()) as { candidates?: unknown[] };
    seeded = Array.isArray(body.candidates) ? body.candidates.length : 0;
  }
  if (seeded === 0) {
    const backlogRes = await ctx.get(`/api/backlog?projectId=${PROJECT_OP_ID}`);
    if (backlogRes.ok()) {
      const backlog = (await backlogRes.json()) as Array<{ op_id: number }>;
      for (const wp of backlog) {
        await ctx.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp.op_id } }).catch(() => {});
        seeded += 1;
      }
    }
  }
  if (seeded === 0) return { sprintId, ready: false, missing: false };

  const activated = await ctx.post(`/api/sprints/${sprintId}/activate`);
  if (!activated.ok()) return { sprintId, ready: false, missing: false };
  await waitSprintStatus(ctx, sprintId, "active").catch(() => {});
  const finished = await ctx.post(`/api/sprints/${sprintId}/finish`, { data: {} });
  if (finished.ok()) await waitSprintTerminal(ctx, sprintId);
  return { sprintId, ready: true, missing: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK A — §1 BUG 1: the dev→dev handoff RECEIVER gets red (Agent A fixture).
// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TJ — SPEC_17 §1 BUG 1: handoff receiver gets red (11762 story)", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let sprintId = 0;
  let dbBefore: DbFingerprint | null;
  let ready = false;
  let scenarioMissing = false;
  let loadedScenario = "";

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    // Try the candidate BUG-1 scenario names; first that loads wins.
    for (const name of BUG1_SCENARIO_CANDIDATES) {
      try {
        await loadScenario(setup, name);
        loadedScenario = name;
        break;
      } catch {
        /* try next */
      }
    }
    if (!loadedScenario) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TJ §1] no BUG-1 handoff scenario loadable (tried ${BUG1_SCENARIO_CANDIDATES.join(", ")}) — Agent A fixture not landed.`);
      return;
    }

    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    for (let day = 1; day <= 4; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api });
    }

    const s = await buildRetroSprint(setup, { scenario: loadedScenario, version: BUG1_VERSION, label: "TJ BUG1" });
    sprintId = s.sprintId;
    ready = s.ready;
  });

  test.afterAll(async () => {
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup?.dispose();
    assertRealDbUnchanged(dbBefore);
  });

  async function statsOrSkip(): Promise<ClosureStatsResponse> {
    test.skip(scenarioMissing, `Agent A BUG-1 handoff fixture not landed (tried ${BUG1_SCENARIO_CANDIDATES.join(", ")}) — Phase 2 wires this up.`);
    test.skip(!ready, "BUG-1 retro sprint could not be created/activated/finished (routes unavailable or 0 items).");
    const rolesOk = await applyRoles(setup, BUG1_ROLES);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed (Agent B).");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B).");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const st = stats as ClosureStatsResponse;
    test.skip(!segmentsLanded(st), "closure-stats.per_developer has no `segments` — Agent B engine not landed.");
    test.skip(
      !v2KindsLanded(st),
      "per_developer[].segments still use v1 kind names (active/redistributed/acquired_worked/…) — Agent B's SPEC_17 v2 developerSegments not landed yet.",
    );
    return st;
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_17 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1 core: same ticket is `handoff` on the sender and `acquired` (red) on
  //    the receiver who logged — the BUG 1 regression. Name-agnostic. ──────────
  test("§1 BUG 1: a dev→dev handed-off ticket the receiver LOGGED shows `handoff` on the sender AND `acquired` (red, counts_to_change, +estimate) on the receiver — the receiver is no longer empty", async () => {
    const s = await statsOrSkip();

    // Index every segment by wp so we can find the (sender handoff, receiver acquired) pair.
    interface SegRef {
      dev: string;
      seg: DeveloperTicketSegment;
    }
    const byWp = new Map<number, SegRef[]>();
    for (const d of s.per_developer) {
      for (const seg of d.segments) {
        const list = byWp.get(seg.wp_op_id) ?? [];
        list.push({ dev: d.name, seg });
        byWp.set(seg.wp_op_id, list);
      }
    }
    // A BUG-1 ticket: appears as `handoff` on one developer AND `acquired` on another.
    const bug1 = [...byWp.entries()].find(([, refs]) => {
      const kinds = new Set(refs.map((r) => r.seg.kind));
      return kinds.has("handoff") && kinds.has("acquired");
    });

    test.info().annotations.push({
      type: "SPEC_17 §1 BUG 1 (11762 story)",
      description:
        `loadedScenario=${loadedScenario}. handoff+acquired ticket=${bug1 ? bug1[0] : "NONE"}. ` +
        `per-wp kinds=${JSON.stringify([...byWp.entries()].map(([wp, refs]) => ({ wp, kinds: refs.map((r) => `${r.dev}:${r.seg.kind}`) })))}`,
    });

    expect(
      bug1,
      "a dev→dev handed-off ticket the receiver logged must appear as `handoff` on the sender AND `acquired` on the receiver (SPEC_17 §3 BUG 1 — pre-fix the receiver had NOTHING)",
    ).toBeTruthy();
    const [, refs] = bug1 as [number, SegRef[]];

    const sender = refs.find((r) => r.seg.kind === "handoff") as SegRef;
    const receiver = refs.find((r) => r.seg.kind === "acquired") as SegRef;
    expect(sender.dev, "sender (handoff) and receiver (acquired) are DIFFERENT developers").not.toBe(receiver.dev);

    // Sender's handoff: blue-hatched, contributes to NEITHER number.
    expect(sender.seg.counts_to_planned, "handoff does NOT count to the sender's Planned (SPEC_17 §1 row c / §7 #1)").toBe(false);
    expect(sender.seg.counts_to_change, "handoff does NOT count to the sender's Change (credit belongs to the finisher)").toBe(false);
    expect(sender.seg.change_delta_hours, "handoff change_delta is 0 (never −estimate — that would double-count vs the receiver)").toBeCloseTo(0, 6);

    // Receiver's acquired (THE bug fix): red, logged marker, +estimate into Change.
    expect(receiver.seg.show_logged_marker, "acquired carries a logged marker (receiver logged real time)").toBe(true);
    expect(receiver.seg.logged_hours, "the receiver logged > 0h on the handed-off ticket (this is what makes it `acquired`, not `idle`)").toBeGreaterThan(0);
    // ⚠️ UPDATED — Increment 30 follow-up, variant A (`CAPACITY_BAR_RULES.md` §5).
    // These asserted `true` / `> 0`. A positive ±Change is now credited only to
    // the developer who currently HOLDS the ticket, and this `acquired` segment
    // belongs to Bubeník, a MID-CHAIN holder (t_handoff ends on Beneš). BUG 1's
    // actual fix is untouched and still asserted above: he gets a red `acquired`
    // segment with a logged marker instead of nothing at all.
    expect(
      receiver.seg.counts_to_change,
      "a MID-CHAIN acquirer no longer carries ±Change — the ticket moved on (variant A)",
    ).toBe(false);
    expect(receiver.seg.change_delta_hours, "…so its change_delta is 0").toBeCloseTo(0, 6);
    // The estimate is credited at most once across the whole chain — that is the
    // property variant A exists to guarantee, whatever the number of hops.
    const creditedChange = refs.filter((r) => r.seg.change_delta_hours > 0);
    expect(
      creditedChange.length,
      `at most one developer gains +estimate for this ticket (found: ${creditedChange.map((c) => c.dev).join(", ") || "none"})`,
    ).toBeLessThanOrEqual(1);
    expect(receiver.seg.in_baseline, "the receiver did NOT hold the ticket at the baseline anchor").toBe(false);

    // ⚠️ CHANGED in Increment 30, then CORRECTED by contracts §2c. A first pass
    // asserted `true` here on the strength of §2a's kind table ("acquired IS the
    // receiver's current scope"). That is wrong for THIS fixture, and the
    // distinction matters: `t_handoff` passes dalby → bubenik(8h) → benes →
    // bubenik(4h) → **benes**, so the `acquired` segment this block finds belongs
    // to Bubenik, a MID-CHAIN holder — Daniel Beneš holds the ticket at the end.
    //
    // §2c derives the flag from the CURRENT holder, so exactly one developer
    // annotates the estimate: the final one. Under §2a both Bubenik and Beneš
    // annotated the full 12h for one 12h ticket (the §2b(iii) multi-hop double
    // count) — this assertion is that double count dissolving.
    expect(sender.seg.counts_to_planned, "handoff never counts to the sender's Planned").toBe(false);
    expect(
      receiver.seg.counts_to_planned,
      "a MID-CHAIN acquirer is not the current holder → does not count to Planned (§2c)",
    ).toBe(false);
    expect(
      receiver.seg.planned_delta_hours,
      "…so it annotates 0, though its bar is still the full estimate long",
    ).toBeCloseTo(0, 6);

    // …and the estimate is counted EXACTLY ONCE, on whoever actually holds it.
    const holders = refs.filter((r) => r.seg.counts_to_planned);
    expect(
      holders.length,
      `exactly one developer annotates this ticket's estimate (found: ${holders.map((h) => h.dev).join(", ") || "none"})`,
    ).toBe(1);
  });

  // ── §1 named check (soft): if Agent A used the 11762 display names, confirm
  //    the receiver who LOGGED (Tobiáš) is the acquirer, the baseline holder
  //    (Cameron) the handoff sender. Annotates-and-skips on a name mismatch. ─
  test("§1 (named): Cameron Dalby has `handoff`, Tobias Bubenik has `acquired` (12h logged) for the same ticket (SPEC_17 §3 literal 11762 story on s12)", async () => {
    const s = await statsOrSkip();
    const findDev = (...names: string[]) => s.per_developer.find((d) => names.includes(d.name));
    const cameron = findDev("Cameron Dalby");
    const tobias = findDev("Tobias Bubenik", "Tobiáš Bubeník");
    if (!cameron || !tobias) {
      test.info().annotations.push({
        type: "SPEC_17 §1 named",
        description: `fixture does not use the s12 11762 names (Cameron=${!!cameron}, Tobias=${!!tobias}); the name-agnostic §1 test above already proved the handoff→acquired relationship. per_developer=${JSON.stringify(s.per_developer.map((d) => d.name))}`,
      });
      test.skip(true, "BUG-1 fixture uses different display names — covered by the name-agnostic §1 test");
      return;
    }
    const handoffWps = new Set(cameron.segments.filter((x) => x.kind === "handoff").map((x) => x.wp_op_id));
    const acquiredWps = new Set(tobias.segments.filter((x) => x.kind === "acquired").map((x) => x.wp_op_id));
    const shared = [...handoffWps].filter((wp) => acquiredWps.has(wp));
    expect(shared.length, "Cameron's handoff ticket == Tobias's acquired ticket (the 12762/#11762 handoff)").toBeGreaterThan(0);
    for (const wp of shared) {
      const tSeg = tobias.segments.find((x) => x.wp_op_id === wp && x.kind === "acquired") as DeveloperTicketSegment;
      expect(tSeg.logged_hours, `Tobias logged real time on the handed-off #${wp} (s12 seeds a genuine 12h time entry)`).toBeGreaterThan(0);
    }
  });

  // ── §4 coverage (Increment 26): s12 has one dedicated ticket per row. Row b
  //    (#12702, Jakub Fiala — a baseline ticket he STILL holds but never logs)
  //    used to be the dedicated grey-hatched `baseline_idle` fixture; Increment
  //    26 abolished that kind, so it is now GREEN `baseline_worked`. This test
  //    now proves (a) that row-b ticket is green + counts to Planned, and (b)
  //    `handoff` and `idle` remain the two distinct hatch kinds (both count to
  //    neither number, but must render visually distinct). ─
  const S12_ROW_B_WP = 12702; // Jakub Fiala — held baseline, never logs → baseline_worked (green) post-Inc26
  test("§4 coverage: the s12 row-b ticket (held baseline, never logged) is now GREEN baseline_worked (counts to Planned) — Increment 26; handoff and idle stay two distinct hatch kinds (neither number)", async () => {
    const s = await statsOrSkip();
    const segs = s.per_developer.flatMap((d) => d.segments);
    const observed = new Set(segs.map((x) => x.kind));
    test.info().annotations.push({
      type: "SPEC_17 §4/§1 s12 kind coverage (Inc26)",
      description: `observed kinds: ${JSON.stringify([...observed])} (s12 targets all of ${JSON.stringify(V2_KINDS)}).`,
    });

    // (a) Row b — the former baseline_idle fixture ticket — is now GREEN
    // baseline_worked and DOES enter Planned (docs/CAPACITY_BAR_RULES.md §6 #1:
    // a held baseline ticket is green regardless of logged time). It must NEVER
    // reappear as a hatched/idle kind.
    const rowB = segs.filter((x) => x.wp_op_id === S12_ROW_B_WP);
    expect(rowB.length, `s12 row-b ticket #${S12_ROW_B_WP} produces a developer segment`).toBeGreaterThan(0);
    for (const seg of rowB) {
      expect(seg.kind, `#${S12_ROW_B_WP} (held baseline, never logged) is GREEN baseline_worked post-Inc26, not a hatched idle kind`).toBe(
        "baseline_worked",
      );
      expect(seg.counts_to_planned, "the green baseline ticket counts toward Planned (baseline retained)").toBe(true);
      expect(seg.counts_to_change, "baseline_worked does not move Change").toBe(false);
    }

    // (b) handoff + idle remain the two distinct hatch kinds (both count to
    // neither number — SPEC_17 §7 #2 they mean different things and must stay
    // VISUALLY distinct). Both still materialise in s12.
    // ⚠️ Increment 30 (contracts §2a) SPLIT these two numerically: `idle` is
    // still-held scope and now counts to Planned, while `handoff` left the
    // developer's hands and counts to neither. They are no longer "both 0/0".
    for (const kind of ["handoff", "idle"] as const) {
      expect(observed.has(kind), `s12 materialises a \`${kind}\` segment (SPEC_17 §1 row for it)`).toBe(true);
      for (const seg of segs.filter((x) => x.kind === kind)) {
        expect(seg.counts_to_planned, `${kind}: counts_to_planned per the Increment-30 table`).toBe(
          PLANNED_CONTRIB[kind] === 1,
        );
        expect(seg.counts_to_change, `${kind} never moves Change (SPEC_17, untouched)`).toBe(false);
      }
    }
    // baseline_worked and idle now SHARE Planned membership, so the argument for
    // keeping them visually distinct rests on the KIND (and its colour), not on
    // the numbers — which is precisely SPEC_17 §7 #2 / CAPACITY_BAR_RULES.md §2:
    // green "signed up at activation" must never read as orange-hatched
    // "acquired mid-sprint and untouched". `handoff` remains numerically
    // distinct from both.
    expect(PLANNED_CONTRIB.baseline_worked, "baseline_worked and idle are both current scope now").toBe(
      PLANNED_CONTRIB.idle,
    );
    expect(PLANNED_CONTRIB.handoff, "…while handoff is not current scope at the sender").not.toBe(
      PLANNED_CONTRIB.idle,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK B — §2/§3/§4 on the reliably-landed s10 churn fixture.
// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TJ — SPEC_17 §2/§3/§4 numbers consistency (s10 churn sprint)", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let sprintId = 0;
  let dbBefore: DbFingerprint | null;
  let ready = false;
  let scenarioMissing = false;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    try {
      await loadScenario(setup, S10_SCENARIO);
    } catch (err) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TJ §2-4] scenario "${S10_SCENARIO}" not loadable: ${String(err)}`);
      return;
    }
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    for (let day = 1; day <= 4; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api });
    }
    const s = await buildRetroSprint(setup, { scenario: S10_SCENARIO, version: S10_VERSION, label: "TJ s10" });
    sprintId = s.sprintId;
    ready = s.ready;
  });

  test.afterAll(async () => {
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup?.dispose();
    assertRealDbUnchanged(dbBefore);
  });

  /** Precondition: fixture + Agent B's v2 engine landed. */
  async function statsOrSkip(): Promise<ClosureStatsResponse> {
    test.skip(scenarioMissing, `scenario "${S10_SCENARIO}" not landed (scenario 404).`);
    test.skip(!ready, "s10 retro sprint could not be created/activated/finished (routes unavailable or 0 items).");
    const rolesOk = await applyRoles(setup, S10_ROLES);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed (Agent B).");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B).");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const st = stats as ClosureStatsResponse;
    test.skip(!segmentsLanded(st), "closure-stats.per_developer has no `segments` — Agent B engine not landed.");
    test.skip(
      !v2KindsLanded(st),
      "per_developer[].segments still use v1 kind names — Agent B's SPEC_17 v2 developerSegments not landed yet.",
    );
    return st;
  }

  // ── §2: no developer's Planned is ever negative + the structural proof ───────
  test("§2 BUG 2: every developer's planned_hours >= 0, and a `removed` segment's estimate lands ONLY in change_delta (negative), never subtracted from Planned", async () => {
    const s = await statsOrSkip();

    test.info().annotations.push({
      type: "SPEC_17 §2 Planned per developer",
      description: JSON.stringify(
        s.per_developer.map((d) => ({
          name: d.name,
          planned: d.planned_hours,
          change: d.scope_change_hours,
          segs: d.segments.map((x) => ({ wp: x.wp_op_id, kind: x.kind, est: x.estimate_hours, cp: x.counts_to_planned, cc: x.counts_to_change, cd: x.change_delta_hours })),
        })),
      ),
    });

    // BUG 2 headline: NO developer's Planned is negative (the "Jan Bílý −8h" bug).
    for (const d of s.per_developer) {
      expect(d.planned_hours, `${d.name}'s Planned must be >= 0 (SPEC_17 §4 BUG 2 — Planned is structurally non-negative)`).toBeGreaterThanOrEqual(0);
    }

    // ⚠️ CHANGED in Increment 30 (contracts §2/§2a). `baseline_hours` — the
    // figure this block was written around — is still EXACTLY Σ green, and that
    // identity is asserted below. `planned_hours` is now CURRENT SCOPE, derived
    // from "who holds the ticket now", NOT from the segment kinds; the two are
    // deliberately different axes and they part company in shapes s10 contains
    // (a baseline ticket handed to a NON-developer keeps its green segment but
    // leaves the developer's Planned; a baseline ticket ABANDONED to unassigned
    // has a `removed` segment yet stays in Planned via the frozen-baseline
    // holder fallback). Per contracts §2 the canonical value wins for anything
    // displayed as Planned — so the divergence is MEASURED here, never coerced.
    for (const d of s.per_developer) {
      // Increment 38 — Baseline = signed up for at Activate: every in-baseline
      // segment (green, handoff, removed), not only the retained green ones.
      const baselineFromKinds = sum(
        d.segments.filter((x) => x.in_baseline).map((x) => x.estimate_hours ?? 0),
      );
      expect(
        d.baseline_hours,
        `${d.name}: baseline_hours == Σ estimate(in-baseline segments) — signed up for at Activate`,
      ).toBeCloseTo(baselineFromKinds, 3);
      expect(
        d.baseline_hours,
        `${d.name}: Baseline is structurally non-negative too`,
      ).toBeGreaterThanOrEqual(0);

      const plannedFromKinds = sum(
        d.segments
          .filter((x) => PLANNED_CONTRIB[x.kind as DeveloperSegmentKind] === 1)
          .map((x) => x.estimate_hours ?? 0),
      );
      if (Math.abs(d.planned_hours - plannedFromKinds) > 0.0005) {
        const notTheirsAnyMore = d.segments.filter((x) => x.current_holder_name !== d.name);
        test.info().annotations.push({
          type: "INCREMENT_30 Planned vs kind-reconstruction (measured)",
          description: `${d.name}: canonical planned_hours=${d.planned_hours} vs Σ(baseline_worked+acquired+idle)=${plannedFromKinds}; segments no longer held by them: ${JSON.stringify(
            notTheirsAnyMore.map((x) => ({ wp: x.wp_op_id, kind: x.kind, est: x.estimate_hours, holder: x.current_holder_name })),
          )}`,
        });
        expect(
          notTheirsAnyMore.length,
          `${d.name}: a Planned/kind divergence must be explained by a ticket that is no longer theirs — never by arithmetic drift`,
        ).toBeGreaterThan(0);
      }
    }

    // Structural proof on at least one `removed` segment (s10's Radek Dostál):
    // counts_to_planned=false, and the estimate shows up as a NEGATIVE change,
    // never subtracted from Planned.
    const removed = allSegments(s).filter((x) => x.kind === "removed");
    if (removed.length === 0) {
      test.info().annotations.push({
        type: "SPEC_17 §2 removed",
        description: "s10 produced no `removed` segment (fixture/engine shape differs) — the non-negative-Planned invariant above still holds; the structural leg is annotated-only.",
      });
    }
    expect(removed.length, "s10 has a baseline-abandoned ticket → a `removed` segment (Radek Dostál row d)").toBeGreaterThan(0);
    for (const seg of removed) {
      expect(seg.counts_to_planned, `removed #${seg.wp_op_id}: counts_to_planned is false (its estimate is NOT retained Planned)`).toBe(false);
      expect(seg.planned_delta_hours, `removed #${seg.wp_op_id}: contributes 0 to Planned (never a subtraction there)`).toBeCloseTo(0, 6);
      expect(seg.counts_to_change, `removed #${seg.wp_op_id}: counts_to_change is true (the loss lives in Change)`).toBe(true);
      expect(seg.change_delta_hours, `removed #${seg.wp_op_id}: its estimate appears as a NEGATIVE change (−estimate), not a Planned subtraction`).toBeLessThan(0);
    }
  });

  // ── §3: cross-surface consistency — the "one computation, four surfaces" guard ─
  test("§3: capacity.scope_planned_hours === closure.total_planned_hours (exact), scope_delivered === total_delivered, each total === Σ its per_developer column, and the report surface matches", async () => {
    const s = await statsOrSkip();
    const cap = await getCapacity(setup, sprintId);
    test.skip(cap === null, "GET /sprints/:id/capacity not available.");
    const c = cap as CapacityResponse;

    test.skip(
      typeof c.scope_planned_hours !== "number" || typeof c.scope_delivered_hours !== "number",
      "capacity.scope_planned_hours / scope_delivered_hours absent — Agent B's Inc-17 unified header not landed.",
    );
    test.skip(
      typeof s.total_delivered_hours !== "number",
      "closure.total_delivered_hours absent — Agent B's Inc-17 Delivered aggregate not landed.",
    );

    const perDevPlanned = sum(s.per_developer.map((d) => d.planned_hours));
    const perDevDelivered = sum(s.per_developer.map((d) => d.delivered_hours ?? 0));
    test.info().annotations.push({
      type: "SPEC_17 §3/§4a cross-surface",
      description:
        `capacity.scope_planned=${c.scope_planned_hours} scope_delivered=${c.scope_delivered_hours} | ` +
        `closure.total_planned=${s.total_planned_hours} total_delivered=${s.total_delivered_hours} | ` +
        `Σ per_dev planned=${perDevPlanned} delivered=${perDevDelivered} | ` +
        `(capacity.total_planned_hours=${c.total_planned_hours} is the DIFFERENT Inc-14 role-filtered figure — must NOT be conflated)`,
    });

    // The four legs of "jeden výpočet" (Capacity header vs Closure header).
    expect(c.scope_planned_hours as number, "capacity.scope_planned_hours === closure.total_planned_hours (SPEC_17 §2/§4a — same computation)").toBeCloseTo(
      s.total_planned_hours,
      3,
    );
    expect(c.scope_delivered_hours as number, "capacity.scope_delivered_hours === closure.total_delivered_hours").toBeCloseTo(
      s.total_delivered_hours as number,
      3,
    );
    // Each header total is exactly the sum of its own per-developer column.
    expect(s.total_planned_hours, "closure.total_planned_hours === Σ per_developer[].planned_hours").toBeCloseTo(perDevPlanned, 3);
    expect(s.total_delivered_hours as number, "closure.total_delivered_hours === Σ per_developer[].delivered_hours").toBeCloseTo(
      perDevDelivered,
      3,
    );
    // ── CAPACITY_BAR_RULES §6 invariants 5 + 8 (Increment 30): the header must
    //    be reproducible from the DEVELOPER ROWS RENDERED BENEATH IT, and the
    //    per-developer table must be the same on both surfaces. MEASURED here,
    //    on the s10 churn fixture, because that is where the two holder
    //    resolutions can diverge. ──
    const devLines = c.lines.filter((l) => l.is_developer);
    const lineByName = new Map(devLines.map((l) => [l.name, l]));
    const sumDevLines = sum(devLines.map((l) => l.planned_hours));
    // A developer who appears in Closure with 0 h and has NO capacity line at all
    // (only left-my-hands segments — `handoff` / `churned`) is not a mismatch:
    // nothing of theirs is missing from the header, and adding up the visible
    // rows still reproduces it. Only a real numeric disagreement counts.
    const mismatches = s.per_developer
      .map((d) => ({ name: d.name, closure: d.planned_hours, line: lineByName.get(d.name)?.planned_hours ?? null }))
      .filter((x) => (x.line === null ? Math.abs(x.closure) > 0.0005 : Math.abs(x.line - x.closure) > 0.0005));
    test.info().annotations.push({
      type: "CAPACITY_BAR_RULES §6 invariant 5/8 (measured)",
      description:
        `header scope_planned=${c.scope_planned_hours} vs Σ visible developer lines=${sumDevLines}; ` +
        `per-developer Closure-vs-CapacityLine mismatches=${JSON.stringify(mismatches)}. ` +
        `capacity lines=${JSON.stringify(c.lines.map((l) => [l.name, l.planned_hours, l.is_developer]))}. ` +
        `NOTE: a RETROSPECTIVE sprint keeps a frozen reconstructed estimate in Closure (CAPACITY_BAR_RULES §5a) while ` +
        `computeCapacity resolves the LIVE effectiveEstimate, so per-line differences here are expected.`,
    });
    // 🔴 MEASURED (Increment 30, reported for Phase 2). On THIS block's sprint
    // the two DO diverge, and each divergence has a nameable, documented cause —
    // never arithmetic drift:
    //
    //   (a) THIS SPRINT IS RETROSPECTIVE. `CAPACITY_BAR_RULES.md` §5a keeps a
    //       retro sprint's estimate of record on the FROZEN reconstructed
    //       snapshot (`retro.ts` writes the ticket's state at start_date), while
    //       `computeCapacity` resolves the LIVE `effectiveEstimate` off the cache
    //       row. That is a deliberate, pre-existing exception, so a per-LINE
    //       difference here is expected and is NOT an invariant-5 breach — the
    //       four canonical surfaces (Capacity header, Closure, sprint detail,
    //       PDF) still read ONE computation, which the assertions above prove.
    //   (b) A baseline ticket ABANDONED to unassigned. Closure's holder
    //       resolution falls back to the frozen baseline assignee
    //       (`wp?.assignee_op_id ?? b?.assignee_op_id`) and keeps the hours on
    //       the ex-holder's developer row, while `computeCapacity` reads the live
    //       cache row and files the same ticket under the UNASSIGNED bucket,
    //       which is not a developer line. Fixing that means choosing ONE holder
    //       resolution for an unassigned in-scope ticket — a product decision
    //       (does abandoned work stay on its last owner's plate, or become
    //       nobody's?), not a refactor.
    //
    // The STRICT per-line identity is proved where it actually applies — on a
    // LIVE sprint — by `tests/src/inc30-current-scope-planned.test.ts`
    // ("the per-developer TABLE is identical between the Capacity lines and the
    // Closure breakdown"), which passes.
    const sprintRow = await setup
      .get("/api/sprints")
      .then(async (r) => (r.ok() ? ((await r.json()) as SprintRow[]).find((x) => x.id === sprintId) : undefined))
      .catch(() => undefined);
    const isRetro = sprintRow?.is_retrospective === true;
    for (const m of mismatches) {
      if (isRetro) continue; // (a) — documented §5a frozen-estimate exception
      const d = s.per_developer.find((x) => x.name === m.name);
      const abandoned = (d?.segments ?? []).filter(
        (x) => x.current_holder_name === null && x.kind === "removed",
      );
      expect(
        abandoned.length,
        `${m.name}: a Closure-vs-CapacityLine Planned mismatch (closure ${m.closure} vs line ${m.line}) must be caused by a ticket abandoned to unassigned — never by arithmetic drift`,
      ).toBeGreaterThan(0);
    }
    if (!isRetro && mismatches.length === 0) {
      expect(
        c.scope_planned_hours as number,
        "invariant 8: the header equals Σ of the developer rows displayed beneath it",
      ).toBeCloseTo(sumDevLines, 3);
    }

    // Delivered is NOT "Planned + Change" (SPEC_17 §2 "NE 'první+druhé'").
    const plannedPlusChange = perDevPlanned + sum(s.per_developer.map((d) => d.scope_change_hours ?? 0));
    test.info().annotations.push({
      type: "SPEC_17 §2 Delivered ≠ první+druhé",
      description: `Delivered=${s.total_delivered_hours} vs (Planned+Change)=${plannedPlusChange} — these are DIFFERENT computations (Delivered = completed+credited only).`,
    });

    // Report surface (the 4th plane): GET /api/reports/:id .stats must match the
    // live closure numbers exactly. Requires the sprint to be CLOSED/listed.
    const reportRes = await setup.get(`/api/reports/${sprintId}`);
    if (!reportRes.ok()) {
      test.info().annotations.push({
        type: "SPEC_17 §4a report surface",
        description: `GET /api/reports/${sprintId} → HTTP ${reportRes.status()} (sprint not closed/reportable in this setup, or route not landed) — the Capacity↔Closure legs above already prove the shared computation; skipping only the report leg.`,
      });
      return;
    }
    const report = (await reportRes.json()) as ReportDetailResponse;
    const rs = report.stats;
    test.info().annotations.push({
      type: "SPEC_17 §4a report surface",
      description: `report.stats.total_planned=${rs.total_planned_hours} total_delivered=${rs.total_delivered_hours}; per_dev planned=${JSON.stringify(rs.per_developer.map((d) => [d.name, d.planned_hours, d.delivered_hours]))}`,
    });
    expect(rs.total_planned_hours, "report.stats.total_planned_hours === live closure.total_planned_hours").toBeCloseTo(s.total_planned_hours, 3);
    if (typeof rs.total_delivered_hours === "number") {
      expect(rs.total_delivered_hours, "report.stats.total_delivered_hours === live closure.total_delivered_hours").toBeCloseTo(
        s.total_delivered_hours as number,
        3,
      );
    }
    // The per-developer table is IDENTICAL across Closure and the report (SPEC_17 §4a).
    const liveByName = new Map(s.per_developer.map((d) => [d.name, d]));
    for (const rd of rs.per_developer) {
      const live = liveByName.get(rd.name);
      if (!live) continue;
      expect(rd.planned_hours, `${rd.name}: report PLANNED === closure PLANNED`).toBeCloseTo(live.planned_hours, 3);
      expect(rd.delivered_hours ?? 0, `${rd.name}: report DELIVERED === closure DELIVERED`).toBeCloseTo(live.delivered_hours ?? 0, 3);
    }
  });

  // ── §4: segment style distinctness (data-layer signatures + page probe) ──────
  test("§4: baseline_worked (green) / handoff / idle are three DIFFERENT kinds with the frozen counts_to_planned/counts_to_change signatures (and distinct classes when Agent C's bar is landed)", async ({ page }) => {
    const s = await statsOrSkip();
    const segs = allSegments(s);

    // Data-layer: EVERY observed segment obeys the frozen v2 sign tables.
    for (const seg of segs) {
      if (!V2_KIND_SET.has(seg.kind)) continue; // (guarded by v2KindsLanded, defensive)
      const kind = seg.kind as DeveloperSegmentKind;
      // ⚠️ UPDATED by contracts §2c. This used to assert equality with the
      // KIND-based table. Since §2c, `counts_to_planned` is derived from the
      // CURRENT HOLDER, so the kind alone cannot decide it — two segments of
      // the SAME kind legitimately annotate differently depending on who holds
      // the ticket now (the Zbynek-handed-to-a-tester case). The table survives
      // only as an UPPER BOUND: being current scope implies a kind marked 1, so
      // a kind marked 0 can never count. Assert exactly that, and no more.
      if (PLANNED_CONTRIB[kind] === 0) {
        expect(
          seg.counts_to_planned,
          `${kind}#${seg.wp_op_id}: PLANNED_CONTRIB=0 is an upper bound — can never be current scope`,
        ).toBe(false);
      }
      expect(seg.counts_to_change, `${kind}#${seg.wp_op_id}: counts_to_change == (CHANGE_SIGN=${CHANGE_SIGN[kind]} !== 0)`).toBe(
        CHANGE_SIGN[kind] !== 0,
      );
      // §2c: planned_delta is the estimate when the segment IS current scope,
      // 0 otherwise — driven by the flag above, not by the kind table.
      expect(seg.planned_delta_hours, `${kind}#${seg.wp_op_id}: planned_delta == counts_to_planned × estimate`).toBeCloseTo(
        seg.counts_to_planned ? (seg.estimate_hours ?? 0) : 0,
        3,
      );
      expect(seg.change_delta_hours, `${kind}#${seg.wp_op_id}: change_delta == sign × estimate`).toBeCloseTo(
        CHANGE_SIGN[kind] * (seg.estimate_hours ?? 0),
        3,
      );
      expect(seg.show_logged_marker, `${kind}#${seg.wp_op_id}: show_logged_marker == kind ∈ {baseline_worked,acquired}`).toBe(
        LOGGED_MARKER_KINDS.has(kind),
      );
    }

    const observed = new Set(segs.map((x) => x.kind));
    test.info().annotations.push({
      type: "SPEC_17 §4 kinds observed",
      description: `observed kinds: ${JSON.stringify([...observed])}. baseline_worked present=${observed.has("baseline_worked")}, handoff=${observed.has("handoff")}, idle=${observed.has("idle")}.`,
    });

    // The three distinct-meaning kinds (Increment 26). handoff & idle are
    // behaviourally identical in the NUMBERS (both count nothing) but MUST be
    // different kinds; the GREEN baseline_worked differs from BOTH by counting
    // toward Planned. The frozen signatures (asserted straight from the returned
    // data, whichever of the three appear):
    for (const seg of segs.filter((x) => x.kind === "baseline_worked")) {
      // ⚠️ UPDATED by contracts §2c. This asserted `true` unconditionally, which
      // held only while the flag was kind-derived. A baseline ticket reassigned
      // to a NON-developer keeps the `baseline_worked` kind (there is no
      // "handed to a tester" kind — `handoff` means "to another DEVELOPER"), yet
      // it is no longer that developer's current scope, so it must not count.
      // The kind still guarantees the colour and the bar length; only the
      // Planned annotation now depends on who holds it.
      const stillTheirs = seg.current_holder_role === "developer" || seg.current_holder_name === null;
      if (stillTheirs) {
        expect(seg.counts_to_planned, "a RETAINED baseline_worked counts toward Planned (green regardless of log — Inc 26)").toBe(true);
      }
      expect(seg.counts_to_change, "baseline_worked does not move Change").toBe(false);
    }
    for (const seg of segs.filter((x) => x.kind === "handoff")) {
      expect(seg.counts_to_planned, "handoff counts to neither number").toBe(false);
      expect(seg.counts_to_change, "handoff counts to neither number").toBe(false);
    }
    // ⚠️ CHANGED in Increment 30 (contracts §2a): `idle` is work the developer
    // STILL HOLDS, so it counts toward Planned now. It remains outside ±Change.
    for (const seg of segs.filter((x) => x.kind === "idle")) {
      expect(seg.counts_to_planned, "idle IS current scope (Increment 30 §2a)").toBe(true);
      expect(seg.counts_to_change, "idle never moves Change (SPEC_17, untouched)").toBe(false);
    }
    // green baseline_worked and idle now SHARE Planned membership, so the case
    // for keeping them VISUALLY distinct rests on their meaning and colour, not
    // on the numbers: "signed up at activation" (green) must never read as
    // "picked up mid-sprint and untouched" (orange-hatched). That is exactly the
    // conflation SPEC_17 §7 #2 / CAPACITY_BAR_RULES.md §2 forbid, and the
    // [data-segment-kind] class probe below is now the ONLY thing enforcing it —
    // which makes that probe load-bearing rather than a nicety.
    expect(PLANNED_CONTRIB.baseline_worked, "baseline_worked and idle are both current scope now").toBe(
      PLANNED_CONTRIB.idle,
    );
    expect(CHANGE_SIGN.baseline_worked, "…and both stay out of ±Change").toBe(CHANGE_SIGN.idle);
    expect(PLANNED_CONTRIB.handoff, "handoff remains numerically distinct from idle").not.toBe(
      PLANNED_CONTRIB.idle,
    );

    // VISUAL distinctness (Agent C): whichever two of the three render, their
    // [data-segment-kind] elements must carry DIFFERENT classes (SPEC_17 §1
    // "musí být vizuálně odlišné" — green + two hatches, three meanings).
    await page.goto("/");
    const kindClass = async (kind: string): Promise<string | null> => {
      const el = page.locator(`[data-segment-kind="${kind}"]`).first();
      const visible = await el.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false);
      if (!visible) return null;
      return (await el.getAttribute("class")) ?? "";
    };
    const classes: Record<string, string | null> = {};
    for (const k of ["baseline_worked", "handoff", "idle"]) classes[k] = await kindClass(k);
    const rendered = Object.entries(classes).filter(([, v]) => v !== null) as Array<[string, string]>;
    if (rendered.length < 2) {
      test.info().annotations.push({
        type: "SPEC_17 §4 visual distinctness",
        description: `fewer than two of {baseline_worked,handoff,idle} rendered as [data-segment-kind] (Agent C bar not landed or fixture lacks the kinds): ${JSON.stringify(classes)} — data-layer distinctness proven above; skipping the visual leg.`,
      });
      test.skip(true, "Agent C capacity-bar markup / the two kinds not both present");
      return;
    }
    for (let i = 0; i < rendered.length; i += 1) {
      for (let j = i + 1; j < rendered.length; j += 1) {
        const a = rendered[i] as [string, string];
        const b = rendered[j] as [string, string];
        expect(
          a[1],
          `[data-segment-kind="${a[0]}"] and ="${b[0]}" must render with DIFFERENT classes (SPEC_17 §7 #2 — no two hatches may collapse)`,
        ).not.toBe(b[1]);
      }
    }
  });

  // ── §0 GUARD: no GET /api/v3/users during the Inc-17 read flows ──────────────
  test("§0 guard: no GET /api/v3/users (admin-gated COLLECTION) while computing capacity / closure-stats / reports (SPEC_17 guardrails)", async () => {
    test.skip(scenarioMissing, `scenario "${S10_SCENARIO}" not landed — nothing to drive against the recording mock.`);
    test.setTimeout(150_000);
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let recSprintId: number | null = null;
    try {
      rec = await createRecordingMockOpServer();
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(S10_SCENARIO)}`);
      await setup.post(`${rec.url}/__mock/goto-day/4`);

      recConnId = await ensureConnection(setup, rec.url, "rec-guard-token-tj");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: recConnId } });
      expect(sync.ok(), `scoped sync to recording mock: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      const built = await buildRetroSprint(setup, { scenario: S10_SCENARIO, version: S10_VERSION, label: "TJ NoUsersColl" });
      recSprintId = built.sprintId || null;

      // Judge only the Inc-17 READ flows: clear the recording after setup.
      rec.reset();
      await setup.get("/api/people").catch(() => {});
      await applyRoles(setup, S10_ROLES).catch(() => {});
      if (recSprintId !== null) {
        await setup.get(`/api/sprints/${recSprintId}/closure-stats`).catch(() => {}); // planned/delivered + segments
        await setup.get(`/api/sprints/${recSprintId}/capacity`).catch(() => {}); // scope_planned/scope_delivered
        await setup.get(`/api/reports/${recSprintId}`).catch(() => {}); // report surface
      }

      const sawOpRead = rec.requests.some((r) => r.path.startsWith("/api/v3/"));
      if (!sawOpRead) {
        test.info().annotations.push({
          type: "SPEC_17 users-collection guard",
          description: `no /api/v3/* read reached the recording mock during the Inc-17 flows (routes likely not landed) — absence assertion vacuous; skipping. Observed=${JSON.stringify([...new Set(rec.requests.map((r) => r.path))])}`,
        });
        test.skip(true, "Increment-17 flows did not exercise OP on the recording mock yet");
        return;
      }

      const usersCollectionHits = rec.requests.filter((r) => r.path === "/api/v3/users");
      test.info().annotations.push({
        type: "SPEC_17 users-collection guard",
        description:
          `Inc-17 flows hit these OP paths: ${JSON.stringify([...new Set(rec.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => `${r.method} ${r.path}`))])}. ` +
          `bare /api/v3/users hits=${usersCollectionHits.length}.`,
      });
      expect(
        usersCollectionHits.length,
        `SPEC_17 guardrail: the API issued GET /api/v3/users (the admin-gated user COLLECTION) ${usersCollectionHits.length}× while computing the Inc-17 numbers — it must NEVER call it (ids come from _links.assignee/accountable + GET /api/v3/memberships, Inc 13 §1a).`,
      ).toBe(0);
    } finally {
      if (recSprintId !== null) await setup.delete(`/api/sprints/${recSprintId}`).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (recConnId !== null) await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      if (rec !== null) await rec.close().catch(() => {});
    }
  });
});
