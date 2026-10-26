import { openDb } from "@osp/db";
import type { NewTicketBaseline, NewWorkPackageCache } from "@osp/db";
import { beforeEach, describe, expect, it } from "vitest";
import { computeClosureStats } from "./closureStats";
import { buildTestApp } from "../test-utils";

function wp(p: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: p.connection_id ?? null,
    op_id: p.op_id,
    project_op_id: 100,
    project_name: null,
    subject: p.subject ?? `WP ${p.op_id}`,
    type_name: "Task",
    status_name: p.status_name ?? "New",
    status_is_closed: p.status_is_closed ?? false,
    assignee_op_id: p.assignee_op_id ?? null,
    assignee_name: p.assignee_name ?? null,
    estimated_hours: p.estimated_hours ?? null,
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
  };
}

describe("computeClosureStats — SPEC_14 §3 role-aware buckets + stats", () => {
  let db: Awaited<ReturnType<typeof openDb>>;
  let sprintId: number;

  beforeEach(async () => {
    db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "Closure Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });

    // People with explicit roles.
    const dev = await r.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");
    const tester = await r.teamMembers.upsert({ op_user_id: 20, name: "Tess Ter", default_hours_per_day: 8 });
    await r.teamMembers.setRole(tester.id, "tester");
    const cust = await r.teamMembers.upsert({ op_user_id: 30, name: "Cust Omer", default_hours_per_day: 8 });
    await r.teamMembers.setRole(cust.id, "customer");
    // op 40 intentionally has role "unset" (default) → ambiguous.
    await r.teamMembers.upsert({ op_user_id: 40, name: "Unset Person", default_hours_per_day: 8 });

    await r.workPackages.upsertMany([
      wp({ op_id: 2, status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 }),
      wp({ op_id: 1, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 10 }),
      wp({ op_id: 3, status_name: "In progress", assignee_op_id: 30, assignee_name: "Cust Omer", estimated_hours: 4 }),
      wp({ op_id: 4, status_name: "In progress", assignee_op_id: 40, assignee_name: "Unset Person", estimated_hours: 3 }),
      wp({ op_id: 5, status_name: "In progress", assignee_op_id: null, assignee_name: null, estimated_hours: 2 }),
      wp({ op_id: 6, status_name: "Rejected", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 5 }),
    ]);
    for (const [wpId, hrs] of [[2, 8], [1, 10], [3, 4], [4, 3], [5, 2], [6, 5]] as const) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }

    // Time entries stored as time_logged changelog rows (attribution by logger).
    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    const tl = (wpId: number, actorOp: number, actorName: string, hours: number, key: string) => ({
      sprint_id: sprint.id,
      wp_op_id: wpId,
      update_run_id: run.id,
      occurred_at: "2026-06-05T09:00:00Z",
      actor_op_id: actorOp,
      actor_name: actorName,
      kind: "time_logged" as const,
      detail_json: JSON.stringify({ kind: "time_logged", hours, spent_on: "2026-06-05" }),
      source: "time_entry" as const,
      op_journal_id: null,
      dedup_key: key,
    });
    await r.ticketChangelog.insertMany([
      tl(2, 10, "Dev One", 12, "te:1"), // dev logs 12 on done ticket wp2
      tl(2, 20, "Tess Ter", 3, "te:2"), // tester logs 3 on wp2
      tl(1, 10, "Dev One", 6, "te:3"), // dev logs 6 on wp1 (not done)
    ]);
    sprintId = sprint.id;
  });

  it("buckets tickets by status × holder role", async () => {
    const s = await computeClosureStats(db.repositories, sprintId, "2026-06-15T00:00:00Z");

    expect(s.done.count).toBe(2); // wp2 (tested), wp3 (in progress + customer)
    expect(s.done.items.map((i) => i.wp_op_id).sort()).toEqual([2, 3]);
    expect(s.not_done.count).toBe(2); // wp1 (dev), wp5 (unassigned)
    expect(s.not_done.items.map((i) => i.wp_op_id).sort()).toEqual([1, 5]);
    expect(s.rejected.count).toBe(1); // wp6
    expect(s.ambiguous.count).toBe(1); // wp4 (unset role)
    expect(s.ambiguous.items[0]!.ambiguous_reason).toContain("Unset Person");
  });

  it("flags the in-progress + unassigned anomaly", async () => {
    const s = await computeClosureStats(db.repositories, sprintId, "2026-06-15T00:00:00Z");
    expect(s.anomalies.map((a) => a.wp_op_id)).toEqual([5]);
    expect(s.anomalies[0]!.anomaly).toBe("unassigned_in_progress");
  });

  it("computes planned/logged/dev-logged totals (dev-only attribution by logger)", async () => {
    const s = await computeClosureStats(db.repositories, sprintId, "2026-06-15T00:00:00Z");
    // SPEC_17 §2/§4a — Planned is DEVELOPER-SCOPED: Σ per_developer.planned_hours.
    // Identity unification (golden tests `identity-golden*.test.ts`): closure
    // now applies the SAME role default /capacity always has
    // (`capacityEffectiveRole`: unset → developer), so "Unset Person" (wp4, 3 h)
    // counts here exactly like the capacity panel counts them — previously they
    // were silently invisible on this surface only (the Zbynek Trnka defect).
    // Dev One holds wp2(8)+wp1(10)+wp6(5) = 23; + Unset Person's wp4(3) = 26.
    // The customer's wp3(4) — an EXPLICIT non-developer — and the unassigned
    // wp5(2) still don't count.
    expect(s.total_planned_hours).toBe(26);
    expect(s.total_logged_hours).toBe(21); // 12+3+6
    expect(s.dev_logged_hours).toBe(18); // 12+6 (tester's 3 excluded)
    expect(s.overshoot_threshold_pct).toBe(25);
  });

  it("per-ticket + estimate accuracy honour 'done tickets only' + overshoot threshold", async () => {
    const s = await computeClosureStats(db.repositories, sprintId, "2026-06-15T00:00:00Z");
    const wp2 = s.per_ticket.find((t) => t.wp_op_id === 2)!;
    expect(wp2).toMatchObject({ estimate_hours: 8, dev_logged_hours: 12, total_logged_hours: 15, delta_hours: 4, overshoot_flag: true });
    const wp1 = s.per_ticket.find((t) => t.wp_op_id === 1)!;
    expect(wp1.delta_hours).toBeNull(); // not done → no accuracy
    expect(wp1.overshoot_flag).toBeNull();
    // Σ dev_logged(done) / Σ estimate(done): (12+0)/(8+4) = 100%.
    expect(s.estimate_accuracy_pct).toBe(100);
  });

  it("per-developer breakdown is Developers only, attributed correctly", async () => {
    const s = await computeClosureStats(db.repositories, sprintId, "2026-06-15T00:00:00Z");
    // Identity unification: "Developers only" now means "not an EXPLICIT
    // tester/customer/other" — the same `capacityEffectiveRole` default
    // /capacity applies, so the unset-role holder appears here too instead of
    // being visible on one surface and missing from the other (golden test A2).
    expect(s.per_developer).toHaveLength(2); // Dev One + Unset Person
    expect(s.per_developer.map((d) => d.name).sort()).toEqual(["Dev One", "Unset Person"]);
    const unset = s.per_developer.find((d) => d.name === "Unset Person")!;
    expect(unset.planned_hours).toBe(3); // holds wp4; never logged
    expect(unset.logged_hours).toBe(0);
    const dev = s.per_developer.find((d) => d.name === "Dev One")!;
    expect(dev.name).toBe("Dev One");
    expect(dev.planned_hours).toBe(23); // wp2(8)+wp1(10)+wp6(5) held by dev
    expect(dev.logged_hours).toBe(18); // their own logged (12+6)
    expect(dev.delivered_estimate_hours).toBe(8); // wp2 done + held by dev
    expect(dev.accuracy_pct).toBe(150); // 12 logged / 8 estimate
    expect(dev.overshoot_hours).toBe(4); // 12 - 8
  });
});

