/**
 * Structural validation of the S1–S6 scenario DATA against the frozen Phase-0
 * contract (fixtures/scenario-types.ts). No engine involved: these tests walk
 * the seeds + timelines the way the engine will, so a scenario that passes
 * here cannot reference an unknown wp/user/version/status key, run days out
 * of order, or violate the "logTime is always paired with setRemaining" rule.
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_STATUSES,
  DEFAULT_PROJECTS,
  type MockEvent,
  type Scenario,
  type WorkPackageSeed,
} from "../scenario-types";
import { scenarios, s4VolatileSprint } from "./index";

// ── Replay: fold the timeline over the seed (contract semantics) ─────────────

interface WpState {
  status: string;
  assignee: string | null;
  accountable: string | null;
  estimated: number | null;
  remaining: number | null;
  version: string | null;
  logged: number;
}

function seedState(wp: WorkPackageSeed): WpState {
  return {
    status: wp.status,
    assignee: wp.assignee ?? null,
    accountable: wp.accountable ?? null,
    estimated: wp.estimatedHours ?? null,
    remaining: wp.remainingHours ?? null,
    version: wp.version ?? null,
    logged: 0,
  };
}

/** Replays the whole timeline; throws on any dangling reference. */
function replay(s: Scenario): Map<string, WpState> {
  const state = new Map<string, WpState>();
  for (const wp of s.seed.workPackages) state.set(wp.key, seedState(wp));
  for (const { events } of s.timeline) {
    for (const e of events) {
      if (e.t === "addWorkPackage") {
        state.set(e.wp.key, seedState(e.wp));
        continue;
      }
      const wp = state.get(e.wp);
      if (!wp) throw new Error(`${s.name}: event references unknown WP key "${e.wp}"`);
      switch (e.t) {
        case "setStatus":
          wp.status = e.status;
          break;
        case "reassign":
          if (e.assignee !== undefined) wp.assignee = e.assignee;
          if (e.accountable !== undefined) wp.accountable = e.accountable;
          break;
        case "logTime":
          wp.logged += e.hours;
          break;
        case "setRemaining":
          wp.remaining = e.hours;
          break;
        case "setEstimate":
          wp.estimated = e.hours;
          break;
        case "setVersion":
          wp.version = e.version;
          break;
      }
    }
  }
  return state;
}

function statusNames(s: Scenario): Set<string> {
  return new Set((s.seed.statuses ?? CANONICAL_STATUSES).map((st) => st.name));
}

function isClosedStatus(s: Scenario, name: string): boolean {
  const st = (s.seed.statuses ?? CANONICAL_STATUSES).find((x) => x.name === name);
  if (!st) throw new Error(`${s.name}: unknown status "${name}"`);
  return st.isClosed;
}

function validateWpSeed(
  s: Scenario,
  wp: WorkPackageSeed,
  ctx: { userKeys: Set<string>; versionKeys: Set<string>; projectIds: Set<number> },
): void {
  const where = `${s.name} / WP "${wp.key}"`;
  expect(statusNames(s).has(wp.status), `${where}: unknown status "${wp.status}"`).toBe(true);
  expect(ctx.projectIds.has(wp.project), `${where}: unknown project ${wp.project}`).toBe(true);
  for (const link of ["assignee", "accountable"] as const) {
    const user = wp[link];
    if (typeof user === "string") {
      expect(ctx.userKeys.has(user), `${where}: unknown ${link} "${user}"`).toBe(true);
    }
  }
  if (typeof wp.version === "string") {
    expect(ctx.versionKeys.has(wp.version), `${where}: unknown version "${wp.version}"`).toBe(true);
  }
  if (wp.estimatedHours != null) expect(wp.estimatedHours, where).toBeGreaterThanOrEqual(0);
  if (wp.remainingHours != null) expect(wp.remainingHours, where).toBeGreaterThanOrEqual(0);
}

// ── Cross-scenario invariants ────────────────────────────────────────────────

describe("scenario registry", () => {
  it("exports all twenty-one scenarios (S1-S6 + S7 comment roundtrip + S8 retro scope churn + S9 role closure + S10 developer work attribution + S11 effective estimate + S12 handoff attribution + S13 sprint list dimming + S14 backlog filter matrix + S15 status casing divergence + S16/S17 assignee identity collision + S18 nightly AU retroactive add + S19/S20 sync coverage + S21 Increment-30 current-scope Planned) with unique, URL-safe names", () => {
    expect(scenarios.map((s) => s.name)).toEqual([
      "s1-accountable-handoff",
      "s2-status-spectrum",
      "s3-epic-over-40h",
      "s4-volatile-sprint",
      "s5-burndown-happy",
      "s6-carryover",
      "s7-tester-roundtrip",
      "s8-retro-scope-churn",
      "s9-role-closure",
      "s10-developer-work-attribution",
      "s11-effective-estimate",
      "s12-handoff-attribution",
      "s13-sprint-list-dimming",
      "s14-backlog-filter-matrix",
      "s15-status-casing-divergence",
      "s16-assignee-collision-mock",
      "s17-assignee-collision-acme",
      "s18-nightly-au-ticket",
      "s19-sync-coverage",
      "s20-sync-coverage-orphaned",
      "s21-inc30-current-scope-planned",
    ]);
    for (const s of scenarios) expect(s.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(new Set(scenarios.map((s) => s.name)).size).toBe(scenarios.length);
  });

  it("every scenario has a meaningful description and a valid start date", () => {
    for (const s of scenarios) {
      expect(s.description.length, s.name).toBeGreaterThan(80);
      expect(s.startDate, s.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(s.startDate)), s.name).toBe(false);
    }
  });
});

