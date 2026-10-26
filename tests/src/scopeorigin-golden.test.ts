import { afterEach, describe, expect, it } from "vitest";
import type { Repositories } from "@osp/db";
import type { ClosureStatsResponse, SprintItemOrigin } from "@osp/contracts";
import { bootRealApp, call, type RealApp } from "./harness";

/**
 * GOLDEN TESTS — Increment 35: scope-origin split (planned before activation
 * vs added during the sprint) — docs/INCREMENT_35_CONTRACTS.md §5;
 * CAPACITY_BAR_RULES §5c + §6 invariant 13.
 *
 * The management question these encode: "how much of the sprint was committed
 * by planning (before the Activate click) vs how much arrived mid-sprint —
 * in tickets, estimated hours, and in developer time actually logged?"
 *
 * Written BEFORE the implementation (the identity-golden pattern): RED against
 * the Phase-0 zeroed stub, green after Agent A lands. PGlite only — no real DB.
 */

const DEV = { op: 911, name: "Split Dev" };

/** Sprint window — every in-window spent_on sits inside it. */
const WINDOW = { start: "2026-06-01", end: "2026-06-14" };

interface SeedTicket {
  wp: number;
  origin: SprintItemOrigin;
  outcome: "planned" | "done" | "removed" | "removed_mid_sprint";
  planned: number | null;
  /** dev hours logged with spent_on INSIDE the window (0 = no row). */
  logged: number;
  /** dev hours logged with spent_on OUTSIDE the window (must never count). */
  loggedOutside?: number;
}

/** §5's worked example, one row per case the split must handle. */
const TICKETS: SeedTicket[] = [
  { wp: 9501, origin: "baseline", outcome: "planned", planned: 10, logged: 8, loggedOutside: 4 },
  { wp: 9502, origin: "baseline", outcome: "done", planned: 20, logged: 12 },
  { wp: 9503, origin: "added_mid_sprint", outcome: "planned", planned: 5, logged: 9 },
  { wp: 9504, origin: "added_retroactively", outcome: "done", planned: 4, logged: 6 },
  // Committed mid-sprint, worked, then descoped — stays in `added` (SPEC_05 §1).
  { wp: 9505, origin: "added_mid_sprint", outcome: "removed_mid_sprint", planned: 3, logged: 2 },
  // Dropped during PLANNING — never committed scope; excluded entirely.
  { wp: 9506, origin: "baseline", outcome: "removed", planned: 7, logged: 0 },
];

/** Expected partition (hand-computed from TICKETS — keep in sync). */
const EXPECT_BASELINE = { ticket_count: 2, estimate_hours: 30, dev_logged_hours: 20 };
const EXPECT_ADDED = { ticket_count: 3, estimate_hours: 12, dev_logged_hours: 17 };
const EXPECT_LOGGED_SHARE = (17 / 37) * 100;
const EXPECT_ESTIMATE_SHARE = (12 / 42) * 100;

async function seed(r: Repositories): Promise<number> {
  const m = await r.teamMembers.upsert({ op_user_id: DEV.op, name: DEV.name, default_hours_per_day: 8 });
  await r.teamMembers.setRole(m.id, "developer");

  const sprint = await r.sprints.create({
    name: "Scope-origin golden",
    start_date: WINDOW.start,
    end_date: WINDOW.end,
    status: "active",
    capacity_mode: "per_person",
  });

  await r.workPackages.upsertMany(
    TICKETS.map((t) => ({
      connection_id: null,
      op_id: t.wp,
      project_op_id: 100,
      project_name: null,
      subject: `WP ${t.wp}`,
      type_name: "Task",
      status_name: t.outcome === "done" ? "Closed" : "In progress",
      status_is_closed: t.outcome === "done",
      assignee_op_id: DEV.op,
      assignee_name: DEV.name,
      estimated_hours: t.planned,
      remaining_hours: null,
      spent_hours: null,
      story_points: null,
      version_op_id: null,
      version_name: null,
      priority: null,
      parent_op_id: null,
      percentage_done: null,
      updated_at_op: "2026-06-01T00:00:00Z",
      raw_json: "{}",
    })),
  );

  const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
  for (const t of TICKETS) {
    await r.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: t.wp,
      planned_hours: t.planned,
      outcome: t.outcome,
      origin: t.origin,
    });
    await r.ticketBaselines.upsertMany([
      {
        sprint_id: sprint.id,
        wp_op_id: t.wp,
        captured_at: `${WINDOW.start}T09:00:00Z`,
        subject: `WP ${t.wp}`,
        status_name: "In progress",
        status_is_closed: false,
        assignee_op_id: DEV.op,
        accountable_op_id: null,
        original_assignee_op_id: DEV.op,
        estimated_hours: t.planned,
        remaining_hours: null,
        spent_hours: null,
        version_op_id: null,
        raw_json: "{}",
        origin: t.origin,
        reconstructed: false,
        reconstruction_gaps_json: null,
        assignee_name_raw: DEV.name,
      },
    ]);
    const rows = [];
    if (t.logged > 0) {
      rows.push({
        sprint_id: sprint.id,
        wp_op_id: t.wp,
        update_run_id: run.id,
        occurred_at: `${WINDOW.start}T12:00:00Z`,
        actor_op_id: DEV.op,
        actor_name: DEV.name,
        kind: "time_logged" as const,
        detail_json: JSON.stringify({ kind: "time_logged", hours: t.logged, spent_on: WINDOW.start }),
        source: "time_entry" as const,
        op_journal_id: null,
        dedup_key: `s${sprint.id}:time_entry:golden-in-${t.wp}`,
      });
    }
    if (t.loggedOutside && t.loggedOutside > 0) {
      // spent_on BEFORE the window — §5 "Logged" window rules must exclude it
      // from the split exactly like they exclude it everywhere else.
      rows.push({
        sprint_id: sprint.id,
        wp_op_id: t.wp,
        update_run_id: run.id,
        occurred_at: `${WINDOW.start}T12:00:00Z`,
        actor_op_id: DEV.op,
        actor_name: DEV.name,
        kind: "time_logged" as const,
        detail_json: JSON.stringify({ kind: "time_logged", hours: t.loggedOutside, spent_on: "2026-05-20" }),
        source: "time_entry" as const,
        op_journal_id: null,
        dedup_key: `s${sprint.id}:time_entry:golden-out-${t.wp}`,
      });
    }
    if (rows.length > 0) await r.ticketChangelog.insertMany(rows);
  }
  return sprint.id;
}

