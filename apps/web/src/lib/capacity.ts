import type { BacklogItem, CapacityLine } from "@osp/contracts";

/**
 * Client-side helpers around the sprint board's capacity/load display.
 *
 * ⚠️ Increment 30 (`docs/INCREMENT_30_CONTRACTS.md` §0a) — this file does NOT
 * compute capacity. `GET /sprints/:id/capacity` exists and is the only source
 * of `planned_hours`: the server resolves every ticket's estimate-of-record
 * and rolls it up per assignee (`CapacityLine`). What lives here is purely
 * presentational plumbing on top of that server response:
 *   - `applyAvailability` overlays LOCALLY-TYPED availability (so a planner
 *     gets live overload feedback while typing, before saving) onto the
 *     server-authoritative lines, and re-sums the server's own `planned_hours`
 *     into `total_available_hours` / `total_planned_hours` for the aggregate —
 *     it never recomputes `planned_hours` itself, only reads it off `l`.
 *   - `mergeCapacityLines` / `capacityLineKey` / `isUnassignedBucketLine` /
 *     `backlogPeople` are identity and bookkeeping helpers (who's a line, who
 *     was added this session, how a line is keyed) — no hour arithmetic.
 * A stale version of this comment used to claim the opposite ("the board
 * derives per-assignee load directly from typed backlog data" because "the
 * frozen contract has no GET for a sprint's capacity") — both clauses were
 * already false by the time Increment 30 started, and reading that comment as
 * if it were the code sent that whole increment chasing a client-side
 * aggregation bug that does not exist. Don't reintroduce it.
 */

export const UNASSIGNED_KEY = "unassigned";

/** Group key for an item: its assignee OP id, or the unassigned bucket. */
export function assigneeKey(item: Pick<BacklogItem, "assignee_op_id">): string {
  return item.assignee_op_id == null ? UNASSIGNED_KEY : String(item.assignee_op_id);
}

/**
 * Stable key for a server capacity line. Increment 13 (REVISED, SPEC_13
 * §1a/§3): a retro-reconstructed person's identity is their NAME — such a
 * line has `op_user_id: null` but a real `member_id` (the backend provisions
 * a roster member per distinct name), and is NOT the same thing as the
 * genuinely-unassigned bucket (`op_user_id` AND `member_id` both null, see
 * CapacityLine's own contract doc). Keys by op_user_id first (unchanged for
 * every pre-Increment-13 line), falls back to member_id so two different
 * name-only lines never collide under the same key, and only falls all the
 * way back to the shared UNASSIGNED_KEY when neither identifier is present.
 */
export function capacityLineKey(line: Pick<CapacityLine, "op_user_id" | "member_id">): string {
  if (line.op_user_id != null) return String(line.op_user_id);
  if (line.member_id != null) return `m${line.member_id}`;
  return UNASSIGNED_KEY;
}

/**
 * True for the single genuinely-unassigned bucket line (a ticket with no
 * assignee at all) — distinct from a name-only retro-reconstructed line
 * (op_user_id null but member_id set), which is a normal, fully-functional
 * person (SPEC_13 §1a).
 */
export function isUnassignedBucketLine(line: Pick<CapacityLine, "op_user_id" | "member_id">): boolean {
  return line.op_user_id == null && line.member_id == null;
}

/** A person who can be assigned sprint availability: a real OP user id + display name. */
export interface AssignablePerson {
  op_user_id: number;
  name: string;
}

/**
 * Distinct real assignees (op_user_id + name) found in a project backlog. The
 * unassigned bucket has no op_user_id and can't be persisted, so it is skipped.
 * First name wins for a given id; a missing name falls back to a stable label.
 */
export function backlogPeople(items: readonly BacklogItem[]): AssignablePerson[] {
  const seen = new Map<number, string>();
  for (const it of items) {
    if (it.assignee_op_id == null) continue;
    if (!seen.has(it.assignee_op_id)) {
      seen.set(it.assignee_op_id, it.assignee_name ?? `User #${it.assignee_op_id}`);
    }
  }
  return [...seen.entries()].map(([op_user_id, name]) => ({ op_user_id, name }));
}

/**
 * Merge server capacity lines with a set of explicitly-added people so the planner
 * can set availability for someone before any of their work is in the sprint. The
 * board no longer auto-seeds every backlog assignee; `people` here are only those
 * the planner picked via "Add person" this session. Server lines (people with items
 * and/or already-saved capacity) win; each added person not already present gets a
 * synthesized zero line (planned 0, available 0). Result is de-duplicated by
 * op_user_id, unassigned bucket preserved and sorted last.
 */
