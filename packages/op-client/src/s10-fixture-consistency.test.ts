import { s10DeveloperWorkAttribution } from "@osp/fixtures/scenarios";
import type {
  MockEvent,
  Scenario,
  ScenarioUser,
  WorkPackageSeed,
} from "@osp/fixtures/scenario-types";
import { describe, expect, it } from "vitest";
import {
  acquiredMidSprint,
  assigneeIntervals,
  holderAtInstant,
  isHolderAtInstant,
  type AssigneeChangeEvent,
} from "./assignee-intervals";

/**
 * Internal-consistency check for the S10 fixture (SPEC_15 §7): fold Agent A's
 * OWN `assigneeIntervals` over the scenario's OWN reassignment timeline and
 * confirm the intended baseline-vs-acquired classification for every developer.
 *
 * The mock journals CHANGES, not WP birth (no v1 "Assignee set to X"), so a
 * baseline holder that is never reassigned has NO assignee event — exactly the
 * case `baseline_holder_fallback` (= the reconstructed/frozen ticket_baseline
 * holder that Agent B supplies) covers. This test therefore reconstructs, per
 * ticket, the SAME three inputs Agent B will hand the engine: the ordered
 * assignee events, the creation instant, and the baseline-holder fallback.
 */

const scenario: Scenario = s10DeveloperWorkAttribution;
const ANCHOR = `${scenario.startDate}T00:00:00.000Z`; // sprint baseline anchor

const nameByKey = new Map<string, string>(
  scenario.seed.users.map((u: ScenarioUser) => [u.key, u.name]),
);
function name(key: string | null | undefined): string | null {
  if (key === null || key === undefined) return null;
  const n = nameByKey.get(key);
  if (n === undefined) throw new Error(`unknown user key: ${key}`);
  return n;
}

/** Day N → its `09:00Z` instant (day granularity is enough; every reassign here
 * is on day ≥ 1 so it lands strictly after the day-0 midnight anchor). */
function dayInstant(day: number): string {
  const base = Date.parse(`${scenario.startDate}T09:00:00.000Z`);
  return new Date(base + day * 86_400_000).toISOString();
}

interface TicketFacts {
  estimate: number | null;
  /** Baseline (seed) assignee NAME, or null; the fallback holder-at-anchor. */
  baselineHolder: string | null;
  /** Creation instant when the ticket was added mid-sprint, else null. */
  createdAt: string | null;
  events: AssigneeChangeEvent[];
}

/** Walk the seed + timeline in order, tracking each WP's live assignee, and
 * derive the assignee-change events + creation instant per ticket — mirroring
 * how the mock engine would journal them. */
function extractFacts(): Map<string, TicketFacts> {
  const facts = new Map<string, TicketFacts>();
  const liveAssignee = new Map<string, string | null>();

  function seedWp(wp: WorkPackageSeed, createdAt: string | null): void {
    const holder = name(wp.assignee ?? null);
    facts.set(wp.key, {
      estimate: wp.estimatedHours ?? null,
      // Holder-at-effective-start fallback: the seed assignee at the anchor for a
      // baseline ticket, or the creation assignee for a mid-sprint birth (the
      // mock doesn't journal births, so this is the only source — exactly what
      // Agent B supplies for an added_mid_sprint item). `createdAt` alone drives
      // the not_yet_created / no-baseline-interval behaviour.
      baselineHolder: holder,
      createdAt,
      events: [],
    });
    liveAssignee.set(wp.key, holder);
  }

  // Seeded (baseline) work packages exist at the anchor → createdAt null.
  for (const wp of scenario.seed.workPackages) seedWp(wp, null);

  for (const dayEntry of scenario.timeline) {
    for (const event of dayEntry.events) {
      applyEvent(event, dayEntry.day);
    }
  }

  function applyEvent(event: MockEvent, day: number): void {
    switch (event.t) {
      case "addWorkPackage":
        seedWp(event.wp, dayInstant(day));
        return;
      case "reassign": {
        if (event.assignee === undefined) return; // accountable-only change
        const f = facts.get(event.wp);
        if (f === undefined) throw new Error(`reassign before add: ${event.wp}`);
        const from = liveAssignee.get(event.wp) ?? null;
        const to = name(event.assignee);
        if (to !== from) {
          f.events.push({ occurred_at: dayInstant(day), from, to });
          liveAssignee.set(event.wp, to);
        }
        return;
      }
      default:
        return; // status/version/time events don't affect assignee intervals
    }
  }

  return facts;
}

