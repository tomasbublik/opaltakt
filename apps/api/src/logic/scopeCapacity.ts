import type { CapacityLine } from "@osp/contracts";

/**
 * SPEC_05 — live scope changes on a running sprint + capacity segments.
 * PHASE 0 DESIGN NOTE: the math + data flow are frozen here; Agent B (Scope &
 * capacity engine) wires them into the existing capacity/item-add/item-remove
 * code. This file exports the PURE math as small, independently-testable
 * functions; where to call them from is specified below rather than
 * re-implemented as a parallel throwing-stub engine (unlike Increment 4's
 * sprintUpdate.ts, most of the surrounding machinery — routes, repos,
 * changelog persistence — already exists and just needs new BRANCHES for the
 * "sprint is active" case, not a new subsystem).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CAPACITY MATH (SPEC_05 §2) — computeCapacitySegments() below
 * ─────────────────────────────────────────────────────────────────────────
 * Per team member, per sprint:
 *   baseline_hours   = Σ effective-hours of the member's items with origin
 *                       "baseline" that are STILL committed (outcome NOT
 *                       "removed"/"removed_mid_sprint")... NO — re-read SPEC_05
 *                       §2 carefully: baseline_hours is the RAW frozen amount
 *                       "at activation", it does NOT shrink when a baseline
 *                       item is later removed. removed_hours is a SEPARATE
 *                       subtraction applied on top for display. Concretely:
 *   baseline_hours   = Σ planned_hours (the ADD-TIME snapshot, per SprintItem)
 *                       of items with origin="baseline" for this member,
 *                       counting EVERY such item regardless of current
 *                       outcome (planned/done/carried/removed_mid_sprint) —
 *                       this is what "frozen at activation" means.
 *   added_hours      = Σ planned_hours of items with origin="added_mid_sprint"
 *                       for this member, EXCLUDING outcome="removed_mid_sprint"
 *                       (a mid-sprint ticket that was added AND THEN removed
 *                       contributes to neither red nor blue — net zero, it
 *                       was never really "committed" long enough to matter;
 *                       simplest correct behavior, avoids double bookkeeping).
 *   removed_hours    = Σ planned_hours of items with origin="baseline" AND
 *                       outcome="removed_mid_sprint" for this member (SPEC_05
 *                       §2: "Σ odhad BASELINE-ticketů člena odebraných po
 *                       aktivaci" — explicitly baseline-only).
 *   available_hours  = the member's SprintMemberCapacity.available_hours,
 *                       UNCHANGED by scope changes (SPEC_05 §1: "dostupná
 *                       kapacita se nemění").
 *   current_committed = baseline_hours + added_hours - removed_hours
 *                       (this IS what `planned_hours` on CapacityLine means —
 *                       kept as the back-compat field name).
 * Bar segments the FRONTEND derives (do not compute server-side, just ship
 * the three raw numbers): green = baseline_hours - removed_hours, red =
 * added_hours, blue = removed_hours.
 * A member "has_sprint_work" when baseline_hours + added_hours > 0 (i.e. they
 * own at least one item that ever counted, even if fully offset by removal —
 * matches the EXISTING has_sprint_work spirit: re-derived from items, not
 * user-removable while true).
 *
 * PRE-ACTIVATION SPRINTS (planning): added_hours = removed_hours = 0 for
 * every line (mid-sprint add/remove don't exist yet, so no item is ever
 * origin="added_mid_sprint" or outcome="removed_mid_sprint" during planning).
 * RECONCILED (post-integration, superseding an earlier draft of this note
 * that said baseline_hours should be a literal 0 pre-activation): don't
 * special-case activation state at all — derive segments PURELY from each
 * item's origin/outcome, unconditionally, in every sprint status. A planning
 * item is always origin="baseline", so baseline_hours naturally equals the
 * live planned sum ("everything currently planned IS the baseline-to-be").
 * A forced literal 0 would render an EMPTY capacity bar during planning
 * despite real planned work — a visual regression from before Increment 5 —
 * so `baseline_hours == planned_hours` pre-activation is the CORRECT,
 * intended result, not a bug. `planned_hours`/`available_hours`/`overloaded`
 * behave EXACTLY as before Increment 5 either way — this is a pure additive
 * change; the existing capacity tests for a planning-phase sprint keep
 * passing unmodified.
 *
 * `overloaded` stays `available_hours > 0 && current_committed > available_hours`
 * (SPEC_05 §1: available never grows, so overload becomes visible exactly
 * when scope creep pushes committed past the frozen ceiling — no new logic
 * needed beyond swapping the live `planned_hours` sum for `current_committed`,
 * which are numerically the same thing this increment introduces).
 *
 * IMPLEMENTATION: apps/api/src/logic/capacity.ts's `computeCapacity()` is the
 * natural home — it already has per-item {wp_op_id, assignee_op_id,
 * planned_hours} and a leaf-effort double-counting pass. Extend its item
 * input with `origin: SprintItemOrigin` and `outcome: SprintItemOutcome`
 * (both already on SprintItem — routes/index.ts's buildCapacityResponse
 * already fetches the items, just needs to pass these two fields through
 * instead of dropping them), and accumulate baseline/added/removed per the
 * formulas above ALONGSIDE the existing planned_hours accumulation. The
 * double-counting leaf-effort filter (drop a parent when a child is also in
 * the sprint) applies identically to the segment sums — reuse the SAME
 * `leafIds` set for all four accumulators.
 *
 * routes/index.ts's buildCapacityResponse ALSO needs one new line: `sprint`
 * (already fetched at the top of that function) has `baseline_total_hours` —
 * thread it straight into `CapacityResponse.baseline_total_hours`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MID-SPRINT ADD (SPEC_05 §4) — POST /sprints/:id/items when sprint.status
 * === "active" (&& !is_locked, already 409s via the existing SPRINT_LOCKED
 * check — no change needed there)
 * ─────────────────────────────────────────────────────────────────────────
 * routes/index.ts's existing POST /sprints/:id/items handler (~line 840):
 * currently ALWAYS reads the WP from the LOCAL cache
 * (`repos.workPackages.getByOpId`) and inserts with `outcome:"planned"`, no
 * `origin`. Branch on `sprint.status === "active"`:
 *
 *   PLANNING (existing behavior, unchanged): origin="baseline" (it's part of
 *   the initial planning set — "baseline" here just means "not added while
 *   running", matching entities.ts's doc), read from local cache as today.
 *
 *   ACTIVE (new): the ticket may not be in the local cache at all yet (SPEC_05
 *   §4: "dočti baseline WP z OP"), so:
 *     1. requireOpClient() (needs the vault unlocked + a connection — same as
 *        every other OP-facing route; if that fails, surface its normal error,
 *        NOT a silent local-cache-only fallback).
 *     2. Fetch the raw OpWorkPackage via Agent A's new
 *        `fetchWorkPackageById(op, wp_op_id)` (packages/op-client) — 404s
 *        (returns null) → WORK_PACKAGE_NOT_FOUND, exactly like today's
 *        cache-miss path.
 *     3. op.getStatuses() (small, cheap — for status_is_closed lookup) and
 *        upsert `work_package_cache` via `toWorkPackageCacheRow(wp, statusById,
 *        null)` (spentFallbackHours: pass null here — a brand-new addition has
 *        no aggregated time entries fetched yet; the NEXT `POST .../update`
 *        run will fill it in correctly, same as any other ticket).
 *     4. Build a `NewTicketBaseline` row straight from the raw `OpWorkPackage`
 *        (mirrors EXACTLY how sprintUpdate.ts's activate() already builds
 *        baselines — same field-by-field mapping incl. `accountable_op_id`
 *        via `parseOpId(wp._links.accountable?.href)`), `captured_at = now`,
 *        `origin: "added_mid_sprint"` → `repos.ticketBaselines.upsertMany([row])`.
 *     5. Insert the `sprint_item` with `origin: "added_mid_sprint"`,
 *        `outcome: "planned"`, `planned_hours` = effective hours (existing
 *        override-aware calculation, unchanged).
 *     6. Changelog: `repos.ticketChangelog.insertMany([{ sprint_id, wp_op_id,
 *        update_run_id: <see below>, occurred_at: now, actor_op_id: null,
 *        actor_name: "Planner", kind: "scope_added", detail_json:
 *        JSON.stringify({kind:"scope_added", hours: planned_hours}),
 *        source: "local", op_journal_id: null, dedup_key:
 *        `local:add:${sprintId}:${wp_op_id}:${now}` }])`. NEEDS an
 *        `update_run_id` (NOT NULL FK) — there is no real update run for a
 *        local action, so create a MINIMAL one:
 *        `repos.sprintUpdateRuns.start(sprintId, "update", "manual")` then
 *        immediately `.finish(id, "success", 1, 1, null, now)` around the
 *        scope-change insert, OR (simpler, prefer this) just call the EXISTING
 *        `sprintLifecycle.update(sprintId, "manual")` right after inserting
 *        the item — it will naturally produce a real update run AND pick up
 *        the fresh OP state again on its own scoped pass. Pick whichever
 *        keeps routes/index.ts simplest; either is correct. Actor for a LOCAL
 *        change has no OP journal (SPEC_05 §3/§9.4) — use `actor_op_id: null,
 *        actor_name: "Planner"` (a fixed label, not a real user — this app is
 *        single-user, so there's no session identity to attribute to).
 *     7. Un-dismiss from the backlog if previously dismissed (mirrors the
 *        existing "Add ticket by id" route's `backlogDismissals.remove`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MID-SPRINT REMOVE (SPEC_05 §4) — DELETE /sprints/:id/items/:wpId when
 * sprint.status === "active"
 * ─────────────────────────────────────────────────────────────────────────
 * routes/index.ts's existing DELETE handler (~line 878) already does
 * `setOutcome(item.id, "removed", nowIso())` unconditionally. Branch:
 *   PLANNING: unchanged, outcome="removed" (row untouched by this increment's
 *   segment math since planning-phase lines don't compute segments at all).
 *   ACTIVE: outcome="removed_mid_sprint" instead of "removed" — SAME
 *   `removed_at` stamp, row is NEVER deleted (already true). Then:
 *     - No OP call at all (SPEC_05 §8: "odebrání nevolá OP vůbec" — purely
 *       local, don't call requireOpClient()).
 *     - Changelog: same shape as scope_added but kind="scope_removed",
 *       detail={kind:"scope_removed", hours: item.planned_hours, logged_hours:
 *       <Σ this ticket's time entries — you likely don't have this on hand
 *       cheaply without an OP call; SPEC_05 §9 doesn't require the exact
 *       figure to be OP-fresh at removal time, only that ALREADY-LOGGED work
 *       stays counted in burndown/velocity (that's packages/sync's
 *       computeSnapshot, already handled in Phase 0) — it is acceptable to
 *       set `logged_hours: null` here if a cheap local number isn't
 *       available, OR read it from the CACHED work_package_cache.spent_hours
 *       for this wp if present (best-effort, not authoritative)>,
 *       source="local", actor_name="Planner", dedup_key:
 *       `local:remove:${sprintId}:${wpId}:${now}`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ACTIVATION CHANGES (extends Increment 4's sprintUpdate.ts activate(), which
 * ALREADY has two compile errors right now from this increment's contract
 * changes — fix them as part of this work, not separately):
 * ─────────────────────────────────────────────────────────────────────────
 *   - Its `NewTicketBaseline` construction needs `origin: "baseline"` added
 *     (every ticket present at activation is, by definition, the baseline).
 *   - `repos.sprints.activate(sprintId, activatedAt, baselineTotalHours)` now
 *     takes a 3rd argument (packages/db, already updated in Phase 0) — compute
 *     `baselineTotalHours` as the leaf-effort sum (SPEC §6 double-counting,
 *     reuse `leafEffort` from ./doubleCounting.ts exactly like
 *     sprintLeafPlanned/buildCapacityResponse already do) of the SAME items
 *     being baselined, using their effective hours (estimate override-aware,
 *     same helper `effectiveEstimate` already used elsewhere in this file).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * BURNDOWN IDEAL-LINE ANCHOR (SPEC_05 §4 — packages/sync's computeSnapshot
 * already anchors on `sprint.baseline_total_hours` as of Phase 0; this is the
 * REMAINING piece: the LIVE GET /sprints/:id/burndown route)
 * ─────────────────────────────────────────────────────────────────────────
 * routes/index.ts's `GET /sprints/:id/burndown` handler calls
 * `sprintLeafPlanned(id)` (a LIVE recompute from current committed items) and
 * passes it to `buildBurndown(sprint, totalPlanned, snapshots)` as the
 * `total_planned_hours` the ideal curve is built from. Change this ONE call
 * site: `const totalPlanned = sprint.baseline_total_hours ?? (await
 * sprintLeafPlanned(id));` — baseline-anchored once activated, live fallback
 * before (identical fallback logic to packages/sync's computeSnapshot in
 * Phase 0 — keep them conceptually in sync). `total_planned_hours` in the
 * BurndownResponse itself then reflects the frozen baseline post-activation,
 * which is the whole point (SPEC_05 §4: scope creep visible as remaining/
 * logged diverging from a FIXED ideal line, not a moving one).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMMUTABILITY — already correct, no new work: both item routes already 409
 * on `sprint.status === "closed"` and `sprint.is_locked` BEFORE reaching any
 * of the branches above (existing SPRINT_CLOSED/SPRINT_LOCKED checks at the
 * top of both handlers). Just confirm your new "active" branches sit AFTER
 * those checks, not before.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INCREMENT 9 (SPEC_09 §3/§4) — GREY REDISTRIBUTION SEGMENTS
 * computeCapacitySegments() below now also returns redistributed_out_hours /
 * redistributed_in_hours per assignee — see accumulateCapacitySegments' new
 * `is_done` / `original_assignee_op_id` inputs and the CapacityLine doc in
 * @osp/contracts for the exact field semantics.
 *
 * WIRING (apps/api/src/logic/capacity.ts + routes/index.ts's
 * buildCapacityResponse — the ONLY two call sites that need to change):
 *   1. buildCapacityResponse already fetches `wps` (work_package_cache rows)
 *      for the sprint's items. It ALSO needs, for items with
 *      `origin === "baseline"`: (a) the sprint's `doneStatusRule`s (already
 *      fetched elsewhere via repos.doneStatusRules.listBySprint — reuse
 *      `isDone()` from ./done.ts, do NOT reinvent done-classification), and
 *      (b) `repos.ticketBaselines.listBySprint(id)` (already fetched for
 *      SprintItemDetail — reuse the same call, don't fetch it twice) to read
 *      `original_assignee_op_id` per wp_op_id.
 *   2. Extend CapacityItemInput (capacity.ts) with `original_assignee_op_id:
 *      number | null` and `is_done: boolean`, both optional (default
 *      is_done=false, original_assignee_op_id=null) so every pre-Increment-9
 *      caller/test is unaffected — mirrors how origin/outcome were added in
 *      Increment 5.
 *   3. computeCapacity() passes these straight through to
 *      accumulateCapacitySegments (same countableItems/leafIds filtering
 *      already in place — grey math applies to the SAME leaf-filtered set,
 *      no separate pass) and copies the two new segment fields onto each
 *      CapacityLine, exactly like baseline_hours/added_hours/removed_hours
 *      already are.
 *   4. currentCommittedHours(seg) now includes + redistributed_in_hours (see
 *      below) — this is what makes a pure receiver's `planned_hours` (and
 *      therefore `overloaded`) reflect the work they actually received,
 *      instead of showing 0 forever.
 *   5. has_sprint_work in capacity.ts must also OR in
 *      `seg.redistributed_in_hours > 0` — a pure receiver (SPEC_09 §4's
 *      Daniel, who owned nothing at activation) must still show as "has
 *      sprint work" once they've received redistributed hours, same
 *      reasoning as the existing baseline_hours + added_hours check.
 *   6. A CLOSED sprint's items have real `outcome` values ("done"/"carried",
 *      set once at closure — see closure.ts) instead of live status, so
 *      `is_done` there should read `outcome === "done"` rather than
 *      re-deriving from work_package_cache (which may be stale/gone post-
 *      closure). An ACTIVE sprint's items are always outcome "planned" until
 *      closure (setOutcome to "done"/"carried" only happens in
 *      closure.ts:115), so `is_done` there MUST come from isDone(wp, rules)
 *      — outcome alone would never show any grey while a sprint is running,
 *      which defeats the whole feature.
 */