export function mergeCapacityLines(
  lines: readonly CapacityLine[],
  people: readonly AssignablePerson[],
): CapacityLine[] {
  const byKey = new Map<string, CapacityLine>();
  for (const l of lines) byKey.set(capacityLineKey(l), l);
  for (const p of people) {
    const key = String(p.op_user_id);
    if (!byKey.has(key)) {
      byKey.set(key, {
        member_id: null,
        op_user_id: p.op_user_id,
        name: p.name,
        available_hours: 0,
        planned_hours: 0,
        overloaded: false,
        has_sprint_work: false, // explicitly added, no sprint items
        // Locally-synthesized line, no server-side scope-change data (SPEC_05 §2)
        // or grey-redistribution data (SPEC_09 §3/§4) — this line has no sprint
        // work at all yet.
        baseline_hours: 0,
        added_hours: 0,
        removed_hours: 0,
        redistributed_out_hours: 0,
        redistributed_in_hours: 0,
        // Increment 14 (SPEC_14 §2): this line has no server-known role yet
        // (it's a locally-synthesized "Add person" row from the project
        // backlog, which carries no role data) — defaults to "developer" /
        // is_developer true, same back-compat default the contract itself
        // specifies for any pre-Increment-14 caller. Once saved, the next
        // GET /capacity reflects the person's REAL persisted role.
        role: "developer",
        is_developer: true,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const au = isUnassignedBucketLine(a);
    const bu = isUnassignedBucketLine(b);
    if (au !== bu) return au ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface CapacitySummary {
  lines: CapacityLine[];
  total_available_hours: number;
  total_planned_hours: number;
  /** True when any assignee is overloaded, or aggregate load exceeds aggregate capacity. */
  overloaded: boolean;
}

/**
 * Overlay locally-edited availability on the server-authoritative capacity lines
 * (from GET /sprints/:id/capacity, whose `planned_hours` already reflect the
 * persisted sprint items). Used for live overload feedback while a planner types
 * new availability before saving; when a key is absent the server value stands.
 *
 * @param lines      server capacity lines (planned_hours already computed)
 * @param available  available hours keyed by {@link capacityLineKey} (missing = server value)
 */
export function applyAvailability(
  lines: readonly CapacityLine[],
  available: Readonly<Record<string, number>>,
): CapacitySummary {
  const out: CapacityLine[] = lines.map((l) => {
    const key = capacityLineKey(l);
    const availableHours = available[key] ?? l.available_hours;
    const planned = round1(l.planned_hours);
    return {
      ...l,
      available_hours: availableHours,
      planned_hours: planned,
      overloaded: availableHours > 0 && planned > availableHours,
    };
  });

  // Increment 14 (SPEC_14 §2 consequence #1) — "capacity = Developers only":
  // a non-developer line (tester/customer/other, and the unassigned bucket,
  // whose role is "unset") still renders — its hours are visible as work that
  // left the developer's hands — but must never inflate the aggregate
  // planned/available totals or the overload flag. This mirrors exactly what
  // the server does for CapacityResponse.total_*; this overlay recomputes
  // totals locally (for live typed-availability feedback) so it has to apply
  // the same `is_developer` filter, not just re-sum every line.
  const devLines = out.filter((l) => l.is_developer);
  const total_available_hours = round1(devLines.reduce((s, l) => s + l.available_hours, 0));
  const total_planned_hours = round1(devLines.reduce((s, l) => s + l.planned_hours, 0));

  return {
    lines: out,
    total_available_hours,
    total_planned_hours,
    overloaded:
      devLines.some((l) => l.overloaded) ||
      (total_available_hours > 0 && total_planned_hours > total_available_hours),
  };
}

/**
 * Increment 38 (`docs/CAPACITY_BAR_RULES.md` §5b) — the reading guide for a
 * developer's `Baseline / Planned / ±Change / Capacity` line, shown verbatim in
 * its hover tooltip. ONE source for the wording, so the panel and the rules
 * document cannot drift apart.
 */
export const CAPACITY_NUMBER_DEFINITIONS = {
  baseline:
    "What they were signed up for at the last Activate — the estimates frozen at that moment, kept even when a ticket is later handed on or removed.",
  planned: "What they hold right now: every ticket currently in the sprint and assigned to them.",
  change: "How their scope moved since activation: plus added and worked, minus removed.",
  capacity: "Their available hours for the sprint.",
} as const;

/** The four-number line's tooltip: one labelled line per number + its definition. */
export function capacityNumbersTitle(n: {
  baseline: string;
  planned: string;
  change: string;
  capacity: string;
}): string {
  const d = CAPACITY_NUMBER_DEFINITIONS;
  return [
    `Baseline: ${n.baseline} — ${d.baseline}`,
    `Planned: ${n.planned} — ${d.planned}`,
    `±Change: ${n.change} — ${d.change}`,
    `Capacity: ${n.capacity} — ${d.capacity}`,
  ].join("\n");
}
