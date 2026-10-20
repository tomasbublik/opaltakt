import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { advanceDay, ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { SCENARIO_WP_IDS, SPRINT_STATUS_TESTID, wpCardTestId } from "../utils/selectors";
import { E2E_URLS } from "../../playwright.config";

/**
 * T6 — Increment 4 (finish / auto-lock). Two independent flows; each does its
 * own full setup (vault/connection/scenario) so it also works run in
 * isolation. Only the vault+connection bootstrap is shared via this file's
 * own beforeAll — each test loads its OWN scenario (a load is a full reset).
 */

const PROJECT_OP_ID = 3;

async function openBoardWithSprint(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sprint board", exact: true }).click();
  const select = page.locator("#sprint-select");
  await expect(select).toBeVisible();
  const option = select.locator("option", { hasText: name });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  await select.selectOption(value ?? "");
}

test.beforeAll(async ({ request }) => {
  await ensureVaultReady(request);
  await ensureConnection(request);
});

test("manual finish locks the board, splits Done/Not-done, and disables further mutation (s6-carryover)", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  page.on("dialog", (d) => void d.accept());

  await loadScenario(request, "s6-carryover");
  const syncRes = await request.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
  if (!syncRes.ok()) throw new Error(`sync failed: ${syncRes.status()} ${await syncRes.text()}`);

  const sprintName = uniqueSprintName("T6 Carryover Sprint");
  const created = await request.post("/api/sprints", {
    data: {
      name: sprintName,
      start_date: "2026-07-01",
      end_date: "2026-07-09",
      capacity_mode: "per_person",
    },
  });
  if (!created.ok()) throw new Error(`create sprint failed: ${created.status()} ${await created.text()}`);
  const sprintId = (await created.json()).id as number;

  for (const wpId of SCENARIO_WP_IDS.s6.tickets) {
    const added = await request.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wpId } });
    if (!added.ok()) throw new Error(`add item ${wpId} failed: ${added.status()} ${await added.text()}`);
  }

  await openBoardWithSprint(page, sprintName);
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");

  // Advance through day 7 — the scenario's own end state: 1601 Resolved,
  // 1602 Closed, 1603 Tested, 1604 On hold (4h left), 1605 Merge pending (1h
  // left). Backend-driven (via `request`), so the already-open page needs a
  // reload to see it (a UI click would auto-refresh via refreshKey; a raw
  // API call does not).
  for (let day = 1; day <= 7; day += 1) {
    await advanceDay(request, { appUrl: E2E_URLS.api });
  }
  await openBoardWithSprint(page, sprintName);

  await page.getByRole("button", { name: "Update Sprint" }).click();
  await expect(page.locator(".msg.error")).toHaveCount(0);

  await page.getByRole("button", { name: "Finish sprint" }).click();

  await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("Finished");
  await expect(page.locator('[role="status"]', { hasText: "Locked" })).toContainText(/finished and locked/i);

  // Immutability guarantee, as it actually exists in this UI: the mutating
  // controls are simply ABSENT once locked (SprintBoardScreen.tsx
  // isReadOnly()/WpCard's `disabled` gating hides them), not present-but-409ing.
  await expect(page.getByRole("button", { name: "Activate" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update Sprint" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish sprint" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to planning" })).toHaveCount(0);
  await expect(page.getByTestId(wpCardTestId(1601)).getByRole("button", { name: "← Return" })).toHaveCount(0);
  await expect(page.getByText("Final update:")).toBeVisible();

  // Closure report. NOTE (discrepancy — see final report): the default
  // done-classification is purely `status_is_closed` (apps/api/src/logic/
  // done.ts), and "Tested" is NOT isClosed in this mock's status table
  // (fixtures/data/statuses.json) — there is also no route/UI to configure a
  // per-sprint done_status_rule override. So WP 1603 (ends the scenario at
  // "Tested") actually lands in not_done alongside 1604/1605, not in `done`
  // as the scenario file's own comment implies. done={1601,1602} (2),
  // not_done={1603,1604,1605} (3).
  await page.getByRole("button", { name: "Closure", exact: true }).click();
  await expect(page.getByRole("button", { name: "View / regenerate closure report" })).toBeVisible();
  await page.getByRole("button", { name: "View / regenerate closure report" }).click();

  await expect(page.getByText("Done (2)", { exact: true })).toBeVisible();
  await expect(page.getByText("Not done (3)", { exact: true })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "#1601" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "#1602" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "#1603" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "#1604" })).toBeVisible();
  await expect(page.locator(".card-title", { hasText: "#1605" })).toBeVisible();

  // "Return to backlog" is NOT guarded by is_locked on the frontend (unlike
  // the sprint-board lifecycle buttons, which are hidden once locked) — the
  // button stays visible and clickable here. But the backend DOES enforce
  // immutability: removing an item from a closed/locked sprint 409s with
  // SPRINT_CLOSED (apps/api/src/routes/index.ts). Confirmed live: clicking it
  // surfaces that exact error and the item stays "not done" (no "Returned"
  // badge) — asserting the REAL behavior, which is arguably a more valuable
  // regression guard than the button-absence checks above, since it covers
  // the "control visible but action still blocked" case those don't.
  const notDoneCard = page.locator(".card", { hasText: "#1604" });
  await notDoneCard.getByRole("button", { name: "Return to backlog" }).click();
  await expect(page.getByText(/is closed \(SPRINT_CLOSED\)/)).toBeVisible();
  await expect(notDoneCard.getByText("Returned")).toHaveCount(0);
  await expect(notDoneCard.getByRole("button", { name: "Return to backlog" })).toBeVisible();

  // Version-export deep link opens a NEW TAB/popup pointing at the mock —
  // never a same-page navigation.
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("button", { name: "Open in OP to change version →" }).click(),
  ]);
  await popup.waitForLoadState();
  expect(popup.url().startsWith(E2E_URLS.mock)).toBe(true);
  await popup.close();
});

