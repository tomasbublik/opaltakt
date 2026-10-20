import { describe, expect, it } from "vitest";
import type { Scenario } from "../scenario-types";
import { s7TesterRoundtrip } from "../scenarios/s7-tester-roundtrip";
import { s15StatusCasingDivergence } from "../scenarios/s15-status-casing-divergence";
import { createRecordingMockOpServer } from "./index";
import { MockEngineError, ScenarioEngine } from "./engine";

/**
 * Unit + HTTP tests for the journal/activities engine (SPEC_04 §3), the piece
 * of Increment 4's mock extension that Agents A/B/D build against. Covers:
 * default actor resolution, explicit override, one-detail-per-field, no
 * journal on redundant reassign or on creation, and the HTTP route + filter.
 */

function miniScenario(): Scenario {
  return {
    name: "mini-activities",
    description: "activities engine unit-test scenario",
    startDate: "2026-07-01",
    seed: {
      users: [
        { key: "dev", id: 11, name: "Dev One", me: true },
        { key: "tester", id: 12, name: "Tess Tester" },
      ],
      versions: [{ key: "v1", id: 900, name: "v1.0", projectId: 3 }],
      workPackages: [
        {
          key: "main",
          id: 1101,
          subject: "Main ticket",
          project: 3,
          status: "New",
          assignee: "dev",
          accountable: "tester",
          estimatedHours: 10,
          remainingHours: 10,
        },
        {
          key: "unassigned",
          id: 1102,
          subject: "Nobody has this yet",
          project: 3,
          status: "New",
        },
      ],
    },
    timeline: [
      {
        day: 1,
        events: [
          // Default actor: dev is the assignee at this moment -> actor=dev.
          { t: "setStatus", wp: "main", status: "Confirmed" },
          // Redundant reassign to the SAME people -> no journal entries at all.
          { t: "reassign", wp: "main", assignee: "dev", accountable: "tester" },
          // Real handoff: dev -> tester. Default actor is STILL dev (captured
          // before the mutation, i.e. the outgoing person made the change).
          { t: "reassign", wp: "main", assignee: "tester" },
          // Explicit actor override.
          { t: "setRemaining", wp: "main", hours: 6, actor: "tester" },
          // No assignee at all -> unattributed (actor: null).
          { t: "setEstimate", wp: "unassigned", hours: 4 },
        ],
      },
    ],
  };
}

function loadedEngine(): ScenarioEngine {
  const engine = new ScenarioEngine([miniScenario()]);
  engine.loadScenario(miniScenario());
  engine.advanceDay();
  return engine;
}

