import { expect, test, type Page } from "@playwright/test";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { DROP_BACKLOG_TESTID, DROP_SPRINT_TESTID, SCENARIO_WP_IDS, wpCardTestId } from "../utils/selectors";

/**
 * T3 — sprint planning: create a sprint, drag (via the click-button
 * alternative — dnd-kit pointer events are fragile to automate) two backlog
 * tickets into it, and check capacity lines appear for their assignees.
 *
 * Uses the same s2-status-spectrum scenario as T2 (fixtures/scenarios/s2-status-spectrum.ts):
 * WP 1201 ("WP in status New") is assigned to "dev" (Dev Dvořák), WP 1204
 * ("WP in status Developed") is assigned to "tester" (Tereza Testerová) —
 * two different real assignees, not Unassigned.
 *
 * Self-contained: does its own ensureVaultReady/ensureConnection/loadScenario
 * + a direct POST /api/sync (rather than re-driving the Import UI, which T2
 * already covers) so this spec also works run alone.
 */

const DEV_WP_ID = SCENARIO_WP_IDS.s2.first; // 1201
const TESTER_WP_ID = SCENARIO_WP_IDS.s2.first + 3; // 1204
const DEV_NAME = "Dev Dvořák";
const TESTER_NAME = "Tereza Testerová";
const DEMO_PROJECT_OP_ID = 3;

function screensNav(page: Page) {
  return page.getByRole("navigation", { name: "Screens" });
}

async function gotoSprintBoard(page: Page, sprintName: string) {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name: "Sprint board" }).click();
  await expect(page.locator("#sprint-select option:checked")).toHaveText(`${sprintName} · planning`);
}

test.describe.serial("T3: sprint planning", () => {
  const sprintName = uniqueSprintName("T3 Sprint");

  test.beforeAll(async ({ request }) => {
    await ensureVaultReady(request);
    await ensureConnection(request);
    // Full reset to day 0 of s2 — the standard per-spec OP-side isolation.
    await loadScenario(request, "s2-status-spectrum");
    // Direct sync (not via the Import UI — T2 already exercises that path):
    // makes this spec self-contained if run in isolation.
    const res = await request.post("/api/sync", { data: { project_op_id: DEMO_PROJECT_OP_ID } });
    if (!res.ok()) throw new Error(`sync failed: ${res.status()} ${await res.text()}`);
  });

  test("T3: create a sprint via the form and see it selected", async ({ page }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Sprint board" }).click();
    await expect(page.getByRole("heading", { name: "Sprint board" })).toBeVisible();

    await page.locator("#s-name").fill(sprintName);
    await page.locator("#s-start").fill("2026-08-01");
    await page.locator("#s-end").fill("2026-08-14");
    await expect(page.getByRole("button", { name: "Create sprint" })).toBeEnabled();
    await page.getByRole("button", { name: "Create sprint" }).click();

    // The app auto-selects the newest sprint once the list refreshes, and
    // #sprint-select's option text is "{name} · {status}".
    await expect(page.locator("#sprint-select option:checked")).toHaveText(`${sprintName} · planning`);
  });

  test("T3: add two assigned backlog tickets to the sprint", async ({ page }) => {
    await gotoSprintBoard(page, sprintName);

    const backlogColumn = page.getByTestId(DROP_BACKLOG_TESTID);
    const sprintColumn = page.getByTestId(DROP_SPRINT_TESTID);

    await expect(backlogColumn.getByTestId(wpCardTestId(DEV_WP_ID))).toBeVisible();
    await backlogColumn
      .getByTestId(wpCardTestId(DEV_WP_ID))
      .getByRole("button", { name: "Add →" })
      .click();
    await expect(sprintColumn.getByTestId(wpCardTestId(DEV_WP_ID))).toBeVisible();

    await expect(backlogColumn.getByTestId(wpCardTestId(TESTER_WP_ID))).toBeVisible();
    await backlogColumn
      .getByTestId(wpCardTestId(TESTER_WP_ID))
      .getByRole("button", { name: "Add →" })
      .click();
    await expect(sprintColumn.getByTestId(wpCardTestId(TESTER_WP_ID))).toBeVisible();
  });

  test("T3: capacity shows a line per ticket assignee", async ({ page }) => {
    await gotoSprintBoard(page, sprintName);

    // Both tickets are still in the sprint from the previous test (state
    // persists server-side across the reload inside gotoSprintBoard).
    const sprintColumn = page.getByTestId(DROP_SPRINT_TESTID);
    await expect(sprintColumn.getByTestId(wpCardTestId(DEV_WP_ID))).toBeVisible();
    await expect(sprintColumn.getByTestId(wpCardTestId(TESTER_WP_ID))).toBeVisible();

    // Capacity lines are derived only from the current sprint's assignees.
    await expect(page.locator(`[aria-label="load for ${DEV_NAME}"]`)).toBeVisible();
    await expect(page.locator(`[aria-label="load for ${TESTER_NAME}"]`)).toBeVisible();

    // The sprint is still in "planning", so availability stays editable.
    await expect(
      page.getByRole("spinbutton", { name: `available hours for ${DEV_NAME}` }),
    ).toBeEditable();
    await expect(
      page.getByRole("spinbutton", { name: `available hours for ${TESTER_NAME}` }),
    ).toBeEditable();
  });
});