/** One member's segment inputs for one sprint (leaf-level, post double-counting). */
export interface CapacitySegmentItemInput {
  wp_op_id: number;
  parent_op_id: number | null;
  assignee_op_id: number | null;
  assignee_name: string | null;
  /** The item's planned_hours snapshot (NOT live effective — SPEC_05 §2: baseline is frozen). */
  planned_hours: number | null;
  origin: "baseline" | "added_mid_sprint" | "added_retroactively";
  outcome: "planned" | "done" | "carried" | "removed" | "removed_mid_sprint";
  /**
   * Increment 9 (SPEC_09 §3): this item's ORIGINAL owner (ticket_baseline's
   * frozen `original_assignee_op_id`), only meaningful for origin="baseline"
   * items. `undefined` (field omitted — every pre-Increment-9 caller) opts
   * OUT of grey tracking entirely for this item (collapses to the old
   * green-only behavior); pass `null` explicitly to mean "baseline row
   * exists but had no assignee at capture" (participates, as the
   * "unassigned" bucket) — these are NOT the same value, do not `?? null`
   * this away when wiring capacity.ts.
   */
  original_assignee_op_id?: number | null;
  /**
   * Increment 9 (SPEC_09 §3): true when the item currently counts as done —
   * see scopeCapacity.ts's WIRING note above for the outcome="done" vs
   * live isDone(wp, rules) distinction (closed sprint vs. active sprint).
   * Optional/defaults to false so every pre-Increment-9 caller is unaffected.
   */
  is_done?: boolean;
  /**
   * Increment 13 (SPEC_13 §1/§3): an explicit bucket key that OVERRIDES the
   * default `assignee_op_id ?? "unassigned"` grouping. Used only by the
   * retrospective capacity roster to give a distinct-but-UNRESOLVED journal
   * name (e.g. "Jan Belka", `assignee_op_id === null`) its OWN bucket instead
   * of collapsing it into the genuinely-unassigned bucket. Every pre-Increment-13
   * caller omits it (undefined) → grouping is byte-for-byte unchanged.
   */
  bucket_key?: number | string;
  /**
   * Identity unification (golden tests `identity-golden*.test.ts`): the
   * ORIGINAL owner's canonical bucket key, resolved by the caller through the
   * SAME person resolver as `bucket_key`. Only meaningful alongside a non-null
   * `original_assignee_op_id`; omitted → the raw
   * `original_assignee_op_id ?? "unassigned"` fallback (every pre-existing
   * caller/test, where current and original keys share one id namespace).
   */
  original_bucket_key?: number | string;
}

