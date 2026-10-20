# Increment 29 — FROZEN CONTRACTS (Phase 0)

Sync coverage (`SPEC_29 §1`), the mid-run race (`SPEC_29 §2`), full refresh, coverage
reporting, and bulk cleanup of out-of-selection tickets.

**This document is frozen.** Every Phase-1 agent codes against it. No agent changes
`packages/contracts` — the orchestrator already wrote every type this increment needs
(§8 lists them verbatim).

`docs/CAPACITY_BAR_RULES.md` is binding and this increment does not change a single
colour rule.

---

## 0. Scope correction — what is ALREADY done, measured in Phase 0

The run prompt merges three specs. Two of them are already shipped and were verified
present in the tree during Phase 0, not assumed:

| Prompt part | Spec | State |
|---|---|---|
| **A** — per-connection sync isolation, cross-server identity, hard cancel | SPEC_23 | **Done** (`a5fa442`…`0b85e25`). `ConnectionSyncOutcome` + `SyncRefreshAllResponse` exist; `apps/api/src/routes/index.ts:1560-1636` isolates skipped connections and re-throws only `VAULT_LOCKED`; `hardCancelRun`/`registerHardCancelController` in `packages/sync/src/index.ts:114-171`. |
| **C** — estimate-of-record recalculation, double-counting badges | SPEC_28 | **Done** (`0b85e25`). `apps/web/src/lib/doubleCounting.ts`, `apps/api/src/logic/doubleCounting.ts`, `docs/INCREMENT_28_CONTRACTS.md`. |
| **C §1.2** — staging + atomic swap | SPEC_20 §2 | **Done**. `work_package_cache_staging` (`packages/db/src/schema.ts:145-193`), `stageBatch`/`commitStaging`/`dropStaging`/`clearAllStaging`. |
| **B** — sync coverage, race, full refresh, cleanup | **SPEC_29** | **This increment.** |

Consequence for Phase 1: parts A and C are **regression surface**, not build surface.
Agent D re-asserts their DoD items (A1–A3, C1–C3) against the existing implementation and
reports; nobody rebuilds them. All build work is SPEC_29.

### 0a. Root cause, measured — the spec's §1 is *half* the gap

SPEC_29 §1 says work packages that entered the cache "another way" are never refreshed and
names `Add ticket by id` (Inc 25) as the path. That path is in fact **already covered**: the
orphans pass at `apps/api/src/routes/index.ts:1686-1774` re-fetches every cached row whose
**project** is not in the import selection.

The real, uncovered hole is one level finer, and it explains the evidence exactly:

```ts
// routes/index.ts:1653   — a selection is (project, version)
const run = await engine.sync({ projectOpId: sel.projectOpId,
                                versionOpId: sel.versionOpId,   // ← version-scoped
                                kind: "full" });
// routes/index.ts:1692   — but the orphans pass only asks about the PROJECT
const syncedProjects = new Set(sels.map((s) => s.projectOpId));
const orphans = rows.filter((w) => !syncedProjects.has(w.project_op_id));
```

`buildWorkPackagesFilters` adds a `version = X` clause when the selection is
version-scoped. A cached row whose project **is** in the selection but whose **version is
not** therefore falls into **neither** set: the paginated sync filters it out, and the
orphans pass considers its project already covered. It is never fetched again — by any run,
forever.

That is #11948 (Northwind, version "Backlog TOP"): `wp_count` per run in the pattern
`14, 49, 40, 13, 5, 3, 7` is one run *per (project, version) selection* ≈131 WPs, while the
cache holds more — the 48 week-old rows are the versions nobody selected.

**Design consequence, and the reason the fix below is shaped the way it is:** the contract
must NOT be "enumerate the known ways a row can escape the selection." That reasoning is
what produced the current half-fix. The contract is **empirical**: after a run, any cached
row for that connection whose `cached_at` is older than the run's start was, by definition,
not refreshed — whatever the reason. That set is re-fetched by op id, and whatever *still*
remains after that is reported. The rule is closed by construction, so a future fourth escape
route needs no new code.

---

## 1. Sync scope — `selection ∪ cache`, computed from `cached_at`

Per connection group in the refresh-all loop of `POST /api/sync`:

