# Increment 34 — Long-running (multi-sprint) tasks — FROZEN CONTRACTS (Phase 0)

> Supersedes `docs/INCREMENT_34_DRAFT.md` (decisions captured there 2026-08-19).
> `docs/CAPACITY_BAR_RULES.md` §5 (Delivered, Effectivity) + §6 invariants 11–12 were
> edited FIRST per its §7 mandate — they are the binding semantics; this doc is the
> implementation contract. Golden tests (`tests/src/multisprint-golden.test.ts`, written
> by the orchestrator, RED before the work) pin the target behaviour.

## §0 Pillars

1. **Uniform rules, no "long-running" flag.** Delivered = burned remaining for EVERY
   ticket; the single-sprint begun-and-finished case must reduce byte-for-byte to the old
   number (invariant 11). Kind/flag-based special-casing is forbidden (Increment 30's
   lesson).
2. **Local data only on read paths.** Cumulative dev-logged (3b) sums the calendar-window
   `time_logged` changelog rows of every sprint the ticket is a member of — all local,
   frozen sprints included. No OP calls, no live-cache dependence for frozen sprints
   (invariant 10 keeps holding).
3. **No backfill.** Already-closed/frozen sprints keep their stored `completed_hours`
   (velocity) and reports; the new rules apply to READS computed fresh (closure-stats)
   and to close/freeze artifacts written from now on.

## §1 Delivered = burned remaining (apps/api — Agent A)

Per ticket, per sprint: `delivered_ticket = max(0, remStart − remEnd)` where
- `remStart` = `ticket_baseline.remaining_hours ?? estimate-of-record` (the §3/§5a
  estimate the surfaces already resolve; retro sprints keep their reconstructed
  snapshot semantics untouched);
- `remEnd` = 0 for a ticket whose done-bucket is `done`; else the CURRENT remaining
  (live `work_package_cache.remaining_hours`, or `frozen_remaining_hours` once frozen —
  see §4), `?? remStart` when unknown (unknown progress ⇒ 0 burned, never negative).

