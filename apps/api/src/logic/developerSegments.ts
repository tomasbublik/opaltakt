import {
  DEV_DONE_TRANSITION_STATUSES,
  DEV_IN_PROGRESS_TRANSITION_STATUSES,
  SEGMENT_CHANGE_SIGN,
  SEGMENT_LOGGED_MARKER_KINDS,
  personKey,
} from "@osp/contracts";
import { computePlannedScope } from "./plannedScope";
import type {
  AssigneeInterval,
  DeveloperCapacityBreakdown,
  DeveloperSegmentKind,
  DeveloperSegmentsInput,
  DeveloperSegmentsTicketInput,
  DeveloperTicketSegment,
  PersonRole,
} from "@osp/contracts";

/**
 * Increment 15/17/26 (SPEC_17 §1, "v2" of SPEC_15 §2; Increment 26 baseline
 * merge) — the PURE developer-capacity-bar engine.
 *
 * Turns already-synced LOCAL data (baseline anchor, per-ticket assignee
 * timelines, status transitions, developer-logged hours, roles) into the
 * per-developer capacity breakdown: the six-row segment classification per
 * (developer × ticket) (baseline_worked / handoff / removed for the baseline
 * dev; acquired / idle / churned for a non-baseline dev), the two STRUCTURALLY
 * SEPARATE bar numbers, and the DELIVERED attribution.
 *
 * Increment 26 (CAPACITY_BAR_RULES.md §6 #1) — the former grey-hatched
 * `baseline_idle` row is ABOLISHED and merged into `baseline_worked`: a baseline
 * ticket the developer STILL holds renders GREEN regardless of whether any time
 * was logged. There is no "held but not yet logged" hatched state any more. Only
 * a baseline ticket that LEFT this dev's hands is distinct (→ handoff to another
 * developer, or → removed to a non-developer / unassigned).
 *
 * v2 (SPEC_17 §1) fixes two real v1 bugs:
 *   • BUG 1 — a developer who ACQUIRED a ticket via a dev→dev HANDOFF mid-sprint
 *     (not just a fresh sprint-add) and then logged time on it now gets a RED
 *     `acquired` segment. In this engine that has ALWAYS worked as long as the
 *     receiver appears in `developersWhoHeld()` (it iterates EVERY interval, so a
 *     MIDDLE-of-chain holder is included) AND their logged hours resolve under
 *     the SAME personKey as their interval holder. The add-path-only symptom is
 *     an UPSTREAM data-assembly issue (op-client interval folding must yield an
 *     interval for the mid-chain receiver, AND closureStats.ts must key that
 *     receiver's logged hours identically to their interval holder) — see the
 *     regression test's #11762-shaped case, which proves the classification is
 *     correct given well-formed input.
 *   • BUG 2 — a developer's PLANNED could go negative (e.g. "Jan Bílý −8h")
 *     because v1's single signed `planned_delta_hours` let removal/redistribution
 *     segments SUBTRACT from the same number the additive segments fed. v2 splits
 *     the bar's two leading numbers into two channels that never cross:
 *       Planned (bar #1) = Σ estimate over baseline_worked ONLY
 *         — a pure non-negative sum, nothing ever subtracts from it.
 *       Change  (bar #2, signed) = Σ estimate(acquired) − Σ estimate(removed)
 *         — the ONLY two kinds that move it; handoff/idle/churned contribute 0.
 *
 * NO DB access and NO OP call live here — the CALLER (closureStats.ts) assembles
 * `DeveloperSegmentsInput` from repos. Role-gated: only people whose
 * role === "developer" produce output rows (a tester/customer/other never gets a
 * developer segment — their committed hours stay on the plain grey CapacityLine).
 */

// ── personKey: the identity key the whole engine (and its caller) share ──────
// Identity unification (HANDOFF, golden tests `identity-golden*.test.ts`): the
// ONE raw key builder now lives in `@osp/contracts` (`personKey`), and the
// production path resolves keys through `createPersonResolver` — threaded in
// via `DeveloperSegmentsInput.resolve_key` — so id/name/connection variants of
// one person fold BEFORE keying (the old local definition here fragmented one
// person into `id:1:64` / `id:-:64` / `nm:Jan Belka` and is deleted). The
// engine falls back to the raw shape only when no resolver is supplied (pure
// unit tests). Cross-connection collisions stay split either way (Concept 4:
// Alan Turing id 3 on the mock ≠ Cameron Dalby id 3 on Acme).
export type PersonKey = string;

/** The engine's per-run key resolution (canonical resolver, or the raw fallback). */
type KeyOf = (
  connectionId: number | null,
  opUserId: number | null,
  name: string | null,
) => PersonKey | null;

const norm = (s: string): string => s.trim().toLowerCase();

/** Human tooltip provenance per segment kind (SPEC_17 §1). British English
 * (Increment 16, SPEC_16 §4) — this string is surfaced verbatim in the
 * capacity-bar tooltip (apps/web, `seg.reason`), so it's UI copy, not internal
 * debug text. Null when the kind + colour alone are self-explanatory. */
