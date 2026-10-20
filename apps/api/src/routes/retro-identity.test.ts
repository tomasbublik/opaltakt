import { describe, expect, it } from "vitest";
import type {
  OpActivity,
  OpMembership,
  OpWorkPackage,
  ReconstructedWpState,
  ReconstructFallback,
  VersionScopeEvent,
} from "@osp/op-client";
import type { ReconstructEngine } from "../logic/reconstruct";
import { buildTestApp, initVault, addConnection, type TestApp } from "../test-utils";

/**
 * SPEC_13 §1a (REVISED) — the identity + retro-capacity behaviors, driven
 * through the real routes against a fake OP. A person's identity IS their NAME:
 * every reconstructed name gets a FULL, capacity-settable line the moment it's
 * seen — an OP user id is opportunistic enrichment (from `_links.assignee` or a
 * project membership, NEVER the admin-gated `GET /api/v3/users`). The crux
 * guards: (a) an UNRESOLVABLE name still gets a line whose availability is
 * settable (no blocking), and (b) the name→identity map is identical across
 * GET /retro/preview and GET /capacity.
 */

const STATUS_NEW = { _type: "Status" as const, id: 1, name: "New", isClosed: false };

function wpIdOf(activities: OpActivity[]): number {
  const href = activities[0]?._links.workPackage.href ?? null;
  const m = href ? /work_packages\/(\d+)/.exec(href) : null;
  return m ? Number(m[1]) : 0;
}

/** A reconstruction engine that returns a canned state per wp id. */
function fakeEngine(stateByWp: Map<number, ReconstructedWpState>): ReconstructEngine {
  return {
    stateAtDate(activities, _s, _d, fallback: ReconstructFallback): ReconstructedWpState {
      return (
        stateByWp.get(wpIdOf(activities)) ?? {
          ...fallback,
          gaps: [],
          not_yet_created: false,
          created_at: null,
        }
      );
    },
    versionScopeEvents(): VersionScopeEvent[] {
      return [];
    },
  };
}

function mkWp(id: number, est: number): OpWorkPackage {
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    estimatedTime: `PT${est}H`,
    remainingTime: `PT${est}H`,
    updatedAt: "2026-07-15T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: "/api/v3/statuses/1", title: "New" },
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
    },
  } as OpWorkPackage;
}

function act(wpId: number): OpActivity {
  return {
    _type: "Activity",
    id: wpId * 10,
    createdAt: "2026-05-30T09:00:00Z",
    details: [],
    comment: null,
    _links: {
      self: { href: `/api/v3/activities/${wpId * 10}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}` },
      user: { href: null },
    },
  } as OpActivity;
}

function st(assigneeName: string, est: number): ReconstructedWpState {
  return {
    status_name: "New",
    assignee_name: assigneeName,
    // Deliberately a MISLEADING live id — retro identity must ignore it and
    // resolve the NAME instead (SPEC_13 §1).
    assignee_op_id: 999,
    estimated_hours: est,
    remaining_hours: est,
    version_name: null,
    gaps: [],
    not_yet_created: false,
    created_at: "2026-05-30T09:00:00Z",
  };
}

/** Project roster (the NON-admin identity source): "Jan Bily" (id 5) and
 * "Cameron Dalby" (id 7) are members. "Jan Belka" (the SPEC_13 ambiguous
 * pair) is NOT — it must never be auto-mapped to "Jan Bily". */
function membership(id: number, userId: number, name: string): OpMembership {
  return {
    _type: "Membership",
    id,
    _links: {
      principal: { href: `/api/v3/users/${userId}`, title: name },
      project: { href: "/api/v3/projects/100" },
    },
  };
}
const MEMBERSHIPS: OpMembership[] = [
  membership(1, 5, "Jan Bily"),
  membership(2, 7, "Cameron Dalby"),
];

