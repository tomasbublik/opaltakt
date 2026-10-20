import { describe, expect, it } from "vitest";
import { openDb } from "@osp/db";
import { instant } from "../test-utils";
import type {
  OpActivity,
  OpClient,
  OpStatus,
  OpUser,
  OpVersion,
  OpWorkPackage,
  ReconstructedWpState,
  VersionScopeEvent,
} from "@osp/op-client";
import { createRetroService } from "./retro";
import type { ReconstructEngine } from "./reconstruct";
import { buildTestApp } from "../test-utils";

/**
 * SPEC_12 — retrospective replay, rebuild-burndown, pre-delete export.
 * Service-level tests drive createRetroService directly against an in-memory DB
 * with a deterministic fake reconstruction engine + a canned OP client (no OP
 * round-trips) — the §0 guardrail's :memory: convention.
 */

const NOW = new Date("2026-07-15T10:00:00Z");
const now = (): Date => NOW;

const STATUSES: OpStatus[] = [
  { _type: "Status", id: 1, name: "New", isClosed: false },
  { _type: "Status", id: 2, name: "In progress", isClosed: false },
  { _type: "Status", id: 3, name: "Tested", isClosed: false },
  { _type: "Status", id: 7, name: "Closed", isClosed: true },
];

function coll<T>(elements: T[]) {
  return {
    _type: "Collection" as const,
    total: elements.length,
    count: elements.length,
    pageSize: 100,
    offset: 1,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

function mkWp(
  id: number,
  statusId: number,
  opts: { est?: number | null; rem?: number | null; versionId?: number; versionName?: string } = {},
): OpWorkPackage {
  const status = STATUSES.find((s) => s.id === statusId)!;
  return {
    _type: "WorkPackage",
    id,
    subject: `WP ${id}`,
    estimatedTime: opts.est != null ? `PT${opts.est}H` : null,
    remainingTime: opts.rem != null ? `PT${opts.rem}H` : null,
    updatedAt: "2026-07-15T00:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${id}` },
      status: { href: `/api/v3/statuses/${statusId}`, title: status.name },
      type: { href: "/api/v3/types/1", title: "Task" },
      project: { href: "/api/v3/projects/100", title: "Project A" },
      ...(opts.versionId != null
        ? { version: { href: `/api/v3/versions/${opts.versionId}`, title: opts.versionName } }
        : {}),
    },
  };
}

/** One (empty-details) activity carrying the WP href so the fake engine can key
 * per ticket. */
// Default creation BEFORE any start_date used below (2026-06-01 / 2026-07-13),
// so a fixture ticket is treated as a real baseline (existed at start_date), not
// a SPEC_13 §2 "created after start_date" scope addition.
function act(wpId: number, id: number, createdAt = "2026-05-30T09:00:00Z"): OpActivity {
  return {
    _type: "Activity",
    id,
    createdAt,
    details: [],
    comment: null,
    _links: {
      self: { href: `/api/v3/activities/${id}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}` },
      user: { href: null },
    },
  };
}

function wpIdOf(activities: OpActivity[]): number {
  const href = activities[0]?._links.workPackage.href ?? null;
  const m = href ? /work_packages\/(\d+)/.exec(href) : null;
  return m ? Number(m[1]) : 0;
}

function fakeEngine(
  stateByWp: Map<number, ReconstructedWpState>,
  churnByWp?: Map<number, VersionScopeEvent[]>,
): ReconstructEngine {
  return {
    stateAtDate(activities, _statusById, _targetDate, fallback): ReconstructedWpState {
      return (
        stateByWp.get(wpIdOf(activities)) ?? {
          ...fallback,
          gaps: [],
          not_yet_created: false,
          created_at: null,
        }
      );
    },
    versionScopeEvents(activities, _versionName): VersionScopeEvent[] {
      return churnByWp?.get(wpIdOf(activities)) ?? [];
    },
  };
}

interface FakeOpCfg {
  versions?: OpVersion[];
  workPackages?: OpWorkPackage[];
  activitiesByWpId?: Record<number, OpActivity[]>;
  timeEntries?: ReturnType<typeof coll> extends never ? never : any[];
  users?: OpUser[];
  memberships?: any[];
}

function fakeOp(cfg: FakeOpCfg): OpClient {
  const wps = cfg.workPackages ?? [];
  return {
    request: <T>() => Promise.resolve(undefined as T),
    getCurrentUser: () => Promise.resolve({ _type: "User", id: 1, name: "T" }),
    getProjects: () => Promise.resolve(coll([]) as any),
    getWorkPackages: (query) => {
      const filters = (query?.filters ?? []) as any[];
      const idF = filters.find((f) => f && typeof f === "object" && "id" in f);
      const verF = filters.find((f) => f && typeof f === "object" && "version" in f);
      let out = wps;
      if (idF) {
        const ids = new Set((idF.id.values ?? []).map((v: string) => Number(v)));
        out = out.filter((w) => ids.has(w.id));
      }
      if (verF) {
        const vids = new Set((verF.version.values ?? []).map((v: string) => Number(v)));
        out = out.filter((w) => {
          const m = /versions\/(\d+)/.exec(w._links.version?.href ?? "");
          return m ? vids.has(Number(m[1])) : false;
        });
      }
      return Promise.resolve(coll(out) as any);
    },
    getTimeEntries: () => Promise.resolve(coll(cfg.timeEntries ?? []) as any),
    getVersions: () => Promise.resolve(coll(cfg.versions ?? []) as any),
    getStatuses: () => Promise.resolve(coll(STATUSES) as any),
    getWorkPackageSchema: () => Promise.resolve({ _type: "Schema" } as any),
    getActivities: (wpId: number) =>
      Promise.resolve(coll(cfg.activitiesByWpId?.[wpId] ?? []) as any),
    getUser: () => Promise.resolve(null),
    getUsers: () => Promise.resolve(coll(cfg.users ?? []) as any),
    getMemberships: () => Promise.resolve(coll(cfg.memberships ?? []) as any),
  };
}

function timeEntry(id: number, wpId: number, hours: number, spentOn: string) {
  return {
    _type: "TimeEntry",
    id,
    hours: `PT${hours}H`,
    spentOn,
    _links: {
      self: { href: `/api/v3/time_entries/${id}` },
      workPackage: { href: `/api/v3/work_packages/${wpId}` },
      user: { href: null },
    },
  };
}

async function setup(cfg: FakeOpCfg, engine: ReconstructEngine) {
  const { repositories: repos, close } = await openDb({ ephemeral: true });
  await repos.connections.create({
    base_url: "https://mock.example.com",
    label: "mock",
    token_ct: "x",
    token_nonce: "y",
    token_tag: "z",
    default_project_op_id: 100,
  });
  const service = createRetroService({
    repos,
    reconstruct: engine,
    buildClientForConnection: () => Promise.resolve(fakeOp(cfg)),
    now,
  });
  return { repos, service, close };
}

function state(over: Partial<ReconstructedWpState>): ReconstructedWpState {
  return {
    status_name: "In progress",
    assignee_name: "Ann",
    assignee_op_id: 10,
    estimated_hours: 8,
    remaining_hours: 8,
    version_name: "3.5.039",
    gaps: [],
    not_yet_created: false,
    created_at: "2026-05-30T09:00:00Z",
    ...over,
  };
}

describe("retro seed / preview (SPEC_12 §2)", () => {
  it("seeds candidates from an OP version regardless of current status (incl. tested)", async () => {
    const stateByWp = new Map<number, ReconstructedWpState>([
      [1001, state({ status_name: "In progress", estimated_hours: 8 })],
      // A `tested` ticket (hidden from the backlog) is still pulled by version.
      [1002, state({ status_name: "Tested", estimated_hours: 5, gaps: ["estimated_hours"] })],
    ]);
    const { repos, service, close } = await setup(
      {
        versions: [{ _type: "Version", id: 5, name: "3.5.039", _links: { self: { href: "/v/5" } } }],
        workPackages: [
          mkWp(1001, 2, { est: 8, rem: 8, versionId: 5, versionName: "3.5.039" }),
          mkWp(1002, 3, { est: 5, rem: 2, versionId: 5, versionName: "3.5.039" }),
        ],
        activitiesByWpId: { 1001: [act(1001, 1)], 1002: [act(1002, 2)] },
      },
      fakeEngine(stateByWp),
    );
    const sprint = await repos.sprints.create({
      name: "Sprint 3.5.039",
      start_date: "2026-06-01",
      end_date: "2026-06-05",
      status: "planning",
      capacity_mode: "per_person",
    });
    await repos.sprints.update(sprint.id, { is_retrospective: true });

    const res = await service.seed(sprint.id, { kind: "version", value: "3.5.039" });
    expect(res.candidates.map((c) => c.wp_op_id).sort()).toEqual([1001, 1002]);
    const tested = res.candidates.find((c) => c.wp_op_id === 1002)!;
    expect(tested.status_at_start_date).toBe("Tested");
    expect(tested.reconstructed).toBe(true);
    // gaps remapped to candidate field names (estimated_hours → estimate_at_start_date).
    expect(tested.gaps).toEqual(["estimate_at_start_date"]);

    // sprint_items persisted (origin=baseline, planned = reconstructed estimate).
    const items = await repos.sprintItems.listBySprint(sprint.id);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.origin === "baseline")).toBe(true);
    expect(items.find((i) => i.wp_op_id === 1001)?.planned_hours).toBe(8);
    // ticket_baseline captured at start_date, reconstructed flag set per gaps.
    const baselines = await repos.ticketBaselines.listBySprint(sprint.id);
    expect(baselines).toHaveLength(2);
    expect(baselines.find((b) => b.wp_op_id === 1002)?.reconstructed).toBe(true);
    expect(baselines.find((b) => b.wp_op_id === 1001)?.reconstructed).toBe(false);
    // seed kind/value recorded on the sprint (SPEC_12 §7).
    const after = await repos.sprints.getById(sprint.id);
    expect(after?.retro_seed_kind).toBe("version");
    expect(after?.retro_seed_value).toBe("3.5.039");
    await close();
  });

  it("a ticket created AFTER start_date is a scope addition, not a baseline (SPEC_13 §2)", async () => {
    // WP 11762-style: reconstructed state at start_date says "didn't exist yet".
    const stateByWp = new Map<number, ReconstructedWpState>([
      [1001, state({ estimated_hours: 8 })], // real baseline
      [
        11762,
        state({
          estimated_hours: 4,
          not_yet_created: true,
          created_at: "2026-07-07T03:41:00Z",
        }),
      ],
    ]);
    const { repos, service, close } = await setup(
      {
        workPackages: [mkWp(1001, 1, { est: 8, rem: 8 }), mkWp(11762, 3, { est: 4, rem: 4 })],
        activitiesByWpId: { 1001: [act(1001, 1)], 11762: [act(11762, 2, "2026-07-07T03:41:00Z")] },
      },
      fakeEngine(stateByWp),
    );
    const sprint = await repos.sprints.create({
      name: "Sprint 3.5.039",
      start_date: "2026-07-06",
      end_date: "2026-07-20",
      status: "planning",
      capacity_mode: "per_person",
    });
    await repos.sprints.update(sprint.id, { is_retrospective: true });

    const res = await service.seed(sprint.id, { kind: "ids", value: "1001, 11762" });
    const created = res.candidates.find((c) => c.wp_op_id === 11762)!;
    expect(created.created_after_start_date).toBe(true);
    expect(created.created_at_op).toBe("2026-07-07T03:41:00Z");

    // Persisted as origin=added_mid_sprint (a scope addition), NOT a baseline.
    const items = await repos.sprintItems.listBySprint(sprint.id);
    expect(items.find((i) => i.wp_op_id === 11762)?.origin).toBe("added_mid_sprint");
    expect(items.find((i) => i.wp_op_id === 1001)?.origin).toBe("baseline");
    const baselines = await repos.ticketBaselines.listBySprint(sprint.id);
    expect(baselines.find((b) => b.wp_op_id === 11762)?.origin).toBe("added_mid_sprint");

    // After activation/replay it is NOT counted in the frozen baseline total.
    const run = await repos.sprintUpdateRuns.start(sprint.id, "activation", "manual");
    await service.runReplay(sprint.id, run.id);
    const after = await repos.sprints.getById(sprint.id);
    expect(after?.baseline_total_hours).toBe(8); // only WP 1001
    const items2 = await repos.sprintItems.listBySprint(sprint.id);
    expect(items2.find((i) => i.wp_op_id === 11762)?.origin).toBe("added_mid_sprint");
    await close();
  });

  it("preview re-reconstructs current items to start_date with NO writes", async () => {
    const stateByWp = new Map([[2001, state({ status_name: "New", estimated_hours: 4 })]]);
    const { repos, service, close } = await setup(
      {
        workPackages: [mkWp(2001, 1, { est: 4, rem: 4 })],
        activitiesByWpId: { 2001: [act(2001, 1)] },
      },
      fakeEngine(stateByWp),
    );
    const sprint = await repos.sprints.create({
      name: "S",
      start_date: "2026-06-01",
      end_date: "2026-06-05",
      status: "planning",
      capacity_mode: "per_person",
    });
    await repos.sprints.update(sprint.id, { is_retrospective: true });
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 2001,
      planned_hours: 4,
      outcome: "planned",
      origin: "baseline",
    });

    const preview = await service.preview(sprint.id);
    expect(preview.start_date).toBe("2026-06-01");
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]?.status_at_start_date).toBe("New");
    // No baseline row written by preview (read-only).
    expect(await repos.ticketBaselines.listBySprint(sprint.id)).toHaveLength(0);
    await close();
  });
});