Credit: done tickets keep the EXISTING winner cascade (max logged; tie-breaks
unchanged). A still-open ticket's positive burn is credited to the developer with max
`logged_by_developer` in THIS sprint's window; with no logger it goes to the ticket's
CURRENT holder (a re-estimate down with no logged work is still that holder's progress);
with neither (unassigned, unlogged) it is dropped from per-developer figures (and thus
from the header — invariant 8 keeps holding).

Implementation home: `developerSegments` (deliveredByDev) — the engine gains
`remaining_start_hours` / `remaining_end_hours` per `DeveloperSegmentsTicketInput`
(threaded by closureStats; contracts fields ALREADY LANDED as optional). Omitted values
(older callers/tests) behave as `remStart = estimate, remEnd = done ? 0 : remStart` —
which reproduces the old behaviour exactly, so untouched unit tests stay meaningful.

Velocity: `closure.ts`'s completed_hours adopts the same per-ticket rule at close time
(sum of burned remaining over the sprint's items). Existing closed sprints untouched
(§0.3).

**Integration amendments (post-agent, from the th-/tr-/td- e2e regressions):**
1. `remStart`'s baseline read is **gap-aware**: a reconstructed baseline whose
   `reconstruction_gaps_json` names `remaining_hours` carries the ticket's CURRENT
   remaining (reconstruction's fallback — typically 0 after the fact), not an at-start
   fact. The same holds for an `added_retroactively` baseline (SPEC_25) — captured
   live at add-click time, AFTER the work it retro-credits, so its remaining (an
   explicit 0 on a done ticket) is post-work state. Both count as **no remaining** →
   estimate-of-record fallback (a done retro-added ticket delivers its estimate,
   exactly as pre-34). One shared reader: `closure.ts` `baselineRemaining`, used by
   closureStats, closure and freeze (frozen_remaining_hours's baseline fallback).
2. `GET /sprints/:id/velocity`'s per-connection breakdown partitions with the same
   per-item burned-remaining rule over all non-removed items (was: Σ planned_hours of
   done items), so it keeps summing to the new completed_hours. Grace-window cache
   drift can skew the recomputation slightly until freeze pins remaining@end.

## §2 Effectivity / Overshoot over cumulative dev-logged (apps/api — Agent A)

For a DONE ticket, `delta_hours` / `overshoot_flag` / the aggregate
`estimate_accuracy_pct` / `overshoot_hours` replace the single-window
`dev_logged_hours` with **cumulative** dev-logged: Σ over ALL sprints whose
`sprint_item` rows contain the wp (any outcome except `removed`) of that sprint's
calendar-window dev-logged rows. closureStats receives a prebuilt
`cumulativeDevLoggedByWp` map (one query over `sprint_item` + the member sprints'
changelogs — batched, not N+1). Single-sprint tickets: cumulative == window (invariant
12's reduction). `TicketEstimateLine` gains `cumulative_dev_logged_hours` (landed in
contracts; stubbed = window value until Agent A fills it) — the UI and PDF show it for
multi-sprint tickets.

Per-developer `overshoot_hours`/`accuracy_pct` (deliveredLogged vs delivered) keep their
existing window semantics — they describe THIS sprint's execution; the CUMULATIVE view
is per-ticket (user decision 3b targets tickets, not people).

## §3 Multi-sprint badge (Agent A data, Agent C display)

`TicketEstimateLine.multi_sprint` and `SprintItemDetail.multi_sprint` (landed in
contracts, stubbed null): `{ sequence, total }` — this sprint's 1-based position among
ALL sprints containing the wp (ordered by `start_date`, then id; any outcome except
`removed`), null when total == 1. Derived from `sprint_item` rows only (local, frozen-
safe). UI: badge "sprint 2/3" on sprint-board cards and in the Closure/report per-ticket
tables + PDF.

## §4 Freeze snapshot amendment (Agent A)

New column `sprint_item.frozen_remaining_hours` (nullable) — migration **0005**,
IDEMPOTENT (`ADD COLUMN IF NOT EXISTS`), never regenerate existing migrations (the
watching-dev-server rule). `freeze.ts` snapshots the live remaining (`?? baseline
remaining`); reactivate clears it with the other frozen_* columns; `FrozenSprintItem-
Fields` + mappers + export tables extended. Read paths use it for §1's `remEnd` when
frozen. (Frozen sprints predating this column: `frozen_remaining_hours` null → `remEnd
= remStart` → 0 burned for open tickets, done tickets still deliver remStart — the
documented no-backfill posture.)

## §5 Carry-over button (Agent B route, Agent C UI)

`POST /sprints/:id/items/:wpOpId/carry` body `{ target_sprint_id }` →
`{ carried: true, target_sprint_id, wp_op_id }`:
- Source sprint: any status (typically closed/locked — carrying does NOT mutate it; its
  item keeps its outcome). Source item must exist and not be `removed`.
- Target sprint: `planning` or `active`, unlocked, unfrozen, ≠ source; target must not
  already contain the wp (409 ITEM_ALREADY_IN_SPRINT). Target in `planning` → a normal
  planning add (origin baseline-to-be); target `active` → the EXISTING mid-sprint-add
  path (origin added_mid_sprint, baseline captured now) — reuse those code paths, do not
  reimplement. `planned_hours` = current estimate of record (remaining-preferring §3 —
  a carried 150h task with 100h left enters the target at 100h).
- Errors reuse existing codes (SPRINT_NOT_FOUND / SPRINT_LOCKED / SPRINT_FROZEN /
  ITEM_ALREADY_IN_SPRINT); zod body in contracts (landed).
- UI (Agent C): "Carry over" button on a sprint-member card when the SOURCE sprint is
  closed/locked and the item is not done — opens a modal with a select of eligible
  target sprints (planning/active, unlocked, unfrozen), confirms, refreshes. British
  English. Also surfaced in Closure's "Not done" list as the same action.

## §6 Golden tests (orchestrator, Phase 1 — RED first)

`tests/src/multisprint-golden.test.ts`: a 150h-shaped ticket across two sprints
(bootRealApp, repo seeding): (a) sprint 1 delivers its burned slice while open→closed,
never 0-then-everything (invariant 11); (b) single-sprint reduction byte-equality;
(c) done-in-sprint-2 delta uses cumulative dev-logged (invariant 12); (d) multi_sprint
badge fields 1/2 and 2/2; (e) carry endpoint happy path + gates; (f) frozen sprint 1
keeps its delivered slice after cache deletion (invariant 10 composition).

## §7 Hard boundaries (every agent, verbatim)

- ⛔ Repo-root CLAUDE.md DATABASE_URL/PORT guardrail verbatim; PGlite for unit tests;
  throwaway `osp_test_*` + non-default ports for anything live; `osp`/`atlas-core`
  OFF-LIMITS. OpenProject strictly GET-only.
- ⛔ Migration rules per §4. CAPACITY_BAR_RULES colours (§1–§4) untouched.
- Ownership: A = apps/api logic (developerSegments/closureStats/closure/freeze) +
  packages/db (migration 0005 + repos) + report/PDF data; B = apps/api routes (carry) +
  its tests; C = apps/web (badges, carry UI, per-ticket cumulative display) — A and B
  BOTH touch apps/api: A owns `src/logic/**` + packages/db, B owns `src/routes/**`; the
  one shared seam is routes/index.ts registering nothing for A (closure route shape is
  unchanged) — B's carry route is additive. On conflict, stop and report.