/** SPEC_23 §2 fixtures that intentionally forgo the common dev/tester/customer
 * cast (they model a cross-server OP-user-id collision instead). */
const IDENTITY_COLLISION_SCENARIOS = new Set([
  "s16-assignee-collision-mock",
  "s17-assignee-collision-acme",
]);

describe.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, s) => {
  const userKeys = new Set(s.seed.users.map((u) => u.key));
  const versionKeys = new Set(s.seed.versions.map((v) => v.key));
  const projectIds = new Set((s.seed.projects ?? DEFAULT_PROJECTS).map((p) => p.id));
  const ctx = { userKeys, versionKeys, projectIds };

  it("seeds exactly one /users/me identity with unique user ids (common cast, unless an identity-collision fixture)", () => {
    // SPEC_23 §2's identity-collision fixtures (s16/s17) DELIBERATELY don't use
    // the common dev/tester/customer cast — they need OP user id 3 to be Alan
    // Turing / Cameron Dalby (the confirmed cross-server id-3 collision), so
    // the cast keys can't be present. The universal invariants (exactly one
    // me:true, ids unique WITHIN the server) still hold for them.
    if (IDENTITY_COLLISION_SCENARIOS.has(s.name)) {
      expect(s.seed.users.filter((u) => u.me)).toHaveLength(1);
    } else {
      for (const key of ["dev", "tester", "customer"]) expect(userKeys.has(key)).toBe(true);
      expect(s.seed.users.filter((u) => u.me).map((u) => u.key)).toEqual(["dev"]);
    }
    expect(new Set(s.seed.users.map((u) => u.id)).size).toBe(s.seed.users.length);
  });

  it("has unique seed keys and explicit WP ids below the auto-assign range", () => {
    const keys = s.seed.workPackages.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = s.seed.workPackages.map((w) => w.id).filter((id): id is number => id != null);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(s.seed.versions.map((v) => v.key)).size).toBe(s.seed.versions.length);
  });

  it("every seed WP references known statuses/users/versions/projects", () => {
    for (const wp of s.seed.workPackages) validateWpSeed(s, wp, ctx);
    for (const te of s.seed.timeEntries ?? []) {
      expect(s.seed.workPackages.some((w) => w.key === te.wp)).toBe(true);
      expect(userKeys.has(te.user)).toBe(true);
      expect(te.hours).toBeGreaterThan(0);
    }
  });

  it("timeline days are non-negative, unique and sorted ascending", () => {
    const days = s.timeline.map((d) => d.day);
    for (const day of days) {
      expect(Number.isInteger(day)).toBe(true);
      expect(day).toBeGreaterThanOrEqual(0);
    }
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(new Set(days).size).toBe(days.length);
  });

  it("every event resolves against the seed (accumulating addWorkPackage keys day by day)", () => {
    const known = new Set(s.seed.workPackages.map((w) => w.key));
    for (const { day, events } of s.timeline) {
      for (const e of events) {
        const where = `${s.name} day ${day}`;
        if (e.t === "addWorkPackage") {
          expect(known.has(e.wp.key), `${where}: duplicate WP key "${e.wp.key}"`).toBe(false);
          validateWpSeed(s, e.wp, ctx);
          known.add(e.wp.key);
          continue;
        }
        expect(known.has(e.wp), `${where}: unknown WP key "${e.wp}"`).toBe(true);
        switch (e.t) {
          case "setStatus":
            expect(statusNames(s).has(e.status), `${where}: status "${e.status}"`).toBe(true);
            break;
          case "reassign":
            for (const user of [e.assignee, e.accountable]) {
              if (typeof user === "string") {
                expect(userKeys.has(user), `${where}: user "${user}"`).toBe(true);
              }
            }
            break;
          case "logTime":
            expect(userKeys.has(e.user), `${where}: user "${e.user}"`).toBe(true);
            expect(e.hours, where).toBeGreaterThan(0);
            break;
          case "comment":
            expect(userKeys.has(e.user), `${where}: user "${e.user}"`).toBe(true);
            expect(e.text.trim().length, where).toBeGreaterThan(0);
            break;
          case "setRemaining":
            expect(e.hours, where).toBeGreaterThanOrEqual(0);
            break;
          case "setEstimate":
            if (e.hours !== null) expect(e.hours, where).toBeGreaterThanOrEqual(0);
            break;
          case "setVersion":
            if (e.version !== null) {
              expect(versionKeys.has(e.version), `${where}: version "${e.version}"`).toBe(true);
            }
            break;
        }
      }
    }
  });

  it("pairs every logTime with an explicit setRemaining on the same WP and day", () => {
    // Contract: logTime does NOT implicitly decrease remaining.
    for (const { day, events } of s.timeline) {
      const remainingSet = new Set(
        events.filter((e) => e.t === "setRemaining").map((e) => e.wp),
      );
      for (const e of events) {
        if (e.t === "logTime") {
          expect(remainingSet.has(e.wp), `${s.name} day ${day}: unpaired logTime on "${e.wp}"`).toBe(true);
        }
      }
    }
  });

  it("the urgent template (when present) is valid", () => {
    if (!s.urgentTemplate) return;
    validateWpSeed(s, { ...s.urgentTemplate, key: "urgent-template-check" }, ctx);
  });
});

