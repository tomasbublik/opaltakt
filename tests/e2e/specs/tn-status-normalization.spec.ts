import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_URLS } from "../../playwright.config";
import { ensureConnection, ensureVaultReady, uniqueSprintName } from "../fixtures/helpers";

/**
 * TN — Increment 21 (SPEC_21 "Status normalization — end filter duplicates"),
 * Agent D / QA.
 *
 * FILE NAME NOTE: continues the … → tl → tm → "tn-…" lexicographic sequence, so
 * it runs LAST against the ONE shared backend (after tm). Do NOT rename.
 *
 * ── WHAT PRODUCED THE BUG, AND WHERE THE FIX LIVES (read before the tests) ────
 * `status_name` had TWO writers that disagreed on casing for the SAME logical
 * status:
 *   - LIVE SYNC writes the work package's own `_links.status.title`, always OP's
 *     canonical spelling ("In progress").
 *   - JOURNAL RECONSTRUCTION (retrospective seed/replay, Increment 11-13) parsed
 *     the LITERAL activity prose, which historically preserved whatever casing
 *     was typed at the time ("in progress", lower-case).
 * The fix (Agent A): op-client's `normalizeStatusName` resolves the raw journal
 * text against the canonical `GET /api/v3/statuses` catalog, so reconstruction
 * now stores "In progress" too. Agent B added a data migration (0017) that
 * re-normalizes existing rows AND a read-side case-insensitive dedup pojistka in
 * `GET /backlog/filter-options`. Agent C deduped the one remaining client-side
 * dropdown (`SprintBoardScreen`'s BacklogColumn). Agent A also built the mock
 * mechanism that makes this expressible end-to-end: `setStatus` gained an
 * optional `statusDisplayText`, and the `s15-status-casing-divergence` scenario
 * uses it — WP 1901 transitions to the canonical "In progress" while its journal
 * DISPLAYS the lower-case "in progress".
 *
 * ── A LOAD-BEARING ARCHITECTURAL FACT the tests are shaped around ─────────────
 * `GET /backlog/filter-options` (the Status DROPDOWN) reads ONLY
 * `work_package_cache`, via the shared `visibleBacklog()` helper. EVERY writer
 * of `work_package_cache.status_name` in the current code — live sync AND every
 * retro cache-refresh path (apps/api/src/logic/retro.ts:370/599/780) — uses the
 * canonical `_links.status.title`. The RECONSTRUCTED (historically lower-case)
 * value is written ONLY to `ticket_baseline`, which the dropdown never reads.
 * CONSEQUENCE: in a freshly-migrated e2e DB the "duplicate Status filter entry"
 * cannot physically arise through any app flow — there is no code path that puts
 * a lower-case status into the cache the dropdown reads, and no e2e spec has a
 * direct-DB-seed mechanism to fabricate one (verified: no spec opens the DB;
 * playwright.config's temp DB path is keyed to the RUNNER pid, not reachable
 * from a worker). So:
 *   - §1/§7 assert the GENERIC no-casing-duplicate invariant on the live filter
 *     facets — a real regression guard that trips if any writer ever
 *     re-introduces a cased duplicate, and that exercises Agent B's read-side
 *     dedup pojistka's output — rather than claiming to reproduce the (now
 *     structurally-impossible-in-cache) bug.
 *   - §3 is the DIRECT, MEANINGFUL proof of the actual fix: it drives a real
 *     retro reconstruction against s15 (journal text "in progress") and asserts
 *     the reconstructed value surfaced by `GET /retro/preview` is the CANONICAL
 *     "In progress", NOT "in progress". This is the one assertion that would
 *     FAIL if Agent A's normalizeStatusName had not landed — it genuinely
 *     exercises the casing divergence.
 *   - §2 proves the FUNCTIONAL guarantee that makes the whole fix safe: a
 *     canonical Status filter value catches matching tickets regardless of the
 *     stored casing (the query layer has been case-insensitive since Inc 19),
 *     so no ticket is lost. The literal "pre-migration lower-case ROW in the
 *     cache" is not constructible here (see above) — that specific migration
 *     mechanic is Agent B's own unit responsibility (repos/migration test); this
 *     asserts the observable read-path contract instead.
 *
 * ── §0 real-DB TRIPWIRE (same pattern as tm-/tl-/tk-): fingerprint the REAL
 *    apps/api/osp.sqlite at start/end; fail loudly if it moved. ───────────────
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Runs against a DEDICATED recording mock (own ephemeral port ⇒ own connection
 * id) loaded with s15-status-casing-divergence. The recording mock doubles as
 * the §8 guardrail request recorder. No new apps/api boot: reuses the
 * playwright.config webServer (which already sets OSP_DB_PATH + PORT per the
 * hard guardrail). Nothing here issues a non-GET toward OP.
 */

