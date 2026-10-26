import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { S22_PROJECTS, S22_WP } from "@osp/fixtures/scenarios";
import {
  ensureConnection,
  ensureVaultReady,
  loadScenario,
  openWindowEnd,
  uniqueSprintName,
} from "../fixtures/helpers";
import { wpCardTestId } from "../utils/selectors";

/**
 * TW — Increment 40 (docs/INCREMENT_40_CONTRACTS.md §1.2 / §2 Agent C+D):
 * every ticket surface shows its OpenProject project.
 *
 *   §a Backlog: sortable "Project" header (by displayed name, nulls last) and
 *      a Project filter whose option VALUES are the connection-safe keys
 *      (`${connection_id}:${project_op_id}`) — selecting northwind shows only
 *      northwind rows.
 *   §b Sprint Board: each WpCard carries a neutral `.badge.project` with the
 *      identifier (tooltip = name); the hidden project's ticket (identifier
 *      unknown — /projects/{id} is 404) falls back to the name.
 *   §c Closure: the per-ticket statistics table has a Project column (name,
 *      tooltip = identifier).
 *   §d The status PDF downloads from the board's "Export status PDF" button.
 *      (The PDF's Project column/legend are asserted at the HTML level by
 *      apps/api's PDF tests — Chromium's PDF text is compressed/subset and is
 *      not greppable here, and the tests package has no PDF parser.)
 *
 * Data: fixtures/scenarios/s22-multi-project.ts (fictional projects only),
 * loaded onto the standard e2e mock (8199). FILE NAME: "tw-" follows "tv-" so
 * this runs after every earlier spec against the ONE shared backend; the data
 * is additive (other scenarios' tickets stay in the backlog), so every
 * assertion below is scoped to S22 rows or is order-generic.
 *
 * Guardrail: only the run's throwaway `osp_e2e_*` DB + the e2e ports
 * (playwright.config.ts) — nothing here can reach the user's `osp`.
 */

const NW = S22_PROJECTS.northwind;
const HB = S22_PROJECTS.harbor;
const HIDDEN = S22_PROJECTS.hidden;
const SPRINT_WPS = [S22_WP.nwSettlement, S22_WP.hbBerthImport, S22_WP.hiddenAuthBump] as const;
/** S22 day 0 (fixtures/scenarios/s22-multi-project.ts `startDate`). */
const S22_START = "2026-09-07";

/** Backlog table column of "Project" (checkbox, ID, Subject, Project, …). */
const PROJECT_COL = 4;

function screensNav(page: Page) {
  return page.getByRole("navigation", { name: "Screens" });
}

async function gotoTab(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name, exact: true }).click();
}

async function selectSprint(page: Page, sprintId: number): Promise<void> {
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
}

