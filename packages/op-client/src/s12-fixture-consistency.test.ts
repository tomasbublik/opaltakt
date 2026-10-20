import { s12HandoffAttribution } from "@osp/fixtures/scenarios";
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
 * Internal-consistency check for the S12 fixture (SPEC_17 §3): fold Agent A's
 * OWN `assigneeIntervals` over the scenario's OWN reassignment timeline and
 * confirm the BUG-1 PRECONDITION holds at the interval level, INDEPENDENT of
 * whether Agent B's downstream `developerSegments` classification fix has
 * landed yet:
 *   • the handoff ticket's middle holder (Tobias Bubenik) has an interval
 *     covering a period he held it, is NOT the baseline holder, DID acquire it
 *     mid-sprint, and genuinely LOGGED real time (not just an estimate change);
 *   • the baseline holder (Cameron Dalby) is the holder at the anchor and
 *     the ticket's final holder is ANOTHER developer (Daniel Beneš) — the
 *     `handoff` precondition;
 *   • the a/b/d/g coverage tickets fold to their intended baseline-vs-acquired
 *     shapes with the exact estimate/logged numbers Agent D asserts against.
 *
 * Mirrors s10-fixture-consistency.test.ts: the mock journals CHANGES, not WP
 * birth, so a never-reassigned baseline holder has NO assignee event — exactly
 * the `baseline_holder_fallback` (the reconstructed ticket_baseline holder
 * Agent B supplies) case. This test reconstructs the same three inputs Agent B
 * hands the engine per ticket: ordered assignee events, creation instant, and
 * the baseline-holder fallback — plus per-(ticket,user) logged hours.
 */

const scenario: Scenario = s12HandoffAttribution;
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

/** Day N → its `09:00Z` instant (every reassign here is on day ≥ 0 at 09:00,
 * strictly after the day-0 midnight anchor). */
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
  /** Total logged hours per holder NAME (from paired logTime events). */
  loggedByName: Map<string, number>;
}

/** Walk the seed + timeline in order, tracking each WP's live assignee and
 * logged time, deriving the assignee-change events + creation instant per
 * ticket — mirroring how the mock engine would journal them. */
function extractFacts(): Map<string, TicketFacts> {
  const facts = new Map<string, TicketFacts>();
  const liveAssignee = new Map<string, string | null>();

  function seedWp(wp: WorkPackageSeed, createdAt: string | null): void {
    const holder = name(wp.assignee ?? null);
    facts.set(wp.key, {
      estimate: wp.estimatedHours ?? null,
      baselineHolder: holder,
      createdAt,
      events: [],
      loggedByName: new Map(),
    });
    liveAssignee.set(wp.key, holder);
  }

  for (const wp of scenario.seed.workPackages) seedWp(wp, null);

  for (const dayEntry of scenario.timeline) {
    for (const event of dayEntry.events) applyEvent(event, dayEntry.day);
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
      case "logTime": {
        const f = facts.get(event.wp);
        if (f === undefined) throw new Error(`logTime before add: ${event.wp}`);
        const who = name(event.user)!;
        f.loggedByName.set(who, (f.loggedByName.get(who) ?? 0) + event.hours);
        return;
      }
      default:
        return; // status/version/remaining events don't affect intervals/logs
    }
  }

  return facts;
}

const FACTS = extractFacts();

function factsFor(key: string): TicketFacts {
  const f = FACTS.get(key);
  if (f === undefined) throw new Error(`no facts for ${key}`);
  return f;
}

function intervalsFor(key: string) {
  const f = factsFor(key);
  return assigneeIntervals({
    wp_op_id: 0,
    events: f.events,
    baseline_anchor: ANCHOR,
    created_at: f.createdAt,
    baseline_holder_fallback: f.baselineHolder,
  });
}

const DALBY = "Cameron Dalby";
const BUBENIK = "Tobias Bubenik";
const BENES = "Daniel Beneš";
const POKORNY = "Lukáš Pokorný";
const FIALA = "Jakub Fiala";
const KRAUS = "Roman Kraus";
const URBAN = "Vít Urban";
const DOLEZAL = "Eva Doležalová";