describe("retro activation replay (SPEC_12 §2)", () => {
  async function seededRetroSprint(
    startDate: string,
    endDate: string,
    extra?: { seedKind?: "version"; churn?: Map<number, VersionScopeEvent[]> },
  ) {
    const stateByWp = new Map<number, ReconstructedWpState>([
      [1001, state({ status_name: "In progress", estimated_hours: 8, remaining_hours: 8 })],
      [1002, state({ status_name: "In progress", estimated_hours: 8, remaining_hours: 8 })],
    ]);
    const { repos, service, close } = await setup(
      {
        // Current live state is CLOSED (proves closure uses live state, replay
        // uses reconstructed In-progress state).
        workPackages: [mkWp(1001, 7, { est: 8, rem: 0 }), mkWp(1002, 7, { est: 8, rem: 0 })],
        activitiesByWpId: { 1001: [act(1001, 1)], 1002: [act(1002, 2)] },
        timeEntries: [timeEntry(1, 1001, 4, "2026-06-02")],
      },
      fakeEngine(stateByWp, extra?.churn),
    );
    const sprint = await repos.sprints.create({
      name: "S",
      start_date: startDate,
      end_date: endDate,
      status: "planning",
      capacity_mode: "per_person",
    });
    await repos.sprints.update(sprint.id, {
      is_retrospective: true,
      ...(extra?.seedKind ? { retro_seed_kind: extra.seedKind, retro_seed_value: "3.5.039" } : {}),
    });
    for (const wp of [1001, 1002]) {
      await repos.sprintItems.add({
        sprint_id: sprint.id,
        wp_op_id: wp,
        planned_hours: 8,
        outcome: "planned",
        origin: "baseline",
      });
    }
    return { repos, service, close, sprint };
  }

  it("past window → auto-locks with a closure report; every day source=reconstructed", async () => {
    const { repos, service, close, sprint } = await seededRetroSprint("2026-06-01", "2026-06-05");
    const run = await repos.sprintUpdateRuns.start(sprint.id, "activation", "manual");
    await service.runReplay(sprint.id, run.id);

    const after = await repos.sprints.getById(sprint.id);
    expect(after?.status).toBe("closed");
    expect(after?.is_locked).toBe(true);
    expect(after?.lock_reason).toBe("end_date");
    expect(after?.retro_replayed_at).not.toBeNull();
    expect(after?.baseline_total_hours).toBe(16);

    const snaps = await repos.burndown.listBySprint(sprint.id);
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.every((s) => s.source === "reconstructed")).toBe(true);
    // Remaining = Σ reconstructed remaining for In-progress+estimate tickets = 16.
    expect(snaps.every((s) => s.remaining_hours === 16)).toBe(true);
    // Logged is cumulative: 0 before 2026-06-02, 4 from 2026-06-02 on.
    const jun1 = snaps.find((s) => s.snapshot_date === "2026-06-01");
    const jun2 = snaps.find((s) => s.snapshot_date === "2026-06-02");
    const jun3 = snaps.find((s) => s.snapshot_date === "2026-06-03");
    expect(jun1?.logged_hours).toBe(0);
    expect(jun2?.logged_hours).toBe(4);
    expect(jun3?.logged_hours).toBe(4);
    // Closure report generated (live state Closed → both done).
    expect(await repos.closureReports.getBySprint(sprint.id)).not.toBeNull();

    const finished = await repos.sprintUpdateRuns.latestBySprint(sprint.id);
    expect(finished?.status).toBe("success");
    await close();
  });

  it("still-open window → ends active and accepts a normal /update afterward", async () => {
    const { repos, service, close, sprint } = await seededRetroSprint("2026-07-13", "2026-07-20");
    const run = await repos.sprintUpdateRuns.start(sprint.id, "activation", "manual");
    await service.runReplay(sprint.id, run.id);

    const after = await repos.sprints.getById(sprint.id);
    expect(after?.status).toBe("active");
    expect(after?.is_locked).toBe(false);
    expect(after?.activated_at).not.toBeNull();
    expect(after?.retro_replayed_at).not.toBeNull();

    const snaps = await repos.burndown.listBySprint(sprint.id);
    expect(snaps.every((s) => s.source === "reconstructed")).toBe(true);
    // Window replayed only up to today (2026-07-15), not the full end_date.
    expect(snaps.every((s) => s.snapshot_date <= "2026-07-15")).toBe(true);
    await close();
  });

  it("version-seeded ticket whose version changed AFTER start_date → origin=added_mid_sprint", async () => {
    const churn = new Map<number, VersionScopeEvent[]>([
      [1002, [{ occurred_at: "2026-06-03T09:00:00Z", direction: "entered" }]],
    ]);
    const { repos, service, close, sprint } = await seededRetroSprint("2026-06-01", "2026-06-05", {
      seedKind: "version",
      churn,
    });
    const run = await repos.sprintUpdateRuns.start(sprint.id, "activation", "manual");
    await service.runReplay(sprint.id, run.id);

    const items = await repos.sprintItems.listBySprint(sprint.id);
    expect(items.find((i) => i.wp_op_id === 1001)?.origin).toBe("baseline");
    expect(items.find((i) => i.wp_op_id === 1002)?.origin).toBe("added_mid_sprint");
    const baselines = await repos.ticketBaselines.listBySprint(sprint.id);
    expect(baselines.find((b) => b.wp_op_id === 1002)?.origin).toBe("added_mid_sprint");
    // Only the baseline ticket (1001) counts toward the frozen baseline total.
    const after = await repos.sprints.getById(sprint.id);
    expect(after?.baseline_total_hours).toBe(8);
    await close();
  });

  it("version-seeded ticket whose version changed AWAY after start_date stops counting toward Remaining from its exit day (mirrors the live burndown's removed_mid_sprint exclusion)", async () => {
    const churn = new Map<number, VersionScopeEvent[]>([
      [1002, [{ occurred_at: "2026-06-03T09:00:00Z", direction: "left" }]],
    ]);
    const { repos, service, close, sprint } = await seededRetroSprint("2026-06-01", "2026-06-05", {
      seedKind: "version",
      churn,
    });
    const run = await repos.sprintUpdateRuns.start(sprint.id, "activation", "manual");
    await service.runReplay(sprint.id, run.id);

    const items = await repos.sprintItems.listBySprint(sprint.id);
    expect(items.find((i) => i.wp_op_id === 1002)?.outcome).toBe("removed_mid_sprint");

    const snaps = await repos.burndown.listBySprint(sprint.id);
    const jun2 = snaps.find((s) => s.snapshot_date === "2026-06-02")!;
    const jun3 = snaps.find((s) => s.snapshot_date === "2026-06-03")!;
    // Before the exit day: both tickets in scope, remaining = 8+8=16, total_count=2.
    expect(jun2.remaining_hours).toBe(16);
    expect(jun2.total_count).toBe(2);
    // From the exit day on: 1002 excluded entirely (remaining AND total_count),
    // exactly like the live path's `outcome !== "removed_mid_sprint"` filter —
    // NOT still contributing after departure.
    expect(jun3.remaining_hours).toBe(8);
    expect(jun3.total_count).toBe(1);
    await close();
  });
});