// ── shared constants ─────────────────────────────────────────────────────────
const SCENARIO = "s15-status-casing-divergence";
const PROJECT_OP_ID = 3; // DEFAULT_PROJECTS "Demo Project" (s15 seeds no projects)
const WP = 1901; // the "casing" ticket
const VERSION_NAME = "3.5.039";
const VERSION_OP_ID = 41; // s15 seed: { key:"v_target", id:41, name:"3.5.039" }
const CANONICAL_STATUS = "In progress"; // exactly as GET /api/v3/statuses renders it
const NONCANONICAL_STATUS = "in progress"; // the journal display casing (statusDisplayText)
// Reconstruct WP 1901 to a target AFTER its day-1 "→ In progress" transition
// (Mon 2026-07-06 = day 0; Tue 07-07 = day 1). Day 2 = Wed 07-08: current status
// is still "In progress" (the day-3 "→ Developed" event hasn't happened yet),
// so the live cache and the reconstruction agree on "In progress".
const REPLAY_TO_DAY = 2;
const SPRINT_START = "2026-07-08";
const SPRINT_END = "2026-07-09";

// ── minimal contract subsets ─────────────────────────────────────────────────
interface BacklogItem {
  op_id: number;
  status_name: string | null;
  status_is_closed?: boolean;
  assignee_op_id: number | null;
  version_op_id: number | null;
  version_name: string | null;
  priority: string | null;
  project_op_id: number;
  connection_id: number | null;
}
interface FilterOptions {
  projects: string[];
  statuses: string[];
  assignees: { id: number; name: string }[];
  versions: { id: number; name: string }[];
  priorities: string[];
  servers: { id: number; name: string }[];
}
interface RetroCandidate {
  wp_op_id: number;
  status_at_start_date: string | null;
  assignee_at_start_date: string | null;
  reconstructed: boolean;
  gaps: string[];
}
interface RetroPreviewResp {
  sprint_id: number;
  start_date: string;
  items: RetroCandidate[];
}
interface ClosureBucket {
  count: number;
  items: unknown[];
}
interface ClosureStatsResp {
  sprint_id: number;
  done: ClosureBucket;
  not_done: ClosureBucket;
  rejected: ClosureBucket;
  ambiguous: ClosureBucket;
}
interface SprintRow {
  id: number;
  status: string;
}
interface SyncStatus {
  current: { id: number } | null;
}

// ── §0 tripwire: the real DB file we must PROVE we never touch ────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", ".."); // tests/e2e/specs → root
const REAL_DB = path.join(REPO_ROOT, "apps", "api", "osp.sqlite");