function reasonFor(
  kind: DeveloperSegmentKind,
  currentHolderRole: PersonRole | null,
): string | null {
  switch (kind) {
    case "baseline_worked":
      // (a) green — a baseline ticket this dev still holds OR logged on. Always
      // green (Increment 26 merged the former baseline_idle row into here — a
      // held-but-unlogged baseline ticket is no longer a separate hatched state).
      // Note whether it left for a tester/customer (developed + handed on).
      return currentHolderRole === "tester" || currentHolderRole === "customer"
        ? "developed and handed off to a tester/customer"
        : null;
    case "handoff":
      return "reassigned to another developer"; // (b) blue-hatched
    case "removed":
      return "dropped from the sprint without work"; // (c) blue (solid)
    case "acquired":
      return "picked up and worked"; // (e) red
    case "idle":
      return "picked up, not yet worked"; // (f) orange-hatched
    case "churned":
      return "briefly held, then passed on without work"; // (g) blue (solid)
    default:
      return null;
  }
}

/** ms-since-epoch; NaN for an unparseable / empty value. */
function ms(iso: string | null): number {
  return iso == null ? Number.NaN : Date.parse(iso);
}

/**
 * The interval covering `instant` (from <= instant < to, or to === null → open).
 * Intervals are oldest-first & non-overlapping; returns the first match, or null
 * when `instant` precedes the first interval (e.g. before the ticket existed).
 */
function intervalAt(
  intervals: AssigneeInterval[],
  instantMs: number,
): AssigneeInterval | null {
  if (Number.isNaN(instantMs)) return null;
  for (const iv of intervals) {
    const f = ms(iv.from);
    const t = iv.to === null ? Number.POSITIVE_INFINITY : ms(iv.to);
    if (f <= instantMs && instantMs < t) return iv;
  }
  return null;
}

/** The CURRENT holder: the open (to === null) interval, else the latest by `from`. */
function currentInterval(intervals: AssigneeInterval[]): AssigneeInterval | null {
  const open = intervals.find((iv) => iv.to === null);
  if (open) return open;
  let best: AssigneeInterval | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const iv of intervals) {
    const f = ms(iv.from);
    if (f >= bestMs) {
      bestMs = f;
      best = iv;
    }
  }
  return best;
}

interface EngineContext {
  roleOf: (key: PersonKey) => PersonRole;
  doneSet: Set<string>;
  inProgressSet: Set<string>;
  /** Canonical person-key resolution (input.resolve_key, or raw personKey). */
  keyOf: KeyOf;
}

/** personKey of an interval's holder, or null for an unassigned interval.
 * `connectionId` scopes the id-based key (see personKey) — every interval of a
 * given ticket shares that ticket's connection, so the caller threads it in. */
function holderKey(
  ctx: EngineContext,
  connectionId: number | null,
  iv: AssigneeInterval | null,
): PersonKey | null {
  if (!iv || iv.holder_name == null) return null;
  return ctx.keyOf(connectionId, iv.holder_op_user_id, iv.holder_name);
}

/** Distinct developer keys that ever held this ticket (any interval) — includes
 * MIDDLE-of-chain holders, not just baseline/current (the BUG 1 receiver). */
function developersWhoHeld(
  ticket: DeveloperSegmentsTicketInput,
  ctx: EngineContext,
): Set<PersonKey> {
  const out = new Set<PersonKey>();
  const conn = ticket.connection_id ?? null;
  for (const iv of ticket.assignee_intervals) {
    const k = holderKey(ctx, conn, iv);
    if (k && ctx.roleOf(k) === "developer") out.add(k);
  }
  return out;
}

/** The developer who held the ticket at the baseline anchor (rows a–d), or null. */
function baselineDevKey(
  ticket: DeveloperSegmentsTicketInput,
  anchorMs: number,
  ctx: EngineContext,
): PersonKey | null {
  if (!ticket.in_baseline_scope) return null;
  const k = holderKey(
    ctx,
    ticket.connection_id ?? null,
    intervalAt(ticket.assignee_intervals, anchorMs),
  );
  return k && ctx.roleOf(k) === "developer" ? k : null;
}

/**
 * DELIVERED tie-break 4a — the developer who HELD the ticket at the earliest
 * status transition FROM an in-progress-like status INTO a dev-done status
 * (SPEC_15 §3). Returns that developer's key (regardless of candidate set — the
 * caller checks membership), or null when there's no such transition / no
 * covering interval / the holder isn't a developer.
 */
function transitionHolderKey(
  ticket: DeveloperSegmentsTicketInput,
  ctx: EngineContext,
): PersonKey | null {
  const sorted = [...ticket.status_transitions].sort((a, b) => ms(a.at) - ms(b.at));
  for (const tr of sorted) {
    const from = tr.from != null ? norm(tr.from) : null;
    const to = norm(tr.to);
    if (from !== null && ctx.inProgressSet.has(from) && ctx.doneSet.has(to)) {
      const iv = intervalAt(ticket.assignee_intervals, ms(tr.at));
      const k = holderKey(ctx, ticket.connection_id ?? null, iv);
      return k && ctx.roleOf(k) === "developer" ? k : null;
    }
  }
  return null;
}