describe("rebuild-burndown (SPEC_12 §5)", () => {
  it("recomputes reconstructed rows and NEVER unlocks a locked sprint", async () => {
    const stateByWp = new Map([[3001, state({ status_name: "In progress", estimated_hours: 8, remaining_hours: 6 })]]);
    const { repos, service, close } = await setup(
      {
        workPackages: [mkWp(3001, 2, { est: 8, rem: 6 })],
        activitiesByWpId: { 3001: [act(3001, 1)] },
      },
      fakeEngine(stateByWp),
    );
    const sprint = await repos.sprints.create({
      name: "S",
      start_date: "2026-06-01",
      end_date: "2026-06-05",
      status: "planning",
      capacity_mode: "per_person",
    });
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 3001,
      planned_hours: 8,
      outcome: "planned",
      origin: "baseline",
    });
    // Activate then close (locked) so we can prove rebuild leaves the lock intact.
    await repos.sprints.activate(sprint.id, "2026-06-01T09:00:00Z", 8);
    await repos.sprints.close(sprint.id, 8, "2026-06-05T18:00:00Z", "finished");

    const res = await service.rebuildBurndown(sprint.id);
    expect(res.sprint_id).toBe(sprint.id);
    const snaps = await repos.burndown.listBySprint(sprint.id);
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.every((s) => s.source === "reconstructed")).toBe(true);
    expect(snaps.every((s) => s.remaining_hours === 6)).toBe(true);

    // The whole point: status/lock untouched.
    const after = await repos.sprints.getById(sprint.id);
    expect(after?.status).toBe("closed");
    expect(after?.is_locked).toBe(true);
    expect(instant(after?.locked_at)).toBe(instant("2026-06-05T18:00:00Z"));
    await close();
  });

  // Increment 25 (SPEC_25 §4/§10): rebuildBurndown is origin-aware — an
  // added_retroactively item only counts from its OWN backdated added_at day, so
  // the scope bump lands on the real day, not day 1. Every other origin counts on
  // every day (unchanged).
  it("counts an added_retroactively item ONLY from its backdated added_at day onward", async () => {
    const stateByWp = new Map([
      [4001, state({ status_name: "In progress", estimated_hours: 8, remaining_hours: 8 })],
      [4002, state({ status_name: "In progress", estimated_hours: 5, remaining_hours: 5 })],
    ]);
    const { repos, service, close } = await setup(
      {
        workPackages: [mkWp(4001, 2, { est: 8, rem: 8 }), mkWp(4002, 2, { est: 5, rem: 5 })],
        activitiesByWpId: { 4001: [act(4001, 1)], 4002: [act(4002, 2)] },
      },
      fakeEngine(stateByWp),
    );
    const sprint = await repos.sprints.create({
      name: "S",
      start_date: "2026-06-01",
      end_date: "2026-06-05",
      status: "planning",
      capacity_mode: "per_person",
    });
    // A plain baseline ticket (counts on every day) + a retroactively-added
    // ticket whose real work started on 2026-06-03 (backdated added_at).
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 4001,
      planned_hours: 8,
      outcome: "planned",
      origin: "baseline",
    });
    await repos.sprintItems.add({
      sprint_id: sprint.id,
      wp_op_id: 4002,
      planned_hours: 5,
      outcome: "planned",
      origin: "added_retroactively",
      added_at: "2026-06-03T00:00:00Z",
      retro_source: "first_time_entry",
    });
    await repos.sprints.activate(sprint.id, "2026-06-01T09:00:00Z", 13);

    await service.rebuildBurndown(sprint.id);
    const snaps = await repos.burndown.listBySprint(sprint.id);
    const day = (d: string) => snaps.find((s) => s.snapshot_date === d)!;
    // Before the backdated day: only the baseline ticket is in scope.
    expect(day("2026-06-01").total_count).toBe(1);
    expect(day("2026-06-02").total_count).toBe(1);
    // On/after the backdated day: the retro ticket joins the scope.
    expect(day("2026-06-03").total_count).toBe(2);
    expect(day("2026-06-04").total_count).toBe(2);
    await close();
  });
});

