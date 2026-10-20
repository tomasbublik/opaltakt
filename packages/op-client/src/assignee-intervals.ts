import type { AssigneeInterval, PersonRole } from "@osp/contracts";
import { parseDetail } from "./journal";
import type { OpActivity } from "./types";

/**
 * SPEC_15 §5 — assignee-interval folding.
 *
 * GENERALIZES `reconstruct.ts`'s `stateAtDate` (a SINGLE point-in-time snapshot
 * of one ticket's assignee) into the FULL TIMELINE of who held a ticket, from
 * when to when — the `AssigneeInterval[]` shape Agent B's `developerSegments`
 * engine consumes to answer the two questions the SPEC_15 §2 table turns on:
 *   • "was developer X the holder at the sprint's baseline anchor?" (rows 1–4),
 *   • "who held the ticket at the dev-done status transition?" (DELIVERED
 *     tie-break, SPEC_15 §3).
 *
 * SEMANTICS (mirror `stateAtDate` exactly — SPEC_15 §5 / Increment 13):
 *   • Identity is the NAME. OP journals carry a display name, never a numeric
 *     id, so `holder_name` is the load-bearing field. `holder_op_user_id` /
 *     `holder_role` are OPPORTUNISTIC enrichment (resolved by an optional
 *     caller-supplied resolver, or left null for the consumer to fill) — never
 *     a precondition, never blocks an interval from existing.
 *   • A "cleared"/unassigned interval is a REAL observed state, represented
 *     with `holder_name = null` — NOT a gap (same as `stateAtDate`'s `to: null`
 *     Assignee event).
 *   • The final interval is OPEN (`to = null`) — the current holder.
 *
 * PURE (no I/O). It reuses `journal.ts`'s `parseDetail` primitive for the
 * OpActivity adapter rather than re-implementing the html/raw regexes.
 */

/**
 * One `assignee_changed` observation for a ticket — normalized from either an OP
 * journal activity (via {@link assigneeChangeEvents}) or a stored
 * `ticket_changelog_entry` (its parsed `ChangelogDetail` `assignee_changed`
 * `{from, to}` + the entry's `occurred_at`). Only `to` + `occurred_at` are
 * load-bearing for the fold; `from` is kept for fidelity/debugging.
 */
export interface AssigneeChangeEvent {
  /** ISO datetime the change was journaled (the activity's `createdAt`). */
  occurred_at: string;
  /** Previous holder display name; null when unknown or cleared-from. */
  from: string | null;
  /** New holder display name; null = the ticket was cleared/unassigned. */
  to: string | null;
}

/** Opportunistic enrichment for one holder name (Increment 13 "person = name").
 * Return `{ op_user_id: null, role: null }` for anything unresolved. */
export type HolderResolver = (
  holderName: string | null,
) => { op_user_id: number | null; role: PersonRole | null };

export interface AssigneeIntervalInput {
  /** The ticket these intervals belong to (copied onto every interval). */
  wp_op_id: number;
  /** The ticket's `assignee_changed` events, in ANY order (sorted internally
   * ascending by `occurred_at` — mirrors `stateAtDate`). */
  events: AssigneeChangeEvent[];
  /** The baseline anchor: `sprint.start_date` for a retrospective sprint, else
   * the activation moment (`activated_at`). ISO datetime OR a bare `YYYY-MM-DD`
   * (normalized to UTC midnight for the emitted `from`). */
  baseline_anchor: string;
  /** The ticket's creation moment (earliest activity's `createdAt`), or null
   * when unknown. When it is AFTER `baseline_anchor` the ticket did not exist
   * at the anchor (`not_yet_created`, mirroring `stateAtDate`) — there is NO
   * baseline interval; the first interval opens at the creation time instead. */
  created_at?: string | null;
  /**
   * The pre-resolved holder NAME to fall back to when NO event determines the
   * holder at the effective start (i.e. no `assignee_changed` event at/<= the
   * anchor, or at/<= the creation time for a `not_yet_created` ticket). The
   * caller resolves this from `ticket_baseline.original_assignee` (via
   * `assignee_name_raw`, or a name resolved from `assignee_op_id`) — this
   * module never reaches into DB types. `null` = genuinely unassigned/unknown
   * at the effective start (a real state, not a gap).
   */
  baseline_holder_fallback?: string | null;
  /** Optional name → id/role enrichment; when omitted every interval's
   * `holder_op_user_id`/`holder_role` is null. */
  resolveHolder?: HolderResolver;
}