export interface CapacitySegments {
  baseline_hours: number;
  added_hours: number;
  removed_hours: number;
  /**
   * Increment 9 (SPEC_09 §3) — grey redistribution, see the CapacityLine doc
   * in @osp/contracts for the exact "sent"/"received" semantics.
   */
  redistributed_out_hours: number;
  redistributed_in_hours: number;
}

/**
 * Pure per-member segment accumulation (SPEC_05 §2 formulas above). Callers
 * (capacity.ts) still own leaf-effort double-counting exclusion (filter items
 * to leaves BEFORE calling this) and the existing planned/available/
 * overloaded/has_sprint_work computation — this only adds the three new sums,
 * grouped by the SAME assignee key (op_user_id, or unassigned) already used
 * there.
 */
export function accumulateCapacitySegments(
  items: readonly CapacitySegmentItemInput[],
): Map<number | string, CapacitySegments> {
  const byAssignee = new Map<number | string, CapacitySegments>();
  const bump = (key: number | string, field: keyof CapacitySegments, hours: number) => {
    const seg =
      byAssignee.get(key) ??
      ({
        baseline_hours: 0,
        added_hours: 0,
        removed_hours: 0,
        redistributed_out_hours: 0,
        redistributed_in_hours: 0,
      } satisfies CapacitySegments);
    seg[field] += hours;
    byAssignee.set(key, seg);
  };
  for (const it of items) {
    // SPEC_13 §3: an explicit bucket_key (retro unresolved-name line) overrides
    // the default assignee-id grouping; every other caller omits it.
    const currentKey = it.bucket_key ?? it.assignee_op_id ?? "unassigned";
    const hours = it.planned_hours ?? 0;
    if (it.origin === "baseline") {
      // SPEC_09 §3: once reassignment exists, baseline_hours (the FROZEN
      // "at activation" scope) must be attributed to the ORIGINAL owner, not
      // whoever currently holds the ticket — otherwise a fully-reassigned
      // item would vanish from the original owner's bar instead of showing
      // as grey there. `original_assignee_op_id !== undefined` gates this
      // (see the field doc): omitted entirely (every pre-Increment-9 caller,
      // where current==original always) falls back to currentKey, so this
      // is a no-op for every existing caller.
      const greyTracked = it.original_assignee_op_id !== undefined;
      const baselineKey = greyTracked
        ? (it.original_bucket_key ?? it.original_assignee_op_id ?? "unassigned")
        : currentKey;
      // Frozen: counts regardless of current outcome (even if later removed).
      bump(baselineKey, "baseline_hours", hours);
      if (it.outcome === "removed_mid_sprint") {
        bump(baselineKey, "removed_hours", hours);
      } else if (it.outcome !== "removed" && greyTracked) {
        // Grey redistribution — ONLY for baseline items still in scope
        // (removed/removed_mid_sprint are fully accounted by removed_hours
        // above, never also grey).
        const reassigned = baselineKey !== currentKey;
        if (it.is_done === true || reassigned) {
          // Vacated: no longer "live green" at the original owner — either
          // finished, or handed to someone else. Bar-length-neutral (the
          // frontend derives green = baseline - removed - redistributed_out,
          // so the owner's bar stays exactly baseline_hours long).
          bump(baselineKey, "redistributed_out_hours", hours);
        }
        if (reassigned) {
          // Received: additive at the CURRENT assignee, may exceed their own
          // baseline/available hours (SPEC_09 §4) — intentional.
          bump(currentKey, "redistributed_in_hours", hours);
        }
      }
    } else if (
      (it.origin === "added_mid_sprint" || it.origin === "added_retroactively") &&
      it.outcome !== "removed_mid_sprint"
    ) {
      // Added-then-removed nets to zero — never counted here (see doc above).
      // added_mid_sprint/added_retroactively (Increment 25, SPEC_25 §5 "±Change,
      // not Planned") have no "original owner" concept (SPEC_09 §3: grey is
      // baseline-only) — always current assignee.
      bump(currentKey, "added_hours", hours);
    }
  }
  return byAssignee;
}

