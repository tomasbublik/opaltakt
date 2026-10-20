import { describe, expect, it } from "vitest";
import { parseIsoDuration } from "@osp/op-client";
import type { Scenario } from "../scenario-types";
import { MockEngineError, ScenarioEngine } from "./engine";
import { hoursToIsoDuration } from "./hal";

/**
 * Unit tests for the scenario engine (SPEC_03 §4) with an injected mini
 * scenario — no HTTP, no registry on disk (Agent M2 builds that in parallel).
 */

function miniScenario(): Scenario {
  return {
    name: "mini",
    description: "engine unit-test scenario",
    startDate: "2026-07-01",
    seed: {
      users: [
        { key: "dev", id: 11, name: "Dev One", login: "dev", me: true },
        { key: "tester", id: 12, name: "Tess Tester" },
        { key: "customer", id: 13, name: "Cust Omer" },
      ],
      versions: [{ key: "sprint1", id: 900, name: "Sprint 1", projectId: 3 }],
      workPackages: [
        {
          key: "epic",
          subject: "Epic over 80h",
          project: 3,
          status: "In progress",
          assignee: "dev",
          accountable: "customer",
          estimatedHours: 80,
          remainingHours: 80,
          version: "sprint1",
        },
        {
          key: "small",
          subject: "Small task",
          project: 3,
          status: "New",
          assignee: "tester",
          estimatedHours: 7.5,
          remainingHours: 7.5,
        },
      ],
      timeEntries: [{ wp: "epic", user: "dev", hours: 2, spentOn: "2026-06-30" }],
    },
    timeline: [
      { day: 0, events: [{ t: "setStatus", wp: "small", status: "Confirmed" }] },
      {
        day: 1,
        events: [
          { t: "logTime", wp: "epic", user: "dev", hours: 6 },
          { t: "setRemaining", wp: "epic", hours: 74 },
        ],
      },
      {
        day: 3,
        events: [
          {
            t: "addWorkPackage",
            wp: {
              key: "added",
              subject: "Scope creep",
              project: 3,
              status: "New",
              assignee: "dev",
              estimatedHours: 4,
            },
          },
        ],
      },
    ],
  };
}

function loadedEngine(): ScenarioEngine {
  const engine = new ScenarioEngine([miniScenario()]);
  engine.loadScenario(miniScenario());
  return engine;
}

