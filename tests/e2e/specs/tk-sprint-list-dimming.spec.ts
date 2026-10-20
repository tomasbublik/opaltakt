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
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";

/**
 * TK — Increment 18 (SPEC_18 Sprint List Dimming), Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tj → "tk-…" lexicographic sequence, so this
 * spec runs LAST (Playwright runs spec files in filename order against ONE
 * shared backend). Do NOT rename.
 *
 * WHAT THIS FILE PROVES (SPEC_18 §3/§6 = this spec's DoD): sprint-list dimming
 * follows the SAME role-aware done-matrix as Closure (SPEC_14 §2), never a
 * hardcoded partial status list.
 *
 *   §1 Every matrix row: GET /sprints/:id/items/detailed returns the right
 *      `is_done`/`done_bucket` per ticket, AND the rendered card carries (or
 *      lacks) the `status-dimmed` class accordingly.
 *   §2 The role-unset ticket (#11818, Ondrej Marek — a name in no other
 *      fixture): NOT `status-dimmed`, and the card shows the "role?" badge.
 *   §3 THE GUARD TEST (SPEC_18 §3 "one source of truth"): a genuine
 *      cross-endpoint comparison over the FULL ticket set — for every wp_op_id,
 *      items/detailed's `is_done === true` IFF that wp is in closure-stats'
 *      `done` OR `rejected` bucket, and `is_done === false` IFF it's in
 *      `not_done` OR `ambiguous`. Not two independently-hardcoded expectations.
 *   §4 Guardrail: the API never issues GET /api/v3/users (admin-gated
 *      COLLECTION) while computing items/detailed + closure-stats.
 *   §0 real-DB TRIPWIRE (same pattern as tg-/tj-): fingerprint the REAL
 *      apps/api/osp.sqlite at start/end; fail loudly if it moved (Increment-11
 *      data-loss incident). No-ops (with a note) when absent.
 *
 * ── FIXTURE ────────────────────────────────────────────────────────────────
 * Drives s13-sprint-list-dimming (18 tickets on version 3.5.043, project 3)
 * covering every DoD row: always_done (Closed/Developed/Merge pending/Tested/
 * Resolved) → dim regardless of role; role_dependent + non-developer → dim;
 * role_dependent + developer → lit; Rejected → dim (separate closure bucket);
 * role_dependent + role-never-set → lit + "role?". Roles are set LIVE below
 * (identity = the NAME, Inc 13/14). Expected buckets once set: done 12 /
 * rejected 1 / not_done 4 / ambiguous 1.
 *
 * ── SEQUENCING (Agents B/C landing in parallel) ─────────────────────────────
 * At write time Agent B (items/detailed's `is_done`/`done_bucket`/`holder_role`)
 * and Agent C (`status-dimmed` from `is_done`, "role?" badge on ambiguous) land
 * concurrently. Each functional test PROBES its precondition and skips with a
 * PRECISE annotation until the piece arrives — it NEVER weakens a check to pass.
 * If items/detailed lacks the Inc-18 fields, the API-level tests skip loudly; if
 * the card markup isn't there, only the browser leg skips (the API leg still
 * bites). No silent-always-skip: every skip names exactly what is missing.
 *
 * ── OSP_DB_PATH / PORT isolation (guardrail) ────────────────────────────────
 * NO new apps/api boot path: reuses tests/playwright.config.ts's webServer
 * (which already sets OSP_DB_PATH + PORT) and, for §4, only spins up ephemeral
 * RECORDING MOCK OP servers (port 0, no DB). Nothing here issues a non-GET
 * toward OP — writes go only to the app's own /api/* surface and /__mock/*.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s13-sprint-list-dimming";
const PROJECT_OP_ID = 3;
const SPRINT_WINDOW = { start: "2026-07-06", end: "2026-07-10" } as const;

type PersonRole = "developer" | "tester" | "customer" | "other" | "unset";
type TicketDoneBucket = "done" | "not_done" | "rejected" | "ambiguous";

// Roles set LIVE (the fixture bakes NO roles). Ondrej Marek is DELIBERATELY
// absent — leaving his role `unset` is what makes #11818 ambiguous.
const ROLES: ReadonlyArray<{ name: string; role: PersonRole }> = [
  { name: "Vojtech Kolar", role: "other" },
  { name: "Jindrich Benda", role: "customer" },
  { name: "David Cesal", role: "customer" },
  { name: "Zbynek Trnka", role: "developer" },
  { name: "Tobias Bubenik", role: "developer" },
];

// ── the expected matrix (single source of truth for the §1 per-ticket checks;
//    the §3 GUARD deliberately does NOT use this — it cross-checks the two live
//    endpoints against each OTHER). ──────────────────────────────────────────
interface Expect {
  bucket: TicketDoneBucket;
  is_done: boolean;
  /** Asserted only where the ROLE is what drives the result. */
  holder_role?: PersonRole;
  label: string;
}
const EXPECTED: Record<number, Expect> = {
  // always_done — role irrelevant, DIM.
  11644: { bucket: "done", is_done: true, label: "Closed" },
  11762: { bucket: "done", is_done: true, label: "Closed" },
  11761: { bucket: "done", is_done: true, label: "Developed (held by a developer — still done)" },
  11687: { bucket: "done", is_done: true, label: "Developed (holder role unset — still done, NOT ambiguous)" },
  11785: { bucket: "done", is_done: true, label: "Merge pending" },
  11756: { bucket: "done", is_done: true, label: "Merge pending" },
  11585: { bucket: "done", is_done: true, label: "Tested" },
  11771: { bucket: "done", is_done: true, label: "Tested" },
  11625: { bucket: "done", is_done: true, label: "Resolved" },
  // role_dependent + non-developer holder — done VIA role, DIM.
  11212: { bucket: "done", is_done: true, holder_role: "other", label: "In progress + other" },
  11747: { bucket: "done", is_done: true, holder_role: "customer", label: "In progress + customer" },
  11726: { bucket: "done", is_done: true, holder_role: "customer", label: "On hold + customer" },
  // rejected — separate closure bucket, but DIMS.
  11633: { bucket: "rejected", is_done: true, label: "Rejected" },
  // role_dependent + developer holder — NOT done, LIT.
  11592: { bucket: "not_done", is_done: false, holder_role: "developer", label: "In progress + developer" },
  11765: { bucket: "not_done", is_done: false, holder_role: "developer", label: "In progress + developer" },
  11739: { bucket: "not_done", is_done: false, holder_role: "developer", label: "New + developer" },
  11797: { bucket: "not_done", is_done: false, holder_role: "developer", label: "Confirmed + developer" },
  // role_dependent + role-never-set holder — AMBIGUOUS, LIT + "role?".
  11818: { bucket: "ambiguous", is_done: false, label: "In progress + role UNSET (ambiguous)" },
};
const ALL_WP_IDS: number[] = Object.keys(EXPECTED).map(Number);
const AMBIGUOUS_WP = 11818;

