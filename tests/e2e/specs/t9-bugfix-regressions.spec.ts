import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { SPRINT_STATUS_TESTID, wpCardTestId } from "../utils/selectors";

/**
 * T9 — Increment 7 (SPEC_07_Bugfix_Batch.md §7) regressions. Self-contained:
 * own beforeAll, works standalone or last-in-suite. §2 (multi-project import)
 * is NOT covered — it could not be reproduced against the mock (see the
 * backend commit message); nothing to regression-guard.
 */

const PROJECT_OP_ID = 3;

async function screensNav(page: Page) {
  return page.getByRole("navigation", { name: "Screens" });
}

test.describe.serial("T9 — SPEC_07 bugfix regressions", () => {
  let connId: number;

  test.beforeAll(async ({ request }) => {
    await ensureVaultReady(request);
    connId = await ensureConnection(request);
    await loadScenario(request, "s5-burndown-happy");
    const sync = await request.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    if (!sync.ok()) throw new Error(`sync failed: ${sync.status()} ${await sync.text()}`);
  });

  test("§1: Disconnect flips the server row to a disconnected state; Reconnect restores it", async ({
    page,
    request,
  }) => {
    // NOTE: this deliberately does NOT assert on the header's aggregate health
    // dot — T7's guardrail test leaves behind an unreachable "canary" second
    // connection (by design, it never cleans up), so the aggregate is already
    // "orange" by the time T9 runs and can't usefully prove a green→non-green
    // transition here. The per-row UI state and the API's own `enabled` flag
    // are what §1 actually changed, so assert on those directly instead.
    await page.goto("/");
    await (await screensNav(page)).getByRole("button", { name: "Setup" }).click();

    const row = page.locator(".server-row", { hasText: "127.0.0.1" }).first();
    await expect(row.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await expect(row.getByText(/Disconnected —/)).toHaveCount(0);

    await row.getByRole("button", { name: "Disconnect" }).click();
    await expect(row.getByText(/Disconnected —/)).toBeVisible();
    await expect(row.getByRole("button", { name: "Connect" })).toBeVisible();

    const disabled = (await (await request.get("/api/connections")).json()) as Array<{
      id: number;
      enabled: boolean;
    }>;
    expect(disabled.find((c) => c.id === connId)?.enabled).toBe(false);

    await row.getByRole("button", { name: "Connect" }).click();
    await expect(row.getByText(/Disconnected —/)).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Disconnect" })).toBeVisible();

    const reenabled = (await (await request.get("/api/connections")).json()) as Array<{
      id: number;
      enabled: boolean;
    }>;
    expect(reenabled.find((c) => c.id === connId)?.enabled).toBe(true);
  });

  test("§3: activating and updating a sprint with real tickets never 400s on time entries, and stays green", async ({
    page,
    request,
  }) => {
    const sprintName = uniqueSprintName("T9 TimeEntries Sprint");
    const created = await request.post("/api/sprints", {
      data: { name: sprintName, start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    if (!created.ok()) throw new Error(`create sprint failed: ${created.status()}`);
    const sprintId = (await created.json()).id as number;
    const added = await request.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: 1501 } });
    if (!added.ok()) throw new Error(`add item failed: ${added.status()} ${await added.text()}`);

    await page.goto("/");
    await (await screensNav(page)).getByRole("button", { name: "Sprint board", exact: true }).click();
    const select = page.locator("#sprint-select");
    await select.selectOption({ label: `${sprintName} · planning` });

    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");
    await expect(page.locator(".msg.error")).toHaveCount(0);

    await page.getByRole("button", { name: "Update Sprint" }).click();
    await expect(page.locator(".msg.error")).toHaveCount(0);

    // The regression this guards: activating/updating a sprint fetches time
    // entries (entity_type+entity_id, SPEC_07 §3) — a bad filter used to 400
    // AND flip THIS connection's health to fail. Checked at the API level (not
    // the header's aggregate dot, which T7's leftover unreachable canary
    // connection already keeps off green regardless — see the §1 test above).
    const health = (await (await request.get("/api/connections/health")).json()) as {
      connections: Array<{ id: number; health: { last_status: string } }>;
    };
    expect(health.connections.find((c) => c.id === connId)?.health.last_status).toBe("ok");
  });

  test("§4: the backlog Server column/filter shows the connected mock and can sort/narrow by it", async ({
    page,
  }) => {
    await page.goto("/");
    await (await screensNav(page)).getByRole("button", { name: "Backlog", exact: true }).click();

    await expect(page.getByRole("button", { name: "Sort by Server" })).toBeVisible();
    await page.getByRole("button", { name: "Sort by Server" }).click(); // just exercises the sort, no crash

    const serverFilter = page.locator("#f-server");
    await expect(serverFilter).toBeVisible();
    const optionCount = await serverFilter.locator("option").count();
    expect(optionCount).toBeGreaterThan(1); // "All" + at least the one mock server

    // Selecting "All" keeps the full list; selecting the one real option re-fetches
    // scoped to that connection and must not error or empty out unexpectedly.
    const value = await serverFilter.locator("option").nth(1).getAttribute("value");
    await serverFilter.selectOption(value ?? "");
    await expect(page.locator('[aria-label="backlog count"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(serverFilter).toHaveValue("");
  });

  test("§5: dismissing a ticket from the Backlog screen does not remove it from an ACTIVE sprint's board", async ({
    page,
    request,
  }) => {
    const sprintName = uniqueSprintName("T9 Immutable Sprint");
    const created = await request.post("/api/sprints", {
      data: { name: sprintName, start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprintId = (await created.json()).id as number;
    const wpId = 1502;
    await request.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wpId } });
    await request.post(`/api/sprints/${sprintId}/activate`);

    // Dismiss the ticket from the backlog — LOCAL only, sprint_item untouched
    // server-side; the regression this guards is purely about what the UI shows.
    const dismiss = await request.post("/api/backlog/remove", { data: { wp_op_ids: [wpId] } });
    expect(dismiss.ok()).toBe(true);

    await page.goto("/");
    await (await screensNav(page)).getByRole("button", { name: "Backlog", exact: true }).click();
    await expect(page.locator(`[aria-label="Select #${wpId}"]`)).toHaveCount(0);

    await (await screensNav(page)).getByRole("button", { name: "Sprint board", exact: true }).click();
    const select = page.locator("#sprint-select");
    await select.selectOption({ label: `${sprintName} · active` });

    const card = page.getByTestId(wpCardTestId(wpId));
    await expect(card).toBeVisible();
    await expect(card).toContainText("no longer in backlog");

    // Capacity must still count it (SPEC_07 §5 follow-on capacity fix).
    const capRes = await request.get(`/api/sprints/${sprintId}/capacity`);
    const cap = (await capRes.json()) as { lines: Array<{ planned_hours: number }> };
    const totalPlanned = cap.lines.reduce((s, l) => s + l.planned_hours, 0);
    expect(totalPlanned).toBeGreaterThan(0);
  });
});
