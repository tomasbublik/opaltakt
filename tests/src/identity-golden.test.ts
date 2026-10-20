import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "@osp/db";
import type { NewTicketBaseline, NewWorkPackageCache, Repositories } from "@osp/db";
import type {
  CapacityLine,
  CapacityResponse,
  ClosureStatsResponse,
  DeveloperCapacityBreakdown,
} from "@osp/contracts";
import { computeClosureStats } from "../../apps/api/src/logic/closureStats";
import { bootRealApp, call, type RealApp } from "./harness";

/**
 * GOLDEN TESTS — one person = one row, everywhere (HANDOFF "Jedna identita
 * osoby + zlatá sada testů").
 *
 * These encode the production evidence verbatim:
 *   • Closure "Per developer" (sprint 3.5.041): one person appears MULTIPLE
 *     times (Jan Belka 3×, Tobias Bubenik 2×), Zbynek Trnka is MISSING entirely
 *     despite logging 4.5 h on #11904, and Tobias's logged shows 8 h where his
 *     real #11904–#11907 total is 12 h (6+3+2+1).
 *   • Capacity (sprint "Atlas.Core 3.6.001"): the UI shows Tobias 10 h / Jan Belka
 *     4 h while GET /api/sprints/:id/capacity correctly returns 32 h / 44 h —
 *     the panel joins `per_developer` rows by `capacityLineKey`, and a
 *     fragmented identity makes that join land on a PARTIAL row.
 *
 * The fragmentation mechanisms reproduced here all exist in the current code:
 *   1. `personKey(connectionId, …)` produces `id:-:<opId>` when connectionId is
 *      null — which happens for every ticket whose work_package_cache row is
 *      GONE (old sprints purged by an import removal) and for every LEGACY
 *      cache row from before Increment 22's connection_id backfill — while the
 *      SAME person's other tickets key `id:<conn>:<opId>`.
 *   2. A journal-only name variant (diacritics: "Jan Bělka" vs the roster's
 *      "Jan Belka") resolves to a `nm:` key; `user_name_alias` rows that curate
 *      exactly this mapping are NEVER read by closureStats, so the fold that
 *      SPEC_13 §1b promises does not happen on this surface.
 *   3. A person with NO team_member row resolves to role "unset" and
 *      `developerSegments` silently drops their row — while the capacity route
 *      defaults the same person to "developer" (`capacityRoleForMemberRole`).
 *      One person, one sprint, visible on one surface and absent from another.
 *
 * CONTRACT (Definition of Done): every test here is RED against the current
 * build and MUST be green after the canonical-identity fix. They assert the
 * target behaviour, not today's, on production-shaped fixtures.
 *
 * Guardrail: PGlite only (openDb ephemeral / bootRealApp default) — no real
 * database, no OP server, no listening ports.
 */

// ── shared fixture helpers (closureStats.test.ts conventions) ────────────────