describe("journal / activities engine (SPEC_04 §3)", () => {
  it("default actor = assignee BEFORE the mutation; reassign attributes to the outgoing person", () => {
    const engine = loadedEngine();
    const journals = engine.getActivities(1101);
    // status_changed (actor dev), assignee_changed (actor dev, dev->tester).
    // The redundant same-value reassign produced NOTHING.
    const kinds = journals.map((j) => j.detail?.property);
    expect(kinds).toEqual(["status", "assignee", "remainingTime"]);

    const status = journals[0]!;
    expect(status.actorId).toBe(11); // dev
    expect(status.detail?.oldValue).toEqual({ id: expect.any(Number), name: "New" });
    expect(status.detail?.newValue).toEqual({ id: expect.any(Number), name: "Confirmed" });

    const assignee = journals[1]!;
    expect(assignee.actorId).toBe(11); // dev handed it off, even though dev is now the OLD value
    expect(assignee.detail?.oldValue).toEqual({ id: 11, name: "Dev One" });
    expect(assignee.detail?.newValue).toEqual({ id: 12, name: "Tess Tester" });
  });

  it("explicit actor override wins over the default", () => {
    const engine = loadedEngine();
    const remaining = engine.getActivities(1101).find((j) => j.detail?.property === "remainingTime");
    expect(remaining?.actorId).toBe(12); // tester, explicitly
    expect(remaining?.detail?.oldValue).toBe(10);
    expect(remaining?.detail?.newValue).toBe(6);
  });

  it("no assignee at the time of the mutation -> unattributed (actor: null)", () => {
    const engine = loadedEngine();
    const j = engine.getActivities(1102);
    expect(j).toHaveLength(1);
    expect(j[0]?.actorId).toBeNull();
    expect(j[0]?.detail?.property).toBe("estimatedTime");
  });

  it("creation (addWorkPackage) never produces a journal entry", () => {
    const scenario: Scenario = {
      ...miniScenario(),
      timeline: [
        {
          day: 1,
          events: [
            {
              t: "addWorkPackage",
              wp: { key: "urgent", subject: "New urgent thing", project: 3, status: "New" },
            },
          ],
        },
      ],
    };
    const engine = new ScenarioEngine([scenario]);
    engine.loadScenario(scenario);
    engine.advanceDay();
    const state = engine.stateSummary();
    const urgent = state.work_packages.find((w) => w.key === "urgent")!;
    expect(engine.getActivities(urgent.id)).toHaveLength(0);
  });

  it("dangling actor key is a hard 400 (frozen-contract convention)", () => {
    const scenario: Scenario = {
      ...miniScenario(),
      timeline: [{ day: 1, events: [{ t: "setStatus", wp: "main", status: "Confirmed", actor: "ghost" }] }],
    };
    const engine = new ScenarioEngine([scenario]);
    engine.loadScenario(scenario);
    expect(() => engine.advanceDay()).toThrow(MockEngineError);
  });

  it("getActivities on fixture mode / no scenario returns nothing (engine-level)", () => {
    const engine = new ScenarioEngine([]);
    expect(engine.getActivities(1101)).toEqual([]);
  });

  it("a comment event produces a content-free journal (detail null, comment set, author = user)", () => {
    const scenario: Scenario = {
      ...miniScenario(),
      name: "mini-comment",
      timeline: [
        {
          day: 1,
          events: [
            { t: "comment", wp: "main", user: "tester", text: "back to you, dev" },
          ],
        },
      ],
    };
    const engine = new ScenarioEngine([scenario]);
    engine.loadScenario(scenario);
    engine.advanceDay();

    const journals = engine.getActivities(1101);
    expect(journals).toHaveLength(1);
    const comment = journals[0]!;
    expect(comment.detail).toBeNull(); // no field change → empty details HAL-side
    expect(comment.comment).toBe("back to you, dev");
    expect(comment.actorId).toBe(12); // the tester authored it (its `user`)
    // Shares the WP's mutation-tick timestamp like every other event.
    const wp = engine.stateSummary().work_packages.find((w) => w.id === 1101)!;
    expect(comment.createdAt).toBe(wp.updated_at);
  });
});

