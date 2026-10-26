import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { CapacityResponse, ClosureStatsResponse, SprintResponse } from "@osp/contracts";
import type { OpStatus, OpWorkPackage, HalLink } from "@osp/op-client";
import {
  activateSprint,
  addConnection,
  buildTestApp,
  initVault,
  type FakeOpData,
  type TestApp,
} from "../test-utils";

/**
 * Increment 30 §2c — ONE holder resolution behind `Planned`.
 *
 * MEASURED DEFECT this pins (Agent D, s10/s12): a developer abandoned a ticket
 * mid-sprint — the live cache row's assignee went to NULL — and its 6 h stayed in
 * his Closure `Planned`, because `computeClosureStats` resolved the holder as
 * `wp?.assignee_op_id ?? baseline.assignee_op_id` (falling back to the FROZEN
 * baseline assignee), while `computeCapacity` reads the live cache assignee only
 * and filed the very same ticket under the Unassigned bucket. Two surfaces, two
 * answers for one ticket — breaking `CAPACITY_BAR_RULES.md` §6 invariants 5 and
 * 8, the two this increment exists to establish.
 *
 * Assigned to nobody means assigned to nobody: the hours go to the unassigned
 * bucket, never back to an ex-holder.
 *
 * The baseline fallback is deliberately RETAINED for CLASSIFICATION (done bucket,
 * `holder_name`, `holder_role`) — an old sprint whose cache rows were purged
 * still has to be able to name a holder. Only Planned changed.
 */

const STATUSES: OpStatus[] = [
  { _type: "Status", id: 7, name: "In progress", isClosed: false },
];

function statusLink(id: number): HalLink {
  const s = STATUSES.find((x) => x.id === id)!;
  return { href: `/api/v3/statuses/${id}`, title: s.name };
}

function opWp(
  id: number,
  assignee: { id: number; name: string } | null,
  hours: number,
): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    // Real durations: activation re-syncs the cache from this fake OP, so a null
    // here would wipe the seeded estimates back to 0.
    estimatedTime: `PT${hours}H`,
    remainingTime: `PT${hours}H`,
    spentTime: null,
    updatedAt: "2026-06-01T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: statusLink(7),
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
      ...(assignee ? { assignee: { href: `/api/v3/users/${assignee.id}`, title: assignee.name } } : {}),
    },
  };
}

const RADEK = { id: 41, name: "Radek Dostal" };
const KEEPER = { id: 42, name: "Klara Keeper" };
const ABANDONED_WP = 5001;
const RETAINED_WP = 5002;
const ABANDONED_HOURS = 6;
const RETAINED_HOURS = 9;