/**
 * Auto-lock via end date — BEST EFFORT, see finding below.
 *
 * Traced the ONLY end-date check in the codebase: apps/api/src/scheduler/
 * sprintUpdates.ts:89 (`now() >= endOfLocalDay(sprint.end_date)` →
 * `sprintLifecycle.finish(id, "end_date", "end_date")`), invoked solely by
 * the periodic tick that `startSprintUpdateScheduler` sets up. That
 * scheduler (along with the snapshot scheduler and heartbeat) is only wired
 * up in apps/api/src/index.ts when `OSP_DISABLE_SCHEDULER !== "1"` — and
 * this e2e harness's webServer config (tests/playwright.config.ts) sets
 * OSP_DISABLE_SCHEDULER=1, so that tick NEVER runs in this environment and
 * there is no HTTP-reachable `tickNow()`.
 *
 * Neither manual path re-checks the date: POST /sprints/:id/update
 * (sprintLifecycle.update(), apps/api/src/logic/sprintUpdate.ts) only checks
 * `is_locked`; POST /sprints/:id/finish (the "Finish sprint" button) always
 * locks with a HARDCODED lock_reason "finished", never "end_date", and never
 * looks at end_date either. So a genuine unattended `lock_reason: "end_date"`
 * auto-lock cannot be exercised through the HTTP API or the UI in this
 * environment — only by running the scheduler in-process (which is exactly
 * what tests/src/sprint-lock.test.ts does, at the Vitest/harness level, not
 * over HTTP).
 *
 * What IS real, testable app behavior and is asserted below instead:
 *  - the frontend's own EndDateWarning banner (a pure `Date.now()` vs
 *    `sprint.end_date` check, SprintBoardScreen.tsx) correctly fires once the
 *    end date has passed;
 *  - clicking "Update Sprint" on a past-end active sprint does NOT lock it
 *    (proving the end-date check is genuinely scheduler-only — a regression
 *    guard against ever coupling it into the manual update path without
 *    updating this test);
 *  - manually finishing that same sprint locks it with lock_reason
 *    "finished" (badge text "Finished"), never "Locked (end date)" — i.e.
 *    the only reachable lock path in this env is the manual one.
 */
test("auto-lock via end date is scheduler-only in this env (OSP_DISABLE_SCHEDULER=1) — best effort", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  page.on("dialog", (d) => void d.accept());

  await loadScenario(request, "s1-accountable-handoff");
  const syncRes = await request.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
  if (!syncRes.ok()) throw new Error(`sync failed: ${syncRes.status()} ${await syncRes.text()}`);

  // Real wall-clock dates (this env uses real Date.now(), not the mock's
  // logical calendar, for the end-date check) — already-past end_date so the
  // EndDateWarning banner and the "would-auto-lock" condition are both true.
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 3);
  const end = new Date(now);
  end.setDate(end.getDate() - 1);

  const sprintName = uniqueSprintName("T6 Past-End Sprint");
  const created = await request.post("/api/sprints", {
    data: {
      name: sprintName,
      start_date: toIso(start),
      end_date: toIso(end),
      capacity_mode: "per_person",
    },
  });
  if (!created.ok()) throw new Error(`create sprint failed: ${created.status()} ${await created.text()}`);
  const sprintId = (await created.json()).id as number;

  const added = await request.post(`/api/sprints/${sprintId}/items`, {
    data: { wp_op_id: SCENARIO_WP_IDS.s1.handoff },
  });
  if (!added.ok()) throw new Error(`add item failed: ${added.status()} ${await added.text()}`);

  await openBoardWithSprint(page, sprintName);
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");

  // The frontend's own (real) end-date-passed warning.
  await expect(page.getByText("End date has passed", { exact: false })).toBeVisible();

  // Manual "Update Sprint" must NOT auto-lock — the only end-date check lives
  // in the (disabled) scheduler.
  await page.getByRole("button", { name: "Update Sprint" }).click();
  await expect(page.locator(".msg.error")).toHaveCount(0);
  await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");
  await expect(page.getByRole("button", { name: "Finish sprint" })).toBeVisible();

  // Manually finishing is the only reachable lock path here — it locks with
  // lock_reason "finished" ("Finished"), never the scheduler's "end_date"
  // ("Locked (end date)").
  await page.getByRole("button", { name: "Finish sprint" }).click();
  await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("Finished");
});