// ── Scenario-specific acceptance invariants ──────────────────────────────────

function get(s: Scenario, key: string): { scenario: Scenario; state: WpState } {
  const state = replay(s).get(key);
  if (!state) throw new Error(`${s.name}: no WP "${key}"`);
  return { scenario: s, state };
}

function scenario(name: string): Scenario {
  const s = scenarios.find((x) => x.name === name);
  if (!s) throw new Error(`missing scenario ${name}`);
  return s;
}

describe("S1 accountable-handoff invariants", () => {
  const s1 = scenario("s1-accountable-handoff");

  it("changes the main WP's assignee but NEVER touches any accountable after the seed", () => {
    const reassigns = s1.timeline
      .flatMap((d) => d.events)
      .filter((e): e is Extract<MockEvent, { t: "reassign" }> => e.t === "reassign");
    expect(reassigns.length).toBeGreaterThanOrEqual(1);
    for (const e of reassigns) expect(e.accountable, "accountable must stay seeded").toBeUndefined();
    // The handoff really moves the assignee off the dev…
    const { state } = get(s1, "main");
    expect(state.assignee).not.toBe("dev");
    // …while accountable is still the seeded customer.
    expect(state.accountable).toBe("customer");
  });

  it("ends the main WP in an OPEN dev-done status (never closed)", () => {
    const { state } = get(s1, "main");
    expect(["Developed", "Tested"]).toContain(state.status);
    expect(isClosedStatus(s1, state.status)).toBe(false);
    // All statuses the WP ever passes through are open too.
    for (const e of s1.timeline.flatMap((d) => d.events)) {
      if (e.t === "setStatus" && e.wp === "main") {
        expect(isClosedStatus(s1, e.status), e.status).toBe(false);
      }
    }
  });
});

describe("S2 status-spectrum invariants", () => {
  const s2 = scenario("s2-status-spectrum");

  it("covers all 10 canonical statuses with exactly one WP each", () => {
    expect(s2.seed.workPackages).toHaveLength(CANONICAL_STATUSES.length);
    expect(new Set(s2.seed.workPackages.map((w) => w.status))).toEqual(
      new Set(CANONICAL_STATUSES.map((st) => st.name)),
    );
    expect(s2.timeline).toEqual([]);
  });
});

describe("S3 epic-over-40h invariants", () => {
  const s3 = scenario("s3-epic-over-40h");

  it("seeds the epic at 80h estimated and 80h remaining", () => {
    const epic = s3.seed.workPackages.find((w) => w.key === "epic");
    expect(epic?.estimatedHours).toBe(80);
    expect(epic?.remainingHours).toBe(80);
  });

  it("burns the epic's remaining STRICTLY down to 0 and logs exactly 80h", () => {
    let prev = 80;
    for (const { events } of s3.timeline) {
      for (const e of events) {
        if (e.t === "setRemaining" && e.wp === "epic") {
          expect(e.hours).toBeLessThan(prev);
          prev = e.hours;
        }
      }
    }
    expect(prev).toBe(0);
    const { state } = get(s3, "epic");
    expect(state.logged).toBe(80);
    expect(state.status).toBe("Tested");
  });

  it("is still unfinished at the suggested Sprint A boundary (day 7 = 2026-07-08)", () => {
    let remainingAtBoundary = 80;
    for (const { day, events } of s3.timeline) {
      if (day > 7) break;
      for (const e of events) {
        if (e.t === "setRemaining" && e.wp === "epic") remainingAtBoundary = e.hours;
      }
    }
    expect(remainingAtBoundary).toBeGreaterThan(40); // real carryover, not a sliver
  });
});

describe("S4 volatile-sprint invariants", () => {
  const s4 = s4VolatileSprint;

  it("adds at least 2 URGENT work packages on day 3", () => {
    const day3 = s4.timeline.find((d) => d.day === 3);
    const added = (day3?.events ?? []).filter(
      (e): e is Extract<MockEvent, { t: "addWorkPackage" }> => e.t === "addWorkPackage",
    );
    expect(added.length).toBeGreaterThanOrEqual(2);
    for (const e of added) {
      expect(e.wp.subject).toMatch(/^URGENT: /);
      expect(["High", "Immediate"]).toContain(e.wp.priority);
    }
  });

  it("carries a scenario-flavored urgent template for /__mock/inject-urgent", () => {
    expect(s4.urgentTemplate?.subject).toMatch(/^URGENT: /);
    expect(["High", "Immediate"]).toContain(s4.urgentTemplate?.priority);
  });
});

describe("S5 burndown-happy invariants", () => {
  const s5 = scenario("s5-burndown-happy");

  it("sums ~60h of estimates and finishes EVERYTHING closed with 0 remaining", () => {
    const total = s5.seed.workPackages.reduce((sum, w) => sum + (w.estimatedHours ?? 0), 0);
    expect(total).toBe(60);
    for (const [key, state] of replay(s5)) {
      expect(isClosedStatus(s5, state.status), `${key} should end closed`).toBe(true);
      expect(state.remaining, key).toBe(0);
    }
  });
});