async function setupRetroSprint(t: TestApp): Promise<{ sprintId: number; connectionId: number }> {
  await initVault(t);
  const conn = (await addConnection(t)) as { id: number };
  const created = await t.app.inject({
    method: "POST",
    url: "/api/sprints",
    payload: { name: "Sprint 3.5.039", start_date: "2026-07-06", end_date: "2026-07-20" },
  });
  const sprintId = created.json().id as number;
  await t.repos.sprints.update(sprintId, { is_retrospective: true });
  const seed = await t.app.inject({
    method: "POST",
    url: `/api/sprints/${sprintId}/retro/seed`,
    payload: { kind: "ids", value: "100, 101" },
  });
  expect(seed.statusCode).toBe(200);
  return { sprintId, connectionId: conn.id };
}

type Rec = Record<string, unknown>;

/** Name→identity token so preview and capacity can be compared as SETS. */
function keysFrom(
  rows: Rec[],
  nameOf: (r: Rec) => unknown,
  idOf: (r: Rec) => unknown,
): string[] {
  return rows.map((r) => `${String(nameOf(r))}#${idOf(r) == null ? "null" : String(idOf(r))}`).sort();
}

describe("SPEC_13 retro identity + capacity (revised: person = name)", () => {
  function opData() {
    return {
      memberships: MEMBERSHIPS,
      workPackages: [mkWp(100, 19), mkWp(101, 24)],
      activitiesByWpId: { 100: [act(100)], 101: [act(101)] },
      statuses: [STATUS_NEW],
    };
  }
  const engine = () =>
    fakeEngine(
      new Map<number, ReconstructedWpState>([
        [100, st("Jan Belka", 19)], // NO id anywhere (only "Jan Bily" is a member)
        [101, st("Cameron Dalby", 24)], // exact membership match → id 7
      ]),
    );

  it("THE crux: an unresolvable name STILL gets a full, capacity-settable line (no blocking)", async () => {
    const t = await buildTestApp({ opData: opData(), reconstruct: engine() });
    const { sprintId } = await setupRetroSprint(t);

    const capacity = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })
    ).json();

    // Jan Belka resolves to NO id (never conflated with Jan Bily), yet gets a
    // real line: correct hours, op_user_id null, a settable member_id, and it
    // counts as sprint work.
    const belka = capacity.lines.find((l: Rec) => l.name === "Jan Belka");
    expect(belka).toBeDefined();
    expect(belka.op_user_id).toBeNull();
    expect(belka.planned_hours).toBe(19);
    expect(belka.has_sprint_work).toBe(true);
    expect(typeof belka.member_id).toBe("number");
    // Cameron Dalby got his id opportunistically from the membership roster.
    const dalby = capacity.lines.find((l: Rec) => l.name === "Cameron Dalby");
    expect(dalby.op_user_id).toBe(7);
    expect(dalby.planned_hours).toBe(24);

    // Setting Jan Belka's availability by member_id succeeds — NO extra gate for
    // an id-less person — and is reflected on the next read.
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/sprints/${sprintId}/capacity`,
      payload: { members: [{ member_id: belka.member_id, available_hours: 20, pto_days: 0 }] },
    });
    expect(put.statusCode).toBe(200);

    const after = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })
    ).json();
    const belkaAfter = after.lines.find((l: Rec) => l.name === "Jan Belka");
    expect(belkaAfter.available_hours).toBe(20);
    expect(belkaAfter.op_user_id).toBeNull();
    expect(belkaAfter.planned_hours).toBe(19);
    expect(belkaAfter.member_id).toBe(belka.member_id);
    await t.close();
  });

  it("preview and capacity resolve the SAME people set (name→identity identical)", async () => {
    const t = await buildTestApp({ opData: opData(), reconstruct: engine() });
    const { sprintId } = await setupRetroSprint(t);

    const preview = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/retro/preview` })
    ).json();
    const capacity = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })
    ).json();

    const previewKeys = keysFrom(
      preview.items,
      (c) => c.assignee_at_start_date,
      (c) => c.assignee_op_id_at_start_date,
    );
    const capacityKeys = keysFrom(
      capacity.lines,
      (l) => l.name,
      (l) => l.op_user_id,
    );
    // THE guard (SPEC_13 §1a point 5): identical name→identity map across views.
    expect(previewKeys).toEqual(capacityKeys);
    expect(previewKeys).toEqual(["Cameron Dalby#7", "Jan Belka#null"]);

    // "Jan Belka" is NEVER auto-mapped to "Jan Bily".
    const belka = preview.items.find((c: Rec) => c.wp_op_id === 100);
    expect(belka.assignee_resolution).toBe("unresolved");
    expect(belka.assignee_op_id_at_start_date).toBeNull();
    await t.close();
  });

  it("GET /people lists everyone; an op_user_id alias makes Belka resolve retroactively", async () => {
    const t = await buildTestApp({ opData: opData(), reconstruct: engine() });
    const { sprintId, connectionId } = await setupRetroSprint(t);

    const people = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/people` })
    ).json();
    expect(people).toHaveLength(2);
    const belka = people.find((p: Rec) => p.name === "Jan Belka");
    expect(belka).toMatchObject({ op_user_id: null, hours: 19, ticket_count: 1 });
    const dalby = people.find((p: Rec) => p.name === "Cameron Dalby");
    expect(dalby).toMatchObject({ op_user_id: 7, hours: 24, ticket_count: 1 });

    // Pin "Jan Belka" → the real user id 5 (the escape hatch for a shared name).
    const aliasRes = await t.app.inject({
      method: "POST",
      url: "/api/user-aliases",
      payload: { connection_id: connectionId, journal_name: "Jan Belka", op_user_id: 5 },
    });
    expect(aliasRes.statusCode).toBe(200);

    // Next read resolves FRESH: Jan Belka's 19h now carries id 5.
    const peopleAfter = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/people` })
    ).json();
    expect(peopleAfter.find((p: Rec) => p.name === "Jan Belka").op_user_id).toBe(5);
    const capacity = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })
    ).json();
    const line5 = capacity.lines.find((l: Rec) => l.op_user_id === 5);
    expect(line5.planned_hours).toBe(19);

    // Deleting the alias reverts it — resolution is never baked in.
    const aliasId = aliasRes.json().id;
    const del = await t.app.inject({ method: "DELETE", url: `/api/user-aliases/${aliasId}` });
    expect(del.json().deleted).toBe(true);
    const reverted = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/people` })
    ).json();
    expect(reverted.find((p: Rec) => p.name === "Jan Belka").op_user_id).toBeNull();
    await t.close();
  });

  it("a merge_into_name alias folds an old name's hours under a current person", async () => {
    const t = await buildTestApp({ opData: opData(), reconstruct: engine() });
    const { sprintId, connectionId } = await setupRetroSprint(t);

    // "Jan Belka" is a renamed spelling of "Cameron Dalby" (contrived): fold
    // it under that current display name, which itself resolves to id 7.
    const aliasRes = await t.app.inject({
      method: "POST",
      url: "/api/user-aliases",
      payload: {
        connection_id: connectionId,
        journal_name: "Jan Belka",
        merge_into_name: "Cameron Dalby",
      },
    });
    expect(aliasRes.statusCode).toBe(200);

    // Now ALL 43h (19 + 24) sit on Cameron Dalby (id 7); no Jan Belka line.
    const capacity = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/capacity` })
    ).json();
    expect(capacity.lines.some((l: Rec) => l.name === "Jan Belka")).toBe(false);
    const dalby = capacity.lines.find((l: Rec) => l.op_user_id === 7);
    expect(dalby.planned_hours).toBe(43);

    const people = (
      await t.app.inject({ method: "GET", url: `/api/sprints/${sprintId}/people` })
    ).json();
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ name: "Cameron Dalby", op_user_id: 7, hours: 43 });
    await t.close();
  });

  it("POST /user-aliases with NEITHER op_user_id nor merge_into_name is rejected", async () => {
    const t = await buildTestApp({ opData: opData(), reconstruct: engine() });
    const { connectionId } = await setupRetroSprint(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/user-aliases",
      payload: { connection_id: connectionId, journal_name: "Someone" },
    });
    expect(res.statusCode).toBe(400);
    await t.close();
  });
});
