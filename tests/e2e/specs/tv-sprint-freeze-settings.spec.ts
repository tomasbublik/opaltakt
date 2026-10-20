import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { SPRINT_STATUS_TESTID } from "../utils/selectors";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { assertThrowawayDatabase } from "../../src/db-isolation";

/**
 * TV — Increment 31 (docs/INCREMENT_31_CONTRACTS.md §4/§5.7) — Settings tab
 * (freeze grace period) + the Import page's out-of-selection cleanup treating
 * a FROZEN sprint's tickets as removable while an active sprint's stay
 * protected.
 *
 * FILE NAME NOTE: "tv-" continues the … → tt → tu → "tv-…" lexicographic
 * sequence, so this spec runs LAST (after tu-sync-coverage.spec.ts), against
 * the ONE shared backend every spec in this directory shares. Do not rename.
 *
 * ── No HTTP trigger for freeze (contracts §2b) ──────────────────────────────
 * A sprint is frozen by the 30-min scheduler tick (or the boot sweep) once
 * `now >= locked_at + freeze_grace_days` — there is no manual "freeze now"
 * endpoint, and the scheduler is disabled in this e2e environment (SPEC_06
 * §3-style convention: every other spec that needs a background job effect
 * drives it explicitly, e.g. advanceDay's `appUrl` sync). So §2b below builds
 * a REAL activated+finished sprint through the UI (baseline capture, lock —
 * everything the app itself does), then seeds ONLY the one column the sweep
 * would flip (`sprint.frozen_at`) directly in the throwaway e2e database —
 * exactly the "DB helper used by other specs" fallback this file's
 * orchestration prompt anticipated, following tu-sync-coverage.spec.ts's own
 * `sql`/`assertThrowawayDatabase` pattern verbatim. Nothing here ever writes
 * to OpenProject (finish/activate are already GET-only to OP by the
 * pre-existing invariant) or touches any database but the run's own
 * `osp_e2e_<pid>`.
 */

const PROJECT_OP_ID = 3;

// ── direct SQL against THE THROWAWAY DATABASE ONLY (tu-sync-coverage.spec.ts
// convention, reproduced verbatim rather than imported — that file has no
// exported helper module, only inline functions). ──────────────────────────
const exec = promisify(execFile);
async function sql(query: string): Promise<void> {
  assertThrowawayDatabase(E2E_DATABASE_URL);
  await exec("psql", [E2E_DATABASE_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", query], {
    env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
  });
}

/** Freeze a sprint the way the (disabled-in-this-env) sweep would — see the
 * file-header note on why this is a legitimate substitute here. */
async function freezeSprintDirectly(sprintId: number): Promise<void> {
  await sql(`UPDATE sprint SET frozen_at = now() WHERE id = ${sprintId}`);
}

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

function screensNav(page: Page) {
  return page.getByRole("navigation", { name: "Screens" });
}

test.beforeAll(async ({ request }) => {
  await ensureVaultReady(request);
  await ensureConnection(request);
});

// ═════════════════════════════════════════════════════════════════════════════
// §a — Settings tab: edit grace days, persists across reload.
// ═════════════════════════════════════════════════════════════════════════════

