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
import { SCENARIO_WP_IDS, SPRINT_STATUS_TESTID, wpCardTestId } from "../utils/selectors";

/**
 * TB — Increment 9 (SPEC_09_Activation_Capacity_Backlog.md §7) regressions.
 *
 * FILE NAME NOTE: same convention as `ta-…` (see that file's header). Playwright
 * runs spec files in LEXICOGRAPHIC filename order, and "tb-…" sorts AFTER every
 * t1–t9 AND after "ta-…", so this spec runs LAST in the suite. That ordering is
 * load-bearing for §1 below: by the time TB runs, t7 has permanently left an
 * unreachable "canary" connection (127.0.0.1:8198) in the registry — exactly
 * the "irrelevant disconnected server" that a scoped activation must IGNORE.
 * Do NOT rename it to "t11" (which would sort before "t2").
 *
 * The five behaviors, one test each, numbered per the SPEC_09 §7 bug list:
 *   #1/#7 — activating a sprint built ONLY from mock tickets is scoped to that
 *           connection: it finishes FAST (no minute-long hang on the unreachable
 *           acme/canary server) and never raises a false CONNECTION_DISABLED.
 *   #2     — the History button renders ONLY for tickets that actually have
 *           changelog entries (has_history), never just to open "No history yet".
 *   #3/#4  — grey redistribution: reassigning a baseline ticket grows the
 *           sender's grey (bar stays the same length) and the receiver's grey;
 *           a ticket ADDED mid-sprint is red (added_hours), never grey.
 *   #5     — a ticket's link points at ITS OWN source server's base_url.
 *   #6     — the Sprint-board backlog HIDES tickets from disconnected servers;
 *           the standalone Backlog screen still shows them, dimmed/stale.
 *
 * Self-contained: its own idempotent vault/connection bootstrap so it works run
 * in isolation OR last-in-suite. Per the t9/ta lesson, every assertion targets a
 * SPECIFIC connection's own state, never the header's GLOBAL aggregate health
 * dot (which the leftover canary keeps off pure-green for the rest of the run).
 *
 * GUARDRAIL: nothing here issues a non-GET toward OP — the only writes are to
 * the app's own /api/* surface and the mock's /__mock/* admin API. No token is
 * read or asserted anywhere.
 */

const PROJECT_OP_ID = 3;
const MOCK_BASE = E2E_URLS.mock; // http://127.0.0.1:8199 — the ticket's own source server
const MOCK_HOSTPORT = "127.0.0.1:8199";

const HANDOFF_WP = SCENARIO_WP_IDS.s1.handoff; // 1101 — dev→tester day-6 handoff (baseline reassign)
const HANDOFF_BG_WP = 1102; // s1 background ticket, assignee dev — used as a mid-sprint (red) add
const S4_CHANGING_WP = SCENARIO_WP_IDS.s4.baseline[0]; // 1401 "session" — logs time + status days 1-2
const S4_STATIC_WP = SCENARIO_WP_IDS.s4.baseline[4]; // 1405 "db-driver" — scenario NEVER moves it (no history)

const DEV_OP_USER_ID = 1; // cast(): "Dev Dvořák", me:true
const TESTER_OP_USER_ID = 2; // cast(): "Tereza Testerová"

// ── shared minimal shapes (contract subset we assert on) ─────────────────────
interface CapLine {
  op_user_id: number | null;
  name: string;
  baseline_hours: number;
  added_hours: number;
  removed_hours: number;
  redistributed_out_hours: number;
  redistributed_in_hours: number;
  planned_hours: number;
}
interface CapResp {
  lines: CapLine[];
}
interface SprintRow {
  id: number;
  status: string;
}
interface BacklogRow {
  op_id: number;
  in_sprint: boolean;
  connection_base_url: string | null;
  stale: boolean;
}

function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}

async function gotoTab(page: Page, name: string, exact = true): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name, exact }).click();
}

/** Select a sprint by its numeric id in the shared #sprint-select picker. */
async function selectSprint(page: Page, sprintId: number): Promise<void> {
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
}