/** ms-since-epoch for an ISO datetime/date; NaN for an unparseable value. */
function toMs(iso: string): number {
  return Date.parse(iso);
}

/** Normalize a bare `YYYY-MM-DD` to a valid IsoDateTime (UTC midnight); pass a
 * value that already carries a time component through unchanged. Keeps every
 * emitted `from`/`to` a schema-valid `AssigneeInterval` datetime. */
function toIsoDateTime(s: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
}

/** Ascending (`occurred_at`) copy — never mutates the input. */
function sortByOccurredAt(events: AssigneeChangeEvent[]): AssigneeChangeEvent[] {
  return [...events].sort((a, b) => toMs(a.occurred_at) - toMs(b.occurred_at));
}

/**
 * Fold a ticket's `assignee_changed` events into the full `AssigneeInterval[]`
 * timeline (see the module doc for the exact algorithm, locked in Phase 0):
 *
 *  1. Sort events ascending by `occurred_at`.
 *  2. Effective start = the creation time when the ticket was created AFTER the
 *     anchor (`not_yet_created`), else the anchor itself.
 *  3. Baseline holder = the last `to` of all events at/<= the effective start;
 *     `baseline_holder_fallback` when none cover it.
 *  4. Open the first interval at the effective start with that holder. For each
 *     later event T: close the current interval (`to = T.occurred_at`) and open
 *     a new one (`from = T.occurred_at`, `holder = T.to`). The final interval is
 *     left open (`to = null`).
 *
 * Always returns at least one interval (the open baseline/first interval), even
 * with no events.
 */
export function assigneeIntervals(input: AssigneeIntervalInput): AssigneeInterval[] {
  const resolve: HolderResolver =
    input.resolveHolder ?? (() => ({ op_user_id: null, role: null }));
  const sorted = sortByOccurredAt(input.events);

  const anchorMs = toMs(input.baseline_anchor);
  const createdAt = input.created_at ?? null;
  const createdMs = createdAt !== null ? toMs(createdAt) : null;
  const notYetCreated = createdMs !== null && createdMs > anchorMs;

  // The instant the ticket's own timeline starts within (or at) the sprint: the
  // anchor normally, but the creation time when the ticket only came into
  // existence mid-sprint (there is no pre-creation baseline interval then).
  const effectiveStart = notYetCreated ? createdAt! : input.baseline_anchor;
  const effectiveStartMs = notYetCreated ? createdMs! : anchorMs;

  // Baseline holder: fold every event AT or BEFORE the effective start; the
  // last `to` wins. An initial "Assignee set to X" journaled exactly at the
  // creation time is therefore absorbed here (no zero-length first interval),
  // not re-emitted below. `undefined` = no event covered it → use the fallback.
  let baselineHolder: string | null | undefined = undefined;
  for (const ev of sorted) {
    if (toMs(ev.occurred_at) > effectiveStartMs) break;
    baselineHolder = ev.to;
  }
  const firstHolder: string | null =
    baselineHolder === undefined ? input.baseline_holder_fallback ?? null : baselineHolder;

  const intervals: AssigneeInterval[] = [];
  let curFrom = toIsoDateTime(effectiveStart);
  let curHolder: string | null = firstHolder;

  for (const ev of sorted) {
    // Events at/<= the effective start were folded into the baseline holder.
    if (toMs(ev.occurred_at) <= effectiveStartMs) continue;
    const at = toIsoDateTime(ev.occurred_at);
    intervals.push(makeInterval(input.wp_op_id, curHolder, curFrom, at, resolve));
    curFrom = at;
    curHolder = ev.to;
  }
  intervals.push(makeInterval(input.wp_op_id, curHolder, curFrom, null, resolve));
  return intervals;
}

