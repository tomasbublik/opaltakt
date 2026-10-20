/**
 * Shared building blocks for the SPEC_03 scenarios (S1–S6).
 *
 * Scenarios are DATA conforming to the frozen Phase-0 contract in
 * fixtures/scenario-types.ts; the mock engine (fixtures/mock-op-server/)
 * interprets them. These helpers only make the data terser to write and
 * enforce one hard rule from the contract: `logTime` never implicitly
 * decreases remaining, so every logged workday is emitted as a PAIRED
 * logTime + setRemaining.
 */
import type {
  MockEvent,
  ScenarioUser,
  TimelineDay,
  WorkPackageSeed,
} from "../scenario-types";

// ── Common cast (SPEC_03 §3: dev / tester / customer) ────────────────────────

/**
 * Every scenario seeds the same three people. `dev` is the /users/me identity
 * (me: true) so connecting the Sprint Planner "as the developer" just works.
 * `customer` exists so the accountable link is a REAL, separate person.
 */
export const CAST: readonly ScenarioUser[] = [
  { key: "dev", id: 1, name: "Dev Dvořák", login: "dev.dvorak", me: true },
  { key: "tester", id: 2, name: "Tereza Testerová", login: "tereza.testerova" },
  { key: "customer", id: 3, name: "Karel Zákazník", login: "karel.zakaznik" },
];

/** Fresh mutable copy of the cast for a scenario seed. */
export function cast(): ScenarioUser[] {
  return CAST.map((u) => ({ ...u }));
}

// ── Event shorthands ─────────────────────────────────────────────────────────

export const ev = {
  /**
   * Change `wp`'s status. `displayText` (Increment 21 / SPEC_21) OPTIONALLY
   * overrides only the casing shown in THIS transition's journal prose (e.g.
   * "in progress") while the WP's own status link keeps the canonical spelling
   * ("In progress") — the exact divergence the status-normalization fix targets.
   */
  status(wp: string, status: string, displayText?: string): MockEvent {
    return displayText === undefined
      ? { t: "setStatus", wp, status }
      : { t: "setStatus", wp, status, statusDisplayText: displayText };
  },
  /** Change only the assignee; the accountable link is left untouched. */
  assign(wp: string, assignee: string | null): MockEvent {
    return { t: "reassign", wp, assignee };
  },
  /** `user` posts a comment on `wp` (author = the comment's actor). */
  comment(wp: string, user: string, text: string): MockEvent {
    return { t: "comment", wp, user, text };
  },
  /**
   * Move `wp` to version `version` (a seed version key, or null to clear it).
   * Journals a "Version changed from X to Y" — the SPEC_12 §3 scope-churn
   * signal a retrospective replay reads to place a ticket into (or out of) a
   * sprint's version mid-window.
   */
  version(wp: string, version: string | null): MockEvent {
    return { t: "setVersion", wp, version };
  },
  add(wp: WorkPackageSeed): MockEvent {
    return { t: "addWorkPackage", wp };
  },
};

/**
 * One logged workday: `user` books `hours` on `wp` and the remaining work is
 * explicitly set to `remainingAfter` (the contract-mandated pairing).
 */
export function work(
  wp: string,
  user: string,
  hours: number,
  remainingAfter: number,
): MockEvent[] {
  return [
    { t: "logTime", wp, user, hours },
    { t: "setRemaining", wp, hours: remainingAfter },
  ];
}

/** A single timeline day. */
export function on(day: number, ...events: MockEvent[]): TimelineDay {
  return { day, events };
}

// ── Timeline generators ──────────────────────────────────────────────────────

/**
 * Burn a work package down across several days: for each `[day, hours]` pair
 * emit a paired logTime + setRemaining, with remaining computed by subtracting
 * from `startRemaining` (never below 0). Keeps multi-day burndowns declarative:
 *
 *   burn("epic", "dev", 80, [[0, 6], [1, 6], ...])
 */
export function burn(
  wp: string,
  user: string,
  startRemaining: number,
  days: ReadonlyArray<readonly [day: number, hours: number]>,
): TimelineDay[] {
  let remaining = startRemaining;
  return days.map(([day, hours]) => {
    remaining = Math.max(0, Math.round((remaining - hours) * 100) / 100);
    return on(day, ...work(wp, user, hours, remaining));
  });
}

/**
 * Merge timeline fragments into one sorted timeline (unique day numbers).
 * Within a day, events keep the ARGUMENT order of the fragments — so put
 * "status flips" before/after "work" fragments deliberately.
 */
export function mergeTimelines(
  ...parts: ReadonlyArray<readonly TimelineDay[]>
): TimelineDay[] {
  const byDay = new Map<number, MockEvent[]>();
  for (const part of parts) {
    for (const { day, events } of part) {
      const list = byDay.get(day);
      if (list) list.push(...events);
      else byDay.set(day, [...events]);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, events]) => ({ day, events }));
}