// Consolidation round (Concept 4) — connection-scoped identity. A bare
// `op_user_id` is only unique WITHIN one OP connection: the SAME numeric id on
// two DIFFERENT servers is two DIFFERENT people (the Increment-23 cross-server
// collision class — Alan Turing id 3 on the mock ≠ Cameron Dalby id 3 on
// Acme). closureStats must NOT fold them onto one `id:3` key.
describe("computeClosureStats — connection-scoped identity (Concept 4 regression)", () => {
  it("two people sharing op_user_id 3 on different connections stay two distinct developers", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const connA = await r.connections.create({
      base_url: "https://mock.example.com", label: "mock",
      token_ct: null, token_nonce: null, token_tag: null, default_project_op_id: null,
    });
    const connB = await r.connections.create({
      base_url: "https://acme.example.com", label: "Acme",
      token_ct: null, token_nonce: null, token_tag: null, default_project_op_id: null,
    });

    // Only ONE team_member can hold bare op_user_id 3 — itself the collision.
    // Both people resolve their role through this single id-keyed member row.
    const dev = await r.teamMembers.upsert({ op_user_id: 3, name: "Alan Turing", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");

    const sprint = await r.sprints.create({
      name: "Cross", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });

    // wp1 on connection A held by "Alan Turing" (id 3); wp2 on connection B held
    // by a DIFFERENT person "Cameron Dalby" who happens to also be id 3.
    await r.workPackages.upsertMany([
      wp({ op_id: 1, connection_id: connA.id, status_name: "Tested", status_is_closed: true, assignee_op_id: 3, assignee_name: "Alan Turing", estimated_hours: 8 }),
      wp({ op_id: 2, connection_id: connB.id, status_name: "Tested", status_is_closed: true, assignee_op_id: 3, assignee_name: "Cameron Dalby", estimated_hours: 6 }),
    ]);
    for (const [wpId, hrs] of [[1, 8], [2, 6]] as const) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }
    const baseline = (wpId: number, name: string, hrs: number): NewTicketBaseline => ({
      sprint_id: sprint.id, wp_op_id: wpId, captured_at: "2026-06-01T09:00:00Z",
      subject: `WP ${wpId}`, status_name: "Tested", status_is_closed: true,
      assignee_op_id: 3, accountable_op_id: null, original_assignee_op_id: 3,
      estimated_hours: hrs, remaining_hours: null, spent_hours: null,
      version_op_id: null, raw_json: "{}", origin: "baseline", reconstructed: false,
      reconstruction_gaps_json: null, assignee_name_raw: name,
    });
    await r.ticketBaselines.upsertMany([baseline(1, "Alan Turing", 8), baseline(2, "Cameron Dalby", 6)]);

    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    await r.ticketChangelog.insertMany([
      { sprint_id: sprint.id, wp_op_id: 1, update_run_id: run.id, occurred_at: "2026-06-05T09:00:00Z", actor_op_id: 3, actor_name: "Alan Turing", kind: "time_logged", detail_json: JSON.stringify({ kind: "time_logged", hours: 8, spent_on: "2026-06-05" }), source: "time_entry", op_journal_id: null, dedup_key: "te:a:1" },
      { sprint_id: sprint.id, wp_op_id: 2, update_run_id: run.id, occurred_at: "2026-06-06T09:00:00Z", actor_op_id: 3, actor_name: "Cameron Dalby", kind: "time_logged", detail_json: JSON.stringify({ kind: "time_logged", hours: 6, spent_on: "2026-06-06" }), source: "time_entry", op_journal_id: null, dedup_key: "te:b:2" },
    ]);

    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");
    const names = new Set(s.per_developer.map((d) => d.name));
    // Both survive as distinct developers — NOT folded onto one `id:3` key.
    expect(s.per_developer).toHaveLength(2);
    expect(names.has("Alan Turing")).toBe(true);
    expect(names.has("Cameron Dalby")).toBe(true);
    // Each is credited only their own connection's work.
    expect(s.per_developer.find((d) => d.name === "Alan Turing")!.delivered_estimate_hours).toBe(8);
    expect(s.per_developer.find((d) => d.name === "Cameron Dalby")!.delivered_estimate_hours).toBe(6);
  });
});