async function getCapacity(ctx: APIRequestContext, sprintId: number): Promise<CapResp> {
  const res = await ctx.get(`/api/sprints/${sprintId}/capacity`);
  expect(res.ok(), `capacity ${sprintId}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as CapResp;
}

/** Find one capacity line by OP user id (dev/tester); fails clearly if absent. */
function lineFor(cap: CapResp, opUserId: number): CapLine {
  const line = cap.lines.find((l) => l.op_user_id === opUserId);
  expect(line, `capacity line for op_user_id ${opUserId} missing`).toBeTruthy();
  return line!;
}

/**
 * Activation is ASYNC now (SPEC_09 §1): POST /activate returns a running
 * SprintUpdateRun and the sprint's own status flips planning→active only once
 * the background run succeeds. Poll the sprint list until it reports "active".
 */
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

test.describe.serial("TB — SPEC_09 activation / capacity / backlog regressions", () => {
  let setup: APIRequestContext;
  let mockConnId: number;

  test.beforeAll(async () => {
    // Test-scoped fixtures are unavailable in beforeAll — own context (SPEC_06 §3).
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    mockConnId = await ensureConnection(setup);
    // Be defensive in case an earlier run bailed with the mock left disabled.
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } });
  });

  test.afterAll(async () => {
    // Never leave the working mock connection disabled for a re-run (§6 toggles it).
    await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: true } }).catch(() => {});
    await setup.dispose();
  });

  // ── #1/#7 — scoped, fast activation with no false CONNECTION_DISABLED ────────
  test("#1/#7: a mock-only sprint activates fast and clean, ignoring any unrelated disconnected server", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    await loadScenario(setup, "s5-burndown-happy");
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // A sprint whose ONLY ticket is sourced from the mock connection. The suite
    // (t7/ta) has, by the time TB runs, left an unreachable canary connection in
    // the registry — the regression this guards is that activation must NOT try
    // to contact it (it has no tickets in this sprint) and so must neither hang
    // for minutes (#1) nor fail with CONNECTION_DISABLED (#7).
    const sprintName = uniqueSprintName("TB Scoped Activation");
    const created = await setup.post("/api/sprints", {
      data: { name: sprintName, start_date: "2026-07-01", end_date: "2026-07-31" },
    });
    expect(created.ok(), `create sprint: ${created.status()}`).toBeTruthy();
    const sprintId = ((await created.json()) as { id: number }).id;
    const added = await setup.post(`/api/sprints/${sprintId}/items`, {
      data: { wp_op_id: SCENARIO_WP_IDS.s5.tickets[0] }, // 1501, a mock ticket
    });
    expect(added.ok(), `add item: ${added.status()} ${await added.text()}`).toBeTruthy();

    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("planning");

    // (c) A progress indicator should appear while the async activation run is in
    // flight. This reuses the existing "Update Sprint" progress component
    // (data-testid="sprint-update-progress", SprintBoardScreen.tsx) — but whether
    // it renders during the ACTIVATING phase depends on Agent C wiring the same
    // component into the planning→active click. Observe it BEST-EFFORT (never
    // flake): for a single-ticket sprint it may also flash by too fast to catch.
    await page.getByRole("button", { name: "Activate" }).click();
    const progress = page.getByTestId("sprint-update-progress");
    const sawProgress = await progress
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    test.info().annotations.push({
      type: "SPEC_09 §1 activation progress indicator observed",
      description: String(sawProgress),
    });

    // (a) It completes QUICKLY. The bounded 15s timeout is the actual regression
    // bar — a regression to "contacts the unreachable server and hangs for
    // minutes" fails loudly here instead of silently eating Playwright's default.
    const started = Date.now();
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active", { timeout: 15_000 });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs, `activation took ${elapsedMs}ms — expected well under a minute`).toBeLessThan(
      15_000,
    );

    // (b) No error banner at all — specifically no CONNECTION_DISABLED flavor,
    // even with the unrelated canary connection sitting disconnected.
    await expect(page.locator(".msg.error")).toHaveCount(0);

    // Cross-check the state flip at the API level too (independent of the header
    // aggregate dot, which the canary keeps off green — the t9/ta lesson).
    await waitSprintStatus(setup, sprintId, "active");
  });

  // ── #2 — History button renders only when the ticket has changelog ──────────
  test("#2: History button shows for a ticket WITH changelog and is absent for one WITHOUT", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // NOTE on strategy: every scenario-timeline event (advanceDay) is stamped
    // on the MOCK's own fixed calendar (2026-07-01 + day N — see
    // fixtures/mock-op-server/engine.ts's nextTimestamp()), which is always
    // dated before `activated_at` (real wall-clock "now") by the time this
    // suite runs — the same documented real-clock-vs-scenario-calendar gotcha
    // t4-activate-update-changelog.spec.ts already calls out. So a
    // scenario-driven ticket can NEVER accrue a post-activation changelog
    // entry in this harness; that half of has_history is proven instead at
    // the unit-test level (apps/api's route tests + SprintBoardScreen.test.tsx
    // both cover has_history=true directly via injected/mocked data).
    // What IS reliably real-time-stamped here: a MID-SPRINT ADD to an already
    // active sprint logs a local "scope_added" changelog entry at the
    // server's actual `now` (SPEC_05 §3, routes/index.ts's
    // logLocalScopeChange) — a deterministic, date-independent way to give a
    // ticket real changelog history without depending on the mock calendar.
    await loadScenario(setup, "s4-volatile-sprint");
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    const sprintName = uniqueSprintName("TB History Gating");
    const created = await setup.post("/api/sprints", {
      data: { name: sprintName, start_date: "2026-07-01", end_date: "2026-07-31" },
    });
    const sprintId = ((await created.json()) as { id: number }).id;
    // Baseline: ONLY the static ticket — it will never get a changelog entry.
    const addStatic = await setup.post(`/api/sprints/${sprintId}/items`, {
      data: { wp_op_id: S4_STATIC_WP },
    });
    expect(addStatic.ok(), `add baseline item: ${addStatic.status()}`).toBeTruthy();
    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(activated.ok(), `activate: ${activated.status()} ${await activated.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");

    // Mid-sprint add (sprint is now active): real-time "scope_added" entry.
    const addChanging = await setup.post(`/api/sprints/${sprintId}/items`, {
      data: { wp_op_id: S4_CHANGING_WP },
    });
    expect(addChanging.ok(), `mid-sprint add: ${addChanging.status()} ${await addChanging.text()}`).toBeTruthy();

    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");

    // Query each ticket's OWN card so the assertion is precise about WHICH ticket
    // has the button. Button selector: aria-label "View changelog for #<id>"
    // (SprintBoardScreen.tsx, text "History"). Agent C gates its rendering on the
    // new has_history flag — so this is the load-bearing post-Agent-C assertion.
    const changingCard = page.getByTestId(wpCardTestId(S4_CHANGING_WP));
    const staticCard = page.getByTestId(wpCardTestId(S4_STATIC_WP));
    await expect(changingCard).toBeVisible();
    await expect(staticCard).toBeVisible();

    await expect(
      changingCard.getByRole("button", { name: `View changelog for #${S4_CHANGING_WP}` }),
    ).toBeVisible();
    await expect(
      staticCard.getByRole("button", { name: `View changelog for #${S4_STATIC_WP}` }),
    ).toHaveCount(0);
  });

  // ── #3/#4 — grey redistribution of the baseline; mid-sprint add stays red ────
  test("#3/#4: reassigning a baseline ticket greys sender+receiver; a mid-sprint add is red not grey", async ({
    request,
  }) => {
    test.setTimeout(120_000);

    // s1: WP 1101 is assigned to dev at day 0 and HANDS OFF to tester on day 6.
    await loadScenario(setup, "s1-accountable-handoff");
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    const sprintName = uniqueSprintName("TB Redistribution");
    const created = await setup.post("/api/sprints", {
      data: {
        name: sprintName,
        start_date: "2026-07-01",
        end_date: "2026-07-31",
        capacity_mode: "per_person",
      },
    });
    const sprintId = ((await created.json()) as { id: number }).id;
    // Baseline = ONLY 1101 (assignee dev). Its original owner o_t=dev is frozen
    // in ticket_baseline.original_assignee_op_id at activation.
    const addBaseline = await setup.post(`/api/sprints/${sprintId}/items`, {
      data: { wp_op_id: HANDOFF_WP },
    });
    expect(addBaseline.ok(), `add baseline: ${addBaseline.status()}`).toBeTruthy();
    const activated = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(activated.ok(), `activate: ${activated.status()} ${await activated.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");

    // Right after activation (still day 0), add a SECOND ticket mid-sprint (dev,
    // still open/Confirmed → non-zero estimate). origin=added_mid_sprint, so its
    // hours must land in dev's added_hours (red), never in any redistributed_*.
    const addMid = await setup.post(`/api/sprints/${sprintId}/items`, {
      data: { wp_op_id: HANDOFF_BG_WP },
    });
    expect(addMid.ok(), `add mid-sprint: ${addMid.status()} ${await addMid.text()}`).toBeTruthy();

    const before = await getCapacity(setup, sprintId);
    const devBefore = lineFor(before, DEV_OP_USER_ID);
    // Baseline captured for dev (1101); nothing reassigned yet → no grey out.
    expect(devBefore.baseline_hours).toBeGreaterThan(0);
    expect(devBefore.redistributed_out_hours).toBe(0);
    // The mid-sprint ticket is red immediately.
    expect(devBefore.added_hours).toBeGreaterThan(0);
    const devAddedBefore = devBefore.added_hours;

    // Advance to day 6 → 1101 reassigns dev→tester (each advance re-syncs the app
    // cache so the current assignee is up to date), then Update Sprint to
    // recompute the capacity segments against the frozen baseline owner.
    for (let day = 1; day <= 6; day += 1) {
      await advanceDay(setup, { appUrl: E2E_URLS.api });
    }
    const upd = await setup.post(`/api/sprints/${sprintId}/update`);
    expect(upd.ok(), `update: ${upd.status()} ${await upd.text()}`).toBeTruthy();

    const after = await getCapacity(setup, sprintId);
    const devAfter = lineFor(after, DEV_OP_USER_ID);
    const testerAfter = lineFor(after, TESTER_OP_USER_ID);

    // Sender (dev, original owner): the bar stays exactly baseline_hours long
    // (SPEC_09 §3 "bar původního vlastníka zůstává stejně dlouhý") and its grey
    // grows because 1101 is no longer live-green on dev (reassigned away).
    expect(devAfter.baseline_hours).toBeCloseTo(devBefore.baseline_hours, 5);
    expect(devAfter.redistributed_out_hours).toBeGreaterThan(0);

    // Receiver (tester): grey received grows — even though tester owned ZERO
    // baseline at activation (a pure receiver, SPEC_09 §4).
    expect(testerAfter.redistributed_in_hours).toBeGreaterThan(0);

    // The mid-sprint ticket is STILL red, never grey: dev's added_hours is
    // unchanged and its grey-out (which counts ONLY baseline-origin items) can
    // never exceed the baseline itself — the mid-sprint add sits outside it.
    expect(devAfter.added_hours).toBeCloseTo(devAddedBefore, 5);
    expect(devAfter.redistributed_out_hours).toBeLessThanOrEqual(devAfter.baseline_hours + 1e-6);
  });

  // ── #5 — a ticket's link points at its own source server ────────────────────
  test("#5: a mock ticket's backlog link resolves to the mock server's own base_url", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await loadScenario(setup, "s5-burndown-happy");
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    await gotoTab(page, "Backlog", true);
    await expect(page.locator('[aria-label="backlog count"]')).toBeVisible();
    // The Backlog screen's union backlog accumulates every project imported by
    // EARLIER spec files too (additive across the whole suite run) and paginates
    // at 20/page with no id search box — bump to the max page size so our
    // target ticket is on-screen regardless of how many other specs ran first.
    await page.getByLabel("Page size").selectOption("100");

    // The link is built as `${source_connection.base_url}/work_packages/<id>`
    // (BacklogScreen.tsx opWorkPackageUrl on item.connection_base_url). Read the
    // expected base from the shared E2E_URLS constant rather than hardcoding.
    // NOTE: index [2] (1503), not [0]/[1] (1501/1502) — t9's own §5 test
    // PERMANENTLY dismisses 1502 from the backlog (backlog_dismissal survives
    // a scenario reload — it's app-DB state, not mock state) earlier in the
    // suite; 1503 isn't touched by any other spec (additive-safe: don't
    // collide with state another spec file leaves behind, per this suite's
    // own convention documented in playwright.config.ts).
    const wpId = SCENARIO_WP_IDS.s5.tickets[2]; // 1503, a mock ticket
    const expectedHref = `${MOCK_BASE}/work_packages/${wpId}`;
    // Both the op-id cell and the subject cell link to the same href; asserting
    // at least one carries the source-server URL proves the resolver.
    await expect(page.locator(`a[href="${expectedHref}"]`).first()).toBeVisible();
  });

  // ── #6 — Sprint-board backlog hides disconnected; Backlog card shows dimmed ──
  test("#6: disconnected server's tickets vanish from the Sprint-board backlog but stay (dimmed) on the Backlog screen", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await loadScenario(setup, "s2-status-spectrum");
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // Pick a genuine backlog ticket from the mock (NOT already committed to any
    // open sprint by an earlier spec) so the board-backlog visibility check is
    // meaningful — resolve it dynamically rather than hardcoding a possibly
    // already-consumed id.
    const backlog = (await (await setup.get("/api/backlog")).json()) as BacklogRow[];
    const candidate = backlog.find(
      (b) => !b.in_sprint && b.connection_base_url === MOCK_BASE,
    );
    expect(candidate, "need a free mock-sourced backlog ticket for §6").toBeTruthy();
    const wpId = candidate!.op_id;

    // A fresh EMPTY planning sprint so the board renders with a backlog column
    // holding all not-in-sprint tickets (incl. our candidate).
    const sprintName = uniqueSprintName("TB Board Backlog Filter");
    const created = await setup.post("/api/sprints", {
      data: { name: sprintName, start_date: "2026-07-01", end_date: "2026-07-31" },
    });
    const sprintId = ((await created.json()) as { id: number }).id;

    // Sanity: while CONNECTED, the ticket is visible in the Sprint-board backlog
    // (search-narrow to it so it's not hidden behind the board's render cap).
    await gotoTab(page, "Sprint board", true);
    await selectSprint(page, sprintId);
    const boardBacklog = page.getByTestId("drop-backlog");
    await page.getByLabel("Search backlog").fill(String(wpId));
    await expect(boardBacklog.getByTestId(wpCardTestId(wpId))).toBeVisible();

    // Disconnect the mock via the Setup UI (mirrors t9 §1 / ta's Disconnect flow).
    await gotoTab(page, "Setup", false);
    const row = page.locator(".server-row", { hasText: MOCK_HOSTPORT });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Disconnect" }).click();
    await expect(row.getByText(/Disconnected —/)).toBeVisible();

    try {
      // On the Sprint board the ticket is now HIDDEN — its source server is
      // disconnected, and the board backlog shows only live-data tickets
      // (SPEC_09 §6). This is Agent C's board-side stale filter.
      await gotoTab(page, "Sprint board", true);
      await selectSprint(page, sprintId);
      await page.getByLabel("Search backlog").fill(String(wpId));
      await expect(page.getByTestId("drop-backlog").getByTestId(wpCardTestId(wpId))).toHaveCount(0);

      // On the standalone Backlog screen the SAME ticket still appears, only
      // dimmed/marked stale (row-stale, unchanged from SPEC_07 §1 behavior).
      await gotoTab(page, "Backlog", true);
      await expect(page.locator('[aria-label="backlog count"]')).toBeVisible();
      const checkbox = page.locator(`[aria-label="Select #${wpId}"]`);
      await expect(checkbox).toBeVisible();
      const backlogRow = page.locator("tr", { has: checkbox });
      await expect(backlogRow).toHaveClass(/row-stale/);
    } finally {
      // Reconnect so the shared backend is left clean for a re-run (this spec
      // runs last, but be a good citizen — cf. ta's afterAll defensiveness).
      await gotoTab(page, "Setup", false);
      const reconnectRow = page.locator(".server-row", { hasText: MOCK_HOSTPORT });
      await reconnectRow.getByRole("button", { name: "Connect" }).click();
      await expect(reconnectRow.getByRole("button", { name: "Disconnect" })).toBeVisible();
    }
  });
});