describe("retro route guards + pre-delete export (SPEC_12 §2/§6)", () => {
  it("retro/seed 409s SPRINT_NOT_RETROSPECTIVE on a plain sprint", async () => {
    const t = await buildTestApp();
    const created = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Plain", start_date: "2026-06-01", end_date: "2026-06-05" },
    });
    const id = created.json().id;
    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${id}/retro/seed`,
      payload: { kind: "version", value: "3.5.039" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SPRINT_NOT_RETROSPECTIVE");
    await t.close();
  });

  it("retro/seed 409s SPRINT_NOT_PLANNING on an active retrospective sprint", async () => {
    const t = await buildTestApp();
    const created = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Retro", start_date: "2026-06-01", end_date: "2026-06-05" },
    });
    const id = created.json().id;
    await t.repos.sprints.update(id, { is_retrospective: true });
    await t.repos.sprints.update(id, { status: "active" });
    const res = await t.app.inject({
      method: "POST",
      url: `/api/sprints/${id}/retro/seed`,
      payload: { kind: "ids", value: "1,2" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SPRINT_NOT_PLANNING");
    await t.close();
  });

  it("DELETE writes a JSON export that round-trips the sprint before cascading", async () => {
    let written: { path: string; data: string } | null = null;
    const t = await buildTestApp({
      sprintExport: {
        exportsDir: "/tmp/osp-retro-export-ok",
        writeFile: (path, data) => {
          written = { path, data };
          return Promise.resolve();
        },
        mkdir: () => Promise.resolve(),
      },
    });
    const created = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Sprint 3.5.039", start_date: "2026-06-01", end_date: "2026-06-05" },
    });
    const id = created.json().id;
    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/${id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().export_path).toMatch(/^exports\/sprint-sprint-3-5-039-.*\.json$/);
    expect(written).not.toBeNull();
    const bundle = JSON.parse(written!.data);
    expect(bundle.sprint.id).toBe(id);
    expect(bundle).toHaveProperty("items");
    expect(bundle).toHaveProperty("baselines");
    expect(bundle).toHaveProperty("burndown");
    expect(bundle).toHaveProperty("capacity");
    expect(bundle).toHaveProperty("closure");
    // Sprint really gone after a successful export.
    expect(await t.repos.sprints.getById(id)).toBeNull();
    await t.close();
  });

  it("a failed export ABORTS the delete — sprint + items remain", async () => {
    const t = await buildTestApp({
      sprintExport: {
        exportsDir: "/tmp/osp-retro-export-fail",
        writeFile: () => Promise.reject(new Error("disk full")),
        mkdir: () => Promise.resolve(),
      },
    });
    const created = await t.app.inject({
      method: "POST",
      url: "/api/sprints",
      payload: { name: "Keep me", start_date: "2026-06-01", end_date: "2026-06-05" },
    });
    const id = created.json().id;
    const del = await t.app.inject({ method: "DELETE", url: `/api/sprints/${id}` });
    expect(del.statusCode).toBe(500);
    // NEVER delete without a successful export first (SPEC_12 §6).
    expect(await t.repos.sprints.getById(id)).not.toBeNull();
    await t.close();
  });
});
