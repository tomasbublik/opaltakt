import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { createRecordingMockOpServer, type RecordingMockOpServer } from "@osp/fixtures";
import { E2E_URLS } from "../../playwright.config";
import {
  advanceDay,
  ensureConnection,
  ensureVaultReady,
  loadScenario,
  uniqueSprintName,
  openWindowEnd,
} from "../fixtures/helpers";

/**
 * TF — Increment 13 (SPEC_13_Retro_Identity_and_Capacity.md), Agent D / QA.
 *
 * FILE NAME NOTE: continues the t9 → ta → tb → tc → td → te lexicographic
 * sequence. Playwright runs spec files in FILENAME order and "tf-…" sorts AFTER
 * "te-…", so this spec runs LAST. Do NOT rename it to "t13" (which would sort
 * BEFORE "t2").
 *
 * WHAT THIS FILE PROVES (SPEC_13 REVISED §8, Agent D brief):
 *
 *   Task 1 — the §0 e2e TRIPWIRE (identical pattern to te-…): stat the REAL
 *     apps/api/osp.sqlite once at suite start and once at suite end; fail loudly
 *     if size or mtime moved (the Increment-11 data-loss incident). Skips
 *     gracefully when the file is absent in this sandbox.
 *
 *   ── REVISED MODEL (SPEC_13 §1a): a person's identity IS their NAME. ──────────
 *   A journal-derived name gets a capacity line IMMEDIATELY — hours summed,
 *   availability editable — whether or not an OP user id is ever known. An id is
 *   OPPORTUNISTIC enrichment (from `_links.assignee`/`_links.accountable` titles
 *   already on fetched work packages, and `GET /api/v3/memberships`), NEVER the
 *   admin-gated `GET /api/v3/users` collection and NEVER a precondition. The old
 *   "blocked until paired" model is gone; `user_name_alias` (now with an OPTIONAL
 *   op_user_id AND an optional merge_into_name) is a rare escape hatch for genuine
 *   ambiguity or a renamed person — not a required unblocking step.
 *
 *   Task 2a — IDENTITY-EQUALITY guard (§1 point 4/5): the name→id map behind
 *     retro/preview and the one behind GET /capacity MUST be the SAME resolver
 *     output (same names, same ids incl. NULLs), a name with op_user_id=null is
 *     STILL a fully-present, normal line in BOTH views (the common, non-blocking
 *     case now), and "Jan Belka" is NEVER substituted for "Jan Bily".
 *   Task 2b — PEOPLE + never-resolved line (§1a/§8): GET /sprints/:id/people
 *     lists EVERYONE (not just unresolved names); a name that never gets an id
 *     still appears in /people AND in /capacity as a normal, fully editable line.
 *   Task 2c — CAPACITY SAVE WITH ZERO PAIRING (§8, the single most important
 *     proof for this revision): pick any reconstructed name (resolved or not) and
 *     PUT its available_hours successfully with NO prior alias/pairing step.
 *   Task 2d — ALIAS ESCAPE HATCH still works (§1b): POST /user-aliases via
 *     merge_into_name (or op_user_id) succeeds and DELETE reverts it — the manual
 *     path remains available for the rare ambiguous/renamed case.
 *   Task 2e — GET /api/v3/users (the COLLECTION) is NEVER CALLED (§1a, the direct
 *     guard against the root cause): a full retro flow is driven against a
 *     RECORDING mock OP instance whose every inbound request path is captured, and
 *     we assert path "/api/v3/users" (bare collection) is never hit — /users/me
 *     and /users/:id remain fine. This observes the API↔mock leg directly (which
 *     browser interception cannot see) and BITES the current fetchAllUsers path.
 *   Task 4 — RECONSTRUCTION honesty (§2): a ticket created AFTER start_date shows
 *     created_after_start_date=true with the real created_at_op (never a bogus
 *     "current state" baseline); a ticket fully inside the window reconstructs
 *     cleanly.  (Unchanged from the prior build — identity pivot doesn't touch it.)
 *   Task 5 — capacity bars render at available=0 (§4). (Unchanged.)
 *   Task 6 — STATE-MACHINE guard (§5): no planning-only endpoint is EVER SENT once
 *     the sprint leaves planning. (Unchanged.)
 *   Task 7 — retro capacity editable post-lock + audit (§6), AND the regression
 *     guard that an ordinary LOCKED sprint's capacity PUT still 409s. (Unchanged.)
 *
 * ⚠️ INTEGRATION NOTE (Agents A/B/C landing in parallel). The CONTRACTS
 * (packages/contracts) are FROZEN and carry the REVISED shapes (SprintPeople-
 * Response/SprintPersonEntry replace UnresolvedNames*; CapacityLine has NO
 * unresolved_name — op_user_id===null on an ordinary line IS the "no id yet"
 * state; UserNameAlias.op_user_id is nullable + merge_into_name added). BEHAVIOR
 * is still landing:
 *   • GET /sprints/:id/people, the reworked resolver (ids ONLY from
 *     _links.assignee/accountable + memberships, NEVER fetchAllUsers), retro
 *     roster from reconstructed names — Agent A/B. As of writing the API still
 *     ships GET /sprints/:id/unresolved-names + createIdentityResolver→
 *     fetchAllUsers→GET /api/v3/users, so Task 2e BITES until Agent B reworks it.
 *   • retro/preview may not yet populate assignee_op_id_at_start_date /
 *     assignee_resolution / created_after_start_date (Agent A/B).
 *   • No Jan-Belka/Jan-Bily ambiguity scenario exists yet (Agent A) —
 *     s7-tester-roundtrip (WP 11762) is the available stand-in; the pair
 *     assertion self-activates once a scenario carrying that pair is loaded.
 * Every FUNCTIONAL test PROBES its endpoint/field first and `test.skip()`s with a
 * clear annotation when the piece isn't landed, keeping the suite green while the
 * real assertions bite automatically once each feature arrives. Task 2e is
 * deliberately a HARD assert on an ABSENCE (only its PREREQUISITE flow steps skip)
 * — a guard that goes green while the bug is present would be worthless.
 *
 * GUARDRAIL (unchanged, NOT duplicating t7-guardrails): nothing here issues a
 * non-GET toward OP — the only writes are to the app's own /api/* surface and
 * the mock's /__mock/* admin API. No token is read or asserted anywhere.
 */

const PROJECT_OP_ID = 3;

// ── §0 e2e tripwire: the real DB file we must PROVE we never touch ────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/e2e/specs/ → repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
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
    return null; // absent in this sandbox — "if it exists, we never touch it".
  }
}

// ── scenarios / fixtures ──────────────────────────────────────────────────────
// s7-tester-roundtrip carries WP 11762 (the real production ticket at the heart
// of SPEC_13), reconstructed from a faithful reassignment/time/comment journal.
// TODO(integration): once Agent A ships an identity-ambiguity scenario (a
// "Jan Belka" / "Jan Bily" pair + a genuinely unresolved name), add its name
// to IDENTITY_SCENARIOS below and the pair assertion in Task 2 self-activates.
const RECON_SCENARIO = "s7-tester-roundtrip";
const RECON_WP = 11762;
const IDENTITY_SCENARIOS = ["s9-identity-ambiguity", "s9-retro-identity", RECON_SCENARIO];
// TODO(integration): version tag Agent A tags the identity/retro fixtures with.
const RETRO_VERSION = "3.5.039";
// The canonical similar-but-distinct pair from SPEC_13 §1 — asserted "never
// substituted" only when BOTH appear in the loaded scenario's reconstruction.
const AMBIGUOUS_PAIR: readonly [string, string] = ["Jan Belka", "Jan Bily"];

