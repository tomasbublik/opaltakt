import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { SCENARIO_WP_IDS } from "../utils/selectors";

/**
 * T8 — REGRESSION checks for real bugs fixed earlier in this project's history
 * (SPEC_06 §4 T8; SPEC_05 §6.1/§6.2):
 *
 *   1. The sprint lifecycle action controls (Activate / Update Sprint / Finish /
 *      Back to planning) live INSIDE the "Sprint details" panel — not in a
 *      separate floating panel elsewhere (SPEC_05 §6.1 UI fix).
 *   2. Clicking "Update Sprint" on an ALREADY-active sprint does NOT throw a
 *      `SPRINT_NOT_ACTIVE` error (the historical update-after-activate bug); the
 *      "Last updated … ago" line shows and a second click still works.
 *   3. A lifecycle error names the sprint by its REAL NAME, never a bare internal
 *      id like "Sprint 42" (SPEC_05 §6.2). Mirrors the vitest guard
 *      `tests/src/sprint-error-names.test.ts` at the E2E/HTTP layer — asserting the
 *      backend response body that the frontend's `errorMessage()` (apps/web/src/
 *      components/ui.tsx) renders verbatim (plus a details.sprintName backstop).
 */

const SCENARIO = "s5-burndown-happy";
const PROJECT_OP_ID = 3;
const WP = SCENARIO_WP_IDS.s5.tickets[0]; // 1501

interface CreatedSprint {
  id: number;
  name: string;
}

test.describe.serial("T8 — UI-fix regressions", () => {
  let setup: APIRequestContext;

  test.beforeAll(async () => {
    // Own APIRequestContext (test-scoped fixtures are unavailable in beforeAll).
    // Idempotent bootstrap so this file also works run in isolation.
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    await loadScenario(setup, SCENARIO); // full reset of the mock to day 0
    await ensureConnection(setup);
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `import sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();
  });

  test.afterAll(async () => {
    await setup.dispose();
  });

  /** Create a fresh planning sprint (unique name) with one item, via the API. */
  async function createSprintWithItem(request: APIRequestContext, label: string): Promise<CreatedSprint> {
    const name = uniqueSprintName(label);
    const created = await request.post("/api/sprints", {
      data: { name, start_date: "2026-07-01", end_date: "2026-07-15", capacity_mode: "per_person" },
    });
    expect(created.ok(), `create sprint: ${created.status()} ${await created.text()}`).toBeTruthy();
    const id = ((await created.json()) as { id: number }).id;
    const added = await request.post(`/api/sprints/${id}/items`, { data: { wp_op_id: WP } });
    expect(added.ok(), `add item: ${added.status()} ${await added.text()}`).toBeTruthy();
    return { id, name };
  }

  /** Open the board on a specific sprint (explicit select beats "active-first" auto-select). */
  async function openBoardOnSprint(page: Page, sprintId: number): Promise<void> {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sprint board" })).toBeEnabled();
    await page.getByRole("button", { name: "Sprint board" }).click();
    const select = page.getByLabel("Sprint", { exact: true });
    await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
    await select.selectOption(String(sprintId));
    await expect(page.getByRole("heading", { name: "Sprint details" })).toBeVisible();
  }

  /** The single <section class="panel"> that holds the "Sprint details" heading. */
  function sprintDetailsPanel(page: Page) {
    return page
      .locator("section.panel")
      .filter({ has: page.getByRole("heading", { name: "Sprint details" }) });
  }

  test("lifecycle controls live INSIDE the Sprint details panel (not a floating panel)", async ({
    page,
    request,
  }) => {
    const sprint = await createSprintWithItem(request, "T8 panel");
    await openBoardOnSprint(page, sprint.id);

    const panel = sprintDetailsPanel(page);

    // Planning state: the only lifecycle button is Activate — and it is a
    // DESCENDANT of the Sprint details panel, and there is exactly one on the page
    // (i.e. it is NOT also rendered by some separate floating panel).
    await expect(panel.getByRole("button", { name: "Activate" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate" })).toHaveCount(1);

    // Activate, then the active-state controls must ALL live in that same panel.
    await panel.getByRole("button", { name: "Activate" }).click();
    for (const label of ["Update Sprint", "Finish sprint", "Back to planning"]) {
      await expect(
        panel.getByRole("button", { name: label }),
        `"${label}" must be inside the Sprint details panel`,
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: label }),
        `"${label}" must not be duplicated by a floating panel`,
      ).toHaveCount(1);
    }
  });

  test("Update Sprint on an already-active sprint does NOT throw SPRINT_NOT_ACTIVE (clicked twice)", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const sprint = await createSprintWithItem(request, "T8 update");
    // Activate up-front via the API so the board opens on an ALREADY-active sprint
    // — the exact state the historical update-after-activate bug fired on.
    const activate = await request.post(`/api/sprints/${sprint.id}/activate`);
    expect(activate.ok(), `activate: ${activate.status()} ${await activate.text()}`).toBeTruthy();

    await openBoardOnSprint(page, sprint.id);

    const panel = sprintDetailsPanel(page);
    const updateBtn = panel.getByRole("button", { name: "Update Sprint" });
    await expect(updateBtn).toBeVisible();

    // First click — no error, and the "Last updated …" line appears.
    await updateBtn.click();
    await expect(page.getByText(/Last updated/)).toBeVisible();
    await expect(updateBtn).toBeEnabled(); // run finished, button is back
    // ErrorBox renders `.msg.error` (overload/other warnings are `.msg.warn` — those
    // are fine); assert specifically NO error surface and no SPRINT_NOT_ACTIVE text.
    await expect(page.locator(".msg.error")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("SPRINT_NOT_ACTIVE");
    await expect(page.locator("body")).not.toContainText("has not been activated");

    // Second click in a row — still no error.
    await updateBtn.click();
    await expect(updateBtn).toBeEnabled();
    await expect(page.locator(".msg.error")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("SPRINT_NOT_ACTIVE");
    await expect(page.locator("body")).not.toContainText("has not been activated");

    // Data-level cross-check (the "Last updated" text is minute-granular, so it can
    // read the same across two fast clicks): both updates were recorded and neither
    // errored — proof the second update-after-activate went through cleanly.
    const runs = (await (await request.get(`/api/sprints/${sprint.id}/updates`)).json()) as Array<{
      status: string;
    }>;
    expect(runs.length, "expected at least two recorded update runs").toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => r.status !== "error"), "no update run may have errored").toBeTruthy();
  });

  test("a lifecycle error names the sprint by its real name, never a bare numeric id", async ({
    request,
  }) => {
    // Genuinely reachable error: POST /update on a still-planning sprint →
    // SPRINT_NOT_ACTIVE (see apps/api/src/logic/sprintUpdate.ts healMissingActivation).
    const sprint = await createSprintWithItem(request, "T8 error-name");

    const res = await request.post(`/api/sprints/${sprint.id}/update`, { data: {} });
    expect(res.status(), "SPRINT_NOT_ACTIVE maps to HTTP 409").toBe(409);

    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { sprintName?: string } };
    };
    expect(body.error.code).toBe("SPRINT_NOT_ACTIVE");
    // details.sprintName carries the EXACT user-facing name…
    expect(body.error.details?.sprintName).toBe(sprint.name);
    // …the message references the real name…
    expect(body.error.message).toContain(sprint.name);
    // …and NEVER the bare internal id ("Sprint <dbId>"), the historical bug.
    expect(new RegExp(`Sprint ${sprint.id}\\b`).test(body.error.message)).toBe(false);
  });
});
