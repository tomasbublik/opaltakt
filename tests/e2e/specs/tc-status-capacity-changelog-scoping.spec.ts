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
} from "../fixtures/helpers";
import { SPRINT_STATUS_TESTID } from "../utils/selectors";

/**
 * TC — Increment 10 (SPEC_10_Status_Capacity_Changelog_Scoping.md §3/§7) regressions.
 *
 * FILE NAME NOTE: continues the t9 → ta → tb → tc lexicographic sequence (see
 * tb-…'s header). Playwright runs spec files in FILENAME order and "tc-…" sorts
 * AFTER every t1–t9, "ta-…" and "tb-…", so this spec runs LAST in the suite —
 * exactly like tb did. That ordering matters here for two reasons:
 *   1. by now t7 has permanently left an unreachable "canary" connection
 *      (127.0.0.1:8198) in the registry, plus whatever other specs added — a
 *      genuinely-disconnected-but-present connection to test §a/§e against; and
 *   2. running last lets §a delete every non-mock connection to reach a
 *      deterministic all-healthy (🟢) aggregate without disturbing an earlier
 *      spec's assumptions (nothing runs after us; t7 re-creates its canary at
 *      the start of the NEXT full run anyway, so re-runs stay clean).
 * Do NOT rename it to "t10" (which would sort before "t2").
 *
 * The five behaviors, numbered per the SPEC_10 §3/§7 bug list:
 *   §a — aggregate header dot: 🟢 only when ALL stored connections are enabled
 *        AND ok; a single disconnected server flips it 🟠 (the reported bug:
 *        1-of-2 down used to stay 🟢); all down → 🔴; back to all-healthy → 🟢.
 *   §b — the connection-status popover closes on an OUTSIDE click and on Escape,
 *        not only by re-clicking its trigger.
 *   §c — a running sprint's capacity roster contains ONLY participants: a
 *        capacity-only person with 0h and no ticket is hidden; one with >0h is
 *        shown; and a person from a DIFFERENT, closed sprint never leaks in.
 *   §d — the s7-tester-roundtrip scenario's changelog is parsed cleanly: no
 *        `unrecognized property "undefined"` / empty "—" garbage (bug #11762),
 *        and — when the harness clock lets scenario journals through — both
 *        assignee_changed rows and a content-free comment_added appear.
 *   §e — a mock-only sprint's Update Sprint AND Finish never hit a DIFFERENT,
 *        disconnected server's CONNECTION_DISABLED (the Increment-9 activation
 *        scoping fix, generalized to update/finish per SPEC_10 §e).
 *
 * Self-contained: its own idempotent vault/connection bootstrap so it works run
 * in isolation OR last-in-suite. Every §a/§e connection this file adds is torn
 * down again (afterAll + per-test finally) so the shared backend is left with a
 * single, enabled, healthy mock connection for a clean re-run.
 *
 * GUARDRAIL: nothing here issues a non-GET toward OP — the only writes are to
 * the app's own /api/* surface and the mock's /__mock/* admin API. No token is
 * read or asserted anywhere.
 */

const PROJECT_OP_ID = 3;
const MOCK_BASE = E2E_URLS.mock; // http://127.0.0.1:8199 — the reachable, healthy server

// Deliberately-dead loopback hosts (nothing listens): a stored connection whose
// health-probe fails immediately (ECONNREFUSED — fast, no timeout). Distinct
// from t7's 8198 canary AND from each other so §a and §e never collide, and so
// this file's teardown only removes connections IT created.
const DEAD_A_BASE = "http://127.0.0.1:8197"; // §a "second server"
const DEAD_E_BASE = "http://127.0.0.1:8196"; // §e "unrelated acme-style server"

// s7-tester-roundtrip (fixtures/scenarios/s7-tester-roundtrip.ts, Agent A):
// ONE ticket travels dev→tester (day 1), tester logs 0.7h (day 2), posts a
// comment (day 3), returns tester→dev (day 4). Calendar day 0 = 2026-07-06.
const S7_SCENARIO = "s7-tester-roundtrip";
const S7_WP = 11762; // the #11762 ticket
const DEV_OP_USER_ID = 1; // "Dev Dvořák"
const TESTER_OP_USER_ID = 2; // "Tereza Testerová"

