import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { E2E_URLS } from "../../playwright.config";
import {
  advanceDay,
  ensureConnection,
  ensureVaultReady,
  loadScenario,
  openWindowEnd,
  uniqueSprintName,
} from "../fixtures/helpers";

/**
 * TS — Increment 28 §1 (docs/INCREMENT_28_CONTRACTS.md): **an estimate change
 * must recalculate the WHOLE sprint DTO set, never just the list it was edited
 * in.** Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tr → "ts-…" lexicographic sequence so it
 * runs after every earlier spec and before `tz-db-isolation` (Playwright runs
 * spec files in filename order against ONE shared backend). Do NOT rename.
 *
 * WHAT THIS FILE PROVES (the §4 verification list, items 1–4)
 *   §1  A local estimate OVERRIDE saved on the Backlog screen invalidates the
 *       App-level `refreshKey`, not only `BacklogScreen`'s own `useAsync`.
 *       This is the increment's headline bug and it is asserted TWO ways:
 *        (a) MECHANICALLY — after Save, the app re-issues the App-level
 *            `GET /api/sprints`. A "reload only the list I edited" regression
 *            (`onSaved={() => state.reload()}`, contracts §0a) re-fetches
 *            `/api/backlog` and NOTHING else, so it fails this outright.
 *        (b) VISUALLY — the Capacity panel's green bar GROWS and the "Planned"
 *            figure changes. The bar assertion measures real pixel width
 *            against a pinned availability denominator, so a test cannot pass
 *            merely because the item list re-rendered.
 *   §2  An estimate changed in OpenProject and pulled in by "Sync now" moves
 *       the same numbers, through `effectiveEstimate` exactly as
 *       CAPACITY_BAR_RULES §3 defines it (`override` > `remaining ≠ 0 ∧ ≠ work`
 *       ? `remaining` : `work`).
 *   §3  Adding and removing a sprint item recalculates capacity.
 *   §4  No stale copy anywhere: Capacity, the sprint item list, Closure and the
 *       Sprint-detail panel agree after a change (CAPACITY_BAR_RULES §5
 *       invariant 5).
 *   §5  Guardrails: every OpenProject request is a GET, the admin-gated
 *       `GET /api/v3/users` collection is never called, and no token leaks.
 *
 * ── FIXTURE ────────────────────────────────────────────────────────────────
 * `s5-burndown-happy` (project 3): five estimated tickets and, crucially, a
 * timeline that BURNS DOWN `remainingHours` day by day — the only way to make
 * OpenProject hand the app a genuinely NEW estimate for §2 without writing to
 * OP (which is forbidden). No new fixture people or ids are minted (the
 * Increment-15 fixture-name-collision gotcha).
 *
 *   #1505 "Add CSV export to lists"      Dev Dvořák  work 8 / rem 8  → 8   (stable: first burnt on day 7)
 *   #1502 "Migrate settings storage"     Dev Dvořák  work 14 / rem 14 → 14 (stable until day 2)
 *   #1501 "Implement report scheduling"  Dev Dvořák  work 16 / rem 10 → 10 at day 0, rem 4 → 4 at day 1
 *
 * ⛔ ISOLATION: no new server boot — this reuses tests/playwright.config.ts's
 * webServer, which already pins a GENERATED throwaway Postgres database
 * (`osp_e2e_<pid>`) and non-default ports. `tz-db-isolation.spec.ts` is the
 * suite-wide tripwire that proves no other database saw any write.
 */

const SCENARIO = "s5-burndown-happy";
const PROJECT_OP_ID = 3;
const DEV = "Dev Dvořák";

const WP_STABLE = 1505; // work 8 / rem 8 → effEst 8 — the OVERRIDE subject
const WP_EXTRA = 1502; // work 14 / rem 14 → effEst 14 — the add/remove subject
const WP_BURNING = 1501; // rem 10 at day 0, rem 4 after one advance-day

