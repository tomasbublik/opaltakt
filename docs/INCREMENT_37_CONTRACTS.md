# Increment 37 — Velocity shows Closure's numbers (one set of numbers)

Frozen contracts. User report (2026-09-01, screenshots): sprint Atlas.Core 3.6.001 shows
Planned 353.7 h / Completed 120 h on Velocity but Planned 171 h / Delivered 206.5 h on
Closure. Verified live (read-only GETs against the user's own instance):

- Velocity `planned_hours` = `sprintLeafPlanned` — Σ effective estimates of ALL leaf items
  (incl. tester/customer-held tickets; 353.7 ≈ scope 359.7 minus double-count
  suppression). Closure's Planned (171) = DEVELOPERS' current scope (Increment 30).
- Velocity `completed_hours` = the close-time bake (`sprint.completed_hours` = 120,
  written before the sprint's later grace-window updates). Closure's Delivered (206.5) =
  live burned-remaining credited to developers.
- Visible drift bug on the user's own screenshot: sprint 3.5.041 breakdown 13.5 h vs
  total 12 h (baked total vs live-partitioned breakdown — the documented Inc-34 caveat).

Decision: Velocity displays THE SAME numbers as Closure. Binding rules edited FIRST:
CAPACITY_BAR_RULES §5 Delivered note (Inc-37 paragraph), §5a exception amendment,
§6 invariant 5 extension.

## §0 Pillars (verbatim in every agent prompt)

1. **OpenProject strictly READ-ONLY (GET only); this increment needs NO OP calls.**
   Never `GET /api/v3/users`.
2. **Reuse, don't recompute** (invariant 5): each velocity history row reads
   `computeClosureStats` — the exact function Closure/Reports/status-PDF read.
3. **No schema change, no migration.** `sprint.completed_hours` keeps being baked at
   close exactly as today — it just stops being DISPLAYED. `average_completed_hours` and
   recommended capacity derive from the new per-row values automatically.
4. **⛔ DB guardrail** (CLAUDE.md, unconditional): never boot `apps/api` without explicit
   `DATABASE_URL` (throwaway `osp_test_*` you created) AND explicit non-default `PORT`
   (never 3001/8099/5173). `osp` and `atlas-core` are OFF-LIMITS. Unit tests = PGlite
   in-process, no server.

## §1 Decisions of record

- **Contract field names stay** (`planned_hours`, `completed_hours`,
  `average_completed_hours`, `by_connection[].completed_hours`) — only their VALUES and
  the web labels change. No zod change.
- Per history row (closed sprints, as today):
  - `planned_hours` := `total_planned_hours` (Closure's Planned header).
  - `completed_hours` := `total_delivered_hours` (Closure's Delivered header).
  - `by_connection` partitions the per-ticket **CREDITED** delivered amounts (the exact
    per-ticket hours `developerSegments` credited into `deliveredByDev`; tickets whose
    burn was dropped — no developer to credit — are NOT in the partition, which is what
    makes it sum to `total_delivered_hours` EXACTLY, by construction). Connection of a
    ticket = frozen_connection_id (frozen sprint) ?? live cache connection_id ?? current
    connection (the existing fallback).
- **Engine internals, not contract surface**: `developerSegments` additionally returns a
  per-ticket credited-delivered map; `closureStats` exposes it via a new exported
  `computeClosureStatsWithInternals(repos, id, generatedAt)` returning
  `{ stats, deliveredByTicket: Map<wpOpId, hours> }` (plain `computeClosureStats` keeps
  its exact current signature/return — every existing caller untouched).
- **Perf**: one `computeClosureStats` per closed sprint per velocity read. Sprint counts
  are small (single-digit); acceptable. No caching in this increment.
- **Web labels**: the view relabels "Completed" → **"Delivered"** everywhere (legend,
  tooltip, stat "Avg delivered (N sprints)", section "Delivered hours by server") so the
  vocabulary matches Closure. Field names in the payload stay `completed_*`.
- The old `sprintLeafPlanned` helper stays for any other caller (check usages) but the
  velocity route stops using it.

## §2 Agent A — apps/api. OWNS `apps/api/src/**`.

1. `developerSegments.ts`: extend the return with the per-ticket credited map (e.g.
   `delivered_by_ticket: Map<number, number>` alongside the existing array — pick the
   least-invasive shape; every existing caller must keep compiling and passing UNEDITED).
2. `closureStats.ts`: `computeClosureStatsWithInternals` per §1 (the existing
   `computeClosureStats` delegates or wraps — zero behaviour change for it).
3. `routes/index.ts` velocity handler: per closed sprint call the internals variant;
   emit `planned_hours` / `completed_hours` / `by_connection` per §1. Delete the now-dead
   per-item burned-remaining partition block from Increment 34 (superseded).
4. Unit tests: velocity route test asserting row values ≡ that sprint's
   `computeClosureStats` totals; breakdown sums EXACTLY to completed; a dropped-credit
   ticket (unassigned+unlogged burn) is absent from the partition and the row still
   balances; frozen sprint stable after cache deletion.

## §3 Agent B — apps/web. OWNS `apps/web/src/**`.

1. Velocity screen: relabel per §1 (British English) — legend "Delivered", tooltip
   "Delivered : X h", header stat "Avg delivered (N sprints)", table heading
   "Delivered hours by server". NO payload/field changes.
2. Component tests updated for the labels; everything else stays green (edit ONLY tests
   that assert the old labels — list them in the report).

## §4 Golden tests (orchestrator, Phase 1 — RED first, `tests/src/velocity-golden.test.ts`)

Seeded on PGlite + in-process app: a closed sprint with (a) a dev-held done ticket,
(b) a TESTER-held done ticket (this is what makes old-planned ≠ closure-planned),
(c) logged dev work; `sprint.completed_hours` deliberately baked to a DIFFERENT value.
Assert, via HTTP from a viewer sprint's `/velocity`:
1. row.planned_hours === closure-stats.total_planned_hours (RED today: leaf-planned),
2. row.completed_hours === closure-stats.total_delivered_hours (RED today: the bake),
3. Σ by_connection === row.completed_hours exactly (RED today).

## §5 Verification & ownership

| Who | Owns | Must not touch |
|---|---|---|
| A | `apps/api/src/**` | web, packages, docs, tests/ workspace |
| B | `apps/web/src/**` | apps/api, packages, docs, tests/ workspace |

Both: package typecheck + package suite green (pre-existing tests unedited except §3's
label assertions). Orchestrator: golden 3/3, full suites, e2e (td §9 velocity e2e test
may legitimately need its expectations updated to the new semantics — orchestrator
reconciles, agents do NOT touch tests/), live-verify against a throwaway DB AND a
read-only comparison against the user's live instance numbers (171/206.5).