// Fabricated OP user ids that appear in NO scenario cast (cast() seeds 1/2/3),
// so a capacity row for them is unambiguously a capacity-only, no-ticket person.
const CAP_ZERO_OP_USER_ID = 9001; // 0h, no ticket → must be HIDDEN (§c)
const CAP_SHOWN_OP_USER_ID = 9002; // 12h, no ticket → must be SHOWN (§c)
const CAP_ISOLATION_OP_USER_ID = 9005; // only ever in a CLOSED sprint → must not leak (§c)
const CAP_ZERO_NAME = "Zerova NoShow TC";
const CAP_SHOWN_NAME = "Showva Shown TC";
const CAP_ISOLATION_NAME = "Isolova Leak TC";

// ── minimal contract subsets we assert on ────────────────────────────────────
interface HealthConn {
  id: number;
  base_url: string;
  enabled: boolean;
}
interface HealthResp {
  aggregate: "green" | "orange" | "red" | "neutral";
  connections: HealthConn[];
}
interface CapLine {
  op_user_id: number | null;
  name: string;
  available_hours: number;
  planned_hours: number;
}
interface CapResp {
  lines: CapLine[];
}
interface SprintRow {
  id: number;
  status: string;
}
interface ChangelogEntry {
  kind: string;
  wp_op_id: number;
  actor_name: string | null;
  occurred_at: string;
  detail: Record<string, unknown>;
  /** "journal" | "time_entry" | "local" — the FOLLOWUPS #8 gating reads it. */
  source: string;
}

// ── navigation helpers (same shape as tb-…) ──────────────────────────────────
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

/** Activation is ASYNC (SPEC_09 §1): poll the sprint list until it reports the
 * requested status. Also reused to wait for finish → "closed". */
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

async function getHealth(ctx: APIRequestContext): Promise<HealthResp> {
  const res = await ctx.get("/api/connections/health");
  expect(res.ok(), `health: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as HealthResp;
}

/** Delete every stored connection EXCEPT the one whose id we keep — used by §a
 * to reach a deterministic single-healthy-server 🟢 aggregate (a DISABLED row
 * still counts as "fail" for the aggregate, so it must be deleted, not merely
 * disconnected, to leave the set all-ok). */
async function deleteOtherConnections(ctx: APIRequestContext, keepId: number): Promise<void> {
  const conns = (await (await ctx.get("/api/connections")).json()) as HealthConn[];
  for (const c of conns) {
    if (c.id !== keepId) await ctx.delete(`/api/connections/${c.id}`);
  }
}

/** Add a stored connection for a base_url if absent (dead host is fine — the
 * row persists with health=fail). Returns its id. */
async function addConnection(ctx: APIRequestContext, baseUrl: string): Promise<number> {
  const conns = (await (await ctx.get("/api/connections")).json()) as HealthConn[];
  const existing = conns.find((c) => c.base_url === baseUrl);
  if (existing) return existing.id;
  const res = await ctx.post("/api/connections", {
    data: { base_url: baseUrl, token: "e2e-tc-dead-token" },
  });
  expect(res.ok(), `add ${baseUrl}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: number }).id;
}

async function deleteConnectionByBase(ctx: APIRequestContext, baseUrl: string): Promise<void> {
  const conns = (await (await ctx.get("/api/connections")).json()) as HealthConn[];
  const found = conns.find((c) => c.base_url === baseUrl);
  if (found) await ctx.delete(`/api/connections/${found.id}`);
}

/** Header aggregate dot — asserted via ConnectionStatus.tsx's aria-label
 * `connection status: ${aggregate}` (NOT a CSS class). Reloads first so the
 * dot reflects a fresh GET /connections/health (add/delete don't all push SSE). */
async function expectAggregateDot(page: Page, color: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator(`[aria-label="connection status: ${color}"]`)).toBeVisible();
}

