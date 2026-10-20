import { expect, test, type Page } from "@playwright/test";
import { ensureConnection, ensureVaultReady, loadScenario } from "../fixtures/helpers";
import { SCENARIO_WP_IDS } from "../utils/selectors";

/**
 * T2 — backlog sync from the s2-status-spectrum scenario (one WP per
 * canonical OpenProject status, ids 1201..1210, project op_id 3 "Demo
 * Project" — fixtures/scenarios/s2-status-spectrum.ts / fixtures/data/projects.json).
 *
 * Self-contained: calls the idempotent `ensureVaultReady`/`ensureConnection`
 * helpers itself (T1 owns the UI-driven bootstrap; every other spec, this one
 * included, must also work if run in isolation, e.g. `playwright test
 * t2-....spec.ts` alone).
 */

const FIRST_WP_ID = SCENARIO_WP_IDS.s2.first; // 1201, status "New", assignee "dev" (Dev Dvořák)
// s2 seeds 10 WPs (one per canonical status), but the backlog VIEW hides 4 of
// them by design (apps/api/src/routes/index.ts HIDDEN_BACKLOG_STATUSES:
// closed/resolved/rejected/tested) — confirmed live (10 seeded → 6 shown).
const VISIBLE_WPS = 6;

function screensNav(page: Page) {
  return page.getByRole("navigation", { name: "Screens" });
}

function backlogRow(page: Page, opId: number) {
  return page
    .locator("table.grid tbody tr")
    .filter({ has: page.getByRole("checkbox", { name: `Select #${opId}` }) });
}

test.describe.serial("T2: backlog sync (s2-status-spectrum)", () => {
  test.beforeAll(async ({ request }) => {
    await ensureVaultReady(request);
    await ensureConnection(request);
    // Full reset to day 0 of s2 — the standard per-spec OP-side isolation.
    await loadScenario(request, "s2-status-spectrum");
  });

  test("T2: sync Demo Project via the Import screen populates the backlog", async ({ page }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Import" }).click();

    // Scope to the "Import from OpenProject" panel — its own submit button is
    // also labelled plain "Import", same as the header nav tab, so an
    // unscoped getByRole("button", { name: "Import" }) would be ambiguous.
    const importPanel = page.locator(".panel", { hasText: "Import from OpenProject" });
    await expect(importPanel.getByRole("heading", { name: "Import from OpenProject" })).toBeVisible();

    const projectCheckbox = importPanel.getByRole("checkbox", { name: "Demo Project" });
    await expect(projectCheckbox).toBeVisible();
    await projectCheckbox.check();

    const importBtn = importPanel.getByRole("button", { name: "Import" });
    await expect(importBtn).toBeEnabled();
    await importBtn.click();

    // POST /sync runs to completion before the client's request resolves —
    // once the "Imported so far" panel lists the project, the sync is done.
    const importedPanel = page.locator(".panel", { hasText: "Imported so far" });
    await expect(importedPanel.getByText("Demo Project")).toBeVisible();

    await screensNav(page).getByRole("button", { name: "Backlog" }).click();
    await expect(page.locator('[aria-label="backlog count"]')).toHaveText(
      `${VISIBLE_WPS} / ${VISIBLE_WPS} work packages`,
    );
  });

  test("T2: status filter narrows the backlog to exactly one status", async ({ page }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Backlog" }).click();
    await expect(page.locator('[aria-label="backlog count"]')).toHaveText(
      `${VISIBLE_WPS} / ${VISIBLE_WPS} work packages`,
    );

    // exact: true — an unscoped substring match also hits the header's
    // "connection status: green" button and the "Sort by Status" column
    // header, both of which contain "status" (confirmed live).
    await page.getByLabel("Status", { exact: true }).selectOption({ label: "New" });

    await expect(page.locator('[aria-label="backlog count"]')).toHaveText(`1 / ${VISIBLE_WPS} work packages`);
    await expect(page.locator("table.grid tbody tr")).toHaveCount(1);
    await expect(backlogRow(page, FIRST_WP_ID)).toBeVisible();

    // Reset the filter for later tests/specs sharing this same page state.
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.locator('[aria-label="backlog count"]')).toHaveText(
      `${VISIBLE_WPS} / ${VISIBLE_WPS} work packages`,
    );
  });

  test("T2: an override shows distinctly from the OP estimate, side by side", async ({ page }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Backlog" }).click();

    const row = backlogRow(page, FIRST_WP_ID);
    await expect(row).toBeVisible();

    // Table columns (BacklogScreen.tsx): …, Priority(9), OP est.(10),
    // Override(11), Effective(12), […] — SPEC_07 §4 inserted a "Server"
    // column between Project and Type, shifting every column after it by one
    // (confirmed live against the real header row). Scenario seeds
    // estimatedHours: 8 for every WP — the OP-estimate column (read-only,
    // straight from OpenProject) must show it before any override.
    await expect(row.locator("td").nth(10)).toHaveText("8h");
    // No local override yet: the override cell is empty and effective == OP est.
    await expect(row.locator("td").nth(11)).toHaveText("—");
    await expect(row.locator("td").nth(12)).toHaveText("8h");

    await row.getByRole("button", { name: `edit override for ${FIRST_WP_ID}` }).click();
    await row.getByRole("spinbutton", { name: `override hours for ${FIRST_WP_ID}` }).fill("5");
    await row.getByRole("button", { name: "Save" }).click();

    // OP estimate is untouched; override and effective both reflect the local 5h.
    await expect(row.locator("td").nth(10)).toHaveText("8h");
    await expect(row.locator("td").nth(11)).toHaveText("5h");
    await expect(row.locator("td").nth(12)).toHaveText("5h");
  });
});
