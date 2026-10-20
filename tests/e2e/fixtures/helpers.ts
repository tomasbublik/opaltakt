import type { APIRequestContext } from "@playwright/test";
import { E2E_URLS, E2E_VAULT_PASSPHRASE } from "../../playwright.config";

/**
 * Setup helpers shared by every spec (SPEC_06 §3). All take the standard
 * Playwright `request` fixture, whose baseURL is the WEB dev server — `/api/*`
 * calls go through the SAME proxy the browser uses (apps/web/vite.config.ts),
 * so setup exercises the real path, not a shortcut around it. `/__mock/*`
 * calls use an ABSOLUTE mock URL (not proxied by web) — Playwright's request
 * methods accept a full URL and bypass baseURL when given one.
 */

export const MOCK_TOKEN = "e2e-mock-token";

/** Idempotent: initializes the vault on first call, unlocks on every later one
 * (unlock() has no "already unlocked" special case — see packages/crypto). */
export async function ensureVaultReady(
  request: APIRequestContext,
  passphrase: string = E2E_VAULT_PASSPHRASE,
): Promise<void> {
  const status = (await (await request.get("/api/vault/status")).json()) as {
    initialized: boolean;
    locked: boolean;
  };
  if (!status.initialized) {
    const res = await request.post("/api/vault/init", { data: { passphrase } });
    if (!res.ok()) throw new Error(`vault init failed: ${res.status()} ${await res.text()}`);
    return; // init auto-unlocks
  }
  if (status.locked) {
    const res = await request.post("/api/vault/unlock", { data: { passphrase } });
    if (!res.ok()) throw new Error(`vault unlock failed: ${res.status()} ${await res.text()}`);
  }
}

/** Idempotent: reuses an existing connection for the given base_url, or adds
 * one against the mock. Returns its local connection id. */
export async function ensureConnection(
  request: APIRequestContext,
  baseUrl: string = E2E_URLS.mock,
  token: string = MOCK_TOKEN,
): Promise<number> {
  const list = (await (await request.get("/api/connections")).json()) as Array<{
    id: number;
    base_url: string;
  }>;
  const existing = list.find((c) => c.base_url === baseUrl);
  if (existing) return existing.id;
  const res = await request.post("/api/connections", { data: { base_url: baseUrl, token } });
  if (!res.ok()) throw new Error(`add connection failed: ${res.status()} ${await res.text()}`);
  const created = (await res.json()) as { id: number };
  return created.id;
}

/** A scenario load is a FULL reset (day 0 of that scenario) — the standard
 * per-spec isolation for OP-side data (scenario-http.test.ts: "Every test
 * starts freshly loaded at day 0 (load = full reset)"). */
export async function loadScenario(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post(`${E2E_URLS.mock}/__mock/load/${encodeURIComponent(name)}`);
  if (!res.ok()) throw new Error(`loadScenario(${name}) failed: ${res.status()} ${await res.text()}`);
}

/** Returns the mock to static-fixture mode (used only by specs that don't
 * need a named scenario, e.g. connection/vault plumbing). */
export async function resetMock(request: APIRequestContext): Promise<void> {
  await request.post(`${E2E_URLS.mock}/__mock/reset`);
}

export interface AdvanceDayResult {
  day: number;
  date: string | null;
  applied_events: unknown[];
  app?: { sync?: { ok: boolean; detail: string | null }; snapshot?: { ok: boolean; detail: string | null } };
}

/** Advances the mock's logical clock one day. Pass `appUrl` to also have the
 * mock call the real app's /api/sync + /api/snapshot right after (requires an
 * unlocked vault — otherwise `app.sync.detail` reports "HTTP 423 VAULT_LOCKED"
 * without throwing). */
export async function advanceDay(
  request: APIRequestContext,
  opts: { appUrl?: string; sync?: boolean; snapshot?: boolean } = {},
): Promise<AdvanceDayResult> {
  const res = await request.post(`${E2E_URLS.mock}/__mock/advance-day`, {
    data: {
      ...(opts.appUrl !== undefined ? { app_url: opts.appUrl } : {}),
      ...(opts.sync !== undefined ? { sync: opts.sync } : {}),
      ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
    },
  });
  if (!res.ok()) throw new Error(`advance-day failed: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<AdvanceDayResult>;
}

/** A unique-enough sprint name so additive/shared-backend tests never collide
 * with a prior run's leftover data (SPEC_06 §3: no fresh DB per test). */
export function uniqueSprintName(label: string): string {
  return `${label} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

/**
 * A sprint `end_date` that is still in the FUTURE relative to the REAL clock.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * These specs anchor sprint windows to the MOCK scenario's calendar (day 0 =
 * 2026-07-06, `advanceDay()` walks it forward). But the APPLICATION decides
 * "is this sprint still running?" against the REAL clock, not the mock's day
 * counter: retro replay's end-of-window auto-lock, the `end_date` lock, and
 * burndown's future-point cutoff all compare against `new Date()`.
 *
 * So a hardcoded `end_date: "2026-07-31"` stops meaning "still open" the
 * moment the real clock passes it — and the spec quietly starts asserting
 * something it no longer sets up. That is not hypothetical: four specs began
 * failing in August 2026 with no code change behind them, because their
 * windows had simply fallen into the past. The failures looked like storage
 * bugs during the Postgres migration and cost real time to disprove.
 *
 * Use this for any window that must still be OPEN when the test runs.
 * START dates deliberately stay pinned to the scenario calendar — that is
 * where the journal history being reconstructed actually lives, and moving
 * them would leave replay with nothing to replay.
 */
export function openWindowEnd(daysAhead = 30): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}