describe("S6 carryover invariants", () => {
  const s6 = scenario("s6-carryover");

  it("seeds a second version (v1.1) as the carryover target", () => {
    expect(s6.seed.versions.map((v) => v.name)).toEqual(["v1.0", "v1.1"]);
    // Every sprint WP starts on v1.0 — moving to v1.1 is the operator's job.
    for (const wp of s6.seed.workPackages) expect(wp.version).toBe("v1_0");
  });

  it("ends with exactly two unfinished WPs: 'On hold' and 'Merge pending'", () => {
    const open = [...replay(s6)].filter(([, st]) => !isClosedStatus(s6, st.status) && st.status !== "Tested");
    expect(new Map(open.map(([k, st]) => [k, st.status]))).toEqual(
      new Map([
        ["sms", "On hold"],
        ["rate-limiter", "Merge pending"],
      ]),
    );
    for (const [, st] of open) expect(st.remaining ?? 0).toBeGreaterThan(0);
    // The finished ones really are finished.
    const doneStatuses = [...replay(s6)]
      .filter(([k]) => k === "dashboard" || k === "browser-pass" || k === "pagination")
      .map(([, st]) => st.status);
    expect(doneStatuses.sort()).toEqual(["Closed", "Resolved", "Tested"]);
  });
});

describe("S7 tester-roundtrip invariants", () => {
  const s7 = scenario("s7-tester-roundtrip");
  const events = s7.timeline.flatMap((d) => d.events);

  it("hands WP 11762 dev->tester, logs time, comments, then returns tester->dev", () => {
    const wp = s7.seed.workPackages.find((w) => w.key === "wp");
    expect(wp?.id).toBe(11762);
    expect(wp?.assignee).toBe("dev");

    // Two reassignments: the handoff and the return.
    const reassigns = events.filter(
      (e): e is Extract<MockEvent, { t: "reassign" }> => e.t === "reassign",
    );
    expect(reassigns.map((e) => e.assignee)).toEqual(["tester", "dev"]);

    // A logged time entry by the tester (paired with a setRemaining).
    const logged = events.filter(
      (e): e is Extract<MockEvent, { t: "logTime" }> => e.t === "logTime",
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ user: "tester", hours: 0.7 });

    // Exactly one comment, authored by the tester.
    const comments = events.filter(
      (e): e is Extract<MockEvent, { t: "comment" }> => e.t === "comment",
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.user).toBe("tester");
    expect(comments[0]?.text.trim().length).toBeGreaterThan(0);

    // Replay ends back on the dev — the round trip closed.
    const { state } = get(s7, "wp");
    expect(state.assignee).toBe("dev");
  });
});

describe("S8 retro-scope-churn invariants (SPEC_12 §3)", () => {
  const s8 = scenario("s8-retro-scope-churn");
  const versionEvents = s8.timeline
    .flatMap((d) => d.events.map((e) => [d.day, e] as const))
    .filter((pair): pair is readonly [number, Extract<MockEvent, { t: "setVersion" }>] =>
      pair[1].t === "setVersion",
    );

  it("seeds the sprint version 3.5.039 and its neighbour 3.5.038", () => {
    expect(s8.seed.versions.map((v) => v.name).sort()).toEqual(["3.5.038", "3.5.039"]);
  });

  it("the entrant enters 3.5.039 and the leaver leaves it, both on day 2 (mid-sprint churn)", () => {
    // Exactly two version changes, both on day 2 (after a 2026-07-06 start).
    expect(versionEvents).toHaveLength(2);
    for (const [day] of versionEvents) expect(day).toBe(2);

    const entrant = versionEvents.find(([, e]) => e.wp === "entrant");
    const leaver = versionEvents.find(([, e]) => e.wp === "leaver");
    // Entrant moves ONTO the sprint version; leaver moves OFF it.
    expect(entrant?.[1].version).toBe("v_target");
    expect(leaver?.[1].version).toBe("v_prev");

    // Their SEED versions are the opposite of where they end up (real churn).
    const seedVersion = (key: string): string | null | undefined =>
      s8.seed.workPackages.find((w) => w.key === key)?.version;
    expect(seedVersion("entrant")).toBe("v_prev");
    expect(seedVersion("leaver")).toBe("v_target");
    // The baseline ticket never churns — it stays on the sprint version.
    expect(seedVersion("baseline")).toBe("v_target");
    expect(versionEvents.some(([, e]) => e.wp === "baseline")).toBe(false);
  });
});