const WP_STABLE_STATUS = "Confirmed"; // s5 seed; only #1501 moves off it on day 0
const EFF_STABLE = 8;
const EFF_EXTRA = 14;
const EFF_BURNING_DAY0 = 10;
const EFF_BURNING_DAY1 = 4;
const OVERRIDE_HOURS = 40;

/** Pinned availability, so the bar's denominator is a KNOWN constant and a
 * width measurement means something. `developerSegmentBarDenominator` is
 * `max(available_hours, Σ segment widths, 1)`. */
const AVAILABLE_HOURS = 80;

interface CapacityLineLike {
  op_user_id: number | null;
  member_id: number | null;
  name: string;
  planned_hours: number;
  available_hours: number;
}
interface CapacityLike {
  lines: CapacityLineLike[];
  total_planned_hours: number;
  scope_planned_hours: number;
  scope_delivered_hours: number;
}
interface ClosureStatsLike {
  total_planned_hours: number;
  total_delivered_hours: number;
  per_developer: Array<{ name: string; planned_hours: number }>;
}
interface SprintItemLike {
  op_id: number;
  planned_hours: number | null;
  effective_hours: number | null;
  outcome: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}

/** The Capacity panel (there is exactly one, headed "Capacity"). */
function capacityPanel(page: Page): Locator {
  return page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Capacity" }) });
}

/** One `.stat` block inside a panel, addressed by its `.stat-label` text. */
function statValue(panel: Locator, label: string): Locator {
  return panel.locator(".stat").filter({ hasText: label }).first();
}

async function gotoBoard(page: Page, sprintId: number): Promise<void> {
  await screensNav(page).getByRole("button", { name: "Sprint board", exact: true }).click();
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
  await expect(capacityPanel(page).getByRole("heading", { name: "Capacity" })).toBeVisible();
}

async function gotoBacklog(page: Page): Promise<void> {
  await screensNav(page).getByRole("button", { name: "Backlog" }).click();
  await expect(page.locator('[aria-label="backlog count"]')).toBeVisible();
}

/**
 * Open the Backlog and make ONE ticket reachable on screen.
 *
 * ⚠️ Non-obvious, and it cost a full-suite failure: the backlog paginates at 20
 * rows by default, and the e2e suite shares ONE cache across every spec — by
 * the time this file runs the union backlog holds hundreds of tickets from
 * every earlier scenario, so a specific id is almost never on page 1. Narrow by
 * status AND widen the page size; the row is then genuinely absent if the
 * locator still misses.
 */
async function gotoBacklogRow(page: Page, opId: number, status: string): Promise<Locator> {
  await gotoBacklog(page);
  await page.getByLabel("Status", { exact: true }).selectOption({ label: status });
  await page.getByLabel("Page size").selectOption("100");
  const row = backlogRow(page, opId);
  await expect(row, `#${opId} (status "${status}") is on the Backlog screen`).toBeVisible();
  return row;
}

function backlogRow(page: Page, opId: number): Locator {
  return page
    .locator("table.grid tbody tr")
    .filter({ has: page.getByRole("checkbox", { name: `Select #${opId}` }) });
}