function makeInterval(
  wp_op_id: number,
  holderName: string | null,
  from: string,
  to: string | null,
  resolve: HolderResolver,
): AssigneeInterval {
  const { op_user_id, role } = resolve(holderName);
  return {
    wp_op_id,
    holder_op_user_id: op_user_id,
    holder_name: holderName,
    holder_role: holderName === null ? null : role,
    from,
    to,
  };
}

/**
 * Adapter: derive a ticket's `AssigneeChangeEvent[]` from its OP activities,
 * reusing `journal.ts`'s `parseDetail` (so the html/raw regexes live in ONE
 * place — SPEC_12 §1). Only `Assignee` details become events; order follows the
 * activities' `createdAt` after {@link assigneeIntervals} sorts them, so the
 * input order here is irrelevant. Companion to {@link creationInstant} for the
 * `not_yet_created` input.
 */
export function assigneeChangeEvents(activities: OpActivity[]): AssigneeChangeEvent[] {
  const events: AssigneeChangeEvent[] = [];
  for (const activity of activities) {
    for (const detail of activity.details) {
      const parsed = parseDetail(detail);
      if (parsed === null || parsed.field !== "Assignee") continue;
      events.push({ occurred_at: activity.createdAt, from: parsed.from, to: parsed.to });
    }
  }
  return events;
}

/** The ticket's creation instant = its earliest activity's `createdAt` (mirrors
 * `stateAtDate`'s `created_at`). Null for an empty activity array. Pass to
 * {@link assigneeIntervals}'s `created_at` for the `not_yet_created` case. */
export function creationInstant(activities: OpActivity[]): string | null {
  let earliest: string | null = null;
  for (const activity of activities) {
    if (earliest === null || toMs(activity.createdAt) < toMs(earliest)) {
      earliest = activity.createdAt;
    }
  }
  return earliest;
}

// ── Derived facts (SPEC_15 §5) ───────────────────────────────────────────────

/** The interval covering `iso` (`from <= iso < to`, or `to === null` for the
 * open interval), or null when `iso` precedes the first interval. Intervals are
 * assumed contiguous & ordered as produced by {@link assigneeIntervals}. */
export function holderAtInstant(
  intervals: AssigneeInterval[],
  iso: string,
): AssigneeInterval | null {
  const t = toMs(iso);
  for (const iv of intervals) {
    const fromMs = toMs(iv.from);
    const toMsVal = iv.to === null ? Infinity : toMs(iv.to);
    if (t >= fromMs && t < toMsVal) return iv;
  }
  return null;
}

/**
 * "In baseline" for developer X (SPEC_15 §5) — X is the holder of the interval
 * covering the anchor. Name match is exact (identity IS the name, Increment 13);
 * trims surrounding whitespace only.
 */
export function isHolderAtInstant(
  intervals: AssigneeInterval[],
  holderName: string,
  iso: string,
): boolean {
  const iv = holderAtInstant(intervals, iso);
  return iv !== null && iv.holder_name !== null && sameName(iv.holder_name, holderName);
}

/**
 * "Acquired mid-sprint" for developer X (SPEC_15 §5, the Row-5 precondition) —
 * X's EARLIEST interval as holder starts STRICTLY AFTER the anchor. False when
 * X never holds the ticket, or holds it already at/through the anchor.
 */
export function acquiredMidSprint(
  intervals: AssigneeInterval[],
  holderName: string,
  anchor: string,
): boolean {
  const anchorMs = toMs(anchor);
  let earliest: number | null = null;
  for (const iv of intervals) {
    if (iv.holder_name !== null && sameName(iv.holder_name, holderName)) {
      const fromMs = toMs(iv.from);
      if (earliest === null || fromMs < earliest) earliest = fromMs;
    }
  }
  return earliest !== null && earliest > anchorMs;
}

/** Exact, whitespace-trimmed display-name equality (Increment 13 identity). */
function sameName(a: string, b: string): boolean {
  return a.trim() === b.trim();
}