describe("S9 role-closure invariants (SPEC_14 §2)", () => {
  const s9 = scenario("s9-role-closure");

  // The confirmed §2 table: id → [status, holder key]. This is the ground truth
  // Agent B's done-engine and Agent D's e2e must reproduce as Done 9 / Not done 2.
  const EXPECTED: ReadonlyArray<readonly [number, string, string]> = [
    [11585, "Tested", "kolar"],
    [11592, "In progress", "trnka"], // Dev → NOT done
    [11625, "Resolved", "cesal"],
    [11687, "Tested", "kuiper"],
    [11726, "On hold", "benda"], // Customer → done via role
    [11747, "In progress", "cesal"], // Customer → done via role
    [11756, "Tested", "dalby"],
    [11762, "Closed", "bily"],
    [11765, "In progress", "bubenik"], // Dev → NOT done
    [11771, "Tested", "kuiper"],
    [11773, "Tested", "kuiper"],
  ];

  it("seeds exactly the 11 sprint-3.5.039 tickets with the confirmed status + holder", () => {
    const byId = new Map(s9.seed.workPackages.map((w) => [w.id, w]));
    expect(s9.seed.workPackages).toHaveLength(EXPECTED.length);
    for (const [id, status, holder] of EXPECTED) {
      const wp = byId.get(id);
      expect(wp, `WP ${id} present`).toBeTruthy();
      expect(wp?.status, `WP ${id} status`).toBe(status);
      expect(wp?.assignee, `WP ${id} holder`).toBe(holder);
    }
  });

  it("names the holders behind the two NOT-DONE tickets (Trnka #11592, Bubenik #11765)", () => {
    const named = (key: string): string | undefined =>
      s9.seed.users.find((u) => u.key === key)?.name;
    expect(named("trnka")).toBe("Zbynek Trnka");
    expect(named("bubenik")).toBe("Tobias Bubenik");
    // The two role-driven DONE tickets are held by the same person (Cesal =
    // Customer on 11747) and Benda (Customer on 11726) — role, not status.
    expect(named("cesal")).toBe("David Cesal");
    expect(named("benda")).toBe("Jindrich Benda");
  });

  it("keeps the shared cast so the /users/me identity invariant still holds", () => {
    for (const key of ["dev", "tester", "customer"]) {
      expect(s9.seed.users.some((u) => u.key === key)).toBe(true);
    }
    expect(s9.seed.users.filter((u) => u.me).map((u) => u.key)).toEqual(["dev"]);
    // Every ticket holder resolves to a seeded user.
    const keys = new Set(s9.seed.users.map((u) => u.key));
    for (const wp of s9.seed.workPackages) {
      if (typeof wp.assignee === "string") expect(keys.has(wp.assignee)).toBe(true);
    }
  });

  it("attributes dev-logged time to Developers with both under- and over-estimate cases", () => {
    const entries = s9.seed.timeEntries ?? [];
    const byId = new Map(s9.seed.workPackages.map((w) => [w.key, w]));
    // Developers (to be set later): Trnka + Bubenik. Their logs are dev-logged.
    const devKeys = new Set(["trnka", "bubenik"]);
    const overshoot: boolean[] = [];
    for (const te of entries) {
      if (!devKeys.has(te.user)) continue;
      const est = byId.get(te.wp)?.estimatedHours ?? 0;
      expect(est, `${te.wp} has an estimate to compare against`).toBeGreaterThan(0);
      overshoot.push(te.hours > est * 1.25);
    }
    // At least one dev-log over the 25% threshold and one under it.
    expect(overshoot).toContain(true); // 11592 (6/4), 11756 (8/6)
    expect(overshoot).toContain(false); // 11585 (4/8), 11765 (8/8)
  });

  it("logs non-dev (tester/customer) time that stays separate from dev-logged", () => {
    const entries = s9.seed.timeEntries ?? [];
    const sumFor = (user: string): number =>
      entries.filter((e) => e.user === user).reduce((s, e) => s + e.hours, 0);
    expect(sumFor("brabec")).toBe(3); // tester time shown separately
    expect(sumFor("cesal")).toBe(10); // customer time (2 × 5h)
    // No developer shares a work package's logged time with a non-developer here
    // in a way that would let dev-logged be read off the assignee.
    expect(sumFor("trnka") + sumFor("bubenik")).toBeGreaterThan(0);
  });

  it("tags every ticket with version 3.5.039 so a sprint can be seeded from it", () => {
    expect(s9.seed.versions.map((v) => v.name)).toEqual(["3.5.039"]);
    for (const wp of s9.seed.workPackages) expect(wp.version).toBe("v_3_5_039");
  });
});