test.describe.serial("TV §a — Settings tab: freeze grace period persists", () => {
  test("changing the grace-days field, saving, and reloading shows the SAVED value, not the old default", async ({
    page,
  }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const graceInput = page.locator("#settings-grace-days");
    await expect(graceInput).toBeVisible();
    const before = await graceInput.inputValue();

    // Pick a value guaranteed to differ from whatever is currently stored
    // (additive/shared-backend spec — never assume today's default is 3).
    const beforeNum = Number(before);
    const next = ((Number.isFinite(beforeNum) ? beforeNum : 3) + 5) % 61; // stays in [0,60]

    await graceInput.fill(String(next));
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible();
    await expect(graceInput).toHaveValue(String(next));

    // Persistence proof: a fresh navigation re-fetches GET /api/config, not a
    // client-only state — must show the SAVED value, not the pre-edit one.
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Settings" }).click();
    await expect(page.locator("#settings-grace-days")).toHaveValue(String(next));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §b — Import page: a frozen-sprint ticket is removable; an active-sprint
// ticket stays disabled with the "cannot be removed" copy.
// ═════════════════════════════════════════════════════════════════════════════

test.describe.serial("TV §b — Import page: frozen sprints stop protecting their tickets", () => {
  const activeSprintName = uniqueSprintName("TV Active Sprint");
  const frozenSprintName = uniqueSprintName("TV Frozen Sprint");
  const WP_ACTIVE = 1201; // s2-status-spectrum: one WP per canonical status, ids 1201..1210.
  const WP_FROZEN = 1202;
  let importSelectionId: number;

  test.beforeAll(async ({ request, browser }) => {
    test.setTimeout(120_000);
    await loadScenario(request, "s2-status-spectrum");
    // Shared-backend hygiene: an earlier spec (tu-sync-coverage runs right
    // before this file alphabetically) leaves ITS OWN random-port mock
    // connection as the CURRENT one, sometimes disabled — `ensureConnection`
    // only guarantees the standard mock connection EXISTS, not that it is
    // current/enabled, so a full-suite run 409'd here with
    // CONNECTION_DISABLED while a solo run passed. Explicitly re-point the
    // app at the standard mock before syncing.
    const connId = await ensureConnection(request);
    const selectRes = await request.patch(`/api/connections/${connId}`, {
      data: { current: true, enabled: true },
    });
    if (!selectRes.ok())
      throw new Error(`select connection failed: ${selectRes.status()} ${await selectRes.text()}`);
    const syncRes = await request.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    if (!syncRes.ok()) throw new Error(`sync failed: ${syncRes.status()} ${await syncRes.text()}`);

    // ── ACTIVE sprint (protects WP_ACTIVE) ──────────────────────────────────
    const createdActive = await request.post("/api/sprints", {
      data: { name: activeSprintName, start_date: "2026-07-01", end_date: "2026-07-20", capacity_mode: "per_person" },
    });
    if (!createdActive.ok()) throw new Error(`create active sprint failed: ${createdActive.status()}`);
    const activeSprintId = ((await createdActive.json()) as { id: number }).id;
    const addA = await request.post(`/api/sprints/${activeSprintId}/items`, { data: { wp_op_id: WP_ACTIVE } });
    if (!addA.ok()) throw new Error(`add WP_ACTIVE failed: ${addA.status()} ${await addA.text()}`);

    // ── (soon-to-be) FROZEN sprint (protects WP_FROZEN only until frozen) ──
    const createdFrozen = await request.post("/api/sprints", {
      data: { name: frozenSprintName, start_date: "2026-07-01", end_date: "2026-07-05", capacity_mode: "per_person" },
    });
    if (!createdFrozen.ok()) throw new Error(`create frozen sprint failed: ${createdFrozen.status()}`);
    const frozenSprintId = ((await createdFrozen.json()) as { id: number }).id;
    const addF = await request.post(`/api/sprints/${frozenSprintId}/items`, { data: { wp_op_id: WP_FROZEN } });
    if (!addF.ok()) throw new Error(`add WP_FROZEN failed: ${addF.status()} ${await addF.text()}`);

    // Activate + finish (via the UI, exactly the mechanism a real user would
    // use) for BOTH sprints — the active one stays active; the other locks so
    // it can be frozen.
    const page = await browser.newPage();
    page.on("dialog", (d) => void d.accept());

    await openBoardWithSprint(page, activeSprintName);
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");

    await openBoardWithSprint(page, frozenSprintName);
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("active");
    await page.getByRole("button", { name: "Update Sprint" }).click();
    await expect(page.locator(".msg.error")).toHaveCount(0);
    await page.getByRole("button", { name: "Finish sprint" }).click();
    await expect(page.getByTestId(SPRINT_STATUS_TESTID)).toHaveText("Finished");

    await page.close();

    // Drop the import selection the initial sync created — WITHOUT this,
    // WP_ACTIVE/WP_FROZEN stay "in selection" and never appear in the
    // out-of-selection panel at all. Deliberately BEFORE the freeze: the
    // DELETE /imports/:id cascade deletes REMOVABLE cache rows (contracts §3
    // — a frozen sprint no longer protects), so freezing first would delete
    // WP_FROZEN's row right here and the panel would have nothing to list.
    // At this instant both sprints still protect (active / closed-in-grace),
    // so both cache rows survive and merely fall out of selection.
    const imports = (await (await request.get("/api/imports")).json()) as Array<{
      id: number;
      project_op_id: number;
    }>;
    const sel = imports.find((i) => i.project_op_id === PROJECT_OP_ID);
    if (!sel) throw new Error(`no import selection found for project ${PROJECT_OP_ID}`);
    importSelectionId = sel.id;
    const del = await request.delete(`/api/imports/${importSelectionId}`);
    if (!del.ok()) throw new Error(`delete import selection failed: ${del.status()} ${await del.text()}`);

    // Now actually freeze it (see file header: no HTTP trigger exists).
    await freezeSprintDirectly(frozenSprintId);
    const sprintsAfter = (await (await request.get("/api/sprints")).json()) as Array<{
      id: number;
      frozen_at: string | null;
    }>;
    const frozenRow = sprintsAfter.find((s) => s.id === frozenSprintId);
    if (!frozenRow || frozenRow.frozen_at === null) {
      throw new Error(`sprint ${frozenSprintId} did not come back frozen after the direct SQL freeze`);
    }
  });

  test("the Import page shows the active-sprint ticket as disabled ('cannot be removed') and the frozen-sprint ticket as removable", async ({
    page,
  }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Import" }).click();

    const panel = page.locator(".panel").filter({ has: page.getByRole("heading", { name: /out-of-selection/i }) });
    await expect(panel, "the out-of-selection panel is visible").toBeVisible({ timeout: 30_000 });

    // The ID cell renders `#<op_id>` (ImportScreen.tsx) — match that exactly.
    const activeRow = panel.locator("tr", { has: page.getByText(`#${WP_ACTIVE}`, { exact: true }) });
    const frozenRow = panel.locator("tr", { has: page.getByText(`#${WP_FROZEN}`, { exact: true }) });
    await expect(activeRow).toBeVisible();
    await expect(frozenRow).toBeVisible();

    // Active-sprint ticket: checkbox disabled, "cannot be removed" copy
    // (docs §4.2 / ImportScreen.tsx's `e.protected` branch).
    await expect(activeRow.getByRole("checkbox")).toBeDisabled();
    await expect(activeRow).toContainText("cannot be removed");
    await expect(activeRow).toContainText(activeSprintName);

    // Frozen-sprint ticket: checkbox ENABLED, "removable" copy naming the
    // frozen sprint (docs §4.2 / ImportScreen.tsx's `frozen_sprint_names` note).
    await expect(frozenRow.getByRole("checkbox")).toBeEnabled();
    await expect(frozenRow).toContainText("removable");
    await expect(frozenRow).toContainText(frozenSprintName);
  });

  test("bulk delete removes the frozen-sprint ticket on one confirmation, leaving the active-sprint ticket in place", async ({
    page,
  }) => {
    await page.goto("/");
    await screensNav(page).getByRole("button", { name: "Import" }).click();

    const panel = page.locator(".panel").filter({ has: page.getByRole("heading", { name: /out-of-selection/i }) });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // The ID cell renders `#<op_id>` (ImportScreen.tsx) — match that exactly.
    await expect(panel.getByText(`#${WP_FROZEN}`, { exact: true })).toBeVisible();

    // "Select all" only ever covers REMOVABLE rows (docs §4.2) — clicking it
    // must never risk the active-sprint ticket even though it is also listed.
    await panel.getByRole("checkbox", { name: "Select all" }).check();
    const remove = panel.getByRole("button", { name: /Remove selected/i });
    await expect(remove).toBeEnabled();
    await remove.click();
    await page.getByTestId("out-of-selection-confirm-button").click();

    const result = page.getByTestId("out-of-selection-result");
    await expect(result).toBeVisible({ timeout: 30_000 });

    // The database is the proof: the frozen ticket's cache row is gone, the
    // active ticket's survives — exactly Invariant 10's promise made visible
    // through the Import screen instead of a direct repos call.
    const cacheAfter = (await (await page.request.get("/api/backlog/out-of-selection")).json()) as {
      entries: Array<{ op_id: number }>;
    };
    const remainingIds = cacheAfter.entries.map((e) => e.op_id);
    expect(remainingIds, `#${WP_FROZEN} was removed`).not.toContain(WP_FROZEN);
    // WP_ACTIVE is still protected, so it may or may not still be LISTED
    // (still out-of-selection either way) but must never have been deletable —
    // the previous test already proved its checkbox was disabled; this
    // re-confirms the cache row itself survived the bulk action.
    expect(remainingIds, `#${WP_ACTIVE} (protected) survives`).toContain(WP_ACTIVE);
  });
});