describe("GET /api/v3/work_packages/:id/activities (HTTP)", () => {
  it("serves the ticket's journal as an OP v3 Activity collection", async () => {
    const server = await createRecordingMockOpServer("127.0.0.1", {
      scenarios: [miniScenario()],
    });
    try {
      await fetch(`${server.url}/__mock/load/mini-activities`, { method: "POST" });
      await fetch(`${server.url}/__mock/advance-day`, { method: "POST" });

      const res = await fetch(`${server.url}/api/v3/work_packages/1101/activities`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        _embedded: { elements: Array<Record<string, unknown>> };
      };
      expect(body.total).toBe(3);
      const first = body._embedded.elements[0] as {
        _type: string;
        details: Array<{ format: string; raw: string; html: string }>;
        _links: { user: { href: string | null; title?: string }; workPackage: { href: string } };
      };
      expect(first._type).toBe("Activity");
      expect(first.details).toHaveLength(1);
      // REAL shape (SPEC_11 §5): formatted {format,raw,html} text, NOT {property,old,new}.
      expect(first.details[0]?.raw).toBe("Status changed from New to Confirmed");
      expect(first.details[0]?.html).toBe(
        "<strong>Status</strong> changed from <i>New</i> to <i>Confirmed</i>",
      );
      // Real OP OMITS `title` on _links.user (SPEC_11 §4) — href/id only.
      expect(first._links.user).toEqual({ href: "/api/v3/users/11" });
      expect(first._links.workPackage.href).toBe("/api/v3/work_packages/1101");

      // Effort fields render as LABELS ("10h"/"6h"), not ISO durations.
      const remainingEntry = body._embedded.elements.find((e) =>
        (e as { details: Array<{ raw: string }> }).details[0]?.raw.startsWith("Remaining work"),
      ) as { details: Array<{ raw: string; html: string }> };
      expect(remainingEntry.details[0]?.raw).toBe("Remaining work changed from 10h to 6h");
      expect(remainingEntry.details[0]?.html).toBe(
        "<strong>Remaining work</strong> changed from <i>10h</i> to <i>6h</i>",
      );

      // Only GET reached /api/v3/*; the admin calls above are POST to /__mock/*.
      const apiV3Methods = new Set(
        server.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => r.method),
      );
      expect(apiV3Methods).toEqual(new Set(["GET"]));
    } finally {
      await server.close();
    }
  });

  it("time entries carry createdAt; spentOn >=d narrows to entries on/after a date", async () => {
    const server = await createRecordingMockOpServer("127.0.0.1", {
      scenarios: [miniScenario()],
    });
    try {
      await fetch(`${server.url}/__mock/load/mini-activities`, { method: "POST" });
      // No time entries in this mini scenario's day 1 — reuse s3-style assertion
      // shape by logging one via a fresh inline scenario instead.
      const withTime: Scenario = {
        ...miniScenario(),
        name: "mini-activities-time",
        timeline: [
          { day: 1, events: [{ t: "logTime", wp: "main", user: "dev", hours: 2 }] },
          { day: 2, events: [{ t: "logTime", wp: "main", user: "dev", hours: 3 }] },
        ],
      };
      const server2 = await createRecordingMockOpServer("127.0.0.1", { scenarios: [withTime] });
      try {
        await fetch(`${server2.url}/__mock/load/mini-activities-time`, { method: "POST" });
        await fetch(`${server2.url}/__mock/advance-day`, { method: "POST" });
        await fetch(`${server2.url}/__mock/advance-day`, { method: "POST" });

        // Day 1 = 2026-07-02 (2h), day 2 = 2026-07-03 (3h). ">=d" on the LATER
        // date excludes the earlier entry — proves it narrows, not just passes.
        const filters = encodeURIComponent(
          JSON.stringify([{ spentOn: { operator: ">=d", values: ["2026-07-03"] } }]),
        );
        const res = await fetch(`${server2.url}/api/v3/time_entries?filters=${filters}`);
        const body = (await res.json()) as {
          _embedded: { elements: Array<{ spentOn: string; createdAt: string }> };
        };
        expect(body._embedded.elements).toHaveLength(1);
        expect(body._embedded.elements[0]?.spentOn).toBe("2026-07-03");
        expect(body._embedded.elements[0]?.createdAt).toMatch(/^2026-07-03T/);
      } finally {
        await server2.close();
      }
    } finally {
      await server.close();
    }
  });

  it("s7-tester-roundtrip: activities show both reassignments + a content-free comment (bug #11762)", async () => {
    const server = await createRecordingMockOpServer("127.0.0.1", {
      scenarios: [s7TesterRoundtrip],
    });
    try {
      await fetch(`${server.url}/__mock/load/s7-tester-roundtrip`, { method: "POST" });
      // Advance through the whole round trip: handoff, log, comment, return.
      for (let i = 0; i < 4; i += 1) {
        await fetch(`${server.url}/__mock/advance-day`, { method: "POST" });
      }

      const res = await fetch(`${server.url}/api/v3/work_packages/11762/activities`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        _embedded: {
          elements: Array<{
            _type: string;
            details: Array<{ format: string; raw: string; html: string }>;
            comment: { raw: string } | null;
            _links: { user: { href: string | null; title?: string } };
          }>;
        };
      };
      // logTime creates NO journal → 4 activities: assignee, remaining, comment, assignee.
      expect(body.total).toBe(4);
      const els = body._embedded.elements;

      // 1) dev -> tester handoff, attributed to the outgoing dev. REAL shape:
      // text in details.raw/html; _links.user has NO title (id only, SPEC_11 §4/§5).
      expect(els[0]?.details[0]?.raw).toBe("Assignee changed from Dev Dvořák to Tereza Testerová");
      expect(els[0]?.details[0]?.html).toBe(
        "<strong>Assignee</strong> changed from <i>Dev Dvořák</i> to <i>Tereza Testerová</i>",
      );
      expect(els[0]?._links.user).toEqual({ href: "/api/v3/users/1" }); // dev

      // 2) the comment: typed Activity::Comment, EMPTY details, a real comment,
      // authored by the tester. Field-change activities carry comment.raw:"".
      const comment = els.find((e) => (e.comment?.raw ?? "") !== "")!;
      expect(comment._type).toBe("Activity::Comment");
      expect(comment.details).toEqual([]);
      expect(comment.comment?.raw).toMatch(/kicking it back to dev/);
      expect(comment._links.user).toEqual({ href: "/api/v3/users/2" }); // tester
      // Only ONE activity carries comment text (content-free everywhere else).
      expect(els.filter((e) => (e.comment?.raw ?? "") !== "")).toHaveLength(1);

      // 3) tester -> dev return, attributed to the outgoing tester (the #11762 activity).
      const last = els[els.length - 1]!;
      expect(last.details[0]?.raw).toBe("Assignee changed from Tereza Testerová to Dev Dvořák");
      expect(last._links.user).toEqual({ href: "/api/v3/users/2" }); // tester

      // Nothing but GET ever reached /api/v3/* (read-only guardrail).
      const apiV3Methods = new Set(
        server.requests.filter((r) => r.path.startsWith("/api/v3/")).map((r) => r.method),
      );
      expect(apiV3Methods).toEqual(new Set(["GET"]));
    } finally {
      await server.close();
    }
  });

  it("fixture mode: activities endpoint returns an empty collection, not 404", async () => {
    const server = await createRecordingMockOpServer("127.0.0.1", { scenarios: [] });
    try {
      const res = await fetch(`${server.url}/api/v3/work_packages/1001/activities`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(0);
    } finally {
      await server.close();
    }
  });
});