describe("S11 effective-estimate invariants (SPEC_16 §5)", () => {
  const s11 = scenario("s11-effective-estimate");

  // Consolidation Round (Concept 2): the local 2-arg `effectiveEstimate`
  // reimplementation that used to live here is DELETED — it omitted the
  // override argument and could silently diverge from the real 3-arg rule.
  // The canonical `effectiveEstimate` (apps/api/src/logic/estimate.ts) can't be
  // imported here (@osp/api is a server app, not a shareable package — no
  // subpath export, and a fixtures→api dependency would be cyclic), and its
  // behaviour is already unit-tested in apps/api/src/logic/estimate.test.ts.
  // These fixture tests therefore assert only the SEED INPUTS the rule consumes
  // (Work/Remaining), stating the rule's expected output in a comment rather
  // than recomputing it with a second, drift-prone copy of the rule.

  it("is a plain backlog seed: no version and no timeline, so no scenario baselines it", () => {
    expect(s11.seed.versions).toEqual([]);
    expect(s11.timeline).toEqual([]);
    for (const wp of s11.seed.workPackages) expect(wp.version ?? null).toBeNull();
  });

  it("does not reuse id 11765, which s9-role-closure.ts already assigns to a DIFFERENT, baselined ticket", () => {
    const s9 = scenario("s9-role-closure");
    const s11Ids = new Set(s11.seed.workPackages.map((w) => w.id));
    const s9Ids = new Set(s9.seed.workPackages.map((w) => w.id));
    for (const id of s11Ids) expect(s9Ids.has(id)).toBe(false);
  });

  it("WP 1901 mirrors the SPEC_16 §5 worked example: Work 24h / Remaining 18h -> effective 18h", () => {
    const wp = s11.seed.workPackages.find((w) => w.id === 1901);
    // Work 24h, Remaining 18h (non-zero, ≠ Work) → canonical effective = 18h.
    expect(wp?.estimatedHours).toBe(24);
    expect(wp?.remainingHours).toBe(18);
    // Narrative fidelity: "Spent 11h" logged, irrelevant to the estimate itself.
    const entries = s11.seed.timeEntries ?? [];
    expect(entries.filter((e) => e.wp === "remaining-wins").reduce((s, e) => s + e.hours, 0)).toBe(
      11,
    );
  });

  it("covers the remaining==work and remaining==0 fall-through-to-Work branches", () => {
    const byKey = new Map(s11.seed.workPackages.map((w) => [w.key, w]));
    // Remaining == Work (8 == 8) → falls through to Work → canonical effective = 8h.
    const equalsWork = byKey.get("remaining-equals-work");
    expect(equalsWork?.estimatedHours).toBe(8);
    expect(equalsWork?.remainingHours).toBe(8);

    // Remaining == 0 (a done ticket, not a "zero estimate") → falls through to
    // Work → canonical effective = 12h.
    const zeroRemaining = byKey.get("remaining-zero");
    expect(zeroRemaining?.estimatedHours).toBe(12);
    expect(zeroRemaining?.remainingHours).toBe(0);
  });

  it("covers a second remaining-wins case with different numbers than 1901's 18h", () => {
    const wp = s11.seed.workPackages.find((w) => w.id === 1904);
    // Work 10h, Remaining 3h (non-zero, ≠ Work) → canonical effective = 3h.
    expect(wp?.estimatedHours).toBe(10);
    expect(wp?.remainingHours).toBe(3);
  });
});

describe("S14 backlog-filter-matrix invariants (SPEC_19 §1/§2/§3)", () => {
  const s14 = scenario("s14-backlog-filter-matrix");
  const wps = s14.seed.workPackages;
  const HIDDEN = new Set(["Closed", "Tested", "Resolved", "Rejected"]);
  const byVersion = (v: string): WorkPackageSeed[] => wps.filter((w) => w.version === v);

  it("holds enough project-90 tickets to span 2 pages at PAGE_SIZE=100 (the abort window)", () => {
    const proj90 = wps.filter((w) => w.project === 90);
    // >100 ⇒ a real second page ⇒ the sync engine's between-pages cancel check
    // is actually reached mid-run (a 1-page sync can never be aborted).
    expect(proj90.length).toBeGreaterThan(100);
    expect(proj90.length).toBe(120);
  });

  it("makes version 3.5.040 status-exclusively 'In progress' (one half of the jointly-empty pair)", () => {
    const iso = byVersion("v_iso");
    expect(iso.length).toBe(8);
    expect(new Set(iso.map((w) => w.status))).toEqual(new Set(["In progress"]));
  });

  it("keeps 'Merge pending' present in the backlog but NEVER on a v_iso ticket (the empty pair)", () => {
    // "Merge pending" exists (in v_mixed) so a non-cascading Status dropdown would
    // offer it, yet no v_iso ticket has it — so version=3.5.040 + status=Merge
    // pending is individually valid but jointly empty.
    const mixed = byVersion("v_mixed");
    expect(mixed.some((w) => w.status === "Merge pending")).toBe(true);
    expect(byVersion("v_iso").some((w) => w.status === "Merge pending")).toBe(false);
    // Mirror: "In progress" lives only on v_iso within project 90.
    expect(mixed.some((w) => w.status === "In progress")).toBe(false);
  });

  it("carries hidden-status tickets (cached, but never a backlog filter option)", () => {
    const hidden = wps.filter((w) => HIDDEN.has(w.status));
    expect(hidden.length).toBe(4);
    // All in project 90 → they count toward the 2-page sync total but must be
    // excluded from the /backlog view + its filter-options.
    for (const w of hidden) expect(w.project).toBe(90);
  });

  it("spreads five fresh assignees, with Andrea/Martin exclusive to v_mixed (assignee→version cascade)", () => {
    const names = new Set(s14.seed.users.map((u) => u.name));
    for (const n of ["Radek Prochazka", "Simona Nemcova", "Filip Ruzicka", "Andrea Kolarova", "Martin Vesely"]) {
      expect(names.has(n)).toBe(true);
    }
    const isoAssignees = new Set(byVersion("v_iso").map((w) => w.assignee));
    expect(isoAssignees.has("andrea")).toBe(false);
    expect(isoAssignees.has("martin")).toBe(false);
  });

  it("uses two projects so the Project facet has a real second value to narrow on", () => {
    expect(new Set(wps.map((w) => w.project))).toEqual(new Set([90, 91]));
    expect((s14.seed.projects ?? []).map((p) => p.id).sort((a, b) => a - b)).toEqual([90, 91]);
  });

  it("has no timeline / time entries so every ticket keeps one updatedAt (2-page incremental re-sync)", () => {
    expect(s14.timeline).toEqual([]);
    expect(s14.seed.timeEntries ?? []).toEqual([]);
  });
});