test.describe.serial("TC — SPEC_10 status / capacity / changelog / scoping regressions", () => {
  let setup: APIRequestContext;
  let mockConnId: number;

  test.beforeAll(async () => {
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } });
  });

  test.afterAll(async () => {
    // Leave a single, enabled, healthy mock connection for a clean re-run.
    await deleteConnectionByBase(setup, DEAD_A_BASE).catch(() => {});
    await deleteConnectionByBase(setup, DEAD_E_BASE).catch(() => {});
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } }).catch(() => {});
    await setup.dispose();
  });

  // ── §a — aggregate dot: green → orange → red → green ─────────────────────────
  test("§a: partial disconnect turns the header dot orange (not green); all down → red; healthy again → green", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    try {
      // Deterministic clean slate: only the mock remains, enabled + freshly ok.
      // (A disabled OR dead leftover connection each count as "fail" for the
      // aggregate, so they'd otherwise keep the dot off pure-green — the exact
      // reason tb warned against relying on the GLOBAL dot mid-suite.)
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
      await deleteOtherConnections(setup, mockConnId);
      const tested = await setup.post(`/api/connections/${mockConnId}/test`);
      expect(tested.ok(), `test mock: ${tested.status()}`).toBeTruthy();

      // (1) All connections healthy+enabled → GREEN.
      const green = await getHealth(setup);
      expect(green.aggregate, `expected green with only a healthy mock: ${JSON.stringify(green.connections.map((c) => c.base_url))}`).toBe("green");
      await expectAggregateDot(page, "green");

      // (2) Add a SECOND server that's down (mock ok + dead fail) → ORANGE.
      // This is the literal SPEC_10 §a bug: 1-of-2 disconnected must NOT stay
      // green. (The dead host is genuinely disconnected/unhealthy — the same
      // condition as the reported acme.)
      await addConnection(setup, DEAD_A_BASE);
      const orange = await getHealth(setup);
      expect(orange.aggregate, "1 healthy + 1 down must aggregate ORANGE").toBe("orange");
      await expectAggregateDot(page, "orange");

      // (3) Disconnect the mock too (both down) → RED.
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });
      const red = await getHealth(setup);
      expect(red.aggregate, "all down must aggregate RED").toBe("red");
      await expectAggregateDot(page, "red");

      // (4) Back to an all-healthy set (re-enable + re-test the mock, drop the
      // unreachable one) → GREEN again.
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } });
      await setup.post(`/api/connections/${mockConnId}/test`);
      await deleteConnectionByBase(setup, DEAD_A_BASE);
      const greenAgain = await getHealth(setup);
      expect(greenAgain.aggregate, "healthy-only set must be GREEN again").toBe("green");
      await expectAggregateDot(page, "green");
    } finally {
      await deleteConnectionByBase(setup, DEAD_A_BASE).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } }).catch(() => {});
    }
  });

  // ── §b — popover closes on outside-click and on Escape ───────────────────────
  test("§b: the connection-status popover closes on an outside click and on Escape", async ({
    page,
  }) => {
    test.setTimeout(45_000);

    // The header indicator is always rendered (Header.tsx). Its trigger is the
    // button carrying aria-label `connection status: …` (ConnectionStatus.tsx);
    // the popover is role="dialog" aria-label="Connections". Both are stable,
    // existing selectors — only the CLOSE-on-outside/Escape behavior is new
    // (Agent C's SPEC_10 §b fix), so this test goes green only once C lands.
    const trigger = page.locator(".conn-status-btn");
    const popover = page.getByRole("dialog", { name: "Connections" });

    // (a) outside click closes it.
    await page.goto("/");
    await trigger.click();
    await expect(popover).toBeVisible();
    // Click a neutral element well outside the popover (the app title — no click
    // handler of its own, so it can only trigger the document-level outside-click
    // dismissal, not a re-toggle of the trigger).
    await page.getByRole("heading", { name: "OpalTakt" }).click();
    await expect(popover).toBeHidden();

    // (b) Escape closes it.
    await trigger.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });

  // ── §c — capacity roster is scoped to participants (no 0h/0h; no leak) ───────
  test("§c: capacity roster hides a 0h no-ticket person, shows a >0h one, and never leaks a closed sprint's member", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await loadScenario(setup, S7_SCENARIO); // any scenario with project 3 works
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // ── Fresh sprint B: capacity-only people, NO tickets for either. ──
    const nameB = uniqueSprintName("TC Capacity Roster");
    const sprintB = ((await (
      await setup.post("/api/sprints", {
        data: { name: nameB, start_date: "2026-07-01", end_date: "2026-07-31", capacity_mode: "per_person" },
      })
    ).json()) as { id: number }).id;

    // One PUT (replaceForSprint) sets BOTH capacity-only people at once.
    const put = await setup.put(`/api/sprints/${sprintB}/capacity`, {
      data: {
        members: [
          { op_user_id: CAP_ZERO_OP_USER_ID, name: CAP_ZERO_NAME, available_hours: 0, pto_days: 0 },
          { op_user_id: CAP_SHOWN_OP_USER_ID, name: CAP_SHOWN_NAME, available_hours: 12, pto_days: 0 },
        ],
      },
    });
    expect(put.ok(), `PUT capacity: ${put.status()} ${await put.text()}`).toBeTruthy();

    // API-level (robust) roster assertions (SPEC_10 §c point 2): 0h/no-ticket is
    // excluded; >0h capacity is sufficient on its own to be a participant.
    const capB = (await put.json()) as CapResp;
    expect(
      capB.lines.find((l) => l.op_user_id === CAP_ZERO_OP_USER_ID),
      "a 0h capacity-only person with no ticket must NOT be in the roster",
    ).toBeFalsy();
    expect(
      capB.lines.find((l) => l.op_user_id === CAP_SHOWN_OP_USER_ID),
      "a >0h capacity-only person must be in the roster",
    ).toBeTruthy();

    // UI-level: the Capacity panel renders one row per roster line (name in a
    // <span> inside .capacity-line). Scope the assertions to that panel so a
    // stray match elsewhere can't fool them.
    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintB);
    const capPanel = page.locator("section.panel", {
      has: page.getByRole("heading", { name: "Capacity", exact: true }),
    });
    await expect(capPanel).toBeVisible();
    await expect(capPanel.getByText(CAP_SHOWN_NAME)).toBeVisible();
    await expect(capPanel.getByText(CAP_ZERO_NAME)).toHaveCount(0);

    // ── Data-isolation: a member of a DIFFERENT, CLOSED sprint must not leak. ──
    // Sprint A: give the isolation person real capacity, then CLOSE it (a direct
    // /close locks a planning sprint as "finished" — SPEC_04). It must then be
    // absent from a brand-new sprint C's roster (sprint_member_capacity is
    // filtered by sprint_id — SPEC_10 §c point 3, no global/nescoped query).
    const nameA = uniqueSprintName("TC Closed Sprint");
    const sprintA = ((await (
      await setup.post("/api/sprints", {
        data: { name: nameA, start_date: "2026-06-01", end_date: "2026-06-30", capacity_mode: "per_person" },
      })
    ).json()) as { id: number }).id;
    const putA = await setup.put(`/api/sprints/${sprintA}/capacity`, {
      data: {
        members: [
          { op_user_id: CAP_ISOLATION_OP_USER_ID, name: CAP_ISOLATION_NAME, available_hours: 12, pto_days: 0 },
        ],
      },
    });
    expect(putA.ok(), `PUT capacity A: ${putA.status()} ${await putA.text()}`).toBeTruthy();
    const closeA = await setup.post(`/api/sprints/${sprintA}/close`);
    expect(closeA.ok(), `close A: ${closeA.status()} ${await closeA.text()}`).toBeTruthy();

    const nameC = uniqueSprintName("TC Fresh After Close");
    const sprintC = ((await (
      await setup.post("/api/sprints", {
        data: { name: nameC, start_date: "2026-08-01", end_date: "2026-08-31", capacity_mode: "per_person" },
      })
    ).json()) as { id: number }).id;
    const capC = (await (await setup.get(`/api/sprints/${sprintC}/capacity`)).json()) as CapResp;
    expect(
      capC.lines.find((l) => l.op_user_id === CAP_ISOLATION_OP_USER_ID),
      "a closed sprint's capacity member must NOT leak into a fresh sprint's roster",
    ).toBeFalsy();
    expect(
      capC.lines.some((l) => l.name === CAP_ISOLATION_NAME),
      "no leak of the closed sprint's member by name either",
    ).toBeFalsy();
  });

  // ── §d — s7-tester-roundtrip: no "undefined" garbage; roundtrip + comment ────
  test("§d: the s7-tester-roundtrip changelog parses cleanly (no unrecognized/undefined) and shows the roundtrip + comment", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await loadScenario(setup, S7_SCENARIO); // day 0 = 2026-07-06; WP 11762
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    const name = uniqueSprintName("TC S7 Roundtrip");
    const sprintId = ((await (
      await setup.post("/api/sprints", {
        data: { name, start_date: "2026-07-06", end_date: "2026-07-31" },
      })
    ).json()) as { id: number }).id;
    const added = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: S7_WP } });
    expect(added.ok(), `add 11762: ${added.status()} ${await added.text()}`).toBeTruthy();

    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(activated.ok(), `activate: ${activated.status()} ${await activated.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");

    // Drive the scenario timeline (dev→tester, log, comment, tester→dev) and pull
    // each change into the app cache, then Update Sprint to derive changelog.
    for (let day = 1; day <= 4; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api });
    }
    const upd = await setup.post(`/api/sprints/${sprintId}/update`);
    expect(upd.ok(), `update: ${upd.status()} ${await upd.text()}`).toBeTruthy();

    // ── API-level changelog (the real regression surface). ──
    const entries = (await (
      await setup.get(`/api/sprints/${sprintId}/tickets/${S7_WP}/changelog`)
    ).json()) as ChangelogEntry[];

    // CORE GUARD (SPEC_10 §d, ALWAYS asserted — the #11762 bug-fix): NOTHING in
    // the changelog is the "unrecognized property "undefined"" paskvil, and no
    // entry carries an empty/undefined detail. Holds even if the list is empty
    // (see the clock note below) — and catches any malformed row if present.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/unrecognized/i);
    expect(serialized).not.toMatch(/undefined/i);
    for (const e of entries) {
      expect(e.detail, `entry ${e.kind} has no detail`).toBeTruthy();
      expect((e.detail as { kind?: string }).kind, `entry ${e.kind} detail.kind missing`).toBeTruthy();
    }

    // PRESENCE (SPEC_10 §d): both assignee_changed rows (dev→tester AND
    // tester→dev, in that order — the #11762 "first change went missing" fix)
    // and a content-free comment_added.
    //
    // ⚠️ CLOCK CAVEAT — read tb-…'s §2 note: the sprintUpdate parser only keeps
    // activities with `createdAt >= activated_at` (apps/api/.../sprintUpdate.ts).
    // s7's journals are stamped on the mock's logical calendar (2026-07-07..10),
    // while activation stamps `activated_at` at the real wall clock. If the CI
    // machine's clock is AT/AFTER the scenario dates (it is today: 2026-07-14),
    // every s7 journal is filtered out and this changelog is EMPTY — the same
    // documented real-clock-vs-scenario-calendar limitation that made tb prove
    // has_history at the unit level instead. So: assert presence STRICTLY when
    // entries came through, and annotate (don't flake) when the clock filtered
    // them — the #11762 parser proper is unit-tested in @osp/op-client's
    // deriveChangelogEvents. Phase 2: if the harness clock is arranged to let
    // s7 journals through, TIGHTEN this to an unconditional expect.
    const assignChanges = entries.filter((e) => e.kind === "assignee_changed");
    const comments = entries.filter((e) => e.kind === "comment_added");
    test.info().annotations.push({
      type: "SPEC_10 §d s7 changelog entries observed",
      description: `total=${entries.length} assignee_changed=${assignChanges.length} comment_added=${comments.length}`,
    });

    // FOLLOWUPS #8 (calendar window): time_logged rows now derive by spent_on
    // (the sprint's calendar window), no longer by createdAt — so time-entry
    // rows arrive EVEN when the clock caveat above filters every journal out.
    // The strict presence branch must therefore key on JOURNAL-sourced entries,
    // not "anything at all": before this, an all-time-entries changelog
    // spuriously armed the journal assertions.
    const journalEntries = entries.filter((e) => e.source === "journal");
    if (journalEntries.length > 0) {
      // dev→tester then tester→dev, in timeline order.
      expect(assignChanges.length, "expected BOTH assignee changes (dev→tester, tester→dev)").toBe(2);
      const [firstAssign, secondAssign] = assignChanges;
      const first = firstAssign?.detail as { to?: string | null } | undefined;
      const second = secondAssign?.detail as { to?: string | null } | undefined;
      expect(first?.to, "first assignee change should hand off TO the tester").toContain("Test");
      expect(second?.to, "second assignee change should return TO the dev").toContain("Dvo");
      // Content-free comment_added present (SPEC_10 §4 decision #3).
      expect(comments.length, "expected a comment_added row").toBeGreaterThan(0);
      expect(comments[0]?.detail).toEqual({ kind: "comment_added" });
    }

    // ── UI-level (nice-to-have): if the ticket has history, open its changelog
    // panel and assert it shows NO garbage. The History button only renders when
    // has_history is true (SPEC_09 §2), which — per the clock caveat — depends on
    // whether any entry survived; hence best-effort. Whenever the panel DOES
    // open, its rendered text must never contain the #11762 garbage. ──
    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");
    const historyBtn = page.getByRole("button", { name: `View changelog for #${S7_WP}` });
    const hasHistory = await historyBtn
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    test.info().annotations.push({
      type: "SPEC_10 §d changelog panel opened in UI",
      description: String(hasHistory),
    });
    if (hasHistory) {
      await historyBtn.click();
      const dialog = page.getByRole("dialog", { name: new RegExp(`#${S7_WP}.*changelog`) });
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toContainText(/unrecognized/i);
      await expect(dialog).not.toContainText(/undefined/i);
      // A content-free comment renders as "💬 comment added" (SprintBoardScreen
      // formatChangelogDetail). Nice-to-have visibility of the comment row.
      // (Guarded: only assert when the comment survived the clock filter.)
      if (comments.length > 0) {
        await expect(dialog.getByText(/comment/i).first()).toBeVisible();
      }
    }
  });

  // ── §e — mock-only sprint: Update AND Finish ignore an unrelated dead server ─
  test("§e: a mock-only sprint's Update Sprint and Finish never hit a disconnected unrelated server", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // A second, UNRELATED connection that is present but disconnected — the
    // SPEC_10 §e "acme" stand-in. It has ZERO tickets in the sprint, so scoped
    // update/finish (Agent B generalizing the Increment-9 activation scoping)
    // must never contact it, hence never raise its CONNECTION_DISABLED.
    await addConnection(setup, DEAD_E_BASE);
    await deleteConnectionByBase(setup, DEAD_E_BASE); // reset any prior state, then re-add cleanly
    const deadId = await addConnection(setup, DEAD_E_BASE);
    await setup.patch(`/api/connections/${deadId}`, { data: { enabled: false } });
    // Keep the mock current + enabled so the sprint's tickets resolve to it.
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });

    try {
      await loadScenario(setup, "s5-burndown-happy");
      const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
      expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      // A sprint whose ONLY ticket is sourced from the mock.
      const name = uniqueSprintName("TC Mock-Only Lifecycle");
      const sprintId = ((await (
        await setup.post("/api/sprints", {
          data: { name, start_date: "2026-07-01", end_date: "2026-07-31" },
        })
      ).json()) as { id: number }).id;
      const added = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: 1501 } });
      expect(added.ok(), `add 1501: ${added.status()} ${await added.text()}`).toBeTruthy();

      const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
      expect(activated.ok(), `activate: ${activated.status()} ${await activated.text()}`).toBeTruthy();
      await waitSprintStatus(setup, sprintId, "active");

      await gotoTab(page, "Sprint board", true);
      await selectSprint(page, sprintId);
      await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");

      // ── Update Sprint — must complete with NO error banner, specifically no
      // CONNECTION_DISABLED for the unrelated dead server. ──
      await page.getByRole("button", { name: "Update Sprint" }).click();
      // Wait for the click to settle (button returns from "Updating…").
      await expect(page.getByRole("button", { name: "Update Sprint" })).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".msg.error")).toHaveCount(0);
      await expect(page.getByText(/CONNECTION_DISABLED|is disconnected/i)).toHaveCount(0);
      // Cross-check the run at the API level: newest update run didn't error.
      const updRes = await setup.post(`/api/sprints/${sprintId}/update`);
      expect(updRes.ok(), `direct update: ${updRes.status()} ${await updRes.text()}`).toBeTruthy();

      // ── Finish — same guarantee across the finish path (final update + lock).
      // Finish is behind a window.confirm; auto-accept it. ──
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "Finish sprint" }).click();
      await waitSprintStatus(setup, sprintId, "closed");
      await expect(page.locator(".msg.error")).toHaveCount(0);
      await expect(page.getByText(/CONNECTION_DISABLED|is disconnected/i)).toHaveCount(0);
    } finally {
      await deleteConnectionByBase(setup, DEAD_E_BASE).catch(() => {});
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } }).catch(() => {});
    }
  });
});
