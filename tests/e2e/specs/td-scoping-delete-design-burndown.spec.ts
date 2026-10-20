import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { E2E_URLS } from "../../playwright.config";
import {
  advanceDay,
  ensureConnection,
  ensureVaultReady,
  loadScenario,
  uniqueSprintName,
  openWindowEnd,
} from "../fixtures/helpers";
import { SPRINT_STATUS_TESTID } from "../utils/selectors";

/**
 * TD — Increment 11 (SPEC_11_Scoping_Delete_Design_Burndown.md) regressions.
 *
 * FILE NAME NOTE: continues the t9 → ta → tb → tc lexicographic sequence (see
 * tc-…'s header). Playwright runs spec files in FILENAME order and "td-…" sorts
 * AFTER every t1–t9 / ta / tb / tc, so this spec runs LAST in the suite. Do NOT
 * rename it to "t10"/"t11" (which would sort BEFORE "t2").
 *
 * The cases, numbered per the SPEC_11 section list:
 *   §1  — CONNECTION-SCOPING GUARD (the hard requirement): a mock-only sprint's
 *         FULL lifecycle (activate → Update → ADD a new mock ticket to the now
 *         active sprint → finish) never contacts, and never surfaces
 *         CONNECTION_DISABLED for, a SECOND connection whose tickets aren't in
 *         the sprint. Proven structurally: the second connection is a genuinely
 *         unreachable host AND its stored health row is asserted byte-unchanged
 *         across the whole lifecycle (the scheduler is disabled in the e2e
 *         harness — OSP_DISABLE_SCHEDULER=1 — so the ONLY thing that could move
 *         its health is the operation contacting it). A regression to
 *         connection-enumeration therefore fails this test, not just the symptom.
 *   §2  — DELETE sprint: works in planning / active / finished-locked; UI modal
 *         cancel-then-confirm; sprint gone from the list; a fresh sprint with the
 *         same backlog ticket re-creates cleanly afterwards (no leftover state).
 *   §3  — DESIGN (functional, not pixel): the 4 semantic capacity-bar colors
 *         (green/grey/red/blue) still render as distinct elements; Developed/
 *         Tested/Resolved tickets get a dimmed treatment vs New/Confirmed/In
 *         progress.
 *   §4  — NO fabricated user names: the capacity panel never renders literal
 *         `User <id>`; an unresolvable user reads `Unknown user (<id>)`.
 *   §5  — parser / history / grey bar: the #11762-shaped reassignment+status
 *         chain surfaces BOTH the status transition and the reassignment, a
 *         `comment_added` row, no literal `undefined`, and the reassignment
 *         recipient gets a grey capacity segment.
 *   §6  — burndown Remaining: only New/Confirmed/In progress estimates count
 *         (On hold / Merge pending / Developed / Tested / Resolved / Closed /
 *         Rejected are excluded).
 *   §7  — burndown Logged is monotonic (never decreases day-over-day).
 *   §8  — closure: "View / regenerate closure report" (POST /close) does NOT
 *         lock a running sprint; Reactivate works only inside the start–end
 *         window (409 REACTIVATE_WINDOW_CLOSED past the end date).
 *   §9  — velocity: real per-closed-sprint totals + per-connection breakdown;
 *         explicit empty state when there are no closed sprints.
 *
 * GUARDRAIL (unchanged, do NOT duplicate t7-guardrails): nothing here issues a
 * non-GET toward OP — the only writes are to the app's own /api/* surface and
 * the mock's /__mock/* admin API. No token is read or asserted anywhere.
 *
 * ⚠️ INTEGRATION NOTE (Agents B/C landing in parallel): several UI-level
 * assertions use best-guess role/text locators for controls that did not exist
 * when this was written (Delete sprint + modal, Reactivate + modal, the
 * dev-done "dimmed" class). Each is tagged `// TODO(integration):` — grep for
 * that marker to reconcile selectors once the frontend lands. The load-bearing
 * guarantees are ALSO asserted at the frozen-contract API level so they hold
 * regardless of the eventual DOM.
 */

const PROJECT_OP_ID = 3;
const MOCK_BASE = E2E_URLS.mock; // http://127.0.0.1:8199 — the reachable, healthy server

// A genuinely-unreachable loopback host for the §1 guard's "second connection".
// Nothing listens on 8195 (ECONNREFUSED). Distinct from tc's 8196/8197 and t7's
// 8198 so this file's teardown only removes connections IT created. Using a dead
// host (not merely a disabled flag) means ANY attempt to contact it as part of a
// scoped sprint operation would visibly change its health row / raise an error —
// which is exactly what the guard asserts must NOT happen.
const DEAD_SCOPE_BASE = "http://127.0.0.1:8195";

const S5_SCENARIO = "s5-burndown-happy"; // 5 mock WPs (1501..1505), project 3
const S2_SCENARIO = "s2-status-spectrum"; // 1 WP per canonical status (1201..1210)
const S7_SCENARIO = "s7-tester-roundtrip"; // #11762 reassignment chain, project 3
const S7_WP = 11762;