// Increment 33 (docs/INCREMENT_33_CONTRACTS.md §1/§3) — off-sprint logged
// time aggregation: rows a sprint update run wrote to `off_sprint_time_entry`
// (Increment 32), folded into ClosureStatsResponse.off_sprint.
describe("computeClosureStats — off_sprint aggregation (Increment 33 §1)", () => {
  async function seed() {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "Off-sprint Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    const dev = await r.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");
    const offOnly = await r.teamMembers.upsert({ op_user_id: 20, name: "Off Only Dev", default_hours_per_day: 8 });
    await r.teamMembers.setRole(offOnly.id, "developer");

    await r.workPackages.upsertMany([
      wp({ op_id: 1, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 }),
    ]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });

    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    await r.ticketChangelog.insertMany([
      {
        sprint_id: sprint.id, wp_op_id: 1, update_run_id: run.id, occurred_at: "2026-06-05T09:00:00Z",
        actor_op_id: 10, actor_name: "Dev One", kind: "time_logged",
        detail_json: JSON.stringify({ kind: "time_logged", hours: 5, spent_on: "2026-06-05" }),
        source: "time_entry", op_journal_id: null, dedup_key: "te:in-sprint",
      },
    ]);
    return { db, r, sprint };
  }

  it("splits share by hours, folds actor spellings, groups+orders tickets, and hits 100% for an off-only person", async () => {
    const { r, sprint } = await seed();
    const fetchedAt = "2026-06-10T12:00:00Z";
    await r.offSprintTime.replaceForSprint(sprint.id, [
      // Dev One (op_user_id 10) — two rows on the SAME off-sprint ticket
      // (999), with two DIFFERENT actor spellings — tests ticket grouping
      // (summed hours, latest non-null subject wins) AND actor folding (one
      // op_user_id, no connection context → folds per IDENTITY_MODEL.md,
      // regardless of the spelling difference).
      { sprint_id: sprint.id, connection_id: null, op_time_entry_id: 501, wp_op_id: 999, wp_subject: "Old title", actor_op_id: 10, actor_name: "Dev One", spent_on: "2026-06-03", hours: 2, fetched_at: fetchedAt },
      { sprint_id: sprint.id, connection_id: null, op_time_entry_id: 502, wp_op_id: 999, wp_subject: "New title", actor_op_id: 10, actor_name: "Dev One (old)", spent_on: "2026-06-04", hours: 3, fetched_at: fetchedAt },
      // A second, smaller off-sprint ticket for Dev One — tests ticket ordering.
      { sprint_id: sprint.id, connection_id: null, op_time_entry_id: 503, wp_op_id: 998, wp_subject: "Small one", actor_op_id: 10, actor_name: "Dev One", spent_on: "2026-06-05", hours: 1, fetched_at: fetchedAt },
      // Off Only Dev (op_user_id 20) — no sprint ticket, no sprint-logged
      // hours at all: "off-only person", per §1's required test case.
      { sprint_id: sprint.id, connection_id: null, op_time_entry_id: 504, wp_op_id: 997, wp_subject: "Elsewhere", actor_op_id: 20, actor_name: "Off Only Dev", spent_on: "2026-06-06", hours: 4, fetched_at: fetchedAt },
    ]);

    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");

    // Comparison base (decision 1b): Σ per_developer[].logged_hours, reused
    // (not re-derived) — Dev One's own in-sprint dev-logged 5h; Off Only Dev
    // never appears in per_developer at all (no sprint work → not "seen").
    expect(s.per_developer.find((d) => d.name === "Dev One")!.logged_hours).toBe(5);
    expect(s.per_developer.find((d) => d.name === "Off Only Dev")).toBeUndefined();

    expect(s.off_sprint.total_hours).toBe(10); // 2+3+1+4
    expect(s.off_sprint.sprint_logged_hours).toBe(5);
    expect(s.off_sprint.share_pct).toBeCloseTo((100 * 10) / (10 + 5), 5);

    expect(s.off_sprint.per_person).toHaveLength(2);
    // §1 ordering: per_person by total_hours desc — Dev One (6h) before Off
    // Only Dev (4h).
    expect(s.off_sprint.per_person.map((p) => p.name)).toEqual(["Dev One", "Off Only Dev"]);

    const devOne = s.off_sprint.per_person[0]!;
    expect(devOne.op_user_id).toBe(10);
    expect(devOne.total_hours).toBe(6); // 2+3+1, the two spellings folded
    expect(devOne.share_pct).toBeCloseTo((100 * 6) / (6 + 5), 5);
    // Ticket grouping (wp999's two rows summed, LATEST non-null subject wins)
    // + ordering (hours desc).
    expect(devOne.tickets).toEqual([
      { wp_op_id: 999, subject: "New title", hours: 5, connection_id: null },
      { wp_op_id: 998, subject: "Small one", hours: 1, connection_id: null },
    ]);

    const offOnlyDev = s.off_sprint.per_person[1]!;
    expect(offOnlyDev.name).toBe("Off Only Dev");
    expect(offOnlyDev.total_hours).toBe(4);
    // Off-only person: zero sprint-logged hours → all of their time is
    // "outside" → 100%, not null (null is reserved for the 0/0 case).
    expect(offOnlyDev.share_pct).toBe(100);
  });

  it("share_pct is null only when BOTH sides are exactly 0 (no off-sprint AND no sprint-logged time)", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({ name: "Empty", start_date: "2026-06-01", end_date: "2026-06-14", status: "active", capacity_mode: "per_person" });
    const dev = await r.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");
    await r.workPackages.upsertMany([wp({ op_id: 1, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 8 })]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
    // No changelog rows logged in-sprint, no off_sprint_time_entry rows either.

    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");
    expect(s.off_sprint.total_hours).toBe(0);
    expect(s.off_sprint.sprint_logged_hours).toBe(0);
    expect(s.off_sprint.share_pct).toBeNull();
    expect(s.off_sprint.per_person).toEqual([]);
  });

  it("a frozen sprint still reports its stored off-sprint rows (freeze-independent — off_sprint reads the table directly, never the live cache)", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({ name: "Frozen", start_date: "2026-06-01", end_date: "2026-06-14", status: "closed", capacity_mode: "per_person" });
    const dev = await r.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");
    await r.offSprintTime.replaceForSprint(sprint.id, [
      { sprint_id: sprint.id, connection_id: null, op_time_entry_id: 601, wp_op_id: 995, wp_subject: "Frozen ticket", actor_op_id: 10, actor_name: "Dev One", spent_on: "2026-06-07", hours: 2, fetched_at: "2026-06-10T12:00:00Z" },
    ]);
    await r.sprints.setFrozen(sprint.id, "2026-06-16T00:00:00Z");

    const s = await computeClosureStats(r, sprint.id, "2026-06-20T00:00:00Z");
    expect(s.off_sprint.total_hours).toBe(2);
    expect(s.off_sprint.per_person).toEqual([
      { op_user_id: 10, name: "Dev One", total_hours: 2, share_pct: 100, tickets: [{ wp_op_id: 995, subject: "Frozen ticket", hours: 2, connection_id: null }] },
    ]);
  });
});

