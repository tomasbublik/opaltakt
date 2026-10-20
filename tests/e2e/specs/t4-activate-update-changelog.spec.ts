import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { advanceDay, ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { SCENARIO_WP_IDS, SPRINT_STATUS_TESTID, wpCardTestId } from "../utils/selectors";
import { E2E_URLS } from "../../playwright.config";

/**
 * T4 — Increment 4 (activate / update / ticket changelog), scenario
 * s1-accountable-handoff. Self-contained: this file's own beforeAll ensures
 * the vault + a connection exist even if run in isolation (t1-t3 may not have
 * run), then loads the scenario itself (a load is a FULL reset of the mock).
 */

const PROJECT_OP_ID = 3;
const HANDOFF_WP = SCENARIO_WP_IDS.s1.handoff; // 1101

/** Navigate fresh and land on the "Sprint board" tab with `name` selected.
 * Needed after any `request`-driven (backend-only) mutation, since those
 * never bump the app's `refreshKey` the way a UI action does. */
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

test.describe.serial("T4 — activate, update, changelog (s1-accountable-handoff)", () => {
  const sprintName = uniqueSprintName("T4 Handoff Sprint");
  let sprintId: number;
  let page: Page;

  test.beforeAll(async ({ request, browser }) => {
    await ensureVaultReady(request);
    await ensureConnection(request);
    await loadScenario(request, "s1-accountable-handoff");

    const syncRes = await request.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    if (!syncRes.ok()) throw new Error(`sync failed: ${syncRes.status()} ${await syncRes.text()}`);

    const created = await request.post("/api/sprints", {
      data: {
        name: sprintName,
        start_date: "2026-07-01",
        end_date: "2026-07-12", // comfortably after the scenario's day-8 end
        capacity_mode: "per_person",
      },
    });
    if (!created.ok()) throw new Error(`create sprint failed: ${created.status()} ${await created.text()}`);
    sprintId = (await created.json()).id as number;

    const added = await request.post(`/api/sprints/${sprintId}/items`, {
      data: { wp_op_id: HANDOFF_WP },
    });
    if (!added.ok()) throw new Error(`add item failed: ${added.status()} ${await added.text()}`);

    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("activating a planning sprint captures a baseline and flips it to active", async () => {
    await openBoardWithSprint(page, sprintName);

    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("planning");
    await expect(page.getByRole("button", { name: "Activate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update Sprint" })).toHaveCount(0);

    await page.getByRole("button", { name: "Activate" }).click();

    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");
    // Baseline capture evidence: Activate is gone, Update Sprint has replaced it.
    await expect(page.getByRole("button", { name: "Activate" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Update Sprint" })).toBeVisible();
  });

  test("Update Sprint right after activation succeeds with no error (regression guard)", async () => {
    // A real historical bug: clicking "Update Sprint" immediately after
    // activation (zero elapsed time, nothing to diff yet) used to error.
    // T8 also regression-checks this from a different angle; this is the
    // direct UI-level check.
    await openBoardWithSprint(page, sprintName);

    await page.getByRole("button", { name: "Update Sprint" }).click();

    await expect(page.locator(".msg.error")).toHaveCount(0);
    await expect(page.getByText(/Last updated .* — (no changes|\d+ changes?)/)).toBeVisible();
  });

  test("after the scenario's day-6 handoff lands, Update Sprint pulls the new status/assignee into the ticket card", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    // Advance the mock's logical clock through day 6: the scenario's
    // dev→tester handoff (status → Developed, assignee dev → tester) is the
    // day-6 event. Each advance-day call (appUrl set) also re-syncs the real
    // app, but the SPRINT's own cache refresh is only derived by an explicit
    // update pass (scheduler is disabled in this env) — hence the manual
    // "Update Sprint" click below.
    for (let day = 1; day <= 6; day += 1) {
      await advanceDay(request, { appUrl: E2E_URLS.api });
    }

    await openBoardWithSprint(page, sprintName);
    await page.getByRole("button", { name: "Update Sprint" }).click();

    await expect(page.locator(".msg.error")).toHaveCount(0);
    await expect(page.getByText(/Last updated .*/)).toBeVisible();

    // NOTE on why this does NOT assert the changelog PANEL's contents: the
    // ticket changelog is derived from OP journals filtered to
    // `createdAt >= activated_at` (SPEC_04 §8). `activated_at` is stamped at
    // REAL wall-clock time (this test's "now"), while every mock scenario's
    // timeline is dated on its OWN fixed calendar starting 2026-07-01 — by
    // the time this suite runs, real "now" is always well past that, so
    // EVERY scenario-timeline journal event predates activation and the
    // changelog is correctly empty ("no changes"). This is documented,
    // pre-existing, expected behavior in this project (see the
    // osp-sprint-lifecycle project memory's "real-clock gotcha"), not
    // something this E2E environment can exercise without an injectable
    // server clock (which apps/api/src/server.ts does not currently expose
    // via env var — only the vitest-level test harness can inject `now`).
    // What Update Sprint CAN and does prove here, achievably: the ticket's
    // CACHED field state (status/assignee) is refreshed from OP — a plain
    // sync upsert, independent of the changelog's journal-timestamp filter.
    const card = page.getByTestId(wpCardTestId(HANDOFF_WP));
    await expect(card).toContainText("Developed");
    await expect(card).toContainText("Tereza Testerová");

    // SPEC_09 §2: the History button is gated on has_history. The real-clock
    // gotcha above still filters every JOURNAL out — but since FOLLOWUPS #8
    // (the calendar window), time_logged rows derive by spent_on, which lives
    // on the scenario's own calendar and lands inside the sprint window
    // regardless of the wall clock. The scenario logs time on this ticket, so
    // its changelog is legitimately non-empty now and the button is PRESENT —
    // and every entry it shows is a time_logged row, never a journal one
    // (asserted via the API, which is the has_history source of truth).
    await expect(card.getByLabel(`View changelog for #${HANDOFF_WP}`)).toHaveCount(1);
    const clRes = await request.get(`/api/sprints/${sprintId}/tickets/${HANDOFF_WP}/changelog`);
    expect(clRes.ok()).toBeTruthy();
    const cl = (await clRes.json()) as Array<{ kind: string; source: string }>;
    expect(cl.length).toBeGreaterThan(0);
    for (const e of cl) {
      expect(e.source, "only time-entry rows can pass the real-clock journal filter").toBe("time_entry");
      expect(e.kind).toBe("time_logged");
    }
  });
});