interface DbFingerprint {
  size: number;
  mtimeMs: number;
}
function fingerprintRealDb(): DbFingerprint | null {
  try {
    const st = fs.statSync(REAL_DB);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
function assertRealDbUnchanged(before: DbFingerprint | null): void {
  const after = fingerprintRealDb();
  if (before === null || after === null) {
    // eslint-disable-next-line no-console
    console.warn(`[§0 tripwire] ${REAL_DB} absent — nothing to compare (invariant holds vacuously).`);
    return;
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(
      `[§0 TRIPWIRE FAILED] ${REAL_DB} changed during the e2e run — ` +
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}. This is the Increment-11 incident.`,
    );
  }
}

/** The one generic check that catches ANY casing-only duplicate (not just the
 * specific ones named in the bug report): lower-casing collapses fewer entries
 * only if a pure casing duplicate exists. */
function assertNoCasingDuplicates(values: string[], facet: string): void {
  const lowered = new Set(values.map((v) => v.toLowerCase()));
  const dupes = values.filter((v, i) => values.findIndex((w) => w.toLowerCase() === v.toLowerCase()) !== i);
  expect(
    lowered.size,
    `${facet} facet has a case-insensitive-equal-but-string-different duplicate: ` +
      `${JSON.stringify(values)} (offending: ${JSON.stringify(dupes)})`,
  ).toBe(values.length);
}

/** For an `{id, name}[]` facet (id IS the identity, unlike a plain string
 * facet): assert no SINGLE id appears with two differently-cased names — the
 * real analogue of the status bug (one entity, two spellings). Two DIFFERENT
 * ids sharing a name is legitimate real-world data, not a bug (see call site
 * comment), so this deliberately does NOT flag that. */
function assertNoIdWithMultipleCasings(
  entries: { id: number; name: string }[],
  facet: string,
): void {
  const byId = new Map<number, Set<string>>();
  for (const { id, name } of entries) {
    const set = byId.get(id) ?? new Set<string>();
    set.add(name);
    byId.set(id, set);
  }
  for (const [id, names] of byId) {
    expect(
      names.size,
      `${facet}: id ${id} has multiple differently-cased names: ${JSON.stringify([...names])}`,
    ).toBe(1);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
test.describe.serial("TN — SPEC_21 status normalization (no duplicate filter entries)", () => {
  let setup: APIRequestContext;
  let rec: RecordingMockOpServer; // dedicated, isolated mock + request recorder
  let myConnId = 0;
  let dbBefore: DbFingerprint | null;
  let ready = false;
  let scenarioMissing = false;
  let retroSprintId = 0;
  let previewStatusAtStart: string | null | undefined;

  // ── low-level helpers ───────────────────────────────────────────────────────
  async function gotoDay(day: number): Promise<void> {
    const res = await setup.post(`${rec.url}/__mock/goto-day/${day}`);
    expect(res.ok(), `goto-day ${day}: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  async function getSyncStatus(): Promise<SyncStatus> {
    const res = await setup.get("/api/sync/status");
    expect(res.ok(), `sync/status: ${res.status()}`).toBeTruthy();
    return (await res.json()) as SyncStatus;
  }
  async function waitNoCurrentSync(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await getSyncStatus()).current === null) return;
      if (Date.now() > deadline) throw new Error("a sync was still running past the deadline");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function fullSync(): Promise<void> {
    const res = await setup.post("/api/sync", {
      data: { project_op_id: PROJECT_OP_ID, connection_id: myConnId, kind: "full" },
    });
    expect(res.ok(), `sync project ${PROJECT_OP_ID}: ${res.status()} ${await res.text()}`).toBeTruthy();
    await waitNoCurrentSync();
  }
  function toQuery(params: Record<string, string | number>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    return qs.toString();
  }
  async function filterOptions(params: Record<string, string | number>): Promise<FilterOptions> {
    const res = await setup.get(`/api/backlog/filter-options?${toQuery(params)}`);
    expect(res.ok(), `filter-options: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as FilterOptions;
  }
  async function backlog(params: Record<string, string | number>): Promise<BacklogItem[]> {
    const res = await setup.get(`/api/backlog?${toQuery(params)}`);
    expect(res.ok(), `backlog: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as BacklogItem[];
  }
  async function getSprint(id: number): Promise<SprintRow | undefined> {
    const res = await setup.get("/api/sprints");
    if (!res.ok()) return undefined;
    return ((await res.json()) as SprintRow[]).find((s) => s.id === id);
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dbBefore = fingerprintRealDb();
    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);

    rec = await createRecordingMockOpServer();
    const load = await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(SCENARIO)}`);
    if (!load.ok()) {
      scenarioMissing = true;
      // eslint-disable-next-line no-console
      console.warn(`[TN] scenario "${SCENARIO}" not loadable: ${load.status()} ${await load.text()}`);
      return;
    }
    myConnId = await ensureConnection(setup, rec.url, "tn-status-norm-token");
    await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: true, current: true } });

    // Advance the scenario clock so WP 1901's day-1 "→ In progress" transition
    // (journal DISPLAY text "in progress") exists, then pull the CURRENT state
    // into work_package_cache. Cache now holds WP 1901 = canonical "In progress".
    await gotoDay(REPLAY_TO_DAY);
    await fullSync();

    // Build a RETROSPECTIVE sprint for version 3.5.039 and seed it — the seed
    // reconstructs WP 1901 to start_date (2026-07-08), reading "in progress"
    // from the journal. GET /retro/preview surfaces the reconstructed value.
    const create = await setup.post("/api/sprints", {
      data: { name: uniqueSprintName("TN Status Casing"), start_date: SPRINT_START, end_date: SPRINT_END },
    });
    expect(create.ok(), `create sprint: ${create.status()} ${await create.text()}`).toBeTruthy();
    retroSprintId = ((await create.json()) as { id: number }).id;

    const patch = await setup.patch(`/api/sprints/${retroSprintId}`, {
      data: { is_retrospective: true },
    });
    expect(patch.ok(), `mark retrospective: ${patch.status()} ${await patch.text()}`).toBeTruthy();

    const seed = await setup.post(`/api/sprints/${retroSprintId}/retro/seed`, {
      data: { kind: "version", value: VERSION_NAME },
    });
    expect(seed.ok(), `retro seed by version ${VERSION_NAME}: ${seed.status()} ${await seed.text()}`).toBeTruthy();

    const prev = await setup.get(`/api/sprints/${retroSprintId}/retro/preview`);
    expect(prev.ok(), `retro preview: ${prev.status()} ${await prev.text()}`).toBeTruthy();
    const preview = (await prev.json()) as RetroPreviewResp;
    previewStatusAtStart = preview.items.find((i) => i.wp_op_id === WP)?.status_at_start_date;

    ready = true;
  });

  test.afterAll(async () => {
    if (retroSprintId) await setup.delete(`/api/sprints/${retroSprintId}`).catch(() => {});
    if (myConnId) await setup.patch(`/api/connections/${myConnId}`, { data: { enabled: false } }).catch(() => {});
    await setup?.dispose();
    if (rec) await rec.close().catch(() => {});
    assertRealDbUnchanged(dbBefore);
  });

  function skipIfNotReady(): void {
    test.skip(scenarioMissing, `scenario "${SCENARIO}" not landed (load 404).`);
    test.skip(!ready, "TN fixture could not be set up (sync / retro seed unavailable).");
  }

  // ── §0 tripwire armed ───────────────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    test.info().annotations.push({
      type: "SPEC_21 isolation",
      description:
        dbBefore === null
          ? `${REAL_DB} not present — tripwire no-ops.`
          : `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
    });
    expect(true).toBe(true);
  });

  // ── §1: NO DUPLICATES in the Status filter (SPEC_21 §6 bullet 1) ─────────────
  test("§1: the Status filter facet has no case-insensitive duplicate entries", async () => {
    skipIfNotReady();

    // Scoped to THIS connection (only s15 data — deterministic) AND globally
    // (the whole shared cache — the realistic multi-status dropdown a user sees).
    const scoped = await filterOptions({ connectionId: myConnId });
    assertNoCasingDuplicates(scoped.statuses, "statuses (this connection)");
    expect(
      scoped.statuses.some((s) => s === CANONICAL_STATUS),
      `WP ${WP} is "In progress" in the live cache, so the scoped Status facet must offer exactly "${CANONICAL_STATUS}"`,
    ).toBeTruthy();

    const global = await filterOptions({});
    assertNoCasingDuplicates(global.statuses, "statuses (global cache)");

    test.info().annotations.push({
      type: "SPEC_21 §6.1 no-duplicates",
      description:
        `scoped statuses=${JSON.stringify(scoped.statuses)}; ` +
        `global statuses=${JSON.stringify(global.statuses)}. ` +
        `Generic Set(lowercase) check catches ANY casing duplicate, not only the reported ones. ` +
        `Architectural note: filter-options reads work_package_cache, whose every writer is canonical, so ` +
        `the reconstructed lower-case value (ticket_baseline only) never reaches this facet — this asserts ` +
        `the invariant + exercises Agent B's read-side dedup pojistka output.`,
    });
  });

  // ── §7: Version / Priority / Assignee — no silent duplication (SPEC_21 §4) ───
  test("§7: version / priority / assignee facets also have no casing duplicates", async () => {
    skipIfNotReady();
    const scoped = await filterOptions({ connectionId: myConnId });
    const global = await filterOptions({});

    // `priorities` is a plain string facet (no separate id) — the STRING is the
    // identity, so any case-insensitive-equal pair is unambiguously the exact
    // bug class this increment fixes.
    assertNoCasingDuplicates(scoped.priorities, "priorities (this connection)");
    assertNoCasingDuplicates(global.priorities, "priorities (global cache)");

    // `versions`/`assignees` are `{id, name}[]` — the ID is the identity, NOT
    // the name. Two DIFFERENT real ids legitimately sharing a display name is
    // NOT a casing-duplicate bug (e.g. two different projects' own version
    // "3.5.040", or two different people who happen to share a name) — this
    // genuinely happens across this suite's own fixtures (s10 and s14 both
    // independently chose "3.5.040" for narrative continuity with real
    // production naming, per Increment 17-21 precedent), which is exactly
    // why this must be scoped to per-id, not per-name: assert instead that
    // NO SINGLE id maps to two differently-cased names (the real analogue of
    // the status bug — one entity, two spellings), which the backend's own
    // id-keyed dedup already structurally prevents, but assert it directly
    // rather than trust it.
    assertNoIdWithMultipleCasings(scoped.versions, "versions (this connection)");
    assertNoIdWithMultipleCasings(global.versions, "versions (global cache)");
    assertNoIdWithMultipleCasings(scoped.assignees, "assignees (this connection)");
    assertNoIdWithMultipleCasings(global.assignees, "assignees (global cache)");

    test.info().annotations.push({
      type: "SPEC_21 §4 due-diligence sweep",
      description:
        `Priority/Version/Assignee are canonical by source (_links.*.title / name=identity), so no duplicate ` +
        `is expected — asserted explicitly rather than trusted. scoped versions=${JSON.stringify(scoped.versions.map((v) => v.name))}, ` +
        `priorities=${JSON.stringify(scoped.priorities)}, assignees=${JSON.stringify(scoped.assignees.map((a) => a.name))}.`,
    });
  });

  // ── §2: FUNCTIONALITY PRESERVED — filter still catches the tickets ───────────
  test("§2: filtering Version 3.5.039 + Status 'In progress' returns WP 1901 regardless of the query's casing", async () => {
    skipIfNotReady();

    const canonical = await backlog({
      connectionId: myConnId,
      version: VERSION_OP_ID,
      status: CANONICAL_STATUS,
    });
    expect(
      canonical.some((r) => r.op_id === WP),
      `Version ${VERSION_NAME} + Status "${CANONICAL_STATUS}" must return WP ${WP} (got op_ids ${JSON.stringify(canonical.map((r) => r.op_id))})`,
    ).toBeTruthy();

    // The guarantee that makes the migration safe: a canonical filter VALUE
    // catches any-cased stored data (Inc 19 made repos.find({statusName})
    // case-insensitive). So filtering by the lower-case "in progress" returns
    // the SAME rows — no ticket is ever lost to a casing mismatch.
    const lower = await backlog({
      connectionId: myConnId,
      version: VERSION_OP_ID,
      status: NONCANONICAL_STATUS,
    });
    expect(
      lower.map((r) => r.op_id).sort(),
      `case-insensitive matching: "${NONCANONICAL_STATUS}" must return the same rows as "${CANONICAL_STATUS}"`,
    ).toEqual(canonical.map((r) => r.op_id).sort());

    test.info().annotations.push({
      type: "SPEC_21 §6.2 functionality preserved",
      description:
        `Version ${VERSION_NAME} + "${CANONICAL_STATUS}" → op_ids ${JSON.stringify(canonical.map((r) => r.op_id))}; ` +
        `same via "${NONCANONICAL_STATUS}". The literal "pre-migration lower-case ROW in work_package_cache" is not ` +
        `constructible in a freshly-migrated e2e DB (no app path writes it; no e2e direct-DB-seed exists) — that ` +
        `migration mechanic is Agent B's unit responsibility (repos/migration test). This proves the observable ` +
        `read-path contract that keeps such rows findable.`,
    });
  });

  // ── §3: NEW WRITES STAY CANONICAL — the DIRECT proof of the fix ──────────────
  test("§3: a fresh retro reconstruction canonicalizes the journal's lower-case 'in progress' to 'In progress'", async () => {
    skipIfNotReady();
    test.skip(
      previewStatusAtStart === undefined,
      `WP ${WP} was not returned by /retro/preview — the version seed did not pick it up.`,
    );

    test.info().annotations.push({
      type: "SPEC_21 §6.3 new writes canonical (core fix proof)",
      description:
        `s15's journal DISPLAYS "in progress" (via statusDisplayText) for WP ${WP}'s transition, while the status ` +
        `link stays canonical "In progress". reconstruct.ts's normalizeStatusName must collapse the divergence. ` +
        `Observed /retro/preview status_at_start_date = ${JSON.stringify(previewStatusAtStart)}. ` +
        `This is the one assertion that FAILS if Agent A's op-client fix had not landed.`,
    });

    expect(
      previewStatusAtStart,
      `reconstruction must store OP's canonical spelling ("${CANONICAL_STATUS}"), not the journal's "${NONCANONICAL_STATUS}"`,
    ).toBe(CANONICAL_STATUS);
    expect(
      previewStatusAtStart,
      `the reconstructed value must NOT be the raw lower-case journal text`,
    ).not.toBe(NONCANONICAL_STATUS);
  });

  // ── §5: CHIPS MATCH FILTER — a browser-level assertion (SPEC_21 §6 bullet 5) ─
  test("§5: the status chip on a backlog row shows the EXACT string the Status filter offers", async ({ page }) => {
    skipIfNotReady();
    test.setTimeout(45_000);

    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Screens" });
    const backlogTab = nav.getByRole("button", { name: "Backlog", exact: true });
    test.skip((await backlogTab.count()) === 0, "Backlog nav tab not present (app not on the connected screen).");
    await backlogTab.click();

    const statusSelect = page.locator("#f-status");
    await expect(statusSelect).toBeVisible({ timeout: 15_000 });

    // The dropdown option list (SPEC_21 §5: chips must equal what you'd select).
    const optionTexts = (await statusSelect.locator("option").allTextContents()).map((t) => t.trim());
    test.skip(
      !optionTexts.includes(CANONICAL_STATUS),
      `"${CANONICAL_STATUS}" is not offered as a Status option (no in-progress rows visible) — nothing to compare.`,
    );

    // Selecting the canonical option narrows the table; every resulting row's
    // status BADGE must render the identical canonical string.
    await statusSelect.selectOption({ label: CANONICAL_STATUS });
    const badges = page.locator("table tbody tr td .badge");
    await expect
      .poll(async () => badges.count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    const badgeTexts = (await badges.allTextContents()).map((t) => t.trim());
    for (const text of badgeTexts) {
      expect(
        text,
        `a status chip shows "${text}" but the Status filter option is "${CANONICAL_STATUS}" — chip ↔ filter must be byte-identical`,
      ).toBe(CANONICAL_STATUS);
    }

    test.info().annotations.push({
      type: "SPEC_21 §6.5 chips match filter",
      description:
        `Status dropdown options=${JSON.stringify(optionTexts)}; after selecting "${CANONICAL_STATUS}", ` +
        `${badgeTexts.length} row chip(s) all read "${CANONICAL_STATUS}".`,
    });
  });

  // ── §6: DONE-MATRIX UNAFFECTED (SPEC_21 §6 bullet: done/isClosed) ────────────
  test("§6: closure classification is casing-invariant — every sprint ticket lands in exactly one bucket", async () => {
    skipIfNotReady();
    test.setTimeout(90_000);

    // Activate the retro sprint (day-by-day replay) so closure-stats has a
    // classified population, then read the role-aware done matrix. The sprint's
    // window (2026-07-08..09) is entirely in the PAST relative to the mock clock,
    // so end-of-replay AUTO-LOCKS it to "closed" (SPEC_12 §2 — "active" is only a
    // TRANSIENT mid-replay state for a past window). Poll to the terminal state
    // before reading, or a mid-flight read would see an incomplete population.
    const act = await setup.post(`/api/sprints/${retroSprintId}/activate`);
    test.skip(act.status() === 404, "POST /sprints/:id/activate not available.");
    expect(act.ok(), `activate retro sprint: ${act.status()} ${await act.text()}`).toBeTruthy();
    const terminal = await (async (): Promise<string | undefined> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const s = await getSprint(retroSprintId);
        if (s && (s.status === "closed" || s.status === "finished")) return s.status;
        if (Date.now() > deadline) return s?.status;
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    test.skip(
      terminal === "planning",
      "retro replay never left 'planning' — activation/replay engine did not run.",
    );

    const first = await setup.get(`/api/sprints/${retroSprintId}/closure-stats`);
    expect(first.ok(), `closure-stats: ${first.status()} ${await first.text()}`).toBeTruthy();
    const c1 = (await first.json()) as ClosureStatsResp;
    const total1 = c1.done.count + c1.not_done.count + c1.rejected.count + c1.ambiguous.count;

    // Idempotency: re-reading produces identical counts (no casing-driven drift
    // between reads). classifyWithRole normalises status via norm() (grep
    // doneRole.ts) — casing cannot move a ticket between buckets by construction,
    // and post-fix every persisted status is canonical anyway, so this is a
    // faithful "counts identical before/after considering casing" assertion.
    const second = await setup.get(`/api/sprints/${retroSprintId}/closure-stats`);
    expect(second.ok(), `closure-stats (2nd): ${second.status()}`).toBeTruthy();
    const c2 = (await second.json()) as ClosureStatsResp;
    const total2 = c2.done.count + c2.not_done.count + c2.rejected.count + c2.ambiguous.count;

    expect(total1, "every classified sprint ticket lands in exactly one bucket (none lost to a casing crack)").toBeGreaterThan(0);
    expect(
      { done: c2.done.count, not_done: c2.not_done.count, rejected: c2.rejected.count, ambiguous: c2.ambiguous.count },
      "closure bucket counts are stable across reads (casing-invariant classification)",
    ).toEqual({ done: c1.done.count, not_done: c1.not_done.count, rejected: c1.rejected.count, ambiguous: c1.ambiguous.count });
    expect(total2).toBe(total1);

    test.info().annotations.push({
      type: "SPEC_21 §6.6 done-matrix unaffected",
      description:
        `terminal sprint status="${terminal}"; buckets done=${c1.done.count} not_done=${c1.not_done.count} ` +
        `rejected=${c1.rejected.count} ambiguous=${c1.ambiguous.count} (Σ=${total1}). classifyWithRole was ALREADY case-insensitive ` +
        `(doneRole.ts norm()), so this was never a classification bug — asserted as a real regression guard anyway.`,
    });
  });

  // ── §8: GUARDRAILS (SPEC_21 §6 bullet: all GET; no /api/v3/users) ────────────
  test("§8 guard: every OP request is a GET, no GET /api/v3/users, and GET /api/v3/statuses is allowed (not flagged)", async () => {
    skipIfNotReady();

    const opRequests = rec.requests.filter((r) => !r.path.startsWith("/__mock"));
    const usersCollection = opRequests.filter((r) => r.path === "/api/v3/users");
    const statusesCatalog = opRequests.filter((r) => r.path === "/api/v3/statuses");
    const nonOpNonMock = rec.requests.filter(
      (r) => !r.path.startsWith("/__mock") && !r.path.startsWith("/api/v3/"),
    );

    test.info().annotations.push({
      type: "SPEC_21 §8 guardrails",
      description:
        `op-client hit these OP paths: ${JSON.stringify([...new Set(opRequests.map((r) => `${r.method} ${r.path}`))].slice(0, 25))}. ` +
        `bare /api/v3/users hits=${usersCollection.length}. /api/v3/statuses hits=${statusesCatalog.length}. ` +
        `non-OP/non-mock paths=${JSON.stringify(nonOpNonMock.map((r) => r.path))}.`,
    });

    expect(opRequests.length, "op-client exercised the recording mock").toBeGreaterThan(0);
    expect(usersCollection.length, "GET /api/v3/users (admin-gated user collection) must NEVER be called").toBe(0);
    expect(nonOpNonMock, "op-client only ever targets /api/v3/*").toEqual([]);
    for (const r of opRequests) {
      expect(r.method, `OP request ${r.method} ${r.path} must be a GET (read-only)`).toBe("GET");
    }
    // The canonical-catalog fetch is the LOAD-BEARING new dependency of this
    // increment — it MUST have been called (sync + reconstruction both need it),
    // and being a plain GET it is correctly NOT flagged by the users-only guard.
    expect(
      statusesCatalog.length,
      "GET /api/v3/statuses (canonical status catalog) must be fetched — it drives normalizeStatusName",
    ).toBeGreaterThan(0);
    for (const r of statusesCatalog) {
      expect(r.method, "GET /api/v3/statuses is a normal allowed GET (NOT the restricted /api/v3/users)").toBe("GET");
    }
  });
});