// Increment 33 (docs/INCREMENT_33_CONTRACTS.md §0.1) — THE INVARIANT: the
// off-sprint block rides on ClosureStatsResponse but never feeds back into any
// OTHER figure. Seeds one sprint, snapshots burndown + capacity + every
// closure field, THEN writes off_sprint_time_entry rows and re-reads — nothing
// but `off_sprint` may move.
describe("Increment 33 §0.1 — off_sprint is STRICTLY SEPARATE from every other figure", () => {
  it("inserting off_sprint_time_entry rows changes ONLY closure.off_sprint — burndown, capacity, and every other closure field stay byte-identical", async () => {
    const t = await buildTestApp();
    try {
      const sprint = await t.repos.sprints.create({
        name: "Invariant", start_date: "2026-06-01", end_date: "2026-06-14",
        status: "active", capacity_mode: "per_person",
      });
      const dev = await t.repos.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
      await t.repos.teamMembers.setRole(dev.id, "developer");
      await t.repos.workPackages.upsertMany([
        {
          connection_id: null, op_id: 1, project_op_id: 100, project_name: null, subject: "WP 1", type_name: "Task",
          status_name: "In progress", status_is_closed: false, assignee_op_id: 10, assignee_name: "Dev One",
          estimated_hours: 8, remaining_hours: 8, spent_hours: null, story_points: null,
          version_op_id: null, version_name: null, priority: null, parent_op_id: null, percentage_done: null,
          updated_at_op: "2026-06-01T00:00:00Z", raw_json: "{}",
        },
      ]);
      await t.repos.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 8, outcome: "planned", origin: "baseline" });
      const run = await t.repos.sprintUpdateRuns.start(sprint.id, "update", "manual");
      await t.repos.ticketChangelog.insertMany([
        {
          sprint_id: sprint.id, wp_op_id: 1, update_run_id: run.id, occurred_at: "2026-06-05T09:00:00Z",
          actor_op_id: 10, actor_name: "Dev One", kind: "time_logged",
          detail_json: JSON.stringify({ kind: "time_logged", hours: 3, spent_on: "2026-06-05" }),
          source: "time_entry", op_journal_id: null, dedup_key: "te:inv1",
        },
      ]);

      // closure-stats is called directly (not over HTTP) with a FIXED
      // generatedAt — the route stamps it from the real clock (`nowIso()`),
      // which would make `generated_at` legitimately differ between the two
      // reads below for a reason that has nothing to do with this invariant.
      // Burndown/capacity carry no such field, so those go over HTTP as usual.
      const genAt = "2026-06-10T00:00:00Z";
      const beforeBurndown = (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/burndown` })).json();
      const beforeCapacity = (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/capacity` })).json();
      const beforeClosure = await computeClosureStats(t.repos, sprint.id, genAt);
      expect(beforeClosure.off_sprint.total_hours).toBe(0);

      await t.repos.offSprintTime.replaceForSprint(sprint.id, [
        {
          sprint_id: sprint.id, connection_id: null, op_time_entry_id: 701, wp_op_id: 900,
          wp_subject: "Elsewhere", actor_op_id: 10, actor_name: "Dev One", spent_on: "2026-06-06",
          hours: 7, fetched_at: "2026-06-10T00:00:00Z",
        },
      ]);

      const afterBurndown = (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/burndown` })).json();
      const afterCapacity = (await t.app.inject({ method: "GET", url: `/api/sprints/${sprint.id}/capacity` })).json();
      const afterClosure = await computeClosureStats(t.repos, sprint.id, genAt);

      expect(afterBurndown).toEqual(beforeBurndown);
      expect(afterCapacity).toEqual(beforeCapacity);

      const { off_sprint: beforeOff, ...beforeRest } = beforeClosure;
      const { off_sprint: afterOff, ...afterRest } = afterClosure;
      expect(afterRest).toEqual(beforeRest);
      expect(afterOff.total_hours).toBe(7);
      expect(afterOff.per_person[0]!.name).toBe("Dev One");
    } finally {
      await t.close();
    }
  });
});

// Increment 35 (docs/INCREMENT_35_CONTRACTS.md §3; CAPACITY_BAR_RULES §5c +
// §6 invariant 13) — scope-origin split: planned-before-activation
// (`baseline`) vs added-during-the-sprint (`added_mid_sprint` |
// `added_retroactively`).
describe("computeClosureStats — scope-origin split (Increment 35 §3)", () => {
  async function seedMixedOrigins() {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "Scope Origin Test",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    const dev = await r.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");

    await r.workPackages.upsertMany([
      wp({ op_id: 101, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 10 }),
      wp({ op_id: 102, status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: null }),
      wp({ op_id: 103, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 6 }),
      wp({ op_id: 104, status_name: "Tested", status_is_closed: true, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 3 }),
      wp({ op_id: 105, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 7 }),
      wp({ op_id: 106, status_name: "In progress", assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 20 }),
    ]);
    const items: Array<{
      wpId: number;
      planned: number | null;
      origin: "baseline" | "added_mid_sprint" | "added_retroactively";
      outcome: "planned" | "done" | "removed" | "removed_mid_sprint";
    }> = [
      { wpId: 101, planned: 10, origin: "baseline", outcome: "planned" },
      // §1: null planned_hours contributes 0 hours but still counts as a ticket.
      { wpId: 102, planned: null, origin: "baseline", outcome: "done" },
      { wpId: 103, planned: 6, origin: "added_mid_sprint", outcome: "planned" },
      { wpId: 104, planned: 3, origin: "added_retroactively", outcome: "done" },
      // Committed mid-sprint, worked, then descoped — stays in `added` (SPEC_05 §1).
      { wpId: 105, planned: 7, origin: "added_mid_sprint", outcome: "removed_mid_sprint" },
      // Dropped during PLANNING — never committed scope; excluded entirely.
      { wpId: 106, planned: 20, origin: "baseline", outcome: "removed" },
    ];
    for (const it of items) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: it.wpId, planned_hours: it.planned, outcome: it.outcome, origin: it.origin });
    }

    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    const tl = (wpId: number, hours: number, key: string) => ({
      sprint_id: sprint.id,
      wp_op_id: wpId,
      update_run_id: run.id,
      occurred_at: "2026-06-05T09:00:00Z",
      actor_op_id: 10,
      actor_name: "Dev One",
      kind: "time_logged" as const,
      detail_json: JSON.stringify({ kind: "time_logged", hours, spent_on: "2026-06-05" }),
      source: "time_entry" as const,
      op_journal_id: null,
      dedup_key: key,
    });
    await r.ticketChangelog.insertMany([
      tl(101, 8, "so:101"),
      tl(102, 5, "so:102"),
      tl(103, 4, "so:103"),
      tl(104, 2, "so:104"),
      tl(105, 1, "so:105"), // removed_mid_sprint — logged hours are real, must count
      tl(106, 100, "so:106"), // removed — must NOT count toward the split at all
    ]);
    return { db, r, sprint };
  }

  it("partitions ticket counts, frozen estimate hours and windowed dev-logged by origin; excludes removed; retains removed_mid_sprint in its origin group; retro-add counts as added", async () => {
    const { r, sprint } = await seedMixedOrigins();
    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");

    // baseline: wp101 (10, 8) + wp102 (null→0, 5) — wp106 (removed) excluded.
    expect(s.scope_origin.baseline).toEqual({ ticket_count: 2, estimate_hours: 10, dev_logged_hours: 13 });
    // added: wp103 (6,4) + wp104 (3,2) + wp105 (7,1, removed_mid_sprint retained).
    expect(s.scope_origin.added).toEqual({ ticket_count: 3, estimate_hours: 16, dev_logged_hours: 7 });
    expect(s.scope_origin.added_logged_share_pct).toBeCloseTo((7 / (13 + 7)) * 100, 5);
    expect(s.scope_origin.added_estimate_share_pct).toBeCloseTo((16 / (10 + 16)) * 100, 5);

    // Per-ticket lines carry the row's origin (only the in-scope four rows —
    // removed_mid_sprint/removed have never appeared in per_ticket, unchanged
    // by this increment).
    const originOf = new Map(s.per_ticket.map((t) => [t.wp_op_id, t.origin]));
    expect(originOf.get(101)).toBe("baseline");
    expect(originOf.get(103)).toBe("added_mid_sprint");
    expect(originOf.get(104)).toBe("added_retroactively");
    expect(s.per_ticket.some((t) => t.wp_op_id === 105 || t.wp_op_id === 106)).toBe(false);
  });

  it("shares are null only when their OWN denominator is 0 (dev-logged share and estimate share are independent axes)", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "No logged time yet", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });
    const dev = await r.teamMembers.upsert({ op_user_id: 10, name: "Dev One", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");
    await r.workPackages.upsertMany([
      wp({ op_id: 1, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 10 }),
      wp({ op_id: 2, assignee_op_id: 10, assignee_name: "Dev One", estimated_hours: 5 }),
    ]);
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 1, planned_hours: 10, outcome: "planned", origin: "baseline" });
    await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: 2, planned_hours: 5, outcome: "planned", origin: "added_mid_sprint" });
    // No time_logged changelog rows at all — dev-logged is 0/0 on both sides.

    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");
    expect(s.scope_origin.baseline).toEqual({ ticket_count: 1, estimate_hours: 10, dev_logged_hours: 0 });
    expect(s.scope_origin.added).toEqual({ ticket_count: 1, estimate_hours: 5, dev_logged_hours: 0 });
    // dev-logged 0/0 → null.
    expect(s.scope_origin.added_logged_share_pct).toBeNull();
    // estimate hours are NOT 0/0 (10 + 5 = 15) → a real, non-null share.
    expect(s.scope_origin.added_estimate_share_pct).toBeCloseTo((5 / 15) * 100, 5);
  });

  it("an empty sprint reports an all-zero block with both shares null (never NaN)", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const sprint = await r.sprints.create({
      name: "Empty", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });
    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");
    expect(s.scope_origin).toEqual({
      baseline: { ticket_count: 0, estimate_hours: 0, dev_logged_hours: 0 },
      added: { ticket_count: 0, estimate_hours: 0, dev_logged_hours: 0 },
      added_logged_share_pct: null,
      added_estimate_share_pct: null,
    });
  });

  // Invariant 13 (CAPACITY_BAR_RULES §6.13) — the block is DERIVED, never
  // load-bearing: every pre-existing top-level figure computed BEFORE the
  // scope-origin block (Planned/Baseline/Delivered/Logged/dev-logged, the
  // per-developer table, the per-ticket lines' own non-origin fields) is
  // byte-identical to what it was before this increment — none of them reads
  // `scope_origin`, and the arithmetic above proves the block's own numbers
  // are exactly derivable from `allSprintItems` (origin/planned_hours) +
  // `devLoggedByWp` (the SAME map every other windowed dev-logged figure in
  // this file already uses).
  it("invariant 13 — the split partitions the SAME windowed dev-logged figures the rest of the response already reports, and touches nothing else", async () => {
    const { r, sprint } = await seedMixedOrigins();
    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");

    // The two groups' dev-logged sum to exactly the windowed hours logged on
    // every INCLUDED item (outcome !== "removed") — i.e. every seeded
    // time_logged row except wp106's (removed, excluded), independently
    // hand-summed here from the seed rather than from `s.per_ticket` (which,
    // unchanged since before this increment, excludes removed_mid_sprint
    // rows like wp105 too — see the note on `allSprintItems` in
    // closureStats.ts for why the split reads the wider set on purpose).
    const includedLoggedSum = 8 + 5 + 4 + 2 + 1; // wp101+wp102+wp103+wp104+wp105
    expect(
      s.scope_origin.baseline.dev_logged_hours + s.scope_origin.added.dev_logged_hours,
    ).toBe(includedLoggedSum);

    // Top-level `dev_logged_hours` (pre-existing, computed upstream of the
    // scope-origin block from the raw changelog and unaffected by it) still
    // includes wp106's 100h — proving the block did not reach back and
    // filter that pre-existing figure.
    expect(s.dev_logged_hours).toBe(8 + 5 + 4 + 2 + 1 + 100);

    // Per-ticket lines' non-origin fields are exactly what they were before
    // this increment (dev_logged_hours per ticket, unaffected by the split).
    const wp101 = s.per_ticket.find((t) => t.wp_op_id === 101)!;
    expect(wp101.dev_logged_hours).toBe(8);
    expect(wp101.estimate_hours).toBe(10);
  });
});

// Increment 38 (`docs/CAPACITY_BAR_RULES.md` §5/§5b) — the reported case: a
// developer signed up for 50 h at Activate whose tickets were ALL reassigned
// afterwards read "Baseline 4 h" on the Capacity panel. Two defects:
//   1. the baseline holder was resolved from the snapshot's id paired with the
//      LIVE holder's name — the resolver keys on the name, so the ticket looked
//      as if its CURRENT holder had held it at activation (the sender's handoff
//      vanished; the receiver got a "baseline" ticket they never had);
//   2. Baseline counted only RETAINED baseline tickets, at the LIVE estimate.
describe("computeClosureStats — Baseline = signed up for at the last Activate (Increment 38)", () => {
  it("keeps every activation-time ticket on the activation holder, at the activation estimate", async () => {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    for (const [id, name, role] of [
      [3, "Cameron Dalby", "developer"],
      [5, "Daniel Brabec", "tester"],
      [261, "Tobias Bubenik", "developer"],
    ] as const) {
      const m = await r.teamMembers.upsert({ op_user_id: id, name, default_hours_per_day: 8 });
      await r.teamMembers.setRole(m.id, role);
    }
    const sprint = await r.sprints.create({
      name: "Baseline", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "planning", capacity_mode: "per_person",
    });
    const activatedAt = "2026-06-01T12:00:00Z";
    await r.sprints.activate(sprint.id, activatedAt, 54);

    // LIVE state (after the reassignments):
    //   101 Dalby → Brabec (tester), re-estimated: remaining 40 → 5
    //   102 Dalby → Bubenik (developer)
    //   103 Bubenik → Dalby
    //   104 Dalby, removed from the sprint mid-sprint
    await r.workPackages.upsertMany([
      { ...wp({ op_id: 101, status_name: "Developed", assignee_op_id: 5, assignee_name: "Daniel Brabec", estimated_hours: 40 }), remaining_hours: 5 },
      wp({ op_id: 102, status_name: "In progress", assignee_op_id: 261, assignee_name: "Tobias Bubenik", estimated_hours: 4 }),
      wp({ op_id: 103, status_name: "New", assignee_op_id: 3, assignee_name: "Cameron Dalby", estimated_hours: 4 }),
      wp({ op_id: 104, status_name: "New", assignee_op_id: 3, assignee_name: "Cameron Dalby", estimated_hours: 6 }),
    ]);
    for (const [wpId, hrs] of [[101, 40], [102, 4], [103, 4], [104, 6]] as const) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }
    const items = await r.sprintItems.listBySprint(sprint.id);
    await r.sprintItems.setOutcome(items.find((i) => i.wp_op_id === 104)!.id, "removed_mid_sprint", "2026-06-05T09:00:00Z");

    // Activation snapshot — a LIVE activation (no assignee_name_raw): the name
    // is only in the OP payload's assignee link.
    const baseline = (wpId: number, opId: number, name: string, est: number): NewTicketBaseline => ({
      sprint_id: sprint.id, wp_op_id: wpId, captured_at: activatedAt,
      subject: `WP ${wpId}`, status_name: "New", status_is_closed: false,
      assignee_op_id: opId, accountable_op_id: null, original_assignee_op_id: opId,
      estimated_hours: est, remaining_hours: est, spent_hours: null, version_op_id: null,
      raw_json: JSON.stringify({ id: wpId, _links: { assignee: { href: `/api/v3/users/${opId}`, title: name } } }),
      origin: "baseline", reconstructed: false, reconstruction_gaps_json: null, assignee_name_raw: null,
    });
    await r.ticketBaselines.upsertMany([
      baseline(101, 3, "Cameron Dalby", 40),
      baseline(102, 3, "Cameron Dalby", 4),
      baseline(103, 261, "Tobias Bubenik", 4),
      baseline(104, 3, "Cameron Dalby", 6),
    ]);

    const run = await r.sprintUpdateRuns.start(sprint.id, "update", "manual");
    const moved = (wpId: number, from: string, to: string, at: string) => ({
      sprint_id: sprint.id, wp_op_id: wpId, update_run_id: run.id, occurred_at: at,
      actor_op_id: null, actor_name: from, kind: "assignee_changed" as const,
      detail_json: JSON.stringify({ kind: "assignee_changed", from, to }),
      source: "journal" as const, op_journal_id: null, dedup_key: `as:${wpId}:${at}`,
    });
    await r.ticketChangelog.insertMany([
      moved(101, "Cameron Dalby", "Daniel Brabec", "2026-06-06T09:00:00Z"),
      moved(102, "Cameron Dalby", "Tobias Bubenik", "2026-06-05T09:00:00Z"),
      moved(103, "Tobias Bubenik", "Cameron Dalby", "2026-06-10T09:00:00Z"),
      {
        sprint_id: sprint.id, wp_op_id: 101, update_run_id: run.id, occurred_at: "2026-06-04T09:00:00Z",
        actor_op_id: 3, actor_name: "Cameron Dalby", kind: "time_logged",
        detail_json: JSON.stringify({ kind: "time_logged", hours: 9, spent_on: "2026-06-04" }),
        source: "time_entry", op_journal_id: null, dedup_key: "te:101",
      },
    ]);

    const s = await computeClosureStats(r, sprint.id, "2026-06-12T00:00:00Z");
    const dalby = s.per_developer.find((d) => d.name === "Cameron Dalby")!;
    const bubenik = s.per_developer.find((d) => d.name === "Tobias Bubenik")!;
    const kindOf = (d: typeof dalby, wpId: number) => d.segments.find((x) => x.wp_op_id === wpId)?.kind;

    // Baseline: 40 + 4 + 6 at the ACTIVATION estimate (101 is re-estimated to 5
    // since, 104 left the sprint) — never moves with reassignments.
    expect(dalby.baseline_hours).toBe(50);
    // Planned: what Dalby holds now — only 103.
    expect(dalby.planned_hours).toBe(4);
    // ±Change: 104 removed from the sprint (−6); handoffs and idle are 0.
    expect(dalby.scope_change_hours).toBe(-6);
    // Segments stay with the ACTIVATION holder.
    expect(kindOf(dalby, 101)).toBe("baseline_worked"); // worked, then to a tester
    expect(kindOf(dalby, 102)).toBe("handoff");
    expect(kindOf(dalby, 103)).toBe("idle"); // received, not worked — NOT his baseline
    expect(kindOf(bubenik, 103)).toBe("handoff");
    expect(kindOf(bubenik, 102)).toBe("idle");
    expect(bubenik.baseline_hours).toBe(4);
    expect(bubenik.planned_hours).toBe(4);
    expect(s.total_baseline_hours).toBe(54);
  });
});
