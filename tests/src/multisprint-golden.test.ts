import { afterEach, describe, expect, it } from "vitest";
import type { Repositories } from "@osp/db";
import type { ClosureStatsResponse } from "@osp/contracts";
import { bootRealApp, call, rawQuery, type RealApp } from "./harness";

/**
 * GOLDEN TESTS — Increment 34: long-running (multi-sprint) tasks
 * (docs/INCREMENT_34_CONTRACTS.md §6; CAPACITY_BAR_RULES §5 Delivered/Effectivity
 * + §6 invariants 11–12).
 *
 * User decisions these encode:
 *   3a — Delivered = burned remaining, uniformly (a 150 h task spanning sprints
 *        delivers per sprint the slice it burned, never 0/0/150);
 *   3b — a DONE ticket's delta/overshoot measure CUMULATIVE dev-logged time
 *        across every member sprint, not the final window;
 *   3c — POST /sprints/:id/items/:wpOpId/carry moves an unfinished ticket into
 *        a chosen open sprint;
 *   3d — multi_sprint badge ("sprint 2/3") on per-ticket lines and item detail.
 *
 * Written BEFORE the implementation (the identity-golden pattern): RED against
 * the Phase-0 stubs, green after Agents A/B land. PGlite only — no real DB.
 */

const DEV = { op: 901, name: "Marathon Dev" };
const LONG_WP = 9201; // the 150h-shaped task
const SHORT_WP = 9301; // single-sprint control ticket

async function seedMember(r: Repositories): Promise<void> {
  const m = await r.teamMembers.upsert({ op_user_id: DEV.op, name: DEV.name, default_hours_per_day: 8 });
  await r.teamMembers.setRole(m.id, "developer");
}

async function seedWp(
  r: Repositories,
  opId: number,
  p: { estimated: number; remaining: number | null; done?: boolean },
): Promise<void> {
  await r.workPackages.upsertMany([
    {
      connection_id: null,
      op_id: opId,
      project_op_id: 100,
      project_name: null,
      subject: `WP ${opId}`,
      type_name: "Task",
      status_name: p.done ? "Closed" : "In progress",
      status_is_closed: p.done ?? false,
      assignee_op_id: DEV.op,
      assignee_name: DEV.name,
      estimated_hours: p.estimated,
      remaining_hours: p.remaining,
      spent_hours: null,
      story_points: null,
      version_op_id: null,
      version_name: null,
      priority: null,
      parent_op_id: null,
      percentage_done: null,
      updated_at_op: "2026-06-01T00:00:00Z",
      raw_json: "{}",
    },
  ]);
}

async function seedSprintWithLongTask(
  r: Repositories,
  p: {
    name: string;
    start: string;
    end: string;
    status: "active" | "closed";
    /** remaining frozen into ticket_baseline at this sprint's activation. */
    remainingAtStart: number;
    /** dev hours logged inside THIS sprint's window (one row, mid-window). */
    loggedInWindow: number;
    includeLongTask?: boolean;
  },
): Promise<number> {
  const sprint = await r.sprints.create({
    name: p.name,
    start_date: p.start,
    end_date: p.end,
    status: p.status,
    capacity_mode: "per_person",
  });
  const wps = p.includeLongTask === false ? [] : [LONG_WP];
  for (const wpId of wps) {
    await r.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: wpId,
      planned_hours: p.remainingAtStart,
      outcome: "planned",
      origin: "baseline",
    });
    await r.ticketBaselines.upsertMany([
      {
        sprint_id: sprint.id,
        wp_op_id: wpId,
        captured_at: `${p.start}T09:00:00Z`,
        subject: `WP ${wpId}`,
        status_name: "In progress",
        status_is_closed: false,
        assignee_op_id: DEV.op,
        accountable_op_id: null,
        original_assignee_op_id: DEV.op,
        estimated_hours: 150,
        remaining_hours: p.remainingAtStart,
        spent_hours: null,
        version_op_id: null,
        raw_json: "{}",
        origin: "baseline",
        reconstructed: false,
        reconstruction_gaps_json: null,
        assignee_name_raw: DEV.name,
      },
    ]);
    if (p.loggedInWindow > 0) {
      const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
      const midWindow = p.start; // day one of the window — safely inside
      await r.ticketChangelog.insertMany([
        {
          sprint_id: sprint.id,
          wp_op_id: wpId,
          update_run_id: run.id,
          occurred_at: `${midWindow}T12:00:00Z`,
          actor_op_id: DEV.op,
          actor_name: DEV.name,
          kind: "time_logged",
          detail_json: JSON.stringify({ kind: "time_logged", hours: p.loggedInWindow, spent_on: midWindow }),
          source: "time_entry",
          op_journal_id: null,
          dedup_key: `s${sprint.id}:time_entry:golden-${wpId}`,
        },
      ]);
    }
  }
  return sprint.id;
}

async function getClosure(app: RealApp["app"], sprintId: number): Promise<ClosureStatsResponse> {
  const res = await call(app, "GET", `/api/sprints/${sprintId}/closure-stats`);
  expect(res.status, JSON.stringify(res.json).slice(0, 300)).toBe(200);
  return res.json as ClosureStatsResponse;
}

