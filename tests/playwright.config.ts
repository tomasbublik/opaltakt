import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_DB_NAME, createE2eDatabaseCommand } from "./e2e/global-db";

/**
 * E2E harness (Increment 6). Drives the REAL stack — mock OpenProject +
 * Fastify API + Vite web — never a real OP server. Fixed, non-default ports
 * so this can run alongside the developer's own `pnpm dev` session without
 * colliding: mock 8199, api 3199, web 5199 (dev defaults are 8099/3001/5173).
 *
 * ── Storage (Increment 27: SQLite → Postgres) ───────────────────────────────
 * The backend runs against a dedicated THROWAWAY POSTGRES DATABASE for the
 * whole run — `osp_e2e_<pid>`, created by a `psql` prefix on the API's own
 * webServer command (Playwright starts webServers BEFORE globalSetup, so
 * provisioning there would be too late) and dropped in globalTeardown.
 * Provisioning logic lives in tests/e2e/global-db.ts.
 *
 * Why the real server and not PGlite, which the vitest suite uses? Because
 * PGlite is PostgreSQL 16.4 and the deployment target is 17.x, and e2e is the
 * one layer whose job is to exercise the real thing end to end. It is also
 * genuinely out-of-process, which is what makes the state persist across every
 * spec file in one boot, exactly like the real app.
 *
 * ⛔ The database NAME IS GENERATED, never configured — no env var can point
 * this run at `osp` (the user's real data) or `atlas-core` (an unrelated project
 * on the same server), and `assertThrowawayDatabase()` re-checks it at module
 * load, at CREATE, and again immediately before the DROP. This is the
 * Increment-11 guardrail: an agent once booted this app against the user's
 * real database and permanently destroyed every sprint they had.
 *
 * Isolation between tests/specs is NOT "fresh DB per test" — it's: (1) the
 * mock OP resets to a known scenario via loadScenario() in each spec's own
 * setup (a scenario load is a full reset — see scenario-http.test.ts), and
 * (2) specs are additive-safe (unique sprint names, tolerate pre-existing
 * connections/imports) the way T1 bootstraps the vault ONCE for the whole run
 * and every other spec just unlocks (idempotent) rather than re-initializing.
 *
 * Runs SERIALLY (workers: 1, fullyParallel: false) against ONE shared backend
 * — T1 (vault init + first connection) must run before anything else that
 * assumes a connection exists, and Playwright runs spec files in filename
 * order, hence the `t1-…` … `t8-…` naming in ./e2e/specs.
 */

export const E2E_PORTS = {
  mock: 8199,
  api: 3199,
  web: 5199,
};

export const E2E_URLS = {
  mock: `http://127.0.0.1:${E2E_PORTS.mock}`,
  api: `http://127.0.0.1:${E2E_PORTS.api}`,
  web: `http://127.0.0.1:${E2E_PORTS.web}`,
};

/** Fixed test-only passphrase — never used for anything real. */
export const E2E_VAULT_PASSPHRASE = "e2e-test-passphrase";

/** Re-exported so specs can assert on / connect to the run's throwaway DB. */
export { E2E_DATABASE_URL, E2E_DB_NAME };

export default defineConfig({
  testDir: "./e2e/specs",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: E2E_URLS.web,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "pnpm --filter @osp/fixtures start",
      // No dedicated /health route on the mock — /__mock/state always 200s.
      url: `${E2E_URLS.mock}/__mock/state`,
      env: { MOCK_OP_PORT: String(E2E_PORTS.mock) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The throwaway database is created HERE, not in globalSetup: Playwright
      // starts webServer entries BEFORE globalSetup runs, so provisioning there
      // is too late (the API dies migrating a database that doesn't exist yet).
      command: `${createE2eDatabaseCommand()} && pnpm --filter @osp/api start`,
      url: `${E2E_URLS.api}/health`,
      env: {
        // ⛔ Both required, no defaults (apps/api/src/index.ts + server.ts).
        // DATABASE_URL is the generated throwaway created by globalSetup;
        // PORT is non-default so a stray process can never bind the port the
        // developer's own dev session uses.
        PORT: String(E2E_PORTS.api),
        DATABASE_URL: E2E_DATABASE_URL,
        OSP_DISABLE_SCHEDULER: "1",
        // Increment 39 — required, no default. e2e drives the app as the
        // synthetic local Planner (no Entra round-trip in the browser).
        OSP_AUTH: "none",
        NODE_ENV: "production",
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // `--port`/`--host` override vite.config.ts's hardcoded 5173 (its port
      // isn't env-driven, only the /api proxy target is via VITE_API_URL). NO
      // `--` before the flags — pnpm forwards a literal `--` into vite's argv,
      // which vite's CLI parser then treats as "end of options", silently
      // ignoring --port/--strictPort/--host and falling back to the config
      // default. `--host 127.0.0.1` matters too: vite's own default host binds
      // ONLY the IPv6 `::1` interface, not IPv4 `127.0.0.1` — every URL in this
      // config uses 127.0.0.1 (matching the mock/api servers' own default
      // host), which would otherwise never connect.
      command: `pnpm --filter @osp/web dev --port ${E2E_PORTS.web} --strictPort --host 127.0.0.1`,
      url: E2E_URLS.web,
      env: { VITE_API_URL: E2E_URLS.api },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
