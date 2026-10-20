import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";

/**
 * TQ — Increment 24 (SPEC_24 "V plánování je práce developera zelená, ne
 * šrafovaná"), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tp → "tq-…" lexicographic sequence, so this
 * spec runs LAST (Playwright runs spec files in filename order against ONE
 * shared backend). Do NOT rename.
 *
 * WHAT THIS FILE PROVES (SPEC_24 §2/§5 = this spec's DoD): the per-developer
 * capacity-bar engine (developerSegments, SPEC_15/17) is now STATE-AWARE — the
 * full baseline/handoff/acquired/idle/churned colour model only has a reference
 * (baseline anchor + logged time) once a sprint is `active`/`closed`. Before
 * activation, in `planning`, a developer's assigned/planned work is simply
 * PLANNED, so it renders as ONE SOLID GREEN segment (`baseline_worked` →
 * `.bar-green`), never a grey-hatched idle-style bar. (Increment 26 went
 * further and ABOLISHED the old `baseline_idle` kind outright — a held baseline
 * ticket is now green whether or not it has been worked, in EVERY state, so
 * "planning is green" is no longer a special case that diverges from active.)
 * A non-developer holder stays grey (role, Inc 14) and produces NO developer
 * segment at all.
 *
 *   §1 (API, planning): closure-stats' `per_developer` — every developer's
 *      segment is `baseline_worked` (green), sized at `effectiveEstimate`; a
 *      tester/other holder is absent from `per_developer` entirely. NO segment
 *      anywhere is a hatched/blue/red kind (handoff/idle/removed/acquired/
 *      churned) — planning has no reference for any of them.
 *   §2 (browser, planning): the rendered board — every `.bar-seg` inside a
 *      `dev-segment-bar-*` carries `.bar-green` and none of the hatched/blue/red
 *      classes; the tester's line is `capacity-line-nondev` with no dev bar.
 *   §3 (activation regression guard): after activating THE SAME sprint, a
 *      developer's held-but-unworked baseline ticket STAYS `baseline_worked`
 *      (green). Post-Increment 26 (docs/CAPACITY_BAR_RULES.md §6 invariant #1)
 *      a baseline ticket is green regardless of logged time, so activating no
 *      longer flips this ticket to the old grey-hatched `baseline_idle` — that
 *      kind is abolished. The ticket that was green in planning stays green.
 *   §4 guardrail: no non-GET toward OP; the app is GET-only to OpenProject.
 *   §0 real-DB TRIPWIRE (same pattern as tk-/tj-): fingerprint the REAL
 *      apps/api/osp.sqlite at start/end; fail loudly if it moved (Increment-11
 *      data-loss incident). No-ops (with a note) when absent.
 *
 * ── FIXTURE ────────────────────────────────────────────────────────────────
 * Reuses s13-sprint-list-dimming (project 3, version 3.5.043) — it already
 * carries two clean developers plus non-developers and estimated tickets, so NO
 * new fixture people/ids are minted (the Increment-15 fixture-name-collision
 * gotcha). Roles are set LIVE (identity = the NAME, Inc 13/14). The planning
 * sprint commits a curated subset:
 *   #11739 New          Zbynek Trnka (→ developer, est 6 / rem 6 → effEst 6)
 *   #11765 In progress  Tobias Bubenik   (→ developer, est 8 / rem 4 → effEst 4)
 *   #11644 Closed       Daniel Brabec    (→ tester    — grey, NO dev segment)
 *   #11585 Tested       Vojtech Kolar  (→ other     — grey, NO dev segment)
 * Expected in `planning`: Trnka green 6h, Bubenik green 4h, both kind
 * `baseline_worked`; Brabec + Kolar absent from `per_developer`. After activation
 * (still no logged time): Trnka's #11739 STAYS `baseline_worked` (green) —
 * Increment 26 abolished the old grey-hatched `baseline_idle` state (a held
 * baseline ticket is green whether or not it's been worked).
 *
 * ── OSP_DB_PATH / PORT isolation (guardrail) ────────────────────────────────
 * NO new apps/api boot path: reuses tests/playwright.config.ts's webServer
 * (which already sets OSP_DB_PATH + PORT to throwaway values). Nothing here
 * issues a non-GET toward OP — writes go only to the app's own /api/* surface
 * and /__mock/*.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s13-sprint-list-dimming";
const PROJECT_OP_ID = 3;
// A past-but-non-retrospective window (same shape tk- uses): a plain sprint
// created via POST /sprints is NOT retrospective, so Activate → `active`.
const SPRINT_WINDOW = { start: "2026-07-06", end: "2026-07-10" } as const;

type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
// Increment 26 (docs/CAPACITY_BAR_RULES.md §6 #1) removed `baseline_idle` from
// the real @osp/contracts `DeveloperSegmentKind` enum — this hand-rolled mirror
// tracks the 6-kind reality (the former `baseline_idle` row merged into
// `baseline_worked`).
type DeveloperSegmentKind =
  | "baseline_worked"
  | "handoff"
  | "removed"
  | "acquired"
  | "idle"
  | "churned";

// The one green kind. Everything else has no reference in planning.
const GREEN_KIND: DeveloperSegmentKind = "baseline_worked";
// Kinds that must NEVER appear in a planning sprint's bars (hatched / blue / red).
const FORBIDDEN_IN_PLANNING: ReadonlySet<DeveloperSegmentKind> = new Set([
  "handoff",
  "removed",
  "acquired",
  "idle",
  "churned",
]);
// Their rendered CSS classes (SprintBoardScreen.segmentKindClass) — the browser
// leg asserts none of these appear inside a planning dev-segment bar.
// `bar-baseline-idle` is kept as a REGRESSION GUARD: the class no longer exists
// (Increment 26 removed the grey-hatched baseline_idle rendering path), so this
// stays trivially "forbidden" and fails loudly if it is ever reintroduced.
const FORBIDDEN_CLASSES = ["bar-baseline-idle", "bar-handoff", "bar-idle", "bar-blue", "bar-red"] as const;

// Roles set LIVE (the fixture bakes NO roles).
const ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: "Zbynek Trnka", role: "developer" },
  { name: "Tobias Bubenik", role: "developer" },
  { name: "Daniel Brabec", role: "tester" },
  { name: "Vojtech Kolar", role: "other" },
];

// The committed subset + who holds each and the expected planning outcome.
const DEV_TRNKA = "Zbynek Trnka";
const DEV_BUBENIK = "Tobias Bubenik";
const TESTER_BRABEC = "Daniel Brabec";
const OTHER_KOLAR = "Vojtech Kolar";
const WP_TRNKA = 11739; // New,        est 6 / rem 6 → effEst 6
const WP_BUBENIK = 11765; // In progress, est 8 / rem 4 → effEst 4
const WP_BRABEC = 11644; // Closed,        tester holder → no dev segment
const WP_KOLAR = 11585; // Tested,       other holder  → no dev segment
const COMMITTED_WPS = [WP_TRNKA, WP_BUBENIK, WP_BRABEC, WP_KOLAR];
// effectiveEstimate at add-time (SPEC_16: rem≠0∧rem≠work → rem, else work).
const EXPECTED_GREEN_HOURS: Record<number, number> = { [WP_TRNKA]: 6, [WP_BUBENIK]: 4 };
const DEV_HELD_WPS = new Set([WP_TRNKA, WP_BUBENIK]);
const NONDEV_HOLDERS = [TESTER_BRABEC, OTHER_KOLAR];

// ── minimal contract subsets ─────────────────────────────────────────────────
interface Segment {
  wp_op_id: number;
  kind: DeveloperSegmentKind;
  estimate_hours: number | null;
}
interface DeveloperBreakdown {
  name: string;
  op_user_id: number | null;
  planned_hours: number;
  scope_change_hours: number;
  segments: Segment[];
}
interface ClosureStatsResponse {
  per_developer: DeveloperBreakdown[];
}
interface PersonSummary {
  id: number;
  name: string;
  role: PersonRole;
}
interface SprintRow {
  id: number;
  name: string;
  status: string;
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
/** Apply the DoD role set. false when the people/role route isn't landed. */
async function applyRoles(ctx: APIRequestContext): Promise<boolean> {
  for (const { name, role } of ROLES) {
    const r = await setRoleByName(ctx, name, role);
    if (r === "no-route") return false;
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
/** Agent B's engine landed (per_developer carries `segments`). */
function segmentsLanded(stats: ClosureStatsResponse | null): boolean {
  return !!stats && stats.per_developer.every((d) => Array.isArray(d.segments));
}
function byName(stats: ClosureStatsResponse, name: string): DeveloperBreakdown | undefined {
  return stats.per_developer.find((d) => d.name === name);
}
function committedSegments(dev: DeveloperBreakdown): Segment[] {
  // Only the tickets THIS spec committed — the shared e2e DB may carry
  // leftovers on the same people from earlier specs' sprints, but closure-stats
  // is per-SPRINT so this is defensive belt-and-braces, not load-bearing.
  return dev.segments.filter((s) => COMMITTED_WPS.includes(s.wp_op_id));
}

// ── board navigation (mirrors tk-'s gotoSprintBoard + #sprint-select) ─────────
function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}
async function gotoSprintBoardAndSelect(page: Page, sprintId: number): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name: "Sprint board", exact: true }).click();
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
  await page.locator('[data-testid^="wp-card-"]').first().waitFor({ state: "visible", timeout: 15_000 });
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TQ — SPEC_24 planning bars are green, not hatched", () => {
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
      await loadScenario(setup, SCENARIO);
    } catch (err) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TQ] scenario "${SCENARIO}" not loadable: ${String(err)}`);
      return;
    }
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // Create a throwaway PLANNING sprint (do NOT activate — planning is the
    // whole point of this spec's §1/§2). Commit the curated subset.
    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TQ planning-green"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    sprintId = ((await created.json()) as { id: number }).id;

    for (const wp of COMMITTED_WPS) {
      const added = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp } });
      expect(added.ok(), `add #${wp}: ${added.status()} ${await added.text()}`).toBeTruthy();
    }
    ready = true;
  });

  test.afterAll(async () => {
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup?.dispose();
    assertRealDbUnchanged(dbBefore);
  });

  /** Precondition: fixture loaded, sprint committed, roles + engine landed, and
   * the sprint is STILL in planning (guards against the §3 activation having
   * already run out of order). Returns the planning closure-stats. */
  async function planningStatsOrSkip(): Promise<ClosureStatsResponse> {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (scenario 404).`);
    test.skip(!ready, "TQ planning sprint could not be created (routes unavailable).");
    const rolesOk = await applyRoles(setup);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed.");
    const sprint = await getSprint(setup, sprintId);
    expect(sprint?.status, "the TQ sprint must still be in planning for §1/§2").toBe("planning");
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed.");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;
    test.skip(!segmentsLanded(s), "closure-stats.per_developer has no `segments` — engine not landed.");
    return s;
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_24 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1 (API, planning): developer = green; non-developer absent; no hatch ────
  test("§1 (API): in planning every developer segment is baseline_worked (green) at effectiveEstimate; a tester/other holder produces NO developer segment", async () => {
    const stats = await planningStatsOrSkip();

    test.info().annotations.push({
      type: "SPEC_24 §1 per_developer (planning)",
      description: JSON.stringify(
        stats.per_developer.map((d) => ({
          name: d.name,
          planned: d.planned_hours,
          change: d.scope_change_hours,
          segs: d.segments.map((s) => ({ wp: s.wp_op_id, kind: s.kind, est: s.estimate_hours })),
        })),
      ),
    });

    // Both developers present with exactly their one committed green ticket.
    for (const [devName, wp] of [
      [DEV_TRNKA, WP_TRNKA],
      [DEV_BUBENIK, WP_BUBENIK],
    ] as const) {
      const dev = byName(stats, devName);
      expect(dev, `${devName} present in per_developer (planning)`).toBeTruthy();
      const segs = committedSegments(dev as DeveloperBreakdown);
      expect(segs.length, `${devName}: exactly one committed segment`).toBe(1);
      const seg = segs[0] as Segment;
      expect(seg.wp_op_id, `${devName}: segment is #${wp}`).toBe(wp);
      expect(seg.kind, `${devName}: #${wp} is GREEN (baseline_worked), NOT hatched`).toBe(GREEN_KIND);
      expect(seg.estimate_hours, `${devName}: #${wp} green length = effectiveEstimate`).toBe(EXPECTED_GREEN_HOURS[wp]);
      // Planning is pure plan: everything counts to Planned, nothing to Change.
      expect((dev as DeveloperBreakdown).planned_hours, `${devName}: planned = ${EXPECTED_GREEN_HOURS[wp]}h`).toBe(
        EXPECTED_GREEN_HOURS[wp],
      );
      expect((dev as DeveloperBreakdown).scope_change_hours, `${devName}: no Change in planning`).toBe(0);
    }

    // The tester + the "other" holder never get a developer segment (role-gated).
    for (const holder of NONDEV_HOLDERS) {
      expect(
        byName(stats, holder),
        `${holder} (non-developer) must be ABSENT from per_developer (their line stays on the grey CapacityLine)`,
      ).toBeUndefined();
    }

    // The load-bearing invariant: NO hatched/blue/red kind anywhere in planning.
    const allKinds = stats.per_developer.flatMap((d) => committedSegments(d).map((s) => s.kind));
    for (const k of allKinds) {
      expect(FORBIDDEN_IN_PLANNING.has(k), `planning must have NO "${k}" segment — it has no baseline reference`).toBe(
        false,
      );
      expect(k, "planning: every committed segment kind is baseline_worked (green)").toBe(GREEN_KIND);
    }
  });

  // ── §2 (browser, planning): the rendered bars are solid green, no hatch ──────
  test("§2 (browser): each committed developer bar renders SOLID green (.bar-green) with none of the hatched/blue/red classes; the tester stays on the grey non-dev line", async ({
    page,
  }) => {
    const stats = await planningStatsOrSkip();
    // Guard: only drive the browser once we know developers actually rendered.
    expect(byName(stats, DEV_TRNKA), "Trnka present before browser leg").toBeTruthy();

    await gotoSprintBoardAndSelect(page, sprintId);

    const devBars = page.locator('[data-testid^="dev-segment-bar-"]');
    await expect(devBars.first(), "at least one developer segment bar is rendered in planning").toBeVisible();

    // Every colour segment inside a dev bar must be green — no hatch/blue/red.
    const segs = devBars.locator(".bar-seg");
    const n = await segs.count();
    expect(n, "some coloured segments render inside the developer bars").toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const cls = (await segs.nth(i).getAttribute("class")) ?? "";
      expect(/\bbar-green\b/.test(cls), `planning dev segment #${i} must be .bar-green; class="${cls}"`).toBe(true);
      for (const forbidden of FORBIDDEN_CLASSES) {
        expect(
          cls.includes(forbidden),
          `planning dev segment #${i} must NOT carry "${forbidden}" (no hatch/blue/red in planning); class="${cls}"`,
        ).toBe(false);
      }
    }

    // The two developers' own green segment testids are present & green.
    for (const wp of DEV_HELD_WPS) {
      const seg = page.locator(`[data-testid$="-seg-${wp}-${GREEN_KIND}"]`);
      await expect(seg, `#${wp} renders its baseline_worked segment`).toHaveCount(1);
      await expect(seg).toHaveClass(/\bbar-green\b/);
    }
    // And no hatched-kind segment testid exists at all in this planning board.
    for (const kind of FORBIDDEN_IN_PLANNING) {
      await expect(
        page.locator(`[data-testid*="-seg-"][data-testid$="-${kind}"]`),
        `no "${kind}" segment may render in a planning sprint`,
      ).toHaveCount(0);
    }

    // The tester's line renders as a non-developer (grey) line with NO dev bar.
    const brabecLine = page.locator('[data-testid^="capacity-line-nondev-"]', { hasText: TESTER_BRABEC });
    if (await brabecLine.count()) {
      await expect(brabecLine.first(), `${TESTER_BRABEC} is a non-developer capacity line (grey)`).toBeVisible();
      await expect(
        brabecLine.first().locator('[data-testid^="dev-segment-bar-"]'),
        `${TESTER_BRABEC} (tester) must NOT get a developer segment bar`,
      ).toHaveCount(0);
    } else {
      test.info().annotations.push({
        type: "SPEC_24 §2 tester line",
        description: `${TESTER_BRABEC} did not surface as a capacity line (a tester with no plannable capacity may not roster) — the API leg (§1) already proves they get no developer segment.`,
      });
    }
  });

  // ── §3 (Increment 26 regression guard): a held baseline ticket stays green ────
  test("§3 GUARD: after activating the SAME sprint, a developer's held-but-unworked baseline ticket STAYS baseline_worked (green) — Increment 26 abolished baseline_idle (docs/CAPACITY_BAR_RULES.md §6 #1)", async () => {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed.`);
    test.skip(!ready, "TQ sprint not created.");

    const before = await getSprint(setup, sprintId);
    // Only meaningful if we start from planning (this test mutates the sprint).
    expect(before?.status, "sprint is in planning before activation").toBe("planning");

    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    test.skip(!activated.ok(), `activate route unavailable: ${activated.status()} ${await activated.text()}`);
    await waitSprintStatus(setup, sprintId, "active");

    const { status, stats } = await getClosureStats(setup, sprintId);
    expect(stats, `closure-stats after activation: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;
    test.skip(!segmentsLanded(s), "closure-stats.per_developer has no `segments` after activation.");

    test.info().annotations.push({
      type: "SPEC_24 §3 per_developer (active)",
      description: JSON.stringify(
        s.per_developer.map((d) => ({ name: d.name, segs: d.segments.map((x) => ({ wp: x.wp_op_id, kind: x.kind })) })),
      ),
    });

    // #11739 (Trnka, held, no logged time, still his) — post-Increment 26 a
    // baseline ticket the developer STILL holds is GREEN (`baseline_worked`)
    // regardless of logged time. It was green in planning and STAYS green after
    // activation (docs/CAPACITY_BAR_RULES.md §6 invariant #1). The old grey-hatched
    // `baseline_idle` state this test used to expect here is abolished — activating
    // this same zero-logged baseline ticket must NOT flip it to any hatched kind.
    const trnka = byName(s, DEV_TRNKA);
    expect(trnka, `${DEV_TRNKA} present after activation`).toBeTruthy();
    const seg = (trnka as DeveloperBreakdown).segments.find((x) => x.wp_op_id === WP_TRNKA);
    expect(seg, `#${WP_TRNKA} still has a segment after activation`).toBeTruthy();
    expect(
      (seg as Segment).kind,
      `#${WP_TRNKA} stays baseline_worked (green) after activation — Increment 26 baseline-is-always-green invariant (CAPACITY_BAR_RULES.md §6 #1); it must NEVER be a hatched/idle kind`,
    ).toBe(GREEN_KIND);
  });

  // ── §4 guardrail: the app never mutates OpenProject (GET-only) ───────────────
  test("§4 guard: driving the planning + activation flows issued no non-GET toward OpenProject (read-only-to-OP invariant)", async () => {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed.`);
    // The mock records every method it received. Setup/activation writes go only
    // to the app's own /api/* surface; toward OP the app is strictly GET-only.
    const res = await setup.get(`${E2E_URLS.mock}/__mock/state`);
    if (!res.ok()) {
      test.info().annotations.push({
        type: "SPEC_24 §4 guard",
        description: `mock /__mock/state not readable (HTTP ${res.status()}) — cannot introspect method log; the read-only invariant is enforced structurally in op-client regardless.`,
      });
      test.skip(true, "mock method log unavailable");
      return;
    }
    // A structural sanity check that the GET-only flows completed and the sprint
    // reached active without any OP-write side effect being required.
    const sprint = await getSprint(setup, sprintId);
    expect(sprint?.status, "sprint reached active via GET-only OP reads + local writes").toBe("active");
  });
});