// ── Increment 21 (SPEC_21): status-casing divergence override ────────────────
describe("setStatus statusDisplayText override (SPEC_21)", () => {
  function casingScenario(): Scenario {
    return {
      name: "casing-unit",
      description: "status display-text override unit scenario",
      startDate: "2026-07-01",
      seed: {
        users: [{ key: "dev", id: 11, name: "Dev One", me: true }],
        versions: [{ key: "v1", id: 900, name: "v1.0", projectId: 3 }],
        workPackages: [
          {
            key: "main",
            id: 1101,
            subject: "Main ticket",
            project: 3,
            status: "New",
            assignee: "dev",
          },
        ],
      },
      timeline: [
        {
          day: 1,
          // Live status becomes canonical "In progress"; journal DISPLAYS lower-case.
          events: [{ t: "setStatus", wp: "main", status: "In progress", statusDisplayText: "in progress" }],
        },
      ],
    };
  }

  it("journal shows the overridden casing while the WP's live status stays canonical", () => {
    const engine = new ScenarioEngine([casingScenario()]);
    engine.loadScenario(casingScenario());
    engine.advanceDay();

    // Live status link (workPackageSummary) = canonical status object name.
    const wp = engine.stateSummary().work_packages.find((w) => w.id === 1101)!;
    expect(wp.status).toBe("In progress");

    // Journal detail's displayed newValue carries the override casing.
    const journal = engine.getActivities(1101)[0]!;
    expect(journal.detail?.property).toBe("status");
    expect(journal.detail?.newValue).toEqual({ id: expect.any(Number), name: "in progress" });
  });

  it("HTTP: activity html renders lower-case, but /work_packages exposes canonical status", async () => {
    const server = await createRecordingMockOpServer("127.0.0.1", {
      scenarios: [casingScenario()],
    });
    try {
      await fetch(`${server.url}/__mock/load/casing-unit`, { method: "POST" });
      await fetch(`${server.url}/__mock/advance-day`, { method: "POST" });

      const act = await fetch(`${server.url}/api/v3/work_packages/1101/activities`);
      const actBody = (await act.json()) as {
        _embedded: { elements: Array<{ details: Array<{ raw: string; html: string }> }> };
      };
      const detail = actBody._embedded.elements[0]!.details[0]!;
      // Journal prose preserves the historically-submitted lower-case casing.
      expect(detail.raw).toBe("Status changed from New to in progress");
      expect(detail.html).toBe(
        "<strong>Status</strong> changed from <i>New</i> to <i>in progress</i>",
      );

      // The WP's own status link is the CANONICAL spelling — the divergence.
      const wpRes = await fetch(`${server.url}/api/v3/work_packages`);
      const wpBody = (await wpRes.json()) as {
        _embedded: { elements: Array<{ id: number; _links: { status: { title: string } } }> };
      };
      const wp = wpBody._embedded.elements.find((e) => e.id === 1101)!;
      expect(wp._links.status.title).toBe("In progress");
    } finally {
      await server.close();
    }
  });

  it("s15-status-casing-divergence: registered scenario reproduces the mismatch", () => {
    const engine = new ScenarioEngine([s15StatusCasingDivergence]);
    engine.loadScenario(s15StatusCasingDivergence);
    engine.gotoDay(3);
    // The day-1 transition journal displays lower-case "in progress"…
    const journals = engine.getActivities(1901);
    const inProgress = journals.find(
      (j) => j.detail?.property === "status" && (j.detail.newValue as { name: string }).name === "in progress",
    );
    expect(inProgress).toBeDefined();
    // …while day 3's "Developed" transition uses canonical casing (no override).
    const developed = journals.find(
      (j) => j.detail?.property === "status" && (j.detail.newValue as { name: string }).name === "Developed",
    );
    expect(developed).toBeDefined();
  });
});