// ── minimal contract subsets we assert on ────────────────────────────────────
interface SprintRow {
  id: number;
  status: string;
  is_locked?: boolean;
  lock_reason?: string | null;
  start_date: string;
  end_date: string;
}
interface ConnHealth {
  last_activity_at: string | null;
  last_check_at: string | null;
  last_status: string;
  last_latency_ms: number | null;
  last_error: string | null;
}
interface ConnRow {
  id: number;
  base_url: string;
  enabled: boolean;
  health: ConnHealth;
}
interface HealthResp {
  aggregate: string;
  connections: ConnRow[];
}
interface CapLine {
  op_user_id: number | null;
  name: string;
  available_hours: number;
  planned_hours: number;
  redistributed_in_hours: number;
  redistributed_out_hours: number;
}
interface CapResp {
  lines: CapLine[];
}
interface BurndownPoint {
  date: string;
  ideal_hours: number;
  remaining_hours: number | null;
  logged_hours: number | null;
  done_count: number | null;
  total_count: number | null;
}
interface BurndownResp {
  sprint_id: number;
  points: BurndownPoint[];
}
interface VelocityBreakdown {
  connection_id: number;
  base_url: string;
  completed_hours: number;
}
interface VelocityEntry {
  sprint_id: number;
  name: string;
  completed_hours: number;
  planned_hours: number;
  by_connection: VelocityBreakdown[];
}
interface VelocityResp {
  history: VelocityEntry[];
  average_completed_hours: number | null;
}
interface ChangelogEntry {
  kind: string;
  detail: Record<string, unknown>;
  /** "journal" | "time_entry" | "local" — the FOLLOWUPS #8 gating reads it. */
  source: string;
}

// ── navigation helpers (same shape as tc-…) ──────────────────────────────────
function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}
async function gotoTab(page: Page, name: string, exact = true): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name, exact }).click();
}
async function selectSprint(page: Page, sprintId: number): Promise<void> {
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
}

/** Activation is ASYNC (SPEC_09 §1): poll the list until the requested status. */
async function waitSprintStatus(
  ctx: APIRequestContext,
  sprintId: number,
  status: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.get("/api/sprints");
    if (res.ok()) {
      const sprint = ((await res.json()) as SprintRow[]).find((s) => s.id === sprintId);
      if (sprint?.status === status) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`sprint ${sprintId} did not reach status "${status}" within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function getSprint(ctx: APIRequestContext, id: number): Promise<SprintRow | undefined> {
  const res = await ctx.get("/api/sprints");
  if (!res.ok()) return undefined;
  return ((await res.json()) as SprintRow[]).find((s) => s.id === id);
}

async function createSprint(
  ctx: APIRequestContext,
  label: string,
  start = "2026-07-01",
  end = "2026-07-31",
): Promise<number> {
  const res = await ctx.post("/api/sprints", {
    data: { name: uniqueSprintName(label), start_date: start, end_date: end },
  });
  expect(res.ok(), `create sprint: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: number }).id;
}

async function addItem(ctx: APIRequestContext, sprintId: number, wpOpId: number): Promise<void> {
  const res = await ctx.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wpOpId } });
  expect(res.ok(), `add item ${wpOpId}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function getHealth(ctx: APIRequestContext): Promise<HealthResp> {
  const res = await ctx.get("/api/connections/health");
  expect(res.ok(), `health: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as HealthResp;
}

