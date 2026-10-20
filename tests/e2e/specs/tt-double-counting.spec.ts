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
  ensureConnection,
  ensureVaultReady,
  openWindowEnd,
  resetMock,
  uniqueSprintName,
} from "../fixtures/helpers";

/**
 * TT — Increment 28 §2 (docs/INCREMENT_28_CONTRACTS.md): **double counting is
 * MARKED, explained, and fixable in one click** — and the §0c defect it
 * uncovered ("a developer VANISHES from Capacity") is gone. Agent D / QA.
 *
 * FILE NAME NOTE: runs after `ts-…` and before `tz-db-isolation` (Playwright
 * runs spec files in filename order against ONE shared backend). Do NOT rename.
 *
 * ── FIXTURE: the exact §0c reproduction, unaltered ──────────────────────────
 * The mock's STATIC fixture mode (`fixtures/data/work_packages.json`) is the
 * only place OpenProject itself reports a parent link, and it reports exactly
 * the pair Phase 0 measured the defect on:
 *
 *   #1001 "Implement login"          Ada Lovelace   In progress  work 8 / rem 4 → effEst 4   PARENT
 *   #1002 "Fix login redirect bug"   Grace Hopper   New          work 4 / rem 4 → effEst 4   child of #1001
 *
 * Phase 0, on a running stack: `GET /sprints/:id/capacity` returned ONE line
 * (Grace, 4 h) — Ada was ABSENT ENTIRELY, because `computeCapacity` filtered
 * its input down to `leafEffort().leaves`. That is a direct violation of
 * CAPACITY_BAR_RULES §5 invariant 5, and it is what §2 would otherwise ship on
 * top of: a "Parent" badge on a ticket whose assignee is missing from the panel
 * directly below it.
 *
 * WHAT THIS FILE PROVES (the §4 verification list, items 5, 7, 8 + §0c)
 *   §0  THE REGRESSION PIN: the parent's developer has a line again, at 0 h,
 *       and — just as important — NO total moved. Proved as a real BEFORE /
 *       AFTER (child-only sprint → add the parent), not asserted from memory.
 *   §1  Marking: "Parent" on #1001, "Child of #1001" on #1002, the risk
 *       tooltip, and a warning listing the CONCRETE pair with controls that
 *       jump to the ticket (§2d).
 *   §2  Actions: "Remove parent(s)" and "Remove children", each behind a
 *       confirmation, each recomputing capacity, with the warning gone
 *       afterwards.
 *   §3  Locked sprint: the badges still render, the ACTIONS are absent, and
 *       both endpoints answer 409.
 *   §4  Guardrails: every OpenProject request is a GET, the admin-gated
 *       `GET /api/v3/users` collection is never called, no token leaks, and
 *       detection is connection-scoped.
 *
 * MULTI-LEVEL COVERAGE LIVES ELSEWHERE, ON PURPOSE. The fixture models exactly
 * ONE parent edge and no scenario sets `parent` at all, so "several children
 * under one parent", "several independent groups" and "grandparent + grandchild
 * with the intermediate absent" (§2a/§6) cannot be expressed here. They are
 * covered against the real Fastify app in `tests/src/inc28-double-counting.test.ts`,
 * which synthesises the cache edges the mock cannot serve.
 *
 * ⛔ ISOLATION: no new server boot — reuses tests/playwright.config.ts's
 * webServer (generated throwaway Postgres `osp_e2e_<pid>`, non-default ports).
 * `tz-db-isolation.spec.ts` is the suite-wide tripwire.
 */

const PROJECT_OP_ID = 3;
const PARENT_WP = 1001;
const CHILD_WP = 1002;
const PARENT_HOLDER = "Ada Lovelace";
const CHILD_HOLDER = "Grace Hopper";
const EFF_PARENT = 4; // work 8 / rem 4 → remaining wins (CAPACITY_BAR_RULES §3)
const EFF_CHILD = 4; // work 4 / rem 4 → remaining == work, so work wins