// ── minimal contract subsets (Inc-18 fields present; a pre-Inc-18 response
//    simply fails the `hasInc18Fields` gate below and skips, never crashes). ──
interface DetailedItem {
  op_id: number;
  subject: string;
  status_name: string;
  is_done?: boolean;
  done_bucket?: TicketDoneBucket;
  holder_role?: PersonRole | null;
  ambiguous_reason?: string | null;
}
interface PersonSummary {
  id: number;
  name: string;
  role: PersonRole;
}
interface ClosureItem {
  wp_op_id: number;
  bucket: TicketDoneBucket;
}
interface ClosureBucket {
  count: number;
  items: ClosureItem[];
}
interface ClosureStatsResponse {
  done: ClosureBucket;
  not_done: ClosureBucket;
  rejected: ClosureBucket;
  ambiguous: ClosureBucket;
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
    // "not-found" tolerated per-name (person not materialized) — the matrix
    // assertions fail loudly if a role that mattered didn't take.
  }
  return true;
}
async function getDetailed(
  ctx: APIRequestContext,
  sprintId: number,
): Promise<{ status: number; items: DetailedItem[] | null }> {
  const res = await ctx.get(`/api/sprints/${sprintId}/items/detailed`);
  if (!res.ok()) return { status: res.status(), items: null };
  return { status: res.status(), items: (await res.json()) as DetailedItem[] };
}
async function getClosureStats(
  ctx: APIRequestContext,
  sprintId: number,
): Promise<{ status: number; stats: ClosureStatsResponse | null }> {
  const res = await ctx.get(`/api/sprints/${sprintId}/closure-stats`);
  if (!res.ok()) return { status: res.status(), stats: null };
  return { status: res.status(), stats: (await res.json()) as ClosureStatsResponse };
}
/** Agent B's Inc-18 enrichment landed: at least one item carries the fields. */
function hasInc18Fields(items: DetailedItem[] | null): boolean {
  return !!items && items.length > 0 && items.every((i) => typeof i.is_done === "boolean" && typeof i.done_bucket === "string");
}
function byOpId(items: DetailedItem[]): Map<number, DetailedItem> {
  return new Map(items.map((i) => [i.op_id, i]));
}