async function addConnection(ctx: APIRequestContext, baseUrl: string): Promise<number> {
  const conns = (await (await ctx.get("/api/connections")).json()) as ConnRow[];
  const existing = conns.find((c) => c.base_url === baseUrl);
  if (existing) return existing.id;
  const res = await ctx.post("/api/connections", {
    data: { base_url: baseUrl, token: "e2e-td-dead-token" },
  });
  expect(res.ok(), `add ${baseUrl}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: number }).id;
}

async function deleteConnectionByBase(ctx: APIRequestContext, baseUrl: string): Promise<void> {
  const conns = (await (await ctx.get("/api/connections")).json()) as ConnRow[];
  const found = conns.find((c) => c.base_url === baseUrl);
  if (found) await ctx.delete(`/api/connections/${found.id}`);
}

function findConn(h: HealthResp, baseUrl: string): ConnRow | undefined {
  return h.connections.find((c) => c.base_url === baseUrl);
}

test.describe.serial("TD — SPEC_11 scoping / delete / design / burndown / velocity", () => {
  let setup: APIRequestContext;
  let mockConnId: number;

  test.beforeAll(async () => {
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
  });

  test.afterAll(async () => {
    await deleteConnectionByBase(setup, DEAD_SCOPE_BASE).catch(() => {});
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } }).catch(() => {});
    await setup.dispose();
  });

  // ── §1 — CONNECTION-SCOPING GUARD (the hard requirement) ─────────────────────
  test("§1: a mock-only sprint's activate/Update/ADD/finish never contact or surface CONNECTION_DISABLED for an unrelated, unreachable connection", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // A SECOND connection, present but pointing at a genuinely unreachable host,
    // and DISABLED — this reproduces the exact reported bug (a disabled acme
    // connection → CONNECTION_DISABLED) AND, because the host is dead, ANY
    // attempt to actually contact it (e.g. an enumeration that ignores the
    // enabled flag) would leave a fresh error / probe timestamp on its health
    // row. It has ZERO tickets in the sprint, so a correctly-scoped operation
    // must never touch it.
    await deleteConnectionByBase(setup, DEAD_SCOPE_BASE);
    const deadId = await addConnection(setup, DEAD_SCOPE_BASE);
    await setup.patch(`/api/connections/${deadId}`, { data: { enabled: false } });
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });

    try {
      await loadScenario(setup, S5_SCENARIO);
      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
      expect(sync.ok(), `sync: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      // Baseline snapshot of the dead connection's stored health. With the
      // scheduler disabled in the harness (OSP_DISABLE_SCHEDULER=1), nothing but
      // an explicit contact can move these fields — so an unchanged snapshot at
      // the end PROVES the dead connection was never contacted (structural
      // guard), not merely that a CONNECTION_DISABLED error was swallowed.
      const before = findConn(await getHealth(setup), DEAD_SCOPE_BASE);
      expect(before, "dead connection must be registered").toBeTruthy();
      const beforeHealth = JSON.stringify(before?.health);

      // Sprint whose ONLY tickets are sourced from the mock server.
      const sprintId = await createSprint(setup, "TD Scope Guard");
      await addItem(setup, sprintId, 1501);

      // Helper: assert the dead connection's health row is byte-identical to the
      // baseline (never probed) after each lifecycle step.
      const assertDeadUntouched = async (label: string): Promise<void> => {
        const now = findConn(await getHealth(setup), DEAD_SCOPE_BASE);
        expect(
          JSON.stringify(now?.health),
          `[${label}] the unrelated, unreachable connection's health row changed — it was contacted by a scoped op (enumeration regression)`,
        ).toBe(beforeHealth);
        expect(now?.enabled, `[${label}] dead connection must still be disabled`).toBe(false);
      };

      // (1) ACTIVATE (async, scoped) — no CONNECTION_DISABLED, dead one untouched.
      const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
      expect(activated.ok(), `activate: ${activated.status()} ${await activated.text()}`).toBeTruthy();
      const activateBody = await activated.text();
      expect(activateBody, "activation must not mention CONNECTION_DISABLED").not.toMatch(
        /CONNECTION_DISABLED|is disconnected/i,
      );
      await waitSprintStatus(setup, sprintId, "active");
      await assertDeadUntouched("after activate");

      // (2) UPDATE (scoped diff pass).
      const upd = await setup.post(`/api/sprints/${sprintId}/update`);
      expect(upd.ok(), `update: ${upd.status()} ${await upd.text()}`).toBeTruthy();
      expect(await upd.text()).not.toMatch(/CONNECTION_DISABLED|is disconnected/i);
      await assertDeadUntouched("after update");

      // (3) ADD a NEW mock ticket to the now-ACTIVE sprint — THE reported §1 bug
      // (baseline read-back of the new WP must go against the WP's OWN connection,
      // the mock, not enumerate all connections).
      const added = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: 1502 } });
      expect(added.ok(), `add-on-active: ${added.status()} ${await added.text()}`).toBeTruthy();
      expect(await added.text()).not.toMatch(/CONNECTION_DISABLED|is disconnected/i);
      await assertDeadUntouched("after add-on-active");

      // (4) FINISH (final scoped update + lock).
      const finished = await setup.post(`/api/sprints/${sprintId}/finish`);
      expect(finished.ok(), `finish: ${finished.status()} ${await finished.text()}`).toBeTruthy();
      expect(await finished.text()).not.toMatch(/CONNECTION_DISABLED|is disconnected/i);
      await waitSprintStatus(setup, sprintId, "closed");
      await assertDeadUntouched("after finish");

      // (5) UI cross-check: no error banner anywhere on the sprint board.
      await gotoTab(page, "Sprint board", true);
      await selectSprint(page, sprintId);
      await expect(page.locator(".msg.error")).toHaveCount(0);
      await expect(page.getByText(/CONNECTION_DISABLED|is disconnected/i)).toHaveCount(0);
    } finally {
      await deleteConnectionByBase(setup, DEAD_SCOPE_BASE).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } }).catch(() => {});
    }
  });

  // ── §2 — DELETE sprint in every state + re-create cleanly ────────────────────
  test("§2: delete works in planning/active/finished, and a fresh sprint re-creates cleanly afterwards", async () => {
    test.setTimeout(120_000);

    await loadScenario(setup, S5_SCENARIO);
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync: ${sync.status()}`).toBeTruthy();

    const delSprint = async (id: number): Promise<void> => {
      const res = await setup.delete(`/api/sprints/${id}`);
      expect(res.ok(), `delete sprint ${id}: ${res.status()} ${await res.text()}`).toBeTruthy();
      const body = (await res.json()) as { sprint_id: number; deleted: boolean };
      expect(body).toMatchObject({ sprint_id: id, deleted: true });
      expect(await getSprint(setup, id), `sprint ${id} must be gone from the list`).toBeUndefined();
    };

    // (a) PLANNING
    const planning = await createSprint(setup, "TD Delete Planning");
    await addItem(setup, planning, 1501);
    await delSprint(planning);

    // (b) ACTIVE
    const active = await createSprint(setup, "TD Delete Active");
    await addItem(setup, active, 1502);
    const act = await setup.post(`/api/sprints/${active}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, active, "active");
    await delSprint(active);

    // (c) FINISHED / locked
    const finished = await createSprint(setup, "TD Delete Finished");
    await addItem(setup, finished, 1503);
    const act2 = await setup.post(`/api/sprints/${finished}/activate`);
    expect(act2.ok(), `activate: ${act2.status()}`).toBeTruthy();
    await waitSprintStatus(setup, finished, "active");
    const fin = await setup.post(`/api/sprints/${finished}/finish`);
    expect(fin.ok(), `finish: ${fin.status()} ${await fin.text()}`).toBeTruthy();
    await waitSprintStatus(setup, finished, "closed");
    await delSprint(finished);

    // (d) Re-create with the SAME backlog ticket — proves no leftover
    // sprint_item / ticket_baseline / unique-constraint state blocks a new sprint.
    const reborn = await createSprint(setup, "TD Delete Reborn");
    await addItem(setup, reborn, 1501); // same WP as the first, now-deleted sprint
    const act3 = await setup.post(`/api/sprints/${reborn}/activate`);
    expect(act3.ok(), `re-activate after delete: ${act3.status()} ${await act3.text()}`).toBeTruthy();
    await waitSprintStatus(setup, reborn, "active");
    await delSprint(reborn); // tidy up
  });

  // ── §2 (UI) — Delete modal cancel-then-confirm on a planning sprint ──────────
  test("§2(UI): the Delete-sprint modal cancels without deleting, then deletes on confirm", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await loadScenario(setup, S5_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TD Delete UI");
    await addItem(setup, sprintId, 1504);

    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("planning");

    // TODO(integration): Agent C adds a red "Delete sprint" button + an "Are you
    // sure?" modal (SPEC_11 §2). Selectors below are best-guess role/text; adjust
    // once the UI lands. The deletion OUTCOME is verified against GET /sprints so
    // only the button/modal wiring is speculative.
    const deleteBtn = page.getByRole("button", { name: /delete sprint/i });
    const opened = await deleteBtn
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      test.info().annotations.push({
        type: "SPEC_11 §2 UI",
        description: "Delete-sprint button not found — Agent C's control not landed yet; API-level §2 covers the guarantee.",
      });
      await setup.delete(`/api/sprints/${sprintId}`); // clean up
      test.skip(true, "Delete-sprint UI control not present yet");
      return;
    }

    // Cancel path: open the modal, dismiss it, sprint still present.
    await deleteBtn.click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: /cancel|no/i }).click();
    await expect(modal).toBeHidden();
    expect(await getSprint(setup, sprintId), "cancel must NOT delete").toBeTruthy();

    // Confirm path: open again, confirm, sprint gone.
    await deleteBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: /delete|yes|confirm/i }).click();
    await expect
      .poll(async () => getSprint(setup, sprintId), { timeout: 10_000 })
      .toBeUndefined();
  });

  // ── §3 — DESIGN: 4 distinct semantic bar colors + dimmed dev-done tickets ────
  test("§3: the 4 semantic capacity-bar colors stay distinct, and Developed/Tested/Resolved tickets are dimmed", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // s2 gives one WP per canonical status: 1201 New, 1203 In progress, 1204
    // Developed (dimmed), etc. Build a planning sprint holding a New, an In
    // progress, and a Developed ticket so both the capacity bar (assignees) and
    // the dev-done dimming are on screen.
    await loadScenario(setup, S2_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TD Design");
    await addItem(setup, sprintId, 1201); // New (assignee dev)
    await addItem(setup, sprintId, 1203); // In progress (assignee dev)
    await addItem(setup, sprintId, 1204); // Developed (assignee tester) — dev-done

    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);

    // (a) The four semantic bar classes (green/grey/red/blue) keep distinct
    // computed backgrounds — the functional guard that a redesign didn't
    // collapse the semantic palette (NOT any exact hex; Agent C owns values).
    // Identity unification: every person now has a per-developer closure row
    // (the capacity "unset → developer" default), so no live line is
    // guaranteed to render the plain aggregate bar with all four spans any
    // more — and a NON-developer line deliberately repaints its spans grey
    // (`.capacity-line-nondev`). The palette itself is what this test pins, so
    // measure it on a synthetic bar mounted in the normal (non-nondev)
    // capacity-line context. `.bar-blue` is a striped gradient: compare the
    // full computed `background` (image + color), not backgroundColor alone.
    const capPanel = page.locator("section.panel", {
      has: page.getByRole("heading", { name: "Capacity", exact: true }),
    });
    await expect(capPanel).toBeVisible();
    const colors = await page.evaluate(() => {
      // The e2e tsconfig loads only the node lib — reach DOM APIs through a
      // loosely-typed globalThis (same pattern as the getComputedStyle calls
      // elsewhere in this file).
      interface LooseEl {
        className: string;
        appendChild(c: LooseEl): void;
        querySelector(sel: string): LooseEl;
        remove(): void;
      }
      const g = globalThis as unknown as {
        document: { createElement(tag: string): LooseEl; body: LooseEl };
        getComputedStyle(e: LooseEl): { backgroundColor: string; backgroundImage: string };
      };
      const host = g.document.createElement("div");
      host.className = "capacity-line";
      const bar = g.document.createElement("div");
      bar.className = "bar";
      host.appendChild(bar);
      const classes = ["bar-green", "bar-grey", "bar-red", "bar-blue"];
      for (const cls of classes) {
        const seg = g.document.createElement("span");
        seg.className = `bar-seg ${cls}`;
        bar.appendChild(seg);
      }
      g.document.body.appendChild(host);
      const out: Record<string, string> = {};
      for (const cls of classes) {
        const style = g.getComputedStyle(bar.querySelector(`.${cls}`));
        out[cls] = `${style.backgroundColor} | ${style.backgroundImage}`;
      }
      host.remove();
      return out;
    });
    const distinct = new Set(Object.values(colors));
    expect(
      distinct.size,
      `the 4 semantic bar colors must be visually distinct, got ${JSON.stringify(colors)}`,
    ).toBe(4);

    // (b) Developed/Tested/Resolved tickets get SOME dimmed treatment vs
    // New/In progress. We compare the computed opacity (and/or a dimming class)
    // of the Developed card against the New card.
    // TODO(integration): Agent C implements the dimming (SPEC_11 §3/#6). If it's
    // a class rather than opacity, extend the check; the intent is "visually
    // distinguishable, more muted".
    const newCard = page.locator(".card", { hasText: "New" }).first();
    const devCard = page.locator(".card", { hasText: "Developed" }).first();
    await expect(newCard).toBeVisible();
    await expect(devCard).toBeVisible();
    const opacityOf = (l: Locator) =>
      l.evaluate(
        (el) => Number((globalThis as unknown as { getComputedStyle(e: unknown): { opacity: string } }).getComputedStyle(el).opacity),
      );
    const classOf = (l: Locator) => l.evaluate((el) => el.className);
    const [newOpacity, devOpacity, newClass, devClass] = await Promise.all([
      opacityOf(newCard),
      opacityOf(devCard),
      classOf(newCard),
      classOf(devCard),
    ]);
    const dimmedByOpacity = devOpacity < newOpacity;
    const dimmedByClass =
      /dim|muted|done|dev-?done|faded|complete/i.test(devClass) &&
      !/dim|muted|done|dev-?done|faded|complete/i.test(newClass);
    if (!dimmedByOpacity && !dimmedByClass) {
      test.info().annotations.push({
        type: "SPEC_11 §3 dev-done dimming",
        description: `no dimming detected yet (newOpacity=${newOpacity} devOpacity=${devOpacity} devClass="${devClass}") — Agent C not landed; reconcile the dimming selector.`,
      });
    }
    expect(
      dimmedByOpacity || dimmedByClass,
      "a Developed ticket must be visually dimmed vs a New ticket (SPEC_11 §3/#6)",
    ).toBeTruthy();
  });

  // ── §4 — no fabricated `User <id>` in capacity ───────────────────────────────
  test("§4: the capacity panel never renders a fabricated `User <id>`; unknown users read `Unknown user (<id>)`", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // s7's #11762 activities carry `_links.user` WITHOUT a title (verbatim from
    // the production fixture), so any actor/assignee whose name can't be resolved
    // is the exact §4 trigger. Build+activate a sprint over it and drive the
    // timeline so assignees flow through the capacity roster.
    await loadScenario(setup, S7_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TD No Fabricated User", "2026-07-06", "2026-07-31");
    await addItem(setup, sprintId, S7_WP);
    const act = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });
    await setup.post(`/api/sprints/${sprintId}/update`);

    // API-level GUARD (robust): no capacity line's name is a bare `User <id>`.
    const cap = (await (await setup.get(`/api/sprints/${sprintId}/capacity`)).json()) as CapResp;
    for (const line of cap.lines) {
      expect(line.name, `capacity line name must not be a fabricated User id: "${line.name}"`).not.toMatch(
        /^User \d+$/,
      );
    }
    // Any unresolved user must read "Unknown user (<id>)" — never bare "User <id>".
    const unknowns = cap.lines.filter((l) => /unknown user/i.test(l.name));
    for (const u of unknowns) {
      expect(u.name, "unknown-user label must include the id in parentheses").toMatch(
        /Unknown user \(\d+\)/i,
      );
    }

    // UI-level: the Capacity panel text never contains `User <number>`.
    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    const capPanel = page.locator("section.panel", {
      has: page.getByRole("heading", { name: "Capacity", exact: true }),
    });
    await expect(capPanel).toBeVisible();
    await expect(capPanel.getByText(/^User \d+$/)).toHaveCount(0);
  });

  // ── §5 — #11762 parser: reassignment + status + comment; grey for receiver ───
  test("§5: the #11762-shaped chain surfaces status + reassignment + comment (no `undefined`), and the recipient gets a grey capacity segment", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // TODO(integration): the definitive #11762 chain (Cameron Dalby → … →
    // Daniel Brabec → Jan Bily, developed→tested, comment_added) lives in the
    // production fixture (fixture_op_activities_11762.sample.json). Agent A is
    // reshaping the mock `activities` (incl. s7) to that exact form. This test
    // asserts the GENERAL properties (both a status transition AND a reassignment
    // appear, a comment_added, no `undefined`) against s7 so it holds whether or
    // not Agent A's developed→tested extension has landed; tighten to the exact
    // Jan-Bily chain once the mock matches the fixture.
    await loadScenario(setup, S7_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TD 11762 Parser", "2026-07-06", "2026-07-31");
    await addItem(setup, sprintId, S7_WP);
    const act = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });
    await setup.post(`/api/sprints/${sprintId}/update`);

    const entries = (await (
      await setup.get(`/api/sprints/${sprintId}/tickets/${S7_WP}/changelog`)
    ).json()) as ChangelogEntry[];

    // CORE GUARD (always asserted, even if the clock filtered every journal —
    // see the clock caveat in tc §d): NO `undefined` / `unrecognized property`
    // garbage anywhere, and every entry has a well-formed discriminated detail.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/undefined/i);
    expect(serialized).not.toMatch(/unrecognized/i);
    for (const e of entries) {
      expect((e.detail as { kind?: string }).kind, `entry ${e.kind} detail.kind missing`).toBeTruthy();
    }

    const statusChanges = entries.filter((e) => e.kind === "status_changed");
    const assignChanges = entries.filter((e) => e.kind === "assignee_changed");
    const comments = entries.filter((e) => e.kind === "comment_added");
    test.info().annotations.push({
      type: "SPEC_11 §5 changelog observed",
      description: `total=${entries.length} status=${statusChanges.length} assignee=${assignChanges.length} comment=${comments.length}`,
    });

    // ⚠️ CLOCK CAVEAT (same as tc §d): the sprintUpdate parser only keeps
    // activities with createdAt >= activated_at, and s7's journals are stamped on
    // the mock's logical calendar. When the harness wall-clock is AT/AFTER those
    // dates, every journal is filtered out. So assert PRESENCE strictly only
    // when JOURNAL-sourced entries came through; the parser proper is
    // unit-tested in @osp/op-client. FOLLOWUPS #8: time_logged rows now derive
    // by spent_on (calendar window), not createdAt — they arrive even when the
    // clock filters every journal, so gating on "any entries at all" would
    // spuriously arm the journal assertions.
    const journalEntries = entries.filter((e) => e.source === "journal");
    if (journalEntries.length > 0) {
      expect(
        assignChanges.length,
        "the reassignment(s) must NOT be silently dropped (SPEC_11 §5b)",
      ).toBeGreaterThan(0);
      expect(
        statusChanges.length,
        "the status transition(s) must NOT be silently dropped (SPEC_11 §5b)",
      ).toBeGreaterThan(0);
      expect(comments.length, "a content-free comment_added must appear (SPEC_11 §5c)").toBeGreaterThan(0);
      expect(comments[0]?.detail).toEqual({ kind: "comment_added" });

      // Grey for the reassignment RECIPIENT (SPEC_11 §5a): whoever received a
      // reassigned baseline ticket carries redistributed_in_hours > 0 (the grey
      // segment) — even beyond their own capacity, and even if they didn't exist
      // in the roster at activation.
      const cap = (await (await setup.get(`/api/sprints/${sprintId}/capacity`)).json()) as CapResp;
      const greyReceiver = cap.lines.find((l) => l.redistributed_in_hours > 0);
      expect(
        greyReceiver,
        "the reassignment recipient must get a grey (redistributed_in) capacity segment",
      ).toBeTruthy();
    }

    // UI: if the ticket has history, its changelog dialog shows no garbage.
    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    const historyBtn = page.getByRole("button", { name: `View changelog for #${S7_WP}` });
    const hasHistory = await historyBtn
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (hasHistory) {
      await historyBtn.click();
      const dialog = page.getByRole("dialog", { name: new RegExp(`#${S7_WP}.*changelog`) });
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toContainText(/undefined/i);
      await expect(dialog).not.toContainText(/unrecognized/i);
    } else {
      test.info().annotations.push({
        type: "SPEC_11 §5 UI",
        description: "History button absent (no entries survived the clock filter); parser garbage still guarded at API level.",
      });
    }
  });

  // ── §6 — burndown Remaining counts only New/Confirmed/In progress ────────────
  test("§6: burndown Remaining excludes dev-done statuses (On hold/Merge pending/Developed/Tested/Resolved/Closed/Rejected)", async () => {
    test.setTimeout(90_000);

    // s2 = one WP per status, each estimate 8h, with explicit remaining:
    //   New 8, Confirmed 6, In progress 3  → dev-pending (counted): 17h
    //   Developed 0, Merge pending 1, Tested 0, On hold 4, Rejected 0,
    //   Resolved 0, Closed 0             → excluded.
    // A sprint over ALL of them must burn-down "Remaining" from the dev-pending
    // set only. The discriminating guard: the On hold (4h) + Merge pending (1h)
    // remaining must NOT be included — a regression to "all open statuses" would
    // push Remaining to 22h. We assert Remaining == 17 (exact) AND, as the
    // non-fragile guard, that it is strictly below the all-open total (22).
    await loadScenario(setup, S2_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TD Remaining Rule", "2026-07-01", openWindowEnd());
    for (let id = 1201; id <= 1210; id += 1) await addItem(setup, sprintId, id);
    const act = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");

    const bd = (await (await setup.get(`/api/sprints/${sprintId}/burndown`)).json()) as BurndownResp;
    const firstReal = bd.points.find((p) => p.remaining_hours != null);
    expect(firstReal, "burndown must have at least one real (non-future) point").toBeTruthy();
    const remaining = firstReal!.remaining_hours!;
    test.info().annotations.push({
      type: "SPEC_11 §6 remaining observed",
      description: `remaining_hours=${remaining} (expected 17 = New8+Confirmed6+InProgress3)`,
    });
    // Non-fragile guard first: On hold + Merge pending must be excluded, so
    // Remaining must be strictly below the all-open-statuses total (22h).
    expect(remaining, "Remaining must exclude On hold + Merge pending (dev-done rule)").toBeLessThan(22);
    // Exact expectation (New8+Confirmed6+InProgress3). If Agent B's formula uses
    // estimates rather than remaining this differs — the annotation records the
    // observed value for a quick reconcile.
    expect(remaining).toBeCloseTo(17, 1);

    await setup.delete(`/api/sprints/${sprintId}`); // tidy up
  });

  // ── §7 — burndown Logged is monotonic ────────────────────────────────────────
  test("§7: burndown Logged never decreases day-over-day (cumulative)", async () => {
    test.setTimeout(120_000);

    await loadScenario(setup, S5_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TD Logged Monotonic", "2026-07-01", "2026-07-31");
    for (const id of [1501, 1502, 1503]) await addItem(setup, sprintId, id);
    const act = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");

    // Drive several days (some log time, "today" logs nothing) + snapshots, then
    // read the burndown series. The cumulative-Logged fix (SPEC_11 §7) means the
    // logged_hours line must only ever rise or stay flat — never fall to 0 on a
    // no-logging day (the reported bug).
    for (let day = 1; day <= 4; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api, snapshot: true });
    }
    await setup.post("/api/snapshot");
    await setup.post(`/api/sprints/${sprintId}/update`);

    const bd = (await (await setup.get(`/api/sprints/${sprintId}/burndown`)).json()) as BurndownResp;
    const logged = bd.points
      .map((p) => p.logged_hours)
      .filter((v): v is number => v != null);
    test.info().annotations.push({
      type: "SPEC_11 §7 logged series",
      description: JSON.stringify(logged),
    });
    for (let i = 1; i < logged.length; i += 1) {
      expect(
        logged[i]!,
        `Logged must be monotonic (cumulative): point ${i} (${logged[i]}) < point ${i - 1} (${logged[i - 1]})`,
      ).toBeGreaterThanOrEqual(logged[i - 1]!);
    }
    // Numbers are rounded to 1 decimal across the chart (SPEC_11 §7 bonus).
    for (const v of logged) {
      expect(Math.round(v * 10) / 10, `logged value ${v} must be rounded to 1 dp`).toBe(v);
    }

    await setup.delete(`/api/sprints/${sprintId}`); // tidy up
  });

  // ── §8 — closure view/regenerate does NOT lock + Reactivate window ───────────
  test("§8: POST /close on an active sprint does NOT lock it; Reactivate works inside the window and 409s past the end date", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await loadScenario(setup, S5_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });

    // (a) A running sprint. Generating/viewing its closure report (POST /close)
    // must be READ-ONLY w.r.t. lock state — the core §8a regression.
    const running = await createSprint(setup, "TD Closure NoLock", "2026-07-01", openWindowEnd());
    await addItem(setup, running, 1501);
    const act = await setup.post(`/api/sprints/${running}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, running, "active");

    const closeRes = await setup.post(`/api/sprints/${running}/close`);
    expect(closeRes.ok(), `close (view report): ${closeRes.status()} ${await closeRes.text()}`).toBeTruthy();
    const afterClose = await getSprint(setup, running);
    expect(afterClose?.status, "viewing the closure report must NOT change status").toBe("active");
    expect(afterClose?.is_locked ?? false, "viewing the closure report must NOT lock the sprint").toBe(false);
    // Regenerate again — still read-only.
    await setup.post(`/api/sprints/${running}/close`);
    const afterClose2 = await getSprint(setup, running);
    expect(afterClose2?.status).toBe("active");
    expect(afterClose2?.is_locked ?? false).toBe(false);

    // UI cross-check: on the Closure screen, the button on an ACTIVE sprint
    // ("Close sprint & generate report") builds the report without locking.
    // TODO(integration): if Agent C relabels this control, adjust the name regex.
    await gotoTab(page, "Closure", true);
    await selectSprint(page, running);
    const closeBtn = page.getByRole("button", {
      name: /close sprint & generate report|regenerate report|view \/ regenerate closure report/i,
    });
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      // Give the report a moment, then re-check state via API.
      await page.waitForTimeout(500);
      const afterUiClose = await getSprint(setup, running);
      expect(afterUiClose?.is_locked ?? false, "UI closure view must not lock").toBe(false);
      expect(afterUiClose?.status).toBe("active");
    }
    await setup.delete(`/api/sprints/${running}`); // tidy up

    // (b) Reactivate INSIDE the window: a finished sprint whose [start,end]
    // brackets today can be reactivated → active again. The end date MUST be
    // computed from the real clock — reactivation is gated on `new Date()`, not
    // on the mock's day counter, so a hardcoded end date silently turns this
    // case into (c) once it falls into the past.
    const inWindow = await createSprint(setup, "TD Reactivate In", "2026-07-01", openWindowEnd());
    await addItem(setup, inWindow, 1502);
    await setup.post(`/api/sprints/${inWindow}/activate`);
    await waitSprintStatus(setup, inWindow, "active");
    const fin = await setup.post(`/api/sprints/${inWindow}/finish`);
    expect(fin.ok(), `finish: ${fin.status()} ${await fin.text()}`).toBeTruthy();
    await waitSprintStatus(setup, inWindow, "closed");
    const react = await setup.post(`/api/sprints/${inWindow}/reactivate`);
    expect(react.ok(), `reactivate in-window: ${react.status()} ${await react.text()}`).toBeTruthy();
    const reacted = (await react.json()) as SprintRow;
    expect(reacted.status, "reactivated sprint must be active again").toBe("active");
    expect(reacted.is_locked ?? false, "reactivated sprint must be unlocked").toBe(false);
    // Update works again post-reactivation (add/update controls re-enabled).
    const updAfter = await setup.post(`/api/sprints/${inWindow}/update`);
    expect(updAfter.ok(), `update after reactivate: ${updAfter.status()} ${await updAfter.text()}`).toBeTruthy();
    await setup.delete(`/api/sprints/${inWindow}`); // tidy up

    // (c) Reactivate PAST the window: a finished sprint whose end_date is already
    // in the past (2026-06-30 < today) must NOT be reactivatable → 409
    // REACTIVATE_WINDOW_CLOSED, and the Reactivate control must be absent in UI.
    const pastWindow = await createSprint(setup, "TD Reactivate Past", "2026-06-01", "2026-06-30");
    await addItem(setup, pastWindow, 1503);
    await setup.post(`/api/sprints/${pastWindow}/activate`);
    await waitSprintStatus(setup, pastWindow, "active");
    const fin2 = await setup.post(`/api/sprints/${pastWindow}/finish`);
    expect(fin2.ok(), `finish past: ${fin2.status()} ${await fin2.text()}`).toBeTruthy();
    await waitSprintStatus(setup, pastWindow, "closed");
    const react2 = await setup.post(`/api/sprints/${pastWindow}/reactivate`);
    expect(react2.status(), "reactivate past the end date must be rejected").toBe(409);
    expect(await react2.text()).toMatch(/REACTIVATE_WINDOW_CLOSED/i);

    // UI: the Reactivate button must be absent for a past-window locked sprint.
    // TODO(integration): Agent C gates a "Reactivate" button on the window
    // (SPEC_11 §8b). Adjust the name regex once the control lands.
    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, pastWindow);
    await expect(page.getByRole("button", { name: /reactivate/i })).toHaveCount(0);
    await setup.delete(`/api/sprints/${pastWindow}`); // tidy up
  });

  // ── §9 — velocity: real totals + per-connection breakdown + empty state ──────
  test("§9: velocity shows real per-closed-sprint totals with a per-connection breakdown (and an empty state when none are closed)", async () => {
    test.setTimeout(120_000);

    // NOTE: velocity is a per-sprint route (GET /sprints/:id/velocity) that
    // returns the GLOBAL closed-sprint history + average. Because td runs last in
    // a shared-backend suite, earlier specs likely already closed sprints — the
    // empty-state (history == [] ⇒ average null, "No closed sprints yet" copy) is
    // therefore asserted opportunistically (only WHEN history is empty), and the
    // real-data path below is the primary guarantee.
    // TODO(integration): to force the empty state deterministically, run this
    // spec first against a fresh OSP_DB_PATH.

    await loadScenario(setup, S5_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });

    // Create + finish a sprint with mock tickets that have logged time, so it
    // contributes REAL (non-placeholder) completed_hours to velocity.
    const sprintId = await createSprint(setup, "TD Velocity", "2026-07-01", "2026-07-31");

    // Opportunistic empty-state check: read the GLOBAL history via this (still
    // planning) sprint BEFORE we close anything. If no sprint has been closed yet
    // (fresh DB), the contract requires an empty history with a null average.
    const preVel = (await (await setup.get(`/api/sprints/${sprintId}/velocity`)).json()) as VelocityResp;
    if (preVel.history.length === 0) {
      expect(preVel.average_completed_hours, "empty history ⇒ null average").toBeNull();
    } else {
      test.info().annotations.push({
        type: "SPEC_11 §9 empty-state",
        description: `history already non-empty (${preVel.history.length}) from earlier specs — empty state needs a fresh OSP_DB_PATH to assert.`,
      });
    }

    for (const id of [1501, 1502]) await addItem(setup, sprintId, id);
    await setup.post(`/api/sprints/${sprintId}/activate`);
    await waitSprintStatus(setup, sprintId, "active");
    for (let day = 1; day <= 3; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api, snapshot: true });
    const fin = await setup.post(`/api/sprints/${sprintId}/finish`);
    expect(fin.ok(), `finish: ${fin.status()} ${await fin.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "closed");

    // GET /sprints/:id/velocity deliberately EXCLUDES sprint :id from its own
    // returned history (routes/index.ts: `.filter((s) => s.id !== id)`) — a
    // sprint's velocity view doesn't compare itself to itself. So the
    // just-closed sprint must be looked up via a DIFFERENT sprint's velocity
    // call, not its own.
    const viewerSprintId = await createSprint(setup, "TD Velocity viewer", "2026-08-01", "2026-08-07");
    const vel = (await (await setup.get(`/api/sprints/${viewerSprintId}/velocity`)).json()) as VelocityResp;
    const entry = vel.history.find((h) => h.sprint_id === sprintId);
    expect(entry, "the just-closed sprint must appear in velocity history").toBeTruthy();
    // Real data, not a placeholder: numeric completed/planned hours + a
    // per-connection breakdown that attributes to a real stored connection and
    // sums to completed_hours (SPEC_11 §9 — single-server sprint still gets a
    // single-entry array).
    expect(Number.isFinite(entry!.completed_hours)).toBe(true);
    expect(Number.isFinite(entry!.planned_hours)).toBe(true);
    expect(entry!.by_connection.length, "per-connection breakdown must be present").toBeGreaterThan(0);
    const breakdownSum = entry!.by_connection.reduce((s, b) => s + b.completed_hours, 0);
    expect(breakdownSum, "per-connection hours must sum to the sprint total").toBeCloseTo(
      entry!.completed_hours,
      1,
    );
    for (const b of entry!.by_connection) {
      expect(b.base_url, "breakdown entry must carry a real connection base_url").toBeTruthy();
      expect(b.connection_id, "breakdown entry must carry a connection id").toBeTruthy();
    }
    // The mock-only sprint attributes entirely to the mock server.
    expect(
      entry!.by_connection.some((b) => b.base_url === MOCK_BASE),
      "a mock-only sprint's completed hours must attribute to the mock connection",
    ).toBeTruthy();

    // TODO(integration): the MULTI-server breakdown (>1 base_url) needs a sprint
    // spanning two REACHABLE servers with tickets — the suite only wires a
    // DEAD/ticket-less second connection today. Assert the multi-server split in
    // Phase 2 with a second reachable mock (pnpm mock:op2). Structure is verified
    // above; the split logic is unit-tested in apps/api/logic/velocity.

    await setup.delete(`/api/sprints/${sprintId}`); // tidy up
  });

  // ── Increment 36 — any-state sprint status PDF ───────────────────────────────
  // POST /sprints/:id/status-pdf must stream a real PDF for a PLANNING sprint
  // and for a LOCKED/finished one alike (the whole point is "generate at any
  // moment and send it to delivery managers"). Real server + real Chromium —
  // the HTML-level number equality lives in apps/api unit tests.
  test("Increment 36: the status PDF streams for a planning AND a finished sprint", async () => {
    test.setTimeout(120_000);
    await loadScenario(setup, S5_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });

    const sprintId = await createSprint(setup, "TD Status PDF", "2026-07-01", "2026-07-31");
    for (const id of [1501, 1502]) await addItem(setup, sprintId, id);

    // Planning state.
    const planningPdf = await setup.post(`/api/sprints/${sprintId}/status-pdf`);
    expect(planningPdf.ok(), `planning status-pdf: ${planningPdf.status()}`).toBeTruthy();
    expect(planningPdf.headers()["content-type"]).toContain("application/pdf");
    const planningBytes = await planningPdf.body();
    expect(planningBytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(planningBytes.length).toBeGreaterThan(5_000);

    // Finished/locked state.
    await setup.post(`/api/sprints/${sprintId}/activate`);
    await waitSprintStatus(setup, sprintId, "active");
    const fin = await setup.post(`/api/sprints/${sprintId}/finish`);
    expect(fin.ok(), `finish: ${fin.status()} ${await fin.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "closed");

    const closedPdf = await setup.post(`/api/sprints/${sprintId}/status-pdf`);
    expect(closedPdf.ok(), `closed status-pdf: ${closedPdf.status()}`).toBeTruthy();
    expect((await closedPdf.body()).subarray(0, 4).toString("latin1")).toBe("%PDF");

    await setup.delete(`/api/sprints/${sprintId}`); // tidy up
  });
});