1. `groupStartedAt = nowIso()` is captured **before** the group's first `engine.sync()`.
2. The existing per-selection syncs run unchanged (`kind: "full"`).
3. **Coverage pass** (replaces the current one-by-one orphans loop):
   ```
   stale = every work_package_cache row R where
             (R.connection_id ?? currentConnId) === conn.id
             AND R.cached_at < groupStartedAt
   ```
   `stale` is fetched via `engine.syncByOpIds(stale.map(r => r.op_id))` — see §2.
4. Tickets added by id (Inc 25) and tickets in sprints need no special case: they are cache
   rows, so step 3 covers them unconditionally. **This satisfies SPEC_29 §1.2 by
   construction — do not add a separate "always in scope" list.**
5. **Coverage is recomputed from the DB after step 3**, never inferred from what the code
   believes it fetched (§4).

`clearAllStaging()` at the top of `engine.sync()` stays as-is; `syncByOpIds` must **not**
call it (it runs after `sync()` within the same group and would be clearing nothing of its
own, but the habit of calling it from two places is how a future concurrent-run bug gets in).

## 2. `SyncEngine.syncByOpIds` — bulk id fetch (Agent A)

Replaces the N+1 orphan loop and gives orphan detection for free.

```ts
export interface SyncByOpIdsResult {
  /** AMENDED in Phase 1 (adjudicated by the orchestrator, Agent A's finding):
   * `SyncRun | null`, not `SyncRun`. This clause and "empty input creates no
   * sync_run at all" below were mutually contradictory as first frozen; the
   * alternative was casting a run that does not exist into existence. Null
   * ONLY for the empty-input early return, so the route's `stale.length > 0`
   * branch never observes it. */
  run: SyncRun | null;
  /** op ids OP returned and this run committed to the live cache. */
  refreshedOpIds: OpId[];
  /** requested but ABSENT from OP's response → orphan candidates (§4.2). */
  missingOpIds: OpId[];
}

export interface SyncEngine {
  // …existing members unchanged…
  syncByOpIds(opIds: OpId[], signal?: AbortSignal): Promise<SyncByOpIdsResult>;
}
```

Frozen behaviour:

- **Batching:** `ID_FETCH_BATCH_SIZE = 100` op ids per OP request, using
  `filters: [{ id: { operator: "=", values: [...ids.map(String)] } }]`, `pageSize: 100`.
  Exported as a named const so the tests assert the batching, not a magic number.
- Creates **one** `sync_run` (`kind: "full"` — `SyncKind` is a closed enum
  `["full","incremental","snapshot"]` and **is not extended** this increment) and registers
  an `AbortController` via `registerHardCancelController`, unregistering in `finally`,
  exactly as `sync()` does. When the caller passes its own `signal`, both are composed.
- Uses `stageBatch` per batch → `commitStaging` **once** at the end. Cancellation
  (DB flag polled before every batch **and** once more immediately before the commit) →
  `dropStaging` + `finish(…, "aborted", …)`. Identical rollback contract to `sync()`.
- `progress(run.id, done, opIds.length)` after every batch.
- `missingOpIds` = requested minus returned, computed per batch and accumulated. An id
  missing because OP 404s/403s the whole batch is **not** silently a missing id — a failed
  batch throws and finishes the run `"error"`, same as `sync()`.
- Empty input → returns without creating a `sync_run` at all
  (`run` is the caller's problem then; see §8 note — the route skips the call when `stale`
  is empty).
- **Read-only to OP**: `GET /api/v3/work_packages?filters=…` only. No `GET /api/v3/users`.
- `toWorkPackageCacheRow(..., connectionId: null)` as everywhere in the engine; the route
  stamps `connection_id` post-hoc via `setConnectionIdForOpIds`.

**Mock support (Agent A, `fixtures/mock-op-server/`):** `filterValueFrom(filtersParam, "id")`
returns only the FIRST value of a clause, so a 100-id filter currently matches one WP. The
mock must match **any** value of the `id` clause (and stay backward compatible for the
single-value callers). This is a protocol-parity fix, not a test convenience — real OP has
always supported multi-value `id`.

## 3. Overlap window + watermark (Agents A + B)

The race is real and the current code has it: `sync()` derives the incremental cutoff from
`workPackages.maxUpdatedAtOp(projectOpId)` — the newest `updated_at_op` already cached. A WP
that changes in OP *during* the run gets a timestamp lower than that maximum and is therefore
never inside a later `updatedAt >= cutoff` window. Frozen fix:

- `SYNC_OVERLAP_WINDOW_MINUTES = 15` — exported from `packages/sync`. The incremental filter
  is `updatedAt >= (watermark − 15 min)`.
