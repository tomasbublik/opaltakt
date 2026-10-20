import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
} from "@playwright/test";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, loadScenario, uniqueSprintName } from "../fixtures/helpers";
import { SCENARIO_WP_IDS, wpCardTestId } from "../utils/selectors";

/**
 * T7 — GUARDRAIL asserts (SPEC_06 §4 T7): the hard, non-negotiable invariants of
 * the whole product — the app is READ-ONLY toward OpenProject, and an OP API
 * token never leaks anywhere the browser can see.
 *
 * ── What THIS (Playwright / browser-network) layer actually proves ───────────
 * Playwright can only observe the traffic the BROWSER makes; it cannot see the
 * backend's outbound HTTP to OpenProject. So the honest split is:
 *
 *   (a) The browser never talks to OpenProject directly — every request it makes
 *       goes to the app's own `/api/*` backend, never to the mock OP origin
 *       (`E2E_URLS.mock`) and never to an OP `/api/v3/*` path. Proven here, live,
 *       by recording every browser request during a full realistic session. This
 *       is a real assertion: the frontend (apps/web/src/api-client.ts) hard-codes
 *       `BASE = "/api"` and has no code path that can even construct an OP URL, and
 *       we confirm that at the network-observation level too.
 *
 *   (b) That the BACKEND only ever GETs against OpenProject is NOT provable from
 *       the browser's network tab (the backend's OP calls are not observable from
 *       here). That property is proven — at the unit AND full-system level, with a
 *       recording mock OP server that asserts the distinct method set reaching OP
 *       is exactly {GET} — by the existing vitest guard `tests/src/read-only-guard.test.ts`
 *       (and `packages/op-client/src/instrument.test.ts` +
 *       `packages/op-client/src/impl.ts`, where `request()` throws
 *       ReadOnlyViolationError synchronously, before any I/O, for any non-GET).
 *       We CROSS-REFERENCE that here, we do not duplicate it. The API-level checks
 *       below (GET /api/projects, GET /api/backlog, POST /api/sync) only confirm the
 *       documented GET-only-toward-OP backend endpoints answer healthily end-to-end
 *       through the real vite proxy — they intentionally do NOT re-claim OP-side
 *       GET-only-ness.
 *
 * ── Token-leak layer ─────────────────────────────────────────────────────────
 * A distinctive CANARY token is typed into the real "API token" form field once,
 * then asserted to be absent from: every HTTP response body the browser observed,
 * the rendered DOM, and `GET /api/connections` field-by-field (the Connection
 * schema in packages/contracts/src/api.ts is "token-free by construction":
 * `has_token: boolean`, no `token` field).
 */

// A DISTINCTIVE value (not the shared MOCK_TOKEN, to avoid any substring
// ambiguity) that must never appear in any response body, the DOM, or a
// connections payload.
const CANARY_TOKEN = "e2e-canary-token-should-never-leak-anywhere";
// A deliberately-dead host: the connection is stored (validation fails, health
// red) but never reached. Distinct from the mock (8199) so it never collides
// with the real, working connection added by ensureConnection().
const CANARY_BASE_URL = "http://127.0.0.1:8198";

const SCENARIO = "s5-burndown-happy";
const PROJECT_OP_ID = 3; // s5 seeds all its WPs under project 3.

