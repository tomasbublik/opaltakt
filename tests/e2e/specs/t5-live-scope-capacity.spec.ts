import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  advanceDay,
  ensureConnection,
  ensureVaultReady,
  loadScenario,
  openWindowEnd,
  uniqueSprintName,
} from "../fixtures/helpers";
import { SCENARIO_WP_IDS, SPRINT_STATUS_TESTID, wpCardTestId } from "../utils/selectors";
import { E2E_URLS } from "../../playwright.config";

/**
 * T5 — Increment 5 (live scope + capacity), scenario s4-volatile-sprint.
 * Self-contained: this file's own beforeAll ensures the vault + a connection
 * exist even if run in isolation, then loads the scenario itself (a load is
 * a FULL reset of the mock).
 */

const PROJECT_OP_ID = 3;
const BASELINE = SCENARIO_WP_IDS.s4.baseline; // [1401..1406]
const REMOVED_WITH_TIME = 1401; // "session" — dev logs 6h+6h on days 1-2 (Developed, 0 remaining)
const URGENT_TO_ADD = 1451; // "URGENT: Production login returns HTTP 500" — assignee dev
const DEV = "Dev Dvořák";
const TESTER = "Tereza Testerová";

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

/** Read a `.bar-seg` span's inline `width: N%` — 0 if the segment is absent/zero. */
async function segWidthPct(seg: Locator): Promise<number> {
  const style = await seg.getAttribute("style");
  const m = style?.match(/width:\s*([\d.]+)%/);
  return m ? Number(m[1]) : 0;
}

async function expectSegPositive(seg: Locator): Promise<void> {
  await expect.poll(async () => segWidthPct(seg), { timeout: 10_000 }).toBeGreaterThan(0);
}

test.describe.serial("T5 — live scope + capacity (s4-volatile-sprint)", () => {
  const sprintName = uniqueSprintName("T5 Volatile Sprint");
  let sprintId: number;
  let page: Page;

  test.beforeAll(async ({ request, browser }) => {
    await ensureVaultReady(request);
    await ensureConnection(request);
    await loadScenario(request, "s4-volatile-sprint");

    const syncRes = await request.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    if (!syncRes.ok()) throw new Error(`sync failed: ${syncRes.status()} ${await syncRes.text()}`);

    const created = await request.post("/api/sprints", {
      data: {
        name: sprintName,
        start_date: "2026-07-01",
        end_date: openWindowEnd(),
        capacity_mode: "per_person",
      },
    });
    if (!created.ok()) throw new Error(`create sprint failed: ${created.status()} ${await created.text()}`);
    sprintId = (await created.json()).id as number;

    for (const wpId of BASELINE) {
      const added = await request.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wpId } });
      if (!added.ok()) throw new Error(`add item ${wpId} failed: ${added.status()} ${await added.text()}`);
    }

    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("create + set capacity + activate a sprint holding the baseline tickets", async () => {
    await openBoardWithSprint(page, sprintName);
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("planning");

    // Real, non-zero availability so the later "unchanged" check (and the
    // stacked-bar percentages) are meaningful rather than trivially 0.
    await page.getByLabel(`available hours for ${DEV}`).fill("40");
    await page.getByLabel(`available hours for ${TESTER}`).fill("30");
    await page.getByRole("button", { name: /Save capacity|Saving…/ }).click();
    await expect(page.getByRole("button", { name: "Save capacity" })).toBeVisible();

    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");
  });

  test("mid-sprint add (via the app's own Backlog 'Add →') creates an amber idle segment without touching available hours", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    // Advance through day 3: days 1-2 burn baseline hours (so WP 1401 already
    // has logged time by the removal test below), day 3 is the scenario's
    // "weekend incident" that adds the urgent WPs (1451-1453) to OP. Each
    // call's appUrl option re-syncs the real app, pulling the new WPs into
    // the local backlog.
    for (let day = 1; day <= 3; day += 1) {
      await advanceDay(request, { appUrl: E2E_URLS.api });
    }

    await openBoardWithSprint(page, sprintName);

    // FLAKE FIX (Increment 30): a bare `inputValue()` reads the DOM once, so it
    // could sample the availability field in the render tick BEFORE the capacity
    // response populated it and see "". Observed failing in 2 of 3 full runs
    // ("Expected: 40, Received: ''") with no behavioural change behind it.
    // `toHaveValue` polls, which is what an assertion about an async-populated
    // field needs — the assertion itself is unchanged.
    const availInput = page.getByLabel(`available hours for ${DEV}`);
    await expect(availInput).toHaveValue("40");
    const availBefore = await availInput.inputValue();

    // The app's own "add a ticket to a running sprint" flow: same "Add →"
    // button as planning-time adds — the server enforces active-sprint
    // (mid-sprint) semantics, giving it origin=added_mid_sprint.
    await page.getByLabel("Search backlog").fill(String(URGENT_TO_ADD));
    const urgentCard = page.getByTestId(wpCardTestId(URGENT_TO_ADD));
    await expect(urgentCard).toBeVisible();
    await urgentCard.getByRole("button", { name: "Add →" }).click();

    // Identity unification: the developer now ALWAYS has a per-ticket segment
    // bar (before, a role-less person had no closure row, so the aggregate
    // fallback bar rendered and painted any added ticket red regardless of
    // work). Canonically (CAPACITY_BAR_RULES §2) an added ticket the developer
    // has NOT yet logged on is the amber-hatched `idle` segment — red
    // (`acquired`) only once they log time on it.
    const devBar = page.locator(`[aria-label="load for ${DEV}"]`);
    await expectSegPositive(devBar.locator(".bar-idle"));

    const availAfter = await page.getByLabel(`available hours for ${DEV}`).inputValue();
    expect(availAfter).toBe(availBefore);
  });

  test("removing a baseline ticket that already has logged time stays visible, greyed, badged 'removed' — and its assignee shows green+red+blue together", async () => {
    await openBoardWithSprint(page, sprintName);

    const card = page.getByTestId(wpCardTestId(REMOVED_WITH_TIME));
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "← Return" }).click();

    // Stays visible (not a hard delete) because time was already logged
    // against it — SPEC_05 §1/§9.1 (SprintBoardScreen.tsx isVisibleInSprint).
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/card-removed/);
    await expect(card.locator(".badge.removed")).toContainText("removed");
    // No move control once it's a historical-removed card (also gated by `disabled`).
    await expect(card.getByRole("button", { name: "← Return" })).toHaveCount(0);

    // Dev now has: green (1402/1405/1406 still in scope), blue (1401 just
    // removed — the aggregate removed-from-sprint span, CAPACITY_BAR_RULES §2),
    // and amber (1451 added mid-sprint, not yet worked → `idle`; it would be
    // red `acquired` only once the dev logs on it) — all three simultaneously
    // on the same person's bar.
    const devBar = page.locator(`[aria-label="load for ${DEV}"]`);
    await expectSegPositive(devBar.locator(".bar-green").first());
    await expectSegPositive(devBar.locator(".bar-blue"));
    await expectSegPositive(devBar.locator(".bar-idle"));
  });
});
