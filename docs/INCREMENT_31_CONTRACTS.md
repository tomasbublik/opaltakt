# Increment 31 — Sprint freeze after a grace period + Import cleanup — FROZEN CONTRACTS (Phase 0)

> Product ask (user, 2026-08-18): the Import page grows with sprint-protected tickets
> forever. Only sprints in **Planning/Active** should protect their tickets. Once a sprint
> is **finished**, people get a few days (default **3**, configurable in a new Settings UI)
> to log late time; after that the sprint and its tickets' state become **locally
> immutable** — no further updates from OP — and its tickets stop being protected on the
> Import page.
>
> User decisions (asked & answered): grace anchors at the FINISH action (`locked_at`), not
> `end_date`; during grace FULL updates run (time + statuses); the retroactive-add flow
> stays functional (it already goes through reactivate, which now also clears the freeze).
>
> Orchestration: Phase 0 (this doc, by the orchestrator) → agents A (backend), B (web),
> C (tests) on disjoint directories → Phase 2 integration + live-verify by the orchestrator.

## §0 Design pillar — freeze is a SNAPSHOT, never a sync carve-out

Increment 29's hard-won lesson (osp-increment29): sync coverage is **empirical** — every
cached row older than the run gets re-fetched, no enumerated exceptions. This increment
does **NOT touch the sync engine or its scope selection at all.** Instead:

1. At freeze time the sprint's numbers are **snapshotted** onto its own rows.
2. After freeze, every read surface for that sprint prefers the snapshot — the live
   `work_package_cache` row becomes irrelevant to it.
3. Therefore the cache row may keep refreshing while it exists (harmless), and may be
   **deleted** via the Import cleanup (also harmless — provably nothing changes).

"Locally immutable" is achieved by where reads look, not by suppressing writes.

## §1 Data model (packages/db — Agent A)

New migration (follow the existing generated-migration conventions):

- `sprint.frozen_at` — nullable isoTimestamp. Set exactly once by the freeze sweep;
  cleared by reactivate.
- `sprint_item` snapshot columns, all nullable, written only at freeze:
  - `frozen_effective_hours` (double precision) — `effectiveEstimate` of record at freeze
    (CAPACITY_BAR_RULES §3 resolution, incl. estimate overrides).
  - `frozen_assignee_op_id` (integer), `frozen_assignee_name` (text) — the FINAL holder.
  - `frozen_status_name` (text), `frozen_status_is_closed` (boolean).
  - `frozen_parent_op_id` (integer) — parent edge for the leaf double-count guard
    (without it, deleting the cache row would silently un-suppress parent/child pairs
    and move totals).
  - `frozen_connection_id` (integer) — identity scope for the assignee
    (`createPersonResolver` handles null, but the known value is stored).
  - `frozen_project_op_id` (integer) — **AMENDMENT (Phase 2, found by Agent C's §5.5
    test)**: `SprintItemDetail.project_op_id` had no frozen/baseline fallback
    (`ticket_baseline` has no project column), so a frozen sprint with deleted cache
    rows emitted `project_op_id: 0` and failed its own positive-OpId response schema.
    The snapshot therefore carries the project id too.
