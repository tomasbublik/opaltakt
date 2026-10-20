# OP Sprint Planner — Consolidation Round: Phase 0 Audit + Plan

> Status: **DONE (2026-07-22).** Both escalations resolved, Phase 1 complete and committed
> (`820ca71`, `413f853`, `ebd7eaf`), Phase 3 verification below.

## Phase 3 — Final verification

- **Full test suite green**: `pnpm -r typecheck` clean across all 9 workspaces; `pnpm -r test`
  green (1052 vitest tests); full Playwright e2e suite 165/177 passed, 12 pre-existing
  self-documented skips, zero new failures. Real `apps/api/osp.sqlite` fingerprinted untouched
  throughout the whole round.
- **Invariant tests**: `apps/api/src/routes/consolidation-invariants.test.ts`, 12/12 green (all 4
  that were red mid-round — cross-connection identity collision, fabricated `User <id>`,
  capacity/Closure done-status disagreement, `sprint_update_run` crash-recovery — are now green).
- **Duplicates physically deleted, confirmed by grep** (not just fixed in place):
  `durationToHours`/`parseIsoDurationLocal` (fixtures), the 2-arg `effectiveEstimate` reimplementation
  (scenarios.test.ts), the old `isDone` import in `routes/index.ts`, `computeCapacityLines`/
  `diffCapacity` (apps/web) — zero remaining references anywhere in the tree.