// ── board navigation (mirrors tg-'s gotoSprintBoard + #sprint-select) ─────────
function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}
async function gotoSprintBoardAndSelect(page: Page, sprintId: number): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name: "Sprint board", exact: true }).click();
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
  // The committed column renders once items/detailed resolves — wait for any card.
  await page.locator('[data-testid^="wp-card-"]').first().waitFor({ state: "visible", timeout: 15_000 });
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TK — SPEC_18 sprint-list dimming = the role-aware done-matrix", () => {
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
      console.warn(`[TK] scenario "${SCENARIO}" not loadable: ${String(err)}`);
      return;
    }
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // A throwaway, uniquely-named sprint in the e2e temp DB. No time entries in
    // s13, so NO retrospective replay is needed — dimming is a pure status×role
    // classification. Activate (captures the baseline) and leave it ACTIVE so
    // the board shows the committed cards.
    const created = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TK dimming"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    sprintId = ((await created.json()) as { id: number }).id;

    for (const wp of ALL_WP_IDS) {
      const added = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp } });
      expect(added.ok(), `add #${wp}: ${added.status()} ${await added.text()}`).toBeTruthy();
    }
    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    if (activated.ok()) {
      await waitSprintStatus(setup, sprintId, "active").catch(() => {});
      ready = true;
    }
  });

  test.afterAll(async () => {
    if (sprintId) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
    await setup?.dispose();
    assertRealDbUnchanged(dbBefore);
  });

  /** Precondition: fixture loaded, sprint ready, roles + Inc-18 fields landed. */
  async function detailedOrSkip(): Promise<DetailedItem[]> {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (scenario 404).`);
    test.skip(!ready, "TK dimming sprint could not be created/activated (routes unavailable).");
    const rolesOk = await applyRoles(setup);
    test.skip(!rolesOk, "GET/PUT /api/people role route not landed (Agent B).");
    const { status, items } = await getDetailed(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/items/detailed not landed.");
    expect(items, `items/detailed: HTTP ${status}`).not.toBeNull();
    const list = items as DetailedItem[];
    test.skip(
      !hasInc18Fields(list),
      "items/detailed rows lack `is_done`/`done_bucket` — Agent B's SPEC_18 §3 enrichment not landed yet.",
    );
    return list;
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_18 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops (invariant holds vacuously).`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1 (API leg): every matrix row's is_done/done_bucket matches the table ───
  test("§1 (API): items/detailed's is_done/done_bucket matches the role-aware matrix for every DoD ticket", async () => {
    const items = await detailedOrSkip();
    const map = byOpId(items);

    test.info().annotations.push({
      type: "SPEC_18 §1 items/detailed",
      description: JSON.stringify(
        ALL_WP_IDS.map((wp) => {
          const it = map.get(wp);
          return { wp, status: it?.status_name, bucket: it?.done_bucket, is_done: it?.is_done, role: it?.holder_role };
        }),
      ),
    });

    // Every seeded ticket is present.
    expect(map.size, `sprint committed exactly ${ALL_WP_IDS.length} tickets`).toBe(ALL_WP_IDS.length);

    for (const wp of ALL_WP_IDS) {
      const exp = EXPECTED[wp] as Expect;
      const it = map.get(wp);
      expect(it, `#${wp} (${exp.label}) present in items/detailed`).toBeTruthy();
      const item = it as DetailedItem;
      expect(item.done_bucket, `#${wp} (${exp.label}): done_bucket`).toBe(exp.bucket);
      expect(item.is_done, `#${wp} (${exp.label}): is_done (dim=${exp.is_done})`).toBe(exp.is_done);
      if (exp.holder_role !== undefined) {
        expect(item.holder_role, `#${wp} (${exp.label}): holder_role drives the result`).toBe(exp.holder_role);
      }
    }

    // is_done ⇔ bucket ∈ {done, rejected} (SPEC_18 §2/§6) — internal invariant.
    for (const it of items) {
      const dimmed = it.done_bucket === "done" || it.done_bucket === "rejected";
      expect(it.is_done, `#${it.op_id}: is_done must equal (done_bucket ∈ {done,rejected})`).toBe(dimmed);
    }
  });

  // ── §1 (browser leg): the card carries/omits `status-dimmed` accordingly ─────
  test("§1 (browser): each committed card has `status-dimmed` iff is_done — the dim class follows the matrix, not a hardcoded status list", async ({
    page,
  }) => {
    const items = await detailedOrSkip();
    const map = byOpId(items);
    await gotoSprintBoardAndSelect(page, sprintId);

    for (const wp of ALL_WP_IDS) {
      const exp = EXPECTED[wp] as Expect;
      const card = page.locator(`[data-testid="wp-card-${wp}"]`);
      await expect(card, `#${wp} (${exp.label}) card is rendered on the board`).toHaveCount(1);
      const cls = (await card.getAttribute("class")) ?? "";
      const dimmed = /\bstatus-dimmed\b/.test(cls);
      const itemDone = map.get(wp)?.is_done ?? false;
      // The card's dim state must equal BOTH the API's is_done AND the expected matrix.
      expect(dimmed, `#${wp} (${exp.label}): card status-dimmed must equal is_done (${itemDone}); class="${cls}"`).toBe(itemDone);
      expect(dimmed, `#${wp} (${exp.label}): card status-dimmed must equal the expected matrix (${exp.is_done})`).toBe(exp.is_done);
    }
  });

  // ── §2: the role-unset ticket stays LIT and shows the "role?" badge ──────────
  test("§2: the ambiguous (role-never-set) #11818 is NOT status-dimmed and shows the 'role?' badge (stays lit, never guessed)", async ({
    page,
  }) => {
    const items = await detailedOrSkip();
    const it = byOpId(items).get(AMBIGUOUS_WP);
    expect(it, `#${AMBIGUOUS_WP} present`).toBeTruthy();
    // API contract: ambiguous → not is_done, and an ambiguous_reason is set.
    expect((it as DetailedItem).done_bucket, `#${AMBIGUOUS_WP} bucket is ambiguous`).toBe("ambiguous");
    expect((it as DetailedItem).is_done, `#${AMBIGUOUS_WP} is NOT is_done (stays lit)`).toBe(false);
    expect(
      (it as DetailedItem).ambiguous_reason,
      `#${AMBIGUOUS_WP} carries an ambiguous_reason (role not set for the holder)`,
    ).toBeTruthy();

    await gotoSprintBoardAndSelect(page, sprintId);
    const card = page.locator(`[data-testid="wp-card-${AMBIGUOUS_WP}"]`);
    await expect(card, `#${AMBIGUOUS_WP} card rendered`).toHaveCount(1);
    const cls = (await card.getAttribute("class")) ?? "";
    expect(/\bstatus-dimmed\b/.test(cls), `#${AMBIGUOUS_WP}: ambiguous card must NOT be dimmed; class="${cls}"`).toBe(false);
    // The "role?" badge (Agent C). Scoped to THIS card so we never match another.
    await expect(
      card.getByText(/role\?/i),
      `#${AMBIGUOUS_WP}: the card shows a "role?" badge (SPEC_18 §5/§6 #2 — role-unset indicator)`,
    ).toBeVisible();
  });

  // ── §3 THE GUARD: cross-check items/detailed vs closure-stats over ALL tickets ─
  test("§3 GUARD: for EVERY ticket, items/detailed.is_done ⇔ it is in closure-stats' done|rejected bucket (one source of truth, cross-verified)", async () => {
    const items = await detailedOrSkip();
    const { status, stats } = await getClosureStats(setup, sprintId);
    test.skip(notImplemented(status), "GET /sprints/:id/closure-stats not landed (Agent B).");
    expect(stats, `closure-stats: HTTP ${status}`).not.toBeNull();
    const s = stats as ClosureStatsResponse;

    // Build closure-stats' per-wp bucket map from its four buckets.
    const closureBucket = new Map<number, TicketDoneBucket>();
    for (const b of [
      { name: "done" as const, bkt: s.done },
      { name: "not_done" as const, bkt: s.not_done },
      { name: "rejected" as const, bkt: s.rejected },
      { name: "ambiguous" as const, bkt: s.ambiguous },
    ]) {
      for (const it of b.bkt.items) closureBucket.set(it.wp_op_id, b.name);
    }

    const detailMap = byOpId(items);
    test.info().annotations.push({
      type: "SPEC_18 §3 cross-endpoint",
      description: JSON.stringify(
        ALL_WP_IDS.map((wp) => ({
          wp,
          detailed_is_done: detailMap.get(wp)?.is_done,
          closure_bucket: closureBucket.get(wp) ?? "MISSING",
        })),
      ),
    });

    // The full ticket set must be identical across both endpoints.
    expect(
      [...closureBucket.keys()].sort((a, z) => a - z),
      "closure-stats covers exactly the sprint's tickets",
    ).toEqual([...ALL_WP_IDS].sort((a, z) => a - z));

    // THE cross-check: is_done (items/detailed) ⇔ done|rejected (closure-stats),
    // NOT is_done ⇔ not_done|ambiguous. Computed from the two LIVE responses,
    // not from EXPECTED — this is the "one computation, verified" assertion.
    for (const wp of ALL_WP_IDS) {
      const isDone = detailMap.get(wp)?.is_done;
      const bucket = closureBucket.get(wp);
      const closureSaysDone = bucket === "done" || bucket === "rejected";
      const closureSaysNotDone = bucket === "not_done" || bucket === "ambiguous";
      expect(isDone, `#${wp}: items/detailed.is_done must be boolean`).toBe(typeof isDone === "boolean" ? isDone : undefined);
      expect(
        isDone === true,
        `#${wp}: items/detailed.is_done===true IFF closure-stats bucket ∈ {done,rejected} (bucket=${bucket})`,
      ).toBe(closureSaysDone);
      expect(
        isDone === false,
        `#${wp}: items/detailed.is_done===false IFF closure-stats bucket ∈ {not_done,ambiguous} (bucket=${bucket})`,
      ).toBe(closureSaysNotDone);
    }

    // Sanity on the fixture's spread so a degenerate all-done run can't pass silently.
    expect(s.done.count, "done bucket = 12").toBe(12);
    expect(s.rejected.count, "rejected bucket = 1").toBe(1);
    expect(s.not_done.count, "not_done bucket = 4").toBe(4);
    expect(s.ambiguous.count, "ambiguous bucket = 1").toBe(1);
  });

  // ── §4 GUARD: no GET /api/v3/users during the dimming read flows ─────────────
  test("§4 guard: no GET /api/v3/users (admin-gated COLLECTION) while computing items/detailed + closure-stats (SPEC_18 guardrails)", async () => {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed — nothing to drive against the recording mock.`);
    test.setTimeout(150_000);
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let recSprintId: number | null = null;
    try {
      rec = await createRecordingMockOpServer();
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);

      recConnId = await ensureConnection(setup, rec.url, "rec-guard-token-tk");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID, connection_id: recConnId } });
      expect(sync.ok(), `scoped sync to recording mock: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      const created = await setup.post("/api/sprints", {
        data: { name: uniqueSprintName("TK NoUsersColl"), start_date: SPRINT_WINDOW.start, end_date: SPRINT_WINDOW.end },
      });
      recSprintId = ((await created.json()) as { id: number }).id;
      for (const wp of ALL_WP_IDS) await setup.post(`/api/sprints/${recSprintId}/items`, { data: { wp_op_id: wp } });
      const activated = await setup.post(`/api/sprints/${recSprintId}/activate`);
      if (activated.ok()) await waitSprintStatus(setup, recSprintId, "active").catch(() => {});

      // Judge only the Inc-18 READ flows: clear the recording after setup.
      rec.reset();
      await setup.get("/api/people").catch(() => {});
      await applyRoles(setup).catch(() => {});
      await setup.get(`/api/sprints/${recSprintId}/items/detailed`).catch(() => {}); // dimming source
      await setup.get(`/api/sprints/${recSprintId}/closure-stats`).catch(() => {}); // the guard-test's other leg

      const sawOpRead = rec.requests.some((r) => r.path.startsWith("/api/v3/"));
      if (!sawOpRead) {
        test.info().annotations.push({
          type: "SPEC_18 users-collection guard",
          description: `no /api/v3/* read reached the recording mock during the Inc-18 flows (routes likely not landed) — absence assertion vacuous; skipping. Observed=${JSON.stringify([...new Set(rec.requests.map((r) => r.path))])}`,
        });
        test.skip(true, "Increment-18 flows did not exercise OP on the recording mock yet");
        return;
      }

      const usersCollectionHits = rec.requests.filter((r) => r.path === "/api/v3/users");
      test.info().annotations.push({
        type: "SPEC_18 users-collection guard",
        description:
          `Inc-18 flows hit these OP paths: ${JSON.stringify([...new Set(rec.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => `${r.method} ${r.path}`))])}. ` +
          `bare /api/v3/users hits=${usersCollectionHits.length}.`,
      });
      expect(
        usersCollectionHits.length,
        `SPEC_18 guardrail: the API issued GET /api/v3/users (the admin-gated user COLLECTION) ${usersCollectionHits.length}× while computing the dimming numbers — it must NEVER call it (roles come from local team_member + _links.assignee, Inc 13/14).`,
      ).toBe(0);
    } finally {
      if (recSprintId !== null) await setup.delete(`/api/sprints/${recSprintId}`).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (recConnId !== null) await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      if (rec !== null) await rec.close().catch(() => {});
    }
  });
});