/**
 * The DELIVERED cascade over a candidate set (SPEC_15 §3 steps 4a–4e):
 *   4a transition holder → 4b baseline assignee → 4c earliest logger →
 *   4d deterministic (op_user_id asc nulls last, then name asc) → 4e null.
 * Restricted to `candidates` at every step (the tied set, or all held devs).
 * UNCHANGED from v1 — credits a done ticket to whoever logged the most
 * REGARDLESS of how many hands it passed through or whether that person is the
 * baseline/current holder (SPEC_17 §1 "Delivered" column: hotové připsané).
 */
function pickWinner(
  ticket: DeveloperSegmentsTicketInput,
  candidates: Set<PersonKey>,
  anchorMs: number,
  ctx: EngineContext,
  personName: (key: PersonKey) => string,
  personOpUserId: (key: PersonKey) => number | null,
): PersonKey | null {
  if (candidates.size === 0) return null;
  if (candidates.size === 1) return [...candidates][0]!;

  // 4a — transition holder.
  const th = transitionHolderKey(ticket, ctx);
  if (th && candidates.has(th)) return th;

  // 4b — baseline assignee.
  const bh = baselineDevKey(ticket, anchorMs, ctx);
  if (bh && candidates.has(bh)) return bh;

  // 4c — earliest logger (only candidates with a known first-logged spentOn).
  const firstLogged = ticket.first_logged_at_by_developer ?? {};
  const withFirst = [...candidates].filter((k) => firstLogged[k] != null);
  if (withFirst.length > 0) {
    withFirst.sort((a, b) => {
      const d = ms(firstLogged[a]!) - ms(firstLogged[b]!);
      if (d !== 0) return d;
      return deterministicCmp(a, b, personName, personOpUserId);
    });
    return withFirst[0]!;
  }

  // 4d — deterministic.
  return [...candidates].sort((a, b) =>
    deterministicCmp(a, b, personName, personOpUserId),
  )[0]!;
}

/** op_user_id ascending (nulls last), then name ascending. */
function deterministicCmp(
  a: PersonKey,
  b: PersonKey,
  personName: (key: PersonKey) => string,
  personOpUserId: (key: PersonKey) => number | null,
): number {
  const ia = personOpUserId(a);
  const ib = personOpUserId(b);
  if (ia !== ib) {
    if (ia == null) return 1;
    if (ib == null) return -1;
    return ia - ib;
  }
  return personName(a).localeCompare(personName(b));
}

/** The kind's canonical render order (baseline row first, then acquired, then
 * informative) — SPEC_17 §1 table order, with the former baseline_idle row
 * merged into baseline_worked (Increment 26). */
const KIND_ORDER: Record<DeveloperSegmentKind, number> = {
  baseline_worked: 0,
  handoff: 2,
  removed: 3,
  acquired: 4,
  idle: 5,
  churned: 6,
};

/**
 * Increment 30 §2c — the CANONICAL current-scope facts, computed once by
 * `plannedScope.ts` from the caller's data and handed to the engine so there is
 * ONE holder resolution behind every Planned number and every segment
 * annotation.
 *
 * The caller supplies this because only the caller has (a) the parent/child
 * edges the double-count guard needs — `DeveloperSegmentsTicketInput` carries no
 * `parent_op_id` — and (b) the authoritative CURRENT holder, which is the live
 * `work_package_cache` assignee, the same source `computeCapacity` reads. The
 * engine's own `assignee_intervals` are a RECONSTRUCTION from changelog rows and
 * can lag or be incomplete; where the two disagree the live row wins, because
 * that is what the Capacity panel shows (invariant 5).
 */
export interface CanonicalPlannedScope {
  /** Canonical Planned per person — `plannedScope.by_holder`. */
  planned_by_person: ReadonlyMap<PersonKey, number>;
  /** Each ticket's authoritative CURRENT holder (`null` = unassigned). */
  holder_by_ticket: ReadonlyMap<number, PersonKey | null>;
}

/**
 * Increment 37 (`docs/INCREMENT_37_CONTRACTS.md` §2.1) — the per-ticket
 * CREDITED delivered amount, alongside the existing per-developer array. A
 * ticket whose burn was dropped (no developer to credit — e.g. unassigned and
 * unlogged) is simply ABSENT from the map, never present with a 0: that
 * absence is exactly what lets a caller partition `deliveredByDev`'s total by
 * ticket and land on the same figure by construction (Velocity's
 * `by_connection` breakdown).
 */
export interface DeveloperSegmentsResult {
  breakdown: DeveloperCapacityBreakdown[];
  delivered_by_ticket: ReadonlyMap<number, number>;
}

/**
 * The plain, pre-Increment-37 entry point — UNCHANGED signature and return
 * shape, so every existing caller/test keeps compiling and passing as-is.
 * Delegates to `developerSegmentsWithInternals` so there is exactly ONE
 * implementation of the engine.
 */
export function developerSegments(
  input: DeveloperSegmentsInput,
  canonical?: CanonicalPlannedScope,
): DeveloperCapacityBreakdown[] {
  return developerSegmentsWithInternals(input, canonical).breakdown;
}