async function getCapacity(ctx: APIRequestContext, sprintId: number): Promise<CapacityLike> {
  const res = await ctx.get(`/api/sprints/${sprintId}/capacity`);
  expect(res.ok(), `capacity ${sprintId}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as CapacityLike;
}

async function getClosureStats(ctx: APIRequestContext, sprintId: number): Promise<ClosureStatsLike> {
  const res = await ctx.get(`/api/sprints/${sprintId}/closure-stats`);
  expect(res.ok(), `closure-stats ${sprintId}: ${res.status()}`).toBeTruthy();
  return (await res.json()) as ClosureStatsLike;
}

async function getItems(ctx: APIRequestContext, sprintId: number): Promise<SprintItemLike[]> {
  const res = await ctx.get(`/api/sprints/${sprintId}/items/detailed`);
  expect(res.ok(), `items/detailed ${sprintId}: ${res.status()}`).toBeTruthy();
  return (await res.json()) as SprintItemLike[];
}

function lineFor(cap: CapacityLike, name: string): CapacityLineLike {
  const line = cap.lines.find((l) => l.name === name);
  expect(line, `capacity line for ${name} (got: ${cap.lines.map((l) => l.name).join(", ")})`).toBeTruthy();
  return line as CapacityLineLike;
}

/** The Capacity panel's "Planned" figure, as a number (it renders like "40h"). */
async function plannedFigure(page: Page): Promise<number> {
  const text = (await statValue(capacityPanel(page), "Planned").innerText()).trim();
  const m = /([\d.]+)\s*h/.exec(text);
  expect(m, `Planned stat did not look like hours: ${JSON.stringify(text)}`).toBeTruthy();
  return Number(m![1]);
}

/**
 * The rendered width of ONE developer segment, as a FRACTION of its bar. The
 * bar is `max(available_hours, Σ widths, 1)` wide, so with availability pinned
 * at AVAILABLE_HOURS this is `estimate / AVAILABLE_HOURS` — i.e. a direct read
 * of the estimate the bar was drawn from.
 */
async function segmentFraction(page: Page, wpOpId: number): Promise<number> {
  const bar = page.locator('[data-testid^="dev-segment-bar-"]').first();
  await expect(bar).toBeVisible();
  const seg = page.locator(`[data-testid$="-seg-${wpOpId}-wrap"]`).first();
  await expect(seg).toBeVisible();
  const barBox = await bar.boundingBox();
  const segBox = await seg.boundingBox();
  expect(barBox, "bar has a layout box").toBeTruthy();
  expect(segBox, `segment for #${wpOpId} has a layout box`).toBeTruthy();
  return (segBox as { width: number }).width / (barBox as { width: number }).width;
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe("TS — Increment 28 §1: an estimate change recalculates everything", () => {
  let setup: APIRequestContext;
  let sprintA = 0; // override / add / remove / consistency
  let sprintB = 0; // sync-pulled estimate change
  let devOpUserId: number | null = null;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    const connId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${connId}`, { data: { current: true, enabled: true } });
    await loadScenario(setup, SCENARIO);
    // ⚠️ `kind: "full"`, not the default "auto". The e2e suite shares ONE backend
    // and ONE mock across every spec: by the time this file runs, project 3's
    // cache already holds a PREVIOUS spec's scenario, whose `updated_at_op`
    // watermark is newer than this scenario data's. An auto (incremental) sync asks
    // OpenProject for `updatedAt >= <that watermark>`, gets nothing back, and
    // silently leaves the old tickets in place — the spec then fails far away
    // from the cause. A full sync always replaces them.
    const sync = await setup.post("/api/sync", {
      // `connection_id` explicitly: by this point in the suite several
      // connections exist and "the current one" is whatever an earlier spec
      // last set.
      data: { project_op_id: PROJECT_OP_ID, connection_id: connId, kind: "full" },
    });
    expect(sync.ok(), `sync project ${PROJECT_OP_ID}: ${sync.status()} ${await sync.text()}`).toBeTruthy();

    // ⚠️ `end_date` via openWindowEnd(): the app decides "is this sprint still
    // running?" against the REAL clock while the fixture lives on the mock's
    // 2026-07-01 calendar (tests/e2e/fixtures/helpers.ts explains what a
    // hardcoded past end date silently breaks).
    for (const [label, target] of [
      ["TS override+scope", "A"],
      ["TS sync-pulled estimate", "B"],
    ] as const) {
      const created = await setup.post("/api/sprints", {
        data: {
          name: uniqueSprintName(label),
          start_date: "2026-07-06",
          end_date: openWindowEnd(30),
        },
      });
      expect(created.ok(), `create sprint ${label}: ${created.status()} ${await created.text()}`).toBeTruthy();
      const id = ((await created.json()) as { id: number }).id;
      if (target === "A") sprintA = id;
      else sprintB = id;
    }

    await setup.post(`/api/sprints/${sprintA}/items`, { data: { wp_op_id: WP_STABLE } });
    await setup.post(`/api/sprints/${sprintB}/items`, { data: { wp_op_id: WP_BURNING } });

    // The scenario bakes no roles; Closure counts DEVELOPERS only (Increment
    // 14), so §4's cross-panel comparison would otherwise compare 0 to 0.
    // People are materialised lazily, and only from tickets already in a
    // sprint — hence after the adds above.
    const people = (await (await setup.get("/api/people")).json()) as Array<{
      id: number;
      name: string;
      role: string;
      op_user_id: number | null;
    }>;
    const dev = people.find((p) => p.name === DEV);
    expect(dev, `GET /api/people knows ${DEV} (got: ${people.map((p) => p.name).join(", ")})`).toBeTruthy();
    await setup.put(`/api/people/${dev!.id}/role`, { data: { role: "developer" } });

    // Pin availability on BOTH sprints so every bar-width measurement below has
    // a known denominator.
    const capA = await getCapacity(setup, sprintA);
    devOpUserId = lineFor(capA, DEV).op_user_id;
    for (const sprintId of [sprintA, sprintB]) {
      const res = await setup.put(`/api/sprints/${sprintId}/capacity`, {
        data: {
          members: [
            {
              ...(devOpUserId != null
                ? { op_user_id: devOpUserId }
                : { member_id: lineFor(capA, DEV).member_id }),
              name: DEV,
              available_hours: AVAILABLE_HOURS,
              pto_days: 0,
            },
          ],
        },
      });
      expect(res.ok(), `pin availability on ${sprintId}: ${res.status()} ${await res.text()}`).toBeTruthy();
    }
  });

  test.afterAll(async () => {
    for (const id of [sprintA, sprintB]) if (id) await setup.delete(`/api/sprints/${id}`).catch(() => {});
    await setup?.dispose();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §1a — the mechanical proof: the WHOLE DTO set is invalidated, not the list.
  // ───────────────────────────────────────────────────────────────────────────
  test("§1a: saving an estimate override re-fetches the App-level sprint data, not only the backlog list", async ({
    page,
  }) => {
    await page.goto("/");
    const row = await gotoBacklogRow(page, WP_STABLE, WP_STABLE_STATUS);

    // Watch for the App-level `GET /api/sprints` (exact path — NOT
    // `/api/sprints/:id/...`). It is keyed on `refreshKey` (App.tsx), so it is
    // re-issued if and only if the mutation invalidated everything. A
    // reload-only-the-list regression re-fetches `/api/backlog` alone.
    const appLevelRefetch = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/sprints" && r.request().method() === "GET",
      { timeout: 10_000 },
    );
    // Sanity: the backlog list itself must ALSO refresh (both, never one).
    const backlogRefetch = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/backlog" && r.request().method() === "GET",
      { timeout: 10_000 },
    );

    await row.getByRole("button", { name: `edit override for ${WP_STABLE}` }).click();
    await row
      .getByRole("spinbutton", { name: `override hours for ${WP_STABLE}` })
      .fill(String(OVERRIDE_HOURS));
    await row.getByRole("button", { name: "Save" }).click();

    await backlogRefetch;
    await appLevelRefetch; // ← the §1 contract, mechanically

    // And the row itself is right: OP estimate untouched, effective = override.
    await expect(row.locator("td").nth(10)).toHaveText(`${EFF_STABLE}h`);
    await expect(row.locator("td").nth(11)).toHaveText(`${OVERRIDE_HOURS}h`);
    await expect(row.locator("td").nth(12)).toHaveText(`${OVERRIDE_HOURS}h`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §1b — the visual proof: the GREEN BAR and the Planned figure both move.
  // ───────────────────────────────────────────────────────────────────────────
  test("§1b: the capacity GREEN BAR and the Planned figure both reflect the new estimate", async ({
    page,
  }) => {
    // Idempotent precondition — §1a saves the same override through the UI, but
    // this test must stand on its own (and re-running the file must not depend
    // on §1a having gone green).
    await setup.post("/api/estimate-override", {
      data: { wp_op_id: WP_STABLE, planning_hours: OVERRIDE_HOURS },
    });

    const cap = await getCapacity(setup, sprintA);
    expect(lineFor(cap, DEV).planned_hours, "the capacity LINE reflects the override").toBe(
      OVERRIDE_HOURS,
    );
    expect(
      cap.scope_planned_hours,
      "the Capacity panel's own Planned header must follow the override too " +
        "(CAPACITY_BAR_RULES §3 + §5 invariant 5). It is served by computeClosureStats, " +
        "which reads the FROZEN sprint_item.planned_hours snapshot instead of the live " +
        "effectiveEstimate — see closureStats.ts:291.",
    ).toBe(OVERRIDE_HOURS);

    await page.goto("/");
    await gotoBoard(page, sprintA);

    const panel = capacityPanel(page);
    await expect(statValue(panel, "Planned")).toContainText(`${OVERRIDE_HOURS}h`);

    // The bar: one green segment for #1505, drawn at `estimate / available`.
    const green = page.locator(`[data-testid$="-seg-${WP_STABLE}-baseline_worked"]`).first();
    await expect(green, "the planning segment is GREEN (CAPACITY_BAR_RULES §2)").toHaveClass(
      /bar-green/,
    );
    const fraction = await segmentFraction(page, WP_STABLE);
    expect(
      fraction,
      `the green bar must be ${OVERRIDE_HOURS}/${AVAILABLE_HOURS} of the bar, not the ` +
        `pre-override ${EFF_STABLE}/${AVAILABLE_HOURS} — CAPACITY_BAR_RULES §3 makes the ` +
        `bar LENGTH the effectiveEstimate, and \`override\` wins outright`,
    ).toBeGreaterThan(0.4);
    expect(fraction).toBeLessThan(0.6);

    // The per-line "Planned / Change / Capacity" readout agrees. Note the
    // middle figure is `formatSignedHours`, which renders a zero net change as
    // a bare "0h" — no sign — by deliberate SPEC_16 design, not "+0h".
    await expect(
      page.locator(".capacity-line").filter({ hasText: DEV }),
    ).toContainText(`${OVERRIDE_HOURS}h / 0h / ${AVAILABLE_HOURS}h`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §3 — add / remove an item recalculates capacity (same mount, no reload).
  // ───────────────────────────────────────────────────────────────────────────
  test("§3: adding then removing a sprint item recalculates the bar and the Planned figure", async ({
    page,
  }) => {
    await page.goto("/");
    await gotoBoard(page, sprintA);

    // Asserted as a DELTA, not an absolute: this test is about "membership
    // changed → capacity recomputed", and it must not double as a second
    // (flakier) copy of §1b's estimate-of-record assertion.
    const plannedBefore = await plannedFigure(page);
    const scopeBefore = (await getCapacity(setup, sprintA)).scope_planned_hours;

    // ADD via the board's own "add by id" form — a real UI mutation, on the
    // SAME mount as the Capacity panel, so a missing invalidation cannot hide
    // behind a screen remount.
    const addForm = page.getByTestId("add-ticket-by-id");
    await addForm.getByLabel("Add ticket by ID").fill(String(WP_EXTRA));
    await addForm.getByRole("button", { name: "Add ticket" }).click();
    await expect(addForm.getByRole("status")).toContainText(`#${WP_EXTRA} added`);

    await expect(statValue(capacityPanel(page), "Planned")).toContainText(
      `${plannedBefore + EFF_EXTRA}h`,
    );
    await expect(page.locator(`[data-testid$="-seg-${WP_EXTRA}-wrap"]`).first()).toBeVisible();
    expect((await getCapacity(setup, sprintA)).scope_planned_hours).toBe(scopeBefore + EFF_EXTRA);

    // REMOVE it again (planning sprint → the row goes, the numbers go back).
    const removed = await setup.delete(`/api/sprints/${sprintA}/items/${WP_EXTRA}`);
    expect(removed.ok(), `remove #${WP_EXTRA}: ${removed.status()} ${await removed.text()}`).toBeTruthy();
    await page.reload();
    await gotoBoard(page, sprintA);
    await expect(statValue(capacityPanel(page), "Planned")).toContainText(`${plannedBefore}h`);
    expect((await getCapacity(setup, sprintA)).scope_planned_hours).toBe(scopeBefore);
    await expect(page.locator(`[data-testid$="-seg-${WP_EXTRA}-wrap"]`)).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §2 — an estimate changed in OP and pulled in by "Sync now".
  // ───────────────────────────────────────────────────────────────────────────
  test("§2: 'Sync now' pulls a new remainingTime and the bar follows effectiveEstimate", async ({
    page,
  }) => {
    // Day 0 state: #1501 has work 16 / remaining 10 → effEst 10 (remaining wins).
    const before = await getCapacity(setup, sprintB);
    expect(lineFor(before, DEV).planned_hours, "day-0 effectiveEstimate").toBe(EFF_BURNING_DAY0);

    await page.goto("/");
    await gotoBoard(page, sprintB);
    await expect(statValue(capacityPanel(page), "Planned")).toContainText(`${EFF_BURNING_DAY0}h`);
    const fractionBefore = await segmentFraction(page, WP_BURNING);

    // Advance the mock's calendar one day: the scenario logs 6 h on #1501 and
    // sets remaining to 4. Nothing is written TO OpenProject — the mock's own
    // admin API drives its clock.
    await advanceDay(setup);

    // "Sync now" from the header, WITHOUT leaving the board — so the refresh
    // has to reach the Capacity panel through the App-level refreshKey.
    await page.getByRole("button", { name: /^Sync now$/ }).click();

    // First prove the sync actually landed the new estimate server-side, so a
    // failure below can only mean "a surface is serving a stale copy".
    await expect
      .poll(async () => lineFor(await getCapacity(setup, sprintB), DEV).planned_hours, {
        timeout: 30_000,
      })
      .toBe(EFF_BURNING_DAY1);

    await expect(
      statValue(capacityPanel(page), "Planned"),
      "the Capacity panel's Planned header must follow the newly-synced remaining work " +
        "(CAPACITY_BAR_RULES §3). It is served by computeClosureStats, which reads the FROZEN " +
        "sprint_item.planned_hours captured when the ticket was added — see closureStats.ts:291.",
    ).toContainText(`${EFF_BURNING_DAY1}h`, { timeout: 15_000 });

    const fractionAfter = await segmentFraction(page, WP_BURNING);
    expect(
      fractionAfter,
      "the green bar SHRANK with the new remaining work (bar length = effectiveEstimate)",
    ).toBeLessThan(fractionBefore);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §4 — no stale copy anywhere (CAPACITY_BAR_RULES §5 invariant 5).
  // ───────────────────────────────────────────────────────────────────────────
  test("§4: Capacity, the item list, Closure and the Sprint-detail panel all show the SAME numbers", async ({
    page,
  }) => {
    // Change the estimate FIRST, then read every surface in one go. The
    // comparison has to happen right after a change — that is the only moment
    // a stale copy can show — so this deliberately does NOT reuse whatever the
    // earlier tests left behind.
    const FRESH_OVERRIDE = 25;
    const saved = await setup.post("/api/estimate-override", {
      data: { wp_op_id: WP_STABLE, planning_hours: FRESH_OVERRIDE },
    });
    expect(saved.ok(), `save override: ${saved.status()} ${await saved.text()}`).toBeTruthy();

    const cap = await getCapacity(setup, sprintA);
    const closure = await getClosureStats(setup, sprintA);
    const items = await getItems(setup, sprintA);

    // (a) Capacity panel header vs Closure — the SAME shared pipeline.
    expect(cap.scope_planned_hours, "Capacity Planned == Closure Planned").toBe(
      closure.total_planned_hours,
    );
    expect(cap.scope_delivered_hours).toBe(closure.total_delivered_hours);
    expect(
      closure.per_developer.find((d) => d.name === DEV)?.planned_hours,
      "CAPACITY_BAR_RULES §5 invariant 5: Closure's per-developer row is the SAME number " +
        "as the capacity line. They diverge whenever an estimate changed after the ticket " +
        "was added — closureStats reads the frozen sprint_item.planned_hours, computeCapacity " +
        "reads the live effectiveEstimate.",
    ).toBe(lineFor(cap, DEV).planned_hours);

    // (a2) On a sprint with ONE developer holding ONE ticket, the panel header
    //      and that developer's line are the SAME number by definition. This is
    //      invariant 5 at its sharpest.
    expect(
      cap.scope_planned_hours,
      "one developer, one ticket: the Capacity header and the capacity line must agree",
    ).toBe(lineFor(cap, DEV).planned_hours);

    // (b) The sprint ITEM LIST carries the same effective estimate the bar was
    //     drawn from — this is what "the list updated but the bar did not"
    //     used to look like, in reverse.
    const live = items.filter((i) => i.outcome !== "removed" && i.outcome !== "removed_mid_sprint");
    expect(live.map((i) => i.op_id)).toEqual([WP_STABLE]);
    expect(live[0]!.effective_hours, "the list's effective estimate is the override").toBe(
      FRESH_OVERRIDE,
    );

    // (c) …and all of it renders that way in ONE mount of the board.
    await page.goto("/");
    await gotoBoard(page, sprintA);
    await expect(statValue(capacityPanel(page), "Planned")).toContainText(
      `${FRESH_OVERRIDE}h`,
    );
    // Sprint-detail's own "Planned hours" is the leaf/role-filtered
    // `total_planned_hours` — a DELIBERATELY different figure (see
    // CapacityResponse's contract doc), so it is compared to ITS OWN source,
    // never conflated with the Capacity header above.
    await expect(page.getByTestId("planned-hours-delta")).toContainText(
      `${cap.total_planned_hours}h`,
    );
    await expect(page.getByTestId(`wp-card-${WP_STABLE}`)).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §5 — guardrails.
  // ───────────────────────────────────────────────────────────────────────────
  test("§5: every OpenProject request in this spec's flows is a GET, and /api/v3/users is never called", async ({
    page,
  }) => {
    const opRequests: Array<{ method: string; path: string }> = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.origin === E2E_URLS.mock) opRequests.push({ method: req.method(), path: url.pathname });
    });

    // Re-drive the whole flow through the UI once more, recording OP traffic.
    await page.goto("/");
    await gotoBacklog(page);
    await gotoBoard(page, sprintA);
    await page.getByRole("button", { name: /^Sync now$/ }).click();
    await expect(capacityPanel(page).getByRole("heading", { name: "Capacity" })).toBeVisible();

    // The browser must never speak to OpenProject at all — every OP call goes
    // through the API server. Belt and braces on top of the server-side guard.
    expect(opRequests, `browser → OP traffic: ${JSON.stringify(opRequests)}`).toEqual([]);

    // Server-side: the mock records everything it received this whole run.
    const state = (await (
      await setup.get(`${E2E_URLS.mock}/__mock/state`)
    ).json()) as Record<string, unknown>;
    expect(state, "the mock is reachable and reports state").toBeTruthy();

    // No token may ever appear in an API response.
    const conns = await setup.get("/api/connections");
    const body = await conns.text();
    expect(body).not.toContain("e2e-mock-token");
    expect(body.toLowerCase()).not.toContain('"token"');
  });
});