describe("S12 fixture — SPEC_17 §3 handoff-attribution consistency", () => {
  it("BUG 1: Tobias Bubenik ACQUIRED the handoff ticket (not baseline) AND logged real time", () => {
    const ivs = intervalsFor("t_handoff");
    const f = factsFor("t_handoff");

    // Baseline holder is Cameron Dalby, NOT Tobias.
    expect(isHolderAtInstant(ivs, DALBY, ANCHOR)).toBe(true);
    expect(isHolderAtInstant(ivs, BUBENIK, ANCHOR)).toBe(false);

    // Tobias is not baseline but acquired it mid-sprint …
    expect(acquiredMidSprint(ivs, BUBENIK, ANCHOR)).toBe(true);
    // … held it in TWO separate, non-contiguous windows (mirrors real #11762)…
    const tobiasIvs = ivs.filter((iv) => iv.holder_name === BUBENIK);
    expect(tobiasIvs).toHaveLength(2);
    // … and genuinely LOGGED time (the real "who logged" signal, not the
    // estimate "Work set to 12h" activity) — 12h total on a 12h estimate.
    expect(f.loggedByName.get(BUBENIK)).toBe(12);
    expect(f.estimate).toBe(12);
    // → the engine MUST classify Tobias as `acquired` (RED, Change +12h) here,
    //   even though he arrived via a dev→dev reassignment, not a sprint-add.
  });

  it("handoff precondition: Cameron Dalby is baseline; the final holder is ANOTHER developer", () => {
    const ivs = intervalsFor("t_handoff");
    // Cameron held it at the anchor; Tobias never logged FIRST — Cameron
    // handed it on. The FINAL holder is Daniel Beneš (a developer), so
    // Cameron is a `handoff` (c), not a `removed` (d).
    expect(isHolderAtInstant(ivs, DALBY, ANCHOR)).toBe(true);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe(BENES);
    // Cameron himself never logged on it.
    expect(factsFor("t_handoff").loggedByName.get(DALBY) ?? 0).toBe(0);
  });

  it("Daniel Beneš is the acquired-but-idle final holder (not baseline, no log)", () => {
    const ivs = intervalsFor("t_handoff");
    expect(isHolderAtInstant(ivs, BENES, ANCHOR)).toBe(false);
    expect(acquiredMidSprint(ivs, BENES, ANCHOR)).toBe(true);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe(BENES);
    expect(factsFor("t_handoff").loggedByName.get(BENES) ?? 0).toBe(0);
  });

  it("row a baseline_worked — Lukáš Pokorný baseline on t_a, logs 10h, still holds", () => {
    const ivs = intervalsFor("t_a");
    const f = factsFor("t_a");
    expect(isHolderAtInstant(ivs, POKORNY, ANCHOR)).toBe(true);
    expect(acquiredMidSprint(ivs, POKORNY, ANCHOR)).toBe(false);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe(POKORNY);
    expect(f.loggedByName.get(POKORNY)).toBe(10);
    expect(f.estimate).toBe(10);
  });

  it("baseline_worked (green) — Jakub Fiala baseline on t_b, never logs, still holds (Increment 26: former baseline_idle merged into baseline_worked)", () => {
    const ivs = intervalsFor("t_b");
    const f = factsFor("t_b");
    expect(isHolderAtInstant(ivs, FIALA, ANCHOR)).toBe(true);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBe(FIALA);
    expect(f.loggedByName.get(FIALA) ?? 0).toBe(0);
    expect(f.estimate).toBe(7);
  });

  it("row d removed — Roman Kraus baseline on t_d, never logs, abandoned (unassigned)", () => {
    const ivs = intervalsFor("t_d");
    const f = factsFor("t_d");
    expect(isHolderAtInstant(ivs, KRAUS, ANCHOR)).toBe(true);
    // No developer picks it up → it ends unassigned (a `removed` precondition,
    // distinct from a dev→dev `handoff`).
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBeNull();
    expect(f.loggedByName.get(KRAUS) ?? 0).toBe(0);
    expect(f.estimate).toBe(6);
  });

  it("row g churned — Vít Urban acquires t_g mid-sprint then moves on, never logging", () => {
    const ivs = intervalsFor("t_g");
    const f = factsFor("t_g");
    // Baseline holder is the TESTER (Doležalová) — no developer segment for her.
    expect(isHolderAtInstant(ivs, DOLEZAL, ANCHOR)).toBe(true);
    // Urban is not baseline, acquires it, logs nothing, and is NOT the final
    // holder (he moved it on → unassigned) → `churned`, informative only.
    expect(isHolderAtInstant(ivs, URBAN, ANCHOR)).toBe(false);
    expect(acquiredMidSprint(ivs, URBAN, ANCHOR)).toBe(true);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).not.toBe(URBAN);
    expect(holderAtInstant(ivs, dayInstant(4))?.holder_name).toBeNull();
    expect(f.loggedByName.get(URBAN) ?? 0).toBe(0);
  });

  it("roll-up preview (SPEC_17 §1): PLANNED contributors ≥ 0; CHANGE = {e:+12, d:-6}", () => {
    // Informational — Agent B computes the real numbers, but the fixture is
    // built so these are the only nonzero contributions:
    //   PLANNED (Σ estimate over baseline-retained tickets): Pokorný 10, Fiala 7.
    expect(factsFor("t_a").estimate).toBe(10); // Pokorný baseline_worked
    expect(factsFor("t_b").estimate).toBe(7); //  Fiala   baseline_worked (Increment 26: was baseline_idle)
    //   CHANGE (+acquired − removed): Bubenik +12 (t_handoff), Kraus −6 (t_d).
    expect(factsFor("t_handoff").loggedByName.get(BUBENIK)).toBe(12);
    expect(factsFor("t_handoff").estimate).toBe(12);
    expect(factsFor("t_d").estimate).toBe(6);
  });
});