async function getClosure(app: RealApp["app"], sprintId: number): Promise<ClosureStatsResponse> {
  const res = await call(app, "GET", `/api/sprints/${sprintId}/closure-stats`);
  expect(res.status, JSON.stringify(res.json).slice(0, 300)).toBe(200);
  return res.json as ClosureStatsResponse;
}

describe("GOLDEN Increment 35 — scope-origin split (CAPACITY_BAR_RULES §5c, invariant 13)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("partitions counts, planned hours and WINDOWED dev-logged by origin; removed excluded, removed_mid_sprint retained, retro-add counts as added (today: zeroed stub)", async () => {
    harness = await bootRealApp();
    const sprintId = await seed(harness.repos);
    const stats = await getClosure(harness.app, sprintId);

    expect(stats.scope_origin.baseline).toEqual(EXPECT_BASELINE);
    expect(stats.scope_origin.added).toEqual(EXPECT_ADDED);
    expect(stats.scope_origin.added_logged_share_pct).toBeCloseTo(EXPECT_LOGGED_SHARE, 5);
    expect(stats.scope_origin.added_estimate_share_pct).toBeCloseTo(EXPECT_ESTIMATE_SHARE, 5);
  });

  it("per-ticket lines carry the row's origin (today: field present via stub — asserts the VALUES)", async () => {
    harness = await bootRealApp();
    const sprintId = await seed(harness.repos);
    const stats = await getClosure(harness.app, sprintId);

    const originOf = new Map(stats.per_ticket.map((t) => [t.wp_op_id, t.origin]));
    expect(originOf.get(9501)).toBe("baseline");
    expect(originOf.get(9503)).toBe("added_mid_sprint");
    expect(originOf.get(9504)).toBe("added_retroactively");
  });

  it("shares are null on a sprint with no included items (0/0 — never NaN), and the block never disturbs pre-existing figures (invariant 13)", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    // An empty active sprint: block must be all-zero with null shares.
    const empty = await r.sprints.create({
      name: "Empty",
      start_date: WINDOW.start,
      end_date: WINDOW.end,
      status: "active",
      capacity_mode: "per_person",
    });
    const emptyStats = await getClosure(harness.app, empty.id);
    expect(emptyStats.scope_origin.baseline.ticket_count).toBe(0);
    expect(emptyStats.scope_origin.added.ticket_count).toBe(0);
    expect(emptyStats.scope_origin.added_logged_share_pct).toBeNull();
    expect(emptyStats.scope_origin.added_estimate_share_pct).toBeNull();

    // Invariant 13 on the seeded sprint: the split partitions the windowed
    // dev-logged of the INCLUDED items. `per_ticket` has never listed
    // `removed_mid_sprint` rows (the long-standing shared filter), while the
    // split deliberately keeps them (§1) — so Σ groups = Σ per_ticket PLUS
    // exactly the removed_mid_sprint items' windowed logged hours, and
    // nothing else moves.
    const sprintId = await seed(r);
    const stats = await getClosure(harness.app, sprintId);
    const removedMidSprintLogged = TICKETS.filter((t) => t.outcome === "removed_mid_sprint").reduce(
      (s, t) => s + t.logged,
      0,
    );
    const perTicketDevLogged = stats.per_ticket.reduce((s, t) => s + t.dev_logged_hours, 0);
    expect(
      stats.scope_origin.baseline.dev_logged_hours + stats.scope_origin.added.dev_logged_hours,
    ).toBeCloseTo(perTicketDevLogged + removedMidSprintLogged, 5);
    // Pin both sides so the relationship can't drift silently: per_ticket
    // still excludes the descoped row (35), the split still counts it (37).
    expect(perTicketDevLogged).toBeCloseTo(35, 5);
    expect(
      stats.scope_origin.baseline.dev_logged_hours + stats.scope_origin.added.dev_logged_hours,
    ).toBeCloseTo(37, 5);
  });
});