async function okJson<T>(res: Awaited<ReturnType<APIRequestContext["post"]>>, what: string): Promise<T> {
  if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Activation is ASYNC (SPEC_09 §1): poll the list until the requested status. */
async function waitSprintStatus(ctx: APIRequestContext, sprintId: number, status: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await ctx.get("/api/sprints");
    if (res.ok()) {
      const s = ((await res.json()) as Array<{ id: number; status: string }>).find((x) => x.id === sprintId);
      if (s?.status === status) return;
    }
    if (Date.now() > deadline) throw new Error(`sprint ${sprintId} never reached "${status}"`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.describe.serial("TW — Increment 40: the project of every ticket", () => {
  let connId = 0;
  let sprintId = 0;
  const sprintName = uniqueSprintName("TW Multi-project");

  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    await ensureVaultReady(request);
    await loadScenario(request, "s22-multi-project");
    connId = await ensureConnection(request);
    // Known cross-spec trap: an earlier spec can leave its own random-port mock
    // connection CURRENT (and sometimes disabled). Re-point explicitly.
    await okJson(
      await request.patch(`/api/connections/${connId}`, { data: { current: true, enabled: true } }),
      "select connection",
    );
    await okJson(await request.get("/api/projects"), "project picker");
    for (const project of [NW.id, HB.id]) {
      await okJson(
        await request.post("/api/sync", { data: { project_op_id: project, connection_id: connId } }),
        `sync project ${project}`,
      );
    }
    // The hidden project's ticket arrives the realistic way: added by id.
    await okJson(
      await request.post("/api/work-packages", { data: { op_id: S22_WP.hiddenAuthBump } }),
      "add hidden-project ticket by id",
    );

    const created = await okJson<{ id: number }>(
      await request.post("/api/sprints", {
        data: { name: sprintName, start_date: S22_START, end_date: openWindowEnd() },
      }),
      "create sprint",
    );
    sprintId = created.id;
    for (const wp of SPRINT_WPS) {
      await okJson(await request.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp } }), `add #${wp}`);
    }
    await okJson(await request.post(`/api/sprints/${sprintId}/activate`), "activate");
    await waitSprintStatus(request, sprintId, "active");
  });

  test.afterAll(async ({ request }) => {
    if (sprintId) await request.delete(`/api/sprints/${sprintId}`);
  });

  test("§a Backlog: Project column sorts by displayed name (asc/desc) and the keyed filter isolates northwind", async ({
    page,
  }) => {
    await gotoTab(page, "Backlog");
    const table = page.locator("table.grid");
    await expect(table).toBeVisible();

    const projectCells = table.locator(`tbody tr td:nth-child(${PROJECT_COL})`);
    const sortBtn = page.getByRole("button", { name: "Sort by Project" });

    await sortBtn.click();
    await expect(table.locator("th", { has: sortBtn })).toHaveAttribute("aria-sort", "ascending");
    const asc = (await projectCells.allInnerTexts()).map((t) => t.trim());
    expect(asc.length).toBeGreaterThan(0);
    assertSorted(asc, "asc");

    await sortBtn.click();
    await expect(table.locator("th", { has: sortBtn })).toHaveAttribute("aria-sort", "descending");
    const desc = (await projectCells.allInnerTexts()).map((t) => t.trim());
    assertSorted(desc, "desc");

    // Filter: the option VALUE is the connection-safe key, never the name.
    const filter = page.locator("#f-project");
    await expect(filter.locator(`option[value="${connId}:${NW.id}"]`)).toHaveCount(1);
    await expect(filter.locator(`option[value="${connId}:${HIDDEN.id}"]`)).toHaveText(HIDDEN.name);
    await filter.selectOption(`${connId}:${NW.id}`);

    const rows = table.locator("tbody tr");
    await expect(rows.filter({ hasText: `${S22_WP.nwSettlement}` }).first()).toBeVisible();
    await expect(rows.filter({ hasText: `${S22_WP.nwRefundRetry}` }).first()).toBeVisible();
    await expect(rows.filter({ hasText: `${S22_WP.hbBerthImport}` })).toHaveCount(0);
    const filtered = (await projectCells.allInnerTexts()).map((t) => t.trim());
    expect(new Set(filtered)).toEqual(new Set([NW.name]));
    // Web tables: name shown, identifier in the tooltip.
    await expect(projectCells.first()).toHaveAttribute("title", NW.identifier);
  });

  test("§b Sprint Board: each card shows a neutral project badge (identifier, tooltip = name; hidden ⇒ name)", async ({
    page,
  }) => {
    await gotoTab(page, "Sprint board");
    await selectSprint(page, sprintId);

    const nwBadge = page.getByTestId(wpCardTestId(S22_WP.nwSettlement)).locator(".badge.project");
    await expect(nwBadge).toHaveText(NW.identifier);
    await expect(nwBadge).toHaveAttribute("title", NW.name);

    const hbBadge = page.getByTestId(wpCardTestId(S22_WP.hbBerthImport)).locator(".badge.project");
    await expect(hbBadge).toHaveText(HB.identifier);
    await expect(hbBadge).toHaveAttribute("title", HB.name);

    // Hidden project: /projects/{id} is 404 → identifier unknown → name.
    const hiddenBadge = page.getByTestId(wpCardTestId(S22_WP.hiddenAuthBump)).locator(".badge.project");
    await expect(hiddenBadge).toHaveText(HIDDEN.name);
  });

  test("§c Closure: the per-ticket statistics table has a Project column (name, tooltip = identifier)", async ({
    page,
  }) => {
    await gotoTab(page, "Closure");
    await selectSprint(page, sprintId);

    const nw = page.getByTestId(`per-ticket-project-${S22_WP.nwSettlement}`);
    await expect(nw).toHaveText(NW.name);
    await expect(nw).toHaveAttribute("title", NW.identifier);
    const hb = page.getByTestId(`per-ticket-project-${S22_WP.hbBerthImport}`);
    await expect(hb).toHaveText(HB.name);
    await expect(hb).toHaveAttribute("title", HB.identifier);
    await expect(page.getByTestId(`per-ticket-project-${S22_WP.hiddenAuthBump}`)).toHaveText(HIDDEN.name);
  });

  test("§d the status PDF downloads from the Sprint Board for a multi-project sprint", async ({ page }) => {
    test.setTimeout(120_000);
    await gotoTab(page, "Sprint board");
    await selectSprint(page, sprintId);

    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await page.getByTestId("export-status-pdf").click();
    const download = await downloadPromise;
    await expect(page.getByTestId("export-status-pdf-error")).toHaveCount(0);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const path = await download.path();
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(5_000);
  });
});

/** Order-generic check over the visible page: "—" (no project) sorts last in
 * BOTH directions; the rest are case-insensitively ordered (localeCompare,
 * exactly the comparator the screen uses). */
function assertSorted(values: string[], dir: "asc" | "desc"): void {
  const named = values.filter((v) => v !== "—");
  const firstDash = values.indexOf("—");
  if (firstDash !== -1) {
    expect(values.slice(firstDash).every((v) => v === "—"), `"—" rows sort last (${dir})`).toBe(true);
  }
  for (let i = 1; i < named.length; i += 1) {
    const cmp = named[i - 1]!.toLowerCase().localeCompare(named[i]!.toLowerCase());
    if (dir === "asc") expect(cmp, `${named[i - 1]} ≤ ${named[i]}`).toBeLessThanOrEqual(0);
    else expect(cmp, `${named[i - 1]} ≥ ${named[i]}`).toBeGreaterThanOrEqual(0);
  }
}