const FACTS = extractFacts();

function intervalsFor(key: string) {
  const f = FACTS.get(key);
  if (f === undefined) throw new Error(`no facts for ${key}`);
  return assigneeIntervals({
    wp_op_id: 0,
    events: f.events,
    baseline_anchor: ANCHOR,
    created_at: f.createdAt,
    baseline_holder_fallback: f.baselineHolder,
  });
}

describe("S10 fixture — SPEC_15 §7 assignee-interval consistency", () => {
  const BELKA = "Jan Belka";
  // Fixture uses "Zbyněk Kovář"/"Marek Sova", NOT SPEC_15's literal prose
  // names "Zbynek Trnka"/"Arend Kuiper" — those already identify a
  // DIFFERENT person in Increment 14's s9-role-closure fixture (shared app
  // DB across e2e spec files); see the NOTE in s10-developer-work-attribution.ts.
  const TRNKA = "Zbyněk Kovář";

  it("Jan Belka's 3 tickets fold to ACQUIRED (not baseline) with estimate sum 19h", () => {
    const belkaTickets = ["t5a", "t5b", "t5c"];
    let estimateSum = 0;
    for (const key of belkaTickets) {
      const ivs = intervalsFor(key);
      // Belka never held it at the baseline anchor …
      expect(isHolderAtInstant(ivs, BELKA, ANCHOR)).toBe(false);
      // … and his earliest interval starts strictly after the anchor.
      expect(acquiredMidSprint(ivs, BELKA, ANCHOR)).toBe(true);
      estimateSum += FACTS.get(key)!.estimate ?? 0;
    }
    expect(estimateSum).toBe(19); // 8 + 6 + 5 — the DoD's PLANNED figure
  });

  it("Zbynek Trnka's ticket is baseline-held by HIM at the anchor (est 30h)", () => {
    const ivs = intervalsFor("t2");
    expect(isHolderAtInstant(ivs, TRNKA, ANCHOR)).toBe(true);
    expect(acquiredMidSprint(ivs, TRNKA, ANCHOR)).toBe(false);
    expect(FACTS.get("t2")!.estimate).toBe(30);
    // Delivered downstream: he hands it to the tester Marek Sova by the end.
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe("Marek Sova");
  });

  it("Row 1 active — Petr Novák holds t1 at baseline and still at the end", () => {
    const ivs = intervalsFor("t1");
    expect(isHolderAtInstant(ivs, "Petr Novák", ANCHOR)).toBe(true);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe("Petr Novák");
  });

  it("Row 3 + Row 6 — Milan Černý baseline on t3, redistributed to Ota Horák who then holds it", () => {
    const ivs = intervalsFor("t3");
    expect(isHolderAtInstant(ivs, "Milan Černý", ANCHOR)).toBe(true);
    // Horák is NOT baseline but acquires it mid-sprint and still holds it (idle).
    expect(isHolderAtInstant(ivs, "Ota Horák", ANCHOR)).toBe(false);
    expect(acquiredMidSprint(ivs, "Ota Horák", ANCHOR)).toBe(true);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe("Ota Horák");
  });

  it("Row 4 removed_no_work — Radek Dostál holds t4 at baseline (scope removal is separate)", () => {
    const ivs = intervalsFor("t4");
    expect(isHolderAtInstant(ivs, "Radek Dostál", ANCHOR)).toBe(true);
  });

  it("Row 7 churned_away — Ivo Svoboda acquires t6 mid-sprint then moves on (not final holder)", () => {
    const ivs = intervalsFor("t6");
    expect(isHolderAtInstant(ivs, "Ivo Svoboda", ANCHOR)).toBe(false);
    expect(acquiredMidSprint(ivs, "Ivo Svoboda", ANCHOR)).toBe(true);
    // He does not hold it at the end — it churned to unassigned (not back to
    // the tester: that would flip it "done" via the role-matrix with zero
    // developer logged time, wrongly crediting Svoboda's DELIVERED).
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).not.toBe("Ivo Svoboda");
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBeNull();
  });
});