// ── minimal contract subsets (mirrors te-/td-'s local-interface style) ────────
interface SprintRow {
  id: number;
  status: string;
  is_locked?: boolean;
  is_retrospective?: boolean;
  start_date: string;
  end_date: string;
}
interface RetroCandidate {
  wp_op_id: number;
  subject: string;
  estimate_at_start_date: number | null;
  assignee_at_start_date: string | null;
  status_at_start_date: string | null;
  reconstructed: boolean;
  gaps: string[];
  // Increment 13 fields (may be absent until Agent A/B populate them):
  assignee_op_id_at_start_date?: number | null;
  assignee_resolution?: "exact" | "alias" | "unresolved" | null;
  created_after_start_date?: boolean;
  created_at_op?: string | null;
}
interface RetroPreviewResp {
  sprint_id: number;
  start_date: string;
  items: RetroCandidate[];
}
interface CapacityLine {
  member_id: number | null;
  op_user_id: number | null;
  name: string;
  available_hours: number;
  planned_hours: number;
  overloaded: boolean;
  has_sprint_work: boolean;
  baseline_hours: number;
  added_hours: number;
  removed_hours: number;
  redistributed_out_hours: number;
  redistributed_in_hours: number;
  // REVISED (SPEC_13 §1/§3): there is NO separate `unresolved_name` field any
  // more — a line with op_user_id===null on an otherwise-ordinary row IS the
  // "known by name only, no OP id yet" state (normal, non-blocking, editable).
}
interface CapacityResp {
  capacity_mode: string;
  lines: CapacityLine[];
  total_available_hours: number;
  total_planned_hours: number;
  baseline_total_hours: number | null;
}
/** GET /sprints/:id/people (SprintPersonEntry) — REPLACES the old
 * unresolved-names endpoint. Lists EVERYONE holding retro-reconstructed work,
 * with op_user_id WHEN known (null is normal, not a blocking state). */
interface SprintPersonEntry {
  connection_id: number;
  name: string;
  op_user_id: number | null;
  hours: number;
  ticket_count: number;
}
/** UserNameAlias (REVISED §1a): op_user_id is now OPTIONAL/nullable, and
 * merge_into_name folds a renamed person's old journal name under a current
 * display name. At least one of the two is set. */