- **New table `sync_watermark`** (migration `0002`, Agent B):
  | column | type | note |
  |---|---|---|
  | `id` | serial pk | |
  | `connection_id` | integer → `op_connection.id`, **nullable** | same ADD-COLUMN-nullable convention as `project.connection_id`; a legacy null group resolves to the current connection, as everywhere else |
  | `project_op_id` | integer not null | |
  | `watermark_at` | `isoTimestamp` not null | |
  unique index on `(connection_id, project_op_id)`.

  **Per (connection, project), not per connection alone** — this is a deliberate refinement
  of SPEC_29 §2.3's "per připojení" and the stricter of the two. A single per-connection
  watermark would be advanced by project A's sync and then used as project B's cutoff, so
  B's changes between B's last sync and A's run would be skipped: the exact bug the spec is
  fixing, one scope up. The requirement the spec actually states — a watermark is never
  shared **across connections** — is satisfied strictly.
  ⚠️ The column is `connection_id`. Not `source_connection_id`.
- `watermark_at` **= the run's `started_at`**, never `finished_at`, never `nowIso()` at
  commit time.
- Written **only** after a fully successful run, after `commitStaging`. `aborted` and
  `error` runs leave it untouched. (`project.last_synced_at` keeps its current
  best-effort behaviour and is **not** the watermark — do not conflate them.)
