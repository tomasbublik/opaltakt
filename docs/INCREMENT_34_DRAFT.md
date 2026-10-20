# Increment 34 — Long-running tasks (multi-sprint, 150h+) — DRAFT (Phase -1)

> Status: DRAFT — user decisions captured 2026-08-19; to be frozen into contracts AFTER
> Increment 33 lands. This touches the metric core (developerSegments / closureStats /
> velocity), so the run MUST start with golden tests written against these decisions
> (the identity-unification pattern).

## User decisions (verbatim intent)

- **3a — Delivered is PROPORTIONAL per sprint**: a sprint delivers the remaining-work it
  actually burned (`remaining at sprint start − remaining at sprint end`, clamped ≥ 0),
  instead of the full estimate landing all at once in the sprint where the ticket
  finally completes. Velocity becomes smooth and honest across sprints.
- **3b — Effectivity/Overshoot of a DONE ticket measure against the TOTAL time across
  all sprints** (cumulative spent), not the final sprint's window only. A 150h estimate
  with 160h真 spent across three sprints = 107 %, not "33 % effectivity".
- **3c — a "Carry over" (Přenést) button** with a target-sprint picker, so unfinished
  tickets move to the chosen next sprint explicitly (today it's a manual re-add).
- **3d — reports mark multi-sprint tickets** (e.g. a "sprint 2/3" badge), detectable
  from `sprint_item` rows of the same `wp_op_id` across sprints.

## What ALREADY works (verified 2026-08-19 — do not re-solve)

- Per-sprint Logged: the calendar window (FOLLOWUPS #8) already scopes each sprint's
  logged time to its own window.
- Per-sprint Planned: `effectiveEstimate` prefers Remaining (Increment 16), so a
  carried task enters the next sprint at its remaining size, not the full estimate.
- Burndown: remaining-based, declines smoothly across sprints.

## Known design hazards to resolve at contract time

1. Proportional Delivered changes the attribution model: today Delivered exists only
   for DONE tickets (max-logger credit). "Progress delivered" on still-open tickets
   needs an attribution rule (proposal: max logger IN THIS SPRINT'S WINDOW) and a
   remaining@start anchor (ticket_baseline carries remaining at activation ✓; the
   sprint-end value comes from the freeze/closure snapshot — note: the Increment-31
   freeze snapshot does NOT store remaining/spent today → likely needs a column
   amendment, idempotent migration rules apply).
2. Cumulative spent for 3b: OP `spentTime` lives in `work_package_cache.spent_hours`
   (live) — a frozen sprint's read must not consult the live cache (invariant 10), so
   the cumulative figure must be SNAPSHOTTED at freeze (another frozen_* column) or
   derived from summed windows.
3. Velocity (`closure.ts` completed_hours) is frozen-at-close per SPEC_05 — decide how
   proportional delivery feeds it without rewriting history for already-closed sprints
   (proposal: new behavior applies from the increment's landing forward; no backfill).
4. Carry-over button: must respect lifecycle gates (source sprint closed/locked is fine
   — carrying is a TARGET-sprint add), the estimate of record at carry time (remaining
   preference), and Import protection semantics.

## Orchestration sketch

Golden tests first (Phase 1, red), then: Agent A = engine/closure/velocity semantics;
Agent B = carry-over route + freeze-snapshot amendment; Agent C = web (badge, carry
button, reports). Orchestrator: contracts, integration, live-verify.