- **Call sites fully re-threaded**: every `personKey()` call now passes the connection dimension;
  every `toWorkPackageCacheRow()` call now passes `connectionId` (required parameter, so a future
  omission is a compile error, not a silent gap); the two now-redundant post-hoc
  `setConnectionIdForOpIds` stamps (mid-sprint add, retroactive add) were removed since the writer
  stamps directly — the ONE remaining `setConnectionIdForOpIds` call (refresh-all's orphan batch) is
  legitimate, a different, still-necessary use.
- ~~**Note**: `apps/api/src/logic/capacity.ts` has its own `personKey(assigneeOpId, memberId)` helper —
  confirmed NOT a duplicate of `developerSegments.ts`'s identity `personKey()`; it's a same-named but
  functionally distinct roster-bucketing key for the older v1 capacity model (see Concept 7's "two
  deliberately different concepts" finding). Left as-is, correctly.~~
  **DISPROVED by production data (identity unification, post-Increment 30).** The two "deliberately
  different" keys made one person render as up to three rows in Closure "Per developer" (`id:1:64` /
  `id:-:64` when the connection was unknown / `nm:Jan Belka` when the id was), made a person with no
  `team_member` row vanish from `/closure-stats` while `/capacity` counted them (Zbynek Trnka,
  4.5 h logged, no row), and made the Capacity panel's per-developer join land on a partial fragment
  (UI 10 h vs `/capacity`'s correct 32 h). Both definitions are now **physically deleted**; THE one
  canonical `personKey`/`createPersonResolver` lives in `packages/contracts/src/identity.ts` and is
  used by `developerSegments.ts`, `closureStats.ts`, `capacity.ts` and `routes/index.ts` alike. The
  contract is pinned by the golden tests `tests/src/identity-golden.test.ts` +
  `identity-golden-unit.test.ts` (written first, red against the old build), and the structural
  decision ("`team_member` is global × ids are per-connection") is recorded in
  `docs/IDENTITY_MODEL.md`.
- **Deliberately NOT done (out of this round's scope, no bug, pure DRY opportunity)**: the ~7 other
  inline `trim().toLowerCase()` status comparators (routes/index.ts, packages/sync, repos.ts SQL,
  etc.) were left as-is — they already work correctly today; only `done.ts`'s BROKEN raw comparison
  was fixed (Concept 3 explicitly scoped it this way: fix the live bug, don't force every already-
  correct comparator through a new shared function in the same round).

## Escalation decisions (frozen)

- **Escalation A — connection policy**: Activation/Update/Finish KEEP strict all-or-nothing
  (`requireAll`) — a frozen baseline/update from only partial connection data would be actively
  misleading, not just incomplete. Codify it as one explicit, named, tested policy function alongside
  refresh-all's existing `isolate` policy, rather than leaving it an implicit, undocumented
  divergence. No behavior change for either path — this closes the "which policy applies where" gap
  without changing what either path actually does.
- **Escalation B — capacity isDone**: MIGRATE `routes/index.ts:743`'s v1 capacity grey-redistribution
  `is_done` from the old status-only `isDone()` to the role-aware `classifyWithRole()` matrix. This
  DOES change the rendered grey/green bar for a developer-held ticket in a closed status on an active
  sprint (a narrow but real scenario) — done deliberately, to satisfy the round's own stated
  "ztlumený ⟺ Done v Closure" invariant.

## How to read this document

For each of the 9 concepts: the canonical function (keep), every other site that touches the
concept (migrate or delete), and a verdict. `✅` = already delegates correctly, nothing to do.
`⚠️` = duplicate/divergent, migrate in Phase 2. `⚠️⚠️` = duplicate that currently **disagrees** with
the canonical version on some input — i.e., a live bug, not just style debt.

---

## Concept 1 — Duration parser

**Canonical**: `parseIsoDuration()` — `packages/op-client/src/util.ts:14`. `P#W#D T#H#M#S` → hours,
day = 24h. Every production call site (sync, sprintUpdate, retro, routes) already delegates ✅.

**Duplicates to fix (test/fixture-only, zero prod impact)**:
- `fixtures/sim.ts:36` `durationToHours` — byte-for-byte copy of the canonical regex. Delete, import
  `parseIsoDuration` instead.
- `fixtures/mock-op-server/engine.test.ts:343` `parseIsoDurationLocal` — same, delete.
- `fixtures/sim.ts:160,185,191` hand-builds `PT${hours}H` (bare-hours, no day component) instead of
  calling the existing inverse formatter `hoursToIsoDuration` (`fixtures/mock-op-server/hal.ts:27`).
  Not wrong today (the parser accepts both encodings) but two serializers for one concept is exactly
  what this round exists to close — migrate `sim.ts` to call `hoursToIsoDuration`.

**Note, not a fix target**: `packages/op-client/src/journal.ts:133` `parseHoursLabel` parses a
**different** input format (human labels like "12h", "1h 30m", not ISO durations) — genuinely a
separate concept that happens to also produce hours. Leave alone.

---

## Concept 2 — effectiveEstimate

**Canonical**: `effectiveEstimate(estimatedHours, remainingHours, overrideHours)` —
`apps/api/src/logic/estimate.ts:26`. All 12 production call sites confirmed correct (right argument
order, no reimplementation). The old 2-arg `effectiveHours` is fully gone (grep-clean).

**Duplicate to fix (test-only)**:
- `fixtures/scenarios/scenarios.test.ts:583` — a local 2-arg reimplementation that **omits the
  override argument**. Currently harmless (no scenario test happens to need override + this exact
  path), but it's a landmine: a future scenario test asserting override behavior would pass against
  this reimplementation while failing against real code. Delete it, import the canonical 3-arg
  function.

---

## Concept 3 — Status normalizer

**Canonical**: `normalizeStatusName()` / `buildStatusCatalog()` — `packages/op-client/src/statusCatalog.ts:27,39,59`.

**Finding: this normalizer is nearly dead code.** Its only caller in the entire repo is journal
reconstruction (`packages/op-client/src/reconstruct.ts:187`). Every write path
(`packages/sync/src/index.ts:192`, `apps/api/src/logic/sprintUpdate.ts:369`,
`apps/api/src/logic/retro.ts:154`) writes `status_name` as the raw `_links.status.title` string,
bypassing the normalizer entirely — correct only because live OP's `_links.status.title` already
matches the `/api/v3/statuses` catalog's casing by construction. Meanwhile **eight separate sites**
each hand-roll their own `trim().toLowerCase()` comparison instead of sharing one:
`doneRole.ts:41,44,57-58`, `routes/index.ts:711,1853,3231`, `packages/sync/src/index.ts:715`,
`retro.ts:250`, `packages/op-client/src/journal.ts` (status lookup), `packages/db/src/repos.ts:563-564`
(SQL `lower(trim(...))`).

**⚠️⚠️ Live bug**: `apps/api/src/logic/done.ts:15-20` (`classifyStatus`, the OLD non-role-aware
`isDone`) compares the **raw, un-normalized** `wp.status_name` against `done_status_rule` rows — no
trim, no lowercase. This is the exact Increment-21 casing-divergence bug pattern, still present here.
It matters because (see Concept 6 below) this exact function still feeds the v1 capacity
grey-redistribution `is_done` flag on a live sprint.

**Consolidation target**: introduce one shared comparator (e.g. `statusNamesEqual(a, b)` — trim +
lowercase, living next to `normalizeStatusName`) and have all 8+ inline sites and `done.ts` call it.
Do NOT force every WRITE path through the full catalog-based normalizer in this round (that would be
a bigger, riskier change than the round's scope — file it as a follow-up if wanted) — but DO fix
`done.ts`'s raw comparison, since it can genuinely misclassify today.

---

## Concept 4 — Identity resolver

**Canonical**: `createIdentityResolver(op, aliases, sources)` — `apps/api/src/logic/identityResolver.ts:87`.
Keys by NAME, connection-scoped (aliases loaded per-connection), id is opportunistic enrichment.
Never calls `GET /api/v3/users`. Used correctly at `routes/index.ts:458`, `retro.ts:579,739`.

**⚠️⚠️ Two live-bug-risk parallel resolvers**:

1. `createUserNameResolver(op)` (`apps/api/src/logic/userNames.ts:54`) — keys by **bare `op_user_id`**,
   resolves via `GET /api/v3/users/:id` (the singular, project-readable endpoint — NOT the forbidden
   admin collection, that's a separate `getUsers()` which has zero non-test callers and should be
   deleted or covered by an invariant test that it's never called). Used at `routes/index.ts:790,2529,2704`,
   `sprintUpdate.ts:656`, `retro.ts:475`. Safe **today** only because each call site happens to build
   its cache from a single connection's data — nothing enforces that.

2. `closureStats.ts`'s own hand-rolled identity map (`resolvePerson`/`nameToOpUserFromLogs`/
   `memberByOpUser` at `closureStats.ts:52-71`), feeding `developerSegments.ts`'s `personKey()`
   (`id:${opUserId}` or `nm:${name}`, `developerSegments.ts:60`) — **keyed by bare `op_user_id` with
   NO connection dimension.** This is the exact Increment-23 cross-server-collision bug class
   (Alan Turing id 3 on the mock ≠ Cameron Dalby id 3 on Acme) — still live here, in a
   different code path than the one Increment 23 actually fixed. A sprint whose tickets span two
   connections could fold two different people onto one `id:3` key today.

3. **`closureStats.ts:86` fabricates `User <id>`** (`` name: resolvedName ?? `User ${resolvedOpUser ?? "?"}` ``)
   — directly violates the Increment-13 "never fabricate a name" invariant. `userNames.ts` already
   has the correct pattern (`unknownUserLabel`); closure re-introduces the exact thing Inc 13 banned.

**Consolidation target**: `closureStats.ts` should build its `personKey`/role/name maps through the
SAME connection-scoped identity resolver (or at minimum key by `(connection_id, op_user_id)` /
`(connection_id, name)`, never bare `op_user_id`), and use `unknownUserLabel` instead of fabricating
`User <id>`. This is fixing a real, currently-live bug, not a style preference — the round's own
stated invariant #3 ("identity se nikdy nepáruje podle op_id napříč připojeními") and #4 ("nikdy
fabrikované jméno") directly cover this.

---

## Concept 5 — Work package writer

**Canonical**: `toWorkPackageCacheRow()` (`packages/sync/src/index.ts:179`) for cache rows,
`buildBaseline()` (`apps/api/src/logic/sprintUpdate.ts:355`) for baseline rows.

**Structural gap**: `toWorkPackageCacheRow` deliberately never sets `connection_id` — every caller is
expected to stamp it separately. Six of seven write paths do this correctly (import, mid-sprint add,
Increment-25 retroactive add, orphan backfill, reconstruction, single-WP backlog add). **One does
not**: `sprintUpdate.ts:477` (the live Update/Finish pass) never re-stamps `connection_id` — it
relies entirely on Drizzle's `onConflictDoUpdate` silently preserving whatever was already there for
an *existing* row. For a WP that's never been cached before and first gets written by this exact
path, it would insert with a NULL `connection_id` — the precise "SERVER —" bug Increment 22 fixed
elsewhere, reachable again through this one gap.

**⚠️ Two divergent baseline builders**: `buildBaseline` (live/current state) vs.
`buildReconBaseline` (`retro.ts:239`, reconstructed state) have overlapping but not-identical field
maps (e.g. version resolution, status source) that can drift independently over time. Not
necessarily a bug today, but worth reconciling into one function with a "live vs. reconstructed"
mode.

**Consolidation target**: make `connection_id` a REQUIRED parameter of `toWorkPackageCacheRow` (not
an afterthought every caller bolts on) so a missing stamp becomes a type error, not a silent gap; add
the missing stamp at `sprintUpdate.ts:477`; reconcile `buildBaseline`/`buildReconBaseline` into one
function parameterized by data source.

---

## Concept 6 — isDone (role-aware done classification)

**Canonical**: `classifyWithRole()` (`apps/api/src/logic/doneRole.ts:48`) — used correctly by
Closure (`closureStats.ts:245`) and dimming/sprint-item-detail (`routes/index.ts:2229`).

**⚠️⚠️ Live disagreement, see Escalation B below**: `routes/index.ts:743` (inside
`buildCapacityResponse`, feeding the OLDER v1 capacity grey-redistribution engine) still calls the
pre-Increment-14, non-role-aware `isDone(wp, rules)` (`done.ts:27`). For a developer-held ticket in a
closed status on an active sprint, this yields `is_done=true` (status-only says "done"), while
Closure/dimming say `not_done` (developer-held tickets aren't done by the role matrix) — same
ticket, opposite done-ness, depending which surface you look at. This is precisely the class of bug
the round exists to close, AND the round's own invariant list explicitly requires "ztlumený ⟺ Done v
Closure" equivalence — but migrating this one call site changes the ACTUAL rendered grey-bar color
for a real (if narrow) scenario, so it needs your sign-off, not a silent fix (see Escalations).

---

## Concept 7 — developerSegments + capacity roll-ups

**Verdict: already substantially consolidated, no bugs found.**

- `computeClosureStats()` (`closureStats.ts:42`) is confirmed the single source for all four
  surfaces: Capacity header (`routes/index.ts:832`), Closure route (`:2857`), Report Detail
  (`report.ts:76`), PDF (`report.ts:278`). Frontend reads the API's numbers directly, no local
  recompute.
- `scopeCapacity.ts`'s v1 aggregate model (green/red/blue/grey roster bar, scope-change +
  availability/overload) and `developerSegments`'s v2 per-developer real-work model are **confirmed
  genuinely different concepts** serving different UI purposes on the same panel (aggregate
  scope-movement vs. per-developer delivered-work attribution) — NOT an unreconciled duplicate.
  Forcing a merge here would be solving a fake ambiguity; leave them as two named, documented fields.
- **Dead code, safe to delete**: `apps/web/src/lib/capacity.ts`'s `computeCapacityLines`/
  `diffCapacity` — a client-side recompute of Planned/overload totals with **zero non-test callers**
  anywhere in the app. Orphaned, no behavior change from removing it.

---

## Concept 8 — Job/lock lifecycle

**Canonical (sync_run)**: `SyncRunRepository` (`packages/db/src/repos.ts:1459-1571`) + the hard-cancel
registry (`packages/sync/src/index.ts:114-141`) + staging/rollback
(`stageBatch`/`commitStaging`/`dropStaging`) + `recoverOrphaned()` + the watchdog
(`apps/api/src/scheduler/syncWatchdog.ts`). All three cancel triggers (manual cancel, watchdog,
crash-recovery) converge on the one `AbortController`-per-run mechanism. This machine is in good
shape — mostly ✅ everywhere it's used.

**⚠️ Divergent buffer-then-commit**: the refresh-all orphan loop (`routes/index.ts:1449-1502`) rolls
back via an in-memory buffer + `upsertMany`, not `stageBatch`/`commitStaging`/`dropStaging` — a
second, hand-rolled implementation of the same "buffer, then commit once" pattern the sync engine
already has a named mechanism for.

**⚠️ Boot-path divergence**: `buildServer()` (`server.ts:64`) calls `recoverOrphaned()`;
`buildTestApp()` (`test-utils.ts:206`) calls `buildApp()` directly and never does. Harmless today
(fresh in-memory DB), but it means the recovery step is exercised by exactly one integration test,
not by the harness every route test boots through.

**⚠️⚠️ The big one — a second, unhardened run-lifecycle machine**: `SprintUpdateRunRepository`
(`repos.ts:1017-1075`, table `sprint_update_run`) drives activation/update/finish/retro-replay
(`sprintUpdate.ts`, `retro.ts`) with **none** of `sync_run`'s hardening:
- No `recoverOrphaned` equivalent — a crash mid-activation leaves a `running` row **forever**, no
  boot recovery, and the watchdog never looks at this table.
- No AbortController/hard-cancel/cancel endpoint — a hung activation/update/retro run **cannot be
  physically cancelled**, only `withTimeout`-capped per individual OP request.
- No staging/rollback — writes land directly, no all-or-nothing commit.

This is squarely within the round's own stated invariant #8 ("žádný permanentní zámek"; "cancel/
watchdog musí běh reálně zastavit") — it's not a new feature, it's making an existing, already-stated
invariant actually hold for a code path that currently doesn't meet it. Recommended for Phase 1/2,
no escalation needed (unlike Concept 9 below, there's no legitimate case for "sprint_update_run
SHOULD be uncancellable/unrecoverable" — that's just a gap).

---

## Concept 9 — Connection resilience

**Canonical resolver**: `requireOpClientForConnection()` (`routes/index.ts:265-282`) +
`requireOpClient()` + `buildTimeoutClientForConnection()`. The "is this one connection okay"
decision is shared everywhere — ✅ import, refresh-all, add-item, add-by-id, retro, delete/reactivate
snapshot all delegate correctly.

**Two genuinely different multi-connection POLICIES exist, and they disagree** (this is
Escalation A, see below):
- **Refresh-all** (`routes/index.ts:1333-1520`, `ConnectionSyncOutcome`): skip a disconnected
  connection, report it, keep going for the others. This is the canonical "isolate and continue"
  model the round's invariant list describes.
- **Activation/Update/Finish** (`sprintUpdate.ts:617-673` `runScopedFetchAndPersist`,
  `resolveScopedConnections` at `:748-763`): enumerates every connection a sprint's tickets touch and
  treats ALL as required — `Promise.allSettled`, then **throws if ANY failed**, failing the whole
  operation. A sprint spanning a healthy connection A and a down connection B currently **cannot
  activate, update, or finish at all**, even though A alone has everything needed for most of the
  sprint.

**Secondary, low-risk**: `tryOpClient()` (`routes/index.ts:328-335`) hand-inlines the same
enabled/locked/token checks as the canonical resolver but returns `null` instead of throwing. A
fourth partial copy of the same decision — fold into the canonical resolver as a
non-throwing/`tryResolve` variant.

---

## Escalations — need your decision before Phase 1 touches these

### Escalation A — should Activation/Update/Finish adopt the "isolate and continue" connection policy?

**Today**: if a sprint's tickets span 2 connections and one is disabled/unreachable, Activation,
Update, and Finish **fail the entire operation** (all-or-nothing). Only background sync/refresh-all
skips the bad connection and continues.

**Two ways to read this**:
1. **It's an oversight** — the exact "CONNECTION_DISABLED forgotten in one more place" pattern this
   round exists to close. Fix: make activation/update/finish also isolate-and-continue, producing a
   PARTIAL result (whatever's reachable) instead of failing outright.
2. **It's a deliberate safety property** — freezing a sprint's baseline (activation) or committing an
   update pass from only SOME of its connections could silently produce a misleading/incomplete
   baseline or update, which is arguably worse than a clear failure demanding the user fix the
   connection first. A partial "baseline_total_hours" frozen with one server's tickets missing could
   be actively wrong, not just incomplete.

I don't have enough context on your intent here to decide silently — this is a genuine behavior
change either way. My inclination is (2): keep activation/finish requiring all connections up
(a frozen baseline should be fully known), but make refresh/update passes isolate-and-continue like
sync already does (an update pass just refreshes existing data, a partial refresh is strictly better
than none) — i.e., codify BOTH policies as one shared, EXPLICIT, named/tested decision
(`resolveScopedConnections(sprintId, { onDisconnected: "fail" | "skip" })`) rather than one being an
accidental gap. But this is your call.

### Escalation B — should capacity's grey-redistribution `is_done` migrate to the role-aware matrix?

**Today**: `routes/index.ts:743` uses the OLD status-only `isDone(wp, rules)` for the v1 capacity
grey-redistribution bar. For a developer-held ticket in a closed status on an active sprint, this
disagrees with Closure/dimming (which use the role-aware matrix and would call the same ticket
`not_done`, since a developer holding it doesn't count as "done" under the role matrix).

This one is more clear-cut than Escalation A — the round's own invariant list explicitly requires
"ztlumený ⟺ Done v Closure" equivalence, and this is exactly that equivalence being violated. My
recommendation: migrate this site to `isDoneBucket(classifyWithRole(...))`, reusing the role signal
already available at that call site (`roleForParticipant`, `routes/index.ts:761`). This WILL change
the rendered grey/green bar for the narrow scenario above (developer-held + closed-status + active
sprint) — flagging so it's a deliberate choice, not a silent side effect, even though I think it's
the correct fix per the round's own stated invariant.

---

## Everything else — proceeding without escalation (clear-cut per the round's own stated invariants)

- `done.ts`'s raw (non-normalized) status comparison → fix to use a shared trim+lowercase comparator.
- `closureStats.ts`'s bare-`op_id`-keyed identity map + fabricated `User <id>` → migrate to
  connection-scoped identity, use `unknownUserLabel`.
- `sprintUpdate.ts:477` missing `connection_id` stamp → add it.
- Dead code deletions (`fixtures/sim.ts` duplicate parser, `scenarios.test.ts`'s 2-arg
  `effectiveEstimate`, `apps/web/src/lib/capacity.ts`'s unused `computeCapacityLines`/`diffCapacity`).
- Divergent buffer-then-commit in the refresh-all orphan loop → route through `stageBatch`/
  `commitStaging`/`dropStaging`.
- `buildTestApp` not calling `recoverOrphaned()` → route through the same boot helper as `buildServer`.
- `sprint_update_run` lacking crash-recovery/cancel/staging → bring it up to the same hardening as
  `sync_run` (per the round's own invariant #8, not a new feature).
- `tryOpClient()`'s duplicate inline connection checks → fold into the canonical resolver.

These are bug-fixes/dedup toward whichever behavior the round's own concept definitions and stated
invariants already declare correct — not new product decisions.