test.describe.serial("T7 — read-only + token-leak guardrails", () => {
  let setup: APIRequestContext;

  test.beforeAll(async () => {
    // `request`/`page` fixtures are test-scoped and unavailable in beforeAll, so
    // spin up an own APIRequestContext (baseURL = the web dev server, exactly like
    // the browser — /api/* flows through the real vite proxy). Idempotent: works
    // whether or not the earlier t1–t6 spec files ran in this shared-backend run.
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    await loadScenario(setup, SCENARIO); // full reset of the mock to day 0
    await ensureConnection(setup); // the real, working mock connection (current)
    const sync = await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    expect(sync.ok(), `import sync failed: ${sync.status()} ${await sync.text()}`).toBeTruthy();
  });

  test.afterAll(async () => {
    await setup.dispose();
  });

  test("a full UI session never reaches OpenProject directly, and the entered token never leaks", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000); // a full create→activate→update→finish flow.

    // Auto-accept the "Finish this sprint?" confirm() near the end of the flow.
    page.on("dialog", (d) => void d.accept());

    // ── Record every browser request + every /api response body for the session ─
    const observed: { url: string; method: string }[] = [];
    const bodyReads: Promise<void>[] = [];
    const responseBodies: { url: string; body: string }[] = [];

    page.on("request", (req) => {
      observed.push({ url: req.url(), method: req.method() });
    });
    page.on("response", (res) => {
      const url = res.url();
      // Only the app backend's JSON matters here. Skip the health SSE stream —
      // reading an open, never-ending stream body would hang (and by construction
      // it emits token-free Connection objects, same schema as everything else).
      if (!url.includes("/api/") || url.includes("/stream")) return;
      bodyReads.push(
        res
          .text()
          .then((body) => {
            responseBodies.push({ url, body });
          })
          .catch(() => {
            // Unreadable (e.g. 204 no-content / already-consumed) — nothing to scan.
          }),
      );
    });

    // ── Drive a realistic multi-step session ─────────────────────────────────
    await page.goto("/");
    // Connected (mock connection + an import exist) → nav is live.
    await expect(page.getByRole("button", { name: "Sprint board" })).toBeEnabled();

    // 1) Add a SECOND connection through the real form — this is the only place
    //    the CANARY token is ever typed. The dead host makes validation fail, but
    //    the connection is still stored (token encrypted server-side).
    await page.getByRole("button", { name: "Setup" }).click();
    await page.getByLabel("OpenProject URL", { exact: true }).fill(CANARY_BASE_URL);
    await page.getByLabel("API token", { exact: true }).fill(CANARY_TOKEN);
    await page.getByLabel("Label (optional)", { exact: true }).fill("canary");
    await page.getByRole("button", { name: "Add server" }).click();
    await expect(
      page.getByText(/Server stored, but validation failed|Connected as/),
    ).toBeVisible();
    // The token was submitted and the panel re-rendered — it must be gone from the DOM.
    await expect(page.locator("body")).not.toContainText(CANARY_TOKEN);

    // 2) Trigger a real browser-initiated sync (POST /api/sync from the page).
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();

    // 3) Look at the backlog (GET /api/backlog).
    await page.getByRole("button", { name: "Backlog", exact: true }).click();

    // 4) Sprint board: create → add a ticket → activate → update → finish.
    await page.getByRole("button", { name: "Sprint board" }).click();
    const sprintName = uniqueSprintName("T7 guardrail");
    await page.getByLabel("New Sprint Name", { exact: true }).fill(sprintName);
    await page.getByLabel("Start", { exact: true }).fill("2026-07-01");
    await page.getByLabel("End", { exact: true }).fill("2026-07-15");
    await page.getByRole("button", { name: "Create sprint" }).click();

    // Select OUR sprint explicitly (a prior run may have left an active sprint that
    // the app's "active-first" auto-select would otherwise prefer). Poll the API
    // for the id — the create submit is async, so it may not be stored yet.
    let mineId: number | undefined;
    await expect
      .poll(async () => {
        const list = (await (await request.get("/api/sprints")).json()) as Array<{
          id: number;
          name: string;
        }>;
        mineId = list.find((s) => s.name === sprintName)?.id;
        return mineId ?? null;
      })
      .not.toBeNull();
    const boardSelect = page.getByLabel("Sprint", { exact: true });
    await expect(boardSelect.locator(`option[value="${mineId}"]`)).toHaveCount(1);
    await boardSelect.selectOption(String(mineId));
    await expect(page.getByRole("heading", { name: "Sprint details" })).toBeVisible();

    // Add one ticket from the backlog column.
    const firstWp = SCENARIO_WP_IDS.s5.tickets[0];
    await page
      .getByTestId(wpCardTestId(firstWp))
      .getByRole("button", { name: "Add →" })
      .click();

    await page.getByRole("button", { name: "Activate" }).click();
    const updateBtn = page.getByRole("button", { name: "Update Sprint" });
    await expect(updateBtn).toBeVisible();
    await updateBtn.click();
    await expect(page.getByText(/Last updated/)).toBeVisible();
    await page.getByRole("button", { name: "Finish sprint" }).click();
    await expect(page.getByTestId("sprint-status")).toContainText("Finished");

    // A last DOM sweep after everything re-rendered.
    await expect(page.locator("body")).not.toContainText(CANARY_TOKEN);

    // ── Assertions ────────────────────────────────────────────────────────────
    await Promise.allSettled(bodyReads);

    // (a) LIVE proof: the browser never spoke to OpenProject.
    expect(observed.length, "expected the browser to make requests").toBeGreaterThan(0);
    expect(
      observed.some((r) => r.url.includes("/api/")),
      "the browser should reach the app backend via /api/*",
    ).toBeTruthy();
    for (const r of observed) {
      expect(
        r.url.startsWith(E2E_URLS.mock),
        `browser hit the OP mock DIRECTLY: ${r.method} ${r.url}`,
      ).toBeFalsy();
      expect(
        r.url.includes("/api/v3/"),
        `browser hit an OpenProject API path: ${r.method} ${r.url}`,
      ).toBeFalsy();
    }

    // (b) Token never appears in ANY observed response body (incl. the
    //     POST /api/connections response for the canary add).
    expect(responseBodies.length, "expected to have captured /api response bodies").toBeGreaterThan(0);
    expect(
      responseBodies.some((r) => r.url.includes("/api/connections")),
      "should have observed a /api/connections response",
    ).toBeTruthy();
    for (const { url, body } of responseBodies) {
      expect(body.includes(CANARY_TOKEN), `token leaked in a response body: ${url}`).toBeFalsy();
    }
  });

  test("GET /api/connections is token-free by construction (field-by-field)", async ({ request }) => {
    // Self-sufficient if this test is run in isolation: ensure a canary connection
    // exists (idempotent — reuses the one the UI added when the file runs whole).
    await ensureConnection(request, CANARY_BASE_URL, CANARY_TOKEN);

    const res = await request.get("/api/connections");
    expect(res.ok()).toBeTruthy();
    const conns = (await res.json()) as Array<Record<string, unknown>>;
    expect(conns.length).toBeGreaterThan(0);

    // Nowhere in the whole payload (top-level or nested health object).
    expect(JSON.stringify(conns).includes(CANARY_TOKEN)).toBeFalsy();

    for (const c of conns) {
      // The schema exposes `has_token: boolean`, never a `token` field.
      expect("token" in c, "a Connection must not carry a `token` key").toBeFalsy();
      expect(typeof c["has_token"]).toBe("boolean");
      // No individual field value equals the token, either.
      for (const value of Object.values(c)) {
        expect(value).not.toBe(CANARY_TOKEN);
      }
    }
  });
});