describe("GOLDEN Increment 34 — Delivered is burned remaining (3a, invariant 11)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("an OPEN long task delivers the remaining it burned this sprint, credited to the window's max logger (today: 0)", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    await seedMember(r);
    // Sprint 1: started with 150h remaining; the live ticket now shows 100h
    // remaining (50h burned) and the dev logged 50h inside the window.
    await seedWp(r, LONG_WP, { estimated: 150, remaining: 100 });
    const s1 = await seedSprintWithLongTask(r, {
      name: "long S1",
      start: "2026-06-01",
      end: "2026-06-14",
      status: "active",
      remainingAtStart: 150,
      loggedInWindow: 50,
    });

    const closure = await getClosure(harness.app, s1);
    const dev = closure.per_developer.find((d) => d.name === DEV.name);
    expect(dev, `${DEV.name} row`).toBeDefined();
    expect(dev!.delivered_hours, "burned remaining 150→100 = 50h delivered").toBe(50);
    expect(closure.total_delivered_hours).toBe(50);
  });

  it("single-sprint reduction: a begun-and-finished ticket still delivers exactly its estimate (must stay green throughout)", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    await seedMember(r);
    // Done ticket, remaining 0, estimate 8, no baseline-remaining recorded
    // (null) — the reduction case: delivered must be 8, exactly as before.
    await seedWp(r, SHORT_WP, { estimated: 8, remaining: 0, done: true });
    const sprint = await r.sprints.create({
      name: "short S",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: SHORT_WP, planned_hours: 8, outcome: "planned", origin: "baseline" });
    await r.ticketBaselines.upsertMany([
      {
        sprint_id: sprint.id, wp_op_id: SHORT_WP, captured_at: "2026-06-01T09:00:00Z",
        subject: `WP ${SHORT_WP}`, status_name: "In progress", status_is_closed: false,
        assignee_op_id: DEV.op, accountable_op_id: null, original_assignee_op_id: DEV.op,
        estimated_hours: 8, remaining_hours: null, spent_hours: null, version_op_id: null,
        raw_json: "{}", origin: "baseline", reconstructed: false,
        reconstruction_gaps_json: null, assignee_name_raw: DEV.name,
      },
    ]);
    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    await r.ticketChangelog.insertMany([
      {
        sprint_id: sprint.id, wp_op_id: SHORT_WP, update_run_id: run.id,
        occurred_at: "2026-06-03T12:00:00Z", actor_op_id: DEV.op, actor_name: DEV.name,
        kind: "time_logged",
        detail_json: JSON.stringify({ kind: "time_logged", hours: 7, spent_on: "2026-06-03" }),
        source: "time_entry", op_journal_id: null, dedup_key: `s${sprint.id}:time_entry:golden-short`,
      },
    ]);

    const closure = await getClosure(harness.app, sprint.id);
    const dev = closure.per_developer.find((d) => d.name === DEV.name)!;
    expect(dev.delivered_hours, "invariant 11 reduction: done single-sprint ticket delivers its estimate").toBe(8);
  });
});

describe("GOLDEN Increment 34 — cumulative Effectivity + multi_sprint badge (3b/3d, invariant 12)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function seedTwoSprintStory(r: Repositories): Promise<{ s1: number; s2: number }> {
    await seedMember(r);
    // Final state: done, remaining 0 (worked 50h in S1, 60h in S2).
    await seedWp(r, LONG_WP, { estimated: 150, remaining: 0, done: true });
    const s1 = await seedSprintWithLongTask(r, {
      name: "story S1", start: "2026-06-01", end: "2026-06-14", status: "closed",
      remainingAtStart: 150, loggedInWindow: 50,
    });
    const s2 = await seedSprintWithLongTask(r, {
      name: "story S2", start: "2026-06-15", end: "2026-06-28", status: "active",
      remainingAtStart: 100, loggedInWindow: 60,
    });
    return { s1, s2 };
  }

  it("a DONE multi-sprint ticket's delta uses CUMULATIVE dev-logged (50+60), not the final window (today: window only)", async () => {
    harness = await bootRealApp();
    const { s2 } = await seedTwoSprintStory(harness.repos);
    const closure = await getClosure(harness.app, s2);
    const line = closure.per_ticket.find((t) => t.wp_op_id === LONG_WP)!;
    expect(line.bucket).toBe("done");
    expect(line.cumulative_dev_logged_hours, "Σ windows: 50 (S1) + 60 (S2)").toBe(110);
    // estimate of record for the done ticket: remaining 0 → falls to Work 150.
    expect(line.delta_hours, "delta = cumulative 110 − estimate 150").toBe(-40);
  });

  it("multi_sprint badges: S1 = 1/2, S2 = 2/2 on per-ticket lines AND items/detailed (today: null)", async () => {
    harness = await bootRealApp();
    const { s1, s2 } = await seedTwoSprintStory(harness.repos);
    const c1 = await getClosure(harness.app, s1);
    const c2 = await getClosure(harness.app, s2);
    expect(c1.per_ticket.find((t) => t.wp_op_id === LONG_WP)!.multi_sprint).toEqual({ sequence: 1, total: 2 });
    expect(c2.per_ticket.find((t) => t.wp_op_id === LONG_WP)!.multi_sprint).toEqual({ sequence: 2, total: 2 });
    const items2 = await call(harness.app, "GET", `/api/sprints/${s2}/items/detailed`);
    const item = (items2.json as Array<{ op_id: number; multi_sprint: unknown }>).find((i) => i.op_id === LONG_WP)!;
    expect(item.multi_sprint).toEqual({ sequence: 2, total: 2 });
  });
});