describe("Increment 30 §2c — an in-scope ticket with NO current assignee is Unassigned, never its ex-holder", () => {
  let t: TestApp;
  let opData: FakeOpData;

  async function seedCache(
    id: number,
    assignee: { id: number; name: string } | null,
    hours: number,
  ): Promise<void> {
    await t.repos.workPackages.upsertMany([
      {
        op_id: id,
        project_op_id: 100,
        project_name: null,
        subject: `WP ${id}`,
        type_name: "Task",
        status_name: "In progress",
        status_is_closed: false,
        assignee_op_id: assignee?.id ?? null,
        assignee_name: assignee?.name ?? null,
        estimated_hours: hours,
        remaining_hours: hours,
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

  beforeEach(async () => {
    opData = {
      statuses: STATUSES,
      workPackages: [
        opWp(ABANDONED_WP, RADEK, ABANDONED_HOURS),
        opWp(RETAINED_WP, KEEPER, RETAINED_HOURS),
      ],
      activitiesByWpId: {},
      timeEntries: [],
    };
    t = await buildTestApp({ opData, now: () => new Date("2026-06-05T08:00:00.000Z") });
    await initVault(t);
    await addConnection(t);
  });

  afterEach(async () => {
    await t.close();
  });

  it("drops the abandoned ticket from its ex-holder's Planned on BOTH surfaces, and keeps them identical", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Inc30 abandonment", start_date: "2026-06-01", end_date: "2026-06-14" },
    });
    const sprintId = SprintResponse.parse(created.json()).id;

    await seedCache(ABANDONED_WP, RADEK, ABANDONED_HOURS);
    await seedCache(RETAINED_WP, KEEPER, RETAINED_HOURS);
    for (const wp of [ABANDONED_WP, RETAINED_WP]) {
      const r = await t.app.inject({
        method: "POST",
        url: `/api/sprints/${sprintId}/items`,
        payload: { wp_op_id: wp },
      });
      expect(r.statusCode, `add ${wp}`).toBe(201);
    }
    await activateSprint(t, sprintId);

    // Closure's role gate defaults an unknown holder to "unset" (Capacity's own
    // back-compat default is "developer"), so materialize both people and mark
    // them developers — otherwise per_developer would legitimately be empty and
    // the comparison below would prove nothing.
    const people = (await t.app.inject({ method: "GET", url: "/api/people" })).json() as Array<{
      id: number;
      name: string;
    }>;
    for (const p of people) {
      const r = await t.app.inject({
        method: "PUT",
        url: `/api/people/${p.id}/role`,
        payload: { role: "developer" },
      });
      expect(r.statusCode, `set role for ${p.name}`).toBe(200);
    }

    // Radek abandons his ticket mid-sprint: the LIVE row loses its assignee, while
    // the FROZEN ticket_baseline still records him as the original owner.
    await seedCache(ABANDONED_WP, null, ABANDONED_HOURS);

    const cap = CapacityResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })).json(),
    );
    const stats = ClosureStatsResponse.parse(
      (await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/closure-stats` })).json(),
    );

    // ── Capacity: the hours sit in the Unassigned bucket, not on Radek ────────
    const radekLine = cap.lines.find((l) => l.op_user_id === RADEK.id);
    const unassigned = cap.lines.find((l) => l.op_user_id === null && l.member_id === null);
    expect(radekLine?.planned_hours ?? 0, "ex-holder carries none of it").toBe(0);
    expect(unassigned?.planned_hours, "the unassigned bucket carries it").toBe(ABANDONED_HOURS);
    expect(
      cap.lines.find((l) => l.op_user_id === KEEPER.id)?.planned_hours,
      "the untouched ticket is unaffected",
    ).toBe(RETAINED_HOURS);

    // ── Closure: same answer. Before §2c this said 6 for Radek and 15 in total. ─
    const radekDev = stats.per_developer.find((d) => d.op_user_id === RADEK.id);
    expect(radekDev?.planned_hours ?? 0, "ex-holder carries none of it here either").toBe(0);
    expect(stats.total_planned_hours, "developers only, current scope only").toBe(RETAINED_HOURS);

    // ── Invariants 5 and 8 ───────────────────────────────────────────────────
    expect(cap.scope_planned_hours, "invariant 5: the two surfaces agree").toBe(
      stats.total_planned_hours,
    );
    expect(
      stats.per_developer.reduce((s, d) => s + d.planned_hours, 0),
      "invariant 8: the header is the sum of the rows beneath it",
    ).toBe(stats.total_planned_hours);

    // Radek does NOT vanish — he is still a row, and his retained baseline still
    // records what he was signed up for. The bar is unchanged; only the number is.
    expect(radekDev, "the developer must never disappear from the panel").toBeDefined();
    expect(radekDev?.baseline_hours).toBe(ABANDONED_HOURS);
    expect(stats.total_baseline_hours, "baseline still counts both tickets").toBe(
      ABANDONED_HOURS + RETAINED_HOURS,
    );

    // §2c, the other half: the BAR ANNOTATION agrees with the number. The
    // changelog here has no un-assignment row, so the engine's reconstructed
    // interval chain still shows Radek as holder — the LIVE row is the authority
    // and wins, exactly as `computeCapacity` reads it. Without this the segment
    // would annotate 6 h "counts to Planned" while the number beside it read 0.
    for (const d of stats.per_developer) {
      expect(
        d.segments.reduce((s2, seg) => s2 + seg.planned_delta_hours, 0),
        `${d.name}: Σ planned_delta_hours == planned_hours`,
      ).toBe(d.planned_hours);
    }
    const radekSeg = radekDev?.segments.find((s2) => s2.wp_op_id === ABANDONED_WP);
    expect(radekSeg, "his bar is still there — colour and length unchanged").toBeDefined();
    expect(radekSeg?.estimate_hours).toBe(ABANDONED_HOURS);
    expect(radekSeg?.counts_to_planned, "but it is no longer his current scope").toBe(false);
  });
});