- `report_config.freeze_grace_days` — integer NOT NULL DEFAULT 3. (The existing singleton
  config table; `report_config` is hereby the app's settings row, not only reports.)

Repos:
- `sprints.setFrozen(sprintId, frozenAt)` / clearing happens inside `reactivate()`
  (reactivate also NULLs every `sprint_item.frozen_*` column for the sprint — a
  reactivated sprint is live again, and a later re-finish re-freezes from fresh data).
- `sprintItems.writeFreezeSnapshot(sprintId, rows: Array<{item_id, ...frozen fields}>)`.
- `reportConfig.get()` returns `freeze_grace_days` too; `reportConfig.setFreezeGraceDays(days)`
  (validate 0–60; 0 = freeze at the first sweep after finish).

## §2 Lifecycle changes (apps/api — Agent A)

### §2a Update gate: SPRINT_LOCKED → allowed during grace; SPRINT_FROZEN after

`createSprintLifecycle().update()` (sprintUpdate.ts:1033) currently throws `SPRINT_LOCKED`
for any locked sprint. New rule:

- sprint `frozen_at != null` → throw new `AppError("SPRINT_FROZEN", 409)` (add the error
  code to @osp/contracts errors).
- sprint locked but NOT frozen (= the grace window, however long it has actually been —
  the gate does NOT recompute the deadline; the sweep owns that) → **update is allowed**
  (this is the whole point: late time logs and final status flips still arrive).
- unlocked sprints — unchanged.

The public `POST /sprints/:id/update` route inherits this (409 `SPRINT_FROZEN` with a
clear message after freeze; works during grace). `finish()` stays idempotent-on-locked.
Everything else that checks `is_locked` (scope edits, capacity writes, delete guards …)
is **untouched** — the lock still means "no planning changes"; grace only re-opens
UPDATE RUNS.

### §2b The freeze sweep — scheduler/sprintUpdates.ts + boot

The existing 30-min tick (`tickNow()`) gains two responsibilities, and `buildServer()`
boot runs one `tickNow()`-equivalent sweep so a stopped app can't miss deadlines:

1. **Grace updates**: every sprint with `status="closed" && is_locked && frozen_at == null`
   gets a normal `update()` run each tick (same throttling as active sprints), so late
   logs arrive without user action.
2. **Freeze**: for those same sprints, when `now >= locked_at + freeze_grace_days` (days,
   compared against the END of the local day of the deadline — reuse `endOfLocalDay`
   conventions), run `freezeSprint(sprintId)`:
   1. one final `update()` run (best effort — an OP outage must not block freezing;
      log and continue),
   2. re-bake closure artifacts: re-run the OUTCOME + closure-report part of
      `performClosure` WITHOUT touching `closed_at`/`locked_at`/`lock_reason` (extract a
      `refreshClosureArtifacts(repos, sprintId, generatedAt)` from closure.ts —
      `performClosure` becomes "refresh + lock"), so `outcome`/`completed_hours`/the
      stored report reflect everything grace delivered,
   3. write the §1 snapshot for every non-removed sprint_item (from live cache row,
      falling back to the ticket_baseline exactly like closureStats does today),
   4. set `sprint.frozen_at`.
   The whole freeze runs inside one job guard (reuse the sprint_update_run machinery —
   kind "update", triggered_by "freeze" — so crash recovery and the watchdog cover it).
3. `reactivate()` clears `frozen_at` + snapshot columns (§1). The reactivate
   date-window rule is unchanged.

### §2c Read surfaces prefer the snapshot (Agent A)

For a sprint with `frozen_at != null`:

- `computeClosureStats`: estimate-of-record = `frozen_effective_hours` (before the
  retro/no-live-source fallbacks); holder for Planned/classification =
  `frozen_assignee_op_id/name` with `frozen_connection_id` as the identity scope;
  status for classification = `frozen_status_name/is_closed`; parent edge for the leaf
  guard = `frozen_parent_op_id`. Baselines/changelog reads unchanged (already local).
- `buildCapacityResponse` (`capItems`): same preference for estimate, assignee, parent,
  status (`is_done` classification) — so /capacity and /closure-stats agree by
  construction (CAPACITY_BAR_RULES §6.5) with or without the cache row.
- `GET /sprints/:id/items/detailed` (`buildSprintItemsDetailed`): effective_hours,
  assignee, status, done_bucket from the snapshot.
- Burndown/velocity: already anchored on frozen data — no change.
- `SprintResponse` gains `frozen_at: string | null` (and the sprint list exposes it) so
  the UI can badge frozen sprints and explain the disabled update.

CAPACITY_BAR_RULES.md §5a gets the freeze exception **in the same change** (its §7
mandate), plus **invariant 10**: *a frozen sprint's Planned/Delivered/±Change/Logged and
per-ticket numbers are identical before and after any mutation OR DELETION of its
work_package_cache rows.* Invariant tests must fail if any read path still consults the
live cache for a frozen sprint.

## §3 Import protection changes (Agent A routes + Agent B UI)

A sprint **protects** a ticket iff the sprint is NOT frozen (`frozen_at == null`) —
planning, active and closed-in-grace all still protect; frozen lifts protection.

- `GET /backlog/out-of-selection`: `in_sprint` stays "member of ANY sprint" (informational
  — the sprint names remain useful), but a new field `protected: boolean` carries the
  actual rule, and `sprint_names` marks frozen memberships (Agent B renders them
  distinctly). `protected_count` counts `protected` rows.
- `POST /backlog/out-of-selection/delete`: server-side re-validation uses the same
  `protected` rule (frozen-only membership ⇒ deletable). Deleting the cache row NEVER
  deletes sprint_items/baselines/changelog — unchanged.
- `DELETE /imports/:id` cascade: the protected set changes from
  `status ∈ {active, closed}` to `status == "active" || (status == "closed" && !frozen)`.
  Planning-item deletion unchanged. (The old "any sprint / frozen as untouchable" doc
  comment near `sprintNamesByOpId` is superseded — update it citing this doc: deletion
  of a FROZEN sprint's cache rows is provably harmless because of §0/§2c.)
- `POST /api/config` route family (new): `GET /api/config` → `{ overshoot_threshold_pct,
  freeze_grace_days }`; `PUT /api/config` accepts either field (zod-validated; grace
  0–60 int). No OP calls; works with a locked vault.

## §4 Web UI (apps/web — Agent B)

1. **Settings tab** (new `Tab` "settings", label "Settings", component
   `SettingsScreen.tsx`): edits `freeze_grace_days` (number input + save, with the
   explanation copy: what grace means, what freeze means) and
   `overshoot_threshold_pct` (it finally gets an edit surface). The People tab STAYS
   where it is (moving it would churn several e2e specs for no functional gain); the
   Settings screen links to People with a short note ("People & roles have their own
   tab"). This satisfies the "Nastavení" ask while keeping the diff minimal.
2. **Import screen** (`OutOfSelectionPanel`): rows are disabled by the new `protected`
   flag (not `in_sprint`); a frozen-sprint membership renders as muted text
   "in frozen sprint X — removable"; the summary line's "protected (in a sprint)"
   copy becomes "protected (in a planning/active sprint or within the grace period)".
3. **Sprint list / board**: a closed sprint shows a small badge — "grace until <date>"
   (locked_at + grace days, computed client-side from the sprint row + config) while
   unfrozen, "frozen" once `frozen_at` is set. The Update button's disabled tooltip on a
   frozen sprint says why (SPRINT_FROZEN).

British English for all user-facing copy (Increment 16 convention).

## §5 Tests (tests/* — Agent C; unit tests inside apps/api are Agent A's)

Contract tests that MUST exist (engine/API level, PGlite/bootRealApp — no real DB):

1. **Grace**: a finished (locked) unfrozen sprint accepts `POST /update`; a
   `time_logged` entry logged after finish lands in the changelog and in
   `per_developer[].logged_hours`.
2. **Freeze trigger**: with `freeze_grace_days = N` and an injectable clock, the sweep
   freezes exactly when `now` passes `locked_at + N days`, not before; boot sweep
   freezes an overdue sprint left unfrozen while the app was down.
3. **Invariant 10**: capture `/closure-stats` + `/capacity` + `/items/detailed` for a
   frozen sprint; then (a) mutate its wp cache rows (estimate/assignee/status change via
   repos), (b) DELETE the rows; all three responses stay byte-identical (excluding
   `generated_at`).
4. **SPRINT_FROZEN**: `POST /update` on a frozen sprint → 409 SPRINT_FROZEN;
   reactivate clears `frozen_at` + snapshots (verify snapshot columns are NULL after)
   and update works again.
5. **Import protection**: out-of-selection rows for a ticket in (a) an active sprint →
   protected; (b) a closed-in-grace sprint → protected; (c) a frozen sprint only →
   NOT protected, bulk delete removes it, and the frozen sprint's numbers (3) still
   hold afterwards.
6. **Config**: GET/PUT /api/config round-trips both fields; validation rejects
   `freeze_grace_days` outside 0–60; closure-stats echoes the overshoot threshold as
   before.
7. **e2e (Playwright)**: Settings tab edits grace days and persists; Import page shows a
   frozen ticket as removable and removes it on one confirmation; existing tu-sync §B5
   expectations reconciled with the new `protected` field (the listing/protected counts).

## §6 Hard boundaries for every agent

- ⛔ The repo-root CLAUDE.md database guardrail applies VERBATIM (each agent prompt
  restates it). Never boot apps/api without an explicit throwaway `DATABASE_URL`
  (`osp_test_*`) AND a non-default `PORT`. `osp` and `atlas-core` are off-limits. Unit
  tests use PGlite only.
- ⛔ OpenProject stays GET-only. No sync-engine scope changes (§0).
- ⛔ `docs/CAPACITY_BAR_RULES.md` colours (§1–§4) do not change; §5a/§6 get the freeze
  exception + invariant 10 as specified.
- Disjoint ownership: A = packages/db + apps/api (+ CAPACITY_BAR_RULES edit);
  B = apps/web; C = tests/src + tests/e2e. Contracts (this doc + @osp/contracts type
  additions listed here) are FROZEN — an agent that believes a contract is wrong stops
  and reports back instead of improvising.
- @osp/contracts additions (Agent A owns the file edits; B/C code against these):
  - `Sprint`/`SprintResponse`: `frozen_at: string | null`.
  - `OutOfSelectionEntry`: `protected: boolean`; `sprint_names` unchanged;
    new `frozen_sprint_names: string[]`.
  - `AppConfigResponse { overshoot_threshold_pct: number; freeze_grace_days: number }`,
    `UpdateAppConfigBody` (both fields optional, at least one required).
  - Error code `SPRINT_FROZEN`.