describe("GOLDEN Increment 34 — carry-over endpoint (3c)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("carries an unfinished ticket from a closed sprint into a chosen planning sprint at the remaining-preferring estimate; gates hold (today: 404)", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    await seedMember(r);
    await seedWp(r, LONG_WP, { estimated: 150, remaining: 100 });
    const s1 = await seedSprintWithLongTask(r, {
      name: "carry source", start: "2026-06-01", end: "2026-06-14", status: "closed",
      remainingAtStart: 150, loggedInWindow: 50,
    });
    const target = await r.sprints.create({
      name: "carry target", start_date: "2026-06-15", end_date: "2026-06-28",
      status: "planning", capacity_mode: "per_person",
    });
    const frozenTarget = await r.sprints.create({
      name: "frozen target", start_date: "2026-05-01", end_date: "2026-05-14",
      status: "closed", capacity_mode: "per_person",
    });
    await r.sprints.setFrozen(frozenTarget.id, "2026-05-20T00:00:00Z");

    // Happy path: closed source → planning target.
    const res = await call(harness.app, "POST", `/api/sprints/${s1}/items/${LONG_WP}/carry`, {
      target_sprint_id: target.id,
    });
    expect(res.status, JSON.stringify(res.json).slice(0, 300)).toBeLessThan(300);
    const carried = await r.sprintItems.getBySprintAndWp(target.id, LONG_WP);
    expect(carried, "item exists in the target sprint").toBeTruthy();
    expect(carried!.planned_hours, "enters at the remaining-preferring estimate (100h left)").toBe(100);
    // Source untouched.
    expect(await r.sprintItems.getBySprintAndWp(s1, LONG_WP)).toBeTruthy();

    // Gate: duplicate carry → ITEM_ALREADY_IN_SPRINT.
    const dup = await call(harness.app, "POST", `/api/sprints/${s1}/items/${LONG_WP}/carry`, {
      target_sprint_id: target.id,
    });
    expect(dup.status).toBeGreaterThanOrEqual(400);

    // Gate: frozen target refused.
    const froz = await call(harness.app, "POST", `/api/sprints/${s1}/items/${LONG_WP}/carry`, {
      target_sprint_id: frozenTarget.id,
    });
    expect(froz.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GOLDEN Increment 34 — frozen sprint keeps its delivered slice (invariants 10×11)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("a frozen sprint's burned-remaining Delivered survives cache mutation AND deletion (needs frozen_remaining_hours)", async () => {
    harness = await bootRealApp();
    const r = harness.repos;
    await seedMember(r);
    await seedWp(r, LONG_WP, { estimated: 150, remaining: 100 });
    const s1 = await seedSprintWithLongTask(r, {
      name: "frozen slice", start: "2026-06-01", end: "2026-06-14", status: "closed",
      remainingAtStart: 150, loggedInWindow: 50,
    });
    // Freeze via the real engine (snapshots every non-removed item, incl. the
    // §4 frozen_remaining_hours this golden test forces into existence).
    const { freezeSprint } = await import("../../apps/api/src/logic/freeze");
    await freezeSprint(
      { repos: r, sprintLifecycle: null as never, log: () => undefined, nowIso: () => "2026-06-20T00:00:00.000Z" } as never,
      s1,
    );
    expect((await r.sprints.getById(s1))!.frozen_at).not.toBeNull();

    const before = await getClosure(harness.app, s1);
    const devBefore = before.per_developer.find((d) => d.name === DEV.name)!;
    expect(devBefore.delivered_hours, "frozen sprint reports its burned slice").toBe(50);

    // Mutate, then delete the live cache row — nothing may move (invariant 10).
    await seedWp(r, LONG_WP, { estimated: 999, remaining: 1, done: true });
    const afterMutate = await getClosure(harness.app, s1);
    expect(afterMutate.per_developer.find((d) => d.name === DEV.name)!.delivered_hours).toBe(50);
    await r.workPackages.deleteMany([LONG_WP]);
    const afterDelete = await getClosure(harness.app, s1);
    expect(afterDelete.per_developer.find((d) => d.name === DEV.name)!.delivered_hours).toBe(50);
    // The snapshot column itself exists and carries the value.
    const rows = await rawQuery<{ frozen_remaining_hours: number | null }>(
      harness.raw,
      "SELECT frozen_remaining_hours FROM sprint_item WHERE sprint_id = $1 AND wp_op_id = $2",
      [s1, LONG_WP],
    );
    expect(rows[0]?.frozen_remaining_hours, "frozen_remaining_hours snapshotted at freeze").toBe(100);
  });
});
