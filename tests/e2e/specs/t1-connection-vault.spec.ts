import { expect, test } from "@playwright/test";
import { E2E_URLS, E2E_VAULT_PASSPHRASE } from "../../playwright.config";
import { MOCK_TOKEN } from "../fixtures/helpers";

/**
 * T1 — vault init + first connection, driven end-to-end THROUGH THE UI.
 *
 * This is the ONE spec allowed to exercise the vault-create and add-connection
 * flows as a user would (every other spec calls the idempotent
 * `ensureVaultReady`/`ensureConnection` helpers in its own `beforeAll`). It
 * MUST run before any other spec — Playwright runs spec files in filename
 * order and the whole suite shares one backend (workers: 1), so the vault
 * genuinely starts uninitialized here and every later spec finds it already
 * unlocked with a connection in place.
 */

test.describe.serial("T1: vault init + connection bootstrap (UI-driven)", () => {
  test("T1: create the vault via the UI", async ({ page }) => {
    await page.goto("/");

    // First-ever boot of this backend: no vault yet → VaultCreateScreen.
    await expect(page.getByRole("heading", { name: "Create passphrase" })).toBeVisible();

    await page.locator("#vault-pass").fill(E2E_VAULT_PASSPHRASE);
    await page.locator("#vault-pass-confirm").fill(E2E_VAULT_PASSPHRASE);
    await expect(page.getByRole("button", { name: "Create vault" })).toBeEnabled();
    await page.getByRole("button", { name: "Create vault" }).click();

    // Vault now initialized + unlocked, 0 connections → lands on Setup, empty.
    await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();
    await expect(
      page.getByText("No servers yet. Add your first OpenProject server below."),
    ).toBeVisible();
  });

  test("T1: add a connection via the UI, health goes green", async ({ page }) => {
    await page.goto("/");

    // Vault stays unlocked server-side across page loads — straight to Setup.
    await expect(page.getByRole("heading", { name: "Add server" })).toBeVisible();

    await page.locator("#op-url").fill(E2E_URLS.mock);
    await page.locator("#op-token").fill(MOCK_TOKEN);
    await page.locator("#op-label").fill("Mock OP");
    await expect(page.getByRole("button", { name: "Add server" })).toBeEnabled();
    await page.getByRole("button", { name: "Add server" }).click();

    // App.tsx's handleServerAdded auto-navigates away from Setup the instant
    // this is the FIRST connection and validation succeeded (routes to Import
    // or Backlog) — so the transient "Connected as {user}" success message on
    // the Setup screen can already be unmounted by the time this assertion
    // runs (confirmed live: the DOM had already landed on Import). Assert the
    // DURABLE outcome instead — the health dot — not the racy transient toast.

    // Aggregate header health dot (an actual <button aria-label="connection
    // status: …">): the add-connection request runs a synchronous health
    // probe server-side and pushes the result over the live SSE health feed,
    // so this needs no manual wait beyond Playwright's own auto-retrying
    // assertion.
    await expect(page.getByRole("button", { name: /connection status: green/i })).toBeVisible();
  });

  test("T1: vault stays unlocked and the connection persists across reload", async ({ page }) => {
    await page.goto("/");

    // Neither gate screen should reappear — the vault is unlocked server-side
    // for the lifetime of this backend process.
    await expect(page.getByRole("heading", { name: "Create passphrase" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Unlock vault" })).not.toBeVisible();

    await expect(page.getByRole("button", { name: /connection status: green/i })).toBeVisible();

    // The stored server is still there (Setup, or wherever the app lands).
    // Scoped to the "Servers" panel — the header's connection-status button
    // also shows the label ("Mock OP"), so an unscoped getByText("Mock OP")
    // is ambiguous (strict-mode violation, confirmed live).
    const nav = page.getByRole("navigation", { name: "Screens" });
    await nav.getByRole("button", { name: "Setup" }).click();
    const serversPanel = page.locator(".panel", { hasText: "Servers" });
    await expect(serversPanel.getByText(E2E_URLS.mock)).toBeVisible();
    await expect(serversPanel.getByText("Mock OP")).toBeVisible();
  });
});
