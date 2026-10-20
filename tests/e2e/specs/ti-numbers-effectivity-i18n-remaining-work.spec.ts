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
 * TI — Increment 16 (SPEC_16_Numbers_Effectivity_i18n_RemainingWork.md), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tg → th → "ti-…" lexicographic sequence, so
 * this spec runs LAST (Playwright runs spec files in filename order against ONE
 * shared backend). Do NOT rename to "t16".
 *
 * WHAT THIS FILE PROVES (SPEC_16 §7 Verification = this spec's DoD):
 *
 *   §1 Effectivity label  — the closure/report screens show "Effectivity" where
 *     they used to show "Accuracy"; the literal "Accuracy" no longer appears in
 *     that context. A LABEL/UI-copy requirement, so this is a page-level check
 *     (Reports → Detail → the closure-stats region) with an API-shape fallback.
 *   §2 Per-developer bar THREE numbers — `retained (green) / ±scope-change / capacity`,
 *     the middle number SIGN-EXPLICIT and GREY-EXCLUDED:
 *       • Jan Belka   `0h / +19h / 30h`  (nothing in baseline, took on 19h and did it)
 *       • Zbyněk Kovář `30h / 0h / 60h`  (baseline unchanged)
 *       • Milan Černý  middle = **0**    (his ticket was redistributed to another
 *                                         developer — GREY — which must NOT show as
 *                                         −10 on his bar; it reappears as the RECEIVER's
 *                                         gain, no double-counting: SPEC_16 §2/§8 #2)
 *       • Ota Horák    middle = **0**    (idle receiver, never logged → informative only)
 *       • Radek Dostál middle = **−6**   (baseline abandoned with zero work → removed_no_work,
 *                                         the negative side IS counted)
 *       • Petr Novák   retained = 8      (active baseline he kept)
 *     Read from GET /sprints/:id/closure-stats' per_developer[].{retained_hours,
 *     scope_change_hours} (Inc-16 additions); available (3rd number) from the
 *     SEPARATE GET /sprints/:id/capacity lines[].available_hours.
 *   §3 Capacity header unified with Closure — `scope_planned_hours` (Capacity) ===
 *     `total_planned_hours` (Closure) for the same sprint (the "142h not 86h"
 *     unification), and `total_delivered_hours` === Σ per_developer[].delivered_hours
 *     (the server's new aggregate matches its own per-developer breakdown).
 *   §4 British English spot-check — the generated PDF (POST /api/reports/:id/pdf)
 *     is a real PDF and contains NO known US-spelling giveaways ("color",
 *     "organize", "favor", "MM/DD"-shaped patterns); a DD/MM/YYYY date is present
 *     when the text layer is extractable. Plus a best-effort page-level tooltip
 *     probe. Inherently a SAMPLING task (SPEC_16 §4), not exhaustive.
 *   §5 effectiveEstimate / Remaining work — GET /api/backlog's effective_hours
 *     follows `remaining != 0 && remaining != work → remaining, else work`, with
 *     a local override still taking precedence (SPEC_16 §5/§8 #3). Driven against
 *     Agent A's s11-effective-estimate fixture (WP 1901 Work 24 / Remaining 18 →
 *     18, mirroring the spec's #11765 example; 1902 remaining==work → work;
 *     1903 remaining==0 → work; 1904 remaining wins → 3).
 *   §0 real-DB TRIPWIRE (same pattern as te-/tf-/tg-/th-): fingerprint the REAL
 *     apps/api/osp.sqlite at each block's start and end; fail loudly if it moved
 *     (Increment-11 data-loss incident). No-ops (with a note) when absent.
 *   §0 users-collection GUARD — the API never issues GET /api/v3/users (the
 *     admin-gated COLLECTION) while computing the Inc-16 flows (closure-stats +
 *     capacity + reports/PDF + backlog), driven against a RECORDING mock OP.
 *
 * ── SEQUENCING (Agents A/B/C landing in parallel) ────────────────────────────
 * The CONTRACTS (packages/contracts) are FROZEN with the Increment-16 shapes:
 *   • CapacityResponse.scope_planned_hours
 *   • ClosureStatsResponse.total_delivered_hours
 *   • DeveloperCapacityBreakdown.retained_hours / .scope_change_hours
 * At the time this spec was WRITTEN, Agent B's engine (the three trailing
 * numbers + the unified Planned + Delivered aggregate) and Agent C's UI copy /
 * British-English/PDF work are NOT necessarily landed. Every functional test
 * therefore PROBES its precondition and test.skip()s with a precise annotation
 * when a piece isn't there, so the suite stays green while the real assertions
 * bite AUTOMATICALLY once each feature arrives (Phase 2 integration). The exact
 * DoD numbers below are the acceptance target.
 *
 * ── FIXTURE FACTS (already landed by Agent A / reconciled) ───────────────────
 * §2/§3 reuse Increment-15's own `s10-developer-work-attribution` fixture (its
 * story is EXACTLY SPEC_16 §2's worked example — Jan Belka 0/+19, Kovář 30/0,
 * Černý redistributed→Horák, Dostál abandoned, Novák active) via the SAME
 * retrospective-sprint setup th- uses. §5 uses Agent A's already-committed
 * `s11-effective-estimate` fixture (WP 1901/1902/1903/1904). NO NEW named person
 * is introduced by this spec — every name is reused from s10 (already
 * materialized by th-), so there is no cross-spec PersonKey collision to worry
 * about (the Increment-15 "Zbynek Trnka" split-brain lesson does not apply).
 *
 * ── OSP_DB_PATH / PORT isolation (SPEC_16 guardrails) ────────────────────────
 * NO new apps/api boot path: reuses tests/playwright.config.ts's webServer (which
 * already sets OSP_DB_PATH + PORT) and, for the users-collection guard, only
 * spins up ephemeral RECORDING MOCK OP servers (port 0, no DB). Each block's
 * live tripwire is the belt-and-braces proof this run never touched the real DB.
 * Nothing here issues a non-GET toward OP — the only writes are to the app's own
 * /api/* surface and the mock's /__mock/* admin API.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s10-developer-work-attribution";
const PROJECT_OP_ID = 3;
const SPRINT_VERSION = "3.5.040";
const SPRINT_WINDOW = { start: "2026-07-06", end: "2026-07-10" } as const;

// s10's cast — display names reused verbatim from th-/the fixture (collision-free).
const JAN = "Jan Belka";
const KOVAR = "Zbyněk Kovář";
const NOVAK = "Petr Novák";
const CERNY = "Milan Černý";
const HORAK = "Ota Horák";
const DOSTAL = "Radek Dostál";

type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
const ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: JAN, role: "developer" },
  { name: KOVAR, role: "developer" },
  { name: NOVAK, role: "developer" },
  { name: CERNY, role: "developer" },
  { name: HORAK, role: "developer" },
  { name: DOSTAL, role: "developer" },
  { name: "Ivo Svoboda", role: "developer" },
  { name: "Marek Sova", role: "tester" },
  { name: "Pavel Král", role: "customer" },
];

// ── SPEC_16 §2 DoD numbers, for the s10 story ────────────────────────────────
const JAN_RETAINED = 0; // nothing in baseline
// ⚠️ SPEC §7 prose says Jan's middle number is "+19h" — but that figure is a
// carry-over from SPEC_15's WORK-based story and does NOT account for THIS
// increment's own §5 change (estimate now = Remaining work when it differs from
// Work). Ticket t5a (12005) is CREATED mid-sprint on day 1 and worked down to
// remaining 4h the SAME day, so under §5 its effective estimate is 4h, not its
// Work value 8h. Jan's acquired_worked Σ is therefore 6+5+4 = 15h, not 6+5+8 =
// 19h. The landed Inc-16 engine returns 15 (confirmed against the running
// stack). Phase 2 should reconcile the SPEC §7 prose ("+19h") to the §5-correct
// 15h (or, if a true `estimate_at_acquisition` is later implemented per the
// deferred note in closureStats.ts, re-verify this number). Everything else in
// §7's per-dev example matches exactly.
const JAN_SCOPE_CHANGE = 15; // §5-adjusted (see note); SPEC §7 prose's stale value was 19
const JAN_SCOPE_CHANGE_SPEC_PROSE = 19;
const KOVAR_RETAINED = 30; // 30h baseline delivered, kept (t2 remaining hit 0 → §5 falls through to Work 30)
const KOVAR_SCOPE_CHANGE = 0; // no acquired/removed
const DOSTAL_SCOPE_CHANGE = -6; // baseline abandoned with zero work → removed_no_work −6 (t4 never worked, remaining==Work)
const NOVAK_RETAINED = 8; // active baseline he kept (t1 reconstructed at start_date, before any work → §5 = Work 8)

// ── v2 kind set (SPEC_17 §1, mirrors @osp/contracts) — reused to derive §2's
//    planned/scope-change from raw segments as a robust structural check.
//    Reconciled during Increment 17 Phase 2 integration: the old v1 kinds
//    (active/delivered/redistributed/removed_no_work/acquired_worked/
//    idle_unworked/churned_away) and the separate `retained_hours` field are
//    GONE — `planned_hours` is now the canonical "bar number 1" (redefined,
//    same VALUE this spec always expected, since Increment 16's own
//    `retained_hours` and Increment 15's `planned_hours` disagreed and this
//    spec was already keying off the CORRECT one). `scope_change_hours`'s
//    NAME and VALUE are unchanged — only the kind names it's computed from
//    are renamed. ─────────────────────────────────────────────────────────
type DeveloperSegmentKind =
  | "baseline_worked"
  | "handoff"
  | "removed"
  | "acquired"
  | "idle"
  | "churned";

// ── minimal contract subsets (Inc-16/17 fields OPTIONAL so a pre-integration
//    response without them makes the precondition probe skip, not crash) ───────
interface PersonSummary {
  id: number;
  name: string;
  role: PersonRole;
}
interface DeveloperTicketSegment {
  wp_op_id: number;
  kind: DeveloperSegmentKind;
  estimate_hours: number | null;
  counts_to_planned: boolean;
  planned_delta_hours: number;
  in_baseline: boolean;
  current_holder_name: string | null;
}
interface DeveloperCapacityBreakdown {
  name: string;
  planned_hours: number;
  delivered_hours: number;
  segments: DeveloperTicketSegment[];
  // Increment-16 addition (optional until Agent B lands it):
  scope_change_hours?: number;
  // Increment-30 addition: Σ green (baseline) — what `planned_hours` meant
  // before Increment 30 turned it into CURRENT SCOPE (CAPACITY_BAR_RULES §5).
  baseline_hours: number;
}
interface ClosureStatsResponse {
  sprint_id: number;
  total_planned_hours: number;
  total_logged_hours: number;
  per_developer: DeveloperCapacityBreakdown[];
  // Increment-16 addition (optional until Agent B lands it):
  total_delivered_hours?: number;
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
  // Increment-16 addition (optional until Agent B lands it):
  scope_planned_hours?: number;
}
interface SprintRow {
  id: number;
  name: string;
  status: string;
  is_locked?: boolean;
  is_retrospective?: boolean;
}
interface BacklogItemRow {
  op_id: number;
  estimated_hours: number | null;
  remaining_hours: number | null;
  override_hours: number | null;
  effective_hours: number | null;
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
async function applyRoles(ctx: APIRequestContext): Promise<boolean> {
  for (const { name, role } of ROLES) {
    const r = await setRoleByName(ctx, name, role);
    if (r === "no-route") return false;
    // "not-found" tolerated per-name (person may not exist in the fixture yet).
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
/** Agent B's Increment-15 engine landed (per-developer `segments` present). */
function inc15Landed(stats: ClosureStatsResponse | null): boolean {
  return !!stats && stats.per_developer.length > 0 && Array.isArray(stats.per_developer[0]?.segments);
}
/** Agent B's Increment-16 per-developer three-number split landed (v2 field
 * name: `planned_hours` — always present — plus `scope_change_hours`). */