// ── S19 / S20 — Increment 29 sync coverage (SPEC_29, contracts §0a) ──────────
describe("S19/S20 sync-coverage invariants (SPEC_29 / contracts §0a)", () => {
  const s19 = scenario("s19-sync-coverage");
  const s20 = scenario("s20-sync-coverage-orphaned");
  const wp = (s: Scenario, id: number) => s.seed.workPackages.find((w) => w.id === id);

  it("seeds two versions of ONE project so a selection can cover one and miss the other", () => {
    // The whole point of contracts §0a: a selection is a (project, version)
    // pair, so two versions of the SAME project are what makes a row fall into
    // neither the paginated sync nor the old project-level orphans pass.
    const versions = s19.seed.versions;
    expect(versions.map((v) => v.id).sort((a, b) => a - b)).toEqual([8510, 8511]);
    for (const v of versions) expect(v.projectId).toBe(8500);
  });

  it("starts every drifted ticket in the SELECTED version and moves it out on day 1", () => {
    const drifted = [
      "drifted-estimate",
      "drifted-plain",
      "drifted-in-sprint",
      "drifted-bulk-a",
      "drifted-bulk-b",
    ];
    for (const key of drifted) {
      const seed = s19.seed.workPackages.find((w) => w.key === key);
      expect(seed?.version, `${key} must start in the selected version`).toBe("v_selected");
    }
    const day1 = s19.timeline.find((d) => d.day === 1);
    const moved = (day1?.events ?? [])
      .filter((e) => e.t === "setVersion" && e.version === "v_unselected")
      .map((e) => (e as { wp: string }).wp);
    expect(moved.sort()).toEqual([...drifted].sort());
  });

  it("#85010 is the #11948 shape: no estimate at import, 8h in OP from day 1", () => {
    const seed = wp(s19, 85010);
    expect(seed?.estimatedHours, "cached empty at import time").toBeNull();
    const day1 = s19.timeline.find((d) => d.day === 1);
    const setEstimate = (day1?.events ?? []).find(
      (e) => e.t === "setEstimate" && e.wp === "drifted-estimate",
    );
    expect(setEstimate && (setEstimate as { hours: number | null }).hours).toBe(8);
  });

  it("#85020 lives in a SECOND project, so only the by-id path can cache it", () => {
    expect(wp(s19, 85020)?.project).toBe(8501);
    // …and nothing else does, or the "no import selection covers it" premise
    // of the Increment-25 leg would be false.
    const inArchive = s19.seed.workPackages.filter((w) => w.project === 8501);
    expect(inArchive.map((w) => w.id)).toEqual([85020]);
  });

  it("S20 is S19 minus exactly one work package, everything else identical", () => {
    const ids19 = s19.seed.workPackages.map((w) => w.id).sort((a, b) => (a ?? 0) - (b ?? 0));
    const ids20 = s20.seed.workPackages.map((w) => w.id).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ids19.filter((id) => !ids20.includes(id))).toEqual([85040]);
    expect(ids20.every((id) => ids19.includes(id))).toBe(true);
    // The timeline must be reusable verbatim: goto-day on the reloaded mock has
    // to reproduce the SAME OP state, or the orphan leg would also silently
    // revert the drift the earlier legs rely on.
    expect(s20.timeline).toEqual(s19.timeline);
    expect(s20.startDate).toBe(s19.startDate);
    expect(s20.seed.versions).toEqual(s19.seed.versions);
  });
});