export function developerSegmentsWithInternals(
  input: DeveloperSegmentsInput,
  /**
   * When omitted — a direct unit-test call — both maps are derived here from the
   * ticket inputs' current interval holder, through the very same helper. There
   * is exactly ONE implementation of the rule either way; this parameter only
   * decides how good the information feeding it is.
   */
  canonical?: CanonicalPlannedScope,
): DeveloperSegmentsResult {
  const roleOf = (key: PersonKey): PersonRole => input.role_by_person[key] ?? "unset";
  const personName = (key: PersonKey): string =>
    input.person_meta[key]?.name ?? key.replace(/^(id:|nm:)/, "") ?? key;
  const personOpUserId = (key: PersonKey): number | null =>
    input.person_meta[key]?.op_user_id ?? null;

  const doneSet = new Set(
    (input.dev_done_statuses ?? DEV_DONE_TRANSITION_STATUSES).map((s) => norm(s)),
  );
  const inProgressSet = new Set(DEV_IN_PROGRESS_TRANSITION_STATUSES.map((s) => norm(s)));
  // Identity unification — the caller's canonical resolver, or the raw
  // `personKey` fallback (pure unit tests; exactly as good as its inputs).
  const keyOf: KeyOf =
    input.resolve_key ??
    ((connectionId, opUserId, name) =>
      opUserId == null && name == null ? null : personKey(connectionId, opUserId, name));
  const ctx: EngineContext = { roleOf, doneSet, inProgressSet, keyOf };

  // Increment 30 §2c — the canonical current-scope facts. Either handed in by
  // closureStats (live cache holder + leaf-suppression edges) or derived here
  // from the intervals, through the very same helper.
  const canonicalScope: CanonicalPlannedScope =
    canonical ??
    (() => {
      const holder_by_ticket = new Map<number, PersonKey | null>();
      for (const t of input.tickets) {
        holder_by_ticket.set(
          t.wp_op_id,
          holderKey(ctx, t.connection_id ?? null, currentInterval(t.assignee_intervals)),
        );
      }
      const { by_holder } = computePlannedScope(
        input.tickets.map((t) => ({
          wp_op_id: t.wp_op_id,
          parent_op_id: null,
          holder_key: holder_by_ticket.get(t.wp_op_id) ?? null,
          estimate_hours: t.estimate_hours,
        })),
      );
      return { planned_by_person: by_holder, holder_by_ticket };
    })();
  const plannedScope = canonicalScope.planned_by_person;
  /**
   * §2c — the ONE current-holder test, shared by every segment annotation. A
   * segment is current scope iff the developer it belongs to is the ticket's
   * authoritative current holder. Every ticket reaching this engine is in scope
   * by construction (the caller filters `removed` / `removed_mid_sprint` out).
   */
  const isCurrentScopeFor = (wpOpId: number, devKey: PersonKey): boolean =>
    canonicalScope.holder_by_ticket.get(wpOpId) === devKey;

  const anchorMs = ms(input.baseline_anchor);
  // Increment 24 (SPEC_24 §2/§3) — state-aware collapse: planning has no
  // baseline/handoff/acquired/idle/churned distinction, only "who's it
  // currently planned to". Omitted/active/closed run the unchanged v2 model.
  const isPlanning = input.sprint_status === "planning";

  // Per-developer accumulators.
  const segmentsByDev = new Map<PersonKey, DeveloperTicketSegment[]>();
  const loggedByDev = new Map<PersonKey, number>();
  const deliveredByDev = new Map<PersonKey, number>();
  const deliveredLoggedByDev = new Map<PersonKey, number>();
  // Increment 37 — the per-ticket CREDITED delivered amount (the exact hours
  // this ticket contributed into `deliveredByDev`), keyed by wp_op_id. Every
  // ticket is visited at most once by the DELIVERED block below, so a plain
  // `.set` (not accumulate) is correct — kept as `+=` regardless for
  // resilience against any future multi-visit refactor.
  const deliveredByTicket = new Map<number, number>();
  // Increment 38 — Baseline = what each developer was signed up for at the
  // activation anchor (activation-time estimate), whatever happened to those
  // tickets since; and the −Change of baseline tickets taken out of the sprint.
  const baselineCommitByDev = new Map<PersonKey, number>();
  const removedFromSprintByDev = new Map<PersonKey, number>();
  const seen = new Set<PersonKey>();

  const seeDev = (key: PersonKey): void => {
    if (roleOf(key) === "developer") seen.add(key);
  };
  const pushSegment = (key: PersonKey, seg: DeveloperTicketSegment): void => {
    seeDev(key);
    const arr = segmentsByDev.get(key) ?? [];
    arr.push(seg);
    segmentsByDev.set(key, arr);
  };

  for (const ticket of input.tickets) {
    // Accumulate every developer's total logged hours (by-logger, dev-only input).
    for (const [key, hours] of Object.entries(ticket.logged_by_developer)) {
      if (hours === 0) continue;
      if (roleOf(key) !== "developer") continue;
      loggedByDev.set(key, (loggedByDev.get(key) ?? 0) + hours);
      seeDev(key);
    }

    const cur = currentInterval(ticket.assignee_intervals);
    const curKey = holderKey(ctx, ticket.connection_id ?? null, cur);
    const curRole: PersonRole | null =
      cur == null || cur.holder_name == null ? null : roleOf(curKey!);
    const curName = cur?.holder_name ?? null;
    const estimate = ticket.estimate_hours;

    const baseKey = baselineDevKey(ticket, anchorMs, ctx);
    const held = developersWhoHeld(ticket, ctx);

    if (isPlanning) {
      // SPEC_24 §2/§3 — no baseline/handoff/acquired/idle/churned distinction
      // exists before activation: the ticket's CURRENT developer holder gets one
      // full-green, fully-Planned segment; a non-developer (or unassigned)
      // holder gets nothing here at all.
      if (curKey != null && curRole === "developer") {
        const devLogged = ticket.logged_by_developer[curKey] ?? 0;
        pushSegment(
          curKey,
          // Increment 30 §2c — one shared holder test, even here where the
          // interval chain already says this dev holds it: the LIVE row is the
          // authority, so a planning sprint answers exactly like an active one.
          makeSegment(
            ticket,
            "baseline_worked",
            estimate,
            devLogged,
            true,
            curName,
            curRole,
            isCurrentScopeFor(ticket.wp_op_id, curKey),
          ),
        );
      }
    } else {
      // ── Baseline developer (three-way split) ──────────────────────────────
      // Increment 26 (CAPACITY_BAR_RULES.md §6 #1) collapses the old four-way
      // a/b/c/d split to three: a baseline ticket the dev still holds — logged or
      // not — is ALWAYS green (baseline_worked). Only a ticket that LEFT this
      // dev's hands is distinct:
      //   • handoff — went to ANOTHER developer (blue-hatched).
      //   • removed — went to a non-developer / unassigned with no log (blue).
      if (baseKey) {
        const devLogged = ticket.logged_by_developer[baseKey] ?? 0;
        const stillTheirs = curKey === baseKey;
        const handedToOtherDev =
          curKey != null && curKey !== baseKey && roleOf(curKey) === "developer";

        let kind: DeveloperSegmentKind;
        if (handedToOtherDev) {
          // (b) handoff — FINAL holder is ANOTHER DEVELOPER. Takes precedence even
          // if this dev logged (SPEC_17 §1 "regardless of whether THIS dev ever
          // logged"): Planned 0, Change 0; credit goes to whoever finishes it via
          // DELIVERED's own max-logged attribution, never the sender's Change.
          kind = "handoff";
        } else if (devLogged > 0 || stillTheirs) {
          // (a) baseline_worked — ALWAYS green. Either this dev logged on their
          // baseline ticket, OR they STILL hold it (baseline retained, worked or
          // not — the merged Increment-26 rule: a held-but-unlogged baseline
          // ticket is green, never hatched). Planned +estimate.
          kind = "baseline_worked";
        } else {
          // (c) removed — baseline dev, no log, ticket LEFT this dev's hands to
          // someone who is NOT another developer (unassigned OR a tester/customer/
          // other holder) → "vyřazen ze sprintu / opuštěn bez práce". Planned 0,
          // Change −estimate (BUG 2 fix: the subtraction lives in Change, never in
          // Planned).
          kind = "removed";
        }

        const commit = ticket.baseline_commit_hours ?? estimate ?? 0;
        baselineCommitByDev.set(baseKey, (baselineCommitByDev.get(baseKey) ?? 0) + commit);

        // Increment 30 §2c — current scope iff the BASELINE dev is still the
        // ticket's holder, tested against the LIVE row rather than the kind. A
        // green `baseline_worked` that has since moved to a TESTER (the Zbynek
        // Trnka defect: bar said 30, number said 0) is false here, and so are
        // handoff / removed — no kind could express this, since `handoff` means
        // "reassigned to another DEVELOPER".
        const seg = makeSegment(
          ticket,
          kind,
          estimate,
          devLogged,
          true,
          curName,
          curRole,
          isCurrentScopeFor(ticket.wp_op_id, baseKey),
        );
        // Increment 38 — a `removed` baseline ticket subtracts what was signed
        // up for (the same activation-time figure Baseline counts), so
        // Baseline + ±Change balances for it.
        if (kind === "removed") seg.change_delta_hours = -commit;
        pushSegment(baseKey, seg);
      }

      // ── Non-baseline developers who acquired/held the ticket (rows e–g) ────
      for (const devKey of held) {
        if (devKey === baseKey) continue; // baseline dev already handled above
        const devLogged = ticket.logged_by_developer[devKey] ?? 0;

        let kind: DeveloperSegmentKind;
        let segEstimate = estimate;
        if (devLogged > 0) {
          // (e) acquired — NOT baseline for this dev AND this dev logged. RED.
          // Change +estimate. Applies REGARDLESS of HOW the ticket reached them —
          // a fresh mid-sprint add AND a dev→dev handoff/reassignment BOTH qualify
          // (BUG 1 fix). Bar length = estimate at the moment of acquisition.
          kind = "acquired";
          segEstimate = estimateAtAcquisition(ctx, ticket, devKey, estimate);
        } else if (curKey === devKey) {
          kind = "idle"; // (f) — holds it, never logged. Informative (Planned 0, Change 0).
        } else {
          kind = "churned"; // (g) — held, logged nothing, moved on. Informative.
        }

        // Increment 30 §2c — current scope iff THIS dev still holds it. An
        // `acquired` segment on a middle-of-chain developer who has since passed
        // the ticket on is false, which is what dissolves the multi-hop double
        // count (§2b(iii)).
        pushSegment(
          devKey,
          makeSegment(
            ticket,
            kind,
            segEstimate,
            devLogged,
            false,
            curName,
            curRole,
            isCurrentScopeFor(ticket.wp_op_id, devKey),
          ),
        );
      }
    }

    // ── DELIVERED attribution — Increment 34 (INCREMENT_34_CONTRACTS.md §1;
    //    CAPACITY_BAR_RULES §5): delivered_ticket = burned remaining,
    //    uniformly for every ticket, done or still open. Credit:
    //      • done   → the EXISTING SPEC_15 §3 winner cascade (max logged;
    //                 tie-breaks unchanged) — only the CREDITED AMOUNT changes
    //                 (burned remaining instead of the acquisition estimate).
    //      • open   → the developer with max logged_by_developer in THIS
    //                 sprint's window; no logger → the CURRENT holder; neither
    //                 → dropped (admit, don't infer — same posture as 4e).
    //    `hasRemainingInputs` gates the NEW rule: when the caller supplies NO
    //    remaining_start/end_hours at all (every pre-Increment-34 unit test),
    //    this reproduces the OLD behaviour LITERALLY — including open tickets
    //    never delivering anything, and the old per-winner "estimate at
    //    acquisition" credited amount for a done ticket, which a flat
    //    ticket-level remStart cannot reconstruct (see the "(e) acquired ...
    //    estimate_at_acquisition" unit test, kept green unedited by this gate).
    if (ticket.done_bucket === "done") {
      const devLoggedEntries = Object.entries(ticket.logged_by_developer).filter(
        ([key, hours]) => hours > 0 && roleOf(key) === "developer",
      );
      let maxLogged = 0;
      for (const [, hours] of devLoggedEntries) maxLogged = Math.max(maxLogged, hours);

      let winner: PersonKey | null = null;
      if (maxLogged > 0) {
        const tied = devLoggedEntries
          .filter(([, hours]) => hours === maxLogged)
          .map(([key]) => key);
        winner =
          tied.length === 1
            ? tied[0]!
            : pickWinner(ticket, new Set(tied), anchorMs, ctx, personName, personOpUserId);
      } else {
        // maxLogged === 0 → cascade over ALL developers who ever held the ticket.
        winner = pickWinner(ticket, held, anchorMs, ctx, personName, personOpUserId);
      }

      if (winner) {
        const E = hasRemainingInputs(ticket)
          ? burnedRemaining(ticket)
          : // OLD literal algorithm (invariant 11 byte-for-byte reduction): the
            // acquisition estimate when the winner isn't the baseline dev, else
            // the ticket's estimate-of-record — matching the winner's own
            // segment length (SPEC_17 §1 "délka baru = odhad").
            winner === baseKey
            ? (estimate ?? 0)
            : (estimateAtAcquisition(ctx, ticket, winner, estimate) ?? 0);
        deliveredByDev.set(winner, (deliveredByDev.get(winner) ?? 0) + E);
        deliveredByTicket.set(ticket.wp_op_id, (deliveredByTicket.get(ticket.wp_op_id) ?? 0) + E);
        const own = ticket.logged_by_developer[winner] ?? 0;
        deliveredLoggedByDev.set(winner, (deliveredLoggedByDev.get(winner) ?? 0) + own);
        seeDev(winner);
      }
      // else 4e — uncredited to any developer ("admit, don't infer") — the
      // ticket stays absent from `deliveredByTicket` too.
    } else if (hasRemainingInputs(ticket)) {
      const burned = burnedRemaining(ticket);
      if (burned > 0) {
        const devLoggedEntries = Object.entries(ticket.logged_by_developer).filter(
          ([key, hours]) => hours > 0 && roleOf(key) === "developer",
        );
        let maxLogged = 0;
        for (const [, hours] of devLoggedEntries) maxLogged = Math.max(maxLogged, hours);

        let winner: PersonKey | null;
        if (maxLogged > 0) {
          const tied = devLoggedEntries
            .filter(([, hours]) => hours === maxLogged)
            .map(([key]) => key);
          winner =
            tied.length === 1
              ? tied[0]!
              : pickWinner(ticket, new Set(tied), anchorMs, ctx, personName, personOpUserId);
        } else {
          // No logger this window → the ticket's CURRENT holder (a
          // re-estimate down with no logged work is still that holder's
          // progress); neither → dropped.
          winner = curKey != null && roleOf(curKey) === "developer" ? curKey : null;
        }

        if (winner) {
          deliveredByDev.set(winner, (deliveredByDev.get(winner) ?? 0) + burned);
          deliveredByTicket.set(
            ticket.wp_op_id,
            (deliveredByTicket.get(ticket.wp_op_id) ?? 0) + burned,
          );
          const own = ticket.logged_by_developer[winner] ?? 0;
          deliveredLoggedByDev.set(winner, (deliveredLoggedByDev.get(winner) ?? 0) + own);
          seeDev(winner);
        }
        // else — no developer to credit (dropped): absent from
        // `deliveredByTicket`, matching the done-branch's "admit, don't infer".
      }
    }
  }

  // ── Increment 30 §2c roster safety net ────────────────────────────────────
  // Every developer the CANONICAL rule credits with Planned must be a visible
  // row, or invariant 8 ("the header equals the sum of the rows beneath it")
  // fails silently and invariant 5 breaks against the Capacity panel, which
  // derives its roster from the same live assignees.
  //
  // Normally redundant: a current holder always produces a segment, so they are
  // already `seen`. It fires only when the two sources disagree — the live cache
  // says a developer holds a ticket while the reconstructed changelog yields no
  // interval for them. Previously such a developer's hours would have been
  // counted by `/capacity` and silently missing from `/closure-stats`.
  // `CAPACITY_BAR_RULES.md` §5a: a developer must never disappear from the panel.
  for (const [key, hours] of plannedScope) {
    if (!Number.isFinite(hours)) continue;
    seeDev(key);
  }

  // Increment 38 — baseline tickets taken out of the sprint after activation:
  // part of what their activation holder signed up for (Baseline), and gone
  // from the sprint (−Change). No segment — nothing of theirs is left to paint.
  if (!isPlanning) {
    for (const r of input.removed_baseline ?? []) {
      const key = ctx.keyOf(r.connection_id ?? null, r.holder_op_user_id, r.holder_name);
      if (key == null || roleOf(key) !== "developer") continue;
      const commit = r.commit_hours ?? 0;
      baselineCommitByDev.set(key, (baselineCommitByDev.get(key) ?? 0) + commit);
      removedFromSprintByDev.set(key, (removedFromSprintByDev.get(key) ?? 0) + commit);
      seeDev(key);
    }
  }

  // ── Assemble one DeveloperCapacityBreakdown per seen developer ────────────
  const breakdown = [...seen]
    .map((key) => {
      const meta = input.person_meta[key];
      const segments = (segmentsByDev.get(key) ?? []).sort(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
      );
      // ── The bar's STRUCTURALLY SEPARATE leading numbers ───────────────────
      //   planned_hours — Increment 30: the CANONICAL current-scope Planned
      //     (`plannedScope.ts`), NOT a segment sum. Σ planned_delta_hours is a
      //     close approximation but is not authoritative: an `acquired` segment
      //     is measured at the estimate AT ACQUISITION, and a multi-hop ticket
      //     leaves an `acquired` segment on a developer who no longer holds it.
      //     `CAPACITY_BAR_RULES.md` §5/§6.7 — one computation, four surfaces.
      //     ALWAYS >= 0 (the Increment-17 BUG 2 fix still holds structurally:
      //     nothing subtracts from Planned).
      //   baseline_hours — Increment 30 introduced it as Σ estimate over
      //     `baseline_worked` segments; ±Change is measured against it
      //     (`CAPACITY_BAR_RULES.md` §5).
      //   scope_change_hours (signed) = Σ change_delta_hours — only acquired (+)
      //     / removed (−) populate this; handoff/idle/churned are 0. UNCHANGED.
      const planned = plannedScope.get(key) ?? 0;
      //     Increment 38 — once activated, Baseline is what the developer was
      //     SIGNED UP FOR at the anchor (activation-time estimates, incl. tickets
      //     since handed off / removed); in planning it stays Σ green.
      const baseline_hours = isPlanning
        ? segments.reduce(
            (s, seg) => (seg.kind === "baseline_worked" ? s + (seg.estimate_hours ?? 0) : s),
            0,
          )
        : (baselineCommitByDev.get(key) ?? 0);
      const scope_change_hours =
        segments.reduce((s, seg) => s + seg.change_delta_hours, 0) -
        (removedFromSprintByDev.get(key) ?? 0);
      const logged = loggedByDev.get(key) ?? 0;
      const delivered = deliveredByDev.get(key) ?? 0;
      const deliveredLogged = deliveredLoggedByDev.get(key) ?? 0;
      const accuracy_pct = delivered > 0 ? (deliveredLogged / delivered) * 100 : null;
      const overshoot_hours = deliveredLogged - delivered;
      return {
        member_id: meta?.member_id ?? null,
        op_user_id: meta?.op_user_id ?? null,
        name: meta?.name ?? personName(key),
        planned_hours: planned,
        baseline_hours,
        logged_hours: logged,
        // Deprecated alias — SAME corrected value as delivered_hours (SPEC_15 §rollout).
        delivered_estimate_hours: delivered,
        delivered_hours: delivered,
        accuracy_pct,
        overshoot_hours,
        segments,
        scope_change_hours,
      } satisfies DeveloperCapacityBreakdown;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { breakdown, delivered_by_ticket: deliveredByTicket };
}

/**
 * Increment 34 (docs/INCREMENT_34_CONTRACTS.md §1; CAPACITY_BAR_RULES §5
 * "Delivered") — `max(0, remStart − remEnd)`, both defaulting per the field's
 * own contract doc comment when the caller omits them: `remStart = estimate,
 * remEnd = done ? 0 : remStart`. `remEnd` is FORCED to 0 for a done ticket
 * regardless of what (if anything) the caller passed for it — "done" always
 * means "nothing left to burn" by definition, never a caller's stale number.
 */
function burnedRemaining(ticket: DeveloperSegmentsTicketInput): number {
  const estHours = ticket.estimate_hours ?? 0;
  const remStart = ticket.remaining_start_hours ?? estHours;
  const isDone = ticket.done_bucket === "done";
  const remEnd = isDone ? 0 : (ticket.remaining_end_hours ?? remStart);
  return Math.max(0, remStart - remEnd);
}

/**
 * True iff the caller supplied ANY Increment-34 remaining-hours input. Gates
 * between the NEW burned-remaining Delivered rule and the OLD literal
 * algorithm (never an approximating formula) — see the DELIVERED block below
 * for why "omitted" must replay the old CODE, not just a formula that usually
 * matches it: the old per-winner credited amount could depend on WHICH
 * developer won (`estimateAtAcquisition`), which no ticket-level `remStart`
 * can reconstruct. Every real caller (closureStats.ts) always supplies both
 * fields (possibly explicit nulls-resolved-to-numbers); only pre-Increment-34
 * unit tests omit them entirely.
 */
function hasRemainingInputs(ticket: DeveloperSegmentsTicketInput): boolean {
  return ticket.remaining_start_hours !== undefined || ticket.remaining_end_hours !== undefined;
}

/** Estimate at the developer's FIRST acquisition instant (row e), fallback current. */
function estimateAtAcquisition(
  ctx: EngineContext,
  ticket: DeveloperSegmentsTicketInput,
  devKey: PersonKey,
  fallback: number | null,
): number | null {
  const map = ticket.estimate_at_acquisition;
  if (!map) return fallback;
  // Earliest interval this developer acquired the ticket.
  let bestFrom: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const iv of ticket.assignee_intervals) {
    if (holderKey(ctx, ticket.connection_id ?? null, iv) !== devKey) continue;
    const f = ms(iv.from);
    if (f < bestMs) {
      bestMs = f;
      bestFrom = iv.from;
    }
  }
  if (bestFrom != null && bestFrom in map) {
    const v = map[bestFrom];
    return v ?? fallback;
  }
  return fallback;
}

function makeSegment(
  ticket: DeveloperSegmentsTicketInput,
  kind: DeveloperSegmentKind,
  estimate: number | null,
  loggedHours: number,
  inBaseline: boolean,
  currentHolderName: string | null,
  currentHolderRole: PersonRole | null,
  /**
   * Increment 30 §2c — is this ticket CURRENT SCOPE for the developer this
   * segment belongs to, i.e. is that developer its holder right now? This, not
   * the KIND, decides `counts_to_planned` / `planned_delta_hours`.
   *
   * §2a's kind table was an approximation and it failed exactly where this
   * increment is measured: segment kinds encode "who held it at the baseline
   * anchor, and did they log on it", while Planned asks "who holds it now", and
   * no kind-based sum can reproduce that. Concretely, `handoff` is defined as
   * "reassigned to another DEVELOPER", so a baseline ticket passed to a TESTER
   * stays `baseline_worked` and no kind ever removes it from the sender's scope
   * — the bar annotated 30 h while the canonical number said 0 h, for the same
   * person, on the same screen.
   *
   * Every ticket reaching this engine is in scope by construction (its caller
   * filters `removed` / `removed_mid_sprint` out), so holder identity is the
   * whole test. Being the current holder implies kind ∈ {baseline_worked,
   * acquired, idle}, so this is a strict refinement of the old table, never a
   * widening.
   */
  isCurrentScope: boolean,
): DeveloperTicketSegment {
  // Increment 30 follow-up (product-owner variant A, `CAPACITY_BAR_RULES.md` §5):
  // a POSITIVE change (`acquired`) is credited ONLY to the developer who
  // currently holds the ticket. Before this, every acquirer in a chain got
  // +estimate and nothing ever cancelled it (Increment 17 deliberately gives the
  // handoff SENDER 0, not −estimate), so a 12 h ticket passing A→B→C reported
  // +24 h of extra scope — growing with every hop. Invisible with two people,
  // wrong with three.
  //
  // The NEGATIVE direction is untouched: `removed` still subtracts, because that
  // ticket left the sprint entirely rather than moving to someone else — and a
  // removed ticket is never `isCurrentScope`, so it must not be gated on it.
  const tableSign = SEGMENT_CHANGE_SIGN[kind]; // -1 | 0 | 1 — now an UPPER BOUND on the + side
  const changeSign = tableSign > 0 && !isCurrentScope ? 0 : tableSign;
  const est = estimate ?? 0;
  return {
    wp_op_id: ticket.wp_op_id,
    subject: ticket.subject,
    kind,
    estimate_hours: estimate,
    logged_hours: loggedHours,
    counts_to_planned: isCurrentScope,
    planned_delta_hours: isCurrentScope ? est : 0, // always >= 0 (SPEC_17 §1 BUG 2 fix)
    counts_to_change: changeSign !== 0,
    change_delta_hours: changeSign * est, // signed: + acquired, − removed, else 0
    show_logged_marker: SEGMENT_LOGGED_MARKER_KINDS.has(kind),
    in_baseline: inBaseline,
    reason: reasonFor(kind, currentHolderRole),
    current_holder_name: currentHolderName,
    current_holder_role: currentHolderRole,
  };
}