function wp(p: Partial<NewWorkPackageCache> & { op_id: number }): NewWorkPackageCache {
  return {
    connection_id: p.connection_id ?? null,
    op_id: p.op_id,
    project_op_id: 100,
    subject: p.subject ?? `WP ${p.op_id}`,
    type_name: "Task",
    status_name: p.status_name ?? "In progress",
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

function baselineRow(
  sprintId: number,
  wpOpId: number,
  p: {
    assignee_op_id: number | null;
    assignee_name_raw: string | null;
    estimated_hours: number | null;
  },
): NewTicketBaseline {
  return {
    sprint_id: sprintId,
    wp_op_id: wpOpId,
    captured_at: "2026-06-01T09:00:00Z",
    subject: `WP ${wpOpId}`,
    status_name: "In progress",
    status_is_closed: false,
    assignee_op_id: p.assignee_op_id,
    accountable_op_id: null,
    original_assignee_op_id: p.assignee_op_id,
    estimated_hours: p.estimated_hours,
    remaining_hours: null,
    spent_hours: null,
    version_op_id: null,
    raw_json: "{}",
    origin: "baseline",
    reconstructed: false,
    reconstruction_gaps_json: null,
    assignee_name_raw: p.assignee_name_raw,
  };
}

interface TimeLog {
  wp: number;
  actorOpId: number | null;
  actorName: string;
  hours: number;
  key: string;
}

async function seedTimeLogs(r: Repositories, sprintId: number, logs: TimeLog[]): Promise<void> {
  const run = await r.sprintUpdateRuns.start(sprintId, "update", "manual");
  await r.ticketChangelog.insertMany(
    logs.map((l) => ({
      sprint_id: sprintId,
      wp_op_id: l.wp,
      update_run_id: run.id,
      occurred_at: "2026-06-05T09:00:00Z",
      actor_op_id: l.actorOpId,
      actor_name: l.actorName,
      kind: "time_logged" as const,
      detail_json: JSON.stringify({ kind: "time_logged", hours: l.hours, spent_on: "2026-06-05" }),
      source: "time_entry" as const,
      op_journal_id: null,
      dedup_key: l.key,
    })),
  );
}

/** The EXACT join key the CapacityPanel uses (apps/web/src/lib/capacity.ts
 * `capacityLineKey`) — replicated verbatim so golden test C proves the UI's
 * own lookup, not a friendlier one. */
function uiJoinKey(row: Pick<CapacityLine, "op_user_id" | "member_id">): string {
  if (row.op_user_id != null) return String(row.op_user_id);
  if (row.member_id != null) return `m${row.member_id}`;
  return "unassigned";
}

// ═════════════════════════════════════════════════════════════════════════════
// A + B — sprint "3.5.041" shape: Closure per-developer identity & attribution
// ═════════════════════════════════════════════════════════════════════════════

describe("GOLDEN A+B — Closure per-developer: one person = one row (sprint 3.5.041 shape)", () => {
  async function seed351(): Promise<{ r: Repositories; sprintId: number }> {
    const db = await openDb({ ephemeral: true });
    const r = db.repositories;
    const conn = await r.connections.create({
      base_url: "https://openproject.example.com",
      label: "Acme",
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });

    // Roster: Tobias + Jan are developers; Zbynek Trnka has NO team_member row.
    const tobias = await r.teamMembers.upsert({ op_user_id: 261, name: "Tobias Bubenik", default_hours_per_day: 8 });
    await r.teamMembers.setRole(tobias.id, "developer");
    const jan = await r.teamMembers.upsert({ op_user_id: 64, name: "Jan Belka", default_hours_per_day: 8 });
    await r.teamMembers.setRole(jan.id, "developer");

    // A curated alias for the journal-only diacritics spelling of Jan's name —
    // exactly what SPEC_13 §1b promises to fold. Must be honoured BEFORE keying.
    await r.userNameAliases.upsert({
      connection_id: conn.id,
      journal_name: "Jan Bělka",
      op_user_id: 64,
      merge_into_name: null,
    });

    const sprint = await r.sprints.create({
      name: "3.5.041",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });

    // Live cache rows (connection known) — Tobias's #11904/#11905, Jan's #12001.
    await r.workPackages.upsertMany([
      wp({ op_id: 11904, connection_id: conn.id, assignee_op_id: 261, assignee_name: "Tobias Bubenik", estimated_hours: 6 }),
      wp({ op_id: 11905, connection_id: conn.id, assignee_op_id: 261, assignee_name: "Tobias Bubenik", estimated_hours: 3 }),
      wp({ op_id: 12001, connection_id: conn.id, assignee_op_id: 64, assignee_name: "Jan Belka", estimated_hours: 8 }),
    ]);
    // #11906/#11907/#12002/#12003 have NO cache row any more (purged by an
    // import removal) — only the frozen ticket_baseline remains. This is the
    // `connectionId == null` path: the same people, keyed differently.
    const items: Array<[number, number]> = [
      [11904, 6], [11905, 3], [11906, 2], [11907, 1],
      [12001, 8], [12002, 4], [12003, 5],
    ];
    for (const [wpId, hrs] of items) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }
    await r.ticketBaselines.upsertMany([
      baselineRow(sprint.id, 11904, { assignee_op_id: 261, assignee_name_raw: "Tobias Bubenik", estimated_hours: 6 }),
      baselineRow(sprint.id, 11905, { assignee_op_id: 261, assignee_name_raw: "Tobias Bubenik", estimated_hours: 3 }),
      baselineRow(sprint.id, 11906, { assignee_op_id: 261, assignee_name_raw: "Tobias Bubenik", estimated_hours: 2 }),
      baselineRow(sprint.id, 11907, { assignee_op_id: 261, assignee_name_raw: "Tobias Bubenik", estimated_hours: 1 }),
      baselineRow(sprint.id, 12001, { assignee_op_id: 64, assignee_name_raw: "Jan Belka", estimated_hours: 8 }),
      baselineRow(sprint.id, 12002, { assignee_op_id: 64, assignee_name_raw: "Jan Belka", estimated_hours: 4 }),
      // Journal-only diacritics variant, no id — resolvable ONLY via the alias.
      baselineRow(sprint.id, 12003, { assignee_op_id: null, assignee_name_raw: "Jan Bělka", estimated_hours: 5 }),
    ]);

    // Production time entries: #11904 Tobias 6 h + Zbynek 4.5 h; then 3+2+1.
    await seedTimeLogs(r, sprint.id, [
      { wp: 11904, actorOpId: 261, actorName: "Tobias Bubenik", hours: 6, key: "te:11904:t" },
      { wp: 11904, actorOpId: 305, actorName: "Zbynek Trnka", hours: 4.5, key: "te:11904:z" },
      { wp: 11905, actorOpId: 261, actorName: "Tobias Bubenik", hours: 3, key: "te:11905:t" },
      { wp: 11906, actorOpId: 261, actorName: "Tobias Bubenik", hours: 2, key: "te:11906:t" },
      { wp: 11907, actorOpId: 261, actorName: "Tobias Bubenik", hours: 1, key: "te:11907:t" },
    ]);
    return { r, sprintId: sprint.id };
  }

  it("A1 — every name appears AT MOST ONCE in per_developer (today: Tobias 2×, Jan Belka 2×)", async () => {
    const { r, sprintId } = await seed351();
    const s = await computeClosureStats(r, sprintId, "2026-06-15T00:00:00Z");
    const names = s.per_developer.map((d) => d.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("A2 — a person who logged time IS in the table even without a team_member row (today: Zbynek Trnka missing)", async () => {
    const { r, sprintId } = await seed351();
    const s = await computeClosureStats(r, sprintId, "2026-06-15T00:00:00Z");
    const zbynek = s.per_developer.find((d) => d.name === "Zbynek Trnka");
    expect(zbynek, "Zbynek Trnka logged 4.5 h on #11904 and must have a row").toBeDefined();
    expect(zbynek!.logged_hours).toBe(4.5);
  });

  it("B6 — Tobias's ONE row carries his full logged total 12 h = 6+3+2+1 (today: split 9/3 across two rows)", async () => {
    const { r, sprintId } = await seed351();
    const s = await computeClosureStats(r, sprintId, "2026-06-15T00:00:00Z");
    const rows = s.per_developer.filter((d) => d.name === "Tobias Bubenik");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.logged_hours).toBe(12);
  });

  it("B5 — #11904 attribution: total 10.5 h; Tobias 6 h and Zbynek 4.5 h land on their (single) rows", async () => {
    const { r, sprintId } = await seed351();
    const s = await computeClosureStats(r, sprintId, "2026-06-15T00:00:00Z");
    const t11904 = s.per_ticket.find((t) => t.wp_op_id === 11904)!;
    expect(t11904.total_logged_hours).toBe(10.5);
    // Per-person attribution is visible through the per_developer rows: Zbynek
    // logged ONLY on #11904, so his single row's logged total is exactly 4.5.
    const zbynek = s.per_developer.find((d) => d.name === "Zbynek Trnka");
    expect(zbynek?.logged_hours).toBe(4.5);
  });

  it("A1b — Jan Belka's baseline folds onto ONE row, alias applied BEFORE keying (8+4+5 = 17 h)", async () => {
    const { r, sprintId } = await seed351();
    const s = await computeClosureStats(r, sprintId, "2026-06-15T00:00:00Z");
    const rows = s.per_developer.filter((d) => d.name === "Jan Belka");
    expect(rows).toHaveLength(1);
    // #12001 (live, 8 h) + #12002 (purged cache, id-only baseline, 4 h)
    // + #12003 (journal-only "Jan Bělka", curated alias → op 64, 5 h).
    expect(rows[0]!.baseline_hours).toBe(17);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C + D — sprint "Atlas.Core 3.6.001" shape: capacity lines vs per_developer join
// ═════════════════════════════════════════════════════════════════════════════

describe("GOLDEN C+D — capacity UI join & cross-surface identity (sprint Atlas.Core 3.6.001 shape)", () => {
  let harness: RealApp | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function seed36(): Promise<{ sprintId: number }> {
    harness = await bootRealApp();
    const r = harness.repos;
    const conn = await r.connections.create({
      base_url: "https://openproject.example.com",
      label: "Acme",
      token_ct: null,
      token_nonce: null,
      token_tag: null,
      default_project_op_id: null,
    });
    for (const [op, name] of [
      [261, "Tobias Bubenik"],
      [64, "Jan Belka"],
      [301, "Cameron Dalby"],
      [302, "Daniel Brabec"],
    ] as const) {
      const m = await r.teamMembers.upsert({ op_user_id: op, name, default_hours_per_day: 8 });
      await r.teamMembers.setRole(m.id, "developer");
    }
    const sprint = await r.sprints.create({
      name: "Atlas.Core 3.6.001",
      start_date: "2026-06-01",
      end_date: "2026-06-14",
      status: "active",
      capacity_mode: "per_person",
    });
    // Tobias holds 32 h: one modern cache row (connection stamped) + one LEGACY
    // row from before Increment 22's backfill (connection_id NULL — the exact
    // rows the backfill missed because nothing re-synced them). Daniel's only
    // row is legacy too. /capacity keys by bare op_user_id, so IT reports the
    // correct totals; closure keys by (connection, id) and fragments.
    await r.workPackages.upsertMany([
      wp({ op_id: 12010, connection_id: conn.id, assignee_op_id: 261, assignee_name: "Tobias Bubenik", estimated_hours: 22 }),
      wp({ op_id: 12011, connection_id: null, assignee_op_id: 261, assignee_name: "Tobias Bubenik", estimated_hours: 10 }),
      wp({ op_id: 12012, connection_id: conn.id, assignee_op_id: 64, assignee_name: "Jan Belka", estimated_hours: 44 }),
      wp({ op_id: 12013, connection_id: conn.id, assignee_op_id: 301, assignee_name: "Cameron Dalby", estimated_hours: 8 }),
      wp({ op_id: 12014, connection_id: null, assignee_op_id: 302, assignee_name: "Daniel Brabec", estimated_hours: 13 }),
    ]);
    const items: Array<[number, number, number]> = [
      [12010, 22, 261], [12011, 10, 261], [12012, 44, 64], [12013, 8, 301], [12014, 13, 302],
    ];
    for (const [wpId, hrs] of items) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }
    await r.ticketBaselines.upsertMany(
      items.map(([wpId, hrs, opId]) =>
        baselineRow(sprint.id, wpId, {
          assignee_op_id: opId,
          assignee_name_raw:
            opId === 261 ? "Tobias Bubenik" : opId === 64 ? "Jan Belka" : opId === 301 ? "Cameron Dalby" : "Daniel Brabec",
          estimated_hours: hrs,
        }),
      ),
    );
    // Tobias logs on BOTH his tickets — the modern one and the legacy one — so
    // his logged total (5 h) must survive on his single row.
    await seedTimeLogs(r, sprint.id, [
      { wp: 12010, actorOpId: 261, actorName: "Tobias Bubenik", hours: 3, key: "te:12010:t" },
      { wp: 12011, actorOpId: 261, actorName: "Tobias Bubenik", hours: 2, key: "te:12011:t" },
    ]);
    return { sprintId: sprint.id };
  }

  async function fetchBoth(sprintId: number): Promise<{ cap: CapacityResponse; closure: ClosureStatsResponse }> {
    const capRes = await call(harness!.app, "GET", `/api/sprints/${sprintId}/capacity`);
    expect(capRes.status).toBe(200);
    const cloRes = await call(harness!.app, "GET", `/api/sprints/${sprintId}/closure-stats`);
    expect(cloRes.status).toBe(200);
    return { cap: capRes.json as CapacityResponse, closure: cloRes.json as ClosureStatsResponse };
  }

  it("C7 — /capacity itself reports the true per-person load (sanity: Tobias 32, Jan 44, Chris 8, Daniel 13)", async () => {
    const { sprintId } = await seed36();
    const { cap } = await fetchBoth(sprintId);
    const byName = new Map(cap.lines.map((l) => [l.name, l.planned_hours]));
    expect(byName.get("Tobias Bubenik")).toBe(32);
    expect(byName.get("Jan Belka")).toBe(44);
    expect(byName.get("Cameron Dalby")).toBe(8);
    expect(byName.get("Daniel Brabec")).toBe(13);
  });

  it("C7b — what the UI RENDERS equals /capacity: per_developer joined by capacityLineKey matches every line (today: Tobias's join lands on a 10 h or 22 h fragment)", async () => {
    const { sprintId } = await seed36();
    const { cap, closure } = await fetchBoth(sprintId);
    // EXACTLY the CapacityPanel's own lookup: Map(per_developer by uiJoinKey).
    const perDevByKey = new Map<string, DeveloperCapacityBreakdown>(
      closure.per_developer.map((d) => [uiJoinKey(d), d]),
    );
    for (const line of cap.lines) {
      if (!line.is_developer || line.op_user_id == null) continue;
      const joined = perDevByKey.get(uiJoinKey(line));
      expect(joined, `per_developer row for ${line.name}`).toBeDefined();
      expect(
        joined!.planned_hours,
        `${line.name}: UI-joined planned must equal the /capacity line`,
      ).toBe(line.planned_hours);
    }
  });

  it("D8a — per_developer names are unique on this surface too (today: Tobias Bubenik 2×)", async () => {
    const { sprintId } = await seed36();
    const { closure } = await fetchBoth(sprintId);
    const names = closure.per_developer.map((d) => d.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("D8b — planned AND logged agree per person across /capacity and /closure-stats", async () => {
    const { sprintId } = await seed36();
    const { cap, closure } = await fetchBoth(sprintId);
    const perDevByName = new Map(closure.per_developer.map((d) => [d.name, d]));
    for (const line of cap.lines) {
      if (!line.is_developer || line.op_user_id == null) continue;
      const row = perDevByName.get(line.name);
      expect(row, `closure row for ${line.name}`).toBeDefined();
      expect(row!.planned_hours, `${line.name}: planned`).toBe(line.planned_hours);
    }
    expect(perDevByName.get("Tobias Bubenik")!.logged_hours).toBe(5); // 3 + 2
  });

  it("D8c — the Capacity header is reproducible from its own developer rows (invariant 8 regression)", async () => {
    const { sprintId } = await seed36();
    const { cap } = await fetchBoth(sprintId);
    const devSum = cap.lines
      .filter((l) => l.is_developer)
      .reduce((s, l) => s + l.planned_hours, 0);
    expect(cap.scope_planned_hours).toBe(devSum);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A4 — the ONE split that must SURVIVE: cross-connection numeric collision
// ═════════════════════════════════════════════════════════════════════════════

describe("GOLDEN A4 — cross-connection op_user_id collision stays split (regression, green today)", () => {
  it("Alan Turing (mock, id 3) and Cameron Dalby (Acme, id 3) never fold into one row", async () => {
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
    const dev = await r.teamMembers.upsert({ op_user_id: 3, name: "Alan Turing", default_hours_per_day: 8 });
    await r.teamMembers.setRole(dev.id, "developer");
    const sprint = await r.sprints.create({
      name: "Cross", start_date: "2026-06-01", end_date: "2026-06-14",
      status: "active", capacity_mode: "per_person",
    });
    await r.workPackages.upsertMany([
      wp({ op_id: 1, connection_id: connA.id, assignee_op_id: 3, assignee_name: "Alan Turing", estimated_hours: 8 }),
      wp({ op_id: 2, connection_id: connB.id, assignee_op_id: 3, assignee_name: "Cameron Dalby", estimated_hours: 6 }),
    ]);
    for (const [wpId, hrs] of [[1, 8], [2, 6]] as const) {
      await r.sprintItems.add({ sprint_id: sprint.id, wp_op_id: wpId, planned_hours: hrs, outcome: "planned", origin: "baseline" });
    }
    await r.ticketBaselines.upsertMany([
      baselineRow(sprint.id, 1, { assignee_op_id: 3, assignee_name_raw: "Alan Turing", estimated_hours: 8 }),
      baselineRow(sprint.id, 2, { assignee_op_id: 3, assignee_name_raw: "Cameron Dalby", estimated_hours: 6 }),
    ]);
    await seedTimeLogs(r, sprint.id, [
      { wp: 1, actorOpId: 3, actorName: "Alan Turing", hours: 8, key: "te:a:1" },
      { wp: 2, actorOpId: 3, actorName: "Cameron Dalby", hours: 6, key: "te:b:2" },
    ]);

    const s = await computeClosureStats(r, sprint.id, "2026-06-15T00:00:00Z");
    const names = s.per_developer.map((d) => d.name).sort();
    expect(names).toEqual(["Alan Turing", "Cameron Dalby"]);
    expect(s.per_developer.find((d) => d.name === "Alan Turing")!.logged_hours).toBe(8);
    expect(s.per_developer.find((d) => d.name === "Cameron Dalby")!.logged_hours).toBe(6);
  });
});
