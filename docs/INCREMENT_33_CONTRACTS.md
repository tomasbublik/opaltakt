# Increment 33 — Off-sprint time in Closure/Reports + person filter on the Sprint Board — FROZEN CONTRACTS (Phase 0)

> User decisions (2026-08-19): 1a share = off / (off + sprint) — "X % of all time went
> outside the sprint"; 1b comparison base = developer time in the sprint's CALENDAR
> window on both sides; 1c "expected admin/meeting tickets" flagging DEFERRED; 2a the
> person filter narrows ONLY the sprint items list (backlog candidates untouched); 2b
> capacity lines always stay complete. (Long-running tasks = the NEXT increment, not
> this one.)

## §0 Pillars

1. **Separation is sacred.** The off-sprint block rides on `ClosureStatsResponse` but is
   NEVER added into Planned / Baseline / ±Change / Delivered / Logged, the burndown, the
   velocity or any capacity number. An invariant test must fail if inserting
   `off_sprint_time_entry` rows moves ANY other figure on ANY surface.
2. **Stored rows only.** Closure/Reports/PDF read `off_sprint_time_entry` (already
   frozen with the sprint by Increment 31's gate) — no OP calls on any read path.
3. **One identity.** Actors fold via `buildPersonResolver`, roster semantics identical
   to Increment 32 (effective-developer rule).

## §1 Closure data (apps/api — Agent A)

`ClosureStatsResponse.off_sprint` — the zod shape is ALREADY LANDED in
`packages/contracts/src/api.ts` (Phase 0), and `computeClosureStats` currently returns a
STUB (zeros; marked "Increment 33 Phase-0 STUB"). Agent A replaces the stub:

- rows = `repos.offSprintTime.listBySprint(sprintId)`; fold actors via the resolver the
  function already builds; person `name`/`op_user_id` from the resolution (same
  conventions as `per_developer`).
- `total_hours` = Σ hours; per person `total_hours` + `tickets` (group rows by
  `wp_op_id`: `{ wp_op_id, subject (latest non-null), hours: Σ, connection_id }`,
  sorted hours desc).
- `sprint_logged_hours` = Σ `per_developer[].logged_hours` (computed in the same
  function — reuse the value, do not re-derive).
- `share_pct` = 100 × total / (total + sprint_logged_hours); null when both are 0.
  Per person: 100 × their off / (their off + their `per_developer.logged_hours`
  (0 when they have no row)); null when 0/0. No rounding server-side (UI formats).
- Ordering: per_person by total_hours desc, then name asc.

## §2 Reports + PDF (apps/api — Agent A)

The report detail (`GET /api/reports/:id` family) and the PDF already consume
`computeClosureStats` output — find the exact assembly sites (logic/report.ts + the PDF
builder) and surface the off-sprint block: a "Outside the sprint" section with the
share ("40 % of developer time went to tickets outside the sprint"), the per-person
totals and their ticket lists. British English. If the report/PDF layer has its own
response contract, extend it in @osp/contracts following its conventions (keep shapes
mirroring §1 — no re-aggregation in the web).

## §3 Invariant + tests (apps/api — Agent A)

- Invariant test (per §0.1): seed a sprint with sprint-logged rows AND off-sprint rows;
  capture burndown + capacity + closure per_developer/per_ticket/totals; assert they
  are IDENTICAL to the same sprint WITHOUT the off-sprint rows (only `off_sprint`
  differs). Add to the api unit suites (PGlite).
- Aggregation tests: share math (incl. null cases 0/0 and off-only person), actor
  folding, ticket grouping, ordering, frozen-sprint read (rows persist, closure still
  reports them after `frozen_at` is set).

## §4 Closure + Reports UI (apps/web — Agent B)

- **ClosureScreen.tsx**: an "Outside the sprint" section (collapsible, same interaction
  pattern as the CapacityPanel's Increment-32 section — but its own component; do NOT
  import from SprintBoardScreen): headline share ("40 % of developer time outside the
  sprint — Xh of Yh total"), per-person rows expandable to ticket lists. Renders
  nothing when `off_sprint.total_hours === 0`.
- **ReportsScreen.tsx** (report detail view): same section, read-only.
- Formatting: percentages via one shared helper, 0 decimals ≥10 %, 1 decimal below;
  hours via the existing formatHours.
- Component tests per existing conventions (mocked api, fixtures overrides).

FILE OWNERSHIP (hard): Agent B touches ONLY ClosureScreen.tsx, ReportsScreen.tsx, their
tests, and MAY add new fixture factories at the END of test/fixtures.ts (never edit
existing ones — `makeClosureStats` already carries an empty `off_sprint` default).

## §5 Person filter on the Sprint Board (apps/web — Agent C)

- A select ("Filter by assignee") above the SPRINT MEMBERS list in
  SprintBoardScreen.tsx — options derived client-side from the loaded
  `items/detailed` rows' assignees (distinct, name asc, "All people" default; include
  an "Unassigned" option when unassigned items exist). No API change, no server call.
- Filtering narrows ONLY the sprint-member ticket cards (2a): the backlog-candidate
  column, capacity lines, off-sprint section, totals and counts all stay complete (2b).
- Reset on sprint switch. Keep the select's a11y label ("Filter sprint tickets by
  assignee") for tests.
- Component tests: options derivation, narrowing, unassigned bucket, reset-on-switch,
  capacity untouched while filtered.

FILE OWNERSHIP (hard): Agent C touches ONLY SprintBoardScreen.tsx and
SprintBoardScreen.test.tsx. Agent B must not touch them. (Both agents run in parallel
in apps/web — the disjoint file sets are the contract.)

## §6 Hard boundaries (every agent, verbatim)

- ⛔ Repo-root CLAUDE.md DATABASE_URL/PORT guardrail verbatim: unit tests = PGlite; any
  live run = throwaway `osp_test_*` + non-default port; `osp` and `atlas-core` OFF-LIMITS.
- ⛔ OpenProject strictly GET-only. NO schema/migration changes in this increment.
- ⛔ CAPACITY_BAR_RULES colours untouched; nothing off-sprint enters any §5 roll-up.
- Contracts doc is frozen — on conflict, stop and report.