function inc16BarLanded(stats: ClosureStatsResponse | null): boolean {
  const d = stats?.per_developer[0];
  return !!d && typeof d.planned_hours === "number" && typeof d.scope_change_hours === "number";
}
/** Derive §2's numbers straight from the frozen v2 segment kind rules (SPEC_17
 * §1) — a robust structural cross-check that Agent B's pre-computed fields
 * agree with the KIND-based partition: planned = Σ est(baseline_worked)
 * (Increment 26 merged the former baseline_idle into it); scope-change =
 * Σ est(acquired) − Σ est(removed); handoff / idle / churned EXCLUDED from
 * both. */
/**
 * Increment 38 (`CAPACITY_BAR_RULES.md` §5) — what the developer was signed up
 * for at Activate: every segment of theirs that is IN BASELINE (green, handoff,
 * removed), not only the retained green ones. Equal to `baseline_hours` while
 * no ticket was re-estimated since activation (true for this scenario).
 */
function signedUpFromSegments(d: DeveloperCapacityBreakdown): number {
  return sum(d.segments.filter((s) => s.in_baseline).map((s) => s.estimate_hours ?? 0));
}
/**
 * Increment 30 (`docs/INCREMENT_30_CONTRACTS.md` §2a) — the KIND-based
 * reconstruction of Planned: `baseline_worked` + `acquired` + `idle`.
 *
 * ⚠️ MEASURED, and reported as a Phase-2 finding: this does NOT always equal the
 * canonical `planned_hours`. The canonical rule is "currently in the sprint AND
 * CURRENTLY ASSIGNED to this developer", while the segment KIND is decided on a
 * different axis (who held it at the baseline anchor, and whether they logged).
 * The two disagree in at least two shapes s10 contains:
 *   • a baseline ticket handed to a NON-developer — the segment stays
 *     `baseline_worked` (green, `counts_to_planned` true) but the ticket is no
 *     longer the developer's, so canonical Planned drops it (Zbyněk Kovář-style);
 *   • a baseline ticket ABANDONED to unassigned — the segment is `removed`
 *     (`counts_to_planned` false) yet the canonical holder resolution falls back
 *     to the frozen baseline assignee, so Planned keeps it (Radek Dostál, 6 h).
 * Per contracts §2, the canonical value wins for anything displayed as
 * "Planned"; the segment fields are presentational. Kept here to MEASURE the
 * gap rather than to define it.
 */