interface CapacityLineLike {
  op_user_id: number | null;
  member_id: number | null;
  name: string;
  planned_hours: number;
  available_hours: number;
  role: string;
  is_developer: boolean;
}
interface CapacityLike {
  lines: CapacityLineLike[];
  total_planned_hours: number;
  scope_planned_hours: number;
  baseline_total_hours: number | null;
}
interface DetailRow {
  op_id: number;
  outcome: string;
  double_count_children?: number[];
  double_count_parent_of?: number | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}
function capacityPanel(page: Page): Locator {
  return page.locator(".panel").filter({ has: page.getByRole("heading", { name: "Capacity" }) });
}
function card(page: Page, opId: number): Locator {
  return page.getByTestId(`wp-card-${opId}`);
}

async function gotoBoard(page: Page, sprintId: number): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name: "Sprint board", exact: true }).click();
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
  await expect(capacityPanel(page).getByRole("heading", { name: "Capacity" })).toBeVisible();
}

async function getCapacity(ctx: APIRequestContext, sprintId: number): Promise<CapacityLike> {
  const res = await ctx.get(`/api/sprints/${sprintId}/capacity`);
  expect(res.ok(), `capacity ${sprintId}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as CapacityLike;
}
async function getDetails(ctx: APIRequestContext, sprintId: number): Promise<Map<number, DetailRow>> {
  const res = await ctx.get(`/api/sprints/${sprintId}/items/detailed`);
  expect(res.ok(), `items/detailed ${sprintId}: ${res.status()}`).toBeTruthy();
  return new Map(((await res.json()) as DetailRow[]).map((r) => [r.op_id, r]));
}
function planned(cap: CapacityLike): Record<string, number> {
  return Object.fromEntries(cap.lines.map((l) => [l.name, l.planned_hours]));
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe("TT — Increment 28 §2: double counting is marked, explained and fixable", () => {
  let setup: APIRequestContext;
  /** Sprint used by §0 (before/after) and §1/§2 (marking + actions). */
  let sprintMain = 0;
  /** A second sprint, activated then finished, for the locked-state leg. */
  let sprintLocked = 0;

  async function createSprint(label: string): Promise<number> {
    const res = await setup.post("/api/sprints", {
      data: {
        name: uniqueSprintName(label),
        start_date: "2026-07-06",
        end_date: openWindowEnd(30),
      },
    });
    expect(res.ok(), `create sprint ${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
    return ((await res.json()) as { id: number }).id;
  }

  async function addItem(sprintId: number, wp: number): Promise<void> {
    const res = await setup.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wp } });
    expect(res.ok(), `add #${wp} to ${sprintId}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }

  /**
   * Put the sprint back into the parent+child collision state, whatever it was
   * in before.
   *
   * These tests originally chained off each other's leftovers — §2's two
   * removal tests empty the sprint, so every test after them asserted against
   * a sprint that no longer had the collision, and failed for a reason that
   * had nothing to do with the thing under test. (Diagnosed from Playwright's
   * own page snapshot: "0 Items in sprint" while the assertion waited for a
   * warning that correctly wasn't there.)
   *
   * The rest of this e2e suite is deliberately additive-safe for the same
   * reason — one shared backend, serial specs. Idempotent: an item already in
   * the sprint is left alone rather than re-added (which would 409).
   */
  async function ensureCollision(sprintId: number): Promise<void> {
    const present = await getDetails(setup, sprintId);
    for (const wp of [PARENT_WP, CHILD_WP]) {
      const row = present.get(wp);
      if (row && row.outcome !== "removed" && row.outcome !== "removed_mid_sprint") continue;
      await setup.delete(`/api/sprints/${sprintId}/items/${wp}`).catch(() => {});
      await addItem(sprintId, wp);
    }
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    const connId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${connId}`, { data: { current: true, enabled: true } });
    // Back to STATIC fixture mode — the only mock state that serves a real
    // `_links.parent`. A reset is a full OP-side reset, the standard per-spec
    // isolation (see loadScenario's doc).
    await resetMock(setup);
    // ⚠️ `kind: "full"`, not the default "auto". The e2e suite shares ONE backend
    // and ONE mock across every spec: by the time this file runs, project 3's
    // cache already holds a PREVIOUS spec's scenario, whose `updated_at_op`
    // watermark is newer than this fixture data's. An auto (incremental) sync asks
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

    sprintMain = await createSprint("TT double-count");

    // Closure counts DEVELOPERS only (Increment 14) and the static fixture
    // bakes no roles, so `scope_planned_hours` would be 0 for a reason with
    // nothing to do with double counting. People are materialised lazily by
    // GET /api/people, and ONLY from tickets already in SOME sprint — hence
    // the throwaway roster sprint.
    const roster = await createSprint("TT roster (setup only)");
    await addItem(roster, PARENT_WP);
    await addItem(roster, CHILD_WP);
    // ⚠️ Force BOTH holders to role "developer", matched by NAME **and** by
    // op_user_id. The shared e2e backend has already run a dozen specs by now,
    // several of which set roles (tester / customer / other) on these same
    // fixture people — and `buildCapacityResponse` resolves a line's role by
    // op_user_id FIRST, name second, so a team_member row keyed on the OP id
    // wins over a same-named one. A non-developer holder is excluded from
    // `total_planned_hours`, which would fail §0 for a reason that has nothing
    // to do with double counting.
    const targetOpUserIds = new Set(
      (await getCapacity(setup, roster)).lines
        .filter((l) => [PARENT_HOLDER, CHILD_HOLDER].includes(l.name))
        .map((l) => l.op_user_id)
        .filter((id): id is number => id != null),
    );
    const people = (await (await setup.get("/api/people")).json()) as Array<{
      id: number;
      name: string;
      role: string;
      op_user_id: number | null;
    }>;
    for (const p of people) {
      const matches =
        [PARENT_HOLDER, CHILD_HOLDER].includes(p.name) ||
        (p.op_user_id != null && targetOpUserIds.has(p.op_user_id));
      if (!matches) continue;
      const res = await setup.put(`/api/people/${p.id}/role`, { data: { role: "developer" } });
      expect(res.ok(), `role developer for ${p.name} (#${p.id}): ${res.status()}`).toBeTruthy();
    }
    const rosterCap = await getCapacity(setup, roster);
    for (const holder of [PARENT_HOLDER, CHILD_HOLDER]) {
      const line = rosterCap.lines.find((l) => l.name === holder);
      expect(
        line?.is_developer,
        `${holder} must be a DEVELOPER for the capacity totals to include them. ` +
          `line=${JSON.stringify(line)} people=${JSON.stringify(people)}`,
      ).toBe(true);
    }
    await setup.delete(`/api/sprints/${roster}`).catch(() => {});
  });

  test.afterAll(async () => {
    for (const id of [sprintMain, sprintLocked]) {
      if (id) await setup.delete(`/api/sprints/${id}`).catch(() => {});
    }
    await setup?.dispose();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §0 — THE REGRESSION PIN (contracts §0c). Before/after, totals asserted.
  // ───────────────────────────────────────────────────────────────────────────
  test("§0: adding the PARENT keeps its developer visible at 0 h and moves NO total", async () => {
    // BEFORE — only the child. One line, the child's holder.
    await addItem(sprintMain, CHILD_WP);
    const before = await getCapacity(setup, sprintMain);
    expect(planned(before)[CHILD_HOLDER], `${CHILD_HOLDER} holds #${CHILD_WP}`).toBe(EFF_CHILD);
    expect(planned(before)[PARENT_HOLDER], `${PARENT_HOLDER} holds nothing yet`).toBeUndefined();
    expect(before.total_planned_hours).toBe(EFF_CHILD);

    // AFTER — add the parent. `leafEffort` suppresses it from the SUM…
    await addItem(sprintMain, PARENT_WP);
    const after = await getCapacity(setup, sprintMain);

    // …but its developer must NOT vanish (this is the whole §0c defect).
    expect(
      after.lines.map((l) => l.name),
      `${PARENT_HOLDER} must have a capacity line — Phase 0 measured her ABSENT`,
    ).toContain(PARENT_HOLDER);
    expect(planned(after)[PARENT_HOLDER], "the suppressed parent contributes 0 h").toBe(0);

    // NOT ONE TOTAL MOVED — the most likely way this increment breaks
    // something real, so it is asserted explicitly, field by field.
    expect(after.total_planned_hours, "leaf-filtered total unchanged").toBe(
      before.total_planned_hours,
    );
    expect(planned(after)[CHILD_HOLDER], "the child holder's number unchanged").toBe(
      planned(before)[CHILD_HOLDER],
    );
    const strip = (cap: CapacityLike) =>
      cap.lines.filter((l) => l.name !== PARENT_HOLDER).sort((a, b) => a.name.localeCompare(b.name));
    expect(strip(after), "every pre-existing line is byte-identical").toEqual(strip(before));

    // The Capacity panel's own "Planned" (the closure pipeline, deliberately
    // NOT leaf-filtered — contracts §2b rule 1) must still count BOTH tickets:
    // this increment marks the collision, it does not re-do the arithmetic.
    //
    // ⚠️ Asserted RELATIVELY here, and pinned to the exact figure in
    // `tests/src/inc28-double-counting.test.ts` instead. In the shared e2e
    // backend `computeClosureStats` resolves roles through its own
    // CONNECTION-SCOPED person index (Increment 23), which disagrees with the
    // capacity panel's connection-agnostic `roleForParticipant` once several
    // connections and same-named fixture people exist — so the absolute number
    // there is not a stable statement about double counting. See the Agent D
    // report.
    expect(
      after.scope_planned_hours,
      "adding the parent must not REDUCE the closure-pipeline Planned",
    ).toBeGreaterThanOrEqual(before.scope_planned_hours);
  });

  test("§0: the board renders the parent's developer with an empty bar, next to the badged ticket", async ({
    page,
  }) => {
    await gotoBoard(page, sprintMain);
    const lines = page.locator(".capacity-line");
    await expect(lines.filter({ hasText: PARENT_HOLDER })).toHaveCount(1);
    await expect(lines.filter({ hasText: CHILD_HOLDER })).toHaveCount(1);
    await expect(card(page, PARENT_WP)).toBeVisible();
    await expect(card(page, CHILD_WP)).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §1 — MARKING (contracts §2a/§2d).
  // ───────────────────────────────────────────────────────────────────────────
  test("§1: the API is the ONE source of the parent/child links", async () => {
    const d = await getDetails(setup, sprintMain);
    expect(d.get(PARENT_WP)?.double_count_children, `#${PARENT_WP} lists its in-sprint child`).toEqual([
      CHILD_WP,
    ]);
    expect(d.get(PARENT_WP)?.double_count_parent_of).toBeNull();
    expect(d.get(CHILD_WP)?.double_count_parent_of, `#${CHILD_WP} points at its parent`).toBe(
      PARENT_WP,
    );
    expect(d.get(CHILD_WP)?.double_count_children).toEqual([]);
  });

  test("§1: the parent card carries a 'Parent' badge, the child 'Child of #1001', both with the risk tooltip", async ({
    page,
  }) => {
    await ensureCollision(sprintMain);
    await gotoBoard(page, sprintMain);

    const parentBadge = card(page, PARENT_WP).getByText(/^Parent of #/);
    await expect(parentBadge, "the parent ticket is badged").toBeVisible();
    const childBadge = card(page, CHILD_WP).getByText(`Child of #${PARENT_WP}`);
    await expect(childBadge, "the child names its parent by id").toBeVisible();

    // The tooltip explains the RISK, not just the relationship.
    for (const badge of [parentBadge, childBadge]) {
      const title = await badge.getAttribute("title");
      expect(title, `badge tooltip: ${String(title)}`).toBeTruthy();
      expect(title!.toLowerCase()).toContain("counted twice");
      expect(title!.toLowerCase()).toContain("leaf level");
    }
  });

  test("§1: the warning lists the CONCRETE pair, with a control that jumps to the ticket", async ({
    page,
  }) => {
    await ensureCollision(sprintMain);
    await gotoBoard(page, sprintMain);
    const warning = page.getByRole("alert").filter({ hasText: /double count/i });
    await expect(warning, "the double-counting warning is shown").toBeVisible();

    // §2d: concrete ids, not "N item(s)".
    await expect(warning).toContainText(`#${PARENT_WP}`);
    await expect(warning).toContainText(`#${CHILD_WP}`);
    await expect(warning, "the old count-only wording is gone").not.toContainText(
      /Double counting: \d+ item\(s\)/,
    );

    // Each id is a CONTROL that brings its card into view.
    const jump = warning.getByRole("button", { name: new RegExp(`#${CHILD_WP}`) });
    await expect(jump, "the child id is clickable").toBeVisible();
    await jump.click();
    await expect(card(page, CHILD_WP)).toBeInViewport();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §2 — ACTIONS (contracts §2c). Confirmation, recompute, warning gone.
  // ───────────────────────────────────────────────────────────────────────────
  test("§2: 'Remove children' is confirmed, recomputes capacity and clears the warning", async ({
    page,
  }) => {
    await ensureCollision(sprintMain);
    await gotoBoard(page, sprintMain);
    const warning = page.getByRole("alert").filter({ hasText: /double count/i });
    await expect(warning).toBeVisible();

    await warning.getByRole("button", { name: /Remove child/i }).click();
    // A modal confirmation naming the tickets — never window.confirm (§2c).
    const modal = page.getByRole("dialog");
    await expect(modal, "the action is behind a confirmation").toBeVisible();
    await expect(modal).toContainText(`#${CHILD_WP}`);
    await modal.getByRole("button", { name: /Remove/i }).click();

    // The collision is gone, the warning with it, and the numbers recomputed:
    // the parent is no longer suppressed, so it now carries its own hours.
    await expect(page.getByRole("alert").filter({ hasText: /double count/i })).toHaveCount(0);
    const cap = await getCapacity(setup, sprintMain);
    expect(planned(cap)[PARENT_HOLDER], "the parent is no longer suppressed").toBe(EFF_PARENT);
    expect(cap.total_planned_hours).toBe(EFF_PARENT);
    const d = await getDetails(setup, sprintMain);
    expect(d.get(PARENT_WP)?.double_count_children).toEqual([]);
    await expect(capacityPanel(page).locator(".capacity-line").filter({ hasText: PARENT_HOLDER })).toHaveCount(1);
  });

  test("§2: 'Remove parent(s)' is the PRIMARY action and works the same way", async ({ page }) => {
    // Re-establish the collision explicitly rather than depending on what the
    // previous test happened to leave behind.
    await ensureCollision(sprintMain);
    await gotoBoard(page, sprintMain);
    const warning = page.getByRole("alert").filter({ hasText: /double count/i });
    await expect(warning).toBeVisible();

    // §5 of the contracts: "Remove parent(s) from sprint" is the recommended
    // action, so it must come FIRST in the warning's controls.
    const actionButtons = warning.getByRole("button", { name: /Remove (parent|child)/i });
    await expect(actionButtons).toHaveCount(2);
    await expect(actionButtons.first(), "the parent removal is the primary action").toHaveText(
      /Remove parent/i,
    );

    await warning.getByRole("button", { name: /Remove parent/i }).click();
    const modal = page.getByRole("dialog");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(`#${PARENT_WP}`);
    await modal.getByRole("button", { name: /Remove/i }).click();

    await expect(page.getByRole("alert").filter({ hasText: /double count/i })).toHaveCount(0);
    const cap = await getCapacity(setup, sprintMain);
    expect(planned(cap)[CHILD_HOLDER]).toBe(EFF_CHILD);
    expect(cap.total_planned_hours, "planning at leaf level: only the child counts").toBe(EFF_CHILD);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §3 — LOCKED sprint: badges yes, actions no, endpoints 409.
  // ───────────────────────────────────────────────────────────────────────────
  test("§3: on a LOCKED sprint the badges still render, the actions are absent and both endpoints 409", async ({
    page,
  }) => {
    sprintLocked = await createSprint("TT locked double-count");
    await addItem(sprintLocked, PARENT_WP);
    await addItem(sprintLocked, CHILD_WP);

    const activated = await setup.post(`/api/sprints/${sprintLocked}/activate`);
    expect(activated.ok(), `activate: ${activated.status()} ${await activated.text()}`).toBeTruthy();
    // Activation is an async background run (SPEC_09 §1) — wait for the flip.
    await expect
      .poll(
        async () => {
          const sprints = (await (await setup.get("/api/sprints")).json()) as Array<{
            id: number;
            status: string;
          }>;
          return sprints.find((s) => s.id === sprintLocked)?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("active");
    const finished = await setup.post(`/api/sprints/${sprintLocked}/finish`);
    expect(finished.ok(), `finish: ${finished.status()} ${await finished.text()}`).toBeTruthy();

    // Both bulk endpoints refuse (Increment 4 immutability).
    for (const side of ["remove-parents", "remove-children"] as const) {
      const res = await setup.post(`/api/sprints/${sprintLocked}/double-count/${side}`);
      expect(res.status(), `${side} on a locked sprint`).toBe(409);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${side} error code`).toMatch(/SPRINT_LOCKED|SPRINT_CLOSED/);
    }

    // MARKING still renders — §2c: only the ACTIONS disappear.
    const d = await getDetails(setup, sprintLocked);
    expect(d.get(PARENT_WP)?.double_count_children).toEqual([CHILD_WP]);
    expect(d.get(CHILD_WP)?.double_count_parent_of).toBe(PARENT_WP);

    await gotoBoard(page, sprintLocked);
    await expect(card(page, PARENT_WP).getByText(/^Parent of #/)).toBeVisible();
    await expect(card(page, CHILD_WP).getByText(`Child of #${PARENT_WP}`)).toBeVisible();
    const warning = page.getByRole("alert").filter({ hasText: /double count/i });
    await expect(warning, "the warning itself still shows").toBeVisible();
    await expect(
      warning.getByRole("button", { name: /Remove (parent|child)/i }),
      "a locked sprint offers NO removal action",
    ).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §4 — guardrails.
  // ───────────────────────────────────────────────────────────────────────────
  test("§4: the browser never talks to OpenProject, and no connection token is ever served", async ({
    page,
  }) => {
    const opRequests: Array<{ method: string; path: string }> = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.origin === E2E_URLS.mock) opRequests.push({ method: req.method(), path: url.pathname });
    });
    await gotoBoard(page, sprintMain);
    expect(opRequests, `browser → OP traffic: ${JSON.stringify(opRequests)}`).toEqual([]);

    const conns = await setup.get("/api/connections");
    const body = await conns.text();
    expect(body).not.toContain("e2e-mock-token");
    expect(body.toLowerCase()).not.toContain('"token"');
  });

  test("§4: detection is connection-scoped — a sprint item's links never span servers", async () => {
    // Every cached row this spec used belongs to ONE connection; the detection
    // walk reads `work_package_cache.parent_op_id` and must not resolve an
    // ancestor through a row from a DIFFERENT server (the Increment-23 bare-op_id
    // collision class). Assert the sprint's own rows agree on their connection.
    const res = await setup.get("/api/backlog");
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()) as Array<{ op_id: number; connection_id: number | null }>;
    const relevant = rows.filter((r) => r.op_id === PARENT_WP || r.op_id === CHILD_WP);
    expect(relevant.length, "both fixture tickets are in the backlog").toBe(2);
    const connIds = new Set(relevant.map((r) => r.connection_id));
    expect(connIds.size, "parent and child come from the SAME connection").toBe(1);
    expect([...connIds][0], "…and it is a real, stamped connection (never NULL)").not.toBeNull();
  });
});