- Cutoff resolution order in `sync()`:
  1. `sync_watermark` row for `(connectionId, projectOpId)` → `watermark_at − Δ`;
  2. no row → `maxUpdatedAtOp(projectOpId) − Δ` (today's behaviour, now with the window);
  3. `maxUpdatedAtOp` null → `kind = "full"`, unchanged.
  A subtracted cutoff is never clamped forward; a slightly wider window is always the safe
  direction.

  > **§3 AMENDED in Phase 1 — the watermark must never REPLACE `maxUpdatedAtOp`, only widen.**
  > As first frozen, rules 1 and 2 read as alternatives and were implemented as
  > `cutoffSource = watermarkAt ?? lastUpdated`. That silently violates this very invariant,
  > because the two timestamps live in **different clock domains**: `watermark_at` is the
  > run's `started_at` on the **app server's** clock, but it is then sent to OP as an
  > `updatedAt >=` filter, i.e. compared against the **OP server's** clock. The 15-minute
  > window is the tolerance for that skew. Where the skew exceeds it, the new cutoff lands
  > *later* than the old one and the incremental sync returns fewer rows than before —
  > coverage going backwards, in the increment whose entire purpose is coverage. Agent B hit
  > it as a hard failure (`tests/src/scenario-e2e.test.ts` › S4, `expected 0 to be >= 2`):
  > the scenario mock's `updatedAt` values sit on the scenario calendar (July 2026) while the
  > real clock is August 2026, so the watermark cutoff landed a month past every mock row.
  >
  > **Frozen resolution — take the EARLIER of the two:**
  > ```ts
  > const cutoffSource =
  >   watermarkAt !== null && lastUpdated !== null
  >     ? (Date.parse(watermarkAt) < Date.parse(lastUpdated) ? watermarkAt : lastUpdated)
  >     : (watermarkAt ?? lastUpdated);
  > ```
  > This can never be narrower than the pre-Increment-29 behaviour, and it does **not** cost
  > the watermark its purpose: the race the watermark exists to fix is exactly the case where
  > `lastUpdated > watermarkAt` (a row cached during the run carries a newer `updatedAt` than
  > the run's start), and there `min` selects the watermark. Where `lastUpdated < watermarkAt`
  > the result is merely wider, which is the safe direction by this rule. It also makes the
  > feature robust against genuine app-host/OP-host clock skew in production, which is not a
  > test artefact — the two hosts are not required to share a clock.
- The engine needs the connection identity to key the watermark. `SyncEngineDeps` gains
  `watermarks?: SyncWatermarkRepository` and `SyncOptions` gains
  `connectionId?: number | null`. Both **optional** — omitted (unit tests, snapshot writer)
  degrades to rule 2, never throws.

## 4. Reporting — no silent success (Agent B)

### 4.1 Coverage, recomputed from the DB

After the coverage pass, per connection group:

```ts
total_cached   = rows for this connection
refreshed      = rows for this connection with cached_at >= groupStartedAt
not_refreshed  = total_cached - refreshed          // > 0 ⇒ the UI MUST warn
oldest_cached_at = min(cached_at) over the group's rows, or null when it has none
```

`refreshed` is **counted in the database**, not accumulated in a JS variable while fetching.
A count derived from "what we believe we sent" is exactly the reporting that let this bug
hide behind `status: success` for weeks.

### 4.2 Orphans

`missingOpIds` from §2 = cached rows OP no longer returns. **Reported, never deleted** —
deletion is the user's explicit action in §5. Reported as op ids in the response and logged
via `req.log.warn`. Rows deliberately excluded from OP's response by permissions look
identical to deleted ones; guessing wrong and hard-deleting the user's sprint history is not
a recoverable mistake.

### 4.3 Response

`ConnectionSyncOutcome` gains `coverage` (null for `skipped`/`error` outcomes — nothing was
attempted, so a zeroed coverage block would read as "everything is stale").
`SyncRefreshAllResponse` gains `full_refresh: boolean`. Exact zod in §8.

## 5. Full refresh (Agent B + C)

- `TriggerSyncBody` gains `full_refresh?: boolean` (default `false`). Meaningful **only** for
  refresh-all (no `project_op_id`); ignored otherwise, exactly like `connection_id` is today.
- `full_refresh: true` ⇒ before syncing, **delete every `sync_watermark` row for that
  connection**, so each selection's `kind: "full"` sync plus the coverage pass rebuilds the
  cutoffs from scratch. Nothing else about the pass changes — "Sync now" already forces
  `kind: "full"`; full refresh additionally guarantees no stale cutoff survives.
- **Periodic:** new `apps/api/src/scheduler/fullRefresh.ts`, following the existing scheduler
  shape (`heartbeat.ts` / `sprintUpdates.ts` — same start/stop, same `unref`ed timer).
  Interval from `OSP_FULL_REFRESH_INTERVAL_MS`, default `86_400_000` (daily). The scheduler
  invokes the same internal refresh-all path with `full_refresh: true`; it must **skip**
  entirely (log, don't throw) when the vault is locked or a sync is already running — a
  background job may never surface a 423/409 to nobody.
- **On demand:** the "Full refresh" button (Agent C) posts `{ full_refresh: true }`.
- `SyncKind` is **not** extended. A full refresh is recorded as ordinary `"full"` runs; the
  response's `full_refresh` flag is how a caller distinguishes it.

## 6. Cleanup of out-of-selection tickets (Agents B + C)

Definition, per cached row R with owning connection `C = R.connection_id ?? currentConnId`:

```
inSelection(R) ⇔ ∃ import_selection S :
     S.connection_id ?? currentConnId  === C
  ∧  S.project_op_id === R.project_op_id
  ∧  (S.version_op_id === null  ∨  S.version_op_id === R.version_op_id)
```

A row is **out of selection** when no such `S` exists. Note the version clause — it is the
same asymmetry as §0a: a project-wide selection covers every version, a version-scoped one
covers only its own.

- **`GET /api/backlog/out-of-selection`** → `OutOfSelectionResponse` (§8). Includes protected
  rows, flagged, so the UI can show *why* they cannot be removed.
- **Protection:** a row is protected when a `sprint_item` references its `op_id` in **any**
  sprint, whatever the sprint's status (`planning`, `active`, `closed`, locked). SPEC_29 §1.5
  names planning/active/closed explicitly; the frozen rule is simply *any sprint*, so a
  status added later cannot silently become deletable. `in_sprint: true` + `sprint_names`.
- **`POST /api/backlog/out-of-selection/delete`** body `{ op_ids: number[] }` →
  `DeleteOutOfSelectionResponse`. One confirmation, many tickets. Server-side re-validation
  of **every** id (the client's list can be stale by the time it posts):
  | condition | bucket |
  |---|---|
  | in a sprint | `protected` — not deleted |
  | currently **in** selection | `rejected` — not deleted |
  | not in the cache at all | `rejected` |
  | otherwise | `removed` — `workPackages.deleteMany` |
  Partial success is the normal outcome and is **200**, never an error: the response lists
  each bucket, and the UI reports it.
- **Local only.** Deletes the `work_package_cache` row. **Never** writes to OP — the
  read-only invariant is not relaxed by a delete endpoint. Sprint items, baselines,
  changelogs and closure data are untouched by construction (protected rows are never
  deleted).

## 7. Capacity after sync (regression check, Agent C + D)

Inc 28 made an estimate change recalculate the bar. This increment must not regress it, and
DoD C1/C2 must hold **through a sync**: when a refresh-all finishes, the sprint board
refetches the **whole** summary DTO (Inc 17 §4a), not just the item list. Agent C **verifies
and, if missing, wires** that one refetch — no redesign of the DTO, no new endpoint. During a
running sync the numbers must not move.

> ### ⚠️ §7 CORRECTED in Phase 1 — staging does NOT make C2 free
>
> This paragraph originally read "that is already guaranteed by staging + atomic swap (§0),
> so C2 is an assertion, not an implementation." **That was wrong**, and it was the
> orchestrator's error, not Agent C's — he was instructed to treat C2 as already satisfied.
>
> Staging makes **one `sync_run`** atomic. A refresh-all is **many** runs: one per import
> selection, plus the coverage pass (§1). Each commits its own staging separately, so
> between commits the cache is genuinely half-updated — project A refreshed, project B not.
> On top of that, `apps/web/src/App.tsx:203` polls `refreshData()` **every 1000 ms while the
> sync runs**, and its own comment states the intent: "the backlog/EFFECTIVE-hours data
> refetches as tickets arrive." Every intermediate state is therefore faithfully rendered.
>
> That is the mechanism behind SPEC_28 §1.2's report — 44 h at "Starting", 4 h at
> "Importing 9/14". It is not a caching bug and never was.
>
> **Frozen fix (Agent C, `apps/web` only):** split the two concerns the single `refreshKey`
> currently conflates. `syncState` (`App.tsx:173`, the progress bar) is the *only* consumer
> that must refetch during a run; every other consumer — capacity, closure, backlog, sprint
> board — must not. Introduce a separate poll key that only `syncState` depends on, tick that
> one every second, and bump `refreshKey` **only** in `runSync`'s `finally`. New values then
> land in one step when the sync settles, which is exactly what DoD C2 asks for.

## 8. Contracts — written in Phase 0, frozen (nobody edits `packages/contracts`)

Already applied to `packages/contracts/src/api.ts`:

```ts
TriggerSyncBody.full_refresh?: boolean

export const SyncCoverage = z.object({
  total_cached: z.number().int(),
  refreshed: z.number().int(),
  not_refreshed: z.number().int(),
  orphan_op_ids: z.array(OpId),
  oldest_cached_at: IsoDateTime.nullable(),
});

ConnectionSyncOutcome.coverage: SyncCoverage.nullable()
SyncRefreshAllResponse.full_refresh: z.boolean()

export const OutOfSelectionEntry = z.object({
  op_id, subject, project_op_id, project_name, version_op_id, version_name,
  connection_id, connection_label, cached_at, updated_at_op,
  in_sprint: z.boolean(), sprint_names: z.array(z.string()),
});
export const OutOfSelectionResponse = z.object({
  entries: z.array(OutOfSelectionEntry),
  total: z.number().int(),
  protected_count: z.number().int(),
});

export const DeleteOutOfSelectionBody = z.object({ op_ids: z.array(OpId).min(1) });
export const DeleteOutOfSelectionResponse = z.object({
  removed: z.array(OpId),
  protected: z.array(z.object({ op_id: OpId, sprint_names: z.array(z.string()) })),
  rejected: z.array(z.object({ op_id: OpId, reason: z.enum(["in_selection", "not_cached"]) })),
});
```

## 9. Guardrails — unchanged, restated because every agent must carry them

1. **Environment isolation.** Every run targets a throwaway PostgreSQL database named
   `osp_test_*` / `osp_e2e_*` **and** an explicit non-default `PORT`. `DATABASE_URL` and
   `PORT` have no defaults and must never be given one.
   **Off-limits, unconditionally: `osp` (the user's real data), `atlas-core` (a different
   project), and `apps/api/osp.sqlite`.** Unit tests run on PGlite and need none of this.
2. **OpenProject is read-only.** `GET /api/v3/*` only. **Never `GET /api/v3/users`.** The
   token never appears in a log, a response, or an error message.
3. **Identity is `(connection_id, name)`** — never a bare `op_id` across servers.
4. `docs/CAPACITY_BAR_RULES.md` is binding; no colour rule changes here.
5. The column is **`connection_id`**. Older specs calling it `source_connection_id` are wrong.
6. Disjoint ownership. Contracts are frozen — an agent that believes it needs a contract
   change stops and reports instead of editing.