function currentScopeFromSegments(d: DeveloperCapacityBreakdown): number {
  const inScope = new Set(["baseline_worked", "acquired", "idle"]);
  return sum(d.segments.filter((s) => inScope.has(s.kind)).map((s) => s.estimate_hours ?? 0));
}
function scopeChangeFromSegments(d: DeveloperCapacityBreakdown): number {
  const acquired = sum(d.segments.filter((s) => s.kind === "acquired").map((s) => s.estimate_hours ?? 0));
  const removed = sum(d.segments.filter((s) => s.kind === "removed").map((s) => s.estimate_hours ?? 0));
  return acquired - removed;
}

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK A — §1/§2/§3/§4 + the users-collection guard, on the s10 retro sprint.
// Setup copied/adapted almost verbatim from th- (the same retrospective flow).
// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TI — SPEC_16 numbers / Effectivity / British English (s10 retro sprint)", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let sprintId = 0;
  let dbBefore: DbFingerprint | null;
  let sprintReady = false;
  let scenarioMissing = false;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb(); // FIRST: fingerprint the real DB.

    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    try {
      await loadScenario(setup, SCENARIO);
    } catch (err) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TI] scenario "${SCENARIO}" not loadable: ${String(err)}`);
      return;
    }

    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });

    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // Reveal the whole 5-day timeline (day-gated in the mock engine) BEFORE
    // seeding/activating — same convention as th-'s retro setup.
    for (let day = 1; day <= 4; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api });
    }

    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TI 3.5.040"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    sprintId = ((await created.json()) as { id: number }).id;

    const retro = await setup.patch(`/api/sprints/${sprintId}`, { data: { is_retrospective: true } });
    expect(retro.ok(), `mark retrospective: ${retro.status()} ${await retro.text()}`).toBeTruthy();

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
    if (seeded === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[TI] scenario "${SCENARIO}" loaded but produced 0 sprint items — fixture shape differs.`);
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
    assertRealDbUnchanged(dbBefore); // LAST: the real DB must be byte-identical.
  });

  /** Shared precondition for the §2/§3 functional tests: fixture + Inc-15 engine. */
  async function statsOrSkip(): Promise<ClosureStatsResponse> {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (scenario 404) — Phase 2 wires this up.`);
    test.skip(!sprintReady, `s10 sprint could not be created/activated/finished (routes unavailable or 0 items).`);
    const rolesOk = await applyRoles(setup);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed (Agent B).");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B).");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;
    test.skip(
      !inc15Landed(s),
      "closure-stats.per_developer has no `segments` — Agent B's Increment-15 engine not landed yet.",
    );
    return s;
  }

  // ── §0: real-DB tripwire armed ──────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_16 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present in this sandbox — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §2: per-developer bar — three numbers, sign-explicit, grey excluded ─────
  // Field/kind names reconciled to Increment 17's v2 model during Phase 2
  // integration: `retained_hours` is GONE (Increment 15's `planned_hours` is
  // now the correctly-redefined, canonical bar-number-1 field — same VALUES
  // this spec always asserted); `acquired_worked`/`redistributed`/
  // `removed_no_work`/`idle_unworked` are renamed `acquired`/`handoff`/
  // `removed`/`idle`. The NUMBERS below are UNCHANGED (v2 preserves the same
  // story for this fixture) — only names moved.
  // ⚠️ Increment 30 (contracts §2a) redefined the FIRST number: `planned_hours`
  // is CURRENT SCOPE, and the retained-baseline figure this test was written
  // around now lives in `baseline_hours`. Jan therefore reads Baseline 0 /
  // Planned 15 / Change +15 instead of "0 / +15"; every other name below is
  // unaffected (they hold no acquired or idle work).
  test("§2: per-dev bar numbers `baseline / planned / ±scope-change / capacity` — Jan baseline 0 & planned 15 (§5-adj, §7 prose +19), Kovář baseline 30 & planned 0, Černý handoff→0, Horák idle, Dostál −6, Novák planned 8; middle number sign-explicit and handoff NOT double-counted", async () => {
    const s = await statsOrSkip();
    test.skip(
      !inc16BarLanded(s),
      "per_developer[].planned_hours / scope_change_hours absent — Agent B's three-number split not landed.",
    );

    const cap = await getCapacity(setup, sprintId);

    test.info().annotations.push({
      type: "SPEC_16/17 §2 per-developer bars (observed)",
      description: JSON.stringify(
        s.per_developer.map((d) => ({
          name: d.name,
          planned: d.planned_hours,
          scope_change: d.scope_change_hours,
          delivered: d.delivered_hours,
          segs: d.segments.map((x) => ({ wp: x.wp_op_id, kind: x.kind, est: x.estimate_hours })),
        })),
      ),
    });

    // ── Structural cross-check first: for EVERY developer the pre-computed
    //    fields must equal the KIND-based partition of their own segments
    //    (planned = baseline_worked — Increment 26 merged the former
    //    baseline_idle into it; scope-change = acquired − removed; handoff /
    //    idle / churned excluded). This proves the "no double-counting" rule
    //    holds for the whole roster, not just the headline names. ──
    for (const d of s.per_developer) {
      // ⚠️ CHANGED in Increment 30 (contracts §2a), and again in Increment 38:
      // `baseline_hours` is what the developer was signed up for at Activate —
      // all their in-baseline segments, handoffs and removals included. `planned_hours` is now CURRENT SCOPE,
      // computed from "who holds the ticket now" rather than from the segment
      // kinds, so it is asserted structurally (non-negative, and reconciled
      // against the sprint total in §3) plus MEASURED against the kind
      // reconstruction below — see `currentScopeFromSegments`' doc for the two
      // shapes where they legitimately part company.
      expect(
        d.baseline_hours,
        `${d.name}: baseline_hours == Σ estimate(in-baseline segments) — signed up for at Activate`,
      ).toBeCloseTo(signedUpFromSegments(d), 3);
      expect(d.planned_hours, `${d.name}: Planned is structurally non-negative`).toBeGreaterThanOrEqual(0);
      if (Math.abs(d.planned_hours - currentScopeFromSegments(d)) > 0.0005) {
        // Recorded, NOT coerced. Every divergence must be explainable by a
        // segment whose ticket is no longer this developer's, or one with no
        // current holder at all — never by arithmetic drift.
        const suspicious = d.segments.filter(
          (x) => x.current_holder_name !== d.name,
        );
        test.info().annotations.push({
          type: "INCREMENT_30 Planned vs kind-reconstruction (measured)",
          description: `${d.name}: canonical planned_hours=${d.planned_hours} vs Σ(baseline_worked+acquired+idle)=${currentScopeFromSegments(d)}; segments not currently held by them: ${JSON.stringify(
            suspicious.map((x) => ({ wp: x.wp_op_id, kind: x.kind, est: x.estimate_hours, holder: x.current_holder_name })),
          )}`,
        });
        expect(
          suspicious.length,
          `${d.name}: a Planned/kind divergence must be caused by a ticket that is no longer theirs`,
        ).toBeGreaterThan(0);
      }
      expect(
        d.scope_change_hours,
        `${d.name}: scope_change_hours == Σ est(acquired) − Σ est(removed) (handoff/idle/churn excluded — SPEC_17 §1/§7 #1)`,
      ).toBeCloseTo(scopeChangeFromSegments(d), 3);
    }

    // ── The SPEC_16 §2 headline worked example (numbers unchanged by v2). ──
    const jan = devByName(s, JAN);
    expect(jan, `${JAN} must appear in per_developer with a non-empty bar`).toBeTruthy();
    const d = jan as DeveloperCapacityBreakdown;
    const janAvail = cap?.lines.find((l) => l.name === JAN)?.available_hours ?? null;
    test.info().annotations.push({
      type: "SPEC_16/17 §2 Jan Belka",
      description:
        `planned=${d.planned_hours} scope_change=${d.scope_change_hours} available=${janAvail}. ` +
        `SPEC §7 prose = "0h / +19h / 30h"; the middle number is +${JAN_SCOPE_CHANGE} (§5-adjusted: t5a's effective ` +
        `estimate is Remaining 4h, not Work 8h), NOT +${JAN_SCOPE_CHANGE_SPEC_PROSE} — Phase 2 should reconcile the doc.`,
    });

    // ⚠️ CHANGED in Increment 30: Jan's BASELINE is 0h (nothing was his at the
    // anchor) — that is the figure this line has always been about, and it now
    // has its own name. His PLANNED is 15h: the three acquired tickets are his
    // CURRENT scope. Numerically Planned == ±Change here, which is exactly why
    // invariant 9 forbids adding them (30h is nobody's scope).
    expect(d.baseline_hours, "Jan's Baseline is 0h (nothing in baseline)").toBeCloseTo(JAN_RETAINED, 3);
    expect(d.planned_hours, "Jan's Planned is 15h — current scope (Inc 30)").toBeCloseTo(
      JAN_SCOPE_CHANGE,
      3,
    );
    expect(
      d.baseline_hours + (d.scope_change_hours ?? 0),
      "Baseline + ±Change == Planned (the composition that balances — invariant 9)",
    ).toBeCloseTo(d.planned_hours, 3);
    expect(d.scope_change_hours as number, "Jan scope-change is POSITIVE (net scope gained — sign-explicit '+')").toBeGreaterThan(0);
    // Composition: exactly his three mid-sprint acquired-and-worked tickets.
    const janAcquired = d.segments.filter((seg) => seg.kind === "acquired");
    expect(new Set(janAcquired.map((x) => x.wp_op_id)), "Jan's gain is his 3 acquired tickets t5a/t5b/t5c").toEqual(
      new Set([12005, 12006, 12007]),
    );
    // Magnitude: the §5-correct value (see the JAN_SCOPE_CHANGE note). This bites
    // if the engine regresses; the annotation above flags the §7-prose mismatch.
    expect(d.scope_change_hours, `Jan scope-change = +${JAN_SCOPE_CHANGE}h (§5-adjusted; SPEC §7 prose said +${JAN_SCOPE_CHANGE_SPEC_PROSE}h)`).toBeCloseTo(
      JAN_SCOPE_CHANGE,
      3,
    );
    // Third number (capacity/available) comes from the SEPARATE capacity line.
    // Its exact value (30h in the SPEC prose) is unchanged capacity behaviour, so
    // assert only that it's a real number and annotate — don't hard-code 30.
    if (janAvail !== null) {
      expect(Number.isFinite(janAvail), "Jan's available (3rd number) is a real number from CapacityLine").toBe(true);
    }

    // ⚠️ CHANGED in Increment 30. Kovář's 30h claim was always about his
    // RETAINED BASELINE, and that is what `baseline_hours` now holds. His
    // canonical `planned_hours` is 0 because the finished ticket has moved on to
    // a non-developer — "what is he on the hook for right now" is nothing. Same
    // measured shape as Zbyněk Trnka in th-; see that spec's 🔴 note for why
    // the green segment and the number legitimately disagree here.
    const kovar = devByName(s, KOVAR);
    expect(kovar, `${KOVAR} must appear in per_developer`).toBeTruthy();
    expect(kovar?.baseline_hours, "Kovář's Baseline is 30h (baseline delivered, unchanged)").toBeCloseTo(
      KOVAR_RETAINED,
      3,
    );
    expect(
      kovar?.planned_hours,
      "Kovář's Planned is 0h — the ticket is no longer his (Increment 30 current-scope rule)",
    ).toBeCloseTo(0, 3);
    expect(kovar?.scope_change_hours, "Kovář scope-change 0h").toBeCloseTo(KOVAR_SCOPE_CHANGE, 3);

    // Milan Černý — his ticket was a HANDOFF (blue-hatched, SPEC_17 row c) to
    // another developer. His middle number MUST be 0, NOT −10, and (v2's own
    // BUG-2 fix) his PLANNED must be 0 too, NOT negative: the handoff is
    // excluded from BOTH numbers here and reappears as the receiver's gain
    // (no double-counting). This is the explicit SPEC_17 §1/§7 #1 assertion.
    const cerny = devByName(s, CERNY);
    expect(cerny, `${CERNY} must appear (he held baseline work that was handed off)`).toBeTruthy();
    expect(
      cerny?.scope_change_hours,
      "Černý scope-change is 0 — a HANDOFF to another dev is NOT counted as −10 on the sender's bar (SPEC_17 §1/§7 #1)",
    ).toBeCloseTo(0, 3);
    expect(
      cerny?.planned_hours,
      "Černý's Planned is 0, NOT negative (BUG 2 fix — a handoff never subtracts from Planned)",
    ).toBeCloseTo(0, 3);

    // Ota Horák — idle receiver (acquired T3 but never logged → idle, sign 0).
    // His own middle must also be 0, so the handoff shows up as a gain on
    // NOBODY's bar until it's actually worked — robustly proving the absence
    // of double-counting from BOTH ends.
    const horak = devByName(s, HORAK);
    if (horak) {
      expect(
        horak.scope_change_hours,
        "Horák scope-change is 0 — an idle (unworked) receiver contributes nothing to number 2 either",
      ).toBeCloseTo(0, 3);
    } else {
      test.info().annotations.push({
        type: "SPEC_16/17 §2 Horák",
        description: "Ota Horák absent from per_developer (idle receiver held no Planned-counting work) — the no-double-count claim still holds from Černý's side.",
      });
    }

    // Radek Dostál — baseline abandoned with zero work (removed, SPEC_17 row
    // d): the NEGATIVE side IS counted in Change (never in Planned). His
    // middle number is −6, sign-explicit.
    const dostal = devByName(s, DOSTAL);
    if (dostal) {
      expect(dostal.scope_change_hours, "Dostál scope-change −6h (baseline abandoned, `removed` counts negative in Change)").toBeCloseTo(
        DOSTAL_SCOPE_CHANGE,
        3,
      );
      expect(dostal.scope_change_hours, "Dostál scope-change is NEGATIVE (net lost)").toBeLessThan(0);
      // The BUG-2 claim this line has always made — Planned is never NEGATIVE —
      // still holds and is what is asserted.
      expect(dostal.planned_hours, "Dostál's Planned is never negative (BUG 2 fix)").toBeGreaterThanOrEqual(0);
      // Increment 38 — Baseline = signed up for at Activate: the abandoned 6 h
      // stay in his Baseline; the loss shows in ±Change (−6), so the two balance.
      expect(dostal.baseline_hours, "Dostál was signed up for 6h at Activate (kept after abandoning it)").toBeCloseTo(
        -DOSTAL_SCOPE_CHANGE,
        3,
      );
      expect(dostal.baseline_hours + (dostal.scope_change_hours ?? 0), "Baseline + ±Change balances").toBeCloseTo(0, 3);
      // ✅ FIXED by contracts §2c. This block previously asserted 6h and
      // documented WHY that was wrong: `closureStats` resolved the holder as
      // `wp?.assignee_op_id ?? b?.assignee_op_id`, so an ABANDONED ticket (set
      // to UNASSIGNED — nobody is its current assignee) fell back to the frozen
      // baseline holder and was handed back to Dostál, while `computeCapacity`
      // put the same 6h in the UNASSIGNED bucket. Two surfaces, two rows, one
      // ticket — an invariant-5 break.
      //
      // §2c gave both surfaces one holder resolution: assigned to nobody means
      // assigned to nobody. Dostál's Planned is now 0 and the 6h sits in the
      // unassigned bucket on BOTH surfaces. Do NOT "restore" the 6h — that
      // would re-introduce the ex-holder fallback and re-break invariant 5.
      expect(
        dostal.planned_hours,
        "Dostál's Planned is 0 — an abandoned ticket belongs to nobody, not to its ex-holder (§2c)",
      ).toBeCloseTo(0, 3);
    }

    // Petr Novák — baseline_worked (v2 row a — he logged 5h on it) baseline he kept.
    const novak = devByName(s, NOVAK);
    if (novak) {
      // t1 is a plain baseline ticket reconstructed at the sprint START DATE
      // (before any work), so §5 sees remaining==Work and keeps 8h — unlike Jan's
      // mid-sprint t5a. Matches SPEC §7 exactly.
      expect(novak.planned_hours, "Novák's Planned is 8h (baseline_worked kept, reconstructed at start_date)").toBeCloseTo(NOVAK_RETAINED, 3);
    }
  });

  // ── §3: Capacity header unified with Closure; Delivered aggregate consistent ─
  test("§3: capacity.scope_planned_hours === closure.total_planned_hours (the 142h-not-86h unification); total_delivered_hours === Σ per_developer[].delivered_hours", async () => {
    const s = await statsOrSkip();
    const cap = await getCapacity(setup, sprintId);
    test.skip(cap === null, "GET /sprints/:id/capacity not available.");
    const c = cap as CapacityResponse;

    // Delivered aggregate consistency — a pure server-vs-itself check, available
    // as soon as Agent B ships total_delivered_hours (Inc-15 delivered_hours is
    // already present).
    test.skip(
      typeof s.total_delivered_hours !== "number",
      "closure-stats.total_delivered_hours absent — Agent B's Increment-16 Delivered aggregate not landed.",
    );
    const perDevDelivered = sum(s.per_developer.map((d) => d.delivered_hours ?? 0));
    test.info().annotations.push({
      type: "SPEC_16 §3 Delivered",
      description: `total_delivered_hours=${s.total_delivered_hours} vs Σ per_developer.delivered_hours=${perDevDelivered}`,
    });
    expect(
      s.total_delivered_hours as number,
      "total_delivered_hours equals the sum of its own per-developer delivered_hours (SPEC_16 §3)",
    ).toBeCloseTo(perDevDelivered, 3);

    // The core unification claim: the Capacity header's Planned and the Closure
    // Planned are the SAME baseline number (they previously diverged 86h vs 142h
    // because the old capacity Planned applied developer-workload filters).
    test.skip(
      typeof c.scope_planned_hours !== "number",
      "capacity.scope_planned_hours absent — Agent B's Increment-16 unified Planned not landed.",
    );
    test.info().annotations.push({
      type: "SPEC_16 §3 unified Planned",
      description: `capacity.scope_planned_hours=${c.scope_planned_hours} vs closure.total_planned_hours=${s.total_planned_hours} (must agree; capacity.total_planned_hours=${c.total_planned_hours} is the DIFFERENT, still-developer-filtered number)`,
    });
    expect(
      c.scope_planned_hours as number,
      "capacity.scope_planned_hours === closure.total_planned_hours (SPEC_16 §3: Planned unified across both headers)",
    ).toBeCloseTo(s.total_planned_hours, 3);
  });

  // ── §3 (UI): the Capacity/Closure header renders three numbers incl. Delivered ─
  test("§3 (UI): the closure header renders a Delivered stat between Planned and Logged (Agent C)", async ({ page }) => {
    test.skip(scenarioMissing || !sprintReady, "s10 sprint not ready.");
    await page.goto("/");
    // Reach the closure-stats region via Reports → Detail (deterministic: our
    // closed sprint is listed there). Tolerate every step's absence pre-integration.
    const opened = await openReportDetail(page, sprintId);
    if (!opened) {
      test.info().annotations.push({
        type: "SPEC_16 §3 UI",
        description: "could not reach the closure-stats region in the UI (vault/connection gate, Reports/Detail not landed, or sprint not listed) — data-layer §3 check above still stands.",
      });
      test.skip(true, "closure-stats UI region not reachable");
      return;
    }
    const region = page.locator('[data-testid="closure-stats"]').first();
    const text = (await region.textContent({ timeout: 5000 }).catch(() => null)) ?? "";
    if (!/Delivered/i.test(text)) {
      test.info().annotations.push({
        type: "SPEC_16 §3 UI",
        description: `closure-stats region has no "Delivered" label yet — Agent C's header change not landed. Region text sample: ${text.slice(0, 200)}`,
      });
      test.skip(true, "Delivered stat not rendered yet");
      return;
    }
    expect(text, "closure header shows a Delivered stat (SPEC_16 §3)").toMatch(/Delivered/i);
  });

  // ── §1: Effectivity label present, Accuracy absent (page-level UI copy) ──────
  test("§1: the closure/report screen shows \"Effectivity\", not \"Accuracy\" (SPEC_16 §1 label rename)", async ({ page }) => {
    test.skip(scenarioMissing || !sprintReady, "s10 sprint not ready.");
    await page.goto("/");
    const opened = await openReportDetail(page, sprintId);
    if (!opened) {
      test.info().annotations.push({
        type: "SPEC_16 §1 Effectivity",
        description: "could not reach the closure-stats region in the UI (gate / Reports-Detail not landed) — label check deferred to Phase 2.",
      });
      test.skip(true, "closure-stats UI region not reachable");
      return;
    }
    const region = page.locator('[data-testid="closure-stats"]').first();
    const text = (await region.textContent({ timeout: 5000 }).catch(() => null)) ?? "";
    // Pre-rename the region still says "Estimate accuracy" / "Accuracy". Skip
    // (don't fail) while Agent C's rename is pending, but bite once it lands.
    if (/Accuracy/i.test(text) && !/Effectivity/i.test(text)) {
      test.info().annotations.push({
        type: "SPEC_16 §1 Effectivity",
        description: `closure-stats region still says "Accuracy" and not "Effectivity" — Agent C's rename not landed. Text: ${text.slice(0, 250)}`,
      });
      test.skip(true, "Accuracy→Effectivity rename not landed");
      return;
    }
    expect(text, "the estimate-accuracy stat is now labelled \"Effectivity\" (SPEC_16 §1)").toMatch(/Effectivity/i);
    expect(text, "the literal \"Accuracy\" no longer appears in the closure-stats context (SPEC_16 §1)").not.toMatch(/Accuracy/i);
  });

  // ── §4: British-English spot-check on the generated PDF + a tooltip probe ────
  test("§4: the report PDF is real and carries no US-spelling giveaways (colour/organise/DD-MM-YYYY); a page-level tooltip is not old-Czech and not US-spelled", async ({ page }) => {
    test.skip(scenarioMissing || !sprintReady, "s10 sprint not ready.");

    const pdf = await setup.post(`/api/reports/${sprintId}/pdf`, { data: {} });
    test.skip(notImplemented(pdf.status()), "POST /api/reports/:id/pdf not landed (Agent B/C).");
    expect(pdf.ok(), `POST /api/reports/${sprintId}/pdf: ${pdf.status()} ${await pdf.text()}`).toBeTruthy();
    expect(pdf.headers()["content-type"], "PDF response is application/pdf").toContain("application/pdf");
    const bytes = await pdf.body();
    expect(bytes.length, "a real PDF is more than a few bytes").toBeGreaterThan(1000);
    expect(bytes.subarray(0, 4).toString("latin1"), "PDF magic header").toBe("%PDF");

    // A generated PDF often compresses its text streams, so we can't rely on
    // FINDING British words in the raw bytes. But asserting the ABSENCE of known
    // US-spelling giveaways is robust either way: if compressed, none are found
    // (pass, correct direction); if the text layer is plaintext and a US spelling
    // slipped through, it's caught. (SPEC_16 §4 is explicitly a sampling task.)
    const raw = bytes.toString("latin1");
    const US_GIVEAWAYS: ReadonlyArray<RegExp> = [
      /\bcolor\b/i, // vs colour
      /\borganize[ds]?\b/i, // vs organise
      /\bfavor(ite|ites|ed)?\b/i, // vs favour
      /\bprioritize[ds]?\b/i, // vs prioritise
      /\bfinalize[ds]?\b/i, // vs finalise
      /\bcenter\b/i, // vs centre
      /\blicense\b/i, // vs licence (noun)
      /\b\d{2}\/\d{2}\/\d{4}\b(?=[^]*MM\/DD)/i, // (placeholder — real MM/DD check below)
    ];
    const foundUs = US_GIVEAWAYS.slice(0, -1).filter((re) => re.test(raw)).map((re) => re.source);
    const textLayerReadable = /\b(Planned|Delivered|Logged|Sprint|Effectivity|Overshoot)\b/i.test(raw);
    // A literal "MM/DD" template token would betray an un-localised US date format.
    const hasUsDateToken = /MM\/DD/.test(raw);
    // A DD/MM/YYYY-shaped date somewhere is the positive British signal (only
    // meaningful when the text layer is extractable).
    const hasBritishDate = /\b\d{2}\/\d{2}\/\d{4}\b/.test(raw);

    test.info().annotations.push({
      type: "SPEC_16 §4 British English (PDF)",
      description:
        `pdf bytes=${bytes.length}; text-layer readable=${textLayerReadable}; ` +
        `US giveaways found=${JSON.stringify(foundUs)}; MM/DD token=${hasUsDateToken}; DD/MM/YYYY date present=${hasBritishDate}.`,
    });

    expect(foundUs, `PDF must contain no US-spelling giveaways (SPEC_16 §4): found ${JSON.stringify(foundUs)}`).toEqual([]);
    expect(hasUsDateToken, "PDF must not contain a literal MM/DD date token (SPEC_16 §4 wants DD/MM/YYYY)").toBe(false);
    if (textLayerReadable && !hasBritishDate) {
      test.info().annotations.push({
        type: "SPEC_16 §4 date format",
        description: "PDF text layer is readable but no DD/MM/YYYY date matched — Agent C's date-format localisation may still be pending; not hard-failing on the positive signal.",
      });
    }

    // Best-effort page-level tooltip probe (SPEC_16 §4 "hover/tooltipy nad
    // progress barem"): read a capacity-bar segment's title attribute and assert
    // it's neither obvious US-spelled nor the OLD Czech copy. Purely a probe —
    // skips when Agent C's bar markup isn't landed.
    await page.goto("/");
    const seg = page.locator("[data-segment-kind][title], .capacity-bar [title], [data-testid='closure-stats'] [title]").first();
    const hasSeg = await seg.waitFor({ state: "attached", timeout: 3000 }).then(() => true).catch(() => false);
    if (!hasSeg) {
      test.info().annotations.push({
        type: "SPEC_16 §4 tooltip",
        description: "no titled capacity-bar segment found — Agent C's bar/tooltips not landed; PDF spot-check above still enforced.",
      });
      return;
    }
    const title = (await seg.getAttribute("title")) ?? "";
    test.info().annotations.push({ type: "SPEC_16 §4 tooltip", description: `sampled tooltip title="${title}"` });
    for (const re of [/\bcolor\b/i, /\borganize\b/i, /\bcenter\b/i]) {
      expect(re.test(title), `tooltip "${title}" must not contain a US spelling (${re.source})`).toBe(false);
    }
  });

  // ── §0 GUARD: no GET /api/v3/users during the Inc-16 read flows ─────────────
  test("§0 guard: no GET /api/v3/users (admin-gated COLLECTION) while computing capacity / closure-stats / reports / PDF (SPEC_16 guardrails)", async () => {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed — nothing to drive against the recording mock.`);
    test.setTimeout(150_000);
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let recSprintId: number | null = null;
    try {
      rec = await createRecordingMockOpServer();
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);
      await setup.post(`${rec.url}/__mock/goto-day/4`);

      recConnId = await ensureConnection(setup, rec.url, "rec-guard-token-ti");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: recConnId } });
      expect(sync.ok(), `scoped sync to recording mock: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      const created = await setup.post("/api/sprints", {
        data: { name: uniqueSprintName("TI NoUsersColl"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
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

      // Judge only the Inc-16 READ flows: clear the recording after setup.
      rec.reset();
      await setup.get("/api/people").catch(() => {});
      await applyRoles(setup).catch(() => {});
      await setup.get(`/api/sprints/${recSprintId}/closure-stats`).catch(() => {}); // three numbers + Delivered
      await setup.get(`/api/sprints/${recSprintId}/capacity`).catch(() => {}); // scope_planned_hours
      await setup.get(`/api/backlog?projectId=${PROJECT_OP_ID}&connectionId=${recConnId}`).catch(() => {}); // effective_hours
      await setup.get("/api/reports").catch(() => {});
      await setup.get(`/api/reports/${recSprintId}`).catch(() => {});
      await setup.post(`/api/reports/${recSprintId}/pdf`, { data: {} }).catch(() => {});

      const sawOpRead = rec.requests.some((r) => r.path.startsWith("/api/v3/"));
      if (!sawOpRead) {
        test.info().annotations.push({
          type: "SPEC_16 users-collection guard",
          description: `no /api/v3/* read reached the recording mock during the Inc-16 flows (routes likely not landed) — absence assertion vacuous; skipping. Observed=${JSON.stringify([...new Set(rec.requests.map((r) => r.path))])}`,
        });
        test.skip(true, "Increment-16 flows did not exercise OP on the recording mock yet");
        return;
      }

      const usersCollectionHits = rec.requests.filter((r) => r.path === "/api/v3/users");
      test.info().annotations.push({
        type: "SPEC_16 users-collection guard",
        description:
          `Inc-16 flows hit these OP paths: ${JSON.stringify([...new Set(rec.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => `${r.method} ${r.path}`))])}. ` +
          `bare /api/v3/users hits=${usersCollectionHits.length}.`,
      });
      expect(
        usersCollectionHits.length,
        `SPEC_16 guardrail: the API issued GET /api/v3/users (the admin-gated user COLLECTION) ${usersCollectionHits.length}× while computing the Inc-16 numbers — it must NEVER call it (ids come from _links.assignee/accountable + GET /api/v3/memberships, Inc 13 §1a).`,
      ).toBe(0);
    } finally {
      if (recSprintId !== null) await setup.delete(`/api/sprints/${recSprintId}`).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (recConnId !== null) await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      if (rec !== null) await rec.close().catch(() => {});
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK B — §5 effectiveEstimate / Remaining work, on the s11 static backlog.
// ═════════════════════════════════════════════════════════════════════════════
const S11_SCENARIO = "s11-effective-estimate";
const S11_PROJECT = 3;
/** One row per branch of the SPEC_16 §5 rule (from s11-effective-estimate.ts). */
const EFF_CASES: ReadonlyArray<{ wp: number; work: number; remaining: number; effective: number; why: string }> = [
  { wp: 1901, work: 24, remaining: 18, effective: 18, why: "remaining != 0 and != work → remaining (spec #11765 example)" },
  { wp: 1902, work: 8, remaining: 8, effective: 8, why: "remaining == work → work (no false positive)" },
  { wp: 1903, work: 12, remaining: 0, effective: 12, why: "remaining == 0 → work" },
  { wp: 1904, work: 10, remaining: 3, effective: 3, why: "remaining != 0 and != work → remaining (small)" },
];

test.describe.serial("TI — SPEC_16 §5 effectiveEstimate / Remaining work (s11 backlog)", () => {
  let setup: APIRequestContext;
  let dbBefore: DbFingerprint | null;
  let scenarioMissing = false;
  let backlog: BacklogItemRow[] = [];

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    try {
      await loadScenario(setup, S11_SCENARIO);
    } catch (err) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TI §5] scenario "${S11_SCENARIO}" not loadable (Agent A fixture): ${String(err)}`);
      return;
    }
    const connId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${connId}`, { data: { current: true, enabled: true } });
    const sync = await setup.post("/api/sync", { data: { project_op_id: S11_PROJECT } });
    expect(sync.ok(), `sync project ${S11_PROJECT}: ${sync.status()} ${await sync.text()}`).toBeTruthy();
    const res = await setup.get(`/api/backlog?projectId=${S11_PROJECT}`);
    if (res.ok()) backlog = (await res.json()) as BacklogItemRow[];
  });

  test.afterAll(async () => {
    await setup?.dispose();
    assertRealDbUnchanged(dbBefore);
  });

  function itemOrSkip(wp: number): BacklogItemRow {
    test.skip(scenarioMissing, `Agent A fixture "${S11_SCENARIO}" not landed (scenario 404).`);
    const item = backlog.find((b) => b.op_id === wp);
    test.skip(!item, `WP ${wp} not present in GET /api/backlog — s11 fixture not synced or shape differs.`);
    const it = item as BacklogItemRow;
    test.skip(it.effective_hours === null || it.effective_hours === undefined, `WP ${wp} has no effective_hours — backlog field not populated.`);
    return it;
  }

  for (const c of EFF_CASES) {
    test(`§5: WP ${c.wp} (Work ${c.work}h / Remaining ${c.remaining}h) → effective ${c.effective}h — ${c.why}`, () => {
      const it = itemOrSkip(c.wp);
      test.info().annotations.push({
        type: "SPEC_16 §5 effectiveEstimate",
        description: `WP ${c.wp}: estimated_hours=${it.estimated_hours} remaining_hours=${it.remaining_hours} override_hours=${it.override_hours} effective_hours=${it.effective_hours} (expect ${c.effective})`,
      });
      // Sanity: the fixture really carries the Work/Remaining pair we reason about.
      if (it.estimated_hours !== null) expect(it.estimated_hours, `WP ${c.wp} Work`).toBeCloseTo(c.work, 3);
      if (it.remaining_hours !== null) expect(it.remaining_hours, `WP ${c.wp} Remaining`).toBeCloseTo(c.remaining, 3);
      // No local override in play here, so effective must equal the rule's output.
      expect(it.override_hours, `WP ${c.wp} has no local override in the baseline case`).toBeNull();
      expect(it.effective_hours as number, `WP ${c.wp} effective = ${c.effective}h (SPEC_16 §5)`).toBeCloseTo(c.effective, 3);
    });
  }

  // ── override precedence: a local override STILL wins over both remaining and
  //    work (SPEC_16 §5/§8 #3 — unchanged top precedence). Runs LAST so it doesn't
  //    perturb the base-case rows above. ──
  test("§5: a local estimate override wins over BOTH remaining and work (precedence unchanged, SPEC_16 §8 #3)", async () => {
    const it = itemOrSkip(1901); // Work 24 / Remaining 18 → 18 without an override.
    const OVERRIDE = 99;
    const res = await setup.post("/api/estimate-override", {
      data: { wp_op_id: 1901, planning_hours: OVERRIDE, note: "TI §5 override-precedence probe" },
    });
    test.skip(notImplemented(res.status()), "POST /api/estimate-override not landed.");
    expect(res.ok(), `POST /api/estimate-override: ${res.status()} ${await res.text()}`).toBeTruthy();

    const after = await setup.get(`/api/backlog?projectId=${S11_PROJECT}`);
    expect(after.ok(), `re-GET backlog: ${after.status()}`).toBeTruthy();
    const row = ((await after.json()) as BacklogItemRow[]).find((b) => b.op_id === 1901);
    expect(row, "WP 1901 still in backlog after override").toBeTruthy();
    test.info().annotations.push({
      type: "SPEC_16 §5 override precedence",
      description: `WP 1901 after override ${OVERRIDE}h: override_hours=${row?.override_hours} effective_hours=${row?.effective_hours} (remaining=${row?.remaining_hours}, work=${row?.estimated_hours})`,
    });
    expect(row?.override_hours, "override_hours reflects the local override").toBeCloseTo(OVERRIDE, 3);
    expect(row?.effective_hours as number, "override wins over remaining(18) AND work(24) — effective = 99h").toBeCloseTo(OVERRIDE, 3);
    // sanity: it did NOT fall through to the §5 remaining value.
    expect(row?.effective_hours as number, "override wins — NOT the remaining-work 18h").not.toBeCloseTo(18, 3);
  });
});

// ── page helper: open Reports → Detail for a given sprint id; false when any
//    step is unreachable (vault/connection gate, Reports/Detail not landed). ───
async function openReportDetail(page: import("@playwright/test").Page, sprintId: number): Promise<boolean> {
  try {
    const reportsTab = page.getByRole("button", { name: "Reports", exact: true });
    if (!(await reportsTab.isVisible({ timeout: 5000 }).catch(() => false))) return false;
    if (await reportsTab.isDisabled().catch(() => true)) return false;
    await reportsTab.click();
    const row = page.locator(`[data-testid="report-row-${sprintId}"]`);
    if (!(await row.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false))) return false;
    await row.getByRole("button", { name: "Detail" }).click();
    const detail = page.locator('[data-testid="report-detail"]');
    if (!(await detail.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false))) return false;
    // The closure-stats region is nested inside report-detail.
    const stats = page.locator('[data-testid="closure-stats"]').first();
    return await stats.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  } catch {
    return false;
  }
}