describe("ScenarioEngine — load / day 0", () => {
  it("starts in fixture mode and switches to scenario mode on load", async () => {
    const engine = new ScenarioEngine([miniScenario()]);
    expect(engine.mode).toBe("fixtures");
    expect(engine.view()).toBeNull();
    const state = await engine.load("mini");
    expect(engine.mode).toBe("scenario");
    expect(state.scenario).toBe("mini");
    expect(state.day).toBe(0);
    expect(state.date).toBe("2026-07-01");
    expect(state.total_days).toBe(3);
    expect(state.pending_days).toBe(2); // days 1 and 3 still unapplied
  });

  it("rejects an unknown scenario name with a 404 engine error", async () => {
    const engine = new ScenarioEngine([miniScenario()]);
    await expect(engine.load("nope")).rejects.toThrowError(MockEngineError);
    await expect(engine.load("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("auto-assigns WP ids from 5001 and applies day-0 events immediately", () => {
    const engine = loadedEngine();
    const state = engine.stateSummary();
    expect(state.work_packages.map((wp) => wp.id)).toEqual([5001, 5002]);
    // Day-0 event applied on load: small moved New → Confirmed.
    const small = state.work_packages.find((wp) => wp.key === "small")!;
    expect(small.status).toBe("Confirmed");
    // The day-0 mutation stamped the touched WP 09:00; epic keeps its seed stamp.
    expect(small.updated_at).toBe("2026-07-01T09:00:00Z");
    const epic = state.work_packages.find((wp) => wp.key === "epic")!;
    expect(epic.updated_at).toBe("2026-07-01T08:00:00Z");
    // Seed time entries count towards spent bookkeeping.
    expect(epic.spent_hours).toBe(2);
  });

  it("hard-400s on dangling scenario keys (wp / user / status / version)", () => {
    const badWp: Scenario = {
      ...miniScenario(),
      timeline: [{ day: 0, events: [{ t: "setStatus", wp: "ghost", status: "New" }] }],
    };
    expect(() => new ScenarioEngine([]).loadScenario(badWp)).toThrowError(
      /Unknown work package key "ghost"/,
    );

    const badStatus = miniScenario();
    badStatus.seed.workPackages[0]!.status = "Bogus";
    expect(() => new ScenarioEngine([]).loadScenario(badStatus)).toThrowError(
      /Unknown status "Bogus"/,
    );

    const badUser = miniScenario();
    badUser.seed.workPackages[0]!.assignee = "ghost";
    expect(() => new ScenarioEngine([]).loadScenario(badUser)).toThrowError(
      /Unknown user key "ghost"/,
    );

    const badVersion = miniScenario();
    badVersion.seed.workPackages[0]!.version = "ghost";
    expect(() => new ScenarioEngine([]).loadScenario(badVersion)).toThrowError(
      /Unknown version key "ghost"/,
    );

    try {
      new ScenarioEngine([]).loadScenario(badWp);
      expect.unreachable("loadScenario must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MockEngineError);
      expect((err as MockEngineError).status).toBe(400);
    }
  });

  it("rejects duplicate work package keys", () => {
    const dup = miniScenario();
    dup.timeline.push({
      day: 0,
      events: [
        {
          t: "addWorkPackage",
          wp: { key: "epic", subject: "clash", project: 3, status: "New" },
        },
      ],
    });
    expect(() => new ScenarioEngine([]).loadScenario(dup)).toThrowError(
      /Duplicate work package key "epic"/,
    );
  });
});

describe("ScenarioEngine — advance-day / clock", () => {
  it("applies the day's events, creates time entries with spentOn = current date", () => {
    const engine = loadedEngine();
    const result = engine.advanceDay();
    expect(result).toMatchObject({ day: 1, date: "2026-07-02", applied_events: 2 });

    const view = engine.view()!;
    // logTime: spentOn = current date; does NOT change remaining on its own.
    const logged = view.timeEntries.find((te) => te.spentOn === "2026-07-02");
    expect(logged).toMatchObject({ wpId: 5001, userId: 11, hours: 6 });
    // remaining changed only because of the explicit setRemaining event.
    const epic = view.workPackages.find((wp) => wp.key === "epic")!;
    expect(epic.remainingHours).toBe(74);
    expect(epic.estimatedHours).toBe(80);
  });

  it("bumps updatedAt ONLY on touched WPs, +1 minute per mutation that day", () => {
    const engine = loadedEngine();
    engine.advanceDay();
    const view = engine.view()!;
    const epic = view.workPackages.find((wp) => wp.key === "epic")!;
    const small = view.workPackages.find((wp) => wp.key === "small")!;
    // Two day-1 mutations touched epic: logTime → 09:00, setRemaining → 09:01.
    expect(epic.updatedAt).toBe("2026-07-02T09:01:00Z");
    // Untouched on day 1: small keeps its day-0 stamp.
    expect(small.updatedAt).toBe("2026-07-01T09:00:00Z");
  });

  it("a day without timeline entries advances the clock with zero events", () => {
    const engine = loadedEngine();
    engine.advanceDay(); // day 1
    const result = engine.advanceDay(); // day 2 — no events
    expect(result).toMatchObject({ day: 2, date: "2026-07-03", applied_events: 0 });
  });

  it("refuses to advance in fixture mode", () => {
    const engine = new ScenarioEngine([]);
    expect(() => engine.advanceDay()).toThrowError(/No scenario loaded/);
  });
});

describe("ScenarioEngine — goto-day", () => {
  it("fast-forwards forward, applying every day in between", () => {
    const engine = loadedEngine();
    const state = engine.gotoDay(3);
    expect(state.day).toBe(3);
    expect(state.date).toBe("2026-07-04");
    expect(state.pending_days).toBe(0);
    // Day-3 addWorkPackage landed with the next auto id and a day-3 stamp.
    const added = state.work_packages.find((wp) => wp.key === "added")!;
    expect(added.id).toBe(5003);
    expect(added.updated_at).toBe("2026-07-04T09:00:00Z");
  });

  it("backward = reload from scratch + fast-forward", () => {
    const engine = loadedEngine();
    engine.gotoDay(3);
    const state = engine.gotoDay(1);
    expect(state.day).toBe(1);
    expect(state.date).toBe("2026-07-02");
    // The day-3 WP is gone again; day-1 effects are present.
    expect(state.work_packages.map((wp) => wp.key)).toEqual(["epic", "small"]);
    const epic = state.work_packages.find((wp) => wp.key === "epic")!;
    expect(epic.remaining_hours).toBe(74);
    expect(epic.spent_hours).toBe(8); // 2 seeded + 6 logged on day 1
  });

  it("rejects negative / non-integer days", () => {
    const engine = loadedEngine();
    expect(() => engine.gotoDay(-1)).toThrowError(MockEngineError);
    expect(() => engine.gotoDay(1.5)).toThrowError(MockEngineError);
  });
});

describe("ScenarioEngine — reassign (assignee vs accountable, SPEC_03 §2a)", () => {
  it("changes assignee independently; accountable stays; null clears", () => {
    const scenario = miniScenario();
    scenario.timeline = [
      { day: 1, events: [{ t: "reassign", wp: "epic", assignee: "tester" }] },
      { day: 2, events: [{ t: "reassign", wp: "epic", accountable: null }] },
    ];
    const engine = new ScenarioEngine([]);
    engine.loadScenario(scenario);

    engine.advanceDay();
    let epic = engine.view()!.workPackages.find((wp) => wp.key === "epic")!;
    expect(epic.assigneeId).toBe(12); // dev → tester
    expect(epic.accountableId).toBe(13); // customer untouched (omitted)

    engine.advanceDay();
    epic = engine.view()!.workPackages.find((wp) => wp.key === "epic")!;
    expect(epic.assigneeId).toBe(12); // omitted → unchanged
    expect(epic.accountableId).toBeNull(); // null → cleared
  });
});

describe("ScenarioEngine — inject-urgent", () => {
  it("falls back to a generic urgent Bug in the first seeded project", () => {
    const engine = loadedEngine();
    const wp = engine.injectUrgent();
    expect(wp.key).toBe("urgent-1");
    expect(wp.id).toBe(5003);
    expect(wp.subject).toMatch(/URGENT/);
    expect(wp.updated_at).toBe("2026-07-01T09:01:00Z"); // day-0 mutation #2
    const second = engine.injectUrgent();
    expect(second.key).toBe("urgent-2");
    expect(second.id).toBe(5004);
  });

  it("uses the scenario's urgentTemplate when present", () => {
    const scenario = miniScenario();
    scenario.urgentTemplate = {
      subject: "Hotfix payments",
      type: "Bug",
      project: 3,
      status: "Confirmed",
      assignee: "dev",
      estimatedHours: 3,
    };
    const engine = new ScenarioEngine([]);
    engine.loadScenario(scenario);
    const wp = engine.injectUrgent();
    expect(wp.subject).toBe("Hotfix payments");
    expect(wp.status).toBe("Confirmed");
    expect(wp.assignee).toBe("dev");
    expect(wp.estimated_hours).toBe(3);
  });
});

describe("ScenarioEngine — reset & setEstimate", () => {
  it("reset returns to fixture mode with an empty state summary", () => {
    const engine = loadedEngine();
    engine.reset();
    expect(engine.mode).toBe("fixtures");
    expect(engine.view()).toBeNull();
    expect(engine.stateSummary()).toMatchObject({
      scenario: null,
      day: 0,
      date: null,
      total_days: 0,
      pending_days: 0,
      work_packages: [],
    });
  });

  it("setEstimate accepts null (clears the estimate)", () => {
    const scenario = miniScenario();
    scenario.timeline = [{ day: 1, events: [{ t: "setEstimate", wp: "epic", hours: null }] }];
    const engine = new ScenarioEngine([]);
    engine.loadScenario(scenario);
    engine.advanceDay();
    expect(engine.view()!.workPackages.find((wp) => wp.key === "epic")!.estimatedHours).toBeNull();
  });
});

describe("duration serialization", () => {
  it("serializes hours as ISO durations that round-trip through parseIsoDuration", () => {
    // Exact strings (frozen contract examples) …
    // Sub-24h: unchanged, byte-for-byte.
    expect(hoursToIsoDuration(7.5)).toBe("PT7H30M");
    expect(hoursToIsoDuration(0.75)).toBe("PT45M");
    expect(hoursToIsoDuration(0)).toBe("PT0H");
    expect(hoursToIsoDuration(null)).toBeNull();
    // ≥24h: emit a day component like real OpenProject (Increment 22). Nobody
    // could previously exercise this path because the mock always serialized
    // ≥24h as "PT{h}H" — which is why prod's day-spanning WPs were never tested.
    expect(hoursToIsoDuration(80)).toBe("P3DT8H");
    expect(hoursToIsoDuration(29)).toBe("P1DT5H"); // mirrors real WP 11592
    expect(hoursToIsoDuration(24)).toBe("P1D");
    expect(hoursToIsoDuration(51.5)).toBe("P2DT3H30M");
    // … and the numeric round-trip via the ONE canonical parser
    // (Consolidation Round, Concept 1: no local mirror reimplementation).
    for (const hours of [80, 7.5, 0.75, 0, 6, 0.25, 123.5, 29, 24, 51.5]) {
      expect(parseIsoDuration(hoursToIsoDuration(hours)!)).toBe(hours);
    }
  });
});