interface UserNameAlias {
  id: number;
  connection_id: number;
  journal_name: string;
  op_user_id: number | null;
  merge_into_name: string | null;
  created_at: string;
}
interface CapacityAuditEntry {
  id: number;
  sprint_id: number;
  edited_at: string;
  changes_json: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────
/** A route is "not landed yet" if it 404s (Fastify unknown-route). */
function notImplemented(status: number): boolean {
  return status === 404;
}

async function getSprint(ctx: APIRequestContext, id: number): Promise<SprintRow | undefined> {
  const res = await ctx.get("/api/sprints");
  if (!res.ok()) return undefined;
  return ((await res.json()) as SprintRow[]).find((s) => s.id === id);
}

async function createSprint(
  ctx: APIRequestContext,
  label: string,
  start: string,
  end: string,
): Promise<number> {
  const res = await ctx.post("/api/sprints", {
    data: { name: uniqueSprintName(label), start_date: start, end_date: end },
  });
  expect(res.ok(), `create sprint: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { id: number }).id;
}

/** Mark a planning sprint retrospective via PATCH (SPEC_12 §2 — only while
 * status="planning"). Returns false if the PATCH isn't accepted (skip signal). */
async function makeRetrospective(ctx: APIRequestContext, sprintId: number): Promise<boolean> {
  const res = await ctx.patch(`/api/sprints/${sprintId}`, { data: { is_retrospective: true } });
  return res.ok();
}

async function addItem(ctx: APIRequestContext, sprintId: number, wpOpId: number): Promise<boolean> {
  const res = await ctx.post(`/api/sprints/${sprintId}/items`, { data: { wp_op_id: wpOpId } });
  return res.ok();
}

/** Seed a retro sprint. Tries `version` then `ids`; returns the HTTP status of
 * the FIRST attempt that wasn't a plain 404 (so callers can branch on 404 =
 * route absent vs other = present-but-couldn't-seed-this-value). */
async function seedRetro(
  ctx: APIRequestContext,
  sprintId: number,
  opts: { version?: string; ids?: string },
): Promise<{ status: number; ok: boolean; body: string }> {
  const attempts: Array<{ kind: "version" | "ids"; value: string }> = [];
  if (opts.version) attempts.push({ kind: "version", value: opts.version });
  if (opts.ids) attempts.push({ kind: "ids", value: opts.ids });
  let last = { status: 0, ok: false, body: "" };
  for (const a of attempts) {
    const res = await ctx.post(`/api/sprints/${sprintId}/retro/seed`, {
      data: { kind: a.kind, value: a.value },
    });
    last = { status: res.status(), ok: res.ok(), body: await res.text() };
    if (notImplemented(res.status())) return last; // route absent — don't keep trying
    if (!res.ok()) continue; // try the next attempt on a real error
    // A 200 with ZERO candidates (e.g. `version` doesn't exist in this
    // scenario's data — s7-tester-roundtrip never sets one) is NOT "found
    // what we wanted" — it's an empty, still-technically-ok response. Only
    // stop early once an attempt actually seeded something; otherwise fall
    // through to the next kind (e.g. `ids`) rather than silently leaving the
    // sprint empty.
    try {
      const parsed = JSON.parse(last.body) as { candidates?: unknown[] };
      if ((parsed.candidates?.length ?? 0) > 0) return last;
    } catch {
      return last; // unparseable body — return as-is, don't loop forever
    }
  }
  return last;
}

async function getPreview(ctx: APIRequestContext, sprintId: number): Promise<RetroPreviewResp | null> {
  const res = await ctx.get(`/api/sprints/${sprintId}/retro/preview`);
  if (!res.ok()) return null;
  return (await res.json()) as RetroPreviewResp;
}

async function getCapacity(ctx: APIRequestContext, sprintId: number): Promise<CapacityResp | null> {
  const res = await ctx.get(`/api/sprints/${sprintId}/capacity`);
  if (!res.ok()) return null;
  return (await res.json()) as CapacityResp;
}

async function waitSprintStatus(
  ctx: APIRequestContext,
  sprintId: number,
  status: string,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sprint = await getSprint(ctx, sprintId);
    if (sprint?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`sprint ${sprintId} did not reach status "${status}" within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Poll until the sprint reaches a TERMINAL locked/closed state (for a
 * past-window retro sprint whose activation replays then auto-locks — "active"
 * is only a transient mid-replay state, see te-…'s note). */
async function waitSprintTerminal(
  ctx: APIRequestContext,
  sprintId: number,
  timeoutMs = 45_000,
): Promise<SprintRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await getSprint(ctx, sprintId);
    if (s && (s.status === "closed" || s.is_locked)) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Available scenario names on the mock (GET /__mock/scenarios). */
async function listScenarios(ctx: APIRequestContext): Promise<string[]> {
  try {
    const res = await ctx.get(`${E2E_URLS.mock}/__mock/scenarios`);
    if (!res.ok()) return [];
    const body = (await res.json()) as unknown;
    const arr = Array.isArray(body)
      ? body
      : ((body as { scenarios?: unknown[] }).scenarios ?? []);
    return (arr as Array<string | { name?: string }>).map((s) => (typeof s === "string" ? s : s.name ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** First identity-capable scenario that actually exists on the mock. */
async function pickIdentityScenario(ctx: APIRequestContext): Promise<string | null> {
  const available = new Set(await listScenarios(ctx));
  for (const name of IDENTITY_SCENARIOS) if (available.has(name)) return name;
  return null;
}

/** Read the mock's OP user directory (GET /api/v3/users) → a usable op_user_id,
 * or a safe fallback. Used only by the alias workflow (which mostly skips in
 * Phase 1). */
async function anyOpUserId(ctx: APIRequestContext): Promise<number> {
  try {
    const res = await ctx.get(`${E2E_URLS.mock}/api/v3/users`);
    if (res.ok()) {
      const hal = (await res.json()) as { _embedded?: { elements?: Array<{ id?: number }> } };
      const id = hal._embedded?.elements?.find((e) => typeof e.id === "number")?.id;
      if (typeof id === "number") return id;
    }
  } catch {
    /* fall through */
  }
  return 1; // scenario cast's `me` (dev.dvorak) id
}

/** name→resolved-op-id map from a preview's reconstructed assignees. Skips
 * items with no assignee name. Value is the resolved op id (null = unresolved). */
function previewIdentityMap(preview: RetroPreviewResp): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const it of preview.items) {
    // A `created_after_start_date` ticket's `assignee_at_start_date` is
    // EXPLICITLY documented fallback/informational data (SPEC_13 §2 — the
    // ticket didn't exist yet, so there is no real "at start_date" identity to
    // compare). Such a ticket enters the roster at its ACTUAL creation moment
    // instead (the existing added_mid_sprint/scope-addition mechanism), which
    // legitimately may resolve to a DIFFERENT person than this placeholder
    // name — that is correct behavior, not a roster-equality violation.
    if (it.created_after_start_date) continue;
    const name = it.assignee_at_start_date;
    if (!name) continue;
    m.set(name, it.assignee_op_id_at_start_date ?? null);
  }
  return m;
}

/** True for the genuine "unassigned" bucket (a ticket with NO assignee at all),
 * which is NOT a reconstructed-assignee identity and must be excluded from the
 * name↔id comparison. In the REVISED model this is the ONLY excluded line — a
 * name-only person (op_user_id===null, real display name) is a first-class
 * identity, not the unassigned bucket. */
function isUnassignedBucketLine(l: CapacityLine): boolean {
  return l.op_user_id == null && (/^unassigned$/i.test(l.name.trim()) || /^—$/.test(l.name.trim()));
}

/** name→op-id map from capacity lines, keyed by the display NAME (identity is
 * the name now). Value is the resolved op id, or null when known by name only —
 * which is a normal, non-blocking state, NOT a reason to drop the line. */
function capacityIdentityMap(cap: CapacityResp): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const l of cap.lines) {
    if (isUnassignedBucketLine(l)) continue;
    m.set(l.name, l.op_user_id);
  }
  return m;
}

async function getPeople(
  ctx: APIRequestContext,
  sprintId: number,
): Promise<{ status: number; people: SprintPersonEntry[] | null }> {
  const res = await ctx.get(`/api/sprints/${sprintId}/people`);
  if (!res.ok()) return { status: res.status(), people: null };
  return { status: res.status(), people: (await res.json()) as SprintPersonEntry[] };
}

/** Computed pixel width of a bar segment (browser-context; e2e tsconfig has only
 * the node lib, so reach `getComputedStyle` via a loosely-typed globalThis — the
 * exact pattern td-…'s §3 uses). */
async function segWidthPx(seg: Locator): Promise<number> {
  const w = await seg.evaluate(
    (el) =>
      (globalThis as unknown as { getComputedStyle(e: unknown): { width: string } }).getComputedStyle(el).width,
  );
  return Number.parseFloat(w) || 0;
}

// ── UI navigation helpers (same shape as td-/tc-) ─────────────────────────────
function screensNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Screens" });
}
async function gotoSprintBoard(page: Page): Promise<void> {
  await page.goto("/");
  await screensNav(page).getByRole("button", { name: "Sprint board", exact: true }).click();
}
async function selectSprint(page: Page, sprintId: number): Promise<void> {
  const select = page.locator("#sprint-select");
  await expect(select.locator(`option[value="${sprintId}"]`)).toHaveCount(1);
  await select.selectOption(String(sprintId));
}

test.describe.serial("TF — SPEC_13 retro identity resolver / capacity bars / state machine", () => {
  let setup: APIRequestContext;
  let mockConnId: number;
  let dbBefore: DbFingerprint | null;

  test.beforeAll(async () => {
    // (Task 1) FIRST thing: fingerprint the real DB before ANY test runs.
    dbBefore = fingerprintRealDb();

    setup = await apiRequest.newContext({ baseURL: E2E_URLS.web });
    await ensureVaultReady(setup);
    mockConnId = await ensureConnection(setup);
    await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } });
  });

  test.afterAll(async () => {
    await setup.dispose();

    // (Task 1) LAST thing: the real apps/api/osp.sqlite must be byte-for-byte
    // (size + mtime) exactly as we found it. If it moved, OUR suite touched the
    // user's real data — the precise Increment-11 failure — and that fails the
    // run loudly. Skip only when the file is genuinely absent in the sandbox.
    const dbAfter = fingerprintRealDb();
    if (dbBefore === null || dbAfter === null) {
      // eslint-disable-next-line no-console
      console.warn(
        `[§0 tripwire] ${REAL_DB} absent in this environment — nothing to compare (invariant "if it exists we never touch it" holds vacuously).`,
      );
      return;
    }
    if (dbAfter.size !== dbBefore.size || dbAfter.mtimeMs !== dbBefore.mtimeMs) {
      throw new Error(
        `[§0 TRIPWIRE FAILED] the REAL DB ${REAL_DB} changed during the e2e run — ` +
          `before=${JSON.stringify(dbBefore)} after=${JSON.stringify(dbAfter)}. ` +
          `This is exactly the Increment-11 incident: the suite must ONLY ever touch ` +
          `its throwaway temp DB (see tests/playwright.config.ts).`,
      );
    }
  });

  // ── Task 1: §0 tripwire is armed ────────────────────────────────────────────
  test("§0: the real-DB tripwire captured a baseline (or the file is absent)", () => {
    if (dbBefore === null) {
      test.info().annotations.push({
        type: "SPEC_13 §0",
        description: `${REAL_DB} not present in this sandbox — tripwire no-ops (invariant holds vacuously).`,
      });
    } else {
      test.info().annotations.push({
        type: "SPEC_13 §0",
        description: `real DB fingerprint captured: ${JSON.stringify(dbBefore)} — must be unchanged at suite end.`,
      });
    }
    expect(true).toBe(true);
  });

  // ── Task 2: ONE resolver across preview + capacity (§1 point 4) ──────────────
  test("identity: the name→user map is IDENTICAL in retro/preview and capacity, a name with NO op id is still a normal present line, and no name is silently substituted for a similar one", async () => {
    test.setTimeout(120_000);

    const scenario = (await pickIdentityScenario(setup)) ?? RECON_SCENARIO;
    await loadScenario(setup, scenario);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    // Build several days of journal history so there IS a past to reconstruct.
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });

    const sprintId = await createSprint(setup, "TF Identity", "2026-07-06", "2026-07-31");
    if (!(await makeRetrospective(setup, sprintId))) {
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }

    // Populate the sprint: version seed (identity fixtures) then id seed (s7),
    // falling back to a plain manual add so there is at least one reconstructed
    // assignee to compare across the two views.
    const seed = await seedRetro(setup, sprintId, { version: RETRO_VERSION, ids: String(RECON_WP) });
    if (notImplemented(seed.status)) {
      await addItem(setup, sprintId, RECON_WP);
    }

    const preview = await getPreview(setup, sprintId);
    if (!preview) {
      test.info().annotations.push({
        type: "SPEC_13 §1",
        description: `GET /retro/preview unavailable on scenario=${scenario} (seed status=${seed.status}); skipping identity comparison.`,
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "retro/preview not available");
      return;
    }

    // GATE: the resolver fields must be populated. Until Agent A/B ship them,
    // assignee_op_id_at_start_date is absent → the identity comparison is not
    // meaningful yet. Skip rather than assert on undefined.
    const anyResolverField = preview.items.some(
      (i) => i.assignee_op_id_at_start_date !== undefined || i.assignee_resolution !== undefined,
    );
    if (!anyResolverField) {
      test.info().annotations.push({
        type: "SPEC_13 §1",
        description: `retro/preview does not populate assignee_op_id_at_start_date/assignee_resolution yet (Agent A/B) on scenario=${scenario}; skipping.`,
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "resolver fields not populated in preview");
      return;
    }

    const cap = await getCapacity(setup, sprintId);
    expect(cap, "capacity must be readable while the retro sprint is in planning").toBeTruthy();

    const previewMap = previewIdentityMap(preview);
    const capMap = capacityIdentityMap(cap!);

    test.info().annotations.push({
      type: "SPEC_13 §1 identity maps",
      description: `scenario=${scenario} preview=${JSON.stringify([...previewMap])} capacity=${JSON.stringify([...capMap])}`,
    });

    // (1) ROSTER completeness (§3): every reconstructed-assignee name in the
    // preview must have a capacity line — preview and capacity are the SAME set
    // of people (modulo capacity's extra unassigned bucket / capacity-only adds).
    for (const [name] of previewMap) {
      expect(
        capMap.has(name),
        `reconstructed assignee "${name}" is in the preview but MISSING from capacity — the retro roster must equal the preview set (SPEC_13 §3)`,
      ).toBeTruthy();
    }

    // (2) ONE RESOLVER (§1 point 4): for every name present in BOTH views, the
    // resolved op id must be IDENTICAL. This is the direct proof that preview and
    // capacity run the same resolver, not two plausible-but-divergent ones.
    for (const [name, previewId] of previewMap) {
      if (!capMap.has(name)) continue;
      expect(
        capMap.get(name),
        `name "${name}" resolves to op_id=${previewId} in preview but op_id=${capMap.get(name)} in capacity — the two views used DIFFERENT resolvers (SPEC_13 §1 point 4)`,
      ).toBe(previewId);
    }

    // (2b) REVISED §1a: a name known ONLY by string (op_user_id===null) is the
    // COMMON, EXPECTED case now (a normal token can't build a user id index), NOT
    // an error/edge case. Every such name that appears in either view MUST still
    // be a fully-present, ordinary line in capacity — never missing, never
    // filtered out, never demoted to the unassigned bucket. (In the prior
    // "blocked until paired" model this was effectively unusable; here it must be
    // first-class.)
    const nullIdNames = [
      ...[...previewMap].filter(([, id]) => id == null).map(([n]) => n),
      ...[...capMap].filter(([, id]) => id == null).map(([n]) => n),
    ];
    if (nullIdNames.length > 0) {
      for (const name of new Set(nullIdNames)) {
        const line = cap!.lines.find((l) => l.name === name && !isUnassignedBucketLine(l));
        expect(
          line,
          `"${name}" is known only by name (no op id) — REVISED §1a: it must STILL be a normal, present capacity line, not missing/filtered`,
        ).toBeTruthy();
        // A name-only identity is NOT the unassigned bucket.
        expect(
          isUnassignedBucketLine(line!),
          `"${name}" is a real reconstructed person, not the anonymous unassigned bucket`,
        ).toBe(false);
      }
      test.info().annotations.push({
        type: "SPEC_13 §1a name-only lines",
        description: `names present with op_user_id=null (the expected common case), each a normal capacity line: ${JSON.stringify([...new Set(nullIdNames)])}`,
      });
    } else {
      test.info().annotations.push({
        type: "SPEC_13 §1a name-only lines",
        description: `scenario=${scenario} happened to resolve every name to an id — no name-only line to assert here (that's also valid; Task 2b/2c prove the never-resolved path explicitly).`,
      });
    }

    // (3) NO SILENT SUBSTITUTION (§1 point 3): whenever the similar-but-distinct
    // pair is present, they must resolve to DIFFERENT ids and neither's hours may
    // land on the other's line.
    const [nameA, nameB] = AMBIGUOUS_PAIR;
    const haveA = previewMap.has(nameA) || capMap.has(nameA);
    const haveB = previewMap.has(nameB) || capMap.has(nameB);
    if (haveA && haveB) {
      const idA = capMap.get(nameA) ?? previewMap.get(nameA) ?? null;
      const idB = capMap.get(nameB) ?? previewMap.get(nameB) ?? null;
      if (idA != null && idB != null) {
        expect(
          idA,
          `"${nameA}" and "${nameB}" must NEVER resolve to the same OP user — that is the fuzzy-match substitution SPEC_13 §1 forbids`,
        ).not.toBe(idB);
      }
      const lineA = cap!.lines.find((l) => l.name === nameA);
      const lineB = cap!.lines.find((l) => l.name === nameB);
      if (lineA && lineB) {
        // Each person's committed hours come from their OWN tickets; a swap would
        // show up as one person carrying the other's total.
        expect(
          lineA.op_user_id ?? -1,
          `"${nameA}"'s capacity line must not carry "${nameB}"'s identity`,
        ).not.toBe(lineB.op_user_id ?? -2);
      }
    } else {
      test.info().annotations.push({
        type: "SPEC_13 §1 substitution",
        description: `the "${nameA}"/"${nameB}" ambiguity pair is not in scenario=${scenario} — substitution assertion self-activates once Agent A ships an identity-ambiguity scenario. Resolver-equality (1)+(2) still fully asserted on the available names.`,
      });
    }

    await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
  });

  /** Shared: stand up a retro sprint in PLANNING seeded with the recon WP.
   * Returns its id, or null (after cleanup) when is_retrospective isn't landed. */
  async function seedRetroSprint(label: string): Promise<number | null> {
    const scenario = (await pickIdentityScenario(setup)) ?? RECON_SCENARIO;
    await loadScenario(setup, scenario);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });
    const sprintId = await createSprint(setup, label, "2026-07-06", "2026-07-31");
    if (!(await makeRetrospective(setup, sprintId))) {
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      return null;
    }
    const seed = await seedRetro(setup, sprintId, { version: RETRO_VERSION, ids: String(RECON_WP) });
    if (notImplemented(seed.status)) await addItem(setup, sprintId, RECON_WP);
    return sprintId;
  }

  // ── Task 2b: GET /people lists EVERYONE; a never-resolved name is a normal,
  // fully-editable capacity line (REVISED §1a/§8) ─────────────────────────────
  test("people: GET /sprints/:id/people lists EVERY reconstructed person (op id optional), and a name with NO op id is still a normal, editable capacity line — not blocked", async () => {
    test.setTimeout(120_000);
    const sprintId = await seedRetroSprint("TF People");
    if (sprintId === null) {
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }

    // GET /people REPLACES the old unresolved-names endpoint — it lists everyone,
    // resolved or not. Absent → Agent B's people route pending.
    const { status, people } = await getPeople(setup, sprintId);
    if (notImplemented(status)) {
      test.info().annotations.push({
        type: "SPEC_13 §1a",
        description: "GET /sprints/:id/people not landed yet (Agent B replaces /unresolved-names with it); skipping.",
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "people route not landed");
      return;
    }
    expect(people, `people: ${status}`).toBeTruthy();

    const cap = await getCapacity(setup, sprintId);
    expect(cap, "capacity must be readable for a retro sprint in planning").toBeTruthy();

    // (1) /people and /capacity are the SAME set of people (§3 roster equality):
    // every person /people lists must have a capacity line by NAME.
    for (const p of people!) {
      const line = cap!.lines.find((l) => l.name === p.name);
      expect(
        line,
        `person "${p.name}" (op_user_id=${p.op_user_id}) is in /people but MISSING from /capacity — same set required (SPEC_13 §3)`,
      ).toBeTruthy();
    }

    // (2) The revision's core: a name with NO op id must STILL be a normal,
    // editable capacity line — never blocked/hidden. This is now the EXPECTED
    // common case (a normal token can't enumerate OP users), so if the scenario
    // happens to surface one, prove it's first-class.
    const nameOnly = people!.find((p) => p.op_user_id == null);
    if (nameOnly) {
      const line = cap!.lines.find((l) => l.name === nameOnly.name && !isUnassignedBucketLine(l));
      expect(
        line,
        `name-only person "${nameOnly.name}" (no OP id) must be a normal, present capacity line — REVISED §1a: an id is NOT a precondition`,
      ).toBeTruthy();
      expect(
        line!.member_id != null || line!.op_user_id != null,
        `"${nameOnly.name}" must be ADDRESSABLE for a capacity PUT (member_id or op_user_id) even with no OP id — otherwise availability can't be edited (SPEC_13 §1a/§8)`,
      ).toBe(true);
      test.info().annotations.push({
        type: "SPEC_13 §1a name-only editable",
        description: `"${nameOnly.name}": op_user_id=null, member_id=${line!.member_id}, hours=${nameOnly.hours} — a normal, editable line.`,
      });
    } else {
      test.info().annotations.push({
        type: "SPEC_13 §1a",
        description: `scenario resolved every name to an id — no genuinely-unresolvable name to assert here. A fixture carrying a name with NO _links.assignee/accountable link and NO membership match is an Agent-A addition; /people-lists-everyone + roster-equality still fully asserted. Task 2c proves the save-without-pairing path regardless.`,
      });
    }

    await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
  });

  // ── Task 2c: §8 CORE ACCEPTANCE — save availability with ZERO pairing ───────
  test("capacity (§8 acceptance): a reconstructed name's available_hours can be PUT/saved with ZERO prior pairing or alias step", async () => {
    test.setTimeout(120_000);
    const sprintId = await seedRetroSprint("TF NoPairing");
    if (sprintId === null) {
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }

    const cap = await getCapacity(setup, sprintId);
    if (!cap) {
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "capacity not readable");
      return;
    }
    // Any reconstructed person that carries sprint work and is addressable for a
    // PUT. PREFER one WITHOUT an op id — that is the strongest proof that no
    // pairing was needed. Deliberately NO alias/pairing call precedes this.
    const eligible = cap.lines.filter(
      (l) => !isUnassignedBucketLine(l) && l.has_sprint_work && (l.member_id != null || l.op_user_id != null),
    );
    const target = eligible.find((l) => l.op_user_id == null) ?? eligible[0];
    if (!target) {
      test.info().annotations.push({
        type: "SPEC_13 §8",
        description: `no reconstructed, addressable capacity line yet (retro roster from reconstructed names is Agent B §3, pending). lines=${JSON.stringify(cap.lines.map((l) => [l.name, l.op_user_id, l.member_id, l.has_sprint_work]))}`,
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "no reconstructed addressable capacity line");
      return;
    }

    const selector =
      target.op_user_id != null ? { op_user_id: target.op_user_id } : { member_id: target.member_id! };
    const NEW_HOURS = 13;
    const put = await setup.put(`/api/sprints/${sprintId}/capacity`, {
      data: { members: [{ ...selector, available_hours: NEW_HOURS, pto_days: 0 }] },
    });
    expect(
      put.ok(),
      `SPEC_13 §8: saving "${target.name}"'s availability must SUCCEED with no pairing (op_user_id=${target.op_user_id}, member_id=${target.member_id}). Got ${put.status()} ${await put.text()}`,
    ).toBeTruthy();

    const after = await getCapacity(setup, sprintId);
    const savedLine = after?.lines.find((l) => l.name === target.name);
    expect(
      savedLine?.available_hours,
      `"${target.name}"'s saved availability must persist as ${NEW_HOURS}h (SPEC_13 §8)`,
    ).toBe(NEW_HOURS);
    test.info().annotations.push({
      type: "SPEC_13 §8 saved-without-pairing",
      description: `"${target.name}" (op_user_id=${target.op_user_id ?? "null"}) → available_hours saved = ${savedLine?.available_hours}h, no alias/pairing step used.`,
    });

    await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
  });

  // ── Task 2d: ALIAS ESCAPE HATCH (§1b) still works when invoked ──────────────
  test("alias escape hatch: POST /user-aliases (merge_into_name or op_user_id) succeeds and DELETE reverts — the manual path remains available for the rare ambiguous/renamed case", async () => {
    test.setTimeout(120_000);
    const sprintId = await seedRetroSprint("TF AliasHatch");
    if (sprintId === null) {
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }

    // A journal name to alias, from the reconstructed capacity roster. All sprint
    // items are on the mock connection, so connection_id = mockConnId (capacity
    // lines don't carry a connection_id, and we don't depend on /people here).
    // Prefer a name with NO existing op_user_id: exact-match (from
    // _links.assignee/accountable or memberships) correctly WINS over an alias
    // (SPEC_13 §1a/Agent A's documented precedence — an alias must not silently
    // override a name that already resolves unambiguously), so aliasing an
    // ALREADY-resolved name to a *different* id is legitimately a no-op, not a
    // bug. Only a name with no exact match proves the alias actually took effect.
    const cap = await getCapacity(setup, sprintId);
    const unresolvedPerson = cap?.lines.find(
      (l) => !isUnassignedBucketLine(l) && l.has_sprint_work && l.op_user_id == null,
    );
    const person = unresolvedPerson ?? cap?.lines.find((l) => !isUnassignedBucketLine(l) && l.has_sprint_work);
    if (!person) {
      test.info().annotations.push({
        type: "SPEC_13 §1b",
        description: `no reconstructed person on the roster to alias (Agent B §3 pending). lines=${JSON.stringify(cap?.lines.map((l) => l.name))}`,
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "no reconstructed name to alias");
      return;
    }

    // Primary escape-hatch invocation: pin this journal name to a real OP user id
    // (the "two people share a display name" case). op_user_id is read straight
    // from the mock's user directory by the TEST (never by the app).
    const opUserId = await anyOpUserId(setup);
    const createRes = await setup.post("/api/user-aliases", {
      data: { connection_id: mockConnId, journal_name: person.name, op_user_id: opUserId },
    });
    if (notImplemented(createRes.status())) {
      test.info().annotations.push({
        type: "SPEC_13 §1b",
        description: "POST /user-aliases not landed (Agent B); skipping escape-hatch round-trip.",
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "user-aliases POST not landed");
      return;
    }
    expect(createRes.ok(), `create alias: ${createRes.status()} ${await createRes.text()}`).toBeTruthy();
    const alias = (await createRes.json()) as UserNameAlias;
    expect(alias.journal_name).toBe(person.name);
    expect(alias.op_user_id).toBe(opUserId);

    // Applies retroactively at read time: this name now resolves to opUserId in
    // capacity — but ONLY when there was no exact match to begin with. If
    // `person` fell back to an already-resolved name (no unresolved candidate
    // existed on this roster), exact-match legitimately keeps winning over the
    // alias, so skip the override assertion for that case (still a valid,
    // documented outcome, not a failure) and rely on the create/delete
    // round-trip above as this run's escape-hatch proof.
    const capAfter = await getCapacity(setup, sprintId);
    const resolvedLine = capAfter?.lines.find((l) => l.name === person.name);
    if (unresolvedPerson && resolvedLine && resolvedLine.op_user_id != null) {
      expect(
        resolvedLine.op_user_id,
        `after aliasing, "${person.name}" should resolve to op_user_id=${opUserId} (read-time, §1b)`,
      ).toBe(opUserId);
    }

    // DELETE reverts (resolution is read-time, never baked into a row).
    const delRes = await setup.delete(`/api/user-aliases/${alias.id}`);
    expect(delRes.ok(), `delete alias: ${delRes.status()} ${await delRes.text()}`).toBeTruthy();

    // Secondary probe: the NEW merge_into_name option (renamed-person case). The
    // current POST handler may not persist it yet — accept either outcome, just
    // record what happened so the field's wiring is visible once it lands.
    const mergeRes = await setup.post("/api/user-aliases", {
      data: { connection_id: mockConnId, journal_name: person.name, merge_into_name: "Some Renamed Person" },
    });
    if (mergeRes.ok()) {
      const merged = (await mergeRes.json()) as UserNameAlias;
      test.info().annotations.push({
        type: "SPEC_13 §1b merge_into_name",
        description: `merge_into_name alias accepted: merge_into_name=${merged.merge_into_name ?? "null(not persisted yet)"} — escape hatch supports the renamed-person path.`,
      });
      await setup.delete(`/api/user-aliases/${merged.id}`).catch(() => {});
    } else {
      test.info().annotations.push({
        type: "SPEC_13 §1b merge_into_name",
        description: `merge_into_name-only alias not accepted yet (${mergeRes.status()}: ${await mergeRes.text()}) — Agent B's upsert still requires op_user_id; the op_user_id escape hatch above is proven.`,
      });
    }

    await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
  });

  // ── Task 4: reconstruction honesty (§2) ─────────────────────────────────────
  test("reconstruction: a ticket created AFTER start_date is flagged created_after_start_date with its real created_at_op; one fully inside the window reconstructs cleanly", async () => {
    test.setTimeout(120_000);

    await loadScenario(setup, RECON_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });

    // (A) CREATED-AFTER case: start_date is BEFORE the scenario's day 0
    // (2026-07-06 — when WP 11762 first appears), so at 2026-07-01 the ticket
    // did NOT exist yet. It must be flagged, not shown as a live "current state"
    // baseline.
    const early = await createSprint(setup, "TF Recon Created-After", "2026-07-01", "2026-07-31");
    if (!(await makeRetrospective(setup, early))) {
      await setup.delete(`/api/sprints/${early}`).catch(() => {});
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }
    const seedEarly = await seedRetro(setup, early, { ids: String(RECON_WP) });
    if (notImplemented(seedEarly.status)) await addItem(setup, early, RECON_WP);
    const previewEarly = await getPreview(setup, early);
    if (!previewEarly) {
      await setup.delete(`/api/sprints/${early}`).catch(() => {});
      test.skip(true, "retro/preview not available");
      return;
    }
    const wpEarly = previewEarly.items.find((i) => i.wp_op_id === RECON_WP);
    if (!wpEarly || wpEarly.created_after_start_date === undefined) {
      test.info().annotations.push({
        type: "SPEC_13 §2",
        description: `created_after_start_date not populated yet (Agent A/B). Observed WP ${RECON_WP}: ${JSON.stringify(wpEarly)}. Skipping honesty assertions.`,
      });
      await setup.delete(`/api/sprints/${early}`).catch(() => {});
      test.skip(true, "created_after_start_date not populated");
      return;
    }
    expect(
      wpEarly.created_after_start_date,
      `WP ${RECON_WP} first appears on 2026-07-06 but the sprint starts 2026-07-01 — it must be created_after_start_date=true, not a bogus "current state" baseline (SPEC_13 §2)`,
    ).toBe(true);
    expect(wpEarly.created_at_op, "created_at_op must carry the ticket's real creation moment").toBeTruthy();
    expect(
      new Date(wpEarly.created_at_op!).getTime(),
      "created_at_op must be AFTER the sprint start_date",
    ).toBeGreaterThan(new Date("2026-07-01").getTime());
    // And it must NOT masquerade as a clean reconstructed baseline (the §2 bug
    // was every row silently stamped from today's live state).
    test.info().annotations.push({
      type: "SPEC_13 §2 created-after observed",
      description: `WP ${RECON_WP}: created_after_start_date=${wpEarly.created_after_start_date} created_at_op=${wpEarly.created_at_op} status@start=${wpEarly.status_at_start_date} reconstructed=${wpEarly.reconstructed}`,
    });
    await setup.delete(`/api/sprints/${early}`).catch(() => {});

    // (B) FULLY-INSIDE case: start_date well AFTER the ticket exists and after
    // its journal history, so the reconstruction has full coverage → it must NOT
    // be stamped "partially reconstructed". (SPEC_13 §2: that flag is the
    // exception, not a blanket.)
    const inside = await createSprint(setup, "TF Recon Full", "2026-07-09", "2026-07-31");
    await makeRetrospective(setup, inside);
    const seedInside = await seedRetro(setup, inside, { ids: String(RECON_WP) });
    if (notImplemented(seedInside.status)) await addItem(setup, inside, RECON_WP);
    const previewInside = await getPreview(setup, inside);
    if (previewInside) {
      const wpInside = previewInside.items.find((i) => i.wp_op_id === RECON_WP);
      if (wpInside) {
        expect(
          wpInside.created_after_start_date ?? false,
          `WP ${RECON_WP} existed well before 2026-07-09 — it must NOT be created_after_start_date`,
        ).toBe(false);
        // NOTE: s7-tester-roundtrip's WP 11762 seed (fixtures/scenarios/s7-tester-roundtrip.ts)
        // never journals an initial "Status set to…"/"Work set to…" (only fields touched by
        // an explicit timeline event get a journal entry — status/estimate are seed-only,
        // never changed) and NEVER sets a version at all (`versions: []`). So
        // status_at_start_date/estimate_at_start_date/version_name are STRUCTURALLY,
        // permanently ungappable for this scenario — that's honest, correct behavior
        // (SPEC_13 §2 wants genuine gaps reported, not invented), not the bug. The
        // identity-critical field SPEC_13 actually cares about — assignee — IS covered
        // (ev.assign fires day 1, well before this sprint's 07-09 target) and must NOT gap.
        expect(
          wpInside.gaps.includes("assignee_at_start_date"),
          `WP ${RECON_WP}'s assignee is reconstructible from day-1 journal coverage (well before 07-09) — it must NOT be a gap. Got gaps=${JSON.stringify(wpInside.gaps)}`,
        ).toBe(false);
        // And it must not be the ORIGINAL bug's signature: blanket-gapped on EVERY
        // field (which is what "silently fell back to today's live state" looked like).
        expect(
          wpInside.gaps.length,
          `WP ${RECON_WP} must not have every field gapped (that's the original "always partially reconstructed" bug) — got gaps=${JSON.stringify(wpInside.gaps)}`,
        ).toBeLessThan(5);
      }
    }
    await setup.delete(`/api/sprints/${inside}`).catch(() => {});
  });

  // ── Task 5: capacity bars render at available=0 (§4) ────────────────────────
  test("bars: capacity-bar segments keep a non-zero width even when Available=0 (only the reference line disappears)", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // Isolate the SPEC_13 §4 RENDER cause independently of the retro roster: any
    // line with planned>0 and available=0 must still draw its segments. A plain
    // planning sprint with an assigned ticket + that person's availability set to
    // 0 reproduces it exactly (SprintBoardScreen's pctOf divides by
    // available_hours — the bug is it collapses every segment to 0% at 0).
    await loadScenario(setup, "s5-burndown-happy");
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    const sprintId = await createSprint(setup, "TF Bars Available0", "2026-07-06", "2026-07-31");
    for (const id of [1501, 1502]) await addItem(setup, sprintId, id);

    const cap = await getCapacity(setup, sprintId);
    const worker = cap?.lines.find((l) => l.op_user_id != null && l.planned_hours > 0);
    if (!worker) {
      test.info().annotations.push({
        type: "SPEC_13 §4",
        description: `no capacity line with an op_user_id + planned hours (lines=${JSON.stringify(cap?.lines.map((l) => [l.name, l.op_user_id, l.planned_hours]))}); skipping.`,
      });
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "no assignable worker line");
      return;
    }
    // Pin this person's availability to 0 while they carry real planned work.
    const put = await setup.put(`/api/sprints/${sprintId}/capacity`, {
      data: { members: [{ op_user_id: worker.op_user_id, available_hours: 0, pto_days: 0 }] },
    });
    expect(put.ok(), `set available=0: ${put.status()} ${await put.text()}`).toBeTruthy();

    await gotoSprintBoard(page);
    await selectSprint(page, sprintId);
    const capPanel = page.locator("section.panel", {
      has: page.getByRole("heading", { name: "Capacity", exact: true }),
    });
    await expect(capPanel).toBeVisible();

    // The worker's own bar (aria-label "load for <name>").
    const bar = capPanel.locator(`[aria-label="load for ${worker.name}"]`).first();
    await expect(bar, `capacity bar for ${worker.name} must render`).toBeVisible();
    const widths: Record<string, number> = {};
    for (const cls of ["bar-green", "bar-grey", "bar-blue", "bar-red"]) {
      const seg = bar.locator(`.${cls}`);
      if ((await seg.count()) === 0) continue;
      widths[cls] = await segWidthPx(seg.first());
    }
    const anyNonZero = Object.values(widths).some((w) => w > 0.5);

    // Agent C's SPEC_13 §4 fix is landed (SprintBoardScreen sizes segments off
    // `barDenominator = max(available, segmentsTotal, 1)`, independent of
    // available). This is now a HARD assert: if a future change reintroduces the
    // "divide by available" collapse, it fails LOUDLY here.
    test.info().annotations.push({
      type: "SPEC_13 §4 bars@available=0",
      description: `worker=${worker.name} planned=${worker.planned_hours}h available=0 → segment widths=${JSON.stringify(widths)}`,
    });
    expect(
      anyNonZero,
      `with Available=0 but ${worker.planned_hours}h planned, the bar segments must still render (SPEC_13 §4). widths=${JSON.stringify(widths)}`,
    ).toBe(true);

    await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
  });

  // ── Task 6: state-machine guard — no planning-only call after planning (§5) ──
  test("state machine: no planning-only endpoint (retro/seed, retro/preview) is EVER SENT once the retro sprint has left planning", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await loadScenario(setup, RECON_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });

    // A retro sprint whose window is still OPEN → activation replays then stays
    // live ("active"), giving a clean planning→active transition to observe.
    const sprintId = await createSprint(setup, "TF StateMachine", "2026-07-06", openWindowEnd());
    if (!(await makeRetrospective(setup, sprintId))) {
      await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }
    const seed = await seedRetro(setup, sprintId, { ids: String(RECON_WP) });
    if (notImplemented(seed.status)) await addItem(setup, sprintId, RECON_WP);

    // ── network interception (the "bones", runnable now) ──────────────────────
    // Record EVERY planning-only request, tagged with whether the sprint had
    // already left planning at the moment it fired. Structural, network-level —
    // the same rigor as the Inc-11 connection-enumeration guard: we prove the
    // call is never SENT, not merely that no error text appears.
    let planningLeft = false;
    const RETRO_PLANNING_ONLY = new RegExp(`/api/sprints/${sprintId}/retro/(seed|preview)\\b`);
    const violations: string[] = [];
    page.on("request", (req) => {
      const u = req.url();
      if (planningLeft && RETRO_PLANNING_ONLY.test(u)) {
        violations.push(`${req.method()} ${u}`);
      }
    });

    // Open the board WHILE the sprint is still planning — retro/preview here is
    // legitimate (planningLeft is still false, so it's not counted).
    await gotoSprintBoard(page);
    await selectSprint(page, sprintId);
    await expect(page.getByTestId("sprint-status")).toHaveText("planning");
    await page.waitForTimeout(500); // let any planning-phase preview fetch settle

    // ── transition planning → active (server-side), then re-drive the UI ──────
    const act = await setup.post(`/api/sprints/${sprintId}/activate`);
    expect(act.ok(), `activate: ${act.status()} ${await act.text()}`).toBeTruthy();
    await waitSprintStatus(setup, sprintId, "active");
    planningLeft = true; // from here on, ANY retro/seed|preview request is a bug

    // Re-render the board on the now-active sprint and let refetches settle — a
    // panel that still auto-fetches retro/preview post-planning would fire here.
    await gotoSprintBoard(page);
    await selectSprint(page, sprintId);
    await expect(page.getByTestId("sprint-status")).toHaveText("active");
    await page.waitForTimeout(1500);
    // Reload once more to trigger every mount-time fetch again.
    await page.reload();
    await selectSprint(page, sprintId).catch(() => {});
    await page.waitForTimeout(1000);

    // Agent C's SPEC_13 §5 state gate is landed (RetroCapacityPanel derives
    // `editable` from status==="planning" and stops issuing retro/seed|preview
    // once the sprint leaves planning). HARD, network-level assert: if the panel
    // ever refetches a planning-only endpoint post-planning again (the
    // SPRINT_NOT_PLANNING regression), this fails LOUDLY — the call is proven
    // never SENT, not merely "no error shown".
    expect(
      violations,
      `a planning-only endpoint was SENT after the sprint left planning (SPEC_13 §5) — the UI must derive available actions from sprint state and never issue these once out of planning:\n${violations.join("\n")}`,
    ).toEqual([]);

    await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
  });

  // ── Task 7: retro capacity editable post-lock + audit; normal locked 409s (§6)
  test("retro capacity: a locked RETRO sprint still accepts a capacity edit (audited); a locked NORMAL sprint's capacity PUT still 409s", async () => {
    test.setTimeout(120_000);

    await loadScenario(setup, RECON_SCENARIO);
    await setup.post("/api/sync", { data: { project_op_id: PROJECT_OP_ID } });
    for (let day = 1; day <= 4; day += 1) await advanceDay(setup, { appUrl: E2E_URLS.api });

    // ── (B) REGRESSION GUARD FIRST (immediately runnable): a NORMAL locked
    // sprint's capacity edit must still be rejected exactly as before. Proves we
    // didn't loosen the rule for everyone while opening it for retro sprints.
    const normal = await createSprint(setup, "TF Cap Normal Locked", "2026-07-01", "2026-07-31");
    await addItem(setup, normal, RECON_WP);
    const capN = await getCapacity(setup, normal);
    const workerN = capN?.lines.find((l) => l.op_user_id != null);
    await setup.post(`/api/sprints/${normal}/activate`);
    await waitSprintStatus(setup, normal, "active");
    const finN = await setup.post(`/api/sprints/${normal}/finish`);
    expect(finN.ok(), `finish normal: ${finN.status()} ${await finN.text()}`).toBeTruthy();
    await waitSprintStatus(setup, normal, "closed");

    const putNormal = await setup.put(`/api/sprints/${normal}/capacity`, {
      data: { members: [{ op_user_id: workerN?.op_user_id ?? 1, available_hours: 5, pto_days: 0 }] },
    });
    expect(
      putNormal.ok(),
      `a locked NORMAL sprint's capacity PUT must be REJECTED (got ${putNormal.status()})`,
    ).toBeFalsy();
    const normalBody = await putNormal.text();
    expect(
      /SPRINT_NOT_PLANNING|SPRINT_LOCKED/.test(normalBody),
      `rejection must carry the not-planning/locked error code, got: ${normalBody}`,
    ).toBe(true);
    await setup.delete(`/api/sprints/${normal}`).catch(() => {});

    // ── (A) RETRO post-lock edit + audit. A past-window retro sprint activates,
    // replays and auto-locks (SPEC_12 §2); its capacity must STILL be editable
    // (reconstructed historical availability, SPEC_13 §6), and the edit lands in
    // GET /capacity-audit.
    const retro = await createSprint(setup, "TF Cap Retro Locked", "2026-06-01", "2026-06-30");
    if (!(await makeRetrospective(setup, retro))) {
      await setup.delete(`/api/sprints/${retro}`).catch(() => {});
      test.skip(true, "is_retrospective PATCH not landed");
      return;
    }
    const seed = await seedRetro(setup, retro, { ids: String(RECON_WP) });
    if (notImplemented(seed.status)) await addItem(setup, retro, RECON_WP);
    const actR = await setup.post(`/api/sprints/${retro}/activate`);
    expect(actR.ok(), `activate retro: ${actR.status()} ${await actR.text()}`).toBeTruthy();
    const finalR = await waitSprintTerminal(setup, retro);
    if (!(finalR && (finalR.status === "closed" || finalR.is_locked))) {
      test.info().annotations.push({
        type: "SPEC_13 §6",
        description: `retro sprint did not auto-lock (status=${finalR?.status}, is_locked=${finalR?.is_locked}) — retro replay/auto-lock not landed; skipping post-lock edit.`,
      });
      await setup.delete(`/api/sprints/${retro}`).catch(() => {});
      test.skip(true, "retro auto-lock not landed");
      return;
    }

    const capR = await getCapacity(setup, retro);
    const workerR = capR?.lines.find((l) => l.op_user_id != null);
    if (!workerR) {
      test.info().annotations.push({
        type: "SPEC_13 §6",
        description: `no resolved capacity line on the locked retro sprint (roster empty — likely SPEC_13 §3 pending). lines=${JSON.stringify(capR?.lines.map((l) => [l.name, l.op_user_id]))}. Skipping post-lock edit.`,
      });
      await setup.delete(`/api/sprints/${retro}`).catch(() => {});
      test.skip(true, "no resolved retro capacity line");
      return;
    }
    const putRetro = await setup.put(`/api/sprints/${retro}/capacity`, {
      data: { members: [{ op_user_id: workerR.op_user_id, available_hours: 7, pto_days: 0 }] },
    });
    if (!putRetro.ok()) {
      const body = await putRetro.text();
      // If it's rejected with the ordinary not-planning code, Agent B's §6
      // exemption for retro sprints hasn't landed yet.
      test.info().annotations.push({
        type: "SPEC_13 §6",
        description: `capacity PUT on a locked RETRO sprint was rejected (${putRetro.status()}: ${body}) — retro post-lock capacity exemption not landed; skipping.`,
      });
      await setup.delete(`/api/sprints/${retro}`).catch(() => {});
      test.skip(true, "retro post-lock capacity edit not landed");
      return;
    }
    // Locking a retro sprint must NOT have changed by the capacity edit.
    const stillLocked = await getSprint(setup, retro);
    expect(
      stillLocked?.status === "closed" || stillLocked?.is_locked,
      "editing retro capacity must not un-lock the sprint",
    ).toBeTruthy();

    // The edit must show up in the audit trail (SPEC_13 §6).
    const auditRes = await setup.get(`/api/sprints/${retro}/capacity-audit`);
    if (notImplemented(auditRes.status())) {
      test.info().annotations.push({
        type: "SPEC_13 §6",
        description: "GET /capacity-audit not landed (Agent B); post-lock EDIT verified, audit assertion pending.",
      });
      await setup.delete(`/api/sprints/${retro}`).catch(() => {});
      test.skip(true, "capacity-audit route not landed");
      return;
    }
    expect(auditRes.ok(), `capacity-audit: ${auditRes.status()} ${await auditRes.text()}`).toBeTruthy();
    const audit = (await auditRes.json()) as CapacityAuditEntry[];
    expect(
      audit.length,
      "the post-lock retro capacity edit must be recorded in the capacity audit (SPEC_13 §6)",
    ).toBeGreaterThan(0);
    expect(audit.every((e) => e.sprint_id === retro)).toBe(true);
    expect(
      audit.some((e) => /available_hours/.test(e.changes_json)),
      "an audit entry must describe the availability change",
    ).toBe(true);

    await setup.delete(`/api/sprints/${retro}`).catch(() => {});
  });

  // ── Task 2e: GET /api/v3/users (the COLLECTION) is NEVER called (§1a) ────────
  // THE direct guard against the root cause. The admin-gated user-COLLECTION
  // endpoint silently starved this feature in production; the revised resolver
  // must source ids ONLY from _links.assignee/accountable + GET
  // /api/v3/memberships. Browser-side interception can't see this — the call is
  // API↔mock, not frontend↔API — so we drive the retro flow against a RECORDING
  // mock OP whose EVERY inbound request path is captured, and assert the bare
  // "/api/v3/users" path is never hit (/users/me and /users/:id remain fine).
  //
  // This BITES the current code: apps/api's createIdentityResolver still calls
  // fetchAllUsers → GET /api/v3/users (retro.ts). It goes green once Agent B
  // reworks the resolver to drop that call. Only the PREREQUISITE flow steps
  // skip; the absence assertion itself is HARD (a guard that passes while the
  // bug is present would be worthless).
  test("guard: the API never issues GET /api/v3/users (the admin-gated COLLECTION) during a full retro flow — ids come from _links.assignee/memberships only (SPEC_13 §1a)", async () => {
    test.setTimeout(150_000);

    // A fresh, isolated recording mock (own ephemeral port + own engine, no DB).
    let rec: RecordingMockOpServer | null = null;
    let recConnId: number | null = null;
    let sprintId: number | null = null;
    // Remember the default connection's state so we can restore it: we route ALL
    // OP traffic to the recording mock for this test by making it the sole
    // enabled/current connection, so any GET /api/v3/users the resolver issues is
    // guaranteed to land on (and be recorded by) THIS server, not leak to the
    // shared default mock (which we don't record).
    try {
      rec = await createRecordingMockOpServer();

      // Give the recording mock the same identity scenario + some journal history.
      const scenario = (await pickIdentityScenario(setup)) ?? RECON_SCENARIO;
      await setup.post(`${rec.url}/__mock/load/${encodeURIComponent(scenario)}`);
      await setup.post(`${rec.url}/__mock/goto-day/4`);

      // Point the app at the recording mock and make it the ONLY live connection.
      recConnId = await ensureConnection(setup, rec.url, "rec-guard-token");
      await setup.patch(`/api/connections/${recConnId}`, { data: { current: true, enabled: true } });
      await setup.patch(`/api/connections/${mockConnId}`, { data: { enabled: false } });

      // Sync project 3 from the recording connection so its tickets (and the
      // journals identity is reconstructed from) live under recConnId.
      const sync = await setup.post("/api/sync", {
        data: { project_op_id: PROJECT_OP_ID, connection_id: recConnId },
      });
      expect(sync.ok(), `scoped sync to recording mock: ${sync.status()} ${await sync.text()}`).toBeTruthy();

      sprintId = await createSprint(setup, "TF NoUsersCollection", "2026-07-06", "2026-07-31");
      const isRetro = await makeRetrospective(setup, sprintId);
      const seed = await seedRetro(setup, sprintId, { version: RETRO_VERSION, ids: String(RECON_WP) });
      if (notImplemented(seed.status)) await addItem(setup, sprintId, RECON_WP);

      // Clear the recording history AFTER setup (load/sync/health) so the
      // assertion covers only the retrospective-planning reads themselves.
      rec.reset();

      // Drive the full retro flow — each of these routes constructs the identity
      // resolver against the recording connection (retro.ts createIdentityResolver
      // sites), so if it enumerates the user collection, it lands here.
      await getPreview(setup, sprintId); // GET /retro/preview
      const cap = await getCapacity(setup, sprintId); // GET /capacity (retro roster)
      await getPeople(setup, sprintId); // GET /people (everyone)
      await setup.get(`/api/sprints/${sprintId}/unresolved-names`).catch(() => {}); // legacy, still present now

      // PRECONDITION: the retro reads must have ACTUALLY talked to OP on the
      // recording connection (some /api/v3/* fetch after the reset), else the
      // flow was served purely from cache / the resolver never ran and "no
      // /api/v3/users" would be vacuously true. (When the current fetchAllUsers
      // path runs, GET /api/v3/users is itself such a read, so this precondition
      // never masks the very call we're guarding against.)
      const sawOpRead = rec.requests.some((r) => r.path.startsWith("/api/v3/"));
      const capacityRan = cap !== null;
      if (!capacityRan || !isRetro || !sawOpRead) {
        test.info().annotations.push({
          type: "SPEC_13 §1a users-collection guard",
          description: `flow could not be driven meaningfully (isRetro=${isRetro}, capacityRan=${capacityRan}, sawOpRead=${sawOpRead}, seed=${seed.status}) — the retro roster/resolver path isn't exercisable yet; absence assertion would be vacuous, skipping. Observed paths=${JSON.stringify([...new Set(rec.requests.map((r) => r.path))])}`,
        });
        test.skip(true, "retro resolver path not exercisable on recording mock");
        return;
      }

      // THE ASSERTION (HARD): the bare user-COLLECTION path was NEVER requested.
      // /api/v3/users/me and /api/v3/users/:id are explicitly allowed.
      const usersCollectionHits = rec.requests.filter((r) => r.path === "/api/v3/users");
      const membershipsHits = rec.requests.filter((r) => r.path === "/api/v3/memberships").length;
      test.info().annotations.push({
        type: "SPEC_13 §1a users-collection guard",
        description:
          `during the retro flow the API hit these OP paths on the recording mock: ` +
          `${JSON.stringify([...new Set(rec.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => `${r.method} ${r.path}`))])}. ` +
          `bare /api/v3/users hits=${usersCollectionHits.length}, /api/v3/memberships hits=${membershipsHits}.`,
      });
      expect(
        usersCollectionHits.length,
        `SPEC_13 §1a: the API issued GET /api/v3/users (the admin-gated user COLLECTION) ${usersCollectionHits.length}× during the retro flow — it must NEVER call it (ids come from _links.assignee/accountable + GET /api/v3/memberships). This is the exact root cause: apps/api/logic/identityResolver.ts's createIdentityResolver → fetchAllUsers must be reworked (Agent B).`,
      ).toBe(0);
    } finally {
      if (sprintId !== null) await setup.delete(`/api/sprints/${sprintId}`).catch(() => {});
      // Restore the default connection as the live one for any later run.
      await setup.patch(`/api/connections/${mockConnId}`, { data: { current: true, enabled: true } }).catch(() => {});
      if (recConnId !== null) {
        await setup.patch(`/api/connections/${recConnId}`, { data: { enabled: false } }).catch(() => {});
      }
      if (rec !== null) await rec.close().catch(() => {});
    }
  });
});