/**
 * Helper for CapacityLine assembly: current_committed = baseline + added -
 * removed + redistributed_in (SPEC_09 §3/§4: a pure receiver's committed
 * total must reflect work reassigned to them, not just baseline_hours which
 * only counts items they originally owned).
 *
 * ⚠️ Increment 30 — this is NO LONGER the source of `CapacityLine.planned_hours`.
 * It double-counts a handoff (the sender keeps `baseline_hours`, because nothing
 * here subtracts `redistributed_out_hours`, while the receiver also gains
 * `redistributed_in_hours`), which breaks `CAPACITY_BAR_RULES.md` §6 invariants
 * 7–8. `Planned` now comes from `plannedScope.ts`, the one canonical rule. This
 * composition is retained because it still describes the SEGMENT fields the bar
 * is drawn from, and its own tests pin that arithmetic.
 */
export function currentCommittedHours(seg: CapacitySegments): number {
  return seg.baseline_hours + seg.added_hours - seg.removed_hours + seg.redistributed_in_hours;
}

/** Never called directly — documents the CapacityLine field mapping for reference. */
export function _segmentsToCapacityLineFields(
  seg: CapacitySegments,
): Pick<
  CapacityLine,
  | "baseline_hours"
  | "added_hours"
  | "removed_hours"
  | "redistributed_out_hours"
  | "redistributed_in_hours"
> {
  return {
    baseline_hours: seg.baseline_hours,
    added_hours: seg.added_hours,
    removed_hours: seg.removed_hours,
    redistributed_out_hours: seg.redistributed_out_hours,
    redistributed_in_hours: seg.redistributed_in_hours,
  };
}