// ── S21 — Increment 30 "Planned = current scope" reproduction ────────────────
// These guard the fixture's DATA PREMISES, i.e. the things the hand arithmetic
// in tests/src/inc30-current-scope-planned.test.ts silently depends on. If a
// premise ever breaks, it must fail HERE (loudly, structurally) rather than as
// a mystery off-by-N in an integration assertion.
describe("S21 inc30-current-scope-planned invariants (INCREMENT_30_CONTRACTS §2a / CAPACITY_BAR_RULES §5)", () => {
  const s21 = scenario("s21-inc30-current-scope-planned");
  const wpByKey = (key: string) => s21.seed.workPackages.find((w) => w.key === key);
  const wpById = (id: number) => s21.seed.workPackages.find((w) => w.id === id);

  it("owns a fresh id band — people 301-305, project 8600, version 8610, WPs 86001-86012 — colliding with no other scenario", () => {
    // Increment 15's lesson: e2e fixtures share an "identity = name" space, so a
    // reused id/name silently merges two unrelated people. Every id here is new.
    const others = scenarios.filter((s) => s.name !== s21.name);
    const otherUserIds = new Set(others.flatMap((s) => s.seed.users.map((u) => u.id)));
    const otherUserNames = new Set(others.flatMap((s) => s.seed.users.map((u) => u.name)));
    const otherWpIds = new Set(
      others.flatMap((s) => s.seed.workPackages.map((w) => w.id).filter((id) => id != null)),
    );
    const otherVersionIds = new Set(others.flatMap((s) => s.seed.versions.map((v) => v.id)));

    const mine = s21.seed.users.filter((u) => u.id >= 300);
    expect(mine.map((u) => u.id).sort((a, b) => a - b)).toEqual([301, 302, 303, 304, 305]);
    for (const u of mine) {
      expect(otherUserIds.has(u.id), `user id ${u.id} (${u.name}) collides`).toBe(false);
      expect(otherUserNames.has(u.name), `user NAME "${u.name}" collides`).toBe(false);
    }
    for (const w of s21.seed.workPackages) {
      expect(w.id, `${w.key} needs an explicit id`).toBeDefined();
      expect(w.id! >= 86001 && w.id! <= 86012, `WP ${w.id} outside the 86001-86012 band`).toBe(true);
      expect(otherWpIds.has(w.id!), `WP id ${w.id} collides`).toBe(false);
      expect(w.project, `${w.key} must live in project 8600`).toBe(8600);
    }
    expect(s21.seed.projects?.map((p) => p.id)).toEqual([8600]);
    expect(s21.seed.versions.map((v) => v.id)).toEqual([8610]);
    expect(otherVersionIds.has(8610)).toBe(false);
  });

  it("keeps effectiveEstimate a pure fall-through to Work: remaining === estimate at seed AND after every paired setRemaining", () => {
    // CAPACITY_BAR_RULES §3: remaining wins only when it is nonzero AND differs
    // from work. Holding them equal everywhere is what makes the test's Planned
    // arithmetic hand-checkable — and #86012's day-3 move keeps the pairing.
    for (const w of s21.seed.workPackages) {
      expect(w.estimatedHours, `${w.key} needs an estimate`).toBeGreaterThan(0);
      expect(w.remainingHours, `${w.key}: remaining must mirror work`).toBe(w.estimatedHours);
    }
    const finalState = replay(s21);
    for (const [key, st] of finalState) {
      expect(st.remaining, `${key}: remaining must still mirror work after the timeline`).toBe(
        st.estimated,
      );
    }
  });

  it("stages the sprint-4 shape: a dev->dev handoff on day 2, and a re-estimate STRICTLY AFTER that acquisition on day 3", () => {
    // The handoff must land AFTER activation (the test activates at day 0) and
    // the receiver must LOG on it, or their segment would be `idle`, not the
    // red `acquired` this reproduction needs.
    const day2 = s21.timeline.find((d) => d.day === 2)!;
    const reassign = day2.events.find(
      (e): e is Extract<MockEvent, { t: "reassign" }> => e.t === "reassign",
    );
    expect(reassign?.wp).toBe("handed-off");
    expect(reassign?.assignee).toBe("rezac");
    expect(wpByKey("handed-off")?.assignee, "…away from Stastna, its baseline holder").toBe("stastna");
    expect(
      day2.events.some((e) => e.t === "logTime" && e.wp === "handed-off" && e.user === "rezac"),
      "the receiver logs on the handed-off ticket (acquired, not idle)",
    ).toBe(true);

    // The residual leg: the estimate moves only AFTER the day-2 acquisition.
    const day3 = s21.timeline.find((d) => d.day === 3)!;
    const setEstimate = day3.events.find(
      (e): e is Extract<MockEvent, { t: "setEstimate" }> => e.t === "setEstimate",
    );
    expect(setEstimate?.wp).toBe("acquired-then-reestimated");
    expect(setEstimate?.hours).toBe(14);
    expect(wpByKey("acquired-then-reestimated")?.estimatedHours, "6 h at acquisition").toBe(6);
    expect(
      s21.timeline
        .filter((d) => d.day <= 2)
        .some((d) => d.events.some((e) => e.t === "setEstimate")),
      "no estimate may move before the acquisition, or the residual is not measurable",
    ).toBe(false);
  });

  it("pairs a parent with a child held by a DIFFERENT developer, so the parent's holder owns nothing else", () => {
    // CAPACITY_BAR_RULES §5a / the Increment-26 vanishing developer: Prazak must
    // hold ONLY the suppressed parent. If the child were his too, the leaf guard
    // would leave him a non-zero line and the regression would be untestable.
    const parent = wpById(86010)!;
    const child = wpById(86011)!;
    expect(child.parent).toBe("dc-parent");
    expect(parent.assignee).toBe("prazak");
    expect(child.assignee).toBe("dolinsky");
    expect(
      s21.seed.workPackages.filter((w) => w.assignee === "prazak").map((w) => w.id),
      "Prazak holds the parent and NOTHING else",
    ).toEqual([86010]);
    // Parent declared before child — the engine resolves parents by key in order.
    const keys = s21.seed.workPackages.map((w) => w.key);
    expect(keys.indexOf("dc-parent")).toBeLessThan(keys.indexOf("dc-child"));
  });

  it("gives the non-developer holder REAL logged work, so 'grey is never plannable' is a live claim", () => {
    expect(wpById(86008)?.assignee).toBe("hajkova");
    const logged = s21.timeline
      .flatMap((d) => d.events)
      .filter((e) => e.t === "logTime" && e.wp === "tester-held")
      .reduce((sum, e) => sum + (e as { hours: number }).hours, 0);
    expect(logged, "the tester actually logs time on their ticket").toBeGreaterThan(0);
  });

  it("leaves #86002 with ZERO logged time — the Increment-26 'baseline is green anyway' leg", () => {
    const logged = s21.timeline
      .flatMap((d) => d.events)
      .filter((e) => e.t === "logTime" && e.wp === "retained-unworked");
    expect(logged, "#86002 must never be logged on").toHaveLength(0);
    const idle = s21.timeline
      .flatMap((d) => d.events)
      .filter((e) => e.t === "logTime" && e.wp === "added-held-unworked");
    expect(idle, "#86007 must never be logged on (it is the `idle` leg)").toHaveLength(0);
  });
});
